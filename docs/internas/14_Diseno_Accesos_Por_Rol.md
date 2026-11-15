# Diseño: configuración administrativa de accesos por rol

**Estado: opción A, publicada, migrada y desplegada en API y web; entorno local actualizado, dentro del alcance validado** (desde `430c4cb`; registro del despliegue en el README, «Accesos por rol»). *Antecedente:* entre la publicación y el despliegue decía «publicada en el repositorio y validada localmente; pendiente de migración, despliegue y actualización del entorno local». El responsable confirmó la opción A: solo restringir y restituir los accesos actuales. La implementación y sus precisiones están en «Implementación (opción A)», al final. Las secciones de diseño se conservan como base; donde difieran, rige la implementación.

**Alcance.** Una pantalla exclusiva de administración para elegir qué menús y qué acciones de cada menú tienen disponibles tres roles: **Nadador** (`swimmer`), **Delegado** (`delegate`) y **Entrenador** (`coach`). Cada acción se configura por separado de su menú, y el cambio voluntario de contraseña es una función configurable más.

**Decisiones confirmadas:**

- Los accesos **se suman**: una función está permitida si la permite **cualquiera** de los roles efectivos de la persona.
- **Administración siempre tiene acceso completo**, aunque tenga otros roles y aunque sus casillas estén desmarcadas.
- La **cuenta de club** y el **representante legal** quedan fuera de los roles configurables.

## Decisión (resuelta: opción A)

*Antecedente:* la pregunta pendiente era si la pantalla podría **conceder** funciones que hoy esos roles no tienen, o solo **restringir y restituir** sus accesos actuales. El responsable confirmó **A**.

| | A. Solo restringir y restituir | B. También conceder |
|---|---|---|
| Techo | La matriz actual del código (`rbac.definitions.ts`) es el máximo. La configuración solo apaga y vuelve a encender | Cualquier función del catálogo |
| Riesgo | Ninguna ampliación de atribuciones: lo peor que puede pasar es que un rol vea menos | Cada función concedible necesita una revisión propia de alcance de datos (por ejemplo, un nadador con «Exportar a Team Manager» vería el club entero) |
| Trabajo | Una guarda adicional por ruta | Además, reglas de alcance nuevas por función y por rol |

La confirmación del acceso administrativo **no** autoriza ampliar las atribuciones de los demás roles. Se implementó **A**. **B** solo se agregaría función por función, cada una con su propia revisión y una autorización expresa.

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

## Implementación (opción A)

**Estado:** implementada y validada en local el 2026-11-14, sobre `c230000`; publicada en `430c4cb`; **publicada, migrada y desplegada en API y web; entorno local actualizado, dentro del alcance validado.** La migración `20261115000000_accesos_por_rol` se aplicó sin seed en producción y en la base local de trabajo; la configuración inicial quedó sin restricciones. No hubo validación funcional autenticada en producción. *Antecedentes:* hasta la publicación decía «No está publicada ni desplegada»; entre la publicación y el despliegue, «publicada en el repositorio y validada localmente, pendiente de migración, despliegue y actualización del entorno local», con producción sin la migración ni las guardas.

### Catálogo y correspondencia con rutas

El catálogo vive en `backend/src/modules/accesos/catalogo.ts` y es la única fuente de verdad.

**Leyenda de «Aplica a»:**
- **N** = nadador, **D/E** = delegado y entrenador (configurables);
- **C/RL** = cuenta de club y representante legal: suman en la evaluación pero **no** se configuran.

Cada guarda de función se agrega **además** del permiso de la ruta.

| Función (id estable) | Menú | Rutas HTTP | Permiso que ya exigía la ruta | Aplica a |
|---|---|---|---|---|
| `menu.inscripciones` | — | `GET /competitions/:id/enabled-events`¹, `GET /registrations/club-swimmers`¹, `GET /registrations/club-eligibility-matrix`, `GET /registrations/available-events`, `GET /registrations/eligible-swimmers`, `GET /registrations?status=confirmed` | `registrations:read` | N, D/E, C/RL |
| `inscripciones.crear` | Inscripciones | `POST /registrations` | `registrations:write` | N, D/E, C/RL |
| `inscripciones.editar_tiempo` | Inscripciones | `PUT /registrations/:id` | `registrations:write` | N, D/E, C/RL |
| `inscripciones.cancelar` | Inscripciones | `POST /registrations/:id/cancel` (también «Deshacer») | `registrations:write` | N, D/E, C/RL |
| `inscripciones.historial` | Inscripciones | `GET /registrations` con `status=cancelled` o sin estado | `registrations:read` | N, D/E, C/RL |
| `menu.relevos` | — | `GET /competitions/:id/enabled-events`¹, `GET /registrations/club-swimmers`¹, `GET /relay-registrations?status=confirmed` | `registrations:read` | N, D/E, C/RL |
| `relevos.armar` | Relevos | `POST /relay-registrations` | `registrations:write` | D/E, C/RL (N: no aplica, invariante del alcance) |
| `relevos.editar` | Relevos | `PUT /relay-registrations/:id` | `registrations:write` | D/E, C/RL |
| `relevos.cancelar` | Relevos | `POST /relay-registrations/:id/cancel` | `registrations:write` | D/E, C/RL |
| `relevos.historial` | Relevos | `GET /relay-registrations` con `status=cancelled` o sin estado | `registrations:read` | N, D/E, C/RL |
| `menu.reportes` | — | sin rutas propias: sus lecturas de apoyo son compartidas por todas las pantallas | — | N, D/E, C/RL |
| `reportes.generar` | Reportes | `GET /reports/registrations` | `reports:read` | N, D/E, C/RL |
| `reportes.exportar` | Reportes | `GET /reports/registrations/export` (CSV, XLSX, PDF) | `reports:read` | N, D/E, C/RL |
| `menu.incorporaciones` | — | sin rutas propias | — | D/E, C/RL |
| `incorporaciones.postular` | Incorporaciones | `POST /swimmer-assignments`, `GET …/cuota`², `GET …/periodos-cambio/vigente`² | `swimmer-assignment:write` | D/E, C/RL |
| `incorporaciones.completar_alta` | Incorporaciones | `POST /swimmer-assignments/altas` | `swimmer-assignment:write` | D/E, C/RL |
| `incorporaciones.listados` | Incorporaciones | `GET /swimmer-assignments`, `GET /swimmer-assignments/:id`, `GET …/altas`, `GET …/altas/:id`, `GET …/cuota`², `GET …/periodos-cambio/vigente`² | `swimmer-assignment:read` / `:write` | D/E, C/RL |
| `cuenta.cambio_voluntario_contrasena` | — | `POST /auth/change-password`, solo **sin** cambio obligatorio pendiente | sesión propia | N, D/E, C/RL |

**Rutas compartidas.**
- ¹ La sirven Inscripciones y Relevos.
- ² La sirven postular y los listados.

Basta que **una** de las funciones esté permitida, de modo que apagar un menú no rompe otro que sigue encendido. Los asistentes `/inscripciones/nueva` y `/inscripciones-relevos/nueva` usan estas mismas rutas, así que quedan cubiertos. En la interfaz, su ruta exige además el menú y la acción de crear o armar.

**Fuera del catálogo:**
- **Team Manager.** Se muestra en la pantalla como «No configurable: conserva sus permisos actuales». Sus rutas (`/export/team-manager/zip` y `/hy3`) no llevan guarda de función: ocultar Reportes no revoca el acceso directo al exportador.
- **Lecturas compartidas por todas las pantallas** (competencias, catálogos, capacidad, club vigente) y el **inicio**.
- `POST /swimmer-assignments/:id/end`, que no es un menú del personal (ver «Observaciones del inventario»).

### Precisiones respecto del diseño

- **«No aplica» en la evaluación.** Si **ningún** rol efectivo de la cuenta tiene la función dentro de su techo, la guarda **no decide**: siguen mandando el permiso, las guardas de rol y el alcance. Así, sin restricciones el comportamiento es exactamente el anterior, y la configuración nunca concede: por ejemplo, un nadador sigue recibiendo 403 `FORBIDDEN` del servicio al armar un relevo.
- **Sin consulta cuando no hace falta.** Administración y las cuentas sin roles configurables aplicables no leen la configuración.
- **Persistencia.**
  - Solo se guardan las celdas **apagadas**; restituir borra la fila.
  - La migración crea la fila de versión (`id = 1`, versión 0) y **ninguna** restricción.
  - El guardado envía el estado **completo**, que se valida contra las celdas configurables: rechaza roles, funciones o combinaciones fuera del catálogo y los huecos. Bloquea la fila de versión (`FOR UPDATE`), compara la versión y, si no hay diferencias, no sube la versión ni audita.
- **Caché por versión.** Cada solicitud protegida lee la fila de versión; si cambió, versión y filas se leen **juntas** en una transacción `REPEATABLE READ`. Una lectura lenta no reemplaza una copia más nueva.
- **Fallos.** Si no se puede leer, responde 503 `CONFIGURACION_ACCESOS_NO_DISPONIBLE` y nunca concede. Ni ese 503 ni el 403 `FUNCION_DESHABILITADA` cierran la sesión.
- **Cambio de contraseña.** Con el cambio obligatorio pendiente, la comprobación ni siquiera lee la configuración. La denegación del voluntario ocurre antes del servicio, así que no cuenta como intento fallido (C-04).
- **Interfaz.**
  - `AccesosProvider` pide `GET /auth/accesos` al iniciar o restaurar la sesión y en cada renovación (cambia el token), y otra vez al recibir `FUNCION_DESHABILITADA`. Con el cambio obligatorio pendiente no lo pide.
  - Descarta las respuestas de otra cuenta, de otra sesión o de una versión anterior.
  - Si la carga falla, no oculta nada adicional (decide el servidor) y conserva lo último sabido de la misma cuenta.
  - Oculta los menús, el botón «Cambiar contraseña» y los controles de cada acción.
  - Protege las rutas, incluidas las de URL directa, con un aviso.
  - Las descargas CSV, XLSX y PDF no se tocaron: Reportes avisa de la denegación desde la propia pantalla.
- **Pantalla.**
  - `/administracion/accesos`, con guardia `admin` en la interfaz y `requireRole("admin")` en la API.
  - Matriz con casillas de nombre accesible («Delegado — Reportes: Exportar CSV, Excel o PDF») y «No aplica».
  - Un menú apagado desactiva y atenúa sus acciones sin borrar sus casillas.
  - Restablecer por rol, cancelar y un resumen antes de guardar.
  - Muestra la última modificación (fecha y autor).
  - Ante un 409, muestra los cambios de la otra persona y conserva lo marcado.

**Sesiones abiertas.** El servidor aplica la configuración vigente desde la siguiente solicitud, también con tokens ya emitidos y por llamada directa. La interfaz puede mostrar un control apagado hasta la siguiente renovación (programada cada 12 minutos; es el intervalo previsto, no un plazo garantizado), hasta recibir una denegación o hasta recargar la página. Ese retraso es solo de presentación. Las funciones cargadas pertenecen al **contexto de autorización** (cuenta, roles efectivos y club), no solo a la cuenta: si los roles cambian, lo cargado se descarta y una respuesta tardía del contexto anterior se ignora. Administración tiene prioridad también en la interfaz. Un editor abierto cuya acción se apaga se cierra en el mismo dibujo y avisa: si no había enviado nada, que se cerró sin enviar cambios; si el guardado ya estaba en curso, sin afirmar que no se guardó, porque el servidor puede confirmarlo y su respuesta se informa como siempre.

### Validación local

Resultados reales en el README, «Accesos por rol»: unitarias del backend, integración sobre la base desechable (incluida la migración), pruebas de la interfaz con jsdom y revisión visual con capturas a 1280 px y 375 px efectivos, con API simulada y datos sintéticos.

**Validación final conjunta** de la entrega (accesos y correcciones de tiempos), cada suite una vez y por separado:
- Frontend, suite completa: 76 archivos, 1267 de 1267 pruebas aprobadas.
- Backend, integración completa sobre la base desechable: 69 archivos, 1487 de 1487 pruebas aprobadas; las 42 migraciones se aplicaron solo en esa base.
- 13 avisos `DEP0190` de Node, del código de pruebas existente; no afectan el resultado.

**Despliegue** (detalle en el README, «Accesos por rol»):
- CI del código `43630543032` en éxito, con integración.
- Exportación previa de la base en Render, completada; sin descarga ni restauración probada.
- Mantenimiento construido en `430c4cb`; tres ejecuciones identificadas por sus filas (`status`, `deploy`, `status`) aplicaron únicamente `20261115000000_accesos_por_rol`, sin seed. *Docker Command* vacío al terminar, programación conservada y Auto-Deploy Off.
- API y web Live en `430c4cb`. Sin credenciales: `/api/health` y `/api/ready` con 200, las rutas nuevas con 401 y un muestreo de 112 respuestas 200 de 112 (máximo 0,88 s; intervalos entre muestras no observados).
- Entorno local con imágenes candidatas del mismo SHA, la migración aplicada sin seed, configuración inicial en versión 0 y sin restricciones, PostgreSQL y su volumen conservados, y servicios detenidos al terminar.

**Limitaciones.**
- No hubo prueba con sesión real contra la API real en un navegador, ni validación funcional autenticada en producción.
- No se probó en Safari.
- Los respaldos de esta entrega no tienen restauración probada.
- El retraso de presentación descrito arriba.
