/**
 * Fase 5, hallazgo 23 — auditoría confiable.
 *
 * Tres defectos distintos, todos reproducidos aquí:
 *
 *  1. `audit()` volcaba `params` entero al fallar, incluidos `before` y
 *     `after`. Si alguna vez se auditara una fila de `users`, el hash de la
 *     contraseña terminaría en los registros y en `audit_logs`, una tabla que
 *     la API expone a quien tenga `audit:read` y que nunca se borra.
 *  2. El cambio AUTOMÁTICO de estado de una competencia —el único que ocurre
 *     sin que nadie lo pida— no dejaba rastro. "¿Cuándo se cerró esta
 *     competencia?" no tenía respuesta, y de esa fecha depende si una
 *     inscripción fue excepción post-cierre.
 *  3. Una importación FALLIDA no dejaba rastro: su auditoría vivía dentro de
 *     la transacción que se revertía. Y una PARCIAL no decía que lo era.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import AdmZip from "adm-zip";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createUser } from "./helpers/seedRbac";
import { audit } from "../src/modules/audit/audit.service";
import * as competitionsService from "../src/modules/competitions/competitions.service";
import * as authService from "../src/modules/auth/auth.service";
import { importCompetitionFromMeetEventsZip, AVISO_DIA_EV3 } from "../src/modules/meet-import/meet-import.service";
import { TEST_PASSWORD } from "./helpers/seedRbac";

let ADMIN: { userId: string };

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  const admin = await createUser({ username: "admin_auditoria", roleNames: ["admin"] });
  ADMIN = { userId: admin.id };
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("la auditoría no guarda secretos", () => {
  it("redacta contraseñas y tokens en `before` y `after`", async () => {
    await audit({
      userId: ADMIN.userId,
      action: "PRUEBA_REDACCION",
      entityType: "User",
      entityId: ADMIN.userId,
      after: {
        username: "visible",
        passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$SECRETO",
        tokenHash: "abc123",
        temporaryPassword: "Clave123",
        anidado: { refreshToken: "rt_secreto", conservado: 42 },
      },
    });

    const fila = await prisma.auditLog.findFirstOrThrow({ where: { action: "PRUEBA_REDACCION" } });
    const after = fila.after as Record<string, unknown>;

    expect(after.username, "lo que no es secreto se conserva").toBe("visible");
    expect(after.passwordHash).toBe("[redactado]");
    expect(after.tokenHash).toBe("[redactado]");
    expect(after.temporaryPassword).toBe("[redactado]");
    expect((after.anidado as Record<string, unknown>).refreshToken, "también en profundidad").toBe("[redactado]");
    expect((after.anidado as Record<string, unknown>).conservado).toBe(42);

    // Y no queda rastro del valor original en ninguna parte de la fila.
    expect(JSON.stringify(fila)).not.toContain("SECRETO");
    expect(JSON.stringify(fila)).not.toContain("Clave123");
  });

  /**
   * El recorrido corta a los ocho niveles. Antes, al llegar a ese límite
   * DEVOLVÍA el subárbol intacto: bastaba con que el secreto estuviera un poco
   * más abajo para que se guardara tal cual. El límite existía para no recorrer
   * estructuras hondas, y terminaba siendo la forma de saltarse la redacción.
   */
  it("no deja pasar un secreto por estar más allá de la profundidad máxima", async () => {
    // 12 niveles de anidamiento, con los secretos al fondo.
    let nodo: Record<string, unknown> = { passwordHash: "SECRETO_PROFUNDO", token: "TOKEN_PROFUNDO" };
    for (let i = 0; i < 12; i++) nodo = { nivel: i, hijo: nodo };

    await audit({ userId: ADMIN.userId, action: "PRUEBA_PROFUNDIDAD", entityType: "User", after: nodo });

    const fila = await prisma.auditLog.findFirstOrThrow({ where: { action: "PRUEBA_PROFUNDIDAD" } });
    const serializada = JSON.stringify(fila);

    expect(serializada, "el valor original no puede aparecer en la fila").not.toContain("SECRETO_PROFUNDO");
    expect(serializada).not.toContain("TOKEN_PROFUNDO");
    expect(serializada, "el subárbol se corta explícitamente, no en silencio").toContain("[omitido: demasiado profundo]");
  });

  it("una referencia circular se corta en vez de agotar la pila", async () => {
    const nodo: Record<string, unknown> = { nombre: "raíz", passwordHash: "SECRETO_CICLICO" };
    nodo.self = nodo;

    // Sin detección de ciclos esto no lanzaba un error de auditoría: reventaba
    // la pila y se llevaba puesta la operación entera.
    await audit({ userId: ADMIN.userId, action: "PRUEBA_CICLO", entityType: "User", after: nodo });

    const fila = await prisma.auditLog.findFirstOrThrow({ where: { action: "PRUEBA_CICLO" } });
    expect(JSON.stringify(fila)).not.toContain("SECRETO_CICLICO");
    expect(JSON.stringify(fila.after)).toContain("[omitido: referencia circular]");
  });

  it("redacta también dentro de listas", async () => {
    await audit({
      userId: ADMIN.userId,
      action: "PRUEBA_REDACCION_LISTA",
      entityType: "User",
      after: { cuentas: [{ username: "a", passwordHash: "SECRETO_1" }, { username: "b", token: "SECRETO_2" }] },
    });

    const fila = await prisma.auditLog.findFirstOrThrow({ where: { action: "PRUEBA_REDACCION_LISTA" } });
    expect(JSON.stringify(fila.after)).not.toContain("SECRETO");
  });
});

describe("una auditoría perdida avisa de forma estructurada", () => {
  it("emite un evento `audit_write_failed` con los datos de la operación, sin el contenido", async () => {
    const consola = vi.spyOn(console, "error").mockImplementation(() => void 0);
    try {
      // `userId` inexistente: la clave foránea de `audit_logs` lo rechaza.
      await audit({
        userId: "00000000-0000-0000-0000-000000000999",
        action: "ACCION_PERDIDA",
        entityType: "Competition",
        entityId: "abc",
        after: { passwordHash: "SECRETO", detalle: "contenido" },
      });

      expect(consola, "un fallo best-effort no puede pasar en silencio").toHaveBeenCalledTimes(1);
      const linea = consola.mock.calls[0]![0] as string;
      const evento = JSON.parse(linea);

      expect(evento.event, "nombre estable, para poder alertar sobre él").toBe("audit_write_failed");
      expect(evento.action).toBe("ACCION_PERDIDA");
      expect(evento.entityType).toBe("Competition");
      expect(evento.entityId).toBe("abc");
      expect(evento.errorCode).toBe("P2003");
      expect(evento.errorName, "clase del error, no su mensaje").toBe("PrismaClientKnownRequestError");

      // El aviso identifica la operación perdida, no vuelca su contenido ni el
      // mensaje del motor —que trae la consulta y sus valores—.
      expect(linea).not.toContain("SECRETO");
      expect(linea).not.toContain("contenido");
      expect(linea, "el mensaje crudo del error no puede llegar a los registros").not.toContain("audit_logs_user_id_fkey");
    } finally {
      consola.mockRestore();
    }
  });

  it("dentro de una transacción NO se traga el error: lanza", async () => {
    await expect(
      prisma.$transaction(async (tx) =>
        audit({ userId: "00000000-0000-0000-0000-000000000999", action: "X", entityType: "Y" }, { tx })
      )
    ).rejects.toThrow();
  });
});

describe("el cambio automático de estado deja rastro", () => {
  async function competenciaQueYaDebioAbrirse() {
    // Se crea con fechas futuras (el servicio exige fin > inicio y valida el
    // rango) y después se retrocede la fecha de inicio directamente en la
    // base, que es lo que hace el paso del tiempo en producción.
    const c = await competitionsService.createCompetition(
      {
        name: "Competencia Automática",
        registrationStartAt: new Date(Date.now() + 86_400_000),
        registrationEndAt: new Date(Date.now() + 172_800_000),
        ageCutoffDate: new Date(),
        maxIndividualEventsPerSwimmer: 5,
        maxRelayEventsPerSwimmerPerSession: 1,
      },
      ADMIN
    );
    await competitionsService.transitionCompetition(c.id, "schedule", ADMIN);
    await prisma.competition.update({
      where: { id: c.id },
      data: { registrationStartAt: new Date(Date.now() - 86_400_000) },
    });
    return c.id;
  }

  it("pasar sola de programada a abierta se registra con el estado anterior y el nuevo", async () => {
    const id = await competenciaQueYaDebioAbrirse();

    const leida = await competitionsService.getCompetitionById(id);
    expect(leida.status, "el auto-cómputo debe haberla abierto").toBe("open");

    const registro = await prisma.auditLog.findFirstOrThrow({
      where: { action: "COMPETITION_STATUS_AUTO_CHANGED", entityId: id },
    });
    expect((registro.before as Record<string, unknown>).status).toBe("scheduled");
    expect((registro.after as Record<string, unknown>).status).toBe("open");
    expect(registro.userId, "no hay actor: lo hizo el paso del tiempo").toBeNull();
  });

  it("no se registra nada cuando el estado no cambia", async () => {
    const id = await competenciaQueYaDebioAbrirse();
    await competitionsService.getCompetitionById(id);
    const primera = await prisma.auditLog.count({ where: { action: "COMPETITION_STATUS_AUTO_CHANGED" } });

    // Segunda lectura: el estado ya está al día.
    await competitionsService.getCompetitionById(id);

    expect(await prisma.auditLog.count({ where: { action: "COMPETITION_STATUS_AUTO_CHANGED" } })).toBe(primera);
  });

  it("el cambio y su registro son atómicos: si no se puede auditar, el estado no cambia", async () => {
    const id = await competenciaQueYaDebioAbrirse();

    // Se rompe la escritura de auditoría cambiando la clave foránea por una
    // que ninguna fila satisface.
    await prisma.$executeRawUnsafe(`ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_prueba CHECK (action <> 'COMPETITION_STATUS_AUTO_CHANGED')`);
    try {
      await expect(competitionsService.getCompetitionById(id)).rejects.toThrow();

      const sinCambiar = await prisma.competition.findUniqueOrThrow({ where: { id } });
      expect(sinCambiar.status, "sin rastro no hay cambio de estado").toBe("scheduled");
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_prueba`);
    }
  });
});

describe("la revocación de sesión deja rastro", () => {
  it("cerrar sesión registra LOGOUT con el usuario dueño del token", async () => {
    const usuario = await createUser({ username: "cierra_sesion", roleNames: ["admin"] });
    const sesion = await authService.login({ username: "cierra_sesion", password: TEST_PASSWORD }, {});

    await authService.logout(sesion.refreshToken, { ipAddress: "10.0.0.1" });

    const registro = await prisma.auditLog.findFirstOrThrow({ where: { action: "LOGOUT" } });
    expect(registro.userId, "el registro identifica a quien cerró sesión").toBe(usuario.id);
    expect(registro.ipAddress).toBe("10.0.0.1");

    /**
     * `entityType` dice "RefreshToken", así que `entityId` tiene que ser el ID
     * del token, no el del usuario. Antes eran el mismo valor: un registro que
     * decía referirse a una entidad y apuntaba a otra, inútil para saber CUÁL
     * de varias sesiones abiertas se cerró.
     */
    const token = await prisma.refreshToken.findFirstOrThrow({ where: { userId: usuario.id } });
    expect(registro.entityType).toBe("RefreshToken");
    expect(registro.entityId, "identifica la sesión concreta que se revocó").toBe(token.id);
    expect(registro.entityId).not.toBe(usuario.id);
  });

  it("con dos sesiones abiertas, el registro apunta a la que se cerró", async () => {
    const usuario = await createUser({ username: "dos_sesiones", roleNames: ["admin"] });
    const primera = await authService.login({ username: "dos_sesiones", password: TEST_PASSWORD }, {});
    const segunda = await authService.login({ username: "dos_sesiones", password: TEST_PASSWORD }, {});
    expect(primera.refreshToken).not.toBe(segunda.refreshToken);

    await authService.logout(segunda.refreshToken);

    const registro = await prisma.auditLog.findFirstOrThrow({ where: { action: "LOGOUT" } });
    const revocado = await prisma.refreshToken.findFirstOrThrow({ where: { userId: usuario.id, revokedAt: { not: null } } });
    const vigente = await prisma.refreshToken.findFirstOrThrow({ where: { userId: usuario.id, revokedAt: null } });

    expect(registro.entityId, "el token revocado, no el que sigue vivo").toBe(revocado.id);
    expect(registro.entityId).not.toBe(vigente.id);
  });

  it("repetir el logout con un token ya revocado no agrega registros", async () => {
    await createUser({ username: "cierra_dos_veces", roleNames: ["admin"] });
    const sesion = await authService.login({ username: "cierra_dos_veces", password: TEST_PASSWORD }, {});

    await authService.logout(sesion.refreshToken);
    await authService.logout(sesion.refreshToken);

    expect(await prisma.auditLog.count({ where: { action: "LOGOUT" } })).toBe(1);
  });
});

describe("las importaciones fallidas y parciales dejan rastro", () => {
  const ENCABEZADO = "Copa de Prueba;Club Org;03/28/2026;03/28/2026;12/31/2026;S;0;290;0;Created by Hy-Tek's MEET MANAGER;Chile;8.0Gc;02/06";
  const LINEA = "1;1;F;1;I;W;0;109;50;A;0;;;N;0;;;;;;;1;1;1;09:45AM;S;4;3;1;0*>";

  function zip(lineas: string[]): Buffer {
    return zipCon(ENCABEZADO, lineas);
  }

  /** Igual que `zip`, pero con un encabezado propio (fechas alteradas). */
  function zipCon(encabezado: string, lineas: string[]): Buffer {
    const z = new AdmZip();
    z.addFile("Meet Events-Copa.ev3", Buffer.from([encabezado, ...lineas].join("\r\n"), "latin1"));
    return z.toBuffer();
  }

  /** Registros de intento fallido acumulados hasta ahora. */
  const fallidos = () => prisma.auditLog.findMany({ where: { action: "COMPETITION_IMPORT_FAILED" } });

  it("ZIP inválido: falla ANTES del parseo y aun así queda registrado", async () => {
    await expect(
      importCompetitionFromMeetEventsZip(Buffer.from("esto no es un zip"), { maxIndividualEventsPerSwimmer: 5 }, ADMIN)
    ).rejects.toThrow();

    const registros = await fallidos();
    expect(registros, "exactamente un registro por intento").toHaveLength(1);
    const after = registros[0]!.after as Record<string, unknown>;
    expect(after.etapa).toBe("lectura-del-zip");
    // El archivo nunca se interpretó: no hay metadatos que anotar.
    expect(after.competitionName).toBeNull();
    expect(after.eventCount).toBeNull();
  });

  it("ZIP sin archivo .ev3: mismo caso, con su etapa", async () => {
    const z = new AdmZip();
    z.addFile("otra-cosa.txt", Buffer.from("x"));

    await expect(importCompetitionFromMeetEventsZip(z.toBuffer(), { maxIndividualEventsPerSwimmer: 5 }, ADMIN)).rejects.toThrow(
      /no contiene ningún archivo \.ev3/i
    );

    const registros = await fallidos();
    expect(registros).toHaveLength(1);
    expect((registros[0]!.after as Record<string, unknown>).etapa).toBe("lectura-del-zip");
  });

  it("encabezado ilegible: falla EN el parseo", async () => {
    const z = new AdmZip();
    z.addFile("Meet Events.ev3", Buffer.from("encabezado;sin;fechas;validas", "latin1"));

    await expect(importCompetitionFromMeetEventsZip(z.toBuffer(), { maxIndividualEventsPerSwimmer: 5 }, ADMIN)).rejects.toThrow();

    const registros = await fallidos();
    expect(registros).toHaveLength(1);
    expect((registros[0]!.after as Record<string, unknown>).etapa).toBe("interpretacion-del-archivo");
  });

  it("cero pruebas válidas: falla en la VALIDACIÓN, ya con metadatos del archivo", async () => {
    await expect(importCompetitionFromMeetEventsZip(zip([]), { maxIndividualEventsPerSwimmer: 5 }, ADMIN)).rejects.toThrow(
      /ninguna prueba válida/i
    );

    const registros = await fallidos();
    expect(registros).toHaveLength(1);
    const after = registros[0]!.after as Record<string, unknown>;
    expect(after.etapa).toBe("validacion");
    expect(after.competitionName, "el archivo sí se interpretó").toBe("Copa de Prueba");
    expect(after.eventCount).toBe(0);
  });

  it("fechas invertidas: validación anterior a la transacción", async () => {
    const encabezado = "Copa Invertida;Club Org;03/30/2026;03/28/2026;12/31/2026;S;0;290;0;x;Chile;8.0Gc;02/06";

    await expect(
      importCompetitionFromMeetEventsZip(zipCon(encabezado, [LINEA]), { maxIndividualEventsPerSwimmer: 5 }, ADMIN)
    ).rejects.toThrow(/anterior a la de inicio/i);

    const registros = await fallidos();
    expect(registros).toHaveLength(1);
    const after = registros[0]!.after as Record<string, unknown>;
    expect(after.etapa).toBe("validacion");
    expect(String(after.reason)).toMatch(/anterior a la de inicio/i);
  });

  /**
   * Una competencia de varios días YA NO es un fallo.
   *
   * Antes se rechazaba porque el `.ev3` no dice en qué día se nada cada
   * prueba, y esa negativa quedaba registrada como intento fallido. Ahora se
   * importa con todas las pruebas en el primer día y un aviso que pide
   * moverlas, así que no hay nada que registrar como fallo.
   *
   * Lo que esta prueba conserva es justamente eso: que el registro de
   * intentos fallidos NO se dispare por algo que ya no falla.
   */
  it("competencia de varios días: ya no es un fallo y no deja registro de intento fallido", async () => {
    // Solo hacen falta los tipos de prueba: distancias, estilos y tipos de
    // jornada los crea la propia importación si no existen.
    await conCatalogoDePruebas();
    const encabezado = "Copa Larga;Club Org;03/28/2026;03/30/2026;12/31/2026;S;0;290;0;x;Chile;8.0Gc;02/06";

    const resumen = await importCompetitionFromMeetEventsZip(zipCon(encabezado, [LINEA]), { maxIndividualEventsPerSwimmer: 5 }, ADMIN);

    expect(resumen.eventsImported).toBe(1);
    // El aviso dice que el importador no puede atribuir el día con certeza, no
    // que el archivo no traiga la información: un `.ev3` real de varios días
    // SÍ la trae, en campos que todavía no se pueden distinguir entre sí.
    expect(resumen.warnings).toContain(AVISO_DIA_EV3);
    expect(await fallidos(), "una importación que prospera no deja intento fallido").toHaveLength(0);
  });

  /** El texto de un error interno tal como podría venir de Prisma o del SO. */
  const ERROR_INTERNO = "SELECT * FROM users WHERE token='SECRETO_INTERNO' -- /srv/app/ruta";

  async function conCatalogoDePruebas() {
    await prisma.testType.upsert({ where: { name: "Individual" }, update: {}, create: { name: "Individual", swimmersCount: 1 } });
    await prisma.testType.upsert({ where: { name: "Relevo" }, update: {}, create: { name: "Relevo", swimmersCount: 4 } });
  }

  it("un error INESPERADO dentro de la transacción no filtra su mensaje ni al cliente ni al registro", async () => {
    await conCatalogoDePruebas();

    const competitionEvents = await import("../src/modules/competitions/competition-events.service");
    const spy = vi.spyOn(competitionEvents, "addCompetitionEvent").mockRejectedValue(new Error(ERROR_INTERNO));

    try {
      const error = await importCompetitionFromMeetEventsZip(zip([LINEA]), { maxIndividualEventsPerSwimmer: 5 }, ADMIN)
        .then(() => null)
        .catch((e) => e as Error);

      /**
       * El mensaje que llega al cliente es el de dominio —"ninguna prueba se
       * pudo importar"—, que este servicio escribió para que se lea. Lo que NO
       * puede traer es el texto del error interno que lo provocó: el detalle
       * por prueba se construía concatenando `err.message`, así que la consulta
       * y las rutas del servidor viajaban dentro de un mensaje de dominio.
       */
      expect(error!.message).toMatch(/No se pudo importar ninguna de las 1 pruebas/);
      expect(error!.message, "la consulta interna no puede llegar al cliente").not.toContain("SECRETO_INTERNO");
      expect(error!.message).not.toContain("/srv/app");
      expect(error!.message, "en su lugar, la clase del error").toMatch(/error interno \(Error\)/);

      // Al registro: lo mismo, y por la misma vía.
      const registros = await fallidos();
      expect(registros).toHaveLength(1);
      const after = registros[0]!.after as Record<string, unknown>;
      expect(after.etapa).toBe("escritura");
      expect(JSON.stringify(after), "tampoco queda guardado en audit_logs").not.toContain("SECRETO_INTERNO");
      expect(JSON.stringify(after)).not.toContain("/srv/app");
    } finally {
      spy.mockRestore();
    }
  });

  it("en una importación PARCIAL, el aviso tampoco filtra el error interno", async () => {
    await conCatalogoDePruebas();

    const competitionEvents = await import("../src/modules/competitions/competition-events.service");
    const spy = vi.spyOn(competitionEvents, "addCompetitionEvent");
    spy.mockRejectedValueOnce(new Error(ERROR_INTERNO));

    try {
      const segunda = "2;1;F;1;I;M;0;109;100;A;0;;;N;0;;;;;;;1;1;1;09:45AM;S;4;3;1;0*>";
      // Aquí la importación tiene ÉXITO: los avisos se devuelven al cliente y
      // se guardan en `skippedDetail`, así que es la tercera vía de salida del
      // mismo texto.
      const resumen = await importCompetitionFromMeetEventsZip(zip([LINEA, segunda]), { maxIndividualEventsPerSwimmer: 5 }, ADMIN);

      expect(resumen.eventsSkipped).toBe(1);
      expect(JSON.stringify(resumen.warnings)).not.toContain("SECRETO_INTERNO");
      expect(JSON.stringify(resumen.warnings)).not.toContain("/srv/app");

      const registro = await prisma.auditLog.findFirstOrThrow({ where: { action: "COMPETITION_IMPORTED_FROM_MEET_EVENTS" } });
      expect(JSON.stringify(registro.after)).not.toContain("SECRETO_INTERNO");
      expect(String((registro.after as Record<string, unknown>).skippedDetail)).toMatch(/error interno \(Error\)/);
    } finally {
      spy.mockRestore();
    }
  });

  it("una importación que falla queda registrada aunque la transacción se revierta", async () => {
    // Sin tipos de prueba en el catálogo, la importación falla después de
    // haber creado la competencia dentro de la transacción.
    await prisma.testType.deleteMany();

    await expect(
      importCompetitionFromMeetEventsZip(zip([LINEA]), { maxIndividualEventsPerSwimmer: 5 }, ADMIN)
    ).rejects.toThrow();

    // Nada se creó...
    expect(await prisma.competition.count()).toBe(0);
    // ...pero el intento sí quedó anotado, UNA sola vez.
    const registros = await fallidos();
    expect(registros, "exactamente un registro por intento fallido").toHaveLength(1);
    const registro = registros[0]!;
    const after = registro.after as Record<string, unknown>;
    expect(registro.userId).toBe(ADMIN.userId);
    expect(after.etapa, "el fallo ocurrió ya dentro de la escritura").toBe("escritura");
    expect(after.competitionName).toBe("Copa de Prueba");
    expect(after.eventCount).toBe(1);
    // El archivo trae una prueba individual, así que lo que falta —y se
    // nombra— es ese tipo. La ausencia de tipos de RELEVO tiene su propio
    // mensaje y solo se comprueba cuando el archivo trae relevos.
    expect(String(after.reason)).toMatch(/tipo de prueba Individual/i);
    expect(after.fase, "el fallo ocurrió importando, no analizando").toBe("importacion");
  });

  it("una importación parcial se registra COMO parcial, con el detalle de lo que quedó fuera", async () => {
    await prisma.testType.upsert({ where: { name: "Individual" }, update: {}, create: { name: "Individual", swimmersCount: 1 } });
    await prisma.testType.upsert({ where: { name: "Relevo" }, update: {}, create: { name: "Relevo", swimmersCount: 4 } });

    const competitionEvents = await import("../src/modules/competitions/competition-events.service");
    const { ValidationError } = await import("../src/shared/errors");
    const spy = vi.spyOn(competitionEvents, "addCompetitionEvent");
    spy.mockRejectedValueOnce(new ValidationError("fallo simulado en la primera prueba"));

    try {
      const segunda = "2;1;F;1;I;M;0;109;100;A;0;;;N;0;;;;;;;1;1;1;09:45AM;S;4;3;1;0*>";
      const resumen = await importCompetitionFromMeetEventsZip(zip([LINEA, segunda]), { maxIndividualEventsPerSwimmer: 5 }, ADMIN);
      expect(resumen.eventsSkipped).toBe(1);

      const registro = await prisma.auditLog.findFirstOrThrow({ where: { action: "COMPETITION_IMPORTED_FROM_MEET_EVENTS" } });
      const after = registro.after as Record<string, unknown>;
      expect(after.partial, "el registro debe decir que nació incompleta").toBe(true);
      expect(after.eventsImported).toBe(1);
      expect(after.eventsSkipped).toBe(1);
      expect(String((after.skippedDetail as string[])[0])).toMatch(/fallo simulado/);
    } finally {
      spy.mockRestore();
    }
  });

  it("una importación completa se registra como NO parcial", async () => {
    await prisma.testType.upsert({ where: { name: "Individual" }, update: {}, create: { name: "Individual", swimmersCount: 1 } });
    await prisma.testType.upsert({ where: { name: "Relevo" }, update: {}, create: { name: "Relevo", swimmersCount: 4 } });

    await importCompetitionFromMeetEventsZip(zip([LINEA]), { maxIndividualEventsPerSwimmer: 5 }, ADMIN);

    const registro = await prisma.auditLog.findFirstOrThrow({ where: { action: "COMPETITION_IMPORTED_FROM_MEET_EVENTS" } });
    expect((registro.after as Record<string, unknown>).partial).toBe(false);
  });
});
