/**
 * Guardia permanente del árbol de dependencias de PRODUCCIÓN.
 *
 * Nació de un bloqueador concreto: `buffers@0.1.1` llegaba al árbol por la
 * cadena `exceljs → unzipper@0.10.14 → binary → buffers`, se evaluaba en
 * memoria con un simple `import ExcelJS`, y el paquete publicado **no declara
 * licencia ni distribuye texto de licencia**. No es admisible en un producto
 * propietario que se entrega como imagen.
 *
 * Se resolvió con un `override` ACOTADO al consumidor —no global— que fija
 * `unzipper` en `0.12.5` exacto. Esta prueba impide que el problema regrese en
 * una actualización futura: si alguien retira el override, sube `exceljs` o
 * introduce otra dependencia que reviva la cadena, falla aquí y no en
 * producción.
 *
 * Todo se comprueba contra el LOCKFILE y contra los paquetes REALMENTE
 * instalados. El lockfile sirve para enumerar el árbol; para la licencia, el
 * campo `license` que registra es un dato de conveniencia, así que la prueba
 * exige además que exista el texto distribuido cuando ese campo falta.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BACKEND = join(__dirname, "..");

interface EntradaLock {
  version?: string;
  license?: string | string[];
  dev?: boolean;
  devOptional?: boolean;
  optional?: boolean;
  peer?: boolean;
  os?: string[];
  cpu?: string[];
}
interface Lockfile {
  packages: Record<string, EntradaLock>;
}
interface Manifiesto {
  overrides?: Record<string, unknown>;
}

const LOCK = JSON.parse(readFileSync(join(BACKEND, "package-lock.json"), "utf8")) as Lockfile;
const PAQUETE = JSON.parse(readFileSync(join(BACKEND, "package.json"), "utf8")) as Manifiesto;

/** Nombre del paquete a partir de su ruta en el lockfile. */
const nombreDe = (ruta: string): string => {
  const partes = ruta.split("node_modules/");
  return partes[partes.length - 1] ?? ruta;
};

/** Todas las entradas del lockfile, con su ruta. La raíz (`""`) queda fuera. */
const TODAS: { ruta: string; nombre: string; entrada: EntradaLock }[] = Object.entries(LOCK.packages)
  .filter(([ruta]) => ruta !== "")
  .map(([ruta, entrada]) => ({ ruta, nombre: nombreDe(ruta), entrada }));

/** Marcas con las que npm señala que una entrada puede omitirse. */
const MARCAS_DE_OMISION = ["dev", "devOptional", "optional", "peer"] as const;

const marcasDe = (e: EntradaLock): string[] =>
  MARCAS_DE_OMISION.filter((m) => (e as Record<string, unknown>)[m] === true);

/**
 * El conjunto que `npm ci --omit=dev --omit=optional` instala, y por tanto lo
 * que la imagen `runtime` distribuye: las entradas SIN ninguna marca.
 *
 * CORRECCIÓN MEDIDA. Aquí se afirmaba que `--omit=dev` omite también lo
 * marcado `devOptional`. Es FALSO. `devOptional` significa alcanzable por la
 * rama de desarrollo Y por la rama opcional; npm poda por las banderas
 * booleanas del nodo, y una entrada `devOptional` no tiene `dev` en `true`, así
 * que `--omit=dev` no la toca. El CLI de `prisma` y sus cinco paquetes
 * asociados llegaban de hecho a la imagen final. Se comprobó instalando el
 * mismo lockfile en aislamiento: `--omit=dev` deja 281 paquetes y
 * `--omit=dev --omit=optional` deja 275, siendo la diferencia exactamente esos
 * seis y el enlace `.bin/prisma`.
 */
const PRODUCCION = TODAS.filter(({ entrada }) => marcasDe(entrada).length === 0);

/** Archivos que un paquete puede usar para distribuir el texto de su licencia. */
const ARCHIVO_DE_LICENCIA = /^(licen[cs]e|copying)(\.|$)/i;

function textoDeLicenciaDistribuido(ruta: string): { existe: boolean; archivo?: string; texto?: string } {
  const dir = join(BACKEND, ruta);
  if (!existsSync(dir)) return { existe: false };
  const archivo = readdirSync(dir).find((f) => ARCHIVO_DE_LICENCIA.test(f));
  if (!archivo) return { existe: false };
  return { existe: true, archivo, texto: readFileSync(join(dir, archivo), "utf8") };
}

describe("árbol de producción — la cadena que traía `buffers` no puede volver", () => {
  it("el override está declarado, acotado a `exceljs` y con versión exacta", () => {
    const overrides = PAQUETE.overrides ?? {};
    expect(overrides, "package.json no declara `overrides`").toHaveProperty("exceljs");
    const deExceljs = overrides["exceljs"] as Record<string, string> | undefined;
    expect(deExceljs, "el override de `exceljs` no es un objeto anidado").toBeTypeOf("object");
    // Exacto: sin `^` ni `~`, para que el árbol sea reproducible.
    expect(deExceljs?.["unzipper"]).toBe("0.12.5");
  });

  it("hay exactamente una `unzipper` y su versión es 0.12.5", () => {
    const encontradas = TODAS.filter(({ nombre }) => nombre === "unzipper");
    expect(
      encontradas.map((x) => `${x.ruta}@${x.entrada.version}`),
      "se esperaba una sola instancia de unzipper"
    ).toHaveLength(1);
    expect(encontradas[0]?.entrada.version).toBe("0.12.5");
  });

  it("la `unzipper` instalada en disco también es 0.12.5", () => {
    const manifiesto = join(BACKEND, "node_modules", "unzipper", "package.json");
    expect(existsSync(manifiesto), "unzipper no está instalada").toBe(true);
    const instalada = JSON.parse(readFileSync(manifiesto, "utf8")) as { version: string };
    expect(instalada.version).toBe("0.12.5");
  });

  it.each(["binary", "buffers", "chainsaw"])("no queda ninguna entrada de `%s` en el lockfile", (paquete) => {
    const encontradas = TODAS.filter(({ nombre }) => nombre === paquete).map((x) => x.ruta);
    expect(encontradas, `${paquete} volvió al árbol`).toEqual([]);
  });

  it.each(["binary", "buffers", "chainsaw"])("no queda ninguna carpeta de `%s` instalada, ni anidada", (paquete) => {
    const encontradas: string[] = [];
    const recorrer = (dir: string): void => {
      let entradas: string[];
      try {
        entradas = readdirSync(dir);
      } catch {
        return;
      }
      for (const nombre of entradas) {
        const abs = join(dir, nombre);
        let hijos: string[];
        try {
          hijos = readdirSync(abs);
        } catch {
          continue; // no es un directorio legible
        }
        if (nombre === paquete && dir.endsWith("node_modules")) encontradas.push(abs);
        if (hijos.length > 0) recorrer(abs);
      }
    };
    recorrer(join(BACKEND, "node_modules"));
    expect(encontradas, `${paquete} sigue instalada`).toEqual([]);
  });
});

/**
 * GUARDIA A — línea base declarativa de lo que npm puede omitir.
 *
 * `dev` queda fuera de esta guardia a propósito: son cientos de entradas que
 * cambian con cualquier herramienta y vigilarlas una a una sería ruido. Lo que
 * se vigila es lo OPCIONAL, que es lo que se omite en silencio sin que nadie
 * lo pida: `optional`, `devOptional` y `peer`.
 *
 * Hoy son siete, y cada una está aquí por una razón conocida:
 *
 *   - Los seis de Prisma son `devOptional` porque `prisma` es `devDependency`
 *     de la raíz y, a la vez, par OPCIONAL de `@prisma/client`, que sí es de
 *     producción. Esa doble alcanzabilidad es la que hacía que `--omit=dev` no
 *     los tocara.
 *   - `fsevents` es `optional` puro y solo para darwin: en Linux npm nunca lo
 *     materializa, ni con `--omit=optional` ni sin él.
 *
 * Un alta, una baja, un cambio de marca o un cambio de versión hacen fallar
 * esta prueba. Eso es lo que se busca: que la decisión de omitir algo nuevo la
 * tome una persona, y no el instalador por su cuenta.
 */
describe("guardia A — el conjunto de entradas omitibles está declarado", () => {
  const ESPERADAS: Record<string, { version: string; marcas: string }> = {
    "node_modules/prisma": { version: "5.22.0", marcas: "devOptional" },
    "node_modules/@prisma/debug": { version: "5.22.0", marcas: "devOptional" },
    "node_modules/@prisma/engines": { version: "5.22.0", marcas: "devOptional" },
    "node_modules/@prisma/engines-version": {
      version: "5.22.0-44.605197351a3c8bdd595af2d2a9bc3025bca48ea2",
      marcas: "devOptional",
    },
    "node_modules/@prisma/fetch-engine": { version: "5.22.0", marcas: "devOptional" },
    "node_modules/@prisma/get-platform": { version: "5.22.0", marcas: "devOptional" },
    "node_modules/fsevents": { version: "2.3.3", marcas: "optional" },
  };

  /**
   * Lo vigilado: lo omitible que NO es además `dev`.
   *
   * Las 76 entradas marcadas `dev+optional` —binarios de plataforma de las
   * herramientas de compilación— quedan fuera a propósito: `--omit=dev` ya las
   * excluye por la rama de desarrollo, así que no pueden colarse en producción
   * y vigilarlas sería ruido que cambia con cada actualización de herramienta.
   * Lo peligroso es justo lo contrario: lo que es omitible SIN ser dev, porque
   * ahí es donde una decisión de npm altera el árbol de producción sin que
   * nadie la haya pedido.
   */
  const OMITIBLES = TODAS.filter(({ entrada }) => {
    const m = marcasDe(entrada);
    return m.length > 0 && !m.includes("dev");
  });

  const observadas: Record<string, { version: string; marcas: string }> = Object.fromEntries(
    OMITIBLES.map(({ ruta, entrada }) => [ruta, { version: entrada.version ?? "(sin version)", marcas: marcasDe(entrada).join(",") }])
  );

  it("el conjunto de entradas `optional`, `devOptional` o `peer` es EXACTAMENTE el declarado", () => {
    // Un solo `toEqual` sobre el objeto completo: comunica a la vez altas,
    // bajas, cambios de marca y cambios de versión, con el diff a la vista.
    expect(
      observadas,
      "cambió el conjunto de dependencias omitibles; revise la causa antes de actualizar esta línea base"
    ).toEqual(ESPERADAS);
  });

  it("son siete, ni una más", () => {
    expect(OMITIBLES).toHaveLength(7);
  });

  it("las marcadas `dev+optional` quedan fuera de esta guardia, y son solo eso", () => {
    // Si alguna dejara de ser `dev`, pasaría a OMITIBLES y la línea base
    // fallaría. Esta prueba deja constancia de por qué no se vigilan.
    const devOpcionales = TODAS.filter(({ entrada }) => entrada.dev === true && entrada.optional === true);
    expect(devOpcionales.length, "cambió el número de opcionales de desarrollo").toBeGreaterThan(0);
    for (const { entrada } of devOpcionales) {
      expect(entrada.devOptional, "una `dev+optional` no puede ser además `devOptional`").not.toBe(true);
    }
  });

  it("ninguna entrada está marcada `peer`: si aparece una, hay que decidir qué hacer con ella", () => {
    const conPeer = TODAS.filter(({ entrada }) => entrada.peer === true).map((x) => x.ruta);
    expect(conPeer, "apareció una dependencia `peer` en el lockfile").toEqual([]);
  });

  it("los seis de Prisma están en el lockfile PRINCIPAL, en su ruta canónica", () => {
    // Se comprueba la ruta, no solo el nombre: atribuirlos por `nombre@version`
    // los asignaba por error al lockfile auxiliar del CLI de migraciones.
    const seis = Object.keys(ESPERADAS).filter((r) => r !== "node_modules/fsevents");
    for (const ruta of seis) {
      expect(LOCK.packages, `falta ${ruta} en el lockfile principal`).toHaveProperty([ruta]);
    }
    expect(seis).toHaveLength(6);
  });

  it("`fsevents` es opcional y restringido a darwin, por eso nunca está en Linux", () => {
    const e = LOCK.packages["node_modules/fsevents"];
    expect(e, "fsevents desapareció del lockfile").toBeDefined();
    expect(e?.optional).toBe(true);
    expect(e?.os).toEqual(["darwin"]);
  });

  it("`@prisma/client` sigue siendo de producción, sin ninguna marca", () => {
    const e = LOCK.packages["node_modules/@prisma/client"];
    expect(e, "@prisma/client desapareció del lockfile").toBeDefined();
    expect(e ? marcasDe(e) : ["(ausente)"]).toEqual([]);
  });
});

describe("árbol de producción — toda licencia debe ser determinable", () => {
  /**
   * Determinable = el paquete distribuye su texto de licencia, o al menos
   * declara un identificador. Lo que no se admite es ninguna de las dos cosas:
   * fue exactamente el caso de `buffers@0.1.1`, y lo que impedía generar un
   * aviso de terceros honesto.
   */
  it("ningún paquete de producción queda sin licencia determinable", () => {
    const indeterminables: string[] = [];
    const ausentesSinExplicacion: string[] = [];

    for (const { ruta, nombre, entrada } of PRODUCCION) {
      const declarada = entrada.license !== undefined && entrada.license !== null;
      const distribuida = textoDeLicenciaDistribuido(ruta);

      if (!existsSync(join(BACKEND, ruta))) {
        // Una opcional con restricción de plataforma puede faltar legítimamente
        // en este sistema (p. ej. `fsevents`, solo darwin). Cualquier otra
        // ausencia es un hallazgo, no una excusa.
        const restringida = entrada.optional === true && (entrada.os !== undefined || entrada.cpu !== undefined);
        if (!restringida) ausentesSinExplicacion.push(`${nombre}@${entrada.version} (${ruta})`);
        continue;
      }

      if (!declarada && !distribuida.existe) {
        indeterminables.push(`${nombre}@${entrada.version} (${ruta})`);
      }
    }

    expect(ausentesSinExplicacion, "paquetes de producción ausentes del disco sin restricción de plataforma").toEqual([]);
    expect(indeterminables, "paquetes de producción sin campo `license` y sin texto distribuido").toEqual([]);
  });

  /**
   * `png-js@1.1.0` es el único paquete de producción que no declara el campo
   * `license`. Se admite porque DISTRIBUYE el texto — no por una lista de
   * excepciones ni por lo que digan terceros sobre él—. La prueba comprueba
   * esa justificación en vez de darla por buena: si un día dejara de traer el
   * archivo, falla.
   */
  it("`png-js` se admite por el texto MIT que distribuye, no por convención", () => {
    const entrada = PRODUCCION.find(({ nombre }) => nombre === "png-js");
    expect(entrada, "png-js ya no está en el árbol de producción; revise esta prueba").toBeDefined();
    if (!entrada) return;

    expect(entrada.entrada.license, "png-js ahora declara licencia: simplifique esta prueba").toBeUndefined();

    const distribuida = textoDeLicenciaDistribuido(entrada.ruta);
    expect(distribuida.existe, "png-js ya no distribuye su archivo de licencia").toBe(true);
    expect(distribuida.texto).toMatch(/MIT License/i);
    expect(distribuida.texto).toMatch(/Permission is hereby granted, free of charge/i);
    expect(distribuida.texto).toMatch(/Copyright \(c\)/i);
  });
});
