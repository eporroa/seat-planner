// Milestone 4: identity registration state and local permission guards.
// The guards mirror apply_mutation's permission rules so the UI fails fast
// (and offline); the server stays the final arbiter. Geometry (grid, bounds,
// overlap) is validated by the UI before it writes, and by the server.
export const migration003 = /* sql */ `
-- name = what the UI shows (server display name once registered);
-- base_name = the animal+color the user picked; registered_base = the base_name
-- the server has accepted. They differ until /api/session succeeds.
ALTER TABLE profile ADD COLUMN base_name text;
ALTER TABLE profile ADD COLUMN registered_base text;
UPDATE profile SET base_name = name;

CREATE OR REPLACE FUNCTION floor_tables_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m uuid := gen_random_uuid();
  is_admin boolean := COALESCE((SELECT p.is_admin FROM profile p LIMIT 1), false);
  is_locked boolean := COALESCE((SELECT r.is_locked FROM floor_room r LIMIT 1), false);
  highest_claimed integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT is_admin THEN RAISE EXCEPTION 'Solo el admin puede borrar mesas'; END IF;
    INSERT INTO tables_local (id, room_id, label, shape, pos_x, pos_y, seat_limit,
      shape_radius, shape_width, shape_height, mutation_id, is_deleted)
    VALUES (OLD.id, OLD.room_id, OLD.label, OLD.shape, OLD.pos_x, OLD.pos_y, OLD.seat_limit,
      OLD.shape_radius, OLD.shape_width, OLD.shape_height, m, true)
    ON CONFLICT (id) DO UPDATE SET mutation_id = m, is_deleted = true;
    INSERT INTO outbox (mutation_id, entity, op, payload)
    VALUES (m, 'table', 'delete', jsonb_build_object('id', OLD.id));
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND NOT is_admin THEN
    RAISE EXCEPTION 'Solo el admin puede crear mesas';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NOT is_admin AND (
      NEW.label IS DISTINCT FROM OLD.label OR NEW.shape IS DISTINCT FROM OLD.shape OR
      NEW.shape_radius IS DISTINCT FROM OLD.shape_radius OR
      NEW.shape_width IS DISTINCT FROM OLD.shape_width OR
      NEW.shape_height IS DISTINCT FROM OLD.shape_height
    ) THEN
      RAISE EXCEPTION 'Solo el admin puede cambiar la mesa';
    END IF;
    IF NEW.seat_limit < OLD.seat_limit THEN
      IF NOT is_admin THEN RAISE EXCEPTION 'No se pueden quitar sillas'; END IF;
      SELECT max(seat_index) INTO highest_claimed FROM floor_seat_claims WHERE table_id = OLD.id;
      IF highest_claimed > NEW.seat_limit THEN RAISE EXCEPTION 'Hay sillas ocupadas'; END IF;
    END IF;
    IF NOT is_admin AND is_locked AND (
      NEW.pos_x IS DISTINCT FROM OLD.pos_x OR NEW.pos_y IS DISTINCT FROM OLD.pos_y OR
      NEW.seat_limit IS DISTINCT FROM OLD.seat_limit
    ) THEN
      RAISE EXCEPTION 'El plano está bloqueado';
    END IF;
  END IF;

  INSERT INTO tables_local (id, room_id, label, shape, pos_x, pos_y, seat_limit,
    shape_radius, shape_width, shape_height, mutation_id, is_deleted)
  VALUES (NEW.id, NEW.room_id, NEW.label, NEW.shape, NEW.pos_x, NEW.pos_y, NEW.seat_limit,
    NEW.shape_radius, NEW.shape_width, NEW.shape_height, m, false)
  ON CONFLICT (id) DO UPDATE SET
    room_id = EXCLUDED.room_id, label = EXCLUDED.label, shape = EXCLUDED.shape,
    pos_x = EXCLUDED.pos_x, pos_y = EXCLUDED.pos_y, seat_limit = EXCLUDED.seat_limit,
    shape_radius = EXCLUDED.shape_radius, shape_width = EXCLUDED.shape_width,
    shape_height = EXCLUDED.shape_height, mutation_id = m, is_deleted = false;
  INSERT INTO outbox (mutation_id, entity, op, payload)
  VALUES (m, 'table', lower(TG_OP), to_jsonb(NEW) - 'is_pending');
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION floor_room_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m uuid := gen_random_uuid();
BEGIN
  IF NOT COALESCE((SELECT p.is_admin FROM profile p LIMIT 1), false) THEN
    RAISE EXCEPTION 'Solo el admin puede bloquear el plano';
  END IF;
  INSERT INTO rooms_local (id, is_locked, mutation_id) VALUES (NEW.id, NEW.is_locked, m)
  ON CONFLICT (id) DO UPDATE SET is_locked = EXCLUDED.is_locked, mutation_id = m;
  INSERT INTO outbox (mutation_id, entity, op, payload)
  VALUES (m, 'room', 'update', jsonb_build_object('id', NEW.id, 'is_locked', NEW.is_locked));
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION floor_seat_claims_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m uuid := gen_random_uuid();
  me record;
  mine record;
  existing_tag text;
  seats integer;
BEGIN
  SELECT client_id, name, is_admin, md5(client_id::text) AS tag INTO me FROM profile LIMIT 1;
  IF me.client_id IS NULL THEN
    RAISE EXCEPTION 'Primero elige tu nombre';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.owner_tag <> me.tag AND NOT me.is_admin THEN
      RAISE EXCEPTION 'Solo puedes liberar tu propia silla';
    END IF;
    INSERT INTO seat_claims_local (table_id, seat_index, room_id, owner_tag, client_name, mutation_id, is_deleted)
    VALUES (OLD.table_id, OLD.seat_index, OLD.room_id, OLD.owner_tag, OLD.client_name, m, true)
    ON CONFLICT (table_id, seat_index) DO UPDATE SET mutation_id = m, is_deleted = true;
    INSERT INTO outbox (mutation_id, entity, op, payload)
    VALUES (m, 'seat_claim', 'delete', jsonb_build_object('table_id', OLD.table_id, 'seat_index', OLD.seat_index));
    RETURN OLD;
  END IF;

  SELECT seat_limit INTO seats FROM floor_tables WHERE id = NEW.table_id;
  IF seats IS NULL OR NEW.seat_index < 1 OR NEW.seat_index > seats THEN
    RAISE EXCEPTION 'Esa silla no existe';
  END IF;

  SELECT owner_tag INTO existing_tag FROM floor_seat_claims
  WHERE table_id = NEW.table_id AND seat_index = NEW.seat_index;
  IF existing_tag IS NOT NULL THEN
    IF existing_tag = me.tag THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Esa silla ya está ocupada';
  END IF;

  -- One chair per person: claiming releases the previous claim under the same mutation.
  FOR mine IN SELECT * FROM floor_seat_claims WHERE owner_tag = me.tag LOOP
    INSERT INTO seat_claims_local (table_id, seat_index, room_id, owner_tag, client_name, mutation_id, is_deleted)
    VALUES (mine.table_id, mine.seat_index, mine.room_id, mine.owner_tag, mine.client_name, m, true)
    ON CONFLICT (table_id, seat_index) DO UPDATE SET mutation_id = m, is_deleted = true;
  END LOOP;

  INSERT INTO seat_claims_local (table_id, seat_index, room_id, owner_tag, client_name, claimed_at, mutation_id, is_deleted)
  VALUES (NEW.table_id, NEW.seat_index,
    (SELECT room_id FROM floor_tables WHERE id = NEW.table_id), me.tag, me.name, now(), m, false)
  ON CONFLICT (table_id, seat_index) DO UPDATE SET
    owner_tag = EXCLUDED.owner_tag, client_name = EXCLUDED.client_name,
    claimed_at = EXCLUDED.claimed_at, mutation_id = m, is_deleted = false;
  INSERT INTO outbox (mutation_id, entity, op, payload)
  VALUES (m, 'seat_claim', 'insert', jsonb_build_object('table_id', NEW.table_id, 'seat_index', NEW.seat_index));
  RETURN NEW;
END $$;
`;
