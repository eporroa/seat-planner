import type { BoundsRect, ChairItem, TableItem } from "./types";

export type { BoundsRect };

export const GRID_SIZE = 20;
export const CHAIR_RADIUS = 10;
export const CHAIR_GAP = 14;
export const MIN_RADIUS = 20;
export const MIN_RECT_SIZE = 40;

export function displayNameOf(table: TableItem, index: number): string {
  return table.name.trim() ? table.name : String(index + 1);
}

export function occupiedCountOf(table: TableItem): number {
  return table.chairs.filter((c) => c.claimedByName !== null).length;
}

export function snapToGrid(value: number): number {
  return Math.round(value / GRID_SIZE) * GRID_SIZE;
}

export interface SeatClaim {
  claimedByName: string;
  isMine: boolean;
  isPending: boolean;
}

// Chairs are derived from the seat count (only claims are stored), so this
// builds exactly `seats` chairs and attaches whatever claim exists for each index.
export function syncChairs(
  tableId: string,
  seats: number,
  claimsBySeat: ReadonlyMap<number, SeatClaim> | undefined
): ChairItem[] {
  const count = Math.max(0, Math.floor(seats) || 0);
  return Array.from({ length: count }, (_, i) => {
    const seatIndex = i + 1;
    const claim = claimsBySeat?.get(seatIndex);
    return {
      id: `${tableId}:${seatIndex}`,
      seatIndex,
      claimedByName: claim?.claimedByName ?? null,
      isMine: claim?.isMine ?? false,
      isPending: claim?.isPending ?? false,
    };
  });
}

// x/y is ALWAYS the top-left of the real bounding box, even for circular
// tables (where x/y is NOT the circle's center). Same convention everywhere,
// which avoids per-shape special cases in alignment and resizing.
export function tableBounds(table: Pick<TableItem, "type" | "x" | "y" | "radius" | "width" | "height">): BoundsRect {
  if (table.type === "circular") {
    const r = table.radius ?? MIN_RADIUS;
    return { x: table.x, y: table.y, width: r * 2, height: r * 2 };
  }
  return {
    x: table.x,
    y: table.y,
    width: table.width ?? MIN_RECT_SIZE,
    height: table.height ?? MIN_RECT_SIZE,
  };
}

export function rectsIntersect(a: BoundsRect, b: BoundsRect): boolean {
  return (
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  );
}

// Seats are evenly spaced. Angle 0 = top (12 o'clock), clockwise. Returns
// coordinates RELATIVE to the table's center; the caller adds the real center.
export function circleChairPoint(
  index: number,
  count: number,
  radius: number
): { x: number; y: number } {
  const angle = (360 / count) * index;
  const theta = ((angle - 90) * Math.PI) / 180;
  const distance = radius + CHAIR_GAP;
  return { x: Math.cos(theta) * distance, y: Math.sin(theta) * distance };
}

interface RectSegment {
  start: { x: number; y: number };
  dir: { x: number; y: number };
  len: number;
  normal: { x: number; y: number };
}

// 5 segments (not 4): the top edge is split in two halves so the distribution
// starts at top-CENTER (not a corner) and goes clockwise: right half of the
// top, right side, bottom, left side, left half of the top.
function buildRectSegments(width: number, height: number): RectSegment[] {
  const halfW = width / 2;
  return [
    { start: { x: halfW, y: 0 }, dir: { x: 1, y: 0 }, len: halfW, normal: { x: 0, y: -1 } },
    { start: { x: width, y: 0 }, dir: { x: 0, y: 1 }, len: height, normal: { x: 1, y: 0 } },
    { start: { x: width, y: height }, dir: { x: -1, y: 0 }, len: width, normal: { x: 0, y: 1 } },
    { start: { x: 0, y: height }, dir: { x: 0, y: -1 }, len: height, normal: { x: -1, y: 0 } },
    { start: { x: 0, y: 0 }, dir: { x: 1, y: 0 }, len: halfW, normal: { x: 0, y: -1 } },
  ];
}

// index/count: evenly spaced position along the perimeter, starting at
// top-center, clockwise. Returns coordinates RELATIVE to the rectangle's
// top-left corner (0,0 to width,height), same convention as table.x/y.
export function rectChairPoint(
  index: number,
  count: number,
  width: number,
  height: number
): { x: number; y: number } {
  const perimeter = 2 * (width + height);
  const segments = buildRectSegments(width, height);
  let remaining = (perimeter / count) * index;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue; // noUncheckedIndexedAccess — the index is always valid here
    if (remaining <= seg.len || i === segments.length - 1) {
      const edge = {
        x: seg.start.x + seg.dir.x * remaining,
        y: seg.start.y + seg.dir.y * remaining,
      };
      return {
        x: edge.x + seg.normal.x * CHAIR_GAP,
        y: edge.y + seg.normal.y * CHAIR_GAP,
      };
    }
    remaining -= seg.len;
  }
  return { x: width / 2, y: -CHAIR_GAP };
}

// Chair center relative to the table's top-left corner, for either shape.
export function chairPoint(
  table: Pick<TableItem, "type" | "x" | "y" | "radius" | "width" | "height">,
  seatIndex: number,
  count: number
): { x: number; y: number } {
  const bounds = tableBounds(table);
  if (table.type === "circular") {
    const rel = circleChairPoint(seatIndex - 1, count, bounds.width / 2);
    return { x: bounds.width / 2 + rel.x, y: bounds.height / 2 + rel.y };
  }
  return rectChairPoint(seatIndex - 1, count, bounds.width, bounds.height);
}
