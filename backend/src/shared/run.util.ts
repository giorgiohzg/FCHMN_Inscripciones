/**
 * Validación de RUN/RUT chileno.
 * Mismo algoritmo aplica a personas (RUN) y a clubes con personalidad
 * jurídica (RUT) — ver RB-02/RB-03 en el documento de arquitectura.
 */

/** Normaliza: quita puntos/espacios, guión, y deja el DV en mayúscula. */
export function normalizeRun(raw: string): string {
  return raw.replace(/[.\s]/g, "").replace("-", "").toUpperCase();
}

/** Formatea a "12.345.678-9" para mostrar en UI. */
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

export interface RunValidationResult {
  valid: boolean;
  reason?: "FORMAT" | "CHECK_DIGIT";
}

/**
 * Valida formato y dígito verificador de un RUN/RUT chileno.
 * Acepta con o sin puntos/guión (ej. "12.345.678-9" o "123456789").
 */
export function validateRun(raw: string): RunValidationResult {
  const clean = normalizeRun(raw);

  if (!/^\d{7,8}[0-9K]$/.test(clean)) {
    return { valid: false, reason: "FORMAT" };
  }

  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);
  const expectedDv = computeCheckDigit(body);

  if (dv !== expectedDv) {
    return { valid: false, reason: "CHECK_DIGIT" };
  }

  return { valid: true };
}
