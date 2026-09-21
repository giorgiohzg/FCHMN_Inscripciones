/**
 * Copia del algoritmo de validación de RUN para dar feedback instantáneo
 * en el formulario. La validación autoritativa SIEMPRE ocurre en el
 * backend (ver src/shared/run.util.ts) — esto es solo UX.
 */
export function normalizeRun(raw: string): string {
  return raw.replace(/[.\s]/g, "").replace("-", "").toUpperCase();
}

export function formatRun(raw: string): string {
  const clean = normalizeRun(raw);
  if (clean.length < 2) return clean;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  const withDots = body.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${withDots}-${dv}`;
}

function computeCheckDigit(body: string): string {
  let sum = 0;
  let multiplier = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const remainder = 11 - (sum % 11);
  if (remainder === 11) return "0";
  if (remainder === 10) return "K";
  return String(remainder);
}

export function isValidRun(raw: string): boolean {
  const clean = normalizeRun(raw);
  if (!/^\d{7,8}[0-9K]$/.test(clean)) return false;
  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  return dv === computeCheckDigit(body);
}
