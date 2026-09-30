/**
 * Importación en dos pasos: analizar y luego confirmar el tipo de cada relevo.
 *
 * Lo que estas pruebas protegen desde la pantalla:
 *   - no se puede importar sin analizar antes;
 *   - ningún relevo viene con un tipo preseleccionado;
 *   - dos relevos idénticos en distancia, estilo y género se deciden POR
 *     SEPARADO y admiten decisiones distintas;
 *   - no se puede importar mientras falte alguna decisión.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { CompetitionMeetImportPage } from "./CompetitionMeetImportPage";
import type { MeetAnalysis } from "./competitionsApi";

const analyzeMeetEvents = vi.fn();
const importFromMeetEvents = vi.fn();

vi.mock("./competitionsApi", async (original) => {
  const real = await original<typeof import("./competitionsApi")>();
  return {
    ...real,
    useCompetitionsApi: () => ({ analyzeMeetEvents, importFromMeetEvents }),
  };
});

vi.mock("../../shared/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const CUATRO = { testTypeId: "tt-4", nombre: "Relevo", swimmersCount: 4, etiqueta: "4×50", divisible: true };
const DOS = { testTypeId: "tt-2", nombre: "Relevo por parejas", swimmersCount: 2, etiqueta: "2×100", divisible: true };

/** Dos relevos IDÉNTICOS salvo por el número de prueba. */
const ANALISIS_GEMELOS: MeetAnalysis = {
  fileHash: "a".repeat(64),
  formato: "hyv",
  competitionName: "Competencia de Prueba",
  startDate: "2030-01-01T00:00:00.000Z",
  endDate: "2030-01-01T00:00:00.000Z",
  ageCutoffDate: "2030-12-31T00:00:00.000Z",
  dayCount: 1,
  eventsTotal: 12,
  requiereConfirmacionDeRelevos: true,
  warnings: [],
  relevos: [
    { eventNumber: 11, distanceMeters: 200, strokeName: "Combinado", gender: "female", opciones: [DOS, CUATRO] },
    { eventNumber: 13, distanceMeters: 200, strokeName: "Combinado", gender: "female", opciones: [DOS, CUATRO] },
  ],
};

function renderizar() {
  return render(
    <MemoryRouter>
      <CompetitionMeetImportPage />
    </MemoryRouter>
  );
}

async function subirArchivoYAnalizar(user: ReturnType<typeof userEvent.setup>) {
  const archivo = new File(["contenido"], "programa.hyv", { type: "application/octet-stream" });
  await user.upload(screen.getByLabelText(/Archivo de Meet Manager/i), archivo);
  await user.type(screen.getByLabelText(/Máximo de pruebas individuales/i), "5");
  await user.click(screen.getByRole("button", { name: /Analizar archivo/i }));
  await screen.findByText(/Análisis: Competencia de Prueba/i);
}

beforeEach(() => {
  analyzeMeetEvents.mockReset().mockResolvedValue(ANALISIS_GEMELOS);
  importFromMeetEvents.mockReset().mockResolvedValue({
    competitionId: "c1",
    competitionName: "Competencia de Prueba",
    eventsImported: 12,
    eventsSkipped: 0,
    sessionsCreated: 1,
    warnings: [],
  });
});

describe("paso 1 — analizar antes de importar", () => {
  it("no ofrece importar hasta que el archivo se analiza", async () => {
    renderizar();
    expect(screen.queryByRole("button", { name: /Importar competencia/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Analizar archivo/i })).toBeInTheDocument();
  });

  it("dice explícitamente que analizar no crea la competencia", async () => {
    // La promesa es acotada y cierta: el análisis no crea la competencia. No
    // se promete "no escribe nada", porque un análisis fallido sí deja un
    // registro de auditoría.
    renderizar();
    expect(screen.getByText(/Este paso no crea la competencia/i)).toBeInTheDocument();
  });

  it("tras analizar, muestra lo que trae el archivo sin haber importado", async () => {
    const user = userEvent.setup();
    renderizar();
    await subirArchivoYAnalizar(user);

    expect(screen.getByText(/Todavía no se ha creado nada/i)).toBeInTheDocument();
    expect(importFromMeetEvents).not.toHaveBeenCalled();
  });

  it("cambiar el archivo descarta el análisis anterior", async () => {
    const user = userEvent.setup();
    renderizar();
    await subirArchivoYAnalizar(user);

    await user.upload(
      screen.getByLabelText(/Archivo de Meet Manager/i),
      new File(["otro"], "otro.hyv", { type: "application/octet-stream" })
    );

    // Las decisiones estaban numeradas por pruebas de OTRO archivo.
    await waitFor(() => expect(screen.queryByText(/Análisis:/i)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Analizar archivo/i })).toBeInTheDocument();
  });
});

describe("paso 2 — confirmar cada relevo", () => {
  it("presenta los dos relevos idénticos como filas SEPARADAS", async () => {
    const user = userEvent.setup();
    renderizar();
    await subirArchivoYAnalizar(user);

    expect(screen.getByText(/#11 — 200 m Combinado damas/)).toBeInTheDocument();
    expect(screen.getByText(/#13 — 200 m Combinado damas/)).toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
  });

  it("no preselecciona ningún tipo, ni siquiera habiendo una sola opción", async () => {
    const user = userEvent.setup();
    analyzeMeetEvents.mockResolvedValue({
      ...ANALISIS_GEMELOS,
      relevos: [{ ...ANALISIS_GEMELOS.relevos[0]!, opciones: [CUATRO] }],
    });
    renderizar();
    await subirArchivoYAnalizar(user);

    // Con una sola opción la tentación de precargarla es máxima, y es
    // exactamente la elección automática que se quiso eliminar.
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("");
  });

  it("muestra la consecuencia de cada opción, no solo su nombre", async () => {
    const user = userEvent.setup();
    renderizar();
    await subirArchivoYAnalizar(user);

    expect(screen.getAllByRole("option", { name: /Relevo \(4 nadadores\) → 4×50/ }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("option", { name: /Relevo por parejas \(2 nadadores\) → 2×100/ }).length).toBeGreaterThan(0);
  });

  it("ofrece omitir como decisión explícita", async () => {
    const user = userEvent.setup();
    renderizar();
    await subirArchivoYAnalizar(user);

    expect(screen.getAllByRole("option", { name: /No puedo confirmarlo/i }).length).toBe(2);
  });

  it("impide importar mientras falte alguna decisión, y dice cuáles", async () => {
    const user = userEvent.setup();
    renderizar();
    await subirArchivoYAnalizar(user);

    expect(screen.getByRole("button", { name: /Importar competencia/i })).toBeDisabled();
    expect(screen.getByText(/Faltan 2 relevo\(s\) por decidir: #11, #13/)).toBeInTheDocument();

    // Decidir uno NO decide el otro.
    await user.selectOptions(screen.getAllByRole("combobox")[0]!, "tt-4");
    expect(screen.getByText(/Faltan 1 relevo\(s\) por decidir: #13/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Importar competencia/i })).toBeDisabled();
  });

  it("envía decisiones DISTINTAS para dos relevos idénticos", async () => {
    const user = userEvent.setup();
    renderizar();
    await subirArchivoYAnalizar(user);

    const [primero, segundo] = screen.getAllByRole("combobox");
    await user.selectOptions(primero!, "tt-4");
    await user.selectOptions(segundo!, "tt-2");
    await user.click(screen.getByRole("button", { name: /Importar competencia/i }));

    await waitFor(() => expect(importFromMeetEvents).toHaveBeenCalledTimes(1));
    const [, , confirmacion] = importFromMeetEvents.mock.calls[0]!;
    expect(confirmacion.fileHash).toBe("a".repeat(64));
    expect(confirmacion.decisiones).toEqual([
      { eventNumber: 11, decision: "tipo", testTypeId: "tt-4" },
      { eventNumber: 13, decision: "tipo", testTypeId: "tt-2" },
    ]);
  });

  it("traduce la omisión a una decisión explícita, no a un hueco", async () => {
    const user = userEvent.setup();
    renderizar();
    await subirArchivoYAnalizar(user);

    await user.selectOptions(screen.getAllByRole("combobox")[0]!, "tt-4");
    await user.selectOptions(screen.getAllByRole("combobox")[1]!, "__omitir__");
    await user.click(screen.getByRole("button", { name: /Importar competencia/i }));

    await waitFor(() => expect(importFromMeetEvents).toHaveBeenCalledTimes(1));
    const [, , confirmacion] = importFromMeetEvents.mock.calls[0]!;
    expect(confirmacion.decisiones[1]).toEqual({ eventNumber: 13, decision: "omitir" });
  });

  it("un archivo sin relevos no pide confirmar nada", async () => {
    const user = userEvent.setup();
    analyzeMeetEvents.mockResolvedValue({ ...ANALISIS_GEMELOS, relevos: [], requiereConfirmacionDeRelevos: false });
    renderizar();
    await subirArchivoYAnalizar(user);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Importar competencia/i })).toBeEnabled();
  });

  it("muestra el error del backend sin perder las decisiones tomadas", async () => {
    const user = userEvent.setup();
    importFromMeetEvents.mockRejectedValue(new Error("El archivo cambió entre el análisis y la confirmación"));
    renderizar();
    await subirArchivoYAnalizar(user);

    await user.selectOptions(screen.getAllByRole("combobox")[0]!, "tt-4");
    await user.selectOptions(screen.getAllByRole("combobox")[1]!, "tt-2");
    await user.click(screen.getByRole("button", { name: /Importar competencia/i }));

    expect(await screen.findByText(/El archivo cambió entre el análisis/i)).toBeInTheDocument();
    // Las elecciones siguen puestas: rehacerlas sería gratuito y molesto.
    expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).value).toBe("tt-4");
  });
});
