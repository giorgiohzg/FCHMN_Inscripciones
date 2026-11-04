# Plan para seis cambios — 1 de noviembre de 2026

Documento de **planificación**, actualizado tras revisar el estado local en
`dcadbc3` y las herramientas incorporadas por ese commit. En esta revisión solo
se modifica este plan; no se implementan los seis cambios ni se ejecutan pruebas,
cargas, migraciones o despliegues. Las referencias al comportamiento proceden
de lectura del código, no de verificaciones en ejecución.

Estado local comprobado: `.github/workflows/ci.yml` tiene cinco líneas añadidas
de comentarios y este plan está sin seguimiento. **`ci.yml` queda expresamente fuera
de cualquier commit** y conserva sus cinco comentarios locales (no se propone un
commit separado para él); el plan sí forma parte de la entrega.
El éxito de CI y el código desplegado comunicados por el usuario no se han
consultado de nuevo en los servicios remotos. La carga inicial y la organización
de sus herramientas están completadas y fuera del alcance de este trabajo.

**Revisión del 2 de noviembre de 2026.** El plan incorpora tres definiciones
confirmadas por el usuario, tratadas como cambios 7, 8 y 9 (§1, etapas 8 a 10,
§4 y §5): correo de club opcional; nombre de usuario opcional al registrar,
editable bajo «Credenciales de acceso» hasta crear las credenciales; y retiro
de «Pendiente de verificar» de la personalidad jurídica, convirtiendo antes esos
registros a «No tiene». **Nada de esto está implementado.** Las referencias al
código actual proceden de lectura, sin ejecutar pruebas, consultas ni
migraciones; no se consultó producción.

**Decisiones del usuario incorporadas el 2 de noviembre (segunda revisión):**
P3, P4, P5, P6, P14 y P15 dejan de ser preguntas. Quedan recogidas en §1
(cambios 1, 3, 4 y 9), en las etapas 4, 5, 6 y 10, en §3, en §4 y en §5. Donde
una decisión no cubre un detalle, el plan lo marca como **«Propuesta, no
confirmada»** y lo lista en §5 («Propuestas por confirmar»). **Nada de esto
está implementado.**

**Ajuste de la tercera revisión (3 de noviembre): eliminar la carga NO es un
requisito para continuar ni para desplegar.** Es una opción independiente,
pendiente de autorización de ejecución y de delimitación; las etapas se
desarrollan y se despliegan **con o sin** ella, y lo ya implementado se
aprovecha tal cual. Ver «Camino mínimo» y «Eliminación de la carga: opción
independiente».

**Tercera revisión del 2 de noviembre: los datos de la carga inicial son
prescindibles** (definición confirmada por el usuario: no se necesitan, pueden
eliminarse y no hace falta preservarlos ni recuperarlos para completar estos
cambios). El plan se simplifica en consecuencia: ver «Simplificación por datos
prescindibles» al final de §2 antes de las etapas. **Solo se planifica: no se
ejecuta ninguna eliminación, no se tocan las migraciones ya revisadas y no se
actuó sobre producción.** Las secciones antiguas que quedan reducidas llevan una
nota «Simplificado» que remite a ese apartado; el texto original se conserva
debajo como historia.

Estado de la etapa 1 en esta revisión: el cambio 5 está **implementado en el
árbol local, sin commit ni despliegue** (`RelayWorkspacePage.tsx` y
`RelayWorkspacePage.test.tsx` modificados), aprobado con condiciones y
verificado con pruebas de jsdom y con arrastre real en navegador contra una API
simulada con datos sintéticos.

---

## 0. Contraste documentación ↔ implementación

`CLAUDE.md` solo fija el uso de `graphify` (se usó; el grafo existe y está
disponible en `graphify-out/`). Lo que sigue es el contraste de `README.md` y
`docs/internas/13_Resumen_Final.md` con el código. Se listan **solo las
discrepancias que afectan a este plan**.

| # | Discrepancia | Afecta a |
|---|---|---|
| D1 | `README.md:644` publica «`PUT /competitions/:id` — Editar (fechas de inscripción **solo en `draft`/`scheduled`**)». El código lo permite en cualquier estado y lo dice explícitamente: `backend/src/modules/competitions/competitions.service.ts:227-233` («antes se bloqueaba fuera de 'draft'/'scheduled'»). | Cambios 3, 4 y 6, que editan esa misma competencia/endpoint |
| D2 | `README.md:658` afirma que las categorías habilitadas deben ser «un **subconjunto** de las ya asociadas a esa prueba en el catálogo general (Módulo 5)». El código dice que esa relación **se eliminó** y que solo exige el mismo tipo de prueba: `competition-events.service.ts:20-45`. | Cambio 4, que edita la misma tarjeta de prueba |
| D3 | El README **no documenta en ninguna parte** los cupos de nadadores (`Competition.maxSwimmers`, `maxSwimmersPerClub`) ni el estado `individual_closed`, pese a que `/competitions/:id/capacity` y `/competitions/:id/reopenRegistrations` sí aparecen en el inventario exhaustivo (`README.md:1087`, `:1094`) y **faltan** en la tabla del Módulo 6 (`README.md:641-651`). Búsqueda de «cupo», «individual_closed», «maxSwimmersPerClub» en el README: cero resultados. | Cambio 4: el límite nuevo es «otro cupo por club» y el existente no está descrito |
| D4 | El README no documenta la invariante de relevos («todo integrante necesita una inscripción individual confirmada en la competencia», `relay-membership.rules.ts`) ni `Competition.maxRelayEventsPerSwimmerPerSession`. `README.md:705` sigue atribuyendo el límite de relevos **solo** a `SessionLimit.maxRelayEvents`, cuando hoy el límite efectivo es el menor de los dos (`relay-registrations.rules.ts:24-35`). | Cambio 3, que consiste exactamente en volver configurable esa invariante |
| D5 | **Contradicción visible al usuario, no solo documental.** `frontend/src/modules/persons/PersonsBulkImportPage.tsx:66` publica una columna «J — Roles» como **obligatoria**, y `:72-76` explica cómo usarla. El backend **rechaza la fila** si la columna J trae algo (`persons-bulk-import.rules.ts:103-108`) y la plantilla descargable ya no la incluye (`persons-bulk-import.service.ts:50-88`, 9 columnas A–I). | Cambio 1 de lleno |
| D6 | `README.md:855` publicaba el permiso de la exportación HY3 como `export:team-manager` **(solo `admin`)**; hoy lo publica con el rol `club` y el personal de club (ver «Definición actualizada» del Cambio 2). `backend/tests/documentacion.test.ts:395-444` compara el permiso publicado de cada ruta sensible con el del código: si el cambio 2 amplía el permiso y no se corrige esa fila, **la prueba de documentación falla**. | Cambio 2 |
| D7 | `docs/internas/13_Resumen_Final.md:55,57,90` publica «30 modelos» y «116 endpoints», y `documentacion.test.ts:289-325` las compara con el esquema y las rutas reales. Este plan **no agrega modelos ni endpoints** (solo columnas), así que las cifras no cambian — pero si alguna etapa agregara una ruta, hay que actualizar las tres apariciones **y** el inventario de `README.md:980-1190`. | Todas |
| D8 | Defecto encontrado de paso, **fuera de lo pedido**, en un archivo que el cambio 6 toca: `competitions.schemas.ts:80` no admite `individual_closed` en el filtro de estado, y el desplegable de la lista lo ofrece (`CompetitionsListPage.tsx:207` recorre `STATUS_LABELS`, que sí lo incluye en `:12`). Elegir «Inscripciones individuales cerradas» devuelve 400. Además `AUTO_MUTABLE_STATUSES` (`competitions.service.ts:86`) no incluye `individual_closed`, que sí avanza solo a `closed` (`competitions.rules.ts:63-65`). Lo reporto; no lo corrijo salvo que se pida. | Cambio 6 (mismo archivo) |

Comentario de código obsoleto detectado de paso:
`competitions.service.ts:230-232` afirma que «si estaba 'closed' y se extiende la
fecha de cierre a futuro, vuelve a 'open' automáticamente»; lo contradicen
`:276-285` y `recomputeStatusAfterEdit` (`competitions.rules.ts:140-158`), que
dejan la reapertura como acción explícita.

---

## 1. Hallazgos del funcionamiento actual y archivos afectados

### Cambio 1 — Carga masiva de personas

**Hoy.** La carga masiva **crea personas y nada más**. La plantilla
(`persons-bulk-import.service.ts:50`) trae dos hojas: `Personas` (solo el
encabezado) e `Instrucciones` (el ejemplo, deliberadamente fuera del alcance del
importador). Las 9 columnas A–I están en `persons-bulk-import.rules.ts:32-42`:
RUN, nombre de usuario, nombre, apellido paterno, apellido materno, fecha de
nacimiento, género, correo, teléfono. `importPersonsFromExcel:115` lee 10 celdas
y rechaza la fila si la J trae algo. El informe es **por fila** y el
comportamiento es parcial entre filas a propósito (`:104-114`).

Incorporar a un club es un paso **aparte**: `bulkAssignSwimmers`
(`assignment.service.ts:299`), expuesto en `POST /swimmer-assignments/bulk-assign`
con permiso `swimmer-assignment:approve`.

**Referencia reutilizable disponible en el repositorio:**

- `assignment.service.ts:305-314` — el comentario que registra «una tanda de
  5.071 asignaciones que tardó tres minutos» y el defecto de resolver la fecha
  dentro del bucle; de ahí salió el parámetro `fechaEfectiva`, que se resuelve
  **una vez por tanda**.
- Las migraciones `20261031000000_fecha_efectiva_membresia` y
  `20261031000100_personalidad_juridica_pendiente`, con
  `tests/fecha-efectiva-membresia.integration.test.ts` y
  `tests/migracion-fecha-efectiva.integration.test.ts`.

El commit `dcadbc3` incorpora además `backend/scripts/carga-masiva/`, sus pruebas
sintéticas y `docs/operacion/`. La guía `carga-masiva-inicial.md`, apartado
«Columnas que leen los guiones», y el generador de planillas sintéticas muestran
el contrato: Personas tiene los nueve campos A–I; Asignaciones relaciona RUN y
usuario de la persona con sigla y nombre del club. En esa operación la fecha
efectiva era común y se configuraba externamente; **para la carga por Excel de
la aplicación la decisión del usuario es otra (P3): una fecha por fila.** El
cargador relaciona la sigla con
el usuario del club usando la planilla de clubes; no demuestra que toda sigla
sea única en la base de datos.

Esto permite proponer la nueva plantilla sin abrir planillas reales. La nueva
plantilla web debe integrar la identificación del club y una columna con la
fecha efectiva de membresía de cada fila (P3); no necesita copiar campos auxiliares como fila de origen o nombre completo
duplicado. Las planillas reales, decisiones e informes permanecen privados.
No se modifica ni se vuelve a ejecutar el cargador completado.

**Obstáculos concretos, independientes de esa información:**

1. *(Resuelto en la etapa 6: `clubs_code_unique_active`.)* **La sigla (`clubs.code`) es el identificador único decidido (P2), pero hoy
   el sistema no lo garantiza.** Decisión del usuario: la sigla identifica al
   club en la carga Excel y **no** se sustituye por `clubs.username`. Lo que se
   observó en el código, sin ejecutar nada: `code` es `TEXT NOT NULL`
   (`20260827161331_add_username_club_code_age_cutoff/migration.sql:18`); en las
   migraciones no aparece ningún índice único sobre él (el único de `clubs` es
   `clubs_username_unique_active`, `20260905000000_phase2_integrity/migration.sql:78`);
   y `clubs.service.ts` normaliza la sigla a mayúsculas al crear y editar
   (`:275`, `:383`) pero las comprobaciones de duplicado que se encontraron son de
   RUT (`:21-27`) y de nombre de usuario. **La unicidad es, por ahora, una
   convención de los datos, no una garantía técnica.** La Etapa 6 la comprueba
   antes de apoyarse en ella (ver allí); si hay discrepancias se informa y se
   propone, sin corregir datos de forma automática. El `rut` es opcional (y nulo
   en los 156 clubes cargados, que quedaron con personalidad jurídica pendiente);
   `clubs.name` tampoco es único.
2. **Cruza una frontera de permisos.** La ruta de carga masiva exige
   `persons:write` (`persons.routes.ts:106,114`); crear una membresía exige
   `swimmer-assignment:approve`. Hoy el administrador tiene los dos; si la carga
   crea membresías sin exigir el segundo permiso, se abre una vía para asignar
   plantel con un permiso que no lo autoriza.
3. **Atomicidad por fila.** `createPerson` y `assignSwimmerDirectly` abren cada
   uno su propia transacción (`assignment.service.ts:197-224`). Dos escrituras
   por fila sin una transacción común pueden dejar la persona creada y sin club,
   con el informe diciendo «error» sobre alguien que sí quedó en la base. Existe
   el patrón `{ tx }` de `shared/transaction.ts:20-30` para resolverlo.
4. **RB-06 es una invariante.** Un nadador tiene como máximo una membresía
   activa: comprobación en `assignSwimmerDirectly:188-194` **más** el índice
   único parcial `club_swimmers_unique_active_person` (`schema.prisma:388-400`).
   Una fila cuyo club choque con una membresía activa previa debe rechazarse con
   ese mensaje, sin reemplazo silencioso.

**Archivos afectados:** `backend/src/modules/persons/persons-bulk-import.rules.ts`,
`…/persons-bulk-import.service.ts`, `…/persons.routes.ts`,
`backend/src/modules/swimmer-assignment/assignment.service.ts` (si se reutiliza
dentro de una transacción), `frontend/src/modules/persons/PersonsBulkImportPage.tsx`,
`frontend/src/modules/persons/personsApi.ts`,
`backend/tests/persons-bulk-import.rules.test.ts`,
`backend/tests/persons-bulk-import.integration.test.ts`, `README.md:937-942`.

### Cambio 2 — Exportación Team Manager para delegado / entrenador / representante legal

> **Actualización local posterior (sin commit ni despliegue).** La descarga pasa a ser
> un ZIP con un `.CL2` y un `.HY3`, por `GET /export/team-manager/zip`; `/hy3` queda
> como alias del mismo ZIP. Las referencias a un `.HY3` suelto de este cambio son
> históricas. Ver el Módulo 11 del README. Permisos y alcance no cambian. La
> importación real en HY-Tek está pendiente.

> **Definición actualizada (4 de noviembre de 2026).** La exportación «Exportar a
> Team Manager (.HY3)» de Reportes está disponible para **delegado, entrenador,
> representante legal y rol `club`**; el administrador conserva su acceso. Esta
> definición **sustituye** la exclusión anterior del rol `club` (P9 y los textos de
> este cambio que lo mencionan como excluido son históricos). Cada actor no
> administrador exporta solo su propio club (403 con otro `clubId`); un nadador sin
> otro rol habilitante no recibe el permiso. Implementación: `"export:team-manager"`
> añadido a `ROLES.club` en `rbac.definitions.ts`; el alcance (servicio y ruta) y el
> botón (`hasPermission`) no necesitaron cambios. **Tras el despliegue hay que
> ejecutar `node dist-seed/prisma/seed.js`** con la imagen de mantenimiento
> construida desde el mismo commit, después de las migraciones y antes de la API y
> la web (no `seed-admin`; `npm run prisma:seed` es solo desarrollo local), como ya estaba previsto: agrega la fila de
> `role_permissions` del rol `club` (el seed agrega y no quita).

**Hoy.** El permiso `export:team-manager` existe en el catálogo
(`rbac.definitions.ts:27`) y está **solo en `admin`** (`:48-49`);
`CLUB_STAFF_PERMISSIONS` (`:37-46`) no lo tiene, y los tres roles comparten
exactamente ese arreglo (`:61-63`), invariante fijada en
`tests/rbac.definitions.test.ts:17-23`.

**El hallazgo central.** La ruta `GET /export/team-manager/hy3`
(`team-manager-export.routes.ts:14`) **pasa el `clubId` de la query directo al
servicio**, y `buildTeamManagerHy3Export` (`team-manager-export.service.ts:43,74`)
**no comprueba ningún alcance**: nunca lo necesitó, porque solo el administrador
podía llamarla. Conceder el permiso sin más dejaría a cualquier delegado
descargar las inscripciones de **cualquier club** —con RUN y fecha de
nacimiento— cambiando el `clubId`. El alcance es, por tanto, parte obligatoria
de este cambio, no un añadido.

El patrón a copiar ya existe: `resolveClubFilter` / `assertClubAccess` /
`requireClubForWrite` en `shared/actorContext.ts:81-126`, usados por
`reports.routes.ts:15,28` vía `buildActorContext`.

**A favor:** el club del personal ya se resuelve en el token.
`authorization.ts:52-62` deriva el `clubId` de un delegado/entrenador/
representante legal desde `club_staff` y **rechaza** a quien figure en más de un
club (`:63-65`). En la pantalla, `ReportsPage.tsx:26` ya calcula `isClubScoped` y
`:67-73` fija su club como texto (no desplegable), dejando `clubId` listo. El
botón está gateado por `hasRole("admin")` en `:170-174`. El frontend ya expone
`hasPermission` (`AuthContext.tsx:42`).

**Dos mensajes que un club empezará a ver** y conviene revisar que le hablen a
él: la competencia sin piscina asignada (`team-manager-export.service.ts:65-71`,
exige acción del administrador) y los relevos con un número de integrantes
distinto de 4 (`:286-299`).

**Archivos afectados:** `backend/src/modules/auth/rbac.definitions.ts`,
`backend/src/modules/team-manager-export/team-manager-export.routes.ts` y
`…/team-manager-export.service.ts`, `frontend/src/modules/reports/ReportsPage.tsx`,
`backend/tests/rbac.definitions.test.ts`,
`backend/tests/permisos-operaciones-nuevas.integration.test.ts`,
`backend/tests/listados-alcance.integration.test.ts`, `README.md:855` y la tabla
de permisos que compara `documentacion.test.ts`.

### Cambio 3 — Condición para inscribir relevos

**Hallazgo principal: la condición ya existe, y como invariante incondicional.**
`backend/src/modules/relay-registrations/relay-membership.rules.ts` la implementa
completa, con sus **dos lados**:

- al formar o modificar el equipo, todos sus integrantes deben tener una
  inscripción individual confirmada en la **misma competencia**
  (`evaluarElegibilidadDeIntegrantes:54`, usada en
  `relay-registrations.service.ts:275-279`);
- al cancelar una inscripción individual, si era la **última** confirmada de
  alguien que integra un relevo confirmado, la cancelación se **rechaza**
  (`evaluarCancelacionDeIndividual:96`, usada en
  `registrations.service.ts:780-787`).

El encabezado del archivo (`:1-30`) argumenta por qué tiene que ser una
invariante y no una validación de alta, que **también aplica al administrador**,
y que el sistema **nunca lo arregla solo** (no cancela ni retira a nadie). Ese
comentario es, de hecho, la especificación de la regla.

Por lo tanto **este cambio no agrega una regla: vuelve opcional una invariante
existente**. Eso tiene dos consecuencias, ya decididas por el usuario: la
casilla nace **marcada** y las competencias existentes conservan la regla (P4),
y al encenderla sobre equipos ya formados que no la cumplen se muestra cuántos
son y el administrador puede guardar, sin que el sistema modifique nada (P5).

Lo que el enunciado pide considerar —«qué ocurre si después se elimina su última
inscripción individual»— **ya está resuelto** y con mensaje redactado
(`relay-membership.rules.ts:104-111`). Lo que falta es que ese segundo lado lea
el mismo interruptor, desde la misma competencia; si no, la regla queda rota de
forma asimétrica.

**Archivos afectados:** `backend/prisma/schema.prisma` (modelo `Competition`) +
una migración, `competitions.schemas.ts` (alta, edición y duplicado),
`competitions.service.ts` (idem), `relay-membership.rules.ts`,
`relay-registrations.service.ts`, `registrations.service.ts` (cancelación),
`frontend/src/modules/competitions/CompetitionsListPage.tsx` (alta),
`…/CompetitionDetailPage.tsx` (edición y resumen), `…/competitionsApi.ts`,
`frontend/src/modules/relay-registrations/RelayWorkspacePage.tsx:454-459` y
`:467-470` (los dos textos **afirman** la regla),
`backend/tests/relay-membership.rules.test.ts`,
`backend/tests/integration-registration-flow.integration.test.ts`,
`README.md:700-707`.

### Cambio 4 — Máximo de nadadores por club en una prueba individual

**Hoy existe un límite por club, pero de competencia completa**, no por prueba:
`Competition.maxSwimmersPerClub` (`schema.prisma:663`), con reglas puras en
`competition-capacity.rules.ts` y lectura del uso en
`competition-capacity.service.ts`. Su unidad de conteo es el **nadador distinto**:
alguien con seis individuales y dos relevos ocupa **un** cupo
(`competition-capacity.rules.ts:1-20`). **No hay nada por `CompetitionEvent`.**

**Interpretación (lo que el enunciado pidió señalar).** El límite nuevo se
entiende **por prueba de competencia** (`competition_events`), no por prueba
maestra del catálogo (`events`) ni por jornada, y solo en pruebas individuales.
Dentro de una prueba individual, «nadadores del club» equivale a **contar las
inscripciones confirmadas** de ese club en esa prueba, porque RB-09 ya impide dos
confirmadas del mismo nadador en la misma prueba (`schema.prisma:807-810`). Es un
límite **independiente** del `maxSwimmersPerClub` de la competencia: uno acota
cuántos nadadores distintos aporta un club a la competencia, el otro cuántos
puede poner en una prueba concreta. Pueden estar los dos, y el efectivo es el que
se alcance primero.

**Inscripciones simultáneas: el patrón ya está resuelto en este proyecto.**
`registrations.service.ts:416-432` explica el hallazgo 9 (contar y luego crear no
es atómico) y `:433-577` hace el conteo **y** la inserción dentro de
`prisma.$transaction(..., { isolationLevel: "Serializable" })`; el conflicto de
serialización lo traduce `withTranslatedPrismaErrors` a un 409 reintentable.
Ningún índice único puede expresar esta regla, porque es agregada. **La
comprobación nueva tiene que ir dentro de esa misma transacción**, nunca antes.

Dos sitios que arrastran el campo nuevo: `duplicateCompetition`
(`competitions.service.ts:660-672`) copia las pruebas y hay que copiar la columna;
y `meet-import` crea `competition_events`, que heredarían el valor por omisión
(`NULL` = sin límite), lo cual es correcto.

**Archivos afectados:** `schema.prisma` (`CompetitionEvent`) + migración,
`competitions.schemas.ts:127-141`, `competition-events.service.ts:85,163`,
una regla pura nueva junto a `competition-capacity.rules.ts`,
`registrations.service.ts`, `competitions.service.ts` (duplicado),
`CompetitionDetailPage.tsx` (`CompetitionEventsBoard`, `:541-780`),
`competitionsApi.ts`, `backend/tests/competition-capacity.rules.test.ts`,
`backend/tests/competition-capacity.integration.test.ts`, `README.md:641-651`.

### Cambio 5 — Nadadores disponibles en relevos

**Hoy.** `RelayWorkspacePage.tsx:264-269` calcula `filteredSwimmers` filtrando
por el género de la prueba activa y por la búsqueda; **no** excluye a quien ya
está en un puesto. En su lugar los marca: fondo distinto y un `✓`
(`:489`, `:495`).

Datos que determinan el diseño correcto:

- `slots` es estado **local y no guardado**: nada se persiste hasta «Confirmar
  equipo» (`handleSaveTeam:366-393`). Así que «soltar correctamente» equivale a
  que `placeInSlot` haya colocado al nadador.
- `placeInSlot:309-317` ya lo quita de cualquier otro puesto, de modo que no
  puede aparecer dos veces.
- Vuelve a estar disponible por cuatro vías ya existentes: `clearSlot:327`,
  `swapSlots:319`, `resetBuilder:271` (que invocan Escape `:143`,
  `selectEvent:277-280` y el cambio de competencia/club `:244-249`) y
  `loadTeamForEdit:293-307` al cargar otro equipo.
- **Operación fallida:** si `api.create`/`api.update` rechaza, `handleSaveTeam`
  muestra un aviso y **conserva `slots`** (`:388-390`). Como el filtro se
  calculará sobre `slots`, el nadador sigue en su puesto y sigue oculto de la
  izquierda, que es coherente: está colocado. Lo que **no** se puede hacer es
  ocultar en función de los **equipos confirmados**, porque entonces un guardado
  fallido ocultaría a alguien que no está en ningún equipo.
- **Alcance del filtro:** solo los puestos del armador abierto. Ocultar a quien
  ya integra un equipo confirmado de la competencia impediría participaciones
  legítimas: `maxRelayEventsPerSwimmerPerSession` vale 1 por omisión pero es
  configurable (`schema.prisma:647`), el tope es por fecha+jornada y
  `SessionLimit.maxRelayEvents` puede restringir más; la comprobación
  autoritativa es por integrante en `relay-registrations.rules.ts:117-123`. La
  interfaz no debe adelantarse a ella.
- El pintado de los puestos busca en `swimmers` (la lista completa, `:581`), no
  en `filteredSwimmers`, así que filtrar la columna izquierda es seguro.

**Archivos afectados:** solo
`frontend/src/modules/relay-registrations/RelayWorkspacePage.tsx` y sus pruebas
(`RelayWorkspacePage.test.tsx`, `RelayWorkspacePage.cierre.test.tsx`). Sin
backend y sin datos.

### Cambio 6 — Visibilidad de competencias

**Hoy ya hay un precedente de visibilidad por rol**, y conviene reutilizar su
forma: `listCompetitions(query, hideDraftAndScheduled)`
(`competitions.service.ts:88`) y `getCompetitionById(id, hideIfDraftOrScheduled)`
(`:151`), conectados en `competitions.routes.ts:37-48` con `!isAdmin`. El segundo
lanza **`NotFoundError`**, «para no revelar siquiera que la competencia existe».

**Quién consume el filtro de competencias** (`competitionsApi.list`):

| Pantalla | Archivo | Filtro actual | ¿En el enunciado? |
|---|---|---|---|
| Panel de Inscripción | `RegistrationWorkspacePage.tsx:303` | sin filtro | **sí** |
| Panel de Relevos | `RelayWorkspacePage.tsx:155` | sin filtro | **sí** |
| Reportes | `ReportsPage.tsx:46` | sin filtro | no — **no se modifica (P8)** |
| Asistente de inscripción | `RegistrationWizardPage.tsx:58` | `status: "open"` | no — **no se modifica (P8)** |
| Asistente de relevos | `RelayRegistrationWizardPage.tsx:48` | `status: "open"` | no — **no se modifica (P8)** |
| Lista de administración | `CompetitionsListPage.tsx:59` | por estado | — |

La tabla de administración está en `CompetitionsListPage.tsx:214-245` y hoy tiene
cuatro columnas (Competencia / Período de inscripción / Estado / acciones), con
`SortableTh` + `sortItems`.

**Trampa de implementación:** `listCompetitions` arma
`where.NOT = { status: "draft" }` (`:95`). Añadir un segundo `NOT` por asignación
lo pisaría. Y cuando `hideDraftAndScheduled` está activo, pagina **en memoria**
(`:108`, `:135-141`). Un booleano guardado no es auto-mutable, así que se puede
filtrar en la base y **no** fuerza ese camino — siempre que se agregue como clave
propia del `where`.

**¿Ocultar afecta solo la visibilidad o también el acceso directo?** (lo que el
enunciado pidió señalar). El estado actual, según lectura del código:

- Ocultar borradores a un no administrador **sí** bloquea `GET /competitions/:id`
  (`NotFoundError`, `competitions.service.ts:151-160`).
- **No** bloquea las rutas con las que realmente se inscribe:
  `GET /competitions/:id/enabled-events` (`registrations.routes.ts:20-23`) no
  recibe contexto de actor en absoluto; `/registrations/available-events`,
  `/registrations/club-eligibility-matrix`, `POST /registrations` y
  `POST /relay-registrations` nunca preguntan si la competencia es visible.
- Lo único que frena inscribirse en un borrador es el **estado**:
  `evaluateRegistrationWindow` (`competitions.rules.ts:332-347`) solo admite
  `open`, `individual_closed` y `closed`.

**Decisión del usuario (P7 y P8): ocultar es solo visibilidad.** El cambio 6
quita la competencia **únicamente de los desplegables del Panel de Inscripción y
del Panel de Relevos**. No restringe accesos directos ni inscripciones: una
competencia oculta pero abierta sigue siendo consultable (`GET /competitions/:id`)
e inscribible por los medios que hoy existen, y así debe quedar escrito en la
ayuda del campo, para que nadie lo tome por una medida de protección. Tampoco se
extiende a Reportes ni a los asistentes de alta, que conservan su listado actual.
En consecuencia **no se toca** `registrations.service.ts`,
`relay-registrations.service.ts` ni las rutas de inscripción.

**Archivos afectados:** `schema.prisma` + migración, `competitions.schemas.ts`,
`competitions.service.ts`, `competitions.routes.ts`,
`CompetitionsListPage.tsx`, `CompetitionDetailPage.tsx`,
`RegistrationWorkspacePage.tsx`, `RelayWorkspacePage.tsx`, `competitionsApi.ts`,
`backend/tests/competition-integrity.integration.test.ts`,
`backend/tests/migration-upgrade.integration.test.ts`,
`frontend/src/modules/competitions/CompetitionsListPage.test.tsx`,
`README.md:641-651`.

### La diferencia de sentido entre el checkbox y la columna

El enunciado pide un checkbox para **ocultar**, desmarcado por omisión, y una
columna titulada exactamente **«Mostrar en competencia»**. Son sentidos opuestos.
Propuesta, que conserva el comportamiento pedido:

- **Guardar un solo campo, en sentido positivo:**
  `visibleInRegistrationPanels Boolean @default(true)`. «Checkbox de ocultar
  desmarcado por omisión» y «campo visible en `true` por omisión» son lo mismo, y
  así la columna muestra el valor guardado tal cual, sin negarlo.
- **No** guardar `hidden Boolean @default(false)`: obligaría a escribir `!hidden`
  en cada punto de lectura, que es la fábrica clásica de errores de doble
  negación. El propio esquema ya trae una advertencia sobre esa trampa
  (`schema.prisma:313-317`).
- **En los formularios**, la casilla se rotula como pide el enunciado —«Ocultar
  esta competencia del panel de inscripción y del panel de relevos»,
  desmarcada— y se enlaza a la negación del campo guardado.
- **En la tabla de administración**, última columna con el título exacto
  «Mostrar en competencia» y valor `Sí` / `No` como insignia (`badge-active` /
  `badge-disabled`), igual que el resto de la tabla.
- Como «Mostrar en competencia» es, literalmente, ambiguo (¿mostrar qué?), se
  conserva el título exacto y se añade un `title` emergente con la frase
  completa: «Aparece en el filtro del Panel de Inscripción y del Panel de
  Relevos». Así el encabezado es el pedido y el significado queda escrito.

### Cambio 7 — Correo electrónico del club opcional

**Hoy el correo del club es obligatorio en las cuatro capas:**

- base de datos: `clubs.email` es `String` no anulable (`schema.prisma:322`);
- API: `email: z.string().email(...)` obligatorio al crear
  (`clubs.schemas.ts:28`); en la edición es opcional (`:140`), pero **no se
  puede vaciar**: el servicio hace `email: input.email ?? undefined`
  (`clubs.service.ts:387`), así que omitirlo deja el anterior y `""` falla el
  formato;
- interfaz: el campo lleva `required` (`ClubFormPage.tsx:250-251`) y el tipo es
  `email: string` (`clubsApi.ts:23`, `:48`);
- la única consumidora del dato es la propia ficha del club: no aparece en
  reportes, exportaciones ni autenticación (búsqueda de `email` en
  `backend/src`: solo `clubs.schemas.ts` y `clubs.service.ts`).

El patrón ya existe en Personas, donde el correo es opcional: `""` se convierte
en «sin correo» al crear (`persons.schemas.ts:28`) y en `null` al editar
(`:55`). No hay índice único sobre el correo de clubes, así que no hay conflicto
de unicidad que resolver.

**Importación.** La aplicación **no tiene importación de clubes**: los 156
clubes entraron por el guion completado (`backend/scripts/carga-masiva/cargar.mjs`,
columnas en `:588-590`), que enviaba el correo de la planilla y lo concilia en
`:345`. Ese guion no se modifica ni se vuelve a ejecutar. Si algún día se
planifica una importación de clubes, la columna de correo será opcional y vacía
significará `NULL`, nunca un correo provisional.

**Archivos afectados:** `schema.prisma` + migración, `clubs.schemas.ts`,
`clubs.service.ts`, `ClubFormPage.tsx`, `clubsApi.ts`,
`backend/tests/clubs.schemas.test.ts`, una prueba de integración de clubes,
`README.md:464-477`.

### Cambio 8 — Nombre de usuario opcional y credenciales de acceso

**Hoy el nombre de usuario es obligatorio al registrar e inmutable desde el
alta.** Lo comprobado por lectura:

- **Esquema:** `persons.username` y `clubs.username` son `TEXT NOT NULL`
  (`20260827161331_add_username_club_code_age_cutoff/migration.sql:19,25`), con
  unicidad parcial entre vigentes `persons_username_unique_active` y
  `clubs_username_unique_active` (`20260905000000_phase2_integrity/migration.sql:75,78`).
  `users.username` también es `NOT NULL`.
- **Reserva global entre tablas** (`username_reservations`, clave primaria
  `username`), mantenida solo por disparadores
  (`20260906010000_phase4_user_identity/migration.sql:80-188`, `:243-253`).
  `username_registry_reserve` **inserta el nombre como clave primaria**: con un
  `NULL` el disparador fallaría. Hoy no ocurre porque la columna es `NOT NULL`;
  al volverla anulable, esa función **debe** cambiar en la misma migración.
- **La base ya bloquea el nombre una vez hay cuenta**, que es exactamente lo que
  pide el requisito en el servidor:
  `users_username_igual_al_titular` exige que una cuenta vigente tenga el mismo
  nombre que su persona o club (`20260906020000_phase4_identity_guards/migration.sql:224-272`),
  y `titular_forbid_rename_con_cuenta` prohíbe renombrar a un titular con
  cuenta vigente, cualquiera sea su estado —activa, bloqueada o inhabilitada—
  (`:296-328`). Corolario útil: **la base ya impide crear una cuenta para un
  titular sin nombre**, porque `NULL` es distinto de cualquier nombre de cuenta.
- **API:** `usernameField` (`shared/username.schema.ts:12-17`: recorta
  espacios, 4–30 caracteres, `[a-zA-Z0-9._-]`) es obligatorio en el alta de
  personas (`persons.schemas.ts:22`) y de clubes (`clubs.schemas.ts:130`); las
  dos ediciones lo excluyen a propósito (`persons.schemas.ts:61-63`,
  `clubs.schemas.ts:143`). La disponibilidad se comprueba en las tres tablas a
  la vez (`shared/username.ts:53-92`).
- **Crear credenciales** no recibe datos: `createCredentialsSchema` es
  `z.object({}).optional()` (`persons.schemas.ts:94`). La de personas toma
  `person.username` dentro de una transacción serializable
  (`persons.service.ts:389-541`); la de clubes toma `club.username`, pero lee el
  club **fuera** de la transacción en que crea la cuenta
  (`clubs.service.ts:468-498`).
- **Restablecer la contraseña** (`persons.service.ts:543-566`,
  `clubs.service.ts:500-520`) cambia hash, `mustChangePassword`, estado e
  intentos fallidos, y revoca las sesiones. **No toca el nombre.**
- **Separación registro/cuenta: ya existe.** `createPerson` y `createClub` no
  crean cuentas; la cuenta nace solo con «Crear credenciales». Lo que no está
  separado es el nombre: hoy se exige al registrar.
- **Interfaz:** el campo está en la parte superior del formulario, con
  `required` y `disabled={isEdit}` (`PersonFormPage.tsx:216-229`,
  `ClubFormPage.tsx:177-204`, con el texto «no se puede modificar una vez
  creado»). La sección **«Credenciales de acceso»** —ya con ese título exacto—
  solo aparece al editar y queda **fuera** del `<form>`
  (`PersonFormPage.tsx:332-363`, `ClubFormPage.tsx:313-336`).
- **Carga masiva de personas:** la columna B es obligatoria
  (`persons-bulk-import.rules.ts:23`, `:33-34`, `:116`) y así lo dicen la
  plantilla (`persons-bulk-import.service.ts:84`) y la pantalla
  (`PersonsBulkImportPage.tsx:58`, `:70`). Una celda vacía hoy rechaza la fila.
- **Otros que suponen un nombre siempre presente:** el preflight
  (`scripts/migrationChecks.ts:98-116`) agrupa por `username` y contaría a
  todos los titulares sin nombre como **un duplicado**; las comprobaciones
  `username-colision-global` y `reservas-de-username-incoherentes`
  (`:255-330`) los verían como titulares **sin reserva**. Los mensajes de
  `prismaErrors.ts:58-64` no cambian. El inicio de sesión busca en `users`
  (`auth.service.ts:117`), donde el nombre sigue siendo obligatorio.
- **Errores de los disparadores:** `translatePrismaError`
  (`prismaErrors.ts:108-202`) solo traduce códigos `P…` de Prisma; no
  reconozco una traducción específica para las excepciones que lanzan los
  disparadores. Por eso el mensaje al usuario debe salir de la comprobación del
  servicio **dentro** de la transacción, y la prueba de concurrencia debe
  confirmar qué recibe el usuario cuando gana la base.

**Dependencias del nombre de usuario en las herramientas de carga (no se
modifican).** El cargador completado **concilia clubes y personas por nombre de
usuario** (`cargar.mjs:689-738` y `:815-816`) y traduce sigla → nombre de
usuario del club usando la planilla (`:817-819`). Funcionó porque la planilla
traía nombres para todos. Con nombres opcionales ese método no sirve para cargas
futuras. Consecuencia para la etapa 6: **la persona se identifica por RUN
normalizado y el club por sigla (P2)**, sin depender del nombre de usuario. Las
herramientas completadas quedan como registro histórico.

**Lo que cambia para los datos existentes.** Ningún nombre guardado se borra ni
se convierte. Las cuentas existentes ya tienen el nombre de su titular
(garantía 2 de `phase4_identity_guards`), así que esos titulares quedan
bloqueados como hoy. Los titulares **sin** cuenta —incluidas, presumiblemente,
muchas de las personas y clubes cargados el 1 de noviembre; la cantidad no se
consultó— pasan a tener el nombre **editable**, que hoy no lo es.

**Archivos afectados:** `schema.prisma` + migración (columnas, función de
reserva y restricciones), `shared/username.schema.ts`, `persons.schemas.ts`,
`persons.service.ts`, `persons.routes.ts` (cuerpo de credenciales),
`clubs.schemas.ts`, `clubs.service.ts`, `clubs.routes.ts`,
`persons-bulk-import.rules.ts`, `persons-bulk-import.service.ts`,
`scripts/migrationChecks.ts`, `PersonFormPage.tsx`, `ClubFormPage.tsx`,
`personsApi.ts`, `clubsApi.ts`, `PersonsBulkImportPage.tsx`; pruebas
`username-identity.integration.test.ts`,
`preflight-username-collision.integration.test.ts`,
`phase4-guard-validations.integration.test.ts`,
`persons-bulk-import.rules.test.ts`, `persons-bulk-import.integration.test.ts`,
`migration-upgrade.integration.test.ts`, `PersonFormPage.admin.test.tsx` y una
prueba nueva de `ClubFormPage`; `README.md:412-477`.

### Cambio 9 — Retirar «Pendiente de verificar» de la personalidad jurídica

**Hoy hay tres estados, introducidos el 31 de octubre** por
`20261031000100_personalidad_juridica_pendiente`: `has_legal_status` anulable y
sin valor por omisión, donde `NULL` es «pendiente» (`schema.prisma:307-318`).
Esa migración no convirtió ninguna fila y explica por qué: convertir en masa
«sustituiría un dato afirmado por una suposición» (`migration.sql:23-27`).
**El requisito nuevo hace justamente lo contrario, por decisión del usuario:**
convierte un dato desconocido en la afirmación «No tiene». Se documenta como tal
en P13.

Dónde vive el tercer estado:

- API: `hasLegalStatus: z.boolean().nullable()` obligatorio
  (`clubs.schemas.ts:15-25`); el RUT es opcional con `null`
  (`refineRut`, `:43-81`); el mensaje propio del representante legal con
  `null` (`:96-109`); el filtro `personalidadJuridica: si|no|pendiente`
  (`:153-160`, resuelto en `clubs.service.ts:196-200`).
- Servicio: `assertRepresentanteLegalPermitido` (`clubs.service.ts:40-47`);
  el RUT se **conserva** con `null` y se **descarta** con `false`
  (`:236`, `:323-330`); el bloqueo por representante designado (`:346-353`).
- Interfaz: tres radios y un club nuevo que nace «pendiente»
  (`ClubFormPage.tsx:32-34`, `:206-230`, `:265-267`); etiqueta, color y filtro
  de la lista (`ClubsListPage.tsx:14-18`, `:106`, `:159-165`); tipos y filtro
  (`clubsApi.ts:6`, `:19-20`, `:44-45`).
- Herramientas completadas: el cargador envía y **exige** `hasLegalStatus: null`
  (`cargar.mjs:641-673`) y compara contra `null` al conciliar (`:347`); las
  consultas de verificación cuentan los pendientes
  (`consultas-verificacion.mjs:119`); la guía `docs/operacion/carga-masiva-inicial.md`
  §2.2 lo explica. **No se modifican**, pero tras este cambio el cargador ya no
  sería aceptado por la API, y repetir sus verificaciones daría diferencias en
  ese campo. Son registro histórico; no se vuelven a ejecutar.

**Dos efectos de la conversión, medidos antes de ejecutarla:**

1. **RUT guardado de un club pendiente — decisión P14: se elimina.** Con
   «pendiente» se admite guardar el RUT (`clubs.schemas.ts:52-55`), y la
   siguiente edición de un club «No tiene» lo borraría en silencio
   (`clubs.service.ts:323-325`). El usuario decidió que la conversión **elimine
   también el RUT de esos clubes**, de modo que la pérdida deja de ser diferida
   y silenciosa y pasa a ser explícita, trazada y hecha en la misma
   transacción (ver etapa 10). Alcance estricto: **solo** el RUT, **solo** de
   los clubes que estaban pendientes. No se toca el RUT de clubes en otro
   estado ni la razón social ni ningún otro campo. Según el plan de la carga, los 156
   clubes cargados quedaron pendientes y sin RUT; cualquier club creado o
   editado después no está medido, y el recuento previo lo mide sin mostrar
   valores.
2. **Representante legal en un club pendiente.** Las reglas impiden designarlo
   sin `true`, pero ninguna restricción de base lo garantiza (solo el índice de
   uno por club, `phase4_identity_guards:336-338`). Un caso así, si existiera,
   quedaría como club «No tiene» con representante, y el propio servicio
   impediría después guardar ese club (`:346-353`).

**Efecto sobre las reglas del representante legal.** Ninguno en la práctica:
hoy un club pendiente **no puede** designar representante, y uno «No tiene»
tampoco. La conversión no toca `club_staff`, `person_roles` ni `user_roles`, así
que **no cambia ningún nombramiento ni permiso**; los clubes con «Tiene» no se
tocan y conservan a sus representantes. Lo único que desaparece es la rama de
mensajes para `null`. Pasar después de «No tiene» a «Tiene» sigue siendo una
decisión explícita, y solo entonces se puede designar.

**Archivos afectados:** `schema.prisma` + migración, `clubs.schemas.ts`,
`clubs.service.ts`, `scripts/migrationChecks.ts`, `ClubFormPage.tsx`,
`ClubsListPage.tsx`, `clubsApi.ts`; pruebas `clubs.schemas.test.ts`,
`clubs-personalidad-juridica.test.ts`,
`personalidad-juridica-transiciones.integration.test.ts`,
`legal-representative.integration.test.ts`,
`migration-upgrade.integration.test.ts` y las que crean clubes con
`hasLegalStatus: null` (búsqueda: también `permisos-operaciones-nuevas`,
`fecha-efectiva-membresia`, `migracion-fecha-efectiva` y otras integraciones);
`README.md:468`, `:481-502`, `:517-523`.

---

## 2. Plan por etapas

El orden va de menor a mayor riesgo y, dentro de eso, de lo independiente a lo
que depende de información externa. Cada etapa se puede desplegar y verificar
sola. Los números de etapa se conservan para no cambiar referencias ya
aprobadas («etapa 1», «etapa 2»); las etapas 8 a 10 son las nuevas.

**Orden de trabajo propuesto (revisión del 2 de noviembre):**

| Paso | Etapa | Cambio | Por qué en ese lugar |
|---|---|---|---|
| — | 1 | 5 | Implementada en local; falta commit y despliegue cuando se pidan |
| 1 | 2 | 2 | Sin datos ni migración; su diseño no depende de los requisitos nuevos |
| 2 | 8 | 7 | Correo opcional: la migración más simple del bloque de clubes |
| 3 | 9 | 8 | Nombre de usuario opcional; la etapa 6 depende de ella |
| 4 | 10 (10a y 10b juntas) | 9 | *Simplificado:* 10a ya está hecha; 10b es una migración de una línea y se despliega con ella (ver «Simplificación por datos prescindibles») |
| 5–7 | 3, 4, 5 | 6, 4, 3 | Competencias; independientes del bloque de clubes |
| 8 | 6 | 1 | Carga con club; después de la etapa 9 |
| — | 7 | — | Documentación anterior, opcional; decidir antes de la etapa 4 |

Las etapas 8, 9 y 10 van seguidas porque tocan los mismos archivos
(`clubs.schemas.ts`, `clubs.service.ts`, `ClubFormPage.tsx`, `clubsApi.ts`);
intercalarlas con otras multiplica los conflictos. Las de competencias (3, 4 y
5) pueden ir antes o después de ese bloque según la prioridad del usuario: no
comparten archivos ni datos con él. La comprobación previa de la etapa 10 es de
solo lectura sobre una copia restaurada y puede adelantarse cuando se autorice,
para conocer las cantidades antes de pedir la ventana.

### Simplificación por datos prescindibles (tercera revisión del 2 de noviembre)

**Definición confirmada del usuario.** Los datos de la carga inicial (156 clubes,
5.071 personas, 5.071 membresías y su auditoría) **no se necesitan y pueden
eliminarse**. No hace falta preservarlos ni recuperarlos para completar los
cambios. **Límites de esta revisión:** solo planifica; no ejecuta eliminaciones,
no toca las migraciones ya revisadas, no añade infraestructura ni mecanismos de
mantenimiento sin necesidad demostrada, y **no supone un reinicio total**: la
cuenta administradora, la configuración, los catálogos y todo dato ajeno a la
carga se conservan.

**Por qué simplifica tanto.** Casi todo el aparato de las etapas 8 a 10 existía
para **no perder ni dejar inservibles** esos registros: respaldos restaurados,
recuentos con sumas de verificación, ventana de mantenimiento, vigilancia,
ensayos de «el código antiguo lee un `NULL`». Los cambios de estructura y las
funciones nuevas **no dependen** de esos datos.

#### Actividades retiradas (su único propósito era conservar o recuperar la carga)

| # | Actividad retirada | Dónde estaba | Qué la sustituye |
|---|---|---|---|
| R1 | **Respaldo «descargado y restaurado» antes de cada migración** | Reglas comunes (§2), etapa 10 punto 1, «Procedimiento» paso 2 y 4 | Nada. Se sigue la rutina de respaldo que ya existe, sin añadir pasos para conservar ni recuperar los datos cargados |
| R2 | **Comprobación previa de cantidades** de la etapa 10 sobre una copia restaurada: clubes por estado, `NULL` con RUT o razón social, RUT de los no convertidos, lista de identificadores `true`, nombramientos en `person_roles`/`user_roles` | Etapa 10 punto 1 | Dos conteos de solo lectura, ver «Camino mínimo» paso 3 |
| R3 | **Verificación posterior de 10a** con sumas de verificación de RUT y razón social, comparación de nombramientos y una auditoría por club | Etapa 10 punto 5 | Las pruebas funcionales sintéticas de la migración (ya hechas) |
| R4 | **Protección del RUT retirado** (el respaldo como única fuente del valor anterior) | Etapa 10 punto 2, P14 | Nada: la decisión P14 (se elimina el RUT al convertir) sigue valiendo para cualquier club `NULL` que quedara, pero ya no se protege su valor |
| R5 | **Ensayos de conservación:** lectura del código antiguo con un `NULL` (la «tabla de evidencia»), escritura del código antiguo tras 8, 9, 10a y 10b, y «una base anterior conserva los correos / nombres y reservas» | «Ensayos en entornos aislados» y §4 «Etapas 8, 9 y 10 — transición» | Se omiten (ver la separación de pruebas más abajo) |
| R6 | **La ceremonia de la ventana:** variantes A y B, el «requisito futuro» de acceso de mantenimiento, el respaldo final de la ventana, el plazo de vigilancia, los criterios de apertura y los criterios para 10b | «Compatibilidad entre versiones y despliegue coordinado» | Despliegue manual ordenado, ver el paso 5 del camino mínimo. **No se construye ningún modo de mantenimiento** |
| R7 | **Reversión por restauración** («la vía general es el respaldo final de la ventana») | Etapa 10 punto 6 y «Reversión: lo que sí y lo que no» | No hay datos que restaurar. Si un despliegue sale mal: corregir hacia adelante o, mientras no exista ningún `NULL` creado, volver al código anterior |
| R8 | **Comprobar las siglas de clubes sobre un respaldo restaurado** (etapa 6) | Etapa 6, tarea sobre `clubs.code` | La misma consulta de solo lectura, sobre la base **después** de la eliminación |

**Las herramientas de la carga** (`backend/scripts/carga-masiva/`, sus pruebas y
`docs/operacion/`) ya eran «registro histórico, no se modifican ni se vuelven a
ejecutar». Siguen igual: retirarlas del repositorio sería trabajo nuevo sin
ganancia. Quedan obsoletas tras las etapas 9 y 10 y su eventual retirada es una
decisión aparte, fuera de este plan.

#### Actividades que siguen siendo necesarias

- **Todos los cambios de estructura**: las migraciones de las etapas 3, 8, 9 y 10a
  (hechas), y las de las etapas 4, 5 y 6 y 10b, también hechas. Ninguna se modifica
  por este motivo.
- **Las pruebas funcionales de cada función nueva** (lista más abajo).
- **Las salvaguardas que protegen a los datos que SÍ se conservan** y cuestan
  poco: 10a aborta con detalle si un club `NULL` tiene representante legal (no
  toca nombramientos); el `CHECK` de cadenas vacías; la reserva de nombres que
  ignora `NULL`.
- **Las comprobaciones del preflight ya escritas** para las etapas 8 a 10: están
  implementadas y verificadas; **no se rehacen ni se quitan**, pero dejan de ser
  requisito de una ventana.
- **Rechazo de cuerpos antiguos con 400, nunca 500** (`hasLegalStatus: null`,
  filtro `pendiente`): es contrato de la API nueva y ya está implementado, no un
  ensayo de conservación.
- **El orden `migración → API → web`**, que no cuesta nada.
- **Etapa 6:** la identificación por RUN y sigla (P2) y la unicidad de la sigla
  siguen siendo necesarias para la función, con o sin los datos.
- **No se deshace lo implementado:** las etapas 1, 2, 3, 8, 9, 10a, las fases
  adicionales A y B y la corrección de visibilidad se conservan tal cual. Rehacer
  10a para fundirla con 10b costaría más que dejarla.

#### 10a / 10b: ¿siguen haciendo falta por separado?

La separación se justificó por dos razones: (1) una **ventana de reversión del
código** mientras la columna siguiera admitiendo `NULL`, pensada para poder
volver atrás **sin perder** los 156 clubes ya convertidos; y (2) la
incompatibilidad del código antiguo con `NOT NULL`.

- **Razón 1: cae.** Sin datos que preservar, volver atrás no exige conservar nada;
  si hiciera falta, deshacer `SET NOT NULL` es una sentencia
  (`ALTER TABLE "clubs" ALTER COLUMN "has_legal_status" DROP NOT NULL;`) que se
  deja anotada, sin mecanismo ni ventana.
- **Razón 2: queda reducida a un detalle de despliegue.** La API y la web se
  despliegan a mano, una tras otra; entre un paso y otro hay minutos, y el
  efecto es un error al guardar un club desde una pestaña vieja. No justifica un
  plazo de vigilancia ni criterios de apertura.
- **Propuesta:** **mantener dos archivos de migración** (10a está hecha y revisada;
  no se edita) **pero desplegarlas en el mismo paso**. 10b pasa a ser una
  migración de una línea (`SET NOT NULL`, con su comprobación de «si queda un
  `NULL`, falla con detalle») y Prisma pasa a `Boolean` en el mismo cambio. Se
  elimina el plazo de vigilancia entre ambas. **Cuánto esfuerzo se ahorra:**
  toda la gestión de la ventana (R6); lo único que se escribe es 10b.
- **Sin eliminar la carga** (el caso por omisión), 10a convierte tal como está
  implementada los clubes pendientes que existan, y no hace falta ningún paso
  extra. Si la carga se eliminara antes, convertiría cero y sería una
  no-operación; en ambos casos sirve de guarda para cualquier club `NULL`
  creado después.

#### Camino mínimo propuesto

**La eliminación de la carga ya no forma parte de la secuencia obligatoria.** El
desarrollo y el despliegue no esperan a ninguna decisión sobre ella.

1. **Terminar lo pendiente con datos sintéticos**, sin operaciones de producción:
   solo la etapa 7, si se decide (las etapas 4, 5, 6 y la migración 10b están
   implementadas, ver su estado). Con las pruebas de la lista funcional (abajo); sin
   los ensayos de conservación.
2. **Un solo despliegue, en el orden de siempre:** `migrate deploy` (todas las
   migraciones pendientes, 10a y 10b incluidas) → `fchmn-api` → `fchmn-web`, a
   mano, con Auto-Deploy en `Off` como hoy. **Sin variantes A/B, sin modo de
   mantenimiento, sin vigilancia.** Se aprovecha lo ya implementado tal cual: 10a
   convierte los clubes pendientes que haya (con la carga presente, los 156) sin
   pasos previos de conservación.
3. **Un conteo de solo lectura antes y otro después** (sustituye a R2 y R3):
   clubes con `has_legal_status IS NULL` (esperado: después, 0) y, de ellos,
   cuántos tienen representante legal (esperado 0; si no, 10a se detiene sola con
   el detalle).
4. **Comprobación mínima de humo** (lecturas y una escritura propia del
   administrador, sin crear registros de prueba que se queden): iniciar sesión
   con la cuenta administradora, listar clubes y personas, abrir una competencia,
   comprobar que «Ocultar» quita la opción del panel, y que guardar un club con
   `hasLegalStatus: null` responde 400 (no 500).
5. **Opcional e independiente: eliminar la carga** (ver el apartado siguiente).
   Puede hacerse antes, después o nunca; **no condiciona** los pasos 1 a 4. Y, si
   se quisiera recargar personas y clubes, por la carga con club y fecha por fila
   de la etapa 6 una vez desplegada: **el cargador antiguo no sirve** tras las
   etapas 9 y 10 (concilia por nombre de usuario y exige `hasLegalStatus: null`).

**Qué cambia respecto al plan anterior:** desaparecen el respaldo restaurado por
migración, el recuento con sumas de verificación, la ventana con sus variantes,
la vigilancia y la espera entre 10a y 10b. No se añade ninguna actividad para
conservar o recuperar los datos cargados.

#### Eliminación de la carga: opción independiente (planificación, sin ejecutar)

**Estado:** opción **pendiente de autorización de ejecución y de delimitación**.
No es un paso del camino mínimo, no bloquea el desarrollo ni el despliegue y este
plan no la ejecuta. Lo que sigue es solo la delimitación, por si se elige hacerla.
Si se eligiera, antes de actuar bastaría una copia previa **normal** de la rutina
existente (no el respaldo restaurado de la versión anterior del plan), porque un
error de delimitación podría tocar datos ajenos a la carga.

**Qué creó la carga** (por lectura del cargador y de los servicios; las cifras
son las de la memoria del proyecto y se **confirman con conteos** antes de actuar):

| Registro | Cantidad esperada | Cómo se creó | Notas |
|---|---|---|---|
| `clubs` | 156 | `POST /clubs`, uno por club | Con personalidad jurídica pendiente y sin RUT |
| `persons` | 5.071 | `POST /persons/bulk-import` | Sin cuenta de acceso |
| `club_swimmers` (membresías) | 5.071, todas activas, inicio `2026-10-30` | `POST /swimmer-assignments/bulk-assign` | |
| `username_reservations` | una por cada nombre de usuario de club o persona | Disparadores `*_username_registry` | Se liberan **solos** al borrar el titular (`AFTER … OR DELETE`) |
| `audit_logs` | las filas de las tres etapas | Servicios | Sin clave foránea hacia los titulares. Pueden contener copias de datos personales: **decidir** si se eliminan (ver «Decisiones») |

**Qué NO es de la carga y se conserva:** la cuenta administradora y sus roles y
permisos sembrados; catálogos (tipos de prueba, distancias, estilos, categorías,
tipos de jornada, piscinas); competencias y su estructura; la configuración; la
auditoría ajena a la carga; `_prisma_migrations`.

**Cómo se delimita** (lecturas, sin escribir): primero los conteos exactos
(clubes, personas, membresías) y que **coincidan** con 156 / 5.071 / 5.071; luego,
que los clubes y las personas candidatos queden definidos por su procedencia
(creados por la cuenta administradora en la ventana de la carga, y las
membresías con inicio `2026-10-30`), **no por una lista de identificadores
guardada en el repositorio**. Si algún conteo difiere, hay datos posteriores a
la carga: **se detiene y se informa**, no se elimina.

**Dependencias que pueden bloquear o ampliar la eliminación** (por el esquema):

| Dependiente | Efecto al borrar el titular | Qué hacer |
|---|---|---|
| `registrations` (`person_id`, `club_id`) | **RESTRICT**: bloquea | Contar las que referencian titulares de la carga. Si existen, son datos posteriores y dependientes: **decisión del usuario** (eliminarlas también o conservar a esos titulares) |
| `relay_registrations` (`club_id`) y `relay_registration_members` (`person_id`) | **RESTRICT**: bloquea | Igual que la anterior |
| `club_swimmers` (`club_id`, `person_id`) | **RESTRICT**: bloquea | Se eliminan primero (son la carga) |
| `club_staff`, `person_roles` | **CASCADE**: se van solos | Contarlos antes para saber qué se lleva |
| `users` (`person_id`, `club_id`) | **SET NULL**: no bloquea, pero deja cuentas huérfanas | Debe haber **0** cuentas de persona o club (la carga tuvo una sola cuenta, la administradora); si hubiera, no se tocan sin decisión |
| `clubs.delegate_person_id`, `clubs.coach_person_id` | **SET NULL** | Sin efecto |

**Orden propuesto, en una sola transacción:** inscripciones de relevo y sus
integrantes → inscripciones individuales (solo si se decidió) → membresías →
personas → clubes → (auditoría, si se decidió) → conteos posteriores: cero de la
carga, y **sin cambio** en usuarios administradores, catálogos y competencias.
**Eliminación lógica descartada:** el campo `deleted_at` existe y libera RUN y
nombres (los índices únicos son parciales), pero **no hay baja de clubes por la
API** y dar de baja 5.071 personas de una en una (`DELETE /persons/:id`) no es
razonable; además dejaría los datos personales en la base, que es lo que se
quiere evitar. Es un **procedimiento único, revisado y ejecutado por quien
autorice**, no una función, ni una ruta, ni una migración.

**Decisiones que quedan para el usuario, y solo si se elige eliminar** (no las
resuelve este plan y **no bloquean el desarrollo ni el despliegue**):

- **D-1.** ¿Se eliminan también las filas de `audit_logs` de la carga? (Recomendado
  si contienen copias de datos personales; requiere verificarlo por lectura.)
- **D-2.** Si hubiera inscripciones posteriores a la carga que dependan de
  titulares cargados: ¿se eliminan con ellos o se conservan esos titulares?
- **D-3.** ¿Basta **una copia previa normal** antes de eliminar (propuesta), o se
  prefiere algo más para ese único paso?

#### Pruebas: funcionales necesarias frente a ensayos de conservación omitibles

| Funcionales (se mantienen) | Ensayos de conservación (se pueden omitir) |
|---|---|
| Esquemas y reglas de cada función nueva (cambios 1 a 9) | «Una base anterior conserva los correos / nombres / reservas» (`migration-upgrade`, etapas 8 y 9) |
| Integración de las funciones: correo opcional, nombre opcional y credenciales, personalidad jurídica de dos estados, visibilidad, límite por prueba, condición de relevos, carga con club | Lectura y escritura del **código antiguo** con `NULL` o con `NOT NULL` (tabla de evidencia) |
| Cada migración aplicada sobre una base sintética: columna, valor por omisión, restricciones, que 10a convierte solo los `NULL` y aborta si hay representante legal | Conteos con suma de verificación de RUT, razón social y nombramientos antes y después |
| `SET NOT NULL` de 10b rechaza un `NULL` con detalle | Restauración de un respaldo para ensayar |
| La API nueva rechaza con 400 los cuerpos antiguos incompatibles | Ensayo de la ventana completa y de la reversión |
| Frontend: formularios, columnas, selectores | Verificación del RUT eliminado «sin imprimir valores» |
| `documentacion.test.ts` (D6, D7), tipos y lint | |

**Qué NO se omite de las pruebas de migración** aunque parezca de conservación:
el caso «10a aborta con detalle y sin dejar nada a medias si un club `NULL` tiene
representante legal» y «solo cambian los `NULL`», porque protegen datos que sí se
conservan.

**Limitaciones de esta simplificación.** (1) Las cifras de la carga proceden de
la memoria del proyecto y de la lectura del código; no se consultó producción.
(2) Que `audit_logs` contenga datos personales y que no existan inscripciones
posteriores que dependan de la carga **no están comprobados**: son los conteos
de la delimitación, solo si se elige eliminar. (3) El riesgo residual de las etapas 8 y 9 —que el código antiguo no
lea una fila con `NULL`— **sigue existiendo** para registros nuevos y lo cubre el
despliegue seguido (migración → API → web); no se ensaya. (4) Esta revisión no
cambia ninguna decisión de producto (P1 a P15).

### Etapa 1 — Cambio 5 (solo interfaz)

Primera por ser la única sin datos ni servidor. **Estado:** implementada en el
árbol local, sin commit ni despliegue; ver la cabecera del documento.

- **Datos:** ninguno. **Servidor:** ninguno.
- **Interfaz** (`RelayWorkspacePage.tsx`):
  - en `filteredSwimmers` (`:264`), excluir a quien esté en `slots`;
  - retirar el `✓` y el fondo de «ya colocado» (`:489`, `:495`), que quedan sin
    caso posible — dejarlos sería dejar ramas muertas;
  - añadir un texto para la columna vacía («No quedan nadadores disponibles para
    esta prueba»), porque con planteles chicos y 4 puestos llenos la columna
    puede quedarse sin nada y parecer un error;
  - el contador «Nadadores: N» (`:441`) cuenta el plantel completo: se deja como
    está (alcance mínimo), pero conviene saber que ya no coincide con lo que se
    ve en la columna.

### Etapa 2 — Cambio 2 (permisos, alcance y botón)

- **Datos:** ninguno.
- **Servidor:**
  1. agregar `"export:team-manager"` a `CLUB_STAFF_PERMISSIONS`
     (`rbac.definitions.ts:37`). Al compartir el arreglo, cubre de una vez a
     delegado, entrenador y representante legal, y la invariante de
     `rbac.definitions.test.ts:17-23` los mantiene idénticos;
  2. **alcance, indispensable:** la ruta pasa a construir `buildActorContext(req)`
     y a resolver el club con `assertClubAccess` / `requireClubForWrite`
     (`shared/actorContext.ts:81-126`). Recomendación: mover la comprobación
     **al servicio**, haciendo que `buildTeamManagerHy3Export` reciba
     `ActorContext` en vez de `{ userId, ipAddress }`, igual que
     `reports.service`, para que cualquier llamador futuro quede cubierto. El
     alcance `swimmer` ya queda rechazado por `assertClubAccess`;
  3. **tras las migraciones y antes de la API y la web hay que ejecutar
     `node dist-seed/prisma/seed.js`** con la imagen de mantenimiento construida
     desde el mismo commit (en local, `npm run prisma:seed`; nunca `seed-admin`): el seed lee la
     matriz desde `rbac.definitions.ts` (`prisma/seed.ts:4,24-37`) y agrega la
     fila que falta en `role_permissions` con `upsert`. Una migración no lo hace.
     Nota: el seed **agrega pero no quita** (`update: {}`, sin `deleteMany`), así
     que retirar un permiso más adelante exigiría trabajo manual.
- **Interfaz** (`ReportsPage.tsx`): cambiar la condición del botón (`:170`) de
  `hasRole("admin")` a `hasPermission("export:team-manager")`
  (`AuthContext.tsx:42`). Para un usuario acotado a su club no hace falta nada
  más: `:67-73` ya fija su club y `clubId`. La nota «seleccione también un club»
  (`:177-181`) sigue siendo solo del administrador. Se conserva la guarda de
  `handleTeamManagerExport:116-119`.
- **Documentación:** `README.md:855` (la celda dice «solo `admin`») y la tabla de
  permisos detallada, o falla `documentacion.test.ts`.

### Etapa 3 — Cambio 6 (visibilidad)

> **Estado (2 de noviembre de 2026): IMPLEMENTADA en el árbol local, sin commit ni
> despliegue.** Cumple lo descrito abajo con estas precisiones de la implementación:
> el filtro es el parámetro de consulta **`visibleInRegistrationPanels`**, que acepta
> exactamente `true` o `false` (otro texto responde 400; `"false"` no se vuelve
> verdadero); omitido no filtra, `true` deja solo las visibles y `false` solo las
> ocultas; se agrega al `where` como clave propia, así que se suma a `NOT`/`status`
> y a la paginación en memoria, y `findMany` y `count` parten de la misma condición.
> Migración nueva `20261102030000_competencia_visible_en_paneles` (aditiva, sin
> tocar las ya revisadas). El detalle, las altas y las inscripciones **no se
> modificaron**; Reportes y los dos asistentes no envían el parámetro. La columna
> «Mostrar en competencia» es la última de la tabla (después de la de acciones) y el
> `colSpan` de la fila vacía pasó a 5. Pruebas: `competitions-visibilidad.schemas.test.ts`,
> `competitions-visibilidad.integration.test.ts`,
> `migracion-visibilidad-competencias.integration.test.ts` y, en el frontend,
> `CompetitionsListPage.visibilidad.test.tsx`,
> `CompetitionDetailPage.visibilidad.test.tsx` y `visibilidadEnConsumidores.test.tsx`.
>
> **Corrección posterior (2 de noviembre): guardar ya no mueve las fechas de
> inscripción.** `CompetitionDetailPage.tsx` cargaba las dos fechas recortadas a
> `AAAA-MM-DDTHH:mm` (sin zona ni segundos) y las reenviaba en cada guardado, de
> modo que marcar la casilla —u otro campo cualquiera— reinterpretaba el texto en
> la zona del servidor y desplazaba los instantes (defecto anterior a la etapa 3).
> Ahora el payload **omite las fechas que no se modificaron**, comparándolas con
> el estado inicial del formulario; editar una fecha a propósito funciona igual.
> No se tocó la política horaria ni se refactorizaron las fechas. Regresiones con
> apertura y cierre junto al cambio de día (marcar, guardar, recargar y desmarcar
> conserva ambos instantes al milisegundo) en
> `CompetitionDetailPage.visibilidad.test.tsx`, y la prueba de
> `CompetitionDetailPage.reapertura.test.tsx` que fijaba el reenvío incondicional
> se actualizó a este contrato.
>
> **Pendiente separado (3 de noviembre de 2026): REPRODUCIDO Y CORREGIDO.**
> `listCompetitions` «sanaba» en paralelo (`Promise.all`) el estado de cada
> competencia cuya ventana cambió, y cada una abre su propia transacción (cambio +
> auditoría). *Antecedente:* se registró como «agotamiento del pool» tras un 503
> (`P2028`) visto con varias competencias a la vez. *Lo comprobado ahora:* con tres
> competencias por sanar el listado ya fallaba, y con una sola conexión abierta bastan
> dos transacciones simultáneas; lo medido fue que, en la base de ensayo, **abrir una
> conexión nueva con Prisma tardó ≈2 s** (frente a 8-74 ms con el cliente `pg`),
> es decir, justo el plazo de arranque de una transacción (`maxWait`, 2 s). N
> transacciones simultáneas exigen N conexiones, las que no estaban ya abiertas
> hay que abrirlas en ese momento, y el listado entero falla. No es entonces solo
> «el pool se llena»: es *iniciar todas a la vez*. *Hipótesis, no comprobada:*
> el origen de esos ≈2 s por conexión nueva (resolución de `localhost` u otra
> particularidad del entorno de ensayo); no se investigó ni se tocó la
> configuración. *Corrección:* el bucle pasa a **secuencial** (`for … await`), de modo
> que todas reutilizan la misma conexión; sin aumentar conexiones ni plazos. Sin
> cambios en las reglas de apertura y cierre, su auditoría transaccional, el orden,
> los filtros, los totales, la paginación ni las restricciones por rol y
> visibilidad. *Prueba:* `competitions-autoestado-secuencial.integration.test.ts`
> mide, con un middleware que retiene 40 ms cada transacción de sanación, cuántas
> hay en curso a la vez: pico 1 exigido; con la versión anterior el pico fue 2 y
> las 8 pruebas del archivo fallaron (P2028). Las pruebas de la etapa 3, que
> evitan el problema sembrando las competencias ya abiertas, no se modificaron.

- **Datos:** migración aditiva
  `ALTER TABLE "competitions" ADD COLUMN "visible_in_registration_panels" BOOLEAN NOT NULL DEFAULT true;`
  y el campo en Prisma con el comentario que explique el sentido positivo. El
  `DEFAULT true` es lo que deja visibles todas las competencias existentes, como
  pide el enunciado.
- **Servidor:**
  - `competitions.schemas.ts`: el campo, opcional, en alta y edición; en el
    duplicado se **hereda** del origen (como los cupos, `competitions.service.ts:621-626`);
  - `listCompetitions` (`:88`): parámetro nuevo que agregue
    `where.visibleInRegistrationPanels = true` **como clave propia**, sin tocar
    `where.NOT` (`:95`);
  - `competitions.routes.ts:37`: el mismo endpoint sirve la tabla del
    administrador **y** el filtro de los paneles, y el administrador también usa
    los paneles — así que **no** se puede decidir por rol, o la función no
    serviría justamente a quien la pide. Recomendación: un parámetro de consulta
    explícito que envíen los dos paneles;
  - acceso directo y altas: **sin cambios** (P7). El parámetro solo afecta a los
    listados que lo envían; el detalle y las inscripciones siguen como hoy.
- **Interfaz:**
  - `CompetitionsListPage.tsx`: columna final «Mostrar en competencia» con
    `Sí`/`No`; actualizar el `colSpan` de la fila vacía de 4 a 5 (`:241`);
  - casilla «Ocultar…» en el formulario de alta (`:123-197`) y en el de edición
    (`CompetitionDetailPage.tsx:298-376`), más una línea de solo lectura en el
    resumen (`:255-296`);
  - `RegistrationWorkspacePage.tsx:303` y `RelayWorkspacePage.tsx:155` envían el
    parámetro nuevo.
- **Documentación:** tabla del Módulo 6 (`README.md:641-651`) y una nota de
  semántica que diga exactamente qué significa ocultar: solo quita la competencia
  de los desplegables de los dos paneles; no restringe accesos ni inscripciones
  (P7), y no alcanza a Reportes ni a los asistentes (P8).

### Etapa 4 — Cambio 4 (límite por prueba)

> **Estado (3 de noviembre de 2026): IMPLEMENTADA en el árbol local, sin commit ni
> despliegue.** Cumple lo descrito abajo con estas precisiones: migración nueva
> `20261103000000_limite_nadadores_por_club_y_prueba` (columna anulable sin valor
> por omisión **y** un `CHECK` de entero positivo; no edita ninguna migración
> revisada); campo `maxSwimmersPerClub` en el alta y la edición de la prueba
> (`null` quita, omitido no toca; `0`, negativos, decimales y texto → 400; un
> relevo con valor → 400 con mensaje); **regla pura** `evaluateEventClubLimit` junto
> a `competition-capacity.rules.ts`; conteo, comprobación y alta **dentro de la
> transacción serializable** de `createRegistration`, con el máximo leído dentro de
> ella; **unidad de conteo:** inscripciones confirmadas del club en esa prueba;
> excepción **solo si `actor.isAdmin`** (no el permiso posterior al cierre), con la
> acción de auditoría `REGISTRATION_CREATED_OVER_EVENT_CLUB_LIMIT_BY_ADMIN` en la
> misma transacción (autor, club, competencia, prueba, máximo y cantidad
> resultante); duplicar hereda; las pruebas nuevas e importadas nacen sin límite.
> Interfaz: campo «Máximo de nadadores por club» (placeholder «Sin límite») en el
> alta por arrastre y en la edición, solo en pruebas individuales, y el valor
> vigente en la tarjeta. Pruebas: `event-club-limit.rules.test.ts`,
> `event-club-limit.integration.test.ts` y, en el frontend,
> `CompetitionDetailPage.limitePorClub.test.tsx`. Sin tabla nueva, sin ruta nueva
> (las cifras publicadas no cambian).

- **Datos:**
  `ALTER TABLE "competition_events" ADD COLUMN "max_swimmers_per_club" INTEGER;`
  — anulable y **sin** valor por omisión, de modo que todo lo existente queda en
  «Sin límite».
- **Servidor:**
  - `competitions.schemas.ts:127-141`: campo `optional().nullable()` en el alta y
    la edición de una prueba de competencia (`nullable` para poder **quitar** el
    límite, igual que los cupos en `:33-34` y `:58-62`);
  - `competition-events.service.ts:85,163`: persistirlo, y **rechazar con mensaje**
    el campo cuando la prueba sea de relevo (`shared/testType.util.ts` tiene con
    qué distinguirlo). Rechazar y no ignorar en silencio es lo coherente con cómo
    el proyecto trata los campos que no aplican (ver `roles` en
    `persons.schemas.ts:30-45`);
  - **regla pura nueva** junto a `competition-capacity.rules.ts`, que reciba el
    límite, lo ya inscrito del club en esa prueba y lo entrante, y devuelva el
    motivo con cuántos sitios quedan — mismo estilo que
    `evaluateCapacity:135-168`, para poder probar los bordes sin base de datos;
  - `registrations.service.ts`: la comprobación **dentro** de la transacción
    serializable existente (`:433-577`), junto a la de cupos (`:494`), con
    `tx.registration.count({ where: { competitionEventId, clubId, status: "confirmed" } })`.
    Eso es lo que cubre las inscripciones simultáneas;
  - reducir el límite por debajo de lo ya inscrito **no borra nada**: solo impide
    altas nuevas, igual que los cupos (`competitions.service.ts:268-275`). Hay
    que decirlo en la ayuda del campo;
  - **excepción administrativa (P6, decidida):** solo un **administrador**
    puede exceder el límite por prueba. Poseer `registrations:write` no basta,
    ni tampoco `registrations:write:post-close` sin ser administrador: la
    condición es `actor.isAdmin`. El patrón de los cupos
    (`competition-capacity.rules.ts:124-133`) se decide con el permiso
    `canRegisterPostClose`, así que la regla nueva **no** lo copia tal cual: la
    regla pura recibe un indicador de «administrador» y no el permiso. Cuando se
    excede, se registra una fila de auditoría con **autor, club, competencia,
    prueba de competencia, límite vigente y cantidad resultante** (conteo del
    club en esa prueba tras la alta), con una acción propia (propuesta de
    nombre: `REGISTRATION_CREATED_EVENT_LIMIT_EXCEPTION`, igual de explícita que
    la acción de cierre `REGISTRATION_CREATED_POST_CLOSE_EXCEPTION`); un
    no administrador recibe el rechazo normal con el tope y los sitios
    restantes;
  - `duplicateCompetition` (`:660-672`): copiar la columna.
- **Interfaz** (`CompetitionDetailPage.tsx`, `CompetitionEventsBoard`):
  - campo numérico con `placeholder="Sin límite"` en el mini-formulario de alta
    por arrastre (`pendingAdd`, `:573-576`, `:704-740`) y en la edición inline
    (`:579-582`, `:741-762`), **visible solo en pruebas individuales**;
  - mostrar el valor vigente en la tarjeta de la prueba, junto al número y al
    recuento de equipos;
  - tipos en `competitionsApi.ts`.
- **Documentación:** `README.md:641-651` y una nota que **distinga** este límite
  del cupo por club de la competencia. Aquí se nota D3: ese cupo no está
  documentado en ninguna parte.

### Etapa 5 — Cambio 3 (condición de relevos)

> **Estado (3 de noviembre de 2026): IMPLEMENTADA en el árbol local, sin commit ni
> despliegue.** Cumple lo descrito abajo con estas precisiones: migración nueva
> `20261103010000_condicion_individual_para_relevos` (`DEFAULT true`, aditiva);
> campo `requireIndividualForRelay` (alta, edición, detalle, tipos y duplicado
> hereda; booleano estricto); `relay-membership.rules.ts` con el **interruptor
> como parámetro obligatorio** de `evaluarElegibilidadDeIntegrantes` y
> `evaluarCancelacionDeIndividual` (apagado → permitido) y el comentario de
> cabecera reescrito («invariante configurable»); el valor se lee de la **misma
> competencia dentro de cada transacción** —en `validateAndResolveRelayTeam`
> (alta y modificación de integrantes) y en `cancelRegistration`—; solo el texto
> del cierre parcial deja de afirmar la individual previa si la condición está
> apagada. **Aviso (P5):** `contarEquiposIncumplidores` (regla pura) y
> `contarEquiposDeRelevoIncumplidores` (lectura, sin escribir) cuentan **equipos
> distintos**; `GET /competitions/:id` y la respuesta del `PUT` devuelven
> `relayTeamsNotMeetingCondition` —sin ruta nueva, las cifras publicadas no
> cambian—, el formulario avisa al marcar la casilla sin impedir guardar, y el
> detalle lo muestra. Pruebas: `relay-membership.rules.test.ts`,
> `relay-condition.integration.test.ts` y, en el frontend,
> `CompetitionDetailPage.condicionRelevos.test.tsx`, el alta en
> `CompetitionsListPage.visibilidad.test.tsx` y el aviso en
> `RelayWorkspacePage.cierre.test.tsx`.

- **Datos:**
  `ALTER TABLE "competitions" ADD COLUMN "require_individual_for_relay" BOOLEAN NOT NULL DEFAULT true;`
  (P4, decidida: la casilla comienza **marcada** al crear una competencia y
  `DEFAULT true` deja **todas las existentes** con la regla actual).
- **Servidor:**
  - `relay-membership.rules.ts`: las dos funciones reciben el interruptor y
    devuelven «permitido» sin más cuando está apagado. **Hay que reescribir el
    comentario de cabecera** (`:1-30`): hoy afirma que la regla es una invariante
    incondicional que también alcanza al administrador, y pasa a ser «invariante
    **cuando la competencia la exige**», conservando los dos lados. Ese comentario
    es la especificación, no un adorno;
  - `relay-registrations.service.ts:275-279`: pasar el valor de la competencia,
    al crear y al modificar integrantes;
  - `registrations.service.ts:780-787`: leer el valor de la **misma** competencia
    dentro de la misma transacción. Apagado, la cancelación se permite y el
    relevo queda con un integrante sin prueba individual — que es exactamente lo
    que el ajuste autoriza;
  - **qué pasa al apagarlo** con relevos ya confirmados: nada se recalcula; solo
    dejan de bloquearse altas y cancelaciones futuras. **Al encenderlo** sobre
    equipos que no cumplen (**P5, decidida**): no se modifica, cancela ni
    retira a nadie, y **el administrador puede guardar**. Lo que cambia es que
    se le **muestra cuántos equipos confirmados están afectados**. *Propuesta,
    no confirmada, de mecanismo:* incluir en el detalle de la competencia
    (`GET /competitions/:id`) el recuento de equipos confirmados con algún
    integrante sin individual confirmada —lectura pura, sin ruta nueva— para
    que el formulario lo muestre al marcar la casilla y antes de guardar, y
    repetirlo en la respuesta del guardado (puede haber cambiado entre
    medias). Los equipos incumplidores siguen existiendo; las validaciones
    posteriores son las de siempre: un alta o una modificación de integrantes
    se valida contra **todos** los integrantes que se envían
    (`relay-registrations.service.ts:275-279`), así que **editar un equipo que
    incumple exige regularizar a quienes le falten**, cancelar el equipo
    sigue siendo posible, y la cancelación de la última individual sigue
    rechazándose para quien integre un relevo confirmado
    (`evaluarCancelacionDeIndividual`). Ese es el estado coherente que las
    pruebas deben fijar;
  - `competitions.schemas.ts` y `competitions.service.ts`: alta, edición y
    duplicado (heredando).
- **Interfaz:**
  - casilla en el alta (`CompetitionsListPage.tsx`) y en la edición
    (`CompetitionDetailPage.tsx`), con la etiqueta del enunciado y una ayuda que
    explique el **segundo lado** (que entonces no se podrá cancelar la última
    individual de quien integre un relevo);
  - línea de solo lectura en el resumen de la competencia;
  - `RelayWorkspacePage.tsx:454-459` y `:467-470` **afirman** la regla: deben
    decirlo solo cuando esté encendida (`selectedCompetition` ya está disponible
    en `:338`).
- **Documentación:** Módulo 8 del README — hay que **escribir** la regla, porque
  hoy no está (D4), y marcarla como configurable.

### Etapa 6 — Cambio 1 (carga masiva con club)

> **Estado (3 de noviembre de 2026): IMPLEMENTADA en el árbol local, sin commit ni
> despliegue.** Precisiones de la implementación:
> - **Columnas:** A-I como antes, **J «Sigla del club (opcional)»** y **K «Fecha
>   efectiva de membresía (AAAA-MM-DD; obligatoria si hay club)»**; la K admite
>   también `DD-MM-AAAA`. La propuesta «fecha faltante con club → rechazar» quedó
>   **aplicada** por instrucción del usuario: con club la fecha es obligatoria y
>   nunca se usa la de hoy; una fecha sin club es un error.
> - **Compatibilidad:** la plantilla A-I sigue sirviendo (solo personas); una J
>   titulada «Roles» rechaza el archivo entero; cualquier otro título en J/K, también.
> - **Unicidad de la sigla (corrección del 3 de noviembre).** La sigla es el
>   identificador único del club y rechazar la ambigüedad no sustituye esa
>   garantía: la migración `20261103020000_sigla_club_unica` crea
>   `clubs_code_unique_active`, único parcial sobre `club_code_normalizado(code)`
>   entre clubes no eliminados, incluidos los inactivos. Con duplicados se detiene
>   con el detalle y no modifica ningún club; se empareja con la comprobación
>   `club-sigla-duplicada` del preflight. El alta y la edición de clubes dan un
>   mensaje claro y el índice decide frente a la concurrencia (409). `resolverSigla`
>   conserva su defensa ante coincidencias ambiguas.
> - **Transacción por fila:** `createPerson` y `assignSwimmerDirectly` aceptan
>   `{ tx }`; la fila hace resolución de la sigla + persona + membresía + rol
>   derivado + auditorías en una sola transacción. **La sigla se resuelve dentro de
>   esa transacción con `FOR SHARE`**, sin lectura previa: la fila espera a un cambio
>   en curso y evalúa lo confirmado, y el club no puede cambiar hasta que ella
>   termine. Una correspondencia que ya no vale rechaza solo esa fila. **Duplicados internos:** se procesa la primera aparición y
>   las siguientes se rechazan indicando su fila (RUN normalizado; usuario solo si
>   viene informado).
> - **Permisos:** la ruta sigue en `persons:write`; si alguna fila trae club, el
>   servicio exige `swimmer-assignment:approve` (lo decide la ruta con el token)
>   y, sin él, rechaza el archivo entero con 403 antes de escribir. Un archivo
>   sin clubes no lo necesita.
> - **No se modificó ni se ejecutó** el cargador de la carga inicial.
> - Pruebas: `persons-bulk-import.rules.test.ts`,
>   `persons-bulk-import.integration.test.ts`,
>   `persons-bulk-import-club.integration.test.ts` y, en el frontend,
>   `PersonsBulkImportPage.test.tsx`.

Última por combinar creación de personas, membresías y roles derivados. El
contrato reutilizable ya está documentado en el repositorio (P1 resuelta) y el
identificador del club está decidido (P2: la sigla); la fecha efectiva
es por fila (P3, decidida). **Depende de la etapa 9**: la columna de nombre de usuario
pasa a ser opcional y eso exige antes que la base admita titulares sin nombre. La implementación y sus pruebas
se harán con datos sintéticos y destinos aislados. No incluye ninguna carga de
datos reales ni intervención en producción.

Se puede hacer **ya y por separado**, sin esperar ninguna decisión: corregir
`PersonsBulkImportPage.tsx:57-76` para que describa la plantilla real (hoy
publica la columna J «Roles» como obligatoria cuando el backend rechaza la fila
que la traiga — D5).

Diseño propuesto para el resto, **a confirmar**:

- **Una** columna de club al final de la hoja `Personas`, **opcional**: si viene,
  además de crear la persona se crea su membresía activa; si no viene, la persona
  se crea sin club, como hoy.
- **Identificación del club (P2, decidida):** la columna lleva la **sigla**
  (`clubs.code`), no el nombre de usuario. La comparación debe normalizar igual
  que el alta (`trim` y mayúsculas, `clubs.service.ts:275`). La hoja
  `Instrucciones` incluye la lista vigente (sigla y nombre del club) generada al
  construir la plantilla, pasada por `neutralizeSpreadsheetFormula`, para que
  nadie tenga que adivinarla.
- *(Resuelto: ver el estado de esta etapa.)* **Comprobación previa de la unicidad de la sigla (primera tarea de esta
  etapa, antes de escribir código que dependa de ella).** Hoy no hay índice único
  ni comprobación de duplicado sobre `clubs.code` (ver obstáculo 1). Se
  verificará con una consulta de **solo lectura** — sobre una copia restaurada de
  un respaldo o la base desechable, nunca la de trabajo ni producción, y con el
  respaldo descargado y restaurado — qué siglas se repiten entre clubes vigentes
  (`deleted_at IS NULL`), con y sin diferencias de mayúsculas y espacios. Si no
  hay repetidas, se propone **garantizarlo** con un índice único parcial
  `WHERE deleted_at IS NULL` (patrón de `clubs_username_unique_active`) más la
  comprobación en el servicio; es un cambio de esquema y requiere aprobación
  aparte. **Si hay repetidas, se redacta un informe con los casos y una propuesta,
  y no se corrige ningún dato automáticamente.** Mientras la unicidad no esté
  garantizada, la carga trata una sigla que coincida con más de un club como
  ambigua y rechaza la fila.
- **Validaciones** por fila, acumulando todos los errores como ya hace
  `mapRowToPersonInput:85-132`: la sigla existe, el club está vigente
  (`deletedAt: null`) y `active` (reutilizando `assertClubActive`), y la sigla
  no es ambigua, diciendo qué clubes coinciden.
- **Nombre de usuario opcional (depende de la etapa 9).** La columna B deja de
  ser obligatoria: celda vacía o con solo espacios significa `NULL`, nunca `""`
  ni un nombre generado a partir del RUN, la sigla o el correo. Si viene, se
  valida con `usernameField` y su unicidad global, como hoy. La carga **no**
  crea credenciales.
- **Identificación sin nombre de usuario.** A diferencia del cargador
  completado, que concilia por nombre de usuario (`cargar.mjs:689-738`,
  `:815-819`), aquí la persona se identifica por **RUN normalizado** y el club
  por **sigla** (P2). Ninguna regla de esta etapa debe depender de que la fila
  traiga nombre de usuario.
- **Duplicados:** el RUN y el nombre de usuario repetidos contra la base los
  ataja `createPerson` y el error llega al informe por fila. Falta cubrir dos
  filas del **mismo archivo** con el mismo RUN o usuario: hoy la segunda falla
  contra la primera ya creada con un mensaje de «ya existe», confuso; conviene
  detectarlo en el propio archivo y decir «duplicado dentro del archivo, fila N».
  El duplicado de nombre de usuario se mira **solo entre celdas no vacías**:
  dos filas sin nombre no son duplicadas.
  Y RB-06: si la persona ya existía con membresía activa en otro club, la fila se
  rechaza con el mensaje de `assignSwimmerDirectly:188-194`, sin reemplazo.
- **Atomicidad por fila:** persona + membresía + rol derivado en **una** sola
  transacción por fila, con el patrón `{ tx }` de `shared/transaction.ts`. Sin
  eso, una fila puede dejar la persona creada sin club y el informe decir «error»
  sobre alguien que sí quedó en la base.
- **Fecha efectiva de membresía por fila (P3, decidida).** La hoja `Personas`
  gana una columna con la fecha efectiva de **cada fila**; no hay una fecha
  única por archivo ni un campo en la pantalla. Se **persiste exactamente la
  fecha de esa fila** como `startDate` de su membresía. Formato
  `AAAA-MM-DD`, o `DD-MM-AAAA` como la fecha de nacimiento de la misma hoja,
  siempre como **fecha de calendario sin hora**, con las mismas reglas que
  `fechaEfectivaField` (`assignment.schemas.ts:23-28`: formato y existencia del
  día). La lógica de `bulkAssignSwimmers:299-314` —resolver la fecha una vez por
  tanda por el riesgo de partir una tanda que cruce la medianoche— **no aplica**
  a esta carga, porque aquí la fecha viene dada por fila y no se calcula; no se
  reutiliza esa función por tanda, sino el camino individual con
  `fechaEfectiva` (`assignSwimmerDirectly`, `assignment.service.ts:197-224`)
  dentro de la transacción de la fila.
  - **Si la fecha falta — *Propuesta, no confirmada*:** el usuario no definió
    este caso. Se propone **exigirla cuando la fila trae club** y rechazar la
    fila con un mensaje claro, **sin aplicar nunca en silencio la fecha de
    hoy**. Sin club, la columna se ignora si viene vacía; si trae fecha sin
    club, se informa como inconsistencia en vez de descartarla. Hasta que se
    confirme, esta es solo una propuesta.
  - Otras validaciones de la fecha (futura, anterior al nacimiento) no están
    definidas ni en el código actual: se mantienen las mismas que la asignación
    directa y cualquier regla adicional queda como propuesta a confirmar.
- **Permisos:** si la carga crea membresías, la ruta debe exigir `persons:write`
  **y** `swimmer-assignment:approve` (dos `requirePermission` en el `preHandler`,
  como `/persons/:id/admin-access` combina permiso y rol en
  `persons.routes.ts:78-90`).
- **Inyección de fórmulas:** la plantilla pasaría a llevar datos leídos de la base
  (la lista de clubes), así que hay que pasarlos por
  `neutralizeSpreadsheetFormula` (`reports.rules.ts`, probado en
  `tests/spreadsheet-injection.test.ts`). Hoy la plantilla es texto fijo y no lo
  necesitaba.

### Fase adicional A — Fechas reales de la competencia en el HY3 (2 de noviembre)

**Estado: IMPLEMENTADA en el árbol local, sin commit ni despliegue.** Es una fase
separada: no renumera ni modifica las etapas 1 a 10.

- **Defecto.** El registro `B1` del archivo HY3 escribía como inicio y término de la
  competencia `registrationStartAt` y `registrationEndAt`, que son las fechas de
  **inscripción**. Con inscripción del 26/10 al 05/11 y competencia el 08/11, Team
  Manager recibía como fechas del evento el 26/10 y el 05/11.
- **Criterio.** Las fechas salen de `CompetitionDate`: un día → inicio y término
  iguales; varios → primera y última, comparadas como texto `AAAA-MM-DD`, sin
  depender del orden de recuperación; ninguna → `ValidationError` claro, nunca las
  de inscripción. El día se lee con componentes UTC (las fechas se guardan como
  medianoche UTC), de modo que la zona del servidor no lo desplaza.
- **Sin cambios.** `ageUpDate` (`ageCutoffDate ?? registrationEndAt`), el resto de
  campos HY3, Latin-1, permisos, alcance por club, auditoría y checksum.
- **Archivos.** `team-manager-export/competition-dates.ts` (nuevo, función pura),
  `team-manager-export.service.ts`.
- **Pruebas.** Regresión 26/10–05/11 y competencia el 08/11/2026 → `11082026` en
  ambos campos con checksum válido; varios días desordenados; sin fechas; corte de
  edad intacto (con y sin `ageCutoffDate`); edades y demás líneas idénticas al
  cambiar las fechas; y estabilidad en **procesos hijos** con `TZ` de
  Santiago, Los Ángeles, Auckland, Kiritimati y UTC (cambiar `process.env.TZ`
  dentro de la prueba no surte efecto en Windows: la primera versión lo demostró).
- **Pendiente / a tener en cuenta.** Una competencia **antigua sin fechas
  programadas** ya no se podrá exportar hasta que se le agregue una (antes
  exportaba con las de inscripción, que eran incorrectas). No se consultó
  producción para saber si hay alguna. No requiere migración.

### Fase adicional B — Orden en Reportes (2 de noviembre)

**Estado: IMPLEMENTADA en el árbol local, sin commit ni despliegue.** Separada de
las etapas 1 a 10; no cambia contratos ni la interfaz.

- **Nadadores de cada club: por apellido paterno**, no por edad. Desempates:
  apellido materno, nombre de pila, nombre completo almacenado, RUN, identificador.
  Sin distinguir mayúsculas ni tildes; la «ñ» es letra propia. **Históricas sin
  apellido paterno:** no se inventa ninguno; van después de las demás, por su
  nombre completo almacenado. Los nombres almacenados no se tocan.
- **Pruebas y relevos de cada nadador:** número de programa numérico; ausentes al
  final; repetidos o ausentes por su **texto visible** (descripción y tiempo) y, solo
  como último recurso, por el identificador de la inscripción. El número de programa
  es `CompetitionEvent.displayOrder` (única columna; `eventNumber` es el nombre del
  mismo dato en el importador).
- **Desempate coherente.** La vista agrupada y las filas planas de CSV / XLSX / PDF
  usan el mismo criterio (`compararLineasDePrueba` y los comparadores de fila de
  `reports.rules.ts`), así que dos filas equivalentes de un mismo nadador salen en el
  mismo orden relativo en ambas; el identificador nunca decide antes que el texto.
- **Categoría y club mostrados: sin cambios.** Son los de la primera inscripción del
  nadador en el orden en que el servicio la entrega (individuales antes que
  relevos), igual que antes. Se separó la **selección** del **orden de las listas**:
  ordenar pruebas y relevos no la altera, y el servicio ordena copias para las filas
  planas, no los arreglos de los que se arman las entradas agrupadas. No se
  redefine como «la de la primera prueba del programa» (una regla no autorizada que
  una versión anterior de esta fase había introducido y ya se retiró).
- **Formatos.** CSV, XLSX y PDF comparten las filas planas, con los mismos criterios;
  los relevos siguen siendo **una fila por equipo**. Sin columnas nuevas ni filas
  duplicadas.
- **Archivos.** `reports.rules.ts` (comparadores puros), `reports.service.ts`
  (ordena las filas planas y entrega los componentes del nombre). El frontend no
  cambia.
- **Pruebas.** `reports-orden.test.ts` (permutaciones, históricas, empates, 2/3/10,
  ausentes, repetidos, categoría) y casos de extremo a extremo con la base
  desechable en `import-export-services.integration.test.ts`.
- **Pendiente / a tener en cuenta.** Las **exportaciones cambian de orden** respecto
  de las descargadas antes (los clubes ahora usan la colación en español y los
  nadadores van por apellido paterno). El PDF se genera íntegro, pero su orden se
  verificó por lectura del código (recorre las mismas filas con `forEach`), no
  abriendo el archivo.

### Etapa 7 — Documentación pendiente (opcional, deuda anterior)

D1, D2, D3, D4 y D8 son **anteriores a este trabajo** y están fuera de lo pedido.
Se hacen solo si se aprueban. Conviene decidirlo antes de la etapa 4: escribir el
límite nuevo por prueba en un README donde el cupo por club de la competencia no
existe deja la documentación más confusa que antes.

### Reglas comunes a las etapas 8, 9 y 10

- **Valores ausentes:** siempre `NULL`, nunca `""`. La API recorta espacios y
  convierte `""` (o solo espacios) en «ausente» al crear y en `null` al editar,
  igual que el correo de personas (`persons.schemas.ts:28`, `:55`). Una
  restricción `CHECK` en la base impide que una cadena vacía llegue por otro
  camino. Así ningún `""` puede competir por un índice único ni por la reserva
  global.
- **Unicidad con `NULL`:** los índices únicos parciales existentes ya admiten
  varios `NULL` (PostgreSQL los considera distintos); **no** se usa
  `NULLS NOT DISTINCT`. La reserva global no guarda `NULL` (ver etapa 9).
- **Orden técnico y compatibilidad operativa son dos cosas distintas** (ver
  «Compatibilidad entre versiones y despliegue coordinado», más abajo). El
  orden técnico es: migración que **relaja**, código nuevo, y solo al final la
  migración que **endurece**. Que ese orden sea necesario **no** garantiza que
  el código antiguo siga funcionando durante la transición: en las etapas 9 y
  10 no lo hace (evidencia en esa sección). Una versión anterior de este plan
  afirmaba lo contrario; queda corregida.
- **Comprobaciones previas en el preflight.** El proyecto empareja cada
  validación de una migración con una comprobación de
  `npm run preflight:migration` (patrón de `phase4_identity_guards:32-45`). Las
  comprobaciones nuevas de estas etapas se agregan a `scripts/migrationChecks.ts`
  con el mismo criterio, y la migración aborta con el detalle si encuentra
  datos que la incumplen, en vez de dejar que falle una restricción sin decir
  qué fila.
- **Pruebas de integración** solo contra la base desechable
  (`docker-compose.test.yml`, puerto 55432, nombre terminado en `_test`), nunca
  contra la de trabajo. Datos sintéticos siempre.
- **Respaldo — *Simplificado (3.ª revisión; R1):* ya no se exige por migración.**
  Texto original, que se conserva como historia: antes de cada migración, respaldo **descargado y restaurado**,
  como el del 1 de noviembre. Auto-Deploy sigue en `Off` en `fchmn-api` y
  `fchmn-web`: cada despliegue es manual.

### Compatibilidad entre versiones y despliegue coordinado (etapas 8, 9 y 10)

> **Simplificado (3.ª revisión, R5–R7).** Con los datos de la carga prescindibles,
> este apartado queda **reducido a historia**: el procedimiento, las variantes A/B,
> el acceso de mantenimiento, los ensayos de conservación, los criterios de
> apertura y de 10b y la reversión por restauración **se retiran**. Vale el
> «Camino mínimo» de «Simplificación por datos prescindibles». Lo único que
> se conserva de aquí es la evidencia de por qué conviene desplegar seguido
> (migración → API → web) y que la API nueva rechace con 400 los cuerpos antiguos.

Todo lo de este apartado es **lectura de código**; no se ejecutó ninguna
prueba, migración ni despliegue.

**Por qué no basta «migrar primero».** Hay tres piezas que se despliegan por
separado y a mano (`fchmn-mantenimiento` ejecuta `prisma migrate deploy`;
`fchmn-api` y `fchmn-web` son servicios aparte, con Auto-Deploy en `Off`), así
que entre un paso y el siguiente hay minutos u horas en que conviven versiones
distintas. Además la web es una aplicación de página única: una pestaña abierta
antes del despliegue sigue ejecutando el código **antiguo** hasta que se
recargue. No hay forma de saber cuántas hay, así que el plan no lo usa como
condición: exige comprobar que la API nueva rechaza sus peticiones.

**Evidencia de incompatibilidad (por lectura):**

| Etapa | Qué hace el código antiguo | Efecto |
|---|---|---|
| 10 | La API antigua acepta `hasLegalStatus: null` (`clubs.schemas.ts:25`, `.nullable()` obligatorio) y la interfaz antigua lo envía al elegir «Pendiente de verificar» (`ClubFormPage.tsx:109`, `:126`, `aValorPj`); un club nuevo **nace** en ese estado (`:34`) | Con `NOT NULL` ya aplicado, guardar esos formularios falla en la base: error 500, o un 409/400 mal explicado, y el usuario pierde lo escrito |
| 9 | El cliente de Prisma antiguo declara `username` como `String` (`schema.prisma:222`, `:304`); las lecturas de personas y clubes (`getPersonById`, `getClubById`, listados) devuelven esa columna. `createCredentials` copia `person.username` (`persons.service.ts:515`) | Al existir **un solo** titular con `username = NULL`, es esperable que Prisma falle al leer esa fila (valor nulo en campo obligatorio), con lo que fallarían el listado y la ficha enteros, no solo esa fila. Y crear credenciales intentaría insertar `NULL` en `users` |
| 8 | Igual con `email` (`schema.prisma:322`, `clubsApi.ts:23`): el cliente antiguo no espera `NULL`, y la interfaz antigua hace `setEmail(c.email)` (`ClubFormPage.tsx:59`) | Fallo de lectura del club o del listado si hay un club sin correo |
| 8, 9 | La API **antigua** exige correo y nombre al crear (`clubs.schemas.ts:28`, `:130`; `persons.schemas.ts:22`) | La interfaz **nueva** que los omita recibiría 400 contra una API antigua: falla limpia, sin escribir nada |

Lo marcado como «esperable» del cliente de Prisma es un comportamiento
conocido de la librería que **no se ha comprobado aquí**: se confirma en la
prueba de transición (ver más abajo) sobre la base desechable, nunca se da por
hecho.

**Dos clases de compatibilidad, que el plan separa:**

1. **Hacia atrás de la migración que relaja** (etapas 8 y 9: quitar `NOT NULL`,
   `CHECK`, función de reserva). El código antiguo **sigue funcionando
   mientras no exista ningún `NULL`**, porque nunca envía `NULL`, `""` ni un
   nombre fuera de formato (sus esquemas Zod lo impiden). La compatibilidad
   termina en el instante en que se crea **el primer** `NULL`, y solo la API
   nueva puede crearlo.
2. **Hacia atrás de la migración que endurece** (etapa 10: `NOT NULL`). No hay
   compatibilidad con la API ni la web antiguas, porque ambas pueden enviar
   `null`.

**Qué se puede y qué no se puede controlar con lo que existe.** La aplicación
no tiene modo de mantenimiento ni de solo lectura (búsqueda en `backend/src`:
ninguno). Con lo que hay, la única forma de impedir escrituras es **detener
`fchmn-api`**, y esa palanca tiene un límite que una versión anterior de este
plan pasó por alto: **en cuanto se arranca la API nueva, se reabren las
escrituras para todos los usuarios**. Por tanto no existe hoy ningún momento
en que la API nueva esté arriba, bloqueada para los usuarios y accesible para
quien valida. Afirmar «se valida antes de reabrir» exige un mecanismo que
mantenga cerrado el acceso mientras se valida. Ese mecanismo no existe y
**no se implementa en este plan**.

**Requisito futuro (no implementado, no diseñado aquí): acceso de
mantenimiento.** Para poder validar con la API nueva en producción sin abrirla
a los usuarios, haría falta algo que haga una de estas cosas, a elegir y
aprobar antes de la ventana:

- un modo de mantenimiento de la API que responda 503 a todos salvo a una
  credencial u origen del operador (requiere código y su propia revisión de
  seguridad); o
- una restricción de acceso a nivel de plataforma que deje alcanzable la API
  solo para el operador, si la plataforma lo permite (**no verificado**); o
- una segunda instancia de la API nueva, privada, contra la misma base (añade
  infraestructura y un servicio a pagar y limpiar).

Hasta que alguno exista y esté aprobado, el procedimiento se divide en dos
variantes, y el plan dice cuál de las dos garantías ofrece cada una:

- **Variante A — con mecanismo de mantenimiento (la verificable).** Se
  cierra el acceso, se migra, se arranca la API nueva *dentro* del cierre, se
  ejecutan las comprobaciones de producción (más abajo) y solo entonces se
  abre a los usuarios. Aquí «validar antes de reabrir» es literal.
- **Variante B — sin mecanismo (la que existiría hoy).** Detener la API
  impide escrituras solo hasta arrancar la nueva. La validación en producción
  ocurre **con las escrituras ya abiertas**, así que lo que protege no es una
  validación previa sino (1) un ensayo completo en entornos aislados con
  escrituras sintéticas, (2) que la API nueva rechace los cuerpos
  incompatibles, (3) un respaldo tomado inmediatamente antes de arrancarla y
  (4) un plazo de vigilancia con criterios de vuelta atrás. El plan **no
  presenta esta variante como validada antes de reabrir**. Se elige la A si es
  posible y, si no, se decide expresamente aceptar la B.

**Procedimiento (futuro; cada paso de producción exige autorización específica
y ninguno se ejecuta aquí).** Se aplica a cada migración por separado.

1. **Ensayo aislado completo** (ver «Ensayos en entornos aislados»): todo el
   procedimiento sobre una copia restaurada o la base desechable, con
   escrituras sintéticas. Es requisito para pedir la ventana.
2. **Preparación:** respaldo descargado y restaurado; comprobación previa de
   cantidades (etapa 10) y preflight; aviso a los usuarios; imágenes nuevas de
   API y web construidas sin desplegar.
3. **Cerrar el acceso:** variante A, con el mecanismo; variante B, detener
   `fchmn-api`. Se anota la hora.
4. **Respaldo final**, ya sin escrituras, que marca el punto de vuelta atrás.
5. **Etapas 8 y 9:** migración que relaja → API nueva → web nueva.
   **Etapa 10:** migración 10a (sin `NOT NULL`) → API nueva → web nueva.
6. **Comprobaciones de producción** (abajo). En la variante A, con el acceso
   aún cerrado; en la B, inmediatamente después de arrancar la API, con
   escrituras abiertas.
7. **Abrir** (variante A) o **mantener abierto** (variante B) solo si los
   criterios de apertura se cumplen; si no, se actúa según «Reversión».
8. **Vigilancia** durante el plazo que se acuerde antes de 10b.

**Por qué 10a y 10b van separadas: la estrategia de reversión.** El `NOT NULL`
es lo único de la etapa 10 que cierra la puerta al código antiguo. Mientras la
columna admita `NULL` (10a), volver a la API y la web anteriores sigue siendo
posible: el esquema acepta lo que ellas escriben. Con `NOT NULL` (10b) esa
vuelta atrás deja de ser posible sin tocar el esquema de nuevo. Separarlas
conserva una **ventana de reversión del código** entre la conversión y el
endurecimiento, y hace de 10b una decisión posterior y explícita. No depende de
que haya o no clientes antiguos abiertos; ese tema se cubre aparte.

**Peticiones incompatibles: se comprueba el rechazo, no la ausencia de
clientes.** No se puede saber qué pestañas hay abiertas, así que el plan no
pone como condición que no queden. Lo que se exige es que la API nueva rechace
de forma segura lo que un cliente antiguo pueda enviar, y que eso sea
comprobable:

- `hasLegalStatus: null` al crear o editar un club → 400 con mensaje que pide
  recargar, **sin 500 y sin escribir nada**;
- filtro `personalidadJuridica=pendiente` → 400 con el mismo criterio;
- cualquier cuerpo antiguo que la API nueva no admita, igual.

Esto se prueba con peticiones que reproducen los cuerpos antiguos, tanto en el
ensayo aislado como —solo rechazos, que no escriben— en producción. La
cantidad de esos rechazos queda en el registro de la API y es la señal que se
usa para decidir 10b.

#### Ensayos en entornos aislados (con escrituras sintéticas)

Únicos lugares donde se escribe para probar: la base desechable
(`docker-compose.test.yml`, puerto 55432, nombre terminado en `_test`) o una
copia restaurada, nunca la de trabajo ni producción. Datos sintéticos siempre.

- migraciones aplicadas en orden y sin error, y `SET NOT NULL` (10b) que falla
  con detalle si queda un `NULL`;
- **lectura del código antiguo con valores nulos:** con un titular de
  `username` y un club de `email` nulos, comprobar cómo responde la API
  antigua en `GET /persons`, `GET /clubs` y la ficha. Confirma o corrige la
  tabla de evidencia;
- **escritura del código antiguo contra el esquema:** compatible tras 8 y 9 sin
  `NULL`; tras 10a, que sigue pudiendo guardar `NULL`; tras 10b, que falla;
- API nueva con escrituras: crear persona y club sin correo ni nombre; crear
  credenciales sin nombre (400, nada escrito) y con nombre; nombre tomado y
  persona sin rol de acceso (el titular queda intacto y editable);
  concurrencia entre renombrar y crear credenciales;
- rechazo de cuerpos incompatibles (lista de arriba);
- 10a: conversión de una base sintética con clubes `true`, `false` y `NULL`
  (con y sin RUT, con representante en un `true`): solo cambian los `NULL`;
  auditoría; nombramientos y roles idénticos;
- inicio de sesión de una cuenta existente y restablecimiento de contraseña;
- web nueva contra la API nueva: formularios y lista de clubes sin errores en
  consola.

#### Comprobaciones futuras en producción (sin escrituras sintéticas)

Cada una requiere **autorización específica** para producción; este plan no
ejecuta ninguna. **No se crean registros de prueba en producción.** Solo hay
lecturas y peticiones que deben ser rechazadas sin escribir:

- migraciones aplicadas (estado de `_prisma_migrations`);
- conteos de solo lectura: 10a → `has_legal_status IS NULL` = 0, `false` =
  previos + convertidos, identificadores `true` idénticos a la comprobación
  previa, nombramientos y roles `legal_representative` idénticos, filas de
  auditoría = convertidos; 8 y 9 → `NULL` en `clubs.email`, `persons.username`,
  `clubs.username` en los valores esperados, `username_reservations` sin filas
  `NULL` ni huérfanas, preflight sin falsos positivos;
- lecturas con la API nueva: listado y ficha de personas y clubes, sin errores
  de lectura de Prisma en el registro;
- inicio de sesión de una cuenta existente (lectura de credenciales; sin
  restablecer ninguna);
- peticiones incompatibles que deben responder 400 sin escribir, comprobando
  después que los conteos no cambiaron;
- registro de la API sin errores 500 nuevos.

**Criterios de apertura:** variante A, todas las comprobaciones de producción
pasan antes de abrir; variante B, se cumplen al arrancar y se mantienen durante
la vigilancia, y cualquier fallo activa la vuelta atrás. En ambas: el ensayo
aislado completo pasó, existe el respaldo final de la ventana y nadie reabre
«para ver qué pasa».

**Criterios para 10b (`SET NOT NULL`):** `NULL` = 0 en `has_legal_status`
(lectura); el plazo de vigilancia acordado transcurrió sin errores 500 y con los
rechazos por `null`, si los hubo, explicados; se acepta expresamente que, desde
10b, volver al código antiguo exige antes revisar el esquema.

**Reversión: lo que sí y lo que no.**

- **Restaurar solo el código antiguo no basta en cuanto existan valores nulos
  (8, 9) o la conversión (10).** La API antigua podría no leer filas con
  `NULL`, y la web antigua mostraría datos que ya no entiende. Y no se puede
  volver a poner `NOT NULL` en `email` ni `username` mientras queden `NULL`
  (la propia instrucción fallaría).
- **Mientras no se haya creado ningún `NULL`**, volver al código antiguo es
  seguro para las etapas 8 y 9: la migración que relaja es compatible con él.
- **Etapa 10a** no deshace con el código: «No tiene» convertido y «No tiene»
  declarado son el mismo valor. Las filas de auditoría **documentan** qué
  clubes cambiaron; **no son una reversión automática**. Una reversión
  selectiva por ellas exige antes revisar, club por club, las ediciones
  posteriores (alguien pudo cambiar a «Tiene», o editar el club ya convertido),
  y que la versión del esquema y del código destino admitan `NULL` en
  `has_legal_status` (no la admitirían tras 10b). Sin esa revisión, no se
  ejecuta.
- **La vía general es el respaldo final de la ventana**, que solo sirve si no
  hubo escrituras posteriores que perder. En la variante B esas escrituras
  pueden existir apenas se arranca la API, por lo que la restauración implica
  perder lo escrito desde entonces: otra razón para preferir la A.
- Revertir una migración es un procedimiento propio, también sujeto a
  autorización para producción; este plan no lo ejecuta.

### Etapa 8 — Cambio 7 (correo del club opcional)

- **Datos:** `ALTER TABLE "clubs" ALTER COLUMN "email" DROP NOT NULL;` y
  `CHECK ("email" IS NULL OR "email" !~ '^\s*$')` (expresión regular y no
  `btrim`: este último solo recorta espacios y dejaba pasar un correo de solo
  tabuladores, hallado al probar la migración). No convierte ninguna fila:
  los correos existentes, incluidos los que pudieran ser provisionales, se
  conservan. Limpiar correos provisionales no forma parte de este cambio ni se
  hace automáticamente.
  - Comprobación previa (solo lectura, copia restaurada): clubes con
    `email ~ '^\s*$'`. Se espera 0, porque la API siempre exigió formato de
    correo. Si hay alguno, la migración se detiene y se informa; no se
    corrige nada.
- **Servidor:** `email` opcional al crear; al editar admite `null` y `""` (que
  significa `null`) para quitarlo; omitido sigue significando «no tocar». El
  formato se valida solo si hay valor. Prisma pasa a `String?`.
- **Interfaz:** etiqueta «Correo electrónico (contacto, opcional)», sin
  `required`; al cargar un club sin correo el campo queda vacío; tipo
  `email: string | null`.
- **API y compatibilidad:** los clientes que hoy envían correo siguen igual. Las
  respuestas pueden traer `email: null`, que la interfaz nueva admite.
- **Importación:** no existe importación de clubes en la aplicación (ver §1).
- **Documentación:** tabla y reglas del Módulo 3 (`README.md:464-502`).

### Etapa 9 — Cambio 8 (nombre de usuario opcional y credenciales)

- **Datos** (una migración):
  1. `ALTER TABLE "persons" ALTER COLUMN "username" DROP NOT NULL;` y lo mismo
     en `clubs`. `users.username` sigue obligatorio: una cuenta siempre tiene
     nombre.
  2. `CREATE OR REPLACE FUNCTION username_registry_reserve(...)` para que
     **no reserve nada** si el nombre es `NULL`. Liberar un `NULL` ya no hace
     nada (`username_registry_release` compara por igualdad). Pasar un nombre a
     `NULL` libera el anterior por la rama existente de «nombre distinto».
  3. `CHECK ("username" IS NULL OR "username" !~ '^\s*$')` en las dos tablas
     (`persons_username_no_vacio`, `clubs_username_no_vacio`): impide `""` y
     cualquier cadena de solo espacios en blanco. **Ajuste al implementar:** la
     propuesta inicial replicaba aquí el formato completo de `usernameField`,
     pero la base de la versión previa que reproduce
     `migration-upgrade.integration.test.ts` tiene nombres de 3 letras, y la
     migración no corrige datos. El formato lo sigue exigiendo la API.
  4. Sin cambios en `users_username_igual_al_titular` ni en
     `titular_forbid_rename_con_cuenta`: ya hacen lo que se pide (una cuenta no
     puede nacer sin el nombre de su titular, y un titular con cuenta vigente no
     se puede renombrar).
  - Comprobación previa (solo lectura, copia restaurada): nombres vacíos o de
    solo espacios (comprobación `username-vacio` del preflight); reservas
    incoherentes con el preflight actual. Si hay incumplimientos, la migración
    se **detiene** con el detalle y no se corrige ningún dato.
  - **No se borra ni se genera ningún nombre.** Los existentes se conservan.
- **Servidor:**
  - alta de persona y de club: `username` opcional; vacío = ausente. Si viene,
    formato y disponibilidad global como hoy. **No** se deriva de RUN, sigla,
    correo ni nombre, y **no** se crea cuenta;
  - edición: `username` admitido (`string`, o `null`/`""` para quitarlo) solo
    mientras el titular **no tenga cuenta**. Con cuenta —activa, bloqueada o
    inhabilitada— se rechaza con «El nombre de usuario ya no se puede cambiar:
    las credenciales de acceso se crearon con él». La comprobación va en la
    misma transacción que la escritura; el disparador
    `titular_forbid_rename_con_cuenta` queda como garantía final;
  - **crear credenciales:** `POST /persons/:id/credentials` y
    `POST /clubs/:id/credentials` aceptan un cuerpo opcional `{ username? }`.
    - Si se envía, se valida (`usernameField` + disponibilidad excluyendo al
      propio titular) y se asigna al titular **en la misma transacción** que
      crea la cuenta.
    - Si no se envía y el titular ya tiene nombre, se usa ese (compatibilidad
      con los clientes actuales, que no envían cuerpo).
    - Si no hay ninguno de los dos: 400 «Indique un nombre de usuario para
      crear las credenciales», con el campo señalado, y **nada se escribe**.
    - **Un intento fallido no bloquea el nombre.** Nombre tomado, persona sin
      rol de acceso (`persons.service.ts:492-504`), rol no configurado,
      conflicto concurrente o fallo de auditoría: la transacción se revierte
      completa y el titular conserva su valor anterior (incluido `NULL`) y sigue
      editable. El bloqueo existe **solo** cuando la fila de `users` quedó
      confirmada.
    - **Clubes:** `createClubCredentials` pasa a una única transacción
      serializable con `withTranslatedPrismaErrors`, como la de personas (hoy
      lee el club fuera, `clubs.service.ts:469-473`). El hash se sigue
      calculando antes de abrirla.
    - La auditoría de la creación registra el nombre asignado.
  - **Restablecer contraseña:** sin cambios. No toca el nombre, no lo
    desbloquea y sigue exigiendo una cuenta.
  - `scripts/migrationChecks.ts`: excluir `NULL` en `username-persona-duplicado`,
    `username-club-duplicado`, `username-colision-global` y
    `reservas-de-username-incoherentes`, para que los titulares sin nombre no
    aparezcan como duplicados ni como «sin reserva».
  - Carga masiva de personas: columna B opcional (ver etapa 6; si la etapa 6
    se pospone, este ajuste mínimo de la columna B se hace aquí).
- **Interfaz** (`PersonFormPage.tsx` y `ClubFormPage.tsx`):
  - el campo sale de la parte superior y pasa a una sección con el título
    exacto **«Credenciales de acceso»**, visible también al **crear**; la
    sección entra en el `<form>` para que «Guardar» envíe el nombre;
  - al crear: campo opcional y la nota «Las credenciales se crean después de
    guardar, con el botón “Crear credenciales”». No se ofrece crear la cuenta
    en el alta;
  - al editar sin cuenta: campo editable; «Guardar» lo persiste (vacío = sin
    nombre); el botón «Crear credenciales» (`type="button"`) envía el valor del
    campo; queda deshabilitado, con la explicación, mientras el campo esté
    vacío o no cumpla el formato. La validación del cliente es solo de ayuda;
  - tras crear correctamente: el campo pasa a solo lectura con la nota «No se
    puede modificar: las credenciales se crearon con este nombre», y se muestra
    «Restablecer contraseña» como hoy;
  - tras un fallo: se muestra el error y el campo sigue editable con lo escrito;
  - tipos `username: string | null` en `personsApi.ts` y `clubsApi.ts`.
- **Documentación:** `README.md:419` («nombre de usuario no editable»),
  `:455-460` (RB-01) y la tabla del Módulo 3, que pasan a decir «editable hasta
  crear las credenciales».

### Etapa 10 — Cambio 9 (retirar «Pendiente de verificar»)

> **Simplificado (3.ª revisión).** Los puntos 1 (comprobación previa de cantidades
> y respaldo restaurado), 5 (verificación posterior con sumas de verificación) y 6
> (reversión por respaldo), y la protección del RUT retirado (P14, trazabilidad),
> existían para conservar o recuperar los 156 clubes de la carga: **se retiran**
> (R1–R4, R7). Sigue vigente la migración **10a ya implementada** —sin
> modificarla— y la **10b se despliega junto con ella**, sin plazo de
> vigilancia. Ver «Simplificación por datos prescindibles».

> **Estado (3 de noviembre de 2026): 10a y 10b están IMPLEMENTADAS en el árbol
> local, sin commit ni despliegue.** La **10b** es la migración
> `20261103030000_personalidad_juridica_obligatoria`: `SET NOT NULL` sin valor por
> omisión; **no convierte ni borra nada** y, si queda un `NULL`, se detiene con el
> detalle (cuántos y cuáles, eliminados incluidos) sin modificar ninguna fila.
> Prisma pasa a `Boolean` y los comentarios de dos estados se actualizaron; la API
> sigue respondiendo 400 a `null` u omisión. Se **despliega junto con la 10a**, en el
> mismo `migrate deploy` y antes de la API y la web nuevas, **sin plazo de
> vigilancia ni ensayos para conservar los datos de la carga inicial**. Pruebas:
> `migracion-personalidad-juridica-obligatoria.integration.test.ts` (base aparte,
> preparada en el esquema anterior: orden completo 10a→10b; solo `true`/`false` sin
> alterar datos; rechazo con `NULL`; `NULL` rechazado tras migrar; sin DEFAULT).
> Las notas siguientes describen la 10a (2 de noviembre).
>
> **Estado de la 10a (2 de noviembre de 2026).** Lo implementado y verificado con datos
> sintéticos en la base desechable:
> migración `20261102020000_personalidad_juridica_sin_pendiente` (transacción
> explícita; aborta ENTERA si un club pendiente tiene representante legal; una
> auditoría por club convertido, sin el valor del RUT; sin tabla nueva);
> comprobación `club-pendiente-con-representante-legal` en el preflight; API que
> solo admite `true`/`false` (`null`, omisión y filtro `pendiente` → 400); y una
> interfaz con dos opciones, «No tiene» seleccionada en las altas. Detalles de
> diseño que el plan no preveía:
>
> - **La validación con diagnóstico va ANTES de `BEGIN`.** Con una transacción
>   explícita, un `RAISE EXCEPTION` dentro deja la conexión abortada y Prisma, al
>   registrar el fallo, choca con «current transaction is aborted»: el motivo se
>   pierde. Fuera de la transacción el operador recibe el diagnóstico completo y
>   no se ha escrito nada. La misma comprobación se repite dentro, sobre los
>   clubes ya bloqueados, como guarda ante una carrera (ahí el mensaje sí queda
>   genérico, pero la transacción se deshace entera: probado con un fallo
>   provocado a mitad de la conversión).
> - **P14, trazabilidad: decidido, no se crea tabla.** El valor anterior del RUT
>   no se conserva en la base: su recuperación eventual depende del respaldo
>   previo protegido. La auditoría registra solo `rutEliminado: true|false`.
> - *(Cerrado con la 10b)* Prisma declaraba `has_legal_status` como `Boolean?`
>   mientras la columna era físicamente anulable; ahora es `Boolean`.
> - *(Cerrado)* **10b:** `SET NOT NULL`, sin valor por omisión, en una migración
>   aparte; ver el estado de arriba. Ya no depende de «criterios de 10b» ni de una
>   ventana: se despliega con la 10a.
> - **Sigue pendiente, como siempre, toda operación sobre producción:** el
>   respaldo descargado y restaurado, la comprobación previa de cantidades, la
>   ventana, la conversión real y la verificación posterior.

**Decisión del usuario que cambia datos:** los clubes con personalidad jurídica
«pendiente» (`NULL`) pasan a «No tiene» (`false`). Es convertir un dato
**desconocido** en una **afirmación negativa**; no es una verificación. Se
ejecuta solo con autorización expresa en el momento de hacerlo, y no se
deshace por migración (ver reversión).

1. **Comprobación previa de cantidades** (solo lectura, sobre la copia
   restaurada de un respaldo descargado; nunca la base de trabajo ni
   producción en esta fase):
   - clubes por estado (`true` / `false` / `NULL`), separando vigentes y
     eliminados lógicamente;
   - **solo cantidades, nunca valores:** clubes `NULL` con RUT guardado y
     clubes `NULL` con razón social guardada (esta última para comprobar luego
     que no se toca); clubes que **no** son `NULL` y tienen RUT (para comprobar
     que no cambia);
   - clubes `NULL` con representante legal en `club_staff`;
   - personas con rol `legal_representative` activo en `person_roles` y en
     `user_roles`, para comparar después;
   - la lista de identificadores de clubes `true`, para comprobar después que
     no cambió.
   Si hay clubes `NULL` con RUT, la migración los elimina (P14, decidida);
   el recuento previo solo fija cuántos son. Si hay clubes `NULL` con
   representante legal → se detiene, se informa y no se toca ningún
   nombramiento. **Respaldo previo obligatorio**, descargado y restaurado (ver
   las reglas comunes): es lo que permite recuperar el RUT retirado.
2. **Migración** (en una sola transacción):
   - validaciones con `RAISE EXCEPTION` y detalle, emparejadas con el
     preflight: abortar si hay `NULL` con representante legal;
   - una fila de auditoría por club convertido (`audit_logs`, acción
     `CLUB_LEGAL_STATUS_CONVERTED`, `before` `null`, `after` `false`, sin
     usuario), para que quede rastro de qué clubes eran pendientes. La columna
     `audit_logs.id` no tiene valor por omisión en la base
     (`20260827015835_init/migration.sql:123-124`; Prisma lo genera en el
     cliente), así que la migración lo genera con `gen_random_uuid()`;
   - **conversión y eliminación del RUT en la MISMA sentencia o, como mínimo,
     la misma transacción** (nunca en pasos separados, para que no exista un
     estado «No tiene con RUT» ni uno «pendiente sin RUT»):
     `UPDATE "clubs" SET "has_legal_status" = false, "rut" = NULL WHERE "has_legal_status" IS NULL;`
     incluidos los eliminados lógicamente. El `WHERE` es lo que impide tocar el
     RUT de clubes en cualquier otro estado. **No** se modifica `legal_name`
     ni ninguna otra columna;
   - **trazabilidad protegida del valor anterior (P14, decidido).** El RUT
     retirado no queda en `audit_logs`, porque esa tabla se consulta por la API
     con `audit:read` y se exporta. Las filas de auditoría de la conversión
     registran *que* el club estaba pendiente y *que* se retiró un RUT
     (`rutEliminado: true|false`), **sin el valor**. **No se crea ninguna tabla**
     para conservarlo (decisión del usuario, que sustituye a la propuesta
     anterior de una tabla restringida): el respaldo previo descargado es la
     **única** fuente del valor anterior y debe conservarse con la misma
     protección que cualquier respaldo con datos personales;
   - `COMMENT ON COLUMN` con los dos estados.
   Es la migración **10a**; todo lo anterior forma parte de ella y ocurre en
   una sola transacción. El `SET NOT NULL` (sin valor por omisión: la API
   exige el valor en cada alta) va en una migración **10b** posterior, con los
   criterios de «Compatibilidad entre versiones y despliegue coordinado»;
   aplicarlo junto con la conversión rompería la vuelta atrás del código.
   No toca `club_staff`, `person_roles`, `user_roles` ni los clubes `true`.
3. **Servidor:** `hasLegalStatus: z.boolean()` obligatorio (enviar `null`
   responde 400); filtro `personalidadJuridica: si|no` (`pendiente` responde
   400); `refineRut` y `assertRepresentanteLegalPermitido` con dos ramas; se
   mantiene el bloqueo de cambio de estado con representante designado.
   **P15:** el valor inicial «No tiene» es solo de la interfaz; el servidor **no**
   tiene valor por omisión y exige el campo explícito, de modo que un cliente
   que lo omita o envíe `null` recibe 400 en vez de afirmar algo sin querer.
   Prisma pasa a `Boolean` **con la 10b**; hasta entonces sigue `Boolean?`
   porque la columna física admite NULL. Las comparaciones explícitas
   `=== true` / `=== false` se conservan.
4. **Interfaz:** dos opciones, «Sí, tiene» y «No tiene»; **al crear un club la
   opción inicial seleccionada es «No tiene» (P15, decidida)**, y al editar se
   muestra la del club; desaparecen los textos de «pendiente» del formulario y
   de la lista, la opción del filtro, la etiqueta «Pendiente» y «Sin RUT
   todavía».
5. **Verificación posterior** (en la copia restaurada al ensayar, y en el
   destino real solo cuando se autorice; tras 10a): `NULL` = 0; `false` = `false` previo +
   convertidos; identificadores `true` idénticos; filas de `club_staff`
   `legal_representative` y roles `legal_representative` en `person_roles` y
   `user_roles` idénticos a la comprobación previa; filas de auditoría =
   convertidos; **RUT:** clubes convertidos con RUT = 0; cantidad de RUT de
   clubes que no se convirtieron **idéntica** a la previa (se compara por
   recuento y por una suma de verificación, nunca imprimiendo valores);
   razón social intacta (mismo recuento y suma de verificación); y una fila de
   auditoría por club convertido, sin el valor del RUT. Los informes
   y los resultados de verificación **no contienen RUT ni otros datos
   personales**.
6. **Reversión:** ninguna migración la deshace por sí misma, porque después de
   la conversión «No tiene» convertido y «No tiene» declarado son el mismo
   valor. La vía general es el respaldo final de la ventana (si no hubo escrituras
   posteriores). Las filas de auditoría **documentan** la conversión, pero **no
   son una reversión automática**: cualquier reversión selectiva requiere
   revisar las ediciones posteriores y la compatibilidad del esquema (ver
   «Compatibilidad entre versiones y despliegue coordinado»).
- **Documentación:** `README.md:468` y `:481-502` vuelven a dos estados y dejan
  constancia de la conversión como decisión del usuario; la nota de la guía de
  la carga (`docs/operacion/carga-masiva-inicial.md` §2.2) queda como registro
  histórico y no se modifica.

---

## 3. Compatibilidad con competencias e inscripciones existentes

- **Las tres migraciones de las etapas 3 a 5 son aditivas**: dos booleanos con
  `DEFAULT` y un entero anulable. Ninguna reescribe filas, ni borra, ni cambia
  tipos. Producción tiene 156 clubes, 5.071 personas y 5.071 membresías activas
  reales: nada de esto las toca.
- **Las etapas 8 y 9 relajan restricciones sin convertir datos**: quitan
  `NOT NULL` de `clubs.email`, `persons.username` y `clubs.username`, agregan
  `CHECK` que solo prohíben cadenas vacías o mal formadas y cambian la función
  de reserva para ignorar `NULL`. Ningún correo ni nombre existente se borra,
  se genera o se reescribe. El efecto visible es que los titulares **sin**
  cuenta pasan a tener el nombre editable.
- **La etapa 10 sí convierte datos**, y es la única: todo club `NULL` pasa a
  `false` por decisión del usuario (P13), con comprobación previa, auditoría
  por club y verificación posterior (10a). El `NOT NULL` se exige después, en
  una migración aparte (10b). No cambia nombramientos ni permisos.
- **Las etapas 8 a 10 no son compatibles hacia atrás sin coordinación**: el
  código antiguo funciona con las migraciones de las etapas 8 y 9 solo mientras
  no exista ningún `NULL`, y no funciona con `NOT NULL` en la etapa 10. Se
  despliegan con el procedimiento de «Compatibilidad entre versiones y
  despliegue coordinado»: detener la API solo evita escrituras hasta volver a
  arrancarla, así que validar antes de abrir exige un mecanismo de
  mantenimiento que hoy no existe (requisito futuro, no implementado); sin él,
  la validación en producción ocurre con las escrituras abiertas.
- **Credenciales existentes:** todas las cuentas vigentes ya llevan el nombre
  de su titular (lo exige la base desde `phase4_identity_guards`), así que
  siguen funcionando igual y sus titulares quedan bloqueados como hoy.
  Restablecer la contraseña no cambia el nombre ni lo desbloquea.
- **Herramientas de la carga completada:** el cargador concilia por nombre de
  usuario y exige `hasLegalStatus: null`; tras las etapas 9 y 10 dejaría de
  servir contra la API. No se modifica ni se vuelve a ejecutar.
  *(3.ª revisión: los datos que esa carga produjo son prescindibles y pueden
  eliminarse; ver «Simplificación por datos prescindibles». Las afirmaciones de
  este apartado sobre «producción tiene 156 clubes, 5.071 personas y 5.071
  membresías» y sobre las etapas 8 a 10 como «no compatibles sin coordinación»
  quedan como contexto histórico.)*
- **Competencias existentes:** `visible_in_registration_panels = true` (siguen
  visibles, como pide el enunciado); `require_individual_for_relay = true`
  (conserva el comportamiento con el que se validaron las inscripciones ya
  confirmadas; P4 decidida: las existentes conservan la regla y las nuevas
  nacen con la casilla marcada); `competition_events.max_swimmers_per_club = NULL`
  («Sin límite»).
- **Inscripciones existentes:** ninguna se revalida, cancela ni recalcula. El
  límite por prueba y la condición de relevos gobiernan **solo altas y
  cancelaciones nuevas**, igual que ya hacen los cupos
  (`competitions.service.ts:268-275`).
- **Duplicar una competencia** debe heredar los tres valores explícitamente; si
  no se toca `duplicateCompetition`, las copias nacerían con los valores por
  omisión y no con los del origen.
- **La etapa 2 cambia datos de permisos, no personas ni inscripciones:** se prevé ejecutar
  `node dist-seed/prisma/seed.js` (idempotente; imagen de mantenimiento del mismo commit,
  tras las migraciones y antes de la API y la web) para que
  `role_permissions` incorpore el permiso. Ninguna migración lo hace.
- **La etapa 1 no toca datos ni servidor** y se puede desplegar sola.
- **Despliegue:** `npx prisma migrate deploy` con el perfil `mantenimiento`
  (`README.md:87-92`), con un respaldo **descargado y restaurado** antes, como el
  de la jornada del 1 de noviembre. Para las etapas 8 a 10 no basta ese orden:
  ver el procedimiento coordinado de §2. Recordar que `fchmn-api` y `fchmn-web`
  quedaron con Auto-Deploy en `Off` desde la carga masiva: hay
  que contarlo en el despliegue, no suponerlo automático.

---

## 4. Criterios de aceptación y pruebas

### Cambio 5 — disponibles en relevos

**Aceptación:** al soltar un nadador en un puesto desaparece de la columna
izquierda; al retirarlo con «×», al pulsar Escape o al cambiar de prueba vuelve
a aparecer. Intercambiar dos puestos ocupados no devuelve a sus integrantes a
la izquierda: ambos siguen colocados. Un guardado fallido no oculta a nadie que
no esté colocado; un nadador que ya integra un equipo **confirmado** de otra
prueba sigue apareciendo como disponible.

**Pruebas** (frontend, vitest + jsdom, junto a `RelayWorkspacePage.test.tsx`):
soltar oculta · «×» devuelve · cambiar de prueba devuelve a los cuatro ·
`api.create` rechazado deja los cuatro en sus puestos y **no** los devuelve a la
izquierda, con el aviso mostrado · integrante de un equipo confirmado de otra
prueba sigue listado.

### Cambio 2 — exportación HY3

**Aceptación:** un delegado, un entrenador, un representante legal y la cuenta
del club (rol `club`) ven el botón y descargan el `.HY3` **de su club**; pedir otro `clubId` responde 403; un nadador
«puro» no ve el botón y la ruta lo rechaza; el administrador sigue exportando
cualquier club; cada descarga sigue dejando `TEAM_MANAGER_EXPORT_HY3` en
auditoría.

**Pruebas:** `rbac.definitions.test.ts` — los tres roles siguen idénticos, el
permiso está en el catálogo, el administrador conserva todo y el rol `swimmer`
**no** lo recibe · integración al estilo de
`permisos-operaciones-nuevas.integration.test.ts` — delegado de A con `clubId=A`
→ 200, con `clubId=B` → 403; nadador → 403; administrador → 200 con cualquiera ·
frontend — el botón aparece en una sesión de delegado (`test/sesionDePrueba.ts`) y
no en una de nadador · `documentacion.test.ts` vuelve a pasar con la fila
corregida.

### Cambio 6 — visibilidad

**Aceptación:** una competencia marcada como oculta no aparece en el filtro del
Panel de Inscripción ni en el del Panel de Relevos, para **ningún** rol
(administrador incluido: es configuración, no permiso); sí aparece en la tabla de
administración, con `No` en «Mostrar en competencia»; `GET /competitions/:id`
sigue respondiendo; las competencias preexistentes quedan con `Sí`; **ocultar no
cambia ninguna regla de acceso ni de inscripción (P7)**: el alta en una
competencia oculta y abierta se comporta exactamente igual que antes; Reportes y
los dos asistentes conservan su listado, oculta o no (P8); duplicar hereda el
valor.

**Pruebas:** integración al estilo de
`competition-integrity.integration.test.ts` — la lista para paneles la omite y la
del administrador la incluye; el detalle sigue accesible; una inscripción sobre
una competencia oculta y abierta sigue admitiéndose (caracteriza P7 para que un
cambio futuro no lo restrinja sin querer); duplicar hereda · frontend — Reportes
y los asistentes siguen listando la competencia oculta ·
`migration-upgrade.integration.test.ts` — tras actualizar una
base anterior, todas las competencias quedan visibles · frontend
(`CompetitionsListPage.test.tsx`) — la columna existe con el título **exacto**
«Mostrar en competencia» y la casilla envía el valor correcto.

### Cambio 4 — límite por prueba

**Aceptación:** el campo aparece vacío («Sin límite») en toda prueba individual,
existente o nueva, y **no** aparece en pruebas de relevo; con el límite en N, la
inscripción N+1 del mismo club en esa prueba se rechaza con un mensaje que diga
el tope y cuántos sitios quedan; otro club no se ve afectado; un nadador ya
inscrito en **otra** prueba no consume sitio en esta; bajar el límite por debajo
de lo inscrito no borra nada; dos altas simultáneas sobre el último sitio dejan
**una** confirmada y un 409 reintentable; duplicar la competencia copia el
límite.

**Pruebas:** unitarias de la regla pura — justo en el tope, uno por encima, sin
límite, límite 1, nadador del mismo club en otra prueba, nadador de otro club ·
integración junto a `competition-capacity.integration.test.ts` — rechazo en N+1,
otro club sigue, **concurrencia** (hay precedente en
`identity-guards-concurrency.integration.test.ts` y
`prisma-conflicts.integration.test.ts`), **P6:** un administrador excede el
límite y queda la auditoría con autor, club, competencia/prueba, límite y
cantidad resultante; un usuario con `registrations:write` o con
`registrations:write:post-close` que **no** es administrador recibe el rechazo ·
duplicado · frontend — el campo no se ofrece en
relevos y vacío envía `null`.

### Cambio 3 — condición de relevos

**Aceptación:** con la condición **encendida**, el comportamiento es idéntico al
de hoy, con los mismos mensajes, incluido el rechazo de cancelar la última
individual de quien integra un relevo; **apagada**, se puede formar un equipo con
integrantes sin prueba individual y cancelar la última individual de un
integrante; apagarla o encenderla **no modifica ni cancela nada** ya confirmado;
las competencias preexistentes conservan la regla (P4) y una competencia nueva
nace con la casilla marcada; duplicar hereda; los textos del Panel de Relevos
solo afirman la regla cuando está encendida. **P5:** al encender la condición
sobre equipos confirmados que no la cumplen se muestra cuántos son y el
administrador puede guardar, sin que ningún equipo, inscripción o integrante
cambie; después, editar uno de esos equipos exige regularizarlo, cancelarlo sigue
siendo posible y cancelar la última individual de un integrante de relevo sigue
rechazándose.

**Pruebas:** `relay-membership.rules.test.ts` — las pruebas actuales siguen
valiendo pasando el interruptor en `true`, más casos nuevos con él en `false` en
los dos lados · integración — ciclo completo apagado (crear relevo sin individual
y cancelar la individual de un integrante) y encendido (mensajes actuales);
migración de una base anterior deja `true` en todas las competencias (P4);
encender la condición con equipos incumplidores devuelve el recuento correcto,
guarda, y deja los equipos, las inscripciones y los integrantes idénticos;
un alta nueva y una edición de un equipo incumplidor se validan; duplicado hereda · frontend —
los dos avisos del Panel de Relevos aparecen o no según el valor.

### Cambio 1 — carga masiva

**Aceptación:** la plantilla descargable incluye la columna de club, que se
identifica por **sigla (P2)**, y la de **fecha efectiva por fila** (P3), y la
hoja `Instrucciones` lista
las siglas vigentes; la comprobación de unicidad de la sigla se hizo y su
resultado está informado antes de depender de ella; una fila con sigla válida
deja persona **+** membresía activa **+** rol `swimmer` derivado, y el
`startDate` de esa membresía es **exactamente** la fecha de su fila (dos filas
con fechas distintas dejan dos fechas distintas; ninguna toma la fecha del día);
una fila con club y sin fecha se rechaza sin escribir nada, con un mensaje
claro (*propuesta no confirmada*); una fila sin club crea la persona sin club,
como hoy; una fila con sigla inexistente, de club
eliminado o inactivo, o que coincida con más de un club, se rechaza **sin escribir
nada** y el informe dice cuál es el problema (en el caso ambiguo, qué clubes
coinciden); una persona que ya tenía membresía activa en otro club se
rechaza con el mensaje de RB-06; dos filas del mismo archivo con el mismo RUN o
usuario dan un mensaje que señala la fila duplicada; la pantalla describe la
plantilla real (sin la columna «Roles»); la ruta exige los dos permisos.

**Pruebas:** `persons-bulk-import.rules.test.ts` — columna nueva, sigla
inexistente, ambigua, de club inactivo, con distinta capitalización o espacios,
duplicado dentro del archivo ·
`persons-bulk-import.integration.test.ts` — la plantilla trae la columna; una
fila con club deja los tres registros; una fila rechazada no deja nada escrito ·
`spreadsheet-injection.test.ts` — los nombres de club que entran en la plantilla
van neutralizados. Con la etapa 9: una fila sin nombre de usuario crea la
persona sin nombre y sin cuenta; dos filas sin nombre no se marcan como
duplicadas; ninguna fila genera un nombre automático. Fecha por fila (P3):
formato válido e inválido, fecha inexistente, fecha faltante con club
(rechazo), fecha presente sin club (aviso), dos fechas distintas persistidas
tal cual, y una tanda que cruza la medianoche no altera ninguna fecha.

### Cambio 7 — correo del club opcional

**Aceptación:** se crea un club sin correo y queda con `email = null`; se quita
el correo de un club existente enviando vacío; omitir el campo al editar no lo
cambia; un correo mal formado sigue rechazándose; ningún club existente pierde
su correo con la migración; no se genera ningún correo provisional.

**Pruebas:** `clubs.schemas.test.ts` — sin correo, `""`, espacios, formato
inválido · integración — alta sin correo, edición que lo quita, edición que no
lo envía, `CHECK` rechaza `''` por SQL directo ·
`migration-upgrade.integration.test.ts` — una base anterior conserva los
correos · frontend — el formulario guarda sin correo.

### Cambio 8 — nombre de usuario opcional

**Aceptación:**

- personas y clubes se registran sin nombre de usuario y **sin cuenta**; ningún
  camino genera nombres ni credenciales por su cuenta;
- el campo aparece bajo el título exacto «Credenciales de acceso», al crear y al
  editar, y es editable mientras no haya cuenta;
- dos titulares sin nombre conviven sin conflicto; un nombre repetido entre
  personas, clubes o cuentas se rechaza con el mensaje de disponibilidad;
- «Crear credenciales» con el campo vacío no se puede pulsar en la interfaz, y
  por API responde 400 sin escribir nada;
- crear credenciales con un nombre informado deja titular y cuenta con ese
  nombre; después el campo es de solo lectura y la API rechaza cambiarlo;
- un intento fallido —nombre tomado, sin rol de acceso, conflicto concurrente—
  deja el titular exactamente como estaba y editable;
- las cuentas existentes siguen entrando con el mismo nombre; restablecer la
  contraseña no cambia el nombre ni lo desbloquea;
- el preflight no informa duplicados ni reservas faltantes por titulares sin
  nombre.

**Pruebas:** unitarias de esquema — vacío y espacios como ausente, formato,
`null` en edición · `username-identity.integration.test.ts` — alta sin nombre,
sin reserva en `username_reservations`; asignar, cambiar y quitar sin cuenta
(reserva y liberación); rechazo tras crear credenciales, por API y por SQL
directo (disparador); credenciales sin nombre → 400 y nada escrito;
credenciales con nombre → titular y cuenta iguales; fallo por persona sin rol de
acceso y por nombre tomado → titular intacto; concurrencia entre renombrar y
crear credenciales (precedente en `identity-guards-concurrency.integration.test.ts`),
registrando qué mensaje recibe el usuario; restablecer no toca el nombre ·
`preflight-username-collision.integration.test.ts` y
`phase4-guard-validations.integration.test.ts` — sin falsos positivos con
`NULL` · `migration-upgrade.integration.test.ts` — una base anterior conserva
nombres y reservas, y la función nueva ignora `NULL` · frontend — título exacto
en alta y edición, campo editable antes, de solo lectura después del éxito,
editable tras un fallo, botón deshabilitado sin nombre válido
(`PersonFormPage.admin.test.tsx` y una prueba nueva de `ClubFormPage`).

### Cambio 9 — personalidad jurídica sin «pendiente»

**Aceptación:** la comprobación previa se hizo y su resultado se informó antes
de convertir; el respaldo previo existe y fue restaurado; tras la migración
10a no queda ningún `NULL`, **los clubes convertidos no conservan RUT**, el RUT
de los demás clubes y la razón social de todos no cambiaron, ningún RUT aparece
en `audit_logs` ni en el informe, y el `NOT NULL`
(10b) solo se aplica cuando se cumplen sus criterios; los convertidos son
exactamente los que eran `NULL`, cada uno con su fila de auditoría; los clubes
«Tiene» y sus representantes, roles y permisos quedan idénticos; formularios,
filtro y API solo admiten «Sí»/«No»; enviar `null` o `pendiente` responde 400;
al crear un club, la interfaz selecciona «No tiene» (P15) y el servidor exige el
campo explícito;
designar representante sigue exigiendo «Tiene» y uno ya designado sigue
bloqueando el cambio de estado; un cuerpo antiguo (`hasLegalStatus: null`,
filtro `pendiente`) recibe un 400 con el mensaje de recarga, nunca un 500; la
auditoría de la conversión no se presenta ni se usa como reversión automática.

**Pruebas:** `clubs.schemas.test.ts` y `clubs-personalidad-juridica.test.ts` —
pasan a dos estados; `null` rechazado ·
`personalidad-juridica-transiciones.integration.test.ts` y
`legal-representative.integration.test.ts` — transiciones y bloqueo con dos
estados · migración sobre una base sintética con clubes `true`, `false` y
`NULL` (con y sin RUT sintético, con razón social, con representante en un
`true`): convierte solo los `NULL` y les quita el RUT en la misma transacción,
conserva el RUT de los `true`, conserva la razón social de todos, deja
auditoría sin el valor del RUT, no toca `club_staff` ni roles, y **aborta con
detalle** (sin dejar nada a medias) si hay un `NULL` con representante · 10b rechaza
`NULL` y falla con detalle si quedara alguno · petición con el cuerpo antiguo
contra la API nueva · frontend — dos opciones y sin filtro «pendiente».

### Etapas 8, 9 y 10 — transición entre versiones

> **Simplificado (3.ª revisión, R5–R6).** Estos criterios y pruebas de transición
> eran ensayos de conservación y de ventana: **se omiten**. Se mantienen solo las
> pruebas funcionales listadas en «Simplificación por datos prescindibles»
> (migración, `SET NOT NULL` con detalle, rechazo de cuerpos antiguos con 400).

**Aceptación:** el procedimiento está ensayado con escrituras sintéticas solo
en entornos aislados; existe la prueba de lectura del código antiguo con un
`NULL` y su resultado está registrado; la API nueva rechaza con 400, sin
escribir, los cuerpos antiguos incompatibles (comprobación en lugar de
suponer que no quedan pestañas antiguas); las comprobaciones de producción son
solo lecturas y rechazos, cada una con autorización específica, y no crean
registros de prueba; el plan indica explícitamente si se aplica la variante A
(con mecanismo de mantenimiento, validación previa a la apertura) o la B (sin
él, validación con escrituras abiertas); los criterios de apertura y los de
10b se cumplen; la separación 10a/10b se justifica por la reversión; y la
reversión está descrita para cada caso (sin `NULL` creados, con `NULL`
creados, tras la conversión) sin presentar la auditoría como automática.

**Pruebas:** integración en la base desechable — migración que relaja +
escritura de la API antigua sin `NULL` (compatible) · con un `NULL` presente,
lectura de la API antigua (confirma o corrige la tabla de evidencia) ·
`SET NOT NULL` con un `NULL` falla · cuerpos antiguos contra la API nueva
responden 400.

---

## 5. Dudas que requieren una decisión

Separadas, a propósito, de las suposiciones de §6: estas **no** las resuelvo yo.
**No queda ninguna pregunta abierta.** P1 a P15 están resueltas. P3, P4, P5,
P6, P14 y P15 las resolvió el usuario el 2 de noviembre de 2026; donde esas
decisiones dejaron un detalle sin definir, el plan lo marca como *propuesta, no
confirmada* y lo reúne en «Propuestas por confirmar», al final de esta sección.
No son preguntas bloqueantes: son supuestos que se aplican si no se indica lo
contrario.

**P1 — Resuelta: contrato reutilizable de las planillas.**
Está documentado y representado en pruebas sintéticas desde `dcadbc3` (ver §1).
No hace falta abrir el expediente privado ni repetir su validación. Esto acredita
el formato reutilizable, no una nueva comprobación de los resultados históricos.

**P2 — Resuelta: el club se identifica por su sigla (`clubs.code`).** Decisión del
usuario; no se sustituye por `clubs.username`. Queda como tarea de la Etapa 6
comprobar que la sigla es única en los datos y proponer cómo garantizarlo
(hoy no hay índice único ni comprobación de duplicado sobre `clubs.code`); ante
cualquier discrepancia, informe y propuesta, sin corregir datos automáticamente.

**P3 — Resuelta: la fecha efectiva de membresía va POR FILA.** La carga Excel
tiene una columna adicional con la fecha de cada fila y se persiste exactamente
esa fecha. Quedan descartadas las propuestas de una fecha única por archivo y de
un campo en la pantalla. Detalle en la etapa 6.

**P4 — Resuelta: la condición de relevos comienza marcada por defecto.**
Conserva la regla actual en las competencias existentes (`DEFAULT true`).

**P5 — Resuelta: al activar la condición con equipos que la incumplen, se
muestra cuántos equipos están afectados y el administrador puede guardar.** No
se modifica, cancela ni retira a nadie automáticamente. Las validaciones
posteriores de altas, ediciones y cancelación de la última individual se
mantienen coherentes (etapa 5).

**P6 — Resuelta: solo un administrador puede exceder el límite de nadadores por
club y prueba**, con auditoría de autor, club, competencia/prueba, límite y
cantidad resultante. `registrations:write` sin ser administrador no basta
(etapa 4).

**P7 — Resuelta: ocultar es solo visibilidad.** Decisión del usuario: el cambio 6
solo quita la competencia de los desplegables del Panel de Inscripción y del
Panel de Relevos; no restringe accesos directos ni inscripciones. Dato medido en
§1 que debe quedar escrito en la ayuda: una competencia oculta pero abierta sigue
siendo inscribible por API, porque ocultar no es una medida de protección.

**P8 — Resuelta: sin extender la ocultación.** Decisión del usuario: no se aplica
a Reportes ni a los dos asistentes (`/inscripciones/nueva`,
`/inscripciones-relevos/nueva`), que conservan su listado actual.

**P9 — Resuelta: roles de exportación.** Se agrega el botón a los tres roles
nombrados y se conserva el acceso del administrador. *(Actualizada el 4 de
noviembre de 2026: el usuario amplió el pedido y el rol `club` también recibe la
exportación, limitada a su propio club; ver «Definición actualizada» del Cambio 2.)*

**P10 — Resuelta por alcance: solo pruebas individuales.** El enunciado lo
especifica; no se ofrece este campo para relevos.

**P11 — Resuelta: el correo del club es opcional** en pantalla, API e
importación, sin correos provisionales. Los correos existentes se conservan.

**P12 — Resuelta: el nombre de usuario de personas y clubes es opcional al
registrar.** Se muestra editable bajo el título exacto «Credenciales de acceso»
y deja de ser editable solo cuando «Crear credenciales» termina bien. Registrar
y crear la cuenta siguen separados; no se generan nombres ni credenciales
automáticamente.

**P13 — Resuelta, como decisión del usuario sobre datos: «Pendiente de
verificar» desaparece y sus registros pasan a «No tiene».** Convierte un dato
desconocido en una afirmación negativa, contra el criterio con que se creó el
tercer estado el 31 de octubre. Se conservan los «Tiene». Se ejecuta con
comprobación previa, auditoría por club y verificación posterior (etapa 10).

**P14 — Resuelta: al convertir los clubes pendientes a «No tiene» se elimina
también su RUT.** Solo el de esos clubes: no se borra el RUT de clubes en otro
estado, ni la razón social ni otro campo. Conversión y eliminación en la misma
transacción, con respaldo previo, trazabilidad protegida del valor anterior y
verificaciones posteriores (etapa 10). Ni el plan ni los informes publican RUT
reales ni otros datos personales.

**P15 — Resuelta: al crear un club, la opción inicial es «No tiene».** El
servidor conserva una validación coherente con los dos estados admitidos: el
campo es obligatorio y solo admite `true` o `false`.

### Propuestas por confirmar

Detalles que las decisiones anteriores no cubren. Se aplican por omisión, pero
**no están confirmadas** y cada una está identificada donde aparece:

1. **Fecha faltante con club (P3):** exigirla y rechazar la fila, sin usar jamás
   la fecha de hoy en silencio. Si trae fecha sin club, informar la
   inconsistencia. Formato de la columna y reglas adicionales de la fecha
   (futura, anterior al nacimiento): las mismas que la asignación directa.
2. **Recuento de equipos afectados (P5):** entregarlo en el detalle de la
   competencia y en la respuesta del guardado, sin ruta nueva.
3. **Auditoría de la excepción (P6):** nombre propio de la acción, con los datos
   decididos.
4. ~~**Trazabilidad del RUT retirado (P14).**~~ **Resuelta:** el usuario decidió
   no crear tabla; solo auditoría sin el valor y, para recuperarlo, el respaldo
   previo protegido.

---

## 6. Suposiciones recomendadas

Se aplican si no se indica lo contrario.

**S1.** Un solo campo en sentido positivo
(`visibleInRegistrationPanels @default(true)`), casilla «Ocultar…» desmarcada por
omisión y columna «Mostrar en competencia» con el título exacto y valores
`Sí`/`No`. Mismo comportamiento pedido, sin doble negación en la base.

**S2.** El límite del cambio 4 se interpreta **por prueba de competencia**
(`competition_events`), no por prueba maestra del catálogo ni por jornada, y es
**independiente** del `maxSwimmersPerClub` de la competencia.

**S3.** El filtro del cambio 5 se calcula **solo** sobre los puestos del armador
abierto, nunca sobre los equipos confirmados, para no impedir participaciones que
los límites configurados sí permiten.

**S4.** Los tres valores nuevos se **heredan** al duplicar una competencia.

**S5.** Ninguna migración revalida, cancela ni recalcula nada existente, con
una sola excepción decidida por el usuario: la conversión de la etapa 10 (P13).

**S6.** Las tres columnas nuevas no agregan modelos ni endpoints, así que las
cifras publicadas (30 modelos, 116 endpoints) no cambian. Las etapas 8 a 10
tampoco: la etapa 9 agrega un cuerpo opcional a dos rutas que ya existen. Si
alguna etapa agregara una ruta, hay que actualizar `README.md:982` y
`docs/internas/13_Resumen_Final.md:55,57,90` o falla `documentacion.test.ts`.

**S7.** Mientras no haya cuenta, el nombre de usuario guardado también se puede
**quitar** (volver a `NULL`), no solo cambiar: es lo coherente con que sea
opcional, y libera su reserva.

**S8.** El nombre se bloquea si existe **cualquier** cuenta del titular, sea
cual sea su estado (activa, bloqueada o inhabilitada), igual que el disparador
de la base. La comparación de nombres sigue siendo exacta tras recortar
espacios, como hoy; no se introduce comparación sin distinguir mayúsculas.

**S9.** «Crear credenciales» solo existe en la edición: al crear una persona o
un club, la sección «Credenciales de acceso» muestra el campo pero no ofrece
crear la cuenta hasta haber guardado.
