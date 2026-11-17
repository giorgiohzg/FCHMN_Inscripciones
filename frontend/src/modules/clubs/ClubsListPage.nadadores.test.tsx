/**
 * Listado de Clubes: columna «Nadadores» (cifra que calcula el servidor). Datos sintéticos, jsdom.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const club = (id: string, name: string, nadadores?: number) => ({
  id,
  name,
  username: null,
  code: id.toUpperCase(),
  hasLegalStatus: false,
  rut: null,
  legalName: null,
  email: null,
  staff: [],
  isAchmnMember: false,
  isAchmnCollaborator: false,
  isFchmnMember: false,
  isFchmnCollaborator: false,
  status: "active",
  ...(nadadores === undefined ? {} : { nadadores }),
});

vi.mock("./clubsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clubsApi")>()),
  useClubsApi: () => ({
    list: vi.fn(async () => ({
      items: [club("alf", "Club Alfa", 1250), club("vac", "Club Vacío", 0), club("ant", "Club API anterior")],
      total: 3,
      page: 1,
      pageSize: 20,
    })),
    update: vi.fn(),
  }),
}));
vi.mock("../../shared/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { ClubsListPage } from "./ClubsListPage";

describe("ClubsListPage: columna Nadadores", () => {
  it("muestra la cantidad del servidor, el cero y «—» si la API no la envía", async () => {
    render(
      <MemoryRouter>
        <ClubsListPage />
      </MemoryRouter>
    );
    expect(await screen.findByRole("columnheader", { name: /Nadadores/ })).toBeInTheDocument();
    const fila = (nombre: string) => screen.getByRole("link", { name: nombre }).closest("tr")!;
    expect(within(fila("Club Alfa")).getByText("1.250")).toBeInTheDocument();
    expect(within(fila("Club Vacío")).getByText("0")).toBeInTheDocument();
    expect(within(fila("Club API anterior")).getAllByText("—").length).toBeGreaterThan(0);
  });
});
