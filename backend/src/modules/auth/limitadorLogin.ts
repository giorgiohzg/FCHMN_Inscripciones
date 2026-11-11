/**
 * C-02: LIMITADOR DE LOGIN (política B).
 *
 * Sustituye el bloqueo temporal de la cuenta entera (RB-15), que permitía a cualquiera que
 * conociera un nombre de usuario dejar fuera a su dueño —y cortar sus sesiones— con cinco
 * contraseñas incorrectas cada quince minutos. Ahora un fallo de un tercero nunca cambia el
 * estado de la cuenta ni toca sus sesiones; lo que limita es:
 *
 *   | Capa   | Regla                                                                   |
 *   |--------|-------------------------------------------------------------------------|
 *   | Par    | 5 fallos en 15 min, ventana DESLIZANTE (filas de `lim_fallo_par`)       |
 *   | Origen | 50 fallos por ventana FIJA de 1 h, abierta por su primer fallo          |
 *   | Cuenta | 20 fallos VERIFICADOS por ventana fija de 1 h activan 60 min protegidos, |
 *   |        | que cada fallo verificado prolonga. Durante la protección, cada fallo    |
 *   |        | de un par impone a ESE par una espera propia de 15 min (política B):    |
 *   |        | los fallos de otros orígenes no la prolongan.                           |
 *
 * La cuenta no rechaza por sí misma: solo endurece la regla de sus pares.
 *
 * RESERVAS. Antes de calcular Argon2, la ADMISIÓN crea una reserva (token, `seq` global y
 * 30 s de vida) y el intento queda contado desde ese momento. La reserva ocupa presupuesto
 * del par y del origen HASTA QUE SE BORRA, haya vencido o no:
 *   - la LIQUIDACIÓN vigente la borra y aplica su resultado (fallo, acierto o neutro);
 *   - una reserva vencida se CONVIERTE en fallo no verificado —al admitir otro intento del
 *     mismo par, o en el barrido—, y una liquidación tardía la encuentra vencida: obsoleta,
 *     sin efectos (503). Cada reserva se cobra UNA sola vez: en el `DELETE … RETURNING`.
 *
 * PERDÓN POR ORDEN DE RESERVA. Un acierto con `seq = s` perdona los fallos del MISMO par con
 * `seq < s` (marca `perdonado_hasta_seq`), se liquiden antes o después. Nunca toca el origen
 * ni la cuenta: un acierto no termina el periodo protegido.
 *
 * BLOQUEOS, en este orden y nunca al revés:
 *   L2 `users` → L3/L4 sesiones → L5 bloqueos consultivos de las claves (orden numérico) →
 *   L6 filas del limitador → L7 `lim_capacidad` (al final, en orden de recurso).
 * La admisión y la liquidación toman solo L5–L7 y NUNCA van dentro de la transacción de
 * `users`; el restablecimiento de credenciales sí llega desde ella (L2 → … → L7).
 *
 * CAPACIDAD atómica: crear o borrar una fila ajusta `lim_capacidad` en la MISMA transacción
 * con `UPDATE … WHERE usadas + n <= cupo`. Sin cupo para una clave nueva o una reserva, el
 * intento recibe 503 SIN verificar la contraseña; las claves existentes no se ven afectadas.
 *
 * ROTACIÓN DEL SECRETO: NO IMPLEMENTADA. El estado guarda la huella del secreto
 * (`lim_configuracion`) y un proceso con otro secreto se niega a arrancar. Rotar exige un
 * procedimiento y una autorización específicos, posteriores.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../shared/prisma.client";
import { AppError, ServiceUnavailableError } from "../../shared/errors";
import { audit } from "../audit/audit.service";
import {
  PERFIL,
  TECNICO,
  RECURSO_RESERVAS,
  claveDe,
  claveDeBloqueo,
  clavesDeIntento,
  fragmentoDe,
  huellaDelSecreto,
  recursoDeFragmento,
  type ClavesDeIntento,
  type TipoDeClave,
} from "./limitadorClaves";

type Tx = Prisma.TransactionClient;

export const MENSAJE_LOGIN_LIMITADO = "Demasiados intentos de inicio de sesión. Espere unos minutos o intente desde otra red.";
export const MENSAJE_LOGIN_NO_COMPLETADO = "No se pudo completar el inicio de sesión. Intente nuevamente en unos instantes.";

/** 429 UNIFORME: el mismo para par, par protegido y origen, exista o no la cuenta. */
export class LoginLimitadoError extends AppError {
  constructor() {
    super(429, "LOGIN_THROTTLED", MENSAJE_LOGIN_LIMITADO);
  }
}

/** 503: saturación del limitador o resultado obsoleto. No dice nada sobre la contraseña. */
export const loginNoCompletado = () => new ServiceUnavailableError(MENSAJE_LOGIN_NO_COMPLETADO);

class CapacidadAgotada extends Error {
  constructor(readonly recurso: string) {
    super(`Capacidad del limitador agotada: ${recurso}`);
  }
}

// ---------------------------------------------------------------------------
// Configuración y utilidades
// ---------------------------------------------------------------------------

/**
 * El secreto lo fija el servidor con la configuración ya validada (`configurarLimitador`). Este
 * módulo NO importa `shared/env`, que valida `process.env` al importarse: lo importan servicios
 * que algunas pruebas unitarias cargan sin entorno. Sin configurar (llamadas internas y pruebas
 * que no construyen el servidor), se toma `AUTH_LIMITER_SECRET` del entorno con la misma
 * exigencia de longitud.
 */
let secretoActual: { secreto: string; huella: Buffer } | null = null;

export function configurarLimitador(secretoDelLimitador: string): void {
  secretoActual = { secreto: secretoDelLimitador, huella: huellaDelSecreto(secretoDelLimitador) };
}

function secreto(): { secreto: string; huella: Buffer } {
  if (!secretoActual) {
    const valor = process.env.AUTH_LIMITER_SECRET;
    if (!valor || valor.length < 32) throw new Error("AUTH_LIMITER_SECRET no está configurado (al menos 32 caracteres)");
    configurarLimitador(valor);
  }
  return secretoActual!;
}

/** Instante como `timestamp` UTC, la misma convención con que Prisma guarda `DateTime`. */
const t = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
const mas = (d: Date, ms: number) => new Date(d.getTime() + ms);

interface Fila {
  id: string;
  tipo: TipoDeClave;
  fragmento: number;
  cuentaId: string | null;
  ventanaInicio: Date | null;
  fallos: number;
  protegidoDesde: Date | null;
  protegidoHasta: Date | null;
  ultimoFalloEn: Date | null;
  perdonadoHastaSeq: bigint;
  rechazos: number;
  rechazoAvisadoEn: Date | null;
  venceEn: Date;
}

const COLUMNAS = Prisma.sql`id::text AS id, tipo, fragmento, cuenta_id::text AS "cuentaId",
  ventana_inicio AS "ventanaInicio", fallos, protegido_desde AS "protegidoDesde",
  protegido_hasta AS "protegidoHasta", ultimo_fallo_en AS "ultimoFalloEn",
  perdonado_hasta_seq AS "perdonadoHastaSeq", rechazos, rechazo_avisado_en AS "rechazoAvisadoEn",
  vence_en AS "venceEn"`;

const OPCIONES_TX = {
  isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
  maxWait: 5_000,
  timeout: 10_000,
} as const;

/** Interbloqueo (40P01) o espera de bloqueo vencida (55P03): la transacción se revirtió entera. */
function esReintentable(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; meta?: unknown };
  if (e?.code === "P2034") return true;
  const texto = `${String(e?.message ?? "")} ${JSON.stringify(e?.meta ?? {})}`;
  return /40P01|55P03|deadlock detected|lock timeout/i.test(texto);
}

/**
 * Transacción corta del limitador, con `lock_timeout` y como mucho `TECNICO.reintentos`
 * reintentos ante interbloqueo o espera vencida. Como la transacción se revierte entera
 * antes de reintentar, ningún efecto se duplica.
 */
async function enTransaccion<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${TECNICO.lockTimeout}'`);
        return fn(tx);
      }, OPCIONES_TX);
    } catch (err) {
      if (intento < TECNICO.reintentos && esReintentable(err)) continue;
      throw err;
    }
  }
}

/** L5: bloqueos consultivos de las claves, en orden numérico y sin repetir. */
async function bloquear(tx: Tx, claves: Buffer[]): Promise<void> {
  const numeros = [...new Set(claves.map(claveDeBloqueo))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // `$executeRaw`: la función devuelve `void`, una columna que `$queryRaw` no sabe leer.
  for (const n of numeros) await tx.$executeRaw`SELECT pg_advisory_xact_lock(${n})`;
}

async function leer(tx: Tx, tipo: TipoDeClave, clave: Buffer, huella: Buffer): Promise<Fila | null> {
  const filas = await tx.$queryRaw<Fila[]>`
    SELECT ${COLUMNAS} FROM lim_clave
     WHERE tipo = ${tipo} AND clave_hmac = ${clave} AND clave_version = ${huella}
       FOR UPDATE`;
  return filas[0] ?? null;
}

async function leerPorId(tx: Tx, id: string): Promise<Fila | null> {
  const filas = await tx.$queryRaw<Fila[]>`SELECT ${COLUMNAS} FROM lim_clave WHERE id = ${id}::uuid FOR UPDATE`;
  return filas[0] ?? null;
}

async function crear(tx: Tx, tipo: TipoDeClave, clave: Buffer, huella: Buffer, cuentaId: string | null, venceEn: Date): Promise<Fila> {
  const filas = await tx.$queryRaw<Fila[]>`
    INSERT INTO lim_clave (id, tipo, clave_hmac, clave_version, fragmento, cuenta_id, vence_en)
    VALUES (${randomUUID()}::uuid, ${tipo}, ${clave}, ${huella}, ${fragmentoDe(clave)}, ${cuentaId}::uuid, ${t(venceEn)})
    RETURNING ${COLUMNAS}`;
  return filas[0]!;
}

type CambiosDeCapacidad = Map<string, number>;
const sumar = (c: CambiosDeCapacidad, recurso: string, n: number) => c.set(recurso, (c.get(recurso) ?? 0) + n);
const cupoPorOmision = (recurso: string) => (recurso === RECURSO_RESERVAS ? TECNICO.cupoReservas : TECNICO.cupoClavesPorFragmento);

/**
 * L7, SIEMPRE lo último de la transacción y en orden de recurso. Un aumento sin cupo lanza
 * `CapacidadAgotada` y revierte TODO lo que la transacción creó. Una fila de capacidad que
 * falte (una base recién truncada) se recrea con su cupo por omisión.
 */
async function ajustarCapacidad(tx: Tx, cambios: CambiosDeCapacidad): Promise<void> {
  const recursos = [...cambios.entries()].filter(([, n]) => n !== 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [recurso, n] of recursos) {
    if (n < 0) {
      await tx.$executeRaw`UPDATE lim_capacidad SET usadas = GREATEST(usadas + ${n}::int, 0) WHERE recurso = ${recurso}`;
      continue;
    }
    for (let vuelta = 0; ; vuelta++) {
      const ok = await tx.$queryRaw<{ recurso: string }[]>`
        UPDATE lim_capacidad SET usadas = usadas + ${n}::int
         WHERE recurso = ${recurso} AND usadas + ${n}::int <= cupo
        RETURNING recurso`;
      if (ok.length > 0) break;
      const existe = await tx.$queryRaw<{ x: number }[]>`SELECT 1 AS x FROM lim_capacidad WHERE recurso = ${recurso}`;
      if (existe.length > 0 || vuelta > 0) throw new CapacidadAgotada(recurso);
      await tx.$executeRaw`
        INSERT INTO lim_capacidad (recurso, usadas, cupo) VALUES (${recurso}, 0, ${cupoPorOmision(recurso)}::int)
        ON CONFLICT (recurso) DO NOTHING`;
    }
  }
}

// ---------------------------------------------------------------------------
// Efectos de un fallo
// ---------------------------------------------------------------------------

/** Ventana fija: su inicio y fallos si sigue vigente; si no, una nueva que abre este fallo. */
function sumarEnVentana(inicio: Date | null, fallos: number, ahora: Date, ventanaMs: number): { inicio: Date; fallos: number } {
  if (inicio && inicio.getTime() + ventanaMs > ahora.getTime()) return { inicio, fallos: fallos + 1 };
  return { inicio: ahora, fallos: 1 };
}

async function sumarFalloOrigen(tx: Tx, origenId: string, ahora: Date): Promise<void> {
  const origen = await leerPorId(tx, origenId);
  if (!origen) return;
  const v = sumarEnVentana(origen.ventanaInicio, origen.fallos, ahora, PERFIL.origenVentanaMs);
  await tx.$executeRaw`
    UPDATE lim_clave SET ventana_inicio = ${t(v.inicio)}, fallos = ${v.fallos}::int,
           vence_en = GREATEST(vence_en, ${t(mas(v.inicio, PERFIL.origenVentanaMs))})
     WHERE id = ${origenId}::uuid`;
}

/** Fallo del par: solo si su `seq` es posterior a la marca de perdón. Conserva los más recientes. */
async function registrarFalloPar(tx: Tx, parId: string, seq: bigint, creadoEn: Date, verificado: boolean, ahora: Date): Promise<void> {
  const par = await leerPorId(tx, parId);
  if (!par || seq <= par.perdonadoHastaSeq) return;
  await tx.$executeRaw`
    INSERT INTO lim_fallo_par (par_id, seq, creado_en, verificado)
    VALUES (${parId}::uuid, ${seq}, ${t(creadoEn)}, ${verificado})
    ON CONFLICT (par_id, seq) DO NOTHING`;
  await tx.$executeRaw`
    UPDATE lim_clave SET ultimo_fallo_en = GREATEST(ultimo_fallo_en, ${t(creadoEn)}),
           vence_en = GREATEST(vence_en, ${t(mas(creadoEn, PERFIL.parVentanaMs))}, ${t(mas(ahora, PERFIL.parVentanaMs))})
     WHERE id = ${parId}::uuid`;
  await tx.$executeRaw`
    DELETE FROM lim_fallo_par
     WHERE par_id = ${parId}::uuid
       AND seq NOT IN (SELECT seq FROM lim_fallo_par WHERE par_id = ${parId}::uuid
                        ORDER BY creado_en DESC, seq DESC LIMIT ${TECNICO.fallosRetenidosPorPar}::int)`;
}

/** Fallo VERIFICADO en la cuenta: ventana fija, activación y prolongación del periodo protegido. */
async function registrarFalloCuenta(tx: Tx, cuentaId: string, ahora: Date, intento: ContextoDeAuditoria): Promise<void> {
  const cuenta = await leerPorId(tx, cuentaId);
  if (!cuenta) return;
  const v = sumarEnVentana(cuenta.ventanaInicio, cuenta.fallos, ahora, PERFIL.cuentaVentanaMs);
  const protegida = cuenta.protegidoHasta !== null && cuenta.protegidoHasta > ahora;
  const activa = !protegida && v.fallos >= PERFIL.cuentaUmbralProteccion;
  const desde = activa ? ahora : cuenta.protegidoDesde;
  const hasta = protegida || activa ? mas(ahora, PERFIL.proteccionMs) : cuenta.protegidoHasta;
  // Prolongar nunca acorta, y `protegido_desde` no cambia mientras el periodo esté vigente.
  const hastaFinal = protegida && cuenta.protegidoHasta && cuenta.protegidoHasta > hasta! ? cuenta.protegidoHasta : hasta;
  const vence = new Date(Math.max(mas(v.inicio, PERFIL.cuentaVentanaMs).getTime(), hastaFinal?.getTime() ?? 0));
  await tx.$executeRaw`
    UPDATE lim_clave SET ventana_inicio = ${t(v.inicio)}, fallos = ${v.fallos}::int,
           protegido_desde = ${desde ? t(desde) : Prisma.sql`NULL`},
           protegido_hasta = ${hastaFinal ? t(hastaFinal) : Prisma.sql`NULL`},
           vence_en = GREATEST(vence_en, ${t(vence)})
     WHERE id = ${cuentaId}::uuid`;
  if (activa) {
    await audit(
      {
        userId: intento.userId ?? null,
        action: "LOGIN_PROTECTION_STARTED",
        entityType: "LoginLimiter",
        ipAddress: intento.ip,
        after: { protegidoHasta: hastaFinal },
      },
      { tx }
    );
  }
}

interface ReservaBorrada {
  seq: bigint;
  origenId: string;
  cuentaId: string | null;
  parId: string | null;
  reservaHasta: Date;
  anulada: boolean;
}

const COLUMNAS_RESERVA = Prisma.sql`seq, origen_id::text AS "origenId", cuenta_id::text AS "cuentaId",
  par_id::text AS "parId", reserva_hasta AS "reservaHasta", anulada`;

/**
 * Una reserva vencida, ya BORRADA por quien llama, se cobra como fallo NO verificado: en el
 * par (si sigue existiendo y su `seq` supera la marca) y en el origen. No toca la cuenta:
 * un fallo sin verificar no activa ni prolonga la protección. Una anulada solo cuenta en el
 * origen, porque su par y su cuenta ya no existen.
 */
async function convertir(tx: Tx, r: ReservaBorrada, ahora: Date): Promise<void> {
  if (r.parId && !r.anulada) await registrarFalloPar(tx, r.parId, r.seq, r.reservaHasta, false, ahora);
  await sumarFalloOrigen(tx, r.origenId, ahora);
}

// ---------------------------------------------------------------------------
// Rechazos agregados
// ---------------------------------------------------------------------------

interface ContextoDeAuditoria {
  /** Solo para la auditoría (que ya registra `userId`): nunca se guarda en el limitador. */
  userId?: string;
  ip?: string;
}

/** Un rechazo suma en su fila; la auditoría recibe un aviso agregado como mucho cada 15 min. */
async function registrarRechazo(tx: Tx, fila: Fila, capa: string, ahora: Date, intento: ContextoDeAuditoria): Promise<void> {
  const avisar = !fila.rechazoAvisadoEn || fila.rechazoAvisadoEn.getTime() + TECNICO.avisoDeRechazosMs <= ahora.getTime();
  const acumulados = fila.rechazos + 1;
  if (!avisar) {
    await tx.$executeRaw`UPDATE lim_clave SET rechazos = rechazos + 1 WHERE id = ${fila.id}::uuid`;
    return;
  }
  await tx.$executeRaw`UPDATE lim_clave SET rechazos = 0, rechazo_avisado_en = ${t(ahora)} WHERE id = ${fila.id}::uuid`;
  await audit(
    {
      userId: fila.tipo === "par" ? (intento.userId ?? null) : null,
      action: "LOGIN_THROTTLED",
      entityType: "LoginLimiter",
      ipAddress: intento.ip,
      after: { capa, rechazos: acumulados },
    },
    { tx }
  );
}

let ultimoAvisoDeSaturacion = 0;
async function avisarSaturacion(recurso: string, intento: ContextoDeAuditoria): Promise<void> {
  if (Date.now() - ultimoAvisoDeSaturacion < 60 * 60_000) return;
  ultimoAvisoDeSaturacion = Date.now();
  await audit({ action: "LOGIN_LIMITER_SATURATED", entityType: "LoginLimiter", ipAddress: intento.ip, after: { recurso } });
}

// ---------------------------------------------------------------------------
// Admisión y liquidación
// ---------------------------------------------------------------------------

export interface Intento extends ContextoDeAuditoria {
  /** El nombre de usuario RECIBIDO (ya recortado por el esquema), exista o no. */
  username: string;
  /** El origen para límites (`origenParaLimites`): IPv4, /64 de IPv6 o respaldo. */
  origen: string;
}

export interface Admision {
  token: string;
  claves: ClavesDeIntento;
  contexto: ContextoDeAuditoria;
}

type DesenlaceDeAdmision = { tipo: "admitida"; token: string } | { tipo: "rechazada" };

/**
 * Fallos de la ventana vigente del origen más sus reservas vivas (vencidas o no): lo que el
 * origen ya consumió de su presupuesto.
 */
async function consumoDelOrigen(tx: Tx, origen: Fila, ahora: Date): Promise<number> {
  const [{ n: reservas } = { n: 0 }] = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM lim_reserva WHERE origen_id = ${origen.id}::uuid`;
  const fallos = origen.ventanaInicio && origen.ventanaInicio.getTime() + PERFIL.origenVentanaMs > ahora.getTime() ? origen.fallos : 0;
  return fallos + reservas;
}

async function admitirEn(tx: Tx, claves: ClavesDeIntento, huella: Buffer, intento: Intento): Promise<DesenlaceDeAdmision> {
  await bloquear(tx, [claves.origen, claves.cuenta, claves.par]);
  const ahora = new Date();
  const capacidad: CambiosDeCapacidad = new Map();

  let origen = await leer(tx, "origen", claves.origen, huella);
  // RECHAZO TEMPRANO: un origen que ya agotó su presupuesto se rechaza ANTES de leer o crear
  // la cuenta y el par, y sin reserva. Así un origen agotado no puede llenar la tabla de
  // claves probando nombres nuevos. El recuento es exacto: cobrar aquí las reservas vencidas
  // de este par las pasaría de reserva a fallo del origen sin cambiar la suma, y quedan
  // contando como reservas hasta que otra admisión del par o el barrido las cobre.
  if (origen && (await consumoDelOrigen(tx, origen, ahora)) >= PERFIL.origenMaxFallos) {
    await registrarRechazo(tx, origen, "origen", ahora, intento);
    return { tipo: "rechazada" };
  }
  if (!origen) {
    origen = await crear(tx, "origen", claves.origen, huella, null, mas(ahora, PERFIL.origenVentanaMs));
    sumar(capacidad, recursoDeFragmento(origen.fragmento), 1);
  }
  let cuenta = await leer(tx, "cuenta", claves.cuenta, huella);
  if (!cuenta) {
    cuenta = await crear(tx, "cuenta", claves.cuenta, huella, null, mas(ahora, PERFIL.cuentaVentanaMs));
    sumar(capacidad, recursoDeFragmento(cuenta.fragmento), 1);
  }
  let par = await leer(tx, "par", claves.par, huella);
  if (!par) {
    par = await crear(tx, "par", claves.par, huella, cuenta.id, mas(ahora, PERFIL.parVentanaMs));
    sumar(capacidad, recursoDeFragmento(par.fragmento), 1);
  }

  // Las reservas VENCIDAS de este par se cobran ahora (tenemos su bloqueo): pasan de «reserva»
  // a «fallo no verificado» en esta transacción. Las de OTROS pares del mismo origen no se tocan
  // aquí —tomar sus bloqueos rompería el orden—, pero siguen contando como reservas del origen.
  const vencidas = await tx.$queryRaw<ReservaBorrada[]>`
    DELETE FROM lim_reserva WHERE par_id = ${par.id}::uuid AND reserva_hasta <= ${t(ahora)}
    RETURNING ${COLUMNAS_RESERVA}`;
  for (const r of vencidas) {
    await convertir(tx, r, ahora);
    sumar(capacidad, RECURSO_RESERVAS, -1);
  }
  if (vencidas.length > 0) {
    origen = (await leerPorId(tx, origen.id))!;
    par = (await leerPorId(tx, par.id))!;
  }

  const [{ n: fallosPar } = { n: 0 }] = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM lim_fallo_par
     WHERE par_id = ${par.id}::uuid AND creado_en > ${t(mas(ahora, -PERFIL.parVentanaMs))}`;
  const [{ n: reservasPar } = { n: 0 }] = await tx.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM lim_reserva WHERE par_id = ${par.id}::uuid`;
  const protegida = cuenta.protegidoHasta !== null && cuenta.protegidoHasta > ahora;

  let rechazo: { fila: Fila; capa: string } | null = null;
  if (protegida) {
    const esperando = par.ultimoFalloEn !== null && par.ultimoFalloEn.getTime() + PERFIL.esperaProtegidaMs > ahora.getTime();
    if (reservasPar > 0 || esperando) rechazo = { fila: par, capa: "par-protegido" };
  } else if (fallosPar + reservasPar >= PERFIL.parMaxFallos) {
    rechazo = { fila: par, capa: "par" };
  }
  // Un origen recién creado, o uno que llega al límite con la conversión de arriba.
  if (!rechazo && (await consumoDelOrigen(tx, origen, ahora)) >= PERFIL.origenMaxFallos) rechazo = { fila: origen, capa: "origen" };

  if (rechazo) {
    await registrarRechazo(tx, rechazo.fila, rechazo.capa, ahora, intento);
    await ajustarCapacidad(tx, capacidad);
    return { tipo: "rechazada" };
  }

  const token = randomUUID();
  await tx.$executeRaw`
    INSERT INTO lim_reserva (token, origen_id, cuenta_id, par_id, reserva_hasta)
    VALUES (${token}::uuid, ${origen.id}::uuid, ${cuenta.id}::uuid, ${par.id}::uuid, ${t(mas(ahora, TECNICO.reservaMs))})`;
  // Claves VENCIDAS reutilizadas: se aplaza su vencimiento al de la reserva. Además de lo
  // evidente (no se purga una clave en uso), escribir la fila crea una versión nueva: una
  // purga que tomó su instantánea antes de que esta admisión confirmara vuelve a comprobar
  // `vence_en` al bloquear la fila (READ COMMITTED) y la descarta, en lugar de borrarla con
  // una reserva viva (que la dejaría huérfana o haría fallar la purga por la clave foránea).
  const minimo = mas(ahora, TECNICO.reservaMs);
  await tx.$executeRaw`
    UPDATE lim_clave SET vence_en = ${t(minimo)}
     WHERE id IN (${origen.id}::uuid, ${cuenta.id}::uuid, ${par.id}::uuid) AND vence_en < ${t(minimo)}`;
  sumar(capacidad, RECURSO_RESERVAS, 1);
  await ajustarCapacidad(tx, capacidad);
  return { tipo: "admitida", token };
}

/**
 * Admite un intento de login ANTES de verificar la contraseña. Lanza `LoginLimitadoError`
 * (429) si un límite lo impide, o un 503 si no hay capacidad. Nada de esto calcula Argon2.
 */
export async function admitir(intento: Intento): Promise<Admision> {
  const { secreto: s, huella } = secreto();
  const claves = clavesDeIntento(s, intento.username, intento.origen);
  const contexto = { userId: intento.userId, ip: intento.ip };
  let desenlace: DesenlaceDeAdmision;
  try {
    desenlace = await enTransaccion((tx) => admitirEn(tx, claves, huella, intento));
  } catch (err) {
    if (err instanceof CapacidadAgotada) {
      await avisarSaturacion(err.recurso, contexto);
      throw loginNoCompletado();
    }
    throw err;
  }
  if (desenlace.tipo === "rechazada") throw new LoginLimitadoError();
  return { token: desenlace.token, claves, contexto };
}

export type ResultadoDeVerificacion = "fallo" | "acierto" | "neutro";
/**
 * - `aplicada`: la reserva era vigente y su resultado produjo efectos.
 * - `anulada`: un restablecimiento la anuló; un fallo contó solo en el origen. Se responde 503.
 * - `obsoleta`: venció (o ya se liquidó). Sin efectos; se responde 503, acierte o no.
 */
export type DesenlaceDeLiquidacion = "aplicada" | "anulada" | "obsoleta";

export async function liquidar(admision: Admision, resultado: ResultadoDeVerificacion): Promise<DesenlaceDeLiquidacion> {
  const { claves, token, contexto } = admision;
  return enTransaccion(async (tx) => {
    await bloquear(tx, [claves.origen, claves.cuenta, claves.par]);
    const ahora = new Date();
    const borrada = await tx.$queryRaw<ReservaBorrada[]>`
      DELETE FROM lim_reserva WHERE token = ${token}::uuid AND reserva_hasta > ${t(ahora)}
      RETURNING ${COLUMNAS_RESERVA}`;
    const r = borrada[0];
    // Vencida o ya liquidada: no se toca. Si sigue en la tabla, la convertirá otra admisión
    // del par o el barrido; así se cobra una sola vez.
    if (!r) return "obsoleta";

    const capacidad: CambiosDeCapacidad = new Map([[RECURSO_RESERVAS, -1]]);
    if (r.anulada || !r.parId || !r.cuentaId) {
      if (resultado === "fallo") await sumarFalloOrigen(tx, r.origenId, ahora);
      await ajustarCapacidad(tx, capacidad);
      return "anulada";
    }

    if (resultado === "fallo") {
      await registrarFalloPar(tx, r.parId, r.seq, ahora, true, ahora);
      await sumarFalloOrigen(tx, r.origenId, ahora);
      await registrarFalloCuenta(tx, r.cuentaId, ahora, contexto);
    } else if (resultado === "acierto") {
      await leerPorId(tx, r.parId);
      await tx.$executeRaw`
        UPDATE lim_clave SET perdonado_hasta_seq = GREATEST(perdonado_hasta_seq, ${r.seq}) WHERE id = ${r.parId}::uuid`;
      await tx.$executeRaw`DELETE FROM lim_fallo_par WHERE par_id = ${r.parId}::uuid AND seq < ${r.seq}`;
      await tx.$executeRaw`
        UPDATE lim_clave SET ultimo_fallo_en = (SELECT max(creado_en) FROM lim_fallo_par WHERE par_id = ${r.parId}::uuid)
         WHERE id = ${r.parId}::uuid`;
    }
    await ajustarCapacidad(tx, capacidad);
    return "aplicada";
  });
}

// ---------------------------------------------------------------------------
// Restablecimiento de credenciales
// ---------------------------------------------------------------------------

/**
 * Dentro de la transacción del restablecimiento (que ya tiene `users` y las sesiones): borra
 * la fila de la CUENTA y sus pares (sus fallos caen en cascada) y ANULA sus reservas, que
 * después solo cuentan en el origen. No toca ninguna fila de origen: restablecer una cuenta
 * no devuelve presupuesto a una IP.
 */
export async function anularCuentaEnLimitador(tx: Tx, username: string | null): Promise<void> {
  if (!username) return;
  const { secreto: s, huella } = secreto();
  const clave = claveDe(s, "cuenta", [username]);
  // Sin `SET LOCAL lock_timeout`: la transacción es la del restablecimiento, con sus propios plazos.
  await bloquear(tx, [clave]);
  const cuenta = await leer(tx, "cuenta", clave, huella);
  if (!cuenta) return;
  await tx.$executeRaw`
    UPDATE lim_reserva SET anulada = true, cuenta_id = NULL, par_id = NULL WHERE cuenta_id = ${cuenta.id}::uuid`;
  const pares = await tx.$queryRaw<{ fragmento: number }[]>`
    DELETE FROM lim_clave WHERE tipo = 'par' AND cuenta_id = ${cuenta.id}::uuid RETURNING fragmento`;
  await tx.$executeRaw`DELETE FROM lim_clave WHERE id = ${cuenta.id}::uuid`;
  const capacidad: CambiosDeCapacidad = new Map();
  for (const p of [...pares, cuenta]) sumar(capacidad, recursoDeFragmento(p.fragmento), -1);
  await ajustarCapacidad(tx, capacidad);
}

// ---------------------------------------------------------------------------
// Barrido, purga y reconciliación
// ---------------------------------------------------------------------------

/** Convierte las reservas vencidas en fallos no verificados. Devuelve cuántas convirtió. */
export async function barrer(lote: number = TECNICO.loteDeMantenimiento): Promise<number> {
  const candidatas = await prisma.$queryRaw<{ token: string }[]>`
    SELECT token::text AS token FROM lim_reserva WHERE reserva_hasta <= ${t(new Date())}
     ORDER BY reserva_hasta LIMIT ${lote}::int`;
  let convertidas = 0;
  for (const { token } of candidatas) {
    const hecho = await enTransaccion(async (tx) => {
      const info = await tx.$queryRaw<{ o: Buffer; c: Buffer | null; p: Buffer | null }[]>`
        SELECT o.clave_hmac AS o, c.clave_hmac AS c, p.clave_hmac AS p
          FROM lim_reserva r JOIN lim_clave o ON o.id = r.origen_id
          LEFT JOIN lim_clave c ON c.id = r.cuenta_id LEFT JOIN lim_clave p ON p.id = r.par_id
         WHERE r.token = ${token}::uuid`;
      const i = info[0];
      if (!i) return false;
      await bloquear(tx, [i.o, ...(i.c ? [i.c] : []), ...(i.p ? [i.p] : [])].map((b) => Buffer.from(b)));
      const ahora = new Date();
      const borrada = await tx.$queryRaw<ReservaBorrada[]>`
        DELETE FROM lim_reserva WHERE token = ${token}::uuid AND reserva_hasta <= ${t(ahora)}
        RETURNING ${COLUMNAS_RESERVA}`;
      if (!borrada[0]) return false;
      await convertir(tx, borrada[0], ahora);
      await ajustarCapacidad(tx, new Map([[RECURSO_RESERVAS, -1]]));
      return true;
    });
    if (hecho) convertidas++;
  }
  return convertidas;
}

/**
 * Borra, por TIEMPO y relaciones (nunca por versión), las claves vencidas sin reservas: pares,
 * orígenes y, al final, cuentas sin pares. Devuelve cuántas borró.
 */
export async function purgar(lote: number = TECNICO.loteDeMantenimiento): Promise<number> {
  return enTransaccion(async (tx) => {
    const ahora = t(new Date());
    const pares = await tx.$queryRaw<{ fragmento: number }[]>`
      DELETE FROM lim_clave WHERE id IN (
        SELECT c.id FROM lim_clave c
         WHERE c.tipo = 'par' AND c.vence_en < ${ahora}
           AND NOT EXISTS (SELECT 1 FROM lim_reserva r WHERE r.par_id = c.id)
         ORDER BY c.vence_en LIMIT ${lote}::int FOR UPDATE SKIP LOCKED)
      RETURNING fragmento`;
    const origenes = await tx.$queryRaw<{ fragmento: number }[]>`
      DELETE FROM lim_clave WHERE id IN (
        SELECT c.id FROM lim_clave c
         WHERE c.tipo = 'origen' AND c.vence_en < ${ahora}
           AND NOT EXISTS (SELECT 1 FROM lim_reserva r WHERE r.origen_id = c.id)
         ORDER BY c.vence_en LIMIT ${lote}::int FOR UPDATE SKIP LOCKED)
      RETURNING fragmento`;
    const cuentas = await tx.$queryRaw<{ fragmento: number }[]>`
      DELETE FROM lim_clave WHERE id IN (
        SELECT c.id FROM lim_clave c
         WHERE c.tipo = 'cuenta' AND c.vence_en < ${ahora}
           AND NOT EXISTS (SELECT 1 FROM lim_clave p WHERE p.cuenta_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM lim_reserva r WHERE r.cuenta_id = c.id)
         ORDER BY c.vence_en LIMIT ${lote}::int FOR UPDATE SKIP LOCKED)
      RETURNING fragmento`;
    const capacidad: CambiosDeCapacidad = new Map();
    for (const f of [...pares, ...origenes, ...cuentas]) sumar(capacidad, recursoDeFragmento(f.fragmento), -1);
    await ajustarCapacidad(tx, capacidad);
    return pares.length + origenes.length + cuentas.length;
  });
}

/** Crea las filas de capacidad que falten, con su cupo por omisión. */
export async function asegurarCapacidad(): Promise<void> {
  const recursos = [...Array.from({ length: TECNICO.fragmentos }, (_, f) => recursoDeFragmento(f)), RECURSO_RESERVAS];
  for (const recurso of recursos) {
    await prisma.$executeRaw`
      INSERT INTO lim_capacidad (recurso, usadas, cupo) VALUES (${recurso}, 0, ${cupoPorOmision(recurso)}::int)
      ON CONFLICT (recurso) DO NOTHING`;
  }
}

/**
 * Red de seguridad: con TODAS las filas de capacidad bloqueadas (L7, en orden), `usadas` pasa
 * a ser el recuento real. Es coherente porque toda inserción o borrado que afecta al recuento
 * necesita L7. Devuelve los recursos corregidos.
 */
export async function reconciliarCapacidad(): Promise<string[]> {
  return enTransaccion(async (tx) => {
    const filas = await tx.$queryRaw<{ recurso: string; usadas: number; cupo: number }[]>`
      SELECT recurso, usadas, cupo FROM lim_capacidad ORDER BY recurso FOR UPDATE`;
    const claves = await tx.$queryRaw<{ fragmento: number; n: number }[]>`
      SELECT fragmento, count(*)::int AS n FROM lim_clave GROUP BY fragmento`;
    const [{ n: reservas } = { n: 0 }] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM lim_reserva`;
    const reales = new Map<string, number>(claves.map((c) => [recursoDeFragmento(c.fragmento), c.n]));
    reales.set(RECURSO_RESERVAS, reservas);
    const corregidos: string[] = [];
    for (const f of filas) {
      const real = Math.min(reales.get(f.recurso) ?? 0, f.cupo);
      if (real !== f.usadas) {
        corregidos.push(f.recurso);
        await tx.$executeRaw`UPDATE lim_capacidad SET usadas = ${real}::int WHERE recurso = ${f.recurso}`;
      }
    }
    return corregidos;
  });
}

/** Ocupación de las claves (0–1) y reservas vivas, para el aviso operativo. */
export async function ocupacion(): Promise<{ claves: number; reservas: number }> {
  const filas = await prisma.$queryRaw<{ recurso: string; usadas: number; cupo: number }[]>`
    SELECT recurso, usadas, cupo FROM lim_capacidad`;
  let usadas = 0;
  let cupo = 0;
  let reservas = 0;
  for (const f of filas) {
    if (f.recurso === RECURSO_RESERVAS) reservas = f.usadas;
    else {
      usadas += f.usadas;
      cupo += f.cupo;
    }
  }
  return { claves: cupo > 0 ? usadas / cupo : 0, reservas };
}

/**
 * VALIDACIÓN PERSISTENTE DEL SECRETO. La primera vez guarda la huella del secreto (inserción
 * atómica: dos procesos que arrancan a la vez guardan una sola). Después, un proceso cuyo
 * secreto tenga otra huella LANZA y no debe arrancar. No borra ni reinicia ningún contador.
 */
export async function verificarConfiguracionDelLimitador(secretoAVerificar: string = secreto().secreto): Promise<void> {
  const huella = huellaDelSecreto(secretoAVerificar);
  await prisma.$executeRaw`INSERT INTO lim_configuracion (id, huella) VALUES (1, ${huella}) ON CONFLICT (id) DO NOTHING`;
  const filas = await prisma.$queryRaw<{ huella: Buffer }[]>`SELECT huella FROM lim_configuracion WHERE id = 1`;
  const guardada = filas[0]?.huella;
  if (!guardada || !Buffer.from(guardada).equals(huella)) {
    throw new Error(
      "AUTH_LIMITER_SECRET no corresponde al estado guardado del limitador de login. " +
        "Restaure el secreto anterior: rotarlo requiere un procedimiento específico (no implementado)."
    );
  }
}

/** Arranca el barrido y la purga periódicos. Devuelve la función que los detiene. */
export function iniciarMantenimientoDelLimitador(log: { warn: (o: object, m: string) => void; error: (o: object, m: string) => void }): () => void {
  let enMarcha = false;
  let ultimoAvisoDeOcupacion = 0;
  const vuelta = async () => {
    if (enMarcha) return;
    enMarcha = true;
    try {
      await barrer();
      await purgar();
      const o = await ocupacion();
      if (o.claves >= TECNICO.avisoOcupacion && Date.now() - ultimoAvisoDeOcupacion > 60 * 60_000) {
        ultimoAvisoDeOcupacion = Date.now();
        log.warn({ ocupacionClaves: Math.round(o.claves * 100) }, "limitador de login: ocupación alta");
      }
    } catch (err) {
      log.error({ err }, "limitador de login: falló el mantenimiento periódico");
    } finally {
      enMarcha = false;
    }
  };
  const temporizador = setInterval(() => void vuelta(), TECNICO.intervaloDeMantenimientoMs);
  temporizador.unref();
  return () => clearInterval(temporizador);
}
