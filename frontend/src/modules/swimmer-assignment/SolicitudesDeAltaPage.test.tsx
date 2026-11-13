/** C-05, fase 3: revisión y resolución de solicitudes de alta. API simulada, datos sintéticos, jsdom. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "../../shared/apiClient";
import { SolicitudesDeAltaPage } from "./SolicitudesDeAltaPage";

vi.mock("../../shared/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

const listarSolicitudes = vi.fn();
const obtenerSolicitud = vi.fn();
const aprobarSolicitud = vi.fn();
const rechazarSolicitud = vi.fn();
vi.mock("./incorporacionesApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./incorporacionesApi")>()),
  useIncorporacionesApi: () => ({ listarSolicitudes, obtenerSolicitud, aprobarSolicitud, rechazarSolicitud }),
}));
const list = vi.fn();
vi.mock("./assignmentApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./assignmentApi")>()),
  useSwimmerAssignmentApi: () => ({ list }),
}));

const CLUB = { id: "club-s", name: "Club Solicitante" };
const SOLICITUD = {
  id: "sol-1",
  estado: "pendiente",
  club: CLUB,
  run: "22222222-2",
  nombres: "Declarada",
  apellidos: "Por El Club",
  creadoEn: "2026-11-10T13:00:00.000Z",
  revisadoEn: null,
  motivoRechazo: null,
  persona: null,
};
const sinCoincidencias = { ...SOLICITUD, coincidencias: { personaVigente: null, eliminadas: [] } };

function montar() {
  return render(
    <MemoryRouter>
      <SolicitudesDeAltaPage />
    </MemoryRouter>
  );
}
async function abrirDetalle() {
  montar();
  fireEvent.click(await screen.findByRole("button", { name: "Revisar" }));
  const dialogo = await screen.findByRole("dialog", { name: "Solicitud de alta" });
  await within(dialogo).findByText("Datos declarados por el club (no verificados)");
  return dialogo;
}
function completarPersona(d: HTMLElement) {
  fireEvent.change(within(d).getByLabelText("Nombres"), { target: { value: "Verificada" } });
  fireEvent.change(within(d).getByLabelText("Apellido paterno"), { target: { value: "Documento" } });
  fireEvent.change(within(d).getByLabelText("Fecha de nacimiento"), { target: { value: "1980-05-05" } });
  fireEvent.change(within(d).getByLabelText("Género"), { target: { value: "female" } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T15:00:00Z"));
  vi.resetAllMocks();
  listarSolicitudes.mockResolvedValue({ items: [SOLICITUD], total: 1, page: 1, pageSize: 20 });
  obtenerSolicitud.mockResolvedValue(sinCoincidencias);
  list.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });
});
afterEach(() => vi.useRealTimers());

describe("lista", () => {
  it("muestra club solicitante, RUN, nombres declarados y estado", async () => {
    montar();
    const fila = (await screen.findByText("22222222-2")).closest("tr")!;
    expect(within(fila).getByText(CLUB.name)).toBeInTheDocument();
    expect(within(fila).getByText("Declarada Por El Club")).toBeInTheDocument();
    expect(within(fila).getByText("Pendiente")).toBeInTheDocument();
  });
});

describe("crear persona", () => {
  it("distingue lo declarado de lo verificado y no copia los nombres declarados", async () => {
    const d = await abrirDetalle();
    expect(within(d).getByText("Datos verificados por administración")).toBeInTheDocument();
    expect((within(d).getByLabelText("Nombres") as HTMLInputElement).value, "nada se rellena con lo declarado").toBe("");
    expect(within(d).getByRole("button", { name: "Crear persona y asignar" })).toBeDisabled();
  });

  it("resuelve en UNA petición atómica, sin RUN en el cuerpo y con la fecha expresa", async () => {
    aprobarSolicitud.mockResolvedValue({ ...SOLICITUD, estado: "aprobada", persona: { id: "p-n", fullName: "Verificada Documento", run: "22222222-2" } });
    const d = await abrirDetalle();
    completarPersona(d);
    const boton = within(d).getByRole("button", { name: "Crear persona y asignar" });
    await waitFor(() => expect(boton).toBeEnabled());
    fireEvent.click(boton);
    fireEvent.click(boton);
    await waitFor(() => expect(aprobarSolicitud).toHaveBeenCalledTimes(1));
    const [id, cuerpo] = aprobarSolicitud.mock.calls[0]!;
    expect(id).toBe("sol-1");
    expect(cuerpo).toEqual({
      modo: "crear",
      datosPersona: { firstName: "Verificada", paternalLastName: "Documento", birthDate: "1980-05-05", gender: "female" },
      fechaEfectiva: "2026-11-12",
    });
    expect(JSON.stringify(cuerpo)).not.toContain("22222222");
    expect(await screen.findByText(/Solicitud aprobada: Verificada Documento/)).toBeInTheDocument();
  });

  it("coincidencia con ELIMINADAS: advierte y exige confirmar una persona nueva (sin marcar)", async () => {
    obtenerSolicitud.mockResolvedValue({ ...SOLICITUD, coincidencias: { personaVigente: null, eliminadas: [{ id: "del-1", deletedAt: "2025-01-01T00:00:00.000Z" }] } });
    aprobarSolicitud.mockResolvedValue({ ...SOLICITUD, estado: "aprobada" });
    const d = await abrirDetalle();
    expect(within(d).getByText(/coincide con 1 persona\(s\) eliminada\(s\)/)).toBeInTheDocument();
    expect(within(d).getByText(/sin\s+heredar cuentas, credenciales, roles ni membresías/)).toBeInTheDocument();
    completarPersona(d);
    const casilla = within(d).getByRole("checkbox", { name: /persona nueva pese a la coincidencia/ });
    expect(casilla).not.toBeChecked();
    expect(within(d).getByRole("button", { name: "Crear persona y asignar" })).toBeDisabled();
    fireEvent.click(casilla);
    fireEvent.click(within(d).getByRole("button", { name: "Crear persona y asignar" }));
    await waitFor(() => expect(aprobarSolicitud.mock.calls[0]![1]).toMatchObject({ modo: "crear", crearPeseACoincidenciaEliminada: true }));
  });

  it("COINCIDENCIA_ELIMINADA aparecida entre medias: recarga y pide la confirmación, sin reintentar", async () => {
    const d = await abrirDetalle();
    completarPersona(d);
    obtenerSolicitud.mockResolvedValue({ ...SOLICITUD, coincidencias: { personaVigente: null, eliminadas: [{ id: "del-2", deletedAt: "2025-01-01T00:00:00.000Z" }] } });
    aprobarSolicitud.mockRejectedValueOnce(new ApiError("coincide", 409, "COINCIDENCIA_ELIMINADA", { personasEliminadas: ["del-2"] }));
    fireEvent.click(within(d).getByRole("button", { name: "Crear persona y asignar" }));
    expect(await within(d).findByRole("checkbox", { name: /persona nueva pese a la coincidencia/ })).not.toBeChecked();
    expect(aprobarSolicitud).toHaveBeenCalledTimes(1);
    expect(obtenerSolicitud).toHaveBeenCalledTimes(2);
  });
});

describe("vincular", () => {
  const conVigente = {
    ...SOLICITUD,
    coincidencias: {
      personaVigente: { id: "p-v", fullName: "Registrada Antes", run: "22222222-2", membresiaActiva: { id: "m-v", club: { id: "club-o", name: "Club Origen" }, startDate: "2026-02-01T00:00:00.000Z" } },
      eliminadas: [],
    },
  };

  it("vincula a la persona REVISADA y confirma el traslado aplicable", async () => {
    obtenerSolicitud.mockResolvedValue(conVigente);
    list.mockResolvedValue({
      items: [{ id: "m-v", clubId: "club-o", personId: "p-v", status: "active", startDate: "2026-02-01T00:00:00.000Z", fechaTermino: null, endDate: null, club: { id: "club-o", name: "Club Origen" }, person: { id: "p-v", fullName: "Registrada Antes", run: "22222222-2" } }],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    aprobarSolicitud.mockResolvedValue({ ...SOLICITUD, estado: "aprobada", persona: { id: "p-v", fullName: "Registrada Antes", run: "22222222-2" } });
    const d = await abrirDetalle();
    expect(within(d).getByText("Persona ya registrada con este RUN (datos verificados)")).toBeInTheDocument();
    const boton = await within(d).findByRole("button", { name: "Vincular y asignar" });
    const casilla = await within(d).findByRole("checkbox", { name: /Confirmo finalizar la membresía vigente en Club Origen/ });
    expect(boton).toBeDisabled();
    fireEvent.click(casilla);
    fireEvent.click(boton);
    await waitFor(() =>
      expect(aprobarSolicitud).toHaveBeenCalledWith("sol-1", { modo: "vincular", personaEsperadaId: "p-v", fechaEfectiva: "2026-11-12", confirmarFinDeMembresiaId: "m-v" })
    );
  });

  it("PERSONA_DISTINTA: recarga la solicitud y exige revisar de nuevo", async () => {
    obtenerSolicitud.mockResolvedValue({ ...conVigente, coincidencias: { ...conVigente.coincidencias, personaVigente: { ...conVigente.coincidencias.personaVigente, membresiaActiva: null } } });
    aprobarSolicitud.mockRejectedValueOnce(new ApiError("distinta", 409, "PERSONA_DISTINTA"));
    const d = await abrirDetalle();
    const boton = await within(d).findByRole("button", { name: "Vincular y asignar" });
    await waitFor(() => expect(boton).toBeEnabled());
    fireEvent.click(boton);
    expect(await within(d).findByText(/cambió desde que se cargó/)).toBeInTheDocument();
    await waitFor(() => expect(obtenerSolicitud).toHaveBeenCalledTimes(2));
    expect(aprobarSolicitud).toHaveBeenCalledTimes(1);
  });

  it("queda resuelta por una PROPUESTA existente: se indica", async () => {
    obtenerSolicitud.mockResolvedValue({ ...conVigente, coincidencias: { ...conVigente.coincidencias, personaVigente: { ...conVigente.coincidencias.personaVigente, membresiaActiva: null } } });
    aprobarSolicitud.mockResolvedValue({ ...SOLICITUD, estado: "resuelta_por_propuesta" });
    const d = await abrirDetalle();
    const boton = await within(d).findByRole("button", { name: "Vincular y asignar" });
    await waitFor(() => expect(boton).toBeEnabled());
    fireEvent.click(boton);
    expect(await screen.findByText(/quedó resuelta por la propuesta existente del club/)).toBeInTheDocument();
  });

  it("el detalle de una ya resuelta por propuesta lo explica y no ofrece acciones", async () => {
    listarSolicitudes.mockResolvedValue({ items: [{ ...SOLICITUD, estado: "resuelta_por_propuesta" }], total: 1, page: 1, pageSize: 20 });
    obtenerSolicitud.mockResolvedValue({ ...SOLICITUD, estado: "resuelta_por_propuesta", persona: { id: "p-v", fullName: "Registrada Antes", run: "22222222-2" } });
    montar();
    fireEvent.click(await screen.findByRole("button", { name: "Ver" }));
    const d = await screen.findByRole("dialog", { name: "Solicitud de alta" });
    expect(await within(d).findByText(/la solicitud quedó resuelta por esa propuesta/)).toBeInTheDocument();
    expect(within(d).getByText("Persona verificada por administración")).toBeInTheDocument();
    expect(within(d).queryByRole("button", { name: /Rechazar|Crear|Vincular/ })).not.toBeInTheDocument();
  });
});

describe("rechazar", () => {
  it("exige motivo; volver no envía; confirmar envía el motivo una vez", async () => {
    let resolver!: (v: unknown) => void;
    rechazarSolicitud.mockReturnValue(new Promise((r) => (resolver = r)));
    const d = await abrirDetalle();
    fireEvent.click(within(d).getByRole("button", { name: "Rechazar solicitud…" }));
    const confirmar = within(d).getByRole("button", { name: "Confirmar rechazo" });
    expect(confirmar).toBeDisabled();
    fireEvent.click(within(d).getByRole("button", { name: "Volver" }));
    expect(rechazarSolicitud).not.toHaveBeenCalled();

    fireEvent.click(within(d).getByRole("button", { name: "Rechazar solicitud…" }));
    fireEvent.change(within(d).getByLabelText("Motivo del rechazo"), { target: { value: "RUN no corresponde (sintético)" } });
    fireEvent.click(within(d).getByRole("button", { name: "Confirmar rechazo" }));
    fireEvent.click(within(d).getByRole("button", { name: /Confirmar rechazo|Rechazando/ }));
    expect(rechazarSolicitud).toHaveBeenCalledTimes(1);
    expect(rechazarSolicitud).toHaveBeenCalledWith("sol-1", "RUN no corresponde (sintético)");
    await act(async () => resolver({}));
    expect(await screen.findByText(/Solicitud rechazada/)).toBeInTheDocument();
  });
});

describe("una sola operación en curso (promesas controladas)", () => {
  it("creando: no se puede rechazar, ni cerrar, ni cambiar los datos; una sola escritura; tras el error se reintenta", async () => {
    const d = await abrirDetalle();
    completarPersona(d);
    let rechazarCreacion!: (e: unknown) => void;
    aprobarSolicitud.mockImplementationOnce(() => new Promise((_, rej) => (rechazarCreacion = rej)));
    const crear = within(d).getByRole("button", { name: "Crear persona y asignar" });
    await waitFor(() => expect(crear).toBeEnabled());
    fireEvent.click(crear);
    fireEvent.click(crear);

    const rechazar = within(d).getByRole("button", { name: "Rechazar solicitud…" });
    expect(rechazar).toBeDisabled();
    fireEvent.click(rechazar);
    expect(within(d).queryByLabelText("Motivo del rechazo")).not.toBeInTheDocument();
    expect(within(d).getByLabelText("Nombres")).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".dialogo-fondo")!);
    expect(screen.getByRole("dialog", { name: "Solicitud de alta" })).toBeInTheDocument();
    expect(aprobarSolicitud).toHaveBeenCalledTimes(1);
    expect(rechazarSolicitud).not.toHaveBeenCalled();

    await act(async () => rechazarCreacion(new ApiError("Error 500 sintético", 500)));
    expect(await within(d).findByText("Error 500 sintético")).toBeInTheDocument();
    expect(within(d).getByLabelText("Nombres")).toBeEnabled();
    expect(within(d).getByRole("button", { name: "Rechazar solicitud…" })).toBeEnabled();

    aprobarSolicitud.mockResolvedValueOnce({ ...SOLICITUD, estado: "aprobada" });
    fireEvent.click(within(d).getByRole("button", { name: "Crear persona y asignar" }));
    await waitFor(() => expect(aprobarSolicitud).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/Solicitud aprobada/)).toBeInTheDocument();
  });

  it("vinculando: tampoco se puede iniciar un rechazo", async () => {
    obtenerSolicitud.mockResolvedValue({
      ...SOLICITUD,
      coincidencias: { personaVigente: { id: "p-v", fullName: "Registrada Antes", run: "22222222-2", membresiaActiva: null }, eliminadas: [] },
    });
    let resolver!: (v: unknown) => void;
    aprobarSolicitud.mockImplementationOnce(() => new Promise((r) => (resolver = r)));
    const d = await abrirDetalle();
    const vincular = await within(d).findByRole("button", { name: "Vincular y asignar" });
    await waitFor(() => expect(vincular).toBeEnabled());
    fireEvent.click(vincular);
    expect(within(d).getByRole("button", { name: "Rechazar solicitud…" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Solicitud de alta" })).toBeInTheDocument();
    expect(aprobarSolicitud).toHaveBeenCalledTimes(1);
    expect(rechazarSolicitud).not.toHaveBeenCalled();
    await act(async () => resolver({ ...SOLICITUD, estado: "aprobada" }));
  });

  it("rechazando: los paneles de crear y vincular no están disponibles y el diálogo no se cierra", async () => {
    let resolver!: (v: unknown) => void;
    rechazarSolicitud.mockImplementationOnce(() => new Promise((r) => (resolver = r)));
    const d = await abrirDetalle();
    fireEvent.click(within(d).getByRole("button", { name: "Rechazar solicitud…" }));
    fireEvent.change(within(d).getByLabelText("Motivo del rechazo"), { target: { value: "Sintético" } });
    fireEvent.click(within(d).getByRole("button", { name: "Confirmar rechazo" }));
    expect(within(d).queryByRole("button", { name: "Crear persona y asignar" })).not.toBeInTheDocument();
    expect(within(d).getByRole("button", { name: "Volver" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Solicitud de alta" })).toBeInTheDocument();
    expect(rechazarSolicitud).toHaveBeenCalledTimes(1);
    await act(async () => resolver({}));
  });
});
