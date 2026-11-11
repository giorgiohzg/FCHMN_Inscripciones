/**
 * Pruebas de integración — requieren PostgreSQL de test disponible en
 * DATABASE_URL (ver .env.test.example). Se ejecutan con:
 *   npm run test:integration
 *
 * Cubren el flujo completo contra la base de datos real (no mocks) porque
 * las reglas críticas (limitador de login, rotación/reuso de refresh token)
 * dependen de transacciones e índices reales.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../src/shared/prisma.client";
import { truncateAllTables } from "./helpers/testDb";
import { hashPassword } from "../src/modules/auth/password.util";
import * as authService from "../src/modules/auth/auth.service";
import { UnauthorizedError } from "../src/shared/errors";

const TEST_USERNAME = "test_integration_user";
const TEST_PASSWORD = "ClaveValida123";

async function createTestUser() {
  const passwordHash = await hashPassword(TEST_PASSWORD);
  return prisma.user.create({
    // `system` y no `person`: una cuenta sin persona ni club es del sistema.
    // Con `person` la base la rechaza (`users_owner_coherente`, hallazgo 20).
    data: { username: TEST_USERNAME, passwordHash, ownerType: "system", mustChangePassword: false, status: "active" },
  });
}

beforeEach(async () => {
  await truncateAllTables(prisma);
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

describe("auth.service — login", () => {
  it("permite login con credenciales correctas y retorna tokens", async () => {
    await createTestUser();
    const result = await authService.login({ username: TEST_USERNAME, password: TEST_PASSWORD }, {});
    expect(result.accessToken).toBeTypeOf("string");
    expect(result.refreshToken).toBeTypeOf("string");
  });

  it("rechaza contraseña incorrecta sin revelar si el usuario existe", async () => {
    await createTestUser();
    await expect(
      authService.login({ username: TEST_USERNAME, password: "Incorrecta1" }, {})
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  /**
   * C-02 sustituye a RB-15: los fallos ya no bloquean la cuenta entera. Tras cinco fallos del
   * mismo par (usuario y origen), el sexto intento de ESE par —incluso con la contraseña
   * correcta— recibe el 429 uniforme sin verificar nada, y la cuenta sigue intacta.
   */
  it("limita el par tras 5 fallos sin bloquear la cuenta (C-02, sustituye a RB-15)", async () => {
    await createTestUser();
    for (let i = 0; i < 5; i++) {
      await expect(
        authService.login({ username: TEST_USERNAME, password: "Incorrecta1" }, {})
      ).rejects.toBeInstanceOf(UnauthorizedError);
    }
    await expect(authService.login({ username: TEST_USERNAME, password: TEST_PASSWORD }, {})).rejects.toMatchObject({
      statusCode: 429,
      code: "LOGIN_THROTTLED",
    });
    const cuenta = await prisma.user.findFirstOrThrow({ where: { username: TEST_USERNAME } });
    expect(cuenta.status).toBe("active");
    expect(cuenta.failedLoginAttempts).toBe(0);
    expect(cuenta.lockedUntil).toBeNull();
  });
});

describe("auth.service — refresh token rotation", () => {
  it("rota el refresh token y revoca el anterior", async () => {
    await createTestUser();
    const { refreshToken } = await authService.login({ username: TEST_USERNAME, password: TEST_PASSWORD }, {});

    const rotated = await authService.refresh(refreshToken, {});
    expect(rotated.refreshToken).not.toBe(refreshToken);

    // Reusar el token viejo debe fallar y revocar toda la sesión (detección de robo).
    await expect(authService.refresh(refreshToken, {})).rejects.toBeInstanceOf(UnauthorizedError);

    // El token nuevo, al haber sido revocado por la detección de reuso, también falla.
    await expect(authService.refresh(rotated.refreshToken, {})).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
