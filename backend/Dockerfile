# =============================================================================
# API de inscripciones — imagen multi-stage.
#
# `docker-compose.yml` declaraba `build: context: ./backend` y este archivo NO
# EXISTÍA: `docker compose up` fallaba siempre. Aquí está, con tres etapas para
# que la imagen final no cargue con el compilador ni con las dependencias de
# desarrollo.
#
# La etapa `migrate` existe porque el despliegue necesita el CLI de Prisma
# —que es una dependencia de DESARROLLO— y la imagen de ejecución no debe
# tenerlo. Compose usa esa etapa para un contenedor efímero que migra y siembra
# datos de referencia, y luego arranca `runtime`, que solo sabe servir.
# =============================================================================

ARG NODE_VERSION=22-alpine

# BASE FIJADA POR DIGEST.
#
# Una etiqueta se mueve. Medido el 2026-09-20: `node:22-alpine` apuntaba ya en
# el registro a `b6f26b36…`, mientras que las imagenes verificadas en las Fases
# 4 y 5 se construyeron sobre `c610fcdf…`. Se conserva ESE digest para que la
# capa base siga siendo exactamente la auditada; cambiarlo obliga a repetir la
# verificacion y a volver a extraer el inventario de avisos.
ARG NODE_DIGEST=sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

# --- Base común: Node con OpenSSL 3 ------------------------------------------
#
# POR QUÉ HACE FALTA OPENSSL.
#
# El motor de consultas de Prisma es una biblioteca nativa que enlaza contra
# OpenSSL. Prisma elige cuál copiar mirando la versión que encuentra en el
# sistema, y en una imagen Alpine SIN el paquete `openssl` no encuentra
# ninguna: avisa («failed to detect the libssl/openssl version to use») y
# recurre a `openssl-1.1.x`, que es la variante equivocada. El contenedor
# arrancaba, servía el puerto y moría al inicializar Prisma:
#
#   Unable to require(`…/libquery_engine-linux-musl.so.node`)
#   Error loading shared library libssl.so.1.1: No such file or directory
#
# `node:22-alpine` trae OpenSSL 3, pero solo la biblioteca compartida; basta
# instalar el paquete para que la detección funcione y Prisma genere el motor
# `linux-musl-openssl-3.0.x`. Se instala UNA sola vez, aquí, y de esta etapa
# heredan `build`, `deps` y `runtime`: así las tres comparten exactamente el
# mismo sistema base y la misma capa.
#
# No se declara `binaryTargets` en `schema.prisma` a propósito: con OpenSSL
# presente, la detección automática acierta, y fijarlo a mano obligaría a
# mantener una lista de destinos en paralelo a la imagen.
#
# `apk` NO recibe el certificado corporativo. La inspección TLS de esta red es
# selectiva: alcanza al registro npm pero no al CDN de Alpine, que presenta su
# certificado auténtico de Let's Encrypt. Darle el paquete a `apk` sería peor
# que inútil, porque `/etc/apk/ca.pem` SUSTITUYE el almacén de autoridades en
# lugar de ampliarlo y dejaría de confiar en el CDN.
FROM node:${NODE_VERSION}@${NODE_DIGEST} AS base
RUN apk add --no-cache openssl

# --- Dependencias completas + compilación ------------------------------------
FROM base AS build
WORKDIR /app

# `npm ci` exige el lockfile y lo respeta al pie de la letra: la imagen se
# construye con las MISMAS versiones que se probaron, no con lo que resuelva
# el registro ese día.
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
# `--no-audit --no-fund`: `npm ci` consulta el servicio de auditoría del
# registro por omisión. Una construcción no debe hacer esa consulta —ni
# depender de ella, ni filtrar el árbol a un tercero—; la auditoría es un paso
# deliberado y aparte. `--no-fund` solo calla un mensaje.
#
# NO se usa `--ignore-scripts`: los scripts de instalación forman parte de lo
# que se está construyendo, y `@prisma/client` genera su cliente en uno.
RUN --mount=type=secret,id=npm_ca \
    sh -c 'if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; npm ci --no-audit --no-fund'

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY tsconfig.seed.json ./
COPY src ./src
RUN npm run build

# Seeds compilados a JavaScript, para que la imagen `migrate` no necesite
# `tsx`. `tsconfig.seed.json` toma como entradas SOLO los dos seeds;
# TypeScript arrastra sus importaciones transitivas y nada mas.
#
# Se invoca el binario por ruta directa, no con `npx`: aqui `typescript` ya
# esta instalado y `npx` solo anadiria una resolucion innecesaria.
RUN ./node_modules/.bin/tsc -p tsconfig.seed.json

# --- Solo dependencias de producción -----------------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Mismo secreto opcional que en la etapa `build`: ver la explicación de arriba.
#
# `--omit=optional` ADEMÁS de `--omit=dev`, y esto no es cosmético.
#
# `npm ci --omit=dev` NO omite lo marcado `devOptional`. npm poda por las
# banderas booleanas del nodo —`dev`, `optional`, `peer`— y una entrada
# `devOptional` no tiene ninguna de las tres en `true`: significa alcanzable por
# la rama de desarrollo Y por la rama opcional. `prisma` es `devDependency` de
# la raíz y, a la vez, par OPCIONAL de `@prisma/client`, que sí es de
# producción. Resultado: el CLI de Prisma y sus cinco paquetes asociados
# —unos 46 MiB— llegaban a `runtime` y a `migrate`, donde nadie los usa.
#
# Medido instalando este mismo lockfile en aislamiento: `--omit=dev` deja 281
# paquetes; `--omit=dev --omit=optional` deja 275. La diferencia es exactamente
# esos seis y el enlace `.bin/prisma`. Las 15 dependencias directas de
# producción siguen instaladas. `fsevents`, el único `optional` puro, es de
# darwin y nunca se materializaba en Linux.
RUN --mount=type=secret,id=npm_ca \
    sh -c 'if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; npm ci --omit=dev --omit=optional --no-audit --no-fund'

# GUARDIA B, inmediatamente después de instalar. Comprueba por RUTA, NOMBRE y
# VERSIÓN que lo instalado es exactamente lo que el lockfile declara sin marcas
# de omisión, que nada marcado se coló, y que `.bin` y `.prisma` no se cuentan
# como paquetes. Falla cerrada: si no puede leer lo que necesita, detiene la
# construcción en lugar de aprobar.
COPY scripts/verificar-arbol-instalado.mjs ./scripts/
RUN node scripts/verificar-arbol-instalado.mjs --raiz /app

# Aquí NO se ejecuta `prisma generate`: el CLI de Prisma acaba de quedar fuera
# por `--omit=optional`. `npx` intentaría descargarlo del registro npm durante
# el build —lento, y dependiente de la red—, y si esa descarga falla el error
# aparece a mitad de la construcción sin relación aparente con la causa. El
# cliente ya se generó en la etapa `build`, con la versión EXACTA del lockfile;
# se copia desde allí.

# --- Imagen final ------------------------------------------------------------
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production

# AVISOS DE TERCEROS. Llegan por un CONTEXTO DE CONSTRUCCION ADICIONAL llamado
# `avisos`, porque viven en la raiz del repositorio y el contexto de esta imagen
# es ./backend. Asi no hay que ampliar el contexto ni duplicar archivos.
#
#   docker compose build backend
#   docker buildx build --build-context avisos=./notices ...
#
# El aviso es AUTOSUFICIENTE: cubre las dependencias Node, los paquetes del
# sistema de la capa base y los componentes que aporta la imagen de Node. No
# remite a ningun otro archivo.
COPY --from=avisos backend.txt /usr/share/licenses/THIRD-PARTY-NOTICES.txt
# El CORPUS de textos. Un identificador SPDX no es un aviso: Alpine no incluye
# los textos dentro de sus paquetes binarios, asi que se entregan aqui, en la
# misma ruta a la que remite el aviso.
COPY --from=avisos licencias /usr/share/licenses/licencias

# `node` es un usuario sin privilegios que la imagen base ya trae.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules

# El cliente de Prisma generado en `build`, encima de las dependencias de
# producción. Son los artefactos que `@prisma/client` carga en ejecución: el
# cliente tipado y el motor de consultas nativo.
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=node:node /app/node_modules/@prisma/client ./node_modules/@prisma/client

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node prisma ./prisma

USER node
EXPOSE 3000

# Vivacidad, no disponibilidad: `/health` no consulta la base a propósito, así
# que una base caída no provoca el reinicio de un proceso que está sano. La
# disponibilidad (`/ready`) la mira Compose en su propio healthcheck.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/health || exit 1

# Solo sirve. Migrar y sembrar son pasos aparte, deliberadamente: ver el
# servicio `migrate` en docker-compose.yml.
CMD ["node", "dist/server.js"]

# --- CLI de Prisma, aislado y con su propio lockfile -------------------------
#
# `prisma` es `devOptional` en el lockfile principal, y la etapa `deps` lo
# excluye con `--omit=dev --omit=optional`. Por eso el CLI vive en su propio
# manifiesto, donde es una dependencia de PRODUCCION declarada con version
# exacta y lockfile propio, instalado FUERA del `node_modules` de la
# aplicacion.
#
# CORRECCION. Aqui se afirmaba que `--omit=dev` ya omitia lo `devOptional` y
# que no habia combinacion de banderas capaz de conservarlo omitiendo `dev`.
# Las dos cosas eran falsas: `--omit=dev` NO lo omitia —el CLI viajaba
# duplicado en `/app/node_modules` y en `/opt/prisma-cli`— y `--omit=optional`
# si lo omite. Con la etapa `deps` corregida, esta etapa deja de ser un
# duplicado y pasa a ser la unica fuente del CLI.
FROM base AS cli-migrate
WORKDIR /opt/prisma-cli
COPY docker/migrate-cli/package.json docker/migrate-cli/package-lock.json ./
RUN --mount=type=secret,id=npm_ca \
    sh -c 'if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; npm ci --omit=dev --no-audit --no-fund'

# --- Herramientas de despliegue (migraciones y seed) -------------------------
#
# Contiene las dependencias de PRODUCCION, el CLI de Prisma aislado en
# /opt/prisma-cli y los seeds ya compilados a JavaScript. No lleva
# `package.json`, de modo que `prisma db seed` no existe como camino.
#
# Comandos admitidos, los tres explicitos:
#
#   prisma migrate deploy --schema=/app/prisma/schema.prisma
#   node dist-seed/prisma/seed.js
#   node dist-seed/prisma/seed-admin.js
#
# Los artefactos quedan en root:root con sus modos de origen. `node` solo
# necesita LEER y EJECUTAR: no se le da propiedad, no se ejecuta `chmod` ni
# `chown`, y no se crea ningun directorio escribible bajo /app ni
# /opt/prisma-cli. Si Prisma necesitara cache temporal, debe usar una
# ubicacion propia del usuario o /tmp, nunca el artefacto distribuido.
FROM base AS migrate
WORKDIR /app

# AVISOS DE TERCEROS, por el mismo contexto adicional `avisos`.
#
# `migrate.txt` es AUTOSUFICIENTE: reproduce entero el arbol de 239 paquetes que
# comparte con `runtime`, y ademas los 6 del CLI de Prisma aislado y los
# paquetes del sistema. NO remite a `backend.txt`. La deduplicacion es una
# tecnica del generador; el artefacto entregado no depende de otro.
COPY --from=avisos migrate.txt /usr/share/licenses/THIRD-PARTY-NOTICES.txt
COPY --from=avisos licencias /usr/share/licenses/licencias

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/dist-seed ./dist-seed
COPY --from=cli-migrate /opt/prisma-cli /opt/prisma-cli

# Solo el esquema y las migraciones: ni los `.ts` de los seeds ni el resto de
# `prisma/`.
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY prisma/migrations ./prisma/migrations

# `prisma` se resuelve por PATH. Nunca `npx`, que intentaria descargarlo del
# registro durante la ejecucion.
ENV PATH=/opt/prisma-cli/node_modules/.bin:$PATH

# NODE_ENV no se hereda: la imagen base solo define PATH, NODE_VERSION y
# YARN_VERSION.
ENV NODE_ENV=production

# La imagen base no declara USER: sin esta linea la etapa correria como root.
USER node

CMD ["prisma", "migrate", "deploy", "--schema=/app/prisma/schema.prisma"]
