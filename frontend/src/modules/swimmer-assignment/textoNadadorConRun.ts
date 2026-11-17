import { nombreApellidosPrimero, type NombreDeNadador } from "../../shared/nombreDeNadador";
import { formatRunConGuion } from "../persons/runValidator";

/**
 * Texto «PATERNO MATERNO, NOMBRES (13579246-2)» para mensajes y etiquetas. Sin RUN no se inventa uno:
 * se omite el paréntesis. Registros incompletos: el nombre completo almacenado, en mayúsculas.
 */
export function textoNadadorConRun(p: NombreDeNadador & { run?: string | null }): string {
  const nombre = nombreApellidosPrimero(p) || "—";
  const run = formatRunConGuion(p.run);
  return run ? `${nombre} (${run})` : nombre;
}
