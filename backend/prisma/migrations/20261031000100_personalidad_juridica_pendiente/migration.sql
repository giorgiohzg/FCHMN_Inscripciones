-- Tercer estado de la personalidad jurídica de un club: «pendiente de verificar».
--
-- `has_legal_status` era `BOOLEAN NOT NULL DEFAULT false`, así que solo podía
-- decir «sí» o «no». Un club cuya situación legal todavía no se ha comprobado
-- quedaba como `false`, indistinguible de uno verificado como «no» — y de ahí
-- colgaban dos reglas: el RUT obligatorio y el representante legal.
--
-- A partir de aquí `NULL` significa PENDIENTE DE VERIFICAR, y es un estado
-- distinto de `false`.

-- 1. Se admite NULL.
ALTER TABLE "clubs" ALTER COLUMN "has_legal_status" DROP NOT NULL;

-- 2. Se retira el valor por omisión.
--    Con `DEFAULT false`, una inserción que omitiera la columna afirmaría «no
--    tiene personalidad jurídica» sin que nadie lo haya comprobado. Sin valor
--    por omisión, omitirla deja NULL: «no se sabe», que es la verdad.
ALTER TABLE "clubs" ALTER COLUMN "has_legal_status" DROP DEFAULT;

COMMENT ON COLUMN "clubs"."has_legal_status" IS
  'true = tiene personalidad juridica (exige RUT) | false = verificado que NO la tiene | NULL = PENDIENTE DE VERIFICAR';

-- 3. NINGUNA fila se convierte.
--    Los `false` existentes se quedan como están: fueron declarados y no hay
--    forma de saber, desde aquí, cuales se verificaron. Convertirlos a NULL en
--    masa sustituiria un dato afirmado por una suposicion. Los clubes que estan
--    realmente pendientes se marcan cuando se los carga, que es cuando se sabe.
