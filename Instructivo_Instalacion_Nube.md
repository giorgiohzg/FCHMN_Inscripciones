# Instalación en la nube (para que quede disponible en internet, sin dejar tu computador prendido)

**Para quién es esta guía:** para alguien que **no sabe programar**, que ya tiene
Visual Studio Code, y que quiere que la aplicación quede funcionando en internet
de forma permanente — accesible desde cualquier computador, sin depender de que
tu computador esté prendido.

**Tiempo estimado:** 60-90 minutos la primera vez.

> ## ✅ Lee esto antes que nada: esta guía YA SE EJECUTÓ
>
> **El 28 de octubre de 2026 se recorrió completa en Render, de principio a fin,
> desde el commit `bffc69b`.** Los cuatro servicios quedaron en marcha, la base
> migrada y sembrada, el administrador creado, y el inicio de sesión, su
> renovación al recargar y el cierre de sesión comprobados en un navegador real.
>
> Eso significa que los pasos de abajo **no son una interpretación de la
> documentación**: son el camino que funcionó. Donde el panel no se comportó como
> la documentación hacía esperar, el texto lo dice y explica qué hacer; hay dos
> puntos así, y los dos cuestan tiempo si se descubren a ciegas:
>
> - **El almacenamiento de PostgreSQL se cobra aparte** y el formulario propone
>   15 GB (ver «Lo que cuesta»).
> - **`API_INTERNA` no acepta el nombre corto del servicio** que muestra Render;
>   hace falta el nombre completo (ver el recuadro del Paso 7). Saltarse esto da
>   un 502 sin explicación evidente.
>
> **El respaldo también está ensayado.** El 29 de octubre se descargó una copia,
> se restauró completa en una base desechable y se verificó estructura,
> relaciones y datos: 31 tablas, 26 migraciones con su suma SHA-256 idéntica a
> las del commit, 38 claves foráneas sin una sola fila huérfana. El Paso 9B trae
> el procedimiento exacto, con dos trampas que conviene leer antes de improvisar.
>
> **Pero ensayar no es tener respaldos.** La rutina es **manual** —exportar desde
> Render, descargar y conservar 30 días—, ya tiene responsable, y **todavía le
> faltan suplente y una cadencia confirmada**. Nada avisa si se deja de hacer. Es
> el primer punto de «Qué falta decidir».
>
> **Lo que sigue sin comprobar** está reunido en «Qué se comprobó y qué no», al
> final, junto con el detalle de cada prueba.
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
| PostgreSQL, cómputo | 0,1 CPU / 256 MB (*Basic 256 MB*) | **6** |
| PostgreSQL, almacenamiento | 1 GB | **0,30** |
| Mantenimiento (cron job) | **mínimo mensual por servicio** | **1** |
| | **Total estimado** | **US$21,30** |

> **El respaldo externo no añade costo**, porque se hace a mano: las
> exportaciones de Render están incluidas en el plan de la base y se descargan
> al equipo del responsable. Se evaluó automatizarlo —habría costado **US$1 más
> al mes**— y se decidió aplazarlo; el Paso 9B explica qué se gana y qué se
> pierde con cada vía.

> **El almacenamiento de la base se cobra APARTE del cómputo**, y esto hay que
> verlo venir. El formulario de PostgreSQL propone **15 GB por omisión**, que
> son **US$4,50 al mes** que se suman al cómputo: el total que muestra el panel
> pasa de US$6,30 a US$10,50 sin que nada lo anuncie. **Comprobado en el panel
> el 2026-10-28**: bajar el campo *Storage* a **1 GB** dejó el total de la base
> en **US$6,30**.
>
> Se eligió 1 GB porque esta base guarda texto —personas, clubes, competencias,
> inscripciones—, no archivos. **El campo se puede subir después** sin recrear
> la base; lo que no se puede es bajarlo. Hay que vigilarlo antes de cargar
> varios años de histórico (ver «Qué falta decidir»).

> **La corrección del cron job.** Su documentación dice: *«There is a minimum
> monthly charge of $1 per cron job service»*. El cobro por tiempo de ejecución
> es insignificante —US$0,00016 por minuto en el plan de 0,5 CPU—, pero **ese
> mínimo de US$1 se cobra igual aunque no se ejecute nunca**. Por eso está en la
> tabla como una línea fija y no como «céntimos».

**Lo que se cobra aparte si te pasas** (todas son holguras amplias para este uso):

| Concepto | Incluido en Hobby | Excedente |
|---|---|---|
| Almacenamiento de la base | **nada incluido** | US$0,30 por GB al mes (ya contado arriba) |
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

   > **Pero ese nombre corto NO es el que va en `API_INTERNA`.** Nginx no lo
   > resuelve, y el síntoma es un 502. El Paso 7 explica por qué y cómo obtener
   > el nombre completo: recuadro «El nombre corto no sirve».

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

> ### Qué ocurre al guardar — medido en el ensayo del 2026-10-28
>
> Esto era una incógnita y el primer ensayo la resolvió **en parte**. Lo que se
> observó, separando lo comprobado de lo que sigue abierto:
>
> **Lo comprobado.**
>
> - **Desplegar el cron job NO lo ejecuta.** Al crearlo, el despliegue terminó
>   en *Deploy succeeded* y la pestaña **Runs** quedó **vacía**: no apareció
>   ninguna ejecución. La pestaña *Logs* solo mostró las líneas del despliegue.
> - **Las dos pestañas guardan de forma distinta**, y esto conviene conocerlo:
>
>   | Dónde guardas | Qué te ofrece Render |
>   |---|---|
>   | **Environment** (variables) | Un menú con **tres** opciones: *Save, rebuild, and deploy* · *Save and apply on next run* · *Save only* |
>   | **Settings** (incluido *Docker Command*) | Un único botón **Save changes**, sin opciones |
>
>   Es decir: en *Settings* **no hay** un «Save only» que elegir. No es un error
>   tuyo si no lo encuentras.
> - **A lo largo de cuatro cambios del *Docker Command* seguidos de *Trigger
>   Run*, la pestaña *Runs* nunca mostró una ejecución que no hubiéramos
>   lanzado.** Cada guardado produjo exactamente las ejecuciones pulsadas, ni una
>   más.
>
> **Lo que sigue abierto.** Las cuatro observaciones anteriores son **evidencia
> de este despliegue, no documentación de Render**. Render no publica qué hace al
> guardar *Settings* en un cron job, y un comportamiento observado cuatro veces
> puede cambiar con una actualización del panel. Por eso el **paso 6 del
> procedimiento sigue siendo obligatorio**: vaciar el campo no depende de esta
> incógnita, la vuelve irrelevante.
>
> **Para las variables de entorno sí hay documentación**: guardarlas *«kicks off
> a deploy»* salvo que elijas **Save only**. Si cambias `SEED_ADMIN_PASSWORD` o
> `DATABASE_URL` aquí y no quieres que se reconstruya en ese momento, usa
> **Save only** o **Save and apply on next run**.
>
> Y en todo caso: haz los pasos 3 a 6 seguidos, y en el paso 5 mira **cuántas
> ejecuciones** aparecen en *Runs*, no solo la última.

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
   | `API_INTERNA` | El **nombre completo** de la API, con su puerto. **No basta `fchmn-api:3000`**: lee el recuadro «El nombre corto no sirve» antes de escribirlo |

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
   > **`API_INTERNA`** se aplica al **ARRANCAR**, y su valor no es el que parece.
   > Lee el recuadro siguiente: este punto costó un 502 en el primer ensayo.
   >
   > El nombre del servicio **no está escrito en ningún archivo del
   > repositorio**: vive solo en esta variable. Si algún día renombras la API,
   > se cambia aquí y basta.

   > ### ⚠️ El nombre corto no sirve — comprobado el 2026-10-28
   >
   > Render muestra la **Service Address** del servicio privado como
   > `fchmn-api:3000`, y ese nombre **funciona** desde una terminal del
   > contenedor de la web (`getent hosts fchmn-api` responde). Pero **Nginx
   > devuelve 502** con este error en su registro:
   >
   > ```
   > fchmn-api could not be resolved (3: Host not found)
   > ```
   >
   > **Por qué.** El nombre corto resuelve gracias a las *search domains* de
   > `/etc/resolv.conf`, que Render rellena con su espacio de nombres interno:
   >
   > ```
   > search own-XXXXXXXXXXXXXXXXXXXX.svc.cluster.local svc.cluster.local cluster.local
   > ```
   >
   > El resolutor del sistema —el que usan `getent`, `wget` o `curl`— prueba esos
   > sufijos uno a uno. **El resolutor propio de Nginx no los usa**: consulta el
   > nombre tal cual, y `fchmn-api` a secas no existe en el DNS. Es una diferencia
   > conocida de Nginx, no un fallo de Render ni de esta configuración.
   >
   > **Qué escribir, entonces.** El nombre completo, que son tres partes:
   >
   > ```
   > <nombre-del-servicio>.<espacio-de-nombres>.svc.cluster.local:<puerto>
   > ```
   >
   > Para obtener el espacio de nombres, abre la **Shell** del servicio de la web
   > y mira la línea `search` de `/etc/resolv.conf`: el primer sufijo es el que
   > toca. Compruébalo con `getent hosts <nombre-corto>` y
   > `getent hosts <nombre-completo>` desde esa misma Shell: **deben devolver la
   > misma dirección**. Así se confirma que no se está hablando con otro
   > servicio, sino con el mismo, nombrado de forma que Nginx sí puede resolver.
   > (En el despliegue del 28 de octubre coincidieron.)
   >
   > **Esto es frágil y conviene saberlo**: el valor incorpora el espacio de
   > nombres interno de Render, que es un detalle de su infraestructura y no algo
   > que Render documente como estable. **Si un redespliegue de la web vuelve a
   > dar 502**, el primer sitio donde mirar es esta variable, repitiendo la
   > consulta de `/etc/resolv.conf`. Queda anotado como mejora pendiente en «Qué
   > falta decidir».

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

- **502 o 504** → el proxy no alcanza la API. **La causa más probable, y la que
  ocurrió en el primer ensayo, es que `API_INTERNA` lleve el nombre corto.**
  Abre **fchmn-web → Logs** y busca la línea del error: si dice
  `… could not be resolved (3: Host not found)`, es exactamente eso; vuelve al
  recuadro «El nombre corto no sirve» del Paso 7. Si el error es otro, revisa
  que ambos servicios estén en la **misma región** y que la API sea un
  **Private Service** en marcha, con su `PORT` coincidiendo con el puerto de
  `API_INTERNA`.
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

### La rutina de respaldo externo

Render conserva los respaldos lógicos **solo 7 días** y el PITR del plan Hobby
cubre **3 días**. Eso significa que cualquier pérdida descubierta más tarde
—un borrado que nadie notó, una temporada que había que recuperar— **solo se
puede reparar con un archivo que esté fuera de Render**. Esta rutina existe para
que ese archivo exista siempre.

> ## ⚠️ Esta rutina es MANUAL, y eso tiene consecuencias
>
> **Decidido el 2026-10-29.** Las exportaciones se crean a mano en el panel de
> Render, se descargan a mano y las copias externas se conservan **30 días**.
>
> **Se evaluó automatizarlo y se descartó por ahora** (ver «El respaldo
> automático: evaluado y aplazado», más abajo). No hay ningún servicio nuevo, ni
> cuenta de almacenamiento externo, ni vigilante.
>
> **Lo que eso significa, dicho sin adornos:** una rutina manual **no avisa
> cuando no se hace**. Si pasa un mes sin que nadie descargue una copia, nada
> falla, nada se pone rojo y nadie recibe un correo. El sistema sigue
> funcionando igual de bien, y la protección simplemente deja de existir sin que
> se note. Es el riesgo que se acepta al elegir esta vía, y la única defensa es
> la disciplina de la persona responsable.

#### Quién responde, y qué sigue pendiente

| | Estado |
|---|---|
| **Responsable** | ✅ **ASIGNADO** — el administrador del sistema, titular de la cuenta de Render y de este repositorio |
| **Suplente** | ⬜ **PENDIENTE** |
| **Frecuencia comprometida** | ⬜ **PENDIENTE DE CONFIRMAR** |
| **Retención** | ✅ **DECIDIDA** — ventana móvil de 30 días |
| **Quién revisa que se hizo** | ⬜ **PENDIENTE** |

> **El nombre del responsable no se escribe aquí a propósito.** Este repositorio
> es **público**: un nombre o un correo escrito en este archivo queda publicado y
> en el historial de Git para siempre. El cargo identifica al responsable sin
> exponer datos personales; el nombre va en la planilla interna de respaldos,
> junto con el del suplente cuando se designe.

> **Los tres pendientes no son del mismo tipo, y conviene no confundirlos.**
>
> - **El suplente** es lo más urgente de los tres. Hoy la rutina se detiene por
>   completo en cualquier ausencia del responsable —vacaciones, una licencia, un
>   viaje— y nada lo señala.
> - **La frecuencia** es la pérdida máxima que se acepta. Está sin confirmar a
>   propósito: la tabla siguiente dice qué cubre cada opción, y la elección es
>   del responsable, no del instructivo.
> - **Quién revisa** sustituye a la alarma que una rutina manual no tiene, y
>   tiene que ser alguien **distinto** del responsable: nadie audita bien su
>   propia disciplina.

#### Qué pérdida cubre cada frecuencia

Esta es la pregunta que hay que responder para elegir, y no es técnica: es
«¿cuánto trabajo estamos dispuestos a repetir?».

| Frecuencia de la copia externa | Pérdida máxima si hay que recurrir a ella |
|---|---|
| Mensual | **hasta un mes** de inscripciones, altas y cambios |
| Semanal | **hasta una semana** |
| Diaria | **hasta un día** |

> **Atención: esa pérdida solo se materializa si la copia externa es el único
> recurso.** Mientras Render esté disponible y el problema se descubra **dentro
> de 3 días**, el PITR recupera hasta el minuto y no se pierde prácticamente
> nada. La copia externa es el recurso para los otros dos casos: un problema
> descubierto **después** de esos 3 días, o que no se pueda contar con Render.

#### La frecuencia: pendiente de confirmar

**Ninguna cadencia está comprometida todavía.** Lo que sigue son opciones para
que el responsable elija; hasta que lo haga, este instructivo **no afirma** que
exista una frecuencia acordada.

| Período | Opciones a considerar |
|---|---|
| Con inscripciones abiertas | diaria · cada dos días · semanal |
| Resto del año | mensual · trimestral |
| Ocasiones puntuales | **antes** de cada actualización con migraciones · al **cerrar** las inscripciones de cada competencia |

> **Las ocasiones puntuales son las de mejor rendimiento por esfuerzo
> invertido**, y por eso aparecen aparte: cubren exactamente los dos momentos en
> que algo puede salir mal de forma masiva. Son dos copias al año por
> competencia, no una rutina de calendario, y conviene decidirlas aunque la
> cadencia regular quede en lo mínimo.

> **Una rutina manual tiene la frecuencia que de verdad se cumple, no la que se
> escribe.** Comprometerse a una copia diaria a mano, todos los días del año
> incluidos domingos y vacaciones, no se sostiene — y una cadencia escrita que
> no se cumple es peor que una modesta que sí: induce a creer que hay una
> protección que no existe. Conviene elegir la más frecuente que se pueda
> sostener de verdad, no la más frecuente que suene bien.

#### La retención de 30 días, y cómo se cumple a mano

**La retención es decisión tomada: ventana móvil de 30 días.**

| | |
|---|---|
| **Retención** | **30 días** desde la descarga |
| **Quién borra** | el responsable, **a mano**, en las dos ubicaciones |
| **Cuándo** | en la misma sesión que la copia nueva, **y solo después de comprobarla** |

> ### ⚠️ El orden importa: primero la copia nueva, después el borrado
>
> **Nunca se borra una copia vencida antes de tener la nueva comprobada.** Si se
> borra primero y la descarga de hoy falla a medias, se queda sin la vieja y sin
> la nueva — y el fallo puede no notarse hasta el día que haga falta restaurar.
>
> Los cuatro pasos, en este orden y sin adelantar ninguno:
>
> | | Paso |
> |---|---|
> | **1** | Crear la exportación en Render y **descargarla** |
> | **2** | **Comprobar la descarga** (ver abajo) |
> | **3** | Copiarla a la **segunda ubicación** y anotarla en la planilla |
> | **4** | **Solo entonces**, borrar las que pasen de 30 días, en las dos ubicaciones |
>
> **Cómo comprobar la descarga**, sin necesidad de base de datos ni de
> restaurar nada. Que el archivo exista y pese algo no basta: una descarga
> cortada produce un `.tar.gz` perfectamente plausible que no se puede abrir.
> Esto lo verifica de verdad:
>
> ```bash
> docker run --rm -v "${PWD}:/respaldo:ro" postgres:16-alpine sh -c 'mkdir -p /tmp/x && cd /tmp/x && tar -zxf /respaldo/NOMBRE_DEL_ARCHIVO.dir.tar.gz && pg_restore --list "$(find . -mindepth 2 -maxdepth 2 -type d | head -1)" | tail -5'
> ```
>
> Si lista entradas, el archivo está completo y es legible. Si falla, **la
> descarga no sirve**: repítela, y **no borres nada** mientras no tengas una
> copia que pase esta comprobación.
>
> Esto son unos segundos y es lo único que separa «tengo un archivo» de «tengo un
> respaldo». No sustituye al ensayo de restauración completo, que sigue siendo
> semestral.

**Dónde se guardan las copias descargadas.** Dos sitios, y que uno no sea el
computador del responsable:

| | Recomendación | Estado |
|---|---|---|
| **Principal** | carpeta del almacenamiento en la nube de la federación, con acceso restringido al responsable y su suplente | ⬜ por confirmar que admite permisos restringidos reales |
| **Segunda copia** | disco externo cifrado, bajo llave y **no conectado de forma permanente** | ⬜ por confirmar |

> **Por qué dos, y por qué una desconectada.** La copia en la nube protege de
> que se dañe o se pierda el equipo; la desconectada protege de que algo —un
> programa malicioso, un borrado que se sincroniza— alcance también a la copia en
> la nube. Son dos riesgos distintos y hacen falta las dos.
>
> **Cifrar el disco externo es lo que sustituye al cifrado que haría la
> automatización.** Al descargarse de Render, el archivo **no está cifrado**:
> contiene RUT, nombres y fechas de nacimiento en claro. Un disco perdido o
> robado sin cifrar entrega todo eso. En Windows eso es BitLocker; en un disco
> que vaya a viajar, conviene además que no quede nunca desbloqueado.

> **El borrado también es manual, y por eso va atado a la copia nueva** —como
> paso 4, nunca antes—. Atarlo a una acción que ya se está haciendo es lo único
> que evita que se olvide; si se deja «para después», se acumulan datos
> personales sin que nadie lo decida.
>
> No hay nada que lo imponga. **La retención efectiva será la que resulte de la
> disciplina de quien la aplique**, y esto el instructivo no puede resolverlo.

> ### ⚠️ La ventana de 7 días: el plazo que de verdad aprieta
>
> **Render borra sus propias exportaciones a los 7 días**, en cualquier plan. La
> copia solo existe fuera de Render cuando está **descargada en tu equipo**.
>
> Crear la exportación y no descargarla **no es un respaldo**: es una copia que
> desaparece sola la semana siguiente. Por eso los dos pasos —crear y
> descargar— van siempre en la misma sesión, nunca en días distintos.

#### El respaldo automático: evaluado y aplazado

Se diseñó, se preparó y se probó en local una automatización completa
—exportación diaria, cifrado antes de salir del servidor, almacenamiento fuera
de Render con borrado automático a los 30 días, y alarma si el respaldo falla
**o si no ocurre**— y **se decidió no implementarla por ahora**.

Queda anotado para cuando se quiera retomar, porque la evaluación ya está hecha:

| | |
|---|---|
| **Costo** | **US$1 al mes** (el mínimo mensual de un cron job de Render; el almacenamiento y la vigilancia resultaban gratuitos a este tamaño) |
| **Qué añadiría** | la copia ocurre sin que nadie se acuerde, y **alguien recibe un correo si deja de ocurrir** |
| **Qué exigiría definir** | destinatarios de las alertas y **custodia de la clave de descifrado** —que, si se pierde, deja todos los respaldos ilegibles para siempre |

> **Lo que se gana automatizando no es el esfuerzo ahorrado: es la alarma.** Una
> rutina manual bien llevada protege igual de bien. La diferencia aparece el día
> en que deja de llevarse bien, porque entonces la automatizada avisa y la
> manual no.

#### Custodia: qué cuidado merece el archivo

- **Contiene todos los datos personales del sistema**: RUT, nombres, clubes,
  inscripciones. Es el documento más sensible que maneja la federación y le
  corresponde el mismo trato que a un registro de socios.
- **No lo subas al repositorio** ni lo mandes por correo, WhatsApp o chat. Si hay
  que entregarlo a alguien, se comparte la carpeta restringida, no el archivo.
- **Conserva el nombre con fecha que le pone Render** (`2026-10-29T12_30Z…`). No
  lo renombres: la fecha y hora en UTC son la única forma de saber a qué momento
  corresponde.
- **Anota cada descarga** en una planilla simple: fecha, quién la hizo, dónde
  quedó. Sin ese registro, dentro de un año nadie sabrá si falta alguno.
- **Da de baja los vencidos**: cuando un respaldo pasa su retención, bórralo de
  las dos ubicaciones. Guardar datos personales más de lo necesario es un riesgo
  sin beneficio.

#### La planilla de respaldos

Al no haber ningún sistema que registre lo que se hizo, **la planilla es el único
rastro**. Una hoja de cálculo basta, con una fila por copia:

| Fecha | Nombre del archivo | ¿Comprobada? | Ubicación 1 | Ubicación 2 | Vencidas borradas | Quién |
|---|---|---|---|---|---|---|

La columna **«¿Comprobada?»** es la que no se puede dejar en blanco: es el paso 2
del orden de arriba, y sin ella la fila solo dice que alguien descargó un
archivo, no que ese archivo sirva.

> **Para qué sirve de verdad esta planilla.** Para que quien revise —esa tercera
> persona pendiente de designar— pueda ver en diez segundos si falta alguna copia,
> y para que dentro de un año se pueda responder «¿teníamos respaldo en tal
> fecha?» sin tener que adivinar.

#### Qué hacer cuando toque el ensayo periódico

Seguir los cinco pasos del ensayo seguro de más abajo, con el respaldo **más
reciente**, y anotar en la planilla la fecha y el resultado. Si el ensayo falla,
**eso es una emergencia**: significa que los respaldos acumulados pueden no
servir, y hay que resolverlo antes de la siguiente competencia.

**Restaurar un respaldo descargado.** Hay **dos cosas distintas** aquí, y
conviene no mezclarlas:

| | Para qué | Riesgo |
|---|---|---|
| **El ensayo** (más abajo) | Comprobar que el archivo sirve | **Ninguno**: base desechable en tu equipo, sin costo |
| **La restauración real** | Recuperar el servicio tras un desastre | **Alto**: reemplaza los objetos de la base de destino |

**Haz el ensayo ahora y la restauración real solo cuando haga falta.** Lo que
sigue está comprobado de principio a fin el 2026-10-29.

> ### ⚠️ No descomprimas el archivo en Windows — comprobado el 2026-10-29
>
> Dentro del `.tar.gz` hay **dos niveles** de carpeta, y el primero lleva la hora
> en el nombre con **dos puntos**:
>
> ```
> 2026-10-29T12:30Z/            ← los dos puntos son ilegales en Windows
>   fchmn_postgres/             ← aqui estan toc.dat y los 31 archivos .dat
> ```
>
> Windows **no admite `:` en un nombre de archivo**, así que descomprimirlo con
> el Explorador, con 7-Zip o con `tar` desde PowerShell falla o renombra la
> carpeta, y entonces `pg_restore` no encuentra nada. Por eso **todos los
> comandos de abajo descomprimen DENTRO del contenedor**, donde el nombre es
> perfectamente válido.
>
> Y ojo con la ruta: `toc.dat` está en el **segundo** nivel. Apuntar
> `pg_restore` al primero da *«does not appear to be a valid archive»*.

**Primero, comprueba las versiones.** Si el servidor de origen es más nuevo que
tu `pg_restore`, la restauración puede fallar o perder cosas. Esto lo lee del
propio archivo, sin tocar los datos ni necesitar la base:

```bash
docker run --rm -v "${PWD}:/respaldo:ro" postgres:16-alpine sh -c 'mkdir -p /tmp/x && cd /tmp/x && tar -zxf /respaldo/NOMBRE_DEL_ARCHIVO.dir.tar.gz && pg_restore --list "$(find . -mindepth 2 -maxdepth 2 -type d | head -1)" | head -8'
```

Busca estas dos líneas y compáralas con `pg_restore --version`:

```
;     Dumped from database version: 16.15
;     Dumped by pg_dump version: 16.15
```

> **Comprobado el 2026-10-29**: origen `16.15`, `pg_dump` `16.15` y el
> `pg_restore` de `postgres:16-alpine` **`16.15`**. Coinciden las tres. Si algún
> día Render sube de versión mayor, usa la imagen que corresponda
> (`postgres:17-alpine`) — descargarla no cuesta nada.

#### El ensayo seguro: una base desechable, sin costo y sin riesgo

**Así se practica sin acercarse a la base operativa.** Es la forma recomendada, y
es la que está comprobada de principio a fin.

1. **Levanta una base desechable.** `--tmpfs` hace que los datos vivan en memoria:
   **no se crea ningún volumen** y al borrar el contenedor no queda rastro.

   ```bash
   docker run -d --name fchmn-ensayo-restauracion -e POSTGRES_USER=ensayo -e POSTGRES_PASSWORD=desechable_no_reutilizar -e POSTGRES_DB=ensayo_restauracion --tmpfs /var/lib/postgresql/data:rw -v "${PWD}:/respaldo:ro" postgres:16-alpine
   ```

   > **`:ro` en el montaje no es decorativo**: deja el archivo descargado como
   > solo lectura, así que el ensayo no puede alterar tu copia. Compruébalo si
   > quieres: `docker exec fchmn-ensayo-restauracion touch /respaldo/x` responde
   > *«Read-only file system»*.

2. **Restaura.** `--exit-on-error` es importante: sin él, `pg_restore` sigue
   adelante tras un fallo y termina diciendo que «hubo errores» sin más.

   ```bash
   docker exec fchmn-ensayo-restauracion sh -c 'mkdir -p /tmp/x && cd /tmp/x && tar -zxf /respaldo/NOMBRE_DEL_ARCHIVO.dir.tar.gz && pg_restore --dbname="postgresql://ensayo:desechable_no_reutilizar@127.0.0.1:5432/ensayo_restauracion" --no-owner --no-privileges --exit-on-error --verbose --format=directory "$(find /tmp/x -mindepth 2 -maxdepth 2 -type d | head -1)"'
   ```

   > **`--verbose` escribe en la salida de ERROR, no en la estándar.** Verás
   > cientos de líneas `pg_restore: creating ...` que **no son fallos**: son el
   > progreso. Lo que indica éxito es el **código de salida 0**. En el ensayo del
   > 2026-10-29 fueron 211 líneas —1 de conexión, 179 creando objetos y 31
   > procesando datos de tabla— y **ni un solo `error` ni `warning`**.

3. **Verifica.** El conteo de filas no basta. Lo mínimo que hay que mirar:

   ```bash
   docker exec fchmn-ensayo-restauracion psql -U ensayo -d ensayo_restauracion -c "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='public') AS tablas, (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) AS migraciones_ok, (SELECT count(*) FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE c.contype='f' AND n.nspname='public' AND NOT c.convalidated) AS fk_sin_validar;"
   ```

   Debe dar **31 tablas**, **26 migraciones** y **0 claves foráneas sin validar**.

   > **La comprobación más fuerte, si quieres ir a fondo:** `_prisma_migrations`
   > guarda la **suma SHA-256** de cada `migration.sql`. Comparar esas 26 sumas
   > con las de los archivos del repositorio demuestra que el esquema restaurado
   > es byte a byte el del commit desplegado. **Comprobado: coincidencia total
   > contra `bffc69b`.**
   >
   > Si lo haces en Windows, calcula las sumas sobre lo que Git tiene
   > **almacenado** (`git cat-file -p :<ruta> | sha256sum`), no sobre los
   > archivos del disco: dos de las 26 migraciones están en el disco con saltos
   > de línea de Windows (CRLF) y su suma no coincide, aunque el contenido sea el
   > mismo. Es un efecto de la copia local, no un problema del respaldo.

4. **Levanta la aplicación contra esa base** — este paso es el que convierte el
   ensayo en una prueba de verdad. Una base que restaura bien pero sobre la que
   el sistema no arranca no sirve de nada.

   Hay que construir las imágenes desde el commit desplegado, crear una red
   aislada y conectar las tres piezas. El procedimiento completo, con los
   comandos y lo que debe responder cada uno, está en **«La aplicación
   funcionando sobre el respaldo restaurado»**, en la sección «Qué se comprobó».
   Lo mínimo que hay que ver:

   - la API arranca **sana** y `/api/ready` responde `"database":"ok"`;
   - se puede **iniciar sesión** y **consultar los catálogos**, y los valores son
     los que esperabas;
   - `refresh` renueva la sesión y `logout` la termina.

   > **Para probar el inicio de sesión, crea una cuenta aparte en la base
   > desechable** con `seed-admin.js` y una contraseña de un solo uso. **No uses
   > la contraseña real del administrador**: no hace falta, y así no circula por
   > ningún archivo ni terminal.

5. **Borra todo y comprueba que no quedó nada.**

   ```bash
   docker rm -f fchmn-ensayo-web fchmn-ensayo-api fchmn-ensayo-db; docker network rm fchmn-ensayo-red; docker volume ls
   ```

   Con `--tmpfs` la lista de volúmenes debe quedar **igual que antes de empezar**.
   Borra también los archivos temporales y la copia de trabajo del respaldo —el
   original, nunca.

#### Restaurar de verdad, sobre una base de Render

Solo cuando haga falta recuperar el servicio, y después de haber practicado:

1. Consigue la **External Database URL** de la base de destino.
2. El mismo comando del punto 2, cambiando el `--dbname` por esa URL y
   **añadiendo `--clean --if-exists`** para que reemplace los objetos existentes.
3. Comprueba la aplicación antes de dar por buena la restauración (Paso 8).

> **🔑 Ese comando lleva la contraseña de la base dentro de la URL.** No lo
> guardes en un archivo ni lo pegues en ningún chat. Bórralo del historial de la
> terminal cuando termines.

> **`--clean --if-exists` borra y recrea los objetos del destino.** Confirma dos
> veces contra qué base apuntas. Si lo que quieres es recuperar datos perdidos,
> **usa PITR** (opción A): casi siempre recupera información más reciente que tu
> última exportación.

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

### Comprobado en el despliegue real de Render — 28 de octubre de 2026

Esta sección es el resultado de recorrer la guía completa. **Es la parte más
importante del documento**, porque cierra supuestos que antes estaban abiertos.

**El despliegue.** Proyecto `fchmn-inscripciones`, entorno `Production`, región
**Oregon (US West)**, los cuatro servicios desde el commit **`bffc69b`**:

| Servicio | Tipo | Dirección | US$/mes |
|---|---|---|---|
| `fchmn-postgres` | PostgreSQL 16, 0,1 CPU / 256 MB, 1 GB | interna | 6,30 |
| `fchmn-api` | **Private Service**, 0,5 CPU / 512 MB | `fchmn-api:3000`, **sin URL pública** | 7 |
| `fchmn-web` | Web Service, 0,5 CPU / 512 MB | `https://fchmn-web.onrender.com` | 7 |
| `fchmn-mantenimiento` | Cron Job, calendario `0 6 1 1 *` | sin dirección | 1 (mínimo) |

**Supuestos que quedaron confirmados**, y que antes figuraban como incógnitas:

- **Un servicio web de Render puede hacer de proxy hacia otro por la red
  privada.** Era el supuesto central del Paso 7 y el que no estaba documentado
  para este uso. Funciona: `/api/health` responde a través del proxy.
- **Un servicio privado con comprobación TCP se considera sano** con esta imagen.
  El despliegue terminó en *Deploy succeeded* y el registro muestra la API
  escuchando en el puerto 3000.
- **Un servicio privado no tiene URL pública**, tal como dice la documentación.
  No hay subdominio `onrender.com` que buscar.
- **Desplegar un cron job no lo ejecuta** (ver el recuadro del Paso 6.b).
- **El guardián de la contraseña del administrador funciona en producción.** Un
  primer intento de `seed-admin.js` **falló a propósito** porque la contraseña no
  tenía mayúscula, y **no creó ninguna cuenta**. Es exactamente lo que debe
  pasar.

**Las comprobaciones HTTP, a través del proxy** (son pruebas de servidor, no de
navegador):

| Petición | Resultado |
|---|---|
| `GET /api/health` | **200** |
| `GET /api/ready` | **200**, `"database":"ok"` |
| `GET /api/docs` | **404** — la documentación interactiva no se expone |
| `GET /api/auth/csrf` | **200**, entrega el testigo |
| `POST /api/auth/login` con credenciales falsas | **401** con mensaje genérico, sin revelar si el usuario existe |
| Cabecera `Access-Control-Allow-Origin` | presente **solo** para el origen declarado en `CORS_ORIGINS` |

**Las pruebas de navegador, hechas por el administrador** (estas sí son pruebas
de navegador, y son las que importan para las cookies):

1. La web carga por **HTTPS** con candado válido.
2. **Inicio de sesión** desde la interfaz: correcto.
3. **Cambio de contraseña obligatorio** en el primer ingreso: correcto.
4. **Recarga con F5: la sesión se mantuvo.** ← *la prueba decisiva del proxy*
5. **Ruta interna escrita directamente** (`/clubes`): carga, sin 404 de Nginx.
6. **Cierre de sesión**: vuelve al ingreso, y recargar **no** devuelve adentro.
7. **La misma secuencia en una ventana de incógnito y con las cookies de
   terceros BLOQUEADAS**: inicio de sesión correcto y **la sesión se mantuvo al
   recargar**. ← *esta es la prueba que cierra el motivo del proxy*

> **Por qué el punto 7 es el que vale.** Era el fallo que había que evitar: con
> la web y la API en direcciones distintas, la cookie de sesión es **de
> terceros** y hay navegadores que no la guardan; el usuario entra, recarga y
> vuelve al login sin ningún mensaje que lo explique. Sirviendo la API bajo
> `/api` del mismo origen **no hay ninguna cookie de terceros que bloquear**, y
> bloquearlas expresamente ya no cambia nada. Comprobado en un navegador real,
> no por HTTP.
>
> Esto también significa que `AUTH_COOKIE_SAMESITE` puede quedarse en `lax`, que
> es más estricto —y por tanto más seguro— que `none`.

**La base de datos.** Antes de migrar se confirmó, en el propio registro de la
ejecución, que el destino era `fchmn_postgres` y que tenía **26 migraciones
pendientes**, es decir, que estaba **vacía**. Después: migraciones aplicadas,
datos de referencia sembrados y administrador creado, cada cosa con su comando
explícito y su ejecución manual.

> **Un detalle del panel que confunde.** `prisma migrate status` **termina con
> código 1** cuando hay migraciones pendientes, así que esa ejecución aparece en
> *Runs* **en rojo** aunque haya funcionado perfectamente. No es un fallo de
> conexión: hay que leer el registro, donde se ve la base identificada y la lista
> de migraciones. Es la forma de comprobar contra qué base se va a trabajar.

### El ensayo de restauración — 29 de octubre de 2026

Se creó un respaldo lógico en Render, se descargó y **se restauró completo en una
base desechable** en el equipo del administrador, sin tocar la base operativa y
sin costo. Resultado: **25 veredictos, todos conformes, y ningún error**.

| Qué se comprobó | Esperado | Encontrado |
|---|---|---|
| Versión de origen / `pg_dump` / `pg_restore` | que coincidan | **16.15** las tres |
| Código de salida de `pg_restore` (con `--exit-on-error`) | 0 | **0**, sin un solo `error` ni `warning` |
| Tablas | 31 | **31**, y ninguna de más ni de menos por nombre |
| Migraciones aplicadas, terminadas y sin revertir | 26 | **26** |
| **Suma SHA-256 de cada migración vs. el commit `bffc69b`** | idénticas | **coincidencia total** |
| Claves foráneas, y cuántas sin validar | 38 / 0 | **38 / 0** |
| **Barrido explícito de huérfanos**, relación por relación | 0 filas | **0 en las 38** |
| Índice único **parcial** de la invariante RB-06 | presente | `club_swimmers_unique_active_person` |
| Tipos enumerados, con sus valores | 12 | **12** |
| Catálogos: distancias, estilos, jornadas, tipos de prueba | los valores literales del seed | **exactos**, no solo la cantidad |
| Matriz RBAC por rol | 17/8/8/8/8/6 | **idéntica** |
| Columnas con valor por omisión | — | 46 |
| Tablas operativas | vacías | **0 filas** (no hay datos reales aún) |

**Además se comprobó que las restricciones no solo existen, sino que RECHAZAN lo
que deben**, con inserciones de prueba dentro de transacciones revertidas: una
clave foránea inválida, un duplicado en un catálogo único, un valor fuera de un
tipo enumerado y una clave primaria compuesta repetida fueron **las cuatro
rechazadas**; una inserción válida fue aceptada y no dejó rastro tras revertir.

**Y un dato que confirma que el respaldo es del sistema vivo**, no de una base
recién creada: la cuenta de administrador aparece con el cambio de contraseña
**ya realizado**, el que se hizo en la prueba de navegador antes de exportar.

> **Dos trampas que costaron tiempo y están documentadas en el Paso 9B:**
>
> 1. **La carpeta interna del respaldo lleva `:` en el nombre** (`2026-10-29T12:30Z`),
>    que Windows no admite. Hay que descomprimir **dentro del contenedor**.
> 2. **`toc.dat` está en el segundo nivel** de carpetas, no en el primero.
>    Apuntar `pg_restore` al primero da *«does not appear to be a valid archive»*.
>
> También conviene saber que **`--verbose` escribe en la salida de error**: las
> 211 líneas `pg_restore: creating ...` son progreso, no fallos.

#### La aplicación funcionando sobre el respaldo restaurado

El ensayo anterior demostró que la **base** se restaura bien. Esto demuestra que
**el sistema funciona encima de ella**. Se restauró el mismo respaldo en una
segunda base desechable y se levantaron la API y la web **construidas desde
`bffc69b`**, en una red Docker aislada, sin ninguna conexión con Render.

| Prueba | Resultado |
|---|---|
| Arranque de la API | **sana** (`Up … (healthy)`), escuchando en el puerto 3000 |
| Arranque de la web y resolución del proxy | **sana**; `25-resolver.sh` configuró el resolutor |
| `GET /api/health` a través del proxy | **200** |
| `GET /api/ready` a través del proxy | **200**, `{"status":"ready","database":"ok"}` ← *la API habla con la base restaurada* |
| `GET /` y `GET /clubes` | **200** y **200** (el *fallback* de SPA entrega `index.html`) |
| `GET /api/auth/csrf` | **200**, entrega el testigo |
| Inicio de sesión con clave **incorrecta** | **401** |
| Inicio de sesión con clave **correcta** | **200**, con `roles:["admin"]` |
| **Ruta de las cookies tras el proxy** | `fchmn_refresh` y `fchmn_csrf` llegaron con **`Path=/api/auth`**, no `/auth`, y ambas `HttpOnly` |
| Catálogos **antes** del cambio de contraseña obligatorio | **403** — el sistema bloquea todo hasta cambiarla |
| Cambio de contraseña | **200**, y la respuesta trae **sesión nueva** porque revoca las anteriores |
| `GET /api/catalogs/…` con sesión válida | **200**: distancias **6**, estilos **4**, tipos de prueba **2** |
| Los **valores** devueltos por la API | `50 100 200 400 800 1500` y `Espalda Libre Mariposa Pecho` — los del respaldo |
| `POST /api/auth/refresh` (lo que hace F5) | **200**, con un token **distinto** del anterior, y ese token sirve en `/api/auth/me` |
| `POST /api/auth/logout` | **204**, y el `refresh` posterior da **401** |
| Auditoría | la base restaurada **registró** los ingresos, fallos, cambios de clave y cierres |

> **Dos cosas que este ensayo demostró de paso, y vale anotarlas:**
>
> 1. **El guardián de producción funciona.** Con `NODE_ENV=production` y
>    `AUTH_COOKIE_SECURE=false`, la API **se niega a arrancar**: *«no se admite en
>    producción»*. Es el comportamiento correcto, y obliga a usar HTTPS.
> 2. **La cuenta que venía del respaldo no se tocó.** Para probar el inicio de
>    sesión se creó una cuenta aparte **solo en la base desechable**, con una
>    contraseña generada al azar que no se mostró en ningún momento. Se verificó
>    después que la cuenta restaurada seguía sin modificar.

**Limitaciones de este ensayo, dichas claramente:**

- **Corrió en modo `development`, y eso fue una decisión del ensayo, no un
  límite del sistema.** En `production` la API exige cookies `Secure`, que a su
  vez exigen HTTPS, y **el equipo local no tenía HTTPS configurado**. Sí se
  puede: basta terminar TLS delante de la web con un certificado propio —uno
  autofirmado o emitido por `mkcert`, confiado en el equipo— y ajustar el Nginx
  del ensayo para escuchar en 443. **Simplemente no se hizo en este ensayo**, y
  por eso el inicio de sesión se probó con la configuración de desarrollo. Queda
  como una comprobación posible y pendiente, no como algo imposible.
  Independiente de eso, la configuración de producción **sí está probada donde
  importa**: en el propio despliegue de Render, con HTTPS real (Paso 8 y las
  pruebas de navegador).
- **Fueron pruebas HTTP, no de navegador.** Describen lo que hace el servidor.
  Las de navegador, con cookies reales, están más arriba y se hicieron contra
  Render.
- **El respaldo no tiene datos reales**: esquema, catálogos y una cuenta. No
  prueba el rendimiento ni el tiempo de restauración con miles de inscripciones.
- **Los catálogos extensibles salieron vacíos** (`category-groups`, `events`,
  `pools`) porque el seed no los crea: los llena el administrador. Que devuelvan
  **200 con 0 elementos** es lo correcto, no un fallo.
- **No se probó el sistema completo**: se comprobaron autenticación y catálogos,
  no la importación de competencias, la carga masiva de personas ni los
  informes.

### No comprobado

- **La rutina de respaldo como rutina.** El **procedimiento** está ensayado de
  principio a fin —crear la exportación, descargarla, restaurarla y levantar la
  aplicación encima—, pero **se ha ejecutado una sola vez, a mano, el 29 de
  octubre**. No hay todavía una rutina que se repita, ni responsable asignado,
  ni ninguna copia conservada bajo la retención de 30 días. **Saber restaurar no
  es lo mismo que tener respaldos.**
- **La restauración sobre una base de Render.** El **ensayo sí está hecho** (ver
  más arriba): el archivo descargado se restauró completo en una base desechable
  y se verificó. Lo que no se ha hecho es apuntar `pg_restore` a una base de
  Render con `--clean --if-exists`, que es el camino de la recuperación real. Es
  deliberado: ese camino reemplaza objetos y no se ensaya contra la base
  operativa.
- **Un respaldo con datos reales.** El ensayo se hizo con una base que solo tiene
  esquema, catálogos y una cuenta. Un respaldo con miles de inscripciones pesará
  mucho más y tardará más, aunque el procedimiento sea el mismo.
- **El sistema completo sobre el respaldo.** Se levantó la aplicación contra la
  base restaurada y se comprobaron arranque, sesión y catálogos (ver más
  arriba), pero **no** la importación de competencias, la carga masiva de
  personas ni los informes.
- **La autoridad que emite el certificado HTTPS.** El candado aparece válido en
  el navegador, pero **no se registró el emisor**. En la red desde la que se
  probó hay inspección TLS corporativa, así que el certificado que el navegador
  muestra ahí **es el de la autoridad corporativa, no el de Render**. Para ver el
  verdadero hay que repetir la comprobación desde una red sin inspección.
- **El comportamiento en otros navegadores.** Lo de las cookies de terceros **ya
  está comprobado** (punto 7 de arriba), pero en **un solo navegador**, el del
  administrador. No se registró cuál era, así que tampoco se puede afirmar qué
  motor se probó. Safari, en particular, aplica sus propias reglas. Con el proxy
  no debería haber diferencia, porque la cookie es **de primera parte** y
  ninguna política de terceros la alcanza; aun así, conviene que alguien con Mac
  o iPhone repita la secuencia del Paso 8 y lo confirme.
- **Si guardar el campo *Docker Command* dispara un despliegue o una ejecución.**
  Observado cuatro veces que no añade ejecuciones, pero **no está documentado**
  (ver el recuadro del Paso 6.b). El procedimiento está escrito para que esa
  incógnita no importe.
- **Si suspender un cron job impide sus ejecuciones programadas.** La
  documentación de Render no lo dice, así que esta guía **no** se apoya en ello:
  usa `Auto-Deploy: Off`, que sí está documentado.
- **Que el calendario del cron job se dispare como se espera.** El próximo
  `0 6 1 1 *` es el 1 de enero. Lo que correrá entonces es el comando inocuo de
  la imagen, pero eso **tampoco está observado todavía**: conviene mirar *Runs*
  el 1 de enero y confirmar que lo que se ejecutó fue el mensaje en reposo.
- **Si 512 MB le bastan a la API.** Es una estimación; el salto siguiente es
  US$25/mes.
- **El consumo real** de tráfico, almacenamiento y minutos de construcción, y por
  tanto si habrá excedentes sobre el estimado de US$21,30.

---

## Qué falta decidir, ya desplegado

Las dos decisiones que había antes de desplegar —plan de pago y cookies— están
tomadas: todo va en planes de pago y el proxy del Paso 7 resolvió las cookies.
Lo que queda abierto es esto, por orden de urgencia:

1. **Designar al suplente del respaldo, y confirmar la frecuencia.** La vía está
   decidida —**exportaciones manuales desde Render, descargadas y conservadas 30
   días**—, el **responsable ya está asignado** y el procedimiento está escrito y
   ensayado en el Paso 9B. Faltan tres cosas:
   - **El suplente.** Es lo más urgente: hoy la rutina se detiene por completo
     en cualquier ausencia del responsable, y nada lo señala.
   - **La frecuencia.** El Paso 9B indica qué pérdida máxima cubre cada opción,
     para que la elección se haga sabiendo qué se está eligiendo.
   - **Quién revisa que se hizo**, alguien distinto del responsable. Al ser
     manual, **nada avisa si se deja de hacer**, y esa revisión es lo único que
     sustituye al aviso automático.
2. **El tamaño del almacenamiento de la base.** Está en **1 GB**, que sobra para
   empezar porque solo guarda texto, pero **se puede subir y no se puede
   bajar**. Hay que mirarlo antes de cargar varios años de histórico. Cada GB son
   US$0,30 al mes.
3. **Quién recibe los avisos de caída.** Render comprueba la salud **al
   desplegar**, no de forma continua. No hay ninguna monitorización configurada.
4. **Quitar la dependencia del espacio de nombres interno de Render.** Hoy
   `API_INTERNA` lleva el nombre completo `…svc.cluster.local` porque el
   resolutor de Nginx no aplica las *search domains* (Paso 7). Funciona, pero
   incorpora un detalle de la infraestructura de Render que ellos no garantizan.
   **La mejora**: en `default.conf.template`, pasar el destino a `proxy_pass` de
   forma literal en vez de por variable, para que resuelva el sistema operativo
   —que sí aplica los sufijos— y el nombre corto baste. El precio es perder la
   reresolución en cada petición, que es justo lo que hoy permite seguir a la API
   cuando cambia de dirección; habría que evaluar cuál de los dos problemas pesa
   más. **No es urgente**: el síntoma, si algún día aparece, es un 502 con el
   error exacto en los registros y el arreglo es cambiar una variable.
5. **Un dominio propio**: deseable por imagen y continuidad, pero ya no hace
   falta para nada técnico. Ver «Un dominio propio: mejora posterior, no
   requisito».
6. **Si en algún momento se automatiza el respaldo.** Se evaluó, se preparó y se
   probó; se decidió aplazarlo. Costaría **US$1 más al mes** y lo que aportaría
   no es ahorro de esfuerzo sino **una alarma cuando el respaldo deja de
   ocurrir**. Ver «El respaldo automático: evaluado y aplazado» en el Paso 9B.
