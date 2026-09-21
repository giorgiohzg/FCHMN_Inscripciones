import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { useCompetitionsApi, type MeetImportSummary } from "./competitionsApi";

export function CompetitionMeetImportPage() {
  const api = useCompetitionsApi();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [maxIndividualEventsPerSwimmer, setMaxIndividualEventsPerSwimmer] = useState("");
  const [uploading, setUploading] = useState(false);
  const [summary, setSummary] = useState<MeetImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleImport() {
    if (!file || !maxIndividualEventsPerSwimmer) return;
    setError(null);
    setSummary(null);
    setUploading(true);
    try {
      const result = await api.importFromMeetEvents(file, Number(maxIndividualEventsPerSwimmer));
      setSummary(result);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo importar la competencia");
    } finally {
      setUploading(false);
    }
  }

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ color: "var(--brand-navy)" }}>Importar competencia desde Team Manager</h1>
        <button className="btn-secondary" onClick={() => navigate("/competencias")}>Volver al listado</button>
      </div>

      <div style={{ maxWidth: 680 }}>
        <p style={{ fontSize: "0.9rem", color: "var(--brand-gray-600)", marginTop: "1rem" }}>
          Suba el archivo <strong>.zip</strong> exportado desde Hy-Tek Meet Manager con la opción <strong>"Meet Events"</strong> (contiene un archivo
          <code>.ev3</code>). El sistema va a crear automáticamente:
        </p>
        <ul style={{ fontSize: "0.9rem", color: "var(--brand-gray-600)" }}>
          <li>La competencia (en estado Borrador), con su nombre y fechas de inscripción</li>
          <li>La fecha de corte para el cálculo de edad de categoría</li>
          <li>Las fechas y jornadas necesarias (inferidas por la hora de cada prueba)</li>
          <li>Las pruebas del catálogo (distancia, estilo, individual o relevo) — reutilizando las que ya existan</li>
          <li>La asignación de cada prueba a la competencia</li>
        </ul>
        <p style={{ fontSize: "0.85rem", color: "var(--state-warning)", marginTop: "0.5rem" }}>
          Importante: el archivo de Meet Manager no incluye categorías de edad — deberá asignarlas manualmente en el detalle de la competencia
          antes de poder abrir las inscripciones.
        </p>

        <label style={{ marginTop: "1rem" }}>Archivo .zip de Meet Manager</label>
        <input ref={fileInputRef} type="file" accept=".zip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />

        <label>Máximo de pruebas individuales por nadador (obligatorio — el archivo no lo trae)</label>
        <input
          type="number"
          min={1}
          value={maxIndividualEventsPerSwimmer}
          onChange={(e) => setMaxIndividualEventsPerSwimmer(e.target.value)}
          style={{ maxWidth: 160 }}
        />

        <div style={{ marginTop: "1rem" }}>
          <button className="btn-primary" onClick={handleImport} disabled={!file || !maxIndividualEventsPerSwimmer || uploading}>
            {uploading ? "Importando..." : "Importar competencia"}
          </button>
        </div>

        {error && <p className="error-message">{error}</p>}

        {summary && (
          <div style={{ marginTop: "2rem" }}>
            <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>Competencia importada: {summary.competitionName}</h2>
            <p style={{ fontSize: "0.9rem" }}>
              {summary.eventsImported} prueba(s) importada(s)
              {summary.eventsSkipped > 0 && <> — <span style={{ color: "var(--state-danger)" }}>{summary.eventsSkipped} omitida(s)</span></>}
              {" "}— {summary.sessionsCreated} jornada(s) creada(s)
            </p>
            {summary.warnings.length > 0 && (
              <ul style={{ fontSize: "0.85rem", color: "var(--state-warning)" }}>
                {summary.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            <button className="btn-primary" style={{ marginTop: "0.5rem" }} onClick={() => navigate(`/competencias/${summary.competitionId}`)}>
              Ir a la competencia importada
            </button>
          </div>
        )}
      </div>
    </AppShell>
  );
}
