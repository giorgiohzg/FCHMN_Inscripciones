/**
 * Hallazgo 10 — qué estados de la competencia admiten operar inscripciones.
 *
 * Antes la pregunta era binaria ("¿está abierta?") y, si no lo estaba,
 * bastaba el permiso post-cierre para operar en CUALQUIER estado.
 */
import { describe, it, expect } from "vitest";
import { evaluateRegistrationWindow, type CompetitionStatus, type RegistrationOperation } from "../src/modules/competitions/competitions.rules";
import { resolveEffectiveRelayLimit } from "../src/modules/relay-registrations/relay-registrations.service";
import { assertTestTypeMatches, requiredRelayMembers } from "../src/shared/testType.util";
import { ValidationError } from "../src/shared/errors";

const OPERACIONES: RegistrationOperation[] = ["create", "update", "cancel"];

describe("evaluateRegistrationWindow", () => {
  it("con la competencia ABIERTA permite a cualquiera, sin marcar excepción", () => {
    for (const op of OPERACIONES) {
      const r = evaluateRegistrationWindow("open", op, false);
      expect(r.allowed).toBe(true);
      expect(r.isPostCloseException).toBe(false);
    }
  });

  it("con la competencia CERRADA exige el permiso post-cierre y marca la excepción", () => {
    for (const op of OPERACIONES) {
      expect(evaluateRegistrationWindow("closed", op, false).allowed).toBe(false);

      const conPermiso = evaluateRegistrationWindow("closed", op, true);
      expect(conPermiso.allowed).toBe(true);
      expect(conPermiso.isPostCloseException).toBe(true);
    }
  });

  /**
   * El núcleo del hallazgo: el permiso post-cierre daba paso libre en
   * cualquier estado que no fuera "abierta".
   */
  const ESTADOS_PROHIBIDOS: CompetitionStatus[] = ["draft", "scheduled", "in_progress", "finished", "cancelled"];

  it("NO permite operar en borrador, programada, en curso, finalizada ni cancelada — ni con permiso post-cierre", () => {
    for (const estado of ESTADOS_PROHIBIDOS) {
      for (const op of OPERACIONES) {
        const conPermiso = evaluateRegistrationWindow(estado, op, true);
        expect(conPermiso.allowed, `${estado}/${op} no debería permitirse`).toBe(false);
        expect(conPermiso.isPostCloseException).toBe(false);
        expect(conPermiso.reason).toBeTruthy();
      }
    }
  });

  it("explica el motivo mencionando el estado", () => {
    expect(evaluateRegistrationWindow("finished", "create", true).reason).toContain("finalizada");
    expect(evaluateRegistrationWindow("draft", "cancel", true).reason).toContain("borrador");
  });
});

describe("resolveEffectiveRelayLimit (hallazgo 11)", () => {
  it("sin límite de jornada manda el de la competencia", () => {
    expect(resolveEffectiveRelayLimit(1, null)).toBe(1);
    expect(resolveEffectiveRelayLimit(3, null)).toBe(3);
  });

  it("la jornada puede RESTRINGIR más que la competencia", () => {
    expect(resolveEffectiveRelayLimit(3, 1)).toBe(1);
    expect(resolveEffectiveRelayLimit(2, 0)).toBe(0);
  });

  it("la jornada NO puede ampliar lo que definió la competencia", () => {
    expect(resolveEffectiveRelayLimit(1, 5)).toBe(1);
  });
});

describe("assertTestTypeMatches (hallazgo 8)", () => {
  const individual = { name: "Individual", swimmersCount: 1 };
  const relevo = { name: "Relevo", swimmersCount: 4 };

  it("acepta una inscripción individual en una prueba individual", () => {
    expect(() => assertTestTypeMatches(individual, 1, "individual")).not.toThrow();
  });

  it("RECHAZA una inscripción individual en una prueba de relevo", () => {
    expect(() => assertTestTypeMatches(relevo, 1, "individual")).toThrow(ValidationError);
    expect(() => assertTestTypeMatches(relevo, 1, "individual")).toThrow(/Relevo/);
  });

  it("la cantidad de integrantes de un relevo sale del catálogo, no de una constante", () => {
    expect(requiredRelayMembers(relevo)).toBe(4);
    // `requiredRelayMembers` solo mira `swimmersCount`: el nombre no es parte del contrato.
    expect(requiredRelayMembers({ swimmersCount: 6 })).toBe(6);
  });
});
