-- Competencia por defecto de los paneles de Inscripción y de Relevos.
--
-- Aditiva: una columna con valor por omisión `false`. Ninguna competencia existente queda
-- marcada (no se elige una histórica automáticamente); la administración la marca después.
ALTER TABLE "competitions" ADD COLUMN "es_predeterminada" BOOLEAN NOT NULL DEFAULT false;

-- Como máximo UNA competencia predeterminada, también ante escrituras simultáneas: índice
-- único parcial sobre una expresión constante, que solo contiene las filas marcadas.
CREATE UNIQUE INDEX "competitions_una_predeterminada" ON "competitions" ((true)) WHERE "es_predeterminada";
