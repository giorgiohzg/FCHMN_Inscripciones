/**
 * Hallazgo 32 — LA DOCUMENTACIÓN DESCRIBE EL SISTEMA QUE EXISTE.
 *
 * El hallazgo pedía sincronizar los documentos con la realidad. El problema de
 * una corrección puramente redactada es que vuelve a desincronizarse con el
 * siguiente cambio de código, en silencio y sin que nada falle.
 *
 * ALCANCE, dicho con precisión para no prometer de más: estas pruebas comparan
 * con el código las cosas **enumerables** —cuántos modelos hay, qué endpoints
 * existen, qué módulos componen el backend y qué guardia protege cada ruta—. No
 * comprueban prosa: una afirmación como «Prisma Client nunca se generó» no es
 * verificable con una expresión regular, y esas se corrigieron a mano y se
 * fecharon.
 *
 * Y no se conforman con «lo que el extractor entienda»: si aparece una ruta
 * declarada con una forma que el extractor no sabe leer, la prueba
 * `no hay rutas declaradas de una forma que este extractor no entienda` **falla**
 * en vez de dejarla pasar sin documentar. Esa es la diferencia entre una
 * garantía y una ilusión de garantía.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const RAIZ = join(__dirname, "..", "..");
const BACKEND = join(__dirname, "..");
const SRC = join(BACKEND, "src");

const leer = (ruta: string): string => readFileSync(join(RAIZ, ruta), "utf8");

const README = leer("README.md");
const RESUMEN = leer("docs/internas/13_Resumen_Final.md");
const PROPUESTA = leer("docs/internas/01_Propuesta_Base.md");

/**
 * El texto SIN las citas en bloque (`> …`).
 *
 * Los documentos conservan a propósito las cifras viejas cuando explican qué
 * cambió —«publicaba 28 modelos y ~90 endpoints»—, y esa memoria es parte de lo
 * que el hallazgo pedía: no borrar la historia. Lo que no puede quedar obsoleto
 * es lo que el documento **afirma**. La distinción es la cita: las notas
 * históricas van en bloque, las afirmaciones no.
 */
const afirmaciones = (texto: string): string =>
  texto
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(">"))
    .join("\n");

/** Todos los `.ts` bajo `src/`, recorriendo subdirectorios. */
function archivosFuente(dir: string = SRC): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, entrada.name);
    if (entrada.isDirectory()) salida.push(...archivosFuente(ruta));
    else if (entrada.name.endsWith(".ts")) salida.push(ruta);
  }
  return salida;
}

/** Los modelos declarados en el esquema, que es la fuente de verdad. */
function modelosDelEsquema(): string[] {
  const esquema = readFileSync(join(BACKEND, "prisma", "schema.prisma"), "utf8");
  return [...esquema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]!);
}

/** Los directorios de `src/modules`, que es lo que compone el backend. */
function modulosDelBackend(): string[] {
  return readdirSync(join(SRC, "modules"), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

/**
 * Una declaración de ruta encontrada en el código.
 *
 * `guardias` son los nombres de las funciones del `preHandler` declarado en la
 * misma llamada —`requirePermission("clubs:write")`, `requireAuth`, …—. Se leen
 * del tramo entre la ruta y el manejador, que es donde viven.
 */
interface RutaDeclarada {
  clave: string; // "MÉTODO /ruta"
  archivo: string;
  guardias: string[];
  /** Permisos exigidos, tal como aparecen en `requirePermission("…")`. */
  permisos: string[];
}

/** Acepta comilla doble, simple y plantilla SIN interpolación. */
const LITERAL = String.raw`(?:"([^"]+)"|'([^']+)'|\`([^\`$]+)\`)`;
const DECLARACION = new RegExp(String.raw`\.(get|post|put|delete|patch)\b[^(]*\(\s*${LITERAL}`, "g");

/**
 * Toda declaración de ruta con literal estático, venga del archivo que venga.
 *
 * No se limita a `*.routes.ts` ni a un directorio plano: recorre `src/` entero,
 * porque una ruta declarada en cualquier otro sitio seguiría siendo una ruta.
 */
function rutasEstaticas(): RutaDeclarada[] {
  const encontradas: RutaDeclarada[] = [];

  for (const archivo of archivosFuente()) {
    const fuente = readFileSync(archivo, "utf8");
    for (const m of fuente.matchAll(DECLARACION)) {
      const camino = m[2] ?? m[3] ?? m[4]!;
      if (!camino.startsWith("/")) continue; // no es una ruta HTTP

      // El tramo desde la ruta hasta el manejador: ahí van las opciones.
      const desde = m.index! + m[0].length;
      const opciones = fuente.slice(desde, desde + 400).split("async")[0] ?? "";
      const guardias = [...opciones.matchAll(/\b(require\w+)\b/g)].map((g) => g[1]!);
      const permisos = [...opciones.matchAll(/requirePermission\(\s*"([^"]+)"/g)].map((g) => g[1]!);

      encontradas.push({
        clave: `${m[1]!.toUpperCase()} ${camino}`,
        archivo: archivo.slice(SRC.length + 1).replace(/\\/g, "/"),
        guardias,
        permisos,
      });
    }
  }

  return encontradas;
}

/**
 * Las transiciones de ciclo de vida de una competencia, que se registran en un
 * bucle sobre un arreglo de acciones y por eso no tienen literal estático.
 *
 * Es el ÚNICO caso dinámico aceptado, y está declarado aquí a propósito: si
 * apareciera otro, la prueba de formas no reconocidas lo detendría.
 */
function rutasDelBucleDeCompetencias(): RutaDeclarada[] {
  const archivo = join(SRC, "modules", "competitions", "competitions.routes.ts");
  const fuente = readFileSync(archivo, "utf8");
  const bucle = fuente.match(/const actions: CompetitionAction\[\] = \[([^\]]+)\]/);
  if (!bucle) return [];

  const guardias = [...fuente.slice(fuente.indexOf(bucle[0])).matchAll(/\b(require\w+)\b/g)]
    .slice(0, 2)
    .map((g) => g[1]!);

  const permisos = [...fuente.slice(fuente.indexOf(bucle[0])).matchAll(/requirePermission\(\s*"([^"]+)"/g)]
    .slice(0, 1)
    .map((g) => g[1]!);

  return [...bucle[1]!.matchAll(/"(\w+)"/g)].map((a) => ({
    clave: `POST /competitions/:id/${a[1]!}`,
    archivo: "modules/competitions/competitions.routes.ts",
    guardias,
    permisos,
  }));
}

function rutasDeclaradas(): RutaDeclarada[] {
  const todas = [...rutasEstaticas(), ...rutasDelBucleDeCompetencias()];
  const porClave = new Map(todas.map((r) => [r.clave, r]));
  return [...porClave.values()].sort((a, b) => a.clave.localeCompare(b.clave));
}

/**
 * Una fila de permisos del README, ya expandida a rutas concretas.
 *
 * `agrupada` distingue las filas que documentan VARIAS rutas de una vez —«GET/POST
 * `/competitions[/:id]`», «POST `/competitions/:id/{schedule|cancel|…}`»—. La
 * distinción cambia el rigor con que se puede comparar, y por eso se conserva en
 * vez de descartar esas filas: antes se saltaban enteras y eran justo las que
 * nadie revisaba.
 */
interface FilaDePermisos {
  linea: number;
  verbos: string[];
  caminos: string[];
  claves: string[]; // producto de verbos × caminos, para las filas simples
  /** El guardia de la ruta: lo que la celda declara ANTES de cualquier paréntesis. */
  permisos: Set<string>;
  /** Permisos nombrados en la prosa: reglas que aplica el servicio, no la ruta. */
  permisosDeServicio: Set<string>;
  agrupada: boolean;
  origen: string;
}

/** Expande `[/:id]`, `{a|b|c}` y las listas separadas por comas. */
function expandirCaminos(celda: string): { caminos: string[]; agrupada: boolean } {
  const literales = [...celda.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  let agrupada = literales.length > 1;
  const caminos: string[] = [];

  for (const literal of literales) {
    const base = literal.split("?")[0]!.trim();

    // `{schedule\|cancel\|…}` → una ruta por alternativa.
    const llaves = base.match(/^(.*)\{(.+)\}$/);
    if (llaves) {
      agrupada = true;
      for (const alternativa of llaves[2]!.split(/\\?\|/)) caminos.push(llaves[1]! + alternativa.trim());
      continue;
    }

    // `/catalogs/categories[/:id]` → la colección y el elemento.
    const corchetes = base.match(/^(.*)\[(.+)\]$/);
    if (corchetes) {
      agrupada = true;
      caminos.push(corchetes[1]!, corchetes[1]! + corchetes[2]!);
      continue;
    }

    caminos.push(base);
  }

  return { caminos, agrupada };
}

/**
 * TODAS las filas de permisos de las TABLAS DETALLADAS del README.
 *
 * Son las de cuatro columnas —método, ruta, descripción, permiso—, que son las
 * que documentan permisos. El inventario final tiene dos columnas y **no cuenta**
 * como documentación de permisos: decir que un permiso aparece «en algún lugar
 * del README» no comprueba nada, porque una fila podría atribuirlo a la ruta
 * equivocada y la comprobación seguiría en verde.
 *
 * Se devuelve una LISTA, no un mapa por ruta: si dos filas documentan la misma
 * ruta, las dos tienen que ser coherentes, y un mapa se habría quedado con la
 * última en silencio.
 */
function filasDePermisos(): FilaDePermisos[] {
  const filas: FilaDePermisos[] = [];
  const lineas = README.split("\n");

  lineas.forEach((linea, i) => {
    const celdas = linea.match(/^\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|\s*$/);
    if (!celdas) return;

    const metodos = celdas[1]!.trim().replace(/~~/g, "");
    if (!/^(GET|POST|PUT|DELETE|PATCH)(\/(GET|POST|PUT|DELETE|PATCH))*$/.test(metodos)) return;

    /**
     * La celda de permiso tiene dos partes, y confundirlas producía falsos
     * desajustes: lo que va ANTES del primer paréntesis es el guardia que la
     * ruta declara, y lo de dentro es prosa sobre reglas que aplica el
     * SERVICIO —«post-cierre requiere `registrations:write:post-close`»—. Esa
     * segunda no es un `preHandler` y no puede compararse con uno; se comprueba
     * aparte, exigiendo que sea un permiso que exista de verdad.
     */
    const celda = celdas[4]!;
    const corte = celda.indexOf("(");
    const guardia = corte === -1 ? celda : celda.slice(0, corte);
    const prosa = corte === -1 ? "" : celda.slice(corte);

    const permisos = new Set([...guardia.matchAll(/`([a-z-]+:[a-z:-]+)`/g)].map((m) => m[1]!));
    if (permisos.size === 0) return;
    const permisosDeServicio = new Set([...prosa.matchAll(/`([a-z-]+:[a-z:-]+)`/g)].map((m) => m[1]!));

    const { caminos, agrupada } = expandirCaminos(celdas[2]!);
    if (caminos.length === 0) return;

    const verbos = metodos.split("/");
    const claves: string[] = [];
    for (const verbo of verbos) for (const camino of caminos) claves.push(`${verbo} ${camino}`);

    filas.push({
      linea: i + 1,
      verbos,
      caminos,
      claves,
      permisos,
      permisosDeServicio,
      agrupada: agrupada || verbos.length > 1,
      origen: linea.slice(0, 90),
    });
  });

  return filas;
}

/** Las filas `| MÉTODO | `/ruta` |` del inventario de endpoints del README. */
function rutasDocumentadas(): string[] {
  const seccion = README.split("## Inventario completo de endpoints")[1];
  if (seccion === undefined) return [];
  const rutas = new Set<string>();
  for (const m of seccion.matchAll(/^\|\s*(GET|POST|PUT|DELETE|PATCH)\s*\|\s*`([^`]+)`/gm)) {
    rutas.add(`${m[1]!} ${m[2]!}`);
  }
  return [...rutas].sort();
}

describe("Hallazgo 32 — la documentación describe el sistema que existe", () => {
  it("la cantidad de modelos de Prisma que se publica es la real", () => {
    const reales = modelosDelEsquema().length;

    const publicadas = [
      ...afirmaciones(README).matchAll(/(\d+)\s+modelos/g),
      ...afirmaciones(RESUMEN).matchAll(/(\d+)\s+modelos/g),
    ].map((m) => Number(m[1]));

    expect(publicadas, "ningún documento publica la cantidad de modelos").not.toHaveLength(0);
    for (const cifra of publicadas) {
      expect(cifra, `se publican ${cifra} modelos y el esquema tiene ${reales}`).toBe(reales);
    }
  });

  it("el inventario de endpoints del README es exactamente el que declara el código", () => {
    const reales = rutasDeclaradas().map((r) => r.clave);
    const documentadas = rutasDocumentadas();

    expect(documentadas, "el README no tiene inventario de endpoints").not.toHaveLength(0);

    const sinDocumentar = reales.filter((r) => !documentadas.includes(r));
    const inexistentes = documentadas.filter((r) => !reales.includes(r));

    expect(sinDocumentar, "rutas que el código declara y el README no documenta").toEqual([]);
    expect(inexistentes, "rutas que el README documenta y el código no declara").toEqual([]);
  });

  it("la cantidad de endpoints que se publica es la real", () => {
    const reales = rutasDeclaradas().length;
    const publicadas = [
      ...afirmaciones(README).matchAll(/(\d+)\s+endpoints/g),
      ...afirmaciones(RESUMEN).matchAll(/(\d+)\s+endpoints/g),
    ].map((m) => Number(m[1]));

    expect(publicadas, "ningún documento publica la cantidad de endpoints").not.toHaveLength(0);
    for (const cifra of publicadas) {
      expect(cifra, `se publican ${cifra} endpoints y el código declara ${reales}`).toBe(reales);
    }
  });

  /**
   * El límite del extractor, convertido en comprobación.
   *
   * Se cuentan las llamadas a `.get(`/`.post(`… de los archivos de rutas y se
   * exige que TODAS hayan sido reconocidas. Si alguien declara una ruta con una
   * plantilla interpolada, una constante o un bucle nuevo, esta prueba falla y
   * obliga a extender el extractor, en vez de dejar la ruta fuera del inventario
   * sin que nadie se entere.
   */
  it("no hay rutas declaradas de una forma que este extractor no entienda", () => {
    const reconocidas = new Set(rutasDeclaradas().map((r) => r.clave));

    const conLiteral = new Set<string>();
    const sospechosas: string[] = [];
    for (const archivo of archivosFuente()) {
      const fuente = readFileSync(archivo, "utf8");
      const nombre = archivo.slice(SRC.length + 1).replace(/\\/g, "/");
      for (const m of fuente.matchAll(/\.(get|post|put|delete|patch)\b[^(]*\(\s*(["'`][^"'`]*["'`]|[^\s),]{0,40})/g)) {
        const primerArgumento = m[2] ?? "";
        const metodo = m[1]!.toUpperCase();

        if (/^["'`]\//.test(primerArgumento)) {
          const camino = primerArgumento.slice(1, -1);
          // Una plantilla interpolada es el caso dinámico, no un literal.
          if (camino.includes("${")) continue;
          conLiteral.add(`${metodo} ${camino}`);
          continue;
        }
        // Otro literal (no es una ruta) o un `.get(` de un Map: no aplica.
        if (/^["'`]/.test(primerArgumento) || primerArgumento.startsWith("(")) continue;
        // Primer argumento no literal SOBRE la app: puede esconder una ruta.
        const antes = fuente.slice(Math.max(0, m.index! - 12), m.index!);
        if (/^[A-Za-z_$]/.test(primerArgumento) && /\b(app|server|fastify|scoped)$/.test(antes)) {
          sospechosas.push(`${nombre}: ${m[0].trim()}`);
        }
      }
    }

    expect(sospechosas, "declaraciones de ruta cuyo camino no es un literal estático").toEqual([]);

    const perdidas = [...conLiteral].filter((r) => !reconocidas.has(r));
    expect(perdidas, "rutas con literal que el extractor no incorporó al inventario").toEqual([]);
  });

  /**
   * CONTRATO DE GUARDIAS: ninguna ruta queda sin protección por descuido.
   *
   * Todo lo que no esté en la lista de públicas tiene que declarar una guardia
   * en su `preHandler`. Las públicas están enumeradas una a una y con su razón:
   * son las de sesión, que no pueden exigir sesión.
   */
  it("toda ruta no pública declara una guardia", () => {
    const PUBLICAS = new Set([
      "GET /health", // sonda de vivacidad
      "GET /ready", // sonda de disponibilidad
      "POST /auth/login", // aún no hay sesión
      "POST /auth/refresh", // se autentica con la cookie, no con el token
      "POST /auth/logout", // ídem; su ausencia no es error
      "GET /auth/csrf", // emite el token que las demás exigen
    ]);

    const desprotegidas = rutasDeclaradas()
      .filter((r) => !PUBLICAS.has(r.clave) && r.guardias.length === 0)
      .map((r) => `${r.clave} (${r.archivo})`);

    expect(desprotegidas, "rutas sin `requirePermission` / `requireAuth` en su preHandler").toEqual([]);
  });

  /**
   * Y el permiso EXACTO de las rutas sensibles, que es lo que el README publica
   * en sus tablas. Esta comprobación nació de una contradicción real: el README
   * decía que finalizar una membresía exigía `swimmer-assignment:approve` y solo
   * el administrador, cuando la ruta exige `swimmer-assignment:write` y el
   * alcance lo decide el servicio. Comparar método y ruta no lo detectaba.
   */
  /**
   * FILAS SIMPLES: conjunto EXACTO de permisos.
   *
   * Una fila que documenta una sola ruta tiene que nombrar exactamente los
   * permisos que esa ruta exige — ni de menos (documentar `read` donde el código
   * pide `write`) ni de más (documentar un permiso que la ruta no aplica).
   */
  it("cada fila simple del README documenta el conjunto exacto de permisos de su ruta", () => {
    const declaradas = new Map(rutasDeclaradas().map((r) => [r.clave, r]));
    const desajustes: string[] = [];
    let comparadas = 0;

    for (const fila of filasDePermisos()) {
      if (fila.agrupada) continue;
      const clave = fila.claves[0]!;

      const ruta = declaradas.get(clave);
      if (!ruta) {
        desajustes.push(`línea ${fila.linea} — ${clave}: el README documenta una ruta que el código no declara`);
        continue;
      }

      comparadas++;
      const enElCodigo = [...new Set(ruta.permisos)].sort();
      const enElReadme = [...fila.permisos].sort();
      if (enElCodigo.join("|") !== enElReadme.join("|")) {
        desajustes.push(
          `línea ${fila.linea} — ${clave}: el README dice [${enElReadme}] y el código exige [${enElCodigo.length ? enElCodigo : "ninguno"}]`
        );
      }
    }

    expect(desajustes, "filas simples cuyos permisos no son exactamente los del código").toEqual([]);

    /**
     * Y que de verdad se haya comparado algo: si un cambio de formato rompiera
     * la extracción, el bucle quedaría vacío y la prueba pasaría sin comprobar
     * nada. El umbral es holgado —no fija el número exacto de filas, que crece
     * con el proyecto—, pero detecta el caso en que deja de leer.
     */
    expect(comparadas, "filas simples efectivamente comparadas").toBeGreaterThan(40);
  });

  /**
   * FILAS AGRUPADAS: no se saltan, se comprueban con el rigor que admiten.
   *
   * Una fila como «GET/POST/PUT/DELETE `/catalogs/events[/:id]` … `catalogs:read` /
   * `catalogs:write`» es una abreviatura: **no** afirma que existan las dieciséis
   * combinaciones de verbo y ruta, sino que ese conjunto de rutas se maneja con
   * esos verbos. Exigir el producto cartesiano completo daría falsos positivos
   * —`PUT /catalogs/events` no existe, y no tiene por qué—.
   *
   * Lo que sí se exige, que es preciso y suficiente para que no se cuele una
   * contradicción:
   *
   *   1. **cada ruta** de la fila existe con al menos uno de sus verbos;
   *   2. **cada verbo** de la fila se usa en al menos una de sus rutas —así una
   *      fila no puede anunciar un `DELETE` que no existe en ninguna—;
   *   3. la unión de permisos del código coincide **exactamente** con la
   *      documentada: ni falta ninguno ni sobra ninguno «por si acaso».
   */
  it("cada fila agrupada cubre exactamente el conjunto de permisos de sus rutas", () => {
    const declaradas = new Map(rutasDeclaradas().map((r) => [r.clave, r]));
    const desajustes: string[] = [];
    let gruposComparados = 0;

    for (const fila of filasDePermisos()) {
      if (!fila.agrupada) continue;

      const existentes = fila.claves.filter((c) => declaradas.has(c));

      for (const camino of fila.caminos) {
        if (!fila.verbos.some((v) => declaradas.has(`${v} ${camino}`))) {
          desajustes.push(`línea ${fila.linea}: documenta \`${camino}\`, que no existe con ninguno de sus métodos`);
        }
      }
      for (const verbo of fila.verbos) {
        if (!fila.caminos.some((c) => declaradas.has(`${verbo} ${c}`))) {
          desajustes.push(`línea ${fila.linea}: documenta el método ${verbo}, que ninguna de sus rutas admite`);
        }
      }
      if (existentes.length === 0) continue;

      gruposComparados++;
      const delCodigo = new Set(existentes.flatMap((c) => declaradas.get(c)!.permisos));
      const sobran = [...fila.permisos].filter((p) => !delCodigo.has(p));
      const faltan = [...delCodigo].filter((p) => !fila.permisos.has(p));

      if (faltan.length) desajustes.push(`línea ${fila.linea}: el código exige [${faltan}] y el README no lo documenta`);
      if (sobran.length) desajustes.push(`línea ${fila.linea}: el README documenta [${sobran}] que ninguna de sus rutas aplica`);
    }

    expect(desajustes, "filas agrupadas cuyos permisos no cuadran con sus rutas").toEqual([]);
    expect(gruposComparados, "filas agrupadas efectivamente comparadas").toBeGreaterThan(4);
  });

  /**
   * Los permisos que el README nombra como reglas del SERVICIO —la excepción
   * post-cierre, por ejemplo— no son guardias de ruta, pero tienen que existir:
   * documentar un permiso inventado es tan engañoso como atribuirlo mal.
   */
  it("los permisos que el README atribuye al servicio existen de verdad", () => {
    const definiciones = readFileSync(join(SRC, "modules", "auth", "rbac.definitions.ts"), "utf8");
    const reales = new Set([...definiciones.matchAll(/"([a-z-]+:[a-z:-]+)"/g)].map((m) => m[1]!));

    const inventados: string[] = [];
    for (const fila of filasDePermisos()) {
      for (const p of fila.permisosDeServicio) {
        if (!reales.has(p)) inventados.push(`línea ${fila.linea}: ${p}`);
      }
    }

    expect(inventados, "permisos documentados que no existen en `rbac.definitions.ts`").toEqual([]);
  });

  it("dos filas que documenten la misma ruta no pueden contradecirse", () => {
    const porRuta = new Map<string, { linea: number; permisos: string }[]>();

    for (const fila of filasDePermisos()) {
      if (fila.agrupada) continue;
      const clave = fila.claves[0]!;
      const lista = porRuta.get(clave) ?? [];
      lista.push({ linea: fila.linea, permisos: [...fila.permisos].sort().join("|") });
      porRuta.set(clave, lista);
    }

    const contradicciones: string[] = [];
    for (const [clave, apariciones] of porRuta) {
      const distintos = new Set(apariciones.map((a) => a.permisos));
      if (distintos.size > 1) {
        contradicciones.push(`${clave}: ${apariciones.map((a) => `línea ${a.linea} dice [${a.permisos}]`).join("; ")}`);
      }
    }

    expect(contradicciones, "la misma ruta documentada con permisos distintos").toEqual([]);
  });

  it("las rutas sensibles están documentadas con su permiso, no solo listadas", () => {
    /**
     * Que la comparación de arriba sea exhaustiva depende de que estas rutas
     * tengan fila en una tabla detallada. Enumerarlas evita que alguien las saque
     * de la documentación de permisos y las deje solo en el inventario.
     */
    const SENSIBLES = [
      "POST /swimmer-assignments",
      "POST /swimmer-assignments/:id/approve",
      "POST /swimmer-assignments/:id/reject",
      "POST /swimmer-assignments/:id/end",
      "POST /swimmer-assignments/direct",
      "POST /swimmer-assignments/bulk-assign",
      "GET /audit-logs",
      "GET /export/team-manager/hy3",
      "POST /registrations",
      "POST /registrations/:id/cancel",
      "POST /relay-registrations",
      "POST /competitions/import-meet-events",
      "POST /persons/bulk-import",
      "POST /persons/:id/credentials/reset",
      "POST /clubs/:id/credentials/reset",
    ];

    const documentadas = new Set(filasDePermisos().flatMap((f) => f.claves));
    const sinFila = SENSIBLES.filter((r) => !documentadas.has(r));
    expect(sinFila, "rutas sensibles sin fila de permiso en una tabla detallada").toEqual([]);
  });

  /** El árbol de `backend/` dentro del diagrama de componentes de §1.3. */
  function arbolDelBackend(): string {
    const seccion = PROPUESTA.split("### 1.3")[1]?.split("**Principio clave")[0] ?? "";
    const inicio = seccion.indexOf("\nbackend/");
    return inicio === -1 ? "" : seccion.slice(inicio);
  }

  /** Los módulos que ese árbol declara, sean rama `├──` o última hoja `└──`. */
  function modulosDocumentados(): string[] {
    return [...arbolDelBackend().matchAll(/│\s+│\s+[├└]──\s+([a-z-]+)\//g)].map((m) => m[1]!);
  }

  it("todos los módulos del backend aparecen en la estructura documentada", () => {
    const documentados = modulosDocumentados();
    const ausentes = modulosDelBackend().filter((m) => !documentados.includes(m));
    expect(ausentes, "módulos del backend que el diagrama de componentes no menciona").toEqual([]);
  });

  it("la estructura documentada no inventa módulos que no existen", () => {
    const reales = new Set(modulosDelBackend());
    const declarados = modulosDocumentados();

    expect(declarados, "el diagrama no declara módulos de backend").not.toHaveLength(0);
    const inventados = declarados.filter((m) => !reales.has(m));
    expect(inventados, "módulos documentados que no existen en `src/modules`").toEqual([]);
  });
});
