import { describe, it, expect } from "vitest";
import { validateIndividualRegistration, resolveCategoryForAge, type IndividualRegistrationCheckInput, type CategoryCandidate } from "../src/modules/registrations/registrations.rules";

function baseInput(overrides: Partial<IndividualRegistrationCheckInput> = {}): IndividualRegistrationCheckInput {
  return {
    competitionIsOpen: true,
    isPostCloseException: false,
    clubIsActive: true,
    swimmerIsActive: true,
    swimmerBelongsToClub: true,
    swimmerBirthDate: new Date("2000-01-01"),
    swimmerGender: "female",
    categoryCutoffDate: new Date("2026-12-31"),
    categoryMinAge: 25,
    categoryMaxAge: 29,
    categoryEnabledForCompetitionEvent: true,
    eventGender: "mixed",
    competitionEventIsEnabled: true,
    alreadyRegisteredForThisEvent: false,
    currentIndividualCountInSession: 0,
    maxIndividualEventsInSession: 3,
    currentIndividualCountInCompetition: 0,
    maxIndividualEventsInCompetition: 10,
    ...overrides,
  };
}

describe("registrations.rules — validateIndividualRegistration", () => {
  it("aprueba una inscripción que cumple todas las condiciones", () => {
    const result = validateIndividualRegistration(baseInput());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rechaza si la competencia no tiene inscripciones abiertas y no hay excepción", () => {
    const result = validateIndividualRegistration(baseInput({ competitionIsOpen: false }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("inscripciones abiertas"))).toBe(true);
  });

  it("permite inscribir con competencia cerrada SI es una excepción administrativa autorizada (RB-08)", () => {
    const result = validateIndividualRegistration(baseInput({ competitionIsOpen: false, isPostCloseException: true }));
    expect(result.valid).toBe(true);
  });

  it("rechaza si el club no está activo", () => {
    const result = validateIndividualRegistration(baseInput({ clubIsActive: false }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("club no está activo"))).toBe(true);
  });

  it("rechaza si el nadador no está activo", () => {
    const result = validateIndividualRegistration(baseInput({ swimmerIsActive: false }));
    expect(result.valid).toBe(false);
  });

  it("rechaza si el nadador no pertenece al club", () => {
    const result = validateIndividualRegistration(baseInput({ swimmerBelongsToClub: false }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("no pertenece"))).toBe(true);
  });

  it("rechaza si la edad del nadador está fuera del rango de la categoría", () => {
    // Nace 2000, corte 2026 -> 26 años, categoría 30-34 -> fuera de rango
    const result = validateIndividualRegistration(baseInput({ categoryMinAge: 30, categoryMaxAge: 34 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("rango de la categoría"))).toBe(true);
  });

  it("acepta el límite exacto de edad de la categoría", () => {
    // 2000 -> 2026 corte = 26 años exactos
    const result = validateIndividualRegistration(baseInput({ categoryMinAge: 26, categoryMaxAge: 26 }));
    expect(result.valid).toBe(true);
  });

  it("rechaza si el género del nadador no coincide con el de la prueba", () => {
    const result = validateIndividualRegistration(baseInput({ eventGender: "male", swimmerGender: "female" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("género"))).toBe(true);
  });

  it("acepta cualquier género cuando la prueba es mixta", () => {
    const result = validateIndividualRegistration(baseInput({ eventGender: "mixed", swimmerGender: "male" }));
    expect(result.valid).toBe(true);
  });

  it("rechaza si la prueba no está habilitada para la competencia", () => {
    const result = validateIndividualRegistration(baseInput({ competitionEventIsEnabled: false }));
    expect(result.valid).toBe(false);
  });

  it("rechaza si la categoría no está habilitada para esta prueba en esta competencia", () => {
    const result = validateIndividualRegistration(baseInput({ categoryEnabledForCompetitionEvent: false }));
    expect(result.valid).toBe(false);
  });

  it("rechaza una inscripción duplicada en la misma prueba", () => {
    const result = validateIndividualRegistration(baseInput({ alreadyRegisteredForThisEvent: true }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ya tiene una inscripción"))).toBe(true);
  });

  it("rechaza al superar el máximo de pruebas individuales de la fecha+jornada", () => {
    const result = validateIndividualRegistration(baseInput({ currentIndividualCountInSession: 3, maxIndividualEventsInSession: 3 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("máximo"))).toBe(true);
  });

  it("permite inscribir sin límite cuando maxIndividualEventsInSession es null", () => {
    const result = validateIndividualRegistration(baseInput({ currentIndividualCountInSession: 50, maxIndividualEventsInSession: null }));
    expect(result.valid).toBe(true);
  });

  it("rechaza al superar el máximo de pruebas individuales de TODA la competencia (RB-10 a nivel de competencia)", () => {
    const result = validateIndividualRegistration(baseInput({ currentIndividualCountInCompetition: 10, maxIndividualEventsInCompetition: 10 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("toda la competencia"))).toBe(true);
  });

  it("permite inscribir sin límite de competencia cuando maxIndividualEventsInCompetition es null", () => {
    const result = validateIndividualRegistration(baseInput({ currentIndividualCountInCompetition: 999, maxIndividualEventsInCompetition: null }));
    expect(result.valid).toBe(true);
  });

  it("el límite de sesión y el límite de competencia son independientes: puede fallar solo uno de los dos", () => {
    // Dentro del límite de sesión, pero ya alcanzó el límite de competencia.
    const result = validateIndividualRegistration(
      baseInput({ currentIndividualCountInSession: 1, maxIndividualEventsInSession: 3, currentIndividualCountInCompetition: 5, maxIndividualEventsInCompetition: 5 })
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/toda la competencia/);
  });

  it("acumula TODOS los errores aplicables, no solo el primero", () => {
    const result = validateIndividualRegistration(
      baseInput({ clubIsActive: false, swimmerIsActive: false, competitionEventIsEnabled: false })
    );
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("registrations.rules — resolveCategoryForAge (cálculo automático de categoría)", () => {
  const categories25_29: CategoryCandidate = { id: "c1", name: "25-29", minAge: 25, maxAge: 29 };
  const categories30_34: CategoryCandidate = { id: "c2", name: "30-34", minAge: 30, maxAge: 34 };

  it("resuelve a la única categoría cuyo rango contiene la edad calculada", () => {
    // Nace 08-sep-1972, corte 31-dic-2025 -> 53 años.
    const category50_54: CategoryCandidate = { id: "c3", name: "50-54", minAge: 50, maxAge: 54 };
    const result = resolveCategoryForAge(new Date("1972-09-08"), new Date("2025-12-31"), [categories25_29, categories30_34, category50_54]);
    expect(result.outcome).toBe("resolved");
    if (result.outcome === "resolved") {
      expect(result.category.id).toBe("c3");
    }
  });

  it("reporta 'none' si ninguna categoría cubre la edad calculada", () => {
    const result = resolveCategoryForAge(new Date("2000-01-01"), new Date("2025-12-31"), [categories25_29, categories30_34]);
    // Nace 2000, corte 2025 -> 25 años exactos -> SÍ cae en 25-29; probemos una edad fuera de rango.
    expect(result.outcome).toBe("resolved");

    const tooYoung = resolveCategoryForAge(new Date("2010-01-01"), new Date("2025-12-31"), [categories25_29, categories30_34]);
    expect(tooYoung.outcome).toBe("none");
    if (tooYoung.outcome === "none") {
      expect(tooYoung.age).toBe(15);
    }
  });

  it("reporta 'ambiguous' si dos o más categorías se superponen para la misma edad", () => {
    const overlapping: CategoryCandidate = { id: "c4", name: "20-30 (superpuesta)", minAge: 20, maxAge: 30 };
    const result = resolveCategoryForAge(new Date("1996-01-01"), new Date("2025-12-31"), [categories25_29, overlapping]);
    // Nace 1996, corte 2025 -> 29 años -> cae en 25-29 Y en 20-30 (superposición real).
    expect(result.outcome).toBe("ambiguous");
    if (result.outcome === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
      expect(result.age).toBe(29);
    }
  });

  it("respeta los límites exactos inferior y superior del rango", () => {
    const exactMin = resolveCategoryForAge(new Date("2000-01-01"), new Date("2025-01-01"), [categories25_29]); // exactamente 25
    expect(exactMin.outcome).toBe("resolved");

    const exactMax = resolveCategoryForAge(new Date("1996-01-01"), new Date("2025-01-01"), [categories25_29]); // exactamente 29
    expect(exactMax.outcome).toBe("resolved");
  });
});
