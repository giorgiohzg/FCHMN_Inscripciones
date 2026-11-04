-- La SIGLA es el identificador único del club.
--
-- `clubs.code` no tenía ninguna garantía de unicidad: era una convención de los
-- datos. Esta migración la vuelve una restricción de la base entre los clubes NO
-- ELIMINADOS lógicamente, incluidos los inactivos (un club inactivo conserva su
-- sigla: si vuelve a activarse no puede encontrarla ocupada). Los eliminados
-- lógicamente no cuentan, igual que en `clubs_username_unique_active`.
--
-- NINGUNA FILA SE MODIFICA. Si hay duplicados, la migración se DETIENE con el
-- detalle: no renombra, no fusiona ni elimina clubes; decidir cuál conserva la sigla
-- es del negocio.
--
-- La comparación usa la misma normalización que la aplicación (`shared/clubCode.ts`):
-- sin blancos a los lados y en mayúsculas. Se enumeran los blancos que `trim()` de
-- JavaScript recorta, porque `btrim` solo quita espacios y `\s` depende del locale.
--
-- Correspondencia con el preflight (`npm run preflight:migration`):
--   VALIDACIÓN 1 -> comprobación `club-sigla-duplicada`

CREATE OR REPLACE FUNCTION club_code_normalizado(codigo TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $fn$
  SELECT upper(regexp_replace(
    codigo,
    '^[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+|[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+$',
    '',
    'g'
  ))
$fn$;

-- --------------------------------------------------------------------------
-- VALIDACIÓN 1 — clubes vigentes (activos o no) que comparten sigla normalizada.
-- --------------------------------------------------------------------------
DO $v_sigla$
DECLARE
  v_detalle TEXT;
BEGIN
  SELECT string_agg(format('«%s»: %s', d.sigla, d.clubes), '; ' ORDER BY d.sigla)
    INTO v_detalle
    FROM (
      SELECT club_code_normalizado(c.code) AS sigla,
             string_agg(format('%s (%s, guardada como «%s», %s)', c.name, c.id, c.code, c.status), ', ' ORDER BY c.name, c.id) AS clubes
        FROM clubs c
       WHERE c.deleted_at IS NULL
       GROUP BY club_code_normalizado(c.code)
      HAVING count(*) > 1
    ) d;

  IF v_detalle IS NOT NULL THEN
    RAISE EXCEPTION
      'Hay clubes vigentes con la misma sigla: %. Decida qué club conserva cada sigla y corrija las demás desde la ficha del club antes de migrar; ver la comprobación "club-sigla-duplicada" del preflight. La migración no modifica ningún club.',
      v_detalle;
  END IF;
END
$v_sigla$;

CREATE UNIQUE INDEX "clubs_code_unique_active" ON "clubs" (club_code_normalizado("code")) WHERE "deleted_at" IS NULL;
