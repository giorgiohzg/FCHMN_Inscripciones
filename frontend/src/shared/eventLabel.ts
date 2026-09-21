export type EventGender = "male" | "female" | "mixed";

const GENDER_LABELS: Record<EventGender, string> = { male: "Varones", female: "Damas", mixed: "Mixto" };

export interface EventLabelInput {
  /**
   * Distancia TOTAL de la prueba en metros. En un relevo es la suma de las
   * postas: un 4×50 llega como 200. Es la misma convención que usan los
   * archivos de Hy-Tek y la que guarda `Event.distance` en el backend
   * (ver `shared/relayDistance.util.ts`).
   */
  distanceMeters: number;
  strokeName: string;
  gender: EventGender;
  /** true si es una prueba de relevo. */
  isRelay: boolean;
  /**
   * Nadadores por equipo (`TestType.swimmersCount`). Se usa para mostrar
   * "4×50" a partir del total. Si no se entrega, se asume 4 (el único tipo
   * de relevo que existe hoy en el catálogo).
   */
  swimmersCount?: number;
}

/**
 * Formato uniforme del nombre de una prueba en toda la aplicación:
 *  - Individual: "50m Libre (Varones)" — se muestra el género, no la
 *    palabra "Individual" (es el caso por defecto, no aporta información).
 *  - Relevo: "Relevo 4x50m Libre (Mixto)" — la distancia se descompone en
 *    postas a partir del total, que es como se nombra un relevo en natación.
 *    Antes se imprimía el número tal cual, así que un relevo de 200 totales
 *    aparecía como "Relevo 200m", que no es como nadie lo llama.
 */
export function formatEventLabel(input: EventLabelInput): string {
  const genderLabel = GENDER_LABELS[input.gender] ?? input.gender;
  if (!input.isRelay) {
    return `${input.distanceMeters}m ${input.strokeName} (${genderLabel})`;
  }

  const legs = input.swimmersCount && input.swimmersCount > 1 ? input.swimmersCount : 4;
  // Si el total no es divisible entre las postas, se muestra el total sin
  // inventar una descomposición que el dato no respalda.
  const perLeg = input.distanceMeters % legs === 0 ? input.distanceMeters / legs : null;
  const distanceLabel = perLeg !== null ? `${legs}x${perLeg}m` : `${input.distanceMeters}m`;

  return `Relevo ${distanceLabel} ${input.strokeName} (${genderLabel})`;
}
