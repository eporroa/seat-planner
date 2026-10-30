"use client";

import { DbProvider } from "@/db/db-provider";
import { FloorApp } from "@/features/floorplan/floor-app";

export function ClientApp() {
  return (
    <DbProvider>
      <FloorApp />
    </DbProvider>
  );
}
