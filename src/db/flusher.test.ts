import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFlusher } from "./flusher";
import { runLocalMigrations } from "./migrate";

const T1 = "00000000-0000-4000-8000-000000000001";
const CLIENT = "11111111-1111-4111-8111-111111111111";

type Handler = (url: string, body: any) => Response | Promise<Response>;
const json = (body: unknown, status = 200) => Response.json(body, { status });

let pg: PGlite;
let clock: number;
let calls: { url: string; body: any }[];
let handler: Handler;
let refetch: ReturnType<typeof vi.fn<() => Promise<void>>>;

function flusher() {
  return createFlusher(pg, {
    origin: "http://x",
    now: () => clock,
    refetch,
    fetchFn: async (input, init) => {
      const url = String(input).replace("http://x", "");
      const body = JSON.parse(String(init?.body));
      calls.push({ url, body });
      return handler(url, body);
    },
  });
}

// Server that applies everything and registers the display name "JaguarCoral2".
const applyAll: Handler = (url, body) =>
  url === "/api/session"
    ? json({ displayName: "JaguarCoral2" })
    : json({ results: body.mutations.map((m: any) => ({ mutationId: m.mutation_id, status: "applied" })) });

const outbox = async () =>
  (await pg.query<{ mutation_id: string; status: string; reason: string | null }>(
    "SELECT mutation_id, status, reason FROM outbox ORDER BY created_at"
  )).rows;
const posX = async () => (await pg.query<{ pos_x: number }>("SELECT pos_x FROM floor_tables WHERE id = $1", [T1])).rows[0]?.pos_x;

beforeEach(async () => {
  pg = await PGlite.create();
  await runLocalMigrations(pg);
  await pg.exec(`INSERT INTO profile (client_id, name, base_name) VALUES ('${CLIENT}', 'JaguarCoral', 'JaguarCoral')`);
  await pg.exec(`INSERT INTO rooms_synced (id) VALUES ('r')`);
  await pg.exec(`INSERT INTO tables_synced (id, room_id, label, shape, pos_x, pos_y, seat_limit, shape_radius)
    VALUES ('${T1}', 'r', 'Mesa 1', 'circular', 140, 120, 4, 60)`);
  clock = 1_000_000;
  calls = [];
  handler = applyAll;
  refetch = vi.fn<() => Promise<void>>(async () => {});
});

describe("flusher", () => {
  it("registers once, adopts the server's display name, then sends in creation order", async () => {
    await pg.exec(`UPDATE floor_tables SET pos_x = 200 WHERE id = '${T1}'`);
    await pg.exec(`UPDATE floor_tables SET pos_x = 260 WHERE id = '${T1}'`);
    await pg.exec(`INSERT INTO floor_seat_claims (table_id, seat_index) VALUES ('${T1}', 1)`);
    await flusher().flush();

    expect(calls.map((c) => c.url)).toEqual(["/api/session", "/api/mutations"]);
    expect(calls[0]?.body).toEqual({ clientId: CLIENT, baseName: "JaguarCoral" });
    expect(calls[1]?.body.mutations.map((m: any) => `${m.entity}/${m.op}`)).toEqual(["table/update", "table/update", "seat_claim/insert"]);
    expect((await pg.query<{ name: string }>("SELECT name FROM profile")).rows[0]?.name).toBe("JaguarCoral2");

    // Applied rows wait for the echo from the changes feed (still inflight, overlay kept).
    expect((await outbox()).every((r) => r.status === "inflight")).toBe(true);
    expect(await posX()).toBe(260);

    await flusher().flush(); // nothing pending: no new session call
    expect(calls).toHaveLength(2);
  });

  it("does nothing while paused", async () => {
    await pg.exec(`UPDATE floor_tables SET pos_x = 200 WHERE id = '${T1}'`);
    await pg.exec("UPDATE local_settings SET value = 'true' WHERE key = 'sync_paused'");
    await flusher().flush();
    expect(calls).toHaveLength(0);
    expect((await outbox())[0]?.status).toBe("pending");
  });

  it("rolls back a rejected mutation and keeps the reason for the toast", async () => {
    await pg.exec(`INSERT INTO floor_seat_claims (table_id, seat_index) VALUES ('${T1}', 1)`);
    handler = (url, body) =>
      url === "/api/session"
        ? json({ displayName: "JaguarCoral" })
        : json({ results: [{ mutationId: body.mutations[0].mutation_id, status: "rejected", reason: "seat_taken" }] });
    await flusher().flush();

    expect((await pg.query("SELECT * FROM floor_seat_claims")).rows).toHaveLength(0);
    expect(await outbox()).toMatchObject([{ status: "rejected", reason: "seat_taken" }]);
  });

  it("a rejected move snaps the table back, but a newer local move survives", async () => {
    await pg.exec(`UPDATE floor_tables SET pos_x = 200 WHERE id = '${T1}'`);
    await pg.exec(`UPDATE floor_tables SET pos_x = 260 WHERE id = '${T1}'`);
    const [first] = await outbox();
    handler = (url, body) =>
      url === "/api/session"
        ? json({ displayName: "JaguarCoral" })
        : json({
            results: body.mutations.map((m: any) =>
              m.mutation_id === first?.mutation_id
                ? { mutationId: m.mutation_id, status: "rejected", reason: "overlap" }
                : { mutationId: m.mutation_id, status: "applied" }
            ),
          });
    await flusher().flush();
    // The first mutation's overlay was already replaced by the second one.
    expect(await posX()).toBe(260);
  });

  it("clears the overlay itself when the server says noop (no echo will come)", async () => {
    await pg.exec(`INSERT INTO floor_seat_claims (table_id, seat_index) VALUES ('${T1}', 1)`);
    handler = (url, body) =>
      url === "/api/session"
        ? json({ displayName: "JaguarCoral" })
        : json({ results: [{ mutationId: body.mutations[0].mutation_id, status: "applied", reason: "noop" }] });
    await flusher().flush();
    expect(await outbox()).toHaveLength(0);
    expect((await pg.query("SELECT * FROM seat_claims_local")).rows).toHaveLength(0);
  });

  it("returns rows to pending on network failure and retries after the backoff", async () => {
    await pg.exec(`UPDATE floor_tables SET pos_x = 200 WHERE id = '${T1}'`);
    let online = false;
    handler = (url, body) => {
      if (!online) throw new TypeError("network down");
      return applyAll(url, body);
    };
    const f = flusher();
    await f.flush();
    expect(calls).toHaveLength(1);

    await f.flush(); // still inside the backoff window: no new attempt
    expect(calls).toHaveLength(1);

    online = true;
    clock += 40_000;
    await f.flush();
    expect(await outbox()).toMatchObject([{ status: "inflight" }]);
  });

  it("keeps rows pending when the server is down (5xx without results)", async () => {
    await pg.exec(`UPDATE floor_tables SET pos_x = 200 WHERE id = '${T1}'`);
    handler = (url) => (url === "/api/session" ? json({ displayName: "JaguarCoral" }) : json({ error: "upstream_error" }, 502));
    await flusher().flush();
    expect(await outbox()).toMatchObject([{ status: "pending" }]);
    expect(await posX()).toBe(200);
  });

  it("treats rate_limited as retryable: nothing is rejected, later rows stay pending", async () => {
    await pg.exec(`UPDATE floor_tables SET pos_x = 200 WHERE id = '${T1}'`);
    await pg.exec(`UPDATE floor_tables SET pos_x = 260 WHERE id = '${T1}'`);
    handler = (url, body) =>
      url === "/api/session"
        ? json({ displayName: "JaguarCoral" })
        : json({ results: [{ mutationId: body.mutations[0].mutation_id, status: "rejected", reason: "rate_limited", retryable: true }] });
    await flusher().flush();
    expect((await outbox()).map((r) => r.status)).toEqual(["pending", "pending"]);
  });

  it("re-registers after a 401 and then succeeds", async () => {
    await pg.exec(`UPDATE floor_tables SET pos_x = 200 WHERE id = '${T1}'`);
    let first = true;
    handler = (url, body) => {
      if (url === "/api/mutations" && first) {
        first = false;
        return json({ error: "no_session" }, 401);
      }
      return applyAll(url, body);
    };
    const f = flusher();
    await f.flush();
    clock += 40_000;
    await f.flush();
    expect(calls.map((c) => c.url)).toEqual(["/api/session", "/api/mutations", "/api/session", "/api/mutations"]);
    expect(await outbox()).toMatchObject([{ status: "inflight" }]);
  });

  it("re-registers when a name change is made", async () => {
    await pg.exec(`UPDATE floor_tables SET pos_x = 200 WHERE id = '${T1}'`);
    const f = flusher();
    await f.flush();
    await pg.exec(`INSERT INTO profile (client_id, name, base_name) VALUES ('${CLIENT}', 'TapirMenta', 'TapirMenta')
      ON CONFLICT (client_id) DO UPDATE SET name = EXCLUDED.name, base_name = EXCLUDED.base_name`);
    await pg.exec(`UPDATE floor_tables SET pos_x = 260 WHERE id = '${T1}'`);
    await f.flush();
    expect(calls.filter((c) => c.url === "/api/session").map((c) => c.body.baseName)).toEqual(["JaguarCoral", "TapirMenta"]);
  });

  it("refetches and settles by hand when the echo never arrives", async () => {
    await pg.exec(`UPDATE floor_tables SET pos_x = 200 WHERE id = '${T1}'`);
    const f = flusher();
    await f.flush();
    expect(await outbox()).toHaveLength(1);

    clock += 31_000;
    await f.flush();
    expect(refetch).toHaveBeenCalledOnce();
    expect(await outbox()).toHaveLength(0);
    expect((await pg.query("SELECT * FROM tables_local")).rows).toHaveLength(0);
  });

  it("does not refetch when the echo arrives in time", async () => {
    await pg.exec(`UPDATE floor_tables SET pos_x = 200 WHERE id = '${T1}'`);
    const f = flusher();
    await f.flush();
    const [row] = await outbox();
    await pg.query("UPDATE tables_synced SET pos_x = 200, last_mutation_id = $1", [row?.mutation_id]);
    clock += 31_000;
    await f.flush();
    expect(refetch).not.toHaveBeenCalled();
    expect(await outbox()).toHaveLength(0);
  });

  it("answers a malformed-request 400 with a final rejection instead of looping", async () => {
    await pg.exec(`UPDATE floor_tables SET pos_x = 200 WHERE id = '${T1}'`);
    handler = (url) => (url === "/api/session" ? json({ displayName: "JaguarCoral" }) : json({ error: "invalid_body" }, 400));
    await flusher().flush();
    expect(await outbox()).toMatchObject([{ status: "rejected", reason: "invalid" }]);
    expect(await posX()).toBe(140);
  });
});
