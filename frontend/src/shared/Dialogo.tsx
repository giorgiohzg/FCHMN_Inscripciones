import { useEffect, useId, useRef, type ReactNode } from "react";

/**
 * Diálogo modal mínimo y accesible (`role="dialog"`, `aria-modal`, título enlazado).
 *
 * Escape y el fondo cierran SOLO si `onCerrar` lo permite: mientras se envía algo, quien lo usa
 * pasa `bloqueado` y el diálogo no se puede cerrar a medias. Cerrar nunca envía nada.
 */
export function Dialogo({
  titulo,
  onCerrar,
  bloqueado = false,
  ancho = 560,
  children,
}: {
  titulo: string;
  onCerrar: () => void;
  bloqueado?: boolean;
  ancho?: number;
  children: ReactNode;
}) {
  const idTitulo = useId();
  const caja = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Foco dentro del diálogo al abrir, para teclado y lectores de pantalla.
    caja.current?.focus();
  }, []);

  useEffect(() => {
    const alPulsar = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !bloqueado) onCerrar();
    };
    window.addEventListener("keydown", alPulsar);
    return () => window.removeEventListener("keydown", alPulsar);
  }, [bloqueado, onCerrar]);

  return (
    <div
      className="dialogo-fondo"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !bloqueado) onCerrar();
      }}
    >
      <div ref={caja} className="dialogo-caja" role="dialog" aria-modal="true" aria-labelledby={idTitulo} tabIndex={-1} style={{ maxWidth: ancho }}>
        <h2 id={idTitulo} className="dialogo-titulo">
          {titulo}
        </h2>
        {children}
      </div>
    </div>
  );
}
