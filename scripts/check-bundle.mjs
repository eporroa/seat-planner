// Fails the build if a secret ends up in anything shipped to the browser.
//   node scripts/check-bundle.mjs   (runs after `next build`)
// Secret values come from the build environment (process.env / .env.local);
// generic patterns catch keys even when their names are unknown here.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const SECRET_NAMES = ["SUPABASE_SERVICE_ROLE_KEY", "SESSION_SECRET", "DEMO_ADMIN_PASSCODE"];

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = { ...loadEnvFile(".env.local"), ...loadEnvFile(".env"), ...process.env };
// Short values (a 4-char dev passcode) would match everywhere; only check real secrets.
const secrets = SECRET_NAMES.map((name) => [name, env[name]]).filter(([, v]) => typeof v === "string" && v.length >= 8);

// The client bundle legitimately holds the Supabase *anon* key (public by design:
// it can only listen to the doorbell channel). Any other JWT is a leak.
const JWT = /eyJ[\w-]{10,}\.(eyJ[\w-]{10,})\.[\w-]{10,}/g;
const PATTERNS = [["Supabase secret key", /sb_secret_[\w-]{10,}/]];

function jwtRole(payload) {
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).role;
  } catch {
    return "unreadable";
  }
}

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(js|mjs|css|html|json|map|txt)$/.test(entry)) yield path;
  }
}

const roots = [".next/static"];
for (const root of roots) if (!existsSync(root)) throw new Error(`${root} not found: run next build first`);

const problems = [];
let scanned = 0;
for (const root of roots) {
  for (const file of files(root)) {
    scanned++;
    const text = readFileSync(file, "utf8");
    for (const [name, value] of secrets) if (text.includes(value)) problems.push(`${file}: contains the value of ${name}`);
    for (const [label, re] of PATTERNS) if (re.test(text)) problems.push(`${file}: matches ${label}`);
    for (const [, payload] of text.matchAll(JWT)) {
      const role = jwtRole(payload);
      if (role !== "anon") problems.push(`${file}: contains a JWT with role "${role}" (only the anon key may ship)`);
    }
  }
}

// Server-only variable names must not be inlined either.
const publicSecrets = Object.keys(env).filter((k) => k.startsWith("NEXT_PUBLIC_") && /SECRET|SERVICE_ROLE|PASSCODE|PASSWORD|TOKEN/.test(k));
for (const name of publicSecrets) problems.push(`${name}: secrets must not use the NEXT_PUBLIC_ prefix`);

if (problems.length > 0) {
  console.error(`Secret check FAILED (${scanned} files scanned):\n- ${problems.join("\n- ")}`);
  process.exit(1);
}
console.log(`Secret check passed: ${scanned} client files scanned, ${secrets.length} secret values checked.`);
