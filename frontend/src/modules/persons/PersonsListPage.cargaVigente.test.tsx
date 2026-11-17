/**
 * Personas: solo la CARGA VIGENTE puede actualizar datos, error e indicador de carga. Una
 * respuesta atrasada (otro orden, otra página u otro filtro) se descarta. Promesas controladas a
 * mano, sin esperas arbitrarias. Datos sintéticos, jsdom.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

type Parametros = { search?: string; orden?: string; page?: number };
interface Pendiente {
  params: Parametros;
  resolver: (v: unknown) => void;
  rechazar: (e: unknown) => void;
}
const pendientes: Pendiente[] = [];
const list = vi.fn(
  (params: Parametros) =>
    new Promise((resolver, rechazar) => {
      pendientes.push({ params, resolver, rechazar });
    })
);
vi.mock("./personsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./personsApi")>()),
  usePersonsApi: () => ({ list, update: vi.fn(), block: vi.fn(), disable: vi.fn(), reactivate: vi.fn(), remove: vi.fn() }),
}));
vi.mock("../../shared/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { PersonsListPage } from "./PersonsListPage";

const persona = (id: string, paterno: string) => ({
  id,
  run: "13579246-2",
  username: null,
  firstName: "Nombre",
  paternalLastName: paterno,
  maternalLastName: null,
  fullName: `Nombre ${paterno}`,
  birthDate: "1980-01-01T00:00:00.000Z",
  gender: "female",
  email: null,
  phone: null,
  status: "active",
  adminAccess: false,
  roles: [],
});
const respuesta = (paterno: string, page = 1) => ({ items: [persona(`${paterno}-${page}`, paterno)], total: 45, page, pageSize: 20 });

/** La petición pendiente que cumple el criterio (la última, si hay varias). */
function pendiente(criterio: (p: Parametros) => boolean): Pendiente {
  const encontrada = [...pendientes].reverse().find((p) => criterio(p.params));
  if (!encontrada)
    throw new Error(`No hay una petición pendiente que cumpla el criterio: ${JSON.stringify(pendientes.map((p) => p.params))}`);
  return encontrada;
}
const resolver = async (p: Pendiente, valor: unknown) => act(async () => p.resolver(valor));
const rechazar = async (p: Pendiente, error: unknown) => act(async () => p.rechazar(error));
const nombreVisible = () =>
  screen
    .getAllByRole("link")
    .map((a) => a.textContent)
    .find((t) => t?.includes(","));

/** Monta y deja visible la primera página ascendente (la carga inicial ya resuelta). */
async function montarConPrimeraPagina() {
  render(
    <MemoryRouter>
      <PersonsListPage />
    </MemoryRouter>
  );
  await resolver(
    pendiente((p) => p.orden === "apellidos" && p.page === 1 && !p.search),
    respuesta("Asc")
  );
  expect(nombreVisible()).toBe("ASC, NOMBRE");
}

beforeEach(() => {
  pendientes.length = 0;
  list.mockClear();
});

describe("PersonsListPage: solo la carga vigente actualiza la pantalla", () => {
  it("ascendente atrasado (página 2) frente a descendente: si el descendente llega primero, se conserva", async () => {
    await montarConPrimeraPagina();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    const antigua = pendiente((p) => p.orden === "apellidos" && p.page === 2);
    fireEvent.click(screen.getByText(/Nombre completo/));
    const nueva = pendiente((p) => p.orden === "apellidos_desc" && p.page === 1);
    await resolver(nueva, respuesta("Desc"));
    await resolver(antigua, respuesta("Asc", 2));
    expect(nombreVisible()).toBe("DESC, NOMBRE");
    expect(screen.getByText(/página 1/)).toBeInTheDocument();
  });

  it("una petición atrasada que FALLA no muestra su error sobre el resultado vigente", async () => {
    await montarConPrimeraPagina();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    const antigua = pendiente((p) => p.orden === "apellidos" && p.page === 2);
    fireEvent.click(screen.getByText(/Nombre completo/));
    const nueva = pendiente((p) => p.orden === "apellidos_desc");
    await resolver(nueva, respuesta("Desc"));
    await rechazar(antigua, new Error("Fallo de la petición atrasada"));
    expect(screen.queryByText("Fallo de la petición atrasada")).not.toBeInTheDocument();
    expect(nombreVisible()).toBe("DESC, NOMBRE");
  });

  it("una petición atrasada que termina con la vigente pendiente NO apaga el indicador de carga", async () => {
    await montarConPrimeraPagina();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    const antigua = pendiente((p) => p.page === 2);
    fireEvent.click(screen.getByText(/Nombre completo/));
    const nueva = pendiente((p) => p.orden === "apellidos_desc");
    await resolver(antigua, respuesta("Asc", 2));
    expect(screen.getByText("Cargando...")).toBeInTheDocument();
    expect(nombreVisible()).toBe("ASC, NOMBRE");
    await resolver(nueva, respuesta("Desc"));
    expect(screen.queryByText("Cargando...")).not.toBeInTheDocument();
    expect(nombreVisible()).toBe("DESC, NOMBRE");
  });

  it("cambio de FILTRO: la respuesta sin filtro que llega después no reemplaza la filtrada", async () => {
    await montarConPrimeraPagina();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    const antigua = pendiente((p) => p.page === 2 && !p.search);
    fireEvent.change(screen.getByPlaceholderText("Buscar por nombre o RUN..."), { target: { value: "Filtro" } });
    const nueva = pendiente((p) => p.search === "Filtro" && p.page === 1);
    await resolver(nueva, respuesta("Filtrada"));
    await resolver(antigua, respuesta("SinFiltro", 2));
    expect(nombreVisible()).toBe("FILTRADA, NOMBRE");
  });

  it("al desmontar, una respuesta pendiente no actualiza nada (sin avisos de React)", async () => {
    const errores = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(
      <MemoryRouter>
        <PersonsListPage />
      </MemoryRouter>
    );
    const inicial = pendiente(() => true);
    unmount();
    await resolver(inicial, respuesta("Tarde"));
    await waitFor(() => expect(errores).not.toHaveBeenCalled());
    errores.mockRestore();
  });
});
