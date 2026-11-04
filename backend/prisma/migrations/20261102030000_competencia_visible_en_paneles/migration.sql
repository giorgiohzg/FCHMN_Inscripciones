-- Visibilidad de las competencias en los desplegables del Panel de Inscripción
-- y del Panel de Relevos.
--
-- Columna nueva, ADITIVA, con `DEFAULT true`: toda competencia que ya existe
-- queda VISIBLE (el valor por omisión se aplica a las filas anteriores al
-- añadir una columna `NOT NULL` con `DEFAULT`), y las que se creen sin indicarlo
-- también. Ninguna fila se modifica a mano ni se pierde nada; no hay validación
-- previa porque no hay dato que pueda impedirla.
--
-- Sentido POSITIVO a propósito (`true` = se muestra): la casilla del formulario
-- dice «Ocultar…» y la columna de la tabla «Mostrar en competencia»; guardar un
-- `hidden` obligaría a negarlo en cada lectura.
--
-- Es solo visibilidad: no cambia permisos, reglas de inscripción, acceso directo,
-- Reportes ni los asistentes.

ALTER TABLE "competitions" ADD COLUMN "visible_in_registration_panels" BOOLEAN NOT NULL DEFAULT true;
