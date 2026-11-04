-- Condición configurable por competencia: «exigir al menos una inscripción individual
-- confirmada antes de participar en relevos».
--
-- Columna nueva, ADITIVA, `NOT NULL DEFAULT true`. Hasta ahora la regla era una
-- invariante incondicional; `true` la conserva EXACTAMENTE para toda competencia que ya
-- existe (el valor por omisión se aplica a las filas anteriores), y las nuevas nacen
-- con la casilla marcada. Ninguna fila se modifica a mano, no se revalida, cancela ni
-- retira a nadie, y por eso no hay validación previa.
--
-- Con `false`, la competencia no exige la individual para formar o modificar un relevo ni
-- bloquea cancelar la última individual de quien integra un relevo. Nada se recalcula al
-- cambiarla: solo gobierna las altas, modificaciones y cancelaciones posteriores.

ALTER TABLE "competitions" ADD COLUMN "require_individual_for_relay" BOOLEAN NOT NULL DEFAULT true;
