/**
 * «Asignación a club» en Nueva persona. La creación atómica (persona + membresía + rol + auditoría)
 * y su reversión son del backend (`alta-con-club-y-paneles.integration`); aquí se fija lo que le
 * toca a la interfaz: opción inicial «Sin asignación», lista COMPLETA de clubes activos (todas las
 * páginas), `clubId` enviado solo si se eligió un club, y que la edición no ofrece el campo.
 * API simulada; datos sintéticos.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { PersonFormPage } from "./PersonFormPage";

vi.mock("../auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u-1", username: "admin", personId: null, roles: ["admin"] },
    logout: vi.fn(),
    reintentarRestauracion: vi.fn(),
    hasRole: (rol: string) => rol === "admin",
  }),
}));
vi.mock("../../shared/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("./SwimmerClubSection", () => ({ SwimmerClubSection: () => null }));

const create = vi.fn();
const get = vi.fn();
vi.mock("./personsApi", () => ({
  usePersonsApi: () => ({ get, create, update: vi.fn(), setAdminAccess: vi.fn(), createCredentials: vi.fn(), resetCredentials: vi.fn() }),
}));

// 130 clubes activos sintéticos: dos páginas de 100.
const CLUBES = Array.from({ length: 130 }, (_, i) => ({ id: `club-${String(i).padStart(3, "0")}`, name: `Club Sintético ${i}`, status: "active" }));
const clubsList = vi.fn();
vi.mock("../clubs/clubsApi", () => ({ useClubsApi: () => ({ list: clubsList }) }));

function montar(ruta = "/personas/nueva") {
  return render(
    <MemoryRouter initialEntries={[ruta]}>
      <Routes>
        <Route path="/personas/nueva" element={<PersonFormPage />} />
        <Route path="/personas/:id" element={<PersonFormPage />} />
        <Route path="/personas" element={<p>Listado de personas</p>} />
      </Routes>
    </MemoryRouter>
  );
}

function completarFormulario() {
  fireEvent.change(screen.getByLabelText("RUN"), { target: { value: "12.345.678-5" } });
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Persona" } });
  fireEvent.change(screen.getByLabelText("Apellido paterno"), { target: { value: "Sintética" } });
  fireEvent.change(screen.getByLabelText("Fecha de nacimiento"), { target: { value: "1980-05-05" } });
  fireEvent.change(screen.getByLabelText("Género"), { target: { value: "female" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  clubsList.mockImplementation(async ({ page = 1, pageSize = 20, status }: { page?: number; pageSize?: number; status?: string }) => {
    const activos = CLUBES.filter((c) => !status || c.status === status);
    return { items: activos.slice((page - 1) * pageSize, page * pageSize), total: activos.length, page, pageSize };
  });
  create.mockResolvedValue({ id: "p-nueva" });
});

describe("Asignación a club en Nueva persona", () => {
  it("empieza en «Sin asignación» y ofrece TODOS los clubes activos, recorriendo las páginas", async () => {
    montar();
    const selector = screen.getByLabelText("Asignación a club") as HTMLSelectElement;
    expect(selector.value).toBe("");
    expect(selector.options[0]!.text).toBe("Sin asignación");
    await waitFor(() => expect(selector.options).toHaveLength(131));
    expect(clubsList).toHaveBeenCalledWith(expect.objectContaining({ status: "active", page: 1 }));
    expect(clubsList).toHaveBeenCalledWith(expect.objectContaining({ status: "active", page: 2 }));
    expect(selector.options[130]!.text).toBe("Club Sintético 129");
  });

  it("con un club elegido envía clubId; sin elegir no lo envía", async () => {
    const { unmount } = montar();
    await waitFor(() => expect((screen.getByLabelText("Asignación a club") as HTMLSelectElement).options).toHaveLength(131));
    completarFormulario();
    fireEvent.change(screen.getByLabelText("Asignación a club"), { target: { value: "club-120" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).toMatchObject({ run: "12.345.678-5", clubId: "club-120" });
    unmount();

    montar();
    await waitFor(() => expect((screen.getByLabelText("Asignación a club") as HTMLSelectElement).options).toHaveLength(131));
    completarFormulario();
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]![0]).not.toHaveProperty("clubId");
  });

  it("si el servidor rechaza (p. ej. club ya no activo) se muestra el error y no se navega", async () => {
    create.mockRejectedValueOnce(new Error("El club no está activo"));
    montar();
    await waitFor(() => expect((screen.getByLabelText("Asignación a club") as HTMLSelectElement).options).toHaveLength(131));
    completarFormulario();
    fireEvent.change(screen.getByLabelText("Asignación a club"), { target: { value: "club-001" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("El club no está activo");
    expect(screen.queryByText("Listado de personas")).toBeNull();
  });

  it("si la lista de clubes falla, lo dice y permite crear sin asignación", async () => {
    clubsList.mockRejectedValue(new Error("Sin conexión sintética"));
    montar();
    expect(await screen.findByText(/Sin conexión sintética\. Puede crear la persona sin asignación\./)).toBeInTheDocument();
    completarFormulario();
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0]).not.toHaveProperty("clubId");
  });

  it("la edición no ofrece el campo ni pide la lista de clubes (no es un traslado)", async () => {
    get.mockResolvedValue({
      id: "p-1", run: "11.111.111-1", username: null, firstName: "Ada", paternalLastName: "Prueba", maternalLastName: "", fullName: "Ada Prueba",
      birthDate: "1990-05-05T00:00:00.000Z", gender: "female", email: null, phone: null, status: "active", adminAccess: false, roles: [], user: null,
    });
    montar("/personas/p-1");
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(screen.queryByLabelText("Asignación a club")).toBeNull();
    expect(clubsList).not.toHaveBeenCalled();
  });
});
