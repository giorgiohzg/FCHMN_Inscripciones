# Corte de sesiones: despliegue y reversión de `refresh_sessions`

Procedimiento para desplegar las sesiones de autenticación en un sistema ya en
producción. **Es una descripción, no una orden:** cada paso sobre producción necesita su
propia autorización.

## Qué cambia

- Cada inicio de sesión crea una fila en `refresh_sessions`, y el JWT la identifica con
  `sid`. Toda petición autenticada comprueba que esa sesión siga vigente, sin caché: un
  logout o un cambio de contraseña tienen efecto inmediato sobre el JWT ya emitido.
- Una sesión dura como máximo `SESSION_ABSOLUTE_HOURS` (8 por omisión) desde su creación.
  Renovar no extiende ese plazo. **No es un cierre por inactividad:** la renovación
  proactiva del frontend es un temporizador y no prueba que haya una persona.
- La API nueva **rechaza** los JWT sin `sid` y los refresh tokens sin sesión, sin
  cascadas de revocación.

## Por qué un corte

Al cambiar la API, todas las sesiones abiertas dejan de valer y cada persona vuelve a
entrar una vez. Es deliberado.

| Alternativa | Por qué no |
|---|---|
| Rellenar `session_id` en los tokens existentes | Un script por lotes sobre producción, para evitar un reingreso |
| Adoptar los tokens antiguos en su primer refresco | Código de compatibilidad durante toda la vigencia del refresh, y otro despliegue para retirarlo |

No hay backfill, purga ni `NOT NULL`, tampoco modos temporales ni seed. La migración es
solo aditiva: la API anterior sigue funcionando con ella aplicada.

## Orden de despliegue

Servicios afectados: `fchmn-mantenimiento`, como ejecutor puntual de la migración, y
`fchmn-api`. **`fchmn-web` no se despliega:** el JWT lleva un campo más y las respuestas no
cambian de forma.

1. **Aviso** a las personas usuarias, fuera de períodos de inscripción. Quien tenga un
   formulario a medias lo perderá.
2. **Respaldo**, con el procedimiento habitual del instructivo de nube.
3. **Migración:** imagen de mantenimiento del mismo commit, Docker Command con
   `prisma migrate deploy --schema=/app/prisma/schema.prisma` (sin `npx`: la imagen de
   mantenimiento ya trae `prisma` en el `PATH`), y vaciar el Docker Command al terminar.
   No ejecutar el seed: no hay permisos ni catálogos nuevos.
4. **API**, desde el mismo commit. El corte ocurre aquí.

Entre los pasos 3 y 4 la API anterior sigue atendiendo con normalidad. Si durante el relevo
la instancia antigua emite un token, esa persona solo tendrá que volver a entrar.

Las pestañas abiertas pasan al login en su siguiente petición, sin intervención.

## Comprobaciones después del corte

Consultas de **solo lectura**, con el método de
[verificacion-por-sql.md](verificacion-por-sql.md). `T0` es el instante en que la API nueva
quedó como única instancia.

```sql
-- Hay sesiones nuevas: la API está creando sesiones.
SELECT count(*) FROM refresh_sessions WHERE revoked_at IS NULL;

-- Debe ser 0: ninguna instancia antigua sigue emitiendo tokens sin sesión.
SELECT count(*) FROM refresh_tokens
 WHERE session_id IS NULL AND revoked_at IS NULL AND created_at > 'T0';

-- Debe ser 0: el invariante. Terminar una sesión revoca sus tokens.
SELECT count(*) FROM refresh_tokens t
  JOIN refresh_sessions s ON s.id = t.session_id
 WHERE s.revoked_at IS NOT NULL AND t.revoked_at IS NULL;
```

Además, con una cuenta propia: iniciar sesión, cerrarla, y comprobar que un refresco
posterior de esa misma pestaña lleva al login.

No hay compatibilidad que retirar. Los tokens antiguos que queden sin revocar ya son
inservibles y caducan solos en `JWT_REFRESH_EXPIRES_IN_DAYS`.

## Reversión

**El riesgo es reactivar sesiones ya invalidadas.** La API anterior no conoce
`refresh_sessions` ni `sid`: solo mira `refresh_tokens.revoked_at` y la firma del JWT. Por
eso volver atrás no es solo redesplegar.

En este orden, cada paso con su autorización:

1. **Revocar los tokens anteriores al corte.** La API nueva los ignora, pero la anterior
   los aceptaría:

   ```sql
   UPDATE refresh_tokens SET revoked_at = now()
    WHERE session_id IS NULL AND revoked_at IS NULL;
   ```

2. **Rotar `JWT_ACCESS_SECRET`** en el mismo despliegue de la API anterior. Sin esto, cada
   JWT de una sesión ya terminada volvería a valer durante su vigencia restante, 15 minutos
   por defecto. No cierra sesiones: quien tenga una cookie vigente obtiene otro token.
3. **Desplegar la API anterior.** Las sesiones terminadas siguen terminadas: su invariante
   las dejó con los tokens revocados.
4. **No borrar nada.** La tabla y la columna se quedan: la API anterior no las usa, y son el
   registro de lo que se revocó.

Nunca poner `revoked_at` en `NULL`, en ninguna de las dos tablas.

### Volver a avanzar después de una reversión

La API anterior no actualiza `refresh_sessions`, así que esa tabla puede tener sesiones que
figuran activas y ya no lo están. Antes de volver a desplegar la API nueva:

```sql
UPDATE refresh_sessions SET revoked_at = now(), revoked_reason = 'admin_revocation'
 WHERE revoked_at IS NULL;
UPDATE refresh_tokens SET revoked_at = now() WHERE revoked_at IS NULL;
```

Equivale a repetir el corte: todos vuelven a entrar una vez.

### Restaurar un respaldo anterior al corte

Un respaldo trae tokens que después se revocaron. Tras restaurarlo, antes de abrir el
servicio, hay que repetir los pasos 1 y 2 de la reversión si la API que quedará es la
anterior, o la sentencia de «volver a avanzar» si es la nueva.

## Límites que conviene conocer

- **Una petición que ya pasó la comprobación puede terminar.** La revocación rige para las
  peticiones posteriores a su confirmación.
- **Sin cookie no hay logout de servidor:** sin ella no se conoce la sesión, y su JWT
  caduca por su cuenta.
- **Si se pierde la respuesta de un refresco,** el reintento presenta un token ya rotado.
  Eso se lee como reuso y termina esa sesión: hay que volver a entrar. No hay ventana de
  gracia.
- **Una operación administrativa puede responder 409** («vuelva a intentarlo») si se cruza
  con un refresco de la misma cuenta. Las que pueden quitar un administrador (bloquear, inhabilitar, eliminar o retirar el acceso de una persona) corren en `Serializable` por la
  guarda del último administrador. Falla cerrada: o se aplicó entera, o no se aplicó nada.
- **El bloqueo temporal por intentos fallidos** rechaza las peticiones de la cuenta mientras
  dura, sin terminar sus sesiones. Es el comportamiento anterior, sin cambios.
