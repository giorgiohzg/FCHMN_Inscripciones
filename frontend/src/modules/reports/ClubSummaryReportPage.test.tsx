/**
 * Reportes: resumen de inscripciones por club (solo administración).
 *
 * Carga, vacío, errores, tabla y totales, exportación de Team Manager por fila, respuestas
 * tardías y pérdida del rol. Interacción simulada con jsdom y servicios simulados, datos
 * sintéticos; no es una revisión visual ni un navegador real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ClubSummaryReportPage } from "./ClubSummaryReportPage";
import { ApiError } from "../../shared/apiClient";
import type { ResumenPorClub } from "./reportsApi";

let roles: string[] = ["admin"];

vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: { id: "u-admin", username: "admin", ownerType: "system", personId: null, clubId: null, roles },
      accessToken: "t",
      permissions: ["reports:read", "export:team-manager"],
      mustChangePassword: false,
      hasRole: (r: string) => roles.includes(r),
      hasPermission: (p: string) => roles.includes("admin") && ["reports:read", "export:team-manager"].includes(p),
      restaurando: false,
      restauracionFallida: false,
      login: vi.fn(),
      logout: vi.fn(),
      changePassword: vi.fn(),
      reintentarRestauracion: vi.fn(),
    }),
  };
});

const competitionsList = vi.fn(async (_p?: Record<string, unknown>) => ({
  items: [
    { id: "comp-1", name: "Competencia Uno", status: "open", dates: [] },
    { id: "comp-2", name: "Competencia Oculta", status: "draft", dates: [] },
    { id: "comp-vacia", name: "Competencia Vacía", status: "open", dates: [] },
  ],
  total: 3,
  page: 1,
  pageSize: 100,
}));
const getResumenPorClub = vi.fn();
const downloadTeamManagerExport = vi.fn(async (_c: string, _club: string) => undefined);

vi.mock("../competitions/competitionsApi", () => ({ useCompetitionsApi: () => ({ list: competitionsList }) }));
vi.mock("./reportsApi", () => ({ useReportsApi: () => ({ getResumenPorClub, downloadTeamManagerExport }) }));

const fila = (clubId: string, clubName: string, v: number, d: number, ind: number, rel: number) => ({
  clubId,
  clubName,
  varones: v,
  damas: d,
  totalNadadores: v + d,
  pruebasIndividuales: ind,
  relevos: rel,
  totalPruebas: ind + rel,
});

const RESUMEN_UNO: ResumenPorClub = {
  competitionId: "comp-1",
  competitionName: "Competencia Uno",
  clubs: [fila("club-a", "Club Alfa", 2, 3, 3, 2), fila("club-h1", "Club Homónimo", 1, 0, 1, 0), fila("club-h2", "Club Homónimo", 0, 2, 2, 0)],
  totales: { varones: 3, damas: 5, totalNadadores: 8, pruebasIndividuales: 6, relevos: 2, totalPruebas: 8 },
};
const RESUMEN_OCULTA: ResumenPorClub = {
  competitionId: "comp-2",
  competitionName: "Competencia Oculta",
  clubs: [fila("club-r", "Club Solo Relevos", 2, 2, 0, 1)],
  totales: { varones: 2, damas: 2, totalNadadores: 4, pruebasIndividuales: 0, relevos: 1, totalPruebas: 1 },
};
const VACIO: ResumenPorClub = {
  competitionId: "comp-vacia",
  competitionName: "Competencia Vacía",
  clubs: [],
  totales: { varones: 0, damas: 0, totalNadadores: 0, pruebasIndividuales: 0, relevos: 0, totalPruebas: 0 },
};
const POR_ID: Record<string, ResumenPorClub> = { "comp-1": RESUMEN_UNO, "comp-2": RESUMEN_OCULTA, "comp-vacia": VACIO };

function diferida<T>() {
  let resolver!: (v: T) => void;
  let rechazar!: (e: unknown) => void;
  const promesa = new Promise<T>((res, rej) => {
    resolver = res;
    rechazar = rej;
  });
  return { promesa, resolver, rechazar };
}

function montar() {
  const vista = render(
    <MemoryRouter>
      <ClubSummaryReportPage />
    </MemoryRouter>
  );
  return vista;
}

const selector = () => screen.getByLabelText("Competencia") as HTMLSelectElement;
const elegir = (id: string) => fireEvent.change(selector(), { target: { value: id } });
const filas = () => within(screen.getByRole("table")).getAllByRole("row");
const celdas = (tr: HTMLElement) => Array.from(tr.querySelectorAll("th, td")).map((c) => c.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  roles = ["admin"];
  getResumenPorClub.mockImplementation(async (id: string) => POR_ID[id]);
  downloadTeamManagerExport.mockImplementation(async () => undefined);
});

describe("selección y estados", () => {
  it("lista todas las competencias (también las ocultas) y pide elegir una", async () => {
    montar();
    expect(await screen.findByRole("option", { name: "Competencia Oculta" })).toBeInTheDocument();
    // Administración no filtra por visibilidad: no se envía el parámetro.
    expect(competitionsList.mock.calls[0]![0]).not.toHaveProperty("visibleInRegistrationPanels");
    expect(screen.getByText("Seleccione una competencia para ver el resumen.")).toBeInTheDocument();
    expect(getResumenPorClub).not.toHaveBeenCalled();
  });

  it("muestra la carga mientras llega el resumen", async () => {
    const pendiente = diferida<ResumenPorClub>();
    getResumenPorClub.mockReturnValueOnce(pendiente.promesa);
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    elegir("comp-1");
    expect(screen.getByRole("status")).toHaveTextContent("Cargando resumen…");
    await act(async () => pendiente.resolver(RESUMEN_UNO));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("competencia sin inscritos: mensaje propio, sin tabla", async () => {
    montar();
    await screen.findByRole("option", { name: "Competencia Vacía" });
    elegir("comp-vacia");
    expect(await screen.findByText("La competencia no tiene inscripciones confirmadas.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("error del servidor: se informa y no queda tabla", async () => {
    getResumenPorClub.mockRejectedValueOnce(new ApiError("Error interno del servidor", 500));
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    elegir("comp-1");
    expect(await screen.findByRole("alert")).toHaveTextContent("Error interno del servidor");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("403 (la sesión perdió administración en el servidor): mensaje de acceso, sin datos", async () => {
    getResumenPorClub.mockRejectedValueOnce(new ApiError("Requiere uno de los siguientes roles: admin", 403));
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    elegir("comp-1");
    expect(await screen.findByRole("alert")).toHaveTextContent("Este reporte es exclusivo de administración.");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("tabla y totales", () => {
  it("una fila por club (homónimos separados), con sus cifras, y la fila de totales", async () => {
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    elegir("comp-1");
    await screen.findByRole("table");

    const [encabezado, ...resto] = filas();
    expect(within(encabezado!).getAllByRole("columnheader").map((c) => c.textContent)).toEqual([
      "Club",
      "Varones",
      "Damas",
      "Total nadadores",
      "Pruebas individuales",
      "Relevos",
      "Total pruebas",
      "Team Manager",
    ]);
    expect(resto).toHaveLength(4); // tres clubes + totales
    expect(celdas(resto[0]!).slice(0, 7)).toEqual(["Club Alfa", "2", "3", "5", "3", "2", "5"]);
    expect(celdas(resto[1]!).slice(0, 7)).toEqual(["Club Homónimo", "1", "0", "1", "1", "0", "1"]);
    expect(celdas(resto[2]!).slice(0, 7)).toEqual(["Club Homónimo", "0", "2", "2", "2", "0", "2"]);
    expect(celdas(resto[3]!).slice(0, 7)).toEqual(["Total", "3", "5", "8", "6", "2", "8"]);
  });

  it("la tabla se desplaza dentro de su contenedor en pantallas angostas", async () => {
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    elegir("comp-1");
    const tabla = await screen.findByRole("table");
    expect(tabla.parentElement).toHaveStyle({ overflowX: "auto" });
  });
});

describe("exportación a Team Manager por fila", () => {
  it("cada botón descarga el ZIP de SU club, también entre homónimos", async () => {
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    elegir("comp-1");
    await screen.findByRole("table");

    const botones = screen.getAllByRole("button", { name: /Exportar a Team Manager \(\.zip\)/ });
    expect(botones).toHaveLength(3);
    fireEvent.click(botones[2]!);
    await waitFor(() => expect(downloadTeamManagerExport).toHaveBeenCalledWith("comp-1", "club-h2"));
    expect(downloadTeamManagerExport).toHaveBeenCalledTimes(1);
  });

  it("una fila generando no bloquea a las demás, y el error queda en su fila", async () => {
    const lenta = diferida<undefined>();
    downloadTeamManagerExport.mockImplementation(async (_c: string, club: string) => {
      if (club === "club-a") return lenta.promesa;
      throw new ApiError("La competencia no tiene piscina asignada", 400);
    });
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    elegir("comp-1");
    await screen.findByRole("table");

    const [filaAlfa, filaH1] = filas().slice(1);
    fireEvent.click(within(filaAlfa!).getByRole("button"));
    expect(within(filaAlfa!).getByRole("button")).toHaveTextContent("Generando...");
    expect(within(filaAlfa!).getByRole("button")).toBeDisabled();
    expect(within(filaH1!).getByRole("button")).toBeEnabled();

    fireEvent.click(within(filaH1!).getByRole("button"));
    expect(await within(filaH1!).findByRole("alert")).toHaveTextContent("La competencia no tiene piscina asignada");
    expect(within(filaAlfa!).queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => lenta.resolver(undefined));
    expect(within(filaAlfa!).getByRole("button")).toHaveTextContent("Exportar a Team Manager (.zip)");
    expect(within(filaAlfa!).getByRole("button")).toBeEnabled();
  });
});

describe("exportación: la operación vieja no toca a la nueva (selección A → B → A)", () => {
  /**
   * Cada llamada a la descarga queda pendiente en su propia promesa controlada, en orden
   * por club: `pendientes["club-a"][0]` es la primera descarga de Club Alfa, `[1]` la segunda.
   */
  function descargasControladas() {
    const pendientes: Record<string, ReturnType<typeof diferida<undefined>>[]> = {};
    downloadTeamManagerExport.mockImplementation((_c: string, club: string) => {
      const d = diferida<undefined>();
      (pendientes[club] ??= []).push(d);
      return d.promesa;
    });
    return pendientes;
  }

  const filaDe = (nombre: string) => screen.getByRole("button", { name: `Exportar a Team Manager (.zip): ${nombre}` }).closest("tr") as HTMLElement;
  const botonDe = (nombre: string) => within(filaDe(nombre)).getByRole("button");

  /** Inicia la descarga vieja de Club Alfa en A, pasa por B, vuelve a A e inicia la nueva del mismo club. */
  async function idaYVuelta() {
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    elegir("comp-1");
    await screen.findByRole("table");
    fireEvent.click(botonDe("Club Alfa"));
    expect(botonDe("Club Alfa")).toHaveTextContent("Generando...");

    elegir("comp-2");
    expect(await screen.findByRole("heading", { name: "Competencia Oculta" })).toBeInTheDocument();

    elegir("comp-1");
    expect(await screen.findByRole("heading", { name: "Competencia Uno" })).toBeInTheDocument();
    // Volver a A no hereda el estado de la operación vieja.
    expect(botonDe("Club Alfa")).toHaveTextContent("Exportar a Team Manager (.zip)");
    fireEvent.click(botonDe("Club Alfa"));
    expect(botonDe("Club Alfa")).toHaveTextContent("Generando...");
    expect(botonDe("Club Alfa")).toBeDisabled();
  }

  it("la descarga vieja termina bien y no quita el «Generando...» de la nueva", async () => {
    const pendientes = descargasControladas();
    await idaYVuelta();
    expect(pendientes["club-a"]).toHaveLength(2);

    await act(async () => pendientes["club-a"]![0]!.resolver(undefined));
    expect(botonDe("Club Alfa"), "la vieja no cierra la nueva").toHaveTextContent("Generando...");
    expect(botonDe("Club Alfa")).toBeDisabled();
    expect(within(filaDe("Club Alfa")).queryByRole("alert")).not.toBeInTheDocument();

    // La nueva termina y actualiza SU estado.
    await act(async () => pendientes["club-a"]![1]!.resolver(undefined));
    expect(botonDe("Club Alfa")).toHaveTextContent("Exportar a Team Manager (.zip)");
    expect(botonDe("Club Alfa")).toBeEnabled();
    expect(within(filaDe("Club Alfa")).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("la descarga vieja falla y su error no aparece en la nueva", async () => {
    const pendientes = descargasControladas();
    await idaYVuelta();

    await act(async () => pendientes["club-a"]![0]!.rechazar(new ApiError("Error de la descarga vieja", 400)));
    expect(within(filaDe("Club Alfa")).queryByRole("alert"), "el error viejo no se muestra").not.toBeInTheDocument();
    expect(botonDe("Club Alfa")).toHaveTextContent("Generando...");
    expect(botonDe("Club Alfa")).toBeDisabled();

    // La nueva falla con su propio error, y ese sí se muestra en su fila.
    await act(async () => pendientes["club-a"]![1]!.rechazar(new ApiError("Error de la descarga nueva", 400)));
    expect(within(filaDe("Club Alfa")).getByRole("alert")).toHaveTextContent("Error de la descarga nueva");
    expect(screen.queryByText("Error de la descarga vieja")).not.toBeInTheDocument();
    expect(botonDe("Club Alfa")).toBeEnabled();
  });

  it("la descarga vieja de una fila sin descarga nueva no deja su error tras volver a A", async () => {
    const pendientes = descargasControladas();
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    elegir("comp-1");
    await screen.findByRole("table");
    const [, filaH1] = filas().slice(1);
    fireEvent.click(within(filaH1!).getByRole("button"));

    elegir("comp-2");
    await screen.findByRole("heading", { name: "Competencia Oculta" });
    elegir("comp-1");
    await screen.findByRole("heading", { name: "Competencia Uno" });

    await act(async () => pendientes["club-h1"]![0]!.rechazar(new ApiError("Error de la descarga vieja", 400)));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    for (const b of screen.getAllByRole("button", { name: /Exportar a Team Manager/ })) expect(b).toBeEnabled();
  });

  it("si la nueva termina primero, la vieja que llega después no borra el estado de la nueva", async () => {
    const pendientes = descargasControladas();
    await idaYVuelta();

    await act(async () => pendientes["club-a"]![1]!.rechazar(new ApiError("Error de la descarga nueva", 400)));
    expect(within(filaDe("Club Alfa")).getByRole("alert")).toHaveTextContent("Error de la descarga nueva");

    await act(async () => pendientes["club-a"]![0]!.resolver(undefined));
    expect(within(filaDe("Club Alfa")).getByRole("alert"), "la vieja no borra el error de la nueva").toHaveTextContent("Error de la descarga nueva");
  });
});

describe("respuestas tardías", () => {
  it("el resumen tardío de la competencia anterior no reemplaza al actual", async () => {
    const tardio = diferida<ResumenPorClub>();
    getResumenPorClub.mockImplementation(async (id: string) => (id === "comp-1" ? tardio.promesa : POR_ID[id]));
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });

    elegir("comp-1");
    elegir("comp-2");
    expect(await screen.findByRole("heading", { name: "Competencia Oculta" })).toBeInTheDocument();

    await act(async () => tardio.resolver(RESUMEN_UNO));
    expect(screen.queryByRole("heading", { name: "Competencia Uno" })).not.toBeInTheDocument();
    expect(screen.queryByText("Club Alfa")).not.toBeInTheDocument();
    expect(screen.getByText("Club Solo Relevos")).toBeInTheDocument();
  });

  it("al cambiar de competencia desaparece el resumen anterior mientras carga el nuevo", async () => {
    const pendiente = diferida<ResumenPorClub>();
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    elegir("comp-1");
    await screen.findByRole("table");

    getResumenPorClub.mockReturnValueOnce(pendiente.promesa);
    elegir("comp-2");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Cargando resumen…");
  });
});

describe("sin rol de administración", () => {
  it("no consulta nada y no muestra el reporte", () => {
    roles = ["delegate"];
    montar();
    expect(screen.getByRole("alert")).toHaveTextContent("Este reporte es exclusivo de administración.");
    expect(screen.queryByLabelText("Competencia")).not.toBeInTheDocument();
    expect(competitionsList).not.toHaveBeenCalled();
    expect(getResumenPorClub).not.toHaveBeenCalled();
  });

  it("si la sesión pierde el rol mientras está abierta, se retira la tabla", async () => {
    const vista = montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    elegir("comp-1");
    await screen.findByRole("table");

    roles = ["delegate"];
    vista.rerender(
      <MemoryRouter>
        <ClubSummaryReportPage />
      </MemoryRouter>
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Este reporte es exclusivo de administración.");
  });
});
