/**
 * EL CARGADOR DE CARGA MASIVA, PROBADO DE PUNTA A PUNTA CON DATOS SINTÉTICOS.
 *
 * Esta prueba no comprueba una función: ejecuta el guion real como lo ejecutaría
 * una persona, contra una API simulada que se puede obligar a fallar de las
 * formas que la API de verdad no deja provocar sin romper algo —un corte
 * justo después de guardar, un registro preexistente que difiere, un token que
 * caduca a mitad de etapa, un 429 permanente—.
 *
 * ALCANCE, dicho con precisión. La API simulada reproduce lo que el cargador
 * OBSERVA: formas de respuesta, mensajes de rechazo y, a propósito, la trampa de
 * la fecha —si `fechaEfectiva` no viaja, se graba HOY, igual que el servicio
 * real—. No es la API del proyecto y no se parece por dentro, así que esto
 * prueba el cargador, no el servidor.
 *
 * QUÉ NO TOCA: ninguna base de datos, ninguna red fuera de 127.0.0.1 y ningún
 * dato real. Las planillas son sintéticas, generadas al arrancar en una carpeta
 * temporal que se borra al terminar.
 *
 * POR QUÉ TARDA ~55 s. Los dos casos del límite de solicitudes esperan de
 * verdad lo que el servidor les dice que esperen: comprobar que `Retry-After`
 * se respeta exige que pase el tiempo, y el caso del 429 permanente consume a
 * propósito las doce esperas con las que el cargador se rinde (15 s por sí
 * solo). Es la parte lenta y es deliberada; el resto de los casos tarda entre
 * tres y seis segundos cada uno.
 *
 * Para iterar sobre un caso concreto sin pagar los demás:
 *   node backend/tests/carga-masiva/pruebas-reanudacion.mjs --caso 4
 *
 * El detalle de cada comprobación va al informe del propio guion, que esta
 * prueba vuelca si algo falla.
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";

const GUION = join(__dirname, "pruebas-reanudacion.mjs");

function ejecutar(args: string[]): Promise<{ codigo: number | null; texto: string }> {
  return new Promise((ok) => {
    const p = spawn(process.execPath, [GUION, ...args], { env: { ...process.env } });
    let texto = "";
    p.stdout.on("data", (d) => (texto += String(d)));
    p.stderr.on("data", (d) => (texto += String(d)));
    p.on("close", (codigo) => ok({ codigo, texto }));
  });
}

describe("cargador de carga masiva", () => {
  it(
    "pasa su batería completa contra la API simulada, con planillas sintéticas",
    async () => {
      const { codigo, texto } = await ejecutar([]);

      const resumen = /(\d+) de (\d+) comprobaciones correctas/.exec(texto);
      // El informe completo solo se vuelca si algo falla: en verde no aporta y
      // ensucia la salida de la suite.
      if (codigo !== 0 || !resumen || resumen[1] !== resumen[2]) {
        throw new Error(`la batería del cargador falló (código ${codigo}):\n${texto}`);
      }

      expect(resumen, "el guion no imprimió su resumen: ¿terminó antes de tiempo?").not.toBeNull();
      const [, correctas, totales] = resumen!;
      expect(Number(totales)).toBeGreaterThan(40);
      expect(correctas).toBe(totales);
      expect(texto).toContain("Todas las comprobaciones correctas.");
    },
    300_000
  );
});
