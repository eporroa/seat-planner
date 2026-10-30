"use client";

import { useState } from "react";
import { Dices } from "lucide-react";
import { usePGlite } from "@electric-sql/pglite-react";
import type { AppDb } from "@/db/client";
import { saveProfile } from "@/db/actions";
import { registerSession, unlockAdmin, UNLOCK_MESSAGES } from "@/db/identity";
import { SQL } from "@/db/queries";
import { randomBaseName } from "@/shared/names";

export function Welcome({ adminRequested }: { adminRequested: boolean }) {
  const db = usePGlite() as unknown as AppDb;
  const [name, setName] = useState(() => randomBaseName());
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enter() {
    setBusy(true);
    setError(null);
    // Ask for durable storage on the first interaction (best effort).
    void navigator.storage?.persist?.();
    const clientId = crypto.randomUUID();

    if (adminRequested) {
      // ?isAdmin=true only reveals this field; the server decides.
      const displayName = await registerSession(clientId, name);
      const result = displayName === null ? "offline" : await unlockAdmin(passcode);
      if (displayName !== null && result === "ok") {
        await db.query(SQL.setProfileRegistered, [clientId, displayName, name, true]);
        return;
      }
      // Without a passcode typed, fall through as a regular attendee.
      if (passcode !== "" && result !== "ok") {
        setError(UNLOCK_MESSAGES[result === "disabled" ? "disabled" : result]);
        setBusy(false);
        return;
      }
    }
    await saveProfile(db, clientId, name);
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-gradient-to-b from-teal-50 to-white p-6">
      <div className="w-full max-w-sm space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-3xl font-extrabold tracking-tight">Mesas en vivo</h1>
          <p className="text-slate-600">JSConf MX 2026</p>
        </div>
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Tu nombre en la sala</p>
          <p className="text-2xl font-bold text-teal-800" data-testid="generated-name">
            {name}
          </p>
          <button
            type="button"
            onClick={() => setName((prev) => randomBaseName(prev))}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
          >
            <Dices size={16} /> Otro nombre
          </button>
        </div>
        {adminRequested && (
          <label className="block space-y-1 text-left">
            <span className="text-sm text-slate-600">Código de admin</span>
            <input
              type="password"
              autoComplete="off"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2"
            />
            {error && (
              <span role="alert" className="text-sm text-red-600">
                {error}
              </span>
            )}
          </label>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={enter}
          className="w-full rounded-xl bg-teal-700 px-4 py-3 text-lg font-semibold text-white shadow hover:bg-teal-800 disabled:opacity-60"
        >
          Entrar
        </button>
      </div>
    </main>
  );
}
