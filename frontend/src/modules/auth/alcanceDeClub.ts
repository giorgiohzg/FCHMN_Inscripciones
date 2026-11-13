/**
 * ¿Puede esta sesión postular incorporaciones POR SU CLUB (C-05, fase 4)?
 *
 * Replica la precedencia del backend (`buildActorContext`): administración gana sobre cualquier
 * otro rol y usa sus propias pantallas; luego, una sesión con club (la cuenta del club o su
 * personal vigente: delegado, entrenador, representante legal) con el permiso de escritura de
 * asignaciones; un nadador sin esas funciones, no. La decisión final la toma el servidor.
 */
export function puedePostularPorSuClub(auth: { user: { clubId: string | null } | null; hasRole: (r: string) => boolean; hasPermission: (p: string) => boolean }): boolean {
  if (auth.hasRole("admin")) return false;
  if (!auth.user?.clubId) return false;
  return auth.hasPermission("swimmer-assignment:write");
}
