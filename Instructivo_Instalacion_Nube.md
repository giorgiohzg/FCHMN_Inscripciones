# Instalación en la nube (para que quede disponible en internet, sin dejar tu computador prendido)

**Para quién es esta guía:** para alguien que **no sabe programar**, que ya tiene
Visual Studio Code, y que quiere que la aplicación quede funcionando en internet
de forma permanente — accesible desde cualquier computador, sin depender de que
tu computador esté prendido.

**Tiempo estimado:** 60-90 minutos la primera vez.

> **Última revisión de esta guía contra el repositorio:** 27 de octubre de 2026.
> Se revisó el código, las dependencias, los `Dockerfile`, `docker-compose.yml`,
> las variables de entorno, los seeds y las migraciones; se contrastó con la
> documentación oficial de Railway vigente a esa fecha; y el procedimiento de
> migraciones, seeds y arranque se **ensayó de principio a fin** con las imágenes
> reales contra una base de datos desechable. Lo que no se pudo probar está
> declarado en la última sección.

> **Sobre el proveedor.** El repositorio **no impone** ningún proveedor de nube:
> no hay archivos de configuración de Railway, Render, Fly, Cloud Run ni AWS. Lo
> único que el código da por supuesto es que el proveedor **inyecta la variable
> `PORT`** y que la aplicación debe escuchar ahí (así está escrito en
> `frontend/nginx/default.conf.template`, que menciona Railway, Heroku y Cloud
> Run como ejemplos). Esta guía elige **Railway** por ser la opción más simple
> para quien no programa, pero es una **decisión de la guía**, no un requisito
> del proyecto.

**Sobre el costo (verificado en la documentación de precios de Railway):**

| Plan | Suscripción | Uso incluido | RAM máx. | Volumen máx. |
|---|---|---|---|---|
| Trial (cuenta nueva) | — | **US$5 una sola vez**, no renovable | 1 GB | **0,5 GB** |
| Free | US$0/mes | US$1 de crédito **al mes** | 0,5 GB | 0,5 GB |
| Hobby | **US$5/mes** | US$5 de uso incluido al mes | 48 GB | 5 GB |

Las **construcciones no se cobran** (ni CPU, ni memoria, ni almacenamiento de
imágenes). Se cobra el uso de RAM, CPU, egreso de red y almacenamiento del
volumen de la base de datos.

> **Dos advertencias que la versión anterior de esta guía no daba:**
>
> 1. **Railway exige una tarjeta de pago** (modalidad *post-paid*) desde el 30 de
>    marzo. No está documentado que el Trial se pueda crear sin ninguna tarjeta,
>    así que **no cuentes con eso**.
> 2. **Si se agota el crédito, no es solo una pausa.** La documentación dice que
>    la suscripción se cancela y Railway **detiene todas las cargas de trabajo**;
>    los datos del volumen se **eliminan 30 días después** del vencimiento en
>    Trial/Free (60 días tras cancelar Hobby). Es decir: *los datos sí se pierden*
>    si se deja pasar el plazo. Haz copias de seguridad (Paso 9) y no dependas del
>    crédito de prueba para datos reales.

---

## Sección 0 — Qué se cambió en el repositorio para que esto funcione

**No necesitas hacer nada de esta sección.** Está aquí para que sepas qué pasó y
para que, si algo falla, entiendas dónde mirar. Si solo quieres desplegar, salta
al Paso 1.

Una versión anterior de esta guía no se podía ejecutar de principio a fin: el
despliegue **fallaba durante la construcción**. Las imágenes del proyecto estaban
hechas para construirse con `docker compose`, que les daba dos cosas que ninguna
plataforma que construya desde un repositorio Git ofrece. Las dos están
resueltas, y el entorno local con Docker Compose sigue funcionando igual.

### Problema 1 — Las imágenes pedían un "contexto adicional"

Los avisos de licencias de terceros viven en `notices/`, en la raíz del
repositorio, pero los contextos de construcción son `backend/` y `frontend/`, y
una instrucción `COPY` no puede salir de su contexto. Eso se resolvía con un
**contexto de construcción con nombre** (`COPY --from=avisos …`), que
`docker-compose.yml` proveía con `additional_contexts`.

Lo que dice la documentación oficial de Railway, y lo que no:

| | |
|---|---|
| **Confirmado en la documentación** | Su página de Dockerfiles cubre la detección del archivo, `RAILWAY_DOCKERFILE_PATH`, las variables por `ARG` y los montajes de caché. **No menciona contextos de construcción adicionales en ninguna parte**, ni en esa página ni en la referencia de configuración. |
| **Solo en hilos de comunidad** | Casos de usuarios con el mismo fallo, a quienes se les responde cambiando el directorio raíz o el `RAILWAY_DOCKERFILE_PATH`. Son indicios, no una afirmación de Railway. |

**Cómo quedó:** el subconjunto de avisos que viaja dentro de las imágenes se
copia ahora a `backend/avisos/` y `frontend/avisos/`, que **sí** están en
contexto, y los `Dockerfile` los toman de ahí. `notices/` sigue siendo la única
fuente de verdad: `scripts/distribuir-avisos.mjs` mantiene las copias byte a
byte y, con `--verificar`, falla si divergen. Esa verificación corre ahora en la
integración continua, así que una copia desactualizada no puede pasar inadvertida.

Tampoco servía apuntar el directorio raíz del servicio a la raíz del
repositorio: los `Dockerfile` hacen `COPY package.json package-lock.json ./`
esperando estar dentro de `backend/` o `frontend/`, y en la raíz **no hay ningún
`package.json`**.

### Problema 2 — Se construía la etapa equivocada del backend

`backend/Dockerfile` produce dos imágenes distintas desde el mismo archivo: la
que **sirve** la API (`runtime`) y la que trae las herramientas de **migración y
seeds** (`migrate`). Compose elige cuál quiere con `target:`. Pero la última
etapa escrita en el archivo era `migrate`, y construir un `Dockerfile` sin elegir
etapa produce **la última**.

| | |
|---|---|
| **Confirmado en la documentación** | Railway usa el `Dockerfile` que encuentre en el directorio raíz del servicio, y **"siempre construirá con un Dockerfile si encuentra uno"**. Ninguna página ni la referencia de configuración ofrece una opción de etapa. |
| **Solo en hilos de comunidad** | Una petición abierta para admitir `--target`, con una respuesta de soporte diciendo que no había planes de añadirlo, y informes de que Railway construye siempre la última etapa. Coherente con la documentación, pero no está escrito allí. |

**Cómo quedó:** sin depender de ningún comportamiento no documentado. Dos cosas
que Railway **sí** documenta se combinan:

- construir un `Dockerfile` sin elegir etapa produce **la última**, y
- `RAILWAY_DOCKERFILE_PATH` permite señalar **otro archivo**.

Así que ahora hay dos archivos, y cada uno termina en la etapa que corresponde:

| Archivo | Termina en | Qué sale |
|---|---|---|
| `backend/Dockerfile` | `runtime` | la **API** — es lo que Railway usa por omisión |
| `backend/Dockerfile.mantenimiento` | `migrate` | las **herramientas de migración** — se pide con `RAILWAY_DOCKERFILE_PATH` |

El segundo **no se escribió a mano**: lo deriva
`scripts/generar-dockerfile-mantenimiento.mjs` del primero, añadiéndole una sola
etapa al final. Si fueran dos archivos independientes, bastaría subir el digest
de la imagen base en uno y no en el otro para que las dos imágenes dejaran de
ser las que describen sus avisos de licencias. La derivación lo hace imposible, y
la integración continua comprueba que no haya divergido.

> Se verificó que la imagen que sale del archivo derivado es **idéntica capa por
> capa y configuración por configuración** a la que sale de
> `docker build --target migrate` sobre el archivo fuente: la etapa añadida es un
> alias y no agrega ni quita nada.

`docker compose` no usa el archivo derivado: sigue eligiendo con `target:`, que es
más directo y no se vio afectado por nada de esto.

### Problema 3 — Dónde corren las migraciones y los seeds

La imagen de la API **a propósito no trae** el CLI de Prisma ni `tsx`: se
excluyen con `npm ci --omit=dev --omit=optional` para que no viajen 46 MiB de
herramientas en un servicio que solo sirve. Por eso **estos comandos no
funcionan en el servicio de la API**, y no se usan en esta guía:

```
npx prisma migrate deploy      ← intentaría descargar Prisma del registro npm
npm run prisma:seed            ← necesita tsx, que no está en la imagen
npm run seed:admin             ← necesita tsx, que no está en la imagen
```

**Cómo quedó:** hay un **tercer servicio** en Railway, construido desde la misma
carpeta pero con `RAILWAY_DOCKERFILE_PATH=Dockerfile.mantenimiento`, que sí trae
`prisma` en el `PATH` y los dos seeds compilados a JavaScript. Es el Paso 6.b de
esta guía. Sus tres comandos, los únicos que existen, son:

```
prisma migrate deploy --schema=/app/prisma/schema.prisma
node dist-seed/prisma/seed.js
node dist-seed/prisma/seed-admin.js
```

**Nada de esto ocurre solo.** El arranque de la API no migra ni siembra; el
servicio de migraciones no crea usuarios al migrar; y el seed del entorno de
revisión visual —el que carga datos de prueba— **no existe dentro de ninguna
imagen**: `tsconfig.seed.json` compila únicamente `seed.ts` y `seed-admin.ts`, y
`backend/.dockerignore` excluye `prisma/seed-revision.ts` del contexto.

---

## Antes de empezar: ¿qué vamos a hacer?

A diferencia de la instalación local (que corre en tu computador), aquí vamos a:

1. Instalar **Git** (una herramienta para subir el código a internet).
2. Crear una cuenta en **GitHub** (donde va a "vivir" el código).
3. Subir el proyecto a GitHub usando el propio VS Code (con botones, sin escribir comandos raros).
4. Crear una cuenta en **Railway** (la plataforma que va a ejecutar la aplicación).
5. Crear el proyecto y la base de datos PostgreSQL.
6. Configurar el servicio del **backend** (la API).
   6.b. Crear el servicio de **mantenimiento** y correr migraciones y datos iniciales.
7. Configurar el servicio del **frontend** (la web).
8. Comprobar que funciona.
9. Activar **copias de seguridad** de la base de datos.
10. Saber cómo **volver atrás** si un despliegue sale mal.

**Arquitectura que resulta** (es la que el repositorio confirma, no una
suposición): **cuatro servicios** — PostgreSQL, la API, la web y el de
mantenimiento—, con dominio público solo para la API y la web. El de
mantenimiento no atiende nada: existe para migrar y sembrar, y está apagado el
resto del tiempo. **Una sola instancia de la API**: el límite de tasa
se cuenta *en la memoria del proceso* (`RATE_LIMIT_GLOBAL_MAX`,
`RATE_LIMIT_AUTH_MAX`), así que con dos o más réplicas el límite deja de valer lo
que dice. No subas el número de réplicas.

**Persistencia de archivos: no hace falta ninguna.** Se revisó el código del
backend y **no escribe archivos a disco** en ningún punto: las importaciones
(`.hyv`, Excel) se procesan en memoria con un límite de 15 MB por archivo, y los
PDF y Excel que genera se envían en la respuesta. El **único** dato que hay que
conservar es la base de datos. Por eso no se configura ningún volumen para la API
ni para la web.

---

## Paso 1 — Instalar Git

1. Ve a **https://git-scm.com/downloads**
2. Descarga la versión para tu sistema operativo.
3. Instala igual que cualquier programa: **Next / Siguiente** en todas las pantallas, dejando las opciones por defecto, hasta el final.

**Verificar que quedó instalado:**

1. Abre VS Code.
2. Abre una terminal (**Terminal → New Terminal**).
3. Escribe:
   ```
   git --version
   ```
4. Debería aparecer algo como `git version 2.4x.x`. Si no, cierra y vuelve a abrir VS Code y prueba de nuevo.

---

## Paso 2 — Crear una cuenta en GitHub

1. Ve a **https://github.com** y haz clic en **Sign up**.
2. Sigue los pasos (correo, contraseña, nombre de usuario). Es gratis.
3. Confirma tu correo cuando te llegue el email de verificación.

---

## Paso 3 — Subir el proyecto a GitHub desde VS Code

1. Abre VS Code y abre la **carpeta principal del proyecto** (**File → Open Folder**): la que contiene directamente `backend`, `frontend` y `docker-compose.yml`. Si seguiste la guía local, es la carpeta que renombraste a `natacion`.
2. En la barra vertical de íconos de la izquierda, busca el ícono que parece una rama de árbol con puntos (**Source Control** / **Control de código fuente**). Haz clic ahí.
3. Vas a ver un botón que dice **"Publish to GitHub" / "Publicar en GitHub"**. Haz clic.
4. VS Code te va a pedir permiso para conectarse a tu cuenta de GitHub — acepta y sigue el proceso de inicio de sesión que se abre en el navegador.
5. Te va a preguntar el nombre del repositorio y si quiere ser **público o privado**. Elige **Private / Privado** (así nadie más puede ver el código sin tu permiso).
6. Espera a que termine de subir (verás una barra de progreso abajo). Cuando termine, tu código ya está en GitHub.

> **Importante — la estructura del repositorio.** Dentro del repositorio,
> `backend` y `frontend` quedan **en la raíz**, no dentro de ninguna carpeta
> `app`. Esto importa en los pasos 6 y 7: el *directorio raíz* de cada servicio
> en Railway es **`backend`** y **`frontend`**, sin prefijo.

**Antes de continuar — comprueba que ningún secreto se subió.** El proyecto lo
previene solo (`.gitignore` ignora `.env` y `.env.*`, con la excepción explícita
de `.env.example` y `.env.test.example`), pero conviene confirmarlo. Abre tu
repositorio en github.com y comprueba que **no aparece**:

- un archivo `.env` en la **raíz** del repositorio (el que tiene `POSTGRES_PASSWORD`),
- un archivo `.env` dentro de **`backend`** (el que tiene `JWT_ACCESS_SECRET` y las credenciales del administrador).

Sí es normal y correcto ver `.env.example`, `backend/.env.example` y
`backend/.env.test.example`: son plantillas sin secretos.

---

## Paso 4 — Crear una cuenta en Railway

1. Ve a **https://railway.com**
2. Haz clic en **Login** o **Start a New Project**.
3. Elige **"Login with GitHub"** — así conectas Railway con la cuenta de GitHub que creaste antes. Acepta los permisos que te pida.
4. Ten presente lo del recuadro de costos de arriba: Railway pide una tarjeta de pago y el crédito del Trial es **uno solo de US$5**, no mensual.

---

## Paso 5 — Crear el proyecto y la base de datos

1. Dentro de Railway, haz clic en **"New Project"**.
2. Elige **"Deploy from GitHub repo"** y selecciona el repositorio que subiste en el Paso 3.
3. Railway va a intentar detectar el proyecto automáticamente. **Es esperable que falle o quede con errores**: en la raíz del repositorio no hay nada que construir (ni `package.json` ni `Dockerfile`). Este primer servicio lo vamos a reconfigurar en el Paso 6 como **backend**.
4. Dentro del mismo proyecto, haz clic en **"+ New"** (o **"Create"**) y elige **"Database" → "Add PostgreSQL"**.

**Qué queda creado:** un servicio PostgreSQL de **un solo nodo**, desde la
imagen con SSL que mantiene Railway. Expone las variables `PGHOST`, `PGPORT`,
`PGUSER`, `PGPASSWORD`, `PGDATABASE` y **`DATABASE_URL`**, accesibles desde los
demás servicios del mismo proyecto por la red privada.

> **No habilites el acceso público de la base de datos.** Railway la deja privada
> por omisión; abrirla crea un *TCP Proxy*, llena `DATABASE_PUBLIC_URL` y además
> se factura el egreso de red. Nuestra API habla con ella por la red interna del
> proyecto.

> **Ojo con el plan y el tamaño.** En Trial y Free el volumen está limitado a
> **0,5 GB**. Es suficiente para empezar, pero es un techo real: si la base crece,
> hay que pasar a Hobby (5 GB).

---

## Paso 6 — Configurar el servicio del backend (la API)

1. Haz clic sobre el servicio que Railway creó desde tu repositorio (el que va a ser el backend). Conviene renombrarlo a algo claro, por ejemplo `backend`.
2. Ve a la pestaña **"Settings"**.
3. En la sección **Source**, busca **"Root Directory"** y escribe exactamente:
   ```
   backend
   ```
   > **Era `app/backend` en la versión anterior de esta guía, y estaba mal.** En
   > el repositorio no existe ninguna carpeta `app`: `backend` y `frontend` están
   > en la raíz. Con la ruta anterior, Railway no encuentra nada que construir.

4. **No configures nada más para construir. Deja "Build Command" y "Start Command" vacíos.**

   Railway encuentra `backend/Dockerfile` y lo usa automáticamente — avisa en los
   registros con `Using detected Dockerfile!`. De ese archivo sale, por omisión,
   la imagen que **sirve** la API, y esa imagen ya sabe arrancar sola
   (`node dist/server.js`). Si escribes comandos en esos dos campos, los de
   construcción **se ignoran** (son de Railpack, el otro constructor) y el de
   arranque **reemplazaría** el de la imagen, que es justo lo que no quieres.

   > **Cómo confirmar que salió la imagen correcta.** En la pestaña
   > **"Deployments"**, abre el despliegue y mira los registros: debe aparecer
   > `Using detected Dockerfile!`, la última etapa construida debe ser `runtime`,
   > y al arrancar el servicio debe quedar escuchando. Si en cambio ves que el
   > servicio ejecuta `prisma migrate deploy` y termina, revisa que este servicio
   > **no** tenga la variable `RAILWAY_DOCKERFILE_PATH` (esa va solo en el
   > servicio del Paso 6.b).

   > **Los comandos de la versión anterior de esta guía ya no sirven, y conviene
   > saber por qué.** Decían:
   >
   > ```
   > Build Command: npm install && npx prisma generate && npm run build
   > Start Command: npx prisma migrate deploy && npm run start
   > ```
   >
   > Dos problemas. Primero, esos campos son de **Railpack**, el constructor por
   > omisión; en presencia de un `Dockerfile` —que ahora existe— Railway usa el
   > `Dockerfile` y los ignora. Segundo, migrar **en el arranque** es exactamente
   > lo que `docker-compose.yml` dejó de hacer a propósito: si la migración falla,
   > el servicio entra en un ciclo de reinicios, y cada reinicio reintenta migrar.
   > Migrar es un **paso previo de operación**, no un requisito de arranque.

5. Ve a la pestaña **"Variables"** y agrega las de la tabla, una por una con **"+ New Variable"**. Están verificadas contra `backend/src/shared/env.schema.ts`, que es lo que la aplicación valida **al arrancar**: si algo falta o está mal, el servicio **no levanta** y lo dice en los registros.

   **Obligatorias — sin estas no arranca:**

   | Nombre | Valor |
   |---|---|
   | `DATABASE_URL` | **Por referencia, no escrita a mano.** Usa el botón de referencia (ícono de enchufe/variable) y elige la base Postgres, o escribe `${{Postgres.DATABASE_URL}}` sustituyendo `Postgres` por el nombre real del servicio de base de datos. |
   | `JWT_ACCESS_SECRET` | Un valor propio de **al menos 32 caracteres** (ver el recuadro de abajo). Se rechaza en producción si empieza con `reemplazar`, `replace`, `cambiar`, `change`, `example`, `ejemplo`, `secret` o `test`. |
   | `NODE_ENV` | `production` |
   | `CORS_ORIGINS` | La dirección pública del **frontend**, exacta y **sin barra final**, p. ej. `https://inscripciones.up.railway.app`. Se completa en el Paso 7.6, cuando ya exista. |

   **Necesarias para este despliegue (frontend y API en dominios distintos):**

   | Nombre | Valor |
   |---|---|
   | `AUTH_COOKIE_SAMESITE` | `none` (ver el recuadro "Por qué `none`") |
   | `TRUST_PROXY_HOPS` | `1` (ver el recuadro "El proxy de Railway") |

   **Deja estas SIN DEFINIR — ponerlas causa problemas:**

   | Nombre | Por qué |
   |---|---|
   | `AUTH_COOKIE_SECURE` | En producción se activa sola. Ponerla en `false` **detiene el arranque a propósito**: la cookie de sesión viajaría sin cifrar. |
   | `PORT` | Railway **la inyecta** y la usa también para el *healthcheck*. La API la obedece (`app.listen({ port: env.PORT })`). Fijarla a mano puede dejar el servicio escuchando donde el enrutador no busca. |
   | `HOST` | Por omisión es `0.0.0.0`, que es lo que Railway necesita. **No la pongas en `127.0.0.1`**: el servicio quedaría inalcanzable, sin ningún error que lo explique. |
   | `PUBLIC_API_URL` | Solo hace falta si publicas la documentación interactiva (ver abajo). |
   | `ENABLE_SWAGGER` | Sin definir, la documentación en `/docs` queda **apagada en producción**, que es lo correcto. Si la pones en `true`, `PUBLIC_API_URL` pasa a ser **obligatoria** o el arranque falla. |

   **Opcionales — tienen valor por omisión y solo se tocan si hace falta:**
   `JWT_ACCESS_EXPIRES_IN` (`15m`), `JWT_REFRESH_EXPIRES_IN_DAYS` (`7`),
   `LOGIN_MAX_ATTEMPTS` (`5`), `LOGIN_LOCKOUT_MINUTES` (`15`),
   `RATE_LIMIT_GLOBAL_MAX` (`300`), `RATE_LIMIT_AUTH_MAX` (`20`).

   **No pongas `SEED_ADMIN_USERNAME` ni `SEED_ADMIN_PASSWORD` aquí.** El servidor
   no las lee: las lee el comando que crea el administrador, y ese comando vive en
   el servicio del **Paso 6.b**. Puestas aquí no harían nada, y serían un secreto
   guardado donde no hace falta.

   **Para generar `JWT_ACCESS_SECRET`:** en VS Code, abre una terminal y ejecuta este comando una vez (igual que en la guía local):
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   > ### El proxy de Railway: por qué `TRUST_PROXY_HOPS=1`
   >
   > Esta variable **faltaba por completo** en la versión anterior de esta guía, y
   > su valor por omisión es `0`.
   >
   > Todo el tráfico público de Railway entra por su red de borde, así que entre
   > internet y la API hay **exactamente un proxy**. Con `0`, Fastify **ignora**
   > la cabecera `X-Forwarded-For`: el registro de auditoría y el límite de tasa
   > por IP verían la dirección del proxy en lugar de la del usuario — una sola IP
   > para todo el mundo, que es tanto una auditoría inútil como un límite de tasa
   > compartido por todos.
   >
   > **No pongas un número mayor que la cantidad real de proxies.** Cada salto de
   > más es una IP que el cliente puede inventar para falsear la auditoría y
   > escaparse del límite. Si algún día pones Cloudflare por delante de Railway,
   > serán dos.

   > ### Por qué `AUTH_COOKIE_SAMESITE=none` en Railway
   >
   > La sesión del usuario viaja en una cookie que el navegador guarda para el
   > dominio del **backend**. En Railway el frontend y el backend reciben
   > **dominios distintos** (`…-frontend.up.railway.app` y
   > `…-backend.up.railway.app`), así que para el navegador son **sitios
   > distintos** y, con el valor por omisión `lax`, sencillamente **no enviaría
   > la cookie**: nadie podría mantener la sesión abierta.
   >
   > `none` le dice al navegador que sí la envíe. A cambio exige dos cosas, que
   > el sistema comprueba al arrancar y rechaza si faltan:
   >
   > 1. **`AUTH_COOKIE_SECURE` activo** (automático en producción). Sin él, los
   >    navegadores descartan la cookie **sin avisar**: la sesión se cerraría
   >    sola en cada recarga y no habría ningún error que lo explicara.
   > 2. **`CORS_ORIGINS` con la dirección exacta del frontend.** Sin la lista, la
   >    API aceptaría peticiones con la sesión del usuario desde *cualquier*
   >    sitio web.
   >
   > **Si más adelante pones ambos servicios bajo un mismo dominio** (por
   > ejemplo `app.fchmn.cl` y `app.fchmn.cl/api`), cambia esta variable a `lax`:
   > es más seguro y no requiere nada más.
   >
   > ### La protección CSRF: no hay que configurar nada
   >
   > La comprobación **está activa siempre**, con cualquier valor de
   > `AUTH_COOKIE_SAMESITE`. Funciona sola, pero conviene saber cómo por si algún
   > día aparece el mensaje *"Comprobación de seguridad fallida"*:
   >
   > 1. Al iniciar sesión —y en `GET /auth/csrf` tras recargar la página— la API
   >    devuelve un **código de un solo uso en el cuerpo de la respuesta**.
   > 2. La aplicación web lo guarda **en memoria** y lo reenvía en la cabecera
   >    `X-CSRF-Token` de cada operación de sesión.
   > 3. La API comprueba que ese código coincida con el que guardó en una cookie
   >    propia.
   >
   > Un sitio malicioso puede provocar la petición, pero **no puede leer el
   > cuerpo de ninguna respuesta de la API** —`CORS_ORIGINS` se lo impide—, así
   > que nunca conoce el código. Por eso el código viaja por la respuesta y no
   > por una cookie legible: entre dominios distintos, el JavaScript del
   > frontend **no puede leer** las cookies del backend.
   >
   > **Si ves ese mensaje**, casi siempre es que `CORS_ORIGINS` no coincide
   > exactamente con la dirección del frontend (sobra una barra final, o dice
   > `http` en vez de `https`). La aplicación lo reintenta una vez por su cuenta
   > antes de mostrarlo, así que si aparece es que el problema persiste.

6. **Dominio público y HTTPS.** En **"Settings" → "Networking" → "Public Networking"**, haz clic en **"Generate Domain"**. Railway asigna una dirección `…up.railway.app` y **provisiona y renueva el certificado SSL automáticamente**: la dirección queda en `https://` sin que configures nada. **Cópiala y guárdala**, la necesitas en el Paso 7.

   > **Sobre el puerto de destino** (*target port*): cuando generas el dominio,
   > Railway detecta el puerto en el que la aplicación escucha y lo fija solo. Si
   > te ofrece una lista, elige el que corresponde a `PORT`. Puedes cambiarlo
   > después con el ícono de edición junto al dominio.

7. **Comprobación de salud.** En **Settings → Deploy**, pon en **"Healthcheck Path"**:
   ```
   /health
   ```
   Railway consulta esa ruta hasta recibir un 2xx antes de enviarle tráfico al
   nuevo despliegue, y así los despliegues no dejan la web caída. El tiempo límite
   por omisión es de 300 segundos.

   > **Por qué `/health` y no `/ready`.** El proyecto expone las dos sondas a
   > propósito: `/health` responde sin consultar la base (vivacidad) y `/ready`
   > consulta PostgreSQL y devuelve **503** si no contesta (disponibilidad).
   > Railway solo mira la ruta **al inicio del despliegue**, no de forma continua.
   > Con `/ready`, un despliegue perfectamente bueno fallaría solo porque la base
   > tardó en estar lista. Usa `/ready` a mano para diagnosticar (Paso 8).

8. **Evita reconstruir todos los servicios en cada cambio.** Salen del mismo repositorio, así que **cada empujón a GitHub los dispara a todos**. En **Settings → Build → "Watch Paths"**, pon en este servicio:
   ```
   backend/**
   ```

9. **Opcional, pero recomendado: activa "Wait for CI"** (**Settings**, junto a la
   fuente de GitHub). El repositorio trae un flujo de GitHub Actions que corre en
   cada empujón a `main`, y con esta opción Railway **espera** a que termine bien
   antes de desplegar. Entre otras cosas, ese flujo comprueba que los avisos de
   licencias dentro de `backend/avisos` y `frontend/avisos` estén al día: sin la
   espera, un empujón con esas copias desactualizadas se desplegaría igual.

10. Railway desplegará el servicio automáticamente. Puedes ver el progreso en la pestaña **"Deployments"**. La primera vez puede tardar varios minutos.

    > **El primer despliegue va a quedar "sano" pero la aplicación no funcionará
    > todavía**, y es normal: faltan las tablas. Eso es el Paso 6.b. Si consultas
    > `/ready` ahora, responderá que la base está accesible; lo que aún no existe
    > es su contenido.

---

## Paso 6.b — Crear el servicio de mantenimiento (migraciones y datos iniciales)

Este es un **tercer servicio**, en el mismo proyecto y desde el mismo
repositorio. No atiende peticiones, no tiene dirección pública y **solo corre
cuando tú lo haces correr**. Existe porque las herramientas de migración no
viajan en la imagen de la API, y eso es deliberado (Sección 0, Problema 3).

1. **"+ New" → "GitHub Repo"** y selecciona otra vez el mismo repositorio.
   Renómbralo a algo inequívoco, por ejemplo `mantenimiento`.
2. **Settings → Source → Root Directory**:
   ```
   backend
   ```
   (el mismo que el backend: es el mismo `Dockerfile`)
3. **Variables.** Solo estas:

   | Nombre | Valor |
   |---|---|
   | `RAILWAY_DOCKERFILE_PATH` | `Dockerfile.mantenimiento` |
   | `DATABASE_URL` | **Por referencia** a la base Postgres, igual que en el Paso 6.5 |
   | `SEED_ADMIN_USERNAME` | El **nombre de usuario** del administrador (no es un correo), p. ej. `admin.fchmn` |
   | `SEED_ADMIN_PASSWORD` | Una contraseña propia y secreta: **mínimo 10 caracteres, con mayúscula, minúscula y número** (la misma política que para cualquier usuario) |

   > **`RAILWAY_DOCKERFILE_PATH` es lo único que distingue este servicio del
   > backend.** Los dos apuntan a la misma carpeta del mismo repositorio; lo que
   > cambia es qué archivo se construye. `backend/Dockerfile` da la API;
   > `backend/Dockerfile.mantenimiento` —derivado del anterior, ver Sección 0— da
   > las herramientas de migración. **No pongas esta variable en el servicio del
   > Paso 6.**
   >
   > **Si la construcción dice que no encuentra el archivo**, prueba con la ruta
   > completa desde la raíz del repositorio: `/backend/Dockerfile.mantenimiento`.
   > La documentación de Railway muestra las dos formas —un nombre suelto y una
   > ruta con barra inicial— sin decir cuál rige cuando hay un directorio raíz
   > configurado; la primera es la que corresponde a ese directorio.

   > **Estas dos credenciales son obligatorias en todos los entornos.** Si falta
   > cualquiera de las dos —o queda **definida pero vacía**, que cuenta como
   > ausente—, el comando que crea el administrador **se niega a ejecutarse** y
   > dice cuál falta: no existen credenciales por omisión. Elige valores propios y
   > no los copies de ninguna plantilla ni de ningún ejemplo. La variable se llama
   > `SEED_ADMIN_USERNAME`; `SEED_ADMIN_EMAIL` no existe y el sistema la ignora. El
   > comando **no imprime** el usuario, la contraseña ni su hash: la salida de un
   > despliegue queda registrada.

4. **Settings → Deploy → Restart Policy**: ponla en **`NEVER`**.

   > **Por qué.** Este servicio termina en cuanto acaba su trabajo. Con la
   > política por omisión, Railway interpretaría cada salida como una caída y lo
   > reintentaría hasta diez veces: diez migraciones seguidas en lugar de una.

5. **No le generes dominio público y no le pongas "Healthcheck Path".** No sirve
   nada por HTTP; un *healthcheck* no encontraría nada escuchando y marcaría el
   despliegue como fallido.

6. **Desactiva el despliegue automático.** En **Settings**, en la sección de la
   fuente de GitHub, haz clic en **Disable** (junto a los despliegues
   automáticos).

   > **Esto es lo más importante de todo el paso.** Un servicio ligado a GitHub
   > se despliega solo con cada empujón a la rama conectada, y desplegar este
   > servicio **ejecuta su comando**: cada cambio del backend aplicaría
   > migraciones sin que nadie lo pidiera. Desactivado, este servicio **solo
   > corre cuando tú lo lanzas**, que es exactamente lo que se quiere de una
   > herramienta de mantenimiento.

   A partir de ahora, para lanzarlo: abre la **paleta de comandos** (`Ctrl+K` /
   `Cmd+K`) y elige **"Deploy Latest Commit"**.

### Los tres comandos, en este orden

El **Start Command** de este servicio (**Settings → Deploy**) decide cuál de los
tres corre. Para cada uno: escribe el comando, lánzalo con `Ctrl+K` →
**"Deploy Latest Commit"**, y **lee los registros** antes de pasar al siguiente.

**1) Aplicar las migraciones** (crea y actualiza las tablas). Es el comando que
la imagen trae por omisión, así que para este paso puedes dejar el Start Command
**vacío**:

```
prisma migrate deploy --schema=/app/prisma/schema.prisma
```

Termina diciendo `All migrations have been successfully applied.`

**2) Sembrar los datos de referencia** (roles, permisos, parámetros y catálogos).
Es **idempotente**: se puede repetir sin problema y **no crea usuarios**.

```
node dist-seed/prisma/seed.js
```

**3) Crear el administrador inicial. Una sola vez.** Usa `SEED_ADMIN_USERNAME` y
`SEED_ADMIN_PASSWORD`. Si el administrador ya existe, el comando lo detecta y
**no lo modifica** —lo dice: *«ya existe y es un administrador válido: no se
modifica»*—, así que un redespliegue accidental no rompe nada:

```
node dist-seed/prisma/seed-admin.js
```

Termina diciendo `Administrador inicial creado. Debe cambiar la contraseña en el
primer ingreso.`

**Cuando los tres hayan terminado bien**, deja el Start Command en el comando 1
(o vacío) para que el próximo lanzamiento sea el inocuo, y no lo vuelvas a lanzar
hasta la próxima actualización con migraciones. Si quieres que no consuma nada,
puedes además quitar su despliegue (**Deployments → tres puntos → Remove**); el
servicio y sus variables se conservan.

> **Nunca dejes el comando 3 escrito en el Start Command.** Es el único que no es
> repetible por naturaleza, y aunque hoy se niega a modificar un administrador
> existente, dejarlo ahí convierte cualquier lanzamiento accidental en un intento
> de crear credenciales.

> **Si una migración o un seed termina con ERROR, no sigas:** corrige la causa y
> repite el paso. Es la misma regla que encabeza `docker-compose.yml`. En
> particular, **no uses la API** hasta que el comando 1 haya terminado bien: sin
> tablas, todo falla.

> **Alternativa: una consola interactiva.** Si prefieres ejecutar los tres
> comandos seguidos sin cambiar el Start Command, instala el CLI de Railway, usa
> `railway link` para conectar la carpeta al proyecto y `railway ssh` para abrir
> una consola dentro del contenedor de este servicio. La versión anterior de esta
> guía mandaba buscar una "consola/shell" o un "Run Command" en el panel: **eso
> no está documentado así**; lo documentado es `railway ssh`.

> **Por qué son tres comandos y no uno.** Antes el arranque del servicio sembraba
> todo en cada reinicio, incluida la creación del administrador. Eso mezclaba
> operaciones repetibles con una que no lo es, y hacía que un despliegue sin
> variables definidas creara en silencio una cuenta con credenciales conocidas.
> Ahora el tercero se ejecuta a mano, una vez, y falla si faltan las variables.

> **Y por qué no un "Pre-deploy Command".** Railway puede ejecutar un comando
> entre la construcción y el despliegue, y sería cómodo para las migraciones.
> Pero lo ejecuta **a partir de la misma imagen de la aplicación**, que no trae
> estas herramientas; y correría en **cada** despliegue, lo que es correcto para
> el comando 1 pero inadmisible para el 3, que no es repetible por naturaleza.

---

## Paso 7 — Configurar el servicio del frontend (la web)

1. En el mismo proyecto de Railway, haz clic en **"+ New" → "GitHub Repo"** y selecciona **el mismo repositorio otra vez**. Esto crea un segundo servicio dentro del mismo proyecto. Conviene renombrarlo a `frontend`.
2. Entra a este nuevo servicio → **"Settings"**.
3. **Root Directory**:
   ```
   frontend
   ```
   > Igual que antes: **no** `app/frontend`.

4. **Constructor.** Railway usará `frontend/Dockerfile` automáticamente por estar en el directorio raíz del servicio — no hay que elegir nada. Compila con Node y sirve el resultado con **Nginx**.

   > **Este servicio no necesita `RAILWAY_DOCKERFILE_PATH`.** La última etapa de
   > `frontend/Dockerfile` ya es la correcta (la de Nginx). El segundo archivo
   > existe solo en `backend/`, que produce dos imágenes distintas.

   > **Por qué Dockerfile y no `npx serve dist -s -p $PORT`.** Esa era la
   > instrucción anterior y tenía dos problemas: `serve` **no está declarado como
   > dependencia** del proyecto, así que cada arranque dependía de que `npx` lo
   > descargara del registro npm —si el registro falla o cambia el paquete, el
   > servicio no levanta—, y no es un servidor pensado para producción. La imagen
   > Nginx ya incluye el *fallback* de SPA, sin el cual recargar el navegador en
   > `/competencias` devuelve 404.

5. **Start Command**: déjalo **vacío**. La imagen ya sabe arrancar sola.

   > **Sobre el puerto:** Railway inyecta la variable `PORT` y espera que el
   > servicio escuche **ahí**. La imagen del frontend ya lo obedece: su
   > configuración de Nginx es una plantilla (`nginx/default.conf.template`) que
   > se completa al arrancar con el valor de `PORT`, y el `Dockerfile` le deja
   > `80` como valor por omisión para uso local. **No agregues una variable `PORT`
   > a mano.** Si el servicio quedara con un puerto fijo distinto del que busca el
   > enrutador, la página no cargaría sin ningún error en los registros que lo
   > explicara.

6. Ve a **"Variables"** y agrega:

   | Nombre | Valor |
   |---|---|
   | `VITE_API_URL` | La dirección pública del backend del Paso 6.6, p. ej. `https://tu-backend-production.up.railway.app`, **sin barra final** |

   > **Importante: esta variable se aplica al CONSTRUIR, no al ejecutar.** Vite
   > escribe la dirección **dentro** de los archivos JavaScript al compilar. Si la
   > cambias después, **hay que volver a desplegar** (*Redeploy*) para que tenga
   > efecto: cambiarla y reiniciar el servicio no modifica los archivos ya
   > generados.
   >
   > **No hace falta marcarla de ninguna forma especial.** La versión anterior de
   > esta guía decía que había que marcarla como *build variable* y pasarla como
   > `--build-arg`: eso no es así en Railway. Railway inyecta las variables del
   > servicio también durante la construcción, y basta con que el `Dockerfile` las
   > declare con `ARG` — `frontend/Dockerfile` ya trae `ARG VITE_API_URL`.

   > **Si no la defines**, la web queda compilada apuntando a
   > `http://localhost:3000` (el valor por omisión de `apiClient.ts` y del
   > `Dockerfile`), y en internet no funcionará: el navegador del usuario buscaría
   > la API en *su propio* computador.

7. Ve a **"Settings" → "Networking"** y haz clic en **"Generate Domain"** para este servicio también. Esta es la dirección que vas a compartir con los usuarios finales (clubes, delegados, etc.), y también llega por HTTPS con certificado automático.

   > **Ahora vuelve al backend y completa `CORS_ORIGINS`.** Copia esta dirección
   > del frontend, entra al servicio del **backend** → **"Variables"**, y pon ese
   > valor en `CORS_ORIGINS`. Escríbelo **exactamente** como aparece, con
   > `https://` y **sin barra final**:
   >
   > | Bien | Mal |
   > |---|---|
   > | `https://inscripciones.up.railway.app` | `https://inscripciones.up.railway.app/` (barra final) |
   > | | `http://inscripciones.up.railway.app` (http en vez de https) |
   > | | `inscripciones.up.railway.app` (sin esquema) |
   >
   > La aplicación valida el formato al arrancar y **rechaza** un origen con ruta
   > final. Hasta que esta variable esté puesta, **nadie podrá iniciar sesión**:
   > el backend rechazará las peticiones de la web por venir de un origen no
   > declarado. Es a propósito — sin esa lista, cualquier sitio de internet podría
   > usar la sesión de tus usuarios.
   >
   > Guarda y espera a que el backend se vuelva a desplegar.

8. **Watch Paths** de este servicio, en **Settings → Build**:
   ```
   frontend/**
   ```

9. Espera a que termine el despliegue (pestaña "Deployments", ícono verde).

---

## Paso 8 — Comprobar que todo funciona

Hazlo en este orden: cada comprobación supone que la anterior pasó.

**1) La API está viva.** Abre en el navegador la dirección del backend con `/health` al final:
```
https://TU-BACKEND.up.railway.app/health
```
Debe responder algo como `{"status":"ok","uptime":12}`. Si no responde, el
problema está en el servicio del backend (mira sus registros, pestaña
**"Deployments"** → el despliegue → *Logs*).

**2) La API alcanza la base de datos.** Ahora con `/ready`:
```
https://TU-BACKEND.up.railway.app/ready
```
Debe responder `{"status":"ready","database":"ok"}`. Si devuelve **503** con
`"database":"unreachable"`, la API está viva pero no habla con PostgreSQL: revisa
que `DATABASE_URL` esté puesta **por referencia** al servicio de Postgres.

**3) La web carga.** Abre la dirección pública del **frontend** (Paso 7.7). Deberías ver la pantalla de ingreso con el logo de la FCHMN.

**4) El *fallback* de SPA funciona.** Escribe directamente una ruta interna, por ejemplo:
```
https://TU-FRONTEND.up.railway.app/competencias
```
Debe cargar la aplicación (y pedirte ingresar), **no** un 404 de Nginx.

**5) Se puede iniciar sesión.** Ingresa con el **nombre de usuario** y la contraseña que definiste en `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`. No es un correo.
   - Si el login falla con un error de conexión o de seguridad, el sospechoso es `CORS_ORIGINS` o `VITE_API_URL` (ver "Problemas comunes").
   - Si dice que las credenciales no existen, probablemente falta ejecutar el comando 3 del Paso 6.b.

**6) Cambia la contraseña.** El sistema te pedirá cambiarla en el primer ingreso — hazlo y guarda la nueva en un lugar seguro.

**7) Recién entonces, comparte la dirección del frontend** con quien necesite usar el sistema.

---

## Paso 9 — Copias de seguridad de la base de datos

**Esto no venía en la versión anterior de esta guía, y es lo que separa una
instalación de prueba de una que puede perder datos de verdad.** Railway **no
hace copias automáticas por omisión**: hay que activarlas.

1. Entra al servicio **PostgreSQL** → pestaña **"Backups"**.
2. Activa al menos un calendario. Puedes tener varios a la vez:

   | Calendario | Frecuencia | Se conserva |
   |---|---|---|
   | Diario | cada 24 h | 6 días |
   | Semanal | cada 7 días | 27 días |
   | Mensual | cada 30 días | 89 días |

   Para datos de inscripciones reales, **el diario es lo mínimo razonable**, y
   conviene sumar el mensual.

**Cómo restaurar una copia** (es un proceso con confirmación, no un botón que
borra lo actual):

1. En la pestaña **"Backups"**, busca la copia por su fecha y haz clic en **Restore**. Tarda entre segundos y unos minutos.
2. Revisa los cambios preparados con **Details**, arriba en el lienzo del proyecto.
3. La restauración crea un **volumen nuevo** con la fecha de la copia, montado donde estaba el original. **El volumen original no se borra**: queda en el proyecto, desmontado.
4. Haz clic en **Deploy** para aplicar y redesplegar el servicio.

**Límites que conviene saber de antemano:**

- Una copia **manual** no puede superar el **50 %** del tamaño total del volumen.
- Una copia solo se puede restaurar **en el mismo proyecto y entorno**.
- **Vaciar un volumen borra todas sus copias.**
- Las copias más recientes que el punto restaurado se quedan en el volumen original: no se copian al nuevo.

> **Una copia dentro de Railway no es una copia fuera de Railway.** Si el riesgo
> que te preocupa es perder la cuenta (crédito agotado, cierre, error de
> facturación), una copia que vive en el mismo proveedor no te protege. Para eso
> hace falta un respaldo externo con `pg_dump` contra la base. **El repositorio no
> trae ninguna herramienta ni script para esto**, así que es una decisión
> pendiente (ver la última sección).

---

## Paso 10 — Si el despliegue falla: cómo recuperar el servicio

Todo esto está en la pestaña **"Deployments"** del servicio, en los **tres puntos**
al final de un despliegue anterior.

**El despliegue nuevo falló y la web dejó de funcionar → *Rollback*.**
Vuelve al despliegue anterior que sí funcionó. Restaura **la imagen y las
variables** de ese momento, sin reconstruir nada. Tiene un plazo: Railway guarda
las imágenes **24 h** en Trial/Free, **72 h** en Hobby, **120 h** en Pro. Pasado
el plazo, la opción no aparece.

**Pasó el plazo del rollback → *Redeploy*.**
Vuelve a construir desde el mismo código y con las variables originales de ese
despliegue. Tarda lo que tarde una construcción, pero no depende de la imagen
guardada.

**El despliegue quedó en *Crashed*.**
El proceso terminó con código distinto de cero. Railway reintenta solo hasta 10
veces según la política de reinicios y luego avisa por correo. Puedes usar el
botón **"Restart"** que aparece en línea sobre el despliegue: restaura la imagen
exacta de esa construcción.

**La construcción se está demorando y quieres detenerla → *Abort deployment*.**

**Perdiste o corrompiste datos → restaura una copia** (Paso 9).

> **Un reinicio no arregla una migración a medias.** Si el fallo fue en
> `prisma migrate deploy`, volver atrás la imagen **no deshace** lo que la
> migración ya escribió en la base. Ese caso se resuelve restaurando una copia de
> seguridad anterior a la migración, y por eso el Paso 9 va antes que cualquier
> actualización con migraciones.

---

## Actualizar la aplicación en el futuro

Cuando quieras subir cambios (por ejemplo, si te comparten una versión nueva del
proyecto):

1. **Antes de nada, haz una copia de seguridad manual** de la base (Paso 9), sobre todo si la versión nueva trae migraciones.
2. Reemplaza los archivos en tu carpeta local por los nuevos.
3. En VS Code, ve al ícono de **Source Control**.
4. Vas a ver la lista de archivos que cambiaron. Escribe un mensaje corto describiendo el cambio (ej. "actualización") en el cuadro de texto de arriba.
5. Haz clic en el botón de **"Commit"** (el ✓) y luego en **"Sync Changes" / "Sincronizar cambios"**.
6. Railway detecta el cambio en GitHub y vuelve a desplegar los servicios cuyos *watch paths* coincidan.
7. **Si la versión nueva trae migraciones**, aplícalas con el comando 1 del servicio de mantenimiento (Paso 6.b). El arranque de la API **no migra solo**, a propósito. El comando 3 —el administrador— **no se repite nunca**.
8. Comprueba con el Paso 8. Si algo salió mal, Paso 10.

> **Si usas la Opción B** (imágenes prearmadas), este flujo no aplica: hay que
> reconstruir y volver a publicar las imágenes a mano, y luego actualizar el tag
> en Railway.

---

## Problemas comunes y solución

**La construcción falla con un error en una línea `COPY avisos/…`**
→ Falta la copia de los avisos dentro del contexto. En tu computador, ejecuta
`node scripts/distribuir-avisos.mjs` en la carpeta del proyecto, y sube el
resultado a GitHub (Source Control → Commit → Sync Changes). La integración
continua también lo avisa con `node scripts/distribuir-avisos.mjs --verificar`.

**El servicio del backend construye bien, pero "arranca y termina" sin servir nada**
→ Se construyó la imagen de mantenimiento en lugar de la API. Revisa que el
servicio del Paso 6 **no** tenga la variable `RAILWAY_DOCKERFILE_PATH`: esa va
únicamente en el servicio del Paso 6.b.

**El servicio de mantenimiento arranca una API en vez de migrar**
→ Lo contrario: no está usando el archivo derivado. Comprueba que
`RAILWAY_DOCKERFILE_PATH=Dockerfile.mantenimiento` esté en *ese* servicio,
escrita exactamente así.

**La construcción del servicio de mantenimiento dice que no encuentra el Dockerfile**
→ Prueba con la ruta completa: `/backend/Dockerfile.mantenimiento`. Y confirma
que el archivo esté en GitHub: lo genera
`node scripts/generar-dockerfile-mantenimiento.mjs` y tiene que estar subido.

**El servicio de mantenimiento se redespliega una y otra vez**
→ Le falta **Restart Policy = `NEVER`** (Paso 6.b.4). Railway está tomando su
salida normal por una caída.

**El despliegue del backend falla con un error sobre la base de datos**
→ Revisa que `DATABASE_URL` esté conectada **por referencia** al servicio de
Postgres (Paso 6.5), no escrita a mano.

**El backend no arranca y en los registros hay una lista de variables con errores**
→ Es la validación de configuración, que corre al arrancar y falla a propósito en
vez de levantar mal configurado. El mensaje dice **qué variable y por qué**. Los
cuatro casos más frecuentes: `CORS_ORIGINS` vacía en producción, `CORS_ORIGINS`
con una barra final, `AUTH_COOKIE_SECURE=false` en producción, y
`JWT_ACCESS_SECRET` demasiado corto o con aspecto de valor de ejemplo.

**El frontend carga pero el login da error de conexión**
→ Revisa que `VITE_API_URL` (Paso 7.6) tenga exactamente la dirección pública del
backend del Paso 6.6, sin `/` al final — y recuerda que **hay que volver a
desplegar** el frontend después de cambiarla.

**Aparece "Comprobación de seguridad fallida" al iniciar sesión**
→ Casi siempre `CORS_ORIGINS` no coincide exactamente con la dirección del
frontend. Ver el recuadro de CSRF en el Paso 6.

**La sesión se cierra sola en cada recarga**
→ El navegador está descartando la cookie. Comprueba que `AUTH_COOKIE_SAMESITE`
sea `none` y que **no** hayas definido `AUTH_COOKIE_SECURE=false`.

**Recargar la página en una ruta interna devuelve 404**
→ El servicio del frontend no está sirviendo la imagen de Nginx del proyecto.
Revisa el Paso 7.4.

**Todas las IP del registro de auditoría son la misma**
→ Falta `TRUST_PROXY_HOPS=1` en el backend (Paso 6.5).

**`/ready` devuelve 503 pero `/health` responde bien**
→ La API está viva y PostgreSQL no contesta. Mira el estado del servicio de base
de datos y `DATABASE_URL`.

**Me quedé sin crédito y la aplicación dejó de responder**
→ Según la documentación de Railway, cuando el crédito llega a cero **la
suscripción se cancela y se detienen las cargas de trabajo**. Entra a Railway →
**Settings del proyecto → Billing** y contrata un plan. **No te confíes:** los
datos del volumen se eliminan **30 días después del vencimiento** en Trial/Free.
Si llevas tiempo sin entrar, restaura primero una copia de seguridad.

**No sé si el archivo `.env` se subió a GitHub por error**
→ Entra a tu repositorio en github.com y revisa la **raíz** y la carpeta
**`backend`**. Si ves un archivo llamado `.env` (no `.env.example`), bórralo desde
ahí mismo y **cambia de inmediato** los secretos que contenía: el
`JWT_ACCESS_SECRET`, la contraseña de la base y las credenciales del
administrador. Borrarlo del repositorio **no lo quita del historial**: pide ayuda
a quien te compartió el proyecto para limpiarlo.

**Quiero usar mi propio dominio (ej. www.mifederacion.cl)**
→ En el servicio del frontend, ve a **Settings → Networking → + Custom Domain**.
Railway te dará **dos registros DNS: un `CNAME` y un `TXT`**, y **los dos son
obligatorios** — si falta el `TXT`, el dominio no se verifica y las peticiones
devuelven 404 aunque el `CNAME` resuelva. El certificado SSL (Let's Encrypt) se
emite solo, normalmente dentro de la hora siguiente a que el DNS esté correcto, y
se renueva automáticamente. Dos límites de plan: **Trial permite 1 dominio
propio** (así que no puedes tener `midominio.cl` y `www.midominio.cl` a la vez) y
**Hobby permite 2 por servicio**. Si pones también el backend en tu dominio
(p. ej. `api.midominio.cl`), acuérdate de actualizar `CORS_ORIGINS` y
`VITE_API_URL`, y de volver a desplegar el frontend.

---

## Qué se comprobó y qué no

### Comprobado con las imágenes reales

Todo esto se ejecutó en una máquina de desarrollo con Docker, contra una **base
de datos desechable** creada y destruida para la prueba (nunca contra datos
reales):

- `docker build ./backend` **sin elegir etapa** produce la imagen de la API
  (`CMD` = `node dist/server.js`, con `dist/server.js` dentro y **sin** el CLI de
  Prisma). Antes producía la de migraciones.
- `docker build -f backend/Dockerfile.mantenimiento ./backend` produce la de
  mantenimiento (`CMD` = `prisma migrate deploy …`), con `prisma` en el `PATH`,
  solo `seed.js` y `seed-admin.js` compilados —**ningún seed de datos de
  prueba**— y **sin** `dist/`: no puede servir la API, y la API no puede migrar.
  La separación entre las dos sigue intacta.
- Esa imagen derivada es **idéntica capa por capa y configuración por
  configuración** a la de `docker build --target migrate ./backend`: la etapa que
  añade el archivo derivado es un alias y no agrega ni quita nada.
- El archivo derivado **no construye la etapa `runtime`**: se comprobó que no
  aparece en el registro de construcción, porque la etapa final no depende de ella.
- `node scripts/generar-dockerfile-mantenimiento.mjs --verificar` confirma que el
  archivo derivado coincide con su fuente, y detecta la divergencia si no.
- `docker build ./frontend` produce la imagen de Nginx, y el contenedor obedece
  `PORT`: con `PORT=8099` sirve `/`, devuelve `index.html` en `/competencias`
  (*fallback* de SPA) y 404 en un activo inexistente.
- Los avisos de terceros están dentro de las cuatro rutas esperadas y son
  **idénticos byte a byte** a `notices/backend.txt`, `notices/migrate.txt`,
  `notices/frontend-web.txt` y `notices/frontend-image.txt`.
- Las guardas del proyecto siguen conformes: `verificar-archivos-de-imagen.mjs`,
  `contraprueba-dockerignore.mjs`, los 852 tests unitarios del backend y la
  comprobación de tipos.
- `docker compose build` y `docker compose --profile mantenimiento build migrate`
  siguen produciendo cada uno su imagen correcta: **el entorno local no cambió**.
- La secuencia completa del Paso 6.b: migraciones aplicadas, datos de referencia
  sembrados, el administrador creado, y repetir ese último comando **no** lo
  modifica. Sin `SEED_ADMIN_*`, se niega a ejecutarse (código de salida 1).
- La API arranca en modo producción y responde `/health` y `/ready`; `/docs`
  devuelve 404 (apagada en producción); y **se inició sesión con éxito** con el
  administrador creado. Con `CORS_ORIGINS` ausente o `AUTH_COOKIE_SECURE=false`,
  el arranque se detiene nombrando la variable.

### No comprobado

- **Nada se desplegó en Railway.** No se creó cuenta, proyecto ni servicio, y no
  se contrató nada. Todos los pasos que ocurren dentro del panel de Railway están
  escritos a partir de su documentación oficial, no de una ejecución.
- **Si `RAILWAY_DOCKERFILE_PATH` se interpreta relativo al directorio raíz del
  servicio o a la raíz del repositorio.** Su documentación muestra las dos formas
  —`Dockerfile.origin` y `/build/Dockerfile`— sin decir cuál rige cuando hay un
  directorio raíz configurado. El Paso 6.b indica la primera, que es la coherente
  con «buscamos un archivo llamado Dockerfile en el directorio raíz», y da la
  segunda como alternativa si la construcción no encuentra el archivo. Las dos
  están documentadas: el riesgo es un intento fallido, no un camino sin salida.
- **Que no exista alguna forma no documentada** de pasar contextos adicionales o
  de elegir la etapa en Railway. Se revisaron su documentación de Dockerfiles, de
  construcciones y su referencia de configuración, y no aparece en ninguna.
- **El consumo real y, por tanto, el costo mensual.** Depende del uso.

## Qué falta decidir antes de desplegar

Son decisiones que el repositorio no toma por ti.

1. **Qué plan se contrata**: el Trial no sirve para datos reales (un solo crédito
   de US$5, volumen de 0,5 GB, y las imágenes para *rollback* solo duran 24 h).
2. **Respaldo fuera del proveedor**: el repositorio **no trae** ningún script de
   `pg_dump` ni procedimiento de respaldo externo. Si los datos importan, hay que
   definirlo.
3. **Dominio propio**: si se va a usar uno, conviene decidirlo **antes**, porque
   cambia `CORS_ORIGINS`, `VITE_API_URL` y —si backend y frontend quedan bajo el
   mismo sitio— permite volver `AUTH_COOKIE_SAMESITE` a `lax`, que es más seguro.
4. **Quién recibe los avisos de caída**: Railway solo comprueba la salud **al
   desplegar**, no de forma continua. No hay ninguna monitorización configurada en
   este proyecto.
