# Instalación en tu computador (ambiente local)

**Para quién es esta guía:** para alguien que **no sabe programar**, pero que tiene
Visual Studio Code instalado y quiere dejar el Sistema de Gestión de Competencias
de Natación funcionando en su propio computador.

**Tiempo estimado:** 30-45 minutos la primera vez.

**No te preocupes si algo no funciona a la primera.** Al final de esta guía hay una
sección de "Problemas comunes y solución" — casi todo lo que puede fallar tiene una
solución de 2 líneas ahí.

---

## Antes de empezar: ¿qué vamos a instalar?

Vamos a instalar 2 programas (además de VS Code, que ya tienes) y luego vamos a
usar el propio VS Code para poner en marcha la aplicación. No necesitas entender
qué hace cada uno, solo seguir los pasos:

1. **Node.js** — el motor que ejecuta el código de la aplicación.
2. **Docker Desktop** — crea automáticamente la base de datos que la aplicación necesita, sin que tengas que instalarla ni configurarla a mano.

---

## Paso 1 — Instalar Node.js

1. Abre tu navegador y ve a **https://nodejs.org**
2. Vas a ver dos botones de descarga. Haz clic en el que dice **"LTS"** (es la versión recomendada y estable — no elijas la que dice "Current").
3. Se descargará un instalador. Ábrelo y haz clic en **Next / Siguiente** en todas las pantallas, dejando todas las opciones como vienen por defecto, hasta llegar a **Install / Instalar**.
4. Cuando termine, cierra el instalador.

**Verificar que quedó instalado:**

1. Abre Visual Studio Code.
2. En el menú de arriba, ve a **Terminal → New Terminal** (o presiona `` Ctrl+ñ `` en Windows, o `` Ctrl+` `` si tu teclado no tiene ñ).
3. Se abrirá un panel de texto en la parte de abajo. Ahí escribe exactamente esto y presiona Enter:
   ```
   node --version
   ```
4. Debería aparecer algo como `v22.x.x` (cualquier número está bien, mientras empiece con "v"). Si en cambio dice "no se reconoce el comando" o algo similar, cierra VS Code por completo, ábrelo de nuevo, y prueba otra vez — Windows a veces necesita reiniciar el programa para reconocer instalaciones nuevas.

---

## Paso 2 — Instalar Docker Desktop

Docker Desktop es el programa que va a crear automáticamente la base de datos.
No necesitas saber usarlo, solo tenerlo abierto en segundo plano.

1. Ve a **https://www.docker.com/products/docker-desktop/**
2. Descarga la versión para tu sistema operativo (Windows o Mac — el botón debería detectarlo solo).
3. Instala igual que cualquier programa: **Next / Siguiente** hasta el final. En Windows, es posible que te pida reiniciar el computador — hazlo si te lo pide.
4. Después de instalar (y reiniciar si correspondía), **abre la aplicación Docker Desktop** desde el menú de inicio. La primera vez puede tardar 1-2 minutos en arrancar. Sabrás que está listo cuando el ícono de la ballena 🐳 en la esquina de tu pantalla deje de moverse/cargar.

**Importante:** Docker Desktop debe estar **abierto** (aunque sea en segundo plano) cada vez que quieras usar la aplicación. Si lo cierras, la base de datos deja de estar disponible.

---

## Paso 3 — Obtener los archivos del proyecto

1. Descarga el archivo `Proyecto_Natacion.zip` que te compartieron.
2. Haz clic derecho sobre el archivo descargado y elige **"Extraer todo..."** (Windows) o simplemente ábrelo con doble clic (Mac). Esto va a crear una carpeta llamada `app` con todo el proyecto adentro. Muévela a un lugar donde la encuentres fácil, por ejemplo directo en el Escritorio, con el nombre `natacion`.
3. Abre Visual Studio Code.
4. Ve a **File / Archivo → Open Folder / Abrir Carpeta...**
5. Selecciona la carpeta `natacion` (la que extrajiste) y ábrela.

A la izquierda deberías ver dos carpetas principales: `backend` y `frontend`.

---

## Paso 4 — Configurar las contraseñas internas de la aplicación

La aplicación necesita una "llave secreta" interna para firmar las sesiones de
los usuarios. Vamos a generarla.

1. En VS Code, abre una terminal nueva (**Terminal → New Terminal**).
2. Copia y pega este comando, y presiona Enter:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
3. Va a aparecer una fila larga de letras y números, algo como `a1b2c3d4...`. **Cópiala** (selecciónala con el mouse y `Ctrl+C` / `Cmd+C`). Guárdala en algún lado por un momento (por ejemplo, pégala en el Bloc de Notas).

Ahora, en el panel izquierdo de VS Code:

5. Entra a la carpeta `backend`.
6. Busca el archivo llamado `.env.example`. Haz clic derecho sobre él → **Copy / Copiar**, luego clic derecho sobre la carpeta `backend` → **Paste / Pegar**. Esto crea una copia.
7. Renombra la copia (clic derecho → **Rename / Renombrar**) a exactamente: `.env`
8. Abre el archivo `.env` (doble clic) y modifica esta línea, reemplazando el texto de ejemplo por la fila de letras/números que generaste en el paso 3:
   ```
   JWT_ACCESS_SECRET="pega-aquí-la-fila-que-generaste"
   ```
9. Más abajo, en el mismo archivo, completa estas dos líneas, que vienen **vacías a propósito**. Son las credenciales con las que entrarás por primera vez:
   ```
   SEED_ADMIN_USERNAME="elige-un-nombre-de-usuario"
   SEED_ADMIN_PASSWORD="elige-una-contraseña"
   ```
   El usuario es un **nombre**, no un correo. La contraseña necesita **al menos 10 caracteres, con una mayúscula, una minúscula y un número**. Elige valores propios y anótalos: los vas a necesitar en el Paso 6.
10. Guarda el archivo (`Ctrl+S` / `Cmd+S`).

11. Busca también la línea `DATABASE_URL`. Dentro de esa dirección hay una contraseña de ejemplo (`CAMBIA_ESTA_CONTRASENA`). Reemplázala por una contraseña propia, usando **solo** letras, números y los signos `. _ ~ -`. Anótala: la necesitarás en el paso siguiente.

Aparte de esas líneas, no necesitas tocar ninguna otra del archivo `.env`.

---

## Paso 4.b — Poner esa misma contraseña donde la lee Docker

La base de datos y la aplicación tienen que usar **exactamente la misma** contraseña. La aplicación la lee de `backend/.env`; Docker la lee de otro archivo, en la carpeta principal del proyecto.

1. En el panel izquierdo de VS Code, ve a la carpeta **principal** del proyecto (la que contiene `backend`, `frontend` y `docker-compose.yml`).
2. Busca el archivo `.env.example` **de esa carpeta** (no el de `backend`). Haz clic derecho → **Copy / Copiar**, luego clic derecho sobre la misma carpeta → **Paste / Pegar**, y renombra la copia a exactamente: `.env`
3. Ábrelo y completa la línea con la **misma** contraseña del paso anterior:
   ```
   POSTGRES_PASSWORD=la-misma-contraseña-que-pusiste-en-DATABASE_URL
   ```
4. Guarda el archivo.
5. Comprueba que las dos coinciden. En la terminal, dentro de `backend`:
   ```
   npm run verificar:credencial
   ```
   Debe terminar con `COHERENCIA OK`. Si dice `COHERENCIA CON PROBLEMAS`, revisa que la contraseña sea idéntica en los dos archivos.

Si te saltas este paso, la base de datos no arrancará y verás un mensaje que dice `define POSTGRES_PASSWORD en el .env de la raiz`.

---

## Paso 5 — Encender la base de datos

1. En la terminal de VS Code, asegúrate de estar dentro de la carpeta `backend`. Si no lo estás, escribe:
   ```
   cd backend
   ```
2. Verifica que Docker Desktop esté abierto (revisa que el ícono de la ballena esté quieto, no cargando).
3. Escribe este comando y presiona Enter:
   ```
   docker compose -f ../docker-compose.yml -f ../docker-compose.dev.yml up -d postgres
   ```
4. Vas a ver varias líneas de texto — es normal, es Docker descargando y preparando la base de datos la primera vez (puede tardar 1-3 minutos). Cuando termine, volverás a ver el cursor esperando otro comando.

---

## Paso 6 — Instalar y preparar el backend (el "motor" de la aplicación)

Todavía dentro de la carpeta `backend`, ejecuta estos comandos **uno por uno**,
esperando que cada uno termine antes de escribir el siguiente:

```
npm install
```
*(instala todo lo que la aplicación necesita — tarda 1-2 minutos)*

```
npx prisma generate
```
*(prepara la conexión con la base de datos)*

```
npx prisma migrate deploy
```
*(crea todas las tablas aplicando las migraciones que ya vienen en el proyecto; no pregunta nada)*

```
npm run prisma:seed
```
*(carga los datos iniciales: roles, permisos, parámetros y catálogos — no crea usuarios)*

```
npm run seed:admin
```
*(crea el usuario administrador, una sola vez)*

Al terminar este último comando vas a ver un mensaje como:
```
Administrador inicial creado. Debe cambiar la contraseña en el primer ingreso.
```

**El usuario y la contraseña son los que definiste en el archivo `.env`**, en las líneas
`SEED_ADMIN_USERNAME` y `SEED_ADMIN_PASSWORD`. Es un **nombre de usuario, no un correo**.
Anótalos: son los que vas a usar para entrar por primera vez. El comando no los muestra
en pantalla a propósito.

Las dos líneas son **obligatorias**, también en tu computador: si las dejas vacías el
comando se niega a ejecutarse y te dice cuál falta. No hay usuario ni contraseña por
omisión, para que no exista ninguna instalación con credenciales previsibles.

---

## Paso 7 — Encender el backend

En la misma terminal (todavía dentro de `backend`), escribe:

```
npm run dev
```

Vas a ver un mensaje indicando que el servidor está escuchando. **Deja esta
terminal abierta** — si la cierras, la aplicación deja de funcionar. Vamos a
necesitar una segunda terminal para el siguiente paso.

---

## Paso 8 — Encender el frontend (lo que se ve en el navegador)

1. Abre una **segunda terminal** en VS Code: haz clic en el ícono `+` que está en la esquina superior derecha del panel de terminal (o **Terminal → New Terminal** de nuevo). Esto abre una terminal nueva sin cerrar la del backend.
2. En esta terminal nueva, escribe:
   ```
   cd frontend
   npm install
   ```
   *(espera a que termine, 1-2 minutos)*
3. Luego:
   ```
   npm run dev
   ```
4. Vas a ver un mensaje con una dirección como `http://localhost:5173/`.

---

## Paso 9 — Abrir la aplicación

1. Abre tu navegador (Chrome, Edge, etc.).
2. Ve a: **http://localhost:5173**
3. Deberías ver la pantalla de ingreso con el logo de la FCHMN.
4. Ingresa con el **nombre de usuario** y la contraseña que definiste en el `.env` (`SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`, Paso 6). No es un correo.
5. El sistema te va a pedir cambiar la contraseña de inmediato — es normal, es una medida de seguridad. Define una contraseña nueva y confírmala.
6. Listo — ya estás dentro del sistema.

---

## Uso diario (después de la primera vez)

Cada vez que quieras volver a usar la aplicación, **no necesitas repetir todos los pasos anteriores**. Solo:

1. Abre Docker Desktop y espera a que esté listo.
2. Abre VS Code, abre la carpeta del proyecto.
3. Abre una terminal, entra a `backend` (`cd backend`) y ejecuta `npm run dev`.
4. Abre una segunda terminal, entra a `frontend` (`cd frontend`) y ejecuta `npm run dev`.
5. Ve a `http://localhost:5173` en tu navegador.

Para **apagar todo**: simplemente cierra las terminales (o presiona `Ctrl+C` en cada una) y cierra Docker Desktop.

---

## Problemas comunes y solución

**"node no se reconoce como un comando"**
→ Cierra VS Code completamente (no solo la ventana, el programa entero) y vuelve a abrirlo. Si persiste, reinicia el computador — a veces Windows necesita esto tras instalar Node.js.

**"docker no se reconoce como un comando" / Docker no responde**
→ Asegúrate de que la aplicación Docker Desktop esté abierta y completamente cargada (ícono de ballena quieto). Si la acabas de instalar, reinicia el computador una vez.

**Error "port already in use" / "puerto ya está en uso" (3000 o 5173)**
→ Significa que ya hay algo corriendo en ese puerto — probablemente dejaste una terminal anterior abierta. Cierra todas las terminales de VS Code (papelera/basurero en cada una) y vuelve a intentar desde el Paso 7.

**La pantalla de login no carga / "no se puede conectar" en el navegador**
→ Revisa que ambas terminales (`backend` y `frontend`) sigan abiertas y sin mensajes de error en rojo. Si una se cerró, vuelve a ejecutar `npm run dev` en esa carpeta.

**Olvidé mi contraseña de administrador**
→ **Volver a ejecutar el Paso 6 no sirve** para esto, y tampoco borra nada: los
comandos de ese paso son repetibles a propósito, y `npm run seed:admin` detecta
que el administrador ya existe y **no lo modifica** (lo dice en pantalla: «ya
existe y es un administrador válido: no se modifica»). La aplicación no tiene
recuperación automática por correo, a propósito.

Los dos caminos que sí funcionan:

- Si hay **otro** usuario administrador con acceso, que restablezca tu contraseña
  desde la ficha de la persona o del club (el sistema genera una temporal y revoca
  tus sesiones activas).
- Si no queda ningún administrador con acceso, hay que restablecer la contraseña
  directamente en la base de datos: pide ayuda a quien te compartió el proyecto.

**Quiero cerrar todo y no dejar nada corriendo**
→ En cada terminal abierta, presiona `Ctrl+C`. Luego cierra Docker Desktop.
