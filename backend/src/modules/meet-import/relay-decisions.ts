/**
 * CONFIRMACIÓN EXPLÍCITA DEL TIPO DE RELEVO.
 *
 * El problema que resuelve: ningún archivo de Meet Manager que sepamos leer
 * dice en cuántas postas se divide un relevo. El `.hyv` no lo trae en
 * absoluto; el `.ev3` lo trae en un campo que este importador todavía no lee.
 * Solo se conoce la distancia TOTAL, y un relevo de 200 m puede ser 4×50 o
 * 2×100.
 *
 * Por qué no se elige solo. Durante un tiempo el importador tomaba el tipo de
 * relevo del catálogo por su cuenta, razonando que si solo hay un tipo
 * (`Relevo`, 4 nadadores) entonces «200 m = 4×50» no es una suposición sino la
 * única lectura representable. El razonamiento es circular: que el sistema no
 * sepa representar otra cosa es un hecho sobre el sistema, no sobre el
 * archivo. Y el valor no es cosmético — `TestType.swimmersCount` decide
 * cuántos nadadores exige cada inscripción de relevo (ver
 * `shared/testType.util.ts`), así que elegir mal cambia lo que cada club tiene
 * que inscribir.
 *
 * LA DECISIÓN VA POR PRUEBA, NO POR TIPO DE PRUEBA. Es tentador agrupar los
 * relevos por su firma (distancia + estilo + género) y pedir una decisión por
 * grupo, que serían menos preguntas. No sirve: dos relevos pueden coincidir en
 * las tres cosas y aun así ser distintos —un 4×50 Libre damas y un 2×100 Libre
 * damas son ambos «200 Libre damas»— y agrupar impondría a uno la decisión del
 * otro sin que nadie lo notara. La clave es el número de prueba.
 *
 * NADA VIENE PRESELECCIONADO. Estas estructuras no tienen un campo "elegido
 * por omisión" a propósito: un valor por omisión es exactamente la elección
 * automática que se quiso eliminar, solo que disfrazada de propuesta.
 */

import { createHash } from "node:crypto";
import type { ParsedGender, ParsedMeet, ParsedMeetEvent } from "./ev3-parser";
import { formatDistanceLabel, metersPerLeg } from "../../shared/relayDistance.util";

/** Una decisión del usuario para UNA prueba de relevo del archivo. */
export type DecisionDeRelevo =
  | { eventNumber: number; decision: "tipo"; testTypeId: string }
  /** No se pudo confirmar: la prueba NO se importa y se cuenta como omitida. */
  | { eventNumber: number; decision: "omitir" };

export interface TipoDeRelevoDisponible {
  id: string;
  name: string;
  swimmersCount: number;
}

/** Una prueba de relevo del archivo, con las opciones entre las que elegir. */
export interface RelevoPorConfirmar {
  eventNumber: number;
  distanceMeters: number;
  strokeName: string;
  gender: ParsedGender;
  opciones: Array<{
    testTypeId: string;
    nombre: string;
    swimmersCount: number;
    /**
     * Cómo quedaría la distancia con ese tipo: "4×50" para 200 m en 4 postas.
     * Se calcula aquí, con la misma función que usa la pantalla de la
     * competencia, para que quien elige vea la consecuencia exacta de su
     * elección y no tenga que dividir de cabeza.
     */
    etiqueta: string;
    /** Falso si el total no se divide entre las postas (200 m en 3, por ejemplo). */
    divisible: boolean;
  }>;
}

/**
 * Huella del archivo tal como se subió.
 *
 * Se calcula sobre los bytes crudos, no sobre lo interpretado: lo que hay que
 * detectar es que entre la fase de análisis y la de confirmación se haya
 * subido OTRO archivo, y cualquier diferencia de bytes lo es. Sin esto, las
 * decisiones tomadas mirando un archivo se aplicarían a otro por número de
 * prueba, que es el peor resultado posible: números que coinciden y
 * significados que no.
 */
export function huellaDelArchivo(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function esRelevo(evento: ParsedMeetEvent): boolean {
  return evento.isRelay;
}

/**
 * Relevos del archivo que necesitan confirmación, en el orden del archivo.
 */
export function relevosParaConfirmar(
  meet: Pick<ParsedMeet, "events">,
  tipos: readonly TipoDeRelevoDisponible[]
): RelevoPorConfirmar[] {
  return meet.events.filter(esRelevo).map((evento) => ({
    eventNumber: evento.eventNumber,
    distanceMeters: evento.distanceMeters,
    strokeName: evento.strokeName,
    gender: evento.gender,
    opciones: tipos.map((tipo) => ({
      testTypeId: tipo.id,
      nombre: tipo.name,
      swimmersCount: tipo.swimmersCount,
      etiqueta: formatDistanceLabel(evento.distanceMeters, tipo.swimmersCount),
      divisible: metersPerLeg(evento.distanceMeters, tipo.swimmersCount) !== null,
    })),
  }));
}

/** Marca de "esta prueba se omite" dentro del mapa de decisiones resueltas. */
export const OMITIR = Symbol("omitir-relevo");

export type DecisionResuelta = string | typeof OMITIR;

export type ResultadoDeValidacion =
  | { ok: true; porPrueba: Map<number, DecisionResuelta> }
  | { ok: false; errores: string[] };

/**
 * Comprueba que las decisiones recibidas cubren el archivo y el catálogo
 * ACTUALES.
 *
 * Se vuelve a validar todo en la segunda fase, sin confiar en nada de la
 * primera, porque entre una y otra pueden haber cambiado las dos cosas: el
 * archivo (otro adjunto) y el catálogo (alguien borró un tipo de prueba). Un
 * fallo aquí no importa nada: se devuelve la lista completa de problemas para
 * que quien importa los corrija de una vez, en vez de descubrirlos de a uno.
 *
 * NO HAY DECISIÓN POR OMISIÓN. Si falta la de alguna prueba, esto falla; no se
 * elige un tipo ni se omite la prueba calladamente.
 */
export function validarDecisiones(
  relevos: readonly RelevoPorConfirmar[],
  decisiones: readonly DecisionDeRelevo[],
  tipos: readonly TipoDeRelevoDisponible[]
): ResultadoDeValidacion {
  const errores: string[] = [];

  /**
   * Si dos relevos comparten número de prueba, la clave deja de identificar
   * una prueba y cualquier decisión sería ambigua. Es un archivo mal formado,
   * y se rechaza antes que nada porque invalida todo lo demás.
   */
  const numeros = relevos.map((r) => r.eventNumber);
  const repetidos = [...new Set(numeros.filter((n, i) => numeros.indexOf(n) !== i))];
  if (repetidos.length > 0) {
    return {
      ok: false,
      errores: [
        `El archivo tiene más de un relevo con el mismo número de prueba (${repetidos.join(", ")}), ` +
          "así que no se puede decidir el tipo de cada uno por separado. Corrija la numeración en Meet Manager y vuelva a exportar.",
      ],
    };
  }

  const idsValidos = new Set(tipos.map((t) => t.id));
  const relevosPorNumero = new Map(relevos.map((r) => [r.eventNumber, r]));
  const porPrueba = new Map<number, DecisionResuelta>();

  for (const decision of decisiones) {
    if (!relevosPorNumero.has(decision.eventNumber)) {
      errores.push(
        `Se recibió una decisión para la prueba #${decision.eventNumber}, que no es un relevo de este archivo. ` +
          "Vuelva a analizar el archivo y repita la confirmación."
      );
      continue;
    }
    if (porPrueba.has(decision.eventNumber)) {
      errores.push(`Se recibió más de una decisión para la prueba #${decision.eventNumber}.`);
      continue;
    }

    if (decision.decision === "omitir") {
      porPrueba.set(decision.eventNumber, OMITIR);
      continue;
    }

    /**
     * El tipo elegido se comprueba contra el catálogo LEÍDO AHORA. Entre el
     * análisis y la confirmación pueden haber borrado ese tipo de prueba, y
     * entonces la elección ya no significa nada: importar con otro sería
     * decidir por el usuario justo lo que él vino a decidir.
     */
    if (!idsValidos.has(decision.testTypeId)) {
      const relevo = relevosPorNumero.get(decision.eventNumber)!;
      errores.push(
        `El tipo de relevo elegido para la prueba #${decision.eventNumber} ` +
          `(${relevo.distanceMeters}m ${relevo.strokeName}) ya no existe en el catálogo. ` +
          "Vuelva a analizar el archivo para ver los tipos disponibles y elija de nuevo."
      );
      continue;
    }

    porPrueba.set(decision.eventNumber, decision.testTypeId);
  }

  const sinDecidir = relevos.filter((r) => !porPrueba.has(r.eventNumber));
  if (sinDecidir.length > 0) {
    errores.push(
      `Faltan decisiones para ${sinDecidir.length} relevo(s): ` +
        `${sinDecidir.map((r) => `#${r.eventNumber} (${r.distanceMeters}m ${r.strokeName})`).join(", ")}. ` +
        "Cada relevo necesita una decisión propia: ninguno se importa por omisión."
    );
  }

  if (errores.length > 0) return { ok: false, errores };
  return { ok: true, porPrueba };
}

/**
 * Texto del rechazo cuando el archivo cambió entre el análisis y la
 * confirmación.
 */
export const AVISO_ARCHIVO_CAMBIADO =
  "El archivo cambió entre el análisis y la confirmación, así que las decisiones tomadas no le corresponden y no se importó nada. " +
  "Vuelva a analizar el archivo que quiere importar y confirme los relevos sobre ese análisis.";

/** Qué hacer, idéntico en los dos formatos. */
const COMO_CONTINUAR =
  "No se importó nada: el tipo de relevo debe confirmarse prueba por prueba antes de importar. " +
  "Analice el archivo primero y confirme cada relevo, o exporte el programa sin relevos y cárguelos manualmente.";

/**
 * Rechazo de un `.hyv` con relevos sin confirmar.
 *
 * Aquí la afirmación es fuerte porque está comprobada: se alineó un `.hyv`
 * real con el `.ev3` del mismo evento y no hay ningún campo que indique las
 * postas.
 */
export const AVISO_RELEVOS_SIN_CONFIRMAR_HYV =
  "El archivo .hyv contiene relevos y no indica en cuántas postas se divide cada uno. " + COMO_CONTINUAR;

/**
 * Rechazo de un `.ev3` con relevos sin confirmar.
 *
 * EL MOTIVO ES DISTINTO Y EL MENSAJE TAMBIÉN, a propósito. El `.ev3` SÍ trae
 * el número de postas, en su campo [29]; lo que pasa es que este importador
 * todavía no lo lee. Decir que "el archivo no lo indica" sería falso y
 * mandaría a buscar el problema donde no está.
 *
 * Mientras tanto se exige la misma confirmación que para el `.hyv`. Antes se
 * tomaba el primer tipo de relevo del catálogo con un aviso; eso es una
 * elección automática sobre un dato que no se ha leído, y un aviso no
 * autoriza a adivinar. Es una medida de seguridad de datos, no un sustituto
 * de leer [29]: cuando esa lectura exista y esté probada, un relevo cuyo
 * número de postas venga en el archivo no debería necesitar confirmación.
 */
export const AVISO_RELEVOS_SIN_CONFIRMAR_EV3 =
  "El archivo contiene relevos. El formato .ev3 sí trae el número de postas de cada relevo, pero el importador todavía no lo lee, " +
  "así que el tipo no se da por sabido. " +
  COMO_CONTINUAR;
