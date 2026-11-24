import { CircledNumber } from "../../shared/CircledNumber";
import { ENCABEZADOS_DE_BLOQUES, enDosBloques, partesDeLineaDelReporte } from "./presentacionReporte";
import type { ClubGroupSwimmerRow, PruebaDeJornada } from "./reportsApi";

function CeldasDePrueba({ prueba }: { prueba: PruebaDeJornada }) {
  return (
    <>
      <td role="cell" className="reporte-prueba">
        <span className="reporte-prueba-contenido">
          {/* Ancho fijo también sin número: las descripciones quedan alineadas. */}
          <span className="reporte-numero">
            <CircledNumber n={prueba.numero} />
          </span>
          <span className="reporte-descripcion">{prueba.descripcion}</span>
        </span>
      </td>
      <td role="cell" className={prueba.tiempo === null ? "reporte-tiempo reporte-sin-tiempo" : "reporte-tiempo"}>
        {prueba.tiempoTexto}
      </td>
    </>
  );
}

/**
 * Nadadores de UN club con sus pruebas en dos bloques por fecha y jornada (la disposición de Excel y
 * PDF), en el orden del servidor. Una sola tabla por club: los tiempos quedan alineados entre
 * nadadores. Con poco ancho pasa a UNA columna, en el mismo orden (`theme.css`, «Reporte detallado»);
 * los `role` explícitos conservan la semántica de tabla aunque cambie su `display`.
 */
export function TablaDeClub({ nadadores }: { nadadores: ClubGroupSwimmerRow[] }) {
  return (
    <table role="table" className="reporte-tabla">
      <thead role="rowgroup">
        <tr role="row">
          {ENCABEZADOS_DE_BLOQUES.map((titulo, i) => (
            <th key={i} role="columnheader" scope="col" className={titulo === "Tiempo" ? "reporte-tiempo" : undefined}>
              {titulo}
            </th>
          ))}
        </tr>
      </thead>
      {nadadores.map((s, indice) => {
        const linea = partesDeLineaDelReporte(s);
        return (
          // Clave: el identificador interno de la persona (única en su club); nunca el nombre ni el RUN.
          <tbody key={s.personId ?? `posicion-${indice}`} role="rowgroup">
            <tr role="row" className="reporte-nadador">
              {/* `PATERNO MATERNO, NOMBRE (EDAD) - Categoría - Género`. Sin RUN. */}
              <th role="rowheader" scope="rowgroup" colSpan={ENCABEZADOS_DE_BLOQUES.length}>
                {s.numero ?? indice + 1}. <strong>{linea.nombre}</strong>
                {linea.detalle}
              </th>
            </tr>
            {s.jornadas?.flatMap((j) =>
              enDosBloques(j.pruebas).map((fila, i) => (
                <tr key={`${j.jornadaId}-${i}`} role="row" className="reporte-fila">
                  {/* En cada fila, para identificar su grupo; en una columna se muestra una vez por jornada. */}
                  <td role="cell" className={i === 0 ? "reporte-jornada" : "reporte-jornada reporte-jornada-repetida"}>
                    {j.titulo}
                  </td>
                  <CeldasDePrueba prueba={fila.izquierda} />
                  {fila.derecha === null ? <td role="cell" className="reporte-vacia" colSpan={2} /> : <CeldasDePrueba prueba={fila.derecha} />}
                </tr>
              ))
            )}
          </tbody>
        );
      })}
    </table>
  );
}
