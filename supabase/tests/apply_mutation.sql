-- Rules test for apply_mutation(). Run against the local stack:
--   pnpm test:db
-- Everything happens in one transaction that is rolled back at the end.
\set ON_ERROR_STOP on
\set QUIET on
begin;

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

create function pg_temp.expect(label text, r jsonb, st text, rsn text default null)
returns void language plpgsql as $$
begin
  if r->>'status' is distinct from st or (rsn is not null and r->>'reason' is distinct from rsn) then
    raise exception 'FAIL - %: expected %/% got %', label, st, coalesce(rsn, '*'), r;
  end if;
  raise notice 'ok - %', label;
end $$;

create function pg_temp.assert(label text, cond boolean) returns void language plpgsql as $$
begin
  if cond is not true then raise exception 'FAIL - %', label; end if;
  raise notice 'ok - %', label;
end $$;

-- Seeded tables: 0001 circle r60 at (140,120); 0002 rect 200x80 at (500,140);
-- 0004 rect at (1300,140); 0005 rect at (100,460).
\set t1 '''00000000-0000-4000-8000-000000000001'''
\set t2 '''00000000-0000-4000-8000-000000000002'''
\set t4 '''00000000-0000-4000-8000-000000000004'''

select pg_temp.assert('seed has 12 tables', (select count(*) from demo_tables where room_id = 'jsconf-mx-2026') = 12);

-- ---------------------------------------------------------------- names
do $$
declare a uuid; b uuid; c uuid; d uuid;
        base text := 'Test' || substr(md5(random()::text), 1, 8);  -- unique per run: independent of leftover clients
begin
  a := pg_temp.reg(base); b := pg_temp.reg(base); c := pg_temp.reg(base);
  perform pg_temp.assert('first name has no suffix', (select display_name from demo_clients where client_id = a) = base);
  perform pg_temp.assert('duplicates get the next number', (select display_name from demo_clients where client_id = b) = base || '2'
    and (select display_name from demo_clients where client_id = c) = base || '3');
  perform demo_register_client(a, 'jsconf-mx-2026', 'LoboJade' || substr(base, 5));  -- rename frees the slot
  d := pg_temp.reg(base);
  perform pg_temp.assert('lowest free suffix is reused', (select display_name from demo_clients where client_id = d) = base);
end $$;

-- ---------------------------------------------------------------- seat claims
do $$
declare a uuid := pg_temp.reg('AjoloteAzul'); b uuid := pg_temp.reg('CoyoteRosa'); adm uuid := pg_temp.reg('PumaGris');
        t1 uuid := '00000000-0000-4000-8000-000000000001';
begin
  perform pg_temp.expect('claim a free seat', pg_temp.m(a, false, 'seat_claim', 'insert', jsonb_build_object('table_id', t1, 'seat_index', 1)), 'applied');
  perform pg_temp.assert('claim stores owner_tag and name', (select s.owner_tag = md5(a::text) and s.client_name = d.display_name from demo_seat_claims s join demo_clients d using (client_id) where s.table_id = t1 and s.seat_index = 1));
  perform pg_temp.expect('taken seat is rejected', pg_temp.m(b, false, 'seat_claim', 'insert', jsonb_build_object('table_id', t1, 'seat_index', 1)), 'rejected', 'seat_taken');
  perform pg_temp.expect('claiming another seat keeps the first one', pg_temp.m(a, false, 'seat_claim', 'insert', jsonb_build_object('table_id', t1, 'seat_index', 2)), 'applied');
  perform pg_temp.assert('a person can hold several chairs', (select count(*) from demo_seat_claims where client_id = a) = 2);
  perform pg_temp.expect('b claims seat 3', pg_temp.m(b, false, 'seat_claim', 'insert', jsonb_build_object('table_id', t1, 'seat_index', 3)), 'applied');
  perform pg_temp.expect('seat_taken changes nothing for me', pg_temp.m(a, false, 'seat_claim', 'insert', jsonb_build_object('table_id', t1, 'seat_index', 3)), 'rejected', 'seat_taken');
  perform pg_temp.assert('my seats survived the rejected claim', (select count(*) from demo_seat_claims where client_id = a) = 2);
  perform pg_temp.expect('claiming my own seat again is a noop', pg_temp.m(a, false, 'seat_claim', 'insert', jsonb_build_object('table_id', t1, 'seat_index', 2)), 'applied', 'noop');
  perform pg_temp.expect('seat beyond seat_limit', pg_temp.m(a, false, 'seat_claim', 'insert', jsonb_build_object('table_id', t1, 'seat_index', 9)), 'rejected', 'invalid_seat');
  perform pg_temp.expect('unknown table', pg_temp.m(a, false, 'seat_claim', 'insert', jsonb_build_object('table_id', gen_random_uuid(), 'seat_index', 1)), 'rejected', 'not_found');
  perform pg_temp.expect('attendee cannot release someone else''s seat', pg_temp.m(b, false, 'seat_claim', 'delete', jsonb_build_object('table_id', t1, 'seat_index', 2)), 'rejected', 'forbidden');
  perform pg_temp.expect('admin releases anyone''s seat', pg_temp.m(adm, true, 'seat_claim', 'delete', jsonb_build_object('table_id', t1, 'seat_index', 2)), 'applied');
  perform pg_temp.expect('release own seat', pg_temp.m(b, false, 'seat_claim', 'delete', jsonb_build_object('table_id', t1, 'seat_index', 3)), 'applied');
  perform pg_temp.expect('releasing a free seat is a noop', pg_temp.m(b, false, 'seat_claim', 'delete', jsonb_build_object('table_id', t1, 'seat_index', 3)), 'applied', 'noop');
  perform pg_temp.m(a, false, 'seat_claim', 'insert', jsonb_build_object('table_id', t1, 'seat_index', 4));
  perform demo_register_client(a, 'jsconf-mx-2026', 'Test' || substr(md5(random()::text), 1, 8));
  perform pg_temp.assert('renaming updates existing claims', (select bool_and(c.client_name = d.display_name and c.client_name <> 'AjoloteAzul')
    from demo_seat_claims c join demo_clients d using (client_id) where c.client_id = a));
end $$;

-- ---------------------------------------------------------------- seat limit
-- Attendees hold at most 20 chairs (the oldest goes first); admins have no limit.
-- pg_temp.nth(i, first_table): the i-th chair counting through the seeded tables from first_table.
create function pg_temp.nth(i integer, first_table integer) returns jsonb language sql as $$
  select jsonb_build_object('table_id', t.id, 'seat_index', i - t.before)
  from (select id, seat_limit,
               coalesce(sum(seat_limit) over (order by id rows between unbounded preceding and 1 preceding), 0) as before
        from demo_tables
        where room_id = 'jsconf-mx-2026'
          and id >= ('00000000-0000-4000-8000-' || lpad(first_table::text, 12, '0'))::uuid) t
  where i > t.before and i <= t.before + t.seat_limit
$$;

do $$
declare g uuid := pg_temp.reg('GatoVerde'); adm uuid := pg_temp.reg('LoboAzul'); holder uuid := pg_temp.reg('BuhoRojo');
        t1 uuid := '00000000-0000-4000-8000-000000000001';
        r jsonb;
begin
  for i in 1..20 loop
    r := pg_temp.mm(g, false, 'seat_claim', 'insert', pg_temp.nth(i, 3));
    if r->>'status' <> 'applied' then raise exception 'FAIL - claim % got %', i, r; end if;
  end loop;
  perform pg_temp.assert('an attendee can hold 20 chairs', (select count(*) from demo_seat_claims where client_id = g) = 20);

  perform pg_temp.mm(holder, false, 'seat_claim', 'insert', jsonb_build_object('table_id', t1, 'seat_index', 5));
  perform pg_temp.expect('a taken chair is rejected at the limit', pg_temp.mm(g, false, 'seat_claim', 'insert', jsonb_build_object('table_id', t1, 'seat_index', 5)), 'rejected', 'seat_taken');
  perform pg_temp.assert('a rejected claim releases nothing', (select count(*) from demo_seat_claims where client_id = g) = 20);
  perform pg_temp.expect('claiming my own chair again is a noop at the limit', pg_temp.mm(g, false, 'seat_claim', 'insert', pg_temp.nth(7, 3)), 'applied', 'noop');
  perform pg_temp.assert('a noop releases nothing', (select count(*) from demo_seat_claims where client_id = g) = 20);

  perform pg_temp.expect('a 21st chair is accepted', pg_temp.mm(g, false, 'seat_claim', 'insert', pg_temp.nth(21, 3)), 'applied');
  perform pg_temp.assert('still exactly 20 chairs', (select count(*) from demo_seat_claims where client_id = g) = 20);
  perform pg_temp.assert('the OLDEST chair was released', not exists (
    select 1 from demo_seat_claims where client_id = g and table_id = (pg_temp.nth(1, 3)->>'table_id')::uuid and seat_index = (pg_temp.nth(1, 3)->>'seat_index')::int));
  perform pg_temp.assert('the newest chair is held', exists (
    select 1 from demo_seat_claims where client_id = g and table_id = (pg_temp.nth(21, 3)->>'table_id')::uuid and seat_index = (pg_temp.nth(21, 3)->>'seat_index')::int));
  perform pg_temp.assert('the second-oldest survived', exists (
    select 1 from demo_seat_claims where client_id = g and table_id = (pg_temp.nth(2, 3)->>'table_id')::uuid and seat_index = (pg_temp.nth(2, 3)->>'seat_index')::int));

  perform pg_temp.mm(g, false, 'seat_claim', 'delete', pg_temp.nth(21, 3));
  perform pg_temp.assert('releasing one leaves 19, and the next claim just adds', (select count(*) from demo_seat_claims where client_id = g) = 19);
  perform pg_temp.mm(g, false, 'seat_claim', 'insert', pg_temp.nth(22, 3));
  perform pg_temp.assert('back to 20 without releasing anything else', (select count(*) from demo_seat_claims where client_id = g) = 20
    and exists (select 1 from demo_seat_claims where client_id = g and table_id = (pg_temp.nth(2, 3)->>'table_id')::uuid and seat_index = (pg_temp.nth(2, 3)->>'seat_index')::int));

  for i in 1..30 loop
    r := pg_temp.mm(adm, true, 'seat_claim', 'insert', pg_temp.nth(i, 9));
    if r->>'status' <> 'applied' then raise exception 'FAIL - admin claim % got %', i, r; end if;
  end loop;
  perform pg_temp.assert('an admin can hold any number of chairs', (select count(*) from demo_seat_claims where client_id = adm) = 30);
end $$;

-- ---------------------------------------------------------------- tables: attendee
do $$
declare a uuid := pg_temp.reg('ZorroLila'); adm uuid := pg_temp.reg('LoboMenta');
        t1 uuid := '00000000-0000-4000-8000-000000000001';
        t2 uuid := '00000000-0000-4000-8000-000000000002';
begin
  perform pg_temp.expect('attendee moves a table', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t1, 'pos_x', 140, 'pos_y', 240)), 'applied');
  perform pg_temp.assert('move stamps last_mutation_id', (select last_mutation_id is not null and pos_y = 240 from demo_tables where id = t1));
  perform pg_temp.expect('move onto another table', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t1, 'pos_x', 500, 'pos_y', 140)), 'rejected', 'overlap');
  perform pg_temp.expect('footprints need one cell of clearance', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t1, 'pos_x', 480, 'pos_y', 240)), 'rejected', 'overlap');
  perform pg_temp.expect('move outside the room', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t1, 'pos_x', 0, 'pos_y', 0)), 'rejected', 'out_of_bounds');
  perform pg_temp.expect('chair ring must fit too', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t1, 'pos_x', 1460, 'pos_y', 240)), 'rejected', 'out_of_bounds');
  perform pg_temp.expect('off-grid position', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t1, 'pos_x', 145, 'pos_y', 240)), 'rejected', 'invalid_grid');
  perform pg_temp.assert('rejected moves changed nothing', (select pos_x = 140 and pos_y = 240 from demo_tables where id = t1));
  perform pg_temp.expect('same position is a noop', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t1, 'pos_x', 140, 'pos_y', 240)), 'applied', 'noop');
  perform pg_temp.expect('attendee cannot resize', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t1, 'shape_radius', 80)), 'rejected', 'forbidden');
  perform pg_temp.expect('attendee cannot rename', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t1, 'label', 'Hackeada')), 'rejected', 'forbidden');
  perform pg_temp.expect('attendee cannot decrease chairs', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t1, 'seat_limit', 7)), 'rejected', 'forbidden');
  perform pg_temp.expect('attendee increases chairs', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t1, 'seat_limit', 9)), 'applied');
  perform pg_temp.expect('chair count max is 12', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t1, 'seat_limit', 13)), 'rejected', 'invalid');
  perform pg_temp.expect('attendee cannot delete', pg_temp.m(a, false, 'table', 'delete', jsonb_build_object('id', t2)), 'rejected', 'forbidden');
  perform pg_temp.expect('attendee cannot create', pg_temp.m(a, false, 'table', 'insert', jsonb_build_object('id', gen_random_uuid(), 'label', 'X', 'shape', 'circular', 'pos_x', 1140, 'pos_y', 300, 'seat_limit', 4, 'shape_radius', 40)), 'rejected', 'forbidden');
  perform pg_temp.expect('attendee cannot batch update', pg_temp.m(a, false, 'table', 'batch_update', jsonb_build_object('tables', jsonb_build_array(jsonb_build_object('id', t1, 'pos_x', 140, 'pos_y', 240)))), 'rejected', 'forbidden');
  perform pg_temp.expect('attendee cannot lock the layout', pg_temp.m(a, false, 'room', 'update', jsonb_build_object('is_locked', true)), 'rejected', 'forbidden');
  perform pg_temp.expect('attendee cannot reset the demo', pg_temp.m(a, false, 'room', 'reset', '{}'::jsonb), 'rejected', 'forbidden');
  perform pg_temp.assert('forbidden calls changed nothing', (select count(*) from demo_tables where room_id = 'jsconf-mx-2026') = 12);
  perform pg_temp.expect('unknown entity', pg_temp.m(a, false, 'banana', 'peel', '{}'::jsonb), 'rejected', 'invalid');
  perform pg_temp.expect('malformed number', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t1, 'pos_x', 'abc')), 'rejected', 'invalid');

  -- ------------------------------------------------------------ admin
  perform pg_temp.expect('admin renames', pg_temp.m(adm, true, 'table', 'update', jsonb_build_object('id', t1, 'label', 'Mesa VIP')), 'applied');
  perform pg_temp.m(adm, true, 'table', 'update', jsonb_build_object('id', t1, 'pos_x', 140, 'pos_y', 120));  -- back to the seed spot
  perform pg_temp.expect('admin resizes', pg_temp.m(adm, true, 'table', 'update', jsonb_build_object('id', t1, 'shape_radius', 80)), 'applied');
  perform pg_temp.expect('resize that collides with a neighbor', pg_temp.m(adm, true, 'table', 'update', jsonb_build_object('id', t2, 'shape_height', 320)), 'rejected', 'overlap');
  perform pg_temp.expect('radius out of range', pg_temp.m(adm, true, 'table', 'update', jsonb_build_object('id', t1, 'shape_radius', 120)), 'rejected', 'invalid_size');
  perform pg_temp.expect('rectangle size out of range', pg_temp.m(adm, true, 'table', 'update', jsonb_build_object('id', t2, 'shape_width', 400)), 'rejected', 'invalid_size');
  perform pg_temp.expect('admin creates a table', pg_temp.m(adm, true, 'table', 'insert', jsonb_build_object('id', '10000000-0000-4000-8000-000000000001', 'label', 'Nueva', 'shape', 'circular', 'pos_x', 1140, 'pos_y', 300, 'seat_limit', 4, 'shape_radius', 40)), 'applied');
  perform pg_temp.expect('created table must not overlap', pg_temp.m(adm, true, 'table', 'insert', jsonb_build_object('id', gen_random_uuid(), 'shape', 'circular', 'pos_x', 1140, 'pos_y', 300, 'seat_limit', 4, 'shape_radius', 40)), 'rejected', 'overlap');
  perform pg_temp.expect('created table must be inside', pg_temp.m(adm, true, 'table', 'insert', jsonb_build_object('id', gen_random_uuid(), 'shape', 'circular', 'pos_x', 1580, 'pos_y', 300, 'seat_limit', 4, 'shape_radius', 40)), 'rejected', 'out_of_bounds');
  perform pg_temp.expect('circle must not carry width', pg_temp.m(adm, true, 'table', 'insert', jsonb_build_object('id', gen_random_uuid(), 'shape', 'circular', 'pos_x', 1140, 'pos_y', 100, 'seat_limit', 4, 'shape_radius', 40, 'shape_width', 100)), 'rejected', 'invalid_size');
  perform pg_temp.expect('label too long', pg_temp.m(adm, true, 'table', 'insert', jsonb_build_object('id', gen_random_uuid(), 'label', repeat('x', 21), 'shape', 'circular', 'pos_x', 1140, 'pos_y', 100, 'seat_limit', 4, 'shape_radius', 40)), 'rejected', 'invalid');
end $$;

-- ---------------------------------------------------------------- seat limits vs claims
do $$
declare a uuid := pg_temp.reg('PumaOcre'); adm uuid := pg_temp.reg('IguanaJade');
        t2 uuid := '00000000-0000-4000-8000-000000000002';
begin
  perform pg_temp.m(a, false, 'seat_claim', 'insert', jsonb_build_object('table_id', t2, 'seat_index', 8));
  perform pg_temp.expect('cannot drop below the highest claimed seat', pg_temp.m(adm, true, 'table', 'update', jsonb_build_object('id', t2, 'seat_limit', 7)), 'rejected', 'seats_claimed');
  perform pg_temp.expect('admin can decrease above it', pg_temp.m(adm, true, 'table', 'update', jsonb_build_object('id', t2, 'seat_limit', 8)), 'applied');
end $$;

-- ---------------------------------------------------------------- locked layout
do $$
declare a uuid := pg_temp.reg('TortugaFucsia'); adm uuid := pg_temp.reg('BallenaCian');
        t4 uuid := '00000000-0000-4000-8000-000000000004';
begin
  perform pg_temp.expect('admin locks the layout', pg_temp.m(adm, true, 'room', 'update', jsonb_build_object('is_locked', true)), 'applied');
  perform pg_temp.expect('locked: attendee cannot move', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t4, 'pos_x', 1300, 'pos_y', 160)), 'rejected', 'locked');
  perform pg_temp.expect('locked: attendee cannot add chairs', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t4, 'seat_limit', 11)), 'rejected', 'locked');
  perform pg_temp.expect('locked: attendee can still claim', pg_temp.m(a, false, 'seat_claim', 'insert', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000006'::uuid, 'seat_index', 1)), 'applied');
  perform pg_temp.expect('locked: attendee can still release', pg_temp.m(a, false, 'seat_claim', 'delete', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000006'::uuid, 'seat_index', 1)), 'applied');
  perform pg_temp.expect('locked: admin can still move', pg_temp.m(adm, true, 'table', 'update', jsonb_build_object('id', t4, 'pos_x', 1300, 'pos_y', 160)), 'applied');
  perform pg_temp.expect('locking twice is a noop', pg_temp.m(adm, true, 'room', 'update', jsonb_build_object('is_locked', true)), 'applied', 'noop');
  perform pg_temp.expect('admin unlocks', pg_temp.m(adm, true, 'room', 'update', jsonb_build_object('is_locked', false)), 'applied');
  perform pg_temp.expect('unlocked: attendee moves again', pg_temp.m(a, false, 'table', 'update', jsonb_build_object('id', t4, 'pos_x', 1300, 'pos_y', 140)), 'applied');
end $$;

-- ---------------------------------------------------------------- batch: final state wins
do $$
declare adm uuid := pg_temp.reg('GuacamayaAzul');
        t2 uuid := '00000000-0000-4000-8000-000000000002';
        t4 uuid := '00000000-0000-4000-8000-000000000004';
begin
  -- Swapping two tables overlaps in the middle but is valid in the end.
  perform pg_temp.expect('batch swap is validated on the final state', pg_temp.m(adm, true, 'table', 'batch_update', jsonb_build_object('tables', jsonb_build_array(
    jsonb_build_object('id', t2, 'pos_x', 1300, 'pos_y', 140), jsonb_build_object('id', t4, 'pos_x', 500, 'pos_y', 140)))), 'applied');
  perform pg_temp.assert('swap landed', (select pos_x from demo_tables where id = t2) = 1300 and (select pos_x from demo_tables where id = t4) = 500);
  perform pg_temp.expect('batch with a colliding final state', pg_temp.m(adm, true, 'table', 'batch_update', jsonb_build_object('tables', jsonb_build_array(
    jsonb_build_object('id', t2, 'pos_x', 900, 'pos_y', 300), jsonb_build_object('id', t4, 'pos_x', 900, 'pos_y', 300)))), 'rejected', 'overlap');
  perform pg_temp.assert('rejected batch rolled back completely', (select pos_x from demo_tables where id = t2) = 1300 and (select pos_x from demo_tables where id = t4) = 500);
  perform pg_temp.expect('empty batch', pg_temp.m(adm, true, 'table', 'batch_update', jsonb_build_object('tables', '[]'::jsonb)), 'rejected', 'invalid');
end $$;

-- ---------------------------------------------------------------- delete cascades claims
do $$
declare a uuid := pg_temp.reg('LoboEscarlata'); adm uuid := pg_temp.reg('TapirJade');
        t5 uuid := '00000000-0000-4000-8000-000000000005';
begin
  perform pg_temp.m(a, false, 'seat_claim', 'insert', jsonb_build_object('table_id', t5, 'seat_index', 1));
  perform pg_temp.expect('admin deletes a table', pg_temp.m(adm, true, 'table', 'delete', jsonb_build_object('id', t5)), 'applied');
  perform pg_temp.assert('delete cascades its claims', not exists (select 1 from demo_seat_claims where table_id = t5));
  perform pg_temp.expect('deleting a missing table is a noop', pg_temp.m(adm, true, 'table', 'delete', jsonb_build_object('id', t5)), 'applied', 'noop');
end $$;

-- ---------------------------------------------------------------- 60 table cap
do $$
declare adm uuid := pg_temp.reg('CacomixtleGris');
begin
  insert into demo_tables (id, room_id, label, shape, pos_x, pos_y, seat_limit, shape_radius)
  select gen_random_uuid(), 'jsconf-mx-2026', 'fill', 'circular', 0, 0, 4, 40
  from generate_series(1, 60 - (select count(*) from demo_tables where room_id = 'jsconf-mx-2026')::int);
  perform pg_temp.expect('max 60 tables per room', pg_temp.m(adm, true, 'table', 'insert', jsonb_build_object('id', gen_random_uuid(), 'shape', 'circular', 'pos_x', 700, 'pos_y', 300, 'seat_limit', 4, 'shape_radius', 40)), 'rejected', 'too_many_tables');
end $$;

-- ---------------------------------------------------------------- reset
do $$
declare a uuid := pg_temp.reg('OceloteViolet'); adm uuid := pg_temp.reg('ArmadilloCian');
begin
  perform pg_temp.m(a, false, 'seat_claim', 'insert', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000001', 'seat_index', 1));
  perform pg_temp.expect('admin resets the demo', pg_temp.m(adm, true, 'room', 'reset', '{}'::jsonb), 'applied');
  perform pg_temp.assert('reset restores the 12 seed tables', (select count(*) from demo_tables where room_id = 'jsconf-mx-2026') = 12
    and (select pos_x = 140 and pos_y = 120 and label = 'Mesa 1' from demo_tables where id = '00000000-0000-4000-8000-000000000001'));
  perform pg_temp.assert('reset clears every claim', (select count(*) from demo_seat_claims) = 0);
  perform pg_temp.assert('reset stamps the mutation id', (select count(*) from demo_tables where last_mutation_id is not null) = 12);
end $$;

-- ---------------------------------------------------------------- idempotency, rate limit, identity
do $$
declare a uuid := pg_temp.reg('MariposaLila'); x uuid := pg_temp.reg('FlamencoRosa'); mid uuid := gen_random_uuid();
        req jsonb; r1 jsonb; r2 jsonb; rl jsonb; rl_id uuid := gen_random_uuid(); i int;
begin
  req := jsonb_build_object('mutation_id', mid, 'entity', 'seat_claim', 'op', 'insert',
    'payload', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000001', 'seat_index', 4));
  r1 := apply_mutation(req, a, false);
  r2 := apply_mutation(req, a, false);
  perform pg_temp.assert('retry returns the stored result', r1 = r2 and r1->>'status' = 'applied');
  perform pg_temp.assert('retry does not apply twice', (select count(*) from demo_applied_mutations where mutation_id = mid) = 1);

  perform pg_temp.expect('unknown client is rejected', apply_mutation(jsonb_build_object('mutation_id', gen_random_uuid(), 'entity', 'room', 'op', 'update', 'payload', '{}'::jsonb), gen_random_uuid(), true), 'rejected', 'unknown_client');
  perform pg_temp.assert('unknown client is retryable (a new session fixes it)', (apply_mutation(jsonb_build_object('mutation_id', gen_random_uuid(), 'entity', 'room', 'op', 'update', 'payload', '{}'::jsonb), gen_random_uuid(), true)->>'retryable')::boolean);

  for i in 1..21 loop
    perform pg_temp.m(x, false, 'seat_claim', 'delete', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000001', 'seat_index', 12));
  end loop;
  rl := apply_mutation(jsonb_build_object('mutation_id', rl_id, 'entity', 'seat_claim', 'op', 'delete',
    'payload', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000001', 'seat_index', 12)), x, false);
  perform pg_temp.expect('more than 20 mutations in 10 s is rate limited', rl, 'rejected', 'rate_limited');
  perform pg_temp.assert('rate_limited is retryable and not recorded', (rl->>'retryable')::boolean and not exists (select 1 from demo_applied_mutations where mutation_id = rl_id));
  perform pg_temp.expect('admins are exempt from the rate limit', pg_temp.m(x, true, 'seat_claim', 'delete', jsonb_build_object('table_id', '00000000-0000-4000-8000-000000000001', 'seat_index', 12)), 'applied');
end $$;

-- ---------------------------------------------------------------- privileges
select pg_temp.assert('anon cannot run apply_mutation', not has_function_privilege('anon', 'apply_mutation(jsonb, uuid, boolean)', 'execute'));
select pg_temp.assert('authenticated cannot run apply_mutation', not has_function_privilege('authenticated', 'apply_mutation(jsonb, uuid, boolean)', 'execute'));
select pg_temp.assert('service_role can run apply_mutation', has_function_privilege('service_role', 'apply_mutation(jsonb, uuid, boolean)', 'execute'));
select pg_temp.assert('anon cannot register clients', not has_function_privilege('anon', 'demo_register_client(uuid, text, text)', 'execute'));
select pg_temp.assert('anon cannot run internals', not has_function_privilege('anon', 'demo_seed_tables(text, uuid)', 'execute'));

do $$
begin
  set local role anon;
  begin
    perform count(*) from demo_tables;
    reset role;
    raise exception 'FAIL - anon can read demo_tables';
  exception when insufficient_privilege then
    reset role;
    raise notice 'ok - anon cannot read demo_tables';
  end;
end $$;

rollback;
\echo All apply_mutation rules passed
