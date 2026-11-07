/**
 * La SONDA del inventario de avisos de terceros (`scripts/inventario/extraer-de-imagen.cjs`).
 *
 * La sonda leía solo el primer nivel de `node_modules`, así que los paquetes ANIDADOS (por ejemplo,
 * `glob/node_modules/minimatch`) no figuraban en los avisos. Que dos extracciones dieran lo mismo no
 * lo detectaba: las dos omitían igual. Estas pruebas parten de un árbol SINTÉTICO en un directorio
 * temporal, con la respuesta correcta conocida de antemano, y comprueban:
 *   - que aparece todo lo anidado, con ámbito y con versiones distintas;
 *   - que el lector ANTERIOR (reproducido aquí) lo habría omitido, de modo que la prueba lo detecta;
 *   - cómo se tratan los duplicados, los enlaces (ciclos y salidas de la raíz) y el resto de carpetas.
 *
 * Nunca toca el `node_modules` real ni crea enlaces hacia él.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

const SONDA = join(__dirname, "..", "..", "scripts", "inventario", "extraer-de-imagen.cjs");

interface Texto { archivo: string; sha256: string; texto: string }
interface Entrada {
  nombre: string; version: string | null; expresion: string | null; base: string; rutas: string[];
  archivosLicencia: string[]; tieneNotice: boolean; textos: Texto[];
}

let TMP: string;
beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "sonda-inventario-"));
});
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

let contador = 0;
/** Un directorio de trabajo nuevo y vacío para cada prueba. */
function nuevoArbol(): string {
  const dir = join(TMP, `arbol-${++contador}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface Opciones { licencia?: string | null; notice?: string; expresion?: string }
/** Crea `<nodeModules>/<nombre>/package.json` (+ LICENSE y NOTICE opcionales) y devuelve el directorio del paquete. */
function paquete(nodeModules: string, nombre: string, version: string, o: Opciones = {}): string {
  const dir = join(nodeModules, ...nombre.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: nombre, version, license: o.expresion ?? "MIT" }));
  if (o.licencia !== null) writeFileSync(join(dir, "LICENSE"), o.licencia ?? `Licencia de ${nombre} ${version}\n`);
  if (o.notice) writeFileSync(join(dir, "NOTICE"), o.notice);
  return dir;
}
const anidado = (dirPaquete: string) => join(dirPaquete, "node_modules");

function sonda(...bases: string[]) {
  const r = spawnSync(process.execPath, [SONDA, "sintetico", ...bases], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`la sonda falló (${r.status}): ${r.stderr}`);
  const salida = JSON.parse(r.stdout) as { node: Entrada[] };
  return { node: salida.node, stdout: r.stdout, stderr: r.stderr };
}

/** `nombre@version` de cada UBICACIÓN que la sonda declara (una entrada puede tener varias rutas). */
function ubicaciones(node: Entrada[]): string[] {
  return node.flatMap((e) => e.rutas.map((r) => `${r}@${e.version}`)).sort();
}

/**
 * ENUMERACIÓN INDEPENDIENTE: recorre TODO el árbol sin usar la lógica de la sonda y cuenta como paquete
 * cada directorio que tiene `package.json` y cuyo padre es un `node_modules` (o un `@ámbito` dentro de uno).
 */
function enumeracionIndependiente(base: string): string[] {
  const salida: string[] = [];
  const visitar = (dir: string) => {
    for (const nombre of readdirSync(dir)) {
      const ruta = join(dir, nombre);
      if (!statSync(ruta).isDirectory()) continue;
      const partes = relative(dirname(base), ruta).split(sep); // empieza por "node_modules"
      const padre = partes[partes.length - 2];
      const abuelo = partes[partes.length - 3];
      const esPaquete =
        !nombre.startsWith(".") &&
        existsSync(join(ruta, "package.json")) &&
        (padre === "node_modules" || (padre?.startsWith("@") && abuelo === "node_modules"));
      if (esPaquete) {
        const rel = partes.slice(1).join("/");
        const version = JSON.parse(readFileSync(join(ruta, "package.json"), "utf8")).version;
        salida.push(`${rel}@${version}`);
      }
      if (nombre !== ".bin") visitar(ruta);
    }
  };
  visitar(base);
  return salida.sort();
}

/** El lector ANTERIOR, tal como era: solo el primer nivel (y los ámbitos). */
function lectorAnterior(base: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(base)) {
    if (entrada.startsWith(".")) continue;
    const ruta = join(base, entrada);
    if (!statSync(ruta).isDirectory()) continue;
    const hijos = entrada.startsWith("@") ? readdirSync(ruta).map((n) => `${entrada}/${n}`) : [entrada];
    for (const h of hijos) {
      const pj = join(base, ...h.split("/"), "package.json");
      if (existsSync(pj)) salida.push(`${h}@${JSON.parse(readFileSync(pj, "utf8")).version}`);
    }
  }
  return salida.sort();
}

/** Un árbol con raíz, ámbito, anidados, versiones distintas del mismo paquete y un anidado con ámbito. */
function arbolBase(): string {
  const nm = join(nuevoArbol(), "node_modules");
  mkdirSync(nm);
  const glob = paquete(nm, "glob", "14.0.4");
  paquete(anidado(glob), "minimatch", "11.0.5");
  const mm = join(anidado(glob), "minimatch");
  paquete(anidado(mm), "brace-expansion", "5.0.12");
  paquete(nm, "minimatch", "10.2.6"); // la MISMA librería en otra versión, en la raíz
  paquete(nm, "@fastify/static", "10.1.10", { notice: "Aviso propio de @fastify/static\n" });
  paquete(anidado(join(nm, "@fastify", "static")), "@scope/interno", "1.0.0"); // con ámbito y anidado
  paquete(nm, "ajv", "8.20.0");
  paquete(anidado(join(nm, "ajv")), "fast-uri", "3.1.9");
  paquete(nm, "fast-uri", "4.2.3");
  return nm;
}

describe("raíz, anidados, ámbitos y versiones distintas", () => {
  it("encuentra TODAS las ubicaciones, con sus rutas relativas a la raíz declarada", () => {
    const nm = arbolBase();

    const { node } = sonda(nm);

    expect(ubicaciones(node)).toEqual(
      [
        "@fastify/static@10.1.10",
        "@fastify/static/node_modules/@scope/interno@1.0.0",
        "ajv@8.20.0",
        "ajv/node_modules/fast-uri@3.1.9",
        "fast-uri@4.2.3",
        "glob@14.0.4",
        "glob/node_modules/minimatch@11.0.5",
        "glob/node_modules/minimatch/node_modules/brace-expansion@5.0.12",
        "minimatch@10.2.6",
      ].sort()
    );
  });

  it("conserva las DOS versiones de un mismo paquete como entradas distintas", () => {
    const { node } = sonda(arbolBase());

    const minimatch = node.filter((e) => e.nombre === "minimatch").map((e) => e.version);
    const fastUri = node.filter((e) => e.nombre === "fast-uri").map((e) => e.version);
    expect(minimatch).toEqual(["10.2.6", "11.0.5"]);
    expect(fastUri).toEqual(["3.1.9", "4.2.3"]);
  });

  it("coincide con una enumeración INDEPENDIENTE del árbol (no solo consigo misma)", () => {
    const nm = arbolBase();

    const { node } = sonda(nm);

    expect(ubicaciones(node)).toEqual(enumeracionIndependiente(nm));
  });

  it("DETECTA LA OMISIÓN del lector anterior: lo que él habría dado NO coincide con lo que hay", () => {
    const nm = arbolBase();
    const real = enumeracionIndependiente(nm);

    const anterior = lectorAnterior(nm);

    expect(anterior.length).toBeLessThan(real.length);
    const omitidos = real.filter((u) => !anterior.includes(u));
    expect(omitidos).toEqual(
      expect.arrayContaining([
        "glob/node_modules/minimatch@11.0.5",
        "glob/node_modules/minimatch/node_modules/brace-expansion@5.0.12",
        "ajv/node_modules/fast-uri@3.1.9",
      ])
    );
    // Y la sonda nueva sí los trae.
    const nuevos = ubicaciones(sonda(nm).node);
    for (const o of omitidos) expect(nuevos).toContain(o);
  });

  it("conserva licencia y NOTICE de un paquete anidado y de uno con ámbito", () => {
    const nm = arbolBase();

    const { node } = sonda(nm);

    const estatico = node.find((e) => e.nombre === "@fastify/static");
    expect(estatico?.tieneNotice).toBe(true);
    expect(estatico?.archivosLicencia).toEqual(["LICENSE", "NOTICE"]);
    expect(estatico?.textos.find((t) => t.archivo === "NOTICE")?.texto).toBe("Aviso propio de @fastify/static\n");
    const anidadoMin = node.find((e) => e.nombre === "minimatch" && e.version === "11.0.5");
    expect(anidadoMin?.textos[0]?.texto).toBe("Licencia de minimatch 11.0.5\n");
    expect(anidadoMin?.base).toBe(nm);
  });
});

describe("duplicados: se agrupan sin perder ninguna ubicación", () => {
  it("el mismo paquete, versión y licencia en varios sitios es UNA entrada con todas sus rutas", () => {
    const nm = join(nuevoArbol(), "node_modules");
    mkdirSync(nm);
    for (const padre of ["x", "y", "z"]) {
      const p = paquete(nm, padre, "1.0.0");
      paquete(anidado(p), "glob", "7.2.3", { licencia: "Licencia idéntica de glob\n" });
    }

    const { node } = sonda(nm);

    const globs = node.filter((e) => e.nombre === "glob");
    expect(globs).toHaveLength(1);
    expect(globs[0]?.rutas).toEqual(["x/node_modules/glob", "y/node_modules/glob", "z/node_modules/glob"]);
  });

  it("misma versión pero DISTINTA licencia: NO se fusionan", () => {
    const nm = join(nuevoArbol(), "node_modules");
    mkdirSync(nm);
    paquete(anidado(paquete(nm, "x", "1.0.0")), "dup", "1.0.0", { licencia: "Texto A\n" });
    paquete(anidado(paquete(nm, "y", "1.0.0")), "dup", "1.0.0", { licencia: "Texto B\n" });

    const { node } = sonda(nm);

    const dups = node.filter((e) => e.nombre === "dup");
    expect(dups).toHaveLength(2);
    expect(dups.map((d) => d.textos[0]?.texto).sort()).toEqual(["Texto A\n", "Texto B\n"]);
  });

  it("misma versión con distinta EXPRESIÓN de licencia declarada: tampoco se fusionan", () => {
    const nm = join(nuevoArbol(), "node_modules");
    mkdirSync(nm);
    paquete(anidado(paquete(nm, "x", "1.0.0")), "dup", "1.0.0", { expresion: "MIT" });
    paquete(anidado(paquete(nm, "y", "1.0.0")), "dup", "1.0.0", { expresion: "ISC" });

    expect(sonda(nm).node.filter((e) => e.nombre === "dup")).toHaveLength(2);
  });

  it("raíces distintas son entradas distintas aunque el paquete y la versión coincidan", () => {
    const a = join(nuevoArbol(), "node_modules");
    const b = join(nuevoArbol(), "node_modules");
    mkdirSync(a);
    mkdirSync(b);
    paquete(a, "comun", "1.0.0");
    paquete(b, "comun", "1.0.0");

    const { node } = sonda(a, b);

    expect(node.filter((e) => e.nombre === "comun").map((e) => e.base).sort()).toEqual([a, b].sort());
  });
});

describe("límites del recorrido", () => {
  it("solo entra en <paquete>/node_modules: no recorre las demás carpetas de un paquete", () => {
    const nm = join(nuevoArbol(), "node_modules");
    mkdirSync(nm);
    const p = paquete(nm, "a", "1.0.0");
    // Un node_modules que NO cuelga directamente del paquete (por ejemplo, un ejemplo o un fixture).
    paquete(join(p, "lib", "node_modules"), "oculto", "9.9.9");
    paquete(join(p, "examples", "demo", "node_modules"), "otro", "8.8.8");
    paquete(anidado(p), "visible", "1.0.0");

    const { node } = sonda(nm);

    expect(node.map((e) => e.nombre).sort()).toEqual(["a", "visible"]);
  });

  it("ignora .bin y cualquier entrada que empiece por punto, también dentro de un anidado", () => {
    const nm = join(nuevoArbol(), "node_modules");
    mkdirSync(nm);
    paquete(nm, ".bin", "0.0.0");
    paquete(nm, ".prisma", "0.0.0");
    const p = paquete(nm, "a", "1.0.0");
    paquete(anidado(p), ".cache", "0.0.0");
    paquete(anidado(p), "b", "1.0.0");

    expect(ubicaciones(sonda(nm).node)).toEqual(["a@1.0.0", "a/node_modules/b@1.0.0"].sort());
  });

  it("un directorio sin package.json no es un paquete ni se recorre", () => {
    const nm = join(nuevoArbol(), "node_modules");
    mkdirSync(join(nm, "sin-manifiesto", "node_modules"), { recursive: true });
    paquete(join(nm, "sin-manifiesto", "node_modules"), "dentro", "1.0.0");
    paquete(nm, "real", "1.0.0");

    expect(sonda(nm).node.map((e) => e.nombre)).toEqual(["real"]);
  });

  it("una raíz que no existe no hace fallar la sonda", () => {
    expect(sonda(join(TMP, "no-existe")).node).toEqual([]);
  });

  it("el orden es determinista: dos ejecuciones dan exactamente la misma salida", () => {
    const nm = arbolBase();

    const a = sonda(nm).stdout;
    const b = sonda(nm).stdout;

    expect(a).toBe(b);
    const nombres = (JSON.parse(a) as { node: Entrada[] }).node.map((e) => `${e.nombre}@${e.version}`);
    expect(nombres).toEqual([...nombres].sort((x, y) => x.localeCompare(y)));
  });
});

describe("enlaces simbólicos (solo dentro de un árbol sintético)", () => {
  /** Crea un enlace de directorio; en Windows, una unión (no pide privilegios). Devuelve false si el sistema no lo permite. */
  function enlazar(destino: string, ruta: string): boolean {
    try {
      symlinkSync(destino, ruta, process.platform === "win32" ? "junction" : "dir");
      return true;
    } catch {
      return false;
    }
  }

  it("un ciclo de enlaces no cuelga la sonda ni duplica paquetes", () => {
    const nm = join(nuevoArbol(), "node_modules");
    mkdirSync(nm);
    const a = paquete(nm, "a", "1.0.0");
    mkdirSync(anidado(a), { recursive: true });
    if (!enlazar(a, join(anidado(a), "ciclo"))) return; // sin permiso para enlaces: no se puede ejercitar

    const { node } = sonda(nm);

    expect(node.filter((e) => e.nombre === "a")).toHaveLength(1);
    expect(node.some((e) => e.nombre === "ciclo")).toBe(false);
  });

  it("un enlace hacia FUERA de la raíz autorizada se ignora", () => {
    const fuera = join(nuevoArbol(), "node_modules-ajeno");
    mkdirSync(fuera);
    paquete(fuera, "intruso", "6.6.6");
    const nm = join(nuevoArbol(), "node_modules");
    mkdirSync(nm);
    const a = paquete(nm, "a", "1.0.0");
    mkdirSync(anidado(a), { recursive: true });
    if (!enlazar(join(fuera, "intruso"), join(anidado(a), "intruso"))) return;

    const { node } = sonda(nm);

    expect(node.map((e) => e.nombre)).toEqual(["a"]);
  });
});

describe("licencia en el README (caso acotado de isarray 1.0.0)", () => {
  /** Texto SINTÉTICO con la forma de una sección de licencia: copyright, concesión y exclusión de garantías. */
  const SECCION =
    "## License\n\n(MIT)\n\nCopyright (c) 2013 Titular Sintetico &lt;titular@example.invalid&gt;\n\n" +
    "Permission is hereby granted, free of charge, to any person obtaining a copy of\nthis software (CONCESION SINTETICA).\n\n" +
    "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND (EXCLUSION SINTETICA).\n";
  const ANTES = "# isarray\n\nDescripcion.\n\n```bash\n# esto no es un encabezado\n$ instalar\n```\n\n";

  function sinArchivoDeLicencia(nm: string, nombre: string, version: string, readme: string): void {
    const dir = paquete(nm, nombre, version, { licencia: null });
    writeFileSync(join(dir, "README.md"), readme);
  }
  const nuevaRaiz = () => {
    const nm = join(nuevoArbol(), "node_modules");
    mkdirSync(nm);
    return nm;
  };

  it("incorpora la sección «License» TAL CUAL, con su procedencia, hash y tamaño", () => {
    const nm = nuevaRaiz();
    sinArchivoDeLicencia(nm, "isarray", "1.0.0", ANTES + SECCION);

    const e = sonda(nm).node[0];

    expect(e?.archivosLicencia).toEqual([]); // no hay archivo de licencia: no se finge uno
    expect(e?.textos).toHaveLength(1);
    const t = e!.textos[0] as Texto & { seccion: string; bytes: number };
    expect(t.archivo).toBe("README.md");
    expect(t.seccion).toBe("License");
    expect(t.texto).toBe(SECCION); // byte a byte: copyright, concesión, exclusión y las entidades sin decodificar
    expect(t.sha256).toBe(sha(SECCION));
    expect(t.bytes).toBe(Buffer.byteLength(SECCION, "utf8"));
    expect(t.texto).toContain("&lt;titular@example.invalid&gt;");
    expect(t.texto).toContain("CONCESION SINTETICA");
    expect(t.texto).toContain("EXCLUSION SINTETICA");
  });

  it("la sección termina en el siguiente encabezado del mismo nivel o superior, y conserva los subencabezados", () => {
    const nm = nuevaRaiz();
    sinArchivoDeLicencia(nm, "isarray", "1.0.0", `${ANTES}${SECCION}\n### Nota\n\nSubapartado de la licencia.\n\n## Otra seccion\n\nNo es licencia.\n`);

    const t = sonda(nm).node[0]?.textos[0];

    expect(t?.texto).toBe(`${SECCION}\n### Nota\n\nSubapartado de la licencia.\n\n`);
    expect(t?.texto).not.toContain("Otra seccion");
  });

  it("un README sin sección «License» no produce texto (falla cerrado: seguirá exigiendo una excepción)", () => {
    const nm = nuevaRaiz();
    sinArchivoDeLicencia(nm, "isarray", "1.0.0", "# isarray\n\nSolo descripcion.\n");

    expect(sonda(nm).node[0]?.textos).toEqual([]);
  });

  it("NO es un detector genérico: otro paquete, u otra versión, con la misma sección no se lee", () => {
    const nm = nuevaRaiz();
    sinArchivoDeLicencia(nm, "otro-paquete", "1.0.0", ANTES + SECCION);
    sinArchivoDeLicencia(nm, "isarray", "1.0.1", ANTES + SECCION);

    const { node } = sonda(nm);

    expect(node.map((e) => `${e.nombre}@${e.version}:${e.textos.length}`).sort()).toEqual(["isarray@1.0.1:0", "otro-paquete@1.0.0:0"]);
  });

  it("si el paquete trae archivo de licencia, manda el archivo y el README no se usa", () => {
    const nm = nuevaRaiz();
    const dir = paquete(nm, "isarray", "1.0.0", { licencia: "Texto del archivo LICENSE\n" });
    writeFileSync(join(dir, "README.md"), ANTES + SECCION);

    const textos = sonda(nm).node[0]?.textos;

    expect(textos?.map((t) => t.archivo)).toEqual(["LICENSE"]);
  });

  it("un # dentro de un bloque de código no cierra la sección", () => {
    const nm = nuevaRaiz();
    const conCodigo = "## License\n\n(MIT)\n\n```bash\n# comentario de shell, no un encabezado\n```\n\nCopyright (c) 2013 Titular\n";
    sinArchivoDeLicencia(nm, "isarray", "1.0.0", conCodigo);

    expect(sonda(nm).node[0]?.textos[0]?.texto).toBe(conCodigo);
  });
});

describe("el inventario versionado registra el texto REAL de isarray 1.0.0", () => {
  const RAIZ = join(__dirname, "..", "..");
  const SHA_DEL_TEXTO = "66aa9feab8bb39aceebd69f2a357015d57ceab486d3c7a19ff8d3d4110a6d101";

  it.each(["backend", "migrate"])("%s: el paquete lleva licencia desde la sección License del README, con hash y tamaño", (artefacto) => {
    const inv = JSON.parse(readFileSync(join(RAIZ, "notices", "inventario", `${artefacto}.json`), "utf8")) as {
      node: Array<{ nombre: string; version: string; rutas: string[]; licencias: Array<{ archivo: string; seccion?: string; sha256: string; bytes: number }> }>;
    };

    const isarray = inv.node.filter((p) => p.nombre === "isarray" && p.version === "1.0.0");

    expect(isarray).toHaveLength(1);
    expect(isarray[0]?.rutas).toHaveLength(4); // las cuatro copias instaladas
    expect(isarray[0]?.licencias).toEqual([{ archivo: "README.md", seccion: "License", sha256: SHA_DEL_TEXTO, bytes: 1108 }]);
  });

  it("el texto guardado es el original íntegro: copyright de 2013, concesión y exclusión de garantías", () => {
    const texto = readFileSync(join(RAIZ, "notices", "textos", `${SHA_DEL_TEXTO}.txt`), "utf8");

    expect(sha(texto)).toBe(SHA_DEL_TEXTO);
    expect(Buffer.byteLength(texto, "utf8")).toBe(1108);
    expect(texto.startsWith("## License\n\n(MIT)\n\n")).toBe(true);
    expect(texto).toContain("Copyright (c) 2013 Julian Gruber &lt;julian@juliangruber.com&gt;");
    expect(texto).toContain("Permission is hereby granted, free of charge, to any person obtaining a copy of");
    expect(texto).toContain("The above copyright notice and this permission notice shall be included in all");
    expect(texto).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR');
    expect(texto.trimEnd().endsWith("SOFTWARE.")).toBe(true);
  });

  it("isarray ya no tiene excepción en notices/excepciones.json (el texto está en el artefacto)", () => {
    const exc = JSON.parse(readFileSync(join(RAIZ, "notices", "excepciones.json"), "utf8")) as { casos: Array<{ paquete: string }> };

    expect(exc.casos.some((c) => c.paquete === "isarray")).toBe(false);
  });

  it("los avisos publicados dicen de dónde sale el texto y lo reproducen", () => {
    for (const a of ["backend", "migrate"]) {
      const aviso = readFileSync(join(RAIZ, "notices", `${a}.txt`), "utf8");
      expect(aviso).toContain('(Texto tomado de la seccion "License" de README.md del paquete, que no incluye archivo de licencia.)');
      expect(aviso).toContain("Copyright (c) 2013 Julian Gruber &lt;julian@juliangruber.com&gt;");
    }
  });
});

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
