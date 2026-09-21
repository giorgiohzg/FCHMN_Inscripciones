/**
 * Fase 6, hallazgo 28 — las PANTALLAS, no solo el ayudante.
 *
 * `paginacion.test.ts` prueba el mecanismo; esto prueba que las pantallas lo
 * usan y que, con más datos que el tamaño de página por omisión del backend, no
 * queda ningún elemento inalcanzable. Es la diferencia entre "el ayudante
 * funciona" y "Reportes ya no se come las competencias antiguas".
 *
 * Los servidores de mentira replican el contrato real: paginan de verdad, y el
 * `pageSize` por omisión es el del backend —20 en `competitions`, 20 en
 * `persons`—, que es el número con el que se producía el corte.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ReportsPage } from "./ReportsPage";

vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: { id: "u1", username: "admin", ownerType: "system", personId: null, clubId: null, roles: ["admin"] },
      accessToken: "t",
      permissions: ["reports:read"],
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

/**
 * El servidor simulado aplica un TECHO de 40 por página, por debajo del total.
 *
 * Con 45 competencias y el techo en 100 —que es lo que pide el ayudante— todo
 * cabía en una sola petición y la prueba no recorría nada: solo comprobaba que
 * se había pedido la página 1. Con el techo en 40, 90 competencias exigen tres
 * páginas de verdad.
 */
const TECHO_DEL_SERVIDOR = 40;
const TAMANO_COMPETICIONES = 20;
const COMPETENCIAS = 90;

const competitionsList = vi.fn(async (params: { page?: number; pageSize?: number } = {}) => {
  const pageSize = Math.min(params.pageSize ?? TAMANO_COMPETICIONES, TECHO_DEL_SERVIDOR);
  const page = params.page ?? 1;
  const desde = (page - 1) * pageSize;
  return {
    items: Array.from({ length: Math.max(0, Math.min(pageSize, COMPETENCIAS - desde)) }, (_, i) => ({
      id: `comp-${desde + i + 1}`,
      name: `Competencia ${desde + i + 1}`,
      status: "open",
      dates: [],
    })),
    total: COMPETENCIAS,
    page,
    pageSize,
  };
});

const clubsList = vi.fn(async (params: { page?: number; pageSize?: number } = {}) => ({
  items: [{ id: "club-1", name: "Club Uno" }],
  total: 1,
  page: params.page ?? 1,
  pageSize: params.pageSize ?? 20,
}));

vi.mock("../competitions/competitionsApi", () => ({
  useCompetitionsApi: () => ({ list: competitionsList }),
}));
vi.mock("../clubs/clubsApi", () => ({ useClubsApi: () => ({ list: clubsList }) }));
vi.mock("./reportsApi", () => ({ useReportsApi: () => ({ registrations: vi.fn(), export: vi.fn() }) }));

vi.mock("../swimmer-assignment/assignmentApi", () => ({
  useSwimmerAssignmentApi: () => ({
    list: vi.fn(async () => ({ items: [], total: 0, page: 1, pageSize: 20 })),
    getCurrentClub: vi.fn(async () => null),
    assignDirectly: vi.fn(),
    endMembership: vi.fn(),
  }),
}));

beforeEach(() => {
  competitionsList.mockClear();
});

describe("Reportes: el selector de competencias no se queda en la primera página", () => {
  it(`con ${COMPETENCIAS} competencias y páginas de ${TECHO_DEL_SERVIDOR} recorre TRES páginas`, async () => {
    render(
      <MemoryRouter>
        <ReportsPage />
      </MemoryRouter>
    );

    await waitFor(() => expect(screen.getByRole("option", { name: "Competencia 1" })).toBeInTheDocument());

    // EL ÚLTIMO ELEMENTO DE LA ÚLTIMA PÁGINA: el que se perdía.
    expect(
      screen.getByRole("option", { name: `Competencia ${COMPETENCIAS}` }),
      "la última competencia tiene que poder elegirse"
    ).toBeInTheDocument();
    // Y uno de la segunda página, para que no valga con la primera y la última.
    expect(screen.getByRole("option", { name: "Competencia 41" })).toBeInTheDocument();

    // Las TRES páginas, explícitamente: 90 elementos con techo de 40.
    expect(competitionsList.mock.calls.map((c) => c[0]?.page)).toEqual([1, 2, 3]);
    expect(screen.getAllByRole("option").length, "todas, más el marcador de vacío").toBeGreaterThanOrEqual(COMPETENCIAS);
  });
});
/**
 * El buscador del plantel (`ClubSwimmersSection`) ya no solo avisa: acumula
 * páginas hasta alcanzar a cualquiera. Eso se prueba, con selección incluida, en
 * `shared/useBusquedaDePersonas.test.tsx`.
 */
