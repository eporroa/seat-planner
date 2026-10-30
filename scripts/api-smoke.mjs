// End-to-end checks for /api/session, /api/admin/session and /api/mutations.
//   BASE_URL=http://localhost:3100 ADMIN_PASSCODE=<the server's DEMO_ADMIN_PASSCODE> pnpm test:api
import { createHash, randomUUID } from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
// Must match DEMO_ADMIN_PASSCODE on the server under test (empty works with an empty one, outside production).
const PASSCODE = process.env.ADMIN_PASSCODE ?? "";
const T1 = "00000000-0000-4000-8000-000000000001";
const T2 = "00000000-0000-4000-8000-000000000002";

let failed = 0;
function check(label, cond, detail) {
  if (cond) console.log(`ok   - ${label}`);
  else {
    failed++;
    console.log(`FAIL - ${label}`, detail === undefined ? "" : JSON.stringify(detail));
  }
}

class Client {
  cookies = new Map();
  async call(path, body, { raw, headers } = {}) {
    const res = await fetch(BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "), ...headers },
      body: raw ?? JSON.stringify(body),
    });
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      this.cookies.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return { status: res.status, json: await res.json().catch(() => null), headers: res.headers };
  }
  mutate(entity, op, payload) {
    return this.call("/api/mutations", { mutations: [{ mutation_id: randomUUID(), entity, op, payload }] });
  }
  async result(entity, op, payload) {
    const r = await this.mutate(entity, op, payload);
    return r.json?.results?.[0] ?? { httpStatus: r.status, ...r.json };
  }
}

async function register(base) {
  const c = new Client();
  const clientId = randomUUID();
  const r = await c.call("/api/session", { clientId, baseName: base });
  return { c, clientId, r };
}

// ---- changes feed (read path)
const feedRes = await fetch(BASE + "/api/changes?since=0");
const feed = await feedRes.json().catch(() => null);
check("changes since=0 returns the whole room", feedRes.status === 200 && feed?.tables?.length === 12 && feed?.rooms?.length === 1, { status: feedRes.status, tables: feed?.tables?.length });
check("changes carry a head version and the epoch", Number.isInteger(feed?.rev) && feed.rev > 0 && /^\d+$/.test(feed?.epoch ?? ""), feed && { rev: feed.rev, epoch: feed.epoch });
// Behind Vercel the CDN consumes s-maxage and clients see only max-age=0, so there the
// proof is behavioral: a repeat of the same URL within a second is served from the cache.
const cacheControl = feedRes.headers.get("cache-control") ?? "";
if (feedRes.headers.has("x-vercel-cache")) {
  // The first response may still be storing when the repeat arrives: a few repeats, any HIT proves it.
  const key = `${BASE}/api/changes?since=0&upto=${Date.now()}`;
  await fetch(key);
  let seen = [];
  for (let i = 0; i < 4 && !seen.includes("HIT"); i++) seen.push((await fetch(key)).headers.get("x-vercel-cache"));
  check("changes are CDN-cacheable for about a second (a repeat is a cache HIT)", seen.includes("HIT"), seen);
} else {
  check("changes are CDN-cacheable for about a second", /s-maxage=1(?!\d)/.test(cacheControl), cacheControl);
}
check("changes never expose client_id or internal versions", !JSON.stringify(feed).includes("client_id") && !("rev" in (feed?.tables?.[0] ?? {})));
const feedLater = await (await fetch(BASE + `/api/changes?since=${feed?.rev}&upto=${(feed?.rev ?? 0) + 1}`)).json();
check("nothing is newer than the head, and upto is only a cache key", feedLater.tables.length === 0 && feedLater.claims.length === 0 && feedLater.rev === feed.rev, feedLater);
check("a bad since is refused", (await fetch(BASE + "/api/changes?since=-1")).status === 400 && (await fetch(BASE + "/api/changes?since=abc")).status === 400);
check("the room cannot be chosen by the client", (await (await fetch(BASE + "/api/changes?since=0&room=other&room_id=other")).json()).tables.length === 12);

// ---- session
const anon = new Client();
check("mutations without a session → 401", (await anon.mutate("room", "reset", {})).status === 401);
check("admin session without a session → 401", (await anon.call("/api/admin/session", { passcode: PASSCODE })).status === 401);
check("free-text names are refused", (await anon.call("/api/session", { clientId: randomUUID(), baseName: "<script>alert(1)</script>" })).status === 400);
check("unknown extra fields are refused", (await anon.call("/api/session", { clientId: randomUUID(), baseName: "JaguarCoral", isAdmin: true })).status === 400);

const a = await register("JaguarCoral");
check("session returns a display name", a.r.status === 200 && /^JaguarCoral\d*$/.test(a.r.json?.displayName ?? ""), a.r.json);
const cookie = a.r.headers.get("set-cookie") ?? "";
check("session cookie is httpOnly + SameSite=Lax", /httponly/i.test(cookie) && /samesite=lax/i.test(cookie), cookie);
const b = await register("JaguarCoral");
check("duplicate base names get the next number", b.r.json?.displayName !== a.r.json?.displayName, [a.r.json, b.r.json]);

// ---- forged cookies
const forged = new Client();
forged.cookies.set("demo_client", Buffer.from(JSON.stringify({ v: 1, kind: "client", clientId: a.clientId, exp: 9999999999 })).toString("base64url") + ".AAAA");
check("forged session cookie → 401", (await forged.mutate("seat_claim", "insert", { table_id: T1, seat_index: 1 })).status === 401);

// ---- seats
const free = 1 + Math.floor(Math.random() * 8);
check("claim a seat", (await a.c.result("seat_claim", "insert", { table_id: T1, seat_index: free })).status === "applied");
const taken = await b.c.result("seat_claim", "insert", { table_id: T1, seat_index: free });
check("same seat from another client → seat_taken", taken.status === "rejected" && taken.reason === "seat_taken", taken);

// ---- attendees can't do admin things by calling the API by hand
for (const [label, entity, op, payload] of [
  ["delete a table", "table", "delete", { id: T2 }],
  ["resize a table", "table", "update", { id: T2, shape_width: 240 }],
  ["rename a table", "table", "update", { id: T2, label: "Hackeada" }],
  ["decrease chairs", "table", "update", { id: T2, seat_limit: 4 }],
  ["lock the layout", "room", "update", { is_locked: true }],
  ["reset the demo", "room", "reset", {}],
]) {
  const r = await b.c.result(entity, op, payload);
  check(`attendee cannot ${label} (forbidden)`, r.status === "rejected" && r.reason === "forbidden", r);
}

// ---- ?isAdmin=true without the passcode gives nothing
const wrong = await b.c.call("/api/admin/session", { passcode: "nope" });
check("wrong passcode → 401 and no admin cookie", wrong.status === 401 && !b.c.cookies.has("demo_admin"), wrong.json);
const stillNo = await b.c.result("table", "delete", { id: T2 });
check("still forbidden after a wrong passcode", stillNo.reason === "forbidden", stillNo);

// ---- malformed input
const bad = await a.c.result("table", "update", { id: T2, pos_x: "abc" });
check("malformed payload → rejected invalid (not retried forever)", bad.status === "rejected" && bad.reason === "invalid", bad);
const extra = await a.c.result("table", "update", { id: T2, pos_x: 500, is_admin: true });
check("unknown payload field → invalid", extra.reason === "invalid", extra);
const nonGrid = await a.c.result("table", "update", { id: T2, pos_x: 505, pos_y: 140 });
check("off-grid move → invalid_grid", nonGrid.reason === "invalid_grid", nonGrid);
check("bad envelope → 400", (await a.c.call("/api/mutations", { mutations: [] })).status === 400);
check("missing mutation_id → 400", (await a.c.call("/api/mutations", { mutations: [{ entity: "room" }] })).status === 400);
check("more than 20 mutations → 400", (await a.c.call("/api/mutations", { mutations: Array.from({ length: 21 }, () => ({ mutation_id: randomUUID() })) })).status === 400);
check("body over 64 KB → 413", (await a.c.call("/api/mutations", null, { raw: JSON.stringify({ pad: "x".repeat(70_000) }) })).status === 413);
check("invalid JSON → 400", (await a.c.call("/api/mutations", null, { raw: "{nope" })).status === 400);

// ---- idempotent retry over HTTP
const replayId = randomUUID();
const replayBody = { mutations: [{ mutation_id: replayId, entity: "table", op: "update", payload: { id: T1, pos_x: 140, pos_y: 160 } }] };
const first = await a.c.call("/api/mutations", replayBody);
const second = await a.c.call("/api/mutations", replayBody);
check("retrying a mutation returns the same result", JSON.stringify(first.json) === JSON.stringify(second.json) && first.json?.results?.[0]?.status === "applied", [first.json, second.json]);

// ---- rate limit: results stop at the first retryable answer
const f = await register("PumaGris").then((x) => x.c);
let sawRateLimit = false;
for (let round = 0; round < 3 && !sawRateLimit; round++) {
  const r = await f.call("/api/mutations", { mutations: Array.from({ length: 20 }, () => ({ mutation_id: randomUUID(), entity: "seat_claim", op: "delete", payload: { table_id: T1, seat_index: 12 } })) });
  const last = r.json?.results?.at(-1);
  if (last?.reason === "rate_limited") {
    sawRateLimit = true;
    check("rate limit is retryable and stops the batch", last.retryable === true && last.status === "rejected", last);
  }
}
check("flooding eventually hits rate_limited", sawRateLimit);

// ---- concurrency: the per-room lock makes these race-free
const racers = await Promise.all(Array.from({ length: 12 }, () => register("TapirMenta")));
const claims = await Promise.all(racers.map((r) => r.c.result("seat_claim", "insert", { table_id: T2, seat_index: 3 })));
check("12 parallel claims of one seat → exactly one wins", claims.filter((r) => r.status === "applied").length === 1 && claims.filter((r) => r.reason === "seat_taken").length === 11, claims.map((r) => r.reason ?? r.status));

// ---- admin
const adm = (await register("OceloteAzul")).c;
check("admin passcode accepted", (await adm.call("/api/admin/session", { passcode: PASSCODE })).status === 200 && adm.cookies.has("demo_admin"));
check("admin locks the layout", (await adm.result("room", "update", { is_locked: true })).status === "applied");
const locked = await a.c.result("table", "update", { id: T1, pos_x: 140, pos_y: 120 });
check("attendee blocked while locked", locked.reason === "locked", locked);
check("attendee can still claim while locked", (await a.c.result("seat_claim", "delete", { table_id: T1, seat_index: free })).status === "applied");
check("admin unlocks", (await adm.result("room", "update", { is_locked: false })).status === "applied");

// two admins create a table on the same free spot at once: the room lock lets one win
const adm2 = (await register("LoboJade")).c;
await adm2.call("/api/admin/session", { passcode: PASSCODE });
const spot = { label: "Carrera", shape: "circular", pos_x: 1140, pos_y: 300, seat_limit: 4, shape_radius: 40, shape_width: null, shape_height: null };
const raced = await Promise.all([
  adm.result("table", "insert", { id: randomUUID(), ...spot }),
  adm2.result("table", "insert", { id: randomUUID(), ...spot }),
]);
const raceOutcome = raced.map((r) => r.reason ?? r.status).sort();
check("two tables created on one free spot at once → exactly one wins", raceOutcome.join() === "applied,overlap", raceOutcome);

// admin cookie is bound to the session it was issued for
const thief = new Client();
thief.cookies.set("demo_client", b.c.cookies.get("demo_client"));
thief.cookies.set("demo_admin", adm.cookies.get("demo_admin"));
const stolen = await thief.result("table", "delete", { id: T2 });
check("admin cookie can't be replayed on another session", stolen.reason === "forbidden", stolen);

// ---- several chairs per person: attendees hold up to 20 (the oldest goes first), admins any number
const SIZES = { 1: 8, 2: 10, 3: 8, 4: 10, 5: 10, 6: 8, 7: 10, 8: 8, 9: 8, 10: 10, 11: 8, 12: 10 };
function* seatsFrom(first) {
  for (let n = first; n <= 12; n++) {
    for (let seat = 1; seat <= SIZES[n]; seat++) yield { table_id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, seat_index: seat };
  }
}
let cacheBust = 0;
// A unique `upto` is only a cache key: it keeps the CDN from answering with a second-old feed.
const freshFeed = async () => (await fetch(BASE + `/api/changes?since=0&upto=${Date.now()}${++cacheBust}`)).json();
const heldBy = async (clientId) => {
  const tag = createHash("md5").update(clientId).digest("hex");
  return (await freshFeed()).claims.filter((c) => c.owner_tag === tag);
};
const group = await register("LoboJade");
const picks = [...seatsFrom(3)].slice(0, 21);
for (const pick of picks.slice(0, 20)) await group.c.result("seat_claim", "insert", pick);
const heldNow = await heldBy(group.clientId);
check("an attendee can hold 20 chairs", heldNow.length === 20, { held: heldNow.length });
const twentyFirst = await group.c.result("seat_claim", "insert", picks[20]);
check("a 21st chair is accepted", twentyFirst.status === "applied", twentyFirst);
const afterTwentyFirst = await heldBy(group.clientId);
const isSeat = (claim, pick) => claim.table_id === pick.table_id && claim.seat_index === pick.seat_index;
check("still 20 chairs, the OLDEST was released and the newest is held",
  afterTwentyFirst.length === 20 && !afterTwentyFirst.some((c) => isSeat(c, picks[0])) && afterTwentyFirst.some((c) => isSeat(c, picks[20])) && afterTwentyFirst.some((c) => isSeat(c, picks[1])),
  { held: afterTwentyFirst.length, oldestStillHeld: afterTwentyFirst.some((c) => isSeat(c, picks[0])), newestHeld: afterTwentyFirst.some((c) => isSeat(c, picks[20])) });
const groupDeletes = (await freshFeed()).deleted;
check("the released chair left a tombstone for the other phones", groupDeletes.some((d) => d.entity === "seat_claim" && d.key.table_id === picks[0].table_id && d.key.seat_index === picks[0].seat_index));

const bigAdmin = await register("TapirMenta");
check("the second admin is accepted", (await bigAdmin.c.call("/api/admin/session", { passcode: PASSCODE })).status === 200);
for (const pick of [...seatsFrom(6)].slice(0, 25)) await bigAdmin.c.result("seat_claim", "insert", pick);
check("an admin can hold any number of chairs (25)", (await heldBy(bigAdmin.clientId)).length === 25);

check("admin resets the demo", (await adm.result("room", "reset", {})).status === "applied");

console.log(failed === 0 ? "\nAll API checks passed" : `\n${failed} API check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
