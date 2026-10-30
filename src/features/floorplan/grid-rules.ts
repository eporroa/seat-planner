import {
  RADIUS_MAX,
  RADIUS_MIN,
  RECT_SIZE_MAX,
  RECT_SIZE_MIN,
  ROOM_HEIGHT,
  ROOM_WIDTH,
} from "@/shared/room";
import type { BoundsRect, TableItem } from "./types";
import { CHAIR_GAP, CHAIR_RADIUS, GRID_SIZE, rectsIntersect, snapToGrid, tableBounds } from "./utils";

type Placeable = Pick<TableItem, "type" | "x" | "y" | "radius" | "width" | "height">;

// Space the chair ring takes outside the table body.
export const CHAIR_RING = CHAIR_GAP + CHAIR_RADIUS;
const SPIRAL_MAX_CELLS = 10;

// Table bounds grown by the chair ring on every side.
export function footprint(table: Placeable): BoundsRect {
  const b = tableBounds(table);
  return {
    x: b.x - CHAIR_RING,
    y: b.y - CHAIR_RING,
    width: b.width + CHAIR_RING * 2,
    height: b.height + CHAIR_RING * 2,
  };
}

export function isInsideRoom(table: Placeable): boolean {
  const f = footprint(table);
  return f.x >= 0 && f.y >= 0 && f.x + f.width <= ROOM_WIDTH && f.y + f.height <= ROOM_HEIGHT;
}

// Two tables collide when their footprints are closer than one grid cell.
export function overlaps(a: Placeable, b: Placeable): boolean {
  const fa = footprint(a);
  const fb = footprint(b);
  return rectsIntersect(
    { x: fa.x - GRID_SIZE, y: fa.y - GRID_SIZE, width: fa.width + GRID_SIZE * 2, height: fa.height + GRID_SIZE * 2 },
    fb
  );
}

export function overlapsAny(candidate: Placeable, others: readonly Placeable[]): boolean {
  return others.some((o) => overlaps(candidate, o));
}

export function isValidPlacement(candidate: Placeable, others: readonly Placeable[]): boolean {
  return isInsideRoom(candidate) && !overlapsAny(candidate, others);
}

export function isValidSize(table: Placeable): boolean {
  if (table.type === "circular") {
    const r = table.radius ?? 0;
    return r >= RADIUS_MIN && r <= RADIUS_MAX && r % GRID_SIZE === 0;
  }
  const w = table.width ?? 0;
  const h = table.height ?? 0;
  return (
    w >= RECT_SIZE_MIN && w <= RECT_SIZE_MAX && w % GRID_SIZE === 0 &&
    h >= RECT_SIZE_MIN && h <= RECT_SIZE_MAX && h % GRID_SIZE === 0
  );
}

// Nearest free grid position to (x, y), searching rings of growing radius up
// to maxCells cells away (default SPIRAL_MAX_CELLS; a drop shouldn't jump far,
// but a newly created table may go anywhere in the room). Returns null when nothing is free.
export function findNearestFreeSpot(
  table: Placeable,
  x: number,
  y: number,
  others: readonly Placeable[],
  maxCells = SPIRAL_MAX_CELLS
): { x: number; y: number } | null {
  const cx = snapToGrid(x);
  const cy = snapToGrid(y);
  for (let ring = 0; ring <= maxCells; ring++) {
    let best: { x: number; y: number; dist: number } | null = null;
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const px = cx + dx * GRID_SIZE;
        const py = cy + dy * GRID_SIZE;
        if (!isValidPlacement({ ...table, x: px, y: py }, others)) continue;
        const dist = Math.hypot(px - x, py - y);
        if (!best || dist < best.dist) best = { x: px, y: py, dist };
      }
    }
    if (best) return { x: best.x, y: best.y };
  }
  return null;
}

// Widest possible search: every grid cell of the room.
export const WHOLE_ROOM_CELLS = Math.ceil(Math.max(ROOM_WIDTH, ROOM_HEIGHT) / GRID_SIZE);
