/**
 * Guion de apoyo de `hy3-fechas-competencia.test.ts`: se ejecuta en un PROCESO
 * APARTE para que la zona horaria (`TZ`) sea de verdad la del proceso. Cambiarla
 * con `process.env.TZ` desde dentro de una prueba no surte efecto en todas las
 * plataformas (en Windows no lo hace), y una prueba de zonas que no cambia la
 * zona no prueba nada.
 *
 * Imprime una línea JSON con el desfase de la zona y los campos de fecha del B1.
 */
import { fechasDeLaCompetencia } from "../../src/modules/team-manager-export/competition-dates";
import { buildB1 } from "../../src/modules/team-manager-export/hy3-writer";

const dias = process.argv.slice(2);
const { inicio, termino } = fechasDeLaCompetencia(
  dias.map((d) => ({ date: new Date(`${d}T00:00:00.000Z`) })),
  "Copa"
);
const b1 = buildB1({ name: "Copa", startDate: inicio, endDate: termino, ageUpDate: new Date("2026-12-31T00:00:00.000Z") });

console.log(
  JSON.stringify({
    desfase: new Date(2026, 10, 8).getTimezoneOffset(),
    // Lo que daría leer la fecha con la zona LOCAL: el defecto que se evita.
    diaLocalDeLaFecha: new Date("2026-11-08T00:00:00.000Z").getDate(),
    inicio: b1.slice(92, 100),
    termino: b1.slice(100, 108),
  })
);
