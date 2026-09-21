import { describe, it, expect, vi, afterEach } from "vitest";
import { join, resolve, sep } from "node:path";
import { compararCoherencia, resolverRutas } from "../scripts/verificar-coherencia";

/**
 * Pruebas del verificador de coherencia de la credencial de PostgreSQL.
 *
 * Ninguna abre un archivo real: `compararCoherencia` es pura y `resolverRutas`
 * solo hace aritmética de rutas. Por eso viven en la suite UNITARIA.
 *
 * Las rutas se construyen desde `resolve(sep)` —la raíz del volumen actual en
 * Windows, `/` en Linux— para que las mismas pruebas valgan en este equipo y en
 * el CI, que corre sobre Ubuntu.
 */

const RAIZ_ABS = resolve(sep);
const DIR_MODULO = join(RAIZ_ABS, "proyecto", "backend", "scripts");

const CLAVE = "Xk9._~-abcDEF0123456789abcDEF0123456789ab";
const PRUEBAS = "clave-publica-solo-pruebas";

const raizCon = (p: string | undefined) => ({ POSTGRES_PASSWORD: p });
const backendCon = (p: string) => ({ DATABASE_URL: `postgresql://natacion:${p}@localhost:5432/natacion?schema=public` });
const pruebasCon = (p: string) => ({ DATABASE_URL: `postgresql://natacion:${p}@localhost:55432/natacion_test?schema=public` });

describe("resolverRutas", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("toma como raíz el directorio dos niveles por encima del módulo", () => {
    const r = resolverRutas(DIR_MODULO);
    expect(join(r.raiz, "backend", "scripts")).toBe(DIR_MODULO);
    expect(r.envRaiz).toBe(join(r.raiz, ".env"));
    expect(r.envBackend).toBe(join(r.raiz, "backend", ".env"));
    expect(r.envPruebas).toBe(join(r.raiz, "backend", ".env.test"));
  });

  /**
   * El fallo que esta prueba impide: resolver con rutas relativas al directorio
   * de trabajo. `npm run` lo invoca desde `backend`, pero nada obliga a ello, y
   * en ese caso el verificador leería archivos inexistentes y emitiría un
   * veredicto falso en lugar de un error.
   */
  it("NO depende del directorio de trabajo", () => {
    const esperado = resolverRutas(DIR_MODULO);

    for (const cwd of [
      join(RAIZ_ABS, "otro", "sitio"),
      join(RAIZ_ABS, "proyecto"),
      join(RAIZ_ABS, "proyecto", "backend"),
    ]) {
      vi.spyOn(process, "cwd").mockReturnValue(cwd);
      expect(resolverRutas(DIR_MODULO)).toEqual(esperado);
    }
  });
});

describe("compararCoherencia", () => {
  it("acepta una configuración coherente", () => {
    expect(compararCoherencia(raizCon(CLAVE), backendCon(CLAVE), pruebasCon(PRUEBAS))).toEqual({
      passwordDefinida: true,
      urlAnalizable: true,
      coherente: true,
      alfabetoUrlSafe: true,
      distintaDePruebas: true,
    });
  });

  it("detecta la divergencia entre el .env de la raíz y backend/.env", () => {
    const v = compararCoherencia(raizCon(CLAVE), backendCon(`${CLAVE}x`), pruebasCon(PRUEBAS));
    expect(v.urlAnalizable).toBe(true);
    expect(v.coherente).toBe(false);
  });

  it("rechaza POSTGRES_PASSWORD ausente", () => {
    const v = compararCoherencia(raizCon(undefined), backendCon(CLAVE), pruebasCon(PRUEBAS));
    expect(v.passwordDefinida).toBe(false);
    expect(v.coherente).toBe(false);
  });

  it("rechaza POSTGRES_PASSWORD vacía", () => {
    const v = compararCoherencia(raizCon(""), backendCon(CLAVE), pruebasCon(PRUEBAS));
    expect(v.passwordDefinida).toBe(false);
    expect(v.coherente).toBe(false);
  });

  it("marca como no analizable una DATABASE_URL que no es una URL", () => {
    const v = compararCoherencia(raizCon(CLAVE), { DATABASE_URL: "esto-no-es-una-url" }, pruebasCon(PRUEBAS));
    expect(v.urlAnalizable).toBe(false);
    expect(v.coherente).toBe(false);
  });

  it("marca como no analizable una DATABASE_URL ausente", () => {
    const v = compararCoherencia(raizCon(CLAVE), {}, pruebasCon(PRUEBAS));
    expect(v.urlAnalizable).toBe(false);
    expect(v.coherente).toBe(false);
  });

  it("rechaza una contraseña con caracteres reservados en URL", () => {
    const conReservados = "clave-con@arroba";
    const v = compararCoherencia(raizCon(conReservados), backendCon(conReservados), pruebasCon(PRUEBAS));
    expect(v.alfabetoUrlSafe).toBe(false);
  });

  it("rechaza que la credencial de desarrollo sea la pública de pruebas", () => {
    const v = compararCoherencia(raizCon(PRUEBAS), backendCon(PRUEBAS), pruebasCon(PRUEBAS));
    expect(v.distintaDePruebas).toBe(false);
  });

  /**
   * Una contraseña con caracteres reservados viaja codificada dentro de la URL.
   * La comparación debe hacerse sobre el valor DECODIFICADO: comparar la forma
   * porcentual contra el valor en claro daría una divergencia inexistente.
   */
  it("compara la contraseña decodificada, no su forma porcentual", () => {
    const conEspacioYMas = "clave con+signos";
    const v = compararCoherencia(
      raizCon(conEspacioYMas),
      backendCon(encodeURIComponent(conEspacioYMas)),
      pruebasCon(PRUEBAS)
    );
    expect(v.coherente).toBe(true);
    expect(v.alfabetoUrlSafe).toBe(false);
  });
});
