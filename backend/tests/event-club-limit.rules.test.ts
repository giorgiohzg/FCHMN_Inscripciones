/**
 * Etapa 4 — máximo de nadadores por club y prueba individual: la regla pura y el contrato
 * de entrada. La comprobación contra la base (transacción, concurrencia, auditoría) está en
 * `event-club-limit.integration.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { evaluateEventClubLimit } from "../src/modules/competitions/competition-capacity.rules";
import { addCompetitionEventSchema, updateCompetitionEventSchema } from "../src/modules/competitions/competitions.schemas";

describe("evaluateEventClubLimit — la unidad es la inscripción confirmada del club en esa prueba", () => {
  it("SIN LÍMITE (null): siempre cabe, aunque el club tenga cientos", () => {
    for (const ya of [0, 1, 50, 999]) {
      const r = evaluateEventClubLimit(null, ya, false);
      expect(r).toMatchObject({ allowed: true, exceededByOverride: false, limit: null, resultingCount: ya + 1 });
    }
  });

  it("límite 1: la primera cabe, la segunda no", () => {
    expect(evaluateEventClubLimit(1, 0, false).allowed).toBe(true);
    const r = evaluateEventClubLimit(1, 1, false);
    expect(r.allowed).toBe(false);
    expect(r.exceededByOverride).toBe(false);
  });

  it("JUSTO EN EL LÍMITE: con 2 de 3 la tercera cabe; con 3 de 3 la cuarta se rechaza", () => {
    expect(evaluateEventClubLimit(3, 2, false)).toMatchObject({ allowed: true, resultingCount: 3 });
    expect(evaluateEventClubLimit(3, 3, false)).toMatchObject({ allowed: false, resultingCount: 4 });
  });

  it("el mensaje habla del club, de la prueba, del máximo, y no echa la culpa a otros clubes", () => {
    const r = evaluateEventClubLimit(2, 2, false, { clubName: "Club Delfín", eventLabel: "50m Libre" });
    expect(r.reason).toContain("Club Delfín");
    expect(r.reason).toContain("«50m Libre»");
    expect(r.reason).toContain("máximo de 2");
    expect(r.reason).toMatch(/demás clubes/);
    expect(r.reason).toMatch(/amplíe el máximo/);
  });

  it("si el máximo se REDUJO por debajo de lo ya inscrito, lo dice y solo impide altas nuevas", () => {
    const r = evaluateEventClubLimit(1, 3, false, { clubName: "Club Delfín" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/ya tiene 3 nadador\(es\) inscrito\(s\) y el máximo por club se fijó en 1/);
  });

  it("el ADMINISTRADOR puede exceder: se acepta y se marca para auditarla", () => {
    expect(evaluateEventClubLimit(2, 2, true)).toMatchObject({ allowed: true, exceededByOverride: true, limit: 2, resultingCount: 3 });
    // Y si aun así cabe, no hay excepción que auditar.
    expect(evaluateEventClubLimit(2, 1, true)).toMatchObject({ allowed: true, exceededByOverride: false });
  });

  it("quien NO es administrador no excede nunca (el permiso no cuenta: la regla solo recibe el indicador)", () => {
    expect(evaluateEventClubLimit(1, 1, false).allowed).toBe(false);
  });
});

describe("campo maxSwimmersPerClub en el alta y la edición de una prueba", () => {
  const base = { eventId: "11111111-1111-4111-8111-111111111111", competitionSessionId: "22222222-2222-4222-8222-222222222222", categoryIds: ["33333333-3333-4333-8333-333333333333"] };

  it("omitido y null significan «sin límite»", () => {
    const omitido = addCompetitionEventSchema.safeParse(base);
    expect(omitido.success && omitido.data.maxSwimmersPerClub).toBeUndefined();
    const nulo = addCompetitionEventSchema.safeParse({ ...base, maxSwimmersPerClub: null });
    expect(nulo.success && nulo.data.maxSwimmersPerClub).toBeNull();
    const edicion = updateCompetitionEventSchema.safeParse({ maxSwimmersPerClub: null });
    expect(edicion.success && edicion.data.maxSwimmersPerClub).toBeNull();
  });

  it("un entero positivo se acepta, también como texto numérico", () => {
    for (const v of [1, 5, "3"]) {
      expect(addCompetitionEventSchema.safeParse({ ...base, maxSwimmersPerClub: v }).success, String(v)).toBe(true);
      expect(updateCompetitionEventSchema.safeParse({ maxSwimmersPerClub: v }).success, String(v)).toBe(true);
    }
  });

  it("cero, negativos, decimales y texto no numérico se RECHAZAN", () => {
    for (const v of [0, -1, -10, 1.5, 2.9, "abc", "", "0", "1.5"]) {
      expect(addCompetitionEventSchema.safeParse({ ...base, maxSwimmersPerClub: v }).success, `alta «${String(v)}»`).toBe(false);
      expect(updateCompetitionEventSchema.safeParse({ maxSwimmersPerClub: v }).success, `edición «${String(v)}»`).toBe(false);
    }
  });

  it("en la edición, omitido significa «no lo toques»", () => {
    const r = updateCompetitionEventSchema.safeParse({ status: "enabled" });
    expect(r.success && "maxSwimmersPerClub" in r.data).toBe(false);
  });
});
