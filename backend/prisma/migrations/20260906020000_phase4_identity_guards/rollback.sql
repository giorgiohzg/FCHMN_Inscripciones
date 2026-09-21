-- ===========================================================================
-- PLAN DE REVERSIÓN de `phase4_identity_guards`.
--
-- Reversión INCONDICIONAL: solo elimina disparadores y un índice. No toca
-- datos, no puede fallar por el estado de la base y no pierde información.
-- (A diferencia de `phase4_user_identity/rollback.sql`, que sí es condicional
-- — ver la advertencia de su paso 4.)
--
-- Prisma no ejecuta este archivo. Después de correrlo, borre la fila
-- correspondiente de `_prisma_migrations`.
-- ===========================================================================

DROP TRIGGER IF EXISTS "club_staff_un_solo_club_por_persona" ON "club_staff";
DROP FUNCTION IF EXISTS club_staff_un_solo_club_por_persona();

DROP INDEX IF EXISTS "club_staff_unique_legal_representative";

DROP TRIGGER IF EXISTS "persons_forbid_rename_con_cuenta" ON "persons";
DROP TRIGGER IF EXISTS "clubs_forbid_rename_con_cuenta" ON "clubs";
DROP FUNCTION IF EXISTS titular_forbid_rename_con_cuenta();

DROP TRIGGER IF EXISTS "users_username_igual_al_titular" ON "users";
DROP FUNCTION IF EXISTS users_username_igual_al_titular();

DROP TRIGGER IF EXISTS "users_forbid_owner_reassignment" ON "users";
DROP FUNCTION IF EXISTS users_forbid_owner_reassignment();

-- NOTA sobre la RE-APLICACIÓN. Revertir es incondicional, pero volver a
-- aplicar no lo es: las cuatro validaciones del inicio de `migration.sql`
-- vuelven a correr, y si durante el intervalo se creó un segundo
-- representante legal, se vinculó a alguien a dos clubes, o se le dio a una
-- cuenta un nombre distinto del de su titular, la migración se detendrá hasta
-- que esos estados se corrijan. Es deliberado: son exactamente las reglas que
-- esta migración existe para garantizar.
