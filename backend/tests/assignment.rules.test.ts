import { describe, it, expect } from "vitest";
import { evaluateTransition, isTerminalStatus } from "../src/modules/swimmer-assignment/assignment.rules";

describe("assignment.rules — evaluateTransition", () => {
  it("permite aprobar una solicitud pendiente (pending -> active)", () => {
    const result = evaluateTransition("pending", "approve");
    expect(result.allowed).toBe(true);
    expect(result.nextStatus).toBe("active");
  });

  it("permite rechazar una solicitud pendiente (pending -> rejected)", () => {
    const result = evaluateTransition("pending", "reject");
    expect(result.allowed).toBe(true);
    expect(result.nextStatus).toBe("rejected");
  });

  it("permite finalizar una asignación activa (active -> ended)", () => {
    const result = evaluateTransition("active", "end");
    expect(result.allowed).toBe(true);
    expect(result.nextStatus).toBe("ended");
  });

  it("rechaza aprobar una asignación que ya está activa", () => {
    const result = evaluateTransition("active", "approve");
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/pending/);
  });

  it("rechaza aprobar una solicitud ya rechazada", () => {
    const result = evaluateTransition("rejected", "approve");
    expect(result.allowed).toBe(false);
  });

  it("rechaza finalizar una solicitud que aún está pendiente (no activa)", () => {
    const result = evaluateTransition("pending", "end");
    expect(result.allowed).toBe(false);
  });

  it("rechaza rechazar una asignación ya finalizada", () => {
    const result = evaluateTransition("ended", "reject");
    expect(result.allowed).toBe(false);
  });

  it("rechaza cualquier transición sobre un estado ya rechazado (terminal)", () => {
    expect(evaluateTransition("rejected", "approve").allowed).toBe(false);
    expect(evaluateTransition("rejected", "reject").allowed).toBe(false);
    expect(evaluateTransition("rejected", "end").allowed).toBe(false);
  });
});

describe("assignment.rules — isTerminalStatus", () => {
  it("considera 'rejected' y 'ended' como estados terminales", () => {
    expect(isTerminalStatus("rejected")).toBe(true);
    expect(isTerminalStatus("ended")).toBe(true);
  });

  it("no considera 'pending' ni 'active' como terminales", () => {
    expect(isTerminalStatus("pending")).toBe(false);
    expect(isTerminalStatus("active")).toBe(false);
  });
});
