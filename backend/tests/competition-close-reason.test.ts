/**
 * Cierre y reapertura de inscripciones — reglas puras.
 *
 * HISTORIA, porque explica el diseño actual.
 *
 * Primero, `recomputeStatusAfterEdit` reabría CUALQUIER competencia cerrada
 * en cuanto alguien la editaba con las fechas vigentes. Eso anulaba un cierre
 * manual por el mero hecho de renombrarla.
 *
 * Después se intentó distinguir la intención de la edición: "trae fechas",
 * "hay cupo libre". No resistió el payload real del formulario, que envía
 * siempre las dos fechas y el cupo se hayan tocado o no, ni la situación de
 * que alguien cancele una inscripción y deje sitio sin que nadie ampliara
 * nada.
 *
 * Conclusión: cuando la intención no se puede distinguir con fiabilidad, se
 * pide de forma explícita. Editar NUNCA reabre; reabrir es una acción propia
 * con sus propias condiciones.
 */
import { describe, it, expect } from "vitest";
import { recomputeStatusAfterEdit, evaluateReopenRegistrations, type RegistrationsCloseReason } from "../src/modules/competitions/competitions.rules";

const AHORA = new Date("2030-06-15T12:00:00.000Z");
const VIGENTE = { inicio: new Date("2030-06-01T00:00:00.000Z"), fin: new Date("2030-06-30T00:00:00.000Z") };
const VENCIDA = { inicio: new Date("2030-01-01T00:00:00.000Z"), fin: new Date("2030-01-31T00:00:00.000Z") };
const FUTURA = { inicio: new Date("2030-12-01T00:00:00.000Z"), fin: new Date("2030-12-31T00:00:00.000Z") };

const SIN_CUPO = { maxSwimmers: null, totalSwimmers: 40 };

describe("recomputeStatusAfterEdit — editar nunca reabre", () => {
  for (const causa of ["manual", "capacity", "schedule", null] as const) {
    it(`una competencia cerrada (causa ${causa ?? "null"}) sigue cerrada tras editarla`, () => {
      // La causa ya ni siquiera entra en la función: da igual por qué se
      // cerró, editar no la reabre.
      expect(recomputeStatusAfterEdit("closed", VIGENTE.inicio, VIGENTE.fin, AHORA)).toBe("closed");
    });
  }

  it("'open' con fechas vencidas SÍ pasa a 'closed': cerrar sigue siendo automático", () => {
    expect(recomputeStatusAfterEdit("open", VENCIDA.inicio, VENCIDA.fin, AHORA)).toBe("closed");
  });

  it("'scheduled' con fechas vigentes pasa a 'open'", () => {
    expect(recomputeStatusAfterEdit("scheduled", VIGENTE.inicio, VIGENTE.fin, AHORA)).toBe("open");
  });

  it("'open' con fechas futuras vuelve a 'scheduled'", () => {
    expect(recomputeStatusAfterEdit("open", FUTURA.inicio, FUTURA.fin, AHORA)).toBe("scheduled");
  });

  for (const estado of ["draft", "cancelled", "in_progress", "finished"] as const) {
    it(`'${estado}' no se toca`, () => {
      expect(recomputeStatusAfterEdit(estado, VIGENTE.inicio, VIGENTE.fin, AHORA)).toBe(estado);
    });
  }
});

describe("evaluateReopenRegistrations — la acción explícita", () => {
  function reabrir(
    estado: "draft" | "scheduled" | "open" | "closed" | "cancelled",
    causa: RegistrationsCloseReason | null,
    ventana: { inicio: Date; fin: Date },
    capacidad: { maxSwimmers: number | null; totalSwimmers: number }
  ) {
    return evaluateReopenRegistrations(estado, causa, ventana.inicio, ventana.fin, AHORA, capacidad);
  }

  it("solo se reabre lo que está cerrado", () => {
    const r = reabrir("open", null, VIGENTE, SIN_CUPO);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/solo se pueden reabrir.*cerrada/i);
  });

  it("no se reabre una competencia cancelada", () => {
    expect(reabrir("cancelled", null, VIGENTE, SIN_CUPO).allowed).toBe(false);
  });

  it("reabre con fechas vigentes y sin cupo alcanzado", () => {
    const r = reabrir("closed", "manual", VIGENTE, SIN_CUPO);
    expect(r.allowed).toBe(true);
    expect(r.nextStatus).toBe("open");
  });

  it("si las fechas aún no empiezan, reabre a 'scheduled'", () => {
    const r = reabrir("closed", "manual", FUTURA, SIN_CUPO);
    expect(r.allowed).toBe(true);
    expect(r.nextStatus).toBe("scheduled");
  });

  it("reabre cualquiera de las cuatro causas: la causa no decide, solo explica", () => {
    for (const causa of ["manual", "capacity", "schedule", null] as const) {
      expect(reabrir("closed", causa, VIGENTE, SIN_CUPO).allowed, `causa ${causa}`).toBe(true);
    }
  });

  describe("impedimento: el periodo de inscripción terminó", () => {
    it("se niega y pide extender la fecha", () => {
      const r = reabrir("closed", "manual", VENCIDA, SIN_CUPO);
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/periodo de inscripción terminó el 2030-01-31/i);
      expect(r.reason).toMatch(/Extienda la fecha de fin/i);
    });

    it("si además fue la fecha la que la cerró, lo dice", () => {
      const r = reabrir("closed", "schedule", VENCIDA, SIN_CUPO);
      expect(r.reason).toMatch(/vencimiento de esa fecha lo que la cerró/i);
    });

    it("no lo dice si la cerró otra cosa", () => {
      const r = reabrir("closed", "manual", VENCIDA, SIN_CUPO);
      expect(r.reason).not.toMatch(/vencimiento de esa fecha/i);
    });
  });

  /**
   * CAMBIO DE COMPORTAMIENTO, deliberado.
   *
   * Antes, reabrir con el cupo alcanzado se NEGABA y obligaba a ampliar el
   * cupo primero. Desde que existe el estado «Inscripciones individuales
   * cerradas» hay una respuesta mejor y más fiel a lo que el administrador
   * pidió: se reabren los RELEVOS —que no consumen cupo, porque se forman con
   * nadadores que ya lo ocupan— y las individuales siguen cerradas.
   *
   * Sigue siendo una acción explícita: no se llega aquí cancelando una
   * inscripción ni editando el cupo.
   */
  describe("el cupo sigue alcanzado: reabre en cierre PARCIAL, no se niega", () => {
    it("habilita los relevos y explica que las individuales siguen cerradas", () => {
      const r = reabrir("closed", "manual", VIGENTE, { maxSwimmers: 10, totalSwimmers: 10 });
      expect(r.allowed).toBe(true);
      expect(r.nextStatus).toBe("individual_closed");
      expect(r.reason).toMatch(/10 nadador\(es\) inscrito\(s\).*cupo es de 10/i);
      expect(r.reason).toMatch(/Se reabrieron los relevos/i);
      expect(r.reason).toMatch(/individuales siguen cerradas/i);
      expect(r.reason).toMatch(/Amplíe el cupo/i);
      expect(r.reason).toMatch(/nunca elimina inscripciones/i);
    });

    it("también si el cupo se redujo por debajo de lo inscrito", () => {
      const r = reabrir("closed", "capacity", VIGENTE, { maxSwimmers: 5, totalSwimmers: 8 });
      expect(r.allowed).toBe(true);
      expect(r.nextStatus).toBe("individual_closed");
    });

    it("con el cupo ampliado por encima de lo inscrito, ya se puede", () => {
      const r = reabrir("closed", "capacity", VIGENTE, { maxSwimmers: 50, totalSwimmers: 10 });
      expect(r.allowed).toBe(true);
      expect(r.nextStatus).toBe("open");
    });

    it("sin cupo configurado, nunca es un impedimento", () => {
      expect(reabrir("closed", "capacity", VIGENTE, { maxSwimmers: null, totalSwimmers: 9999 }).allowed).toBe(true);
    });
  });

  it("la fecha vencida se informa ANTES que el cupo: es el impedimento más básico", () => {
    const r = reabrir("closed", "capacity", VENCIDA, { maxSwimmers: 10, totalSwimmers: 10 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/periodo de inscripción terminó/i);
  });
});
