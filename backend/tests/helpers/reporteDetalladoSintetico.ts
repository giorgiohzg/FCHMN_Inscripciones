/**
 * Datos SINTÉTICOS del reporte detallado: entradas como las que arma el servicio (primero las
 * individuales y después los relevos, una por integrante). Nombres, clubes y RUN inventados.
 */
import { armarReporteDetallado, type ReporteDetallado } from "../../src/modules/reports/reporteDetallado.rules";
import type { JornadaDeEntrada, PruebaDeJornada, SwimmerEventEntry } from "../../src/modules/reports/reports.rules";
import type ExcelJS from "exceljs";

export const CORTE = new Date("2027-12-31T00:00:00.000Z");

const jornada = (id: string, dia: string, nombre: string, primerNumero: number | null): JornadaDeEntrada => ({
  id,
  fecha: new Date(`${dia}T00:00:00.000Z`),
  nombre,
  primerNumero,
});
/** Dos jornadas «Mañana» en días distintos; la noche abre el programa antes que la especial. */
export const JORNADAS = {
  miercolesManana: jornada("s-mie-m", "2027-01-06", "Mañana", 1),
  miercolesTarde: jornada("s-mie-t", "2027-01-06", "Tarde", 4),
  juevesManana: jornada("s-jue-m", "2027-01-07", "Mañana", 5),
  juevesNoche: jornada("s-jue-n", "2027-01-07", "Noche", 20),
  juevesEspecial: jornada("s-jue-e", "2027-01-07", "Especial", 30),
};

export interface Persona {
  personId: string;
  nombres: string | null;
  paterno: string | null;
  materno: string | null;
  completo?: string;
  genero?: "male" | "female";
  categoria?: string;
  club?: string;
}

/** Identificador sintético del club, distinto de su nombre. */
export const idDeClub = (nombre: string) => `id-${nombre}`;

export function entrada(p: Persona, o: Partial<SwimmerEventEntry> & Pick<SwimmerEventEntry, "jornada">): SwimmerEventEntry {
  return {
    personId: p.personId,
    run: `RUNSINTETICO-${p.personId}`,
    fullName: p.completo ?? [p.nombres, p.paterno, p.materno].filter(Boolean).join(" "),
    firstName: p.nombres,
    paternalLastName: p.paterno,
    maternalLastName: p.materno,
    clubId: idDeClub(p.club ?? "CLUB DE PRUEBA"),
    clubName: p.club ?? "CLUB DE PRUEBA",
    birthDate: new Date("1984-05-10T00:00:00.000Z"),
    gender: p.genero ?? "female",
    categoryName: p.categoria ?? "Master D",
    eventNumber: 1,
    eventLabel: "50m Libre",
    timeLabel: null,
    kind: "individual",
    ...o,
  };
}

export const ANA: Persona = { personId: "p-ana", nombres: "Ana", paterno: "Prueba", materno: "Sintética" };
/** Sin segundo apellido. */
export const BRUNO: Persona = { personId: "p-bruno", nombres: "Bruno", paterno: "Ñandú", materno: null, genero: "male", categoria: "Master E" };
/** Registro histórico, sin apellidos separados. */
export const CARMEN: Persona = { personId: "p-carmen", nombres: null, paterno: null, materno: null, completo: "Carmen del Río Histórica" };
export const DIEGO: Persona = { personId: "p-diego", nombres: "Diego", paterno: "Ávila", materno: "Über", genero: "male" };
/** Solo relevos. */
export const ELENA: Persona = { personId: "p-elena", nombres: "Elena", paterno: "Relevista", materno: "Única", categoria: "Relevo 160-199" };
export const LARGO: Persona = {
  personId: "p-largo",
  nombres: "María de los Ángeles Fernanda Constanza Guadalupe del Carmen",
  paterno: "Fernández-Echeverría de la Santísima Trinidad",
  materno: "Larraín Undurraga y Goyeneche-Iturralde del Solar",
};
/** Contenido que exige escapado y neutralización. */
export const HOSTIL: Persona = { personId: "p-hostil", nombres: '"Beto"; =1+1', paterno: "=SUMA(A1)", materno: "Soto, +2", club: 'Club "Raro"; =1+1, -S.A.' };

const RELEVO = "Relevo 200m Libre (Mixto)";

/** Escenario base: 6 personas en el club de prueba y 1 en el club hostil; 2 equipos de relevo. */
export function entradasBase(): SwimmerEventEntry[] {
  const J = JORNADAS;
  return [
    // Ana: deliberadamente en desorden; números 10, 2 y ausente en la misma jornada.
    entrada(ANA, { jornada: J.juevesManana, eventNumber: 8, eventLabel: "200m Combinado", timeLabel: "3:28,52" }),
    entrada(ANA, { jornada: J.miercolesManana, eventNumber: null, eventLabel: "50m Mariposa" }),
    entrada(ANA, { jornada: J.miercolesManana, eventNumber: 10, eventLabel: "100m Espalda", timeLabel: "1:45,00" }),
    entrada(ANA, { jornada: J.miercolesManana, eventNumber: 2, eventLabel: "800m Libre", timeLabel: "13:03,08" }),
    entrada(ANA, { jornada: J.juevesManana, eventNumber: 5, eventLabel: "100m Pecho", timeLabel: "1:39,07" }),
    entrada(ANA, { jornada: J.miercolesTarde, eventNumber: 4, eventLabel: "50m Pecho", timeLabel: "0:45,10" }),
    entrada(ANA, { jornada: J.juevesEspecial, eventNumber: 30, eventLabel: "400m Libre" }),
    entrada(ANA, { jornada: J.juevesNoche, eventNumber: 20, eventLabel: "50m Espalda" }),
    entrada(BRUNO, { jornada: J.juevesManana, eventNumber: 6, eventLabel: "100m Pecho", timeLabel: "1:20,00" }),
    entrada(CARMEN, { jornada: J.miercolesManana, eventNumber: 2, eventLabel: "800m Libre" }),
    entrada(DIEGO, { jornada: J.miercolesManana, eventNumber: 3, eventLabel: "800m Libre", timeLabel: "12:00,50" }),
    entrada(LARGO, { jornada: J.miercolesManana, eventNumber: 2, eventLabel: "800m Libre" }),
    entrada(HOSTIL, { jornada: J.miercolesManana, eventNumber: 2, eventLabel: "800m Libre", timeLabel: "14:00,00" }),
    // Dos equipos: cada uno aporta una entrada por integrante.
    ...[ANA, BRUNO, DIEGO, ELENA].map((p) =>
      entrada(p, { jornada: J.juevesManana, kind: "relay", eventNumber: 7, eventLabel: RELEVO, timeLabel: "2:15,34", categoryName: "Relevo 160-199" })
    ),
    ...[LARGO, CARMEN, DIEGO, ELENA].map((p) =>
      entrada(p, { jornada: J.miercolesTarde, kind: "relay", eventNumber: 9, eventLabel: "Relevo 200m Combinado (Mixto)", categoryName: "Relevo 160-199" })
    ),
  ];
}

export const EQUIPOS_BASE = new Map([[idDeClub("CLUB DE PRUEBA"), 2]]);

export const reporteBase = (): ReporteDetallado => armarReporteDetallado("CAMPEONATO SINTÉTICO", entradasBase(), CORTE, EQUIPOS_BASE);

/** El escenario base más `clubes` × `porClub` nadadores: suficiente para varias páginas. */
export function reporteGrande(clubes = 4, porClub = 15): ReporteDetallado {
  const J = Object.values(JORNADAS);
  const extra: SwimmerEventEntry[] = [];
  for (let c = 1; c <= clubes; c++) {
    for (let n = 1; n <= porClub; n++) {
      const p: Persona = {
        personId: `p-${c}-${n}`,
        nombres: n % 3 === 0 ? "Persona Ñuñoa" : "Persona",
        paterno: `Apellido${String(n).padStart(2, "0")}`,
        materno: n % 4 === 0 ? null : "Ejemplo",
        club: `Club Sintético ${c}`,
        genero: n % 2 ? "female" : "male",
      };
      for (let e = 0; e < 1 + (n % 7); e++) {
        extra.push(entrada(p, { jornada: J[e % J.length]!, eventNumber: e * 3 + 2, eventLabel: `${50 * (e + 1)}m Libre`, timeLabel: e % 2 ? null : `1:${10 + e},0${e}` }));
      }
    }
  }
  return armarReporteDetallado("CAMPEONATO SINTÉTICO", [...extra, ...entradasBase()], CORTE, EQUIPOS_BASE);
}

// ------------------------------------------------------------------------------- Dos clubes
// Personas con inscripciones guardadas en DOS clubes de la misma competencia.

export const CLUB_A = "CLUB SINTÉTICO A";
export const CLUB_B = "CLUB SINTÉTICO B";
/** Individual en A, individual en B y relevo en B. */
export const DORA: Persona = { personId: "p-dora", nombres: "Dora", paterno: "Doble", materno: "Club" };
/** Otra persona con el MISMO nombre, en el club A. */
export const DORA_HOMONIMA: Persona = { ...DORA, personId: "p-dora-homonima", categoria: "Master F" };
/** Individual en A y SOLO relevo en B: en B su categoría es la del relevo. */
export const FITO: Persona = { personId: "p-fito", nombres: "Fito", paterno: "Mixto", materno: null, genero: "male" };
export const GALA: Persona = { personId: "p-gala", nombres: "Gala", paterno: "Única", materno: "Beta" };
export const HUGO: Persona = { personId: "p-hugo", nombres: "Hugo", paterno: "Único", materno: "Beta", genero: "male" };

export function entradasDosClubes(): SwimmerEventEntry[] {
  const J = JORNADAS;
  const en = (p: Persona, club: string, o: Parameters<typeof entrada>[1]) => entrada({ ...p, club }, o);
  return [
    en(DORA, CLUB_A, { jornada: J.miercolesManana, eventNumber: 2, eventLabel: "800m Libre", timeLabel: "13:03,08", categoryName: "Master D" }),
    en(DORA, CLUB_B, { jornada: J.juevesManana, eventNumber: 5, eventLabel: "100m Pecho", timeLabel: "1:39,07", categoryName: "Master E" }),
    en(DORA_HOMONIMA, CLUB_A, { jornada: J.miercolesTarde, eventNumber: 4, eventLabel: "50m Pecho", timeLabel: "0:45,10", categoryName: "Master F" }),
    en(FITO, CLUB_A, { jornada: J.miercolesManana, eventNumber: 10, eventLabel: "100m Espalda", categoryName: "Master C" }),
    // Un equipo, del club B, con Dora y Fito (que también están en A) y dos personas más.
    ...[DORA, FITO, GALA, HUGO].map((p) =>
      en(p, CLUB_B, { jornada: J.juevesManana, kind: "relay", eventNumber: 7, eventLabel: RELEVO, timeLabel: "2:15,34", categoryName: "Relevo 160-199" })
    ),
  ];
}
/** Un solo equipo (cuatro integrantes), del club B. */
export const EQUIPOS_DOS_CLUBES = new Map([[idDeClub(CLUB_B), 1]]);

/** La distribución correcta, escrita a mano: club → «n. nadador» → jornada → pruebas. */
export const DISTRIBUCION_DOS_CLUBES = [
  {
    club: `${CLUB_A} (3 nadadores, 3 pruebas individuales, 0 relevos)`,
    nadadores: [
      { personId: "p-dora", linea: "1. DOBLE CLUB, DORA (43) - Master D - Damas", pruebas: ["06-01-2027 Mañana: 2 800m Libre 13:03,08"] },
      { personId: "p-dora-homonima", linea: "2. DOBLE CLUB, DORA (43) - Master F - Damas", pruebas: ["06-01-2027 Tarde: 4 50m Pecho 0:45,10"] },
      { personId: "p-fito", linea: "3. MIXTO, FITO (43) - Master C - Varones", pruebas: ["06-01-2027 Mañana: 10 100m Espalda"] },
    ],
  },
  {
    club: `${CLUB_B} (4 nadadores, 1 pruebas individuales, 1 relevos)`,
    nadadores: [
      {
        personId: "p-dora",
        linea: "1. DOBLE CLUB, DORA (43) - Master E - Damas",
        pruebas: ["07-01-2027 Mañana: 5 100m Pecho 1:39,07", "07-01-2027 Mañana: 7 Relevo 200m Libre (Mixto) 2:15,34"],
      },
      { personId: "p-fito", linea: "2. MIXTO, FITO (43) - Relevo 160-199 - Varones", pruebas: ["07-01-2027 Mañana: 7 Relevo 200m Libre (Mixto) 2:15,34"] },
      { personId: "p-gala", linea: "3. ÚNICA BETA, GALA (43) - Relevo 160-199 - Damas", pruebas: ["07-01-2027 Mañana: 7 Relevo 200m Libre (Mixto) 2:15,34"] },
      { personId: "p-hugo", linea: "4. ÚNICO BETA, HUGO (43) - Relevo 160-199 - Varones", pruebas: ["07-01-2027 Mañana: 7 Relevo 200m Libre (Mixto) 2:15,34"] },
    ],
  },
];

export const reporteDosClubes = (): ReporteDetallado => armarReporteDetallado("CAMPEONATO SINTÉTICO", entradasDosClubes(), CORTE, EQUIPOS_DOS_CLUBES);

// ------------------------------------------------------------------------------- Lectura

/** «descripción tiempo», o solo la descripción si no hay tiempo: para comparar líneas de un vistazo. */
export const textoDe = (p: PruebaDeJornada) => (p.tiempo === null ? p.descripcion : `${p.descripcion} ${p.tiempo}`);
/** «[n] descripción tiempo», tal como se ve en un bloque (con «Sin tiempo» si falta). */
export const bloqueDe = (p: PruebaDeJornada) => `${p.numero === null ? "" : `[${p.numero}] `}${p.descripcion} ${p.tiempoTexto}`;

export interface ClubLeido {
  club: string;
  nadadores: { linea: string; filas: { jornada: string; bloques: string[] }[] }[];
}
/** Lee de vuelta la hoja «Inscripciones»: títulos y filas de dos bloques, tal como quedaron escritos. */
export function leerHojaDetallada(hoja: ExcelJS.Worksheet): ClubLeido[] {
  const clubes: ClubLeido[] = [];
  hoja.eachRow((fila, n) => {
    if (n <= 2) return;
    const a = String(fila.getCell(1).value ?? "");
    const esFila = !fila.getCell(1).isMerged && fila.getCell(3).value !== null;
    if (esFila) {
      const bloque = (numero: number, prueba: number, tiempo: number) => {
        if (fila.getCell(prueba).value === null) return [];
        const valor = fila.getCell(numero).value;
        return [`${valor === null ? "" : `[${valor}] `}${fila.getCell(prueba).value} ${fila.getCell(tiempo).value}`];
      };
      clubes.at(-1)!.nadadores.at(-1)!.filas.push({ jornada: a, bloques: [...bloque(2, 3, 4), ...bloque(5, 6, 7)] });
    } else if (/^\d+\. /.test(a)) clubes.at(-1)!.nadadores.push({ linea: a, filas: [] });
    else clubes.push({ club: a, nadadores: [] });
  });
  return clubes;
}
