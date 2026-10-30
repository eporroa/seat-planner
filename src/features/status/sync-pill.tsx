"use client";

import { useLiveQuery } from "@electric-sql/pglite-react";
import { Q, summarizeSync, type SyncState, type SyncStatusRow } from "@/db/queries";

const BACKEND_LABEL: Record<string, string> = { "opfs-ahp": "OPFS", idb: "IndexedDB" };

const STATE_STYLE: Record<SyncState, { dot: string; label: string }> = {
  live: { dot: "bg-emerald-500", label: "En vivo" },
  syncing: { dot: "bg-sky-500 animate-pulse", label: "Sincronizando" },
  offline: { dot: "bg-amber-500", label: "Sin conexión" },
  paused: { dot: "bg-amber-500", label: "Sin red (simulado)" },
};

export function SyncPill() {
  const backend = useLiveQuery<{ value: string }>(Q.backend)?.rows[0]?.value;
  const pending = useLiveQuery<{ n: number }>(Q.pendingCount)?.rows[0]?.n ?? 0;
  const status = useLiveQuery<SyncStatusRow>(Q.syncStatus)?.rows;
  const paused = useLiveQuery<{ value: string }>(Q.syncPaused)?.rows[0]?.value === "true";
  const state = STATE_STYLE[summarizeSync(status, paused)];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600">
      <span className={`h-2 w-2 rounded-full ${state.dot}`} />
      {state.label} · {backend ? (BACKEND_LABEL[backend] ?? backend) : "…"}
      {pending > 0 && <span className="text-amber-600">· {pending} pendientes</span>}
    </span>
  );
}
