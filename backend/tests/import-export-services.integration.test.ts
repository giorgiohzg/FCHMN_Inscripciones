/**
 * Fase 3 — pruebas que invocan REALMENTE los tres caminos de importación y
 * exportación contra PostgreSQL:
 *
 *   - `importCompetitionFromMeetEventsZip` (el ZIP de Meet Events)
 *   - `getRegistrationsReport` + `buildCsv` / `buildXlsx` (los reportes)
 *   - `buildTeamManagerExport` (el ZIP con el .CL2 y el .HY3)
 *
 * Hasta ahora la Fase 3 se apoyaba en pruebas de funciones puras
 * (parser, escritor HY3, escapado CSV, límites de ZIP). Eso verifica las
 * piezas, no el camino: nada comprobaba que el servicio de exportación
 * exigiera la piscina, que el tope contara los relevos, o que una
 * importación fallida no dejara una competencia a medio crear.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import AdmZip from "adm-zip";
import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { buildServer } from "../src/server";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addActiveMembership, addClubStaff, TEST_PASSWORD } from "./helpers/seedRbac";
import * as competitionsService from "../src/modules/competitions/competitions.service";
import * as structureService from "../src/modules/competitions/competition-structure.service";
import * as competitionEventsService from "../src/modules/competitions/competition-events.service";
import * as registrationsService from "../src/modules/registrations/registrations.service";
import * as relayService from "../src/modules/relay-registrations/relay-registrations.service";
import * as catalogsCategories from "../src/modules/catalogs/categories.service";
import * as catalogsEvents from "../src/modules/catalogs/events.service";
import * as reportsService from "../src/modules/reports/reports.service";
import { buildTeamManagerExport } from "../src/modules/team-manager-export/team-manager-export.service";
import { isValidCl2Line } from "../src/modules/team-manager-export/cl2-writer";
import { formatHy3Date } from "../src/modules/team-manager-export/hy3-writer";
import { computeHy3Checksum } from "../src/modules/team-manager-export/hy3-checksum";
import {
  importCompetitionFromMeetEventsZip,
  analizarArchivoDeImportacion,
  AVISO_DIA_EV3,
  AVISO_DIA_HYV,
  AVISO_JORNADA_SIN_ESPECIFICAR,
  JORNADA_SIN_ESPECIFICAR,
} from "../src/modules/meet-import/meet-import.service";
import {
  AVISO_ARCHIVO_CAMBIADO,
  AVISO_RELEVOS_SIN_CONFIRMAR_EV3,
  AVISO_RELEVOS_SIN_CONFIRMAR_HYV,
} from "../src/modules/meet-import/relay-decisions";
import { ValidationError, ForbiddenError, NotFoundError } from "../src/shared/errors";
import type { ActorContext } from "../src/shared/actorContext";

/**
 * El actor apunta a un usuario REAL de la base. Con un id inventado, cada
 * `audit()` falla con P2003 contra la clave foránea de `audit_logs.user_id`
 * y —como la auditoría suprime sus errores (hallazgo 23, Fase 5)— el fallo
 * pasa inadvertido y no se puede comprobar que las acciones queden
 * registradas.
 */
let SYSTEM_ACTOR: { userId: string; ipAddress?: string };
let ADMIN_ACTOR: ActorContext & { isAdmin: true; scope: { kind: "admin" } };

/** Catálogos base que normalmente crea el seed y de los que depende la importación. */
async function seedCatalogosBase() {
  await prisma.testType.upsert({ where: { name: "Individual" }, update: {}, create: { name: "Individual", swimmersCount: 1 } });
  await prisma.testType.upsert({ where: { name: "Relevo" }, update: {}, create: { name: "Relevo", swimmersCount: 4 } });
  for (const meters of [50, 100, 200, 400]) {
    await prisma.distance.upsert({ where: { meters }, update: {}, create: { meters } });
  }
  for (const name of ["Libre", "Espalda", "Pecho", "Mariposa", "Combinado"]) {
    await prisma.stroke.upsert({ where: { name }, update: {}, create: { name } });
  }
  for (const name of ["Mañana", "Tarde", "Noche"]) {
    await prisma.sessionType.upsert({ where: { name }, update: {}, create: { name } });
  }
}

const SAMPLE_EV3 = readFileSync(join(__dirname, "fixtures", "sample.ev3"), "latin1");

/**
 * Confirma TODOS los relevos del archivo con un mismo tipo del catálogo.
 *
 * Desde que la confirmación se exige en los DOS formatos, cualquier prueba que
 * importe un archivo con relevos tiene que pasar por aquí. Va a nivel de
 * módulo y no dentro de un `describe` porque la necesitan tanto las pruebas de
 * `.hyv` como las de `.ev3`.
 *
 * Pasa por el análisis real en vez de fabricar la huella: así, de paso,
 * comprueba que las dos fases encajan.
 */
async function confirmarTodo(buffer: Buffer, nombre: string, testTypeId?: string) {
  const analisis = await analizarArchivoDeImportacion(buffer, SYSTEM_ACTOR, nombre);
  return {
    fileHash: analisis.fileHash,
    decisiones: analisis.relevos.map((r) => ({
      eventNumber: r.eventNumber,
      decision: "tipo" as const,
      testTypeId: testTypeId ?? r.opciones[0]!.testTypeId,
    })),
  };
}

function zipConEv3(contenido: string, nombre = "Meet Events-Copa.ev3"): Buffer {
  const zip = new AdmZip();
  zip.addFile(nombre, Buffer.from(contenido, "latin1"));
  return zip.toBuffer();
}

/** Encabezado del .ev3 con fechas a medida + las líneas de prueba indicadas. */
function ev3Con(opciones: { inicio: string; fin: string; lineas: string[] }): string {
  const encabezado = `Copa de Prueba;Club Org;${opciones.inicio};${opciones.fin};12/31/2026;S;0;290;0;Created by Hy-Tek's MEET MANAGER;Chile;8.0Gc;02/06`;
  return [encabezado, ...opciones.lineas].join("\r\n");
}

const LINEA_INDIVIDUAL = "1;1;F;1;I;W;0;109;50;A;0;;;N;0;;;;;;;1;1;1;09:45AM;S;4;3;1;0*>";

/**
 * Observación e intervención de consultas mediante un MIDDLEWARE de Prisma.
 *
 * No se puede usar `vi.spyOn` sobre `prisma.registration.count`: los
 * delegados son Proxies, y tanto restaurar el espía como borrar la propiedad
 * dejan el método en `undefined`, rompiendo el cliente para todas las
 * pruebas siguientes ("prisma.registration.count is not a function").
 *
 * Un middleware es no invasivo: se registra UNA vez, queda inerte mientras
 * el control esté apagado, y permite (a) devolver conteos obsoletos —lo que
 * ocurre en la realidad cuando otro club inscribe entre contar y leer— y
 * (b) capturar los argumentos reales de cada `findMany`, incluido su `take`,
 * dejando que la consulta se ejecute de verdad contra la base.
 */
interface ConsultaCapturada {
  model: string;
  args: { take?: number } & Record<string, unknown>;
}

const control: {
  conteoObsoleto: number | null;
  capturas: ConsultaCapturada[];
  /** Si no es `null`, reordena lo que devuelve la lectura de inscripciones individuales (la consulta se ejecuta de verdad). */
  reordenarIndividuales: ((filas: Array<{ competitionEvent: { displayOrder: number | null } }>) => unknown[]) | null;
} = {
  conteoObsoleto: null,
  capturas: [],
  reordenarIndividuales: null,
};

const MODELOS_DE_INSCRIPCION = new Set(["Registration", "RelayRegistration"]);

prisma.$use(async (params, next) => {
  if (params.model && MODELOS_DE_INSCRIPCION.has(params.model)) {
    if (control.conteoObsoleto !== null && params.action === "count") {
      return control.conteoObsoleto;
    }
    if (params.action === "findMany") {
      control.capturas.push({ model: params.model, args: (params.args ?? {}) as ConsultaCapturada["args"] });
    }
  }
  const resultado = await next(params);
  if (control.reordenarIndividuales && params.model === "Registration" && params.action === "findMany") {
    return control.reordenarIndividuales(resultado);
  }
  return resultado;
});

/** Fuerza los `count` a un valor obsoleto y empieza a capturar las lecturas. */
function conConteosObsoletos(valor = 0) {
  control.conteoObsoleto = valor;
  control.capturas = [];
  return {
    /** Lecturas capturadas de un modelo, en orden. */
    lecturasDe: (model: "Registration" | "RelayRegistration") => control.capturas.filter((c) => c.model === model),
    restore: () => {
      control.conteoObsoleto = null;
      control.capturas = [];
    },
  };
}

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  await seedCatalogosBase();

  const admin = await createUser({ username: "admin_importexport", roleNames: ["admin"] });
  SYSTEM_ACTOR = { userId: admin.id };
  ADMIN_ACTOR = { userId: admin.id, isAdmin: true, scope: { kind: "admin" }, canRegisterPostClose: true };
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// importCompetitionFromMeetEventsZip
// ---------------------------------------------------------------------------

describe("importCompetitionFromMeetEventsZip (invocación real)", () => {
  it("importa una competencia de UN día y deja la estructura completa en la base", async () => {
    const resumen = await importCompetitionFromMeetEventsZip(
      zipConEv3(ev3Con({ inicio: "03/28/2026", fin: "03/28/2026", lineas: [LINEA_INDIVIDUAL] })),
      { maxIndividualEventsPerSwimmer: 5 },
      SYSTEM_ACTOR
    );

    expect(resumen.eventsImported).toBe(1);
    expect(resumen.eventsSkipped).toBe(0);

    const competencia = await prisma.competition.findUniqueOrThrow({
      where: { id: resumen.competitionId },
      include: { dates: { include: { sessions: true } }, competitionEvents: true },
    });
    // Cambio 6: lo importado nace VISIBLE en los paneles de inscripción y relevos, salvo configuración expresa.
    expect(competencia.visibleInRegistrationPanels).toBe(true);
    // Etapa 4: las pruebas importadas empiezan SIN límite de nadadores por club (NULL).
    expect(competencia.competitionEvents.length).toBeGreaterThan(0);
    expect(competencia.competitionEvents.every((c) => c.maxSwimmersPerClub === null)).toBe(true);
    expect(competencia.status).toBe("draft");
    expect(competencia.dates).toHaveLength(1);
    expect(competencia.dates[0]!.sessions).toHaveLength(1);
    expect(competencia.competitionEvents).toHaveLength(1);
  });

  /**
   * CAMBIO DE COMPORTAMIENTO (antes esto era un rechazo).
   *
   * El `.ev3` no dice en qué día se nada cada prueba. Antes la importación se
   * rechazaba por eso, y el administrador tenía que cargar decenas de pruebas
   * a mano. Ahora se importa: todas las pruebas van al primer día y un aviso
   * explícito pide moverlas. Las demás fechas se crean vacías para que
   * moverlas sea arrastrarlas a un día que ya existe.
   */
  it("una competencia de varios días se importa TODA en el primer día, con aviso", async () => {
    const zip = zipConEv3(ev3Con({ inicio: "03/28/2026", fin: "03/30/2026", lineas: [LINEA_INDIVIDUAL] }));

    const resumen = await importCompetitionFromMeetEventsZip(zip, { maxIndividualEventsPerSwimmer: 5 }, SYSTEM_ACTOR);

    expect(resumen.eventsImported).toBe(1);
    expect(resumen.warnings).toContain(AVISO_DIA_EV3);
    /**
     * El aviso NO debe decir que el archivo no trae la información. Un `.ev3`
     * real de dos días sí la trae: lo que no se puede es saber cuál de sus
     * campos es el día y cuál el número de sesión. Esta comprobación existe
     * para que esa redacción no vuelva a colarse.
     */
    expect(resumen.warnings.join(" ")).not.toMatch(/el archivo no especifica qué pruebas/i);

    const competencia = await prisma.competition.findUniqueOrThrow({
      where: { id: resumen.competitionId },
      include: { dates: { include: { sessions: { include: { competitionEvents: true } } } } },
    });

    // Los TRES días existen, para poder mover las pruebas a su sitio.
    expect(competencia.dates).toHaveLength(3);

    const porDia = [...competencia.dates]
      .sort((a, b) => a.date.getTime() - b.date.getTime())
      .map((d) => d.sessions.reduce((n, s) => n + s.competitionEvents.length, 0));

    // Todas las pruebas en el primero; los otros dos, vacíos.
    expect(porDia).toEqual([1, 0, 0]);
  });

  /**
   * FORMATOS ADMITIDOS — el contenido decide, no la extensión.
   *
   * Estas pruebas recorren el camino REAL de importación, no solo el
   * detector: lo que se comprueba es que un `.ev3` suelto y un `.hyv` con ese
   * mismo contenido terminan creando la misma competencia con el importador
   * que ya existía, y que un `.hyv` con contenido ajeno se rechaza.
   */
  describe("formatos admitidos", () => {
    const FIXTURES = join(__dirname, "fixtures");

    it("importa un .ev3 SUELTO, sin comprimir", async () => {
      const ev3 = Buffer.from(ev3Con({ inicio: "03/28/2026", fin: "03/28/2026", lineas: [LINEA_INDIVIDUAL] }), "latin1");

      const resumen = await importCompetitionFromMeetEventsZip(ev3, { maxIndividualEventsPerSwimmer: 5 }, SYSTEM_ACTOR, "programa.ev3");

      expect(resumen.eventsImported).toBe(1);
      expect(await prisma.competition.count()).toBe(1);
    });

    it("importa un .hyv cuyo contenido es un .ev3 — reutiliza el mismo importador", async () => {
      const hyv = readFileSync(join(FIXTURES, "sample-meet-events.hyv"));

      const resumen = await importCompetitionFromMeetEventsZip(
        hyv,
        { maxIndividualEventsPerSwimmer: 5, confirmacionDeRelevos: await confirmarTodo(hyv, "sample-meet-events.hyv") },
        SYSTEM_ACTOR,
        "sample-meet-events.hyv"
      );

      // El fixture sintético trae 14 pruebas y una competencia de un día.
      expect(resumen.eventsImported).toBe(14);
      expect(resumen.competitionName).toBe("Competencia Sintética de Pruebas");
    });

    it("RECHAZA un .hyv cuyo contenido no es importable, SIN crear nada", async () => {
      const basura = readFileSync(join(FIXTURES, "sample-no-importable.hyv"));

      await expect(
        importCompetitionFromMeetEventsZip(basura, { maxIndividualEventsPerSwimmer: 5 }, SYSTEM_ACTOR, "sample-no-importable.hyv")
      ).rejects.toThrow(/no tiene el contenido de una exportación/i);

      expect(await prisma.competition.count()).toBe(0);
    });

    it("el archivo multidía sintético carga sus 14 pruebas en el primer día de tres", async () => {
      const multiday = readFileSync(join(FIXTURES, "sample-multiday.ev3"));

      const resumen = await importCompetitionFromMeetEventsZip(
        multiday,
        { maxIndividualEventsPerSwimmer: 5, confirmacionDeRelevos: await confirmarTodo(multiday, "sample-multiday.ev3") },
        SYSTEM_ACTOR,
        "sample-multiday.ev3"
      );

      expect(resumen.eventsImported).toBe(14);
      expect(resumen.warnings).toContain(AVISO_DIA_EV3);

      const competencia = await prisma.competition.findUniqueOrThrow({
        where: { id: resumen.competitionId },
        include: { dates: { include: { sessions: { include: { competitionEvents: true } } } } },
      });
      expect(competencia.dates).toHaveLength(3);
      const porDia = [...competencia.dates]
        .sort((a, b) => a.date.getTime() - b.date.getTime())
        .map((d) => d.sessions.reduce((n, s) => n + s.competitionEvents.length, 0));
      expect(porDia[0]).toBe(14);
      expect(porDia.slice(1)).toEqual([0, 0]);
    });
  });

  /**
   * FORMATO `.hyv` NATIVO.
   *
   * El fixture se traduce campo a campo desde `sample.ev3`, así que describe
   * LA MISMA competencia que el `.ev3`. Eso permite la comprobación que cierra
   * de verdad el riesgo de tener dos parsers: importar los dos archivos y
   * exigir que produzcan el mismo conjunto de pruebas. Si alguno se desvía
   * —un estilo mal mapeado, el género leído de la columna equivocada—, esa
   * prueba falla aunque las dos importaciones sigan "funcionando".
   */
  describe("formato .hyv nativo", () => {
    const FIXTURES = join(__dirname, "fixtures");
    const OPCIONES = { maxIndividualEventsPerSwimmer: 5 };
    const HYV_NATIVO = readFileSync(join(FIXTURES, "sample-hyv-nativo.hyv"));

    async function pruebasImportadas(competitionId: string) {
      const filas = await prisma.competitionEvent.findMany({
        where: { competitionId },
        include: { event: { include: { distance: true, stroke: true, testType: true } } },
      });
      return filas
        .map((f) => `${f.event.testType.swimmersCount > 1 ? "R" : "I"} ${f.event.distance.meters} ${f.event.stroke.name} ${f.event.gender}`)
        .sort();
    }

    it("importa un .hyv nativo: 14 pruebas, sin ninguna saltada", async () => {
      const resumen = await importCompetitionFromMeetEventsZip(
        HYV_NATIVO,
        { ...OPCIONES, confirmacionDeRelevos: await confirmarTodo(HYV_NATIVO, "sample-hyv-nativo.hyv") },
        SYSTEM_ACTOR,
        "sample-hyv-nativo.hyv"
      );

      expect(resumen.eventsImported).toBe(14);
      expect(resumen.eventsSkipped).toBe(0);
      expect(resumen.competitionName).toBe("Competencia Sintética de Pruebas");
      expect(resumen.warnings.join(" ")).not.toMatch(/no se pudo importar/i);
    });

    it("produce EXACTAMENTE las mismas pruebas que el .ev3 del mismo programa", async () => {
      /**
       * El tipo de relevo se fija POR IDENTIDAD en las dos importaciones.
       *
       * Antes cada una tomaba `opciones[0]` del análisis. Eso vale mientras el
       * catálogo tenga un solo tipo de relevo, pero hace que la comparación
       * dependa de un orden en vez de de lo que la prueba quiere medir: que
       * los dos parsers produzcan las mismas pruebas. Si alguna vez las dos
       * llamadas eligieran distinto, esta prueba fallaría señalando a los
       * parsers, que no tendrían la culpa.
       */
      const tipoDeRelevo = await prisma.testType.findFirstOrThrow({ where: { swimmersCount: { gt: 1 } } });

      const desdeHyv = await importCompetitionFromMeetEventsZip(
        HYV_NATIVO,
        { ...OPCIONES, confirmacionDeRelevos: await confirmarTodo(HYV_NATIVO, "sample-hyv-nativo.hyv", tipoDeRelevo.id) },
        SYSTEM_ACTOR,
        "sample-hyv-nativo.hyv"
      );
      const ev3 = readFileSync(join(FIXTURES, "sample.ev3"));
      const desdeEv3 = await importCompetitionFromMeetEventsZip(
        ev3,
        { ...OPCIONES, confirmacionDeRelevos: await confirmarTodo(ev3, "sample.ev3", tipoDeRelevo.id) },
        SYSTEM_ACTOR,
        "sample.ev3"
      );

      const porHyv = await pruebasImportadas(desdeHyv.competitionId);
      const porEv3 = await pruebasImportadas(desdeEv3.competitionId);

      expect(porHyv).toEqual(porEv3);
      expect(porHyv).toHaveLength(14);
      // Y que la comparación no sea vacua: los cinco estilos tienen que estar.
      expect(new Set(porHyv.map((p) => p.split(" ")[2]))).toEqual(
        new Set(["Libre", "Espalda", "Pecho", "Mariposa", "Combinado"])
      );
    });

    it("deja TODAS las pruebas en la jornada sin especificar, y avisa", async () => {
      const resumen = await importCompetitionFromMeetEventsZip(
        HYV_NATIVO,
        { ...OPCIONES, confirmacionDeRelevos: await confirmarTodo(HYV_NATIVO, "sample-hyv-nativo.hyv") },
        SYSTEM_ACTOR,
        "sample-hyv-nativo.hyv"
      );

      const competencia = await prisma.competition.findUniqueOrThrow({
        where: { id: resumen.competitionId },
        include: { dates: { include: { sessions: { include: { sessionType: true, competitionEvents: true } } } } },
      });

      const jornadas = competencia.dates.flatMap((d) => d.sessions);
      expect(jornadas).toHaveLength(1);
      expect(jornadas[0]!.sessionType.name).toBe(JORNADA_SIN_ESPECIFICAR);
      expect(jornadas[0]!.competitionEvents).toHaveLength(14);

      // NUNCA se reparten entre Mañana y Tarde: eso sería inventar el dato.
      expect(jornadas.map((j) => j.sessionType.name)).not.toContain("Mañana");
      expect(jornadas.map((j) => j.sessionType.name)).not.toContain("Tarde");

      expect(resumen.warnings.some((w) => w.startsWith(AVISO_JORNADA_SIN_ESPECIFICAR))).toBe(true);
      expect(resumen.warnings.join(" ")).toMatch(/14 de 14 pruebas importadas/);
    });

    it("con varios días muestra LOS DOS avisos: falta el día y falta la jornada", async () => {
      const multiday = readFileSync(join(FIXTURES, "sample-hyv-nativo-multiday.hyv"));
      const resumen = await importCompetitionFromMeetEventsZip(
        multiday,
        { ...OPCIONES, confirmacionDeRelevos: await confirmarTodo(multiday, "sample-hyv-nativo-multiday.hyv") },
        SYSTEM_ACTOR,
        "sample-hyv-nativo-multiday.hyv"
      );

      expect(resumen.warnings).toContain(AVISO_DIA_HYV);
      expect(resumen.warnings.some((w) => w.startsWith(AVISO_JORNADA_SIN_ESPECIFICAR))).toBe(true);
      // El aviso del .hyv es el que corresponde, no el del .ev3.
      expect(resumen.warnings).not.toContain(AVISO_DIA_EV3);

      const competencia = await prisma.competition.findUniqueOrThrow({
        where: { id: resumen.competitionId },
        include: { dates: { include: { sessions: { include: { competitionEvents: true } } } } },
      });

      // Los dos días existen —para poder arrastrar las pruebas— y todas las
      // pruebas están en el primero.
      expect(competencia.dates).toHaveLength(2);
      const porDia = [...competencia.dates]
        .sort((a, b) => a.date.getTime() - b.date.getTime())
        .map((d) => d.sessions.reduce((n, s) => n + s.competitionEvents.length, 0));
      expect(porDia).toEqual([14, 0]);
    });

    it("con los relevos confirmados NO aparece ningún aviso de tipo elegido sin confirmar", async () => {
      /**
       * Esta prueba cambió de sentido a propósito. Antes exigía un aviso que
       * decía que el importador había elegido el tipo de relevo por su cuenta.
       * Ese aviso ya no debe existir para un `.hyv`: o el usuario confirma
       * cada relevo, o no se importa. Un aviso residual de "se eligió por ti"
       * sería la señal de que quedó un camino que decide solo.
       */
      const resumen = await importCompetitionFromMeetEventsZip(
        HYV_NATIVO,
        { ...OPCIONES, confirmacionDeRelevos: await confirmarTodo(HYV_NATIVO, "sample-hyv-nativo.hyv") },
        SYSTEM_ACTOR,
        "sample-hyv-nativo.hyv"
      );

      expect(resumen.eventsImported).toBe(14);
      expect(resumen.warnings.join(" ")).not.toMatch(/no se confirmó/i);
      expect(resumen.warnings.join(" ")).not.toMatch(/primer tipo del catálogo/i);
      expect(resumen.warnings.join(" ")).not.toMatch(/no indica el número de postas/i);
    });

    it("los relevos del .hyv conservan la distancia TOTAL, igual que los del .ev3", async () => {
      const resumen = await importCompetitionFromMeetEventsZip(
        HYV_NATIVO,
        { ...OPCIONES, confirmacionDeRelevos: await confirmarTodo(HYV_NATIVO, "sample-hyv-nativo.hyv") },
        SYSTEM_ACTOR,
        "sample-hyv-nativo.hyv"
      );

      const relevos = await prisma.competitionEvent.findMany({
        where: { competitionId: resumen.competitionId, event: { testType: { swimmersCount: { gt: 1 } } } },
        include: { event: { include: { distance: true } } },
      });
      expect(relevos).toHaveLength(4);
      // 200 es el TOTAL de un 4×50, no la distancia por posta.
      expect(relevos.every((r) => r.event.distance.meters === 200)).toBe(true);
    });

    /**
     * SOLO LA VERSIÓN Y LA DISPOSICIÓN VERIFICADAS.
     *
     * Lo que se comprueba aquí no es el mensaje —eso ya lo cubren las pruebas
     * del parser— sino la consecuencia que importa: que NO queda nada escrito.
     * Un rechazo que dejara una competencia a medio armar sería peor que
     * haberla importado mal, porque nadie sabría que está incompleta.
     */
    describe("un .hyv que no coincide con lo verificado se rechaza sin crear la competencia", () => {
      const original = () => readFileSync(join(FIXTURES, "sample-hyv-nativo.hyv"), "latin1");

      async function rechazaSinEscribir(contenido: string, patron: RegExp) {
        const antes = {
          competencias: await prisma.competition.count(),
          fechas: await prisma.competitionDate.count(),
          jornadas: await prisma.competitionSession.count(),
          pruebas: await prisma.competitionEvent.count(),
        };

        await expect(
          importCompetitionFromMeetEventsZip(Buffer.from(contenido, "latin1"), OPCIONES, SYSTEM_ACTOR, "otra-version.hyv")
        ).rejects.toThrow(patron);

        expect({
          competencias: await prisma.competition.count(),
          fechas: await prisma.competitionDate.count(),
          jornadas: await prisma.competitionSession.count(),
          pruebas: await prisma.competitionEvent.count(),
        }).toEqual(antes);
      }

      it("otra versión del exportador", async () => {
        const lineas = original().split("\r\n");
        const cab = lineas[0]!.split(";");
        cab[8] = "8.1Ab";
        await rechazaSinEscribir([cab.join(";"), ...lineas.slice(1)].join("\r\n"), /8\.1Ab/);
      });

      it("un encabezado con un campo de más", async () => {
        const lineas = original().split("\r\n");
        await rechazaSinEscribir([lineas[0] + ";extra", ...lineas.slice(1)].join("\r\n"), /encabezado.*12 campos/is);
      });

      it("una sola línea de prueba con un campo de más", async () => {
        const lineas = original().split("\r\n");
        lineas[3] = lineas[3] + ";extra";
        await rechazaSinEscribir(lineas.join("\r\n"), /línea 4.*19 campos/is);
      });

      it("el rechazo NO se interpreta por posición: no se importa una competencia parcial", async () => {
        const lineas = original().split("\r\n");
        const cab = lineas[0]!.split(";");
        cab[8] = "8.1Ab";
        await expect(
          importCompetitionFromMeetEventsZip(
            Buffer.from([cab.join(";"), ...lineas.slice(1)].join("\r\n"), "latin1"),
            OPCIONES,
            SYSTEM_ACTOR,
            "otra-version.hyv"
          )
        ).rejects.toThrow(/No se importó nada/i);
      });

      it("deja registro del intento fallido, en la etapa de interpretación", async () => {
        const lineas = original().split("\r\n");
        const cab = lineas[0]!.split(";");
        cab[8] = "8.1Ab";

        await importCompetitionFromMeetEventsZip(
          Buffer.from([cab.join(";"), ...lineas.slice(1)].join("\r\n"), "latin1"),
          OPCIONES,
          SYSTEM_ACTOR,
          "otra-version.hyv"
        ).catch(() => undefined);

        const registro = await prisma.auditLog.findFirstOrThrow({
          where: { action: "COMPETITION_IMPORT_FAILED" },
          orderBy: { createdAt: "desc" },
        });
        const after = registro.after as Record<string, unknown>;
        expect(after.etapa).toBe("interpretacion-del-archivo");
        expect(String(after.reason)).toMatch(/8\.1Ab/);
      });
    });

    it("el registro de auditoría anota el formato y las pruebas sin jornada", async () => {
      const resumen = await importCompetitionFromMeetEventsZip(
        HYV_NATIVO,
        { ...OPCIONES, confirmacionDeRelevos: await confirmarTodo(HYV_NATIVO, "sample-hyv-nativo.hyv") },
        SYSTEM_ACTOR,
        "sample-hyv-nativo.hyv"
      );

      const registro = await prisma.auditLog.findFirstOrThrow({
        where: { action: "COMPETITION_IMPORTED_FROM_MEET_EVENTS", entityId: resumen.competitionId },
      });
      const after = registro.after as Record<string, unknown>;
      expect(after.formato).toBe("hyv");
      expect(after.pruebasSinJornada).toBe(14);
    });

    /**
     * CONFIRMACIÓN EXPLÍCITA DEL TIPO DE RELEVO — las dos fases.
     *
     * Lo que estas pruebas exigen es que nada se importe sin una decisión
     * propia, y que cuando algo se rechaza NO quede nada escrito. Por eso casi
     * todas comprueban el conteo de filas antes y después, no solo el mensaje.
     */
    describe("confirmación del tipo de relevo", () => {
      const GEMELOS = readFileSync(join(FIXTURES, "sample-hyv-relevos-gemelos.hyv"));

      async function conteos() {
        return {
          competencias: await prisma.competition.count(),
          fechas: await prisma.competitionDate.count(),
          jornadas: await prisma.competitionSession.count(),
          pruebas: await prisma.competitionEvent.count(),
        };
      }

      /** Segundo tipo de relevo, para que haya algo entre lo que elegir. */
      async function crearRelevoDeDos() {
        return prisma.testType.upsert({
          where: { name: "Relevo por parejas" },
          update: {},
          create: { name: "Relevo por parejas", swimmersCount: 2 },
        });
      }

      // ---- fase 1: analizar sin escribir ---------------------------------

      it("el análisis no crea la competencia ni el catálogo, y describe cada relevo por separado", async () => {
        const antes = await conteos();
        const distanciasAntes = await prisma.distance.count();
        const estilosAntes = await prisma.stroke.count();
        const jornadasAntes = await prisma.sessionType.count();

        const analisis = await analizarArchivoDeImportacion(HYV_NATIVO, SYSTEM_ACTOR, "sample-hyv-nativo.hyv");

        expect(await conteos()).toEqual(antes);
        // Tampoco crea catálogo al vuelo, que es lo que sí hace la importación.
        expect(await prisma.distance.count()).toBe(distanciasAntes);
        expect(await prisma.stroke.count()).toBe(estilosAntes);
        expect(await prisma.sessionType.count()).toBe(jornadasAntes);

        expect(analisis.eventsTotal).toBe(14);
        expect(analisis.relevos).toHaveLength(4);
        expect(analisis.requiereConfirmacionDeRelevos).toBe(true);
        expect(analisis.fileHash).toMatch(/^[0-9a-f]{64}$/);
      });

      it("un análisis que prospera NO deja registro de auditoría; uno que falla SÍ", async () => {
        /**
         * La promesa del análisis es acotada, y conviene que la prueba diga
         * exactamente cuál es: no crea la competencia. "No escribe nada" sería
         * falso, porque un análisis fallido deja constancia a propósito —si no,
         * al separar esta fase se habría perdido el rastro de los archivos
         * ilegibles, que es justo el que sirve para diagnosticarlos—.
         */
        const registros = () => prisma.auditLog.count({ where: { action: "COMPETITION_IMPORT_FAILED" } });

        await analizarArchivoDeImportacion(HYV_NATIVO, SYSTEM_ACTOR, "sample-hyv-nativo.hyv");
        expect(await registros(), "un análisis correcto no escribe nada").toBe(0);

        await expect(
          analizarArchivoDeImportacion(Buffer.from("esto no es una exportación\r\nde nada\r\n", "latin1"), SYSTEM_ACTOR, "basura.hyv")
        ).rejects.toThrow();

        expect(await registros(), "un análisis fallido sí deja rastro").toBe(1);
        const registro = await prisma.auditLog.findFirstOrThrow({ where: { action: "COMPETITION_IMPORT_FAILED" } });
        expect((registro.after as Record<string, unknown>).fase).toBe("analisis");
        // Y aun así no se creó ninguna competencia.
        expect(await prisma.competition.count()).toBe(0);
      });

      it("el análisis ofrece las opciones del catálogo, ninguna preseleccionada", async () => {
        await crearRelevoDeDos();
        const analisis = await analizarArchivoDeImportacion(HYV_NATIVO, SYSTEM_ACTOR, "sample-hyv-nativo.hyv");

        const opciones = analisis.relevos[0]!.opciones;
        expect(opciones).toHaveLength(2);
        // La consecuencia de cada opción va junto a ella: 200 m en 2 o en 4.
        expect(opciones.map((o) => o.etiqueta).sort()).toEqual(["2×100", "4×50"]);
        // Y no hay ningún campo que marque una como elegida.
        expect(JSON.stringify(opciones)).not.toMatch(/seleccionad|elegid|default|preferid/i);
      });

      // ---- el caso que obliga a decidir por prueba -----------------------

      it("dos relevos IDÉNTICOS admiten decisiones distintas, y cada una se respeta", async () => {
        const dos = await crearRelevoDeDos();
        const cuatro = await prisma.testType.findFirstOrThrow({ where: { name: "Relevo" } });

        const analisis = await analizarArchivoDeImportacion(GEMELOS, SYSTEM_ACTOR, "gemelos.hyv");
        const once = analisis.relevos.find((r) => r.eventNumber === 11)!;
        const trece = analisis.relevos.find((r) => r.eventNumber === 13)!;

        // El fixture cumple su cometido: son indistinguibles salvo por el número.
        expect(once.distanceMeters).toBe(trece.distanceMeters);
        expect(once.strokeName).toBe(trece.strokeName);
        expect(once.gender).toBe(trece.gender);

        const resumen = await importCompetitionFromMeetEventsZip(
          GEMELOS,
          {
            ...OPCIONES,
            confirmacionDeRelevos: {
              fileHash: analisis.fileHash,
              decisiones: analisis.relevos.map((r) => ({
                eventNumber: r.eventNumber,
                decision: "tipo" as const,
                testTypeId: r.eventNumber === 13 ? dos.id : cuatro.id,
              })),
            },
          },
          SYSTEM_ACTOR,
          "gemelos.hyv"
        );

        expect(resumen.eventsImported).toBe(14);

        const relevos = await prisma.competitionEvent.findMany({
          where: { competitionId: resumen.competitionId, event: { testType: { swimmersCount: { gt: 1 } } } },
          include: { event: { include: { testType: true, distance: true } } },
        });

        // Los dos gemelos existen como pruebas DISTINTAS, con distinto tipo.
        const porPostas = relevos.map((r) => r.event.testType.swimmersCount).sort();
        expect(porPostas).toEqual([2, 4, 4, 4]);
        const dePareja = relevos.filter((r) => r.event.testType.swimmersCount === 2);
        expect(dePareja).toHaveLength(1);
        expect(dePareja[0]!.event.distance.meters).toBe(200); // el total no cambia
      });

      // ---- archivo cambiado entre fases ----------------------------------

      it("RECHAZA sin crear la competencia si el archivo cambió entre el análisis y la confirmación", async () => {
        // Se analiza uno y se confirma sobre OTRO cuyos números de prueba
        // coinciden: es el caso peligroso, porque las decisiones "encajan".
        const confirmacion = await confirmarTodo(HYV_NATIVO, "sample-hyv-nativo.hyv");
        const antes = await conteos();

        await expect(
          importCompetitionFromMeetEventsZip(GEMELOS, { ...OPCIONES, confirmacionDeRelevos: confirmacion }, SYSTEM_ACTOR, "gemelos.hyv")
        ).rejects.toThrow(AVISO_ARCHIVO_CAMBIADO);

        expect(await conteos()).toEqual(antes);
      });

      it("basta un byte distinto para que la huella no valga", async () => {
        const confirmacion = await confirmarTodo(HYV_NATIVO, "sample-hyv-nativo.hyv");
        const retocado = Buffer.from(HYV_NATIVO.toString("latin1").replace("Competencia Sintética", "Competencia Sintetica"), "latin1");

        await expect(
          importCompetitionFromMeetEventsZip(retocado, { ...OPCIONES, confirmacionDeRelevos: confirmacion }, SYSTEM_ACTOR, "x.hyv")
        ).rejects.toThrow(AVISO_ARCHIVO_CAMBIADO);
      });

      // ---- elección que ya no existe en el catálogo -----------------------

      it("RECHAZA sin crear la competencia si el tipo elegido ya no existe al importar", async () => {
        const dos = await crearRelevoDeDos();
        const confirmacion = await confirmarTodo(HYV_NATIVO, "sample-hyv-nativo.hyv", dos.id);

        // Entre el análisis y la confirmación, alguien borra ese tipo.
        await prisma.testType.delete({ where: { id: dos.id } });
        const antes = await conteos();

        await expect(
          importCompetitionFromMeetEventsZip(HYV_NATIVO, { ...OPCIONES, confirmacionDeRelevos: confirmacion }, SYSTEM_ACTOR, "x.hyv")
        ).rejects.toThrow(/ya no existe en el catálogo/i);

        expect(await conteos()).toEqual(antes);
      });

      it("RECHAZA un tipo que existe pero no es de relevo", async () => {
        const individual = await prisma.testType.findFirstOrThrow({ where: { name: "Individual" } });
        const confirmacion = await confirmarTodo(HYV_NATIVO, "sample-hyv-nativo.hyv", individual.id);
        const antes = await conteos();

        await expect(
          importCompetitionFromMeetEventsZip(HYV_NATIVO, { ...OPCIONES, confirmacionDeRelevos: confirmacion }, SYSTEM_ACTOR, "x.hyv")
        ).rejects.toThrow(/ya no existe en el catálogo/i);

        expect(await conteos()).toEqual(antes);
      });

      // ---- decisión faltante ----------------------------------------------

      it("RECHAZA sin crear la competencia si falta la decisión de un solo relevo", async () => {
        const completa = await confirmarTodo(HYV_NATIVO, "sample-hyv-nativo.hyv");
        const incompleta = { ...completa, decisiones: completa.decisiones.slice(0, -1) };
        const antes = await conteos();

        await expect(
          importCompetitionFromMeetEventsZip(HYV_NATIVO, { ...OPCIONES, confirmacionDeRelevos: incompleta }, SYSTEM_ACTOR, "x.hyv")
        ).rejects.toThrow(/Faltan decisiones para 1 relevo/);

        expect(await conteos()).toEqual(antes);
      });

      it("una lista de decisiones VACÍA no equivale a confirmar", async () => {
        const completa = await confirmarTodo(HYV_NATIVO, "sample-hyv-nativo.hyv");
        const antes = await conteos();

        await expect(
          importCompetitionFromMeetEventsZip(
            HYV_NATIVO,
            { ...OPCIONES, confirmacionDeRelevos: { fileHash: completa.fileHash, decisiones: [] } },
            SYSTEM_ACTOR,
            "x.hyv"
          )
        ).rejects.toThrow(/Faltan decisiones para 4 relevo/);

        expect(await conteos()).toEqual(antes);
      });

      // ---- rechazo temporal sin confirmación ------------------------------

      it("un .hyv con relevos y SIN confirmación se rechaza, en vez de elegir el tipo solo", async () => {
        const antes = await conteos();

        await expect(
          importCompetitionFromMeetEventsZip(HYV_NATIVO, OPCIONES, SYSTEM_ACTOR, "sample-hyv-nativo.hyv")
        ).rejects.toThrow(AVISO_RELEVOS_SIN_CONFIRMAR_HYV);

        expect(await conteos()).toEqual(antes);
      });

      /**
       * LA MISMA EXIGENCIA PARA EL `.ev3`, como medida temporal.
       *
       * Antes, un `.ev3` con relevos se importaba tomando el primer tipo de
       * relevo del catálogo y avisando. Eso es elegir sobre un dato que no se
       * ha leído: el `.ev3` SÍ trae el número de postas en su campo [29], pero
       * el importador todavía no lo lee. Hasta que esa lectura exista y esté
       * probada, se exige confirmación también aquí.
       *
       * El mensaje es distinto del `.hyv` a propósito: decir que "el archivo
       * no lo indica" sería falso para el `.ev3` y mandaría a buscar el
       * problema donde no está.
       */
      it("un .ev3 con relevos y SIN confirmación también se rechaza, con SU motivo", async () => {
        const antes = await conteos();

        await expect(
          importCompetitionFromMeetEventsZip(Buffer.from(SAMPLE_EV3, "latin1"), OPCIONES, SYSTEM_ACTOR, "sample.ev3")
        ).rejects.toThrow(AVISO_RELEVOS_SIN_CONFIRMAR_EV3);

        expect(await conteos()).toEqual(antes);
      });

      it("el motivo del .ev3 NO afirma que el archivo no traiga el dato", async () => {
        // El `.ev3` lo trae en [29]; lo que falta es leerlo. La redacción
        // tiene que distinguir "no está" de "no lo leemos todavía".
        expect(AVISO_RELEVOS_SIN_CONFIRMAR_EV3).toMatch(/sí trae el número de postas/i);
        expect(AVISO_RELEVOS_SIN_CONFIRMAR_EV3).toMatch(/todavía no lo lee/i);
        expect(AVISO_RELEVOS_SIN_CONFIRMAR_HYV).toMatch(/no indica en cuántas postas/i);
      });

      it("un .zip con relevos tampoco se importa sin confirmar", async () => {
        const antes = await conteos();

        await expect(
          importCompetitionFromMeetEventsZip(zipConEv3(SAMPLE_EV3), OPCIONES, SYSTEM_ACTOR, "meet.zip")
        ).rejects.toThrow(AVISO_RELEVOS_SIN_CONFIRMAR_EV3);

        expect(await conteos()).toEqual(antes);
      });

      it("un .ev3 con relevos SÍ se importa cuando se confirman", async () => {
        const ev3 = Buffer.from(SAMPLE_EV3, "latin1");
        const resumen = await importCompetitionFromMeetEventsZip(
          ev3,
          { ...OPCIONES, confirmacionDeRelevos: await confirmarTodo(ev3, "sample.ev3") },
          SYSTEM_ACTOR,
          "sample.ev3"
        );

        expect(resumen.eventsImported).toBe(14);
        expect(resumen.eventsSkipped).toBe(0);
        // Y sin ningún aviso de "se eligió por ti": ya no queda esa rama.
        expect(resumen.warnings.join(" ")).not.toMatch(/primer tipo del catálogo/i);
      });

      it("un .ev3 SIN relevos se sigue importando sin confirmar nada", async () => {
        // La medida no es un peaje general: solo alcanza a los relevos.
        const resumen = await importCompetitionFromMeetEventsZip(
          zipConEv3(ev3Con({ inicio: "03/28/2026", fin: "03/28/2026", lineas: [LINEA_INDIVIDUAL] })),
          OPCIONES,
          SYSTEM_ACTOR
        );
        expect(resumen.eventsImported).toBe(1);
      });

      it("un .hyv SIN relevos se importa sin necesidad de confirmar nada", async () => {
        // La confirmación se exige donde hace falta, no como peaje general.
        const sinRelevos = Buffer.from(
          HYV_NATIVO.toString("latin1")
            .split("\r\n")
            .filter((l) => l.split(";")[3] !== "R")
            .join("\r\n"),
          "latin1"
        );

        const analisis = await analizarArchivoDeImportacion(sinRelevos, SYSTEM_ACTOR, "sin-relevos.hyv");
        expect(analisis.relevos).toHaveLength(0);
        expect(analisis.requiereConfirmacionDeRelevos).toBe(false);

        const resumen = await importCompetitionFromMeetEventsZip(sinRelevos, OPCIONES, SYSTEM_ACTOR, "sin-relevos.hyv");
        expect(resumen.eventsImported).toBe(10);
      });

      // ---- omitir --------------------------------------------------------

      it("un relevo omitido NO se importa y se cuenta claramente como omitido", async () => {
        const confirmacion = await confirmarTodo(HYV_NATIVO, "sample-hyv-nativo.hyv");
        const conOmision = {
          ...confirmacion,
          decisiones: confirmacion.decisiones.map((d) =>
            d.eventNumber === 11 ? ({ eventNumber: 11, decision: "omitir" } as const) : d
          ),
        };

        const resumen = await importCompetitionFromMeetEventsZip(
          HYV_NATIVO,
          { ...OPCIONES, confirmacionDeRelevos: conOmision },
          SYSTEM_ACTOR,
          "x.hyv"
        );

        expect(resumen.eventsImported).toBe(13);
        expect(resumen.eventsSkipped).toBe(1);
        // Visible en los tres lugares: el aviso destacado, el detalle, y la base.
        expect(resumen.warnings[0]).toMatch(/IMPORTACIÓN PARCIAL: 13 de 14/);
        expect(resumen.warnings.some((w) => w.startsWith("Prueba #11") && /no se confirmó en cuántas postas/.test(w))).toBe(true);

        const relevos = await prisma.competitionEvent.findMany({
          where: { competitionId: resumen.competitionId, event: { testType: { swimmersCount: { gt: 1 } } } },
        });
        expect(relevos).toHaveLength(3);

        const registro = await prisma.auditLog.findFirstOrThrow({
          where: { action: "COMPETITION_IMPORTED_FROM_MEET_EVENTS", entityId: resumen.competitionId },
        });
        const after = registro.after as Record<string, unknown>;
        expect(after.relevosConfirmados).toBe(true);
        expect(after.relevosOmitidos).toEqual([11]);
        expect(String(after.skippedDetail)).toMatch(/Prueba #11/);
      });

      it("si se omiten TODOS los relevos, las individuales se importan igual", async () => {
        const confirmacion = await confirmarTodo(HYV_NATIVO, "sample-hyv-nativo.hyv");
        const todasOmitidas = {
          ...confirmacion,
          decisiones: confirmacion.decisiones.map((d) => ({ eventNumber: d.eventNumber, decision: "omitir" as const })),
        };

        const resumen = await importCompetitionFromMeetEventsZip(
          HYV_NATIVO,
          { ...OPCIONES, confirmacionDeRelevos: todasOmitidas },
          SYSTEM_ACTOR,
          "x.hyv"
        );

        expect(resumen.eventsImported).toBe(10);
        expect(resumen.eventsSkipped).toBe(4);
      });

      it("si el archivo es SOLO relevos y se omiten todos, no se crea la competencia", async () => {
        // Sin ninguna prueba importada la competencia sería un cascarón: la
        // guarda existente revierte la transacción entera.
        const soloRelevos = Buffer.from(
          HYV_NATIVO.toString("latin1")
            .split("\r\n")
            .filter((l, i) => i === 0 || l.split(";")[3] === "R")
            .join("\r\n"),
          "latin1"
        );
        const analisis = await analizarArchivoDeImportacion(soloRelevos, SYSTEM_ACTOR, "solo-relevos.hyv");
        const antes = await conteos();

        await expect(
          importCompetitionFromMeetEventsZip(
            soloRelevos,
            {
              ...OPCIONES,
              confirmacionDeRelevos: {
                fileHash: analisis.fileHash,
                decisiones: analisis.relevos.map((r) => ({ eventNumber: r.eventNumber, decision: "omitir" as const })),
              },
            },
            SYSTEM_ACTOR,
            "solo-relevos.hyv"
          )
        ).rejects.toThrow(/no se pudo importar ninguna/i);

        expect(await conteos()).toEqual(antes);
      });
    });
  });

  it("con una competencia de UN solo día no aparece el aviso de días", async () => {
    const resumen = await importCompetitionFromMeetEventsZip(
      zipConEv3(ev3Con({ inicio: "03/28/2026", fin: "03/28/2026", lineas: [LINEA_INDIVIDUAL] })),
      { maxIndividualEventsPerSwimmer: 5 },
      SYSTEM_ACTOR
    );
    expect(resumen.warnings).not.toContain(AVISO_DIA_EV3);
    expect(resumen.warnings).not.toContain(AVISO_DIA_HYV);
  });

  it("RECHAZA un rango de fechas invertido SIN crear nada", async () => {
    const zip = zipConEv3(ev3Con({ inicio: "03/30/2026", fin: "03/28/2026", lineas: [LINEA_INDIVIDUAL] }));

    await expect(importCompetitionFromMeetEventsZip(zip, { maxIndividualEventsPerSwimmer: 5 }, SYSTEM_ACTOR)).rejects.toThrow(
      /anterior a la de inicio/i
    );
    expect(await prisma.competition.count()).toBe(0);
  });

  it("cuando NINGUNA prueba se importa, la transacción revierte todo y el error no habla de limpieza", async () => {
    /**
     * La rama `eventsImported === 0` solo se alcanza si el archivo parsea
     * bien pero la asignación de cada prueba falla. Con datos reales eso no
     * se puede provocar (el parser ya descarta lo inválido antes), así que
     * se fuerza el fallo de `addCompetitionEvent` — todo lo demás (la
     * competencia, sus fechas y la reversión) ocurre de verdad contra la base.
     */
    const spy = vi
      .spyOn(competitionEventsService, "addCompetitionEvent")
      .mockRejectedValue(new ValidationError("fallo simulado al asignar la prueba"));

    try {
      const zip = zipConEv3(ev3Con({ inicio: "03/28/2026", fin: "03/28/2026", lineas: [LINEA_INDIVIDUAL] }));
      const error = await importCompetitionFromMeetEventsZip(zip, { maxIndividualEventsPerSwimmer: 5 }, SYSTEM_ACTOR)
        .then(() => null)
        .catch((e) => e as ValidationError);

      expect(error).toBeInstanceOf(ValidationError);
      expect(error!.message).toMatch(/no se pudo importar ninguna/i);
      expect(error!.message).toContain("fallo simulado");

      // Hallazgo 18: ya no hay limpieza compensatoria, así que tampoco puede
      // haber un aviso de "no se pudo eliminar la competencia creada a
      // medias" — la reversión la hace la base de datos.
      expect(error!.message).not.toContain("ATENCIÓN");
      expect(error!.message).not.toMatch(/no se pudo eliminar la competencia/i);
      expect(error!.details).not.toHaveProperty("cleanupOk");

      expect(await prisma.competition.count()).toBe(0);
      expect(await prisma.competitionDate.count()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("si falla DESPUÉS de crear la competencia, la transacción revierte todo y el mensaje original se conserva", async () => {
    // Se borran los tipos de prueba: la validación del catálogo ocurre
    // después de crear la competencia y sus fechas, así que este caso
    // ejercita la reversión sobre escrituras ya hechas dentro de la
    // transacción.
    await prisma.testType.deleteMany();

    const error = await importCompetitionFromMeetEventsZip(
      zipConEv3(ev3Con({ inicio: "03/28/2026", fin: "03/28/2026", lineas: [LINEA_INDIVIDUAL] })),
      { maxIndividualEventsPerSwimmer: 5 },
      SYSTEM_ACTOR
    )
      .then(() => null)
      .catch((e) => e as ValidationError);

    // El error de dominio conserva su mensaje: explica el problema real.
    // El archivo de esta prueba trae solo una individual, así que lo que falta
    // y se nombra es el tipo Individual; la falta de tipos de relevo tiene su
    // propio mensaje, y solo aparece cuando el archivo trae relevos.
    expect(error!.message).toMatch(/no tiene configurado el tipo de prueba Individual/i);
    expect(error!.message).not.toContain("ATENCIÓN");

    expect(await prisma.competition.count(), "la transacción debe haber revertido la competencia").toBe(0);
    expect(await prisma.competitionDate.count()).toBe(0);
    expect(await prisma.competitionSession.count()).toBe(0);
  });

  /**
   * Hallazgo 18 — lo que la limpieza compensatoria NO cubría.
   *
   * `cleanupPartialImport` borraba la competencia y confiaba en la cascada,
   * así que el catálogo creado al vuelo durante una importación fallida
   * (distancias, estilos, tipos de jornada, pruebas maestras) quedaba escrito
   * para siempre: eran filas compartidas que la cascada no toca. Con la
   * transacción, un fallo revierte también esas filas.
   */
  it("una importación fallida no deja catálogo creado a medias", async () => {
    const distanciasAntes = await prisma.distance.count();
    const pruebasMaestrasAntes = await prisma.event.count();

    const spy = vi
      .spyOn(competitionEventsService, "addCompetitionEvent")
      .mockRejectedValue(new ValidationError("fallo simulado al asignar la prueba"));

    try {
      // Distancia que NO existe en el catálogo base (777 m): la importación
      // la crea, junto con la prueba maestra correspondiente, antes de
      // fallar al asignarla a la competencia.
      const linea = "9;1;F;1;I;W;0;109;777;A;0;;;N;0;;;;;;;1;1;1;09:45AM;S;4;3;1;0*>";
      await importCompetitionFromMeetEventsZip(
        zipConEv3(ev3Con({ inicio: "03/28/2026", fin: "03/28/2026", lineas: [linea] })),
        { maxIndividualEventsPerSwimmer: 5 },
        SYSTEM_ACTOR
      ).catch(() => null);
    } finally {
      spy.mockRestore();
    }

    expect(await prisma.distance.count(), "la distancia creada al vuelo debe revertirse").toBe(distanciasAntes);
    expect(await prisma.event.count(), "la prueba maestra creada al vuelo debe revertirse").toBe(pruebasMaestrasAntes);
    expect(await prisma.competition.count()).toBe(0);
  });

  /**
   * La tolerancia a fallos parciales tiene que sobrevivir a la transacción:
   * en PostgreSQL, una sentencia fallida aborta la transacción entera, así
   * que sin savepoints la primera prueba con problemas habría arrastrado a
   * todas las siguientes.
   */
  it("una prueba que falla se salta y las demás se importan igual (savepoint por prueba)", async () => {
    const spy = vi.spyOn(competitionEventsService, "addCompetitionEvent");
    // Falla solo la PRIMERA prueba; la segunda debe entrar normalmente.
    spy.mockRejectedValueOnce(new ValidationError("fallo simulado en la primera prueba"));

    try {
      const segundaLinea = "2;1;F;1;I;M;0;109;100;A;0;;;N;0;;;;;;;1;1;1;09:45AM;S;4;3;1;0*>";
      const resumen = await importCompetitionFromMeetEventsZip(
        zipConEv3(ev3Con({ inicio: "03/28/2026", fin: "03/28/2026", lineas: [LINEA_INDIVIDUAL, segundaLinea] })),
        { maxIndividualEventsPerSwimmer: 5 },
        SYSTEM_ACTOR
      );

      expect(resumen.eventsImported).toBe(1);
      expect(resumen.eventsSkipped).toBe(1);
      expect(resumen.warnings[0]).toMatch(/IMPORTACIÓN PARCIAL/);

      // La competencia se confirmó con la prueba que sí entró: el savepoint
      // revirtió únicamente el intento fallido.
      expect(await prisma.competition.count()).toBe(1);
      expect(await prisma.competitionEvent.count()).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("RECHAZA un ZIP sin archivo .ev3", async () => {
    const zip = new AdmZip();
    zip.addFile("otro.txt", Buffer.from("x"));
    await expect(importCompetitionFromMeetEventsZip(zip.toBuffer(), { maxIndividualEventsPerSwimmer: 5 }, SYSTEM_ACTOR)).rejects.toThrow(
      /no contiene ningún archivo \.ev3/i
    );
  });

  it("los relevos del fixture conservan su distancia TOTAL en la base", async () => {
    const zip = zipConEv3(SAMPLE_EV3);
    const resumen = await importCompetitionFromMeetEventsZip(
      zip,
      { maxIndividualEventsPerSwimmer: 5, confirmacionDeRelevos: await confirmarTodo(zip, "meet.zip") },
      SYSTEM_ACTOR
    );
    expect(resumen.eventsImported).toBeGreaterThan(0);

    const pruebasRelevo = await prisma.competitionEvent.findMany({
      where: { competitionId: resumen.competitionId, event: { testType: { swimmersCount: { gt: 1 } } } },
      include: { event: { include: { distance: true } } },
    });

    expect(pruebasRelevo.length).toBeGreaterThan(0);
    for (const ce of pruebasRelevo) {
      expect(ce.event.distance.meters, "un 4×50 se guarda como 200, no como 50").toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// Escenario con inscripciones, para reportes y exportación
// ---------------------------------------------------------------------------

async function montarCompetenciaConInscripciones(opciones: {
  conPiscina: boolean;
  nombreClub?: string;
  /** Días (AAAA-MM-DD) de la competencia, en el orden en que se programan. Por omisión, hoy. */
  fechas?: string[];
  /** Ventana de inscripción (AAAA-MM-DD). Por omisión, ayer–mañana. */
  inscripcion?: { inicio: string; fin: string };
}) {
  const testType = await prisma.testType.upsert({ where: { name: "Individual" }, update: {}, create: { name: "Individual", swimmersCount: 1 } });
  const relayType = await prisma.testType.upsert({ where: { name: "Relevo" }, update: {}, create: { name: "Relevo", swimmersCount: 4 } });
  const distancia = await prisma.distance.upsert({ where: { meters: 50 }, update: {}, create: { meters: 50 } });
  const distanciaRelevo = await prisma.distance.upsert({ where: { meters: 200 }, update: {}, create: { meters: 200 } });
  const estilo = await prisma.stroke.upsert({ where: { name: "Libre" }, update: {}, create: { name: "Libre" } });
  const tipoJornada = await prisma.sessionType.upsert({ where: { name: "Mañana" }, update: {}, create: { name: "Mañana" } });

  const club = await createClub(opciones.nombreClub ?? "Club Exportador", "CLBE", "club_exportador");
  const clubUser = await createUser({ username: "club_exportador", roleNames: ["club"], clubId: club.id });

  const nadadores: Array<{ id: string }> = [];
  for (let i = 1; i <= 4; i++) {
    const p = await createPerson({
      run: `8000000${i}`,
      username: `exporta_${i}`,
      firstName: `Nadador${i}`,
      gender: i % 2 === 0 ? "male" : "female",
      birthYear: 1990,
    });
    await addActiveMembership(club.id, p.id, clubUser.id);
    nadadores.push(p);
  }

  const categoria = await catalogsCategories.createCategory({ testTypeId: testType.id, name: "Master Export", minAge: 20, maxAge: 60 }, SYSTEM_ACTOR);
  const categoriaRelevo = await catalogsCategories.createCategory(
    { testTypeId: relayType.id, name: "Relevo Export", minAge: 0, maxAge: 500 },
    SYSTEM_ACTOR
  );

  const piscina = opciones.conPiscina
    ? await prisma.pool.create({ data: { name: "Piscina Municipal", courseLength: "short_25m" } })
    : null;

  const ahora = new Date();
  const competencia = await competitionsService.createCompetition(
    {
      name: "Copa Exportación",
      registrationStartAt: opciones.inscripcion ? new Date(`${opciones.inscripcion.inicio}T00:00:00.000Z`) : new Date(ahora.getTime() - 86_400_000),
      registrationEndAt: opciones.inscripcion ? new Date(`${opciones.inscripcion.fin}T00:00:00.000Z`) : new Date(ahora.getTime() + 86_400_000),
      ageCutoffDate: new Date(ahora.getFullYear(), 11, 31),
      maxIndividualEventsPerSwimmer: 10,
      maxRelayEventsPerSwimmerPerSession: 1,
      poolId: piscina?.id,
    },
    SYSTEM_ACTOR
  );
  await competitionsService.transitionCompetition(competencia.id, "schedule", SYSTEM_ACTOR);

  const dias = opciones.fechas?.map((d) => new Date(`${d}T00:00:00.000Z`)) ?? [new Date()];
  const fecha = await structureService.addCompetitionDate(competencia.id, dias[0]!, SYSTEM_ACTOR);
  const jornada = await structureService.addSession(fecha.id, tipoJornada.id, SYSTEM_ACTOR);
  // Los demás días se programan sin jornadas; el orden de alta es el que se pida.
  for (const dia of dias.slice(1)) await structureService.addCompetitionDate(competencia.id, dia, SYSTEM_ACTOR);

  const eventoIndividual = await catalogsEvents.createEvent(
    { testTypeId: testType.id, distanceId: distancia.id, strokeId: estilo.id, gender: "mixed" },
    SYSTEM_ACTOR
  );
  const ceIndividual = await competitionEventsService.addCompetitionEvent(
    competencia.id,
    { eventId: eventoIndividual.id, competitionSessionId: jornada.id, categoryIds: [categoria.id], displayOrder: 1 },
    SYSTEM_ACTOR
  );

  const eventoRelevo = await catalogsEvents.createEvent(
    { testTypeId: relayType.id, distanceId: distanciaRelevo.id, strokeId: estilo.id, gender: "mixed" },
    SYSTEM_ACTOR
  );
  const ceRelevo = await competitionEventsService.addCompetitionEvent(
    competencia.id,
    { eventId: eventoRelevo.id, competitionSessionId: jornada.id, categoryIds: [categoriaRelevo.id], displayOrder: 2 },
    SYSTEM_ACTOR
  );

  /**
   * LOS CUATRO se inscriben individualmente, no solo el primero.
   *
   * Antes solo se inscribía a `nadadores[0]`, porque un relevo se podía formar
   * con cualquiera. Desde que un integrante necesita una inscripción
   * individual confirmada en la misma competencia, ese montaje ya no
   * representa un escenario posible: la API lo rechaza, y con razón.
   *
   * Los tiempos distintos por nadador mantienen lo que estas pruebas miran de
   * verdad —el contenido del reporte y del .HY3—, que necesita datos que no
   * sean todos iguales.
   */
  for (const [i, n] of nadadores.entries()) {
    await registrationsService.createRegistration(
      { competitionEventId: ceIndividual.id, clubId: club.id, personId: n.id, seedTimeCentiseconds: 3012 + i },
      ADMIN_ACTOR
    );
  }
  const relevo = await relayService.createRelayRegistration(
    { competitionEventId: ceRelevo.id, clubId: club.id, personIds: nadadores.map((n) => n.id) },
    ADMIN_ACTOR
  );

  /**
   * Agrega OTRO equipo de relevo del mismo club, en una prueba de relevo
   * distinta (otro estilo, para no chocar con el índice único de equipo por
   * club+prueba+categoría). Sirve para armar escenarios donde los relevos
   * exceden el presupuesto restante sin tocar las individuales.
   */
  async function agregarSegundoRelevo() {
    const otroEstilo = await prisma.stroke.upsert({ where: { name: "Espalda" }, update: {}, create: { name: "Espalda" } });
    const otroEventoRelevo = await catalogsEvents.createEvent(
      { testTypeId: relayType.id, distanceId: distanciaRelevo.id, strokeId: otroEstilo.id, gender: "mixed" },
      SYSTEM_ACTOR
    );
    const otroCeRelevo = await competitionEventsService.addCompetitionEvent(
      competencia.id,
      { eventId: otroEventoRelevo.id, competitionSessionId: jornada.id, categoryIds: [categoriaRelevo.id], displayOrder: 3 },
      SYSTEM_ACTOR
    );
    // La competencia admite 1 relevo por nadador y jornada; para el segundo
    // equipo se amplía ese tope, que es un parámetro de negocio legítimo.
    await prisma.competition.update({ where: { id: competencia.id }, data: { maxRelayEventsPerSwimmerPerSession: 2 } });
    return relayService.createRelayRegistration(
      { competitionEventId: otroCeRelevo.id, clubId: club.id, personIds: nadadores.map((n) => n.id) },
      ADMIN_ACTOR
    );
  }

  return { competencia, club, ceIndividual, ceRelevo, relevo, nadadores, categoria, agregarSegundoRelevo };
}

// ---------------------------------------------------------------------------
// getRegistrationsReport (+ CSV / XLSX)
// ---------------------------------------------------------------------------

describe("getRegistrationsReport (invocación real)", () => {
  it("devuelve individuales y relevos con sus columnas", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({ conPiscina: true });

    const reporte = await reportsService.getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR);

    expect(reporte.competitionName).toBe("Copa Exportación");
    // Cuatro individuales: desde que un integrante de relevo necesita una
    // inscripción individual confirmada, el montaje inscribe a los cuatro.
    expect(reporte.individualRows).toHaveLength(4);
    expect(reporte.relayRows).toHaveLength(1);
    expect(reporte.individualRows[0]!.club).toBe(club.name);
    expect(reporte.relayRows[0]!.integrante1).toContain("Nadador1");
  });

  it("el CSV generado neutraliza un nombre de club malicioso", async () => {
    const { competencia } = await montarCompetenciaConInscripciones({ conPiscina: true, nombreClub: "=cmd|'/c calc'!A1" });

    const reporte = await reportsService.getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR);
    const csv = reportsService.buildCsv(reporte.individualRows, reporte.relayRows);

    expect(csv).toContain("cmd|'/c calc'!A1");
    // Ninguna celda del CSV puede empezar con un carácter de fórmula.
    for (const linea of csv.split("\r\n")) {
      for (const celda of linea.split(",")) {
        const contenido = celda.replace(/^"/, "");
        expect(["=", "+", "@"].some((c) => contenido.startsWith(c)), `celda peligrosa: ${celda}`).toBe(false);
      }
    }
  });

  it("el XLSX se genera y es un archivo válido", async () => {
    const { competencia } = await montarCompetenciaConInscripciones({ conPiscina: true });
    const reporte = await reportsService.getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR);

    const buffer = await reportsService.buildXlsx(reporte.individualRows, reporte.relayRows);
    // Un .xlsx es un ZIP: debe empezar con la firma PK.
    expect(buffer.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(buffer.length).toBeGreaterThan(1000);
  });

  /**
   * El escenario tiene 1 inscripción individual y 1 equipo de relevo.
   *
   * Con el tope en 1, un contador que solo mirara las individuales daría 1 y
   * dejaría pasar el reporte. Contando ambas da 2 y debe rechazarlo: eso es
   * exactamente lo que distingue el comportamiento corregido del anterior.
   */
  it("el tope de filas cuenta TAMBIÉN los relevos, no solo las individuales", async () => {
    const { competencia } = await montarCompetenciaConInscripciones({ conPiscina: true });

    const error = await reportsService
      .getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR, { maxRows: 1 })
      .then(() => null)
      .catch((e) => e as ValidationError);

    expect(error, "con 4 individuales + 1 relevo y tope 1, el reporte debe rechazarse").toBeInstanceOf(ValidationError);
    // Lo que esta prueba protege sigue igual: el tope cuenta las DOS clases.
    // Con solo las individuales el mensaje diría 4, no 5.
    expect(error!.message).toContain("5 inscripciones");
    expect(error!.message).toContain("4 individuales");
    expect(error!.message).toContain("1 de relevo");
    expect(error!.message).toMatch(/acote el reporte/i);
  });

  /**
   * CAMINO POSTERIOR AL CONTEO.
   *
   * Las pruebas anteriores insertaban filas antes de llamar al servicio, así
   * que el `count` previo ya rechazaba y los `findMany` nunca se ejecutaban:
   * no probaban ni el `take` ni la verificación posterior.
   *
   * Aquí se fuerzan los `count` a devolver valores OBSOLETOS (0), que es
   * exactamente lo que pasa cuando otro club inscribe entre contar y leer.
   * Los `findMany` quedan intactos y leen los datos reales; los spies
   * verifican que se llamaron con el `take` correcto y que la comprobación
   * posterior a la lectura es la que rechaza.
   */
  it("con el conteo obsoleto, la lectura acotada y la verificación posterior atajan el exceso (reportes)", async () => {
    const { competencia } = await montarCompetenciaConInscripciones({ conPiscina: true });
    // Datos reales: 4 individuales + 1 relevo = 5 filas. El montaje ya inscribe
    // a los cuatro —lo exige la invariante de relevos—, así que el bucle que
    // añadía los tres restantes sobra y ahora fallaría por duplicado.

    const conteos = conConteosObsoletos(0);

    try {
      const error = await reportsService
        .getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR, { maxRows: 2 })
        .then(() => null)
        .catch((e) => e as ValidationError);

      // El conteo previo dijo 0 y dejó pasar: el rechazo vino DESPUÉS de leer.
      expect(error, "la verificación posterior a la lectura debe rechazar").toBeInstanceOf(ValidationError);

      // Se ejecutó la lectura acotada de individuales con el presupuesto completo.
      const lecturasIndividuales = conteos.lecturasDe("Registration");
      expect(lecturasIndividuales.length).toBeGreaterThan(0);
      expect(lecturasIndividuales[0]!.args.take).toBe(3); // MAX(2) + 1

      // Las 4 individuales ya agotaron el presupuesto de 2, así que el corte
      // ocurre ANTES de leer relevos: ni siquiera se consulta.
      expect(conteos.lecturasDe("RelayRegistration"), "no debe leer relevos si las individuales ya excedieron").toHaveLength(0);
      expect(error!.details).toMatchObject({ maxRows: 2, truncated: true });
    } finally {
      conteos.restore();
    }
  });

  it("el presupuesto de relevos es el REMANENTE, no otro MAX+1", async () => {
    const { competencia } = await montarCompetenciaConInscripciones({ conPiscina: true });
    // Datos reales: 4 individuales + 1 relevo.

    const conteos = conConteosObsoletos(0);

    try {
      // Tope 5: las individuales consumen 4, así que a los relevos les debe
      // quedar un presupuesto de 1 y pedirse `take: 2` (remanente + 1).
      // Con un tope por consulta se habría pedido 6 (MAX + 1).
      await reportsService.getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR, { maxRows: 5 });

      const lecturasRelevo = conteos.lecturasDe("RelayRegistration");
      expect(lecturasRelevo.length).toBeGreaterThan(0);
      expect(lecturasRelevo[0]!.args.take).toBe(2);
      expect(lecturasRelevo[0]!.args.take, "un tope por consulta habría pedido MAX+1 = 6").not.toBe(6);
    } finally {
      conteos.restore();
    }
  });

  /**
   * El caso que aísla la rama `relayRegs.length > presupuestoRestante`.
   *
   * Las individuales caben dentro del tope, así que el corte temprano no se
   * activa; son los RELEVOS los que agotan el remanente. Sin el presupuesto
   * combinado, este escenario habría pasado: cada consulta habría tenido su
   * propio `MAX + 1` y ninguna, por separado, habría excedido.
   */
  it("rechaza cuando los relevos exceden el presupuesto RESTANTE, con las individuales dentro del límite", async () => {
    const { competencia, agregarSegundoRelevo } = await montarCompetenciaConInscripciones({ conPiscina: true });
    await agregarSegundoRelevo();
    // Datos reales: 4 individuales + 2 relevos = 6 filas.

    const conteos = conConteosObsoletos(0);
    try {
      // Tope 5: las individuales (4) caben; queda 1 de presupuesto y hay 2
      // relevos, así que el exceso lo aporta exclusivamente la sección de
      // relevos.
      const error = await reportsService
        .getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR, { maxRows: 5 })
        .then(() => null)
        .catch((e) => e as ValidationError);

      expect(error, "el exceso lo aportan los relevos, no las individuales").toBeInstanceOf(ValidationError);

      // Las individuales NO dispararon el corte temprano: se leyeron y se
      // siguió adelante hasta consultar los relevos.
      const lecturasIndividuales = conteos.lecturasDe("Registration");
      const lecturasRelevo = conteos.lecturasDe("RelayRegistration");
      expect(lecturasIndividuales[0]!.args.take).toBe(6); // MAX(5) + 1
      expect(lecturasRelevo.length, "debe haberse consultado la sección de relevos").toBeGreaterThan(0);
      expect(lecturasRelevo[0]!.args.take, "presupuesto restante (5 - 4) + 1").toBe(2);

      // El rechazo procede de la comparación con el remanente, así que la
      // lectura vino truncada.
      expect(error!.details).toMatchObject({ individualRows: 4, relayRows: 2, totalRows: 6, truncated: true });
      expect(error!.message).toContain("al menos");
    } finally {
      conteos.restore();
    }
  });

  it("el mensaje dice 'al menos' cuando la lectura vino truncada", async () => {
    // El montaje ya inscribe individualmente a los cuatro: lo exige la
    // invariante de relevos, y volver a inscribirlos fallaría por duplicado.
    const { competencia } = await montarCompetenciaConInscripciones({ conPiscina: true });

    const conteos = conConteosObsoletos(0);

    try {
      const error = await reportsService
        .getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR, { maxRows: 1 })
        .then(() => null)
        .catch((e) => e as ValidationError);

      expect(error!.message).toContain("al menos");
      expect(error!.details).toMatchObject({ truncated: true });
      // No puede presentar el número leído como si fuera el total exacto.
      expect(error!.message).not.toMatch(/tiene \d+ inscripciones/);
    } finally {
      conteos.restore();
    }
  });

  it("con el conteo obsoleto pero dentro del tope, el reporte se genera con los datos reales", async () => {
    const { competencia } = await montarCompetenciaConInscripciones({ conPiscina: true });

    const conteos = conConteosObsoletos(0);

    try {
      const reporte = await reportsService.getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR, { maxRows: 50 });
      // Los datos vienen del findMany real, no del count falseado.
      expect(reporte.individualRows).toHaveLength(4);
      expect(reporte.relayRows).toHaveLength(1);
    } finally {
      conteos.restore();
    }
  });

  it("con el tope holgado, el mismo reporte se genera sin problema", async () => {
    const { competencia } = await montarCompetenciaConInscripciones({ conPiscina: true });
    const reporte = await reportsService.getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR, { maxRows: 100 });
    expect(reporte.individualRows.length + reporte.relayRows.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// buildTeamManagerExport
// ---------------------------------------------------------------------------

/** El HY3 del paquete: la mayoría de estas pruebas miran su contenido. */
async function exportarHy3(...args: Parameters<typeof buildTeamManagerExport>) {
  const { hy3 } = await buildTeamManagerExport(...args);
  return hy3;
}

/** Abre el ZIP de una respuesta y devuelve sus archivos, con los bytes tal cual. */
function abrirZip(zip: Buffer) {
  const entradas = new AdmZip(zip).getEntries();
  const de = (ext: string) => entradas.find((e) => e.entryName.endsWith(ext))?.getData();
  return { nombres: entradas.map((e) => e.entryName).sort(), hy3: de(".HY3")!, cl2: de(".CL2")! };
}

/** Sin el encabezado, que lleva la hora de generación. */
const sinEncabezado = (bytes: Buffer) => bytes.toString("latin1").split("\r\n").slice(1).join("\r\n");

describe("buildTeamManagerExport (invocación real)", () => {
  it("genera el archivo con la piscina configurada y la distancia TOTAL del relevo", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({ conPiscina: true });

    const { filename, content } = await exportarHy3(competencia.id, club.id, ADMIN_ACTOR);

    expect(filename).toMatch(/\.hy3$/i);
    const lineas = content.split(/\r?\n/);

    const f1 = lineas.find((l) => l.startsWith("F1"));
    expect(f1, "debe haber un registro F1 del equipo de relevo").toBeTruthy();
    // Columnas 18-21 del F1: distancia total. 200 = 4×50, no 800.
    expect(Number(f1!.slice(18, 21).trim())).toBe(200);

    const e1 = lineas.find((l) => l.startsWith("E1"));
    expect(Number(e1!.slice(15, 21).trim())).toBe(50);

    // Piscina corta configurada ⇒ curso "S", no la "L" que antes se asumía.
    const b2 = lineas.find((l) => l.startsWith("B2"));
    expect(b2).toContain("S");
  });

  it("RECHAZA exportar si la competencia no tiene piscina asignada", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({ conPiscina: false });

    await expect(exportarHy3(competencia.id, club.id, ADMIN_ACTOR)).rejects.toThrow(/no tiene piscina asignada/i);
  });

  it("RECHAZA generar el archivo si hay un relevo con datos inconsistentes, en vez de omitirlo", async () => {
    const { competencia, club, relevo } = await montarCompetenciaConInscripciones({ conPiscina: true });

    // Se deja el equipo con 3 integrantes, simulando un dato corrupto.
    const miembros = await prisma.relayRegistrationMember.findMany({ where: { relayRegistrationId: relevo.id } });
    await prisma.relayRegistrationMember.delete({ where: { id: miembros[0]!.id } });

    const error: ValidationError = await exportarHy3(competencia.id, club.id, ADMIN_ACTOR).then(
      () => {
        throw new Error("se esperaba que la exportación fallara");
      },
      (e: ValidationError) => e
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toMatch(/inconsistentes/i);
    expect(error.message).toContain("3 integrante(s)");
  });

  it("con el conteo obsoleto, la lectura acotada del .HY3 ataja el exceso (camino posterior al conteo)", async () => {
    // El montaje ya inscribe individualmente a los cuatro: lo exige la
    // invariante de relevos, y repetirlo fallaría por duplicado.
    const { competencia, club } = await montarCompetenciaConInscripciones({ conPiscina: true });
    // Datos reales: 4 individuales + 1 relevo.

    const conteos = conConteosObsoletos(0);

    try {
      const error = await exportarHy3(competencia.id, club.id, ADMIN_ACTOR, { maxRows: 2 })
        .then(() => null)
        .catch((e) => e as ValidationError);

      expect(error, "el rechazo debe venir de la verificación posterior a la lectura").toBeInstanceOf(ValidationError);
      const lecturasIndividuales = conteos.lecturasDe("Registration");
      expect(lecturasIndividuales.length).toBeGreaterThan(0);
      expect(lecturasIndividuales[0]!.args.take).toBe(3); // MAX(2) + 1
      expect(error!.message).toContain("al menos");
      expect(error!.details).toMatchObject({ maxRows: 2, truncated: true });
    } finally {
      conteos.restore();
    }
  });

  it("el .HY3 rechaza cuando los relevos exceden el presupuesto RESTANTE", async () => {
    const { competencia, club, agregarSegundoRelevo } = await montarCompetenciaConInscripciones({ conPiscina: true });
    await agregarSegundoRelevo();
    // Datos reales: 4 individuales + 2 relevos.

    const conteos = conConteosObsoletos(0);
    try {
      // Tope 5: las cuatro individuales caben y queda 1 de presupuesto para
      // dos relevos, así que el exceso lo aportan solo ellos.
      const error = await exportarHy3(competencia.id, club.id, ADMIN_ACTOR, { maxRows: 5 })
        .then(() => null)
        .catch((e) => e as ValidationError);

      expect(error).toBeInstanceOf(ValidationError);

      const lecturasIndividuales = conteos.lecturasDe("Registration");
      const lecturasRelevo = conteos.lecturasDe("RelayRegistration");
      expect(lecturasIndividuales[0]!.args.take).toBe(6); // MAX(5) + 1
      expect(lecturasRelevo.length, "las individuales cabían: debe haberse leído relevos").toBeGreaterThan(0);
      expect(lecturasRelevo[0]!.args.take, "presupuesto restante (5 - 4) + 1").toBe(2);

      expect(error!.details).toMatchObject({ individualRows: 4, relayRows: 2, totalRows: 6, truncated: true });
      expect(error!.message).toContain("al menos");
    } finally {
      conteos.restore();
    }
  });

  it("el presupuesto de relevos del .HY3 es el remanente", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({ conPiscina: true });

    const conteos = conConteosObsoletos(0);

    try {
      await exportarHy3(competencia.id, club.id, ADMIN_ACTOR, { maxRows: 5 });
      const lecturasRelevo = conteos.lecturasDe("RelayRegistration");
      expect(lecturasRelevo[0]!.args.take).toBe(2); // remanente (5 - 4) + 1
      expect(lecturasRelevo[0]!.args.take).not.toBe(6);
    } finally {
      conteos.restore();
    }
  });

  it("el tope del archivo .HY3 también cuenta individuales y relevos", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({ conPiscina: true });

    const error = await exportarHy3(competencia.id, club.id, ADMIN_ACTOR, { maxRows: 1 })
      .then(() => null)
      .catch((e) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    // Lo que esta prueba protege sigue igual: el tope cuenta las DOS clases.
    // Mirando solo las individuales, el mensaje diría 4 y no 5.
    expect(error!.message).toContain("5 inscripciones confirmadas");
    expect(error!.message).toContain("4 individuales");
    expect(error!.message).toContain("1 de relevo");
  });

  it("RECHAZA exportar un club sin inscripciones confirmadas", async () => {
    const { competencia } = await montarCompetenciaConInscripciones({ conPiscina: true });
    const otroClub = await createClub("Club Sin Inscritos", "CLBS");

    await expect(exportarHy3(competencia.id, otroClub.id, ADMIN_ACTOR)).rejects.toThrow(/no tiene inscripciones confirmadas/i);
  });

  it("deja registro de auditoría de la exportación", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({ conPiscina: true });
    await exportarHy3(competencia.id, club.id, ADMIN_ACTOR);

    const registros = await prisma.auditLog.findMany({ where: { action: "TEAM_MANAGER_EXPORT_HY3" } });
    expect(registros.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// buildTeamManagerExport — ALCANCE del actor (etapa 2)
// ---------------------------------------------------------------------------

/** Actor de un solo club, tal como lo construiría `buildActorContext`. */
function actorDeClub(userId: string, clubId: string): ActorContext {
  return { userId, isAdmin: false, scope: { kind: "club", clubId }, canRegisterPostClose: false };
}

describe("buildTeamManagerExport — el servicio se protege solo", () => {
  it("el personal de un club exporta SU club y el archivo es idéntico al del administrador", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({ conPiscina: true });

    const delAdmin = await exportarHy3(competencia.id, club.id, ADMIN_ACTOR);
    const delPersonal = await exportarHy3(competencia.id, club.id, actorDeClub(ADMIN_ACTOR.userId, club.id));

    expect(delPersonal.filename).toBe(delAdmin.filename);
    expect(delPersonal.content).toBe(delAdmin.content);
  });

  it("un actor de otro club recibe ForbiddenError y el servicio no lee NADA", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({ conPiscina: true });
    const otroClub = await createClub("Club Ajeno", "CLBX");
    const lecturas = conConteosObsoletos(0);
    try {
      const error = await exportarHy3(competencia.id, club.id, actorDeClub(ADMIN_ACTOR.userId, otroClub.id)).then(
        () => null,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(ForbiddenError);
      // Ni siquiera llegó a consultar inscripciones.
      expect(lecturas.lecturasDe("Registration")).toHaveLength(0);
      expect(lecturas.lecturasDe("RelayRegistration")).toHaveLength(0);
    } finally {
      lecturas.restore();
    }
  });

  it("el rechazo por alcance va ANTES de comprobar si existen la competencia o el club", async () => {
    const { club } = await montarCompetenciaConInscripciones({ conPiscina: true });
    const otroClub = await createClub("Club Ajeno", "CLBX");
    const ajeno = actorDeClub(ADMIN_ACTOR.userId, otroClub.id);

    // Competencia inexistente + club ajeno: 403, no 404 (no se revela qué existe).
    await expect(exportarHy3("no-existe", club.id, ajeno)).rejects.toBeInstanceOf(ForbiddenError);
    // Control: con alcance válido, esa misma competencia sí da 404.
    await expect(exportarHy3("no-existe", club.id, actorDeClub(ADMIN_ACTOR.userId, club.id))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("un nadador puro no puede exportar ningún club, ni siquiera el suyo", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({ conPiscina: true });
    const nadador: ActorContext = { userId: ADMIN_ACTOR.userId, isAdmin: false, scope: { kind: "swimmer", personId: "p" }, canRegisterPostClose: false };
    await expect(exportarHy3(competencia.id, club.id, nadador)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("un rechazo por alcance NO deja registro de auditoría de exportación", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({ conPiscina: true });
    const otroClub = await createClub("Club Ajeno", "CLBX");
    await expect(exportarHy3(competencia.id, club.id, actorDeClub(ADMIN_ACTOR.userId, otroClub.id))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await prisma.auditLog.count({ where: { action: "TEAM_MANAGER_EXPORT_HY3" } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /export/team-manager/hy3 — matriz de permisos por HTTP (etapa 2)
// ---------------------------------------------------------------------------

describe("GET /export/team-manager/hy3 — permisos y alcance por HTTP", () => {
  type App = Awaited<ReturnType<typeof buildServer>>;
  let app: App;

  async function entrar(username: string): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
    if (res.statusCode !== 200) throw new Error(`login de ${username} falló: ${res.statusCode} ${res.body}`);
    return res.json().accessToken;
  }

  const exportar = (token: string, competitionId: string, clubId: string) =>
    app.inject({
      method: "GET",
      url: `/export/team-manager/zip?competitionId=${competitionId}&clubId=${clubId}`,
      headers: { authorization: `Bearer ${token}` },
    });

  /** Monta competencia, dos clubes y una cuenta por cada actor de la matriz. */
  async function montarMatriz() {
    const base = await montarCompetenciaConInscripciones({ conPiscina: true });
    const clubPropio = base.club;
    const clubAjeno = await createClub("Club Ajeno", "CLBX", "club_ajeno");

    const tokens: Record<string, string> = {};

    // Personal del club propio: delegado, entrenador y representante legal.
    for (const [clave, rol, run] of [
      ["delegado", "delegate", "70000001"],
      ["entrenador", "coach", "70000002"],
      ["representante", "legal_representative", "70000003"],
    ] as const) {
      const persona = await createPerson({ run, username: `staff_${clave}`, firstName: clave, gender: "female", roles: [] });
      await addClubStaff(clubPropio.id, persona.id, rol);
      await createUser({ username: `staff_${clave}`, roleNames: [rol], personId: persona.id });
      tokens[clave] = await entrar(`staff_${clave}`);
    }

    // Personal del OTRO club: sirve para comprobar que cada uno ve solo el suyo.
    const delAjeno = await createPerson({ run: "70000004", username: "staff_ajeno", firstName: "Ajeno", gender: "male", roles: [] });
    await addClubStaff(clubAjeno.id, delAjeno.id, "delegate");
    await createUser({ username: "staff_ajeno", roleNames: ["delegate"], personId: delAjeno.id });
    tokens.delegadoAjeno = await entrar("staff_ajeno");

    // Cuenta del propio club (rol `club`): recibe el permiso, acotada a su club.
    tokens.cuentaClub = await entrar("club_exportador");

    // Cuenta del OTRO club (rol `club`): sirve para comprobar que cada cuenta ve solo el suyo.
    await createUser({ username: "club_ajeno", roleNames: ["club"], clubId: clubAjeno.id });
    tokens.cuentaClubAjena = await entrar("club_ajeno");

    // Nadador puro del club propio (rol `swimmer`, sin staff).
    const nada = await createPerson({ run: "70000005", username: "nadador_puro", firstName: "Nadia", gender: "female" });
    await addActiveMembership(clubPropio.id, nada.id, ADMIN_ACTOR.userId);
    await createUser({ username: "nadador_puro", roleNames: ["swimmer"], personId: nada.id });
    tokens.nadadorPuro = await entrar("nadador_puro");

    // Administrador.
    tokens.admin = await entrar("admin_importexport");

    return { ...base, clubPropio, clubAjeno, tokens };
  }

  beforeEach(async () => {
    app = await buildServer();
    await app.ready();
  });
  /**
   * Un servidor por caso, cerrado y ESPERADO después de cada uno —también si el
   * caso falla—. Antes solo se cerraba el último en un `afterAll`, así que los
   * demás quedaban abiertos hasta el final de la suite.
   */
  afterEach(async () => {
    const cerrar = app;
    app = undefined as unknown as App;
    await cerrar?.close();
  });

  it.each(["cuentaClub", "delegado", "entrenador", "representante"] as const)("%s: su club → 200 con el archivo; otro club → 403 sin contenido", async (clave) => {
    const m = await montarMatriz();

    const propio = await exportar(m.tokens[clave]!, m.competencia.id, m.clubPropio.id);
    expect(propio.statusCode).toBe(200);
    expect(propio.headers["content-type"]).toContain("application/zip");
    expect(propio.headers["content-disposition"]).toMatch(/^attachment; filename="[\w-]+\.zip"$/);
    const nombres = abrirZip(propio.rawPayload).nombres;
    expect(nombres.map((n) => n.slice(-4))).toEqual([".CL2", ".HY3"]);
    expect(nombres[0]!.slice(0, -4), "los dos archivos llevan el mismo nombre base").toBe(nombres[1]!.slice(0, -4));
    expect(new AdmZip(propio.rawPayload).getEntries().map((e) => e.header.flags)).toEqual([0, 0]);

    // Ajeno: el personal del club propio pide el club ajeno.
    const ajeno = await exportar(m.tokens[clave]!, m.competencia.id, m.clubAjeno.id);
    expect(ajeno.statusCode).toBe(403);
    expect(ajeno.headers["content-type"]).not.toContain("zip");
    expect(ajeno.headers["content-disposition"]).toBeUndefined();
    expect(ajeno.rawPayload.subarray(0, 2).toString("latin1"), "sin firma de ZIP").not.toBe("PK");
  });

  it("el personal de OTRO club tampoco puede pedir el club propio de aquellos", async () => {
    const m = await montarMatriz();
    const res = await exportar(m.tokens.delegadoAjeno!, m.competencia.id, m.clubPropio.id);
    expect(res.statusCode).toBe(403);
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

  it("la cuenta de OTRO club (rol `club`) tampoco puede pedir el club propio de aquella", async () => {
    const m = await montarMatriz();
    const res = await exportar(m.tokens.cuentaClubAjena!, m.competencia.id, m.clubPropio.id);
    expect(res.statusCode).toBe(403);
    expect(res.headers["content-disposition"]).toBeUndefined();
    expect(res.rawPayload.subarray(0, 2).toString("latin1"), "sin firma de ZIP").not.toBe("PK");

    // Y, simétricamente, su propio club sí (el club ajeno no tiene inscripciones: el error es de negocio, no 403).
    const suyo = await exportar(m.tokens.cuentaClubAjena!, m.competencia.id, m.clubAjeno.id);
    expect(suyo.statusCode).not.toBe(403);
    expect(suyo.body).toMatch(/no tiene inscripciones confirmadas/i);
  });

  it("el nadador puro es rechazado (403), también con SU propio club", async () => {
    const m = await montarMatriz();
    const res = await exportar(m.tokens.nadadorPuro!, m.competencia.id, m.clubPropio.id);
    expect(res.statusCode).toBe(403);
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

  it("el archivo de la cuenta del club es byte a byte el del administrador", async () => {
    const m = await montarMatriz();
    const delAdmin = await exportar(m.tokens.admin!, m.competencia.id, m.clubPropio.id);
    const delClub = await exportar(m.tokens.cuentaClub!, m.competencia.id, m.clubPropio.id);
    expect(delClub.statusCode).toBe(200);
    for (const archivo of ["hy3", "cl2"] as const) {
      expect(sinEncabezado(abrirZip(delClub.rawPayload)[archivo])).toBe(sinEncabezado(abrirZip(delAdmin.rawPayload)[archivo]));
    }
  });

  it("sin sesión → 401", async () => {
    const m = await montarMatriz();
    const res = await app.inject({ method: "GET", url: `/export/team-manager/zip?competitionId=${m.competencia.id}&clubId=${m.clubPropio.id}` });
    expect(res.statusCode).toBe(401);
  });

  it("el administrador exporta cualquier club, y el archivo del personal es byte a byte el mismo", async () => {
    const m = await montarMatriz();

    const delAdmin = await exportar(m.tokens.admin!, m.competencia.id, m.clubPropio.id);
    expect(delAdmin.statusCode).toBe(200);
    const delPersonal = await exportar(m.tokens.delegado!, m.competencia.id, m.clubPropio.id);
    expect(delPersonal.statusCode).toBe(200);
    for (const archivo of ["hy3", "cl2"] as const) {
      expect(sinEncabezado(abrirZip(delPersonal.rawPayload)[archivo])).toBe(sinEncabezado(abrirZip(delAdmin.rawPayload)[archivo]));
    }

    // Cualquier club: el ajeno no tiene inscripciones, y el error de negocio (no 403) lo demuestra.
    const ajeno = await exportar(m.tokens.admin!, m.competencia.id, m.clubAjeno.id);
    expect(ajeno.statusCode).not.toBe(403);
    expect(ajeno.body).toMatch(/no tiene inscripciones confirmadas/i);
  });

  it("el formato se conserva: Latin-1, registros HY3 de individuales y relevos", async () => {
    const m = await montarMatriz();
    const res = await exportar(m.tokens.delegado!, m.competencia.id, m.clubPropio.id);
    const { hy3: bytesHy3, cl2 } = abrirZip(res.rawPayload);
    const texto = bytesHy3.toString("latin1");
    const lineas = texto.split(/\r?\n/);

    expect(lineas[0]!.startsWith("A1")).toBe(true);
    expect(lineas.some((l) => l.startsWith("E1"))).toBe(true); // individual
    expect(lineas.some((l) => l.startsWith("F1"))).toBe(true); // relevo
    expect(lineas.some((l) => l.startsWith("F3"))).toBe(true);
    // Byte a byte equivale a codificar el contenido del servicio en Latin-1.
    const directo = await exportarHy3(m.competencia.id, m.clubPropio.id, ADMIN_ACTOR);
    expect(sinEncabezado(bytesHy3)).toBe(sinEncabezado(Buffer.from(directo.content, "latin1")));

    // El CL2 del mismo paquete: 160 columnas, checksums válidos y sus registros.
    const lineasCl2 = cl2.toString("latin1").split("\r\n").filter(Boolean);
    expect(lineasCl2.filter((l) => !isValidCl2Line(l))).toEqual([]);
    expect(lineasCl2.some((l) => l.startsWith("D0"))).toBe(true);
    expect(lineasCl2.some((l) => l.startsWith("E0"))).toBe(true);
    expect(lineasCl2.some((l) => l.startsWith("F0"))).toBe(true);
    expect(lineasCl2[lineasCl2.length - 1]!.startsWith("Z0")).toBe(true);
  });

  it("la ruta anterior /hy3 sigue viva como alias: mismos permisos y el mismo ZIP", async () => {
    const m = await montarMatriz();
    const pedir = (token: string, clubId: string) =>
      app.inject({
        method: "GET",
        url: `/export/team-manager/hy3?competitionId=${m.competencia.id}&clubId=${clubId}`,
        headers: { authorization: `Bearer ${token}` },
      });

    const propio = await pedir(m.tokens.cuentaClub!, m.clubPropio.id);
    expect(propio.statusCode).toBe(200);
    expect(propio.headers["content-type"]).toContain("application/zip");
    expect(abrirZip(propio.rawPayload).nombres).toHaveLength(2);

    expect((await pedir(m.tokens.cuentaClub!, m.clubAjeno.id)).statusCode).toBe(403);
    expect((await pedir(m.tokens.nadadorPuro!, m.clubPropio.id)).statusCode).toBe(403);
  });

  it("exporta solo el apellido PATERNO y el RUN con guion, sin tocar lo almacenado", async () => {
    const m = await montarMatriz();
    const persona = await prisma.person.findFirstOrThrow({ where: { run: "80000001" } });
    await prisma.person.update({
      where: { id: persona.id },
      data: { paternalLastName: "De la Fuente", maternalLastName: "Maternoúnico", firstName: "Ana María", run: "12345678K" },
    });
    const antes = await prisma.person.findUniqueOrThrow({ where: { id: persona.id } });

    const res = await exportar(m.tokens.admin!, m.competencia.id, m.clubPropio.id);
    const { hy3, cl2 } = abrirZip(res.rawPayload);
    const textoHy3 = hy3.toString("latin1");
    const textoCl2 = cl2.toString("latin1");

    // Apellido compuesto entero, tal como está en su campo, y nada del materno.
    expect(textoHy3).toContain("De la Fuente");
    expect(textoCl2).toContain("De la Fuente, Ana María");
    expect(textoHy3 + textoCl2).not.toContain("Maternoúnico");
    expect(textoHy3 + textoCl2).toContain("12345678-K");

    // Las referencias de relevo usan ese mismo apellido.
    const f3 = textoHy3.split("\r\n").filter((l) => l.startsWith("F3")).join("");
    expect(f3).toContain("De la");

    expect(await prisma.person.findUniqueOrThrow({ where: { id: persona.id } }), "los datos no se tocan").toEqual(antes);
  });

  it("una persona histórica sin apellido separado detiene la exportación, sin adivinar y sin auditar", async () => {
    const m = await montarMatriz();
    const persona = await prisma.person.findFirstOrThrow({ where: { run: "80000002" } });
    await prisma.person.update({
      where: { id: persona.id },
      data: { paternalLastName: null, maternalLastName: null, firstName: null, fullName: "Pérez Soto, Luisa" },
    });
    const antes = await prisma.auditLog.count({ where: { action: "TEAM_MANAGER_EXPORT_HY3" } });

    const res = await exportar(m.tokens.admin!, m.competencia.id, m.clubPropio.id);

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("apellido paterno");
    expect(res.body).toContain("Pérez Soto, Luisa");
    expect(await prisma.auditLog.count({ where: { action: "TEAM_MANAGER_EXPORT_HY3" } })).toBe(antes);
    expect((await prisma.person.findUniqueOrThrow({ where: { id: persona.id } })).fullName).toBe("Pérez Soto, Luisa");
  });

  it("AUDITORÍA: cada descarga permitida registra TEAM_MANAGER_EXPORT_HY3 con su autor; un rechazo no registra nada", async () => {
    const m = await montarMatriz();
    const antes = await prisma.auditLog.count({ where: { action: "TEAM_MANAGER_EXPORT_HY3" } });

    await exportar(m.tokens.delegadoAjeno!, m.competencia.id, m.clubPropio.id); // 403
    await exportar(m.tokens.cuentaClubAjena!, m.competencia.id, m.clubPropio.id); // 403
    await exportar(m.tokens.nadadorPuro!, m.competencia.id, m.clubPropio.id); // 403
    expect(await prisma.auditLog.count({ where: { action: "TEAM_MANAGER_EXPORT_HY3" } })).toBe(antes);

    const res = await exportar(m.tokens.entrenador!, m.competencia.id, m.clubPropio.id);
    expect(res.statusCode).toBe(200);

    const registros = await prisma.auditLog.findMany({ where: { action: "TEAM_MANAGER_EXPORT_HY3" }, orderBy: { createdAt: "asc" } });
    expect(registros).toHaveLength(antes + 1);
    const entrenador = await prisma.user.findFirstOrThrow({ where: { username: "staff_entrenador" } });
    expect(registros[registros.length - 1]!.userId).toBe(entrenador.id);
    const detalle = registros[registros.length - 1]!.after as { clubId: string; filename: string; files: string[] };
    expect(detalle.clubId).toBe(m.clubPropio.id);
    expect(detalle.filename).toMatch(/\.zip$/);
    expect(detalle.files.map((f) => f.slice(-3)).sort()).toEqual(["CL2", "HY3"]);
  });
});

// ---------------------------------------------------------------------------
// B1 del HY3 — fechas REALES de la competencia (tarea 1 de la entrega del 2026-11-02)
// ---------------------------------------------------------------------------

/** Campos de fecha del B1: "B1" + nombre(45) + sede(45) + inicio(8) + término(8) + corte(8). */
const fechasDeB1 = (contenido: string) => {
  const b1 = contenido.split(/\r?\n/).find((l) => l.startsWith("B1"))!;
  return { b1, inicio: b1.slice(92, 100), termino: b1.slice(100, 108), corte: b1.slice(108, 116) };
};

const checksumValido = (linea: string) => linea.slice(128, 130) === computeHy3Checksum(linea.slice(0, 128));

describe("buildTeamManagerExport — B1 lleva las fechas de la COMPETENCIA", () => {
  it("REGRESIÓN: inscripción 26/10–05/11/2026 y competencia el 08/11/2026 → 11082026 en ambos campos, con checksum válido", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({
      conPiscina: true,
      fechas: ["2026-11-08"],
      inscripcion: { inicio: "2026-10-26", fin: "2026-11-05" },
    });
    const { content } = await exportarHy3(competencia.id, club.id, ADMIN_ACTOR);
    const { b1, inicio, termino } = fechasDeB1(content);

    expect(inicio).toBe("11082026");
    expect(termino).toBe("11082026");
    expect(b1).not.toContain("10262026"); // ni rastro de la apertura de inscripciones
    expect(b1).not.toContain("11052026"); // ni de su cierre (el corte de edad es el 31 de diciembre)
    expect(checksumValido(b1), "checksum del B1").toBe(true);
    // Todo el archivo conserva sus checksums válidos.
    for (const linea of content.split(/\r?\n/).filter(Boolean)) expect(checksumValido(linea), linea.slice(0, 2)).toBe(true);
  });

  it("varios días dados de alta DESORDENADOS: primera y última programadas", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({
      conPiscina: true,
      fechas: ["2026-11-10", "2026-11-15", "2026-11-08", "2026-11-09"],
      inscripcion: { inicio: "2026-10-26", fin: "2026-11-05" },
    });
    const { b1, inicio, termino } = fechasDeB1((await exportarHy3(competencia.id, club.id, ADMIN_ACTOR)).content);
    expect([inicio, termino]).toEqual(["11082026", "11152026"]);
    expect(checksumValido(b1)).toBe(true);
  });

  it("SIN fechas programadas: error claro, y no se sustituyen por las de inscripción", async () => {
    // Una competencia con piscina y sin ninguna fecha (ni, por tanto, jornadas ni pruebas).
    const piscina = await prisma.pool.create({ data: { name: "Piscina Sin Fechas", courseLength: "short_25m" } });
    const competencia = await competitionsService.createCompetition(
      {
        name: "Copa Sin Fechas",
        registrationStartAt: new Date("2026-10-26T00:00:00.000Z"),
        registrationEndAt: new Date("2026-11-05T00:00:00.000Z"),
        ageCutoffDate: new Date("2026-12-31T00:00:00.000Z"),
        maxIndividualEventsPerSwimmer: 10,
        maxRelayEventsPerSwimmerPerSession: 1,
        poolId: piscina.id,
      },
      SYSTEM_ACTOR
    );
    const club = await createClub("Club Sin Fechas", "CSF", "club_sin_fechas");

    const error = await exportarHy3(competencia.id, club.id, ADMIN_ACTOR).then(
      () => null,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toMatch(/Copa Sin Fechas/);
    expect((error as Error).message).toMatch(/no tiene fechas programadas/);
    expect(await prisma.auditLog.count({ where: { action: "TEAM_MANAGER_EXPORT_HY3" } }), "no se audita una exportación que no ocurrió").toBe(0);
  });

  it("el CORTE DE EDAD no cambió: sigue siendo ageCutoffDate, y sin ella el cierre de inscripciones", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({
      conPiscina: true,
      fechas: ["2026-11-08"],
      inscripcion: { inicio: "2026-10-26", fin: "2026-11-05" },
    });

    // Con ageCutoffDate: el 31 de diciembre que fijó la competencia.
    const conCorte = fechasDeB1((await exportarHy3(competencia.id, club.id, ADMIN_ACTOR)).content);
    expect(conCorte.corte).toBe(formatHy3Date((await prisma.competition.findUniqueOrThrow({ where: { id: competencia.id } })).ageCutoffDate!));

    // Sin ageCutoffDate: la alternativa de siempre, el cierre de inscripciones (05/11), NO la fecha de la competencia.
    await prisma.competition.update({ where: { id: competencia.id }, data: { ageCutoffDate: null } });
    const sinCorte = fechasDeB1((await exportarHy3(competencia.id, club.id, ADMIN_ACTOR)).content);
    expect(sinCorte.corte).toBe("11052026");
    expect(sinCorte.inicio).toBe("11082026");
    expect(sinCorte.termino).toBe("11082026");
  });

  it("las edades y el resto de las líneas NO dependen de las fechas de la competencia", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({
      conPiscina: true,
      fechas: ["2026-11-08"],
      inscripcion: { inicio: "2026-10-26", fin: "2026-11-05" },
    });
    const sinA1B1 = (c: string) => c.split(/\r?\n/).filter((l) => l && !l.startsWith("A1") && !l.startsWith("B1"));

    const antes = (await exportarHy3(competencia.id, club.id, ADMIN_ACTOR)).content;
    // Se programan dos días más: cambia B1, y nada más.
    await prisma.competitionDate.createMany({
      data: [
        { competitionId: competencia.id, date: new Date("2026-11-09T00:00:00.000Z") },
        { competitionId: competencia.id, date: new Date("2026-11-15T00:00:00.000Z") },
      ],
    });
    const despues = (await exportarHy3(competencia.id, club.id, ADMIN_ACTOR)).content;

    expect(fechasDeB1(antes).termino).toBe("11082026");
    expect(fechasDeB1(despues).termino).toBe("11152026");
    expect(fechasDeB1(despues).corte).toBe(fechasDeB1(antes).corte);
    expect(sinA1B1(despues)).toEqual(sinA1B1(antes));
    // Y hay edades escritas (D1): el contenido no quedó vacío por casualidad.
    expect(sinA1B1(despues).some((l) => l.startsWith("D1"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reportes — ORDEN (tarea 2 de la entrega del 2026-11-02)
// ---------------------------------------------------------------------------

describe("Reportes: orden por apellido paterno y por número de programa", () => {
  /**
   * Cuatro nadadores con edades deliberadamente CONTRARIAS al orden alfabético, y
   * un nadador histórico sin apellido paterno; una nadadora (la 1) con pruebas
   * individuales y relevos en números 2, 3, 10 y un número ausente, dadas de alta
   * en el orden contrario al del programa.
   */
  async function montarEscenario() {
    const base = await montarCompetenciaConInscripciones({ conPiscina: true });
    const [n1, n2, n3, n4] = base.nadadores as [{ id: string }, { id: string }, { id: string }, { id: string }];

    const nombre = (id: string, paternal: string | null, maternal: string | null, first: string | null, fullName: string, birth: string) =>
      prisma.person.update({
        where: { id },
        data: { paternalLastName: paternal, maternalLastName: maternal, firstName: first, fullName, birthDate: new Date(`${birth}T00:00:00.000Z`) },
      });
    await nombre(n1.id, "Zamora", "Pérez", "Zoe", "Zoe Zamora Pérez", "1975-05-05"); // dentro del rango de la categoría (20-60)
    await nombre(n2.id, "Araya", "Luna", "Bea", "Bea Araya Luna", "2000-05-05");
    await nombre(n3.id, null, null, null, "Carmen del Río", "1985-05-05"); // histórica: sin apellido paterno
    await nombre(n4.id, "Araya", "Soto", "Ana", "Ana Araya Soto", "1990-05-05");

    // Números de programa: la individual de la base pasa al 10, el relevo al 10 también (otra lista).
    await prisma.competitionEvent.update({ where: { id: base.ceIndividual.id }, data: { displayOrder: 10 } });
    await prisma.competitionEvent.update({ where: { id: base.ceRelevo.id }, data: { displayOrder: 10 } });

    // Más pruebas individuales, creadas en el orden CONTRARIO al del programa: sin número, 3 y 2.
    const tipo = await prisma.testType.findUniqueOrThrow({ where: { name: "Individual" } });
    const distancia = await prisma.distance.findFirstOrThrow({ where: { meters: 50 } });
    const jornada = await prisma.competitionSession.findFirstOrThrow({ where: { competitionId: base.competencia.id } });
    const extra = async (trazo: string, displayOrder: number | null) => {
      const estilo = await prisma.stroke.upsert({ where: { name: trazo }, update: {}, create: { name: trazo } });
      const evento = await catalogsEvents.createEvent({ testTypeId: tipo.id, distanceId: distancia.id, strokeId: estilo.id, gender: "mixed" }, SYSTEM_ACTOR);
      const ce = await competitionEventsService.addCompetitionEvent(
        base.competencia.id,
        { eventId: evento.id, competitionSessionId: jornada.id, categoryIds: [base.categoria.id], displayOrder: displayOrder ?? undefined },
        SYSTEM_ACTOR
      );
      await registrationsService.createRegistration({ competitionEventId: ce.id, clubId: base.club.id, personId: n1.id, seedTimeCentiseconds: 3000 }, ADMIN_ACTOR);
      return ce;
    };
    await extra("Mariposa", null);
    await extra("Pecho", 3);
    await extra("Espalda", 2);

    // Un segundo relevo, con número 2 (el primero quedó en 10).
    const segundo = await base.agregarSegundoRelevo();
    await prisma.competitionEvent.update({ where: { id: segundo.competitionEventId }, data: { displayOrder: 2 } });

    return { ...base, ids: { n1: n1.id, n2: n2.id, n3: n3.id, n4: n4.id } };
  }

  const ESPERADO = ["Bea Araya Luna", "Ana Araya Soto", "Zoe Zamora Pérez", "Carmen del Río"];

  it("agrupación: por club, nadadores por apellido paterno (histórico al final), edad y categoría intactas", async () => {
    const { competencia } = await montarEscenario();
    const { groupedByClub } = await reportsService.getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR);

    expect(groupedByClub).toHaveLength(1);
    const club = groupedByClub[0]!;
    expect(club.swimmers.map((s) => s.nombreCompleto)).toEqual(ESPERADO);
    // Edades al corte (31-dic del año en curso): por edad saldrían Bea, Ana, Carmen, Zoe —no el orden alfabético—,
    // y siguen mostrándose.
    const anio = new Date().getFullYear();
    expect(club.swimmers.map((s) => s.edad)).toEqual([anio - 2000, anio - 1990, anio - 1975, anio - 1985]);
    expect(club.totalNadadores).toBe(4);
    // Cada nadador conserva su categoría (la individual manda).
    for (const s of club.swimmers) expect(s.categoria).toBeTruthy();
    expect(club.totalRelevos).toBe(2);
  });

  it("pruebas y relevos de una nadadora: 2, 3, 10 y el ausente al final; relevos 2, 10", async () => {
    const { competencia } = await montarEscenario();
    const { groupedByClub } = await reportsService.getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR);
    const zoe = groupedByClub[0]!.swimmers.find((s) => s.nombreCompleto === "Zoe Zamora Pérez")!;

    expect(zoe.pruebas.map((l) => l.number)).toEqual([2, 3, 10, null]);
    expect(zoe.relevos.map((l) => l.number)).toEqual([2, 10]);
    expect(zoe.pruebas.map((l) => l.text.split(" ")[1])).toEqual(["Espalda", "Pecho", "Libre", "Mariposa"]);
  });

  it("filas planas: mismo orden que la vista agrupada, una fila por inscripción, relevos por equipo", async () => {
    const { competencia } = await montarEscenario();
    const informe = await reportsService.getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR);

    // Individuales: las de cada nadador juntas, nadadores en el orden de la vista agrupada.
    const secuencia = informe.individualRows.map((r) => r.nombreCompleto);
    const sinRepetidosConsecutivos = secuencia.filter((n, i) => i === 0 || n !== secuencia[i - 1]);
    expect(sinRepetidosConsecutivos).toEqual(ESPERADO);
    // Y no se pierde ni se duplica ninguna fila: 4 nadadores en la base + 3 pruebas extra de Zoe = 7.
    expect(informe.individualRows).toHaveLength(7);
    // Las de Zoe, por número de programa.
    expect(informe.individualRows.filter((r) => r.nombreCompleto === "Zoe Zamora Pérez").map((r) => r.estilo)).toEqual([
      "Espalda",
      "Pecho",
      "Libre",
      "Mariposa",
    ]);

    // Relevos: UNA fila por equipo (no por integrante), por número de programa.
    expect(informe.relayRows).toHaveLength(2);
    expect(informe.relayRows[0]!.prueba).toMatch(/Espalda/); // número 2
    expect(informe.relayRows[1]!.prueba).toMatch(/Libre/); // número 10
  });

  it("CSV, XLSX y PDF: mismo orden y mismas filas que el informe, sin columnas nuevas", async () => {
    const { competencia } = await montarEscenario();
    const informe = await reportsService.getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR);
    const esperadas = informe.individualRows.map((r) => r.nombreCompleto);

    // CSV
    const csv = reportsService.buildCsv(informe.individualRows, informe.relayRows);
    const lineasCsv = csv.split("\r\n");
    const iInd = lineasCsv.indexOf("INDIVIDUALES");
    const iRel = lineasCsv.indexOf("RELEVOS");
    const filasInd = lineasCsv.slice(iInd + 2, iRel - 1); // cabecera, filas, línea en blanco
    expect(filasInd).toHaveLength(informe.individualRows.length);
    expect(filasInd.map((l) => l.split(",")[3])).toEqual(esperadas); // columna «nombre completo»
    expect(lineasCsv[iInd + 1]!.split(",")).toHaveLength(13); // sin columnas añadidas
    expect(lineasCsv[iRel + 1]!.split(",")).toHaveLength(11);
    expect(lineasCsv.slice(iRel + 2).filter(Boolean)).toHaveLength(informe.relayRows.length);

    // XLSX
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load((await reportsService.buildXlsx(informe.individualRows, informe.relayRows)) as never);
    const hojaInd = libro.getWorksheet("Individuales")!;
    const nombresXlsx: string[] = [];
    hojaInd.eachRow((fila, n) => {
      if (n > 1) nombresXlsx.push(String(fila.getCell(4).value));
    });
    expect(nombresXlsx).toEqual(esperadas);
    expect(hojaInd.getRow(1).cellCount).toBe(13);
    expect(libro.getWorksheet("Relevos")!.rowCount).toBe(1 + informe.relayRows.length);

    // PDF: se descomprimen sus flujos y se leen las líneas de texto en el orden en que
    // quedaron en el archivo (no se renderiza ni se abre en un visor: es una extracción
    // del contenido generado). Las líneas de «Individuales» siguen el orden del informe.
    const pdf = await reportsService.buildPdf(informe.competitionName, informe.individualRows, informe.relayRows);
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    const lineasPdf = lineasDeTextoDelPdf(pdf);
    const iIndPdf = lineasPdf.indexOf("Individuales");
    const iRelPdf = lineasPdf.indexOf("Relevos");
    expect(iIndPdf).toBeGreaterThanOrEqual(0);
    expect(iRelPdf).toBeGreaterThan(iIndPdf);
    const individualesPdf = lineasPdf.slice(iIndPdf + 1, iRelPdf);
    expect(individualesPdf).toHaveLength(informe.individualRows.length);
    informe.individualRows.forEach((r, i) => {
      expect(individualesPdf[i]).toBe(`${r.club} — ${r.nombreCompleto} (${r.run}) — ${r.prueba} — ${r.categoria} — ${r.fecha} ${r.jornada}`);
    });
    // Relevos: una línea por equipo (la lista de integrantes puede partirse en varias líneas del PDF, así que
    // se buscan las que empiezan con el club del equipo, en el orden del informe).
    const relevosPdf = lineasPdf.slice(iRelPdf + 1).filter((l) => l.startsWith(`${informe.relayRows[0]!.equipoClub} — `));
    expect(relevosPdf).toHaveLength(informe.relayRows.length);
    informe.relayRows.forEach((r, i) => expect(relevosPdf[i]).toContain(`${r.equipoClub} — ${r.prueba} — ${r.categoria}`));
  });

  it("permisos y alcance no cambian: un club solo ve lo suyo, y el contenido es el mismo", async () => {
    const { competencia, club } = await montarEscenario();
    const comoClub: ActorContext = { userId: ADMIN_ACTOR.userId, isAdmin: false, scope: { kind: "club", clubId: club.id }, canRegisterPostClose: false };
    const delClub = await reportsService.getRegistrationsReport({ competitionId: competencia.id }, comoClub);
    const delAdmin = await reportsService.getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR);
    expect(delClub.groupedByClub).toEqual(delAdmin.groupedByClub);

    const otro = await createClub("Club Ajeno Reportes", "CAJR", "club_ajeno_rep");
    await expect(reportsService.getRegistrationsReport({ competitionId: competencia.id, clubId: otro.id }, comoClub)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("desempate COHERENTE: números repetidos y ausentes salen en el mismo orden relativo en la vista agrupada y en las filas planas (CSV / XLSX / PDF)", async () => {
    const base = await montarEscenario();
    const tipo = await prisma.testType.findUniqueOrThrow({ where: { name: "Individual" } });
    const jornada = await prisma.competitionSession.findFirstOrThrow({ where: { competitionId: base.competencia.id } });
    // Ana (n4) con dos pruebas del mismo número (6), dos sin número y distintos tiempos: todo por texto.
    const agregar = async (metros: number, trazo: string, displayOrder: number | null, centisegundos: number | null) => {
      const distancia = await prisma.distance.upsert({ where: { meters: metros }, update: {}, create: { meters: metros } });
      const estilo = await prisma.stroke.upsert({ where: { name: trazo }, update: {}, create: { name: trazo } });
      const evento = await catalogsEvents.createEvent({ testTypeId: tipo.id, distanceId: distancia.id, strokeId: estilo.id, gender: "mixed" }, SYSTEM_ACTOR);
      const ce = await competitionEventsService.addCompetitionEvent(
        base.competencia.id,
        { eventId: evento.id, competitionSessionId: jornada.id, categoryIds: [base.categoria.id], displayOrder: displayOrder ?? undefined },
        SYSTEM_ACTOR
      );
      await registrationsService.createRegistration(
        { competitionEventId: ce.id, clubId: base.club.id, personId: base.ids.n4, seedTimeCentiseconds: centisegundos ?? undefined },
        ADMIN_ACTOR
      );
    };
    // Se dan de alta en un orden que NO coincide con el del texto (Pecho antes que Espalda, etc.).
    await agregar(100, "Pecho", 6, null);
    await agregar(100, "Espalda", 6, 7000);
    await agregar(200, "Mariposa", null, null);
    await agregar(100, "Mariposa", null, 9000);

    const informe = await reportsService.getRegistrationsReport({ competitionId: base.competencia.id }, ADMIN_ACTOR);
    const ana = informe.groupedByClub[0]!.swimmers.find((s) => s.nombreCompleto === "Ana Araya Soto")!;
    const vista = ana.pruebas.map((l) => `${l.number}|${l.text}`);

    // Lo que consumen los archivos: las filas planas de Ana, con su mismo número y texto (descripción + tiempo).
    // La prueba base de Ana (50m Libre, sin tiempo) está en el programa 10.
    const planas = informe.individualRows.filter((r) => r.nombreCompleto === "Ana Araya Soto");
    expect(planas).toHaveLength(ana.pruebas.length);
    expect(ana.pruebas.map((l) => l.number)).toEqual([6, 6, 10, null, null]);
    expect(vista[0]).toBe("6|100m Espalda 1:10,00"); // repetido: «Espalda» antes que «Pecho» aunque «Pecho» se inscribió antes
    expect(vista[1]).toBe("6|100m Pecho");
    expect(vista[3]).toBe("null|100m Mariposa 1:30,00"); // ausentes al final, por texto: «100m» antes que «200m»
    expect(vista[4]).toBe("null|200m Mariposa");
    expect(planas.map((r) => r.prueba)).toEqual(["100m Espalda", "100m Pecho", "50m Libre", "100m Mariposa", "200m Mariposa"]);
    expect(planas.map((r) => r.prueba)).toEqual(ana.pruebas.map((l) => l.text.replace(/ \d+:\d{2},\d{2}$/, "")));

    // CSV y XLSX respetan ese mismo orden relativo.
    const csv = reportsService.buildCsv(informe.individualRows, informe.relayRows).split("\r\n");
    const filasCsv = csv.slice(csv.indexOf("INDIVIDUALES") + 2, csv.indexOf("RELEVOS") - 1).filter((l) => l.includes("Ana Araya Soto"));
    expect(filasCsv.map((l) => l.split(",")[6])).toEqual(planas.map((r) => r.prueba)); // columna «prueba»
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load((await reportsService.buildXlsx(informe.individualRows, informe.relayRows)) as never);
    const pruebasXlsx: string[] = [];
    libro.getWorksheet("Individuales")!.eachRow((fila, n) => {
      if (n > 1 && String(fila.getCell(4).value) === "Ana Araya Soto") pruebasXlsx.push(String(fila.getCell(7).value));
    });
    expect(pruebasXlsx).toEqual(planas.map((r) => r.prueba));

    // PDF: mismas líneas, mismo orden (extracción del contenido generado).
    const pdf = await reportsService.buildPdf(informe.competitionName, informe.individualRows, informe.relayRows);
    const lineasPdf = lineasDeTextoDelPdf(pdf);
    // Solo la sección «Individuales» (Ana también figura como integrante en la de «Relevos»).
    const delPdf = lineasPdf.slice(lineasPdf.indexOf("Individuales"), lineasPdf.indexOf("Relevos")).filter((l) => l.includes("Ana Araya Soto"));
    expect(delPdf.map((l) => l.split(" — ")[2])).toEqual(planas.map((r) => r.prueba));
  });

  it("la categoría y el club mostrados NO cambian por el orden de presentación: la del primer registro entregado, no la de la primera prueba del programa", async () => {
    const base = await montarCompetenciaConInscripciones({ conPiscina: true });
    const [n1] = base.nadadores as [{ id: string }];
    // La prueba de la base de n1 queda en el programa 9 (categoría «Master Export»).
    await prisma.competitionEvent.update({ where: { id: base.ceIndividual.id }, data: { displayOrder: 9 } });
    // Una segunda individual, en el programa 1 y de OTRA categoría (otro tipo de prueba, para no solapar edades),
    // inscrita DESPUÉS: si la selección dependiera del programa, la categoría mostrada pasaría a «Master Dos».
    const tipoDos = await prisma.testType.upsert({ where: { name: "Individual Dos" }, update: {}, create: { name: "Individual Dos", swimmersCount: 1 } });
    const categoriaDos = await catalogsCategories.createCategory({ testTypeId: tipoDos.id, name: "Master Dos", minAge: 20, maxAge: 60 }, SYSTEM_ACTOR);
    const distancia = await prisma.distance.findFirstOrThrow({ where: { meters: 50 } });
    const estilo = await prisma.stroke.upsert({ where: { name: "Espalda" }, update: {}, create: { name: "Espalda" } });
    const jornada = await prisma.competitionSession.findFirstOrThrow({ where: { competitionId: base.competencia.id } });
    const evento = await catalogsEvents.createEvent({ testTypeId: tipoDos.id, distanceId: distancia.id, strokeId: estilo.id, gender: "mixed" }, SYSTEM_ACTOR);
    const ce = await competitionEventsService.addCompetitionEvent(
      base.competencia.id,
      { eventId: evento.id, competitionSessionId: jornada.id, categoryIds: [categoriaDos.id], displayOrder: 1 },
      SYSTEM_ACTOR
    );
    await registrationsService.createRegistration({ competitionEventId: ce.id, clubId: base.club.id, personId: n1.id, seedTimeCentiseconds: 3000 }, ADMIN_ACTOR);

    /**
     * La base NO garantiza el orden de los empates por (club, nombre): dos inscripciones de un mismo nadador
     * pueden volver en cualquier orden. Para que la prueba sea determinista el middleware de Prisma reordena la lectura (que se ejecuta de verdad) y se
     * entrega cada vez el orden que se quiere —con la inscripción del programa 1 al final o al principio—,
     * y se comprueba que la categoría mostrada sigue a lo entregado, no al número de programa.
     */
    const leerEntregando = async (primeroElDelPrograma1: boolean) => {
      const delUno = (x: { competitionEvent: { displayOrder: number | null } }) => (x.competitionEvent.displayOrder === 1 ? 0 : 1);
      control.reordenarIndividuales = (filas) => filas.slice().sort((a, b) => (primeroElDelPrograma1 ? delUno(a) - delUno(b) : delUno(b) - delUno(a)));
      try {
        return await reportsService.getRegistrationsReport({ competitionId: base.competencia.id }, ADMIN_ACTOR);
      } finally {
        control.reordenarIndividuales = null;
      }
    };
    const delNadador = (i: Awaited<ReturnType<typeof leerEntregando>>) => i.groupedByClub[0]!.swimmers.find((s) => s.run === "80000001")!;

    // Se entrega PRIMERO la inscripción del programa 9 (categoría «Master Export»): esa es la categoría mostrada,
    // aunque la prueba 1 (otra categoría) figure primero en el programa. Las pruebas sí se muestran ordenadas.
    const conBasePrimero = await leerEntregando(false);
    expect(delNadador(conBasePrimero).categoria).toBe("Master Export");
    expect(delNadador(conBasePrimero).pruebas.map((l) => l.number)).toEqual([1, 9]);

    // Entregada primero la del programa 1, la categoría es la de esa inscripción: la selección sigue a lo entregado.
    const conProgramaUnoPrimero = await leerEntregando(true);
    expect(delNadador(conProgramaUnoPrimero).categoria).toBe("Master Dos");
    expect(delNadador(conProgramaUnoPrimero).pruebas.map((l) => l.number)).toEqual([1, 9]);

    // Las filas planas (que sí se ordenan, por programa) no dependen de lo entregado.
    for (const informe of [conBasePrimero, conProgramaUnoPrimero]) {
      expect(informe.individualRows.filter((r) => r.run === "80000001").map((r) => r.categoria)).toEqual(["Master Dos", "Master Export"]);
    }
  });
});

/**
 * Líneas de texto de un PDF generado por PDFKit, en el orden del archivo. Descomprime los flujos
 * (Flate) y lee los arreglos `TJ` (cadenas hexadecimales en WinAnsi). NO renderiza ni valida el
 * PDF: es una extracción del contenido para comprobar el orden de las líneas que se escribieron.
 */
function lineasDeTextoDelPdf(pdf: Buffer): string[] {
  const lineas: string[] = [];
  const texto = pdf.toString("latin1");
  const flujos = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let m = flujos.exec(texto); m; m = flujos.exec(texto)) {
    let contenido: string;
    try {
      contenido = inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1");
    } catch {
      continue; // flujo no comprimido (fuentes, etc.)
    }
    for (const tj of contenido.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      const bytes = [...tj[1]!.matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => h[1]!).join("");
      lineas.push(new TextDecoder("windows-1252").decode(Buffer.from(bytes, "hex")));
    }
  }
  return lineas;
}
