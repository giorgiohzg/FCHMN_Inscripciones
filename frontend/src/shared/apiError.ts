/**
 * Arma un mensaje de error legible a partir de la respuesta del backend.
 * Antes, todos los clientes API solo usaban `body.message` (el mensaje
 * genérico, ej. "Datos de competencia inválidos") y descartaban
 * `body.details` — el detalle específico de qué campo falló y por qué
 * (viene de `parsed.error.flatten()` en el backend). Esto hacía
 * prácticamente imposible saber qué corregir cuando fallaba una
 * validación con varios campos posibles.
 */
export function extractApiErrorMessage(body: any, fallback: string): string {
  const baseMessage: string = body?.message ?? fallback;
  const details = body?.details;
  if (!details) return baseMessage;

  const messages: string[] = [];
  const fieldErrors = details.fieldErrors as Record<string, string[]> | undefined;
  if (fieldErrors) {
    for (const [field, msgs] of Object.entries(fieldErrors)) {
      if (msgs && msgs.length > 0) messages.push(`${field}: ${msgs.join(", ")}`);
    }
  }
  const formErrors = details.formErrors as string[] | undefined;
  if (formErrors && formErrors.length > 0) messages.push(...formErrors);

  if (messages.length === 0) return baseMessage;
  return `${baseMessage} — ${messages.join(" | ")}`;
}
