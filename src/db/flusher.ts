import type { PGlite } from "@electric-sql/pglite";

// Outbox flusher: sends local mutations to /api/mutations in order. It never
// blocks the UI; failures just leave rows pending and retry with backoff.

const BATCH_SIZE = 20;
const TICK_MS = 5000;
const ECHO_TIMEOUT_MS = 30_000;
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

interface OutboxRow {
  mutation_id: string;
  entity: string;
  op: string;
  payload: unknown;
}

interface MutationResult {
  mutationId: string;
  status: "applied" | "rejected";
  reason?: string | null;
  retryable?: boolean;
}

export interface FlusherDeps {
  fetchFn?: typeof fetch;
  origin?: string;
  now?: () => number;
  // Refetch every shape from scratch (the echo never arrived).
  refetch?: () => Promise<void>;
}

export function createFlusher(pg: PGlite, deps: FlusherDeps = {}) {
  const fetchFn = deps.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const origin = deps.origin ?? globalThis.location.origin;
  const now = deps.now ?? Date.now;

  let flushing = false;
  let again = false;
  let failures = 0;
  let notBefore = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  // Applied mutations waiting for their echo through the changes feed.
  const awaitingEcho = new Map<string, number>();

  const isPaused = async () =>
    (await pg.query<{ value: string }>("SELECT value FROM local_settings WHERE key = 'sync_paused'")).rows[0]?.value === "true";

  function backoff(minimumMs = 0) {
    const base = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)] ?? 30_000;
    notBefore = now() + Math.max(minimumMs, base * (0.75 + Math.random() * 0.5));
  }

  async function post(path: string, body: unknown): Promise<Response> {
    return fetchFn(`${origin}${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // The server issues the session cookie and assigns the display name.
  async function ensureRegistered(): Promise<boolean> {
    const { rows } = await pg.query<{ client_id: string; base_name: string; registered_base: string | null }>(
      "SELECT client_id, base_name, registered_base FROM profile LIMIT 1"
    );
    const profile = rows[0];
    if (!profile) return false;
    if (profile.registered_base === profile.base_name) return true;
    const response = await post("/api/session", { clientId: profile.client_id, baseName: profile.base_name });
    if (!response.ok) throw new Error(`session ${response.status}`);
    const { displayName } = (await response.json()) as { displayName: string };
    await pg.query(
      "UPDATE profile SET registered_base = $2, name = $3 WHERE client_id = $1 AND base_name = $2",
      [profile.client_id, profile.base_name, displayName]
    );
    return true;
  }

  const forgetRegistration = () => pg.exec("UPDATE profile SET registered_base = NULL");

  async function release(ids: string[]) {
    if (ids.length === 0) return;
    await pg.query("UPDATE outbox SET status = 'pending' WHERE mutation_id = ANY($1::uuid[]) AND status = 'inflight'", [ids]);
  }

  // Drops the optimistic overlay: the server's state wins.
  async function dropOverlay(db: Pick<PGlite, "query">, mutationId: string) {
    await db.query("DELETE FROM tables_local WHERE mutation_id = $1", [mutationId]);
    await db.query("DELETE FROM seat_claims_local WHERE mutation_id = $1", [mutationId]);
    await db.query("DELETE FROM rooms_local WHERE mutation_id = $1", [mutationId]);
  }

  async function settle(batch: OutboxRow[], results: MutationResult[]) {
    const byId = new Map(results.map((r) => [r.mutationId, r]));
    const retry: string[] = [];
    let reRegister = false;
    let wait = 0;

    for (const row of batch) {
      const result = byId.get(row.mutation_id);
      if (!result || result.retryable) {
        retry.push(row.mutation_id);
        if (result?.reason === "unknown_client") reRegister = true;
        if (result?.reason === "rate_limited") wait = 2000;
        continue;
      }
      if (result.status === "rejected") {
        await pg.transaction(async (tx) => {
          await dropOverlay(tx, row.mutation_id);
          const reason = result.reason ?? "invalid";
          await tx.query("UPDATE outbox SET status = 'rejected', reason = $2 WHERE mutation_id = $1", [row.mutation_id, reason]);
          await tx.query("INSERT INTO rejection_log (mutation_id, entity, op, reason) VALUES ($1, $2, $3, $4)", [
            row.mutation_id, row.entity, row.op, reason,
          ]);
          await tx.query("DELETE FROM rejection_log WHERE id NOT IN (SELECT id FROM rejection_log ORDER BY id DESC LIMIT 20)");
        });
      } else if (result.reason === "noop") {
        // Nothing changed on the server, so no echo will ever arrive.
        await pg.transaction(async (tx) => {
          await dropOverlay(tx, row.mutation_id);
          await tx.query("DELETE FROM outbox WHERE mutation_id = $1", [row.mutation_id]);
        });
      } else {
        awaitingEcho.set(row.mutation_id, now());
      }
    }

    await release(retry);
    if (reRegister) await forgetRegistration();
    if (retry.length > 0) backoff(wait);
    return retry.length === 0;
  }

  async function sendBatch(): Promise<"empty" | "ok" | "retry"> {
    const { rows: batch } = await pg.query<OutboxRow>(
      "SELECT mutation_id, entity, op, payload FROM outbox WHERE status = 'pending' ORDER BY created_at LIMIT $1",
      [BATCH_SIZE]
    );
    if (batch.length === 0) return "empty";
    const ids = batch.map((r) => r.mutation_id);
    await pg.query("UPDATE outbox SET status = 'inflight', attempts = attempts + 1 WHERE mutation_id = ANY($1::uuid[])", [ids]);

    let response: Response;
    try {
      response = await post(
        "/api/mutations",
        { mutations: batch.map((r) => ({ mutation_id: r.mutation_id, entity: r.entity, op: r.op, payload: r.payload })) }
      );
    } catch {
      await release(ids);
      backoff();
      return "retry";
    }

    if (response.status === 401) {
      await release(ids);
      await forgetRegistration();
      backoff();
      return "retry";
    }
    if (response.status === 400 || response.status === 413) {
      // The request itself is malformed: retrying can't help.
      await settle(batch, batch.map((r) => ({ mutationId: r.mutation_id, status: "rejected" as const, reason: "invalid" })));
      return "ok";
    }

    // 5xx may still carry the results that were applied before the failure.
    const body = (await response.json().catch(() => null)) as { results?: MutationResult[] } | null;
    const ok = await settle(batch, Array.isArray(body?.results) ? body.results : []);
    if (!response.ok && ok) backoff();
    return response.ok && ok ? "ok" : "retry";
  }

  // Applied mutations normally clear themselves when the echo arrives. If one
  // hasn't after 30 s, refetch the shapes and then settle it by hand.
  async function checkEchoes() {
    if (awaitingEcho.size === 0) return;
    const ids = [...awaitingEcho.keys()];
    const { rows } = await pg.query<{ mutation_id: string }>(
      "SELECT mutation_id FROM outbox WHERE mutation_id = ANY($1::uuid[])",
      [ids]
    );
    const stillThere = new Set(rows.map((r) => r.mutation_id));
    for (const id of ids) if (!stillThere.has(id)) awaitingEcho.delete(id);

    const overdue = [...awaitingEcho].filter(([, at]) => now() - at >= ECHO_TIMEOUT_MS).map(([id]) => id);
    if (overdue.length === 0) return;
    await deps.refetch?.();
    for (const id of overdue) {
      // Refetch put the server's truth in the synced tables; the overlay is obsolete.
      await dropOverlay(pg, id);
      await pg.query("DELETE FROM outbox WHERE mutation_id = $1", [id]);
      awaitingEcho.delete(id);
    }
  }

  async function flushOnce() {
    if (await isPaused()) return;
    await checkEchoes();
    if (now() < notBefore) return;
    try {
      if (!(await ensureRegistered())) return;
    } catch {
      backoff();
      return;
    }
    // Keep going until the outbox is empty or something needs a retry.
    for (;;) {
      const outcome = await sendBatch();
      if (outcome === "empty") {
        failures = 0;
        return;
      }
      if (outcome === "retry") return;
      failures = 0;
    }
  }

  async function flush() {
    if (flushing) {
      again = true;
      return;
    }
    flushing = true;
    try {
      do {
        again = false;
        await flushOnce();
      } while (again);
    } catch (error) {
      console.warn("[flusher] unexpected error", error);
      backoff();
    } finally {
      flushing = false;
    }
  }

  async function init() {
    await pg.listen("outbox", () => void flush());
    await pg.listen("settings", () => void flush());
    globalThis.addEventListener?.("online", () => {
      notBefore = 0;
      void flush();
    });
    timer = setInterval(() => void flush(), TICK_MS);
    void flush();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { init, stop, flush };
}
