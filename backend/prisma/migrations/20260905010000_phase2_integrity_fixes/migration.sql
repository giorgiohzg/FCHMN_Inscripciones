-- ===========================================================================
-- Fase 2 (reapertura) — cierre de huecos detectados en la revisión
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. El disparador que deriva `competition_sessions.competition_id` solo se
--    ejecutaba en INSERT y en UPDATE OF competition_date_id. Un UPDATE
--    directo de `competition_id` no lo activaba, así que bastaba
--
--        UPDATE competition_sessions SET competition_id = '<otra>' WHERE ...
--
--    para desalinear la jornada de su fecha y burlar la clave foránea
--    compuesta que protege la coherencia competencia↔jornada: la fila pasaba
--    a "pertenecer" a una competencia que no es la de su fecha.
--
--    Ahora el disparador se ejecuta en CUALQUIER update y siempre recalcula
--    el valor desde `competition_dates`, ignorando lo que traiga la
--    sentencia. La columna deja de ser escribible en la práctica.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS competition_sessions_set_competition_id ON "competition_sessions";

CREATE TRIGGER competition_sessions_set_competition_id
  BEFORE INSERT OR UPDATE ON "competition_sessions"
  FOR EACH ROW EXECUTE FUNCTION set_competition_session_competition_id();

-- Cierre del otro extremo: si alguna vez se moviera una FECHA a otra
-- competencia, sus jornadas quedarían apuntando a la anterior. Se
-- re-sincronizan automáticamente.
CREATE OR REPLACE FUNCTION resync_sessions_after_date_moved() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."competition_id" IS DISTINCT FROM OLD."competition_id" THEN
    UPDATE "competition_sessions"
       SET "competition_id" = NEW."competition_id"
     WHERE "competition_date_id" = NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS competition_dates_resync_sessions ON "competition_dates";

CREATE TRIGGER competition_dates_resync_sessions
  AFTER UPDATE OF "competition_id" ON "competition_dates"
  FOR EACH ROW EXECUTE FUNCTION resync_sessions_after_date_moved();

-- ---------------------------------------------------------------------------
-- 2. Hallazgo 13 — faltaba `category_groups.name`, que conservaba unicidad
--    TOTAL pese a tener `deleted_at`: eliminar el grupo "Master FINA" y
--    volver a crearlo fallaba con P2002 contra una fila ya retirada.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS "category_groups_name_key";
CREATE UNIQUE INDEX "category_groups_name_unique_active"
  ON "category_groups" ("name")
  WHERE "deleted_at" IS NULL;
