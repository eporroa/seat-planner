// Attendee names are never free text: they are an animal + a color in PascalCase.
// Colors are gender-invariant in Spanish so every combination reads naturally.
// The server validates base names against these same lists.
export const ANIMALS = [
  "Ajolote",
  "Jaguar",
  "Quetzal",
  "Tlacuache",
  "Coyote",
  "Ocelote",
  "Armadillo",
  "Cacomixtle",
  "Xoloitzcuintle",
  "Teporingo",
  "Iguana",
  "Flamenco",
  "Tortuga",
  "Ballena",
  "Mariposa",
  "Lobo",
  "Puma",
  "Zorro",
  "Guacamaya",
  "Tapir",
] as const;

export const COLORS = [
  "Azul",
  "Verde",
  "Rosa",
  "Naranja",
  "Violeta",
  "Turquesa",
  "Coral",
  "Esmeralda",
  "Fucsia",
  "Lila",
  "Magenta",
  "Cian",
  "Celeste",
  "Gris",
  "Lavanda",
  "Menta",
  "Jade",
  "Granate",
  "Escarlata",
  "Ocre",
] as const;

function pick<T>(list: readonly T[]): T {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return list[(values[0] ?? 0) % list.length] as T;
}

export function randomBaseName(previous?: string): string {
  for (;;) {
    const name = `${pick(ANIMALS)}${pick(COLORS)}`;
    if (name !== previous) return name;
  }
}

const BASE_NAMES = new Set(ANIMALS.flatMap((animal) => COLORS.map((color) => `${animal}${color}`)));

export function isValidBaseName(name: string): boolean {
  return BASE_NAMES.has(name);
}

// Duplicates get the next free number: JaguarCoral, JaguarCoral2, JaguarCoral3…
export function displayNameFor(baseName: string, suffix: number): string {
  return suffix <= 1 ? baseName : `${baseName}${suffix}`;
}
