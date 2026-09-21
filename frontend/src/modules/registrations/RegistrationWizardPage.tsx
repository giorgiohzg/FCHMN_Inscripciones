import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { useAuth } from "../auth/AuthContext";
import { useCompetitionsApi, type Competition } from "../competitions/competitionsApi";
import { useClubsApi, type Club } from "../clubs/clubsApi";
import { useRegistrationsApi, type EligibleSwimmer, type AvailableIndividualEvent, type RegistrationItem } from "./registrationsApi";
import { useSwimmerAssignmentApi } from "../swimmer-assignment/assignmentApi";
import { formatCalendarDate } from "../../shared/calendarDate";
import { formatEventLabel } from "../../shared/eventLabel";
import { formatShortName } from "../../shared/personDisplayName";
import { parseSwimTimeInput, formatSwimTimeReadable } from "../../shared/swimTime";
import { traerTodasLasPaginas } from "../../shared/paginacion";

interface BatchRowResult {
  eventLabel: string;
  status: "created" | "error";
  error?: string;
}

export function RegistrationWizardPage() {
  const { user, hasRole } = useAuth();
  const navigate = useNavigate();
  const competitionsApi = useCompetitionsApi();
  const clubsApi = useClubsApi();
  const api = useRegistrationsApi();
  const assignmentApi = useSwimmerAssignmentApi();

  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [ownClubName, setOwnClubName] = useState<string | null>(null);
  const [swimmers, setSwimmers] = useState<EligibleSwimmer[]>([]);
  const [availableEvents, setAvailableEvents] = useState<AvailableIndividualEvent[]>([]);
  const [existingRegistrations, setExistingRegistrations] = useState<RegistrationItem[]>([]);

  const [competitionId, setCompetitionId] = useState("");
  const [clubId, setClubId] = useState("");
  const [personId, setPersonId] = useState("");
  const [competitionEventId, setCompetitionEventId] = useState("");
  const [timeInput, setTimeInput] = useState("");

  // Modo nadador: carga masiva — un checkbox + un tiempo por cada prueba disponible.
  const [batchSelected, setBatchSelected] = useState<Record<string, boolean>>({});
  const [batchTimes, setBatchTimes] = useState<Record<string, string>>({});
  const [batchResults, setBatchResults] = useState<BatchRowResult[] | null>(null);
  const [batchSubmitting, setBatchSubmitting] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isClubUser = user?.ownerType === "club";
  const isPureSwimmer = user?.ownerType === "person" && !hasRole("admin") && !user?.clubId;

  useEffect(() => {
    // Selector: sin recorrer las páginas solo llegaban las 20 primeras
    // competencias abiertas (el tamaño por omisión del backend).
    traerTodasLasPaginas((page, pageSize) => competitionsApi.list({ status: "open", page, pageSize }))
      .then(setCompetitions)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar las competencias"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isPureSwimmer) {
      if (user?.personId) {
        setPersonId(user.personId);
        assignmentApi
          .getCurrentClub(user.personId)
          .then((c) => {
            if (c) {
              setClubId(c.club.id);
              setOwnClubName(c.club.name);
            } else {
              setOwnClubName("Sin club asignado");
              setError("No tiene un club asignado — no puede inscribirse hasta que un administrador lo asigne a un club.");
            }
          })
          .catch((err) => setError(err instanceof Error ? err.message : "No se pudo determinar su club"));
      }
      return;
    }
    traerTodasLasPaginas((page, pageSize) => clubsApi.list({ status: "active", page, pageSize }))
      .then((clubes) => {
        setClubs(clubes);
        if (isClubUser && user?.clubId) setClubId(user.clubId);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar los clubes"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isPureSwimmer) return;
    setPersonId("");
    setCompetitionEventId("");
    setAvailableEvents([]);
    if (!clubId) {
      setSwimmers([]);
      return;
    }
    api
      .listClubSwimmers(clubId)
      .then(setSwimmers)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar los nadadores del club"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubId]);

  // Carga de pruebas disponibles: en modo nadador se dispara con competencia+personId
  // (ya autocompletado); en el modo general, igual, pero personId lo elige el usuario.
  useEffect(() => {
    setCompetitionEventId("");
    setAvailableEvents([]);
    setBatchSelected({});
    setBatchTimes({});
    setBatchResults(null);
    if (!competitionId || !personId) return;
    api
      .listAvailableEvents(competitionId, personId)
      .then(setAvailableEvents)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar las pruebas disponibles"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competitionId, personId]);

  function loadExistingRegistrations() {
    if (!competitionId || !clubId) {
      setExistingRegistrations([]);
      return;
    }
    traerTodasLasPaginas((page, pageSize) => api.list({ competitionId, clubId, status: "confirmed", page, pageSize }))
      .then(setExistingRegistrations)
      .catch((err) => setError(err instanceof Error ? err.message : "No se pudieron cargar las inscripciones ya confirmadas"));
  }

  useEffect(() => {
    loadExistingRegistrations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competitionId, clubId]);

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
        personId,
        seedTimeCentiseconds: parsedTime.centiseconds,
      });
      setSuccess("Inscripción confirmada correctamente.");
      setCompetitionEventId("");
      setTimeInput("");
      api.listAvailableEvents(competitionId, personId).then(setAvailableEvents);
      loadExistingRegistrations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo confirmar la inscripción");
    } finally {
      setLoading(false);
    }
  }

  function toggleBatchRow(eventId: string) {
    setBatchSelected((prev) => ({ ...prev, [eventId]: !prev[eventId] }));
  }

  const selectedBatchCount = Object.values(batchSelected).filter(Boolean).length;

  async function handleBatchConfirm() {
    setError(null);
    setBatchResults(null);
    setBatchSubmitting(true);
    const results: BatchRowResult[] = [];
    for (const ev of availableEvents) {
      if (!batchSelected[ev.competitionEventId]) continue;
      const label = `${ev.distanceMeters}m ${ev.strokeName} — ${ev.categoryName}`;
      const rawTime = batchTimes[ev.competitionEventId]?.trim();
      let centiseconds: number | undefined;
      if (rawTime) {
        const parsed = parseSwimTimeInput(rawTime);
        if (!parsed.ok) {
          results.push({ eventLabel: label, status: "error", error: parsed.error });
          continue;
        }
        centiseconds = parsed.centiseconds;
      }
      try {
        await api.create({ competitionEventId: ev.competitionEventId, clubId, personId, seedTimeCentiseconds: centiseconds });
        results.push({ eventLabel: label, status: "created" });
      } catch (err) {
        results.push({ eventLabel: label, status: "error", error: err instanceof Error ? err.message : "Error desconocido" });
      }
    }
    setBatchResults(results);
    setBatchSelected({});
    setBatchTimes({});
    setBatchSubmitting(false);
    api.listAvailableEvents(competitionId, personId).then(setAvailableEvents);
    loadExistingRegistrations();
  }

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ color: "var(--brand-navy)" }}>Nueva inscripción individual</h1>
        <button className="btn-secondary" onClick={() => navigate("/inscripciones")}>Ver inscripciones</button>
      </div>

      {error && <p className="error-message">{error}</p>}
      {success && (
        <p style={{ fontSize: "0.9rem", background: "var(--brand-bg)", color: "var(--brand-navy)", padding: "0.6rem", borderRadius: 6 }}>{success}</p>
      )}

      <div style={{ maxWidth: 720 }}>
        <label>1. Competencia (con inscripciones abiertas)</label>
        <select value={competitionId} onChange={(e) => setCompetitionId(e.target.value)}>
          <option value="">Seleccionar...</option>
          {competitions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {competitions.length === 0 && (
          <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)" }}>No hay competencias con inscripciones abiertas en este momento.</p>
        )}

        <label>2. Club</label>
        {isPureSwimmer ? (
          <p style={{ fontSize: "0.9rem", padding: "0.5rem 0" }}>{ownClubName ?? "Cargando..."}</p>
        ) : (
          <select value={clubId} onChange={(e) => setClubId(e.target.value)} disabled={isClubUser}>
            <option value="">Seleccionar...</option>
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}

        <label>3. Nadador</label>
        {isPureSwimmer ? (
          <p style={{ fontSize: "0.9rem", padding: "0.5rem 0" }}>Usted mismo — los nadadores solo pueden inscribirse a sí mismos.</p>
        ) : (
          <>
            <select value={personId} onChange={(e) => setPersonId(e.target.value)} disabled={!clubId}>
              <option value="">Seleccionar...</option>
              {swimmers.map((s) => <option key={s.id} value={s.id}>{s.fullName} ({s.run})</option>)}
            </select>
            {clubId && swimmers.length === 0 && (
              <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)" }}>Este club no tiene nadadores activos asignados todavía.</p>
            )}
          </>
        )}

        {isPureSwimmer ? (
          <>
            <label>4. Pruebas disponibles — marque las que desea inscribir e ingrese el tiempo estimado de cada una</label>
            <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginTop: "-0.3rem" }}>
              Formato del tiempo: mmsscc (ej: 012567 = 1 minuto 25,67 segundos). Es opcional para cada prueba.
            </p>
            {personId && competitionId && availableEvents.length === 0 && (
              <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>
                No hay pruebas disponibles (puede que ya esté inscrito en todas, que ninguna tenga una categoría configurada para su edad, o que el
                género no coincida).
              </p>
            )}
            {availableEvents.length > 0 && (
              <table className="data-table" style={{ marginTop: "0.5rem" }}>
                <thead><tr><th></th><th>Prueba</th><th>Categoría</th><th>Fecha / Jornada</th><th>Tiempo estimado (mmsscc)</th></tr></thead>
                <tbody>
                  {availableEvents.map((ev) => (
                    <tr key={ev.competitionEventId}>
                      <td>
                        <input type="checkbox" style={{ width: "auto" }} checked={Boolean(batchSelected[ev.competitionEventId])} onChange={() => toggleBatchRow(ev.competitionEventId)} />
                      </td>
                      <td>{ev.distanceMeters}m {ev.strokeName}</td>
                      <td>{ev.categoryName}</td>
                      <td>{formatCalendarDate(ev.competitionDate)} {ev.sessionTypeName}</td>
                      <td>
                        <input
                          value={batchTimes[ev.competitionEventId] ?? ""}
                          onChange={(e) => setBatchTimes((prev) => ({ ...prev, [ev.competitionEventId]: e.target.value }))}
                          placeholder="mmsscc"
                          maxLength={6}
                          style={{ maxWidth: 100 }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <button
              className="btn-primary"
              style={{ marginTop: "1rem" }}
              onClick={handleBatchConfirm}
              disabled={selectedBatchCount === 0 || batchSubmitting || !clubId}
            >
              {batchSubmitting ? "Confirmando..." : `Confirmar ${selectedBatchCount || ""} inscripción(es) seleccionada(s)`}
            </button>

            {batchResults && (
              <div style={{ marginTop: "1.5rem" }}>
                <h2 style={{ fontSize: "1.02rem", color: "var(--brand-navy)" }}>Resultado</h2>
                <table className="data-table" style={{ marginTop: "0.4rem" }}>
                  <thead><tr><th>Prueba</th><th>Estado</th><th>Detalle</th></tr></thead>
                  <tbody>
                    {batchResults.map((r, i) => (
                      <tr key={i}>
                        <td>{r.eventLabel}</td>
                        <td><span className={`badge ${r.status === "created" ? "badge-active" : "badge-disabled"}`}>{r.status === "created" ? "Confirmada" : "Error"}</span></td>
                        <td>{r.error ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : (
          <>
            <label>4. Prueba (categoría calculada automáticamente según fecha de nacimiento y fecha de corte)</label>
            <select value={competitionEventId} onChange={(e) => setCompetitionEventId(e.target.value)} disabled={!personId || !competitionId}>
              <option value="">Seleccionar...</option>
              {availableEvents.map((e) => (
                <option key={e.competitionEventId} value={e.competitionEventId}>
                  {e.distanceMeters}m {e.strokeName} — {e.categoryName} — {formatCalendarDate(e.competitionDate)} {e.sessionTypeName}
                </option>
              ))}
            </select>
            {personId && competitionId && availableEvents.length === 0 && (
              <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)" }}>
                No hay pruebas disponibles para este nadador en esta competencia (puede que ya esté inscrito en todas, que ninguna prueba tenga una categoría
                configurada para su edad, o que el género no coincida).
              </p>
            )}

            <label>Tiempo estimado (opcional) — formato mmsscc</label>
            <input value={timeInput} onChange={(e) => setTimeInput(e.target.value)} placeholder="012567" maxLength={6} style={{ maxWidth: 120 }} />

            <button className="btn-primary" style={{ marginTop: "1.25rem" }} onClick={handleConfirm} disabled={!competitionEventId || !clubId || loading}>
              {loading ? "Confirmando..." : "Confirmar inscripción"}
            </button>
          </>
        )}

        {competitionId && clubId && (
          <div style={{ marginTop: "2rem", paddingTop: "1.5rem", borderTop: "1px solid var(--brand-gray-100)" }}>
            <h2 style={{ fontSize: "1rem", color: "var(--brand-navy)" }}>Inscripciones ya confirmadas de este club en esta competencia</h2>
            {existingRegistrations.length === 0 ? (
              <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>Todavía no hay inscripciones individuales confirmadas en esta competencia.</p>
            ) : (
              <table className="data-table">
                <thead><tr><th>Nadador</th><th>Prueba</th><th>Fecha / Jornada</th><th>Categoría</th><th>Tiempo estimado</th></tr></thead>
                <tbody>
                  {existingRegistrations.map((r) => (
                    <tr key={r.id}>
                      <td>{formatShortName(r.person)} ({r.person.run})</td>
                      <td>{formatEventLabel({ distanceMeters: r.competitionEvent.event.distance.meters, strokeName: r.competitionEvent.event.stroke.name, gender: r.competitionEvent.event.gender, isRelay: r.competitionEvent.event.testType.swimmersCount > 1 })}</td>
                      <td>{formatCalendarDate(r.competitionEvent.competitionSession.competitionDate.date)} — {r.competitionEvent.competitionSession.sessionType.name}</td>
                      <td>{r.category.name}</td>
                      <td>{formatSwimTimeReadable(r.seedTimeCentiseconds)}</td>
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
