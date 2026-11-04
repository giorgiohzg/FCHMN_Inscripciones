/**
 * Etapa 9 — la sección «Credenciales de acceso» en las fichas de persona y de club.
 *
 * Se recorre con las DOS fichas reales (no solo con el componente suelto),
 * porque lo que importa es cómo cada una lo conecta con su API:
 *   - el título exacto aparece también en el alta, donde el nombre es
 *     opcional y no se ofrece crear la cuenta;
 *   - sin cuenta, el nombre es editable y «Guardar» lo envía (vacío = `null`);
 *   - «Crear credenciales» envía el nombre escrito y no se puede pulsar con el
 *     campo vacío o mal formado;
 *   - tras crearlas, el campo queda de solo lectura; si fallan, sigue editable
 *     con lo escrito;
 *   - con cuenta, «Guardar» ya no envía el nombre.
 *
 * Interacción SIMULADA con jsdom, no un navegador real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { PersonFormPage } from "../modules/persons/PersonFormPage";
import { ClubFormPage } from "../modules/clubs/ClubFormPage";

vi.mock("../modules/auth/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u-1", username: "admin", personId: "otra", roles: ["admin"] },
    logout: vi.fn(),
    reintentarRestauracion: vi.fn(),
    hasRole: () => false,
  }),
}));
vi.mock("./AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("../modules/persons/SwimmerClubSection", () => ({ SwimmerClubSection: () => null }));
vi.mock("../modules/swimmer-assignment/ClubSwimmersSection", () => ({ ClubSwimmersSection: () => null }));
vi.mock("../modules/clubs/PersonPicker", () => ({ PersonPicker: () => null }));
vi.mock("../modules/clubs/PersonMultiPicker", () => ({ PersonMultiPicker: () => null }));

const persons = { get: vi.fn(), create: vi.fn(), update: vi.fn(), createCredentials: vi.fn(), resetCredentials: vi.fn(), setAdminAccess: vi.fn() };
const clubs = { get: vi.fn(), create: vi.fn(), update: vi.fn(), createCredentials: vi.fn(), resetCredentials: vi.fn() };
vi.mock("../modules/persons/personsApi", () => ({ usePersonsApi: () => persons }));
vi.mock("../modules/clubs/clubsApi", () => ({ useClubsApi: () => clubs }));

const CUENTA = (username: string) => ({ id: "u-9", username, status: "active", mustChangePassword: true, lastLoginAt: null });

function persona(over: Record<string, unknown> = {}) {
  return {
    id: "p-1",
    run: "12.345.678-5",
    username: null,
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
    roles: [],
    user: null,
    ...over,
  };
}

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
    staff: [],
    isAchmnMember: false,
    isAchmnCollaborator: false,
    isFchmnMember: false,
    isFchmnCollaborator: false,
    user: null,
    ...over,
  };
}

/** Lo que cambia entre las dos fichas. */
const FICHAS = [
  {
    ficha: "persona",
    api: persons,
    registro: persona,
    rutaEditar: "/personas/p-1",
    rutaAlta: "/personas/nueva",
    patron: "/personas/:id",
    elemento: <PersonFormPage />,
    cargado: "Ada",
    editarOtroDato: () => fireEvent.change(screen.getByLabelText(/Teléfono de contacto/i), { target: { value: "912345678" } }),
    rellenarAlta: () => {
      fireEvent.change(screen.getByLabelText(/^RUN$/i), { target: { value: "12.345.678-5" } });
      fireEvent.change(screen.getByLabelText(/^Nombre$/i), { target: { value: "Ana" } });
      fireEvent.change(screen.getByLabelText(/Apellido paterno/i), { target: { value: "Prueba" } });
      fireEvent.change(screen.getByLabelText(/Fecha de nacimiento/i), { target: { value: "1990-01-01" } });
      fireEvent.change(screen.getByLabelText(/Género/i), { target: { value: "female" } });
    },
  },
  {
    ficha: "club",
    api: clubs,
    registro: club,
    rutaEditar: "/clubes/c-1",
    rutaAlta: "/clubes/nuevo",
    patron: "/clubes/:id",
    elemento: <ClubFormPage />,
    cargado: "Club Sintético",
    editarOtroDato: () => fireEvent.change(screen.getByLabelText(/Nombre del club/i), { target: { value: "Club Renombrado" } }),
    rellenarAlta: () => {
      fireEvent.change(screen.getByLabelText(/Nombre del club/i), { target: { value: "Club Nuevo" } });
      fireEvent.change(screen.getByLabelText(/Sigla/i), { target: { value: "NUE" } });
    },
  },
] as const;

const campo = () => screen.getByLabelText(/Nombre de usuario/i) as HTMLInputElement;
const botonCrear = () => screen.queryByRole("button", { name: /Crear credenciales/i });

beforeEach(() => {
  vi.clearAllMocks();
  for (const api of [persons, clubs]) {
    api.create.mockResolvedValue({ id: "nuevo" });
    api.update.mockResolvedValue({ id: "x" });
  }
});

describe.each(FICHAS)("ficha de $ficha", (f) => {
  function montar(ruta: string) {
    render(
      <MemoryRouter initialEntries={[ruta]}>
        <Routes>
          <Route path={f.patron} element={f.elemento} />
          <Route path="/personas" element={<p>LISTA</p>} />
          <Route path="/clubes" element={<p>LISTA</p>} />
        </Routes>
      </MemoryRouter>
    );
  }

  async function montarEdicion(registro: Record<string, unknown>) {
    f.api.get.mockResolvedValue(registro);
    montar(f.rutaEditar);
    await waitFor(() => expect(screen.getByDisplayValue(f.cargado)).toBeInTheDocument());
  }

  it("ALTA: título exacto, campo editable y opcional, sin botón de crear credenciales", async () => {
    montar(f.rutaAlta);
    expect(screen.getByRole("heading", { name: "Credenciales de acceso" })).toBeInTheDocument();
    expect(campo()).toBeEnabled();
    expect(campo()).not.toBeRequired();
    expect(botonCrear()).not.toBeInTheDocument();
    expect(screen.getByText(/se crean después de guardar/i)).toBeInTheDocument();
  });

  it("ALTA sin nombre: se envía null y no se crea ninguna cuenta", async () => {
    montar(f.rutaAlta);
    f.rellenarAlta();
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(f.api.create).toHaveBeenCalledTimes(1));
    expect(f.api.create.mock.calls[0]![0].username).toBeNull();
    expect(f.api.createCredentials).not.toHaveBeenCalled();
  });

  it("ALTA con un nombre mal formado: no se guarda y se explica", async () => {
    montar(f.rutaAlta);
    f.rellenarAlta();
    fireEvent.change(campo(), { target: { value: "ab" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/entre 4 y 30/);
    expect(f.api.create).not.toHaveBeenCalled();
  });

  it("EDICIÓN sin cuenta: el campo es editable y «Guardar» envía el nombre (vacío = null)", async () => {
    await montarEdicion(f.registro({ username: "guardado.uno" }));
    expect(screen.getByRole("heading", { name: "Credenciales de acceso" })).toBeInTheDocument();
    expect(campo()).toBeEnabled();
    expect(campo().value).toBe("guardado.uno");

    fireEvent.change(campo(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(f.api.update).toHaveBeenCalledTimes(1));
    expect(f.api.update.mock.calls[0]![1].username).toBeNull();
  });

  it("EDICIÓN: «Crear credenciales» no se puede pulsar sin nombre o con uno mal formado", async () => {
    await montarEdicion(f.registro({ username: null }));
    expect(campo().value).toBe("");
    expect(botonCrear()).toBeDisabled();

    fireEvent.change(campo(), { target: { value: "ab" } });
    expect(botonCrear()).toBeDisabled();

    fireEvent.change(campo(), { target: { value: "nombre.valido" } });
    expect(botonCrear()).toBeEnabled();
  });

  it("ÉXITO: envía el nombre escrito y después el campo queda bloqueado", async () => {
    await montarEdicion(f.registro({ username: null }));
    f.api.createCredentials.mockResolvedValue({ username: "nuevo.acceso", temporaryPassword: "Temporal123" });
    f.api.get.mockResolvedValue(f.registro({ username: "nuevo.acceso", user: CUENTA("nuevo.acceso") }));

    fireEvent.change(campo(), { target: { value: " nuevo.acceso " } });
    fireEvent.click(botonCrear()!);

    await waitFor(() => expect(f.api.createCredentials).toHaveBeenCalledWith(expect.any(String), "nuevo.acceso"));
    await waitFor(() => expect(campo()).toBeDisabled());
    expect(campo().value).toBe("nuevo.acceso");
    expect(botonCrear()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Restablecer contraseña/i })).toBeInTheDocument();
    expect(screen.getByText(/No se puede modificar/)).toBeInTheDocument();
  });

  it("FALLO: se muestra el error y el campo sigue editable con lo escrito", async () => {
    await montarEdicion(f.registro({ username: null }));
    f.api.createCredentials.mockRejectedValue(new Error("Ese nombre de usuario ya está en uso por un club."));

    fireEvent.change(campo(), { target: { value: "ocupado.ya" } });
    fireEvent.click(botonCrear()!);

    expect(await screen.findByRole("alert")).toHaveTextContent(/ya está en uso/);
    expect(campo()).toBeEnabled();
    expect(campo().value).toBe("ocupado.ya");
    expect(botonCrear()).toBeEnabled();
  });

  it("CON CUENTA: el campo es de solo lectura y «Guardar» ya no envía el nombre", async () => {
    await montarEdicion(f.registro({ username: "con.cuenta", user: CUENTA("con.cuenta") }));
    expect(campo()).toBeDisabled();
    expect(campo().value).toBe("con.cuenta");
    expect(botonCrear()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(f.api.update).toHaveBeenCalledTimes(1));
    expect(f.api.update.mock.calls[0]![1]).not.toHaveProperty("username");
  });
  // -------------------------------------------------------------------------
  // Corrección 1 — nombres antiguos que no cumplen el formato actual
  // -------------------------------------------------------------------------

  describe("nombre ANTIGUO de tres caracteres, sin cuenta", () => {
    const antiguo = () => f.registro({ username: "ana" });

    it("el campo no se marca como inválido y «Crear credenciales» sigue disponible", async () => {
      await montarEdicion(antiguo());
      expect(campo().value).toBe("ana");
      expect(screen.queryByText(/entre 4 y 30/)).not.toBeInTheDocument();
      expect(botonCrear()).toBeEnabled();
    });

    it("editar OTRO dato guarda SIN enviar username, y no bloquea por el formato antiguo", async () => {
      await montarEdicion(antiguo());
      f.editarOtroDato();
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

      await waitFor(() => expect(f.api.update).toHaveBeenCalledTimes(1));
      expect(f.api.update.mock.calls[0]![1], "el nombre antiguo no se reenvía").not.toHaveProperty("username");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("cambiarlo por OTRO INVÁLIDO se rechaza y no se guarda nada", async () => {
      await montarEdicion(antiguo());
      fireEvent.change(campo(), { target: { value: "ab" } });
      expect(screen.getByText(/entre 4 y 30/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/entre 4 y 30/);
      expect(f.api.update).not.toHaveBeenCalled();
    });

    it("dejar el antiguo y volver a escribirlo igual NO cuenta como cambio", async () => {
      await montarEdicion(antiguo());
      fireEvent.change(campo(), { target: { value: "otro" } });
      fireEvent.change(campo(), { target: { value: " ana " } });
      f.editarOtroDato();
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

      await waitFor(() => expect(f.api.update).toHaveBeenCalledTimes(1));
      expect(f.api.update.mock.calls[0]![1]).not.toHaveProperty("username");
    });

    it("cambiarlo por uno VÁLIDO lo envía recortado", async () => {
      await montarEdicion(antiguo());
      fireEvent.change(campo(), { target: { value: " ana.valida " } });
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

      await waitFor(() => expect(f.api.update).toHaveBeenCalledTimes(1));
      expect(f.api.update.mock.calls[0]![1].username).toBe("ana.valida");
    });

    it("QUITARLO (sin cuenta) lo envía como null", async () => {
      await montarEdicion(antiguo());
      fireEvent.change(campo(), { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

      await waitFor(() => expect(f.api.update).toHaveBeenCalledTimes(1));
      expect(f.api.update.mock.calls[0]![1].username).toBeNull();
    });

    it("crear credenciales sin tocar el campo usa el guardado: no reenvía el nombre antiguo", async () => {
      await montarEdicion(antiguo());
      f.api.createCredentials.mockResolvedValue({ username: "ana", temporaryPassword: "Temporal123" });
      f.api.get.mockResolvedValue(f.registro({ username: "ana", user: CUENTA("ana") }));

      fireEvent.click(botonCrear()!);

      await waitFor(() => expect(f.api.createCredentials).toHaveBeenCalledWith(expect.any(String), null));
      await waitFor(() => expect(campo()).toBeDisabled());
    });

    it("el ALTA conserva la validación: tres caracteres se rechazan", async () => {
      montar(f.rutaAlta);
      f.rellenarAlta();
      fireEvent.change(campo(), { target: { value: "ana" } });
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(/entre 4 y 30/);
      expect(f.api.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Corrección 2 — la creación se confirmó, pero la relectura de la ficha falla o tarda
  // -------------------------------------------------------------------------

  describe("POST exitoso y relectura de la ficha problemática", () => {
    const CONFIRMADA = { username: "nuevo.acceso", temporaryPassword: "Temporal123" };

    /** Monta la ficha sin cuenta y escribe un nombre válido, listo para crear. */
    async function prepararCreacion() {
      await montarEdicion(f.registro({ username: null }));
      f.api.createCredentials.mockResolvedValue(CONFIRMADA);
      fireEvent.change(campo(), { target: { value: "nuevo.acceso" } });
    }

    it("GET RECHAZADO: queda bloqueado, sin repetir la creación, con las credenciales a la vista", async () => {
      await prepararCreacion();
      f.api.get.mockRejectedValue(new Error("red caída"));

      fireEvent.click(botonCrear()!);

      await waitFor(() => expect(campo()).toBeDisabled());
      expect(campo().value, "conserva el nombre confirmado").toBe("nuevo.acceso");
      expect(botonCrear(), "no se ofrece repetir la creación").not.toBeInTheDocument();
      expect(screen.getByText(/Credenciales creadas\. Usuario: nuevo\.acceso — Contraseña temporal: Temporal123/)).toBeInTheDocument();

      // El fallo se comunica como fallo de ACTUALIZACIÓN, no de creación.
      const aviso = await screen.findByRole("alert");
      expect(aviso).toHaveTextContent(/se crearon correctamente/);
      expect(aviso).toHaveTextContent(/no se pudo actualizar la ficha/);
      expect(aviso).toHaveTextContent(/red caída/);
      expect(aviso).not.toHaveTextContent(/No se pudieron crear/);

      // No se inventan datos de la cuenta: sin estado confirmado, sin insignia.
      expect(screen.queryByText("active")).not.toBeInTheDocument();
      expect(f.api.createCredentials).toHaveBeenCalledTimes(1);
      expect(f.api.createCredentials).toHaveBeenCalledWith(expect.any(String), "nuevo.acceso");
    });

    it("GET PENDIENTE: bloquea de inmediato, sin esperar la relectura, y se mantiene al llegar", async () => {
      await prepararCreacion();
      let resolverFicha!: (ficha: unknown) => void;
      f.api.get.mockReturnValue(new Promise((resolver) => (resolverFicha = resolver)));

      fireEvent.click(botonCrear()!);

      // La relectura sigue sin responder y la interfaz ya refleja la creación.
      await waitFor(() => expect(campo()).toBeDisabled());
      expect(campo().value).toBe("nuevo.acceso");
      expect(botonCrear()).not.toBeInTheDocument();
      expect(screen.getByText(/Credenciales creadas\. Usuario: nuevo\.acceso/)).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(f.api.createCredentials).toHaveBeenCalledTimes(1);

      // Al llegar la ficha, sigue bloqueado y ahora sí hay estado confirmado.
      resolverFicha(f.registro({ username: "nuevo.acceso", user: CUENTA("nuevo.acceso") }));
      await waitFor(() => expect(screen.getByText("active")).toBeInTheDocument());
      expect(campo()).toBeDisabled();
      expect(botonCrear()).not.toBeInTheDocument();
      expect(f.api.createCredentials).toHaveBeenCalledTimes(1);
    });

    it("tras la creación confirmada, «Guardar» no envía el nombre aunque la ficha no se haya releído", async () => {
      await prepararCreacion();
      f.api.get.mockRejectedValue(new Error("red caída"));
      fireEvent.click(botonCrear()!);
      await waitFor(() => expect(campo()).toBeDisabled());

      f.editarOtroDato();
      fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

      await waitFor(() => expect(f.api.update).toHaveBeenCalledTimes(1));
      expect(f.api.update.mock.calls[0]![1]).not.toHaveProperty("username");
    });

    it("si el POST FALLA, todo sigue como antes: campo editable, botón disponible y corregible", async () => {
      await prepararCreacion();
      f.api.createCredentials.mockRejectedValueOnce(new Error("Ese nombre de usuario ya está en uso por un club."));
      f.api.get.mockClear();

      fireEvent.click(botonCrear()!);

      const aviso = await screen.findByRole("alert");
      expect(aviso).toHaveTextContent(/ya está en uso/);
      expect(campo()).toBeEnabled();
      expect(campo().value).toBe("nuevo.acceso");
      expect(botonCrear()).toBeEnabled();
      expect(f.api.get, "no se relee la ficha si la creación falló").not.toHaveBeenCalled();
      expect(screen.queryByText(/Credenciales creadas/)).not.toBeInTheDocument();

      // Se corrige y se vuelve a intentar.
      f.api.createCredentials.mockResolvedValueOnce({ username: "otro.acceso", temporaryPassword: "Temporal456" });
      f.api.get.mockResolvedValue(f.registro({ username: "otro.acceso", user: CUENTA("otro.acceso") }));
      fireEvent.change(campo(), { target: { value: "otro.acceso" } });
      fireEvent.click(botonCrear()!);
      await waitFor(() => expect(campo()).toBeDisabled());
    });
  });
});
