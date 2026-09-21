/**
 * Matriz de autorización, probada por HTTP contra la aplicación real
 * (`app.inject`), no llamando a los servicios: es la única forma de verificar
 * que un atacante que llama directamente a la API no puede saltarse nada.
 *
 * Cubre los dos hallazgos críticos de la Fase 1:
 *   1. Cambio obligatorio de contraseña — un token de un usuario con
 *      `mustChangePassword = true` no debe servir para nada más.
 *   2. Aislamiento entre clubes — ningún usuario no administrador puede leer
 *      planteles, inscripciones, reportes ni asignaciones de otro club.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { resolvePersonClubId } from "../src/modules/auth/authorization";
import { seedRolesAndPermissions, createClub, createPerson, createUser, addClubStaff, addActiveMembership, TEST_PASSWORD } from "./helpers/seedRbac";

let app: FastifyInstance;

const ctx = {
  clubAId: "",
  clubBId: "",
  swimmerAId: "",
  swimmerBId: "",
  /** Sirve de `requestedByUserId` cuando una prueba fabrica membresías. */
  adminUserId: "",
  tokens: {} as Record<string, string>,
};

async function login(
  username: string
): Promise<{ accessToken: string; status: number; body: any; refreshCookie: string; csrf: { token: string; cookie: string } }> {
  const res = await app.inject({ method: "POST", url: "/auth/login", payload: { username, password: TEST_PASSWORD } });
  const body = res.json();
  return {
    accessToken: body.accessToken,
    status: res.statusCode,
    body,
    refreshCookie: res.statusCode === 200 ? cookieDeSesion(res) : "",
    csrf: res.statusCode === 200 ? csrfDe(res) : { token: "", cookie: "" },
  };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/**
 * El refresh token ya NO viaja en el cuerpo: va en una cookie HttpOnly. Estas
 * pruebas lo leen de la cabecera `set-cookie` porque necesitan simular lo que
 * hace el navegador —reenviar la cookie— sin poder verlo desde "JavaScript de
 * la página", que es justamente el punto del cambio.
 */
function cookieDeSesion(res: { cookies: Array<{ name: string; value: string }> }): string {
  const c = res.cookies.find((x) => x.name === "fchmn_refresh");
  if (!c) throw new Error("la respuesta no trae la cookie de sesión");
  return c.value;
}

/**
 * Cabeceras de una petición de sesión legítima.
 *
 * La comprobación CSRF se exige SIEMPRE desde la revisión de la política (antes
 * solo con `SameSite=None`), así que toda operación de sesión lleva la cookie de
 * refresco, la de CSRF y la cabecera con el mismo valor.
 */
function conCookie(valor: string, csrf?: { token: string; cookie: string }) {
  if (!csrf) return { cookie: `fchmn_refresh=${valor}` };
  return { cookie: `fchmn_refresh=${valor}; fchmn_csrf=${csrf.cookie}`, "x-csrf-token": csrf.token };
}

/** Extrae el par (token del cuerpo, valor de la cookie) de una respuesta de sesión. */
function csrfDe(res: { cookies: Array<{ name: string; value: string }>; json: () => any }) {
  return { token: res.json().csrfToken as string, cookie: res.cookies.find((c) => c.name === "fchmn_csrf")!.value };
}

beforeAll(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
  app = await buildServer();
  await app.ready();

  const clubA = await createClub("Club A", "CLBA", "club_a");
  const clubB = await createClub("Club B", "CLBB", "club_b");
  ctx.clubAId = clubA.id;
  ctx.clubBId = clubB.id;

  // Cuentas de tipo club.
  const clubAUser = await createUser({ username: "club_a", roleNames: ["club"], clubId: clubA.id });
  await createUser({ username: "club_b", roleNames: ["club"], clubId: clubB.id });

  // Administrador.
  const adminUser = await createUser({ username: "admin_test", roleNames: ["admin"] });
  ctx.adminUserId = adminUser.id;

  // Delegado del club A (persona + ClubStaff + cuenta).
  const delegateA = await createPerson({ run: "10000001", username: "deleg_a", firstName: "Delegada", gender: "female", roles: ["delegate"] });
  await addClubStaff(clubA.id, delegateA.id, "delegate");
  await createUser({ username: "deleg_a", roleNames: ["delegate"], personId: delegateA.id });

  // Representante legal del club B: por decisión de negocio tiene los mismos
  // permisos que un delegado, acotado a SU club.
  const legalRepB = await createPerson({ run: "10000002", username: "replegal_b", firstName: "Representante", gender: "male", roles: ["legal_representative"] });
  await addClubStaff(clubB.id, legalRepB.id, "legal_representative");
  await createUser({ username: "replegal_b", roleNames: ["legal_representative"], personId: legalRepB.id });

  // Nadadores con cuenta, uno por club.
  const swimmerA = await createPerson({ run: "20000001", username: "nadador_a", firstName: "Nadadora", gender: "female" });
  const swimmerB = await createPerson({ run: "20000002", username: "nadador_b", firstName: "Nadador", gender: "male" });
  ctx.swimmerAId = swimmerA.id;
  ctx.swimmerBId = swimmerB.id;
  await addActiveMembership(clubA.id, swimmerA.id, clubAUser.id);
  await addActiveMembership(clubB.id, swimmerB.id, clubAUser.id);
  await createUser({ username: "nadador_a", roleNames: ["swimmer"], personId: swimmerA.id });

  // Cuenta con cambio de contraseña PENDIENTE (rol admin a propósito: si el
  // gate no funcionara, tendría acceso a todo).
  await createUser({ username: "pendiente", roleNames: ["admin"], mustChangePassword: true });

  for (const username of ["admin_test", "club_a", "club_b", "deleg_a", "replegal_b", "nadador_a", "pendiente"]) {
    const { accessToken } = await login(username);
    ctx.tokens[username] = accessToken;
  }
});

afterAll(async () => {
  await app?.close();
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("cambio obligatorio de contraseña (hallazgo 1)", () => {
  it("el login informa que el cambio está pendiente", async () => {
    const { body } = await login("pendiente");
    expect(body.mustChangePassword).toBe(true);
  });

  it("BLOQUEA cualquier endpoint protegido aunque el token traiga permisos de admin", async () => {
    const token = ctx.tokens.pendiente!;
    const rutas = ["/persons", "/clubs", "/competitions", "/registrations", "/audit-logs", "/dashboard/stats"];

    for (const url of rutas) {
      const res = await app.inject({ method: "GET", url, headers: auth(token) });
      expect(res.statusCode, `${url} debería estar bloqueado`).toBe(403);
      expect(res.json().error).toBe("PASSWORD_CHANGE_REQUIRED");
    }
  });

  it("BLOQUEA también las escrituras directas a la API", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/clubs",
      headers: auth(ctx.tokens.pendiente!),
      payload: { name: "Club Colado", username: "colado", code: "COL", hasLegalStatus: false, email: "x@test.local" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("PERMITE ver la sesión y cambiar la contraseña, y devuelve una sesión utilizable", async () => {
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: auth(ctx.tokens.pendiente!) });
    expect(me.statusCode).toBe(200);
    expect(me.json().mustChangePassword).toBe(true);

    const cambio = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: auth(ctx.tokens.pendiente!),
      payload: { currentPassword: TEST_PASSWORD, newPassword: "NuevaClave123", confirmPassword: "NuevaClave123" },
    });
    expect(cambio.statusCode).toBe(200);

    // La sesión devuelta debe servir de inmediato: antes el backend revocaba
    // los tokens y no entregaba otros, dejando al cliente sin sesión válida.
    const nuevoToken = cambio.json().accessToken;
    const despues = await app.inject({ method: "GET", url: "/clubs", headers: auth(nuevoToken) });
    expect(despues.statusCode).toBe(200);

    // El cuerpo NO puede traer el refresh token: ese es el punto del hallazgo 27.
    expect(cambio.json(), "el refresh token no vuelve al JavaScript de la página").not.toHaveProperty("refreshToken");

    // Y la cookie de sesión que sí devuelve debe ser inmediatamente utilizable:
    // el cambio revoca las sesiones anteriores, incluida la que hizo la llamada.
    const refrescado = await app.inject({
      method: "POST",
      url: "/auth/refresh",
      headers: conCookie(cookieDeSesion(cambio), csrfDe(cambio)),
    });
    expect(refrescado.statusCode, refrescado.body).toBe(200);
  });
});

describe("aislamiento entre clubes (hallazgo 2)", () => {
  const rolesDeClubA = ["club_a", "deleg_a"];

  it("un club NO puede listar el plantel de otro club", async () => {
    for (const rol of rolesDeClubA) {
      const res = await app.inject({
        method: "GET",
        url: `/registrations/club-swimmers?clubId=${ctx.clubBId}`,
        headers: auth(ctx.tokens[rol]!),
      });
      expect(res.statusCode, `${rol} no debería ver el plantel del club B`).toBe(403);
    }
  });

  it("un club NO puede consultar la elegibilidad de un nadador de otro club", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/registrations/available-events?competitionId=00000000-0000-0000-0000-000000000000&personId=${ctx.swimmerBId}`,
      headers: auth(ctx.tokens.club_a!),
    });
    expect(res.statusCode).toBe(403);
  });

  it("un club NO puede pedir el reporte de otro club", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/reports/registrations?competitionId=00000000-0000-0000-0000-000000000000&clubId=${ctx.clubBId}`,
      headers: auth(ctx.tokens.club_a!),
    });
    expect(res.statusCode).toBe(403);
  });

  it("un club NO ve los clubes ajenos en el listado", async () => {
    const res = await app.inject({ method: "GET", url: "/clubs", headers: auth(ctx.tokens.club_a!) });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(ctx.clubAId);
  });

  it("el representante legal queda acotado a SU club, igual que un delegado", async () => {
    const propio = await app.inject({ method: "GET", url: "/clubs", headers: auth(ctx.tokens.replegal_b!) });
    expect(propio.json().items.map((c: any) => c.id)).toEqual([ctx.clubBId]);

    const ajeno = await app.inject({
      method: "GET",
      url: `/registrations/club-swimmers?clubId=${ctx.clubAId}`,
      headers: auth(ctx.tokens.replegal_b!),
    });
    expect(ajeno.statusCode).toBe(403);
  });

  it("un nadador solo se ve a sí mismo, no al resto del plantel", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/registrations/club-swimmers?clubId=${ctx.clubAId}`,
      headers: auth(ctx.tokens.nadador_a!),
    });
    expect(res.statusCode).toBe(200);
    const ids = res.json().map((s: any) => s.id);
    expect(ids).toEqual([ctx.swimmerAId]);
  });

  it("un nadador NO puede consultar la información de otro nadador", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/swimmer-assignments/current-club/${ctx.swimmerBId}`,
      headers: auth(ctx.tokens.nadador_a!),
    });
    expect(res.statusCode).toBe(403);
  });

  it("el administrador SÍ puede consultar cualquier club", async () => {
    const res = await app.inject({ method: "GET", url: "/clubs", headers: auth(ctx.tokens.admin_test!) });
    expect(res.json().items).toHaveLength(2);

    const plantel = await app.inject({
      method: "GET",
      url: `/registrations/club-swimmers?clubId=${ctx.clubBId}`,
      headers: auth(ctx.tokens.admin_test!),
    });
    expect(plantel.statusCode).toBe(200);
  });
});

describe("estado de la cuenta (hallazgo 3)", () => {
  it("un bloqueo administrativo NO se levanta solo en el siguiente login", async () => {
    const persona = await createPerson({ run: "30000001", username: "bloqueada", firstName: "Bloqueada", gender: "female" });
    const user = await createUser({ username: "bloqueada", roleNames: ["swimmer"], personId: persona.id });

    // Bloqueo administrativo: `locked` SIN `lockedUntil`.
    await prisma.user.update({ where: { id: user.id }, data: { status: "locked", lockedUntil: null } });

    const primerIntento = await login("bloqueada");
    expect(primerIntento.status).toBe(401);

    const despues = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(despues.status, "el login no debe reactivar un bloqueo administrativo").toBe("locked");
  });

  it("un bloqueo TEMPORAL vencido sí se levanta solo", async () => {
    const persona = await createPerson({ run: "30000002", username: "temporal", firstName: "Temporal", gender: "male" });
    const user = await createUser({ username: "temporal", roleNames: ["swimmer"], personId: persona.id });
    await prisma.user.update({
      where: { id: user.id },
      data: { status: "locked", lockedUntil: new Date(Date.now() - 60_000) },
    });

    const res = await login("temporal");
    expect(res.status).toBe(200);
  });

  it("un access token vigente deja de servir en cuanto la cuenta se inhabilita", async () => {
    const persona = await createPerson({ run: "30000003", username: "vigente", firstName: "Vigente", gender: "female" });
    const user = await createUser({ username: "vigente", roleNames: ["swimmer"], personId: persona.id });
    const { accessToken } = await login("vigente");

    const antes = await app.inject({ method: "GET", url: "/competitions", headers: auth(accessToken) });
    expect(antes.statusCode).toBe(200);

    await prisma.user.update({ where: { id: user.id }, data: { status: "disabled" } });

    const despues = await app.inject({ method: "GET", url: "/competitions", headers: auth(accessToken) });
    expect(despues.statusCode, "el token anterior no debe seguir funcionando").toBe(401);
  });

  it("eliminar lógicamente una persona inhabilita su cuenta y corta sus sesiones", async () => {
    const persona = await createPerson({ run: "30000004", username: "eliminada", firstName: "Eliminada", gender: "female" });
    await createUser({ username: "eliminada", roleNames: ["swimmer"], personId: persona.id });
    const { accessToken, body } = await login("eliminada");
    expect(accessToken).toBeTypeOf("string");

    const admin = ctx.tokens.admin_test!;
    const borrado = await app.inject({ method: "DELETE", url: `/persons/${persona.id}`, headers: auth(admin) });
    expect(borrado.statusCode).toBe(204);

    const conTokenViejo = await app.inject({ method: "GET", url: "/competitions", headers: auth(accessToken) });
    expect(conTokenViejo.statusCode).toBe(401);

    const conRefreshViejo = await app.inject({ method: "POST", url: "/auth/refresh", payload: { refreshToken: body.refreshToken } });
    expect(conRefreshViejo.statusCode).toBe(401);

    const nuevoLogin = await login("eliminada");
    expect(nuevoLogin.status).toBe(401);
  });
});

describe("la autorización se revalida en cada solicitud, no se lee del token", () => {
  it("retirar un ROL invalida de inmediato el access token anterior", async () => {
    const persona = await createPerson({ run: "60000001", username: "con_rol", firstName: "ConRol", gender: "female" });
    const user = await createUser({ username: "con_rol", roleNames: ["admin"], personId: persona.id });
    const { accessToken } = await login("con_rol");

    const antes = await app.inject({ method: "GET", url: "/audit-logs", headers: auth(accessToken) });
    expect(antes.statusCode, "con el rol admin debe poder ver la auditoría").toBe(200);

    // Se le retira el rol mientras su access token sigue vigente.
    await prisma.userRole.deleteMany({ where: { userId: user.id } });

    const despues = await app.inject({ method: "GET", url: "/audit-logs", headers: auth(accessToken) });
    expect(despues.statusCode, "el token anterior no debe conservar los permisos retirados").toBe(403);
  });

  it("quitar a una persona como delegado le retira el alcance del club de inmediato", async () => {
    const persona = await createPerson({ run: "60000002", username: "deleg_temp", firstName: "Delegado", gender: "male", roles: ["delegate"] });
    const staff = await addClubStaff(ctx.clubAId, persona.id, "delegate");
    await createUser({ username: "deleg_temp", roleNames: ["delegate"], personId: persona.id });
    const { accessToken } = await login("deleg_temp");

    const antes = await app.inject({ method: "GET", url: `/clubs/${ctx.clubAId}`, headers: auth(accessToken) });
    expect(antes.statusCode, "como delegado del club A debe poder ver su ficha").toBe(200);

    // El `clubId` viajaba dentro del JWT: sin revalidación, esta persona
    // seguiría operando sobre el club A durante los 15 minutos de vigencia
    // del token aunque ya no fuera su delegado.
    await prisma.clubStaff.delete({ where: { id: staff.id } });

    const despues = await app.inject({ method: "GET", url: `/clubs/${ctx.clubAId}`, headers: auth(accessToken) });
    expect(despues.statusCode, "sin el vínculo, el token anterior no debe dar acceso al club").toBe(403);
  });

  it("agregar un permiso surte efecto sin volver a iniciar sesión", async () => {
    const persona = await createPerson({ run: "60000003", username: "sube_rol", firstName: "Sube", gender: "female" });
    const user = await createUser({ username: "sube_rol", roleNames: ["swimmer"], personId: persona.id });
    const { accessToken } = await login("sube_rol");

    const antes = await app.inject({ method: "GET", url: "/audit-logs", headers: auth(accessToken) });
    expect(antes.statusCode).toBe(403);

    const adminRole = await prisma.role.findUniqueOrThrow({ where: { name: "admin" } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: adminRole.id } });

    const despues = await app.inject({ method: "GET", url: "/audit-logs", headers: auth(accessToken) });
    expect(despues.statusCode).toBe(200);
  });
});

describe("una persona representa un solo club", () => {
  it("RECHAZA nombrar representante legal a quien ya es delegado de otro club", async () => {
    const persona = await createPerson({ run: "70000001", username: "multi_club", firstName: "Multi", gender: "male", roles: ["delegate"] });
    await addClubStaff(ctx.clubAId, persona.id, "delegate");

    const res = await app.inject({
      method: "PUT",
      url: `/clubs/${ctx.clubBId}`,
      headers: auth(ctx.tokens.admin_test!),
      // El representante legal solo se procesa si el club declara
      // personalidad jurídica, y entonces el RUT es obligatorio (RB-02):
      // 11111111-1 es un RUT con dígito verificador válido.
      payload: { hasLegalStatus: true, rut: "11111111-1", legalRepresentativePersonId: persona.id },
    });

    expect(res.statusCode, "no puede ser personal de dos clubes, ni siquiera con roles distintos").toBe(400);
    expect(res.json().message).toContain("un club a la vez");
  });

  it("FALLA CERRADO si en la base ya existieran vínculos con dos clubes", async () => {
    const persona = await createPerson({ run: "70000002", username: "inconsistente", firstName: "Inconsistente", gender: "female", roles: ["delegate"] });

    /**
     * Desde `phase4_identity_guards` la BASE impide este estado, así que para
     * construirlo hay que desactivar su disparador. No es hacer trampa: la
     * comprobación de fallo cerrado sigue haciendo falta precisamente para los
     * datos que entraron ANTES de esa garantía, o por una restauración
     * parcial. Que la base lo prohíba de ahora en adelante no vuelve
     * innecesario que el código sepa reaccionar si lo encuentra.
     */
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`ALTER TABLE club_staff DISABLE TRIGGER club_staff_un_solo_club_por_persona`);
      await tx.clubStaff.create({ data: { clubId: ctx.clubAId, personId: persona.id, roleType: "delegate" } });
      await tx.clubStaff.create({ data: { clubId: ctx.clubBId, personId: persona.id, roleType: "coach" } });
      await tx.$executeRawUnsafe(`ALTER TABLE club_staff ENABLE TRIGGER club_staff_un_solo_club_por_persona`);
    });

    await expect(resolvePersonClubId(persona.id)).rejects.toThrow(/más de un club/i);
  });
});

describe("rotación de refresh tokens (hallazgo 4)", () => {
  it("dos solicitudes CONCURRENTES con el mismo refresh token: solo una tiene éxito", async () => {
    const persona = await createPerson({ run: "40000001", username: "concurrente", firstName: "Concurrente", gender: "male" });
    await createUser({ username: "concurrente", roleNames: ["swimmer"], personId: persona.id });
    const { refreshCookie, csrf } = await login("concurrente");

    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/auth/refresh", headers: conCookie(refreshCookie, csrf) }),
      app.inject({ method: "POST", url: "/auth/refresh", headers: conCookie(refreshCookie, csrf) }),
    ]);

    const exitosas = [a, b].filter((r) => r.statusCode === 200);
    expect(exitosas, "el mismo refresh token no puede canjearse dos veces").toHaveLength(1);
  });

  it("reusar un refresh token ya rotado revoca toda la sesión", async () => {
    const persona = await createPerson({ run: "40000002", username: "reuso", firstName: "Reuso", gender: "female" });
    await createUser({ username: "reuso", roleNames: ["swimmer"], personId: persona.id });
    const { refreshCookie, csrf } = await login("reuso");

    const primera = await app.inject({ method: "POST", url: "/auth/refresh", headers: conCookie(refreshCookie, csrf) });
    expect(primera.statusCode, primera.body).toBe(200);
    // La rotación llega por Set-Cookie, no en el cuerpo.
    expect(primera.json(), "el cuerpo no expone el refresh token").not.toHaveProperty("refreshToken");
    const rotado = cookieDeSesion(primera);

    const reuso = await app.inject({ method: "POST", url: "/auth/refresh", headers: conCookie(refreshCookie, csrf) });
    expect(reuso.statusCode).toBe(401);

    // El token emitido en la rotación legítima también queda revocado.
    const posterior = await app.inject({ method: "POST", url: "/auth/refresh", headers: conCookie(rotado, csrf) });
    expect(posterior.statusCode).toBe(401);
  });
});

describe("recuperación de contraseña (hallazgo 5)", () => {
  it("los endpoints de auto-recuperación ya no existen", async () => {
    const forgot = await app.inject({ method: "POST", url: "/auth/forgot-password", payload: { username: "admin_test" } });
    expect(forgot.statusCode).toBe(404);

    const reset = await app.inject({ method: "POST", url: "/auth/reset-password", payload: { token: "x", newPassword: "NuevaClave123", confirmPassword: "NuevaClave123" } });
    expect(reset.statusCode).toBe(404);
  });

  it("el restablecimiento administrativo vuelve a exigir el cambio de contraseña", async () => {
    const persona = await createPerson({ run: "50000001", username: "restablecer", firstName: "Restablecer", gender: "female" });
    await createUser({ username: "restablecer", roleNames: ["swimmer"], personId: persona.id });

    const reset = await app.inject({
      method: "POST",
      url: `/persons/${persona.id}/credentials/reset`,
      headers: auth(ctx.tokens.admin_test!),
    });
    expect(reset.statusCode).toBe(200);
    const temporal = reset.json().temporaryPassword;
    expect(temporal).toBeTypeOf("string");

    const nuevoLogin = await app.inject({ method: "POST", url: "/auth/login", payload: { username: "restablecer", password: temporal } });
    expect(nuevoLogin.statusCode).toBe(200);
    expect(nuevoLogin.json().mustChangePassword).toBe(true);

    // Y con esa sesión no puede operar hasta cambiarla.
    const bloqueado = await app.inject({ method: "GET", url: "/competitions", headers: auth(nuevoLogin.json().accessToken) });
    expect(bloqueado.statusCode).toBe(403);
  });
});

/**
 * FINALIZAR UNA MEMBRESÍA NO ES APROBARLA.
 *
 * El README declaraba que `POST /swimmer-assignments/:id/end` exigía
 * `swimmer-assignment:approve` y que solo el administrador podía usarlo. La ruta
 * exige `swimmer-assignment:write` —que tienen el club y todo su personal— y el
 * servicio la acota al club propio. La contradicción vivió sin que nada fallara
 * porque las pruebas documentales solo comparan método y ruta: no miran quién
 * puede llamarlas.
 *
 * Estas pruebas fijan el contrato real: permiso primero, alcance después.
 */
describe("finalizar una membresía: permiso y alcance por club", () => {
  /** Un nadador nuevo con membresía activa en el club indicado. */
  async function membresiaActivaEn(clubId: string, run: string, username: string) {
    const persona = await createPerson({ run, username, firstName: "Membresía", gender: "female" });
    const membresia = await addActiveMembership(clubId, persona.id, ctx.adminUserId);
    return { personaId: persona.id, membresiaId: membresia.id };
  }

  const finalizar = (id: string, token: string) =>
    app.inject({ method: "POST", url: `/swimmer-assignments/${id}/end`, headers: auth(token) });

  const estadoDe = async (id: string) =>
    (await prisma.clubSwimmer.findUniqueOrThrow({ where: { id } })).status;

  it("un nadador NO puede finalizar: le falta el permiso", async () => {
    const { membresiaId } = await membresiaActivaEn(ctx.clubAId, "90000001", "fin_nadador");

    const res = await finalizar(membresiaId, ctx.tokens.nadador_a!);

    expect(res.statusCode, "el rol `swimmer` no tiene `swimmer-assignment:write`").toBe(403);
    expect(await estadoDe(membresiaId), "la membresía sigue viva").toBe("active");
  });

  it("un club con el permiso NO puede finalizar la membresía de OTRO club", async () => {
    const { membresiaId } = await membresiaActivaEn(ctx.clubAId, "90000002", "fin_ajena_club");

    const res = await finalizar(membresiaId, ctx.tokens.club_b!);

    expect(res.statusCode, "tiene el permiso, pero no el alcance").toBe(403);
    expect(await estadoDe(membresiaId)).toBe("active");
  });

  it("el personal de otro club tampoco: el permiso no basta", async () => {
    const { membresiaId } = await membresiaActivaEn(ctx.clubAId, "90000003", "fin_ajena_staff");

    // `replegal_b` es representante legal del club B y comparte exactamente los
    // permisos de un delegado.
    const res = await finalizar(membresiaId, ctx.tokens.replegal_b!);

    expect(res.statusCode).toBe(403);
    expect(await estadoDe(membresiaId)).toBe("active");
  });

  it("el personal del MISMO club sí finaliza, sin pedirle permiso al administrador", async () => {
    const { membresiaId } = await membresiaActivaEn(ctx.clubAId, "90000004", "fin_propia_staff");

    // `deleg_a` es delegada del club A, que es el club de la membresía.
    const res = await finalizar(membresiaId, ctx.tokens.deleg_a!);

    expect(res.statusCode, `finalizar es la operación inversa de proponer; respuesta: ${res.body}`).toBe(200);
    expect(await estadoDe(membresiaId)).toBe("ended");
  });

  it("la propia cuenta del club finaliza las suyas", async () => {
    const { membresiaId } = await membresiaActivaEn(ctx.clubAId, "90000005", "fin_propia_club");

    const res = await finalizar(membresiaId, ctx.tokens.club_a!);

    expect(res.statusCode).toBe(200);
    expect(await estadoDe(membresiaId)).toBe("ended");
  });

  it("el administrador finaliza cualquiera", async () => {
    const { membresiaId } = await membresiaActivaEn(ctx.clubBId, "90000006", "fin_admin");

    const res = await finalizar(membresiaId, ctx.tokens.admin_test!);

    expect(res.statusCode).toBe(200);
    expect(await estadoDe(membresiaId)).toBe("ended");
  });

  it("aprobar y rechazar SIGUEN siendo exclusivos del administrador", async () => {
    const persona = await createPerson({ run: "90000007", username: "fin_pendiente", firstName: "Pendiente", gender: "male" });
    const pendiente = await prisma.clubSwimmer.create({
      data: { clubId: ctx.clubAId, personId: persona.id, status: "pending", requestedByUserId: ctx.adminUserId },
    });

    for (const accion of ["approve", "reject"]) {
      const res = await app.inject({
        method: "POST",
        url: `/swimmer-assignments/${pendiente.id}/${accion}`,
        headers: auth(ctx.tokens.deleg_a!),
        payload: {},
      });
      expect(res.statusCode, `${accion} exige \`swimmer-assignment:approve\``).toBe(403);
    }

    expect((await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: pendiente.id } })).status).toBe("pending");
  });
});

/**
 * DIAGNÓSTICO — el contexto que reciben `proposeAssignment` y `endAssignment`.
 *
 * Los servicios de este módulo esperan `{ isAdmin, actorClubId }`; el contexto
 * compartido de `shared/actorContext` expone `{ isAdmin, scope }` y **no** trae
 * `actorClubId`. Por eso el módulo tiene un adaptador, `assignmentActor(req)`.
 * Dos rutas no lo usaban y pasaban el contexto compartido tal cual, así que
 * `actor.actorClubId` llegaba `undefined` y la comparación
 * `actorClubId !== clubId` era verdadera SIEMPRE para un no administrador: el
 * club quedaba sin poder proponer ni finalizar en su propio plantel.
 *
 * Nada lo detectaba porque no había ninguna prueba que ejercitara esas dos
 * rutas con una cuenta de club.
 */
describe("el club opera sobre su propio plantel", () => {
  it("una cuenta de club PUEDE proponer un nadador de su club", async () => {
    const persona = await createPerson({ run: "90000011", username: "prop_club", firstName: "Propuesta", gender: "female" });

    const res = await app.inject({
      method: "POST",
      url: "/swimmer-assignments",
      headers: auth(ctx.tokens.club_a!),
      payload: { clubId: ctx.clubAId, personId: persona.id },
    });

    expect(res.statusCode, `el club propone en su propio club; respuesta: ${res.body}`).toBe(201);
    expect(res.json().status).toBe("pending");
  });

  it("pero NO en representación de otro club", async () => {
    const persona = await createPerson({ run: "90000012", username: "prop_ajena", firstName: "Ajena", gender: "female" });

    const res = await app.inject({
      method: "POST",
      url: "/swimmer-assignments",
      headers: auth(ctx.tokens.club_b!),
      payload: { clubId: ctx.clubAId, personId: persona.id },
    });

    expect(res.statusCode).toBe(403);
  });

  it("el personal del club también propone, en el club donde está nombrado", async () => {
    const persona = await createPerson({ run: "90000013", username: "prop_staff", firstName: "PorStaff", gender: "male" });

    const res = await app.inject({
      method: "POST",
      url: "/swimmer-assignments",
      headers: auth(ctx.tokens.deleg_a!),
      payload: { clubId: ctx.clubAId, personId: persona.id },
    });

    expect(res.statusCode, `respuesta: ${res.body}`).toBe(201);
  });

  it("un nadador no puede proponer: le falta el permiso", async () => {
    const persona = await createPerson({ run: "90000014", username: "prop_nadador", firstName: "PorNadador", gender: "male" });

    const res = await app.inject({
      method: "POST",
      url: "/swimmer-assignments",
      headers: auth(ctx.tokens.nadador_a!),
      payload: { clubId: ctx.clubAId, personId: persona.id },
    });

    expect(res.statusCode).toBe(403);
  });
});

/**
 * RB-06 ES UNA INVARIANTE, NO UN PARÁMETRO.
 *
 * `SWIMMER_SINGLE_CLUB_ACTIVE` vivía en `system_settings` y el servicio lo
 * consultaba antes de comprobar la regla, pero la migración crea el índice único
 * parcial `club_swimmers_unique_active_person` de forma incondicional: con el
 * parámetro en `false`, PostgreSQL seguía rechazando la segunda membresía y el
 * usuario veía un error de base de datos en vez del mensaje de negocio. El
 * parámetro se retiró; la comprobación es ahora incondicional y su valor está en
 * llegar ANTES que la base, con un mensaje entendible.
 */
describe("un nadador activo, un solo club (RB-06)", () => {
  it("la segunda membresía se rechaza con el MENSAJE DE NEGOCIO, no con un error de base", async () => {
    const persona = await createPerson({ run: "90000021", username: "un_solo_club", firstName: "Única", gender: "female" });
    await addActiveMembership(ctx.clubAId, persona.id, ctx.adminUserId);

    const res = await app.inject({
      method: "POST",
      url: "/swimmer-assignments/direct",
      headers: auth(ctx.tokens.admin_test!),
      payload: { clubId: ctx.clubBId, personId: persona.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message, "tiene que nombrar el club donde ya está").toContain("Club A");
    expect(res.json().message).toContain("membresía activa");
  });

  it("aprobar una solicitud pendiente tampoco crea la segunda", async () => {
    const persona = await createPerson({ run: "90000022", username: "un_solo_club_2", firstName: "Segunda", gender: "female" });
    await addActiveMembership(ctx.clubAId, persona.id, ctx.adminUserId);
    const pendiente = await prisma.clubSwimmer.create({
      data: { clubId: ctx.clubBId, personId: persona.id, status: "pending", requestedByUserId: ctx.adminUserId },
    });

    const res = await app.inject({
      method: "POST",
      url: `/swimmer-assignments/${pendiente.id}/approve`,
      headers: auth(ctx.tokens.admin_test!),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("membresía activa");
    expect((await prisma.clubSwimmer.findUniqueOrThrow({ where: { id: pendiente.id } })).status).toBe("pending");
  });

  it("finalizada la anterior, la nueva se acepta", async () => {
    const persona = await createPerson({ run: "90000023", username: "un_solo_club_3", firstName: "Tercera", gender: "female" });
    const anterior = await addActiveMembership(ctx.clubAId, persona.id, ctx.adminUserId);

    const fin = await app.inject({
      method: "POST",
      url: `/swimmer-assignments/${anterior.id}/end`,
      headers: auth(ctx.tokens.admin_test!),
    });
    expect(fin.statusCode).toBe(200);

    const res = await app.inject({
      method: "POST",
      url: "/swimmer-assignments/direct",
      headers: auth(ctx.tokens.admin_test!),
      payload: { clubId: ctx.clubBId, personId: persona.id },
    });

    expect(res.statusCode, `respuesta: ${res.body}`).toBe(201);
  });

  it("y el índice único sigue ahí como red de seguridad", async () => {
    const filas = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'club_swimmers' AND indexname = 'club_swimmers_unique_active_person'`
    );
    expect(filas, "la comprobación de servicio no sustituye a la garantía de la base").toHaveLength(1);
  });

  /**
   * La carrera de verdad —dos transacciones solapadas sobre el índice— vive en
   * `identity-guards-concurrency.integration.test.ts`, que es donde están las
   * conexiones independientes y la observación del bloqueo en `pg_stat_activity`.
   * Aquí quedaría como un `Promise.allSettled` que no garantiza solapamiento.
   */
});

/**
 * LOS ROLES SON DERIVADOS — regresión del flujo completo.
 *
 * La documentación afirmaba que los cuatro `person_roles` salen de relaciones
 * reales, pero el ABM de personas seguía aceptándolos en el alta, en la edición
 * y en la carga masiva. Eso permitía fabricar una delegada sin nombramiento o
 * una nadadora sin plantel, contradiciendo `club_staff` y `club_swimmers`.
 *
 * El flujo que se prueba aquí es el que estaba roto de punta a punta: crear una
 * persona (sin rol, porque ya no se puede pedir), encontrarla en la pantalla de
 * asignación masiva (que la filtraba por un rol que todavía no podía tener),
 * asignarla y comprobar que es ENTONCES cuando aparece el rol.
 */
describe("los roles de una persona se derivan de sus relaciones", () => {
  const crearPersona = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/persons", headers: auth(ctx.tokens.admin_test!), payload });

  const datosBase = (run: string, username: string) => ({
    run,
    username,
    firstName: "Derivada",
    paternalLastName: "Prueba",
    birthDate: "1990-05-05",
    gender: "female",
  });

  it("una persona recién creada NO tiene ningún rol", async () => {
    const res = await crearPersona(datosBase("91000001-2", "derivada_1"));

    expect(res.statusCode, `respuesta: ${res.body}`).toBe(201);
    const creada = res.json();
    expect(creada.roles, "el alta no otorga roles").toEqual([]);
  });

  /**
   * RECHAZO, no descarte silencioso.
   *
   * Zod elimina los campos desconocidos, así que un cliente antiguo que enviara
   * `roles` habría recibido un 201 y habría dado por hecha una operación que
   * nunca ocurrió. Eso es peor que fallar: el error queda invisible hasta que
   * alguien nota que la persona no tiene los roles que cree haberle puesto.
   */
  it("pedir roles en el alta RECHAZA la petición y no crea nada", async () => {
    const rolesAntes = await prisma.personRole.count();

    const res = await crearPersona({ ...datosBase("91000002-0", "derivada_2"), roles: ["delegate", "swimmer"] });

    expect(res.statusCode, `respuesta: ${res.body}`).toBe(400);
    expect(res.json().message + JSON.stringify(res.json().details), "dice dónde se obtiene el rol").toMatch(/plantel|ficha del club/);

    // Y no hay creación parcial: ni la persona ni ningún rol nuevo.
    expect(await prisma.person.count({ where: { username: "derivada_2" } }), "no se crea a medias").toBe(0);
    expect(await prisma.personRole.count(), "ningún rol fabricado").toBe(rolesAntes);
  });

  it("pedir roles en la edición RECHAZA la petición, sin cambios parciales", async () => {
    const creada = (await crearPersona(datosBase("91000003-9", "derivada_3"))).json();

    const res = await app.inject({
      method: "PUT",
      url: `/persons/${creada.id}`,
      headers: auth(ctx.tokens.admin_test!),
      payload: { firstName: "Derivada2", roles: ["coach"] },
    });

    expect(res.statusCode, `respuesta: ${res.body}`).toBe(400);

    // Lo que iba en la misma petición TAMPOCO se aplicó: se rechaza entera.
    const despues = await prisma.person.findUniqueOrThrow({ where: { id: creada.id } });
    expect(despues.firstName, "el nombre no se editó a medias").toBe("Derivada");
    expect(await prisma.personRole.findMany({ where: { personId: creada.id } })).toHaveLength(0);
  });

  /**
   * El agujero concreto: sin club no hay rol, y la pantalla de asignación
   * masiva filtraba por ese rol. La persona que acababa de crearse era
   * exactamente la que no podía encontrarse.
   */
  it("aparece en «Sin club» pese a no tener rol, se asigna, y ENTONCES obtiene el rol", async () => {
    const creada = (await crearPersona(datosBase("91000004-7", "derivada_4"))).json();

    const sinClub = await app.inject({
      method: "GET",
      url: "/swimmer-assignments/swimmers-by-club?clubFilter=none",
      headers: auth(ctx.tokens.admin_test!),
    });
    expect(sinClub.statusCode).toBe(200);
    expect(
      sinClub.json().map((p: { id: string }) => p.id),
      "una persona sin club tiene que ser visible en la pantalla que existe para darle uno"
    ).toContain(creada.id);

    // Se la asigna a un club.
    const asignada = await app.inject({
      method: "POST",
      url: "/swimmer-assignments/direct",
      headers: auth(ctx.tokens.admin_test!),
      payload: { clubId: ctx.clubAId, personId: creada.id },
    });
    expect(asignada.statusCode, `respuesta: ${asignada.body}`).toBe(201);

    // Y ahora sí tiene el rol, derivado de la membresía.
    const roles = await prisma.personRole.findMany({ where: { personId: creada.id, active: true } });
    expect(roles.map((r) => r.roleType), "el rol llega con la membresía, no antes").toEqual(["swimmer"]);

    // Ya no está «sin club», y sí está en el plantel de su club.
    const trasAsignar = await app.inject({
      method: "GET",
      url: "/swimmer-assignments/swimmers-by-club?clubFilter=none",
      headers: auth(ctx.tokens.admin_test!),
    });
    expect(trasAsignar.json().map((p: { id: string }) => p.id)).not.toContain(creada.id);

    const enSuClub = await app.inject({
      method: "GET",
      url: `/swimmer-assignments/swimmers-by-club?clubFilter=${ctx.clubAId}`,
      headers: auth(ctx.tokens.admin_test!),
    });
    expect(enSuClub.json().map((p: { id: string }) => p.id)).toContain(creada.id);
  });

  it("al finalizar la membresía, el rol se retira solo", async () => {
    const creada = (await crearPersona(datosBase("91000005-5", "derivada_5"))).json();
    const asignada = (
      await app.inject({
        method: "POST",
        url: "/swimmer-assignments/direct",
        headers: auth(ctx.tokens.admin_test!),
        payload: { clubId: ctx.clubAId, personId: creada.id },
      })
    ).json();

    const fin = await app.inject({
      method: "POST",
      url: `/swimmer-assignments/${asignada.id}/end`,
      headers: auth(ctx.tokens.admin_test!),
    });
    expect(fin.statusCode).toBe(200);

    const activos = await prisma.personRole.findMany({ where: { personId: creada.id, active: true } });
    expect(activos, "sin membresía no hay rol de nadador").toHaveLength(0);
  });
});

/**
 * EL REPRESENTANTE LEGAL PUEDE ENTRAR AL SISTEMA.
 *
 * `createCredentials` construía la lista de roles de acceso con `delegate`,
 * `coach` y `swimmer`, y se olvidaba del cuarto. El resultado era incoherente en
 * tres direcciones a la vez: RBAC le concede exactamente los permisos de un
 * delegado (`CLUB_STAFF_PERMISSIONS`), el mensaje de error decía que nombrarla
 * representante legal habilita el acceso, y sin embargo una persona cuyo único
 * rol fuera ese no podía obtener credenciales. Quedaba nombrada, con permisos
 * definidos, y sin puerta.
 *
 * Se recorre el camino entero, sin atajos por base de datos.
 */
describe("el representante legal obtiene credenciales y entra", () => {
  it("sin roles no puede; nombrada representante legal, sí — y con los permisos correctos", async () => {
    // 1. Persona sin ningún rol.
    const alta = await app.inject({
      method: "POST",
      url: "/persons",
      headers: auth(ctx.tokens.admin_test!),
      payload: {
        run: "91000011-K",
        username: "replegal_nueva",
        firstName: "Renata",
        paternalLastName: "Legal",
        birthDate: "1985-04-04",
        gender: "female",
      },
    });
    expect(alta.statusCode, `respuesta: ${alta.body}`).toBe(201);
    const persona = alta.json();
    expect(persona.roles).toEqual([]);

    // Sin rol no hay acceso, y el mensaje explica cómo obtenerlo.
    const sinRol = await app.inject({
      method: "POST",
      url: `/persons/${persona.id}/credentials`,
      headers: auth(ctx.tokens.admin_test!),
    });
    expect(sinRol.statusCode).toBe(400);
    expect(sinRol.json().message).toMatch(/plantel de un club|ficha del club/);

    // 2. Se la nombra ÚNICA representante legal de un club con personalidad
    //    jurídica (sin ella el nombramiento no existe).
    const club = await app.inject({
      method: "POST",
      url: "/clubs",
      headers: auth(ctx.tokens.admin_test!),
      payload: {
        name: "Club Con Personalidad",
        username: "club_personalidad",
        code: "CPJ",
        hasLegalStatus: true,
        rut: "76086428-5",
        legalName: "Club Con Personalidad Jurídica SpA",
        email: "cpj@test.local",
        legalRepresentativePersonId: persona.id,
      },
    });
    expect(club.statusCode, `respuesta: ${club.body}`).toBe(201);

    // El rol funcional se derivó del nombramiento.
    const funcionales = await prisma.personRole.findMany({ where: { personId: persona.id, active: true } });
    expect(funcionales.map((r) => r.roleType)).toEqual(["legal_representative"]);

    // 3. Y ahora sí puede tener credenciales.
    const credenciales = await app.inject({
      method: "POST",
      url: `/persons/${persona.id}/credentials`,
      headers: auth(ctx.tokens.admin_test!),
    });
    expect(credenciales.statusCode, `respuesta: ${credenciales.body}`).toBe(201);
    const temporal = credenciales.json().temporaryPassword;
    expect(temporal).toBeTypeOf("string");

    // 4. El rol de ACCESO quedó escrito.
    const cuenta = await prisma.user.findUniqueOrThrow({
      where: { personId: persona.id },
      include: { userRoles: { include: { role: true } } },
    });
    expect(
      cuenta.userRoles.map((ur) => ur.role.name),
      "el UserRole `legal_representative` tiene que existir"
    ).toEqual(["legal_representative"]);

    // 5. Y entra, con los permisos de su rol.
    const entrada = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "replegal_nueva", password: temporal },
    });
    expect(entrada.statusCode, `respuesta: ${entrada.body}`).toBe(200);
    expect(entrada.json().mustChangePassword, "primera entrada: contraseña temporal").toBe(true);

    const perfil = entrada.json().user;
    expect(perfil.roles).toEqual(["legal_representative"]);

    /**
     * Los permisos son EXACTAMENTE los del personal del club: la decisión de
     * negocio es que un representante legal tiene las mismas atribuciones que
     * un delegado, y lo que lo distingue son sus reglas de nombramiento.
     */
    const claims = JSON.parse(Buffer.from(entrada.json().accessToken.split(".")[1]!, "base64").toString());
    expect([...claims.permissions].sort()).toEqual(
      ["catalogs:read", "clubs:read", "competitions:read", "registrations:read", "registrations:write", "reports:read", "swimmer-assignment:read", "swimmer-assignment:write"].sort()
    );
    expect(claims.clubId, "y su alcance es el club donde fue nombrada").toBe(club.json().id);
  });
});
