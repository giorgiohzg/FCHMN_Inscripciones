-- CONCILIACIÓN: ¿la marca «permisos de administrador» y el rol real coinciden?
--
-- POR QUÉ HACE FALTA ESTE SCRIPT
--
-- `persons.admin_access` guarda la intención y `user_roles` concede el acceso.
-- La coherencia entre ambas se mantiene por disciplina —`setAdminAccess` es el
-- único escritor de las dos— y NO por una restricción de la base: la condición
-- cruza tres tablas y un CHECK de PostgreSQL no puede expresarla.
--
-- Una disciplina que nadie comprueba es una suposición. Esto la comprueba.
--
-- SOLO LECTURA: tres SELECT. No modifica ni borra nada.
--
-- Uso (base de revisión):
--   Get-Content scripts\auditar-admin-desincronizado.sql -Raw |
--     docker exec -i fchmn_inscripciones_revision-postgres-revision-1
--       psql -U natacion -d natacion_revision -f -

\echo '== 1. Personas CON la marca cuya cuenta NO tiene el rol admin =='
\echo '   (sin cuenta todavia NO es un problema: la marca se aplica al crearla)'

SELECT
  p.id            AS persona_id,
  p.status        AS estado_persona,
  u.id            AS cuenta_id,
  u.status        AS estado_cuenta
FROM persons p
JOIN users u ON u.person_id = p.id
WHERE p.admin_access
  AND NOT EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = u.id AND r.name = 'admin'
  );

\echo ''
\echo '== 2. Cuentas de persona CON rol admin cuya persona NO tiene la marca =='

SELECT
  p.id            AS persona_id,
  p.status        AS estado_persona,
  u.id            AS cuenta_id,
  u.status        AS estado_cuenta
FROM users u
JOIN persons p ON p.id = u.person_id
JOIN user_roles ur ON ur.user_id = u.id
JOIN roles r ON r.id = ur.role_id
WHERE r.name = 'admin'
  AND NOT p.admin_access;

\echo ''
\echo '== 3. Administradores UTILIZABLES que quedan =='
\echo '   (la cuenta system cuenta: no tiene persona detras)'

SELECT
  count(*)                                              AS total,
  count(*) FILTER (WHERE u.owner_type = 'system')       AS de_sistema,
  count(*) FILTER (WHERE u.owner_type = 'person')       AS de_personas
FROM users u
LEFT JOIN persons p ON p.id = u.person_id
WHERE u.status = 'active'
  AND u.deleted_at IS NULL
  AND EXISTS (
    SELECT 1 FROM user_roles ur
    JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = u.id AND r.name = 'admin'
  )
  AND (p.id IS NULL OR (p.status = 'active' AND p.deleted_at IS NULL));
