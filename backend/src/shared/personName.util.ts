/**
 * Arma el "nombre completo" para mostrar (convención chilena: Nombre +
 * Apellido Paterno + Apellido Materno), a partir de los 3 campos que
 * ahora se ingresan por separado en Personas. El apellido materno es
 * opcional — si no se ingresa, simplemente se omite del resultado.
 */
export function formatPersonFullName(firstName: string, paternalLastName: string, maternalLastName?: string | null): string {
  const parts = [firstName.trim(), paternalLastName.trim(), maternalLastName?.trim()].filter((p): p is string => Boolean(p));
  return parts.join(" ");
}
