/**
 * C-05, fase 3: el panel de revisión trae el historial COMPLETO (más de 100 membresías, la activa
 * en una página posterior) y comparte la barrera de operación. API simulada, datos sintéticos, jsdom.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { StrictMode } from "react";
import { ApiError } from "../../shared/apiClient";
import { PanelDeActivacion } from "./PanelDeActivacion";
import { useOperacionUnica, type OperacionUnica } from "../../shared/useOperacionUnica";

const list = vi.fn();
vi.mock("./assignmentApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./assignmentApi")>()),
  useSwimmerAssignmentApi: () => ({ list }),
}));

const DESTINO = { id: "club-destino", name: "Club Destino" };
const HOY = "2026-11-12";

/** 150 membresías de una persona en el orden del backend; la ACTIVA es la 141 (página 2). */
function historialLargo(personId: string, posicionActiva = 140) {
  return Array.from({ length: 150 }, (_, i) => {
    const activa = i === posicionActiva;
    const club = activa ? { id: "club-vigente", name: "Club Vigente" } : { id: `club-${i}`, name: `Club Viejo ${i}` };
    return {
      id: `${personId}-m${i}`,
      clubId: club.id,
      personId,
      status: activa ? "active" : "ended",
      startDate: "2020-01-01T00:00:00.000Z",
      fechaTermino: activa ? null : "2020-12-31T00:00:00.000Z",
      endDate: null,
      club,
      person: { id: personId, fullName: "Sintético", run: "1-9" },
    };
  });
}

/** Servidor que pagina de verdad (máximo 100 por página, como el backend). */
function paginar(todas: unknown[]) {
  return async ({ page = 1, pageSize = 20 }: { page?: number; pageSize?: number }) => {
    const tam = Math.min(pageSize, 100);
    return { items: todas.slice((page - 1) * tam, page * tam), total: todas.length, page, pageSize: tam };
  };
}

function Montaje(props: {
  personaId: string;
  clubDestino?: { id: string; name: string };
  permiteTraslado?: boolean;
  enviar?: () => Promise<unknown>;
  operacion?: OperacionUnica;
}) {
  return (
    <PanelDeActivacion
      personaId={props.personaId}
      clubDestino={props.clubDestino ?? DESTINO}
      permiteTraslado={props.permiteTraslado ?? true}
      hoy={HOY}
      etiquetaConfirmar="Confirmar"
      enviar={props.enviar ?? (async () => ({}))}
      onExito={() => undefined}
      onCancelar={() => undefined}
      operacion={props.operacion}
    />
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});
afterEach(() => vi.useRealTimers());

describe("historial completo (más de 100 membresías)", () => {
  it("encuentra la vigente en la página 2 y exige confirmarla; nunca pide más de 100 por página", async () => {
    list.mockImplementation(paginar(historialLargo("p-1")));
    const enviar = vi.fn(async () => ({}));
    render(<Montaje personaId="p-1" enviar={enviar} />);

    const casilla = await screen.findByRole("checkbox", { name: /Confirmo finalizar la membresía vigente en Club Vigente/ });
    expect(screen.getByText("Club Vigente")).toBeInTheDocument();
    expect(screen.queryByText(/no tiene otra membresía activa/), "no se afirma que no hay activa").not.toBeInTheDocument();
    const confirmar = screen.getByRole("button", { name: "Confirmar" });
    expect(confirmar).toBeDisabled();

    fireEvent.click(casilla);
    fireEvent.click(confirmar);
    await waitFor(() => expect(enviar).toHaveBeenCalledWith({ fechaEfectiva: HOY, confirmarFinDeMembresiaId: "p-1-m140" }));

    const pedidas = list.mock.calls.map((c) => c[0]);
    expect(pedidas.map((p) => p.page)).toEqual([1, 2]);
    for (const p of pedidas) {
      expect(p.personId).toBe("p-1");
      expect(p.pageSize).toBeLessThanOrEqual(100);
    }
  });

  it("asignación directa (sin traslado): con la activa en la página 2 no se presenta como posible", async () => {
    list.mockImplementation(paginar(historialLargo("p-1")));
    render(<Montaje personaId="p-1" permiteTraslado={false} />);
    expect(await screen.findByText(/no trasladan/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDisabled();
  });

  it("si una página posterior falla, no se trunca en silencio: error y sin confirmar", async () => {
    const todas = historialLargo("p-1");
    list.mockImplementation(async ({ page = 1, pageSize = 20 }: { page?: number; pageSize?: number }) => {
      if (page === 2) throw new ApiError("Error 500", 500);
      return paginar(todas)({ page, pageSize });
    });
    render(<Montaje personaId="p-1" permiteTraslado={false} />);
    expect(await screen.findByText("Error 500")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDisabled();
    expect(screen.queryByText(/no tiene otra membresía activa/)).not.toBeInTheDocument();
  });

  it("una página posterior que llega VACÍA pese al total también se rechaza", async () => {
    const todas = historialLargo("p-1");
    list.mockImplementation(async ({ page = 1, pageSize = 20 }: { page?: number; pageSize?: number }) =>
      page === 2 ? { items: [], total: todas.length, page: 2, pageSize: 100 } : paginar(todas)({ page, pageSize })
    );
    render(<Montaje personaId="p-1" permiteTraslado={false} />);
    expect(await screen.findByText(/no está completa|Se reunieron 100/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDisabled();
  });
});

describe("cambio de persona", () => {
  it("la carga atrasada de la persona anterior no sustituye la de la nueva, y lo confirmado se reinicia", async () => {
    let resolverA!: (v: unknown) => void;
    list.mockImplementation(({ personId, page = 1, pageSize = 20 }: { personId: string; page?: number; pageSize?: number }) => {
      if (personId === "p-a") return new Promise((r) => (resolverA = r));
      // B tiene una vigente en otro club, en una sola página.
      return paginar(historialLargo("p-b", 3).slice(0, 10))({ page, pageSize });
    });
    const { rerender } = render(<Montaje personaId="p-a" />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    rerender(<Montaje personaId="p-b" />);
    const casilla = await screen.findByRole("checkbox", { name: /Confirmo finalizar la membresía vigente en Club Vigente/ });
    fireEvent.click(casilla);
    expect(casilla).toBeChecked();

    // A responde tarde con SU historial (vigente en otro club): no se aplica.
    await act(async () => {
      resolverA({ items: [{ ...historialLargo("p-a", 0)[0], club: { id: "club-a", name: "Club De A" } }], total: 1, page: 1, pageSize: 100 });
    });
    expect(screen.queryByText("Club De A")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Club Vigente/ })).toBeChecked();

    // Volver a cambiar de persona reinicia la confirmación.
    rerender(<Montaje personaId="p-c" />);
    expect(await screen.findByRole("checkbox", { name: /Club Vigente/ })).not.toBeChecked();
  });
});

describe("cambio de destino con la misma persona (misma instancia, sin key)", () => {
  const OTRO_DESTINO = { id: "club-otro-destino", name: "Club Otro Destino" };

  it("recupera un historial válido, reinicia la confirmación y no queda cargando", async () => {
    list.mockImplementation(paginar(historialLargo("p-1", 3).slice(0, 10)));
    const { rerender } = render(<Montaje personaId="p-1" />);
    const casilla = await screen.findByRole("checkbox", { name: /Confirmo finalizar la membresía vigente en Club Vigente/ });
    fireEvent.click(casilla);
    expect(casilla).toBeChecked();
    const cargasAntes = list.mock.calls.length;

    rerender(<Montaje personaId="p-1" clubDestino={OTRO_DESTINO} />);

    const nueva = await screen.findByRole("checkbox", { name: /Confirmo finalizar la membresía vigente en Club Vigente/ });
    expect(nueva, "la confirmación del destino anterior no sobrevive").not.toBeChecked();
    expect(screen.getByText("Fecha efectiva (inicio en Club Otro Destino)")).toBeInTheDocument();
    expect(screen.queryByText("Cargando el historial…")).not.toBeInTheDocument();
    expect(list.mock.calls.length, "se volvió a pedir el historial").toBeGreaterThan(cargasAntes);
    expect(screen.getByRole("button", { name: "Confirmar" })).toBeDisabled();
  });

  it("también bajo StrictMode (montaje doble en desarrollo)", async () => {
    list.mockImplementation(paginar(historialLargo("p-1", 3).slice(0, 10)));
    const { rerender } = render(
      <StrictMode>
        <Montaje personaId="p-1" />
      </StrictMode>
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: /Club Vigente/ }));
    rerender(
      <StrictMode>
        <Montaje personaId="p-1" clubDestino={OTRO_DESTINO} />
      </StrictMode>
    );
    expect(await screen.findByRole("checkbox", { name: /Club Vigente/ })).not.toBeChecked();
    expect(screen.getByText("Fecha efectiva (inicio en Club Otro Destino)")).toBeInTheDocument();
  });

  it("la carga del destino anterior que llega tarde no se aplica sobre la del nuevo", async () => {
    let resolverVieja!: (v: unknown) => void;
    // Primera carga (destino anterior) en vuelo; las siguientes responden al instante.
    list.mockImplementationOnce(() => new Promise((r) => (resolverVieja = r)));
    list.mockImplementation(paginar(historialLargo("p-1", 3).slice(0, 10)));
    const { rerender } = render(<Montaje personaId="p-1" />);
    await waitFor(() => expect(list).toHaveBeenCalled());

    rerender(<Montaje personaId="p-1" clubDestino={OTRO_DESTINO} />);
    expect(await screen.findByRole("checkbox", { name: /Club Vigente/ })).toBeInTheDocument();

    // La respuesta atrasada trae otra vigente: no puede reemplazar la revisión actual.
    await act(async () => {
      resolverVieja({ items: [{ ...historialLargo("p-1", 0)[0], club: { id: "club-tardio", name: "Club Tardío" } }], total: 1, page: 1, pageSize: 100 });
    });
    expect(screen.queryByText("Club Tardío")).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Club Vigente/ })).toBeInTheDocument();
  });
});

describe("barrera de operación compartida", () => {
  function ConOperacionExterna({ alListo }: { alListo: (op: OperacionUnica) => void }) {
    const op = useOperacionUnica();
    alListo(op);
    return <Montaje personaId="p-x" operacion={op} enviar={async () => new Promise(() => undefined)} />;
  }

  it("si el contenedor tiene otra escritura en curso, el panel no envía", async () => {
    list.mockImplementation(paginar([]));
    let op!: OperacionUnica;
    render(<ConOperacionExterna alListo={(o) => (op = o)} />);
    const confirmar = await screen.findByRole("button", { name: "Confirmar" });
    await waitFor(() => expect(confirmar).toBeEnabled());
    act(() => {
      op.iniciar();
    });
    expect(screen.getByRole("button", { name: /Confirmar|Enviando/ })).toBeDisabled();
  });
});
