# Preflight de incorporaciones (C-05)

Comprobación de **solo lectura** que se ejecuta **antes** de aplicar las migraciones
`20261112000000_c05_incorporaciones` y `20261114000000_competencia_predeterminada`. Detecta dos situaciones
que requieren revisión humana:

- **propuestas pendientes duplicadas:** más de una para el mismo club y la misma persona;
- **membresías activas con inicio futuro:** posterior al día actual en Santiago.

Son las mismas condiciones de `backend/scripts/migrationChecks.ts`. No corrige ni borra nada.

## Comando

En el servicio de mantenimiento (Cron Job), campo **Docker Command**:

```
node /app/operacion/preflight-incorporaciones.mjs
```

Es una orden simple, sin shell, sin comillas y sin SQL en el campo. El ejecutor y el SQL vienen dentro
de la imagen de mantenimiento (`backend/operacion/`, copiados expresamente por `backend/Dockerfile`).

Procedimiento:

1. Escribir el comando, guardar, recargar la página y confirmar el texto.
2. **Trigger Run** una sola vez y leer el registro.
3. Esperar a que la ejecución termine y **vaciar el campo**: guardar, recargar y confirmar que quedó vacío.
4. Comprobar que la programación y Auto-Deploy desactivado se conservan.

## Cómo leer el resultado

Solo cuenta como aprobado si se cumplen **las dos** condiciones a la vez:

- la ejecución termina con **status 0**;
- el registro contiene la línea exacta:

  ```
  PREFLIGHT_OK sha256=1faaf4f4755c7dbd5cc22fbcbc37b03f5935ef9e5f66b9076354c59f30ac21d0
  ```

| Status | Línea | Qué significa | Qué hacer |
|---|---|---|---|
| 0 | `PREFLIGHT_OK sha256=…` | Sin datos incompatibles | Continuar con la migración |
| 1 | `PREFLIGHT_BLOQUEA grupos_pendientes_duplicados=N membresias_activas_inicio_futuro=M` | Hay datos que revisar; solo se informan conteos | **Detenerse.** Revisión humana. No corregir datos ni migrar |
| 2 | `PREFLIGHT_ERROR: el archivo SQL …` | El SQL falta, está vacío o no coincide con su hash; **no se consultó la base** | Detenerse; revisar la imagen construida |
| 3 | `PREFLIGHT_ERROR: …` | Prisma o la conexión fallaron, o se agotó el tiempo. Solo se muestra un código técnico, como `P1001` | Detenerse; no reintentar con variantes |

Cualquier otro resultado, o un status 0 sin esa línea exacta, **no** es una aprobación.

**No confundir con `prisma migrate status`.** Cuando hay migraciones pendientes, ese comando termina con
**status 1** como algo **esperado**: lo que importa es que liste exactamente las dos pendientes previstas y
ninguna fallida. El status 1 del preflight, en cambio, es un bloqueo.

## Qué garantiza

- **Solo lectura:**
  - el SQL abre `BEGIN READ ONLY`;
  - comprueba dentro que `transaction_read_only` esté en `on`;
  - fija `lock_timeout` en 5 s, `statement_timeout` en 60 s e `idle_in_transaction_session_timeout` en 120 s.
- **SQL íntegro:** el ejecutor verifica el SHA-256 del SQL antes de conectarse, de modo que cualquier cambio
  en el archivo detiene la ejecución con status 2. Cambiar el SQL obliga a actualizar el hash en
  `preflight-incorporaciones.mjs` y en `backend/tests/preflight-incorporaciones.test.ts`, y a validarlo de nuevo.
- **Ejecución:** Prisma se llama sin shell (`spawn` con argumentos fijos) y con un tope total de 180 s.
- **Salida acotada:** la salida de Prisma nunca se imprime, ni tampoco variables de entorno, URL de conexión,
  credenciales, nombres o RUN.

## Validación local (2026-11-14)

Sobre una base temporal propia dentro del contenedor desechable de pruebas, con las 39 migraciones previas
a C-05 y datos sintéticos, usando la imagen de mantenimiento construida con estos archivos y su
`ENTRYPOINT` normal:

| Escenario | Resultado |
|---|---|
| Datos limpios | 0 y `PREFLIGHT_OK` |
| Propuestas pendientes duplicadas | 1, `grupos_pendientes_duplicados=1` |
| Membresía activa con inicio futuro | 1, `membresias_activas_inicio_futuro=1` |
| SQL ausente, vacío o alterado | 2, antes de conectarse |
| Host inexistente, base inexistente o sin `DATABASE_URL` | 3 (`P1001`, `P1003`, `P1012`), sin la marca de éxito y sin usuario, clave, host ni URL en la salida |
| Sonda de escritura con la misma envoltura | rechazada por PostgreSQL; datos sin cambios |
| El mismo SQL sin `READ ONLY` | la guarda interna lo detiene, y el ejecutor lo rechaza por hash |

**Aún no se ha ejecutado en Render.**

## Antecedente: intento del 2026-11-13

El primer intento usó en Docker Command una orden `sh -c '…'` con el SQL en base64. En el registro de
Render, `sh` recibió el texto del script como si fuera **un nombre de archivo**
(`sh: …: Filename too long`) y la ejecución terminó con **status 127** sin ejecutar ninguna instrucción
SQL. Fue una **interpretación incorrecta de esa invocación concreta**. No está demostrado que Render
ignore siempre `-c` o las comillas; por eso este procedimiento evita depender de ello.

Antes, en la misma sesión, `prisma migrate status` había terminado con **status 1**, que era lo esperado
porque listó exactamente las dos migraciones pendientes previstas.

Ninguna migración se aplicó, la API y la web siguieron en `0f03a0d`, y el Docker Command quedó vacío y
confirmado.

Las ejecuciones del cron se cuentan por los **eventos** del servicio: «Cron job run triggered» y «Cron job
run failed», a las 23:37 con status 1 y a las 23:39 con status 127, hora del panel. No sirve el contador
visual «RUN» del panel, que mostró el mismo número antes y después.
