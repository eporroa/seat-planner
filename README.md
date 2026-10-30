# Seat Planner ("Mesas en vivo")

A local-first table and seat picker. It is the code behind the live demo of the talk
"Adiós a los Spinners: Frontend Local-First" (JSConf México 2026): hundreds of phones pick
chairs at the same time, and every read and write goes to a Postgres database **in the browser**
(PGlite). The network only syncs in the background, so nothing in the UI ever waits for it.

This is a copy meant to be downloaded, read and run. It contains no keys, no deployment and no
data: you bring your own Supabase project (and Vercel, if you want to host it). Everything below
works on your laptop with Docker and the Supabase CLI.

## Architecture

```
Browser tab(s)
 ├─ React 19 UI (main thread)
 │    ├─ useLiveQuery('SELECT … FROM floor_tables …')  → Konva canvas
 │    └─ db.query('UPDATE floor_tables SET pos_x=$1 …') → instant local write
 └─ PGliteWorker (leader tab only runs PGlite)
      ├─ PGlite ── opfs-ahp://mesas-en-vivo   (fallback idb://mesas-en-vivo)
      ├─ read path:  GET /api/changes?since=N  ◀── demo_changes()  ◀── Postgres (versioned rows + tombstones)
      │              Supabase Realtime Broadcast "doorbell" ── "newest version is N" (no row data)
      └─ write path: outbox flusher ──▶ POST /api/mutations ──▶ apply_mutation() ──▶ Postgres
```

Rules the code keeps: the UI talks only to local PGlite; ids are client-generated UUIDs;
Secrets never reach the client; the server is the arbiter of every conflict.

## How it works (the talk's four steps)

| Step | What happens | Where |
| --- | --- | --- |
| 1. Local write | A tap or drag is an `UPDATE`/`INSERT` on a view. `INSTEAD OF` triggers write an overlay row plus an outbox row in one transaction. | `src/db/actions.ts`, `src/db/migrations/001-init.ts`, `003-write-path.ts` |
| 2. OPFS | PGlite persists in the Origin Private File System (IndexedDB fallback), so reloads and restarts keep everything, including unsynced changes. | `src/db/pglite.worker.ts` |
| 3. Live query | The canvas renders from `useLiveQuery` on `floor_tables` and `floor_seat_claims`; the latency readout times write → next render. | `src/features/floorplan/use-floor.ts`, `src/db/latency.ts` |
| 4. Background sync | A Realtime Broadcast ping says "the newest version is N"; the phone fetches what is newer from `/api/changes` into the `*_synced` tables, and the flusher sends the outbox to the server. The row coming back clears the local overlay. | `src/db/sync-controller.ts`, `src/db/flusher.ts`, `src/app/api/changes/route.ts`, `src/app/api/mutations/route.ts` |

### The read path in one paragraph

Every row has a `rev` from one Postgres sequence and deletions leave tombstones, so
`demo_changes(room, since)` can answer "what is newer than version N" with one cheap query. A
deferred trigger rings a **public Broadcast channel** once per transaction with only the new
version (so no row data, and no `client_id`, ever travels over the socket). Phones answer the ping
by fetching `/api/changes?since=N&upto=M`; the URL is the same for every phone (so the CDN
collapses hundreds of fetches into one) and new for every ping (so it can never be a stale cached
answer). Underneath, a slow poll (5 s, or 2 s without the socket) covers a dead socket, and a
restored or recreated database is detected through the cluster epoch or a head version that went
backwards, which makes the phone start over from version 0.

Server side: `supabase/migrations/*.sql` holds the schema and `apply_mutation()`, which is the
only writer. It validates permissions, the grid rules (bounds, overlap, sizes) and idempotency in
one transaction per mutation. `supabase/tests/apply_mutation.sql` tests every rule.

Names are never typed: each person gets an animal + color in Spanish (`JaguarCoral`), and the
server appends the lowest free number on duplicates (`JaguarCoral2`).

## Run it locally

Requirements: Node 24, pnpm 12 (pinned through `packageManager`; use corepack), Docker, the
[Supabase CLI](https://supabase.com/docs/guides/cli).

```sh
corepack enable
pnpm install
supabase start          # local Postgres on 55322, API on 55321, Realtime on (see the note on ports below)
cp .env.example .env.local   # then fill it in (see below)
pnpm build && pnpm start -p 3100
```

Open http://localhost:3100. If the room is empty after the first start, run `pnpm db:reset`: it
re-applies the migrations and the seed (12 tables).

The Supabase ports are shifted by 1000 from the defaults (55321 instead of 54321, and so on) so this
project can run next to other local Supabase stacks. If you prefer the defaults, change them in
`supabase/config.toml`, and in `package.json` (`test:db`) and your `.env.local` to match.

Use the production build (as above) while testing: `next dev` currently gets stuck in a reload
loop on the app page.

Local `.env.local` values come from `supabase status -o env`: `SUPABASE_URL=http://127.0.0.1:55321`
and the service-role key (server only), `NEXT_PUBLIC_SUPABASE_URL` plus the **anon** key as
`NEXT_PUBLIC_SUPABASE_ANON_KEY` (public by design: it can only listen to the doorbell), and any
32+ character `SESSION_SECRET`.

Phones need HTTPS (OPFS and secure cookies), so to try it on a phone deploy it (below) or tunnel
your local server.

### Admin mode

Open `/?isAdmin=true`. The param only reveals a "Código de admin" field; the server checks the
passcode (`DEMO_ADMIN_PASSCODE`) and sets an 8-hour signed cookie. An empty passcode works only
outside production. Pick a long passcode: the URL is on a projector.

## Tests

```sh
pnpm typecheck
pnpm test        # vitest: grid rules, local triggers, echo cleanup, flusher, admin ops
pnpm test:db     # SQL rules of apply_mutation and the changes feed (needs `supabase start`)
pnpm test:api    # HTTP checks against a running server: BASE_URL and ADMIN_PASSCODE (= its DEMO_ADMIN_PASSCODE)
pnpm test:load   # crowd: CLIENTS=300 BASE_URL=https://… [SUPABASE_URL=… SUPABASE_ANON_KEY=… holds a Realtime socket per client] [ADMIN_PASSCODE=… resets the room]
pnpm build       # also runs scripts/check-bundle.mjs: fails if a secret (anything but the anon key) is in the client bundle
```

## Deploy it yourself

These steps use your own Supabase and Vercel accounts.

1. **Supabase.** Create a project (pick the region closest to your Vercel functions). Run
   `supabase link --project-ref <ref>` then `supabase db push`, then run `supabase/seed.sql`.
   Logical replication is already on. Keep the service-role key server-side only.
2. **Realtime.** Nothing to set up: Supabase Realtime is on by default, and the doorbell is a *public*
   Broadcast channel (`realtime.send(..., private := false)`). If you disabled "Allow public access"
   in the project's Realtime settings, enable it again. The Free plan allows 200 concurrent Realtime
   connections and Pro 500, so a room of more than ~200 phones needs Pro; past the limit phones
   just fall back to polling every 2 s.
3. **Vercel.** Import the repo and set the environment variables below for Production. Use the
   default Node.js runtime. Deploy, then open `/debug` on a phone and a laptop: both rows under
   "Sync" should say `upToDate=true`.

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public: the browser uses them only to listen to the doorbell channel |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Used only by server routes |
| `DEMO_ROOM_ID` | Any id; the seed uses `jsconf-mx-2026` (see `supabase/seed.sql`) |
| `DEMO_ADMIN_PASSCODE` | Admin passcode (required in production) |
| `SESSION_SECRET` | HMAC key for cookies, 32+ characters (`openssl rand -base64 48`) |
| `NEXT_PUBLIC_APP_URL` | Public URL shown on `/qr` |

No secret may use the `NEXT_PUBLIC_` prefix. The build fails if any JWT other than the anon key ends
up in the client bundle.

## Operating notes

- **Reset the room:** use the admin "Restablecer demo" button. It clears claims and
  restores the layout for everyone.
- **Recreating or restoring the database** changes its epoch (and versions restart low); phones
  notice on their next fetch and start over from version 0 instead of silently stalling.
- **"Simular sin red"** pauses sync and the flusher from the header (DevTools "Offline" does not
  reliably affect requests made from a worker). Resuming drains the outbox in order.
- **Realtime connection cap:** past the project's limit (`ConnectionRateLimitReached: Too many
  connected users`) extra phones simply poll every 2 s instead of getting a ping: they still sync,
  just in ~1-2 s rather than ~200 ms. On the hosted test project the cap showed up at roughly 250
  sockets; check the plan before a big room. `pnpm test:load` with `SUPABASE_URL` and
  `SUPABASE_ANON_KEY` reports how many sockets joined and why the others did not. Let a previous
  run's sockets time out (about a minute) before rerunning, or they count against the cap.
- **Safari and OPFS:** Safari can refuse OPFS sync access handles ("UnknownError: Invalid platform
  file handle"). PGlite's OPFS backend opens its files inside promise executors, so `create()` never
  settles and the error only appears as an unhandled rejection; `src/db/storage.ts` listens for
  that and falls back to IndexedDB at once instead of hanging. Two test switches on any page
  reproduce this without a Safari: `?storage=idb` skips OPFS, and `?storage=opfs-broken` makes it
  fail exactly like Safari does. `/debug` shows which backend is in use. IndexedDB starts slower
  (about 4 s to the floor and 8 s to full data on a laptop).
- **`/debug`** shows the storage backend, leader tab, the state of the changes feed and of the
  Realtime socket, the resume position (epoch and version), the outbox and the last 20 server
  rejections.

## Make it yours

- **Names:** attendees never type a name; `src/shared/names.ts` holds the animals and colors.
- **Layout:** the room size, table limits and the 20-chair limit are in `src/shared/room.ts`. The
  SQL in `supabase/migrations/` repeats these numbers (the server is the final judge), so change
  both sides together; `pnpm test` and `pnpm test:db` exercise each side.
- **Seed:** the starting tables come from `demo_seed_tables()` in the first migration, called by
  `supabase/seed.sql`; `src/shared/seed.ts` mirrors them for the tests.
- **Copy:** the interface text is in Spanish (es-MX); search for it in `src/features/`.

## License

[MIT](LICENSE) © 2026 Erik Porroa. Use it, change it, share it.
