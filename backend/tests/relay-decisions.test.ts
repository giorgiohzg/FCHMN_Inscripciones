/**
 * Confirmación explícita del tipo de relevo.
 *
 * Lo que estas pruebas protegen, en una frase: **ningún relevo se importa sin
 * una decisión propia y explícita**. Ni por tener el catálogo un solo tipo, ni
 * por parecerse a otro relevo del mismo archivo, ni por omisión del cliente.
 */
import { describe, it, expect } from "vitest";
import {
  OMITIR,
  huellaDelArchivo,
  relevosParaConfirmar,
  validarDecisiones,
  type DecisionDeRelevo,
  type TipoDeRelevoDisponible,
} from "../src/modules/meet-import/relay-decisions";
import type { ParsedMeetEvent } from "../src/modules/meet-import/ev3-parser";

const CUATRO: TipoDeRelevoDisponible = { id: "11111111-1111-1111-1111-111111111111", name: "Relevo", swimmersCount: 4 };
const DOS: TipoDeRelevoDisponible = { id: "22222222-2222-2222-2222-222222222222", name: "Relevo por parejas", swimmersCount: 2 };
const TIPOS = [DOS, CUATRO];

function relevo(eventNumber: number, extra: Partial<ParsedMeetEvent> = {}): ParsedMeetEvent {
  return {
    eventNumber,
    isRelay: true,
    gender: "female",
    distanceMeters: 200,
    strokeName: "Libre",
    sessionTime: "",
    ...extra,
  };
}

function individual(eventNumber: number): ParsedMeetEvent {
  return { eventNumber, isRelay: false, gender: "male", distanceMeters: 50, strokeName: "Libre", sessionTime: "" };
}

const elegir = (eventNumber: number, testTypeId: string): DecisionDeRelevo => ({ eventNumber, decision: "tipo", testTypeId });
const omitir = (eventNumber: number): DecisionDeRelevo => ({ eventNumber, decision: "omitir" });

describe("relevosParaConfirmar", () => {
  it("toma solo los relevos, en el orden del archivo", () => {
    const meet = { events: [individual(1), relevo(2), individual(3), relevo(4)] };
    expect(relevosParaConfirmar(meet, TIPOS).map((r) => r.eventNumber)).toEqual([2, 4]);
  });

  it("no propone ninguna opción como elegida", () => {
    // Un valor por omisión sería la elección automática que se quiso quitar,
    // disfrazada de propuesta. Las opciones no tienen campo de selección.
    const [fila] = relevosParaConfirmar({ events: [relevo(1)] }, TIPOS);
    expect(fila!.opciones).toHaveLength(2);
    for (const opcion of fila!.opciones) {
      expect(Object.keys(opcion).sort()).toEqual(["divisible", "etiqueta", "nombre", "swimmersCount", "testTypeId"]);
    }
  });

  it("muestra la consecuencia de cada opción, para que la elección sea legible", () => {
    const [fila] = relevosParaConfirmar({ events: [relevo(1, { distanceMeters: 200 })] }, TIPOS);
    const porPostas = new Map(fila!.opciones.map((o) => [o.swimmersCount, o]));
    expect(porPostas.get(4)!.etiqueta).toBe("4×50");
    expect(porPostas.get(2)!.etiqueta).toBe("2×100");
    expect(porPostas.get(4)!.divisible).toBe(true);
  });

  it("marca como no divisible el total que no cuadra con las postas", () => {
    const [fila] = relevosParaConfirmar({ events: [relevo(1, { distanceMeters: 150 })] }, [CUATRO]);
    expect(fila!.opciones[0]!.divisible).toBe(false);
    expect(fila!.opciones[0]!.etiqueta).toBe("150"); // se muestra el total crudo
  });

  it("sin tipos de relevo en el catálogo, la fila queda sin opciones", () => {
    const [fila] = relevosParaConfirmar({ events: [relevo(1)] }, []);
    expect(fila!.opciones).toEqual([]);
  });
});

describe("huellaDelArchivo", () => {
  it("es estable para el mismo contenido y distinta para contenidos distintos", () => {
    const a = Buffer.from("contenido de prueba", "latin1");
    expect(huellaDelArchivo(a)).toBe(huellaDelArchivo(Buffer.from("contenido de prueba", "latin1")));
    expect(huellaDelArchivo(a)).not.toBe(huellaDelArchivo(Buffer.from("contenido de pruebaX", "latin1")));
  });

  it("cambia ante una diferencia de UN byte", () => {
    const a = Buffer.from([1, 2, 3, 4]);
    const b = Buffer.from([1, 2, 3, 5]);
    expect(huellaDelArchivo(a)).not.toBe(huellaDelArchivo(b));
  });
});

/**
 * EL CASO QUE OBLIGA A DECIDIR POR PRUEBA.
 *
 * Dos relevos con la misma distancia, el mismo estilo y el mismo género
 * pueden ser cosas distintas —un 4×50 y un 2×100 son ambos "200 Libre
 * damas"—. Agrupar por esa firma le impondría a uno la decisión del otro.
 */
describe("dos relevos idénticos en distancia, estilo y género", () => {
  const meet = { events: [relevo(11), relevo(23)] };

  it("se presentan como DOS filas, no como una", () => {
    const filas = relevosParaConfirmar(meet, TIPOS);
    expect(filas).toHaveLength(2);
    expect(filas.map((f) => f.eventNumber)).toEqual([11, 23]);
    // Idénticos en todo lo demás: es justo lo que hace inservible agrupar.
    expect(filas[0]!.distanceMeters).toBe(filas[1]!.distanceMeters);
    expect(filas[0]!.strokeName).toBe(filas[1]!.strokeName);
    expect(filas[0]!.gender).toBe(filas[1]!.gender);
  });

  it("admiten decisiones DISTINTAS y cada una se respeta", () => {
    const filas = relevosParaConfirmar(meet, TIPOS);
    const r = validarDecisiones(filas, [elegir(11, CUATRO.id), elegir(23, DOS.id)], TIPOS);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.porPrueba.get(11)).toBe(CUATRO.id);
    expect(r.porPrueba.get(23)).toBe(DOS.id);
  });

  it("uno puede importarse y el otro omitirse", () => {
    const filas = relevosParaConfirmar(meet, TIPOS);
    const r = validarDecisiones(filas, [elegir(11, CUATRO.id), omitir(23)], TIPOS);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.porPrueba.get(11)).toBe(CUATRO.id);
    expect(r.porPrueba.get(23)).toBe(OMITIR);
  });

  it("decidir uno NO decide el otro", () => {
    const filas = relevosParaConfirmar(meet, TIPOS);
    const r = validarDecisiones(filas, [elegir(11, CUATRO.id)], TIPOS);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.join(" ")).toMatch(/Faltan decisiones para 1 relevo/);
    expect(r.errores.join(" ")).toMatch(/#23/);
  });
});

describe("validarDecisiones — nada se importa por omisión", () => {
  const filas = relevosParaConfirmar({ events: [relevo(1), relevo(2)] }, TIPOS);

  it("sin ninguna decisión, falla y nombra todos los relevos pendientes", () => {
    const r = validarDecisiones(filas, [], TIPOS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.join(" ")).toMatch(/Faltan decisiones para 2 relevo/);
    expect(r.errores.join(" ")).toMatch(/#1/);
    expect(r.errores.join(" ")).toMatch(/#2/);
    expect(r.errores.join(" ")).toMatch(/ninguno se importa por omisión/i);
  });

  it("omitir es una decisión que hay que pedir, y vale como tal", () => {
    const r = validarDecisiones(filas, [omitir(1), omitir(2)], TIPOS);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.porPrueba.values()]).toEqual([OMITIR, OMITIR]);
  });

  it("sin relevos en el archivo, no hace falta ninguna decisión", () => {
    const r = validarDecisiones([], [], TIPOS);
    expect(r.ok).toBe(true);
  });
});

describe("validarDecisiones — el catálogo se valida en el momento de importar", () => {
  const filas = relevosParaConfirmar({ events: [relevo(7)] }, TIPOS);

  it("RECHAZA una elección que ya no existe en el catálogo", () => {
    // El tipo se borró entre el análisis y la confirmación: la elección dejó
    // de significar algo, e importar con otro sería decidir por el usuario
    // justo lo que él vino a decidir.
    const r = validarDecisiones(filas, [elegir(7, DOS.id)], [CUATRO]);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.join(" ")).toMatch(/ya no existe en el catálogo/i);
    expect(r.errores.join(" ")).toMatch(/#7/);
    expect(r.errores.join(" ")).toMatch(/vuelva a analizar/i);
  });

  it("RECHAZA un identificador inventado", () => {
    const r = validarDecisiones(filas, [elegir(7, "99999999-9999-9999-9999-999999999999")], TIPOS);
    expect(r.ok).toBe(false);
  });

  it("RECHAZA elegir un tipo que no es de relevo", () => {
    // `TIPOS` solo contiene tipos de relevo; el id de un tipo individual no
    // está en la lista y por eso no pasa. La comprobación es la misma.
    const r = validarDecisiones(filas, [elegir(7, "33333333-3333-3333-3333-333333333333")], TIPOS);
    expect(r.ok).toBe(false);
  });

  it("acepta cuando el tipo elegido sigue estando", () => {
    const r = validarDecisiones(filas, [elegir(7, CUATRO.id)], TIPOS);
    expect(r.ok).toBe(true);
  });
});

describe("validarDecisiones — decisiones que no corresponden al archivo", () => {
  const filas = relevosParaConfirmar({ events: [individual(1), relevo(2)] }, TIPOS);

  it("RECHAZA una decisión para una prueba que no es relevo", () => {
    const r = validarDecisiones(filas, [elegir(2, CUATRO.id), elegir(1, CUATRO.id)], TIPOS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.join(" ")).toMatch(/#1.*no es un relevo de este archivo/i);
  });

  it("RECHAZA una decisión para una prueba inexistente", () => {
    const r = validarDecisiones(filas, [elegir(2, CUATRO.id), elegir(99, CUATRO.id)], TIPOS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.join(" ")).toMatch(/#99/);
  });

  it("RECHAZA dos decisiones para la misma prueba", () => {
    const r = validarDecisiones(filas, [elegir(2, CUATRO.id), omitir(2)], TIPOS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.join(" ")).toMatch(/más de una decisión para la prueba #2/i);
  });

  it("junta TODOS los problemas en vez de informar el primero", () => {
    const filas2 = relevosParaConfirmar({ events: [relevo(1), relevo(2), relevo(3)] }, TIPOS);
    const r = validarDecisiones(filas2, [elegir(99, CUATRO.id), elegir(1, "sin-registro")], TIPOS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Uno por la prueba ajena, uno por el tipo inexistente, uno por las que faltan.
    expect(r.errores.length).toBeGreaterThanOrEqual(3);
  });
});

describe("validarDecisiones — números de prueba repetidos", () => {
  it("RECHAZA el archivo: la decisión por prueba sería ambigua", () => {
    const filas = relevosParaConfirmar({ events: [relevo(5), relevo(5)] }, TIPOS);
    const r = validarDecisiones(filas, [elegir(5, CUATRO.id)], TIPOS);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores).toHaveLength(1); // invalida todo lo demás: se informa solo esto
    expect(r.errores[0]).toMatch(/más de un relevo con el mismo número de prueba \(5\)/i);
  });
});
