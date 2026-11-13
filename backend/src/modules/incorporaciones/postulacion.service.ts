/**
 * C-05: postulación de incorporaciones por RUN.
 *
 * FLUJO DEL CLUB (cuenta del club, delegado, entrenador o representante legal, en su club):
 *
 *   0. Estructura y autorización, ANTES de cobrar: permiso (ruta), alcance del club (de la
 *      sesión; un `clubId` ajeno es 403), cabecera `Idempotency-Key` y club activo. Nada de
 *      esto consume cuota, así que una solicitud no autorizada no gasta la cuota de nadie.
 *   1. T1 (cobro, transacción propia) bajo el bloqueo de la cuota del club y del día de
 *      Santiago: resuelve la idempotencia, marca interrumpidos los intentos en curso antiguos
 *      del club, retira RUN temporales vencidos, cuenta y, si queda cuota, inserta el intento
 *      `en_curso` con un `token_ejecucion` nuevo y CONFIRMA. A partir de aquí el intento cuenta.
 *   2. T2 (resolución, otra transacción): adquiere el DERECHO de ejecución bloqueando la fila
 *      del intento solo si sigue `en_curso` con SU token. Un proceso que perdió ese derecho
 *      (intento ya interrumpido o resuelto) no hace nada. Valida el RUN, busca la coincidencia
 *      exacta y decide. Los rechazos esperados se CONFIRMAN con su resultado y recién después
 *      se traducen a la respuesta: el intento queda contado aunque la respuesta sea un error.
 *      Un fallo técnico revierte T2 (no queda propuesta ni auditoría, no se devuelven datos) y
 *      el intento cobrado se conserva, marcado `error_tecnico` o, si eso también falla,
 *      `interrumpido` por el mantenimiento.
 *
 * Orden de bloqueos: cuota (solo en T1) · club → RUN → intento → persona → membresías → periodo.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/prisma.client";
import { AppError, ForbiddenError, ServiceUnavailableError, ValidationError } from "../../shared/errors";
import type { ActorContext } from "../../shared/actorContext";
import { fechaCalendarioAUtc, hoyEnZonaDelNegocio } from "../../shared/fecha.util";
import { normalizeRun, validateRun } from "../../shared/run.util";
import { audit } from "../audit/audit.service";
import { bloquear, bloquearMembresiasDePersona } from "../swimmer-assignment/membresias.protocolo";
import { assertClubActive } from "../swimmer-assignment/assignment.service";
import type { PostulacionInput, SegundoPasoInput } from "../swimmer-assignment/assignment.schemas";
import { errorTecnico } from "./causaTecnica";
import { CLAVES_DE_BLOQUEO, CUOTA_DIARIA_POR_CLUB, FORMATO_CLAVE_IDEMPOTENCIA, PLAZOS, huellaDeAlta, huellaDePostulacion } from "./incorporaciones.claves";

type Tx = Prisma.TransactionClient;
type EstadoIntento = Prisma.IntentoIncorporacionGetPayload<object>["estado"];

// ---------------------------------------------------------------------------
// Secreto (el mismo que el limitador, con propósito propio; ver incorporaciones.claves.ts)
// ---------------------------------------------------------------------------

let secretoActual: string | null = null;

/** Lo fija el servidor con la configuración validada. Sin configurar, se toma del entorno. */
export function configurarIncorporaciones(secreto: string): void {
  secretoActual = secreto;
}

function secreto(): string {
  if (!secretoActual) {
    const valor = process.env.AUTH_LIMITER_SECRET;
    if (!valor || valor.length < 32) throw new Error("AUTH_LIMITER_SECRET no está configurado (al menos 32 caracteres)");
    secretoActual = valor;
  }
  return secretoActual;
}

/** Instante como `timestamp` UTC, la misma convención con que Prisma guarda `DateTime`. */
const t = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

// ---------------------------------------------------------------------------
// Respuestas y rechazos
// ---------------------------------------------------------------------------

export interface Cuota {
  usados: number;
  limite: number;
  dia: string;
}

const RECHAZOS: Partial<Record<EstadoIntento, { status: number; codigo: string; mensaje: string }>> = {
  run_invalido: { status: 400, codigo: "RUN_INVALIDO", mensaje: "El RUN no es válido (formato o dígito verificador)." },
  duplicado: {
    status: 409,
    codigo: "DUPLICADO",
    mensaje: "Ya existe una propuesta o solicitud pendiente para este RUN en este club, o el nadador ya pertenece a él.",
  },
  fuera_de_periodo: {
    status: 409,
    codigo: "MEMBRESIA_ACTIVA_FUERA_DE_PERIODO",
    mensaje:
      "La persona tiene una membresía activa en otro club. Un cambio de club solo puede postularse durante un periodo habilitado por la administración.",
  },
  club_no_disponible: { status: 409, codigo: "CLUB_NO_DISPONIBLE", mensaje: "El club no está activo." },
  interrumpido: {
    status: 409,
    codigo: "INTENTO_INTERRUMPIDO",
    mensaje: "El intento anterior con esta clave se interrumpió. Vuelva a intentarlo con una clave nueva.",
  },
  error_tecnico: {
    status: 409,
    codigo: "INTENTO_INTERRUMPIDO",
    mensaje: "El intento anterior con esta clave se interrumpió. Vuelva a intentarlo con una clave nueva.",
  },
};

function rechazo(estado: EstadoIntento, cuota?: Cuota): AppError {
  const r = RECHAZOS[estado];
  if (!r) return new ServiceUnavailableError();
  return new AppError(r.status, r.codigo, r.mensaje, cuota ? { cuota } : undefined);
}

const errorDePaso = (codigo: "PASO_VENCIDO" | "PASO_YA_UTILIZADO" | "PASO_NO_DISPONIBLE") =>
  new AppError(
    409,
    codigo,
    codigo === "PASO_VENCIDO"
      ? "El plazo para completar nombre y apellido venció. Inicie una nueva postulación."
      : codigo === "PASO_YA_UTILIZADO"
        ? "Este paso ya se completó con otros datos."
        : "Este intento no admite completar nombre y apellido."
  );

export interface Resultado {
  http: 200 | 201;
  cuerpo: Record<string, unknown>;
}

/** Datos visibles de una propuesta para su club: los acordados (nombre, id y RUN). */
async function vistaDePropuesta(id: string) {
  const p = await prisma.clubSwimmer.findUnique({
    where: { id },
    include: { club: { select: { id: true, name: true } }, person: { select: { id: true, fullName: true, run: true } } },
  });
  if (!p) return null;
  return { id: p.id, status: p.status, club: p.club, person: p.person, createdAt: p.createdAt };
}

/** Datos visibles de una solicitud de alta para su club. */
export async function vistaDeSolicitud(id: string) {
  const s = await prisma.solicitudAltaIncorporacion.findUnique({
    where: { id },
    include: { club: { select: { id: true, name: true } }, persona: { select: { id: true, fullName: true, run: true } } },
  });
  if (!s) return null;
  return {
    id: s.id,
    estado: s.estado,
    club: s.club,
    run: s.runNormalizado,
    nombres: s.nombresDeclarados,
    apellidos: s.apellidosDeclarados,
    creadoEn: s.creadoEn,
    revisadoEn: s.revisadoEn,
    motivoRechazo: s.motivoRechazo,
    persona: s.persona,
  };
}

// ---------------------------------------------------------------------------
// Cuota
// ---------------------------------------------------------------------------

export async function cuotaDelClub(clubId: string, ahora: Date = new Date()): Promise<Cuota & { restantes: number }> {
  const dia = hoyEnZonaDelNegocio(ahora);
  const usados = await prisma.intentoIncorporacion.count({ where: { clubId, dia: fechaCalendarioAUtc(dia) } });
  return { usados, limite: CUOTA_DIARIA_POR_CLUB, dia, restantes: Math.max(0, CUOTA_DIARIA_POR_CLUB - usados) };
}

async function avisarCuotaAgotada(tx: Tx, clubId: string, userId: string, dia: string) {
  // Un aviso como mucho por club y día: la auditoría no se llena con cada rechazo.
  const entityId = `${clubId}:${dia}`;
  const previo = await tx.auditLog.findFirst({ where: { entityType: "CuotaIncorporacion", entityId }, select: { id: true } });
  if (!previo) {
    await audit({ userId, action: "INCORPORATION_QUOTA_EXHAUSTED", entityType: "CuotaIncorporacion", entityId, after: { clubId, dia, limite: CUOTA_DIARIA_POR_CLUB } }, { tx });
  }
}

// ---------------------------------------------------------------------------
// Mantenimiento: intentos interrumpidos y RUN temporal vencido
// ---------------------------------------------------------------------------

/** Marca `interrumpido` los intentos `en_curso` más antiguos que el plazo. Salta los bloqueados (T2 vivo). */
async function marcarInterrumpidos(db: Tx | typeof prisma, ahora: Date, clubId?: string): Promise<number> {
  const limite = new Date(ahora.getTime() - PLAZOS.enCursoMs);
  const delClub = clubId ? Prisma.sql`AND club_id = ${clubId}` : Prisma.empty;
  return db.$executeRaw`
    UPDATE intentos_incorporacion SET estado = 'interrumpido', resuelto_en = ${t(ahora)}
     WHERE id IN (SELECT id FROM intentos_incorporacion
                   WHERE estado = 'en_curso' AND creado_en < ${t(limite)} ${delClub}
                   ORDER BY creado_en LIMIT ${PLAZOS.loteMantenimiento}
                     FOR UPDATE SKIP LOCKED)`;
}

/** Retira el RUN temporal de los segundos pasos vencidos sin consumir. */
async function retirarRunsVencidos(db: Tx | typeof prisma, ahora: Date, clubId?: string): Promise<number> {
  const delClub = clubId ? Prisma.sql`AND club_id = ${clubId}` : Prisma.empty;
  return db.$executeRaw`
    UPDATE intentos_incorporacion SET run_normalizado = NULL
     WHERE id IN (SELECT id FROM intentos_incorporacion
                   WHERE run_normalizado IS NOT NULL AND expira_en <= ${t(ahora)} ${delClub}
                   ORDER BY expira_en LIMIT ${PLAZOS.loteMantenimiento}
                     FOR UPDATE SKIP LOCKED)`;
}

/** Barrido completo, en lotes. Lo corre el temporizador de la API al arrancar y cada 5 minutos. */
export async function mantenerIntentos(ahora: Date = new Date()): Promise<{ interrumpidos: number; runsRetirados: number }> {
  let interrumpidos = 0;
  let runsRetirados = 0;
  for (;;) {
    const n = await marcarInterrumpidos(prisma, ahora);
    interrumpidos += n;
    if (n < PLAZOS.loteMantenimiento) break;
  }
  for (;;) {
    const n = await retirarRunsVencidos(prisma, ahora);
    runsRetirados += n;
    if (n < PLAZOS.loteMantenimiento) break;
  }
  return { interrumpidos, runsRetirados };
}

export function iniciarMantenimientoDeIncorporaciones(log: { error: (o: object, m: string) => void }): () => void {
  let enMarcha = false;
  const vuelta = async () => {
    if (enMarcha) return;
    enMarcha = true;
    try {
      await mantenerIntentos();
    } catch (err) {
      log.error({ err }, "incorporaciones: falló el mantenimiento de intentos");
    } finally {
      enMarcha = false;
    }
  };
  void vuelta();
  const temporizador = setInterval(() => void vuelta(), PLAZOS.intervaloMantenimientoMs);
  temporizador.unref();
  return () => clearInterval(temporizador);
}

// ---------------------------------------------------------------------------
// Decisión común (T2, segundo paso): propuesta pendiente o rechazo registrado
// ---------------------------------------------------------------------------

type Decision =
  | { tipo: "rechazo"; estado: "duplicado" | "fuera_de_periodo" }
  | { tipo: "propuesta"; propuestaId: string; tipoPropuesta: "alta" | "cambio" };

/**
 * Con el club, el RUN y la persona bloqueados: membresías, periodo y duplicados, y la propuesta
 * con su auditoría. `exigePeriodo` es el club; administración puede postular en cualquier fecha.
 */
async function proponer(
  tx: Tx,
  p: { clubId: string; personId: string; userId: string; ipAddress?: string; dia: string; exigePeriodo: boolean; intentoId?: string; via: string }
): Promise<Decision> {
  const bloqueadas = await bloquearMembresiasDePersona(tx, p.personId);
  if (bloqueadas.some((m) => m.club_id === p.clubId)) return { tipo: "rechazo", estado: "duplicado" };

  const activaEnOtro = bloqueadas.some((m) => m.status === "active");
  if (activaEnOtro && p.exigePeriodo) {
    // FOR SHARE: un cierre concurrente del periodo espera a que esta postulación termine.
    const periodo = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM periodos_cambio_club
       WHERE cerrado_en IS NULL AND inicio <= ${p.dia}::date AND fin >= ${p.dia}::date
         FOR SHARE`;
    if (periodo.length === 0) return { tipo: "rechazo", estado: "fuera_de_periodo" };
  }

  const propuesta = await tx.clubSwimmer.create({
    data: { clubId: p.clubId, personId: p.personId, status: "pending", requestedByUserId: p.userId },
  });
  const tipoPropuesta = activaEnOtro ? "cambio" : "alta";
  await audit(
    {
      userId: p.userId,
      action: "SWIMMER_ASSIGNMENT_PROPOSED",
      entityType: "ClubSwimmer",
      entityId: propuesta.id,
      ipAddress: p.ipAddress,
      after: { ...propuesta, tipo: tipoPropuesta, intentoId: p.intentoId ?? null, via: p.via },
    },
    { tx }
  );
  return { tipo: "propuesta", propuestaId: propuesta.id, tipoPropuesta };
}

// ---------------------------------------------------------------------------
// Club: T1 + T2
// ---------------------------------------------------------------------------

type Cobro =
  | { tipo: "repeticion"; previo: Prisma.IntentoIncorporacionGetPayload<object> }
  | { tipo: "agotada"; cuota: Cuota }
  | { tipo: "cobrado"; intentoId: string; token: string; cuota: Cuota };

async function cobrar(clubId: string, userId: string, clave: string, huella: Buffer, ahora: Date): Promise<Cobro> {
  const dia = hoyEnZonaDelNegocio(ahora);
  return prisma.$transaction(async (tx) => {
    await bloquear(tx, CLAVES_DE_BLOQUEO.cuota(clubId, dia));
    const previo = await tx.intentoIncorporacion.findUnique({
      where: { clubId_userId_claveIdempotencia: { clubId, userId, claveIdempotencia: clave } },
    });
    if (previo) return { tipo: "repeticion" as const, previo };

    await marcarInterrumpidos(tx, ahora, clubId);
    await retirarRunsVencidos(tx, ahora, clubId);

    const usados = await tx.intentoIncorporacion.count({ where: { clubId, dia: fechaCalendarioAUtc(dia) } });
    if (usados >= CUOTA_DIARIA_POR_CLUB) {
      await avisarCuotaAgotada(tx, clubId, userId, dia);
      return { tipo: "agotada" as const, cuota: { usados, limite: CUOTA_DIARIA_POR_CLUB, dia } };
    }
    const token = randomUUID();
    const intento = await tx.intentoIncorporacion.create({
      data: {
        clubId,
        userId,
        dia: fechaCalendarioAUtc(dia),
        claveIdempotencia: clave,
        huellaContenido: huella,
        estado: "en_curso",
        tokenEjecucion: token,
        creadoEn: ahora,
      },
    });
    return { tipo: "cobrado" as const, intentoId: intento.id, token, cuota: { usados: usados + 1, limite: CUOTA_DIARIA_POR_CLUB, dia } };
  });
}

type ResultadoT2 =
  | { tipo: "sin_derecho" }
  | { tipo: "rechazo"; estado: EstadoIntento }
  | { tipo: "requiere_alta"; expiraEn: Date }
  | { tipo: "propuesta"; propuestaId: string; tipoPropuesta: "alta" | "cambio" };

/** T2: adquiere el derecho de ejecución (estado + token) y resuelve. */
async function resolver(
  intento: { id: string; token: string },
  p: { clubId: string; userId: string; ipAddress?: string; runEntrada: string; ahora: Date }
): Promise<ResultadoT2> {
  const dia = hoyEnZonaDelNegocio(p.ahora);
  return prisma.$transaction(
    async (tx) => {
      await bloquear(tx, CLAVES_DE_BLOQUEO.club(p.clubId));
      const validez = validateRun(p.runEntrada);
      const run = normalizeRun(p.runEntrada);
      if (validez.valid) await bloquear(tx, CLAVES_DE_BLOQUEO.run(run));

      const derecho = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM intentos_incorporacion
         WHERE id = ${intento.id} AND estado = 'en_curso' AND token_ejecucion = ${intento.token}::uuid
           FOR UPDATE`;
      if (derecho.length === 0) return { tipo: "sin_derecho" as const };

      // Columnas, no relaciones: con `connect` Prisma escribe la referencia en una SEGUNDA
      // sentencia, y la restricción de coherencia (estado ↔ propuesta) rechaza la primera.
      const cerrar = (estado: EstadoIntento, extra: Prisma.IntentoIncorporacionUncheckedUpdateInput = {}) =>
        tx.intentoIncorporacion.update({ where: { id: intento.id }, data: { estado, resueltoEn: p.ahora, ...extra } });

      if (!validez.valid) {
        await cerrar("run_invalido");
        return { tipo: "rechazo" as const, estado: "run_invalido" as const };
      }
      const club = await tx.club.findFirst({ where: { id: p.clubId, deletedAt: null }, select: { status: true } });
      if (!club || club.status !== "active") {
        await cerrar("club_no_disponible");
        return { tipo: "rechazo" as const, estado: "club_no_disponible" as const };
      }

      // Coincidencia EXACTA con una persona NO eliminada. Una eliminada no cuenta: el club sigue
      // el flujo de alta y no recibe nada del registro eliminado.
      const persona = await tx.person.findFirst({ where: { run, deletedAt: null }, select: { id: true } });
      if (!persona) {
        const expiraEn = new Date(p.ahora.getTime() + PLAZOS.segundoPasoMs);
        await cerrar("requiere_alta", { runNormalizado: run, expiraEn });
        return { tipo: "requiere_alta" as const, expiraEn };
      }

      const d = await proponer(tx, {
        clubId: p.clubId,
        personId: persona.id,
        userId: p.userId,
        ipAddress: p.ipAddress,
        dia,
        exigePeriodo: true,
        intentoId: intento.id,
        via: "postulacion-club",
      });
      if (d.tipo === "rechazo") {
        await cerrar(d.estado);
        return d;
      }
      await cerrar("propuesta_creada", { propuestaId: d.propuestaId });
      return d;
    },
    { timeout: PLAZOS.resolucionMs, maxWait: 5_000 }
  );
}

/** Marca el intento como `error_tecnico` si sigue en curso con su token. Mejor esfuerzo. */
async function marcarErrorTecnico(intento: { id: string; token: string }, ahora: Date) {
  await prisma.$executeRaw`
    UPDATE intentos_incorporacion SET estado = 'error_tecnico', resuelto_en = ${t(ahora)}
     WHERE id = ${intento.id} AND estado = 'en_curso' AND token_ejecucion = ${intento.token}::uuid`;
}

/** Repetición con la misma clave: nunca vuelve a buscar; responde con el estado actual. */
async function responderRepeticion(previo: Prisma.IntentoIncorporacionGetPayload<object>, huella: Buffer, ahora: Date): Promise<Resultado> {
  if (!Buffer.from(previo.huellaContenido).equals(huella)) {
    throw new AppError(409, "IDEMPOTENCIA_CONFLICTO", "Esta clave de idempotencia ya se usó con otro contenido. Genere una clave nueva para una postulación distinta.");
  }
  switch (previo.estado) {
    case "en_curso":
      if (previo.creadoEn.getTime() < ahora.getTime() - PLAZOS.enCursoMs) throw rechazo("interrumpido");
      throw new AppError(409, "OPERACION_EN_CURSO", "La postulación con esta clave todavía se está procesando. Reintente en unos segundos.", { reintentarEnSegundos: 2 });
    case "propuesta_creada":
    case "resuelto_por_propuesta": {
      const propuesta = previo.propuestaId ? await vistaDePropuesta(previo.propuestaId) : null;
      return { http: 200, cuerpo: { resultado: "propuesta_creada", repeticion: true, propuesta } };
    }
    case "requiere_alta":
      if (!previo.runNormalizado || !previo.expiraEn || previo.expiraEn <= ahora) throw errorDePaso("PASO_VENCIDO");
      return { http: 200, cuerpo: { resultado: "requiere_datos_de_alta", repeticion: true, intentoId: previo.id, expiraEn: previo.expiraEn } };
    case "alta_registrada": {
      const solicitud = await prisma.solicitudAltaIncorporacion.findUnique({ where: { intentoId: previo.id }, select: { id: true } });
      return { http: 200, cuerpo: { resultado: "solicitud_alta_creada", repeticion: true, solicitud: solicitud ? await vistaDeSolicitud(solicitud.id) : null } };
    }
    default:
      throw rechazo(previo.estado);
  }
}

export async function postularComoClub(input: PostulacionInput, actor: ActorContext, claveIdempotencia: string | undefined, opciones?: { ahora?: Date }): Promise<Resultado> {
  // 0. Estructura y autorización: antes del cobro.
  if (actor.scope.kind !== "club") throw new ForbiddenError("Solo el club y su personal postulan por esta vía.");
  const clubId = actor.scope.clubId;
  if (input.clubId && input.clubId !== clubId) throw new ForbiddenError("No tiene permiso para operar sobre datos de otro club.");
  if (!claveIdempotencia || !FORMATO_CLAVE_IDEMPOTENCIA.test(claveIdempotencia)) {
    throw new AppError(400, "IDEMPOTENCIA_REQUERIDA", "Falta la cabecera Idempotency-Key (8 a 64 caracteres: letras, números, «-» o «_»).");
  }
  const club = await prisma.club.findFirst({ where: { id: clubId, deletedAt: null }, select: { status: true } });
  if (!club || club.status !== "active") throw new AppError(409, "CLUB_NO_DISPONIBLE", "El club no está activo.");

  const ahora = opciones?.ahora ?? new Date();
  const huella = huellaDePostulacion(secreto(), clubId, normalizeRun(input.run));

  // 1. T1: cobro.
  let cobro: Cobro;
  try {
    cobro = await cobrar(clubId, actor.userId, claveIdempotencia, huella, ahora);
  } catch (err) {
    // Antes de confirmar T1: no se consumió cuota. La causa va saneada al registro (`causaTecnica`).
    throw errorTecnico(err);
  }
  if (cobro.tipo === "repeticion") return responderRepeticion(cobro.previo, huella, ahora);
  if (cobro.tipo === "agotada") {
    throw new AppError(429, "CUOTA_AGOTADA", `El club alcanzó los ${CUOTA_DIARIA_POR_CLUB} intentos de hoy. Podrá volver a postular mañana.`, { cuota: cobro.cuota });
  }

  // 2. T2: resolución.
  const intento = { id: cobro.intentoId, token: cobro.token };
  let r: ResultadoT2;
  try {
    r = await resolver(intento, { clubId, userId: actor.userId, ipAddress: actor.ipAddress, runEntrada: input.run, ahora });
  } catch (err) {
    await marcarErrorTecnico(intento, ahora).catch(() => undefined);
    // Sin datos personales; el intento cobrado se conserva. La causa va saneada al registro.
    throw errorTecnico(err);
  }

  switch (r.tipo) {
    case "sin_derecho":
      throw rechazo("interrumpido", cobro.cuota);
    case "rechazo":
      throw rechazo(r.estado, cobro.cuota);
    case "requiere_alta":
      return { http: 200, cuerpo: { resultado: "requiere_datos_de_alta", intentoId: intento.id, expiraEn: r.expiraEn, cuota: cobro.cuota } };
    case "propuesta": {
      const propuesta = await vistaDePropuesta(r.propuestaId);
      return { http: 201, cuerpo: { resultado: "propuesta_creada", propuesta: propuesta && { ...propuesta, tipo: r.tipoPropuesta }, cuota: cobro.cuota } };
    }
  }
}

// ---------------------------------------------------------------------------
// Segundo paso del club: nombre y apellido de un RUN no registrado
// ---------------------------------------------------------------------------

const normalizarNombre = (s: string) => s.trim().replace(/\s+/g, " ");

type ResultadoPaso =
  | { tipo: "no_encontrado" }
  | { tipo: "error"; error: AppError }
  | { tipo: "repeticion"; estado: EstadoIntento; intentoId: string; propuestaId: string | null }
  | { tipo: "rechazo"; estado: EstadoIntento }
  | { tipo: "propuesta"; propuestaId: string; tipoPropuesta: "alta" | "cambio" }
  | { tipo: "solicitud"; solicitudId: string };

/**
 * Ligado al intento ORIGINAL (su club, su usuario y su RUN, que no se pueden sustituir), de uso
 * único y con vencimiento. No cobra cuota: consume el intento ya cobrado. Si entre los dos pasos
 * se registró a la persona, se vuelven a aplicar las reglas de la postulación y, si corresponde,
 * se crea la propuesta.
 */
export async function completarAlta(input: SegundoPasoInput, actor: ActorContext, opciones?: { ahora?: Date }): Promise<Resultado> {
  if (actor.scope.kind !== "club") throw new ForbiddenError("Solo el club y su personal completan este paso.");
  const clubId = actor.scope.clubId;
  const ahora = opciones?.ahora ?? new Date();
  const nombres = normalizarNombre(input.nombres);
  const apellidos = normalizarNombre(input.apellidos);
  const huella = huellaDeAlta(secreto(), input.intentoId, nombres, apellidos);
  const dia = hoyEnZonaDelNegocio(ahora);

  let r: ResultadoPaso;
  try {
    r = await prisma.$transaction(
      async (tx): Promise<ResultadoPaso> => {
        await bloquear(tx, CLAVES_DE_BLOQUEO.club(clubId));
        // El intento solo existe para su club y su usuario: otro actor recibe lo mismo que si no existiera.
        const previo = await tx.intentoIncorporacion.findFirst({ where: { id: input.intentoId, clubId, userId: actor.userId }, select: { runNormalizado: true } });
        if (!previo) return { tipo: "no_encontrado" };
        if (previo.runNormalizado) await bloquear(tx, CLAVES_DE_BLOQUEO.run(previo.runNormalizado));
        await tx.$queryRaw`SELECT id FROM intentos_incorporacion WHERE id = ${input.intentoId} FOR UPDATE`;
        const intento = await tx.intentoIncorporacion.findUniqueOrThrow({ where: { id: input.intentoId } });

        if (intento.consumidoEn) {
          if (intento.huellaAlta && Buffer.from(intento.huellaAlta).equals(huella)) {
            return { tipo: "repeticion", estado: intento.estado, intentoId: intento.id, propuestaId: intento.propuestaId };
          }
          return { tipo: "error", error: errorDePaso("PASO_YA_UTILIZADO") };
        }
        if (intento.estado !== "requiere_alta") return { tipo: "error", error: errorDePaso("PASO_NO_DISPONIBLE") };
        if (!intento.runNormalizado || !intento.expiraEn || intento.expiraEn <= ahora) {
          if (intento.runNormalizado) await tx.intentoIncorporacion.update({ where: { id: intento.id }, data: { runNormalizado: null } });
          return { tipo: "error", error: errorDePaso("PASO_VENCIDO") };
        }
        const run = intento.runNormalizado;
        const consumir = (estado: EstadoIntento, extra: Prisma.IntentoIncorporacionUncheckedUpdateInput = {}) =>
          tx.intentoIncorporacion.update({ where: { id: intento.id }, data: { estado, consumidoEn: ahora, huellaAlta: huella, runNormalizado: null, ...extra } });

        const club = await tx.club.findFirst({ where: { id: clubId, deletedAt: null }, select: { status: true } });
        if (!club || club.status !== "active") {
          await consumir("club_no_disponible");
          return { tipo: "rechazo", estado: "club_no_disponible" };
        }

        const persona = await tx.person.findFirst({ where: { run, deletedAt: null }, select: { id: true } });
        if (persona) {
          const d = await proponer(tx, { clubId, personId: persona.id, userId: actor.userId, ipAddress: actor.ipAddress, dia, exigePeriodo: true, intentoId: intento.id, via: "segundo-paso" });
          if (d.tipo === "rechazo") {
            await consumir(d.estado);
            return d;
          }
          await consumir("resuelto_por_propuesta", { propuestaId: d.propuestaId });
          return d;
        }

        const duplicada = await tx.solicitudAltaIncorporacion.findFirst({ where: { clubId, runNormalizado: run, estado: "pendiente" }, select: { id: true } });
        if (duplicada) {
          await consumir("duplicado");
          return { tipo: "rechazo", estado: "duplicado" };
        }
        const solicitud = await tx.solicitudAltaIncorporacion.create({
          data: {
            clubId,
            intentoId: intento.id,
            runNormalizado: run,
            nombresDeclarados: nombres,
            apellidosDeclarados: apellidos,
            solicitadoPorUserId: actor.userId,
            creadoEn: ahora,
          },
        });
        await consumir("alta_registrada");
        // Solo identificadores: los datos declarados viven en la solicitud, de acceso restringido.
        await audit(
          {
            userId: actor.userId,
            action: "SWIMMER_INCORPORATION_REQUEST_CREATED",
            entityType: "SolicitudAltaIncorporacion",
            entityId: solicitud.id,
            ipAddress: actor.ipAddress,
            after: { id: solicitud.id, clubId, intentoId: intento.id },
          },
          { tx }
        );
        return { tipo: "solicitud", solicitudId: solicitud.id };
      },
      { timeout: PLAZOS.resolucionMs, maxWait: 5_000 }
    );
  } catch (err) {
    throw errorTecnico(err);
  }

  switch (r.tipo) {
    case "no_encontrado":
      throw new AppError(404, "PASO_NO_ENCONTRADO", "No hay un paso pendiente con ese identificador para su cuenta.");
    case "error":
      throw r.error;
    case "rechazo":
      throw rechazo(r.estado);
    case "propuesta":
      return { http: 201, cuerpo: { resultado: "propuesta_creada", propuesta: await vistaDePropuesta(r.propuestaId) } };
    case "solicitud":
      return { http: 201, cuerpo: { resultado: "solicitud_alta_creada", solicitud: await vistaDeSolicitud(r.solicitudId) } };
    case "repeticion": {
      if (r.estado === "alta_registrada") {
        const s = await prisma.solicitudAltaIncorporacion.findUnique({ where: { intentoId: r.intentoId }, select: { id: true } });
        return { http: 200, cuerpo: { resultado: "solicitud_alta_creada", repeticion: true, solicitud: s ? await vistaDeSolicitud(s.id) : null } };
      }
      if (r.estado === "resuelto_por_propuesta" && r.propuestaId) {
        return { http: 200, cuerpo: { resultado: "propuesta_creada", repeticion: true, propuesta: await vistaDePropuesta(r.propuestaId) } };
      }
      throw rechazo(r.estado);
    }
  }
}

// ---------------------------------------------------------------------------
// Administración: postulación por RUN con club explícito (sin cuota ni periodo)
// ---------------------------------------------------------------------------

/**
 * Administración puede postular por RUN indicando el club. No pasa por la cuota (es del club) ni
 * exige periodo (administración cambia de club en cualquier fecha). Un RUN sin persona registrada
 * se responde 404: administración tiene la ficha de Personas para registrarla.
 */
export async function postularComoAdministracion(input: PostulacionInput, actor: ActorContext, opciones?: { ahora?: Date }): Promise<Resultado> {
  if (actor.scope.kind !== "admin") throw new ForbiddenError();
  if (!input.clubId) throw new ValidationError("Administración debe indicar el club (clubId).");
  const clubId = input.clubId;
  if (!validateRun(input.run).valid) throw new AppError(400, "RUN_INVALIDO", "El RUN no es válido (formato o dígito verificador).");
  const run = normalizeRun(input.run);
  const dia = hoyEnZonaDelNegocio(opciones?.ahora ?? new Date());

  const d = await prisma.$transaction(async (tx) => {
    await assertClubActive(clubId, tx);
    await bloquear(tx, CLAVES_DE_BLOQUEO.run(run));
    const persona = await tx.person.findFirst({ where: { run, deletedAt: null }, select: { id: true } });
    if (!persona) {
      throw new AppError(404, "PERSONA_NO_REGISTRADA", "No hay una persona registrada con ese RUN. Regístrela en Personas o resuelva la solicitud de alta del club.");
    }
    return proponer(tx, { clubId, personId: persona.id, userId: actor.userId, ipAddress: actor.ipAddress, dia, exigePeriodo: false, via: "administracion" });
  });
  if (d.tipo === "rechazo") throw rechazo(d.estado);
  const propuesta = await vistaDePropuesta(d.propuestaId);
  return { http: 201, cuerpo: { resultado: "propuesta_creada", propuesta: propuesta && { ...propuesta, tipo: d.tipoPropuesta } } };
}
