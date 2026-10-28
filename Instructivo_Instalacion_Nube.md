# Instalación en la nube (para que quede disponible en internet, sin dejar tu computador prendido)

**Para quién es esta guía:** para alguien que **no sabe programar**, que ya tiene
Visual Studio Code, y que quiere que la aplicación quede funcionando en internet
de forma permanente — accesible desde cualquier computador, sin depender de que
tu computador esté prendido.

**Tiempo estimado:** 60-90 minutos la primera vez.

> ## ⚠️ Lee esto antes que nada: qué está probado y qué no
>
> **Nada de lo que ocurre dentro del panel de Render se ha ejecutado todavía.**
> No se creó ninguna cuenta, ningún servicio ni ninguna base de datos. Todos los
> pasos 4 en adelante están escritos a partir de la **documentación oficial de
> Render**, consultada el 28 de octubre de 2026, y pueden diferir en detalles de
> la interfaz (nombres de botones, orden de los campos).
>
> **Lo que sí está probado**, con las imágenes reales y contra una base de datos
> desechable, es todo lo que depende del repositorio: que las imágenes se
> construyen, que son las correctas, que las migraciones y los seeds funcionan y
> que la aplicación arranca y permite iniciar sesión. El detalle está en la
> sección «Qué se comprobó y qué no», al final.
>
> Si un paso del panel no coincide con lo que ves, **no improvises**: anótalo y
> consúltalo. Esta guía se corrige con lo que encuentres.

---

## Por qué Render y no Railway

La versión anterior de esta guía usaba **Railway**. Dejó de servir por dos
motivos, en este orden de importancia:

1. **Railway sufrió un incidente de seguridad el 21 de octubre de 2026** en el
   que un intruso pudo acceder a secretos de clientes, y pidió rotar
   credenciales. Este sistema va a guardar la contraseña de la base de datos, la
   llave que firma las sesiones y datos personales de nadadores (RUT, nombres,
   clubes).
2. **Railway tiene las altas de cuentas nuevas suspendidas** desde ese incidente
   —`Sign ups are currently disabled`— y su página de estado, al 27 de octubre,
   no da fecha de reapertura.

**Render** cumple lo mismo que necesitábamos de Railway y, en dos puntos, mejor:
permite elegir el archivo `Dockerfile` y el directorio de contexto desde el
panel, y permite **descargar** copias de seguridad de la base de datos.

> **El repositorio no impone ningún proveedor.** No hay archivos de configuración
> de Render, Railway ni ningún otro. Lo único que el código da por supuesto es
> que el proveedor inyecta la variable `PORT` y que hay que escuchar ahí. Render
> lo hace (por omisión `10000`) y además exige escuchar en `0.0.0.0`, que es
> justo lo que la aplicación ya hace.

---

## Lo que cuesta, con los números confirmados

Render cobra **dos cosas**: el plan del espacio de trabajo (*workspace*) y el
cómputo de cada servicio por separado.

**Plan del espacio de trabajo: Hobby, US$0 al mes.** Es suficiente: incluye
dominios propios, *point-in-time recovery* de 3 días, infraestructura como
código y hasta 25 servicios.

| Componente | Plan elegido | US$/mes |
|---|---|---|
| Espacio de trabajo | Hobby | **0** |
| API (backend), **servicio privado** | 0,5 CPU / 512 MB | **7** |
| Web (frontend), servicio web | 0,5 CPU / 512 MB | **7** |
| PostgreSQL | 256 MB RAM, 1 GB SSD incluido | **6** |
| Mantenimiento (cron job) | **mínimo mensual por servicio** | **1** |
| | **Total estimado** | **US$21** |

> **La corrección del cron job.** Su documentación dice: *«There is a minimum
> monthly charge of $1 per cron job service»*. El cobro por tiempo de ejecución
> es insignificante —US$0,00016 por minuto en el plan de 0,5 CPU—, pero **ese
> mínimo de US$1 se cobra igual aunque no se ejecute nunca**. Por eso está en la
> tabla como una línea fija y no como «céntimos».

**Lo que se cobra aparte si te pasas** (todas son holguras amplias para este uso):

| Concepto | Incluido en Hobby | Excedente |
|---|---|---|
| Almacenamiento de la base | **1 GB SSD** | US$0,30 por GB |
| Tráfico de salida | 5 GB al mes | US$0,15 por GB |
| Minutos de construcción | 500 al mes | US$5 por cada 1.000 |
| Dominios propios | 2 | US$0,25 por dominio al mes |
| Discos persistentes | — | US$0,25 por GB al mes (**este proyecto no usa ninguno**) |

> **Qué se puede abaratar para un ensayo, y qué no.** El plan **Free** existe
> para servicios web, PostgreSQL y Key Value, pero **no** para servicios
> privados ni para cron jobs. En esta configuración:
>
> | Componente | ¿Se puede ensayar en Free? |
> |---|---|
> | Web | Sí, pero **se apaga tras 15 min sin tráfico** y arrastra a la API, porque todo pasa por ella |
> | API | **No.** Es un servicio privado (Paso 6) y no hay versión gratuita |
> | PostgreSQL | Sí, pero **caduca a los 30 días**, 1 GB fijo y **sin ninguna copia de seguridad** |
> | Mantenimiento | **No.** Los cron jobs no admiten Free |
>
> Es decir: un ensayo cuesta como mínimo **US$8/mes** (la API y el cron job), y
> **Free no sirve para datos reales** en ningún caso.

---

## Sección 0 — Qué se preparó en el repositorio

**No necesitas hacer nada de esta sección.** Está aquí para que, si algo falla,
sepas dónde mirar. Si solo quieres desplegar, salta al Paso 1.

Las imágenes de este proyecto estaban hechas para construirse con
`docker compose`, que ofrece dos cosas que **ninguna** plataforma que construya
desde un repositorio Git ofrece. Las dos se resolvieron, y el entorno local con
Docker Compose sigue funcionando exactamente igual.

### Los avisos de licencias viajan dentro de cada contexto

Los avisos de terceros viven en `notices/`, en la raíz, pero los contextos de
construcción son `backend/` y `frontend/`, y una instrucción `COPY` no puede
salir de su contexto. Antes eso se resolvía con un contexto adicional con nombre
(`COPY --from=avisos`), que solo existe en `docker compose` y en `docker buildx`.

Ahora el subconjunto distribuible se copia a `backend/avisos/` y
`frontend/avisos/`, que sí están en contexto. `notices/` sigue siendo la única
fuente de verdad: `scripts/distribuir-avisos.mjs` mantiene las copias byte a
byte y, con `--verificar`, falla si divergen. Esa verificación corre en la
integración continua.

### Cada imagen sale de su propio archivo

`backend/Dockerfile` produce dos imágenes distintas: la que **sirve** la API
(`runtime`) y la que trae las herramientas de **migración y seeds** (`migrate`).
Construir un `Dockerfile` sin elegir etapa produce **la última**, y la última era
`migrate`: se habría desplegado el contenedor de migraciones en lugar de la API.

| Archivo | Termina en | Qué sale |
|---|---|---|
| `backend/Dockerfile` | `runtime` | la **API** |
| `backend/Dockerfile.mantenimiento` | `migrate` | las **herramientas de mantenimiento** |

El segundo **no se escribió a mano**: lo deriva
`scripts/generar-dockerfile-mantenimiento.mjs` del primero, añadiéndole una sola
etapa al final. Dos archivos independientes habrían divergido —un digest distinto
en uno— y entonces los avisos de licencias de ambas imágenes habrían dejado de
describir lo que se distribuye. La integración continua comprueba que no hayan
divergido.

**Esa etapa final hace algo más, y es importante:** sustituye el comando por
omisión de la imagen por un `echo`. Es decir, **la imagen de mantenimiento
ejecutada sin un comando explícito no hace nada y no toca la base de datos**. Es
lo que permite que el servicio programado del Paso 6.b sea inofensivo en reposo.

`docker compose` **no se ve afectado**: construye con `target: migrate` sobre el
archivo fuente, cuyo servicio de migraciones conserva `prisma migrate deploy`
como comando, exactamente como siempre.

### La web sirve también la API, bajo el mismo origen

El Nginx del frontend tiene un bloque `/api` que reenvía a la API por la red
privada del proveedor. Es lo que hace que el navegador vea **una sola
dirección**, y con ello desaparece el problema de las cookies de terceros.

Tres detalles que no son obvios y están resueltos en
`frontend/nginx/default.conf.template`:

- **La ruta de las cookies se reescribe.** La API las emite con `Path=/auth`,
  pero el navegador las ve bajo `/api/auth`, que no empieza por `/auth`: sin
  `proxy_cookie_path`, no las devolvería nunca y la sesión no se mantendría.
- **El límite de tamaño del cuerpo sube a 20 MB.** El de Nginx por omisión es
  1 MB, y la API acepta archivos de hasta 15 MB: sin esto, una importación
  mediana moriría con un 413 que la aplicación nunca vería.
- **El destino es una variable de Nginx, no un nombre fijo.** Así se resuelve el
  DNS en cada petición y la web sigue a la API cuando cambia de dirección al
  redesplegarse. Esa forma exige una directiva `resolver`, que
  `frontend/nginx/25-resolver.sh` escribe al arrancar leyendo `/etc/resolv.conf`.

La dirección de la API se configura con la variable `API_INTERNA`: **el nombre
del servicio no está escrito en ningún archivo del repositorio.**

### La API no puede migrar, y el mantenimiento no puede servir

La imagen de la API **a propósito no trae** el CLI de Prisma ni `tsx`: se
excluyen para que no viajen 46 MiB de herramientas en un servicio que solo sirve.
Y la imagen de mantenimiento **no trae `dist/`**: no puede atender peticiones.

Los tres comandos del mantenimiento, los únicos que existen, son:

```
prisma migrate deploy --schema=/app/prisma/schema.prisma
node dist-seed/prisma/seed.js
node dist-seed/prisma/seed-admin.js
```

**Nada de esto ocurre solo.** El arranque de la API no migra ni siembra, y el
seed del entorno de revisión visual —el que carga datos de prueba— **no existe
dentro de ninguna imagen**: `tsconfig.seed.json` compila únicamente `seed.ts` y
`seed-admin.ts`, y `backend/.dockerignore` excluye `prisma/seed-revision.ts`.

---

## Antes de empezar: ¿qué vamos a hacer?

1. Instalar **Git** *(ya hecho, si seguiste la guía anterior)*.
2. Crear una cuenta en **GitHub** *(ya hecho)*.
3. Subir el proyecto a GitHub *(ya hecho)*.
4. Crear una cuenta en **Render**.
5. Crear el proyecto y la base de datos PostgreSQL.
6. Configurar el servicio del **backend** (la API).
   - 6.b. Crear el servicio de **mantenimiento** y correr migraciones y datos iniciales.
7. Configurar el servicio del **frontend** (la web).
8. Comprobar que funciona.
9. Activar y practicar las **copias de seguridad**.
10. Saber cómo **volver atrás** si un despliegue sale mal.

**Arquitectura que resulta** (es la que el repositorio confirma, no una
suposición): **cuatro servicios** —PostgreSQL, la API, la web y el de
mantenimiento—.

**El navegador solo conoce UNA dirección: la de la web.** El Nginx que sirve la
web reenvía a la API todo lo que llegue a `/api`, por la red privada de Render.
Esa decisión es el eje de esta guía y resuelve de raíz el problema de las
cookies de terceros, que de otro modo impediría mantener la sesión abierta en
Safari y en cualquier navegador con el bloqueo activado.

```
navegador ──► web (Nginx)  ──┬──► archivos de la aplicación
                             └──► /api  ──► API ──► PostgreSQL
                                  (red privada, sin salida a internet)
```

**La API no tiene dirección pública.** Va como *Private Service*: el único
camino hasta ella es ese proxy. No es solo un detalle de orden — es lo que
impide que alguien falsee su dirección IP y anule el límite de intentos de
ingreso. El Paso 6 lo explica con las mediciones.

**Una sola instancia de la API.** El límite de tasa se cuenta *en la memoria del
proceso* (`RATE_LIMIT_GLOBAL_MAX`, `RATE_LIMIT_AUTH_MAX`), así que con dos o más
instancias el límite deja de valer lo que dice. No escales horizontalmente.

**Persistencia de archivos: no hace falta ninguna.** Se revisó el código del
backend y **no escribe archivos a disco** en ningún punto: las importaciones
(`.hyv`, Excel) se procesan en memoria con un límite de 15 MB por archivo, y los
PDF y Excel que genera se envían en la respuesta. El **único** dato que hay que
conservar es la base de datos. Por eso no se configura ningún disco persistente,
que además se cobraría aparte.

---

## Pasos 1 a 3 — Git, GitHub y el código subido

Si seguiste la versión anterior de esta guía, **ya está hecho**: el repositorio
`FCHMN_Inscripciones` está en GitHub, en la rama `main`.

**Una comprobación que ahora importa más.** El repositorio está configurado como
**público**, así que cualquiera puede leer su contenido y su historial completo.
Se revisaron las cuatro ramas y todo el historial y **no hay ningún secreto**:
solo las cuatro plantillas `.env.example`, con valores de relleno. Pero de aquí
en adelante no hay margen de error:

- **Nunca** subas un archivo `.env` real, un volcado de la base, un registro de
  despliegue ni una captura con variables a la vista.
- Si alguna vez ocurre, borrar el archivo **no lo quita del historial**: hay que
  rotar de inmediato los secretos afectados y pedir ayuda para limpiarlo.

A favor: en los repositorios públicos GitHub activa gratis el *escaneo de
secretos* y la *protección de empuje*, que bloquean un empujón que parezca
contener una credencial antes de que salga.

---

## Paso 4 — Crear una cuenta en Render

1. Ve a **https://render.com** y haz clic en **Get Started**.
2. Elige registrarte **con GitHub** — así Render puede leer tu repositorio.
3. Acepta los permisos que pida. Puedes darle acceso **solo** al repositorio
   `FCHMN_Inscripciones` en vez de a todos; es lo recomendable.
4. Cuando te pregunte por el plan del espacio de trabajo, elige **Hobby**
   (US$0 al mes).

> **🔑 Credenciales.** Aquí ingresas las de **tu cuenta de GitHub**, en la
> ventana de GitHub. No las escribas en ningún otro lado ni se las pases a nadie.
> Lo mismo valdrá para todas las contraseñas que definas más adelante.

> **💳 Dinero.** Crear la cuenta y el espacio Hobby no cuesta nada. El primer
> cobro aparece cuando creas un servicio con un plan de cómputo de pago. El
> **cron job del Paso 6.b es el único que no tiene plan Free**, así que es el
> primer US$1 que vas a gastar.

---

## Paso 5 — Crear el proyecto y la base de datos

1. En el panel de Render, crea un **Project** (proyecto) para agrupar todo. Llámalo, por ejemplo, `fchmn-inscripciones`.
2. Dentro del proyecto, haz clic en **New** → **Postgres**.
3. Rellena:
   - **Name**: `fchmn-postgres`
   - **Region**: elige una y **anótala**. Los demás servicios tienen que ir en
     la **misma región** para poder hablar por la red interna.
   - **PostgreSQL Version**: **16** (es la que usa el entorno local y contra la
     que se probaron las migraciones).
   - **Instance Type**: `256 MB RAM` (US$6/mes) para uso real, o **Free** si
     solo vas a ensayar — recordando que caduca a los 30 días y no tiene copias.
4. Créala y espera a que su estado pase a **Available**.

**Lo que vas a necesitar después:** en la página de la base, Render muestra dos
direcciones de conexión.

| | Para qué sirve |
|---|---|
| **Internal Database URL** | La que usan los otros servicios de Render en la misma región. **Es la que vamos a usar.** |
| **External Database URL** | Para conectarse desde fuera de Render. Solo la usarás para restaurar un respaldo (Paso 9). |

> **🔑 Las dos contienen la contraseña de la base.** Trátalas como una
> credencial: no las pegues en un correo, en un chat ni en un archivo del
> repositorio. En el Paso 6 no vas a copiarla a mano: Render permite enlazarla.

---

## Paso 6 — Configurar el servicio del backend (la API)

> ### 🔒 La API va como **Private Service**, no como Web Service
>
> Es la decisión de seguridad más importante de esta guía, y no es una
> precaución teórica: **está medida**.
>
> Un *Private Service* de Render **no recibe subdominio `onrender.com` y no es
> alcanzable desde internet**. Solo le hablan los otros servicios del proyecto,
> por la red privada. Como la web llega a la API por ese camino (Paso 7), la API
> no necesita dirección pública para nada.
>
> **Qué pasaría si la dejáramos pública.** La API confía en dos saltos de
> proxy (`TRUST_PROXY_HOPS=2`), porque ese es el recorrido real cuando se entra
> por la web. Pero alguien que entrara **directamente por la dirección pública
> de la API** solo tendría un proxy por delante, y ese salto de más se lo
> quedaría él: podría inventar su propia dirección IP con una cabecera
> `X-Forwarded-For`.
>
> *Comprobado en un entorno local que reproduce el recorrido:*
>
> | Camino | IP que queda auditada |
> |---|---|
> | Directo a la API, inyectando `203.0.113.66` | **`203.0.113.66`** — la inventada |
> | Por la web, a través del proxy | `198.51.100.9` — la real |
>
> *Y el efecto sobre el límite de tasa de `/auth`, que son 20 intentos por
> minuto y por IP:*
>
> | 30 intentos de ingreso | Procesados | Bloqueados |
> |---|---|---|
> | Directos, **rotando** la IP inventada | **30** | **0** |
> | Directos, con una IP fija | 20 | 10 |
> | Por el proxy, rotando la IP inventada | 20 | 10 |
>
> Es decir: con la API pública, **la protección contra el ensayo masivo de
> contraseñas se puede anular por completo** rotando una cabecera, y el registro
> de auditoría queda envenenado. Como servicio privado, ese camino no existe.
>
> **El esquema y el host no son un problema** por separado: se revisó el código
> y la aplicación no usa en ningún punto el protocolo ni el nombre de dominio de
> la petición. Lo único que depende de las cabeceras reenviadas es la IP.

1. En el proyecto, **New** → **Private Service**.
2. Conecta el repositorio `FCHMN_Inscripciones`, rama `main`.
3. Rellena la configuración:

   | Campo | Valor |
   |---|---|
   | **Name** | `fchmn-api` |
   | **Region** | **la misma** que la base de datos |
   | **Language** | **Docker** |
   | **Root Directory** | `backend` |
   | **Dockerfile Path** | `Dockerfile` |
   | **Docker Build Context Directory** | `.` |
   | **Instance Type** | `0.5 CPU / 512 MB` (US$7/mes) |

   > **Los *private services* no admiten plan Free.** El plan gratuito de Render
   > solo existe para servicios web, PostgreSQL y Key Value. Aquí **no hay
   > versión de ensayo**: son US$7/mes desde el primer día. El precio es el mismo
   > que el de un servicio web equivalente, así que **esto no cambia el
   > presupuesto**, solo quita la posibilidad de probar gratis esta pieza.
   >
   > Da igual: un servicio web Free tampoco habría servido, porque **los
   > servicios web gratuitos no reciben tráfico por la red privada**.

   > **No hay campo *Health Check Path*.** Render solo ofrece comprobaciones de
   > salud HTTP a los servicios web; a los privados les aplica una comprobación
   > TCP, que mira si el puerto está abierto y nada más. Es una pérdida real y
   > conviene saberla: Render **no** sabrá si la API responde mal, solo si está
   > escuchando. La comprobación de verdad la sigues teniendo a mano en
   > `/api/ready` (Paso 8), y la web sí conserva su propia comprobación HTTP.

   > **Estos tres campos son relativos al *Root Directory*.** Su documentación lo
   > dice expresamente: el comando de construcción, el de arranque, el previo al
   > despliegue, el *Dockerfile path* y el *Docker build context directory*
   > operan todos a partir de él. Por eso `Dockerfile` y `.` bastan, sin
   > prefijos.

   > **Deja vacío el *Docker Command*** (está en **Advanced**). La imagen ya sabe
   > arrancar sola (`node dist/server.js`). Poner algo ahí lo **reemplazaría**.

   > **Por qué `/health` y no `/ready`.** El proyecto expone las dos sondas a
   > propósito: `/health` responde sin consultar la base (vivacidad) y `/ready`
   > consulta PostgreSQL y devuelve **503** si no contesta. Render consulta la
   > ruta hasta recibir un 2xx antes de enviar tráfico al despliegue nuevo. Con
   > `/ready`, un despliegue perfectamente bueno fallaría solo porque la base
   > tardó en estar lista. Usa `/ready` a mano para diagnosticar (Paso 8).

4. **Variables de entorno.** Están verificadas contra
   `backend/src/shared/env.schema.ts`, que es lo que la aplicación valida **al
   arrancar**: si algo falta o está mal, el servicio **no levanta** y lo dice en
   los registros nombrando la variable.

   **Obligatorias — sin estas no arranca:**

   | Nombre | Valor |
   |---|---|
   | `DATABASE_URL` | **Enlazada, no escrita a mano.** Render ofrece añadir la base del proyecto; elige la **Internal Database URL** de `fchmn-postgres`. |
   | `JWT_ACCESS_SECRET` | Un valor propio de **al menos 32 caracteres** (ver abajo cómo generarlo). Se rechaza en producción si empieza por `reemplazar`, `replace`, `cambiar`, `change`, `example`, `ejemplo`, `secret` o `test`. |
   | `NODE_ENV` | `production` |
   | `CORS_ORIGINS` | La dirección pública del **frontend**, exacta y **sin barra final**. Se completa en el Paso 7, cuando ya exista. |

   **Necesarias para este despliegue:**

   | Nombre | Valor |
   |---|---|
   | `AUTH_COOKIE_SAMESITE` | `lax` (ver el recuadro de abajo) |
   | `TRUST_PROXY_HOPS` | `2` (ver el recuadro de abajo) |
   | `PORT` | `3000` |

   > **Por qué aquí sí se declara `PORT`.** En un servicio web, Render inyecta
   > `PORT` y enruta por él, y lo correcto es no tocarlo. En un **servicio
   > privado** no hay enrutador: la web se conecta al puerto que le digas. La
   > documentación de Render no describe el comportamiento de `PORT` para
   > servicios privados, así que lo fijamos nosotros y dejamos de depender de un
   > detalle no documentado. Este valor tiene que coincidir con el que pongas en
   > `API_INTERNA` (Paso 7).

   > ### Por qué `lax` y por qué `2`
   >
   > Las dos salen de la misma decisión: **el navegador accede a la web y a la
   > API desde el mismo origen**, porque el Nginx del frontend sirve la API en
   > `/api` (Paso 7). El recorrido real de una petición es:
   >
   > ```
   > navegador  →  borde de Render  →  Nginx del frontend  →  API
   > ```
   >
   > **`AUTH_COOKIE_SAMESITE=lax`**, porque con un solo origen la cookie de
   > sesión **no es una cookie de terceros**: no hay nada que un navegador pueda
   > bloquear. `lax` es además más seguro que `none`, porque el navegador no
   > manda la cookie en peticiones nacidas en otro sitio.
   >
   > **`TRUST_PROXY_HOPS=2`**, porque hay exactamente **dos** proxies por
   > delante: el borde de Render y el Nginx del frontend. Con ese número, la API
   > toma como dirección del usuario la que declaró el borde, y descarta
   > cualquier dirección que el propio cliente haya intentado inyectar. De ahí
   > dependen el registro de auditoría y el límite de tasa por IP.
   >
   > **Ni uno más ni uno menos.** Con `1`, la API creería que el usuario es el
   > Nginx del frontend: todas las IP de la auditoría serían la misma y el
   > límite de tasa sería común a todo el mundo. Con `3`, un cliente podría
   > inventar una IP y la API se la creería.
   >
   > *Comprobado en un entorno local que reproduce ese recorrido: con `2`, una
   > petición en la que el borde declara `190.44.12.77` queda auditada con esa
   > IP; y una en la que el cliente intenta colar `9.9.9.9` por delante queda
   > auditada igualmente con `190.44.12.77`, descartando la inventada.*

   **Deja estas SIN DEFINIR — ponerlas causa problemas:**

   | Nombre | Por qué |
   |---|---|
   | `AUTH_COOKIE_SECURE` | En producción se activa sola. Ponerla en `false` **detiene el arranque a propósito**: la cookie de sesión viajaría sin cifrar. |
   | `HOST` | Por omisión es `0.0.0.0`, que es lo que hace falta. **No la pongas en `127.0.0.1`**: el servicio quedaría inalcanzable incluso desde la red privada. |
   | `PUBLIC_API_URL` | Solo hace falta si publicas la documentación interactiva. |
   | `ENABLE_SWAGGER` | Sin definir, la documentación en `/docs` queda **apagada en producción**, que es lo correcto. Si la pones en `true`, `PUBLIC_API_URL` pasa a ser **obligatoria** o el arranque falla. |

   **Opcionales — tienen valor por omisión:** `JWT_ACCESS_EXPIRES_IN` (`15m`),
   `JWT_REFRESH_EXPIRES_IN_DAYS` (`7`), `LOGIN_MAX_ATTEMPTS` (`5`),
   `LOGIN_LOCKOUT_MINUTES` (`15`), `RATE_LIMIT_GLOBAL_MAX` (`300`),
   `RATE_LIMIT_AUTH_MAX` (`20`).

   **No pongas aquí `SEED_ADMIN_USERNAME` ni `SEED_ADMIN_PASSWORD`.** El servidor
   no las lee: las lee el comando que crea el administrador, en el Paso 6.b.
   Puestas aquí no harían nada y serían un secreto guardado donde no hace falta.

   **Para generar `JWT_ACCESS_SECRET`:** en VS Code, abre una terminal y ejecuta
   este comando una vez:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   > **⚠️ Cuidado con las variables y la construcción.** Render convierte
   > automáticamente las variables del servicio en *build arguments* disponibles
   > durante la construcción de la imagen, y su documentación advierte: **no
   > referencies en el `Dockerfile` ningún argumento con un valor sensible**,
   > porque quedaría dentro de la imagen. Los `Dockerfile` de este proyecto no lo
   > hacen —solo declaran `VITE_API_URL`, `NODE_VERSION` y los digests—, así que
   > no hay nada que cambiar. Pero si alguien añade un `ARG JWT_ACCESS_SECRET`,
   > estaría filtrando el secreto a la imagen.

   > ### El problema que este despliegue ya NO tiene
   >
   > Conviene saberlo, porque explica por qué la configuración es así.
   >
   > Si la web y la API estuvieran en direcciones distintas —que es lo que pasa
   > si cada una usa su propia dirección `…onrender.com`—, la cookie de sesión
   > sería una **cookie de terceros** para el navegador. Y hay navegadores que
   > las bloquean: Safari por omisión desde 2020, y cualquiera con el bloqueo
   > activado. El síntoma sería cruel: el usuario inicia sesión, entra, y al
   > recargar vuelve al login, sin ningún error que lo explique.
   >
   > *(Dos direcciones `…onrender.com` son sitios distintos de verdad:
   > `onrender.com` figura en la Public Suffix List, que es la lista con la que
   > los navegadores deciden qué cuenta como «mismo sitio».)*
   >
   > **El Paso 7 lo elimina de raíz**, no lo mitiga: el Nginx de la web sirve
   > también la API, bajo `/api`. El navegador ve **una sola dirección**, así
   > que no existe ninguna cookie de terceros y no hay nada que ningún
   > navegador pueda bloquear. Por eso aquí `AUTH_COOKIE_SAMESITE` va en `lax`
   > y no en `none`.

   > ### La protección CSRF: no hay que configurar nada
   >
   > La comprobación **está activa siempre**, con cualquier valor de
   > `AUTH_COOKIE_SAMESITE`. Funciona sola, pero conviene saber cómo por si algún
   > día aparece el mensaje *«Comprobación de seguridad fallida»*:
   >
   > 1. Al iniciar sesión —y en `GET /auth/csrf` tras recargar la página— la API
   >    devuelve un **código de un solo uso en el cuerpo de la respuesta**.
   > 2. La aplicación web lo guarda **en memoria** y lo reenvía en la cabecera
   >    `X-CSRF-Token` de cada operación de sesión.
   > 3. La API comprueba que coincida con el que guardó en una cookie propia.
   >
   > Un sitio malicioso puede provocar la petición, pero **no puede leer el
   > cuerpo de ninguna respuesta de la API** —`CORS_ORIGINS` se lo impide—, así
   > que nunca conoce el código.
   >
   > **Si ves ese mensaje**, casi siempre es que `CORS_ORIGINS` no coincide
   > exactamente con la dirección del frontend (sobra una barra final, o dice
   > `http` en vez de `https`).

5. **Build Filters**, para que un cambio en el frontend no reconstruya la API.
   En **Settings → Build & Deploy → Build Filters**, añade como *Included Path*:
   ```
   backend/**
   ```
   > Los *build filters* son siempre relativos a la **raíz del repositorio**,
   > aunque hayas puesto un *Root Directory*.

6. **Crea el servicio.** Render construirá la imagen y la desplegará. La primera
   vez tarda varios minutos.

   > **El primer despliegue va a quedar «sano» pero la aplicación no funcionará
   > todavía**, y es normal: faltan las tablas. Eso es el Paso 6.b.

7. **Anota la dirección INTERNA**, que es la que necesitarás en el Paso 7. Un
   servicio privado la muestra como su **Service Address**, y también está en el
   menú **Connect**. Con `PORT=3000` será algo como `fchmn-api:3000`.

   > **Este servicio no tiene dirección pública, y eso es el objetivo.** Render
   > no da subdominio `onrender.com` a los servicios privados. Si buscas una
   > dirección pública aquí y no la encuentras, está bien: no debe haberla.

---

## Paso 6.b — El servicio de mantenimiento (migraciones y datos iniciales)

Este es un **cuarto servicio**, en el mismo proyecto y desde el mismo
repositorio. No atiende peticiones y no tiene dirección pública. Existe porque
las herramientas de migración no viajan en la imagen de la API, y eso es
deliberado.

### Esto es un servicio PROGRAMADO. Dilo en voz alta.

En Render, el tipo de servicio que sabe «ejecutar un comando y terminar» es el
**Cron Job**, y **un cron job exige un calendario**. No existe un servicio que
solo se ejecute a mano: **este servicio se va a ejecutar solo, en la fecha que
le pongas, y eso no se puede desactivar.**

No vamos a fingir lo contrario con un truco de calendario. Lo que hacemos es que
**esa ejecución automática no pueda hacer daño**, porque lo que se ejecuta por
omisión no toca la base de datos.

> ### 🔒 La propiedad en la que se apoya todo
>
> **La imagen de mantenimiento, ejecutada sin un comando explícito, imprime una
> línea y termina bien, sin abrir ninguna conexión a la base de datos.**
>
> Está así por construcción: `backend/Dockerfile.mantenimiento` sustituye el
> comando por omisión por un `echo`. Migrar o sembrar **exige escribir el
> comando**, que es justo lo que debe ser un acto deliberado.
>
> *Comprobado: ejecutada sin red alguna y con `DATABASE_URL` definida, termina
> con código 0; el mismo contenedor con el comando de migraciones falla con
> `P1001: Can't reach database server`. Y ejecutada contra una base vacía, la
> deja con las mismas cero tablas.*

Sobre esa base se apoyan dos cosas más, en este orden:

1. **El comando por omisión de la imagen no toca la base.** Es la única capa que
   protege de verdad, y no depende de que nadie se acuerde de nada.
2. **El campo *Docker Command* se deja vacío en reposo**, para que se use ese
   comando por omisión. Si prefieres verlo escrito en el panel, puedes poner el
   `echo` a mano (más abajo se indica cómo); el efecto es el mismo.
3. **Cada ejecución real es un acto explícito**: escribir el comando, lanzarlo,
   leer el registro y **vaciar el campo otra vez**.

> **Lo que esto NO promete.** Si dejas un comando real escrito en el campo y el
> servicio se ejecuta —por el calendario, o por alguna otra causa que la
> documentación de Render no detalla—, ese comando se ejecutará. Por eso el
> último paso del procedimiento, vaciar el campo, no es opcional.
>
> Lo comprobado es más acotado: **la imagen, ejecutada sin comando, no toca la
> base**. Mientras el campo esté vacío, una ejecución inesperada es inofensiva.
> Mientras no lo esté, no lo es.

### Crear el servicio

1. En el proyecto, **New** → **Cron Job**.
2. Conecta el mismo repositorio, rama `main`.
3. Rellena:

   | Campo | Valor |
   |---|---|
   | **Name** | `fchmn-mantenimiento` |
   | **Region** | **la misma** que la base de datos |
   | **Language** | **Docker** |
   | **Root Directory** | `backend` |
   | **Dockerfile Path** | `Dockerfile.mantenimiento` |
   | **Docker Build Context Directory** | `.` |
   | **Instance Type** | `0.5 CPU / 512 MB` (los cron jobs **no** admiten Free) |
   | **Schedule** | `0 6 1 1 *` |
   | **Docker Command** (en *Advanced*) | **déjalo vacío** |

   > **`Dockerfile.mantenimiento` es lo único que distingue este servicio de la
   > API.** Los dos apuntan a la misma carpeta del mismo repositorio; lo que
   > cambia es qué archivo se construye.

   > **Sobre el calendario: `0 6 1 1 *` significa «el 1 de enero a las 06:00
   > UTC», una vez al año.** Es una expresión **válida y real**: ese día el
   > servicio **se va a ejecutar**, sin que nadie lo pida.
   >
   > Y no pasa nada, porque lo que se ejecutará es el comando por omisión de la
   > imagen, que solo imprime una línea. En el registro de ese día verás
   > exactamente eso y nada más.
   >
   > **Por qué una fecha real y no un truco.** Existe la costumbre de poner
   > fechas imposibles —el 30 de febrero— para que «nunca» se dispare. Es una
   > mala idea: depende de cómo interprete la expresión cada plataforma, no está
   > documentado que Render la acepte, y sobre todo **oculta** que el servicio es
   > programado, de modo que el día que alguien herede esto creerá que no puede
   > ejecutarse solo. Prefiero una fecha honesta y una ejecución inofensiva.
   >
   > Si prefieres otra cadencia, cualquiera sirve. Lo que no debe cambiar es que
   > el estado en reposo sea inofensivo.

4. **Docker Command: déjalo vacío.**

   Vacío, Render ejecuta el comando por omisión de la imagen, que es el `echo`
   inofensivo. No hay nada que escribir ni que recordar.

   > **Esto es nuevo, y es la diferencia con cualquier versión anterior de esta
   > guía.** Antes, el comando por omisión de esta imagen era
   > `prisma migrate deploy`, así que dejar el campo vacío significaba «migra en
   > cada ejecución programada». Ahora el archivo `Dockerfile.mantenimiento`
   > sustituye ese comando por omisión, y **vacío es el estado seguro**.

   > **Si prefieres verlo escrito en el panel**, puedes poner a mano:
   > ```
   > echo "Mantenimiento en reposo: sin accion."
   > ```
   > Escríbelo **así**, sin `/bin/sh -c` delante. Se probó en la imagen real:
   > `/bin/sh -c echo "…"` **imprime una línea vacía** —el texto se toma como
   > nombre del programa, no como argumento de `echo`—, con lo que el registro no
   > diría nada. La forma de arriba funciona tanto si Render ejecuta el comando
   > directamente como si lo pasa por un shell, porque `echo` existe como
   > programa en la imagen. Si tu panel exigiera un shell, la forma correcta es
   > `/bin/sh -c 'echo "Mantenimiento en reposo: sin accion."'`, **con comillas
   > simples alrededor de todo**.

5. **Variables de entorno.** Solo estas tres:

   | Nombre | Valor |
   |---|---|
   | `DATABASE_URL` | **Enlazada** a `fchmn-postgres` (Internal Database URL), igual que en el Paso 6 |
   | `SEED_ADMIN_USERNAME` | El **nombre de usuario** del administrador (no es un correo), p. ej. `admin.fchmn` |
   | `SEED_ADMIN_PASSWORD` | Una contraseña propia y secreta: **mínimo 10 caracteres, con mayúscula, minúscula y número** |

   > **🔑 Estas dos credenciales son obligatorias y no tienen valor por omisión.**
   > Si falta cualquiera —o queda **definida pero vacía**, que cuenta como
   > ausente—, el comando que crea el administrador **se niega a ejecutarse** y
   > dice cuál falta. *(Comprobado: termina con código de salida 1.)* Elige
   > valores propios, no los copies de ninguna plantilla, y **no los escribas en
   > ningún chat ni correo**. La variable se llama `SEED_ADMIN_USERNAME`;
   > `SEED_ADMIN_EMAIL` no existe. El comando **no imprime** el usuario, la
   > contraseña ni su hash: la salida de un despliegue queda registrada.

6. **Auto-Deploy: ponlo en `Off`** (**Settings**, sección *Auto-Deploy*). Las
   opciones son `On Commit` (la de fábrica), `After CI Checks Pass` y `Off`.

   > **Por qué `Off` aquí y no en los otros servicios.** Este servicio no sirve
   > tráfico: no necesita estar al día con cada empujón. Con `Off`, nada de lo que
   > pase en GitHub lo toca, y tú decides cuándo reconstruirlo —antes de un
   > mantenimiento que use código nuevo, con **Manual Deploy**—. Es una
   > protección documentada, a diferencia de suspender el servicio, que la
   > documentación de Render no explica para cron jobs y que por eso esta guía
   > no usa.

7. **Build Filters**: *Included Path* `backend/**`. (Con `Auto-Deploy: Off` es
   redundante, pero no estorba si algún día lo vuelves a encender.)

### El procedimiento de mantenimiento

**Cada ejecución sigue estos seis pasos. Sin saltarse ninguno.**

1. **Confirma contra qué base vas a trabajar.** En **Environment**, que
   `DATABASE_URL` esté **enlazada a `fchmn-postgres`** y no escrita a mano.
2. Ve a **Settings** y escribe en **Docker Command** el comando que toca.
3. Guarda.
4. Ve a la pestaña **Runs** y pulsa **Trigger Run**.
5. **Lee el registro**: confirma primero **qué comando se ejecutó** y después el
   mensaje de éxito que se indica abajo.
6. **Vuelve a Settings y vacía el campo Docker Command.**

> **El paso 6 no es opcional.** Mientras un comando real esté escrito ahí, una
> ejecución programada lo ejecutaría. Vacíalo en cuanto termines, y compruébalo.

> ### Cuidado: guardar un cambio puede desencadenar un despliegue
>
> Esto está documentado para las **variables de entorno**: al guardarlas, Render
> *«kicks off a deploy»* **salvo que elijas la opción «Save only»**, que las
> guarda sin desplegar. Si alguna vez cambias `SEED_ADMIN_PASSWORD` o
> `DATABASE_URL` aquí, usa **Save only** si no quieres que se reconstruya en ese
> momento.
>
> **Para el campo *Docker Command*, la documentación de Render no dice** si
> guardarlo dispara un despliegue, ni si un despliegue de un cron job provoca una
> ejecución. Se buscó expresamente y **no hay respuesta oficial**. Indicios de
> terceros sugieren que un despliegue no inicia una ejecución, pero **no son
> documentación y esta guía no se apoya en ellos**.
>
> **Qué significa en la práctica, dicho sin adornos:** entre el momento en que
> guardas un comando real (paso 3) y el momento en que lo vacías (paso 6), **ese
> comando podría ejecutarse sin que tú pulses nada**. No es una hipótesis
> descartada: es una incógnita. Los tres comandos son, por suerte, tolerables en
> ese escenario —migrar lo ya migrado no hace nada, el seed de referencia es
> idempotente y el de administrador no modifica uno existente—, pero **eso no es
> lo mismo que decir que no puede pasar nada**.
>
> Por eso: ten la ventana abierta, haz los pasos 3 a 6 seguidos, y en el paso 5
> mira **cuántas ejecuciones** aparecen en la pestaña *Runs*, no solo la última.
>
> **PENDIENTE DE COMPROBAR EN EL PRIMER ENSAYO.** Guarda un cambio del *Docker
> Command* y anota si aparece un despliegue, si aparece una ejecución, y en qué
> orden. Es el dato que falta para cerrar este punto, y esta guía se corrige con
> él.

**Los tres comandos, en este orden.** Son los únicos que existen en esta imagen.

**1) Aplicar las migraciones** (crea y actualiza las tablas):
```
prisma migrate deploy --schema=/app/prisma/schema.prisma
```
Termina diciendo `All migrations have been successfully applied.`

**2) Sembrar los datos de referencia** (roles, permisos, parámetros y catálogos).
Es **idempotente**: se puede repetir sin problema y **no crea usuarios**.
```
node dist-seed/prisma/seed.js
```

**3) Crear el administrador inicial. Una sola vez.**
```
node dist-seed/prisma/seed-admin.js
```
Termina diciendo `Administrador inicial creado. Debe cambiar la contraseña en el
primer ingreso.` Si el administrador ya existe, el comando lo detecta y **no lo
modifica** —lo dice: *«ya existe y es un administrador válido: no se modifica»*—,
así que una ejecución accidental no rompe nada.

> **Si una migración o un seed termina con ERROR, no sigas:** corrige la causa y
> repite el paso. Y **no uses la API** hasta que el comando 1 haya terminado
> bien: sin tablas, todo falla.

> **La alternativa rigurosa, si alguna vez quieres eliminar hasta el último
> resquicio.** Render ofrece **one-off jobs**: procesos de una sola vez que usan
> la última construcción de un servicio existente y reciben el comando en la
> propia invocación. Con ellos el *Docker Command* del cron job **nunca** cambia
> —se queda inocuo para siempre— y el riesgo de calendario desaparece por
> construcción. El inconveniente es que **solo se crean por la API de Render**,
> con una clave de API y un comando en terminal, así que no encaja con el
> objetivo de administrar esto sin programar. Queda documentado por si en algún
> momento hay alguien que pueda hacerlo así.

> **Por qué son tres comandos y no uno.** Antes el arranque del servicio sembraba
> todo en cada reinicio, incluida la creación del administrador. Eso mezclaba
> operaciones repetibles con una que no lo es, y hacía que un despliegue sin
> variables definidas creara en silencio una cuenta con credenciales conocidas.

---

## Paso 7 — Configurar el servicio del frontend (la web)

1. En el proyecto, **New** → **Web Service**, mismo repositorio y rama.
2. Rellena:

   | Campo | Valor |
   |---|---|
   | **Name** | `fchmn-web` |
   | **Region** | la misma |
   | **Language** | **Docker** |
   | **Root Directory** | `frontend` |
   | **Dockerfile Path** | `Dockerfile` |
   | **Docker Build Context Directory** | `.` |
   | **Instance Type** | `0.5 CPU / 512 MB`, o **Free** para ensayar |
   | **Health Check Path** | `/` |

   > **Este servicio no necesita `Dockerfile Path` especial.** La última etapa de
   > `frontend/Dockerfile` ya es la correcta (la de Nginx). El segundo archivo
   > existe solo en `backend/`, que produce dos imágenes distintas.

   > **Deja vacío el *Docker Command*.** La imagen ya sabe arrancar sola.

   > **Sobre el puerto:** Render inyecta `PORT` y espera que el servicio escuche
   > ahí. La imagen del frontend ya lo obedece: su configuración de Nginx es una
   > plantilla (`nginx/default.conf.template`) que se completa al arrancar con el
   > valor de `PORT`. **No agregues una variable `PORT` a mano.**

3. **Variables de entorno**, dos, y las dos importan:

   | Nombre | Valor |
   |---|---|
   | `VITE_API_URL` | `/api` |
   | `API_INTERNA` | La **dirección interna** de la API, con su puerto: `fchmn-api:3000` |

   > ### Estas dos variables son el corazón de la configuración
   >
   > Hacen que **el navegador vea una sola dirección**. La web pide la API a
   > `/api/…`, que es su propio origen; este Nginx recoge esa petición y la
   > reenvía por la **red privada** de Render al servicio de la API. El
   > navegador nunca habla con la API directamente, así que no hay cookies de
   > terceros y no hay nada que pueda bloquear.
   >
   > **`VITE_API_URL=/api`** se aplica al **CONSTRUIR**, no al ejecutar: Vite
   > escribe ese valor dentro de los archivos JavaScript al compilar. Si la
   > cambias después, **hay que volver a desplegar**. No hace falta marcarla de
   > ninguna forma especial: Render convierte las variables del servicio en
   > *build arguments*, y `frontend/Dockerfile` ya declara `ARG VITE_API_URL`.
   >
   > **`API_INTERNA`** se aplica al **ARRANCAR**. Su valor lo da Render: es la
   > **Service Address** del servicio privado de la API, y el puerto es el que
   > fijaste con `PORT` en el Paso 6 (`3000`). Si Render te muestra algo
   > distinto, usa lo que te muestre.
   >
   > El nombre del servicio **no está escrito en ningún archivo del
   > repositorio**: vive solo en esta variable. Si algún día renombras la API,
   > se cambia aquí y basta.

   > ### Requisitos de la red privada — léelos antes
   >
   > - **La API y la web deben estar en la MISMA región y el MISMO espacio de
   >   trabajo.** Es lo que Render exige para que compartan red privada.
   > - **La API está en un plan de pago**, porque los *private services* no
   >   admiten Free (Paso 6). La web sí podría estar en Free para un ensayo, pero
   >   entonces se apagaría por inactividad y arrastraría a la API con ella,
   >   porque todo el tráfico pasa por aquí.
   > - **La API no tiene dirección pública en absoluto.** Es un servicio
   >   privado: el único camino hasta ella es este proxy. Esa es la razón por la
   >   que `TRUST_PROXY_HOPS=2` es seguro (ver el recuadro del Paso 6).

4. **Build Filters**: *Included Path* `frontend/**`.

5. **Crea el servicio** y anota su dirección pública (p. ej.
   `https://fchmn-web.onrender.com`). **Esta es la que compartirás con los
   usuarios finales.**

6. **Ahora vuelve a la API y completa `CORS_ORIGINS`.** Entra a `fchmn-api` →
   **Environment**, y pon ahí esa dirección **exactamente** como aparece, con
   `https://` y **sin barra final**:

   | Bien | Mal |
   |---|---|
   | `https://fchmn-web.onrender.com` | `https://fchmn-web.onrender.com/` (barra final) |
   | | `http://fchmn-web.onrender.com` (http en vez de https) |
   | | `fchmn-web.onrender.com` (sin esquema) |

   La aplicación valida el formato al arrancar y **rechaza** un origen con ruta
   final. Hasta que esta variable esté puesta, **nadie podrá iniciar sesión**.
   Guarda y espera a que la API se vuelva a desplegar.

---

## Paso 8 — Comprobar que todo funciona

En este orden; cada comprobación supone que la anterior pasó.

**Todas las direcciones son la de la WEB.** Es lo propio de esta configuración:
la API se alcanza por `/api` del mismo sitio, así que no hay una segunda
dirección que comprobar. Sustituye `fchmn-web.onrender.com` por la tuya.

**1) La web carga.** Abre la dirección del frontend. Deberías ver la pantalla de
ingreso con el logo de la FCHMN.

**2) El *fallback* de SPA funciona.** Escribe directamente una ruta interna:
```
https://fchmn-web.onrender.com/competencias
```
Debe cargar la aplicación (y pedirte ingresar), **no** un 404 de Nginx.

**3) El proxy llega a la API.** Esta es la comprobación propia de esta
configuración, y la primera que falla si algo está mal:
```
https://fchmn-web.onrender.com/api/health
```
Debe responder algo como `{"status":"ok","uptime":12}`.

- **502 o 504** → el proxy no alcanza la API. Revisa `API_INTERNA` (nombre y
  puerto exactos, los del menú **Connect → Internal** de la API), que ambos
  servicios estén en la **misma región**, y que la API sea un **Private
  Service** en marcha (su *Service Address* y su `PORT` deben coincidir con
  `API_INTERNA`).
- **404 con el aspecto de una página de Nginx** → la petición no entró al
  bloque `/api/`; revisa que la ruta lleve la barra final del prefijo.

**4) La API alcanza la base de datos.**
```
https://fchmn-web.onrender.com/api/ready
```
Debe responder `{"status":"ready","database":"ok"}`. Si devuelve **503** con
`"database":"unreachable"`, la API está viva pero no habla con PostgreSQL:
revisa que `DATABASE_URL` esté **enlazada** y que ambos estén en la misma región.

**5) La documentación está apagada.**
```
https://fchmn-web.onrender.com/api/docs
```
Debe devolver **404**. Si responde, `NODE_ENV` no es `production` o alguien puso
`ENABLE_SWAGGER=true`.

**6) Se puede iniciar sesión.** Con el **nombre de usuario** y la contraseña que
definiste en `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`. No es un correo.
- Si falla con error de conexión o de seguridad, el sospechoso es `CORS_ORIGINS`
  o `VITE_API_URL`.
- Si dice que las credenciales no existen, falta ejecutar el comando 3 del Paso 6.b.

**7) Cambia la contraseña.** El sistema te la pedirá en el primer ingreso.
Guárdala en un lugar seguro.

**8) La sesión sobrevive a una recarga.** Con la sesión abierta, pulsa **F5**.
Debes seguir dentro. Si vuelves a la pantalla de ingreso, la cookie de sesión no
se está guardando: revisa la reescritura de `Path` (recuadro del Paso 7).

**9) La misma prueba en Safari**, o en un navegador con el bloqueo de cookies de
terceros activado (Brave, un modo privado, un perfil con protección reforzada).

**Debería seguir funcionando**, porque con el proxy la cookie **no es de
terceros**: web y API comparten origen y no hay nada que bloquear. Esta prueba
ya no busca un fallo previsible, sino **confirmar que el proxy hace lo que se
espera** en el navegador más estricto.

> **Si no tienes a mano un Mac o un iPhone**, actívalo a propósito en Chrome:
> *Configuración → Privacidad y seguridad → Cookies de terceros → Bloquear*.

Si aun así te expulsa, el proxy no está sirviendo la API desde el mismo origen:
comprueba en las herramientas de desarrollo (pestaña **Red**) que las llamadas
van a `…/api/…` de **tu misma dirección**, y no a una dirección `…onrender.com`
distinta. Si van a otra, `VITE_API_URL` no quedó en `/api` al construir.

**10) Una descarga y una importación.** Entra a una ficha de personas y descarga
la **plantilla de carga masiva**; luego intenta importar un archivo de varios
MB. Son las dos operaciones que pasan por el proxy con un cuerpo o una respuesta
grandes, y las que delatarían un límite mal puesto (un `413` al subir, o una
descarga cortada a medias).

**11) Recién entonces, comparte la dirección del frontend.**

---

## Paso 9 — Copias de seguridad

Render ofrece **dos mecanismos distintos**, y conviene no confundirlos porque
protegen de cosas distintas.

### A. Recuperación a un punto en el tiempo (PITR) — automática

Render **respalda continuamente** las bases de pago y permite restaurarlas a un
momento concreto del pasado. **No hay que activarla**, pero sí conocer su límite:

| Plan del espacio de trabajo | Ventana de recuperación |
|---|---|
| **Hobby** | los últimos **3 días** |
| Pro o superior | los últimos **7 días** |

**Las bases en plan Free no tienen PITR en absoluto.**

**Para restaurar:** en la página **Recovery** de la base → sección *Point-in-Time
Recovery* → **Restore Database**. Render **crea una instancia nueva** con el
estado de ese momento; la original **no se toca**. Eso te deja comprobar la copia
antes de cambiar nada. Si está bien, apuntas los servicios a la nueva; si no, la
borras y pruebas con otra hora. No puedes restaurar a un momento de los últimos
diez minutos.

### B. Respaldo lógico descargable — tu copia fuera de Render

Esto es lo que resuelve el hueco que esta guía tenía abierto: **una copia que no
vive en el proveedor**.

**Crear y descargar:**

1. Página **Recovery** de la base → **Create export**.
2. Cuando esté listo aparece en la tabla de esa misma página, como un archivo
   comprimido `.dir.tar.gz` con la fecha en el nombre (p. ej.
   `2026-10-28T19_21Z.dir.tar.gz`).
3. Pulsa el enlace de descarga y guárdalo en tu computador.

> **Render los conserva solo 7 días**, en cualquier plan. Si no lo descargas,
> desaparece. Y **no genera respaldos lógicos para bases en plan Free**.

**Custodia — qué hacer con el archivo descargado:**

- **Contiene todos los datos personales del sistema**: RUT, nombres, clubes,
  inscripciones. Trátalo como el documento más sensible que maneja la federación.
- Guárdalo en **al menos dos sitios** y que uno **no** sea tu computador: un
  disco externo, o el almacenamiento en la nube de la federación con la carpeta
  restringida a quien corresponda.
- **No lo subas al repositorio** ni lo mandes por correo o chat.
- **Ponle fecha en el nombre** y mantén una cadencia: uno antes de cada
  actualización con migraciones, y uno mensual que se conserve.
- Decide y escribe **cuánto tiempo** se conservan y **quién** puede acceder.

**Restaurar un respaldo descargado.** Lee esto antes:

> **El procedimiento borra y recrea los objetos de la base de destino.** No lo
> uses sobre una base con datos importantes del mismo esquema. Si lo que quieres
> es recuperar datos perdidos, usa **PITR** (opción A): casi siempre recupera
> información más reciente que tu última exportación.

1. Descarga el `.dir.tar.gz` desde la página **Recovery**.
2. Consigue la **External Database URL** de la base de destino.
3. Descomprime y restaura. Como tienes Docker Desktop, puedes hacerlo **sin
   instalar nada**, desde la carpeta donde dejaste el archivo:

   ```
   tar -zxvf 2026-10-28T19_21Z.dir.tar.gz
   ```

   ```
   docker run --rm -v "${PWD}:/respaldo" postgres:16-alpine pg_restore --dbname="PEGA_AQUI_LA_EXTERNAL_DATABASE_URL" --verbose --clean --if-exists --no-owner --no-privileges --format=directory "/respaldo/2026-10-28T19:21Z/NOMBRE_DE_LA_BASE"
   ```

   > **🔑 Ese comando lleva la contraseña de la base dentro de la URL.** No lo
   > guardes en un archivo ni lo pegues en ningún chat. Bórralo del historial de
   > la terminal cuando termines.

   > **Si `tar` no te funciona**, descomprime con la misma imagen, sin instalar
   > nada: `docker run --rm -v "${PWD}:/respaldo" postgres:16-alpine tar -zxvf /respaldo/2026-10-28T19_21Z.dir.tar.gz -C /respaldo`
   >
   > *Comprobado: la imagen `postgres:16-alpine` trae `pg_restore` 16.15,
   > `pg_dump` y `tar`.*

4. Comprueba la aplicación antes de dar por buena la restauración (Paso 8).

**Practica esto una vez, antes de que haya datos reales.** Un respaldo que nunca
se restauró no es un respaldo: es un archivo.

---

## Paso 10 — Si el despliegue falla: cómo recuperar el servicio

**El despliegue nuevo falló o rompió algo → *Rollback*.**
En la página del servicio, en su lista de despliegues, puedes volver a un
despliegue anterior. El plan Hobby **conserva los 5 últimos**.

**Quieres repetir el último intento → *Redeploy*.**
Vuelve a construir desde el mismo código.

**El servicio no arranca.** Mira los registros del despliegue. Si el problema es
la configuración, la API lo dice explícitamente nombrando la variable:
`Configuración inválida. Revise las variables de entorno:` seguido de la lista.

**Perdiste o corrompiste datos → PITR o un respaldo descargado** (Paso 9).

> **Un rollback no deshace una migración.** Si el fallo fue en
> `prisma migrate deploy`, volver atrás la imagen **no deshace** lo que la
> migración ya escribió en la base. Ese caso se resuelve con PITR a un momento
> anterior a la migración, y por eso el Paso 9 va antes que cualquier
> actualización.

---

## Actualizar la aplicación en el futuro

1. **Primero, crea y descarga un respaldo** (Paso 9B), sobre todo si la versión nueva trae migraciones.
2. Reemplaza los archivos en tu carpeta local por los nuevos.
3. En VS Code, **Source Control** → mensaje corto → **Commit** → **Sync Changes**.
4. Render detecta el cambio y vuelve a desplegar los servicios cuyos *build filters* coincidan.
5. **Si la versión nueva trae migraciones**, ejecútalas con el comando 1 del Paso 6.b. El arranque de la API **no migra solo**, a propósito. El comando 3 —el administrador— **no se repite nunca**.
6. Comprueba con el Paso 8. Si algo salió mal, Paso 10.

> **Si cambian los avisos de licencias**, hay que redistribuirlos antes de subir:
> `node scripts/distribuir-avisos.mjs`. La integración continua lo comprueba y
> falla si las copias quedaron desactualizadas.

---

## Problemas comunes y solución

**La construcción falla en una línea `COPY avisos/…`**
→ Falta la copia de los avisos dentro del contexto. En tu computador ejecuta
`node scripts/distribuir-avisos.mjs` y sube el resultado a GitHub.

**El servicio de la API construye bien, pero «arranca y termina» sin servir nada**
→ Se construyó la imagen de mantenimiento. Revisa que `fchmn-api` tenga
**Dockerfile Path** = `Dockerfile`, no `Dockerfile.mantenimiento`.

**El servicio de mantenimiento levanta una API en vez de ejecutar el comando**
→ Lo contrario: su **Dockerfile Path** debe ser `Dockerfile.mantenimiento`.

**El cron job se ejecutó solo**
→ **Es lo esperado**: es un servicio programado y el calendario lo dispara una
vez al año. Abre el registro de esa ejecución y mira **qué comando corrió**. Si
dice `Mantenimiento en reposo: sin accion.`, no pasó nada y no hay nada que
hacer. Si corrió otra cosa, significa que **no se vació el campo *Docker Command*
tras el último mantenimiento**: es el paso 6 del procedimiento. Vacíalo ahora y
comprueba en qué estado quedó la base.

**Tras iniciar sesión, al recargar vuelvo a la pantalla de ingreso**
→ El navegador no está devolviendo la cookie de sesión. Con el proxy, la causa
más probable es la **ruta** de la cookie: en las herramientas de desarrollo,
pestaña **Red**, mira la respuesta del login y comprueba que `Set-Cookie` diga
`Path=/api/auth`. Si dice `Path=/auth`, falta la reescritura `proxy_cookie_path`
en la plantilla de Nginx, y la cookie nunca se enviará de vuelta.
→ Comprueba también que las llamadas van a `…/api/…` **de tu misma dirección**.
Si van a otra dirección `…onrender.com`, `VITE_API_URL` no quedó en `/api` al
construir y vuelves a tener cookies de terceros.

**La web carga pero todo da error 502 o 504**
→ El proxy no alcanza la API. Las tres causas, por orden de frecuencia:
`API_INTERNA` con un nombre o puerto equivocado (cópialos del menú **Connect →
Internal** de la API); los dos servicios en **regiones distintas**; o la **API en
plan Free**, que no recibe tráfico por la red privada.

**Una importación falla con «413» o «Request Entity Too Large»**
→ El archivo supera el límite del proxy (20 MB). La API acepta hasta 15 MB, así
que un archivo entre 15 y 20 MB lo rechazará la aplicación con su propio
mensaje, y por encima de 20 MB lo corta Nginx. Si de verdad hacen falta archivos
mayores, hay que subir los dos límites, no solo uno.

**Después de redesplegar la API, la web da 502 un rato**
→ Es esperable mientras la API arranca. Si persiste más de un minuto, mira los
registros de la API: lo más probable es que no esté arrancando (ver la entrada
de variables con errores).

**El despliegue de la API falla con un error sobre la base de datos**
→ Revisa que `DATABASE_URL` esté **enlazada** a `fchmn-postgres`, no escrita a
mano, y que ambos estén en la **misma región**.

**La API no arranca y los registros listan variables con errores**
→ Es la validación de configuración, que falla a propósito en vez de levantar mal
configurado. Los casos más frecuentes: `CORS_ORIGINS` vacía en producción,
`CORS_ORIGINS` con barra final, `AUTH_COOKIE_SECURE=false` en producción, y
`JWT_ACCESS_SECRET` demasiado corto o con aspecto de valor de ejemplo.

**El frontend carga pero el login da error de conexión**
→ `VITE_API_URL` debe tener exactamente la dirección de la API, sin `/` final — y
**hay que volver a desplegar** el frontend después de cambiarla.

**Aparece «Comprobación de seguridad fallida» al iniciar sesión**
→ Casi siempre `CORS_ORIGINS` no coincide exactamente con la dirección de la web.

**La sesión se cierra sola en cada recarga**
→ Comprueba que `AUTH_COOKIE_SAMESITE` sea `lax` y que **no** hayas definido
`AUTH_COOKIE_SECURE=false` (en producción el arranque lo rechaza).

**Recargar la página en una ruta interna devuelve 404**
→ El servicio del frontend no está sirviendo la imagen de Nginx del proyecto.

**Todas las IP del registro de auditoría son la misma**
→ Falta `TRUST_PROXY_HOPS=1` en la API.

**La primera visita del día tarda muchísimo**
→ Estás en plan **Free**: el servicio se apagó tras 15 minutos sin tráfico y
tiene que arrancar de nuevo. Es la razón principal para no usar Free en
producción.

**La base dejó de existir**
→ Si era **Free**, caducó a los 30 días. Hay 14 días de gracia para pasarla a un
plan de pago antes de perderla.

---

## Un dominio propio: mejora posterior, no requisito

Con el proxy del Paso 7, **el problema de las cookies de terceros no existe**:
el navegador ve una sola dirección y no hay nada que ningún navegador pueda
bloquear. Un dominio propio deja de ser una necesidad técnica y pasa a ser lo
que siempre debió ser: una decisión de imagen y de continuidad.

**Qué aportaría, cuando lo tengas:**

- Una dirección presentable para una federación nacional, en vez de
  `…onrender.com`.
- Independencia del nombre del proveedor: si algún día se cambia de plataforma,
  la dirección que conocen los clubes no cambia.

**Qué costaría:** el dominio. Un `.cl` ronda los **CLP 10.000 + IVA al año**
(conviene confirmarlo en nic.cl o con un registrador: no verifiqué la tarifa
vigente). En Render, **US$0 extra**: el plan Hobby incluye 2 dominios propios y
emite los certificados HTTPS solo.

**Qué habría que hacer:** añadir el dominio al servicio de la **web** —solo a
ese: la API ya no necesita dirección pública—, crear en el DNS el `CNAME` **y**
el `TXT` que indique Render (**los dos son obligatorios**; sin el `TXT` el
dominio devuelve 404 aunque el `CNAME` resuelva), y luego cambiar
`CORS_ORIGINS` en la API por la dirección nueva y volver a desplegar la web.
`VITE_API_URL` sigue siendo `/api` y no se toca, porque es una ruta relativa:
esa es otra ventaja del proxy.

**Qué habría que mantener:** renovar el dominio cada año. Si caduca, el sistema
deja de ser accesible. Conviene dejar escrito quién controla el registro y el
DNS.

**Cuándo hacerlo:** cuando haya un dominio confirmado y alguien responsable de
renovarlo. No hay ninguna urgencia técnica.

## Qué se comprobó y qué no

### Comprobado, con las imágenes reales

Ejecutado en una máquina de desarrollo con Docker, contra una **base de datos
desechable** creada y destruida para la prueba (nunca contra datos reales):

- `docker build ./backend` **sin elegir etapa** produce la imagen de la API
  (`CMD` = `node dist/server.js`, con `dist/server.js` dentro y **sin** el CLI de
  Prisma).
- `docker build -f backend/Dockerfile.mantenimiento ./backend` produce la de
  mantenimiento (`CMD` = `prisma migrate deploy …`), con `prisma` en el `PATH`,
  solo `seed.js` y `seed-admin.js` compilados —**ningún seed de datos de
  prueba**— y **sin `dist/`**.
- La imagen derivada es **idéntica capa por capa y configuración por
  configuración** a `docker build --target migrate ./backend`.
- Los avisos de terceros están en las cuatro rutas esperadas y son **idénticos
  byte a byte** a los de `notices/`.
- La secuencia completa del Paso 6.b: migraciones aplicadas, datos de referencia
  sembrados, administrador creado; repetir ese último comando **no** lo modifica;
  sin `SEED_ADMIN_*` termina con **código de salida 1**.
- La API arranca en modo producción y responde `/health` y `/ready`; `/docs`
  devuelve 404; **se inició sesión con éxito**. Con `CORS_ORIGINS` ausente o
  `AUTH_COOKIE_SECURE=false`, el arranque se detiene nombrando la variable.
- El frontend obedece `PORT`, sirve `/`, devuelve `index.html` en `/competencias`
  y 404 en un activo inexistente.
- La integración continua pasa en limpio sobre GitHub (commit `48bdeb9`).
- `onrender.com` figura en la *Public Suffix List*, lo que confirma que dos
  direcciones `…onrender.com` son **sitios distintos** para el navegador — el
  motivo por el que existe el proxy del Paso 7.

### El proxy de mismo origen: pruebas HTTP

Con el entorno completo levantado en local (PostgreSQL desechable, la API en
modo producción con `TRUST_PROXY_HOPS=2` y `AUTH_COOKIE_SAMESITE=lax`, y la web
construida con `VITE_API_URL=/api`), **con una herramienta de línea de
comandos**:

- **Rutas de la web:** `/`, `/competencias` y `/clubes` devuelven **200** y
  entregan `index.html`; `/third-party-notices.txt` **200**; un activo
  inexistente **404**.
- **La API bajo el mismo origen:** `/api/health` **200**, `/api/ready` **200**
  con `database: ok`, `/api/docs` **404** (apagada en producción).
- **Reescritura de la ruta de las cookies:** el login devuelve las dos cookies
  con `Path=/api/auth`, `HttpOnly; Secure; SameSite=Lax`. Sin la directiva
  `proxy_cookie_path` llegarían con `Path=/auth` y el navegador no las
  devolvería nunca.
- **Ciclo de sesión completo:** login **200** → cambio de contraseña **200** →
  renovación **200** con un token nuevo y la cookie rotada → cierre de sesión
  **204**, que borra ambas cookies (también con el `Path` reescrito).
- **Descarga:** la plantilla Excel de carga masiva llega con su
  `Content-Type` de hoja de cálculo, su `Content-Disposition` intacto y una
  firma de archivo válida.
- **Importación y tamaño del cuerpo:** un archivo de **5 MB** —que el límite por
  omisión de Nginx, 1 MB, habría cortado— llega entero y lo rechaza **la
  aplicación** por su contenido; uno de **25 MB** lo corta Nginx con **413**. El
  límite actúa donde debe.
- **Dirección del usuario con dos saltos:** con `TRUST_PROXY_HOPS=2`, una
  petición en la que el borde declara `190.44.12.77` queda auditada con esa IP;
  y otra en la que el cliente intenta colar `9.9.9.9` por delante queda auditada
  igualmente con `190.44.12.77`. La IP inventada se descarta.
- **El resolutor DNS** se genera al arrancar a partir de `/etc/resolv.conf`, y
  `envsubst` sustituye la dirección de la API dejando intactas las variables de
  Nginx.

### Por qué la API va como servicio privado: la prueba

Mismo entorno local, con la API expuesta además en un puerto propio para
reproducir qué pasaría si tuviera dirección pública. En los dos casos el
atacante inyecta `X-Forwarded-For: 203.0.113.66` y el borde le añade su IP real
`198.51.100.9`:

| Camino | IP auditada |
|---|---|
| **Directo a la API** | **`203.0.113.66`** — la inventada |
| Por la web, a través del proxy | `198.51.100.9` — la real |

Y el efecto sobre el límite de `/auth` (20 por minuto y por IP), con 30 intentos
contra un usuario inexistente para aislarlo del bloqueo de cuenta:

| 30 intentos | Procesados (401) | Bloqueados (429) |
|---|---|---|
| **Directos, rotando la IP inventada** | **30** | **0** |
| Directos, con IP fija | 20 | 10 |
| Por el proxy, rotando la IP inventada | 20 | 10 |

Con la API pública, la defensa contra el ensayo masivo de contraseñas **se anula
por completo**. Por el proxy, el ataque no cambia nada. De ahí que la API vaya
como *Private Service*.

- También se revisó el código: la aplicación **no usa** el protocolo ni el
  nombre de dominio de la petición en ningún punto (`req.protocol`,
  `req.hostname`). Lo único que depende de las cabeceras reenviadas es `req.ip`,
  que alimenta la auditoría y el límite de tasa.

### El proxy de mismo origen: prueba en un navegador real

Esto **sí es una prueba de navegador**, y es distinta de las anteriores. En un
navegador de verdad, contra ese mismo entorno local:

- Se **inició sesión desde la interfaz** y se llegó al panel de administración.
- Se **recargó la página** navegando directamente a `/dashboard` y a `/clubes`:
  **la sesión se mantuvo** en ambos casos.
- En el registro de red del navegador, **todas** las llamadas van a
  `/api/…` **del mismo origen** que la web. No hay ni una sola petición entre
  sitios.
- La renovación automática tras recargar devuelve **200** (en la primera visita,
  sin sesión, devuelve 401 y la aplicación muestra el login, que es lo correcto).

Es exactamente el flujo que falla cuando la cookie es de terceros, y aquí
funciona.

### Lo local sigue igual

- `docker compose config` y `docker compose build` correctos; la imagen de la
  web conserva `VITE_API_URL=http://localhost:3000` compilado dentro, así que el
  uso local no cambia: el navegador sigue llamando a la API por su puerto
  publicado. El proxy queda además disponible en `/api` para comprobarlo.
- El servicio `migrate` de Compose conserva `prisma migrate deploy` como
  comando.
- **El comando por omisión de la imagen de mantenimiento no toca la base.**
  Ejecutada **sin red alguna** (`--network none`) y con `DATABASE_URL` definida,
  imprime su mensaje y termina con **código 0**: ni siquiera intenta conectar. El
  mismo contenedor, con el comando de migraciones y en las mismas condiciones,
  falla con `P1001: Can't reach database server`. Y ejecutada contra una base
  vacía, la deja con **las mismas cero tablas**.
- **Los tres comandos explícitos siguen funcionando** sobre esa misma imagen: 31
  tablas tras migrar, 17 permisos tras el seed de referencia, 1 usuario tras el
  de administrador, y **código de salida 1** sin `SEED_ADMIN_*`.
- **Regenerar el `Dockerfile` de mantenimiento conserva el comportamiento**: el
  generador es idempotente y su `--verificar` queda conforme; una prueba
  automática (`backend/tests/dockerfile-mantenimiento.test.ts`) vigila que la
  fuente siga terminando en `runtime`, que conserve `prisma migrate deploy` para
  Compose, y que el comando por omisión del derivado **no** nombre `prisma`,
  `migrate`, `dist-seed` ni `seed-admin`. Se comprobó que esa prueba **falla**
  si se devuelve el comando peligroso al archivo derivado.
- También se comprobó que la variante `/bin/sh -c echo "…"` imprime una línea
  vacía, por lo que el instructivo no la usa.
- **Inicio y renovación de sesión, contra la API real** y con un origen cruzado
  declarado en `CORS_ORIGINS`:
  - `POST /auth/login` → **200**, con `Set-Cookie` de las dos cookies marcadas
    `HttpOnly; Secure; SameSite=None`, `Path=/auth`, y
    `Access-Control-Allow-Credentials: true`.
  - `POST /auth/refresh` con la cookie y la cabecera `X-CSRF-Token` → **200**,
    con un token de acceso **nuevo y distinto** del anterior y la cookie de
    refresco rotada. La renovación funciona.
  - La misma renovación **sin la cookie** → **401**, *«No hay una sesión activa
    en este navegador»*.
  - La misma renovación **sin la cabecera CSRF** → **403**, *«Comprobación de
    seguridad fallida»*: la protección sigue activa.

  > **Estas cuatro son pruebas HTTP, no pruebas de navegador.** Describen lo que
  > hace el servidor ante una petición con o sin cookie, hecha con una
  > herramienta de línea de comandos. **No demuestran** cómo se comportará
  > ningún navegador real: ni si enviará la cookie, ni si la guardará, ni qué
  > hará su política de cookies de terceros. Eso solo se sabe con el sistema
  > desplegado y un navegador delante.
- **Las herramientas de restauración del Paso 9** existen en `postgres:16-alpine`
  (`pg_restore` 16.15, `pg_dump`, `tar`), así que el respaldo se puede restaurar
  sin instalar nada en el computador.

### No comprobado

- **Nada se desplegó en Render.** No se creó cuenta, proyecto ni servicio, y no
  se contrató nada. **Todos los pasos 4 a 10 vienen de la documentación oficial**,
  no de una ejecución. Los nombres exactos de campos y botones pueden diferir.
- **Si guardar el campo *Docker Command* dispara un despliegue o una ejecución.**
  La documentación de Render no lo dice. Para las **variables de entorno** sí
  está documentado que guardar lanza un despliegue salvo que se elija *Save only*.
  El procedimiento del Paso 6.b está escrito para que esa incógnita no importe.
- **Si suspender un cron job impide sus ejecuciones programadas.** La
  documentación de Render no lo dice, así que esta guía **no** se apoya en ello:
  usa `Auto-Deploy: Off`, que sí está documentado.
- **Que Render permita a un servicio web hacer de proxy hacia otro por la red
  privada.** Su documentación dice que los servicios de la misma región y
  espacio de trabajo pueden hablar entre sí por esa red, y que los servicios web
  Free **no la reciben**, pero **no describe este uso concreto**. Es el supuesto
  central del Paso 7 y **el primero que hay que comprobar al desplegar**: es el
  paso 3 del Paso 8.
- **El valor y el formato exactos de la dirección interna de un servicio
  privado.** La guía indica `fchmn-api:3000` porque fija `PORT=3000` en el
  propio servicio, en vez de depender del comportamiento de `PORT` para
  servicios privados, que Render no documenta. El valor que muestre su *Service
  Address* manda sobre eso.
- **Que un servicio privado con comprobación TCP se considere sano** con esta
  imagen. La documentación dice que a los privados solo se les aplica esa
  comprobación; la API abre su puerto al arrancar, así que debería bastar, pero
  no está probado.
- **El comportamiento en Safari del sistema desplegado.** Con el proxy *no
  debería* haber problema, porque no hay cookies de terceros, y en un navegador
  real contra el entorno local la sesión se mantuvo. Pero eso fue con un solo
  origen en `localhost`: **confirmarlo en el despliegue real sigue siendo el
  paso 9 del Paso 8**.
- **El comportamiento con HTTPS real.** Las pruebas locales corrieron sobre
  `http://localhost`, que los navegadores tratan como contexto seguro y por eso
  aceptan cookies `Secure`. En Render habrá HTTPS de verdad; no se espera
  diferencia, pero no está probado.
- **Si 512 MB le bastan a la API.** Es una estimación; el salto siguiente es
  US$25/mes.
- **El consumo real** de tráfico, almacenamiento y minutos de construcción, y por
  tanto si habrá excedentes sobre el estimado de US$21.

---

## Qué falta decidir antes de desplegar

1. **Plan Free para ensayar, o de pago desde el principio.** Free sirve para
   comprobar que todo funciona; no sirve para datos reales (se apaga solo, caduca
   a los 30 días y no tiene ninguna copia de seguridad).
2. **La política de respaldos externos**: con qué cadencia se descargan, dónde se
   guardan, cuánto se conservan y quién puede acceder (Paso 9B).
3. **Nada: lo de las cookies ya está decidido.** El proxy del Paso 7 lo
   resuelve, y no hace falta dominio propio para ello. Un dominio sigue siendo
   deseable por imagen y continuidad, pero puede esperar: ver «Un dominio
   propio: mejora posterior, no requisito».
4. **Quién recibe los avisos de caída.** Render comprueba la salud **al
   desplegar**, no de forma continua. No hay ninguna monitorización configurada.
