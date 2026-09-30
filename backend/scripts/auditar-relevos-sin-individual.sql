-- AUDITORÍA: integrantes de relevo SIN inscripción individual confirmada
-- en la misma competencia.
--
-- Es la regla nueva que se va a imponer. Antes de imponerla hay que saber
-- cuántas filas ya existentes la incumplen: una validación añadida sin mirar
-- los datos previos deja el sistema en un estado donde lo ya guardado no se
-- puede volver a guardar.
--
-- SOLO LECTURA: son dos SELECT. No modifica ni borra nada, así que se puede
-- ejecutar contra cualquier base —incluida `natacion`— sin efectos.
--
-- OJO CON EL MODELO: ni `registrations` ni `relay_registrations` guardan la
-- competencia. Las dos apuntan a `competition_events`, y es esa tabla la que
-- tiene `competition_id`. "La misma competencia" exige pasar por ahí; comparar
-- `competition_event_id` sería otra cosa —la misma PRUEBA— y mucho más
-- restrictivo de lo que pide la regla.
--
-- Uso (ejemplo contra la base de revisión):
--   Get-Content scripts\auditar-relevos-sin-individual.sql -Raw |
--     docker exec -i fchmn_inscripciones_revision-postgres-revision-1
--       psql -U natacion -d natacion_revision -f -

\echo '== 1. Resumen: cuantos incumplimientos hay =='

WITH integrantes AS (
  SELECT
    m.person_id,
    m.order_position,
    rr.id           AS relevo_id,
    rr.club_id,
    ce.competition_id
  FROM relay_registration_members m
  JOIN relay_registrations rr ON rr.id = m.relay_registration_id
  JOIN competition_events ce  ON ce.id = rr.competition_event_id
  WHERE rr.status = 'confirmed'
),
incumplen AS (
  SELECT i.*
  FROM integrantes i
  WHERE NOT EXISTS (
    SELECT 1
    FROM registrations r
    JOIN competition_events ce2 ON ce2.id = r.competition_event_id
    WHERE r.person_id = i.person_id
      AND ce2.competition_id = i.competition_id
      AND r.status = 'confirmed'
  )
)
SELECT
  count(*)                              AS integrantes_sin_individual,
  count(DISTINCT relevo_id)             AS relevos_afectados,
  count(DISTINCT competition_id)        AS competencias_afectadas,
  count(DISTINCT person_id)             AS nadadores_afectados
FROM incumplen;

\echo ''
\echo '== 2. Detalle por competencia y relevo (identificadores, sin nombres de personas) =='

WITH integrantes AS (
  SELECT
    m.person_id,
    m.order_position,
    rr.id           AS relevo_id,
    rr.club_id,
    ce.competition_id
  FROM relay_registration_members m
  JOIN relay_registrations rr ON rr.id = m.relay_registration_id
  JOIN competition_events ce  ON ce.id = rr.competition_event_id
  WHERE rr.status = 'confirmed'
)
SELECT
  c.name                                AS competencia,
  c.status                              AS estado,
  i.relevo_id,
  cl.code                               AS club,
  i.person_id                           AS nadador_id,
  i.order_position                           AS posta,
  -- Distingue dos situaciones que se arreglan distinto: no tener ninguna
  -- inscripción individual, o tenerlas todas canceladas.
  (
    SELECT count(*)
    FROM registrations r
    JOIN competition_events ce2 ON ce2.id = r.competition_event_id
    WHERE r.person_id = i.person_id AND ce2.competition_id = i.competition_id
  )                                     AS individuales_en_cualquier_estado
FROM integrantes i
JOIN competitions c ON c.id = i.competition_id
LEFT JOIN clubs cl  ON cl.id = i.club_id
WHERE NOT EXISTS (
  SELECT 1
  FROM registrations r
  JOIN competition_events ce2 ON ce2.id = r.competition_event_id
  WHERE r.person_id = i.person_id
    AND ce2.competition_id = i.competition_id
    AND r.status = 'confirmed'
)
ORDER BY c.name, i.relevo_id, i.order_position;
