/**
 * Reporte «Clubes y nadadores»: pantalla (grupos completos, vacíos, sin club, exportación) y
 * acceso exclusivo de administración por URL directa. Datos sintéticos, jsdom.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "../../shared/apiClient";
import type { ReporteClubesYNadadores } from "./reportsApi";

const getClubesYNadadores = vi.fn<() => Promise<ReporteClubesYNadadores>>();
const downloadClubesYNadadores = vi.fn(async (_f: string) => undefined);
vi.mock("./reportsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./reportsApi")>()),
  useReportsApi: () => ({ getClubesYNadadores, downloadClubesYNadadores }),
}));
vi.mock("../../shared/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("./ReportesNav", () => ({ ReportesNav: () => null }));

import { ClubesYNadadoresReportPage } from "./ClubesYNadadoresReportPage";

const REPORTE: ReporteClubesYNadadores = {
  clubes: [
    {
      clubId: "c1",
      clubName: "Club Alfa",
      sigla: "ALF",
      estado: "active",
      nadadores: [
        { personId: "p1", nombre: "ÁVILA SOTO, ANA" },
        { personId: "p2", nombre: "ZETA, LUIS" },
      ],
    },
    { clubId: "c2", clubName: "Club Vacío", sigla: "VAC", estado: "disabled", nadadores: [] },
  ],
  sinClub: [{ personId: "p3", nombre: "LIBRE, SOFÍA" }],
  revision: [],
  totales: { clubes: 2, nadadoresConClub: 2, sinClub: 1, enClubesEliminados: 0 },
};

const montar = () =>
  render(
    <MemoryRouter>
      <ClubesYNadadoresReportPage />
    </MemoryRouter>
  );

beforeEach(() => {
  getClubesYNadadores.mockReset();
  downloadClubesYNadadores.mockClear();
});

describe("ClubesYNadadoresReportPage", () => {
  it("muestra cada club con sus nadadores, los clubes vacíos y «Sin club asignado», sin pedir una competencia", async () => {
    getClubesYNadadores.mockResolvedValue(REPORTE);
    montar();
    const alfa = await screen.findByRole("region", { name: /Club Alfa/ });
    expect(
      within(alfa)
        .getAllByRole("listitem")
        .map((li) => li.textContent)
    ).toEqual(["ÁVILA SOTO, ANA", "ZETA, LUIS"]);
    const vacio = screen.getByRole("region", { name: /Club Vacío/ });
    expect(within(vacio).getByText("Sin nadadores.")).toBeInTheDocument();
    expect(within(vacio).getByText(/club inhabilitado/)).toBeInTheDocument();
    const sinClub = screen.getByRole("region", { name: /Sin club asignado/ });
    expect(within(sinClub).getByText("LIBRE, SOFÍA")).toBeInTheDocument();
    expect(screen.queryByLabelText(/competencia/i)).not.toBeInTheDocument();
    expect(getClubesYNadadores).toHaveBeenCalledWith();
  });

  it("exporta CSV, Excel y PDF desde el servidor", async () => {
    getClubesYNadadores.mockResolvedValue(REPORTE);
    montar();
    await screen.findByRole("region", { name: /Club Alfa/ });
    for (const [boton, formato] of [
      ["Exportar CSV", "csv"],
      ["Exportar Excel", "xlsx"],
      ["Exportar PDF", "pdf"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: boton }));
      await waitFor(() => expect(downloadClubesYNadadores).toHaveBeenLastCalledWith(formato));
    }
  });

  it("lista aparte, para revisión, a quienes tienen membresía activa en un club eliminado (no como sin club)", async () => {
    getClubesYNadadores.mockResolvedValue({
      ...REPORTE,
      revision: [{ clubId: "c9", clubName: "Club Disuelto", sigla: "DIS", personas: [{ personId: "p9", nombre: "ÑUÑOA, INÉS" }] }],
      totales: { ...REPORTE.totales, enClubesEliminados: 1 },
    });
    montar();
    const revision = await screen.findByRole("region", { name: /Revisión: membresía activa en un club eliminado/ });
    expect(within(revision).getByText("ÑUÑOA, INÉS")).toBeInTheDocument();
    expect(within(revision).getByText(/Club Disuelto/)).toBeInTheDocument();
    const sinClub = screen.getByRole("region", { name: /Sin club asignado/ });
    expect(within(sinClub).queryByText("ÑUÑOA, INÉS")).not.toBeInTheDocument();
    expect(screen.getByText(/1 con membresía activa en un club/)).toBeInTheDocument();
    // Orden: clubes, revisión y, como ÚLTIMA sección, «Sin club asignado» (igual que las exportaciones).
    const secciones = screen.getAllByRole("region").map((r) => r.getAttribute("aria-labelledby"));
    expect(secciones).toEqual(["club-c1", "club-c2", "revision-clubes-eliminados", "sin-club"]);
  });

  it("sin personas en clubes eliminados no muestra la sección de revisión", async () => {
    getClubesYNadadores.mockResolvedValue(REPORTE);
    montar();
    await screen.findByRole("region", { name: /Club Alfa/ });
    expect(screen.queryByRole("region", { name: /Revisión/ })).not.toBeInTheDocument();
  });

  it("un 403 dice que es exclusivo de administración y no ofrece reintentar", async () => {
    getClubesYNadadores.mockRejectedValue(new ApiError("Prohibido", 403));
    montar();
    expect(await screen.findByText("Este reporte es exclusivo de administración.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reintentar" })).not.toBeInTheDocument();
  });
});
