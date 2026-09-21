-- ===========================================================================
-- PLAN DE REVERSIÓN de `drop_dead_schema`.
--
-- Prisma no ejecuta este archivo: solo lee `migration.sql`. Está aquí para que
-- la reversión sea un procedimiento escrito y probado, no una improvisación.
-- `tests/migration-upgrade.integration.test.ts` lo ejecuta de verdad.
--
-- ALCANCE, dicho sin rodeos: **restaura la ESTRUCTURA, no los datos.**
--
-- `DROP TABLE` se llevó las filas y no hay forma de recuperarlas desde aquí.
-- Lo que este archivo devuelve son las dos tablas vacías, con exactamente la
-- misma forma que tenían en `20260827015835_init`: sus columnas, sus tipos, su
-- clave primaria, el índice único de `token_hash` y la clave foránea a
-- `users` con borrado en cascada.
--
-- Eso basta para lo que la reversión tiene que permitir: que el esquema
-- anterior vuelva a ser válido y que una versión previa de la aplicación
-- arranque contra esta base. No basta —y no lo pretende— para recuperar
-- información.
--
-- SOBRE LAS FILAS QUE HUBIERA: no se inspeccionaron, y no se afirma que no las
-- hubiera. Una base antigua pudo conservar filas en cualquiera de las dos:
--
--   * `password_reset_tokens` dejó de escribirse al retirarse la
--     auto-recuperación por correo, pero las filas anteriores a esa retirada
--     seguirían ahí;
--   * `system_settings` dejó de sembrarse al quitar sus dos parámetros del
--     seed, y quitar un `upsert` no borra lo ya escrito.
--
-- Se descartaron DELIBERADAMENTE, con autorización explícita, porque todos los
-- datos actuales son de prueba y las bases se recrean antes de la primera
-- versión. No se hizo comprobación previa ni volcado, y no se pretendía hacerlo.
--
-- En consecuencia: recuperar filas exige el **respaldo previo a la migración**.
-- Este archivo no lo sustituye.
--
-- Después de ejecutarlo hay que borrar la fila correspondiente de
-- `_prisma_migrations` para que Prisma vuelva a considerarla pendiente.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_token_hash_key"
  ON "password_reset_tokens"("token_hash");

ALTER TABLE "password_reset_tokens"
  DROP CONSTRAINT IF EXISTS "password_reset_tokens_user_id_fkey";
ALTER TABLE "password_reset_tokens"
  ADD CONSTRAINT "password_reset_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "system_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);
