-- El correo electrónico del club pasa a ser OPCIONAL.
--
-- `clubs.email` era `TEXT NOT NULL`. Un club sin correo conocido obligaba a
-- inventar uno provisional, y un dato inventado es peor que un dato ausente.
-- A partir de aquí la ausencia es `NULL`, y solo `NULL`: nunca una cadena vacía.
--
-- NINGUNA FILA SE CONVIERTE NI SE LIMPIA. Los correos existentes —incluidos los
-- que pudieran ser provisionales— se conservan tal cual. Quitar `NOT NULL` no
-- toca los datos; y la restricción nueva solo se puede crear si ninguna fila la
-- incumple, así que antes se comprueba y, si hay alguna, la migración se
-- DETIENE con el detalle en vez de corregirla por su cuenta.
--
-- Correspondencia con el preflight (`npm run preflight:migration`):
--   VALIDACIÓN 1 -> comprobación `club-email-vacio`

-- --------------------------------------------------------------------------
-- VALIDACIÓN 1 — clubes con el correo vacío o de solo espacios.
-- --------------------------------------------------------------------------
DO $v_email$
DECLARE
  v_detalle TEXT;
BEGIN
  SELECT string_agg(c.name || ' (' || c.id || ')', ', ')
    INTO v_detalle
    FROM clubs c
   WHERE c.email ~ '^\s*$';

  IF v_detalle IS NOT NULL THEN
    RAISE EXCEPTION
      'Hay clubes con el correo vacío (%). Corríjalos con su correo real antes de migrar; ver la comprobación "club-email-vacio" del preflight. La migración no los modifica.',
      v_detalle;
  END IF;
END;
$v_email$;

-- 1. Se admite NULL.
ALTER TABLE "clubs" ALTER COLUMN "email" DROP NOT NULL;

-- 2. Y la ausencia es SOLO NULL: una cadena vacía o de espacios no entra por
--    ningún camino, tampoco por SQL directo. Se usa una expresión regular y no
--    `btrim`, porque `btrim` solo recorta ESPACIOS: un correo de solo tabuladores
--    o saltos de línea pasaría, y la API (que recorta todo el espacio en blanco)
--    y la base dirían cosas distintas.
ALTER TABLE "clubs"
  ADD CONSTRAINT "clubs_email_no_vacio"
  CHECK ("email" IS NULL OR "email" !~ '^\s*$');

COMMENT ON COLUMN "clubs"."email" IS
  'Correo de contacto OPCIONAL. NULL = sin correo; nunca una cadena vacia ni un correo provisional.';
