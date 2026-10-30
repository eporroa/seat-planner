-- Mesas en vivo: server-side source of truth.
-- Reads go through Electric (behind our proxy); writes only through
-- apply_mutation(), called with the service role from /api/mutations.

create table demo_rooms (
  id text primary key,
  is_locked boolean not null default false,
  updated_at timestamptz not null default now(),
  last_mutation_id uuid
);

create table demo_tables (
  id uuid primary key,
  room_id text not null references demo_rooms(id) on delete cascade,
  label text not null default '' check (char_length(label) <= 20),
  shape text not null check (shape in ('circular', 'rectangular')),
  pos_x integer not null check (pos_x % 20 = 0),
  pos_y integer not null check (pos_y % 20 = 0),
  seat_limit integer not null check (seat_limit between 1 and 12),
  shape_radius integer check (shape_radius is null or shape_radius between 40 and 100),
  shape_width integer check (shape_width is null or shape_width between 80 and 320),
  shape_height integer check (shape_height is null or shape_height between 80 and 320),
  updated_at timestamptz not null default now(),
  last_mutation_id uuid
);
create index on demo_tables (room_id);

-- Attendees never choose free text: the display name is an animal + color
-- (validated in the API) plus the lowest free numeric suffix per room.
create table demo_clients (
  client_id uuid primary key,
  room_id text not null references demo_rooms(id) on delete cascade,
  base_name text not null,
  suffix integer not null check (suffix >= 1),
  display_name text not null,
  created_at timestamptz not null default now(),
  unique (room_id, display_name)
);

-- Chairs are derived from seat_limit; only claims are stored.
-- client_id never leaves the server: the Electric shape exposes owner_tag
-- (md5 of client_id) so a client can recognize its own claims without
-- anyone being able to impersonate another attendee.
create table demo_seat_claims (
  table_id uuid not null references demo_tables(id) on delete cascade,
  seat_index integer not null check (seat_index >= 1),
  room_id text not null references demo_rooms(id) on delete cascade,
  client_id uuid not null,
  owner_tag text not null,
  client_name text not null check (char_length(client_name) between 2 and 40),
  claimed_at timestamptz not null default now(),
  last_mutation_id uuid,
  primary key (table_id, seat_index),
  unique (room_id, client_id)
);
create index on demo_seat_claims (room_id);

-- Idempotency + rate limiting + audit.
create table demo_applied_mutations (
  mutation_id uuid primary key,
  client_id uuid not null,
  status text not null check (status in ('applied', 'rejected')),
  reason text,
  created_at timestamptz not null default now()
);
create index on demo_applied_mutations (client_id, created_at desc);

-- Electric needs full row identity to filter deletes by room.
alter table demo_rooms replica identity full;
alter table demo_tables replica identity full;
alter table demo_seat_claims replica identity full;

alter table demo_rooms enable row level security;
alter table demo_tables enable row level security;
alter table demo_clients enable row level security;
alter table demo_seat_claims enable row level security;
alter table demo_applied_mutations enable row level security;
-- No policies: the public Supabase API can't touch these tables.
revoke all on demo_rooms, demo_tables, demo_clients, demo_seat_claims, demo_applied_mutations
  from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Grid rules. Must match src/features/floorplan/{utils,grid-rules}.ts:
-- GRID_SIZE 20, chair ring = CHAIR_GAP 14 + CHAIR_RADIUS 10 = 24,
-- room 1600 x 1000, footprints need one grid cell of clearance.
-- ---------------------------------------------------------------------------

-- Grid multiples, size ranges and shape/dimension consistency (values only).
create function demo_check_geometry(
  p_shape text, p_x integer, p_y integer, p_radius integer, p_width integer, p_height integer
) returns void
language plpgsql immutable as $$
begin
  if p_x is null or p_y is null or p_x % 20 <> 0 or p_y % 20 <> 0 then
    raise exception 'invalid_grid';
  end if;
  if p_shape = 'circular' then
    if p_radius is null or p_width is not null or p_height is not null
       or p_radius not between 40 and 100 or p_radius % 20 <> 0 then
      raise exception 'invalid_size';
    end if;
  elsif p_shape = 'rectangular' then
    if p_width is null or p_height is null or p_radius is not null
       or p_width not between 80 and 320 or p_height not between 80 and 320
       or p_width % 20 <> 0 or p_height % 20 <> 0 then
      raise exception 'invalid_size';
    end if;
  else
    raise exception 'invalid';
  end if;
end $$;

-- Room bounds (including the chair ring) and overlap against every other table.
create function demo_assert_placement(p_room_id text, p_table_id uuid) returns void
language plpgsql as $$
declare
  t demo_tables;
  w integer;
  h integer;
begin
  select * into t from demo_tables where id = p_table_id and room_id = p_room_id;
  if not found then
    raise exception 'not_found';
  end if;
  w := case when t.shape = 'circular' then t.shape_radius * 2 else t.shape_width end;
  h := case when t.shape = 'circular' then t.shape_radius * 2 else t.shape_height end;

  if t.pos_x - 24 < 0 or t.pos_y - 24 < 0
     or t.pos_x + w + 24 > 1600 or t.pos_y + h + 24 > 1000 then
    raise exception 'out_of_bounds';
  end if;

  if exists (
    select 1
    from demo_tables o
    cross join lateral (
      select case when o.shape = 'circular' then o.shape_radius * 2 else o.shape_width end as ow,
             case when o.shape = 'circular' then o.shape_radius * 2 else o.shape_height end as oh
    ) d
    where o.room_id = p_room_id
      and o.id <> p_table_id
      -- footprint(t) grown by one grid cell intersects footprint(o)
      and (t.pos_x - 24 - 20) < (o.pos_x - 24 + d.ow + 48)
      and (t.pos_x - 24 - 20 + w + 48 + 40) > (o.pos_x - 24)
      and (t.pos_y - 24 - 20) < (o.pos_y - 24 + d.oh + 48)
      and (t.pos_y - 24 - 20 + h + 48 + 40) > (o.pos_y - 24)
  ) then
    raise exception 'overlap';
  end if;
end $$;

-- Applies one table update (full-state or partial payload). Returns whether
-- anything changed. Attendees may only move a table or add chairs, and only
-- while the layout is unlocked.
create function demo_apply_table_update(
  p_room_id text, p_mutation_id uuid, p_payload jsonb, p_is_admin boolean
) returns boolean
language plpgsql as $$
declare
  cur demo_tables;
  n_label text;
  n_x integer;
  n_y integer;
  n_seats integer;
  n_radius integer;
  n_width integer;
  n_height integer;
begin
  select * into cur from demo_tables
  where id = (p_payload->>'id')::uuid and room_id = p_room_id
  for update;
  if not found then
    raise exception 'not_found';
  end if;

  if p_payload ? 'shape' and p_payload->>'shape' <> cur.shape then
    raise exception 'invalid';
  end if;

  n_label  := case when p_payload ? 'label' then p_payload->>'label' else cur.label end;
  n_x      := case when p_payload ? 'pos_x' then (p_payload->>'pos_x')::integer else cur.pos_x end;
  n_y      := case when p_payload ? 'pos_y' then (p_payload->>'pos_y')::integer else cur.pos_y end;
  n_seats  := case when p_payload ? 'seat_limit' then (p_payload->>'seat_limit')::integer else cur.seat_limit end;
  n_radius := case when p_payload ? 'shape_radius' then (p_payload->>'shape_radius')::integer else cur.shape_radius end;
  n_width  := case when p_payload ? 'shape_width' then (p_payload->>'shape_width')::integer else cur.shape_width end;
  n_height := case when p_payload ? 'shape_height' then (p_payload->>'shape_height')::integer else cur.shape_height end;

  if n_label is not distinct from cur.label and n_x = cur.pos_x and n_y = cur.pos_y
     and n_seats = cur.seat_limit and n_radius is not distinct from cur.shape_radius
     and n_width is not distinct from cur.shape_width
     and n_height is not distinct from cur.shape_height then
    return false;
  end if;

  if not p_is_admin then
    if n_label is distinct from cur.label
       or n_radius is distinct from cur.shape_radius
       or n_width is distinct from cur.shape_width
       or n_height is distinct from cur.shape_height
       or n_seats < cur.seat_limit then
      raise exception 'forbidden';
    end if;
    if (select is_locked from demo_rooms where id = p_room_id) then
      raise exception 'locked';
    end if;
  end if;

  if n_seats not between 1 and 12 then
    raise exception 'invalid';
  end if;
  if n_seats < cur.seat_limit
     and exists (select 1 from demo_seat_claims where table_id = cur.id and seat_index > n_seats) then
    raise exception 'seats_claimed';
  end if;
  if char_length(n_label) > 20 then
    raise exception 'invalid';
  end if;

  perform demo_check_geometry(cur.shape, n_x, n_y, n_radius, n_width, n_height);

  update demo_tables
  set label = n_label, pos_x = n_x, pos_y = n_y, seat_limit = n_seats,
      shape_radius = n_radius, shape_width = n_width, shape_height = n_height,
      updated_at = now(), last_mutation_id = p_mutation_id
  where id = cur.id;
  return true;
end $$;

-- Seed layout: 12 tables in a tidy 4 x 3 grid, circular and rectangular
-- alternating like a checkerboard. Must match src/shared/seed.ts.
create function demo_seed_tables(p_room_id text, p_mutation_id uuid default null) returns void
language sql as $$
  insert into demo_tables (id, room_id, label, shape, pos_x, pos_y, seat_limit,
                           shape_radius, shape_width, shape_height, last_mutation_id)
  select
    ('00000000-0000-4000-8000-' || lpad(g.n::text, 12, '0'))::uuid,
    p_room_id,
    'Mesa ' || g.n,
    case when g.circ then 'circular' else 'rectangular' end,
    (array[200, 600, 1000, 1400])[g.col + 1] - case when g.circ then 60 else 100 end,
    (array[180, 500, 820])[g.row + 1] - case when g.circ then 60 else 40 end,
    case when g.circ then 8 else 10 end,
    case when g.circ then 60 end,
    case when g.circ then null else 200 end,
    case when g.circ then null else 80 end,
    p_mutation_id
  from (
    select n, (n - 1) / 4 as row, (n - 1) % 4 as col,
           (((n - 1) / 4) + ((n - 1) % 4)) % 2 = 0 as circ
    from generate_series(1, 12) n
  ) g
$$;

-- ---------------------------------------------------------------------------
-- Session: assigns the display name. Called by /api/session.
-- ---------------------------------------------------------------------------
create function demo_register_client(p_client_id uuid, p_room_id text, p_base_name text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_suffix integer;
  v_display text;
begin
  perform pg_advisory_xact_lock(hashtextextended('room:' || p_room_id, 0));
  if not exists (select 1 from demo_rooms where id = p_room_id) then
    raise exception 'unknown_room';
  end if;

  select min(s) into v_suffix
  from generate_series(1, 1000) s
  where not exists (
    select 1 from demo_clients c
    where c.room_id = p_room_id and c.base_name = p_base_name
      and c.suffix = s and c.client_id <> p_client_id
  );
  v_display := p_base_name || case when v_suffix > 1 then v_suffix::text else '' end;

  insert into demo_clients (client_id, room_id, base_name, suffix, display_name)
  values (p_client_id, p_room_id, p_base_name, v_suffix, v_display)
  on conflict (client_id) do update
    set base_name = excluded.base_name, suffix = excluded.suffix, display_name = excluded.display_name;

  update demo_seat_claims set client_name = v_display
  where client_id = p_client_id and client_name <> v_display;

  return jsonb_build_object('displayName', v_display);
end $$;

-- ---------------------------------------------------------------------------
-- apply_mutation: the server is the arbiter. One call per mutation, its own
-- transaction. Identity and admin flag come from signed cookies in the API,
-- never from the mutation body. The display name comes from demo_clients.
--
-- Mutation: { mutation_id, entity, op, payload }
-- Result:   { mutationId, status: applied|rejected, reason, retryable? }
--   reason 'noop' (applied): nothing changed; the client clears its overlay
--   because no Electric echo will arrive.
-- ---------------------------------------------------------------------------
create function apply_mutation(p_mutation jsonb, p_client_id uuid, p_is_admin boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := (p_mutation->>'mutation_id')::uuid;
  v_key text := (p_mutation->>'entity') || '/' || (p_mutation->>'op');
  v_payload jsonb := coalesce(p_mutation->'payload', '{}'::jsonb);
  v_prev demo_applied_mutations;
  v_room text;
  v_name text;
  v_tag text;
  v_status text := 'applied';
  v_reason text := null;
  v_table_id uuid;
  v_seat integer;
  v_claim demo_seat_claims;
  v_item jsonb;
  v_changed boolean;
  v_any_changed boolean := false;
  v_limit integer;
begin
  -- Serialize one client's mutations so idempotency checks can't race.
  perform pg_advisory_xact_lock(hashtextextended('client:' || p_client_id::text, 0));

  select * into v_prev from demo_applied_mutations where mutation_id = v_id;
  if found then
    return jsonb_build_object('mutationId', v_id, 'status', v_prev.status, 'reason', v_prev.reason);
  end if;

  select room_id, display_name, md5(client_id::text) into v_room, v_name, v_tag
  from demo_clients where client_id = p_client_id;
  if v_room is null then
    -- Not recorded: the session can still be created and the mutation retried.
    return jsonb_build_object('mutationId', v_id, 'status', 'rejected',
                              'reason', 'unknown_client', 'retryable', true);
  end if;

  -- Rate limit. Not recorded either: it is retryable, never a final answer.
  if not p_is_admin and (
    select count(*) from demo_applied_mutations
    where client_id = p_client_id and created_at > now() - interval '10 seconds'
  ) > 20 then
    return jsonb_build_object('mutationId', v_id, 'status', 'rejected',
                              'reason', 'rate_limited', 'retryable', true);
  end if;

  -- One writer per room at a time: makes the overlap check race-free.
  perform pg_advisory_xact_lock(hashtextextended('room:' || v_room, 0));

  begin
    case v_key
      when 'seat_claim/insert' then
        v_table_id := (v_payload->>'table_id')::uuid;
        v_seat := (v_payload->>'seat_index')::integer;
        select seat_limit into v_limit from demo_tables where id = v_table_id and room_id = v_room;
        if not found then
          raise exception 'not_found';
        end if;
        if v_seat is null or v_seat < 1 or v_seat > v_limit then
          raise exception 'invalid_seat';
        end if;

        select * into v_claim from demo_seat_claims where table_id = v_table_id and seat_index = v_seat;
        if found then
          if v_claim.client_id = p_client_id then
            v_reason := 'noop';
          else
            raise exception 'seat_taken';
          end if;
        else
          -- Release the previous claim only now that the target is free.
          delete from demo_seat_claims where room_id = v_room and client_id = p_client_id;
          insert into demo_seat_claims (table_id, seat_index, room_id, client_id, owner_tag,
                                        client_name, last_mutation_id)
          values (v_table_id, v_seat, v_room, p_client_id, v_tag, v_name, v_id);
        end if;

      when 'seat_claim/delete' then
        select * into v_claim from demo_seat_claims
        where table_id = (v_payload->>'table_id')::uuid
          and seat_index = (v_payload->>'seat_index')::integer and room_id = v_room;
        if not found then
          v_reason := 'noop';
        elsif v_claim.client_id <> p_client_id and not p_is_admin then
          raise exception 'forbidden';
        else
          delete from demo_seat_claims where table_id = v_claim.table_id and seat_index = v_claim.seat_index;
        end if;

      when 'table/insert' then
        if not p_is_admin then
          raise exception 'forbidden';
        end if;
        if (select count(*) from demo_tables where room_id = v_room) >= 60 then
          raise exception 'too_many_tables';
        end if;
        if char_length(coalesce(v_payload->>'label', '')) > 20
           or coalesce((v_payload->>'seat_limit')::integer, 0) not between 1 and 12 then
          raise exception 'invalid';
        end if;
        perform demo_check_geometry(
          v_payload->>'shape', (v_payload->>'pos_x')::integer, (v_payload->>'pos_y')::integer,
          (v_payload->>'shape_radius')::integer, (v_payload->>'shape_width')::integer,
          (v_payload->>'shape_height')::integer);
        insert into demo_tables (id, room_id, label, shape, pos_x, pos_y, seat_limit,
                                 shape_radius, shape_width, shape_height, last_mutation_id)
        values ((v_payload->>'id')::uuid, v_room, coalesce(v_payload->>'label', ''),
                v_payload->>'shape', (v_payload->>'pos_x')::integer, (v_payload->>'pos_y')::integer,
                (v_payload->>'seat_limit')::integer, (v_payload->>'shape_radius')::integer,
                (v_payload->>'shape_width')::integer, (v_payload->>'shape_height')::integer, v_id);
        perform demo_assert_placement(v_room, (v_payload->>'id')::uuid);

      when 'table/update' then
        v_changed := demo_apply_table_update(v_room, v_id, v_payload, p_is_admin);
        if not v_changed then
          v_reason := 'noop';
        else
          perform demo_assert_placement(v_room, (v_payload->>'id')::uuid);
        end if;

      when 'table/batch_update' then
        -- Admin layout tools move many tables at once: validate the FINAL state.
        if not p_is_admin then
          raise exception 'forbidden';
        end if;
        if jsonb_typeof(v_payload->'tables') <> 'array' or jsonb_array_length(v_payload->'tables') not between 1 and 60 then
          raise exception 'invalid';
        end if;
        for v_item in select * from jsonb_array_elements(v_payload->'tables') loop
          v_changed := demo_apply_table_update(v_room, v_id, v_item, true);
          v_any_changed := v_any_changed or v_changed;
        end loop;
        if not v_any_changed then
          v_reason := 'noop';
        else
          for v_item in select * from jsonb_array_elements(v_payload->'tables') loop
            perform demo_assert_placement(v_room, (v_item->>'id')::uuid);
          end loop;
        end if;

      when 'table/delete' then
        if not p_is_admin then
          raise exception 'forbidden';
        end if;
        delete from demo_tables where id = (v_payload->>'id')::uuid and room_id = v_room;
        if not found then
          v_reason := 'noop';
        end if;

      when 'room/update' then
        if not p_is_admin then
          raise exception 'forbidden';
        end if;
        if jsonb_typeof(v_payload->'is_locked') <> 'boolean' then
          raise exception 'invalid';
        end if;
        update demo_rooms
        set is_locked = (v_payload->>'is_locked')::boolean, updated_at = now(), last_mutation_id = v_id
        where id = v_room and is_locked <> (v_payload->>'is_locked')::boolean;
        if not found then
          v_reason := 'noop';
        end if;

      when 'room/reset' then
        if not p_is_admin then
          raise exception 'forbidden';
        end if;
        delete from demo_tables where room_id = v_room;  -- cascades the claims
        perform demo_seed_tables(v_room, v_id);

      else
        raise exception 'invalid';
    end case;
  exception
    when raise_exception then
      get stacked diagnostics v_reason = message_text;
      v_status := 'rejected';
    when check_violation or not_null_violation or foreign_key_violation or unique_violation
         or invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then
      v_status := 'rejected';
      v_reason := 'invalid';
  end;

  insert into demo_applied_mutations (mutation_id, client_id, status, reason)
  values (v_id, p_client_id, v_status, v_reason);

  return jsonb_build_object('mutationId', v_id, 'status', v_status, 'reason', v_reason);
end $$;

-- Only the service role (our API) can run the server-side functions.
revoke execute on function
  demo_check_geometry(text, integer, integer, integer, integer, integer),
  demo_assert_placement(text, uuid),
  demo_apply_table_update(text, uuid, jsonb, boolean),
  demo_seed_tables(text, uuid),
  demo_register_client(uuid, text, text),
  apply_mutation(jsonb, uuid, boolean)
from public, anon, authenticated;

grant execute on function
  demo_register_client(uuid, text, text),
  apply_mutation(jsonb, uuid, boolean)
to service_role;
