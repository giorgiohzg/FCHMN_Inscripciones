import ExcelJS from "exceljs";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../shared/prisma.client";
import { createPerson } from "./persons.service";
import { assignSwimmerDirectly } from "../swimmer-assignment/assignment.service";
import {
  mapRowToPersonInput,
  evaluarEncabezado,
  resolverSigla,
  detectarDuplicadosInternos,
  runYUsuarioDeFila,
  filaTraeClub,
  normalizarSigla,
  PERSONS_IMPORT_HEADERS,
  type ClubParaSigla,
  type ResolucionDeSigla,
} from "./persons-bulk-import.rules";
import { neutralizeSpreadsheetFormula } from "../reports/reports.rules";
import { ValidationError, ForbiddenError } from "../../shared/errors";
import { mensajePublicable } from "../../shared/errorPublicable";
import { analizarXlsxAislado } from "./xlsx/analisis-aislado";
import { LIMITES_XLSX, PERSONS_IMPORT_SHEET, type LimitesXlsx } from "./xlsx/limites";

export { PERSONS_IMPORT_SHEET };

interface ActorContext {
  userId: string;
  ipAddress?: string;
}

/** Nombre de la hoja de AYUDA. Nunca se procesa. */
export const PERSONS_INSTRUCTIONS_SHEET = "Instrucciones";

/** El permiso que exige incorporar personas a un club (crear membresías activas). */
export const PERMISO_ASIGNAR_CLUB = "swimmer-assignment:approve";

/** La fila ilustrativa: vive en la hoja de ayuda, jamás en la de datos. */
const EXAMPLE_ROW = [
  "12.345.678-5",
  "jperez",
  "Juan",
  "Pérez",
  "González",
  "15-03-1990",
  "Masculino",
  "jperez@correo.cl",
  "912345678",
  "SIGLA",
  "2026-03-01",
];

/**
 * Plantilla descargable: DOS hojas.
 *
 *   - `Personas`: solo el encabezado, sin ninguna fila de datos.
 *   - `Instrucciones`: la fila de ejemplo, las notas de formato y la LISTA de
 *     clubes vigentes y activos (sigla y nombre) a los que se puede incorporar.
 *
 * ANTES ERA UNA SOLA HOJA, y ese diseño creaba personas falsas. El ejemplo
 * («Juan Pérez González», RUN 12.345.678-5) es una fila enteramente válida, de
 * modo que quien descargaba la plantilla y la subía sin editar insertaba esa
 * persona en la base. La separación en dos hojas resuelve el problema por
 * construcción: la hoja que el importador lee no contiene datos, y la que
 * contiene el ejemplo no se lee.
 *
 * La lista de clubes se lee de la base, así que cada sigla y cada nombre pasan por
 * `neutralizeSpreadsheetFormula`: un nombre de club que empiece por `=`, `+`, `-`
 * o `@` se escribe como texto y no como fórmula.
 */
export async function buildPersonsImportTemplate(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  // --- Hoja de datos: encabezado y nada más -------------------------------
  const datos = workbook.addWorksheet(PERSONS_IMPORT_SHEET);
  datos.addRow(PERSONS_IMPORT_HEADERS).font = { bold: true };
  PERSONS_IMPORT_HEADERS.forEach((_, i) => {
    datos.getColumn(i + 1).width = 26;
  });

  // --- Hoja de ayuda: ejemplo y notas, fuera del alcance del importador ---
  const guia = workbook.addWorksheet(PERSONS_INSTRUCTIONS_SHEET);
  guia.getColumn(1).width = 120;
  guia.getColumn(2).width = 60;

  guia.addRow([`Esta hoja es solo informativa: el sistema NO la lee ni importa nada de ella.`]).font = {
    bold: true,
  };
  guia.addRow([`Escriba sus datos en la hoja «${PERSONS_IMPORT_SHEET}», a partir de la fila 2.`]);
  guia.addRow([]);

  guia.addRow(["Ejemplo de una fila bien formada (informativo, NO se importa):"]).font = { bold: true };
  guia.addRow(PERSONS_IMPORT_HEADERS).font = { italic: true };
  guia.addRow(EXAMPLE_ROW).font = { italic: true };
  guia.addRow([]);

  guia.addRow(["Notas:"]).font = { italic: true, bold: true };
  guia.addRow([`- No borre ni reordene la fila de encabezado de la hoja «${PERSONS_IMPORT_SHEET}» (fila 1).`]);
  guia.addRow([`- No escriba datos en esta hoja: no se procesan. Solo se lee «${PERSONS_IMPORT_SHEET}».`]);
  guia.addRow(["- Fecha de nacimiento: formato DD-MM-AAAA (ej: 15-03-1990)."]);
  guia.addRow(["- Género: escriba exactamente \"Femenino\" o \"Masculino\"."]);
  guia.addRow(["- El nombre de usuario, el correo electrónico, el teléfono, el apellido materno y el club son opcionales. Los demás campos son obligatorios."]);
  guia.addRow(["- Si deja vacío el nombre de usuario, la persona queda sin él: el sistema no inventa uno ni crea credenciales. Se le asigna después, en su ficha, al crear sus credenciales de acceso."]);
  guia.addRow(["- El RUN, y el nombre de usuario cuando lo escriba, deben ser únicos — el sistema rechazará filas repetidas dentro del archivo o ya existentes."]);
  guia.addRow([
    "- Club (columna J): escriba la SIGLA del club, no su nombre ni su nombre de usuario. Si la deja vacía, la persona se registra sin club. Si la escribe, la persona queda incorporada al plantel de ese club desde la fecha de la columna K, y obtiene el rol de nadador.",
  ]);
  guia.addRow([
    "- Fecha efectiva de membresía (columna K): obligatoria si hay club. Formato AAAA-MM-DD (ej: 2026-03-01) o DD-MM-AAAA. Es un día de calendario: se guarda exactamente ese día. El sistema NO usa la fecha de hoy por su cuenta. Si no hay club, déjela vacía.",
  ]);
  guia.addRow([
    "- Una persona que ya existe en el sistema (mismo RUN) no se modifica ni se cambia de club desde este archivo: esa fila se rechaza.",
  ]);
  guia.addRow([
    "- Este archivo NO tiene columna de roles. El rol de nadador se obtiene al incorporar a la persona a un club, y los de delegado, entrenador y representante legal al nombrarla en la ficha del club. Una plantilla antigua con la columna «Roles» se rechaza entera.",
  ]);
  guia.addRow([]);

  // --- Clubes a los que se puede incorporar -------------------------------
  // Mismo criterio que el importador: cada sigla se escribe normalizada y se evalúa con
  // `resolverSigla` contra TODOS los clubes vigentes, activos o no. La lista es orientativa;
  // la correspondencia vale la que haya al procesar cada fila, no la de esta descarga.
  const vigentes = await prisma.club.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, code: true, status: true, deletedAt: true },
    orderBy: [{ code: "asc" }, { name: "asc" }],
  });
  const clubes = vigentes.filter((c) => c.status === "active");
  guia.addRow(["Clubes vigentes y activos (use la SIGLA en la columna J):"]).font = { bold: true };
  guia.addRow(["Sigla", "Nombre del club"]).font = { italic: true, bold: true };
  if (clubes.length === 0) {
    guia.addRow(["(no hay clubes vigentes y activos)"]);
  } else {
    for (const c of clubes) {
      const nota = resolverSigla(c.code, vigentes).ok ? "" : " (sigla ambigua: no se puede usar hasta corregirla)";
      guia.addRow([neutralizeSpreadsheetFormula(normalizarSigla(c.code)), neutralizeSpreadsheetFormula(c.name + nota)]);
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/**
 * Qué club corresponde a la sigla AHORA, dentro de la transacción de la fila.
 *
 * `FOR SHARE` es lo que impide usar una correspondencia obsoleta:
 *   - si otra transacción está cambiando ese club (sigla, estado o baja), esta lectura ESPERA
 *     a que termine y evalúa la versión confirmada: si la sigla ya no le corresponde, el club
 *     no sale y la fila se rechaza;
 *   - una vez leído, ese club no puede cambiar hasta que esta fila termine, así que la
 *     sigla, el estado y la vigencia que se validaron son los que rigen al confirmar.
 *     La clave foránea de la membresía no bastaría: su bloqueo no frena un cambio de sigla.
 *
 * No hay caché: cada fila lee y bloquea. Se traen también los eliminados, solo para poder
 * decir por qué no se acepta la sigla; ver `resolverSigla`.
 */
async function resolverSiglaEnTransaccion(tx: Prisma.TransactionClient, sigla: string): Promise<ResolucionDeSigla> {
  const coincidentes = await tx.$queryRaw<ClubParaSigla[]>`
    SELECT id, name, code, status::text AS status, deleted_at AS "deletedAt"
      FROM clubs
     WHERE club_code_normalizado(code) = ${normalizarSigla(sigla)}
     ORDER BY id
       FOR SHARE`;
  return resolverSigla(sigla, coincidentes);
}

export interface BulkImportRowResult {
  row: number; // número de fila en el Excel (1-indexado, incluye el encabezado)
  status: "created" | "error";
  fullName?: string;
  /** Club al que quedó incorporada la persona (solo filas creadas con club). */
  clubName?: string;
  /** Fecha efectiva guardada, `AAAA-MM-DD` (solo filas creadas con club). */
  fechaEfectiva?: string;
  errors?: string[];
}

export interface BulkImportSummary {
  totalRows: number;
  /** Personas creadas (con o sin club). */
  createdCount: number;
  /** De las creadas, cuántas quedaron además incorporadas a un club. */
  withClubCount: number;
  errorCount: number;
  results: BulkImportRowResult[];
}

export interface BulkImportOptions {
  /**
   * ¿Tiene quien carga el permiso de incorporar personas a un club
   * (`swimmer-assignment:approve`)? Lo decide la ruta a partir del token. Por
   * omisión NO: así ningún llamador abre por descuido una vía de asignación.
   */
  puedeAsignarClub?: boolean;
  /** Límites del análisis. Solo las pruebas los cambian. */
  limites?: LimitesXlsx;
}

/**
 * Procesa el archivo Excel subido: valida y crea una persona por fila válida y,
 * si la fila trae club, su membresía activa con la fecha efectiva indicada.
 *
 * PARCIAL ENTRE FILAS, ATÓMICO DENTRO DE CADA UNA. Una fila con errores no detiene
 * las demás; pero cada fila se escribe en UNA transacción —persona, membresía, rol
 * de nadador derivado y las dos auditorías—, de modo que si algo falla a mitad de
 * camino la fila se revierte entera: nunca queda una persona creada sin el club
 * que pedía su fila mientras el informe dice «error».
 *
 * La sigla se resuelve DENTRO de esa misma transacción, fila por fila, bloqueando el club
 * (`resolverSiglaEnTransaccion`): una lectura previa al bucle podría quedar obsoleta si la
 * sigla cambia durante la carga. Si la sigla ya no corresponde, se rechaza esa fila y las
 * demás continúan.
 *
 * Antes de escribir nada se comprueba el ARCHIVO entero:
 *   - sus límites y su estructura, en un proceso aparte y con plazo (`xlsx/`): un archivo
 *     fuera de límites no llega a crear a nadie;
 *   - el encabezado de J y K (una plantilla con «Roles» se rechaza: nunca se lee
 *     como club);
 *   - el permiso: si alguna fila trae club y quien carga no puede asignar, se
 *     rechaza el archivo completo con 403, sin crear a nadie a medias.
 */
export async function importPersonsFromExcel(fileBuffer: Buffer, actor: ActorContext, opciones: BulkImportOptions = {}): Promise<BulkImportSummary> {
  const libro = await analizarXlsxAislado(fileBuffer, opciones.limites ?? LIMITES_XLSX);
  const { filas } = libro;

  const encabezado = evaluarEncabezado(libro.encabezado);
  if (!encabezado.ok) throw new ValidationError(encabezado.error);

  if (encabezado.conColumnasDeClub && !opciones.puedeAsignarClub && filas.some((f) => filaTraeClub(f.valores))) {
    throw new ForbiddenError(
      `El archivo incorpora personas a clubes, y eso requiere el permiso "${PERMISO_ASIGNAR_CLUB}". No se importó ninguna fila. ` +
        "Quite las siglas de club (columna J) y sus fechas (columna K) para registrar solo a las personas, o pida a un administrador que haga la carga."
    );
  }

  const duplicados = detectarDuplicadosInternos(filas.map((f) => ({ row: f.row, ...runYUsuarioDeFila(f.valores) })));

  const results: BulkImportRowResult[] = [];
  let createdCount = 0;
  let withClubCount = 0;

  for (const { row: rowNumber, valores } of filas) {
    const mapped = mapRowToPersonInput(valores, { conColumnasDeClub: encabezado.conColumnasDeClub });
    const errores = [...(duplicados.get(rowNumber) ?? []), ...mapped.errors];

    if (errores.length > 0 || !mapped.ok || !mapped.data) {
      results.push({ row: rowNumber, status: "error", errors: errores });
      continue;
    }

    const data = mapped.data;
    const sigla = mapped.sigla ?? null;
    const fechaEfectiva = mapped.fechaEfectiva ?? null;
    try {
      // UNA transacción por fila: resolución de la sigla + persona + membresía + rol derivado + auditorías.
      const { person, club } = await prisma.$transaction(async (tx) => {
        let elegido: ClubParaSigla | null = null;
        if (sigla) {
          const resuelto = await resolverSiglaEnTransaccion(tx, sigla);
          if (!resuelto.ok) throw new ValidationError(resuelto.error);
          elegido = resuelto.club;
        }
        const creada = await createPerson(data, actor, { tx });
        if (elegido) {
          await assignSwimmerDirectly({ clubId: elegido.id, personId: creada.id, fechaEfectiva: fechaEfectiva! }, actor, { tx });
        }
        return { person: creada, club: elegido };
      });
      results.push({
        row: rowNumber,
        status: "created",
        fullName: person.fullName,
        ...(club ? { clubName: club.name, fechaEfectiva: fechaEfectiva! } : {}),
      });
      createdCount++;
      if (club) withClubCount++;
    } catch (err) {
      // Solo lo previsto llega al archivo de resultados; lo inesperado queda en el registro interno.
      results.push({ row: rowNumber, status: "error", errors: [mensajePublicable(err, "carga-masiva-personas", rowNumber)] });
    }
  }

  return { totalRows: results.length, createdCount, withClubCount, errorCount: results.length - createdCount, results };
}
