/**
 * Comprobaciones del preflight de migración de la Fase 2.
 *
 * Viven en su propio módulo para que la prueba de actualización
 * (`tests/migration-upgrade.integration.test.ts`) pueda recorrerlas una por
 * una y garantizar que TODAS quedan ejercitadas con datos reales: si mañana
 * se agrega una comprobación y nadie le crea un caso de conflicto, esa prueba
 * falla en vez de dejar el hueco silencioso.
 */

export interface Check {
  id: string;
  title: string;
  /** Qué constraint de la migración se rompería. */
  constraint: string;
  /** Consulta que devuelve las filas conflictivas (vacía = todo bien). */
  query: string;
  remediation: string;
  /**
   * Objeto que esta comprobación necesita, y la migración que lo crea.
   *
   * El preflight corre antes de migrar, así que algunas comprobaciones miran
   * objetos que crea una migración ANTERIOR de la misma tanda. En una base que
   * todavía no la aplicó, la consulta ni siquiera parsea; sin esto caían en
   * "SIN VERIFICAR" —que bloquea, y con razón— y el preflight quedaba
   * imposible de aprobar en el baseline.
   *
   * La decisión NO puede basarse solo en que la tabla exista: eso confundiría
   * "esta base es anterior" con "la tabla debería estar y no está", que es un
   * daño real. Se cruzan las dos señales:
   *
   *   migración no aplicada + tabla ausente  -> NO APLICA (correcto y esperado)
   *   migración aplicada    + tabla ausente  -> SIN VERIFICAR y bloquea
   *   tabla presente                         -> se ejecuta la comprobación
   */
  requires?: { table: string; migration: string };
}

export const CHECKS: Check[] = [
  {
    id: "registros-duplicados",
    title: "Inscripciones individuales confirmadas duplicadas (mismo nadador y prueba)",
    constraint: "registrations_unique_confirmed_person_event",
    query: `
      SELECT r.competition_event_id, r.person_id, p.full_name, count(*) AS repeticiones,
             string_agg(r.id::text, ', ') AS ids
        FROM registrations r
        JOIN persons p ON p.id = r.person_id
       WHERE r.status = 'confirmed'
       GROUP BY r.competition_event_id, r.person_id, p.full_name
      HAVING count(*) > 1`,
    remediation:
      "Cancele las inscripciones sobrantes dejando UNA confirmada por nadador y prueba " +
      "(UPDATE registrations SET status='cancelled', cancelled_at=now() WHERE id IN (...)).",
  },
  {
    id: "relevos-duplicados",
    title: "Equipos de relevo confirmados duplicados (mismo club, prueba y categoría)",
    constraint: "relay_registrations_unique_confirmed_team",
    query: `
      SELECT rr.competition_event_id, rr.club_id, c.name AS club, rr.category_id, count(*) AS repeticiones,
             string_agg(rr.id::text, ', ') AS ids
        FROM relay_registrations rr
        JOIN clubs c ON c.id = rr.club_id
       WHERE rr.status = 'confirmed'
       GROUP BY rr.competition_event_id, rr.club_id, c.name, rr.category_id
      HAVING count(*) > 1`,
    remediation: "Cancele los equipos sobrantes dejando uno confirmado por club, prueba y categoría.",
  },
  {
    id: "membresias-multiples",
    title: "Nadadores con más de una membresía ACTIVA",
    constraint: "club_swimmers_unique_active_person",
    query: `
      SELECT cs.person_id, p.full_name, count(*) AS clubes_activos,
             string_agg(cl.name, ', ') AS clubes
        FROM club_swimmers cs
        JOIN persons p ON p.id = cs.person_id
        JOIN clubs cl ON cl.id = cs.club_id
       WHERE cs.status = 'active'
       GROUP BY cs.person_id, p.full_name
      HAVING count(*) > 1`,
    remediation: "Finalice las membresías que no correspondan (status='ended', end_date=now()), dejando una activa por nadador.",
  },
  {
    id: "run-duplicado",
    title: "RUN repetido entre personas vigentes",
    constraint: "persons_run_unique_active",
    query: `
      SELECT run, count(*) AS repeticiones, string_agg(full_name, ' | ') AS personas
        FROM persons WHERE deleted_at IS NULL
       GROUP BY run HAVING count(*) > 1`,
    remediation:
      "Unifique las fichas duplicadas y elimine lógicamente las sobrantes (UPDATE persons SET deleted_at = now() WHERE id IN (...)). " +
      "El índice nuevo es parcial: ignora las filas eliminadas, así que el historial se conserva.",
  },
  {
    id: "username-persona-duplicado",
    title: "Nombre de usuario repetido entre personas vigentes",
    constraint: "persons_username_unique_active",
    query: `
      SELECT username, count(*) AS repeticiones, string_agg(full_name, ' | ') AS personas
        FROM persons WHERE deleted_at IS NULL
       GROUP BY username HAVING count(*) > 1`,
    remediation:
      "Renombre los usuarios repetidos, o elimine lógicamente la ficha sobrante (deleted_at = now()). " +
      "Cualquiera de las dos basta: el índice nuevo solo mira las personas vigentes.",
  },
  {
    id: "username-club-duplicado",
    title: "Nombre de usuario repetido entre clubes vigentes",
    constraint: "clubs_username_unique_active",
    query: `
      SELECT username, count(*) AS repeticiones, string_agg(name, ' | ') AS clubes
        FROM clubs WHERE deleted_at IS NULL
       GROUP BY username HAVING count(*) > 1`,
    remediation:
      "Renombre los usuarios repetidos, o elimine lógicamente el club sobrante (deleted_at = now()). " +
      "Cualquiera de las dos basta: el índice nuevo solo mira los clubes vigentes.",
  },
  {
    id: "categoria-duplicada",
    title: "Categorías vigentes con el mismo nombre dentro del mismo tipo de prueba",
    constraint: "categories_unique_active_name",
    query: `
      SELECT test_type_id, name, count(*) AS repeticiones, string_agg(id::text, ', ') AS ids
        FROM categories WHERE deleted_at IS NULL
       GROUP BY test_type_id, name HAVING count(*) > 1`,
    remediation:
      "Reasigne las inscripciones a la categoría que se conserva y elimine lógicamente las duplicadas " +
      "(UPDATE categories SET deleted_at = now() WHERE id IN (...)). NO hace falta borrarlas físicamente: el índice " +
      "nuevo es parcial y solo mira las categorías vigentes, y el índice de compatibilidad de " +
      "'indices-previos-ausentes' es ordinario, no único.",
  },
  {
    id: "grupo-categoria-duplicado",
    title: "Grupos de categorías vigentes con el mismo nombre",
    constraint: "category_groups_name_unique_active",
    query: `
      SELECT name, count(*) AS repeticiones, string_agg(id::text, ', ') AS ids
        FROM category_groups WHERE deleted_at IS NULL
       GROUP BY name HAVING count(*) > 1`,
    remediation:
      "Reasigne las categorías al grupo que se conserva y elimine lógicamente los duplicados " +
      "(UPDATE category_groups SET deleted_at = now() WHERE id IN (...)). Sin borrado físico.",
  },
  {
    id: "prueba-duplicada",
    title: "Pruebas maestras vigentes repetidas (mismo tipo, distancia, estilo y género)",
    constraint: "events_unique_active_definition",
    query: `
      SELECT test_type_id, distance_id, stroke_id, gender, count(*) AS repeticiones, string_agg(id::text, ', ') AS ids
        FROM events WHERE deleted_at IS NULL
       GROUP BY test_type_id, distance_id, stroke_id, gender HAVING count(*) > 1`,
    remediation:
      "Reapunte a la prueba que se conserva las competencias que usen las duplicadas y elimine lógicamente estas " +
      "últimas (UPDATE events SET deleted_at = now() WHERE id IN (...)). NO hace falta borrarlas físicamente: ver la " +
      "nota de 'categoria-duplicada'.",
  },
  {
    id: "indices-previos-ausentes",
    title: "Índices de la versión anterior que la migración espera poder eliminar",
    constraint: "DROP INDEX en 20260905000000_phase2_integrity",
    /**
     * La migración reemplaza cada índice único TOTAL por su versión parcial
     * con `DROP INDEX <nombre>; CREATE UNIQUE INDEX ...`. Ese `DROP INDEX` no
     * lleva `IF EXISTS`: si el índice no está —porque se eliminó a mano en
     * algún momento— la migración aborta a mitad y queda marcada como
     * fallida, bloqueando el despliegue.
     *
     * IMPORTANTE — el índice de compatibilidad NO debe ser único.
     *
     * `DROP INDEX` solo necesita que exista un índice con ese NOMBRE; le da
     * igual si es único o no. Pedir que se recreara el índice ÚNICO original
     * era una instrucción incompatible con la remediación de los duplicados:
     * esas indican eliminar lógicamente la fila sobrante (`deleted_at`), y
     * una fila eliminada lógicamente sigue existiendo para un índice TOTAL,
     * de modo que este nunca se podría crear. La consecuencia práctica era
     * exigir borrar historial físicamente solo para poder migrar.
     *
     * Con un índice ORDINARIO del mismo nombre, la migración lo encuentra, lo
     * elimina y crea en su lugar el índice único parcial correcto — que sí
     * ignora las filas eliminadas.
     *
     * Solo se reporta cuando el índice previo falta Y su reemplazo parcial
     * tampoco existe; si el reemplazo ya está, la migración ya se aplicó.
     */
    query: `
      SELECT esperado.previo AS indice_faltante,
             esperado.reemplazo AS indice_que_creara_la_migracion,
             format('CREATE INDEX %I ON %I (%s);', esperado.previo, esperado.tabla, esperado.columnas) AS sql_de_remediacion
        FROM (VALUES
                ('persons_run_key',                                     'persons',    '"run"',                                              'persons_run_unique_active'),
                ('persons_username_key',                                'persons',    '"username"',                                         'persons_username_unique_active'),
                ('clubs_username_key',                                  'clubs',      '"username"',                                         'clubs_username_unique_active'),
                ('categories_test_type_id_name_key',                    'categories', '"test_type_id", "name"',                             'categories_unique_active_name'),
                ('events_test_type_id_distance_id_stroke_id_gender_key','events',     '"test_type_id", "distance_id", "stroke_id", "gender"','events_unique_active_definition')
             ) AS esperado(previo, tabla, columnas, reemplazo)
       WHERE NOT EXISTS (SELECT 1 FROM pg_indexes i WHERE i.schemaname = 'public' AND i.indexname = esperado.previo)
         AND NOT EXISTS (SELECT 1 FROM pg_indexes i WHERE i.schemaname = 'public' AND i.indexname = esperado.reemplazo)`,
    remediation:
      "Cree un índice ORDINARIO (no único) con el nombre que falta, usando el SQL que aparece en la columna " +
      "'sql_de_remediacion' de cada fila. No recree el índice ÚNICO original: las filas eliminadas lógicamente " +
      "participan igual en un índice total y lo impedirían. La migración solo necesita que el nombre exista para " +
      "poder eliminarlo y crear en su lugar el índice único parcial definitivo.",
  },
  {
    id: "jornada-de-otra-competencia",
    title: "Pruebas de competencia asociadas a la jornada de OTRA competencia",
    constraint: "competition_events_session_belongs_to_competition_fkey",
    query: `
      SELECT ce.id AS competition_event_id, ce.competition_id AS competencia_de_la_prueba,
             d.competition_id AS competencia_de_la_jornada
        FROM competition_events ce
        JOIN competition_sessions s ON s.id = ce.competition_session_id
        JOIN competition_dates d ON d.id = s.competition_date_id
       WHERE d.competition_id <> ce.competition_id`,
    remediation:
      "Reasigne esas pruebas a una jornada de su propia competencia, o elimínelas si fueron creadas por error. " +
      "Sin esto, la clave foránea compuesta no se puede crear.",
  },
  {
    id: "cuenta-dueno-incoherente",
    title: "Cuentas de acceso cuyo tipo de dueño no coincide con sus columnas",
    constraint: "users_owner_coherente",
    // `owner_type::text` y no `owner_type = 'system'`: en la base ANTERIOR el
    // enum todavía no tiene ese valor y la comparación directa aborta la
    // consulta con "invalid input value for enum". El preflight corre, por
    // definición, antes de la migración que agrega el valor.
    query: `
      SELECT u.id, u.username, u.owner_type, u.person_id, u.club_id,
             CASE
               WHEN u.person_id IS NOT NULL AND u.club_id IS NOT NULL THEN 'tiene persona Y club'
               WHEN u.owner_type::text = 'person' AND u.club_id IS NOT NULL THEN 'declara persona pero apunta a un club'
               WHEN u.owner_type::text = 'club'   AND u.person_id IS NOT NULL THEN 'declara club pero apunta a una persona'
               ELSE 'tipo de dueño no coincide con las columnas'
             END AS motivo
        FROM users u
       WHERE NOT (
              (u.owner_type::text = 'person' AND u.person_id IS NOT NULL AND u.club_id IS NULL)
           OR (u.owner_type::text = 'club'   AND u.club_id   IS NOT NULL AND u.person_id IS NULL)
           OR (u.owner_type::text = 'system' AND u.person_id IS NULL     AND u.club_id   IS NULL)
       )
         -- Las cuentas sin persona ni club son el administrador: la migración
         -- las pasa sola a 'system'. No se reportan como bloqueo porque no
         -- requieren intervención.
         AND NOT (u.person_id IS NULL AND u.club_id IS NULL)`,
    remediation:
      "Cada cuenta debe tener UN dueño: una persona, un club, o ninguno si es del sistema. " +
      "Una cuenta con persona Y club a la vez debe quedarse con una sola (UPDATE users SET club_id=NULL WHERE id='...'), " +
      "y una cuyo owner_type no coincide con la columna que sí tiene debe corregir el owner_type. " +
      "El caso del administrador (sin persona ni club) lo resuelve la migración sola: pasa a owner_type='system'.",
  },
  {
    id: "username-colision-global",
    title: "Nombres de usuario compartidos por titulares distintos (persona, club o cuenta)",
    constraint: "username_reservations_pkey",
    query: `
      WITH titulares AS (
        SELECT p.username, 'person'::text AS owner_kind, p.id::text AS owner_id, 'persona: ' || p.full_name AS detalle
          FROM persons p WHERE p.deleted_at IS NULL
        UNION ALL
        SELECT c.username, 'club', c.id::text, 'club: ' || c.name
          FROM clubs c WHERE c.deleted_at IS NULL
        UNION ALL
        SELECT u.username,
               CASE WHEN u.person_id IS NOT NULL THEN 'person'
                    WHEN u.club_id   IS NOT NULL THEN 'club'
                    ELSE 'system' END,
               COALESCE(u.person_id, u.club_id, u.id)::text,
               'cuenta de acceso: ' || u.username
          FROM users u WHERE u.deleted_at IS NULL
      ), distintos AS (
        -- La deduplicación es por TITULAR, no por fila: una persona y su
        -- propia cuenta de acceso son el MISMO titular con el mismo nombre, y
        -- no deben contarse dos veces. Incluir la columna descriptiva en el
        -- DISTINCT las separaba (su texto difiere) y hacia que cualquier
        -- persona con credenciales apareciera como colision consigo misma.
        SELECT username, owner_kind, owner_id, min(detalle) AS detalle
          FROM titulares
         GROUP BY username, owner_kind, owner_id
      )
      SELECT username, count(*) AS titulares_distintos,
             string_agg(detalle || ' [' || owner_kind || ' ' || owner_id || ']', ' | ') AS titulares
        FROM distintos
       GROUP BY username
      HAVING count(*) > 1`,
    remediation:
      "Renombre a uno de los titulares antes de migrar. El nombre de usuario es inmutable desde la aplicación, así que " +
      "hay que hacerlo por base de datos (UPDATE persons SET username='...' WHERE id='...', y el mismo cambio en su fila " +
      "de users si tiene credenciales). Elija cuál conserva el nombre y avise al otro titular: es el nombre con el que entra al sistema.",
  },
  {
    id: "reservas-de-username-incoherentes",
    title: "Registro de nombres de usuario que no describe a los titulares reales",
    constraint: "username_reservations_pkey / users_forbid_owner_reassignment",
    // Solo aplica una vez creado el registro. En una base anterior a esa
    // migración no hay nada que comprobar: la tabla se crea y se carga en la
    // propia migración, que ya verifica su carga. Si la migración figura
    // aplicada y la tabla no está, eso NO es "no aplica": es un daño.
    requires: { table: "username_reservations", migration: "20260906010000_phase4_user_identity" },
    query: `
      WITH filas AS (
        SELECT p.username, 'person'::text AS owner_kind, p.id::text AS owner_id, 'persona: ' || p.full_name AS detalle
          FROM persons p WHERE p.deleted_at IS NULL
        UNION ALL
        SELECT c.username, 'club', c.id::text, 'club: ' || c.name
          FROM clubs c WHERE c.deleted_at IS NULL
        UNION ALL
        SELECT u.username,
               CASE WHEN u.person_id IS NOT NULL THEN 'person'
                    WHEN u.club_id   IS NOT NULL THEN 'club'
                    ELSE 'system' END,
               COALESCE(u.person_id, u.club_id, u.id)::text,
               'cuenta de acceso'
          FROM users u WHERE u.deleted_at IS NULL
      ), titulares AS (
        -- Se deduplica por TITULAR antes de arrastrar la descripción. Una
        -- persona y su propia cuenta son el mismo titular con el mismo
        -- nombre; agrupar incluyendo 'detalle' —cuyo texto difiere— las
        -- separaba y reportaba dos veces el mismo conflicto.
        SELECT username, owner_kind, owner_id, min(detalle) AS detalle
          FROM filas
         GROUP BY username, owner_kind, owner_id
      )
      -- (a) titular vigente sin reserva, y (b) reserva con propietario
      -- equivocado: se distinguen en la columna 'problema'.
      SELECT t.username, t.detalle AS titular,
             CASE WHEN r.username IS NULL THEN 'titular vigente sin reserva'
                  ELSE 'la reserva pertenece a ' || r.owner_kind || ' ' || r.owner_id
             END AS problema
        FROM titulares t
        LEFT JOIN username_reservations r ON r.username = t.username
       WHERE r.username IS NULL
          OR r.owner_kind IS DISTINCT FROM t.owner_kind
          OR r.owner_id   IS DISTINCT FROM t.owner_id
      UNION ALL
      -- (c) reservas huérfanas: retienen un nombre que ya nadie usa y que
      -- nadie puede volver a tomar.
      SELECT r.username, r.owner_kind || ' ' || r.owner_id, 'reserva sin titular vigente'
        FROM username_reservations r
       WHERE NOT EXISTS (SELECT 1 FROM persons p WHERE p.username = r.username AND p.deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM clubs   c WHERE c.username = r.username AND c.deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM users   u WHERE u.username = r.username AND u.deleted_at IS NULL)`,
    remediation:
      "El registro se puede reconstruir entero, porque no contiene informacion propia: borre las filas afectadas y " +
      "vuelva a insertarlas desde persons/clubs/users vigentes, con el mismo criterio de titular que usan los " +
      "disparadores (persona -> su id; club -> su id; cuenta del sistema -> su propio id). Hagalo ANTES de aplicar " +
      "phase4_identity_guards: despues de esa migracion el dueno de una cuenta es inmutable y una reserva mal " +
      "atribuida ya no se puede corregir cambiandolo.",
  },
  {
    id: "representantes-legales-multiples",
    title: "Clubes con más de un representante legal",
    constraint: "club_staff_unique_legal_representative",
    query: `
      SELECT cs.club_id, c.name AS club, count(*) AS representantes,
             string_agg(p.full_name, ' | ') AS personas
        FROM club_staff cs
        JOIN clubs c ON c.id = cs.club_id
        JOIN persons p ON p.id = cs.person_id
       WHERE cs.role_type = 'legal_representative'
       GROUP BY cs.club_id, c.name
      HAVING count(*) > 1`,
    remediation:
      "Deje UN representante legal por club: elimine las filas sobrantes de club_staff " +
      "(DELETE FROM club_staff WHERE id IN (...)). Quien deje el cargo pierde el rol funcional y el de acceso, " +
      "que se derivan del nombramiento; si además debe seguir operando el club, nómbrelo delegado.",
  },
  {
    id: "persona-en-varios-clubes",
    title: "Personas vinculadas como personal a más de un club",
    constraint: "club_staff_un_solo_club_por_persona",
    query: `
      SELECT cs.person_id, p.full_name AS persona, count(DISTINCT cs.club_id) AS clubes,
             string_agg(DISTINCT c.name || ' (' || cs.role_type || ')', ' | ') AS vinculos
        FROM club_staff cs
        JOIN persons p ON p.id = cs.person_id
        JOIN clubs c ON c.id = cs.club_id
       GROUP BY cs.person_id, p.full_name
      HAVING count(DISTINCT cs.club_id) > 1`,
    remediation:
      "Una persona es delegado, entrenador o representante legal de UN solo club. Elimine sus vínculos con los demás " +
      "(DELETE FROM club_staff WHERE person_id='...' AND club_id <> '<el que conserva>'). Es una decisión de negocio: " +
      "de ese vínculo depende a qué club queda acotada su sesión.",
  },
  {
    id: "cuenta-username-distinto-al-titular",
    title: "Cuentas de acceso cuyo nombre de usuario no es el de su titular",
    constraint: "users_username_igual_al_titular",
    query: `
      SELECT u.id, u.username AS username_cuenta,
             COALESCE(p.username, c.username) AS username_titular,
             COALESCE(p.full_name, c.name) AS titular
        FROM users u
        LEFT JOIN persons p ON p.id = u.person_id
        LEFT JOIN clubs   c ON c.id = u.club_id
       WHERE u.deleted_at IS NULL
         AND ((u.person_id IS NOT NULL AND u.username IS DISTINCT FROM p.username)
           OR (u.club_id   IS NOT NULL AND u.username IS DISTINCT FROM c.username))`,
    remediation:
      "El nombre de usuario es UNO por titular: la cuenta es su credencial, no una identidad aparte. Iguálelos por base " +
      "de datos, decidiendo cuál de los dos se conserva (UPDATE users SET username = (SELECT username FROM persons WHERE id = users.person_id) " +
      "WHERE id='...', o al revés). Recuerde que el elegido es el nombre con el que esa persona o club entran al sistema.",
  },
];
