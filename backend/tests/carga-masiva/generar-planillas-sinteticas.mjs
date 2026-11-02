// =============================================================================
// PLANILLAS SINTÉTICAS PARA PROBAR EL CARGADOR
//
// Genera las tres planillas y su manifiesto con datos INVENTADOS, con la misma
// disposición de columnas que espera `backend/scripts/carga-masiva/cargar.mjs`.
//
//   node backend/tests/carga-masiva/generar-planillas-sinteticas.mjs --salida <carpeta>
//
// POR QUÉ SE GENERAN Y NO SE GUARDAN. Por lo mismo que el resto de los fixtures
// de este repositorio: las planillas reales llevan RUN, nombres, correos y
// fechas de nacimiento de personas, y el repositorio es público. Generarlas
// garantiza que no pueda colarse un dato real por la puerta de atrás, y además
// evita meter binarios .xlsx en el historial.
//
// LOS DATOS SON RECONOCIBLEMENTE FALSOS a propósito: nombres de la lista de
// abajo, correos en `.invalid` —reservado por la RFC 2606, nunca resoluble— y
// RUN con dígito verificador correcto pero cuerpo en un rango que no se asigna.
// Que el dígito sea correcto importa: así estas planillas también sirven contra
// una API real en un entorno de desarrollo, que sí lo valida.
//
// EL TAMAÑO ES PEQUEÑO a propósito: una carga de prueba tiene que caber en los
// segundos que una batería de pruebas puede gastar. Las propiedades que se
// comprueban —conciliar, detenerse, reanudar, esperar un 429— no dependen del
// volumen.
// =============================================================================

import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

/** Dígito verificador del RUN chileno, mismo algoritmo que `shared/run.util.ts`. */
function digitoVerificador(cuerpo) {
  let suma = 0;
  let mult = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * mult;
    mult = mult === 7 ? 2 : mult + 1;
  }
  const resto = 11 - (suma % 11);
  if (resto === 11) return "0";
  if (resto === 10) return "K";
  return String(resto);
}

const runDe = (cuerpo) => `${cuerpo}-${digitoVerificador(String(cuerpo))}`;

const CLUBES = [
  { nombre: "Club Natación Aurora", sigla: "AUROR", usuario: "club.aurora" },
  { nombre: "Club Deportivo Bahía", sigla: "BAHIA", usuario: "club.bahia" },
  { nombre: "Club Acuático Cumbre", sigla: "CUMBR", usuario: "club.cumbre" },
  { nombre: "Club Delfines del Valle", sigla: "DELFI", usuario: "club.delfines" },
  { nombre: "Club Estuario", sigla: "ESTUA", usuario: "club.estuario" },
  // El sexto no tiene nadadores: la carga tiene que admitir clubes vacíos, y la
  // verificación tiene que contarlos como tales en lugar de alarmarse.
  { nombre: "Club Fundación Nueva", sigla: "FUNDA", usuario: "club.fundacion" },
];

const NOMBRES = [
  ["Ana", "Pérez", "Soto", "F"],
  ["Bruno", "Rojas", "Lagos", "M"],
  ["Carla", "Muñoz", "Vera", "F"],
  ["Diego", "Castro", "Ruiz", "M"],
  ["Elena", "Fuentes", "Pinto", "F"],
  ["Felipe", "Navarro", "Díaz", "M"],
  ["Gabriela", "Herrera", "Ortiz", "F"],
  ["Hugo", "Salas", "Bravo", "M"],
  ["Irene", "Vargas", "Mena", "F"],
  ["Joaquín", "Cortés", "Reyes", "M"],
  ["Karina", "Espinoza", "Luna", "F"],
  ["Lucas", "Guerrero", "Paz", "M"],
];

/** Doce nadadores repartidos en cinco clubes; el sexto queda sin ninguno. */
const REPARTO = [0, 0, 0, 1, 1, 2, 2, 2, 2, 3, 3, 4];

function construir() {
  const clubes = CLUBES.map((c, i) => ({
    filaOriginal: i + 1,
    name: c.nombre,
    code: c.sigla,
    username: c.usuario,
    email: `contacto@${c.sigla.toLowerCase()}.invalid`,
    personalidad: "Pendiente",
    rut: "",
    legalName: "",
    achmnMiembro: i % 2 === 0 ? "Sí" : "No",
    achmnColaborador: "No",
    fchmnMiembro: "Sí",
    fchmnColaborador: i % 3 === 0 ? "Sí" : "No",
  }));

  const personas = NOMBRES.map(([nombre, paterno, materno, g], i) => {
    const run = runDe(30000000 + i * 137);
    const usuario = `${nombre}.${paterno}`.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    return {
      run,
      username: usuario,
      firstName: nombre,
      paternalLastName: paterno,
      maternalLastName: materno,
      // Con BARRAS y día o mes de una cifra: es la forma en que estas planillas
      // llegan de verdad, y la que un normalizador descuidado da por distinta.
      birthDate: `${((i % 28) + 1).toString()}/${((i % 12) + 1).toString()}/${1985 + i}`,
      gender: g === "F" ? "Femenino" : "Masculino",
      email: `${usuario}@ejemplo.invalid`,
      phone: `+5690000${String(1000 + i).slice(-4)}`,
    };
  });

  const asignaciones = personas.map((p, i) => {
    const club = clubes[REPARTO[i]];
    return {
      fila: i + 1,
      run: p.run,
      username: p.username,
      nombreCompleto: `${p.firstName} ${p.paternalLastName} ${p.maternalLastName}`,
      sigla: club.code,
      club: club.name,
    };
  });

  return { clubes, personas, asignaciones };
}

async function escribir(salida, { clubes, personas, asignaciones }) {
  fs.mkdirSync(salida, { recursive: true });

  const wbC = new ExcelJS.Workbook();
  const hC = wbC.addWorksheet("Clubes");
  hC.addRow(["Fila", "Nombre", "Sigla", "Usuario", "Correo", "Personalidad jurídica", "RUT", "Razón social", "ACHMN miembro", "ACHMN colaborador", "FCHMN miembro", "FCHMN colaborador"]);
  for (const c of clubes) {
    hC.addRow([c.filaOriginal, c.name, c.code, c.username, c.email, c.personalidad, c.rut, c.legalName, c.achmnMiembro, c.achmnColaborador, c.fchmnMiembro, c.fchmnColaborador]);
  }

  const wbP = new ExcelJS.Workbook();
  const hP = wbP.addWorksheet("Personas");
  hP.addRow(["RUN", "Usuario", "Nombre", "Apellido paterno", "Apellido materno", "Fecha de nacimiento DD-MM-AAAA", "Género", "Correo", "Teléfono"]);
  for (const p of personas) {
    hP.addRow([p.run, p.username, p.firstName, p.paternalLastName, p.maternalLastName, p.birthDate, p.gender, p.email, p.phone]);
  }

  const wbA = new ExcelJS.Workbook();
  const hA = wbA.addWorksheet("Asignaciones");
  hA.addRow(["Fila", "RUN", "Usuario", "Nombre completo", "Sigla del club", "Club"]);
  for (const a of asignaciones) {
    hA.addRow([a.fila, a.run, a.username, a.nombreCompleto, a.sigla, a.club]);
  }

  const archivos = {
    clubes: "clubes-sinteticos.xlsx",
    personas: "personas-sinteticas.xlsx",
    asignaciones: "asignaciones-sinteticas.xlsx",
  };
  await wbC.xlsx.writeFile(path.join(salida, archivos.clubes));
  await wbP.xlsx.writeFile(path.join(salida, archivos.personas));
  await wbA.xlsx.writeFile(path.join(salida, archivos.asignaciones));

  const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(salida, f))).digest("hex");
  const conNadadores = new Set(asignaciones.map((a) => a.sigla)).size;

  const manifiesto = {
    _origen: "Generado por backend/tests/carga-masiva/generar-planillas-sinteticas.mjs. Datos inventados.",
    // Una fecha fija y lejana: así una prueba que compruebe «todas con esta
    // fecha» no puede pasar por accidente porque coincida con hoy.
    fechaEfectiva: "2030-03-15",
    directorioDePlanillas: ".",
    planillas: {
      clubes: { archivo: archivos.clubes, hoja: "Clubes", sha256: sha(archivos.clubes) },
      personas: { archivo: archivos.personas, hoja: "Personas", sha256: sha(archivos.personas) },
      asignaciones: { archivo: archivos.asignaciones, hoja: "Asignaciones", sha256: sha(archivos.asignaciones) },
    },
    totales: {
      clubes: clubes.length,
      personas: personas.length,
      asignaciones: asignaciones.length,
      clubesConNadadores: conNadadores,
    },
    limiteDeSolicitudesPorMinuto: 300,
  };
  const rutaManifiesto = path.join(salida, "manifiesto.json");
  fs.writeFileSync(rutaManifiesto, JSON.stringify(manifiesto, null, 1) + "\n", "utf8");
  return { rutaManifiesto, manifiesto };
}

/** Deja las planillas y el manifiesto en `salida` y devuelve la ruta del manifiesto. */
export async function generarPlanillasSinteticas(salida) {
  const destino = salida ?? fs.mkdtempSync(path.join(os.tmpdir(), "carga-sintetica-"));
  const datos = construir();
  const { rutaManifiesto, manifiesto } = await escribir(destino, datos);
  return { carpeta: destino, rutaManifiesto, manifiesto, datos };
}

// Ejecutable directo, para inspeccionar las planillas a mano.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--salida");
  const salida = i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : undefined;
  const r = await generarPlanillasSinteticas(salida);
  console.log(JSON.stringify({ carpeta: r.carpeta, manifiesto: r.rutaManifiesto, totales: r.manifiesto.totales }, null, 1));
}
