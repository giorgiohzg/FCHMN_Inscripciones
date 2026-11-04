/**
 * Etapa 9 — el nombre de usuario es OPCIONAL en los contratos de la API.
 *
 * Pruebas puras de los esquemas (sin base de datos). Lo que fijan:
 *   - la ausencia es `null`, nunca una cadena vacía;
 *   - en el alta, omitirlo equivale a «sin nombre»; en la edición, a «no tocar»;
 *   - un nombre informado se recorta y debe cumplir el formato de siempre;
 *   - el cuerpo de «Crear credenciales» es opcional entero.
 */
import { describe, it, expect } from "vitest";
import { usernameOpcionalField } from "../src/shared/username.schema";
import { personCreateSchema, personUpdateSchema, createCredentialsSchema } from "../src/modules/persons/persons.schemas";
import { clubCreateSchema, clubUpdateSchema } from "../src/modules/clubs/clubs.schemas";
import { mapRowToPersonInput } from "../src/modules/persons/persons-bulk-import.rules";

const PERSONA = {
  run: "12345678-5",
  firstName: "Ana",
  paternalLastName: "Prueba",
  birthDate: "1990-01-01",
  gender: "female",
};

const CLUB = {
  name: "Club Sintético",
  code: "SINT",
  hasLegalStatus: false,
};

describe("usernameOpcionalField", () => {
  it.each([[null], [""], ["   "], [" \u0009 "]])("%j significa «sin nombre»: null", (valor) => {
    const r = usernameOpcionalField.safeParse(valor);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBeNull();
  });

  it("recorta un nombre válido", () => {
    const r = usernameOpcionalField.safeParse("  ana.prueba  ");
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe("ana.prueba");
  });

  it.each([
    ["abc", /al menos 4/],
    ["a".repeat(31), /30 caracteres/],
    ["ana prueba", /letras, números/],
    ["ana@prueba", /letras, números/],
  ])("rechaza %j con el mensaje concreto", (valor, mensaje) => {
    const r = usernameOpcionalField.safeParse(valor);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.message).toMatch(mensaje);
  });
});

describe.each([
  { titular: "persona", crear: personCreateSchema, editar: personUpdateSchema, base: PERSONA, baseEdicion: {} },
  { titular: "club", crear: clubCreateSchema, editar: clubUpdateSchema, base: CLUB, baseEdicion: { hasLegalStatus: false } },
])("$titular", ({ crear, editar, base, baseEdicion }) => {
  it("alta SIN el campo: válida y sin nombre", () => {
    const r = crear.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.username ?? null).toBeNull();
  });

  it.each([[null], [""], ["   "]])("alta con username %j: válida y queda null", (username) => {
    const r = crear.safeParse({ ...base, username });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.username).toBeNull();
  });

  it("alta con un nombre mal formado: rechazada", () => {
    expect(crear.safeParse({ ...base, username: "ab" }).success).toBe(false);
  });

  it("edición: omitirlo lo deja indefinido (no tocar)", () => {
    const r = editar.safeParse(baseEdicion);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.username).toBeUndefined();
  });

  it.each([[null], [""], ["   "]])("edición con username %j: llega null (quitarlo)", (username) => {
    const r = editar.safeParse({ ...baseEdicion, username });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.username).toBeNull();
  });

  it("edición con un nombre válido: se recorta", () => {
    const r = editar.safeParse({ ...baseEdicion, username: " nuevo.nombre " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.username).toBe("nuevo.nombre");
  });

  it("edición con un nombre mal formado: rechazada", () => {
    expect(editar.safeParse({ ...baseEdicion, username: "con espacio" }).success).toBe(false);
  });
});

describe("cuerpo de «Crear credenciales»", () => {
  it.each([[undefined], [{}], [{ username: null }], [{ username: "" }], [{ username: "  " }]])(
    "%j: válido y sin nombre solicitado (se usará el guardado)",
    (cuerpo) => {
      const r = createCredentialsSchema.safeParse(cuerpo);
      expect(r.success).toBe(true);
      if (r.success) expect(r.data?.username ?? null).toBeNull();
    }
  );

  it("con un nombre válido lo entrega recortado", () => {
    const r = createCredentialsSchema.safeParse({ username: " nuevo.acceso " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data?.username).toBe("nuevo.acceso");
  });

  it("con un nombre mal formado: rechazado", () => {
    expect(createCredentialsSchema.safeParse({ username: "ab" }).success).toBe(false);
  });
});

describe("carga masiva por Excel — columna B opcional", () => {
  const fila = (usuario: unknown) => ["12345678-5", usuario, "Juan", "Pérez", "", "15-03-1990", "Masculino", "", ""];

  it.each([[""], [null], ["   "]])("columna B %j: la fila es válida y la persona queda sin nombre", (usuario) => {
    const r = mapRowToPersonInput(fila(usuario));
    expect(r.ok, r.errors.join("; ")).toBe(true);
    expect(r.data?.username).toBeNull();
  });

  it("columna B con un nombre mal formado: la fila se rechaza con el motivo", () => {
    const r = mapRowToPersonInput(fila("j perez"));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/letras, números/);
  });
});
