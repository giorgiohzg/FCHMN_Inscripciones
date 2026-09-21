/**
 * Fase 3 — pruebas que invocan REALMENTE los tres caminos de importación y
 * exportación contra PostgreSQL:
 *
 *   - `importCompetitionFromMeetEventsZip` (el ZIP de Meet Events)
 *   - `getRegistrationsReport` + `buildCsv` / `buildXlsx` (los reportes)
 *   - `buildTeamManagerHy3Export` (el archivo .HY3)
 *
 * Hasta ahora la Fase 3 se apoyaba en pruebas de funciones puras
 * (parser, escritor HY3, escapado CSV, límites de ZIP). Eso verifica las
 * piezas, no el camino: nada comprobaba que el servicio de exportación
 * exigiera la piscina, que el tope contara los relevos, o que una
 * importación fallida no dejara una competencia a medio crear.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import AdmZip from "adm-zip";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addActiveMembership } from "./helpers/seedRbac";
import * as competitionsService from "../src/modules/competitions/competitions.service";
import * as structureService from "../src/modules/competitions/competition-structure.service";
import * as competitionEventsService from "../src/modules/competitions/competition-events.service";
import * as registrationsService from "../src/modules/registrations/registrations.service";
import * as relayService from "../src/modules/relay-registrations/relay-registrations.service";
import * as catalogsCategories from "../src/modules/catalogs/categories.service";
import * as catalogsEvents from "../src/modules/catalogs/events.service";
import * as reportsService from "../src/modules/reports/reports.service";
import { buildTeamManagerHy3Export } from "../src/modules/team-manager-export/team-manager-export.service";
import { importCompetitionFromMeetEventsZip } from "../src/modules/meet-import/meet-import.service";
import { ValidationError } from "../src/shared/errors";

/**
 * El actor apunta a un usuario REAL de la base. Con un id inventado, cada
 * `audit()` falla con P2003 contra la clave foránea de `audit_logs.user_id`
 * y —como la auditoría suprime sus errores (hallazgo 23, Fase 5)— el fallo
 * pasa inadvertido y no se puede comprobar que las acciones queden
 * registradas.
 */
let SYSTEM_ACTOR: { userId: string; ipAddress?: string };
let ADMIN_ACTOR: { userId: string; isAdmin: true; scope: { kind: "admin" }; canRegisterPostClose: boolean };

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

const control: { conteoObsoleto: number | null; capturas: ConsultaCapturada[] } = {
  conteoObsoleto: null,
  capturas: [],
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
  return next(params);
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
    expect(competencia.status).toBe("draft");
    expect(competencia.dates).toHaveLength(1);
    expect(competencia.dates[0]!.sessions).toHaveLength(1);
    expect(competencia.competitionEvents).toHaveLength(1);
  });

  it("RECHAZA un archivo de varios días SIN crear nada, y no sugiere importar uno por día", async () => {
    const zip = zipConEv3(ev3Con({ inicio: "03/28/2026", fin: "03/30/2026", lineas: [LINEA_INDIVIDUAL] }));

    await expect(importCompetitionFromMeetEventsZip(zip, { maxIndividualEventsPerSwimmer: 5 }, SYSTEM_ACTOR)).rejects.toThrow(/3 días/);

    // Nada escrito: el rechazo ocurre antes de la primera escritura.
    expect(await prisma.competition.count()).toBe(0);
    expect(await prisma.competitionDate.count()).toBe(0);

    // Y el consejo NO puede ser "importe un archivo por día": eso crearía
    // tres competencias separadas.
    const error: Error = await importCompetitionFromMeetEventsZip(zip, { maxIndividualEventsPerSwimmer: 5 }, SYSTEM_ACTOR).then(
      () => {
        throw new Error("se esperaba que la importación fallara");
      },
      (e: Error) => e
    );
    expect(error.message).toContain("cree la competencia manualmente");
    expect(error.message).toContain("competencias distintas");
    expect(error.message).not.toMatch(/exporte .* un archivo \.ev3 por cada día .* impórtelos/i);
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
    expect(error!.message).toMatch(/no tiene configurados los tipos de prueba/i);
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

  it("los relevos dla exportación real conservan su distancia TOTAL en la base", async () => {
    const resumen = await importCompetitionFromMeetEventsZip(zipConEv3(SAMPLE_EV3), { maxIndividualEventsPerSwimmer: 5 }, SYSTEM_ACTOR);
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

async function montarCompetenciaConInscripciones(opciones: { conPiscina: boolean; nombreClub?: string }) {
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
      registrationStartAt: new Date(ahora.getTime() - 86_400_000),
      registrationEndAt: new Date(ahora.getTime() + 86_400_000),
      ageCutoffDate: new Date(ahora.getFullYear(), 11, 31),
      maxIndividualEventsPerSwimmer: 10,
      maxRelayEventsPerSwimmerPerSession: 1,
      poolId: piscina?.id,
    },
    SYSTEM_ACTOR
  );
  await competitionsService.transitionCompetition(competencia.id, "schedule", SYSTEM_ACTOR);

  const fecha = await structureService.addCompetitionDate(competencia.id, new Date(), SYSTEM_ACTOR);
  const jornada = await structureService.addSession(fecha.id, tipoJornada.id, SYSTEM_ACTOR);

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

  await registrationsService.createRegistration(
    { competitionEventId: ceIndividual.id, clubId: club.id, personId: nadadores[0]!.id, seedTimeCentiseconds: 3012 },
    ADMIN_ACTOR
  );
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
    expect(reporte.individualRows).toHaveLength(1);
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

    expect(error, "con 1 individual + 1 relevo y tope 1, el reporte debe rechazarse").toBeInstanceOf(ValidationError);
    expect(error!.message).toContain("2 inscripciones");
    expect(error!.message).toContain("1 individuales");
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
    const { competencia, club, ceIndividual, nadadores } = await montarCompetenciaConInscripciones({ conPiscina: true });
    for (const nadador of nadadores.slice(1)) {
      await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, clubId: club.id, personId: nadador.id }, ADMIN_ACTOR);
    }
    // Datos reales: 4 individuales + 1 relevo = 5 filas.

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
    // Datos reales: 1 individual + 1 relevo.

    const conteos = conConteosObsoletos(0);

    try {
      // Tope 5: las individuales consumen 1, así que a los relevos les debe
      // quedar un presupuesto de 4 y pedirse `take: 5` (remanente + 1).
      // Con un tope por consulta se habría pedido 6 (MAX + 1).
      await reportsService.getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR, { maxRows: 5 });

      const lecturasRelevo = conteos.lecturasDe("RelayRegistration");
      expect(lecturasRelevo.length).toBeGreaterThan(0);
      expect(lecturasRelevo[0]!.args.take).toBe(5);
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
    // Datos reales: 1 individual + 2 relevos = 3 filas.

    const conteos = conConteosObsoletos(0);
    try {
      // Tope 2: la individual (1) cabe; quedan 1 de presupuesto y hay 2
      // relevos, así que el exceso lo aporta exclusivamente la sección de
      // relevos.
      const error = await reportsService
        .getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR, { maxRows: 2 })
        .then(() => null)
        .catch((e) => e as ValidationError);

      expect(error, "el exceso lo aportan los relevos, no las individuales").toBeInstanceOf(ValidationError);

      // Las individuales NO dispararon el corte temprano: se leyeron y se
      // siguió adelante hasta consultar los relevos.
      const lecturasIndividuales = conteos.lecturasDe("Registration");
      const lecturasRelevo = conteos.lecturasDe("RelayRegistration");
      expect(lecturasIndividuales[0]!.args.take).toBe(3); // MAX(2) + 1
      expect(lecturasRelevo.length, "debe haberse consultado la sección de relevos").toBeGreaterThan(0);
      expect(lecturasRelevo[0]!.args.take, "presupuesto restante (2 - 1) + 1").toBe(2);

      // El rechazo procede de la comparación con el remanente, así que la
      // lectura vino truncada.
      expect(error!.details).toMatchObject({ individualRows: 1, relayRows: 2, totalRows: 3, truncated: true });
      expect(error!.message).toContain("al menos");
    } finally {
      conteos.restore();
    }
  });

  it("el mensaje dice 'al menos' cuando la lectura vino truncada", async () => {
    const { competencia, club, ceIndividual, nadadores } = await montarCompetenciaConInscripciones({ conPiscina: true });
    for (const nadador of nadadores.slice(1)) {
      await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, clubId: club.id, personId: nadador.id }, ADMIN_ACTOR);
    }

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
      expect(reporte.individualRows).toHaveLength(1);
      expect(reporte.relayRows).toHaveLength(1);
    } finally {
      conteos.restore();
    }
  });

  it("con el tope holgado, el mismo reporte se genera sin problema", async () => {
    const { competencia } = await montarCompetenciaConInscripciones({ conPiscina: true });
    const reporte = await reportsService.getRegistrationsReport({ competitionId: competencia.id }, ADMIN_ACTOR, { maxRows: 100 });
    expect(reporte.individualRows.length + reporte.relayRows.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// buildTeamManagerHy3Export
// ---------------------------------------------------------------------------

describe("buildTeamManagerHy3Export (invocación real)", () => {
  it("genera el archivo con la piscina configurada y la distancia TOTAL del relevo", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({ conPiscina: true });

    const { filename, content } = await buildTeamManagerHy3Export(competencia.id, club.id, SYSTEM_ACTOR);

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

    await expect(buildTeamManagerHy3Export(competencia.id, club.id, SYSTEM_ACTOR)).rejects.toThrow(/no tiene piscina asignada/i);
  });

  it("RECHAZA generar el archivo si hay un relevo con datos inconsistentes, en vez de omitirlo", async () => {
    const { competencia, club, relevo } = await montarCompetenciaConInscripciones({ conPiscina: true });

    // Se deja el equipo con 3 integrantes, simulando un dato corrupto.
    const miembros = await prisma.relayRegistrationMember.findMany({ where: { relayRegistrationId: relevo.id } });
    await prisma.relayRegistrationMember.delete({ where: { id: miembros[0]!.id } });

    const error: ValidationError = await buildTeamManagerHy3Export(competencia.id, club.id, SYSTEM_ACTOR).then(
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
    const { competencia, club, ceIndividual, nadadores } = await montarCompetenciaConInscripciones({ conPiscina: true });
    for (const nadador of nadadores.slice(1)) {
      await registrationsService.createRegistration({ competitionEventId: ceIndividual.id, clubId: club.id, personId: nadador.id }, ADMIN_ACTOR);
    }
    // Datos reales: 4 individuales + 1 relevo.

    const conteos = conConteosObsoletos(0);

    try {
      const error = await buildTeamManagerHy3Export(competencia.id, club.id, SYSTEM_ACTOR, { maxRows: 2 })
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
    // Datos reales: 1 individual + 2 relevos.

    const conteos = conConteosObsoletos(0);
    try {
      const error = await buildTeamManagerHy3Export(competencia.id, club.id, SYSTEM_ACTOR, { maxRows: 2 })
        .then(() => null)
        .catch((e) => e as ValidationError);

      expect(error).toBeInstanceOf(ValidationError);

      const lecturasIndividuales = conteos.lecturasDe("Registration");
      const lecturasRelevo = conteos.lecturasDe("RelayRegistration");
      expect(lecturasIndividuales[0]!.args.take).toBe(3); // MAX(2) + 1
      expect(lecturasRelevo.length, "las individuales cabían: debe haberse leído relevos").toBeGreaterThan(0);
      expect(lecturasRelevo[0]!.args.take, "presupuesto restante (2 - 1) + 1").toBe(2);

      expect(error!.details).toMatchObject({ individualRows: 1, relayRows: 2, totalRows: 3, truncated: true });
      expect(error!.message).toContain("al menos");
    } finally {
      conteos.restore();
    }
  });

  it("el presupuesto de relevos del .HY3 es el remanente", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({ conPiscina: true });

    const conteos = conConteosObsoletos(0);

    try {
      await buildTeamManagerHy3Export(competencia.id, club.id, SYSTEM_ACTOR, { maxRows: 5 });
      const lecturasRelevo = conteos.lecturasDe("RelayRegistration");
      expect(lecturasRelevo[0]!.args.take).toBe(5); // (5 - 1) + 1
      expect(lecturasRelevo[0]!.args.take).not.toBe(6);
    } finally {
      conteos.restore();
    }
  });

  it("el tope del archivo .HY3 también cuenta individuales y relevos", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({ conPiscina: true });

    const error = await buildTeamManagerHy3Export(competencia.id, club.id, SYSTEM_ACTOR, { maxRows: 1 })
      .then(() => null)
      .catch((e) => e as ValidationError);

    expect(error).toBeInstanceOf(ValidationError);
    expect(error!.message).toContain("2 inscripciones confirmadas");
    expect(error!.message).toContain("1 individuales");
    expect(error!.message).toContain("1 de relevo");
  });

  it("RECHAZA exportar un club sin inscripciones confirmadas", async () => {
    const { competencia } = await montarCompetenciaConInscripciones({ conPiscina: true });
    const otroClub = await createClub("Club Sin Inscritos", "CLBS");

    await expect(buildTeamManagerHy3Export(competencia.id, otroClub.id, SYSTEM_ACTOR)).rejects.toThrow(/no tiene inscripciones confirmadas/i);
  });

  it("deja registro de auditoría de la exportación", async () => {
    const { competencia, club } = await montarCompetenciaConInscripciones({ conPiscina: true });
    await buildTeamManagerHy3Export(competencia.id, club.id, SYSTEM_ACTOR);

    const registros = await prisma.auditLog.findMany({ where: { action: "TEAM_MANAGER_EXPORT_HY3" } });
    expect(registros.length).toBeGreaterThan(0);
  });
});
