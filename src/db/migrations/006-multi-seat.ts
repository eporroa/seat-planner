import { MAX_SEATS_PER_ATTENDEE } from "@/shared/room";

// A person may hold several chairs: up to MAX_SEATS_PER_ATTENDEE for attendees
// (claiming past that releases the oldest, under the same mutation), no limit
// for admins. Mirrors apply_mutation so the UI behaves the same offline.
export const migration006 = /* sql */ `
-- claimed_at is needed to find the oldest chair; appended so the view can be replaced in place.
CREATE OR REPLACE VIEW floor_seat_claims AS
SELECT
  COALESCE(l.table_id, s.table_id) AS table_id,
  COALESCE(l.seat_index, s.seat_index) AS seat_index,
  CASE WHEN l.table_id IS NOT NULL THEN l.room_id ELSE s.room_id END AS room_id,
  CASE WHEN l.table_id IS NOT NULL THEN l.owner_tag ELSE s.owner_tag END AS owner_tag,
  CASE WHEN l.table_id IS NOT NULL THEN l.client_name ELSE s.client_name END AS client_name,
  (l.table_id IS NOT NULL) AS is_pending,
  CASE WHEN l.table_id IS NOT NULL THEN l.claimed_at ELSE s.claimed_at END AS claimed_at
FROM seat_claims_synced s
FULL OUTER JOIN seat_claims_local l ON l.table_id = s.table_id AND l.seat_index = s.seat_index
WHERE NOT COALESCE(l.is_deleted, false)
  AND EXISTS (SELECT 1 FROM floor_tables t WHERE t.id = COALESCE(l.table_id, s.table_id));

CREATE OR REPLACE FUNCTION floor_seat_claims_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  m uuid := gen_random_uuid();
  me record;
  oldest record;
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

  -- Holding ${MAX_SEATS_PER_ATTENDEE} already: the oldest ones go, under the same mutation as the new claim.
  IF NOT me.is_admin THEN
    FOR oldest IN
      SELECT table_id, seat_index, room_id, owner_tag, client_name FROM floor_seat_claims
      WHERE owner_tag = me.tag
      ORDER BY claimed_at DESC NULLS LAST, table_id, seat_index
      OFFSET ${MAX_SEATS_PER_ATTENDEE - 1}
    LOOP
      INSERT INTO seat_claims_local (table_id, seat_index, room_id, owner_tag, client_name, mutation_id, is_deleted)
      VALUES (oldest.table_id, oldest.seat_index, oldest.room_id, oldest.owner_tag, oldest.client_name, m, true)
      ON CONFLICT (table_id, seat_index) DO UPDATE SET mutation_id = m, is_deleted = true;
    END LOOP;
  END IF;

  INSERT INTO seat_claims_local (table_id, seat_index, room_id, owner_tag, client_name, claimed_at, mutation_id, is_deleted)
  VALUES (NEW.table_id, NEW.seat_index,
    (SELECT room_id FROM floor_tables WHERE id = NEW.table_id), me.tag, me.name, clock_timestamp(), m, false)
  ON CONFLICT (table_id, seat_index) DO UPDATE SET
    owner_tag = EXCLUDED.owner_tag, client_name = EXCLUDED.client_name,
    claimed_at = EXCLUDED.claimed_at, mutation_id = m, is_deleted = false;
  INSERT INTO outbox (mutation_id, entity, op, payload)
  VALUES (m, 'seat_claim', 'insert', jsonb_build_object('table_id', NEW.table_id, 'seat_index', NEW.seat_index));
  RETURN NEW;
END $$;
`;
