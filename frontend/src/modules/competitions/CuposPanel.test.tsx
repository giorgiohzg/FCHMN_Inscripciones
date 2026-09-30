/**
 * El panel de cupos tiene que decir CUÁNTO QUEDA, no solo el tope.
 *
 * Sin eso, quien inscribe descubre que la competencia está llena al recibir
 * el error, después de haber preparado la inscripción. Estas pruebas fijan
 * los tres estados que el panel debe distinguir: sin límite, con sitio, y
 * completo.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CuposPanel } from "./CuposPanel";
import type { Competition, CompetitionCapacity } from "./competitionsApi";

function competencia(over: Partial<Competition> = {}): Competition {
  return {
    id: "c-1",
    name: "Copa",
    description: null,
    status: "open",
    registrationStartAt: "2030-01-01T00:00:00.000Z",
    registrationEndAt: "2030-02-01T00:00:00.000Z",
    ageCutoffDate: "2030-12-31",
    maxIndividualEventsPerSwimmer: 5,
    maxRelayEventsPerSwimmerPerSession: 1,
    maxSwimmers: null,
    maxSwimmersPerClub: null,
    poolId: null,
    dates: [],
    ...over,
  } as Competition;
}

function uso(over: Partial<CompetitionCapacity> = {}): CompetitionCapacity {
  return {
    maxSwimmers: null,
    maxSwimmersPerClub: null,
    totalSwimmers: 0,
    remainingSwimmers: null,
    isFull: false,
    byClub: [],
    ...over,
  };
}

describe("sin cupos configurados", () => {
  it("lo dice en una línea y no monta la sección completa", () => {
    render(<CuposPanel competition={competencia()} capacity={uso({ totalSwimmers: 12 })} />);
    expect(screen.getByText(/sin límite/i)).toBeTruthy();
    expect(screen.getByText(/12 nadador\(es\) inscrito\(s\)/i)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("aguanta que el uso no se haya podido cargar", () => {
    render(<CuposPanel competition={competencia()} capacity={null} />);
    expect(screen.getByText(/sin límite/i)).toBeTruthy();
  });
});

describe("cupo global", () => {
  it("muestra ocupados, tope y cuántos quedan", () => {
    render(
      <CuposPanel
        competition={competencia({ maxSwimmers: 50 })}
        capacity={uso({ maxSwimmers: 50, totalSwimmers: 30, remainingSwimmers: 20 })}
      />
    );
    expect(screen.getByText(/Total de la competencia/i)).toBeTruthy();
    expect(screen.getByText(/quedan 20/i)).toBeTruthy();

    const barra = screen.getByRole("progressbar");
    expect(barra.getAttribute("aria-valuenow")).toBe("30");
    expect(barra.getAttribute("aria-valuemax")).toBe("50");
  });

  it("cuando está completo avisa y dice exactamente qué hay que hacer", () => {
    render(
      <CuposPanel
        competition={competencia({ maxSwimmers: 10 })}
        capacity={uso({ maxSwimmers: 10, totalSwimmers: 10, remainingSwimmers: 0, isFull: true })}
      />
    );
    expect(screen.getByText(/Cupo completo/i)).toBeTruthy();
    expect(screen.getByText(/cerraron automáticamente/i)).toBeTruthy();

    /*
      El mensaje dice los DOS pasos —ampliar el cupo y reabrir— porque son
      actos distintos: guardar la competencia con un cupo mayor no la reabre.

      Antes decía "los ya inscritos pueden seguir gestionando sus pruebas".
      Se quitó porque es falso para un club: con las inscripciones cerradas
      solo puede operar un administrador con permiso post-cierre, también
      sobre nadadores que ya están dentro.
    */
    expect(screen.getByText(/amplíe el cupo/i)).toBeTruthy();
    expect(screen.getByText(/Reabrir inscripciones/i)).toBeTruthy();
    expect(screen.getByText(/guardar la competencia por sí solo no la reabre/i)).toBeTruthy();

    // Y no promete cupos que no existen.
    expect(screen.queryByText(/quedan /i)).toBeNull();
  });

  it("explica que la unidad de cuenta es el nadador, no la prueba", () => {
    render(<CuposPanel competition={competencia({ maxSwimmers: 10 })} capacity={uso({ totalSwimmers: 1 })} />);
    expect(screen.getByText(/nadadores distintos con inscripción activa, no la cantidad de pruebas/i)).toBeTruthy();
  });
});

describe("cupo por club", () => {
  it("lista cada club con sus inscritos y sus disponibles", () => {
    render(
      <CuposPanel
        competition={competencia({ maxSwimmersPerClub: 4 })}
        capacity={uso({
          maxSwimmersPerClub: 4,
          totalSwimmers: 6,
          byClub: [
            { clubId: "a", clubName: "Club Alfa", swimmers: 4, remaining: 0, isFull: true },
            { clubId: "b", clubName: "Club Beta", swimmers: 2, remaining: 2, isFull: false },
          ],
        })}
      />
    );
    expect(screen.getByText("Club Alfa")).toBeTruthy();
    expect(screen.getByText("Completo")).toBeTruthy();
    expect(screen.getByText("Club Beta")).toBeTruthy();
    expect(screen.getByText("2 / 4")).toBeTruthy();
  });

  it("sin clubes inscritos todavía, lo dice en vez de mostrar una tabla vacía", () => {
    render(<CuposPanel competition={competencia({ maxSwimmersPerClub: 4 })} capacity={uso({ maxSwimmersPerClub: 4 })} />);
    expect(screen.getByText(/Todavía no hay clubes con nadadores inscritos/i)).toBeTruthy();
  });
});
