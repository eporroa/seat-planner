"use client";

import { useEffect, useState } from "react";
import { PGliteProvider } from "@electric-sql/pglite-react";
import { getDb, type AppDb } from "./client";

// Loads the PGlite worker, then renders children inside the provider.
export function DbProvider({ children }: { children: React.ReactNode }) {
  const [db, setDb] = useState<AppDb | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getDb().then(
      (instance) => !cancelled && setDb(instance),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e))
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="p-6 text-red-700">No se pudo abrir la base de datos local: {error}</p>;
  }
  if (!db) {
    return <div className="grid h-dvh place-items-center text-slate-500">Abriendo base de datos local…</div>;
  }
  return <PGliteProvider db={db}>{children}</PGliteProvider>;
}
