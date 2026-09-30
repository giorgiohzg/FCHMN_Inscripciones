/**
 * Genera los fixtures sintéticos de importación derivados de `sample.ev3`.
 *
 * Se generan con un guion en vez de escribirlos a mano por la misma razón que
 * el anonimizador: el formato exige CRLF y CP1252, y un editor los cambia sin
 * avisar. Derivarlos del fixture ya anonimizado garantiza además que no
 * aparezca ningún dato real por la puerta de atrás.
 *
 *   sample-multiday.ev3          competencia de TRES días, sin asignación por día
 *   sample-meet-events.hyv       copia byte a byte del .ev3 con otra extensión
 *   sample-no-importable.hyv     contenido binario que debe rechazarse
 *   sample-hyv-nativo.hyv        gramática PROPIA del .hyv, un día
 *   sample-hyv-nativo-multiday.hyv  la misma, en DOS días
 *
 * Los dos últimos se traducen campo a campo desde `sample.ev3` en vez de
 * escribirse a mano, y eso tiene dos consecuencias que importan:
 *
 *   1. Describen la MISMA competencia que el `.ev3`, así que una prueba puede
 *      importar los dos archivos y exigir que produzcan las mismas pruebas.
 *      Es la forma de detectar que un parser se desvíe del otro.
 *   2. Derivan de un fixture ya anonimizado, así que no puede colarse ningún
 *      dato real por la puerta de atrás. Los archivos `.hyv` y `.ev3` reales
 *      con los que se decodificó el formato NO están en el repositorio y no
 *      deben incorporarse: llevan el nombre de un evento y un recinto reales.
 *
 * Uso: node backend/scripts/generar-fixtures-importacion.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(AQUI, "..", "tests", "fixtures");
const NL = String.fromCharCode(10);

const base = fs.readFileSync(path.join(FIXTURES, "sample.ev3"), "latin1");
const lineas = base.split("\r\n");

// --- 1. variante de TRES días -------------------------------------------
// Solo se mueve la fecha de FIN del encabezado (campo [3]); las líneas de
// prueba quedan igual, porque el formato .ev3 no dice a qué día va cada una:
// eso es justo lo que el fixture tiene que representar.
const cab = lineas[0].split(";");
if (cab[2] !== "01/01/2030") throw new Error("el fixture base cambió: se esperaba inicio 01/01/2030");
cab[3] = "01/03/2030";
const multiday = [cab.join(";"), ...lineas.slice(1)].join("\r\n");
fs.writeFileSync(path.join(FIXTURES, "sample-multiday.ev3"), Buffer.from(multiday, "latin1"));

// --- 2. .hyv con contenido COMPATIBLE ------------------------------------
// Mismo contenido que el .ev3, otra extensión: es el caso que demuestra que
// el importador se reutiliza por contenido y no por nombre.
fs.copyFileSync(path.join(FIXTURES, "sample.ev3"), path.join(FIXTURES, "sample-meet-events.hyv"));

// --- 3. .hyv NO importable ------------------------------------------------
// Bytes de control y un 0x00 al principio: ni ZIP ni texto .ev3. Sirve para
// probar que la extensión admitida no basta para que un archivo se acepte.
const basura = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x10, 0x7f, 0x00, 0x42, 0x00, 0x99, 0x00, 0x13, 0x37, 0x00, 0x01, 0x02, 0x03, 0x04]);
fs.writeFileSync(path.join(FIXTURES, "sample-no-importable.hyv"), basura);

// --- 4. .hyv con la gramática PROPIA del formato --------------------------
// Traducción campo a campo desde el .ev3, según lo verificado alineando un
// .hyv real con el .ev3 del mismo evento (ver `hyv-parser.ts`).
const ESTILO_EV3_A_HYV = { A: "1", B: "2", C: "3", D: "4", E: "5" };
const GENERO_EV3_A_HYV = { W: "F", M: "M" };

function lineaDePruebaHyv(lineaEv3) {
  const c = lineaEv3.replace(/\*>$/, "").split(";");
  const [numero, tipo, generoEv3, distancia, estiloEv3] = [c[0], c[4], c[5], c[8], c[9]];

  const genero = GENERO_EV3_A_HYV[generoEv3];
  const estilo = ESTILO_EV3_A_HYV[estiloEv3];
  if (!genero) throw new Error(`género .ev3 sin traducción a .hyv: "${generoEv3}" (prueba ${numero})`);
  if (!estilo) throw new Error(`estilo .ev3 sin traducción a .hyv: "${estiloEv3}" (prueba ${numero})`);
  if (tipo !== "I" && tipo !== "R") throw new Error(`tipo .ev3 inesperado: "${tipo}" (prueba ${numero})`);

  //  [0]     [1]  [2]     [3]   [4] [5]    [6]        [7]   [8][9][10] [11] [12..17]
  return [numero, "F", genero, tipo, "0", "0", distancia, estilo, "", "", "", "0", "", "", "", "", "", ""].join(";");
}

function archivoHyv(fechaFin) {
  const c = cabeceraOriginal;
  const cabecera = [
    c[0], // nombre
    c[2], // inicio
    fechaFin, // fin
    c[4], // corte de edad
    "S", // código de una letra, sin identificar
    c[1], // recinto
    "",
    "Hy-Tek Sports Software",
    "7.0Gb", // única versión verificada
    "CN", // código de dos letras, sin identificar
    "0000I", // serie/suma de control sintética: el parser no la valida
  ].join(";");
  return [cabecera, ...lineas.slice(1).filter((l) => l.trim()).map(lineaDePruebaHyv), ""].join("\r\n");
}

const cabeceraOriginal = lineas[0].split(";");
const hyvUnDia = archivoHyv(cabeceraOriginal[3]); // 01/01/2030, mismo día
const hyvDosDias = archivoHyv("01/02/2030");

// Comprobación de lo generado ANTES de escribirlo: un fixture que no cumpla
// la gramática haría fallar las pruebas de integración con un error que no
// señalaría hacia aquí.
for (const [nombre, contenido] of [["sample-hyv-nativo.hyv", hyvUnDia], ["sample-hyv-nativo-multiday.hyv", hyvDosDias]]) {
  const ls = contenido.split("\r\n").filter((l) => l.trim());
  if (ls.some((l) => l.endsWith("*>"))) throw new Error(`${nombre}: no debe llevar la marca *> del .ev3`);
  if (ls[0].split(";").length !== 11) throw new Error(`${nombre}: el encabezado debe tener 11 campos`);
  for (const [i, l] of ls.slice(1).entries()) {
    if (l.split(";").length !== 18) throw new Error(`${nombre}: la línea de prueba ${i + 1} debe tener 18 campos`);
  }
  if (ls.length !== lineas.filter((l) => l.trim()).length) throw new Error(`${nombre}: se perdieron pruebas en la traducción`);
}
// Las cinco letras de estilo tienen que estar representadas: si el fixture
// base cambiara y dejara de cubrirlas, las pruebas dejarían de verificar el
// mapa completo sin que nadie lo notara.
const estilosCubiertos = new Set(hyvUnDia.split("\r\n").filter((l) => l.trim()).slice(1).map((l) => l.split(";")[7]));
for (const codigo of ["1", "2", "3", "4", "5"]) {
  if (!estilosCubiertos.has(codigo)) throw new Error(`el fixture .hyv no cubre el código de estilo ${codigo}`);
}

fs.writeFileSync(path.join(FIXTURES, "sample-hyv-nativo.hyv"), Buffer.from(hyvUnDia, "latin1"));
fs.writeFileSync(path.join(FIXTURES, "sample-hyv-nativo-multiday.hyv"), Buffer.from(hyvDosDias, "latin1"));

// --- 5. .hyv con DOS RELEVOS GEMELOS --------------------------------------
// Dos relevos idénticos en distancia, estilo y género, y distinto número de
// prueba. Es el caso que obliga a decidir el tipo de relevo POR PRUEBA: si las
// decisiones se agruparan por la firma (distancia+estilo+género), estos dos
// quedarían fundidos en uno y a uno se le impondría la decisión del otro.
// Se obtiene igualando el estilo del relevo nº13 al del nº11.
const lineasGemelos = hyvUnDia.split("\r\n").filter((l) => l.trim());
const idx13 = lineasGemelos.findIndex((l) => l.split(";")[0] === "13");
const idx11 = lineasGemelos.findIndex((l) => l.split(";")[0] === "11");
if (idx13 < 0 || idx11 < 0) throw new Error("el fixture .hyv cambió: se esperaban las pruebas 11 y 13");
const campos13 = lineasGemelos[idx13].split(";");
const campos11 = lineasGemelos[idx11].split(";");
campos13[7] = campos11[7]; // mismo estilo
campos13[6] = campos11[6]; // misma distancia
campos13[2] = campos11[2]; // mismo género
lineasGemelos[idx13] = campos13.join(";");
const hyvGemelos = [...lineasGemelos, ""].join("\r\n");

// El fixture no sirve para nada si los dos relevos no quedaron realmente
// idénticos, así que se comprueba en vez de confiar en el recorte de arriba.
const clave = (l) => {
  const c = l.split(";");
  return `${c[2]}|${c[3]}|${c[6]}|${c[7]}`;
};
if (clave(lineasGemelos[idx11]) !== clave(lineasGemelos[idx13])) {
  throw new Error("los relevos 11 y 13 no quedaron idénticos en género, tipo, distancia y estilo");
}
if (lineasGemelos[idx11].split(";")[3] !== "R" || lineasGemelos[idx13].split(";")[3] !== "R") {
  throw new Error("las pruebas 11 y 13 deben ser relevos");
}
fs.writeFileSync(path.join(FIXTURES, "sample-hyv-relevos-gemelos.hyv"), Buffer.from(hyvGemelos, "latin1"));

// El tamaño se lee del archivo ya escrito, no de la variable en memoria: así
// el informe refleja lo que quedó en disco, que es lo que usarán las pruebas.
const generados = [
  "sample-multiday.ev3",
  "sample-meet-events.hyv",
  "sample-no-importable.hyv",
  "sample-hyv-nativo.hyv",
  "sample-hyv-nativo-multiday.hyv",
  "sample-hyv-relevos-gemelos.hyv",
];
process.stdout.write("FIXTURES DE IMPORTACION GENERADOS" + NL);
for (const nombre of generados) {
  const ruta = path.join(FIXTURES, nombre);
  process.stdout.write("  " + nombre.padEnd(34) + " " + fs.statSync(ruta).size + " bytes" + NL);
}
