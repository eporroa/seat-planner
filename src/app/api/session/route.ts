import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isValidBaseName } from "@/shared/names";
import { serverEnv } from "@/server/env";
import { setClientCookie } from "@/server/session";
import { supabaseAdmin } from "@/server/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({ clientId: z.uuid(), baseName: z.string().max(60) });

// Creates (or renames) the attendee: the server assigns the display name
// (animal + color + lowest free number) and signs the session cookie.
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > 1024) return NextResponse.json({ error: "too_large" }, { status: 413 });

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const body = bodySchema.safeParse(json);
  if (!body.success || !isValidBaseName(body.data.baseName)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin().rpc("demo_register_client", {
    p_client_id: body.data.clientId,
    p_room_id: serverEnv().DEMO_ROOM_ID,
    p_base_name: body.data.baseName,
  });
  const displayName = (data as { displayName?: unknown } | null)?.displayName;
  if (error || typeof displayName !== "string") {
    console.error("[api/session] upstream error", error?.message ?? "no display name");
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }

  const res = NextResponse.json({ displayName });
  setClientCookie(req, res, body.data.clientId);
  return res;
}
