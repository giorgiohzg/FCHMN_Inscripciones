/**
 * Espejo en el frontend de `computeAge` del backend (`shared/age.util.ts`)
 * — se usa SOLO para mostrar una vista previa en vivo antes de confirmar
 * (ej. la categoría calculada de un equipo de relevo). El backend siempre
 * vuelve a calcular todo de forma autoritativa al confirmar; si por
 * cualquier motivo esta vista previa difiere, el mensaje de error del
 * backend prevalece.
 */
export function computeAgeClientPreview(birthDateISO: string, cutoffDateISO: string): number {
  const birth = new Date(birthDateISO);
  const cutoff = new Date(cutoffDateISO);

  let age = cutoff.getUTCFullYear() - birth.getUTCFullYear();
  const hasHadBirthdayThisYear =
    cutoff.getUTCMonth() > birth.getUTCMonth() ||
    (cutoff.getUTCMonth() === birth.getUTCMonth() && cutoff.getUTCDate() >= birth.getUTCDate());
  if (!hasHadBirthdayThisYear) age -= 1;

  return age;
}
