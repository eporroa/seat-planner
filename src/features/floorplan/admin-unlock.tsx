"use client";

import { useState } from "react";
import { usePGlite } from "@electric-sql/pglite-react";
import type { AppDb } from "@/db/client";
import { registerSession, unlockAdmin, UNLOCK_MESSAGES } from "@/db/identity";
import { SQL } from "@/db/queries";

// For someone already in the app who opens ?isAdmin=true: ask for the passcode.
export function AdminUnlock({ clientId, baseName }: { clientId: string; baseName: string }) {
  const db = usePGlite() as unknown as AppDb;
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    const displayName = await registerSession(clientId, baseName);
    const result = displayName === null ? "offline" : await unlockAdmin(passcode);
    if (displayName !== null && result === "ok") {
      await db.query(SQL.setProfileRegistered, [clientId, displayName, baseName, true]);
    } else {
      setError(UNLOCK_MESSAGES[result === "ok" ? "wrong" : result]);
    }
    setBusy(false);
  }

  return (
    <form
      className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-amber-50 px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="text-xs text-slate-700" htmlFor="admin-passcode">
        Código de admin
      </label>
      <input
        id="admin-passcode"
        type="password"
        autoComplete="off"
        value={passcode}
        onChange={(e) => setPasscode(e.target.value)}
        className="rounded border border-slate-300 px-2 py-1 text-sm"
      />
      <button type="submit" disabled={busy} className="rounded bg-teal-700 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60">
        Entrar como admin
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-600">
          {error}
        </span>
      )}
    </form>
  );
}
