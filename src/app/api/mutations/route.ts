import { NextResponse, type NextRequest } from "next/server";
import { mutationIdSchema, mutationResultSchema, mutationSchema, requestSchema, type MutationResult } from "@/server/mutation-schema";
import { readClientId, readIsAdmin } from "@/server/session";
import { supabaseAdmin } from "@/server/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BODY_BYTES = 64 * 1024;

// Identity and admin come from signed cookies, never from the body. Every
// mutation is applied by apply_mutation() (one transaction each), in order.
export async function POST(req: NextRequest) {
  const clientId = readClientId(req);
  if (!clientId) return NextResponse.json({ error: "no_session" }, { status: 401 });

  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return NextResponse.json({ error: "too_large" }, { status: 413 });

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const request = requestSchema.safeParse(json);
  if (!request.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  // Without a mutation_id there is nothing to answer for: reject the whole request.
  const ids = request.data.mutations.map((m) => mutationIdSchema.safeParse(m));
  if (ids.some((id) => !id.success)) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const isAdmin = readIsAdmin(req, clientId);
  const supabase = supabaseAdmin();
  const results: MutationResult[] = [];

  for (const [index, rawMutation] of request.data.mutations.entries()) {
    const mutationId = (ids[index] as { data: { mutation_id: string } }).data.mutation_id;
    const parsed = mutationSchema.safeParse(rawMutation);
    if (!parsed.success) {
      // A malformed mutation is a final answer, otherwise it would be retried forever.
      results.push({ mutationId, status: "rejected", reason: "invalid" });
      continue;
    }

    const { data, error } = await supabase.rpc("apply_mutation", {
      p_mutation: parsed.data,
      p_client_id: clientId,
      p_is_admin: isAdmin,
    });
    const result = mutationResultSchema.safeParse(data);
    if (error || !result.success) {
      console.error("[api/mutations] upstream error", error?.message ?? "unexpected result");
      // Keep what was already applied; the client retries the rest.
      return NextResponse.json({ error: "upstream_error", results }, { status: 502 });
    }
    results.push(result.data);
    // Order matters: after a retryable answer, later mutations must wait.
    if (result.data.retryable) break;
  }

  return NextResponse.json({ results });
}
