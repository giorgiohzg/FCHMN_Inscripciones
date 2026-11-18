import { ApiError } from "../../shared/apiClient";

/**
 * ELIMINACIÓN COMPLETA DE UNA COMPETENCIA: advertencia previa y resumen del resultado, comunes
 * al listado y a la competencia seleccionada para que ambos digan exactamente lo mismo.
 *
 * No existe eliminación de varias competencias a la vez: cada botón elimina una.
 */

export interface RecuentoDeEliminacion {
  inscripcionesIndividuales: number;
  inscripcionesIndividualesConfirmadas: number;
  inscripcionesIndividualesCanceladas: number;
  equiposDeRelevo: number;
  equiposDeRelevoConfirmados: number;
  equiposDeRelevoCancelados: number;
  integrantesDeRelevo: number;
  pruebasAsignadas: number;
  categoriasHabilitadas: number;
  limitesDeJornada: number;
  jornadas: number;
  fechas: number;
}

export interface ResultadoDeEliminacion {
  competitionId: string;
  nombre: string;
  eraPredeterminada: boolean;
  eliminados: RecuentoDeEliminacion;
}

/** Texto de la confirmación. `nombre` se omite cuando ya está a la vista (la propia competencia). */
export function advertenciaDeEliminacion(nombre?: string): string {
  const cual = nombre ? `la competencia «${nombre}»` : "esta competencia";
  return [
    `¿Eliminar ${cual} por completo? Esta acción NO se puede deshacer.`,
    "",
    "También se eliminarán:",
    "• TODAS sus inscripciones individuales, confirmadas o canceladas;",
    "• TODOS sus equipos de relevo, confirmados o cancelados, con sus integrantes;",
    "• sus pruebas asignadas, jornadas, fechas y límites.",
    "",
    "Se conservan las pruebas de Catálogos, las personas, los clubes y las demás competencias.",
  ].join("\n");
}

function plural(n: number, singular: string, pluralTexto: string): string {
  return `${n} ${n === 1 ? singular : pluralTexto}`;
}

/** Resumen de lo que de verdad eliminó el servidor. */
export function resumenDeEliminacion(r: ResultadoDeEliminacion): string {
  const e = r.eliminados;
  const partes = [
    `${plural(e.inscripcionesIndividuales, "inscripción individual", "inscripciones individuales")} (${plural(e.inscripcionesIndividualesConfirmadas, "confirmada", "confirmadas")}, ${plural(e.inscripcionesIndividualesCanceladas, "cancelada", "canceladas")})`,
    `${plural(e.equiposDeRelevo, "equipo de relevo", "equipos de relevo")} (${plural(e.equiposDeRelevoConfirmados, "confirmado", "confirmados")}, ${plural(e.equiposDeRelevoCancelados, "cancelado", "cancelados")}) con ${plural(e.integrantesDeRelevo, "integrante", "integrantes")}`,
    `${plural(e.pruebasAsignadas, "prueba asignada", "pruebas asignadas")}, ${plural(e.jornadas, "jornada", "jornadas")} y ${plural(e.fechas, "fecha", "fechas")}`,
  ];
  const predeterminada = r.eraPredeterminada ? " Era la competencia por defecto: ya no hay ninguna marcada." : "";
  return `Se eliminó «${r.nombre}»: ${partes.join("; ")}.${predeterminada}`;
}

// ---------------------------------------------------------------------------
// DESENLACE DE UNA ELIMINACIÓN, también cuando la respuesta no es concluyente.
//
// Un error del cliente no prueba que la transacción se haya rechazado: el servidor pudo
// confirmarla y perderse la respuesta (red, proxy, cuerpo ilegible). Por eso:
//   - SOLO un 4xx del servidor es un rechazo conocido (la competencia sigue como estaba);
//   - un 404 dice que la competencia ya no existe, sin atribuir el borrado a esta petición;
//   - todo lo demás es INCIERTO y se comprueba con una LECTURA, nunca repitiendo el DELETE;
//   - los recuentos solo se muestran si vienen de una respuesta válida del servidor.
// ---------------------------------------------------------------------------

export type DesenlaceDeEliminacion =
  | { tipo: "eliminada"; resultado: ResultadoDeEliminacion }
  | { tipo: "rechazada"; mensaje: string }
  /** `trasIncertidumbre`: se supo por la comprobación, no por la respuesta del DELETE. */
  | { tipo: "no-existe"; trasIncertidumbre: boolean }
  | { tipo: "sigue-existiendo" }
  | { tipo: "sin-confirmar" };

export interface OperacionesDeEliminacion {
  eliminar: (id: string) => Promise<unknown>;
  leer: (id: string) => Promise<unknown>;
}

const CLAVES_DE_RECUENTO: (keyof RecuentoDeEliminacion)[] = [
  "inscripcionesIndividuales",
  "inscripcionesIndividualesConfirmadas",
  "inscripcionesIndividualesCanceladas",
  "equiposDeRelevo",
  "equiposDeRelevoConfirmados",
  "equiposDeRelevoCancelados",
  "integrantesDeRelevo",
  "pruebasAsignadas",
  "categoriasHabilitadas",
  "limitesDeJornada",
  "jornadas",
  "fechas",
];

/** ¿Es la respuesta del servidor para ESTA competencia, con todos sus recuentos? */
export function esResultadoDeEliminacion(valor: unknown, competitionId: string): valor is ResultadoDeEliminacion {
  if (typeof valor !== "object" || valor === null) return false;
  const r = valor as Partial<ResultadoDeEliminacion>;
  if (r.competitionId !== competitionId || typeof r.nombre !== "string" || typeof r.eraPredeterminada !== "boolean") return false;
  const e = r.eliminados as Record<string, unknown> | undefined;
  if (typeof e !== "object" || e === null) return false;
  return CLAVES_DE_RECUENTO.every((k) => Number.isInteger(e[k]) && (e[k] as number) >= 0);
}

/** Un 4xx que respondió el servidor: la operación no se aplicó. */
function esRechazoConocido(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status >= 400 && err.status < 500;
}

/** Lee la competencia para saber si sigue existiendo. Nunca lanza. */
export async function comprobarEstadoDeCompetencia(leer: OperacionesDeEliminacion["leer"], id: string): Promise<DesenlaceDeEliminacion> {
  try {
    await leer(id);
    return { tipo: "sigue-existiendo" };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { tipo: "no-existe", trasIncertidumbre: true };
    return { tipo: "sin-confirmar" };
  }
}

/** Envía el DELETE UNA vez y, si la respuesta no es concluyente, comprueba por lectura. Nunca lanza. */
export async function eliminarYConfirmar(ops: OperacionesDeEliminacion, id: string): Promise<DesenlaceDeEliminacion> {
  let respuesta: unknown;
  try {
    respuesta = await ops.eliminar(id);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { tipo: "no-existe", trasIncertidumbre: false };
    if (esRechazoConocido(err)) return { tipo: "rechazada", mensaje: err.message };
    return comprobarEstadoDeCompetencia(ops.leer, id);
  }
  if (esResultadoDeEliminacion(respuesta, id)) return { tipo: "eliminada", resultado: respuesta };
  return comprobarEstadoDeCompetencia(ops.leer, id);
}

export interface MensajeDeEliminacion {
  texto: string;
  /** `exito` → aviso de estado; `problema` → alerta. */
  tono: "exito" | "problema";
  /** Ofrecer «Comprobar de nuevo» (solo lectura). */
  comprobarDeNuevo: boolean;
}

const INCIERTO = "No se pudo confirmar la respuesta del servidor.";

export function mensajeDeEliminacion(d: DesenlaceDeEliminacion, nombre: string): MensajeDeEliminacion {
  switch (d.tipo) {
    case "eliminada":
      return { texto: resumenDeEliminacion(d.resultado), tono: "exito", comprobarDeNuevo: false };
    case "rechazada":
      return { texto: `No se eliminó «${nombre}»: ${d.mensaje}`, tono: "problema", comprobarDeNuevo: false };
    case "no-existe":
      return d.trasIncertidumbre
        ? {
            texto: `${INCIERTO} Al comprobarlo, la competencia «${nombre}» ya no existe. No hay recuentos de lo eliminado.`,
            tono: "problema",
            comprobarDeNuevo: false,
          }
        : { texto: `La competencia «${nombre}» ya no existe. No hay recuentos de lo eliminado.`, tono: "problema", comprobarDeNuevo: false };
    case "sigue-existiendo":
      return {
        texto: `${INCIERTO} Al comprobarlo, la competencia «${nombre}» todavía existe. Vuelva a cargar la página antes de intentarlo de nuevo.`,
        tono: "problema",
        comprobarDeNuevo: false,
      };
    case "sin-confirmar":
      return {
        texto: `No se pudo confirmar si «${nombre}» se eliminó ni comprobar su estado. Compruébelo de nuevo en unos momentos; no vuelva a eliminarla sin comprobar.`,
        tono: "problema",
        comprobarDeNuevo: true,
      };
  }
}
