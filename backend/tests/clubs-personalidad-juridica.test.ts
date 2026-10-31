import { describe, it, expect } from "vitest";
import { clubCreateSchema, clubUpdateSchema } from "../src/modules/clubs/clubs.schemas";
import { bulkAssignSwimmersSchema, directAssignmentSchema, approveAssignmentSchema } from "../src/modules/swimmer-assignment/assignment.schemas";

/**
 * Los TRES estados de la personalidad jurídica, y la regla que los separa:
 * **`null` («pendiente de verificar») no es `false`**.
 *
 * El riesgo que estas pruebas vigilan es silencioso: con `boolean | null`, un
 * `if (hasLegalStatus)` sigue compilando y trata `null` igual que `false`. No
 * hay error de tipos que lo delate, así que la única defensa es comprobar el
 * comportamiento de cada estado por separado.
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

function mensajes(r: { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } }) {
  return r.success ? [] : (r.error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`);
}

describe("personalidad jurídica: el campo admite tres estados", () => {
  it("acepta true, false y null — y nada más", () => {
    for (const estado of [true, false, null]) {
      const r = clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: estado, rut: estado === true ? RUT_VALIDO : undefined });
      expect(r.success, `estado ${JSON.stringify(estado)}: ${mensajes(r).join("; ")}`).toBe(true);
    }
  });

  it("NO acepta que el campo se omita: dejar pendiente tiene que ser deliberado", () => {
    const r = clubCreateSchema.safeParse({ ...CLUB_BASE });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/hasLegalStatus/);
  });

  it("no acepta una cadena como estado", () => {
    expect(clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: "pendiente" }).success).toBe(false);
  });
});

describe("RUT según el estado (RB-02 con tres estados)", () => {
  it("con personalidad jurídica: el RUT es OBLIGATORIO", () => {
    const r = clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: true });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/RUT es obligatorio/);
  });

  it("pendiente: el RUT es OPCIONAL", () => {
    expect(clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: null }).success).toBe(true);
  });

  it("pendiente CON RUT: se acepta y se valida igual", () => {
    expect(clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: null, rut: RUT_VALIDO }).success).toBe(true);

    const malo = clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: null, rut: RUT_DV_MALO });
    expect(malo.success).toBe(false);
    expect(mensajes(malo).join(" ")).toMatch(/dígito verificador/);
  });

  it("pendiente con RUT NO pasa a verificado: el estado sigue siendo null", () => {
    const r = clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: null, rut: RUT_VALIDO });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.hasLegalStatus).toBeNull();
  });

  it("verificado como SIN personalidad jurídica: el RUT no se valida porque no se guarda", () => {
    expect(clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: false, rut: RUT_DV_MALO }).success).toBe(true);
  });

  it("con personalidad jurídica y RUT inválido: se rechaza", () => {
    const r = clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: true, rut: RUT_DV_MALO });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/dígito verificador/);
  });
});

describe("representante legal: no se designa sin personalidad jurídica confirmada", () => {
  it("con personalidad jurídica: se puede designar", () => {
    const r = clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: true, rut: RUT_VALIDO, legalRepresentativePersonId: UUID });
    expect(r.success, mensajes(r).join("; ")).toBe(true);
  });

  it("PENDIENTE: se rechaza la designación, con un mensaje que explica por qué", () => {
    const r = clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: null, legalRepresentativePersonId: UUID });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/pendiente de verificar/i);
  });

  it("sin personalidad jurídica: se rechaza la designación", () => {
    const r = clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: false, legalRepresentativePersonId: UUID });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/Solo los clubes con personalidad jurídica/);
  });

  it("pendiente SIN designación: válido", () => {
    expect(clubCreateSchema.safeParse({ ...CLUB_BASE, hasLegalStatus: null, legalRepresentativePersonId: null }).success).toBe(true);
  });

  it("la misma regla aplica al actualizar", () => {
    const r = clubUpdateSchema.safeParse({ hasLegalStatus: null, legalRepresentativePersonId: UUID });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/pendiente de verificar/i);
  });
});

describe("al actualizar, el estado siempre viaja explícito", () => {
  it("exige hasLegalStatus para poder re-evaluar RB-02", () => {
    const r = clubUpdateSchema.safeParse({ name: "OTRO NOMBRE" });
    expect(r.success).toBe(false);
    expect(mensajes(r).join(" ")).toMatch(/hasLegalStatus/);
  });

  it("un null explícito se conserva como null y no se confunde con «no enviado»", () => {
    const r = clubUpdateSchema.safeParse({ hasLegalStatus: null });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.hasLegalStatus).toBeNull();
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
