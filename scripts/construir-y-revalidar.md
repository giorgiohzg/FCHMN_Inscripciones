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
docker buildx build --build-context avisos=./notices \
  --target runtime --tag fchmn-backend:descubrimiento ./backend
docker buildx build --build-context avisos=./notices \
  --target migrate --tag fchmn-migrate:descubrimiento ./backend
docker buildx build --build-context avisos=./notices \
  --target runtime --tag fchmn-frontend:descubrimiento ./frontend
```

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
docker buildx build --build-context avisos=./notices \
  --target runtime --tag fchmn-backend:candidato-v4 ./backend
docker buildx build --build-context avisos=./notices \
  --target migrate --tag fchmn-migrate:candidato-v4 ./backend
docker buildx build --build-context avisos=./notices \
  --target runtime --tag fchmn-frontend:candidato-v4 ./frontend
```

### Las dos exigencias que cierran el círculo

**a) Igualdad byte a byte** entre los avisos del repositorio y los incorporados
a cada imagen:

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

Solo cuando **a** y **b** se cumplen, las candidatas finales pasan a Fases 4 y 5.

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
