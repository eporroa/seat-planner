import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { serverEnv } from "@/server/env";
import { passcodeMatches, readClientId, setAdminCookie } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({ passcode: z.string().max(200) });

// Best-effort brute-force guard (per warm instance; the passcode is the real defense).
const attempts = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

function tooManyAttempts(clientId: string): boolean {
  const now = Date.now();
  const entry = attempts.get(clientId);
  if (!entry || entry.resetAt < now) {
    attempts.set(clientId, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

// ?isAdmin=true in the URL only reveals the passcode field. Admin powers
// exist only once this route verifies the passcode and signs a cookie bound
// to the attendee's session.
export async function POST(req: NextRequest) {
  const clientId = readClientId(req);
  if (!clientId) return NextResponse.json({ error: "no_session" }, { status: 401 });

  let json: unknown;
  try {
    json = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const body = bodySchema.safeParse(json);
  if (!body.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const expected = serverEnv().DEMO_ADMIN_PASSCODE;
  if (expected === "") {
    // An empty passcode is a local-dev convenience; it must never open production.
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "admin_disabled" }, { status: 503 });
    }
  } else {
    if (tooManyAttempts(clientId)) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
    if (!passcodeMatches(body.data.passcode, expected)) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return NextResponse.json({ error: "wrong_passcode" }, { status: 401 });
    }
  }

  const res = NextResponse.json({ ok: true });
  setAdminCookie(req, res, clientId);
  return res;
}
