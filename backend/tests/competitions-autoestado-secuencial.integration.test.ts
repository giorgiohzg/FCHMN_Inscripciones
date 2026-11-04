/**
 * `listCompetitions` «sana» el estado de cada competencia al leerla (RB-07): una guardada como
 * «programada» cuya ventana ya abrió pasa a «abierta», y una «abierta» cuya ventana venció pasa a
 * «cerrada», con su auditoría en una transacción propia.
 *
 * DEFECTO. Esas transacciones se iniciaban TODAS A LA VEZ (`Promise.all` sobre `applyAutoStatus`).
 * Cada una necesita su propia conexión, así que N competencias por sanar exigían N conexiones
 * simultáneas: las que no estaban ya abiertas tenían que abrirse en ese momento, y si abrirlas tarda
 * más que el plazo de arranque de una transacción (2 s en Prisma), el listado entero fallaba con
 * `P2028` («Unable to start a transaction in the given time») → 503. Con la base de ensayo de este
 * proyecto abrir una conexión nueva tardó ≈2 s, y el listado fallaba con solo tres competencias.
 *
 * REGRESIÓN CONTROLADA. No se depende de la lentitud del entorno: un middleware de Prisma
 * (a) cuenta cuántas de esas transacciones están en curso a la vez, y (b) retiene cada una 40 ms,
 * lo bastante para que, si se lanzan juntas, se solapen. Con la implementación anterior el pico es
 * mayor que 1; secuencial, es exactamente 1.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions } from "./helpers/seedRbac";
import * as competitionsService from "../src/modules/competitions/competitions.service";

const DIA = 86_400_000;

const medicion = { activa: false, enCurso: 0, pico: 0, iniciadas: 0, retencionMs: 40 };

prisma.$use(async (params, next) => {
  const esSanacion = medicion.activa && params.model === "Competition" && params.action === "update";
  if (esSanacion) {
    medicion.iniciadas++;
    medicion.enCurso++;
    medicion.pico = Math.max(medicion.pico, medicion.enCurso);
    await new Promise((r) => setTimeout(r, medicion.retencionMs));
  }
  const resultado = await next(params);
  // La transacción de la sanación termina con su auditoría (misma transacción).
  if (medicion.activa && params.model === "AuditLog" && params.action === "create" && JSON.stringify(params.args).includes("COMPETITION_STATUS_AUTO_CHANGED")) {
    medicion.enCurso--;
  }
  return resultado;
});

const reiniciar = () => Object.assign(medicion, { activa: false, enCurso: 0, pico: 0, iniciadas: 0 });

/** Competencias sintéticas que REALMENTE necesitan sanarse: `por_abrir` (programada con ventana abierta) y `por_cerrar` (abierta con ventana vencida). */
async function sembrar(porAbrir: number, porCerrar: number, extra: { sanas?: number; ocultas?: number } = {}) {
  const ahora = Date.now();
  const crear = (name: string, status: "scheduled" | "open" | "draft", inicio: number, fin: number, visible = true) =>
    prisma.competition.create({
      data: {
        name,
        status,
        registrationStartAt: new Date(inicio),
        registrationEndAt: new Date(fin),
        maxIndividualEventsPerSwimmer: 5,
        visibleInRegistrationPanels: visible,
      },
    });
  // Fechas de inicio DISTINTAS y descendentes con el índice: el orden del listado es por inicio descendente.
  for (let i = 0; i < porAbrir; i++) await crear(`Por abrir ${String(i).padStart(2, "0")}`, "scheduled", ahora - (10 + i) * DIA, ahora + 60 * DIA);
  for (let i = 0; i < porCerrar; i++) await crear(`Por cerrar ${String(i).padStart(2, "0")}`, "open", ahora - (100 + i) * DIA, ahora - 5 * DIA);
  for (let i = 0; i < (extra.sanas ?? 0); i++) await crear(`Sana ${String(i).padStart(2, "0")}`, "open", ahora - (200 + i) * DIA, ahora + 90 * DIA);
  for (let i = 0; i < (extra.ocultas ?? 0); i++) await crear(`Oculta por abrir ${i}`, "scheduled", ahora - (300 + i) * DIA, ahora + 60 * DIA, false);
  await crear("Borrador", "draft", ahora - 400 * DIA, ahora + 30 * DIA);
}

beforeEach(async () => {
  reiniciar();
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
});

afterAll(async () => {
  reiniciar();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

const listar = (query: Record<string, unknown> = {}, ocultarBorradorYProgramada = false) =>
  competitionsService.listCompetitions({ page: 1, pageSize: 100, ...query } as never, ocultarBorradorYProgramada);

describe("las transacciones de sanación del estado NO se inician todas a la vez", () => {
  it("con 6 competencias por sanar, hay UNA transacción en curso a la vez (pico = 1)", async () => {
    await sembrar(4, 2);
    medicion.activa = true;

    // Con la implementación anterior este listado podía incluso fallar con P2028; aquí importa el pico medido.
    await listar().catch(() => undefined);

    medicion.activa = false;
    expect(medicion.iniciadas, "se intentó sanar las seis").toBeGreaterThanOrEqual(1);
    expect(medicion.pico, `pico de transacciones simultáneas: ${medicion.pico}`).toBe(1);
  });

  it("y el listado completa: las seis quedan sanadas, cada una con su auditoría, sin error", async () => {
    await sembrar(4, 2);
    medicion.activa = true;
    const r = await listar();
    medicion.activa = false;

    expect(medicion.iniciadas).toBe(6);
    expect(medicion.pico).toBe(1);
    expect(r.items.filter((c) => c.name.startsWith("Por abrir")).every((c) => c.status === "open")).toBe(true);
    expect(r.items.filter((c) => c.name.startsWith("Por cerrar")).every((c) => c.status === "closed")).toBe(true);

    // Persistido, con la causa del cierre por fecha, y una auditoría por cambio (usuario nulo: lo hizo el tiempo).
    const guardadas = await prisma.competition.findMany({ where: { name: { startsWith: "Por " } } });
    expect(guardadas.filter((c) => c.status === "open")).toHaveLength(4);
    const cerradas = guardadas.filter((c) => c.status === "closed");
    expect(cerradas).toHaveLength(2);
    expect(cerradas.every((c) => c.registrationsClosedReason === "schedule" && c.registrationsClosedAt !== null)).toBe(true);
    const auditorias = await prisma.auditLog.findMany({ where: { action: "COMPETITION_STATUS_AUTO_CHANGED" } });
    expect(auditorias).toHaveLength(6);
    expect(auditorias.every((a) => a.userId === null)).toBe(true);
    expect(new Set(auditorias.map((a) => a.entityId)).size).toBe(6);
  });

  it("volver a listar no repite nada: ya están sanadas", async () => {
    await sembrar(3, 1);
    await listar();
    medicion.activa = true;
    await listar();
    medicion.activa = false;
    expect(medicion.iniciadas).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "COMPETITION_STATUS_AUTO_CHANGED" } })).toBe(4);
  });
});

describe("el listado conserva su orden, filtros, totales, paginación y restricciones", () => {
  const nombres = (r: { items: { name: string }[] }) => r.items.map((c) => c.name);

  it("orden por inicio de inscripción descendente, igual con y sin sanación", async () => {
    await sembrar(3, 2, { sanas: 2 });
    const esperado = [...(await prisma.competition.findMany({ orderBy: [{ registrationStartAt: "desc" }, { id: "desc" }] }))].map((c) => c.name);
    const r = await listar();
    expect(nombres(r)).toEqual(esperado);
    expect(r.total).toBe(8);
  });

  it("paginación: sin repetidos ni huecos y el mismo total en todas las páginas", async () => {
    await sembrar(5, 3, { sanas: 2 });
    const todas: string[] = [];
    const totales = new Set<number>();
    for (let page = 1; page <= 5; page++) {
      const r = await listar({ page, pageSize: 4 });
      totales.add(r.total);
      todas.push(...nombres(r));
    }
    expect(totales).toEqual(new Set([11]));
    expect(todas).toHaveLength(11);
    expect(new Set(todas).size).toBe(11);
  });

  it("filtro de estado auto-mutable: usa el estado sanado, no el guardado", async () => {
    await sembrar(4, 2, { sanas: 1 });
    const abiertas = await listar({ status: "open" });
    expect(nombres(abiertas).sort()).toEqual(["Por abrir 00", "Por abrir 01", "Por abrir 02", "Por abrir 03", "Sana 00"]);
    expect(abiertas.total).toBe(5);
    const cerradas = await listar({ status: "closed" });
    expect(nombres(cerradas).sort()).toEqual(["Por cerrar 00", "Por cerrar 01"]);
  });

  it("restricción por rol: quien no es administrador no ve Borrador ni Programada (tras sanar, las abiertas sí)", async () => {
    await sembrar(2, 1);
    const r = await listar({}, true);
    expect(nombres(r).sort()).toEqual(["Por abrir 00", "Por abrir 01", "Por cerrar 00"]);
    expect(r.total).toBe(3);
  });

  it("filtro de visibilidad de los desplegables: se suma a lo anterior y no pisa nada", async () => {
    await sembrar(2, 1, { ocultas: 2 });
    const visibles = await listar({ visibleInRegistrationPanels: true }, true);
    expect(nombres(visibles).sort()).toEqual(["Por abrir 00", "Por abrir 01", "Por cerrar 00"]);
    const ocultas = await listar({ visibleInRegistrationPanels: false });
    expect(nombres(ocultas).sort()).toEqual(["Oculta por abrir 0", "Oculta por abrir 1"]);
    expect(ocultas.items.every((c) => c.status === "open")).toBe(true);
    // Sin el filtro, el administrador sigue viéndolas todas.
    expect((await listar()).total).toBe(2 + 1 + 2 + 1);
  });
});
