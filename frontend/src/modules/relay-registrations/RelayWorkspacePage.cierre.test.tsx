/**
 * PANEL DE RELEVOS en los dos estados de cierre.
 *
 * La distinción que estas pruebas protegen es el punto entero del cambio:
 *
 *   - «Inscripciones individuales cerradas» (cupo lleno) → este panel SIGUE
 *     operativo para un club: se alcanzó el cupo de nadadores, pero los
 *     relevos se forman con nadadores que ya lo ocupan;
 *   - «Inscripciones cerradas» → aquí no se puede nada, y no basta con
 *     esconder botones: la prueba tampoco se puede seleccionar con teclado.
 *
 * Y lo que estas pruebas NO son: una barrera de seguridad. El backend rechaza
 * igual estas operaciones; lo que se comprueba aquí es que la pantalla no
 * invite a intentar algo que va a fallar, y que diga por qué.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RelayWorkspacePage } from "./RelayWorkspacePage";

type Sesion = { ownerType: string; clubId: string | null; personId: string | null; roles: string[] };
let sesion: Sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };

vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: { id: "u1", username: "club-uno", ...sesion },
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

/** El estado de la competencia se cambia por prueba. */
let estadoCompetencia = "open";
const CLUBES = [{ id: "club-1", name: "Club Uno", code: "C1", status: "active" }];

const competitionsList = vi.fn(async () => ({
  items: [{ id: "comp-A", name: "Competencia A", status: estadoCompetencia, dates: [], ageCutoffDate: "2026-12-31" }],
  total: 1,
  page: 1,
  pageSize: 100,
}));
const clubsList = vi.fn(async () => ({ items: CLUBES, total: 1, page: 1, pageSize: 100 }));
const clubsGet = vi.fn(async () => CLUBES[0]!);
const getCurrentClub = vi.fn(async () => ({ club: { id: "club-1", name: "Club Uno" } }) as unknown);

const PRUEBA_DE_RELEVO = {
  id: "ce-relevo",
  displayOrder: 1,
  event: { distance: { meters: 200 }, stroke: { name: "Libre" }, gender: "mixed", testType: { swimmersCount: 4 } },
  competitionSession: { sessionType: { name: "Mañana" }, competitionDate: { date: "2026-03-01" } },
  enabledCategories: [{ category: { id: "cat", name: "Libre", minAge: 0, maxAge: 400 } }],
};

/**
 * Un equipo confirmado tal como lo devuelve la API. `competitionEvent` completo
 * no es opcional: `teamsForEvent` empareja por distancia, estilo y género, y sin
 * él la pantalla revienta al renderizar y React desmonta el árbol entero.
 */
const EQUIPO = {
  id: "t-1",
  competitionEventId: "ce-relevo",
  competitionEvent: PRUEBA_DE_RELEVO,
  club: { id: "club-1", name: "Club Uno" },
  category: { id: "cat", name: "Libre" },
  status: "confirmed",
  seedTimeCentiseconds: 12345,
  members: [1, 2, 3, 4].map((n) => ({
    orderPosition: n,
    person: { id: `p${n}`, fullName: `Nadador ${n}`, run: `${n}-${n}` },
  })),
};

const listEnabledEvents = vi.fn(async () => [PRUEBA_DE_RELEVO] as unknown[]);
const listClubSwimmers = vi.fn(async () => [] as unknown[]);
const relayList = vi.fn(async () => ({ items: [EQUIPO] as unknown[], total: 1, page: 1, pageSize: 50 }));

vi.mock("../competitions/competitionsApi", () => ({ useCompetitionsApi: () => ({ list: competitionsList }) }));
vi.mock("../clubs/clubsApi", () => ({ useClubsApi: () => ({ list: clubsList, get: clubsGet }) }));
vi.mock("../swimmer-assignment/assignmentApi", () => ({ useSwimmerAssignmentApi: () => ({ getCurrentClub }) }));
vi.mock("../registrations/registrationsApi", () => ({
  useRegistrationsApi: () => ({ listEnabledEvents, listClubSwimmers }),
}));
vi.mock("./relayRegistrationsApi", () => ({
  useRelayRegistrationsApi: () => ({ list: relayList, create: vi.fn(), cancel: vi.fn(), update: vi.fn() }),
}));

beforeEach(() => {
  sesion = { ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] };
  estadoCompetencia = "open";
  vi.clearAllMocks();
  // Las implementaciones se reestablecen aquí, como en la prueba hermana de
  // esta pantalla: la configuración de vitest las descarta entre casos, y sin
  // esto los servicios devuelven `undefined` y el panel no llega a pintar nada.
  competitionsList.mockImplementation(async () => ({
    items: [{ id: "comp-A", name: "Competencia A", status: estadoCompetencia, dates: [], ageCutoffDate: "2026-12-31" }],
    total: 1,
    page: 1,
    pageSize: 100,
  }));
  clubsList.mockResolvedValue({ items: CLUBES, total: 1, page: 1, pageSize: 100 });
  clubsGet.mockResolvedValue(CLUBES[0]!);
  getCurrentClub.mockResolvedValue({ club: { id: "club-1", name: "Club Uno" } });
  listEnabledEvents.mockResolvedValue([PRUEBA_DE_RELEVO]);
  listClubSwimmers.mockResolvedValue([]);
  relayList.mockResolvedValue({ items: [EQUIPO], total: 1, page: 1, pageSize: 50 });
});

/**
 * La página tiene varios `combobox` —los dos filtros y el separador
 * redimensionable de la barra lateral—, así que se elige por la etiqueta que
 * precede al desplegable, igual que en la prueba hermana de esta pantalla.
 */
function elegir(etiqueta: RegExp, valor: string) {
  const select = screen.getAllByRole("combobox").find((s) => (s.previousElementSibling?.textContent ?? "").match(etiqueta))!;
  fireEvent.change(select, { target: { value: valor } });
}

/**
 * Una cuenta de club trae el suyo ya resuelto y no ve el desplegable; un
 * administrador sí lo ve y tiene que elegirlo, o la vista nunca se carga.
 */
async function montarYElegir() {
  render(
    <MemoryRouter>
      <RelayWorkspacePage />
    </MemoryRouter>
  );
  await waitFor(() => expect(competitionsList).toHaveBeenCalled());
  elegir(/Competencia/, "comp-A");
  if (sesion.roles.includes("admin")) {
    await waitFor(() => expect(screen.getByRole("option", { name: "Club Uno" })).toBeInTheDocument());
    elegir(/^Club$/, "club-1");
  }
  await waitFor(() => expect(relayList).toHaveBeenCalled());
}

/**
 * La tarjeta de la prueba: su texto va partido entre el número en círculo y la
 * etiqueta, así que se busca el `strong` que las contiene a las dos y se sube
 * al contenedor, que es el que lleva el manejador de selección.
 */
const rotuloDePrueba = () =>
  screen.getAllByText((_t, el) => el?.tagName === "STRONG" && (el.textContent ?? "").includes("Relevo 4x50m"))[0]!;
const tarjetaDePrueba = () => rotuloDePrueba().parentElement!;

describe("competencia ABIERTA: todo operativo", () => {
  it("la prueba es seleccionable y los equipos tienen Editar y ×", async () => {
    await montarYElegir();
    expect(await screen.findByRole("button", { name: "Editar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "×" })).toBeInTheDocument();
    expect(screen.queryByText(/Inscripciones cerradas/i)).not.toBeInTheDocument();
  });
});

describe("«Inscripciones individuales cerradas»: los relevos SIGUEN abiertos", () => {
  beforeEach(() => {
    estadoCompetencia = "individual_closed";
  });

  it("avisa de que aquí sí se puede seguir trabajando", async () => {
    await montarYElegir();
    expect(await screen.findByText(/Los relevos siguen abiertos/i)).toBeInTheDocument();
    expect(screen.getByText(/inscripción individual confirmada/i)).toBeInTheDocument();
  });

  it("conserva Editar y × : es operación normal, no excepción", async () => {
    await montarYElegir();
    expect(await screen.findByRole("button", { name: "Editar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "×" })).toBeInTheDocument();
  });

  it("la prueba sigue siendo seleccionable, con ratón y con teclado", async () => {
    await montarYElegir();
    const tarjeta = tarjetaDePrueba();
    expect(tarjeta.getAttribute("aria-disabled")).not.toBe("true");
  });
});

describe("«Inscripciones cerradas»: nada operativo para un club", () => {
  beforeEach(() => {
    estadoCompetencia = "closed";
  });

  it("avisa del cierre y mantiene la consulta", async () => {
    await montarYElegir();
    expect(await screen.findByText(/Inscripciones cerradas/i)).toBeInTheDocument();
    expect(screen.getByText(/visibles para consulta/i)).toBeInTheDocument();
  });

  it("oculta Editar y ×", async () => {
    await montarYElegir();
    await screen.findByText(/Inscripciones cerradas/i);
    expect(screen.queryByRole("button", { name: "Editar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "×" })).not.toBeInTheDocument();
  });

  it("la prueba NO es alcanzable por teclado y se anuncia deshabilitada", async () => {
    /**
     * Sin `tabIndex` la tarjeta no recibe foco, así que no hay camino de
     * teclado hacia el constructor; `aria-disabled` lo anuncia.
     *
     * No se le pone `role="button"` a propósito: se intentó, y ARIA declara
     * presentacionales a los descendientes de un `role="button"`, de modo que
     * los botones de dentro —«Editar», «×»— desaparecían del árbol de
     * accesibilidad. La comprobación de abajo vigila que no vuelva a ponerse.
     */
    await montarYElegir();
    await screen.findByText(/Inscripciones cerradas/i);

    const tarjeta = tarjetaDePrueba();
    expect(tarjeta.getAttribute("tabindex"), "sin tabIndex no hay foco ni activación con Enter").toBeNull();
    expect(tarjeta.getAttribute("role"), "role=button ocultaría los botones que contiene").toBeNull();
    expect(tarjeta.getAttribute("aria-disabled")).toBe("true");
  });

  it("ni con ratón: al pulsar la prueba no aparece «Nuevo equipo»", async () => {
    await montarYElegir();
    await screen.findByText(/Inscripciones cerradas/i);

    fireEvent.click(tarjetaDePrueba());
    expect(screen.queryByText(/Nuevo equipo/i)).not.toBeInTheDocument();
  });
});

describe("un administrador conserva los controles en ambos cierres", () => {
  for (const estado of ["individual_closed", "closed"]) {
    it(`en '${estado}'`, async () => {
      sesion = { ownerType: "system", clubId: null, personId: null, roles: ["admin"] };
      estadoCompetencia = estado;
      await montarYElegir();
      expect(await screen.findByRole("button", { name: "Editar" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "×" })).toBeInTheDocument();
    });
  }
});
