-- Cupos opcionales de NADADORES DISTINTOS por competencia.
--
-- Ambas columnas son NULLABLE y sin valor por defecto a propósito: toda
-- competencia existente queda con NULL, que significa "sin límite", de modo
-- que el comportamiento anterior se conserva intacto sin necesidad de migrar
-- datos ni de recalcular nada.
--
-- Cuentan nadadores distintos con inscripción activa (individuales
-- confirmadas + integrantes de relevos confirmados), NO la cantidad de
-- pruebas en que participa cada uno.
ALTER TABLE "competitions" ADD COLUMN "max_swimmers" INTEGER;
ALTER TABLE "competitions" ADD COLUMN "max_swimmers_per_club" INTEGER;

-- Coherencia mínima a nivel de base: un cupo, si se define, tiene que ser
-- positivo. La validación de negocio vive en Zod y en el servicio; esta
-- restricción existe para que ningún camino alternativo (SQL manual, otro
-- cliente) deje un 0 o un negativo que el resto del sistema no sabe leer.
ALTER TABLE "competitions"
  ADD CONSTRAINT "competitions_max_swimmers_positive"
  CHECK ("max_swimmers" IS NULL OR "max_swimmers" > 0);

ALTER TABLE "competitions"
  ADD CONSTRAINT "competitions_max_swimmers_per_club_positive"
  CHECK ("max_swimmers_per_club" IS NULL OR "max_swimmers_per_club" > 0);
