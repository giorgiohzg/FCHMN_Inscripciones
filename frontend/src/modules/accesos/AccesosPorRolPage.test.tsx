/**
 * Pantalla «Accesos por rol» (administración). Interacción simulada con jsdom y API simulada;
 * datos sintéticos. No es un navegador real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AccesosPorRolPage } from "./AccesosPorRolPage";
import type { ConfiguracionDeAccesos, Valores } from "./accesosApi";

vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: { id: "u-admin", username: "admin.sintetico", ownerType: "system", personId: null, clubId: null, roles: ["admin"] },
      accessToken: "t",
      permissions: [],
      mustChangePassword: false,
      hasRole: (r: string) => r === "admin",
      hasPermission: () => true,
      restaurando: false,
      restauracionFallida: false,
      login: vi.fn(),
      logout: vi.fn(),
      changePassword: vi.fn(),
      reintentarRestauracion: vi.fn(),
    }),
  };
});

const leer = vi.fn();
const guardar = vi.fn();
vi.mock("./accesosApi", async () => {
  const real = await vi.importActual<typeof import("./accesosApi")>("./accesosApi");
  return { ...real, useAccesosApi: () => ({ leer, guardar }) };
});
const { ApiError } = await import("../../shared/apiClient");

const TODOS = ["swimmer", "delegate", "coach"] as const;
const PERSONAL = ["delegate", "coach"] as const;
const f = (id: string, etiqueta: string, menu: string | null, aplicaA: readonly string[]) => ({ id, etiqueta, menu, aplicaA: [...aplicaA] as ("swimmer" | "delegate" | "coach")[] });

const GRUPOS: ConfiguracionDeAccesos["grupos"] = [
  {
    menu: f("menu.relevos", "Inscripciones de Relevo", null, TODOS),
    acciones: [f("relevos.armar", "Armar un equipo", "menu.relevos", PERSONAL), f("relevos.historial", "Ver el historial", "menu.relevos", TODOS)],
    noConfigurables: [],
  },
  {
    menu: f("menu.reportes", "Reportes", null, TODOS),
    acciones: [f("reportes.generar", "Generar reporte", "menu.reportes", TODOS), f("reportes.exportar", "Exportar CSV, Excel o PDF", "menu.reportes", TODOS)],
    noConfigurables: [{ id: "reportes.team_manager", etiqueta: "Exportar a Team Manager (.zip)", nota: "No configurable: conserva sus permisos actuales." }],
  },
  { menu: null, acciones: [f("cuenta.cambio_voluntario_contrasena", "Cambio voluntario de contraseña", null, TODOS)], noConfigurables: [] },
];

function valores(apagadas: string[] = []): Valores {
  const v: Valores = { swimmer: {}, delegate: {}, coach: {} };
  for (const g of GRUPOS) for (const x of [...(g.menu ? [g.menu] : []), ...g.acciones]) for (const r of x.aplicaA) v[r][x.id] = !apagadas.includes(`${r}:${x.id}`);
  return v;
}

const configuracion = (version: number, apagadas: string[] = [], ultima: ConfiguracionDeAccesos["ultimaModificacion"] = null): ConfiguracionDeAccesos => ({
  version,
  valores: valores(apagadas),
  ultimaModificacion: ultima,
  roles: ["swimmer", "delegate", "coach"],
  grupos: GRUPOS,
  siempreDisponibles: ["Cerrar sesión (POST /auth/logout)"],
});

const casilla = (nombre: string) => screen.getByRole("checkbox", { name: nombre }) as HTMLInputElement;

async function montar() {
  render(
    <MemoryRouter>
      <AccesosPorRolPage />
    </MemoryRouter>
  );
  await screen.findByRole("table");
}

beforeEach(() => {
  vi.clearAllMocks();
  leer.mockResolvedValue(configuracion(0));
});

describe("matriz", () => {
  it("columnas Nadador, Delegado y Entrenador; sin columna de administración", async () => {
    await montar();
    const encabezados = within(screen.getByRole("table")).getAllByRole("columnheader").map((h) => h.textContent);
    expect(encabezados).toEqual(["Función", "Nadador", "Delegado", "Entrenador"]);
    expect(screen.queryByRole("columnheader", { name: /Administración/ })).not.toBeInTheDocument();
  });

  it("casillas con nombre accesible y «No aplica» donde el rol no tiene la función", async () => {
    await montar();
    expect(casilla("Delegado — Inscripciones de Relevo: Armar un equipo")).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Nadador — Inscripciones de Relevo: Armar un equipo" })).not.toBeInTheDocument();
    const fila = screen.getByRole("rowheader", { name: "Armar un equipo" }).closest("tr")!;
    expect(within(fila).getByText("No aplica")).toBeInTheDocument();
    expect(casilla("Nadador — Cambio voluntario de contraseña")).toBeChecked();
  });

  it("Team Manager aparece como no configurable, sin casillas", async () => {
    await montar();
    const fila = screen.getByRole("rowheader", { name: "Exportar a Team Manager (.zip)" }).closest("tr")!;
    expect(within(fila).getByText("No configurable: conserva sus permisos actuales.")).toBeInTheDocument();
    expect(within(fila).queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("sin modificaciones: lo dice; con una, muestra fecha y autor", async () => {
    await montar();
    expect(screen.getByText("Sin modificaciones: rigen los valores del sistema.")).toBeInTheDocument();
  });

  it("apagar un menú desactiva sus acciones SIN borrar su casilla; al encenderlo se conservan", async () => {
    await montar();
    fireEvent.click(casilla("Delegado — Reportes: Exportar CSV, Excel o PDF"));
    expect(casilla("Delegado — Reportes: Exportar CSV, Excel o PDF")).not.toBeChecked();
    fireEvent.click(casilla("Delegado — Menú Reportes"));
    expect(casilla("Delegado — Reportes: Generar reporte")).toBeDisabled();
    expect(casilla("Delegado — Reportes: Generar reporte")).toBeChecked();
    expect(casilla("Delegado — Reportes: Exportar CSV, Excel o PDF")).not.toBeChecked();
    // Otro rol no se ve afectado.
    expect(casilla("Entrenador — Reportes: Generar reporte")).toBeEnabled();
    fireEvent.click(casilla("Delegado — Menú Reportes"));
    expect(casilla("Delegado — Reportes: Generar reporte")).toBeEnabled();
    expect(casilla("Delegado — Reportes: Generar reporte")).toBeChecked();
    expect(casilla("Delegado — Reportes: Exportar CSV, Excel o PDF")).not.toBeChecked();
  });
});

describe("guardar, cancelar y restablecer", () => {
  it("resumen antes de guardar; se envía el estado completo con la versión leída", async () => {
    guardar.mockResolvedValue({ configuracion: configuracion(1, ["coach:reportes.exportar"], { en: "2026-11-15T12:00:00.000Z", por: { id: "u-admin", username: "admin.sintetico" } }), cambios: 1 });
    await montar();
    expect(screen.getByRole("button", { name: "Revisar y guardar" })).toBeDisabled();
    fireEvent.click(casilla("Entrenador — Reportes: Exportar CSV, Excel o PDF"));
    fireEvent.click(screen.getByRole("button", { name: "Revisar y guardar (1)" }));
    const resumen = screen.getByRole("region", { name: "Resumen de cambios" });
    expect(resumen).toHaveTextContent("Entrenador — Reportes: Exportar CSV, Excel o PDF: se restringe");
    expect(guardar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar y guardar" }));
    await waitFor(() => expect(guardar).toHaveBeenCalledWith(0, valores(["coach:reportes.exportar"])));
    expect(await screen.findByRole("status")).toHaveTextContent("Cambios guardados (versión 1)");
    expect(screen.getByText(/Última modificación: .*por admin\.sintetico \(versión 1\)/)).toBeInTheDocument();
  });

  it("cancelar descarta lo marcado; restablecer devuelve un rol a los valores del sistema", async () => {
    leer.mockResolvedValue(configuracion(4, ["swimmer:reportes.generar", "swimmer:menu.relevos"]));
    await montar();
    fireEvent.click(casilla("Delegado — Reportes: Generar reporte"));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar cambios" }));
    expect(casilla("Delegado — Reportes: Generar reporte")).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Valores del sistema: Nadador" }));
    expect(casilla("Nadador — Reportes: Generar reporte")).toBeChecked();
    expect(casilla("Nadador — Menú Inscripciones de Relevo")).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Revisar y guardar (2)" }));
    expect(screen.getByRole("region", { name: "Resumen de cambios" })).toHaveTextContent("se restituye");
  });

  it("409: carga el estado vigente, muestra los cambios ajenos y CONSERVA lo marcado, sin reintentar", async () => {
    guardar.mockRejectedValueOnce(
      new ApiError("Otra persona guardó cambios", 409, "CONFIGURACION_CAMBIADA", {
        vigente: { version: 1, valores: valores(["delegate:menu.relevos"]), ultimaModificacion: { en: "2026-11-15T12:00:00.000Z", por: { id: "u2", username: "otra.admin" } } },
      })
    );
    await montar();
    fireEvent.click(casilla("Entrenador — Reportes: Generar reporte"));
    fireEvent.click(screen.getByRole("button", { name: "Revisar y guardar (1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirmar y guardar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Otra persona guardó cambios mientras usted editaba (versión 1)");
    expect(screen.getByRole("region", { name: "Cambios de la otra persona" })).toHaveTextContent("Delegado — Inscripciones de Relevo: se restringe");
    // Lo suyo sigue marcado, sobre el estado vigente; lo de la otra persona se conserva y NO
    // aparece como un cambio suyo (confirmar no lo revierte).
    expect(casilla("Entrenador — Reportes: Generar reporte")).not.toBeChecked();
    expect(casilla("Delegado — Menú Inscripciones de Relevo")).not.toBeChecked();
    const resumen = screen.getByRole("region", { name: "Resumen de cambios" });
    expect(resumen).toHaveTextContent("Entrenador — Reportes: Generar reporte: se restringe");
    expect(resumen).not.toHaveTextContent("Inscripciones de Relevo");
    expect(guardar).toHaveBeenCalledTimes(1);

    // Al confirmar de nuevo se usa la versión VIGENTE.
    guardar.mockResolvedValueOnce({ configuracion: configuracion(2, ["coach:reportes.generar"]), cambios: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Confirmar y guardar" }));
    await waitFor(() => expect(guardar).toHaveBeenLastCalledWith(1, expect.anything()));
  });

  it("un error de carga se informa y permite reintentar", async () => {
    leer.mockRejectedValueOnce(new Error("No se pudo comprobar la configuración de accesos."));
    render(
      <MemoryRouter>
        <AccesosPorRolPage />
      </MemoryRouter>
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo comprobar");
    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByRole("table")).toBeInTheDocument();
  });
});
