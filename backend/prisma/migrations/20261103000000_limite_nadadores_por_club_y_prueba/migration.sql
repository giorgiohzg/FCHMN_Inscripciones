-- Máximo de nadadores por club en una PRUEBA INDIVIDUAL de una competencia.
--
-- Columna nueva, ADITIVA y anulable, SIN valor por omisión: `NULL` significa
-- «Sin límite», que es el comportamiento de siempre. Toda prueba que ya existe
-- queda sin límite; ninguna fila se modifica ni se pierde nada, y por eso no hay
-- validación previa.
--
-- El `CHECK` garantiza lo mismo que la API: con valor, un entero POSITIVO. Ninguna
-- fila anterior puede incumplirlo porque todas valen `NULL`.
--
-- Es independiente de los cupos de la competencia (`competitions.max_swimmers` y
-- `competitions.max_swimmers_per_club`), que cuentan nadadores distintos en toda
-- la competencia. Este cuenta las inscripciones confirmadas del club EN ESA prueba.
--
-- Reducirlo por debajo de lo ya inscrito no borra ni cancela nada: solo restringe
-- las altas posteriores. Solo tiene sentido para pruebas individuales; que no se
-- use en relevos lo exige la API (la base no conoce el tipo de la prueba).

ALTER TABLE "competition_events" ADD COLUMN "max_swimmers_per_club" INTEGER;

ALTER TABLE "competition_events"
  ADD CONSTRAINT "competition_events_max_swimmers_per_club_positivo"
  CHECK ("max_swimmers_per_club" IS NULL OR "max_swimmers_per_club" >= 1);
