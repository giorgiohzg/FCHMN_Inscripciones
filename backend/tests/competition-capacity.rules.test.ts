/**
 * Cupos de nadadores — reglas puras.
 *
 * Lo que estas pruebas fijan, y que es el corazón del requisito: la unidad de
 * cupo es el NADADOR, no la prueba. De ahí salen los dos comportamientos que
 * más fácil se rompen al tocar el código:
 *
 *   - un nadador YA inscrito nunca choca contra el cupo, por lleno que esté;
 *   - un alta por lotes (un relevo) cabe entera o no cabe: no se admite a
 *     medias.
 */
import { describe, it, expect } from "vitest";
import { evaluateCapacity, shouldCloseRegistrations } from "../src/modules/competitions/competition-capacity.rules";

const SIN_LIMITES = { maxSwimmers: null, maxSwimmersPerClub: null };

describe("evaluateCapacity — sin límites configurados", () => {
  it("admite cualquier alta y nunca cierra", () => {
    const r = evaluateCapacity(SIN_LIMITES, { totalSwimmers: 9999, clubSwimmers: 9999 }, { newToCompetition: 4, newToClub: 4 });
    expect(r.allowed).toBe(true);
    expect(r.reachesGlobalLimit).toBe(false);
  });

  it("es el comportamiento de las competencias anteriores a los cupos", () => {
    // Una competencia migrada tiene ambos campos en NULL; nada debe cambiar.
    const r = evaluateCapacity(SIN_LIMITES, { totalSwimmers: 0, clubSwimmers: 0 }, { newToCompetition: 1, newToClub: 1 });
    expect(r.allowed).toBe(true);
  });
});

describe("evaluateCapacity — cupo global", () => {
  const limites = { maxSwimmers: 10, maxSwimmersPerClub: null };

  it("admite el alta que deja el cupo EXACTAMENTE lleno", () => {
    const r = evaluateCapacity(limites, { totalSwimmers: 9, clubSwimmers: 0 }, { newToCompetition: 1, newToClub: 1 });
    expect(r.allowed).toBe(true);
    expect(r.projectedTotal).toBe(10);
  });

  it("y ese alta es la que dispara el cierre automático", () => {
    const r = evaluateCapacity(limites, { totalSwimmers: 9, clubSwimmers: 0 }, { newToCompetition: 1, newToClub: 1 });
    expect(r.reachesGlobalLimit).toBe(true);
  });

  it("rechaza el alta que lo superaría por uno", () => {
    const r = evaluateCapacity(limites, { totalSwimmers: 10, clubSwimmers: 0 }, { newToCompetition: 1, newToClub: 1 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/cupo de 10 nadador/i);
    expect(r.reason).toMatch(/No quedan cupos/i);
  });

  it("un alta por lotes que NO cabe entera se rechaza entera", () => {
    // 8 de 10 usados, entra un relevo con 4 nadadores nuevos: no caben.
    const r = evaluateCapacity(limites, { totalSwimmers: 8, clubSwimmers: 0 }, { newToCompetition: 4, newToClub: 4 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Quedan 2 cupo\(s\).*necesita 4/i);
  });

  it("un alta por lotes que cabe justo se admite", () => {
    const r = evaluateCapacity(limites, { totalSwimmers: 6, clubSwimmers: 0 }, { newToCompetition: 4, newToClub: 4 });
    expect(r.allowed).toBe(true);
    expect(r.reachesGlobalLimit).toBe(true);
  });
});

describe("evaluateCapacity — un nadador ya inscrito no consume cupo", () => {
  it("con la competencia LLENA, sigue pudiendo inscribir otra prueba", () => {
    const r = evaluateCapacity(
      { maxSwimmers: 10, maxSwimmersPerClub: 3 },
      { totalSwimmers: 10, clubSwimmers: 3 },
      { newToCompetition: 0, newToClub: 0 }
    );
    expect(r.allowed).toBe(true);
  });

  it("un relevo cuyos 4 integrantes ya estaban inscritos cabe en una competencia llena", () => {
    const r = evaluateCapacity({ maxSwimmers: 4, maxSwimmersPerClub: null }, { totalSwimmers: 4, clubSwimmers: 4 }, { newToCompetition: 0, newToClub: 0 });
    expect(r.allowed).toBe(true);
  });

  it("pero un relevo con UN integrante nuevo en una competencia llena se rechaza", () => {
    const r = evaluateCapacity({ maxSwimmers: 4, maxSwimmersPerClub: null }, { totalSwimmers: 4, clubSwimmers: 4 }, { newToCompetition: 1, newToClub: 1 });
    expect(r.allowed).toBe(false);
  });
});

describe("evaluateCapacity — cupo por club", () => {
  const limites = { maxSwimmers: 100, maxSwimmersPerClub: 5 };

  it("rechaza al club que llegó a su tope, nombrándolo", () => {
    const r = evaluateCapacity(limites, { totalSwimmers: 20, clubSwimmers: 5 }, { newToCompetition: 1, newToClub: 1, clubName: "Club Delfines" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/Club Delfines/);
    expect(r.reason).toMatch(/cupo de 5 nadador/i);
    expect(r.reason).toMatch(/ya inscritos de este club pueden seguir/i);
  });

  it("no afecta a otros clubes: el mismo cupo global sigue teniendo sitio", () => {
    const r = evaluateCapacity(limites, { totalSwimmers: 20, clubSwimmers: 0 }, { newToCompetition: 1, newToClub: 1 });
    expect(r.allowed).toBe(true);
  });

  it("un nadador que ya está en la competencia con OTRO club sí consume cupo del club nuevo", () => {
    // No es nuevo para la competencia (0) pero sí para el club (1).
    const r = evaluateCapacity(limites, { totalSwimmers: 20, clubSwimmers: 5 }, { newToCompetition: 0, newToClub: 1 });
    expect(r.allowed).toBe(false);
  });

  it("cuando los dos cupos están llenos, el mensaje habla del global", () => {
    const r = evaluateCapacity({ maxSwimmers: 10, maxSwimmersPerClub: 5 }, { totalSwimmers: 10, clubSwimmers: 5 }, { newToCompetition: 1, newToClub: 1 });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/La competencia alcanzó su cupo/i);
  });
});

describe("shouldCloseRegistrations", () => {
  it("sin cupo global, nunca cierra", () => {
    expect(shouldCloseRegistrations(null, 10_000)).toBe(false);
  });

  it("cierra al alcanzarlo exactamente", () => {
    expect(shouldCloseRegistrations(10, 10)).toBe(true);
  });

  it("no cierra por debajo", () => {
    expect(shouldCloseRegistrations(10, 9)).toBe(false);
  });

  it("sigue cerrado si el cupo se REDUJO por debajo de lo ya inscrito", () => {
    // Es el caso de bajar el cupo a 5 con 8 nadadores ya inscritos: no se
    // borra a nadie, pero no entra nadie más y queda cerrada.
    expect(shouldCloseRegistrations(5, 8)).toBe(true);
  });
});
