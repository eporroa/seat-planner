-- A person may now hold several chairs: up to 20 for attendees (the oldest is
-- released automatically beyond that), unlimited for admins. The old rule was
-- one chair per person, enforced by a unique constraint and by releasing the
-- previous claim on every new one.
alter table demo_seat_claims drop constraint demo_seat_claims_room_id_client_id_key;
create index demo_seat_claims_owner_idx on demo_seat_claims (room_id, client_id);
-- "Oldest" must be well defined even for claims made in one transaction.
alter table demo_seat_claims alter column claimed_at set default clock_timestamp();

create or replace function apply_mutation(p_mutation jsonb, p_client_id uuid, p_is_admin boolean)
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
          insert into demo_seat_claims (table_id, seat_index, room_id, client_id, owner_tag,
                                        client_name, last_mutation_id)
          values (v_table_id, v_seat, v_room, p_client_id, v_tag, v_name, v_id);
          -- Attendees hold at most 20 chairs: past that, the oldest ones are released
          -- (after the new claim succeeded, so a failure never costs anyone a seat).
          -- Admins have no limit.
          if not p_is_admin then
            delete from demo_seat_claims c
            using (
              select table_id, seat_index from demo_seat_claims
              where room_id = v_room and client_id = p_client_id
              order by claimed_at desc, table_id, seat_index
              offset 20
            ) old
            where c.table_id = old.table_id and c.seat_index = old.seat_index;
          end if;
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
