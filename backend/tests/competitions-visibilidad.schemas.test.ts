/**
 * Cambio 6 — el contrato de entrada del campo de visibilidad y de su filtro.
 *
 * El caso que justifica la prueba: `z.coerce.boolean()` convierte CUALQUIER texto
 * no vacío —«false» incluido— en `true`. Aquí se fija que ni el filtro del listado
 * ni el cuerpo del alta y la edición lo hacen.
 */
import { describe, it, expect } from "vitest";
import { competitionCreateSchema, competitionUpdateSchema, competitionListQuerySchema } from "../src/modules/competitions/competitions.schemas";

describe("filtro del listado: visibleInRegistrationPanels", () => {
  const parse = (q: Record<string, unknown>) => competitionListQuerySchema.safeParse(q);

  it("OMITIDO: queda sin definir (el listado general no se filtra) y la paginación conserva sus valores", () => {
    const r = parse({});
    expect(r.success && r.data.visibleInRegistrationPanels).toBeUndefined();
    expect(r.success && [r.data.page, r.data.pageSize]).toEqual([1, 20]);
  });

  it("«true» -> true y «false» -> false (el texto «false» NO es verdadero)", () => {
    const verdadero = parse({ visibleInRegistrationPanels: "true" });
    const falso = parse({ visibleInRegistrationPanels: "false" });
    expect(verdadero.success && verdadero.data.visibleInRegistrationPanels).toBe(true);
    expect(falso.success && falso.data.visibleInRegistrationPanels).toBe(false);
  });

  it("cualquier otro valor se rechaza", () => {
    for (const valor of ["FALSE", "TRUE", "True", "0", "1", "si", "yes", "", " true", "null", true, false, 1, 0]) {
      expect(parse({ visibleInRegistrationPanels: valor }).success, `«${String(valor)}»`).toBe(false);
    }
  });

  it("se combina con el resto de los filtros sin alterarlos", () => {
    const r = parse({ search: " Copa ", status: "open", visibleInRegistrationPanels: "true", page: "2", pageSize: "10" });
    expect(r.success && r.data).toEqual({ search: "Copa", status: "open", visibleInRegistrationPanels: true, page: 2, pageSize: 10 });
  });
});

describe("alta y edición: visibleInRegistrationPanels", () => {
  const base = {
    name: "Copa de prueba",
    registrationStartAt: "2030-01-01T00:00:00.000Z",
    registrationEndAt: "2030-02-01T00:00:00.000Z",
    ageCutoffDate: "2030-12-31",
    maxIndividualEventsPerSwimmer: 3,
  };

  it("alta: omitido queda sin definir (el servicio lo resuelve a visible); true y false se aceptan", () => {
    const omitido = competitionCreateSchema.safeParse(base);
    expect(omitido.success && omitido.data.visibleInRegistrationPanels).toBeUndefined();
    const oculta = competitionCreateSchema.safeParse({ ...base, visibleInRegistrationPanels: false });
    expect(oculta.success && oculta.data.visibleInRegistrationPanels).toBe(false);
  });

  it("alta y edición: un texto NO se coacciona (ni «false» ni «true»)", () => {
    for (const valor of ["false", "true", "", 0, 1, null]) {
      expect(competitionCreateSchema.safeParse({ ...base, visibleInRegistrationPanels: valor }).success, `alta «${String(valor)}»`).toBe(false);
      expect(competitionUpdateSchema.safeParse({ visibleInRegistrationPanels: valor }).success, `edición «${String(valor)}»`).toBe(false);
    }
  });

  it("edición: omitido significa «no lo toques»", () => {
    const r = competitionUpdateSchema.safeParse({ name: "Otro nombre" });
    expect(r.success && "visibleInRegistrationPanels" in r.data).toBe(false);
  });
});
