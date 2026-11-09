/**
 * Lo que se ve en los desplegables de competencias de Inscripción, Relevos y Reportes.
 *
 * Un servidor de mentira con 130 competencias visibles y 12 ocultas aplica el filtro como el real
 * (solo si llega `visibleInRegistrationPanels`) y pagina de verdad: se comprueba que quien no es administrador
 * no ve ninguna oculta, que administración ve las 142, y que la paginación completa se conserva.
 * Son pruebas simuladas (jsdom), no comprobaciones en navegador.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RegistrationWorkspacePage } from "../registrations/RegistrationWorkspacePage";
import { RelayWorkspacePage } from "../relay-registrations/RelayWorkspacePage";
import { ReportsPage } from "../reports/ReportsPage";

let roles: string[] = ["admin"];
let clubId: string | null = null;
vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: { id: "u1", username: "x", ownerType: clubId ? "club" : "system", clubId, personId: null, roles },
      accessToken: "t",
      permissions: [],
      mustChangePassword: false,
      hasRole: (r: string) => roles.includes(r),
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

const VISIBLES = 130;
const OCULTAS = 12;
const todas = [
  ...Array.from({ length: VISIBLES }, (_, i) => ({ id: `v${i}`, name: `Visible ${i}`, status: "open", visibleInRegistrationPanels: true })),
  ...Array.from({ length: OCULTAS }, (_, i) => ({ id: `o${i}`, name: `Oculta ${i}`, status: "open", visibleInRegistrationPanels: false })),
];
const listPorOmision = async (p: { visibleInRegistrationPanels?: boolean; page?: number; pageSize?: number }) => {
  const base = p.visibleInRegistrationPanels === undefined ? todas : todas.filter((c) => c.visibleInRegistrationPanels === p.visibleInRegistrationPanels);
  const page = p.page ?? 1;
  const pageSize = p.pageSize ?? 20;
  return { items: base.slice((page - 1) * pageSize, page * pageSize), total: base.length, page, pageSize };
};
const list = vi.fn(listPorOmision);
const vacia = async () => ({ items: [] as unknown[], total: 0, page: 1, pageSize: 100 });
const servidorVacio = () => new Proxy({}, { get: () => vi.fn(vacia) });

vi.mock("./competitionsApi", () => ({ useCompetitionsApi: () => ({ list }) }));
vi.mock("../clubs/clubsApi", () => ({ useClubsApi: () => servidorVacio() }));
vi.mock("../registrations/registrationsApi", () => ({ useRegistrationsApi: () => servidorVacio() }));
vi.mock("../relay-registrations/relayRegistrationsApi", () => ({ useRelayRegistrationsApi: () => servidorVacio() }));
vi.mock("../reports/reportsApi", () => ({ useReportsApi: () => servidorVacio() }));
vi.mock("../swimmer-assignment/assignmentApi", () => ({ useSwimmerAssignmentApi: () => servidorVacio() }));

const PANTALLAS = { Inscripción: RegistrationWorkspacePage, Relevos: RelayWorkspacePage, Reportes: ReportsPage } as const;

async function opcionesDeCompetencias(Pantalla: () => JSX.Element, esperadas: number) {
  const { container } = render(
    <MemoryRouter>
      <Pantalla />
    </MemoryRouter>
  );
  const nombres = () => Array.from(container.querySelectorAll("option")).map((o) => o.textContent ?? "").filter((t) => /^(Visible|Oculta) \d+/.test(t));
  await waitFor(() => expect(nombres().length).toBe(esperadas));
  return nombres();
}

beforeEach(() => {
  list.mockImplementation(listPorOmision);
  list.mockClear();
  roles = ["admin"];
  clubId = null;
});

describe.each(Object.entries(PANTALLAS))("selector de %s", (_n, Pantalla) => {
  it("no administración: solo las visibles, todas las páginas (130, más de una página de 100)", async () => {
    roles = ["club"];
    clubId = "club-1";
    const op = await opcionesDeCompetencias(Pantalla, VISIBLES);
    expect(op.some((t) => t.startsWith("Oculta"))).toBe(false);
    expect(list.mock.calls.length).toBeGreaterThan(1);
  });

  it("administración: visibles y ocultas, todas las páginas", async () => {
    const op = await opcionesDeCompetencias(Pantalla, VISIBLES + OCULTAS);
    expect(op.filter((t) => t.startsWith("Oculta"))).toHaveLength(OCULTAS);
  });

  it("administración combinada con otro rol: prevalece la excepción administrativa", async () => {
    roles = ["club", "admin"];
    clubId = "club-1";
    const op = await opcionesDeCompetencias(Pantalla, VISIBLES + OCULTAS);
    expect(op.filter((t) => t.startsWith("Oculta"))).toHaveLength(OCULTAS);
  });

  it("una sesión estable no provoca recargas repetidas del listado", async () => {
    const { rerender } = render(
      <MemoryRouter>
        <Pantalla />
      </MemoryRouter>
    );
    await waitFor(() => expect(list).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    const antes = list.mock.calls.length;
    rerender(
      <MemoryRouter>
        <Pantalla />
      </MemoryRouter>
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(list.mock.calls.length).toBe(antes);
  });
});

/** Deja que se resuelvan todas las promesas encadenadas ya encoladas (no es una espera de tiempo). */
const vaciarMicrotareas = () => act(async () => { await new Promise<void>((r) => setTimeout(r, 0)); });

/** Promesa controlada: el orden de llegada de las respuestas lo decide la prueba, no un temporizador. */
function diferida<T>() {
  let resolver!: (v: T) => void;
  const promesa = new Promise<T>((r) => (resolver = r));
  return { promesa, resolver };
}

describe.each(Object.entries(PANTALLAS))("cambio de rol en el selector de %s, sin desmontar", (_n, Pantalla) => {
  type Respuesta = Awaited<ReturnType<typeof list>>;
  const pagina = (items: typeof todas): Respuesta => ({ items, total: items.length, page: 1, pageSize: 100 });
  const visiblesSolo = todas.filter((c) => c.visibleInRegistrationPanels).slice(0, 3);
  const todasChicas = [...visiblesSolo, ...todas.filter((c) => !c.visibleInRegistrationPanels).slice(0, 2)];
  const nombres = (cont: HTMLElement) => Array.from(cont.querySelectorAll("option")).map((o) => o.textContent ?? "").filter((t) => /^(Visible|Oculta) \d+/.test(t));
  const montar = () => {
    const ui = () => (
      <MemoryRouter>
        <Pantalla />
      </MemoryRouter>
    );
    const r = render(ui());
    return { cont: r.container, rerender: () => r.rerender(ui()) };
  };

  it("de no administrador a administrador: recarga omitiendo el parámetro y la respuesta tardía de antes no pisa las opciones nuevas", async () => {
    roles = ["club"];
    clubId = "club-1";
    const pendientes: { params: Record<string, unknown>; resolver: (v: Respuesta) => void }[] = [];
    list.mockImplementation((p) => {
      const d = diferida<Respuesta>();
      pendientes.push({ params: p, resolver: d.resolver });
      return d.promesa;
    });
    const { cont, rerender } = montar();
    await waitFor(() => expect(pendientes).toHaveLength(1));
    expect(pendientes[0]!.params.visibleInRegistrationPanels).toBe(true);

    roles = ["club", "admin"];
    rerender();
    await waitFor(() => expect(pendientes).toHaveLength(2));
    expect(pendientes[1]!.params).not.toHaveProperty("visibleInRegistrationPanels");

    pendientes[1]!.resolver(pagina(todasChicas));
    await waitFor(() => expect(nombres(cont)).toHaveLength(todasChicas.length));
    // Llega tarde la respuesta de la condición anterior: no sustituye las opciones nuevas.
    pendientes[0]!.resolver(pagina(visiblesSolo));
    await vaciarMicrotareas();
    expect(nombres(cont)).toHaveLength(todasChicas.length);
    expect(pendientes).toHaveLength(2);
  });

  it("al perder admin: recarga con visibleInRegistrationPanels=true y la respuesta tardía de antes no pisa las opciones nuevas", async () => {
    roles = ["admin"];
    clubId = null;
    const pendientes: { params: Record<string, unknown>; resolver: (v: Respuesta) => void }[] = [];
    list.mockImplementation((p) => {
      const d = diferida<Respuesta>();
      pendientes.push({ params: p, resolver: d.resolver });
      return d.promesa;
    });
    const { cont, rerender } = montar();
    await waitFor(() => expect(pendientes).toHaveLength(1));
    expect(pendientes[0]!.params).not.toHaveProperty("visibleInRegistrationPanels");

    roles = ["club"];
    clubId = "club-1";
    rerender();
    await waitFor(() => expect(pendientes).toHaveLength(2));
    expect(pendientes[1]!.params.visibleInRegistrationPanels).toBe(true);

    pendientes[1]!.resolver(pagina(visiblesSolo));
    await waitFor(() => expect(nombres(cont)).toHaveLength(visiblesSolo.length));
    // La respuesta administrativa (con ocultas) llega tarde: no debe reaparecer ninguna oculta.
    pendientes[0]!.resolver(pagina(todasChicas));
    await vaciarMicrotareas();
    expect(nombres(cont).some((t) => t.startsWith("Oculta"))).toBe(false);
    expect(nombres(cont)).toHaveLength(visiblesSolo.length);
  });
});
