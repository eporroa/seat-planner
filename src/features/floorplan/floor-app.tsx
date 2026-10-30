"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { usePGlite, useLiveQuery } from "@electric-sql/pglite-react";
import { toast, Toaster } from "sonner";
import { Users } from "lucide-react";

import type { AppDb } from "@/db/client";
import {
  addSeat, claimSeat, createTable, deleteTable, moveTable, moveTables, releaseSeat, renameTable,
  resetRoom, resizeTable, saveProfile, setLocked, setSeatCount,
} from "@/db/actions";
import { Q } from "@/db/queries";
import { randomBaseName } from "@/shared/names";
import { MAX_SEATS_PER_ATTENDEE, MAX_TABLES, ROOM_HEIGHT, ROOM_WIDTH } from "@/shared/room";
import { RejectionToasts } from "@/features/status/rejection-toasts";
import { LatencyReadout, OfflineToggle } from "@/features/status/offline-toggle";
import { SyncPill } from "@/features/status/sync-pill";
import { Welcome } from "@/features/welcome/welcome";
import { FloorCanvas, type FocusRequest } from "./floor-canvas";
import { AdminToolbar } from "./admin-toolbar";
import { AdminUnlock } from "./admin-unlock";
import { ConfirmDialog } from "./confirm-dialog";
import { findNearestFreeSpot, isValidPlacement, isValidSize, WHOLE_ROOM_CELLS } from "./grid-rules";
import { alignTables, distributeTables, tidyTables } from "./layout-ops";
import { TableSheet } from "./table-sheet";
import type { AlignKind, AxisKind, ChairItem, TableItem } from "./types";
import { snapToGrid } from "./utils";
import { useFloorTables, useProfile } from "./use-floor";

const SHEET_INSET = 260;
const ADMIN_SHEET_INSET = 340;

export function FloorApp() {
  return (
    <Suspense fallback={<div className="grid h-dvh place-items-center text-slate-500">Cargando…</div>}>
      <FloorGate />
    </Suspense>
  );
}

function FloorGate() {
  // ?isAdmin=true only asks for admin mode; the server verifies the passcode.
  const adminRequested = useSearchParams().get("isAdmin") === "true";
  const { profile, loading } = useProfile();
  if (loading) return <div className="grid h-dvh place-items-center text-slate-500">Cargando…</div>;
  if (!profile) return <Welcome adminRequested={adminRequested} />;
  return (
    <Floor
      myTag={profile.tag}
      name={profile.name}
      baseName={profile.base_name ?? profile.name}
      clientId={profile.client_id}
      isAdmin={adminRequested && profile.is_admin}
      offerUnlock={adminRequested && !profile.is_admin}
    />
  );
}

interface FloorProps {
  myTag: string;
  name: string;
  baseName: string;
  clientId: string;
  isAdmin: boolean;
  offerUnlock: boolean;
}

function Floor({ myTag, name, baseName, clientId, isAdmin, offerUnlock }: FloorProps) {
  const db = usePGlite() as unknown as AppDb;
  const { tables } = useFloorTables(myTag);
  const seated = useLiveQuery<{ n: number }>(Q.seated)?.rows[0]?.n ?? 0;
  const locked = useLiveQuery<{ is_locked: boolean }>("SELECT is_locked FROM floor_room LIMIT 1")?.rows[0]?.is_locked ?? false;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "reset" | null>(null);

  const selected = selectedIds.length === 1 ? tables.find((t) => t.id === selectedIds[0]) : undefined;
  const canMove = isAdmin || !locked;

  function select(ids: string[]) {
    setSelectedIds(ids);
    const only = ids.length === 1 ? ids[0] : undefined;
    // On touch screens, tapping a table opens the sheet and zooms to it. With a
    // mouse the view stays put so multi-select and drag targets don't shift.
    const touch = window.matchMedia("(pointer: coarse)").matches;
    if (only && only !== selectedIds[0] && touch) setFocus({ tableId: only, nonce: Date.now() });
  }

  // Validates the drop (grid, room bounds, overlap) and returns the final position.
  function handleMove(id: string, x: number, y: number): { x: number; y: number } {
    const table = tables.find((t) => t.id === id);
    if (!table) return { x, y };
    const group = selectedIds.length > 1 && selectedIds.includes(id) ? selectedIds : [id];
    const moving = new Set(group);
    const others = tables.filter((t) => !moving.has(t.id));

    let final: { x: number; y: number } | null;
    if (group.length === 1) {
      final = findNearestFreeSpot(table, x, y, others);
    } else {
      // Group drops are all-or-nothing: same delta for everyone, no spiral search.
      const dx = x - table.x;
      const dy = y - table.y;
      const ok = group.every((gid) => {
        const t = tables.find((tt) => tt.id === gid);
        if (!t) return true;
        const moved = { ...t, x: t.x + dx, y: t.y + dy };
        return findNearestFreeSpot(moved, moved.x, moved.y, others)?.x === moved.x &&
          findNearestFreeSpot(moved, moved.x, moved.y, others)?.y === moved.y;
      });
      final = ok ? { x, y } : null;
    }

    if (!final) {
      toast("No hay espacio ahí — la mesa regresó a su lugar");
      return { x: table.x, y: table.y };
    }
    const dx = final.x - table.x;
    const dy = final.y - table.y;
    if (dx !== 0 || dy !== 0) {
      for (const gid of group) {
        const t = tables.find((tt) => tt.id === gid);
        if (t) void moveTable(db, gid, t.x + dx, t.y + dy);
      }
    }
    return final;
  }

  function addTable(shape: "circular" | "rectangular") {
    if (tables.length >= MAX_TABLES) {
      toast.error(`Máximo ${MAX_TABLES} mesas`);
      return;
    }
    // Preferred size first; the seed layout is packed, so fall back to smaller tables.
    const sizes: { radius?: number; width?: number; height?: number }[] =
      shape === "circular"
        ? [{ radius: 60 }, { radius: 40 }]
        : [{ width: 200, height: 80 }, { width: 160, height: 80 }, { width: 120, height: 80 }, { width: 80, height: 80 }];
    const id = crypto.randomUUID();
    const seats = shape === "circular" ? 8 : 10;
    let placed: { size: (typeof sizes)[number]; x: number; y: number } | null = null;
    for (const size of sizes) {
      const candidate: TableItem = { id, name: "", type: shape, seats, x: 0, y: 0, ...size, isPending: true, chairs: [] };
      const w = size.radius ? size.radius * 2 : (size.width ?? 0);
      const h = size.radius ? size.radius * 2 : (size.height ?? 0);
      const spot = findNearestFreeSpot(candidate, snapToGrid((ROOM_WIDTH - w) / 2), snapToGrid((ROOM_HEIGHT - h) / 2), tables, WHOLE_ROOM_CELLS);
      if (spot) {
        placed = { size, ...spot };
        break;
      }
    }
    if (!placed) {
      toast.error("No hay espacio para otra mesa");
      return;
    }
    const { size, x, y } = placed;
    const nextNumber = Math.max(0, ...tables.map((t) => Number(/^Mesa (\d+)$/.exec(t.name)?.[1] ?? 0))) + 1;
    void createTable(db, {
      id, label: `Mesa ${nextNumber}`, shape, x, y, seats,
      radius: size.radius ?? null, width: size.width ?? null, height: size.height ?? null,
    }).then((ok) => ok && select([id]));
  }

  // Align / distribute / tidy: validate the FINAL layout, then send one batch.
  function applyLayout(next: TableItem[]) {
    const original = new Map(tables.map((t) => [t.id, t]));
    const moved = next
      .map((t) => ({ ...t, x: snapToGrid(t.x), y: snapToGrid(t.y) }))
      .filter((t) => original.get(t.id)?.x !== t.x || original.get(t.id)?.y !== t.y);
    if (moved.length === 0) return;
    const final = new Map(tables.map((t) => [t.id, t]));
    moved.forEach((t) => final.set(t.id, t));
    const all = [...final.values()];
    if (!moved.every((t) => isValidPlacement(t, all.filter((o) => o.id !== t.id)))) {
      toast.error("Ese acomodo no cabe en el salón");
      return;
    }
    void moveTables(db, moved.map((t) => ({ id: t.id, pos_x: t.x, pos_y: t.y })));
  }
  const onAlign = (kind: AlignKind) => applyLayout(alignTables(tables, selectedIds, kind));
  const onDistribute = (axis: AxisKind) => applyLayout(distributeTables(tables, selectedIds, axis));
  const onTidy = (axis: AxisKind) => applyLayout(tidyTables(tables, selectedIds, axis));

  function handleResize(id: string, changes: Partial<TableItem>) {
    const table = tables.find((t) => t.id === id);
    if (!table) return;
    const next = { ...table, ...changes };
    const others = tables.filter((t) => t.id !== id);
    if (!isValidSize(next) || !isValidPlacement(next, others)) {
      toast.error("No cabe con ese tamaño");
      return;
    }
    void resizeTable(db, id, { radius: next.radius ?? null, width: next.width ?? null, height: next.height ?? null }, next.x, next.y);
  }

  function confirmAction() {
    if (confirm === "delete") for (const id of selectedIds) void deleteTable(db, id);
    if (confirm === "reset") void resetRoom(db);
    if (confirm === "delete") setSelectedIds([]);
    setConfirm(null);
  }

  // Chairs I hold. Attendees keep at most MAX_SEATS_PER_ATTENDEE: past that, claiming
  // another releases the oldest one (the server does the same); admins have no limit.
  const myChairs = tables.reduce((n, t) => n + t.chairs.filter((c) => c.isMine).length, 0);

  function claim(tableId: string, seat: number) {
    if (!isAdmin && myChairs >= MAX_SEATS_PER_ATTENDEE) {
      toast(`Ya tienes ${MAX_SEATS_PER_ATTENDEE} sillas: se libera la más antigua`);
    }
    void claimSeat(db, tableId, seat);
  }

  function handleChairTap(table: TableItem, chair: ChairItem, directOk: boolean) {
    setSelectedIds([table.id]);
    if (!directOk) {
      setFocus({ tableId: table.id, nonce: Date.now() });
      return;
    }
    if (chair.claimedByName === null) claim(table.id, chair.seatIndex);
    else if (chair.isMine || isAdmin) void releaseSeat(db, table.id, chair.seatIndex);
    else toast(`Ocupada por ${chair.claimedByName}`);
  }

  return (
    <div className="relative flex h-dvh flex-col">
      <Toaster position="top-center" richColors />
      <RejectionToasts />
      <header className="z-10 flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{name}</p>
          <button
            type="button"
            className="text-xs text-teal-700 underline"
            onClick={() => void saveProfile(db, clientId, randomBaseName(name))}
          >
            Cambiar nombre
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1 text-xs text-slate-600">
            <Users size={14} /> {seated}
          </span>
          {myChairs > 0 && (
            <span className="text-xs text-sky-700" data-testid="my-chairs" title="Tus sillas">
              Mis sillas {isAdmin ? myChairs : `${myChairs}/${MAX_SEATS_PER_ATTENDEE}`}
            </span>
          )}
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{isAdmin ? "Admin" : "Asistente"}</span>
          <SyncPill />
        </div>
      </header>
      <div className="z-10 flex items-center justify-between gap-2 border-b border-slate-100 bg-white px-3 py-1">
        <OfflineToggle />
        <LatencyReadout />
      </div>
      {offerUnlock && <AdminUnlock clientId={clientId} baseName={baseName} />}
      {isAdmin && (
        <AdminToolbar
          selectionCount={selectedIds.length}
          locked={locked}
          onAddTable={addTable}
          onDelete={() => setConfirm("delete")}
          onAlign={onAlign}
          onDistribute={onDistribute}
          onTidy={onTidy}
          onToggleLock={() => void setLocked(db, !locked)}
          onReset={() => setConfirm("reset")}
        />
      )}
      {locked && !isAdmin && (
        <p className="z-10 bg-amber-50 px-3 py-1 text-center text-xs text-amber-800">Plano bloqueado: solo puedes elegir silla</p>
      )}

      <div className="relative min-h-0 flex-1">
        <FloorCanvas
          tables={tables}
          selectedIds={selectedIds}
          onSelect={select}
          onMoveTable={handleMove}
          onResizeTable={handleResize}
          onChairTap={handleChairTap}
          canMove={canMove}
          isAdmin={isAdmin}
          focusRequest={focus}
          bottomInset={selected ? (isAdmin ? ADMIN_SHEET_INSET : SHEET_INSET) : 0}
        />
        {selected && (
          <TableSheet
            table={selected}
            isAdmin={isAdmin}
            locked={locked}
            onClose={() => setSelectedIds([])}
            onClaim={(seat) => claim(selected.id, seat)}
            onRelease={(seat) => void releaseSeat(db, selected.id, seat)}
            onAddSeat={() => void addSeat(db, selected.id)}
            onRename={(label) => void renameTable(db, selected.id, label)}
            onRemoveSeat={() => void setSeatCount(db, selected.id, selected.seats - 1)}
            onResize={(changes) => handleResize(selected.id, changes)}
          />
        )}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "reset" ? "Restablecer la demo" : "Eliminar mesas"}
        message={
          confirm === "reset"
            ? "Se vuelve al plano inicial y se liberan todas las sillas para todos."
            : `Se eliminan ${selectedIds.length} mesa(s) y se liberan sus sillas para todos.`
        }
        confirmLabel={confirm === "reset" ? "Restablecer" : "Eliminar"}
        onConfirm={confirmAction}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
