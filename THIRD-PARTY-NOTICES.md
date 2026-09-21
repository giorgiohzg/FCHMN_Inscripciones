# Avisos de terceros

El software de FCHMN es **propietario** y se distribuye bajo los términos de su
propio [LICENSE](LICENSE). Ese archivo **no cubre** los componentes de terceros
que acompañan al producto: cada uno se rige por su propia licencia, y este
directorio las reproduce.

Los avisos **se generan**, no se editan a mano:

```bash
node scripts/generar-avisos.mjs
```

## Cuatro avisos, cuatro destinatarios

Cada archivo es **autosuficiente**: incluye todo lo necesario para entenderlo y
no remite a ningún otro, aunque compartan componentes. La deduplicación ocurre
en el generador, nunca en el artefacto entregado.

| Aviso | Cubre | Llega a |
|---|---|---|
| [`notices/frontend-web.txt`](notices/frontend-web.txt) | Las 9 dependencias presentes en el HTML, CSS y JavaScript | El navegador de cada persona usuaria |
| [`notices/frontend-image.txt`](notices/frontend-image.txt) | Todo lo de la imagen: nginx, sus 4 módulos, 68 paquetes Alpine y el aviso web | Quien reciba la imagen |
| [`notices/backend.txt`](notices/backend.txt) | 239 dependencias Node, 19 paquetes Alpine, Node.js y Yarn | Quien reciba la imagen |
| [`notices/migrate.txt`](notices/migrate.txt) | Lo anterior más los 6 paquetes del CLI de Prisma aislado | Quien reciba la imagen |

`frontend-web.txt` se sirve como archivo estático y se enlaza desde la
interfaz. `frontend-image.txt` viaja **dentro** de la imagen, pero no se expone
como si su contenido se enviara al navegador: el servidor web y las capas del
sistema operativo se quedan en el servidor.

## Manifiestos

| Archivo | Qué registra |
|---|---|
| [`notices/inventario/`](notices/inventario/) | Los hechos extraídos de cada imagen: paquete, versión, expresión de licencia, archivos de licencia y sus SHA-256 |
| [`notices/textos/`](notices/textos/) | Los textos tal como viajan en los artefactos, deduplicados por SHA-256 |
| [`notices/textos-canonicos/`](notices/textos-canonicos/) | Textos canónicos SPDX, usados **solo** por excepción declarada |
| [`notices/excepciones.json`](notices/excepciones.json) | Los casos que no se resuelven leyendo el artefacto, con qué se verificó y qué no |
| [`notices/procedencia.json`](notices/procedencia.json) | De dónde salió cada **texto** recuperado: URL, etiqueta, commit y SHA-256 |
| [`notices/sources.json`](notices/sources.json) | De dónde sale el **código fuente** de cada componente copyleft, y el mecanismo previsto |
| [`notices/corpus.json`](notices/corpus.json) | El corpus de textos de licencia: qué identificador resuelve a qué archivo |
| [`notices/licencias/`](notices/licencias/) | Los 24 textos completos (25 identificadores, porque `custom` y `LicenseRef-AOM-Patent-1.0` comparten archivo). **Se copian dentro de cada imagen**, porque un identificador no es un aviso y Alpine no incluye los textos en sus paquetes |
| [`notices/avisos-fuente.json`](notices/avisos-fuente.json) | Los avisos de copyright propios de cada paquete **fuente**: titulares, años y textos específicos |

### El corpus, y por qué existe

Alpine Linux **no incluye** los textos de licencia dentro de sus paquetes
binarios: en las tres imágenes, los 68 y 19 paquetes del sistema llegan sin una
sola línea de licencia. Listar «`busybox 1.37.0-r12  GPL-2.0-only`» no cumple lo
que la GPL exige, que es entregar el texto.

Por eso `notices/licencias/` viaja dentro de cada imagen, en la misma ruta a la
que remite el aviso, y cada paquete indica en qué archivo está su texto:

```
  busybox      1.37.0-r12   GPL-2.0-only
                            texto: GPL-2.0-only: licencias/GPL-2.0-only.txt
```

Los textos canónicos vienen de la lista oficial SPDX **v3.29.0**, fijada en el
commit `31ba1a50e5397e00a304dbadc76531740e89ee48` — por commit y no por rama,
para que la procedencia sea reproducible. Un texto específico de un componente
**nunca** se sustituye por su equivalente canónico: los `COPYRIGHT` de nginx se
reproducen tal como viajan en la imagen.

### Avisos de copyright: el texto de la licencia no basta

Un texto canónico cubre el **cuerpo** de la licencia, no los titulares, los años
ni los textos propios de cada proyecto. Esos se recogen aparte, deduplicados por
paquete **fuente** y no por binario, en `notices/avisos-fuente.json`.

De los 64 paquetes fuente: **15 con aviso propio recuperado** (27 archivos),
**4 verificados y sin aviso**, y **45 no verificables**. Este último estado no
dice que no exista aviso: dice que la fuente exacta se publica solo como tarball
y comprobarlo exigiría descargar un binario. No se afirma ausencia sin mirar.

El `openssl` que instala Alpine se acredita **aparte** del que enumera la
licencia combinada de Node.js: son componentes distintos, con versiones
distintas — `3.3.3-r0` en el frontend, `3.5.8-r0` en backend y migrate — y cada
uno con su `LICENSE.txt` de la versión exacta.

### Fuentes copyleft: el commit sale del artefacto

El commit de aports de cada paquete se lee del campo `c:` de
`/lib/apk/db/installed`, que apk conserva **dentro del propio artefacto**: es el
commit con el que se construyó ese binario exacto.

Consultar qué versión publica hoy la rama **no sirve**: en la resolución del
2026-09-20, **27 de 87 paquetes** ya tenían en su rama una versión posterior a la
distribuida. Los 24 componentes copyleft y Apache tienen hoy su commit exacto
resuelto.

## Estado de cumplimiento

> **Preparado para uso interno. Distribución externa BLOQUEADA.**

**Escenario de esta primera versión:** repositorio privado, uso interno de FCHMN,
imágenes **no** entregadas fuera de FCHMN, y frontend entregado a los navegadores
de personas usuarias internas.

Las obligaciones de **ofrecer el código fuente** por distribución externa no se
activan todavía. Esto **no** significa que las condiciones de atribución
desaparezcan: los avisos se incorporan igualmente, como política conservadora de
cumplimiento y para dejar el proyecto listo para una entrega externa futura.

### Por qué la distribución externa está bloqueada

No se declara cumplimiento externo completo mientras siga pendiente cualquiera
de estos puntos. Hoy quedan tres pendientes:

| Condición | Estado |
|---|---|
| Todas las fuentes exactas resueltas | **Cumplida** — los 24 componentes copyleft y Apache tienen su commit exacto |
| Corpus de licencias completo | **Cumplida** — 24 archivos de texto para 25 identificadores, incluido `LicenseRef-AOM-Patent-1.0`; ninguno sin resolver |
| Avisos de copyright verificados | **Pendiente** — 45 de 64 paquetes fuente no son verificables sin descargar su tarball |
| Candidatas finales construidas y verificadas | **Pendiente** — todavía no se han construido |
| Archivo de fuentes correspondiente | **Pendiente** — no existe |

`notices/sources.json` lo declara en `entregaExterna.bloqueada`, con sus motivos
enumerados, y la prueba `avisos-terceros.test.ts` falla si ese campo deja de
reflejar la realidad.

**No existe** archivo de fuentes correspondiente y **no se publica** ninguna
oferta escrita. `sources.json` registra procedencia y plan; no debe citarse como
prueba de disponibilidad.

### Mecanismo previsto para una entrega externa

Cada versión publicada de las imágenes irá **acompañada** de un archivo con la
fuente correspondiente a esas versiones exactas: el `APKBUILD` y los parches de
aports en el commit exacto, más los tarballs upstream que ese `APKBUILD` declara.

No se usa una oferta escrita como mecanismo preferido: dependería de una promesa
operativa posterior y de enlaces que caducan — `dl-cdn.alpinelinux.org` retira
las ramas al terminar su soporte, de modo que las versiones exactas dejan de
estar disponibles. Acompañar la fuente elimina esa dependencia.

## Casos residuales

Registrados en `notices/excepciones.json` con `riesgoResidual: true`:

- **`@swc/helpers@0.3.17`** — declara MIT en su manifiesto; el tarball no trae
  texto; no existe etiqueta ni commit verificable; el texto incorporado es el
  canónico SPDX, **no** uno recuperado del lanzamiento. Aceptado
  provisionalmente. Pendiente: consultar upstream.
- **`abstract-logging@2.0.1`, `dfa@1.2.0`, `fontkit@1.9.0`** — misma situación,
  pero con etiqueta verificada: se comprobó que esa etiqueta tampoco contiene
  archivo de licencia.

Resueltos, sin riesgo residual:

- **`png-js@1.1.0`** — sin campo `license`, pero el artefacto **sí** trae un
  `LICENSE` con concesión MIT de Devon Govett.
- **`saxes@5.0.1`** — el texto de su etiqueta exacta contiene **tres**
  concesiones; el canónico SPDX habría borrado dos titulares.
- **`brotli@1.3.3`** — declara MIT, pero distribuye código de Google bajo
  Apache-2.0 en `enc/` y `dec/`. Se incorporan **ambas** capas y se conservan
  las cabeceras de aviso dentro de los archivos.
- **`aom-libs@3.11.0-r0`** — el átomo `custom` de Alpine es la **Alliance for
  Open Media Patent License 1.0**, confirmada con el `PATENTS` de la versión
  exacta (`aomedia/aom@v3.11.0`, 5701 bytes). La expresión legible es
  `BSD-2-Clause AND LicenseRef-AOM-Patent-1.0`, **conjuntiva**, y se conserva
  junto a la original de Alpine.

## Verificación

```bash
node scripts/generar-avisos.mjs --verificar
```

Falla si los avisos publicados divergen de lo que produce el generador. La
prueba `backend/tests/avisos-terceros.test.ts` lo ejecuta sin red y comprueba
además la integridad de los textos y la cobertura de las excepciones.

## Regenerar el inventario

El inventario se extrae de las **imágenes construidas**, no del árbol de
desarrollo, porque lo que obliga es lo que se distribuye. El procedimiento está
en [`scripts/extraer-inventario.md`](scripts/extraer-inventario.md).

## Construir y revalidar: dos pasadas, no una

Construir una candidata, medirla y regenerar los avisos **deja esa misma
candidata con los avisos viejos dentro**. Por eso el procedimiento tiene dos
pasadas: unas candidatas de descubrimiento que solo se miden y se descartan, y
unas candidatas finales construidas ya con los avisos definitivos, sobre las que
se exige igualdad byte a byte y que regenerar no produzca cambio alguno.

Está en [`scripts/construir-y-revalidar.md`](scripts/construir-y-revalidar.md).
Las candidatas de descubrimiento **no se promocionan nunca**.
