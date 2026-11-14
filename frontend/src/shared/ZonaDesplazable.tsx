import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/**
 * ZONA DESPLAZABLE con desplazamiento DESCUBRIBLE, para el Panel de Inscripción y el de Relevos.
 *
 * En macOS (Safari y también otros navegadores) las barras de desplazamiento se ocultan mientras
 * no se usan, según «Mostrar barras de desplazamiento» del sistema. Un contenedor con
 * `overflow: auto` sigue siendo desplazable con trackpad, ratón y teclado, pero nada indica que
 * hay más contenido. Esta zona añade, sin cambiar cómo se desplaza:
 *
 *  - foco de teclado (`tabIndex=0`) con nombre accesible (`role="region"` y `aria-label`): con el
 *    foco dentro, las flechas, Re Pág/Av Pág, Inicio y Fin desplazan;
 *  - si `controlesHorizontales` y el contenido es más ancho que la zona, botones VISIBLES
 *    «Anterior» y «Siguiente» (deshabilitados en los extremos) y un texto que dice si queda
 *    contenido a cada lado. Se recalculan al desplazar y al cambiar el tamaño;
 *  - la clase `zona-desplazable`, que en `theme.css` declara barras propias. Que Safari de macOS
 *    las muestre siempre NO está comprobado (validación pendiente en un Mac real), así que lo
 *    descubrible no depende de ellas. Esa clase solo se usa en estos paneles.
 *
 * No intercepta la rueda, el trackpad ni el arrastre: el desplazamiento nativo se conserva.
 */
export function ZonaDesplazable({
  etiqueta,
  className = "",
  style,
  controlesHorizontales = false,
  textoContenido = "contenido",
  children,
}: {
  etiqueta: string;
  className?: string;
  style?: CSSProperties;
  controlesHorizontales?: boolean;
  /** Qué hay a los lados, para el texto de ayuda (p. ej. «días»). */
  textoContenido?: string;
  children: ReactNode;
}) {
  const id = useId();
  const zona = useRef<HTMLDivElement>(null);
  const [estado, setEstado] = useState({ desborda: false, alInicio: true, alFinal: true });

  const medir = useCallback(() => {
    const z = zona.current;
    if (!z) return;
    const maximo = z.scrollWidth - z.clientWidth;
    // Un píxel de tolerancia: el redondeo de subpíxeles deja `scrollLeft` a 0,5 del extremo.
    const siguiente = { desborda: maximo > 1, alInicio: z.scrollLeft <= 1, alFinal: z.scrollLeft >= maximo - 1 };
    setEstado((previo) =>
      previo.desborda === siguiente.desborda && previo.alInicio === siguiente.alInicio && previo.alFinal === siguiente.alFinal ? previo : siguiente
    );
  }, []);

  useLayoutEffect(() => {
    if (controlesHorizontales) medir();
  });

  useEffect(() => {
    if (!controlesHorizontales) return;
    const z = zona.current;
    if (!z) return;
    window.addEventListener("resize", medir);
    // jsdom y navegadores antiguos no tienen ResizeObserver: la medición por render y por
    // desplazamiento sigue funcionando sin él.
    const observador = typeof ResizeObserver === "function" ? new ResizeObserver(medir) : null;
    observador?.observe(z);
    return () => {
      window.removeEventListener("resize", medir);
      observador?.disconnect();
    };
  }, [controlesHorizontales, medir]);

  function desplazar(sentido: -1 | 1) {
    const z = zona.current;
    if (!z) return;
    const reducido = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Casi un ancho visible: deja a la vista un borde de lo anterior para no perder la referencia.
    const paso = Math.max(120, Math.round(z.clientWidth * 0.85));
    if (typeof z.scrollBy === "function") z.scrollBy({ left: sentido * paso, behavior: reducido ? "auto" : "smooth" });
    else z.scrollLeft += sentido * paso;
  }

  const hayIzquierda = estado.desborda && !estado.alInicio;
  const hayDerecha = estado.desborda && !estado.alFinal;
  const ayuda = !estado.desborda
    ? null
    : hayIzquierda && hayDerecha
      ? `Hay más ${textoContenido} a la izquierda y a la derecha.`
      : hayDerecha
        ? `Hay más ${textoContenido} a la derecha.`
        : `Hay más ${textoContenido} a la izquierda.`;

  return (
    <div className="zona-desplazable-envoltorio">
      {controlesHorizontales && estado.desborda && (
        <div className="zona-desplazable-controles" role="group" aria-label={`Desplazamiento de ${etiqueta}`}>
          <button type="button" className="btn-secondary" onClick={() => desplazar(-1)} disabled={!hayIzquierda} aria-controls={id}>
            ◀ Anterior
          </button>
          <span className="zona-desplazable-ayuda" aria-live="polite">
            {ayuda}
          </span>
          <button type="button" className="btn-secondary" onClick={() => desplazar(1)} disabled={!hayDerecha} aria-controls={id}>
            Siguiente ▶
          </button>
        </div>
      )}
      <div
        id={id}
        ref={zona}
        role="region"
        aria-label={etiqueta}
        tabIndex={0}
        className={`zona-desplazable ${className}`.trim()}
        style={style}
        onScroll={controlesHorizontales ? medir : undefined}
      >
        {children}
      </div>
    </div>
  );
}
