/**
 * COMPETENCIA POR DEFECTO en el Panel de Inscripción y en el Panel de Relevos.
 *
 *  - Se preselecciona solo si está en la lista que esa cuenta puede elegir. El servidor de mentira
 *    imita el filtro: con `visibleInRegistrationPanels: true` no devuelve las ocultas.
 *  - Administración conserva su excepción: ve las ocultas, también la predeterminada oculta.
 *  - Sin predeterminada accesible el selector queda sin elección.
 *  - Una elección manual (incluido volver a «Seleccionar...») no la pisa una carga posterior.
 *
 * Que el servidor marque como máximo una y respete la visibilidad lo prueba
 * `competencia-predeterminada.integration.test.ts`. Datos sintéticos.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RegistrationWorkspacePage } from "../registrations/RegistrationWorkspacePage";
import { RelayWorkspacePage } from "../relay-registrations/RelayWorkspacePage";

type Sesion = { ownerType: string; clubId: string | null; personId: string | null; roles: string[] };
let sesion: Sesion = { ownerType: "system", clubId: null, personId: null, roles: ["admin"] };

vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: { id: "u1", username: "quien-sea", ...sesion },
      accessToken: "t",
      permissions: ["registrations:read", "registrations:write"],
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
const servidorVacio = (extra: Record<string, unknown> = {}) =>
  new Proxy(extra, { get: (t, p: string) => (p in t ? t[p] : vi.fn(vacia)) });

interface Comp {
  id: string;
  name: string;
  status: string;
  visibleInRegistrationPanels: boolean;
  esPredeterminada: boolean;
}
let competencias: Comp[] = [];
/** Devuelve lo que el servidor devolvería con ese filtro; `retrasar` deja la respuesta en espera. */
let retrasar: Promise<void> | null = null;
const competitionsList = vi.fn(async (params: { visibleInRegistrationPanels?: boolean }) => {
  if (retrasar) await retrasar;
  const items = competencias.filter((c) => params.visibleInRegistrationPanels === undefined || c.visibleInRegistrationPanels === params.visibleInRegistrationPanels);
  return { items, total: items.length, page: 1, pageSize: 100 };
});

vi.mock("./competitionsApi", () => ({ useCompetitionsApi: () => ({ list: competitionsList }) }));
vi.mock("../clubs/clubsApi", () => ({ useClubsApi: () => servidorVacio({ get: vi.fn(async () => ({ id: "club-1", name: "Club Uno" })) }) }));
vi.mock("../registrations/registrationsApi", () => ({ useRegistrationsApi: () => servidorVacio({ listEnabledEvents: vi.fn(async () => []), listClubEligibilityMatrix: vi.fn(async () => []), listClubSwimmers: vi.fn(async () => []) }) }));
vi.mock("../relay-registrations/relayRegistrationsApi", () => ({ useRelayRegistrationsApi: () => servidorVacio() }));
vi.mock("../swimmer-assignment/assignmentApi", () => ({ useSwimmerAssignmentApi: () => servidorVacio({ getCurrentClub: vi.fn(async () => null) }) }));

const comp = (id: string, opciones: Partial<Comp> = {}): Comp => ({ id, name: `Competencia ${id}`, status: "open", visibleInRegistrationPanels: true, esPredeterminada: false, ...opciones });
const DELEGADO: Sesion = { ownerType: "person", clubId: "club-1", personId: "p-1", roles: ["delegate"] };
const ADMIN: Sesion = { ownerType: "system", clubId: null, personId: null, roles: ["admin"] };

const PANTALLAS = { "Panel de Inscripción": RegistrationWorkspacePage, "Panel de Relevos": RelayWorkspacePage } as const;
const selector = () => screen.getByRole("combobox", { name: "Competencia" }) as HTMLSelectElement;

beforeEach(() => {
  sesion = ADMIN;
  retrasar = null;
  competencias = [];
  competitionsList.mockClear();
});

for (const [nombre, Pantalla] of Object.entries(PANTALLAS)) {
  const montar = () =>
    render(
      <MemoryRouter>
        <Pantalla />
      </MemoryRouter>
    );

  describe(nombre, () => {
    it("preselecciona la predeterminada visible para quien no administra", async () => {
      sesion = DELEGADO;
      competencias = [comp("A"), comp("B", { esPredeterminada: true })];
      montar();
      await waitFor(() => expect(selector().value).toBe("B"));
    });

    it("una predeterminada OCULTA: el delegado queda sin elección; administración la ve preseleccionada", async () => {
      competencias = [comp("A"), comp("B"), comp("O", { visibleInRegistrationPanels: false, esPredeterminada: true })];
      sesion = DELEGADO;
      const { unmount } = montar();
      await waitFor(() => expect(competitionsList).toHaveBeenCalled());
      await waitFor(() => expect(selector().options).toHaveLength(3));
      expect(selector().value).toBe("");
      unmount();

      sesion = ADMIN;
      montar();
      await waitFor(() => expect(selector().value).toBe("O"));
    });

    it("sin predeterminada el selector queda sin elección", async () => {
      competencias = [comp("A"), comp("B")];
      montar();
      await waitFor(() => expect(selector().options).toHaveLength(3));
      expect(selector().value).toBe("");
    });

    it("la elección manual sobrevive a una carga posterior, también si eligió «Seleccionar...»", async () => {
      sesion = DELEGADO;
      competencias = [comp("A"), comp("B", { esPredeterminada: true })];
      const { rerender } = montar();
      await waitFor(() => expect(selector().value).toBe("B"));

      // Vuelve a «Seleccionar...» a mano.
      fireEvent.change(selector(), { target: { value: "" } });
      expect(selector().value).toBe("");

      // Una recarga de la lista (la sesión pasa a administración) llega TARDE y con la marca.
      let soltar!: () => void;
      retrasar = new Promise<void>((r) => (soltar = r));
      sesion = ADMIN;
      rerender(
        <MemoryRouter>
          <Pantalla />
        </MemoryRouter>
      );
      await waitFor(() => expect(competitionsList).toHaveBeenCalledTimes(2));
      await act(async () => {
        soltar();
        await competitionsList.mock.results[1]!.value;
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(selector().value, "no se reaplica la predeterminada").toBe("");

      // Y una elección concreta tampoco cambia.
      fireEvent.change(selector(), { target: { value: "A" } });
      expect(selector().value).toBe("A");
    });
  });
}

/**
 * SELECCIÓN QUE DEJA DE ESTAR DISPONIBLE (corrección antes de publicar).
 *
 * Una cuenta con administración y además personal de club (tiene club propio) entra con una
 * competencia OCULTA seleccionada; la misma pantalla sigue montada y la cuenta pierde
 * administración: la lista nueva ya no trae esa competencia. La selección debe quedar VACÍA (sin
 * sustituirla por otra, aunque haya una predeterminada visible) y su contenido dejar de mostrarse.
 * Es una incoherencia de selección y presentación: el servidor ya rechaza lo que corresponde.
 */
const ADMIN_CON_CLUB: Sesion = { ownerType: "person", clubId: "club-1", personId: "p-1", roles: ["admin", "delegate"] };
const SOLO_DELEGADO: Sesion = { ownerType: "person", clubId: "club-1", personId: "p-1", roles: ["delegate"] };
const AVISO_SIN_ELECCION = /Elija una competencia y un club/;

for (const [nombre, Pantalla] of Object.entries(PANTALLAS)) {
  const vista = () => (
    <MemoryRouter>
      <Pantalla />
    </MemoryRouter>
  );
  /** Vuelve a pintar la MISMA pantalla montada con la sesión indicada. */
  const cambiarSesion = (rerender: (ui: React.ReactElement) => void, s: Sesion) => {
    sesion = s;
    rerender(vista());
  };

  describe(`${nombre}: una selección que deja de estar disponible`, () => {
    it("la predeterminada oculta preseleccionada por administración se limpia al perder administración, sin sustituirla", async () => {
      competencias = [comp("A"), comp("B"), comp("O", { visibleInRegistrationPanels: false, esPredeterminada: true })];
      sesion = ADMIN_CON_CLUB;
      const { rerender } = render(vista());
      await waitFor(() => expect(selector().value).toBe("O"));
      await waitFor(() => expect(screen.queryByText(AVISO_SIN_ELECCION)).toBeNull());

      cambiarSesion(rerender, SOLO_DELEGADO);
      await waitFor(() => expect(competitionsList).toHaveBeenCalledTimes(2));
      await waitFor(() => expect([...selector().options].map((o) => o.value)).toEqual(["", "A", "B"]));
      expect(selector().value).toBe("");
      // El contenido de la competencia descartada deja de mostrarse.
      expect(await screen.findByText(AVISO_SIN_ELECCION)).toBeInTheDocument();
    });

    it("una selección MANUAL que desaparece de la lista también se limpia, y no se reemplaza por la predeterminada", async () => {
      competencias = [comp("A"), comp("B", { esPredeterminada: true }), comp("O", { visibleInRegistrationPanels: false })];
      sesion = ADMIN_CON_CLUB;
      const { rerender } = render(vista());
      await waitFor(() => expect(selector().value).toBe("B"));
      fireEvent.change(selector(), { target: { value: "O" } });
      await waitFor(() => expect(screen.queryByText(AVISO_SIN_ELECCION)).toBeNull());

      cambiarSesion(rerender, SOLO_DELEGADO);
      await waitFor(() => expect(competitionsList).toHaveBeenCalledTimes(2));
      await waitFor(() => expect([...selector().options].map((o) => o.value)).toEqual(["", "A", "B"]));
      expect(selector().value).toBe("");
      expect(await screen.findByText(AVISO_SIN_ELECCION)).toBeInTheDocument();
    });

    it("una selección manual que SIGUE disponible se conserva al cambiar la lista", async () => {
      competencias = [comp("A"), comp("B", { esPredeterminada: true }), comp("O", { visibleInRegistrationPanels: false })];
      sesion = ADMIN_CON_CLUB;
      const { rerender } = render(vista());
      await waitFor(() => expect(selector().value).toBe("B"));
      fireEvent.change(selector(), { target: { value: "A" } });

      cambiarSesion(rerender, SOLO_DELEGADO);
      await waitFor(() => expect(competitionsList).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(selector().options).toHaveLength(3));
      expect(selector().value).toBe("A");
    });

    it("una respuesta TARDÍA de la carga administrativa no restaura opciones ni la selección descartada", async () => {
      competencias = [comp("A"), comp("B"), comp("O", { visibleInRegistrationPanels: false, esPredeterminada: true })];
      // La carga administrativa queda en espera; la de delegado responde enseguida.
      let soltarAdmin!: () => void;
      const esperaAdmin = new Promise<void>((r) => (soltarAdmin = r));
      competitionsList.mockImplementationOnce(async (params: { visibleInRegistrationPanels?: boolean }) => {
        await esperaAdmin;
        const items = competencias.filter((c) => params.visibleInRegistrationPanels === undefined || c.visibleInRegistrationPanels);
        return { items, total: items.length, page: 1, pageSize: 100 };
      });
      sesion = ADMIN_CON_CLUB;
      const { rerender } = render(vista());
      await waitFor(() => expect(competitionsList).toHaveBeenCalledTimes(1));

      cambiarSesion(rerender, SOLO_DELEGADO);
      await waitFor(() => expect([...selector().options].map((o) => o.value)).toEqual(["", "A", "B"]));

      await act(async () => {
        soltarAdmin();
        await competitionsList.mock.results[0]!.value;
        await new Promise((r) => setTimeout(r, 0));
      });
      expect([...selector().options].map((o) => o.value)).toEqual(["", "A", "B"]);
      expect(selector().value).toBe("");
      expect(screen.getByText(AVISO_SIN_ELECCION)).toBeInTheDocument();
    });
  });
}
