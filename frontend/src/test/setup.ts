import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/**
 * `waitFor` espera 1 s por omisión. Varias pruebas de sesión encadenan una
 * renovación asíncrona con un render de React, y bajo la carga de la suite
 * completa ese margen se agotaba: los mismos casos pasaban aislados y fallaban
 * al ejecutarlos todos juntos. Una prueba que depende de la carga de la máquina
 * no informa de nada.
 */
configure({ asyncUtilTimeout: 5_000 });

/**
 * BroadcastChannel ACOTADO AL ARCHIVO DE PRUEBA.
 *
 * El `BroadcastChannel` global de Node comunica entre los *worker threads* del
 * runner, así que los archivos de prueba que corren en paralelo se enviaban
 * mensajes de sesión entre sí: `permissions.test.tsx` adoptaba la sesión que
 * anunciaba `sessionRestore.test.tsx` y fallaba de forma intermitente.
 *
 * Eso es un artefacto del entorno de pruebas, no del navegador: dos archivos de
 * prueba no son dos pestañas. Aquí se sustituye por una implementación
 * equivalente cuyo alcance es este entorno —sigue entregando de forma
 * ASÍNCRONA y sin devolver el mensaje al emisor, como el real—, de modo que el
 * comportamiento se conserva y solo desaparece la fuga entre archivos.
 *
 * La coordinación entre pestañas se prueba en `refreshCoordinator.test.ts`, que
 * instala su propio canal controlado y lo sustituye a este.
 */
const canalesAbiertos = new Set<CanalLocal>();

class CanalLocal implements Pick<BroadcastChannel, "name" | "postMessage" | "close"> {
  onmessage: ((evento: MessageEvent) => void) | null = null;

  constructor(readonly name: string) {
    canalesAbiertos.add(this);
  }

  postMessage(data: unknown): void {
    for (const otro of canalesAbiertos) {
      // Un BroadcastChannel nunca se entrega a sí mismo.
      if (otro === this || otro.name !== this.name) continue;
      // Asíncrono, como el real.
      queueMicrotask(() => otro.onmessage?.({ data } as MessageEvent));
    }
  }

  close(): void {
    canalesAbiertos.delete(this);
  }
}

vi.stubGlobal("BroadcastChannel", CanalLocal);

afterEach(() => {
  cleanup();
  /**
   * Red de seguridad: si una prueba con temporizadores falsos termina de forma
   * inesperada, dejarlos activos contamina TODAS las siguientes del archivo con
   * un reloj detenido, y el síntoma —esperas que nunca se cumplen— no apunta a
   * la prueba culpable.
   */
  vi.useRealTimers();
});
