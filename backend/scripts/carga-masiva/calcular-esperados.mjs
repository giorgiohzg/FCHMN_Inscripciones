// =============================================================================
// ESPERADOS DE UNA CARGA MASIVA — calculados desde las planillas aprobadas
//
// No se conecta a nada: lee los tres .xlsx que declara el manifiesto y escribe
// por pantalla lo que la base de datos debe contener cuando la carga termine.
//
// Existe para que los números con los que se verifica una carga no sean la
// afirmación de nadie, sino algo reproducible: cualquiera lo ejecuta sobre las
// mismas planillas y obtiene los mismos.
//
//   node backend/scripts/carga-masiva/calcular-esperados.mjs \
//        --manifiesto <ruta/manifiesto.json> [--por-club]
//
// -----------------------------------------------------------------------------
// LA HUELLA DE CORRESPONDENCIA, Y POR QUÉ ES UNA SUMA
//
// Comprueba la CORRESPONDENCIA entre cada persona y su club, no solo los
// totales: dos nadadores intercambiados entre dos clubes dejan los conteos por
// club idénticos y la huella distinta.
//
//     clave  = RUN normalizado  +  "|"  +  sigla del club en mayúsculas
//     valor  = primeros 4 bytes del md5(clave), en orden little-endian
//     huella = SUMA de los valores de todas las membresías esperadas
//
// La suma es a propósito: sumar no depende del orden, así que la huella no
// depende de la colación de la base ni del orden de las filas. Un md5 sobre una
// concatenación ordenada sí dependería, y una colación distinta en el servidor
// daría una diferencia falsa.
//
// El SQL que la calcula del otro lado está en `docs/operacion/verificacion-por-sql.md`.
//
// NOTA SOBRE LO QUE ESTA HUELLA REVELA. Para un club con un solo nadador, el
// valor es el de su única clave, y 4 bytes de md5 son pocos: alguien con las
// siglas y fuerza bruta podría recuperar ese RUN. No es un identificador
// opaco. Trátela como dato interno, igual que las planillas de las que sale.
// =============================================================================

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import ExcelJS from "exceljs";

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

function argumento(nombre, porOmision) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : porOmision;
}

function morir(mensaje, detalle) {
  console.error(`DETENIDO: ${mensaje}`);
  if (detalle !== undefined) console.error(`  ${typeof detalle === "string" ? detalle : JSON.stringify(detalle)}`);
  process.exit(2);
}

// --- manifiesto ---------------------------------------------------------------

const rutaManifiesto = argumento("manifiesto");
if (!rutaManifiesto) morir("Falta --manifiesto");
const absoluta = path.resolve(rutaManifiesto);
if (!fs.existsSync(absoluta)) morir(`No existe el manifiesto ${absoluta}`);

let manifiesto;
try {
  manifiesto = JSON.parse(fs.readFileSync(absoluta, "utf8"));
} catch (e) {
  morir("El manifiesto no es JSON válido", e.message);
}
if (!FECHA_ISO.test(String(manifiesto.fechaEfectiva ?? ""))) {
  morir("El manifiesto no declara una fechaEfectiva con forma AAAA-MM-DD");
}

const DIR = path.resolve(path.dirname(absoluta), manifiesto.directorioDePlanillas ?? ".");
const planilla = (clave) => {
  const p = manifiesto.planillas?.[clave];
  if (!p?.archivo || !p?.hoja) morir(`El manifiesto no declara la planilla «${clave}» con archivo y hoja`);
  return p;
};

// --- lectura ------------------------------------------------------------------

const normRun = (v) => String(v ?? "").trim().replace(/[.\-\s]/g, "").toUpperCase();
const normSigla = (v) => String(v ?? "").trim().toUpperCase();

/** Igual que en SQL: `get_byte(decode(md5(k),'hex'), 0..3)` en little-endian. */
function valorDeClave(k) {
  const b = crypto.createHash("md5").update(k, "utf8").digest();
  return BigInt(b[0]) + BigInt(b[1]) * 256n + BigInt(b[2]) * 65536n + BigInt(b[3]) * 16777216n;
}

function texto(celda) {
  const v = celda?.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (v.text !== undefined) return String(v.text);
    if (v.result !== undefined) return String(v.result);
    if (v.richText) return v.richText.map((t) => t.text).join("");
    return String(v);
  }
  return String(v);
}

async function hoja(clave) {
  const p = planilla(clave);
  const ruta = path.join(DIR, p.archivo);
  if (!fs.existsSync(ruta)) morir(`Falta la planilla de ${clave}: ${ruta}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(ruta);
  const h = wb.getWorksheet(p.hoja);
  if (!h) morir(`${p.archivo} no tiene la hoja «${p.hoja}»`);
  return h;
}

/** Las mismas columnas que lee el cargador. Si cambian, cambian en los dos. */
const clubes = [];
(await hoja("clubes")).eachRow((fila, n) => {
  if (n === 1) return;
  const c = (i) => texto(fila.getCell(i)).trim();
  if (!c(2)) return;
  clubes.push({ nombre: c(2), sigla: c(3), username: c(4) });
});

const personas = [];
(await hoja("personas")).eachRow((fila, n) => {
  if (n === 1) return;
  const c = (i) => texto(fila.getCell(i)).trim();
  if (!c(1)) return;
  personas.push({ run: c(1), username: c(2) });
});

const asignaciones = [];
(await hoja("asignaciones")).eachRow((fila, n) => {
  if (n === 1) return;
  const c = (i) => texto(fila.getCell(i)).trim();
  if (!c(3)) return;
  asignaciones.push({ run: c(2), username: c(3), sigla: c(5) });
});

// --- huella y conteos por club ------------------------------------------------

let huella = 0n;
const porClub = new Map();
const siglasDeClubes = new Set(clubes.map((c) => normSigla(c.sigla)));
const problemas = [];

for (const a of asignaciones) {
  const sigla = normSigla(a.sigla);
  if (!siglasDeClubes.has(sigla)) problemas.push(`la sigla ${sigla} no está en la planilla de clubes`);
  const v = valorDeClave(normRun(a.run) + "|" + sigla);
  huella += v;
  const p = porClub.get(sigla) ?? { n: 0, suma: 0n };
  p.n += 1;
  p.suma += v;
  porClub.set(sigla, p);
}

const runsUnicos = new Set(asignaciones.map((a) => normRun(a.run)));
const sinNadadores = [...siglasDeClubes].filter((s) => !porClub.has(s)).sort();

// Si el manifiesto declara totales, se contrastan: un desajuste aquí significa
// que el manifiesto y las planillas no hablan de la misma carga.
const declarados = manifiesto.totales ?? {};
const contraste = {};
for (const [clave, real] of [
  ["clubes", clubes.length],
  ["personas", personas.length],
  ["asignaciones", asignaciones.length],
  ["clubesConNadadores", porClub.size],
]) {
  if (declarados[clave] !== undefined) {
    contraste[clave] = { enElManifiesto: declarados[clave], enLasPlanillas: real, coincide: declarados[clave] === real };
    if (declarados[clave] !== real) problemas.push(`el manifiesto declara ${declarados[clave]} ${clave} y las planillas traen ${real}`);
  }
}

console.log(
  JSON.stringify(
    {
      manifiesto: absoluta,
      fechaEfectivaEsperada: manifiesto.fechaEfectiva,
      planillas: { clubes: clubes.length, personas: personas.length, asignaciones: asignaciones.length },
      contrasteConElManifiesto: contraste,
      esperadoEnLaBase: {
        clubes: clubes.length,
        clubes_pendientes_de_personalidad: clubes.length,
        personas: personas.length,
        membresias_activas: asignaciones.length,
        roles_de_nadador_activos: asignaciones.length,
        cargos_de_club: 0,
        cuentas_de_acceso_nuevas: 0,
        reservas_de_nombre_nuevas: clubes.length + personas.length,
        asientos_de_auditoria_de_la_carga: clubes.length + personas.length + asignaciones.length,
      },
      correspondencia: {
        huella_global: huella.toString(),
        runs_distintos: runsUnicos.size,
        clubes_con_nadadores: porClub.size,
        clubes_sin_nadadores: sinNadadores.length,
        siglas_sin_nadadores: sinNadadores,
      },
      problemas,
    },
    null,
    1
  )
);

// La lista por club sale solo si se pide: es la que sirve para localizar un
// descuadre, y también la que más revela.
if (process.argv.includes("--por-club")) {
  console.log("\n--- conteo y huella por club (sigla:n:suma) ---");
  console.log(
    [...porClub.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([s, v]) => `${s}:${v.n}:${v.suma}`)
      .join("\n")
  );
}

if (problemas.length) {
  console.error("\nPROBLEMAS:");
  for (const p of problemas) console.error("  " + p);
  process.exitCode = 2;
}
