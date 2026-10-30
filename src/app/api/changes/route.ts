import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { serverEnv } from "@/server/env";
import { supabaseAdmin } from "@/server/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const sinceSchema = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// Everything in the room newer than `since` (a version number), read-only and
// identical for every phone, so the CDN can collapse hundreds of polls into one
// origin request per second. `upto` (the version a doorbell announced) is only a
// cache key: it makes the URL new, so a phone answering a ping is never served
// an answer cached before that change. The room is fixed server-side; claims never carry
// client_id (demo_changes returns owner_tag only).
export async function GET(req: NextRequest) {
  const since = sinceSchema.safeParse(req.nextUrl.searchParams.get("since") ?? "0");
  if (!since.success) return NextResponse.json({ error: "invalid_since" }, { status: 400 });

  const { data, error } = await supabaseAdmin().rpc("demo_changes", {
    p_room: serverEnv().DEMO_ROOM_ID,
    p_since: since.data,
  });
  if (error || typeof data !== "object" || data === null) {
    console.error("[api/changes] upstream error", error?.message ?? "no data");
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
  return NextResponse.json(data, {
    headers: { "cache-control": "public, max-age=0, s-maxage=1" },
  });
}
