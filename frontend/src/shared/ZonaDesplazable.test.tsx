/**
 * `ZonaDesplazable`: región con nombre y foco de teclado, y controles visibles cuando el
 * contenido es más ancho que la zona. jsdom no calcula diseño: los tamaños se simulan
 * definiendo `scrollWidth`, `clientWidth` y `scrollLeft`. Esto NO valida Safari ni ningún motor
 * real: solo la lógica del componente.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ZonaDesplazable } from "./ZonaDesplazable";

function tamanos(el: HTMLElement, t: { scrollWidth: number; clientWidth: number; scrollLeft?: number }) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => t.scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, get: () => t.clientWidth });
  let izquierda = t.scrollLeft ?? 0;
  Object.defineProperty(el, "scrollLeft", { configurable: true, get: () => izquierda, set: (v: number) => (izquierda = v) });
  return { mover: (v: number) => (izquierda = v) };
}

describe("ZonaDesplazable", () => {
  it("es una región con nombre y foco de teclado, aunque no desborde", () => {
    render(<ZonaDesplazable etiqueta="Pruebas por día">contenido</ZonaDesplazable>);
    const zona = screen.getByRole("region", { name: "Pruebas por día" });
    expect(zona.tabIndex).toBe(0);
    expect(zona.className).toContain("zona-desplazable");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("sin desbordamiento horizontal no muestra controles", () => {
    const { rerender } = render(
      <ZonaDesplazable etiqueta="Pruebas" controlesHorizontales>
        a
      </ZonaDesplazable>
    );
    tamanos(screen.getByRole("region", { name: "Pruebas" }), { scrollWidth: 300, clientWidth: 300 });
    rerender(
      <ZonaDesplazable etiqueta="Pruebas" controlesHorizontales>
        b
      </ZonaDesplazable>
    );
    expect(screen.queryByRole("group", { name: /Desplazamiento/ })).toBeNull();
  });

  it("con desbordamiento muestra Anterior/Siguiente, los habilita según el extremo y desplaza", () => {
    const { rerender } = render(
      <ZonaDesplazable etiqueta="Pruebas" controlesHorizontales textoContenido="días">
        a
      </ZonaDesplazable>
    );
    const zona = screen.getByRole("region", { name: "Pruebas" });
    const t = tamanos(zona, { scrollWidth: 1000, clientWidth: 400 });
    const scrollBy = vi.fn((o: { left: number }) => t.mover(Math.min(600, Math.max(0, zona.scrollLeft + o.left))));
    (zona as unknown as { scrollBy: typeof scrollBy }).scrollBy = scrollBy;
    rerender(
      <ZonaDesplazable etiqueta="Pruebas" controlesHorizontales textoContenido="días">
        b
      </ZonaDesplazable>
    );

    const anterior = screen.getByRole("button", { name: /Anterior/ });
    const siguiente = screen.getByRole("button", { name: /Siguiente/ });
    expect(anterior).toBeDisabled();
    expect(siguiente).toBeEnabled();
    expect(screen.getByText("Hay más días a la derecha.")).toBeInTheDocument();
    expect(siguiente.getAttribute("aria-controls")).toBe(zona.id);

    fireEvent.click(siguiente);
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: 340 }));
    act(() => {
      fireEvent.scroll(zona);
    });
    expect(screen.getByText("Hay más días a la izquierda y a la derecha.")).toBeInTheDocument();
    expect(anterior).toBeEnabled();

    t.mover(600);
    act(() => {
      fireEvent.scroll(zona);
    });
    expect(siguiente).toBeDisabled();
    expect(screen.getByText("Hay más días a la izquierda.")).toBeInTheDocument();

    fireEvent.click(anterior);
    expect(scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ left: -340 }));
  });
});
