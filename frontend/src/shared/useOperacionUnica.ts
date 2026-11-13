import { useCallback, useMemo, useRef, useState } from "react";

/**
 * UNA SOLA ESCRITURA EN CURSO POR FLUJO, compartida entre un contenedor (un diálogo, una ficha)
 * y los componentes que envían dentro de él.
 *
 * - `iniciar()` reserva de forma SÍNCRONA y devuelve un testigo, o `null` si ya hay una en curso:
 *   un segundo clic, o una acción exterior (rechazar mientras se aprueba), no pasa.
 * - `terminar(testigo)` libera SOLO si el testigo sigue siendo el vigente.
 * - `enCurso` es para pintar (deshabilitar controles, bloquear el cierre del diálogo);
 *   `ocupada()` es la comprobación síncrona para los manejadores.
 *
 * Bloquear el cierre mientras hay una operación no es una cancelación: una petición enviada sigue
 * su curso en el servidor. Lo que se evita es desmontar el flujo y perder su resultado.
 */
export interface OperacionUnica {
  enCurso: boolean;
  iniciar: () => number | null;
  terminar: (testigo: number) => void;
  ocupada: () => boolean;
}

export function useOperacionUnica(): OperacionUnica {
  const vigente = useRef<number | null>(null);
  const siguiente = useRef(0);
  const [enCurso, setEnCurso] = useState(false);

  const iniciar = useCallback(() => {
    if (vigente.current !== null) return null;
    const testigo = ++siguiente.current;
    vigente.current = testigo;
    setEnCurso(true);
    return testigo;
  }, []);

  const terminar = useCallback((testigo: number) => {
    if (vigente.current !== testigo) return;
    vigente.current = null;
    setEnCurso(false);
  }, []);

  const ocupada = useCallback(() => vigente.current !== null, []);

  return useMemo(() => ({ enCurso, iniciar, terminar, ocupada }), [enCurso, iniciar, terminar, ocupada]);
}
