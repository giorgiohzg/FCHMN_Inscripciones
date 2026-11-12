/**
 * Reportes: resumen de inscripciones por club (solo administración).
 *
 * Carga, vacío, errores, tabla y totales, exportación de Team Manager por fila, respuestas
 * tardías y pérdida del rol. Interacción simulada con jsdom y servicios simulados, datos
 * sintéticos; no es una revisión visual ni un navegador real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const fila = (clubId: string, clubName: string, v: number, d: number, ind: number, rel: number, mayores = 0) => ({
  clubId,
  clubName,
  varones: v,
  damas: d,
  totalNadadores: v + d,
  nadadoresConEdadMinima: mayores,
  pruebasIndividuales: ind,
  relevos: rel,
  totalPruebas: ind + rel,
});

const RESUMEN_UNO: ResumenPorClub = {
  competitionId: "comp-1",
  competitionName: "Competencia Uno",
  edadMinima: 70,
  clubs: [fila("club-a", "Club Alfa", 2, 3, 3, 2, 2), fila("club-h1", "Club Homónimo", 1, 0, 1, 0, 0), fila("club-h2", "Club Homónimo", 0, 2, 2, 0, 1)],
  totales: { varones: 3, damas: 5, totalNadadores: 8, nadadoresConEdadMinima: 3, pruebasIndividuales: 6, relevos: 2, totalPruebas: 8 },
};
const RESUMEN_OCULTA: ResumenPorClub = {
  competitionId: "comp-2",
  competitionName: "Competencia Oculta",
  edadMinima: 70,
  clubs: [fila("club-r", "Club Solo Relevos", 2, 2, 0, 1)],
  totales: { varones: 2, damas: 2, totalNadadores: 4, nadadoresConEdadMinima: 0, pruebasIndividuales: 0, relevos: 1, totalPruebas: 1 },
};
const VACIO: ResumenPorClub = {
  competitionId: "comp-vacia",
  competitionName: "Competencia Vacía",
  edadMinima: 70,
  clubs: [],
  totales: { varones: 0, damas: 0, totalNadadores: 0, nadadoresConEdadMinima: 0, pruebasIndividuales: 0, relevos: 0, totalPruebas: 0 },
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
  // El simulado devuelve la edad pedida como edad aplicada, como el servidor.
  getResumenPorClub.mockImplementation(async (id: string, edad: number) => ({ ...POR_ID[id]!, edadMinima: edad }));
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
      "Nadadores de 70 años o más",
      "Pruebas individuales",
      "Relevos",
      "Total pruebas",
      "Team Manager",
    ]);
    expect(resto).toHaveLength(4); // tres clubes + totales
    expect(celdas(resto[0]!).slice(0, 8)).toEqual(["Club Alfa", "2", "3", "5", "2", "3", "2", "5"]);
    expect(celdas(resto[1]!).slice(0, 8)).toEqual(["Club Homónimo", "1", "0", "1", "0", "1", "0", "1"]);
    expect(celdas(resto[2]!).slice(0, 8)).toEqual(["Club Homónimo", "0", "2", "2", "1", "2", "0", "2"]);
    expect(celdas(resto[3]!).slice(0, 8)).toEqual(["Total", "3", "5", "8", "3", "6", "2", "8"]);
  });

  it("nadadores de 70 años o más: la columna va junto a «Total nadadores», muestra 0 si nadie cumple, y su total es el del servidor", async () => {
    montar();
    await screen.findByRole("option", { name: "Competencia Oculta" });
    elegir("comp-2");
    await screen.findByRole("table");

    const [encabezado, filaClub, filaTotal] = filas();
    const columnas = within(encabezado!).getAllByRole("columnheader").map((c) => c.textContent);
    const indice = columnas.indexOf("Nadadores de 70 años o más");
    expect(indice).toBe(columnas.indexOf("Total nadadores") + 1);
    expect(celdas(filaClub!)[indice]).toBe("0");
    expect(celdas(filaTotal!)[indice]).toBe("0");
  });

  it("nadadores de 70 años o más: miles con el formato de los demás números", async () => {
    getResumenPorClub.mockResolvedValueOnce({
      competitionId: "comp-1",
      competitionName: "Competencia Uno",
      edadMinima: 70,
      clubs: [fila("club-a", "Club Alfa", 1500, 900, 10, 0, 1234)],
      totales: { varones: 1500, damas: 900, totalNadadores: 2400, nadadoresConEdadMinima: 1234, pruebasIndividuales: 10, relevos: 0, totalPruebas: 10 },
    } satisfies ResumenPorClub);
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    elegir("comp-1");
    await screen.findByRole("table");
    const [, filaClub, filaTotal] = filas();
    expect(celdas(filaClub!)[4]).toBe((1234).toLocaleString("es-CL"));
    expect(celdas(filaTotal!)[4]).toBe((1234).toLocaleString("es-CL"));
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

describe("edad mínima", () => {
  /** Columna de edad de «Competencia Uno» según el umbral (sintética): las demás cifras no cambian. */
  const COLUMNA_POR_EDAD: Record<number, number[]> = { 65: [4, 1, 2], 70: [2, 0, 1], 75: [1, 0, 0] };
  const resumenUnoCon = (edad: number): ResumenPorClub => {
    const columna = COLUMNA_POR_EDAD[edad] ?? [0, 0, 0];
    return {
      ...RESUMEN_UNO,
      edadMinima: edad,
      clubs: RESUMEN_UNO.clubs.map((f, i) => ({ ...f, nadadoresConEdadMinima: columna[i]! })),
      totales: { ...RESUMEN_UNO.totales, nadadoresConEdadMinima: columna.reduce((a, b) => a + b, 0) },
    };
  };
  const campoEdad = () => screen.getByLabelText("Edad mínima") as HTMLInputElement;
  const botonAplicar = () => screen.getByRole("button", { name: "Aplicar" });
  const escribir = (valor: string) => fireEvent.change(campoEdad(), { target: { value: valor } });
  const aplicar = (valor: string) => {
    escribir(valor);
    fireEvent.click(botonAplicar());
  };
  const encabezados = () => within(filas()[0]!).getAllByRole("columnheader").map((c) => c.textContent);
  const columnaEdad = () => filas().slice(1).map((tr) => celdas(tr)[4]);
  const sinEdad = (tr: HTMLElement) => celdas(tr).filter((_c, i) => i !== 4);
  const seccion = () => screen.getByRole("region", { name: /^Resumen de / });
  const consultas = () => getResumenPorClub.mock.calls.length;

  async function conCompetenciaUno() {
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    elegir("comp-1");
    await screen.findByRole("table");
  }

  beforeEach(() => {
    getResumenPorClub.mockImplementation(async (id: string, edad: number) => (id === "comp-1" ? resumenUnoCon(edad) : { ...POR_ID[id]!, edadMinima: edad }));
  });

  it("valor inicial 70, con «Aplicar» junto al campo, y la primera consulta lo usa", async () => {
    await conCompetenciaUno();
    expect(campoEdad().value).toBe("70");
    expect(campoEdad()).toHaveAttribute("type", "number");
    expect(campoEdad()).toHaveAccessibleDescription(/fecha de corte de la competencia/);
    expect(botonAplicar()).toBeInTheDocument();
    expect(getResumenPorClub.mock.calls).toEqual([["comp-1", 70]]);
    expect(encabezados()[4]).toBe("Nadadores de 70 años o más");
    expect(columnaEdad()).toEqual(["2", "0", "1", "3"]);
  });

  it("borrar 70 y escribir 75 con el teclado no consulta ni retira la tabla; Enter aplica con UNA consulta", async () => {
    const user = userEvent.setup();
    await conCompetenciaUno();
    const antes = consultas();

    await user.clear(campoEdad());
    expect(campoEdad()).toHaveAttribute("aria-invalid", "true");
    await user.type(campoEdad(), "75");
    expect(consultas(), "escribir no consulta").toBe(antes);
    expect(campoEdad()).toHaveFocus();
    // Siguen los resultados de 70, identificados por la respuesta, y se avisa el cambio pendiente.
    expect(encabezados()[4]).toBe("Nadadores de 70 años o más");
    expect(campoEdad()).toHaveAccessibleDescription("Cambio sin aplicar: se mantiene 70. Pulse «Aplicar» o Enter.");

    await user.keyboard("{Enter}");
    await waitFor(() => expect(encabezados()[4]).toBe("Nadadores de 75 años o más"));
    expect(getResumenPorClub.mock.calls.slice(antes)).toEqual([["comp-1", 75]]);
    expect(columnaEdad()).toEqual(["1", "0", "0", "1"]);
    expect(campoEdad()).toHaveAccessibleDescription(/fecha de corte de la competencia/);
  });

  it("«Aplicar» hace una sola consulta; aplicar otra vez la edad ya vigente no consulta", async () => {
    await conCompetenciaUno();
    const antes = consultas();
    aplicar("75");
    await waitFor(() => expect(encabezados()[4]).toBe("Nadadores de 75 años o más"));
    expect(getResumenPorClub.mock.calls.slice(antes)).toEqual([["comp-1", 75]]);

    fireEvent.click(botonAplicar());
    await act(async () => {});
    expect(consultas()).toBe(antes + 1);
  });

  it("65, 70 y 75: encabezado y columna (con su total) cambian; las demás cifras y los clubes, no", async () => {
    await conCompetenciaUno();
    const otrasCifras = filas().slice(1).map(sinEdad);
    for (const [edad, esperado] of [
      ["65", ["4", "1", "2", "7"]],
      ["75", ["1", "0", "0", "1"]],
      ["70", ["2", "0", "1", "3"]],
    ] as const) {
      aplicar(edad);
      await waitFor(() => expect(encabezados()[4]).toBe(`Nadadores de ${edad} años o más`));
      expect(getResumenPorClub).toHaveBeenLastCalledWith("comp-1", Number(edad));
      expect(columnaEdad(), edad).toEqual(esperado);
      expect(filas().slice(1).map(sinEdad), edad).toEqual(otrasCifras);
    }
  });

  it("club sin personas que cumplan: sigue en la tabla con 0", async () => {
    await conCompetenciaUno();
    aplicar("99");
    await waitFor(() => expect(encabezados()[4]).toBe("Nadadores de 99 años o más"));
    expect(filas()).toHaveLength(5); // encabezado, tres clubes y totales
    expect(columnaEdad()).toEqual(["0", "0", "0", "0"]);
  });

  it("inválido: validación a la vista, no se aplica ni consulta, y siguen los resultados de 70", async () => {
    await conCompetenciaUno();
    const antes = consultas();
    for (const valor of ["", "7.5", "-1", "151", "070", "abc"]) {
      aplicar(valor);
      expect(screen.getByRole("alert"), valor).toHaveTextContent("Ingrese un número entero entre 0 y 150. No se aplica: se mantiene 70.");
      expect(campoEdad()).toHaveAttribute("aria-invalid", "true");
      expect(encabezados()[4], valor).toBe("Nadadores de 70 años o más");
      expect(screen.queryByRole("status"), valor).not.toBeInTheDocument();
    }
    await act(async () => {});
    expect(consultas()).toBe(antes);

    aplicar("75");
    await waitFor(() => expect(encabezados()[4]).toBe("Nadadores de 75 años o más"));
    expect(getResumenPorClub.mock.calls.slice(antes)).toEqual([["comp-1", 75]]);
  });

  it("con un cambio sin aplicar, otra competencia se consulta con la edad aplicada", async () => {
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    escribir("75");
    elegir("comp-2");
    expect(await screen.findByRole("heading", { name: "Competencia Oculta" })).toBeInTheDocument();
    expect(getResumenPorClub.mock.calls).toEqual([["comp-2", 70]]);
    expect(campoEdad()).toHaveAccessibleDescription("Cambio sin aplicar: se mantiene 70. Pulse «Aplicar» o Enter.");
  });

  it("mientras recalcula: carga identificada, la tabla anterior marcada y con SU encabezado, nunca con el umbral nuevo", async () => {
    await conCompetenciaUno();
    const pendiente = diferida<ResumenPorClub>();
    getResumenPorClub.mockReturnValueOnce(pendiente.promesa);
    aplicar("75");

    expect(screen.getByRole("status")).toHaveTextContent("Recalculando con 75 años o más… La tabla muestra todavía los resultados de 70 años o más.");
    expect(seccion()).toHaveAttribute("aria-busy", "true");
    expect(encabezados()[4]).toBe("Nadadores de 70 años o más");
    expect(screen.queryByText("Nadadores de 75 años o más")).not.toBeInTheDocument();
    expect(columnaEdad()).toEqual(["2", "0", "1", "3"]);

    await act(async () => pendiente.resolver(resumenUnoCon(75)));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(seccion()).toHaveAttribute("aria-busy", "false");
    expect(encabezados()[4]).toBe("Nadadores de 75 años o más");
    expect(columnaEdad()).toEqual(["1", "0", "0", "1"]);
  });

  it("al aplicar otra edad en la misma competencia se conserva el contenedor desplazable (no se vuelve a montar)", async () => {
    await conCompetenciaUno();
    const contenedor = screen.getByRole("table").parentElement!;
    contenedor.scrollLeft = 420; // en jsdom no hay diseño: lo que se comprueba es que el nodo es el mismo
    const pendiente = diferida<ResumenPorClub>();
    getResumenPorClub.mockReturnValueOnce(pendiente.promesa);
    aplicar("75");
    expect(screen.getByRole("table").parentElement, "mientras recalcula").toBe(contenedor);
    await act(async () => pendiente.resolver(resumenUnoCon(75)));
    expect(screen.getByRole("table").parentElement, "con el resultado nuevo").toBe(contenedor);
    expect(contenedor).toHaveStyle({ overflowX: "auto" });
  });

  it("cambiar de competencia sigue retirando los resultados de la anterior", async () => {
    await conCompetenciaUno();
    const pendiente = diferida<ResumenPorClub>();
    getResumenPorClub.mockReturnValueOnce(pendiente.promesa);
    elegir("comp-2");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Cargando resumen…");
  });

  it("si falla la actualización: error identificado, tabla anterior con su edad, y «Reintentar» pide la misma edad", async () => {
    await conCompetenciaUno();
    getResumenPorClub.mockRejectedValueOnce(new ApiError("Error interno del servidor", 500));
    aplicar("75");
    const alerta = await screen.findByRole("alert");
    expect(alerta).toHaveTextContent("No se pudo actualizar a 75 años o más (Error interno del servidor). La tabla muestra los resultados de 70 años o más.");
    expect(encabezados()[4]).toBe("Nadadores de 70 años o más");
    expect(seccion()).toHaveStyle({ opacity: "0.55" });

    const antes = consultas();
    fireEvent.click(within(alerta).getByRole("button", { name: "Reintentar" }));
    await waitFor(() => expect(encabezados()[4]).toBe("Nadadores de 75 años o más"));
    expect(getResumenPorClub.mock.calls.slice(antes)).toEqual([["comp-1", 75]]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("tras un error, «Aplicar» con el mismo valor también reintenta", async () => {
    await conCompetenciaUno();
    getResumenPorClub.mockRejectedValueOnce(new ApiError("Error interno del servidor", 500));
    aplicar("75");
    await screen.findByRole("alert");
    const antes = consultas();
    fireEvent.click(botonAplicar());
    await waitFor(() => expect(encabezados()[4]).toBe("Nadadores de 75 años o más"));
    expect(getResumenPorClub.mock.calls.slice(antes)).toEqual([["comp-1", 75]]);
  });

  it("un 403 no ofrece reintentar", async () => {
    getResumenPorClub.mockRejectedValueOnce(new ApiError("Requiere uno de los siguientes roles: admin", 403));
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    elegir("comp-1");
    expect(await screen.findByRole("alert")).toHaveTextContent("Este reporte es exclusivo de administración.");
    expect(screen.queryByRole("button", { name: "Reintentar" })).not.toBeInTheDocument();
  });

  it("respuesta tardía de la edad anterior: se descarta y no reemplaza a la vigente", async () => {
    await conCompetenciaUno();
    const tardia = diferida<ResumenPorClub>();
    getResumenPorClub.mockImplementation(async (_id: string, edad: number) => (edad === 75 ? tardia.promesa : resumenUnoCon(edad)));
    aplicar("75");
    aplicar("65");
    await waitFor(() => expect(encabezados()[4]).toBe("Nadadores de 65 años o más"));

    await act(async () => tardia.resolver(resumenUnoCon(75)));
    expect(encabezados()[4]).toBe("Nadadores de 65 años o más");
    expect(columnaEdad()).toEqual(["4", "1", "2", "7"]);
  });

  it("respuesta tardía de otra competencia con la misma edad: se descarta", async () => {
    const tardia = diferida<ResumenPorClub>();
    getResumenPorClub.mockImplementation(async (id: string, edad: number) => (id === "comp-1" ? tardia.promesa : { ...POR_ID[id]!, edadMinima: edad }));
    montar();
    await screen.findByRole("option", { name: "Competencia Uno" });
    aplicar("75");
    elegir("comp-1");
    elegir("comp-2");
    expect(await screen.findByRole("heading", { name: "Competencia Oculta" })).toBeInTheDocument();

    await act(async () => tardia.resolver(resumenUnoCon(75)));
    expect(screen.queryByText("Club Alfa")).not.toBeInTheDocument();
    expect(screen.getByText("Club Solo Relevos")).toBeInTheDocument();
    expect(encabezados()[4]).toBe("Nadadores de 75 años o más");
  });

  it("una respuesta con otra edad que la aplicada se muestra identificada por la suya, con aviso", async () => {
    await conCompetenciaUno();
    getResumenPorClub.mockImplementation(async () => resumenUnoCon(70));
    aplicar("75");
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(encabezados()[4]).toBe("Nadadores de 70 años o más");
    expect(screen.getByRole("alert")).toHaveTextContent("Estos resultados son de 70 años o más, no de la edad aplicada (75).");
  });

  it("aplicar otra edad con una exportación en curso: la fila sigue «Generando...» y la exportación no recibe la edad", async () => {
    const descarga = diferida<undefined>();
    downloadTeamManagerExport.mockReturnValueOnce(descarga.promesa);
    await conCompetenciaUno();
    const filaAlfa = () => filas().find((tr) => tr.textContent?.includes("Club Alfa"))!;

    fireEvent.click(within(filaAlfa()).getByRole("button"));
    const pendiente = diferida<ResumenPorClub>();
    getResumenPorClub.mockReturnValueOnce(pendiente.promesa);
    aplicar("65");
    expect(within(filaAlfa()).getByRole("button"), "mientras recalcula").toHaveTextContent("Generando...");
    await act(async () => pendiente.resolver(resumenUnoCon(65)));
    expect(encabezados()[4]).toBe("Nadadores de 65 años o más");
    expect(within(filaAlfa()).getByRole("button"), "con la edad nueva").toHaveTextContent("Generando...");

    await act(async () => descarga.resolver(undefined));
    expect(within(filaAlfa()).getByRole("button")).toHaveTextContent("Exportar a Team Manager (.zip)");
    expect(within(filaAlfa()).queryByRole("alert")).not.toBeInTheDocument();
    expect(downloadTeamManagerExport.mock.calls).toEqual([["comp-1", "club-a"]]);
  });
});
