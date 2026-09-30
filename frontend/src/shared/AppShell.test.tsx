/**
 * Columna lateral: la etiqueta se lee entera y el ancho se puede ajustar.
 *
 * El defecto de partida era que "Asignación de Nadadores" quedaba cortada,
 * sin ningún indicio de que faltaba texto. Dos cambios lo resuelven: la
 * etiqueta se ajusta en varias líneas (CSS) y la columna se puede ensanchar
 * arrastrando. Estas pruebas cubren lo que el CSS no puede demostrar por sí
 * solo: que el manillar existe, que responde al ratón y al teclado, que
 * respeta sus límites y que la preferencia se recuerda.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "./AppShell";

// El AppShell consulta la sesión; se simula con un administrador.
vi.mock("../modules/auth/AuthContext", () => ({
  useAuth: () => ({
    user: { username: "admin" },
    logout: vi.fn(),
    hasRole: () => true,
  }),
}));

vi.mock("./AvisosTerceros", () => ({ AvisosTerceros: () => null }));

function montar() {
  return render(
    <MemoryRouter>
      <AppShell>
        <p>contenido</p>
      </AppShell>
    </MemoryRouter>
  );
}

function manillar() {
  return screen.getByRole("separator", { name: /Ajustar ancho del menú/i });
}

function barraLateral(): HTMLElement {
  const nav = document.querySelector("nav.app-sidebar");
  if (!nav) throw new Error("no se encontró la columna lateral");
  return nav as HTMLElement;
}

function anchoActual(): number {
  return Number((barraLateral().style.getPropertyValue("--app-sidebar-width") || "0").replace("px", ""));
}

beforeEach(() => {
  localStorage.clear();
});

describe("la etiqueta completa está presente", () => {
  it("«Asignación de Nadadores» aparece entera en el menú", () => {
    montar();
    // Si se recortara con `text-overflow`, el nodo seguiría teniendo el texto
    // completo; lo que garantiza que se LEA es el CSS (`white-space: normal`).
    // Aquí se fija al menos que la etiqueta no se abrevia en el marcado.
    expect(screen.getByText("Asignación de Nadadores")).toBeTruthy();
  });

  it("la etiqueta va en su propio elemento, para poder ajustarla por CSS", () => {
    montar();
    const etiqueta = screen.getByText("Asignación de Nadadores");
    expect(etiqueta.className).toContain("app-sidebar-label");
  });
});

describe("manillar de redimensionado", () => {
  it("arranca en el ancho por defecto y lo expone como variable CSS", () => {
    montar();
    expect(anchoActual()).toBe(220);
  });

  it("arrastrar con el ratón cambia el ancho", () => {
    montar();
    // El rectángulo del nav no lo calcula jsdom: se simula que empieza en 0.
    vi.spyOn(barraLateral(), "getBoundingClientRect").mockReturnValue({ left: 0 } as DOMRect);

    fireEvent.mouseDown(manillar());
    fireEvent.mouseMove(window, { clientX: 300 });
    expect(anchoActual()).toBe(300);

    fireEvent.mouseUp(window);
    expect(localStorage.getItem("natacion.sidebarWidth")).toBe("300");
  });

  it("no baja del mínimo ni sube del máximo", () => {
    montar();
    vi.spyOn(barraLateral(), "getBoundingClientRect").mockReturnValue({ left: 0 } as DOMRect);

    fireEvent.mouseDown(manillar());
    fireEvent.mouseMove(window, { clientX: 10 });
    expect(anchoActual()).toBe(160);

    fireEvent.mouseMove(window, { clientX: 9999 });
    expect(anchoActual()).toBe(420);
    fireEvent.mouseUp(window);
  });

  it("las flechas del teclado también lo ajustan", () => {
    montar();
    fireEvent.keyDown(manillar(), { key: "ArrowRight" });
    expect(anchoActual()).toBe(228);

    fireEvent.keyDown(manillar(), { key: "ArrowLeft" });
    expect(anchoActual()).toBe(220);

    // Shift mueve a saltos mayores.
    fireEvent.keyDown(manillar(), { key: "ArrowRight", shiftKey: true });
    expect(anchoActual()).toBe(252);
  });

  it("Inicio y el doble clic restablecen el ancho por defecto", () => {
    montar();
    fireEvent.keyDown(manillar(), { key: "ArrowRight", shiftKey: true });
    expect(anchoActual()).not.toBe(220);

    fireEvent.keyDown(manillar(), { key: "Home" });
    expect(anchoActual()).toBe(220);

    fireEvent.keyDown(manillar(), { key: "ArrowRight", shiftKey: true });
    fireEvent.doubleClick(manillar());
    expect(anchoActual()).toBe(220);
  });

  it("es alcanzable por teclado y se describe como separador vertical", () => {
    montar();
    const h = manillar();
    expect(h.getAttribute("tabindex")).toBe("0");
    expect(h.getAttribute("aria-orientation")).toBe("vertical");
    expect(h.getAttribute("aria-valuemin")).toBe("160");
    expect(h.getAttribute("aria-valuemax")).toBe("420");
  });
});

describe("la preferencia de ancho se recuerda, acotada", () => {
  it("relee el ancho guardado", () => {
    localStorage.setItem("natacion.sidebarWidth", "333");
    montar();
    expect(anchoActual()).toBe(333);
  });

  it("un valor guardado fuera de rango se acota al leerlo", () => {
    // Un valor manipulado, o de una versión con otros límites, no puede
    // dejar la columna inservible.
    localStorage.setItem("natacion.sidebarWidth", "5000");
    montar();
    expect(anchoActual()).toBe(420);
  });

  it("un valor guardado ilegible cae al valor por defecto", () => {
    localStorage.setItem("natacion.sidebarWidth", "no-es-un-numero");
    montar();
    expect(anchoActual()).toBe(220);
  });
});

describe("menú contraído", () => {
  it("el manillar desaparece: ahí el ancho lo manda el modo, no el arrastre", () => {
    localStorage.setItem("natacion.sidebarCollapsed", "1");
    montar();
    expect(screen.queryByRole("separator", { name: /Ajustar ancho/i })).toBeNull();
  });
});
