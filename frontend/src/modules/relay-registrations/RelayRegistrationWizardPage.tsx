import { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { useAuth } from "../auth/AuthContext";
import { useCompetitionsApi, type Competition } from "../competitions/competitionsApi";
import { useClubsApi, type Club } from "../clubs/clubsApi";
import { useRegistrationsApi, type EnabledCompetitionEvent, type EligibleSwimmer } from "../registrations/registrationsApi";
import { useRelayRegistrationsApi, type RelayRegistrationItem } from "./relayRegistrationsApi";
import { formatEventLabel } from "../../shared/eventLabel";
import { computeAgeClientPreview } from "../../shared/ageClientPreview";
import { formatCalendarDate } from "../../shared/calendarDate";
import { relayPositionLabels } from "../../shared/relayOrder";
import { parseSwimTimeInput, formatSwimTimeReadable } from "../../shared/swimTime";
import { traerTodasLasPaginas } from "../../shared/paginacion";

export function RelayRegistrationWizardPage() {
  const { user, hasRole } = useAuth();
  const navigate = useNavigate();
  const competitionsApi = useCompetitionsApi();
  const clubsApi = useClubsApi();
  const enabledEventsApi = useRegistrationsApi();
  const api = useRelayRegistrationsApi();

  const isPureSwimmer = user?.ownerType === "person" && !hasRole("admin") && !user?.clubId;

  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [relayEvents, setRelayEvents] = useState<EnabledCompetitionEvent[]>([]);
  const [swimmers, setSwimmers] = useState<EligibleSwimmer[]>([]);
  const [existingTeams, setExistingTeams] = useState<RelayRegistrationItem[]>([]);

  const [competitionId, setCompetitionId] = useState("");
  const [clubId, setClubId] = useState("");
  const [competitionEventId, setCompetitionEventId] = useState("");
  // 4 puestos ORDENADOS (no un conjunto sin orden) — en pruebas Combinado
  // el orden importa: Espalda, Pecho, Mariposa, Libre.
  const [orderedIds, setOrderedIds] = useState<string[]>(["", "", "", ""]);
  const [timeInput, setTimeInput] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isClubUser = user?.ownerType === "club";

  useEffect(() => {
    // Selector: sin recorrer las páginas solo llegaban las 20 primeras.
    traerTodasLasPaginas((page, pageSize) => competitionsApi.list({ status: "open", page, pageSize }))
      .then(setCompetitions)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar las competencias"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    traerTodasLasPaginas((page, pageSize) => clubsApi.list({ status: "active", page, pageSize }))
      .then((clubes) => {
        setClubs(clubes);
        if (isClubUser && user?.clubId) setClubId(user.clubId);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar los clubes"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setCompetitionEventId("");
    setOrderedIds(["", "", "", ""]);
    if (!competitionId) {
      setRelayEvents([]);
      return;
    }
    enabledEventsApi
      .listEnabledEvents(competitionId)
      .then((events) => setRelayEvents(events.filter((e) => e.event.testType.swimmersCount > 1)))
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar las pruebas de relevo"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competitionId]);

  useEffect(() => {
    setOrderedIds(["", "", "", ""]);
    if (!clubId) {
      setSwimmers([]);
      return;
    }
    enabledEventsApi
      .listClubSwimmers(clubId)
      .then(setSwimmers)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar los nadadores del club"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId]);

  function loadExistingTeams() {
    if (!competitionId || !clubId) {
      setExistingTeams([]);
      return;
    }
    traerTodasLasPaginas((page, pageSize) => api.list({ competitionId, clubId, status: "confirmed", page, pageSize }))
      .then(setExistingTeams)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar los relevos ya confirmados"));
  }

  useEffect(() => {
    loadExistingTeams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competitionId, clubId]);

  const selectedCompetition = competitions.find((c) => c.id === competitionId);
  const selectedEvent = relayEvents.find((e) => e.id === competitionEventId);

  const swimmersForEvent = selectedEvent
    ? swimmers.filter((s) => selectedEvent.event.gender === "mixed" || selectedEvent.event.gender === s.gender)
    : [];

  const positionLabels = selectedEvent ? relayPositionLabels(selectedEvent.event.stroke.name) : relayPositionLabels("");
  const selectedIds = orderedIds.filter(Boolean);

  function setPosition(index: number, personId: string) {
    setOrderedIds((prev) => {
      const next = [...prev];
      next[index] = personId;
      return next;
    });
  }

  const categoryPreview = useMemo(() => {
    if (!selectedEvent || !selectedCompetition || selectedIds.length !== 4) return null;
    if (!selectedCompetition.ageCutoffDate) return { error: "Esta competencia todavía no tiene definida su fecha de corte." };

    const selectedSwimmers = selectedIds.map((id) => swimmers.find((s) => s.id === id)).filter((s): s is EligibleSwimmer => Boolean(s));
    if (selectedSwimmers.length !== 4) return null;

    const combinedAge = selectedSwimmers.reduce((sum, s) => sum + computeAgeClientPreview(s.birthDate, selectedCompetition.ageCutoffDate!), 0);
    const match = selectedEvent.enabledCategories.find((ec) => combinedAge >= ec.category.minAge && combinedAge <= ec.category.maxAge);
    const matchCount = selectedEvent.enabledCategories.filter((ec) => combinedAge >= ec.category.minAge && combinedAge <= ec.category.maxAge).length;

    if (matchCount === 0) return { combinedAge, error: `No hay ninguna categoría configurada para esta edad combinada (${combinedAge} años).` };
    if (matchCount > 1) return { combinedAge, error: `Hay más de una categoría que coincide con esta edad combinada (${combinedAge} años) — revise las categorías en Catálogo.` };
    return { combinedAge, categoryName: match!.category.name };
  }, [selectedEvent, selectedCompetition, selectedIds, swimmers]);

  async function handleConfirm() {
    setError(null);
    setSuccess(null);
    setLoading(true);
    try {
      const parsedTime = timeInput.trim() ? parseSwimTimeInput(timeInput) : { ok: true, centiseconds: undefined };
      if (!parsedTime.ok) {
        setError(parsedTime.error ?? "Tiempo inválido");
        setLoading(false);
        return;
      }
      await api.create({
        competitionEventId,
        clubId,
        personIds: orderedIds,
        seedTimeCentiseconds: parsedTime.centiseconds,
      });
      setSuccess("Equipo de relevo inscrito correctamente.");
      setOrderedIds(["", "", "", ""]);
      setTimeInput("");
      loadExistingTeams();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo confirmar la inscripción");
    } finally {
      setLoading(false);
    }
  }

  if (isPureSwimmer) {
    return (
      <AppShell>
        <h1 style={{ color: "var(--brand-navy)" }}>Inscripciones de Relevo</h1>
        <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>
          Los nadadores solo pueden visualizar los relevos en los que participan, no inscribir ni modificar equipos.
        </p>
        <button className="btn-secondary" onClick={() => navigate("/inscripciones-relevos")}>Ver mis relevos</button>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ color: "var(--brand-navy)" }}>Nueva inscripción de relevo</h1>
        <button className="btn-secondary" onClick={() => navigate("/inscripciones-relevos")}>Ver inscripciones de relevos</button>
      </div>

      {error && <p className="error-message">{error}</p>}
      {success && (
        <p style={{ fontSize: "0.9rem", background: "var(--brand-bg)", color: "var(--brand-navy)", padding: "0.6rem", borderRadius: 6 }}>{success}</p>
      )}

      <div style={{ maxWidth: 760 }}>
        <label>1. Competencia (con inscripciones abiertas)</label>
        <select value={competitionId} onChange={(e) => setCompetitionId(e.target.value)}>
          <option value="">Seleccionar...</option>
          {competitions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <label>2. Club</label>
        <select value={clubId} onChange={(e) => setClubId(e.target.value)} disabled={isClubUser}>
          <option value="">Seleccionar...</option>
          {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        <label>3. Prueba de relevo</label>
        <select value={competitionEventId} onChange={(e) => { setCompetitionEventId(e.target.value); setOrderedIds(["", "", "", ""]); }} disabled={!competitionId}>
          <option value="">Seleccionar...</option>
          {relayEvents.map((e) => (
            <option key={e.id} value={e.id}>
              {formatEventLabel({ distanceMeters: e.event.distance.meters, strokeName: e.event.stroke.name, gender: e.event.gender, isRelay: true })} — {formatCalendarDate(e.competitionSession.competitionDate.date)} {e.competitionSession.sessionType.name}
            </option>
          ))}
        </select>
        {competitionId && relayEvents.length === 0 && (
          <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)" }}>Esta competencia no tiene pruebas de relevo habilitadas.</p>
        )}

        <label>4. Orden del equipo (4 nadadores, sin duplicados)</label>
        {!competitionEventId && <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>Complete los pasos anteriores primero.</p>}
        {competitionEventId && swimmersForEvent.length === 0 && (
          <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>No hay nadadores del club con un género compatible con esta prueba.</p>
        )}
        {competitionEventId && swimmersForEvent.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem" }}>
            {positionLabels.map((label, i) => (
              <div key={i}>
                <label style={{ fontSize: "0.85rem" }}>{label}</label>
                <select value={orderedIds[i]} onChange={(e) => setPosition(i, e.target.value)}>
                  <option value="">Seleccionar...</option>
                  {swimmersForEvent
                    .filter((s) => s.id === orderedIds[i] || !orderedIds.includes(s.id))
                    .map((s) => <option key={s.id} value={s.id}>{s.fullName} ({s.run})</option>)}
                </select>
              </div>
            ))}
          </div>
        )}
        <p style={{ fontSize: "0.85rem", color: selectedIds.length === 4 ? "var(--state-success)" : "var(--brand-gray-600)", marginTop: "0.4rem" }}>
          Seleccionados: {selectedIds.length} / 4
        </p>

        <label>5. Tiempo estimado del relevo (opcional) — formato mmsscc</label>
        <input value={timeInput} onChange={(e) => setTimeInput(e.target.value)} placeholder="012567" maxLength={6} style={{ maxWidth: 120 }} />

        <label>Categoría (calculada automáticamente por la edad combinada del equipo)</label>
        {categoryPreview === null && <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>Seleccione los 4 nadadores para calcularla.</p>}
        {categoryPreview && "categoryName" in categoryPreview && (
          <p style={{ fontSize: "0.95rem", fontWeight: 600, color: "var(--brand-navy)" }}>
            {categoryPreview.categoryName} <span style={{ fontWeight: 400, color: "var(--brand-gray-600)" }}>(edad combinada: {categoryPreview.combinedAge} años)</span>
          </p>
        )}
        {categoryPreview && "error" in categoryPreview && (
          <p style={{ fontSize: "0.85rem", color: "var(--state-warning)" }}>{categoryPreview.error}</p>
        )}

        <button
          className="btn-primary"
          style={{ marginTop: "0.5rem" }}
          onClick={handleConfirm}
          disabled={selectedIds.length !== 4 || loading || !categoryPreview || "error" in (categoryPreview ?? {})}
        >
          {loading ? "Confirmando..." : "Confirmar equipo de relevo"}
        </button>

        {competitionId && clubId && (
          <div style={{ marginTop: "2rem", paddingTop: "1.5rem", borderTop: "1px solid var(--brand-gray-100)" }}>
            <h2 style={{ fontSize: "1rem", color: "var(--brand-navy)" }}>Relevos ya confirmados de este club en esta competencia</h2>
            {existingTeams.length === 0 ? (
              <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>Todavía no hay equipos de relevo confirmados en esta competencia.</p>
            ) : (
              <table className="data-table">
                <thead><tr><th>Prueba</th><th>Fecha / Jornada</th><th>Categoría</th><th>Integrantes (en orden)</th><th>Tiempo estimado</th></tr></thead>
                <tbody>
                  {existingTeams.map((t) => (
                    <tr key={t.id}>
                      <td>{formatEventLabel({ distanceMeters: t.competitionEvent.event.distance.meters, strokeName: t.competitionEvent.event.stroke.name, gender: t.competitionEvent.event.gender, isRelay: true })}</td>
                      <td>{formatCalendarDate(t.competitionEvent.competitionSession.competitionDate.date)} — {t.competitionEvent.competitionSession.sessionType.name}</td>
                      <td>{t.category.name}</td>
                      <td>{t.members.slice().sort((a, b) => a.orderPosition - b.orderPosition).map((m) => m.person.fullName).join(" → ")}</td>
                      <td>{formatSwimTimeReadable(t.seedTimeCentiseconds)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
