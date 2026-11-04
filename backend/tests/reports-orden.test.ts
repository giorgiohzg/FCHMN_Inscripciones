/**
 * ORDEN de la vista agrupada de Reportes (y de las filas planas de CSV / XLSX / PDF).
 *
 * Pruebas puras del criterio de `reports.rules.ts`. Los casos de extremo a extremo
 * —datos reales en la base, los tres formatos— están en el bloque «Reportes: orden…»
 * de `import-export-services.integration.test.ts`.
 *
 *   - Nadadores de un club: por APELLIDO PATERNO (no por edad).
 *   - Pruebas y relevos de un nadador: por número de programa NUMÉRICO; los
 *     repetidos o ausentes, por descripción y tiempo; el id solo al final.
 *   - Todo determinista: el orden de PRESENTACIÓN no depende del orden de entrada.
 *   - Categoría y club mostrados: NO son parte del orden; los decide la primera
 *     inscripción que entrega el servicio (individuales antes que relevos), como siempre.
 */
import { describe, it, expect } from "vitest";
import {
  groupReportByClubAndSwimmer,
  compararNadadores,
  compararNumerosDePrograma,
  compararLineasDePrueba,
  compararFilasIndividuales,
  compararFilasDeRelevo,
  lineaDePrueba,
  type SwimmerEventEntry,
} from "../src/modules/reports/reports.rules";

const CORTE = new Date("2026-12-31T00:00:00Z");

function entry(over: Partial<SwimmerEventEntry> = {}): SwimmerEventEntry {
  return {
    personId: "p1",
    run: "1",
    fullName: "Nombre Apellido",
    clubName: "Delfines",
    birthDate: new Date("2000-03-15T00:00:00Z"),
    gender: "female",
    categoryName: "25-29",
    eventNumber: 1,
    eventLabel: "50m Libre",
    timeLabel: null,
    kind: "individual",
    ...over,
  };
}

/** Todas las permutaciones de una lista corta (≤ 6 elementos). */
function permutaciones<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) => permutaciones([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
}

const nombres = (entries: SwimmerEventEntry[]) => groupReportByClubAndSwimmer(entries, CORTE)[0]!.swimmers.map((s) => s.nombreCompleto);

describe("nadadores: por apellido paterno", () => {
  it("ordena por apellido paterno aunque las edades vayan en sentido CONTRARIO", () => {
    const entradas = [
      entry({ personId: "a", run: "1", fullName: "Zoe Zamora Pérez", paternalLastName: "Zamora", maternalLastName: "Pérez", firstName: "Zoe", birthDate: new Date("2012-01-01T00:00:00Z") }),
      entry({ personId: "b", run: "2", fullName: "Ana Soto Díaz", paternalLastName: "Soto", maternalLastName: "Díaz", firstName: "Ana", birthDate: new Date("1995-01-01T00:00:00Z") }),
      entry({ personId: "c", run: "3", fullName: "Bea Araya Luna", paternalLastName: "Araya", maternalLastName: "Luna", firstName: "Bea", birthDate: new Date("1960-01-01T00:00:00Z") }),
    ];
    // Por edad (de menor a mayor) saldrían Zamora, Soto, Araya: el opuesto.
    expect(nombres(entradas)).toEqual(["Bea Araya Luna", "Ana Soto Díaz", "Zoe Zamora Pérez"]);
  });

  it("la edad, la categoría y el nombre mostrados no cambian", () => {
    const g = groupReportByClubAndSwimmer(
      [entry({ personId: "a", fullName: "Zoe Zamora Pérez", paternalLastName: "Zamora", categoryName: "10-14", birthDate: new Date("2012-06-01T00:00:00Z") })],
      CORTE
    );
    expect(g[0]!.swimmers[0]).toMatchObject({ nombreCompleto: "Zoe Zamora Pérez", edad: 14, categoria: "10-14", genero: "Damas" });
  });

  it("empate de apellido paterno: desempata el materno, luego el nombre de pila", () => {
    const base = { paternalLastName: "Pérez" };
    const entradas = [
      entry({ ...base, personId: "1", run: "1", fullName: "Luis Pérez Soto", maternalLastName: "Soto", firstName: "Luis" }),
      entry({ ...base, personId: "2", run: "2", fullName: "Marta Pérez Araya", maternalLastName: "Araya", firstName: "Marta" }),
      entry({ ...base, personId: "3", run: "3", fullName: "Ana Pérez Soto", maternalLastName: "Soto", firstName: "Ana" }),
    ];
    expect(nombres(entradas)).toEqual(["Marta Pérez Araya", "Ana Pérez Soto", "Luis Pérez Soto"]);
  });

  it("sin distinguir mayúsculas ni tildes: «Perez» y «PÉREZ» empatan y el desempate sigue las demás claves", () => {
    const entradas = [
      entry({ personId: "1", run: "1", fullName: "Luis PÉREZ", paternalLastName: "PÉREZ", maternalLastName: "Soto", firstName: "Luis" }),
      entry({ personId: "2", run: "2", fullName: "Ana Perez", paternalLastName: "Perez", maternalLastName: "Díaz", firstName: "Ana" }),
    ];
    expect(nombres(entradas)).toEqual(["Ana Perez", "Luis PÉREZ"]);
  });

  it("la eñe es una letra propia: «Muñoz» va después de «Mulder» y antes de «Nuñez»", () => {
    const entradas = ["Nuñez", "Muñoz", "Mulder"].map((a, i) => entry({ personId: String(i), run: String(i), fullName: `X ${a}`, paternalLastName: a }));
    expect(nombres(entradas)).toEqual(["X Mulder", "X Muñoz", "X Nuñez"]);
  });

  it("empate total de nombre: desempata el RUN y, al final, el identificador", () => {
    const iguales = { fullName: "Ana Rojas Luna", paternalLastName: "Rojas", maternalLastName: "Luna", firstName: "Ana" };
    const porRun = [entry({ ...iguales, personId: "z", run: "9" }), entry({ ...iguales, personId: "a", run: "2" })];
    expect(groupReportByClubAndSwimmer(porRun, CORTE)[0]!.swimmers.map((s) => s.run)).toEqual(["2", "9"]);
    const porId = [entry({ ...iguales, personId: "z", run: "5" }), entry({ ...iguales, personId: "a", run: "5" })];
    // Con el mismo RUN el orden lo da el identificador; se comprueba con el comparador.
    expect(compararNadadores({ ...iguales, run: "5", personId: "a" }, { ...iguales, run: "5", personId: "z" })).toBeLessThan(0);
    expect(porId).toHaveLength(2);
  });

  describe("personas HISTÓRICAS sin apellido paterno", () => {
    const entradas = [
      entry({ personId: "h1", run: "5", fullName: "Carmen del Río" }), // sin paternalLastName
      entry({ personId: "n1", run: "6", fullName: "Ana Zúñiga", paternalLastName: "Zúñiga", firstName: "Ana" }),
      entry({ personId: "h2", run: "7", fullName: "Abel Vergara", paternalLastName: "   " }), // vacío / espacios = ausente
      entry({ personId: "n2", run: "8", fullName: "Bea Alvear", paternalLastName: "Alvear", firstName: "Bea" }),
      entry({ personId: "h3", run: "9", fullName: "Zoe Ñancul", paternalLastName: null, maternalLastName: "Aguilar", firstName: "Zoe" }),
    ];

    it("van DESPUÉS de las que sí tienen apellido paterno, ordenadas por su nombre completo almacenado", () => {
      expect(nombres(entradas)).toEqual(["Bea Alvear", "Ana Zúñiga", "Abel Vergara", "Carmen del Río", "Zoe Ñancul"]);
    });

    it("no se modifica ni se inventa ningún nombre: el mostrado es el almacenado, tal cual", () => {
      const mostrados = groupReportByClubAndSwimmer(entradas, CORTE)[0]!.swimmers.map((s) => s.nombreCompleto);
      expect([...mostrados].sort()).toEqual(entradas.map((e) => e.fullName).sort());
    });

    it("un materno o un nombre suelto, sin paterno, NO se usan como clave", () => {
      // «Zoe Ñancul» tiene materno «Aguilar»: aun así queda con las históricas, por su nombre completo.
      const g = nombres(entradas);
      expect(g.indexOf("Zoe Ñancul")).toBeGreaterThan(g.indexOf("Carmen del Río"));
    });

    it("el resultado es el mismo con cualquier orden de entrada", () => {
      const esperado = nombres(entradas);
      for (const orden of permutaciones(entradas)) expect(nombres(orden)).toEqual(esperado);
    });
  });

  it("DETERMINISMO: todas las permutaciones de una lista con empates dan el mismo orden", () => {
    const entradas = [
      entry({ personId: "1", run: "1", fullName: "Ana Pérez Soto", paternalLastName: "Pérez", maternalLastName: "Soto", firstName: "Ana" }),
      entry({ personId: "2", run: "2", fullName: "Ana Pérez Soto", paternalLastName: "Pérez", maternalLastName: "Soto", firstName: "Ana" }),
      entry({ personId: "3", run: "3", fullName: "Luis Pérez Araya", paternalLastName: "Pérez", maternalLastName: "Araya", firstName: "Luis" }),
      entry({ personId: "4", run: "4", fullName: "Sin Apellido" }),
      entry({ personId: "5", run: "5", fullName: "Abel Alvear", paternalLastName: "Alvear" }),
    ];
    const g = (es: SwimmerEventEntry[]) => groupReportByClubAndSwimmer(es, CORTE)[0]!.swimmers.map((s) => s.run);
    const esperado = g(entradas);
    for (const orden of permutaciones(entradas)) expect(g(orden)).toEqual(esperado);
    expect(esperado).toEqual(["5", "3", "1", "2", "4"]);
  });

  it("los clubes siguen agrupados y en orden alfabético", () => {
    const g = groupReportByClubAndSwimmer(
      [
        entry({ personId: "1", clubName: "Norte", paternalLastName: "Ñ" }),
        entry({ personId: "2", clubName: "Austral", paternalLastName: "B" }),
        entry({ personId: "3", clubName: "Norte", paternalLastName: "A" }),
      ],
      CORTE
    );
    expect(g.map((x) => x.clubName)).toEqual(["Austral", "Norte"]);
    expect(g[1]!.totalNadadores).toBe(2);
  });
});

describe("pruebas y relevos de un nadador: número de programa NUMÉRICO", () => {
  const lineas = (entries: SwimmerEventEntry[], cual: "pruebas" | "relevos") =>
    groupReportByClubAndSwimmer(entries, CORTE)[0]!.swimmers[0]![cual].map((l) => l.number);

  it("2, 3, 10 (y no 10, 2, 3), en individuales y en relevos por separado", () => {
    const entradas = [10, 2, 3].flatMap((n) => [
      entry({ eventNumber: n, eventLabel: `Individual ${n}`, kind: "individual" }),
      entry({ eventNumber: n + 100, eventLabel: `Relevo ${n}`, kind: "relay" }),
    ]);
    expect(lineas(entradas, "pruebas")).toEqual([2, 3, 10]);
    expect(lineas(entradas, "relevos")).toEqual([102, 103, 110]);
  });

  it("los números AUSENTES van al final, y entre sí se ordenan por texto", () => {
    const entradas = [
      entry({ eventNumber: null, eventLabel: "Zeta" }),
      entry({ eventNumber: 10, eventLabel: "Diez" }),
      entry({ eventNumber: null, eventLabel: "Alfa" }),
      entry({ eventNumber: 2, eventLabel: "Dos" }),
    ];
    const g = groupReportByClubAndSwimmer(entradas, CORTE)[0]!.swimmers[0]!.pruebas;
    expect(g.map((l) => `${l.number ?? "—"}:${l.text}`)).toEqual(["2:Dos", "10:Diez", "—:Alfa", "—:Zeta"]);
  });

  it("los números REPETIDOS se desempatan por texto, no por el orden de llegada", () => {
    const entradas = [
      entry({ eventNumber: 5, eventLabel: "100m Pecho", timeLabel: null }),
      entry({ eventNumber: 5, eventLabel: "100m Espalda", timeLabel: "1:10,00" }),
      entry({ eventNumber: 5, eventLabel: "100m Espalda", timeLabel: "1:05,00" }),
    ];
    const esperado = ["100m Espalda 1:05,00", "100m Espalda 1:10,00", "100m Pecho"];
    for (const orden of permutaciones(entradas)) {
      expect(groupReportByClubAndSwimmer(orden, CORTE)[0]!.swimmers[0]!.pruebas.map((l) => l.text)).toEqual(esperado);
    }
  });

  it("DETERMINISMO con ausentes y repetidos mezclados: todas las permutaciones dan lo mismo", () => {
    const entradas = [
      entry({ eventNumber: 3, eventLabel: "C" }),
      entry({ eventNumber: null, eventLabel: "Z" }),
      entry({ eventNumber: 3, eventLabel: "B" }),
      entry({ eventNumber: 10, eventLabel: "D" }),
      entry({ eventNumber: 2, eventLabel: "A" }),
    ];
    const f = (es: SwimmerEventEntry[]) => groupReportByClubAndSwimmer(es, CORTE)[0]!.swimmers[0]!.pruebas.map((l) => `${l.number}:${l.text}`);
    const esperado = f(entradas);
    expect(esperado).toEqual(["2:A", "3:B", "3:C", "10:D", "null:Z"]);
    for (const orden of permutaciones(entradas)) expect(f(orden)).toEqual(esperado);
  });

  it("los comparadores respetan el criterio por sí solos", () => {
    expect(compararNumerosDePrograma(2, 10)).toBeLessThan(0);
    expect(compararNumerosDePrograma(10, 2)).toBeGreaterThan(0);
    expect(compararNumerosDePrograma(null, 1)).toBeGreaterThan(0);
    expect(compararNumerosDePrograma(1, null)).toBeLessThan(0);
    expect(compararNumerosDePrograma(null, undefined)).toBe(0);
    expect(compararLineasDePrueba({ number: 4, text: "x" }, { number: 4, text: "x" })).toBe(0);
  });
});

describe("categoría y club mostrados: los de la primera inscripción entregada, NO los de la primera prueba del programa", () => {
  const swimmer = (entries: SwimmerEventEntry[]) => groupReportByClubAndSwimmer(entries, CORTE)[0]!.swimmers[0]!;

  it("con individuales y relevos, la categoría es la de la individual (el servicio las entrega primero)", () => {
    const entradas = [
      entry({ kind: "individual", categoryName: "25-29", eventNumber: 9 }),
      entry({ kind: "relay", categoryName: "80-99", eventNumber: 1, eventLabel: "Relevo" }),
    ];
    expect(swimmer(entradas).categoria).toBe("25-29");
  });

  it("REGRESIÓN: dos individuales de categorías distintas con orden de llegada CONTRARIO al programa: la categoría se conserva y las pruebas se muestran ordenadas", () => {
    // Llega primero la del programa 7 (categoría B); la del programa 2 (categoría A) llega después.
    const entradas = [
      entry({ categoryName: "Categoría B", eventNumber: 7, eventLabel: "Prueba siete" }),
      entry({ categoryName: "Categoría A", eventNumber: 2, eventLabel: "Prueba dos" }),
    ];
    const s = swimmer(entradas);
    expect(s.categoria).toBe("Categoría B"); // la de la primera inscripción que llegó, NO la del primer número de programa
    expect(s.pruebas.map((l) => `${l.number}:${l.text}`)).toEqual(["2:Prueba dos", "7:Prueba siete"]); // la presentación sí va ordenada
  });

  it("la categoría sigue el orden de llegada, no el del programa: invertida la llegada, cambia con ella", () => {
    const b = entry({ categoryName: "Categoría B", eventNumber: 7, eventLabel: "Prueba siete" });
    const a = entry({ categoryName: "Categoría A", eventNumber: 2, eventLabel: "Prueba dos" });
    expect(swimmer([a, b]).categoria).toBe("Categoría A");
    expect(swimmer([b, a]).categoria).toBe("Categoría B");
    // Y el orden de presentación es el mismo en ambos casos.
    expect(swimmer([a, b]).pruebas).toEqual(swimmer([b, a]).pruebas);
  });

  it("una prueba sin número de programa que llega primero también conserva su categoría", () => {
    const entradas = [
      entry({ categoryName: "Categoría C", eventNumber: null, eventLabel: "Sin número" }),
      entry({ categoryName: "Categoría A", eventNumber: 1, eventLabel: "Primera" }),
    ];
    const s = swimmer(entradas);
    expect(s.categoria).toBe("Categoría C");
    expect(s.pruebas.map((l) => l.text)).toEqual(["Primera", "Sin número"]);
  });

  it("SOLO RELEVOS: la categoría es la del primer relevo que llega; los relevos se muestran ordenados", () => {
    const entradas = [
      entry({ kind: "relay", categoryName: "R2", eventNumber: 8, eventLabel: "Relevo 2" }),
      entry({ kind: "relay", categoryName: "R1", eventNumber: 3, eventLabel: "Relevo 1" }),
    ];
    const s = swimmer(entradas);
    expect(s.categoria).toBe("R2");
    expect(s.pruebas).toEqual([]);
    expect(s.relevos.map((l) => `${l.number}:${l.text}`)).toEqual(["3:Relevo 1", "8:Relevo 2"]);
    expect(swimmer([entradas[1]!, entradas[0]!]).categoria).toBe("R1");
  });

  it("el club mostrado es el de la primera inscripción que llega, con las mismas reglas", () => {
    const entradas = [
      entry({ clubName: "Club Z", categoryName: "Z", eventNumber: 9, eventLabel: "Individual" }),
      entry({ kind: "relay", clubName: "Club A", categoryName: "A", eventNumber: 1, eventLabel: "Relevo" }),
    ];
    const grupos = groupReportByClubAndSwimmer(entradas, CORTE);
    expect(grupos.map((g) => g.clubName)).toEqual(["Club Z"]);
    expect(grupos[0]!.swimmers[0]!.relevos).toHaveLength(1);
  });

  it("nombre, edad y género provienen de la persona, no de la prueba", () => {
    const s = swimmer([entry({ fullName: "Ana Soto", birthDate: new Date("1990-06-01T00:00:00Z"), gender: "female" })]);
    expect([s.nombreCompleto, s.edad, s.genero]).toEqual(["Ana Soto", 36, "Damas"]);
  });
});

describe("desempate COMPARTIDO entre la vista agrupada y las filas planas", () => {
  /** Inscripciones de UN nadador, con ids que CONTRADICEN el texto (el id de «Pecho» es el menor). */
  const base = [
    { id: "id-1", numero: 5, etiqueta: "100m Pecho", tiempo: null as string | null },
    { id: "id-2", numero: 5, etiqueta: "100m Espalda", tiempo: "1:10,00" },
    { id: "id-3", numero: 5, etiqueta: "100m Espalda", tiempo: "1:05,00" },
    { id: "id-4", numero: null, etiqueta: "50m Mariposa", tiempo: null },
    { id: "id-5", numero: null, etiqueta: "50m Libre", tiempo: "30,00" },
    { id: "id-6", numero: 10, etiqueta: "200m Combinado", tiempo: null },
    { id: "id-7", numero: 2, etiqueta: "50m Libre", tiempo: null },
  ];
  type Insc = (typeof base)[number];
  const persona = { fullName: "Nadador Uno", run: "1", personId: "p1", paternalLastName: "Uno" };
  const filaPlana = (x: Insc) => ({ clubName: "Delfines", persona, linea: lineaDePrueba(x.numero, x.etiqueta, x.tiempo), id: x.id });
  const entrada = (x: Insc) =>
    entry({ personId: "p1", fullName: "Nadador Uno", paternalLastName: "Uno", eventNumber: x.numero, eventLabel: x.etiqueta, timeLabel: x.tiempo });
  const textoVisible = (x: Insc) => (x.tiempo ? `${x.etiqueta} ${x.tiempo}` : x.etiqueta);
  const ordenPlano = (xs: Insc[]) => xs.slice().sort((a, b) => compararFilasIndividuales(filaPlana(a), filaPlana(b)));

  it("la línea compartida construye el mismo texto que la vista agrupada", () => {
    for (const x of base) {
      const vista = groupReportByClubAndSwimmer([entrada(x)], CORTE)[0]!.swimmers[0]!.pruebas[0]!;
      expect(vista).toEqual(lineaDePrueba(x.numero, x.etiqueta, x.tiempo));
      expect(vista.text).toBe(textoVisible(x));
    }
  });

  it("filas planas: número numérico, ausentes al final, descripción y tiempo; el id NO decide antes que el texto", () => {
    expect(ordenPlano(base).map(textoVisible)).toEqual([
      "50m Libre", // 2
      "100m Espalda 1:05,00", // 5
      "100m Espalda 1:10,00", // 5
      "100m Pecho", // 5: su id (id-1) es el menor, pero por texto va después de «Espalda»
      "200m Combinado", // 10
      "50m Libre 30,00", // ausente
      "50m Mariposa", // ausente
    ]);
  });

  it("el orden relativo de las filas planas COINCIDE con el de la vista agrupada, con cualquier permutación", () => {
    const vista = groupReportByClubAndSwimmer(base.map(entrada), CORTE)[0]!.swimmers[0]!.pruebas.map((l) => `${l.number}:${l.text}`);
    // Todas las permutaciones de 6 elementos son 720: se recorren todas; el séptimo queda fijo al final.
    for (const orden of permutaciones(base.slice(0, 6))) {
      const planas = ordenPlano([...orden, base[6]!]).map((x) => `${x.numero}:${textoVisible(x)}`);
      expect(planas).toEqual(vista);
    }
  });

  it("el identificador solo desempata filas idénticas a la vista, y el resultado no depende del orden de entrada", () => {
    const iguales = [
      { id: "z-2", numero: 4, etiqueta: "50m Libre", tiempo: "30,00" },
      { id: "a-1", numero: 4, etiqueta: "50m Libre", tiempo: "30,00" },
    ];
    for (const orden of permutaciones(iguales)) expect(ordenPlano(orden).map((x) => x.id)).toEqual(["a-1", "z-2"]);
  });

  it("filas planas de individuales: nadadores por apellido paterno y las filas de cada uno juntas", () => {
    const f = (apellido: string, personId: string, id: string, numero: number) => ({
      clubName: "Delfines",
      persona: { fullName: `N ${apellido}`, run: personId, personId, paternalLastName: apellido },
      linea: lineaDePrueba(numero, "50m Libre", null),
      id,
    });
    const filas = [f("Zamora", "p1", "id-a", 1), f("Araya", "p2", "id-b", 9), f("Zamora", "p1", "id-c", 3), f("Araya", "p2", "id-d", 2)];
    const orden = filas
      .slice()
      .sort(compararFilasIndividuales)
      .map((x) => `${x.persona.paternalLastName}:${x.linea.number}`);
    expect(orden).toEqual(["Araya:2", "Araya:9", "Zamora:1", "Zamora:3"]);
  });

  it("relevos: una fila por equipo; mismo criterio visible (número, texto), luego categoría e id; coincide con la vista agrupada", () => {
    const r = (id: string, numero: number | null, etiqueta: string, tiempo: string | null, categoryName: string) => ({
      clubName: "Delfines",
      linea: lineaDePrueba(numero, etiqueta, tiempo),
      categoryName,
      id,
      etiqueta,
      tiempo,
    });
    const filas = [
      r("id-1", 5, "Relevo 4x50m Libre (Mixto)", "2:10,00", "Cat B"),
      r("id-2", null, "Relevo 4x50m Libre (Damas)", null, "Cat A"),
      r("id-3", 5, "Relevo 4x50m Libre (Mixto)", "2:05,00", "Cat C"),
      r("id-4", 2, "Relevo 4x50m Combinado (Varones)", null, "Cat A"),
      r("id-5", 5, "Relevo 4x50m Libre (Mixto)", "2:05,00", "Cat A"),
    ];
    const ordenar = (xs: typeof filas) => xs.slice().sort(compararFilasDeRelevo).map((x) => x.id);
    const esperado = ["id-4", "id-5", "id-3", "id-1", "id-2"]; // 2 · 5 (2:05,00: Cat A antes que Cat C) · 5 (2:10,00) · ausente
    expect(ordenar(filas)).toEqual(esperado);
    for (const p of permutaciones(filas)) expect(ordenar(p)).toEqual(esperado);

    // Misma secuencia de textos que la lista de relevos de un nadador en la vista agrupada.
    const vista = groupReportByClubAndSwimmer(
      filas.map((x) => entry({ kind: "relay", eventNumber: x.linea.number, eventLabel: x.etiqueta, timeLabel: x.tiempo, categoryName: x.categoryName })),
      CORTE
    )[0]!.swimmers[0]!.relevos.map((l) => l.text);
    expect(vista).toEqual(esperado.map((id) => filas.find((x) => x.id === id)!.linea.text));
  });
});

describe("totales y contenido se conservan", () => {
  it("mismos totales y mismas líneas que antes del reordenamiento", () => {
    const g = groupReportByClubAndSwimmer(
      [
        entry({ personId: "1", run: "1", fullName: "B", paternalLastName: "B", eventNumber: 10, eventLabel: "I10" }),
        entry({ personId: "1", run: "1", fullName: "B", paternalLastName: "B", eventNumber: 2, eventLabel: "I2" }),
        entry({ personId: "2", run: "2", fullName: "A", paternalLastName: "A", eventNumber: 1, eventLabel: "I1" }),
        entry({ personId: "1", run: "1", fullName: "B", paternalLastName: "B", eventNumber: 30, eventLabel: "R", kind: "relay" }),
      ],
      CORTE,
      new Map([["Delfines", 1]])
    )[0]!;
    expect(g.totalNadadores).toBe(2);
    expect(g.totalPruebasIndividuales).toBe(3);
    expect(g.totalRelevos).toBe(1);
    expect(g.swimmers.map((s) => s.run)).toEqual(["2", "1"]);
    expect(g.swimmers[1]!.pruebas.map((l) => l.text)).toEqual(["I2", "I10"]);
  });
});
