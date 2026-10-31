-- Fecha EFECTIVA de la membresía, separada de las marcas de auditoría.
--
-- `start_date` era un TIMESTAMP(3) al que el servicio escribía `new Date()`:
-- el mismo instante que `reviewed_at`, en la misma operación. Dos campos para
-- un solo hecho, y el que tenía nombre de dato del negocio guardaba un
-- instante en UTC. Medido: una asignación hecha en Chile a las 23:58 del 30 de
-- octubre quedaba almacenada como `2026-10-31 02:58`, mientras la interfaz
-- —que formatea con `toLocaleDateString("es-CL")`— mostraba `30-10-2026`.
--
-- A partir de aquí: `start_date` es una FECHA DE CALENDARIO (sin hora y sin
-- zona) y `reviewed_at` es la única marca de auditoría. El diseño original ya
-- lo contemplaba: «start_date NULLABLE -- se completa al aprobar (= reviewed_at
-- o fecha indicada)».

-- 1. Ninguna marca de auditoría se pierde.
--    Hoy los dos campos llevan el mismo instante, pero `reviewed_at` es
--    anulable: una fila antigua podría tener la hora solo en `start_date`, y el
--    paso 2 la descarta. Se copia ANTES.
UPDATE "club_swimmers"
   SET "reviewed_at" = "start_date"
 WHERE "reviewed_at" IS NULL
   AND "start_date" IS NOT NULL;

-- 2. El tipo pasa a DATE, con la fecha de calendario CHILENA del instante
--    guardado: exactamente la que la interfaz ya venía mostrando, así que
--    ninguna pantalla cambia de valor para los datos existentes.
--
--    La doble conversión es necesaria y el orden importa: `start_date` es
--    `timestamp without time zone` con un instante UTC, así que primero
--    `AT TIME ZONE 'UTC'` lo interpreta como UTC (y da un `timestamptz`), y
--    después `AT TIME ZONE 'America/Santiago'` lo lleva al reloj chileno. Esto
--    respeta el horario de verano de cada fecha concreta, porque PostgreSQL
--    aplica la regla vigente en ESE instante, no un desplazamiento fijo.
ALTER TABLE "club_swimmers"
  ALTER COLUMN "start_date" TYPE DATE
  USING ("start_date" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Santiago')::date;

COMMENT ON COLUMN "club_swimmers"."start_date" IS
  'Fecha EFECTIVA de inicio de la membresia (dia calendario chileno). No es una marca de auditoria: esa es reviewed_at.';

-- NOTA: `end_date` conserva el mismo defecto y no se toca en esta migracion,
-- a proposito. No se muestra en ninguna pantalla y cambiarlo mezclaria dos
-- decisiones. Queda pendiente.
