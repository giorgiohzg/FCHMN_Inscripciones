import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { useClubsApi, type Club } from "../clubs/clubsApi";
import { useSwimmerAssignmentApi, CODIGOS, type SwimmerForBulkAssign, type BulkAssignSummary } from "./assignmentApi";
import { useSort, sortItems, SortableTh } from "../../shared/sortableTable";
import { traerTodasLasPaginas } from "../../shared/paginacion";
import { esFechaCalendarioExistente, formatearFechaCalendario, hoyEnSantiago } from "../../shared/fechaCalendario";

const NONE_FILTER = "none";

/** Lo que se envió en la última tanda: el reintento usa EXACTAMENTE el mismo club y la misma fecha. */
interface Tanda {
  targetClubId: string;
  fechaEfectiva: string;
  resumen: BulkAssignSummary;
}

export function BulkSwimmerAssignmentPage() {
  const navigate = useNavigate();
  const clubsApi = useClubsApi();
  const api = useSwimmerAssignmentApi();
  const hoy = hoyEnSantiago();

  const [clubs, setClubs] = useState<Club[]>([]);
  const [sourceClubFilter, setSourceClubFilter] = useState(NONE_FILTER);
  const [search, setSearch] = useState("");
  const [swimmers, setSwimmers] = useState<SwimmerForBulkAssign[]>([]);
  const { sortKey, sortDir, onSort } = useSort<"fullName" | "run">();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [targetClubId, setTargetClubId] = useState("");
  const [fechaEfectiva, setFechaEfectiva] = useState(hoy);

  const [loadingSwimmers, setLoadingSwimmers] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [tanda, setTanda] = useState<Tanda | null>(null);
  const [aceptaIncompleto, setAceptaIncompleto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Barrera síncrona contra el doble envío. */
  const enviando = useRef(false);
  /** Solo la última búsqueda aplica su respuesta. */
  const busquedaVigente = useRef(0);

  useEffect(() => {
    traerTodasLasPaginas((page, pageSize) => clubsApi.list({ status: "active", page, pageSize }))
      .then(setClubs)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar los clubes"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function cargarNadadores() {
    const n = ++busquedaVigente.current;
    setLoadingSwimmers(true);
    return api
      .listSwimmersByClub(sourceClubFilter, search || undefined)
      .then((r) => {
        if (n === busquedaVigente.current) setSwimmers(r);
      })
      .catch((err) => {
        if (n === busquedaVigente.current) setError(err instanceof Error ? err.message : "No se pudieron cargar los nadadores");
      })
      .finally(() => {
        if (n === busquedaVigente.current) setLoadingSwimmers(false);
      });
  }

  useEffect(() => {
    setSelectedIds([]);
    setTanda(null);
    setError(null);
    void cargarNadadores();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceClubFilter, search]);

  function toggleSwimmer(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => (prev.length === swimmers.length ? [] : swimmers.map((s) => s.id)));
  }

  const fechaValida = esFechaCalendarioExistente(fechaEfectiva) && fechaEfectiva <= hoy;

  async function enviar(club: string, ids: string[], fecha: string, aceptar: boolean) {
    if (enviando.current) return;
    enviando.current = true;
    setError(null);
    setAssigning(true);
    try {
      const resumen = await api.bulkAssign(club, ids, aceptar ? { fechaEfectiva: fecha, aceptarHistorialIncompleto: true } : { fechaEfectiva: fecha });
      setTanda({ targetClubId: club, fechaEfectiva: fecha, resumen });
      setAceptaIncompleto(false);
      setSelectedIds([]);
      // Recarga la lista con el mismo filtro: los recién asignados ya no deberían aparecer si el filtro de origen es distinto al destino.
      await cargarNadadores();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo asignar a los nadadores");
    } finally {
      enviando.current = false;
      setAssigning(false);
    }
  }

  const conHistorialIncompleto = tanda?.resumen.results.filter((r) => r.status === "error" && r.codigo === CODIGOS.historialIncompleto) ?? [];
  const nombreDestino = (id: string) => clubs.find((c) => c.id === id)?.name ?? "el club de destino";

  return (
    <AppShell>
      <div className="c05-pantalla">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
          <h1 style={{ color: "var(--brand-navy)" }}>Asignación masiva de nadadores</h1>
          <button className="btn-secondary" onClick={() => navigate("/asignaciones")}>
            Volver a asignaciones
          </button>
        </div>
        <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>
          Filtre nadadores por su club actual (o "Sin club" para los que todavía no tienen ninguno), selecciónelos, y asígnelos todos de una vez a un club destino.
          Cada nadador queda activo de inmediato, sin pasar por aprobación. La asignación masiva no traslada: quien tenga una membresía activa en otro club se
          rechaza y debe cambiarse desde la ficha de la persona.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "1rem", maxWidth: 800, marginTop: "1rem" }}>
          <div>
            <label htmlFor="filtro-club">Filtrar por club actual</label>
            <select id="filtro-club" value={sourceClubFilter} onChange={(e) => setSourceClubFilter(e.target.value)}>
              <option value={NONE_FILTER}>Sin club</option>
              {clubs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="buscar-nadador">Buscar por nombre o RUN (opcional)</label>
            <input id="buscar-nadador" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar..." />
          </div>
        </div>

        {error && <p className="error-message">{error}</p>}

        <div style={{ marginTop: "1rem" }}>
          {loadingSwimmers ? (
            <p style={{ fontSize: "0.9rem", color: "var(--brand-gray-600)" }}>Cargando nadadores...</p>
          ) : (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem", flexWrap: "wrap", gap: "0.5rem" }}>
                <span style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>
                  {swimmers.length} nadador(es) {sourceClubFilter === NONE_FILTER ? "sin club" : `en el club filtrado`} — {selectedIds.length} seleccionado(s)
                </span>
                {swimmers.length > 0 && (
                  <button className="btn-secondary" onClick={toggleSelectAll}>
                    {selectedIds.length === swimmers.length ? "Deseleccionar todos" : "Seleccionar todos"}
                  </button>
                )}
              </div>
              <div className="tabla-desplazable">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th></th>
                      <SortableTh label="Nadador" sortKey="fullName" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                      <SortableTh label="RUN" sortKey="run" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortItems(swimmers, sortKey, sortDir, (s, key) => s[key]).map((s) => (
                      <tr key={s.id}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={`Seleccionar a ${s.fullName}`}
                            style={{ width: "auto" }}
                            checked={selectedIds.includes(s.id)}
                            onChange={() => toggleSwimmer(s.id)}
                          />
                        </td>
                        <td>{s.fullName}</td>
                        <td>{s.run}</td>
                      </tr>
                    ))}
                    {swimmers.length === 0 && (
                      <tr>
                        <td colSpan={3} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1rem" }}>
                          Sin nadadores para este filtro.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div style={{ marginTop: "1.5rem", maxWidth: 400 }}>
          <label htmlFor="club-destino">Club de destino</label>
          <select id="club-destino" value={targetClubId} onChange={(e) => setTargetClubId(e.target.value)}>
            <option value="">Seleccionar...</option>
            {clubs.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <label htmlFor="fecha-masiva">Fecha efectiva (la misma para toda la tanda)</label>
          <input id="fecha-masiva" type="date" required value={fechaEfectiva} max={hoy} onChange={(e) => setFechaEfectiva(e.target.value)} />
          {!fechaValida && <p className="error-message">Indique una fecha válida, hoy o anterior ({formatearFechaCalendario(hoy)}).</p>}
          <button
            className="btn-primary"
            style={{ marginTop: "0.75rem" }}
            onClick={() => void enviar(targetClubId, selectedIds, fechaEfectiva, false)}
            disabled={!targetClubId || selectedIds.length === 0 || assigning || !fechaValida}
          >
            {assigning ? "Asignando..." : `Asignar ${selectedIds.length || ""} nadador(es) seleccionado(s)`}
          </button>
        </div>

        {tanda && (
          <div style={{ marginTop: "2rem" }}>
            <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>Resultado</h2>
            <p style={{ fontSize: "0.9rem" }}>
              {tanda.resumen.totalCount} nadador(es) procesado(s) con fecha {formatearFechaCalendario(tanda.fechaEfectiva)} —{" "}
              <span style={{ color: "var(--state-success)" }}>{tanda.resumen.assignedCount} asignado(s)</span>
              {tanda.resumen.errorCount > 0 && (
                <>
                  {" "}
                  — <span style={{ color: "var(--state-danger)" }}>{tanda.resumen.errorCount} con error</span>
                </>
              )}
            </p>
            <div className="tabla-desplazable">
              <table className="data-table" style={{ marginTop: "0.5rem" }}>
                <thead>
                  <tr>
                    <th>Nadador</th>
                    <th>Estado</th>
                    <th>Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {tanda.resumen.results.map((r) => (
                    <tr key={r.personId}>
                      <td>{r.fullName}</td>
                      <td>
                        <span className={`badge ${r.status === "assigned" ? "badge-active" : "badge-disabled"}`}>
                          {r.status === "assigned" ? "Asignado" : r.codigo === CODIGOS.historialIncompleto ? "Historial incompleto" : "Error"}
                        </span>
                      </td>
                      <td>{r.error ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {conHistorialIncompleto.length > 0 && (
              <div className="aviso aviso-advertencia" style={{ marginTop: "1rem" }}>
                <p style={{ margin: "0 0 0.4rem" }}>
                  <strong>{conHistorialIncompleto.length} nadador(es) con historial incompleto.</strong> Tienen membresías anteriores con fechas desconocidas y no se
                  puede descartar un solapamiento. Puede reintentar SOLO esos, en {nombreDestino(tanda.targetClubId)} con la misma fecha (
                  {formatearFechaCalendario(tanda.fechaEfectiva)}), aceptando expresamente la incertidumbre. No se completará ninguna fecha y la aceptación queda en la
                  auditoría. Los conflictos de fechas conocidos no se pueden aceptar.
                </p>
                <label className="casilla">
                  <input type="checkbox" checked={aceptaIncompleto} onChange={(e) => setAceptaIncompleto(e.target.checked)} disabled={assigning} />
                  Acepto, como administración, el historial incompleto de esos {conHistorialIncompleto.length} nadador(es).
                </label>
                <button
                  className="btn-primary"
                  style={{ marginTop: "0.5rem" }}
                  disabled={!aceptaIncompleto || assigning}
                  onClick={() =>
                    void enviar(
                      tanda.targetClubId,
                      conHistorialIncompleto.map((r) => r.personId),
                      tanda.fechaEfectiva,
                      true
                    )
                  }
                >
                  Reintentar {conHistorialIncompleto.length} con aceptación
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
