-- Accesos por rol (opción A: solo restringir y restituir los accesos actuales).
--
-- ADITIVA y sin cambio de comportamiento:
--  - crea la fila ÚNICA de versión (id = 1, versión 0, sin autor): es la INICIALIZACIÓN de la
--    versión, no una restricción;
--  - NO crea ninguna fila en `accesos_por_rol`: sin filas, todas las funciones siguen como hoy.
-- El catálogo de funciones vive en el código (`src/modules/accesos/catalogo.ts`).

CREATE TABLE "configuracion_accesos" (
    "id" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "actualizado_por_user_id" TEXT,
    "actualizado_en" TIMESTAMP(3),

    CONSTRAINT "configuracion_accesos_pkey" PRIMARY KEY ("id"),
    -- Una sola fila.
    CONSTRAINT "configuracion_accesos_fila_unica" CHECK ("id" = 1),
    CONSTRAINT "configuracion_accesos_version_no_negativa" CHECK ("version" >= 0),
    -- Autor y fecha van juntos: o los dos (tras un guardado) o ninguno (inicial).
    CONSTRAINT "configuracion_accesos_autor_y_fecha" CHECK (("actualizado_por_user_id" IS NULL) = ("actualizado_en" IS NULL))
);

CREATE TABLE "accesos_por_rol" (
    "rol" VARCHAR(20) NOT NULL,
    "funcion" VARCHAR(80) NOT NULL,
    "habilitada" BOOLEAN NOT NULL,
    "actualizado_por_user_id" TEXT NOT NULL,
    "actualizado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accesos_por_rol_pkey" PRIMARY KEY ("rol", "funcion"),
    -- Solo los tres roles configurables. Administración, cuenta de club y representante legal
    -- no se configuran.
    CONSTRAINT "accesos_por_rol_rol_configurable" CHECK ("rol" IN ('swimmer', 'delegate', 'coach')),
    CONSTRAINT "accesos_por_rol_funcion_no_vacia" CHECK (length(btrim("funcion")) > 0)
);

ALTER TABLE "configuracion_accesos" ADD CONSTRAINT "configuracion_accesos_actualizado_por_user_id_fkey" FOREIGN KEY ("actualizado_por_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "accesos_por_rol" ADD CONSTRAINT "accesos_por_rol_actualizado_por_user_id_fkey" FOREIGN KEY ("actualizado_por_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Inicialización de la versión: sin restricciones.
INSERT INTO "configuracion_accesos" ("id", "version") VALUES (1, 0);
