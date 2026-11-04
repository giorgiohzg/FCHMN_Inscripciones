-- Etapa 10a: se retira el estado «pendiente de verificar» de la personalidad jurídica.
--
-- DECISIÓN DEL USUARIO QUE CAMBIA DATOS. Los clubes con `has_legal_status` NULL
-- («pendiente») pasan a `false` («No tiene»), y a esos MISMOS clubes se les
-- elimina el RUT que tengan guardado. Es convertir un dato DESCONOCIDO en una
-- afirmación negativa: no es una verificación de que el club carezca de
-- personalidad jurídica, y así queda documentado. La migración
-- `20261031000100_personalidad_juridica_pendiente` se negó a hacerlo en su día
-- precisamente por eso; el usuario lo decidió ahora de forma expresa.
--
-- ALCANCE EXACTO
--   - Solo filas con `has_legal_status IS NULL`, vigentes o eliminadas
--     lógicamente. Los clubes `true` y `false` no se tocan.
--   - Solo la columna `rut` de esas filas, y la propia `has_legal_status`.
--     Razón social, nombramientos (`club_staff`), roles y permisos NO se tocan.
--   - NO se crea ninguna tabla para conservar los RUT retirados. Si alguna vez
--     hiciera falta recuperarlos, la fuente es el respaldo previo protegido del
--     procedimiento de despliegue. La auditoría registra QUE se eliminó un RUT,
--     nunca su valor.
--
-- SIN `SET NOT NULL`. Esa es la migración 10b, que se decide aparte: mientras la
-- columna siga admitiendo NULL, volver al código anterior sigue siendo posible
-- (ver "Compatibilidad entre versiones" en el plan). El contrato público ya solo
-- admite booleanos; aquí la columna sigue siendo anulable solo a nivel físico.
--
-- Correspondencia con el preflight (`npm run preflight:migration`):
--   VALIDACIÓN 1 -> comprobación `club-pendiente-con-representante-legal`

-- LA VALIDACIÓN VA ANTES DE `BEGIN`, a propósito. Si un `RAISE EXCEPTION` ocurre
-- DENTRO de una transacción explícita, la conexión queda en estado abortado y
-- Prisma, al registrar el fallo, choca con «current transaction is aborted»: el
-- diagnóstico se pierde y el operador solo ve ese mensaje genérico. Fuera de la
-- transacción explícita, el fallo llega completo y no se ha escrito nada. La
-- misma comprobación se REPITE dentro (más abajo) como guarda ante una carrera.

-- --------------------------------------------------------------------------
-- VALIDACIÓN 1 — un club pendiente con representante legal (ANTES de la transacción).
--
-- La regla de negocio impide designar representante legal sin personalidad
-- jurídica confirmada, así que no debería existir; pero ninguna restricción de
-- base lo garantiza. Convertir a «No tiene» a un club que tiene representante
-- lo dejaría en un estado que el propio servicio rechaza al guardar, y el
-- nombramiento es una vía de acceso al sistema. La conversión NO retira
-- nombramientos: si hay uno, se detiene TODA y no se escribe nada.
--
-- Se cuentan todos los nombramientos del club, también los de personas
-- eliminadas lógicamente: sin una decisión expresa, no se retira ninguno. El
-- diagnóstico nombra al club y cuenta nombramientos; no incluye datos de las
-- personas.
-- --------------------------------------------------------------------------
DO $v_representante$
DECLARE
  v_detalle TEXT;
BEGIN
  SELECT string_agg(c.name || ' (' || c.id || '; ' || d.nombramientos || ' nombramiento(s))', ', ')
    INTO v_detalle
    FROM (SELECT club_id, count(*) AS nombramientos
            FROM club_staff
           WHERE role_type = 'legal_representative'
           GROUP BY club_id) d
    JOIN clubs c ON c.id = d.club_id
   WHERE c.has_legal_status IS NULL;

  IF v_detalle IS NOT NULL THEN
    RAISE EXCEPTION
      'Hay clubes con personalidad jurídica pendiente que tienen representante legal (%). La conversión a "No tiene" se detiene COMPLETA y no modifica nada, porque no retira nombramientos por su cuenta. Resuélvalo antes de migrar; ver la comprobación "club-pendiente-con-representante-legal" del preflight.',
      v_detalle;
  END IF;
END;
$v_representante$;


BEGIN;

-- --------------------------------------------------------------------------
-- Los clubes a convertir se fijan UNA vez y se BLOQUEAN, para que la auditoría
-- y la actualización hablen exactamente de las mismas filas: un club pendiente
-- que otra transacción creara entre medias no entra en esta conversión (ni
-- queda auditado sin convertirse, ni convertido sin auditarse).
--
-- `tenia_rut` se captura ANTES de borrarlo, y es lo único del RUT que se
-- conserva: un booleano.
-- --------------------------------------------------------------------------
CREATE TEMP TABLE _clubes_a_convertir ON COMMIT DROP AS
  SELECT id, (rut IS NOT NULL) AS tenia_rut
    FROM clubs
   WHERE has_legal_status IS NULL
     FOR UPDATE;

-- Guarda dentro de la transacción: sobre los clubes ya BLOQUEADOS, por si entre la
-- validación de arriba y este punto apareció un nombramiento. Si salta, se deshace
-- todo (el diagnóstico completo ya lo da la validación previa).
DO $g_representante$
BEGIN
  IF EXISTS (
    SELECT 1 FROM club_staff cs
     WHERE cs.role_type = 'legal_representative'
       AND cs.club_id IN (SELECT id FROM _clubes_a_convertir)
  ) THEN
    RAISE EXCEPTION 'Aparecio un representante legal en un club a convertir. Se deshace todo.';
  END IF;
END;
$g_representante$;

-- Una fila de auditoría por club convertido. Sin usuario (la hace la migración)
-- y SIN el valor del RUT: solo estado anterior, estado nuevo y si se eliminó uno.
INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, ip_address, before, after)
SELECT gen_random_uuid()::text,
       NULL,
       'CLUB_LEGAL_STATUS_CONVERTED',
       'Club',
       t.id,
       NULL,
       jsonb_build_object('hasLegalStatus', NULL),
       jsonb_build_object('hasLegalStatus', false, 'rutEliminado', t.tenia_rut)
  FROM _clubes_a_convertir t;

-- La conversión y la eliminación del RUT, en UNA sola sentencia: no puede existir
-- un estado «No tiene con RUT» ni «pendiente sin RUT» entre dos pasos. El
-- `WHERE` por identificador es lo que impide tocar cualquier otra fila.
UPDATE clubs
   SET has_legal_status = false,
       rut = NULL
 WHERE id IN (SELECT id FROM _clubes_a_convertir);

-- --------------------------------------------------------------------------
-- Verificación dentro de la misma transacción: si algo no cuadra, se deshace todo.
-- --------------------------------------------------------------------------
DO $v_resultado$
DECLARE
  v_convertidos INT;
  v_auditados   INT;
  v_mal         INT;
BEGIN
  SELECT count(*) INTO v_convertidos FROM _clubes_a_convertir;

  SELECT count(*) INTO v_auditados
    FROM audit_logs a
   WHERE a.action = 'CLUB_LEGAL_STATUS_CONVERTED'
     AND a.entity_id IN (SELECT id FROM _clubes_a_convertir);

  SELECT count(*) INTO v_mal
    FROM clubs c
   WHERE c.id IN (SELECT id FROM _clubes_a_convertir)
     AND (c.has_legal_status IS DISTINCT FROM false OR c.rut IS NOT NULL);

  IF v_mal <> 0 OR v_auditados <> v_convertidos THEN
    RAISE EXCEPTION
      'La conversión no cuadra (% club(es) a convertir, % auditado(s), % sin convertir bien). Se deshace todo.',
      v_convertidos, v_auditados, v_mal;
  END IF;
END;
$v_resultado$;

COMMENT ON COLUMN "clubs"."has_legal_status" IS
  'true = tiene personalidad juridica (exige RUT) | false = no tiene. NULL ya NO es un estado valido (antes: pendiente de verificar); la columna sigue admitiendo NULL solo hasta la migracion que la hace obligatoria';

COMMIT;
