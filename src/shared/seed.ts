import { DEMO_ROOM_ID } from "./room";

export interface SeedTable {
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
}

// 12 tables in a tidy 4 x 3 grid, circular and rectangular alternating like a
// checkerboard. Fixed ids so the server-side reset recreates the same rows.
const COLUMN_CENTERS = [200, 600, 1000, 1400];
const ROW_CENTERS = [180, 500, 820];

export const SEED_TABLES: SeedTable[] = ROW_CENTERS.flatMap((cy, row) =>
  COLUMN_CENTERS.map((cx, col): SeedTable => {
    const n = row * COLUMN_CENTERS.length + col + 1;
    const circular = (row + col) % 2 === 0;
    return {
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      room_id: DEMO_ROOM_ID,
      label: `Mesa ${n}`,
      shape: circular ? "circular" : "rectangular",
      pos_x: circular ? cx - 60 : cx - 100,
      pos_y: circular ? cy - 60 : cy - 40,
      seat_limit: circular ? 8 : 10,
      shape_radius: circular ? 60 : null,
      shape_width: circular ? null : 200,
      shape_height: circular ? null : 80,
    };
  })
);
