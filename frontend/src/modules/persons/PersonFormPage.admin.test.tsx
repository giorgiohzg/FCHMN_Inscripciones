/**
 * La casilla «Habilitar permisos de administrador».
 *
 * Lo que se fija aquí es el comportamiento de la interfaz, NO la seguridad:
 * quien impide que un no administrador conceda permisos es la ruta del
 * backend, que exige el rol además del permiso (`admin-access.integration`).
 * Ocultar la casilla solo evita ofrecer una acción que sería rechazada.
 *
 * Los puntos que se comprueban son los que ya se equivocaron una vez o
 * pueden hacerlo en silencio:
 *   - la casilla no aparece para quien no es administrador, ni en una ficha
 *     nueva (donde no hay persona a la que conceder nada);
 *   - retirarse los permisos a UNO MISMO cierra la sesión, y hacerlo sobre
 *     otra persona no;
 *   - con la marca puesta y sin cuenta, el texto dice que todavía NO hay
 *     acceso;
 *   - si la llamada falla, la casilla vuelve a su valor real en vez de
 *     quedarse afirmando un cambio que no ocurrió.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { PersonFormPage } from "./PersonFormPage";

const logout = vi.fn();
const reintentarRestauracion = vi.fn();
const sesion = { roles: ["admin"], personId: "otra-persona" };

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u-1", username: "admin", personId: sesion.personId, roles: sesion.roles },
    logout,
    reintentarRestauracion,
    hasRole: (rol: string) => sesion.roles.includes(rol),
  }),
}));

// AppShell arrastra menú, sesión y avisos; nada de eso interviene aquí.
vi.mock("../../shared/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("./SwimmerClubSection", () => ({ SwimmerClubSection: () => null }));

const get = vi.fn();
const setAdminAccess = vi.fn();

vi.mock("./personsApi", () => ({
  usePersonsApi: () => ({
    get,
    setAdminAccess,
    update: vi.fn(),
    create: vi.fn(),
    createCredentials: vi.fn(),
    resetCredentials: vi.fn(),
  }),
}));

const PERSONA_ID = "p-1";

function persona(over: Record<string, unknown> = {}) {
  return {
    id: PERSONA_ID,
    run: "11.111.111-1",
    username: "ada.prueba",
    firstName: "Ada",
    paternalLastName: "Prueba",
    maternalLastName: "",
    fullName: "Ada Prueba",
    birthDate: "1990-05-05T00:00:00.000Z",
    gender: "female",
    email: null,
    phone: null,
    status: "active",
    adminAccess: false,
    roles: [{ roleType: "swimmer", active: true }],
    user: { id: "u-9", username: "ada.prueba", status: "active", mustChangePassword: false, lastLoginAt: null },
    ...over,
  };
}

function montar(ruta = `/personas/${PERSONA_ID}`) {
  return render(
    <MemoryRouter initialEntries={[ruta]}>
      <Routes>
        <Route path="/personas/:id" element={<PersonFormPage />} />
      </Routes>
    </MemoryRouter>
  );
}

const casilla = () => screen.queryByLabelText(/Habilitar permisos de administrador/i);

beforeEach(() => {
  vi.clearAllMocks();
  sesion.roles = ["admin"];
  sesion.personId = "otra-persona";
  get.mockResolvedValue(persona());
  setAdminAccess.mockResolvedValue({ id: PERSONA_ID, fullName: "Ada Prueba", adminAccess: true, tieneCuenta: true, sesionesRevocadas: 0 });
});

describe("visibilidad", () => {
  it("un administrador la ve al editar", async () => {
    montar();
    await waitFor(() => expect(casilla()).toBeInTheDocument());
  });

  it("quien NO es administrador no la ve", async () => {
    sesion.roles = ["delegate"];
    montar();

    // Se espera a que la ficha esté cargada para no confundir "aún no pintada"
    // con "oculta".
    await waitFor(() => expect(screen.getByDisplayValue("ada.prueba")).toBeInTheDocument());
    expect(casilla()).not.toBeInTheDocument();
    expect(screen.queryByText(/Permisos de administrador/i)).not.toBeInTheDocument();
  });

  it("no aparece al crear una persona nueva", async () => {
    render(
      <MemoryRouter initialEntries={["/personas/nueva"]}>
        <Routes>
          <Route path="/personas/:id" element={<PersonFormPage />} />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByText("Nueva persona")).toBeInTheDocument();
    expect(casilla()).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
});

describe("conceder", () => {
  it("llama a la API y lo confirma", async () => {
    montar();
    fireEvent.click(await screen.findByLabelText(/Habilitar permisos de administrador/i));

    await waitFor(() => expect(setAdminAccess).toHaveBeenCalledWith(PERSONA_ID, true));
    expect(await screen.findByText(/Permisos de administrador concedidos/i)).toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
  });

  it("sin cuenta, avisa que TODAVÍA no hay acceso", async () => {
    get.mockResolvedValue(persona({ user: null }));
    setAdminAccess.mockResolvedValue({ id: PERSONA_ID, fullName: "Ada Prueba", adminAccess: true, tieneCuenta: false, sesionesRevocadas: 0 });
    montar();

    fireEvent.click(await screen.findByLabelText(/Habilitar permisos de administrador/i));

    expect(await screen.findByText(/aún no puede entrar/i)).toBeInTheDocument();
    expect(screen.getByText(/La persona aún no tiene cuenta/i)).toBeInTheDocument();
  });

  it("si la API falla, la casilla vuelve atrás y se muestra el motivo", async () => {
    setAdminAccess.mockRejectedValue(new Error("No tiene permiso para esta operación"));
    montar();

    const check = (await screen.findByLabelText(/Habilitar permisos de administrador/i)) as HTMLInputElement;
    fireEvent.click(check);

    expect(await screen.findByText(/No tiene permiso para esta operación/i)).toBeInTheDocument();
    expect(check.checked, "no debe quedar marcada tras un rechazo").toBe(false);
  });
});

describe("retirar", () => {
  beforeEach(() => {
    get.mockResolvedValue(persona({ adminAccess: true }));
    setAdminAccess.mockResolvedValue({ id: PERSONA_ID, fullName: "Ada Prueba", adminAccess: false, tieneCuenta: true, sesionesRevocadas: 2 });
  });

  it("sobre OTRA persona no cierra la sesión propia", async () => {
    montar();
    fireEvent.click(await screen.findByLabelText(/Habilitar permisos de administrador/i));

    await waitFor(() => expect(setAdminAccess).toHaveBeenCalledWith(PERSONA_ID, false));
    expect(await screen.findByText(/Se revocaron sus sesiones/i)).toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
  });

  it("sobre UNO MISMO cierra la sesión", async () => {
    sesion.personId = PERSONA_ID;
    montar();

    fireEvent.click(await screen.findByLabelText(/Habilitar permisos de administrador/i));

    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Se cerrará su sesión/i)).toBeInTheDocument();
  });

  it("el aviso de cierre de sesión solo se anuncia en la ficha propia", async () => {
    // Sobre otra persona, el texto de la casilla marcada no debe prometerlo.
    montar();
    await screen.findByLabelText(/Habilitar permisos de administrador/i);
    expect(screen.queryByText(/se cerrará su sesión/i)).not.toBeInTheDocument();
  });
});
