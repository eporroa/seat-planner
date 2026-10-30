"use client";

import { useEffect } from "react";
import { useLiveQuery } from "@electric-sql/pglite-react";
import { noteRender } from "@/db/latency";
import { Q, type ClaimRow, type ProfileRow, type TableRow } from "@/db/queries";
import type { SeatClaim } from "./utils";
import { syncChairs } from "./utils";
import type { TableItem } from "./types";

export function useProfile(): { profile: ProfileRow | null; loading: boolean } {
  const result = useLiveQuery<ProfileRow>(Q.profile);
  return { profile: result?.rows[0] ?? null, loading: result === undefined };
}

// Everything the UI knows about the room comes from live queries on the local DB.
export function useFloorTables(myTag: string | null): { tables: TableItem[]; ready: boolean } {
  const tableRows = useLiveQuery<TableRow>(Q.tables);
  const claimRows = useLiveQuery<ClaimRow>(Q.claims);
  // Closes the latency measurement started by the last local write.
  useEffect(() => noteRender(), [tableRows, claimRows]);
  if (!tableRows || !claimRows) return { tables: [], ready: false };

  const claimsByTable = new Map<string, Map<number, SeatClaim>>();
  for (const c of claimRows.rows) {
    const bySeat = claimsByTable.get(c.table_id) ?? new Map<number, SeatClaim>();
    bySeat.set(c.seat_index, {
      claimedByName: c.client_name,
      isMine: myTag !== null && c.owner_tag === myTag,
      isPending: c.is_pending,
    });
    claimsByTable.set(c.table_id, bySeat);
  }

  const tables = tableRows.rows.map(
    (r): TableItem => ({
      id: r.id,
      name: r.label,
      type: r.shape,
      seats: r.seat_limit,
      x: r.pos_x,
      y: r.pos_y,
      radius: r.shape_radius ?? undefined,
      width: r.shape_width ?? undefined,
      height: r.shape_height ?? undefined,
      isPending: r.is_pending,
      chairs: syncChairs(r.id, r.seat_limit, claimsByTable.get(r.id)),
    })
  );
  return { tables, ready: true };
}
