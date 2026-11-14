/**
 * Preflight de incorporaciones (C-05): el SQL versionado, su ejecutor y cómo entra en la imagen.
 *
 *  - El SQL es EXACTAMENTE el validado (hash), conserva la transacción `BEGIN READ ONLY`, su
 *    comprobación interna, los límites de espera y las dos condiciones de `migrationChecks.ts`.
 *  - El ejecutor falla ANTES de consultar la base si el SQL falta, está vacío o fue alterado, no
 *    imprime la marca de éxito sin un Prisma correcto y no expone la salida original ni el entorno.
 *  - `backend/Dockerfile` copia expresamente solo esos dos archivos en `migrate`, no en `runtime`.
 *
 * Sin base de datos: la ejecución real contra PostgreSQL se valida con la imagen construida.
 * Datos sintéticos.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CHECKS } from "../scripts/migrationChecks";

const DIR = join(__dirname, "..", "operacion");
const SQL = join(DIR, "preflight-incorporaciones.sql");
const EJECUTOR = join(DIR, "preflight-incorporaciones.mjs");
const HASH = "1faaf4f4755c7dbd5cc22fbcbc37b03f5935ef9e5f66b9076354c59f30ac21d0";
const DOCKERFILE = readFileSync(join(__dirname, "..", "Dockerfile"), "utf8");

const normal = (s: string) => s.replace(/\s+/g, " ").trim();
const texto = readFileSync(SQL, "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mod: any;
beforeAll(async () => {
  mod = await import(pathToFileURL(EJECUTOR).href);
});

describe("el SQL versionado", () => {
  it("es exactamente el validado y el ejecutor espera ese mismo hash", () => {
    expect(createHash("sha256").update(readFileSync(SQL)).digest("hex")).toBe(HASH);
    expect(mod.SHA256_ESPERADO).toBe(HASH);
  });

  it("abre BEGIN READ ONLY, lo comprueba dentro y fija los límites de espera", () => {
    expect(texto).toMatch(/^BEGIN READ ONLY;$/m);
    expect(texto).toContain("IF current_setting('transaction_read_only') <> 'on' THEN");
    expect(texto).toContain("SET LOCAL lock_timeout = '5s';");
    expect(texto).toContain("SET LOCAL statement_timeout = '60s';");
    expect(texto).toContain("SET LOCAL idle_in_transaction_session_timeout = '120s';");
    expect(texto).toMatch(/^COMMIT;$/m);
    expect(texto).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT)\b/i);
  });

  it("usa las mismas condiciones que migrationChecks.ts", () => {
    const duplicadas = normal(CHECKS.find((c) => c.id === "propuestas-pendientes-duplicadas")!.query);
    const futuro = normal(CHECKS.find((c) => c.id === "membresias-activas-con-inicio-futuro")!.query);
    const sql = normal(texto);
    for (const parte of ["FROM club_swimmers cs WHERE cs.status::text = 'pending' GROUP BY cs.club_id, cs.person_id HAVING count(*) > 1"]) {
      expect(duplicadas).toContain(parte);
      expect(sql).toContain(parte);
    }
    const condicionFuturo = futuro.slice(futuro.indexOf("FROM club_swimmers cs"), futuro.indexOf(" ORDER BY"));
    expect(condicionFuturo).toMatch(/^FROM club_swimmers cs WHERE cs.status::text = 'active' AND .*::date$/);
    expect(sql).toContain(condicionFuturo);
  });
});

describe("el ejecutor", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "preflight-"));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** Copia el ejecutor junto a un SQL dado (o ninguno) y lo corre sin Prisma en el PATH. */
  function correr(nombre: string, sql: Buffer | null) {
    const dir = mkdtempSync(join(tmp, `${nombre}-`));
    copyFileSync(EJECUTOR, join(dir, "preflight-incorporaciones.mjs"));
    if (sql) writeFileSync(join(dir, "preflight-incorporaciones.sql"), sql);
    const r = spawnSync(process.execPath, [join(dir, "preflight-incorporaciones.mjs")], {
      encoding: "utf8",
      // PATH vacío: si el ejecutor intentara llamar a Prisma, fallaría con 3, no con 2.
      env: { PATH: dir, DATABASE_URL: "postgresql://usuario:CLAVE_SINTETICA_SECRETA@host-sintetico:5432/base" },
      timeout: 30_000,
    });
    return { codigo: r.status, salida: `${r.stdout}${r.stderr}` };
  }

  it.each([
    ["ausente", null, "no existe"],
    ["vacío", Buffer.alloc(0), "está vacío"],
    ["alterado", Buffer.from(texto.replace("> 1", "> 2")), "no coincide"],
  ])("SQL %s: termina con 2 antes de consultar la base, sin marca de éxito", (_c, sql, motivo) => {
    const r = correr(String(_c), sql as Buffer | null);
    expect(r.codigo).toBe(2);
    expect(r.salida).toContain(motivo);
    expect(r.salida).toContain("No se consultó la base");
    expect(r.salida).not.toContain("PREFLIGHT_OK");
  });

  it("si Prisma no puede iniciarse: termina con 3, sin marca de éxito ni secretos", () => {
    const r = correr("sin-prisma", readFileSync(SQL));
    expect(r.codigo).toBe(3);
    expect(r.salida).toContain("PREFLIGHT_ERROR: no se pudo iniciar Prisma");
    expect(r.salida).not.toContain("PREFLIGHT_OK");
    expect(r.salida).not.toMatch(/CLAVE_SINTETICA_SECRETA|postgresql:|host-sintetico/);
  });

  it("clasifica la salida de Prisma sin devolver nunca el texto original", () => {
    expect(mod.clasificarSalida("Error: ERROR: PREFLIGHT_BLOQUEA grupos_pendientes_duplicados=3 membresias_activas_inicio_futuro=0")).toEqual({
      tipo: "bloqueo",
      duplicadas: 3,
      inicioFuturo: 0,
    });
    const original = "Error: P1001 Can't reach database server at `host-sintetico`:5432 user=usuario password=CLAVE_SINTETICA_SECRETA RUN 11.111.111-1";
    const c = mod.clasificarSalida(original);
    expect(c).toEqual({ tipo: "error", detalle: "Prisma informó el código P1001" });
    expect(JSON.stringify(c)).not.toMatch(/host-sintetico|CLAVE|11\.111/);
    expect(mod.clasificarSalida("ERROR: cannot execute UPDATE in a read-only transaction").detalle).toMatch(/solo lectura/);
    expect(mod.clasificarSalida("ERROR: PREFLIGHT_ERROR: la transaccion no es de solo lectura").detalle).toMatch(/solo lectura/);
    expect(mod.clasificarSalida("algo inesperado con datos: Ana Pérez 11.111.111-1")).toEqual({
      tipo: "error",
      detalle: "error no clasificado de Prisma o de la conexión",
    });
  });

  it("ejecuta Prisma sin shell y con argumentos fijos", () => {
    const fuente = readFileSync(EJECUTOR, "utf8");
    expect(fuente).toContain('spawn(binario, ["db", "execute", "--file", rutaSql, "--schema", esquema], { shell: false');
    // Del módulo de procesos solo se importa `spawn` (nada que pase por una shell).
    expect(fuente).toContain('import { spawn } from "node:child_process";');
    expect(fuente).not.toMatch(/\b(execSync|execFile|execFileSync|spawnSync)\b/);
    expect(fuente).not.toMatch(/process\.env/);
  });
});

describe("backend/Dockerfile", () => {
  const etapa = (nombre: string) => {
    const desde = DOCKERFILE.indexOf(`AS ${nombre}\n`);
    const hasta = DOCKERFILE.indexOf("\nFROM ", desde);
    return DOCKERFILE.slice(desde, hasta === -1 ? undefined : hasta);
  };

  it("copia EXPRESAMENTE solo los dos archivos del preflight en `migrate`", () => {
    expect(etapa("migrate")).toContain("COPY operacion/preflight-incorporaciones.sql operacion/preflight-incorporaciones.mjs ./operacion/");
    const copias = DOCKERFILE.split("\n").filter((l) => /^COPY .*operacion/.test(l));
    expect(copias).toHaveLength(1);
    expect(DOCKERFILE).not.toMatch(/^COPY (\.\/)?operacion\/? /m);
    // La carpeta de scripts no se copia a `migrate` (la única copia preexistente es la guarda
    // `verificar-arbol-instalado.mjs` de una etapa de construcción).
    expect(etapa("migrate")).not.toMatch(/^COPY .*scripts/m);
  });

  it("la API (`runtime`) no lleva el preflight y los CMD no cambian", () => {
    expect(etapa("runtime")).not.toContain("operacion");
    expect(etapa("migrate")).toContain('CMD ["prisma", "migrate", "deploy", "--schema=/app/prisma/schema.prisma"]');
  });
});
