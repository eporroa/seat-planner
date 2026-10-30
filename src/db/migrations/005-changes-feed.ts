// Milestone 6 (read path without Electric): the synced tables are filled by
// /api/changes, which resumes from a version number kept in local_meta.
export const migration005 = /* sql */ `
-- Rows and resume state from the Electric era are discarded; the first pull
-- (since = 0) brings everything back.
DELETE FROM seat_claims_synced;
DELETE FROM tables_synced;
DELETE FROM rooms_synced;
DELETE FROM local_meta WHERE key IN ('rev', 'epoch');
DELETE FROM sync_status;
DROP SCHEMA IF EXISTS electric CASCADE;
`;
