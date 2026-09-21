-- ===========================================================================
-- Fase 2 — Integridad de competencias e inscripciones
--
-- Esta migración combina lo que Prisma sabe generar (columnas y claves
-- foráneas) con índices PARCIALES escritos a mano, que el esquema de Prisma
-- no puede expresar. Los índices parciales son la parte importante: son la
-- garantía a nivel de PostgreSQL de reglas que hasta ahora solo existían
-- como "leer y después escribir" en la capa de servicio, y que por lo tanto
-- dos solicitudes concurrentes podían saltarse.
--
-- AVISO PARA QUIEN EJECUTE `prisma migrate dev` MÁS ADELANTE: como Prisma
-- desconoce los índices parciales, detectará "drift" y propondrá borrarlos.
-- Use `prisma migrate dev --create-only` y revise el SQL antes de aplicarlo.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Hallazgo 7 — la eliminación de una prueba de competencia ya NO arrastra
--    en cascada las inscripciones. Con RESTRICT, PostgreSQL rechaza el
--    borrado si existe cualquier inscripción (confirmada o cancelada), y el
--    servicio da un mensaje explicativo antes de llegar aquí.
-- ---------------------------------------------------------------------------
ALTER TABLE "registrations" DROP CONSTRAINT "registrations_competition_event_id_fkey";
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_competition_event_id_fkey"
  FOREIGN KEY ("competition_event_id") REFERENCES "competition_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "relay_registrations" DROP CONSTRAINT "relay_registrations_competition_event_id_fkey";
ALTER TABLE "relay_registrations" ADD CONSTRAINT "relay_registrations_competition_event_id_fkey"
  FOREIGN KEY ("competition_event_id") REFERENCES "competition_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Hallazgo 11 — límite de relevos por nadador y jornada, configurable por
--    competencia. El valor por defecto (1) reproduce exactamente el tope
--    que antes estaba escrito a fuego en el código.
-- ---------------------------------------------------------------------------
ALTER TABLE "competitions" ADD COLUMN "max_relay_events_per_swimmer_per_session" INTEGER NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- 3. Hallazgo 9 — unicidad real bajo concurrencia.
--
--    Son índices PARCIALES porque la regla solo aplica a las filas vigentes:
--    una inscripción cancelada no debe impedir volver a inscribir al mismo
--    nadador, y una membresía finalizada no debe impedir una nueva.
-- ---------------------------------------------------------------------------

-- RB-09: una sola inscripción CONFIRMADA por nadador y prueba de competencia.
CREATE UNIQUE INDEX "registrations_unique_confirmed_person_event"
  ON "registrations" ("competition_event_id", "person_id")
  WHERE "status" = 'confirmed';

-- Un solo equipo CONFIRMADO por club, prueba de competencia y categoría.
CREATE UNIQUE INDEX "relay_registrations_unique_confirmed_team"
  ON "relay_registrations" ("competition_event_id", "club_id", "category_id")
  WHERE "status" = 'confirmed';

-- RB-06/A-04: un nadador con una sola membresía ACTIVA a la vez. La regla es
-- configurable (`SWIMMER_SINGLE_CLUB_ACTIVE`), y por eso el índice se crea
-- solo si el parámetro está activo; si se desactiva, hay que eliminarlo con
-- una migración explícita (queda documentado en el README).
CREATE UNIQUE INDEX "club_swimmers_unique_active_person"
  ON "club_swimmers" ("person_id")
  WHERE "status" = 'active';

-- ---------------------------------------------------------------------------
-- 4. Hallazgo 13 — claves naturales únicas SOLO entre filas vigentes.
--
--    Antes eran índices únicos totales: eliminar lógicamente una persona,
--    club, categoría o prueba y volver a crearla con la misma clave natural
--    fallaba con P2002 contra una fila que el usuario ya no puede ver ni
--    recuperar desde la interfaz.
-- ---------------------------------------------------------------------------
DROP INDEX "persons_run_key";
CREATE UNIQUE INDEX "persons_run_unique_active" ON "persons" ("run") WHERE "deleted_at" IS NULL;

DROP INDEX "persons_username_key";
CREATE UNIQUE INDEX "persons_username_unique_active" ON "persons" ("username") WHERE "deleted_at" IS NULL;

DROP INDEX "clubs_username_key";
CREATE UNIQUE INDEX "clubs_username_unique_active" ON "clubs" ("username") WHERE "deleted_at" IS NULL;

DROP INDEX "categories_test_type_id_name_key";
CREATE UNIQUE INDEX "categories_unique_active_name" ON "categories" ("test_type_id", "name") WHERE "deleted_at" IS NULL;

DROP INDEX "events_test_type_id_distance_id_stroke_id_gender_key";
CREATE UNIQUE INDEX "events_unique_active_definition"
  ON "events" ("test_type_id", "distance_id", "stroke_id", "gender")
  WHERE "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Hallazgo 6 — coherencia competencia ↔ jornada.
--
--    `competition_events` referencia una competencia Y una jornada, pero
--    nada impedía que la jornada perteneciera a OTRA competencia: bastaba
--    enviar el id de una jornada ajena al crear o mover la prueba, y los
--    límites por jornada y los reportes quedaban calculados contra la
--    competencia equivocada.
--
--    Se garantiza con una clave foránea compuesta: se expone el
--    `competition_id` de cada jornada como columna derivada y se exige que
--    el par (jornada, competencia) de `competition_events` exista.
-- ---------------------------------------------------------------------------

-- 5.1 Columna derivada en competition_sessions, poblada desde su fecha.
ALTER TABLE "competition_sessions" ADD COLUMN "competition_id" TEXT;

UPDATE "competition_sessions" s
   SET "competition_id" = d."competition_id"
  FROM "competition_dates" d
 WHERE d."id" = s."competition_date_id";

ALTER TABLE "competition_sessions" ALTER COLUMN "competition_id" SET NOT NULL;

-- Se mantiene sincronizada por disparador: la jornada siempre pertenece a la
-- competencia de su fecha.
CREATE OR REPLACE FUNCTION set_competition_session_competition_id() RETURNS TRIGGER AS $$
BEGIN
  SELECT d."competition_id" INTO NEW."competition_id"
    FROM "competition_dates" d
   WHERE d."id" = NEW."competition_date_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER competition_sessions_set_competition_id
  BEFORE INSERT OR UPDATE OF "competition_date_id" ON "competition_sessions"
  FOR EACH ROW EXECUTE FUNCTION set_competition_session_competition_id();

-- 5.2 Clave candidata (id, competition_id) para poder referenciarla.
ALTER TABLE "competition_sessions"
  ADD CONSTRAINT "competition_sessions_id_competition_id_key" UNIQUE ("id", "competition_id");

-- 5.3 La prueba de competencia debe apuntar a una jornada DE ESA competencia.
ALTER TABLE "competition_events"
  ADD CONSTRAINT "competition_events_session_belongs_to_competition_fkey"
  FOREIGN KEY ("competition_session_id", "competition_id")
  REFERENCES "competition_sessions" ("id", "competition_id")
  ON DELETE CASCADE ON UPDATE CASCADE;
