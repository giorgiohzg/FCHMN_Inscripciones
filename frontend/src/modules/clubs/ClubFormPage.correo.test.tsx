/**
 * Etapa 8 — el correo del club es OPCIONAL en el formulario.
 *
 * Se fija lo que la interfaz envía: un campo vacío viaja como `null` (nunca
 * como cadena vacía) para que, al editar, quite el correo; y un club que llega
 * con `email: null` se muestra con el campo vacío, sin romperse.
 *
 * Interacción simulada con jsdom, no con un navegador real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ClubFormPage } from "./ClubFormPage";

vi.mock("../../shared/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../swimmer-assignment/ClubSwimmersSection", () => ({ ClubSwimmersSection: () => null }));
vi.mock("./PersonPicker", () => ({ PersonPicker: () => null }));
vi.mock("./PersonMultiPicker", () => ({ PersonMultiPicker: () => null }));

const get = vi.fn();
const create = vi.fn();
const update = vi.fn();

vi.mock("./clubsApi", () => ({
  useClubsApi: () => ({ get, create, update, createCredentials: vi.fn(), resetCredentials: vi.fn() }),
}));

function club(over: Record<string, unknown> = {}) {
  return {
    id: "c-1",
    name: "Club Sintético",
    username: "club.sintetico",
    code: "SINT",
    hasLegalStatus: false,
    rut: null,
    legalName: null,
    email: null,
    staff: [],
    isAchmnMember: false,
    isAchmnCollaborator: false,
    isFchmnMember: false,
    isFchmnCollaborator: false,
    user: null,
    ...over,
  };
}

function montar(ruta: string) {
  render(
    <MemoryRouter initialEntries={[ruta]}>
      <Routes>
        <Route path="/clubes/:id" element={<ClubFormPage />} />
        <Route path="/clubes" element={<p>LISTA</p>} />
      </Routes>
    </MemoryRouter>
  );
}

const campoCorreo = () => screen.getByLabelText(/Correo electrónico/i) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ id: "c-9" });
  update.mockResolvedValue({ id: "c-1" });
});

describe("el campo de correo", () => {
  it("se presenta como opcional y no es obligatorio", async () => {
    montar("/clubes/nuevo");
    const campo = campoCorreo();
    expect(screen.getByText(/Correo electrónico \(contacto, opcional\)/)).toBeInTheDocument();
    expect(campo).not.toBeRequired();
  });

  it("un club con email null se carga con el campo VACÍO y sin errores", async () => {
    get.mockResolvedValue(club({ email: null }));
    montar("/clubes/c-1");
    await waitFor(() => expect(screen.getByDisplayValue("Club Sintético")).toBeInTheDocument());
    expect(campoCorreo().value).toBe("");
  });

  it("un club con correo lo muestra", async () => {
    get.mockResolvedValue(club({ email: "hola@club.example.invalid" }));
    montar("/clubes/c-1");
    await waitFor(() => expect(campoCorreo().value).toBe("hola@club.example.invalid"));
  });
});

describe("lo que se envía", () => {
  it("alta SIN correo: viaja null, nunca una cadena vacía", async () => {
    montar("/clubes/nuevo");
    fireEvent.change(screen.getByLabelText(/Nombre del club/i), { target: { value: "Club Nuevo" } });
    fireEvent.change(screen.getByLabelText(/Nombre de usuario/i), { target: { value: "club.nuevo" } });
    fireEvent.change(screen.getByLabelText(/Sigla/i), { target: { value: "NUE" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0].email).toBeNull();
  });

  it("edición que BORRA el correo: viaja null", async () => {
    get.mockResolvedValue(club({ email: "borrar@club.example.invalid" }));
    montar("/clubes/c-1");
    await waitFor(() => expect(campoCorreo().value).toBe("borrar@club.example.invalid"));

    fireEvent.change(campoCorreo(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1].email).toBeNull();
  });

  it("solo espacios se trata como vacío: viaja null", async () => {
    get.mockResolvedValue(club({ email: "x@club.example.invalid" }));
    montar("/clubes/c-1");
    await waitFor(() => expect(campoCorreo().value).toBe("x@club.example.invalid"));

    fireEvent.change(campoCorreo(), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1].email).toBeNull();
  });

  it("un correo informado viaja tal cual", async () => {
    get.mockResolvedValue(club({ email: null }));
    montar("/clubes/c-1");
    await waitFor(() => expect(screen.getByDisplayValue("Club Sintético")).toBeInTheDocument());

    fireEvent.change(campoCorreo(), { target: { value: "nuevo@club.example.invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1].email).toBe("nuevo@club.example.invalid");
  });
});
