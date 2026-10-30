import { toast } from "sonner";
import type { AppDb } from "./client";
import { beginWrite, cancelWrite } from "./latency";
import { SQL } from "./queries";
import { DEMO_ROOM_ID } from "@/shared/room";

// Local writes: they resolve in milliseconds and never touch the network.
// Trigger errors carry Spanish messages meant for the user.
// `measure` is off for writes that don't change what the floor renders.
async function run(db: AppDb, sql: string, params: unknown[], measure = true): Promise<boolean> {
  if (measure) beginWrite();
  try {
    await db.query(sql, params);
    return true;
  } catch (error) {
    cancelWrite();
    const message = error instanceof Error ? error.message.replace(/^error: /i, "") : "No se pudo guardar";
    toast.error(message);
    return false;
  }
}

export const moveTable = (db: AppDb, id: string, x: number, y: number) => run(db, SQL.moveTable, [id, x, y]);
export const claimSeat = (db: AppDb, tableId: string, seat: number) => run(db, SQL.claimSeat, [tableId, seat]);
export const releaseSeat = (db: AppDb, tableId: string, seat: number) => run(db, SQL.releaseSeat, [tableId, seat]);
export const addSeat = (db: AppDb, tableId: string) => run(db, SQL.addSeat, [tableId]);

export async function saveProfile(db: AppDb, clientId: string, name: string): Promise<void> {
  await db.query(SQL.setProfile, [clientId, name]);
}

export interface NewTable {
  id: string;
  label: string;
  shape: "circular" | "rectangular";
  x: number;
  y: number;
  seats: number;
  radius: number | null;
  width: number | null;
  height: number | null;
}

// Admin operations. The view triggers re-check the role, so these fail fast
// with a Spanish message even if the UI were bypassed.
export const createTable = (db: AppDb, t: NewTable) =>
  run(db, "INSERT INTO floor_tables (id, room_id, label, shape, pos_x, pos_y, seat_limit, shape_radius, shape_width, shape_height) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [
    t.id, DEMO_ROOM_ID, t.label, t.shape, t.x, t.y, t.seats, t.radius, t.width, t.height,
  ]);
export const deleteTable = (db: AppDb, id: string) => run(db, "DELETE FROM floor_tables WHERE id = $1", [id]);
export const renameTable = (db: AppDb, id: string, label: string) =>
  run(db, "UPDATE floor_tables SET label = $2 WHERE id = $1", [id, label]);
export const setSeatCount = (db: AppDb, id: string, seats: number) =>
  run(db, "UPDATE floor_tables SET seat_limit = $2 WHERE id = $1", [id, seats]);
export const resizeTable = (
  db: AppDb,
  id: string,
  size: { radius: number | null; width: number | null; height: number | null },
  x: number,
  y: number
) =>
  run(db, "UPDATE floor_tables SET shape_radius = $2, shape_width = $3, shape_height = $4, pos_x = $5, pos_y = $6 WHERE id = $1", [
    id, size.radius, size.width, size.height, x, y,
  ]);
export const moveTables = (db: AppDb, items: { id: string; pos_x: number; pos_y: number }[]) =>
  run(db, "SELECT local_move_tables($1::jsonb)", [JSON.stringify(items)]);
export const setLocked = (db: AppDb, locked: boolean) => run(db, "UPDATE floor_room SET is_locked = $1", [locked], false);
export const resetRoom = (db: AppDb) => run(db, "SELECT local_reset_room()", [], false);

// "Simular sin red": the pause switch lives in the DB so any tab can flip it.
export const setSyncPaused = (db: AppDb, paused: boolean) =>
  run(db, "INSERT INTO local_settings (key, value) VALUES ('sync_paused', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [
    String(paused),
  ], false);
