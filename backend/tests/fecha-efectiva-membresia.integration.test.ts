/**
 * La fecha EFECTIVA de una membresía, contra PostgreSQL y por los servicios
 * reales.
 *
 * Lo que se comprueba es que el día que entra es el día que queda guardado —sin
 * importar la hora ni la zona del servidor— y que sigue siendo distinto de la
 * marca de auditoría.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser, createPerson } from "./helpers/seedRbac";
import * as clubsService from "../src/modules/clubs/clubs.service";
import * as assignmentService from "../src/modules/swimmer-assignment/assignment.service";
import { hoyEnZonaDelNegocio, utcAFechaCalendario } from "../src/shared/fecha.util";

let ADMIN: { userId: string };
const FECHA = "2026-10-30";

const CLUB_BASE = {
  email: "contacto@example.invalid",
  hasLegalStatus: null,
  isAchmnMember: false,
  isAchmnCollaborator: false,
  isFchmnMember: false,
  isFchmnCollaborator: false,
  delegatePersonIds: [],
  coachPersonIds: [],
  legalRepresentativePersonId: null,
};

const crearClub = (sufijo: string) =>
  clubsService.createClub(
    { ...CLUB_BASE, name: `Club ${sufijo}`, code: sufijo.slice(0, 5).toUpperCase(), username: `club.${sufijo}` },
    ADMIN
  );

const crearPersona = (n: number) =>
  createPerson({ run: `2000000${n}`, username: `nadador${n}`, firstName: `Nadador${n}`, gender: "male" });

/** Lee `start_date` como texto directamente de la base: sin capas que lo desplacen. */
async function fechaEnLaBase(id: string): Promise<string | null> {
  const r = await prisma.$queryRawUnsafe<{ v: string | null }[]>(`SELECT start_date::text AS v FROM club_swimmers WHERE id = $1`, id);
  return r[0]?.v ?? null;
}

beforeEach(async () => {
  await truncateAllTables(prisma as unknown as Parameters<typeof truncateAllTables>[0]);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin.fechas", roleNames: ["admin"] });
  ADMIN = { userId: admin.id };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("la fecha efectiva que entra es la que queda guardada", () => {
  it("asignación directa: guarda exactamente el día pedido", async () => {
    const club = await crearClub("d1");
    const persona = await crearPersona(1);
    const m = await assignmentService.assignSwimmerDirectly({ clubId: club.id, personId: persona.id, fechaEfectiva: FECHA }, ADMIN);

    expect(utcAFechaCalendario(m.startDate)).toBe(FECHA);
    // Y en la base, leído como texto: ningún desplazamiento de ±1 día.
    expect(await fechaEnLaBase(m.id)).toBe(FECHA);
  });

  it("la marca de auditoría sigue siendo un INSTANTE y es distinta de la fecha", async () => {
    const club = await crearClub("d2");
    const persona = await crearPersona(2);
    const m = await assignmentService.assignSwimmerDirectly({ clubId: club.id, personId: persona.id, fechaEfectiva: FECHA }, ADMIN);

    expect(m.reviewedAt).toBeInstanceOf(Date);
    // `reviewedAt` conserva la hora; `startDate` es medianoche UTC del día.
    expect(m.startDate!.toISOString()).toBe(`${FECHA}T00:00:00.000Z`);
    expect(m.reviewedAt!.toISOString()).not.toBe(m.startDate!.toISOString());

    const tipos = await prisma.$queryRawUnsafe<{ column_name: string; data_type: string }[]>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name='club_swimmers' AND column_name IN ('start_date','reviewed_at')`
    );
    const porNombre = Object.fromEntries(tipos.map((t) => [t.column_name, t.data_type]));
    expect(porNombre.start_date).toBe("date");
    expect(porNombre.reviewed_at).toBe("timestamp without time zone");
  });

  it("sin fecha: usa el día de HOY en Chile, no el del reloj del servidor", async () => {
    const club = await crearClub("d3");
    const persona = await crearPersona(3);
    const m = await assignmentService.assignSwimmerDirectly({ clubId: club.id, personId: persona.id }, ADMIN);
    expect(await fechaEnLaBase(m.id)).toBe(hoyEnZonaDelNegocio());
  });

  it("la reasignación a otro club también acepta la fecha", async () => {
    const a = await crearClub("d4a");
    const b = await crearClub("d4b");
    const persona = await crearPersona(4);
    await assignmentService.assignSwimmerDirectly({ clubId: a.id, personId: persona.id, fechaEfectiva: "2026-01-15" }, ADMIN);
    const m = await assignmentService.reassignSwimmerToClub(persona.id, b.id, ADMIN, FECHA);
    expect(await fechaEnLaBase(m.id)).toBe(FECHA);
  });

  it("la aprobación de una propuesta también acepta la fecha", async () => {
    const club = await crearClub("d5");
    const persona = await crearPersona(5);
    const propuesta = await assignmentService.proposeAssignment(
      { clubId: club.id, personId: persona.id },
      { userId: ADMIN.userId, scope: { kind: "admin" } } as never
    );
    // Una propuesta nace SIN fecha de inicio: se le pone al aprobar.
    expect(propuesta.startDate).toBeNull();

    const aprobada = await assignmentService.approveAssignment(propuesta.id, ADMIN, FECHA);
    expect(await fechaEnLaBase(aprobada.id)).toBe(FECHA);
  });
});

describe("una carga masiva comparte UNA fecha", () => {
  it("las 30 membresías quedan con la MISMA fecha, la pedida", async () => {
    const club = await crearClub("m1");
    const personas = [];
    for (let i = 100; i < 130; i++) personas.push(await crearPersona(i));

    const r = await assignmentService.bulkAssignSwimmers(
      { targetClubId: club.id, personIds: personas.map((p) => p.id), fechaEfectiva: FECHA },
      ADMIN
    );
    expect(r.assignedCount).toBe(30);

    const distintas = await prisma.$queryRawUnsafe<{ n: bigint; f: string }[]>(
      `SELECT count(*) AS n, start_date::text AS f FROM club_swimmers WHERE status='active' GROUP BY start_date`
    );
    // UNA sola fecha para toda la tanda. Antes había una marca por membresía.
    expect(distintas).toHaveLength(1);
    expect(distintas[0]!.f).toBe(FECHA);
    expect(Number(distintas[0]!.n)).toBe(30);
  });

  it("las marcas de auditoría SÍ son distintas entre sí: cada escritura tiene su instante", async () => {
    const club = await crearClub("m2");
    const personas = [];
    for (let i = 200; i < 205; i++) personas.push(await crearPersona(i));
    await assignmentService.bulkAssignSwimmers({ targetClubId: club.id, personIds: personas.map((p) => p.id), fechaEfectiva: FECHA }, ADMIN);

    const r = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(DISTINCT reviewed_at) AS n FROM club_swimmers WHERE status='active'`
    );
    // La fecha efectiva es una decisión; la auditoría, un registro de hechos.
    expect(Number(r[0]!.n)).toBeGreaterThan(1);
  });

  it("sin fecha, toda la tanda comparte el día de hoy en Chile", async () => {
    const club = await crearClub("m3");
    const personas = [];
    for (let i = 300; i < 305; i++) personas.push(await crearPersona(i));
    await assignmentService.bulkAssignSwimmers({ targetClubId: club.id, personIds: personas.map((p) => p.id) }, ADMIN);

    const r = await prisma.$queryRawUnsafe<{ f: string }[]>(
      `SELECT DISTINCT start_date::text AS f FROM club_swimmers WHERE status='active'`
    );
    expect(r).toHaveLength(1);
    expect(r[0]!.f).toBe(hoyEnZonaDelNegocio());
  });
});
