/**
 * Corrección de DESDE/HASTA: evaluación pura de superposiciones (`evaluarFechasCorregidas`).
 * Extremos inclusivos; una fecha nula es desconocida; `end_date` nunca decide.
 */
import { describe, it, expect } from "vitest";
import { evaluarFechasCorregidas, type FilaMembresia } from "../src/modules/swimmer-assignment/membresias.protocolo";

const fila = (
  id: string,
  status: FilaMembresia["status"],
  start_date: string | null,
  fecha_termino: string | null,
  end_date: Date | null = null
): FilaMembresia => ({
  id,
  club_id: `club-${id}`,
  status,
  start_date,
  fecha_termino,
  end_date,
});

describe("evaluarFechasCorregidas", () => {
  const activa = fila("act", "active", "2025-03-10", null);

  it("una finalizada que termina el día ANTES de la activa es compatible", () => {
    const r = evaluarFechasCorregidas(fila("fin", "ended", "2024-01-01", "2025-03-09"), [activa]);
    expect(r).toEqual({ conflictos: [], incompletas: [] });
  });

  it("terminar el MISMO día en que empieza la otra se superpone (extremos inclusivos)", () => {
    const r = evaluarFechasCorregidas(fila("fin", "ended", "2024-01-01", "2025-03-10"), [activa]);
    expect(r.conflictos.map((c) => c.membresiaId)).toEqual(["act"]);
    expect(r.conflictos[0]!.motivo).toContain("sin término (vigente)");
  });

  it("una activa que se adelanta hasta el periodo de una finalizada choca con ella", () => {
    const r = evaluarFechasCorregidas(fila("act", "active", "2024-06-01", null), [
      fila("fin", "ended", "2024-01-01", "2024-12-31"),
      activa,
    ]);
    expect(r.conflictos.map((c) => c.membresiaId)).toEqual(["fin"]);
  });

  it("una membresía de un solo día (DESDE = HASTA) es válida si no toca a otra", () => {
    const r = evaluarFechasCorregidas(fila("uno", "ended", "2025-03-09", "2025-03-09"), [
      activa,
      fila("x", "ended", "2025-01-01", "2025-03-08"),
    ]);
    expect(r).toEqual({ conflictos: [], incompletas: [] });
  });

  it("fechas desconocidas que impiden descartar la superposición: incompleta, nunca conflicto inventado", () => {
    const historico = fila("hist", "ended", null, null, new Date("2020-01-01T00:00:00Z"));
    const r = evaluarFechasCorregidas(fila("act", "active", "2025-03-10", null), [historico]);
    expect(r).toEqual({ conflictos: [], incompletas: ["hist"] });
  });

  it("una fecha desconocida no impide decidir cuando la otra membresía queda entera antes", () => {
    // La corregida tiene DESDE desconocido, pero termina antes de que empiece la activa.
    const r = evaluarFechasCorregidas(fila("vieja", "ended", null, "2025-03-01"), [activa]);
    expect(r).toEqual({ conflictos: [], incompletas: [] });
  });

  it("pendientes, rechazadas y la propia membresía no cuentan", () => {
    const r = evaluarFechasCorregidas(fila("act", "active", "2025-03-10", null), [
      fila("act", "active", "2020-01-01", null),
      fila("pend", "pending", null, null),
      fila("rech", "rejected", null, null),
    ]);
    expect(r).toEqual({ conflictos: [], incompletas: [] });
  });
});
