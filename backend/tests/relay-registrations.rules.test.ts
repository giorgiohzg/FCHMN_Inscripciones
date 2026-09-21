import { describe, it, expect } from "vitest";
import { validateRelayRegistration, type RelayRegistrationCheckInput, type RelayMemberInput } from "../src/modules/relay-registrations/relay-registrations.rules";

function makeMember(overrides: Partial<RelayMemberInput> = {}): RelayMemberInput {
  return {
    personId: "p1",
    displayName: "Nadador 1",
    swimmerIsActive: true,
    swimmerBelongsToClub: true,
    swimmerGender: "female",
    currentRelayCountInSession: 0,
    ...overrides,
  };
}

// Por defecto: 2 hombres + 2 mujeres, para que siga siendo un equipo
// válido incluso en una prueba mixta (regla de composición 2+2).
function fourValidMembers(): RelayMemberInput[] {
  return [
    makeMember({ personId: "p1", displayName: "Nadador 1", swimmerGender: "male" }),
    makeMember({ personId: "p2", displayName: "Nadador 2", swimmerGender: "male" }),
    makeMember({ personId: "p3", displayName: "Nadador 3", swimmerGender: "female" }),
    makeMember({ personId: "p4", displayName: "Nadador 4", swimmerGender: "female" }),
  ];
}

function baseInput(overrides: Partial<RelayRegistrationCheckInput> = {}): RelayRegistrationCheckInput {
  return {
    competitionIsOpen: true,
    isPostCloseException: false,
    clubIsActive: true,
    competitionEventIsEnabled: true,
    duplicateTeamForClub: false,
    eventGender: "mixed",
    maxRelayEventsInSession: 2,
    requiredMemberCount: 4,
    members: fourValidMembers(),
    ...overrides,
  };
}

describe("relay-registrations.rules — validateRelayRegistration", () => {
  it("aprueba un equipo de 4 nadadores que cumple todas las condiciones", () => {
    const result = validateRelayRegistration(baseInput());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rechaza un equipo con menos de 4 integrantes", () => {
    const result = validateRelayRegistration(baseInput({ members: fourValidMembers().slice(0, 3) }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exactamente 4"))).toBe(true);
  });

  it("rechaza un equipo con más de 4 integrantes", () => {
    const result = validateRelayRegistration(baseInput({ members: [...fourValidMembers(), makeMember({ personId: "p5", displayName: "Nadador 5" })] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("exactamente 4"))).toBe(true);
  });

  it("rechaza un nadador duplicado dentro del mismo equipo", () => {
    const members = fourValidMembers();
    members[3] = { ...members[0]! }; // duplica al primero en la 4ta posición
    const result = validateRelayRegistration(baseInput({ members }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicado"))).toBe(true);
  });

  it("rechaza si la competencia no tiene inscripciones abiertas y no hay excepción", () => {
    const result = validateRelayRegistration(baseInput({ competitionIsOpen: false }));
    expect(result.valid).toBe(false);
  });

  it("permite con competencia cerrada si es excepción administrativa (RB-08)", () => {
    const result = validateRelayRegistration(baseInput({ competitionIsOpen: false, isPostCloseException: true }));
    expect(result.valid).toBe(true);
  });

  it("rechaza si el club ya tiene un equipo inscrito para esta prueba y categoría", () => {
    const result = validateRelayRegistration(baseInput({ duplicateTeamForClub: true }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("ya tiene un equipo"))).toBe(true);
  });

  it("rechaza si un integrante no está activo", () => {
    const members = fourValidMembers();
    members[1] = makeMember({ personId: "p2", displayName: "Nadador 2", swimmerGender: "male", swimmerIsActive: false });
    const result = validateRelayRegistration(baseInput({ members }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Nadador 2") && e.includes("no está activo"))).toBe(true);
  });

  it("rechaza si un integrante no pertenece al club", () => {
    const members = fourValidMembers();
    members[2] = makeMember({ personId: "p3", displayName: "Nadador 3", swimmerGender: "female", swimmerBelongsToClub: false });
    const result = validateRelayRegistration(baseInput({ members }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Nadador 3") && e.includes("no pertenece"))).toBe(true);
  });

  it("rechaza si el género de un integrante no es compatible con la prueba", () => {
    const members = [
      makeMember({ personId: "p1", displayName: "Nadador 1", swimmerGender: "male" }),
      makeMember({ personId: "p2", displayName: "Nadador 2", swimmerGender: "female" }),
      makeMember({ personId: "p3", displayName: "Nadador 3", swimmerGender: "female" }),
      makeMember({ personId: "p4", displayName: "Nadador 4", swimmerGender: "female" }),
    ];
    const result = validateRelayRegistration(baseInput({ eventGender: "female", members }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Nadador 1") && e.includes("género"))).toBe(true);
  });

  it("acepta un relevo mixto con exactamente 2 hombres y 2 mujeres", () => {
    const result = validateRelayRegistration(baseInput({ eventGender: "mixed" }));
    expect(result.valid).toBe(true);
  });

  it("rechaza un relevo mixto que no tenga exactamente 2 hombres y 2 mujeres (3 hombres y 1 mujer)", () => {
    const members = [
      makeMember({ personId: "p1", displayName: "Nadador 1", swimmerGender: "male" }),
      makeMember({ personId: "p2", displayName: "Nadador 2", swimmerGender: "male" }),
      makeMember({ personId: "p3", displayName: "Nadador 3", swimmerGender: "male" }),
      makeMember({ personId: "p4", displayName: "Nadador 4", swimmerGender: "female" }),
    ];
    const result = validateRelayRegistration(baseInput({ eventGender: "mixed", members }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("2 nadadores y 2 nadadoras"))).toBe(true);
  });

  it("rechaza un relevo mixto compuesto por las 4 del mismo género", () => {
    const members = fourValidMembers().map((m) => ({ ...m, swimmerGender: "female" as const }));
    const result = validateRelayRegistration(baseInput({ eventGender: "mixed", members }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("2 nadadores y 2 nadadoras"))).toBe(true);
  });

  it("no exige composición 2+2 en pruebas no mixtas (mismo género para todos)", () => {
    const members = [
      makeMember({ personId: "p1", displayName: "Nadador 1", swimmerGender: "female" }),
      makeMember({ personId: "p2", displayName: "Nadador 2", swimmerGender: "female" }),
      makeMember({ personId: "p3", displayName: "Nadador 3", swimmerGender: "female" }),
      makeMember({ personId: "p4", displayName: "Nadador 4", swimmerGender: "female" }),
    ];
    const result = validateRelayRegistration(baseInput({ eventGender: "female", members }));
    expect(result.valid).toBe(true);
  });

  /**
   * Hallazgo 11 — el límite de relevos por nadador y jornada dejó de ser la
   * constante 1 escrita en el código y ahora sale de la configuración de la
   * competencia (con la jornada pudiendo restringir más).
   */
  it("rechaza al integrante que ya alcanzó el límite configurado", () => {
    const members = fourValidMembers();
    members[3] = { ...members[3]!, currentRelayCountInSession: 2 };
    const result = validateRelayRegistration(baseInput({ maxRelayEventsInSession: 2, members }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Nadador 4") && e.includes("máximo de 2 relevo(s)"))).toBe(true);
  });

  it("PERMITE un segundo relevo cuando la configuración lo admite (antes lo rechazaba con un tope fijo de 1)", () => {
    const members = fourValidMembers();
    members[0] = { ...members[0]!, currentRelayCountInSession: 1 };
    const result = validateRelayRegistration(baseInput({ maxRelayEventsInSession: 2, members }));
    expect(result.valid).toBe(true);
  });

  it("con el valor por defecto (1) mantiene el comportamiento histórico", () => {
    const members = fourValidMembers();
    members[0] = { ...members[0]!, currentRelayCountInSession: 1 };
    const result = validateRelayRegistration(baseInput({ maxRelayEventsInSession: 1, members }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("máximo de 1 relevo(s)"))).toBe(true);
  });

  it("sin límite (null) admite cualquier cantidad de relevos por nadador", () => {
    const members = fourValidMembers();
    members[0] = { ...members[0]!, currentRelayCountInSession: 7 };
    const result = validateRelayRegistration(baseInput({ maxRelayEventsInSession: null, members }));
    expect(result.valid).toBe(true);
  });

  it("un límite de 0 significa que la jornada no admite relevos", () => {
    const result = validateRelayRegistration(baseInput({ maxRelayEventsInSession: 0 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("no admite relevos"))).toBe(true);
  });

  it("permite si nadie tiene relevos previos en la jornada", () => {
    const result = validateRelayRegistration(baseInput({ maxRelayEventsInSession: 2 }));
    expect(result.valid).toBe(true);
  });

  it("acumula errores de varios integrantes distintos a la vez", () => {
    const members = fourValidMembers();
    members[0] = makeMember({ personId: "p1", displayName: "Nadador 1", swimmerGender: "male", swimmerIsActive: false });
    members[1] = makeMember({ personId: "p2", displayName: "Nadador 2", swimmerGender: "male", swimmerBelongsToClub: false });
    const result = validateRelayRegistration(baseInput({ members }));
    expect(result.errors.some((e) => e.includes("Nadador 1"))).toBe(true);
    expect(result.errors.some((e) => e.includes("Nadador 2"))).toBe(true);
  });
});

describe("relay-registrations.rules — resolveCategoryForComputedAge (edad combinada del equipo)", () => {
  it("la categoría del relevo se resuelve por la SUMA de edades de los 4 integrantes, no individualmente", async () => {
    const { resolveCategoryForComputedAge } = await import("../src/modules/registrations/registrations.rules");
    // 4 nadadores de 20, 22, 25 y 28 años -> edad combinada = 95.
    const combinedAge = 20 + 22 + 25 + 28;
    const category = { id: "c1", name: "80-99", minAge: 80, maxAge: 99 };
    const result = resolveCategoryForComputedAge(combinedAge, [category]);
    expect(result.outcome).toBe("resolved");
    if (result.outcome === "resolved") expect(result.category.id).toBe("c1");
  });
});
