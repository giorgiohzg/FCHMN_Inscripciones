/**
 * Hallazgo 31, frente 6 — LA TABLA DE RUTAS Y SUS GUARDIAS.
 *
 * `App.tsx` estaba al 0 % y es donde se decide **quién puede llegar a qué**. La
 * autorización de verdad la impone el backend, y eso ya está probado por HTTP en
 * `listados-alcance.integration.test.ts`; lo que se comprueba aquí es la otra
 * mitad: que la interfaz no lleve a un usuario a una pantalla que no le
 * corresponde. Una regresión que quitara `requiredRole="admin"` de un bloque de
 * rutas no rompería ninguna prueba de backend —el servidor seguiría diciendo que
 * no— pero abriría el panel de personas, clubes o auditoría a cualquier delegado,
 * con los datos que la pantalla cargue por su cuenta antes de recibir el 403.
 *
 * Las pantallas se sustituyen por marcadores: lo que se prueba es el enrutado,
 * no lo que cada una hace después.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { App } from "./App";

type Sesion = {
  accessToken: string | null;
  mustChangePassword: boolean;
  roles: string[];
  restaurando: boolean;
  restauracionFallida: boolean;
};
let sesion: Sesion = {
  accessToken: "t",
  mustChangePassword: false,
  roles: ["admin"],
  restaurando: false,
  restauracionFallida: false,
};

/**
 * Estable entre renders: si se creara uno nuevo en cada llamada a `useAuth`, el
 * botón invocaría un espía distinto del que la prueba inspecciona.
 */
const reintentarRestauracion = vi.fn();

vi.mock("./modules/auth/AuthContext", () => ({
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({
    user: { id: "u1", username: "quien-sea", ownerType: "system", personId: null, clubId: null, roles: sesion.roles },
    accessToken: sesion.accessToken,
    permissions: [],
    mustChangePassword: sesion.mustChangePassword,
    hasRole: (r: string) => sesion.roles.includes(r),
    hasPermission: () => true,
    restaurando: sesion.restaurando,
    restauracionFallida: sesion.restauracionFallida,
    login: vi.fn(),
    logout: vi.fn(),
    changePassword: vi.fn(),
    reintentarRestauracion,
  }),
}));

// Marcadores en lugar de las pantallas reales. El JSX va dentro de cada
// factoría porque `vi.mock` se eleva al principio del archivo: una función
// auxiliar declarada aquí arriba todavía no existiría cuando se ejecuta.
vi.mock("./modules/auth/LoginPage", () => ({ LoginPage: () => <p>PANTALLA login</p> }));
vi.mock("./modules/auth/ForceChangePasswordPage", () => ({
  ForceChangePasswordPage: () => <p>PANTALLA cambiar contraseña</p>,
}));
vi.mock("./modules/persons/PersonsListPage", () => ({ PersonsListPage: () => <p>PANTALLA personas</p> }));
vi.mock("./modules/persons/PersonFormPage", () => ({ PersonFormPage: () => <p>PANTALLA ficha de persona</p> }));
vi.mock("./modules/persons/PersonsBulkImportPage", () => ({
  PersonsBulkImportPage: () => <p>PANTALLA carga masiva de personas</p>,
}));
vi.mock("./modules/clubs/ClubsListPage", () => ({ ClubsListPage: () => <p>PANTALLA clubes</p> }));
vi.mock("./modules/clubs/ClubFormPage", () => ({ ClubFormPage: () => <p>PANTALLA ficha de club</p> }));
vi.mock("./modules/swimmer-assignment/SwimmerAssignmentsPage", () => ({
  SwimmerAssignmentsPage: () => <p>PANTALLA asignaciones</p>,
}));
vi.mock("./modules/swimmer-assignment/BulkSwimmerAssignmentPage", () => ({
  BulkSwimmerAssignmentPage: () => <p>PANTALLA asignación masiva</p>,
}));
vi.mock("./modules/catalogs/CatalogsPage", () => ({ CatalogsPage: () => <p>PANTALLA catálogos</p> }));
vi.mock("./modules/competitions/CompetitionsListPage", () => ({
  CompetitionsListPage: () => <p>PANTALLA competencias</p>,
}));
vi.mock("./modules/competitions/CompetitionDetailPage", () => ({
  CompetitionDetailPage: () => <p>PANTALLA ficha de competencia</p>,
}));
vi.mock("./modules/competitions/CompetitionMeetImportPage", () => ({
  CompetitionMeetImportPage: () => <p>PANTALLA importar competencia</p>,
}));
vi.mock("./modules/audit/AuditLogPage", () => ({ AuditLogPage: () => <p>PANTALLA auditoría</p> }));
vi.mock("./modules/registrations/RegistrationWizardPage", () => ({
  RegistrationWizardPage: () => <p>PANTALLA asistente de inscripción</p>,
}));
vi.mock("./modules/relay-registrations/RelayRegistrationWizardPage", () => ({
  RelayRegistrationWizardPage: () => <p>PANTALLA asistente de relevos</p>,
}));
vi.mock("./modules/dashboard/AdminDashboardPage", () => ({ AdminDashboardPage: () => <p>PANTALLA panel admin</p> }));
vi.mock("./modules/registrations/RegistrationWorkspacePage", () => ({
  RegistrationWorkspacePage: () => <p>PANTALLA inscripciones</p>,
}));
vi.mock("./modules/relay-registrations/RelayWorkspacePage", () => ({
  RelayWorkspacePage: () => <p>PANTALLA relevos</p>,
}));
vi.mock("./modules/reports/ReportsPage", () => ({ ReportsPage: () => <p>PANTALLA reportes</p> }));

beforeEach(() => {
  sesion = { accessToken: "t", mustChangePassword: false, roles: ["admin"], restaurando: false, restauracionFallida: false };
  reintentarRestauracion.mockClear();
});

/** Renderiza la aplicación situada en una ruta concreta. */
function abrir(ruta: string) {
  window.history.pushState({}, "", ruta);
  return render(<App />);
}

/**
 * LA FRONTERA ADMINISTRATIVA — LAS CATORCE RUTAS, UNA POR UNA.
 *
 * No basta con probar tres y suponer el resto: el guard se declara por bloque,
 * pero una ruta puede salirse del bloque en cualquier edición y nadie lo notaría.
 * De las catorce, **tres** son paramétricas —`/personas/:id`, `/clubes/:id` y
 * `/competencias/:id`—; las once restantes son estáticas. Las tres se recorren con
 * un identificador concreto, porque una ruta con parámetro puede dejar de
 * coincidir sin que la estática lo haga.
 *
 * Que `App.tsx` marque 100 % de líneas no demuestra nada de esto: la cobertura
 * dice que la línea se ejecutó, no que estuviera bajo el guard correcto.
 */
const RUTAS_DE_ADMIN: Array<[string, string]> = [
  ["/auditoria", "PANTALLA auditoría"],
  ["/personas", "PANTALLA personas"],
  ["/personas/carga-masiva", "PANTALLA carga masiva de personas"],
  ["/personas/nueva", "PANTALLA ficha de persona"],
  ["/personas/11111111-1111-1111-1111-111111111111", "PANTALLA ficha de persona"],
  ["/clubes", "PANTALLA clubes"],
  ["/clubes/nuevo", "PANTALLA ficha de club"],
  ["/clubes/22222222-2222-2222-2222-222222222222", "PANTALLA ficha de club"],
  ["/asignaciones", "PANTALLA asignaciones"],
  ["/asignaciones/masiva", "PANTALLA asignación masiva"],
  ["/catalogos", "PANTALLA catálogos"],
  ["/competencias", "PANTALLA competencias"],
  ["/competencias/importar", "PANTALLA importar competencia"],
  ["/competencias/33333333-3333-3333-3333-333333333333", "PANTALLA ficha de competencia"],
];

/** Las que no llevan `requiredRole`: el acotamiento lo aplica el servidor. */
const RUTAS_COMPARTIDAS: Array<[string, string]> = [
  ["/dashboard", "PANTALLA panel admin"],
  ["/inscripciones", "PANTALLA inscripciones"],
  ["/inscripciones/nueva", "PANTALLA asistente de inscripción"],
  ["/inscripciones-relevos", "PANTALLA relevos"],
  ["/inscripciones-relevos/nueva", "PANTALLA asistente de relevos"],
  ["/reportes", "PANTALLA reportes"],
];

describe("las catorce pantallas de administración exigen el rol admin", () => {
  it.each(RUTAS_DE_ADMIN)("un DELEGADO que abre %s no ve %s", async (ruta, pantalla) => {
    sesion.roles = ["delegate"];
    abrir(ruta);

    expect(await screen.findByText("No autorizado")).toBeInTheDocument();
    expect(screen.queryByText(pantalla), "ni por debajo del aviso").not.toBeInTheDocument();
  });

  it.each(RUTAS_DE_ADMIN)("un ADMINISTRADOR que abre %s sí ve %s", async (ruta, pantalla) => {
    abrir(ruta);

    expect(await screen.findByText(pantalla)).toBeInTheDocument();
    expect(screen.queryByText("No autorizado")).not.toBeInTheDocument();
  });

  it.each(RUTAS_DE_ADMIN)("un NADADOR tampoco entra en %s", async (ruta, pantalla) => {
    sesion.roles = ["swimmer"];
    abrir(ruta);

    expect(await screen.findByText("No autorizado")).toBeInTheDocument();
    expect(screen.queryByText(pantalla)).not.toBeInTheDocument();
  });
});

describe("las seis pantallas de operación las abre cualquier sesión válida", () => {
  it.each(RUTAS_COMPARTIDAS)("un DELEGADO abre %s", async (ruta, pantalla) => {
    sesion.roles = ["delegate"];
    abrir(ruta);

    // El panel de inicio es el único que cambia de contenido según el rol.
    const esperado = ruta === "/dashboard" ? "Bienvenido" : pantalla;
    expect(await screen.findByText(esperado)).toBeInTheDocument();
    expect(screen.queryByText("No autorizado")).not.toBeInTheDocument();
  });

  it.each(RUTAS_COMPARTIDAS)("un NADADOR abre %s", async (ruta, pantalla) => {
    sesion.roles = ["swimmer"];
    abrir(ruta);

    const esperado = ruta === "/dashboard" ? "Bienvenido" : pantalla;
    expect(await screen.findByText(esperado)).toBeInTheDocument();
  });
});

describe("sin sesión no se llega a ninguna parte", () => {
  it.each(["/dashboard", "/inscripciones", "/personas", "/reportes"])("%s manda al login", async (ruta) => {
    sesion.accessToken = null;
    abrir(ruta);

    expect(await screen.findByText("PANTALLA login")).toBeInTheDocument();
  });

  it("una ruta que no existe también manda al login", async () => {
    abrir("/esta-ruta-no-existe");

    expect(await screen.findByText("PANTALLA login")).toBeInTheDocument();
  });
});

/**
 * EL CAMBIO OBLIGATORIO DE CONTRASEÑA. Es un gate: con el cambio pendiente no se
 * puede ir a ninguna otra pantalla, ni siquiera escribiendo la dirección.
 */
describe("con el cambio de contraseña pendiente no se puede ir a otro sitio", () => {
  it.each(["/dashboard", "/inscripciones", "/personas"])("%s redirige al cambio", async (ruta) => {
    sesion.mustChangePassword = true;
    abrir(ruta);

    expect(await screen.findByText("PANTALLA cambiar contraseña")).toBeInTheDocument();
  });

  it("la propia pantalla de cambio SÍ se abre, que si no sería un bucle", async () => {
    sesion.mustChangePassword = true;
    abrir("/cambiar-password");

    expect(await screen.findByText("PANTALLA cambiar contraseña")).toBeInTheDocument();
  });

  it("pero no sin sesión", async () => {
    sesion = { ...sesion, accessToken: null, mustChangePassword: true };
    abrir("/cambiar-password");

    expect(await screen.findByText("PANTALLA login")).toBeInTheDocument();
  });
});

/**
 * EL PANEL DE INICIO SEGÚN EL ROL. Los indicadores de gestión son del
 * administrador; el resto ve una bienvenida. Si esto se invirtiera, la pantalla
 * pediría los KPI globales para alguien que no debe verlos.
 */
describe("el panel de inicio depende del rol", () => {
  it("ADMINISTRADOR: indicadores de gestión", async () => {
    abrir("/dashboard");

    expect(await screen.findByText("PANTALLA panel admin")).toBeInTheDocument();
  });

  it("DELEGADO: bienvenida, sin indicadores", async () => {
    sesion.roles = ["delegate"];
    abrir("/dashboard");

    expect(await screen.findByText("Bienvenido")).toBeInTheDocument();
    expect(screen.queryByText("PANTALLA panel admin")).not.toBeInTheDocument();
  });
});

/**
 * MIENTRAS SE RESTAURA LA SESIÓN NO SE DECIDE NADA. Al recargar no hay access
 * token —vive en memoria—, pero la cookie sigue ahí. Sin esta espera, recargar
 * en cualquier pantalla expulsaba al usuario al login.
 */
describe("la restauración de sesión no expulsa a nadie", () => {
  it("mientras restaura, ni login ni pantalla: espera", async () => {
    sesion = { ...sesion, accessToken: null, restaurando: true };
    abrir("/inscripciones");

    expect(await screen.findByText(/Restaurando sesión/)).toBeInTheDocument();
    expect(screen.queryByText("PANTALLA login")).not.toBeInTheDocument();
  });

  it("si la restauración FALLÓ por red, ofrece reintentar en vez de cerrar la sesión", async () => {
    sesion = { ...sesion, accessToken: null, restauracionFallida: true };
    abrir("/inscripciones");

    expect(await screen.findByRole("button", { name: "Reintentar" })).toBeInTheDocument();
    expect(screen.queryByText("PANTALLA login"), "un 5xx no es una sesión inválida").not.toBeInTheDocument();
  });

  it("y el botón REINTENTA de verdad: una pulsación, una llamada", async () => {
    sesion = { ...sesion, accessToken: null, restauracionFallida: true };
    abrir("/inscripciones");

    fireEvent.click(await screen.findByRole("button", { name: "Reintentar" }));

    expect(reintentarRestauracion, "que exista el botón no prueba que haga algo").toHaveBeenCalledTimes(1);
  });

  it("lo mismo en la ruta de cambio de contraseña, que tiene su propio guard", async () => {
    sesion = { ...sesion, accessToken: null, restauracionFallida: true };
    abrir("/cambiar-password");

    fireEvent.click(await screen.findByRole("button", { name: "Reintentar" }));

    expect(reintentarRestauracion).toHaveBeenCalledTimes(1);
  });
});
