"use client";

import { useLiveQuery, usePGlite } from "@electric-sql/pglite-react";
import { WifiOff } from "lucide-react";
import type { AppDb } from "@/db/client";
import { setSyncPaused } from "@/db/actions";
import { useLastWriteLatency } from "@/db/latency";
import { Q } from "@/db/queries";

// Stage controls: the on-stage "no network" switch and the measured write latency.
export function OfflineToggle() {
  const db = usePGlite() as unknown as AppDb;
  const paused = useLiveQuery<{ value: string }>(Q.syncPaused)?.rows[0]?.value === "true";
  return (
    <button
      type="button"
      aria-pressed={paused}
      onClick={() => void setSyncPaused(db, !paused)}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
        paused ? "border-amber-400 bg-amber-50 text-amber-800" : "border-slate-200 bg-white text-slate-600"
      }`}
    >
      <WifiOff size={13} /> Simular sin red
    </button>
  );
}

export function LatencyReadout() {
  const ms = useLastWriteLatency();
  if (ms === null) return null;
  return (
    <span className="text-xs tabular-nums text-slate-500" data-testid="latency">
      Última escritura local: {ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms
    </span>
  );
}
