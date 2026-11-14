/**
 * Formato de la línea de cada nadador en «Generar reporte»:
 * `PATERNO MATERNO, NOMBRE (EDAD) - Categoría - Género`. Datos sintéticos.
 */
import { describe, it, expect } from "vitest";
import { lineaDelReporte, partesDeLineaDelReporte } from "./presentacionReporte";
import type { ClubGroupSwimmerRow } from "./reportsApi";

const fila = (o: Partial<ClubGroupSwimmerRow>): ClubGroupSwimmerRow => ({
  personId: "p1",
  nombreCompleto: "Ana María Ejemplo Prueba",
  apellidoPaterno: "Ejemplo",
  apellidoMaterno: "Prueba",
  nombres: "Ana María",
  edad: 54,
  categoria: "Master G",
  genero: "Damas",
  pruebas: [],
  relevos: [],
  ...o,
});

describe("lineaDelReporte", () => {
  it("formato exacto: mayúsculas, edad entre paréntesis sin «años», categoría y género con guiones", () => {
    expect(lineaDelReporte(fila({}))).toBe("EJEMPLO PRUEBA, ANA MARÍA (54) - Master G - Damas");
  });

  it("separa el nombre (en negrita en pantalla) del resto", () => {
    expect(partesDeLineaDelReporte(fila({}))).toEqual({ nombre: "EJEMPLO PRUEBA, ANA MARÍA", detalle: " (54) - Master G - Damas" });
  });

  it("apellidos compuestos y tildes, con los campos separados tal cual", () => {
    expect(lineaDelReporte(fila({ apellidoPaterno: "de la Fuente", apellidoMaterno: "Núñez del Río", nombres: "José Ñandú", genero: "Varones" }))).toBe(
      "DE LA FUENTE NÚÑEZ DEL RÍO, JOSÉ ÑANDÚ (54) - Master G - Varones"
    );
  });

  it("sin apellido materno: `PATERNO, NOMBRE`", () => {
    expect(lineaDelReporte(fila({ apellidoMaterno: null }))).toBe("EJEMPLO, ANA MARÍA (54) - Master G - Damas");
  });

  it("registro histórico sin apellido paterno: el nombre almacenado en mayúsculas, sin coma", () => {
    expect(lineaDelReporte(fila({ nombreCompleto: "Persona Histórica Sintética", apellidoPaterno: null, apellidoMaterno: null, nombres: null }))).toBe(
      "PERSONA HISTÓRICA SINTÉTICA (54) - Master G - Damas"
    );
  });

  it("registro sin nombre de pila: tampoco se arma la coma", () => {
    expect(lineaDelReporte(fila({ nombreCompleto: "Ejemplo Prueba", nombres: null }))).toBe("EJEMPLO PRUEBA (54) - Master G - Damas");
  });

  it("API anterior, sin los campos separados: el nombre almacenado en mayúsculas", () => {
    const { apellidoPaterno: _p, apellidoMaterno: _m, nombres: _n, ...anterior } = fila({});
    expect(lineaDelReporte(anterior)).toBe("ANA MARÍA EJEMPLO PRUEBA (54) - Master G - Damas");
  });
});
