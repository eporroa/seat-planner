import type {
  AlignKind,
  AxisKind,
  BoundsWithId,
  SizeKind,
  TableItem,
} from "./types";
import { GRID_SIZE, MIN_RADIUS, MIN_RECT_SIZE, snapToGrid, tableBounds } from "./utils";

const TIDY_GAP = GRID_SIZE * 2;

function selectedBounds(tables: TableItem[], selectedIds: string[]): BoundsWithId[] {
  return selectedIds
    .map((id) => {
      const table = tables.find((t) => t.id === id);
      return table ? { id, ...tableBounds(table) } : null;
    })
    .filter((x): x is BoundsWithId => x !== null);
}

function applyMoves(
  tables: TableItem[],
  moves: { id: string; dx: number; dy: number }[]
): TableItem[] {
  const byId = new Map(moves.filter((m) => m.dx !== 0 || m.dy !== 0).map((m) => [m.id, m]));
  if (byId.size === 0) return tables;
  return tables.map((t) => {
    const move = byId.get(t.id);
    return move ? { ...t, x: t.x + move.dx, y: t.y + move.dy } : t;
  });
}

export function nudgeTables(
  tables: TableItem[],
  selectedIds: string[],
  dx: number,
  dy: number
): TableItem[] {
  if (dx === 0 && dy === 0) return tables;
  return tables.map((t) =>
    selectedIds.includes(t.id) ? { ...t, x: t.x + dx, y: t.y + dy } : t
  );
}

export function alignTables(
  tables: TableItem[],
  selectedIds: string[],
  kind: AlignKind
): TableItem[] {
  const selected = selectedBounds(tables, selectedIds);
  if (selected.length < 2) return tables;

  const minX = Math.min(...selected.map((b) => b.x));
  const maxRight = Math.max(...selected.map((b) => b.x + b.width));
  const minY = Math.min(...selected.map((b) => b.y));
  const maxBottom = Math.max(...selected.map((b) => b.y + b.height));
  const centerX = (minX + maxRight) / 2;
  const centerY = (minY + maxBottom) / 2;

  return applyMoves(
    tables,
    selected.map((b) => {
      switch (kind) {
        case "left":
          return { id: b.id, dx: minX - b.x, dy: 0 };
        case "right":
          return { id: b.id, dx: maxRight - b.width - b.x, dy: 0 };
        case "hcenter":
          return { id: b.id, dx: centerX - b.width / 2 - b.x, dy: 0 };
        case "top":
          return { id: b.id, dx: 0, dy: minY - b.y };
        case "bottom":
          return { id: b.id, dx: 0, dy: maxBottom - b.height - b.y };
        case "vcenter":
          return { id: b.id, dx: 0, dy: centerY - b.height / 2 - b.y };
      }
    })
  );
}

export function normalizeTables(
  tables: TableItem[],
  selectedIds: string[],
  kind: SizeKind
): TableItem[] {
  const selected = selectedBounds(tables, selectedIds);
  if (selected.length < 2) return tables;
  const targetSize = Math.max(...selected.map((b) => (kind === "width" ? b.width : b.height)));

  return tables.map((t) => {
    if (!selectedIds.includes(t.id)) return t;
    if (t.type === "circular") {
      return { ...t, radius: Math.max(MIN_RADIUS, targetSize / 2) };
    }
    return kind === "width"
      ? { ...t, width: Math.max(MIN_RECT_SIZE, targetSize) }
      : { ...t, height: Math.max(MIN_RECT_SIZE, targetSize) };
  });
}

export function distributeTables(
  tables: TableItem[],
  selectedIds: string[],
  axis: AxisKind
): TableItem[] {
  const selected = selectedBounds(tables, selectedIds);
  if (selected.length < 3) return tables;

  const sorted = [...selected].sort((a, b) => (axis === "horizontal" ? a.x - b.x : a.y - b.y));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return tables;

  const firstSize = axis === "horizontal" ? first.width : first.height;
  const startEdge = (axis === "horizontal" ? first.x : first.y) + firstSize;
  const endEdge = axis === "horizontal" ? last.x : last.y;
  const middle = sorted.slice(1, -1);
  const sumMiddleSizes = middle.reduce(
    (sum, b) => sum + (axis === "horizontal" ? b.width : b.height),
    0
  );
  const gap = (endEdge - startEdge - sumMiddleSizes) / (sorted.length - 1);

  const moves: { id: string; dx: number; dy: number }[] = [];
  let cursor = startEdge;
  middle.forEach((b) => {
    const size = axis === "horizontal" ? b.width : b.height;
    const currentStart = axis === "horizontal" ? b.x : b.y;
    const delta = snapToGrid(cursor + gap) - currentStart;
    moves.push({
      id: b.id,
      dx: axis === "horizontal" ? delta : 0,
      dy: axis === "horizontal" ? 0 : delta,
    });
    cursor = snapToGrid(cursor + gap) + size;
  });
  return applyMoves(tables, moves);
}

export function tidyTables(
  tables: TableItem[],
  selectedIds: string[],
  axis: AxisKind
): TableItem[] {
  const selected = selectedBounds(tables, selectedIds);
  if (selected.length < 3) return tables;

  const sorted = [...selected].sort((a, b) => (axis === "horizontal" ? a.x - b.x : a.y - b.y));
  const firstItem = sorted[0];
  if (!firstItem) return tables;

  const moves: { id: string; dx: number; dy: number }[] = [];
  let cursor = axis === "horizontal" ? firstItem.x : firstItem.y;
  sorted.forEach((b, i) => {
    const size = axis === "horizontal" ? b.width : b.height;
    if (i === 0) {
      cursor += size + TIDY_GAP;
      return;
    }
    const currentStart = axis === "horizontal" ? b.x : b.y;
    const targetStart = snapToGrid(cursor);
    const delta = targetStart - currentStart;
    moves.push({
      id: b.id,
      dx: axis === "horizontal" ? delta : 0,
      dy: axis === "horizontal" ? 0 : delta,
    });
    cursor = targetStart + size + TIDY_GAP;
  });
  return applyMoves(tables, moves);
}
