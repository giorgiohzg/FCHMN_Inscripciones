/**
 * Pruebas de los AVISOS DE TERCEROS.
 *
 * Un aviso de terceros envejece en silencio: se genera una vez, alguien
 * actualiza una dependencia, y el archivo publicado deja de describir lo que
 * se distribuye sin que nada proteste. Estas pruebas son ese protesto.
 *
 * Todas corren SIN RED y sin Docker: operan sobre el inventario ya extraído y
 * sobre los textos guardados. Lo que se comprueba es la coherencia entre
 * inventario, textos, excepciones y avisos publicados.
 *
 * Se comprueban los dos sentidos. Un generador que solo se ha visto aprobar no
 * está probado: hay casos que lo ven FALLAR ante un inventario divergente.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, writeFileSync, rmSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const RAIZ = join(__dirname, "..", "..");
const NOTICES = join(RAIZ, "notices");
const GENERADOR = join(RAIZ, "scripts", "generar-avisos.mjs");

const ARTEFACTOS = ["frontend-web", "frontend-image", "backend", "migrate"] as const;

interface Licencia { archivo: string; sha256: string; bytes: number }
interface PaqueteNode {
  nombre: string; version: string | null; expresion: string | null;
  autor: string | null; repositorio: string | null;
  licencias?: Licencia[]; tieneNotice: boolean;
}
interface PaqueteSistema {
  nombre: string; version: string | null; expresion: string | null;
  origen: string; commit?: string | null; construido?: string | null;
}
interface Suelto { componente: string; ruta: string; sha256: string; bytes: number }
interface Inventario { artefacto: string; node: PaqueteNode[]; sistema: PaqueteSistema[]; sueltos: Suelto[] }

function inventario(a: string): Inventario {
  return JSON.parse(readFileSync(join(NOTICES, "inventario", `${a}.json`), "utf8"));
}
function aviso(a: string): string {
  return readFileSync(join(NOTICES, `${a}.txt`), "utf8");
}
function correrGenerador(args: string[] = []) {
  return spawnSync(process.execPath, [GENERADOR, ...args], { encoding: "utf8", cwd: RAIZ });
}

const excepciones = JSON.parse(readFileSync(join(NOTICES, "excepciones.json"), "utf8"));
const sources = JSON.parse(readFileSync(join(NOTICES, "sources.json"), "utf8"));
const corpus = JSON.parse(readFileSync(join(NOTICES, "corpus.json"), "utf8"));
const avisosFuente = JSON.parse(readFileSync(join(NOTICES, "avisos-fuente.json"), "utf8"));

describe("avisos de terceros: el generador es determinista", () => {
  it("los avisos publicados coinciden con lo que produce el generador", () => {
    const r = correrGenerador(["--verificar"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("dos generaciones seguidas producen los mismos bytes", () => {
    const antes = ARTEFACTOS.map((a) => aviso(a));
    expect(correrGenerador().status).toBe(0);
    const despues = ARTEFACTOS.map((a) => aviso(a));
    expect(despues).toEqual(antes);
  });

  it("no hay marca de tiempo de GENERACIÓN ni rutas del equipo que generó", () => {
    // Las fechas de CONSTRUCCIÓN de cada paquete sí aparecen, y deben: vienen
    // del artefacto y son parte de la procedencia. Lo que rompería el
    // determinismo es una fecha del momento de generar, que es lo que se
    // prohíbe aquí.
    for (const a of ARTEFACTOS) {
      const texto = aviso(a);
      expect(texto, `${a}: no debe fechar su propia generación`)
        .not.toMatch(/Generado[^\n]*\d{4}-\d{2}-\d{2}/);
      expect(texto, `${a}: no debe llevar rutas del equipo que lo generó`).not.toMatch(/[A-Z]:\\Users\\/);
    }
  });

  it("las fechas que aparecen son de construcción del paquete, no de generación", () => {
    const img = aviso("backend");
    const fechas = img.match(/construido el {3}: (\S+)/g) ?? [];
    expect(fechas.length, "deben constar las fechas de construcción").toBeGreaterThan(0);
    // Y deben coincidir con lo que registra el inventario del artefacto.
    // Solo los COPYLEFT llevan bloque de fuente correspondiente: Apache-2.0 no
    // obliga a entregar código, así que sus paquetes no aparecen ahí.
    const inv = inventario("backend");
    for (const p of inv.sistema) {
      if (!/GPL|MPL/i.test(p.expresion ?? "") || !p.construido) continue;
      expect(img, `la fecha de ${p.nombre} no sale del inventario`).toContain(p.construido);
    }
  });
});

describe("avisos de terceros: los textos son íntegros", () => {
  it("cada texto guardado tiene el SHA-256 que lo nombra", () => {
    const dir = join(NOTICES, "textos");
    const archivos = readdirSync(dir).filter((f) => f.endsWith(".txt"));
    expect(archivos.length).toBeGreaterThan(0);
    for (const f of archivos) {
      const contenido = readFileSync(join(dir, f), "utf8");
      const real = createHash("sha256").update(contenido, "utf8").digest("hex");
      expect(real, `${f} no coincide con su propio hash`).toBe(f.replace(/\.txt$/, ""));
    }
  });

  it("todo texto referido por una EXCEPCIÓN existe en disco", () => {
    // Esta comprobación existe porque el volcado del inventario llegó a borrar
    // un texto recuperado de una etiqueta: lo referencia `excepciones.json`,
    // no el inventario, así que la comprobación de abajo no lo cubría.
    for (const c of excepciones.casos) {
      if (c.textoDesde !== "etiqueta") continue;
      expect(existsSync(join(NOTICES, "textos", `${c.sha256}.txt`)),
        `falta el texto recuperado de ${c.paquete}@${c.version}`).toBe(true);
    }
  });

  it("todo texto referido por el inventario existe en disco", () => {
    for (const a of ARTEFACTOS) {
      const inv = inventario(a);
      for (const p of inv.node) {
        for (const l of p.licencias ?? []) {
          expect(existsSync(join(NOTICES, "textos", `${l.sha256}.txt`)),
            `${a}: falta el texto de ${p.nombre}@${p.version}`).toBe(true);
        }
      }
      for (const s of inv.sueltos) {
        expect(existsSync(join(NOTICES, "textos", `${s.sha256}.txt`)),
          `${a}: falta el texto de ${s.componente}`).toBe(true);
      }
    }
  });
});

describe("avisos de terceros: cobertura completa del inventario", () => {
  it.each(ARTEFACTOS)("%s: cada paquete Node aparece en su aviso", (a) => {
    const inv = inventario(a);
    const texto = aviso(a);
    for (const p of inv.node) {
      expect(texto, `${a}: falta ${p.nombre}@${p.version}`).toContain(`${p.nombre}@${p.version}`);
    }
  });

  it.each(ARTEFACTOS)("%s: cada paquete del sistema aparece en su aviso", (a) => {
    const inv = inventario(a);
    const texto = aviso(a);
    for (const p of inv.sistema) {
      expect(texto, `${a}: falta el paquete de sistema ${p.nombre}`).toContain(p.nombre);
    }
  });

  it.each(ARTEFACTOS)("%s: el recuento declarado coincide con el inventario", (a) => {
    const inv = inventario(a);
    const texto = aviso(a);
    if (inv.node.length > 0) expect(texto).toContain(`DEPENDENCIAS NODE  (${inv.node.length} paquetes)`);
    if (inv.sistema.length > 0) expect(texto).toContain(`SISTEMA OPERATIVO  (${inv.sistema.length} paquetes)`);
  });

  it("todo paquete sin texto de licencia tiene excepción declarada", () => {
    const declarados = new Set(excepciones.casos.map((c: { paquete: string; version: string }) => `${c.paquete}@${c.version}`));
    for (const a of ARTEFACTOS) {
      for (const p of inventario(a).node) {
        if ((p.licencias ?? []).length === 0) {
          expect(declarados.has(`${p.nombre}@${p.version}`),
            `${p.nombre}@${p.version} no tiene texto ni excepción`).toBe(true);
        }
      }
    }
  });

  it("toda excepción declara de dónde sale su texto", () => {
    for (const c of excepciones.casos) {
      expect(["artefacto", "etiqueta", "canonico"],
        `${c.paquete}: textoDesde inválido`).toContain(c.textoDesde);
      if (c.textoDesde === "etiqueta") expect(c.sha256, `${c.paquete}: falta sha256`).toBeTruthy();
      if (c.textoDesde === "canonico") expect(c.textoCanonico, `${c.paquete}: falta textoCanonico`).toBeTruthy();
    }
  });
});

describe("avisos de terceros: las obligaciones se declaran por licencia", () => {
  it("todo NOTICE de un paquete Apache se reproduce en el aviso", () => {
    // Apache-2.0 §4(d) solo obliga a reproducir un NOTICE si el paquete lo
    // incluye. Ninguno lo hace hoy; si mañana alguno lo incluyera, esta prueba
    // exige que su texto acabe en el aviso.
    for (const a of ARTEFACTOS) {
      for (const p of inventario(a).node) {
        if (!p.tieneNotice) continue;
        const notice = (p.licencias ?? []).find((l) => l.archivo.toUpperCase().startsWith("NOTICE"));
        expect(notice, `${p.nombre}: declara NOTICE pero no se guardó`).toBeTruthy();
        const texto = readFileSync(join(NOTICES, "textos", `${notice!.sha256}.txt`), "utf8");
        expect(aviso(a), `${a}: el NOTICE de ${p.nombre} no está en el aviso`).toContain(texto.trimEnd());
      }
    }
  });

  it("cada componente copyleft del sistema está en sources.json", () => {
    const registrados = new Set<string>();
    for (const c of sources.componentes) {
      for (const b of c.binarios) registrados.add(`${c.ramaAports}|${b}|${c.versionDistribuida}`);
    }
    const RAMA: Record<string, string> = {
      "frontend-image": "3.21-stable", backend: "3.24-stable", migrate: "3.24-stable",
    };
    for (const a of ["frontend-image", "backend", "migrate"]) {
      for (const p of inventario(a).sistema) {
        if (!/GPL|MPL/i.test(p.expresion ?? "")) continue;
        expect(registrados.has(`${RAMA[a]}|${p.nombre}|${p.version}`),
          `${a}: ${p.nombre}@${p.version} es copyleft y no está en sources.json`).toBe(true);
      }
    }
  });

  it("las expresiones duales declaran la alternativa elegida y las conjuntivas no eligen", () => {
    const porClave = new Map(excepciones.expresionesNoUnicas.map(
      (c: { paquete: string; version: string }) => [`${c.paquete}@${c.version}`, c]));
    for (const a of ARTEFACTOS) {
      for (const p of inventario(a).node) {
        const e = p.expresion ?? "";
        if (!/ OR | AND /.test(e)) continue;
        const c = porClave.get(`${p.nombre}@${p.version}`) as { tipo: string; eleccion: string | null } | undefined;
        expect(c, `${p.nombre}@${p.version}: expresión no única sin registrar`).toBeTruthy();
        if (/ OR /.test(e)) expect(c!.eleccion, `${p.nombre}: disyuntiva sin elección`).toBeTruthy();
        if (/ AND /.test(e) && !/ OR /.test(e)) expect(c!.eleccion, `${p.nombre}: conjuntiva no debe elegir`).toBeNull();
      }
    }
  });

  it("sources.json no afirma una disponibilidad que aún no existe", () => {
    expect(sources.estadoDeDisponibilidad.archivoDeFuentesCreado).toBe(false);
    expect(sources.estadoDeDisponibilidad.ofertaEscritaPublicada).toBe(false);
    for (const a of ["backend", "migrate", "frontend-image"]) {
      const texto = aviso(a);
      expect(texto, `${a}: no debe prometer una oferta que no se ha publicado`)
        .not.toMatch(/oferta escrita v[aá]lida/i);
    }
  });
});

describe("corpus de licencias: cada paquete llega a un TEXTO, no a un identificador", () => {
  /** Descompone una expresión SPDX en sus átomos. Misma regla que el generador. */
  function atomos(e: string | null): string[] {
    if (!e || !e.trim()) return [];
    return e.replace(/[()]/g, " ").split(/\s+(?:OR|AND|or|and)\s+/).map((s) => s.trim()).filter(Boolean);
  }
  const porId = new Map<string, { archivo: string | null; resuelto: boolean; sha256?: string }>(
    corpus.licencias.map((l: { identificador: string }) => [l.identificador, l]) as never);

  it("cada texto del corpus tiene el SHA-256 que corpus.json declara", () => {
    for (const l of corpus.licencias) {
      if (!l.archivo) continue;
      const ruta = join(RAIZ, l.archivo);
      expect(existsSync(ruta), `falta ${l.archivo}`).toBe(true);
      const real = createHash("sha256").update(readFileSync(ruta, "utf8"), "utf8").digest("hex");
      expect(real, `${l.identificador}: el texto no coincide con su hash registrado`).toBe(l.sha256);
    }
  });

  it("el corpus declara su fuente canónica fijada por commit, no por rama", () => {
    expect(corpus.fuenteCanonica.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(corpus.fuenteCanonica.version).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it("NINGÚN paquete del sistema queda asociado solo a un identificador", () => {
    const fallos: string[] = [];
    for (const a of ["frontend-image", "backend", "migrate"]) {
      for (const p of inventario(a).sistema) {
        for (const at of atomos(p.expresion)) {
          const l = porId.get(at);
          if (!l) { fallos.push(`${a}: ${p.nombre}@${p.version} usa "${at}", que no está en el corpus`); continue; }
          // `archivo` = hay texto entregable. `resuelto` sin archivo = se
          // declaró por qué no hay texto que entregar (dominio público, o un
          // texto propio del componente que viaja aparte en la imagen).
          if (!l.archivo && !l.resuelto) {
            fallos.push(`${a}: ${p.nombre}@${p.version} usa "${at}", SIN texto y SIN resolver`);
          }
        }
      }
    }
    // Ya no queda ningún átomo sin resolver: `custom` se identificó como la
    // Alliance for Open Media Patent License 1.0 y su texto está en el corpus.
    expect(corpus.sinResolver, "no debe quedar ninguna licencia sin resolver").toEqual([]);
    expect(fallos, "hay licencias sin texto y sin registrar").toEqual([]);
  });

  it("cada aviso de imagen dice en qué archivo del corpus está cada texto", () => {
    for (const a of ["frontend-image", "backend", "migrate"]) {
      const texto = aviso(a);
      const usados = new Set<string>();
      for (const p of inventario(a).sistema) for (const at of atomos(p.expresion)) usados.add(at);
      for (const at of usados) {
        const l = porId.get(at);
        if (!l?.archivo) continue;
        const base = l.archivo.split("/").pop()!;
        expect(texto, `${a}: el aviso no remite al texto de ${at}`).toContain(`licencias/${base}`);
      }
    }
  });

  it("el corpus cubre también los átomos de las dependencias Node que lo necesitan", () => {
    const sinTexto: string[] = [];
    for (const a of ARTEFACTOS) {
      for (const p of inventario(a).node) {
        if ((p.licencias ?? []).length > 0) continue;
        const exc = excepciones.casos.find(
          (c: { paquete: string; version: string }) => c.paquete === p.nombre && c.version === p.version);
        if (!exc) { sinTexto.push(`${a}: ${p.nombre}@${p.version}`); continue; }
        expect(["etiqueta", "canonico", "artefacto"]).toContain(exc.textoDesde);
      }
    }
    expect(sinTexto, "dependencias Node sin texto y sin excepción").toEqual([]);
  });
});

describe("fuentes: cada componente copyleft tiene su commit exacto", () => {
  it("el commit sale del artefacto, no de consultar la rama", () => {
    expect(sources.origenDeLosCommits.campo).toContain("c:");
    expect(sources.origenDeLosCommits.campo).toContain("installed");
  });

  it("todo componente copyleft o Apache tiene commit de aports resuelto", () => {
    const sinResolver = sources.componentes.filter((c: { resuelto: boolean }) => !c.resuelto);
    for (const c of sinResolver) {
      expect(sources.entregaExterna.bloqueada,
        `${c.paqueteFuente} no está resuelto y la entrega externa no está bloqueada`).toBe(true);
    }
    for (const c of sources.componentes.filter((x: { resuelto: boolean }) => x.resuelto)) {
      expect(c.commitAports, `${c.paqueteFuente}: commit con formato inválido`).toMatch(/^[0-9a-f]{40}$/);
      expect(c.apkbuild).toContain(c.commitAports);
      expect(c.espejoOficial).toContain(c.commitAports);
    }
  });

  it("el commit registrado coincide con el del inventario del artefacto", () => {
    for (const a of ["frontend-image", "backend", "migrate"]) {
      for (const p of inventario(a).sistema) {
        if (!/GPL|MPL|Apache/i.test(p.expresion ?? "")) continue;
        const c = sources.componentes.find(
          (x: { paqueteFuente: string; versionDistribuida: string }) =>
            x.paqueteFuente === p.origen && x.versionDistribuida === p.version);
        expect(c, `${a}: ${p.nombre} sin entrada en sources.json`).toBeTruthy();
        expect(c.commitAports, `${a}: ${p.nombre} con commit divergente`).toBe(p.commit);
      }
    }
  });

  it("sources.json bloquea la entrega externa mientras quede algo pendiente", () => {
    // El bloqueo no depende solo de los manifiestos: también de hitos del
    // proyecto que no pueden levantarse solos.
    const hayPendientes =
      sources.componentes.some((c: { resuelto: boolean }) => !c.resuelto) ||
      corpus.sinResolver.length > 0 ||
      avisosFuente.paquetes.some((p: { estado: string }) => p.estado === "no-verificable") ||
      !sources.entregaExterna.hitos.candidatasFinalesConstruidasYVerificadas ||
      !sources.entregaExterna.hitos.archivoDeFuentesCorrespondienteCreado;
    expect(sources.entregaExterna.bloqueada).toBe(hayPendientes);
    if (hayPendientes) expect(sources.entregaExterna.motivos.length).toBeGreaterThan(0);
  });

  it("los hitos del proyecto se declaran explícitamente y hoy están sin cumplir", () => {
    expect(sources.entregaExterna.hitos.candidatasFinalesConstruidasYVerificadas).toBe(false);
    expect(sources.entregaExterna.hitos.archivoDeFuentesCorrespondienteCreado).toBe(false);
    expect(sources.entregaExterna.motivos.join(" ")).toContain("candidatas finales");
    expect(sources.entregaExterna.motivos.join(" ")).toContain("archivo de fuentes");
  });
});

describe("avisos de copyright: titulares y textos propios", () => {
  const ARTS_IMAGEN = ["frontend-image", "backend", "migrate"] as const;
  const porFuente = new Map<string, {
    estado: string; avisos: { archivo: string; url: string; sha256: string }[];
    commitAports: string | null; nota: string | null;
    fuenteTarball?: string; fuenteSinResolver?: string; lugaresInspeccionados: string[];
  }>(avisosFuente.paquetes.map((p: { paqueteFuente: string; version: string }) =>
    [`${p.paqueteFuente}|${p.version}`, p]) as never);

  it("NINGÚN `custom` queda sin resolver", () => {
    expect(corpus.sinResolver).toEqual([]);
    const aom = corpus.licencias.find((l: { identificador: string }) => l.identificador === "custom");
    expect(aom.resuelto).toBe(true);
    expect(aom.identificadorLegible).toBe("LicenseRef-AOM-Patent-1.0");
    expect(aom.expresionOriginalAlpine, "debe conservarse la expresión original de Alpine")
      .toBe("BSD-2-Clause AND custom");
    expect(aom.expresionLegible).toBe("BSD-2-Clause AND LicenseRef-AOM-Patent-1.0");
    // El PATENTS debe venir de la versión exacta, no del sitio web.
    expect(aom.url).toContain("v3.11.0");
    expect(aom.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(join(RAIZ, "notices", "licencias", "LicenseRef-AOM-Patent-1.0.txt"))).toBe(true);
  });

  it("cada paquete fuente está asociado a su commit exacto", () => {
    for (const a of ARTS_IMAGEN) {
      for (const p of inventario(a).sistema) {
        if (!p.commit) continue; // nginx: no viene de aports, se registra aparte
        const f = porFuente.get(`${p.origen}|${p.version}`);
        expect(f, `${a}: ${p.origen}@${p.version} sin entrada en avisos-fuente.json`).toBeTruthy();
        expect(f!.commitAports, `${p.origen}: commit divergente`).toBe(p.commit);
      }
    }
  });

  it("todo paquete fuente tiene un estado declarado, y ninguno es una suposición", () => {
    for (const p of avisosFuente.paquetes) {
      expect(["encontrado", "verificado-ausente", "no-verificable"],
        `${p.paqueteFuente}: estado inválido`).toContain(p.estado);
      if (p.estado === "encontrado") {
        expect(p.avisos.length).toBeGreaterThan(0);
        for (const av of p.avisos) {
          expect(av.url, `${p.paqueteFuente}: aviso sin URL`).toBeTruthy();
          expect(av.sha256).toMatch(/^[0-9a-f]{64}$/);
          expect(existsSync(join(NOTICES, "textos", `${av.sha256}.txt`)),
            `${p.paqueteFuente}: falta el texto de ${av.archivo}`).toBe(true);
        }
      }
      if (p.estado === "verificado-ausente") {
        expect(p.lugaresInspeccionados.length,
          `${p.paqueteFuente}: dice verificado pero no registra dónde miró`).toBeGreaterThan(0);
        expect(p.nota).toBeTruthy();
      }
      if (p.estado === "no-verificable") {
        expect(p.fuenteTarball || p.fuenteSinResolver,
          `${p.paqueteFuente}: no verificable pero sin registrar la fuente`).toBeTruthy();
      }
    }
  });

  it("un texto propio NO se sustituye por uno canónico", () => {
    // Para cada paquete con aviso propio, su texto exacto debe aparecer en el
    // aviso del artefacto. Si se hubiera reemplazado por el canónico SPDX, el
    // texto propio faltaría.
    for (const a of ARTS_IMAGEN) {
      const texto = aviso(a);
      const vistos = new Set<string>();
      for (const p of inventario(a).sistema) {
        const clave = `${p.origen}|${p.version}`;
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        const f = porFuente.get(clave);
        if (!f || f.estado !== "encontrado") continue;
        for (const av of f.avisos) {
          const propio = readFileSync(join(NOTICES, "textos", `${av.sha256}.txt`), "utf8").trimEnd();
          expect(texto, `${a}: el ${av.archivo} propio de ${p.origen} no está en el aviso`)
            .toContain(propio);
        }
      }
    }
  });

  it("los casos de dominio público tienen procedencia, no un encogimiento de hombros", () => {
    for (const a of ARTS_IMAGEN) {
      for (const p of inventario(a).sistema) {
        if (!/public.?domain/i.test(p.expresion ?? "")) continue;
        const f = porFuente.get(`${p.origen}|${p.version}`);
        expect(f, `${p.nombre}: dominio público sin registro de fuente`).toBeTruthy();
        if (f!.estado === "encontrado") {
          // Se conservó la declaración real: debe tener URL y hash.
          expect(f!.avisos.every((av) => av.url && av.sha256)).toBe(true);
        } else {
          // Si no se recuperó, debe constar POR QUÉ y dónde se miró.
          expect(f!.nota, `${p.nombre}: sin explicación`).toBeTruthy();
          expect(f!.estado).toBe("no-verificable");
        }
      }
    }
  });

  it("OpenSSL del sistema se registra aparte del que enumera Node.js", () => {
    // El aviso combinado de Node menciona OpenSSL, pero eso no cubre el paquete
    // `openssl` que Alpine instala: son componentes distintos y se acreditan
    // por separado, cada uno con su versión.
    const versiones = new Map([["frontend-image", "3.3.3-r0"], ["backend", "3.5.8-r0"], ["migrate", "3.5.8-r0"]]);
    for (const [art, ver] of versiones) {
      const f = porFuente.get(`openssl|${ver}`);
      expect(f, `${art}: openssl@${ver} sin entrada propia`).toBeTruthy();
      expect(f!.estado, `${art}: el openssl del sistema debe tener aviso propio`).toBe("encontrado");
      expect(f!.avisos.some((av) => av.archivo === "LICENSE.txt")).toBe(true);
      expect(f!.avisos[0]!.url, `${art}: el aviso debe venir de la versión exacta`)
        .toContain(ver.replace(/-r\d+$/, ""));
    }
    // Y el de Node sigue estando, como componente distinto.
    for (const art of ["backend", "migrate"]) {
      expect(inventario(art).sueltos.some((s) => s.componente === "Node.js")).toBe(true);
    }
  });

  it("toda licencia que exige conservar avisos tiene texto, y aviso propio o excepción", () => {
    const EXIGEN_AVISO = /MIT|BSD|ISC|Apache|Zlib|Libpng|libtiff|curl|X11|IJG|GD|FTL|Beerware|bzip2|BlueOak|GPL|MPL/i;
    const porId = new Map(corpus.licencias.map((l: { identificador: string }) => [l.identificador, l]) as never);
    const fallos: string[] = [];
    for (const a of ARTS_IMAGEN) {
      // Los paquetes que NO vienen de aports —nginx y sus módulos— llevan su
      // propio COPYRIGHT dentro de la imagen y se registran como componentes
      // sueltos, no en avisos-fuente.json. Cuentan como cubiertos.
      const sueltos = new Set(inventario(a).sueltos.map((s) => s.componente));
      for (const p of inventario(a).sistema) {
        if (sueltos.has(p.nombre)) continue;
        const ats = (p.expresion ?? "").replace(/[()]/g, " ").split(/\s+(?:OR|AND|or|and)\s+/)
          .map((s) => s.trim()).filter(Boolean);
        for (const at of ats) {
          if (!EXIGEN_AVISO.test(at)) continue;
          const l = porId.get(at) as { archivo: string | null; resuelto: boolean } | undefined;
          if (!l?.archivo) { fallos.push(`${a}: ${p.nombre} usa ${at} sin texto en el corpus`); continue; }
          const f = porFuente.get(`${p.origen}|${p.version}`);
          const tieneAvisoPropio = f?.estado === "encontrado";
          const documentado = f?.estado === "verificado-ausente" || f?.estado === "no-verificable";
          if (!tieneAvisoPropio && !documentado) {
            fallos.push(`${a}: ${p.nombre} (${at}) sin aviso propio ni excepción documentada`);
          }
        }
      }
    }
    expect(fallos).toEqual([]);
  });
});

describe("avisos de terceros: el alcance de cada aviso es el correcto", () => {
  it("frontend-web cubre solo lo que se envía al navegador", () => {
    const web = inventario("frontend-web");
    expect(web.sistema.length, "el aviso web no debe incluir paquetes del sistema").toBe(0);
    expect(web.sueltos.length, "el aviso web no debe incluir componentes de la imagen base").toBe(0);
    expect(web.node.length).toBeGreaterThan(0);
    const texto = aviso("frontend-web");
    expect(texto, "el aviso web no debe mencionar el servidor web").not.toContain("nginx");
    expect(texto).toContain("EXCLUSIVAMENTE el codigo de terceros que se envia al");
  });

  it("frontend-image contiene el servidor y el sistema, que el web no envía", () => {
    const img = inventario("frontend-image");
    expect(img.sistema.length).toBeGreaterThan(0);
    expect(aviso("frontend-image")).toContain("nginx");
  });

  it("migrate es autosuficiente: no remite a otro aviso para sus paquetes compartidos", () => {
    const mig = inventario("migrate");
    const back = inventario("backend");
    const enMigrate = new Set(mig.node.map((p) => `${p.nombre}@${p.version}`));
    for (const p of back.node) {
      expect(enMigrate.has(`${p.nombre}@${p.version}`),
        `migrate no reproduce ${p.nombre}@${p.version}`).toBe(true);
    }
    expect(mig.node.length).toBeGreaterThan(back.node.length);
    const texto = aviso("migrate");
    expect(texto, "migrate no debe delegar en el aviso del backend").not.toMatch(/v[eé]ase notices\/backend\.txt/i);
  });

  it("el CLI de Prisma solo aparece en migrate", () => {
    const soloEnMigrate = inventario("migrate").node.filter((p) => p.nombre === "prisma");
    expect(soloEnMigrate.length).toBe(1);
    expect(inventario("backend").node.some((p) => p.nombre === "prisma")).toBe(false);
    expect(aviso("backend")).not.toContain("\nprisma@");
  });
});

describe("avisos de terceros: el generador falla ante divergencias", () => {
  const INV = join(NOTICES, "inventario", "frontend-web.json");
  const COPIA = join(NOTICES, "inventario", "frontend-web.json.respaldo");

  function conInventarioAlterado(mutar: (inv: Inventario) => void, comprobar: (r: ReturnType<typeof correrGenerador>) => void) {
    copyFileSync(INV, COPIA);
    try {
      const inv: Inventario = JSON.parse(readFileSync(INV, "utf8"));
      mutar(inv);
      writeFileSync(INV, JSON.stringify(inv, null, 2) + "\n");
      comprobar(correrGenerador(["--verificar"]));
    } finally {
      copyFileSync(COPIA, INV);
      rmSync(COPIA, { force: true });
      // Se restituye el estado publicado para no dejar residuo.
      correrGenerador();
    }
  }

  /**
   * El primer paquete de `node`, con la garantía de que existe.
   *
   * Las pruebas que siguen alteran ese primer paquete, pero el inventario que
   * reciben viene de leer el archivo real: nada asegura de antemano que traiga
   * alguno. Con `noUncheckedIndexedAccess`, `inv.node[0]` es `PaqueteNode |
   * undefined`, y taparlo con `!` convertiría un inventario vacío —que sería un
   * defecto del generador— en un fallo confuso dentro del `mutar`. Aquí se
   * afirma explícitamente y se falla con un mensaje que dice qué pasó.
   */
  function primerPaqueteNode(inv: Inventario): PaqueteNode {
    const primero = inv.node[0];
    if (!primero) throw new Error("el inventario no trae ningún paquete node: esta prueba necesita al menos uno");
    return primero;
  }

  it("falla si se añade un paquete al inventario", () => {
    conInventarioAlterado(
      (inv) => inv.node.push({
        nombre: "paquete-inventado", version: "9.9.9", expresion: "MIT",
        autor: null, repositorio: null, tieneNotice: false,
        licencias: [{ archivo: "LICENSE", sha256: "0".repeat(64), bytes: 1 }],
      }),
      (r) => { expect(r.status).not.toBe(0); },
    );
  });

  it("falla si cambia la versión de un paquete", () => {
    conInventarioAlterado(
      (inv) => { primerPaqueteNode(inv).version = "0.0.0-divergente"; },
      (r) => {
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("DIVERGE");
      },
    );
  });

  it("falla si cambia la expresión de licencia", () => {
    conInventarioAlterado(
      (inv) => { primerPaqueteNode(inv).expresion = "GPL-3.0-only"; },
      (r) => {
        expect(r.status).toBe(1);
        expect(r.stderr).toContain("DIVERGE");
      },
    );
  });

  it("falla si un paquete se queda sin texto y sin excepción", () => {
    conInventarioAlterado(
      (inv) => { primerPaqueteNode(inv).licencias = []; },
      (r) => {
        expect(r.status).not.toBe(0);
        expect(r.stderr).toMatch(/sin texto de licencia y sin entrada/);
      },
    );
  });

  it("y tras cada alteración el estado publicado queda restituido", () => {
    expect(correrGenerador(["--verificar"]).status).toBe(0);
  });
});
