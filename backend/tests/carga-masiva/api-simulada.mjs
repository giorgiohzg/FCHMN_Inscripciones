// =============================================================================
// API SIMULADA — solo para probar el cargador
//
// Imita los extremos que usa `Cargador_Carga_Masiva.mjs` y permite provocar a
// voluntad las situaciones que en la API real no se pueden provocar sin
// romper algo: un corte justo después de guardar, un registro preexistente con
// datos distintos, y un token que caduca a mitad de una etapa.
//
// NO es la API del proyecto y no se parece por dentro. Solo reproduce lo que el
// cargador observa: las formas de respuesta, los mensajes de rechazo medidos en
// los ensayos, y —a propósito— **la trampa de la fecha**: si `fechaEfectiva` no
// viene, graba HOY, igual que el servicio real.
//
// Los datos salen de las planillas que declara el manifiesto —en las pruebas,
// las SINTÉTICAS de `generar-planillas-sinteticas.mjs`—: nada escrito a disco,
// todo en memoria y se va con el proceso.
//
// Variables de entorno que gobiernan la simulación:
//   SIM_MANIFIESTO        OBLIGATORIA: ruta del manifiesto cuyas planillas se
//                         usan como datos de referencia
//   SIM_PUERTO            puerto (0 = el sistema elige, se imprime)
//   SIM_SEMBRAR_CLUBES    n: parte con los n primeros clubes ya creados
//   SIM_SEMBRAR_PERSONAS  n: parte con las n primeras personas ya creadas
//   SIM_CORTE_EN          n: en el n-ésimo POST /clubs GUARDA y luego corta la
//                         conexión sin responder (el corte del enunciado)
//   SIM_CLUB_DISTINTO     sigla: ese club se siembra con el correo cambiado
//   SIM_PERSONA_DISTINTA  n: esa fila de personas se siembra con otra fecha de
//                         nacimiento
//   SIM_MEMBRESIA_OTRO_CLUB  sigla: su primer nadador se siembra con membresía
//                            activa en OTRO club
//   SIM_MEMBRESIA_OTRA_FECHA sigla: su primer nadador se siembra con membresía
//                            activa en el club correcto y otra fecha efectiva
//   SIM_TOKEN_VIDA        n: el token vale n peticiones autenticadas; después
//                         responde 401 hasta que se renueve
//   SIM_LIMITE_POR_MINUTO n: 429 con `retry-after` pasadas n solicitudes por
//                         ventana, como `@fastify/rate-limit`
//   SIM_VENTANA_S         segundos de esa ventana (60 por omisión; se encoge
//                         para que las pruebas no tarden un minuto)
//   SIM_429_SIEMPRE       1: 429 permanente en todo menos `/auth/*`, para
//                         comprobar el tope de reintentos
// =============================================================================

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Buffer } from "node:buffer";
import { URL } from "node:url";
import ExcelJS from "exceljs";

const ENT = (n, d = 0) => (process.env[n] ? Number(process.env[n]) : d);
const CAD = (n) => process.env[n] || "";

// --- manifiesto ---------------------------------------------------------------

const RUTA_MANIFIESTO = CAD("SIM_MANIFIESTO");
if (!RUTA_MANIFIESTO) {
  console.error("[simulada] falta SIM_MANIFIESTO: sin manifiesto no hay datos de referencia");
  process.exit(2);
}
const MANIFIESTO = JSON.parse(fs.readFileSync(path.resolve(RUTA_MANIFIESTO), "utf8"));
const DIR = path.resolve(path.dirname(path.resolve(RUTA_MANIFIESTO)), MANIFIESTO.directorioDePlanillas ?? ".");
const FECHA_EFECTIVA = MANIFIESTO.fechaEfectiva;

/**
 * Una fecha distinta de la efectiva, para el caso «membresía con otra fecha».
 *
 * Se deriva de la del manifiesto en lugar de escribirse fija: una fecha fija
 * podría coincidir con la efectiva de algún manifiesto y entonces el caso
 * dejaría de probar nada, en silencio.
 */
const OTRA_FECHA = `${Number(FECHA_EFECTIVA.slice(0, 4)) - 1}${FECHA_EFECTIVA.slice(4)}`;

const texto = (c) => {
  const v = c && c.value;
  if (v == null) return "";
  if (typeof v === "object") return v.richText ? v.richText.map((x) => x.text).join("") : String(v.text ?? v.result ?? "");
  return String(v);
};

async function filas(clave, mapa) {
  const p = MANIFIESTO.planillas?.[clave];
  if (!p?.archivo || !p?.hoja) throw new Error(`el manifiesto no declara la planilla ${clave}`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(DIR, p.archivo));
  const h = wb.getWorksheet(p.hoja);
  const out = [];
  h.eachRow((fila, n) => {
    if (n === 1) return;
    const r = mapa((i) => texto(fila.getCell(i)).trim(), n);
    if (r) out.push(r);
  });
  return out;
}

// Mismo patrón que `parseSpanishDate` del servidor: guion o barra, una o dos
// cifras. La hoja «Personas» trae las fechas con barras.
const normFecha = (s) => {
  const m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(String(s ?? "").trim());
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : String(s ?? "").trim();
};
const iso = (f) => `${f}T00:00:00.000Z`;
const hoyEnChile = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);

// --- Estado en memoria -------------------------------------------------------

const estado = {
  clubes: [],
  personas: [],
  membresias: [],
  postsClubes: 0,
  ventana: { desde: Date.now(), cuenta: 0 },
  limitadas: 0,
  tokens: new Map(), // token -> peticiones restantes
  sesiones: new Set(),
};

const aprobado = { clubes: [], personas: [], asignaciones: [] };

async function cargarAprobado() {
  aprobado.clubes = await filas("clubes", (c) =>
    c(2) ? { name: c(2), code: c(3), username: c(4), email: c(5), rut: c(7), legalName: c(8),
             isAchmnMember: c(9), isAchmnCollaborator: c(10), isFchmnMember: c(11), isFchmnCollaborator: c(12) } : null
  );
  aprobado.personas = await filas("personas", (c, n) =>
    c(1) ? { fila: n, run: c(1), username: c(2), firstName: c(3), paternalLastName: c(4), maternalLastName: c(5),
             birthDate: c(6), gender: c(7), email: c(8), phone: c(9) } : null
  );
  aprobado.asignaciones = await filas("asignaciones", (c) =>
    c(3) ? { run: c(2), username: c(3), sigla: c(5) } : null
  );
}

const bool = (v) => ["sí", "si", "true", "1", "x"].includes(String(v ?? "").trim().toLowerCase());

function clubDesdeAprobado(a) {
  return {
    id: crypto.randomUUID(),
    name: a.name,
    code: a.code,
    username: a.username,
    email: a.email,
    hasLegalStatus: null,
    rut: a.rut || null,
    legalName: a.legalName || null,
    isAchmnMember: bool(a.isAchmnMember),
    isAchmnCollaborator: bool(a.isAchmnCollaborator),
    isFchmnMember: bool(a.isFchmnMember),
    isFchmnCollaborator: bool(a.isFchmnCollaborator),
    status: "active",
    staff: [],
  };
}

function personaDesdeAprobado(a) {
  return {
    id: crypto.randomUUID(),
    run: a.run,
    username: a.username,
    firstName: a.firstName,
    paternalLastName: a.paternalLastName,
    maternalLastName: a.maternalLastName,
    fullName: `${a.firstName} ${a.paternalLastName}`.trim(),
    birthDate: iso(normFecha(a.birthDate)),
    gender: String(a.gender).toLowerCase().startsWith("f") ? "female" : "male",
    email: a.email || null,
    phone: a.phone || null,
    status: "active",
    adminAccess: false,
    roles: [{ roleType: "swimmer", active: true }],
  };
}

function sembrar() {
  const nC = ENT("SIM_SEMBRAR_CLUBES");
  for (let i = 0; i < nC; i++) estado.clubes.push(clubDesdeAprobado(aprobado.clubes[i]));

  const distinto = CAD("SIM_CLUB_DISTINTO");
  if (distinto) {
    const a = aprobado.clubes.find((c) => c.code === distinto);
    if (!a) throw new Error(`SIM_CLUB_DISTINTO: no existe la sigla ${distinto}`);
    if (!estado.clubes.some((c) => c.username === a.username)) estado.clubes.push(clubDesdeAprobado(a));
    const c = estado.clubes.find((x) => x.username === a.username);
    c.email = "otro-correo@ejemplo.invalid"; // la diferencia que el cargador debe ver
  }

  const nP = ENT("SIM_SEMBRAR_PERSONAS");
  for (let i = 0; i < nP; i++) estado.personas.push(personaDesdeAprobado(aprobado.personas[i]));

  const filaDistinta = ENT("SIM_PERSONA_DISTINTA");
  if (filaDistinta) {
    const a = aprobado.personas.find((p) => p.fila === filaDistinta);
    if (!a) throw new Error(`SIM_PERSONA_DISTINTA: no existe la fila ${filaDistinta}`);
    if (!estado.personas.some((p) => p.run === a.run)) estado.personas.push(personaDesdeAprobado(a));
    const p = estado.personas.find((x) => x.run === a.run);
    p.birthDate = iso("1900-01-01"); // la diferencia
  }

  const sembrarMembresia = (sigla, clubDestino, fecha) => {
    const primera = aprobado.asignaciones.find((x) => x.sigla === sigla);
    if (!primera) throw new Error(`no hay nadadores para la sigla ${sigla}`);
    const apC = aprobado.clubes.find((c) => c.code === (clubDestino ?? sigla));
    let club = estado.clubes.find((c) => c.username === apC.username);
    if (!club) {
      club = clubDesdeAprobado(apC);
      estado.clubes.push(club);
    }
    const apP = aprobado.personas.find((p) => p.username === primera.username);
    let persona = estado.personas.find((p) => p.username === primera.username);
    if (!persona) {
      persona = personaDesdeAprobado(apP);
      estado.personas.push(persona);
    }
    estado.membresias.push({
      id: crypto.randomUUID(),
      clubId: club.id,
      personId: persona.id,
      status: "active",
      requestedByUserId: "sim",
      reviewedByUserId: "sim",
      reviewedAt: new Date().toISOString(),
      rejectionReason: null,
      startDate: iso(fecha),
      endDate: null,
      club: { id: club.id, name: club.name },
      person: { id: persona.id, fullName: persona.fullName, run: persona.run },
    });
  };

  const otroClub = CAD("SIM_MEMBRESIA_OTRO_CLUB");
  if (otroClub) {
    // El nadador queda activo en un club que NO es el aprobado.
    const otra = aprobado.clubes.find((c) => c.code !== otroClub);
    sembrarMembresia(otroClub, otra.code, FECHA_EFECTIVA);
  }
  const otraFecha = CAD("SIM_MEMBRESIA_OTRA_FECHA");
  if (otraFecha) sembrarMembresia(otraFecha, otraFecha, OTRA_FECHA);
}

// --- Servidor ----------------------------------------------------------------

function pagina(items, url) {
  const p = Number(url.searchParams.get("page") ?? 1);
  const t = Number(url.searchParams.get("pageSize") ?? 20);
  return { items: items.slice((p - 1) * t, p * t), total: items.length, page: p, pageSize: t };
}

function responder(res, codigo, cuerpo, cabeceras = {}) {
  const txt = JSON.stringify(cuerpo ?? {});
  res.writeHead(codigo, { "content-type": "application/json; charset=utf-8", ...cabeceras });
  res.end(txt);
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://simulada");
  const ruta = url.pathname.replace(/^\/api/, "");
  const cuerpo = await new Promise((ok) => {
    const trozos = [];
    req.on("data", (d) => trozos.push(d));
    req.on("end", () => ok(Buffer.concat(trozos)));
  });

  // --- límite de solicitudes, como el de la API real ------------------------
  //
  // `@fastify/rate-limit` 10.3.0 responde 429 y pone `retry-after` **en
  // segundos** (`ttlInSeconds = Math.ceil(res.ttl / 1000)`), con el cuerpo que
  // arma `errorResponseBuilder` en `server.ts`. Esto reproduce las dos cosas.
  //
  // `SIM_VENTANA_S` encoge la ventana para que las pruebas no tarden un minuto.
  // `/__estado` queda fuera: es el ojo de la prueba, no tráfico del cargador.
  if (ruta !== "/__estado") {
    const siempre = CAD("SIM_429_SIEMPRE") && !ruta.startsWith("/auth/");
    const limite = ENT("SIM_LIMITE_POR_MINUTO");
    if (siempre) {
      res.setHeader("retry-after", "1");
      return responder(res, 429, {
        statusCode: 429,
        code: "RATE_LIMIT_EXCEEDED",
        error: "RATE_LIMIT_EXCEEDED",
        message: "Demasiadas solicitudes seguidas — espere 1 segundos e intente de nuevo.",
      });
    }
    if (limite) {
      const ventanaMs = ENT("SIM_VENTANA_S", 60) * 1000;
      const ahora = Date.now();
      if (ahora - estado.ventana.desde >= ventanaMs) estado.ventana = { desde: ahora, cuenta: 0 };
      estado.ventana.cuenta++;
      if (estado.ventana.cuenta > limite) {
        const restanteS = Math.ceil((estado.ventana.desde + ventanaMs - ahora) / 1000);
        estado.limitadas++;
        res.setHeader("retry-after", String(Math.max(restanteS, 1)));
        return responder(res, 429, {
          statusCode: 429,
          code: "RATE_LIMIT_EXCEEDED",
          error: "RATE_LIMIT_EXCEEDED",
          message: `Demasiadas solicitudes seguidas — espere ${Math.max(restanteS, 1)} segundos e intente de nuevo.`,
        });
      }
    }
  }

  // --- sesión ---
  if (ruta === "/auth/login" && req.method === "POST") {
    const token = crypto.randomUUID();
    const vida = ENT("SIM_TOKEN_VIDA", Infinity);
    estado.tokens.set(token, vida);
    const sesion = crypto.randomUUID();
    estado.sesiones.add(sesion);
    return responder(res, 200, { accessToken: token, csrfToken: "csrf-" + sesion, roles: ["admin"] }, { "set-cookie": `sesion=${sesion}; Path=/; HttpOnly` });
  }
  if (ruta === "/auth/refresh" && req.method === "POST") {
    const galleta = /sesion=([0-9a-f-]+)/.exec(req.headers.cookie ?? "");
    if (!galleta || !estado.sesiones.has(galleta[1])) return responder(res, 401, { message: "Sin sesión" });
    const token = crypto.randomUUID();
    estado.tokens.set(token, ENT("SIM_TOKEN_VIDA", Infinity));
    return responder(res, 200, { accessToken: token, csrfToken: "csrf-" + galleta[1] });
  }

  // --- espejo para las comprobaciones de la prueba ---
  //
  // Va ANTES de la autenticación a propósito: es el ojo de la prueba sobre el
  // estado, y no debe depender de un token que el propio caso está venciendo.
  if (ruta === "/__estado" && req.method === "GET") {
    return responder(res, 200, {
      clubes: estado.clubes.length,
      personas: estado.personas.length,
      membresias: estado.membresias.length,
      postsClubes: estado.postsClubes,
      limitadas: estado.limitadas,
      usuariosDuplicados: estado.clubes.length - new Set(estado.clubes.map((c) => c.username)).size,
      fechasDeMembresia: [...new Set(estado.membresias.map((m) => m.startDate.slice(0, 10)))].sort(),
    });
  }

  // --- autenticación, con caducidad simulada ---
  const cabecera = String(req.headers.authorization ?? "");
  const token = cabecera.startsWith("Bearer ") ? cabecera.slice(7) : null;
  const restantes = token ? estado.tokens.get(token) : undefined;
  if (restantes === undefined) return responder(res, 401, { message: "Token inválido o caducado" });
  if (restantes <= 0) return responder(res, 401, { message: "Token caducado" });
  estado.tokens.set(token, restantes - 1);

  // --- clubes ---
  if (ruta === "/clubs" && req.method === "GET") {
    const busca = (url.searchParams.get("search") ?? "").toLowerCase();
    const items = busca
      ? estado.clubes.filter((c) => [c.name, c.code, c.username, c.legalName, c.rut].some((v) => String(v ?? "").toLowerCase().includes(busca)))
      : estado.clubes;
    return responder(res, 200, pagina(items, url));
  }
  if (ruta === "/clubs" && req.method === "POST") {
    const entrada = JSON.parse(cuerpo.toString("utf8") || "{}");
    if (!("hasLegalStatus" in entrada)) {
      return responder(res, 400, { message: "Datos inválidos", detalle: "hasLegalStatus es obligatorio (nullable, no optional)" });
    }
    if (estado.clubes.some((c) => c.username === entrada.username)) {
      return responder(res, 400, {
        message: `El nombre de usuario "${entrada.username}" ya está en uso por un club. Los nombres de usuario son únicos entre personas, clubes y cuentas de acceso, y no se pueden cambiar después de crearlos.`,
      });
    }
    estado.postsClubes++;
    const nuevo = { id: crypto.randomUUID(), status: "active", staff: [], rut: null, legalName: null, ...entrada };
    estado.clubes.push(nuevo);
    // EL CORTE DEL ENUNCIADO: ya está guardado y la respuesta no llega nunca.
    const corte = ENT("SIM_CORTE_EN");
    if (corte && estado.postsClubes === corte) {
      console.error(`[simulada] club nº ${corte} GUARDADO y conexión cortada sin responder`);
      return res.socket.destroy();
    }
    return responder(res, 201, nuevo);
  }

  // --- personas ---
  if (ruta === "/persons" && req.method === "GET") return responder(res, 200, pagina(estado.personas, url));
  if (ruta === "/persons/bulk-import" && req.method === "POST") {
    const resultados = [];
    for (const a of aprobado.personas) {
      if (estado.personas.some((p) => p.run.replace(/[.-]/g, "") === a.run.replace(/[.-]/g, ""))) {
        resultados.push({ row: a.fila, status: "error", errors: ["Ya existe una persona registrada con este RUN"] });
        continue;
      }
      const p = personaDesdeAprobado(a);
      estado.personas.push(p);
      resultados.push({ row: a.fila, status: "created", fullName: p.fullName });
    }
    const creadas = resultados.filter((r) => r.status === "created").length;
    return responder(res, 200, { totalCount: resultados.length, createdCount: creadas, errorCount: resultados.length - creadas, results: resultados });
  }

  // --- asignaciones ---
  if (ruta === "/swimmer-assignments" && req.method === "GET") {
    const estadoPedido = url.searchParams.get("status");
    const clubId = url.searchParams.get("clubId");
    const personId = url.searchParams.get("personId");
    let items = estado.membresias;
    if (estadoPedido) items = items.filter((m) => m.status === estadoPedido);
    if (clubId) items = items.filter((m) => m.clubId === clubId);
    if (personId) items = items.filter((m) => m.personId === personId);
    return responder(res, 200, pagina(items, url));
  }
  if (ruta === "/swimmer-assignments/bulk-assign" && req.method === "POST") {
    const entrada = JSON.parse(cuerpo.toString("utf8") || "{}");
    const club = estado.clubes.find((c) => c.id === entrada.targetClubId);
    if (!club) return responder(res, 404, { message: "Club no encontrado" });
    // LA TRAMPA, reproducida a propósito: sin fechaEfectiva, HOY.
    const fecha = entrada.fechaEfectiva ?? hoyEnChile();
    const resultados = [];
    for (const personId of entrada.personIds ?? []) {
      const persona = estado.personas.find((p) => p.id === personId);
      if (!persona) {
        resultados.push({ personId, fullName: "?", status: "error", error: "Nadador no encontrado" });
        continue;
      }
      if (estado.membresias.some((m) => m.personId === personId && m.status === "active")) {
        resultados.push({ personId, fullName: persona.fullName, status: "error", error: "El nadador ya pertenece activamente a este club" });
        continue;
      }
      estado.membresias.push({
        id: crypto.randomUUID(),
        clubId: club.id,
        personId,
        status: "active",
        requestedByUserId: "sim",
        reviewedByUserId: "sim",
        reviewedAt: new Date().toISOString(),
        rejectionReason: null,
        startDate: iso(fecha),
        endDate: null,
        club: { id: club.id, name: club.name },
        person: { id: persona.id, fullName: persona.fullName, run: persona.run },
      });
      resultados.push({ personId, fullName: persona.fullName, status: "assigned" });
    }
    const ok = resultados.filter((r) => r.status === "assigned").length;
    return responder(res, 200, { totalCount: resultados.length, assignedCount: ok, errorCount: resultados.length - ok, results: resultados });
  }

  return responder(res, 404, { message: `Sin ruta ${req.method} ${ruta}` });
});

await cargarAprobado();
sembrar();
servidor.listen(ENT("SIM_PUERTO", 0), "127.0.0.1", () => {
  console.log(`PUERTO=${servidor.address().port}`);
  console.error(
    `[simulada] lista: ${estado.clubes.length} clubes, ${estado.personas.length} personas, ${estado.membresias.length} membresías sembradas`
  );
});
