# Instrucciones para trabajar en este repositorio

Reglas permanentes. El funcionamiento del sistema está en `README.md` y en `docs/`.

## Antes de empezar

- Lee la documentación pertinente a la tarea (`README.md`, `docs/` y los demás archivos de instrucciones aplicables).
- Consulta el estado y el historial de Git antes de modificar nada.

## Alcance y cambios ajenos

- Haz exclusivamente lo autorizado. Lo que encuentres fuera de ese alcance se informa; no se corrige por cuenta propia.
- Preserva los cambios ajenos del árbol de trabajo (archivos modificados o sin seguimiento que no creaste): no los reviertas, reformatees ni incluyas.
- Si la tarea es de solo lectura, no modifiques archivos, datos, configuración ni Git, y no ejecutes nada que escriba.

## Git y producción

- No hagas commit, push ni operaciones en producción sin autorización explícita. La autorización vale para la operación nombrada, no para las siguientes.
- Cuando una operación ya esté autorizada, continúa sin pedir de nuevo el mismo permiso.

## Datos sensibles

- No publiques ni reproduzcas datos personales, credenciales, respaldos ni archivos privados, ni en el código, ni en los mensajes de commit, ni en la documentación, ni en los informes.
- En pruebas y ejemplos usa datos sintéticos.

## Comprobaciones

- Que sean proporcionales al cambio: las pruebas de lo que tocaste y, cuando corresponda, el typecheck y el lint del área. Una suite completa solo con una necesidad concreta.
- No repitas validaciones ya aprobadas, salvo que haya cambios, fallos o dudas concretas que lo justifiquen.
- Las pruebas de integración deben ejecutarse exclusivamente contra la base desechable de `docker-compose.test.yml`, respetando sus protecciones; nunca contra producción ni la base de trabajo.

## Recursos de prueba

- Si levantas contenedores o servidores solo para probar, registra cuáles son y detenlos al terminar, también cuando haya fallos.
- No detengas recursos ajenos o compartidos.
- No elimines contenedores, imágenes, volúmenes ni datos sin autorización específica.

## Informe final

Informa siempre:

- los archivos modificados;
- las comprobaciones ejecutadas y sus resultados;
- las limitaciones;
- el estado de Git;
- los recursos iniciados y detenidos.

Distingue las pruebas simuladas de las observaciones reales.

## Exploración del código

- Para búsquedas literales y cambios localizados, usa `rg` y la lectura directa.
- Graphify es opcional y sirve para arquitectura, dependencias y relaciones entre módulos (`graphify query`, `path`, `explain`). Confirma lo que indique en el código y la configuración.
- `graphify-out/` es salida local regenerable, ignorada por Git. Puede faltar, fallar o estar desactualizada, y eso nunca bloquea el trabajo: se lee el código directamente.
- No lo regeneres (`graphify update .`) en tareas de solo lectura. Si tras cambios estructurales hace falta, actualízalo una sola vez al terminar el bloque de trabajo, no después de cada edición.
