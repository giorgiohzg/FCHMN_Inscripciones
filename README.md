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

- Node.js **22.22.2 o posterior de la serie 22, 24.15 o posterior, o 26+**. Es lo que exige el árbol completo: `jsdom` 30.0.1 (frontend) pide `^22.22.2 || ^24.15.0 || >=26.0.0`, y el backend
  declara `^22.13.0 || >=24` (su producción ya exigía Node ≥22). Las imágenes Docker usan `node:22.23.4-alpine3.24` fijada por digest (Node 22.23.4; la web, además, `nginx:1.30.6-alpine3.24`). Con un Node anterior `npm install` emite advertencias `EBADENGINE`
  (`engine-strict` no está activado, así que no bloquea).
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
docker compose --profile mantenimiento run --rm migrate node dist-seed/prisma/seed-admin.js   # UNA vez
docker compose up -d
```

**Actualización:**

```bash
docker compose --profile mantenimiento run --rm migrate prisma migrate deploy --schema=/app/prisma/schema.prisma
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
> Vite la incrusta en el bundle. Apuntar a otro backend exige reconstruir. Además, la política de seguridad de contenido de la
> web debe admitir ese destino, y se declara **aparte**: `CSP_CONNECT_SRC` lista **orígenes**
> (`esquema://host[:puerto]`, sin ruta), mientras que `VITE_API_URL` puede llevar ruta. Docker
> Compose lee ambas del entorno o del `.env` de Compose (el `CSP_CONNECT_SRC` por omisión es
> `'self' http://localhost:3000`, el uso local):
>
> | `VITE_API_URL` (al construir) | `CSP_CONNECT_SRC` (al arrancar) |
> |---|---|
> | sin definir (uso local) | sin definir |
> | `/api` (API bajo el mismo origen) | `'self'` |
> | `https://api.ejemplo.cl/api` | `'self' https://api.ejemplo.cl` |
>
> ```bash
> VITE_API_URL=https://api.ejemplo.cl/api CSP_CONNECT_SRC="'self' https://api.ejemplo.cl" docker compose up -d --build frontend
> ```
>
> Si no coinciden, el contenedor **no arranca** y el registro dice por qué.

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
| POST | `/auth/logout` | Termina la **sesión completa** de esa cookie y **la borra**: su JWT deja de valer de inmediato | Cookie de sesión (su ausencia no es error) |
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
- **JWT de acceso** (15 min por defecto) + **refresh token opaco con rotación** (7 días por
  defecto), ambos dentro de una **sesión** (`refresh_sessions`) identificada por el `sid` del
  JWT. Cada petición autenticada comprueba esa sesión, sin caché, así que terminarla tiene
  efecto inmediato. Código en `backend/src/modules/auth/sessions.ts`; despliegue y reversión
  en [docs/operacion/corte-de-sesiones.md](docs/operacion/corte-de-sesiones.md).
  - **Duración absoluta:** `SESSION_ABSOLUTE_HOURS` (8 por omisión) desde la creación, y
    renovar no la extiende. No es un cierre por inactividad: la renovación proactiva del
    frontend es un temporizador y no prueba actividad humana.
  - **Se clasifica primero la sesión y después el token.** Token desconocido, sin sesión o
    de una sesión terminada o vencida: 401, sin efectos sobre nadie más. Token ya rotado en
    una sesión **activa**: es un reuso, y termina **solo esa sesión**. `replaced_by` por sí
    solo no basta, porque un token rotado puede ser de una familia que terminó legítimamente,
    y una cookie antigua no debe cerrar sesiones nuevas.
  - **Alcance:** el logout termina su sesión, aunque el token presentado ya esté rotado. El
    cambio de contraseña termina todas y crea una. Restablecer credenciales, bloquear,
    inhabilitar, eliminar y retirar el acceso administrativo terminan todas. Reactivar una
    cuenta no revive ninguna.
  - **Un solo orden de bloqueos:** `persons`/`clubs` (solo operaciones administrativas) →
    `users` → `refresh_sessions` → `refresh_tokens`. Las transacciones de sesión (login,
    refresh, logout, cambio de contraseña e intento fallido) usan `READ COMMITTED` y plazos
    explícitos; las operaciones administrativas de **personas** que pueden quitar un
    administrador (bloquear, inhabilitar, eliminar y retirar el acceso) conservan
    `Serializable` por la guarda del último administrador y pueden responder un 409 reintentable (ver
    [docs/seguridad/PLAN_SEGURIDAD.md](docs/seguridad/PLAN_SEGURIDAD.md)). Argon2 queda fuera de los bloqueos, y lo verificado se revalida bajo bloqueo comparando
    el hash leído: una credencial sustituida no emite sesión ni suma un intento fallido, y un
    bloqueo administrativo, una inhabilitación o una eliminación concurrentes prevalecen.
- **Fase 2 de seguridad (API desplegada en producción desde `6d2dae5`; validada en local y en la CI):**
  - **`Cache-Control: no-store` en toda respuesta de la API**, incluidos errores, rutas
    inexistentes (404), el límite de solicitudes (429), la autenticación, el CSRF y las
    descargas de reportes y de Team Manager. Es un hook `onSend` registrado antes que los
    módulos; no cambia cuerpos, códigos, tipos de contenido ni nombres de archivo.
  - **Un fallo inesperado ya no publica su texto.** En la carga masiva de personas, la
    asignación masiva de nadadores y la importación de competencias solo se responde lo que el
    sistema escribió para quien opera (validaciones y conflictos de dominio, incluidos los
    errores de la base que el sistema sabe traducir); el resto devuelve un mensaje genérico y
    deja en el registro interno una línea estructurada con la clase y el código del error,
    sin su mensaje ni su traza (`backend/src/shared/errorPublicable.ts`). Los analizadores
    `.ev3` y `.hyv` lanzan `ValidationError` para sus errores previstos; un `TypeError` u otro
    `Error` ya no se publica solo por haber ocurrido durante la interpretación.
  - **Contrato del login.** Usuario inexistente o eliminado, contraseña incorrecta,
    incoherencia entre la persona y su cuenta (persona eliminada o estados que no se
    corresponden) y bloqueo temporal **vigente** (aunque la contraseña sea la correcta): un 401
    genérico, con el mismo código y mensaje, sin `lockedUntil`. Cuenta inhabilitada o
    bloqueada por un administrador —sola, o junto a su persona con el mismo estado, que es lo
    que dejan «bloquear» e «inhabilitar» persona—: el motivo se revela solo tras comprobar
    una contraseña correcta y revalidarla frente al hash vigente, con la persona releída bajo
    bloqueo. Un bloqueo temporal vencido sigue su flujo de la Fase 1. Ya no hay un 423 `ACCOUNT_LOCKED` en el login. Donde no hay un hash real que
    comprobar se hace una **verificación ficticia de Argon2** (hash calculado una vez por
    proceso, secreto aleatorio, resultado descartado: no puede autenticar a nadie). Eso
    elimina el camino que se saltaba el cálculo; **no iguala los tiempos de respuesta**, que
    conservan diferencias residuales. El límite por IP, los contadores, el bloqueo por cuenta,
    la auditoría y S10 no cambian. En producción solo se observaron `/api/health`, `/api/ready`
    y `/api/auth/me` sin credenciales (todas con `no-store`); lo demás se validó en local y en la CI.
- **Fase 3 de seguridad (cerrada: desplegada en `fchmn-web` desde `1641004`):** **cabeceras de
  seguridad en la web** (Nginx del frontend): `Content-Security-Policy` estricta
  (`default-src 'none'`, `script-src`/`style-src`/`img-src`/`font-src` en `'self'`,
  `frame-ancestors 'none'`, sin `unsafe-inline` ni `unsafe-eval`), `X-Frame-Options: DENY`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` y HSTS igual al de la API,
  sin `preload`. Van en un fragmento (`frontend/nginx/snippets/`) incluido solo en las
  ubicaciones estáticas, con `always`, y **no** en `/api/`, que ya recibe las suyas. El
  `connect-src` sale de la variable de **arranque** `CSP_CONNECT_SRC` (`'self'` por omisión,
  que sirve con la API bajo el mismo origen, `VITE_API_URL=/api`); Docker Compose la declara con
  `'self' http://localhost:3000` por omisión y se puede sobrescribir (ver la tabla junto a `VITE_API_URL`). No es `API_INTERNA` (la dirección de Nginx hacia la API). Un valor
  inválido, o incoherente con el `VITE_API_URL` compilado, **impide arrancar** el contenedor con
  un mensaje. Comprobada con la imagen real y un navegador real **contra una API simulada**
  (0 violaciones de CSP) y, ya en producción, con las cabeceras y la carga pública de `/login`
  comprobadas (sin pruebas autenticadas). Detalle y límites en
  `docs/seguridad/PLAN_SEGURIDAD.md`.
- **Fase 4 de seguridad (cerrada: desplegada en `fchmn-api` desde `4317e0f`):** **límites
  de la carga masiva por Excel**. El análisis corre en un **proceso hijo** con el entorno vacío, sin
  base de datos, con el montón acotado y un plazo de 60 s que lo mata de verdad. Antes de ExcelJS se
  inspecciona el ZIP contando los bytes reales al descomprimir (4 MB comprimido; 16 MB por entrada,
  32 MB en total) y se mide el libro: hojas, filas, índices, celdas y los rangos que ExcelJS recorre
  celda por celda, con cada coordenada dentro de los límites aunque el área sea pequeña. Los nombres
  de las entradas deben coincidir entre el directorio central y el encabezado local, y ser canónicos:
  así, todo lo que ExcelJS lea como hoja, libro o cadenas se ha inspeccionado. Tras cargar se
  comprueban las dimensiones efectivas. Admite hasta 10.000 personas por archivo; lo que excede se
  rechaza entero, sin escribir nada. Hay **una sola carga activa por instancia**: la segunda recibe 409, sin cola, y la
  garantía es por proceso, no entre réplicas. La escritura fila por fila no cambió. Comprobado con
  datos sintéticos, también con el backend compilado en la imagen con 0,5 CPU y 512 MB. En producción
  solo se observó la disponibilidad (`/api/health` y `/api/ready` operativos, `/api/auth/me` sin
  credenciales con 401, todos con `no-store`); **no se probaron cargas ni importaciones allí**. Una plantilla con personas sintéticas, editada y guardada por **Microsoft Excel
  16.0 (compilación 20430)**, pasa con los límites de producción, también con formato o ancho
  aplicado a toda la hoja (`<col>` hasta 16.384, con tope propio; celdas y referencias siguen en
  1.024 columnas). Medido en la imagen con 0,5 CPU y 512 MB: unos 45 MB más con 16 hojas con ese
  formato. **No** se probaron LibreOffice, Google Sheets ni otras versiones de Excel. Diseño,
  calibración y riesgos en `docs/seguridad/PLAN_SEGURIDAD.md`.
- **SEC-02: los reportes no entregan el RUN (cerrada: desplegada en web y API desde `3cf1aaf`).**
  Ni la pantalla de Reportes, ni el JSON, ni el CSV, el XLSX o el PDF muestran el RUN, para ningún rol,
  administrador incluido; los integrantes de relevo salen solo por nombre. La vista agrupada entrega
  `personId`, un identificador **interno** asociado a una persona (**no anónimo**), como clave estable de
  cada fila, porque el nombre puede repetirse. El RUN sigue almacenado y desempata el orden por dentro.
  **Team Manager no cambió**: sus `.CL2` y `.HY3` conservan el RUN (mismas huellas que antes). **Transición:**
  la web nueva funciona con la API anterior y con la nueva, pero una pestaña con la web **antigua** contra la
  API nueva mostraría «(undefined)», así que se desplegó primero la web, se recargaron las pestañas y después
  la API. **Evidencia:** el JSON, el CSV, el XLSX y el PDF sin RUN, y el RUN conservado en Team Manager, se
  validaron con datos sintéticos, en la base desechable y en la CI, **sin comprobación funcional de esas
  salidas en producción**; en producción, Render informó ambos servicios Live y las consultas HTTP comprobaron
  disponibilidad, y el usuario comprobó la pantalla de Reportes sin RUN. Detalle en `docs/seguridad/PLAN_SEGURIDAD.md`.
- **SEC-01: topes en las listas JSON (cerrada: desplegada en `fchmn-api` desde `120e29d`).** Las 11 listas de
  9 rutas (`personIds` de relevos y de asignación masiva, delegados y entrenadores de un club, `categoryIds`, reordenamientos y las decisiones
  de relevo de la importación de Meet Events) tienen un tope de longitud que se comprueba **antes** de validar
  sus elementos (`listaAcotada`; el `.max()` de Zod 3 no lo hace): relevos 8, asignación masiva 10.000, 50 delegados y 50 entrenadores,
  100 categorías, 1.000 reordenamientos y 500 decisiones. Cada ruta JSON tiene además un `bodyLimit` (4 KiB, 512 KiB, 32 KiB, 16 KiB y 256 KiB) que
  rechaza con 413 antes de autenticar. El multipart de analizar e importar Meet Events limita campos (64 KiB), cantidad (4 campos, 1 archivo, 6 partes)
  y **rechaza los campos truncados**, que el plugin entrega cortados sin fallar; el máximo global del archivo (15 MB) no cambió. **El tope de 8 en
  relevos es un límite técnico nuevo** (un tipo con más de 8 nadadores no podría inscribirse hasta subirlo) y **10.000 asignaciones no garantizan una
  duración determinada**. Se validó en local y en la CI con datos sintéticos, y está desplegada en `fchmn-api` (Live, Auto-Deploy Off); en producción solo se observó disponibilidad, **sin pruebas funcionales de los límites**. SEC-01 mitiga las rutas identificadas y **no elimina el aviso de Zod**; SEC-03 sigue pendiente. Detalle y riesgos en `docs/seguridad/PLAN_SEGURIDAD.md`.
- **SEC-03, entrega A: actualizaciones compatibles del backend (cerrada dentro de su alcance: desplegada solo en `fchmn-api` desde `dab3690`).** `fastify` 5.12.3 → 5.12.8, `@fastify/swagger-ui` 6.1.3 y sus
  transitivas dentro de rango (`@fastify/static` 10.1.10 y, con él, `glob` 14, `minimatch` 11, `fast-uri` 4.2.3 y 3.1.9, `brace-expansion`); los `override` de `uuid` y `unzipper` no cambian. En
  producción el único aviso que queda es **`zod`** (entrega C); `vite`, `vitest`, `esbuild`, `tinypool` y el `minimatch` de `eslint` siguen como avisos de desarrollo. Las candidatas de la API y de
  mantenimiento se construyeron y sus avisos de terceros se regeneraron desde inventarios extraídos de las imágenes (la sonda ahora recorre también los `node_modules` anidados: 19 paquetes más por artefacto, contrastados con una enumeración independiente del árbol instalado). (Estado al cerrar A; lo posterior consta en las viñetas de B y C.) **SEC-03 no está completa**. **Despliegue:** solo `fchmn-api` (Render informó éxito y Live; Auto-Deploy Off); la web y el servicio de mantenimiento **no** se desplegaron, y los artefactos de
  mantenimiento del repositorio no son su actualización. En producción solo se observó disponibilidad y el 401 sin credenciales, **sin pruebas funcionales**. Las construcciones de imágenes y sus inventarios
  se verificaron en local, no en CI. Detalle y riesgos en `docs/seguridad/PLAN_SEGURIDAD.md`.
- **SEC-03, entrega B: Vite, Vitest y herramientas (publicada en el repositorio, validada en local y desplegada: API en `64e2122` y web en `2de9dea`).** `vite` 5.4.21 → 7.3.7 (en el backend, ahora `devDependency` explícita), `vitest` y `@vitest/coverage-v8` 1.6.1 → 4.1.12 en ambos proyectos,
  y transitivas dentro de rango (`undici` 8.12.4, `source-map-js` 1.2.2, el `zod` de lint del frontend 4.6.7); `@vitejs/plugin-react` 4.7.0 y `jsdom` 30.0.1 se conservan. Ninguna versión de producción cambia. Se adaptaron las configuraciones
  (Vitest 4 retiró `coverage.all`), el orden de un par de `afterEach`, la firma de `Mock` y los tiempos de espera de tres pruebas pesadas (el recorrido optimizado de carpetas prohibidas sigue enlaces, con guardia de ciclos), se fijó en `vite.config.ts` el objetivo de navegadores que aplicaba Vite 5.4.21 (`es2020`, `edge88`, `firefox78`,
  `chrome87`, `safari14`; sin polyfills y sin probarlo en navegadores reales), y se actualizaron los `engines` y los requisitos de Node. **No se presenta el cambio de pool como
  corrección del pánico intermitente de Prisma.** Pasaron la suite unitaria y la de integración del backend, la del frontend y su construcción; en esa entrega no se construyó ninguna imagen ni se desplegó nada; el despliegue se hizo después, con la web en `2de9dea` y la API en `64e2122` (ver la viñeta de C). Sigue pendiente el aviso de desarrollo de `minimatch` de `eslint`. Detalle y riesgos en `docs/seguridad/PLAN_SEGURIDAD.md`.
- **SEC-03, entrega C: Zod del backend 3.25.76 → 4.6.7 (cerrada: API en `64e2122`; mantenimiento y web en `2de9dea`).** Cierra el aviso GHSA-mrhx-c7xc-m3w5, el último de producción del backend. El bloqueo cambia solo en `zod`. Se conservan los mensajes personalizados en español, `.flatten()` y su forma `{formErrors, fieldErrors}`, y
  los identificadores siguen aceptándose como antes (`z.guid()`). Zod 4 trae cambios silenciosos que se corrigieron: ignora `errorMap`/`required_error`/`invalid_type_error` y aplica los valores por omisión dentro de `.partial()`, de modo que los esquemas de actualización de clubes y piscinas ya no derivan de los de creación (editar sin
  los indicadores no los restablece; se comprueba por HTTP contra la base desechable). SEC-01 se conserva íntegra (`listaAcotada` incluida). Pasaron las suites unitaria (67 archivos) y de integración (54) del backend; las imágenes candidatas de la API y de mantenimiento se construyeron en local y su inventario cambia solo en `zod`. **Desplegada a mano en `fchmn-api`** (`dab3690` → `64e2122`, despliegue [`dep-dbnkbotg1s2s73cupeeg`](https://dashboard.render.com/pserv/srv-dbh4ih4ipgvc73dore80/deploys/dep-dbnkbotg1s2s73cupeeg), «Deploy succeeded» y Live, Auto-Deploy Off; CI 42381732030 en éxito). En producción solo se observó disponibilidad (`/api/health` y `/api/ready` 200, `/api/auth/me` 401 sin credenciales, todas con `Cache-Control: no-store`); la validación funcional fue local y en la CI. **Despliegue conjunto posterior (a mano, Auto-Deploy Off):** `fchmn-mantenimiento` (Cron Job) pasó de `b920893` a `2de9dea`, despliegue [`dep-dbnl1k49v7es73d2mu10`](https://dashboard.render.com/cron/crn-dbh500bl550s73c5n2o0/deploys/dep-dbnl1k49v7es73d2mu10), construcción exitosa (el servicio queda con `2de9dea` como última construcción exitosa), Docker Command vacío, programación `0 6 1 1 *` y Auto-Deploy Off sin cambios; **no se ejecutó el cron** (el historial seguía en 26 ejecuciones antes y después). `fchmn-web` pasó de `3cf1aaf` a `2de9dea`, despliegue [`dep-dbnla79srm7s739ot2h0`](https://dashboard.render.com/web/srv-dbh48scs728c73arlf8g/deploys/dep-dbnla79srm7s739ot2h0), «Deploy succeeded» y operativa, Auto-Deploy Off; ahora sirve el paquete `index-Cw6aswfZ.js` (antes `index-DwjQ-YM9.js`), compilado con Vite 7. Vite es una herramienta de construcción, no un servidor que se ejecute en producción. `2de9dea` solo difiere de `64e2122` en documentación: `backend/` es idéntico; no se afirma identidad binaria entre imágenes. **Comprobaciones HTTP en la web (solo lectura, disponibilidad y cabeceras):** `/login` e `index.html` responden 200 con `Cache-Control: no-store`, la CSP con `connect-src 'self'` y sin `localhost`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` y `Referrer-Policy: no-referrer`; el JavaScript nuevo y su hoja de estilos responden 200 y el JavaScript trae dos líneas `Cache-Control` (`max-age=31536000` y `public, immutable`); la ruta del paquete anterior responde 404; `/api/ready` 200 y `/api/auth/me` sin credenciales 401, con `Cache-Control: no-store`. Sin pruebas funcionales autenticadas de esta actualización. **Limpieza local completada:** 41 contenedores temporales eliminados (28 `sec03-` y 13 `sec03c-`, todos detenidos) y los seis del proyecto preservados con su ID y estado, sin borrar imágenes ni volúmenes. El Deploy Hook de la API se regeneró tras su exposición en una salida de herramienta. Sigue abierto el aviso de desarrollo de `minimatch`. Detalle, expectativas cambiadas y límites en `docs/seguridad/PLAN_SEGURIDAD.md`.
- **SEC-03, override acotado de `minimatch` (publicado; validado localmente; CI del SHA por comprobar).** Solución **temporal** para el último aviso, de desarrollo (GHSA-g3hv-75wg-m249, `minimatch` `>=7.0.0 <11.0.1`): en ambos `package.json`, `overrides` que fijan `minimatch` en `11.0.5` solo bajo `eslint`, `@eslint/config-array` y `@typescript-eslint/typescript-estree`, sin override global ni cambio de padres; se conservan los de `uuid` y `exceljs.unzipper`. **En el backend se acepta la reubicación** de `minimatch` 11.0.5, `brace-expansion` 5.0.12 y `balanced-match` 4.0.4, que `glob` ya usaba en producción: pasan de `glob/node_modules` a la raíz (misma versión, integridad, contenido y licencia; cambian rutas y marcas y, con ellas, tres líneas de cada inventario de avisos, mientras los avisos generados no cambian). Con lint, tipos, comparación de diagnósticos y patrones, `npm audit` (0 avisos) y las imágenes de la API y de mantenimiento construidas en local, no queda ninguna copia en el rango afectado **en el árbol local**; el aviso era del árbol de herramientas del repositorio (las copias de producción ya estaban fuera del rango), y las instalaciones futuras incorporarán la reubicación aceptada sin que un nuevo despliegue sea requisito para cerrarlo. Publicado en `main`; la CI de su SHA se comprueba aparte. Cada clave se retira cuando el padre publicado resuelva por sí mismo una versión corregida (sin fecha prometida). Detalle y límites en `docs/seguridad/PLAN_SEGURIDAD.md`.
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
  *Limitación actual:* el identificador del ciclo se genera en el cliente, de modo que dos
  pestañas que arrancan por separado no se reconocen y cada una renueva por su cuenta. La
  serialización y la propagación del cierre no se ven afectadas. El backend ya tiene una
  identidad de sesión (`sid`), pero el frontend no la usa como ciclo.
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
- **«Cambiar contraseña» en la cabecera, para toda cuenta con sesión** (administración, club, personal, nadadores y cuentas con varios roles; **publicada y desplegada en `fchmn-web`, dentro de su alcance**). Es un enlace junto a «Cerrar sesión» que lleva a `/cambiar-password`, la misma ruta y el mismo flujo del cambio obligatorio (`ForceChangePasswordPage` → `AuthContext.changePassword` → `/auth/change-password`); no hay otro endpoint ni otro mecanismo. La pantalla distingue dos casos según `mustChangePassword`: **voluntario** (título «Cambiar contraseña», contraseña actual, nueva y confirmación, y «Cancelar», que vuelve al panel sin enviar nada) y **obligatorio** (aviso y restricción de siempre, **sin** «Cancelar»). La política de contraseñas, la comprobación de la contraseña actual, la coordinación entre pestañas, la renovación, el CSRF y la revocación de sesiones no cambian. Los intentos con una contraseña actual incorrecta se cuentan por sesión desde C-04 (ver «Intentos de cambio de contraseña por sesión»).
  - **Despliegue:** solo `fchmn-web`, de `6de4de3` a `973cacca46432240aa3cb1c8a91d28e2684b83e5` ([despliegue](https://dashboard.render.com/web/srv-dbh48scs728c73arlf8g/deploys/dep-dbp8gh3m8hqs73d5tgo0)). Render informó «Deploy succeeded» y Live, con Auto-Deploy Off. CI del código `42744737370`, éxito. **La API y el mantenimiento no se desplegaron.**
  - **Evidencia, por separado.** *HTTP observado:* `/login` y `/api/ready` con 200 y `/api/auth/me` sin credenciales con 401, los tres con `Cache-Control: no-store` y la CSP conservada; el paquete JS referenciado se sirve correctamente. Eso acredita disponibilidad y que se sirve el paquete nuevo, **no** el funcionamiento de la interfaz. *Validación funcional:* local y en la CI, con la autenticación **simulada** en las pruebas de interfaz; **no hubo prueba autenticada en producción**.
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
- **Limitador del login** (C-02, política B; **cerrada dentro de su alcance: migrada y desplegada en la API desde
  `b1b1c2a5d942e94dd0434bb60f6dc2b008aaeb61`** el 2026-11-11, validada en local y en la CI,
  **sin pruebas funcionales autenticadas de los límites en producción** y **sin una ejecución
  local completa en verde**; la web no se desplegó). `AUTH_LIMITER_SECRET` lo configuró el usuario y lo
  conserva fuera del repositorio. Sustituye al bloqueo temporal de la cuenta entera tras 5 intentos fallidos,
  que permitía a un tercero bloquear cualquier cuenta. Límites persistentes en PostgreSQL:
  5 fallos por **par** usuario–origen en 15 minutos (ventana deslizante), 50 fallos por
  **origen** por hora (ventana fija) y, con 20 fallos verificados de una **cuenta** en una
  hora, 60 minutos de protección en los que cada fallo de un par le impone su propia espera
  de 15 minutos sin afectar a otros orígenes. IPv6 se agrupa por `/64` solo para estas
  claves; la auditoría conserva la IP completa. Respuesta **429 uniforme** al limitar y
  **503** ante saturación o error técnico. Las claves se guardan solo como HMAC con
  `AUTH_LIMITER_SECRET`, que no se puede rotar todavía (la rotación requiere un
  procedimiento y una autorización posteriores). Retira `LOGIN_MAX_ATTEMPTS` y
  `LOGIN_LOCKOUT_MINUTES`; los bloqueos temporales antiguos se respetan hasta vencer y los
  administrativos se conservan. Siguen vigentes sus límites: las redes compartidas (el límite de
  origen puede afectar a usuarios legítimos tras una misma salida), los ataques distribuidos
  lentos y la capacidad y los parámetros, que no están calibrados en Render. Detalle, evidencia
  y reversión en `docs/seguridad/PLAN_SEGURIDAD.md` («C-02»).
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
  y más estricto en `/auth/*` (20 req/min, `RATE_LIMIT_AUTH_MAX`). Con C-02 (en producción),
  el login y las operaciones de sesión (`/auth/refresh`, `/auth/logout`, `/auth/me`…) tienen
  presupuestos **separados** (`RATE_LIMIT_SESION_MAX`, 60 por omisión), para que una ráfaga de
  logins no deje sin renovar las sesiones abiertas. El contador vive **en
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
- `IP_CLIENTE_FUENTE` decide de dónde sale la IP del cliente (`backend/src/shared/ipCliente.ts`):
  `socket` (valor por defecto, local y pruebas) usa el par TCP e ignora `X-Forwarded-For`,
  `X-Real-IP` y `CF-Connecting-IP`; `cf-connecting-ip` (Render) usa esa cabecera validada y
  normalizada, con respaldo al socket. Reemplaza a `TRUST_PROXY_HOPS`. **Desplegado en producción
  (API y web) desde `7860b1d377abd998f48ec938e73dfc28f62176ba`** (2026-11-11), con
  `IP_CLIENTE_FUENTE=cf-connecting-ip`; el mantenimiento, que seguía en `2c3552e`, se construyó
  después desde `b1b1c2a` para la migración de C-02. `TRUST_PROXY_HOPS=2` permanece configurada en la API, pero el código nuevo la ignora
  (no se ha retirado). La identificación de IP tiene una **validación acotada en producción**
  (un equipo y una red), no una garantía general. Evidencia, frontera de confianza y límites en
  `docs/seguridad/PLAN_SEGURIDAD.md` («IP del cliente»); C-02 está desplegada en la API desde `b1b1c2a` («C-02»).

## Endpoints del Módulo 2 — Personas

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/persons` | Lista personas (búsqueda por RUN/nombre, filtro por rol/estado, paginado). Con `orden=apellidos` o `apellidos_desc` (listado de Personas) ordena por apellido paterno, materno y nombres en el servidor, antes de paginar; sin `orden`, el orden de siempre | `persons:read` |
| GET | `/persons/:id` | Detalle de una persona (incluye roles y credenciales) | `persons:read` |
| POST | `/persons` | Crea una persona (valida RUN chileno). El nombre de usuario es **opcional** y no se genera ni se crea cuenta. **No acepta `roles`**: son derivados, y enviarlos se rechaza con 400. `clubId` opcional («Asignación a club»): crea además su membresía activa desde hoy en Chile, en la misma transacción (ver «Alta de persona con asignación a club») | `persons:write` |
| PUT | `/persons/:id` | Actualiza datos (RUN no editable; nombre de usuario editable solo sin cuenta vigente). **Tampoco acepta `roles`** | `persons:write` |
| DELETE | `/persons/:id` | Eliminación lógica | `persons:write` |
| POST | `/persons/:id/block` | Bloquea persona y su cuenta de acceso si tiene | `persons:write` |
| POST | `/persons/:id/disable` | Inhabilita persona y su cuenta de acceso si tiene | `persons:write` |
| POST | `/persons/:id/reactivate` | Reactiva persona y su cuenta de acceso si tiene | `persons:write` |
| PUT | `/persons/:id/admin-access` | Concede o retira permisos de administrador. Exige además el **rol** `admin` | `persons:write` + rol `admin` |
| POST | `/persons/:id/credentials` | Crea credenciales de acceso (contraseña temporal, un solo uso en la respuesta). Cuerpo opcional `{ username }` | `persons:write` |
| POST | `/persons/:id/credentials/reset` | Restablece la contraseña (revoca sesiones activas) | `persons:write` |

**Permisos de administrador por persona.** `persons.admin_access` guarda la
*intención*; quien concede el acceso es la fila de `user_roles` con el rol
`admin`, que es lo único que la autorización consulta en cada solicitud. La
marca se puede poner antes de que la persona tenga cuenta —entonces no se crea
ninguna credencial— y `POST /persons/:id/credentials` la aplica al crearla, sin
exigir ningún rol funcional. Retirarla quita solo el rol administrativo, termina
las sesiones de esa cuenta y deja intactos los demás roles. Ninguna
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
- **Nombre de usuario opcional (etapa 9).** Registrar a una persona o un club
  **no** exige nombre de usuario ni crea cuenta: la ausencia es `NULL` (nunca una
  cadena vacía; lo impiden `persons_username_no_vacio` y `clubs_username_no_vacio`)
  y no se genera ningún nombre automáticamente. Mientras el titular **no tenga una
  cuenta vigente** —activa, bloqueada o inhabilitada—, el nombre se puede asignar,
  cambiar o quitar desde su ficha (`PUT` con `username`; `null`, vacío o espacios lo
  quitan; omitirlo lo conserva). Con cuenta, el nombre queda **bloqueado**: el
  servicio lo rechaza y, por debajo, `titular_forbid_rename_con_cuenta`.
  `POST …/credentials` acepta un cuerpo opcional `{ "username": "…" }`: si viene,
  se asigna al titular **en la misma transacción serializable** que crea la cuenta;
  si no, se usa el guardado; sin ninguno, **400 sin escribir nada**. Cualquier
  fallo revierte todo y el nombre sigue editable. Restablecer la contraseña no
  cambia ni desbloquea el nombre. La reserva global (`username_reservations`)
  ignora `NULL` y libera el nombre anterior al cambiarlo o quitarlo (migración
  `20261102010000_username_opcional`, comprobación `username-vacio` del
  preflight). El formato (4 a 30 caracteres: letras, números, puntos y guiones)
  lo exige la API; la base solo impide la cadena vacía. La carga masiva por Excel
  admite la columna B vacía.
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
| GET | `/clubs` | Lista clubes (búsqueda por nombre/razón social/RUT, filtro por estado y por **personalidad jurídica** —`si` / `no`—, paginado). Cada club trae `nadadores`: personas distintas con membresía activa en él, sin eliminadas, pendientes, historial ni personal (ver «Clubes y nadadores, orden del plantel y edición de fechas») | `clubs:read` |
| GET | `/clubs/:id` | Detalle de un club (incluye su personal —delegados, entrenadores y representante legal— y las credenciales) | `clubs:read` |
| POST | `/clubs` | Crea un club (RB-02: RUT obligatorio solo si tiene personalidad jurídica; `hasLegalStatus` es obligatorio y solo admite `true` o `false`). El correo y el nombre de usuario son opcionales | `clubs:write` |
| PUT | `/clubs/:id` | Actualiza datos del club. Omitir `email` lo conserva; `null`, vacío o solo espacios lo elimina. `username`, igual, solo sin cuenta vigente | `clubs:write` |
| DELETE | `/clubs/:id` | Eliminación lógica | `clubs:write` |
| POST | `/clubs/:id/block` | Bloquea el club y su cuenta de acceso si tiene | `clubs:write` |
| POST | `/clubs/:id/disable` | Inhabilita el club y su cuenta de acceso si tiene | `clubs:write` |
| POST | `/clubs/:id/reactivate` | Reactiva el club y su cuenta de acceso si tiene | `clubs:write` |
| POST | `/clubs/:id/credentials` | Crea credenciales de acceso del club. Cuerpo opcional `{ username }`, igual que en personas | `clubs:write` |
| POST | `/clubs/:id/credentials/reset` | Restablece la contraseña del club | `clubs:write` |

### Reglas aplicadas en el Módulo 3

- **RB-02 — la personalidad jurídica tiene DOS estados** (`true` / `false`):

  | `hasLegalStatus` | Significado | RUT |
  |---|---|---|
  | `true` | tiene personalidad jurídica | **obligatorio**, validado |
  | `false` | no tiene | se descarta |

  El campo es **obligatorio y sin valor por omisión** en el contrato público:
  `null`, omitirlo o enviar otra cosa responde **400** con un mensaje que lo
  explica, sin escribir nada. El filtro del listado solo admite `si` o `no`;
  `pendiente` responde 400. En la interfaz, un club nuevo comienza con «No tiene»
  seleccionado (es solo la selección inicial; el servidor no asume nada).

  El RUT se valida (formato + dígito verificador) con el mismo algoritmo del RUN
  de personas (`shared/run.util.ts`). Cubierto en `clubs.schemas.test.ts`,
  `clubs-personalidad-juridica.test.ts`,
  `personalidad-juridica-transiciones.integration.test.ts` y
  `personalidad-juridica-api.integration.test.ts`.

  > **Historia: el estado «pendiente de verificar» (2026-10-31 → 2026-11-02).**
  > Entre ambas fechas existió un tercer estado, `null`. Se retiró por decisión del
  > usuario, y la migración `20261102020000_personalidad_juridica_sin_pendiente`
  > (**etapa 10a**) convirtió los clubes pendientes en «No tiene» y **eliminó el RUT
  > de esos mismos clubes**. Esto es convertir un dato *desconocido* en una
  > afirmación *negativa*: no es una verificación, y así debe leerse. La migración:
  > corre en una transacción explícita; **se detiene entera, sin escribir nada, si
  > un club pendiente tiene representante legal** (no retira nombramientos; ver la
  > comprobación `club-pendiente-con-representante-legal` del preflight); deja
  > **una fila de auditoría por club** (`CLUB_LEGAL_STATUS_CONVERTED`: estado
  > anterior, nuevo y si se eliminó un RUT, **nunca su valor**); y no toca los RUT
  > de otros estados, las razones sociales, los nombramientos, los roles ni los
  > permisos. **No existe ninguna tabla con los RUT retirados**: recuperarlos, si
  > hiciera falta, depende del respaldo previo protegido del procedimiento de
  > despliegue.
  >
  > **Cierre (etapa 10b).** La migración `20261103030000_personalidad_juridica_obligatoria`
  > declara `clubs.has_legal_status` **`NOT NULL`, sin valor por omisión** en la base, y
  > Prisma pasa a `Boolean`. **No convierte ni borra nada**: si al migrar queda algún
  > `NULL`, se **detiene** con el detalle (cuántos y cuáles clubes, también los
  > eliminados lógicamente) y sin modificar ninguna fila; convertir pendientes es
  > trabajo de la 10a. La API sigue exigiendo un booleano explícito en cada alta y
  > edición (`null` u omitirlo responde 400), y el formulario conserva «No tiene» como
  > valor inicial. **Se despliega junto con la 10a**, en el mismo `migrate deploy` y
  > antes de la API y la web nuevas: un cliente anterior que enviara `null` fallaría en
  > la base.
- **Correo del club opcional.** `clubs.email` es anulable: la ausencia es **`NULL`**,
  nunca una cadena vacía ni un correo provisional (lo impide la restricción
  `clubs_email_no_vacio`, que también rechaza solo-espacios y tabuladores). Al
  crear, omitirlo o enviar `null`, `""` o espacios deja `NULL`. Al editar:
  **omitirlo conserva el valor**; `null`, `""` o solo espacios **lo elimina**; un
  correo informado se recorta y debe tener formato válido. Las respuestas pueden
  traer `"email": null`. La migración `20261102000000_club_email_opcional` no
  modifica ningún correo existente —tampoco los provisionales— y se **detiene**
  con el detalle si hay un club con el correo vacío (comprobación
  `club-email-vacio` del preflight): esos casos se corrigen a mano, antes de migrar.
  Pasar la columna a anulable exige desplegar la migración **antes** que el código
  nuevo, y una API o un cliente anteriores pueden fallar al leer un club sin
  correo (ver el plan de despliegue de las etapas 8 a 10).
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
  - Solo se puede designar con personalidad jurídica (`true`). Con `false` la
    designación se **rechaza** con un mensaje que lo explica — no se descarta en
    silencio.
  - **Un representante designado BLOQUEA el cambio de estado.** Pasar de `true` a
    `false` se rechaza mientras exista uno, y hay que retirarlo expresamente
    primero (`legalRepresentativePersonId: null`, con el estado todavía en
    `true`). Son dos pasos a propósito.

    > **Esto cambió el 2026-10-31.** Antes, poner el indicador en `false`
    > retiraba el nombramiento y desactivaba el rol de acceso de esa persona
    > **sin avisar**. Ahora quitar el acceso de una persona es siempre una
    > decisión visible. La conversión de la etapa 10a respeta la misma regla: no
    > retira ningún nombramiento, y se detiene si encuentra uno en un club pendiente.
  - Como máximo **uno por club** (a diferencia de delegados y entrenadores).
  - El rol funcional (`person_roles`) y el rol de acceso (`user_roles`) se **derivan**
    del nombramiento: se activan al nombrarlo y se desactivan al retirarlo o
    reemplazarlo — nunca por un cambio de estado del club.

  La equivalencia de permisos se verifica en `tests/rbac.definitions.test.ts` y el
  ciclo de vida completo en `tests/legal-representative.integration.test.ts`.
- **A-03**: una credencial de acceso por club (mismo patrón que personas, `ownerType=club`).
- Bloquear/inhabilitar/reactivar un club propaga el mismo estado a su cuenta de usuario.
- **El estado del club se aplica a quien actúa por él** (auditoría AUD-04/AUD-11; **cerrada dentro de su
  alcance**: API desplegada desde `d877686`, probada en local y en la CI). La autorización efectiva se resuelve en un solo
  lugar (`resolverAutorizacionEfectiva`, en `modules/auth/authorization.ts`), el mismo para el
  login, la renovación, el cambio de contraseña y cada solicitud:
  - La cuenta de un club bloqueado, inhabilitado o eliminado no inicia sesión, no renueva y no
    opera, aunque su fila de usuario figure activa.
  - El personal (delegado, entrenador, representante legal) de un club no activo **conserva su
    sesión y su acceso personal**, pero queda sin club y sin los roles de personal: sin otro rol
    no tiene permisos; si además es nadador, opera exactamente como nadador. Es una reducción de
    la autorización efectiva —`user_roles` y `club_staff` no cambian— y al reactivar el club la
    siguiente solicitud recupera todo, sin volver a iniciar sesión. No se revoca ninguna sesión
    del personal ni de administradores; el administrador no cambia.
  - Crear credenciales de un club no activo se rechaza (400). Restablecerlas deja la cuenta
    `active` si el club está activo (como siempre) y con el estado del club si no lo está; en
    ambos casos `lockedUntil` nulo y `failedLoginAttempts` en 0.
  - **Despliegue:** `fchmn-api` pasó de `64e2122` a `d877686` (despliegue [`dep-dbnu7hu417fc73ep19v0`](https://dashboard.render.com/pserv/srv-dbh4ih4ipgvc73dore80/deploys/dep-dbnu7hu417fc73ep19v0), exitoso y Live, Auto-Deploy Off; CI del código 42437889969 en éxito). Web y mantenimiento no se desplegaron. En producción solo se observó disponibilidad (`/api/health` y `/api/ready` 200, `/api/auth/me` sin credenciales 401, todas con `Cache-Control: no-store`); la validación funcional fue local y en la CI, sin pruebas funcionales en producción.
  - Detalle y pruebas en `docs/seguridad/PLAN_SEGURIDAD.md` («AUD-A»).
- **Correcciones de baja severidad de la API** (auditoría AUD-03, AUD-05, AUD-07, AUD-15 y AUD-02; completadas dentro de su alcance: probadas en local, publicadas y desplegadas en `fchmn-api` desde `b02eff2`, Live; sin pruebas funcionales en producción):
  - **Registros:** la ruta de cada petición se escribe sin su cadena de consulta (ahí viajan las búsquedas por nombre o RUN) y los errores solo con una lista explícita de campos, sin mensaje ni valores; el `reqId` se conserva. Solo el registro de la aplicación: AUD-03 no queda resuelta en todas las capas. El de Nginx se corrige en AUD-B (más abajo, desplegada en la web; el registro de errores sigue pendiente), y los registros del proveedor no fueron inspeccionados ni se garantiza que se modifiquen.
  - **Personas ajenas:** quien no es administrador debe demostrar primero la pertenencia al plantel activo de su club; una persona de otro club y una inexistente reciben el mismo 403 genérico, sin nombre ni RUN (inscripción individual y relevos, al crear y al editar).
  - **Competencias en Borrador o Programada:** solo el administrador las ve también en sus pruebas, capacidad, elegibilidad, reportes y exportación a Team Manager, con estado efectivo y sin escribir; `visibleInRegistrationPanels` sigue controlando solo los desplegables de Inscripción, Relevos y Reportes (para quienes no son administradores).
  - **`GET /swimmer-assignments/current-club/:personId`** devuelve únicamente `{ club: { id, name } }` o `null`.
  - **ZIP:** el conteo de entradas se comprueba antes de materializarlas, y un ZIP dañado es un error controlado.
  - Detalle, cambios de contrato y límites en `docs/seguridad/PLAN_SEGURIDAD.md` («AUD-C»).
- **Imágenes base y registro de acceso de Nginx** (auditoría AUD-01 y AUD-03; completadas dentro de su alcance: validadas en local, publicadas y desplegadas desde `b02eff2` en `fchmn-api` y `fchmn-web` (Live) y construidas en `fchmn-mantenimiento`, cuyo cron no se ejecutó; CI 42529120274 en éxito): las bases pasan a **Node 22.23.4** (versión de seguridad de la rama 22 LTS) y a **Nginx 1.30.6** (última estable), con etiqueta y digest explícitos, sobre Alpine 3.24.4; no se migra a Node 24. `frontend/nginx/default.conf.template` declara un formato de registro de acceso JSON propio, **sin cadena de consulta ni `Referer`**, que reemplaza al `access_log` heredado de la imagen oficial (comprobado con la configuración efectiva y con un marcador sintético de búsqueda). Inventarios, fuentes y avisos de las tres imágenes regenerados con el procedimiento documentado (textos de licencia íntegros; verificadores en 0). Escaneo con Trivy: la web pasa de 215 a 1 aviso por versión; en la API y mantenimiento quedan 24, 23 del `npm` incluido en la imagen base y ninguno en las dependencias de la aplicación. **Riesgo residual:** esos avisos no están corregidos; se registran como riesgo condicionado (8 sin la condición de uso en el código de npm, 15 que exigirían ejecutar `npm` en la imagen con una entrada hostil, y `zlib` como posible falso positivo provisional, con 1.4-r0 recomendada como paso propio); el registro de errores de Nginx escribe la consulta cuando falla el upstream, y los registros del proveedor no fueron inspeccionados. Los 24 avisos son de las candidatas locales escaneadas, no de un escaneo de producción, cuyas versiones y paquetes efectivos no se inspeccionaron; en producción se comprobó disponibilidad, cabeceras, el aviso público y, de forma acotada, el registro de acceso de la web, sin pruebas funcionales. Detalle en `docs/seguridad/PLAN_SEGURIDAD.md` («AUD-B» y «Despliegue conjunto de AUD-B y AUD-C»).

- **zlib incorporada en Node 22.23.4** (evaluación documental, solo lectura; ningún cambio de código ni de imágenes): Node trae su propia zlib (`process.versions.zlib` observada localmente: `1.3.1-e00f703`), independiente del paquete zlib de Alpine, que no actualiza. Se revisaron el binding de Node, correcciones concretas de zlib 1.4 y los flujos del proyecto (XLSX, Meet Events y exportación de Team Manager). No se identificó una exposición concreta a las condiciones revisadas que justifique actualizar Node ahora. Se conserva un riesgo residual acotado; no es una garantía de seguridad ni una declaración de que toda la zlib incorporada esté corregida. Los casos de la variante optimizada de Chromium quedan indeterminados. Detalle y criterios de revisión futura en `docs/seguridad/PLAN_SEGURIDAD.md` («zlib incorporada en Node»).
- **npm y npx fuera de las imágenes que se ejecutan** (aviso residual de AUD-B; **retirada publicada y desplegada en la API y construida en mantenimiento, dentro de su alcance**): las etapas finales de la API, de migraciones y el alias de mantenimiento derivan de una etapa `ejecucion` sin la instalación global de npm ni sus enlaces; las etapas que construyen la conservan. El perfil `mantenimiento` de Compose usa `prisma migrate deploy --schema=/app/prisma/schema.prisma` y `node dist-seed/prisma/seed.js`, y el administrador inicial se crea con `node dist-seed/prisma/seed-admin.js`. Los bytes de npm **siguen en las capas inferiores** de la imagen; Yarn y Corepack no se retiraron, y los usos de npm/npx que pudiera tener Render están sin comprobar. SHA `dbdbda278b2193064a506e6955d1f59c66f83788`: API `c6580d3` → `dbdbda2` y mantenimiento `c6580d3` → `dbdbda2` (construido, cron sin ejecutar); la web no se redesplegó. **No se verificó por shell la ausencia de npm/npx en las imágenes de producción**; la evidencia es local. Detalle en `docs/seguridad/PLAN_SEGURIDAD.md` («npm fuera de las imágenes de ejecución»).
- **Campos del upstream en el registro de acceso de Nginx** (observabilidad de la incidencia 504; **publicada y desplegada en la web**): `fchmn_acceso` añade `upstream_status`, `upstream_connect_time`, `upstream_header_time` y `upstream_response_time`, siempre como **cadenas JSON** (pueden ir vacías, valer `-` o llevar listas de intentos). No añade direcciones, consultas, `Referer`, cookies ni tokens, y no arregla ni explica por sí sola la indisponibilidad: no identifica una dirección antigua. Web `c6580d3` → `6de4de3a5b73ed7b994cf5d64ff790b88159fa4d`; la API y el mantenimiento no se desplegaron. En producción solo se comprobó una petición normal; los fallos y reintentos se validaron en local, y la causa del 504 sigue indeterminada. Detalle en `docs/seguridad/PLAN_SEGURIDAD.md` («Campos del upstream en el registro de acceso»).
- **zlib del sistema a 1.4-r0** (AUD-B, aviso residual; **desplegada en la API y la web y construida en mantenimiento; versión efectiva del paquete en producción sin verificar**): las imágenes de la API, migraciones/mantenimiento y web instalan `'zlib>=1.4-r0'` sobre las mismas bases fijadas por digest (sin `apk upgrade` general; apk solo actualizó `zlib`). Versión efectiva `1.4-r0` (aports `bdf501c870a9`). La copia de zlib que Node incorpora (`process.versions.zlib` `1.3.1-e00f703`) **no cambia**, y los 23 avisos de `npm` siguen abiertos. SHA `c6580d33c0a9b1b3ba6d688a6a99b40085c08737`: API `d105823` → `c6580d3`, web `5d8d023` → `c6580d3` y mantenimiento `b02eff2` → `c6580d3` (construido, cron sin ejecutar). **No se verificó la versión de zlib realmente instalada en producción**; los Dockerfile exigen al menos 1.4-r0. **Incidencia pendiente de diagnóstico:** tras el despliegue de la API hubo una indisponibilidad transitoria (504 por la web), sin causa determinada. Detalle en `docs/seguridad/PLAN_SEGURIDAD.md` («zlib del sistema»).
- **Registro de errores de Nginx sin el mensaje original** (AUD-03, capa Nginx; **publicado y desplegado en la web, dentro de su alcance**): los errores de petición del servidor web ya no van a stderr con la línea de petición, la URI del upstream y el `Referer` (que llevan la consulta). Van por syslog UDP, solo dentro del contenedor (127.0.0.1:5140), a un servidor `stream` del mismo Nginx con njs (`frontend/nginx/nginx.conf` y `frontend/nginx/njs/registro-errores.js`; módulo ya instalado en la imagen, sin paquetes ni procesos nuevos), que escribe en stderr solo `canal`, `nivel`, `clase` y `errno` de una lista cerrada. Se pierde detalle de diagnóstico y UDP puede perder mensajes; el registro general, los registros del proveedor y los datos puestos en la ruta quedan fuera. AUD-03 no queda cerrada en todas las capas. Despliegue: `fchmn-web` de `5d0692f` a `6da7fd9cfd52e13f317bb3d913c5b26bbff77033` (Render: Deploy succeeded y Live, Auto-Deploy Off; CI `42628838096`, éxito); la API y el mantenimiento no se desplegaron. La protección funcional se probó solo en local con la imagen candidata; en producción solo se observaron el estado del despliegue, la disponibilidad y las cabeceras, sin provocar fallos ni inspeccionar registros. Detalle en `docs/seguridad/PLAN_SEGURIDAD.md` («Errores de Nginx»).
- **AUD-V y «Descancelar»** (completados dentro de su alcance: publicados, desplegados en API y web y probados en local y en CI):
  - **Estado:** Código publicado en `f697d6e`; corrección documental y SHA desplegado `d1058232bc761770088627d05c6ec393158cc005` (`d105823`); CI `42551118288`, éxito. Despliegue manual y único de `fchmn-api` y `fchmn-web`, de `b02eff2` a `d105823`, ambos Live, con Auto-Deploy desactivado. El mantenimiento permanece en `b02eff2`: no se construyó ni se ejecutó. Lo observado en Render es el commit y el estado Live; por HTTP solo se comprobaron disponibilidad (`/api/health`, `/api/ready`) y cabeceras. La validación funcional es la local y la CI; la interfaz se probó con pruebas simuladas y **no** hubo comprobación funcional autenticada ni exportaciones, descancelaciones ni otras acciones en producción. El CSV se probó solo en Excel 16.0 con configuración es-CL, sin generalizar a otros entornos. Los despliegues anteriores quedan como antecedentes. Siguen abiertos los avisos de imágenes y los registros del proveedor y de Nginx, y las decisiones pendientes.
  - **Fórmulas en el CSV de inscritos:** con Excel 16.0 en es-CL (separador `;`), abrir por doble clic el CSV evaluaba valores como `Club;=1+1;Z`. La exportación CSV neutraliza ahora también cada trozo que una planilla podría tomar como inicio de celda (tras `;`, `|`, tabulador o salto de línea, saltando espacios y comillas). Cambia solo `escapeCsvValue`; la neutralización compartida con XLSX no se toca. Sin cambios de separador, columnas ni estructura. Los casos ensayados ya no producen fórmulas en Excel (doble clic e importación con coma, `;` y tabulador); el BOM y los acentos siguen sin corregirse.
  - **«Descancelar»:** `POST /competitions/:id/uncancel`, solo con el rol `admin` (comprobado en la API además del permiso), lleva una competencia `cancelada` a `borrador`, siempre. Conserva sus datos, no abre inscripciones y audita `COMPETITION_UNCANCEL` en la misma transacción; rechaza otros estados y las repeticiones o solicitudes concurrentes. La página de la competencia muestra el botón solo a administración y con la competencia cancelada, con confirmación.
  - Detalle y límites en `docs/seguridad/PLAN_SEGURIDAD.md` («AUD-V» y «Descancelar»).
- **Intentos de cambio de contraseña por sesión** (C-04; **cerrada dentro de su alcance: migrada y desplegada en producción**, validada en local y en la CI, **sin prueba autenticada del límite en producción**): `/auth/change-password` cuenta las contraseñas actuales incorrectas de **cada sesión**, durante toda su vida (el refresh no la reinicia). En la quinta termina **solo esa sesión** —la cuenta, las demás sesiones y los logins futuros no cambian— y la interfaz vuelve al login con el motivo; los cuatro primeros fallos no expulsan. Rige igual para el cambio obligatorio y el voluntario. El `sid` sale de la sesión que verificó el servidor, nunca de la solicitud; una reserva por sesión, con token y caducidad, decide qué resultado produce efectos, y Argon2 sigue fuera de las transacciones. No cuentan los errores de la contraseña nueva, los de ejecución ni los resultados que llegan tarde. Esquema: tres columnas nuevas en `refresh_sessions` (migración aditiva). **C-02** (bloqueo de cuentas por terceros en el login) está **desplegada en producción** (API en `b1b1c2a`, 2026-11-11), validada en local y en la CI y **sin pruebas autenticadas de sus límites en producción**. Su corrección de errores técnicos de C-04 (una excepción de Argon2 o su saturación ya no cuentan como fallo ni terminan la sesión: 503) se desplegó con ella; el cierre de C-04 descrito arriba no se reescribe. Detalle y límites en `docs/seguridad/PLAN_SEGURIDAD.md` («C-04»).
  - **Cierre en producción (2026-11-10).** Código `2c3552e46d4b4530f47014ebcab53ecff1852047`; CI `42873065151`, éxito. Respaldo de `fchmn-postgres` terminado y disponible, sin descarga ni enlace firmado. Única migración aplicada: `20261110000000_intentos_cambio_contrasena`, con el cron de mantenimiento (dos ejecuciones, de 26 a 28; Docker Command vacío y programación conservada; [construcción](https://dashboard.render.com/cron/crn-dbh500bl550s73c5n2o0/deploys/dep-dbpmirui0phs73cg2cug)). Despliegues, en este orden: web `973cacc` → `2c3552e` ([despliegue](https://dashboard.render.com/web/srv-dbh48scs728c73arlf8g/deploys/dep-dbpmmhou01pc73dqumag)) y API `79bcc2b` → `2c3552e` ([despliegue](https://dashboard.render.com/pserv/srv-dbh4ih4ipgvc73dore80/deploys/dep-dbpmnd6c6qcc73dgjf90)). Render informó «Deploy succeeded» y Live en ambas, con Auto-Deploy Off en web, API y mantenimiento.
  - **Evidencia, por separado.** *Render:* commit, estado y operaciones descritos arriba. *HTTP observado:* `/login`, `/api/health` y `/api/ready` con 200 y `/api/auth/me` sin credenciales con 401, con `Cache-Control: no-store` y la CSP conservada; la web sirve un paquete JS que contiene el código de C-04. El muestreo de `/api/health` dio 30 respuestas 200 entre las 19:08:06Z y las 19:13:07Z, con un máximo de 888 ms; los intervalos entre muestras no se observaron, así que eso acredita disponibilidad en los instantes muestreados. *Validación funcional:* pruebas locales previas (incluida la integración sobre la base desechable) y la CI. *Producción:* **sin pruebas autenticadas del límite, la reserva ni el cierre terminal.** Conviene recargar las pestañas abiertas; no se actualizaron las de otros usuarios.
  - **Correspondencia local.** Imágenes locales: frontend `2094ef56a597`, backend `69edf76a7cfe` y migraciones `2f8a5fcaded4`. *Contenido comprobado:* el `prisma/` de la imagen del backend coincide con el de `2c3552e` (38 migraciones) y el código de C-04 está en el `dist` del backend y en el paquete del frontend. *Registro de construcción:* el log de la construcción nombra esas tres imágenes y los contenedores de frontend y backend usan las suyas. *Migración local:* el registro de la migración local muestra aplicada `20261110000000_intentos_cambio_contrasena`. En la actualización local anterior se recrearon los contenedores de frontend, backend y Postgres, conservando el volumen; ahora quedaron detenidos y el volumen local se conservó. No se declara identidad binaria con las imágenes de Render: el paquete JS del frontend local y el de producción tienen nombres distintos y no se investigó la causa.
- **Acceso externo a la base de producción cerrado** (C-01, hallazgo de la auditoría de seguridad; **mitigado mediante la configuración de red de Postgres en Render el 2026-11-10**): la lista propia de reglas de entrada de `fchmn-postgres` pasó de `0.0.0.0/0` a vacía, de modo que la base ya no admite conexiones desde internet; los servicios de Render siguen conectando por la red privada. Una restauración externa autorizada exige abrir temporalmente solo la IP del operador (`/32`) y cerrarla al terminar (ver `Instructivo_Instalacion_Nube.md`, Paso 9). Esto **no** resuelve por sí solo la seguridad de la base: credenciales, permisos del rol de la aplicación y retención siguen como estaban. Detalle y límites en `docs/seguridad/PLAN_SEGURIDAD.md` («C-01: acceso externo a Postgres»).
- **Privacidad de reportes y relevos** (auditoría AUD-06, AUD-09, AUD-10 y AUD-14; **AUD-10 y AUD-14 publicadas y desplegadas en la API, dentro de su alcance**):
  - **AUD-10:** en el reporte de inscritos (JSON, CSV y XLSX), solo la administración recibe la fecha de nacimiento completa; los demás roles reciben la **edad** a la fecha de corte de la competencia (la misma de la vista agrupada), en el mismo lugar. En CSV y XLSX, «Edad» reemplaza a «Fecha de nacimiento» y el resto de las columnas no cambia. El PDF, la vista agrupada, Team Manager y la ausencia de RUN no cambian.
  - **AUD-14:** en `GET /relay-registrations`, un nadador sin funciones de club recibe su propio RUN y la propiedad `run` de sus compañeros ya no viene; administración y personal del club reciben el RUN de los integrantes de su alcance, como antes.
  - **AUD-06 y AUD-09 se conservan por decisión expresa del usuario** (no son mitigaciones): el nadador sigue recibiendo los totales y el desglose `byClub` de la capacidad de todos los clubes, y la auditoría conserva sus copias completas en `before`/`after`, con la redacción de secretos de siempre. **La política de retención de la auditoría sigue pendiente**; los registros existentes no se tocaron.
  - API `dbdbda2` → `79bcc2b237fda5cb1ccd9ccd03f9b9987d7dbeb2` (Render: Deploy succeeded, Live, Auto-Deploy Off; CI `42727571298`, éxito); la web y el mantenimiento no se desplegaron. Los contratos por rol se comprobaron en local y en la CI; no hubo validación funcional autenticada en producción, y el muestreo de `/api/health` (30 respuestas 200) solo acredita disponibilidad, con huecos sin observar.
  - Detalle, contratos por rol y límites en `docs/seguridad/PLAN_SEGURIDAD.md` («Privacidad de reportes y relevos»).
- **Selectores de competencias y «Cancelar edición»** (desplegados solo en `fchmn-web`): Inscripción, Relevos y Reportes excluyen las competencias ocultas para quienes no son administradores; la administración las conserva. «Cancelar edición» está junto a «Guardar cambios». Web desplegada desde `5d0692fc14cd2bce639e2b4a6ea29c61e656d6f9` (antes `d105823`); la API y el mantenimiento no se desplegaron. Validación funcional local con pruebas simuladas y CI, sin comprobación funcional autenticada en producción. Detalle en `docs/seguridad/PLAN_SEGURIDAD.md`.

## Endpoints del Módulo 4 — Asignación de Nadadores a Clubes

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/swimmer-assignments` | Lista solicitudes (filtro por club/nadador/estado, paginado). Con `orden=apellidos` (plantel de Editar Club) ordena por apellido paterno, materno y nombre antes de paginar y excluye a las personas eliminadas. Con `orden=nadador` o `nadador_desc` (Asignación de Nadadores) aplica el mismo orden, ascendente o invertido, antes de paginar y sobre el mismo conjunto que sin `orden`, sin excluir personas eliminadas; sin `orden`, el de siempre | `swimmer-assignment:read` |
| GET | `/swimmer-assignments/:id` | Detalle de una solicitud | `swimmer-assignment:read` |
| POST | `/swimmer-assignments` | C-05 (fase 2, desplegada en producción desde `5780336`): postulación **por RUN** (`{ run }`; ya no acepta `personId`). El club y su personal —delegado, entrenador o representante legal— postulan en su club con cabecera `Idempotency-Key` y cuota de 30 intentos diarios por club; administración indica `clubId`. Queda `pending` | `swimmer-assignment:write` |
| POST | `/swimmer-assignments/:id/approve` | Aprueba y activa la MISMA propuesta. Cuerpo opcional: `fechaEfectiva` (`AAAA-MM-DD`, no futura), `confirmarFinDeMembresiaId` (traslado) y `aceptarHistorialIncompleto` | `swimmer-assignment:approve` (solo `admin`) |
| POST | `/swimmer-assignments/:id/reject` | Rechaza la solicitud | `swimmer-assignment:approve` (solo `admin`) |
| POST | `/swimmer-assignments/:id/end` | Baja simple de una membresía activa. C-05 (desplegada en producción desde `5780336`): cuerpo **obligatorio** `fechaTermino` (`AAAA-MM-DD`, último día de pertenencia; no futura ni anterior al inicio; el mismo día del inicio sí). Con inicio desconocido, solo administración puede aceptarlo con `aceptarHistorialIncompleto` | `swimmer-assignment:write` + alcance: el `admin`, o el personal **del mismo club** |
| GET | `/swimmer-assignments/cuota` | C-05: intentos usados hoy (Santiago) del propio club; administración indica `clubId` | `swimmer-assignment:write` |
| GET | `/swimmer-assignments/periodos-cambio/vigente` | C-05: si hay un periodo de cambio vigente hoy | `swimmer-assignment:write` |
| GET | `/swimmer-assignments/periodos-cambio` | C-05: lista los periodos de cambio | `swimmer-assignment:approve` (solo `admin`) |
| POST | `/swimmer-assignments/periodos-cambio` | C-05: crea un periodo global (`inicio`, `fin` inclusivos de Santiago) | `swimmer-assignment:approve` (solo `admin`) |
| POST | `/swimmer-assignments/periodos-cambio/:id/cerrar` | C-05: cierre anticipado; no hay edición ni reapertura | `swimmer-assignment:approve` (solo `admin`) |
| POST | `/swimmer-assignments/altas` | C-05: segundo paso de un RUN no registrado (`intentoId`, `nombres`, `apellidos`); crea la solicitud de alta | `swimmer-assignment:write` (club y su personal) |
| GET | `/swimmer-assignments/altas` | C-05: solicitudes de alta del propio club; administración ve todas | `swimmer-assignment:write` |
| GET | `/swimmer-assignments/altas/:id` | C-05: detalle; administración ve además las coincidencias del RUN | `swimmer-assignment:write` + alcance |
| POST | `/swimmer-assignments/altas/:id/aprobar` | C-05: crea o vincula a la persona y la asigna al club solicitante | `swimmer-assignment:approve` + `persons:write` (solo `admin`) |
| POST | `/swimmer-assignments/altas/:id/rechazar` | C-05: rechaza la solicitud de alta | `swimmer-assignment:approve` (solo `admin`) |

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

  C-05 (desplegada en producción desde `5780336`): la **fecha de término la elige quien registra la baja**
  (`fechaTermino`, obligatoria; puede ser una renuncia comunicada después) y se
  guarda en `fecha_termino`. El instante real de la operación queda en `end_date`
  y en la auditoría, sin retroceder. Una baja hasta hoy implica que otra membresía
  solo puede empezar después de hoy; una retroactiva admite un inicio posterior a
  ella si el historial lo permite.
- **La fecha efectiva de la membresía es un dato del negocio, no una marca de auditoría.**
  `club_swimmers.start_date` es una columna **`DATE`** —una fecha de calendario,
  sin hora y sin zona— y responde «desde cuándo pertenece al club». La marca de
  auditoría es `reviewed_at`, que sigue siendo un instante y responde «cuándo se
  registró».

  Los cuatro endpoints que activan una membresía aceptan `fechaEfectiva` en
  formato `AAAA-MM-DD`: `/direct`, `/bulk-assign`, `/:id/approve` y
  `/reassign/:personId`. Si no viene, se usa **el día de hoy en Chile**, no el del
  reloj del servidor. En `bulk-assign` la fecha se resuelve **una vez** y se
  aplica a toda la tanda. Con C-05 la fecha efectiva **nunca puede ser futura**
  (400 `FECHA_FUTURA`) y se contrasta con el historial del nadador.

  > **Antes los dos campos recibían `new Date()` en la misma operación**, así que
  > `start_date` era una segunda copia de `reviewed_at`. Medido: una asignación
  > hecha en Chile a las 23:58 del 30 de octubre quedaba guardada como el 31,
  > mientras la interfaz mostraba el 30. El dato valía una cosa en la base y otra
  > en la pantalla.
  >
  > **Al mostrar una fecha de calendario, no la pase por `new Date()`.** Prisma
  > sirve una columna `DATE` como medianoche UTC, y
  > `toLocaleDateString("es-CL")` sobre eso resta un día. Use
  > `shared/fechaCalendario.ts` en el frontend y `shared/fecha.util.ts` en el
  > backend.
  >
  > *Antecedente:* la pantalla de asignación masiva no tenía el campo de fecha y
  > usaba el día de hoy. Con C-05 la pantalla pide la fecha efectiva
  > **expresamente** (hoy o anterior) y la envía para toda la tanda.
- **RB-06 — un nadador activo, un solo club. Es una invariante, no un parámetro.**
  Nunca hay dos membresías activas a la vez, y ningún cambio de club ocurre en
  silencio. Con C-05, si el nadador ya tiene una membresía activa en **otro** club:
  - **aprobar una propuesta** (y `reassign` o resolver una solicitud de alta) admite
    un **traslado** solo con la **confirmación expresa** de la membresía vigente que
    se finalizará (`confirmarFinDeMembresiaId`); sin ella responde 409
    `CONFIRMACION_REQUERIDA`, y si la vigente cambió, `REVISAR_DE_NUEVO`. La anterior
    termina el día calendario previo al nuevo inicio, y todo ocurre en una
    transacción auditada;
  - **`/direct` y `bulk-assign` NO trasladan**: siguen rechazando a quien está activo
    en otro club.

  > *Antecedente (antes de C-05):* aprobar y asignar directamente se bloqueaban por
  > igual y había que finalizar la anterior primero.

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
  que sí se exige al postular (C-05, por RUN): que el club esté `active` y que el
  alcance del actor sea ese club. Una persona **sin membresía activa** se puede
  postular todo el año; una **con membresía activa en otro club**, solo durante un
  **periodo de cambio habilitado** por administración (fuera de él, 409
  `MEMBRESIA_ACTIVA_FUERA_DE_PERIODO`). La aprobación del traslado sigue RB-06.

  > *Antecedente (antes de C-05):* se proponía por `personId` y se exigía que la
  > persona no tuviera una membresía activa en otro club.
- `getCurrentClubForPerson()` queda expuesto como utilidad reutilizable para módulos futuros (ej. inscripciones, que deben determinar automáticamente el club vigente de un nadador — sección 9 del requerimiento).
- En el frontend: la ficha de cada club (`ClubFormPage`) es **de administración** e incluye la sección "Plantel de nadadores", donde administración asigna directamente (con fecha) y registra bajas. **No es la pantalla de postulación del club**: el club y su personal postulan por RUN en `/incorporaciones` (C-05). Administración aprueba o rechaza las propuestas en `/asignaciones`, accesible desde el menú lateral.
  > *Antecedente:* esta línea decía que en la ficha del club «el club busca y propone»; esa ficha ya era solo de administración.
- C-05, fase 3 (desplegada en producción desde `5780336`): las pantallas de administración piden la fecha expresamente (baja con calendario; activaciones con fecha no futura), revisan y confirman los traslados y la aceptación de un historial incompleto, y agregan `/asignaciones/periodos` (periodos de cambio) y `/asignaciones/altas` (solicitudes de alta). Ver `docs/seguridad/PLAN_SEGURIDAD.md`, C-05.
- C-05, fase 4 (desplegada en producción desde `5780336`): la cuenta del club y su personal vigente (delegado, entrenador, representante legal) postulan por RUN en `/incorporaciones` (enlace «Incorporaciones» del menú), con el segundo paso de nombre y apellido declarados, la cuota y el periodo informados por el servidor, y la lista de propuestas y solicitudes de alta del propio club. Administración y nadadores no acceden a esa pantalla. C-05 está publicada, migrada y desplegada en producción, con el entorno local actualizado, dentro del alcance validado: sin validación funcional autenticada en producción. Estado, despliegue y límites en `docs/seguridad/PLAN_SEGURIDAD.md`, C-05.

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
| GET/POST | `/competitions[/:id]` | Listar/crear competencias. El listado admite el filtro explícito `visibleInRegistrationPanels=true\|false` (ver «Visibilidad en los selectores de Inscripción, Relevos y Reportes») | `competitions:read` / `competitions:write` |
| PUT | `/competitions/:id` | Editar (fechas de inscripción solo en `draft`/`scheduled`); también `visibleInRegistrationPanels` y `requireIndividualForRelay`. La respuesta y `GET /competitions/:id` traen `relayTeamsNotMeetingCondition` (ver «Condición de inscripción individual para relevos») | `competitions:write` |
| POST | `/competitions/:id/duplicate` | Duplica estructura completa como base de una nueva (hereda la visibilidad en los paneles) | `competitions:write` |
| PUT/DELETE | `/competitions/:id/predeterminada` | Marca o quita la **competencia por defecto** de los paneles de Inscripción y de Relevos (como máximo una, global; ver «Competencia por defecto»). Solo el rol `admin`, comprobado en la API además del permiso. No cambia estado, fechas ni visibilidad; la copia de una competencia no la hereda | `competitions:write` + rol `admin` |
| POST | `/competitions/:id/{schedule\|cancel\|closeRegistrations\|start\|finish}` | Transiciones de ciclo de vida | `competitions:write` |
| POST/DELETE | `/competitions/:id/dates`, `/competition-dates/:dateId` | Fechas de la competencia | `competitions:write` |
| POST/DELETE | `/competition-dates/:dateId/sessions`, `/competition-sessions/:sessionId` | Jornadas dentro de una fecha | `competitions:write` |
| PUT | `/competition-sessions/:sessionId/limit` | Límites de pruebas individuales/relevos (NULL = sin límite) | `competitions:write` |
| GET/POST/PUT/DELETE | `/competitions/:id/events`, `/competition-events/:ceId` | Pruebas asignadas a la competencia. Alta y edición admiten `maxSwimmersPerClub` (máximo de nadadores por club en esa prueba individual; ver «Máximo de nadadores por club y prueba») | `competitions:read` / `competitions:write` |
| GET/POST | `/catalogs/session-types` | Catálogo extensible de jornadas (Mañana/Tarde sembrado) | `catalogs:read` / `catalogs:write` |

### Reglas aplicadas en el Módulo 6

- **RB-07 (apertura/cierre automático)**: aislé el cómputo en una función pura forward-only (`scheduled → open → closed`, nunca retrocede) en `competitions.rules.ts`, con **20 pruebas unitarias**. Se aplica de forma perezosa: cada vez que se lee una competencia, si la fecha actual implica un cambio de estado, se persiste automáticamente — sin necesitar un job/cron real todavía, pero la misma función serviría para uno.
- **Cierre manual anticipado** (sección 10, "excepciones manuales a administradores"): una vez que una competencia se cierra manualmente (`closeRegistrations`), el auto-cómputo la trata como estado terminal y **no la reabre**, aunque la fecha de fin todavía no haya llegado — cubierto explícitamente en los tests.
- **Máquina de transiciones manuales** (`schedule`, `cancel`, `closeRegistrations`, `start`, `finish`) con reglas claras de origen válido para cada una (ej. no se puede `finish` si no está `in_progress`).
- **Sección 13 / RB-13**: al asignar una prueba a la competencia, las categorías habilitadas deben ser un **subconjunto** de las ya asociadas a esa prueba en el catálogo general (Módulo 5) — no se puede habilitar una categoría que la prueba no admite. Quitar una prueba de la competencia borra únicamente `competition_events`, nunca la prueba maestra.
- **Duplicar competencia**: copia completa de fechas, jornadas, límites y pruebas asignadas (con sus categorías habilitadas) hacia una nueva competencia en `draft`, remapeando todos los IDs internos dentro de una transacción.
- **Sección 12 (A-09)**: límites de pruebas individuales/relevos definidos por fecha+jornada, uniformes para todos los nadadores de esa sesión; `null` en cualquiera de los dos campos significa "sin límite".

#### Máximo de nadadores por club y prueba

Cada prueba **individual** de una competencia puede llevar un máximo de nadadores por club (`CompetitionEvent.maxSwimmersPerClub`, columna `max_swimmers_per_club`).

- **Valor y validación.** Por omisión **«Sin límite»**, que se guarda como `NULL` (así quedan todas las pruebas anteriores, y las nuevas y las importadas). Con valor, un **entero positivo** (la API lo valida y la base lo exige con un `CHECK`). Enviar `null` al editar **quita** el límite; omitirlo no lo toca. **No se ofrece para relevos**: una prueba de relevo con un valor responde 400 con un mensaje, y la interfaz no muestra el campo.
- **Qué cuenta.** Las inscripciones individuales **confirmadas** del club en **esa** prueba de competencia —equivale a nadadores distintos de ese club en esa prueba—, sin importar en qué otras pruebas esté cada nadador. Otro club y otra prueba no consumen el cupo. **Cancelar libera** el cupo (las canceladas no cuentan).
- **Es independiente** de los cupos de nadadores de la competencia (`maxSwimmers` y `maxSwimmersPerClub` de la competencia, que cuentan nadadores **distintos en toda la competencia**): ni los consulta ni los modifica, y ambos se aplican a la vez.
- **Reducirlo** por debajo de lo ya inscrito **no elimina ni cancela** nada: solo impide altas posteriores (el mensaje lo dice).
- **Concurrencia.** El conteo, la comprobación y el alta ocurren dentro de la misma transacción serializable que ya protege las inscripciones simultáneas: dos altas sobre el último cupo no pueden quedar ambas (una recibe el rechazo del límite o el conflicto reintentable).
- **Excepción de administrador.** **Solo un administrador** (`actor.isAdmin`) puede exceder el máximo. **No basta** tener `registrations:write`, ni `registrations:write:post-close` sin ser administrador; el resto de las reglas de inscripción no se relaja. Cada exceso deja una fila de auditoría `REGISTRATION_CREATED_OVER_EVENT_CLUB_LIMIT_BY_ADMIN` **en la misma transacción** que el alta (si la auditoría falla, el alta se revierte), con autor, club, competencia, prueba de competencia, máximo vigente y cantidad resultante.
- **Mensaje para el club:** «El club … alcanzó el máximo de N nadador(es) por club en la prueba «…». No quedan cupos para este club en esta prueba…».
- **Duplicar** la competencia **hereda** el máximo de cada prueba.

#### Visibilidad en los selectores de Inscripción, Relevos y Reportes

Cada competencia guarda `visibleInRegistrationPanels` (columna `visible_in_registration_panels`, `BOOLEAN NOT NULL DEFAULT true`).

- **Qué significa ocultar.** Quita la competencia **únicamente de los desplegables de Inscripción, Relevos y Reportes** para quienes **no son administradores**. La **administración** (también una cuenta que combine `admin` con otros roles) sigue viéndola en esos tres selectores, ocultas y visibles juntas. Es solo ocultar una opción, no restringir el acceso.
- **Qué NO hace.** No es una medida de protección: **no** modifica permisos, accesos directos (`GET /competitions/:id` sigue respondiendo), reglas de inscripción ni las altas —una competencia oculta pero abierta admite inscripciones por los mismos medios que antes—, y **no** alcanza a los **asistentes** de inscripción y de relevos, que conservan su listado. Tampoco la quita de la tabla de Competencias de administración.
- **Formularios.** Alta y edición llevan la casilla «Ocultar esta competencia del panel de inscripción, del panel de relevos y de Reportes», **desmarcada por defecto**. Se guarda en sentido positivo (casilla marcada = `false`), para no tener que negar el campo en cada lectura. La tabla de administración añade al final la columna **«Mostrar en competencia»** con `Sí`/`No`.
- **El filtro.** `GET /competitions?visibleInRegistrationPanels=true|false`. **Omitido, el listado se comporta como siempre** (todas las competencias que el rol puede ver). Los tres selectores envían `true` a quienes no son administradores; **administración omite el parámetro** (enviar `false` devolvería únicamente las ocultas). Cada pantalla recorre todas las páginas y conserva sus demás condiciones. Se aceptan exactamente los textos `true` y `false`; cualquier otro valor responde 400 (en particular, `"false"` **no** se interpreta como verdadero, como haría una coerción a booleano). El filtro es una condición propia de la consulta: **se suma** a las restricciones por rol y estado (el personal que no es administrador sigue sin ver Borrador ni Programada) y los resultados, el total y la paginación salen de la misma condición.
- **Competencias existentes, duplicadas e importadas.** La migración `20261102030000_competencia_visible_en_paneles` es aditiva: las competencias anteriores quedan **visibles**. Duplicar **hereda** la visibilidad del origen. Las nuevas y las importadas (Team Manager / Meet Events) nacen visibles salvo configuración expresa.

#### Competencia por defecto de los paneles

Administración puede marcar en **Competencias** (columna «Por defecto») **una** competencia por defecto, global y persistente (`competitions.es_predeterminada`, migración `20261114000000_competencia_predeterminada`).

- **Como máximo una**, también ante cambios simultáneos: índice único parcial `competitions_una_predeterminada` y un bloqueo consultivo que ordena las marcas (la última confirmada gana). Marcar otra desmarca la anterior; quitarla solo afecta a la competencia pedida (si otra administración ya cambió la marca, no hace nada y la pantalla lo avisa).
- **Al entrar al Panel de Inscripción y al Panel de Relevos** aparece preseleccionada, **solo si está entre las competencias que esa cuenta puede ver y elegir** en su desplegable. Administración conserva su excepción para las ocultas. Si no hay una accesible, el selector queda sin elección.
- La elección manual manda: una vez que la persona elige (también «Seleccionar...»), una carga posterior o tardía de la lista no la cambia.
- **No abre inscripciones** ni cambia estado, fechas, visibilidad ni `updated_at`. La migración no elige ninguna competencia existente, y duplicar no hereda la marca.
- **Auditoría:** `COMPETITION_DEFAULT_SET` (con la anterior y la nueva) y `COMPETITION_DEFAULT_CLEARED`, en la misma transacción.

#### Presentación y desplazamiento en los paneles

- **Orden y nombres.** Ambos paneles ordenan a los nadadores por apellido paterno, apellido materno y nombre, y los presentan como `PATERNO MATERNO, NOMBRE (EDAD)`. Las mayúsculas son de presentación: los datos no cambian. Se usan los campos separados, sin partir `fullName`. Un registro histórico sin apellido paterno o sin nombre se muestra con su `fullName` en mayúsculas, sin coma, y va al final. La edad es la que calcula el servidor a la fecha de corte (`edadAlCorte`). Búsqueda, selección e identificadores no cambian, y tampoco los reportes ni las exportaciones.
- **Poco espacio.** Las dos columnas solo se mantienen si caben; con menos de 900 px de ventana se apilan. La zona de pruebas tiene botones visibles «Anterior»/«Siguiente», un aviso de que hay más días a un lado y foco de teclado; esos controles no dependen de las barras del sistema. Además, se declaran barras propias (`::-webkit-scrollbar`), que en Chromium se observaron visibles. *Antecedente:* al publicar, quedaba pendiente comprobar en un Mac real si en Safari de macOS quedaban visibles. Después, el usuario informó que revisó en Safari en Mac y que funciona bien. Es su revisión manual: **no garantiza que las barras queden siempre visibles en cualquier configuración de macOS**. Antes, a 375 px la zona de pruebas quedaba con 0 px de ancho (inalcanzable) y los selectores desbordaban la página. Los estilos están acotados a estos paneles (`theme.css`, «Panel de Inscripción y Panel de Relevos»).
- **Edad de quien ya no está en el plantel.** La fila de cada inscripción individual y cada integrante de un relevo muestran la edad al corte que viene con la propia inscripción (`edadAlCorte` en `GET /registrations` y en los integrantes de `GET /relay-registrations`, calculada por el servidor para esa competencia). Se conserva aunque la membresía haya terminado, sin volver a poner a la persona entre los disponibles. Solo viaja el número, nunca la fecha de nacimiento. Un nadador recibe en los relevos su propia edad, pero no la de sus compañeros: es una **medida adicional de esta implementación**, para no ampliar lo que se deriva de la fecha de nacimiento. **No** es una decisión previa de AUD-14, que regulaba el RUN.
- **Selección que deja de estar disponible.** Si la competencia elegida ya no está en la lista de la cuenta (por ejemplo, la sesión perdió administración y la competencia es oculta), la selección se vacía y el panel deja de mostrar su contenido; no se reemplaza por otra, ni siquiera por la predeterminada. Una elección que sigue disponible se conserva.

#### Estado de estas mejoras (competencia por defecto, alta con club, presentación y desplazamiento)

**Publicadas, migradas y desplegadas en producción; entorno local actualizado, dentro del alcance validado.** Se desplegaron el 2026-11-14 junto con C-05 y el preflight empaquetado, desde `5780336338febd668615d3e4a66219a13f6cc12a` (CI `43550942111`, aprobada para ese SHA). La migración `20261114000000_competencia_predeterminada` se aplicó, sin seed, en producción y en la base local de trabajo, y la API (`dep-dbrtl3mi0phs73bgp91g`) y la web (`dep-dbrtm8rl550s73erpcv0`) quedaron Live en ese SHA. El registro del despliegue (respaldo, ejecuciones del mantenimiento, muestreo HTTP, entorno local y límites) está en `docs/seguridad/PLAN_SEGURIDAD.md`, C-05, «Despliegue en producción y entorno local». No hubo validación funcional autenticada ni escrituras de prueba en producción: lo observado allí acredita disponibilidad y cabeceras, no el funcionamiento con sesión. La configuración de accesos por rol sigue **solo diseñada** (`docs/internas/14_Diseno_Accesos_Por_Rol.md`), pendiente de decidir si podrá conceder atribuciones nuevas. *Estado posterior:* se decidió la opción A (solo restringir y restituir) y quedó publicada en el repositorio, pendiente de migración y despliegue; más tarde se migró y desplegó en API y web desde `430c4cb`, con el entorno local actualizado. Ver «Accesos por rol».

*Antecedente:* hasta ese despliegue figuraban publicadas en el repositorio y pendientes de despliegue, con la migración aplicada solo a la base desechable de pruebas.

Validación local, con resultados reales:

- **Primera entrega.**
  - Frontend de las áreas tocadas (jsdom, API simulada): 268 de 268.
  - Backend: prueba documental 12 de 12 y contratos 148 de 148.
  - Integración sobre la base desechable, en una sola ejecución: 12 archivos, 299 de 299.
  - Tipos sin errores; lint sin errores nuevos.
  - Revisión visual **observada en Chromium** (navegador integrado, frontend real y API simulada con datos sintéticos) a 375, 768 y 1280 px.
- **Correcciones previas a la publicación, con reproducciones que fallaron antes de corregir.**
  - *Selección que deja de estar disponible:* 4 pruebas, 2 por panel. Fallaron porque el panel seguía mostrando el contenido de la competencia descartada.
  - *Edad de inscritos fuera del plantel:* 2 pruebas de frontend, que mostraban el nombre sin edad, y 3 de integración, sin `edadAlCorte`.
  - Después de corregir: frontend 111 de 111, backend unitarias 34 de 34 e integración 6 archivos, 172 de 172.
- **Safari de macOS real.** *Antecedente:* esta validación no incluyó Safari y quedó pendiente comprobar allí el desplazamiento y las barras de ambos paneles, porque jsdom y Chromium no la reemplazan. Después, el usuario informó que revisó en Safari en Mac y que funciona bien. Es su revisión manual, no una prueba automatizada: no indicó versión ni configuración, y no garantiza barras siempre visibles en cualquier configuración de macOS.
- **Team Manager:** no cambió el código de exportación (`team-manager-export/`) ni sus dependencias compartidas. Solo se agregó a `competitions` una columna que el generador no lee. Esto **no** equivale a haber comparado un ZIP generado, y tras el despliegue tampoco se probó con exportaciones reales.

### Sigla del club

La **sigla** (`clubs.code`) es el **identificador único del club**. La garantía es de la base: el índice único parcial `clubs_code_unique_active`, sobre `club_code_normalizado(code)` y `WHERE deleted_at IS NULL` (migración `20261103020000_sigla_club_unica`).

- **Alcance:** clubes no eliminados lógicamente, **incluidos los inactivos**: un club inactivo conserva su sigla. Un club eliminado la libera.
- **Normalización:** sin blancos a los lados y en mayúsculas, la misma en la aplicación (`shared/clubCode.ts`) y en la función SQL.
- **Al crear y editar:** se responde con un mensaje que nombra al club que la usa. Frente a dos operaciones simultáneas la garantía final es el índice, y la perdedora recibe un 409 con el mensaje de la sigla.
- **Datos anteriores:** si hay duplicados, la migración se **detiene** con el detalle (comprobación `club-sigla-duplicada` del preflight) y no modifica ningún club: decidir qué club conserva la sigla es del negocio.

### Alta de persona con asignación a club

**Nueva persona** tiene el selector «Asignación a club». Su opción inicial es «Sin asignación», seguida de la lista completa de clubes activos (todas las páginas).

Al guardar con un club, `POST /persons` con `clubId` crea, en **una** transacción:

- la persona;
- su membresía **activa** desde **hoy en America/Santiago**;
- el rol derivado de nadador;
- las auditorías `PERSON_CREATED` y `SWIMMER_ASSIGNMENT_DIRECT`.

Reglas:

- Reutiliza la asignación directa de C-05: fecha no futura, historial y el orden de bloqueos club → RUN → persona.
- Si la asignación falla o el club ya no está activo, **no queda nada**, tampoco la persona.
- No crea credenciales.
- La edición no ofrece el campo y descarta `clubId`: no es un mecanismo de traslado.

### Carga masiva por Excel con club y fecha efectiva

`GET /persons/bulk-import/template` descarga la plantilla y `POST /persons/bulk-import` la procesa (`persons-bulk-import.rules.ts` y `.service.ts`).

- **Columnas de la hoja `Personas`, en este orden:** A RUN · B nombre de usuario (opcional) · C nombre · D apellido paterno · E apellido materno (opcional) · F fecha de nacimiento `DD-MM-AAAA` · G género · H correo (opcional) · I teléfono (opcional) · **J sigla del club (opcional)** · **K fecha efectiva de membresía** (`AAAA-MM-DD` o `DD-MM-AAAA`; **obligatoria si hay club**). La hoja `Instrucciones` trae el ejemplo, las notas y la **lista de clubes vigentes y activos** (sigla y nombre), con cada valor pasado por `neutralizeSpreadsheetFormula`; el importador no la lee.
- **Plantillas anteriores:** la de A-I (sin J ni K) sigue sirviendo para registrar solo personas. Una plantilla con la J titulada «Roles» se **rechaza entera** (400, nada escrito): esa columna nunca se reinterpreta como club. Cualquier otro título en J o K, también.
- **Club:** se identifica por la **sigla** (`clubs.code`, comparada con `trim` y mayúsculas), no por el nombre ni por el nombre de usuario. Solo se resuelven clubes **vigentes y activos**. Una sigla inexistente, de un club inactivo o eliminado rechaza la fila con un mensaje que lo dice. **La correspondencia sigla → club se resuelve dentro de la transacción de cada fila, con `FOR SHARE`:** no hay lectura previa ni caché. Si otra operación está cambiando ese club, la fila espera y evalúa lo confirmado; una vez leído, el club no puede cambiar de sigla, estado ni vigencia hasta que la fila termine. Si la sigla ya no corresponde, se rechaza esa fila y las demás continúan. La sigla es única por garantía de la base (ver «Sigla del club»); aun así el importador conserva su defensa: si una lectura devolviera dos clubes vigentes, rechaza la fila como **ambigua** sin elegir. La lista de la plantilla usa el mismo criterio (sigla normalizada, evaluada con `resolverSigla`) y es orientativa: vale lo vigente al procesar cada fila.
- **Fecha efectiva:** con club es obligatoria y debe ser un día que exista; **nunca** se usa la fecha de hoy en silencio. Una fecha sin club es un error informado. Se guarda exactamente el día escrito (columna `DATE`, medianoche UTC, `shared/fecha.util.ts`), sin desplazamiento por zona horaria; una celda de fecha nativa de Excel se lee por sus componentes UTC.
- **Sin club** la fila registra solo a la persona, como antes. El nombre de usuario sigue siendo opcional: vacío = `NULL`; **nunca** se genera uno ni se crean credenciales.
- **Una transacción por fila:** resolución de la sigla, persona, membresía activa (`assignSwimmerDirectly` con `{ tx }`), rol de nadador derivado y las auditorías `PERSON_CREATED` y `SWIMMER_ASSIGNMENT_DIRECT` se escriben juntos; si algo falla, la fila se revierte entera. Entre filas el procesamiento sigue siendo **parcial**: una fila con error no impide las demás.
- **Sin reasignar ni sobrescribir:** una persona cuyo RUN ya existe se rechaza (no se modifica ni se cambia de club); se mantiene una sola membresía activa por persona (RB-06). No se crean cuentas.
- **Duplicados dentro del archivo:** RUN (normalizado) y nombre de usuario **informado** repetidos se rechazan desde la **segunda** aparición, indicando la fila de la primera; dos filas sin nombre de usuario no son duplicadas.
- **Permisos:** la ruta exige `persons:write`; si **alguna** fila trae club, además `swimmer-assignment:approve` (se comprueba antes de escribir: sin él, el archivo entero responde 403). Un archivo sin clubes se importa solo con `persons:write`.
- **Informe:** por fila (número de fila del Excel), con el club y la fecha guardados en las creadas con club; totales `totalRows = createdCount + errorCount` y `withClubCount` (de las creadas, las incorporadas a un club).

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
| GET | `/registrations` | Lista inscripciones (filtro por competencia/club/nadador/estado). Cada una trae `edadAlCorte` (edad al corte de su competencia, calculada por el servidor; sin fecha de nacimiento) | `registrations:read` |
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
| GET | `/relay-registrations` | Lista inscripciones de relevo (filtro por competencia/club/estado). Cada integrante trae `edadAlCorte`. Un nadador la recibe solo para sí mismo: es una medida adicional de esta implementación, no parte de AUD-14 (que regula el RUN) | `registrations:read` |
| POST | `/relay-registrations` | Confirma un equipo de relevo (4 nadadores, valida el equipo completo) | `registrations:write` |
| POST | `/relay-registrations/:id/cancel` | Cancela un equipo de relevo | `registrations:write` (post-cierre requiere `registrations:write:post-close`) |

### Reglas aplicadas en el Módulo 8

- **RB-11 (exactamente 4, sin duplicados)**: `zod` ya rechaza en el esquema cualquier payload que no traiga exactamente 4 `personIds`; la regla pura (`relay-registrations.rules.ts`) además detecta duplicados dentro del arreglo aunque el esquema los deje pasar (ej. el mismo nadador enviado dos veces sí cumple "longitud 4" pero no es un equipo válido). **22 pruebas unitarias** cubren equipo incompleto, equipo con 5, duplicado interno, y cada regla individual por integrante.
- **Validación por integrante, no solo por equipo**: cada uno de los 4 nadadores se valida individualmente (activo, pertenece al club, edad, género, límite de relevos en esa fecha+jornada) y los mensajes de error identifican **a qué integrante** corresponde cada falla — no un error genérico de "equipo inválido".
- **Un equipo por club por prueba+categoría**: un club no puede tener dos equipos confirmados para la misma prueba de relevo y categoría (`duplicateTeamForClub`).
- **RB-10 (límite de relevos por nadador)** se evalúa **por integrante individual** en la fecha+jornada correspondiente, reutilizando el mismo `SessionLimit.maxRelayEvents` del Módulo 6 — un nadador puede estar bloqueado de sumarse a un 3er relevo aunque sus 3 compañeros de equipo sí puedan.
- Reutiliza exactamente el mismo patrón de excepción post-cierre (RB-08) y alcance por club que el Módulo 7, sin duplicar esa lógica de permisos.
- **RUN de los integrantes según el alcance** (AUD-14; AUD-10 y AUD-14 publicadas y desplegadas en la API, dentro de su alcance): administración y alcance de club (cuenta del club, delegado, entrenador y representante legal, también si además son nadadores) reciben `members[].person.run`. Un nadador sin esas funciones recibe solo el suyo: en sus compañeros la propiedad no existe (no va vacía). Se decide con el alcance efectivo de la sesión y la identidad de la persona, nunca con parámetros del cliente; qué relevos ve cada actor, la paginación y los totales no cambian.
- **Frontend**: el asistente bloquea la selección de un 5º nadador en cuanto hay 4 marcados (UX preventiva), pero la validación real y autoritativa siempre ocurre en el backend.

#### Condición de inscripción individual para relevos (configurable por competencia)

Cada competencia guarda `requireIndividualForRelay` (columna `require_individual_for_relay`, `BOOLEAN NOT NULL DEFAULT true`), con la casilla «Exigir al menos una inscripción individual confirmada antes de participar en relevos» en el alta y en la edición. **Comienza marcada**: las competencias anteriores, las nuevas y las importadas la tienen activada, y **duplicar hereda** el valor del origen.

- **Activada** (la regla de siempre, ahora explícita; antes no estaba documentada). Tiene **dos lados** (`relay-membership.rules.ts`):
  1. **Formar o modificar un equipo** (`POST /relay-registrations` y `PUT /relay-registrations/:id` con integrantes) exige que **todos** los integrantes tengan al menos una inscripción individual **confirmada en la misma competencia** —no en la misma prueba—. Rige también para el administrador: su excepción levanta cupos y cierres, no esto. Editar un equipo que hoy incumple exige que el equipo **resultante** cumpla; corregir solo su tiempo no es modificar integrantes.
  2. **Cancelar la última inscripción individual** de un nadador que integra un relevo confirmado se **rechaza**; con otra individual confirmada, o tras cancelar el relevo, se permite. El sistema nunca retira al nadador ni cancela en cascada.
- **Desactivada**: no se exige la individual para formar o modificar un relevo, y **no se bloquea** cancelar la última individual por esa condición. Nada se recalcula al apagarla.
- **Se lee de la misma competencia, dentro de la transacción** de cada operación (la de relevos y la de la cancelación individual), no de una lectura previa.
- **Se conserva todo lo demás:** cupos, cierres, edades, categorías, el límite de relevos por nadador y jornada, la pertenencia al club, permisos y alcance. Solo el texto del cierre parcial («Los relevos siguen disponibles…») deja de afirmar la individual previa cuando la competencia no la exige.
- **Aviso al activarla sobre equipos que no cumplen.** No se modifica, cancela ni retira a nadie y **el administrador puede guardar**. `GET /competitions/:id` y la respuesta de `PUT /competitions/:id` incluyen `relayTeamsNotMeetingCondition`: los **equipos confirmados distintos** (no los integrantes) con algún integrante sin individual confirmada en la competencia. Es una lectura pura, sin ruta nueva. El formulario lo muestra al marcar la casilla y, tras guardar, en el resumen.

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
| GET | `/reports/registrations/clubs?competitionId=` | Clubes con al menos una inscripción confirmada (individual o de relevo) en la competencia: opciones del selector de club | `reports:read` (además, rol `admin`) |
| GET | `/reports/clubs-summary?competitionId=` | Resumen de inscripciones por club, con cifras agregadas y sin datos personales | `reports:read` (además, rol `admin`) |
| GET | `/reports/clubes-y-nadadores` | Reporte general «Clubes y nadadores» (pertenencia vigente, sin competencia): clubes con sus nadadores, revisión de membresías activas en clubes eliminados y «Sin club asignado». Solo nombres | `reports:read` (además, rol `admin`) |
| GET | `/reports/clubes-y-nadadores/export?format=csv\|xlsx\|pdf` | Exporta el mismo reporte completo, generado en el servidor | `reports:read` (además, rol `admin`) |

Filtros soportados (sección 16): `competitionId` (obligatorio), `clubId`, `competitionDateId`, `sessionTypeId`, `competitionEventId`, `categoryId`, `gender`.

### Selector de clubes y resumen por club (estado: publicada y desplegada; entorno local actualizado)

> **Estado:** publicada en el repositorio (`d8c3acfb39712dcac2ebd29625d8617a24323184`) y **desplegada en la API y en la web**, con el entorno local actualizado. Está **dentro del alcance validado**: no hay comprobación funcional autenticada en producción (ver «Qué no se comprobó»). El mantenimiento no cambió.
>
> **Qué se validó y cómo** (cada capa por separado):
>
> - **Pruebas funcionales locales y CI.** El backend, con **pruebas de integración** contra la base desechable de pruebas: autorización por rol, reglas de conteo y regresiones de alcance. La interfaz, con **pruebas automatizadas simuladas** (jsdom). La CI del código (`43212548298`) terminó en éxito.
> - **Revisión visual con API simulada.** Se hizo en un navegador real, con una API simulada y datos sintéticos: verificó la presentación y el manejo de estado, no el backend integrado ni el contenido de ningún ZIP de Team Manager. Un ajuste de estilo posterior (la celda «Total») se revisó solo por código, sin repetir la observación en navegador.
> - **Estado de despliegue observado en Render.** Ver «Producción» más abajo.
> - **Disponibilidad HTTP.** Ver «Disponibilidad» más abajo: son lecturas públicas sin credenciales.
>
> **Qué no se comprobó.** No se hicieron pruebas autenticadas ni exportaciones en producción, así que el resumen administrativo y la exportación a Team Manager no se probaron allí. Las lecturas públicas acreditan disponibilidad, no funcionamiento de estas funciones.
>
> **Producción** (Render, Auto-Deploy Off en ambos servicios; despliegue manual por SHA exacto):
>
> | Servicio | Versión | Despliegue | Resultado |
> |---|---|---|---|
> | `fchmn-api` | `b1b1c2a` → `d8c3acf` | `dep-dbqr4u1srm7s73dno7jg` | Deploy succeeded y Live |
> | `fchmn-web` | `7860b1d` → `d8c3acf` | `dep-dbqr63mi0phs73dghd1g` | Deploy succeeded y Live |
> | `fchmn-mantenimiento` | sin cambios, `b1b1c2a` | no se desplegó | — |
>
> Sin migraciones, seed ni variables o configuración nuevas.
>
> **Disponibilidad** (2026-11-12, sin credenciales):
>
> - Muestreo de `/api/health` por la web, de 12:34:05Z a 12:38:56Z: **28 de 28 respuestas con 200**, con latencias de 284 a 675 ms. Los intervalos entre muestras no se observaron. La primera muestra con el uptime de la instancia nueva es de las 12:35:53Z: es una observación, no la hora exacta del reinicio.
> - Comprobación final: `/login`, `/api/health` y `/api/ready` con 200 (`database: ok`); `/api/auth/me` sin credenciales con 401. Las comprobaciones realizadas conservaron `Cache-Control: no-store` y la CSP.
>
> **Entorno local.** Imágenes de backend `598436879063` y de frontend `bfc801c6bb5f`, construidas desde el código limpio de `d8c3acf`. Postgres y su volumen se conservaron. No se ejecutaron migraciones ni seed, y **C-05 no está aplicada**. Al terminar, backend, frontend y Postgres quedaron detenidos, como al inicio. No se afirma identidad binaria con Render: los nombres de los paquetes de JavaScript difieren entre local y producción, y la causa no se investigó.

- **Selector de clubes del reporte detallado (administración).** Al elegir una competencia, el desplegable muestra solo los clubes con al menos una inscripción **confirmada**, individual o de relevo (incluye los que solo tienen relevos). Al cambiar de competencia se actualizan las opciones, se limpia el club si deja de ser válido, se descarta una respuesta tardía de la competencia anterior y se retira el reporte anterior. Las cuentas de club y el personal conservan su club fijo y el nadador su reporte personal: no consultan este endpoint.
- **Resumen por club** (`/reportes/resumen-por-club`). Exclusivo de administración en la navegación (pestañas de Reportes), en la ruta de la interfaz y en el servidor: `requireRole("admin")` con los roles vigentes de cada solicitud, y el servicio vuelve a exigir el alcance de administración. Cualquier otro rol recibe 403 aunque tenga `reports:read`. El único filtro es la competencia; administración puede elegir también las ocultas.
- **Reglas de conteo** (una consulta SQL agregada por competencia, `resumenPorClub.service.ts`):
  - Solo inscripciones `confirmed`, igual que el reporte detallado y Team Manager.
  - Se agrupa por el **club de la inscripción** (`club_id`), no por su nombre ni por la membresía actual del nadador: dos clubes homónimos son dos filas.
  - **Nadadores**: personas distintas por club, uniendo inscritos individuales e integrantes de relevos confirmados. Quien solo nada relevos cuenta, y quien está en varias pruebas cuenta una vez en ese club.
  - **Varones / Damas**: por el sexo de la persona, no por el género de la prueba; un relevo mixto no crea un tercer grupo.
  - **Pruebas individuales**: cada inscripción individual confirmada. **Relevos**: cada equipo confirmado, una vez. **Total de pruebas** = individuales + relevos.
  - **Totales**: suma de cada columna sobre todas las filas. Quien compite por dos clubes en la misma competencia cuenta en ambos.
  - La respuesta no lleva RUN, nombres de personas ni fechas de nacimiento.
- **Team Manager por fila.** Cada fila descarga el ZIP de su club con la exportación existente (`/export/team-manager/zip`), que conserva su contenido, sus validaciones y su control de acceso. No hay exportación global. Cada fila muestra su propio estado y su propio error sin bloquear a las demás.

### Resumen por club: columna de edad con «Edad mínima» configurable (estado: publicada y desplegada en API y web; entorno local actualizado, dentro del alcance validado)

> **Estado:** ampliación posterior al cierre de Reportes anterior, que se conserva como antecedente (más arriba). Está **publicada y desplegada en API y web; entorno local actualizado, dentro del alcance validado**: no hubo validación autenticada del filtro ni exportaciones en producción (ver «Qué no se comprobó»). El código es el commit `0f03a0d0db02da5255eb9d6b422e19b9bae5f29a`; el mantenimiento no cambió.
>
> **Qué se validó y cómo** (cada capa por separado):
>
> - **Pruebas locales y CI.**
>   - Integración real contra la base desechable de pruebas, con la fecha de corte, el umbral y la validación del parámetro.
>   - Pruebas puras de equivalencia exhaustiva con `computeAge`.
>   - Pruebas automatizadas simuladas de la interfaz (jsdom): interacción, validación, respuestas tardías y exportaciones.
>   - La CI del código (`43265810427`) terminó en éxito.
> - **Revisión visual con API simulada.** Se hizo en un navegador real, con una API simulada y datos sintéticos (escritorio y pantalla angosta): verificó presentación e interacción de la interfaz, no el backend integrado ni el contenido de ningún ZIP de Team Manager.
> - **Estado de despliegue observado en Render.** Ver «Producción» más abajo.
> - **Lecturas HTTP.** Ver «Disponibilidad» más abajo: son lecturas públicas sin credenciales.
>
> **Qué no se comprobó.** No se hicieron pruebas autenticadas del filtro ni exportaciones en producción, así que la columna de edad y el campo «Edad mínima» no se probaron allí. Las lecturas públicas acreditan disponibilidad, no el cálculo del filtro.
>
> **Producción** (Render, Auto-Deploy Off en ambos servicios; despliegue manual por SHA exacto):
>
> | Servicio | Versión | Despliegue | Resultado |
> |---|---|---|---|
> | `fchmn-api` | `d8c3acf` → `0f03a0d` | `dep-dbqvdbe7bikc73c0999g` | Deploy succeeded y Live |
> | `fchmn-web` | `d8c3acf` → `0f03a0d` | `dep-dbqvf4jbc2fs73fa72j0` | Deploy succeeded y Live |
> | `fchmn-mantenimiento` | sin cambios, `b1b1c2a` | no se desplegó | — |
>
> Sin migraciones, seed ni variables o configuración nuevas.
>
> **Disponibilidad** (2026-11-12, sin credenciales):
>
> - Muestreo de `/api/health` por la web, de 17:25:00Z a 17:34:05Z: **51 de 51 respuestas con 200**, con latencias de aproximadamente 286 a 939 ms. Los intervalos entre muestras no se observaron. La última muestra es 73 segundos posterior a la observación de la web Live.
> - Las horas de «Live observado» (API 17:29:00Z, web 17:32:52Z) son las de la consulta espaciada, no las horas exactas de transición. La primera muestra con el uptime de la instancia nueva de la API es de las 17:26:48Z: es una observación, no la hora exacta del reinicio.
> - Comprobación final: `/login`, `/api/health` y `/api/ready` con 200 (`database: ok`); `/api/auth/me` sin credenciales con 401. Las comprobaciones realizadas conservaron `Cache-Control: no-store` y la CSP.
>
> **Entorno local.** Imágenes de backend `0a65cc0c599e` y de frontend `c8084e7faa53`, construidas desde la copia limpia de `0f03a0d`. Postgres y su volumen se conservaron, y solo se recrearon backend y frontend. No se ejecutaron migraciones ni seed, y **C-05 no está aplicada**. Al terminar, los servicios quedaron detenidos, como al inicio. No se afirma identidad binaria con Render: los nombres de los paquetes de JavaScript difieren entre local y producción, y la causa no se investigó.

- **Qué agrega.** Un campo numérico «Edad mínima» junto al selector de competencia, con 70 al inicio, y una columna «Nadadores de N años o más» junto a «Total nadadores», con su total en el pie. Sin endpoints, migraciones ni dependencias nuevas.
- **Qué controla la edad mínima.** Solo esa columna y su total. No cambia varones, damas, total de nadadores, pruebas individuales, relevos ni total de pruebas. Tampoco cambia qué clubes aparecen (siguen todos los que tienen una inscripción confirmada, aunque su columna de edad sea 0) ni la exportación a Team Manager, que sigue exportando el club completo. El selector de clubes del reporte detallado no cambia.
- **Edad mínima y fecha de corte son cosas distintas.** La edad mínima es el umbral. La fecha de corte es el día al que se mide la edad: el `ageCutoffDate` de la competencia o, si falta, `getDefaultAgeCutoffDate()` (31 de diciembre del año en curso, en UTC), igual que el reporte detallado. Cuenta quien cumple `computeAge(birthDate, fechaDeCorte) >= edadMinima`, incluido quien cumple justo en la fecha de corte.
- **Contrato** (`GET /reports/clubs-summary`):
  - Parámetro opcional `edadMinima`. Si se omite, se usa 70.
  - Se acepta un entero de **0 a 150**, escrito solo con dígitos: sin signo, decimales, espacios, exponente ni ceros a la izquierda. Un valor vacío, `7.5`, `-1`, `abc`, `Infinity`, `1e2`, `070`, `151` o un parámetro repetido reciben 400. El tope de 150 cubre cualquier edad real y mantiene el año límite (año del corte − edad) en años de calendario válidos; el cálculo solo compara enteros.
  - La respuesta informa `edadMinima` (el umbral aplicado) y cada fila y los totales traen `nadadoresConEdadMinima`.
- **Cálculo en la base.** En la misma consulta agregada, con las mismas personas distintas por club que «Total nadadores» (individuales e integrantes de relevos confirmados, una vez por club, por el club de la inscripción). Compara la tupla (año, mes, día) del nacimiento con (año del corte − edad mínima, mes del corte, día del corte). No resta años a una fecha, así que quien nació un 29 de febrero cumple en un año no bisiesto recién el 1 de marzo, como en `computeAge`. El total es la suma de la columna.
- **Interfaz.**
  - Escribir o borrar en el campo no consulta ni retira la tabla. La edad se confirma con «Aplicar» o Enter, que hacen una sola consulta. Mientras haya un cambio sin aplicar, el campo lo indica y se siguen mostrando los últimos resultados.
  - Un valor vacío o inválido muestra la validación y no se aplica.
  - El encabezado sale de la edad que informa la respuesta, no del campo. Mientras se recalcula, la tabla anterior se atenúa y un aviso indica que sus resultados son de la edad anterior. Si la actualización falla, se muestra el error y «Reintentar» vuelve a pedir la misma edad.
  - Al aplicar otra edad en la misma competencia, la tabla no se vuelve a montar, así que conserva su desplazamiento horizontal. Cambiar de competencia sigue retirando los resultados de la anterior.
  - Se descarta cualquier respuesta tardía de otra combinación de competencia y edad. Aplicar otra edad no altera el estado de las exportaciones en curso.
- **Privacidad y acceso.** La fecha de nacimiento solo se compara dentro de la base: la respuesta sigue sin RUN, nombres de personas ni fechas de nacimiento. El acceso sigue siendo exclusivo de administración.

### Competencia por defecto y presentación del listado (estado: publicada y desplegada en API y web; entorno local actualizado, dentro del alcance validado)

> **Estado:** **publicada y desplegada en API y web; entorno local actualizado, dentro del alcance validado.** El código es el commit `e02ba9466ba3fff4117a9b8d1036bd1b78edb106`. No hubo validación funcional autenticada en producción (ver «Qué no se comprobó»). Los cierres anteriores de Reportes se conservan como antecedentes, más arriba. *Antecedente:* hasta el despliegue, este estado decía «publicada en el repositorio y validada dentro del alcance descrito; pendiente de despliegue y actualización local».
>
> **Qué se validó y cómo** (cada capa por separado):
>
> - **Pruebas funcionales locales y CI.** Las de «Validación local», más abajo: pruebas automatizadas simuladas de la interfaz (jsdom), unitarias del backend e integración real sobre la base desechable. La CI del código (`43595888561`) terminó en éxito.
> - **Revisión visual con API simulada.** Frontend real y API simulada con datos sintéticos (ver «Validación local»). Verifica presentación e interacción, no el backend integrado ni ningún ZIP de Team Manager.
> - **Estado observado en Render.** Ver «Producción».
> - **Disponibilidad y cabeceras HTTP.** Ver «Disponibilidad»: lecturas sin credenciales.
>
> **Producción** (Render, Auto-Deploy Off en ambos servicios; despliegue manual por SHA exacto):
>
> | Servicio | Versión | Despliegue | Resultado |
> |---|---|---|---|
> | `fchmn-api` | `5780336` → `e02ba94` | [`dep-dbs6aguk1f9s738d0oi0`](https://dashboard.render.com/pserv/srv-dbh4ih4ipgvc73dore80/deploys/dep-dbs6aguk1f9s738d0oi0) | Deploy succeeded y Live |
> | `fchmn-web` | `5780336` → `e02ba94` | [`dep-dbs6bfu1egvs73cv6du0`](https://dashboard.render.com/web/srv-dbh48scs728c73arlf8g/deploys/dep-dbs6bfu1egvs73cv6du0) | Deploy succeeded y Live |
> | `fchmn-mantenimiento` | sin cambios, `5780336` | no se desplegó | — |
>
> Sin migraciones, seed, variables o configuración nuevas, y sin operaciones de respaldo: el tramo `5780336..e02ba94` no cambia esquema, paquetes ni Dockerfiles.
>
> **Disponibilidad** (2026-11-14, sin credenciales):
>
> - Muestreo de `/api/health` por la web, de 13:41:44Z a 13:47:16Z: **32 de 32 respuestas con 200**, con latencias de aproximadamente 0,28 a 0,74 s. Los intervalos entre muestras no se observaron, así que esto no acredita disponibilidad continua.
> - La muestra de las 13:42:59Z es la primera que observó la instancia nueva de la API: es una observación, no la hora exacta del reinicio.
> - Comprobación final:
>   - `/login`, `/api/health` y `/api/ready` respondieron 200, y `/api/auth/me` sin credenciales, 401;
>   - las cabeceras de seguridad de `/login` coincidieron con las previas al despliegue, y `/api/health` conservó `Cache-Control: no-store`;
>   - el paquete del frontend se sirvió correctamente, con los textos nuevos. Eso acredita la entrega del paquete, no una prueba funcional.
>
> **Entorno local.**
> - Imágenes de backend `7ae3e21a5a54` y de frontend `7d1fe37ef07b`, construidas desde la copia limpia de `e02ba94`.
> - PostgreSQL y su volumen se conservaron, sin migraciones ni seed, y solo se recrearon backend y frontend. Al terminar, los tres servicios quedaron detenidos, como al inicio.
> - Las imágenes anteriores se conservan para la reversión.
> - No se afirma identidad binaria con Render.
>
> **Qué no se comprobó y qué queda pendiente.**
> - No hubo validación funcional autenticada ni escrituras de prueba en producción.
> - Team Manager no se modificó, y no se ejecutaron exportaciones reales ni comparaciones de ZIP. CSV, XLSX y PDF no cambian.
> - Siguen pendientes:
>   - la comprobación en Safari de macOS real (al cierre de este despliegue; después, el usuario informó que revisó en Safari en Mac y que funciona bien: ver «Presentación y desplazamiento en los paneles»);
>   - la configuración de accesos por rol, que está solo diseñada (al cierre de este despliegue; después quedó publicada en el repositorio y más tarde migrada y desplegada en API y web desde `430c4cb`, con el entorno local actualizado: ver «Accesos por rol»);
>   - los dos problemas preexistentes de anchura, descritos al final de esta sección.

- **Competencia por defecto en Reportes.** «Listado de inscritos» (el de «Generar reporte») y «Resumen por club» preseleccionan la competencia por defecto con el **mismo criterio** de los paneles de Inscripción y de Relevos (`competenciaPreseleccionada`; ver «Competencia por defecto de los paneles»):
  - Solo si está entre las competencias que esa cuenta puede elegir. Administración conserva su excepción para las ocultas. Si no hay una accesible, el selector queda vacío.
  - Una elección manual, incluido volver a «Seleccionar...», no se pisa.
  - Si la selección deja de estar disponible, se vacía, se retiran sus resultados y no se sustituye por otra.
  - La preselección pasa por la **misma preparación que una elección manual**. En el listado de inscritos invalida el informe a la vista y, para administración, deja pendientes las opciones de club hasta que respondan, así que no se puede generar ni exportar con un club aún no validado. En el resumen reinicia la generación de la selección, que protege las exportaciones por fila, también tras A → B → A.
  - **No genera el informe**: «Generar reporte» sigue siendo el botón. El resumen carga como siempre al tener competencia.
  - Se conservan la paginación completa, el filtro de clubes con inscripciones y el descarte de respuestas tardías de listas, clubes, informes y resúmenes.
- **Línea de cada nadador en «Generar reporte».** El formato pasa a ser `PATERNO MATERNO, NOMBRE (EDAD) - Categoría - Género`, con nombre y apellidos en mayúsculas y la edad sin «años». Se conservan la numeración por club, la agrupación, los totales y las listas de pruebas y relevos.
  - **Nombre.** Se arma con los campos separados y el mismo criterio de los paneles (`nombreEnPanel`): sin materno queda `PATERNO, NOMBRE`. Un registro histórico sin apellido paterno o sin nombre muestra el nombre almacenado en mayúsculas, sin coma ni apellidos inventados.
  - **Edad.** Es la que calcula el servidor a la fecha de corte.
  - **Orden.** No cambia: es el del servidor (`compararNadadores`, ver «Orden del reporte» más abajo). La pantalla no reordena.
- **Contrato.** La vista agrupada (`groupedByClub[].swimmers[]`) agrega `apellidoPaterno`, `apellidoMaterno` y `nombres`, tal como están guardados y con `null` si faltan, **solo para la presentación**. Es un cambio compatible: con una API anterior, la pantalla muestra `nombreCompleto` en mayúsculas.
  - `nombreCompleto`, `fullName` y las demás salidas no cambian.
  - No se agrega RUN ni fecha de nacimiento, y no cambian los alcances por rol, club o persona. El nadador sigue recibiendo solo su propia línea.
- **Exportaciones sin cambios.** CSV, XLSX y PDF usan las filas planas (`individualRows`, `relayRows`), no la vista agrupada, así que su contenido y formato no cambian. Los botones conservan sus llamadas. La exportación a Team Manager (`team-manager-export/`) no se tocó y no importa nada de Reportes. Esto **no** equivale a haber comparado un ZIP generado.
- **Validación local, con resultados reales:**
  - Frontend de Reportes y de la competencia por defecto de los paneles (jsdom, API simulada): 114 de 114 en 9 archivos.
  - Backend: unitarias de Reportes y prueba documental, 70 de 70 en 4 archivos.
  - Integración sobre la base desechable, solo los archivos de Reportes afectados: 2 archivos, 122 de 122.
  - Tipos sin errores. Lint sin errores nuevos.
  - **Revisión visual con capturas**, en Chromium (navegador integrado visible), con el frontend real y una API simulada con datos sintéticos. Ancho efectivo medido en la página: 1280 px en escritorio y 375 px de documento en pantalla angosta.
    - Como administración, en los dos anchos:
      - preselección con «Cargando clubes...» y luego los clubes, sin informe hasta pulsar el botón;
      - formato, apellidos compuestos, registro histórico y ajuste de líneas: a 375 px todas las líneas caben, con el borde derecho más lejano a 359 px;
      - totales y listas de pruebas conservados;
      - resumen por club preseleccionado, con sus controles.
    - Como delegado, en una revisión anterior **sin capturas** (navegador oculto, lectura del DOM): selector vacío con la predeterminada oculta, y preselección sin generar con la visible.
    - No se pulsó ninguna exportación.
  - **Problemas preexistentes observados, ajenos a esta entrega** (no se modificaron):
    - A 375 px, la fila de botones del listado de inscritos no se ajusta y llega a unos 700 px, con desplazamiento horizontal de la página.
    - La tabla del resumen es más ancha que su contenedor también a 1280 px (1063 frente a 981 px): la columna de Team Manager se alcanza desplazando la tabla.

### Reglas aplicadas en el Módulo 10

- **Una sola fuente de verdad para el formato de fila**: `mapIndividualRegistrationToRow` y `mapRelayRegistrationToRow` (`reports.rules.ts`) son funciones puras que definen el "shape" exacto de cada fila una sola vez; JSON, CSV, XLSX y PDF consumen la misma salida — no hay 4 implementaciones distintas del mismo formato que puedan desincronizarse. **20 pruebas unitarias** verifican el formateo exacto de columnas (incluida la traducción de género) y el escapado CSV (RFC 4180: comillas, comas, saltos de línea).
- **Columnas mínimas exigidas** (sección 16) presentes, salvo el RUN, que se retiró: para individuales — competencia, club, nombre, fecha de nacimiento (solo para la administración; los demás roles reciben la **edad** en su lugar, AUD-10), categoría, prueba, distancia, estilo, género, fecha, jornada, tipo de prueba; para relevos — equipo/club, prueba, categoría, y los 4 integrantes **por nombre**. **Ningún reporte entrega el RUN** (SEC-02), para ningún rol, y la columna «RUN» ya no existe en CSV ni en XLSX; la excepción es el archivo de Team Manager, que lo conserva.
- **Exportación real a 3 formatos**: se agregaron `exceljs` (Excel nativo, no CSV disfrazado) y `pdfkit` (PDF real) como dependencias del backend — verificado generando y reabriendo archivos de muestra antes de entregar el módulo.
- El reporte siempre parte de `Registration`/`RelayRegistration` con `status: confirmed` — las inscripciones canceladas nunca aparecen en el listado ni en las exportaciones.
- **Orden del reporte** (criterios puros en `reports.rules.ts`, compartidos por la vista agrupada y por las filas planas de CSV / XLSX / PDF, probados en `reports-orden.test.ts`):
  - **Clubes**: alfabético, como siempre. **Nadadores dentro de cada club: por apellido paterno** (no por edad; la edad se sigue mostrando). Desempates, en orden: apellido materno, nombre de pila, nombre completo almacenado, RUN e identificador. Sin distinguir mayúsculas ni tildes; la «ñ» es una letra propia.
  - **Personas históricas sin apellido paterno** (`paternalLastName` nulo o vacío): **no se les inventa ni se les deduce un apellido** del nombre completo, ni se modifica el nombre almacenado. Van **después** de todas las que sí lo tienen, por su nombre completo almacenado y luego RUN e identificador.
  - **Pruebas y relevos de cada nadador**, en listas separadas, por **número de programa numérico** (2, 3, 10 y no 10, 2, 3). El número de programa es `CompetitionEvent.displayOrder` —la única columna que lo guarda; `eventNumber` es el nombre que le da el importador de Meet Events al mismo dato—. Los números **ausentes van al final**; los **repetidos o ausentes** se desempatan por su texto visible (descripción y tiempo, el mismo que muestra la vista agrupada) y, **solo como último recurso**, por el identificador de la inscripción: el identificador nunca decide antes que el texto. La vista agrupada y las filas planas de los archivos comparten el mismo criterio (`compararLineasDePrueba`), de modo que dos filas equivalentes de un mismo nadador salen en el mismo orden relativo en ambos.
  - **Categoría y club mostrados: no cambian.** Siguen siendo los de la primera inscripción del nadador en el orden en que el servicio la entrega (sus individuales antes que sus relevos), como antes. **No dependen del orden de presentación**: ordenar pruebas y relevos no altera la categoría, y no se redefine como «la de la primera prueba del programa».
  - **Formatos**: CSV, XLSX y PDF usan las mismas filas planas, así que comparten el orden: individuales por club, nadador (apellido paterno…) y, dentro del nadador, el criterio de pruebas anterior; **relevos, una fila por equipo** (no por nadador), por club y ese mismo criterio (luego categoría e identificador). No se añaden columnas ni se duplican filas. La diferencia con la vista agrupada es la justificada por su estructura: allí hay una línea por nadador con sus listas; aquí, una fila por inscripción o por equipo.

## Módulo 11 — Exportación a Team Manager (resuelve A-06)

Se partió de exportaciones reales de Hy-Tek Team Manager (`.HY3` y `.CL2`). Se
decodificó su estructura byte a byte y se implementaron generadores **verificados
contra datos reales**, no contra documentación de terceros sin contrastar. Los
fixtures que se conservan en el repositorio son sintéticos.

**Lo que se descarga es un ZIP con exactamente dos archivos, un `.CL2` y un `.HY3`**,
de las mismas inscripciones, personas y relevos: los dos salen de un único modelo
(`export-model.ts`). Es la forma del paquete que Team Manager produce y que HY-TEK
Meet Manager importa.

> **Motivo.** Meet Manager rechazó el `.HY3` anterior con «NO es un archivo .HY3
> creado por Active». Frente a una exportación real que sí importa, el encabezado
> difería: el `A1` decía `Sist. FCHMN` donde va `Hy-Tek, Ltd`, y la hora corría una
> columna el resto de la línea. **Es la causa probable, no demostrada**: no se ha
> podido ejecutar Meet Manager para aislar cuál de las diferencias lo provoca.
> *Antecedente:* aquí constaba que la importación real en HY-Tek seguía pendiente.
> Después, el usuario importó manualmente en Meet Manager un **candidato derivado**
> (no una exportación del servicio desplegado) con resultado satisfactorio: ver
> «Géneros, nombres de archivo, categoría y exhibición de los relevos».

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
- **Exportación real reconstruida**: con los generadores actuales, un paquete real
  de 24 nadadores, 72 pruebas y 3 relevos se reconstruyó **idéntico byte a byte**, en
  sus dos archivos (108 líneas de HY3 y 115 de CL2), a partir de los datos leídos del
  propio archivo. Es una comprobación hecha **fuera del repositorio**, porque ese
  archivo tiene datos personales. Reconstruir no es importar: demuestra el formato de
  lo que aquel archivo contenía, no lo que hace el programa con otros casos.
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
- **Fechas de la competencia en `B1`.** Los dos campos de fecha de la competencia
  (inicio y término) salen de sus **`CompetitionDate`**, no de las fechas de
  inscripción, que es lo que se escribía hasta el 2026-11-02. Con un día, inicio y
  término son ese día; con varios, la primera y la última programadas, sea cual sea
  el orden en que se dieron de alta. Una competencia **sin fechas** no se exporta:
  responde 400 con un mensaje claro, sin sustituirlas por las de inscripción. El día
  se lee con los componentes UTC (el sistema guarda cada fecha como medianoche UTC),
  así que no se desplaza por la zona horaria del servidor. **El corte de edad no
  cambió**: sigue siendo `ageCutoffDate` y, si falta, el cierre de inscripciones.
  Cubierto en `hy3-fechas-competencia.test.ts` (incluye procesos con otras zonas
  horarias) y en `import-export-services.integration.test.ts`.

### Limitaciones documentadas honestamente

- **Lo que el `.CL2` real no contenía y por tanto es inferencia.** Sale del estándar
  SDIF, sin contraste contra Hy-Tek: una prueba o relevo **sin marca** (`NT`), un
  código de club de 5 caracteres, y un nadador **que solo nada relevos**, que no lleva
  `D0` y aparece únicamente en sus `F0`. Son los primeros sitios donde mirar si un caso
  real falla. *Antecedente:* el relevo **combinado** (estilo `7`) y el relevo **mixto**
  (sexo `X`) figuraban aquí como inferencia; una exportación de referencia de Team
  Manager con un relevo mixto combinado los trae así.
- **Sede**: el `B1` de ambos formatos lleva la constante `cduc` de la muestra. El
  sistema no modela este dato.
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

### `.CL2`: SDIF de 160 columnas

`cl2-writer.ts`. Registros `A0`, `B1`, `C1`, `D0` (una prueba individual), `D3` (una
por nadador, tras su primer `D0`), `E0` (equipo de relevo), `F0` (un integrante, en
orden de posta) y `Z0` (conteos). Cada línea tiene 160 columnas: 156 de contenido, un
espacio, una `N` y el checksum, y termina en CRLF, también la última.

**El checksum se determinó** (antes figuraba como no resuelto): suma simple de los
bytes de las columnas 0-155, sin ponderar; `floor(suma / 19) + 11`; dígito de unidades
y luego el de decenas. Búsqueda exhaustiva sobre ventana, pesos, divisor, constante y
orden de dígitos: es la **única** combinación que acierta en las 115 líneas de una
exportación real, incluidas las que llevan `ñ`. Solo se ven dos dígitos, así que la
constante queda determinada módulo 100.

Un hallazgo que se cruza con el HY3: la edad de `D0` y `D1` es a la **fecha de corte**,
pero la de `F0` es a la **fecha de la competencia** (en el archivo real solo así
coinciden los 12 integrantes; a la fecha de corte, 10).

### Nombres y RUN en estos archivos

- **Solo el apellido paterno**, en los dos formatos y en las referencias de relevo
  (`F3`), tal como está en su campo: `De la Fuente` sale entero, y el materno no sale.
- **Una persona histórica sin nombre y apellido paterno por separado detiene la
  exportación** con un 400 que la nombra. De su `fullName` no se puede saber qué es
  apellido paterno, así que no se adivina, igual que con una piscina sin asignar o un
  relevo incompleto. Se corrige completando la ficha.
- **RUN sin puntos y con guion** (`11111111-1`, `K` mayúscula), alineado a la izquierda
  en su campo, en la columna 69 del `D1`. Lo que no tiene forma de RUN no recibe un
  guion inventado.
- Es solo la forma de exportarlos: lo almacenado y lo que muestra el resto del sistema
  no cambian.

El `A1` del HY3 lleva `Hy-Tek, Ltd` en la columna 29 y la hora ajustada a la derecha en
las columnas 66-74, pegada a `TEAM MANAGER Lite`: `3:54 PMTEAM MANAGER Lite`.

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
  *Antecedente:* aquí constaba que, con marca, el `F1` lleva una `X` en la columna 83
  (y el `E0` del CL2 otra en la 154). Esa `X` es la marca de **exhibición**: Meet
  Manager importó como «Exh» los relevos con marca. Ahora ambas posiciones van en
  blanco, con marca o sin ella, y la marca se conserva en su campo. Ver «Géneros,
  nombres de archivo, categoría y exhibición de los relevos».
- **`F3`** (los 4 integrantes del equipo, en orden): mismo `swimmerId` que su
  registro `D1` — un nadador que compite en un relevo pero en ninguna prueba
  individual igual recibe su línea `D1` (sin `E1` después), tal como en la muestra
  real: primero se listan todos los nadadores que SOLO están en relevos, y recién
  después los que tienen pruebas individuales (con su `D1` seguido de sus `E1`).

El endpoint incluye ambos tipos de inscripción en un mismo paquete por club.

- El campo de "tiempo de marca de referencia" (seed time) se exporta con el valor
  real si el nadador (o el equipo de relevo) tiene uno cargado; si no, se exporta
  como `0`.

### Géneros, nombres de archivo, categoría y exhibición de los relevos (estado: publicada en el repositorio y validada localmente, con importación manual satisfactoria del candidato derivado; pendiente de despliegue y actualización del entorno local)

> **Estado:** **publicada en el repositorio y validada localmente, con importación manual satisfactoria del candidato derivado; pendiente de despliegue y actualización del entorno local.** El **servicio desplegado todavía no contiene esta corrección**: hasta desplegarla, lo que se descarga de producción sigue con el formato anterior (género de la prueba copiado del nadador, `MIX`, mes en inglés, `X` de exhibición en los relevos con marca y un correlativo desde 100 como categoría). Sin cambios de esquema, migraciones, seed, variables, permisos ni rutas.

**Qué cambia** (posiciones contadas **desde 0**, como `slice`; la columna en base 1 es la siguiente).

- **Sexo de la persona y género de la prueba, separados.** La persona conserva M o F (HY3: `D1` posición 2, `E1` posición 2 y `F3`; CL2: `D0` posición 65 y `F0`). La prueba lleva el suyo, tomado de `competitionEvent.event.gender`: `E1` posiciones 13-14 (`XX` en una prueba mixta) y `D0` posición 66 (`X`). Antes ambos campos copiaban el sexo del nadador.
- **Género mixto en los dos formatos.** El relevo mixto escribe `XXX` en el `F1` (posiciones 12-14; antes `MIX`) y `X` en el `E0` (posición 20, ya era así). `MMM`/`M` y `FFF`/`F` no cambian.
- **Mes en español en los nombres de archivo** (`ene` a `dic`): el ZIP, el `.HY3` y el `.CL2` comparten la base, por ejemplo `SIGLA-Entries-Competencia-06ene2027-001`. El día se lee en UTC, como antes, y las fechas dentro de los archivos siguen siendo numéricas (`MMDDYYYY`).
- **Campos de exhibición vacíos.** `F1` posición 83 y `E0` posición 154 quedan en blanco, tenga el relevo marca o no; el sistema no tiene relevos de exhibición. Antes llevaban `X` siempre que había marca, y Meet Manager marcaba «Exh» y anteponía la `X` a la marca. **Las marcas se conservan**: `F1` posiciones 51-58 con el curso en la 59 (`0.00` sin marca) y `E0` posiciones 45-52 con el curso en la 53 (`NT` sin marca).
- **Categoría del relevo en el HY3.** `F1` posiciones 9-11 llevan la **categoría registrada del relevo**: la `minAge` de la categoría con que quedó inscrito, que el sistema resuelve al inscribir por la suma de edades de los integrantes a la fecha de corte (200 para 200-239), ajustada a la derecha. Ya **no hay un contador desde 100** (100, 101…), que Meet Manager leía como categoría. Un valor que no sea un entero de 0 a 999 detiene la exportación en vez de recortarse. Dos relevos de pruebas distintas pueden compartir categoría. El CL2 no tiene campo de categoría: el `E0` conserva `UNOV` y la suma de edades (posiciones 34-36) en blanco, como la referencia.
- **No cambian:** marcas, integrantes y orden de postas, número de prueba, distancia, estilo, piscina, inscripciones individuales ni datos almacenados.

**Evidencia de la categoría** (exportaciones de Team Manager revisadas fuera del repositorio, sin datos personales en este documento). En una, los dos relevos, de pruebas distintas, llevan `200`. En otra, tres relevos llevan `160`, `200` y `240`, dos de ellos en la misma prueba, y la suma de edades de cada equipo cae en 160-199, 200-239 y 240-279 respectivamente. Es decir, el campo es el límite inferior del tramo y no un identificador único. **Dependencia del catálogo:** el archivo lleva la `minAge` tal como esté configurada. Solo se observaron 160, 200 y 240; si las categorías de relevo del catálogo no reproducen los tramos de Team Manager, el archivo llevará el límite configurado. No se revisó el catálogo de producción.

**1. Pruebas del generador y del servicio real** (datos sintéticos; la integración, solo contra la base desechable de `docker-compose.test.yml`; rondas separadas).

- **Ronda de géneros y nombres.**
  - `tests/team-manager-genero-prueba.test.ts`, nueva: 32 casos. Con el código anterior fallaron 22, por los motivos esperados. Dos salvedades: el cambio de `MIX` a `XXX` vive en el servicio, así que solo falló su función nueva por no existir; y el escritor del `F1` ya copiaba `XXX` si se le entregaba. Pruebas del generador: 178/178.
  - Integración: 5 pruebas nuevas en `import-export-services.integration.test.ts`, que llaman a `buildTeamManagerExport` y abren el ZIP que devuelve (sin armar el modelo a mano); el archivo pasó 115/115. Contrapruebas temporales en el servicio, restauradas byte a byte: volver a derivar el género de la prueba del sexo del nadador y volver a emitir `MIX` hicieron fallar las pruebas correspondientes.
- **Ronda de categoría y exhibición.**
  - `tests/team-manager-relevos-categoria-exhibicion.test.ts`, nueva: 17 casos (relevos masculinos, femeninos y mixtos, con y sin marca; categorías 200, 200, 240 y 160; integrantes; largos, checksums, Latin-1 y CRLF). Con el código anterior fallaron 10, por los dos defectos. Cambiaron de significado tres expectativas antiguas que exigían la `X` con marca (`hy3-writer.test.ts` y `cl2-writer.test.ts`), y el campo `relayId` pasó a `categoriaRelevo`, con valores de categoría realistas en los fixtures. Pruebas del generador: 195/195.
  - Integración: 4 pruebas nuevas con categorías por suma de edades (200, 200, 240 y 160), que coinciden con las que guarda el sistema para cada inscripción; el archivo pasó 119/119. Una contraprueba temporal que volvía al correlativo desde 100 hizo fallar la prueba de categoría y la de huella; el servicio se restauró byte a byte.
- **Huellas fijas de SEC-02.** Se actualizaron en cada ronda conservando las anteriores: deshaciendo **solo** los campos corregidos (y recalculando el checksum de esas líneas) el archivo vuelve exactamente a la huella previa. En la segunda ronda solo cambió el HY3, porque ese montaje inscribe el relevo sin marca.
- Tipos sin errores y lint limpio en el área.

**2. Verificación independiente del candidato derivado** (fuera del repositorio). Para probar en Meet Manager se derivó un paquete del ZIP que FCHMN ya había generado para un club real; su contenido no se publica. Primero se corrigieron los campos de género, `XXX` y el mes del nombre. Después, a partir de ese mismo candidato ya importado, solo la categoría (`F1` posiciones 9-11), la exhibición (`F1` 83 y `E0` 154) y sus checksums; cada `F1` derivado coincide con lo que escribe el generador corregido. Un verificador independiente confirmó: 6 nadadores, 41 inscripciones individuales y 2 relevos; personas, inscripciones individuales, integrantes, orden de postas y marcas idénticos al origen; largos, checksums, CRLF y codificación válidos, y los mismos nombres y fechas de entrada en el ZIP. **No es una exportación del servicio desplegado.**

**3. Importación manual del candidato derivado** (informada por el usuario, en Meet Manager).

- Con el primer candidato (solo géneros y mes), las inscripciones se cargaron, pero los relevos quedaron como exhibición y con categorías `A 100` y `A 101` en vez de `A 200`: los dos defectos corregidos aquí.
- Con el candidato corregido, el usuario confirmó que la importación fue correcta. **Sus capturas muestran** la categoría 200 en ambos relevos, «Exh» desmarcado, las marcas 4:00,00 y 5:00,00, y «Gen X» conservado en el relevo mixto.
- El informe de inscripciones de Meet Manager posterior a esa importación (privado) muestra 41 inscripciones individuales y 2 relevos, los relevos como `X200` y `F200`, y ninguna marca precedida de `X`. Es una revisión manual del usuario, no una prueba automatizada.

**4. Servicio desplegado.** **No contiene esta corrección.** Falta desplegarla en API y web, actualizar el entorno local y comprobar una exportación obtenida del servicio desplegado.

**Limitaciones**

- **Contradicción no resuelta:** una exportación de referencia de Team Manager con relevos con marca también traía la `X` en esas posiciones; no se sabe si allí se importaron como exhibición. La semántica de exhibición se basa en el comportamiento observado en Meet Manager.
- La categoría depende de cómo estén configuradas las categorías de relevo en el catálogo; fuera de 160, 200 y 240 no hay evidencia.
- La importación manual cubrió un solo club y una competencia, con un relevo mixto y uno femenino; no se importó un relevo masculino ni uno sin marca.
- No hay prueba automatizada contra Meet Manager.

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
| GET | `/export/team-manager/zip?competitionId=&clubId=` | Descarga el ZIP (`application/zip`) con un `.CL2` y un `.HY3` de las inscripciones individuales Y de relevo confirmadas de un club en una competencia. El administrador exporta cualquier club; el rol `club` y el personal de club, solo el suyo | `export:team-manager` |
| GET | `/export/team-manager/hy3?competitionId=&clubId=` | Alias de la ruta anterior: entrega el mismo ZIP, para las pestañas que sigan abiertas con la versión previa de la web durante un despliegue. Ya no devuelve un `.HY3` suelto | `export:team-manager` |

**Cambio de contrato.** La ruta canónica pasa a ser `/export/team-manager/zip`, y la
respuesta deja de ser `application/octet-stream` con un `.HY3`: es `application/zip`.
El permiso, los parámetros, los 403 y los límites no cambian. La auditoría sigue
registrando `TEAM_MANAGER_EXPORT_HY3` para no partir el historial, y añade `files` con
los dos nombres.

**Quién puede exportar.** El permiso `export:team-manager` lo tienen el
administrador, el rol `club` (la cuenta del club) y el personal de club
—delegado, entrenador y representante legal, que comparten
`CLUB_STAFF_PERMISSIONS`—. **No** lo tiene el nadador. El archivo lleva RUN y fecha
de nacimiento, así que el permiso por sí solo no basta: **el alcance lo aplica el
servicio** (`buildTeamManagerHy3Export` recibe el `ActorContext` y llama a
`assertClubAccess` antes de leer nada). La cuenta del club y el personal que pidan
otro `clubId` reciben **403 sin contenido**; el administrador conserva cualquier
club; un nadador puro queda rechazado aunque algún día se le concediera el
permiso. El botón de **Reportes** aparece según `hasPermission("export:team-manager")`
y, para quien no es administrador, el club es el suyo y no se puede elegir.

**Al desplegar este cambio.** (Incluye al rol `club`.) La matriz de permisos vive en
`rbac.definitions.ts`, pero la base de datos guarda la suya en `role_permissions`
y **ninguna migración la actualiza**. Hay que ejecutar el seed (idempotente: agrega lo que falta, no quita nada) en cada entorno donde se
despliegue. **En el despliegue** se ejecuta con la **imagen de mantenimiento**
(`backend/Dockerfile.mantenimiento`, etapa `migrate`) **construida desde el mismo
commit de la entrega**, con el comando admitido en esa imagen:

```bash
node dist-seed/prisma/seed.js
```

y **después de aplicar las migraciones y antes de actualizar la API y la web**.
Secuencia operativa de esta entrega: (1) `prisma migrate deploy --schema=/app/prisma/schema.prisma`
con todas las migraciones pendientes, (2) `node dist-seed/prisma/seed.js`, (3) API,
(4) web. **No se ejecuta `seed-admin`**: la cuenta administradora existente se
conserva. `npm run prisma:seed` es solo para el desarrollo local. Mientras no se ejecute, el servidor sigue respondiendo 403 al
personal y a la cuenta del club, que es el fallo seguro; el servidor relee los permisos en cada
solicitud, y el botón aparece en la siguiente sesión que se emita. Es una
operación de despliegue sujeta a autorización específica en producción.

Los dos archivos se codifican en **ISO-8859-1** (Latin-1), igual que los originales —
no UTF-8, ya que Team Manager es un software de la era DOS/Windows clásico que
espera esa codificación. Un carácter fuera de Latin-1 se exporta como `?`, sin tocar
el dato almacenado.

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
- `team-manager-export.service.ts` — cada descarga ahora registra `TEAM_MANAGER_EXPORT_HY3` con el club y la cantidad de inscripciones incluidas.

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
| POST | `/persons/bulk-import` | Carga masiva de personas —y, si la fila trae sigla de club y fecha efectiva, su membresía activa—, con informe por fila (ver «Carga masiva por Excel con club y fecha efectiva»). Las filas con club exigen además `swimmer-assignment:approve` | `persons:write` |

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
| POST | `/swimmer-assignments/bulk-assign` | Asignación masiva. C-05 (desplegada en producción desde `5780336`): cada fila rechazada trae `codigo` estable (p. ej. `HISTORIAL_INCOMPLETO`) | `swimmer-assignment:approve` |
| POST | `/swimmer-assignments/reassign/:personId` | Traslada un nadador a otro club | `swimmer-assignment:approve` |
| GET | `/swimmer-assignments/swimmers-by-club` | Personas asignables por club actual (o `none`, sin club) para la asignación masiva: lista completa, ordenada por apellido paterno, materno y nombre | `swimmer-assignment:approve` |
| GET | `/swimmer-assignments/current-club/:personId` | Club vigente de un nadador | `swimmer-assignment:read` |
| PUT | `/swimmer-assignments/:id/fechas` | Corrige DESDE (`startDate`) y, en una finalizada, HASTA (`fechaTermino`) de una membresía. No cambia el estado (ver «Clubes y nadadores, orden del plantel y edición de fechas») | `swimmer-assignment:approve` (además, rol `admin`) |

### Apoyo al asistente de inscripción y al programa

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/registrations/available-events` | Pruebas disponibles para un nadador ya elegido (orden de inscripción alternativo: primero el nadador, después la prueba) | `registrations:read` |
| GET | `/registrations/club-eligibility-matrix` | Elegibilidad de **todo** el plantel del club en una sola consulta — la usa el panel de arrastrar y soltar. Cada nadador trae `firstName`, `paternalLastName`, `maternalLastName` y `edadAlCorte` (edad a la fecha de corte de la competencia, con el respaldo del 31 de diciembre) | `registrations:read` |
| GET | `/registrations/club-swimmers` | Plantel del club para el asistente y el Panel de Relevos, con los campos de nombre separados. Con `competitionId` opcional (competencia visible para el actor; si no, 404) cada nadador trae `edadAlCorte` | `registrations:read` |
| PUT | `/registrations/:id` | Edita el tiempo de referencia de una inscripción | `registrations:write` |
| PUT | `/relay-registrations/:id` | Edita un equipo de relevo: tiempo de referencia y, si se entrega, los integrantes y su orden (en Combinado: espalda, pecho, mariposa, libre) | `registrations:write` |
| PUT | `/competition-events/reorder` | Reordena las pruebas del programa | `competitions:write` |
| PUT | `/catalogs/distances/:id`, `/catalogs/strokes/:id` | Edición de los catálogos base | `catalogs:write` |

### Entrada del tiempo estimado (estado: publicada, migrada y desplegada en API y web; entorno local actualizado, dentro del alcance validado)

> **Estado:** **publicada, migrada y desplegada en API y web; entorno local actualizado, dentro del alcance validado.** Forma parte de la misma entrega que «Accesos por rol» (`430c4cb`): su validación final conjunta y el registro del despliegue están allí. No hubo validación funcional autenticada en producción. *Antecedentes:* antes de la publicación, el estado decía «cambio local: sin publicar ni desplegar»; entre la publicación y el despliegue, «publicada en el repositorio y validada localmente; pendiente de migración, despliegue y actualización del entorno local».

En los paneles de Inscripción y de Relevos y en sus asistentes, el tiempo estimado se escribe con **1 a 6 dígitos, sin separadores, leídos de derecha a izquierda**: los dos últimos son centésimas, los dos anteriores segundos y los restantes minutos (hasta 99); lo que falta a la izquierda vale cero. No hace falta completar seis dígitos ni escribir ceros iniciales: `13236` = 1:32,36; `2356` = 0:23,56; `023600` = 2:36,00; `10000` = 1:00,00; `1` = 0:00,01. Se mantienen las demás reglas: segundos entre 00 y 59 (no se convierten en minutos), el tiempo cero se rechaza, no se admiten signos, decimales, exponentes ni separadores, y se ignoran los espacios exteriores. El campo vacío conserva su significado en cada operación. La interfaz envía **centésimas totales** al backend, que no cambia (`frontend/src/shared/swimTime.ts`).

Al **editar**, el campo se precarga con el tiempo guardado convertido al formato del campo (`formatSwimTimeCentiseconds`): un tiempo guardado de 20000 centésimas (3:20,00) aparece como `032000`, y guardar sin cambios envía exactamente 20000. Antes se precargaba el número guardado rellenado con ceros (`020000`, que se lee 2:00,00), así que guardar sin tocarlo podía cambiar los tiempos de un minuto o más. No se corrigieron registros existentes: no se sabe cuáles pudieron verse afectados.

**Limitaciones.** El backend conserva su propio `swimTime.util.ts` con 6 dígitos fijos (ninguna ruta lo usa para leer entradas: recibe centésimas). Un tiempo guardado igual a 0 conserva el comportamiento anterior (en Relevos se precarga vacío; en Inscripción, `000000`, que se rechaza). Los tiempos de 100 minutos o más y el ancho del campo de edición de Inscripción (65 px) no cambiaron. Los asistentes no se revisaron en pantalla: sus ayudas se comprobaron por código y tipos.

### Accesos por rol (estado: publicada, migrada y desplegada en API y web; entorno local actualizado, dentro del alcance validado)

> **Estado:** **publicada, migrada y desplegada en API y web; entorno local actualizado, dentro del alcance validado.** El código es el commit `430c4cbb1099b8b3e73713cb404a2603b03c8db2`; la migración `20261115000000_accesos_por_rol` se aplicó, sin seed, en producción y en la base local de trabajo. No hubo validación funcional autenticada en producción (ver «Qué no se comprobó»). Diseño completo, catálogo y correspondencia con rutas en `docs/internas/14_Diseno_Accesos_Por_Rol.md`. *Antecedentes:* antes de la publicación, el estado decía «implementada y validada en local; sin publicar ni desplegar»; entre la publicación y el despliegue, «publicada en el repositorio y validada localmente; pendiente de migración, despliegue y actualización del entorno local», con producción sin la pantalla, sin las guardas y sin la migración.
>
> **Despliegue de la entrega** (accesos por rol y entrada del tiempo estimado), desde `430c4cbb1099b8b3e73713cb404a2603b03c8db2`. Las horas «del panel» son las que muestra Render (GMT-3) y corresponden a la noche del **14-11-2026**; las horas con `Z` son UTC y corresponden al **15-11-2026**, porque a esa hora ya se había cruzado la medianoche UTC.
>
> **Qué se validó y cómo** (cada capa por separado):
>
> - **Pruebas funcionales locales y CI.** Las de «Validación local», más abajo. La CI del código (`43630543032`, push a `main`, primer intento, SHA exacto) terminó en éxito con tipos, lint, pruebas y build del frontend, y tipos, lint, unitarias, migraciones sobre su base desechable e **integración** del backend.
> - **Revisión visual con API simulada.** Ver «Validación local». Verifica presentación e interacción, no el backend integrado.
> - **Estado observado en Render** y **disponibilidad HTTP**: ver abajo. Son lecturas del panel y comprobaciones sin credenciales.
>
> **Respaldo previo.** Se creó una exportación lógica nueva de la base en Render (página Recovery) y se esperó a que la tabla la mostrara completada con su archivo `.dir.tar.gz`: la fila apareció a las 21:35 del panel y quedó con su archivo a las 21:36 (00:35–00:36Z). **No se descargó** ni se obtuvieron sus enlaces, y **no se probó su restauración**. Render la conserva al menos 7 días.
>
> **Migración** (servicio `fchmn-mantenimiento`):
>
> - **Construcción.** Con `origin/main` revalidado justo antes, el control **Manual Build** construyó [`dep-dbsfufc9v7es73cjvdug`](https://dashboard.render.com/cron/crn-dbh500bl550s73c5n2o0/deploys/dep-dbsfufc9v7es73cjvdug), iniciado a las 21:39:25 del panel (00:39:25Z). El registro hizo checkout de `430c4cbb1099b8b3e73713cb404a2603b03c8db2` y el panel mostró Deploy succeeded (46 s) y la cabecera en `430c4cb`. Construir no lanzó ninguna ejecución. *Observación:* el botón inició la construcción con un solo clic, sin menú intermedio.
> - **Ejecuciones.** Antes de cada **Trigger Run** se comprobó que no hubiera una ejecución activa y que guardar el comando no hubiera iniciado otra; se lanzó una sola vez cada una y se leyó su registro:
>   1. `prisma migrate status`: 42 migraciones encontradas y, como **única** pendiente, `20261115000000_accesos_por_rol`; sin fallidas, divergencias ni errores de conexión. Terminó con código 1, el esperado con una pendiente.
>   2. `prisma migrate deploy`: aplicó **únicamente** `20261115000000_accesos_por_rol` y terminó con `All migrations have been successfully applied.`
>   3. `prisma migrate status`: `Database schema is up to date!`
>
>   **Sin seed.** El contador «RUN 30» de la pestaña Runs **no aumentó** con estas ejecuciones; por eso se identificaron por sus filas: aparecieron **tres filas nuevas** (9,8 s, 10 s y 9,4 s), en ese orden, y ninguna otra. No se determinó qué cuenta ese contador.
> - **Al terminar.** *Docker Command* vacío, comprobado tras recargar la página; programación conservada (`0 6 1 1 *`); Auto-Deploy en `Off`. La variable de la base se comprobó solo por su nombre en la API y en el mantenimiento, sin mostrar valores, apoyada en la confirmación manual anterior de su destino.
>
> **Producción** (Auto-Deploy Off en los tres servicios: leído antes del despliegue en API y web, y comprobado al cerrar en el mantenimiento; despliegue manual eligiendo el SHA completo, cada uno confirmado una sola vez; la API antes que la web, y la web solo después de comprobar la API):
>
> | Servicio | Versión | Despliegue | Inicio (panel / UTC) | Resultado |
> |---|---|---|---|---|
> | `fchmn-mantenimiento` | `5780336` → `430c4cb` | [`dep-dbsfufc9v7es73cjvdug`](https://dashboard.render.com/cron/crn-dbh500bl550s73c5n2o0/deploys/dep-dbsfufc9v7es73cjvdug) | 21:39:25 / 00:39:25Z | Deploy succeeded (construcción) |
> | `fchmn-api` | `e02ba94` → `430c4cb` | [`dep-dbsg2k56e07s739olmvg`](https://dashboard.render.com/pserv/srv-dbh4ih4ipgvc73dore80/deploys/dep-dbsg2k56e07s739olmvg) | 21:48:17 / 00:48:17Z | Deploy succeeded y Live (29 s según el panel) |
> | `fchmn-web` | `e02ba94` → `430c4cb` | [`dep-dbsg49uc6qcc73931610`](https://dashboard.render.com/web/srv-dbh48scs728c73arlf8g/deploys/dep-dbsg49uc6qcc73931610) | 21:51:51 / 00:51:51Z | Deploy succeeded y Live (32,8 s según el panel) |
>
> No se registró la hora exacta en que cada servicio pasó a Live: solo el inicio, la duración que muestra el panel y el estado final observado.
>
> **Disponibilidad** (sin credenciales; acredita disponibilidad, no funcionamiento con sesión):
>
> - Con la API ya Live y **antes** de desplegar la web: `/api/health` y `/api/ready` respondieron 200 (`/api/ready` con la base disponible), y `/api/auth/accesos` y `/api/accesos-por-rol` respondieron **401** sin credenciales, cuando antes del despliegue respondían 404. Eso muestra que las rutas existen, no que funcionen.
> - Después de la web: `/` respondió 200 y el paquete servido cambió de `index-B5bgaq62.js` a `index-BIIjQRsM.js`, que contiene los textos y rutas nuevos. Eso acredita la entrega del paquete, no una prueba funcional.
> - Muestreo único de `/api/health` por la web, de 00:46:49Z a 01:06:41Z (antes de la API hasta después de la web): **112 de 112 respuestas con 200**, con un máximo de 0,88 s. Los intervalos entre muestras no se observaron, así que no acredita disponibilidad continua.
>
> **Entorno local**, con el mismo código y la misma migración:
>
> - **Antes de intervenir producción** se construyeron las candidatas desde la copia de `430c4cb` (configuración local propia, sin cambiar valores ni TLS): backend `285cf187b915`, frontend `ff2796c5ff92` y migrate `40630fbd87c5` (con las 42 migraciones). Las imágenes anteriores se conservan como reserva (backend `7ae3e21a5a54`, frontend `7d1fe37ef07b`, migrate `d70849e66516`); mientras se intervenía producción, `latest` siguió apuntando a ellas.
> - Respaldo lógico local previo, generado como archivo dentro del contenedor y copiado como archivo, con la misma huella SHA-256 en origen y copia. Se guarda fuera del repositorio.
> - Migración con comando explícito y **sin seed**: `status` (solo pendiente `20261115000000_accesos_por_rol`) → `deploy` (aplicó solo esa) → `status` (al día). La configuración inicial quedó en **versión 0 y sin restricciones** (cero filas en `accesos_por_rol`), comprobado con una consulta de solo lectura.
> - **PostgreSQL y su volumen se conservaron**, sin recrear el contenedor. **Backend y frontend se reemplazaron** deliberadamente por las candidatas, y los contenedores usan esas imágenes. Los contenedores efímeros de migración e inspección se retiraron al terminar.
> - `/health`, `/ready` y la web respondieron 200, y las rutas nuevas 401 sin credenciales. Al terminar, los tres servicios quedaron **detenidos**, como al inicio.
> - **No se afirma identidad binaria con Render.** El paquete web local (`index-CGkpyWAZ.js`) tiene otro nombre que el de producción; la causa no se comprobó.
>
> **Qué no se comprobó y qué queda pendiente.**
> - No hubo validación funcional autenticada ni escrituras de prueba en producción: no se cambiaron accesos de usuarios reales ni se guardaron tiempos. La revisión visual con una cuenta real queda a cargo del responsable.
> - No se probó en Safari durante el despliegue (*antecedente*). Después, el usuario informó que revisó en Safari en Mac y que funciona bien: ver la revisión manual, más abajo.
> - Al cierre del despliegue, ningún respaldo de esta entrega tenía restauración probada (*antecedente*). Después, el respaldo local se restauró en el ensayo del 15-11-2026, descrito más abajo. La exportación de Render sigue sin restauración probada.
> - Team Manager no se modificó, y no se ejecutaron exportaciones reales.
> - Siguen las limitaciones de «Entrada del tiempo estimado» y de esta sección, más abajo.
>
> **Revisión manual posterior, informada por el usuario.** Después del despliegue, el usuario informó que revisó las funciones solicitadas y que quedaron correctamente implementadas. Se registra como su informe: no es una prueba automatizada, y no indicó cuenta, rol ni navegador. En ese informe no constaba Safari (*antecedente*). Más tarde, el usuario confirmó que revisó en Safari en Mac y que funciona bien; también es su revisión manual, sin versión, configuración ni cuentas indicadas.
>
> **Ensayo de recuperación posterior** (15-11-2026, local y aislado):
>
> - **Restauración.** El respaldo lógico local tomado en este despliegue, previo a `accesos_por_rol`, se restauró en un PostgreSQL desechable: 40 tablas y 41 migraciones.
> - **Migración.** Se aplicó solo `20261115000000_accesos_por_rol`, sin seed, y quedaron 42 tablas y 42 migraciones, al día.
> - **Arranque.** La API de `430c4cb`, con `NODE_ENV=production`, arrancó con el `AUTH_LIMITER_SECRET` original del entorno local y respondió 200 en `/health` y `/ready`.
> - **Primer intento.** Usó otro secreto y la API no arrancó. Fue la protección del limitador, no un fallo de la restauración.
> - **Qué exige recuperar.** Hay que conservar ese secreto, custodiado aparte del respaldo.
> - **Qué no valida.** Una restauración de Render, el PITR ni un respaldo posterior a la migración. Tampoco se probaron el inicio de sesión ni las funciones del negocio.
>
> Detalle y procedimiento en `Instructivo_Instalacion_Nube.md`: el Paso 9B y «El ensayo de recuperación — 15 de noviembre de 2026».
>
> **Reversión de código.** Desplegar `e02ba94` en la web y la API. La migración **no** se deshace y no se borran tablas, restricciones guardadas ni auditorías. Con el código anterior las restricciones configurables **dejan de aplicarse**, pero se conservan los permisos y controles originales; y la web anterior reintroduce el defecto de precarga del tiempo (no solo la entrada fija de 6 dígitos).

Pantalla exclusiva de administración (`/administracion/accesos`, menú «Accesos por rol») para **restringir y restituir** los menús y acciones que hoy tienen el **nadador**, el **delegado** y el **entrenador** (opción A, confirmada): la configuración **nunca concede** funciones nuevas.

- **Reglas.**
  - Una función se permite si **cualquiera** de los roles efectivos de la persona la permite.
  - **Administración** conserva siempre el acceso completo, aunque tenga otros roles.
  - La **cuenta de club** y el **representante legal** conservan sus atribuciones actuales, sin configuración.
  - Se evalúa sobre los roles **efectivos** de cada solicitud, que el servidor recarga de la base y ya vienen reducidos si el club no está operativo; nunca sobre la copia del JWT.
  - Las asignaciones de roles y las membresías no se modifican.
- **Catálogo fijo** (`backend/src/modules/accesos/catalogo.ts`), con identificadores estables, menú, pantallas, rutas, permisos y roles en que aplica. Comprende los menús Inscripciones, Inscripciones de Relevo, Reportes e Incorporaciones con sus acciones independientes (inscribir, editar el tiempo, cancelar y deshacer, historial; armar, editar, cancelar e historial de relevos; generar y exportar CSV, Excel o PDF; postular, completar el alta y listados), y el **cambio voluntario de contraseña**. Donde un rol no tiene hoy la función, la pantalla muestra **«No aplica»**.
- **Siempre disponibles:** cerrar sesión, el cambio **obligatorio** de contraseña, el inicio y la restauración y renovación de la sesión.
- **Servidor.**
  - Cada ruta del catálogo lleva una guarda de función **además** de su permiso, sus guardas de rol y su alcance, nunca en su lugar.
  - Las rutas compartidas se permiten si **alguna** de sus funciones lo está: `enabled-events` y `club-swimmers` sirven a Inscripciones y a Relevos; la cuota y el periodo vigente, a postular y a los listados.
  - `GET /registrations` y `GET /relay-registrations` son la lista operativa con `status=confirmed` y el historial en los demás casos.
  - Una función apagada responde **403 `FUNCION_DESHABILITADA`**.
  - Si la configuración no se puede leer, responde **503 `CONFIGURACION_ACCESOS_NO_DISPONIBLE`**: nunca concede.
  - Ninguno de los dos cierra la sesión.
- **Persistencia** (migración aditiva `20261115000000_accesos_por_rol`):
  - `configuracion_accesos` es una fila única de versión; la migración la crea con versión 0 y sin restricciones.
  - `accesos_por_rol` guarda solo las celdas apagadas. Sin filas, el comportamiento es exactamente el anterior.
  - Cada guardado envía el estado completo con la versión leída. Una versión desactualizada responde **409 `CONFIGURACION_CAMBIADA`** con el estado vigente, sin escribir ni reintentar.
  - La auditoría `ROLE_ACCESS_UPDATED` (actor, versiones y solo las celdas cambiadas) va en la misma transacción.
- **Sesiones abiertas.** El servidor aplica la configuración vigente desde la **siguiente solicitud**, también con tokens ya emitidos y por llamada directa. La interfaz pide sus funciones efectivas (`GET /auth/accesos`) al iniciar o restaurar la sesión, al renovarla y al recibir `FUNCION_DESHABILITADA`. Por eso un menú puede seguir a la vista hasta la siguiente renovación (programada cada 12 minutos; es el intervalo previsto, no un plazo garantizado), pero sus operaciones ya se deniegan. Lo cargado pertenece a la cuenta **con sus roles efectivos y su club**: si los roles cambian sin cambiar la cuenta, se descarta y se vuelve a pedir, y administración nunca hereda restricciones (tiene prioridad haya datos o no). Un editor abierto (tiempo de una inscripción, constructor de un equipo de relevo) cuya acción se apaga se cierra con un aviso: si aún no había enviado nada, dice que se cerró sin enviar cambios; si el guardado ya se había enviado, no afirma que no se guardó y su respuesta se informa como siempre, sin otra petición; «Cancelar edición» solo cierra el editor y no depende del permiso de cancelación.
- **Team Manager, excepción explícita.** La exportación a Team Manager **no es configurable**: conserva sus permisos actuales y sus rutas no llevan guarda de función. Ocultar el menú Reportes **no** revoca el acceso directo al exportador. CSV, XLSX y PDF quedan sujetos a la acción «Exportar» sin cambios en su contenido, formato ni descarga.

- **Validación local, con resultados reales** (datos sintéticos):
  - **Backend, unitarias** (catálogo, techo frente a `rbac.definitions.ts`, evaluación, validación, Team Manager sin guarda) y las de rutas afectadas: 4 archivos, 119 de 119. Prueba documental: 12 de 12.
  - **Integración** sobre la base desechable de `docker-compose.test.yml`, donde se aplicó la migración:
    - `accesos-por-rol.integration.test.ts`: 25 de 25. Cubre:
      - cada rol y sus combinaciones;
      - administración con otros roles;
      - cuenta de club y representante legal;
      - menú y acción apagados y su restitución;
      - todas las rutas del catálogo, compartidas y alternativas;
      - lista frente a historial;
      - sesión abierta antes del cambio;
      - club no operativo y alcance;
      - cambio voluntario apagado frente al obligatorio;
      - configuración inicial;
      - 409 y guardados simultáneos;
      - auditoría atómica y fallo de carga;
      - Team Manager.
    - Archivos de integración que ejercen las rutas modificadas o las migraciones: 40 archivos, 976 de 977. El único fallo fue la prueba de C-05 que fija la cantidad y la última migración: se actualizó a 42, y después C-05 y accesos dieron 68 de 68.
  - **Frontend** (jsdom, API simulada):
    - las pruebas existentes de las áreas tocadas, 39 archivos, 667 de 667;
    - nuevas: sesión y rutas 12 de 12, pantalla 9 de 9 y paneles 10 de 10.
  - Tipos sin errores. Lint sin errores nuevos.
  - **Revisión visual con capturas** en Chromium (navegador integrado visible), con el frontend real y una API simulada, a 1280 px y 375 px efectivos:
    - la matriz, «No aplica» y Team Manager como no configurable;
    - el menú apagado, con sus acciones atenuadas y sus casillas conservadas;
    - el resumen, el guardado y la última modificación;
    - el conflicto 409;
    - el delegado sin el menú, el aviso por URL directa y sin «Cambiar contraseña».

    La revisión encontró y corrigió dos defectos propios:
    - tras un 409, confirmar revertía los cambios de la otra persona: ahora el borrador se rehace sobre el estado vigente;
    - a 375 px la tabla no era utilizable con el menú lateral abierto: ahora se apila por función.
  - **Validación final conjunta de la entrega** (accesos por rol y correcciones de tiempos), ejecutada una vez sobre el mismo contenido, cada suite por separado y sin solaparse:
    - **Frontend, suite completa** (`npm test`): 76 archivos, 1267 de 1267 pruebas aprobadas, sin omitidas.
    - **Backend, integración completa** (`npm run test:integration`, configuración real) sobre el contenedor desechable de `docker-compose.test.yml`, con el guard de destino previo: 69 archivos, 1487 de 1487 pruebas aprobadas, sin omitidas. Las **42 migraciones** se aplicaron **solo en esa base desechable**; las bases auxiliares que crean las pruebas de migración se eliminaron y el contenedor volvió a quedar detenido.
    - **Advertencias:** 13 avisos `DEP0190` de Node (`shell: true` al lanzar `npx` en Windows), del código de pruebas existente; no afectan el resultado.
    - Una huella SHA-256 de los archivos de la entrega, tomada antes y comprobada después, confirmó que no cambiaron durante la validación.
  - **Correcciones posteriores a la primera validación**, cada una reproducida antes con pruebas que fallaban por el motivo esperado: el **contexto de autorización** (lo cargado pertenece a la cuenta con sus roles efectivos y su club; administración tiene prioridad), los **editores abiertos** cuya acción se apaga (incluido el aviso con un guardado ya en curso) y la entrada y precarga de **tiempos** (ver «Entrada del tiempo estimado»).
- **Limitaciones.**
  - No se probó con sesión real en un navegador contra la API real (la revisión visual usa una API simulada), ni hubo validación funcional autenticada en producción.
  - Esta validación no incluyó Safari (*antecedente*). Después, el usuario informó que revisó en Safari en Mac y que funciona bien: es su revisión manual, no una prueba automatizada.
  - Un menú puede seguir a la vista hasta la siguiente renovación de la sesión.
  - La migración usa el nombre `20261115000000_accesos_por_rol`, que ordena después de las anteriores.

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/auth/accesos` | Funciones del catálogo que la sesión tiene deshabilitadas, con la versión evaluada y la cuenta. Solo sirve para ocultar controles | Sesión válida (sin cambio obligatorio pendiente) |
| GET | `/accesos-por-rol` | Configuración vigente, versión, última modificación y catálogo para la pantalla | Rol `admin` |
| PUT | `/accesos-por-rol` | Guarda el estado completo con la versión leída; 409 si cambió | Rol `admin` |

### Clubes y nadadores, orden del plantel y edición de fechas (estado: publicada y desplegada en API y web; entorno local actualizado, dentro del alcance validado)

> **Estado:** **publicada y desplegada en API y web; entorno local actualizado, dentro del alcance validado.** El código desplegado es el commit `d516c7fb832f866e1887984ec78f5c0150c88dab`; la CI del código (`44103518434`) terminó en éxito. **No hubo cambios de esquema, migraciones, seed ni variables nuevas.** No hubo validación funcional autenticada de estas mejoras en producción (ver «Limitaciones»). *Antecedente:* entre la publicación y el despliegue, este estado decía «publicada en el repositorio y validada localmente; pendiente de despliegue y actualización del entorno local».

**Qué incluye**

- **Columna «Nadadores» en Clubes.** `GET /clubs` añade a cada club la cantidad de personas distintas con membresía **activa** en él, sin personas eliminadas, propuestas pendientes, historial ni personal del club. Es el total del plantel, no el de una página, y se obtiene con una sola consulta agrupada por página del listado. Conserva el alcance por club de quien no es administrador.
- **Orden del plantel en Editar Club.** Por omisión, apellido paterno, apellido materno y nombre, con el comparador de Reportes (`compararNadadores`): sin distinguir mayúsculas ni tildes; los registros históricos sin apellido paterno van al final por su nombre completo almacenado, sin inventar apellidos; desempatan el RUN y los identificadores. Se ordena en el servidor **antes de paginar** y excluye a las personas eliminadas, para que el total coincida con la columna «Nadadores»; sus membresías no se modifican. Las dos lecturas (orden y filas de la página) comparten una instantánea `REPEATABLE READ` de solo lectura; si aun así faltara una fila, la respuesta es un error, no una página corta.
- **Reporte general «Clubes y nadadores»** (pestaña de Reportes), **exclusivo de administración** en la pantalla y en sus dos rutas (`reports:read` y rol `admin`, más la comprobación de alcance en el servicio). No pide ni consulta ninguna competencia. Orden de las secciones, el mismo en pantalla, CSV, Excel y PDF:
  1. **clubes no eliminados**, por nombre, también los que no tienen nadadores, cada uno con sus nadadores actuales (membresía activa de una persona no eliminada) por apellido paterno, materno y nombre;
  2. **revisión de membresías activas en clubes eliminados**, cuando exista: esas personas tienen una membresía activa, así que no se reclasifican como «sin club»; no se recupera el club ni se finaliza ni repara nada;
  3. **«Sin club asignado», siempre al final:** todas las personas no eliminadas, con cuenta activa y sin membresía activa, con el mismo criterio que la asignación masiva. No exige el rol `swimmer` (es derivado) ni un historial previo, así que incluye a delegados, entrenadores o representantes legales sin membresía activa: el personal no figura en su club por ser personal, pero sí aquí si cumple el criterio.

  Solo se muestran nombres (`PATERNO MATERNO, NOMBRE`, o el nombre completo almacenado si el registro está incompleto): sin RUN, nacimiento ni correo. Los totales separan clubes, nadadores con club, sin club y revisión. Las tres consultas se leen en una transacción `REPEATABLE READ` de solo lectura, con una única instantánea; una lectura incoherente (una persona dos veces o en dos grupos) se rechaza. CSV y Excel tienen las mismas filas (con la columna «Sección») y conservan la neutralización de fórmulas; el PDF mide cada línea con su fuente y ancho reales, repite el encabezado del grupo con «(continuación)» al cambiar de página y no deja encabezados solos al pie. Los reportes por competencia no cambian.
- **Edición administrativa de DESDE y HASTA** desde Asignación de Nadadores a Clubes, Editar Club y Editar Persona, con un mismo diálogo y la misma validación (`PUT /swimmer-assignments/:id/fechas`). Solo administración: el botón se muestra solo con el rol `admin` y la ruta exige `swimmer-assignment:approve` y el rol `admin`, así que poder abrir la ficha no la concede. Reglas:
  - fechas de calendario sin hora; DESDE y HASTA iguales o anteriores a **hoy en America/Santiago**;
  - HASTA, cuando tenga valor, igual o posterior a DESDE (el mismo día es válido);
  - **sin superposiciones** con ninguna otra membresía activa o finalizada de la persona, con extremos inclusivos: una nueva pertenencia empieza después del último día de la anterior. Si una fecha desconocida impide descartarla, se exige una aceptación administrativa explícita y auditada; no se completa ninguna fecha por inferencia;
  - en una membresía **activa** solo se corrige DESDE; HASTA lo pone la baja existente. En una finalizada se corrigen ambas. Pendientes y rechazadas no se editan;
  - **sin cambios automáticos de estado:** corregir fechas no asigna ni da de baja, no retrocede `endDate` (el instante real de la baja), no cambia las marcas de solicitud, aprobación y creación ni toca inscripciones o competencias;
  - protocolo de C-05: bloqueo de la persona y de todas sus membresías, reevaluación con las filas bloqueadas, actualización y auditoría (`SWIMMER_ASSIGNMENT_DATES_CORRECTED`) en la misma transacción.

**Pruebas funcionales locales previas al despliegue** (rondas separadas; ninguna fue una ejecución completa de todas las suites). Todo con datos sintéticos; la integración, solo contra la base desechable de `docker-compose.test.yml`.

- **Ronda 1 — implementación.**
  - Backend, unitarias del área (12 archivos, 2 nuevos): 447/447. Integración: el archivo nuevo y 5 existentes del área, 222/222.
  - Frontend: 9 archivos existentes de las pantallas tocadas, 243/243, y 5 archivos nuevos, 19/19 (jsdom, API simulada en las pruebas).
  - Concurrencia de la edición de fechas: dos correcciones válidas por separado pero superpuestas juntas, con el bloqueo de la persona retenido desde otra conexión: se guarda una y la otra recibe 409. Contraprueba leyendo el historial antes del bloqueo: ambas se guardaban (la prueba la detecta).
  - Tipos y lint sin errores en ambas capas.
- **Ronda 2 — consistencia y PDF.**
  - Reglas del reporte y de fechas: 17/17. Archivo de integración: 22/22, con intercalados deterministas (una asignación confirmada durante la lectura del reporte; una baja entre las dos lecturas del plantel). Contraprueba con `READ COMMITTED`: la persona quedaba omitida y el plantel respondía 500; ambos fallos detectados. Frontend del reporte: 11/11.
  - PDF: se reprodujo primero el defecto (nombres y encabezados largos se partían y se superponían con la línea siguiente) y luego se corrigió con la paginación por altura real.
- **Ronda 3 — orden de las secciones.** Una prueba nueva con los tres tipos de grupo reprodujo el orden anterior (revisión después de «Sin club asignado»): 3 casos fallaban. Tras la corrección: reglas 14/14, pantalla 5/5 y, en integración, solo la prueba de CSV y Excel cuya expectativa cambió, 1/1. Tipos y lint sin errores.
**Revisión visual previa** (local, datos sintéticos):

- **Revisión visual de la pantalla** con la API real contra la base desechable y datos sintéticos (incluidos nombres largos), en escritorio (1280 px) y a 375 px: columna «Nadadores», plantel ordenado, diálogo de fechas (rechazo por superposición, guardado válido, fechas futuras y HASTA anterior a DESDE), reporte con la revisión diferenciada, «Sin club asignado» como última sección, totales separados, botones de exportación accesibles y sin desplazamiento horizontal.
- **Revisión visual del PDF** sintético con un visor que renderiza las páginas como imagen: antes de la corrección, superposiciones; después, sin recortes, con tildes y Ñ, encabezados de continuación y el orden definitivo de las secciones.

**CI.** La ejecución `44103518434` corresponde al SHA exacto `d516c7f` (push en `main`, primer intento) y terminó en éxito: backend (tipos, lint, unitarias, migraciones sobre la base desechable e integración), frontend (tipos, lint, pruebas y build de producción) y la comprobación de derivados (avisos y Dockerfile de mantenimiento).

**Despliegue y comprobaciones operativas** (17-11-2026; Render en GMT-3, horas con `Z` en UTC). Son comprobaciones de disponibilidad y cabeceras sin credenciales, distintas de las pruebas funcionales de arriba.

- **Antes de operar:** API, web y mantenimiento estaban en `430c4cb`, Live (API y web), sin operaciones en curso y con Auto-Deploy `Off` en los tres.
- **Respaldo previo:** se creó una exportación lógica nueva en la página Recovery (la fila apareció con hora de panel 12:25, 15:25Z; su archivo se observó disponible a las 15:27Z) y se descargó al destino privado establecido, sin sobrescribir copias anteriores. Se comprobó la integridad del gzip y se listaron sus entradas (46). **No se probó su restauración.**
- **Producción** (despliegue manual del commit exacto, Auto-Deploy `Off`; primero la API y, tras comprobarla, la web):

  | Servicio | Versión | Despliegue | Inicio (panel) | Duración mostrada | Observado |
  |---|---|---|---|---|---|
  | `fchmn-api` | `430c4cb` → `d516c7f` | `dep-dbu75l3l550s73a4tf2g` | 12:29:24 (15:29:24Z) | 45,1 s | Deploy succeeded y Live a las 15:30:43Z |
  | `fchmn-web` | `430c4cb` → `d516c7f` | `dep-dbu76nm7bikc738gdca0` | 12:31:42 (15:31:42Z) | 40,3 s | Deploy succeeded y Live a las 15:32:51Z |

  Las horas «observado» son las de la lectura del panel, no el instante en que cada servicio pasó a Live.
- **Mantenimiento:** sin operaciones (sin construcción ni ejecución). Sigue en `430c4cb`, con Docker Command vacío, la misma programación y Auto-Deploy `Off`; su historial seguía en 30 ejecuciones antes y después. Su imagen solo contiene esquema, migraciones y seeds, que no cambiaron.
- **Disponibilidad, muestras registradas.** 13 muestras sin credenciales cada ~30 s, de 15:28:36Z a 15:35:06Z, contra la web pública: en todas, `/login`, `/api/health` y `/api/ready` respondieron 200. La ruta nueva `/api/reports/clubes-y-nadadores` respondió 404 (API anterior) hasta la muestra de 15:29:42Z y 401 desde la de 15:30:15Z; el paquete de la web fue el anterior hasta la muestra de 15:32:23Z y el nuevo desde la de 15:32:55Z. Cada cambio ocurrió dentro de esa ventana entre muestras, sin instante exacto; fuera de las muestras no hay observaciones, y estas no acreditan disponibilidad en los intervalos entre ellas ni después de 15:35:06Z.
- **Comprobaciones puntuales:**
  - API (15:30:51Z): `/api/health` y `/api/ready` 200; `/api/reports/clubes-y-nadadores`, su exportación y `PUT /swimmer-assignments/:id/fechas` respondieron 401 sin credenciales, con `Cache-Control: no-store`.
  - Web (15:33:00Z): `/login` 200 con `Cache-Control: no-store`, CSP con `connect-src 'self'` y sin `localhost`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` y `Referrer-Policy: no-referrer`. El paquete nuevo respondió 200 con caché inmutable y contiene la ruta del reporte; el paquete anterior respondió 404; `/api/auth/me` sin credenciales, 401.
- **Entorno local, en el mismo procedimiento:**
  - Las imágenes candidatas se construyeron desde una **copia limpia** del SHA exacto (exportación del commit, verificada contra él), no desde el árbol del checkout principal: backend `5286b6fe5d0b` y frontend `84a51a22a14f`, con `VITE_API_URL=http://localhost:3000`. No hizo falta el certificado corporativo como secreto de construcción.
  - Las imágenes anteriores se conservan para reversión como `prev-20261117-430c4cb` (backend `285cf187b915`, frontend `ff2796c5ff92`); las candidatas pasaron a `latest`.
  - Se recrearon solo backend y frontend sin construir (`docker compose up -d --no-build backend frontend`). PostgreSQL arrancó con el mismo contenedor y el mismo volumen de datos; no se activó el perfil de mantenimiento ni se ejecutaron migraciones o seed.
  - Los tres servicios quedaron sanos; la API respondió 200 en `/health` y `/ready` y 401 en la ruta nueva; la web respondió 200 con un paquete que incluye la ruta. Al terminar, los tres servicios quedaron **detenidos**, como estaban.
- **Team Manager:** su corrección pendiente quedó excluida de esta entrega y preservada en el checkout principal, sin cambios. Durante este procedimiento no hubo exportaciones reales ni validación en Meet Manager.
- **Reversión del código:** en Render, volver a los despliegues anteriores de `430c4cb`, primero la web y luego la API; en local, volver a etiquetar `prev-20261117-430c4cb` como `latest` y recrear backend y frontend sin construir. Como no hubo cambios de esquema, no hace falta revertir la base. La reversión del código **no deshace** las operaciones que los usuarios hayan guardado entretanto (por ejemplo, fechas de pertenencia corregidas).

**Limitaciones**

- Si un único texto (un nombre o un encabezado) midiera más que una página útil del PDF, se colocaría solo en una página nueva sin encabezado de continuación y podría exceder el área útil. No se comprobó si ocurre con datos reales.
- No hubo validación funcional autenticada de estas mejoras en producción; queda pendiente la revisión del usuario. Las respuestas 401 solo acreditan el rechazo sin credenciales: no validan los permisos de usuarios autenticados, los cálculos ni las exportaciones.
- No se afirma identidad binaria entre las imágenes de Render y las locales. El paquete web local y el de producción tienen nombres distintos; la URL de API compilada es distinta y puede explicarlo, pero no se comprobó que sea la única causa.
- No se afirma la ausencia de escrituras en la base durante el despliegue: no se revisó la actividad de los usuarios.
- La tabla de Clubes ya desbordaba a 1280 px antes de esta entrega; la columna «Nadadores» la ensancha.
- Eliminar una persona no finaliza sus membresías: el listado general de asignaciones sin `orden` puede seguir mostrándola; el plantel ordenado, la columna «Nadadores» y el reporte la excluyen.
- El comparador de Reportes que se reutiliza pone a quien no tiene apellido materno después de quien sí lo tiene; el de los paneles de inscripción, antes. Es una diferencia anterior a esta entrega.

### Nombres por apellidos y RUN con guion en el plantel y en Personas (estado: publicada y desplegada en API y web; entorno local actualizado, dentro del alcance validado)

> **Estado:** **publicada y desplegada en API y web; entorno local actualizado, dentro del alcance validado.** El código desplegado es el commit `787490e9919b367f0af9c921b1f6c207142864d5`. **Sin cambios de esquema, migraciones, seed ni variables nuevas.** No hubo validación funcional autenticada en producción (ver «Limitaciones»). *Antecedentes:* entre la publicación y el despliegue, este estado decía «publicada en el repositorio y validada localmente; pendiente de despliegue y actualización del entorno local»; antes de publicarse, «implementada y validada localmente; pendiente de publicación y despliegue».

**Qué incluye**

- **Formato.** En el plantel de Editar Club cada nadador se muestra como `PATERNO MATERNO, NOMBRES (12345678-9)`; en Personas, la columna «Nombre completo» como `PATERNO MATERNO, NOMBRES` y la columna RUN como `12345678-9`. Nombres en mayúsculas, con tildes y Ñ; RUN sin puntos, con guion antes del dígito verificador y K en mayúscula. El RUN no se convierte a número (conserva ceros iniciales), no duplica un guion ya presente, no se corta en el guion en columnas estrechas y, si falta, no se inventa (sin paréntesis en el plantel, «—» en Personas).
- **Registros incompletos.** Se usan los campos separados (`paternalLastName`, `maternalLastName`, `firstName`); sin segundo apellido, `PATERNO, NOMBRES`. Si falta el apellido paterno o el nombre, se muestra el nombre completo almacenado en mayúsculas, sin coma y sin partirlo para inventar apellidos. Los espacios repetidos se reducen a uno. Es solo presentación: no se modifican los nombres ni los RUN guardados. Los paneles de inscripción y relevos y Reportes conservan su presentación (`nombreEnPanel` no cambia).
- **Orden de Personas en el servidor.** El listado empieza ordenado por apellido paterno, materno y nombres, ascendente; pulsar «Nombre completo» lo invierte. Ambos sentidos se resuelven en el servidor sobre el conjunto completo, antes de paginar (`GET /persons?orden=apellidos|apellidos_desc`, con el comparador de Reportes y desempate estable), y cambiar el sentido vuelve a la página 1. Sin `orden`, la ruta conserva el orden de siempre para los buscadores y selectores que la usan. Búsqueda, filtros, paginación y permisos no cambian. El plantel ya se ordenaba por apellidos antes de paginar; ahora además recibe los componentes del nombre.
- **Respuestas atrasadas en Personas.** Solo la carga vigente puede actualizar los datos, el error y el indicador de carga (el mismo patrón que Asignación de Nadadores); una respuesta de otro orden, página o filtro, o posterior al desmontaje, se descarta. Las recargas tras las acciones sobre personas se conservan.

**Pruebas y revisión** (rondas separadas; no son una única ejecución de suites completas). Datos sintéticos; la integración, solo contra la base desechable de `docker-compose.test.yml`.

- **Ronda 1 — formato y orden.**
  - Frontend: los 16 archivos de prueba que usan estos módulos, incluidos 3 nuevos, 262/262 (jsdom, API simulada).
  - Backend unitarias (documentación, esquemas, listas y orden determinista): 298/298.
  - Integración: el archivo nuevo de orden por apellidos, 7/7 (orden ascendente y descendente entre páginas, homónimos, tildes y Ñ, exclusión de eliminadas, búsqueda y filtros, comportamiento sin `orden`, rechazo de un orden desconocido, acceso denegado a la cuenta de club y datos guardados intactos).
  - Tipos y lint sin errores.
- **Ronda 2 — cargas atrasadas y revisión visual.**
  - Una prueba nueva con promesas controladas reprodujo primero, con el código anterior, **cuatro casos** que fallaban: un orden ascendente atrasado que reemplazaba al descendente, el error de una petición atrasada mostrado sobre el resultado vigente, el indicador de carga apagado por una petición atrasada y una respuesta sin filtro que reemplazaba a la filtrada. Tras la corrección, 5/5. El quinto caso (desmontaje) ya pasaba antes: comprueba que no aparecen avisos, no demuestra por sí solo que se impidan las actualizaciones.
  - Archivos afectados de Personas, plantel y helpers: 89/89; tras mantener el RUN sin cortes, los 5 archivos del plantel y de Personas, 53/53. Tipos y lint sin errores.
  - Revisión visual con la API real contra la base desechable y datos sintéticos (el archivo de integración de esta entrega volvió a ejecutarse, 7/7, solo para preparar esos datos), en escritorio (1280 px) y a 375 px: formato del plantel y de Personas, segundo apellido ausente, compuestos, tildes y Ñ, registros incompletos al final, orden inicial y cambio ascendente/descendente entre páginas con vuelta a la página 1, y RUN sin cortes.

**CI.** La ejecución `44132620280` corresponde al SHA exacto `787490e` (push en `main`). Frontend (tipos, lint, pruebas y build de producción) y Derivados (avisos y Dockerfile de mantenimiento) se aprobaron en el intento 1 y sus resultados se conservaron. Backend falló en el intento 1 por un tiempo agotado (más de 5.000 ms) en una prueba de `backend/tests/resumen-por-club.rules.test.ts` que esta entrega no modifica; con autorización se repitieron solo los trabajos fallidos y Backend se aprobó en el intento 2. La causa del tiempo agotado inicial sigue sin confirmarse.

**Despliegue y comprobaciones operativas** (17-11-2026; Render en GMT-3, horas con `Z` en UTC). Son comprobaciones de disponibilidad y cabeceras sin credenciales, distintas de las pruebas funcionales de arriba.

- **Antes de operar:** API y web estaban en `d516c7f`, Live, sin operaciones en curso y con Auto-Deploy `Off`; el mantenimiento, en `430c4cb`.
- **Respaldo previo:** se creó una exportación lógica nueva en la página Recovery. Un primer intento no llegó a registrarla (la tabla seguía igual tras recargar); el segundo creó una sola exportación nueva, cuya fila apareció a las 17:53Z (hora de panel 14:53) y cuyo archivo se observó disponible a las 17:56Z. Se descargó al destino privado establecido, sin sobrescribir copias anteriores; se comprobó la integridad del gzip y se listaron sus entradas (46). **No se probó su restauración.**
- **Producción** (despliegue manual del commit exacto, Auto-Deploy `Off`; primero la API y, tras comprobarla, la web):

  | Servicio | Versión | Despliegue | Inicio (panel) | Duración mostrada | Observado |
  |---|---|---|---|---|---|
  | `fchmn-api` | `d516c7f` → `787490e` | `dep-dbu9c1ek1f9s739ris7g` | 14:59:33 (17:59:33Z) | 32,1 s | Deploy succeeded y Live a las 18:00:24Z |
  | `fchmn-web` | `d516c7f` → `787490e` | `dep-dbu9cph5efls739lvpt0` | 15:01:10 (18:01:10Z) | 1 min 18 s | Deploy succeeded y Live a las 18:02:36Z |

  Las horas «observado» son las de la lectura del panel registradas en la sesión, no el instante en que cada servicio pasó a Live.
- **Mantenimiento:** sin operaciones (sin construcción ni ejecución, sin cambios de comando, programación ni Auto-Deploy). Sigue en `430c4cb`, con 30 ejecuciones antes y después.
- **Disponibilidad, muestras registradas.** 22 muestras sin credenciales cada ~32 s, de 17:58:26Z a 18:09:55Z, contra la web pública: en todas, `/login`, `/api/health` y `/api/ready` respondieron 200 y `/api/persons?orden=apellidos` respondió 401. Esa ruta responde 401 sin credenciales con la API anterior y con la nueva, así que las muestras no distinguen la versión de la API. El paquete de la web fue el anterior hasta la muestra de 18:02:20Z y el nuevo desde la de 18:02:52Z; el cambio ocurrió en esa ventana, sin instante exacto. Después de la lectura de la web Live (18:02:36Z) hubo 14 muestras, de 18:02:52Z a 18:09:55Z, unos 7 min 19 s entre esa lectura y la última muestra. Fuera de las muestras no hay observaciones: no acreditan disponibilidad en los intervalos entre ellas ni después de 18:09:55Z.
- **Comprobaciones puntuales:**
  - API (18:00:31Z): `/api/health` y `/api/ready` 200, con una instancia recién iniciada; `/api/auth/me` y `/api/persons?orden=apellidos` y `?orden=apellidos_desc` respondieron 401 sin credenciales; `Cache-Control: no-store`.
  - Web (18:02:44Z): `/login` 200 con `Cache-Control: no-store`, CSP con `connect-src 'self'` y `frame-ancestors 'none'`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` y `Referrer-Policy: no-referrer`. `/login` referencia un paquete nuevo, que respondió 200 como JavaScript y contiene el orden `apellidos_desc`; el paquete anterior respondió 404 (se registró, no era condición).
- **Entorno local, en el mismo procedimiento:**
  - Las imágenes candidatas se construyeron desde una **copia limpia** del SHA exacto (exportación del commit, verificada contra él), no desde el árbol del checkout principal: backend `3524c9ba58d6` y frontend `63538cc69fdc`, con `VITE_API_URL=http://localhost:3000`. No hizo falta el certificado corporativo como secreto de construcción.
  - Las imágenes anteriores se conservan para reversión como `prev-20261117-d516c7f` (backend `5286b6fe5d0b`, frontend `84a51a22a14f`); las candidatas pasaron a `latest`.
  - Se recrearon solo backend y frontend sin construir (`docker compose up -d --no-build backend frontend`), y usan exactamente las imágenes candidatas. PostgreSQL arrancó con el mismo contenedor y el mismo volumen de datos; no se activó el perfil de mantenimiento ni se ejecutaron migraciones o seed.
  - Los tres servicios quedaron sanos; la API respondió 200 en `/health` y `/ready` y 401 en `/persons?orden=apellidos`; la web respondió 200 con un paquete que contiene `apellidos_desc`. Al terminar, los tres servicios quedaron **detenidos**, como estaban.
- **Team Manager:** su corrección pendiente quedó excluida de esta entrega y preservada en el checkout principal, sin cambios. Durante este procedimiento no hubo exportaciones reales ni validación en Meet Manager.
- **Reversión del código:** en Render, volver a los despliegues anteriores de `d516c7f`, primero la web y luego la API; en local, volver a etiquetar `prev-20261117-d516c7f` como `latest` y recrear backend y frontend sin construir. Como no hubo cambios de esquema, no hace falta revertir la base. La reversión del código **no deshace** las operaciones que los usuarios hayan guardado entretanto.

**Limitaciones**

- Las demás columnas de Personas y la cabecera «Nadador» del plantel ordenan solo la página visible; no es un ordenamiento global.
- No se midió el rendimiento con datos reales (cada página lee las claves de orden de todas las filas que cumplen el filtro).
- A 375 px se observaron desbordes horizontales: en Personas, la tabla (unos 1.016 px) y el botón «+ Nueva persona» parcialmente fuera de la pantalla; en el plantel, unos 40 px. La adaptación móvil no está resuelta. Quitar el `nowrap` del RUN reducía el plantel solo 3 px, pero esa medición no demuestra por sí sola que todo el desborde fuera previo.
- Quien no tiene apellido materno queda después de quien sí lo tiene con el mismo paterno (criterio previo de `compararNadadores`); quien tiene apellido pero no nombre de pila se muestra con su nombre completo almacenado.
- No hubo validación funcional autenticada en producción durante el despliegue. *Antecedente:* aquí constaba que quedaba pendiente la revisión del usuario. Después, el usuario confirmó que revisó manualmente en producción estos cambios de Personas y del plantel de Editar Club y que funcionan correctamente. Es su revisión manual, no una prueba automatizada. Las respuestas 401 solo acreditan el rechazo sin credenciales: no comprueban los nombres, el orden, los permisos de usuarios autenticados ni las exportaciones.
- No se afirma identidad binaria entre las imágenes de Render y las locales. El paquete web local y el de producción tienen nombres distintos; la URL de API compilada es distinta y puede explicarlo, pero no se comprobó que sea la única causa.
- No se afirma la ausencia de escrituras en la base durante el despliegue: no se revisó la actividad de los usuarios.

### Nombres por apellidos y RUN con guion en Asignación de Nadadores a Clubes (estado: publicada y desplegada en API y web; entorno local actualizado, dentro del alcance validado)

> **Estado:** **publicada y desplegada en API y web; entorno local actualizado, dentro del alcance validado.** El código desplegado es el commit `0b1cf37471333108740500affac96bd1fd89c693`. **Sin cambios de esquema, migraciones, seed ni variables nuevas.** No hubo validación funcional autenticada en producción (ver «Limitaciones»). *Antecedente:* entre la publicación y el despliegue, este estado decía «publicada en el repositorio y validada localmente; pendiente de despliegue y actualización del entorno local».
>
> *Antecedente:* el usuario informó que revisó manualmente en producción los cambios de la entrega anterior en Personas y en el plantel de Editar Club, y que funcionan correctamente. Esa confirmación corresponde solo a aquella entrega; no se extiende a esta.

**Qué incluye**

- **Formato.** En el listado de Asignación de Nadadores a Clubes cada nadador se muestra como `PATERNO MATERNO, NOMBRES (12345678-9)`, con el mismo componente que el plantel de Editar Club: nombres en mayúsculas, con tildes y Ñ; RUN sin puntos, con guion antes del dígito verificador y K en mayúscula, sin convertirlo a número (conserva ceros iniciales) y sin cortarse en el guion. Sin segundo apellido, `PATERNO, NOMBRES`; los registros antiguos incompletos muestran el nombre completo almacenado, sin coma ni apellidos inventados, y sin RUN no se agrega el paréntesis. Es solo presentación: no se modifican los datos guardados.
- **Orden global antes de paginar.** El listado empieza ordenado por apellido paterno, materno y nombres, ascendente, con el comparador de Reportes y desempate estable (RUN, persona y membresía). Pulsar «Nadador» invierte el orden completo y vuelve a la página 1; cambiar el filtro de estado conserva el orden. Ambos sentidos se resuelven en el servidor sobre el conjunto filtrado completo (`GET /swimmer-assignments?orden=nadador|nadador_desc`).
- **`nadador` frente a `apellidos`.** `orden=apellidos` sigue siendo el del plantel vigente de Editar Club y excluye a las personas eliminadas. `nadador` y `nadador_desc` no excluyen a nadie: el listado administrativo conserva **el mismo conjunto de membresías que antes** (sin `orden`), incluidas las de personas eliminadas, que se siguen revisando ahí. No se reparan, finalizan ni eliminan registros. Sin `orden`, la ruta conserva el orden de siempre (más recientes primero) para sus demás consumidores.
- **Diálogos y mensajes** de la misma pantalla: Aprobar, Rechazar, Finalizar membresía y Corregir fechas muestran al nadador con el mismo formato, y también los mensajes de confirmación. Los diálogos de baja y de fechas, compartidos con Editar Club y Editar Persona, solo cambian cuando la pantalla de Asignación les pasa el nombre; en esas otras pantallas siguen como estaban.
- **Asignación masiva.** La lista de selección se entrega completa (sin paginar) ordenada por apellidos; la columna «Nadador» muestra `PATERNO MATERNO, NOMBRES` y la columna RUN, el RUN con guion. Pulsar «Nadador» invierte la lista completa; «RUN» ordena por RUN. La tabla de resultado de cada tanda usa el mismo formato con el RUN, también después de recargarse la lista. Filtro por club, búsqueda, selección, fecha efectiva, reintento con aceptación y permisos no cambian.

**Pruebas y revisión** (rondas separadas; no son una única ejecución de suites completas). Datos sintéticos; la integración, solo contra la base desechable de `docker-compose.test.yml`.

- **Ronda 1 — implementación.**
  - Frontend: en los 12 archivos de prueba existentes del módulo de asignaciones fallaron primero 4 casos que buscaban el nombre en su forma anterior (ahora en mayúsculas); se ajustaron esas 3 expectativas y quedaron 167/167. Archivos nuevos de presentación y orden de la pantalla y de la asignación masiva: 11/11 (orden pedido al servidor, inversión con vuelta a la página 1, filtro, orden local de «Club», diálogos, búsqueda y resultado de la tanda). Otro consumidor del diálogo de fechas (Editar Persona) y los helpers de nombre y RUN: 18/18.
  - Backend unitarias relacionadas (esquemas, listas, rutas, orden determinista y documentación): 308/308.
  - Integración: el archivo nuevo, 11/11 (31 membresías, más que una página: orden ascendente y descendente entre páginas, mismo conjunto que sin `orden` en cada estado, desempate de dos membresías de una misma persona, tildes y Ñ, homónimos, registros históricos al final, componentes del nombre, `apellidos` sin eliminadas, alcance de la cuenta de club, orden desconocido rechazado, lista de la asignación masiva por apellidos con filtro y búsqueda, acceso exclusivo de administración y datos guardados intactos). Regresión del plantel de Editar Club y de Personas: 29/29.
  - Tipos sin errores en ambas capas; lint sin errores ni advertencias nuevas en los archivos tocados.
- **Ronda 2 — revisión visual y corrección.**
  - Revisión con la API real del repositorio contra la base desechable y datos sintéticos (el archivo de integración de esta entrega volvió a ejecutarse, 11/11, solo para preparar esos datos), en escritorio (1280 px) y a 375 px: formato del listado, orden inicial e inversión global con vuelta a la página 1, diálogos de aprobar, rechazar, baja y corrección de fechas (abiertos y cancelados sin guardar), lista de la asignación masiva con filtro por club e inversión, y ausencia de desplazamiento horizontal de la página a 375 px (la tabla del listado se desplaza dentro de su contenedor, como antes).
  - Para ver la tabla de resultado se hicieron **dos asignaciones masivas, solo en la base desechable**, de dos personas sintéticas cada una a un club sintético. La primera mostró un defecto a 375 px: en esa tabla el RUN se cortaba en el guion. Se corrigió con el mismo componente que el listado, se amplió la prueba del resultado y la segunda asignación lo confirmó.
  - Tras la corrección, una ejecución de las pruebas del área con los servidores de la revisión abiertos terminó en 194/196: dos pruebas existentes, no modificadas («navega a la SEGUNDA página y muestra sus filas» del plantel y «muestra origen, destino y fechas, y exige confirmar EXPRESAMENTE la vigente» de Asignación), superaron el límite de 5 s. Esos dos archivos, solos, pasaron 53/53, y el área completa, con los servidores ya detenidos, 196/196. La relación con los servidores abiertos es una hipótesis, no una causa demostrada. Tipos sin errores.

**CI.** La ejecución `44158781151` corresponde al SHA exacto `0b1cf37` (push en `main`) y se aprobó en el intento 1: Frontend (tipos, lint, pruebas y build de producción), Derivados (avisos y Dockerfile de mantenimiento) y Backend (tipos, lint y pruebas).

**Despliegue y comprobaciones operativas** (17-11-2026; Render en GMT-3, horas con `Z` en UTC). Son comprobaciones de disponibilidad y cabeceras sin credenciales, distintas de las pruebas funcionales de arriba.

- **Antes de operar:** API y web estaban en `787490e`, Live y sin operaciones en curso; el mantenimiento, en `430c4cb`.
- **Respaldo previo:** se creó una exportación lógica nueva en la página Recovery; el clic quedó registrado una sola vez, sin exportaciones duplicadas, y su fila muestra la hora de panel 17:01 (20:01Z). Se descargó al destino privado establecido, sin sobrescribir copias anteriores; se comprobó la integridad del gzip y se listaron sus entradas (46, con la misma estructura que el respaldo anterior). **No se probó su restauración.**
- **Producción** (despliegue manual del commit exacto; primero la API y, tras comprobarla, la web):

  | Servicio | Versión | Despliegue | Inicio (panel) | Duración mostrada | Observado |
  |---|---|---|---|---|---|
  | `fchmn-api` | `787490e` → `0b1cf37` | `dep-dbub868jo6nc739ifn9g` | 17:07:53 (20:07:53Z) | 36,5 s | Live con `0b1cf37` a las 20:08:37Z |
  | `fchmn-web` | `787490e` → `0b1cf37` | `dep-dbub964ipgvc738d9nk0` | 17:10:00 (20:10:00Z) | 36 s | Live con `0b1cf37` a las 20:11:04Z |

  Las horas «observado» son las de la lectura del panel registradas en la sesión, no el instante en que cada servicio pasó a Live.
- **Mantenimiento:** sin operaciones (sin construcción ni ejecución, sin cambios de comando, programación ni Auto-Deploy, que sigue `Off`). Sigue en `430c4cb`, con 30 ejecuciones. No se ejecutaron migraciones ni seed, ni se cambiaron variables.
- **Comprobaciones puntuales:**
  - API (20:08:41Z): `/api/health` y `/api/ready` 200, con una instancia recién iniciada; `/api/auth/me` y `/api/swimmer-assignments?orden=nadador` y `?orden=nadador_desc` respondieron 401 sin credenciales; `Cache-Control: no-store`.
  - Web (20:11:12Z): `/login` 200 con `Cache-Control: no-store`, CSP con `connect-src 'self'` y `frame-ancestors 'none'`, `Strict-Transport-Security: max-age=31536000; includeSubDomains`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` y `Referrer-Policy: no-referrer`. `/login` referencia un paquete nuevo, que respondió 200 como JavaScript con caché inmutable, contiene el orden `nadador_desc` y no contiene `localhost`; el paquete anterior respondió 404 (se registró, no era condición).
- **Entorno local, en el mismo procedimiento:**
  - Las imágenes candidatas se construyeron desde una **copia limpia** del SHA exacto (exportación del commit, verificada contra él), no desde el árbol del checkout principal: backend `ec3e8e3d04ad` y frontend `f6b4312e4b12`, con `VITE_API_URL=http://localhost:3000`. No hizo falta el certificado corporativo como secreto de construcción.
  - Las imágenes anteriores se conservan para reversión como `prev-20261117-787490e` (backend `3524c9ba58d6`, frontend `63538cc69fdc`); las candidatas pasaron a `latest`.
  - Se recrearon solo backend y frontend sin construir (`docker compose up -d --no-build backend frontend`), y usan exactamente las imágenes candidatas. PostgreSQL arrancó con el mismo contenedor y el mismo volumen de datos; no se activó el perfil de mantenimiento ni se ejecutaron migraciones o seed.
  - Los tres servicios quedaron sanos; la API respondió 200 en `/health` y `/ready` y 401 en `/swimmer-assignments?orden=nadador`; la web respondió 200 con un paquete que contiene `nadador_desc`. Al terminar, los tres servicios quedaron **detenidos**, como estaban.
- **Team Manager:** su corrección pendiente quedó excluida de esta entrega y preservada en el checkout principal, sin cambios. Durante este procedimiento no hubo exportaciones reales ni validación en Meet Manager.
- **Reversión del código:** en Render, volver a los despliegues anteriores de `787490e`, primero la web y luego la API; en local, volver a etiquetar `prev-20261117-787490e` como `latest` y recrear backend y frontend sin construir. Como no hubo cambios de esquema, no hace falta revertir la base. La reversión del código **no deshace** las operaciones que los usuarios hayan guardado entretanto.

**Disponibilidad: muestreo original durante el despliegue.** 20 rondas sin credenciales cada ~32 s, de 20:07:17Z a 20:17:48Z, contra la web pública; cada ronda pidió `/login`, `/api/health`, `/api/ready` y `/api/swimmer-assignments?orden=nadador`.

- **19 rondas completamente satisfactorias:** `/login`, `/api/health` y `/api/ready` respondieron 200 y la ruta protegida, 401. Esa ruta responde 401 sin credenciales con la API anterior y con la nueva, así que las rondas no distinguen la versión de la API.
- **Una petición sin respuesta HTTP:** en la ronda iniciada a las 20:12:07Z, `/api/ready` registró `000`, que no es un estado HTTP del servidor: el cliente no recibió respuesta. En esa misma ronda, `/login` y `/api/health` respondieron 200 y la ruta protegida, 401. **No es un tiempo agotado confirmado:** el registro de esa ronda no guardó la duración de cada petición, el código de salida ni el mensaje de error del cliente. Indirectamente, esa ronda tardó 47 s hasta la siguiente, frente a 32–35 s en los demás intervalos; esos ~15 s adicionales son compatibles con el límite de espera de 15 s por petición, pero no lo demuestran.
- **Registros consultados (solo lectura, ventana de 20:12:00Z a 20:12:56Z):** en el registro de acceso de la web (la instancia nueva y la anterior, que seguía activa) y en el de la API (la instancia nueva) **no se encontró una petición correspondiente**. Las demás peticiones de esa ronda aparecen, con tiempos de milisegundos; tampoco hay errores del proxy (499, 502 o 504), advertencias, errores, reinicios ni eventos de despliegue posteriores a Live. La cobertura es limitada: el panel muestra un número acotado de líneas por consulta, el canal de errores de Nginx usa UDP y puede perder mensajes, y no hay registros del borde de Render delante de la web. Por eso **no se afirma que la petición no llegara a la API**.
- **Causa sin determinar.** La instancia anterior de la web terminó un cierre ordenado unos 29 s después (20:12:36Z); esa coincidencia no demuestra causalidad. No se atribuye el fallo al proxy, al cliente ni a la red.
- El paquete de la web fue el anterior hasta la ronda de 20:10:30Z y el nuevo desde la de 20:11:02Z; el cambio ocurrió en esa ventana, sin instante exacto. Después de la lectura de la API Live (20:08:37Z) hubo 17 rondas; después de la lectura de la web Live (20:11:04Z), 12, de 20:11:35Z a 20:17:48Z, unos 6 min 44 s entre esa lectura y la última ronda.

**Disponibilidad: seguimiento adicional posterior** (una ejecución aparte, no se suma al muestreo original). 10 rondas sin credenciales cada ~30 s, de 20 peticiones en total a `/api/health` y `/api/ready` por el mismo acceso público, con espera máxima de 15 s por petición, entre 21:38:33Z y 21:43:04Z (unos cuatro minutos y medio): las 20 respondieron 200 con salida 0 del cliente. Este seguimiento **no elimina ni explica** el fallo original, no declara resuelto ningún incidente y, como el muestreo original, no acredita disponibilidad en los intervalos entre peticiones ni fuera de las ventanas observadas.

**Limitaciones**

- Las columnas «Club» y «Estado» del listado principal ordenan solo la página visible; no es un ordenamiento global.
- No se midió el rendimiento con datos reales (cada página lee las claves de orden de todas las membresías que cumplen el filtro).
- Solicitudes de alta, Periodos de cambio y la pantalla de incorporaciones del club quedaron expresamente fuera de esta entrega, sin cambios.
- Se mantiene el criterio de `compararNadadores`: quien no tiene apellido materno queda después de quien sí lo tiene con el mismo paterno.
- No hubo validación funcional autenticada en producción; queda pendiente la revisión del usuario de esta entrega de Asignación. Las respuestas 401 solo acreditan el rechazo sin credenciales: no comprueban los nombres, el orden, los diálogos, la asignación masiva ni los permisos de usuarios autenticados.
- Una petición a `/api/ready` del muestreo original quedó sin respuesta HTTP y su causa sigue sin determinar (ver «Disponibilidad»).
- No se afirma identidad binaria entre las imágenes de Render y las locales. El paquete web local y el de producción tienen nombres distintos; la URL de API compilada es distinta y puede explicarlo, pero no se comprobó que sea la única causa.
- No se afirma la ausencia de escrituras en la base durante el despliegue: no se revisó la actividad de los usuarios.

## Inventario completo de endpoints

**138 endpoints**, agrupados por el módulo que los declara. Esta lista no está
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

### `accesos`

| Método | Ruta |
|---|---|
| GET | `/accesos-por-rol` |
| PUT | `/accesos-por-rol` |
| GET | `/auth/accesos` |

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
| PUT | `/competitions/:id/predeterminada` |
| DELETE | `/competitions/:id/predeterminada` |
| POST | `/competitions/:id/reopenRegistrations` |
| POST | `/competitions/:id/schedule` |
| POST | `/competitions/:id/start` |
| POST | `/competitions/:id/uncancel` |

### `dashboard`

| Método | Ruta |
|---|---|
| GET | `/dashboard/stats` |

### `incorporaciones`

| Método | Ruta |
|---|---|
| GET | `/swimmer-assignments/cuota` |
| GET | `/swimmer-assignments/periodos-cambio/vigente` |
| GET | `/swimmer-assignments/periodos-cambio` |
| POST | `/swimmer-assignments/periodos-cambio` |
| POST | `/swimmer-assignments/periodos-cambio/:id/cerrar` |
| POST | `/swimmer-assignments/altas` |
| GET | `/swimmer-assignments/altas` |
| GET | `/swimmer-assignments/altas/:id` |
| POST | `/swimmer-assignments/altas/:id/aprobar` |
| POST | `/swimmer-assignments/altas/:id/rechazar` |

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
| GET | `/reports/registrations/clubs` |
| GET | `/reports/clubs-summary` |
| GET | `/reports/clubes-y-nadadores` |
| GET | `/reports/clubes-y-nadadores/export` |

### `swimmer-assignment`

| Método | Ruta |
|---|---|
| GET | `/swimmer-assignments` |
| POST | `/swimmer-assignments` |
| GET | `/swimmer-assignments/:id` |
| POST | `/swimmer-assignments/:id/approve` |
| POST | `/swimmer-assignments/:id/end` |
| PUT | `/swimmer-assignments/:id/fechas` |
| POST | `/swimmer-assignments/:id/reject` |
| POST | `/swimmer-assignments/bulk-assign` |
| GET | `/swimmer-assignments/current-club/:personId` |
| POST | `/swimmer-assignments/direct` |
| POST | `/swimmer-assignments/reassign/:personId` |
| GET | `/swimmer-assignments/swimmers-by-club` |

### `team-manager-export`

| Método | Ruta |
|---|---|
| GET | `/export/team-manager/zip` |
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
- **La importación del ZIP en HY-Tek no se ha comprobado**: los archivos reproducen
  byte a byte un paquete real, pero el programa no se ha ejecutado contra lo generado
  por este sistema.
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
