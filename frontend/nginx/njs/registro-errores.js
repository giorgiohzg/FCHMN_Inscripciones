/*
 * RECEPTOR DE LOS ERRORES DE PETICIÓN DE NGINX (njs, módulo `stream`).
 *
 * POR QUÉ EXISTE. Cuando falla una petición, Nginx escribe en su registro de errores la línea de
 * petición, la URI del upstream y el `Referer` (`request:`, `upstream:`, `referrer:`), CON su cadena de
 * consulta: ahí viajan búsquedas por nombre o RUN. Algunos mensajes copian además `uri?args` en el propio
 * texto (por ejemplo «http finalize non-active request», nivel alert). Nginx 1.30 de código abierto no
 * tiene directiva para quitarlos.
 *
 * QUÉ HACE. El servidor web envía sus errores de petición por syslog (UDP, solo 127.0.0.1) a un servidor
 * `stream` del mismo Nginx, que ejecuta `recibir`. Cada datagrama se PROYECTA a cuatro campos de una lista
 * cerrada (canal, nivel, clase y errno). Ningún valor de salida se copia del mensaje: todos son constantes
 * de este archivo, y la línea final se valida contra esa lista antes de emitirse.
 *
 * NADA SE REGISTRA DE UNA EXCEPCIÓN. njs escribe en el registro el mensaje de cualquier excepción que
 * escape del manejador, y ese mensaje podría contener el datagrama. Por eso cada etapa —registro del
 * callback, conversión, clasificación, serialización, validación, emisión y finalización— está en su
 * propio `try`, los `catch` solo asignan constantes y nunca se vuelve a lanzar. Si algo falla, se emite
 * `RESPALDO` (mismo esquema, clase `error_interno`) una sola vez, sin reintentos. Si falla la propia
 * emisión, el mensaje se pierde: es preferible perder diagnóstico a filtrar datos.
 *
 * QUÉ NO CUBRE. Fallos del motor njs o de Nginx que no se pueden atrapar desde JavaScript (memoria,
 * desbordamiento de pila, terminación del worker), ni los datagramas que UDP pierda.
 */

var CANAL = 'errores_peticion';

var NIVELES = ['emerg', 'alert', 'crit', 'error', 'warn', 'notice', 'info', 'debug'];

// Clase y patrón. La clase es una constante; el patrón solo decide cuál.
var CLASES = [
    ['conexion_rechazada', /connect\(\) failed \((\d{1,4}): /],
    ['dns', /could not be resolved \((\d{1,4}): /],
    ['timeout', /upstream timed out \((\d{1,4}): /],
    ['respuesta_invalida', /upstream sent (?:no valid|invalid)/],
    ['lectura_upstream', /(?:readv|recv|writev|send)\(\) failed \((\d{1,4}): /],
    ['cierre_prematuro', /upstream prematurely closed/],
    ['cuerpo_excesivo', /client intended to send too large body/],
    ['archivo', /open\(\) "[^"]*" failed \((\d{1,4}): /],
    ['finalizacion_no_activa', /http finalize non-active request/]
];

// errno solo si pertenece a este conjunto; si no, la constante "otro".
var ERRNOS = { '2': 2, '13': 13, '32': 32, '104': 104, '110': 110, '111': 111, '113': 113 };

var RESPALDO = '{"canal":"errores_peticion","nivel":"desconocido","clase":"error_interno","errno":"ninguno"}';

function nombresDeClases() {
    var r = ['desconocido', 'error_interno'];
    for (var i = 0; i < CLASES.length; i++) { r.push(CLASES[i][0]); }
    return r;
}

function valoresDeErrno() {
    var r = ['"otro"', '"ninguno"'];
    for (var k in ERRNOS) { if (Object.prototype.hasOwnProperty.call(ERRNOS, k)) { r.push(String(ERRNOS[k])); } }
    return r;
}

// La ÚNICA forma que puede tener una línea emitida.
var PERMITIDA = new RegExp(
    '^\\{"canal":"' + CANAL + '"' +
    ',"nivel":"(?:' + NIVELES.concat(['desconocido']).join('|') + ')"' +
    ',"clase":"(?:' + nombresDeClases().join('|') + ')"' +
    ',"errno":(?:' + valoresDeErrno().join('|') + ')\\}$'
);

function texto(data) {
    if (typeof data === 'string') { return data; }
    var t = String(data);
    if (typeof t !== 'string') { throw new Error('conversion'); }
    return t;
}

function proyectar(t) {
    if (typeof t !== 'string') { throw new Error('tipo'); }
    var r = { nivel: 'desconocido', clase: 'desconocido', errno: 'ninguno' };
    var pri = /^<(\d{1,3})>/.exec(t);
    if (pri) {
        var n = Number(pri[1]);
        if (n >= 0 && n <= 191) { r.nivel = NIVELES[n % 8]; }
    }
    // Solo el tramo anterior al contexto (", client: ") decide la clase: así una consulta del contexto
    // no puede elegirla. Una clasificación equivocada nunca copia datos: la salida sigue siendo constante.
    var corte = t.indexOf(', client: ');
    var mensaje = corte >= 0 ? t.slice(0, corte) : t;
    for (var i = 0; i < CLASES.length; i++) {
        var c = CLASES[i][1].exec(mensaje);
        if (c) {
            r.clase = CLASES[i][0];
            if (c[1] !== undefined) {
                r.errno = Object.prototype.hasOwnProperty.call(ERRNOS, c[1]) ? ERRNOS[c[1]] : 'otro';
            }
            break;
        }
    }
    return r;
}

function serializar(r) {
    var errno = (typeof r.errno === 'number') ? String(r.errno) : '"' + r.errno + '"';
    return '{"canal":"' + CANAL + '","nivel":"' + r.nivel + '","clase":"' + r.clase + '","errno":' + errno + '}';
}

/** `etapas` permite a las pruebas forzar fallos en cada paso; en Nginx se usan las reales. */
function crearProcesador(etapas) {
    return function procesar(s, data) {
        var linea = RESPALDO;
        try { linea = etapas.serializar(etapas.proyectar(etapas.texto(data))); } catch (e) { linea = RESPALDO; }
        try {
            if (typeof linea !== 'string' || !PERMITIDA.test(linea)) { linea = RESPALDO; }
        } catch (e) { linea = RESPALDO; }
        try { s.warn(linea); } catch (e) { /* se pierde el diagnóstico; sin reintento */ }
        try { s.off('upload'); } catch (e) { /* nada */ }
        try { s.done(); } catch (e) { /* nada */ }
    };
}

var procesar = crearProcesador({ texto: texto, proyectar: proyectar, serializar: serializar });

function crearReceptor(proc) {
    return function recibir(s) {
        try {
            s.on('upload', function (data) {
                try { proc(s, data); } catch (e) { /* proc no lanza; defensa adicional */ }
            });
        } catch (e) {
            try { s.warn(RESPALDO); } catch (e2) { /* nada */ }
            try { s.done(); } catch (e3) { /* nada */ }
        }
    };
}

var recibir = crearReceptor(procesar);

export default {
    recibir: recibir,
    procesar: procesar,
    proyectar: proyectar,
    serializar: serializar,
    texto: texto,
    crearProcesador: crearProcesador,
    crearReceptor: crearReceptor,
    PERMITIDA: PERMITIDA,
    RESPALDO: RESPALDO
};
