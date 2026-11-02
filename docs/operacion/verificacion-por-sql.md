# Verificación por SQL de solo lectura

Cómo comprobar, desde el servicio de mantenimiento y **sin escribir nada**, qué
quedó de verdad en la base después de una carga masiva.

> **Por qué hace falta.** El registro de un cargador dice qué le respondió la
> API, no qué quedó guardado. Son casi siempre lo mismo, y «casi siempre» no es
> una verificación.

---

## 1. Por dónde, y por qué no con `psql`

La imagen de mantenimiento es Node más el CLI de Prisma: **no trae `psql`**.
Pero trae `@prisma/client`, y con él se ejecutan consultas SQL en crudo por la
red privada. Eso es todo lo que hace falta.

| | |
|---|---|
| Dónde | el servicio de mantenimiento (Cron Job), por su conexión privada |
| Mecanismo | pegar el comando en **Docker Command** → **Trigger Run** → leer el registro → **vaciar el campo** |
| Acceso externo de la base | **sin cambios**. No hace falta una URL externa ni tocar listas de acceso |

**Vaciar el campo al terminar no es opcional.** Mientras haya un comando
escrito, una ejecución programada lo ejecutaría. Aquí es de solo lectura, así
que el riesgo es menor que con una migración, pero la costumbre se mantiene.

### Las tres propiedades que hacen esto seguro

**1. La sesión no puede escribir.** Lo primero que ejecuta cada comando es

```sql
SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY
```

y lo segundo es imprimir `transaction_read_only`, que debe decir `on`. No es una
promesa, es una garantía del motor: en esa sesión un `UPDATE`, un `INSERT`, un
`DELETE` o un `CREATE TABLE` se rechazan con
`25006: cannot execute … in a read-only transaction`.

**2. Una sola conexión.** El comando fuerza `connection_limit=1` sobre la URL
que recibe, así que aporta **exactamente una** conexión. Sin eso, el grupo de
conexiones de Prisma abriría varias y contaminaría justo la comprobación de
cuántas hay conectadas.

**3. Un recorte del pegado falla, no miente.** Es una línea de JavaScript: si se
corta, Node da un error de sintaxis. **No existe la posibilidad de que un
comando truncado devuelva una respuesta incompleta como si fuera buena.** La
señal de que el texto llegó entero es la última línea del registro:
`=== CONSULTA En TERMINADA SIN ESCRIBIR NADA ===`.

> Ni `$` ni comillas dobles aparecen en los comandos, a propósito: el `$` se
> construye con `String.fromCharCode(36)`. Así se comportan igual si el panel
> parte el comando en argumentos él mismo o si lo pasa por un shell, donde un
> `$` se expandiría.

## 2. Obtener los comandos

No están escritos en este documento: los imprime un generador, porque llevan la
fecha de la carga, la ventana de auditoría y la huella de correspondencia.
Escritos a mano aquí serían los de **una** carga concreta y habría que editarlos
con cuidado cada vez — exactamente la clase de edición manual en la que se cuela
un error que la consulta no puede detectar.

```bash
node backend/scripts/carga-masiva/calcular-esperados.mjs --manifiesto <ruta>
# anote huella_global

node backend/scripts/carga-masiva/consultas-verificacion.mjs \
     --manifiesto <ruta> \
     --desde "AAAA-MM-DD HH:MM:SS" --hasta "AAAA-MM-DD HH:MM:SS" \
     --huella <huella_global>
```

`--desde` y `--hasta` son la ventana de la carga **en hora UTC**, tomada del
registro del cargador. Conviene abrirla con holgura de unos minutos, y tener
presente que **todo lo que caiga dentro se cuenta**: un ingreso anterior a la
carga que entre en la ventana aparecerá como un `LOGIN` más.

Salen tres comandos, no uno. Juntos pasan de 11.000 caracteres y el límite del
campo donde se pegan no está documentado; partidos en tres, cada uno queda en un
tamaño ya probado y el registro de cada ejecución se lee sin desplazarse.

| | Qué responde |
|---|---|
| **E1** | totales · fecha efectiva · personalidad jurídica |
| **E2** | correspondencia persona↔club · roles de nadador · duplicadas y huérfanas |
| **E3** | cuentas de acceso · auditoría de las tres etapas · escrituras por tabla |

## 3. Qué mirar en cada sección

Los números exactos salen de `calcular-esperados.mjs`; aquí va **qué significa**
cada cosa y cuándo hay que detenerse.

### E1

| Sección | Qué tiene que decir |
|---|---|
| `0_solo_lectura` | **`on`**. Si no, deténgase: la sesión podría escribir |
| `1_identidad_y_migraciones` | la base esperada, el número de migraciones aplicadas y **una** conexión |
| `2_TOTALES` | clubes, personas y membresías activas = los de las planillas; `cargos_de_club` **0**; `cuentas` **sin aumentar** |
| `3_MEMBRESIAS_Y_FECHA_EFECTIVA` | **una sola fecha presente**, la aprobada; `con_otra_fecha` y `sin_fecha` en **0** |
| `4_CLUBES_PERSONALIDAD_JURIDICA` | todos **pendientes**; **0** en `true` y **0 en `false`** |

> **`instantes_de_revision_distintos` es el dato que distingue una carga por la
> API de un volcado directo.** Debe ser un número grande, cercano al de
> membresías: cada una se escribió en su propia solicitud, con su propio
> instante. Un **1** significa que se escribieron todas de golpe, y eso no es lo
> que hace el cargador.

> **`reservas_de_nombre` no son cuentas.** Es el registro global de nombres de
> usuario que mantienen los disparadores de la base: una fila por club y por
> persona vigente, más la de cada cuenta del sistema. Crece con la carga aunque
> no se cree ninguna credencial.

### E2 — la correspondencia

| Sección | Qué tiene que decir |
|---|---|
| `5_CORRESPONDENCIA_PERSONA_CLUB` | `huella_global` **igual** a la esperada, y `coincide: true` |
| `5b_por_club_sigla_n_suma` | una entrada por club con nadadores, para localizar un descuadre |
| `6_ROLES_DE_NADADOR` | un rol activo por membresía activa; **0** membresías sin rol y **0** roles sin membresía |
| `7_DUPLICADAS_Y_HUERFANAS` | **0** en todo, salvo `solicitantes_distintos` (1) y `clubes_sin_nadadores`, que es un número legítimo |

> **`coincide: null` no es `true`.** Sobre una base sin membresías activas la
> suma es `null` y la comparación también. Mire primero
> `membresias_activas`.

Si `coincide` sale **`false`**, alguna persona no está en el club que decía la
planilla, y **los totales no lo habrían mostrado**: dos nadadores intercambiados
entre dos clubes dejan todos los conteos iguales. Para localizarlo, compare la
lista `sigla:n:suma` de `calcular-esperados.mjs --por-club` con el array
`por_club` de `5b`: los clubes cuya **suma** difiera son los afectados, y si
además difiere la **n**, hay nadadores de más o de menos.

**No corrija nada automáticamente.** Una segunda pasada del cargador no es la
herramienta para arreglar un dato: solo volvería a confirmar lo que ya hay.

### E3 — cuentas y auditoría

| Sección | Qué tiene que decir |
|---|---|
| `8_CUENTAS_DE_ACCESO` | **las cuentas que ya existían, ni una más**. Una carga de datos no crea credenciales |
| `8b_cuentas_y_reservas` | **0** cuentas de personas y **0** de clubes |
| `9_AUDITORIA_POR_ETAPA` | `CLUB_CREATED`, `PERSON_CREATED` y `SWIMMER_ASSIGNMENT_DIRECT` con tantos asientos como entidades creadas, y **`asientos` = `entidades_distintas`** |
| `9b_auditoria_dentro_y_fuera` | el total de la ventana debe cuadrar asiento por asiento con la suma de las tres etapas más los ingresos |
| `9c_cobertura_de_auditoria` | **0** en los cuatro: ninguna entidad sin asiento, ningún asiento sin entidad |
| `10_ESCRITURAS_POR_TABLA` | solo las tablas de la carga y los catálogos que ya existían. **Una tabla de negocio ajena a la carga con escrituras es una diferencia que hay que explicar** |

> **Los contadores de la sección 10 son acumulados desde el último reinicio de
> estadísticas**, no de la carga, y sobre una base restaurada reflejan el propio
> `pg_restore`. Sirven para ver **qué** se escribió, no **cuánto** escribió
> exactamente la carga.

### Lo que estas consultas deliberadamente no miran

**Nada derivado de contraseñas.** Una huella del hash de la cuenta
administradora serviría para detectar un cambio de clave entre dos lecturas,
pero es un derivado de una credencial y no entra en un repositorio público.
Quien quiera esa comprobación la añade en su copia del generador.

## 4. La huella de correspondencia

```
clave  = RUN normalizado  +  "|"  +  sigla del club en mayúsculas
valor  = primeros 4 bytes del md5(clave), en little-endian
huella = SUMA de los valores de todas las membresías activas
```

Los dos lados la calculan igual: `calcular-esperados.mjs` desde las planillas,
el SQL desde la base. El RUN se normaliza con
`upper(translate(run, '.- ', ''))`, que es lo mismo que hace `normalizeRun` del
servidor.

**Es una suma, no un hash de una concatenación ordenada**, y la diferencia
importa: sumar no depende del orden, así que la huella no depende de la colación
de la base. Un `md5` sobre `string_agg(… order by k)` sí dependería, y una
colación distinta en el servidor habría dado una diferencia falsa.

> **Qué revela.** Para un club con un solo nadador el valor es el de su única
> clave, y 4 bytes de md5 son pocos: alguien con las siglas y fuerza bruta podría
> recuperar ese RUN. No es un identificador opaco. Trátela como dato interno,
> igual que las planillas de las que sale, y no la pegue en un sitio público.

## 5. Después de verificar

Si todo cuadra, el siguiente paso es un **respaldo posterior a la carga**:
crearlo, descargarlo en la misma sesión, comprobar que se abre y anotar su
huella. El procedimiento completo está en el instructivo de nube, sección de
respaldos — aquí no se repite.

Un respaldo de un estado que no se ha verificado conserva el problema junto con
los datos. Ese es el orden y no el contrario.
