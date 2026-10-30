"use client";

import dynamic from "next/dynamic";

// PGlite and Konva only run in the browser.
const ClientApp = dynamic(() => import("./client-app").then((m) => m.ClientApp), {
  ssr: false,
  loading: () => <div className="grid h-dvh place-items-center text-slate-500">Cargando…</div>,
});

export function ClientEntry() {
  return <ClientApp />;
}
