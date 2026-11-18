/**
 * PARÁMETROS DEL SISTEMA editables por administración.
 *
 * Hoy existe uno solo: el MENSAJE DEL LOGIN, el texto bajo el botón «Ingresar».
 *
 *  - Es TEXTO PLANO: se guarda y se entrega tal cual, con sus saltos de línea. La interfaz
 *    lo muestra como texto (nunca como HTML), así que no hace falta sanearlo aquí.
 *  - Sin fila en `parametros_sistema` rige `MENSAJE_LOGIN_POR_DEFECTO`, que reproduce el
 *    mensaje que estaba escrito en `LoginPage.tsx`. La interfaz usa el mismo texto como
 *    respaldo si no logra leerlo (ver `frontend/src/modules/auth/mensajeDeAcceso.ts`).
 *  - La lectura pública (`leerMensajeLoginPublico`) devuelve SOLO el texto: ni la fecha de
 *    modificación ni quién lo cambió.
 *  - La escritura es exclusiva de administración (la ruta exige el rol `admin`) y se audita
 *    en la MISMA transacción (`LOGIN_MESSAGE_UPDATED`). Guardar el mismo texto no escribe ni
 *    audita.
 */
import { prisma } from "../../shared/prisma.client";
import { audit } from "../audit/audit.service";
import { ValidationError } from "../../shared/errors";

export const CLAVE_MENSAJE_LOGIN = "login.mensaje";

/** Máximo de caracteres del mensaje del login (la base acota además cualquier parámetro a 4000). */
export const MAXIMO_MENSAJE_LOGIN = 1000;

/** El mensaje vigente antes de que fuera editable, completo y con su pregunta inicial. */
export const MENSAJE_LOGIN_POR_DEFECTO =
  "¿Olvidó su contraseña? Solicite a un administrador de la Federación que restablezca su acceso: recibirá una contraseña temporal y el sistema le pedirá definir una nueva al ingresar.";

interface ContextoDeAuditoria {
  userId: string;
  ipAddress?: string;
}

export interface MensajeLoginAdministrativo {
  texto: string;
  /** `true` si no hay valor guardado y rige el texto por defecto. */
  porDefecto: boolean;
  textoPorDefecto: string;
  maximo: number;
  actualizadoEn: string | null;
}

/**
 * Normaliza el texto recibido: saltos de línea `\r\n` y `\r` a `\n`, y sin espacios ni líneas
 * en blanco al principio o al final. Los saltos y espacios interiores se conservan.
 * Rechaza lo que no sea texto, lo vacío, lo que supere el máximo y los caracteres de control
 * (salvo el salto de línea y el tabulador).
 */
export function normalizarMensajeLogin(valor: unknown): string {
  if (typeof valor !== "string") throw new ValidationError("El mensaje debe ser texto.");
  const texto = valor.replace(/\r\n?/g, "\n").trim();
  if (texto.length === 0) throw new ValidationError("El mensaje no puede quedar vacío.");
  if ([...texto].length > MAXIMO_MENSAJE_LOGIN) {
    throw new ValidationError(`El mensaje no puede superar los ${MAXIMO_MENSAJE_LOGIN} caracteres.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(texto)) {
    throw new ValidationError("El mensaje contiene caracteres no permitidos.");
  }
  return texto;
}

async function leerFila() {
  return prisma.parametroSistema.findUnique({ where: { clave: CLAVE_MENSAJE_LOGIN } });
}

/** Lo único que ve el login sin sesión: el texto vigente. */
export async function leerMensajeLoginPublico(): Promise<{ texto: string }> {
  const fila = await leerFila();
  return { texto: fila?.valor ?? MENSAJE_LOGIN_POR_DEFECTO };
}

/** Lo que ve la pantalla de administración. */
export async function leerMensajeLoginAdministrativo(): Promise<MensajeLoginAdministrativo> {
  const fila = await leerFila();
  return describir(fila);
}

function describir(fila: { valor: string; actualizadoEn: Date } | null): MensajeLoginAdministrativo {
  return {
    texto: fila?.valor ?? MENSAJE_LOGIN_POR_DEFECTO,
    porDefecto: fila === null,
    textoPorDefecto: MENSAJE_LOGIN_POR_DEFECTO,
    maximo: MAXIMO_MENSAJE_LOGIN,
    actualizadoEn: fila?.actualizadoEn.toISOString() ?? null,
  };
}

/** Guarda el mensaje del login. Devuelve el estado resultante y si hubo cambio. */
export async function guardarMensajeLogin(
  valor: unknown,
  actor: ContextoDeAuditoria
): Promise<{ mensaje: MensajeLoginAdministrativo; cambio: boolean }> {
  const texto = normalizarMensajeLogin(valor);
  return prisma.$transaction(async (tx) => {
    // Bloqueo consultivo por clave: dos guardados simultáneos se ordenan y cada auditoría
    // registra el texto que de verdad reemplazó. Un `FOR UPDATE` no bastaría: mientras no
    // existe la fila no hay nada que bloquear, y las dos primeras escrituras leerían «sin valor».
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"parametros:" + CLAVE_MENSAJE_LOGIN}, 0))`;
    const filas = await tx.$queryRaw<{ valor: string }[]>`SELECT valor FROM parametros_sistema WHERE clave = ${CLAVE_MENSAJE_LOGIN}`;
    const anterior = filas[0]?.valor ?? null;
    const vigente = anterior ?? MENSAJE_LOGIN_POR_DEFECTO;
    if (anterior !== null && anterior === texto) {
      const fila = await tx.parametroSistema.findUnique({ where: { clave: CLAVE_MENSAJE_LOGIN } });
      return { mensaje: describir(fila), cambio: false };
    }

    const fila = await tx.parametroSistema.upsert({
      where: { clave: CLAVE_MENSAJE_LOGIN },
      create: { clave: CLAVE_MENSAJE_LOGIN, valor: texto },
      update: { valor: texto, actualizadoEn: new Date() },
    });
    await audit(
      {
        userId: actor.userId,
        action: "LOGIN_MESSAGE_UPDATED",
        entityType: "ParametroSistema",
        entityId: CLAVE_MENSAJE_LOGIN,
        ipAddress: actor.ipAddress,
        before: { texto: vigente, porDefecto: anterior === null },
        after: { texto },
      },
      { tx }
    );
    return { mensaje: describir(fila), cambio: true };
  });
}
