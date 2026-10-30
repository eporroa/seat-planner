"use client";

import { useEffect, useState } from "react";
import { useLiveQuery, usePGlite } from "@electric-sql/pglite-react";
import { DbProvider } from "@/db/db-provider";
import type { AppDb } from "@/db/client";
import { Q, type SyncStatusRow } from "@/db/queries";

interface OutboxRow {
  mutation_id: string;
  entity: string;
  op: string;
  status: string;
  reason: string | null;
  attempts: number;
}

function Panel() {
  const db = usePGlite() as unknown as AppDb;
  const backend = useLiveQuery<{ value: string }>(Q.backend)?.rows[0]?.value ?? "…";
  const outbox = useLiveQuery<OutboxRow>(
    "SELECT mutation_id, entity, op, status, reason, attempts FROM outbox ORDER BY created_at"
  )?.rows;
  const shapes = useLiveQuery<SyncStatusRow>(Q.syncStatus)?.rows;
  const paused = useLiveQuery<{ value: string }>(Q.syncPaused)?.rows[0]?.value === "true";
  const counts = useLiveQuery<{ tables: number; claims: number }>(
    "SELECT (SELECT count(*)::int FROM tables_synced) AS tables, (SELECT count(*)::int FROM seat_claims_synced) AS claims"
  )?.rows[0];
  const rejections = useLiveQuery<{ id: number; entity: string; op: string; reason: string }>(
    "SELECT id, entity, op, reason FROM rejection_log ORDER BY id DESC"
  )?.rows;
  const resume = useLiveQuery<{ key: string; value: string }>(
    "SELECT key, value FROM local_meta WHERE key IN ('rev', 'epoch')"
  )?.rows;
  const [isLeader, setIsLeader] = useState(db.isLeader);
  const [storage, setStorage] = useState<{ usage?: number; quota?: number; persisted?: boolean }>({});

  useEffect(() => {
    const off = db.onLeaderChange(() => setIsLeader(db.isLeader));
    return off;
  }, [db]);

  useEffect(() => {
    void (async () => {
      const estimate = await navigator.storage?.estimate?.();
      const persisted = await navigator.storage?.persisted?.();
      setStorage({ usage: estimate?.usage, quota: estimate?.quota, persisted });
    })();
  }, []);

  const mb = (n?: number) => (n === undefined ? "?" : `${(n / 1024 / 1024).toFixed(1)} MB`);
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-6 font-mono text-sm">
      <h1 className="text-xl font-bold">/debug</h1>
      <dl className="grid grid-cols-[12rem_1fr] gap-y-1">
        <dt>Storage backend</dt>
        <dd data-testid="backend">{backend}</dd>
        <dt>Leader tab</dt>
        <dd>{String(isLeader)}</dd>
        <dt>Local DB size</dt>
        <dd>
          {mb(storage.usage)} / {mb(storage.quota)}
        </dd>
        <dt>Persisted</dt>
        <dd>{String(storage.persisted)}</dd>
      </dl>
      <h2 className="font-bold">Sync</h2>
      <ul className="space-y-1" data-testid="shapes">
        {shapes?.map((r) => (
          <li key={r.shape}>
            {r.shape} · upToDate={String(r.up_to_date)} · reachable={String(r.reachable)}
            {r.error ? ` · error: ${r.error}` : ""}
          </li>
        ))}
        {shapes?.length === 0 && <li>sin datos</li>}
      </ul>
      <p data-testid="synced-counts">
        synced: {counts?.tables ?? 0} mesas, {counts?.claims ?? 0} sillas ocupadas
      </p>
      <p data-testid="subscription" className="break-all text-xs text-slate-500">
        resume: {resume?.map((r) => `${r.key} ${r.value}`).join(" · ") || "—"}
      </p>
      <button
        type="button"
        className="rounded border border-slate-300 px-3 py-1"
        onClick={() =>
          void db.query(
            "INSERT INTO local_settings (key, value) VALUES ('sync_paused', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
            [String(!paused)]
          )
        }
      >
        {paused ? "Reanudar sync" : "Pausar sync"}
      </button>
      <h2 className="font-bold">Outbox ({outbox?.length ?? 0})</h2>
      <ul className="space-y-1">
        {outbox?.map((r) => (
          <li key={r.mutation_id}>
            {r.entity}/{r.op} · {r.status} · intentos {r.attempts} {r.reason ?? ""}
          </li>
        ))}
      </ul>
      <h2 className="font-bold">Últimos rechazos ({rejections?.length ?? 0})</h2>
      <ul className="space-y-1" data-testid="rejections">
        {rejections?.map((r) => (
          <li key={r.id}>
            {r.entity}/{r.op} · {r.reason}
          </li>
        ))}
      </ul>
    </main>
  );
}

export function DebugPanel() {
  return (
    <DbProvider>
      <Panel />
    </DbProvider>
  );
}
