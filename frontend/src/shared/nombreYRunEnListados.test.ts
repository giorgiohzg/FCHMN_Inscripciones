/**
 * Presentación estandarizada de nombre y RUN en los listados de Personas y del plantel.
 * Datos SINTÉTICOS.
 */
import { describe, it, expect } from "vitest";
import { nombreApellidosPrimero, nombreEnPanel } from "./nombreDeNadador";
import { formatRunConGuion } from "../modules/persons/runValidator";

describe("nombreApellidosPrimero", () => {
  it("PATERNO MATERNO, NOMBRES con tildes y Ñ en mayúsculas", () => {
    expect(nombreApellidosPrimero({ fullName: "x", firstName: "Iñaki José", paternalLastName: "Núñez", maternalLastName: "Peña" })).toBe(
      "NÚÑEZ PEÑA, IÑAKI JOSÉ"
    );
  });

  it("apellidos y nombres compuestos se conservan tal cual, sin partirlos", () => {
    expect(
      nombreApellidosPrimero({
        fullName: "x",
        firstName: "María de los Ángeles",
        paternalLastName: "de la Fuente",
        maternalLastName: "San Martín",
      })
    ).toBe("DE LA FUENTE SAN MARTÍN, MARÍA DE LOS ÁNGELES");
  });

  it("sin segundo apellido: PATERNO, NOMBRES, sin espacios ni comas sobrantes", () => {
    expect(nombreApellidosPrimero({ fullName: "x", firstName: "Ana", paternalLastName: "Rojas", maternalLastName: null })).toBe(
      "ROJAS, ANA"
    );
    expect(nombreApellidosPrimero({ fullName: "x", firstName: "Ana", paternalLastName: "Rojas", maternalLastName: "   " })).toBe(
      "ROJAS, ANA"
    );
  });

  it("espacios repetidos dentro de un componente se reducen a uno", () => {
    expect(
      nombreApellidosPrimero({ fullName: "x", firstName: "Ana   María", paternalLastName: " Rojas ", maternalLastName: "Soto  Paz" })
    ).toBe("ROJAS SOTO PAZ, ANA MARÍA");
  });

  it("registros antiguos incompletos: el nombre completo almacenado, sin coma ni apellidos inventados", () => {
    expect(
      nombreApellidosPrimero({ fullName: "  Pedro   Pablo Ruiz ", firstName: null, paternalLastName: null, maternalLastName: null })
    ).toBe("PEDRO PABLO RUIZ");
    // Con apellido pero sin nombre de pila tampoco se reordena: no se sabe qué parte es el nombre.
    expect(nombreApellidosPrimero({ fullName: "Pedro Ruiz", firstName: null, paternalLastName: "Ruiz", maternalLastName: null })).toBe(
      "PEDRO RUIZ"
    );
  });

  it("no cambia la presentación de los paneles (`nombreEnPanel`)", () => {
    expect(nombreEnPanel({ fullName: "x", firstName: "Ana   María", paternalLastName: "Rojas" })).toBe("ROJAS, ANA   MARÍA");
  });
});

describe("formatRunConGuion", () => {
  it("sin puntos, con guion antes del dígito verificador", () => {
    expect(formatRunConGuion("13.579.246-2")).toBe("13579246-2");
    expect(formatRunConGuion("135792462")).toBe("13579246-2");
  });

  it("no duplica el guion si ya viene formateado", () => {
    expect(formatRunConGuion("13579246-2")).toBe("13579246-2");
  });

  it("dígito K en mayúscula", () => {
    expect(formatRunConGuion("10.000.013-k")).toBe("10000013-K");
    expect(formatRunConGuion("10000013k")).toBe("10000013-K");
  });

  it("conserva los ceros iniciales: no lo convierte a número", () => {
    expect(formatRunConGuion("01234567-8")).toBe("01234567-8");
  });

  it("sin RUN no inventa uno; lo que no tiene forma de RUN se devuelve normalizado, sin guion", () => {
    expect(formatRunConGuion("")).toBe("");
    expect(formatRunConGuion(null)).toBe("");
    expect(formatRunConGuion("R1")).toBe("R1");
  });
});
