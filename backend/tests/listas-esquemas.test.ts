/**
 * Las 11 listas JSON de la API (SEC-01), una por una, contra su esquema REAL.
 *
 * Dos cosas por lista:
 *  1. EQUIVALENCIA: dentro del tope, el resultado es idéntico al de la definición anterior (copiada aquí
 *     tal cual estaba). Es lo que distingue un cambio ACCIDENTAL de contrato de uno intencionado.
 *  2. RECHAZO NUEVO E INTENCIONADO: sobre el tope hay un único error, con el mensaje propio, y los
 *     elementos no se validan (aunque sean inválidos).
 *
 * Todo es sintético y no toca Prisma.
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { createRelayRegistrationSchema, updateRelayRegistrationSchema } from "../src/modules/relay-registrations/relay-registrations.schemas";
import { bulkAssignSwimmersSchema } from "../src/modules/swimmer-assignment/assignment.schemas";
import { clubCreateSchema, clubUpdateSchema } from "../src/modules/clubs/clubs.schemas";
import { addCompetitionEventSchema, updateCompetitionEventSchema, reorderCompetitionEventsSchema } from "../src/modules/competitions/competitions.schemas";
import { confirmacionDeRelevosSchema, decisionDeRelevoSchema } from "../src/modules/meet-import/meet-import.schemas";
import { LIMITES_LISTAS } from "../src/shared/limites-listas";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NO_UUID = "no-es-un-uuid";

/** Resultado de UN campo de un esquema completo: sus datos si pasó, o sus mensajes si no. */
function resultadoDelCampo(esquema: z.ZodTypeAny, base: Record<string, unknown>, campo: string, valor: unknown) {
  const entrada = valor === undefined ? { ...base } : { ...base, [campo]: valor };
  const r = esquema.safeParse(entrada);
  if (r.success) return { ok: true as const, valor: (r.data as Record<string, unknown>)[campo] };
  return { ok: false as const, mensajes: (r.error.flatten().fieldErrors as Record<string, string[] | undefined>)[campo] };
}

interface CasoDeLista {
  nombre: string;
  /** El esquema real. */
  esquema: z.ZodTypeAny;
  /** Cuerpo válido sin la lista. */
  base: Record<string, unknown>;
  campo: string;
  /** La definición ANTERIOR de la lista (sin tope de longitud). */
  anterior: z.ZodTypeAny;
  tope: number;
  mensajeDelTope: string;
  /** Un elemento válido y otro inválido para esa lista. */
  valido: (n: number) => unknown;
  invalido: unknown;
  opcional: boolean;
}

const baseRelevo = { competitionEventId: uuid(900), clubId: uuid(901) };
const baseClub = {
  name: "Club Sintético",
  code: "SINT",
  hasLegalStatus: false,
  isAchmnMember: false,
  isFchmnMember: false,
  isFchmnCollaborator: false,
};
const decisionValida = (n: number) => ({ eventNumber: n, decision: "tipo", testTypeId: uuid(n) });
// `z.guid()` es el identificador que aceptaba el `.uuid()` de Zod 3 (ver `src/shared/uuid.schema.ts`): la definición «anterior» conserva esa regla.
const uuidLista = z.array(z.guid());

const CASOS: CasoDeLista[] = [
  {
    nombre: "relevo (crear) · personIds",
    esquema: createRelayRegistrationSchema,
    base: baseRelevo,
    campo: "personIds",
    anterior: uuidLista.min(2, "Un equipo de relevo debe tener más de un nadador"),
    tope: LIMITES_LISTAS.integrantesDeRelevo,
    mensajeDelTope: "Un equipo de relevo admite como máximo 8 integrantes",
    valido: uuid,
    invalido: NO_UUID,
    opcional: false,
  },
  {
    nombre: "relevo (actualizar) · personIds",
    esquema: updateRelayRegistrationSchema,
    base: {},
    campo: "personIds",
    anterior: uuidLista.min(2, "Un equipo de relevo debe tener más de un nadador").optional(),
    tope: LIMITES_LISTAS.integrantesDeRelevo,
    mensajeDelTope: "Un equipo de relevo admite como máximo 8 integrantes",
    valido: uuid,
    invalido: NO_UUID,
    opcional: true,
  },
  {
    nombre: "asignación masiva · personIds",
    esquema: bulkAssignSwimmersSchema,
    base: { targetClubId: uuid(900) },
    campo: "personIds",
    anterior: uuidLista.min(1, "Debe seleccionar al menos un nadador"),
    tope: LIMITES_LISTAS.asignacionMasiva,
    mensajeDelTope: "Se pueden asignar como máximo 10.000 nadadores por operación",
    valido: uuid,
    invalido: NO_UUID,
    opcional: false,
  },
  {
    nombre: "club (crear) · delegatePersonIds",
    esquema: clubCreateSchema,
    base: baseClub,
    campo: "delegatePersonIds",
    anterior: uuidLista.optional(),
    tope: LIMITES_LISTAS.delegadosPorClub,
    mensajeDelTope: "Un club admite como máximo 50 delegados",
    valido: uuid,
    invalido: NO_UUID,
    opcional: true,
  },
  {
    nombre: "club (crear) · coachPersonIds",
    esquema: clubCreateSchema,
    base: baseClub,
    campo: "coachPersonIds",
    anterior: uuidLista.optional(),
    tope: LIMITES_LISTAS.entrenadoresPorClub,
    mensajeDelTope: "Un club admite como máximo 50 entrenadores",
    valido: uuid,
    invalido: NO_UUID,
    opcional: true,
  },
  {
    nombre: "club (actualizar) · delegatePersonIds",
    esquema: clubUpdateSchema,
    base: { hasLegalStatus: false },
    campo: "delegatePersonIds",
    anterior: uuidLista.optional(),
    tope: LIMITES_LISTAS.delegadosPorClub,
    mensajeDelTope: "Un club admite como máximo 50 delegados",
    valido: uuid,
    invalido: NO_UUID,
    opcional: true,
  },
  {
    nombre: "club (actualizar) · coachPersonIds",
    esquema: clubUpdateSchema,
    base: { hasLegalStatus: false },
    campo: "coachPersonIds",
    anterior: uuidLista.optional(),
    tope: LIMITES_LISTAS.entrenadoresPorClub,
    mensajeDelTope: "Un club admite como máximo 50 entrenadores",
    valido: uuid,
    invalido: NO_UUID,
    opcional: true,
  },
  {
    nombre: "prueba de la competencia (agregar) · categoryIds",
    esquema: addCompetitionEventSchema,
    base: { eventId: uuid(900), competitionSessionId: uuid(901) },
    campo: "categoryIds",
    anterior: uuidLista.min(1, "Debe habilitar al menos una categoría"),
    tope: LIMITES_LISTAS.categoriasPorPrueba,
    mensajeDelTope: "Se admiten como máximo 100 categorías por prueba",
    valido: uuid,
    invalido: NO_UUID,
    opcional: false,
  },
  {
    nombre: "prueba de la competencia (actualizar) · categoryIds",
    esquema: updateCompetitionEventSchema,
    base: {},
    campo: "categoryIds",
    anterior: uuidLista.min(1).optional(),
    tope: LIMITES_LISTAS.categoriasPorPrueba,
    mensajeDelTope: "Se admiten como máximo 100 categorías por prueba",
    valido: uuid,
    invalido: NO_UUID,
    opcional: true,
  },
  {
    nombre: "reordenar pruebas · updates",
    esquema: reorderCompetitionEventsSchema,
    base: {},
    campo: "updates",
    anterior: z
      .array(z.object({ id: z.guid(), displayOrder: z.coerce.number().int() }))
      .min(1, "Debe incluir al menos una prueba a renumerar"),
    tope: LIMITES_LISTAS.reordenamientos,
    mensajeDelTope: "Se pueden renumerar como máximo 1.000 pruebas por operación",
    valido: (n) => ({ id: uuid(n), displayOrder: n }),
    invalido: { id: NO_UUID, displayOrder: "x" },
    opcional: false,
  },
  {
    nombre: "importación de Meet Events · decisiones",
    esquema: confirmacionDeRelevosSchema,
    base: { fileHash: "a".repeat(64) },
    campo: "decisiones",
    anterior: z.array(decisionDeRelevoSchema).max(500, "Demasiadas decisiones de relevo"),
    tope: LIMITES_LISTAS.decisionesDeRelevo,
    mensajeDelTope: "Demasiadas decisiones de relevo",
    valido: decisionValida,
    invalido: { eventNumber: -1, decision: "inventada" },
    opcional: false,
  },
];

describe("los topes aprobados", () => {
  it("coinciden con lo autorizado", () => {
    expect(LIMITES_LISTAS).toEqual({
      integrantesDeRelevo: 8,
      asignacionMasiva: 10_000,
      delegadosPorClub: 50,
      entrenadoresPorClub: 50,
      categoriasPorPrueba: 100,
      reordenamientos: 1_000,
      decisionesDeRelevo: 500,
    });
  });
});

describe.each(CASOS)("$nombre", (caso) => {
  const lista = (n: number) => Array.from({ length: n }, (_, i) => caso.valido(i + 1));
  const campoAntiguo = z.object({ [caso.campo]: caso.anterior });
  const antes = (valor: unknown) => resultadoDelCampo(campoAntiguo, {}, caso.campo, valor);
  const ahora = (valor: unknown) => resultadoDelCampo(caso.esquema, caso.base, caso.campo, valor);

  describe("equivalencia con la definición anterior (cambio accidental = fallo)", () => {
    const entradas: Array<[string, unknown]> = [
      ["ausente", undefined],
      ["null", null],
      ["texto", "texto"],
      ["objeto", {}],
      ["vacía", []],
      ["un elemento válido", lista(1)],
      ["dos elementos válidos", lista(2)],
      ["un elemento inválido", [caso.invalido]],
      ["válido e inválido", [caso.valido(1), caso.invalido]],
      ["dentro del tope, válida", lista(Math.min(caso.tope - 1, 7))],
      ["en el tope exacto, válida", lista(caso.tope)],
      ["en el tope exacto, toda inválida", Array.from({ length: caso.tope }, () => caso.invalido)],
    ];
    it.each(entradas)("%s", (_nombre, valor) => {
      const esperado = antes(valor);
      const obtenido = ahora(valor);
      // La definición anterior de `decisiones` ya tenía su `.max` y los esquemas completos añaden más reglas
      // al cuerpo; aquí solo se compara el campo.
      expect(obtenido).toEqual(esperado);
    });
  });

  describe("rechazo nuevo e intencionado sobre el tope", () => {
    it("tope + 1 con elementos válidos: un único error con el mensaje propio", () => {
      expect(ahora(lista(caso.tope + 1))).toEqual({ ok: false, mensajes: [caso.mensajeDelTope] });
    });

    it("tope + 1 con elementos INVÁLIDOS: sigue siendo un único error (no se validan los elementos)", () => {
      expect(ahora(Array.from({ length: caso.tope + 1 }, () => caso.invalido))).toEqual({ ok: false, mensajes: [caso.mensajeDelTope] });
    });
  });

  it(caso.opcional ? "es opcional: ausente sigue siendo válida y no aparece en los datos" : "es obligatoria: ausente se rechaza como antes", () => {
    const r = ahora(undefined);
    if (caso.opcional) {
      expect(r).toEqual({ ok: true, valor: undefined });
    } else {
      expect(r.ok).toBe(false);
    }
  });
});

describe("decisiones de relevo: la diferencia intencionada de forma", () => {
  const confirmar = (decisiones: unknown) => confirmacionDeRelevosSchema.safeParse({ fileHash: "a".repeat(64), decisiones });

  it("501 decisiones VÁLIDAS: la misma respuesta de siempre (un error, el mismo mensaje)", () => {
    const valida = Array.from({ length: 501 }, (_, i) => decisionValida(i + 1));
    const antes = z.object({ decisiones: z.array(decisionDeRelevoSchema).max(500, "Demasiadas decisiones de relevo") }).safeParse({ decisiones: valida });
    const ahora = confirmar(valida);
    expect(ahora.success).toBe(false);
    expect(antes.success).toBe(false);
    if (!ahora.success && !antes.success) expect(ahora.error.flatten().fieldErrors).toEqual(antes.error.flatten().fieldErrors);
  });

  it("501 decisiones INVÁLIDAS: un único error del tope (con Zod 3 la definición anterior traía además uno por elemento)", () => {
    const invalida = Array.from({ length: 501 }, () => ({ eventNumber: -1, decision: "inventada" }));
    const antes = z.object({ decisiones: z.array(decisionDeRelevoSchema).max(500, "Demasiadas decisiones de relevo") }).safeParse({ decisiones: invalida });
    const ahora = confirmar(invalida);
    // Con Zod 4.6.6+ (GHSA-mrhx-c7xc-m3w5) el `.max()` de la definición anterior YA rechaza antes de recorrer los elementos, así que
    // aquí también hay un solo error: es la corrección del aviso, no una propiedad de `listaAcotada`, que se conserva igualmente.
    expect(antes.success).toBe(false);
    if (!antes.success) expect(antes.error.issues).toHaveLength(1);
    expect(ahora.success).toBe(false);
    if (!ahora.success) expect(ahora.error.issues).toHaveLength(1);
  });
});
