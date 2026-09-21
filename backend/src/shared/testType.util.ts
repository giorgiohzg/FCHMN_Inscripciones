import { ValidationError } from "./errors";

/**
 * Hallazgo 8 — coherencia entre el tipo de prueba y la forma de inscribirse.
 *
 * La interfaz solo ofrece pruebas individuales en el asistente individual y
 * de relevo en el de relevos, pero eso es una comodidad de la pantalla: la
 * API aceptaba cualquier combinación. Con una llamada directa se podía
 * inscribir a un solo nadador en una prueba de relevo, o registrar un equipo
 * de 4 en una prueba individual; en ambos casos quedaban filas imposibles de
 * exportar correctamente a Team Manager y que descuadran los reportes.
 *
 * La validación se hace contra `swimmersCount`, que es el campo que hace
 * extensible el catálogo de tipos de prueba (sección 6 del requerimiento):
 * si mañana existe un relevo de 6, la regla sigue valiendo sin tocar código.
 */
export function assertTestTypeMatches(
  testType: { name: string; swimmersCount: number },
  expectedSwimmersCount: number,
  operationLabel: "individual" | "de relevo"
): void {
  if (testType.swimmersCount !== expectedSwimmersCount) {
    throw new ValidationError(
      `La prueba seleccionada es de tipo "${testType.name}" (${testType.swimmersCount} nadador(es) por inscripción) ` +
        `y no admite una inscripción ${operationLabel}, que requiere ${expectedSwimmersCount}.`
    );
  }
}

/** Cantidad de integrantes que exige un tipo de prueba de relevo. */
export function requiredRelayMembers(testType: { swimmersCount: number }): number {
  return testType.swimmersCount;
}
