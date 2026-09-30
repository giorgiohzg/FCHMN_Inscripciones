import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { useCompetitionsApi, type MeetAnalysis, type MeetImportSummary, type RelayDecision } from "./competitionsApi";

const GENERO: Record<string, string> = { female: "damas", male: "varones", mixed: "mixto" };

/**
 * Valor con el que se representa "omitir esta prueba" en el desplegable.
 *
 * Es una cadena reservada y no un id vacío para que no se confunda con "no he
 * elegido nada": son dos estados distintos y el segundo impide importar.
 */
const OMITIR = "__omitir__";

export function CompetitionMeetImportPage() {
  const api = useCompetitionsApi();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [maxIndividualEventsPerSwimmer, setMaxIndividualEventsPerSwimmer] = useState("");
  const [uploading, setUploading] = useState(false);
  const [summary, setSummary] = useState<MeetImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Estado de la confirmación de relevos (fase 2).
   *
   * `elecciones` va por NÚMERO DE PRUEBA, no por tipo de prueba: dos relevos
   * con la misma distancia, estilo y género pueden necesitar tipos distintos.
   *
   * Empieza VACÍO a propósito. No se precarga ninguna opción, ni siquiera
   * cuando el catálogo tiene un solo tipo de relevo: una preselección es la
   * elección automática que se quiso eliminar, solo que con aspecto de
   * propuesta del usuario.
   */
  const [analisis, setAnalisis] = useState<MeetAnalysis | null>(null);
  const [elecciones, setElecciones] = useState<Record<number, string>>({});

  const relevosPendientes = analisis ? analisis.relevos.filter((r) => !elecciones[r.eventNumber]) : [];
  const listoParaImportar = Boolean(analisis) && relevosPendientes.length === 0 && Boolean(maxIndividualEventsPerSwimmer);

  function reiniciar() {
    setAnalisis(null);
    setElecciones({});
    setError(null);
  }

  async function handleAnalizar() {
    if (!file) return;
    setError(null);
    setSummary(null);
    setAnalisis(null);
    setElecciones({});
    setUploading(true);
    try {
      setAnalisis(await api.analyzeMeetEvents(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo analizar el archivo");
    } finally {
      setUploading(false);
    }
  }

  async function handleImport() {
    if (!file || !maxIndividualEventsPerSwimmer || !analisis) return;
    if (relevosPendientes.length > 0) return;
    setError(null);
    setSummary(null);
    setUploading(true);
    try {
      const decisiones: RelayDecision[] = analisis.relevos.map((r) => {
        const elegido = elecciones[r.eventNumber]!;
        return elegido === OMITIR
          ? { eventNumber: r.eventNumber, decision: "omitir" }
          : { eventNumber: r.eventNumber, decision: "tipo", testTypeId: elegido };
      });

      const result = await api.importFromMeetEvents(file, Number(maxIndividualEventsPerSwimmer), {
        fileHash: analisis.fileHash,
        decisiones,
      });
      setSummary(result);
      setFile(null);
      setAnalisis(null);
      setElecciones({});
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
          Suba el archivo exportado desde Hy-Tek Meet Manager con la opción <strong>"Meet Events"</strong>. Se admiten el{" "}
          <strong>.zip</strong> completo (que contiene un <code>.ev3</code>), el <strong>.ev3</strong> suelto y el <strong>.hyv</strong>.
          Lo que decide es el <strong>contenido</strong>, no la extensión: un archivo con el nombre correcto pero otro contenido se rechaza.
          El sistema va a crear automáticamente:
        </p>
        <ul style={{ fontSize: "0.9rem", color: "var(--brand-gray-600)" }}>
          <li>La competencia (en estado Borrador), con su nombre y fechas de inscripción</li>
          <li>La fecha de corte para el cálculo de edad de categoría</li>
          <li>Las fechas y jornadas necesarias (inferidas por la hora de cada prueba, cuando el archivo la trae)</li>
          <li>Las pruebas del catálogo (distancia, estilo, individual o relevo) — reutilizando las que ya existan</li>
          <li>La asignación de cada prueba a la competencia</li>
        </ul>
        <p style={{ fontSize: "0.85rem", color: "var(--state-warning)", marginTop: "0.5rem" }}>
          Importante: el archivo de Meet Manager no incluye categorías de edad — deberá asignarlas manualmente en el detalle de la competencia
          antes de poder abrir las inscripciones.
        </p>
        {/*
          Lo que la importación NO puede resolver sola. Va aquí, antes de subir
          el archivo, y no solo en los avisos posteriores: quien importa tiene
          que saber de antemano que queda trabajo manual, no descubrirlo
          después entre una lista de mensajes.
        */}
        <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)", marginTop: "0.5rem" }}>
          Tenga en cuenta que ningún formato de Meet Manager indica <strong>a qué día ni a qué jornada</strong> corresponde cada prueba de
          forma que se pueda aplicar con certeza. En una competencia de varios días, las pruebas se cargarán todas en el primero, y
          las que no traigan hora quedarán en una jornada llamada <em>«Jornada sin especificar (importada)»</em>. No se reparten entre
          Mañana y Tarde para no inventar un dato que el archivo no da: deberá distribuirlas usted. El resumen se lo recordará al terminar.
        </p>
        <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)", marginTop: "0.5rem" }}>
          El formato <strong>.hyv</strong> se contrastó contra un archivo real de Meet Manager <strong>7.0Gb</strong>, y por ahora{" "}
          <strong>solo se acepta esa versión y esa disposición de campos</strong>. Un <code>.hyv</code> que no coincida se rechaza sin crear
          la competencia, en vez de interpretarse a riesgo de cargar las pruebas con distancias o estilos equivocados: en ese caso exporte el
          mismo programa como <code>.ev3</code>, o avise al administrador para incorporar ese formato.
        </p>
        <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)", marginTop: "0.5rem" }}>
          Ningún formato indica <strong>en cuántas postas se divide un relevo</strong>: solo trae la distancia total, y 200 m pueden ser
          4×50 o 2×100. Por eso la importación va en dos pasos: primero se analiza el archivo, y usted confirma el tipo de cada relevo
          antes de que se cree nada. Ningún relevo se importa sin esa confirmación.
        </p>

        <label style={{ marginTop: "1rem" }} htmlFor="archivo-meet">Archivo de Meet Manager (.zip, .ev3 o .hyv)</label>
        <input
          id="archivo-meet"
          ref={fileInputRef}
          type="file"
          accept=".zip,.ev3,.hyv"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            // Un archivo nuevo invalida el análisis anterior: las decisiones
            // están numeradas por pruebas de OTRO archivo.
            reiniciar();
          }}
        />

        {/*
          El `htmlFor` faltaba: sin él, un lector de pantalla anuncia un campo
          numérico sin nombre, y hacer clic en la etiqueta no enfoca el campo.
        */}
        <label htmlFor="max-individuales">Máximo de pruebas individuales por nadador (obligatorio — el archivo no lo trae)</label>
        <input
          id="max-individuales"
          type="number"
          min={1}
          value={maxIndividualEventsPerSwimmer}
          onChange={(e) => setMaxIndividualEventsPerSwimmer(e.target.value)}
          style={{ maxWidth: 160 }}
        />

        {/* PASO 1 — analizar. Mientras no haya análisis, no hay nada que importar. */}
        {!analisis && (
          <div style={{ marginTop: "1rem" }}>
            <button className="btn-primary" onClick={handleAnalizar} disabled={!file || uploading}>
              {uploading ? "Analizando..." : "Analizar archivo"}
            </button>
            <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", marginTop: "0.4rem" }}>
              Este paso no crea la competencia: solo lee el archivo y muestra qué contiene.
            </p>
          </div>
        )}

        {analisis && (
          <div style={{ marginTop: "1.5rem" }}>
            <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>Análisis: {analisis.competitionName}</h2>
            <p style={{ fontSize: "0.9rem" }}>
              {analisis.eventsTotal} prueba(s) — {analisis.dayCount} día(s) — {analisis.relevos.length} relevo(s) por confirmar.
              {" "}Todavía no se ha creado nada.
            </p>

            {analisis.relevos.length > 0 && (
              <div style={{ marginTop: "1rem" }}>
                <h3 style={{ fontSize: "0.95rem", color: "var(--brand-navy)" }}>Confirme el tipo de cada relevo</h3>
                <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>
                  Cada relevo se decide por separado, aunque dos coincidan en distancia, estilo y género: pueden ser pruebas distintas.
                  Si no puede confirmar alguno, elija <em>No puedo confirmarlo</em> y esa prueba quedará sin importar, contada como omitida.
                </p>
                <table style={{ width: "100%", marginTop: "0.6rem", fontSize: "0.88rem" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>Prueba</th>
                      <th style={{ textAlign: "left" }}>Tipo de relevo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analisis.relevos.map((relevo) => {
                      const etiqueta = `#${relevo.eventNumber} — ${relevo.distanceMeters} m ${relevo.strokeName} ${GENERO[relevo.gender] ?? relevo.gender}`;
                      return (
                        <tr key={relevo.eventNumber}>
                          <td>{etiqueta}</td>
                          <td>
                            <select
                              aria-label={`Tipo de relevo para la prueba ${relevo.eventNumber}`}
                              /*
                                El valor arranca en "" y esa opción no se puede
                                volver a elegir: obliga a una decisión y deja
                                ver cuáles faltan.
                              */
                              value={elecciones[relevo.eventNumber] ?? ""}
                              onChange={(e) =>
                                setElecciones((previas) => ({ ...previas, [relevo.eventNumber]: e.target.value }))
                              }
                            >
                              <option value="" disabled>
                                Elija una opción
                              </option>
                              {relevo.opciones.map((opcion) => (
                                <option key={opcion.testTypeId} value={opcion.testTypeId}>
                                  {opcion.nombre} ({opcion.swimmersCount} nadadores) → {opcion.etiqueta}
                                  {opcion.divisible ? "" : " — la distancia no se divide en postas iguales"}
                                </option>
                              ))}
                              <option value={OMITIR}>No puedo confirmarlo — no importar esta prueba</option>
                            </select>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {relevosPendientes.length > 0 && (
                  <p role="status" style={{ fontSize: "0.85rem", color: "var(--state-warning)", marginTop: "0.5rem" }}>
                    Faltan {relevosPendientes.length} relevo(s) por decidir: {relevosPendientes.map((r) => `#${r.eventNumber}`).join(", ")}.
                  </p>
                )}
              </div>
            )}

            <div style={{ marginTop: "1rem", display: "flex", gap: "0.6rem" }}>
              <button className="btn-primary" onClick={handleImport} disabled={!listoParaImportar || uploading}>
                {uploading ? "Importando..." : "Importar competencia"}
              </button>
              <button className="btn-secondary" onClick={reiniciar} disabled={uploading}>
                Cancelar
              </button>
            </div>
            {!maxIndividualEventsPerSwimmer && (
              <p style={{ fontSize: "0.85rem", color: "var(--state-warning)", marginTop: "0.4rem" }}>
                Indique el máximo de pruebas individuales por nadador para poder importar.
              </p>
            )}
          </div>
        )}

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
              /*
                Los avisos no son decorativos: el más importante —que el
                archivo no dice a qué día va cada prueba— obliga a mover las
                pruebas a mano. Va destacado, no como una nota al pie.
              */
              <div
                role="alert"
                style={{
                  marginTop: "0.75rem",
                  border: "1px solid var(--state-warning)",
                  borderRadius: 6,
                  padding: "0.6rem 0.9rem",
                  background: "rgba(245, 158, 11, 0.08)",
                }}
              >
                <strong style={{ fontSize: "0.88rem", color: "var(--state-warning)" }}>
                  Revise lo siguiente ({summary.warnings.length}):
                </strong>
                <ul style={{ fontSize: "0.85rem", margin: "0.35rem 0 0", paddingLeft: "1.1rem" }}>
                  {summary.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
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
