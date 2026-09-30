/**
 * Estado «Inscripciones individuales cerradas» — la matriz completa.
 *
 * La regla de fondo, de la que cuelga todo lo demás: **un cupo lleno cierra
 * las inscripciones individuales, no la competencia**. Los relevos se forman
 * con nadadores que ya ocupan cupo, así que no consumen ninguno y no hay
 * motivo para bloquearlos.
 *
 * Y la segunda, que es la que más fácil se rompe al tocar el código: de este
 * estado **no se sale solo**. Ni cancelando una inscripción, ni ampliando el
 * cupo, ni editando cualquier otro campo. Solo cerrando del todo —a mano o por
 * vencimiento— o reabriendo de forma explícita.
 */
import { describe, it, expect } from "vitest";
import {
  computeEffectiveStatus,
  recomputeStatusAfterEdit,
  evaluateReopenRegistrations,
  evaluateRegistrationWindow,
  evaluateCompetitionAction,
  isRegistrationOpen,
  isRelayRegistrationOpen,
  individualRegistrationsClosed,
  type CompetitionStatus,
} from "../src/modules/competitions/competitions.rules";

const INICIO = new Date("2026-03-01T00:00:00Z");
const FIN = new Date("2026-03-31T23:59:59Z");
const DENTRO = new Date("2026-03-15T12:00:00Z");
const ANTES = new Date("2026-02-01T12:00:00Z");
const DESPUES = new Date("2026-04-05T12:00:00Z");

const LLENO = { maxSwimmers: 10, totalSwimmers: 10 };
const EXCEDIDO = { maxSwimmers: 10, totalSwimmers: 13 };
const CON_SITIO = { maxSwimmers: 10, totalSwimmers: 4 };
const SIN_CUPO = { maxSwimmers: null, totalSwimmers: 99 };

describe("el cierre parcial solo avanza, nunca retrocede", () => {
  it("dentro de la ventana se queda donde está", () => {
    expect(computeEffectiveStatus("individual_closed", INICIO, FIN, DENTRO)).toBe("individual_closed");
  });

  it("al vencer la fecha pasa a cerrada del todo", () => {
    expect(computeEffectiveStatus("individual_closed", INICIO, FIN, DESPUES)).toBe("closed");
  });

  it("antes de que empiece la ventana tampoco vuelve a 'scheduled'", () => {
    // No debería ocurrir —no se llena una competencia que no ha abierto— pero
    // si ocurriera, retroceder sería peor que quedarse quieto.
    expect(computeEffectiveStatus("individual_closed", INICIO, FIN, ANTES)).toBe("individual_closed");
  });

  it("una edición dentro de la ventana NO lo reabre", () => {
    /**
     * Es la trampa del estado: bastaba con añadirlo a la lista de
     * recalculables para que el cierre por fecha funcionara, y a cambio
     * cualquier edición —ampliar el cupo, corregir el nombre— lo habría
     * devuelto a 'open'.
     */
    expect(recomputeStatusAfterEdit("individual_closed", INICIO, FIN, DENTRO)).toBe("individual_closed");
  });

  it("una edición con la fecha vencida sí lo cierra del todo", () => {
    expect(recomputeStatusAfterEdit("individual_closed", INICIO, FIN, DESPUES)).toBe("closed");
  });
});

describe("qué está abierto en cada estado", () => {
  const casos: Array<[CompetitionStatus, boolean, boolean]> = [
    // estado,             individuales, relevos
    ["open", true, true],
    ["individual_closed", false, true],
    ["closed", false, false],
    ["draft", false, false],
    ["scheduled", false, false],
    ["in_progress", false, false],
    ["finished", false, false],
    ["cancelled", false, false],
  ];

  for (const [estado, individuales, relevos] of casos) {
    it(`${estado}: individuales=${individuales}, relevos=${relevos}`, () => {
      expect(isRegistrationOpen(estado), "individuales").toBe(individuales);
      expect(isRelayRegistrationOpen(estado), "relevos").toBe(relevos);
      expect(individualRegistrationsClosed(estado)).toBe(!individuales);
    });
  }

  it("el cierre parcial es el ÚNICO estado donde difieren", () => {
    const difieren = casos.filter(([, ind, rel]) => ind !== rel).map(([e]) => e);
    expect(difieren).toEqual(["individual_closed"]);
  });
});

describe("permisos por estado, rol y tipo de inscripción", () => {
  const NO_ADMIN = false;
  const ADMIN = true;

  it("en cierre parcial, un club NO puede tocar individuales — ni de nadadores ya inscritos", () => {
    for (const op of ["create", "update", "cancel"] as const) {
      const r = evaluateRegistrationWindow("individual_closed", op, NO_ADMIN, "individual");
      expect(r.allowed, op).toBe(false);
      expect(r.reason, op).toMatch(/cupo de nadadores/i);
      // El mensaje debe señalar la salida que sí existe.
      expect(r.reason, op).toMatch(/relevos siguen disponibles/i);
    }
  });

  it("en cierre parcial, un club SÍ puede crear, editar y cancelar relevos", () => {
    for (const op of ["create", "update", "cancel"] as const) {
      const r = evaluateRegistrationWindow("individual_closed", op, NO_ADMIN, "relay");
      expect(r.allowed, op).toBe(true);
      // Y NO es una excepción: es operación corriente de este estado.
      expect(r.isPostCloseException, op).toBe(false);
    }
  });

  it("en cierre total, un club no puede nada — ni individuales ni relevos", () => {
    for (const kind of ["individual", "relay"] as const) {
      for (const op of ["create", "update", "cancel"] as const) {
        const r = evaluateRegistrationWindow("closed", op, NO_ADMIN, kind);
        expect(r.allowed, `${kind}/${op}`).toBe(false);
      }
    }
  });

  it("un administrador opera en los dos estados de cierre, marcado como excepción", () => {
    for (const estado of ["individual_closed", "closed"] as const) {
      for (const kind of ["individual", "relay"] as const) {
        const r = evaluateRegistrationWindow(estado, "create", ADMIN, kind);
        expect(r.allowed, `${estado}/${kind}`).toBe(true);
        // Salvo el relevo en cierre parcial, que es operación normal para
        // todos y por eso no se marca.
        const esperadoExcepcion = !(estado === "individual_closed" && kind === "relay");
        expect(r.isPostCloseException, `${estado}/${kind}`).toBe(esperadoExcepcion);
      }
    }
  });

  it("con la competencia abierta nada es excepción", () => {
    for (const kind of ["individual", "relay"] as const) {
      const r = evaluateRegistrationWindow("open", "create", NO_ADMIN, kind);
      expect(r.allowed).toBe(true);
      expect(r.isPostCloseException).toBe(false);
    }
  });

  it("ni el administrador opera en borrador, en ejecución, finalizada o cancelada", () => {
    for (const estado of ["draft", "scheduled", "in_progress", "finished", "cancelled"] as const) {
      for (const kind of ["individual", "relay"] as const) {
        expect(evaluateRegistrationWindow(estado, "create", ADMIN, kind).allowed, `${estado}/${kind}`).toBe(false);
      }
    }
  });

  it("sin indicar el tipo se comporta como individual, que es lo que era antes", () => {
    expect(evaluateRegistrationWindow("individual_closed", "create", NO_ADMIN).allowed).toBe(false);
  });
});

describe("reapertura: siempre explícita, y con el cupo lleno aterriza en el cierre parcial", () => {
  it("desde 'closed' con el cupo lleno reabre los RELEVOS, no las individuales", () => {
    const r = evaluateReopenRegistrations("closed", "manual", INICIO, FIN, DENTRO, LLENO);
    expect(r.allowed).toBe(true);
    expect(r.nextStatus).toBe("individual_closed");
    expect(r.reason).toMatch(/relevos/i);
    expect(r.reason).toMatch(/individuales siguen cerradas/i);
  });

  it("desde 'closed' con el cupo EXCEDIDO por un administrador, igual", () => {
    const r = evaluateReopenRegistrations("closed", "capacity", INICIO, FIN, DENTRO, EXCEDIDO);
    expect(r.allowed).toBe(true);
    expect(r.nextStatus).toBe("individual_closed");
  });

  it("desde 'closed' con sitio libre reabre del todo", () => {
    const r = evaluateReopenRegistrations("closed", "manual", INICIO, FIN, DENTRO, CON_SITIO);
    expect(r.allowed).toBe(true);
    expect(r.nextStatus).toBe("open");
  });

  it("sin cupo configurado reabre del todo por muchos inscritos que haya", () => {
    const r = evaluateReopenRegistrations("closed", "manual", INICIO, FIN, DENTRO, SIN_CUPO);
    expect(r.allowed).toBe(true);
    expect(r.nextStatus).toBe("open");
  });

  it("desde el cierre parcial también se puede reabrir, si hay sitio", () => {
    const r = evaluateReopenRegistrations("individual_closed", "capacity", INICIO, FIN, DENTRO, CON_SITIO);
    expect(r.allowed).toBe(true);
    expect(r.nextStatus).toBe("open");
  });

  it("con la fecha vencida no se reabre nada, y dice qué corregir", () => {
    for (const estado of ["closed", "individual_closed"] as const) {
      const r = evaluateReopenRegistrations(estado, "schedule", INICIO, FIN, DESPUES, CON_SITIO);
      expect(r.allowed, estado).toBe(false);
      expect(r.reason, estado).toMatch(/Extienda la fecha de fin/i);
    }
  });

  it("antes de que empiece la ventana vuelve a 'scheduled', aunque el cupo esté lleno", () => {
    // Todavía no hay nada que habilitar; cuando abra, el cierre por cupo
    // volverá a actuar si sigue lleno.
    const r = evaluateReopenRegistrations("closed", "capacity", INICIO, FIN, ANTES, LLENO);
    expect(r.allowed).toBe(true);
    expect(r.nextStatus).toBe("scheduled");
  });

  it("no se reabre lo que no está cerrado", () => {
    for (const estado of ["open", "draft", "scheduled", "in_progress", "finished", "cancelled"] as const) {
      expect(evaluateReopenRegistrations(estado, null, INICIO, FIN, DENTRO, CON_SITIO).allowed, estado).toBe(false);
    }
  });
});

describe("acciones de competencia desde el cierre parcial", () => {
  it("se puede cerrar del todo a mano", () => {
    const r = evaluateCompetitionAction("individual_closed", "closeRegistrations");
    expect(r.allowed).toBe(true);
    expect(r.nextStatus).toBe("closed");
  });

  it("se puede cancelar", () => {
    expect(evaluateCompetitionAction("individual_closed", "cancel").allowed).toBe(true);
  });

  it("NO se puede iniciar la ejecución: los relevos siguen abiertos", () => {
    const r = evaluateCompetitionAction("individual_closed", "start");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/relevos siguen abiertos/i);
    expect(r.reason).toMatch(/Cierre las inscripciones por completo/i);
  });

  it("desde 'closed' sí se puede iniciar", () => {
    expect(evaluateCompetitionAction("closed", "start").allowed).toBe(true);
  });

  it("no se puede programar desde el cierre parcial", () => {
    expect(evaluateCompetitionAction("individual_closed", "schedule").allowed).toBe(false);
  });
});
