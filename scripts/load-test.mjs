// Simulates a crowd: each client registers, loads the changes feed, optionally
// joins the Realtime doorbell channel, then claims seats and re-reads the feed.
// Reports latency percentiles per endpoint.
//   BASE_URL=https://... CLIENTS=300 ADMIN_PASSCODE=... node scripts/load-test.mjs
// With SUPABASE_URL and SUPABASE_ANON_KEY set, every client also holds a Realtime
// socket (the 200/500 concurrent-connection limits only bite if you test this).
// With ADMIN_PASSCODE set, the room is reset at the end (claims cleared).
import { RealtimeClient } from "@supabase/realtime-js";
import { randomUUID } from "node:crypto";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const CLIENTS = Number(process.env.CLIENTS ?? 300);
const CLAIMS_PER_CLIENT = Number(process.env.CLAIMS ?? 3);
// Arrivals are spread over this window; a real room fills over minutes, not seconds.
const ARRIVAL_MS = Number(process.env.ARRIVAL_MS ?? 3000);
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE;
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const sockets = { joined: 0, failed: 0, pings: 0, clients: [], reasons: new Map() };
const TABLES = Array.from({ length: 12 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
const SEATS = { circ: 8, rect: 10 };

const samples = new Map(); // label -> ms[]
const statuses = new Map(); // label -> Map<status, count>
function record(label, ms, status) {
  (samples.get(label) ?? samples.set(label, []).get(label)).push(ms);
  const byStatus = statuses.get(label) ?? statuses.set(label, new Map()).get(label);
  byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
}

async function timed(label, url, init) {
  const start = performance.now();
  try {
    const res = await fetch(url, init);
    await res.arrayBuffer();
    record(label, performance.now() - start, res.status);
    return res;
  } catch (error) {
    record(label, performance.now() - start, "network");
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ANIMALS = ["Jaguar", "Tapir", "Puma", "Ocelote", "Lobo"];
const COLORS = ["Coral", "Menta", "Gris", "Azul", "Jade"];

async function client(index) {
  await sleep(Math.random() * ARRIVAL_MS);
  const clientId = randomUUID();
  const baseName = `${ANIMALS[index % 5]}${COLORS[Math.floor(index / 5) % 5]}`;
  const session = await timed("POST /api/session", `${BASE}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, baseName }),
  });
  const cookie = (session?.headers.getSetCookie() ?? []).map((c) => c.split(";")[0]).join("; ");

  const feed = await timed("GET /api/changes (initial)", `${BASE}/api/changes?since=0`);
  let rev = 0;
  try {
    rev = (await feed?.clone().json())?.rev ?? 0;
  } catch {}

  if (SUPABASE_URL && ANON_KEY) {
    const socket = new RealtimeClient(`${SUPABASE_URL}/realtime/v1`, { params: { apikey: ANON_KEY }, transport: WebSocket });
    sockets.clients.push(socket);
    socket
      .channel("mesas", { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "rev" }, () => sockets.pings++)
      .subscribe((status, error) => {
        if (status === "SUBSCRIBED") sockets.joined++;
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          sockets.failed++;
          const reason = `${status}: ${error?.message ?? error ?? "no detail"}`.slice(0, 160);
          sockets.reasons.set(reason, (sockets.reasons.get(reason) ?? 0) + 1);
        }
      });
    socket.connect();
  }

  for (let i = 0; i < CLAIMS_PER_CLIENT; i++) {
    await sleep(500 + Math.random() * 1500);
    // What a phone does after a doorbell: fetch what is new (shared cache key).
    await timed("GET /api/changes (after ping)", `${BASE}/api/changes?since=${rev}&upto=${rev + 1}`);
    const tableIndex = Math.floor(Math.random() * TABLES.length);
    const seats = tableIndex % 2 === 0 ? SEATS.circ : SEATS.rect;
    await timed("POST /api/mutations", `${BASE}/api/mutations`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        mutations: [
          {
            mutation_id: randomUUID(),
            entity: "seat_claim",
            op: "insert",
            payload: { table_id: TABLES[tableIndex], seat_index: 1 + Math.floor(Math.random() * seats) },
          },
        ],
      }),
    });
  }
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;

console.log(`Load test: ${CLIENTS} clients x ${CLAIMS_PER_CLIENT} claims against ${BASE} (arrivals over ${ARRIVAL_MS / 1000} s)`);
const started = performance.now();
await Promise.all(Array.from({ length: CLIENTS }, (_, i) => client(i)));
console.log(`Finished in ${((performance.now() - started) / 1000).toFixed(1)} s\n`);
if (SUPABASE_URL && ANON_KEY) {
  await sleep(1500);
  console.log(`Realtime sockets: ${sockets.joined}/${CLIENTS} joined, ${sockets.failed} failed, ${sockets.pings} pings received`);
  for (const [reason, n] of sockets.reasons) console.log(`  ${n}x ${reason}`);
  if (sockets.joined < CLIENTS) console.log("  (fewer joined than clients: check the plan's concurrent-connection limit)");
  // Close cleanly and give the close frames time to leave: dangling sockets count against
  // the project's concurrent-connection limit until the server times them out.
  sockets.clients.forEach((c) => c.disconnect());
  await sleep(2000);
  console.log();
}

let failed = false;
for (const [label, values] of [...samples].sort()) {
  const sorted = [...values].sort((a, b) => a - b);
  const codes = [...statuses.get(label)].map(([s, n]) => `${s}x${n}`).join(" ");
  console.log(`${label.padEnd(28)} n=${String(sorted.length).padStart(4)}  p50=${pct(sorted, 50).toFixed(0).padStart(5)} ms  p95=${pct(sorted, 95).toFixed(0).padStart(5)} ms  max=${sorted.at(-1).toFixed(0).padStart(5)} ms  [${codes}]`);
  const bad = [...statuses.get(label)].some(([s]) => s === "network" || (typeof s === "number" && s >= 500));
  if (bad) failed = true;
}
const socketsFailed = SUPABASE_URL && ANON_KEY && sockets.joined < CLIENTS;
if (socketsFailed) failed = true;
const mutationP95 = pct([...(samples.get("POST /api/mutations") ?? [0])].sort((a, b) => a - b), 95);
console.log(`\nTarget: /api/mutations p95 < 500 ms -> ${mutationP95 < 500 ? "PASS" : "FAIL"} (${mutationP95.toFixed(0)} ms)`);
if (mutationP95 >= 500) failed = true;

if (ADMIN_PASSCODE) {
  const admin = randomUUID();
  const s = await fetch(`${BASE}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId: admin, baseName: "JaguarJade" }) });
  const cookies = s.headers.getSetCookie().map((c) => c.split(";")[0]);
  const a = await fetch(`${BASE}/api/admin/session`, { method: "POST", headers: { "content-type": "application/json", cookie: cookies.join("; ") }, body: JSON.stringify({ passcode: ADMIN_PASSCODE }) });
  cookies.push(...a.headers.getSetCookie().map((c) => c.split(";")[0]));
  const r = await fetch(`${BASE}/api/mutations`, { method: "POST", headers: { "content-type": "application/json", cookie: cookies.join("; ") }, body: JSON.stringify({ mutations: [{ mutation_id: randomUUID(), entity: "room", op: "reset", payload: {} }] }) });
  console.log(`Room reset: ${r.status}`);
}
process.exit(failed ? 1 : 0);
