import { personCreateSchema, type PersonCreateInput } from "./persons.schemas";

/**
 * LA CARGA MASIVA YA NO TRAE ROLES.
 *
 * Tenía una columna «Roles» obligatoria, y era la última puerta abierta para
 * fabricar un rol funcional sin la relación que lo justifica: se podía cargar a
 * alguien como «Delegado» sin nombramiento en ningún club, o como «Nadador» sin
 * plantel. Los cuatro `person_roles` se derivan —`swimmer` de la membresía
 * activa, los otros tres del nombramiento en `club_staff`—, así que la columna
 * afirmaba algo que el sistema no podía sostener.
 *
 * La carga masiva crea personas; incorporarlas a un club es el paso siguiente,
 * y para eso está la asignación masiva.
 */

/**
 * Formato exigido del archivo Excel de carga masiva (columnas A-I, en este
 * orden exacto, con encabezado en la fila 1 — ver plantilla descargable
 * generada por `buildPersonsImportTemplate`):
 *
 *   A: RUN                    (obligatorio, ej: "12.345.678-9")
 *   B: Nombre de usuario       (obligatorio, sin espacios)
 *   C: Nombre                  (obligatorio)
 *   D: Apellido paterno        (obligatorio)
 *   E: Apellido materno        (opcional)
 *   F: Fecha de nacimiento     (obligatorio, formato DD-MM-AAAA)
 *   G: Género                  (obligatorio, "Femenino" o "Masculino")
 *   H: Correo electrónico      (opcional)
 *   I: Teléfono                (opcional)
 */
export const PERSONS_IMPORT_HEADERS = [
  "RUN",
  "Nombre de usuario",
  "Nombre",
  "Apellido paterno",
  "Apellido materno (opcional)",
  "Fecha de nacimiento (DD-MM-AAAA)",
  "Género (Femenino/Masculino)",
  "Correo electrónico (opcional)",
  "Teléfono (opcional)",
];

export interface PersonRowMapResult {
  ok: boolean;
  data?: PersonCreateInput;
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
    // exceljs puede devolver una celda de fecha ya como objeto Date.
    const d = String(value.getUTCDate()).padStart(2, "0");
    const m = String(value.getUTCMonth() + 1).padStart(2, "0");
    return `${d}-${m}-${value.getUTCFullYear()}`;
  }
  return String(value).trim();
}

/**
 * Convierte una fila cruda del Excel (9 celdas, en el orden de
 * `PERSONS_IMPORT_HEADERS`) en un `PersonCreateInput` validado, o en la
 * lista de errores encontrados — acumula TODOS los problemas de la fila
 * en vez de detenerse en el primero, igual que el resto de las
 * validaciones del sistema.
 */
export function mapRowToPersonInput(rawRow: unknown[]): PersonRowMapResult {
  const [runRaw, usernameRaw, firstNameRaw, paternalLastNameRaw, maternalLastNameRaw, birthDateRaw, genderRaw, emailRaw, phoneRaw] = [
    0, 1, 2, 3, 4, 5, 6, 7, 8,
  ].map((i) => cellToString(rawRow[i]));

  const errors: string[] = [];

  const birthDate = birthDateRaw ? parseSpanishDate(birthDateRaw) : null;
  if (birthDateRaw && !birthDate) errors.push(`Fecha de nacimiento inválida: "${birthDateRaw}" (use DD-MM-AAAA)`);

  const gender = genderRaw ? parseGender(genderRaw) : null;
  if (genderRaw && !gender) errors.push(`Género inválido: "${genderRaw}" (use "Femenino" o "Masculino")`);

  /**
   * Una columna de más se AVISA en vez de ignorarse: quien reutilice una
   * plantilla antigua con su columna «Roles» debe enterarse de que ese dato ya
   * no se aplica, no descubrirlo después viendo personas sin rol.
   */
  const sobrante = cellToString(rawRow[9]);
  if (sobrante) {
    errors.push(
      `Columna J en desuso: los roles ya no se cargan desde este archivo. El rol de nadador se obtiene al incorporar a la persona al plantel de un club, y los de delegado, entrenador y representante legal al nombrarla en la ficha del club. Borre esa columna y vuelva a cargar.`
    );
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

  return { ok: true, data: parsed.data, errors: [] };
}
