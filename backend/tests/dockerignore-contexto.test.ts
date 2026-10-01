/**
 * GUARDA DEL CONTEXTO DE CONSTRUCCIÓN: lo que no debe entrar en la imagen.
 *
 * POR QUÉ EXISTE. Una candidata del backend llevaba dentro cuatro archivos que
 * el repositorio excluye a propósito: tres documentos internos que acompañan a
 * las migraciones y el seed del entorno de revisión visual, que contiene una
 * credencial local. Entraban por `COPY prisma ./prisma`, porque el contexto de
 * construcción no los filtraba. El `.dockerignore` lo corrige; esta prueba
 * impide que vuelvan a colarse.
 *
 * POR QUÉ CON ARCHIVOS SINTÉTICOS. Los archivos reales están ignorados por
 * Git, así que **en un clon limpio no existen**: una prueba que los buscara en
 * el árbol pasaría por vacuidad justo donde debe vigilar. Aquí se fabrica un
 * contexto de mentira, con archivos creados por la propia prueba, y se le
 * aplican las reglas REALES de `backend/.dockerignore`.
 *
 * LIMITACIÓN, DECLARADA SIN RODEOS. Esto comprueba un MODELO de las reglas,
 * escrito más abajo, no el filtro real de Docker. Un modelo puede estar mal y
 * dar un veredicto tranquilizador.
 *
 * El motivo de que aquí haya un modelo y no el filtro real es que el flujo de
 * `.github/workflows/ci.yml` **no construye imágenes**; no que allí falte
 * Docker, porque ese mismo flujo levanta PostgreSQL como contenedor de
 * servicio y el ejecutor lo tiene. Es una limitación del alcance actual de la
 * CI, no una imposibilidad.
 *
 * Por eso el modelo no es la única guarda, y ninguna de las otras dos es
 * opcional:
 *
 *   - `scripts/contraprueba-dockerignore.mjs` construye un contexto sintético
 *     con una imagen `FROM scratch` y comprueba qué dejó pasar el **filtro
 *     real**. Es manual, en la máquina de construcción;
 *   - `scripts/verificar-archivos-de-imagen.mjs` inspecciona las imágenes ya
 *     construidas y es **puerta obligatoria antes de promover**.
 *
 * En resumen: en CI queda el modelo; lo que decide antes de un despliegue son
 * las dos comprobaciones locales.
 *
 * ALCANCE DEL EMPAREJADOR. Reproduce el subconjunto de reglas que este
 * `.dockerignore` usa: patrones anclados a la raíz del contexto, `*` dentro de
 * un segmento, negación con `!` —gana la última regla que coincide— y
 * exclusión de un directorio con todo su contenido. Si algún día el archivo
 * usa algo fuera de ese subconjunto, la prueba **falla diciéndolo** en vez de
 * dar un veredicto que no puede sostener.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DOCKERIGNORE = path.join(__dirname, "..", ".dockerignore");

/** Rutas, relativas al contexto `./backend`, que NO deben entrar jamás. */
const DEBEN_QUEDAR_FUERA = [
  "prisma/migrations/AUDITORIA_MIGRACIONES.md",
  "prisma/migrations/PROPUESTA_SESSION_ID.md",
  "prisma/migrations/PROPUESTA_HALLAZGO_22.md",
  // Sintético: un documento futuro con ese prefijo tiene que quedar fuera sin
  // que nadie se acuerde de añadirlo a ninguna lista.
  "prisma/migrations/PROPUESTA_INVENTADA_PARA_LA_PRUEBA.md",
  "prisma/seed-revision.ts",
  // Los que el archivo ya excluía, para que una edición futura no los pierda.
  ".env",
  "node_modules/alguna-dependencia/index.js",
  "tests/alguna.test.ts",
];

/** Rutas que SÍ deben entrar: la guarda no puede excluir de más. */
const DEBEN_ENTRAR = [
  "prisma/schema.prisma",
  "prisma/seed.ts",
  "prisma/seed-admin.ts",
  "prisma/migrations/migration_lock.toml",
  "prisma/migrations/20260930000000_add_person_admin_access/migration.sql",
  "package.json",
  ".env.example",
  "src/server.ts",
];

interface Regla {
  patron: string;
  negada: boolean;
}

function leerReglas(): Regla[] {
  return fs
    .readFileSync(DOCKERIGNORE, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map((l) => (l.startsWith("!") ? { patron: l.slice(1).trim(), negada: true } : { patron: l, negada: false }));
}

/**
 * Construcciones que este emparejador NO modela.
 *
 * `**` está deliberadamente fuera: hoy no se usa, y modelarlo bien —con sus
 * casos de borde al principio, en medio y al final del patrón— sería escribir
 * un emparejador de verdad. Si alguien lo añade al `.dockerignore`, la primera
 * prueba falla y lo dice, que es mejor que un modelo aproximado dando un
 * veredicto tranquilizador.
 */
function construccionNoSoportada(patron: string): string | null {
  if (patron.includes("**")) return "comodín `**` entre segmentos";
  if (patron.includes("?")) return "comodín `?`";
  if (patron.includes("[")) return "clase de caracteres `[...]`";
  if (patron.startsWith("/")) return "patrón con barra inicial";
  return null;
}

function aExpresion(patron: string): RegExp {
  const cuerpo = patron
    .split("/")
    .map((seg) => seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join("/");
  // Un patrón que nombra un directorio excluye también su contenido.
  return new RegExp("^" + cuerpo + "(?:/.*)?$");
}

/** Decide si una ruta queda fuera del contexto. Gana la última regla. */
function quedaFuera(ruta: string, reglas: Regla[]): boolean {
  let fuera = false;
  for (const r of reglas) {
    if (aExpresion(r.patron).test(ruta)) fuera = !r.negada;
  }
  return fuera;
}

/** Crea el contexto sintético y devuelve las rutas relativas que contiene. */
function fabricarContexto(raiz: string, rutas: string[]): string[] {
  for (const r of rutas) {
    const destino = path.join(raiz, r);
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, `contenido sintetico de ${r}\n`);
  }
  const encontradas: string[] = [];
  (function recorrer(dir: string, prefijo: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefijo ? `${prefijo}/${e.name}` : e.name;
      if (e.isDirectory()) recorrer(path.join(dir, e.name), rel);
      else encontradas.push(rel);
    }
  })(raiz, "");
  return encontradas.sort();
}

let reglas: Regla[];
let temporal: string;
let presentes: string[];

beforeAll(() => {
  reglas = leerReglas();
  temporal = fs.mkdtempSync(path.join(os.tmpdir(), "fchmn-contexto-"));
  presentes = fabricarContexto(temporal, [...DEBEN_QUEDAR_FUERA, ...DEBEN_ENTRAR]);
});

afterAll(() => {
  if (temporal) fs.rmSync(temporal, { recursive: true, force: true });
});

describe("contexto de construcción del backend", () => {
  it("el emparejador entiende todas las reglas del .dockerignore", () => {
    /**
     * Si esta prueba falla, el veredicto de las demás no vale: significaría
     * que el archivo usa una construcción que aquí no se modela.
     */
    const noSoportadas = reglas
      .map((r) => ({ patron: r.patron, motivo: construccionNoSoportada(r.patron) }))
      .filter((x) => x.motivo !== null);
    expect(noSoportadas, JSON.stringify(noSoportadas)).toHaveLength(0);
  });

  it("el contexto sintético se fabricó entero", () => {
    expect(presentes.length).toBe(DEBEN_QUEDAR_FUERA.length + DEBEN_ENTRAR.length);
  });

  it.each(DEBEN_QUEDAR_FUERA)("NO entra en el contexto: %s", (ruta) => {
    expect(presentes, "el archivo sintético debía existir").toContain(ruta);
    expect(quedaFuera(ruta, reglas), `${ruta} debería quedar excluido por .dockerignore`).toBe(true);
  });

  it.each(DEBEN_ENTRAR)("SÍ entra en el contexto: %s", (ruta) => {
    expect(presentes, "el archivo sintético debía existir").toContain(ruta);
    expect(quedaFuera(ruta, reglas), `${ruta} NO debería quedar excluido`).toBe(false);
  });

  it("ningún documento interno de migraciones sobrevive al filtro", () => {
    const supervivientes = presentes.filter((r) => !quedaFuera(r, reglas));
    const sospechosos = supervivientes.filter(
      (r) => /^prisma\/migrations\/[A-Z_]+\.md$/.test(r) || r === "prisma/seed-revision.ts"
    );
    expect(sospechosos, JSON.stringify(sospechosos)).toHaveLength(0);
  });
});
