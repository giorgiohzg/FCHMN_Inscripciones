-- Preflight de solo lectura previo a 20261112000000_c05_incorporaciones y
-- 20261114000000_competencia_predeterminada. Conserva las condiciones de
-- backend/scripts/migrationChecks.ts («propuestas-pendientes-duplicadas» y
-- «membresias-activas-con-inicio-futuro»). Solo informa conteos: ni nombres,
-- ni RUN, ni identificadores. No escribe: la transacción es READ ONLY y se
-- comprueba dentro de ella. Bloqueo = excepción = salida distinta de cero.
BEGIN READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL idle_in_transaction_session_timeout = '120s';
DO $preflight$
DECLARE
  duplicadas bigint;
  inicio_futuro bigint;
BEGIN
  IF current_setting('transaction_read_only') <> 'on' THEN
    RAISE EXCEPTION 'PREFLIGHT_ERROR: la transaccion no es de solo lectura';
  END IF;

  SELECT count(*) INTO duplicadas
    FROM (SELECT cs.club_id, cs.person_id
            FROM club_swimmers cs
           WHERE cs.status::text = 'pending'
           GROUP BY cs.club_id, cs.person_id
          HAVING count(*) > 1) AS grupos;

  SELECT count(*) INTO inicio_futuro
    FROM club_swimmers cs
   WHERE cs.status::text = 'active'
     AND cs.start_date IS NOT NULL
     AND (CASE WHEN pg_typeof(cs.start_date) = 'date'::regtype
               THEN cs.start_date::date
               ELSE ((cs.start_date::timestamp AT TIME ZONE 'UTC') AT TIME ZONE 'America/Santiago')::date
          END) > (now() AT TIME ZONE 'America/Santiago')::date;

  IF duplicadas > 0 OR inicio_futuro > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT_BLOQUEA grupos_pendientes_duplicados=% membresias_activas_inicio_futuro=%', duplicadas, inicio_futuro;
  END IF;
END
$preflight$;
COMMIT;
