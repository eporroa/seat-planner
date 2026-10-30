"use client";

import { useEffect, useRef } from "react";
import { Circle, Group, Rect, Text, Transformer } from "react-konva";
import Konva from "konva";

import type { ChairItem, TableItem } from "./types";
import {
  CHAIR_RADIUS,
  MIN_RADIUS,
  MIN_RECT_SIZE,
  chairPoint,
  occupiedCountOf,
  snapToGrid,
  tableBounds,
} from "./utils";

export const COLOR_SELECTED_STROKE = "#006b5f";
export const COLOR_PRIMARY = "#031632";
export const COLOR_OUTLINE_VARIANT = "#c5c6ce";
export const COLOR_MINE = "#0EA5E9";
export const COLOR_TAKEN = "#F97316";

// Konva draws a drag only after this many px, so a tap never moves a table.
const DRAG_CLICK_THRESHOLD = 3;

function PulseRing({ radius }: { radius: number }) {
  const ref = useRef<Konva.Circle>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const animation = new Konva.Animation((frame) => {
      const t = ((frame?.time ?? 0) % 1200) / 1200;
      node.opacity(0.6 * (1 - t));
      node.radius(radius + 2 + t * 5);
    }, node.getLayer());
    animation.start();
    return () => {
      animation.stop();
    };
  }, [radius]);
  return <Circle ref={ref} radius={radius} stroke={COLOR_MINE} strokeWidth={2} listening={false} />;
}

function ChairDot({
  chair,
  x,
  y,
  onTap,
}: {
  chair: ChairItem;
  x: number;
  y: number;
  onTap: (chair: ChairItem) => void;
}) {
  const taken = chair.claimedByName !== null;
  const fill = chair.isMine ? COLOR_MINE : taken ? COLOR_TAKEN : "#ffffff";
  return (
    <Group
      x={x}
      y={y}
      onClick={(e) => {
        e.cancelBubble = true;
        onTap(chair);
      }}
      onTap={(e) => {
        e.cancelBubble = true;
        onTap(chair);
      }}
    >
      {chair.isMine && chair.isPending && <PulseRing radius={CHAIR_RADIUS} />}
      <Circle radius={CHAIR_RADIUS} fill={fill} stroke={COLOR_SELECTED_STROKE} strokeWidth={1.5} />
      {taken && (
        <Text
          x={-CHAIR_RADIUS}
          y={-5}
          width={CHAIR_RADIUS * 2}
          align="center"
          text={(chair.claimedByName ?? "").charAt(0).toUpperCase()}
          fontSize={11}
          fontStyle="bold"
          fill="#ffffff"
          listening={false}
        />
      )}
    </Group>
  );
}

export function TableNode({
  table,
  displayName,
  isSelected,
  canMove,
  canResize,
  onSelect,
  onMove,
  onDragStart,
  onDragMoveLive,
  onTransform,
  onChairTap,
}: {
  table: TableItem;
  displayName: string;
  isSelected: boolean;
  canMove: boolean;
  canResize: boolean;
  onSelect: (id: string, additive: boolean) => void;
  // Returns the final (validated) position so a rejected drop can snap back.
  onMove: (id: string, x: number, y: number) => { x: number; y: number };
  // Live drag so the rest of a multi-selection moves along with this table.
  onDragStart?: (id: string) => void;
  onDragMoveLive?: (id: string, x: number, y: number) => void;
  onTransform: (id: string, changes: Partial<TableItem>) => void;
  onChairTap: (table: TableItem, chair: ChairItem) => void;
}) {
  const shapeRef = useRef<Konva.Group>(null);
  const transformerRef = useRef<Konva.Transformer>(null);

  useEffect(() => {
    if (isSelected && canResize && transformerRef.current && shapeRef.current) {
      transformerRef.current.nodes([shapeRef.current]);
      transformerRef.current.getLayer()?.batchDraw();
    }
  }, [isSelected, canResize]);

  const bounds = tableBounds(table);
  const centerX = bounds.width / 2;
  const centerY = bounds.height / 2;
  const occupied = occupiedCountOf(table);
  const selectedShadow = {
    shadowColor: isSelected ? COLOR_SELECTED_STROKE : undefined,
    shadowBlur: isSelected ? 12 : 0,
    shadowOpacity: isSelected ? 0.35 : 0,
  };
  const stroke = isSelected || table.type === "circular" ? COLOR_SELECTED_STROKE : COLOR_OUTLINE_VARIANT;
  const outline = {
    stroke,
    strokeWidth: isSelected ? 3 : 1.5,
    dash: table.isPending ? [6, 4] : undefined,
  };

  return (
    <>
      <Group
        ref={shapeRef}
        id={table.id}
        x={table.x}
        y={table.y}
        draggable={canMove}
        dragDistance={DRAG_CLICK_THRESHOLD}
        onClick={(e) => onSelect(table.id, e.evt.shiftKey)}
        onTap={() => onSelect(table.id, false)}
        onDragStart={() => onDragStart?.(table.id)}
        onDragMove={(e) => onDragMoveLive?.(table.id, e.target.x(), e.target.y())}
        onDragEnd={(e) => {
          const final = onMove(table.id, snapToGrid(e.target.x()), snapToGrid(e.target.y()));
          e.target.position(final);
        }}
        onTransformEnd={() => {
          const node = shapeRef.current;
          if (!node) return;
          const scaleX = node.scaleX();
          const scaleY = node.scaleY();
          node.scaleX(1);
          node.scaleY(1);
          if (table.type === "circular") {
            onTransform(table.id, {
              radius: Math.max(MIN_RADIUS, snapToGrid((table.radius ?? MIN_RADIUS) * scaleX)),
              x: snapToGrid(node.x()),
              y: snapToGrid(node.y()),
            });
          } else {
            onTransform(table.id, {
              width: Math.max(MIN_RECT_SIZE, snapToGrid((table.width ?? MIN_RECT_SIZE) * scaleX)),
              height: Math.max(MIN_RECT_SIZE, snapToGrid((table.height ?? MIN_RECT_SIZE) * scaleY)),
              x: snapToGrid(node.x()),
              y: snapToGrid(node.y()),
            });
          }
        }}
      >
        {table.type === "circular" ? (
          <Circle x={centerX} y={centerY} radius={table.radius ?? MIN_RADIUS} fill="white" {...outline} {...selectedShadow} />
        ) : (
          <Rect width={bounds.width} height={bounds.height} fill="white" cornerRadius={8} {...outline} {...selectedShadow} />
        )}
        {table.chairs.map((chair) => {
          const p = chairPoint(table, chair.seatIndex, table.chairs.length);
          return <ChairDot key={chair.id} chair={chair} x={p.x} y={p.y} onTap={(c) => onChairTap(table, c)} />;
        })}
        <Text
          x={0}
          y={centerY - 14}
          width={bounds.width}
          align="center"
          text={displayName}
          fontSize={13}
          fontStyle="bold"
          fill={isSelected ? COLOR_SELECTED_STROKE : COLOR_PRIMARY}
          listening={false}
        />
        <Text
          x={0}
          y={centerY + 3}
          width={bounds.width}
          align="center"
          text={`${occupied}/${table.chairs.length}`}
          fontSize={11}
          fill="#5b6475"
          listening={false}
        />
      </Group>
      {isSelected && canResize && (
        <Transformer
          ref={transformerRef}
          rotateEnabled={false}
          keepRatio={table.type === "circular"}
          boundBoxFunc={(oldBox, newBox) =>
            Math.abs(newBox.width) < MIN_RECT_SIZE || Math.abs(newBox.height) < MIN_RECT_SIZE ? oldBox : newBox
          }
        />
      )}
    </>
  );
}
