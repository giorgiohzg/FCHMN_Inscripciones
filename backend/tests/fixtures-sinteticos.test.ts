/**
 * GUARDA POSITIVA: los fixtures de Hy-Tek contienen SOLO identidad sintética.
 *
 * Los formatos se decodificaron contra exportaciones reales, pero los archivos
 * que viven en el repositorio se anonimizaron. Esta prueba existe para que esa
 * propiedad no dependa de que alguien se acuerde.
 *
 * Es una guarda POSITIVA a propósito: describe lo que los archivos **deben**
 * contener y rechaza todo lo demás. La alternativa —una lista de los nombres
 * reales que hubo, para buscarlos— volvería a meter esos nombres en el
 * repositorio, que es exactamente lo que la anonimización vino a evitar.
 *
 * Cubre las dos mitades del trato:
 *   1. la identidad es la sintética y nada más;
 *   2. el contrato técnico del formato sigue intacto, porque un fixture
 *      "limpio" que ya no ejercita el formato no sirve de nada.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { computeHy3Checksum, HY3_LINE_LENGTH } from "../src/modules/team-manager-export/hy3-checksum";

const FIXTURES = path.join(__dirname, "fixtures");
const HY3 = ["sample.hy3", "sample-with-relays.hy3"];

/** Vocabulario sintético admitido, el mismo que produce el anonimizador. */
const APELLIDOS = [
  "Álamo", "Bravo", "Ñandú", "Delta", "Eco", "Foxtrot", "Golf", "Hotel",
  "India", "Julieta", "Kilo", "Lima", "Mike", "Noviembre", "Oscar", "Papa",
  "Quebec", "Romeo", "Sierra", "Tango", "Uniforme", "Victor", "Whisky",
  "Xray", "Yanqui", "Zulu", "Ambar", "Bosque", "Cobre", "Duna", "Ermita",
  "Fresno", "Granate", "Helecho", "Islote", "Jade",
];
const CLUB_CODIGO = "SINT";
const CLUB_NOMBRE = "Club Sintético de Pruebas";
const COMPETENCIA = "Competencia Sintética de Pruebas";

/* Año reservado para todo lo que proviene del evento. Cualquier fecha del
   fixture que caiga fuera delata un dato que sobrevivió a la anonimización. */
const ANIO_EVENTO = 2030;
/* Rango plausible para una marca de natación máster, en segundos. Acota por
   arriba y por abajo: un valor fuera de aquí no es una marca sintética. */
const MARCA_MIN = 20;
const MARCA_MAX = 1200;
const HORAS_SESION = ["09:00AM", "11:00AM", "02:00PM", "04:00PM"];

/* Los campos de nombre, según las posiciones fijas del formato. */
const D1_APELLIDO = [8, 28] as const;
const D1_NOMBRE = [28, 48] as const;
const D1_RUN = [65, 79] as const;
const D1_FECHA = [88, 96] as const;

function leerLineas(nombre: string): string[] {
  return fs.readFileSync(path.join(FIXTURES, nombre), "latin1").split("\r\n").filter(Boolean);
}

describe("fixtures Hy-Tek — la identidad es sintética y solo sintética", () => {
  for (const nombre of HY3) {
    const lineas = leerLineas(nombre);

    it(`${nombre}: todo apellido de un registro D1 pertenece al vocabulario sintético`, () => {
      const apellidos = lineas
        .filter((l) => l.startsWith("D1"))
        .map((l) => l.slice(...D1_APELLIDO).trim());
      expect(apellidos.length).toBeGreaterThan(0);
      for (const a of apellidos) expect(APELLIDOS).toContain(a);
    });

    it(`${nombre}: no hay dos nadadores con el mismo apellido`, () => {
      const apellidos = lineas
        .filter((l) => l.startsWith("D1"))
        .map((l) => l.slice(...D1_APELLIDO).trim());
      expect(new Set(apellidos).size).toBe(apellidos.length);
    });

    it(`${nombre}: todo nombre de pila tiene la forma PersonaNN`, () => {
      const nombres = lineas
        .filter((l) => l.startsWith("D1"))
        .map((l) => l.slice(...D1_NOMBRE).trim());
      for (const n of nombres) expect(n).toMatch(/^Persona\d{2}$/);
    });

    it(`${nombre}: todo identificador viene del rango sintético reservado`, () => {
      const runs = lineas
        .filter((l) => l.startsWith("D1"))
        .map((l) => l.slice(...D1_RUN).trim());
      for (const r of runs) expect(r).toMatch(/^(10000\d{3}|10000\d{2}|1000\d{3})-[0-9K]$/);
    });

    it(`${nombre}: toda fecha de nacimiento cae el día 1 al 28 de 1970-1999`, () => {
      const fechas = lineas
        .filter((l) => l.startsWith("D1"))
        .map((l) => l.slice(...D1_FECHA));
      for (const f of fechas) {
        expect(f).toMatch(/^\d{8}$/);
        const mes = Number(f.slice(0, 2));
        const dia = Number(f.slice(2, 4));
        const anio = Number(f.slice(4));
        expect(mes).toBeGreaterThanOrEqual(1);
        expect(mes).toBeLessThanOrEqual(12);
        expect(dia).toBeGreaterThanOrEqual(1);
        expect(dia).toBeLessThanOrEqual(28);
        expect(anio).toBeGreaterThanOrEqual(1970);
        expect(anio).toBeLessThanOrEqual(1999);
      }
    });

    it(`${nombre}: las abreviaturas de E1 y F3 coinciden con el apellido del D1 correspondiente`, () => {
      const porId = new Map<string, string>();
      for (const l of lineas.filter((x) => x.startsWith("D1"))) {
        porId.set(l.slice(5, 8).trim(), l.slice(...D1_APELLIDO).trim());
      }
      let comprobadas = 0;
      for (const l of lineas) {
        if (l.startsWith("E1")) {
          const esperado = porId.get(l.slice(5, 8).trim());
          if (esperado) {
            expect(l.slice(8, 13)).toBe(esperado.slice(0, 5).padEnd(5, " "));
            comprobadas++;
          }
        } else if (l.startsWith("F3")) {
          for (let k = 0; k < 4; k++) {
            const base = 2 + k * 13;
            const esperado = porId.get(l.slice(base + 3, base + 6).trim());
            if (esperado) {
              expect(l.slice(base + 6, base + 11)).toBe(esperado.slice(0, 5).padEnd(5, " "));
              comprobadas++;
            }
          }
        }
      }
      expect(comprobadas).toBeGreaterThan(0);
    });

    it(`${nombre}: el club y la competencia son los sintéticos`, () => {
      const c1 = lineas.find((l) => l.startsWith("C1"))!;
      expect(c1.slice(2, 7).trim()).toBe(CLUB_CODIGO);
      expect(c1.slice(7, 119).trim()).toBe(CLUB_NOMBRE);

      const b1 = lineas.find((l) => l.startsWith("B1"))!;
      expect(b1.slice(2, 47).trim()).toBe(COMPETENCIA);

      for (const f1 of lineas.filter((l) => l.startsWith("F1"))) {
        expect(f1.slice(2, 7).trim()).toBe(CLUB_CODIGO);
      }
    });
  }

  it("sample.ev3: la competencia es la sintética", () => {
    const crudo = fs.readFileSync(path.join(FIXTURES, "sample.ev3"), "latin1");
    expect(crudo.split("\r\n")[0]!.split(";")[0]).toBe(COMPETENCIA);
  });
});

describe("fixtures Hy-Tek — fechas, marcas y metadatos del evento son sintéticos", () => {
  for (const nombre of HY3) {
    const lineas = leerLineas(nombre);

    it(`${nombre}: toda fecha del evento cae en el año reservado`, () => {
      /* B1 lleva inicio, fin y corte de edad; A1 la fecha de generación. Son
         las cuatro fechas que provienen del evento, y ninguna otra. */
      const b1 = lineas.find((l) => l.startsWith("B1"))!;
      for (const desde of [92, 100, 108]) {
        expect(Number(b1.slice(desde + 4, desde + 8))).toBe(ANIO_EVENTO);
      }
      const a1 = lineas.find((l) => l.startsWith("A1"))!;
      expect(Number(a1.slice(62, 66))).toBe(ANIO_EVENTO);
    });

    it(`${nombre}: ninguna fecha del archivo es anterior al rango sintético`, () => {
      /* Las de nacimiento van de 1970 a 1999 y las del evento en 2030: si
         apareciera un año fuera de esos dos rangos, vendría del original. */
      const anios = new Set<number>();
      for (const l of lineas.filter((x) => x.startsWith("D1"))) {
        anios.add(Number(l.slice(92, 96)));
      }
      for (const a of anios) {
        expect(a).toBeGreaterThanOrEqual(1970);
        expect(a).toBeLessThanOrEqual(1999);
      }
    });

    it(`${nombre}: toda marca individual es plausible y está bien formada`, () => {
      const marcas = lineas
        .filter((l) => l.startsWith("E1"))
        .map((l) => l.slice(51, 59).trim());
      expect(marcas.length).toBeGreaterThan(0);
      for (const m of marcas) {
        expect(m).toMatch(/^\d{1,4},\d{2}$/);
        const seg = Number(m.replace(",", "."));
        expect(seg).toBeGreaterThanOrEqual(MARCA_MIN);
        expect(seg).toBeLessThanOrEqual(MARCA_MAX);
      }
    });

    it(`${nombre}: las marcas cubren las dos precisiones del formato`, () => {
      const marcas = lineas
        .filter((l) => l.startsWith("E1"))
        .map((l) => l.slice(51, 59).trim());
      const exactas = marcas.filter((m) => m.endsWith(",00")).length;
      const conCentesimas = marcas.length - exactas;
      expect(exactas).toBeGreaterThan(0);
      expect(conCentesimas).toBeGreaterThan(0);
    });

    it(`${nombre}: las marcas de relevo son sintéticas o la ausencia explícita "0.00"`, () => {
      const marcas = lineas
        .filter((l) => l.startsWith("F1"))
        .map((l) => l.slice(51, 59).trim());
      expect(marcas.length).toBeGreaterThan(0);
      for (const m of marcas) {
        if (m === "0.00") continue; // sin marca de referencia: punto decimal, no es un dato
        expect(m).toMatch(/^\d{1,4},\d{2}$/);
        const seg = Number(m.replace(",", "."));
        expect(seg).toBeGreaterThanOrEqual(MARCA_MIN);
        expect(seg).toBeLessThanOrEqual(MARCA_MAX);
      }
    });
  }

  it("entre los dos fixtures se cubren relevos con marca y sin marca", () => {
    const todas = HY3.flatMap((n) =>
      leerLineas(n)
        .filter((l) => l.startsWith("F1"))
        .map((l) => l.slice(51, 59).trim()),
    );
    expect(todas.filter((m) => m === "0.00").length).toBeGreaterThan(0);
    expect(todas.filter((m) => m !== "0.00").length).toBeGreaterThan(0);
  });

  it("sample.ev3: todas sus fechas caen en el año reservado", () => {
    const cab = fs
      .readFileSync(path.join(FIXTURES, "sample.ev3"), "latin1")
      .split("\r\n")[0]!
      .split(";");
    const fechas = cab.filter((c) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(c.trim()));
    expect(fechas.length).toBeGreaterThanOrEqual(7);
    for (const f of fechas) expect(Number(f.trim().slice(-4))).toBe(ANIO_EVENTO);
  });

  it("sample.ev3: las horas de sesión vienen del repertorio sintético", () => {
    const lineas = fs
      .readFileSync(path.join(FIXTURES, "sample.ev3"), "latin1")
      .split("\r\n")
      .filter((l) => l.trim())
      .slice(1);
    const horas = lineas.map((l) => l.replace(/\*>$/, "").split(";")[24]).filter(Boolean);
    expect(horas.length).toBeGreaterThan(0);
    for (const h of horas) expect(HORAS_SESION).toContain(h);
  });

  it("sample.ev3: los metadatos de texto del encabezado son marcadores sintéticos", () => {
    const cab = fs
      .readFileSync(path.join(FIXTURES, "sample.ev3"), "latin1")
      .split("\r\n")[0]!
      .split(";");
    /* Los campos de texto que el parser no lee guardaban sede, organizador y
       operador del evento real. Ahora llevan el marcador `sintetico-<campo>`,
       recortado al ancho original cuando el campo es más corto que él: por eso
       se exige que el valor sea un PREFIJO del marcador, no su igual. */
    for (const i of [1, 9, 10, 11, 24, 26, 28, 29]) {
      if (cab[i] === undefined || !cab[i].trim()) continue;
      const marcador = `sintetico-${i}`;
      expect(
        marcador.startsWith(cab[i].trim()),
        `el campo [${i}] del encabezado no es un marcador sintético`,
      ).toBe(true);
      expect(cab[i].trim().length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("fixtures Hy-Tek — el contrato técnico del formato sigue intacto", () => {
  for (const nombre of HY3) {
    const ruta = path.join(FIXTURES, nombre);

    it(`${nombre}: cada línea mide 130 caracteres y su checksum es válido`, () => {
      const lineas = leerLineas(nombre);
      expect(lineas.length).toBeGreaterThan(0);
      for (const l of lineas) {
        expect(l).toHaveLength(HY3_LINE_LENGTH);
        expect(computeHy3Checksum(l.slice(0, 128))).toBe(l.slice(128));
      }
    });

    it(`${nombre}: termina cada línea en CRLF, sin un solo LF suelto`, () => {
      const bytes = fs.readFileSync(ruta);
      const crlf = bytes.toString("latin1").split("\r\n").length - 1;
      const lf = bytes.toString("latin1").split("\n").length - 1;
      expect(crlf).toBeGreaterThan(0);
      expect(lf - crlf).toBe(0);
    });

    it(`${nombre}: sigue siendo CP1252 y no UTF-8, como exige el formato`, () => {
      const bytes = fs.readFileSync(ruta);
      /* Si hay bytes por encima de 127 y el archivo NO es UTF-8 válido, la
         codificación de un solo byte es la única lectura posible. Que los haya
         importa: un fixture degradado a ASCII puro dejaría de ejercitar esta
         ruta sin que nada fallase. */
      expect(bytes.some((b) => b > 127)).toBe(true);
      let esUtf8 = true;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        esUtf8 = false;
      }
      expect(esUtf8).toBe(false);
    });

    it(`${nombre}: conserva los tipos de registro que dan sentido al fixture`, () => {
      const tipos = new Set(leerLineas(nombre).map((l) => l.slice(0, 2)));
      for (const t of ["A1", "B1", "B2", "C1", "C2", "C3", "D1", "E1"]) {
        expect(tipos).toContain(t);
      }
    });
  }

  it("sample-with-relays.hy3: conserva los registros de relevo F1 y F3", () => {
    const lineas = leerLineas("sample-with-relays.hy3");
    expect(lineas.filter((l) => l.startsWith("F1")).length).toBeGreaterThan(0);
    expect(lineas.filter((l) => l.startsWith("F3")).length).toBeGreaterThan(0);
  });

  it("sample.ev3: conserva el encabezado y las catorce pruebas", () => {
    const lineas = fs
      .readFileSync(path.join(FIXTURES, "sample.ev3"), "latin1")
      .split("\r\n")
      .filter((l) => l.trim());
    expect(lineas).toHaveLength(15);
  });
});
