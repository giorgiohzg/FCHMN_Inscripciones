# Construir y revalidar las tres imágenes

## El problema que este procedimiento evita

Una sola pasada es **circular**: se construye una candidata con los avisos que
hay, se extrae su inventario real, se regeneran los avisos… y la candidata ya
construida sigue llevando dentro los avisos viejos. Validarla entonces valida
un artefacto que contiene una descripción obsoleta de sí mismo.

Por eso hay **dos pasadas**. Las de la primera existen solo para ser medidas y
se descartan; las de la segunda son las que se verifican y, eventualmente, se
promocionan.

## Pasada 1 — candidatas de descubrimiento

**Nunca se promocionan.** Solo sirven para saber qué contienen de verdad.

```bash
node scripts/distribuir-avisos.mjs
docker buildx build --target runtime --tag fchmn-backend:descubrimiento ./backend
docker buildx build --target migrate --tag fchmn-migrate:descubrimiento ./backend
docker buildx build --target runtime --tag fchmn-frontend:descubrimiento ./frontend
```

> **Ya no se pasa `--build-context avisos=./notices`.** Los avisos viajan ahora
> dentro de cada contexto, en `backend/avisos/` y `frontend/avisos/`, porque un
> contexto adicional no existe en las plataformas que construyen desde un
> repositorio Git. `notices/` sigue siendo la única fuente de verdad y
> `scripts/distribuir-avisos.mjs` mantiene las copias byte a byte; de ahí que la
> distribución sea el primer comando de cada pasada.
>
> **Aquí se sigue usando `--target` sobre `backend/Dockerfile`**, que es la
> fuente. `backend/Dockerfile.mantenimiento` es un archivo DERIVADO que existe
> solo para las plataformas sin `--target`; no se usa en este procedimiento, pero
> sí hay que mantenerlo al día:
>
> ```bash
> node scripts/generar-dockerfile-mantenimiento.mjs --verificar
> ```

Las bases van fijadas por digest en los `Dockerfile`. Al fijar nginx a un digest
distinto del anterior **cambiarán versiones de paquetes del sistema**: es
esperado, y es justamente lo que hay que medir.

1. **Extraer los inventarios reales** de las tres, según
   [`extraer-inventario.md`](extraer-inventario.md).
2. **Resolver las fuentes**: `node scripts/generar-sources.mjs`. Los commits
   salen del campo `c:` de la base de apk de cada artefacto, no de consultar qué
   publica hoy la rama.
3. **Completar el corpus** si aparecen licencias nuevas: si un átomo no está en
   `notices/corpus.json`, la prueba de cobertura falla y hay que resolverlo
   antes de seguir.
4. **Regenerar los avisos definitivos**: `node scripts/generar-avisos.mjs`.
5. **Pruebas**: `npx vitest run tests/avisos-terceros.test.ts` en `backend/`.

Si `sources.json` marca `entregaExterna.bloqueada`, se puede continuar para uso
interno, pero queda registrado y la entrega externa sigue prohibida.

## Pasada 2 — candidatas finales

Se construyen **con los avisos ya definitivos**:

```bash
node scripts/distribuir-avisos.mjs
docker buildx build --target runtime --tag fchmn-backend:candidato-v4 ./backend
docker buildx build --target migrate --tag fchmn-migrate:candidato-v4 ./backend
docker buildx build --target runtime --tag fchmn-frontend:candidato-v4 ./frontend
```

### Las dos exigencias que cierran el círculo

**a) Igualdad byte a byte** entre los avisos del repositorio y los incorporados
a cada imagen. Primero, que las copias en contexto no se hayan quedado atrás:

```bash
node scripts/distribuir-avisos.mjs --verificar
```

Debe devolver 0. Si diverge, la imagen se construyó con un aviso viejo y hay que
redistribuir y reconstruir. Después, contra el artefacto:

```bash
docker run --rm --network none --entrypoint sha256sum fchmn-backend:candidato-v4 \
  /usr/share/licenses/THIRD-PARTY-NOTICES.txt
sha256sum notices/backend.txt
```

Los dos hashes deben coincidir. Igual para `migrate.txt`, para
`frontend-image.txt` y para `frontend-web.txt` en su ruta servida.

**b) Regenerar desde las candidatas finales produce CERO cambios.** Se vuelve a
extraer el inventario de las candidatas finales, se regenera, y
`node scripts/generar-avisos.mjs --verificar` debe devolver 0. Si cambia algo,
la pasada 2 alteró lo que la pasada 1 había medido y hay que repetir.

**c) Nada sin versionar viaja dentro.** Una candidata del backend llevaba tres
documentos internos de `prisma/migrations/` y el seed del entorno de revisión,
que contiene una credencial local: `COPY prisma ./prisma` los arrastraba desde
el contexto. El filtro está en `backend/.dockerignore`, pero el filtro se
comprueba sobre el artefacto, no sobre el archivo de reglas:

```bash
node scripts/verificar-archivos-de-imagen.mjs \
  fchmn-backend:candidato-AAAAMMDD-HHMM fchmn-migrate:candidato-AAAAMMDD-HHMM
```

Exige que **todo** archivo bajo `/app/prisma/` corresponda a una ruta
versionada en Git. Es una regla positiva a propósito: una lista de archivos
prohibidos envejecería con el primer documento nuevo.

El contexto lo vigilan otras dos, y conviene saber qué prueba cada una:

| Comprobación | Qué mira | ¿Corre hoy en CI? |
|---|---|---|
| `backend/tests/dockerignore-contexto.test.ts` | un **modelo** de las reglas, con archivos sintéticos | **sí** |
| `scripts/contraprueba-dockerignore.mjs` | el **filtro real** de Docker, con un contexto sintético y una imagen `FROM scratch` | no |
| `scripts/verificar-archivos-de-imagen.mjs` | lo que **quedó dentro** del artefacto | no |

La limitación, dicha con precisión: **en la integración continua solo se
comprueba el modelo**, porque el flujo de hoy no construye imágenes. No es que
allí falte Docker —`ci.yml` levanta PostgreSQL como contenedor de servicio, de
modo que el ejecutor lo tiene—: es que no hay artefacto que inspeccionar y
nadie ha añadido todavía la contraprueba del filtro real.

Mientras siga así, un modelo puede estar mal, y por eso las dos comprobaciones
con Docker son **puertas locales obligatorias** antes de promover, no extras
opcionales.

Solo cuando **a**, **b** y **c** se cumplen, las candidatas finales pasan a
Fases 4 y 5.

## Las dos comprobaciones del frontend son distintas

No se mezclan, porque cubren cosas distintas:

| Comprobación | Qué mira | Qué debe contener |
|---|---|---|
| **HTTP** | `GET /third-party-notices.txt` | **Solo** las dependencias entregadas al navegador |
| **Inspección de imagen** | `/usr/share/licenses/` dentro del contenedor | El aviso completo de la imagen y el directorio `licencias/` |

La prueba HTTP **no** debe exigir que aparezcan nginx ni los paquetes Alpine:
esos no se envían al navegador. Y la inspección de imagen **sí** debe exigirlos.

## Después

Fases 4 y 5 sobre las candidatas finales, y después la promoción controlada ya
validada: etiquetas `prev-*`, promoción por identificador inmutable, recreación
solo del backend con `--no-deps --no-build --force-recreate`, y reversión única
ante cualquier fallo posterior a la primera mutación.

Las candidatas de descubrimiento **no se promocionan nunca**. Pueden retirarse
cuando las finales estén verificadas, y solo entonces.
