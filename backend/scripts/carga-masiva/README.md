# Carga masiva inicial — herramientas

| Archivo | Qué hace |
|---|---|
| `cargar.mjs` | conduce las tres etapas por la API. **Pasada en seco por omisión**; escribir exige `--confirmar` y repetir la fecha |
| `calcular-esperados.mjs` | lee las planillas y dice qué debe contener la base al terminar. No se conecta a nada |
| `consultas-verificacion.mjs` | imprime tres comandos de **solo lectura** para comprobar el resultado. No se conecta a nada |
| `manifiesto.ejemplo.json` | plantilla. Cópiela junto a sus planillas, **fuera del repositorio**, y rellénela |

**El procedimiento está en [`docs/operacion/carga-masiva-inicial.md`](../../../docs/operacion/carga-masiva-inicial.md)**, y la
verificación en [`docs/operacion/verificacion-por-sql.md`](../../../docs/operacion/verificacion-por-sql.md). Las pruebas, en
[`backend/tests/carga-masiva/`](../../tests/carga-masiva/).

Ni las planillas ni los resultados entran en este repositorio: es público y las
planillas llevan datos personales. El cargador **se niega a escribir sus
resultados dentro del árbol de Git**.
