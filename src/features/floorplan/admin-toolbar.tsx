"use client";

import type { ReactNode } from "react";
import { AlignHorizontalJustifyStart, Circle, LayoutGrid, Lock, RectangleHorizontal, RotateCcw, Trash2, Unlock } from "lucide-react";
import type { AlignKind, AxisKind } from "./types";

interface AdminToolbarProps {
  selectionCount: number;
  locked: boolean;
  onAddTable: (shape: "circular" | "rectangular") => void;
  onDelete: () => void;
  onAlign: (kind: AlignKind) => void;
  onDistribute: (axis: AxisKind) => void;
  onTidy: (axis: AxisKind) => void;
  onToggleLock: () => void;
  onReset: () => void;
}

const ALIGN_OPTIONS: { kind: AlignKind; label: string }[] = [
  { kind: "left", label: "Izquierda" },
  { kind: "hcenter", label: "Centro horizontal" },
  { kind: "right", label: "Derecha" },
  { kind: "top", label: "Arriba" },
  { kind: "vcenter", label: "Centro vertical" },
  { kind: "bottom", label: "Abajo" },
];

const AXIS_OPTIONS: { axis: AxisKind; label: string }[] = [
  { axis: "horizontal", label: "Horizontal" },
  { axis: "vertical", label: "Vertical" },
];

const button =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40";

function Menu({ label, icon, disabled, children }: { label: string; icon: ReactNode; disabled: boolean; children: ReactNode }) {
  return (
    <details className="relative" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && e.currentTarget.removeAttribute("open")}>
      <summary className={`${button} list-none ${disabled ? "pointer-events-none opacity-40" : "cursor-pointer"}`}>
        {icon} {label}
      </summary>
      <div className="absolute left-0 top-full z-20 mt-1 min-w-40 rounded-lg border border-slate-200 bg-white p-1 shadow-lg">{children}</div>
    </details>
  );
}

function MenuItem({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      className="block w-full rounded px-3 py-1.5 text-left text-xs hover:bg-slate-100"
      onClick={(e) => {
        onClick();
        e.currentTarget.closest("details")?.removeAttribute("open");
      }}
    >
      {children}
    </button>
  );
}

export function AdminToolbar(props: AdminToolbarProps) {
  const { selectionCount } = props;
  return (
    <div role="toolbar" aria-label="Herramientas de admin" className="z-10 flex flex-wrap items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-3 py-2">
      <button type="button" className={button} onClick={() => props.onAddTable("circular")}>
        <Circle size={14} /> Mesa redonda
      </button>
      <button type="button" className={button} onClick={() => props.onAddTable("rectangular")}>
        <RectangleHorizontal size={14} /> Mesa rectangular
      </button>
      <button type="button" className={button} disabled={selectionCount === 0} onClick={props.onDelete}>
        <Trash2 size={14} /> Eliminar
      </button>
      <Menu label="Alinear" icon={<AlignHorizontalJustifyStart size={14} />} disabled={selectionCount < 2}>
        {ALIGN_OPTIONS.map((o) => (
          <MenuItem key={o.kind} onClick={() => props.onAlign(o.kind)}>
            {o.label}
          </MenuItem>
        ))}
      </Menu>
      <Menu label="Distribuir" icon={<LayoutGrid size={14} />} disabled={selectionCount < 3}>
        {AXIS_OPTIONS.map((o) => (
          <MenuItem key={o.axis} onClick={() => props.onDistribute(o.axis)}>
            {o.label}
          </MenuItem>
        ))}
      </Menu>
      <Menu label="Ordenar" icon={<LayoutGrid size={14} />} disabled={selectionCount < 3}>
        {AXIS_OPTIONS.map((o) => (
          <MenuItem key={o.axis} onClick={() => props.onTidy(o.axis)}>
            {o.label}
          </MenuItem>
        ))}
      </Menu>
      <button type="button" className={button} onClick={props.onToggleLock} aria-pressed={props.locked}>
        {props.locked ? <Unlock size={14} /> : <Lock size={14} />} {props.locked ? "Desbloquear plano" : "Bloquear plano"}
      </button>
      <button type="button" className={`${button} text-red-700`} onClick={props.onReset}>
        <RotateCcw size={14} /> Restablecer demo
      </button>
    </div>
  );
}
