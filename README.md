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
- **Limitador del login** (C-02, política B; **publicada en el repositorio, con validación local descrita; pendiente de despliegue**;
  en producción sigue el bloqueo de cuenta RB-15 hasta su despliegue). Sustituye al bloqueo temporal de la cuenta entera tras 5 intentos fallidos,
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
  administrativos se conservan. Detalle en `docs/seguridad/PLAN_SEGURIDAD.md` («C-02»).
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
  y más estricto en `/auth/*` (20 req/min, `RATE_LIMIT_AUTH_MAX`). Con C-02 (pendiente de despliegue),
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
  `IP_CLIENTE_FUENTE=cf-connecting-ip`; el mantenimiento sigue en `2c3552e`, sin construir ni
  ejecutar. `TRUST_PROXY_HOPS=2` permanece configurada en la API, pero el código nuevo la ignora
  (no se ha retirado). La identificación de IP tiene una **validación acotada en producción**
  (un equipo y una red), no una garantía general. Evidencia, frontera de confianza y límites en
  `docs/seguridad/PLAN_SEGURIDAD.md` («IP del cliente»); C-02 está publicada en el repositorio, con validación local descrita; pendiente de despliegue.

## Endpoints del Módulo 2 — Personas

| Método | Ruta | Descripción | Permiso |
|---|---|---|---|
| GET | `/persons` | Lista personas (búsqueda por RUN/nombre, filtro por rol/estado, paginado) | `persons:read` |
| GET | `/persons/:id` | Detalle de una persona (incluye roles y credenciales) | `persons:read` |
| POST | `/persons` | Crea una persona (valida RUN chileno). El nombre de usuario es **opcional** y no se genera ni se crea cuenta. **No acepta `roles`**: son derivados, y enviarlos se rechaza con 400 | `persons:write` |
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
| GET | `/clubs` | Lista clubes (búsqueda por nombre/razón social/RUT, filtro por estado y por **personalidad jurídica** —`si` / `no`—, paginado) | `clubs:read` |
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
- **Intentos de cambio de contraseña por sesión** (C-04; **cerrada dentro de su alcance: migrada y desplegada en producción**, validada en local y en la CI, **sin prueba autenticada del límite en producción**): `/auth/change-password` cuenta las contraseñas actuales incorrectas de **cada sesión**, durante toda su vida (el refresh no la reinicia). En la quinta termina **solo esa sesión** —la cuenta, las demás sesiones y los logins futuros no cambian— y la interfaz vuelve al login con el motivo; los cuatro primeros fallos no expulsan. Rige igual para el cambio obligatorio y el voluntario. El `sid` sale de la sesión que verificó el servidor, nunca de la solicitud; una reserva por sesión, con token y caducidad, decide qué resultado produce efectos, y Argon2 sigue fuera de las transacciones. No cuentan los errores de la contraseña nueva, los de ejecución ni los resultados que llegan tarde. Esquema: tres columnas nuevas en `refresh_sessions` (migración aditiva). **C-02** (bloqueo de cuentas por terceros en el login) está **publicada en el repositorio, con validación local descrita; pendiente de despliegue**. Su corrección de errores técnicos de C-04 (una excepción de Argon2 o su saturación ya no cuentan como fallo ni terminan la sesión: 503) también queda pendiente de despliegue; el cierre de C-04 descrito arriba no cambia. Detalle y límites en `docs/seguridad/PLAN_SEGURIDAD.md` («C-04»).
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
| GET | `/swimmer-assignments` | Lista solicitudes (filtro por club/nadador/estado, paginado) | `swimmer-assignment:read` |
| GET | `/swimmer-assignments/:id` | Detalle de una solicitud | `swimmer-assignment:read` |
| POST | `/swimmer-assignments` | El club o su personal —delegado, entrenador o representante legal— propone incorporar un nadador (queda `pending`) | `swimmer-assignment:write` |
| POST | `/swimmer-assignments/:id/approve` | Aprueba y activa la asignación. Cuerpo opcional: `fechaEfectiva` (`AAAA-MM-DD`) | `swimmer-assignment:approve` (solo `admin`) |
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
- **La fecha efectiva de la membresía es un dato del negocio, no una marca de auditoría.**
  `club_swimmers.start_date` es una columna **`DATE`** —una fecha de calendario,
  sin hora y sin zona— y responde «desde cuándo pertenece al club». La marca de
  auditoría es `reviewed_at`, que sigue siendo un instante y responde «cuándo se
  registró».

  Los cuatro endpoints que activan una membresía aceptan `fechaEfectiva` en
  formato `AAAA-MM-DD`: `/direct`, `/bulk-assign`, `/:id/approve` y
  `/reassign/:personId`. Si no viene, se usa **el día de hoy en Chile**, no el del
  reloj del servidor. En `bulk-assign` la fecha se resuelve **una vez** y se
  aplica a toda la tanda.

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
  > **Pendiente:** la pantalla de asignación masiva todavía no tiene el campo de
  > fecha, así que desde la interfaz se usa el día de hoy. La API sí la acepta.
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
| GET/POST | `/competitions[/:id]` | Listar/crear competencias. El listado admite el filtro explícito `visibleInRegistrationPanels=true\|false` (ver «Visibilidad en los selectores de Inscripción, Relevos y Reportes») | `competitions:read` / `competitions:write` |
| PUT | `/competitions/:id` | Editar (fechas de inscripción solo en `draft`/`scheduled`); también `visibleInRegistrationPanels` y `requireIndividualForRelay`. La respuesta y `GET /competitions/:id` traen `relayTeamsNotMeetingCondition` (ver «Condición de inscripción individual para relevos») | `competitions:write` |
| POST | `/competitions/:id/duplicate` | Duplica estructura completa como base de una nueva (hereda la visibilidad en los paneles) | `competitions:write` |
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

### Sigla del club

La **sigla** (`clubs.code`) es el **identificador único del club**. La garantía es de la base: el índice único parcial `clubs_code_unique_active`, sobre `club_code_normalizado(code)` y `WHERE deleted_at IS NULL` (migración `20261103020000_sigla_club_unica`).

- **Alcance:** clubes no eliminados lógicamente, **incluidos los inactivos**: un club inactivo conserva su sigla. Un club eliminado la libera.
- **Normalización:** sin blancos a los lados y en mayúsculas, la misma en la aplicación (`shared/clubCode.ts`) y en la función SQL.
- **Al crear y editar:** se responde con un mensaje que nombra al club que la usa. Frente a dos operaciones simultáneas la garantía final es el índice, y la perdedora recibe un 409 con el mensaje de la sigla.
- **Datos anteriores:** si hay duplicados, la migración se **detiene** con el detalle (comprobación `club-sigla-duplicada` del preflight) y no modifica ningún club: decidir qué club conserva la sigla es del negocio.

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

Filtros soportados (sección 16): `competitionId` (obligatorio), `clubId`, `competitionDateId`, `sessionTypeId`, `competitionEventId`, `categoryId`, `gender`.

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
> **La importación real en HY-Tek sigue pendiente de comprobarse.**

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
  SDIF, sin contraste contra Hy-Tek: una prueba o relevo **sin marca** (`NT`), el
  relevo **combinado** (estilo `7`), el relevo **mixto** (sexo `X`), un código de club
  de 5 caracteres, y un nadador **que solo nada relevos**, que no lleva `D0` y aparece
  únicamente en sus `F0`. Son los primeros sitios donde mirar si un caso real falla.
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
  el marcador de estado `C` que sí lleva `E1` (esa posición queda en blanco). Con
  marca lleva una `X` en la columna 83; sin marca, no.
- **`F3`** (los 4 integrantes del equipo, en orden): mismo `swimmerId` que su
  registro `D1` — un nadador que compite en un relevo pero en ninguna prueba
  individual igual recibe su línea `D1` (sin `E1` después), tal como en la muestra
  real: primero se listan todos los nadadores que SOLO están en relevos, y recién
  después los que tienen pruebas individuales (con su `D1` seguido de sus `E1`).

El endpoint incluye ambos tipos de inscripción en un mismo paquete por club.

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

**118 endpoints**, agrupados por el módulo que los declara. Esta lista no está
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
| POST | `/competitions/:id/uncancel` |

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
