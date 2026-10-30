import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { serverEnv } from "./env";

export const CLIENT_COOKIE = "demo_client";
export const ADMIN_COOKIE = "demo_admin";
const CLIENT_TTL_S = 60 * 60 * 24 * 30;
const ADMIN_TTL_S = 60 * 60 * 8;

interface ClientToken {
  v: 1;
  kind: "client";
  clientId: string;
  exp: number;
}
interface AdminToken {
  v: 1;
  kind: "admin";
  clientId: string;
  exp: number;
}

function mac(body: string): Buffer {
  return createHmac("sha256", serverEnv().SESSION_SECRET).update(body).digest();
}

function sign(payload: ClientToken | AdminToken): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body).toString("base64url")}`;
}

function verify<T extends { exp: number; kind: string }>(token: string | undefined, kind: T["kind"]): T | null {
  if (!token) return null;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;
  const expected = mac(body);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    if (payload.kind !== kind || typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function cookieOptions(req: NextRequest, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    // Browsers treat localhost as secure, so Secure also works for local prod builds.
    secure: process.env.NODE_ENV === "production" || req.nextUrl.protocol === "https:",
    path: "/",
    maxAge,
  };
}

export function setClientCookie(req: NextRequest, res: NextResponse, clientId: string): void {
  const token = sign({ v: 1, kind: "client", clientId, exp: Math.floor(Date.now() / 1000) + CLIENT_TTL_S });
  res.cookies.set(CLIENT_COOKIE, token, cookieOptions(req, CLIENT_TTL_S));
}

export function setAdminCookie(req: NextRequest, res: NextResponse, clientId: string): void {
  const token = sign({ v: 1, kind: "admin", clientId, exp: Math.floor(Date.now() / 1000) + ADMIN_TTL_S });
  res.cookies.set(ADMIN_COOKIE, token, cookieOptions(req, ADMIN_TTL_S));
}

export function readClientId(req: NextRequest): string | null {
  return verify<ClientToken>(req.cookies.get(CLIENT_COOKIE)?.value, "client")?.clientId ?? null;
}

// The admin cookie is bound to the client cookie's id, so it can't be replayed
// on another attendee's session.
export function readIsAdmin(req: NextRequest, clientId: string): boolean {
  return verify<AdminToken>(req.cookies.get(ADMIN_COOKIE)?.value, "admin")?.clientId === clientId;
}

// Constant-time comparison that doesn't leak the passcode length.
export function passcodeMatches(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
