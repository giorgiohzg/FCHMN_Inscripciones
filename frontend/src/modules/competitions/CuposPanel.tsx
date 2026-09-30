import type { Competition, CompetitionCapacity } from "./competitionsApi";

/**
 * Cupos de nadadores y su uso actual.
 *
 * El dato que importa mostrar no es solo el tope, sino **cuánto queda**: sin
 * eso, quien inscribe descubre que la competencia está llena al recibir el
 * error, después de haber preparado la inscripción.
 *
 * La barra es deliberadamente simple (un `div` sobre otro): un gráfico aquí
 * sería ruido, y este panel se lee de un vistazo.
 */

function Barra({ usados, tope }: { usados: number; tope: number }) {
  const porcentaje = tope > 0 ? Math.min(100, Math.round((usados / tope) * 100)) : 0;
  const lleno = usados >= tope;
  return (
    <div
      role="progressbar"
      aria-valuenow={usados}
      aria-valuemin={0}
      aria-valuemax={tope}
      aria-label={`${usados} de ${tope} cupos ocupados`}
      style={{ background: "var(--brand-gray-200, #e5e7eb)", borderRadius: 999, height: 8, overflow: "hidden", marginTop: "0.3rem" }}
    >
      <div
        style={{
          width: `${porcentaje}%`,
          height: "100%",
          background: lleno ? "var(--state-danger)" : porcentaje >= 80 ? "var(--state-warning)" : "var(--state-success)",
          transition: "width 0.2s ease",
        }}
      />
    </div>
  );
}

export function CuposPanel({ competition, capacity }: { competition: Competition; capacity: CompetitionCapacity | null }) {
  const sinCupos = competition.maxSwimmers === null && competition.maxSwimmersPerClub === null;

  // Sin cupos configurados no se ocupa sitio en pantalla con una sección
  // vacía: se dice en una línea, junto al resto de los límites.
  if (sinCupos) {
    return (
      <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>
        Cupos de nadadores: <strong>sin límite</strong>
        {capacity && <> — {capacity.totalSwimmers} nadador(es) inscrito(s)</>}
      </p>
    );
  }

  return (
    <section style={{ marginTop: "1rem", maxWidth: 640, background: "var(--brand-bg)", borderRadius: 8, padding: "0.9rem 1.1rem" }}>
      <h2 style={{ fontSize: "0.95rem", color: "var(--brand-navy)", margin: 0 }}>Cupos de nadadores</h2>
      <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", margin: "0.2rem 0 0.8rem" }}>
        Se cuentan nadadores distintos con inscripción activa, no la cantidad de pruebas de cada uno.
      </p>

      {competition.maxSwimmers !== null && (
        <div style={{ marginBottom: "0.9rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.88rem" }}>
            <span>Total de la competencia</span>
            <span>
              <strong>{capacity ? capacity.totalSwimmers : "—"}</strong> / {competition.maxSwimmers}
              {capacity && capacity.remainingSwimmers !== null && !capacity.isFull && (
                <span style={{ color: "var(--brand-gray-600)" }}> — quedan {capacity.remainingSwimmers}</span>
              )}
            </span>
          </div>
          {capacity && <Barra usados={capacity.totalSwimmers} tope={competition.maxSwimmers} />}
          {capacity?.isFull && (
            <p style={{ fontSize: "0.8rem", color: "var(--state-danger)", marginTop: "0.4rem" }}>
              Cupo completo: las inscripciones se cerraron automáticamente. Para admitir más nadadores, amplíe el cupo y use{" "}
              <strong>Reabrir inscripciones</strong> — guardar la competencia por sí solo no la reabre.
            </p>
          )}
        </div>
      )}

      {competition.maxSwimmersPerClub !== null && (
        <div>
          <div style={{ fontSize: "0.88rem", marginBottom: "0.3rem" }}>
            Por club: máximo <strong>{competition.maxSwimmersPerClub}</strong> nadador(es)
          </div>
          {capacity && capacity.byClub.length > 0 ? (
            <table className="data-table" style={{ fontSize: "0.85rem" }}>
              <thead>
                <tr>
                  <th>Club</th>
                  <th style={{ width: 110 }}>Inscritos</th>
                  <th style={{ width: 110 }}>Disponibles</th>
                </tr>
              </thead>
              <tbody>
                {capacity.byClub.map((c) => (
                  <tr key={c.clubId}>
                    <td>{c.clubName}</td>
                    <td>
                      {c.swimmers} / {competition.maxSwimmersPerClub}
                    </td>
                    <td style={{ color: c.isFull ? "var(--state-danger)" : undefined }}>{c.isFull ? "Completo" : (c.remaining ?? "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>Todavía no hay clubes con nadadores inscritos.</p>
          )}
        </div>
      )}
    </section>
  );
}
