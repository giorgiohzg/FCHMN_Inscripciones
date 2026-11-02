# Carga masiva inicial

Poblar un sistema recién instalado con **clubes, personas y membresías** desde
tres planillas, **por la API** y en tres etapas.

> **Por la API y no por la base.** La alternativa —un `INSERT` masivo— se salta
> las validaciones, los disparadores que mantienen la reserva global de nombres
> de usuario, la sincronización del rol de nadador y la auditoría. Lo que
> quedaría en la base no sería lo que el sistema produce, y la diferencia solo
> aparecería meses después. Por eso aquí todo entra por los mismos extremos que
> usa la interfaz.

| | |
|---|---|
| Cargador | [`backend/scripts/carga-masiva/cargar.mjs`](../../backend/scripts/carga-masiva/cargar.mjs) |
| Esperados desde las planillas | [`backend/scripts/carga-masiva/calcular-esperados.mjs`](../../backend/scripts/carga-masiva/calcular-esperados.mjs) |
| Comandos de verificación | [`backend/scripts/carga-masiva/consultas-verificacion.mjs`](../../backend/scripts/carga-masiva/consultas-verificacion.mjs) |
| Plantilla del manifiesto | [`backend/scripts/carga-masiva/manifiesto.ejemplo.json`](../../backend/scripts/carga-masiva/manifiesto.ejemplo.json) |
| Pruebas | [`backend/tests/carga-masiva/`](../../backend/tests/carga-masiva/) — API simulada y batería, con planillas sintéticas |

---

## 1. Las tres etapas

| Etapa | Extremo | Llamadas |
|---|---|---|
| 1. Clubes | `POST /clubs` | una por club |
| 2. Personas | `POST /persons/bulk-import` | **una**, sube el `.xlsx` |
| 3. Membresías | `POST /swimmer-assignments/bulk-assign` | una por club con nadadores |

El orden no es negociable: la etapa 3 necesita los identificadores que crean las
dos primeras.

## 2. Las tres trampas que hacen falla silenciosa

Son las que hay que conocer antes de empezar, porque ninguna produce un error.

### 2.1 `fechaEfectiva` ausente escribe la fecha de HOY

El campo es **opcional** en el esquema de la API. Si no viaja, el servicio usa
el día de hoy en la zona de Chile. Una carga que lo omitiera grabaría la fecha
de ejecución en **todas** las membresías, sin error y sin aviso, y la
corrección después es registro por registro.

El cargador lo exige en cada carga útil y lo comprueba antes de enviar. Y para
escribir pide la fecha **dos veces**: en el manifiesto y en la línea de órdenes.

### 2.2 `hasLegalStatus` omitido no significa «pendiente»

La columna tiene **tres** estados: `true` (tiene personalidad jurídica),
`false` (se verificó que no la tiene) y `null` (**pendiente de verificar**). En
el esquema de la API el campo es `nullable` y **no** `optional`: omitirlo no
deja `null`, falla la validación. Y poner `false` no es neutro: afirma algo que
nadie comprobó.

El cargador envía `hasLegalStatus: null` explícito y se detiene si la planilla
trae cualquier otro valor.

### 2.3 «Ya existe» no dice QUÉ existe

Que el sistema responda que algo ya existe no dice si es lo nuestro: podría ser
otro club con el mismo nombre de usuario, una persona con el mismo RUN y otra
fecha de nacimiento, o una membresía en otro club o con otra fecha.

**El cargador no acepta ningún «ya existe» por su mensaje.** Lee el registro de
la API y lo compara campo a campo con la planilla. Si todo coincide, lo da por
hecho; si algo difiere, **se detiene y no sobrescribe**: no hay `PATCH`, ni
`PUT`, ni reintento que «arregle» la diferencia. Reparar es una decisión de
quien opera, con el detalle delante.

## 3. El manifiesto

Todo lo propio de una carga vive en un JSON **junto a las planillas, fuera del
repositorio**. Copie
[`manifiesto.ejemplo.json`](../../backend/scripts/carga-masiva/manifiesto.ejemplo.json)
y rellénelo.

```jsonc
{
  "fechaEfectiva": "AAAA-MM-DD",     // la que se grabará en TODAS las membresías
  "directorioDePlanillas": ".",      // relativo al propio manifiesto
  "planillas": {
    "clubes":       { "archivo": "…xlsx", "hoja": "Clubes",       "sha256": "…" },
    "personas":     { "archivo": "…xlsx", "hoja": "Personas",     "sha256": "…" },
    "asignaciones": { "archivo": "…xlsx", "hoja": "Asignaciones", "sha256": "…" }
  },
  "totales": { "clubes": 0, "personas": 0, "asignaciones": 0, "clubesConNadadores": 0 },
  "limiteDeSolicitudesPorMinuto": 300
}
```

**Las huellas no son decorativas.** El cargador compara cada planilla con su
`sha256` antes de abrir sesión. Un archivo reabierto y guardado por la hoja de
cálculo, o una copia de otra ronda, cambia la huella y la carga se detiene ahí.
Sin eso, «la planilla aprobada» es una creencia. Calcule cada una así:

```bash
node -e "console.log(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.argv[1])).digest('hex'))" <archivo>
```

La plantilla del repositorio **no es ejecutable a propósito**: sus huellas no
son hexadecimales y el cargador se detiene al validarlas.

### Columnas que leen los guiones

| Planilla | Columnas, en orden |
|---|---|
| Clubes | fila · nombre · **sigla** · usuario · correo · personalidad jurídica · RUT · razón social · 4 indicadores de membresía/colaboración |
| Personas | **RUN** · usuario · nombre · apellido paterno · apellido materno · fecha de nacimiento · género · correo · teléfono |
| Asignaciones | fila · **RUN** · **usuario de la persona** · nombre completo · **sigla del club** · nombre del club |

Las fechas de nacimiento se admiten con guion o barra y con día o mes de una
cifra, el mismo patrón que usa el importador del servidor.

## 4. El procedimiento

### Paso 1 — Contrastar las planillas consigo mismas

```bash
node backend/scripts/carga-masiva/calcular-esperados.mjs --manifiesto <ruta> --por-club
```

Imprime lo que la base debe contener al terminar, y **contrasta los totales del
manifiesto con las planillas**: si no coinciden, el manifiesto y las planillas
no hablan de la misma carga. No se conecta a nada.

Anote la **huella de correspondencia** (`huella_global`): es la que después
demuestra que cada persona quedó en el club que decía la planilla. El apartado 4
de [verificacion-por-sql.md](verificacion-por-sql.md) explica cómo está
definida.

### Paso 2 — Comprobar todo lo comprobable sin tocar el sistema

```bash
API_BASE=https://<su-destino>/api CARGA_USUARIO=<cuenta> \
node backend/scripts/carga-masiva/cargar.mjs \
     --manifiesto <ruta> --salida <carpeta fuera del repo> --etapa todas --sin-sesion
```

`--sin-sesion` comprueba el destino, las huellas, los totales y las cargas
útiles, y **se detiene antes de ingresar**. No escribe absolutamente nada: ni un
asiento de auditoría, ni una fila de sesión. No pide contraseña.

### Paso 3 — Pasada en seco

Lo mismo sin `--sin-sesion`, con `CARGA_CLAVE` en el entorno. Añade el **estado
inicial real del destino**, que para leerlo hay que ingresar.

> **Una pasada en seco no es «cero escrituras», y conviene decirlo exacto.**
> Ingresar escribe tres cosas: un asiento `LOGIN` en `audit_logs`, una fila en
> `refresh_tokens` y el `last_login_at` de la cuenta. Nada del negocio: ni un
> club, ni una persona, ni una membresía. Son los mismos tres efectos de abrir
> la aplicación en el navegador. Si no quiere ni eso, quédese en el paso 2.

En seco tampoco se escriben los archivos de resultado por etapa: una pasada que
anuncia no escribir nada no debe dejar rastro.

> **«NO comprobables en seco: N» no es un fallo.** En seco la etapa 1 no crea
> los clubes, así que la etapa 3 no puede buscarlos. Es el orden, no un error.

### Paso 4 — La carga

```bash
API_BASE=… CARGA_USUARIO=… CARGA_CLAVE=… \
node backend/scripts/carga-masiva/cargar.mjs \
     --manifiesto <ruta> --salida <carpeta fuera del repo> --etapa todas \
     --confirmar --fecha-efectiva AAAA-MM-DD
```

**Las dos llaves.** `--confirmar` sin `--fecha-efectiva` se niega, y una fecha
distinta de la del manifiesto también. Cuando la fecha vivía dentro del guion,
una guarda impedía editarla a mano; al salir al manifiesto habría quedado como
un parámetro más, y es el valor que, omitido, se convierte en silencio en el día
de hoy.

### Paso 5 — Verificar

Por SQL de solo lectura: [verificacion-por-sql.md](verificacion-por-sql.md).
**El registro del cargador dice qué respondió la API, no qué quedó guardado.**

## 5. La contraseña, sin dejarla por ahí

La clave viaja por el entorno y el cargador no la escribe en ningún archivo ni
en su registro. En Windows PowerShell, para escribirla oculta y limpiarla
siempre —también si falla o si interrumpe con Ctrl+C—:

```powershell
$env:API_BASE = "https://<su-destino>/api"
$env:CARGA_USUARIO = "<cuenta>"
try {
    $segura = Read-Host "Clave de $($env:CARGA_USUARIO)" -AsSecureString
    $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($segura)
    $env:CARGA_CLAVE = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)

    node backend/scripts/carga-masiva/cargar.mjs --manifiesto <ruta> --salida <carpeta> --etapa todas
}
finally {
    if ($null -ne $bstr) { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    Remove-Item Env:CARGA_CLAVE -ErrorAction SilentlyContinue
    Remove-Variable segura, bstr -ErrorAction SilentlyContinue
    [System.GC]::Collect()
    if (Test-Path Env:CARGA_CLAVE) { Write-Host "ATENCION: CARGA_CLAVE sigue definida." -ForegroundColor Red }
}
```

Dos detalles que no son de estilo: en Windows PowerShell 5.1 **no existen `&&`
ni `||`**, y `try`/`finally` es lo único que limpia la variable también ante una
interrupción; y `PtrToStringBSTR` en vez de `PtrToStringAuto`, porque con `Auto`
una clave con caracteres fuera de ASCII puede truncarse.

**Lo inevitable, dicho claro:** la clave pasa por una variable de entorno en
claro mientras el proceso corre. Lo que se evita es que quede en el historial,
en un archivo, en el registro del cargador o en la sesión al terminar.

## 6. Reanudar sin duplicar

Cada etapa escribe un `.jsonl` en la carpeta de `--salida`, **una línea por
registro en cuanto se conoce**. Un corte a mitad deja un archivo legible con
todo lo hecho; un JSON completo se escribiría al final, que es cuando ya no
sirve.

Para reanudar, se vuelve a lanzar con **la misma carpeta de `--salida`**.

> **Ese archivo es una ayuda, no la verdad.** La verdad está en la API, y por eso
> cada reanudación concilia contra ella. El caso difícil —el servidor guardó y
> la respuesta no llegó, así que el registro local no lo anotó— se detecta igual:
> el cargador vuelve a leer y concilia. Está probado: un corte provocado justo
> después de guardar se reanuda sin duplicar nada.

## 7. El límite de solicitudes

La API limita a `RATE_LIMIT_GLOBAL_MAX` solicitudes por minuto —300 por
omisión— y `/auth/*` tiene uno más estricto. Una carga grande puede alcanzarlo.

El cargador espera lo que diga `Retry-After`, **hasta doce veces por petición**,
y luego se detiene. No hay reintento infinito: si el servidor sigue limitando
tras doce esperas, algo pasa que no se arregla esperando más.

El resumen final informa de `solicitudesTotales` y `picoDeSolicitudesPorMinuto`.
El pico es el dato útil: una carga que no recibió ningún 429 no dice con cuánto
margen pasó, y el pico sí.

## 8. Si no se puede hablar con el destino

`fetch` de Node envuelve todo fallo de transporte en un `TypeError: fetch
failed` cuyo rastro no menciona host, código ni motivo. El cargador desarma la
cadena de causas e imprime código, llamada al sistema, dirección y puerto, con
una pista por cada código conocido.

Para separar el cargador de la red hay un diagnóstico aparte, que **no
autentica, no envía credenciales y no escribe nada**:

```bash
node scripts/diagnostico/diagnosticar-conexion.mjs --url https://<su-destino>/api/health
```

Comprueba, por capas: versión de Node, variables de proxy y de certificados,
DNS, puerto, saludo TLS con la cadena completa de certificados, una petición con
`node:https` y otra con `fetch`. Termina con un veredicto y un código de salida
que lo acompaña.

> **Si el emisor del certificado no es el del sitio, hay inspección de tráfico
> en el camino.** Es habitual en redes corporativas. La salida correcta es que
> Node **confíe** en esa autoridad: `node --use-system-ca …` cuando la raíz ya
> está instalada en el equipo, o `NODE_EXTRA_CA_CERTS` apuntando a la raíz
> exportada.
>
> **Nunca `NODE_TLS_REJECT_UNAUTHORIZED=0`.** Eso no arregla la validación: la
> apaga para todo el proceso, incluida la conexión por la que viaja la
> contraseña.

## 9. Las pruebas

```bash
cd backend && npx vitest run tests/carga-masiva/carga-masiva.test.ts
```

Ejecutan el cargador **de verdad** contra una API simulada que se puede obligar
a fallar como la API real no permite sin romper algo: un corte justo después de
guardar, un registro preexistente que difiere, un token que caduca a mitad de
etapa, un 429 con `Retry-After` y un 429 permanente. Y comprueban las guardas:
que en seco no se escriba nada, que `--confirmar` sin la fecha se niegue, que un
byte de más en una planilla la invalide, que sin destino no arranque y que una
salida dentro del repositorio se rechace.

Sin base de datos, sin red fuera de `127.0.0.1` y **con planillas sintéticas**
generadas al arrancar: los datos son inventados, los correos van a `.invalid` y
los RUN tienen dígito verificador correcto pero cuerpo en un rango que no se
asigna.

Para iterar sobre un caso concreto:

```bash
node backend/tests/carga-masiva/pruebas-reanudacion.mjs --caso 4
```

Y para mirar las planillas sintéticas a mano:

```bash
node backend/tests/carga-masiva/generar-planillas-sinteticas.mjs --salida <carpeta>
```
