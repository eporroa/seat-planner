import { describe, expect, it } from "vitest";
import { findNearestFreeSpot, footprint, isInsideRoom, isValidPlacement, overlaps } from "./grid-rules";
import { alignTables, tidyTables } from "./layout-ops";
import type { TableItem } from "./types";
import { circleChairPoint, rectChairPoint, snapToGrid } from "./utils";

const circle = (x: number, y: number, radius = 60) => ({ type: "circular" as const, x, y, radius });
const rect = (x: number, y: number, width = 200, height = 80) => ({ type: "rectangular" as const, x, y, width, height });

describe("grid rules", () => {
  it("expands the footprint by the chair ring", () => {
    expect(footprint(circle(100, 100, 60))).toEqual({ x: 76, y: 76, width: 168, height: 168 });
  });

  it("keeps the whole chair ring inside the room", () => {
    expect(isInsideRoom(circle(20, 20))).toBe(false);
    expect(isInsideRoom(circle(40, 40))).toBe(true);
    expect(isInsideRoom(rect(1400, 100))).toBe(false);
  });

  it("requires one grid cell of clearance between footprints", () => {
    const a = circle(100, 100); // footprint right edge = 244
    // b footprint left edge must be >= 244 + 20 = 264 → b.x >= 288
    expect(overlaps(a, circle(268, 100))).toBe(true);
    expect(overlaps(a, circle(288, 100))).toBe(false);
  });

  it("finds the nearest free spot, or null when boxed in", () => {
    const blocker = circle(300, 300);
    const spot = findNearestFreeSpot(circle(300, 300), 300, 300, [blocker]);
    expect(spot).not.toBeNull();
    expect(isValidPlacement({ ...circle(0, 0), ...spot! }, [blocker])).toBe(true);
    expect(spot!.x % 20).toBe(0);
    expect(spot!.y % 20).toBe(0);

    const wall = Array.from({ length: 40 }, (_, i) => rect(40 + (i % 8) * 40, 40 + Math.floor(i / 8) * 40, 320, 320));
    expect(findNearestFreeSpot(circle(200, 200), 200, 200, wall)).toBeNull();
    // A wider search finds room elsewhere when the neighborhood is packed.
    const far = findNearestFreeSpot(circle(200, 200), 200, 200, wall, 80);
    expect(far).not.toBeNull();
    expect(isValidPlacement({ ...circle(0, 0), ...far! }, wall)).toBe(true);
  });
});

describe("chair geometry", () => {
  it("starts at 12 o'clock and goes clockwise", () => {
    const first = circleChairPoint(0, 8, 60);
    expect(first.x).toBeCloseTo(0);
    expect(first.y).toBeCloseTo(-74);
    const second = circleChairPoint(2, 8, 60); // quarter turn → 3 o'clock
    expect(second.x).toBeCloseTo(74);
    expect(second.y).toBeCloseTo(0);
  });

  it("starts rectangles at top-center", () => {
    const p = rectChairPoint(0, 10, 200, 80);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(-14);
  });

  it("snaps to the 20px grid", () => {
    expect(snapToGrid(29)).toBe(20);
    expect(snapToGrid(31)).toBe(40);
  });
});

describe("layout ops", () => {
  const base = (id: string, x: number, y: number): TableItem => ({
    id, name: id, type: "rectangular", seats: 4, x, y, width: 100, height: 60, isPending: false, chairs: [],
  });

  it("aligns by id", () => {
    const out = alignTables([base("a", 100, 100), base("b", 300, 200)], ["a", "b"], "left");
    expect(out.map((t) => t.x)).toEqual([100, 100]);
  });

  it("tidies with a two-cell gap on the grid", () => {
    const out = tidyTables([base("a", 0, 0), base("b", 130, 0), base("c", 400, 0)], ["a", "b", "c"], "horizontal");
    expect(out.map((t) => t.x)).toEqual([0, 140, 280]);
  });
});

import { SEED_TABLES } from "@/shared/seed";
import { isValidSize } from "./grid-rules";

describe("seed layout", () => {
  const items = SEED_TABLES.map((t) => ({
    type: t.shape,
    x: t.pos_x,
    y: t.pos_y,
    radius: t.shape_radius ?? undefined,
    width: t.shape_width ?? undefined,
    height: t.shape_height ?? undefined,
  }));

  it("has 12 valid, grid-aligned, non-overlapping tables", () => {
    expect(items).toHaveLength(12);
    items.forEach((t, i) => {
      expect(t.x % 20).toBe(0);
      expect(t.y % 20).toBe(0);
      expect(isValidSize(t)).toBe(true);
      expect(isValidPlacement(t, items.filter((_, j) => j !== i))).toBe(true);
    });
  });
});
