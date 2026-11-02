// =============================================================================
// CONSULTAS DE VERIFICACIÓN DE UNA CARGA MASIVA — generador de comandos
//
// Imprime tres comandos de SOLO LECTURA para pegar en el servicio de
// mantenimiento. No se conecta a nada: solo escribe texto.
//
//   node backend/scripts/carga-masiva/consultas-verificacion.mjs \
//        --manifiesto <ruta/manifiesto.json> \
//        --desde "AAAA-MM-DD HH:MM:SS" --hasta "AAAA-MM-DD HH:MM:SS" \
//        [--huella <suma de calcular-esperados.mjs>] [--solo E2]
//
// POR QUÉ UN GENERADOR Y NO TRES COMANDOS ESCRITOS EN UN DOCUMENTO
//
//   1. Los comandos llevan la fecha de la carga, la ventana de auditoría y la
//      huella de correspondencia. Escritos a mano en un documento, serían los
//      de UNA carga concreta y habría que editarlos con cuidado cada vez: es
//      exactamente la clase de edición manual en la que se cuela un error que
//      la consulta no puede detectar.
//   2. El SQL queda versionado como código y revisable en un diff, en lugar de
//      enterrado en una línea de 4.000 caracteres dentro de un .md.
//
// POR QUÉ TRES COMANDOS Y NO UNO. Juntos pasan de 11.000 caracteres. El campo
// donde se pegan tiene un límite que no está documentado; partidos en tres,
// cada uno queda en el tamaño que ya se ha usado con éxito, y el registro de
// cada ejecución se lee sin desplazarse.
//
// LO QUE ESTAS CONSULTAS NO HACEN: escribir. La sesión se pone en solo lectura
// por orden del motor antes de la primera consulta, y lo primero que imprime
// cada comando es `transaction_read_only`, que debe decir `on`.
//
// LO QUE DELIBERADAMENTE NO MIRAN: nada derivado de contraseñas. Una huella del
// hash de la cuenta administradora serviría para detectar un cambio de clave,
// pero es un derivado de una credencial y no entra en un repositorio público.
// Quien quiera esa comprobación la añade en su copia.
// =============================================================================

import fs from "node:fs";
import path from "node:path";

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;
const MARCA = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function argumento(nombre) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function morir(mensaje) {
  console.error(`DETENIDO: ${mensaje}`);
  process.exit(2);
}

const rutaManifiesto = argumento("manifiesto");
if (!rutaManifiesto) morir("Falta --manifiesto");
const absoluta = path.resolve(rutaManifiesto);
if (!fs.existsSync(absoluta)) morir(`No existe el manifiesto ${absoluta}`);
const manifiesto = JSON.parse(fs.readFileSync(absoluta, "utf8"));
if (!FECHA_ISO.test(String(manifiesto.fechaEfectiva ?? ""))) morir("El manifiesto no declara una fechaEfectiva válida");

const FECHA = manifiesto.fechaEfectiva;
const DESDE = argumento("desde");
const HASTA = argumento("hasta");
if (!DESDE || !HASTA) morir("Faltan --desde y --hasta: la ventana de la carga, en hora UTC («AAAA-MM-DD HH:MM:SS»)");
if (!MARCA.test(DESDE) || !MARCA.test(HASTA)) morir("--desde y --hasta deben tener la forma «AAAA-MM-DD HH:MM:SS»");
if (DESDE >= HASTA) morir("--desde tiene que ser anterior a --hasta");

const HUELLA = argumento("huella");
if (HUELLA !== undefined && !/^\d+$/.test(HUELLA)) morir("--huella tiene que ser el entero que imprime calcular-esperados.mjs");

const SOLO = argumento("solo");

// -----------------------------------------------------------------------------
// Los cuerpos.
//
// Ni `$` ni comillas dobles aparecen en ellos, a propósito: el `$` se construye
// con `String.fromCharCode(36)` y así da igual que el panel parta el comando en
// argumentos él mismo o lo pase por un shell, donde un `$` se expandiría.
//
// Un recorte del pegado FALLA, no miente: es una línea de JavaScript, así que si
// se corta, Node da un error de sintaxis. La señal de que llegó entera es la
// última línea, `=== CONSULTA En TERMINADA SIN ESCRIBIR NADA ===`.
// -----------------------------------------------------------------------------

const PREAMBULO = [
  "const{PrismaClient}=require('@prisma/client');",
  "const D=String.fromCharCode(36);",
  "const NL=String.fromCharCode(10);",
  "const u=process.env.DATABASE_URL;",
  // `connection_limit=1` para que este comando aporte EXACTAMENTE una conexión:
  // el grupo de Prisma abriría varias y contaminaría la comprobación de cuántas
  // hay conectadas.
  "const p=new PrismaClient({datasources:{db:{url:u+(u.includes('?')?'&':'?')+'connection_limit=1'}}});",
  "const Q=p[D+'queryRawUnsafe'].bind(p);",
  "const E=p[D+'executeRawUnsafe'].bind(p);",
  "const R=(k,v)=>typeof v==='bigint'?v.toString():v;",
  "const say=(t,v)=>console.log(NL+'--- '+t+' ---'+NL+JSON.stringify(v,R,1));",
  "const a1=D+'1';const a2=D+'2';const a3=D+'3';const a4=D+'4';const a5=D+'5';const a6=D+'6';",
].join("");

const CIERRE = (n) =>
  `console.log(NL+'=== CONSULTA ${n} TERMINADA SIN ESCRIBIR NADA ===');}catch(e){console.error('FALLO:',e&&e.message?e.message:e);process.exitCode=1;}finally{await p[D+'disconnect']();}})();`;

const APERTURA = "(async()=>{try{await E('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');say('0_solo_lectura',await Q('show transaction_read_only'));";

/** El valor de 4 bytes del md5 de la clave, en little-endian. Igual que en JS. */
const V = "get_byte(x.dd,0)::bigint + get_byte(x.dd,1)::bigint*256 + get_byte(x.dd,2)::bigint*65536 + get_byte(x.dd,3)::bigint*16777216";
const UNION = " from club_swimmers cs join persons pe on pe.id = cs.person_id join clubs c on c.id = cs.club_id ";
const CLAVE = (r, s, sep) =>
  `cross join lateral (select decode(md5(upper(translate(pe.run, ${r}::text, ${s}::text)) || ${sep}::text || upper(btrim(c.code))), `;

function e1() {
  return [
    PREAMBULO,
    "const A='active';const FE='" + FECHA + "';",
    APERTURA,
    "say('1_identidad_y_migraciones',await Q('select current_database() as base, current_user as usuario, pg_backend_pid()::int as pid, (select count(*)::int from pg_stat_activity where datname = current_database()) as conexiones_en_esta_base, now()::text as ahora, (select count(*)::int from _prisma_migrations where finished_at is not null and rolled_back_at is null) as migraciones, (select max(migration_name) from _prisma_migrations where finished_at is not null) as ultima_migracion'));",
    "say('2_TOTALES',await Q('select (select count(*)::int from clubs) as clubes, (select count(*)::int from clubs where deleted_at is null) as clubes_vigentes, (select count(*)::int from persons) as personas, (select count(*)::int from persons where deleted_at is null) as personas_vigentes, (select count(*)::int from club_swimmers) as membresias_todas, (select count(*)::int from club_swimmers where status::text = '+a1+') as membresias_activas, (select count(*)::int from club_staff) as cargos_de_club, (select count(*)::int from person_roles) as roles_de_persona, (select count(*)::int from users) as cuentas, (select count(*)::int from username_reservations) as reservas_de_nombre, (select count(*)::int from competitions) as competencias, (select count(*)::int from registrations) as inscripciones, (select count(*)::int from audit_logs) as auditoria_total',A));",
    "say('3_MEMBRESIAS_Y_FECHA_EFECTIVA',await Q('select (count(*))::int as activas, (count(*) filter (where start_date = '+a2+'::date))::int as con_fecha_aprobada, (count(*) filter (where start_date is distinct from '+a2+'::date))::int as con_otra_fecha, (count(*) filter (where start_date is null))::int as sin_fecha, min(start_date)::text as minima, max(start_date)::text as maxima, (count(distinct start_date))::int as fechas_distintas, (select array_agg(distinct start_date::text) from club_swimmers where status::text = '+a1+') as fechas_presentes, (count(*) filter (where reviewed_at is null))::int as sin_revision, (count(distinct reviewed_by_user_id))::int as revisores_distintos, (count(distinct reviewed_at))::int as instantes_de_revision_distintos, min(reviewed_at)::text as primera_revision, max(reviewed_at)::text as ultima_revision from club_swimmers where status::text = '+a1,A,FE));",
    "say('4_CLUBES_PERSONALIDAD_JURIDICA',await Q('select (count(*) filter (where has_legal_status is null))::int as pendientes_de_verificar, (count(*) filter (where has_legal_status = true))::int as con_personalidad, (count(*) filter (where has_legal_status = false))::int as sin_personalidad, (count(*) filter (where rut is not null))::int as con_rut, (count(*) filter (where legal_name is not null))::int as con_razon_social, (count(*) filter (where status::text = '+a1+'))::int as vigentes, (count(*) filter (where deleted_at is not null))::int as eliminados, (count(distinct upper(btrim(code))))::int as siglas_distintas, (count(distinct username))::int as nombres_de_usuario_distintos from clubs',A));",
    CIERRE("E1"),
  ].join("");
}

function e2() {
  const conHuella = HUELLA !== undefined;
  const seleccion = conHuella
    ? "sum(v)::text as huella_global, '+a6+'::text as huella_esperada, (sum(v) = '+a6+'::bigint) as coincide"
    : "sum(v)::text as huella_global";
  const parametros = conHuella ? "A,PT,VAC,SEP,HEX,HUE" : "A,PT,VAC,SEP,HEX";
  return [
    PREAMBULO,
    "const A='active';const SW='swimmer';const PT='.- ';const VAC='';const SEP='|';const HEX='hex';const DP=':';",
    conHuella ? "const HUE='" + HUELLA + "';" : "",
    APERTURA,
    "const V='" + V + "';",
    `say('5_CORRESPONDENCIA_PERSONA_CLUB',await Q('select count(*)::int as membresias_activas, (count(distinct run_norm))::int as runs_distintos, (count(distinct sigla))::int as clubes_distintos, ${seleccion} from (select upper(translate(pe.run, '+a2+'::text, '+a3+'::text)) as run_norm, upper(btrim(c.code)) as sigla, '+V+' as v'+'${UNION}'+'${CLAVE("'+a2+'", "'+a3+'", "'+a4+'")}'+a5+'::text) as dd) x where cs.status::text = '+a1+') q',${parametros}));`,
    `say('5b_por_club_sigla_n_suma',await Q('select array_agg(sigla || '+a2+'::text || n::text || '+a2+'::text || suma::text order by sigla) as por_club from (select upper(btrim(c.code)) as sigla, count(*)::int as n, sum('+V+') as suma'+'${UNION}'+'${CLAVE("'+a3+'", "'+a4+'", "'+a5+'")}'+a6+'::text) as dd) x where cs.status::text = '+a1+' group by 1) t',A,DP,PT,VAC,SEP,HEX));`,
    "say('6_ROLES_DE_NADADOR',await Q('select (select (count(*) filter (where role_type::text = '+a2+' and active))::int from person_roles) as nadador_activos, (select (count(*) filter (where role_type::text = '+a2+' and not active))::int from person_roles) as nadador_inactivos, (select (count(*) filter (where role_type::text <> '+a2+'))::int from person_roles) as de_otro_tipo, (select count(*)::int from club_swimmers cs where cs.status::text = '+a1+' and not exists (select 1 from person_roles r where r.person_id = cs.person_id and r.role_type::text = '+a2+' and r.active)) as activas_sin_rol_de_nadador, (select count(*)::int from person_roles r where r.role_type::text = '+a2+' and r.active and not exists (select 1 from club_swimmers cs where cs.person_id = r.person_id and cs.status::text = '+a1+')) as rol_sin_membresia_activa',A,SW));",
    "say('7_DUPLICADAS_Y_HUERFANAS',await Q('select (select count(*)::int from (select person_id from club_swimmers where status::text = '+a1+' group by person_id having count(*) > 1) t) as personas_con_mas_de_una_activa, (select count(*)::int from (select person_id, club_id from club_swimmers group by person_id, club_id having count(*) > 1) t) as pares_persona_club_repetidos, (select count(*)::int from club_swimmers cs join clubs c on c.id = cs.club_id where c.deleted_at is not null) as con_club_eliminado, (select count(*)::int from club_swimmers cs join persons pe on pe.id = cs.person_id where pe.deleted_at is not null) as con_persona_eliminada, (select count(*)::int from club_swimmers where status::text <> '+a1+') as en_otro_estado, (select count(*)::int from club_swimmers where end_date is not null) as con_fecha_de_termino, (select count(*)::int from club_swimmers where rejection_reason is not null) as con_motivo_de_rechazo, (select count(distinct requested_by_user_id)::int from club_swimmers) as solicitantes_distintos, (select count(*)::int from persons pe where pe.deleted_at is null and not exists (select 1 from club_swimmers cs where cs.person_id = pe.id and cs.status::text = '+a1+')) as personas_sin_membresia_activa, (select count(*)::int from clubs c where c.deleted_at is null and not exists (select 1 from club_swimmers cs where cs.club_id = c.id and cs.status::text = '+a1+')) as clubes_sin_nadadores, (select array_agg(upper(btrim(c.code)) order by upper(btrim(c.code))) from clubs c where c.deleted_at is null and not exists (select 1 from club_swimmers cs where cs.club_id = c.id and cs.status::text = '+a1+')) as siglas_sin_nadadores',A));",
    CIERRE("E2"),
  ].join("");
}

function e3() {
  return [
    PREAMBULO,
    "const SYS='system';const DP=':';const T0='" + DESDE + "';const T1='" + HASTA + "';",
    "const CC='CLUB_CREATED';const PC='PERSON_CREATED';const SA='SWIMMER_ASSIGNMENT_DIRECT';",
    APERTURA,
    "say('8_CUENTAS_DE_ACCESO',await Q('select username, owner_type::text as titular, status::text as estado, must_change_password as debe_cambiar_clave, (person_id is not null) as ligada_a_persona, (club_id is not null) as ligada_a_club, created_at::text as creada, updated_at::text as actualizada, last_login_at::text as ultimo_ingreso, deleted_at::text as eliminada from users order by created_at'));",
    "say('8b_cuentas_y_reservas',await Q('select (select count(*)::int from users) as cuentas_total, (select count(*)::int from users where owner_type::text = '+a1+') as del_sistema, (select count(*)::int from users where person_id is not null) as de_personas, (select count(*)::int from users where club_id is not null) as de_clubes, (select count(*)::int from refresh_tokens) as sesiones_registradas, (select count(*)::int from refresh_tokens where revoked_at is null and expires_at > now()) as sesiones_vigentes, (select array_agg(owner_kind || '+a2+'::text || n order by owner_kind) from (select owner_kind, count(*)::text as n from username_reservations group by owner_kind) t) as reservas_por_titular',SYS,DP));",
    "say('9_AUDITORIA_POR_ETAPA',await Q('select action, entity_type, count(*)::int as asientos, (count(distinct entity_id))::int as entidades_distintas, min(created_at)::text as primero, max(created_at)::text as ultimo, (count(distinct user_id))::int as autores from audit_logs where created_at >= '+a1+'::timestamp and created_at < '+a2+'::timestamp group by action, entity_type order by count(*) desc',T0,T1));",
    "say('9b_auditoria_dentro_y_fuera',await Q('select (select count(*)::int from audit_logs) as total, (select count(*)::int from audit_logs where created_at < '+a1+'::timestamp) as antes_de_la_carga, (select count(*)::int from audit_logs where created_at >= '+a1+'::timestamp and created_at < '+a2+'::timestamp) as en_la_ventana, (select count(*)::int from audit_logs where created_at >= '+a2+'::timestamp) as despues_de_la_ventana, (select max(created_at)::text from audit_logs) as ultimo_asiento',T0,T1));",
    "say('9c_cobertura_de_auditoria',await Q('select (select count(*)::int from clubs c where not exists (select 1 from audit_logs a where a.action = '+a1+' and a.entity_id = c.id)) as clubes_sin_asiento, (select count(*)::int from persons pe where not exists (select 1 from audit_logs a where a.action = '+a2+' and a.entity_id = pe.id)) as personas_sin_asiento, (select count(*)::int from club_swimmers cs where not exists (select 1 from audit_logs a where a.action = '+a3+' and a.entity_id = cs.id)) as membresias_sin_asiento, (select count(*)::int from audit_logs a where a.action = '+a3+' and not exists (select 1 from club_swimmers cs where cs.id = a.entity_id)) as asientos_de_membresia_huerfanos',CC,PC,SA));",
    "say('10_ESCRITURAS_POR_TABLA',await Q('select relname as tabla, n_tup_ins::text as insertadas, n_tup_upd::text as actualizadas, n_tup_del::text as borradas, n_live_tup::text as vivas from pg_stat_user_tables where n_tup_ins + n_tup_upd + n_tup_del > 0 order by relname'));",
    CIERRE("E3"),
  ].join("");
}

const comandos = [
  ["E1", "totales, fecha efectiva y personalidad jurídica", e1()],
  ["E2", "correspondencia persona-club, roles, duplicadas y huérfanas", e2()],
  ["E3", "cuentas de acceso, auditoría de las tres etapas y escrituras por tabla", e3()],
];

for (const [nombre, que, cuerpo] of comandos) {
  if (SOLO && SOLO.toUpperCase() !== nombre) continue;
  if (cuerpo.includes('"')) morir(`${nombre}: el cuerpo trae comillas dobles y no se puede envolver en node -e`);
  if (/\$/.test(cuerpo)) morir(`${nombre}: el cuerpo trae un signo de dólar literal`);
  console.log(`\n${"=".repeat(78)}`);
  console.log(`${nombre} — ${que}   (${cuerpo.length + 10} caracteres)`);
  console.log("=".repeat(78));
  console.log(`node -e "${cuerpo}"`);
}

console.log(`\n${"-".repeat(78)}`);
console.log(`fecha efectiva declarada: ${FECHA}`);
console.log(`ventana de auditoría: ${DESDE} → ${HASTA} (UTC)`);
console.log(HUELLA !== undefined ? `huella de correspondencia esperada: ${HUELLA}` : "sin --huella: E2 imprime la huella pero no la compara");
