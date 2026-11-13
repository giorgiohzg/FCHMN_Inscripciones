/**
 * C-05, fase 4: pantalla «Incorporaciones» del club. API simulada, datos sintéticos, jsdom.
 * El club y la cuota los decide el servidor (simulado aquí); la pantalla solo los muestra.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { ApiError } from "../../shared/apiClient";
import { IncorporacionesClubPage } from "./IncorporacionesClubPage";

vi.mock("../../shared/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

let usuario = { id: "u-club-1", clubId: "club-1" };
vi.mock("../auth/AuthContext", () => ({ useAuth: () => ({ user: usuario }) }));

const postular = vi.fn();
const completarAlta = vi.fn();
const cuota = vi.fn();
const periodoVigente = vi.fn();
const propuestas = vi.fn();
const solicitudes = vi.fn();
vi.mock("./postulacionApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./postulacionApi")>()),
  usePostulacionApi: () => ({ postular, completarAlta, cuota, periodoVigente, propuestas, solicitudes }),
}));

const RUN_VALIDO = "12.345.678-5";
const RUN_OTRO = "11.111.111-1";
const vacia = (page = 1) => ({ items: [], total: 0, page, pageSize: 20 });
const PROPUESTA = { id: "m-1", status: "pending", club: { id: "club-1", name: "Club Uno" }, person: { id: "p-1", fullName: "Persona Sintética", run: "12.345.678-5" }, createdAt: "2026-11-12T15:00:00.000Z" };

function montar() {
  return render(<IncorporacionesClubPage />);
}
const campoRun = () => screen.getByLabelText("RUN del nadador");
function escribirRun(v: string) {
  fireEvent.change(campoRun(), { target: { value: v } });
}
const botonPostular = () => screen.getByRole("button", { name: /Postular|Reintentar la misma postulación|Enviando/ });

beforeEach(() => {
  vi.resetAllMocks();
  usuario = { id: "u-club-1", clubId: "club-1" };
  cuota.mockResolvedValue({ usados: 7, limite: 30, dia: "2026-11-12", restantes: 23 });
  periodoVigente.mockResolvedValue({ vigente: false });
  propuestas.mockImplementation(async ({ page }: { page: number }) => vacia(page));
  solicitudes.mockImplementation(async ({ page }: { page: number }) => vacia(page));
});
afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("contexto del servidor", () => {
  it("muestra la cuota y el periodo tal como los informa el servidor", async () => {
    periodoVigente.mockResolvedValue({ vigente: true, inicio: "2026-11-01", fin: "2026-11-30" });
    montar();
    expect(await screen.findByText(/7 de 30\. Quedan 23/)).toBeInTheDocument();
    expect(screen.getByText(/compartida por todas las cuentas del club/)).toBeInTheDocument();
    expect(screen.getByText(/habilitado del 01-11-2026 al 30-11-2026/)).toBeInTheDocument();
  });

  it("sin periodo vigente lo explica, sin apertura automática", async () => {
    montar();
    expect(await screen.findByText(/solo puede postular a personas sin membresía activa/)).toBeInTheDocument();
    expect(screen.getByText(/no se abren solos en marzo ni en agosto/)).toBeInTheDocument();
  });

  it("la cuota mostrada es la del servidor tras cada intento, sin descontarla localmente", async () => {
    cuota.mockResolvedValueOnce({ usados: 7, limite: 30, dia: "2026-11-12", restantes: 23 });
    cuota.mockResolvedValueOnce({ usados: 9, limite: 30, dia: "2026-11-12", restantes: 21 }); // otra cuenta del club también postuló
    postular.mockResolvedValue({ resultado: "propuesta_creada", propuesta: PROPUESTA });
    montar();
    await screen.findByText(/7 de 30/);
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    expect(await screen.findByText(/9 de 30\. Quedan 21/)).toBeInTheDocument();
    expect(cuota).toHaveBeenCalledTimes(2);
  });
});

describe("persona registrada", () => {
  it("envía SOLO el RUN con una clave, y explica que queda pendiente de revisión", async () => {
    postular.mockResolvedValue({ resultado: "propuesta_creada", propuesta: PROPUESTA });
    montar();
    escribirRun(`  ${RUN_VALIDO} `);
    fireEvent.click(botonPostular());
    await waitFor(() => expect(postular).toHaveBeenCalledTimes(1));
    const [run, clave] = postular.mock.calls[0]!;
    expect(run).toBe(RUN_VALIDO);
    expect(clave).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    const aviso = await screen.findByText(/Postulación registrada: Persona Sintética/);
    expect(aviso.textContent).toMatch(/pendiente de revisión de la administración/);
    expect(aviso.textContent).toMatch(/no forma parte del club/);
    expect(aviso.textContent).not.toMatch(/activa|miembro activo/i);
    expect((campoRun() as HTMLInputElement).value).toBe("");
  });

  it("un RUN inválido se rechaza localmente y no se envía", async () => {
    montar();
    escribirRun("12.345.678-9");
    fireEvent.click(botonPostular());
    expect(await screen.findByText(/El RUN no es válido/)).toBeInTheDocument();
    expect(postular).not.toHaveBeenCalled();
  });
});

describe("RUN no registrado: segundo paso", () => {
  it("pide nombre y apellido declarados y los envía ligados al intento, sin RUN", async () => {
    postular.mockResolvedValue({ resultado: "requiere_datos_de_alta", intentoId: "int-1", expiraEn: "2026-11-12T15:15:00.000Z" });
    completarAlta.mockResolvedValue({ resultado: "solicitud_alta_creada", solicitud: null });
    montar();
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    expect(await screen.findByRole("heading", { name: "Datos declarados por el club" })).toBeInTheDocument();
    expect(screen.queryByLabelText("RUN del nadador"), "el RUN no se vuelve a pedir").not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: " Ana " } });
    fireEvent.change(screen.getByLabelText("Apellido"), { target: { value: "Sintética" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar solicitud de alta" }));
    await waitFor(() => expect(completarAlta).toHaveBeenCalledWith("int-1", "Ana", "Sintética"));
    expect(postular, "no se repite la postulación").toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Solicitud de alta enviada/)).toBeInTheDocument();
  });

  it("si la persona quedó registrada entre pasos, informa la propuesta pendiente", async () => {
    postular.mockResolvedValue({ resultado: "requiere_datos_de_alta", intentoId: "int-2", expiraEn: "2026-11-12T15:15:00.000Z" });
    completarAlta.mockResolvedValue({ resultado: "propuesta_creada", propuesta: PROPUESTA });
    montar();
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    fireEvent.change(await screen.findByLabelText("Nombre"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("Apellido"), { target: { value: "Sintética" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar solicitud de alta" }));
    expect(await screen.findByText(/quedó registrada entre tanto.*pendiente de revisión/)).toBeInTheDocument();
  });

  it.each([
    ["PASO_VENCIDO", /Venció el plazo/],
    ["PASO_YA_UTILIZADO", /ya se completó con otros datos/],
    ["PASO_NO_ENCONTRADO", /ya no está disponible para su cuenta/],
  ])("%s descarta el paso y lo explica", async (codigo, texto) => {
    postular.mockResolvedValue({ resultado: "requiere_datos_de_alta", intentoId: "int-3", expiraEn: "2026-11-12T15:15:00.000Z" });
    completarAlta.mockRejectedValue(new ApiError("x", codigo === "PASO_NO_ENCONTRADO" ? 404 : 409, codigo));
    montar();
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    fireEvent.change(await screen.findByLabelText("Nombre"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("Apellido"), { target: { value: "Sintética" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar solicitud de alta" }));
    expect(await screen.findByText(texto)).toBeInTheDocument();
    expect(screen.queryByLabelText("Nombre")).not.toBeInTheDocument();
    expect(screen.getByLabelText("RUN del nadador")).toBeInTheDocument();
  });

  it("un fallo técnico conserva el paso; reintentar reenvía el MISMO intento con los mismos datos", async () => {
    postular.mockResolvedValue({ resultado: "requiere_datos_de_alta", intentoId: "int-4", expiraEn: "2026-11-12T15:15:00.000Z" });
    completarAlta.mockRejectedValueOnce(new ApiError("caído", 503, "SERVICE_UNAVAILABLE"));
    completarAlta.mockResolvedValueOnce({ resultado: "solicitud_alta_creada", solicitud: null });
    montar();
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    fireEvent.change(await screen.findByLabelText("Nombre"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("Apellido"), { target: { value: "Sintética" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar solicitud de alta" }));
    expect(await screen.findByText(/no se duplicará/)).toBeInTheDocument();
    expect(completarAlta).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reintentar el envío" }));
    await waitFor(() => expect(completarAlta).toHaveBeenCalledTimes(2));
    expect(completarAlta.mock.calls[1]).toEqual(["int-4", "Ana", "Sintética"]);
    expect(await screen.findByText(/Solicitud de alta enviada/)).toBeInTheDocument();
  });
});

describe("idempotencia y resultados inciertos", () => {
  it("tras un fallo de red se REINTENTA con la misma clave; nada se reenvía solo", async () => {
    postular.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    postular.mockResolvedValueOnce({ resultado: "propuesta_creada", repeticion: true, propuesta: PROPUESTA });
    montar();
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    expect(await screen.findByText(/No se pudo confirmar si la postulación se registró/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(postular, "sin reintento automático").toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Reintentar la misma postulación" }));
    await waitFor(() => expect(postular).toHaveBeenCalledTimes(2));
    expect(postular.mock.calls[1]![1], "misma clave").toBe(postular.mock.calls[0]![1]);
    expect(await screen.findByText(/Esta postulación ya estaba registrada/)).toBeInTheDocument();
  });

  it("OPERACION_EN_CURSO conserva la clave; cambiar el RUN usa una clave NUEVA", async () => {
    postular.mockRejectedValueOnce(new ApiError("en curso", 409, "OPERACION_EN_CURSO", { reintentarEnSegundos: 2 }));
    postular.mockResolvedValueOnce({ resultado: "propuesta_creada", propuesta: PROPUESTA });
    montar();
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    expect(await screen.findByText(/todavía se está procesando/)).toBeInTheDocument();
    escribirRun(RUN_OTRO);
    fireEvent.click(botonPostular());
    await waitFor(() => expect(postular).toHaveBeenCalledTimes(2));
    expect(postular.mock.calls[1]![0]).toBe(RUN_OTRO);
    expect(postular.mock.calls[1]![1], "otro RUN, otra postulación").not.toBe(postular.mock.calls[0]![1]);
  });

  it("INTENTO_INTERRUMPIDO descarta la clave: la siguiente postulación, a pedido del usuario, usa otra", async () => {
    postular.mockRejectedValueOnce(new ApiError("interrumpido", 409, "INTENTO_INTERRUMPIDO"));
    postular.mockResolvedValueOnce({ resultado: "propuesta_creada", propuesta: PROPUESTA });
    montar();
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    expect(await screen.findByText(/se interrumpió y ya contó en la cuota/)).toBeInTheDocument();
    expect(postular).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Postular" }));
    await waitFor(() => expect(postular).toHaveBeenCalledTimes(2));
    expect(postular.mock.calls[1]![1]).not.toBe(postular.mock.calls[0]![1]);
  });

  it("DOBLE clic y Enter durante el envío: una sola escritura", async () => {
    let resolver!: (v: unknown) => void;
    postular.mockImplementationOnce(() => new Promise((r) => (resolver = r)));
    montar();
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    fireEvent.click(botonPostular());
    fireEvent.keyDown(campoRun(), { key: "Enter" });
    expect(postular).toHaveBeenCalledTimes(1);
    expect(campoRun()).toBeDisabled();
    await act(async () => resolver({ resultado: "propuesta_creada", propuesta: PROPUESTA }));
    expect(await screen.findByText(/Postulación registrada/)).toBeInTheDocument();
  });
});

describe("rechazos con código estructurado", () => {
  it.each([
    ["CUOTA_AGOTADA", 429, /alcanzó los intentos de hoy/],
    ["MEMBRESIA_ACTIVA_FUERA_DE_PERIODO", 409, /solo puede postularse durante un periodo habilitado/],
    ["DUPLICADO", 409, /Ya hay una propuesta o solicitud pendiente/],
    ["IDEMPOTENCIA_CONFLICTO", 409, /no coincide con la actual/],
  ])("%s", async (codigo, status, texto) => {
    postular.mockRejectedValue(new ApiError("mensaje del servidor", status, codigo));
    montar();
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    expect(await screen.findByText(texto)).toBeInTheDocument();
    // Un rechazo definitivo no se ofrece como «reintentar la misma».
    expect(screen.queryByRole("button", { name: "Reintentar la misma postulación" })).not.toBeInTheDocument();
  });

  it("tras un fallo técnico definitivo (503 con código) se puede recuperar", async () => {
    postular.mockRejectedValueOnce(new ApiError("caído", 503, "SERVICE_UNAVAILABLE"));
    postular.mockRejectedValueOnce(new ApiError("interrumpido", 409, "INTENTO_INTERRUMPIDO"));
    postular.mockResolvedValueOnce({ resultado: "propuesta_creada", propuesta: PROPUESTA });
    montar();
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    fireEvent.click(await screen.findByRole("button", { name: "Reintentar la misma postulación" }));
    expect(await screen.findByText(/se interrumpió/)).toBeInTheDocument();
    expect(postular.mock.calls[1]![1]).toBe(postular.mock.calls[0]![1]);
    fireEvent.click(screen.getByRole("button", { name: "Postular" }));
    expect(await screen.findByText(/Postulación registrada/)).toBeInTheDocument();
    expect(postular.mock.calls[2]![1]).not.toBe(postular.mock.calls[0]![1]);
  });
});

describe("cambio de usuario o club", () => {
  it("una respuesta tardía del contexto anterior no se aplica, y el segundo paso no sobrevive", async () => {
    postular.mockResolvedValueOnce({ resultado: "requiere_datos_de_alta", intentoId: "int-A", expiraEn: "2026-11-12T15:15:00.000Z" });
    const { rerender } = montar();
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    expect(await screen.findByLabelText("Nombre")).toBeInTheDocument();

    let resolver!: (v: unknown) => void;
    completarAlta.mockImplementationOnce(() => new Promise((r) => (resolver = r)));
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("Apellido"), { target: { value: "Sintética" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar solicitud de alta" }));

    usuario = { id: "u-delegado-2", clubId: "club-2" };
    rerender(<IncorporacionesClubPage />);
    expect(screen.queryByLabelText("Nombre"), "el paso de otra cuenta no sigue").not.toBeInTheDocument();
    expect(screen.getByLabelText("RUN del nadador")).toHaveValue("");

    await act(async () => resolver({ resultado: "solicitud_alta_creada", solicitud: null }));
    expect(screen.queryByText(/Solicitud de alta enviada/), "la respuesta tardía no se pinta").not.toBeInTheDocument();
  });
});

describe("listados del propio club", () => {
  it("propuestas: paginación y descarte de la respuesta de un filtro anterior", async () => {
    let resolverVieja!: (v: unknown) => void;
    propuestas.mockImplementationOnce(() => new Promise((r) => (resolverVieja = r)));
    propuestas.mockImplementation(async ({ page, status }: { page: number; status?: string }) => ({
      items: Array.from({ length: page === 1 ? 20 : 5 }, (_, i) => ({ ...PROPUESTA, id: `m-${status}-${page}-${i}`, status: status ?? "rejected", person: { ...PROPUESTA.person, fullName: `Rechazada ${page}-${i}` } })),
      total: 25,
      page,
      pageSize: 20,
    }));
    montar();
    fireEvent.change(screen.getByLabelText("Estado de las propuestas"), { target: { value: "rejected" } });
    const seccion = screen.getByRole("region", { name: "Propuestas del club" });
    expect(await within(seccion).findByText("Rechazada 1-0")).toBeInTheDocument();
    await act(async () => resolverVieja({ items: [{ ...PROPUESTA, person: { ...PROPUESTA.person, fullName: "Pendiente Vieja" } }], total: 1, page: 1, pageSize: 20 }));
    expect(within(seccion).queryByText("Pendiente Vieja")).not.toBeInTheDocument();
    fireEvent.click(within(seccion).getByRole("button", { name: "Siguiente" }));
    expect(await within(seccion).findByText("Rechazada 2-0")).toBeInTheDocument();
    expect(propuestas).toHaveBeenLastCalledWith({ status: "rejected", page: 2, pageSize: 20 });
  });

  it("solicitudes: distingue lo declarado por el club de lo verificado", async () => {
    solicitudes.mockResolvedValue({
      items: [
        { id: "s-1", estado: "pendiente", club: { id: "club-1", name: "Club Uno" }, run: "22.222.222-2", nombres: "Declarada", apellidos: "Por Club", creadoEn: "2026-11-12T14:00:00.000Z", revisadoEn: null, motivoRechazo: null, persona: null },
        { id: "s-2", estado: "aprobada", club: { id: "club-1", name: "Club Uno" }, run: "33.333.333-3", nombres: "Otra", apellidos: "Declarada", creadoEn: "2026-11-10T14:00:00.000Z", revisadoEn: "2026-11-11T14:00:00.000Z", motivoRechazo: null, persona: { id: "p-9", fullName: "Nombre Verificado", run: "33.333.333-3" } },
      ],
      total: 2,
      page: 1,
      pageSize: 20,
    });
    montar();
    const seccion = screen.getByRole("region", { name: "Solicitudes de alta del club" });
    expect(await within(seccion).findByText("Declarada Por Club")).toBeInTheDocument();
    expect(within(seccion).getByText("Sin verificar")).toBeInTheDocument();
    expect(within(seccion).getByText("Nombre Verificado")).toBeInTheDocument();
  });
});

describe("datos personales fuera de la memoria de la pantalla", () => {
  it("no quedan RUN, nombres ni identificadores en el almacenamiento ni en la consola", async () => {
    const espias = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    postular.mockResolvedValue({ resultado: "requiere_datos_de_alta", intentoId: "int-secreto", expiraEn: "2026-11-12T15:15:00.000Z" });
    completarAlta.mockResolvedValue({ resultado: "solicitud_alta_creada", solicitud: null });
    montar();
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    fireEvent.change(await screen.findByLabelText("Nombre"), { target: { value: "NombreSintetico" } });
    fireEvent.change(screen.getByLabelText("Apellido"), { target: { value: "ApellidoSintetico" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar solicitud de alta" }));
    await screen.findByText(/Solicitud de alta enviada/);

    const almacenado = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage });
    for (const dato of ["12345678", "12.345.678-5", "NombreSintetico", "ApellidoSintetico", "int-secreto"]) {
      expect(almacenado).not.toContain(dato);
      for (const espia of espias) expect(JSON.stringify(espia.mock.calls)).not.toContain(dato);
    }
    espias.forEach((e) => e.mockRestore());
  });
});

describe("ronda de correcciones: errores 5xx, contenido estable y estado actual", () => {
  const ERROR_INTERNO = () => new ApiError("Error interno del servidor", 500, "INTERNAL_ERROR");

  async function hastaSegundoPaso(intentoId = "int-9") {
    postular.mockResolvedValueOnce({ resultado: "requiere_datos_de_alta", intentoId, expiraEn: "2026-11-12T15:15:00.000Z" });
    montar();
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    fireEvent.change(await screen.findByLabelText("Nombre"), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText("Apellido"), { target: { value: "Sintética" } });
  }

  it("primer paso con 500 INTERNAL_ERROR: resultado incierto y reintento con la MISMA clave", async () => {
    postular.mockRejectedValueOnce(ERROR_INTERNO());
    postular.mockResolvedValueOnce({ resultado: "propuesta_creada", repeticion: true, propuesta: PROPUESTA });
    montar();
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    fireEvent.click(await screen.findByRole("button", { name: "Reintentar la misma postulación" }));
    await waitFor(() => expect(postular).toHaveBeenCalledTimes(2));
    expect(postular.mock.calls[1]![1]).toBe(postular.mock.calls[0]![1]);
  });

  it("segundo paso con 500 INTERNAL_ERROR: conserva el intento y lo reenvía", async () => {
    await hastaSegundoPaso("int-500");
    completarAlta.mockRejectedValueOnce(ERROR_INTERNO());
    completarAlta.mockResolvedValueOnce({ resultado: "solicitud_alta_creada", repeticion: true, solicitud: null });
    fireEvent.click(screen.getByRole("button", { name: "Enviar solicitud de alta" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reintentar el envío" }));
    await waitFor(() => expect(completarAlta).toHaveBeenCalledTimes(2));
    expect(completarAlta.mock.calls[1]![0]).toBe("int-500");
  });

  it("tras un resultado incierto, el reenvío lleva EXACTAMENTE lo enviado, aunque se intente cambiar los campos", async () => {
    await hastaSegundoPaso("int-estable");
    completarAlta.mockRejectedValueOnce(ERROR_INTERNO());
    completarAlta.mockResolvedValueOnce({ resultado: "solicitud_alta_creada", repeticion: true, solicitud: null });
    fireEvent.click(screen.getByRole("button", { name: "Enviar solicitud de alta" }));
    expect(await screen.findByText(/Pendiente de confirmar: Ana Sintética/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Otra" } });
    fireEvent.change(screen.getByLabelText("Apellido"), { target: { value: "Persona" } });
    fireEvent.click(screen.getByRole("button", { name: "Reintentar el envío" }));
    await waitFor(() => expect(completarAlta).toHaveBeenCalledTimes(2));
    expect(completarAlta.mock.calls[1]).toEqual(["int-estable", "Ana", "Sintética"]);
  });

  it("con un envío sin confirmar, cerrar el formulario NO se presenta como cancelación", async () => {
    await hastaSegundoPaso();
    completarAlta.mockRejectedValueOnce(ERROR_INTERNO());
    fireEvent.click(screen.getByRole("button", { name: "Enviar solicitud de alta" }));
    await screen.findByText(/Pendiente de confirmar/);
    fireEvent.click(screen.getByRole("button", { name: /Cerrar sin confirmar|Descartar/ }));
    expect(await screen.findByText(/podría haberse guardado/)).toBeInTheDocument();
    expect(screen.queryByText(/Se descartó el paso/)).not.toBeInTheDocument();
  });

  it.each([
    ["active", /fue aprobada/, /pendiente de revisión|no forma parte/],
    ["rejected", /fue rechazada/, /pendiente de revisión|no forma parte/],
  ])("recuperar una propuesta ya %s muestra su estado actual", async (status, esperado, prohibido) => {
    postular.mockRejectedValueOnce(ERROR_INTERNO());
    postular.mockResolvedValueOnce({ resultado: "propuesta_creada", repeticion: true, propuesta: { ...PROPUESTA, status } });
    montar();
    escribirRun(RUN_VALIDO);
    fireEvent.click(botonPostular());
    fireEvent.click(await screen.findByRole("button", { name: "Reintentar la misma postulación" }));
    const aviso = await screen.findByText(esperado);
    expect(aviso.textContent).not.toMatch(prohibido);
  });

  it.each([
    ["aprobada", /fue aprobada/],
    ["rechazada", /fue rechazada/],
    ["resuelta_por_propuesta", /resolvió con una propuesta existente/],
  ])("recuperar una solicitud de alta %s muestra su estado actual", async (estado, esperado) => {
    await hastaSegundoPaso();
    completarAlta.mockRejectedValueOnce(ERROR_INTERNO());
    completarAlta.mockResolvedValueOnce({
      resultado: "solicitud_alta_creada",
      repeticion: true,
      solicitud: { id: "s-r", estado, club: { id: "club-1", name: "Club Uno" }, run: "12.345.678-5", nombres: "Ana", apellidos: "Sintética", creadoEn: "2026-11-12T14:00:00.000Z", revisadoEn: null, motivoRechazo: null, persona: null },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar solicitud de alta" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reintentar el envío" }));
    const aviso = await screen.findByText(esperado);
    expect(aviso.textContent).not.toMatch(/verificará los datos/);
  });

  it("una solicitud de alta realmente pendiente conserva el mensaje de revisión", async () => {
    await hastaSegundoPaso();
    completarAlta.mockResolvedValueOnce({
      resultado: "solicitud_alta_creada",
      solicitud: { id: "s-p", estado: "pendiente", club: { id: "club-1", name: "Club Uno" }, run: "12.345.678-5", nombres: "Ana", apellidos: "Sintética", creadoEn: "2026-11-12T14:00:00.000Z", revisadoEn: null, motivoRechazo: null, persona: null },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar solicitud de alta" }));
    expect(await screen.findByText(/verificará los datos declarados/)).toBeInTheDocument();
  });
});
