# Sistema de Gestión de Competencias de Natación

**Federación Chilena Máster de Natación (FCHMN)**

## Estado del proyecto

- ✅ **Módulo 1 — Autenticación y Usuarios**: implementado (backend + frontend + tests).
- ✅ **Módulo 2 — ABM de Personas**: implementado (backend + frontend + tests).
- ✅ **Módulo 3 — ABM de Entidades o Clubes**: implementado (backend + frontend + tests).
- ✅ **Módulo 4 — Asignación de Nadadores a Clubes**: implementado (backend + frontend + tests).
- ✅ **Módulo 5 — Tipos de Pruebas, Categorías y Pruebas**: implementado (backend + frontend + tests).
- ✅ **Módulo 6 — Competencias, Fechas y Jornadas**: implementado (backend + frontend + tests).
- ✅ **Módulo 7 — Inscripciones Individuales**: implementado (backend + frontend + tests).
- ✅ **Módulo 8 — Inscripciones de Relevos**: implementado (backend + frontend + tests).
- ✅ **Módulo 9 — Validaciones**: matriz de trazabilidad completa (ver `docs/internas/09_Validaciones_Trazabilidad.md`) — sin código nuevo, la lógica ya vive en los Módulos 7 y 8.
- ✅ **Módulo 10 — Reportes**: implementado (backend + frontend + tests) — listado de inscritos con exportación a CSV, Excel y PDF.
- ✅ **Módulo 11 — Exportación a Team Manager**: implementado y **verificado contra un archivo real** (ver detalle abajo) — resuelve la ambigüedad A-06.
- ✅ **Módulo 12 — Auditoría**: implementado (backend + frontend + tests) — pantalla de consulta sobre el `AuditLog` que ya se puebla desde el Módulo 1.
- ✅ **Módulo 13 — Pruebas y documentación final**: proyecto cerrado — ver `docs/internas/13_Resumen_Final.md` para la matriz de trazabilidad completa contra los 24 puntos del requerimiento original, checklist de entregables, y limitaciones conocidas.
- ✅ **Dashboard del administrador** (sección 21): KPIs de clubes/nadadores/competencias activas/inscripciones abiertas + tabla de inscritos por competencia — cierra la única pantalla explícitamente pedida que había quedado como placeholder.
- ✅ **Branding**: logo e identidad visual FCHMN aplicados (login, header, sidebar, tablas, botones).

**Proyecto completo: 13/13 módulos implementados.**

## Identidad visual

Paleta extraída del logo institucional, definida en `frontend/src/theme.css`:

| Color | Uso |
|---|---|
| `#4FA8CE` (celeste) | Color primario — botones, enlaces, foco de inputs |
| `#31446F` (azul marino) | Headers, sidebar, texto de marca |
| `#F4F8FB` | Fondo general |

El logo se encuentra en `frontend/src/assets/logo-fchmn.png` y se usa en la pantalla de login (`LoginPage`) y en el header de la aplicación (`AppShell`, visible en todas las pantallas post-login).


## Requisitos

- Node.js **20.11+**; **22 LTS recomendado**, que es el que usan las imágenes Docker
  (`node:22-alpine`). Las herramientas de prueba del frontend (jsdom 30, undici 8) declaran
  Node ≥22, así que con 20 `npm install` emite advertencias `EBADENGINE`.
- Docker y Docker Compose (para PostgreSQL local)

## Instalación (entorno local)

```bash
cd backend
cp .env.example .env
# Editar .env: JWT_ACCESS_SECRET y la contraseña dentro de DATABASE_URL
# (generar el secreto con: openssl rand -hex 32)

cp ../.env.example ../.env
# Editar ../.env: POSTGRES_PASSWORD, la MISMA contraseña que puso en DATABASE_URL

npm install
npm run verificar:credencial   # confirma que ambas contraseñas coinciden
docker compose -f ../docker-compose.yml -f ../docker-compose.dev.yml up -d postgres

npx prisma migrate deploy   # aplica las migraciones YA versionadas
npm run prisma:seed         # roles, permisos, parámetros y catálogos (idempotente)
npm run seed:admin          # UNA vez: crea el administrador inicial

npm run dev                 # levanta la API en http://localhost:3000
```

> **`migrate deploy`, no `migrate dev --name init`.** El repositorio ya trae sus
> migraciones versionadas; `migrate dev --name init` intentaría **crear una migración
> nueva** a partir del esquema, además de reiniciar la base si detecta divergencia.
> Instalar no es desarrollar el esquema: `deploy` aplica lo que ya existe y no crea
> nada. `migrate dev` queda reservado para cuando se modifica `schema.prisma`.

### Todo en contenedores

**Instalación nueva:**

```bash
cp backend/.env.example backend/.env   # y editar los secretos
cp .env.example .env                   # POSTGRES_PASSWORD, la misma de DATABASE_URL

docker compose up -d postgres
docker compose --profile mantenimiento run --rm migrate                      # migraciones + catálogos
docker compose --profile mantenimiento run --rm migrate npm run seed:admin   # UNA vez
docker compose up -d
```

**Actualización:**

```bash
docker compose --profile mantenimiento run --rm migrate npx prisma migrate deploy
docker compose up -d --no-deps --force-recreate backend
```

**Arranque cotidiano:**

```bash
docker compose up -d
```

La web queda en `http://localhost:8080` y la API en `http://localhost:3000`.

> **Si una migración o un seed termina con error, no arranque el backend.** Corrija la
> causa y repita el paso: una API contra un esquema a medio aplicar falla de formas
> difíciles de diagnosticar.

El servicio `migrate` es efímero y pertenece al perfil `mantenimiento`: **`docker compose
up -d` no lo ejecuta**. Aplicar migraciones y sembrar catálogos son operaciones
deliberadas, no parte de encender la aplicación.

> `VITE_API_URL` se resuelve **al construir** la imagen del frontend, no al ejecutarla:
> Vite la incrusta en el bundle. Apuntar a otro backend exige reconstruir:
> `docker compose build --build-arg VITE_API_URL=https://api.ejemplo.cl frontend`.

La documentación interactiva de la API queda disponible en `http://localhost:3000/docs` (Swagger UI).
En producción `/docs` está **deshabilitada por defecto**; para publicarla hay que poner
`ENABLE_SWAGGER=true` y definir `PUBLIC_API_URL`.

### Usuario administrador inicial

`npm run seed:admin` crea (si no existe) el usuario administrador con
`SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`. Es un **nombre de usuario, no un correo**.
Queda con `mustChangePassword = true`, por lo que el frontend lo lleva a cambiar la
contraseña en el primer ingreso.

Es un comando **aparte y manual**, que se ejecuta una sola vez al instalar. No forma parte
de `prisma:seed` ni del arranque del contenedor:

- **`SEED_ADMIN_USERNAME` y `SEED_ADMIN_PASSWORD` son obligatorias en todos los entornos**,
  desarrollo incluido. Si falta cualquiera de las dos, el comando termina con código 1.
  **No hay credenciales por omisión**: una cuenta de administrador previsible es explotable
  apenas el puerto queda accesible, y `mustChangePassword` no lo impide, porque quien
  conoce la credencial puede usarla antes que su dueño legítimo.
- Exigir lo mismo en todos los entornos evita además que la instalación local y la de
  producción sigan caminos distintos.
- La contraseña se valida contra la misma política que se le exige a cualquier usuario
  (10 caracteres, mayúscula, minúscula y número). **Ni la contraseña ni el nombre de
  usuario se imprimen**, porque la salida de un despliegue suele quedar registrada.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Pruebas

```bash
cd backend
npm run test               # unitarias (no requieren base de datos)
npm run test:integration   # integración (requiere la base DESECHABLE levantada)
npm run test:coverage:all  # unitarias + integración en una sola corrida, con cobertura

cd ../frontend
npm run test               # pruebas de componentes (jsdom)
npm run test:coverage      # ídem, con cobertura sobre TODO el código productivo
```

Las de integración corren **solo** contra la base desechable de
`docker-compose.test.yml` (puerto 55432, base `natacion_test`): el arranque valida
el destino y aborta si apunta a cualquier otra, precisamente para que no puedan
tocar la base de trabajo.

**Cifras medidas el 13 de septiembre de 2026:**

| Suite | Archivos | Pruebas |
|---|---:|---:|
| Backend, unitarias | 26 | 436 |
| Backend, integración | 23 | 389 (387 pasan, 2 omitidas) |
| Frontend | 23 | 480 |
| **Total** | **72** | **1.305** |

Cobertura de líneas medida el 13 de septiembre de 2026: **85,28 %** en el backend
(unitarias + integración) y **54,77 %** en el frontend. La diferencia es conocida
y deliberada: dentro del backend quedan módulos por debajo de la media (relevos,
carga masiva), y no se aplican umbrales porque los que había estaban calculados
sobre una base equivocada. **No hay pruebas E2E de interfaz**: Playwright quedó
aprobado como herramienta y el plan escrito, pero la dependencia no se instaló.
Es la brecha abierta más grande.

## Endpoints del Módulo 1

| Método | Ruta | Descripción | Auth |
|---|---|---|---|
| POST | `/auth/login` | Inicia sesión: devuelve el access token y **establece la cookie** del refresh | No |
| POST | `/auth/refresh` | Rota el refresh token **leyéndolo de la cookie** y devuelve access token **y perfil completo** | Cookie de sesión |
| GET | `/auth/csrf` | Devuelve el token CSRF vigente (cuerpo + cookie), o emite uno si no hay. Activo **siempre** | No |
| POST | `/auth/logout` | Revoca el refresh token y **borra la cookie** | Cookie de sesión (su ausencia no es error) |
| POST | `/auth/change-password` | Cambia la contraseña y **reemplaza la cookie** por la de la sesión nueva | Sí |
| GET | `/auth/me` | Retorna el payload del usuario autenticado (roles/permisos) | Sí |

`/auth/forgot-password` y `/auth/reset-password` **no existen**: la auto-recuperación se
eliminó por decisión explícita (no hay servidor de correo y la implementación anterior
devolvía el token de restablecimiento en la propia respuesta HTTP). El único camino es el
restablecimiento administrativo: `POST /persons/:id/credentials/reset` y
`POST /clubs/:id/credentials/reset`.

Estas rutas necesitan `credentials: "include"` desde el navegador: sin eso la cookie de
sesión no viaja.

## Decisiones de seguridad implementadas

- Contraseñas con **Argon2id** (nunca texto plano ni bcrypt).
- **JWT de acceso** (15 min) + **refresh token opaco con rotación** (7 días); reuso de un
  refresh token ya rotado revoca toda la sesión (indicio de robo de token).
- **El refresh token viaja en una cookie `HttpOnly`**, no en el cuerpo de la respuesta.
  Antes se devolvía en el JSON de `/auth/login` y el frontend lo guardaba en
  `sessionStorage`, donde cualquier script de la página podía leerlo — y ese token vale
  siete días. Ahora el JavaScript de la aplicación no puede verlo. Atributos: `HttpOnly`,
  `Secure` en producción, `Path=/auth` (no se envía a las demás rutas), `Max-Age` igual a
  la vida del token, y **host-only** (sin `Domain`, así que no se comparte con
  subdominios). El **access token vive en memoria** y se reconstruye con un refresco al
  recargar la página.
- **`SameSite` según el despliegue** (`AUTH_COOKIE_SAMESITE`): `lax` cuando la web y la
  API comparten sitio —el navegador no manda la cookie en POST nacidos en otro sitio, así
  que el CSRF queda cubierto por construcción— y `none` cuando están en sitios distintos,
  lo que exige `Secure` y `CORS_ORIGINS` exacta. El arranque rechaza las combinaciones
  inválidas, porque su síntoma —una cookie que el navegador descarta en silencio— es
  indistinguible de un fallo aleatorio. En producción `Secure` es obligatorio con
  cualquier `SameSite`: es lo que impide que el refresh token viaje sin cifrar.
- **Comprobaciones NO ejecutadas** (ver también `backend/tests/session-cookie-navegador.integration.test.ts`):
  el **`docker build` real** —que sigue **pendiente**, no cerrado: el análisis estático
  (`docker build --check`) no valida fallos de ejecución— y un **smoke test en navegadores
  reales**. Las
  pruebas con `tough-cookie` cubren `Path`, `Domain`/host-only y `HttpOnly` con el
  algoritmo del RFC 6265, pero **no** `SameSite`, **no** HTTPS/`Secure` en transporte,
  **no** la aplicación de CORS (Node ignora esas cabeceras) y **no** las políticas de
  cookies de terceros (bloqueo por omisión en Safari, CHIPS, modo incógnito). Antes de
  usar `AUTH_COOKIE_SAMESITE=none` en producción hay que probar el inicio de sesión, la
  recarga y el cierre en Chrome, Firefox y Safari —ventana normal y privada— contra un
  despliegue con HTTPS y la web en un host distinto del de la API.
- **Defensa CSRF SIEMPRE, con cualquier `SameSite`**: el servidor entrega un token en el
  **cuerpo** de `GET /auth/csrf` (y de login y cambio de contraseña) y lo respalda con una
  cookie `HttpOnly`; el cliente lo guarda **en memoria** y lo repite en `X-CSRF-Token`.
  El contrato es fijo: el token es un `string`, no `string | null`, y no existe ningún
  campo `requerido` — cuando lo había, un `null` en una respuesta desactivaba la
  protección en el cliente para el resto de la sesión.
  Antes solo se exigía con `SameSite=None`; ahora `SameSite` es defensa en profundidad y no
  la única barrera, porque es de **sitio y no de origen** (no separa un subdominio
  comprometido de la web legítima), depende de que el navegador lo implemente, y una sola
  variable de entorno podía desactivar la protección. **Única excepción deliberada:** cerrar
  sesión sin cookie de refresco responde 204 sin exigir token — no hay nada que revocar, y
  exigirlo convertía el caso más normal (sesión ya expirada) en un 403.
- **El token CSRF no rota en cada refresco.** Se emite al iniciar sesión, al cambiar la
  contraseña y en el bootstrap cuando no existe. Rotarlo en cada refresco creaba una carrera
  entre pestañas: la que renovaba obtenía uno nuevo y la otra se quedaba con el viejo hasta
  que le llegara el aviso —asíncrono—, y en esa ventana sus operaciones fallaban con 403.
- **Quién puede pedir un token nuevo**: decide el `Origin` contra `CORS_ORIGINS`, no
  `Sec-Fetch-Site`. Un `Origin` permitido vale aunque la petición sea `cross-site`, que es
  justamente lo que hace el frontend cuando web y API están en hosts distintos. Sin
  `Origin` decide `Sec-Fetch-Site`; sin ninguna de las dos se acepta (no hay navegador, y
  por tanto no hay cookies de una víctima que aprovechar).
  No es el double-submit clásico por `document.cookie`, que **no puede funcionar aquí**:
  `SameSite=None` existe justamente cuando la web y la API están en hosts distintos, y el
  JavaScript de la web nunca puede leer una cookie host-only de la API (ni una con
  `Path=/auth` desde `/competencias`). Lo que protege el token es CORS: una página
  atacante puede provocar la petición, pero no leer la respuesta que lo contiene.
  `GET /auth/csrf` existe para reconstruirlo tras recargar la página, cuando la memoria
  del cliente se vació pero la cookie sigue siendo válida; **no rota el token si ya hay
  uno** —rotarlo desincronizaría las pestañas y permitiría inutilizar la sesión desde
  fuera— y comprueba `Sec-Fetch-Site`/`Origin` antes de emitir el primero.
- **Un 403 no es una sesión expirada.** En `/auth/refresh` y `/auth/logout` significa que
  la comprobación CSRF falló, algo que ocurre por motivos normales (otra pestaña rotó el
  token, o la página se recargó). El cliente rehace el bootstrap y reintenta **una vez**;
  si persiste, conserva la sesión y muestra un error. Solo el **401** la invalida.
- **Garantía de la coordinación entre pestañas: SERIALIZACIÓN, no unicidad.** Web Locks
  asegura que nunca haya dos renovaciones en vuelo a la vez, que es lo que evita el reuso
  del refresh token. El `BroadcastChannel` ahorra rotaciones cuando el aviso llega a
  tiempo, pero su entrega es asíncrona: entre liberar el cerrojo y recibir el mensaje hay
  una ventana en la que otra pestaña puede renovar sin haberse enterado. Eso produce una
  rotación de más, inocua. **No se afirma "un solo refresco en total"**, y hay una prueba
  con entrega demorada que lo demuestra.
- **Ciclo de sesión, comparado por IGUALDAD.** Cada mensaje entre pestañas lleva un
  identificador de ciclo que se renueva en login, logout y cambio de contraseña. Un anuncio
  de otro ciclo se descarta, así que una renovación atrasada no puede revivir una sesión
  cerrada ni pisar el perfil del usuario que acaba de entrar. **No es un contador
  comparado por orden**: eso fallaba entre pestañas con historiales distintos —una en 8 y
  otra en 2 aceptaba como nuevo un mensaje viejo—.
  **El orden lo decide la AUTORIDAD, no la entrega.** `BroadcastChannel` no ordena los
  mensajes de emisores distintos: la receptora puede recibir el inicio de sesión de una
  pestaña antes que el de otra que entró primero. Quien entra escribe, dentro del cerrojo,
  un registro en `localStorage["fchmn.ciclo"]` — `{ ciclo, estado, revision }` — y todo
  mensaje se contrasta contra él antes de aplicarse. Así un cierre atrasado no puede cerrar
  la sesión que otra pestaña abrió después.
  Tres propiedades de ese registro, cada una por un defecto concreto:
  **(1) una pestaña nueva ADOPTA el ciclo activo** al cargarse, en vez de inventarse uno
  —con un ciclo propio quedaba fuera de la sesión en curso—;
  **(2) el cierre deja una TUMBA** (`estado: "closed"`) en vez de borrar la clave: borrarla
  dejaba el origen sin autoridad, indistinguible de "nunca hubo sesión", y un `iniciada` o
  `renovado` atrasado del ciclo recién cerrado revivía la sesión mientras el mensaje de
  cierre aún viajaba por el canal;
  **(3) `revision` es monotónica** y viaja en cada mensaje. **Manda la revisión y después
  el ciclo**: una revisión mayor describe una transición posterior venga del ciclo que
  venga —incluido el mismo—, y una anterior se ignora aunque el ciclo coincida. El cierre
  es una transición como cualquier otra y **avanza la revisión**: si conservara la del
  estado activo, un fallo al escribir la tumba dejaría el registro anterior empatado en
  revisión y la pestaña volvería a la sesión que acababa de cerrar. Lo mismo del lado del
  receptor: **el reloj local avanza con todo mensaje que se aplica** —también con un cierre,
  y de forma monotónica— porque si no, una receptora que no pudiera persistir la tumba se
  quedaría empatada con el registro viejo y volvería a la sesión cerrada.
  **Una tumba no se reabre por su propio ciclo**, ni con revisión mayor: tras un cierre
  quien vuelve a entrar abre un ciclo nuevo, así que un `iniciada`/`renovado` del ciclo
  enterrado no puede venir de ningún flujo legítimo.
  Sin `localStorage` —modo privado, políticas del navegador, valor corrupto— **no hay orden
  entre pestañas**: queda un camino de reserva declarado que compara con el ciclo local, no
  adopta nada ajeno y no comparte sesión. La serialización de Web Locks es independiente de
  esto y sigue siendo la garantía fuerte.
  **Los mensajes del canal se procesan DENTRO del cerrojo**, en la misma fila que el
  refresco, el login, el cierre y el cambio de contraseña, y se **reevalúan** al entrar:
  lo que era válido cuando el mensaje llegó puede no serlo cuando le toca el turno. Si al
  persistir la autoridad resulta que otra pestaña ya registró una revisión superior, el
  mensaje se descarta entero —ningún callback ve su sesión— y esta pestaña se pone al día
  con la que ganó.
  **Caso intermedio: se puede leer pero no escribir.** Es el más traicionero, porque el
  registro sigue ahí, legible y creíble, mientras describe un estado anterior al real. La
  pestaña cuya escritura falla se marca degradada y **deja de leerlo**: opera con su ciclo
  local, que es el de la cookie vigente. Sus mensajes siguen llevando una revisión mayor
  que la registrada, así que otra pestaña que sí pueda escribir los acepta y **registra la
  transición en su lugar**. Lo único irrecuperable es una pestaña que arranque desde cero
  mientras nadie ha podido actualizar el registro: leerá el estado antiguo. La degradación
  **no es permanente**: bajo el cerrojo se comprueba si el registro contiene ya una
  autoridad al menos tan nueva como la última revisión emitida por esta pestaña, y en ese
  caso vuelve a fiarse de él.
  *Limitación actual, con propuesta pendiente:* el identificador se genera en el cliente,
  de modo que dos pestañas que arrancan por separado no se reconocen y cada una renueva por
  su cuenta. La serialización y la propagación del cierre no se ven afectadas. La solución
  es un `session_id` emitido por el backend, que exige una columna nueva en
  `refresh_tokens`. Está diseñada pero **sin aplicar**: no hay migración creada ni
  cambios en `schema.prisma`.
- **La respuesta se adopta DESPUÉS de validar el ciclo**, nunca antes: la función que pide
  el refresco devuelve la respuesta cruda y no toca estado, CSRF ni almacenamiento. Antes
  adoptaba primero, así que un refresco terminado tras un logout dejaba la sesión escrita
  en la pestaña que lo había iniciado.
- **Las cuatro operaciones de sesión comparten cerrojo** —refrescar, cerrar, entrar y
  cambiar la contraseña—. Sin eso, un refresco podía escribir su `Set-Cookie` después de
  que un logout borrara la cookie, dejando una sesión renovable que el usuario creía
  cerrada.
- **Validación en tiempo de ejecución de toda sesión** (`sessionSchema.ts`), aplicada por
  igual a lo que llega del servidor y a lo que llega por el canal: `id`, `username`,
  `ownerType` dentro del enum, `personId`/`clubId` como cadena o nulo, `roles` y token
  decodificable. Lo que no encaje se ignora sin tocar el estado. Ya no hay ningún cast.
- **Coherencia entre el token y el perfil, claim por claim.** No basta con que ambos sean
  válidos por separado: se comparan `sub`, `ownerType`, `personId`, `clubId` y el conjunto
  de roles. Una discrepancia invalida la respuesta entera, porque significaría mostrar a un
  usuario mientras las peticiones salen con la credencial de otro. Y unos claims
  malformados invalidan el TOKEN COMPLETO en vez de degradarse: `roles: [1, {}]` ya no se
  convierte en `[]` —eso dejaba pasar una autorización distinta de la que el servidor
  firmó—, un token sin `sub` o sin `ownerType` se rechaza (el backend los firma siempre), y
  un `clubId: 42` ya no se degrada a `null`, donde casaba con un perfil sin club.
- **`/auth/change-password` devuelve la SESIÓN COMPLETA** —access token, token CSRF,
  `mustChangePassword` y **el perfil**—, porque el cliente la adopta tal cual y abre un
  ciclo nuevo. Antes no devolvía `user` y la aplicación quedaba sin nombre, sin club y sin
  roles justo después del cambio; ninguna prueba lo veía porque miraban el servicio o un
  mock del cliente. Ahora hay una prueba de integración que habla HTTP contra el servidor
  real (`backend/tests/cambio-contrasena-contrato.integration.test.ts`).
- **El cambio de contraseña no puede interbloquearse con la renovación.** Corre entero
  dentro del cerrojo de sesión, incluida la petición; si esta responde 401, renueva
  **sin volver a pedir el cerrojo** (`renovarDentroDelCerrojo`) y reintenta una vez. Por eso
  `/auth/change-password` está fuera del bucle automático de 401 del cliente HTTP: desde
  ahí la renovación pediría el cerrojo que sostiene el cambio y esperaría a quien la invocó.
  La alternativa aparentemente obvia —una bandera de módulo "ya lo tengo"— **no sirve**: en
  JavaScript no hay hilo que distinga una llamada anidada de una operación concurrente de la
  misma pestaña, así que la bandera dejaba pasar también a las concurrentes y anulaba la
  exclusión que el cerrojo existe para dar.
- **Un fallo transitorio al restaurar no manda al login.** Un 401 confirmado limpia la
  sesión y navega; una red caída o un 5xx muestran una pantalla de reintento conservando el
  perfil, porque la cookie sigue siendo válida y el servidor ni siquiera llegó a opinar.
- **Entre pestañas se comparte la sesión ENTERA** —access token, token CSRF,
  perfil y `mustChangePassword`—, no solo el token: una pestaña que adoptara únicamente el
  access token quedaría sin saber quién es el usuario si acabara de abrirse. (El token
  CSRF ya no rota en el refresco, precisamente para que su desfase deje de ser posible.)
- **Un único cliente HTTP en el frontend** con renovación coordinada: ante un 401 se
  renueva **una sola vez** y se reintenta **una sola vez**; `login`, `refresh` y `logout`
  quedan fuera de ese bucle. Las renovaciones simultáneas se unifican dentro de la pestaña
  con una promesa compartida, **entre pestañas con la Web Locks API** (serializa) y
  **BroadcastChannel** (comparte el token recién emitido, para que la segunda pestaña no
  rote otra vez). El mismo canal propaga el **cierre de sesión** a las demás pestañas. Es
  necesario porque el refresh token es de un solo uso y dos rotaciones a la vez se leerían
  como robo de sesión. Los escalones de degradación en navegadores sin esas APIs están
  documentados y probados en `frontend/src/modules/auth/refreshCoordinator.ts`.
- **Un fallo transitorio no cierra la sesión.** Solo un 401 o 403 del servidor la dan por
  inválida; una red caída, un timeout o un 5xx conservan la sesión y se reintentan. Y
  **cerrar sesión falla ruidosamente si no llegó al servidor**: la cookie es `HttpOnly` y
  solo el servidor puede revocarla, así que anunciar un cierre que no ocurrió dejaría al
  usuario creyendo que salió de un equipo compartido.
- **Bloqueo de cuenta tras 5 intentos fallidos** (RB-15), 15 minutos, configurable.
- **RBAC** evaluado siempre en backend (`requirePermission` / `requireRole`); el frontend
  solo usa roles y permisos para mostrar/ocultar UI, nunca como control real.
  `hasPermission()` consulta los permisos que trae el access token vigente —que el backend
  recalcula en cada emisión—; antes devolvía `true` para cualquier permiso, incluidos los
  inexistentes.
- **Auditoría** de login, login fallido, bloqueo de cuenta, cambio y recuperación de
  contraseña (RB-14).
- Mensajes de error de login **genéricos**: no revelan si el nombre de usuario o
  la cuenta existe. (El login es por **nombre de usuario**, no por correo.)
- Rate limiting global (300 req/min, `RATE_LIMIT_GLOBAL_MAX`) + rate limiting específico
  y más estricto en `/auth/*` (20 req/min, `RATE_LIMIT_AUTH_MAX`). El contador vive **en
  memoria del proceso**, así que el límite es por instancia: el despliegue previsto es de
  una sola instancia. Con más de una habría que volver a un contador compartido
  (ver la nota de Redis en `docs/internas/01_Propuesta_Base.md`).
- Helmet (headers de seguridad) y CORS con lista blanca (`CORS_ORIGINS`, obligatoria en
  producción) y métodos declarados explícitamente.
- **`/docs` (Swagger UI) está deshabilitado por defecto en producción.** Se publica solo
  fuera de producción, o forzándolo con `ENABLE_SWAGGER=true`; en ese caso
  `PUBLIC_API_URL` pasa a ser obligatoria.
- Sondas separadas: `/health` (vivacidad, no consulta la base) y `/ready`
  (disponibilidad, consulta PostgreSQL y responde 503 si no contesta).
- `TRUST_PROXY_HOPS` declara cuántos proxies propios hay por delante; con `0` (valor por
  defecto) no se confía en `X-Forwarded-For`.

## Endpoints del Módulo 2 — Personas

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/persons` | Lista personas (búsqueda por RUN/nombre, filtro por rol/estado, paginado) | `persons:read` |
| GET | `/persons/:id` | Detalle de una persona (incluye roles y credenciales) | `persons:read` |
| POST | `/persons` | Crea una persona (valida RUN chileno). **No acepta `roles`**: son derivados, y enviarlos se rechaza con 400 | `persons:write` |
| PUT | `/persons/:id` | Actualiza datos (RUN y nombre de usuario no editables). **Tampoco acepta `roles`** | `persons:write` |
| DELETE | `/persons/:id` | Eliminación lógica | `persons:write` |
| POST | `/persons/:id/block` | Bloquea persona y su cuenta de acceso si tiene | `persons:write` |
| POST | `/persons/:id/disable` | Inhabilita persona y su cuenta de acceso si tiene | `persons:write` |
| POST | `/persons/:id/reactivate` | Reactiva persona y su cuenta de acceso si tiene | `persons:write` |
| PUT | `/persons/:id/admin-access` | Concede o retira permisos de administrador. Exige además el **rol** `admin` | `persons:write` + rol `admin` |
| POST | `/persons/:id/credentials` | Crea credenciales de acceso (contraseña temporal, un solo uso en la respuesta) | `persons:write` |
| POST | `/persons/:id/credentials/reset` | Restablece la contraseña (revoca sesiones activas) | `persons:write` |

**Permisos de administrador por persona.** `persons.admin_access` guarda la
*intención*; quien concede el acceso es la fila de `user_roles` con el rol
`admin`, que es lo único que la autorización consulta en cada solicitud. La
marca se puede poner antes de que la persona tenga cuenta —entonces no se crea
ninguna credencial— y `POST /persons/:id/credentials` la aplica al crearla, sin
exigir ningún rol funcional. Retirarla quita solo el rol administrativo, revoca
los refresh tokens de esa cuenta y deja intactos los demás roles. Ninguna
acción puede dejar el sistema sin un administrador utilizable, contando la
cuenta `system`.

### Reglas aplicadas en el Módulo 2

- **RB-03**: validación de RUN chileno (formato + dígito verificador módulo 11), duplicado en frontend (`runValidator.ts`, solo UX) y backend (`shared/run.util.ts`, autoritativo).
- **RB-04 — una persona puede tener varios roles activos a la vez, y todos son
  DERIVADOS.** ~~Sincronizados vía `PUT /persons/:id`~~: ni el alta ni la edición
  de personas aceptan roles; hacerlo permitía fabricar una delegada sin
  nombramiento o una nadadora sin plantel, contradiciendo `club_staff` y
  `club_swimmers`. Quién escribe cada uno:

  | Rol | De dónde sale |
  |---|---|
  | `swimmer` | Una membresía **activa** en un club (`syncSwimmerRole`) |
  | `delegate`, `coach`, `legal_representative` | El nombramiento en la ficha del club (`club_staff`) |

  El historial se preserva igual que antes: al desaparecer la relación el rol se
  **desactiva**, no se borra. Y una persona recién creada no tiene ningún rol,
  que es lo correcto: todavía no es nada de ningún club.
- **RB-01**: al crear credenciales se valida que la persona no tenga ya una
  cuenta y que su **nombre de usuario** esté libre. ~~Que el correo no esté en
  uso~~: la identidad es el `username`, no el correo —que es un dato de contacto
  y ni siquiera es obligatorio—. La reserva es **global** entre personas, clubes
  y cuentas (`username_reservations`), porque ningún índice puede ser único
  entre tablas distintas.
- El RUN **no es editable** tras la creación (decisión de diseño — corregirlo requeriría un flujo administrativo aparte, no cubierto en el requerimiento original).
- Bloquear/inhabilitar/reactivar una persona propaga el mismo estado a su cuenta de usuario (`User.status`) si la tiene.

## Endpoints del Módulo 3 — Clubes

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/clubs` | Lista clubes (búsqueda por nombre/razón social/RUT, filtro por estado, paginado) | `clubs:read` |
| GET | `/clubs/:id` | Detalle de un club (incluye su personal —delegados, entrenadores y representante legal— y las credenciales) | `clubs:read` |
| POST | `/clubs` | Crea un club (RB-02: RUT obligatorio solo si tiene personalidad jurídica) | `clubs:write` |
| PUT | `/clubs/:id` | Actualiza datos del club | `clubs:write` |
| DELETE | `/clubs/:id` | Eliminación lógica | `clubs:write` |
| POST | `/clubs/:id/block` | Bloquea el club y su cuenta de acceso si tiene | `clubs:write` |
| POST | `/clubs/:id/disable` | Inhabilita el club y su cuenta de acceso si tiene | `clubs:write` |
| POST | `/clubs/:id/reactivate` | Reactiva el club y su cuenta de acceso si tiene | `clubs:write` |
| POST | `/clubs/:id/credentials` | Crea credenciales de acceso del club | `clubs:write` |
| POST | `/clubs/:id/credentials/reset` | Restablece la contraseña del club | `clubs:write` |

### Reglas aplicadas en el Módulo 3

- **RB-02**: el RUT es obligatorio y se valida (formato + dígito verificador) únicamente
  si `hasLegalStatus = true`. Se reutiliza el mismo algoritmo del RUN de personas
  (`shared/run.util.ts`), cubierto con 14 pruebas unitarias sobre el esquema Zod (`clubs.schemas.test.ts`).
- **A-01 / A-02**: el personal del club vive en la tabla `club_staff`
  (`club_id`, `person_id`, `role_type`), no en columnas `delegate_person_id` /
  `coach_person_id` como decía la propuesta original: un club puede tener **varios**
  delegados y varios entrenadores. Lo que sí se conserva de A-02 es el alcance:
  **una persona es personal de un solo club**, cualquiera sea el cargo. La restricción
  se aplica al asignar (`clubs.service`) y, si aun así aparecieran vínculos con dos
  clubes, `resolvePersonClubId` **falla cerrado** en vez de elegir uno.
  Las personas se eligen desde el catálogo ya registrado (`PersonPicker`).
- **Representante legal** (regla de negocio confirmada, no estaba en la propuesta
  original): **es un rol de acceso**, con **exactamente las mismas atribuciones que un
  delegado** (`CLUB_STAFF_PERMISSIONS`). En consecuencia:
  - Puede tener credenciales y operar sobre el club donde fue nombrado; no las
    requiere obligatoriamente (igual que delegados y entrenadores).
  - Le aplica la misma restricción de un solo club que a delegado y entrenador.
  - Solo existe si el club declara personalidad jurídica (RB-02). Si el club la
    pierde, el nombramiento se retira automáticamente.
  - Como máximo **uno por club** (a diferencia de delegados y entrenadores).
  - El rol funcional (`person_roles`) y el rol de acceso (`user_roles`) se **derivan**
    del nombramiento: se activan al nombrarlo y se desactivan al retirarlo,
    reemplazarlo o quitarle al club la personalidad jurídica.

  La equivalencia de permisos se verifica en `tests/rbac.definitions.test.ts` y el
  ciclo de vida completo en `tests/legal-representative.integration.test.ts`.
- **A-03**: una credencial de acceso por club (mismo patrón que personas, `ownerType=club`).
- Bloquear/inhabilitar/reactivar un club propaga el mismo estado a su cuenta de usuario.

## Endpoints del Módulo 4 — Asignación de Nadadores a Clubes

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/swimmer-assignments` | Lista solicitudes (filtro por club/nadador/estado, paginado) | `swimmer-assignment:read` |
| GET | `/swimmer-assignments/:id` | Detalle de una solicitud | `swimmer-assignment:read` |
| POST | `/swimmer-assignments` | El club o su personal —delegado, entrenador o representante legal— propone incorporar un nadador (queda `pending`) | `swimmer-assignment:write` |
| POST | `/swimmer-assignments/:id/approve` | Aprueba y activa la asignación | `swimmer-assignment:approve` (solo `admin`) |
| POST | `/swimmer-assignments/:id/reject` | Rechaza la solicitud | `swimmer-assignment:approve` (solo `admin`) |
| POST | `/swimmer-assignments/:id/end` | Finaliza una membresía activa | `swimmer-assignment:write` + alcance: el `admin`, o el personal **del mismo club** |

### Reglas aplicadas en el Módulo 4

- **A-05**: el club y su personal solo pueden *proponer* (`swimmer-assignment:write`); únicamente el rol `admin` tiene `swimmer-assignment:approve`, que es lo que exigen **aprobar** y **rechazar**. Esto separa ambos permisos a nivel de RBAC, no solo de UI.
- **Finalizar NO es aprobar.** `POST /:id/end` exige `swimmer-assignment:write`, no
  `approve`: un club puede dar de baja a un nadador de **su propio** plantel sin
  pedirle permiso al administrador, que es la operación inversa de proponerlo.
  Quién puede, exactamente:
  - el `admin`, sobre cualquier membresía;
  - quien tenga `swimmer-assignment:write` —`club`, `delegate`, `coach` y
    `legal_representative`— **solo si la membresía es de su club**; contra otro
    club responde 403.

  El permiso habilita la acción; el alcance lo decide `endAssignment` comparando
  el club del actor con el de la membresía, y está cubierto en
  `tests/authorization.integration.test.ts`.
- **RB-06 — un nadador activo, un solo club. Es una invariante, no un parámetro.**
  Si el nadador ya tiene una membresía activa en **otro** club, tanto la
  aprobación como la asignación directa se **bloquean** con un mensaje explícito:
  hay que finalizar la anterior primero. No se hace un intercambio automático
  silencioso, para que el historial quede completo y auditable.

  Hubo un parámetro `SWIMMER_SINGLE_CLUB_ACTIVE` en `system_settings` y **se
  retiró**: no configuraba nada. La base tiene un índice único parcial
  —`club_swimmers(person_id) WHERE status='active'`— que se crea siempre, así que
  desactivar el parámetro solo conseguía que el usuario viera un error de base de
  datos en lugar del mensaje de negocio. Hoy la comprobación es incondicional y
  llega antes que la base; el índice queda como garantía frente a dos
  inserciones concurrentes, que ninguna comprobación previa puede evitar.
- **Máquina de estados** (`pending → active`, `pending → rejected`, `active → ended`) aislada como función pura en `assignment.rules.ts`, cubierta con 10 pruebas unitarias sin necesidad de base de datos (`assignment.rules.test.ts`) — cualquier transición fuera de estas reglas se rechaza con un mensaje claro.
- **El rol `swimmer` NO es un requisito previo: es una consecuencia.** Se
  deriva de la membresía —`syncSwimmerRole` lo activa al quedar la persona con
  una membresía activa y lo desactiva cuando no le queda ninguna—, así que
  exigirlo antes de proponer sería pedir el efecto para permitir la causa. Lo
  que sí se exige al proponer: que el club esté `active`, que el alcance del
  actor sea ese club y que la persona no tenga ya una membresía activa en otro
  (RB-06).
- `getCurrentClubForPerson()` queda expuesto como utilidad reutilizable para módulos futuros (ej. inscripciones, que deben determinar automáticamente el club vigente de un nadador — sección 9 del requerimiento).
- En el frontend: la ficha de cada club (`ClubFormPage`) incluye una sección de "Plantel de nadadores" donde el club busca y propone nadadores directamente; el administrador aprueba/rechaza desde una pantalla dedicada (`/asignaciones`) accesible desde el menú lateral.

## Endpoints del Módulo 5 — Tipos de Pruebas, Categorías y Pruebas

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/catalogs/test-types` | Lista tipos de prueba (Individual, Relevo — sembrados) | `catalogs:read` |
| GET | `/catalogs/distances` | Lista distancias | `catalogs:read` |
| POST | `/catalogs/distances` | Agrega una distancia (catálogo extensible) | `catalogs:write` |
| GET | `/catalogs/strokes` | Lista estilos | `catalogs:read` |
| POST | `/catalogs/strokes` | Agrega un estilo (catálogo extensible) | `catalogs:write` |
| GET/POST/PUT/DELETE | `/catalogs/categories[/:id]` | ABM de categorías (eliminación lógica) | `catalogs:read` / `catalogs:write` |
| GET/POST/PUT/DELETE | `/catalogs/events[/:id]` | ABM de pruebas maestras, con `categoryIds` para la relación explícita | `catalogs:read` / `catalogs:write` |

### Reglas aplicadas en el Módulo 5

- **RB-05**: cálculo de edad aislado en `shared/age.util.ts` (años cumplidos a la fecha de corte de la categoría, no a la fecha de inscripción). 12 pruebas unitarias cubren casos límite: cumpleaños exacto en la fecha de corte, 29 de febrero, recién nacido (`age.util.test.ts`).
- **Sección 6**: tipos de prueba sembrados (Individual=1 nadador, Relevo=4), con `swimmersCount` como el campo que hace extensible el catálogo a futuros tipos sin cambiar código.
- **Sección 8**: distancias (50/100/200/400/800/1500 m) y estilos (Mariposa/Espalda/Pecho/Libre) sembrados como catálogos editables — se pueden agregar nuevos valores desde la pantalla de Catálogos sin tocar código.
- **Relación explícita Prueba↔Categoría**: tabla `event_categories`, con **integridad reforzada**: una prueba solo puede asociarse a categorías del **mismo tipo de prueba** (una prueba Individual no puede asociarse a una categoría definida para Relevo) — validado en `assertCategoriesBelongToTestType`.
- **A-07**: las categorías son un catálogo global reutilizable entre competencias, no se duplican.
- **A-08**: modificar una categoría no revalida retroactivamente inscripciones ya confirmadas (documentado en el servicio; la validación efectiva de inscripciones llega en el Módulo 9).
- **RB-13** (anticipada): la eliminación lógica de una prueba maestra es independiente de su uso en competencias — al quitar una prueba de una competencia (Módulo 6) solo se borra la relación, nunca esta fila.

## Endpoints del Módulo 6 — Competencias, Fechas y Jornadas

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET/POST | `/competitions[/:id]` | Listar/crear competencias | `competitions:read` / `competitions:write` |
| PUT | `/competitions/:id` | Editar (fechas de inscripción solo en `draft`/`scheduled`) | `competitions:write` |
| POST | `/competitions/:id/duplicate` | Duplica estructura completa como base de una nueva | `competitions:write` |
| POST | `/competitions/:id/{schedule\|cancel\|closeRegistrations\|start\|finish}` | Transiciones de ciclo de vida | `competitions:write` |
| POST/DELETE | `/competitions/:id/dates`, `/competition-dates/:dateId` | Fechas de la competencia | `competitions:write` |
| POST/DELETE | `/competition-dates/:dateId/sessions`, `/competition-sessions/:sessionId` | Jornadas dentro de una fecha | `competitions:write` |
| PUT | `/competition-sessions/:sessionId/limit` | Límites de pruebas individuales/relevos (NULL = sin límite) | `competitions:write` |
| GET/POST/PUT/DELETE | `/competitions/:id/events`, `/competition-events/:ceId` | Pruebas asignadas a la competencia | `competitions:read` / `competitions:write` |
| GET/POST | `/catalogs/session-types` | Catálogo extensible de jornadas (Mañana/Tarde sembrado) | `catalogs:read` / `catalogs:write` |

### Reglas aplicadas en el Módulo 6

- **RB-07 (apertura/cierre automático)**: aislé el cómputo en una función pura forward-only (`scheduled → open → closed`, nunca retrocede) en `competitions.rules.ts`, con **20 pruebas unitarias**. Se aplica de forma perezosa: cada vez que se lee una competencia, si la fecha actual implica un cambio de estado, se persiste automáticamente — sin necesitar un job/cron real todavía, pero la misma función serviría para uno.
- **Cierre manual anticipado** (sección 10, "excepciones manuales a administradores"): una vez que una competencia se cierra manualmente (`closeRegistrations`), el auto-cómputo la trata como estado terminal y **no la reabre**, aunque la fecha de fin todavía no haya llegado — cubierto explícitamente en los tests.
- **Máquina de transiciones manuales** (`schedule`, `cancel`, `closeRegistrations`, `start`, `finish`) con reglas claras de origen válido para cada una (ej. no se puede `finish` si no está `in_progress`).
- **Sección 13 / RB-13**: al asignar una prueba a la competencia, las categorías habilitadas deben ser un **subconjunto** de las ya asociadas a esa prueba en el catálogo general (Módulo 5) — no se puede habilitar una categoría que la prueba no admite. Quitar una prueba de la competencia borra únicamente `competition_events`, nunca la prueba maestra.
- **Duplicar competencia**: copia completa de fechas, jornadas, límites y pruebas asignadas (con sus categorías habilitadas) hacia una nueva competencia en `draft`, remapeando todos los IDs internos dentro de una transacción.
- **Sección 12 (A-09)**: límites de pruebas individuales/relevos definidos por fecha+jornada, uniformes para todos los nadadores de esa sesión; `null` en cualquiera de los dos campos significa "sin límite".

## Corrección al Módulo 2: campo Género en Personas

El Módulo 7 requiere validar que "el género del nadador sea compatible con la prueba"
(sección 15), pero el modelo `Person` del Módulo 2 no capturaba ese dato — no estaba
en la lista de campos de la sección 5 del requerimiento original. Se agregó como campo
obligatorio (`gender: male | female`) al modelo `Person`, al formulario de creación/edición
de personas y a los esquemas de validación correspondientes. Es una corrección necesaria,
no una ambigüedad de diseño: sin este dato la regla de género de la sección 15 no se
puede implementar.

## Endpoints del Módulo 7 — Inscripciones Individuales

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/competitions/:id/enabled-events` | Pruebas habilitadas de una competencia (paso 3) | `registrations:read` |
| GET | `/registrations/eligible-swimmers` | Nadadores elegibles para club+prueba+categoría (paso 6) | `registrations:read` |
| GET | `/registrations` | Lista inscripciones (filtro por competencia/club/nadador/estado) | `registrations:read` |
| POST | `/registrations` | Confirma una inscripción individual (ejecuta todas las validaciones) | `registrations:write` |
| POST | `/registrations/:id/cancel` | Cancela una inscripción | `registrations:write` (post-cierre requiere `registrations:write:post-close`) |

### Reglas aplicadas en el Módulo 7

- **Sección 15 (validaciones)**: las 10 reglas del requerimiento se aislaron en una función pura (`registrations.rules.ts`) que **acumula todos los errores aplicables** en vez de detenerse en el primero — el usuario ve de una vez todo lo que falla. **23 pruebas unitarias** cubren cada regla individualmente y su combinación.
- **RB-07 / RB-08**: reutiliza directamente `computeEffectiveStatus` e `isRegistrationOpen` del Módulo 6 (mismo cómputo de apertura/cierre, sin duplicar lógica). Tras el cierre, solo un usuario con el permiso `registrations:write:post-close` (exclusivo del rol `admin` en el seed) puede crear o cancelar inscripciones — quedan marcadas con `isPostCloseException=true`, visibles en el listado.
- **RB-05 (edad)** y **RB-12 (género)**: se validan con `age.util.ts` (Módulo 5) y el nuevo campo `gender` de `Person`, respectivamente.
- **RB-09 (no duplicados)** y **RB-10 (límite por fecha+jornada)**: se recalculan en cada intento de inscripción contra la base de datos real, no contra un estado en memoria — evita condiciones de carrera obvias entre dos inscripciones casi simultáneas del mismo nadador.
- **Alcance del club**: un usuario de tipo `club` (o `delegate`, `coach`, `legal_representative`) solo puede inscribir o cancelar inscripciones de **su propio club** — validado en el servicio, no solo ocultando la opción en la UI.
- **Frontend**: la pantalla de inscripción sigue literalmente los 9 pasos de la sección 14 (competencia → club → prueba habilitada → categoría → nadador elegible → confirmar), con los selects deshabilitados hasta que el paso anterior esté completo.

## Endpoints del Módulo 8 — Inscripciones de Relevos

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| ~~GET~~ | ~~`/relay-registrations/eligible-swimmers`~~ | **Nunca existió.** El asistente de relevos usa los mismos endpoints de elegibilidad que las inscripciones individuales (`/registrations/eligible-swimmers` y `/registrations/club-eligibility-matrix`), porque el criterio es idéntico. Esta fila se publicó por simetría con el Módulo 7 y describía una ruta que no está en el código; la detectó la prueba que compara cada fila con su ruta. | — |
| GET | `/relay-registrations` | Lista inscripciones de relevo (filtro por competencia/club/estado) | `registrations:read` |
| POST | `/relay-registrations` | Confirma un equipo de relevo (4 nadadores, valida el equipo completo) | `registrations:write` |
| POST | `/relay-registrations/:id/cancel` | Cancela un equipo de relevo | `registrations:write` (post-cierre requiere `registrations:write:post-close`) |

### Reglas aplicadas en el Módulo 8

- **RB-11 (exactamente 4, sin duplicados)**: `zod` ya rechaza en el esquema cualquier payload que no traiga exactamente 4 `personIds`; la regla pura (`relay-registrations.rules.ts`) además detecta duplicados dentro del arreglo aunque el esquema los deje pasar (ej. el mismo nadador enviado dos veces sí cumple "longitud 4" pero no es un equipo válido). **22 pruebas unitarias** cubren equipo incompleto, equipo con 5, duplicado interno, y cada regla individual por integrante.
- **Validación por integrante, no solo por equipo**: cada uno de los 4 nadadores se valida individualmente (activo, pertenece al club, edad, género, límite de relevos en esa fecha+jornada) y los mensajes de error identifican **a qué integrante** corresponde cada falla — no un error genérico de "equipo inválido".
- **Un equipo por club por prueba+categoría**: un club no puede tener dos equipos confirmados para la misma prueba de relevo y categoría (`duplicateTeamForClub`).
- **RB-10 (límite de relevos por nadador)** se evalúa **por integrante individual** en la fecha+jornada correspondiente, reutilizando el mismo `SessionLimit.maxRelayEvents` del Módulo 6 — un nadador puede estar bloqueado de sumarse a un 3er relevo aunque sus 3 compañeros de equipo sí puedan.
- Reutiliza exactamente el mismo patrón de excepción post-cierre (RB-08) y alcance por club que el Módulo 7, sin duplicar esa lógica de permisos.
- **Frontend**: el asistente bloquea la selección de un 5º nadador en cuanto hay 4 marcados (UX preventiva), pero la validación real y autoritativa siempre ocurre en el backend.

## Módulo 9 — Validaciones

No se agregó código nuevo: las 12 validaciones exigidas por la sección 15 ya estaban
implementadas dentro de los Módulos 7 y 8 (`registrations.rules.ts` y
`relay-registrations.rules.ts`). Este módulo se entrega como un documento de
**trazabilidad** (`docs/internas/09_Validaciones_Trazabilidad.md`) que
mapea cada regla del requerimiento al código que la implementa, con cobertura 14/14
(las 12 originales más las 2 específicas de relevos) y explica dos decisiones de
diseño no evidentes: por qué "prueba habilitada para la fecha y jornada" es una
garantía estructural (no una validación en tiempo de ejecución), y cómo se resuelven
en dos capas los permisos de usuario (RBAC + alcance por club).

## Endpoints del Módulo 10 — Reportes

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/reports/registrations` | Reporte en JSON (individuales + relevos) con filtros | `reports:read` |
| GET | `/reports/registrations/export?format=csv\|xlsx\|pdf` | Descarga el mismo reporte en el formato solicitado | `reports:read` |

Filtros soportados (sección 16): `competitionId` (obligatorio), `clubId`, `competitionDateId`, `sessionTypeId`, `competitionEventId`, `categoryId`, `gender`.

### Reglas aplicadas en el Módulo 10

- **Una sola fuente de verdad para el formato de fila**: `mapIndividualRegistrationToRow` y `mapRelayRegistrationToRow` (`reports.rules.ts`) son funciones puras que definen el "shape" exacto de cada fila una sola vez; JSON, CSV, XLSX y PDF consumen la misma salida — no hay 4 implementaciones distintas del mismo formato que puedan desincronizarse. **20 pruebas unitarias** verifican el formateo exacto de columnas (incluida la traducción de género) y el escapado CSV (RFC 4180: comillas, comas, saltos de línea).
- **Columnas mínimas exigidas** (sección 16) todas presentes: para individuales — competencia, club, RUN, nombre, fecha de nacimiento, categoría, prueba, distancia, estilo, género, fecha, jornada, tipo de prueba; para relevos — equipo/club, prueba, categoría, y los 4 integrantes con nombre y RUN.
- **Exportación real a 3 formatos**: se agregaron `exceljs` (Excel nativo, no CSV disfrazado) y `pdfkit` (PDF real) como dependencias del backend — verificado generando y reabriendo archivos de muestra antes de entregar el módulo.
- El reporte siempre parte de `Registration`/`RelayRegistration` con `status: confirmed` — las inscripciones canceladas nunca aparecen en el listado ni en las exportaciones.

## Módulo 11 — Exportación a Team Manager (resuelve A-06)

Se partió de una exportación real de Hy-Tek Team Manager (formatos `.HY3`/`.CL2`).
Se decodificó su estructura byte a byte y se implementó un generador **verificado
contra datos reales**, no contra documentación de terceros sin contrastar. El
fixture que se conserva en el repositorio es sintético.

### Verificación

> **Los fixtures de Hy-Tek son sintéticos.** Los formatos se decodificaron contra
> exportaciones reales, pero los archivos que viven en el repositorio
> (`sample.hy3`, `sample-with-relays.hy3`, `sample.ev3`) tienen personas, club y
> competencia inventados: ningún dato de una persona real entra al historial.
> Conservan la codificación CP1252, los terminadores CRLF, los anchos de campo y
> checksums válidos, de modo que siguen ejercitando el formato de verdad.
> `backend/scripts/anonimizar-fixtures.mjs` es reproducible e idempotente, y
> `tests/fixtures-sinteticos.test.ts` comprueba que así siguen.

- **Checksum de línea**: se encontró el algoritmo documentado públicamente para el
  formato HY3 y se probó contra las **121 líneas de datos** de una exportación real de
  Hy-Tek — coincide en el 100% de los casos. El fixture que se conserva en el
  repositorio es **sintético** (ver más abajo), y `tests/hy3-checksum.test.ts` separa
  las dos cosas: las líneas de encabezado sin datos de persona no se tocaron y
  conservan el checksum original de Hy-Tek — son las que demuestran que el algoritmo
  es el correcto —, mientras que las demás verifican que el cálculo se aplica de forma
  consistente a los ocho tipos de registro.
- **Estructura de campos**: se decodificaron las posiciones exactas de columna para
  los registros `A1` (encabezado), `B1`/`B2` (competencia), `C1`/`C2`/`C3` (club),
  `D1` (nadador) y `E1` (prueba individual inscrita). El generador (`hy3-writer.ts`)
  se prueba **reconstruyendo líneas del fixture** `tests/fixtures/sample.hy3` — 6
  líneas de datos de distintos nadadores, distancias y estilos coinciden **byte a
  byte** (`tests/hy3-writer.test.ts`).
- Un hallazgo colateral útil: el campo "age-up date" de la competencia en el registro
  `B1` corresponde exactamente al concepto de fecha de corte que ya
  usábamos para el cálculo de edad (RB-05, Módulo 5) — confirma que esa decisión de
  diseño está alineada con el estándar de la industria.

### Limitaciones documentadas honestamente

- **Solo formato `.HY3`**, no `.CL2`. El archivo `.CL2` de la muestra usa un
  algoritmo de checksum **distinto** al de `.HY3` que no se logró determinar con
  certeza en el tiempo disponible (se intentó por fuerza bruta sobre variantes del
  mismo algoritmo, sin éxito). Dado que `.HY3` es el formato moderno recomendado por
  Hy-Tek y ya está 100% verificado, se priorizó entregarlo funcional en vez de
  arriesgar ambos formatos a medio verificar.
- **Nombres con caracteres especiales (ñ, á, é, etc.)**: se encontró un caso en el
  propia exportación real (un apellido con "ñ") donde la línea `D1`
  generada por el Team Manager original presenta un corrimiento de una columna
  respecto al resto de las líneas — aparenta ser una inconsistencia del software
  original al calcular el ancho de ese carácter. El generador de este sistema
  **no reproduce esa inconsistencia** (produce columnas fijas y consistentes para
  todos los nombres); se documenta por transparencia, no se pudo confirmar con más
  de un caso si Team Manager la exige al importar.
- **Curso de piscina ("L"/"S", larga o corta) — ya no se adivina.** Al principio se
  escribía `L` fijo, tomado de la primera exportación; una segunda mostró
  `S` para su competencia, confirmando que es un dato de cada sede y no una
  constante. Hoy el sistema **sí** modela la piscina (`Pool`, con
  `courseLength`), la competencia la referencia, y el curso se deriva de ella. Si
  la competencia no tiene piscina asignada, **la exportación falla con un mensaje
  explícito** en vez de suponer piscina larga: ese carácter le dice a Team Manager
  cómo interpretar los tiempos de referencia, y una competencia de piscina corta
  exportada como larga produce marcas mal clasificadas sin que nada avise.

### Relevos (`F1`/`F2`, resuelto)

La limitación original (solo inscripciones individuales) quedó resuelta con una
segunda exportación real que sí incluía relevos.
Se decodificó igual que el resto — byte a byte
(`tests/fixtures/sample-with-relays.hy3`, `tests/hy3-writer.test.ts`):

- **`F1`** (encabezado del equipo de relevo): club, letra de equipo (siempre "A" —
  un club solo puede tener un equipo por prueba+categoría, ya validado al
  inscribir), la distancia **total** del relevo —que es el valor almacenado tal
  cual, **sin multiplicar** (ver «Semántica de la distancia» más abajo)—, estilo,
  número de la prueba en el programa, y marca de referencia si existe.
  Un hallazgo relevante: cuando NO hay marca de referencia, el campo se escribe
  como `0.00` con **punto** decimal (formato inglés) — a diferencia de una marca
  real, que usa **coma** decimal (formato chileno) igual que en `E1`. Tampoco lleva
  el marcador de estado `C` que sí lleva `E1` (esa posición queda en blanco).
- **`F3`** (los 4 integrantes del equipo, en orden): mismo `swimmerId` que su
  registro `D1` — un nadador que compite en un relevo pero en ninguna prueba
  individual igual recibe su línea `D1` (sin `E1` después), tal como en la muestra
  real: primero se listan todos los nadadores que SOLO están en relevos, y recién
  después los que tienen pruebas individuales (con su `D1` seguido de sus `E1`).

El endpoint ahora incluye ambos tipos de inscripción en un mismo archivo por club.

- El campo de "tiempo de marca de referencia" (seed time) se exporta con el valor
  real si el nadador (o el equipo de relevo) tiene uno cargado; si no, se exporta
  como `0`.

### Semántica de la distancia en pruebas de relevo

**`Event.distance` guarda siempre la distancia TOTAL de la prueba**, no la de cada
posta:

| Prueba | Valor almacenado |
|---|---:|
| 50 Libre (individual) | `50` |
| 4×50 Libre (relevo) | `200` |
| 4×100 Combinado (relevo) | `400` |

Se eligió el total porque es lo que traen los archivos `.ev3` de Hy-Tek Meet
Manager —la fuente desde la que se importan los programas— y lo que espera el
registro `F1` del `.HY3` al exportar. Con la distancia por posta habría que
convertir en **ambos** extremos; con el total, la conversión ocurre solo al
mostrarla en pantalla (`4×50`), en `shared/relayDistance.util.ts`.

Esto corrige un defecto real: el importador guardaba el total y el exportador lo
multiplicaba por 4 asumiendo que era por posta, así que un 4×50 importado se
exportaba como un relevo de 800 metros y el ciclo importar → exportar no
devolvía el mismo archivo. El contrato queda fijado en
`tests/relay-distance-roundtrip.test.ts`.

### Endpoint

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/export/team-manager/hy3?competitionId=&clubId=` | Descarga el archivo `.HY3` con las inscripciones individuales Y de relevo confirmadas de un club en una competencia | `export:team-manager` (solo `admin`) |

El archivo se codifica en **ISO-8859-1** (Latin-1), igual que el archivo original —
no UTF-8, ya que Team Manager es un software de la era DOS/Windows clásico que
espera esa codificación.

## Módulo 12 — Auditoría

`AuditLog` y la función `audit()` ya existían desde el Módulo 1 y se invocan en
**59 acciones distintas** a lo largo de todos los módulos (login, bloqueos,
creación/edición de personas y clubes, asignaciones de nadadores, transiciones de
competencia, inscripciones, exportaciones, etc.) — este módulo agrega la capa de
**consulta** que faltaba.

### Corrección encontrada al construir este módulo

Al revisar qué se estaba auditando realmente, encontré que **las exportaciones no
quedaban registradas** pese a que la sección 19 las lista explícitamente
("Auditar especialmente: ... Exportaciones"). Corregido en dos lugares:
- `reports.routes.ts` — cada exportación (CSV/Excel/PDF) ahora registra `REPORT_EXPORTED` con el formato, los filtros usados y la cantidad de filas exportadas.
- `team-manager-export.service.ts` — cada descarga `.HY3` ahora registra `TEAM_MANAGER_EXPORT_HY3` con el club y la cantidad de inscripciones incluidas.

### Endpoints

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/audit-logs` | Lista el registro de auditoría (filtros: usuario, entidad, ID de entidad, acción, rango de fechas) | `audit:read` (solo `admin`) |
| GET | `/audit-logs/filters` | Devuelve los valores de `entityType` y `action` ya registrados, para poblar los filtros de la UI sin hardcodear una lista que se desactualice | `audit:read` (solo `admin`) |

### Diseño

- **Solo lectura por diseño**: no existe endpoint de escritura/borrado sobre `AuditLog` desde la aplicación — es un requisito implícito de integridad de cualquier rastro de auditoría (si se pudiera editar, dejaría de servir como evidencia).
- Los filtros de "Entidad" y "Acción" en el frontend se pueblan dinámicamente desde `/audit-logs/filters` (valores realmente usados en la base de datos), en vez de una lista fija en el código que inevitablemente quedaría desactualizada a medida que se agreguen nuevas acciones en módulos futuros.
- Cada fila es expandible para mostrar `before`/`after` en JSON legible, sin saturar la tabla principal.

## Capacidades incorporadas después de los 13 módulos

Estas no corresponden a ninguno de los 13 módulos numerados del requerimiento
original: aparecieron después, al corregir hallazgos o al cubrir necesidades
operativas reales. Estaban en el código y **no** en esta documentación.

### Piscinas (`pools`)

Catálogo de sedes con su longitud de curso. Existe porque el archivo de Team
Manager necesita saber si la competencia es de 25 o 50 metros (ver «Curso de
piscina» arriba); una competencia referencia su piscina con `poolId`.

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/pools` | Lista piscinas (búsqueda y paginado) | `catalogs:read` |
| GET | `/pools/:id` | Detalle de una piscina | `catalogs:read` |
| POST | `/pools` | Crea una piscina (nombre, dirección, curso, techada, temperada) | `catalogs:write` |
| PUT | `/pools/:id` | Actualiza una piscina | `catalogs:write` |
| DELETE | `/pools/:id` | Eliminación lógica | `catalogs:write` |

### Importación del programa desde Meet Manager (`meet-import`)

Carga un `.zip` exportado desde Hy-Tek Meet Manager («Meet Events»), lee el `.ev3`
que contiene y crea las fechas, jornadas y pruebas de la competencia. El límite de
pruebas individuales por nadador se pide aparte porque el archivo no lo trae.
Aquí es donde importa la semántica de la distancia de relevos descrita arriba: el
`.ev3` trae el **total**, y así se guarda.

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| POST | `/competitions/import-meet-events/analyze` | Analiza el archivo **sin crear la competencia** y devuelve sus relevos con las opciones del catálogo (multipart: `file`) | `competitions:write` |
| POST | `/competitions/import-meet-events` | Importa el programa (multipart: `file` + `maxIndividualEventsPerSwimmer` + `relayDecisions`) | `competitions:write` |

La importación va en **dos pasos** porque ningún formato de Meet Manager indica
en cuántas postas se divide un relevo: solo trae la distancia total, y 200 m
pueden ser 4×50 o 2×100. El primer paso analiza el archivo **sin crear la
competencia ni entradas de catálogo** —lo único que llega a escribir es un
registro en `audit_logs` si el análisis falla, para no perder el rastro de los
archivos que no se pudieron leer—; el segundo importa con una decisión
**explícita por cada prueba de relevo** —la
decisión va por número de prueba y no por distancia/estilo/género, porque dos
relevos pueden coincidir en los tres y ser cosas distintas—. `relayDecisions`
lleva además la huella del archivo analizado: si el archivo cambió entre los dos
pasos, la importación se rechaza. Un relevo sin decisión no se importa por
omisión, y uno marcado como «no puedo confirmarlo» queda fuera y se cuenta como
omitido.

### Importación masiva de personas

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/persons/bulk-import/template` | Descarga la plantilla del archivo de carga | `persons:write` |
| POST | `/persons/bulk-import` | Carga masiva de personas, con informe de errores por fila | `persons:write` |

### Grupos de categorías

Agrupan categorías para presentarlas y filtrarlas juntas.

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/catalogs/category-groups` | Lista los grupos | `catalogs:read` |
| POST | `/catalogs/category-groups` | Crea un grupo | `catalogs:write` |
| PUT | `/catalogs/category-groups/:id` | Actualiza un grupo | `catalogs:write` |
| DELETE | `/catalogs/category-groups/:id` | Eliminación lógica | `catalogs:write` |

### Gestión directa del plantel (administrador)

El flujo de propuesta y aprobación del Módulo 4 sigue siendo el de los clubes.
Estas rutas son del administrador, que no necesita proponerse nada a sí mismo:

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| POST | `/swimmer-assignments/direct` | Asigna un nadador a un club sin pasar por `pending` | `swimmer-assignment:approve` |
| POST | `/swimmer-assignments/bulk-assign` | Asignación masiva | `swimmer-assignment:approve` |
| POST | `/swimmer-assignments/reassign/:personId` | Traslada un nadador a otro club | `swimmer-assignment:approve` |
| GET | `/swimmer-assignments/swimmers-by-club` | Plantel agrupado por club | `swimmer-assignment:approve` |
| GET | `/swimmer-assignments/current-club/:personId` | Club vigente de un nadador | `swimmer-assignment:read` |

### Apoyo al asistente de inscripción y al programa

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/registrations/available-events` | Pruebas disponibles para un nadador ya elegido (orden de inscripción alternativo: primero el nadador, después la prueba) | `registrations:read` |
| GET | `/registrations/club-eligibility-matrix` | Elegibilidad de **todo** el plantel del club en una sola consulta — la usa el panel de arrastrar y soltar | `registrations:read` |
| GET | `/registrations/club-swimmers` | Plantel del club para el asistente | `registrations:read` |
| PUT | `/registrations/:id` | Edita el tiempo de referencia de una inscripción | `registrations:write` |
| PUT | `/relay-registrations/:id` | Edita un equipo de relevo: tiempo de referencia y, si se entrega, los integrantes y su orden (en Combinado: espalda, pecho, mariposa, libre) | `registrations:write` |
| PUT | `/competition-events/reorder` | Reordena las pruebas del programa | `competitions:write` |
| PUT | `/catalogs/distances/:id`, `/catalogs/strokes/:id` | Edición de los catálogos base | `catalogs:write` |

## Inventario completo de endpoints

**116 endpoints**, agrupados por el módulo que los declara. Esta lista no está
escrita a mano: `backend/tests/documentacion.test.ts` la compara con las rutas que
el código declara y **falla si alguna sobra o falta**. Además comprueba que
ninguna ruta fuera de las públicas se quede sin guardia, y que el permiso exacto
de las rutas sensibles sea el que estas tablas publican — comparar solo método y
ruta dejaba pasar contradicciones de permisos.

Y declara su propio límite: si aparece una ruta cuyo camino no sea un literal
—una plantilla interpolada, una constante, un bucle nuevo—, la prueba **falla**
en vez de dejarla fuera del inventario en silencio. La única excepción admitida,
y está enumerada, es el bucle de transiciones de ciclo de vida de una
competencia. Las tablas por módulo de arriba siguen siendo la referencia de
permisos y semántica; esta es el inventario exhaustivo.

Las sondas `/health` y `/ready` las declara `server.ts`, no un módulo. `/docs`
(Swagger UI) no aparece aquí porque la publica el complemento de Swagger, y solo
fuera de producción o con `ENABLE_SWAGGER=true`.

### `(servidor)`

| Método | Ruta |
|---|---|
| GET | `/health` |
| GET | `/ready` |

### `audit`

| Método | Ruta |
|---|---|
| GET | `/audit-logs` |
| GET | `/audit-logs/filters` |

### `auth`

| Método | Ruta |
|---|---|
| POST | `/auth/change-password` |
| GET | `/auth/csrf` |
| POST | `/auth/login` |
| POST | `/auth/logout` |
| GET | `/auth/me` |
| POST | `/auth/refresh` |

### `catalogs`

| Método | Ruta |
|---|---|
| GET | `/catalogs/categories` |
| POST | `/catalogs/categories` |
| GET | `/catalogs/categories/:id` |
| PUT | `/catalogs/categories/:id` |
| DELETE | `/catalogs/categories/:id` |
| GET | `/catalogs/category-groups` |
| POST | `/catalogs/category-groups` |
| PUT | `/catalogs/category-groups/:id` |
| DELETE | `/catalogs/category-groups/:id` |
| GET | `/catalogs/distances` |
| POST | `/catalogs/distances` |
| PUT | `/catalogs/distances/:id` |
| DELETE | `/catalogs/distances/:id` |
| GET | `/catalogs/events` |
| POST | `/catalogs/events` |
| GET | `/catalogs/events/:id` |
| PUT | `/catalogs/events/:id` |
| DELETE | `/catalogs/events/:id` |
| GET | `/catalogs/strokes` |
| POST | `/catalogs/strokes` |
| PUT | `/catalogs/strokes/:id` |
| DELETE | `/catalogs/strokes/:id` |
| GET | `/catalogs/test-types` |

### `clubs`

| Método | Ruta |
|---|---|
| GET | `/clubs` |
| POST | `/clubs` |
| GET | `/clubs/:id` |
| PUT | `/clubs/:id` |
| DELETE | `/clubs/:id` |
| POST | `/clubs/:id/block` |
| POST | `/clubs/:id/credentials` |
| POST | `/clubs/:id/credentials/reset` |
| POST | `/clubs/:id/disable` |
| POST | `/clubs/:id/reactivate` |

### `competitions`

| Método | Ruta |
|---|---|
| GET | `/catalogs/session-types` |
| POST | `/catalogs/session-types` |
| DELETE | `/competition-dates/:dateId` |
| POST | `/competition-dates/:dateId/sessions` |
| PUT | `/competition-events/:ceId` |
| DELETE | `/competition-events/:ceId` |
| PUT | `/competition-events/reorder` |
| DELETE | `/competition-sessions/:sessionId` |
| PUT | `/competition-sessions/:sessionId/limit` |
| GET | `/competitions` |
| POST | `/competitions` |
| GET | `/competitions/:id` |
| PUT | `/competitions/:id` |
| DELETE | `/competitions/:id` |
| POST | `/competitions/:id/cancel` |
| GET | `/competitions/:id/capacity` |
| POST | `/competitions/:id/closeRegistrations` |
| POST | `/competitions/:id/dates` |
| POST | `/competitions/:id/duplicate` |
| GET | `/competitions/:id/events` |
| POST | `/competitions/:id/events` |
| POST | `/competitions/:id/finish` |
| POST | `/competitions/:id/reopenRegistrations` |
| POST | `/competitions/:id/schedule` |
| POST | `/competitions/:id/start` |

### `dashboard`

| Método | Ruta |
|---|---|
| GET | `/dashboard/stats` |

### `meet-import`

| Método | Ruta |
|---|---|
| POST | `/competitions/import-meet-events/analyze` |
| POST | `/competitions/import-meet-events` |

### `persons`

| Método | Ruta |
|---|---|
| GET | `/persons` |
| POST | `/persons` |
| GET | `/persons/:id` |
| PUT | `/persons/:id` |
| DELETE | `/persons/:id` |
| PUT | `/persons/:id/admin-access` |
| POST | `/persons/:id/block` |
| POST | `/persons/:id/credentials` |
| POST | `/persons/:id/credentials/reset` |
| POST | `/persons/:id/disable` |
| POST | `/persons/:id/reactivate` |
| POST | `/persons/bulk-import` |
| GET | `/persons/bulk-import/template` |

### `pools`

| Método | Ruta |
|---|---|
| GET | `/pools` |
| POST | `/pools` |
| GET | `/pools/:id` |
| PUT | `/pools/:id` |
| DELETE | `/pools/:id` |

### `registrations`

| Método | Ruta |
|---|---|
| GET | `/competitions/:id/enabled-events` |
| GET | `/registrations` |
| POST | `/registrations` |
| PUT | `/registrations/:id` |
| POST | `/registrations/:id/cancel` |
| GET | `/registrations/available-events` |
| GET | `/registrations/club-eligibility-matrix` |
| GET | `/registrations/club-swimmers` |
| GET | `/registrations/eligible-swimmers` |

### `relay-registrations`

| Método | Ruta |
|---|---|
| GET | `/relay-registrations` |
| POST | `/relay-registrations` |
| PUT | `/relay-registrations/:id` |
| POST | `/relay-registrations/:id/cancel` |

### `reports`

| Método | Ruta |
|---|---|
| GET | `/reports/registrations` |
| GET | `/reports/registrations/export` |

### `swimmer-assignment`

| Método | Ruta |
|---|---|
| GET | `/swimmer-assignments` |
| POST | `/swimmer-assignments` |
| GET | `/swimmer-assignments/:id` |
| POST | `/swimmer-assignments/:id/approve` |
| POST | `/swimmer-assignments/:id/end` |
| POST | `/swimmer-assignments/:id/reject` |
| POST | `/swimmer-assignments/bulk-assign` |
| GET | `/swimmer-assignments/current-club/:personId` |
| POST | `/swimmer-assignments/direct` |
| POST | `/swimmer-assignments/reassign/:personId` |
| GET | `/swimmer-assignments/swimmers-by-club` |

### `team-manager-export`

| Método | Ruta |
|---|---|
| GET | `/export/team-manager/hy3` |

## Módulo 13 — Pruebas y documentación final

Ver **`docs/internas/13_Resumen_Final.md`** para:
- Matriz de trazabilidad completa: las 24 secciones del requerimiento original vs. dónde se implementó cada una.
- Checklist de los 20 entregables de la sección 22.
- Verificación de los criterios de calidad de la sección 23.
- Números finales del proyecto, medidos y fechados.
- **Limitaciones conocidas**, declaradas sin rodeos.

### Dashboard del administrador (cierre de brecha)

Al hacer el repaso final se detectó que la única pantalla explícitamente pedida en
el requerimiento (sección 21: "el dashboard del administrador debe mostrar número
de clubes, nadadores, competencias activas, inscripciones abiertas, y nadadores
inscritos por competencia") había quedado como un placeholder genérico durante
todo el desarrollo modular, porque no correspondía a ninguno de los 13 módulos
numerados de la sección 24. Se implementó antes de cerrar el proyecto:

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/dashboard/stats` | KPIs administrativos (reutiliza el auto-cómputo de estado del Módulo 6 para nunca mostrar una competencia "abierta" ya vencida) | Rol `admin` |

Los usuarios `club`/`delegate`/`coach`/`legal_representative` siguen viendo una bienvenida simple en
`/dashboard` — el panel con KPIs es exclusivo del administrador, tal como pide
la sección 21.

## Estado final

**Los 13 módulos del requerimiento están implementados**, con branding institucional
aplicado en toda la aplicación, **1.305 pruebas** entre backend y frontend, y una
exportación a Team Manager verificada byte a byte contra archivos reales — no contra
documentación de terceros sin contrastar.

Lo que sigue abierto, sin adornos:

- **No hay pruebas E2E** de interfaz. Es el hueco más grande: Playwright está
  aprobado como herramienta y el plan escrito, pero la dependencia no se instaló.
- **La exportación a Team Manager no cubre `.CL2`**, solo `.HY3` (el checksum del
  `.CL2` no se logró determinar). Los relevos **sí** están cubiertos.
- **El `docker build` real sigue sin ejecutarse**, y tampoco un smoke test en
  navegadores reales.
- La cobertura del frontend (54,77 %) va por detrás de la del backend (85,28 %).

Las limitaciones de fondo y su estado están en `docs/internas/13_Resumen_Final.md`; las de
pruebas quedan enumeradas arriba. Ninguna está escondida.

## Licencia

**Software propietario.** Copyright (c) 2026 FEDERACION DEPORTIVA NACIONAL CHILENA
MASTER DE NATACION (FCHMN), RUT 65.102.869-8. Todos los derechos reservados.

No se concede autorización para usar, copiar, modificar, publicar, distribuir,
sublicenciar, vender ni crear obras derivadas de este software, total o
parcialmente, sin autorización previa y escrita de su titular. El acceso al código
fuente no concede licencia ni transfiere derechos de propiedad intelectual.

Los componentes de terceros que este proyecto utiliza conservan **sus propias
licencias** y derechos; este aviso no modifica ni sustituye sus condiciones.

El texto completo está en [`LICENSE`](LICENSE).
