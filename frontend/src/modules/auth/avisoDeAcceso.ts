/**
 * Aviso para la pantalla de inicio de sesión cuando el servidor TERMINÓ la sesión durante
 * un cambio de contraseña (C-04: demasiados intentos con la contraseña actual incorrecta).
 *
 * Al limpiar la sesión, la ruta lleva al login y la pantalla de cambio se desmonta, así que
 * su mensaje de error se perdería. Se guarda aquí, en memoria —no es un dato sensible ni
 * hace falta que sobreviva a una recarga—, y el login lo muestra hasta el siguiente intento.
 *
 * Leer no lo consume: en modo estricto React puede montar dos veces la pantalla.
 */
let aviso: string | null = null;

export function dejarAvisoDeAcceso(mensaje: string): void {
  aviso = mensaje;
}

export function leerAvisoDeAcceso(): string | null {
  return aviso;
}

export function descartarAvisoDeAcceso(): void {
  aviso = null;
}
