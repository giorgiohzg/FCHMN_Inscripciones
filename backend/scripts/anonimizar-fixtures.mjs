/**
 * Anonimización de los fixtures de Hy-Tek.
 *
 * Los tres archivos de muestra provenían de exportaciones reales y contenían
 * datos de personas: apellidos, nombres, identificadores nacionales y fechas
 * de nacimiento. Este guion los sustituye por una identidad sintética
 * inequívoca, CONSERVANDO el contrato técnico de cada formato:
 *
 *   - codificación CP1252;
 *   - terminadores CRLF, sin LF sueltos;
 *   - 130 caracteres por línea en HY3 (128 de contenido + 2 de checksum);
 *   - anchos y posiciones de campo exactos;
 *   - estructura y orden de los registros;
 *   - checksums recalculados con `computeHy3Checksum`, el MISMO algoritmo
 *     que usa la producción: no se reimplementa aquí.
 *
 * Es idempotente: sobre datos ya sintéticos produce el mismo resultado.
 *
 * Uso:  node backend/scripts/anonimizar-fixtures.mjs [--verificar]
 *       `--verificar` no escribe: solo comprueba que los archivos ya están
 *       anonimizados y que sus checksums son válidos.
 */
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(AQUI, "..", "tests", "fixtures");
const SOLO_VERIFICAR = process.argv.includes("--verificar");

/* El checksum se toma del módulo de producción, transpilado al vuelo, para que
   no exista una segunda implementación que pueda divergir. */
const require = createRequire(import.meta.url);
require("tsx/cjs");
const { computeHy3Checksum, HY3_CONTENT_LENGTH, HY3_LINE_LENGTH } = require(
  path.join(AQUI, "..", "src", "modules", "team-manager-export", "hy3-checksum.ts"),
);
/* El formateador de tiempos tambien sale de produccion: las marcas sinteticas
   se escriben con la MISMA funcion que usa el exportador. */
const { formatHy3Time_SecondsComma } = require(
  path.join(AQUI, "..", "src", "modules", "team-manager-export", "hy3-writer.ts"),
);

// ---------------------------------------------------------------------------
//  IDENTIDAD SINTÉTICA
// ---------------------------------------------------------------------------
/* Apellidos del alfabeto fonético y de un vocabulario de objetos y plantas:
   no son apellidos de personas y sus primeros CINCO caracteres son distintos
   entre sí, que es lo que exigen los registros E1 y F3 (abreviatura de 5).

   Dos de los tres primeros llevan ACENTO a propósito. Los datos reales tenían
   caracteres fuera de ASCII y eran lo que obligaba a leer estos archivos como
   CP1252; con un vocabulario puramente ASCII esa ruta dejaría de ejercitarse y
   la anonimización habría debilitado la cobertura en silencio. */
const APELLIDOS = [
  "Álamo", "Bravo", "Ñandú", "Delta", "Eco", "Foxtrot", "Golf", "Hotel",
  "India", "Julieta", "Kilo", "Lima", "Mike", "Noviembre", "Oscar", "Papa",
  "Quebec", "Romeo", "Sierra", "Tango", "Uniforme", "Victor", "Whisky",
  "Xray", "Yanqui", "Zulu", "Ambar", "Bosque", "Cobre", "Duna", "Ermita",
  "Fresno", "Granate", "Helecho", "Islote", "Jade",
];

const CLUB_CODIGO = "SINT";
const CLUB_NOMBRE = "Club Sintético de Pruebas";
const SEDE = "sint";
const COMPETENCIA = "Competencia Sintética de Pruebas";

/* ---------------------------------------------------------------------------
   METADATOS DE LA COMPETENCIA

   Las marcas y las fechas del evento real se sustituyen aunque ya no haya
   nombres: un tiempo, una distancia y una fecha, cruzados contra resultados
   publicados, vuelven a señalar a una persona. Todo lo que sigue proviene de
   un año reservado (2030) y de un cálculo determinista, no del archivo.
--------------------------------------------------------------------------- */
const ANIO_SINTETICO = 2030;
const FECHA_INICIO = "01012030";   // MMDDYYYY, el formato de Hy-Tek
const FECHA_FIN = "01022030";
const FECHA_CORTE = "12312030";
const FECHA_GENERACION = "01032030";
const HORA_GENERACION = "9:00 AM ";  // 8 caracteres, como el campo
const HORAS_SESION = ["09:00AM", "11:00AM", "02:00PM", "04:00PM"];

/* Segundos por metro segun el estilo. Producen marcas plausibles para una
   categoria master sin proceder de ninguna competencia. */
const RITMO = { A: 0.85, B: 0.95, C: 1.05, D: 0.9, E: 1.0 };

/** Marca sintetica, estable para la misma prueba y el mismo nadador. */
function marca(distancia, estilo, semilla) {
  const ritmo = RITMO[estilo] ?? 1.0;
  const base = Math.round(distancia * ritmo) + (semilla % 17);
  /* Uno de cada tres cae en segundos exactos -se escribe ",00"- y el resto
     lleva centesimas. Asi el fixture sigue ejercitando las dos precisiones que
     el formato admite, que es lo que hacia con los tiempos reales. */
  if (semilla % 3 === 0) return base;
  return Math.round((base + ((semilla * 29) % 100) / 100) * 100) / 100;
}

/* El apellido se asigna por ORDEN DE APARICIÓN dentro de cada archivo, no por
   el id. Asignarlo con `id % APELLIDOS.length` repetía apellidos dentro del
   mismo archivo, y las pruebas localizan líneas buscando el apellido: dos
   nadadores homónimos harían que `find` devolviese la línea equivocada. Con el
   rango, la unicidad está garantizada mientras el archivo tenga como mucho
   tantos nadadores como apellidos disponibles, y eso se comprueba. */
let cache = new Map();
function reiniciarIdentidades(idsEnOrden) {
  cache = new Map();
  if (idsEnOrden.length > APELLIDOS.length) {
    throw new Error(`el archivo tiene ${idsEnOrden.length} nadadores y solo hay ${APELLIDOS.length} apellidos sintéticos`);
  }
  idsEnOrden.forEach((id, rango) => identidad(id, rango));
}

/** Identidad estable para un id de nadador: misma entrada, misma salida. */
function identidad(idCrudo, rangoSugerido) {
  const id = String(idCrudo).trim();
  if (cache.has(id)) return cache.get(id);
  const rango = rangoSugerido !== undefined ? rangoSugerido : cache.size;
  const apellido = APELLIDOS[rango % APELLIDOS.length];
  const orden = String(rango + 1).padStart(2, "0");
  /* El RUN sintético conserva las TRES formas que las pruebas ejercitan: ocho
     dígitos con verificador numérico, siete dígitos, y terminado en K. Se
     reparten por RANGO -no por id- para que los tres primeros nadadores de
     cada archivo cubran las tres formas y ninguna variante quede sin prueba. */
  const forma = rango % 3;
  let run;
  if (forma === 0) run = `${10000000 + rango}-${(rango + 1) % 10}`;
  else if (forma === 1) run = `${1000000 + rango}-${(rango + 3) % 10}`;
  else run = `${10000000 + rango}-K`;
  const anioNacimiento = 1970 + (rango % 30);
  const valor = {
    rango,
    apellido,
    nombre: `Persona${orden}`,
    run,
    // MMDDYYYY, el formato del propio Hy-Tek
    fecha: `${String((rango % 12) + 1).padStart(2, "0")}${String((rango % 28) + 1).padStart(2, "0")}${anioNacimiento}`,
    edad: String(2026 - anioNacimiento),
  };
  cache.set(id, valor);
  return valor;
}

// ---------------------------------------------------------------------------
//  UTILIDADES DE CAMPO
// ---------------------------------------------------------------------------
const derecha = (v, n) => String(v).slice(0, n).padEnd(n, " ");
const izquierda = (v, n) => String(v).slice(0, n).padStart(n, " ");

/** Reemplaza un tramo por un valor del ANCHO EXACTO; la longitud no cambia. */
function poner(linea, desde, ancho, valor) {
  if (valor.length !== ancho) throw new Error(`ancho ${valor.length} != ${ancho}`);
  return linea.slice(0, desde) + valor + linea.slice(desde + ancho);
}

// ---------------------------------------------------------------------------
//  TRANSFORMACIÓN DE UNA LÍNEA HY3
// ---------------------------------------------------------------------------
function anonimizarLineaHy3(linea) {
  let c = linea.slice(0, HY3_CONTENT_LENGTH);
  const tipo = c.slice(0, 2);

  if (tipo === "A1") {
    /* Fecha y hora en que el Team Manager real generó el archivo. */
    c = poner(c, 58, 8, FECHA_GENERACION);
    c = poner(c, 68, 8, HORA_GENERACION);
  } else if (tipo === "B1") {
    c = poner(c, 2, 45, derecha(COMPETENCIA, 45));
    c = poner(c, 47, 45, derecha(SEDE, 45));
    /* Inicio, fin y corte de edad de la competencia real. */
    c = poner(c, 92, 8, FECHA_INICIO);
    c = poner(c, 100, 8, FECHA_FIN);
    c = poner(c, 108, 8, FECHA_CORTE);
  } else if (tipo === "C1") {
    c = poner(c, 2, 5, derecha(CLUB_CODIGO, 5));
    c = poner(c, 7, 112, derecha(CLUB_NOMBRE, 112));
  } else if (tipo === "D1") {
    const yo = identidad(c.slice(5, 8));
    c = poner(c, 8, 20, derecha(yo.apellido, 20));
    c = poner(c, 28, 20, derecha(yo.nombre, 20));
    c = poner(c, 65, 14, izquierda(yo.run, 14));
    c = poner(c, 88, 8, yo.fecha);
    c = poner(c, 97, 2, izquierda(yo.edad, 2));
  } else if (tipo === "E1") {
    const yo = identidad(c.slice(5, 8));
    c = poner(c, 8, 5, derecha(yo.apellido, 5));
    /* La marca de referencia del nadador en esa prueba. */
    const distancia = Number(c.slice(15, 21).trim());
    const estilo = c[21];
    const segundos = marca(distancia, estilo, yo.rango + distancia);
    c = poner(c, 51, 8, izquierda(formatHy3Time_SecondsComma(segundos), 8));
  } else if (tipo === "F1") {
    c = poner(c, 2, 5, derecha(CLUB_CODIGO, 5));
    /* Un relevo SIN marca se escribe "0.00" con punto decimal: eso no es un
       dato del evento, es la ausencia de uno, y se conserva tal cual porque
       las pruebas distinguen las dos formas. */
    const actual = c.slice(51, 59).trim();
    if (actual !== "0.00") {
      const distancia = Number(c.slice(18, 21).trim());
      const estilo = c[21];
      const relevoId = Number(c.slice(9, 12).trim()) || 0;
      const segundos = marca(distancia, estilo, relevoId % 23);
      c = poner(c, 51, 8, izquierda(formatHy3Time_SecondsComma(segundos), 8));
    }
  } else if (tipo === "F3") {
    for (let k = 0; k < 4; k++) {
      const base = 2 + k * 13;
      const yo = identidad(c.slice(base + 3, base + 6));
      c = poner(c, base + 6, 5, derecha(yo.apellido, 5));
    }
  }

  if (c.length !== HY3_CONTENT_LENGTH) throw new Error("el contenido cambió de largo");
  return c + computeHy3Checksum(c);
}

function anonimizarHy3(ruta) {
  const crudo = fs.readFileSync(ruta, "latin1");
  const lineas = crudo.split("\r\n");
  const finalVacio = lineas[lineas.length - 1] === "";
  const datos = finalVacio ? lineas.slice(0, -1) : lineas;

  /* Primero los D1, en su orden real, para fijar el rango de cada nadador; los
     E1 y F3 que vengan después reutilizan esa misma identidad. */
  const idsD1 = [];
  for (const l of datos) {
    if (l.startsWith("D1")) {
      const id = l.slice(5, 8).trim();
      if (!idsD1.includes(id)) idsD1.push(id);
    }
  }
  reiniciarIdentidades(idsD1);

  const salida = datos.map((l, i) => {
    if (l.length !== HY3_LINE_LENGTH) {
      throw new Error(`${path.basename(ruta)} línea ${i + 1}: largo ${l.length} != ${HY3_LINE_LENGTH}`);
    }
    return anonimizarLineaHy3(l);
  });

  const texto = salida.join("\r\n") + (finalVacio ? "\r\n" : "");
  if (!SOLO_VERIFICAR) fs.writeFileSync(ruta, Buffer.from(texto, "latin1"));
  return { lineas: salida.length, bytes: Buffer.from(texto, "latin1").length };
}

// ---------------------------------------------------------------------------
//  TRANSFORMACIÓN DEL EV3
// ---------------------------------------------------------------------------
/* El .ev3 es el PROGRAMA de pruebas: no contiene nadadores. Pero sí contiene
   metadatos del evento real, y más de los que saltan a la vista: SIETE campos
   de fecha en el encabezado (no tres) y nueve campos de texto que el parser no
   lee y que pueden guardar sede, organizador u operador.

   Se sustituyen todos. Los códigos de una o dos letras de las líneas de prueba
   —individual/relevo, género, estilo— son gramática del formato, no metadatos,
   y se conservan intactos porque son justo lo que las pruebas ejercitan. */
const EV3_CAMPOS_FECHA = [2, 3, 4, 12, 16, 23, 33];
const EV3_CAMPOS_TEXTO = [1, 9, 10, 11, 24, 26, 28, 29];
const EV3_FECHAS = {
  2: `01/01/${ANIO_SINTETICO}`,
  3: `01/02/${ANIO_SINTETICO}`,
  4: `12/31/${ANIO_SINTETICO}`,
};
const EV3_CAMPO_HORA_SESION = 24; // en las líneas de prueba, no en el encabezado

function anonimizarEv3(ruta) {
  const crudo = fs.readFileSync(ruta, "latin1");
  const lineas = crudo.split("\r\n");

  // --- encabezado ---
  const cab = lineas[0].split(";");
  cab[0] = COMPETENCIA;
  for (const i of EV3_CAMPOS_FECHA) {
    if (cab[i] === undefined) continue;
    cab[i] = EV3_FECHAS[i] ?? `06/15/${ANIO_SINTETICO}`;
  }
  for (const i of EV3_CAMPOS_TEXTO) {
    if (cab[i] === undefined) continue;
    /* Se conserva el LARGO del campo: el formato es de ancho variable, pero un
       cambio de longitud aquí no aportaría nada y sí podría sorprender. */
    cab[i] = derecha(`sintetico-${i}`, cab[i].length);
  }
  lineas[0] = cab.join(";");

  // --- líneas de prueba: solo la hora de sesión ---
  for (let i = 1; i < lineas.length; i++) {
    if (!lineas[i].trim()) continue;
    const cierre = lineas[i].endsWith("*>") ? "*>" : "";
    const campos = lineas[i].replace(/\*>$/, "").split(";");
    if (campos[EV3_CAMPO_HORA_SESION] !== undefined && campos[EV3_CAMPO_HORA_SESION].trim()) {
      campos[EV3_CAMPO_HORA_SESION] = HORAS_SESION[(i - 1) % HORAS_SESION.length];
    }
    lineas[i] = campos.join(";") + cierre;
  }

  const texto = lineas.join("\r\n");
  if (!SOLO_VERIFICAR) fs.writeFileSync(ruta, Buffer.from(texto, "latin1"));
  return { lineas: lineas.filter((l) => l.trim()).length, bytes: Buffer.from(texto, "latin1").length };
}

// ---------------------------------------------------------------------------
const NL = String.fromCharCode(10);
let salida = "";
const mapas = [];
for (const nombre of ["sample.hy3", "sample-with-relays.hy3"]) {
  const r = anonimizarHy3(path.join(FIXTURES, nombre));
  salida += `  ${nombre.padEnd(26)} ${r.lineas} lineas, ${r.bytes} bytes${NL}`;
  mapas.push([nombre, [...cache.entries()]]);
}
const e = anonimizarEv3(path.join(FIXTURES, "sample.ev3"));
salida += `  ${"sample.ev3".padEnd(26)} ${e.lineas} lineas, ${e.bytes} bytes${NL}`;

process.stdout.write((SOLO_VERIFICAR ? "VERIFICACION (no se escribio nada)" : "ANONIMIZACION APLICADA") + NL + salida);

/* La tabla de identidades sintéticas usadas, para poder actualizar las pruebas
   sin volver a mirar los archivos. Solo contiene valores inventados. */
if (process.argv.includes("--mapa")) {
  for (const [nombre, entradas] of mapas) {
    process.stdout.write(NL + "MAPA DE IDENTIDADES SINTETICAS — " + nombre + NL);
    for (const [id, v] of entradas.sort((a, b) => Number(a[0]) - Number(b[0]))) {
      process.stdout.write(`  ${id.padStart(3)}  ${v.apellido.padEnd(10)} ${v.nombre.padEnd(10)} ${v.run.padEnd(12)} ${v.fecha} edad ${v.edad}${NL}`);
    }
  }
}
