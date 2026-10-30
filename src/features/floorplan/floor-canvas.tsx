"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Hand, Maximize2, MousePointer2, ZoomIn, ZoomOut } from "lucide-react";
import type Konva from "konva";
import { Layer, Rect, Stage } from "react-konva";

import { ROOM_HEIGHT, ROOM_WIDTH } from "@/shared/room";
import { COLOR_OUTLINE_VARIANT, COLOR_SELECTED_STROKE, TableNode } from "./canvas-nodes";
import { footprint } from "./grid-rules";
import type { ChairItem, TableItem } from "./types";
import { CHAIR_RADIUS, GRID_SIZE, displayNameOf, tableBounds } from "./utils";

const MIN_SCALE = 0.15;
const MAX_SCALE = 3;
const FIT_PADDING = 16;
const WHEEL_STEP = 1.1;
// Chairs are tappable on the canvas only when they are at least this big.
const MIN_CHAIR_TOUCH_PX = 32;

export interface FocusRequest {
  tableId: string;
  nonce: number;
}

export interface FloorCanvasProps {
  tables: TableItem[];
  selectedIds: string[];
  onSelect: (ids: string[]) => void;
  // Returns the final position (a validated spot, or the original on rejection).
  onMoveTable: (id: string, x: number, y: number) => { x: number; y: number };
  onResizeTable: (id: string, changes: Partial<TableItem>) => void;
  // directOk: chairs are big enough at the current zoom to act on directly.
  onChairTap: (table: TableItem, chair: ChairItem, directOk: boolean) => void;
  canMove: boolean;
  isAdmin: boolean;
  focusRequest: FocusRequest | null;
  // Pixels at the bottom covered by the bottom sheet.
  bottomInset: number;
}

function createDotPattern(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = GRID_SIZE;
  canvas.height = GRID_SIZE;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = COLOR_OUTLINE_VARIANT;
    ctx.beginPath();
    ctx.arc(1, 1, 1, 0, Math.PI * 2);
    ctx.fill();
  }
  return canvas;
}

const clampScale = (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));

export function FloorCanvas({
  tables,
  selectedIds,
  onSelect,
  onMoveTable,
  onResizeTable,
  onChairTap,
  canMove,
  isAdmin,
  focusRequest,
  bottomInset,
}: FloorCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);
  const pinch = useRef<{ dist: number; center: { x: number; y: number } } | null>(null);
  const didInitialFit = useRef(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(1);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const [tool, setTool] = useState<"select" | "hand">("select");
  const [isSpaceHeld, setIsSpaceHeld] = useState(false);
  const [marquee, setMarquee] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const dragGroupOriginsRef = useRef<Map<string, { x: number; y: number }> | null>(null);

  const selectedSet = new Set(selectedIds);
  // Hand tool / space: everything pans. Otherwise attendees still pan by dragging
  // empty space (tables are draggable children, so they win), while admins
  // marquee-select on empty space.
  const explicitPan = tool === "hand" || isSpaceHeld;
  const isPanMode = explicitPan || !isAdmin;
  const dotPattern = useMemo(() => (typeof document !== "undefined" ? createDotPattern() : null), []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function viewFor(box: { x: number; y: number; width: number; height: number }, inset: number, maxScale = MAX_SCALE) {
    const availH = Math.max(1, size.height - inset);
    const next = Math.min(
      maxScale,
      clampScale(Math.min((size.width - FIT_PADDING * 2) / box.width, (availH - FIT_PADDING * 2) / box.height))
    );
    return {
      scale: next,
      pos: {
        x: (size.width - box.width * next) / 2 - box.x * next,
        y: (availH - box.height * next) / 2 - box.y * next,
      },
    };
  }

  function fitRoom() {
    if (size.width === 0) return;
    const v = viewFor({ x: 0, y: 0, width: ROOM_WIDTH, height: ROOM_HEIGHT }, 0);
    setScale(v.scale);
    setStagePos(v.pos);
  }

  // Fit the whole room once the container has a size.
  useEffect(() => {
    if (didInitialFit.current || size.width === 0) return;
    didInitialFit.current = true;
    fitRoom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);

  // Zoom to a table (phone flow: tap table → sheet opens → canvas zooms in).
  useEffect(() => {
    if (!focusRequest || size.width === 0) return;
    const table = tables.find((t) => t.id === focusRequest.tableId);
    if (!table) return;
    const v = viewFor(footprint(table), bottomInset);
    setScale(v.scale);
    setStagePos(v.pos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== "Space" || isSpaceHeld) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      setIsSpaceHeld(true);
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.code === "Space") setIsSpaceHeld(false);
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [isSpaceHeld]);

  function zoomAround(point: { x: number; y: number }, nextScale: number) {
    const clamped = clampScale(nextScale);
    const worldX = (point.x - stagePos.x) / scale;
    const worldY = (point.y - stagePos.y) / scale;
    setScale(clamped);
    setStagePos({ x: point.x - worldX * clamped, y: point.y - worldY * clamped });
  }

  function handleSelect(id: string, additive: boolean) {
    if (!additive || !isAdmin) {
      onSelect([id]);
      return;
    }
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelect(Array.from(next));
  }

  function handleTableDragStart(id: string) {
    if (!selectedSet.has(id) || selectedSet.size < 2) {
      dragGroupOriginsRef.current = null;
      return;
    }
    const origins = new Map<string, { x: number; y: number }>();
    tables.forEach((t) => {
      if (selectedSet.has(t.id)) origins.set(t.id, { x: t.x, y: t.y });
    });
    dragGroupOriginsRef.current = origins;
  }

  // Moves the other selected Konva nodes directly (no React state per frame).
  function handleTableDragMoveLive(id: string, x: number, y: number) {
    const origins = dragGroupOriginsRef.current;
    const mine = origins?.get(id);
    const stage = stageRef.current;
    if (!origins || !mine || !stage) return;
    const dx = x - mine.x;
    const dy = y - mine.y;
    origins.forEach((origin, otherId) => {
      if (otherId === id) return;
      stage.findOne(`#${otherId}`)?.position({ x: origin.x + dx, y: origin.y + dy });
    });
    stage.batchDraw();
  }

  function handleTableDragEnd(id: string, x: number, y: number) {
    const origins = dragGroupOriginsRef.current;
    dragGroupOriginsRef.current = null;
    const final = onMoveTable(id, x, y);
    const mine = origins?.get(id);
    if (origins && mine) {
      // Keep the rest of the group consistent with the dragged table's outcome.
      const stage = stageRef.current;
      origins.forEach((origin, otherId) => {
        if (otherId === id) return;
        stage?.findOne(`#${otherId}`)?.position({ x: origin.x + final.x - mine.x, y: origin.y + final.y - mine.y });
      });
      stage?.batchDraw();
    }
    return final;
  }

  function handleChairTap(table: TableItem, chair: ChairItem) {
    const precisePointer = window.matchMedia("(pointer: fine)").matches;
    onChairTap(table, chair, precisePointer || scale * CHAIR_RADIUS * 2 >= MIN_CHAIR_TOUCH_PX);
  }

  function handleWheel(e: Konva.KonvaEventObject<WheelEvent>) {
    e.evt.preventDefault();
    const pointer = stageRef.current?.getPointerPosition();
    if (!pointer) return;
    zoomAround(pointer, e.evt.deltaY > 0 ? scale / WHEEL_STEP : scale * WHEEL_STEP);
  }

  function handleStageMouseDown(e: Konva.KonvaEventObject<MouseEvent>) {
    if (isPanMode || e.target !== e.target.getStage()) return; // marquee is admin-only
    const pos = stageRef.current?.getRelativePointerPosition();
    if (!pos) return;
    marqueeStart.current = pos;
    setMarquee({ x: pos.x, y: pos.y, width: 0, height: 0 });
    onSelect([]);
  }

  function handleStageMouseMove() {
    const start = marqueeStart.current;
    const pos = stageRef.current?.getRelativePointerPosition();
    if (!start || !pos) return;
    setMarquee({
      x: Math.min(start.x, pos.x),
      y: Math.min(start.y, pos.y),
      width: Math.abs(pos.x - start.x),
      height: Math.abs(pos.y - start.y),
    });
  }

  function handleStageMouseUp() {
    if (marquee && (marquee.width > 4 || marquee.height > 4)) {
      onSelect(
        tables
          .filter((t) => {
            const b = tableBounds(t);
            return (
              b.x < marquee.x + marquee.width &&
              b.x + b.width > marquee.x &&
              b.y < marquee.y + marquee.height &&
              b.y + b.height > marquee.y
            );
          })
          .map((t) => t.id)
      );
    }
    marqueeStart.current = null;
    setMarquee(null);
  }

  // Two-finger pinch: zoom around the midpoint and follow it while panning.
  function handleTouchMove(e: Konva.KonvaEventObject<TouchEvent>) {
    const [a, b] = [e.evt.touches[0], e.evt.touches[1]];
    if (!a || !b) return;
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    if (stage.isDragging()) stage.stopDrag();
    const rect = stage.container().getBoundingClientRect();
    const center = { x: (a.clientX + b.clientX) / 2 - rect.left, y: (a.clientY + b.clientY) / 2 - rect.top };
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const last = pinch.current;
    pinch.current = { dist, center };
    if (!last || last.dist === 0) return;
    const nextScale = clampScale(scale * (dist / last.dist));
    const worldX = (last.center.x - stagePos.x) / scale;
    const worldY = (last.center.y - stagePos.y) / scale;
    setScale(nextScale);
    setStagePos({ x: center.x - worldX * nextScale, y: center.y - worldY * nextScale });
  }

  return (
    <div ref={containerRef} className="relative h-full w-full touch-none overflow-hidden bg-slate-100">
      {size.width > 0 && (
        <Stage
          ref={stageRef}
          width={size.width}
          height={size.height}
          scaleX={scale}
          scaleY={scale}
          x={stagePos.x}
          y={stagePos.y}
          draggable={isPanMode}
          dragDistance={3}
          onDragEnd={(e) => {
            if (e.target === e.target.getStage()) setStagePos({ x: e.target.x(), y: e.target.y() });
          }}
          onWheel={handleWheel}
          onMouseDown={handleStageMouseDown}
          onMouseMove={handleStageMouseMove}
          onMouseUp={handleStageMouseUp}
          onTouchMove={handleTouchMove}
          onTouchEnd={() => {
            pinch.current = null;
          }}
          onClick={(e) => {
            if (e.target === e.target.getStage() && !marquee) onSelect([]);
          }}
          onTap={(e) => {
            if (e.target === e.target.getStage()) onSelect([]);
          }}
        >
          <Layer>
            <Rect width={ROOM_WIDTH} height={ROOM_HEIGHT} fill="#ffffff" stroke={COLOR_OUTLINE_VARIANT} strokeWidth={2} listening={false} />
            {dotPattern && (
              <Rect
                width={ROOM_WIDTH}
                height={ROOM_HEIGHT}
                fillPatternImage={dotPattern as unknown as HTMLImageElement}
                fillPatternRepeat="repeat"
                listening={false}
              />
            )}
          </Layer>
          <Layer>
            {tables.map((table, i) => (
              <TableNode
                key={table.id}
                table={table}
                displayName={displayNameOf(table, i)}
                isSelected={selectedSet.has(table.id)}
                canMove={canMove && !explicitPan}
                canResize={isAdmin}
                onSelect={handleSelect}
                onMove={handleTableDragEnd}
                onDragStart={handleTableDragStart}
                onDragMoveLive={handleTableDragMoveLive}
                onTransform={onResizeTable}
                onChairTap={handleChairTap}
              />
            ))}
            {marquee && (
              <Rect
                {...marquee}
                fill="rgba(0, 107, 95, 0.08)"
                stroke={COLOR_SELECTED_STROKE}
                strokeWidth={1}
                dash={[4, 4]}
                listening={false}
              />
            )}
          </Layer>
        </Stage>
      )}

      <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between">
        {isAdmin ? (
          <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
            <ToolButton active={tool === "select"} label="Selección" onClick={() => setTool("select")}>
              <MousePointer2 size={16} />
            </ToolButton>
            <ToolButton active={tool === "hand"} label="Mano (o barra espaciadora)" onClick={() => setTool("hand")}>
              <Hand size={16} />
            </ToolButton>
          </div>
        ) : (
          <span />
        )}
        <div className="pointer-events-auto flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
          <ToolButton label="Alejar" onClick={() => zoomAround({ x: size.width / 2, y: size.height / 2 }, scale / 1.3)}>
            <ZoomOut size={16} />
          </ToolButton>
          <span className="w-10 text-center text-xs text-slate-500">{Math.round(scale * 100)}%</span>
          <ToolButton label="Acercar" onClick={() => zoomAround({ x: size.width / 2, y: size.height / 2 }, scale * 1.3)}>
            <ZoomIn size={16} />
          </ToolButton>
          <div className="mx-1 h-4 w-px bg-slate-200" />
          <ToolButton label="Ajustar a pantalla" onClick={fitRoom}>
            <Maximize2 size={16} />
          </ToolButton>
        </div>
      </div>
    </div>
  );
}

function ToolButton({
  active,
  label,
  onClick,
  children,
}: {
  active?: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`rounded p-2 ${active ? "bg-teal-100 text-teal-800" : "text-slate-500 hover:bg-slate-50"}`}
    >
      {children}
    </button>
  );
}
