/**
 * Parser del formato `.hyv`.
 *
 * ALCANCE, dicho antes que nada: la gramática se decodificó alineando un
 * `.hyv` real con el `.ev3` del MISMO evento, ambos de Meet Manager 7.0Gb.
 * Esas pruebas no están aquí y no pueden estarlo —los archivos reales llevan
 * el nombre de un evento y un recinto reales y no entran al repositorio—, así
 * que lo que se verifica aquí es que el parser implemente esa gramática, con
 * un fixture sintético que la reproduce. Nada de esto dice nada sobre otras
 * versiones de Meet Manager.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseHyvFile, HYV_VERSION_VERIFICADA } from "../src/modules/meet-import/hyv-parser";
import { ValidationError } from "../src/shared/errors";

/** Ejecuta algo que debe fallar y devuelve el mensaje del error. */
function capturarMensaje(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("se esperaba un rechazo y no lo hubo");
}

const FIXTURES = path.join(__dirname, "fixtures");
const leerFixture = (n: string) => fs.readFileSync(path.join(FIXTURES, n), "latin1");

/** Encabezado válido de 11 campos, con los valores sobrescribibles. */
function encabezado(cambios: Partial<Record<number, string>> = {}): string {
  const campos = [
    "Competencia de Prueba",
    "01/01/2030",
    "01/01/2030",
    "12/31/2030",
    "S",
    "Piscina de Prueba",
    "",
    "Hy-Tek Sports Software",
    HYV_VERSION_VERIFICADA,
    "CN",
    "0000I",
  ];
  for (const [i, v] of Object.entries(cambios)) campos[Number(i)] = v!;
  return campos.join(";");
}

/** Línea de prueba válida de 18 campos, con los valores sobrescribibles. */
function prueba(cambios: Partial<Record<number, string>> = {}): string {
  const campos = ["1", "F", "F", "I", "0", "0", "50", "1", "", "", "", "0", "", "", "", "", "", ""];
  for (const [i, v] of Object.entries(cambios)) campos[Number(i)] = v!;
  return campos.join(";");
}

const archivo = (...lineas: string[]) => lineas.join("\r\n") + "\r\n";

describe("parseHyvFile — encabezado", () => {
  it("lee nombre y las tres fechas del fixture sintético", () => {
    const meet = parseHyvFile(leerFixture("sample-hyv-nativo.hyv"));
    expect(meet.name).toBe("Competencia Sintética de Pruebas");
    expect(meet.startDate.toISOString().slice(0, 10)).toBe("2030-01-01");
    expect(meet.endDate.toISOString().slice(0, 10)).toBe("2030-01-01");
    expect(meet.ageCutoffDate.toISOString().slice(0, 10)).toBe("2030-12-31");
  });

  it("interpreta las fechas como MM/DD/AAAA, no DD/MM", () => {
    // Es el orden demostrado por el archivo real: su corte de edad, 12/31,
    // sería el día 12 del mes 31 en el otro orden.
    const meet = parseHyvFile(archivo(encabezado({ 1: "10/03/2026", 2: "10/04/2026", 3: "12/31/2026" }), prueba()));
    expect(meet.startDate.toISOString().slice(0, 10)).toBe("2026-10-03");
    expect(meet.endDate.toISOString().slice(0, 10)).toBe("2026-10-04");
    expect(meet.ageCutoffDate.toISOString().slice(0, 10)).toBe("2026-12-31");
  });

  it("rechaza una fecha imposible en vez de acomodarla", () => {
    // 31/12 en las posiciones mes/día: si el parser "corrigiera" el orden,
    // aceptaría archivos de otro formato y los leería mal en silencio.
    expect(() => parseHyvFile(archivo(encabezado({ 1: "31/12/2030" }), prueba()))).toThrow(/fecha de inicio/i);
  });

  it("lanza si falta cualquiera de las tres fechas, nombrando cuál", () => {
    expect(() => parseHyvFile(archivo(encabezado({ 1: "" }), prueba()))).toThrow(/fecha de inicio/i);
    expect(() => parseHyvFile(archivo(encabezado({ 2: "no-es-fecha" }), prueba()))).toThrow(/fecha de fin/i);
    expect(() => parseHyvFile(archivo(encabezado({ 3: "" }), prueba()))).toThrow(/corte de edad/i);
  });

  it("lanza con un archivo vacío", () => {
    expect(() => parseHyvFile("")).toThrow(/vacío/i);
    expect(() => parseHyvFile("   \r\n  \r\n")).toThrow(/vacío/i);
  });

  it("avisa, sin rechazar, cuando el nombre viene en blanco", () => {
    const meet = parseHyvFile(archivo(encabezado({ 0: "" }), prueba()));
    expect(meet.name).toBe("");
    expect(meet.warnings.some((w) => /nombre de la competencia/i.test(w))).toBe(true);
    expect(meet.events).toHaveLength(1);
  });
});

describe("parseHyvFile — pruebas", () => {
  const meet = parseHyvFile(leerFixture("sample-hyv-nativo.hyv"));

  it("lee las 14 pruebas del fixture sin avisos", () => {
    expect(meet.events).toHaveLength(14);
    expect(meet.warnings).toEqual([]);
  });

  it("mapea los cinco códigos de estilo, cada uno como se verificó contra el .ev3 pareado", () => {
    const porNumero = new Map(meet.events.map((e) => [e.eventNumber, e]));
    // Códigos 1..5 ↔ A..E del .ev3: Libre, Espalda, Pecho, Mariposa, Combinado.
    expect(porNumero.get(1)!.strokeName).toBe("Libre"); // 1
    expect(porNumero.get(5)!.strokeName).toBe("Espalda"); // 2
    expect(porNumero.get(7)!.strokeName).toBe("Pecho"); // 3
    expect(porNumero.get(3)!.strokeName).toBe("Mariposa"); // 4
    expect(porNumero.get(11)!.strokeName).toBe("Combinado"); // 5
    // Y los cinco están representados, no solo los que se comprobaron arriba.
    expect(new Set(meet.events.map((e) => e.strokeName))).toEqual(
      new Set(["Libre", "Espalda", "Pecho", "Mariposa", "Combinado"])
    );
  });

  it("lee el género del campo [2] y no del constante [1]", () => {
    // LA TRAMPA DEL FORMATO: [1] vale "F" en TODAS las líneas y no es el
    // género. Un parser que tomara el primer campo con forma de género daría
    // todo femenino. Aquí [1]="F" y [2]="M" deben producir un varón.
    const meet = parseHyvFile(archivo(encabezado(), prueba({ 1: "F", 2: "M" })));
    expect(meet.events[0]!.gender).toBe("male");
    expect(meet.warnings).toEqual([]);
  });

  it("reparte los géneros del fixture como el .ev3 del que se tradujo", () => {
    expect(meet.events.filter((e) => e.gender === "female")).toHaveLength(7);
    expect(meet.events.filter((e) => e.gender === "male")).toHaveLength(7);
  });

  it("distingue individual de relevo y guarda la distancia TOTAL", () => {
    const relevos = meet.events.filter((e) => e.isRelay);
    expect(relevos).toHaveLength(4);
    // 200 es el total de un 4×50, según la convención de relayDistance.util.
    expect(relevos.every((e) => e.distanceMeters === 200)).toBe(true);
    expect(meet.events.filter((e) => !e.isRelay)).toHaveLength(10);
  });

  it("deja la jornada vacía y el día sin definir en TODAS las pruebas", () => {
    // No es una carencia del parser: se comprobó campo por campo que el
    // formato no trae ni la hora ni nada que separe un día de otro.
    expect(meet.events.every((e) => e.sessionTime === "")).toBe(true);
    expect(meet.events.every((e) => e.eventDate === undefined)).toBe(true);
  });
});

describe("parseHyvFile — líneas que no encajan: se omiten con aviso, no abortan", () => {
  it("omite una prueba con código de estilo desconocido y lo NOMBRA", () => {
    const meet = parseHyvFile(archivo(encabezado(), prueba({ 0: "1" }), prueba({ 0: "2", 7: "9" })));
    expect(meet.events.map((e) => e.eventNumber)).toEqual([1]);
    expect(meet.warnings.some((w) => /Prueba 2/.test(w) && /"9"/.test(w) && /se esperaba 1 a 5/i.test(w))).toBe(true);
  });

  it("omite una prueba con género desconocido y lo NOMBRA en vez de adivinarlo", () => {
    // No se inventa un código para "mixto": si aparece, hay que verlo.
    const meet = parseHyvFile(archivo(encabezado(), prueba({ 0: "1", 2: "X" })));
    expect(meet.events).toHaveLength(0);
    expect(meet.warnings.some((w) => /Prueba 1/.test(w) && /"X"/.test(w) && /se esperaba F o M/i.test(w))).toBe(true);
  });

  it("omite tipos distintos de I y R", () => {
    const meet = parseHyvFile(archivo(encabezado(), prueba({ 0: "1", 3: "Z" })));
    expect(meet.events).toHaveLength(0);
    expect(meet.warnings.some((w) => /"Z"/.test(w) && /se esperaba I o R/i.test(w))).toBe(true);
  });

  it("omite distancias vacías, cero, negativas o no numéricas", () => {
    for (const valor of ["", "0", "-50", "cincuenta", "50.5"]) {
      const meet = parseHyvFile(archivo(encabezado(), prueba({ 0: "1", 6: valor })));
      expect(meet.events, `distancia "${valor}"`).toHaveLength(0);
      expect(meet.warnings.some((w) => /distancia/i.test(w)), `distancia "${valor}"`).toBe(true);
    }
  });

  it("omite números de prueba vacíos, no numéricos o no positivos", () => {
    for (const valor of ["", "  ", "abc", "0", "-3", "2.5"]) {
      const meet = parseHyvFile(archivo(encabezado(), prueba({ 0: valor })));
      expect(meet.events, `número "${valor}"`).toHaveLength(0);
      expect(meet.warnings.some((w) => /número de prueba/i.test(w)), `número "${valor}"`).toBe(true);
    }
  });

  it("una línea mala no impide leer las buenas", () => {
    const meet = parseHyvFile(
      archivo(encabezado(), prueba({ 0: "1" }), prueba({ 0: "2", 7: "" }), prueba({ 0: "3", 2: "M" }))
    );
    expect(meet.events.map((e) => e.eventNumber)).toEqual([1, 3]);
    expect(meet.warnings).toHaveLength(1);
  });

  it("avisa cuando NINGUNA prueba se pudo interpretar", () => {
    const meet = parseHyvFile(archivo(encabezado(), prueba({ 7: "9" })));
    expect(meet.events).toHaveLength(0);
    expect(meet.warnings.some((w) => /ninguna prueba/i.test(w))).toBe(true);
  });
});

/**
 * SOLO SE ACEPTA LA VERSIÓN Y LA DISPOSICIÓN VERIFICADAS.
 *
 * Estas pruebas fijan un cambio de criterio deliberado: antes, un archivo con
 * otra disposición se interpretaba por posición y se avisaba. Ahora se
 * rechaza. El motivo es el modo de fallar, no la probabilidad de acertar: un
 * rechazo se resuelve exportando el `.ev3`, mientras que una competencia
 * importada con los campos desplazados se ve completa y puede llegar hasta las
 * inscripciones con distancias y estilos equivocados.
 */
describe("parseHyvFile — solo la versión y la disposición verificadas", () => {
  it("acepta sin avisos el archivo que sí coincide", () => {
    const meet = parseHyvFile(archivo(encabezado(), prueba()));
    expect(meet.warnings).toEqual([]);
    expect(meet.events).toHaveLength(1);
  });

  it("RECHAZA cuando la versión del exportador es otra, nombrándola", () => {
    expect(() => parseHyvFile(archivo(encabezado({ 8: "8.1Ab" }), prueba()))).toThrow(/8\.1Ab/);
    expect(() => parseHyvFile(archivo(encabezado({ 8: "8.1Ab" }), prueba()))).toThrow(
      new RegExp(HYV_VERSION_VERIFICADA.replace(".", "\\."))
    );
  });

  it("RECHAZA cuando el archivo no declara ninguna versión", () => {
    expect(() => parseHyvFile(archivo(encabezado({ 8: "" }), prueba()))).toThrow(/\(ninguna\)/);
  });

  it("RECHAZA un encabezado que no tenga exactamente 11 campos", () => {
    expect(() => parseHyvFile(archivo(encabezado() + ";extra", prueba()))).toThrow(/encabezado.*12 campos.*11/is);
    expect(() => parseHyvFile(archivo(encabezado().replace(/;[^;]*$/, ""), prueba()))).toThrow(/encabezado.*10 campos.*11/is);
  });

  it("RECHAZA si UNA SOLA línea de prueba no trae los 18 campos, y dice cuál", () => {
    // Una sola línea desplazada basta: lo que cambió es la gramática, y las
    // demás podrían estar igual de mal sin que la cantidad lo delate.
    expect(() => parseHyvFile(archivo(encabezado(), prueba({ 0: "1" }), prueba({ 0: "2" }) + ";extra"))).toThrow(
      /línea 3.*19 campos.*18/is
    );
  });

  it("el rechazo explica qué hacer: exportar el .ev3 o informar el archivo", () => {
    try {
      parseHyvFile(archivo(encabezado({ 8: "9.9Zz" }), prueba()));
      throw new Error("debió rechazar");
    } catch (err) {
      const mensaje = (err as Error).message;
      expect(mensaje).toMatch(/No se importó nada/i);
      expect(mensaje).toMatch(/\.ev3/);
      expect(mensaje).toMatch(/informe este archivo/i);
    }
  });

  it("el rechazo es un ValidationError, para que el motivo quede en la auditoría", () => {
    /**
     * No es un detalle de tipos. `describirFallo`, en `meet-import.service`,
     * guarda en `audit_logs` el mensaje de un `ValidationError` y solo la
     * clase de cualquier otro error —porque uno de Prisma traería la consulta
     * y sus valores—. Con un `Error` corriente, el rechazo de un `.hyv` de
     * otra versión se registraba con `reason: null`: el día que aparezca ese
     * archivo, el registro no diría por qué se rechazó, que es justo el dato
     * necesario para incorporar su formato.
     */
    expect(() => parseHyvFile(archivo(encabezado({ 8: "8.1Ab" }), prueba()))).toThrow(ValidationError);
    expect(() => parseHyvFile(archivo(encabezado() + ";extra", prueba()))).toThrow(ValidationError);
    expect(() => parseHyvFile(archivo(encabezado(), prueba() + ";extra"))).toThrow(ValidationError);
    expect(() => parseHyvFile("")).toThrow(ValidationError);
    expect(() => parseHyvFile(archivo(encabezado({ 1: "" }), prueba()))).toThrow(ValidationError);
  });

  it("acota lo que copia del archivo al mensaje, que también se guarda", () => {
    // El archivo lo sube el usuario y `audit_logs` se expone por la API y se
    // exporta a planilla: un valor larguísimo o con caracteres de control no
    // debe viajar entero hasta ahí.
    const largo = "X".repeat(500);
    const mensaje = capturarMensaje(() => parseHyvFile(archivo(encabezado({ 8: largo }), prueba())));
    expect(mensaje).toMatch(/…/);
    expect(mensaje.length).toBeLessThan(600);
    expect(mensaje).not.toContain(largo);

    const conControles = capturarMensaje(() => parseHyvFile(archivo(encabezado({ 8: "8.1\u0001\u001bAb" }), prueba())));
    const hayControles = [...conControles].some((c) => {
      const codigo = c.codePointAt(0)!;
      return codigo <= 0x1f || codigo === 0x7f;
    });
    expect(hayControles).toBe(false);
    // El valor sigue siendo reconocible una vez limpio: se acota, no se borra.
    expect(conControles).toContain("8.1Ab");
  });

  it("la disposición se comprueba ANTES que los datos del encabezado", () => {
    // Con un encabezado de otra forma, las fechas que se leerían de él no
    // significan necesariamente lo que creemos: el mensaje debe hablar de la
    // disposición, no de una fecha ilegible.
    expect(() => parseHyvFile(archivo("solo;dos", prueba()))).toThrow(/2 campos/);
  });

  it("un código de estilo desconocido NO rechaza el archivo: es un dato, no la disposición", () => {
    // La distinción importa: aquí el layout es correcto y el problema está
    // acotado a una línea, así que se salta con aviso y el resto entra.
    const meet = parseHyvFile(archivo(encabezado(), prueba({ 0: "1" }), prueba({ 0: "2", 7: "9" })));
    expect(meet.events).toHaveLength(1);
    expect(meet.warnings).toHaveLength(1);
  });

  it("no confunde una propiedad heredada de Object con un código válido", () => {
    // Con `tabla[codigo]` a secas, "constructor" devuelve una función —un
    // valor verdadero— y la prueba entraría con un estilo inventado.
    for (const codigo of ["constructor", "toString", "hasOwnProperty", "valueOf"]) {
      const meet = parseHyvFile(archivo(encabezado(), prueba({ 7: codigo })));
      expect(meet.events, codigo).toHaveLength(0);
      expect(meet.warnings.some((w) => /estilo/i.test(w)), codigo).toBe(true);
    }
    for (const codigo of ["constructor", "toString"]) {
      const meet = parseHyvFile(archivo(encabezado(), prueba({ 2: codigo })));
      expect(meet.events, codigo).toHaveLength(0);
      expect(meet.warnings.some((w) => /género/i.test(w)), codigo).toBe(true);
    }
  });
});
