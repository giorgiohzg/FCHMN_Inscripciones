# Módulo 9 — Validaciones: Matriz de Trazabilidad

Este módulo no introduce lógica nueva: las 12 validaciones exigidas por la **sección 15**
del requerimiento ya se implementaron dentro de los Módulos 7 (inscripciones individuales)
y 8 (inscripciones de relevos), en funciones puras dedicadas y testeadas. Este documento
existe para dejar explícita la trazabilidad completa — útil para QA y para auditorías
futuras — y para señalar las dos decisiones de diseño que resuelven puntos no triviales
del requerimiento.

## Matriz de cobertura

| # | Validación (sección 15) | Individual | Relevo | Implementación |
|---|---|:---:|:---:|---|
| 1 | La competencia está abierta | ✅ | ✅ | `competitionIsOpen` — reutiliza `computeEffectiveStatus`/`isRegistrationOpen` del Módulo 6 |
| 2 | El club está activo y habilitado | ✅ | ✅ | `clubIsActive` |
| 3 | El usuario tiene permiso para inscribir | ✅ | ✅ | RBAC (`registrations:write`) + alcance por club (`actorClubId`) en la capa de servicio, no solo oculto en la UI |
| 4 | El nadador está activo | ✅ | ✅ (por integrante) | `swimmerIsActive` |
| 5 | El nadador pertenece al club | ✅ | ✅ (por integrante) | `swimmerBelongsToClub` — verifica `ClubSwimmer.status = active` (Módulo 4) |
| 6 | El nadador cumple la categoría por edad | ✅ | ✅ (por integrante) | `computeAge()` (Módulo 5, RB-05) vs. rango de la categoría |
| 7 | El género del nadador es compatible con la prueba | ✅ | ✅ (por integrante) | comparación directa, `mixed` exime la regla |
| 8 | La prueba está habilitada para la competencia | ✅ | ✅ | `competitionEventIsEnabled` (`CompetitionEvent.status = enabled`, Módulo 6) |
| 9 | La prueba está habilitada para la fecha y jornada | ✅ | ✅ | **Estructural, no una validación de tiempo de ejecución**: cada `CompetitionEvent` referencia una única `competitionSessionId` (fecha+jornada) desde su creación (Módulo 6, sección 13) — al elegir la prueba en el asistente ya se está eligiendo su fecha/jornada, por lo que no puede existir una combinación inválida |
| 10 | No se supera el máximo de pruebas individuales | ✅ | — | `currentIndividualCountInSession` vs. `SessionLimit.maxIndividualEvents` (por nadador, por fecha+jornada — RB-10) |
| 11 | No se supera el máximo de relevos | — | ✅ | `currentRelayCountInSession` vs. `SessionLimit.maxRelayEvents` (por integrante, por fecha+jornada — RB-10) |
| 12 | No existe una inscripción duplicada | ✅ | ✅ (equivalente: un equipo por club) | `alreadyRegisteredForThisEvent` (individual) / `duplicateTeamForClub` (relevo) |
| 13 | Para relevos, existen exactamente 4 nadadores | — | ✅ | `personIds` con `.length(4)` en el esquema Zod + verificación redundante en la regla pura |
| 14 | Los 4 nadadores cumplen las reglas aplicables | — | ✅ | reglas 4-7 y 11 evaluadas **individualmente por integrante**, con el nombre del nadador en cada mensaje de error |

**Cobertura: 14/14.**

## Decisiones de diseño relevantes

1. **Mensajes acumulativos, no "fail-fast"**: tanto `validateIndividualRegistration` como `validateRelayRegistration` recorren *todas* las reglas y acumulan *todos* los errores aplicables antes de retornar, en vez de detenerse en la primera falla. Esto cumple literalmente el requisito "Las reglas deben devolver mensajes claros y comprensibles al usuario" — el usuario corrige todo de una vez, no en rondas sucesivas de prueba y error.

2. **Punto #3 (permiso del usuario) se resuelve en dos capas**, no solo en la validación de negocio:
   - RBAC de Fastify (`requirePermission('registrations:write')`) rechaza la petición antes de llegar al servicio si el rol no tiene el permiso.
   - Dentro del servicio, si quien opera es un usuario de tipo `club`, se verifica que el `clubId` de la inscripción coincida con el club del usuario autenticado — un club no puede inscribir nadadores de otro club aunque conozca su ID.

3. **Excepción post-cierre (RB-08)**: las validaciones 1 y 8 (competencia abierta / prueba habilitada) admiten una excepción explícita y auditada cuando el actor tiene el permiso `registrations:write:post-close` (exclusivo del rol `admin`). Esta excepción se registra en el propio registro de inscripción (`isPostCloseException = true`), visible en los listados y reportes.

## Verificación

**Cifras medidas el 12 de septiembre de 2026** (`npm run test` en `backend/`): las
**45 pruebas unitarias** de este bloque —23 en `registrations.rules.test.ts` y 22
en `relay-registrations.rules.test.ts`— cubren cada fila de la matriz de forma
aislada y también su combinación (varios errores a la vez). No se agregan pruebas
nuevas en este módulo porque no hay código nuevo que probar: la cobertura vive con
las reglas.

> La versión anterior de este párrafo hablaba de 31 pruebas (16 + 15). Eran las que
> había al cerrar el Módulo 9; después crecieron con las correcciones de auditoría
> posteriores.

A esto se suman las pruebas de integración que ejercitan las mismas reglas por
HTTP —alcance por club, excepción post-cierre, concurrencia— en
`tests/integration-registration-flow.integration.test.ts`,
`tests/authorization.integration.test.ts` y
`tests/listados-alcance.integration.test.ts`, entre otras.
