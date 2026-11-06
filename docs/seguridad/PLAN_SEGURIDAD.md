# Plan de seguridad

Plan consolidado de los hallazgos de seguridad pendientes, en cuatro fases, con su estado
de avance. Los hallazgos son de **revisión estática** del código, salvo donde se indica una
observación de producción ya disponible: ninguno de los intercalados se ha reproducido en
producción. Este documento no autoriza ninguna operación sobre producción.

## Estado de avance

| Fase | Contenido | Estado |
|---|---|---|
| **A1** | Cliente: un 401 o una renovación atrasados no cierran ni reutilizan una sesión posterior | **Cerrada y desplegada** en la web |
| **1** | Sesiones y revocación efectiva del JWT | **En producción desde el 2026-11-05** (`b920893`): migración aplicada y API desplegada, con el corte de sesiones ejecutado. La CI de `b920893` pasó completa, integraciones incluidas. Ver «Puesta en producción» |
| **2** | `Cache-Control: no-store`, filtrado de excepciones, login uniforme | **API desplegada en producción el 2026-11-05 (`6d2dae5`)**; la CI pasó completa. Salud y cabeceras observadas; funcionalidades sin comprobar en producción. Ver «Fase 2» |
| **3** | Cabeceras del frontend (Nginx) | Pendiente |
| **4** | Límites del procesamiento XLSX | Pendiente |
| Vite 5.4.21 | Aviso GHSA-rq7h-c2jc-7f22 en una dependencia de desarrollo | **Aplazado, fuera de estas fases** |

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

## Fase 3: cabeceras del frontend (pendiente)

- **Hallazgos:** faltan CSP, protección de enmarcado, `nosniff` y política de referencia;
  HSTS está en la API pero no en el frontend.
- **Objetivo:** un fragmento de Nginx incluido en las ubicaciones estáticas, con `always`.
  **No** a nivel `server`: en Nginx, un `add_header` en `location` anula los heredados, y
  además duplicaría las cabeceras de la API en `/api/`.
- **Política candidata:** `default-src 'none'`; `script-src`, `style-src`, `img-src` y
  `font-src` en `'self'`; `base-uri 'none'`; `form-action 'self'`; `frame-ancestors 'none'`;
  `object-src 'none'`. `connect-src` requiere una variable de despliegue, porque Compose usa
  la API en otro origen.
- **Aceptación:** cabeceras en rutas estáticas y errores, sin duplicados en `/api/`, y la
  aplicación sin violaciones de CSP.
- **Riesgo:** una CSP estricta puede romper algo; los estilos en línea de React son una
  hipótesis a validar. Se recomienda probarla primero en modo informativo.

## Fase 4: XLSX (pendiente)

- **Hallazgo:** la carga masiva abre el libro en memoria sin presupuesto propio, y el bucle de
  filas usa el número de la última fila declarada. Es una superficie de **disponibilidad con
  acceso administrativo**, no una vulnerabilidad de datos.
- **Objetivo:** inspeccionar el ZIP antes de abrirlo; presupuesto de expansión real, no el
  declarado; límites de hojas y filas antes de iterar; análisis aislado con plazo; una sola
  carga simultánea.
- **Calibración:** con datos sintéticos. La carga histórica de 5.071 personas es una
  referencia y no un requisito de capacidad.
- **Aceptación:** un archivo sintético fuera de límites se rechaza sin agotar el proceso, y
  una carga legítima calibrada pasa.

## Vite

Vite 5.4.21 es una dependencia de **desarrollo**; el aviso exige un servidor de desarrollo
expuesto en la red, fuera de Windows y con una coincidencia de rutas. La imagen publicada
solo contiene el resultado de la construcción. **No es una vulnerabilidad del sitio
publicado.** Es mantenimiento de herramientas, con una actualización de versión mayor que se
trata aparte; queda aplazado y fuera de estas fases.

## Validaciones futuras seguras

Solo con datos sintéticos y en entornos aislados. Las pruebas de integración se ejecutan
exclusivamente contra la base desechable de `docker-compose.test.yml`, respetando sus
protecciones; nunca contra producción ni la base de trabajo. Para cada fase pendiente se
verifican los criterios de aceptación de su sección, y en la Fase 3 con una imagen local de
Nginx.

## Historia

`backend/prisma/migrations/PROPUESTA_SESSION_ID.md` es un antecedente del diseño, no una
instrucción vigente, y Git lo ignora. Donde difiera de este documento, rige este documento.
