-- El nombre de usuario de personas y clubes pasa a ser OPCIONAL.
--
-- Hasta aquí era `TEXT NOT NULL` en `persons` y `clubs`: registrar a alguien
-- obligaba a inventarle un nombre de acceso aunque nunca fuera a tener cuenta.
-- Ahora la ausencia es `NULL` —y solo `NULL`: nunca una cadena vacía— y el
-- nombre se puede asignar más tarde, a más tardar al crear las credenciales.
--
-- `users.username` NO cambia: una cuenta de acceso siempre tiene nombre.
--
-- NINGÚN NOMBRE SE BORRA, GENERA NI REESCRIBE. Quitar `NOT NULL` no toca los
-- datos. Las restricciones nuevas solo se pueden crear si ninguna fila las
-- incumple, así que antes se comprueba y, si hay alguna, la migración se
-- DETIENE con el detalle en vez de corregirla por su cuenta.
--
-- Lo que NO cambia, y sigue garantizando la identidad:
--   - `persons_username_unique_active` / `clubs_username_unique_active`:
--     PostgreSQL considera distintos los NULL, así que varios titulares sin
--     nombre conviven sin tocar estos índices.
--   - `users_username_igual_al_titular`: una cuenta vigente debe llamarse como
--     su titular; con el titular en NULL, la cuenta no puede nacer.
--   - `titular_forbid_rename_con_cuenta`: con una cuenta vigente (activa,
--     bloqueada o inhabilitada) el nombre del titular no se puede cambiar NI
--     QUITAR, porque pasar a NULL también es cambiarlo.
--
-- Correspondencia con el preflight (`npm run preflight:migration`):
--   VALIDACIÓN 1 -> comprobación `username-vacio`

-- --------------------------------------------------------------------------
-- VALIDACIÓN 1 — nombres de usuario vacíos o de solo espacios en blanco.
--
-- Con `NOT NULL` no había otra forma de "no tener nombre" que una cadena vacía,
-- y la restricción de abajo la prohíbe. Se usa una expresión regular y no
-- `btrim`, porque `btrim` solo recorta espacios y dejaría pasar tabuladores.
-- --------------------------------------------------------------------------
DO $v_username$
DECLARE
  v_detalle TEXT;
BEGIN
  SELECT string_agg(t.detalle, ', ')
    INTO v_detalle
    FROM (
      SELECT 'persona ' || p.full_name || ' (' || p.id || ')' AS detalle FROM persons p WHERE p.username ~ '^\s*$'
      UNION ALL
      SELECT 'club ' || c.name || ' (' || c.id || ')' FROM clubs c WHERE c.username ~ '^\s*$'
    ) t;

  IF v_detalle IS NOT NULL THEN
    RAISE EXCEPTION
      'Hay nombres de usuario vacíos (%). Asígneles un nombre real antes de migrar; ver la comprobación "username-vacio" del preflight. La migración no los modifica.',
      v_detalle;
  END IF;
END;
$v_username$;

-- 1. Se admite NULL en los titulares.
ALTER TABLE "persons" ALTER COLUMN "username" DROP NOT NULL;
ALTER TABLE "clubs"   ALTER COLUMN "username" DROP NOT NULL;

-- 2. La ausencia es SOLO NULL. Una cadena vacía no puede competir por un índice
--    único ni por la reserva global. El FORMATO completo (4-30 caracteres,
--    letras, números, puntos y guiones) lo sigue exigiendo la API, como hasta
--    ahora: llevarlo a la base habría bloqueado la migración de cualquier base
--    con nombres anteriores a esa regla (la base de la versión previa que
--    reproduce `migration-upgrade.integration.test.ts` tiene uno de 3 letras),
--    y esta migración no corrige datos.
ALTER TABLE "persons"
  ADD CONSTRAINT "persons_username_no_vacio" CHECK ("username" IS NULL OR "username" !~ '^\s*$');
ALTER TABLE "clubs"
  ADD CONSTRAINT "clubs_username_no_vacio" CHECK ("username" IS NULL OR "username" !~ '^\s*$');

-- 3. La reserva global ignora NULL.
--
--    `username_reservations.username` es la clave primaria: reservar NULL
--    fallaría. Sin nombre no hay nada que reservar. Liberar NULL tampoco tiene
--    sentido (y no coincidiría con ninguna fila); se corta explícitamente.
--
--    Los disparadores de `persons`, `clubs` y `users` no cambian: siguen
--    reservando el nombre nuevo y liberando el anterior. Con estas dos funciones
--    eso cubre los cuatro casos —asignar (NULL -> nombre), cambiar, quitar
--    (nombre -> NULL) y eliminar lógicamente— sin ramas nuevas.
CREATE OR REPLACE FUNCTION username_registry_reserve(p_username TEXT, p_kind TEXT, p_id TEXT)
RETURNS void AS $fn$
DECLARE
  v_kind TEXT;
  v_id   TEXT;
BEGIN
  IF p_username IS NULL THEN
    RETURN;
  END IF;

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

CREATE OR REPLACE FUNCTION username_registry_release(p_username TEXT)
RETURNS void AS $fn$
BEGIN
  IF p_username IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM username_reservations r
   WHERE r.username = p_username
     AND NOT EXISTS (SELECT 1 FROM persons p WHERE p.username = r.username AND p.deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM clubs   c WHERE c.username = r.username AND c.deleted_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM users   u WHERE u.username = r.username AND u.deleted_at IS NULL);
END;
$fn$ LANGUAGE plpgsql;

COMMENT ON COLUMN "persons"."username" IS
  'Nombre de acceso OPCIONAL. NULL = sin nombre; nunca vacio. Editable mientras no haya cuenta vigente; despues, inmutable.';
COMMENT ON COLUMN "clubs"."username" IS
  'Nombre de acceso OPCIONAL. NULL = sin nombre; nunca vacio. Editable mientras no haya cuenta vigente; despues, inmutable.';
