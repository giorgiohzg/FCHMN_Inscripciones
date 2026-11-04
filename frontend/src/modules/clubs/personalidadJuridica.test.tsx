/**
 * Etapa 10a — la personalidad jurídica tiene DOS estados en la interfaz.
 *
 * El estado «pendiente de verificar» se retiró del formulario, del listado y
 * del filtro. En un alta comienza seleccionado «No tiene». Lo que viaja al
 * servidor es siempre `true` o `false`.
 *
 * Interacción simulada con jsdom, no con un navegador real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ClubFormPage } from "./ClubFormPage";
import { ClubsListPage } from "./ClubsListPage";

vi.mock("../../shared/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../swimmer-assignment/ClubSwimmersSection", () => ({ ClubSwimmersSection: () => null }));
vi.mock("./PersonPicker", () => ({ PersonPicker: () => <p>PICKER representante legal</p> }));
vi.mock("./PersonMultiPicker", () => ({ PersonMultiPicker: () => null }));

const get = vi.fn();
const list = vi.fn();
const create = vi.fn();
const update = vi.fn();

vi.mock("./clubsApi", () => ({
  useClubsApi: () => ({
    get,
    list,
    create,
    update,
    createCredentials: vi.fn(),
    resetCredentials: vi.fn(),
    block: vi.fn(),
    disable: vi.fn(),
    reactivate: vi.fn(),
    remove: vi.fn(),
  }),
}));

function club(over: Record<string, unknown> = {}) {
  return {
    id: "c-1",
    name: "Club Sintético",
    username: null,
    code: "SINT",
    hasLegalStatus: false,
    rut: null,
    legalName: null,
    email: null,
    status: "active",
    staff: [],
    isAchmnMember: false,
    isAchmnCollaborator: false,
    isFchmnMember: false,
    isFchmnCollaborator: false,
    user: null,
    ...over,
  };
}

function montarFicha(ruta: string) {
  render(
    <MemoryRouter initialEntries={[ruta]}>
      <Routes>
        <Route path="/clubes/:id" element={<ClubFormPage />} />
        <Route path="/clubes" element={<p>LISTA</p>} />
      </Routes>
    </MemoryRouter>
  );
}

const radios = () => screen.getAllByRole("radio", { name: /Sí, tiene|No tiene|Pendiente/i }) as HTMLInputElement[];

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ id: "nuevo" });
  update.mockResolvedValue({ id: "c-1" });
});

describe("formulario de club", () => {
  it("ofrece SOLO «Sí, tiene» y «No tiene»; no hay ninguna opción pendiente", () => {
    montarFicha("/clubes/nuevo");
    expect(radios().map((r) => r.parentElement!.textContent?.trim())).toEqual(["Sí, tiene", "No tiene"]);
    expect(screen.queryByText(/pendiente/i)).not.toBeInTheDocument();
  });

  it("en un ALTA comienza seleccionado «No tiene», sin RUT ni representante", () => {
    montarFicha("/clubes/nuevo");
    const [si, no] = radios();
    expect(no!.checked).toBe(true);
    expect(si!.checked).toBe(false);
    expect(screen.queryByLabelText(/^RUT$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/PICKER representante legal/)).not.toBeInTheDocument();
    expect(screen.getByText(/Solo los clubes con personalidad jurídica pueden tener representante legal/)).toBeInTheDocument();
  });

  it("un alta sin tocar la opción envía hasLegalStatus: false (booleano, nunca null)", async () => {
    montarFicha("/clubes/nuevo");
    fireEvent.change(screen.getByLabelText(/Nombre del club/i), { target: { value: "Club Nuevo" } });
    fireEvent.change(screen.getByLabelText(/Sigla/i), { target: { value: "NUE" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0].hasLegalStatus).toBe(false);
    expect(create.mock.calls[0]![0].rut).toBeUndefined();
  });

  it("elegir «Sí, tiene» exige un RUT válido y muestra el selector de representante legal", async () => {
    montarFicha("/clubes/nuevo");
    fireEvent.click(radios()[0]!);

    expect(screen.getByLabelText(/^RUT$/)).toBeRequired();
    expect(screen.getByText(/PICKER representante legal/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Nombre del club/i), { target: { value: "Club Nuevo" } });
    fireEvent.change(screen.getByLabelText(/Sigla/i), { target: { value: "NUE" } });
    // Vacío: el navegador lo frena con `required`, y no se envía nada.
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(create).not.toHaveBeenCalled();

    // Con dígito verificador incorrecto: lo rechaza la propia pantalla.
    fireEvent.change(screen.getByLabelText(/^RUT$/), { target: { value: "11.111.111-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/RUT es obligatorio y debe ser válido/);
    expect(create).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/^RUT$/), { target: { value: "11.111.111-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0].hasLegalStatus).toBe(true);
  });

  it("al EDITAR muestra el estado del club", async () => {
    get.mockResolvedValue(club({ hasLegalStatus: true, rut: "111111111" }));
    montarFicha("/clubes/c-1");
    await waitFor(() => expect(screen.getByDisplayValue("Club Sintético")).toBeInTheDocument());
    expect(radios()[0]!.checked).toBe(true);
    expect(radios()[1]!.checked).toBe(false);
  });

  it("un club que llega con null residual (columna aún anulable) se presenta como «No tiene»", async () => {
    get.mockResolvedValue(club({ hasLegalStatus: null }));
    montarFicha("/clubes/c-1");
    await waitFor(() => expect(screen.getByDisplayValue("Club Sintético")).toBeInTheDocument());
    expect(radios()[1]!.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]![1].hasLegalStatus).toBe(false);
  });

  it("con representante designado, pasar a «No tiene» no se permite desde la pantalla", async () => {
    get.mockResolvedValue(
      club({
        hasLegalStatus: true,
        rut: "111111111",
        staff: [{ id: "s", roleType: "legal_representative", person: { id: "p", fullName: "Persona Sintética", run: "1-9" } }],
      })
    );
    montarFicha("/clubes/c-1");
    await waitFor(() => expect(screen.getByDisplayValue("Club Sintético")).toBeInTheDocument());

    fireEvent.click(radios()[1]!);
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/designado\(a\) como representante legal/);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("listado de clubes", () => {
  function montarLista() {
    list.mockResolvedValue({
      items: [club({ id: "a", name: "Club Con", hasLegalStatus: true, rut: "111111111", code: "CON" }), club({ id: "b", name: "Club Sin", hasLegalStatus: false, code: "SIN" })],
      total: 2,
      page: 1,
      pageSize: 20,
    });
    render(
      <MemoryRouter>
        <ClubsListPage />
      </MemoryRouter>
    );
  }

  it("el filtro ofrece solo «con» y «sin» personalidad jurídica", async () => {
    montarLista();
    await screen.findByText("Club Con");
    const filtro = screen.getByLabelText("Filtrar por personalidad jurídica") as HTMLSelectElement;
    expect(within(filtro).getAllByRole("option").map((o) => (o as HTMLOptionElement).value)).toEqual(["", "si", "no"]);
    expect(within(filtro).queryByText(/pendiente/i)).not.toBeInTheDocument();
  });

  it("la columna muestra solo «Sí» y «No», y ninguna fila dice «Pendiente»", async () => {
    montarLista();
    await screen.findByText("Club Con");
    expect(screen.queryByText(/pendiente/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sin RUT todavía/)).not.toBeInTheDocument();
    expect(screen.getByText("Sí")).toBeInTheDocument();
    expect(screen.getByText("No")).toBeInTheDocument();
  });

  it("al filtrar se pide al servidor «si» o «no»", async () => {
    montarLista();
    await screen.findByText("Club Con");
    fireEvent.change(screen.getByLabelText("Filtrar por personalidad jurídica"), { target: { value: "no" } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ personalidadJuridica: "no" })));
  });
});
