# Extraer el inventario de avisos desde las imágenes

El inventario se extrae de las **imágenes construidas**, no del árbol de
desarrollo. La razón es simple: lo que obliga es lo que se distribuye. Un
`node_modules` local puede contener dependencias de desarrollo que nunca viajan,
y una imagen puede contener capas base que el árbol local no tiene.

`scripts/inventario/extraer-de-imagen.cjs` se ejecuta **dentro** de cada imagen,
en solo lectura y sin red. Lee tres cosas:

- los árboles `node_modules` que se le indiquen, con el texto de licencia de cada
  paquete;
- `/lib/apk/db/installed`, la base de datos de paquetes del sistema;
- los componentes sueltos que aportan las imágenes base (Node.js, Yarn, nginx y
  sus módulos).

## Procedimiento

Las tres imágenes con Node se extraen montando la sonda:

```bash
docker run --rm --network none --read-only \
  --mount type=bind,source="$PWD/scripts/inventario/extraer-de-imagen.cjs",target=/s.cjs,readonly \
  --entrypoint node fchmn_inscripciones-backend:latest \
  /s.cjs backend /app/node_modules > /tmp/backend.json
```

```bash
docker run --rm --network none --read-only \
  --mount type=bind,source="$PWD/scripts/inventario/extraer-de-imagen.cjs",target=/s.cjs,readonly \
  --entrypoint node fchmn_inscripciones-migrate:latest \
  /s.cjs migrate /app/node_modules /opt/prisma-cli/node_modules > /tmp/migrate.json
```

La imagen del frontend **no tiene Node**, así que su base de apk y los
`COPYRIGHT` de nginx se extraen con `tar` y se analizan fuera:

```bash
docker run --rm --network none --entrypoint tar fchmn_inscripciones-frontend:latest \
  -cf - /lib/apk/db/installed /usr/share/licenses > /tmp/frontend.tar
```

`frontend-web` se compone del cierre de dependencias de producción del frontend,
que es lo único que acaba en el paquete enviado al navegador:

```bash
cd frontend && npm ls --omit=dev --all --json
```

En Windows, `git-bash` convierte las rutas POSIX de los argumentos a rutas de
Windows y la sonda no se encuentra. Anteponer `MSYS_NO_PATHCONV=1`.

## Después de extraer

Los metadatos van a `notices/inventario/<artefacto>.json` y los textos a
`notices/textos/<sha256>.txt`, deduplicados por hash. Luego:

```bash
node scripts/generar-avisos.mjs
```

## El campo `c:` y por qué importa

La sonda captura, de cada paquete del sistema, el campo `c:` de la base de apk:
el **commit de aports con el que se construyó ese binario**, conservado dentro
del propio artefacto. `scripts/generar-sources.mjs` lo usa como fuente de verdad.

La alternativa —consultar qué versión publica hoy la rama— no sirve. En la
resolución del 2026-09-20, **27 de los 87 paquetes consultados** ya tenían en su
rama una versión más nueva que la distribuida: para esos, el commit de la rama
identifica un código que **no** es el del binario entregado. Con el campo `c:`
el problema desaparece, porque el dato viaja con el artefacto.

Los cinco paquetes de nginx **no** llevan `c:`: proceden de nginx.org, no de
aports. Se registran aparte, en `fuentesNoAlpine`.

## Tras una reconstrucción

Cuando se reconstruyan las imágenes con las bases fijadas por digest, el
inventario **debe volver a extraerse** y verificarse contra la nueva candidata.
No se asume a partir de una imagen anterior: las ramas de Alpine siguen
recibiendo correcciones, y al fijar un digest distinto cambian las versiones de
los paquetes del sistema.

El procedimiento completo, con sus dos pasadas, está en
[`construir-y-revalidar.md`](construir-y-revalidar.md).
