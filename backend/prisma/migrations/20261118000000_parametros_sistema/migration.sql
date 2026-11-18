-- Parámetros del sistema editables por administración (hoy, solo `login.mensaje`).
--
-- Aditiva: una tabla nueva, sin filas. Mientras no haya fila, el sistema usa el valor
-- por defecto definido en el código, que reproduce el mensaje vigente del login.
CREATE TABLE "parametros_sistema" (
    "clave" VARCHAR(80) NOT NULL,
    "valor" TEXT NOT NULL,
    "actualizado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "parametros_sistema_pkey" PRIMARY KEY ("clave"),
    -- Texto no vacío y acotado; el servicio aplica además el límite propio de cada clave.
    CONSTRAINT "parametros_sistema_valor_no_vacio" CHECK (length(btrim("valor")) > 0),
    CONSTRAINT "parametros_sistema_valor_acotado" CHECK (char_length("valor") <= 4000)
);
