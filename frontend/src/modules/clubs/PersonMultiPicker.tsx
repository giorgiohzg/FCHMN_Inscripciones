import { useEffect, useState } from "react";
import { usePersonsApi } from "../persons/personsApi";
import { useBusquedaDePersonas } from "../../shared/useBusquedaDePersonas";

interface PersonMultiPickerProps {
  label: string;
  values: string[];
  onChange: (personIds: string[]) => void;
}

/**
 * Selector "buscar desde las personas registradas" que permite agregar
 * VARIAS personas (delegados/entrenadores) — ya no filtra por rol al
 * buscar, porque el rol funcional ahora se deriva de esta misma
 * asignación (antes de asignar a alguien no tiene el rol todavía, así
 * que filtrar por rol lo dejaría fuera de los resultados).
 */
export function PersonMultiPicker({ label, values, onChange }: PersonMultiPickerProps) {
  const api = usePersonsApi();
  // Búsqueda compartida: acumula páginas a petición, deduplica y descarta
  // respuestas de consultas anteriores. Ver `useBusquedaDePersonas`.
  const busqueda = useBusquedaDePersonas(({ search, page }) => api.list({ search, page }));
  const [selectedLabels, setSelectedLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    const missing = values.filter((v) => !selectedLabels[v]);
    if (missing.length === 0) return;
    Promise.all(missing.map((id) => api.get(id).catch(() => null))).then((people) => {
      setSelectedLabels((prev) => {
        const next = { ...prev };
        people.forEach((p) => {
          if (p) next[p.id] = `${p.fullName} (${p.run})`;
        });
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  /**
   * Las ya seleccionadas se ocultan de las sugerencias: reofrecerlas confunde y
   * hace creer que el clic no funcionó. El recuento de abajo cuenta lo REALMENTE
   * visible, no las opciones traídas.
   */
  const visibles = busqueda.opciones.filter((o) => !values.includes(o.id));

  function addPerson(id: string) {
    if (!values.includes(id)) onChange([...values, id]);
    busqueda.limpiar();
  }

  function removePerson(id: string) {
    onChange(values.filter((v) => v !== id));
  }

  return (
    <div>
      <label>{label}</label>
      {values.length > 0 && (
        <ul style={{ listStyle: "none", margin: "0 0 0.4rem", padding: 0, display: "flex", flexDirection: "column", gap: "0.3rem" }}>
          {values.map((id) => (
            <li key={id} style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <span style={{ fontSize: "0.9rem" }}>{selectedLabels[id] ?? "Cargando..."}</span>
              <button type="button" className="btn-secondary" onClick={() => removePerson(id)} style={{ padding: "0.15rem 0.55rem", fontSize: "0.8rem" }}>
                Quitar
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        placeholder="Buscar persona por nombre o RUN para agregar..."
        value={busqueda.search}
        onChange={(e) => busqueda.setSearch(e.target.value)}
      />
      {visibles.length > 0 && (
        <ul style={{ listStyle: "none", margin: "0.3rem 0 0", padding: 0, border: "1px solid var(--brand-gray-300)", borderRadius: 6 }}>
          {visibles.map((o) => (
            <li key={o.id} onClick={() => addPerson(o.id)} style={{ padding: "0.5rem 0.75rem", cursor: "pointer", fontSize: "0.9rem" }}>
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
          Se muestran {visibles.length} de {busqueda.total} coincidencias.{" "}
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
    </div>
  );
}
