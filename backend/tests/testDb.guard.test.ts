/**
 * El guard que impide correr pruebas destructivas contra la base de trabajo.
 * Es la corrección del incidente que borró categorías, jornadas, pruebas de
 * competencia e inscripciones: estas pruebas verifican que las conexiones
 * peligrosas se rechacen ANTES de abrir la conexión.
 */
import { describe, it, expect } from "vitest";
import { checkDisposableDatabaseUrl } from "./helpers/testDb";

const OK = "si-esta-base-es-desechable";
const VALID = "postgresql://natacion:clave-de-prueba@localhost:55432/natacion_test?schema=public";

describe("checkDisposableDatabaseUrl", () => {
  it("acepta la base desechable de docker-compose.test.yml", () => {
    const result = checkDisposableDatabaseUrl(VALID, OK);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target).toEqual({ host: "localhost", port: "55432", database: "natacion_test" });
    }
  });

  it("acepta el nombre de servicio de Compose como host", () => {
    expect(checkDisposableDatabaseUrl("postgresql://natacion:clave-de-prueba@postgres-test:55432/natacion_test", OK).ok).toBe(true);
  });

  it("RECHAZA la base de trabajo (puerto 5432, nombre sin sufijo)", () => {
    expect(checkDisposableDatabaseUrl("postgresql://natacion:clave-de-prueba@localhost:5432/natacion", OK).ok).toBe(false);
  });

  it("RECHAZA una base con el nombre correcto pero en el puerto de trabajo", () => {
    const result = checkDisposableDatabaseUrl("postgresql://natacion:clave-de-prueba@localhost:5432/natacion_test", OK);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("5432");
  });

  it("RECHAZA una base en el puerto de pruebas pero con nombre de producción", () => {
    const result = checkDisposableDatabaseUrl("postgresql://natacion:clave-de-prueba@localhost:55432/natacion", OK);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("_test");
  });

  it("RECHAZA un host REMOTO aunque el puerto y el nombre calcen", () => {
    const result = checkDisposableDatabaseUrl("postgresql://natacion:clave-de-prueba@db.produccion.cl:55432/natacion_test", OK);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no es local");
  });

  it("RECHAZA cuando falta la confirmación explícita", () => {
    const result = checkDisposableDatabaseUrl(VALID, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("ALLOW_DESTRUCTIVE_TESTS");
  });

  it("RECHAZA una confirmación con un valor distinto", () => {
    expect(checkDisposableDatabaseUrl(VALID, "true").ok).toBe(false);
    expect(checkDisposableDatabaseUrl(VALID, "yes").ok).toBe(false);
  });

  it("RECHAZA una URL ausente", () => {
    expect(checkDisposableDatabaseUrl(undefined, OK).ok).toBe(false);
  });

  it("RECHAZA una URL malformada", () => {
    expect(checkDisposableDatabaseUrl("no-es-una-url", OK).ok).toBe(false);
  });

  it("RECHAZA un motor distinto de PostgreSQL", () => {
    expect(checkDisposableDatabaseUrl("mysql://user:pass@localhost:55432/natacion_test", OK).ok).toBe(false);
  });
});
