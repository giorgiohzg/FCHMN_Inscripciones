# =============================================================================
# Interfaz web — build con Node, servida por Nginx.
#
# Sustituye a `npx serve dist` de Instructivo_Instalacion_Nube.md, que dependía
# de descargar un paquete desde el registro npm en cada arranque y no servía la
# aplicación como SPA.
#
# VITE_API_URL SE FIJA AL CONSTRUIR, no al ejecutar.
# ---------------------------------------------------------------------------
# Vite reemplaza `import.meta.env.VITE_API_URL` por su valor literal dentro del
# bundle: para cuando Nginx sirve los archivos, la URL ya es texto dentro del
# JavaScript. Poner la variable en `environment:` del contenedor NO cambia nada
# —el bundle ya está escrito— y esa es justamente la confusión que hay que
# evitar. Por eso se declara como ARG y se pasa con `--build-arg`, y por eso
# apuntar a otro backend exige RECONSTRUIR la imagen.
# =============================================================================

ARG NODE_VERSION=22.23.4-alpine3.24
ARG NGINX_VERSION=1.30.6-alpine3.24

# BASES FIJADAS POR DIGEST.
#
# Una etiqueta se mueve. Medido el 2026-09-20: `node:22-alpine` apuntaba en el
# registro a `b6f26b36…`, mientras que las imágenes verificadas en las Fases 4
# y 5 se habían construido sobre `c610fcdf…`. Construir «la misma etiqueta» dos
# veces puede dar dos imágenes distintas, y entonces el inventario de avisos
# deja de describir lo que se distribuye.
#
# Al reconstruir sobre un digest distinto cambian las versiones de los paquetes
# del sistema, y por eso el inventario debe volver a extraerse y verificarse
# contra la nueva candidata.
#
# AUD-B (2026-11-08): Node pasa de 22.23.2 (`c610fcdf…`) a 22.23.4 (version de
# seguridad de la rama 22 LTS, nodejs.org, 2026-10-20) y Nginx de 1.27.5
# (`65645c7b…`, rama que el fabricante ya no evalua) a 1.30.6, la ultima
# ESTABLE (nginx.org), sobre Alpine 3.24.4. No se migra a Node 24 ni a la
# rama mainline de Nginx. Etiqueta y digest son los del INDICE multiplataforma
# de las imagenes oficiales de Docker Hub, verificados descargando cada imagen
# por digest y leyendo `NODE_VERSION` y `NGINX_VERSION`; al subir una version
# hay que actualizar ETIQUETA Y DIGEST juntos.
ARG NODE_DIGEST=sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202
ARG NGINX_DIGEST=sha256:583b7f2fce1cdb8da5ad5c39ebd3c33b98b87d493190e548bdee1fa8c619c311

# --- Compilación -------------------------------------------------------------
FROM node:${NODE_VERSION}@${NODE_DIGEST} AS build
WORKDIR /app

COPY package.json package-lock.json ./

# AUTORIDAD ADICIONAL PARA REDES CON INSPECCIÓN TLS.
#
# En una red que descifra y vuelve a cifrar el tráfico, el certificado que
# presenta el registro npm lo firma una autoridad corporativa que el almacén de
# la imagen no conoce, y `npm ci` falla con UNABLE_TO_GET_ISSUER_CERT_LOCALLY
# —enmascarado, además, por el defecto «Exit handler never called!» de npm.
#
# El certificado entra como SECRETO DE CONSTRUCCIÓN, no por ARG, ENV, COPY ni
# ADD: un montaje `type=secret` no queda en la imagen, ni en sus capas, ni en
# los metadatos, ni en la caché de construcción.
#
# El montaje es OPCIONAL (`required=false` es el valor por omisión): en una red
# sin inspección, sin pasar el secreto, la condición no se cumple y `npm ci`
# corre exactamente igual que antes.
#
#   docker buildx build --secret id=npm_ca,src=<ruta al PEM> ...
#
# `--no-audit --no-fund`: alinea esta etapa con los tres `npm ci` del backend.
# `npm ci` consulta por omisión el servicio de auditoría del registro; una
# construcción no debe hacer esa consulta, ni depender de ella, ni filtrar el
# árbol a un tercero. La auditoría es un paso deliberado y aparte.
#
# ESTO NO RESUELVE TLS. Quitar una consulta de red no sustituye al certificado:
# si la red descifra y vuelve a cifrar el tráfico, `npm ci` sigue necesitando la
# autoridad corporativa, que entra por el montaje de secreto de arriba. Ambas
# cosas son independientes.
RUN --mount=type=secret,id=npm_ca \
    sh -c 'if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; npm ci --no-audit --no-fund'

# El valor por omisión sirve para una prueba local; cualquier otro despliegue
# debe pasarlo explícitamente:
#   docker compose build --build-arg VITE_API_URL=https://api.ejemplo.cl frontend
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=${VITE_API_URL}

COPY . .
RUN npm run build

# --- Servido estático --------------------------------------------------------
FROM nginx:${NGINX_VERSION}@${NGINX_DIGEST} AS runtime

# ZLIB DEL SISTEMA, CON UN MÍNIMO EXPLÍCITO (como en la base de la API).
#
# La base fijada trae `zlib` 1.3.2-r1; Alpine 3.24 publica 1.4-r0 (`secfixes`:
# CVE-2026-4738). Se actualiza SOLO ese paquete, sin `apk upgrade` general, y el
# mínimo impide la versión antigua. La versión obtenida queda en el inventario
# extraído de la imagen; Alpine solo sirve la última revisión de la rama.
RUN apk add --no-cache 'zlib>=1.4-r0'

# La plantilla se procesa con `envsubst` al arrancar (mecanismo propio de la
# imagen oficial de Nginx: todo lo que esté en /etc/nginx/templates/*.template).
# `NGINX_ENVSUBST_FILTER` restringe la sustitución a las DOS variables que la
# plantilla espera; sin él, `envsubst` vaciaría también `$uri`, `$host`,
# `$proxy_add_x_forwarded_for` y demás variables de Nginx.
#
# El filtro es una expresión regular que se compara con el NOMBRE de cada
# variable del entorno. Va anclada (`^...$`) para que no alcance por accidente a
# cualquier otra que contenga esas palabras.
#
# El filtro admite TRES variables: PORT, API_INTERNA y CSP_CONNECT_SRC (la lista
# de orígenes de `connect-src` de la cabecera Content-Security-Policy). Las
# demás —`$uri`, `$host`, `$esquema_original`…— son de Nginx y no se tocan.
ENV PORT=80
ENV NGINX_ENVSUBST_FILTER="^(PORT|API_INTERNA|CSP_CONNECT_SRC)$"

# DIRECCIÓN INTERNA DE LA API, para el proxy de `/api`.
#
# El valor por omisión es el del entorno local con Docker Compose, donde la API
# es el servicio `backend` y escucha en 3000. En la nube se sobrescribe con la
# dirección interna que dé el proveedor, como variable del servicio: el nombre
# no está escrito en ningún archivo del repositorio.
#
# No lleva esquema: la plantilla antepone `http://`. El tráfico entre servicios
# va por la red privada del proveedor, donde no hay TLS que terminar.
ENV API_INTERNA=backend:3000

COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template

# CONFIGURACIÓN PRINCIPAL Y RECEPTOR DE ERRORES DE PETICIÓN (AUD-03, capa Nginx).
#
# `nginx.conf` es el de la imagen oficial sin cambios, más la carga del módulo njs de `stream` (ya
# instalado en esta imagen, `nginx-module-njs`) y un servidor UDP solo en 127.0.0.1 que recibe por
# syslog los errores de petición y escribe en stderr únicamente campos de una lista cerrada (ver
# `nginx/njs/registro-errores.js`). Sin paquetes ni procesos nuevos y sin puertos publicados.
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/njs/registro-errores.js /etc/nginx/njs/registro-errores.js

# CABECERAS DE SEGURIDAD DEL FRONTEND (Fase 3) y su `connect-src`.
#
# CSP_CONNECT_SRC lista los orígenes a los que el navegador puede llamar con
# `fetch`. Se aplica al ARRANCAR (como API_INTERNA), pero DEBE SER COHERENTE con
# `VITE_API_URL`, que se fijó al CONSTRUIR:
#
#   VITE_API_URL=/api  (la API bajo el mismo origen, como en la nube)
#                         → CSP_CONNECT_SRC="'self'"   (el valor por omisión)
#   VITE_API_URL=http://localhost:3000  (Docker Compose, otro origen)
#                         → CSP_CONNECT_SRC="'self' http://localhost:3000"
#
# No lo confunda con API_INTERNA: esa es la dirección que usa ESTE Nginx, por la
# red privada, para reenviar `/api`; CSP_CONNECT_SRC es la que usa el NAVEGADOR.
#
# `API_URL_COMPILADA` guarda el valor que se compiló en el bundle (ya es texto
# visible en el JavaScript, no un secreto) para que el arranque compruebe la
# coherencia y falle con un mensaje claro en vez de dejar una web que carga y no
# puede llamar a la API. Ver nginx/18-validar-csp.sh.
ARG VITE_API_URL=http://localhost:3000
ENV API_URL_COMPILADA=${VITE_API_URL}
ENV CSP_CONNECT_SRC="'self'"
COPY nginx/snippets/cabeceras-seguridad.conf.template /etc/nginx/templates/snippets/cabeceras-seguridad.conf.template
COPY --chmod=0755 nginx/18-validar-csp.sh /docker-entrypoint.d/18-validar-csp.sh

# Escribe la directiva `resolver` al arrancar, leyendo /etc/resolv.conf. Hace
# falta porque el destino del proxy se pasa por una variable de Nginx, que es lo
# que permite seguir al backend cuando cambia de dirección. El propio guion
# explica el porqué con detalle.
#
# La imagen oficial ejecuta /docker-entrypoint.d/*.sh en orden; el `25-` lo deja
# después del `20-` que completa la plantilla.
COPY --chmod=0755 nginx/25-resolver.sh /docker-entrypoint.d/25-resolver.sh
COPY --from=build /app/dist /usr/share/nginx/html

# AVISOS DE TERCEROS. Llegan desde `frontend/avisos/`, que está DENTRO del
# contexto de esta imagen.
#
# Antes llegaban por un CONTEXTO DE CONSTRUCCIÓN ADICIONAL llamado `avisos`
# (`COPY --from=avisos ...`), que apuntaba a `notices/` en la raíz del
# repositorio. Eso funciona con `docker compose` y con `docker buildx
# --build-context`, pero NO con las plataformas que construyen desde un
# repositorio Git: solo ofrecen un contexto —el directorio raíz del servicio— y
# la construcción se detenía en esta misma línea.
#
# `notices/` sigue siendo la única fuente de verdad. `frontend/avisos/` es una
# copia byte a byte del subconjunto distribuible, escrita y verificada por
# `scripts/distribuir-avisos.mjs`:
#
#   node scripts/distribuir-avisos.mjs             actualiza las copias
#   node scripts/distribuir-avisos.mjs --verificar falla si divergen
#
# Son DOS destinos con dos alcances distintos, y la diferencia importa:
#
#   third-party-notices.txt  se SIRVE por HTTP. Cubre solo las dependencias que
#                            viajan en el HTML, el CSS y el JavaScript, que es
#                            lo único que se entrega al navegador.
#
#   /usr/share/licenses/...  NO se sirve. Cubre toda la imagen —servidor web,
#                            módulos y paquetes del sistema— y acompaña a quien
#                            reciba la imagen, no a quien visita la web.
COPY avisos/frontend-web.txt /usr/share/nginx/html/third-party-notices.txt
COPY avisos/frontend-image.txt /usr/share/licenses/THIRD-PARTY-NOTICES.txt
# El corpus acompana al aviso de la IMAGEN, no al que se sirve por HTTP: el
# navegador solo recibe el codigo web, no el sistema operativo.
COPY avisos/licencias /usr/share/licenses/licencias

EXPOSE 80

# El healthcheck también sigue al puerto configurado.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${PORT}/" || exit 1

CMD ["nginx", "-g", "daemon off;"]
