-- Read path without Electric: every change gets a version (rev) from one
-- sequence, deletions leave tombstones, demo_changes() returns what is newer
-- than a version, and a statement-level trigger rings a Realtime Broadcast
-- "doorbell" with just the latest version (never row data).
--
-- Writes are serialized per room by apply_mutation's advisory lock, so
-- versions become visible in the order they were assigned.

create sequence demo_rev;

alter table demo_rooms add column rev bigint not null default 0;
alter table demo_tables add column rev bigint not null default 0;
alter table demo_seat_claims add column rev bigint not null default 0;

create function demo_bump_rev() returns trigger language plpgsql as $$
begin
  new.rev := nextval('demo_rev');
  return new;
end $$;

create trigger demo_rooms_rev before insert or update on demo_rooms
  for each row execute function demo_bump_rev();
create trigger demo_tables_rev before insert or update on demo_tables
  for each row execute function demo_bump_rev();
create trigger demo_seat_claims_rev before insert or update on demo_seat_claims
  for each row execute function demo_bump_rev();

-- Existing rows get their first version.
update demo_rooms set is_locked = is_locked;
update demo_tables set label = label;
update demo_seat_claims set claimed_at = claimed_at;

create table demo_tombstones (
  rev bigint primary key,
  entity text not null check (entity in ('room', 'table', 'seat_claim')),
  key jsonb not null,
  room_id text not null
);
alter table demo_tombstones enable row level security;
revoke all on demo_tombstones from anon, authenticated;

create function demo_tombstone_table() returns trigger language plpgsql as $$
begin
  insert into demo_tombstones (rev, entity, key, room_id)
  values (nextval('demo_rev'), 'table', jsonb_build_object('id', old.id), old.room_id);
  return old;
end $$;
create function demo_tombstone_claim() returns trigger language plpgsql as $$
begin
  insert into demo_tombstones (rev, entity, key, room_id)
  values (nextval('demo_rev'), 'seat_claim',
          jsonb_build_object('table_id', old.table_id, 'seat_index', old.seat_index), old.room_id);
  return old;
end $$;
create trigger demo_tables_tombstone after delete on demo_tables
  for each row execute function demo_tombstone_table();
create trigger demo_seat_claims_tombstone after delete on demo_seat_claims
  for each row execute function demo_tombstone_claim();

-- Everything in the room newer than p_since, in one statement (one snapshot).
-- client_id never leaves the server: claims are returned with owner_tag only.
create function demo_changes(p_room text, p_since bigint) returns jsonb
language sql stable security definer set search_path = public
as $$
  with
    r as (select * from demo_rooms where id = p_room and rev > p_since),
    t as (select * from demo_tables where room_id = p_room and rev > p_since),
    c as (select * from demo_seat_claims where room_id = p_room and rev > p_since),
    d as (select * from demo_tombstones where room_id = p_room and rev > p_since)
  select jsonb_build_object(
    'epoch', demo_epoch(),
    -- The head version of the room (not clamped to p_since): a head BELOW what a
    -- client holds means the database was restored, and the client starts over.
    'rev', coalesce((select max(rev) from (
      select rev from demo_rooms where id = p_room
      union all select rev from demo_tables where room_id = p_room
      union all select rev from demo_seat_claims where room_id = p_room
      union all select rev from demo_tombstones where room_id = p_room) heads), 0),
    'rooms', coalesce((select jsonb_agg(to_jsonb(r) - 'rev') from r), '[]'::jsonb),
    'tables', coalesce((select jsonb_agg(to_jsonb(t) - 'rev') from t), '[]'::jsonb),
    'claims', coalesce((select jsonb_agg(to_jsonb(c) - 'rev' - 'client_id') from c), '[]'::jsonb),
    'deleted', coalesce((select jsonb_agg(jsonb_build_object('entity', d.entity, 'key', d.key) order by d.rev) from d), '[]'::jsonb)
  )
$$;

revoke all on function demo_changes(text, bigint) from public, anon, authenticated;
grant execute on function demo_changes(text, bigint) to service_role;

-- The doorbell. A public Broadcast channel carries only the newest version;
-- phones then ask /api/changes for the data. Where Realtime is absent (a
-- plain Postgres) the failure is swallowed: clients simply poll.
--
-- Deferred constraint triggers fire at COMMIT, once per changed row, so the
-- first one rings with the transaction's FINAL version and the rest skip: one
-- message per transaction however many rows (a reset touches ~100).
create function demo_ping() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('mesas.pinged', true), '') = 'on' then
    return null;
  end if;
  perform set_config('mesas.pinged', 'on', true);
  begin
    perform realtime.send(
      jsonb_build_object('rev', (select last_value from demo_rev)), 'rev', 'mesas', false);
  exception when others then
    null;
  end;
  return null;
end $$;

create constraint trigger demo_rooms_ping after insert or update or delete on demo_rooms
  deferrable initially deferred for each row execute function demo_ping();
create constraint trigger demo_tables_ping after insert or update or delete on demo_tables
  deferrable initially deferred for each row execute function demo_ping();
create constraint trigger demo_seat_claims_ping after insert or update or delete on demo_seat_claims
  deferrable initially deferred for each row execute function demo_ping();
