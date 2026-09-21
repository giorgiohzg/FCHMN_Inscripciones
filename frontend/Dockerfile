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

ARG NODE_VERSION=22-alpine
ARG NGINX_VERSION=1.27-alpine

# BASES FIJADAS POR DIGEST.
#
# Una etiqueta se mueve. Medido el 2026-09-20: `node:22-alpine` apuntaba en el
# registro a `b6f26b36…`, mientras que las imágenes verificadas en las Fases 4
# y 5 se habían construido sobre `c610fcdf…`. Construir «la misma etiqueta» dos
# veces puede dar dos imágenes distintas, y entonces el inventario de avisos
# deja de describir lo que se distribuye.
#
# NODE_DIGEST conserva el digest ya verificado, para que la capa de Node siga
# siendo exactamente la auditada. NGINX_DIGEST fija el índice publicado el
# 2026-09-20; NO está probado que sea el de la imagen anterior, porque esa
# imagen no registra su base. Al reconstruir cambiarán versiones de paquetes
# del sistema, y por eso el inventario debe volver a extraerse y verificarse
# contra la nueva candidata.
ARG NODE_DIGEST=sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
ARG NGINX_DIGEST=sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10

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

# La plantilla se procesa con `envsubst` al arrancar (mecanismo propio de la
# imagen oficial de Nginx: todo lo que esté en /etc/nginx/templates/*.template).
# `NGINX_ENVSUBST_FILTER` restringe la sustitución a PORT; sin él, `envsubst`
# vaciaría también `$uri`, `$host` y demás variables de Nginx.
ENV PORT=80
ENV NGINX_ENVSUBST_FILTER=PORT

COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

# AVISOS DE TERCEROS. Llegan por un CONTEXTO DE CONSTRUCCIÓN ADICIONAL llamado
# `avisos`, porque viven en la raíz del repositorio y el contexto de esta imagen
# es ./frontend. Así no hay que ampliar el contexto ni duplicar archivos.
#
#   docker compose build frontend
#   docker buildx build --build-context avisos=./notices ...
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
COPY --from=avisos frontend-web.txt /usr/share/nginx/html/third-party-notices.txt
COPY --from=avisos frontend-image.txt /usr/share/licenses/THIRD-PARTY-NOTICES.txt
# El corpus acompana al aviso de la IMAGEN, no al que se sirve por HTTP: el
# navegador solo recibe el codigo web, no el sistema operativo.
COPY --from=avisos licencias /usr/share/licenses/licencias

EXPOSE 80

# El healthcheck también sigue al puerto configurado.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${PORT}/" || exit 1

CMD ["nginx", "-g", "daemon off;"]
