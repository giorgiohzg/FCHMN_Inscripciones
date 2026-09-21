import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { usePersonsApi, type BulkImportSummary } from "./personsApi";

export function PersonsBulkImportPage() {
  const api = usePersonsApi();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [summary, setSummary] = useState<BulkImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDownloadTemplate() {
    setError(null);
    try {
      await api.downloadBulkImportTemplate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo descargar la plantilla");
    }
  }

  async function handleUpload() {
    if (!file) return;
    setError(null);
    setSummary(null);
    setUploading(true);
    try {
      const result = await api.bulkImport(file);
      setSummary(result);
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo procesar el archivo");
    } finally {
      setUploading(false);
    }
  }

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h1 style={{ color: "var(--brand-navy)" }}>Carga masiva de personas</h1>
        <button className="btn-secondary" onClick={() => navigate("/personas")}>Volver al listado</button>
      </div>

      <div style={{ maxWidth: 680 }}>
        <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)", marginTop: "1.5rem" }}>Formato exigido del archivo Excel</h2>
        <p style={{ fontSize: "0.9rem", color: "var(--brand-gray-600)" }}>
          El archivo debe ser <strong>.xlsx</strong>, con una fila de encabezado y una fila por persona, en este orden exacto de columnas:
        </p>
        <table className="data-table" style={{ marginTop: "0.5rem" }}>
          <thead><tr><th>Columna</th><th>Campo</th><th>Obligatorio</th><th>Formato</th></tr></thead>
          <tbody>
            <tr><td>A</td><td>RUN</td><td>Sí</td><td>Ej: 12.345.678-9</td></tr>
            <tr><td>B</td><td>Nombre de usuario</td><td>Sí</td><td>Sin espacios, único en el sistema</td></tr>
            <tr><td>C</td><td>Nombre</td><td>Sí</td><td>Texto libre</td></tr>
            <tr><td>D</td><td>Apellido paterno</td><td>Sí</td><td>Texto libre</td></tr>
            <tr><td>E</td><td>Apellido materno</td><td>No</td><td>Texto libre</td></tr>
            <tr><td>F</td><td>Fecha de nacimiento</td><td>Sí</td><td>DD-MM-AAAA</td></tr>
            <tr><td>G</td><td>Género</td><td>Sí</td><td>"Femenino" o "Masculino"</td></tr>
            <tr><td>H</td><td>Correo electrónico</td><td>No</td><td>Ej: nombre@correo.cl</td></tr>
            <tr><td>I</td><td>Teléfono</td><td>No</td><td>Texto libre</td></tr>
            <tr><td>J</td><td>Roles</td><td>Sí</td><td>Nadador, Delegado y/o Entrenador, separados por coma</td></tr>
          </tbody>
        </table>
        <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)", marginTop: "0.5rem" }}>
          El RUN y el nombre de usuario deben ser únicos — filas duplicadas o ya existentes en el sistema se rechazan individualmente, sin afectar al resto del archivo.
        </p>
        <p style={{ fontSize: "0.85rem", color: "var(--state-danger)", marginTop: "0.5rem" }}>
          Importante sobre Roles: marcar "Delegado" o "Entrenador" aquí no les da acceso al sistema por sí solo — además hay que asignarlos como delegado/entrenador
          en la ficha del club correspondiente, ya que el acceso se otorga por esa asignación real, no por esta columna. "Representante Legal" no se puede cargar
          desde este archivo: se asigna únicamente desde la ficha del club.
        </p>

        <button className="btn-secondary" style={{ marginTop: "1rem" }} onClick={handleDownloadTemplate}>
          Descargar plantilla de ejemplo
        </button>

        <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)", marginTop: "2rem" }}>Cargar archivo</h2>
        <input ref={fileInputRef} type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <div style={{ marginTop: "0.75rem" }}>
          <button className="btn-primary" onClick={handleUpload} disabled={!file || uploading}>
            {uploading ? "Procesando..." : "Cargar personas"}
          </button>
        </div>

        {error && <p className="error-message">{error}</p>}

        {summary && (
          <div style={{ marginTop: "2rem" }}>
            <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>Resultado</h2>
            <p style={{ fontSize: "0.9rem" }}>
              {summary.totalRows} fila(s) procesada(s) — <span style={{ color: "var(--state-success)" }}>{summary.createdCount} creada(s)</span>
              {summary.errorCount > 0 && <> — <span style={{ color: "var(--state-danger)" }}>{summary.errorCount} con error</span></>}
            </p>
            <table className="data-table" style={{ marginTop: "0.5rem" }}>
              <thead><tr><th>Fila</th><th>Estado</th><th>Detalle</th></tr></thead>
              <tbody>
                {summary.results.map((r) => (
                  <tr key={r.row}>
                    <td>{r.row}</td>
                    <td>
                      <span className={`badge ${r.status === "created" ? "badge-active" : "badge-disabled"}`}>
                        {r.status === "created" ? "Creada" : "Error"}
                      </span>
                    </td>
                    <td>{r.status === "created" ? r.fullName : r.errors?.join(" · ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}
