/**
 * Orden y presentación de nadadores DENTRO de los dos paneles: plantel ordenado por apellido
 * paterno, materno y nombre, con el formato `PATERNO MATERNO, NOMBRE (EDAD)`, la edad que envía el
 * servidor, los registros incompletos al final con su alternativa, y las inscripciones de cada
 * prueba también ordenadas. Los identificadores y la selección no cambian. API simulada; datos
 * sintéticos. (Las reglas del formato se prueban en `shared/nombreDeNadador.test.ts`.)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { RegistrationWorkspacePage } from "./RegistrationWorkspacePage";
import { RelayWorkspacePage } from "../relay-registrations/RelayWorkspacePage";

vi.mock("../auth/AuthContext", async () => {
  const real = await vi.importActual<typeof import("../auth/AuthContext")>("../auth/AuthContext");
  return {
    ...real,
    useAuth: () => ({
      user: { id: "u1", username: "club", ownerType: "club", clubId: "club-1", personId: null, roles: ["club"] },
      accessToken: "t",
      permissions: ["registrations:read", "registrations:write"],
      mustChangePassword: false,
      hasRole: (r: string) => r === "club",
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
const COMPETENCIA = { id: "comp-A", name: "Competencia A", status: "open", ageCutoffDate: "2027-12-31T00:00:00.000Z", esPredeterminada: true };
const PERSONAS = [
  { id: "p-hist", firstName: null, paternalLastName: null, maternalLastName: null, fullName: "Registro Histórico Sintético", edad: 61 },
  { id: "p-z", firstName: "Ana", paternalLastName: "Zeta", maternalLastName: null, fullName: "Ana Zeta", edad: 30 },
  { id: "p-b2", firstName: "Zoe", paternalLastName: "Bravo", maternalLastName: "Castro", fullName: "Zoe Bravo Castro", edad: 41 },
  { id: "p-b1", firstName: "Ana", paternalLastName: "Bravo", maternalLastName: "Castro", fullName: "Ana Bravo Castro", edad: 54 },
  { id: "p-a", firstName: "Luis", paternalLastName: "Álvarez", maternalLastName: "Díaz", fullName: "Luis Álvarez Díaz", edad: 47 },
];
const ESPERADO = ["ÁLVAREZ DÍAZ, LUIS (47)", "BRAVO CASTRO, ANA (54)", "BRAVO CASTRO, ZOE (41)", "ZETA, ANA (30)", "REGISTRO HISTÓRICO SINTÉTICO (61)"];

const evento = (id: string, swimmersCount: number) => ({
  id,
  displayOrder: 1,
  event: { id: `e-${id}`, distance: { meters: 50 }, stroke: { name: "Libre" }, testType: { name: swimmersCount === 1 ? "Individual" : "Relevo", swimmersCount }, gender: "female" },
  competitionSession: { id: "s1", sessionType: { name: "Mañana" }, competitionDate: { date: "2027-01-15" } },
  enabledCategories: [],
});
const matriz = vi.fn(async () =>
  PERSONAS.map((p) => ({ personId: p.id, fullName: p.fullName, firstName: p.firstName, paternalLastName: p.paternalLastName, maternalLastName: p.maternalLastName, edadAlCorte: p.edad, run: `${p.id}-1`, gender: "female", eligibleEvents: [], registeredEventIds: [] }))
);
const plantel = vi.fn(async () =>
  PERSONAS.map((p) => ({ id: p.id, fullName: p.fullName, firstName: p.firstName, paternalLastName: p.paternalLastName, maternalLastName: p.maternalLastName, edadAlCorte: p.edad, run: `${p.id}-1`, gender: "female", birthDate: "1980-01-01T00:00:00.000Z" }))
);
const inscripciones = vi.fn(async () => ({
  items: ["p-z", "p-hist", "p-a"].map((id, i) => {
    const p = PERSONAS.find((x) => x.id === id)!;
    return {
      id: `r${i}`,
      status: "confirmed",
      seedTimeCentiseconds: 3000,
      // La edad al corte viene con la inscripción (servidor), no del plantel.
      edadAlCorte: p.edad,
      person: { id: p.id, fullName: p.fullName, firstName: p.firstName, paternalLastName: p.paternalLastName, maternalLastName: p.maternalLastName, run: `${p.id}-1` },
      club: { id: "club-1", name: "Club Uno" },
      category: { id: "c", name: "Máster" },
      competitionEvent: { competition: { id: "comp-A", name: "A", isRegistrationOpen: true }, event: evento("ce-1", 1).event, competitionSession: evento("ce-1", 1).competitionSession },
    };
  }),
  total: 3,
  page: 1,
  pageSize: 100,
}));

vi.mock("../competitions/competitionsApi", () => ({ useCompetitionsApi: () => ({ list: vi.fn(async () => ({ items: [COMPETENCIA], total: 1, page: 1, pageSize: 100 })) }) }));
vi.mock("../clubs/clubsApi", () => ({ useClubsApi: () => ({ list: vi.fn(vacia), get: vi.fn(async () => ({ id: "club-1", name: "Club Uno" })) }) }));
vi.mock("../swimmer-assignment/assignmentApi", () => ({ useSwimmerAssignmentApi: () => ({ getCurrentClub: vi.fn(async () => null) }) }));
vi.mock("./registrationsApi", () => ({
  useRegistrationsApi: () => ({
    listEnabledEvents: vi.fn(async () => [evento("ce-1", 1), evento("ce-r", 4)]),
    listClubEligibilityMatrix: matriz,
    listClubSwimmers: plantel,
    list: inscripciones,
    create: vi.fn(),
    cancel: vi.fn(),
    update: vi.fn(),
  }),
}));
const relevos = vi.fn(vacia);
vi.mock("../relay-registrations/relayRegistrationsApi", () => ({ useRelayRegistrationsApi: () => ({ list: relevos, create: vi.fn(), update: vi.fn(), cancel: vi.fn() }) }));

beforeEach(() => vi.clearAllMocks());

const textos = (raiz: HTMLElement) => within(raiz).getAllByText(/☰/).map((e) => (e.textContent ?? "").replace("☰", "").trim());

describe("Panel de Inscripción", () => {
  it("plantel ordenado y presentado con la edad del servidor; incompletos al final; selección por id", async () => {
    render(
      <MemoryRouter>
        <RegistrationWorkspacePage />
      </MemoryRouter>
    );
    const region = await screen.findByRole("region", { name: "Nadadores del plantel" });
    await waitFor(() => expect(textos(region)).toEqual(ESPERADO));

    // Las inscripciones de la prueba, también ordenadas, con la edad del plantel.
    const zonaPruebas = screen.getByRole("region", { name: "Pruebas por día" });
    expect(within(zonaPruebas).getByText("ÁLVAREZ DÍAZ, LUIS (47)")).toBeInTheDocument();
    const filas = within(zonaPruebas).getAllByText(/\(\d+\)$/).map((e) => e.textContent);
    expect(filas).toEqual(["ÁLVAREZ DÍAZ, LUIS (47)", "ZETA, ANA (30)", "REGISTRO HISTÓRICO SINTÉTICO (61)"]);

    // La búsqueda sigue funcionando por nombre guardado y por el presentado.
    fireEvent.change(screen.getByPlaceholderText(/Buscar nadador/), { target: { value: "bravo castro, z" } });
    await waitFor(() => expect(textos(region)).toEqual(["BRAVO CASTRO, ZOE (41)"]));
  });
});

describe("Panel de Relevos", () => {
  it("plantel ordenado y presentado, pedido con la competencia para la edad al corte", async () => {
    render(
      <MemoryRouter>
        <RelayWorkspacePage />
      </MemoryRouter>
    );
    const region = await screen.findByRole("region", { name: "Nadadores disponibles" });
    await waitFor(() => expect(textos(region)).toEqual(ESPERADO));
    expect(plantel).toHaveBeenCalledWith("club-1", "comp-A");
  });
});

/**
 * INSCRITOS QUE YA NO ESTÁN EN EL PLANTEL ACTIVO (corrección antes de publicar). Su inscripción o
 * su relevo confirmados siguen ahí, pero la persona no aparece en la matriz ni en el plantel: la
 * edad debe venir de la propia inscripción o del integrante (`edadAlCorte`, calculada por el
 * servidor), no del mapa del plantel. La persona no vuelve a la lista de disponibles.
 */
const EX = { id: "p-ex", firstName: "Elsa", paternalLastName: "Excluida", maternalLastName: "Antigua", fullName: "Elsa Excluida Antigua" };
const personaEx = { ...EX, run: "p-ex-1" };

describe("inscritos fuera del plantel activo", () => {
  it("Panel de Inscripción: la fila de la inscripción conserva nombre y edad; no vuelve al plantel", async () => {
    inscripciones.mockResolvedValueOnce({
      items: [
        {
          id: "r-ex",
          status: "confirmed",
          seedTimeCentiseconds: 3100,
          edadAlCorte: 58,
          person: personaEx,
          club: { id: "club-1", name: "Club Uno" },
          category: { id: "c", name: "Máster" },
          competitionEvent: { competition: { id: "comp-A", name: "A", isRegistrationOpen: true }, event: evento("ce-1", 1).event, competitionSession: evento("ce-1", 1).competitionSession },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    } as never);
    render(
      <MemoryRouter>
        <RegistrationWorkspacePage />
      </MemoryRouter>
    );
    const zonaPruebas = await screen.findByRole("region", { name: "Pruebas por día" });
    expect(await within(zonaPruebas).findByText("EXCLUIDA ANTIGUA, ELSA (58)")).toBeInTheDocument();
    const plantel = screen.getByRole("region", { name: "Nadadores del plantel" });
    expect(within(plantel).queryByText(/EXCLUIDA/)).toBeNull();
  });

  it("Panel de Relevos: el integrante fuera del plantel conserva nombre y edad, en el orden de los puestos", async () => {
    const miembro = (orderPosition: number, persona: Record<string, unknown>, edadAlCorte: number) => ({ orderPosition, edadAlCorte, person: persona });
    const enPlantel = (id: string) => {
      const p = PERSONAS.find((x) => x.id === id)!;
      return { id: p.id, fullName: p.fullName, firstName: p.firstName, paternalLastName: p.paternalLastName, maternalLastName: p.maternalLastName, run: `${p.id}-1` };
    };
    relevos.mockResolvedValueOnce({
      items: [
        {
          id: "t-ex",
          status: "confirmed",
          seedTimeCentiseconds: 20000,
          club: { id: "club-1", name: "Club Uno" },
          category: { id: "cr", name: "Relevo" },
          competitionEvent: { competition: { id: "comp-A", name: "A" }, event: evento("ce-r", 4).event, competitionSession: evento("ce-r", 4).competitionSession },
          // Orden de puestos distinto del alfabético, y desordenado en la respuesta.
          members: [miembro(3, enPlantel("p-a"), 47), miembro(1, personaEx, 58), miembro(4, enPlantel("p-z"), 30), miembro(2, enPlantel("p-b1"), 54)],
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    } as never);
    render(
      <MemoryRouter>
        <RelayWorkspacePage />
      </MemoryRouter>
    );
    const zona = await screen.findByRole("region", { name: "Pruebas de relevo por día" });
    expect(
      await within(zona).findByText("EXCLUIDA ANTIGUA, ELSA (58) → BRAVO CASTRO, ANA (54) → ÁLVAREZ DÍAZ, LUIS (47) → ZETA, ANA (30)")
    ).toBeInTheDocument();
    const plantel = screen.getByRole("region", { name: "Nadadores disponibles" });
    expect(within(plantel).queryByText(/EXCLUIDA/)).toBeNull();
  });
});
