-- ===========================================================================
-- PLAN DE REVERSIÓN de `phase4_user_identity` (y de `phase4_owner_type_system`
-- en lo que se puede revertir).
--
-- Prisma no ejecuta este archivo: solo lee `migration.sql`. Está aquí para que
-- la reversión sea un procedimiento escrito y probado, no una improvisación.
-- `tests/migration-upgrade.integration.test.ts` lo ejecuta de verdad para
-- volver la base al estado anterior y luego migrar otra vez, así que si deja
-- de servir, esa prueba falla.
--
-- Después de ejecutarlo hay que borrar las dos filas correspondientes de
-- `_prisma_migrations` para que Prisma vuelva a considerarlas pendientes.
--
-- LO QUE NO SE PUEDE REVERTIR: el valor 'system' del enum `OwnerType`.
-- PostgreSQL no permite eliminar valores de un enum. Por eso el paso 1
-- devuelve las cuentas afectadas a 'person', que es como estaban antes: el
-- valor queda declarado pero sin usar, y el esquema anterior vuelve a
-- funcionar. Es inocuo mientras nadie lo use.
-- ===========================================================================

-- 1. Cuentas del sistema vuelven a su representación anterior (`person` sin
--    persona), que es la que entiende el código previo.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_owner_coherente";
UPDATE "users" SET "owner_type" = 'person' WHERE "owner_type" = 'system';

-- 2. Disparadores y funciones del registro de nombres de usuario.
DROP TRIGGER IF EXISTS "persons_username_registry" ON "persons";
DROP TRIGGER IF EXISTS "clubs_username_registry" ON "clubs";
DROP TRIGGER IF EXISTS "users_username_registry" ON "users";
DROP FUNCTION IF EXISTS persons_username_registry();
DROP FUNCTION IF EXISTS clubs_username_registry();
DROP FUNCTION IF EXISTS users_username_registry();
DROP FUNCTION IF EXISTS username_registry_reserve(TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS username_registry_release(TEXT);

-- 3. La reserva global. No contiene información propia: se reconstruye entera
--    desde `persons`, `clubs` y `users` si se vuelve a migrar.
DROP TABLE IF EXISTS "username_reservations";

-- 4. `users.username` vuelve a su índice único TOTAL.
--
--    ESTA REVERSIÓN ES CONDICIONAL. No es una advertencia teórica: reutilizar
--    el nombre de usuario de una cuenta eliminada lógicamente es precisamente
--    lo que la migración vino a habilitar, así que cualquier instalación que
--    haya usado esa función tendrá nombres repetidos entre cuentas —una
--    vigente y una o más eliminadas— y el índice TOTAL no los admite.
--
--    El bloque siguiente lo detecta y detiene la reversión con un mensaje
--    explícito, en vez de fallar más abajo con un error de índice duplicado
--    que no dice qué hacer.
--
--    CÓMO DESBLOQUEARLO (decisión del operador, no automatizable):
--      a) renombrar las cuentas ELIMINADAS que retienen el nombre
--         (UPDATE users SET username = username || '_' || id WHERE deleted_at IS NOT NULL AND ...), o
--      b) eliminarlas físicamente, aceptando que se pierde ese historial.
--    La opción (a) conserva la trazabilidad y es la recomendada.
DO $reversion_condicional$
DECLARE
  v_repetidos INT;
  v_detalle   TEXT;
BEGIN
  SELECT count(*), string_agg(username, ', ')
    INTO v_repetidos, v_detalle
    FROM (SELECT username FROM users GROUP BY username HAVING count(*) > 1) AS d;

  IF v_repetidos > 0 THEN
    RAISE EXCEPTION
      'REVERSIÓN BLOQUEADA: % nombre(s) de usuario están repetidos entre cuentas vigentes y eliminadas (%). El índice único TOTAL que restaura este paso no los admite. Renombre o elimine físicamente las cuentas eliminadas que los retienen y vuelva a ejecutar.',
      v_repetidos, v_detalle;
  END IF;
END;
$reversion_condicional$;

DROP INDEX IF EXISTS "users_username_unique_active";
CREATE UNIQUE INDEX "users_username_key" ON "users" ("username");
