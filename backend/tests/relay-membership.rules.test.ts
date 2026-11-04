/**
 * Invariante: todo integrante de un relevo confirmado tiene al menos una
 * inscripción individual confirmada en la misma competencia.
 *
 * Tiene DOS lados, y comprobar solo uno la deja rota: se valida al formar o
 * cambiar el equipo, y se impide cancelar la última individual de alguien que
 * integra un relevo confirmado. Sin el segundo lado, la regla se cumple en el
 * instante del alta y deja de cumplirse cinco minutos después.
 */
import { describe, it, expect } from "vitest";
import {
  evaluarElegibilidadDeIntegrantes,
  evaluarCancelacionDeIndividual,
  contarEquiposIncumplidores,
} from "../src/modules/relay-registrations/relay-membership.rules";

const ana = { personId: "p-ana", displayName: "Ana Ruiz (1-9)" };
const beto = { personId: "p-beto", displayName: "Beto Lagos (2-7)" };
const cora = { personId: "p-cora", displayName: "Cora Díaz (3-5)" };
const dino = { personId: "p-dino", displayName: "Dino Paz (4-3)" };

describe("elegibilidad de los integrantes", () => {
  it("acepta un equipo cuyos cuatro integrantes ya nadan individualmente", () => {
    const r = evaluarElegibilidadDeIntegrantes(
      [ana, beto, cora, dino],
      new Set(["p-ana", "p-beto", "p-cora", "p-dino"]),
      true
    );
    expect(r.ok).toBe(true);
    expect(r.sinInscripcionIndividual).toEqual([]);
  });

  it("rechaza si UNO no tiene inscripción individual, y lo nombra", () => {
    const r = evaluarElegibilidadDeIntegrantes(
      [ana, beto, cora, dino],
      new Set(["p-ana", "p-beto", "p-dino"]),
      true
    );
    expect(r.ok).toBe(false);
    expect(r.sinInscripcionIndividual).toEqual(["p-cora"]);
    expect(r.reason).toContain("Cora Díaz");
    // No debe delatar a quienes sí cumplen.
    expect(r.reason).not.toContain("Ana Ruiz");
  });

  it("nombra a TODOS los que faltan, no solo al primero", () => {
    const r = evaluarElegibilidadDeIntegrantes([ana, beto, cora, dino], new Set(["p-ana"]), true);
    expect(r.sinInscripcionIndividual).toEqual(["p-beto", "p-cora", "p-dino"]);
    for (const nombre of ["Beto Lagos", "Cora Díaz", "Dino Paz"]) {
      expect(r.reason, nombre).toContain(nombre);
    }
  });

  it("dice qué hacer, no solo que está mal", () => {
    const r = evaluarElegibilidadDeIntegrantes([ana], new Set(), true);
    expect(r.reason).toMatch(/Inscríbalos primero/i);
    expect(r.reason).toMatch(/cámbielos por otros/i);
  });

  it("con nadie inscrito rechaza a los cuatro", () => {
    const r = evaluarElegibilidadDeIntegrantes([ana, beto, cora, dino], new Set(), true);
    expect(r.sinInscripcionIndividual).toHaveLength(4);
  });

  it("conserva el orden recibido, que es el de las postas", () => {
    const r = evaluarElegibilidadDeIntegrantes([dino, cora, beto, ana], new Set(), true);
    expect(r.sinInscripcionIndividual).toEqual(["p-dino", "p-cora", "p-beto", "p-ana"]);
  });

  it("un equipo vacío no incumple nada: de la cantidad se encarga otra regla", () => {
    expect(evaluarElegibilidadDeIntegrantes([], new Set(), true).ok).toBe(true);
  });
});

describe("cancelación de la última inscripción individual", () => {
  const relevo = { relayRegistrationId: "rr-1", descripcion: "200m Libre" };
  const otroRelevo = { relayRegistrationId: "rr-2", descripcion: "200m Combinado" };

  it("permite cancelar si al nadador le quedan otras individuales", () => {
    expect(evaluarCancelacionDeIndividual(2, [relevo], true).allowed).toBe(true);
  });

  it("permite cancelar la última si no integra ningún relevo", () => {
    expect(evaluarCancelacionDeIndividual(0, [], true).allowed).toBe(true);
  });

  it("RECHAZA cancelar la última si integra un relevo confirmado", () => {
    const r = evaluarCancelacionDeIndividual(0, [relevo], true);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/última inscripción individual confirmada/i);
    expect(r.reason).toContain("200m Libre");
  });

  it("nombra todos los relevos afectados y cuántos son", () => {
    const r = evaluarCancelacionDeIndividual(0, [relevo, otroRelevo], true);
    expect(r.reason).toMatch(/2 relevo/);
    expect(r.reason).toContain("200m Libre");
    expect(r.reason).toContain("200m Combinado");
  });

  it("deja claro que el sistema NO arregla nada por su cuenta", () => {
    /**
     * Es la parte que evita el daño peor. Eliminar el relevo o quitar al
     * integrante sería "resolver" el conflicto destruyendo datos que nadie
     * pidió borrar; elegir entre las dos salidas es del usuario.
     */
    const r = evaluarCancelacionDeIndividual(0, [relevo], true);
    expect(r.reason).toMatch(/Retire al nadador de esos equipos/i);
    expect(r.reason).toMatch(/no los modifica por su cuenta/i);
  });

  it("el límite exacto está en 'una más': con 1 se permite, con 0 no", () => {
    expect(evaluarCancelacionDeIndividual(1, [relevo], true).allowed).toBe(true);
    expect(evaluarCancelacionDeIndividual(0, [relevo], true).allowed).toBe(false);
  });
});

describe("CONDICIÓN APAGADA (Competition.requireIndividualForRelay = false)", () => {
  it("cualquier integrante es elegible, tenga o no individual", () => {
    const r = evaluarElegibilidadDeIntegrantes([ana, beto, cora, dino], new Set(), false);
    expect(r).toEqual({ ok: true, sinInscripcionIndividual: [] });
  });

  it("cancelar la última individual de quien integra un relevo NO se bloquea", () => {
    const relevo = { relayRegistrationId: "r1", descripcion: "200m Libre" };
    expect(evaluarCancelacionDeIndividual(0, [relevo], false).allowed).toBe(true);
    // Y activada, el mismo caso se rechaza: lo único que cambió es el interruptor.
    expect(evaluarCancelacionDeIndividual(0, [relevo], true).allowed).toBe(false);
  });

  it("el administrador no tiene un trato distinto: la función ni lo recibe", () => {
    expect(evaluarElegibilidadDeIntegrantes([ana], new Set(), true).ok).toBe(false);
  });
});

describe("contarEquiposIncumplidores — equipos distintos, no integrantes", () => {
  const equipo = (id: string, ...personIds: string[]) => ({ relayRegistrationId: id, personIds });

  it("sin equipos o con todos cumpliendo: 0", () => {
    expect(contarEquiposIncumplidores([], new Set())).toBe(0);
    expect(contarEquiposIncumplidores([equipo("e1", "a", "b")], new Set(["a", "b"]))).toBe(0);
  });

  it("VARIOS integrantes incumplidores del MISMO equipo cuentan UNA vez", () => {
    expect(contarEquiposIncumplidores([equipo("e1", "a", "b", "c", "d")], new Set(["a"]))).toBe(1);
  });

  it("cuenta cada equipo incumplidor, y no los que cumplen", () => {
    const equipos = [equipo("e1", "a", "b"), equipo("e2", "a", "c"), equipo("e3", "b", "c"), equipo("e4", "d", "e")];
    // Con individual: a y b. e1 cumple; e2 (c), e3 (c) y e4 (d, e) incumplen.
    expect(contarEquiposIncumplidores(equipos, new Set(["a", "b"]))).toBe(3);
  });

  it("un nadador en dos equipos incumplidores hace incumplir a los dos", () => {
    expect(contarEquiposIncumplidores([equipo("e1", "x", "a"), equipo("e2", "x", "b")], new Set(["a", "b"]))).toBe(2);
  });
});
