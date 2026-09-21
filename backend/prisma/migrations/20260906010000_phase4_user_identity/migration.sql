-- ===========================================================================
-- Hallazgo 20 — identidad de las cuentas de acceso y unicidad global del
-- nombre de usuario.
--
-- Tres problemas distintos, todos sobre lo mismo:
--
--  1. `users.owner_type` podía contradecir a `person_id` / `club_id`. El
--     administrador se guardaba como `person` sin persona, y nada impedía una
--     cuenta con persona Y club a la vez.
--
--  2. `users.username` tenía índice único TOTAL, mientras que
--     `persons.username` y `clubs.username` pasaron a unicidad PARCIAL en
--     `phase2_integrity`. La incoherencia se nota al eliminar lógicamente a
--     una persona: su nombre de usuario queda libre y se puede volver a
--     registrar, pero al pedir credenciales para la persona nueva el nombre
--     sigue ocupado por la cuenta de la persona eliminada. Sin forma de
--     renombrar (el nombre de usuario es inmutable), la única salida era
--     borrar y rehacer.
--
--  3. Nada impedía que una persona y un club tomaran el MISMO nombre de
--     usuario: son tablas distintas y PostgreSQL no tiene índices únicos entre
--     tablas. El choque aparecía recién al crear las credenciales de la
--     segunda, con el mismo callejón sin salida.
--
-- El punto 3 se resuelve con una reserva global (`username_reservations`)
-- mantenida por disparadores: cada nombre vigente tiene exactamente una fila y
-- su clave primaria es la garantía. La aplicación no escribe esa tabla.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Coherencia entre el tipo de dueño y las columnas que lo señalan.
-- ---------------------------------------------------------------------------

-- Respaldo de datos: las cuentas sin persona ni club son del sistema.
UPDATE "users"
   SET "owner_type" = 'system'
 WHERE "person_id" IS NULL
   AND "club_id" IS NULL
   AND "owner_type" <> 'system';

ALTER TABLE "users"
  ADD CONSTRAINT "users_owner_coherente" CHECK (
        ("owner_type" = 'person' AND "person_id" IS NOT NULL AND "club_id" IS NULL)
     OR ("owner_type" = 'club'   AND "club_id"   IS NOT NULL AND "person_id" IS NULL)
     OR ("owner_type" = 'system' AND "person_id" IS NULL     AND "club_id"   IS NULL)
  );

-- ---------------------------------------------------------------------------
-- 2. `users.username` único solo entre cuentas VIGENTES.
--
--    Mismo criterio que `persons_username_unique_active` y
--    `clubs_username_unique_active`: una cuenta eliminada lógicamente no
--    retiene el nombre de usuario.
-- ---------------------------------------------------------------------------
DROP INDEX "users_username_key";
CREATE UNIQUE INDEX "users_username_unique_active" ON "users" ("username") WHERE "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Reserva global de nombres de usuario.
-- ---------------------------------------------------------------------------
CREATE TABLE "username_reservations" (
    "username"   TEXT NOT NULL,
    "owner_kind" TEXT NOT NULL,
    "owner_id"   TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "username_reservations_pkey" PRIMARY KEY ("username")
);

ALTER TABLE "username_reservations"
  ADD CONSTRAINT "username_reservations_owner_kind_valido"
  CHECK ("owner_kind" IN ('person', 'club', 'system'));

CREATE INDEX "username_reservations_owner_kind_owner_id_idx"
  ON "username_reservations" ("owner_kind", "owner_id");

-- Reserva el nombre para un titular. Si ya está reservado por OTRO titular,
-- falla. Si lo está por el mismo, no hace nada: una persona y su cuenta de
-- acceso comparten titular y por lo tanto comparten reserva.
CREATE OR REPLACE FUNCTION username_registry_reserve(p_username TEXT, p_kind TEXT, p_id TEXT)
RETURNS void AS $fn$
DECLARE
  v_kind TEXT;
  v_id   TEXT;
BEGIN
  INSERT INTO username_reservations (username, owner_kind, owner_id)
  VALUES (p_username, p_kind, p_id)
  ON CONFLICT (username) DO NOTHING;

  SELECT owner_kind, owner_id INTO v_kind, v_id
    FROM username_reservations
   WHERE username = p_username;

  IF v_kind IS DISTINCT FROM p_kind OR v_id IS DISTINCT FROM p_id THEN
    RAISE EXCEPTION
      'El nombre de usuario "%" ya está en uso por otro titular (% %). Los nombres de usuario son únicos entre personas, clubes y cuentas de acceso.',
      p_username, v_kind, v_id
      USING ERRCODE = 'unique_violation';
  END IF;
END;
$fn$ LANGUAGE plpgsql;

-- Libera el nombre SOLO si ya no queda ningún titular vigente que lo use. Se
-- recalcula contra el estado final de las tres tablas, así que no depende del
-- orden en que se eliminen la persona/club y su cuenta dentro de una misma
-- transacción.
CREATE OR REPLACE FUNCTION username_registry_release(p_username TEXT)
RETURNS void AS $fn$
BEGIN
  DELETE FROM username_reservations r
   WHERE r.username = p_username
     AND NOT EXISTS (SELECT 1 FROM persons p WHERE p.username = r.username AND p.deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM clubs   c WHERE c.username = r.username AND c.deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM users   u WHERE u.username = r.username AND u.deleted_at IS NULL);
END;
$fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION persons_username_registry()
RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM username_registry_release(OLD.username);
    RETURN OLD;
  END IF;

  IF NEW.deleted_at IS NULL THEN
    PERFORM username_registry_reserve(NEW.username, 'person', NEW.id);
  END IF;

  IF TG_OP = 'UPDATE' AND (OLD.username IS DISTINCT FROM NEW.username OR NEW.deleted_at IS NOT NULL) THEN
    PERFORM username_registry_release(OLD.username);
  END IF;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION clubs_username_registry()
RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM username_registry_release(OLD.username);
    RETURN OLD;
  END IF;

  IF NEW.deleted_at IS NULL THEN
    PERFORM username_registry_reserve(NEW.username, 'club', NEW.id);
  END IF;

  IF TG_OP = 'UPDATE' AND (OLD.username IS DISTINCT FROM NEW.username OR NEW.deleted_at IS NOT NULL) THEN
    PERFORM username_registry_release(OLD.username);
  END IF;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

-- El titular de una cuenta es su persona o su club; si no tiene ninguno, es
-- ella misma (cuenta del sistema). Así la cuenta de una persona reserva bajo
-- el mismo titular que la persona y no choca con ella.
CREATE OR REPLACE FUNCTION users_username_registry()
RETURNS trigger AS $fn$
DECLARE
  v_kind TEXT;
  v_id   TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM username_registry_release(OLD.username);
    RETURN OLD;
  END IF;

  IF NEW.deleted_at IS NULL THEN
    v_kind := CASE
                WHEN NEW.person_id IS NOT NULL THEN 'person'
                WHEN NEW.club_id   IS NOT NULL THEN 'club'
                ELSE 'system'
              END;
    v_id := COALESCE(NEW.person_id, NEW.club_id, NEW.id);
    PERFORM username_registry_reserve(NEW.username, v_kind, v_id);
  END IF;

  IF TG_OP = 'UPDATE' AND (OLD.username IS DISTINCT FROM NEW.username OR NEW.deleted_at IS NOT NULL) THEN
    PERFORM username_registry_release(OLD.username);
  END IF;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

-- Carga inicial: se reserva lo que ya existe, en el mismo orden de prioridad
-- que usan los disparadores. Si hubiera colisiones previas, esta migración
-- falla aquí — el preflight las detecta antes (`username-colision-global`).
INSERT INTO username_reservations (username, owner_kind, owner_id)
SELECT p.username, 'person', p.id FROM persons p WHERE p.deleted_at IS NULL
ON CONFLICT (username) DO NOTHING;

INSERT INTO username_reservations (username, owner_kind, owner_id)
SELECT c.username, 'club', c.id FROM clubs c WHERE c.deleted_at IS NULL
ON CONFLICT (username) DO NOTHING;

INSERT INTO username_reservations (username, owner_kind, owner_id)
SELECT u.username,
       CASE WHEN u.person_id IS NOT NULL THEN 'person'
            WHEN u.club_id   IS NOT NULL THEN 'club'
            ELSE 'system' END,
       COALESCE(u.person_id, u.club_id, u.id)
  FROM users u WHERE u.deleted_at IS NULL
ON CONFLICT (username) DO NOTHING;

-- Verificación de la carga inicial: si algún titular vigente quedó sin su
-- reserva, o con una reserva a nombre de otro, la migración se detiene aquí en
-- vez de dejar el registro incompleto y los disparadores fallando después.
DO $verificacion$
DECLARE
  v_conflictos INT;
BEGIN
  SELECT count(*) INTO v_conflictos
    FROM (
      SELECT p.username, 'person' AS k, p.id AS i FROM persons p WHERE p.deleted_at IS NULL
      UNION ALL
      SELECT c.username, 'club', c.id FROM clubs c WHERE c.deleted_at IS NULL
      UNION ALL
      SELECT u.username,
             CASE WHEN u.person_id IS NOT NULL THEN 'person'
                  WHEN u.club_id   IS NOT NULL THEN 'club'
                  ELSE 'system' END,
             COALESCE(u.person_id, u.club_id, u.id)
        FROM users u WHERE u.deleted_at IS NULL
    ) titulares
    LEFT JOIN username_reservations r ON r.username = titulares.username
   WHERE r.username IS NULL
      OR r.owner_kind IS DISTINCT FROM titulares.k
      OR r.owner_id   IS DISTINCT FROM titulares.i;

  IF v_conflictos > 0 THEN
    RAISE EXCEPTION
      'Hay % nombres de usuario compartidos por titulares distintos. Ejecute el preflight (npm run migrate:preflight) y resuelva "username-colision-global" antes de migrar.',
      v_conflictos;
  END IF;
END;
$verificacion$;

CREATE TRIGGER persons_username_registry
AFTER INSERT OR UPDATE OF username, deleted_at OR DELETE ON persons
FOR EACH ROW EXECUTE FUNCTION persons_username_registry();

CREATE TRIGGER clubs_username_registry
AFTER INSERT OR UPDATE OF username, deleted_at OR DELETE ON clubs
FOR EACH ROW EXECUTE FUNCTION clubs_username_registry();

CREATE TRIGGER users_username_registry
AFTER INSERT OR UPDATE OF username, deleted_at OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION users_username_registry();
