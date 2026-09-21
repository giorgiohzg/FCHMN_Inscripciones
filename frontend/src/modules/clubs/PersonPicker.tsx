import { useEffect, useState } from "react";
import { usePersonsApi } from "../persons/personsApi";
import { useBusquedaDePersonas } from "../../shared/useBusquedaDePersonas";

interface PersonPickerProps {
  label: string;
  value: string | null | undefined;
  onChange: (personId: string | null) => void;
}

/**
 * Selector "buscar desde las personas registradas" (requisito explícito de
 * la sección 4 del documento base). Ya no filtra por rol funcional al
 * buscar — el rol ahora se deriva de la asignación misma (delegado/
 * entrenador/representante legal), así que antes de asignar a alguien
 * por primera vez todavía no tiene ese rol.
 */
export function PersonPicker({ label, value, onChange }: PersonPickerProps) {
  const api = usePersonsApi();
  /**
   * La búsqueda vive en un hook compartido con los demás buscadores de
   * personas: acumula páginas a petición, deduplica, descarta respuestas de
   * consultas anteriores y limpia todo al cambiar el texto. Ver
   * `useBusquedaDePersonas`.
   */
  const busqueda = useBusquedaDePersonas(({ search, page }) => api.list({ search, page }));
  const [selectedLabel, setSelectedLabel] = useState<string>("");

  useEffect(() => {
    if (!value) {
      setSelectedLabel("");
      return;
    }
    api.get(value).then((p) => setSelectedLabel(`${p.fullName} (${p.run})`)).catch(() => void 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div>
      <label>{label}</label>
      {value && selectedLabel ? (
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ fontSize: "0.9rem" }}>{selectedLabel}</span>
          <button type="button" className="btn-secondary" onClick={() => onChange(null)} style={{ padding: "0.2rem 0.6rem" }}>
            Quitar
          </button>
        </div>
      ) : (
        <>
          <input
            placeholder="Buscar persona por nombre o RUN..."
            value={busqueda.search}
            onChange={(e) => busqueda.setSearch(e.target.value)}
          />
          {busqueda.opciones.length > 0 && (
            <ul style={{ listStyle: "none", margin: "0.3rem 0 0", padding: 0, border: "1px solid var(--brand-gray-300)", borderRadius: 6 }}>
              {busqueda.opciones.map((o) => (
                <li
                  key={o.id}
                  onClick={() => {
                    onChange(o.id);
                    busqueda.limpiar();
                  }}
                  style={{ padding: "0.5rem 0.75rem", cursor: "pointer", fontSize: "0.9rem" }}
                >
                  {o.fullName} ({o.run})
                </li>
              ))}
            </ul>
          )}
          {busqueda.error && (
            <p className="error-message">
              {busqueda.error}{" "}
              <button
                type="button"
                className="btn-secondary"
                onClick={busqueda.requiereReinicio ? busqueda.reiniciarBusqueda : busqueda.reintentar}
                disabled={busqueda.cargando}
                style={{ padding: "0.15rem 0.5rem", fontSize: "0.8rem" }}
              >
                {/*
                  Si el reparto cambió a mitad del recorrido, reintentar la misma
                  página seguiría mezclando dos estados distintos: lo que toca es
                  rehacer la búsqueda desde la primera página.
                */}
                {busqueda.cargando ? "Cargando…" : busqueda.requiereReinicio ? "Reiniciar búsqueda" : "Reintentar"}
              </button>
            </p>
          )}
          {busqueda.total > 0 && !busqueda.error && (
            <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", marginTop: "0.3rem" }}>
              Se muestran {busqueda.opciones.length} de {busqueda.total} coincidencias.{" "}
              {busqueda.hayMas && (
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={busqueda.cargarMas}
                  disabled={busqueda.cargando}
                  style={{ padding: "0.15rem 0.5rem", fontSize: "0.8rem" }}
                >
                  {busqueda.cargando ? "Cargando…" : "Cargar más resultados"}
                </button>
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
}
