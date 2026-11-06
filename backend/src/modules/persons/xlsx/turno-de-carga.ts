/**
 * UNA carga masiva activa por PROCESO, sin cola.
 *
 * Se toma antes de recibir el archivo y se libera al terminar de escribir, para que dos
 * cargas no acumulen a la vez ni los buffers ni los analizadores. Una segunda carga se
 * rechaza en el acto: una cola retendría esos mismos archivos en memoria.
 *
 * La garantía es POR PROCESO. Vive en la memoria de la instancia y no coordina réplicas:
 * el despliegue previsto es de una sola, igual que el límite de solicitudes.
 */
let ocupado = false;

/** Devuelve con qué liberar el turno, o `null` si ya hay una carga activa. */
export function tomarTurnoDeCarga(): (() => void) | null {
  if (ocupado) return null;
  ocupado = true;
  let liberado = false;
  return () => {
    if (liberado) return;
    liberado = true;
    ocupado = false;
  };
}
