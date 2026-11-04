import { describe, it, expect } from "vitest";
import { clubCreateSchema, clubUpdateSchema } from "../src/modules/clubs/clubs.schemas";

const base = {
  name: "Club Delfines",
  username: "delfines_cl",
  code: "SINT",
  email: "contacto@delfines.cl",
  isAchmnMember: false,
  isFchmnMember: false,
  isFchmnCollaborator: false,
};

describe("clubs.schemas — RB-02 (RUT condicional a personalidad jurídica)", () => {
  it("permite crear un club SIN personalidad jurídica y SIN rut", () => {
    const result = clubCreateSchema.safeParse({ ...base, hasLegalStatus: false });
    expect(result.success).toBe(true);
  });

  it("rechaza un club CON personalidad jurídica y SIN rut", () => {
    const result = clubCreateSchema.safeParse({ ...base, hasLegalStatus: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      const rutIssue = result.error.issues.find((i) => i.path.includes("rut"));
      expect(rutIssue?.message).toMatch(/obligatorio/i);
    }
  });

  it("rechaza un club CON personalidad jurídica y un rut con dígito verificador inválido", () => {
    const result = clubCreateSchema.safeParse({ ...base, hasLegalStatus: true, rut: "11.111.111-2" });
    expect(result.success).toBe(false);
  });

  it("acepta un club CON personalidad jurídica y un rut válido", () => {
    const result = clubCreateSchema.safeParse({ ...base, hasLegalStatus: true, rut: "11.111.111-1" });
    expect(result.success).toBe(true);
  });

  it("ignora el rut si se envía pero hasLegalStatus es false (no se exige validarlo)", () => {
    const result = clubCreateSchema.safeParse({ ...base, hasLegalStatus: false, rut: "no-es-un-rut" });
    expect(result.success).toBe(true);
  });

  it("rechaza si falta el nombre del club", () => {
    const result = clubCreateSchema.safeParse({ ...base, name: "", hasLegalStatus: false });
    expect(result.success).toBe(false);
  });

  it("rechaza un correo electrónico inválido", () => {
    const result = clubCreateSchema.safeParse({ ...base, email: "no-es-correo", hasLegalStatus: false });
    expect(result.success).toBe(false);
  });
});

describe("clubs.schemas — sigla (code) y nombre de usuario", () => {
  it("rechaza una sigla de más de 5 caracteres", () => {
    const result = clubCreateSchema.safeParse({ ...base, hasLegalStatus: false, code: "DELFIN" });
    expect(result.success).toBe(false);
  });

  it("rechaza una sigla vacía", () => {
    const result = clubCreateSchema.safeParse({ ...base, hasLegalStatus: false, code: "" });
    expect(result.success).toBe(false);
  });

  it("acepta una sigla de exactamente 5 caracteres", () => {
    const result = clubCreateSchema.safeParse({ ...base, hasLegalStatus: false, code: "DELFI" });
    expect(result.success).toBe(true);
  });

  it("rechaza una sigla con caracteres no alfanuméricos", () => {
    const result = clubCreateSchema.safeParse({ ...base, hasLegalStatus: false, code: "DE-F" });
    expect(result.success).toBe(false);
  });

  it("rechaza un nombre de usuario demasiado corto", () => {
    const result = clubCreateSchema.safeParse({ ...base, hasLegalStatus: false, username: "ab" });
    expect(result.success).toBe(false);
  });

  it("rechaza un nombre de usuario con espacios u otros caracteres inválidos", () => {
    const result = clubCreateSchema.safeParse({ ...base, hasLegalStatus: false, username: "club delfines" });
    expect(result.success).toBe(false);
  });

  it("acepta un nombre de usuario con letras, números, puntos y guiones", () => {
    const result = clubCreateSchema.safeParse({ ...base, hasLegalStatus: false, username: "club.delfines-2026" });
    expect(result.success).toBe(true);
  });
});

describe("clubs.schemas — correo OPCIONAL (etapa 8)", () => {
  const sinCorreo = (() => {
    const { email: _omitido, ...resto } = base;
    return resto;
  })();

  it("alta SIN el campo: válida, y la ausencia no se convierte en cadena vacía", () => {
    const r = clubCreateSchema.safeParse({ ...sinCorreo, hasLegalStatus: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email ?? null).toBeNull();
  });

  it.each([[null], [""], ["   "], [" 	 "]])("alta con email %j: válida y queda en null", (email) => {
    const r = clubCreateSchema.safeParse({ ...base, email, hasLegalStatus: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBeNull();
  });

  it("alta con un correo informado: se recorta y se conserva", () => {
    const r = clubCreateSchema.safeParse({ ...base, email: "  a@b.cl  ", hasLegalStatus: false });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("a@b.cl");
  });

  it.each([["no-es-correo"], ["a@"], ["@b.cl"], ["a b@c.cl"]])("rechaza el correo mal formado %j en el alta y en la edición", (email) => {
    expect(clubCreateSchema.safeParse({ ...base, email, hasLegalStatus: false }).success).toBe(false);
    expect(clubUpdateSchema.safeParse({ email, hasLegalStatus: false }).success).toBe(false);
  });

  describe("edición", () => {
    it("OMITIR el campo lo deja indefinido (el servicio conserva el valor)", () => {
      const r = clubUpdateSchema.safeParse({ hasLegalStatus: false });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.email).toBeUndefined();
    });

    it.each([[null], [""], ["   "]])("email %j significa ELIMINAR: llega como null", (email) => {
      const r = clubUpdateSchema.safeParse({ email, hasLegalStatus: false });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.email).toBeNull();
    });

    it("un correo informado, válido, se recorta", () => {
      const r = clubUpdateSchema.safeParse({ email: " nuevo@club.cl ", hasLegalStatus: false });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data.email).toBe("nuevo@club.cl");
    });
  });
});
