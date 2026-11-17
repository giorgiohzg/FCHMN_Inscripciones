import { nombreApellidosPrimero, type NombreDeNadador } from "../../shared/nombreDeNadador";
import { formatRunConGuion } from "../persons/runValidator";

/**
 * Presentación de un nadador en el plantel de Editar Club y en Asignación de Nadadores:
 * «PATERNO MATERNO, NOMBRES (13579246-2)». Sin RUN no se inventa uno: se omite el paréntesis. El RUN
 * no se corta en el guion cuando la columna es estrecha. Registros incompletos: el nombre completo
 * almacenado, en mayúsculas (`nombreApellidosPrimero`). Es solo presentación.
 */
export function NadadorConRun({ p }: { p: NombreDeNadador & { run?: string | null } }) {
  const nombre = nombreApellidosPrimero(p) || "—";
  const run = formatRunConGuion(p.run);
  return (
    <>
      {nombre}
      {run && (
        <>
          {" "}
          <span style={{ whiteSpace: "nowrap" }}>({run})</span>
        </>
      )}
    </>
  );
}
