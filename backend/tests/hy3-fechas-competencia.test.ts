/**
 * B1 del HY3 lleva las fechas REALES de la competencia, no las de inscripción.
 *
 * Pruebas puras (sin base de datos) del criterio de `fechasDeLaCompetencia` y de
 * cómo queda escrito el registro B1, con su checksum. Los casos de extremo a
 * extremo —la competencia real, el club, el alcance— están en
 * `import-export-services.integration.test.ts`.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fechasDeLaCompetencia } from "../src/modules/team-manager-export/competition-dates";
import { buildB1 } from "../src/modules/team-manager-export/hy3-writer";
import { computeHy3Checksum, HY3_CONTENT_LENGTH, HY3_LINE_LENGTH } from "../src/modules/team-manager-export/hy3-checksum";
import { ValidationError } from "../src/shared/errors";

const BACKEND_DIR = resolve(__dirname, "..");
const GUION = resolve(__dirname, "helpers", "fechas-hy3-en-proceso.ts");

const dia = (iso: string) => ({ date: new Date(`${iso}T00:00:00.000Z`) });
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Columnas del B1: "B1" + nombre(45) + sede(45) + inicio(8) + término(8) + corte(8). */
function camposDeFecha(b1: string) {
  return { inicio: b1.slice(92, 100), termino: b1.slice(100, 108), corte: b1.slice(108, 116) };
}

describe("criterio de fechas", () => {
  it("un día: inicio y término son esa fecha", () => {
    const r = fechasDeLaCompetencia([dia("2026-11-08")], "Copa");
    expect(iso(r.inicio)).toBe("2026-11-08");
    expect(iso(r.termino)).toBe("2026-11-08");
  });

  it("varios días: primera y última programadas, sea cual sea el orden de entrada", () => {
    const base = ["2026-11-09", "2026-11-08", "2026-11-15", "2026-11-10"];
    // Todas las permutaciones de una lista corta: el resultado no puede depender del orden.
    const permutaciones = (xs: string[]): string[][] =>
      xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutaciones([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
    for (const orden of permutaciones(base)) {
      const r = fechasDeLaCompetencia(orden.map(dia), "Copa");
      expect(iso(r.inicio), orden.join(",")).toBe("2026-11-08");
      expect(iso(r.termino), orden.join(",")).toBe("2026-11-15");
    }
  });

  it("cruza meses y años sin confundir el orden (texto, no número)", () => {
    const r = fechasDeLaCompetencia([dia("2027-01-02"), dia("2026-12-30"), dia("2026-12-31")], "Copa");
    expect(iso(r.inicio)).toBe("2026-12-30");
    expect(iso(r.termino)).toBe("2027-01-02");
  });

  it("sin fechas: error claro que no sugiere usar las de inscripción", () => {
    let error: unknown;
    try {
      fechasDeLaCompetencia([], "Copa Sin Fechas");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    const mensaje = (error as Error).message;
    expect(mensaje).toContain("Copa Sin Fechas");
    expect(mensaje).toMatch(/no tiene fechas programadas/);
    expect(mensaje).toMatch(/No se usan las fechas de inscripción/);
  });

  it("una hora distinta de la medianoche UTC no cambia el DÍA guardado", () => {
    // El día de calendario es el de los componentes UTC, como en todo el sistema.
    const r = fechasDeLaCompetencia([{ date: new Date("2026-11-08T23:59:59.999Z") }, { date: new Date("2026-11-08T00:00:00.000Z") }], "Copa");
    expect(iso(r.inicio)).toBe("2026-11-08");
    expect(iso(r.termino)).toBe("2026-11-08");
  });
});

describe("estabilidad frente a la zona horaria del proceso", () => {
  /**
   * Cada caso corre en un PROCESO APARTE con su `TZ`. Cambiar `process.env.TZ`
   * dentro de la prueba no surte efecto en todas las plataformas (en Windows no
   * lo hace: la primera versión de esta prueba lo demostró), así que no probaría
   * nada. El propio guion informa el desfase real de la zona, y se exige que
   * sea el esperado.
   */
  function enZona(zona: string, ...dias: string[]) {
    const salida = execFileSync(process.execPath, ["--import", "tsx", GUION, ...dias], {
      cwd: BACKEND_DIR,
      env: { ...process.env, TZ: zona },
      encoding: "utf8",
    });
    return JSON.parse(salida.trim().split(String.fromCharCode(10)).pop()!) as { desfase: number; diaLocalDeLaFecha: number; inicio: string; termino: string };
  }

  // Una zona al OESTE de Greenwich (donde `getDate()` restaría un día), una al
  // ESTE (donde sumaría uno) y UTC. Desfase de `getTimezoneOffset()` en noviembre.
  it.each([
    ["America/Santiago", 180, 7],
    ["America/Los_Angeles", 480, 7],
    ["Pacific/Auckland", -780, 8],
    ["Pacific/Kiritimati", -840, 8],
    ["UTC", 0, 8],
  ])("TZ=%s (desfase %i): la competencia del 08/11/2026 se escribe 11082026", (zona, desfase, diaLocal) => {
    const r = enZona(zona, "2026-11-08");
    expect(r.desfase, "la zona del proceso hijo es la pedida").toBe(desfase);
    // En las zonas al oeste, leer el día con la zona local daría el 7: es el defecto que se evita.
    expect(r.diaLocalDeLaFecha).toBe(diaLocal);
    expect(r.inicio).toBe("11082026");
    expect(r.termino).toBe("11082026");
  });

  it("varios días desordenados, en una zona al oeste: primera y última intactas", () => {
    const r = enZona("America/Los_Angeles", "2026-11-09", "2026-11-08", "2026-11-15");
    expect([r.inicio, r.termino]).toEqual(["11082026", "11152026"]);
  });
});

describe("registro B1", () => {
  it("regresión: inscripción 26/10–05/11 y competencia el 08/11/2026 → B1 con 11082026 en AMBAS fechas, con checksum válido", () => {
    const inscripcion = { inicio: new Date("2026-10-26T00:00:00.000Z"), fin: new Date("2026-11-05T00:00:00.000Z") };
    const { inicio, termino } = fechasDeLaCompetencia([dia("2026-11-08")], "Copa Regresión");
    const corte = new Date("2026-12-31T00:00:00.000Z");

    const b1 = buildB1({ facility: "cduc", name: "Copa Regresión", startDate: inicio, endDate: termino, ageUpDate: corte });
    const { inicio: i, termino: t, corte: c } = camposDeFecha(b1);

    expect(i).toBe("11082026");
    expect(t).toBe("11082026");
    // Ni rastro de las fechas de inscripción.
    expect(b1).not.toContain("10262026");
    expect(b1).not.toContain("11052026");
    // El corte de edad es otro dato y no se movió.
    expect(c).toBe("12312026");

    expect(b1).toHaveLength(HY3_LINE_LENGTH);
    expect(b1.slice(HY3_CONTENT_LENGTH)).toBe(computeHy3Checksum(b1.slice(0, HY3_CONTENT_LENGTH)));
    expect(inscripcion.inicio.getTime()).toBeLessThan(inicio.getTime()); // el fixture es coherente
  });

  it("varios días: B1 lleva primera y última, con checksum válido", () => {
    const { inicio, termino } = fechasDeLaCompetencia([dia("2026-11-15"), dia("2026-11-08"), dia("2026-11-09")], "Copa");
    const b1 = buildB1({ facility: "cduc", name: "Copa", startDate: inicio, endDate: termino, ageUpDate: new Date("2026-12-31T00:00:00.000Z") });
    const { inicio: i, termino: t } = camposDeFecha(b1);
    expect([i, t]).toEqual(["11082026", "11152026"]);
    expect(b1.slice(HY3_CONTENT_LENGTH)).toBe(computeHy3Checksum(b1.slice(0, HY3_CONTENT_LENGTH)));
  });
});
