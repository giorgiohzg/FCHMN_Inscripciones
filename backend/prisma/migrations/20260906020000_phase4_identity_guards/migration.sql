-- ===========================================================================
-- Hallazgo 20 (cierre) y hallazgo 19 (garantía en base).
--
-- Cuatro huecos que la migración anterior dejó abiertos:
--
--  1. `username_reservations` guarda el TITULAR de cada nombre
--     (`owner_kind` + `owner_id`), pero los disparadores solo escuchan
--     `username` y `deleted_at`. Cambiar `users.person_id`, `users.club_id` o
--     `users.owner_type` dejaba la reserva apuntando al titular anterior, sin
--     que nada lo advirtiera.
--
--     DECISIÓN: esas tres columnas son INMUTABLES.
--
--  2. `users.username` podía no coincidir con el de su titular.
--
--     DECISIÓN: deben ser iguales. El nombre de usuario es UNO por titular —es
--     lo que significa "única fuente de verdad"— y la cuenta es su credencial,
--     no una identidad aparte. La aplicación ya lo hacía
--     (`createCredentials` copia `person.username`; `createClubCredentials`,
--     `club.username`); lo que faltaba era que la base lo exigiera.
--
--  3. y 4. "Un solo representante legal por club" y "una persona pertenece a
--     un solo club" vivían solo en `clubs.service`. Una escritura directa las
--     saltaba, y dos solicitudes simultáneas también.
--
-- ---------------------------------------------------------------------------
-- ANTES de crear nada se VALIDA el estado histórico. Un índice único o un
-- disparador que se crean sobre datos que ya los incumplen abortan la
-- migración con un error del motor que no dice qué fila la causó. Cada bloque
-- de abajo se detiene con el detalle.
--
-- CORRESPONDENCIA CON EL PREFLIGHT (`npm run migrate:preflight`):
--
--   VALIDACIÓN 1 -> comprobación `representantes-legales-multiples`
--   VALIDACIÓN 2 -> comprobación `persona-en-varios-clubes`
--   VALIDACIÓN 3 -> comprobación `reservas-de-username-incoherentes`, que solo
--                   se ejecuta si `username_reservations` YA existe. En una
--                   base anterior a `phase4_user_identity` la tabla no está y
--                   la comprobación se reporta como "NO APLICA": ahí no hay
--                   nada que revisar, porque la tabla se crea y se carga en
--                   esa misma migración, que verifica su propia carga. El
--                   preflight solo cubre este caso al re-ejecutarse sobre una
--                   base que ya pasó por `phase4_user_identity` — que es
--                   justamente cuando puede haber una reserva corrompida.
--   VALIDACIÓN 4 -> comprobación `cuenta-username-distinto-al-titular`
-- ===========================================================================

-- --------------------------------------------------------------------------
-- VALIDACIÓN 1 — más de un representante legal en el mismo club.
-- --------------------------------------------------------------------------
DO $v_replegal$
DECLARE
  v_detalle TEXT;
BEGIN
  SELECT string_agg(c.name || ' (' || d.cuantos || ')', ', ')
    INTO v_detalle
    FROM (SELECT club_id, count(*) AS cuantos
            FROM club_staff WHERE role_type = 'legal_representative'
           GROUP BY club_id HAVING count(*) > 1) d
    JOIN clubs c ON c.id = d.club_id;

  IF v_detalle IS NOT NULL THEN
    RAISE EXCEPTION
      'Hay clubes con más de un representante legal (%). Deje uno por club antes de migrar; ver la comprobación "representantes-legales-multiples" del preflight.',
      v_detalle;
  END IF;
END;
$v_replegal$;

-- --------------------------------------------------------------------------
-- VALIDACIÓN 2 — personas que son personal de más de un club.
-- --------------------------------------------------------------------------
DO $v_multiclub$
DECLARE
  v_detalle TEXT;
BEGIN
  SELECT string_agg(p.full_name || ' (' || d.clubes || ' clubes)', ', ')
    INTO v_detalle
    FROM (SELECT person_id, count(DISTINCT club_id) AS clubes
            FROM club_staff GROUP BY person_id HAVING count(DISTINCT club_id) > 1) d
    JOIN persons p ON p.id = d.person_id;

  IF v_detalle IS NOT NULL THEN
    RAISE EXCEPTION
      'Hay personas vinculadas como personal a más de un club (%). Deje un solo club por persona antes de migrar; ver "persona-en-varios-clubes" del preflight.',
      v_detalle;
  END IF;
END;
$v_multiclub$;

-- --------------------------------------------------------------------------
-- VALIDACIÓN 3 — el registro de nombres describe a los titulares REALES.
--
-- Es la validación que hay que hacer ANTES de congelar la propiedad: a partir
-- del disparador de inmutabilidad, una reserva que apunte al titular
-- equivocado ya no se puede arreglar cambiando el dueño de la cuenta. Se
-- comprueba en las dos direcciones —ningún titular vigente sin su reserva
-- correcta, y ninguna reserva sin titular vigente— porque un huérfano en
-- cualquiera de los dos lados retiene un nombre que nadie puede liberar.
-- --------------------------------------------------------------------------
DO $v_reservas$
DECLARE
  v_sin_reserva INT;
  v_huerfanas   INT;
  v_detalle     TEXT;
BEGIN
  WITH titulares AS (
    SELECT p.username, 'person'::text AS owner_kind, p.id::text AS owner_id
      FROM persons p WHERE p.deleted_at IS NULL
    UNION
    SELECT c.username, 'club', c.id::text
      FROM clubs c WHERE c.deleted_at IS NULL
    UNION
    SELECT u.username,
           CASE WHEN u.person_id IS NOT NULL THEN 'person'
                WHEN u.club_id   IS NOT NULL THEN 'club'
                ELSE 'system' END,
           COALESCE(u.person_id, u.club_id, u.id)::text
      FROM users u WHERE u.deleted_at IS NULL
  )
  SELECT count(*), string_agg(t.username || ' -> ' || t.owner_kind || ' ' || t.owner_id, ', ')
    INTO v_sin_reserva, v_detalle
    FROM titulares t
    LEFT JOIN username_reservations r ON r.username = t.username
   WHERE r.username IS NULL
      OR r.owner_kind IS DISTINCT FROM t.owner_kind
      OR r.owner_id   IS DISTINCT FROM t.owner_id;

  IF v_sin_reserva > 0 THEN
    RAISE EXCEPTION
      'El registro de nombres de usuario no coincide con sus titulares en % caso(s) (%). Reconstrúyalo antes de congelar la propiedad de las cuentas.',
      v_sin_reserva, v_detalle;
  END IF;

  SELECT count(*) INTO v_huerfanas
    FROM username_reservations r
   WHERE NOT EXISTS (SELECT 1 FROM persons p WHERE p.username = r.username AND p.deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM clubs   c WHERE c.username = r.username AND c.deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM users   u WHERE u.username = r.username AND u.deleted_at IS NULL);

  IF v_huerfanas > 0 THEN
    RAISE EXCEPTION
      'Hay % reserva(s) de nombre de usuario sin ningún titular vigente. Retienen nombres que nadie puede volver a usar: elimínelas antes de migrar.',
      v_huerfanas;
  END IF;
END;
$v_reservas$;

-- --------------------------------------------------------------------------
-- VALIDACIÓN 4 — cuentas cuyo nombre no es el de su titular.
--
-- Solo se exige a las cuentas VIGENTES. Una cuenta eliminada lógicamente es
-- historial: su nombre puede haber quedado desalineado, y de hecho el plan de
-- reversión de `phase4_user_identity` indica renombrarlas para liberar el
-- nombre. Lo que no puede pasar es que una de esas vuelva a estar vigente con
-- un nombre distinto del de su titular — eso lo impide el disparador de la
-- garantía 2, que también se dispara al reactivarlas.
-- --------------------------------------------------------------------------
DO $v_username_titular$
DECLARE
  v_detalle TEXT;
BEGIN
  SELECT string_agg(u.username || ' (titular: ' || COALESCE(p.username, c.username) || ')', ', ')
    INTO v_detalle
    FROM users u
    LEFT JOIN persons p ON p.id = u.person_id
    LEFT JOIN clubs   c ON c.id = u.club_id
   WHERE u.deleted_at IS NULL
     AND ((u.person_id IS NOT NULL AND u.username IS DISTINCT FROM p.username)
       OR (u.club_id   IS NOT NULL AND u.username IS DISTINCT FROM c.username));

  IF v_detalle IS NOT NULL THEN
    RAISE EXCEPTION
      'Hay cuentas cuyo nombre de usuario no es el de su titular (%). Iguálelos antes de migrar; ver "cuenta-username-distinto-al-titular" del preflight.',
      v_detalle;
  END IF;
END;
$v_username_titular$;

-- ===========================================================================
-- GARANTÍAS
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. El dueño de una cuenta de acceso no se puede cambiar.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION users_forbid_owner_reassignment()
RETURNS trigger AS $fn$
BEGIN
  IF NEW.owner_type IS DISTINCT FROM OLD.owner_type
     OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.club_id   IS DISTINCT FROM OLD.club_id THEN
    RAISE EXCEPTION
      'El dueño de una cuenta de acceso no se puede cambiar (cuenta %: % -> %). Elimine la cuenta y cree una nueva para el titular correcto.',
      OLD.id, OLD.owner_type, NEW.owner_type
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER users_forbid_owner_reassignment
BEFORE UPDATE OF owner_type, person_id, club_id ON users
FOR EACH ROW EXECUTE FUNCTION users_forbid_owner_reassignment();

-- ---------------------------------------------------------------------------
-- 2. El nombre de una cuenta VIGENTE es el de su titular.
--
--    Se comprueba en tres momentos, y los tres hacen falta:
--
--      - INSERT: la cuenta nace con el nombre de su titular.
--      - UPDATE OF username: no se la puede renombrar apartándola de él.
--      - UPDATE OF deleted_at: una cuenta eliminada SÍ puede tener un nombre
--        desalineado (es historial, y el plan de reversión de
--        `phase4_user_identity` indica renombrarlas para liberar el nombre),
--        así que al REACTIVARLA hay que volver a exigir la igualdad. Sin este
--        tercer caso quedaba una puerta abierta: renombrar una cuenta
--        eliminada y después ponerle `deleted_at = NULL`, que no toca
--        `username` y por lo tanto no disparaba nada.
--
--    Los cambios del TITULAR se cubren aparte, en la garantía 5: renombrar a
--    una persona o a un club con cuenta vigente está prohibido.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION users_username_igual_al_titular()
RETURNS trigger AS $fn$
DECLARE
  v_titular TEXT;
BEGIN
  -- Una cuenta eliminada lógicamente no tiene que cumplir la igualdad.
  IF NEW.deleted_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  /**
   * El nombre del titular se lee TOCANDO su fila, no con un SELECT.
   *
   * Con una lectura simple quedaba una carrera entre esta operación y el
   * renombrado del titular: la cuenta leía el nombre viejo, la otra
   * transacción renombraba sin ver la cuenta todavía no confirmada —su propia
   * comprobación mira `users`, donde aún no hay nada—, y las dos confirmaban.
   * Resultado: cuenta vigente con un nombre que ya no es el de su titular,
   * exactamente lo que este disparador existe para impedir.
   *
   * `UPDATE ... RETURNING` cierra las dos puntas a la vez: serializa sobre la
   * fila del titular —el renombrado es también un UPDATE de esa fila, así que
   * una de las dos espera— y devuelve el nombre ya bajo ese cerrojo. Y como
   * modifica la fila de verdad, bajo REPEATABLE READ el perdedor aborta con
   * 40001 en vez de continuar con su instantánea, igual que en
   * `club_staff_un_solo_club_por_persona`.
   */
  IF NEW.person_id IS NOT NULL THEN
    UPDATE persons SET updated_at = updated_at WHERE id = NEW.person_id RETURNING username INTO v_titular;
  ELSIF NEW.club_id IS NOT NULL THEN
    UPDATE clubs SET updated_at = updated_at WHERE id = NEW.club_id RETURNING username INTO v_titular;
  ELSE
    RETURN NEW; -- cuenta del sistema: no tiene titular del que copiar.
  END IF;

  IF NEW.username IS DISTINCT FROM v_titular THEN
    RAISE EXCEPTION
      'El nombre de usuario de una cuenta vigente debe ser el de su titular (se intentó "%", el titular es "%").',
      NEW.username, v_titular
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER users_username_igual_al_titular
BEFORE INSERT OR UPDATE OF username, deleted_at ON users
FOR EACH ROW EXECUTE FUNCTION users_username_igual_al_titular();

-- ---------------------------------------------------------------------------
-- 5. Un titular con cuenta VIGENTE no se puede renombrar.
--
--    El disparador anterior solo escucha `users`: un `UPDATE persons SET
--    username = ...` volvía a separar los dos nombres sin que nada lo
--    advirtiera, y como el dueño de la cuenta es inmutable (garantía 1) ya no
--    había forma de recomponerlo salvo eliminando la cuenta.
--
--    REGLA ELEGIDA: se prohíbe el renombrado SOLO cuando existe una cuenta
--    vigente, no siempre. Una persona o un club sin credenciales todavía se
--    puede renombrar por base de datos, que es lo que necesitan las
--    remediaciones del preflight (`username-colision-global`) y la
--    recuperación de un respaldo. Con cuenta vigente, primero hay que
--    eliminarla; su nombre de acceso no puede cambiar bajo los pies de quien
--    lo usa para entrar.
--
--    Este disparador no necesita tomar ningún cerrojo por su cuenta: la
--    sentencia que lo dispara ya es un UPDATE de la fila del titular, que es
--    la misma fila que toca el disparador de la garantía 2 al crear o
--    reactivar una cuenta. Esa fila es el punto de encuentro de las dos
--    operaciones, y por eso no pueden colarse en paralelo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION titular_forbid_rename_con_cuenta()
RETURNS trigger AS $fn$
DECLARE
  v_cuenta TEXT;
BEGIN
  IF NEW.username IS NOT DISTINCT FROM OLD.username THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'persons' THEN
    SELECT u.username INTO v_cuenta FROM users u WHERE u.person_id = NEW.id AND u.deleted_at IS NULL;
  ELSE
    SELECT u.username INTO v_cuenta FROM users u WHERE u.club_id = NEW.id AND u.deleted_at IS NULL;
  END IF;

  IF v_cuenta IS NOT NULL THEN
    RAISE EXCEPTION
      'No se puede cambiar el nombre de usuario de % porque tiene una cuenta de acceso vigente ("%"): es el nombre con el que entra al sistema. Elimine la cuenta primero.',
      TG_TABLE_NAME, v_cuenta
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER persons_forbid_rename_con_cuenta
BEFORE UPDATE OF username ON persons
FOR EACH ROW EXECUTE FUNCTION titular_forbid_rename_con_cuenta();

CREATE TRIGGER clubs_forbid_rename_con_cuenta
BEFORE UPDATE OF username ON clubs
FOR EACH ROW EXECUTE FUNCTION titular_forbid_rename_con_cuenta();

-- ---------------------------------------------------------------------------
-- 3. Como máximo UN representante legal por club.
--
--    Delegados y entrenadores pueden ser varios; el representante legal no.
--    El índice es parcial sobre el tipo de cargo, así que no toca a los otros.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "club_staff_unique_legal_representative"
  ON "club_staff" ("club_id")
  WHERE "role_type" = 'legal_representative';

-- ---------------------------------------------------------------------------
-- 4. Una persona es personal de UN SOLO club, cualquiera sea el cargo.
--
--    No se puede expresar como índice único: la misma persona SÍ puede tener
--    dos cargos en el MISMO club, así que un único sobre `person_id` sería
--    demasiado estricto. Lo que hay que impedir es que sus filas apunten a
--    clubes distintos.
--
--    El bloqueo de la fila de `persons` es lo que lo hace seguro entre
--    solicitudes simultáneas: dos inserciones para la misma persona se
--    serializan ahí, y la segunda ve ya escrita a la primera en vez de leer
--    un estado anterior y concluir que no hay conflicto.
--
--    POR QUÉ UN `UPDATE` Y NO UN `SELECT ... FOR UPDATE`.
--
--    Con `FOR UPDATE` la garantía solo valía bajo READ COMMITTED, que es el
--    nivel predeterminado y el que usa la aplicación. Bajo REPEATABLE READ
--    fallaba en silencio: `FOR UPDATE` no modifica la fila, así que al
--    confirmar la primera transacción no hay conflicto de serialización que
--    detectar, y la segunda continúa con su instantánea —anterior a la
--    inserción de la primera— y concluye que no hay otro club. Comprobado:
--    con `FOR UPDATE`, las dos inserciones prosperaban.
--
--    Tocar realmente la fila cambia eso: bajo REPEATABLE READ, actualizar una
--    fila que otra transacción acaba de actualizar aborta con 40001, y bajo
--    READ COMMITTED se comporta igual que antes. La garantía deja de depender
--    del nivel de aislamiento. El costo es una escritura sin cambio de valor
--    sobre `persons` por cada alta de personal, que es una operación
--    infrecuente; se toca `updated_at` a propósito para no disparar los
--    disparadores de `username`, que escuchan otras columnas.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION club_staff_un_solo_club_por_persona()
RETURNS trigger AS $fn$
DECLARE
  v_otro_club TEXT;
BEGIN
  -- Serializa por persona: la transacción concurrente espera aquí, y bajo
  -- REPEATABLE READ aborta en vez de continuar con datos viejos.
  UPDATE persons SET updated_at = updated_at WHERE id = NEW.person_id;

  SELECT cs.club_id INTO v_otro_club
    FROM club_staff cs
   WHERE cs.person_id = NEW.person_id
     AND cs.club_id <> NEW.club_id
   LIMIT 1;

  IF v_otro_club IS NOT NULL THEN
    RAISE EXCEPTION
      'Una persona solo puede ser delegado, entrenador o representante legal de un club a la vez (ya pertenece al club %).',
      v_otro_club
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER club_staff_un_solo_club_por_persona
BEFORE INSERT OR UPDATE OF person_id, club_id ON club_staff
FOR EACH ROW EXECUTE FUNCTION club_staff_un_solo_club_por_persona();
