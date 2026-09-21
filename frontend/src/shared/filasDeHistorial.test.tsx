/**
 * Fase 6, hallazgo 31 — EQUIVALENCIA DEMOSTRADA, no solo inspeccionada.
 *
 * Las pruebas anteriores del panel usaban filas ficticias: demostraban que el
 * componente funciona, no que los Workspace produzcan lo mismo que las páginas
 * retiradas. Aquí se prueban las dos mitades que faltaban:
 *
 *  1. **Los mapeadores** de respuesta del API a fila, uno por dominio, con todas
 *     las columnas de cada uno.
 *  2. **La integración**: qué se le pide al API —competencia, club y estado— y
 *     qué acaba en pantalla, incluidas varias páginas y el error fail-closed.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import {
  COLUMNAS_INSCRIPCIONES,
  COLUMNAS_RELEVOS,
  cargadorDeInscripciones,
  cargadorDeRelevos,
  filaDeInscripcion,
  filaDeRelevo,
} from "./filasDeHistorial";
import { PanelDeHistorial } from "./PanelDeHistorial";
import type { RegistrationItem } from "../modules/registrations/registrationsApi";
import type { RelayRegistrationItem } from "../modules/relay-registrations/relayRegistrationsApi";

const inscripcion = (id: string, status: "confirmed" | "cancelled"): RegistrationItem => ({
  id,
  status,
  seedTimeCentiseconds: 6543,
  person: { id: "p1", fullName: "Juan Pérez González", firstName: "Juan", paternalLastName: "Pérez", run: "11111111-1" },
  club: { id: "cl1", name: "Club Uno" },
  category: { id: "cat1", name: "Juvenil" },
  competitionEvent: {
    competition: { id: "comp1", name: "Nacional", isRegistrationOpen: true },
    event: {
      distance: { meters: 100 },
      stroke: { name: "Libre" },
      testType: { name: "Individual", swimmersCount: 1 },
      gender: "male",
    },
    competitionSession: { sessionType: { name: "Mañana" }, competitionDate: { date: "2026-03-15" } },
  },
});

const relevo = (id: string, status: "confirmed" | "cancelled"): RelayRegistrationItem => ({
  id,
  status,
  seedTimeCentiseconds: 24567,
  club: { id: "cl1", name: "Club Uno" },
  category: { id: "cat1", name: "Juvenil" },
  competitionEvent: {
    competition: { id: "comp1", name: "Nacional" },
    event: {
      distance: { meters: 50 },
      stroke: { name: "Libre" },
      testType: { name: "Relevo", swimmersCount: 4 },
      gender: "mixed",
    },
    competitionSession: { sessionType: { name: "Tarde" }, competitionDate: { date: "2026-03-16" } },
  },
  // A propósito desordenados: el orden de nado lo pone el mapeador.
  members: [
    { orderPosition: 3, person: { id: "p3", fullName: "Tercero Tres", run: "3-3" } },
    { orderPosition: 1, person: { id: "p1", fullName: "Primero Uno", run: "1-1" } },
    { orderPosition: 4, person: { id: "p4", fullName: "Cuarto Cuatro", run: "4-4" } },
    { orderPosition: 2, person: { id: "p2", fullName: "Segundo Dos", run: "2-2" } },
  ],
});

describe("mapeador de INSCRIPCIONES individuales", () => {
  it("produce todas las columnas de la página retirada, en su orden", () => {
    const fila = filaDeInscripcion(inscripcion("r1", "confirmed"));

    expect(fila.id).toBe("r1");
    expect(fila.cancelada).toBe(false);
    expect(fila.celdas).toHaveLength(COLUMNAS_INSCRIPCIONES.length);
    expect(fila.celdas[0]).toContain("11111111-1"); // nadador con su RUN
    expect(fila.celdas[1]).toBe("Club Uno");
    expect(fila.celdas[2], "prueba: distancia, estilo y género").toMatch(/100/);
    expect(fila.celdas[3], "fecha y jornada juntas").toContain("Mañana");
    expect(fila.celdas[4]).toBe("Juvenil");
    expect(fila.celdas[5], "tiempo estimado legible").toMatch(/\d/);
  });

  it("marca como cancelada la que lo está", () => {
    expect(filaDeInscripcion(inscripcion("r2", "cancelled")).cancelada).toBe(true);
  });
});

describe("mapeador de RELEVOS", () => {
  it("produce todas sus columnas, con el equipo en orden de nado", () => {
    const fila = filaDeRelevo(relevo("t1", "cancelled"));

    expect(fila.id).toBe("t1");
    expect(fila.cancelada).toBe(true);
    expect(fila.celdas).toHaveLength(COLUMNAS_RELEVOS.length);
    expect(fila.celdas[0]).toBe("Club Uno");
    expect(fila.celdas[1]).toMatch(/50/);
    expect(fila.celdas[2]).toContain("Tarde");
    expect(fila.celdas[3]).toBe("Juvenil");
    // La columna propia del dominio: el equipo, ordenado por posición.
    expect(fila.celdas[4]).toBe("Primero Uno, Segundo Dos, Tercero Tres, Cuarto Cuatro");
    expect(fila.celdas[5]).toMatch(/\d/);
  });
});

/**
 * INTEGRACIÓN: el panel montado como lo montan los Workspace, con el mismo
 * `cargar` —cargador de UNA página + mapeador— y un API simulado que pagina.
 *
 * Antes este bloque comprobaba que se recorrían las TRES páginas y que las 45
 * filas acababan en pantalla. Eso era el defecto, no la garantía: el panel es una
 * tabla, y `paginacion.ts:16-20` reserva el recorrido completo para selectores y
 * conjuntos de decisión. Ahora se comprueba lo contrario.
 */
describe("el historial, tal como lo usan los Workspace", () => {
  const TOTAL = 45;
  const POR_PAGINA = 20;

  function apiQuePagina(status: "confirmed" | "cancelled" | undefined) {
    return vi.fn(
      async (params: {
        page?: number;
        pageSize?: number;
        competitionId?: string;
        clubId?: string;
        status?: "confirmed" | "cancelled";
      }) => {
        const pageSize = Math.min(params.pageSize ?? POR_PAGINA, POR_PAGINA);
        const page = params.page ?? 1;
        const desde = (page - 1) * pageSize;
        const items = Array.from({ length: Math.max(0, Math.min(pageSize, TOTAL - desde)) }, (_, i) =>
          inscripcion(`r-${desde + i + 1}`, status ?? "cancelled")
        );
        return { items, total: TOTAL, page, pageSize };
      }
    );
  }

  function montarConApi(list: ReturnType<typeof apiQuePagina>) {
    return render(
      <PanelDeHistorial
        nombrePlural="inscripciones"
        dependencias={["comp-1", "club-9"]}
        encabezados={COLUMNAS_INSCRIPCIONES}
        // EL MISMO cargador que usa el Workspace, no una copia de su lógica.
        cargar={cargadorDeInscripciones(list as never, "comp-1", "club-9")}
      />
    );
  }

  const abrir = () => fireEvent.click(screen.getByRole("button", { name: /Ver historial/ }));
  const siguiente = () => screen.getByRole("button", { name: "Siguiente" });

  it("pide CANCELADAS de la primera página, con la competencia y el club", async () => {
    const list = apiQuePagina("cancelled");
    montarConApi(list);
    abrir();

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list.mock.calls[0]![0]).toMatchObject({
      competitionId: "comp-1",
      clubId: "club-9",
      status: "cancelled",
      page: 1,
      pageSize: POR_PAGINA,
    });

    // 45 registros: UNA petición, no tres. Y en pantalla, una página de filas.
    await waitFor(() => expect(screen.getAllByText("Cancelada")).toHaveLength(POR_PAGINA));
    expect(list, "una tabla pide una página por vez").toHaveBeenCalledTimes(1);
  });

  it("«Siguiente» pide la página 2 al API, con el mismo filtro", async () => {
    const list = apiQuePagina("cancelled");
    montarConApi(list);
    abrir();
    await screen.findByText(/Mostrando 1–20 de 45/);

    fireEvent.click(siguiente());

    await waitFor(() => expect(screen.getByText(/Mostrando 21–40 de 45/)).toBeInTheDocument());
    expect(list.mock.calls.map((c) => c[0].page)).toEqual([1, 2]);
    expect(list.mock.calls[1]![0]).toMatchObject({ competitionId: "comp-1", clubId: "club-9", status: "cancelled" });
  });

  it("cambia a CONFIRMADAS y a TODAS enviando el estado correcto", async () => {
    const list = apiQuePagina("confirmed");
    montarConApi(list);
    abrir();
    await waitFor(() => expect(list).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "confirmed" } });
    await waitFor(() => expect(list.mock.calls.some((c) => c[0].status === "confirmed")).toBe(true));

    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "todas" } });
    await waitFor(() => expect(list.mock.calls.some((c) => c[0].status === undefined)).toBe(true));

    await waitFor(() => expect(screen.getAllByText("Confirmada").length).toBeGreaterThan(0));
  });

  it("RECHAZA una página distinta de la pedida", async () => {
    /**
     * Un servidor que ignora `page` —o un proxy que sirve de caché la primera—
     * devolvería siempre lo mismo y la navegación giraría en el vacío mostrando
     * filas equivocadas con apariencia de correctas.
     */
    const list = vi.fn(async () => ({
      items: Array.from({ length: 20 }, (_, i) => inscripcion(`r-${i + 1}`, "cancelled")),
      total: 45,
      page: 1,
      pageSize: 20,
    }));

    montarConApi(list as never);
    abrir();
    await screen.findByText(/Mostrando 1–20 de 45/);

    fireEvent.click(siguiente());

    expect(await screen.findByText(/Se pidió la página 2 y el servidor devolvió la 1/)).toBeInTheDocument();
    expect(screen.queryByRole("table"), "no se pinta la página equivocada").not.toBeInTheDocument();
  });

  it("RECHAZA un tamaño de página mayor que el pedido", async () => {
    /**
     * Con 20 filas y `pageSize: 100`, el pie calcularía «una sola página» sobre
     * un total de 45 y escondería 25 registros sin avisar.
     */
    const list = vi.fn(async () => ({
      items: Array.from({ length: 20 }, (_, i) => inscripcion(`r-${i + 1}`, "cancelled")),
      total: 45,
      page: 1,
      pageSize: 100,
    }));

    montarConApi(list as never);
    abrir();

    expect(await screen.findByText(/Se pidieron 20 elementos por página y el servidor informa 100/)).toBeInTheDocument();
  });

  it("RECHAZA una página VACÍA cuando el total dice que hay registros", async () => {
    /**
     * Es el caso que la comprobación anterior —solo el exceso— dejaba pasar, y el
     * peor de todos para el usuario: la pantalla diría «Sin inscripciones para
     * este filtro» **y** un pie afirmando que existen 45. Dos mensajes que se
     * contradicen, y quien consulta se queda sin saber cuál creer.
     *
     * Ahora es un error fail-closed: ni tabla, ni pie, ni «Sin…».
     */
    const list = vi.fn(async () => ({ items: [], total: 45, page: 1, pageSize: 20 }));

    montarConApi(list as never);
    abrir();

    expect(await screen.findByText(/debían venir 20/)).toBeInTheDocument();
    expect(screen.queryByRole("table"), "ninguna tabla").not.toBeInTheDocument();
    expect(screen.queryByText(/Sin inscripciones para este filtro/), "ni el vacío").not.toBeInTheDocument();
    expect(screen.queryByText(/de 45/), "ni un pie que afirme que hay 45").not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Siguiente" })).not.toBeInTheDocument();
  });

  it("no ofrece NINGUNA acción sobre las canceladas", async () => {
    const list = apiQuePagina("cancelled");
    montarConApi(list);
    abrir();
    await waitFor(() => expect(list).toHaveBeenCalled());
    await screen.findAllByText("Cancelada");

    const botones = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(botones.filter((t) => /cancelar|editar|eliminar|guardar/i.test(t))).toEqual([]);
  });
});

/**
 * LO MISMO PARA RELEVOS. El mapeador se probaba aislado, pero el cargador
 * paginado solo se ejercitaba con inscripciones individuales: la mitad del
 * historial quedaba sin cubrir.
 */
describe("el historial de RELEVOS, tal como lo usa su Workspace", () => {
  const TOTAL = 45;
  const POR_PAGINA = 20;

  function apiDeRelevos(status: "confirmed" | "cancelled" | undefined) {
    return vi.fn(
      async (params: {
        page?: number;
        pageSize?: number;
        competitionId?: string;
        clubId?: string;
        status?: "confirmed" | "cancelled";
      }) => {
        const pageSize = Math.min(params.pageSize ?? POR_PAGINA, POR_PAGINA);
        const page = params.page ?? 1;
        const desde = (page - 1) * pageSize;
        const items = Array.from({ length: Math.max(0, Math.min(pageSize, TOTAL - desde)) }, (_, i) =>
          relevo(`t-${desde + i + 1}`, status ?? "cancelled")
        );
        return { items, total: TOTAL, page, pageSize };
      }
    );
  }

  function montarRelevos(list: ReturnType<typeof apiDeRelevos>) {
    return render(
      <PanelDeHistorial
        nombrePlural="equipos de relevo"
        dependencias={["comp-7", "club-3"]}
        encabezados={COLUMNAS_RELEVOS}
        cargar={cargadorDeRelevos(list as never, "comp-7", "club-3")}
      />
    );
  }

  const abrir = () => fireEvent.click(screen.getByRole("button", { name: /Ver historial/ }));
  const siguiente = () => screen.getByRole("button", { name: "Siguiente" });

  it("pide CANCELADOS de la primera página, con competencia y club", async () => {
    const list = apiDeRelevos("cancelled");
    montarRelevos(list);
    abrir();

    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(list.mock.calls[0]![0]).toMatchObject({
      competitionId: "comp-7",
      clubId: "club-3",
      status: "cancelled",
      page: 1,
      pageSize: POR_PAGINA,
    });

    await waitFor(() => expect(screen.getAllByText("Cancelada")).toHaveLength(POR_PAGINA));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("«Siguiente» pide la página 2 de los relevos", async () => {
    const list = apiDeRelevos("cancelled");
    montarRelevos(list);
    abrir();
    await screen.findByText(/Mostrando 1–20 de 45/);

    fireEvent.click(siguiente());

    await waitFor(() => expect(screen.getByText(/Mostrando 21–40 de 45/)).toBeInTheDocument());
    expect(list.mock.calls.map((c) => c[0].page)).toEqual([1, 2]);
  });

  it("muestra las COLUMNAS de relevos, con el equipo en orden de nado", async () => {
    montarRelevos(apiDeRelevos("cancelled"));
    abrir();
    await screen.findAllByText("Cancelada");

    for (const encabezado of COLUMNAS_RELEVOS) {
      expect(screen.getByRole("columnheader", { name: encabezado }), encabezado).toBeInTheDocument();
    }
    // La columna propia del dominio: los cuatro nadadores, ordenados.
    expect(screen.getAllByText("Primero Uno, Segundo Dos, Tercero Tres, Cuarto Cuatro").length).toBe(POR_PAGINA);
  });

  it("cambia a CONFIRMADOS y a TODOS enviando el estado correcto", async () => {
    const list = apiDeRelevos("confirmed");
    montarRelevos(list);
    abrir();
    await waitFor(() => expect(list).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "confirmed" } });
    await waitFor(() => expect(list.mock.calls.some((c) => c[0].status === "confirmed")).toBe(true));

    fireEvent.change(screen.getByLabelText("Estado"), { target: { value: "todas" } });
    await waitFor(() => expect(list.mock.calls.some((c) => c[0].status === undefined)).toBe(true));

    await waitFor(() => expect(screen.getAllByText("Confirmada").length).toBeGreaterThan(0));
  });

  it("RECHAZA una página distinta de la pedida", async () => {
    const list = vi.fn(async () => ({
      items: Array.from({ length: 20 }, (_, i) => relevo(`t-${i + 1}`, "cancelled")),
      total: 45,
      page: 1,
      pageSize: 20,
    }));

    montarRelevos(list as never);
    abrir();
    await screen.findByText(/Mostrando 1–20 de 45/);

    fireEvent.click(siguiente());

    expect(await screen.findByText(/Se pidió la página 2 y el servidor devolvió la 1/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("no ofrece NINGUNA acción sobre los relevos cancelados", async () => {
    montarRelevos(apiDeRelevos("cancelled"));
    abrir();
    await screen.findAllByText("Cancelada");

    const botones = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(botones.filter((t) => /cancelar|editar|eliminar|guardar/i.test(t))).toEqual([]);
  });
});
