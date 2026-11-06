# Plan de seguridad

Plan consolidado de los hallazgos de seguridad pendientes, en cuatro fases más SEC-01 a SEC-03, con su estado
de avance. Los hallazgos son de **revisión estática** del código, salvo donde se indica una
observación de producción ya disponible: ninguno de los intercalados se ha reproducido en
producción. Este documento no autoriza ninguna operación sobre producción.

## Estado de avance

| Fase | Contenido | Estado |
|---|---|---|
| **A1** | Cliente: un 401 o una renovación atrasados no cierran ni reutilizan una sesión posterior | **Cerrada y desplegada** en la web |
| **1** | Sesiones y revocación efectiva del JWT | **En producción desde el 2026-11-05** (`b920893`): migración aplicada y API desplegada, con el corte de sesiones ejecutado. La CI de `b920893` pasó completa, integraciones incluidas. Ver «Puesta en producción» |
| **2** | `Cache-Control: no-store`, filtrado de excepciones, login uniforme | **API desplegada en producción el 2026-11-05 (`6d2dae5`)**; la CI pasó completa. Salud y cabeceras observadas; funcionalidades sin comprobar en producción. Ver «Fase 2» |
| **3** | Cabeceras del frontend (Nginx) | **Cerrada**: desplegada en `fchmn-web` desde `1641004` (Live, Auto-Deploy Off) y validada en local (imagen real y navegador real con una API simulada). Ver «Fase 3» |
| **4** | Límites del procesamiento XLSX | **Cerrada** dentro de su alcance: desplegada en `fchmn-api` desde `4317e0f` (Live, Auto-Deploy Off) y validada en local con datos sintéticos. Ver «Fase 4» |
| **SEC-02** | Ningún reporte entrega el RUN, para ningún rol | **Cerrada** dentro de su alcance: desplegada en web y API desde `3cf1aaf` (Live, Auto-Deploy Off). Ver «SEC-02» |
| CI de SEC-02 | Pánico intermitente del motor de Prisma en las pruebas unitarias (ejecución 42269659668) | **Diagnosticado; protección publicada en el repositorio y validada en local.** La causa del pánico **no está demostrada**. Ver «CI de SEC-02» |
| **SEC-01** | Topes para las listas JSON (`personIds` de relevos y otras) | **Cerrada** dentro de su alcance: desplegada en `fchmn-api` desde `120e29d` (Live, Auto-Deploy Off) y validada en local y en la CI con datos sintéticos. Ver «SEC-01» |
| **SEC-03** | Dependencias | **Revisada, sin cambios.** Ver «SEC-01 y SEC-03» |
| Vite 5.4.21 | Avisos en una dependencia de desarrollo | **Aplazado, fuera de estas fases.** Ver «Vite» |

**«Validada localmente» significa:** la suite de integración completa y la unitaria se
ejecutaron una vez sobre la implementación, con dos fallos de expectativas desactualizadas
(un 403 que ahora es 401 y un total de modelos de Prisma en la documentación), que se
corrigieron. Después **solo se repitieron partes**: las tres pruebas de integración de
sesiones y administración, las dos unitarias afectadas, el typecheck y el lint. Las suites
completas no se repitieron tras las correcciones. La suite de integración corrió solo sobre
la base desechable de `docker-compose.test.yml`, con datos sintéticos.

**La CI de `4311a67` falló** en «Pruebas unitarias» de Backend, con tres casos de
`orden-determinista.test.ts`: `persons.service` y `clubs.service` importan ahora
`auth/sessions`, que lee `shared/env` al importarse y exige la configuración completa de
autenticación. Esa prueba solo pasaba donde hubiera un `backend/.env` (`@prisma/client` lo
carga solo), que la CI no tiene. La corrección aísla la prueba con un doble del módulo de
sesiones, sin tocar la validación del entorno, y se publicó en `b920893`. La CI de ese commit
(ejecución 42102251640) pasó completa, con las pruebas unitarias, las migraciones y las
integraciones de la Fase 1.

### Puesta en producción (2026-11-05)

Commit desplegado: `b9208932f26e17b7eb56e6beba084f977857e65c`. Solo lo usaba su titular.

| Paso | Resultado |
|---|---|
| Historial previo | 36 migraciones aplicadas y terminadas, ninguna revertida ni inconclusa; solo faltaba `20261106000000_refresh_sessions` |
| Respaldo | Exportación nueva de la base, descargada fuera del repositorio. Se descomprimió sin errores y su catálogo se leyó con `pg_restore --list` (herramienta de versión mayor igual o superior a la del archivo): 31 tablas con datos. **No fue una restauración completa** |
| `fchmn-mantenimiento` | Despliegue manual de `b920893`, con Docker Command vacío; no se ejecutó nada sobre la base |
| Migración | `prisma migrate deploy` una sola vez: «37 migrations found», se aplicó únicamente `20261106000000_refresh_sessions` y la ejecución terminó correctamente. Docker Command quedó vacío y se comprobó tras recargar |
| `fchmn-api` | Despliegue manual de `b920893`: *Deploy succeeded* y *Live*. **Aquí ocurrió el corte de sesiones** |
| Salud | Por el proxy de la web, `/` respondió 200 y `/api/ready` respondió 200 con `{"status":"ready","database":"ok"}` |

Auto-Deploy sigue desactivado en los tres servicios, la programación del mantenimiento no
cambió y `fchmn-web` no se desplegó (sigue en `4e6300d`).

**Lo que no se comprobó:** las consultas de solo lectura posteriores al corte de
[../operacion/corte-de-sesiones.md](../operacion/corte-de-sesiones.md) (sesiones creadas,
tokens sin sesión, invariante de revocación), la prueba con una cuenta propia (iniciar y
cerrar sesión, y un refresco posterior) y la confirmación por consulta de que la migración
figura terminada en `_prisma_migrations`: la salida de `migrate deploy` es la única
evidencia de que se aplicó. La salud comprobada es la de arranque y conexión a la base, no
la del flujo de autenticación.

## Decisiones aprobadas

1. **Duración absoluta de 8 horas** desde la creación de la sesión, configurable con
   `SESSION_ABSOLUTE_HOURS` (8 por omisión). Renovar no la extiende, y cada refresh token
   vence en el mínimo entre su plazo habitual y ese límite.
2. **Transición mediante corte anunciado, ejecutado el 2026-11-05 al desplegar la API.** La API nueva rechaza los
   JWT sin `sid` y los refresh tokens sin sesión, sin cascadas de revocación. No hay
   backfill, adopción de tokens históricos, purga, `NOT NULL` ni modos temporales.
3. **Reutilización de un refresh token consumido:** si pertenece a una sesión todavía activa,
   se termina **únicamente esa sesión** y se conservan las demás. Un token rotado de una
   sesión ya terminada es un 401 sin efectos: una cookie antigua no cierra sesiones nuevas.

## Fuera de la Fase 1

Sin decidir y sin implementar. Cada uno necesita autorización expresa:

- **S10:** el bloqueo temporal por intentos fallidos rechaza hoy las peticiones de la cuenta
  mientras dura, sin terminar sus sesiones. Se conserva tal cual.
- **Cierre por inactividad humana.** Se recomienda como mejora posterior, a los 30 minutos.
  La renovación proactiva del frontend es un temporizador y no prueba actividad humana.
- **Purga y retención** de tokens y sesiones.
- **Revocar la cookie anterior al iniciar sesión**, que exigiría CSRF en el login.

## Fase 1: sesiones

### Hallazgos

| ID | Hallazgo | Estado |
|---|---|---|
| S1 | El JWT sobrevive a logout y cambio de contraseña durante su vigencia restante (15 minutos por defecto; el esquema admite más y el valor efectivo de producción no se ha comprobado) | Implementado |
| S2 | Logout con token ya rotado dejaba vivo a su sucesor | Implementado |
| S3 | Carreras entre login, refresh, logout, cambio de contraseña y revocaciones administrativas | Implementado y probado con intercalados reales |
| S4 | Cambios de contraseña concurrentes se pisaban | Implementado |
| S5 | Reactivar una cuenta dejaba operativos los JWT vigentes | Implementado |
| S6 | Sin duración absoluta | Implementado (8 horas). Purga fuera de la fase |
| S7 | Una cookie antigua provocaba revocaciones en cascada | Implementado |
| S8 | La rotación se confirmaba antes de resolver la autorización | Implementado |
| S9 | `refresh` no evaluaba el estado de la persona | Implementado |
| S11 | Un intento fallido sobrescribía un bloqueo administrativo, una inhabilitación o un cambio de credenciales posteriores; la reactivación de un bloqueo temporal vencido hacía lo mismo | Implementado |

### Diseño

- **Identidad.** Cada login o cambio de contraseña crea una sesión (`refresh_sessions`). La
  rotación del refresh la conserva. El JWT lleva su `sid`, y cada petición autenticada
  comprueba que la sesión exista, sea del mismo usuario, no esté revocada ni vencida. No hay
  caché: la revocación tiene efecto inmediato.
- **Migración.** Solo aditiva: la tabla nueva y `refresh_tokens.session_id` nulable. Una tabla
  y no solo una columna, porque hacen falta una fila bloqueable antes de insertar el token
  siguiente y un objetivo para terminar **una** sesión sin tocar las demás. La API anterior
  sigue funcionando con la migración aplicada.
- **Invariante.** Terminar una sesión revoca sus tokens en la misma transacción, de modo que
  incluso la API anterior la respeta.
- **Clasificación de un refresh token, bajo bloqueo.** Primero el estado de la sesión y
  después el token. `replaced_by` por sí solo no basta, porque un token rotado puede
  pertenecer a una familia que terminó legítimamente.

  | Estado | Resultado |
  |---|---|
  | Token desconocido o sin sesión | 401, sin efectos |
  | Sesión terminada o vencida | 401, sin efectos, aunque el token tenga `replaced_by` |
  | Sesión activa, token ya rotado | Reuso: termina solo esa sesión y se audita |
  | Sesión activa, token vigente | Rota |

- **Orden de bloqueos.** `persons`/`clubs` (solo operaciones administrativas) → `users`
  (`FOR NO KEY UPDATE`) → `refresh_sessions` → `refresh_tokens`. Nada que tenga `users`
  vuelve a bloquear `persons` o `clubs`. `FOR NO KEY UPDATE` y no `FOR UPDATE`, para no
  chocar con los bloqueos de las claves foráneas.
- **Credenciales.** Argon2 se ejecuta fuera de los bloqueos. Bajo bloqueo se revalida el hash
  leído antes (H0), el estado de la cuenta y el de la persona. Una credencial sustituida no
  emite sesión ni suma un intento fallido, y los estados administrativos prevalecen.
- **Autorización antes de consumir.** Roles, permisos y club se resuelven antes de la
  transacción de refresh. Si fallan, el token no se consume.
- **Denegaciones.** La transacción confirma y el error se lanza después, para no revertir una
  revocación por reuso ni su auditoría.

### Aislamiento de las transacciones

No todas son `READ COMMITTED`:

- **Sesión** (login, refresh, logout, cambio de contraseña e intento fallido):
  `READ COMMITTED`, con `maxWait` de 5 s y `timeout` de 10 s. Es necesario: tras esperar el
  bloqueo de `users`, cada sentencia debe ver lo que confirmó quien lo tenía.
- **Operaciones administrativas sobre personas** (bloquear, inhabilitar, eliminar y
  conceder o retirar el acceso administrativo): conservan **`Serializable`**. Es una excepción justificada: la guarda del último
  administrador lo exige, porque sin él dos operaciones simultáneas sobre los dos últimos
  administradores pasarían ambas.
- **Consecuencia, un conflicto reintentable.** Esas operaciones leen su instantánea antes de
  que un refresh concurrente consuma un token, y PostgreSQL aborta la transacción
  (`P2034`). La API lo traduce a un 409 («vuelva a intentarlo»). Falla cerrada: no se aplica
  nada, y reintentar la completa. Lo que no puede ocurrir es una operación confirmada con un
  token vivo. Se comprobó a nivel de servicio; la traducción a 409 no se comprobó por HTTP.
- **Bloqueo, inhabilitación y eliminación de clubes, y restablecimiento de credenciales de
  personas y clubes:** sin aislamiento especial, el de Prisma por omisión. Sus revocaciones
  toman el bloqueo de `users` dentro de su propia transacción.

### Alcance de las revocaciones

| Operación | Alcance |
|---|---|
| Logout | La sesión de esa cookie, aunque su token ya esté rotado |
| Cambio de contraseña | Todas las sesiones; crea una nueva en la misma transacción |
| Restablecer credenciales, bloquear, inhabilitar, eliminar, retirar el acceso administrativo | Todas las sesiones de la cuenta |
| Reuso de un token consumido | Solo la sesión afectada |
| Reactivar una cuenta | No revive nada |
| Bloqueo temporal por intentos fallidos | Ninguna (S10, sin cambios) |

### Alcance de la fase

**Incluye:** la tabla y la columna, `sid` y su comprobación, el protocolo de bloqueos, la
clasificación de tokens, la comparación del hash en login y cambio de contraseña, el ayudante
único de revocación, el límite absoluto, las pruebas y la documentación del despliegue.

**Excluye:** el frontend y A1, las Fases 2 a 4, las respuestas uniformes de login (en la
Fase 1 los mensajes y el 423 se conservaron; la Fase 2 los cambia a propósito), S10, la inactividad humana, la purga, Vite y la revocación
de la cookie anterior.

### Criterios de aceptación

- El logout invalida solo el JWT de esa sesión, de inmediato.
- El cambio de contraseña deja una sola sesión activa, y una cookie antigua no la afecta.
- Un logout con token rotado termina a su sucesor.
- Ninguna intercalación probada deja un token activo en una sesión terminada.
- Dos cambios de contraseña concurrentes no se pisan.
- Reactivar una cuenta no revive sesiones.
- Un fallo al resolver el club no consume el refresh token.
- Un token rotado de una sesión terminada no cierra sesiones nuevas.
- Un intento fallido iniciado antes de un bloqueo administrativo, una inhabilitación, una
  eliminación o un cambio de credenciales no los sobrescribe.
- El límite de 8 horas y sus fronteras se cumplen, y renovar no lo extiende.
- Los JWT sin `sid` y los tokens sin sesión se rechazan, sin cascadas.
- La política del bloqueo temporal no cambia. (Los mensajes y el 423 se conservaron en la
  Fase 1; la Fase 2 los reemplaza por el contrato descrito más abajo.)

### Evidencia

Las integraciones se ejecutaron contra la base desechable, con servicios reales y datos
sintéticos. Lo único simulado es `Date`, en las fronteras del límite absoluto. Los
intercalados se fijaron con una conexión `pg` que retiene la fila de `users` y con la espera
de cada operación confirmada en `pg_stat_activity`. Se introdujeron trece defectos
temporales, uno a uno, y las pruebas detectaron los trece.

No se probaron: un navegador real, Render, la reversión ejecutada ni el rendimiento bajo
carga. La reversión está solo documentada.

### Límites de las garantías

- Una petición que ya pasó la comprobación puede terminar.
- Sin cookie no hay logout de servidor: el JWT caduca por su cuenta.
- Si se pierde la respuesta de un refresh, el reintento se lee como reuso y exige volver a
  entrar. No hay ventana de gracia.
- Sin Web Locks en el navegador, dos refrescos simultáneos pueden terminar la sesión.
- Una consulta más por petición autenticada.

### Transición y reversión

El corte anunciado es la opción recomendada frente al backfill o a adoptar los tokens
antiguos: todos vuelven a entrar una vez, y no hay código de compatibilidad ni script sobre
producción. El orden, las comprobaciones posteriores y la reversión que no reactiva sesiones
invalidadas están en [../operacion/corte-de-sesiones.md](../operacion/corte-de-sesiones.md).
Servicios afectados: `fchmn-mantenimiento` como ejecutor puntual de la migración y
`fchmn-api`. `fchmn-web` no se despliega.

## Fase 2: API sin esquema (desplegada en producción; funcionalidades sin comprobar allí)

**Estado:** implementada, validada en local, publicada en `6d2dae5` (CI 42144375023 completa, con las migraciones sobre la base desechable y las integraciones) y **desplegada en `fchmn-api`** el 2026-11-05 (ver «Despliegue de la Fase 2»). Sin
cambios de esquema, migraciones, dependencias, frontend ni Nginx. La evidencia es de pruebas
locales con datos sintéticos; los hallazgos siguen siendo de revisión estática, y nada se
reprodujo en producción.

### Hallazgos

`Cache-Control` ausente en la API; excepciones internas devueltas por fila en la carga masiva
de personas y en la asignación masiva; un `TypeError` del analizador podía llegar al mensaje
de la importación de competencias; el login distinguía estados, y por tiempos, entre los
casos con y sin contraseña real que comprobar.

### Comportamiento implementado

1. **`no-store` global.** Un hook `onSend` registrado en `buildServer` antes de cualquier
   plugin y ruta establece `Cache-Control: no-store` en toda respuesta: éxitos,
   autenticación y CSRF, errores (también los lanzados desde un `preHandler`), rutas
   inexistentes, límites de solicitudes (429), preflight CORS y las descargas de reportes,
   de Team Manager y de la plantilla. No altera cuerpos, permisos, tipos de contenido ni
   nombres de archivo.
2. **Filtrado de errores** (`backend/src/shared/errorPublicable.ts`). En la carga masiva de
   personas y en la asignación masiva, el resultado de cada fila solo lleva el texto de un
   `AppError` o de un error de Prisma que `translatePrismaError` reconoce, con su mensaje
   redactado. Todo lo demás responde un mensaje genérico, y el detalle queda en el registro
   interno como una línea JSON (`fila_fallo_inesperado`) con contexto, referencia, clase y
   código del error, **sin su mensaje ni su traza**. En la importación de competencias se
   eliminó la regla que publicaba cualquier `Error` ocurrido durante la interpretación: los
   errores previstos de `parseEv3File` pasaron a ser `ValidationError` (como ya lo eran los de
   `parseHyvFile`), conservan su mensaje, y un `TypeError` u otro `Error` responde el mensaje
   genérico y deja en la auditoría solo clase y código. Se conservan el procesamiento
   parcial por fila, los resultados y la atomicidad de cada fila.
3. **Contrato del login.**

   | Situación | Respuesta |
   |---|---|
   | Usuario inexistente o eliminado | 401 genérico |
   | Contraseña incorrecta, en cualquier estado | 401 genérico |
   | **Incoherencia** entre la persona y su cuenta: persona eliminada, o estados que no se corresponden | 401 genérico, con cualquier contraseña |
   | Bloqueo temporal **vigente**, aunque la contraseña sea la correcta | 401 genérico, sin `lockedUntil` y sin verificar la contraseña real |
   | Cuenta inhabilitada o bloqueada por un administrador (sola, o con su persona en el **mismo** estado), con la contraseña correcta frente al hash vigente | 401 con el motivo |
   | Bloqueo temporal vencido | Flujo de la Fase 1 (se levanta al entrar; un fallo cuenta un intento) |

   «Genérico» es el mismo estado, código (`UNAUTHORIZED`) y mensaje («Usuario o contraseña
   incorrectos»). El motivo de una cuenta inhabilitada o bloqueada se decide **bajo
   bloqueo**, después de comparar el hash verificado con el vigente (H0) y de releer a la
   persona: una contraseña sustituida durante el login produce el genérico. Con contraseña
   incorrecta, esas dos cuentas responden el genérico sin contar intentos ni cambiar de
   estado.

   **Estado administrativo habitual frente a incoherencia.** `blockPerson` y `disablePerson`
   cambian a la vez `persons.status` y `users.status` de la cuenta vinculada (con
   `lockedUntil` nulo) y cortan sus sesiones: ese es el estado administrativo habitual de una
   cuenta de persona, y recibe el motivo. Es una *incoherencia* todo lo que el sistema no
   produce: persona eliminada o inexistente, cuenta activa con persona bloqueada o
   inhabilitada, estados que no se corresponden, o un bloqueo temporal sobre una persona que
   no está activa. Esas se rechazan con el genérico **antes** de comprobar la contraseña (con
   verificación ficticia) y sin tocar la cuenta. *Corrección posterior a la primera
   implementación:* esta ya rechazaba por el estado de la persona antes de verificar la
   contraseña, de modo que una persona bloqueada o inhabilitada por el sistema nunca recibía
   el motivo; las pruebas del contrato solo usaban cuentas sin persona y no lo detectaban.
   Ahora hay regresiones que pasan por `personsService.blockPerson` y `disablePerson`. Ya no se emite
   el 423 `ACCOUNT_LOCKED`; el frontend no lo usaba. El límite por IP (429), los errores
   técnicos (503 y 500), los contadores, el bloqueo por cuenta, la auditoría y S10 no cambian.
4. **Verificación ficticia de Argon2** (`verificacionFicticia`, en `password.util.ts`) donde no
   hay hash real que comprobar: usuario inexistente o eliminado, incoherencia persona/cuenta y
   bloqueo temporal vigente. El hash se calcula una vez por proceso (perezoso, con los mismos
   parámetros que `hashPassword`) sobre un secreto aleatorio, y el resultado se descarta: la
   función devuelve siempre `false`. Argon2 sigue fuera de los bloqueos, y la revalidación H0,
   el orden de bloqueos, la revocación y las transacciones de la Fase 1 no se tocaron.

### Qué elimina la verificación ficticia y qué no

Elimina el camino que **no pagaba** el cálculo de Argon2. **No iguala los tiempos de
respuesta y no se afirma que lo haga**: el usuario inexistente no hace la comprobación bajo
bloqueo ni la auditoría, un bloqueo vigente no cuenta intentos, y la primera verificación
ficticia de cada proceso calcula además su hash. Esas diferencias residuales no se midieron.

### Validación local

Contra la base desechable de `docker-compose.test.yml` y con datos sintéticos:

- Pruebas nuevas: `login-contrato.integration.test.ts` (matriz por estado y contraseña,
  respuestas idénticas, bloqueo vigente sin efectos ni fecha, verificación ficticia observada
  en `argon2.verify` y `argon2.hash`, errores técnicos y 429),
  `no-store.integration.test.ts`, `errores-filtrados.integration.test.ts`,
  `error-publicable.test.ts`, `verificacion-ficticia.test.ts`, tres casos de revalidación H0 en
  `sesiones-concurrencia.integration.test.ts` y cuatro de descargas en
  `import-export-services.integration.test.ts`.
- Expectativas que cambian a propósito: el 423 y los mensajes de cuenta inhabilitada o
  bloqueada sin contraseña correcta, en `sesiones.integration.test.ts`,
  `sesiones-concurrencia.integration.test.ts` y `auth.service.integration.test.ts`. Las
  comprobaciones de estado, revocación y concurrencia no se debilitaron.
- Pasada completa: unitarias 55 archivos y 1.122 pruebas; integraciones 51 archivos y 1.019
  pruebas; `typecheck` sin errores; `lint` sin errores (con las advertencias que ya existían).
  Una primera pasada de integración dio 137 fallos porque se solaparon dos ejecuciones sobre la
  misma base; se repitió una sola ejecución y pasó completa.
- Corrección del estado de la persona (ver arriba): se añadieron 17 regresiones a
  `login-contrato.integration.test.ts` (persona con cuenta bloqueada o inhabilitada mediante
  `personsService`, por HTTP, más las incoherencias). Sobre el código anterior fallaban
  exactamente las dos de «contraseña correcta → motivo»; con la corrección pasan las 53 del
  archivo. Se repitieron solo las suites afectadas de login, sesiones, concurrencia y
  administradores (`typecheck` y `lint` sin errores); no se repitieron las suites completas.

### Límites

- Nada de esto se probó en producción ni con un navegador real.
- La clase `AccountLockedError` y el código `ACCOUNT_LOCKED` siguen definidos pero ya no los
  emite ningún camino del login.
- El mensaje genérico de las filas no distingue la causa; quien opera debe acudir al
  administrador con la fecha y hora de la carga.
- **Riesgo:** el cálculo ficticio añade el coste de un Argon2 a los intentos que antes
  respondían sin calcularlo.
- **Alcance de la comprobación en producción (limitación):** solo se observaron `/api/health`, `/api/ready` y `/api/auth/me` sin credenciales. El contrato del login, las cargas y las exportaciones no se probaron allí; su evidencia es la local y la de la CI.

### Despliegue de la Fase 2

Solo `fchmn-api`, desde el commit exacto `6d2dae5f70fa2bac1d202048b1863c3602a7732a` (despliegue
manual con «Deploy a specific commit»). Antes: último despliegue `b920893`, Auto-Deploy en Off
y ningún despliegue en curso. No hubo migraciones (la entrega no cambia el esquema), ni seed,
ni respaldo, ni corte forzado de sesiones, ni cambios de configuración. `fchmn-web` y
`fchmn-mantenimiento` no se desplegaron.

| Paso | Resultado |
|---|---|
| `fchmn-api` | *Deploy succeeded* (35 s) y *Live*, commit `6d2dae5`; Auto-Deploy sigue en Off |
| `/api/health` (por el proxy de la web) | 200, `{"status":"ok"}`, `Cache-Control: no-store` |
| `/api/ready` | 200, `{"status":"ready","database":"ok"}`, `Cache-Control: no-store` |
| `/api/auth/me` sin credenciales | 401 `UNAUTHORIZED`, `Cache-Control: no-store` |

**Observado en producción:** solo esas tres respuestas de solo lectura. **No comprobado en
producción:** el contrato del login, el filtrado de errores en cargas masivas e importaciones,
las descargas y la verificación ficticia; su evidencia es la local y la de la CI.

## Fase 3: cabeceras del frontend (cerrada: desplegada en producción)

**Estado:** **cerrada dentro de su alcance.** `fchmn-web` se desplegó a mano en Render desde
`1641004431bdcf14f8555c961d37051a4c1a676f` (Live, **Auto-Deploy en Off**; la CI de ese SHA, ejecución
42214496430, terminó en éxito). Despliegue: https://dashboard.render.com/web/srv-dbh48scs728c73arlf8g/deploys/dep-dbmsbh3bc2fs73aqk7h0
(variables de la web: `VITE_API_URL=/api` y `CSP_CONNECT_SRC` sin declarar, es decir `'self'`).
Antes del despliegue se validó
sobre la imagen real de Nginx y en un navegador real, con una **API simulada** y datos
sintéticos (ver «Validación local» y «Límites»). No se tocó el backend, la autenticación, el
esquema, las migraciones, las dependencias, Vite ni la Fase 4.

- **Hallazgos:** faltaban CSP, protección de enmarcado, `nosniff` y política de referencia;
  HSTS estaba en la API pero no en el frontend.
- **Dónde:** un fragmento reutilizable, `frontend/nginx/snippets/cabeceras-seguridad.conf.template`,
  incluido de forma **explícita** en `location /`, `location /assets/` y `location = /index.html`,
  con `always` (para que también salgan en 403 y 404). **No** a nivel `server`: en Nginx un
  `add_header` dentro de un `location` anula los heredados, y a ese nivel alcanzaría a `/api/`,
  duplicando las cabeceras de la API (dos CSP se *intersecan*). `/api/` no lo incluye. Las
  plantillas se procesan con `envsubst` y el fragmento queda en `conf.d/snippets/`, un
  subdirectorio que el `include conf.d/*.conf` de la imagen no alcanza.
- **Política final:**

  ```
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
    img-src 'self'; font-src 'self'; connect-src ${CSP_CONNECT_SRC}; base-uri 'none';
    form-action 'self'; frame-ancestors 'none'; object-src 'none'
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  ```

  HSTS es el mismo valor que ya envía la API con helmet, y **sin `preload`**. Sin comodines,
  sin `unsafe-inline`, sin `unsafe-eval`, sin `data:` ni `blob:`: no hizo falta ninguna
  excepción.
- **Inventario del build** (imagen real): un HTML sin scripts ni estilos en línea, un
  JavaScript y una hoja de estilos de Vite, y el logo en PNG; **todos del mismo origen**. El
  CSS no tiene `url()`, `@import` ni `@font-face`. No hay fuentes ni recursos externos.
  El bundle contiene dos llamadas `fetch` (`apiClient.ts`) y una descarga por `fetch` +
  `blob:` + un `<a download>`, que ni `connect-src` ni nada más necesita ampliar.
- **Estilos de React:** hay 568 usos de `style={{…}}` y se confirmó la hipótesis del plan: React
  los aplica por CSSOM (`element.style.x = …`), que `style-src` no bloquea. Con la política
  aplicada, un `setAttribute("style", …)` sí se bloquea (`style-src-attr`) y el CSSOM no; las
  páginas muestran sus estilos en línea sin violaciones.

### Configuración por entorno

`CSP_CONNECT_SRC` (variable de **arranque**, `'self'` por omisión) lista los orígenes a los que
el **navegador** puede llamar con `fetch`. **No es `API_INTERNA`**, que es la dirección que usa
Nginx por la red privada para reenviar `/api`. Debe ser coherente con `VITE_API_URL`, que se
fija al **construir**:

| Entorno | `VITE_API_URL` (build) | `CSP_CONNECT_SRC` (arranque) |
|---|---|---|
| Nube, la API bajo el mismo origen | `/api` | `'self'` (por omisión; no hay que declararla) |
| Docker Compose, uso local | sin definir (`http://localhost:3000`) | sin definir (`'self' http://localhost:3000`, el valor por omisión de `docker-compose.yml`) |
| API relativa en Compose | `/api` | `'self'` (declararla; con el valor local también arrancaría, pero dejaría abierto `localhost:3000`) |
| API absoluta con ruta | `https://api.ejemplo.cl/api` | `'self' https://api.ejemplo.cl` (el origen, **sin la ruta**) |

`VITE_API_URL` es una URL base (puede llevar ruta); `CSP_CONNECT_SRC` es una lista de orígenes.
Compose ya **no** deriva una de la otra (copiar `VITE_API_URL` producía `'self' /api` o un origen
con ruta, ambos rechazados): `CSP_CONNECT_SRC` se declara aparte, con `${CSP_CONNECT_SRC:-'self'
http://localhost:3000}`, y se puede sobrescribir desde el entorno o el `.env` de Compose.

El Dockerfile conserva el valor compilado en `API_URL_COMPILADA`, y
`frontend/nginx/18-validar-csp.sh` corre **antes** de `20-envsubst` y **no deja arrancar** el
contenedor, con un mensaje, si: el valor está vacío; contiene comodines, `'unsafe-*'`,
`'none'`, `data:`/`blob:`, esquemas sueltos, rutas, consultas, comillas dobles, `;`, `$`, `\` o
saltos de línea; o si no es coherente con el bundle (el origen de `VITE_API_URL` debe figurar,
o `'self'` si es una ruta). El filtro de `envsubst` pasó a `^(PORT|API_INTERNA|CSP_CONNECT_SRC)$`:
las variables de Nginx (`$uri`, `$host`…) no se tocan.

### Validación local

Imagen construida con el `frontend/Dockerfile` (bases de Nginx y Node sin actualizar), en dos
variantes —`VITE_API_URL=/api` y la de Compose— y contenedores exclusivos de prueba:

- **Configuración:** `nginx -t` correcto; `nginx -T` muestra el fragmento incluido solo en las
  tres ubicaciones y el `include conf.d/*.conf` no lo alcanza; sin `${…}` sin sustituir;
  `PORT`, `API_INTERNA` y `CSP_CONNECT_SRC` sustituidos (se probó con `PORT=8099`).
- **Cabeceras (curl sobre la imagen real):** las cinco, en `/login`, `/`, `index.html`, una
  ruta SPA, JS, CSS, PNG, un 404 real de `/assets/…` y `/assets/` (404). Caché de assets y
  `no-store` de `index.html` conservados; el fallback de la SPA responde 200 con cabeceras.
  En `/api/` hay **una sola** copia de cada cabecera, la de la API. `Set-Cookie` reescrito de
  `/auth` a `/api/auth`.
- **Valores inválidos:** una veintena de casos probados dentro de la imagen y 26 en la prueba automatizada
  (aceptados y rechazados, estos con su mensaje); un contenedor con un valor inválido terminó con código 1 sin llegar a generar la
  configuración. Se corrigió un defecto hallado al probar: sin `set -f`, un `*` se expandía
  contra los archivos del directorio.
- **Navegador real** (el pane de Claude, sobre Nginx), con una API simulada local:
  1. *Modo informativo* (`Content-Security-Policy-Report-Only` con `report-uri`, solo en un
     contenedor de prueba): login, panel, navegación, Reportes y descarga con **0 informes y
     0 eventos `securitypolicyviolation`**. Control positivo: un script en línea inyectado
     sí generó un informe.
  2. *Política aplicada*, API bajo el mismo origen (`/api`): login, panel, Clubes, Personas,
     Competencias, Inscripciones, Relevos, Reportes y una **descarga CSV con datos sintéticos
     (blob + `<a download>`, nombre tomado de `Content-Disposition`)**; sesión mantenida al
     recargar por la cookie reescrita; imágenes y estilos correctos; **0 violaciones**. Control
     positivo: un script en línea, un atributo `style` y un `fetch` externo se bloquean
     (`disposition: enforce`).
  3. *Política aplicada*, API en otro origen (`http://localhost:3000`, el modo Compose): login con
     CORS y cookies, panel, Reportes y descarga; **0 violaciones**; `fetch` a la API configurada
     permitido y a un origen ajeno bloqueado por `connect-src`.
- **Corrección de Compose (posterior):** la primera versión armaba `CSP_CONNECT_SRC` copiando
  `VITE_API_URL`, lo que daba `'self' /api` (con `/api`) o un origen con ruta (con
  `https://api.ejemplo.cl/api`), ambos rechazados por el validador, y declarar la variable no
  sobrescribía el valor. Ahora se declara aparte y se puede sobrescribir. Se comprobó con
  `docker compose config` (solo resuelve, no arranca nada) y con pruebas que resuelven el YAML
  como Compose y pasan los valores efectivos por el guion de validación: omisión local, `/api`,
  URL absoluta con ruta, sobrescritura y rechazo de los incoherentes. No se reconstruyó la imagen
  ni se repitió la navegación (la política no cambió).
- **Automatizado:** `backend/tests/frontend-cabeceras.test.ts` (55 pruebas, unitarias): las cinco
  cabeceras con `always`, la CSP y su ausencia de comodines, HSTS igual al de helmet, dónde se
  incluye el fragmento (y dónde no), caché y fallback conservados, filtro de `envsubst`,
  Dockerfile, Compose y el guion de validación con `sh`. También pasaron `documentacion`,
  `avisos-terceros`, `dockerfile-mantenimiento` y `dockerignore-contexto`; `typecheck` y `lint`
  sin errores. No se repitieron las suites del backend ni las completas.

### Comprobaciones en producción

Solo lecturas HTTP y una carga pública, sin iniciar sesión:

- Cabeceras de `/login`, `/index.html`, el JS y el CSS reales: las cinco, con los valores previstos
  (CSP con `connect-src 'self'` y sin `localhost`); `no-store` en el HTML y caché inmutable en los
  assets.
- `/api/ready` responde 200 (`ready`, base `ok`), con una sola copia de las cabeceras de seguridad,
  las de la API.
- `/login` en un navegador: HTML, JS, CSS y logo con 200 y formulario visible. La única entrada de
  consola fue el 401 esperado de `/api/auth/refresh` sin sesión; no hubo mensajes de bloqueo por
  CSP. Eso **no garantiza** la ausencia total de violaciones: no había un listener de
  `securitypolicyviolation`.

### Límites

- **Producción:** sin pruebas autenticadas (pantallas, descargas y cargas de archivos no se
  recorrieron), sin listener de `securitypolicyviolation` y HSTS comprobado solo como cabecera
  (los navegadores lo ignoran en HTTP plano).
- **API simulada.** Los datos son sintéticos y la API es un servidor mínimo escrito para la
  prueba: no ejercita al backend real, y varias pantallas (Auditoría, Catálogos, Asignaciones y
  otras con formas de datos más complejas) no se recorrieron porque el simulador no las
  alimentaba (devolvían `TypeError` por datos, no por la política). Las violaciones de esas
  pantallas **no están descartadas**; se cubrieron las vías que cargan recursos —las páginas
  cargan un único bundle, una hoja de estilos y el logo— y la política no depende de la página.
- **Cargas de archivos** (importaciones `.hyv`/`.ev3`, carga masiva) **no se probaron** en el
  navegador: usan `FormData` por `fetch`, cubierto por `connect-src`.
- Las páginas de error generadas por Nginx **antes** de elegir ubicación (p. ej. un 400 por una
  petición mal formada) no llevan estas cabeceras.
- La prueba automatizada lee archivos y ejecuta el guion; no construye la imagen ni ejecuta
  Nginx. No se le hizo una prueba de mutación.
- Las imágenes `fchmn-frontend:fase3-*` y los contenedores `fchmn-f3*` de prueba quedan en el
  equipo local, detenidos.
- **Recomendado:** recorrer las pantallas autenticadas con una cuenta propia y un listener de
  `securitypolicyviolation`, sin credenciales en este repositorio.

## Fase 4: límites del XLSX (cerrada: desplegada en `fchmn-api`)

**Estado:** **cerrada dentro de su alcance.** `fchmn-api` se desplegó a mano en Render desde
`4317e0fc7d824407fe028808319c14c936e0e7f4` (Live, **Auto-Deploy en Off**; la CI de ese SHA, ejecución
42250202229, terminó en éxito). Despliegue: https://dashboard.render.com/pserv/srv-dbh4ih4ipgvc73dore80/deploys/dep-dbmvvr7f3r2c73bpfgkg
(una instancia, plan de 0,5 CPU y 512 MB, el de la calibración).

**Producción: disponibilidad observada, no validación funcional.** Tras el despliegue se hicieron solo
solicitudes de lectura por la web: `/api/health` y `/api/ready` operativos (base de datos disponible),
y `/api/auth/me` sin credenciales rechazado con 401, todos con `Cache-Control: no-store`. **No se
realizó ninguna carga ni importación en producción:** el funcionamiento del importador con los nuevos
límites está validado **en local**, con datos sintéticos (ver «Validación local»).

- **Hallazgo:** la carga masiva abría el libro en memoria sin presupuesto propio y dentro del
  hilo principal. Es una superficie de **disponibilidad con acceso administrativo**
  (`persons:write`), no una vulnerabilidad de datos.
- **Lo que recorre ExcelJS a ciegas** (leído en su código): `<mergeCell>`, `<dataValidation>` y
  `<definedName>` recorren su rango celda por celda (`A1:XFD1048576` son 17.000 millones de
  vueltas), `<col max>` crea una columna por número, y el número de fila fija el recorrido de
  las filas.

### Diseño

Todo está en `backend/src/modules/persons/xlsx/`. La escritura de personas no cambió.

1. **Turno de carga** (`turno-de-carga.ts`). Se toma **antes de recibir el archivo** y se libera
   al terminar, con éxito o con fallo. Una segunda carga recibe **409** en el acto, sin cola: su
   cuerpo se descarta sin guardarlo. La garantía es **por proceso**: no coordina réplicas, y el
   despliegue previsto es de una instancia, igual que el límite de solicitudes.
2. **Recepción acotada.** La ruta pasa su propio `fileSize` (el flujo se corta sin acumular) y un
   plazo de subida que cierra la conexión: un envío detenido no retiene el turno.
3. **Proceso de análisis** (`analisis-aislado.ts`, `analizador.proceso.ts`). El análisis corre en
   un **proceso hijo**, con el entorno vacío, `--max-old-space-size` y sin Prisma ni `shared/env`
   (lo comprueba una prueba sobre el grafo de imports). Al vencer el plazo se le envía `SIGKILL`,
   y la promesa no se resuelve hasta que terminó. Si el proceso no pudo crearse no hay PID: Node
   emite `error` y `close`, nunca `exit`, y `kill` lanzaría; la solicitud termina sin esperar a
   nadie y responde el 500 genérico. La finalización se sigue desde que el hijo nace, y la falta de
   respuesta se decide en `close`, que llega tras vaciar el canal. Del hijo solo sale un resultado,
   un rechazo escrito por este sistema o un fallo sin texto.
4. **Inspección del ZIP** (`inspeccion-zip.ts`), antes de ExcelJS. Cada entrada se descomprime de
   verdad con `inflateRawSync` y `maxOutputLength`: zlib cuenta los bytes reales y corta al superar
   el tope, sin acumular el resto. Lo declarado no se cree: debe coincidir con lo real. La lectura
   es más estricta que la de JSZip para que ambos vean lo mismo: se rechazan ZIP64, cifrado, el campo
   extra de ruta Unicode y datos antes o después del archivo. JSZip toma el nombre del encabezado
   **local** y lo normaliza, así que el nombre local y el central deben ser idénticos byte a byte,
   UTF-8 válido y ya canónicos: `a/../x`, `./x`, `a//x`, barras invertidas, controles y colisiones
   (`x`, `/x`, `x/`) se rechazan. Solo se admite una barra inicial, que ExcelJS retira. Eso garantiza
   que toda hoja, libro o tabla de cadenas que ExcelJS reconozca se haya inspeccionado como tal.
5. **Escaneo del libro** (`escaneo-xml.ts`), sobre esos mismos bytes. Un recorrido de etiquetas que
   distingue comentarios, CDATA y atributos, y que rechaza lo que no puede medir (`<!DOCTYPE`,
   UTF-16, entidades en un atributo medido). Mide hojas, filas, índices, celdas, columnas, cadenas
   compartidas y el área de combinaciones, validaciones y nombres definidos. **Cada coordenada debe
   caber por sí misma**: los dos extremos de un rango y las referencias sueltas se validan aunque el
   área sea pequeña. Los extremos de `<col>` (`min` y `max`) tienen su **propio tope, 16.384**, y no
   el de las celdas: ExcelJS crea un objeto de formato por columna declarada, y su número en cada
   hoja queda acotado por ese máximo aunque haya declaraciones repetidas o solapadas. Los nombres definidos se leen con las
   reglas de ExcelJS (solo lo que registra, sin confundir el nombre de la hoja con una referencia), y
   un comentario o un CDATA dentro de uno se rechaza. `<dimension>` no se usa: es una declaración,
   ExcelJS no la recorre y aquí se mide lo real.
6. **Lectura** (`analizador.ts`). Se conserva `workbook.xlsx.load`, que da las celdas combinadas,
   hipervínculos, fórmulas y fechas con que ya funcionaba la carga. Tras cargar y antes de recorrer
   se comprueban las dimensiones **efectivas** de todas las hojas, como defensa si el escaneo y
   ExcelJS divergieran. Se limitan las filas con datos y el texto por celda y total, porque una
   cadena compartida se repite gratis en el archivo.

**Por qué un proceso y no `worker_threads`.** La primera versión usaba un hilo con
`resourceLimits`, y al medirla se reprodujo tres de tres veces un **aborto del proceso entero**
(salida 134, `FATAL ERROR: ... JavaScript heap out of memory`, en Windows con Node 24, con el
escaneo desactivado para la prueba): el fallo de memoria del hilo no se quedó en el hilo. Con un
hijo, ese mismo archivo responde un rechazo y la API sigue viva, en Windows y en la imagen.

### Límites vigentes

| Límite | Valor | Por qué |
|---|---|---|
| Archivo comprimido | 4 MB | 10.000 personas ocupan 0,6 MB |
| Entradas del ZIP | 128 | Holgura sobre las 16 hojas |
| Expansión real por entrada / total | 16 MB / 32 MB | 10.000 personas expanden 5,5 MB; el caso al borde, 20,6 MB |
| Hojas | 16 | |
| Filas (`<row>`, todas las hojas) e índice de fila | 25.000 | Admite filas vacías con formato; frena la hoja dispersa |
| Filas **con datos** | 10.000 | Casi el doble de la carga histórica, que es referencia y no requisito |
| Columna máxima de **celdas y referencias** (combinaciones, validaciones, nombres) | 1.024 | Lo que hay más allá de la L se ignora, pero no debe costar |
| Extremos `min` y `max` de **`<col>`** (formato de columnas) | 16.384 | Máximo físico de una hoja: Excel lo escribe al dar formato o ancho a la hoja entera. Límite aparte: declara formato, no celdas |
| Celdas (todas las hojas) | 300.000 | 25.000 filas × 12 celdas |
| Cadenas compartidas | 150.000 | |
| Área declarada (suma) | 300.000 celdas | Una validación en una columna entera (1.048.576) se rechaza |
| Caracteres por celda / en total | 2.048 / 8 MB | |
| Plazo de análisis | 60 s | 1,6 veces el caso al borde en el perfil de producción |
| Plazo de subida | 120 s | |
| Montón del análisis | 128 MB | El caso al borde cabe |

### Calibración

Archivos sintéticos, con el **backend compilado** dentro de la imagen del backend (Node 22) y los
recursos del plan de la API: `--cpus 0.5 --memory 512m`. El pico es el de todo el contenedor, por
`memory.peak`; el proceso principal de esa prueba es mínimo, sin Fastify ni Prisma.

| Archivo | Comprimido | Expandido | Tiempo | Pico | Resultado |
|---|---|---|---|---|---|
| 5.071 personas (referencia) | 0,3 MB | 2,8 MB | 6,8 s | 63 MB | Pasa |
| 10.000 personas | 0,6 MB | 5,5 MB | 13,9 s | 90 MB | Pasa |
| Al borde: 9.999 filas largas y otra hoja hasta 25.000 filas | 1,7 MB | 20,6 MB | 38,0 s | 164 MB | Pasa |
| Bomba de 1 GB que declara 100 bytes | 1,0 MB | cortada en 16 MB | 1,2 s | 55 MB | Rechazo |
| Hoja dispersa, combinación, validación, nombre definido, `<col>` | < 2 KB | | 0,8 a 1,8 s | 55 MB | Rechazo |

El mayor retraso observado en el hilo principal fue de 133 ms en los casos normales y de 403 ms en
el caso al borde.

### Validación local

- **Unitarias** (`xlsx-inspeccion`, `xlsx-analisis`): 114 pruebas, con ZIP construidos a mano
  (`tests/helpers/zipSintetico.ts`) y límites reducidos. Incluyen una comparación con el JSZip real:
  las discrepancias de nombres se comprueban primero contra lo que él lee.
- **Integración** (`persons-bulk-import-limites`, 19 pruebas, base desechable de
  `docker-compose.test.yml`): HTTP real con socket para las subidas a medias. Archivo legítimo y
  plantilla; rechazos sin ninguna escritura (personas, membresías y auditoría sin cambios); plazo
  vencido con `/health` respondiendo; segunda carga con 409; liberación tras éxito, rechazo, corte
  de conexión, subida detenida y fallo de creación del proceso (simulado con un doble que reproduce
  los eventos reales observados: `error` y `close`, sin `exit`).
- **Sin regresión:** `persons-bulk-import`, `persons-bulk-import-club` y `errores-filtrados`, las
  reglas, `exceljs-carga`, `unzipper-compatibilidad` y `dependencias-produccion`.
- **Desarrollo y compilado:** el mismo análisis corrió con `tsx`, con Vitest y desde `dist`, en
  Windows y en la imagen con el perfil de producción.
- **Cancelación real:** un bucle síncrono real de ExcelJS, con el escaneo desactivado solo en la
  prueba, se mata a los 5,0 s; el proceso principal siguió latiendo y el análisis siguiente
  funcionó.
- **Agotamiento real:** ese mismo archivo con un plazo largo agota el montón del hijo y responde un
  rechazo a los 34 s, sin afectar al proceso principal.
- **Mutaciones:** quitar el tope de zlib, la medición de filas y validaciones, el `SIGKILL`, la
  comparación del nombre local, la validación de los extremos o el control del PID hace fallar las
  pruebas. Las pruebas del formato de columnas cubren: la hoja entera pasa con los límites de
  producción; extremos `min` y `max` por encima de 16.384 se rechazan; y las celdas y referencias
  (combinaciones, validaciones, nombres definidos) por encima de 1.024 siguen rechazándose, incluso
  con la hoja entera con formato.
- **Compatibilidad con un editor real** (comprobación local posterior, sin base de datos):
  - *Editor:* Microsoft Excel 16.0 (compilación 20430) de Microsoft Office, instalado en el equipo.
    Se manejó por automatización (VBScript, instancia propia y sin ventana); la automatización
    tipada de PowerShell falló por una biblioteca de tipos de Excel sin registrar, que no se tocó.
  - *Caso:* plantilla actual de la carga masiva (hojas `Personas` e `Instrucciones`, encabezado A-K,
    anchos de columna) con cuatro personas sintéticas, tres con club y fecha de membresía. Se abrió,
    se editó (una persona nueva, una fecha efectiva como fecha nativa de Excel en dos formatos, y la
    de nacimiento como texto) y se guardó como XLSX **desde Excel**. El punto de partida lo generó
    ExcelJS, solo para tener algo que abrir.
  - *Resultado:* **pasa** con el analizador compilado y los límites de producción (4 s en Windows).
    Se conservaron la hoja `Personas` (la activa), el encabezado completo, las cuatro filas y los
    valores; las fechas efectivas nativas llegaron como `Date` y se mapearon a `2026-03-01` y
    `2026-05-10`; la de texto, a `2026-04-01`.
  - *Estructuras del archivo:* 11 entradas ZIP con nombres canónicos y deflate, sin ZIP64 ni campos
    extra; `<dimension ref="A1:K5">`; `<cols>` con una sola declaración `min=1 max=11`; sin
    combinaciones, validaciones ni nombres definidos; cadenas compartidas y tema habituales.
  - *Hoja entera:* el mismo libro con ancho y formato aplicados a **toda la hoja** (Excel escribe
    `<col min="1" max="16384" width="18.7109375" style="4"/>`) se rechazaba con el tope único de 1.024
    columnas. Tras separar los dos límites, **ese mismo archivo guardado por Excel** (sin volver a
    automatizar Excel) pasa con el analizador compilado y conserva hoja, encabezado, filas, valores y
    fechas (`2026-03-01`, `2026-04-01`, `2026-05-10`).
  - *Alcance:* una versión de Excel, dos archivos, sin LibreOffice ni Google Sheets, y sin importar
    nada. No es una garantía para otros archivos de Excel.
- **Costo del formato de columnas** (backend compilado, imagen del backend, `--cpus 0.5 --memory
  512m`, un contenedor por archivo; pico de todo el contenedor por `memory.peak`). Libros
  sintéticos con `<col min=1 max=16384>` en **todas** las hojas, con 5.071 o 10.000 personas en
  `Personas`. Los tiempos de esta máquina variaron entre tandas (el mismo caso base midió 6,8 s en la
  calibración y 15 a 19 s después), así que solo se compara dentro de la misma tanda:

  | Caso | Hojas | Tiempo | Pico | Resultado |
  |---|---|---|---|---|
  | 5.071 personas, sin `<col>` (base) | 2 | 15 a 19 s | 63 a 65 MB | Pasa |
  | 5.071 personas, `<col>` hasta 16.384 | 16 | 19 a 20 s | 108 MB | Pasa |
  | 10.000 personas, `<col>` hasta 16.384 | 16 | 29 s | 131 MB | Pasa |
  | 5.071 personas, 12.000 `<col>` repetidas por hoja (192.000) | 16 | 42 s | 129 MB | Pasa |

  El formato de columnas añade unos 45 MB y una fracción del tiempo con 16 hojas, y encaja en los
  presupuestos existentes (montón de 128 MB, plazo de 60 s, 512 MB de la instancia). El caso de
  declaraciones repetidas es el que menos margen deja con el plazo; ver el riesgo arriba. El mayor
  retraso del hilo principal fue de 505 ms.
- **Tras las correcciones de revisión** (nombres, coordenadas, finalización) no se repitió la
  calibración ni el agotamiento: los presupuestos no cambiaron. El analizador compilado se comprobó
  en Windows con el archivo de 5.071 personas.

### Riesgos residuales

- **La memoria es compartida.** `--max-old-space-size` no cubre los buffers externos, y el hijo usa
  la misma memoria de la instancia. Los presupuestos acotan lo conocido; si la instancia se agotara,
  el sistema podría matar a la API en vez de al hijo. La medición no incluyó una API real en reposo.
- **Estructuras no medidas.** Lo que ExcelJS haga con estilos, temas o dibujos está acotado por el
  tamaño de la entrada, el montón y el plazo, no por un presupuesto propio.
- **Hijo huérfano.** Si la API muere durante un análisis, un hijo atascado en un bucle síncrono no
  se entera. En producción, el contenedor se reinicia con ella; en desarrollo, termina al agotar su
  montón o hay que detenerlo.
- **Una instancia.** Con más réplicas habría una carga activa por réplica.
- **Validaciones en columnas enteras.** Una plantilla propia con una validación hasta la fila
  1.048.576 se rechaza con un mensaje. La plantilla descargable no trae validaciones.
- **Otros editores.** Se comprobó **Microsoft Excel** (ver «Compatibilidad con un editor real»);
  no se probaron LibreOffice, Google Sheets ni otras versiones de Excel. Las reglas de nombres y de
  ZIP rechazan como inválido lo que no sea canónico.
- **Hoja con formato o ancho en todas las columnas.** La comprobación con Excel halló que dar
  formato o ancho a la hoja entera hace que Excel declare `<col min="1" max="16384">`, y el tope
  único de 1.024 columnas lo rechazaba. **Corregido:** `<col>` tiene su propio tope de 16.384
  (`columnasDeFormatoMax`) y las celdas y referencias conservan 1.024. Costo medido abajo.
- **Declaraciones `<col>` repetidas.** Un archivo hostil puede repetir `<col min=1 max=16384>` cientos
  de miles de veces en cada hoja: el número de objetos que crea ExcelJS sigue acotado, pero leerlas
  cuesta tiempo (42 s en el peor caso medido, con 192.000 declaraciones en 16 hojas, bajo el plazo
  de 60 s y con poco margen). Si se excediera, el plazo lo corta sin escribir nada. Alternativa
  **no aplicada**: limitar el número de elementos `<col>` por hoja (Excel escribe unos pocos).
- **Fallo real de creación.** El doble de las pruebas reproduce los eventos observados con un
  ejecutable inexistente en Windows; en Linux no se observó ese fallo.
- **Producción.** Solo se observó la disponibilidad de la API desplegada; el importador no se ejercitó allí, y las mediciones de tiempo y memoria son de Windows con Docker, no de Render. Probar otros editores (LibreOffice, Google Sheets, otras versiones de Excel) es opcional y no condiciona este cierre.

## SEC-02: ningún reporte entrega el RUN (cerrada: desplegada en web y API)

**Decisión funcional aprobada:** ningún reporte muestra ni entrega el RUN, para ningún rol,
administrador incluido. **Estado:** **cerrada dentro de su alcance.** Desplegada a mano en Render, web y API, desde
`3cf1aaf2234fb6ac699842301d7a0f1cf18234aa`, con Auto-Deploy en **Off** en ambos. No cambia el esquema, los datos almacenados ni los permisos.

| Servicio | Despliegue | Commit |
|---|---|---|
| Web (`fchmn-web`) | `dep-dbn3napsrm7s73d9kba0` | `1641004` → `3cf1aaf` |
| API (`fchmn-api`) | `dep-dbn3t6egekts738r3vc0` | `4317e0f` → `3cf1aaf` |

La CI de ese SHA (ejecución 42287095793) terminó en éxito. Primero la web, luego la recarga de pestañas y
después la API.

**Evidencia de producción, por origen:**
- **Render** informó ambos despliegues exitosos y los servicios Live, con Auto-Deploy Off. Las consultas HTTP de solo lectura
  comprobaron **disponibilidad y cabeceras**: `/api/health` y `/api/ready` con 200 (base disponible),
  `/api/auth/me` sin credenciales con 401, `Cache-Control: no-store`, y en la web las cabeceras de seguridad
  con `connect-src 'self'` y el paquete JavaScript nuevo.
- **El usuario** recargó las pestañas y comprobó que la pantalla de Reportes **no muestra el RUN**, después del
  despliegue de la web y antes del de la API. Esa comprobación autenticada no la hizo quien implementó el cambio.
- **Validado en local y en la CI, sin comprobación funcional en producción:** que el JSON, el CSV, el XLSX y el PDF
  no entreguen el RUN, y que Team Manager lo conserve con su formato vigente. Eso no es una tarea pendiente para cerrar SEC-02.

**Dónde estaba y qué ocurre ahora:**

| Salida | Antes | Ahora |
|---|---|---|
| Pantalla de Reportes | «Nombre (RUN) — edad…», con el RUN de clave de la fila | Sin RUN; la clave es `personId` |
| JSON, filas individuales | `run` | Sin el campo |
| JSON, vista agrupada | `run` | `personId` en su lugar |
| CSV y XLSX, individuales | Columna «RUN» | La columna **no existe** (12 columnas, no 13; ni vacía ni oculta) |
| PDF | `(RUN)` tras el nombre | Sin RUN ni paréntesis |
| Integrantes de relevo, en las cuatro salidas | «Nombre (RUN)» | Solo el nombre |

- **Se conserva** lo demás: nombres, edades, categorías, filtros, totales, permisos, alcance por
  administrador, club y nadador, y el orden. El RUN sigue **almacenado** y el backend lo usa por
  dentro solo como desempate del orden (`compararNadadores`, tras apellidos, nombre y nombre
  completo); no llega a ninguna salida.
- **`personId`** es un identificador **interno** y estable, asociado a una persona concreta. **No es
  un dato anónimo**: se entrega solo a quien ya puede ver el reporte. Reemplaza al RUN como clave de
  la interfaz porque el nombre puede repetirse (homónimos).
- **Team Manager no cambió.** El módulo `team-manager-export` no se tocó y sus archivos `.CL2` y
  `.HY3` conservan el RUN con su formato vigente. Su consulta y su formato son propios y no importan
  nada de `reports/`.

**Transición (SEC-02), ya ejecutada.** El cambio es un **retiro de campos**, y la web nueva funciona con los dos
contratos: con la API anterior, que aún envía `run` y no `personId`, ignora el RUN sin mostrarlo ni
reenviarlo y usa la posición como clave; con la nueva, usa `personId`. El caso inverso **no**
funciona: una pestaña con la web **antigua** abierta contra la API nueva mostraría «(undefined)» en vez
del RUN, y sus claves de lista fallarían. Por eso el orden previsto es: 1) desplegar la web nueva; 2)
que las pestañas abiertas se **recarguen** (no hay cierre de sesión ni cambio de autenticación; basta
recargar o volver a entrar); 3) solo entonces desplegar la API que retira el campo. Se siguió ese orden. Entre el despliegue de la
web y el de la API, la API anterior seguía entregando el RUN, que la web nueva ignoraba.

### Validación local

- **Integración**, en la base desechable de `docker-compose.test.yml`, con datos sintéticos y
  centinelas inconfundibles (un RUN de forma real, buscado con puntos, con guion, pegado y solo el
  cuerpo, y cadenas con letras): JSON sin claves ni valores con RUN para administrador, club y nadador;
  CSV con sus encabezados exactos y cada dato bajo su columna; XLSX reabierto **y** todas sus partes XML
  (cadenas compartidas, hojas, propiedades); PDF por extracción de texto y buscando también dentro de
  los flujos comprimidos, incluida su forma hexadecimal; por HTTP con administrador y con la cuenta del
  club; homónimos con `personId` distinto y orden y totales intactos; el alcance de un club ajeno sigue
  dando 403.
- **Team Manager:** con el reloj fijo en `2026-06-15T15:00:00Z` y datos sintéticos, los archivos
  **internos** (no el ZIP, que lleva fechas) tienen las mismas huellas SHA-256 que **antes** del
  cambio, tomadas con el mismo montaje y estables en dos corridas; y llevan el RUN con guion en
  ambos. No se repitió ninguna importación manual en Team Manager.
- **Pantalla** (jsdom, no un navegador real): sin RUN ni en el texto ni en el HTML con el contrato
  nuevo, con el anterior y con ambos campos a la vez; sin claves repetidas con homónimos; igual para un
  delegado de club. Con el RUN restaurado a propósito, la prueba falla.
- **Mutaciones:** concatenar de nuevo el RUN en los integrantes, o dejar la columna vacía en CSV y
  XLSX, hace fallar las pruebas.
- Pruebas existentes que dependían del RUN o de los índices de columna se adaptaron
  (`reports.rules`, `reports-orden`, la integración de importación y exportación), sin relajar
  expectativas de orden, categoría ni totales.

### Límites

- **No es una purga de datos:** el RUN sigue en la base, en `/persons` y en las pantallas de personas,
  en la carga masiva y en Team Manager. Esta decisión es solo para los reportes.
- **Quien ya descargó** un reporte conserva su copia con RUN.
- **Planillas externas** que dependan de la posición de las columnas se desplazan una columna.
- **Homónimos:** dos integrantes de relevo con el mismo nombre ya no se distinguen en las salidas; es
  consecuencia de la decisión.
- Un nombre completo almacenado que contuviera un RUN escrito a mano se entregaría tal cual: no se
  inspeccionó.
- Pantalla comprobada con jsdom en las pruebas, y en producción por el usuario (ver «Estado»). Las demás salidas no tienen comprobación funcional en producción.

## SEC-01: topes en las listas JSON (cerrada: desplegada en `fchmn-api`)

**Estado: cerrada dentro de su alcance.** Desplegada a mano en Render, solo `fchmn-api`, desde
`120e29d64a708d8a3841a97e41cf0b3a0f63eecc`, con Auto-Deploy en **Off**.

| Servicio | Despliegue | Commit |
|---|---|---|
| API (`fchmn-api`) | `dep-dbn637ec6qcc73cooe20` ([enlace](https://dashboard.render.com/pserv/srv-dbh4ih4ipgvc73dore80/deploys/dep-dbn637ec6qcc73cooe20)) | `3cf1aaf` → `120e29d` |

La CI del código (ejecución 42306423042) terminó en éxito. Render informó «Deploy succeeded» y Live. La web no cambia.

**Evidencia de producción, por origen:**
- **Observado en producción:** `/api/health` y `/api/ready` con 200 (base disponible), `/api/auth/me` sin credenciales con 401 y
  `Cache-Control: no-store`. Es disponibilidad, no validación funcional.
- **Validado en local y en la CI, con datos sintéticos:** los límites de listas, de cuerpos y del multipart. **No se hicieron pruebas funcionales ni
  solicitudes excesivas en producción**; esa limitación no es una tarea pendiente para cerrar SEC-01.
- SEC-01 mitiga las rutas identificadas y **no elimina el aviso de la versión instalada de Zod**; SEC-03 sigue pendiente.
No cambia servicios de negocio, esquema de datos, migraciones, `seed`, catálogo, dependencias, frontend ni
la configuración global de cargas.

**El problema.** En Zod 3 el `.max()` de un arreglo valida todos los elementos y solo al final añade el error del
máximo. Una lista enorme de elementos inválidos costaba cientos de miles de errores y megabytes de memoria antes
de rechazarse; y la de relevos, además, se rechazaba por su cantidad exacta después de consultar personas.

**La solución.**
- `listaAcotada(max, esquemaDeLista, mensaje)` (`backend/src/shared/listaAcotada.ts`) comprueba la longitud con un
  `z.custom` y solo entonces pasa la lista (`pipe`) al esquema de elementos. Con exceso hay **un único error y no
  se valida ningún elemento**; dentro del tope el resultado es el del esquema anterior. Los números viven en
  `backend/src/shared/limites-listas.ts`.
- `bodyLimit` por ruta JSON: Fastify rechaza con 413 **antes de autenticar** un cuerpo mayor.
- Un lector multipart compartido para analizar e importar Meet Events (`meet-import.multipart.ts`).

**Límites vigentes** (rutas con listas JSON: **9 rutas, 11 campos**; `/analyze` comparte el lector, así que son 10 las que
se tocan):

| Ruta | Lista | Tope | Límite del cuerpo |
|---|---|---|---|
| `POST /relay-registrations` y `PUT /relay-registrations/:id` | `personIds` | 8 | 4 KiB |
| `POST /swimmer-assignments/bulk-assign` | `personIds` | 10.000 | 512 KiB |
| `POST /clubs` y `PUT /clubs/:id` | `delegatePersonIds`, `coachPersonIds` | 50 cada una | 32 KiB |
| `POST /competitions/:id/events` y `PUT /competition-events/:ceId` | `categoryIds` | 100 | 16 KiB |
| `PUT /competition-events/reorder` | `updates` | 1.000 | 256 KiB |
| `POST /competitions/import-meet-events` | `decisiones` (campo `relayDecisions`) | 500 (el que ya existía) | ver multipart |

**Multipart de analizar e importar Meet Events.** `@fastify/multipart` 9.4.0, `@fastify/busboy` 3.2.2 y Fastify 5.12.3:
- **`bodyLimit` no rige para multipart** (su analizador no lee el cuerpo por Fastify): lo acotan los límites del plugin.
- Un campo que supera `fieldSize` **no falla**: llega cortado con `valueTruncated`, y el fragmento puede seguir siendo JSON
  válido (por ejemplo, `{"fileHash":…,"decisiones":[]}` seguido de espacios). Por eso el lector lo rechaza **antes de guardarlo o
  interpretarlo**. `fieldnameTruncated` no llega a ser verdadero en esta versión (busboy no limita la longitud del nombre), así que
  además se rechaza todo nombre de más de 64 caracteres.
- Límites por llamada: campos de 64 KiB, 4 campos, 1 archivo y 6 partes. **No se indica `fileSize`**: rige el máximo global de
  15 MB, que no se tocó; la carga masiva de personas conserva su propio límite.
- Un archivo cuyo campo no se llama `file` se rechaza sin leerlo, y tras cualquier rechazo se deja de leer el resto de la solicitud.
- Los campos que no son `maxIndividualEventsPerSwimmer` ni `relayDecisions` se descartan sin guardarse (nada los leía).
- El nombre de archivo que se devuelve en el mensaje de extensión no admitida se acota a 80 caracteres.

**Respuestas.**

| Situación | Respuesta |
|---|---|
| Lista sobre su tope | 400 `VALIDATION_ERROR`, un único error en `details.fieldErrors.<campo>` |
| Cuerpo JSON sobre el límite de su ruta | 413 de Fastify, antes de autenticar |
| Campo multipart truncado, o nombre de más de 64 caracteres | 413 `PAYLOAD_TOO_LARGE`, texto fijo, sin reproducir lo recibido |
| Más de 4 campos / 1 archivo / 6 partes | 413 del plugin (`FST_FIELDS_LIMIT`, `FST_FILES_LIMIT`, `FST_PARTS_LIMIT`): el primer límite alcanzado |
| Archivo mayor a 15 MB | 413 `FST_REQ_FILE_TOO_LARGE` (sin cambio) |
| Archivo con campo distinto de `file` | 400 `VALIDATION_ERROR` |

**Contrato.**
- **Conservado:** opcionalidad («no enviado» sigue siendo «no tocar»), mínimos, mensajes existentes (incluido «Demasiadas decisiones de relevo»),
  permisos, alcance, validaciones de dominio y la cantidad exacta de integrantes por `swimmersCount`.
- **Rechazos nuevos e intencionados:** listas sobre su tope; cuerpos sobre el límite de su ruta (incluidos textos absurdos en clubes, que antes
  solo acotaba 1 MiB); campos multipart truncados; nombres de más de 64 caracteres; más de 4 campos, 1 archivo o 6 partes; archivo con campo
  distinto de `file`; y un segundo archivo (antes el segundo `file` sobrescribía al primero).
- **Cambio de forma intencionado:** con más de 500 decisiones **inválidas**, la respuesta trae solo el error del tope (antes, además, uno por
  elemento). Con más de 500 decisiones válidas la respuesta es la misma de siempre.

### Validación local de SEC-01

Todo con datos sintéticos. Se distingue lo **simulado** de lo **observado en la base real desechable**.

- **Simulado (sin base de datos; autenticación y servicios sustituidos, el resto es código real):**
  `lista-acotada.test.ts` (13), `listas-esquemas.test.ts` (168), `listas-rutas.test.ts` (65) y `meet-import-multipart.test.ts` (48).
  Demuestran, **de forma determinista**, que con exceso se validan **cero elementos** (un contador de validaciones queda en 0, y el mismo caso con
  `.max()` de Zod 3 sí valida todos), que dentro del tope el resultado es idéntico al de la definición anterior, que el cuerpo mayor al límite no llega a
  autenticarse, y, en multipart, el rechazo de campos truncados —incluido el fragmento que seguiría siendo JSON válido, con el control de que el esquema
  lo aceptaría—, de nombres largos, de exceso de campos/archivos/partes, del archivo con campo distinto de `file` y del archivo mayor a 15 MB. Cada
  rechazo **termina** (plazo de 5 s) y deja en cero las llamadas al servicio de importación.
- **Observado con la aplicación real y la base desechable** (`listas-json.integration.test.ts`, 58): con `prisma.$use` se registran las consultas. Una
  petición rechazada por SEC-01 deja **exactamente las mismas consultas que una línea base** (la autenticación y autorización, medidas con una validación
  previa; esos controles no se modificaron), una petición válida deja consultas adicionales (control de sensibilidad), y un cuerpo mayor al límite deja **cero**
  consultas, con 413 incluso sin token.
- **Integraciones afectadas, una ejecución limpia** (22 archivos, 586 pruebas, solo en la base de `docker-compose.test.yml`): pasaron. (Una primera
  ejecución se descartó: se lanzaron dos a la vez sobre la misma base y se interfirieron; se detuvieron ambas y se repitió una sola.)
- **Suite unitaria completa, una vez:** 64 archivos, 1.614 pruebas, pasaron. **Typecheck** completo del backend y **lint**: sin errores (el lint
  informa 51 avisos de `any` ya existentes, ninguno en archivos nuevos).
- No se repitieron las mediciones de memoria ni cargas reales, y no se ejecutó nada contra producción.

### Límites y riesgos residuales

- **Relevos: 8 es un límite técnico nuevo, no una propiedad del dominio.** `TestType.swimmersCount` es un entero libre y el catálogo se
  diseñó extensible: un tipo con más de 8 nadadores, si se creara, no podría inscribirse (400) hasta subir el tope. El catálogo de producción no se
  consultó. La cantidad exacta por `swimmersCount` se sigue validando en el servicio.
- **10.000 asignaciones no garantizan una duración determinada.** El servicio las procesa una por una; la carga real de 5.071 tardó unos 3
  minutos, observado una sola vez y **sin extrapolación** a 10.000 ni repetición para medirlo. No se verificó que una operación así termine antes de
  algún tiempo máximo de Nginx o de Render.
- Un rechazo en mitad de un multipart no puede devolver al cliente lo que ya envió: se deja de leer el resto, pero lo ya recibido (hasta 15 MB de
  archivo si viaja antes que un campo truncado) quedó en memoria de forma transitoria, sin trabajo de negocio.
- El servidor no define `requestTimeout` ni `connectionTimeout` (valores por omisión de Fastify): ajeno a esta tarea, no se tocó.
- Que un archivo con otro nombre de campo bloqueaba la solicitud se deduce de leer el código del plugin (la parte queda sin consumir). La
  validación comprueba que **ahora** la solicitud termina; no se reprodujo el bloqueo con el código anterior.
- Los duplicados dentro de una lista siguen aceptándose, como antes.
- `listaAcotada` depende del comportamiento de Zod 3 (`pipe` no ejecuta la salida tras un fallo previo); una migración de Zod o de Fastify
  (SEC-03) lo revalidaría con las mismas pruebas. SEC-01 **no** corrige el aviso de Zod: lo mitiga en las rutas alcanzables.

## SEC-01 y SEC-03: revisadas (SEC-01 implementada; SEC-03 sin cambios)

**SEC-01 (listas JSON).** Medido en memoria con Zod 3.25.76 durante la revisión: `.max()` **no** corta el
recorrido (solo marca el estado y sigue), así que un cuerpo de 1 MiB de elementos inválidos genera unos
350.000 errores, unos 5 MB de `details` y más de 100 MB de montón retenidos por solicitud. **Ya está
implementada y desplegada en `fchmn-api`** (cerrada): ver la sección «SEC-01». Lo que queda aquí es la
revisión original, como antecedente.

**SEC-03 (dependencias).** Corrección a una afirmación demasiado general de la revisión: **Zod tiene
una vía identificada** (SEC-01, aviso GHSA-mrhx-c7xc-m3w5, sin parche en 3.x). Para los demás avisos
(`fastify`, `fast-uri`, `glob`, `minimatch`, `brace-expansion`) **no se encontró una ruta
alcanzable en el código ni en la configuración publicados, pero eso es ausencia de evidencia, no
prueba de imposibilidad**: la revisión fue estática, sobre un árbol de producción de 275 paquetes en
el backend y 9 en el frontend (sin avisos). Siguen siendo mantenimiento pendiente. Las dependencias
de desarrollo (Vite, Vitest, `tinypool`, `esbuild`) no entran en las imágenes.

## CI de SEC-02: pánico intermitente del motor de Prisma (diagnóstico y protección publicada)

**Qué pasó.** La ejecución 42269659668 (commit `34acee1`, SEC-02) falló en el paso «Pruebas unitarias» del
Backend, a los 11 s, con `Process completed with exit code 134`. La **reejecución de los trabajos
fallidos** (intento 2, sin cambiar código ni configuración) **pasó**: 58 de 58 archivos y 1.297 pruebas, y el
registro no tiene ningún pánico. Por tanto el fallo es **intermitente**, y **no está corregido**.

**Evidencia del registro original** (conservado fuera del repositorio):
- El proceso que abortó fue el **motor nativo de Prisma**: `thread '<unnamed>' panicked at
  query-engine/query-engine-node-api/src/engine.rs:74:45: Failed to deserialize constructor options …
  Error { status: PendingException }`, seguido de «panic in a function that cannot unwind … aborting» y
  `Aborted (core dumped)`. El 134 es la consecuencia.
- El registro muestra un pánico del motor de Prisma y no contiene mensajes de agotamiento de memoria. Esto identifica el aborto observado, pero no demuestra su causa subyacente ni descarta toda influencia de los recursos.
- Quince archivos habían terminado en verde y ninguno falló antes del aborto. Vitest 1.6.1 usa el pool
  `threads` por omisión.
- **Relación con SEC-02:** no se encontró ninguna. El intento 2 pasó con el mismo commit, y SEC-02 no toca los
  módulos que las pruebas implicadas importan. Con un fallo intermitente no puede probarse un negativo.

**Lo que NO está demostrado:** qué archivo de prueba inició el motor, ni el mecanismo exacto. Hay
explicaciones publicadas de otros proyectos para este mismo pánico (cierre del hilo de Vitest mientras el
motor aún se construye, con Prisma 6.19.2; ver [intelliquote, PR 137](https://github.com/lucasfelsky/intelliquote/pull/137)
y [Statly, issue 809](https://github.com/statlyaus/Statly/issues/809)), pero aquí hay Prisma 5.22.0 y **no se
reprodujo**. Es una hipótesis compatible con la evidencia, no una causa confirmada.

**Vía de entrada identificada en este repositorio.** `src/shared/prisma.client.ts` hace
`globalThis.__prisma ?? new PrismaClient()` al importarse, y con el cliente se carga el motor nativo
aunque no se consulte nada. `meet-import.service.ts` y `relay-registrations.service.ts` lo importan, y
cuatro pruebas unitarias cargan esos servicios sin simular Prisma: `fixtures-sinteticos`,
`meet-import-asignacion-por-dia`, `meet-import-jornada` y `registration-window.rules`. Son archivos de
milisegundos.

**Protección publicada en el repositorio (commit y push a `main`) y validada en local.** Es solo infraestructura de pruebas:
- `backend/tests/helpers/prisma-guard.ts`, registrado en `setupFiles` de `vitest.config.ts` (la
  configuración **unitaria**). Antes de cada archivo pone en `globalThis.__prisma` —el punto que el
  singleton ya consulta— un doble que **no es un cliente real**, así que el singleton no llama al
  constructor. No importa servicios ni `@prisma/client`, y no se tocó código de producción.
- El doble **falla con un mensaje claro** ante cualquier uso (`prisma.person`, `$transaction`,
  `$connect`…, o asignarle algo): no devuelve listas vacías, éxitos ni nada que esconda un fallo. Solo
  responde a las sondas que no son uso (`then`, símbolos, `toJSON`).
- Los **dobles explícitos** (`vi.mock(".../prisma.client")`) siguen siendo los utilizados:
  `orden-determinista.test.ts` pasa sin cambios, y `prisma-guard-doble-explicito.test.ts` lo comprueba con un
  servicio real.
- **No se extiende** a la integración ni a la cobertura combinada: conservan sus configuraciones y sus
  protecciones de base de datos (una prueba lo verifica).

**Evidencia determinista del aislamiento** (`prisma-guard.test.ts`, 20 pruebas, y `prisma-guard-doble-explicito.test.ts`, 3):
con `@prisma/client` simulado por un constructor espía, importar el singleton protegido **no llama al
constructor**, ni tras varias importaciones; un **control de sensibilidad** borra el doble y el mismo
`import` sí llama al constructor, así que la prueba detecta el problema; y cualquier acceso inesperado
lanza. Con la protección desactivada a propósito, **15 de las 23 pruebas fallan**. La suite unitaria
completa pasó una vez: 60 archivos y 1.320 pruebas. No se hicieron tandas repetidas.

**Límites.**
- Esto demuestra el **aislamiento**: las pruebas unitarias ya no construyen un cliente real. **No demuestra** que
  el pánico intermitente haya desaparecido ni cuál era su causa; un verde, o varios, tampoco lo harían.
- Si el pánico tuviera otro origen (por ejemplo, otro módulo que cargue el motor), la protección no lo cubriría.
- Cualquier prueba unitaria futura que necesite datos de Prisma debe simular el singleton o ser de integración.
- Pendiente: observar la CI en ejecuciones posteriores. Publicarla no demuestra que el fallo intermitente quedó corregido.

## Vite

Vite 5.4.21 es una dependencia de **desarrollo** y la imagen publicada solo contiene el resultado
de la construcción: **no afecta al sitio publicado.** Corrección a lo que decía este apartado: los
avisos más recientes **sí alcanzan a Windows** (filtración del hash NTLMv2 desde un sitio que visite
quien desarrolla, y una posible inyección de comandos a través de `/__open-in-editor`, que Vite 5 trae)
y exigen el servidor de desarrollo en marcha. Para quien trabaja en Windows, conviene no navegar por
sitios no confiables con `npm run dev` activo. No se verificó la explotación, y Vite 5 no tiene parche
para esa familia: la actualización de versión mayor se trata aparte y sigue fuera de estas fases.

## Validaciones futuras seguras

Solo con datos sintéticos y en entornos aislados. Las pruebas de integración se ejecutan
exclusivamente contra la base desechable de `docker-compose.test.yml`, respetando sus
protecciones; nunca contra producción ni la base de trabajo. Para cada fase pendiente se
verifican los criterios de aceptación de su sección, y en la Fase 3 con una imagen local de
Nginx.

## Historia

`backend/prisma/migrations/PROPUESTA_SESSION_ID.md` es un antecedente del diseño, no una
instrucción vigente, y Git lo ignora. Donde difiera de este documento, rige este documento.
