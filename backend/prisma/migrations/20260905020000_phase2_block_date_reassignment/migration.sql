-- ===========================================================================
-- Fase 2 (reapertura 2) — mover una fecha entre competencias deja de ser
-- posible, en vez de propagarse en silencio.
--
-- Qué estaba mal: la migración anterior agregó
-- `resync_sessions_after_date_moved`, que ante un cambio de
-- `competition_dates.competition_id` actualizaba las jornadas de esa fecha
-- para "mantener la coherencia". El efecto real era el contrario de lo
-- buscado: como la clave foránea compuesta de `competition_events` está
-- declarada ON UPDATE CASCADE, al cambiar el `competition_id` de las
-- jornadas se arrastraban también las pruebas de competencia y, con ellas,
-- todo su historial de inscripciones. Una sola sentencia
--
--     UPDATE competition_dates SET competition_id = '<otra>' WHERE id = '...'
--
-- movía una jornada completa, sus pruebas y las inscripciones ya registradas
-- a otra competencia, sin auditoría y sin que ninguna validación se enterara.
-- El disparador convertía una inconsistencia detectable en una migración de
-- datos silenciosa.
--
-- Decisión: la operación NO está soportada por el sistema. Una fecha
-- pertenece a la competencia bajo la que se creó; para "moverla" hay que
-- crear la fecha en la competencia de destino y retirar la anterior, que es
-- justamente el flujo que deja rastro. Se bloquea en la base de datos.
-- ===========================================================================

-- 1. Fuera el disparador que propagaba el cambio.
DROP TRIGGER IF EXISTS competition_dates_resync_sessions ON "competition_dates";
DROP FUNCTION IF EXISTS resync_sessions_after_date_moved();

-- 2. Cambiar la competencia de una fecha queda prohibido.
CREATE OR REPLACE FUNCTION forbid_competition_date_reassignment() RETURNS TRIGGER AS $$
DECLARE
  jornadas integer;
  pruebas integer;
BEGIN
  IF NEW."competition_id" IS DISTINCT FROM OLD."competition_id" THEN
    SELECT count(*) INTO jornadas FROM "competition_sessions" WHERE "competition_date_id" = OLD."id";
    SELECT count(*) INTO pruebas
      FROM "competition_events" ce
      JOIN "competition_sessions" s ON s."id" = ce."competition_session_id"
     WHERE s."competition_date_id" = OLD."id";

    RAISE EXCEPTION
      'No se puede cambiar la competencia de una fecha ya creada (fecha % con % jornada(s) y % prueba(s)). '
      'Mover la fecha arrastraría sus jornadas, pruebas e inscripciones a otra competencia sin dejar rastro. '
      'Cree la fecha en la competencia de destino y retire esta.',
      OLD."id", jornadas, pruebas
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER competition_dates_forbid_reassignment
  BEFORE UPDATE OF "competition_id" ON "competition_dates"
  FOR EACH ROW EXECUTE FUNCTION forbid_competition_date_reassignment();

-- 3. Segunda línea de defensa: la clave foránea compuesta deja de propagar
--    actualizaciones. Aunque alguien lograra cambiar el `competition_id` de
--    una jornada (hoy imposible: el disparador lo recalcula), las pruebas de
--    competencia no lo seguirían — la operación fallaría en vez de
--    reasignarlas.
ALTER TABLE "competition_events" DROP CONSTRAINT "competition_events_session_belongs_to_competition_fkey";
ALTER TABLE "competition_events"
  ADD CONSTRAINT "competition_events_session_belongs_to_competition_fkey"
  FOREIGN KEY ("competition_session_id", "competition_id")
  REFERENCES "competition_sessions" ("id", "competition_id")
  ON DELETE CASCADE ON UPDATE RESTRICT;
