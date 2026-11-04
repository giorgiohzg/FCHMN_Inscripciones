/**
 * Texto del campo «máximo por club» -> valor para la API.
 * Vacío = sin límite (`null`). Con valor, un entero positivo; cualquier otra cosa devuelve `"invalido"`.
 */
export function parseMaxSwimmersPerClub(texto: string): number | null | "invalido" {
  const limpio = texto.trim();
  if (limpio === "") return null;
  if (!/^\d+$/.test(limpio)) return "invalido";
  const n = Number(limpio);
  return Number.isSafeInteger(n) && n >= 1 ? n : "invalido";
}
