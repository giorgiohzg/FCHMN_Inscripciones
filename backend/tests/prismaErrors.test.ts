/**
 * Traducción de errores de Prisma a errores de dominio.
 *
 * Es la pieza que convierte una violación de índice —la garantía real bajo
 * concurrencia— en una respuesta que el usuario entiende.
 *
 * IMPORTANTE sobre la forma de los datos de prueba: hasta ahora este archivo
 * usaba errores sintéticos con NOMBRES DE ÍNDICE (`persons_run_unique_active`)
 * y por eso daba por buena una traducción que en la práctica no ocurría nunca.
 * Prisma no informa el nombre del índice: informa el modelo y las columnas.
 * Los `meta` de aquí abajo están copiados literalmente de los nueve conflictos
 * reales provocados contra PostgreSQL, y `prisma-conflicts.integration.test.ts`
 * vuelve a provocarlos de verdad para que esta correspondencia no pueda
 * quedarse obsoleta en silencio.
 */
import { describe, it, expect } from "vitest";
import { translatePrismaError, withTranslatedPrismaErrors, uniqueConflictKeys } from "../src/shared/prismaErrors";
import { ConflictError, NotFoundError, ValidationError } from "../src/shared/errors";

function prismaError(code: string, target?: string[] | string, modelName?: string) {
  const meta = target || modelName ? { ...(target ? { target } : {}), ...(modelName ? { modelName } : {}) } : undefined;
  return { code, meta, name: "PrismaClientKnownRequestError" };
}

describe("uniqueConflictKeys", () => {
  it("normaliza el `meta` real a `Modelo.columnas` y a `columnas`", () => {
    expect(uniqueConflictKeys({ modelName: "Category", target: ["test_type_id", "name"] })).toEqual([
      "Category.test_type_id,name",
      "test_type_id,name",
    ]);
  });

  it("sin modelo, deja solo la clave de columnas", () => {
    expect(uniqueConflictKeys({ target: ["run"] })).toEqual(["run"]);
  });

  it("acepta un `target` en texto y lo normaliza igual", () => {
    expect(uniqueConflictKeys({ target: "Test_Type_Id, Name", modelName: "Category" })).toEqual([
      "Category.test_type_id,name",
      "test_type_id,name",
    ]);
  });

  it("sin target no hay clave", () => {
    expect(uniqueConflictKeys(undefined)).toEqual([]);
    expect(uniqueConflictKeys({ target: [] })).toEqual([]);
  });
});

describe("translatePrismaError", () => {
  it("traduce P2002 de cada índice único con su mensaje propio", () => {
    // [modelo, columnas del índice, mensaje esperado] — tal como Prisma los
    // informa (ver la nota de cabecera).
    const casos: [string, string[], RegExp][] = [
      ["Registration", ["competition_event_id", "person_id"], /ya está inscrito en esta prueba/i],
      ["RelayRegistration", ["competition_event_id", "club_id", "category_id"], /ya tiene un equipo inscrito/i],
      ["ClubSwimmer", ["person_id"], /membresía activa/i],
      ["Person", ["run"], /ese RUN/i],
      ["Person", ["username"], /nombre de usuario/i],
      ["Club", ["username"], /club con ese nombre de usuario/i],
      ["Category", ["test_type_id", "name"], /categoría con ese nombre/i],
      ["Event", ["test_type_id", "distance_id", "stroke_id", "gender"], /combinación de tipo, distancia, estilo y género/i],
    ];

    for (const [modelo, columnas, mensaje] of casos) {
      const traducido = translatePrismaError(prismaError("P2002", columnas, modelo));
      expect(traducido, `falta traducción para ${modelo}.${columnas.join(",")}`).toBeInstanceOf(ConflictError);
      expect(traducido!.statusCode).toBe(409);
      expect(traducido!.message).toMatch(mensaje);
    }
  });

  it("el mismo conjunto de columnas en cada modelo recibe SU mensaje, no el del vecino", () => {
    // `username` es clave única en Person, Club y User, con tres mensajes
    // distintos: la clave incluye el modelo justamente para no confundirlos.
    expect(translatePrismaError(prismaError("P2002", ["username"], "Person"))!.message).toMatch(/persona con ese nombre de usuario/i);
    expect(translatePrismaError(prismaError("P2002", ["username"], "Club"))!.message).toMatch(/club con ese nombre de usuario/i);
    expect(translatePrismaError(prismaError("P2002", ["username"], "User"))!.message).toMatch(/cuenta de acceso/i);
  });

  it("sin `modelName` no se adivina el modelo: sale el mensaje genérico", () => {
    // Con solo `["username"]` no hay forma de saber si es de Person, Club o
    // User. Atribuirle uno cualquiera sería peor que no explicar nada.
    const traducido = translatePrismaError(prismaError("P2002", ["username"]));
    expect(traducido!.message).toBe("Ya existe un registro con esos datos.");
    expect(traducido!.statusCode).toBe(409);
  });

  it("un índice desconocido igual sale como conflicto 409, no como error interno", () => {
    const traducido = translatePrismaError(prismaError("P2002", ["algun_campo_futuro"], "ModeloFuturo"));
    expect(traducido).toBeInstanceOf(ConflictError);
    expect(traducido!.statusCode).toBe(409);
  });

  it("traduce P2003 (clave foránea) como conflicto", () => {
    expect(translatePrismaError(prismaError("P2003"))).toBeInstanceOf(ConflictError);
  });

  it("traduce P2025 como no encontrado", () => {
    expect(translatePrismaError(prismaError("P2025"))).toBeInstanceOf(NotFoundError);
  });

  it("traduce P2034 (conflicto de serialización) como 409 reintentable", () => {
    const traducido = translatePrismaError(prismaError("P2034"));
    expect(traducido).toBeInstanceOf(ConflictError);
    expect(traducido!.message).toMatch(/vuelva a intentarlo/i);
  });

  it("traduce P2014 (relación obligatoria) como conflicto", () => {
    const traducido = translatePrismaError(prismaError("P2014"));
    expect(traducido!.statusCode).toBe(409);
    expect(traducido!.message).toMatch(/vínculo obligatorio/i);
  });

  it("traduce P2000 (valor demasiado largo) como error del cliente, no del sistema", () => {
    const traducido = translatePrismaError(prismaError("P2000"));
    expect(traducido!.statusCode, "es un dato que el usuario puede corregir").toBe(400);
    expect(traducido!.message).toMatch(/largo máximo/i);
  });

  it("traduce P2011 (falta un dato obligatorio) como 400", () => {
    expect(translatePrismaError(prismaError("P2011"))!.statusCode).toBe(400);
  });

  /**
   * La base caída NO es un 500. La aplicación está bien; lo que no responde es
   * PostgreSQL. Un 503 le dice al cliente y a cualquier sonda que reintentar
   * tiene sentido; un 500 sugiere un defecto que reintentar no arregla.
   */
  it.each(["P1000", "P1001", "P1002", "P1008", "P1017"])("traduce %s (conexión) como 503 reintentable", (codigo) => {
    const traducido = translatePrismaError(prismaError(codigo));
    expect(traducido!.statusCode).toBe(503);
    expect(traducido!.code).toBe("SERVICE_UNAVAILABLE");
    expect(traducido!.message).toMatch(/no está disponible/i);
  });

  it("devuelve null para lo que no es un error conocido de Prisma", () => {
    expect(translatePrismaError(new Error("boom"))).toBeNull();
    expect(translatePrismaError(prismaError("P9999"))).toBeNull();
  });
});

describe("withTranslatedPrismaErrors", () => {
  it("devuelve el resultado cuando no hay error", async () => {
    await expect(withTranslatedPrismaErrors(async () => 42)).resolves.toBe(42);
  });

  it("aplica el mensaje propio del llamador con la clave `Modelo.columnas`", async () => {
    const propio = new ConflictError("Ya existe un grupo de categorías con ese nombre");

    await expect(
      withTranslatedPrismaErrors(
        async () => {
          throw prismaError("P2002", ["name"], "CategoryGroup");
        },
        { "CategoryGroup.name": propio }
      )
    ).rejects.toBe(propio);
  });

  it("un override para otro modelo NO se aplica", async () => {
    const ajeno = new ConflictError("mensaje de otro modelo");
    const error = await withTranslatedPrismaErrors(
      async () => {
        throw prismaError("P2002", ["name"], "SessionType");
      },
      { "CategoryGroup.name": ajeno }
    ).catch((e) => e as ConflictError);

    expect(error).not.toBe(ajeno);
    expect(error.statusCode).toBe(409);
  });

  it("deja pasar intactos los errores que no son de Prisma", async () => {
    const propio = new ValidationError("regla de negocio");
    await expect(
      withTranslatedPrismaErrors(async () => {
        throw propio;
      })
    ).rejects.toBe(propio);
  });
});

/**
 * El manejador global decide además CÓMO se registra cada error. Un 4xx es una
 * respuesta prevista y no ensucia los registros; un 5xx sí tiene que quedar
 * anotado, y hasta ahora un `AppError` de 503 —la base caída— salía sin
 * registrar ninguno, porque la rama de `AppError` devolvía siempre `log: null`.
 */
describe("registro de errores en el manejador global", () => {
  it("un AppError 4xx no se registra", async () => {
    const { resolveErrorResponse } = await import("../src/shared/httpErrorResponse");
    expect(resolveErrorResponse(new ValidationError("dato inválido")).log).toBeNull();
  });

  it("un AppError 5xx SÍ se registra como error", async () => {
    const { resolveErrorResponse } = await import("../src/shared/httpErrorResponse");
    const { ServiceUnavailableError } = await import("../src/shared/errors");

    const resuelto = resolveErrorResponse(new ServiceUnavailableError());

    expect(resuelto.status).toBe(503);
    expect(resuelto.log, "una caída de la base no puede pasar en silencio").toBe("error");
  });

  it("un P1001 crudo llega al cliente como 503 y se registra", async () => {
    const { resolveErrorResponse } = await import("../src/shared/httpErrorResponse");

    const resuelto = resolveErrorResponse({ code: "P1001", name: "PrismaClientKnownRequestError" });

    expect(resuelto.status).toBe(503);
    expect(resuelto.body.error).toBe("SERVICE_UNAVAILABLE");
    expect(resuelto.log).toBe("error");
  });
});
