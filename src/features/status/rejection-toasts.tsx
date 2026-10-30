"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useLiveQuery, usePGlite } from "@electric-sql/pglite-react";
import type { AppDb } from "@/db/client";
import { rejectionMessage } from "@/shared/reasons";

interface RejectedRow {
  mutation_id: string;
  entity: string;
  reason: string | null;
}

// The flusher keeps rejected outbox rows; this explains each one and clears it.
export function RejectionToasts() {
  const db = usePGlite() as unknown as AppDb;
  const rows = useLiveQuery<RejectedRow>(
    "SELECT mutation_id, entity, reason FROM outbox WHERE status = 'rejected' ORDER BY created_at"
  )?.rows;
  // Another render may see the same row before the delete lands.
  const shown = useRef(new Set<string>());

  useEffect(() => {
    if (!rows?.length) return;
    const fresh = rows.filter((r) => !shown.current.has(r.mutation_id));
    for (const row of fresh) {
      shown.current.add(row.mutation_id);
      toast.error(rejectionMessage(row.reason, row.entity));
    }
    if (fresh.length > 0) {
      void db.query("DELETE FROM outbox WHERE status = 'rejected' AND mutation_id = ANY($1::uuid[])", [
        fresh.map((r) => r.mutation_id),
      ]);
    }
  }, [rows, db]);

  return null;
}
