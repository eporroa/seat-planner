"use client";

import { useState } from "react";
import { Minus, Plus, X } from "lucide-react";
import type { TableItem } from "./types";
import { occupiedCountOf } from "./utils";

interface TableSheetProps {
  table: TableItem;
  isAdmin: boolean;
  locked: boolean;
  onClose: () => void;
  onClaim: (seat: number) => void;
  onRelease: (seat: number) => void;
  onAddSeat: () => void;
  // Admin only.
  onRename: (label: string) => void;
  onRemoveSeat: () => void;
  onResize: (changes: { radius?: number; width?: number; height?: number }) => void;
}

const STEP = 20;

function Stepper({ label, value, onMinus, onPlus }: { label: string; value: number; onMinus: () => void; onPlus: () => void }) {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-600">
      <span className="w-12">{label}</span>
      <button type="button" aria-label={`Reducir ${label}`} onClick={onMinus} className="rounded border border-slate-300 p-1 hover:bg-slate-50">
        <Minus size={14} />
      </button>
      <span className="w-10 text-center tabular-nums">{value}</span>
      <button type="button" aria-label={`Aumentar ${label}`} onClick={onPlus} className="rounded border border-slate-300 p-1 hover:bg-slate-50">
        <Plus size={14} />
      </button>
    </div>
  );
}

// Keyed by table id + name so the draft resets when the selection or the synced name changes.
function RenameField({ name, onRename }: { name: string; onRename: (label: string) => void }) {
  const [draft, setDraft] = useState(name);
  const commit = () => {
    const label = draft.trim();
    if (label !== name) onRename(label);
  };
  return (
    <input
      aria-label="Nombre de la mesa"
      maxLength={20}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
    />
  );
}

// Bottom sheet with large seat buttons: the phone-friendly way to pick a chair.
export function TableSheet({ table, isAdmin, locked, onClose, onClaim, onRelease, onAddSeat, onRename, onRemoveSeat, onResize }: TableSheetProps) {
  const canAddSeat = table.seats < 12 && (isAdmin || !locked);
  return (
    <section
      className="absolute inset-x-0 bottom-0 z-10 max-h-[60dvh] overflow-y-auto rounded-t-2xl border-t border-slate-200 bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(0,0,0,0.08)]"
      aria-label={`Mesa ${table.name}`}
    >
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">{table.name || "Mesa"}</h2>
          <p className="text-sm text-slate-500">
            {occupiedCountOf(table)}/{table.chairs.length} ocupadas
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Cerrar" className="rounded-full p-2 text-slate-500 hover:bg-slate-100">
          <X size={20} />
        </button>
      </div>
      {isAdmin && (
        <div className="mb-3 space-y-2 rounded-xl bg-slate-50 p-3">
          <RenameField key={`${table.id}:${table.name}`} name={table.name} onRename={onRename} />
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Stepper label="Sillas" value={table.seats} onMinus={onRemoveSeat} onPlus={onAddSeat} />
            {table.type === "circular" ? (
              <Stepper
                label="Radio"
                value={table.radius ?? 0}
                onMinus={() => onResize({ radius: (table.radius ?? 0) - STEP })}
                onPlus={() => onResize({ radius: (table.radius ?? 0) + STEP })}
              />
            ) : (
              <>
                <Stepper
                  label="Ancho"
                  value={table.width ?? 0}
                  onMinus={() => onResize({ width: (table.width ?? 0) - STEP })}
                  onPlus={() => onResize({ width: (table.width ?? 0) + STEP })}
                />
                <Stepper
                  label="Alto"
                  value={table.height ?? 0}
                  onMinus={() => onResize({ height: (table.height ?? 0) - STEP })}
                  onPlus={() => onResize({ height: (table.height ?? 0) + STEP })}
                />
              </>
            )}
          </div>
        </div>
      )}
      <ul className="grid grid-cols-4 gap-2">
        {table.chairs.map((chair) => {
          const taken = chair.claimedByName !== null;
          const mine = chair.isMine;
          const disabled = taken && !mine && !isAdmin;
          return (
            <li key={chair.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => (taken ? onRelease(chair.seatIndex) : onClaim(chair.seatIndex))}
                className={`flex h-14 w-full flex-col items-center justify-center rounded-xl border text-xs font-semibold ${
                  mine
                    ? "border-sky-500 bg-sky-500 text-white"
                    : taken
                      ? "border-orange-500 bg-orange-500 text-white"
                      : "border-teal-700 bg-white text-teal-800 hover:bg-teal-50"
                } ${disabled ? "opacity-90" : ""}`}
              >
                <span className="text-base">{chair.seatIndex}</span>
                <span className="max-w-full truncate px-1 text-[10px] font-normal">
                  {mine ? "Liberar" : taken ? chair.claimedByName : "Libre"}
                </span>
              </button>
            </li>
          );
        })}
        {canAddSeat && (
          <li>
            <button
              type="button"
              onClick={onAddSeat}
              className="flex h-14 w-full flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 text-xs text-slate-500 hover:bg-slate-50"
            >
              <Plus size={18} />
              Silla
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}
