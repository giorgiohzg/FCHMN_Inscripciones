/**
 * Fase 6, hallazgo 28 — ORDEN TOTAL EN TODA PAGINACIÓN POR DESPLAZAMIENTO.
 *
 * `skip`/`take` reparten filas según un orden. Si ese orden no es TOTAL —si dos
 * filas pueden empatar—, el motor decide entre ellas como quiera, y PostgreSQL no
 * promete el mismo criterio entre dos consultas. Consecuencia real: dos
 * inscripciones creadas en el mismo milisegundo salen en un orden en la página 1
 * y en el contrario en la página 2; una se repite y otra **no aparece nunca**.
 *
 * Los campos que se usaban eran todos no únicos: `fullName`, `name`,
 * `registrationStartAt`, `createdAt`, `distance.meters`, `testTypeId + minAge`.
 * Añadir `id` como último criterio cierra el orden sin cambiar el que ve el
 * usuario.
 *
 * ESTAS PRUEBAS MIRAN LOS ARGUMENTOS QUE SE LE PASAN A PRISMA. No hace falta base
 * de datos: lo que hay que fijar es la forma de la consulta, y así la regresión
 * se detecta aunque nadie tenga 200 registros con la misma fecha.
 *
 * LO QUE ESTO GARANTIZA Y LO QUE NO:
 *   - SÍ: con los datos quietos, recorrer las páginas devuelve cada fila una vez.
 *   - NO: no es una fotografía transaccional. Una inserción o un borrado durante
 *     el recorrido sigue desplazando filas, y una puede repetirse —el cliente la
 *     deduplica— o perderse. Eso exigiría paginación por cursor.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

/** Registro de lo que cada modelo recibió en `findMany`. */
const llamadas: Array<{ modelo: string; args: any }> = [];

/** Prisma de mentira: devuelve vacío y anota los argumentos. */
function modeloFalso(nombre: string) {
  return {
    findMany: vi.fn(async (args: any) => {
      llamadas.push({ modelo: nombre, args });
      return [];
    }),
    count: vi.fn(async () => 0),
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
  };
}

const prismaFalso: Record<string, any> = new Proxy(
  {},
  {
    get(destino: Record<string, any>, prop: string) {
      if (prop === "then") return undefined;
      if (!destino[prop]) destino[prop] = modeloFalso(prop);
      return destino[prop];
    },
  }
);

vi.mock("../src/shared/prisma.client", () => ({ prisma: prismaFalso }));

/** Actor de alcance `admin`: sin restricción de club (ver `actorContext.ts`). */
const ACTOR_ADMIN = {
  userId: "u-admin",
  isAdmin: true,
  scope: { kind: "admin" as const },
  canRegisterPostClose: false,
};

/** Los argumentos de `findMany` del modelo indicado, el último registrado. */
function argsDe(modelo: string) {
  const encontrado = [...llamadas].reverse().find((l) => l.modelo === modelo);
  expect(encontrado, `no se llamó a prisma.${modelo}.findMany`).toBeDefined();
  return encontrado!.args;
}

/**
 * El `orderBy` tiene que ser una LISTA cuyo último criterio sea `id`. Un objeto
 * suelto —`orderBy: { createdAt: "desc" }`— es justamente la forma que fallaba.
 */
function exigirDesempatePorId(modelo: string) {
  const { orderBy } = argsDe(modelo);
  expect(Array.isArray(orderBy), `${modelo}: el orderBy debe ser una lista de criterios`).toBe(true);
  const ultimo = orderBy[orderBy.length - 1];
  expect(Object.keys(ultimo), `${modelo}: el último criterio debe ser el id`).toEqual(["id"]);
  expect(["asc", "desc"]).toContain(ultimo.id);
  return orderBy;
}

/** Y la consulta tiene que estar paginada de verdad. */
function exigirPaginacion(modelo: string) {
  const args = argsDe(modelo);
  expect(typeof args.skip, `${modelo}: sin skip no hay paginación`).toBe("number");
  expect(typeof args.take, `${modelo}: sin take no hay paginación`).toBe("number");
}

beforeEach(() => {
  llamadas.length = 0;
});

describe("toda consulta paginada ordena con desempate por id", () => {
  it("personas: fullName y después id", async () => {
    const { listPersons } = await import("../src/modules/persons/persons.service");
    await listPersons({ page: 1, pageSize: 20 } as any);

    expect(exigirDesempatePorId("person")).toEqual([{ fullName: "asc" }, { id: "asc" }]);
    exigirPaginacion("person");
  });

  it("clubes: name y después id", async () => {
    const { listClubs } = await import("../src/modules/clubs/clubs.service");
    await listClubs({ page: 1, pageSize: 20 } as any, ACTOR_ADMIN as any);

    expect(exigirDesempatePorId("club")).toEqual([{ name: "asc" }, { id: "asc" }]);
    exigirPaginacion("club");
  });

  it("competencias: registrationStartAt y después id, con skip/take", async () => {
    /**
     * Camino NORMAL, el que pagina en la base de datos. `listCompetitions` tiene
     * además un camino que trae todo y recorta EN MEMORIA cuando se filtra por un
     * estado auto-mutable (`draft`/`scheduled` calculados al vuelo): ahí no hay
     * `skip`/`take`, pero el `slice` recorta sobre el orden de esta misma
     * consulta, así que también necesita el desempate. Ver la prueba siguiente.
     */
    const { listCompetitions } = await import("../src/modules/competitions/competitions.service");
    await listCompetitions({ page: 1, pageSize: 20 } as any);

    expect(exigirDesempatePorId("competition")).toEqual([{ registrationStartAt: "desc" }, { id: "desc" }]);
    exigirPaginacion("competition");
  });

  it("competencias, camino que pagina EN MEMORIA: mismo orden, sin skip/take", async () => {
    const { listCompetitions } = await import("../src/modules/competitions/competitions.service");
    // Ocultar borradores y programadas obliga a traer el conjunto completo.
    await listCompetitions({ page: 1, pageSize: 20 } as any, true);

    const args = argsDe("competition");
    expect(exigirDesempatePorId("competition")).toEqual([{ registrationStartAt: "desc" }, { id: "desc" }]);
    // Aquí NO hay paginación en la consulta: el recorte lo hace el `slice`.
    expect(args.skip, "este camino trae todo y recorta después").toBeUndefined();
    expect(args.take).toBeUndefined();
  });

  it("inscripciones individuales: createdAt y después id", async () => {
    const { listRegistrations } = await import("../src/modules/registrations/registrations.service");
    await listRegistrations({ page: 1, pageSize: 20 } as any, ACTOR_ADMIN as any);

    expect(exigirDesempatePorId("registration")).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    exigirPaginacion("registration");
  });

  it("relevos: createdAt y después id", async () => {
    const { listRelayRegistrations } = await import("../src/modules/relay-registrations/relay-registrations.service");
    await listRelayRegistrations({ page: 1, pageSize: 20 } as any, ACTOR_ADMIN as any);

    expect(exigirDesempatePorId("relayRegistration")).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    exigirPaginacion("relayRegistration");
  });

  it("asignaciones de nadadores: createdAt y después id", async () => {
    const { listAssignments } = await import("../src/modules/swimmer-assignment/assignment.service");
    await listAssignments({ page: 1, pageSize: 20 } as any);

    expect(exigirDesempatePorId("clubSwimmer")).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    exigirPaginacion("clubSwimmer");
  });

  it("auditoría: createdAt y después id", async () => {
    const { listAuditLogs } = await import("../src/modules/audit/audit.service");
    await listAuditLogs({ page: 1, pageSize: 20 } as any);

    expect(exigirDesempatePorId("auditLog")).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    exigirPaginacion("auditLog");
  });

  it("eventos: distancia y después id", async () => {
    const { listEvents } = await import("../src/modules/catalogs/events.service");
    await listEvents({ page: 1, pageSize: 20 } as any);

    expect(exigirDesempatePorId("event")).toEqual([{ distance: { meters: "asc" } }, { id: "asc" }]);
    exigirPaginacion("event");
  });

  it("categorías: tipo de prueba, edad mínima y después id", async () => {
    const { listCategories } = await import("../src/modules/catalogs/categories.service");
    await listCategories({ page: 1, pageSize: 20 } as any);

    expect(exigirDesempatePorId("category")).toEqual([{ testTypeId: "asc" }, { minAge: "asc" }, { id: "asc" }]);
    exigirPaginacion("category");
  });
});

describe("el orden funcional se conserva", () => {
  it("el id se añade AL FINAL, nunca por delante", async () => {
    /**
     * Poner `id` primero cambiaría lo que ve el usuario: la lista dejaría de
     * estar alfabética o cronológica y pasaría a un orden sin sentido para él.
     */
    const { listPersons } = await import("../src/modules/persons/persons.service");
    await listPersons({ page: 1, pageSize: 20 } as any);

    const orderBy = argsDe("person").orderBy;
    expect(Object.keys(orderBy[0])).toEqual(["fullName"]);
  });

  it("la dirección del desempate acompaña a la del criterio principal", async () => {
    // Con `desc` el desempate también es `desc`: si no, el orden se vuelve
    // inconsistente dentro de cada grupo de empatados.
    const { listAuditLogs } = await import("../src/modules/audit/audit.service");
    await listAuditLogs({ page: 1, pageSize: 20 } as any);

    const orderBy = argsDe("auditLog").orderBy;
    expect(orderBy[0].createdAt).toBe("desc");
    expect(orderBy[orderBy.length - 1].id).toBe("desc");
  });
});
