/**
 * Muestra solo Nombre + Apellido paterno (sin apellido materno) — usado
 * en columnas de tablas donde se prefiere un nombre más corto. Si la
 * persona todavía no tiene los campos separados (creada antes de ese
 * cambio), recurre a `fullName` completo como respaldo.
 */
export function formatShortName(person: { fullName: string; firstName: string | null; paternalLastName: string | null }): string {
  if (person.firstName && person.paternalLastName) {
    return `${person.firstName} ${person.paternalLastName}`;
  }
  return person.fullName;
}
