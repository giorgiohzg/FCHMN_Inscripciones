# Operación

Guías para operar el sistema ya instalado. No son un tutorial de instalación ni
de desarrollo.

| Documento | Para qué |
|---|---|
| [carga-masiva-inicial.md](carga-masiva-inicial.md) | Poblar un sistema recién instalado con clubes, personas y membresías desde planillas, por la API y sin tocar la base |
| [corte-de-sesiones.md](corte-de-sesiones.md) | Desplegar `refresh_sessions` en un sistema en producción, y revertirlo sin reactivar sesiones invalidadas |
| [verificacion-por-sql.md](verificacion-por-sql.md) | Comprobar por SQL de **solo lectura**, desde el servicio de mantenimiento, qué quedó de verdad en la base |

## Lo que NO está aquí, y dónde está

Esta carpeta no repite el instructivo de instalación. Si busca una de estas
cosas, está en **[`Instructivo_Instalacion_Nube.md`](../../Instructivo_Instalacion_Nube.md)**:

| | Dónde |
|---|---|
| Crear los servicios, las variables de entorno y la base | Instructivo de nube, pasos 1 a 7 |
| `IP_CLIENTE_FUENTE` (antes `TRUST_PROXY_HOPS`) y el resto de la configuración de la API | Instructivo de nube, paso 6 |
| Respaldos: crear la exportación, descargarla, comprobarla y la rutina de retención | Instructivo de nube, «Respaldos y recuperación» |
| Leer qué commit está desplegado y desactivar o reactivar el despliegue automático | Instructivo de nube |
| Ensayo de restauración de un respaldo | Instructivo de nube |

Y para el entorno local, **[`Instructivo_Instalacion_Local.md`](../../Instructivo_Instalacion_Local.md)**.

## Dos reglas que valen para todo lo de esta carpeta

**1. Las planillas y los resultados no entran en el repositorio.** Este
repositorio es público, incluido `docs/`. Las planillas de carga llevan RUN,
nombres, correos y fechas de nacimiento; los resultados por etapa llevan nombres
de usuario y siglas. Viven en la carpeta de trabajo de quien opera, fuera del
árbol de Git. Las herramientas están escritas para que eso no dependa de la
memoria de nadie: el cargador **se niega a escribir sus resultados dentro del
repositorio**.

**2. Lo específico de una operación va en un manifiesto.** Fechas, totales,
nombres de archivo y huellas no se escriben en los guiones ni en estos
documentos: van en un archivo JSON que acompaña a las planillas. Hay una
plantilla en
[`backend/scripts/carga-masiva/manifiesto.ejemplo.json`](../../backend/scripts/carga-masiva/manifiesto.ejemplo.json).
