/**
 * «Generar reporte»: jerarquía competencia → club → nadador → fecha y jornada → pruebas en pantalla.
 *
 *  - La pantalla recorre la estructura del servidor (la misma de CSV, Excel y PDF) sin reagrupar,
 *    reordenar ni recontar: se comprueba con datos que ella ordenaría de otro modo.
 *  - Dos jornadas del mismo nombre en días distintos se ven separadas; los relevos, en su jornada.
 *  - Con una API anterior (sin `jornadas`) se conservan las listas de antes.
 * Interacción simulada con jsdom y servicios simulados, datos sintéticos; no es un navegador real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ReportsPage } from "./ReportsPage";
import type { ClubGroup, ClubGroupSwimmerRow, JornadaDelNadador, RegistrationsReportResult } from "./reportsApi";

vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: { id: "u-admin", username: "admin", ownerType: "system", personId: null, clubId: null, roles: ["admin"] },
      accessToken: "t",
      permissions: ["reports:read"],
      mustChangePassword: false,
      hasRole: (r: string) => r === "admin",
      hasPermission: () => false,
      restaurando: false,
      restauracionFallida: false,
      login: vi.fn(),
      logout: vi.fn(),
      changePassword: vi.fn(),
      reintentarRestauracion: vi.fn(),
    }),
  };
});
vi.mock("../competitions/competitionsApi", () => ({
  useCompetitionsApi: () => ({ list: async () => ({ items: [{ id: "comp-1", name: "CAMPEONATO SINTÉTICO", status: "open" }], total: 1, page: 1, pageSize: 100 }) }),
}));
vi.mock("../clubs/clubsApi", () => ({ useClubsApi: () => ({ list: vi.fn(), get: vi.fn() }) }));
vi.mock("../swimmer-assignment/assignmentApi", () => ({ useSwimmerAssignmentApi: () => ({ getCurrentClub: vi.fn(async () => null) }) }));

const getRegistrationsReport = vi.fn();
vi.mock("./reportsApi", () => ({
  useReportsApi: () => ({
    getRegistrationsReport,
    downloadExport: vi.fn(),
    downloadTeamManagerExport: vi.fn(),
    getClubesConInscripciones: async () => ({ clubs: [] }),
  }),
}));

const prueba = (numero: number | null, descripcion: string, tiempo: string | null = null, tipo: "individual" | "relevo" = "individual") => ({
  numero,
  tipo,
  descripcion,
  tiempo,
  tiempoTexto: tiempo ?? "Sin tiempo",
});
const jornada = (jornadaId: string, fecha: string, nombre: string, pruebas: JornadaDelNadador["pruebas"]): JornadaDelNadador => ({
  jornadaId,
  fecha,
  jornada: nombre,
  titulo: `${fecha} ${nombre}`,
  pruebas,
});

const ANA: ClubGroupSwimmerRow = {
  personId: "p-ana",
  nombreCompleto: "Ana Prueba Sintética",
  numero: 1,
  nombrePresentado: "PRUEBA SINTÉTICA, ANA",
  detalle: "(43) - Master D - Damas",
  edad: 43,
  categoria: "Master D",
  genero: "Damas",
  // Deliberadamente fuera de todo orden «natural»: la pantalla no debe tocarlo.
  jornadas: [
    jornada("s2", "07-01-2027", "Mañana", [prueba(8, "200m Combinado", "3:28,52"), prueba(5, "100m Pecho", "1:39,07")]),
    jornada("s1", "06-01-2027", "Mañana", [prueba(10, "100m Espalda"), prueba(2, "800m Libre", "13:03,08"), prueba(null, "50m Mariposa")]),
    jornada("s3", "06-01-2027", "Tarde", [prueba(9, "Relevo 200m Libre (Mixto)", "2:15,34", "relevo")]),
  ],
  pruebas: [],
  relevos: [],
};
const ELENA: ClubGroupSwimmerRow = {
  ...ANA,
  personId: "p-elena",
  numero: 2,
  nombrePresentado: "RELEVISTA ÚNICA, ELENA",
  jornadas: [jornada("s3", "06-01-2027", "Tarde", [prueba(9, "Relevo 200m Libre (Mixto)", "2:15,34", "relevo")])],
};
const CLUB: ClubGroup = {
  clubName: "CLUB DE PRUEBA",
  totalNadadores: 2,
  totalPruebasIndividuales: 5,
  totalRelevos: 1,
  totalesTexto: "2 nadadores, 5 pruebas individuales, 1 relevos",
  swimmers: [ANA, ELENA],
};
const informe = (clubes: ClubGroup[]): RegistrationsReportResult => ({ competitionName: "CAMPEONATO SINTÉTICO", individualRows: [], relayRows: [], groupedByClub: clubes });

async function generar(resultado: RegistrationsReportResult) {
  getRegistrationsReport.mockResolvedValue(resultado);
  render(
    <MemoryRouter>
      <ReportsPage />
    </MemoryRouter>
  );
  await screen.findByRole("option", { name: "CAMPEONATO SINTÉTICO" });
  fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "comp-1" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Generar reporte" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Generar reporte" }));
  await screen.findByRole("heading", { name: "CAMPEONATO SINTÉTICO" });
}

/** El grupo de filas de un nadador, a partir de su nombre. */
const grupo = (nombre: string, dentro: HTMLElement = document.body) => within(dentro).getByText(nombre).closest("tbody")!;
const titulo = (g: HTMLElement) => within(g).getByRole("rowheader").textContent;
/** Sus filas de pruebas, celda a celda: [jornada, prueba, tiempo, prueba, tiempo] (o vacía a la derecha). */
const filas = (g: HTMLElement) =>
  within(g)
    .getAllByRole("row")
    .filter((f) => !within(f).queryByRole("rowheader"))
    .map((f) => within(f).getAllByRole("cell").map((c) => (c.querySelector(".reporte-numero") ? Array.from(c.firstElementChild!.children, (x) => x.textContent).filter(Boolean).join(" ") : c.textContent)));

beforeEach(() => vi.clearAllMocks());

describe("jerarquía del reporte en pantalla", () => {
  it("competencia, club con totales, nadador numerado, y sus jornadas con las pruebas, tal como las entrega el servidor", async () => {
    await generar(informe([CLUB]));
    expect(screen.getByRole("heading", { name: /CLUB DE PRUEBA/ })).toHaveTextContent("CLUB DE PRUEBA (2 nadadores, 5 pruebas individuales, 1 relevos)");

    expect(within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Fecha y jornada", "Prueba", "Tiempo", "Prueba", "Tiempo"]);
    const ana = grupo("PRUEBA SINTÉTICA, ANA");
    expect(titulo(ana)).toBe("1. PRUEBA SINTÉTICA, ANA (43) - Master D - Damas");
    // De izquierda a derecha y siguiendo abajo; cada jornada por separado; con impar, la derecha vacía.
    expect(filas(ana)).toEqual([
      ["07-01-2027 Mañana", "8 200m Combinado", "3:28,52", "5 100m Pecho", "1:39,07"],
      ["06-01-2027 Mañana", "10 100m Espalda", "Sin tiempo", "2 800m Libre", "13:03,08"],
      ["06-01-2027 Mañana", "50m Mariposa", "Sin tiempo", ""],
      ["06-01-2027 Tarde", "9 Relevo 200m Libre (Mixto)", "2:15,34", ""],
    ]);
  });

  it("una, dos, tres y varias pruebas por jornada: todas, una vez y en el orden del servidor", async () => {
    for (const n of [1, 2, 3, 7]) {
      const pruebas = Array.from({ length: n }, (_, i) => prueba(i + 1, `${i + 1}00m Libre`, i % 2 ? null : `1:0${i},0${i}`));
      await generar(informe([{ ...CLUB, swimmers: [{ ...ANA, jornadas: [jornada("s1", "06-01-2027", "Mañana", pruebas)] }] }]));
      const leidas = filas(grupo("PRUEBA SINTÉTICA, ANA"));
      expect(leidas).toHaveLength(Math.ceil(n / 2));
      expect(leidas.every((f) => f[0] === "06-01-2027 Mañana")).toBe(true);
      expect(leidas.flatMap((f) => f.slice(1)).filter((c) => c !== "")).toEqual(pruebas.flatMap((p) => [`${p.numero} ${p.descripcion}`, p.tiempoTexto]));
      expect(leidas[leidas.length - 1]!.length).toBe(n % 2 ? 4 : 5);
      cleanup();
    }
  });

  it("en una columna la jornada se muestra una vez: las filas siguientes la llevan marcada como repetida", async () => {
    await generar(informe([CLUB]));
    const ana = grupo("PRUEBA SINTÉTICA, ANA");
    expect(Array.from(ana.querySelectorAll(".reporte-jornada"), (c) => [c.textContent, c.classList.contains("reporte-jornada-repetida")])).toEqual([
      ["07-01-2027 Mañana", false],
      ["06-01-2027 Mañana", false],
      ["06-01-2027 Mañana", true],
      ["06-01-2027 Tarde", false],
    ]);
  });

  it("quien solo participa en relevos tiene su línea y su jornada", async () => {
    await generar(informe([CLUB]));
    const elena = grupo("RELEVISTA ÚNICA, ELENA");
    expect(titulo(elena)).toBe("2. RELEVISTA ÚNICA, ELENA (43) - Master D - Damas");
    expect(filas(elena)).toEqual([["06-01-2027 Tarde", "9 Relevo 200m Libre (Mixto)", "2:15,34", ""]]);
  });

  it("no recalcula: usa el nombre, el detalle, el número y los totales del servidor", async () => {
    await generar(
      informe([{ ...CLUB, totalesTexto: "TOTALES DEL SERVIDOR", swimmers: [{ ...ANA, numero: 7, nombrePresentado: "NOMBRE DEL SERVIDOR", detalle: "DETALLE DEL SERVIDOR" }] }])
    );
    expect(screen.getByRole("heading", { name: /CLUB DE PRUEBA/ })).toHaveTextContent("(TOTALES DEL SERVIDOR)");
    expect(titulo(grupo("NOMBRE DEL SERVIDOR"))).toBe("7. NOMBRE DEL SERVIDOR DETALLE DEL SERVIDOR");
  });

  it("una misma persona en dos clubes, y dos clubes con el mismo nombre: cada bloque con lo suyo y claves sin repetir", async () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => {});
    const enA: ClubGroupSwimmerRow = { ...ANA, jornadas: [jornada("s1", "06-01-2027", "Mañana", [prueba(2, "800m Libre", "13:03,08")])] };
    const enB: ClubGroupSwimmerRow = { ...ANA, detalle: "(43) - Master E - Damas", jornadas: [jornada("s2", "07-01-2027", "Mañana", [prueba(5, "100m Pecho", "1:39,07")])] };
    const club = (clubId: string, s: ClubGroupSwimmerRow): ClubGroup => ({ ...CLUB, clubId, clubName: "CLUB HOMÓNIMO", swimmers: [s] });
    await generar(informe([club("club-a", enA), club("club-b", enB)]));

    const bloques = screen.getAllByRole("heading", { name: /CLUB HOMÓNIMO/ }).map((h) => h.parentElement!);
    expect(bloques.map((b) => [titulo(grupo("PRUEBA SINTÉTICA, ANA", b)), filas(grupo("PRUEBA SINTÉTICA, ANA", b))])).toEqual([
      ["1. PRUEBA SINTÉTICA, ANA (43) - Master D - Damas", [["06-01-2027 Mañana", "2 800m Libre", "13:03,08", ""]]],
      ["1. PRUEBA SINTÉTICA, ANA (43) - Master E - Damas", [["07-01-2027 Mañana", "5 100m Pecho", "1:39,07", ""]]],
    ]);
    expect(consola.mock.calls.filter((c) => String(c[0]).includes("same key"))).toEqual([]);
    consola.mockRestore();
  });

  it("transición: con una API anterior, sin jornadas, muestra las listas de antes", async () => {
    const anterior: ClubGroupSwimmerRow = {
      personId: "p-ana",
      nombreCompleto: "Ana Prueba Sintética",
      apellidoPaterno: "Prueba",
      apellidoMaterno: "Sintética",
      nombres: "Ana",
      edad: 43,
      categoria: "Master D",
      genero: "Damas",
      pruebas: [{ number: 2, text: "800m Libre 13:03,08" }],
      relevos: [{ number: 9, text: "Relevo 200m Libre (Mixto)" }],
    };
    await generar(informe([{ clubName: "CLUB DE PRUEBA", totalNadadores: 1, totalPruebasIndividuales: 1, totalRelevos: 1, swimmers: [anterior] }]));
    expect(screen.getByRole("heading", { name: /CLUB DE PRUEBA/ })).toHaveTextContent("(1 nadadores, 1 pruebas individuales, 1 relevos)");
    const ana = screen.getByText("PRUEBA SINTÉTICA, ANA").closest("div")!.parentElement!;
    expect(screen.queryByRole("table")).toBeNull();
    expect(ana.firstElementChild).toHaveTextContent("1. PRUEBA SINTÉTICA, ANA (43) - Master D - Damas");
    expect(ana).toHaveTextContent("800m Libre 13:03,08");
    expect(ana).toHaveTextContent("Relevo 200m Libre (Mixto)");
    expect(ana).not.toHaveTextContent(/\d{2}-\d{2}-\d{4}/);
  });
});
