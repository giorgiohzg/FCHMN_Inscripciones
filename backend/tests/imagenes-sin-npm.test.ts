/**
 * GUARDA: las imágenes que se EJECUTAN (`runtime`, `migrate` y el alias `mantenimiento`) no llevan npm ni npx.
 *
 * `backend/Dockerfile` construye con npm (`build`, `deps`, `cli-migrate`, todas desde `base`) y ejecuta desde
 * `ejecucion`, que es `base` sin la instalación global de npm ni sus enlaces. Esta prueba fija esa forma y que
 * los comandos operativos (Compose y README) usen comandos directos, sin `npm`/`npx` dentro del contenedor.
 *
 * QUÉ NO COMPRUEBA. No construye ni ejecuta imágenes: que `npm`/`npx` no estén en la imagen final, que Node y
 * Prisma funcionen y que los seeds corran se comprobó con las imágenes candidatas (ver el plan de seguridad).
 * Tampoco puede comprobar que los bytes desaparezcan: un `rm` en una capa nueva solo los oculta.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const RAIZ = path.join(__dirname, "..", "..");
const leer = (...p: string[]) => readFileSync(path.join(RAIZ, ...p), "utf8").replace(/\r\n/g, "\n");
const FUENTE = leer("backend", "Dockerfile");
const COMPOSE = leer("docker-compose.yml");
const README = leer("README.md");

/** Etapas `FROM <origen> AS <nombre>` en orden, y el cuerpo sin comentarios de cada una. */
function etapas(texto: string) {
  const lineas = texto.split("\n");
  const r: { nombre: string; origen: string; cuerpo: string[] }[] = [];
  for (const l of lineas) {
    const m = /^FROM\s+(\S+)\s+AS\s+(\S+)\s*$/i.exec(l);
    if (m) { r.push({ origen: m[1]!, nombre: m[2]!, cuerpo: [] }); continue; }
    if (r.length && l.trim() && !l.trim().startsWith("#")) r.at(-1)!.cuerpo.push(l.trim());
  }
  return r;
}

describe("backend/Dockerfile", () => {
  const e = etapas(FUENTE);
  const de = (n: string) => e.find((x) => x.nombre === n)!;

  it("construye desde `base` (con npm) y ejecuta desde `ejecucion` (sin npm)", () => {
    for (const n of ["build", "deps", "cli-migrate", "ejecucion"]) expect(de(n).origen, n).toBe("base");
    for (const n of ["runtime", "migrate"]) expect(de(n).origen, n).toBe("ejecucion");
  });

  it("`ejecucion` retira exactamente la instalación global de npm y sus dos enlaces, y nada más", () => {
    expect(de("ejecucion").cuerpo).toEqual(["RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx"]);
  });

  it("ni `runtime` ni `migrate` invocan npm o npx", () => {
    for (const n of ["runtime", "migrate"]) {
      for (const l of de(n).cuerpo) expect(l, `${n}: ${l}`).not.toMatch(/\b(npm|npx)\b/);
    }
  });

  it("`runtime` sigue siendo la última etapa y arranca con node", () => {
    expect(e.at(-1)!.nombre).toBe("runtime");
    expect(de("runtime").cuerpo).toContain('CMD ["node", "dist/server.js"]');
  });
});

describe("comandos operativos con la imagen `migrate`", () => {
  it("el perfil `mantenimiento` de Compose usa el CLI de Prisma y el seed compilado, sin npm ni npx", () => {
    const bloque = COMPOSE.slice(COMPOSE.indexOf("\n  migrate:\n"), COMPOSE.indexOf("\n  backend:\n"));
    const comando = /^\s*command:\s*(.+)$/m.exec(bloque)![1]!;
    expect(comando).toBe('sh -c "prisma migrate deploy --schema=/app/prisma/schema.prisma && node dist-seed/prisma/seed.js"');
    expect(comando).not.toMatch(/\b(npm|npx)\b|db seed/);
  });

  it("los ejemplos de Compose y README sobre `migrate` no usan npm ni npx", () => {
    for (const [nombre, texto] of [["docker-compose.yml", COMPOSE], ["README.md", README]] as const) {
      for (const l of texto.split("\n").filter((x) => x.includes("run --rm migrate"))) {
        expect(l, `${nombre}: ${l.trim()}`).not.toMatch(/run --rm migrate\s+(npm|npx)\b/);
      }
    }
    expect(COMPOSE).toContain("run --rm migrate node dist-seed/prisma/seed-admin.js");
    expect(README).toContain("run --rm migrate node dist-seed/prisma/seed-admin.js");
  });
});
