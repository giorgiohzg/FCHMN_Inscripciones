import { describe, it, expect } from "vitest";
import { mapRowToPersonInput, PERSONS_IMPORT_HEADERS } from "../src/modules/persons/persons-bulk-import.rules";

// Columnas: RUN, Usuario, Nombre, Apellido paterno, Apellido materno,
// Fecha nacimiento, Género, Correo, Teléfono. **Sin columna de roles**: los
// `person_roles` se derivan de la membresía y del nombramiento en el club, no
// se cargan por archivo.
function validRow(overrides: Partial<Record<number, unknown>> = {}): unknown[] {
  const base = ["12345678-5", "jperez", "Juan", "Pérez", "González", "15-03-1990", "Masculino", "jperez@test.cl", "912345678"];
  Object.entries(overrides).forEach(([i, v]) => (base[Number(i)] = v as string));
  return base;
}

describe("persons-bulk-import.rules — mapRowToPersonInput", () => {
  it("mapea correctamente una fila válida completa", () => {
    const result = mapRowToPersonInput(validRow());
    expect(result.ok).toBe(true);
    expect(result.data?.username).toBe("jperez");
    expect(result.data?.firstName).toBe("Juan");
    expect(result.data?.paternalLastName).toBe("Pérez");
    expect(result.data?.maternalLastName).toBe("González");
    expect(result.data?.gender).toBe("male");
    expect(result.data, "la fila mapeada no lleva roles").not.toHaveProperty("roles");
  });

  it("acepta el apellido materno vacío (es opcional)", () => {
    const result = mapRowToPersonInput(validRow({ 4: "" }));
    expect(result.ok).toBe(true);
    expect(result.data?.maternalLastName).toBeUndefined();
  });

  it("acepta el teléfono vacío (es opcional)", () => {
    const result = mapRowToPersonInput(validRow({ 8: "" }));
    expect(result.ok).toBe(true);
    expect(result.data?.phone).toBeUndefined();
  });

  it("acepta el correo electrónico vacío (es opcional)", () => {
    const result = mapRowToPersonInput(validRow({ 7: "" }));
    expect(result.ok).toBe(true);
    expect(result.data?.email).toBeUndefined();
  });

  /**
   * La plantilla antigua traía una columna J de roles. Ignorarla en silencio
   * sería peor que rechazarla: quien la reutilizara creería haber cargado
   * delegados y se encontraría con personas sin ningún rol.
   */
  it("RECHAZA una fila que todavía trae la columna de roles, explicando por qué", () => {
    const result = mapRowToPersonInput(validRow({ 9: "Nadador, Delegado" }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Columna J en desuso"))).toBe(true);
    expect(result.errors.some((e) => e.includes("plantel")), "dice dónde se obtiene el rol").toBe(true);
  });

  it("interpreta 'Femenino' y 'Masculino' correctamente", () => {
    expect(mapRowToPersonInput(validRow({ 6: "Femenino" })).data?.gender).toBe("female");
    expect(mapRowToPersonInput(validRow({ 6: "Masculino" })).data?.gender).toBe("male");
  });

  it("rechaza una fecha de nacimiento con formato inválido", () => {
    const result = mapRowToPersonInput(validRow({ 5: "1990/03/15" }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Fecha de nacimiento"))).toBe(true);
  });

  it("rechaza una fecha de nacimiento inexistente (31 de febrero)", () => {
    const result = mapRowToPersonInput(validRow({ 5: "31-02-2000" }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Fecha de nacimiento"))).toBe(true);
  });

  it("rechaza un género no reconocido", () => {
    const result = mapRowToPersonInput(validRow({ 6: "Otro" }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Género"))).toBe(true);
  });

  it("una fila SIN columna de roles es la normal y se acepta", () => {
    const result = mapRowToPersonInput(validRow({ 9: "" }));
    expect(result.ok).toBe(true);
  });

  it("rechaza una fila sin nombre", () => {
    const result = mapRowToPersonInput(validRow({ 2: "" }));
    expect(result.ok).toBe(false);
  });

  it("rechaza una fila sin apellido paterno", () => {
    const result = mapRowToPersonInput(validRow({ 3: "" }));
    expect(result.ok).toBe(false);
  });

  it("rechaza un RUN inválido (delega en la validación estándar del sistema)", () => {
    const result = mapRowToPersonInput(validRow({ 0: "12345678-9" })); // dígito verificador incorrecto (correcto es -5)
    expect(result.ok).toBe(false);
  });

  it("rechaza un correo electrónico con formato inválido", () => {
    const result = mapRowToPersonInput(validRow({ 7: "no-es-correo" }));
    expect(result.ok).toBe(false);
  });

  it("acumula varios errores de la misma fila a la vez", () => {
    const result = mapRowToPersonInput(validRow({ 5: "fecha-mala", 6: "Otro", 9: "RolInventado" }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("interpreta correctamente una celda de fecha nativa de Excel (objeto Date)", () => {
    const result = mapRowToPersonInput(validRow({ 5: new Date(Date.UTC(1990, 2, 15)) }));
    expect(result.ok).toBe(true);
  });

  it("expone exactamente 9 columnas en el encabezado de la plantilla", () => {
    expect(PERSONS_IMPORT_HEADERS).toHaveLength(9);
  });
});
