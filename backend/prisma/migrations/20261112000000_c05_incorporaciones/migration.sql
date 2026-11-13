-- C-05: incorporaciones por RUN — fase 1, solo el modelo de datos.
--
-- ADITIVA: tres tablas nuevas (periodos de cambio de club, intentos de postulación y
-- solicitudes de alta), dos enumeraciones y una columna nula en `club_swimmers`
-- (`fecha_termino`). No modifica ni completa ningún dato existente: todas las membresías
-- finalizadas antes de esta migración quedan con `fecha_termino` NULA, que significa término
-- DESCONOCIDO. `end_date` (instante de la operación) no se convierte en fecha de pertenencia.
--
-- La API anterior funciona con esta migración aplicada: no conoce las tablas nuevas ni la
-- columna, y el índice único nuevo de propuestas pendientes coincide con la regla que el
-- servicio ya aplica («Ya existe una solicitud pendiente para este nadador en este club»).
--
-- GUARDA PREVIA: si ya existen propuestas pendientes duplicadas (mismo club y persona), la
-- migración se DETIENE antes de crear nada, sin corregir ni borrar filas. El mensaje lista
-- solo identificadores de membresía, nunca datos de personas.

DO $$
DECLARE
  v_grupos  integer;
  v_detalle text;
BEGIN
  SELECT count(*)
    INTO v_grupos
    FROM (
      SELECT 1
        FROM "club_swimmers" cs
       WHERE cs."status" = 'pending'
       GROUP BY cs."club_id", cs."person_id"
      HAVING count(*) > 1
    ) t;

  SELECT string_agg(ids, ' | ')
    INTO v_detalle
    FROM (
      SELECT string_agg(cs.id, ', ' ORDER BY cs.id) AS ids
        FROM "club_swimmers" cs
       WHERE cs."status" = 'pending'
       GROUP BY cs."club_id", cs."person_id"
      HAVING count(*) > 1
       ORDER BY min(cs."created_at")
       LIMIT 20
    ) d;

  IF v_grupos > 0 THEN
    RAISE EXCEPTION
      'Hay propuestas pendientes duplicadas para un mismo club y persona (% grupo(s), hasta 20 listados por id de membresía: %). Resuélvalas (rechace las sobrantes) antes de migrar; la migración no las corrige.',
      v_grupos, v_detalle;
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "EstadoIntentoIncorporacion" AS ENUM ('en_curso', 'propuesta_creada', 'requiere_alta', 'alta_registrada', 'resuelto_por_propuesta', 'run_invalido', 'club_no_disponible', 'duplicado', 'fuera_de_periodo', 'interrumpido', 'error_tecnico');

-- CreateEnum
CREATE TYPE "EstadoSolicitudAlta" AS ENUM ('pendiente', 'aprobada', 'rechazada', 'resuelta_por_propuesta');

-- AlterTable
ALTER TABLE "club_swimmers" ADD COLUMN     "fecha_termino" DATE;

-- CreateTable
CREATE TABLE "periodos_cambio_club" (
    "id" TEXT NOT NULL,
    "inicio" DATE NOT NULL,
    "fin" DATE NOT NULL,
    "motivo" VARCHAR(300),
    "creado_por_user_id" TEXT NOT NULL,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cerrado_en" TIMESTAMP(3),
    "cerrado_por_user_id" TEXT,

    CONSTRAINT "periodos_cambio_club_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intentos_incorporacion" (
    "id" TEXT NOT NULL,
    "club_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "dia" DATE NOT NULL,
    "clave_idempotencia" VARCHAR(64) NOT NULL,
    "huella_contenido" BYTEA NOT NULL,
    "estado" "EstadoIntentoIncorporacion" NOT NULL DEFAULT 'en_curso',
    "token_ejecucion" UUID NOT NULL,
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resuelto_en" TIMESTAMP(3),
    "run_normalizado" VARCHAR(9),
    "expira_en" TIMESTAMP(3),
    "consumido_en" TIMESTAMP(3),
    "huella_alta" BYTEA,
    "propuesta_id" TEXT,

    CONSTRAINT "intentos_incorporacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "solicitudes_alta_incorporacion" (
    "id" TEXT NOT NULL,
    "club_id" TEXT NOT NULL,
    "intento_id" TEXT NOT NULL,
    "run_normalizado" VARCHAR(9) NOT NULL,
    "nombres_declarados" VARCHAR(120) NOT NULL,
    "apellidos_declarados" VARCHAR(120) NOT NULL,
    "solicitado_por_user_id" TEXT NOT NULL,
    "estado" "EstadoSolicitudAlta" NOT NULL DEFAULT 'pendiente',
    "creado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revisado_por_user_id" TEXT,
    "revisado_en" TIMESTAMP(3),
    "motivo_rechazo" VARCHAR(500),
    "persona_id" TEXT,
    "membresia_id" TEXT,
    "propuesta_existente_id" TEXT,
    "persona_creada_pese_a_eliminada" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "solicitudes_alta_incorporacion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "periodos_cambio_club_inicio_fin_idx" ON "periodos_cambio_club"("inicio", "fin");

-- CreateIndex
CREATE UNIQUE INDEX "intentos_incorporacion_propuesta_id_key" ON "intentos_incorporacion"("propuesta_id");

-- CreateIndex
CREATE INDEX "intentos_incorporacion_club_id_dia_idx" ON "intentos_incorporacion"("club_id", "dia");

-- CreateIndex
CREATE UNIQUE INDEX "intentos_incorporacion_club_id_user_id_clave_idempotencia_key" ON "intentos_incorporacion"("club_id", "user_id", "clave_idempotencia");

-- CreateIndex
CREATE UNIQUE INDEX "solicitudes_alta_incorporacion_intento_id_key" ON "solicitudes_alta_incorporacion"("intento_id");

-- CreateIndex
CREATE UNIQUE INDEX "solicitudes_alta_incorporacion_membresia_id_key" ON "solicitudes_alta_incorporacion"("membresia_id");

-- CreateIndex
CREATE INDEX "solicitudes_alta_incorporacion_club_id_estado_idx" ON "solicitudes_alta_incorporacion"("club_id", "estado");

-- CreateIndex
CREATE INDEX "solicitudes_alta_incorporacion_estado_creado_en_idx" ON "solicitudes_alta_incorporacion"("estado", "creado_en");

-- AddForeignKey
ALTER TABLE "periodos_cambio_club" ADD CONSTRAINT "periodos_cambio_club_creado_por_user_id_fkey" FOREIGN KEY ("creado_por_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "periodos_cambio_club" ADD CONSTRAINT "periodos_cambio_club_cerrado_por_user_id_fkey" FOREIGN KEY ("cerrado_por_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intentos_incorporacion" ADD CONSTRAINT "intentos_incorporacion_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intentos_incorporacion" ADD CONSTRAINT "intentos_incorporacion_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intentos_incorporacion" ADD CONSTRAINT "intentos_incorporacion_propuesta_id_fkey" FOREIGN KEY ("propuesta_id") REFERENCES "club_swimmers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitudes_alta_incorporacion" ADD CONSTRAINT "solicitudes_alta_incorporacion_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitudes_alta_incorporacion" ADD CONSTRAINT "solicitudes_alta_incorporacion_intento_id_fkey" FOREIGN KEY ("intento_id") REFERENCES "intentos_incorporacion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitudes_alta_incorporacion" ADD CONSTRAINT "solicitudes_alta_incorporacion_solicitado_por_user_id_fkey" FOREIGN KEY ("solicitado_por_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitudes_alta_incorporacion" ADD CONSTRAINT "solicitudes_alta_incorporacion_revisado_por_user_id_fkey" FOREIGN KEY ("revisado_por_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitudes_alta_incorporacion" ADD CONSTRAINT "solicitudes_alta_incorporacion_persona_id_fkey" FOREIGN KEY ("persona_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitudes_alta_incorporacion" ADD CONSTRAINT "solicitudes_alta_incorporacion_membresia_id_fkey" FOREIGN KEY ("membresia_id") REFERENCES "club_swimmers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "solicitudes_alta_incorporacion" ADD CONSTRAINT "solicitudes_alta_incorporacion_propuesta_existente_id_fkey" FOREIGN KEY ("propuesta_existente_id") REFERENCES "club_swimmers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Restricciones que Prisma no modela.
-- ---------------------------------------------------------------------------

-- club_swimmers: la fecha de término es de calendario, solo en membresías finalizadas y nunca
-- antes del inicio. NULA en una finalizada = término desconocido (no se infiere de end_date).
ALTER TABLE "club_swimmers" ADD CONSTRAINT "club_swimmers_fecha_termino_solo_finalizada_check"
  CHECK ("fecha_termino" IS NULL OR "status" = 'ended');
ALTER TABLE "club_swimmers" ADD CONSTRAINT "club_swimmers_fecha_termino_no_antes_del_inicio_check"
  CHECK ("fecha_termino" IS NULL OR "start_date" IS NULL OR "fecha_termino" >= "start_date");

-- Una sola propuesta pendiente por club y persona (la guarda previa garantiza que se puede crear).
CREATE UNIQUE INDEX "club_swimmers_unique_pending_club_person"
  ON "club_swimmers" ("club_id", "person_id")
  WHERE "status" = 'pending';

-- periodos_cambio_club
ALTER TABLE "periodos_cambio_club" ADD CONSTRAINT "periodos_cambio_club_fechas_check"
  CHECK ("fin" >= "inicio");
ALTER TABLE "periodos_cambio_club" ADD CONSTRAINT "periodos_cambio_club_cierre_check"
  CHECK (("cerrado_en" IS NULL) = ("cerrado_por_user_id" IS NULL));
-- Dos periodos sin cierre anticipado no pueden solaparse (fechas inclusivas).
ALTER TABLE "periodos_cambio_club" ADD CONSTRAINT "periodos_cambio_club_sin_solape_excl"
  EXCLUDE USING gist (daterange("inicio", "fin", '[]') WITH &&)
  WHERE ("cerrado_en" IS NULL);
ALTER TABLE "periodos_cambio_club" ADD CONSTRAINT "periodos_cambio_club_motivo_check"
  CHECK ("motivo" IS NULL OR char_length(btrim("motivo")) > 0);

-- intentos_incorporacion
ALTER TABLE "intentos_incorporacion" ADD CONSTRAINT "intentos_incorporacion_clave_check"
  CHECK (char_length("clave_idempotencia") BETWEEN 8 AND 64);
ALTER TABLE "intentos_incorporacion" ADD CONSTRAINT "intentos_incorporacion_huellas_check"
  CHECK (octet_length("huella_contenido") = 32 AND ("huella_alta" IS NULL OR octet_length("huella_alta") = 32));
-- `en_curso` es el único estado sin resolver: tiene resuelto_en nulo, y solo él.
ALTER TABLE "intentos_incorporacion" ADD CONSTRAINT "intentos_incorporacion_resolucion_check"
  CHECK (("estado" = 'en_curso') = ("resuelto_en" IS NULL));
-- El RUN temporal solo existe mientras el alta está pendiente de completar.
ALTER TABLE "intentos_incorporacion" ADD CONSTRAINT "intentos_incorporacion_run_temporal_check"
  CHECK ("run_normalizado" IS NULL OR ("estado" = 'requiere_alta' AND "consumido_en" IS NULL));
ALTER TABLE "intentos_incorporacion" ADD CONSTRAINT "intentos_incorporacion_run_formato_check"
  CHECK ("run_normalizado" IS NULL OR "run_normalizado" ~ '^[0-9]{7,8}[0-9K]$');
ALTER TABLE "intentos_incorporacion" ADD CONSTRAINT "intentos_incorporacion_expira_check"
  CHECK ("estado" <> 'requiere_alta' OR "expira_en" IS NOT NULL);
-- Consumo único del segundo paso: se registra con su huella, una sola vez, y deja de estar
-- pendiente de completar.
ALTER TABLE "intentos_incorporacion" ADD CONSTRAINT "intentos_incorporacion_consumo_check"
  CHECK (("consumido_en" IS NULL) = ("huella_alta" IS NULL)
         AND ("consumido_en" IS NULL OR ("expira_en" IS NOT NULL AND "estado" NOT IN ('en_curso', 'requiere_alta'))));
ALTER TABLE "intentos_incorporacion" ADD CONSTRAINT "intentos_incorporacion_propuesta_check"
  CHECK (("estado" IN ('propuesta_creada', 'resuelto_por_propuesta')) = ("propuesta_id" IS NOT NULL));
-- Para marcar interrumpidos y para retirar el RUN vencido sin recorrer la tabla.
CREATE INDEX "intentos_incorporacion_en_curso_idx"
  ON "intentos_incorporacion" ("creado_en")
  WHERE "estado" = 'en_curso';
CREATE INDEX "intentos_incorporacion_run_temporal_idx"
  ON "intentos_incorporacion" ("expira_en")
  WHERE "run_normalizado" IS NOT NULL;

-- solicitudes_alta_incorporacion
ALTER TABLE "solicitudes_alta_incorporacion" ADD CONSTRAINT "solicitudes_alta_run_formato_check"
  CHECK ("run_normalizado" ~ '^[0-9]{7,8}[0-9K]$');
ALTER TABLE "solicitudes_alta_incorporacion" ADD CONSTRAINT "solicitudes_alta_nombres_check"
  CHECK (char_length(btrim("nombres_declarados")) > 0 AND char_length(btrim("apellidos_declarados")) > 0);
ALTER TABLE "solicitudes_alta_incorporacion" ADD CONSTRAINT "solicitudes_alta_revision_check"
  CHECK (("revisado_en" IS NULL) = ("revisado_por_user_id" IS NULL)
         AND ("estado" = 'pendiente') = ("revisado_en" IS NULL));
ALTER TABLE "solicitudes_alta_incorporacion" ADD CONSTRAINT "solicitudes_alta_resolucion_check"
  CHECK (("estado" = 'aprobada') = ("membresia_id" IS NOT NULL)
         AND ("estado" = 'resuelta_por_propuesta') = ("propuesta_existente_id" IS NOT NULL)
         AND ("estado" IN ('aprobada', 'resuelta_por_propuesta')) = ("persona_id" IS NOT NULL));
ALTER TABLE "solicitudes_alta_incorporacion" ADD CONSTRAINT "solicitudes_alta_motivo_check"
  CHECK ("motivo_rechazo" IS NULL OR "estado" = 'rechazada');
ALTER TABLE "solicitudes_alta_incorporacion" ADD CONSTRAINT "solicitudes_alta_pese_a_eliminada_check"
  CHECK (NOT "persona_creada_pese_a_eliminada" OR "estado" = 'aprobada');
-- Una sola solicitud pendiente por club y RUN (otros clubes pueden tener la suya).
CREATE UNIQUE INDEX "solicitudes_alta_unique_pendiente_club_run"
  ON "solicitudes_alta_incorporacion" ("club_id", "run_normalizado")
  WHERE "estado" = 'pendiente';
