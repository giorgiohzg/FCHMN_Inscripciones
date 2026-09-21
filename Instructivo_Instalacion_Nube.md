# Instalación en la nube (para que quede disponible en internet, sin dejar tu computador prendido)

**Para quién es esta guía:** para alguien que **no sabe programar**, que ya tiene
Visual Studio Code, y que quiere que la aplicación quede funcionando en internet
de forma permanente — accesible desde cualquier computador, sin depender de que
tu computador esté prendido.

**Tiempo estimado:** 45-60 minutos la primera vez.

**Sobre el costo:** vamos a usar una plataforma llamada **Railway**. Te da
US$5 de crédito gratis al crear la cuenta (sin pedir tarjeta de crédito) para que
pruebes todo sin gastar nada. Ese crédito normalmente alcanza para 1-4 semanas de
uso liviano. Después, si quieres que la aplicación siga disponible de forma
permanente, Railway cobra un plan desde **US$5 al mes**. Te lo aviso de entrada
para que no te encuentres con sorpresas — no es necesario pagar nada para seguir
esta guía y probar todo primero.

---

## Antes de empezar: ¿qué vamos a hacer?

A diferencia de la instalación local (que corre en tu computador), aquí vamos a:

1. Instalar **Git** (una herramienta para subir el código a internet).
2. Crear una cuenta en **GitHub** (donde va a "vivir" el código).
3. Subir el proyecto a GitHub usando el propio VS Code (con botones, sin escribir comandos raros).
4. Crear una cuenta en **Railway** (la plataforma que va a ejecutar la aplicación).
5. Conectar Railway con tu proyecto de GitHub y configurarlo.
6. Obtener el enlace público de tu aplicación.

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

1. Abre VS Code y abre la carpeta del proyecto (**File → Open Folder**, la carpeta `natacion` que contiene `app`, tal como en la guía local — si no la tienes, descomprime `Proyecto_Natacion.zip` primero).
2. En la barra vertical de íconos de la izquierda, busca el ícono que parece una rama de árbol con puntos (**Source Control** / **Control de código fuente**). Haz clic ahí.
3. Vas a ver un botón que dice **"Publish to GitHub" / "Publicar en GitHub"**. Haz clic.
4. VS Code te va a pedir permiso para conectarse a tu cuenta de GitHub — acepta y sigue el proceso de inicio de sesión que se abre en el navegador.
5. Te va a preguntar el nombre del repositorio (puedes dejar el que sugiere, por ejemplo `app`) y si quiere ser **público o privado**. Elige **Private / Privado** (así nadie más puede ver el código sin tu permiso).
6. Espera a que termine de subir (verás una barra de progreso abajo). Cuando termine, tu código ya está en GitHub.

**Importante — antes de continuar:** verifica que el archivo `.env` (el que creaste en la guía local con las contraseñas secretas) **no se haya subido**. Esto ya está prevenido automáticamente en este proyecto, pero es bueno confirmarlo: en GitHub, abre tu repositorio en el navegador y revisa que **no aparezca** un archivo llamado `.env` dentro de la carpeta `backend` (sí es normal y correcto ver `.env.example`).

---

## Paso 4 — Crear una cuenta en Railway

1. Ve a **https://railway.com**
2. Haz clic en **Login** o **Start a New Project**.
3. Elige **"Login with GitHub"** — así conectas Railway con la cuenta de GitHub que creaste antes. Acepta los permisos que te pida.

---

## Paso 5 — Crear el proyecto y la base de datos

1. Dentro de Railway, haz clic en **"New Project"**.
2. Elige **"Deploy from GitHub repo"**.
3. Busca y selecciona el repositorio que subiste en el Paso 3 (por ejemplo `app`).
4. Railway va a intentar detectar el proyecto automáticamente. **No te preocupes si falla o si aparece un servicio con errores** — lo vamos a configurar a mano en los siguientes pasos. Este primer servicio detectado lo vamos a usar para el **backend**.
5. Dentro del mismo proyecto, haz clic en el botón **"+ New"** (o **"Create"**) y elige **"Database" → "Add PostgreSQL"**. Railway crea automáticamente una base de datos y la conecta al proyecto.

---

## Paso 6 — Configurar el servicio del backend

1. Haz clic sobre el servicio que Railway creó desde tu repositorio (el que va a ser el backend).
2. Ve a la pestaña **"Settings"**.
3. Busca el campo **"Root Directory"** y escribe: `app/backend`
4. Busca **"Build Command"** y escribe:
   ```
   npm install && npx prisma generate && npm run build
   ```
5. Busca **"Start Command"** y escribe:
   ```
   npx prisma migrate deploy && npm run start
   ```
6. Ve a la pestaña **"Variables"** (todavía dentro de este mismo servicio). Aquí vamos a agregar las variables de entorno, una por una, con el botón **"+ New Variable"**:

   | Nombre | Valor |
   |---|---|
   | `DATABASE_URL` | Haz clic en el botón de "referencia" (ícono de enchufe/variable) y elige la base de datos Postgres que creaste — Railway completa esto automáticamente. |
   | `JWT_ACCESS_SECRET` | Genera un valor único (ver recuadro abajo) |
   | `NODE_ENV` | `production` |
   | `CORS_ORIGINS` | La dirección pública del **frontend**, exacta y sin barra final, ej. `https://inscripciones.up.railway.app`. **Obligatoria en producción.** Se completa en el Paso 7.7, cuando ya exista. |
   | `AUTH_COOKIE_SAMESITE` | `none` (ver el recuadro de abajo) |
   | `AUTH_COOKIE_SECURE` | Déjala **sin definir**. En producción se activa sola, y ponerla en `false` hace que el arranque falle a propósito. |
   | `SEED_ADMIN_USERNAME` | El **nombre de usuario** del administrador (no es un correo), ej. `admin.fchmn` |
   | `SEED_ADMIN_PASSWORD` | Una contraseña propia y secreta: mínimo 10 caracteres, con mayúscula, minúscula y número |

   > **Estas dos variables son obligatorias en todos los entornos.** Si falta cualquiera
   > de las dos, el comando que crea el administrador se detiene con un error: **no existen
   > credenciales por omisión**. Elige valores propios y no los copies de ninguna
   > plantilla ni de ningún ejemplo. La variable se llama `SEED_ADMIN_USERNAME`;
   > `SEED_ADMIN_EMAIL` no existe y el sistema la ignora.


   > ### Por qué `AUTH_COOKIE_SAMESITE=none` en Railway
   >
   > La sesión del usuario viaja en una cookie que el navegador guarda para el
   > dominio del **backend**. En Railway el frontend y el backend reciben
   > **dominios distintos** (`...-frontend.up.railway.app` y
   > `...-backend.up.railway.app`), así que para el navegador son **sitios
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

   **Para generar el valor de `JWT_ACCESS_SECRET`:** en VS Code, abre una terminal y ejecuta este comando una vez (igual que en la guía local):
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

7. Ve a la pestaña **"Settings"** nuevamente y busca **"Networking"**. Haz clic en **"Generate Domain"** — esto le da a tu backend una dirección pública (algo como `tu-proyecto-production.up.railway.app`). **Cópiala y guárdala**, la necesitas en el Paso 7.
8. Railway va a desplegar el servicio automáticamente. Puedes ver el progreso en la pestaña **"Deployments"**. La primera vez puede tardar 3-5 minutos.

**Cargar los datos iniciales:** una vez que el despliegue termine sin errores (ícono
verde), ve a la pestaña **"Settings"** de este servicio, busca la opción de abrir una
**consola/shell** (o usa el botón de tres puntos junto al servicio → "Run Command"), y
ejecuta **dos comandos, en este orden**:

```
npm run prisma:seed
```
*(roles, permisos, parámetros y catálogos. Se puede repetir sin problema: no crea usuarios.)*

```
npm run seed:admin
```
*(crea el administrador con `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`. **Una sola vez.**)*

> **Por qué son dos comandos y no uno.** Antes el arranque del servicio sembraba todo en
> cada reinicio, incluida la creación del administrador. Eso mezclaba una operación
> repetible con una que no lo es, y hacía que un despliegue sin variables definidas
> creara en silencio una cuenta con credenciales conocidas. Ahora el segundo comando se
> ejecuta a mano, una vez, y en producción falla si faltan las variables.
>
> El comando **no imprime la contraseña**: es la que definiste tú en el Paso 6.6.

---

## Paso 7 — Configurar el servicio del frontend

1. En el mismo proyecto de Railway, haz clic en **"+ New" → "GitHub Repo"** y selecciona **el mismo repositorio otra vez**. Esto crea un segundo servicio dentro del mismo proyecto (uno para el backend, otro para el frontend).
2. Entra a este nuevo servicio → **"Settings"**.
3. **Root Directory**: `app/frontend`
4. **Builder**: elige **Dockerfile**. El proyecto trae `frontend/Dockerfile`, que compila
   con Node y sirve el resultado con **Nginx**.

   > **Por qué Dockerfile y no `npx serve dist -s -p $PORT`.** Esa era la instrucción
   > anterior y tenía dos problemas: `serve` **no está declarado como dependencia** del
   > proyecto, así que cada arranque dependía de que `npx` lo descargara del registro npm
   > —si el registro falla o cambia el paquete, el servicio no levanta—, y no es un
   > servidor pensado para producción. La imagen Nginx ya incluye el *fallback* de SPA,
   > sin el cual recargar el navegador en `/competencias` devuelve 404.

5. **Start Command**: déjalo **vacío**. La imagen ya sabe arrancar sola.

   > **Sobre el puerto:** Railway asigna un puerto en tiempo de ejecución con la
   > variable `PORT` y espera que el servicio escuche **ahí**. La imagen del
   > frontend ya lo obedece: su configuración de Nginx es una plantilla
   > (`nginx/default.conf.template`) que se completa al arrancar con el valor de
   > `PORT`. **No agregues una variable `PORT` a mano** — la pone Railway. Si el
   > servicio quedara con un puerto fijo, el enrutador de Railway no encontraría
   > nada escuchando y la página no cargaría, sin ningún error en los registros
   > que lo explicara.
6. Ve a **"Variables"** y agrega:

   | Nombre | Valor |
   |---|---|
   | `VITE_API_URL` | La dirección pública del backend que copiaste en el Paso 6.7 (ej. `https://tu-proyecto-production.up.railway.app`) |

   > **Importante: esta variable se aplica al CONSTRUIR, no al ejecutar.** Vite escribe
   > la dirección dentro de los archivos JavaScript en el momento de compilar. Si la
   > cambias después, **hay que volver a desplegar** (botón "Redeploy") para que tenga
   > efecto: cambiarla y reiniciar el servicio no modifica los archivos ya generados.
   > En Railway, marca la variable como disponible en build (*build variable*) para que
   > el Dockerfile la reciba como `--build-arg VITE_API_URL`.

7. Ve a **"Settings" → "Networking"** y haz clic en **"Generate Domain"** para este servicio también. Esta es la dirección que vas a compartir con los usuarios finales de la aplicación (clubes, delegados, etc.).

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
   > Hasta que esta variable esté puesta, **nadie podrá iniciar sesión**: el
   > backend rechazará las peticiones de la web por venir de un origen no
   > declarado. Es a propósito — sin esa lista, cualquier sitio de internet
   > podría usar la sesión de tus usuarios.
   >
   > Guarda y espera a que el backend se vuelva a desplegar.
8. Espera a que termine el despliegue (pestaña "Deployments", ícono verde).

---

## Paso 8 — Probar que todo funciona

1. Abre la dirección pública del **frontend** (la que generaste en el Paso 7.7) en tu navegador.
2. Deberías ver la pantalla de ingreso con el logo de la FCHMN.
3. Ingresa con el **nombre de usuario** y la contraseña que definiste en las variables `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` del Paso 6.
4. El sistema te pedirá cambiar la contraseña — hazlo y guarda la nueva en un lugar seguro.
5. Comparte la dirección del frontend con quien necesite usar el sistema.

---

## Actualizar la aplicación en el futuro

Cuando quieras subir cambios (por ejemplo, si te comparten una versión nueva del
proyecto):

1. Reemplaza los archivos en tu carpeta local por los nuevos.
2. En VS Code, ve al ícono de **Source Control**.
3. Vas a ver la lista de archivos que cambiaron. Escribe un mensaje corto describiendo el cambio (ej. "actualización") en el cuadro de texto de arriba.
4. Haz clic en el botón de **"Commit"** (el ✓) y luego en **"Sync Changes" / "Sincronizar cambios"**.
5. Railway detecta automáticamente el cambio en GitHub y vuelve a desplegar solo — no necesitas hacer nada más en Railway.

---

## Problemas comunes y solución

**El despliegue del backend falla con un error sobre la base de datos**
→ Revisa que la variable `DATABASE_URL` esté conectada por *referencia* al servicio de Postgres (Paso 6.6), no escrita a mano.

**El frontend carga pero el login da error de conexión**
→ Revisa que la variable `VITE_API_URL` del frontend (Paso 7.6) tenga exactamente la misma dirección pública que le asignaste al backend en el Paso 6.7, sin una `/` al final.

**Me quedé sin crédito gratis y la aplicación dejó de responder**
→ Es normal, Railway pausa los servicios cuando se acaba el crédito de prueba. Entra a Railway → **"Settings" del proyecto → "Billing"** y activa un plan de pago (desde US$5/mes) para reactivarlo. Tus datos no se pierden.

**No sé si el archivo `.env` se subió a GitHub por error**
→ Entra a tu repositorio en github.com y navega a la carpeta `backend`. Si ves un archivo llamado `.env` (no `.env.example`), bórralo desde ahí mismo (ícono de basurero al abrirlo) y cambia de inmediato las contraseñas/secretos que hayas usado, por seguridad.

**Quiero usar mi propio dominio (ej. www.mifederacion.cl) en vez de la dirección de Railway**
→ En el servicio del frontend, ve a **Settings → Networking → Custom Domain** y sigue las instrucciones que te muestra Railway (vas a necesitar acceso a la configuración DNS de tu dominio).
