import { useEffect, useState } from "react";
import { useClubsApi, type Club } from "../clubs/clubsApi";
import { useSwimmerAssignmentApi } from "../swimmer-assignment/assignmentApi";
import { traerTodasLasPaginas } from "../../shared/paginacion";

export function SwimmerClubSection({ personId }: { personId: string }) {
  const clubsApi = useClubsApi();
  const api = useSwimmerAssignmentApi();

  const [currentClub, setCurrentClub] = useState<{ id: string; name: string } | null | undefined>(undefined); // undefined = cargando
  const [clubs, setClubs] = useState<Club[]>([]);
  const [changing, setChanging] = useState(false);
  const [selectedClubId, setSelectedClubId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function load() {
    api
      .getCurrentClub(personId)
      .then((a) => setCurrentClub(a ? a.club : null))
      .catch(() => setCurrentClub(null));
  }

  useEffect(() => {
    load();
    traerTodasLasPaginas((page, pageSize) => clubsApi.list({ status: "active", page, pageSize }))
      .then(setClubs)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar los clubes"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personId]);

  async function handleConfirm() {
    if (!selectedClubId) return;
    setError(null);
    setMessage(null);
    setSaving(true);
    try {
      await api.reassign(personId, selectedClubId);
      setMessage("Club actualizado correctamente.");
      setChanging(false);
      setSelectedClubId("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo asignar el club");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ marginTop: "2rem", paddingTop: "1.5rem", borderTop: "1px solid var(--brand-gray-100)", maxWidth: 520 }}>
      <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>Club asignado</h2>

      {currentClub === undefined && <p style={{ fontSize: "0.9rem", color: "var(--brand-gray-600)" }}>Cargando...</p>}

      {currentClub !== undefined && !changing && (
        <>
          {currentClub ? (
            <p style={{ fontSize: "0.9rem" }}>
              Actualmente asignado a: <strong>{currentClub.name}</strong>
            </p>
          ) : (
            <p style={{ fontSize: "0.9rem", color: "var(--brand-gray-600)" }}>No tiene club asignado.</p>
          )}
          <button className="btn-secondary" onClick={() => setChanging(true)}>
            {currentClub ? "Cambiar de club" : "Asignar a un club"}
          </button>
        </>
      )}

      {changing && (
        <div style={{ marginTop: "0.5rem" }}>
          <label>{currentClub ? "Nuevo club" : "Club"}</label>
          <select value={selectedClubId} onChange={(e) => setSelectedClubId(e.target.value)}>
            <option value="">Seleccionar...</option>
            {clubs.filter((c) => c.id !== currentClub?.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {currentClub && (
            <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginTop: "0.2rem" }}>
              Esto finaliza automáticamente su membresía actual en {currentClub.name} y lo deja activo en el club nuevo.
            </p>
          )}
          <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
            <button className="btn-primary" onClick={handleConfirm} disabled={!selectedClubId || saving}>
              {saving ? "Guardando..." : "Confirmar"}
            </button>
            <button className="btn-secondary" onClick={() => { setChanging(false); setSelectedClubId(""); }}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {error && <p className="error-message">{error}</p>}
      {message && (
        <p style={{ fontSize: "0.85rem", background: "var(--brand-bg)", padding: "0.6rem", borderRadius: 6, marginTop: "0.5rem" }}>{message}</p>
      )}
    </div>
  );
}
