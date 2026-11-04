import { describe, it, expect } from "vitest";
import {
  mapRowToPersonInput,
  PERSONS_IMPORT_HEADERS,
  evaluarEncabezado,
  parseFechaEfectiva,
  resolverSigla,
  detectarDuplicadosInternos,
  normalizarSigla,
  type ClubParaSigla,
} from "../src/modules/persons/persons-bulk-import.rules";

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
   * La columna J ya no es «Roles»: es la SIGLA del club. Un valor allí se trata
   * como sigla (y la plantilla antigua con «Roles» se rechaza entera por el
   * encabezado, ver `evaluarEncabezado`): nunca se lee como rol.
   */
  it("la columna J es la sigla del club y exige la fecha efectiva de la K", () => {
    const sinFecha = mapRowToPersonInput(validRow({ 9: "Nadador, Delegado" }));
    expect(sinFecha.ok).toBe(false);
    expect(sinFecha.errors.join(" ")).toMatch(/Falta la fecha efectiva de membresía/);
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

  it("una fila SIN club es la normal y se acepta (solo la persona)", () => {
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
    const result = mapRowToPersonInput(validRow({ 5: "fecha-mala", 6: "Otro", 9: "SIGLA" }));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("interpreta correctamente una celda de fecha nativa de Excel (objeto Date)", () => {
    const result = mapRowToPersonInput(validRow({ 5: new Date(Date.UTC(1990, 2, 15)) }));
    expect(result.ok).toBe(true);
  });

  it("expone exactamente 11 columnas (A-K): las 9 de la persona más sigla y fecha efectiva", () => {
    expect(PERSONS_IMPORT_HEADERS).toHaveLength(11);
    expect(PERSONS_IMPORT_HEADERS[9]).toMatch(/Sigla del club/);
    expect(PERSONS_IMPORT_HEADERS[10]).toMatch(/Fecha efectiva de membresía/);
  });
});

describe("club y fecha efectiva por fila", () => {
  it("con sigla y fecha: la sigla se normaliza (trim + mayúsculas) y la fecha queda AAAA-MM-DD", () => {
    const r = mapRowToPersonInput(validRow({ 9: "  cnv ", 10: "2026-03-01" }));
    expect(r.ok).toBe(true);
    expect(r.sigla).toBe("CNV");
    expect(r.fechaEfectiva).toBe("2026-03-01");
  });

  it("acepta DD-MM-AAAA, DD/MM/AAAA y una celda de fecha nativa de Excel, sin correr el día", () => {
    expect(mapRowToPersonInput(validRow({ 9: "CNV", 10: "01-03-2026" })).fechaEfectiva).toBe("2026-03-01");
    expect(mapRowToPersonInput(validRow({ 9: "CNV", 10: "1/3/2026" })).fechaEfectiva).toBe("2026-03-01");
    expect(mapRowToPersonInput(validRow({ 9: "CNV", 10: new Date(Date.UTC(2026, 9, 31)) })).fechaEfectiva).toBe("2026-10-31");
  });

  it("sin club, la fila no trae ni sigla ni fecha", () => {
    const r = mapRowToPersonInput(validRow());
    expect(r).toMatchObject({ ok: true, sigla: null, fechaEfectiva: null });
  });

  it("con club y SIN fecha: error claro; nunca se usa la fecha de hoy", () => {
    const r = mapRowToPersonInput(validRow({ 9: "CNV" }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/obligatoria cuando la fila trae club.*no usa la fecha de hoy/);
  });

  it("fechas inválidas o inexistentes se rechazan", () => {
    for (const mala of ["2026-02-30", "31-02-2026", "2026/03/01", "mañana", "2026-13-01", "01-03-26"]) {
      const r = mapRowToPersonInput(validRow({ 9: "CNV", 10: mala }));
      expect(r.ok, mala).toBe(false);
      expect(r.errors.join(" "), mala).toMatch(/Fecha efectiva de membresía inválida/);
    }
  });

  it("fecha SIN club: inconsistencia informada, no descartada", () => {
    const r = mapRowToPersonInput(validRow({ 10: "2026-03-01" }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/trae fecha efectiva de membresía .* pero no trae sigla de club/);
  });

  it("en un archivo SIN encabezados de J y K, datos en esas columnas rechazan la fila", () => {
    const r = mapRowToPersonInput(validRow({ 9: "CNV", 10: "2026-03-01" }), { conColumnasDeClub: false });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/no tiene esos encabezados/);
    expect(mapRowToPersonInput(validRow(), { conColumnasDeClub: false }).ok).toBe(true);
  });

  it("una columna L con datos se rechaza", () => {
    const r = mapRowToPersonInput(validRow({ 11: "algo" }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/columna L no forma parte/);
  });

  it("parseFechaEfectiva: solo días de calendario existentes", () => {
    expect(parseFechaEfectiva("2024-02-29")).toBe("2024-02-29");
    expect(parseFechaEfectiva("2025-02-29")).toBeNull();
    expect(parseFechaEfectiva("2026-3-1")).toBe("2026-03-01");
    expect(parseFechaEfectiva("2026-03-01T10:00")).toBeNull();
  });
});

describe("evaluarEncabezado — qué plantilla es", () => {
  const base = PERSONS_IMPORT_HEADERS.slice(0, 9);

  it("actual (J y K con sus títulos) y anterior (J y K vacías) se aceptan", () => {
    expect(evaluarEncabezado([...PERSONS_IMPORT_HEADERS])).toEqual({ ok: true, conColumnasDeClub: true });
    expect(evaluarEncabezado([...base])).toEqual({ ok: true, conColumnasDeClub: false });
    // Sin distinguir mayúsculas ni espacios de más.
    expect(evaluarEncabezado([...base, "  SIGLA DEL CLUB (OPCIONAL) ", PERSONS_IMPORT_HEADERS[10]!.toUpperCase()]).ok).toBe(true);
  });

  it("una J titulada «Roles» rechaza el ARCHIVO entero: nunca se reinterpreta como club", () => {
    const r = evaluarEncabezado([...base, "Roles"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/plantilla antigua/);
      expect(r.error).toMatch(/NO se interpreta como club/);
      expect(r.error).toMatch(/No se importó ninguna fila/);
    }
  });

  it("cualquier otro título en J o K también rechaza el archivo", () => {
    expect(evaluarEncabezado([...base, "Club"]).ok).toBe(false);
    expect(evaluarEncabezado([...base, PERSONS_IMPORT_HEADERS[9]!]).ok, "J sin K").toBe(false);
  });
});

describe("resolverSigla — solo clubes vigentes y activos, nunca una coincidencia ambigua", () => {
  const club = (id: string, code: string, extra: Partial<ClubParaSigla> = {}): ClubParaSigla => ({
    id,
    name: `Club ${id}`,
    code,
    status: "active",
    deletedAt: null,
    ...extra,
  });

  it("resuelve una sigla única, sin distinguir mayúsculas ni espacios", () => {
    const r = resolverSigla("cnv", [club("a", " CNV "), club("b", "OTRO")]);
    expect(r).toEqual({ ok: true, club: club("a", " CNV ") });
    expect(normalizarSigla(" cnv ")).toBe("CNV");
  });

  it("inexistente", () => {
    const r = resolverSigla("XYZ", [club("a", "CNV")]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/No existe ningún club con la sigla «XYZ»/);
  });

  it("inactivo", () => {
    const r = resolverSigla("CNV", [club("a", "CNV", { status: "inactive" })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no está activo/);
  });

  it("eliminado (y no hay otro vigente con esa sigla)", () => {
    const r = resolverSigla("CNV", [club("a", "CNV", { deletedAt: new Date() })]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/club eliminado/);
  });

  it("un eliminado con la misma sigla que uno vigente NO la vuelve ambigua", () => {
    const r = resolverSigla("CNV", [club("a", "CNV", { deletedAt: new Date() }), club("b", "CNV")]);
    expect(r.ok && r.club.id).toBe("b");
  });

  it("AMBIGUA: dos vigentes (aunque uno esté inactivo o difiera en mayúsculas/espacios) → error con los nombres", () => {
    for (const otro of [club("b", "CNV"), club("b", "cnv "), club("b", "CNV", { status: "inactive" })]) {
      const r = resolverSigla("CNV", [club("a", "CNV"), otro]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toMatch(/ambigua/);
        expect(r.error).toContain("«Club a»");
        expect(r.error).toContain("«Club b»");
      }
    }
  });
});

describe("detectarDuplicadosInternos — RUN y usuario informado dentro del archivo", () => {
  it("el RUN se compara normalizado; se procesa la primera aparición y se señala su fila", () => {
    const d = detectarDuplicadosInternos([
      { row: 2, run: "12.345.678-5", username: "" },
      { row: 3, run: "123456785", username: "" },
      { row: 4, run: "11.111.111-1", username: "" },
    ]);
    expect([...d.keys()]).toEqual([3]);
    expect(d.get(3)![0]).toMatch(/RUN repetido dentro del archivo: ya aparece en la fila 2/);
  });

  it("el usuario informado repetido se señala; los usuarios AUSENTES no son duplicados", () => {
    const d = detectarDuplicadosInternos([
      { row: 2, run: "1-9", username: "ana" },
      { row: 3, run: "2-7", username: "" },
      { row: 4, run: "3-5", username: " " },
      { row: 5, run: "4-3", username: "ana" },
    ]);
    expect([...d.keys()]).toEqual([5]);
    expect(d.get(5)![0]).toMatch(/Nombre de usuario "ana" repetido.*fila 2/);
  });

  it("una fila con RUN y usuario repetidos acumula los dos mensajes", () => {
    const d = detectarDuplicadosInternos([
      { row: 2, run: "1-9", username: "ana" },
      { row: 3, run: "1-9", username: "ana" },
    ]);
    expect(d.get(3)).toHaveLength(2);
  });
});
