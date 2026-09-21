# Sistema de Gestión de Competencias de Natación
## Documento base: Arquitectura, Modelo de Datos, Reglas de Negocio y Supuestos

---

## 1. Propuesta de Arquitectura

### 1.1 Visión general

Arquitectura de 3 capas desacopladas, contenedorizada, con separación estricta entre presentación, lógica de negocio y persistencia.

```
┌─────────────────────────────────────────────────────────┐
│  FRONTEND — React + TypeScript + Vite                    │
│  (SPA, consume API REST vía HTTPS)                        │
└───────────────────────┬───────────────────────────────────┘
                         │ HTTPS / JSON
┌───────────────────────▼───────────────────────────────────┐
│  API GATEWAY (Nginx / reverse proxy)                       │
│  - Terminación TLS, rate limiting, headers de seguridad     │
└───────────────────────┬───────────────────────────────────┘
                         │
┌───────────────────────▼───────────────────────────────────┐
│  BACKEND — Node.js + TypeScript + Express/Fastify           │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────────┐    │
│  │ Auth Module │ │ Domain/Core  │ │ Export/Reports    │    │
│  │ (JWT+Refresh│ │ (reglas de   │ │ (Team Manager,    │    │
│  │  RBAC)      │ │  negocio)    │ │  Excel/CSV/PDF)   │    │
│  └─────────────┘ └──────────────┘ └──────────────────┘    │
│  ORM: Prisma                                                │
└───────────────────────┬───────────────────────────────────┘
                         │
┌───────────────────────▼───────────────────────────────────┐
│  PostgreSQL (datos transaccionales)                         │
│  + Redis (opcional: sesiones/rate-limit/cache de catálogos) │
└───────────────────────────────────────────────────────────┘
```

> **Nota de estado (sustituida).** Redis figuraba como componente opcional y no se
> implementó. El rate limiting quedó **en memoria del proceso** (`@fastify/rate-limit`
> sin almacén externo), las sesiones se resuelven con JWT + refresh tokens en
> PostgreSQL, y no hay cache de catálogos. La decisión se conserva porque describe el
> diseño original; lo que hoy está en pie es el párrafo de abajo. Ver
> [1.2](#12-decisión-de-stack) y RB-15.

### 1.2 Decisión de stack

| Capa | Tecnología | Justificación |
|---|---|---|
| Frontend | React + TypeScript + Vite | Tipado estricto, ecosistema maduro, buen soporte de formularios complejos (React Hook Form + Zod) |
| Backend | Node.js + TypeScript + Fastify | Mismo lenguaje que el frontend (menor fricción de equipo), Fastify es más rápido que Express y tiene validación de esquema nativa |
| ORM | Prisma | Migraciones versionadas, tipado end-to-end, buen soporte de transacciones (crítico para inscripciones) |
| Base de datos | PostgreSQL 16 | Transaccional, soporta índices parciales/únicos compuestos (necesarios para reglas de duplicidad) |
| Cache/Rate-limit | ~~Redis~~ → **en memoria del proceso** (ver nota) | Rate limiting de login, bloqueo temporal por intentos fallidos, cache de catálogos (categorías/pruebas) |
| Autenticación | JWT (access 15 min) + Refresh Token (7 días, rotación) | Estándar, permite RBAC vía claims |
| Documentación API | OpenAPI 3.1 vía Fastify-Swagger | Autogenerada desde los esquemas Zod/TypeBox |
| Contenedores | Docker + docker-compose | Requisito explícito, facilita entorno local reproducible |

> **Sustitución de la fila "Cache/Rate-limit".** Redis nunca se incorporó y no forma
> parte del stack: `docker-compose.yml` levanta solo PostgreSQL y la configuración no
> tiene `REDIS_URL`. En su lugar:
>
> | Necesidad original | Cómo está resuelta hoy |
> |---|---|
> | Rate limiting | `@fastify/rate-limit` con contador **en memoria del proceso**: 300 req/min global (`RATE_LIMIT_GLOBAL_MAX`) y 20 req/min en `/auth/*` (`RATE_LIMIT_AUTH_MAX`). |
> | Bloqueo por intentos fallidos | En PostgreSQL, sobre la fila del usuario (RB-15). Es persistente y sobrevive a un reinicio, cosa que el contador en memoria no hace. |
> | Cache de catálogos | No se implementó; los catálogos se consultan directamente. |
>
> **Condición de validez:** el contador en memoria es por proceso, así que el límite
> efectivo se multiplica por el número de instancias. El despliegue previsto es de **una
> sola instancia**. Escalar horizontalmente exige volver a un contador compartido —Redis
> u otro— o mover el límite al proxy de entrada; hacerlo sin eso deja el rate limiting
> sin efecto real. El bloqueo de cuenta de RB-15 no depende de esto.
| Testing | Vitest (unitarias) + Vitest con `app.inject()` de Fastify contra PostgreSQL desechable (integración) + ~~Playwright~~ | Cobertura de reglas de negocio es la prioridad |

> **Sustitución de la fila "Testing".** Supertest no se usa: las pruebas de
> integración hablan HTTP con `app.inject()` del propio Fastify, contra la base
> desechable de `docker-compose.test.yml`. Y **Playwright no está instalado**: no
> hay ninguna prueba E2E. La herramienta quedó aprobada y el plan escrito, pero
> sin autorización para incorporar la dependencia; por eso la fila de arriba la
> deja tachada.

### 1.3 Diagrama de componentes (lógico)

> **Estructura real, no la planificada.** Este árbol se corrigió el 12 de
> septiembre de 2026 contra el repositorio. La versión anterior describía un
> `apps/` que nunca existió y módulos que se llamaron de otra forma
> (`swimmer-club-assignment`, `admin-dashboard`) o que se organizaron distinto
> (`export/adapters/team-manager/` terminó siendo el módulo
> `team-manager-export/`). `backend/tests/documentacion.test.ts` compara esta
> lista con `src/modules` y falla si sobra o falta alguno.

```
frontend/
├── src/
│   ├── modules/
│   │   ├── audit/
│   │   ├── auth/
│   │   ├── catalogs/           (tipos de prueba, categorías, distancias, estilos, pruebas)
│   │   ├── clubs/
│   │   ├── competitions/
│   │   ├── dashboard/
│   │   ├── persons/
│   │   ├── pools/
│   │   ├── registrations/
│   │   ├── relay-registrations/
│   │   ├── reports/
│   │   ├── swimmer-assignment/
│   │   └── team-manager-export/
│   ├── shared/                 # cliente HTTP, paginación, componentes comunes
│   ├── assets/
│   └── test/
backend/
├── src/
│   ├── modules/
│   │   ├── audit/
│   │   ├── auth/               # login, refresh, RBAC middleware, CSRF
│   │   ├── catalogs/
│   │   ├── clubs/
│   │   ├── competitions/
│   │   ├── dashboard/
│   │   ├── meet-import/        # importa el programa desde un .ev3 de Meet Manager
│   │   ├── persons/
│   │   ├── pools/
│   │   ├── registrations/      # dominio central + máquina de validaciones
│   │   ├── relay-registrations/
│   │   ├── reports/
│   │   ├── swimmer-assignment/
│   │   └── team-manager-export/
│   ├── shared/                 # errores, logger, utilidades de dominio
│   └── server.ts               # composición, sondas /health y /ready
├── prisma/
└── tests/
docker-compose.yml              # postgres + migrate + backend + frontend
docker-compose.test.yml         # base desechable para las pruebas de integración
```

**Principio clave de diseño**: el módulo `registrations` NO conoce el formato de exportación ni de reportes; expone únicamente el estado consistente de las inscripciones. `team-manager-export` y `reports` son consumidores de solo lectura. Esto permite agregar nuevos formatos de exportación (además de Team Manager) sin tocar el dominio.

---

## 2. Modelo de Datos

> **Revisado entero contra `prisma/schema.prisma` el 12 de septiembre de 2026.**
> Esta sección describía el modelo *propuesto*, y el implementado se separó de él
> en varios puntos: tablas que no se crearon, campos que cambiaron de dueño y
> **30 modelos** donde la propuesta enumeraba una docena. La fuente de verdad es
> el esquema; aquí queda el mapa conceptual, con las diferencias señaladas donde
> las hay. Una prueba compara la cantidad de modelos publicada con la real.

### 2.1 Diagrama entidad-relación (resumen textual)

```
Person 1───* PersonRole          (swimmer | delegate | coach | legal_representative)
Person 1───1 User                (credenciales, opcional — no toda persona tiene login)
Person 1───* ClubStaff *───1 Club   (delegado / entrenador / representante legal)
Person 1───* ClubSwimmer *───1 Club (historial de pertenencia, con estado y vigencia)

Club 1───1 User                  (credenciales del club)

TestType 1───* Category          (Category puede agruparse en CategoryGroup)
TestType 1───* Event             (Event = "prueba": distancia + estilo + género)
Event 1───1 Distance, 1───1 Stroke

Pool 1───* Competition           (curso de piscina: largo 50 m o corto 25 m)
Competition 1───* CompetitionDate 1───* CompetitionSession 1───1 SessionLimit
Competition 1───* CompetitionEvent ───1 Event
CompetitionEvent 1───* CompetitionEventCategory ───1 Category

Registration        → Person(nadador) + CompetitionEvent + Club + Category
RelayRegistration   → Club + CompetitionEvent + Category
                    → RelayRegistrationMember (1..4, con orden, Person)

User 1───* RefreshToken, UserRole ; Role *───* Permission (vía RolePermission)
AuditLog → referencia genérica (entity_type, entity_id) + before/after JSON
SystemSetting, UsernameReservation, PasswordResetToken (ver notas abajo)
```

**Diferencias con la propuesta original**, todas confirmadas en el esquema:

- `DelegateAssignment` y `CoachAssignment` **no existen**. El personal del club
  vive en una sola tabla, `ClubStaff`, con `role_type` — y ese `role_type`
  incluye al representante legal.
- La relación `Club *───* Person` que dibujaba la propuesta era N:M sin
  restricción. Hoy una persona es personal de **un solo** club (A-02).
- `CategoryGroup`, `Pool` y `UsernameReservation` no estaban previstos.

### 2.2 Tablas principales

> **La convención NO es uniforme.** La propuesta afirmaba que *todas* las tablas
> de negocio tienen `created_by`, `updated_by` y `deleted_at`. No es así, y la
> diferencia importa: las tablas con **eliminación lógica** (`deleted_at`) son
> las de catálogo y de entidades —`Person`, `Club`, `Category`, `Event`,
> `Distance`, `Stroke`, `Pool`, `CategoryGroup`, `User`—, mientras que las de
> **hechos** no se borran lógicamente: `ClubSwimmer` cambia de `status`,
> `Registration` pasa a `cancelled`, `AuditLog` no se toca en absoluto y no
> tiene siquiera `updated_at`. Lo mismo con la autoría: `created_by` /
> `updated_by` están en las entidades, no en los hechos, que registran quién
> actuó en columnas propias (`requested_by_user_id`, `registered_by_user_id`,
> `cancelled_by_user_id`).

**users** — `id`, `username`, `password_hash`, `must_change_password`,
`status ENUM(active,locked,disabled)`, `owner_type ENUM(person,club,system)`,
`person_id` / `club_id` (excluyentes), `last_login_at`,
`failed_login_attempts`, `locked_until`

- La credencial es un **nombre de usuario**, no un correo, y su unicidad es
  **parcial**: solo entre filas vigentes, para que una eliminación lógica libere
  el nombre. De ahí que el administrador inicial se siembre con
  `SEED_ADMIN_USERNAME`.
- `owner_type` tiene **tres** valores. `system` modela explícitamente al
  administrador, que no es ni persona ni club: antes se guardaba como `person`
  con `person_id` nulo, un estado que contradecía su propio tipo e impedía
  exigir coherencia en la base. Con el tercer valor, una restricción
  (`users_owner_coherente`) exige que `person` traiga persona, `club` traiga club
  y `system` no traiga ninguna.

**username_reservations** — reserva nombres de usuario para que dos altas
simultáneas no se los disputen. No estaba previsto.

**roles** / **permissions** / **role_permissions** / **user_roles** — RBAC clásico
many-to-many. **refresh_tokens** — sesiones vivas, con rotación.

~~**password_reset_tokens**~~ — **eliminada** el 13 de septiembre de 2026
(migración `20260913000000_drop_dead_schema`). Sobrevivía del flujo de
auto-recuperación por correo, retirado por decisión explícita, y ningún código la
leía ni la escribía. El único restablecimiento es el administrativo, que no la
usa.

**persons** — `id`, `run`, `username`, `first_name`, `paternal_last_name`,
`maternal_last_name`, `full_name`, `birth_date`, `gender ENUM(male,female)`,
`email`, `phone`, `status ENUM(active,locked,disabled)`

- El nombre está **descompuesto** en tres columnas y `full_name` es el
  compuesto; la propuesta solo contemplaba `full_name`. La separación existe
  porque la exportación a Team Manager necesita apellidos y nombre por separado.
- `gender` no estaba en la propuesta: lo exige la validación de género de la
  sección 15.
- `run` es único **entre filas vigentes**, igual que `username`.

**person_roles** — `id`, `person_id`, `role_type ENUM(swimmer,delegate,coach,legal_representative)`, `active`
- Único por `(person_id, role_type)`.

**clubs** — `id`, `name`, `username`, `code`, `has_legal_status`, `rut`
(obligatorio solo si `has_legal_status`, RB-02), `legal_name`, `email`,
`is_achmn_member`, `is_achmn_collaborator`, `is_fchmn_member`,
`is_fchmn_collaborator`, `status`

**club_staff** — `id`, `club_id`, `person_id`, `role_type ENUM(delegate,coach,legal_representative)`
- Único por `(club_id, person_id, role_type)`. Sustituye a las columnas
  `delegate_person_id` / `coach_person_id` de la propuesta, que **nunca
  existieron**.

**club_swimmers** (historial de pertenencia) — `id`, `club_id`, `person_id`,
`status ENUM(pending,active,rejected,ended)`, `requested_by_user_id`,
`reviewed_by_user_id`, `reviewed_at`, `rejection_reason`, `start_date`, `end_date`
- Los estados `pending` y `rejected` vienen de A-05: el club propone y el
  administrador aprueba o rechaza.
- Índice único parcial `UNIQUE(person_id) WHERE status='active'` — ver la nota
  de §2.3 sobre `SWIMMER_SINGLE_CLUB_ACTIVE`.

**pools** — `id`, `name`, `address`, `course_length ENUM(long_50m,short_25m)`,
`is_heated`, `is_covered`

**test_types** — `id`, `name`, `swimmers_count` (1 o 4)

**category_groups** — `id`, `name`. Agrupa categorías para presentarlas juntas.

**categories** — `id`, `test_type_id`, `category_group_id`, `name`, `min_age`, `max_age`
- **Sin `cutoff_date`.** La propuesta la ponía aquí; hoy la fecha de corte es de
  la **competencia** (`competitions.age_cutoff_date`), porque una misma categoría
  se reutiliza entre competencias con cortes distintos. RB-05 se recalculó en
  consecuencia.

**distances** — `id`, `meters` (único). **strokes** — `id`, `name`.

**events** ("pruebas maestras") — `id`, `test_type_id`, `distance_id`,
`stroke_id`, `gender ENUM(male,female,mixed)`
- En relevos, la distancia es la **total** de la prueba (un 4×50 son 200 m), no
  la de cada posta. Ver la sección correspondiente del `README.md`.

**competitions** — `id`, `name`, `description`,
`status ENUM(draft,scheduled,open,closed,in_progress,finished,cancelled)`,
`registration_start_at`, `registration_end_at`, `age_cutoff_date`,
`max_individual_events_per_swimmer`, `max_relay_events_per_swimmer_per_session`,
`pool_id`

**competition_dates** — `id`, `competition_id`, `date`. Único por competencia y fecha.

**session_types** — catálogo extensible (mañana/tarde/…).
**competition_sessions** — `id`, `competition_date_id`, `session_type_id`,
`competition_id`. Única la combinación fecha+tipo de jornada.

**session_limits** — `id`, `competition_session_id` (único), `max_individual_events`,
`max_relay_events`; `NULL` significa "sin límite".

**competition_events** — `id`, `competition_id`, `event_id`,
`competition_session_id`, `status`, `display_order`. Único por
`(competition_id, event_id, competition_session_id)`.
**competition_event_categories** — puente con las categorías habilitadas.

**registrations** (individuales) — `id`, `competition_event_id`, `person_id`,
`club_id`, `category_id`, `status ENUM(confirmed,cancelled)`,
`seed_time_centiseconds`, `registered_by_user_id`, `cancelled_by_user_id`,
`cancelled_at`, `is_post_close_exception`
- `seed_time_centiseconds` y `is_post_close_exception` no estaban previstos: el
  primero es la marca de referencia que exporta Team Manager; el segundo marca
  las excepciones posteriores al cierre (RB-08), visibles en listados y reportes.

**relay_registrations** — mismas columnas, sin `person_id`.
**relay_registration_members** — `id`, `relay_registration_id`, `person_id`,
`order_position` (1-4).

~~**system_settings**~~ — **eliminada** el 13 de septiembre de 2026, en la
misma migración. Dejó de sembrarse al retirarse los dos parámetros que tenía
—`LOGIN_MAX_ATTEMPTS`, que nadie leía, y `SWIMMER_SINGLE_CLUB_ACTIVE`, que no
configuraba nada (§2.3)—; quitarlos del seed no borra lo ya escrito, así que
pudo conservar filas hasta el `DROP TABLE` (ver §2.2.1). Si algún día hace falta un parámetro que de verdad se
configure en caliente, la tabla se vuelve a crear con su propia migración.
Mantener una tabla sin consumidores no aportaba utilidad y sí invitaba a creer
que existía configuración dinámica.

**audit_logs** — `id`, `user_id`, `action`, `entity_type`, `entity_id`,
`ip_address`, `before JSONB`, `after JSONB`, `created_at`

### 2.2.1 Esquema muerto, retirado

Dos modelos quedaron sin ningún consumidor productivo y se eliminaron el 13 de
septiembre de 2026 con la migración `20260913000000_drop_dead_schema`, **antes de
la primera versión** y con autorización explícita.

| Modelo | Por qué quedó huérfano |
|---|---|
| `PasswordResetToken` | Sobrevivía del flujo de auto-recuperación por correo, eliminado por decisión explícita: no hay servidor de correo y la implementación anterior devolvía el token en la propia respuesta HTTP. El único restablecimiento es el administrativo, que genera una contraseña temporal y no usa esta tabla. |
| `SystemSetting` | Dejó de tener parámetros **consumidos y sembrados** por la aplicación al retirarse `LOGIN_MAX_ATTEMPTS` (nadie la leía) y `SWIMMER_SINGLE_CLUB_ACTIVE` (invariante disfrazada, §2.3). Qué filas conservara una base concreta no se comprobó. |

**Cómo se hizo, y por qué así:**

- Con una **migración nueva**. Las ya aplicadas no se editan: Prisma calcula el
  checksum sobre el **archivo completo**, comentarios incluidos, así que
  cambiarlas deja el historial de la base describiendo algo que ya no está en
  disco.

  > **Ocurrió aquí, y conviene que quede escrito.** Los comentarios de
  > `drop_dead_schema` se retocaron después de aplicarla a `natacion_test`, y el
  > checksum divergió (`23acb018…` guardado frente a `8820c182…` del archivo).
  > Se corrigió por el único camino legítimo: congelar el contenido, **recrear
  > la base desechable** con `prisma migrate reset` y aplicar las 21 migraciones
  > desde cero — sin tocar `_prisma_migrations` a mano y sin `migrate resolve`,
  > que habrían tapado la divergencia en vez de resolverla.
  >
  > Ninguna prueba lo detectaba: las de `migration-upgrade` trabajan sobre una
  > base efímera que crean y migran con los archivos actuales, así que por
  > construcción nunca ven una divergencia. Ahora hay tres pruebas que miran la
  > base de integración real —la que conserva su historial entre corridas— y
  > comparan checksum a checksum.
- Es **destructiva** y se asumió como tal. Con precisión sobre las filas, que
  es donde una frase cómoda se vuelve una afirmación sin respaldo: **podían
  existir filas históricas en ambas tablas** y **no se inspeccionaron**. Que
  `password_reset_tokens` dejara de escribirse no borra lo escrito antes, y
  quitar un `upsert` del seed no vacía `system_settings`. Se descartaron
  **deliberadamente**, con autorización explícita, porque todos los datos
  actuales son de prueba y las bases se recrean antes de la primera versión. No
  hubo comprobación previa ni volcado, y no se pretendía que los hubiera.
  `rollback.sql` restaura **solo la estructura**; recuperar filas exigiría el
  respaldo previo a la migración.
- Se aplicó y probó **únicamente en `natacion_test`**: la suite de integración
  corre `prisma migrate deploy` en su arranque contra esa base. **`natacion` no
  se tocó**; se recreará con un procedimiento controlado antes de publicar.
- Se retiró además la relación sobrante `User.passwordResetTokens`, que sin la
  tabla no tenía sentido.
- El recuento de modelos bajó de 32 a **30**, y hay una prueba que compara esa
  cifra con el esquema: la documentación tenía que actualizarse en el mismo
  cambio o el build habría fallado.
- **Tiene plan de reversión**, como el resto de las migraciones delicadas del
  proyecto: `rollback.sql` restaura la **estructura** de las dos tablas —vacías,
  con sus columnas, clave primaria, índice único y clave foránea—, y lo dice sin
  rodeos: **no recupera datos**. Basta para lo que la reversión debe permitir
  —que el esquema anterior vuelva a ser válido y una versión previa arranque—;
  la recuperación de filas, si alguna vez hiciera falta, es un restore del
  respaldo previo y no ese archivo.
  `tests/migration-upgrade.integration.test.ts` lo **ejecuta de verdad**, así que
  un plan que dejara de servir haría fallar la suite.
- **El efecto se comprueba, no se supone.** Cuatro pruebas consultan el catálogo
  de PostgreSQL: las dos tablas ya no existen, la migración consta como aplicada
  en `_prisma_migrations`, y las tablas que no debía tocar siguen ahí —el
  contraste, sin el cual una prueba de ausencias pasaría también si la migración
  hubiera arrasado con media base—.

### 2.3 Índices y restricciones críticas

| Restricción | Motivo |
|---|---|
| `UNIQUE(persons.run)` **entre filas vigentes** | RUN no duplicado, sin que un borrado lógico lo bloquee para siempre |
| `UNIQUE(persons.username)`, `UNIQUE(clubs.username)`, `UNIQUE(users.username)`, todas parciales | La credencial se libera al eliminar lógicamente |
| `UNIQUE(club_staff: club_id, person_id, role_type)` | Un mismo cargo no se duplica |
| `UNIQUE(club_swimmers.person_id) WHERE status='active'` | Un nadador activo, un club — **ver la nota de abajo** |
| `UNIQUE(registrations: competition_event_id, person_id) WHERE status='confirmed'` | No hay inscripción individual duplicada (RB-09) |
| `UNIQUE(relay_registrations: competition_event_id, club_id, category_id) WHERE status='confirmed'` | Un solo equipo confirmado por club, prueba y categoría |
| `UNIQUE(relay_registration_members: relay_registration_id, person_id)` | Ningún nadador repetido dentro de un relevo |
| `UNIQUE(relay_registration_members: relay_registration_id, order_position)` | Ninguna posta duplicada |
| `UNIQUE(competition_dates: competition_id, date)` | Una fecha no se repite en una competencia |
| `UNIQUE(competition_sessions: competition_date_id, session_type_id)` | Una jornada por tipo y fecha |
| `UNIQUE(competition_events: competition_id, event_id, competition_session_id)` | Una prueba no se asigna dos veces a la misma jornada |
| `CHECK` de coherencia de dueño en `users` | `person` trae persona, `club` trae club, `system` ninguna |
| «Exactamente 4 integrantes por relevo» | **No** es una restricción SQL: se inserta en dos pasos y se valida en el servicio, dentro de una transacción |

> **Resuelto el 13 de septiembre de 2026 — «un solo club activo» es una
> INVARIANTE.** El índice único parcial sobre `club_swimmers.person_id` se crea
> **incondicionalmente** en la migración, mientras el servicio consultaba
> `SWIMMER_SINGLE_CLUB_ACTIVE` antes de comprobar la regla. Con el parámetro en
> `false`, PostgreSQL seguía impidiendo la segunda membresía activa y el usuario
> veía un error de base de datos en vez del mensaje de negocio: la regla no era
> configurable en la práctica.
>
> Se decidió en favor de la invariante. El parámetro se retiró del seed y del
> servicio; la comprobación es incondicional y su valor está en llegar **antes**
> que la base, con un mensaje entendible. El índice se conserva como garantía
> real: cubre dos inserciones concurrentes, que ninguna comprobación previa puede
> evitar por sí sola. Cubierto en `tests/authorization.integration.test.ts`.
>
> **Texto histórico, identificado como tal.** El comentario dentro de
> `prisma/migrations/20260905000000_phase2_integrity/migration.sql` (líneas
> 55-61) afirma que el índice «se crea solo si el parámetro está activo». Eso
> **nunca fue cierto** —el `CREATE UNIQUE INDEX` es incondicional— y **no se
> corrigió a propósito**: editar una migración ya aplicada cambia su suma de
> verificación y Prisma la rechazaría en el siguiente despliegue. Ese comentario
> debe leerse como un registro de lo que se creía al escribirlo, no como
> documentación vigente. Las descripciones vigentes son esta nota y el comentario
> de `ClubSwimmer` en `schema.prisma`.

## 3. Reglas de Negocio Identificadas (RB)

| # | Regla |
|---|---|
| RB-01 | Un `user` pertenece exclusivamente a una `person` **o** a un `club`, nunca a ambos — o a **ninguno** de los dos si es el administrador del sistema (`owner_type = system`). La coherencia se exige con una restricción en la base, no solo en el servicio. |
| RB-02 | `rut` de club es obligatorio **solo si** `has_legal_status = true`; se valida formato y dígito verificador chileno. |
| RB-03 | `run` de persona es obligatorio, se valida con el dígito verificador chileno y es único **entre las filas vigentes**: una persona eliminada lógicamente no bloquea su RUN para siempre. |
| RB-04 | Una persona puede tener múltiples roles simultáneos vía `person_roles`, que hoy son cuatro: nadador, delegado, entrenador y representante legal. Los tres últimos se **derivan** del nombramiento en `club_staff`, no se marcan a mano. |
| RB-05 | La edad de un nadador para efectos de categoría se calcula con `birth_date` vs. la **fecha de corte de la COMPETENCIA** (`competitions.age_cutoff_date`), no la de inscripción ni la de la prueba. ~~`category.cutoff_date`~~: esa columna no existe; la fecha de corte se movió a la competencia porque una misma categoría se reutiliza entre competencias con cortes distintos. |
| RB-06 | Un nadador activo pertenece a un club a la vez. Es una **invariante**, no un parámetro: ~~`SWIMMER_SINGLE_CLUB_ACTIVE`~~ se retiró porque no configuraba nada. Se comprueba siempre en el servicio —para dar el mensaje claro— y la garantiza un índice único parcial. Ver la nota al final de §2.3. |
| RB-07 | Las inscripciones solo pueden crearse si `competition.status = open` y `now()` está entre `registration_start_at` y `registration_end_at`. |
| RB-08 | Tras el cierre de inscripciones, los clubes pierden permiso de modificación; los administradores pueden hacer cambios excepcionales, quedando registrados en `audit_logs` con marca de "excepción post-cierre". |
| RB-09 | No puede existir más de una inscripción **confirmada** del mismo nadador en la misma `competition_event`. |
| RB-10 | Los límites `max_individual_events` / `max_relay_events` de `session_limits` se evalúan por **nadador**, por **fecha** y **jornada**, no por competencia completa. `NULL` significa «sin límite». La competencia tiene además sus propios topes (`max_individual_events_per_swimmer`, `max_relay_events_per_swimmer_per_session`), que llegan con la importación del programa. |
| RB-11 | En relevos se exigen exactamente 4 integrantes al inscribir, sin duplicados y todos elegibles (activos, del club, cumpliendo categoría y género). El **orden** de las postas importa y se persiste (`order_position`): en pruebas Combinado es espalda, pecho, mariposa, libre. |
| RB-12 | El género del nadador debe ser compatible con `event.gender` (si el evento es `mixed`, no aplica restricción). |
| RB-13 | Eliminar una prueba de una competencia (`competition_events`) no elimina el `event` maestro — solo la relación. Mismo criterio aplica al desasociar categorías, tipos de prueba, etc. (soft-delete / eliminación de relación, nunca del catálogo maestro). |
| RB-14 | Toda operación de creación/modificación/bloqueo sobre clubes, personas, asignaciones, competencias, inscripciones y exportaciones genera un registro en `audit_logs`. |
| RB-15 | Bloqueo temporal de cuenta tras N intentos fallidos de login (parametrizable, sugerido 5 intentos → bloqueo 15 min). ~~Gestionado vía Redis~~ → implementado **en PostgreSQL**, sobre la fila del usuario: así el bloqueo persiste tras un reinicio y no depende de un componente que no se incorporó (ver nota en 1.2). |

---

## 4. Supuestos Funcionales

1. **RUN vs. RUT**: se asume que "RUN" (personas) y "RUT" (clubes con personalidad jurídica) siguen el mismo algoritmo de validación chileno estándar (módulo 11).
2. Un club **sin** personalidad jurídica puede seguir operando en el sistema (inscribiendo nadadores) — el RUT solo es obligatorio si `has_legal_status = true`.
3. ~~El campo "Delegado(a)" y "Entrenador(a)" a nivel de **club** representa al delegado/entrenador **principal** (1 cada uno).~~ **Supuesto descartado**: no hay «principal». Un club tiene tantos delegados y entrenadores como haga falta, todos en `club_staff`, y el rol individual de `person_roles` se deriva de ese nombramiento. Lo único limitado a uno por club es el representante legal.
4. Las categorías (`edad mínima/máxima`) se definen una vez y se reutilizan entre competencias — no se duplican por competencia. **La fecha de corte NO es de la categoría**, precisamente por esa reutilización: es de cada competencia (`age_cutoff_date`), y es la que usa RB-05.
5. El "orden de competencia" de una prueba dentro de una competencia es informativo (para armar el programa), no afecta reglas de inscripción.
6. Los reportes y exportaciones son de solo lectura sobre el estado confirmado de inscripciones al momento de generarse (no hay "snapshot" versionado salvo lo que registre `audit_logs`).
7. El acceso de "Delegado" y "Entrenador" (roles de sistema, sección 3.3-3.4) se modela como usuarios vinculados a una `person`. ~~Vía una tabla de asignación `delegate_club_access` / `coach_club_access`.~~ **Esas tablas no se crearon**: el club sobre el que operan sale de `club_staff`, y es **uno solo** (A-02). Si una persona apareciera vinculada a dos clubes, la resolución falla cerrado en vez de elegir uno.
8. "Team Manager" se asume como el software de gestión de competencias de natación ampliamente usado en el ámbito FINA/World Aquatics (formato de archivo tipo Hy-Tek/SD3 o similar) — **a confirmar**, ver A-06.

---

## 5. Parámetros de Configuración (no hardcodeados)

> **Corregida el 12 de septiembre de 2026 contra el código.** La columna «dónde
> vive» decía `system_settings` para los límites de bloqueo; el servidor los lee
> del entorno.

| Parámetro | Variable / clave | Valor por defecto | Dónde vive de verdad |
|---|---|---|---|
| ~~Nadador simultáneo en un solo club~~ | ~~`SWIMMER_SINGLE_CLUB_ACTIVE`~~ | — | **Retirado**: era una invariante disfrazada de parámetro (RB-06 y §2.3) |
| Intentos fallidos antes de bloqueo | `LOGIN_MAX_ATTEMPTS` | 5 | **Entorno** (`env.schema.ts`, rango 1–100) |
| Duración de bloqueo temporal | `LOGIN_LOCKOUT_MINUTES` | 15 min | **Entorno** (rango 1–1440) |
| Límite global de peticiones | `RATE_LIMIT_GLOBAL_MAX` | 300/min | Entorno; contador **en memoria del proceso** |
| Límite de peticiones en `/auth/*` | `RATE_LIMIT_AUTH_MAX` | 20/min | Ídem |
| Expiración del access token | `JWT_ACCESS_EXPIRES_IN` | 15 min | Entorno |
| Expiración del refresh token | `JWT_REFRESH_EXPIRES_IN_DAYS` | 7 días, con rotación | Entorno |
| Máximo de pruebas por nadador y jornada | — | sin límite (`NULL`) | Datos: `session_limits`, por fecha+jornada |
| Máximo de relevos por nadador y jornada | — | sin límite (`NULL`) | Ídem |
| Curso de piscina para exportar | — | sin valor por omisión | Datos: la piscina de la competencia; sin ella la exportación falla |

> **Configuración muerta eliminada (12 de septiembre de 2026).** El seed escribía
> también una fila `LOGIN_MAX_ATTEMPTS` en `system_settings` que **nadie leía**:
> el servicio de autenticación usa la variable de entorno. Ofrecer una perilla que
> no hace nada es peor que no ofrecerla, así que se quitó del seed. La única
> fuente es el entorno. El dato histórico no se migra: las bases actuales son de
> prueba y se recrean antes de la primera versión.

---

## 6. Roles y Matriz de Permisos (RBAC)

> **Corregida el 12 de septiembre de 2026.** Aparecen dos roles que no existían
> cuando se escribió esta propuesta —**representante legal** y **nadador**— y se
> ajusta el alcance del personal del club: opera sobre **su** club, uno solo, no
> sobre «clubes asignados»; esa idea murió con la tabla N:M descartada en A-02.
> La definición viva está en `src/modules/auth/rbac.definitions.ts` y se verifica
> en `tests/rbac.definitions.test.ts`.

Seis roles. `delegate`, `coach` y `legal_representative` comparten literalmente la
misma lista (`CLUB_STAFF_PERMISSIONS`), así que van en una sola columna:

| Acción | Admin | Club | Personal del club | Nadador |
|---|:---:|:---:|:---:|:---:|
| CRUD Personas | ✅ | ❌ | ❌ | ❌ |
| CRUD Clubes | ✅ | Solo lectura | Solo lectura | ❌ |
| Asignar nadador a club | ✅ (aprueba) | Propone (`pending`) | Propone | Solo consulta su club |
| Crear competencia | ✅ | ❌ | ❌ | ❌ |
| Inscribir nadadores | ✅ | ✅ (su club) | ✅ (su club) | ✅ (solo a sí mismo, individuales) |
| Modificar inscripción (competencia abierta) | ✅ | ✅ (su club) | ✅ (su club) | ✅ (las suyas) |
| Modificar inscripción (competencia cerrada) | ✅ (excepcional, auditado, `registrations:write:post-close`) | ❌ | ❌ | ❌ |
| Ver reportes | ✅ (global) | Solo su club | Solo su club | Solo lo suyo |
| Exportar Team Manager | ✅ | ❌ | ❌ | ❌ |
| Consultar auditoría | ✅ | ❌ | ❌ | ❌ |

Dos precisiones que la matriz no puede expresar:

- **El permiso habilita la acción; el alcance decide sobre qué.** Que un club no
  pueda inscribir nadadores de otro club, o que un nadador solo se inscriba a sí
  mismo, no lo garantiza el permiso sino el contexto del actor
  (`shared/actorContext.ts`), en la capa de servicio.
- Al representante legal lo distinguen sus **reglas de nombramiento** —uno por
  club, y solo si el club tiene personalidad jurídica—, no sus atribuciones.

---

## 7. Ambigüedades y Decisiones Pendientes

**Estado: RESUELTAS.** Decisiones confirmadas:

| # | Ambigüedad | Decisión final |
|---|---|---|
| A-01 | Delegado/Entrenador único por club vs. varios | 🔄 **Cambiado dos veces.** La propuesta decía «1 principal por club» con FK directa; la implementación admite **varios** delegados y varios entrenadores por club, en la tabla `club_staff`. |
| A-02 | Alcance de representación de un delegado | ✅ Un delegado **solo puede representar el club donde fue nombrado**. Se descartó la tabla `delegate_club_access` (N:M), pero el alcance **no** se resuelve con `clubs.delegate_person_id` —esa columna no existe—, sino con `club_staff`. |
| A-03 | Multi-usuario por club | ✅ Una credencial por club en el MVP. |
| A-04 | Regla "nadador en un solo club" | 🔄 **Cambiada el 13/09/2026**: se resolvió como **invariante**, no como parámetro. La configurabilidad era ficticia —el índice único de la base se crea siempre— y solo servía para cambiar un mensaje claro por un error de base de datos. |
| A-05 | Auto-gestión de plantel por el club | 🔄 **Cambio respecto a la propuesta**: la asignación de nadadores a un club **requiere aprobación del administrador**. El club puede *proponer* (crear una solicitud en estado `pending`), pero la fila en `club_swimmers` solo pasa a `active` cuando un administrador la aprueba. Se agrega estado `status ENUM(pending, active, rejected, ended)` en `club_swimmers`. |
| A-06 | Formato exacto de exportación Team Manager | ✅ Adaptador desacoplado con interfaz genérica; mapeo exacto de columnas queda pendiente de archivo de muestra real. |
| A-07 | Categorías globales vs. por competencia | ✅ Catálogo global reutilizable. |
| A-08 | Modificar categoría con inscritos existentes | ✅ No se re-valida retroactivamente; solo aplica a nuevas inscripciones. |
| A-09 | Límite de pruebas uniforme vs. por categoría | ✅ Uniforme por fecha + jornada. |
| A-10 | Multi-idioma / multi-moneda | ✅ No aplica por ahora. |

### Impacto de los cambios A-02 y A-05 en el modelo de datos

**A-02** — Se **elimina** la tabla `delegate_club_access` (N:M) planteada como propuesta, pero **no** como decía esta sección. Lo que quedó implementado:
- El personal del club vive en `club_staff` (`club_id`, `person_id`, `role_type`).
  Las columnas `clubs.delegate_person_id` y `clubs.coach_person_id` **nunca
  existieron** en el esquema: un club puede tener varios delegados y varios
  entrenadores.
- Lo que sí se conserva es el **alcance**: una persona es personal de un solo
  club, cualquiera sea el cargo. La restricción se aplica al asignar y, si aun así
  aparecieran vínculos con dos clubes, la resolución del club de una persona
  **falla cerrado** en vez de elegir uno.
- El acceso RBAC se resuelve buscando a la persona en `club_staff`, no comparando
  una FK.

**Representante legal** (regla confirmada después de esta propuesta) — es un
**rol de acceso** con exactamente las mismas atribuciones que un delegado. Sus
reglas propias:
- Solo existe si el club declara personalidad jurídica (RB-02); si el club la
  pierde, el nombramiento se retira automáticamente.
- Como máximo **uno por club** —a diferencia de delegados y entrenadores—, y le
  aplica la misma restricción de un solo club.
- Puede tener credenciales, pero no las requiere.
- El rol funcional (`person_roles`) y el de acceso (`user_roles`) se **derivan**
  del nombramiento: se activan al nombrarlo y se desactivan al retirarlo,
  reemplazarlo o quitarle al club la personalidad jurídica.

La equivalencia de permisos se verifica en `tests/rbac.definitions.test.ts` y el
ciclo de vida completo en `tests/legal-representative.integration.test.ts`.

**A-05** — Se modifica la tabla `club_swimmers`:
```
club_swimmers
  id, club_id, person_id,
  status ENUM(pending, active, rejected, ended),   -- antes: active/ended
  requested_by_user_id,        -- quién propuso la asignación (club)
  reviewed_by_user_id NULLABLE,-- admin que aprobó/rechazó
  reviewed_at NULLABLE,
  start_date NULLABLE,         -- se completa al aprobar (= reviewed_at o fecha indicada)
  end_date NULLABLE
```
Flujo: `Club crea solicitud (pending)` → `Admin aprueba (active, start_date=hoy)` **o** `Admin rechaza (rejected)`. Un nadador solo puede tener una fila en `active` a la vez (constraint de RB-06/A-04 aplica solo sobre filas `active`, no sobre `pending`). Toda transición queda en `audit_logs` (RB-14).

---

## 8. Próximos Pasos

Conforme a la sección 24 del requerimiento ("Forma de Trabajo"), una vez validados este documento y las ambigüedades (sección 7), se procede módulo por módulo en el orden definido:

1. Autenticación y usuarios
2. ABM de personas
3. ABM de entidades/clubes
4. Asignación de nadadores a clubes
5. Tipos de pruebas, categorías y pruebas
6. Competencias, fechas y jornadas
7. Inscripciones individuales
8. Inscripciones de relevos
9. Validaciones
10. Reportes
11. Exportación Team Manager
12. Auditoría
13. Pruebas y documentación final

Cada módulo se entregará con: modelo de datos (migración Prisma), endpoints (OpenAPI), reglas de negocio, validaciones, pantallas, código frontend/backend y pruebas — tal como especifica el requerimiento.
