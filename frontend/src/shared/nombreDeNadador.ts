/**
 * PRESENTACIÓN Y ORDEN DE NADADORES en el Panel de Inscripción y en el Panel de Relevos.
 *
 * Formato: `PATERNO MATERNO, NOMBRE (EDAD)`, p. ej. `SINTÉTICO EJEMPLO, ANA MARÍA (54)`.
 *
 *  - Usa los campos SEPARADOS que ya guarda la persona (`paternalLastName`, `maternalLastName`,
 *    `firstName`). Las mayúsculas son solo de presentación: los datos no cambian.
 *  - NUNCA se reconstruyen apellidos partiendo `fullName`: con nombres o apellidos compuestos esa
 *    partición inventaría datos.
 *  - REGISTROS INCOMPLETOS (históricos, sin apellido paterno o sin nombre): alternativa explícita.
 *    Se muestra `fullName` tal como está guardado, en mayúsculas y SIN coma (la coma afirmaría
 *    dónde terminan los apellidos, que no se sabe). Sin apellido materno no es incompleto: se
 *    muestra `PATERNO, NOMBRE`.
 *  - La edad es la que calcula el SERVIDOR a la fecha de corte de la competencia (`edadAlCorte`,
 *    con el mismo respaldo que las reglas de inscripción). Si no se conoce, no se muestra: no se
 *    calcula aquí con otro criterio.
 *
 * Orden: apellido paterno, apellido materno (sin materno va antes) y nombre, con comparación
 * en español sin distinguir mayúsculas ni tildes. Los registros incompletos van DESPUÉS de los
 * completos, ordenados por su `fullName`. El identificador desempata, para un orden estable.
 */
export interface NombreDeNadador {
  fullName: string;
  firstName?: string | null;
  paternalLastName?: string | null;
  maternalLastName?: string | null;
}

const recortado = (v: string | null | undefined) => (v ?? "").trim();
const mayusculas = (v: string) => v.toLocaleUpperCase("es-CL");
const colador = new Intl.Collator("es-CL", { sensitivity: "base" });

/** ¿Tiene los campos separados mínimos (apellido paterno y nombre)? */
export function tieneNombreSeparado(p: NombreDeNadador): boolean {
  return recortado(p.paternalLastName) !== "" && recortado(p.firstName) !== "";
}

/** `PATERNO MATERNO, NOMBRE` o, si el registro está incompleto, `FULLNAME`. Sin la edad. */
export function nombreEnPanel(p: NombreDeNadador): string {
  if (!tieneNombreSeparado(p)) return mayusculas(recortado(p.fullName));
  const materno = recortado(p.maternalLastName);
  const apellidos = materno ? `${recortado(p.paternalLastName)} ${materno}` : recortado(p.paternalLastName);
  return mayusculas(`${apellidos}, ${recortado(p.firstName)}`);
}

/** El nombre con la edad entre paréntesis, si se conoce. */
export function nombreConEdad(p: NombreDeNadador, edad: number | null | undefined): string {
  const nombre = nombreEnPanel(p);
  return typeof edad === "number" && Number.isFinite(edad) ? `${nombre} (${edad})` : nombre;
}

/** Comparador: paterno, materno, nombre; incompletos al final por `fullName`; desempata `id`. */
export function compararNadadores<T extends NombreDeNadador>(idDe: (p: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const completoA = tieneNombreSeparado(a);
    const completoB = tieneNombreSeparado(b);
    if (completoA !== completoB) return completoA ? -1 : 1;
    const claves: [string, string][] = completoA
      ? [
          [recortado(a.paternalLastName), recortado(b.paternalLastName)],
          [recortado(a.maternalLastName), recortado(b.maternalLastName)],
          [recortado(a.firstName), recortado(b.firstName)],
        ]
      : [[recortado(a.fullName), recortado(b.fullName)]];
    for (const [x, y] of claves) {
      const c = colador.compare(x, y);
      if (c !== 0) return c;
    }
    const ia = idDe(a);
    const ib = idDe(b);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  };
}

/** ¿Coincide con la búsqueda? Por `fullName`, por el nombre presentado o por RUN. */
export function coincideConBusqueda(p: NombreDeNadador & { run: string }, consulta: string): boolean {
  const q = consulta.trim().toLocaleLowerCase("es-CL");
  if (!q) return true;
  return (
    p.fullName.toLocaleLowerCase("es-CL").includes(q) ||
    nombreEnPanel(p).toLocaleLowerCase("es-CL").includes(q) ||
    p.run.toLowerCase().includes(q)
  );
}
