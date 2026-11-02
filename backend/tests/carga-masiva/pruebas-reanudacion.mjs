// =============================================================================
// PRUEBAS DEL CARGADOR — cortes, diferencias, caducidad y límite de solicitudes
//
//   node backend/tests/carga-masiva/pruebas-reanudacion.mjs --manifiesto <ruta> [caso]
//
// Levanta la API simulada con una situación provocada, ejecuta el cargador y
// comprueba el CÓDIGO DE SALIDA, lo que quedó en la API y lo que quedó en los
// archivos de resultados.
//
// NO TOCA NADA DE NADIE: la API es un proceso local en 127.0.0.1 con el estado
// en memoria, los datos son las planillas SINTÉTICAS que genera
// `generar-planillas-sinteticas.mjs`, y los resultados van a una carpeta
// temporal que se borra al terminar. Sin base de datos y sin red.
//
// Sin `--manifiesto` genera las planillas sintéticas y usa las suyas.
// =============================================================================

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "node:buffer";
import { setTimeout as programar, clearTimeout as cancelar } from "node:timers";
import ExcelJS from "exceljs";
import { generarPlanillasSinteticas } from "./generar-planillas-sinteticas.mjs";

// Global de Node desde la 18; se toma de `globalThis` para que el linter no
// tenga que adivinar de dónde viene en un `.mjs`.
const { fetch } = globalThis;

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CARGADOR = path.join(DIR, "..", "..", "scripts", "carga-masiva", "cargar.mjs");
const SIMULADA = path.join(DIR, "api-simulada.mjs");

function argumento(nombre) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

// --- el manifiesto manda: totales, fecha y planillas -------------------------

let MANIFIESTO_RUTA = argumento("manifiesto");
let temporalDeLasPlanillas = null;
if (!MANIFIESTO_RUTA) {
  const g = await generarPlanillasSinteticas();
  MANIFIESTO_RUTA = g.rutaManifiesto;
  temporalDeLasPlanillas = g.carpeta;
}
MANIFIESTO_RUTA = path.resolve(MANIFIESTO_RUTA);
const MANIFIESTO = JSON.parse(fs.readFileSync(MANIFIESTO_RUTA, "utf8"));
const T = MANIFIESTO.totales;
const FECHA = MANIFIESTO.fechaEfectiva;
const DIR_PLANILLAS = path.resolve(path.dirname(MANIFIESTO_RUTA), MANIFIESTO.directorioDePlanillas ?? ".");

/** El club donde se corta la etapa 1, y la fila de persona que se altera. */
const CORTE = Math.max(2, Math.min(5, T.clubes));
const FILA_DISTINTA = Math.min(7, T.personas + 1);

// --- datos de referencia para construir los casos ---------------------------

async function columna(clave, indice) {
  const p = MANIFIESTO.planillas[clave];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(DIR_PLANILLAS, p.archivo));
  const valores = [];
  wb.getWorksheet(p.hoja).eachRow((f, n) => {
    if (n === 1) return;
    const v = String(f.getCell(indice).value ?? "").trim();
    if (v) valores.push(v);
  });
  return valores;
}

async function referencias() {
  const siglasDeClubes = await columna("clubes", 3);
  const siglasAsignadas = await columna("asignaciones", 5);
  return { primerClub: siglasDeClubes[0], siglaConNadadores: siglasAsignadas[0] };
}

// --- utilidades --------------------------------------------------------------

function levantarSimulada(env) {
  return new Promise((ok, mal) => {
    const p = spawn(process.execPath, [SIMULADA], {
      env: { ...process.env, SIM_MANIFIESTO: MANIFIESTO_RUTA, ...env },
    });
    let salida = "";
    // El temporizador de arranque se CANCELA al conocer el puerto. Antes no se
    // cancelaba, y un temporizador de 60 s pendiente mantiene vivo el bucle de
    // eventos de Node: cada caso tardaba 61 segundos en terminar aunque sus
    // comprobaciones hubieran acabado en dos. Medido al portar esta batería.
    const vigilante = programar(() => mal(new Error("la API simulada no arrancó en 60 s")), 60000);
    p.stdout.on("data", (d) => {
      salida += d;
      const m = /PUERTO=(\d+)/.exec(salida);
      if (m) {
        cancelar(vigilante);
        ok({ proceso: p, puerto: Number(m[1]) });
      }
    });
    p.stderr.on("data", () => {});
    p.on("exit", (c) => {
      cancelar(vigilante);
      mal(new Error(`la API simulada terminó con ${c}`));
    });
  });
}

/**
 * Ejecuta el cargador. Si los argumentos piden `--confirmar`, añade la segunda
 * llave de la fecha: el cargador la exige para escribir y una prueba no debe
 * sortear la guarda que prueba.
 */
function correrCargador(puerto, salida, args) {
  const llaves = args.includes("--confirmar") ? ["--fecha-efectiva", FECHA] : [];
  return new Promise((ok) => {
    const p = spawn(process.execPath, [CARGADOR, "--manifiesto", MANIFIESTO_RUTA, "--salida", salida, ...args, ...llaves], {
      env: { ...process.env, API_BASE: `http://127.0.0.1:${puerto}/api`, CARGA_USUARIO: "operador.prueba", CARGA_CLAVE: "clave-de-prueba" },
    });
    let texto = "";
    p.stdout.on("data", (d) => (texto += d));
    p.stderr.on("data", (d) => (texto += d));
    p.on("close", (codigo) => ok({ codigo, texto }));
  });
}

const estadoDe = (puerto) => fetch(`http://127.0.0.1:${puerto}/api/__estado`).then((r) => r.json());

function leerJsonl(ruta) {
  if (!fs.existsSync(ruta)) return [];
  return fs.readFileSync(ruta, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const resultados = [];
function comprobar(caso, condicion, detalle) {
  resultados.push({ caso, bien: Boolean(condicion), detalle });
  console.log(`${condicion ? "bien " : "MAL  "} ${caso}${detalle ? `   — ${detalle}` : ""}`);
}

function carpetaTemporal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "carga-prueba-"));
}

// --- los casos ---------------------------------------------------------------

async function caso1_corteTrasGuardar() {
  const nombre = "1. corte tras guardar, antes de registrar";
  console.log(`\n=== ${nombre}`);
  // La API simulada corta la conexión en el POST nº CORTE, ya guardado.
  const { proceso, puerto } = await levantarSimulada({ SIM_CORTE_EN: String(CORTE) });
  const salida = carpetaTemporal();
  try {
    const a = await correrCargador(puerto, salida, ["--etapa", "1", "--confirmar"]);
    const tras = await estadoDe(puerto);
    comprobar(`${nombre}: la primera pasada se detiene`, a.codigo === 2, `código ${a.codigo}`);
    comprobar(`${nombre}: la API guardó los ${CORTE}`, tras.clubes === CORTE && tras.postsClubes === CORTE, `clubes=${tras.clubes}`);

    const jsonl = leerJsonl(path.join(salida, "etapa1_clubes.jsonl"));
    const anotados = jsonl.filter((r) => r.estado === "creado").length;
    comprobar(`${nombre}: el nº ${CORTE} NO quedó anotado localmente`, anotados === CORTE - 1, `anotados=${anotados} de ${CORTE} guardados`);

    // Segunda pasada, misma carpeta: tiene que conciliar el huérfano y acabar.
    const b = await correrCargador(puerto, salida, ["--etapa", "1", "--confirmar"]);
    const fin = await estadoDe(puerto);
    comprobar(`${nombre}: la segunda pasada termina bien`, b.codigo === 0, `código ${b.codigo}`);
    comprobar(`${nombre}: quedan ${T.clubes} clubes`, fin.clubes === T.clubes, `clubes=${fin.clubes}`);
    comprobar(`${nombre}: sin nombres de usuario duplicados`, fin.usuariosDuplicados === 0, `duplicados=${fin.usuariosDuplicados}`);
    comprobar(
      `${nombre}: el huérfano se concilió, no se duplicó`,
      b.texto.includes("releyendo para conciliar") || leerJsonl(path.join(salida, "etapa1_clubes.jsonl")).some((r) => r.estado === "ya_existia_conciliado"),
      "conciliado por lectura"
    );
  } finally {
    proceso.kill();
    fs.rmSync(salida, { recursive: true, force: true });
  }
}

async function caso2_clubDistinto(ref) {
  const nombre = "2a. club existente con datos distintos";
  console.log(`\n=== ${nombre}`);
  const { proceso, puerto } = await levantarSimulada({ SIM_CLUB_DISTINTO: ref.primerClub });
  const salida = carpetaTemporal();
  try {
    const r = await correrCargador(puerto, salida, ["--etapa", "1", "--confirmar"]);
    const fin = await estadoDe(puerto);
    comprobar(`${nombre}: se detiene`, r.codigo === 2, `código ${r.codigo}`);
    comprobar(`${nombre}: lo dice por el campo`, r.texto.includes("datos DISTINTOS") && r.texto.includes("email"), "nombra el campo email");
    comprobar(`${nombre}: no creó nada`, fin.clubes === 1 && fin.postsClubes === 0, `clubes=${fin.clubes}, posts=${fin.postsClubes}`);
    comprobar(`${nombre}: no sobrescribió`, !r.texto.includes("PATCH") && !r.texto.includes("PUT"), "ninguna escritura de corrección");
  } finally {
    proceso.kill();
    fs.rmSync(salida, { recursive: true, force: true });
  }
}

async function caso2b_personaDistinta() {
  const nombre = "2b. persona existente con otra fecha de nacimiento";
  console.log(`\n=== ${nombre}`);
  const { proceso, puerto } = await levantarSimulada({ SIM_SEMBRAR_CLUBES: String(T.clubes), SIM_PERSONA_DISTINTA: String(FILA_DISTINTA) });
  const salida = carpetaTemporal();
  try {
    const r = await correrCargador(puerto, salida, ["--etapa", "2", "--confirmar"]);
    const fin = await estadoDe(puerto);
    comprobar(`${nombre}: se detiene`, r.codigo === 2, `código ${r.codigo}`);
    comprobar(`${nombre}: nombra el campo`, r.texto.includes("birthDate"), "birthDate en las diferencias");
    comprobar(`${nombre}: no subió el importador`, fin.personas === 1, `personas=${fin.personas}`);
  } finally {
    proceso.kill();
    fs.rmSync(salida, { recursive: true, force: true });
  }
}

async function caso2c_membresia(ref) {
  for (const [variante, env, campo] of [
    ["2c. membresía activa en OTRO club", { SIM_MEMBRESIA_OTRO_CLUB: ref.siglaConNadadores }, "clubId"],
    ["2d. membresía con OTRA fecha efectiva", { SIM_MEMBRESIA_OTRA_FECHA: ref.siglaConNadadores }, "startDate"],
  ]) {
    console.log(`\n=== ${variante}`);
    const { proceso, puerto } = await levantarSimulada({ SIM_SEMBRAR_CLUBES: String(T.clubes), SIM_SEMBRAR_PERSONAS: String(T.personas), ...env });
    const salida = carpetaTemporal();
    try {
      const r = await correrCargador(puerto, salida, ["--etapa", "3", "--confirmar"]);
      comprobar(`${variante}: se detiene`, r.codigo === 2, `código ${r.codigo}`);
      comprobar(`${variante}: nombra el campo`, r.texto.includes(campo), `${campo} en las diferencias`);
    } finally {
      proceso.kill();
      fs.rmSync(salida, { recursive: true, force: true });
    }
  }
}

async function caso3_tokenVencido() {
  const nombre = "3. token vencido a mitad de etapa";
  console.log(`\n=== ${nombre}`);
  const { proceso, puerto } = await levantarSimulada({ SIM_TOKEN_VIDA: "9" });
  const salida = carpetaTemporal();
  try {
    const r = await correrCargador(puerto, salida, ["--etapa", "todas", "--confirmar"]);
    const fin = await estadoDe(puerto);
    const resumen = JSON.parse(fs.readFileSync(path.join(salida, "resumen.json"), "utf8"));
    comprobar(`${nombre}: termina bien`, r.codigo === 0, `código ${r.codigo}`);
    comprobar(`${nombre}: renovó el token`, resumen.renovacionesDeToken > 0, `renovaciones=${resumen.renovacionesDeToken}`);
    comprobar(
      `${nombre}: la carga quedó completa`,
      fin.clubes === T.clubes && fin.personas === T.personas && fin.membresias === T.asignaciones,
      JSON.stringify(fin).slice(0, 120)
    );
  } finally {
    proceso.kill();
    fs.rmSync(salida, { recursive: true, force: true });
  }
}

async function caso4_cargaLimpiaYFecha() {
  const nombre = "4. carga limpia de punta a punta";
  console.log(`\n=== ${nombre}`);
  const { proceso, puerto } = await levantarSimulada({});
  const salida = carpetaTemporal();
  try {
    const r = await correrCargador(puerto, salida, ["--etapa", "todas", "--confirmar"]);
    const fin = await estadoDe(puerto);
    comprobar(`${nombre}: termina bien`, r.codigo === 0, `código ${r.codigo}`);
    comprobar(
      `${nombre}: ${T.clubes} / ${T.personas} / ${T.asignaciones}`,
      fin.clubes === T.clubes && fin.personas === T.personas && fin.membresias === T.asignaciones,
      JSON.stringify(fin).slice(0, 120)
    );
    comprobar(
      `${nombre}: TODAS las membresías con fecha ${FECHA}`,
      fin.fechasDeMembresia.length === 1 && fin.fechasDeMembresia[0] === FECHA,
      `fechas=${fin.fechasDeMembresia.join(", ")}`
    );
    // Y repetir no duplica nada.
    const b = await correrCargador(puerto, salida, ["--etapa", "todas", "--confirmar"]);
    const fin2 = await estadoDe(puerto);
    comprobar(`${nombre}: repetir termina bien`, b.codigo === 0, `código ${b.codigo}`);
    comprobar(
      `${nombre}: repetir no duplica`,
      fin2.clubes === T.clubes && fin2.personas === T.personas && fin2.membresias === T.asignaciones,
      JSON.stringify(fin2).slice(0, 120)
    );
  } finally {
    proceso.kill();
    fs.rmSync(salida, { recursive: true, force: true });
  }
}

async function caso5_limiteConRetryAfter() {
  const nombre = "5. 429 con Retry-After: espera y recupera";
  console.log(`\n=== ${nombre}`);
  // Ventana corta y límite bajo para que la prueba no tarde un minuto por
  // espera. En la API real son 300 por minuto; aquí 8 por segundo, que con
  // cualquier tamaño de planilla fuerza varios 429 y los hace recuperables.
  const { proceso, puerto } = await levantarSimulada({ SIM_LIMITE_POR_MINUTO: "8", SIM_VENTANA_S: "1" });
  const salida = carpetaTemporal();
  try {
    const t = Date.now();
    const r = await correrCargador(puerto, salida, ["--etapa", "todas", "--confirmar"]);
    const segundos = Math.round((Date.now() - t) / 1000);
    const fin = await estadoDe(puerto);
    const resumen = JSON.parse(fs.readFileSync(path.join(salida, "resumen.json"), "utf8"));
    comprobar(`${nombre}: termina bien`, r.codigo === 0, `código ${r.codigo} en ${segundos} s`);
    comprobar(`${nombre}: el servidor limitó de verdad`, fin.limitadas > 0, `respuestas 429 = ${fin.limitadas}`);
    comprobar(`${nombre}: el cargador esperó`, resumen.esperasPorLimiteDeSolicitudes > 0, `esperas = ${resumen.esperasPorLimiteDeSolicitudes}`);
    comprobar(`${nombre}: respetó Retry-After`, r.texto.includes("esperando 1 s") || r.texto.includes("esperando 2 s"), "esperó los segundos que indicó el servidor");
    comprobar(
      `${nombre}: la carga quedó completa y sin duplicados`,
      fin.clubes === T.clubes && fin.personas === T.personas && fin.membresias === T.asignaciones && fin.usuariosDuplicados === 0,
      JSON.stringify(fin).slice(0, 130)
    );
    comprobar(
      `${nombre}: todas con fecha ${FECHA}`,
      fin.fechasDeMembresia.length === 1 && fin.fechasDeMembresia[0] === FECHA,
      `fechas=${fin.fechasDeMembresia.join(", ")}`
    );
    comprobar(`${nombre}: contó las solicitudes`, resumen.solicitudesTotales > 0, `solicitudes=${resumen.solicitudesTotales}, pico/min=${resumen.picoDeSolicitudesPorMinuto}`);
  } finally {
    proceso.kill();
    fs.rmSync(salida, { recursive: true, force: true });
  }
}

async function caso6_limitePermanente() {
  const nombre = "6. 429 permanente: se rinde tras 12 esperas";
  console.log(`\n=== ${nombre}`);
  // El 429 no alcanza a `/auth/*`, para que el corte ocurra DENTRO de la etapa
  // y no en el ingreso.
  const { proceso, puerto } = await levantarSimulada({ SIM_429_SIEMPRE: "1" });
  const salida = carpetaTemporal();
  try {
    const r = await correrCargador(puerto, salida, ["--etapa", "1", "--confirmar"]);
    const fin = await estadoDe(puerto);
    const esperas = (r.texto.match(/límite de solicitudes/g) ?? []).length;
    comprobar(`${nombre}: se detiene`, r.codigo === 2, `código ${r.codigo}`);
    comprobar(`${nombre}: los reintentos están acotados`, esperas === 12, `esperas = ${esperas}`);
    comprobar(`${nombre}: lo dice con claridad`, r.texto.includes("sigue limitando"), "mensaje explícito");
    comprobar(`${nombre}: no creó nada`, fin.clubes === 0 && fin.postsClubes === 0, `clubes=${fin.clubes}`);
  } finally {
    proceso.kill();
    fs.rmSync(salida, { recursive: true, force: true });
  }
}

/**
 * Las guardas que impiden una escritura accidental.
 *
 * Se prueban porque son la razón de ser del guion y porque ahora que la fecha,
 * los totales y las huellas viven en un archivo externo, lo que antes garantizaba
 * una constante tiene que garantizarlo una comprobación.
 */
async function caso7_guardas() {
  const nombre = "7. guardas contra una escritura accidental";
  console.log(`\n=== ${nombre}`);
  const { proceso, puerto } = await levantarSimulada({});
  const salida = carpetaTemporal();
  try {
    // a) sin --confirmar no se escribe nada, y termina bien
    const seco = await correrCargador(puerto, salida, ["--etapa", "todas"]);
    const trasSeco = await estadoDe(puerto);
    comprobar(`${nombre}: la pasada en seco termina bien`, seco.codigo === 0, `código ${seco.codigo}`);
    comprobar(
      `${nombre}: en seco no escribe NADA`,
      trasSeco.clubes === 0 && trasSeco.personas === 0 && trasSeco.membresias === 0 && trasSeco.postsClubes === 0,
      JSON.stringify(trasSeco).slice(0, 110)
    );
    comprobar(
      `${nombre}: en seco no deja archivos de etapa`,
      !fs.existsSync(path.join(salida, "etapa1_clubes.jsonl")),
      "ningún .jsonl"
    );

    // b) --confirmar SIN repetir la fecha: se niega
    const sinFecha = await new Promise((ok) => {
      const p = spawn(process.execPath, [CARGADOR, "--manifiesto", MANIFIESTO_RUTA, "--salida", salida, "--etapa", "1", "--confirmar"], {
        env: { ...process.env, API_BASE: `http://127.0.0.1:${puerto}/api`, CARGA_USUARIO: "operador.prueba", CARGA_CLAVE: "clave-de-prueba" },
      });
      let texto = "";
      p.stdout.on("data", (d) => (texto += d));
      p.stderr.on("data", (d) => (texto += d));
      p.on("close", (codigo) => ok({ codigo, texto }));
    });
    const trasSinFecha = await estadoDe(puerto);
    comprobar(`${nombre}: --confirmar sin --fecha-efectiva se niega`, sinFecha.codigo === 2, `código ${sinFecha.codigo}`);
    comprobar(`${nombre}: y lo explica`, sinFecha.texto.includes("repetir la fecha"), "mensaje explícito");
    comprobar(`${nombre}: y no creó nada`, trasSinFecha.postsClubes === 0, `posts=${trasSinFecha.postsClubes}`);

    // c) una planilla alterada rompe la huella y detiene todo
    const copia = carpetaTemporal();
    for (const f of fs.readdirSync(DIR_PLANILLAS)) {
      const origen = path.join(DIR_PLANILLAS, f);
      if (fs.statSync(origen).isFile()) fs.copyFileSync(origen, path.join(copia, f));
    }
    const manAlterado = path.join(copia, "manifiesto.json");
    // El manifiesto puede no vivir junto a las planillas: se copia aparte.
    fs.copyFileSync(MANIFIESTO_RUTA, manAlterado);
    const victima = path.join(copia, MANIFIESTO.planillas.clubes.archivo);
    fs.appendFileSync(victima, Buffer.from([0x00])); // un byte basta
    const huella = await new Promise((ok) => {
      const p = spawn(process.execPath, [CARGADOR, "--manifiesto", manAlterado, "--salida", salida, "--etapa", "1"], {
        env: { ...process.env, API_BASE: `http://127.0.0.1:${puerto}/api`, CARGA_USUARIO: "operador.prueba", CARGA_CLAVE: "clave-de-prueba" },
      });
      let texto = "";
      p.stdout.on("data", (d) => (texto += d));
      p.stderr.on("data", (d) => (texto += d));
      p.on("close", (codigo) => ok({ codigo, texto }));
    });
    comprobar(`${nombre}: un byte de más en la planilla la invalida`, huella.codigo === 2, `código ${huella.codigo}`);
    comprobar(`${nombre}: nombra la huella esperada y la encontrada`, huella.texto.includes("NO es la aprobada"), "mensaje explícito");
    fs.rmSync(copia, { recursive: true, force: true });

    // d) sin destino explícito no arranca
    const sinDestino = await new Promise((ok) => {
      const env = { ...process.env, CARGA_USUARIO: "operador.prueba", CARGA_CLAVE: "clave-de-prueba" };
      delete env.API_BASE;
      const p = spawn(process.execPath, [CARGADOR, "--manifiesto", MANIFIESTO_RUTA, "--salida", salida, "--etapa", "1"], { env });
      let texto = "";
      p.stdout.on("data", (d) => (texto += d));
      p.stderr.on("data", (d) => (texto += d));
      p.on("close", (codigo) => ok({ codigo, texto }));
    });
    comprobar(`${nombre}: sin API_BASE no arranca`, sinDestino.codigo === 2, `código ${sinDestino.codigo}`);
    comprobar(`${nombre}: y dice qué falta`, sinDestino.texto.includes("API_BASE"), "nombra la variable");

    // e) una salida dentro del repositorio se rechaza: el repositorio es público
    const dentro = await new Promise((ok) => {
      const p = spawn(process.execPath, [CARGADOR, "--manifiesto", MANIFIESTO_RUTA, "--salida", DIR, "--etapa", "1"], {
        env: { ...process.env, API_BASE: `http://127.0.0.1:${puerto}/api`, CARGA_USUARIO: "operador.prueba", CARGA_CLAVE: "clave-de-prueba" },
      });
      let texto = "";
      p.stdout.on("data", (d) => (texto += d));
      p.stderr.on("data", (d) => (texto += d));
      p.on("close", (codigo) => ok({ codigo, texto }));
    });
    comprobar(`${nombre}: rechaza --salida dentro del repositorio`, dentro.codigo === 2, `código ${dentro.codigo}`);
    comprobar(`${nombre}: y dice por qué`, dentro.texto.includes("DENTRO del repositorio"), "mensaje explícito");
  } finally {
    proceso.kill();
    fs.rmSync(salida, { recursive: true, force: true });
  }
}

// --- ejecución ---------------------------------------------------------------

const ref = await referencias();
console.log(`manifiesto: ${MANIFIESTO_RUTA}`);
console.log(`planillas: ${T.clubes} clubes, ${T.personas} personas, ${T.asignaciones} asignaciones, fecha ${FECHA}`);
console.log(`referencias: primer club «${ref.primerClub}», sigla con nadadores «${ref.siglaConNadadores}»`);

// Filtro opcional: `--caso 4` corre solo el caso 4. Sirve para comprobar un
// cambio acotado sin repetir los ocho.
const filtro = argumento("caso") ?? "";
const todos = [
  ["1", () => caso1_corteTrasGuardar()],
  ["2", () => caso2_clubDistinto(ref)],
  ["2b", () => caso2b_personaDistinta()],
  ["2c", () => caso2c_membresia(ref)],
  ["3", () => caso3_tokenVencido()],
  ["4", () => caso4_cargaLimpiaYFecha()],
  ["5", () => caso5_limiteConRetryAfter()],
  ["6", () => caso6_limitePermanente()],
  ["7", () => caso7_guardas()],
];
try {
  for (const [nombre, ejecutar] of todos) {
    if (filtro && nombre !== filtro) continue;
    await ejecutar();
  }
  if (filtro) console.log(`\n(solo se ejecutó el caso ${filtro})`);
} finally {
  if (temporalDeLasPlanillas) fs.rmSync(temporalDeLasPlanillas, { recursive: true, force: true });
}

const mal = resultados.filter((r) => !r.bien);
console.log(`\n${"=".repeat(70)}`);
console.log(`${resultados.length - mal.length} de ${resultados.length} comprobaciones correctas`);
if (mal.length) {
  for (const m of mal) console.log(`  MAL: ${m.caso} — ${m.detalle ?? ""}`);
  process.exitCode = 1;
} else {
  console.log("Todas las comprobaciones correctas.");
}
