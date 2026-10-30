import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLocalMigrations } from "./migrate";
import { createSyncController, type RealtimeConnection } from "./sync-controller";

const ROOM = "r";
const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";

// A tiny stand-in for /api/changes: keeps rows with versions and tombstones.
class FakeServer {
  rev = 0;
  epoch = "epoch-1";
  tables = new Map<string, Record<string, unknown> & { rev: number }>();
  claims = new Map<string, Record<string, unknown> & { rev: number }>();
  deleted: { rev: number; entity: string; key: Record<string, unknown> }[] = [];
  requests: string[] = [];
  down = false;

  setTable(id: string, patch: Record<string, unknown> = {}) {
    const row = { id, room_id: ROOM, label: id.slice(-2), shape: "circular", pos_x: 140, pos_y: 120, seat_limit: 8, shape_radius: 60, shape_width: null, shape_height: null, updated_at: null, last_mutation_id: null, ...this.tables.get(id), ...patch, rev: ++this.rev };
    this.tables.set(id, row);
  }
  setClaim(tableId: string, seat: number, patch: Record<string, unknown> = {}) {
    this.claims.set(`${tableId}:${seat}`, { table_id: tableId, seat_index: seat, room_id: ROOM, owner_tag: "abc", client_name: "TapirMenta", claimed_at: null, last_mutation_id: null, ...patch, rev: ++this.rev });
  }
  removeClaim(tableId: string, seat: number) {
    this.claims.delete(`${tableId}:${seat}`);
    this.deleted.push({ rev: ++this.rev, entity: "seat_claim", key: { table_id: tableId, seat_index: seat } });
  }
  removeTable(id: string) {
    this.tables.delete(id);
    this.deleted.push({ rev: ++this.rev, entity: "table", key: { id } });
  }

  fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(String(input));
    this.requests.push(url.pathname + url.search);
    if (this.down) throw new TypeError("network down");
    const since = Number(url.searchParams.get("since"));
    const strip = ({ rev: _rev, ...row }: Record<string, unknown>) => row;
    const newer = (r: { rev: number }) => r.rev > since;
    const t = [...this.tables.values()].filter(newer);
    const c = [...this.claims.values()].filter(newer);
    const d = this.deleted.filter(newer);
    // Like the real feed: the head version, never clamped to what the client holds.
    const rev = Math.max(0, ...this.tables.values().map((r) => r.rev), ...this.claims.values().map((r) => r.rev), ...this.deleted.map((r) => r.rev));
    return Response.json({
      epoch: this.epoch,
      rev,
      rooms: since === 0 ? [{ id: ROOM, is_locked: false, updated_at: null, last_mutation_id: null }] : [],
      tables: t.map(strip),
      claims: c.map(strip),
      deleted: d.map(({ entity, key }) => ({ entity, key })),
    });
  };
}

let pg: PGlite;
let server: FakeServer;
let ring: (rev: number) => void;
let socket: (connected: boolean) => void;
let closed: boolean;
let controllers: ReturnType<typeof createSyncController>[];

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 4000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function controller() {
  const c = createSyncController(pg, {
    origin: "http://x",
    fetchFn: ((input: RequestInfo | URL) => server.fetch(input)) as typeof fetch,
    connectRealtime: (onPing, onState): RealtimeConnection => {
      ring = onPing;
      socket = onState;
      closed = false;
      return { close: () => (closed = true) };
    },
  });
  controllers.push(c);
  return c;
}

const tableCount = async () => (await pg.query<{ n: number }>("SELECT count(*)::int AS n FROM tables_synced")).rows[0]?.n ?? 0;
const meta = async (key: string) => (await pg.query<{ value: string }>("SELECT value FROM local_meta WHERE key = $1", [key])).rows[0]?.value;
const status = async (name: string) => (await pg.query<{ up_to_date: boolean; reachable: boolean; error: string | null }>("SELECT up_to_date, reachable, error FROM sync_status WHERE shape = $1", [name])).rows[0];

beforeEach(async () => {
  pg = await PGlite.create();
  await runLocalMigrations(pg);
  server = new FakeServer();
  controllers = [];
  server.setTable(T1);
  server.setTable(T2, { shape: "rectangular", shape_radius: null, shape_width: 200, shape_height: 80, pos_x: 500 });
});

afterEach(() => controllers.forEach((c) => c.stop()));

describe("changes feed sync", () => {
  it("loads the snapshot on start and remembers the version", async () => {
    await controller().init();
    await waitFor(tableCount, (n) => n === 2);
    expect(server.requests[0]).toBe("/api/changes?since=0");
    expect(await meta("rev")).toBe(String(server.rev));
    expect(await meta("epoch")).toBe("epoch-1");
    expect((await pg.query("SELECT * FROM rooms_synced")).rows).toHaveLength(1);
    await waitFor(() => status("changes"), (s) => s?.up_to_date === true);
  });

  it("continues from the last version, applying updates, new rows and tombstones", async () => {
    const c = controller();
    await c.init();
    await waitFor(tableCount, (n) => n === 2);
    server.setClaim(T1, 3);
    server.setTable(T1, { pos_x: 260 });
    server.removeTable(T2);
    await c.pull();
    await waitFor(tableCount, (n) => n === 1);
    expect(server.requests.at(-1)).toMatch(/since=\d+$/);
    expect((await pg.query<{ pos_x: number }>("SELECT pos_x FROM tables_synced")).rows[0]?.pos_x).toBe(260);
    expect((await pg.query("SELECT * FROM seat_claims_synced")).rows).toHaveLength(1);

    server.removeClaim(T1, 3);
    await c.pull();
    await waitFor(async () => (await pg.query("SELECT * FROM seat_claims_synced")).rows.length, (n) => n === 0);
  });

  it("a doorbell fetches immediately with a cache key that no earlier answer can match", async () => {
    await controller().init();
    await waitFor(tableCount, (n) => n === 2);
    server.setTable(T1, { pos_x: 300 });
    ring(server.rev);
    await waitFor(async () => (await pg.query<{ pos_x: number }>("SELECT pos_x FROM tables_synced WHERE id = $1", [T1])).rows[0]?.pos_x, (x) => x === 300);
    expect(server.requests.some((r) => new RegExp(`since=\\d+&upto=${server.rev}$`).test(r))).toBe(true);
  });

  it("ignores a doorbell for a version it already has", async () => {
    await controller().init();
    await waitFor(tableCount, (n) => n === 2);
    const before = server.requests.length;
    ring(server.rev); // announces the version we just applied
    await new Promise((r) => setTimeout(r, 200));
    // It may fetch once to confirm, but never with an upto beyond what it holds.
    expect(server.requests.slice(before).every((r) => !r.includes("upto"))).toBe(true);
  });

  it("clears the optimistic overlay when the feed delivers our mutation's row", async () => {
    await pg.exec(`INSERT INTO profile (client_id, name, base_name, is_admin) VALUES (gen_random_uuid(), 'Admin', 'Admin', true)`);
    const c = controller();
    await c.init();
    await waitFor(tableCount, (n) => n === 2);
    await pg.exec(`UPDATE floor_tables SET pos_x = 400 WHERE id = '${T1}'`);
    const mutationId = (await pg.query<{ mutation_id: string }>("SELECT mutation_id FROM tables_local")).rows[0]?.mutation_id;
    expect((await pg.query("SELECT * FROM outbox")).rows).toHaveLength(1);
    server.setTable(T1, { pos_x: 400, last_mutation_id: mutationId });
    await c.pull();
    await waitFor(async () => (await pg.query("SELECT * FROM tables_local")).rows.length, (n) => n === 0);
    expect((await pg.query("SELECT * FROM outbox")).rows).toHaveLength(0);
  });

  it("starts over when the database was recreated (different epoch)", async () => {
    const c = controller();
    await c.init();
    await waitFor(tableCount, (n) => n === 2);
    // The server is rebuilt: new cluster, versions restart low, one table survives.
    server = Object.assign(new FakeServer(), { epoch: "epoch-2" });
    server.setTable(T1, { label: "Nueva" });
    await c.pull();
    await waitFor(tableCount, (n) => n === 1);
    expect(await meta("epoch")).toBe("epoch-2");
    expect(await meta("rev")).toBe(String(server.rev));
    expect((await pg.query<{ label: string }>("SELECT label FROM tables_synced")).rows[0]?.label).toBe("Nueva");
  });

  it("starts over when versions go backwards even if the epoch is unchanged", async () => {
    const c = controller();
    await c.init();
    await waitFor(tableCount, (n) => n === 2);
    const restored = new FakeServer();
    restored.setTable(T1, { label: "Restaurada" });
    server.fetch = restored.fetch;
    await c.pull();
    await waitFor(tableCount, (n) => n === 1);
    expect((await pg.query<{ label: string }>("SELECT label FROM tables_synced")).rows[0]?.label).toBe("Restaurada");
  });

  it("keeps local tombstones when the synced rows are replaced", async () => {
    await pg.exec(`INSERT INTO profile (client_id, name, base_name, is_admin) VALUES (gen_random_uuid(), 'Admin', 'Admin', true)`);
    const c = controller();
    await c.init();
    await waitFor(tableCount, (n) => n === 2);
    await pg.exec(`DELETE FROM floor_tables WHERE id = '${T2}'`);
    await c.refetch();
    await waitFor(tableCount, (n) => n === 2);
    expect((await pg.query("SELECT * FROM tables_local WHERE is_deleted")).rows).toHaveLength(1);
  });

  it("reports an unreachable server without losing data, and recovers", async () => {
    const c = controller();
    await c.init();
    await waitFor(tableCount, (n) => n === 2);
    server.down = true;
    ring(server.rev + 1);
    await waitFor(() => status("changes"), (s) => s?.reachable === false);
    expect(await tableCount()).toBe(2);
    server.down = false;
    server.setTable(T1, { pos_x: 380 });
    await waitFor(() => status("changes"), (s) => s?.reachable === true && s.up_to_date === true, 6000);
  });

  it("tracks the doorbell socket separately from the feed", async () => {
    await controller().init();
    await waitFor(tableCount, (n) => n === 2);
    socket(true);
    await waitFor(() => status("realtime"), (s) => s?.up_to_date === true);
    socket(false);
    await waitFor(() => status("realtime"), (s) => s?.up_to_date === false);
    // The feed itself is still healthy: polling covers a dead socket.
    expect((await status("changes"))?.up_to_date).toBe(true);
  });

  it("does nothing while paused and resumes on unpause", async () => {
    await pg.exec("UPDATE local_settings SET value = 'true' WHERE key = 'sync_paused'");
    await controller().init();
    await new Promise((r) => setTimeout(r, 200));
    expect(server.requests).toHaveLength(0);
    expect(closed ?? true).toBe(true);
    await pg.exec("UPDATE local_settings SET value = 'false' WHERE key = 'sync_paused'");
    await waitFor(tableCount, (n) => n === 2);
  });
});
