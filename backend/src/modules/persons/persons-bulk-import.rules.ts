import { personCreateSchema, type PersonCreateInput } from "./persons.schemas";
import { normalizeRun } from "../../shared/run.util";
import { esFechaCalendarioValida } from "../../shared/fecha.util";
import { normalizarSigla } from "../../shared/clubCode";
import { CELDAS_LEIDAS } from "./xlsx/limites";

export { normalizarSigla, CELDAS_LEIDAS };

/**
 * LA CARGA MASIVA NO TRAE ROLES.
 *
 * Tenía una columna «Roles» obligatoria, y era la última puerta abierta para
 * fabricar un rol funcional sin la relación que lo justifica: se podía cargar a
 * alguien como «Delegado» sin nombramiento en ningún club, o como «Nadador» sin
 * plantel. Los cuatro `person_roles` se derivan —`swimmer` de la membresía
 * activa, los otros tres del nombramiento en `club_staff`—, así que la columna
 * afirmaba algo que el sistema no podía sostener.
 *
 * Desde la etapa 6 la carga SÍ puede incorporar a la persona a un club: si la
 * fila trae la sigla del club y la fecha efectiva, se crea su membresía activa y,
 * con ella, el rol de nadador DERIVADO. El rol nunca se escribe desde el archivo.
 */

/**
 * Formato exigido del archivo Excel de carga masiva (columnas A-K, en este
 * orden exacto, con encabezado en la fila 1 — ver la plantilla descargable
 * generada por `buildPersonsImportTemplate`):
 *
 *   A: RUN                    (obligatorio, ej: "12.345.678-9")
 *   B: Nombre de usuario       (opcional; vacío = sin nombre, nunca se genera uno)
 *   C: Nombre                  (obligatorio)
 *   D: Apellido paterno        (obligatorio)
 *   E: Apellido materno        (opcional)
 *   F: Fecha de nacimiento     (obligatorio, formato DD-MM-AAAA)
 *   G: Género                  (obligatorio, "Femenino" o "Masculino")
 *   H: Correo electrónico      (opcional)
 *   I: Teléfono                (opcional)
 *   J: Sigla del club          (opcional; vacía = la persona se registra sin club)
 *   K: Fecha efectiva          (obligatoria SI hay club; AAAA-MM-DD o DD-MM-AAAA)
 *
 * Las plantillas anteriores (A-I, sin J ni K) siguen siendo válidas: sus filas
 * registran solo a la persona. Una plantilla aún más antigua con «Roles» en la J
 * se RECHAZA entera (ver `evaluarEncabezado`): nunca se lee «Roles» como sigla.
 */
export const PERSONS_IMPORT_HEADERS = [
  "RUN",
  "Nombre de usuario (opcional)",
  "Nombre",
  "Apellido paterno",
  "Apellido materno (opcional)",
  "Fecha de nacimiento (DD-MM-AAAA)",
  "Género (Femenino/Masculino)",
  "Correo electrónico (opcional)",
  "Teléfono (opcional)",
  "Sigla del club (opcional)",
  "Fecha efectiva de membresía (AAAA-MM-DD; obligatoria si hay club)",
];

/** Posiciones (0-indexadas) de las dos columnas de club. */
export const COLUMNA_SIGLA = 9;
export const COLUMNA_FECHA_EFECTIVA = 10;

export interface PersonRowMapResult {
  ok: boolean;
  data?: PersonCreateInput;
  /** Sigla normalizada (`trim` + mayúsculas) o `null` si la fila no trae club. */
  sigla?: string | null;
  /** Fecha efectiva `AAAA-MM-DD`, o `null` si la fila no trae club. */
  fechaEfectiva?: string | null;
  errors: string[];
}

function parseSpanishDate(raw: string): Date | null {
  const match = raw.trim().match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (!match) return null;
  const [, d, m, y] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  // Valida que la fecha exista de verdad (ej. rechaza 31-02-2000).
  if (date.getUTCDate() !== Number(d) || date.getUTCMonth() !== Number(m) - 1) return null;
  return date;
}

function parseGender(raw: string): "male" | "female" | null {
  const normalized = raw.trim().toLowerCase();
  if (["femenino", "female", "f", "dama", "damas"].includes(normalized)) return "female";
  if (["masculino", "male", "m", "varon", "varón", "varones"].includes(normalized)) return "male";
  return null;
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    // exceljs devuelve una celda de fecha como `Date` a medianoche UTC: se leen
    // los componentes UTC, nunca los locales, para no correr el día.
    const d = String(value.getUTCDate()).padStart(2, "0");
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    return `${d}-${m}-${value.getUTCFullYear()}`;
  }
  // Celdas con formato enriquecido o hipervínculo: exceljs las entrega como objeto.
  if (typeof value === "object") {
    const v = value as { text?: unknown; richText?: { text: string }[]; result?: unknown };
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join("").trim();
    if (typeof v.text === "string") return v.text.trim();
    if (v.result !== undefined) return cellToString(v.result);
  }
  return String(value).trim();
}

/**
 * La fecha efectiva de una fila, como fecha de CALENDARIO `AAAA-MM-DD`.
 *
 * Admite `AAAA-MM-DD` (el formato de la API y de `fechaEfectivaField`) y
 * `DD-MM-AAAA` / `DD/MM/AAAA` (el de la fecha de nacimiento de la misma hoja).
 * Una celda de fecha nativa de Excel llega aquí ya convertida a `DD-MM-AAAA`
 * con sus componentes UTC. Nunca hay hora ni zona: el día que se lee es el que
 * se guarda. Devuelve `null` si el formato no corresponde o el día no existe.
 */
export function parseFechaEfectiva(raw: string): string | null {
  const texto = raw.trim();
  let iso: string | null = null;
  const isoMatch = texto.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    iso = `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  } else {
    const esMatch = texto.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (esMatch) {
      const [, d, m, y] = esMatch;
      iso = `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
    }
  }
  return iso && esFechaCalendarioValida(iso) ? iso : null;
}

const normalizarEncabezado = (v: unknown) => cellToString(v).toLowerCase().replace(/\s+/g, " ");

export type ResultadoEncabezado = { ok: true; conColumnasDeClub: boolean } | { ok: false; error: string };

/**
 * ¿Qué plantilla es? Se mira el encabezado de las columnas J y K.
 *
 *   - J y K con los títulos actuales → plantilla actual (con club).
 *   - J y K vacías → plantilla anterior (A-I): las filas registran solo a la persona.
 *   - Cualquier otra cosa → el ARCHIVO ENTERO se rechaza sin escribir nada. En
 *     particular, una J titulada «Roles» (plantilla de antes de retirar los roles)
 *     no se reinterpreta como sigla: leer «Nadador» como sigla de club sería
 *     reutilizar en silencio una columna que significaba otra cosa.
 */
export function evaluarEncabezado(encabezado: unknown[]): ResultadoEncabezado {
  const j = normalizarEncabezado(encabezado[COLUMNA_SIGLA]);
  const k = normalizarEncabezado(encabezado[COLUMNA_FECHA_EFECTIVA]);
  const esperadoJ = PERSONS_IMPORT_HEADERS[COLUMNA_SIGLA]!.toLowerCase();
  const esperadoK = PERSONS_IMPORT_HEADERS[COLUMNA_FECHA_EFECTIVA]!.toLowerCase();

  if (j === "" && k === "") return { ok: true, conColumnasDeClub: false };
  if (j === esperadoJ && k === esperadoK) return { ok: true, conColumnasDeClub: true };

  if (j.includes("rol")) {
    return {
      ok: false,
      error:
        `Este archivo usa una plantilla antigua: su columna J se titula «${cellToString(encabezado[COLUMNA_SIGLA])}». Los roles ya no se cargan ` +
        `desde este archivo y esa columna NO se interpreta como club. Descargue la plantilla actual, copie sus datos en ella y vuelva a cargar. No se importó ninguna fila.`,
    };
  }
  return {
    ok: false,
    error:
      `El encabezado de las columnas J y K no corresponde a la plantilla: se esperaba «${PERSONS_IMPORT_HEADERS[COLUMNA_SIGLA]}» y ` +
      `«${PERSONS_IMPORT_HEADERS[COLUMNA_FECHA_EFECTIVA]}» (o ambas vacías, en la plantilla anterior sin club). ` +
      "Descargue la plantilla actual y vuelva a cargar. No se importó ninguna fila.",
  };
}

/**
 * Convierte una fila cruda del Excel (en el orden de `PERSONS_IMPORT_HEADERS`) en
 * un `PersonCreateInput` validado más, si corresponde, la sigla y la fecha
 * efectiva de su membresía; o en la lista de errores encontrados — acumula TODOS
 * los problemas de la fila en vez de detenerse en el primero.
 *
 * `conColumnasDeClub` dice si el archivo trae J y K con sus títulos (ver
 * `evaluarEncabezado`). En un archivo sin ellas, una fila con datos en J o K se
 * rechaza: esos datos no tienen encabezado que diga qué son.
 *
 * Criterio conservador sobre la fecha efectiva (decisión del usuario):
 *   - con club, la fecha es OBLIGATORIA y debe ser válida; nunca se usa la de hoy
 *     en silencio;
 *   - una fecha SIN club es una inconsistencia y se informa, en vez de descartarla.
 */
export function mapRowToPersonInput(rawRow: unknown[], opciones: { conColumnasDeClub?: boolean } = { conColumnasDeClub: true }): PersonRowMapResult {
  const [runRaw, usernameRaw, firstNameRaw, paternalLastNameRaw, maternalLastNameRaw, birthDateRaw, genderRaw, emailRaw, phoneRaw, siglaRaw, fechaRaw, sobranteRaw] =
    Array.from({ length: CELDAS_LEIDAS }, (_, i) => cellToString(rawRow[i]));

  const errors: string[] = [];

  const birthDate = birthDateRaw ? parseSpanishDate(birthDateRaw) : null;
  if (birthDateRaw && !birthDate) errors.push(`Fecha de nacimiento inválida: "${birthDateRaw}" (use DD-MM-AAAA)`);

  const gender = genderRaw ? parseGender(genderRaw) : null;
  if (genderRaw && !gender) errors.push(`Género inválido: "${genderRaw}" (use "Femenino" o "Masculino")`);

  let sigla: string | null = null;
  let fechaEfectiva: string | null = null;

  if (opciones.conColumnasDeClub === false) {
    if (siglaRaw || fechaRaw) {
      errors.push(
        "La fila trae datos en las columnas J o K, pero el archivo no tiene esos encabezados. Use la plantilla actual, con «Sigla del club» y «Fecha efectiva de membresía»."
      );
    }
  } else {
    if (siglaRaw) sigla = normalizarSigla(siglaRaw);
    if (sigla) {
      if (!fechaRaw) {
        errors.push(
          `Falta la fecha efectiva de membresía (columna K): es obligatoria cuando la fila trae club («${sigla}»). Escríbala como AAAA-MM-DD o DD-MM-AAAA; el sistema no usa la fecha de hoy por su cuenta.`
        );
      } else {
        fechaEfectiva = parseFechaEfectiva(fechaRaw);
        if (!fechaEfectiva) errors.push(`Fecha efectiva de membresía inválida: "${fechaRaw}" (use AAAA-MM-DD o DD-MM-AAAA, con un día que exista).`);
      }
    } else if (fechaRaw) {
      errors.push(
        `La fila trae fecha efectiva de membresía ("${fechaRaw}") pero no trae sigla de club (columna J). Escriba la sigla del club, o borre la fecha si la persona no se incorpora a ningún club.`
      );
    }
  }

  if (sobranteRaw) {
    errors.push(`La columna L no forma parte de la plantilla ("${sobranteRaw}"). Borre las columnas que sobran y vuelva a cargar.`);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const candidate = {
    run: runRaw,
    username: usernameRaw,
    firstName: firstNameRaw,
    paternalLastName: paternalLastNameRaw,
    maternalLastName: maternalLastNameRaw || undefined,
    birthDate: birthDate as unknown as Date,
    gender: gender as "male" | "female",
    email: emailRaw,
    phone: phoneRaw || undefined,
  };

  const parsed = personCreateSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`) };
  }

  return { ok: true, data: parsed.data, sigla, fechaEfectiva, errors: [] };
}

// ---------------------------------------------------------------------------
// Resolución de la sigla del club
// ---------------------------------------------------------------------------

export interface ClubParaSigla {
  id: string;
  name: string;
  code: string;
  status: string;
  deletedAt: Date | null;
}

export type ResolucionDeSigla = { ok: true; club: ClubParaSigla } | { ok: false; error: string };

/**
 * ¿A qué club se refiere esta sigla?
 *
 * Solo resuelve clubes VIGENTES (`deletedAt` nulo) y ACTIVOS. La comparación
 * normaliza igual que el alta de clubes (`trim` + mayúsculas).
 *
 * Recibe los clubes ya leídos DENTRO de la transacción de la fila y bloqueados: ver
 * `resolverSiglaEnTransaccion`. No debe alimentarse de una lectura previa a la fila.
 *
 * UNICIDAD. La base garantiza que no haya dos clubes vigentes con la misma sigla
 * (`clubs_code_unique_active`). Esta función igual nunca elige: si la sigla coincidiera
 * con MÁS DE UN club vigente —activo o no—, la fila se rechaza como AMBIGUA, nombrando
 * los clubes, y no se escribe nada. Es una defensa adicional, no la garantía.
 */
export function resolverSigla(sigla: string, clubes: readonly ClubParaSigla[]): ResolucionDeSigla {
  const buscada = normalizarSigla(sigla);
  const coincidentes = clubes.filter((c) => normalizarSigla(c.code) === buscada);
  const vigentes = coincidentes.filter((c) => c.deletedAt === null);

  if (vigentes.length === 0) {
    if (coincidentes.length > 0) {
      return { ok: false, error: `La sigla «${buscada}» corresponde a un club eliminado. Solo se puede incorporar personas a clubes vigentes.` };
    }
    return { ok: false, error: `No existe ningún club con la sigla «${buscada}». Revise la lista de siglas en la hoja «Instrucciones» de la plantilla.` };
  }
  if (vigentes.length > 1) {
    const nombres = vigentes.map((c) => `«${c.name}»`).join(", ");
    return {
      ok: false,
      error: `La sigla «${buscada}» es ambigua: la comparten ${vigentes.length} clubes vigentes (${nombres}). No se asigna ningún club por adivinación; corrija las siglas en la ficha de los clubes antes de cargar esta fila.`,
    };
  }
  const club = vigentes[0]!;
  if (club.status !== "active") {
    return { ok: false, error: `El club «${club.name}» (sigla «${buscada}») no está activo. Solo se puede incorporar personas a clubes activos.` };
  }
  return { ok: true, club };
}

// ---------------------------------------------------------------------------
// Duplicados dentro del archivo
// ---------------------------------------------------------------------------

export interface FilaParaDuplicados {
  row: number;
  run: string;
  /** Nombre de usuario tal como viene (recortado). Vacío = ausente: no participa. */
  username: string;
}

/**
 * RUN y nombres de usuario repetidos DENTRO del archivo.
 *
 * Se procesa la PRIMERA aparición; cada aparición posterior se rechaza diciendo en
 * qué fila está la primera. El RUN se compara normalizado (sin puntos ni guion, en
 * mayúsculas); el nombre de usuario, exacto tras recortar espacios, como en el resto
 * del sistema. Dos filas SIN nombre de usuario no son duplicadas.
 *
 * Devuelve, por número de fila, los mensajes de duplicado de esa fila.
 */
export function detectarDuplicadosInternos(filas: readonly FilaParaDuplicados[]): Map<number, string[]> {
  const primeraPorRun = new Map<string, number>();
  const primeraPorUsuario = new Map<string, number>();
  const errores = new Map<number, string[]>();
  const agregar = (row: number, msg: string) => errores.set(row, [...(errores.get(row) ?? []), msg]);

  for (const f of filas) {
    const run = f.run.trim() ? normalizeRun(f.run) : "";
    if (run) {
      const primera = primeraPorRun.get(run);
      if (primera === undefined) primeraPorRun.set(run, f.row);
      else agregar(f.row, `RUN repetido dentro del archivo: ya aparece en la fila ${primera}. Solo se procesa la primera aparición.`);
    }
    const usuario = f.username.trim();
    if (usuario) {
      const primera = primeraPorUsuario.get(usuario);
      if (primera === undefined) primeraPorUsuario.set(usuario, f.row);
      else agregar(f.row, `Nombre de usuario "${usuario}" repetido dentro del archivo: ya aparece en la fila ${primera}. Solo se procesa la primera aparición.`);
    }
  }
  return errores;
}

/** Lee las celdas crudas de RUN y usuario de una fila (para `detectarDuplicadosInternos`). */
export function runYUsuarioDeFila(rawRow: unknown[]): { run: string; username: string } {
  return { run: cellToString(rawRow[0]), username: cellToString(rawRow[1]) };
}

/** ¿La fila trae algo en la columna de sigla? (para decidir si el archivo pide permiso de asignar). */
export function filaTraeClub(rawRow: unknown[]): boolean {
  return cellToString(rawRow[COLUMNA_SIGLA]) !== "";
}
