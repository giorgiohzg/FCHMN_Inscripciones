/**
 * Presentación y orden de nadadores en los paneles (`nombreDeNadador.ts`). Datos sintéticos.
 */
import { describe, it, expect } from "vitest";
import { compararNadadores, coincideConBusqueda, nombreConEdad, nombreEnPanel, tieneNombreSeparado } from "./nombreDeNadador";

const p = (id: string, first: string | null, pat: string | null, mat: string | null, full: string) => ({
  id,
  firstName: first,
  paternalLastName: pat,
  maternalLastName: mat,
  fullName: full,
  run: `${id}-1`,
});

describe("presentación", () => {
  it("PATERNO MATERNO, NOMBRE (EDAD) con los campos separados, en mayúsculas solo al presentar", () => {
    const persona = p("a", "Sofía Andrea", "Núñez", "Ávila", "Sofía Andrea Núñez Ávila");
    expect(nombreConEdad(persona, 54)).toBe("NÚÑEZ ÁVILA, SOFÍA ANDREA (54)");
    // Los datos no cambian.
    expect(persona.firstName).toBe("Sofía Andrea");
  });

  it("sin apellido materno: PATERNO, NOMBRE", () => {
    expect(nombreEnPanel(p("a", "Bruno", "Sintético", null, "Bruno Sintético"))).toBe("SINTÉTICO, BRUNO");
    expect(nombreEnPanel(p("a", "Bruno", "Sintético", "   ", "Bruno Sintético"))).toBe("SINTÉTICO, BRUNO");
  });

  it("apellidos compuestos se toman de los campos, nunca partiendo fullName", () => {
    expect(nombreEnPanel(p("a", "Ana", "De La Prueba", "Del Río", "Ana De La Prueba Del Río"))).toBe("DE LA PRUEBA DEL RÍO, ANA");
  });

  it("registro histórico incompleto: fullName en mayúsculas, sin coma ni apellidos inventados", () => {
    const sinNada = p("h1", null, null, null, "Registro Histórico Sintético");
    const sinPaterno = p("h2", "Solo", null, "Materno", "Solo Nombre Antiguo");
    const sinNombre = p("h3", null, "Paterno", null, "Otro Registro Antiguo");
    for (const x of [sinNada, sinPaterno, sinNombre]) expect(tieneNombreSeparado(x)).toBe(false);
    expect(nombreConEdad(sinNada, 37)).toBe("REGISTRO HISTÓRICO SINTÉTICO (37)");
    expect(nombreEnPanel(sinPaterno)).toBe("SOLO NOMBRE ANTIGUO");
    expect(nombreEnPanel(sinNombre)).toBe("OTRO REGISTRO ANTIGUO");
    expect(nombreEnPanel(sinNada)).not.toContain(",");
  });

  it("sin edad conocida no muestra paréntesis ni calcula otra", () => {
    const persona = p("a", "Ana", "Zeta", null, "Ana Zeta");
    expect(nombreConEdad(persona, undefined)).toBe("ZETA, ANA");
    expect(nombreConEdad(persona, null)).toBe("ZETA, ANA");
    expect(nombreConEdad(persona, 0)).toBe("ZETA, ANA (0)");
  });
});

describe("orden", () => {
  it("apellido paterno, luego materno (sin materno primero), luego nombre; incompletos al final; id desempata", () => {
    const lista = [
      p("6", null, null, null, "Aaa Histórico"),
      p("1", "Zoe", "Bravo", "Castro", "Zoe Bravo Castro"),
      p("2", "Ana", "Bravo", "Castro", "Ana Bravo Castro"),
      p("3", "Ana", "Bravo", null, "Ana Bravo"),
      p("4", "Ana", "Álvarez", "Zúñiga", "Ana Álvarez Zúñiga"),
      p("5", "Ana", "bravo", "castro", "Ana bravo castro"),
      p("7", "Solo", null, null, "Bbb Histórico"),
    ];
    const ordenada = lista.slice().sort(compararNadadores((x) => x.id)).map((x) => x.id);
    // «Álvarez» va antes que «Bravo» (sin distinguir tildes); 2 y 5 empatan sin distinguir
    // mayúsculas y desempata el id.
    expect(ordenada).toEqual(["4", "3", "2", "5", "1", "6", "7"]);
  });

  it("es estable entre ejecuciones con homónimos (el id desempata)", () => {
    const a = p("b", "Ana", "Zeta", null, "Ana Zeta");
    const b = p("a", "Ana", "Zeta", null, "Ana Zeta");
    expect([a, b].sort(compararNadadores((x) => x.id)).map((x) => x.id)).toEqual(["a", "b"]);
    expect([b, a].sort(compararNadadores((x) => x.id)).map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("búsqueda", () => {
  it("encuentra por fullName, por el nombre presentado y por RUN, sin distinguir mayúsculas", () => {
    const persona = p("a", "Valentina", "Sintética", "Ejemplo", "Valentina Sintética Ejemplo");
    expect(coincideConBusqueda(persona, "valentina")).toBe(true);
    expect(coincideConBusqueda(persona, "SINTÉTICA EJEMPLO, VAL")).toBe(true);
    expect(coincideConBusqueda(persona, "a-1")).toBe(true);
    expect(coincideConBusqueda(persona, "   ")).toBe(true);
    expect(coincideConBusqueda(persona, "otra")).toBe(false);
  });
});
