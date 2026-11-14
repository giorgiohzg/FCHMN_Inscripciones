# Diseño: configuración administrativa de accesos por rol

**Estado: diseño, sin implementar.** Falta una decisión del responsable (ver «Decisión pendiente»). Nada de esto cambia el comportamiento actual.

**Alcance.** Una pantalla exclusiva de administración para elegir qué menús y qué acciones de cada menú tienen disponibles tres roles: **Nadador** (`swimmer`), **Delegado** (`delegate`) y **Entrenador** (`coach`). Cada acción se configura por separado de su menú, y el cambio voluntario de contraseña es una función configurable más.

**Decisiones confirmadas:**

- Los accesos **se suman**: una función está permitida si la permite **cualquiera** de los roles efectivos de la persona.
- **Administración siempre tiene acceso completo**, aunque tenga otros roles y aunque sus casillas estén desmarcadas.
- La **cuenta de club** y el **representante legal** quedan fuera de los roles configurables.

## Decisión pendiente

¿La pantalla podrá **conceder** funciones que hoy esos roles no tienen, o solo **restringir y restituir** sus accesos actuales?

| | A. Solo restringir y restituir | B. También conceder |
|---|---|---|
| Techo | La matriz actual del código (`rbac.definitions.ts`) es el máximo. La configuración solo apaga y vuelve a encender | Cualquier función del catálogo |
| Riesgo | Ninguna ampliación de atribuciones: lo peor que puede pasar es que un rol vea menos | Cada función concedible necesita una revisión propia de alcance de datos (por ejemplo, un nadador con «Exportar a Team Manager» vería el club entero) |
| Trabajo | Una guarda adicional por ruta | Además, reglas de alcance nuevas por función y por rol |

La confirmación del acceso administrativo **no** autoriza ampliar las atribuciones de los demás roles. Mientras no se decida, el diseño se limita a **A**. **B** solo se agregaría función por función, cada una con su propia revisión.

## Inventario real

Verificado en el código al 2026-11-13, sobre `721f1cf`. Las referencias son a archivos del repositorio.

### Permisos de cada rol

Los permisos son la unión de los de todos los roles de la cuenta. Las tablas `roles`, `permissions`, `role_permissions` y `user_roles` mandan en ejecución; el seed las crea a partir de `rbac.definitions.ts` y **no borra** filas.

| Permiso | Nadador | Delegado / Entrenador (y representante legal) |
|---|:-:|:-:|
| `catalogs:read`, `competitions:read` | ✔ | ✔ |
| `registrations:read`, `registrations:write` | ✔ | ✔ |
| `reports:read` | ✔ | ✔ |
| `swimmer-assignment:read` | ✔ | ✔ |
| `swimmer-assignment:write` | – | ✔ |
| `clubs:read` | – | ✔ |
| `export:team-manager` | – | ✔ |
| Escritura de personas, clubes, competencias y catálogos; aprobación; post-cierre; auditoría | – | – |

### Reglas que no son permisos

Ninguna tabla rol→permiso puede configurar estas reglas, y el diseño las conserva intactas:

- **Rutas reservadas al rol `admin` en el código** (`requireRole("admin")`): por ejemplo `uncancel`, `admin-access`, `/dashboard/stats`, los reportes por club y la competencia predeterminada.
- **Alcance**, en `shared/actorContext.ts`:
  - Un nadador solo opera sobre sí mismo y no arma relevos: el servicio responde 403 al alcance `swimmer`.
  - El personal opera solo sobre el plantel activo de su club.
  - La postulación por RUN exige alcance de club, más la cuota y los periodos.
- **Reducción de roles** (`modules/auth/authorization.ts`, `ROLES_DE_PERSONAL`): si el club del nombramiento no está activo o está eliminado, se quitan `delegate`, `coach` y `legal_representative` en cada solicitud, sin tocar `user_roles`.
- **Cambio obligatorio de contraseña**: mientras rige, `requireAuth` responde 403 `PASSWORD_CHANGE_REQUIRED` a todo, salvo `/auth/me` y `/auth/change-password`.

### Menús, rutas y acciones

Menús de `shared/AppShell.tsx` y rutas de `App.tsx`. Leyenda: **N** = nadador, **D/E** = delegado y entrenador.

| Menú (ruta) | N | D/E | Acciones y endpoints |
|---|:-:|:-:|---|
| Inicio (`/dashboard`) | ✔ | ✔ | Solo bienvenida para quien no administra |
| Inscripciones (`/inscripciones`) | ✔ (sobre sí) | ✔ (su club) | Inscribir (`POST /registrations`), editar el tiempo (`PUT /registrations/:id`), cancelar y deshacer (`POST /registrations/:id/cancel`), ver el historial (`GET /registrations`) |
| Inscripciones de Relevo (`/inscripciones-relevos`) | ✔ (solo lectura) | ✔ | Armar un equipo (`POST /relay-registrations`), editarlo (`PUT /relay-registrations/:id`), cancelarlo (`POST …/:id/cancel`), ver el historial |
| Reportes (`/reportes`) | ✔ | ✔ | Generar (`GET /reports/registrations`); exportar CSV, Excel o PDF (`GET /reports/registrations/export`); exportar a Team Manager (`GET /export/team-manager/zip`, solo D/E) |
| Incorporaciones (`/incorporaciones`) | – | ✔ | Postular por RUN (`POST /swimmer-assignments`), completar el segundo paso (`POST /swimmer-assignments/altas`), ver listados, cuota y periodo vigente |
| Asistentes (`/inscripciones/nueva`, `/inscripciones-relevos/nueva`) | ✔ | ✔ | Sin enlace en la interfaz: solo se llega por URL. Usan los mismos endpoints de los paneles |
| Cabecera | ✔ | ✔ | «Cambiar contraseña» (`/cambiar-password` → `POST /auth/change-password`) y «Cerrar sesión» (`POST /auth/logout`) |
| Personas, Clubes, Asignación de Nadadores, Catálogos, Competencias, Auditoría | – | – | Solo administración |

### Sesión

- **Servidor:** en cada solicitud verifica la sesión y vuelve a leer roles, permisos y club desde la base (`rbac.middleware.ts`). Un cambio en la base rige desde la solicitud siguiente.
- **Interfaz:** toma roles y permisos del token de acceso, que dura 15 minutos y se renueva cada 12. Sus menús pueden quedar atrasados hasta una renovación.

## Diseño (opción A)

### 1. Catálogo de funciones

Es una lista **fija en el código**, con identificadores estables. Cada función declara:

- su menú, si es una acción;
- los **permisos o guardas** que la protegen en el servidor;
- en qué roles **aplica**, que son el techo actual.

| Menú | Acciones configurables | Aplica a |
|---|---|---|
| `menu.inscripciones` | `inscripciones.crear`, `inscripciones.editar_tiempo`, `inscripciones.cancelar`, `inscripciones.historial` | N, D, E |
| `menu.relevos` | `relevos.armar`, `relevos.editar`, `relevos.cancelar`, `relevos.historial` | Ver: N, D, E. Escribir: D, E (para N «no aplica»: invariante del alcance) |
| `menu.reportes` | `reportes.generar`, `reportes.exportar`, `reportes.team_manager` | N, D, E (Team Manager: D, E) |
| `menu.incorporaciones` | `incorporaciones.postular`, `incorporaciones.completar_alta`, `incorporaciones.listados` | D, E |
| Cuenta | `cuenta.cambio_voluntario_contrasena` | N, D, E |

**Fuera del catálogo, siempre disponibles:**

- cerrar sesión;
- el cambio **obligatorio** de contraseña;
- `/auth/me`, `/auth/refresh` y el inicio.

**Regla jerárquica:** una acción solo rige si su menú está habilitado. Apagar un menú apaga sus acciones sin perder sus casillas.

### 2. Persistencia y auditoría

- **Tablas.** `accesos_por_rol (rol, funcion, habilitada, actualizado_por, actualizado_en)`, con clave única `(rol, funcion)` y un CHECK que limite `rol` a los tres configurables. `configuracion_accesos (id = 1, version, actualizado_por, actualizado_en)` es la fila única de versión.
- **Sin filas = comportamiento actual.** La migración no crea filas, así que desplegarla no cambia nada.
- **Restituir** borra la fila o la pone en `true`; en ningún caso puede superar el techo del código.
- **Auditoría.** `ROLE_ACCESS_UPDATED` va en la misma transacción. Registra la versión anterior y la nueva y, como `before` y `after`, solo las casillas que cambiaron.

### 3. Aplicación en el servidor

Ocultar botones no basta: la protección está en el servidor.

- **Guarda nueva.** `requireFuncion("reportes.exportar")` se agrega a cada ruta del catálogo **además** de su `requirePermission`, nunca en su lugar. Así, un error en la configuración no puede ampliar nada.
- **Evaluación.** Se hace después de `resolverAutorizacionEfectiva`:
  - administración → siempre permitida;
  - en otro caso → permitida si **algún** rol efectivo de la cuenta la permite:
    - si el rol es configurable (N, D o E): debe cumplir a la vez el techo del código, el menú habilitado y la acción habilitada;
    - si es otro rol (club o representante legal): rige su matriz del código, sin configuración.
  - Como la reducción por club no operativo ya quitó los roles de personal, esos roles no suman.
  - El alcance por club y por persona no cambia: lo siguen comprobando los servicios.
- **Sesiones abiertas y llamadas directas.** La configuración se lee en **cada solicitud**. Se lee una sola fila de versión y, si cambió, se vuelve a cargar la tabla, que es pequeña, y se guarda en memoria **por versión**. El cambio rige desde la solicitud siguiente, también con tokens ya emitidos y por llamada directa a la API. Si una función está deshabilitada, el servidor responde 403 con el código estable `FUNCION_DESHABILITADA`.

### 4. Interfaz

- **Funciones efectivas.** `GET /auth/accesos` devuelve las funciones efectivas de la sesión. Se pide al entrar, al renovar y al recibir un 403 `FUNCION_DESHABILITADA`, que además oculta el control. `AppShell` y las pantallas deciden con esa lista; el retraso posible es solo de presentación.
- **Cambio de contraseña.**
  - Si `cuenta.cambio_voluntario_contrasena` está deshabilitada, se oculta el botón «Cambiar contraseña».
  - `/auth/change-password` responde 403 **solo si la sesión no tiene el cambio obligatorio**. Con el obligatorio, la ruta sigue permitida y todo lo demás sigue bloqueado como hoy, así que la configuración no permite eludirlo.

### 5. Pantalla de administración

- **Acceso.** Ruta `/administracion/accesos`: guardia `admin` en la interfaz, `requireRole("admin")` en la API y un menú propio.
- **Matriz.**
  - Filas: menús, con sus acciones anidadas.
  - Columnas: Nadador, Delegado y Entrenador.
  - Casillas con nombre accesible («Delegado — Exportar a Team Manager»).
  - Las celdas fuera del techo se muestran como **«No aplica»**, sin casilla.
  - Una acción con su menú apagado se ve atenuada y explicada.
- **Ayudas.** «Restablecer valores del sistema» por rol. Un resumen de cambios antes de guardar. Cuándo y quién hizo la última modificación.
- Administración no aparece como columna: su acceso es completo.

### 6. Cambios simultáneos de dos administraciones

- Cada lectura trae `version`, y cada guardado la envía. En la transacción, `UPDATE configuracion_accesos SET version = version + 1 WHERE id = 1 AND version = $esperada`: si no actualiza ninguna fila, responde 409 `CONFIGURACION_CAMBIADA` con el estado vigente.
- La pantalla recarga, muestra qué cambió la otra persona y conserva lo que se estaba marcando para volver a revisarlo, sin reintentos automáticos.

### 7. Pruebas previstas

- **Servidor.**
  - Matriz por rol y combinación de roles (suma).
  - Administración con casillas desmarcadas.
  - Llamada directa con la función deshabilitada (403) y sesión abierta antes del cambio.
  - Club no operativo (la reducción sigue).
  - Alcance intacto.
  - Cambio obligatorio frente a voluntario deshabilitado.
  - Concurrencia de versiones (409).
  - Auditoría en la transacción.
  - Migración sin filas = sin cambios.
- **Interfaz.**
  - Menús y botones según las funciones efectivas.
  - Reacción a `FUNCION_DESHABILITADA`.
  - Conflicto 409.
  - Accesibilidad de la matriz.

## Observaciones del inventario

**No es un hallazgo nuevo:** `GET /competitions/:id/capacity` entrega a un **nadador** el desglose `byClub` de todos los clubes. Es **AUD-06**, que **se conserva por decisión expresa del usuario** (ver `docs/seguridad/PLAN_SEGURIDAD.md`, «Privacidad de reportes y relevos»). No se corrige en esta tarea. Si la pantalla de accesos llegara a tocar Reportes, debe mantener esa decisión salvo que se revise expresamente.

**Fuera de este alcance**, se informan y no se corrigieron:

1. El personal de club puede dar de baja membresías de su club por la API (`POST /swimmer-assignments/:id/end`), aunque su interfaz no ofrece ese botón.
2. Los asistentes `/inscripciones/nueva` y `/inscripciones-relevos/nueva` no tienen enlace: solo se llega por URL.
