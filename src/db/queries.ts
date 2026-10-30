// All SQL the UI uses lives here.
export interface TableRow {
  id: string;
  room_id: string;
  label: string;
  shape: "circular" | "rectangular";
  pos_x: number;
  pos_y: number;
  seat_limit: number;
  shape_radius: number | null;
  shape_width: number | null;
  shape_height: number | null;
  is_pending: boolean;
}

export interface ClaimRow {
  table_id: string;
  seat_index: number;
  owner_tag: string;
  client_name: string;
  is_pending: boolean;
}

export interface ProfileRow {
  client_id: string;
  name: string;
  base_name: string | null;
  is_admin: boolean;
  tag: string;
}

export const Q = {
  tables: "SELECT * FROM floor_tables ORDER BY label, id",
  claims: "SELECT table_id, seat_index, owner_tag, client_name, is_pending FROM floor_seat_claims",
  profile: "SELECT client_id, name, base_name, is_admin, md5(client_id::text) AS tag FROM profile LIMIT 1",
  backend: "SELECT value FROM local_meta WHERE key = 'backend'",
  seated: "SELECT count(*)::int AS n FROM floor_seat_claims",
  syncStatus: "SELECT shape, up_to_date, reachable, error FROM sync_status ORDER BY shape",
  syncPaused: "SELECT value FROM local_settings WHERE key = 'sync_paused'",
  pendingCount: "SELECT count(*)::int AS n FROM outbox WHERE status <> 'rejected'",
} as const;

export const SQL = {
  // name is a placeholder until the server assigns the display name.
  setProfile: `INSERT INTO profile (client_id, name, base_name) VALUES ($1, $2, $2)
    ON CONFLICT (client_id) DO UPDATE SET name = EXCLUDED.name, base_name = EXCLUDED.base_name`,
  // After the server accepted the session (and possibly the admin passcode).
  setProfileRegistered: `INSERT INTO profile (client_id, name, base_name, registered_base, is_admin)
    VALUES ($1, $2, $3, $3, $4)
    ON CONFLICT (client_id) DO UPDATE SET name = EXCLUDED.name, base_name = EXCLUDED.base_name,
      registered_base = EXCLUDED.registered_base, is_admin = EXCLUDED.is_admin`,
  setAdmin: "UPDATE profile SET is_admin = $1",
  moveTable: "UPDATE floor_tables SET pos_x = $2, pos_y = $3 WHERE id = $1",
  claimSeat: "INSERT INTO floor_seat_claims (table_id, seat_index) VALUES ($1, $2)",
  releaseSeat: "DELETE FROM floor_seat_claims WHERE table_id = $1 AND seat_index = $2",
  addSeat: "UPDATE floor_tables SET seat_limit = seat_limit + 1 WHERE id = $1 AND seat_limit < 12",
} as const;

export interface SyncStatusRow {
  shape: string;
  up_to_date: boolean;
  reachable: boolean;
  error: string | null;
}

export type SyncState = "live" | "syncing" | "offline" | "paused";

export function summarizeSync(rows: SyncStatusRow[] | undefined, paused: boolean): SyncState {
  if (paused) return "paused";
  // The socket is only the doorbell: polling keeps us current without it.
  const feed = rows?.filter((r) => r.shape === "changes");
  if (!feed || feed.length === 0) return "syncing";
  if (feed.some((r) => !r.reachable || r.error)) return "offline";
  return feed.every((r) => r.up_to_date) ? "live" : "syncing";
}
