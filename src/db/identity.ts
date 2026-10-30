// The two inherently-online calls: creating the session cookie and checking
// the admin passcode. Everything else in the app stays local-first.

export type UnlockResult = "ok" | "wrong" | "rate_limited" | "offline" | "disabled";

async function post(path: string, body: unknown): Promise<Response | null> {
  try {
    return await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}

// Returns the display name the server assigned, or null when unreachable.
export async function registerSession(clientId: string, baseName: string): Promise<string | null> {
  const response = await post("/api/session", { clientId, baseName });
  if (!response?.ok) return null;
  const { displayName } = (await response.json()) as { displayName?: string };
  return displayName ?? null;
}

// Requires the session cookie from registerSession.
export async function unlockAdmin(passcode: string): Promise<UnlockResult> {
  const response = await post("/api/admin/session", { passcode });
  if (!response) return "offline";
  if (response.ok) return "ok";
  if (response.status === 429) return "rate_limited";
  if (response.status === 503) return "disabled";
  return "wrong";
}

export const UNLOCK_MESSAGES: Record<Exclude<UnlockResult, "ok">, string> = {
  wrong: "Código incorrecto",
  rate_limited: "Demasiados intentos, espera un minuto",
  offline: "Necesitas conexión para entrar como admin",
  disabled: "El modo admin no está habilitado",
};
