/**
 * ACCESOS POR ROL, por HTTP contra la aplicación real (`app.inject`) y la base DESECHABLE.
 *
 * Distingue siempre la denegación por función (403 `FUNCION_DESHABILITADA`) de cualquier otra
 * respuesta: con la función permitida, una solicitud incompleta llega al permiso, al alcance o a
 * la validación de siempre (400, 403 `FORBIDDEN`, 404…), que es justo lo que debe pasar.
 * Datos sintéticos.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addClubStaff, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";
import { CATALOGO, celdasConfigurables } from "../src/modules/accesos/catalogo";
import { guardarConfiguracion, olvidarCacheDeAccesos } from "../src/modules/accesos/accesos.service";

let app: FastifyInstance;
const tok: Record<string, string> = {};
const ids = { clubA: "", clubB: "", admin: "", admin2: "" };
const UUID = "00000000-0000-4000-8000-000000000000";

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function login(username: string): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login de ${username} falló: ${res.statusCode} ${res.body}`);
  return res.json().accessToken;
}

type Valores = Record<string, Record<string, boolean>>;
function todoEncendido(): Valores {
  const v: Valores = { swimmer: {}, delegate: {}, coach: {} };
  for (const c of celdasConfigurables()) v[c.rol]![c.funcion] = true;
  return v;
}
function con(apagadas: string[]): Valores {
  const v = todoEncendido();
  for (const k of apagadas) {
    const [rol, funcion] = k.split(":") as [string, string];
    v[rol]![funcion] = false;
  }
  return v;
}

async function leer(t = tok.admin!) {
  const res = await app.inject({ method: "GET", url: "/accesos-por-rol", headers: auth(t) });
  expect(res.statusCode).toBe(200);
  return res.json() as { version: number; valores: Valores; ultimaModificacion: { en: string; por: { username: string } | null } | null };
}

async function guardar(valores: Valores, version?: number, t = tok.admin!) {
  const v = version ?? (await leer(t)).version;
  return app.inject({ method: "PUT", url: "/accesos-por-rol", headers: auth(t), payload: { version: v, valores } });
}

async function configurar(apagadas: string[]) {
  const res = await guardar(con(apagadas));
  expect(res.statusCode, res.body).toBe(200);
}

/** Código de error de una solicitud (o `OK` si no hubo error). */
async function codigo(t: string, metodo: "GET" | "POST" | "PUT", url: string, payload?: Record<string, unknown>): Promise<string> {
  const res = await app.inject(payload !== undefined ? { method: metodo, url, headers: auth(t), payload } : { method: metodo, url, headers: auth(t) });
  if (res.statusCode < 400) return "OK";
  return `${res.statusCode} ${(res.json() as { error?: string; code?: string }).error ?? "?"}`;
}
const DESHABILITADA = "403 FUNCION_DESHABILITADA";

/** URL concreta de una ruta del catálogo (parámetros sintéticos). */
function url(ruta: string, condicion?: string): string {
  let u = ruta.replace(":id", UUID);
  if (u === "/registrations" || u === "/relay-registrations") u += condicion?.startsWith("status=confirmed") ? "?status=confirmed" : "?status=cancelled";
  return u;
}

beforeAll(async () => {
  app = await buildServer();
  await app.ready();
  await truncateAllTables(prisma as unknown as Parameters<typeof truncateAllTables>[0]);
  olvidarCacheDeAccesos();
  await seedRolesAndPermissions();

  const clubA = await createClub("Club Accesos A", "ACA", "club_acc_a");
  const clubB = await createClub("Club Accesos B", "ACB", "club_acc_b");
  ids.clubA = clubA.id;
  ids.clubB = clubB.id;

  ids.admin = (await createUser({ username: "admin_acc", roleNames: ["admin"] })).id;
  ids.admin2 = (await createUser({ username: "admin_acc2", roleNames: ["admin"] })).id;
  await createUser({ username: "club_acc_a", roleNames: ["club"], clubId: clubA.id });

  const persona = async (run: string, username: string, roles: string[], club?: { id: string; como: "delegate" | "coach" | "legal_representative" }, nada = false, opciones: { mustChangePassword?: boolean } = {}) => {
    const p = await createPerson({ run, username, firstName: username, gender: "female", roles: [] });
    if (club) await addClubStaff(club.id, p.id, club.como);
    if (nada) await addActiveMembership(clubA.id, p.id, ids.admin);
    await createUser({ username, roleNames: roles, personId: p.id, ...opciones });
  };
  await persona("60000001", "deleg_acc", ["delegate"], { id: clubA.id, como: "delegate" });
  await persona("60000002", "coach_acc", ["coach"], { id: clubA.id, como: "coach" });
  await persona("60000003", "replegal_acc", ["legal_representative"], { id: clubA.id, como: "legal_representative" });
  await persona("60000004", "nada_acc", ["swimmer"], undefined, true);
  await persona("60000005", "deleg_coach_acc", ["delegate", "coach"], { id: clubA.id, como: "delegate" });
  await persona("60000006", "deleg_nada_b", ["delegate", "swimmer"], { id: clubB.id, como: "delegate" }, true);
  await persona("60000007", "admin_deleg_acc", ["admin", "delegate"], { id: clubA.id, como: "delegate" });
  await persona("60000008", "nada_obligado", ["swimmer"], undefined, true, { mustChangePassword: true });

  for (const u of ["admin_acc", "admin_acc2", "club_acc_a", "deleg_acc", "coach_acc", "replegal_acc", "nada_acc", "deleg_coach_acc", "deleg_nada_b", "admin_deleg_acc"]) {
    tok[u] = await login(u);
  }
  tok.admin = tok.admin_acc!;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  // Cada caso parte de la configuración inicial (todo encendido) y del club B activo.
  const actual = await leer();
  const yaInicial = Object.values(actual.valores).every((v) => Object.values(v).every(Boolean));
  if (!yaInicial) await configurar([]);
  await prisma.club.update({ where: { id: ids.clubB }, data: { status: "active" } });
});

describe("configuración inicial (migración)", () => {
  it("versión 0, sin autor, sin filas y todo encendido", async () => {
    // Este caso corre primero: la migración (y el TRUNCATE de las pruebas) deja la versión 0.
    const cfg = await leer();
    expect(cfg.version).toBe(0);
    expect(cfg.ultimaModificacion).toBeNull();
    expect(await prisma.accesoPorRol.count()).toBe(0);
    for (const rol of ["swimmer", "delegate", "coach"]) expect(Object.values(cfg.valores[rol]!).every(Boolean)).toBe(true);
  });

  it("ninguna ruta del catálogo se deniega por función para ningún rol", async () => {
    for (const u of ["deleg_acc", "coach_acc", "replegal_acc", "nada_acc", "club_acc_a", "deleg_coach_acc"]) {
      for (const f of CATALOGO) {
        for (const r of f.rutas) {
          if (r.ruta === "/auth/change-password") continue;
          expect(await codigo(tok[u]!, r.metodo, url(r.ruta, r.condicion), r.metodo === "GET" ? undefined : {}), `${u} ${r.metodo} ${r.ruta}`).not.toBe(DESHABILITADA);
        }
      }
    }
  });

  it("/auth/accesos: sin funciones deshabilitadas", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/accesos", headers: auth(tok.deleg_acc!) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ version: 0, deshabilitadas: [] });
  });
});

describe("cada rol, menús y acciones", () => {
  it("delegado: acción apagada → 403 FUNCION_DESHABILITADA; las demás siguen; restituida → vuelve", async () => {
    const antes = tok.deleg_acc!; // sesión abierta ANTES del cambio
    await configurar(["delegate:reportes.exportar"]);
    expect(await codigo(antes, "GET", "/reports/registrations/export")).toBe(DESHABILITADA);
    expect(await codigo(antes, "GET", "/reports/registrations")).not.toBe(DESHABILITADA);
    const acc = await app.inject({ method: "GET", url: "/auth/accesos", headers: auth(antes) });
    expect(acc.json().deshabilitadas).toEqual(["reportes.exportar"]);
    // El entrenador y el nadador no se ven afectados.
    expect(await codigo(tok.coach_acc!, "GET", "/reports/registrations/export")).not.toBe(DESHABILITADA);
    expect(await codigo(tok.nada_acc!, "GET", "/reports/registrations/export")).not.toBe(DESHABILITADA);
    await configurar([]);
    expect(await codigo(antes, "GET", "/reports/registrations/export")).not.toBe(DESHABILITADA);
  });

  it("nadador y entrenador: sus propias casillas", async () => {
    await configurar(["swimmer:inscripciones.crear", "coach:relevos.armar"]);
    expect(await codigo(tok.nada_acc!, "POST", "/registrations", {})).toBe(DESHABILITADA);
    expect(await codigo(tok.coach_acc!, "POST", "/relay-registrations", {})).toBe(DESHABILITADA);
    expect(await codigo(tok.deleg_acc!, "POST", "/registrations", {})).not.toBe(DESHABILITADA);
    expect(await codigo(tok.deleg_acc!, "POST", "/relay-registrations", {})).not.toBe(DESHABILITADA);
  });

  it("menú apagado: apaga sus acciones sin borrar sus casillas; al encenderlo se conservan", async () => {
    await configurar(["delegate:menu.reportes", "delegate:reportes.exportar"]);
    expect(await codigo(tok.deleg_acc!, "GET", "/reports/registrations")).toBe(DESHABILITADA);
    expect(await codigo(tok.deleg_acc!, "GET", "/reports/registrations/export")).toBe(DESHABILITADA);
    const cfg = await leer();
    expect(cfg.valores.delegate!["reportes.generar"]).toBe(true);
    expect(cfg.valores.delegate!["reportes.exportar"]).toBe(false);
    // Se vuelve a encender el menú: «Generar» vuelve y «Exportar» sigue apagada.
    await configurar(["delegate:reportes.exportar"]);
    expect(await codigo(tok.deleg_acc!, "GET", "/reports/registrations")).not.toBe(DESHABILITADA);
    expect(await codigo(tok.deleg_acc!, "GET", "/reports/registrations/export")).toBe(DESHABILITADA);
  });

  it("todas las rutas del catálogo quedan protegidas: con todo apagado para el delegado, cada una responde FUNCION_DESHABILITADA", async () => {
    await configurar(celdasConfigurables().filter((c) => c.rol === "delegate").map((c) => `delegate:${c.funcion}`));
    for (const f of CATALOGO) {
      if (!f.aplicaA.includes("delegate")) continue;
      for (const r of f.rutas) {
        if (r.ruta === "/auth/change-password") continue;
        expect(await codigo(tok.deleg_acc!, r.metodo, url(r.ruta, r.condicion), r.metodo === "GET" ? undefined : {}), `${f.id} ${r.metodo} ${r.ruta}`).toBe(DESHABILITADA);
      }
    }
    // El cambio voluntario, aparte (cuerpo válido de forma, contraseña actual incorrecta).
    expect(await codigo(tok.deleg_acc!, "POST", "/auth/change-password", { currentPassword: "x", newPassword: "OtraClave12345", confirmPassword: "OtraClave12345" })).toBe(DESHABILITADA);
  });
});

describe("suma de roles y roles no configurables", () => {
  it("delegado + entrenador: basta que uno lo permita", async () => {
    await configurar(["delegate:reportes.generar"]);
    expect(await codigo(tok.deleg_coach_acc!, "GET", "/reports/registrations")).not.toBe(DESHABILITADA);
    await configurar(["delegate:reportes.generar", "coach:reportes.generar"]);
    expect(await codigo(tok.deleg_coach_acc!, "GET", "/reports/registrations")).toBe(DESHABILITADA);
  });

  it("administración con otro rol y todo apagado: acceso completo", async () => {
    await configurar(celdasConfigurables().map((c) => `${c.rol}:${c.funcion}`));
    for (const u of ["admin_acc", "admin_deleg_acc"]) {
      expect(await codigo(tok[u]!, "GET", "/reports/registrations")).not.toBe(DESHABILITADA);
      expect(await codigo(tok[u]!, "POST", "/registrations", {})).not.toBe(DESHABILITADA);
    }
    const acc = await app.inject({ method: "GET", url: "/auth/accesos", headers: auth(tok.admin_deleg_acc!) });
    expect(acc.json().deshabilitadas).toEqual([]);
  });

  it("cuenta de club y representante legal conservan sus atribuciones aunque todo esté apagado", async () => {
    await configurar(celdasConfigurables().map((c) => `${c.rol}:${c.funcion}`));
    for (const u of ["club_acc_a", "replegal_acc"]) {
      for (const f of CATALOGO.filter((x) => x.aplicaA.includes("club"))) {
        for (const r of f.rutas) {
          if (r.ruta === "/auth/change-password") continue;
          expect(await codigo(tok[u]!, r.metodo, url(r.ruta, r.condicion), r.metodo === "GET" ? undefined : {}), `${u} ${r.ruta}`).not.toBe(DESHABILITADA);
        }
      }
    }
  });
});

describe("rutas compartidas y alternativas", () => {
  it("apagar Inscripciones no rompe Relevos en las lecturas compartidas", async () => {
    await configurar(["delegate:menu.inscripciones"]);
    expect(await codigo(tok.deleg_acc!, "GET", `/competitions/${UUID}/enabled-events`)).not.toBe(DESHABILITADA);
    expect(await codigo(tok.deleg_acc!, "GET", `/registrations/club-swimmers?clubId=${ids.clubA}`)).not.toBe(DESHABILITADA);
    expect(await codigo(tok.deleg_acc!, "GET", "/registrations/club-eligibility-matrix")).toBe(DESHABILITADA);
    expect(await codigo(tok.deleg_acc!, "GET", "/relay-registrations?status=confirmed")).not.toBe(DESHABILITADA);
    await configurar(["delegate:menu.inscripciones", "delegate:menu.relevos"]);
    expect(await codigo(tok.deleg_acc!, "GET", `/competitions/${UUID}/enabled-events`)).toBe(DESHABILITADA);
  });

  it("lista operativa frente a historial en la misma ruta", async () => {
    await configurar(["delegate:inscripciones.historial", "delegate:relevos.historial"]);
    expect(await codigo(tok.deleg_acc!, "GET", "/registrations?status=confirmed")).not.toBe(DESHABILITADA);
    expect(await codigo(tok.deleg_acc!, "GET", "/registrations?status=cancelled")).toBe(DESHABILITADA);
    expect(await codigo(tok.deleg_acc!, "GET", "/registrations")).toBe(DESHABILITADA);
    expect(await codigo(tok.deleg_acc!, "GET", "/relay-registrations?status=confirmed")).not.toBe(DESHABILITADA);
    expect(await codigo(tok.deleg_acc!, "GET", "/relay-registrations?status=cancelled")).toBe(DESHABILITADA);
  });

  it("los asistentes usan las mismas operaciones: quedan cubiertos", async () => {
    await configurar(["delegate:inscripciones.crear"]);
    // El asistente de inscripción consulta estas lecturas y crea con POST /registrations.
    expect(await codigo(tok.deleg_acc!, "GET", "/registrations/available-events")).not.toBe(DESHABILITADA);
    expect(await codigo(tok.deleg_acc!, "POST", "/registrations", {})).toBe(DESHABILITADA);
  });

  it("incorporaciones: cuota y periodo vigente sirven a postular y a los listados", async () => {
    await configurar(["delegate:incorporaciones.postular"]);
    expect(await codigo(tok.deleg_acc!, "GET", "/swimmer-assignments/cuota")).not.toBe(DESHABILITADA);
    expect(await codigo(tok.deleg_acc!, "POST", "/swimmer-assignments", {})).toBe(DESHABILITADA);
    await configurar(["delegate:incorporaciones.postular", "delegate:incorporaciones.listados"]);
    expect(await codigo(tok.deleg_acc!, "GET", "/swimmer-assignments/cuota")).toBe(DESHABILITADA);
  });
});

describe("club no operativo y alcance", () => {
  it("se evalúa sobre los roles efectivos ya reducidos, con la misma sesión", async () => {
    await configurar(["swimmer:reportes.generar"]);
    // Club B activo: el rol de delegado suma y lo permite.
    expect(await codigo(tok.deleg_nada_b!, "GET", "/reports/registrations")).not.toBe(DESHABILITADA);
    await prisma.club.update({ where: { id: ids.clubB }, data: { status: "disabled" } });
    // Club B no operativo: queda solo el rol de nadador, que lo tiene apagado.
    expect(await codigo(tok.deleg_nada_b!, "GET", "/reports/registrations")).toBe(DESHABILITADA);
    // Lo que el nadador no tiene no se concede: la postulación sigue rechazada por permiso.
    expect(await codigo(tok.deleg_nada_b!, "POST", "/swimmer-assignments", {})).toBe("403 FORBIDDEN");
  });

  it("el alcance por club no cambia con la configuración encendida", async () => {
    expect(await codigo(tok.deleg_acc!, "GET", `/registrations/club-swimmers?clubId=${ids.clubB}`)).toMatch(/^403 /);
    expect(await codigo(tok.deleg_acc!, "GET", `/registrations/club-swimmers?clubId=${ids.clubB}`)).not.toBe(DESHABILITADA);
  });
});

describe("cambio de contraseña", () => {
  it("voluntario apagado → FUNCION_DESHABILITADA; el obligatorio sigue disponible", async () => {
    await configurar(["swimmer:cuenta.cambio_voluntario_contrasena"]);
    expect(
      await codigo(tok.nada_acc!, "POST", "/auth/change-password", { currentPassword: TEST_PASSWORD, newPassword: "OtraClave12345", confirmPassword: "OtraClave12345" })
    ).toBe(DESHABILITADA);
    const obligado = await login("nada_obligado");
    const res = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: auth(obligado),
      payload: { currentPassword: TEST_PASSWORD, newPassword: "OtraClave12345", confirmPassword: "OtraClave12345" },
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe("persistencia, concurrencia y auditoría", () => {
  it("guardado: versión +1, auditoría con actor y solo las diferencias, en la misma transacción", async () => {
    const v0 = (await leer()).version;
    const auditoriasAntes = await prisma.auditLog.count({ where: { action: "ROLE_ACCESS_UPDATED" } });
    await configurar(["coach:reportes.exportar"]);
    const cfg = await leer();
    expect(cfg.version).toBe(v0 + 1);
    expect(cfg.ultimaModificacion?.por?.username).toBe("admin_acc");
    const registro = await prisma.auditLog.findFirstOrThrow({ where: { action: "ROLE_ACCESS_UPDATED" }, orderBy: { createdAt: "desc" } });
    expect(await prisma.auditLog.count({ where: { action: "ROLE_ACCESS_UPDATED" } })).toBe(auditoriasAntes + 1);
    expect(registro.userId).toBe(ids.admin);
    expect(registro.before).toEqual({ version: v0, celdas: [{ rol: "coach", funcion: "reportes.exportar", habilitada: true }] });
    expect(registro.after).toEqual({ version: v0 + 1, celdas: [{ rol: "coach", funcion: "reportes.exportar", habilitada: false }] });
    expect(await prisma.accesoPorRol.findMany({ select: { rol: true, funcion: true, habilitada: true } })).toEqual([{ rol: "coach", funcion: "reportes.exportar", habilitada: false }]);
  });

  it("guardar sin cambios no sube la versión ni audita", async () => {
    const v = (await leer()).version;
    const n = await prisma.auditLog.count({ where: { action: "ROLE_ACCESS_UPDATED" } });
    const res = await guardar(todoEncendido(), v);
    expect(res.statusCode).toBe(200);
    expect(res.json().cambios).toBe(0);
    expect((await leer()).version).toBe(v);
    expect(await prisma.auditLog.count({ where: { action: "ROLE_ACCESS_UPDATED" } })).toBe(n);
  });

  it("versión desactualizada → 409 CONFIGURACION_CAMBIADA con el estado vigente, sin escribir", async () => {
    const v = (await leer()).version;
    expect((await guardar(con(["delegate:reportes.generar"]), v, tok.admin_acc2!)).statusCode).toBe(200);
    const n = await prisma.auditLog.count({ where: { action: "ROLE_ACCESS_UPDATED" } });
    const res = await guardar(con(["coach:reportes.generar"]), v);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("CONFIGURACION_CAMBIADA");
    expect(res.json().details.vigente.version).toBe(v + 1);
    expect(res.json().details.vigente.valores.delegate["reportes.generar"]).toBe(false);
    expect((await leer()).valores.coach!["reportes.generar"]).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: "ROLE_ACCESS_UPDATED" } })).toBe(n);
  });

  it("dos guardados simultáneos con la misma versión: uno gana y el otro recibe 409", async () => {
    const v = (await leer()).version;
    const [a, b] = await Promise.all([guardar(con(["delegate:menu.relevos"]), v), guardar(con(["coach:menu.relevos"]), v, tok.admin_acc2!)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect((await leer()).version).toBe(v + 1);
  });

  it("un fallo dentro de la transacción no deja nada a medias (ni filas, ni versión, ni auditoría)", async () => {
    const v = (await leer()).version;
    const n = await prisma.auditLog.count({ where: { action: "ROLE_ACCESS_UPDATED" } });
    // Un autor inexistente viola la clave foránea al escribir: la transacción entera se revierte.
    await expect(guardarConfiguracion({ version: v, valores: con(["delegate:reportes.generar"]) }, { userId: UUID })).rejects.toThrow();
    expect((await leer()).version).toBe(v);
    expect(await prisma.accesoPorRol.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "ROLE_ACCESS_UPDATED" } })).toBe(n);
  });

  it("rechaza combinaciones fuera del catálogo y exige administración", async () => {
    const v = (await leer()).version;
    const malo = todoEncendido();
    malo.swimmer!["relevos.armar"] = false;
    expect((await guardar(malo, v)).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/accesos-por-rol", headers: auth(tok.deleg_acc!), payload: { version: v, valores: todoEncendido() } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/accesos-por-rol", headers: auth(tok.deleg_acc!) })).statusCode).toBe(403);
  });
});

describe("fallos de carga", () => {
  it("sin la fila de versión: 503 técnico, nunca acceso concedido, y la sesión sigue", async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "configuracion_accesos" WHERE id = 1`);
    try {
      const res = await app.inject({ method: "GET", url: "/reports/registrations", headers: auth(tok.deleg_acc!) });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe("CONFIGURACION_ACCESOS_NO_DISPONIBLE");
      // La sesión no se cierra: /auth/me sigue respondiendo.
      expect((await app.inject({ method: "GET", url: "/auth/me", headers: auth(tok.deleg_acc!) })).statusCode).toBe(200);
      // Administración y roles no configurables no dependen de la configuración.
      expect((await app.inject({ method: "GET", url: "/reports/registrations", headers: auth(tok.club_acc_a!) })).statusCode).not.toBe(503);
    } finally {
      await prisma.$executeRawUnsafe(`INSERT INTO "configuracion_accesos" ("id", "version") VALUES (1, 0) ON CONFLICT ("id") DO NOTHING`);
      olvidarCacheDeAccesos();
    }
  });
});

describe("Team Manager se conserva", () => {
  it("con Reportes apagado, su exportador no responde FUNCION_DESHABILITADA", async () => {
    await configurar(["delegate:menu.reportes", "delegate:reportes.generar", "delegate:reportes.exportar"]);
    expect(await codigo(tok.deleg_acc!, "GET", "/export/team-manager/zip")).not.toBe(DESHABILITADA);
    expect(await codigo(tok.deleg_acc!, "GET", "/export/team-manager/hy3")).not.toBe(DESHABILITADA);
  });
});
