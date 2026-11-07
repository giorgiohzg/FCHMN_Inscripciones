import { describe, it, expect } from "vitest";
import { clubCreateSchema, clubUpdateSchema, clubListQuerySchema } from "../src/modules/clubs/clubs.schemas";
import { bulkAssignSwimmersSchema, directAssignmentSchema, approveAssignmentSchema } from "../src/modules/swimmer-assignment/assignment.schemas";

/**
 * Los DOS estados de la personalidad jurídica (`true` / `false`), desde la
 * etapa 10a. El tercer estado, `null` («pendiente de verificar»), se retiró del
 * contrato público: un cliente anterior que lo envíe recibe un 400 comprensible.
 *
 * El riesgo que estas pruebas vigilan es silencioso: la columna física todavía
 * admite NULL (hasta la migración 10b), así que nada en los tipos de la base
 * impide que un `null` se cuele. Solo el contrato de la API lo cierra.
 */

const CLUB_BASE = {
  name: "CLUB DE PRUEBA",
  code: "PRUEB",
  username: "club.prueba",
  email: "contacto@example.invalid",
  isAchmnMember: false,
  isAchmnCollaborator: false,
  isFchmnMember: false,
  isFchmnCollaborator: false,
};

const UUID = "11111111-2222-3333-4444-555555555555";
/**
 * RUT con dígito verificador válido, evidentemente sintético: un valor
 * correcto en el rango 76-77 millones podría pertenecer a una empresa real.
 */
const RUT_VALIDO = "11111111-1";
const RUT_DV_MALO = "11111111-2";

function mensajes(r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return r.success ? [] : (r.error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("personalidad jurídica: el campo admite dos estados", () => {
  it("acepta true y false — y nada más", () => {
    for (const estado of [true, false]) {
      const r = clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: estado, rut: estado ? RUT_VALIDO : undefined });
      expect(r.success, `estado ${JSON.stringify(estado)}: ${mensajes(r).join("; ")}`).toBe(true);
    }
  });

  it("RECHAZA null (el antiguo «pendiente de verificar») con un mensaje comprensible", () => {
    const r = clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: null });
    expect(r.success).toBe(false);
    const texto = mensajes(r).join(" ");
    expect(texto).toMatch(/hasLegalStatus/);
    expect(texto).toMatch(/Sí o No/);
    expect(texto).toMatch(/pendiente de verificar/);
  });

  it("NO acepta que el campo se omita: omitirlo no puede significar «No tiene»", () => {
    const r = clubCreateSchema.safeParse({ ...CLUB_BASE });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/hasLegalStatus/);
  });

  it.each([["pendiente"], ["si"], ["no"], [1], [0]])("no acepta %j como estado", (valor) => {
    expect(clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: valor }).success).toBe(false);
  });
});

describe("RUT según el estado (RB-02 con dos estados)", () => {
  it("con personalidad jurídica: el RUT es OBLIGATORIO", () => {
    const r = clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: true });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/RUT es obligatorio/);
  });

  it("sin personalidad jurídica: el RUT no se valida porque no se guarda", () => {
    expect(clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: false }).success).toBe(true);
    expect(clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: false, rut: RUT_DV_MALO }).success).toBe(true);
  });

  it("con personalidad jurídica y RUT inválido: se rechaza", () => {
    const r = clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: true, rut: RUT_DV_MALO });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/dígito verificador/);
  });

  it("con personalidad jurídica y RUT válido: se acepta", () => {
    expect(clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: true, rut: RUT_VALIDO }).success).toBe(true);
  });
});

describe("representante legal: solo con personalidad jurídica", () => {
  it("con personalidad jurídica: se puede designar", () => {
    const r = clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: true, rut: RUT_VALIDO, legalRepresentativePersonId: UUID });
    expect(r.success, mensajes(r).join("; ")).toBe(true);
  });

  it("sin personalidad jurídica: se rechaza la designación", () => {
    const r = clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: false, legalRepresentativePersonId: UUID });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/Solo los clubes con personalidad jurídica/);
  });

  it("sin personalidad jurídica y SIN designación: válido", () => {
    expect(clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: false, legalRepresentativePersonId: null }).success).toBe(true);
  });

  it("la misma regla aplica al actualizar", () => {
    const r = clubUpdateSchema.safeParse({ hasLegalStatus: false, legalRepresentativePersonId: UUID });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/Solo los clubes con personalidad jurídica/);
  });
});

describe("filtro del listado: solo «si» y «no»", () => {
  it.each([["si"], ["no"]])("acepta %j", (valor) => {
    expect(clubListQuerySchema.safeParse({ personalidadJuridica: valor }).success).toBe(true);
  });

  it("sin filtro es válido", () => {
    expect(clubListQuerySchema.safeParse({}).success).toBe(true);
  });

  it("RECHAZA «pendiente» con un mensaje que explica que ya no existe", () => {
    const r = clubListQuerySchema.safeParse({ personalidadJuridica: "pendiente" });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/solo admite "si" o "no"/);
    expect(mensajes(r).join(" ")).toMatch(/"pendiente" ya no existe/);
  });
});

describe("al actualizar, el estado siempre viaja explícito", () => {
  it("exige hasLegalStatus para poder re-evaluar RB-02", () => {
    const r = clubUpdateSchema.safeParse({ name: "OTRO NOMBRE" });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/hasLegalStatus/);
  });

  it("un null explícito se RECHAZA: no se confunde con «no enviado» ni se acepta como estado", () => {
    const r = clubUpdateSchema.safeParse({ hasLegalStatus: null });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/Sí o No/);
  });
});

describe("fecha efectiva: solo fechas de calendario", () => {
  const BULK = { targetClubId: UUID, personIds: [UUID] };

  it("acepta AAAA-MM-DD", () => {
    const r = bulkAssignSwimmersSchema.safeParse({ ...BULK, fechaEfectiva: "2026-10-30" });
    expect(r.success, mensajes(r).join("; ")).toBe(true);
    if (r.success) expect(r.data.fechaEfectiva).toBe("2026-10-30");
  });

  it("es opcional: sin ella el servicio usa hoy en Chile", () => {
    const r = bulkAssignSwimmersSchema.safeParse(BULK);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.fechaEfectiva).toBeUndefined();
  });

  it("RECHAZA un instante: admitir la hora reabriría el problema de las zonas", () => {
    const r = bulkAssignSwimmersSchema.safeParse({ ...BULK, fechaEfectiva: "2026-10-30T00:00:00.000Z" });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/AAAA-MM-DD/);
  });

  it("rechaza otros formatos y días inexistentes", () => {
    for (const v of ["30-10-2026", "2026/10/30", "2026-2-3", "", "ayer"]) {
      expect(bulkAssignSwimmersSchema.safeParse({ ...BULK, fechaEfectiva: v }).success, `«${v}»`).toBe(false);
    }
    const inexistente = bulkAssignSwimmersSchema.safeParse({ ...BULK, fechaEfectiva: "2026-02-30" });
    expect(inexistente.success).toBe(false);
    expect(mensajes(inexistente).join(" ")).toMatch(/no existe/i);
  });

  it("la admiten también la asignación directa y la aprobación", () => {
    expect(directAssignmentSchema.safeParse({ clubId: UUID, personId: UUID, fechaEfectiva: "2026-10-30" }).success).toBe(true);
    expect(approveAssignmentSchema.safeParse({ fechaEfectiva: "2026-10-30" }).success).toBe(true);
    // Aprobar sin cuerpo sigue funcionando.
    expect(approveAssignmentSchema.safeParse({}).success).toBe(true);
  });

  it("la propuesta NO la admite: una membresía pendiente todavía no tiene fecha de inicio", async () => {
    const { proposeAssignmentSchema } = await import("../src/modules/swimmer-assignment/assignment.schemas");
    const r = proposeAssignmentSchema.safeParse({ clubId: UUID, personId: UUID, fechaEfectiva: "2026-10-30" });
    expect(r.success).toBe(true);
    // Zod descarta las claves no declaradas: la fecha no llega al servicio.
    if (r.success) expect("fechaEfectiva" in r.data).toBe(false);
  });
});
