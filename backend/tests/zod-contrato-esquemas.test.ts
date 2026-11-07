/**
 * Contrato de los esquemas de validación frente al cambio de Zod (SEC-03 C).
 *
 * Estas pruebas nacieron como CARACTERIZACIÓN: se escribieron y se pasaron primero con Zod 3.25.76, para fijar qué hace hoy
 * cada esquema, y se mantienen idénticas con Zod 4. Lo que fijan es el CONTRATO observable de la API:
 *   - los mensajes PERSONALIZADOS en español (la persona usuaria los ve);
 *   - qué claves salen en los datos transformados (campo omitido = «no tocar»);
 *   - los valores por omisión de la CREACIÓN, que no deben filtrarse a las ACTUALIZACIONES;
 *   - las reglas de `undefined`, `null`, vacío y espacios.
 *
 * NO fijan los textos genéricos de Zod («Required», «Invalid input…»): cambian entre versiones y no son parte del contrato.
 * Solo comprueban que el campo tenga ALGÚN error. Todo con datos sintéticos.
 */
import { describe, it, expect } from "vitest";
import type { ZodType } from "zod";
import { clubCreateSchema, clubUpdateSchema, clubListQuerySchema } from "../src/modules/clubs/clubs.schemas";
import { poolCreateSchema, poolUpdateSchema } from "../src/modules/pools/pools.schemas";
import {
  personCreateSchema,
  personUpdateSchema,
  adminAccessSchema,
  createCredentialsSchema,
} from "../src/modules/persons/persons.schemas";
import {
  competitionCreateSchema,
  competitionUpdateSchema,
  competitionListQuerySchema,
  addDateSchema,
  addCompetitionEventSchema,
} from "../src/modules/competitions/competitions.schemas";
import { meetImportOptionsSchema, decisionDeRelevoSchema } from "../src/modules/meet-import/meet-import.schemas";
import { directAssignmentSchema, bulkAssignSwimmersSchema } from "../src/modules/swimmer-assignment/assignment.schemas";
import { createRegistrationSchema, updateRegistrationSchema } from "../src/modules/registrations/registrations.schemas";
import { mapRowToPersonInput } from "../src/modules/persons/persons-bulk-import.rules";
import { parseEnv } from "../src/shared/env.schema";
import { ValidationError } from "../src/shared/errors";

/** UUID sintético que NO cumple RFC 4122 (variante inválida): el contrato histórico lo acepta (`z.guid()`). */
const ID = "11111111-2222-3333-4444-555555555555";
const ID_V4 = "11111111-1111-4111-8111-111111111111";
const RUT_VALIDO = "11111111-1";

const claves = (v: unknown): string[] => Object.keys(v as object).sort();

/** `fieldErrors` del esquema ante la entrada, o `null` si la acepta. */
function errores(esquema: ZodType, entrada: unknown): Record<string, string[] | undefined> | null {
  const r = esquema.safeParse(entrada);
  return r.success ? null : (r.error.flatten().fieldErrors as Record<string, string[] | undefined>);
}
function datos<T = Record<string, unknown>>(esquema: ZodType, entrada: unknown): T {
  const r = esquema.safeParse(entrada);
  if (!r.success) throw new Error("se esperaba aceptar: " + JSON.stringify(r.error.flatten()));
  return r.data as T;
}
const primerMensaje = (esquema: ZodType, entrada: unknown, campo: string): string | undefined => errores(esquema, entrada)?.[campo]?.[0];

const CLUB = { name: "Club Sintético", code: "SINT", hasLegalStatus: false };

describe("clubes — creación", () => {
  it("los indicadores de membresía salen en false por omisión; nada más se inventa", () => {
    expect(claves(datos(clubCreateSchema, CLUB))).toEqual(
      ["code", "hasLegalStatus", "isAchmnCollaborator", "isAchmnMember", "isFchmnCollaborator", "isFchmnMember", "name"].sort()
    );
    expect(datos(clubCreateSchema, CLUB)).toMatchObject({ isAchmnMember: false, isAchmnCollaborator: false, isFchmnMember: false, isFchmnCollaborator: false });
  });

  it.each([
    ["ausente", undefined],
    ["null", null],
    ["texto", "si"],
  ])("personalidad jurídica %s: conserva el mensaje personalizado", (_n, valor) => {
    const entrada = valor === undefined ? { ...CLUB, hasLegalStatus: undefined } : { ...CLUB, hasLegalStatus: valor };
    const m = primerMensaje(clubCreateSchema, entrada, "hasLegalStatus");
    expect(m).toMatch(/^Indique si el club tiene personalidad jurídica \(Sí o No\)/);
    expect(m).toMatch(/pendiente de verificar/);
  });

  it("el correo opcional: ausente = sin clave; null, vacío y espacios = null; se recorta; el formato se valida", () => {
    expect(claves(datos(clubCreateSchema, CLUB))).not.toContain("email");
    for (const vacio of [null, "", "   "]) expect(datos(clubCreateSchema, { ...CLUB, email: vacio }).email).toBeNull();
    expect(datos(clubCreateSchema, { ...CLUB, email: "  contacto@example.invalid " }).email).toBe("contacto@example.invalid");
    expect(errores(clubCreateSchema, { ...CLUB, email: "no-es-correo" })).toEqual({ email: ["Correo electrónico inválido"] });
    expect(errores(clubCreateSchema, { ...CLUB, email: 5 })?.email?.length).toBeGreaterThan(0);
  });

  it("las listas de delegados y entrenadores: ausentes = sin clave; tope con su mensaje; UUID no RFC aceptado", () => {
    expect(claves(datos(clubCreateSchema, CLUB))).not.toContain("delegatePersonIds");
    expect(datos(clubCreateSchema, { ...CLUB, delegatePersonIds: [ID, ID_V4] }).delegatePersonIds).toEqual([ID, ID_V4]);
    expect(errores(clubCreateSchema, { ...CLUB, delegatePersonIds: Array.from({ length: 51 }, () => ID) })).toEqual({
      delegatePersonIds: ["Un club admite como máximo 50 delegados"],
    });
    expect(errores(clubCreateSchema, { ...CLUB, coachPersonIds: Array.from({ length: 51 }, () => ID) })).toEqual({
      coachPersonIds: ["Un club admite como máximo 50 entrenadores"],
    });
    expect(errores(clubCreateSchema, { ...CLUB, delegatePersonIds: ["no-es-uuid"] })?.delegatePersonIds?.length).toBe(1);
  });

  it("las reglas de RUT, representante y membresías conservan sus mensajes", () => {
    expect(errores(clubCreateSchema, { ...CLUB, hasLegalStatus: true })).toEqual({ rut: ["El RUT es obligatorio para clubes con personalidad jurídica"] });
    expect(errores(clubCreateSchema, { ...CLUB, hasLegalStatus: true, rut: "abc" })).toEqual({ rut: ["Formato de RUT inválido (use 12345678-9)"] });
    expect(errores(clubCreateSchema, { ...CLUB, hasLegalStatus: true, rut: "11111111-2" })).toEqual({ rut: ["El dígito verificador del RUT no es válido"] });
    expect(errores(clubCreateSchema, { ...CLUB, legalRepresentativePersonId: ID })).toEqual({
      legalRepresentativePersonId: ["Solo los clubes con personalidad jurídica pueden tener representante legal"],
    });
    expect(errores(clubCreateSchema, { ...CLUB, isAchmnMember: true, isAchmnCollaborator: true })).toEqual({
      isAchmnCollaborator: ["Un club no puede ser Socio y Colaborador ACHMN a la vez"],
    });
  });
});

describe("clubes — actualización: lo omitido sigue significando «no modificar»", () => {
  it("sin los indicadores, los datos NO los traen (ni con valor por omisión)", () => {
    expect(claves(datos(clubUpdateSchema, { hasLegalStatus: false, name: "Nuevo nombre" }))).toEqual(["hasLegalStatus", "name"]);
    expect(claves(datos(clubUpdateSchema, { hasLegalStatus: true, rut: RUT_VALIDO }))).toEqual(["hasLegalStatus", "rut"]);
  });

  it("un indicador enviado se conserva, incluso en false, y no arrastra a los demás", () => {
    expect(datos(clubUpdateSchema, { hasLegalStatus: false, isFchmnMember: true })).toEqual({ hasLegalStatus: false, isFchmnMember: true });
    expect(datos(clubUpdateSchema, { hasLegalStatus: false, isFchmnMember: false })).toEqual({ hasLegalStatus: false, isFchmnMember: false });
  });

  it("correo y nombre de usuario: omitido = sin clave; null, vacío o espacios = quitarlo (null)", () => {
    expect(claves(datos(clubUpdateSchema, { hasLegalStatus: false }))).toEqual(["hasLegalStatus"]);
    for (const vacio of [null, "", "  "]) {
      expect(datos(clubUpdateSchema, { hasLegalStatus: false, email: vacio, username: vacio })).toMatchObject({ email: null, username: null });
    }
  });

  it("la personalidad jurídica sigue siendo obligatoria también al actualizar", () => {
    expect(primerMensaje(clubUpdateSchema, { name: "X club" }, "hasLegalStatus")).toMatch(/^Indique si el club tiene personalidad jurídica/);
  });
});

describe("clubes — filtros de listado", () => {
  it("«pendiente» se rechaza con el mensaje propio; si, no y omitido se aceptan", () => {
    expect(errores(clubListQuerySchema, { personalidadJuridica: "pendiente" })).toEqual({
      personalidadJuridica: ['El filtro de personalidad jurídica solo admite "si" o "no". El estado "pendiente" ya no existe.'],
    });
    expect(datos(clubListQuerySchema, { personalidadJuridica: "si" }).personalidadJuridica).toBe("si");
    expect(claves(datos(clubListQuerySchema, {}))).toEqual(["page", "pageSize"]);
  });

  it("paginación: valores por omisión, texto numérico coaccionado y topes", () => {
    expect(datos(clubListQuerySchema, {})).toMatchObject({ page: 1, pageSize: 20 });
    expect(datos(clubListQuerySchema, { page: "2", pageSize: "100" })).toMatchObject({ page: 2, pageSize: 100 });
    expect(errores(clubListQuerySchema, { pageSize: "101" })?.pageSize?.length).toBe(1);
    expect(errores(clubListQuerySchema, { page: "0" })?.page?.length).toBe(1);
    expect(errores(clubListQuerySchema, { page: "abc" })?.page?.length).toBe(1);
  });
});

describe("piscinas", () => {
  it("creación: los indicadores salen en false por omisión", () => {
    expect(datos(poolCreateSchema, { name: "Piscina X", courseLength: "short_25m" })).toEqual({
      name: "Piscina X",
      isHeated: false,
      isCovered: false,
      courseLength: "short_25m",
    });
  });

  it("actualización: lo omitido NO se restablece (sin isHeated ni isCovered en los datos)", () => {
    expect(claves(datos(poolUpdateSchema, { name: "Nuevo nombre" }))).toEqual(["name"]);
    expect(claves(datos(poolUpdateSchema, {}))).toEqual([]);
    expect(datos(poolUpdateSchema, { isHeated: true })).toEqual({ isHeated: true });
    expect(datos(poolUpdateSchema, { isCovered: false })).toEqual({ isCovered: false });
  });

  it("el tipo de piscina conserva su mensaje en la creación; en la actualización, un valor inválido también falla", () => {
    expect(errores(poolCreateSchema, { name: "Piscina X" })).toEqual({ courseLength: ["Debe indicar si es piscina de 25 o 50 metros"] });
    expect(errores(poolCreateSchema, { name: "Piscina X", courseLength: "x" })).toEqual({ courseLength: ["Debe indicar si es piscina de 25 o 50 metros"] });
    expect(errores(poolUpdateSchema, { courseLength: "x" })?.courseLength?.length).toBe(1);
  });
});

describe("personas", () => {
  const PERSONA = { run: "12345678-5", firstName: "Ana", paternalLastName: "Prueba", birthDate: "1990-01-01", gender: "female" };

  it("creación válida: fecha coaccionada a Date, sin claves inventadas", () => {
    const d = datos<{ birthDate: Date }>(personCreateSchema, PERSONA);
    expect(d.birthDate).toBeInstanceOf(Date);
    expect(d.birthDate.toISOString()).toBe("1990-01-01T00:00:00.000Z");
    expect(claves(d)).not.toContain("roles");
    expect(claves(d)).not.toContain("email");
  });

  it("mensajes personalizados de creación", () => {
    expect(primerMensaje(personCreateSchema, { ...PERSONA, gender: "x" }, "gender")).toBe("Debe indicar el género de la persona");
    expect(primerMensaje(personCreateSchema, { ...PERSONA, gender: undefined }, "gender")).toBe("Debe indicar el género de la persona");
    expect(primerMensaje(personCreateSchema, { ...PERSONA, birthDate: "no-es-fecha" }, "birthDate")).toBe("Fecha de nacimiento inválida");
    expect(primerMensaje(personCreateSchema, { ...PERSONA, birthDate: undefined }, "birthDate")).toBe("Fecha de nacimiento inválida");
    expect(primerMensaje(personCreateSchema, { ...PERSONA, firstName: "A" }, "firstName")).toBe("El nombre es obligatorio");
    expect(primerMensaje(personCreateSchema, { ...PERSONA, run: "1234" }, "run")).toBe("Formato de RUN inválido (use 12345678-9)");
  });

  it("`roles` se RECHAZA con su mensaje, al crear y al actualizar; ausente o undefined se acepta", () => {
    for (const esquema of [personCreateSchema, personUpdateSchema]) {
      const entrada = esquema === personCreateSchema ? { ...PERSONA, roles: ["swimmer"] } : { roles: ["swimmer"] };
      expect(primerMensaje(esquema, entrada, "roles")).toMatch(/^Los roles no se asignan desde la ficha de la persona/);
    }
    expect(errores(personCreateSchema, { ...PERSONA, roles: null })?.roles?.[0]).toMatch(/^Los roles no se asignan/);
    expect(errores(personCreateSchema, { ...PERSONA, roles: undefined })).toBeNull();
  });

  it("correo: vacío = sin dato (creación: sin valor; actualización: null); mal formado conserva su mensaje", () => {
    expect(datos(personCreateSchema, { ...PERSONA, email: "" }).email).toBeUndefined();
    expect(datos(personCreateSchema, { ...PERSONA, email: " ana@example.invalid " }).email).toBe("ana@example.invalid");
    expect(datos(personUpdateSchema, { email: "" }).email).toBeNull();
    expect(claves(datos(personUpdateSchema, {}))).toEqual([]);
    expect(errores(personCreateSchema, { ...PERSONA, email: "nope" })).toEqual({ email: ["Correo electrónico inválido"] });
    expect(errores(personUpdateSchema, { email: "nope" })).toEqual({ email: ["Correo electrónico inválido"] });
    expect(errores(personCreateSchema, { ...PERSONA, email: 5 })?.email?.length).toBeGreaterThan(0);
  });

  it("nombre de usuario opcional: omitido = sin clave; null, vacío o espacios = null; formato con su mensaje", () => {
    expect(claves(datos(personCreateSchema, PERSONA))).not.toContain("username");
    for (const vacio of [null, "", "   "]) expect(datos(personCreateSchema, { ...PERSONA, username: vacio }).username).toBeNull();
    expect(errores(personCreateSchema, { ...PERSONA, username: "ab" })).toEqual({ username: ["El nombre de usuario debe tener al menos 4 caracteres"] });
    expect(claves(datos(personUpdateSchema, { firstName: "Ana" }))).toEqual(["firstName"]);
  });

  it("actualización parcial: solo salen las claves enviadas", () => {
    expect(claves(datos(personUpdateSchema, { phone: "123", gender: "male" }))).toEqual(["gender", "phone"]);
    expect(datos(personUpdateSchema, { birthDate: "1990-05-06" }).birthDate).toBeInstanceOf(Date);
  });

  it("permisos de administrador y credenciales", () => {
    expect(errores(adminAccessSchema, {})).toEqual({ adminAccess: ["Indique si la persona debe tener permisos de administrador"] });
    expect(errores(adminAccessSchema, { adminAccess: "si" })).toEqual({ adminAccess: ["Indique si la persona debe tener permisos de administrador"] });
    expect(datos(adminAccessSchema, { adminAccess: false })).toEqual({ adminAccess: false });
    expect(createCredentialsSchema.safeParse(undefined).success).toBe(true);
    expect(datos(createCredentialsSchema, { username: "  " })).toEqual({ username: null });
  });
});

describe("competencias", () => {
  const FECHAS = { registrationStartAt: "2026-03-01", registrationEndAt: "2026-03-10", ageCutoffDate: "2026-12-31" };
  const BASE = { name: "Competencia X", ...FECHAS, maxIndividualEventsPerSwimmer: "3" };

  it("creación válida: coerciones, valor por omisión de relevos y claves", () => {
    const d = datos<{ maxIndividualEventsPerSwimmer: number; maxRelayEventsPerSwimmerPerSession: number; registrationStartAt: Date }>(competitionCreateSchema, BASE);
    expect(d.maxIndividualEventsPerSwimmer).toBe(3);
    expect(d.maxRelayEventsPerSwimmerPerSession).toBe(1);
    expect(d.registrationStartAt).toBeInstanceOf(Date);
    expect(claves(d)).not.toContain("maxSwimmers");
    expect(claves(d)).not.toContain("visibleInRegistrationPanels");
  });

  it("mensajes personalizados de la creación", () => {
    expect(primerMensaje(competitionCreateSchema, { ...BASE, registrationStartAt: "x" }, "registrationStartAt")).toBe("Fecha de inicio de inscripción inválida");
    expect(primerMensaje(competitionCreateSchema, { ...BASE, registrationEndAt: "x" }, "registrationEndAt")).toBe("Fecha de fin de inscripción inválida");
    expect(primerMensaje(competitionCreateSchema, { ...BASE, ageCutoffDate: "x" }, "ageCutoffDate")).toBe("Fecha de corte de edad inválida");
    expect(primerMensaje(competitionCreateSchema, { ...BASE, maxIndividualEventsPerSwimmer: undefined }, "maxIndividualEventsPerSwimmer")).toBe(
      "Debe ingresar la cantidad máxima de pruebas individuales por nadador"
    );
    expect(primerMensaje(competitionCreateSchema, { ...BASE, maxIndividualEventsPerSwimmer: "abc" }, "maxIndividualEventsPerSwimmer")).toBe(
      "Debe ingresar la cantidad máxima de pruebas individuales por nadador"
    );
    expect(primerMensaje(competitionCreateSchema, { ...BASE, maxIndividualEventsPerSwimmer: "0" }, "maxIndividualEventsPerSwimmer")).toBe("Debe ser al menos 1");
    expect(primerMensaje(competitionCreateSchema, { ...BASE, maxRelayEventsPerSwimmerPerSession: "abc" }, "maxRelayEventsPerSwimmerPerSession")).toBe(
      "Debe indicar el máximo de relevos por nadador y jornada"
    );
    expect(primerMensaje(competitionCreateSchema, { ...BASE, maxRelayEventsPerSwimmerPerSession: "-1" }, "maxRelayEventsPerSwimmerPerSession")).toBe("No puede ser negativo");
  });

  it("decimales en cantidades: se rechazan con el mismo mensaje personalizado (con Zod 3 el del esquema también cubría a `.int()`)", () => {
    expect(primerMensaje(competitionCreateSchema, { ...BASE, maxIndividualEventsPerSwimmer: "1.5" }, "maxIndividualEventsPerSwimmer")).toBe(
      "Debe ingresar la cantidad máxima de pruebas individuales por nadador"
    );
    expect(primerMensaje(competitionCreateSchema, { ...BASE, maxRelayEventsPerSwimmerPerSession: "0.5" }, "maxRelayEventsPerSwimmerPerSession")).toBe(
      "Debe indicar el máximo de relevos por nadador y jornada"
    );
  });

  it("reglas entre campos conservan mensaje y ruta", () => {
    expect(errores(competitionCreateSchema, { ...BASE, registrationEndAt: "2026-02-01" })).toEqual({
      registrationEndAt: ["La fecha de fin de inscripción debe ser posterior a la de inicio"],
    });
    expect(errores(competitionCreateSchema, { ...BASE, maxSwimmers: 10, maxSwimmersPerClub: 11 })).toEqual({
      maxSwimmersPerClub: ["El cupo por club no puede superar el cupo total de la competencia"],
    });
  });

  it("cupos: null se conserva (quitar el cupo); omitido no aparece; booleanos estrictos", () => {
    expect(datos(competitionCreateSchema, { ...BASE, maxSwimmers: null }).maxSwimmers).toBeNull();
    expect(errores(competitionCreateSchema, { ...BASE, visibleInRegistrationPanels: "false" })?.visibleInRegistrationPanels?.length).toBe(1);
    expect(datos(competitionCreateSchema, { ...BASE, visibleInRegistrationPanels: false }).visibleInRegistrationPanels).toBe(false);
  });

  it("actualización: solo salen las claves enviadas (sin valor por omisión de relevos)", () => {
    expect(claves(datos(competitionUpdateSchema, { name: "Nuevo nombre" }))).toEqual(["name"]);
    expect(claves(datos(competitionUpdateSchema, {}))).toEqual([]);
    expect(datos(competitionUpdateSchema, { maxSwimmers: null }).maxSwimmers).toBeNull();
  });

  it("filtros: la visibilidad se enumera y se transforma; la paginación tiene sus valores por omisión", () => {
    expect(datos(competitionListQuerySchema, { visibleInRegistrationPanels: "true" }).visibleInRegistrationPanels).toBe(true);
    expect(datos(competitionListQuerySchema, { visibleInRegistrationPanels: "false" }).visibleInRegistrationPanels).toBe(false);
    expect(errores(competitionListQuerySchema, { visibleInRegistrationPanels: "yes" })?.visibleInRegistrationPanels?.length).toBe(1);
    expect(claves(datos(competitionListQuerySchema, {}))).toEqual(["page", "pageSize"]);
  });

  it("fecha de la jornada y prueba de la competencia", () => {
    expect(errores(addDateSchema, { date: "x" })).toEqual({ date: ["Fecha inválida"] });
    expect(errores(addDateSchema, {})).toEqual({ date: ["Fecha inválida"] });
    expect(errores(addCompetitionEventSchema, { eventId: "x", competitionSessionId: ID, categoryIds: [ID] })).toEqual({ eventId: ["Prueba inválida"] });
    expect(errores(addCompetitionEventSchema, { eventId: ID, competitionSessionId: ID, categoryIds: [] })).toEqual({
      categoryIds: ["Debe habilitar al menos una categoría"],
    });
    expect(errores(addCompetitionEventSchema, { eventId: ID, competitionSessionId: ID, categoryIds: [ID], maxSwimmersPerClub: "0" })).toEqual({
      maxSwimmersPerClub: ["El máximo por club debe ser al menos 1"],
    });
    expect(datos(addCompetitionEventSchema, { eventId: ID, competitionSessionId: ID, categoryIds: [ID], maxSwimmersPerClub: null }).maxSwimmersPerClub).toBeNull();
  });
});

describe("importación de Meet Events", () => {
  it("la cantidad de pruebas individuales conserva su mensaje; el opcional de relevos no aparece si no se envía", () => {
    expect(primerMensaje(meetImportOptionsSchema, {}, "maxIndividualEventsPerSwimmer")).toBe("Debe ingresar la cantidad máxima de pruebas individuales por nadador");
    expect(primerMensaje(meetImportOptionsSchema, { maxIndividualEventsPerSwimmer: "abc" }, "maxIndividualEventsPerSwimmer")).toBe(
      "Debe ingresar la cantidad máxima de pruebas individuales por nadador"
    );
    expect(primerMensaje(meetImportOptionsSchema, { maxIndividualEventsPerSwimmer: "1.5" }, "maxIndividualEventsPerSwimmer")).toBe(
      "Debe ingresar la cantidad máxima de pruebas individuales por nadador"
    );
    expect(datos(meetImportOptionsSchema, { maxIndividualEventsPerSwimmer: "2" })).toEqual({ maxIndividualEventsPerSwimmer: 2 });
  });

  it("la decisión por prueba de relevo: unión discriminada con sus mensajes", () => {
    expect(datos(decisionDeRelevoSchema, { eventNumber: 3, decision: "omitir" })).toEqual({ eventNumber: 3, decision: "omitir" });
    expect(datos(decisionDeRelevoSchema, { eventNumber: 3, decision: "tipo", testTypeId: ID })).toEqual({ eventNumber: 3, decision: "tipo", testTypeId: ID });
    const r = decisionDeRelevoSchema.safeParse({ eventNumber: 3, decision: "tipo", testTypeId: "x" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe("El tipo de relevo elegido no es válido");
    const d = decisionDeRelevoSchema.safeParse({ eventNumber: 3, decision: "inventada" });
    expect(d.success).toBe(false);
    if (!d.success) expect(d.error.issues[0]?.message).toBe("Invalid discriminator value. Expected 'tipo' | 'omitir'");
  });
});

describe("asignaciones e inscripciones", () => {
  it("fecha efectiva: formato, existencia y opcional", () => {
    const base = { clubId: ID, personId: ID };
    expect(claves(datos(directAssignmentSchema, base))).toEqual(["clubId", "personId"]);
    expect(errores(directAssignmentSchema, { ...base, fechaEfectiva: "30/10/2026" })).toEqual({
      fechaEfectiva: ["Use el formato AAAA-MM-DD (fecha de calendario, sin hora)", "Esa fecha no existe"],
    });
    expect(errores(directAssignmentSchema, { ...base, fechaEfectiva: "2026-02-30" })).toEqual({ fechaEfectiva: ["Esa fecha no existe"] });
    expect(datos(directAssignmentSchema, { ...base, fechaEfectiva: " 2026-10-30 " }).fechaEfectiva).toBe("2026-10-30");
    expect(errores(directAssignmentSchema, { clubId: "x", personId: ID })).toEqual({ clubId: ["Club inválido"] });
  });

  it("asignación masiva: mínimo, tope y mensajes", () => {
    expect(errores(bulkAssignSwimmersSchema, { targetClubId: ID, personIds: [] })).toEqual({ personIds: ["Debe seleccionar al menos un nadador"] });
    expect(errores(bulkAssignSwimmersSchema, { targetClubId: ID, personIds: Array.from({ length: 10_001 }, () => ID) })).toEqual({
      personIds: ["Se pueden asignar como máximo 10.000 nadadores por operación"],
    });
    expect(errores(bulkAssignSwimmersSchema, { targetClubId: "x", personIds: [ID] })).toEqual({ targetClubId: ["Club de destino inválido"] });
  });

  it("tiempo de inscripción: coerción de texto numérico, null solo donde se permite", () => {
    const base = { competitionEventId: ID, clubId: ID, personId: ID };
    expect(datos(createRegistrationSchema, { ...base, seedTimeCentiseconds: "1234" }).seedTimeCentiseconds).toBe(1234);
    expect(claves(datos(createRegistrationSchema, base))).not.toContain("seedTimeCentiseconds");
    expect(errores(createRegistrationSchema, { ...base, seedTimeCentiseconds: "-1" })?.seedTimeCentiseconds?.length).toBe(1);
    expect(datos(updateRegistrationSchema, { seedTimeCentiseconds: null }).seedTimeCentiseconds).toBeNull(); // nullable: null se conserva
    expect(errores(updateRegistrationSchema, {})?.seedTimeCentiseconds?.length).toBe(1);
  });

  it("DIFERENCIA ACEPTADA (D3): los enteros fuera del rango seguro se rechazan; el mayor entero seguro se acepta", () => {
    // Con Zod 3 "1e20" y "9007199254740993" pasaban `.int()` y fallaban después en la base; Zod 4 los rechaza en el borde.
    const base = { competitionEventId: ID, clubId: ID, personId: ID };
    for (const fueraDeRango of ["1e20", "9007199254740993"]) {
      expect(errores(createRegistrationSchema, { ...base, seedTimeCentiseconds: fueraDeRango })?.seedTimeCentiseconds?.length).toBe(1);
    }
    expect(datos(createRegistrationSchema, { ...base, seedTimeCentiseconds: "9007199254740991" }).seedTimeCentiseconds).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("carga masiva de personas: el informe de filas rechazadas", () => {
  const fila = (correo: string) => ["12345678-5", "", "Juan", "Pérez", "", "15-03-1990", "Masculino", correo, ""];

  it("una fila con correo inválido se rechaza con `campo: mensaje`", () => {
    const r = mapRowToPersonInput(fila("no-es-correo"));
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("email: Correo electrónico inválido");
  });

  it("una fila válida pasa por el mismo esquema y conserva sus datos", () => {
    const r = mapRowToPersonInput(fila(""));
    expect(r.ok, r.errors.join("; ")).toBe(true);
    expect(r.data?.firstName).toBe("Juan");
  });
});

describe("errores HTTP y de arranque", () => {
  it("ValidationError conserva el contrato {formErrors, fieldErrors} que lee el frontend", () => {
    const r = clubCreateSchema.safeParse({ ...CLUB, hasLegalStatus: true });
    expect(r.success).toBe(false);
    if (r.success) return;
    const e = new ValidationError("Datos de club inválidos", r.error.flatten());
    expect(e.statusCode).toBe(400);
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.details).toEqual({ formErrors: [], fieldErrors: { rut: ["El RUT es obligatorio para clubes con personalidad jurídica"] } });
  });

  it("la configuración inválida se informa por variable, con `VARIABLE: mensaje`", () => {
    const r = parseEnv({});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errores.some((m) => m.startsWith("DATABASE_URL: "))).toBe(true);
    expect(r.errores.some((m) => m.startsWith("JWT_ACCESS_SECRET: "))).toBe(true);
  });
});
