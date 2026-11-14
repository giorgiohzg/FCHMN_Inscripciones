/**
 * VISTA AGRUPADA de «Generar reporte»: campos de PRESENTACIÓN del nombre.
 *
 * La vista agrupada entrega, además de `nombreCompleto`, los componentes del nombre tal como están
 * guardados (`apellidoPaterno`, `apellidoMaterno`, `nombres`) para que la pantalla presente
 * `PATERNO MATERNO, NOMBRE`. Esto comprueba que:
 *  - llegan tal cual, con `null` si faltan, y `nombreCompleto` no cambia;
 *  - el ORDEN sigue siendo el de `compararNadadores` (paterno, materno, nombre; históricos al final;
 *    homónimos desempatados de forma estable), sin un segundo criterio;
 *  - quien está inscrito solo en relevos también los recibe;
 *  - no aparece el RUN ni la fecha de nacimiento.
 * Funciones puras, datos sintéticos.
 */
import { describe, it, expect } from "vitest";
import { groupReportByClubAndSwimmer, type SwimmerEventEntry } from "../src/modules/reports/reports.rules";

const corte = new Date("2026-12-31T00:00:00Z");

function entrada(o: Partial<SwimmerEventEntry> & { personId: string }): SwimmerEventEntry {
  return {
    run: `run-${o.personId}`,
    fullName: "Sin Nombre",
    clubName: "Club Sintético",
    birthDate: new Date("1972-05-10T00:00:00Z"),
    gender: "male",
    categoryName: "Master G",
    eventNumber: 1,
    eventLabel: "50m Libre",
    timeLabel: null,
    kind: "individual",
    ...o,
  };
}

const nadadores = (entradas: SwimmerEventEntry[]) => groupReportByClubAndSwimmer(entradas, corte).flatMap((g) => g.swimmers);

describe("campos de presentación del nombre", () => {
  it("llegan tal como están guardados, y nombreCompleto no cambia", () => {
    const [s] = nadadores([
      entrada({ personId: "p1", fullName: "Ana María Ejemplo Prueba", firstName: "Ana María", paternalLastName: "Ejemplo", maternalLastName: "Prueba" }),
    ]);
    expect(s).toMatchObject({ nombreCompleto: "Ana María Ejemplo Prueba", apellidoPaterno: "Ejemplo", apellidoMaterno: "Prueba", nombres: "Ana María" });
    expect(s).not.toHaveProperty("run");
    expect(s).not.toHaveProperty("fechaNacimiento");
    expect(s).not.toHaveProperty("birthDate");
  });

  it("los que faltan llegan como null (registro histórico), sin deducirlos de fullName", () => {
    const [s] = nadadores([entrada({ personId: "p1", fullName: "Persona Histórica Sintética" })]);
    expect(s).toMatchObject({ nombreCompleto: "Persona Histórica Sintética", apellidoPaterno: null, apellidoMaterno: null, nombres: null });
  });

  it("quien está inscrito solo en relevos también los recibe", () => {
    const [s] = nadadores([
      entrada({ personId: "r1", kind: "relay", eventLabel: "Relevo 4x50m Libre (Varones)", fullName: "Beto Relevo Solo", firstName: "Beto", paternalLastName: "Relevo", maternalLastName: "Solo" }),
    ]);
    expect(s).toMatchObject({ apellidoPaterno: "Relevo", apellidoMaterno: "Solo", nombres: "Beto", pruebas: [] });
    expect(s!.relevos).toHaveLength(1);
  });
});

describe("el orden sigue siendo el de compararNadadores", () => {
  it("paterno, materno y nombre, con apellidos compuestos, sin importar el orden de entrada", () => {
    const entradas = [
      entrada({ personId: "a", fullName: "Carla de la Fuente Rojo", firstName: "Carla", paternalLastName: "de la Fuente", maternalLastName: "Rojo" }),
      entrada({ personId: "b", fullName: "Bruno Del Campo Azul", firstName: "Bruno", paternalLastName: "Del Campo", maternalLastName: "Azul" }),
      entrada({ personId: "c", fullName: "Alba Del Campo", firstName: "Alba", paternalLastName: "Del Campo", maternalLastName: null }),
      entrada({ personId: "d", fullName: "Abel Del Campo Azul", firstName: "Abel", paternalLastName: "Del Campo", maternalLastName: "Azul" }),
    ];
    // «de la Fuente» antes que «Del Campo» (el espacio va antes que la «l»); dentro de Del Campo,
    // Azul (Abel, Bruno) y luego el que no tiene materno, que va después de los que lo tienen.
    const esperado = ["a", "d", "b", "c"];
    expect(nadadores(entradas).map((s) => s.personId)).toEqual(esperado);
    expect(nadadores(entradas.slice().reverse()).map((s) => s.personId)).toEqual(esperado);
  });

  it("homónimos: dos personas con el mismo nombre quedan en un orden estable, cada una con su identificador", () => {
    const homonimo = { fullName: "Dana Igual Igual", firstName: "Dana", paternalLastName: "Igual", maternalLastName: "Igual" };
    const entradas = [entrada({ personId: "h2", run: "run-2", ...homonimo }), entrada({ personId: "h1", run: "run-1", ...homonimo })];
    expect(nadadores(entradas).map((s) => s.personId)).toEqual(["h1", "h2"]);
    expect(nadadores(entradas.slice().reverse()).map((s) => s.personId)).toEqual(["h1", "h2"]);
  });

  it("los históricos sin apellido paterno van después, por su nombre almacenado", () => {
    const entradas = [
      entrada({ personId: "x", fullName: "Zeta Histórica" }),
      entrada({ personId: "y", fullName: "Alfa Histórica" }),
      entrada({ personId: "z", fullName: "Zoe Completa Sintética", firstName: "Zoe", paternalLastName: "Completa", maternalLastName: "Sintética" }),
    ];
    expect(nadadores(entradas).map((s) => s.personId)).toEqual(["z", "y", "x"]);
  });
});

describe("lo demás de la vista agrupada no cambia", () => {
  it("edad, categoría, género, listas y totales", () => {
    const grupos = groupReportByClubAndSwimmer(
      [
        entrada({ personId: "p1", fullName: "Eva Total Uno", firstName: "Eva", paternalLastName: "Total", maternalLastName: "Uno", gender: "female", eventNumber: 4 }),
        entrada({ personId: "p1", fullName: "Eva Total Uno", firstName: "Eva", paternalLastName: "Total", maternalLastName: "Uno", gender: "female", kind: "relay", eventNumber: 9, eventLabel: "Relevo 4x50m Libre (Damas)" }),
      ],
      corte,
      new Map([["Club Sintético", 1]])
    );
    expect(grupos).toHaveLength(1);
    expect(grupos[0]).toMatchObject({ clubName: "Club Sintético", totalNadadores: 1, totalPruebasIndividuales: 1, totalRelevos: 1 });
    expect(grupos[0]!.swimmers[0]).toMatchObject({
      edad: 54,
      categoria: "Master G",
      genero: "Damas",
      pruebas: [{ number: 4, text: "50m Libre" }],
      relevos: [{ number: 9, text: "Relevo 4x50m Libre (Damas)" }],
    });
  });
});
