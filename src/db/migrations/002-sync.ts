// Milestone 3: the synced tables are now filled by Electric, not by a local seed.
export const migration002 = /* sql */ `
-- Rows written by the Milestone 1 local seed (and the never-sent outbox that
-- went with them) are discarded; the shapes repopulate everything.
DELETE FROM seat_claims_local;
DELETE FROM tables_local;
DELETE FROM rooms_local;
DELETE FROM outbox;
DELETE FROM seat_claims_synced;
DELETE FROM tables_synced;
DELETE FROM rooms_synced;

-- Per-shape sync state, written by the worker and read by the status pill and /debug.
CREATE TABLE sync_status (
  shape text PRIMARY KEY,
  up_to_date boolean NOT NULL DEFAULT false,
  reachable boolean NOT NULL DEFAULT true,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Settings may be flipped from any tab while only the leader runs sync, so
-- changes travel through the database.
CREATE FUNCTION local_settings_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('settings', NEW.key);
  RETURN NEW;
END $$;
CREATE TRIGGER local_settings_notify_trg AFTER INSERT OR UPDATE ON local_settings
  FOR EACH ROW EXECUTE FUNCTION local_settings_notify();
`;
