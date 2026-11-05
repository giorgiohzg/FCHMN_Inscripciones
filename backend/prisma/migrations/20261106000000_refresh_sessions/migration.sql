-- Sesiones de autenticación: una fila que existe desde el login y sobrevive a la
-- rotación del refresh token.
--
-- POR QUÉ UNA TABLA Y NO SOLO UNA COLUMNA. Hacen falta tres cosas que una columna en
-- `refresh_tokens` no da: una fila bloqueable ANTES de insertar el token siguiente, un
-- objetivo para el `sid` del JWT que permita terminar UNA sesión sin tocar las demás, y
-- un estado que distinga «familia terminada» de «token reutilizado».
--
-- ESTRICTAMENTE ADITIVA. Una tabla nueva y una columna nula. La API anterior sigue
-- funcionando sin cambios mientras esta migración ya está aplicada: su cliente ignora la
-- columna y sus inserciones la dejan en NULL.
--
-- NO HAY BACKFILL, PURGA NI `NOT NULL`. Las filas existentes conservan `session_id` NULL
-- y no se modifica ninguna. La API nueva rechaza esos tokens sin afectar a nadie más,
-- y el histórico caduca por su cuenta. Ver `docs/operacion/corte-de-sesiones.md`.

CREATE TABLE "refresh_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absolute_expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" TEXT,

    CONSTRAINT "refresh_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "refresh_sessions_user_id_idx" ON "refresh_sessions"("user_id");

ALTER TABLE "refresh_sessions"
    ADD CONSTRAINT "refresh_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "refresh_tokens" ADD COLUMN "session_id" TEXT;

CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

ALTER TABLE "refresh_tokens"
    ADD CONSTRAINT "refresh_tokens_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "refresh_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
