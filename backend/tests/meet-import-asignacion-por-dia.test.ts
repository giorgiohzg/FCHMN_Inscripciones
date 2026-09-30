/**
 * ¿Respetar la asignación por día del archivo, o mandarlo todo al primer día?
 *
 * La regla es "todo o nada" a propósito: una asignación a medias repartiría
 * unas pruebas por su día real y otras por omisión, y nadie podría distinguir
 * a simple vista cuáles quedaron mal. Con el aviso, en cambio, el
 * administrador sabe exactamente qué tiene que revisar.
 */
import { describe, it, expect } from "vitest";
import { evaluarAsignacionPorDia } from "../src/modules/meet-import/meet-import.service";
import type { ParsedMeetEvent } from "../src/modules/meet-import/ev3-parser";

const DIA_1 = new Date("2030-01-01T00:00:00.000Z");
const DIA_3 = new Date("2030-01-03T00:00:00.000Z");

function prueba(eventNumber: number, eventDate?: Date): ParsedMeetEvent {
  return {
    eventNumber,
    isRelay: false,
    gender: "female",
    distanceMeters: 50,
    strokeName: "Libre",
    sessionTime: "09:00AM",
    ...(eventDate ? { eventDate } : {}),
  };
}

describe("evaluarAsignacionPorDia", () => {
  it("sin ninguna fecha por prueba — el caso del .ev3 — no hay asignación", () => {
    const r = evaluarAsignacionPorDia([prueba(1), prueba(2), prueba(3)], DIA_1, DIA_3);
    expect(r.valida).toBe(false);
    // Sin motivo: no es un error del archivo, es que el formato no lo trae.
    expect(r.motivo).toBeUndefined();
  });

  it("con fecha válida en TODAS las pruebas, se respeta", () => {
    const r = evaluarAsignacionPorDia(
      [prueba(1, DIA_1), prueba(2, new Date("2030-01-02T00:00:00.000Z")), prueba(3, DIA_3)],
      DIA_1,
      DIA_3
    );
    expect(r.valida).toBe(true);
  });

  it("una asignación PARCIAL se descarta entera, y lo dice", () => {
    const r = evaluarAsignacionPorDia([prueba(1, DIA_1), prueba(2), prueba(3, DIA_3)], DIA_1, DIA_3);
    expect(r.valida).toBe(false);
    expect(r.motivo).toMatch(/solo a 2 de 3 pruebas/i);
  });

  it("una fecha FUERA del rango descarta la asignación completa", () => {
    const r = evaluarAsignacionPorDia([prueba(1, DIA_1), prueba(2, new Date("2030-02-15T00:00:00.000Z"))], DIA_1, DIA_3);
    expect(r.valida).toBe(false);
    expect(r.motivo).toMatch(/fuera del rango de la competencia \(2030-01-01 a 2030-01-03\)/i);
  });

  it("una fecha inválida cuenta como ausente", () => {
    const rota = prueba(2, new Date("no-es-una-fecha"));
    const r = evaluarAsignacionPorDia([prueba(1, DIA_1), rota], DIA_1, DIA_3);
    expect(r.valida).toBe(false);
    expect(r.motivo).toMatch(/solo a 1 de 2 pruebas/i);
  });

  it("una competencia de un solo día con asignación coherente también es válida", () => {
    const r = evaluarAsignacionPorDia([prueba(1, DIA_1), prueba(2, DIA_1)], DIA_1, DIA_1);
    expect(r.valida).toBe(true);
  });
});
