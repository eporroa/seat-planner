// Spanish copy for the reasons apply_mutation (and the local guards) can give.
export const REJECTION_MESSAGES: Record<string, string> = {
  seat_taken: "Alguien ganó esa silla 😅 — elige otra",
  overlap: "No hay espacio ahí — la mesa regresó a su lugar",
  out_of_bounds: "La mesa se salía del salón y regresó a su lugar",
  invalid_grid: "Esa posición no es válida — la mesa regresó a su lugar",
  invalid_size: "Ese tamaño no es válido",
  invalid_seat: "Esa silla no existe",
  locked: "El plano está bloqueado",
  forbidden: "Solo el admin puede hacer eso",
  seats_claimed: "Hay sillas ocupadas, no se pueden quitar",
  too_many_tables: "Ya no caben más mesas",
  not_found: "Esa mesa ya no existe",
  invalid: "No se pudo guardar ese cambio",
};

export function rejectionMessage(reason: string | null, entity?: string): string {
  // Releasing a chair that turned out to belong to someone else.
  if (reason === "forbidden" && entity === "seat_claim") return "Esa silla ya no es tuya";
  return (reason && REJECTION_MESSAGES[reason]) || "No se pudo guardar ese cambio";
}
