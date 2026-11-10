-- C-04: intentos de cambio de contraseña por sesión.
--
-- ESTRICTAMENTE ADITIVA. Tres columnas nuevas en `refresh_sessions`: un entero con
-- valor por omisión constante (PostgreSQL 16 lo añade sin reescribir la tabla) y dos
-- columnas nulas. La API anterior sigue funcionando mientras esta migración ya está
-- aplicada: su cliente no las lee y sus inserciones toman los valores por omisión.
--
-- SIN BACKFILL. Las sesiones existentes empiezan con cero intentos y sin reserva.

ALTER TABLE "refresh_sessions" ADD COLUMN "password_change_failures" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "refresh_sessions" ADD COLUMN "password_change_reservation" TEXT;
ALTER TABLE "refresh_sessions" ADD COLUMN "password_change_reserved_until" TIMESTAMP(3);
