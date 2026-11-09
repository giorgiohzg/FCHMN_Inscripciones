/**
 * QUIÉN envía el filtro de visibilidad y quién no.
 *
 * Ocultar una competencia la quita de los desplegables de Inscripción, Relevos y Reportes para
 * quienes NO son administradores. Administración (también si combina otros roles) los ve completos:
 * omite el parámetro, porque enviar `false` traería solo las ocultas. Los dos asistentes conservan
 * su listado de siempre y no envían el filtro.
 *
 * Se renderizan las pantallas con servidores de mentira y se mira qué parámetros llegan a
 * `competitionsApi.list`. Que el servidor aplique el filtro lo prueban las pruebas de integración del backend.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RegistrationWorkspacePage } from "../registrations/RegistrationWorkspacePage";
import { RelayWorkspacePage } from "../relay-registrations/RelayWorkspacePage";
import { RegistrationWizardPage } from "../registrations/RegistrationWizardPage";
import { RelayRegistrationWizardPage } from "../relay-registrations/RelayRegistrationWizardPage";
import { ReportsPage } from "../reports/ReportsPage";

type Sesion = { ownerType: string; clubId: string | null; personId: string | null; roles: string[] };
let sesion: Sesion = { ownerType: "system", clubId: null, personId: null, roles: ["admin"] };

vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: { id: "u1", username: "quien-sea", ...sesion },
      accessToken: "t",
      permissions: ["registrations:read", "registrations:write", "reports:read"],
      mustChangePassword: false,
      hasRole: (r: string) => sesion.roles.includes(r),
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
vi.mock("../../shared/ToastProvider", async () => {
  const real = await vi.importActual<typeof import("../../shared/ToastProvider")>("../../shared/ToastProvider");
  return { ...real, useToast: () => ({ showToast: vi.fn() }) };
});

const vacia = async () => ({ items: [] as unknown[], total: 0, page: 1, pageSize: 100 });
const competitionsList = vi.fn(vacia);

/** Cualquier método que la pantalla pida de estos servidores responde con una página vacía. */
const servidorVacio = (extra: Record<string, unknown> = {}) =>
  new Proxy(extra, { get: (t, p: string) => (p in t ? t[p] : vi.fn(vacia)) });

vi.mock("./competitionsApi", () => ({ useCompetitionsApi: () => ({ list: competitionsList }) }));
vi.mock("../clubs/clubsApi", () => ({ useClubsApi: () => servidorVacio() }));
vi.mock("../registrations/registrationsApi", () => ({ useRegistrationsApi: () => servidorVacio() }));
vi.mock("../relay-registrations/relayRegistrationsApi", () => ({ useRelayRegistrationsApi: () => servidorVacio() }));
vi.mock("../reports/reportsApi", () => ({ useReportsApi: () => servidorVacio() }));
vi.mock("../swimmer-assignment/assignmentApi", () => ({
  useSwimmerAssignmentApi: () => servidorVacio({ getCurrentClub: vi.fn(async () => null) }),
}));

const PANTALLAS = {
  "Panel de Inscripción": RegistrationWorkspacePage,
  "Panel de Relevos": RelayWorkspacePage,
  Reportes: ReportsPage,
  "Asistente de inscripción": RegistrationWizardPage,
  "Asistente de relevos": RelayRegistrationWizardPage,
} as const;

async function parametrosQueEnvia(Pantalla: () => JSX.Element) {
  competitionsList.mockClear();
  render(
    <MemoryRouter>
      <Pantalla />
    </MemoryRouter>
  );
  await waitFor(() => expect(competitionsList).toHaveBeenCalled());
  return competitionsList.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);
}

beforeEach(() => {
  competitionsList.mockReset().mockImplementation(vacia);
  sesion = { ownerType: "system", clubId: null, personId: null, roles: ["admin"] };
});

describe("los tres selectores piden solo las visibles, salvo para administración", () => {
  const noAdmin: [string, Sesion][] = [
    ["personal de club", { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] }],
    ["delegado (delegate)", { ownerType: "person", clubId: "club-1", personId: "p-1", roles: ["delegate"] }],
    ["entrenador (coach)", { ownerType: "person", clubId: "club-1", personId: "p-3", roles: ["coach"] }],
    ["representante legal (legal_representative)", { ownerType: "person", clubId: "club-1", personId: "p-4", roles: ["legal_representative"] }],
    ["nadador", { ownerType: "person", clubId: null, personId: "p-2", roles: ["swimmer"] }],
  ];
  const admin: [string, Sesion][] = [
    ["administrador", { ownerType: "system", clubId: null, personId: null, roles: ["admin"] }],
    ["administrador con otro rol", { ownerType: "system", clubId: null, personId: null, roles: ["club", "admin"] }],
    ["administrador con otro rol y club", { ownerType: "club", clubId: "club-1", personId: null, roles: ["delegate", "admin"] }],
  ];
  const selectores = ["Panel de Inscripción", "Panel de Relevos", "Reportes"] as const;

  for (const nombre of selectores) {
    for (const [rol, s] of noAdmin) {
      it(`${nombre} — ${rol}: TODAS las páginas llevan visibleInRegistrationPanels: true`, async () => {
        sesion = s;
        const llamadas = await parametrosQueEnvia(PANTALLAS[nombre]);
        expect(llamadas.length).toBeGreaterThan(0);
        for (const parametros of llamadas) expect(parametros.visibleInRegistrationPanels).toBe(true);
      });
    }
    for (const [rol, s] of admin) {
      it(`${nombre} — ${rol}: omite el parámetro (nunca envía false)`, async () => {
        sesion = s;
        const llamadas = await parametrosQueEnvia(PANTALLAS[nombre]);
        expect(llamadas.length).toBeGreaterThan(0);
        for (const parametros of llamadas) expect(parametros).not.toHaveProperty("visibleInRegistrationPanels");
      });
    }
  }
});

describe("los asistentes conservan su listado: NO envían el filtro", () => {
  for (const nombre of ["Asistente de inscripción", "Asistente de relevos"] as const) {
    it(`${nombre}: ningún parámetro de visibilidad`, async () => {
      const llamadas = await parametrosQueEnvia(PANTALLAS[nombre]);
      for (const parametros of llamadas) expect(parametros).not.toHaveProperty("visibleInRegistrationPanels");
    });
  }

  it("los asistentes siguen pidiendo solo las abiertas, como antes", async () => {
    for (const nombre of ["Asistente de inscripción", "Asistente de relevos"] as const) {
      const llamadas = await parametrosQueEnvia(PANTALLAS[nombre]);
      for (const parametros of llamadas) expect(parametros.status).toBe("open");
    }
  });
});
