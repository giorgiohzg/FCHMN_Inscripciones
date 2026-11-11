-- C-02: limitador de login (ver `src/modules/auth/limitadorLogin.ts`).
--
-- ESTRICTAMENTE ADITIVA: cinco tablas nuevas, sin tocar ninguna existente. La API anterior
-- funciona con esta migración ya aplicada: no conoce estas tablas. No hay backfill: el
-- limitador empieza vacío, y los bloqueos temporales antiguos de `users` se respetan hasta
-- su vencimiento.
--
-- Las tablas guardan solo huellas HMAC, recuentos y fechas: ninguna IP, ningún nombre de
-- usuario y ningún `users.id`.

-- CreateTable
CREATE TABLE "lim_clave" (
    "id" UUID NOT NULL,
    "tipo" VARCHAR(8) NOT NULL,
    "clave_hmac" BYTEA NOT NULL,
    "clave_version" BYTEA NOT NULL,
    "fragmento" SMALLINT NOT NULL,
    "cuenta_id" UUID,
    "ventana_inicio" TIMESTAMP(3),
    "fallos" INTEGER NOT NULL DEFAULT 0,
    "protegido_desde" TIMESTAMP(3),
    "protegido_hasta" TIMESTAMP(3),
    "ultimo_fallo_en" TIMESTAMP(3),
    "perdonado_hasta_seq" BIGINT NOT NULL DEFAULT 0,
    "rechazos" INTEGER NOT NULL DEFAULT 0,
    "rechazo_avisado_en" TIMESTAMP(3),
    "vence_en" TIMESTAMP(3) NOT NULL,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lim_clave_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lim_fallo_par" (
    "par_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "creado_en" TIMESTAMP(3) NOT NULL,
    "verificado" BOOLEAN NOT NULL,

    CONSTRAINT "lim_fallo_par_pkey" PRIMARY KEY ("par_id","seq")
);

-- CreateTable
CREATE TABLE "lim_reserva" (
    "seq" BIGSERIAL NOT NULL,
    "token" UUID NOT NULL,
    "origen_id" UUID NOT NULL,
    "cuenta_id" UUID,
    "par_id" UUID,
    "reserva_hasta" TIMESTAMP(3) NOT NULL,
    "anulada" BOOLEAN NOT NULL DEFAULT false,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lim_reserva_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "lim_capacidad" (
    "recurso" VARCHAR(16) NOT NULL,
    "usadas" INTEGER NOT NULL DEFAULT 0,
    "cupo" INTEGER NOT NULL,

    CONSTRAINT "lim_capacidad_pkey" PRIMARY KEY ("recurso")
);

-- CreateTable
CREATE TABLE "lim_configuracion" (
    "id" SMALLINT NOT NULL,
    "huella" BYTEA NOT NULL,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lim_configuracion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lim_clave_tipo_vence_en_idx" ON "lim_clave"("tipo", "vence_en");

-- CreateIndex
CREATE INDEX "lim_clave_cuenta_id_idx" ON "lim_clave"("cuenta_id");

-- CreateIndex
CREATE UNIQUE INDEX "lim_clave_tipo_clave_hmac_clave_version_key" ON "lim_clave"("tipo", "clave_hmac", "clave_version");

-- CreateIndex
CREATE UNIQUE INDEX "lim_reserva_token_key" ON "lim_reserva"("token");

-- CreateIndex
CREATE INDEX "lim_reserva_origen_id_idx" ON "lim_reserva"("origen_id");

-- CreateIndex
CREATE INDEX "lim_reserva_cuenta_id_idx" ON "lim_reserva"("cuenta_id");

-- CreateIndex
CREATE INDEX "lim_reserva_par_id_idx" ON "lim_reserva"("par_id");

-- CreateIndex
CREATE INDEX "lim_reserva_reserva_hasta_idx" ON "lim_reserva"("reserva_hasta");

-- AddForeignKey
ALTER TABLE "lim_clave" ADD CONSTRAINT "lim_clave_cuenta_id_fkey" FOREIGN KEY ("cuenta_id") REFERENCES "lim_clave"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lim_fallo_par" ADD CONSTRAINT "lim_fallo_par_par_id_fkey" FOREIGN KEY ("par_id") REFERENCES "lim_clave"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lim_reserva" ADD CONSTRAINT "lim_reserva_origen_id_fkey" FOREIGN KEY ("origen_id") REFERENCES "lim_clave"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lim_reserva" ADD CONSTRAINT "lim_reserva_cuenta_id_fkey" FOREIGN KEY ("cuenta_id") REFERENCES "lim_clave"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lim_reserva" ADD CONSTRAINT "lim_reserva_par_id_fkey" FOREIGN KEY ("par_id") REFERENCES "lim_clave"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Invariantes que Prisma no modela.
ALTER TABLE "lim_clave" ADD CONSTRAINT "lim_clave_tipo_check" CHECK ("tipo" IN ('origen', 'cuenta', 'par'));
ALTER TABLE "lim_clave" ADD CONSTRAINT "lim_clave_fragmento_check" CHECK ("fragmento" BETWEEN 0 AND 15);
ALTER TABLE "lim_clave" ADD CONSTRAINT "lim_clave_cuenta_solo_en_pares_check" CHECK (("tipo" = 'par') = ("cuenta_id" IS NOT NULL));
ALTER TABLE "lim_clave" ADD CONSTRAINT "lim_clave_fallos_check" CHECK ("fallos" >= 0 AND "rechazos" >= 0);
ALTER TABLE "lim_capacidad" ADD CONSTRAINT "lim_capacidad_usadas_check" CHECK ("usadas" >= 0 AND "usadas" <= "cupo");
ALTER TABLE "lim_configuracion" ADD CONSTRAINT "lim_configuracion_una_fila_check" CHECK ("id" = 1);

-- Capacidad inicial: 16 fragmentos de 6250 claves (100 000) y 200 reservas. Cifras
-- candidatas; la aplicación vuelve a crear una fila que falte con estos mismos valores.
INSERT INTO "lim_capacidad" ("recurso", "usadas", "cupo")
SELECT 'claves:' || lpad(f::text, 2, '0'), 0, 6250 FROM generate_series(0, 15) AS f;
INSERT INTO "lim_capacidad" ("recurso", "usadas", "cupo") VALUES ('reservas', 0, 200);
