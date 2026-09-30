-- Causa del cierre de inscripciones.
--
-- POR QUÉ HACE FALTA
--
-- `competitions.status` es un enum único: un 'closed' no dice si lo cerró un
-- administrador, el vencimiento de la fecha o el agotamiento del cupo. Sin esa
-- distinción, `recomputeStatusAfterEdit` reabría CUALQUIER competencia cerrada
-- en cuanto alguien la editaba con las fechas vigentes — incluido un cierre
-- manual, que es una decisión explícita que ninguna edición incidental
-- (renombrar, cambiar la piscina) debería anular.
--
-- SEMÁNTICA DE NULL
--
-- NULL significa "cerrada antes de que existiera este campo": causa
-- desconocida. Es un conjunto FINITO que no vuelve a crecer, porque a partir
-- de aquí los tres caminos de cierre escriben siempre su causa —incluido el
-- cierre por fecha, que se persiste en `applyAutoStatus`—. Una fila con NULL
-- se trata como un cierre deliberado: no se reabre por una edición incidental.
--
-- Ambas columnas son NULLABLE y sin valor por defecto: ninguna fila existente
-- cambia, y no hace falta migrar datos ni adivinar causas retroactivas.
CREATE TYPE "RegistrationsCloseReason" AS ENUM ('manual', 'capacity', 'schedule');

ALTER TABLE "competitions" ADD COLUMN "registrations_closed_reason" "RegistrationsCloseReason";
ALTER TABLE "competitions" ADD COLUMN "registrations_closed_at" TIMESTAMP(3);

-- Coherencia: la causa y la marca de tiempo solo tienen sentido con las
-- inscripciones cerradas, y van siempre juntas. Esta restricción impide que un
-- camino alternativo deje una fila abierta con causa de cierre, o una causa sin
-- su fecha, estados que el resto del sistema no sabe leer.
ALTER TABLE "competitions"
  ADD CONSTRAINT "competitions_close_reason_coherente"
  CHECK (
    ("registrations_closed_reason" IS NULL AND "registrations_closed_at" IS NULL)
    OR
    ("registrations_closed_reason" IS NOT NULL AND "registrations_closed_at" IS NOT NULL AND "status" = 'closed')
  );
