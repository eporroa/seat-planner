-- Rules test for the changes feed (demo_changes, versions, tombstones, doorbell).
--   pnpm test:db
-- Everything happens in one transaction that is rolled back at the end.
\set ON_ERROR_STOP on
\set QUIET on
begin;

create function pg_temp.assert(label text, cond boolean) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL - %', label; end if;
  raise notice 'ok - %', label;
end $$;

create function pg_temp.reg(base text) returns uuid language plpgsql as $$
declare c uuid := gen_random_uuid();
begin
  perform demo_register_client(c, 'jsconf-mx-2026', base);
  return c;
end $$;

create function pg_temp.m(c uuid, adm boolean, entity text, op text, payload jsonb)
returns jsonb language sql as $$
  select apply_mutation(jsonb_build_object('mutation_id', gen_random_uuid(),
    'entity', entity, 'op', op, 'payload', payload), c, adm)
$$;

-- Like m(), but forgets the client's recent mutations first: the whole test runs in one
-- transaction (one timestamp), which would otherwise trip the 20-per-10-seconds rate limit.
create function pg_temp.mm(c uuid, adm boolean, entity text, op text, payload jsonb)
returns jsonb language plpgsql as $$
begin
  delete from demo_applied_mutations where client_id = c;
  return pg_temp.m(c, adm, entity, op, payload);
end $$;

create function pg_temp.changes(since bigint) returns jsonb language sql as $$
  select demo_changes('jsconf-mx-2026', since)
$$;

\set t1 '''00000000-0000-4000-8000-000000000001'''

-- ---------------------------------------------------------------- snapshot
select pg_temp.assert('since=0 returns every table', jsonb_array_length(pg_temp.changes(0)->'tables') = 12);
select pg_temp.assert('since=0 returns the room', jsonb_array_length(pg_temp.changes(0)->'rooms') = 1);
select pg_temp.assert('the response carries the cluster epoch', (pg_temp.changes(0)->>'epoch') = demo_epoch());
select pg_temp.assert('rev equals the newest version', (pg_temp.changes(0)->>'rev')::bigint = (select max(rev) from demo_tables));
select pg_temp.assert('nothing is newer than the newest version',
  jsonb_array_length(pg_temp.changes((pg_temp.changes(0)->>'rev')::bigint)->'tables') = 0
  and (pg_temp.changes((pg_temp.changes(0)->>'rev')::bigint)->>'rev')::bigint = (pg_temp.changes(0)->>'rev')::bigint);
select pg_temp.assert('rows do not leak the internal rev column', not (pg_temp.changes(0)->'tables'->0 ? 'rev'));
select pg_temp.assert('a client ahead of the server sees a lower head (restore detection)', (pg_temp.changes(999999999)->>'rev')::bigint < 999999999);
select pg_temp.assert('another room sees nothing', demo_changes('some-other-room', 0)->'tables' = '[]'::jsonb);

-- ---------------------------------------------------------------- claims
do $$
declare
  c uuid := pg_temp.reg('Test' || substr(md5(random()::text), 1, 6));
  before_rev bigint := (pg_temp.changes(0)->>'rev')::bigint;
  r jsonb;
  claim jsonb;
begin
  perform pg_temp.m(c, false, 'seat_claim', 'insert', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000001', 'seat_index', 2));
  r := pg_temp.changes(before_rev);
  perform pg_temp.assert('a claim shows up as the only change', jsonb_array_length(r->'claims') = 1 and jsonb_array_length(r->'tables') = 0);
  perform pg_temp.assert('rev moved forward', (r->>'rev')::bigint > before_rev);
  claim := r->'claims'->0;
  perform pg_temp.assert('claims never include client_id', not (claim ? 'client_id'));
  perform pg_temp.assert('claims carry owner_tag and the echo mutation id', claim ? 'owner_tag' and claim->>'last_mutation_id' is not null);
  perform pg_temp.assert('owner_tag is md5 of the client id', claim->>'owner_tag' = md5(c::text));

  -- Releasing leaves a tombstone, not a row.
  before_rev := (r->>'rev')::bigint;
  perform pg_temp.m(c, false, 'seat_claim', 'delete', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000001', 'seat_index', 2));
  r := pg_temp.changes(before_rev);
  perform pg_temp.assert('a release is a tombstone', r->'deleted'->0->>'entity' = 'seat_claim'
    and (r->'deleted'->0->'key'->>'seat_index')::int = 2 and jsonb_array_length(r->'claims') = 0);

  -- Claiming more chairs just adds rows: nothing is released until the 20-chair limit.
  before_rev := (r->>'rev')::bigint;
  perform pg_temp.mm(c, false, 'seat_claim', 'insert', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000001', 'seat_index', 3));
  perform pg_temp.mm(c, false, 'seat_claim', 'insert', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000001', 'seat_index', 4));
  r := pg_temp.changes(before_rev);
  perform pg_temp.assert('claiming two more chairs yields two rows and no tombstones', jsonb_array_length(r->'deleted') = 0 and jsonb_array_length(r->'claims') = 2);

  -- Past the limit the oldest is released: its tombstone comes with the new row.
  for i in 5..8 loop
    perform pg_temp.mm(c, false, 'seat_claim', 'insert', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000001', 'seat_index', i));
  end loop;
  for i in 1..8 loop
    perform pg_temp.mm(c, false, 'seat_claim', 'insert', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000003', 'seat_index', i));
  end loop;
  for i in 1..6 loop
    perform pg_temp.mm(c, false, 'seat_claim', 'insert', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000004', 'seat_index', i));
  end loop;
  before_rev := (pg_temp.changes(0)->>'rev')::bigint;
  perform pg_temp.mm(c, false, 'seat_claim', 'insert', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000004', 'seat_index', 7));
  r := pg_temp.changes(before_rev);
  perform pg_temp.assert('a claim past the limit yields a tombstone for the oldest and the new row',
    jsonb_array_length(r->'deleted') = 1 and jsonb_array_length(r->'claims') = 1);
end $$;

-- ---------------------------------------------------------------- table updates, deletes, cascades
do $$
declare
  admin uuid := pg_temp.reg('Test' || substr(md5(random()::text), 1, 6));
  other uuid := pg_temp.reg('Test' || substr(md5(random()::text), 1, 6));
  before_rev bigint;
  r jsonb;
begin
  perform pg_temp.m(other, false, 'seat_claim', 'insert', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000001', 'seat_index', 6));
  before_rev := (pg_temp.changes(0)->>'rev')::bigint;
  perform pg_temp.m(admin, true, 'table', 'update', jsonb_build_object('id', '00000000-0000-4000-8000-000000000001', 'label', 'Renombrada'));
  r := pg_temp.changes(before_rev);
  perform pg_temp.assert('an update returns the whole changed row', jsonb_array_length(r->'tables') = 1 and r->'tables'->0->>'label' = 'Renombrada');

  before_rev := (r->>'rev')::bigint;
  perform pg_temp.m(admin, true, 'table', 'delete', jsonb_build_object('id', '00000000-0000-4000-8000-000000000001'));
  r := pg_temp.changes(before_rev);
  perform pg_temp.assert('deleting a table tombstones it', exists (
    select 1 from jsonb_array_elements(r->'deleted') d where d->>'entity' = 'table' and d->'key'->>'id' = '00000000-0000-4000-8000-000000000001'));
  perform pg_temp.assert('the cascade tombstones its claims', exists (
    select 1 from jsonb_array_elements(r->'deleted') d where d->>'entity' = 'seat_claim' and d->'key'->>'table_id' = '00000000-0000-4000-8000-000000000001'));

  -- Reset deletes and re-creates the same ids: the tombstones must be OLDER than the new rows.
  before_rev := (r->>'rev')::bigint;
  perform pg_temp.m(admin, true, 'room', 'reset', '{}'::jsonb);
  r := pg_temp.changes(before_rev);
  perform pg_temp.assert('reset re-creates all 12 tables', jsonb_array_length(r->'tables') = 12);
  perform pg_temp.assert('reset rows are newer than every tombstone of the same table',
    not exists (select 1 from demo_tombstones t join demo_tables d on d.id = (t.key->>'id')::uuid
                where t.entity = 'table' and t.rev > d.rev));
end $$;

-- ---------------------------------------------------------------- access
select pg_temp.assert('versions are unique across tables', (select count(*) from (
  select rev from demo_tables union all select rev from demo_seat_claims union all select rev from demo_rooms) x) =
  (select count(distinct rev) from (
  select rev from demo_tables union all select rev from demo_seat_claims union all select rev from demo_rooms) x));

do $$
begin
  set local role anon;
  begin
    perform demo_changes('jsconf-mx-2026', 0);
    reset role;
    raise exception 'FAIL - anon can call demo_changes';
  exception when insufficient_privilege then
    reset role;
    raise notice 'ok - anon cannot call demo_changes';
  end;
  set local role anon;
  begin
    perform count(*) from demo_tombstones;
    reset role;
    raise exception 'FAIL - anon can read demo_tombstones';
  exception when insufficient_privilege then
    reset role;
    raise notice 'ok - anon cannot read demo_tombstones';
  end;
end $$;

-- The doorbell: a change leaves a public broadcast message holding only the version.
do $$
declare
  before_count bigint;
  last_rev bigint;
begin
  if to_regclass('realtime.messages') is null then
    raise notice 'skip - realtime is not installed here';
    return;
  end if;
  select count(*) into before_count from realtime.messages where topic = 'mesas';
  update demo_rooms set is_locked = is_locked;
  set constraints all immediate; -- the test never commits, so fire the deferred triggers now
  perform pg_temp.assert('a change rings the doorbell', (select count(*) from realtime.messages where topic = 'mesas') > before_count);
  select max((payload->>'rev')::bigint) into last_rev from realtime.messages where topic = 'mesas';
  perform pg_temp.assert('the doorbell carries the newest version', last_rev = (select last_value from demo_rev));
  update demo_tables set label = label;
  update demo_tables set label = label;
  set constraints all immediate;
  perform pg_temp.assert('a transaction rings only once however many rows changed',
    (select count(*) from realtime.messages where topic = 'mesas') = before_count + 1);
  -- Realtime adds its own message id; anything else would be data leaking into the broadcast.
  perform pg_temp.assert('the doorbell carries nothing but the version', not exists (
    select 1 from realtime.messages m, jsonb_object_keys(m.payload) k where m.topic = 'mesas' and k not in ('rev', 'id')));
end $$;

rollback;
\echo All changes feed rules passed
