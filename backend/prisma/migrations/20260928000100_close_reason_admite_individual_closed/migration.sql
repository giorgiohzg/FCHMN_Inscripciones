-- La coherencia entre estado y causa de cierre, ampliada al cierre parcial.
--
-- QUÉ ESTABA MAL
--
-- `competitions_close_reason_coherente`, de la migración
-- `20260922190000_add_registrations_close_reason`, exige literalmente
-- `status = 'closed'` para que la causa y la marca de tiempo puedan existir.
-- Con el estado nuevo, cerrar por cupo escribe `individual_closed` + causa
-- `capacity`, y la base RECHAZARÍA esa escritura. El cierre por cupo quedaría
-- roto, no degradado: la transacción de la inscripción entera fallaría.
--
-- La migración anterior NO se modifica: ya está aplicada. Esta la sustituye.
--
-- QUÉ COMBINACIONES SON VÁLIDAS, una por una:
--
--   estado             causa      marca   ¿válido?  por qué
--   ─────────────────  ─────────  ──────  ────────  ──────────────────────────
--   cualquiera≠ind_cl  NULL       NULL    sí        no está cerrada, o es una
--                                                   fila anterior a que la
--                                                   causa existiera
--   closed             manual     no NULL sí        cierre anticipado del
--                                                   administrador
--   closed             capacity   no NULL sí        se llenó y luego se cerró
--                                                   del todo
--   closed             schedule   no NULL sí        venció la fecha de fin
--   closed             NULL       NULL    sí        fila antigua, causa
--                                                   desconocida
--   individual_closed  capacity   no NULL sí        ÚNICA forma de llegar al
--                                                   cierre parcial: el cupo
--   individual_closed  manual     —       NO        cerrar a mano cierra del
--                                                   todo, nunca a medias
--   individual_closed  schedule   —       NO        el vencimiento cierra del
--                                                   todo
--   individual_closed  NULL       NULL    NO        el cierre parcial siempre
--                                                   tiene causa: nació después
--                                                   de que la causa existiera
--   abierta            cualquiera no NULL NO        una causa de cierre en una
--                                                   competencia no cerrada es
--                                                   un estado que nadie sabe
--                                                   leer
--   cerrada            no NULL    NULL    NO        la causa y la marca van
--                                                   siempre juntas
--
-- Ninguna fila existente puede violarla: no hay ninguna en `individual_closed`
-- —el valor acaba de crearse— y el resto de combinaciones se aceptan igual que
-- antes.
ALTER TABLE "competitions" DROP CONSTRAINT "competitions_close_reason_coherente";

ALTER TABLE "competitions"
  ADD CONSTRAINT "competitions_close_reason_coherente"
  CHECK (
    (
      "registrations_closed_reason" IS NULL
      AND "registrations_closed_at" IS NULL
      -- El cierre parcial NUNCA carece de causa.
      AND "status" <> 'individual_closed'
    )
    OR
    (
      "registrations_closed_reason" IS NOT NULL
      AND "registrations_closed_at" IS NOT NULL
      AND (
        "status" = 'closed'
        -- El cierre parcial solo puede deberse al cupo.
        OR ("status" = 'individual_closed' AND "registrations_closed_reason" = 'capacity')
      )
    )
  );
