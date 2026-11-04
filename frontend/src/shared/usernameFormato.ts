/**
 * Formato del nombre de usuario, del lado del cliente: mismas reglas que
 * `usernameField` del backend (4 a 30 caracteres; letras, números, puntos,
 * guiones y guiones bajos). Solo para guiar al usuario: quien decide es el
 * servidor.
 *
 * Devuelve el problema, o `null` si no hay ninguno. Vacío no es un problema:
 * el nombre es opcional.
 */
export function problemaDeUsername(valor: string): string | null {
  const v = valor.trim();
  if (v === "") return null;
  if (v.length < 4 || v.length > 30) return "El nombre de usuario debe tener entre 4 y 30 caracteres.";
  if (!/^[a-zA-Z0-9._-]+$/.test(v)) return "Solo se permiten letras, números, puntos, guiones y guiones bajos.";
  return null;
}

/**
 * Qué hacer con el campo de nombre de usuario al EDITAR una ficha.
 *
 * Los nombres anteriores a la regla de formato (p. ej. «ana», de 3 letras) se
 * conservan tal cual; si el usuario no los toca, no hay nada que validar ni que
 * enviar. Solo un nombre que el usuario CAMBIÓ se valida y se envía:
 *
 *   - `cambio`: el campo difiere (recortado) del nombre cargado;
 *   - `valor`: lo que se enviaría —el nombre recortado, o `null` para quitarlo—;
 *   - `problema`: el problema de formato, y SOLO si cambió.
 *
 * El formato de un nombre nuevo no se relaja: cambiarlo a otro inválido se
 * rechaza igual que en un alta.
 */
export function evaluarUsernameEditado(
  original: string | null | undefined,
  actual: string
): { cambio: boolean; valor: string | null; problema: string | null } {
  const cambio = actual.trim() !== (original ?? "");
  return { cambio, valor: actual.trim() || null, problema: cambio ? problemaDeUsername(actual) : null };
}
