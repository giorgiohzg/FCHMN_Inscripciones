-- Etapa 10b: `clubs.has_legal_status` pasa a ser OBLIGATORIA (`NOT NULL`).
--
-- Cierra la posibilidad de guardar personalidad jurídica «pendiente». La etapa 10a
-- (`20261102020000_personalidad_juridica_sin_pendiente`) ya convirtió a «No tiene»
-- los clubes pendientes que existían; esta migración solo endurece la columna.
--
-- NO CONVIERTE NI BORRA NADA. Si al migrar queda algún `NULL`, la migración se
-- DETIENE con el detalle y no modifica ninguna fila: convertir pendientes es
-- trabajo de la 10a, y decidir qué hacer con uno que aparezca después es del negocio.
--
-- SIN VALOR POR OMISIÓN EN LA BASE. La API exige un booleano explícito en cada alta
-- y edición (enviar `null` u omitirlo responde 400): un valor por omisión permitiría
-- que un cliente que omita el campo afirme «No tiene» sin que nadie lo decidiera.
--
-- SE DESPLIEGA JUNTO CON 10a, en el mismo `migrate deploy` y antes de la API y la web
-- nuevas (ver el plan). Un cliente anterior que envíe `null` falla en la base: por eso
-- API y web deben cambiar en el mismo despliegue.
--
-- La validación va fuera de toda transacción explícita, como en la 10a: así el
-- diagnóstico llega completo en vez de «current transaction is aborted».

DO $v_pendientes$
DECLARE
  v_cantidad INT;
  v_detalle  TEXT;
BEGIN
  SELECT count(*),
         string_agg(c.name || ' (' || c.id || CASE WHEN c.deleted_at IS NULL THEN '' ELSE ', eliminado lógicamente' END || ')', ', ' ORDER BY c.name, c.id)
    INTO v_cantidad, v_detalle
    FROM clubs c
   WHERE c.has_legal_status IS NULL;

  IF v_cantidad > 0 THEN
    RAISE EXCEPTION
      'Hay % club(es) con personalidad jurídica pendiente (has_legal_status NULL): %. La migración se detiene y no modifica nada. Conviértalos con la migración 20261102020000_personalidad_juridica_sin_pendiente (que debe aplicarse antes) o decida cada caso; el sistema no los convierte por su cuenta aquí.',
      v_cantidad, v_detalle;
  END IF;
END
$v_pendientes$;

ALTER TABLE "clubs" ALTER COLUMN "has_legal_status" SET NOT NULL;

COMMENT ON COLUMN "clubs"."has_legal_status" IS
  'true = tiene personalidad juridica (exige RUT) | false = no tiene. Obligatoria y sin valor por omision: la API exige el booleano explicito. NULL ("pendiente") ya no existe';
