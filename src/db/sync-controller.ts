import type { PGlite } from "@electric-sql/pglite";
import { RealtimeClient } from "@supabase/realtime-js";

// Read path. Supabase Realtime Broadcast is only a doorbell ("the newest
// version is N"); the data itself comes from GET /api/changes?since=<version>,
// applied to the *_synced tables. Missing a ping costs nothing: a slow poll
// runs underneath, and after any gap the feed simply continues from the last
// version we applied (deletions are tombstones, so nothing is lost).

const POLL_WITH_SOCKET_MS = 5000;
const POLL_WITHOUT_SOCKET_MS = 2000;
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const FETCH_TIMEOUT_MS = 8000;
// A ping can arrive a moment before the CDN's view of the feed settles; look again.
const CATCH_UP_ATTEMPTS = 3;
const CATCH_UP_DELAY_MS = 300;

interface Changes {
  epoch: string;
  rev: number;
  rooms: Record<string, unknown>[];
  tables: Record<string, unknown>[];
  claims: Record<string, unknown>[];
  deleted: { entity: "room" | "table" | "seat_claim"; key: Record<string, unknown> }[];
}

const UPSERTS = {
  rooms: { table: "rooms_synced", columns: ["id", "is_locked", "updated_at", "last_mutation_id"], key: ["id"] },
  tables: {
    table: "tables_synced",
    columns: ["id", "room_id", "label", "shape", "pos_x", "pos_y", "seat_limit", "shape_radius", "shape_width", "shape_height", "updated_at", "last_mutation_id"],
    key: ["id"],
  },
  claims: {
    table: "seat_claims_synced",
    columns: ["table_id", "seat_index", "room_id", "owner_tag", "client_name", "claimed_at", "last_mutation_id"],
    key: ["table_id", "seat_index"],
  },
} as const;

function upsertSql({ table, columns, key }: (typeof UPSERTS)[keyof typeof UPSERTS]): string {
  const list = columns.join(", ");
  const updates = columns.filter((c) => !(key as readonly string[]).includes(c)).map((c) => `${c} = EXCLUDED.${c}`);
  return `INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)
    ON CONFLICT (${key.join(", ")}) DO UPDATE SET ${updates.join(", ")}`;
}

// A reset replaces the synced rows wholesale; the echo triggers must not
// mistake that for the server deleting rows (they would drop local tombstones).
async function clearSyncedTables(tx: Pick<PGlite, "exec">) {
  await tx.exec("SET LOCAL session_replication_role = replica");
  await tx.exec("DELETE FROM seat_claims_synced; DELETE FROM tables_synced; DELETE FROM rooms_synced");
  await tx.exec("SET LOCAL session_replication_role = origin");
}

export interface RealtimeConnection {
  close: () => void;
}

export interface SyncDeps {
  fetchFn?: typeof fetch;
  origin?: string;
  // Rings `onPing(version)` and reports the socket state; the default talks to Supabase.
  connectRealtime?: (onPing: (rev: number) => void, onState: (connected: boolean) => void) => RealtimeConnection | null;
}

function supabaseRealtime(onPing: (rev: number) => void, onState: (connected: boolean) => void): RealtimeConnection | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null; // polling only
  const client = new RealtimeClient(`${url}/realtime/v1`, { params: { apikey: anonKey } });
  client
    .channel("mesas", { config: { broadcast: { self: false } } })
    .on("broadcast", { event: "rev" }, (message: { payload?: { rev?: unknown } }) => {
      const rev = Number(message.payload?.rev);
      if (Number.isFinite(rev)) onPing(rev);
    })
    .subscribe((status: string) => onState(status === "SUBSCRIBED"));
  client.connect();
  return { close: () => void client.disconnect() };
}

export function createSyncController(pg: PGlite, deps: SyncDeps = {}) {
  const fetchFn = deps.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const origin = deps.origin ?? globalThis.location.origin;
  const connectRealtime = deps.connectRealtime ?? supabaseRealtime;

  let active = false;
  let pulling = false;
  let again = false;
  let wantedRev = 0; // newest version a doorbell announced
  let socketUp = false;
  let failures = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let realtime: RealtimeConnection | null = null;
  const lastStatus = new Map<string, string>();

  async function meta(key: string): Promise<string | null> {
    const { rows } = await pg.query<{ value: string }>("SELECT value FROM local_meta WHERE key = $1", [key]);
    return rows[0]?.value ?? null;
  }
  const setMeta = (key: string, value: string) =>
    pg.query("INSERT INTO local_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, value]);

  async function writeStatus(name: "changes" | "realtime", state: { upToDate?: boolean; reachable?: boolean; error?: string | null }) {
    const { rows } = await pg.query<{ up_to_date: boolean; reachable: boolean; error: string | null }>(
      "SELECT up_to_date, reachable, error FROM sync_status WHERE shape = $1",
      [name]
    );
    const current = rows[0];
    const next = {
      upToDate: state.upToDate ?? current?.up_to_date ?? false,
      reachable: state.reachable ?? current?.reachable ?? true,
      error: state.error === undefined ? (current?.error ?? null) : state.error,
    };
    const signature = JSON.stringify(next);
    if (lastStatus.get(name) === signature) return;
    lastStatus.set(name, signature);
    await pg.query(
      `INSERT INTO sync_status (shape, up_to_date, reachable, error, updated_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (shape) DO UPDATE SET up_to_date = $2, reachable = $3, error = $4, updated_at = now()`,
      [name, next.upToDate, next.reachable, next.error]
    );
  }

  async function fetchChanges(since: number, upto: number): Promise<Changes | "unavailable"> {
    // With a doorbell target the URL is unique to (since, upto), so every phone
    // shares one cache entry and none can be served an answer older than the ping.
    const query = upto > since ? `since=${since}&upto=${upto}` : `since=${since}`;
    try {
      const response = await fetchFn(`${origin}/api/changes?${query}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) {
        await writeStatus("changes", { upToDate: false, reachable: response.status < 500, error: `changes ${response.status}` });
        return "unavailable";
      }
      return (await response.json()) as Changes;
    } catch (error) {
      await writeStatus("changes", { upToDate: false, reachable: false, error: error instanceof Error ? error.message : String(error) });
      return "unavailable";
    }
  }

  async function apply(changes: Changes) {
    await pg.transaction(async (tx) => {
      for (const gone of changes.deleted) {
        if (gone.entity === "table") await tx.query("DELETE FROM tables_synced WHERE id = $1", [gone.key.id]);
        if (gone.entity === "seat_claim") {
          await tx.query("DELETE FROM seat_claims_synced WHERE table_id = $1 AND seat_index = $2", [gone.key.table_id, gone.key.seat_index]);
        }
      }
      // Tombstones first: a reset deletes and re-creates the same ids, and the new rows are newer.
      for (const [field, spec] of [["rooms", UPSERTS.rooms], ["tables", UPSERTS.tables], ["claims", UPSERTS.claims]] as const) {
        const rows = changes[field];
        if (rows.length > 0) await tx.query(upsertSql(spec), [JSON.stringify(rows)]);
      }
      await tx.query("INSERT INTO local_meta (key, value) VALUES ('rev', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [String(changes.rev)]);
    });
  }

  // Drops everything that came from the server and starts over from version 0.
  async function resetSyncState() {
    await pg.transaction(async (tx) => {
      await clearSyncedTables(tx);
      await tx.query("DELETE FROM local_meta WHERE key = 'rev'");
    });
  }

  // One round: fetch what is newer than what we hold and apply it.
  async function pullOnce(): Promise<"ok" | "failed"> {
    const since = Number((await meta("rev")) ?? 0);
    const result = await fetchChanges(since, wantedRev);
    if (result === "unavailable") return "failed";

    // A recreated or restored database restarts its versions: start over.
    const storedEpoch = await meta("epoch");
    if ((storedEpoch !== null && storedEpoch !== result.epoch) || result.rev < since) {
      await resetSyncState();
      await setMeta("epoch", result.epoch);
      return pullOnce();
    }
    if (storedEpoch === null) await setMeta("epoch", result.epoch);

    await apply(result);
    await writeStatus("changes", { upToDate: true, reachable: true, error: null });
    return "ok";
  }

  async function pull() {
    if (!active) return;
    if (pulling) {
      again = true;
      return;
    }
    pulling = true;
    if (pollTimer) clearTimeout(pollTimer);
    try {
      let attempts = 0;
      do {
        again = false;
        const outcome = await pullOnce();
        if (outcome === "failed") {
          schedule(RETRY_DELAYS_MS[Math.min(failures++, RETRY_DELAYS_MS.length - 1)] ?? 30_000);
          return;
        }
        failures = 0;
        const applied = Number((await meta("rev")) ?? 0);
        if (applied < wantedRev && attempts++ < CATCH_UP_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, CATCH_UP_DELAY_MS));
          again = true;
        }
      } while (again && active);
      schedule(socketUp ? POLL_WITH_SOCKET_MS : POLL_WITHOUT_SOCKET_MS);
    } catch (error) {
      console.warn("[sync] pull failed", error);
      await writeStatus("changes", { upToDate: false, error: error instanceof Error ? error.message : String(error) });
      schedule(RETRY_DELAYS_MS[Math.min(failures++, RETRY_DELAYS_MS.length - 1)] ?? 30_000);
    } finally {
      pulling = false;
    }
  }

  function schedule(delayMs: number) {
    if (!active) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => void pull(), delayMs);
  }

  function start() {
    if (active) return;
    active = true;
    failures = 0;
    realtime = connectRealtime(
      (rev) => {
        if (rev > wantedRev) wantedRev = rev;
        void pull();
      },
      (connected) => {
        socketUp = connected;
        void writeStatus("realtime", { upToDate: connected, reachable: connected, error: null });
        // Anything rung while the socket was down is picked up on (re)connect.
        if (connected) void pull();
      }
    );
    void pull();
  }

  function stop() {
    active = false;
    socketUp = false;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    realtime?.close();
    realtime = null;
  }

  async function isPaused() {
    const { rows } = await pg.query<{ value: string }>("SELECT value FROM local_settings WHERE key = 'sync_paused'");
    return rows[0]?.value === "true";
  }

  async function applySettings() {
    if (await isPaused()) {
      stop();
      await writeStatus("changes", { upToDate: false });
      await writeStatus("realtime", { upToDate: false });
    } else {
      start();
    }
  }

  // The echo never arrived (or something looks wrong): refetch everything.
  async function refetch() {
    stop();
    await resetSyncState();
    await applySettings();
  }

  async function init() {
    await pg.listen("settings", () => void applySettings());
    globalThis.addEventListener?.("online", () => {
      if (active) void pull();
    });
    await applySettings();
  }

  return { init, stop, refetch, pull };
}
