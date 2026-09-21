import { describe, it, expect } from "vitest";
import { computeEffectiveStatus, evaluateCompetitionAction, isRegistrationOpen, recomputeStatusAfterEdit } from "../src/modules/competitions/competitions.rules";

const START = new Date("2026-06-01T00:00:00Z");
const END = new Date("2026-06-30T23:59:59Z");

describe("competitions.rules — computeEffectiveStatus", () => {
  it("mantiene 'scheduled' antes de la fecha de inicio de inscripción", () => {
    const now = new Date("2026-05-15T00:00:00Z");
    expect(computeEffectiveStatus("scheduled", START, END, now)).toBe("scheduled");
  });

  it("pasa automáticamente a 'open' al llegar la fecha de inicio", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    expect(computeEffectiveStatus("scheduled", START, END, now)).toBe("open");
  });

  it("se mantiene 'open' dentro del período de inscripción", () => {
    const now = new Date("2026-06-15T12:00:00Z");
    expect(computeEffectiveStatus("open", START, END, now)).toBe("open");
    expect(computeEffectiveStatus("scheduled", START, END, now)).toBe("open");
  });

  it("pasa automáticamente a 'closed' al superar la fecha de fin", () => {
    const now = new Date("2026-07-01T00:00:00Z");
    expect(computeEffectiveStatus("open", START, END, now)).toBe("closed");
  });

  it("una vez 'closed' no se reabre automáticamente aunque la fecha esté vigente", () => {
    // Cierre manual anticipado (excepción admin) — el cómputo automático no debe revertirlo.
    const now = new Date("2026-06-15T00:00:00Z"); // dentro del período
    expect(computeEffectiveStatus("closed", START, END, now)).toBe("closed");
  });

  it("nunca modifica estados manuales/terminales: draft, in_progress, finished, cancelled", () => {
    const now = new Date("2026-06-15T00:00:00Z"); // dentro del período de inscripción
    expect(computeEffectiveStatus("draft", START, END, now)).toBe("draft");
    expect(computeEffectiveStatus("in_progress", START, END, now)).toBe("in_progress");
    expect(computeEffectiveStatus("finished", START, END, now)).toBe("finished");
    expect(computeEffectiveStatus("cancelled", START, END, now)).toBe("cancelled");
  });
});

describe("competitions.rules — isRegistrationOpen", () => {
  it("solo el estado 'open' permite inscribir sin excepción", () => {
    expect(isRegistrationOpen("open")).toBe(true);
    expect(isRegistrationOpen("scheduled")).toBe(false);
    expect(isRegistrationOpen("closed")).toBe(false);
    expect(isRegistrationOpen("draft")).toBe(false);
  });
});

describe("competitions.rules — evaluateCompetitionAction", () => {
  it("permite programar (schedule) solo desde 'draft'", () => {
    expect(evaluateCompetitionAction("draft", "schedule").allowed).toBe(true);
    expect(evaluateCompetitionAction("open", "schedule").allowed).toBe(false);
  });

  it("permite cancelar desde cualquier estado no terminal", () => {
    for (const s of ["draft", "scheduled", "open", "closed", "in_progress"] as const) {
      expect(evaluateCompetitionAction(s, "cancel").allowed).toBe(true);
    }
  });

  it("rechaza cancelar una competencia ya finalizada o ya cancelada", () => {
    expect(evaluateCompetitionAction("finished", "cancel").allowed).toBe(false);
    expect(evaluateCompetitionAction("cancelled", "cancel").allowed).toBe(false);
  });

  it("permite cerrar inscripciones manualmente desde 'scheduled' u 'open'", () => {
    expect(evaluateCompetitionAction("scheduled", "closeRegistrations").allowed).toBe(true);
    expect(evaluateCompetitionAction("open", "closeRegistrations").allowed).toBe(true);
    expect(evaluateCompetitionAction("draft", "closeRegistrations").allowed).toBe(false);
  });

  it("exige inscripciones cerradas antes de iniciar la ejecución (start)", () => {
    expect(evaluateCompetitionAction("closed", "start").allowed).toBe(true);
    expect(evaluateCompetitionAction("open", "start").allowed).toBe(false);
  });

  it("solo permite finalizar desde 'in_progress'", () => {
    expect(evaluateCompetitionAction("in_progress", "finish").allowed).toBe(true);
    expect(evaluateCompetitionAction("closed", "finish").allowed).toBe(false);
  });
});

describe("competitions.rules — recomputeStatusAfterEdit (al editar fechas explícitamente)", () => {
  it("reabre a 'open' una competencia 'closed' si la nueva fecha de cierre queda en el futuro", () => {
    const now = new Date("2026-07-05T00:00:00Z"); // después del cierre original
    const newEnd = new Date("2026-07-31T23:59:59Z"); // se extiende a futuro
    expect(recomputeStatusAfterEdit("closed", START, newEnd, now)).toBe("open");
  });

  it("mantiene 'closed' si la nueva fecha de cierre sigue en el pasado", () => {
    const now = new Date("2026-07-05T00:00:00Z");
    expect(recomputeStatusAfterEdit("closed", START, END, now)).toBe("closed");
  });

  it("pasa a 'scheduled' si la nueva fecha de inicio queda en el futuro", () => {
    const now = new Date("2026-05-01T00:00:00Z");
    const newStart = new Date("2026-08-01T00:00:00Z");
    const newEnd = new Date("2026-08-31T23:59:59Z");
    expect(recomputeStatusAfterEdit("open", newStart, newEnd, now)).toBe("scheduled");
  });

  it("permite pasar de 'open' a 'closed' si se adelanta la fecha de cierre a una ya pasada", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    const newEnd = new Date("2026-06-10T00:00:00Z"); // se adelanta, ya pasó
    expect(recomputeStatusAfterEdit("open", START, newEnd, now)).toBe("closed");
  });

  it("NUNCA modifica un estado 'draft' — requiere la acción explícita 'Programar'", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    expect(recomputeStatusAfterEdit("draft", START, END, now)).toBe("draft");
  });

  it("NUNCA modifica un estado 'cancelled'", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    expect(recomputeStatusAfterEdit("cancelled", START, END, now)).toBe("cancelled");
  });

  it("NUNCA modifica un estado 'in_progress' ni 'finished'", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    expect(recomputeStatusAfterEdit("in_progress", START, END, now)).toBe("in_progress");
    expect(recomputeStatusAfterEdit("finished", START, END, now)).toBe("finished");
  });
});
