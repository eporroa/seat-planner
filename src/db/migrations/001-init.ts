// Local schema (PGlite). Synced tables are written ONLY by the Electric sync;
// the UI reads/writes the floor_* views. Writes land in *_local overlays plus
// the outbox; the Electric echo (matching last_mutation_id) clears them.
export const migration001 = /* sql */ `
CREATE TABLE rooms_synced (
  id text PRIMARY KEY,
  is_locked boolean NOT NULL DEFAULT false,
  updated_at timestamptz,
  last_mutation_id uuid
);
CREATE TABLE tables_synced (
  id uuid PRIMARY KEY,
  room_id text NOT NULL,
  label text NOT NULL DEFAULT '',
  shape text NOT NULL,
  pos_x integer NOT NULL,
  pos_y integer NOT NULL,
  seat_limit integer NOT NULL,
  shape_radius integer,
  shape_width integer,
  shape_height integer,
  updated_at timestamptz,
  last_mutation_id uuid
);
-- owner_tag = md5(client_id): the shape never exposes the real client_id.
CREATE TABLE seat_claims_synced (
  table_id uuid NOT NULL,
  seat_index integer NOT NULL,
  room_id text NOT NULL,
  owner_tag text NOT NULL,
  client_name text NOT NULL,
  claimed_at timestamptz,
  last_mutation_id uuid,
  PRIMARY KEY (table_id, seat_index)
);

CREATE TABLE rooms_local (
  id text PRIMARY KEY,
  is_locked boolean NOT NULL DEFAULT false,
  updated_at timestamptz,
  mutation_id uuid NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false
);
CREATE TABLE tables_local (
  id uuid PRIMARY KEY,
  room_id text NOT NULL,
  label text NOT NULL DEFAULT '',
  shape text NOT NULL,
  pos_x integer NOT NULL,
  pos_y integer NOT NULL,
  seat_limit integer NOT NULL,
  shape_radius integer,
  shape_width integer,
  shape_height integer,
  mutation_id uuid NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false
);
CREATE TABLE seat_claims_local (
  table_id uuid NOT NULL,
  seat_index integer NOT NULL,
  room_id text NOT NULL,
  owner_tag text NOT NULL,
  client_name text NOT NULL,
  claimed_at timestamptz,
  mutation_id uuid NOT NULL,
  is_deleted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (table_id, seat_index)
);

CREATE TABLE outbox (
  mutation_id uuid PRIMARY KEY,
  entity text NOT NULL,
  op text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'inflight', 'rejected')),
  reason text,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX outbox_created_at_idx ON outbox (created_at);

CREATE TABLE profile (
  client_id uuid PRIMARY KEY,
  name text NOT NULL,
  is_admin boolean NOT NULL DEFAULT false
);
CREATE TABLE metrics (key text PRIMARY KEY, value numeric NOT NULL);
CREATE TABLE local_meta (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE local_settings (key text PRIMARY KEY, value text NOT NULL);
INSERT INTO local_settings VALUES ('sync_paused', 'false');

-- Views the UI reads. The local overlay wins over the synced row.
CREATE VIEW floor_room AS
SELECT
  COALESCE(l.id, s.id) AS id,
  CASE WHEN l.id IS NOT NULL THEN l.is_locked ELSE s.is_locked END AS is_locked,
  (l.id IS NOT NULL) AS is_pending
FROM rooms_synced s FULL OUTER JOIN rooms_local l ON l.id = s.id
WHERE NOT COALESCE(l.is_deleted, false);

CREATE VIEW floor_tables AS
SELECT
  COALESCE(l.id, s.id) AS id,
  CASE WHEN l.id IS NOT NULL THEN l.room_id ELSE s.room_id END AS room_id,
  CASE WHEN l.id IS NOT NULL THEN l.label ELSE s.label END AS label,
  CASE WHEN l.id IS NOT NULL THEN l.shape ELSE s.shape END AS shape,
  CASE WHEN l.id IS NOT NULL THEN l.pos_x ELSE s.pos_x END AS pos_x,
  CASE WHEN l.id IS NOT NULL THEN l.pos_y ELSE s.pos_y END AS pos_y,
  CASE WHEN l.id IS NOT NULL THEN l.seat_limit ELSE s.seat_limit END AS seat_limit,
  CASE WHEN l.id IS NOT NULL THEN l.shape_radius ELSE s.shape_radius END AS shape_radius,
  CASE WHEN l.id IS NOT NULL THEN l.shape_width ELSE s.shape_width END AS shape_width,
  CASE WHEN l.id IS NOT NULL THEN l.shape_height ELSE s.shape_height END AS shape_height,
  (l.id IS NOT NULL) AS is_pending
FROM tables_synced s FULL OUTER JOIN tables_local l ON l.id = s.id
WHERE NOT COALESCE(l.is_deleted, false);

-- Claims of a locally deleted table disappear with it (cascade, offline too).
CREATE VIEW floor_seat_claims AS
SELECT
  COALESCE(l.table_id, s.table_id) AS table_id,
  COALESCE(l.seat_index, s.seat_index) AS seat_index,
  CASE WHEN l.table_id IS NOT NULL THEN l.room_id ELSE s.room_id END AS room_id,
  CASE WHEN l.table_id IS NOT NULL THEN l.owner_tag ELSE s.owner_tag END AS owner_tag,
  CASE WHEN l.table_id IS NOT NULL THEN l.client_name ELSE s.client_name END AS client_name,
  (l.table_id IS NOT NULL) AS is_pending
FROM seat_claims_synced s
FULL OUTER JOIN seat_claims_local l ON l.table_id = s.table_id AND l.seat_index = s.seat_index
WHERE NOT COALESCE(l.is_deleted, false)
  AND EXISTS (SELECT 1 FROM floor_tables t WHERE t.id = COALESCE(l.table_id, s.table_id));

-- Outbox insert wakes the flusher.
CREATE FUNCTION outbox_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('outbox', NEW.mutation_id::text);
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_notify_trg AFTER INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION outbox_notify();

-- INSTEAD OF triggers: overlay + outbox in the same transaction.
CREATE FUNCTION floor_tables_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m uuid := gen_random_uuid();
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO tables_local (id, room_id, label, shape, pos_x, pos_y, seat_limit,
      shape_radius, shape_width, shape_height, mutation_id, is_deleted)
    VALUES (OLD.id, OLD.room_id, OLD.label, OLD.shape, OLD.pos_x, OLD.pos_y, OLD.seat_limit,
      OLD.shape_radius, OLD.shape_width, OLD.shape_height, m, true)
    ON CONFLICT (id) DO UPDATE SET mutation_id = m, is_deleted = true;
    INSERT INTO outbox (mutation_id, entity, op, payload)
    VALUES (m, 'table', 'delete', jsonb_build_object('id', OLD.id));
    RETURN OLD;
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
CREATE TRIGGER floor_tables_write_trg INSTEAD OF INSERT OR UPDATE OR DELETE ON floor_tables
  FOR EACH ROW EXECUTE FUNCTION floor_tables_write();

CREATE FUNCTION floor_room_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m uuid := gen_random_uuid();
BEGIN
  INSERT INTO rooms_local (id, is_locked, mutation_id) VALUES (NEW.id, NEW.is_locked, m)
  ON CONFLICT (id) DO UPDATE SET is_locked = EXCLUDED.is_locked, mutation_id = m;
  INSERT INTO outbox (mutation_id, entity, op, payload)
  VALUES (m, 'room', 'update', jsonb_build_object('id', NEW.id, 'is_locked', NEW.is_locked));
  RETURN NEW;
END $$;
CREATE TRIGGER floor_room_write_trg INSTEAD OF UPDATE ON floor_room
  FOR EACH ROW EXECUTE FUNCTION floor_room_write();

-- One chair per person: claiming releases the previous claim (tombstoned
-- under the same mutation; the server does the same atomically).
CREATE FUNCTION floor_seat_claims_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m uuid := gen_random_uuid();
  me record;
  mine record;
  existing_tag text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO seat_claims_local (table_id, seat_index, room_id, owner_tag, client_name, mutation_id, is_deleted)
    VALUES (OLD.table_id, OLD.seat_index, OLD.room_id, OLD.owner_tag, OLD.client_name, m, true)
    ON CONFLICT (table_id, seat_index) DO UPDATE SET mutation_id = m, is_deleted = true;
    INSERT INTO outbox (mutation_id, entity, op, payload)
    VALUES (m, 'seat_claim', 'delete', jsonb_build_object('table_id', OLD.table_id, 'seat_index', OLD.seat_index));
    RETURN OLD;
  END IF;

  SELECT client_id, name, md5(client_id::text) AS tag INTO me FROM profile LIMIT 1;
  IF me.client_id IS NULL THEN
    RAISE EXCEPTION 'Primero elige tu nombre';
  END IF;

  SELECT owner_tag INTO existing_tag FROM floor_seat_claims
  WHERE table_id = NEW.table_id AND seat_index = NEW.seat_index;
  IF existing_tag IS NOT NULL THEN
    IF existing_tag = me.tag THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Esa silla ya está ocupada';
  END IF;

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
CREATE TRIGGER floor_seat_claims_write_trg INSTEAD OF INSERT OR DELETE ON floor_seat_claims
  FOR EACH ROW EXECUTE FUNCTION floor_seat_claims_write();

-- Echo cleanup. UUIDs are not ordered, so only an EXACT mutation_id match
-- clears an overlay row: a newer local change keeps its overlay.
CREATE FUNCTION tables_synced_echo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM outbox WHERE mutation_id IN
      (SELECT mutation_id FROM tables_local WHERE id = OLD.id AND is_deleted);
    DELETE FROM tables_local WHERE id = OLD.id AND is_deleted;
    RETURN OLD;
  END IF;
  DELETE FROM tables_local WHERE id = NEW.id AND mutation_id = NEW.last_mutation_id;
  DELETE FROM outbox WHERE mutation_id = NEW.last_mutation_id;
  RETURN NEW;
END $$;
CREATE TRIGGER tables_synced_echo_trg AFTER INSERT OR UPDATE OR DELETE ON tables_synced
  FOR EACH ROW EXECUTE FUNCTION tables_synced_echo();

CREATE FUNCTION seat_claims_synced_echo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM outbox WHERE mutation_id IN
      (SELECT mutation_id FROM seat_claims_local
       WHERE table_id = OLD.table_id AND seat_index = OLD.seat_index AND is_deleted);
    DELETE FROM seat_claims_local
    WHERE table_id = OLD.table_id AND seat_index = OLD.seat_index AND is_deleted;
    RETURN OLD;
  END IF;
  DELETE FROM seat_claims_local
  WHERE table_id = NEW.table_id AND seat_index = NEW.seat_index AND mutation_id = NEW.last_mutation_id;
  DELETE FROM outbox WHERE mutation_id = NEW.last_mutation_id;
  RETURN NEW;
END $$;
CREATE TRIGGER seat_claims_synced_echo_trg AFTER INSERT OR UPDATE OR DELETE ON seat_claims_synced
  FOR EACH ROW EXECUTE FUNCTION seat_claims_synced_echo();

CREATE FUNCTION rooms_synced_echo() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM rooms_local WHERE id = NEW.id AND mutation_id = NEW.last_mutation_id;
  DELETE FROM outbox WHERE mutation_id = NEW.last_mutation_id;
  RETURN NEW;
END $$;
CREATE TRIGGER rooms_synced_echo_trg AFTER INSERT OR UPDATE ON rooms_synced
  FOR EACH ROW EXECUTE FUNCTION rooms_synced_echo();
`;
