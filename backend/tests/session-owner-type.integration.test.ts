/**
 * `OwnerType.system` en los contratos de sesión (hallazgo 20, cierre).
 *
 * El defecto: `AccessTokenPayload` y `AuthorizationState` declaraban
 * `ownerType: "person" | "club"`, y `auth.service` metía el valor real con un
 * cast `as "person" | "club"`. La cuenta del administrador —que no tiene
 * persona ni club— viajaba en el token afirmando ser de tipo `person`: el
 * token decía algo falso sobre su propio dueño, y el compilador no podía
 * advertirlo porque el cast le quitaba la información.
 *
 * Estas pruebas DECODIFICAN los tokens realmente emitidos por los tres
 * caminos que los producen —login, refresh y cambio de contraseña— en vez de
 * comprobar solo el objeto `user` de la respuesta.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { seedRolesAndPermissions, createClub, createPerson, createUser, TEST_PASSWORD } from "./helpers/seedRbac";
import * as authService from "../src/modules/auth/auth.service";
import { verifyAccessToken } from "../src/modules/auth/jwt.util";
import { loadAuthorizationState } from "../src/modules/auth/authorization";

const CTX = { ipAddress: "127.0.0.1" };

beforeEach(async () => {
  await truncateAllTables(prisma);
  await seedRolesAndPermissions();
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

async function iniciarSesion(username: string) {
  const sesion = await authService.login({ username, password: TEST_PASSWORD }, CTX);
  return { sesion, payload: verifyAccessToken(sesion.accessToken) };
}

describe("el token refleja el tipo de dueño REAL de la cuenta", () => {
  it("login de un administrador emite un token `system`, sin persona ni club", async () => {
    await createUser({ username: "admin_sesion", roleNames: ["admin"] });

    const { sesion, payload } = await iniciarSesion("admin_sesion");

    expect(payload.ownerType, "antes viajaba como `person` por un cast").toBe("system");
    expect(payload.personId).toBeNull();
    expect(payload.clubId).toBeNull();
    expect(sesion.user.ownerType).toBe("system");
  });

  it("login de una cuenta de persona emite `person` con su club efectivo", async () => {
    const club = await createClub("Club Norte", "CN");
    const persona = await createPerson({ run: "10000001", username: "deleg", firstName: "Delia", gender: "female", roles: ["delegate"] });
    await prisma.clubStaff.create({ data: { clubId: club.id, personId: persona.id, roleType: "delegate" } });
    await createUser({ username: "deleg", roleNames: ["delegate"], personId: persona.id });

    const { payload } = await iniciarSesion("deleg");

    expect(payload.ownerType).toBe("person");
    expect(payload.personId).toBe(persona.id);
    expect(payload.clubId, "el club se deriva de su vínculo como personal").toBe(club.id);
  });

  it("login de una cuenta de club emite `club`", async () => {
    const club = await createClub("Club Sur", "CS");
    await createUser({ username: "club_cs", roleNames: ["club"], clubId: club.id });

    const { payload } = await iniciarSesion("club_cs");

    expect(payload.ownerType).toBe("club");
    expect(payload.clubId).toBe(club.id);
    expect(payload.personId).toBeNull();
  });
});

describe("el tipo de dueño sobrevive a la rotación de la sesión", () => {
  it("refresh conserva `system` en el token nuevo", async () => {
    await createUser({ username: "admin_sesion", roleNames: ["admin"] });
    const { sesion } = await iniciarSesion("admin_sesion");

    const rotada = await authService.refresh(sesion.refreshToken, CTX);

    expect(verifyAccessToken(rotada.accessToken).ownerType).toBe("system");
  });

  it("refresh conserva `club` en el token nuevo", async () => {
    const club = await createClub("Club Sur", "CS");
    await createUser({ username: "club_cs", roleNames: ["club"], clubId: club.id });
    const { sesion } = await iniciarSesion("club_cs");

    const rotada = await authService.refresh(sesion.refreshToken, CTX);
    const payload = verifyAccessToken(rotada.accessToken);

    expect(payload.ownerType).toBe("club");
    expect(payload.clubId).toBe(club.id);
  });

  it("changePassword emite una sesión nueva con el mismo tipo de dueño", async () => {
    const usuario = await createUser({ username: "admin_sesion", roleNames: ["admin"], mustChangePassword: true });

    const resultado = await authService.changePassword(
      usuario.id,
      { currentPassword: TEST_PASSWORD, newPassword: "OtraClaveValida456", confirmPassword: "OtraClaveValida456" },
      CTX
    );

    expect(verifyAccessToken(resultado.accessToken).ownerType).toBe("system");
  });

  it("changePassword de una cuenta de persona conserva `person` y su club", async () => {
    const club = await createClub("Club Norte", "CN");
    const persona = await createPerson({ run: "10000002", username: "coach1", firstName: "Carla", gender: "female", roles: ["coach"] });
    await prisma.clubStaff.create({ data: { clubId: club.id, personId: persona.id, roleType: "coach" } });
    const usuario = await createUser({ username: "coach1", roleNames: ["coach"], personId: persona.id, mustChangePassword: true });

    const resultado = await authService.changePassword(
      usuario.id,
      { currentPassword: TEST_PASSWORD, newPassword: "OtraClaveValida456", confirmPassword: "OtraClaveValida456" },
      CTX
    );
    const payload = verifyAccessToken(resultado.accessToken);

    expect(payload.ownerType).toBe("person");
    expect(payload.personId).toBe(persona.id);
    expect(payload.clubId).toBe(club.id);
  });
});

describe("el estado de autorización que se recalcula en cada solicitud", () => {
  it("expone `system` para el administrador, sin adivinar un club", async () => {
    const admin = await createUser({ username: "admin_sesion", roleNames: ["admin"] });

    const estado = await loadAuthorizationState(admin.id);

    expect(estado?.ownerType).toBe("system");
    expect(estado?.clubId, "un administrador no queda acotado a ningún club").toBeNull();
  });
});
