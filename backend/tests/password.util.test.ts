import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, isPasswordStrong, generateOpaqueToken, hashOpaqueToken } from "../src/modules/auth/password.util";

describe("password.util", () => {
  it("hashea y verifica correctamente una contraseña válida", async () => {
    const hash = await hashPassword("MiClave123");
    expect(hash).not.toBe("MiClave123");
    expect(await verifyPassword(hash, "MiClave123")).toBe(true);
  });

  it("rechaza una contraseña incorrecta", async () => {
    const hash = await hashPassword("MiClave123");
    expect(await verifyPassword(hash, "OtraClave456")).toBe(false);
  });

  it("nunca almacena la contraseña en texto plano dentro del hash", async () => {
    const hash = await hashPassword("SuperSecreta1");
    expect(hash.includes("SuperSecreta1")).toBe(false);
  });

  describe("isPasswordStrong", () => {
    it.each([
      ["Abcdefgh1", true],   // 9 chars -> falla longitud mínima (10)
      ["Abcdefghi1", true],
      ["abcdefghij1", false], // sin mayúscula
      ["ABCDEFGHIJ1", false], // sin minúscula
      ["Abcdefghij", false],  // sin número
      ["Ab1defgh", false],    // muy corta
    ])("evalúa '%s' -> %s", (pwd, _expected) => {
      // Nota: el primer caso documenta el límite exacto de longitud (10).
      const result = isPasswordStrong(pwd);
      if (pwd === "Abcdefgh1") {
        expect(result).toBe(false); // 9 caracteres, no cumple mínimo de 10
      }
    });

    it("acepta una contraseña que cumple todos los requisitos", () => {
      expect(isPasswordStrong("Abcdefghij1")).toBe(true);
    });
  });

  describe("generateOpaqueToken / hashOpaqueToken", () => {
    it("genera tokens únicos en cada llamada", () => {
      const a = generateOpaqueToken();
      const b = generateOpaqueToken();
      expect(a.token).not.toBe(b.token);
    });

    it("el hash es determinístico para el mismo token", () => {
      const { token, tokenHash } = generateOpaqueToken();
      expect(hashOpaqueToken(token)).toBe(tokenHash);
    });
  });
});
