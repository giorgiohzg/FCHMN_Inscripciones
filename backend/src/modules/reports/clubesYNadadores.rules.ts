/**
 * Reporte GENERAL «Clubes y nadadores» (exclusivo de administración): reglas puras.
 *
 * Es independiente de las competencias: describe la pertenencia VIGENTE, no lo inscrito.
 *
 *  - Un grupo por club NO eliminado (cualquiera sea su estado), ordenados por nombre; también
 *    los clubes sin nadadores.
 *  - Debajo, sus nadadores ACTUALES: membresía `active` de una persona no eliminada. Una persona
 *    tiene a lo sumo una membresía activa (`club_swimmers_unique_active_person`), así que no se
 *    duplica por su historial.
 *  - «Sin club asignado»: el MISMO criterio que la asignación masiva (`whereSinClubAsignable`):
 *    TODA persona no eliminada, con cuenta activa y sin membresía activa, sin exigir el rol
 *    `swimmer` ni un historial previo (decisión del usuario).
 *  - El PERSONAL de un club (delegados, entrenadores, representante legal) no entra en el grupo
 *    de ese club por su vínculo de personal, que no es una membresía. Pero si esa persona no tiene
 *    membresía activa, cumple el criterio de «Sin club asignado» y aparece allí.
 *  - «Revisión: membresía activa en un club eliminado»: personas no eliminadas cuya membresía
 *    activa es de un club eliminado. No son «sin club» (tienen una membresía activa) y no se
 *    reclasifican ni se repara nada: se listan aparte, para que administración las revise.
 *  - Solo el nombre de cada persona: sin RUN, nacimiento, correo ni otros datos.
 *
 * ORDEN DE LAS SECCIONES (el mismo en pantalla, CSV, Excel y PDF): los clubes no eliminados; luego
 * la revisión, si existe; y SIEMPRE al final «Sin club asignado», como pidió el usuario.
 *
 * Cada persona aparece EXACTAMENTE una vez. Si las filas recibidas lo contradicen (la misma
 * persona dos veces, o «sin club» y con membresía a la vez), es una lectura incoherente y se
 * rechaza con un error: no se corrige en silencio.
 *
 * Pantalla, CSV, Excel y PDF salen de la MISMA estructura (`filasDelReporte` para las dos
 * planillas), completa: no hay paginación ni tope que la recorte.
 */
import { compararClubes, compararNadadores, escapeCsvValue, neutralizeSpreadsheetFormula, type PersonaOrdenable } from "./reports.rules";

export const ETIQUETA_SIN_CLUB = "Sin club asignado";
export const ETIQUETA_REVISION = "Revisión: membresía activa en un club eliminado";
export const SECCION_CLUB = "Club";
export const TEXTO_CLUB_SIN_NADADORES = "(sin nadadores)";
export const ENCABEZADOS = ["Sección", "Club", "Sigla", "N°", "Nadador"] as const;

export interface PersonaDelReporte extends PersonaOrdenable {
  personId: string;
}

export interface NadadorDelReporte {
  personId: string;
  /** `PATERNO MATERNO, NOMBRE`, o el nombre completo almacenado si el registro está incompleto. */
  nombre: string;
}

export interface GrupoDeClub {
  clubId: string;
  clubName: string;
  sigla: string;
  estado: "active" | "locked" | "disabled";
  nadadores: NadadorDelReporte[];
}

/** Club ELIMINADO con personas que aún tienen en él su membresía activa (sección de revisión). */
export interface GrupoDeRevision {
  clubId: string;
  clubName: string;
  sigla: string;
  personas: NadadorDelReporte[];
}

export interface ReporteClubesYNadadores {
  clubes: GrupoDeClub[];
  sinClub: NadadorDelReporte[];
  /** Vacío si no hay ninguna; ordenados por nombre del club eliminado. */
  revision: GrupoDeRevision[];
  totales: {
    clubes: number;
    nadadoresConClub: number;
    sinClub: number;
    /** Personas de la sección de revisión. No se suman a `nadadoresConClub` ni a `sinClub`. */
    enClubesEliminados: number;
  };
}

/** Lectura incoherente: una persona que aparecería dos veces o en dos grupos. */
export class LecturaIncoherente extends Error {}

const limpio = (v: string | null | undefined) => (v ?? "").trim();
const mayusculas = (v: string) => v.toLocaleUpperCase("es-CL");

/**
 * Presentación del nombre: la misma que el Panel de Inscripción y Reportes en pantalla
 * (`frontend/src/shared/nombreDeNadador.ts`). Usa los campos separados; si falta el apellido
 * paterno o el nombre (registros históricos) muestra el nombre completo almacenado, SIN coma:
 * nunca se parte `fullName` para inventar apellidos. Las mayúsculas son solo de presentación.
 */
export function nombreDelReporte(p: Pick<PersonaOrdenable, "fullName" | "firstName" | "paternalLastName" | "maternalLastName">): string {
  if (limpio(p.paternalLastName) === "" || limpio(p.firstName) === "") return mayusculas(limpio(p.fullName));
  const materno = limpio(p.maternalLastName);
  const apellidos = materno ? `${limpio(p.paternalLastName)} ${materno}` : limpio(p.paternalLastName);
  return mayusculas(`${apellidos}, ${limpio(p.firstName)}`);
}

const ordenarPersonas = (personas: readonly PersonaDelReporte[]): NadadorDelReporte[] =>
  [...personas].sort(compararNadadores).map((p) => ({ personId: p.personId, nombre: nombreDelReporte(p) }));

const porNombreDeClub = (a: { id: string; name: string }, b: { id: string; name: string }) =>
  compararClubes(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Arma el reporte: clubes por nombre (desempata el id), personas por apellidos.
 *
 * `membresiasActivas` trae TODAS las membresías activas de personas no eliminadas, con su club
 * (eliminado o no). `clubes` son los clubes NO eliminados. Las tres listas deben venir de la MISMA
 * instantánea de lectura (ver `obtenerClubesYNadadores`).
 */
export function armarReporte(entrada: {
  clubes: readonly { id: string; name: string; code: string; status: GrupoDeClub["estado"] }[];
  membresiasActivas: readonly { clubId: string; club: { name: string; code: string; eliminado: boolean }; persona: PersonaDelReporte }[];
  sinClub: readonly PersonaDelReporte[];
}): ReporteClubesYNadadores {
  const porClub = new Map<string, PersonaDelReporte[]>();
  for (const c of entrada.clubes) porClub.set(c.id, []);
  const eliminados = new Map<string, { id: string; name: string; code: string; personas: PersonaDelReporte[] }>();
  const vistas = new Set<string>();
  const registrar = (p: PersonaDelReporte) => {
    if (vistas.has(p.personId)) throw new LecturaIncoherente("Una persona aparece más de una vez en la lectura del reporte.");
    vistas.add(p.personId);
  };

  let conClub = 0;
  for (const m of entrada.membresiasActivas) {
    registrar(m.persona);
    const lista = porClub.get(m.clubId);
    if (lista) {
      lista.push(m.persona);
      conClub++;
      continue;
    }
    if (!m.club.eliminado) throw new LecturaIncoherente("Una membresía activa apunta a un club que no está en la lectura.");
    const grupo = eliminados.get(m.clubId) ?? { id: m.clubId, name: m.club.name, code: m.club.code, personas: [] };
    grupo.personas.push(m.persona);
    eliminados.set(m.clubId, grupo);
  }
  for (const p of entrada.sinClub) registrar(p);

  const clubes = [...entrada.clubes]
    .sort(porNombreDeClub)
    .map((c) => ({ clubId: c.id, clubName: c.name, sigla: c.code, estado: c.status, nadadores: ordenarPersonas(porClub.get(c.id)!) }));
  const revision = [...eliminados.values()]
    .sort(porNombreDeClub)
    .map((c) => ({ clubId: c.id, clubName: c.name, sigla: c.code, personas: ordenarPersonas(c.personas) }));
  return {
    clubes,
    sinClub: ordenarPersonas(entrada.sinClub),
    revision,
    totales: {
      clubes: clubes.length,
      nadadoresConClub: conClub,
      sinClub: entrada.sinClub.length,
      enClubesEliminados: revision.reduce((s, g) => s + g.personas.length, 0),
    },
  };
}

export type TipoDeGrupo = "club" | "sinClub" | "revision";
export interface GrupoPresentado {
  tipo: TipoDeGrupo;
  seccion: string;
  titulo: string;
  sigla: string;
  personas: NadadorDelReporte[];
}

/**
 * Grupos en el orden en que se presentan: los clubes, la revisión (si existe) y, SIEMPRE como
 * última sección, «Sin club asignado». Es la única fuente del orden para CSV, Excel y PDF.
 */
export function gruposEnOrden(r: ReporteClubesYNadadores): GrupoPresentado[] {
  return [
    ...r.clubes.map((c) => ({ tipo: "club" as const, seccion: SECCION_CLUB, titulo: c.clubName, sigla: c.sigla, personas: c.nadadores })),
    ...r.revision.map((c) => ({
      tipo: "revision" as const,
      seccion: ETIQUETA_REVISION,
      titulo: c.clubName,
      sigla: c.sigla,
      personas: c.personas,
    })),
    { tipo: "sinClub" as const, seccion: ETIQUETA_SIN_CLUB, titulo: ETIQUETA_SIN_CLUB, sigla: "", personas: r.sinClub },
  ];
}

/**
 * Filas de las planillas (CSV y Excel, idénticas): una por persona, con su sección, club, sigla y
 * número dentro del grupo. Un club (o «Sin club asignado») sin personas tiene UNA fila con
 * «(sin nadadores)» y sin número, para que aparezca igual que en pantalla. En «Sin club asignado»
 * las columnas de club quedan vacías. La sección de revisión solo existe si tiene personas.
 */
export function filasDelReporte(r: ReporteClubesYNadadores): string[][] {
  const filas: string[][] = [];
  for (const g of gruposEnOrden(r)) {
    const club = g.tipo === "sinClub" ? "" : g.titulo;
    if (g.personas.length === 0) filas.push([g.seccion, club, g.sigla, "", TEXTO_CLUB_SIN_NADADORES]);
    else g.personas.forEach((n, i) => filas.push([g.seccion, club, g.sigla, String(i + 1), n.nombre]));
  }
  return filas;
}

/** CSV completo. Cada celda pasa por `escapeCsvValue` (fórmulas y límites de celda, AUD-V). */
export function csvDelReporte(r: ReporteClubesYNadadores): string {
  const lineas = [ENCABEZADOS.map(escapeCsvValue).join(",")];
  for (const fila of filasDelReporte(r)) lineas.push(fila.map(escapeCsvValue).join(","));
  return lineas.join("\r\n");
}

/** Celdas seguras para Excel: la misma neutralización de fórmulas que el CSV. */
export const celdasSeguras = (fila: readonly string[]): string[] => fila.map(neutralizeSpreadsheetFormula);

/** Línea de totales del PDF: distingue los tres grupos. */
export function resumenDeTotales(r: ReporteClubesYNadadores): string {
  const t = r.totales;
  return (
    `${t.clubes} club(es) · ${t.nadadoresConClub} nadador(es) con club · ${t.sinClub} sin club asignado · ` +
    `${t.enClubesEliminados} con membresía activa en un club eliminado (revisión)`
  );
}

// ----------------------------------------------------------------------------------------- PDF

/** Una línea del PDF. */
export type LineaDelPdf =
  | { tipo: "encabezado"; texto: string; continuacion: boolean; grupo: TipoDeGrupo }
  | { tipo: "nadador"; texto: string }
  | { tipo: "vacio"; texto: string };

/** Una línea ya ubicada, con la ALTURA real que ocupa (puntos). */
export interface LineaUbicada {
  linea: LineaDelPdf;
  alto: number;
}

/** Título del encabezado de un grupo. */
export function tituloDelGrupo(g: GrupoPresentado): string {
  const n = g.personas.length;
  if (g.tipo === "sinClub") return `${ETIQUETA_SIN_CLUB} — ${n} persona(s)`;
  if (g.tipo === "revision") return `Revisión — club eliminado: ${g.titulo} (${g.sigla}) — ${n} persona(s) con membresía activa`;
  return `${g.titulo} (${g.sigla}) — ${n} nadador(es)`;
}

const tituloDeContinuacion = (g: GrupoPresentado) =>
  g.tipo === "revision" ? `Revisión — club eliminado: ${g.titulo} (continuación)` : `${g.titulo} (continuación)`;

/**
 * Distribución en páginas por ALTURA REAL, PURA: `medir` devuelve cuántos puntos ocupa cada línea
 * con su texto ya ajustado al ancho (el servicio la mide con la misma fuente y ancho con que la
 * dibuja; las pruebas usan una medida sintética). Reglas:
 *  - una línea nunca se corta entre páginas ni se superpone con la siguiente: si no cabe entera,
 *    va a la página siguiente;
 *  - un encabezado nunca queda solo al pie: debe caber junto con la primera línea de su grupo;
 *  - si un grupo continúa en otra página, esa página empieza repitiendo su encabezado con
 *    «(continuación)»;
 *  - nada se omite: cada persona ocupa exactamente una entrada en alguna página. Una línea más
 *    alta que una página entera se coloca igualmente, sola, en una página nueva.
 */
export function paginarPdf(
  r: ReporteClubesYNadadores,
  opciones: { altoPrimera: number; alto: number; medir: (l: LineaDelPdf) => number }
): LineaUbicada[][] {
  const paginas: LineaUbicada[][] = [[]];
  let libre = opciones.altoPrimera;
  const actual = () => paginas[paginas.length - 1]!;
  const nueva = () => {
    paginas.push([]);
    libre = opciones.alto;
  };
  const poner = (linea: LineaDelPdf, alto: number) => {
    actual().push({ linea, alto });
    libre -= alto;
  };

  for (const g of gruposEnOrden(r)) {
    const encabezado: LineaDelPdf = { tipo: "encabezado", texto: tituloDelGrupo(g), continuacion: false, grupo: g.tipo };
    const lineas: LineaDelPdf[] =
      g.personas.length === 0
        ? [{ tipo: "vacio", texto: TEXTO_CLUB_SIN_NADADORES }]
        : g.personas.map((n, i) => ({ tipo: "nadador" as const, texto: `${i + 1}. ${n.nombre}` }));
    const altoEncabezado = opciones.medir(encabezado);
    if (altoEncabezado + opciones.medir(lineas[0]!) > libre && actual().length > 0) nueva();
    poner(encabezado, altoEncabezado);
    for (const l of lineas) {
      const alto = opciones.medir(l);
      if (alto > libre && actual().length > 0) {
        nueva();
        const continuacion: LineaDelPdf = { tipo: "encabezado", texto: tituloDeContinuacion(g), continuacion: true, grupo: g.tipo };
        poner(continuacion, opciones.medir(continuacion));
        // Ni en una página nueva cabe junto a su encabezado: va sola en la siguiente.
        if (alto > libre) nueva();
      }
      poner(l, alto);
    }
  }
  return paginas;
}
