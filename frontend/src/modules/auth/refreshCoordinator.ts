/**
 * COORDINACIÓN DE LA SESIÓN ENTRE PETICIONES Y ENTRE PESTAÑAS.
 *
 * El refresh token es de UN SOLO USO: cada renovación revoca el anterior y el
 * backend interpreta el uso de un token ya rotado como robo de sesión,
 * revocando TODAS las sesiones del usuario.
 *
 * QUÉ SE GARANTIZA, EXACTAMENTE
 * -----------------------------
 * **Serialización.** Nunca hay dos renovaciones EN VUELO a la vez, ni dentro de
 * una pestaña ni entre pestañas. Eso es lo que evita el reuso: el refresh token
 * vive en una cookie que el navegador comparte, así que dos peticiones
 * simultáneas enviarían el MISMO valor y la segunda se leería como robo. Con las
 * renovaciones en fila, la segunda pestaña envía la cookie ya rotada, que es
 * válida.
 *
 * **NO se garantiza una sola renovación en total.** El aviso por
 * `BroadcastChannel` es asíncrono: entre que una pestaña libera el cerrojo y que
 * la otra recibe el mensaje hay una ventana en la que la segunda puede entrar al
 * cerrojo sin haberse enterado, y renovar. Eso produce una rotación de más
 * —inocua, porque cada rotación emite una sesión válida— pero desmiente
 * cualquier afirmación de unicidad. El canal es una OPTIMIZACIÓN que ahorra
 * rotaciones en el caso normal, no una barrera.
 *
 * Las tres piezas:
 *   1. PROMESA COMPARTIDA — varias peticiones de la misma pestaña con 401.
 *   2. WEB LOCKS — serializa las pestañas. Es lo que da la garantía.
 *   3. BROADCASTCHANNEL — comparte el resultado para ahorrar rotaciones, y
 *      propaga el cierre de sesión.
 */

const NOMBRE_CERROJO = "fchmn-refresh-sesion";
const NOMBRE_CANAL = "fchmn-sesion";

import { validarSesion, type SesionValidada } from "./sessionSchema";

/** Lo que una renovación produce, ya validado. */
export type SesionRenovada = SesionValidada;

/**
 * Los TRES desenlaces posibles de una renovación.
 *
 * Antes se devolvía `SesionRenovada | null` y `null` mezclaba dos cosas muy
 * distintas: "el servidor dice que la sesión no vale" y "el resultado se
 * descartó porque el ciclo cambió mientras estaba en vuelo". El llamador
 * trataba las dos igual y limpiaba la sesión, así que un refresco que terminaba
 * después de un login con otra cuenta cerraba la sesión recién iniciada.
 */
export type ResultadoRenovacion =
  | { tipo: "renovada"; sesion: SesionRenovada }
  /** 401 confirmado: hay que volver a entrar. */
  | { tipo: "invalida" }
  /** El ciclo cambió mientras se renovaba: no hay nada que hacer, y nada que limpiar. */
  | { tipo: "descartada" };

/**
 * IDENTIDAD DEL CICLO DE SESIÓN.
 *
 * Cada ciclo —lo que va de un login a su cierre— tiene un identificador
 * opaco, y un mensaje solo se adopta si pertenece AL MISMO ciclo. La
 * comparación es de IGUALDAD, nunca de orden.
 *
 * POR QUÉ NO UN CONTADOR. La versión anterior usaba `let generacion = 1` local
 * a cada pestaña y comparaba con `<`. Dos pestañas con historiales distintos
 * llegaban a números distintos —una en 8, otra en 2— y entonces un mensaje
 * ANTIGUO con generación 8 se colaba en la pestaña que iba por 2, porque 8 no
 * es menor que 2. El número local no es un reloj global y no puede usarse como
 * si lo fuera.
 *
 * LIMITACIÓN CONOCIDA, PENDIENTE DE APROBACIÓN. Este identificador se genera en
 * el CLIENTE, así que dos pestañas que arrancan por separado (dos recargas
 * independientes) tienen ciclos distintos y no se reconocen entre sí: dejan de
 * ahorrarse rotaciones por el canal, aunque el cierre de sesión sí se propaga
 * (ver abajo) y la serialización por Web Locks —que es la garantía real— no se
 * ve afectada. La solución completa es un `sessionId` emitido por el BACKEND y
 * estable durante las rotaciones; requiere una columna nueva en
 * `refresh_tokens`, y por eso está presentada como propuesta en vez de
 * implementada.
 */
/**
 * AUTORIDAD COMPARTIDA DEL CICLO VIGENTE.
 *
 * `BroadcastChannel` no ordena los mensajes de emisores distintos: dos pestañas
 * que publican a la vez pueden llegar en cualquier orden a una tercera. Aceptar
 * `iniciada` y `cerrada` sin más dejaba dos agujeros reales:
 *
 *   - inicio de A emitido ANTES pero entregado DESPUÉS del inicio de B → la
 *     receptora volvía a A;
 *   - cierre de A entregado después del login de B → cerraba la sesión de B.
 *
 * La solución es no dejar que el orden de entrega decida. El estado vigente se
 * guarda en `localStorage`, que es **compartido por todas las pestañas del
 * origen** y se escribe DENTRO del cerrojo: quien entra en la sección crítica
 * fija la autoridad, y el orden lo determina el cerrojo, no la red de mensajes.
 *
 * NO ES UN VALOR SUELTO, ES UN REGISTRO CON TUMBA:
 *
 *     { ciclo, estado: "active" | "closed", revision }
 *
 * Borrar la clave al cerrar sesión —lo que se hacía antes— deja el origen SIN
 * autoridad, y "sin autoridad" es indistinguible de "nunca hubo sesión": un
 * `iniciada` o un `renovado` atrasado del ciclo recién cerrado caía entonces en
 * el camino de reserva y podía reactivar la sesión. La tumba (`estado:
 * "closed"`) convierte eso en una comprobación explícita y verificable: el ciclo
 * cerrado sigue estando ahí, marcado como cerrado.
 *
 * `revision` es un contador **monotónico** del origen. Nunca retrocede, y una
 * escritura con revisión anterior se rechaza. Sirve para que dos pestañas que
 * escriben casi a la vez no puedan reordenarse: gana la revisión mayor, no la
 * última en llegar.
 *
 * El valor NO es secreto: identificadores opacos y un contador. No da acceso a
 * nada.
 */
const CLAVE_AUTORIDAD = "fchmn.ciclo";

export interface AutoridadDeSesion {
  ciclo: string;
  estado: "active" | "closed";
  revision: number;
}

/**
 * Lee el registro autoritativo del origen.
 *
 * `null` significa "no se puede saber": no hay nada escrito, el almacenamiento
 * está bloqueado, o lo que hay no tiene la forma esperada (una versión anterior
 * de la aplicación guardaba aquí una cadena suelta). En los tres casos se cae al
 * camino de reserva, que es más conservador, nunca más permisivo.
 */
function leerAutoridad(): AutoridadDeSesion | null {
  let crudo: string | null;
  try {
    crudo = localStorage.getItem(CLAVE_AUTORIDAD);
  } catch {
    // Almacenamiento bloqueado (modo privado, políticas del navegador).
    return null;
  }
  if (crudo === null) return null;

  try {
    const v: unknown = JSON.parse(crudo);
    if (typeof v !== "object" || v === null) return null;
    const a = v as Record<string, unknown>;
    if (typeof a.ciclo !== "string" || a.ciclo.length === 0) return null;
    if (a.estado !== "active" && a.estado !== "closed") return null;
    if (typeof a.revision !== "number" || !Number.isInteger(a.revision) || a.revision < 1) return null;
    return { ciclo: a.ciclo, estado: a.estado, revision: a.revision };
  } catch {
    // Cadena suelta de una versión anterior, o JSON corrupto.
    return null;
  }
}

/**
 * MODO DEGRADADO: esta pestaña dejó de poder persistir sus transiciones.
 *
 * El caso que lo obliga: `setItem` falla —cuota, modo privado, políticas— justo
 * cuando esta pestaña inicia sesión como B. El registro compartido sigue
 * diciendo `{ciclo A, active, N}` y **sigue siendo legible**, así que en la
 * siguiente sincronización esta pestaña volvería al ciclo A… que ya no
 * corresponde a la cookie que el navegador acaba de recibir, que es la de B.
 * Todo lo que hiciera a partir de ahí saldría etiquetado con una sesión muerta.
 *
 * La regla es entonces: **quien sabe que no pudo persistir una transición deja
 * de tratar el valor anterior como fuente de verdad.** Pasa al camino de
 * reserva —su ciclo local manda— hasta que consiga escribir de nuevo.
 *
 * Lo que esta pestaña SÍ conserva en modo degradado:
 *   - opera con el ciclo correcto, el de la cookie vigente;
 *   - sigue emitiendo mensajes con una revisión mayor que la persistida, que es
 *     lo que permite a las demás enterarse (ver `evaluarMensaje`);
 *   - la serialización de Web Locks, que no depende de esto.
 *
 * Lo que NO puede garantizar:
 *   - que otra pestaña que arranque desde cero se una a su ciclo: esa leerá el
 *     registro antiguo, que nadie pudo actualizar;
 *   - el orden frente a transiciones simultáneas de otras pestañas, porque ya no
 *     participa en el registro compartido.
 */
let autoridadFiable = true;

type ResultadoEscritura =
  /** Quedó en el almacenamiento compartido. */
  | "escrita"
  /** Rechazada por monotonicidad: lo que hay es MÁS NUEVO y debe prevalecer. */
  | "rechazada"
  /** No se pudo escribir: el almacenamiento no está disponible. */
  | "sin-almacenamiento";

/**
 * Escribe el registro, con dos reglas de MONOTONICIDAD:
 *
 *   - una revisión anterior a la vigente no se escribe;
 *   - una tumba no se puede reabrir con la MISMA revisión.
 *
 * Sin ellas, dos escrituras casi simultáneas podrían dejar el origen en el
 * estado de la que terminó última, que no es necesariamente la más nueva.
 *
 * El resultado NO es decorativo: `"sin-almacenamiento"` degrada esta pestaña
 * (ver `autoridadFiable`). `"rechazada"` no la degrada, al contrario: significa
 * que otra pestaña registró una transición posterior, y esa sí es fuente de
 * verdad.
 */
function escribirAutoridad(a: AutoridadDeSesion): ResultadoEscritura {
  const actual = leerAutoridad();
  if (actual) {
    if (a.revision < actual.revision) return "rechazada";
    if (a.revision === actual.revision && actual.estado === "closed" && a.estado === "active") return "rechazada";
  }
  try {
    localStorage.setItem(CLAVE_AUTORIDAD, JSON.stringify(a));
    // Se recupera la confianza: esta transición sí quedó registrada.
    autoridadFiable = true;
    return "escrita";
  } catch {
    autoridadFiable = false;
    return "sin-almacenamiento";
  }
}

/**
 * El registro compartido, SOLO si esta pestaña puede seguir fiándose de él.
 *
 * Es la lectura que usan las decisiones (qué mensajes se aceptan, con qué ciclo
 * se opera). `escribirAutoridad` usa la lectura cruda, porque para respetar la
 * monotonicidad hay que mirar lo que hay escrito de verdad.
 */
function autoridadVigente(): AutoridadDeSesion | null {
  return autoridadFiable ? leerAutoridad() : null;
}

/**
 * SALIDA DEL MODO DEGRADADO.
 *
 * Sin esto, la degradación era una trampa sin salida: `autoridadFiable` solo
 * volvía a `true` cuando ESTA instancia conseguía escribir, así que una pestaña
 * cuyo `setItem` falló una vez podía ignorar para siempre las transiciones de
 * las demás —comparaba los mensajes únicamente con su ciclo local— aunque el
 * almacenamiento se hubiera recuperado hace rato.
 *
 * La comprobación es barata y se hace donde importa: **bajo el cerrojo**, antes
 * de decidir sobre un mensaje o de operar. Si el registro contiene una autoridad
 * al menos tan nueva como la última revisión que esta pestaña emitió, es que
 * alguien pudo escribir después de nuestro fallo, y entonces vuelve a ser fuente
 * de verdad.
 *
 * El umbral es `>= revisionLocal`, no `>`:
 *   - por debajo (`<`) el registro es ANTERIOR a nuestra transición y adoptarlo
 *     nos devolvería a una sesión que la cookie ya no respalda — justo el defecto
 *     que motivó el modo degradado;
 *   - la IGUALDAD es el empate esperable: la revisión que esta pestaña no pudo
 *     persistir queda libre, y otra la usa legítimamente para su propia
 *     transición. Gana la que está escrita, porque es la única que verán las
 *     pestañas que arranquen después; converger a ella evita una división
 *     permanente del origen.
 *
 * No se usa el evento `storage` —que solo llega a las OTRAS pestañas y no a la
 * que escribió— porque esta comprobación cubre el mismo caso sin listeners: una
 * pestaña degradada que no está haciendo nada tampoco necesita enterarse todavía.
 */
function intentarRecuperarConfianza(): void {
  if (autoridadFiable) return;
  const cruda = leerAutoridad();
  if (cruda === null || cruda.revision < revisionLocal) return;
  autoridadFiable = true;
}

function borrarAutoridad(): void {
  try {
    localStorage.removeItem(CLAVE_AUTORIDAD);
  } catch {
    // Ver arriba.
  }
}

/** Qué hacer con un mensaje que llega por el canal. */
type Veredicto =
  | "ignorar"
  /** Del ciclo vigente: se aplica sin tocar el registro. */
  | "aceptar"
  /**
   * De un ciclo DISTINTO pero con revisión mayor: describe una transición
   * posterior a la registrada aquí. Se aplica y se adopta como autoridad.
   */
  | "adoptar";

/**
 * ¿Se acepta este mensaje?
 *
 * Con autoridad fiable manda ella, y la regla DEPENDE DEL TIPO:
 *
 *   - `iniciada` / `renovado` del ciclo vigente exigen que esté ACTIVO y que la
 *     revisión coincida. Contra una tumba se rechazan: eso es lo que impide que
 *     un mensaje atrasado reactive una sesión cerrada.
 *   - `cerrada` se acepta también contra la tumba de su propio ciclo. Tiene que
 *     ser así: la pestaña que cierra escribe la tumba ANTES de publicar, de modo
 *     que cuando el mensaje llega a las demás la autoridad ya dice "closed".
 *     Exigir "active" ahí dejaría a las otras pestañas mostrando una sesión que
 *     ya no existe. Cerrar dos veces es idempotente.
 *
 * MANDA LA REVISIÓN, Y DESPUÉS EL CICLO. La revisión es el reloj del origen: una
 * revisión MAYOR describe una transición posterior a la registrada aquí, venga
 * del ciclo que venga, y solo puede haberla emitido una pestaña que hizo esa
 * transición y **no pudo persistirla** (`setItem` falló allí). Rechazarla dejaría
 * a esta pestaña con un estado que el navegador ya no respalda.
 *
 * Eso incluye el MISMO ciclo: un cierre lleva la revisión siguiente a la del
 * registro activo, así que `{cerrada, A, 6}` contra `{A, active, 5}` es
 * exactamente el caso —la pestaña que cerró no pudo escribir la tumba, y esta
 * puede hacerlo por ella—. Comprobar el ciclo antes que la revisión dejaba ese
 * mensaje fuera y la sesión seguía viva aquí.
 *
 * Con revisiones IGUALES se mira el ciclo y el estado:
 *   - ciclo distinto → se rechaza. Es el empate de dos pestañas que emitieron la
 *     misma revisión; gana la que está registrada, y converger a ella evita que
 *     el origen se parta en dos.
 *   - `cerrada` del ciclo vigente → se acepta, idempotente. Tiene que ser así: la
 *     pestaña que cierra escribe la tumba ANTES de publicar, de modo que cuando
 *     el mensaje llega la autoridad ya dice "closed".
 *   - `iniciada` / `renovado` → solo contra autoridad ACTIVA. Contra una tumba se
 *     rechazan: eso impide que un mensaje atrasado reactive una sesión cerrada.
 *
 * UNA TUMBA NO SE REABRE POR SU PROPIO CICLO, ni siquiera con revisión mayor.
 * Un `iniciada` o `renovado` del ciclo enterrado no puede existir en ningún flujo
 * legítimo: tras un cierre, quien vuelve a entrar abre un ciclo NUEVO, nunca
 * reutiliza el cerrado. Un mensaje así solo puede ser basura o un residuo, y
 * aplicarlo devolvería al usuario a una sesión que el servidor ya revocó. La
 * excepción es `cerrada`, que sobre su propia tumba es idempotente.
 *
 * SIN autoridad —bloqueada, ilegible o esta pestaña degradada— se compara con el
 * ciclo local, y **también con la revisión**: en modo degradado `revisionLocal`
 * es la única referencia temporal que queda, y sin ella un mensaje atrasado del
 * mismo ciclo volvía a aplicarse como si fuera nuevo. Es el camino de reserva:
 * conserva el aislamiento entre ciclos distintos pero NO ordena a dos pestañas
 * entre sí, así que no es una garantía fuerte.
 */
function evaluarMensaje(msg: MensajeDeSesion): Veredicto {
  const autoridad = autoridadVigente();
  if (autoridad === null) {
    if (msg.ciclo !== ciclo) return "ignorar";
    // Sin registro, lo único que ordena es lo que esta pestaña ya emitió.
    return msg.revision < revisionLocal ? "ignorar" : "aceptar";
  }

  // 1) La revisión primero: mayor gana, sea del ciclo que sea…
  if (msg.revision > autoridad.revision) {
    // …salvo que pretenda revivir el ciclo que esta misma autoridad enterró.
    const reabreLaTumba = autoridad.ciclo === msg.ciclo && autoridad.estado === "closed" && msg.tipo !== "cerrada";
    return reabreLaTumba ? "ignorar" : "adoptar";
  }
  if (msg.revision < autoridad.revision) return "ignorar";

  // 2) Con la misma revisión, el ciclo tiene que coincidir.
  if (autoridad.ciclo !== msg.ciclo) return "ignorar";

  // 3) Y entonces mandan las reglas de estado.
  if (msg.tipo === "cerrada") return "aceptar";
  return autoridad.estado === "active" ? "aceptar" : "ignorar";
}

function nuevoCiclo(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // Reserva para entornos sin `crypto.randomUUID`: no necesita ser
  // criptográfico, solo irrepetible.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * El ciclo con el que arranca ESTA pestaña.
 *
 * Una pestaña nueva —o una recarga— **adopta el ciclo autoritativo si hay una
 * sesión activa**, en vez de inventarse uno. Empezar siempre con `nuevoCiclo()`
 * dejaba a la pestaña recién abierta fuera de la sesión en curso: sus mensajes
 * no pertenecían a ningún ciclo vigente y los de las demás tampoco al suyo,
 * hasta que casualmente llegara un `iniciada`. Contra una TUMBA no se adopta
 * nada: esa sesión está cerrada y lo que corresponde es un ciclo propio.
 */
function cicloInicial(): string {
  // Al cargar el módulo nada se ha intentado escribir todavía: la lectura cruda
  // y la fiable coinciden.
  const a = leerAutoridad();
  return a && a.estado === "active" ? a.ciclo : nuevoCiclo();
}

let ciclo = cicloInicial();

/** Revisión de la autoridad que esta pestaña cree vigente. */
let revisionLocal = leerAutoridad()?.revision ?? 0;

/**
 * La revisión que le toca a la SIGUIENTE transición.
 *
 * Es el máximo entre lo registrado y lo que esta pestaña ya emitió, más uno. El
 * segundo término importa en modo degradado: una pestaña que no pudo persistir
 * la revisión 6 ya la puso en sus mensajes, así que su transición siguiente
 * tiene que ser la 7. Calcularla solo desde el registro —atrasado en 5— la haría
 * reutilizar la 6, y un receptor que ya hubiera adoptado la 6 ignoraría la
 * transición nueva por no ser estrictamente mayor.
 */
function revisionSiguiente(): number {
  return Math.max(leerAutoridad()?.revision ?? 0, revisionLocal) + 1;
}

/**
 * Adopta el ciclo autoritativo vigente antes de operar.
 *
 * Se llama al entrar en la sección crítica: entre que la pestaña arrancó y que
 * llega el momento de renovar, otra pudo iniciar sesión. Sin esto, la operación
 * saldría etiquetada con un ciclo que ya no es el del origen y su resultado se
 * descartaría —o peor, se publicaría un mensaje que nadie acepta—.
 */
function sincronizarConAutoridad(): void {
  // Puede que el almacenamiento se haya recuperado y otra pestaña haya
  // registrado algo posterior mientras esta estaba degradada.
  intentarRecuperarConfianza();

  /**
   * `autoridadVigente`, no la lectura cruda: si esta pestaña no pudo persistir
   * su última transición, el valor guardado es ANTERIOR a ella y volver a él
   * significaría operar con el ciclo de una sesión que la cookie ya no respalda.
   */
  const a = autoridadVigente();
  // Sin autoridad (camino de reserva) o contra una tumba, se conserva el ciclo
  // local: adoptar un ciclo cerrado sería adoptar una sesión que no existe.
  if (!a || a.estado !== "active") return;

  revisionLocal = a.revision;
  if (a.ciclo === ciclo) return;

  ciclo = a.ciclo;
  // Lo anunciado pertenecía al ciclo anterior: deja de servir para ahorrarse
  // una rotación.
  ultimoAnuncio = null;
}

/** ¿La autoridad dice que el ciclo de esta pestaña ya está cerrado? */
function cicloLocalEnterrado(): boolean {
  const a = autoridadVigente();
  return a !== null && a.ciclo === ciclo && a.estado === "closed";
}

/**
 * Todo mensaje viaja con la REVISIÓN de la autoridad bajo la que se emitió.
 *
 * El ciclo dice "de qué sesión hablo"; la revisión, "de qué momento del origen".
 * Un mensaje cuya revisión no es la vigente pertenece a un estado anterior y se
 * ignora aunque el ciclo coincida. Un mensaje sin revisión —de una versión
 * anterior de la aplicación, todavía abierta en otra pestaña tras un
 * despliegue— no se puede situar en esa historia y también se ignora.
 */
type MensajeDeSesion =
  | { tipo: "renovado"; ciclo: string; revision: number; sesion: SesionRenovada; en: number }
  /**
   * Alguien INICIÓ SESIÓN en otra pestaña. Trae el ciclo nuevo y la sesión.
   *
   * Es el caso del cambio de cuenta: la cookie del navegador es una sola, así
   * que en cuanto la pestaña 2 entra como B, la pestaña 1 ya NO tiene la sesión
   * de A —aunque siga mostrándola—. Si no se enterase, seguiría pintando a A y
   * su botón de cerrar sesión revocaría la sesión de B creyendo cerrar la de A.
   */
  | { tipo: "iniciada"; ciclo: string; revision: number; sesion: SesionRenovada; en: number }
  | { tipo: "cerrada"; ciclo: string; revision: number; en: number };

/** Renovación en curso en ESTA pestaña, si la hay. */
let enCurso: Promise<ResultadoRenovacion> | null = null;

/** Última sesión anunciada, con su ciclo y marca de tiempo. */
let ultimoAnuncio: { sesion: SesionRenovada; ciclo: string; en: number } | null = null;

let canal: BroadcastChannel | null = null;



/**
 * Momento a partir del cual esta pestaña acepta anuncios.
 *
 * La generación cubre los cambios de ciclo de sesión; esto cubre lo demás: un
 * mensaje emitido antes de que esta pestaña empezara su vida no le sirve.
 */
let epoca = Date.now();

function avanzarEpoca(): void {
  epoca = Math.max(Date.now(), epoca);
}

const alRenovarOtraPestana: Array<(sesion: SesionRenovada) => void> = [];
const alCerrarOtraPestana: Array<() => void> = [];
const alIniciarOtraPestana: Array<(sesion: SesionRenovada) => void> = [];

/** Ventana dentro de la cual se considera vigente lo que anunció otra pestaña. */
const VENTANA_REUSO_MS = 10_000;

interface Dependencias {
  /**
   * Llama a POST /auth/refresh y devuelve la respuesta CRUDA.
   *
   * NO debe adoptar nada: ni tocar el estado de la aplicación, ni el token
   * CSRF, ni el almacenamiento. Antes sí lo hacía —adoptaba la respuesta y
   * luego el coordinador comprobaba si el ciclo seguía vigente—, de modo que
   * una renovación que terminaba después de un logout ya había escrito la
   * sesión en la pestaña que la inició. Descartar el resultado a posteriori no
   * deshacía nada. Ahora primero se valida el ciclo y solo después se adopta.
   *
   * Devuelve la respuesta, `null` si la SESIÓN YA NO VALE (401), y LANZA si el
   * fallo es transitorio (red, timeout, 5xx) o de comprobación CSRF (403).
   */
  pedirRenovacion(): Promise<unknown>;
  /**
   * Adopta la sesión ya validada y perteneciente al ciclo vigente. La llama el
   * coordinador, nunca `pedirRenovacion`.
   */
  adoptar(sesion: SesionRenovada): void;
  /** Token vigente en memoria, para la doble comprobación. */
  tokenActual(): string | null;
}

function hayCerrojos(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.locks?.request === "function";
}

function hayCanal(): boolean {
  return typeof BroadcastChannel === "function";
}

/**
 * VALIDACIÓN DE LO QUE LLEGA POR EL CANAL.
 *
 * `BroadcastChannel` entrega lo que cualquier código del mismo origen decida
 * publicar: otra versión de la aplicación tras un despliegue, una extensión, un
 * script inyectado. La forma de la sesión la comprueba `sessionSchema`, que es
 * el mismo esquema que se aplica a lo que llega del servidor.
 */
function validarMensaje(v: unknown): MensajeDeSesion | null {
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  if (typeof m.en !== "number" || !Number.isFinite(m.en)) return null;
  if (typeof m.ciclo !== "string" || m.ciclo.length === 0) return null;
  // La revisión es obligatoria: sin ella el mensaje no se puede situar en la
  // historia del origen (ver `MensajeDeSesion`).
  if (typeof m.revision !== "number" || !Number.isInteger(m.revision) || m.revision < 1) return null;

  if (m.tipo === "cerrada") return { tipo: "cerrada", ciclo: m.ciclo, revision: m.revision, en: m.en };

  if (m.tipo === "renovado" || m.tipo === "iniciada") {
    // El ciclo del sobre y el de la sesión tienen que coincidir: sin esto se
    // podría envolver una sesión de un ciclo dentro de un sobre de otro.
    const sesion = validarSesion(m.sesion, m.ciclo);
    return sesion ? { tipo: m.tipo, ciclo: m.ciclo, revision: m.revision, sesion, en: m.en } : null;
  }
  return null;
}

/** Abre el canal (una vez) y empieza a escuchar a las demás pestañas. */
function obtenerCanal(): BroadcastChannel | null {
  if (!hayCanal()) return null;
  if (canal) return canal;

  canal = new BroadcastChannel(NOMBRE_CANAL);
  canal.onmessage = (evento: MessageEvent<unknown>) => {
    const msg = validarMensaje(evento.data);
    if (!msg) return;

    // Antigüedad: emitido antes de que esta pestaña arrancara. No depende de la
    // autoridad, así que se resuelve aquí y evita pedir el cerrojo para nada.
    if (msg.en < epoca) return;

    /**
     * EL PROCESAMIENTO ENTERO VA DENTRO DEL CERROJO COMÚN.
     *
     * Antes se hacía aquí mismo: evaluar el mensaje, persistir la autoridad,
     * cambiar el ciclo y adoptar o cerrar la sesión, todo fuera de la sección
     * crítica. Entre esos pasos, cualquier otra pestaña podía avanzar la
     * autoridad —un login, un cierre— y el mensaje terminaba aplicándose contra
     * un estado que ya no existía cuando se decidió que era válido.
     *
     * Con el cerrojo, la recepción se pone en la MISMA fila que el refresco, el
     * login, el cierre y el cambio de contraseña, y el mensaje se **reevalúa**
     * al entrar: lo que valía cuando llegó puede no valer cuando le toca.
     *
     * `onmessage` no puede devolver una promesa a nadie, así que un rechazo
     * aquí sería un *unhandled rejection*. Pero absorberlo en silencio —lo que
     * hacía un `catch(() => undefined)`— esconde también los fallos de
     * `procesarMensaje`: un error de programación en la recepción de mensajes
     * entre pestañas es justo el que nadie va a reproducir a mano. Se registra,
     * y **no se reintenta**: el mensaje o se aplica o no.
     */
    void conCerrojoDeSesion(async () => {
      procesarMensaje(msg);
    }).catch((err: unknown) => {
      console.error("[sesión] fallo al procesar un mensaje entre pestañas", { tipo: msg.tipo, error: err });
    });
  };
  return canal;
}

/**
 * Aplica un mensaje del canal. **Se llama siempre con el cerrojo tomado.**
 *
 * Es síncrona a propósito: entre la evaluación y la escritura no debe haber
 * ningún punto de suspensión en el que otra operación de ESTA pestaña pueda
 * intercalarse.
 */
function procesarMensaje(msg: MensajeDeSesion): void {
  // Quizá el almacenamiento se recuperó y otra pestaña registró algo posterior.
  intentarRecuperarConfianza();

  /**
   * REEVALUACIÓN dentro del cerrojo. Los tres tipos pasan por la autoridad del
   * origen, con la regla que corresponde a cada uno (ver `evaluarMensaje`).
   *
   * Antes `iniciada` y `cerrada` se aceptaban siempre, y como el canal no ordena
   * mensajes de emisores distintos, un inicio de A entregado después del de B
   * devolvía la sesión a A, y un cierre de A posterior al login de B cerraba la
   * de B.
   */
  const veredicto = evaluarMensaje(msg);
  if (veredicto === "ignorar") return;

  /**
   * La emisora hizo una transición que no pudo persistir; esta pestaña sí puede,
   * así que la registra por ella. Sin esto, el origen se quedaría con un registro
   * anterior al estado real y cada pestaña nueva arrancaría en una sesión que ya
   * no existe.
   */
  if (veredicto === "adoptar") {
    const resultado = escribirAutoridad({
      ciclo: msg.ciclo,
      estado: msg.tipo === "cerrada" ? "closed" : "active",
      revision: msg.revision,
    });

    /**
     * `"rechazada"` significa que entre la evaluación y la escritura apareció
     * una autoridad SUPERIOR —otra pestaña, en otro hilo, escribiendo en el
     * mismo `localStorage`—. Ignorar ese resultado, como se hacía, aplicaba el
     * mensaje perdedor sobre un origen que ya había avanzado.
     *
     * Lo correcto es lo contrario: no adoptar nada de este mensaje, dar por
     * buena la autoridad que ganó —está escrita, luego es válida y posterior— y
     * ponerse al día con ella. Ningún callback llega a ver la sesión perdedora.
     */
    if (resultado === "rechazada") {
      autoridadFiable = true;
      sincronizarConAutoridad();
      return;
    }

    // `"sin-almacenamiento"`: esta pestaña queda degradada y aplica el mensaje
    // igualmente. Es el comportamiento documentado al final del archivo.
  }

  /**
   * EL RELOJ LOCAL AVANZA CON TODO MENSAJE QUE SE APLICA, sea del tipo que sea, y
   * ANTES de separar por tipo.
   *
   * La rama `cerrada` iba delante de la asignación, así que una receptora que
   * recibía `{cerrada, A, 6}` y **no podía persistirla** seguía con
   * `revisionLocal = 5`. El registro guardado —`{A, active, 5}`— empataba
   * entonces con su reloj y `intentarRecuperarConfianza` lo daba por bueno: la
   * pestaña volvía a la sesión que acababa de cerrar. Es el mismo defecto que se
   * corrigió en el emisor, visto desde el otro lado.
   *
   * Monotónico (`Math.max`), nunca una asignación directa: en modo degradado el
   * reloj local puede ir por DELANTE del mensaje, y retroceder abriría la puerta
   * a que un mensaje atrasado volviera a parecer nuevo.
   *
   * No se llega aquí si el veredicto fue `ignorar` ni si la escritura resultó
   * `rechazada` porque ganó otra autoridad: en ambos casos ya se ha vuelto antes.
   */
  revisionLocal = Math.max(revisionLocal, msg.revision);

  if (msg.tipo === "cerrada") {
    /**
     * La tumba, también aquí. El emisor ya la escribió —`localStorage` es
     * compartido—, pero esta pestaña puede ser la que NO tiene almacenamiento,
     * o el registro pudo borrarse entre medias. Escribirla es idempotente y
     * deja el estado explícito en vez de vacío.
     */
    enterrarCiclo(msg.ciclo, msg.revision);
    // El ciclo local pasa a uno propio: el anterior está enterrado.
    ciclo = nuevoCiclo();
    ultimoAnuncio = null;
    avisar(alCerrarOtraPestana, undefined);
    return;
  }

  /**
   * SINCRONIZACIÓN DEL CICLO LOCAL con todo mensaje aceptado, no solo con
   * `iniciada`. Una pestaña que arrancó con un ciclo propio y luego recibe un
   * `renovado` del ciclo autoritativo tiene que adoptarlo: si no, su siguiente
   * operación saldría etiquetada con un ciclo que el origen ya no reconoce.
   */
  ciclo = msg.ciclo;
  ultimoAnuncio = { sesion: msg.sesion, ciclo: msg.ciclo, en: msg.en };

  if (msg.tipo === "iniciada") {
    /**
     * Otra pestaña inició sesión y su ciclo YA es el autoritativo —lo fijó
     * dentro del cerrojo antes de publicar—. El navegador tiene una sola
     * cookie: seguir mostrando al usuario anterior sería mostrar algo falso.
     */
    avisar(alIniciarOtraPestana, msg.sesion);
    return;
  }

  avisar(alRenovarOtraPestana, msg.sesion);
}

/**
 * Llama a los suscriptores UNO A UNO, aislados.
 *
 * Son código de la aplicación —`AuthContext`, y cualquiera que se suscriba—: si
 * uno lanza, los demás tienen que enterarse igual. Sin este aislamiento, una
 * excepción en el primer suscriptor dejaba a los siguientes sin recibir un
 * cierre de sesión, que es exactamente el aviso que no se puede perder.
 */
function avisar<T>(suscriptores: Array<(dato: T) => void>, dato: T): void {
  // Copia: un suscriptor puede darse de baja durante la notificación.
  for (const f of [...suscriptores]) {
    try {
      f(dato);
    } catch (err) {
      console.error("[sesión] un suscriptor falló al aplicar un mensaje entre pestañas", err);
    }
  }
}

/**
 * Registra qué hacer cuando OTRA pestaña renueva o cierra la sesión.
 * Devuelve la función para darse de baja.
 */
export function escucharOtrasPestanas(handlers: {
  alRenovar: (sesion: SesionRenovada) => void;
  alCerrar: () => void;
  /** Otra pestaña inició sesión: hay que adoptar ESA, sea de quien sea. */
  alIniciar: (sesion: SesionRenovada) => void;
}): () => void {
  obtenerCanal();
  alRenovarOtraPestana.push(handlers.alRenovar);
  alCerrarOtraPestana.push(handlers.alCerrar);
  alIniciarOtraPestana.push(handlers.alIniciar);

  return () => {
    const i = alRenovarOtraPestana.indexOf(handlers.alRenovar);
    if (i >= 0) alRenovarOtraPestana.splice(i, 1);
    const j = alCerrarOtraPestana.indexOf(handlers.alCerrar);
    if (j >= 0) alCerrarOtraPestana.splice(j, 1);
    const k = alIniciarOtraPestana.indexOf(handlers.alIniciar);
    if (k >= 0) alIniciarOtraPestana.splice(k, 1);
  };
}

/**
 * Marca un ciclo como cerrado en la autoridad del origen: la TUMBA.
 *
 * No pisa la autoridad si el ciclo vigente ya es OTRO —otra pestaña entró
 * después—: enterrar un ciclo ajeno cerraría una sesión que no es la que se
 * está cerrando.
 */
function enterrarCiclo(cerrado: string, revision: number): ResultadoEscritura | "omitida" {
  const actual = leerAutoridad();
  /**
   * No se pisa el registro de OTRO ciclo… salvo que la tumba sea posterior. Ese
   * caso existe: una pestaña degradada cerró la sesión que sí tenía, y el
   * registro guardado es el anterior a su propio login. Su revisión es mayor, así
   * que la tumba corresponde y sin ella el origen se quedaría anunciando una
   * sesión activa que nadie puede usar.
   */
  if (actual && actual.ciclo !== cerrado && revision <= actual.revision) return "omitida";
  return escribirAutoridad({ ciclo: cerrado, estado: "closed", revision });
}

/**
 * Cierra el ciclo de sesión: deja la tumba y lo anuncia.
 * Todo lo que estuviera en vuelo del ciclo anterior queda invalidado.
 */
export function anunciarCierreDeSesion(): void {
  sincronizarConAutoridad();
  const cerrado = ciclo;

  /**
   * EL CIERRE ES UNA TRANSICIÓN NUEVA, con su propia revisión.
   *
   * Antes conservaba la del registro activo, y eso abría un agujero cuando la
   * escritura de la tumba fallaba: el registro se quedaba en
   * `{ciclo, active, N}` con la MISMA revisión que la pestaña creía tener, así
   * que `intentarRecuperarConfianza` —que acepta `>= revisionLocal`— lo daba por
   * bueno de inmediato y la pestaña volvía a una sesión que acababa de cerrar.
   *
   * Con `revisionSiguiente()` la tumba es N+1: si no se puede persistir, el
   * registro activo se queda en N, que es ANTERIOR a `revisionLocal`, y la
   * recuperación ya no lo acepta. Un login posterior avanzará otra vez.
   */
  revisionLocal = revisionSiguiente();

  /**
   * La TUMBA se escribe ANTES de publicar, y no se borra la clave.
   *
   * Borrarla dejaba el origen sin autoridad, y sin autoridad un `iniciada` o un
   * `renovado` atrasado del ciclo recién cerrado caía en el camino de reserva y
   * podía reactivar la sesión. Con la tumba, ese mensaje se rechaza de forma
   * explícita: el ciclo existe y está marcado como cerrado.
   */
  enterrarCiclo(cerrado, revisionLocal);
  const revisionDelCierre = revisionLocal;
  ciclo = nuevoCiclo();
  ultimoAnuncio = null;
  obtenerCanal()?.postMessage({
    tipo: "cerrada",
    ciclo: cerrado,
    // EXACTAMENTE la revisión con la que se enterró: las demás pestañas la
    // necesitan para poder adoptar la tumba aunque su registro siga en la anterior.
    revision: revisionDelCierre,
    en: Date.now(),
  } satisfies MensajeDeSesion);
}

/**
 * Empieza un ciclo de sesión NUEVO (login, o cambio de cuenta).
 *
 * Avanza la generación igual que el cierre: una renovación atrasada del usuario
 * anterior no puede sobrescribir la sesión recién iniciada.
 */
export function comenzarCicloDeSesion(): string {
  ciclo = nuevoCiclo();
  /**
   * El ciclo nuevo pasa a ser el autoritativo del origen, con la revisión
   * SIGUIENTE. Se llama siempre DENTRO del cerrojo (login y cambio de
   * contraseña), que es lo que ordena dos inicios concurrentes: el segundo en
   * entrar sube la revisión, y los mensajes del primero —que llevan la
   * anterior— dejan de aceptarse.
   */
  revisionLocal = revisionSiguiente();

  /**
   * Si la escritura falla, esta pestaña queda DEGRADADA (ver `autoridadFiable`)
   * y a partir de aquí manda su ciclo local, no el registro anterior. Ignorar el
   * resultado dejaba que la autoridad vieja —todavía legible— se reimpusiera en
   * la siguiente sincronización, devolviendo la pestaña a la sesión anterior
   * mientras la cookie del navegador ya era la nueva.
   */
  escribirAutoridad({ ciclo, estado: "active", revision: revisionLocal });
  ultimoAnuncio = null;
  avanzarEpoca();
  return ciclo;
}

/**
 * Anuncia que ESTA pestaña inició sesión, con el ciclo y la sesión nuevos.
 *
 * Las demás la adoptan. Es la política única del navegador para el cambio de
 * cuenta: una sola cookie, una sola sesión, todas las pestañas mostrando la
 * misma.
 */
export function anunciarInicioDeSesion(sesion: SesionRenovada): void {
  const en = Date.now();
  ultimoAnuncio = { sesion, ciclo, en };
  obtenerCanal()?.postMessage({
    tipo: "iniciada",
    ciclo,
    revision: revisionLocal,
    sesion,
    en,
  } satisfies MensajeDeSesion);
}

/** Ciclo vigente. Se necesita para etiquetar la sesión que se adopta. */
export function cicloActual(): string {
  return ciclo;
}

/**
 * Adopta un ciclo determinado.
 *
 * Es el punto de entrada por el que llegará el `sessionId` del backend cuando
 * exista: todas las pestañas de una misma sesión compartirán identidad y
 * volverán a reconocerse entre sí. Mientras tanto el ciclo se genera en el
 * cliente, cada pestaña tiene el suyo, y esta función la usan las pruebas para
 * reproducir el escenario de varias pestañas en la misma sesión.
 */
export function fijarCicloDeSesion(id: string): void {
  const actual = leerAutoridad();
  ciclo = id;
  ultimoAnuncio = null;

  /**
   * ADOPTAR no es EMPEZAR. Si ese ciclo ya es el autoritativo y sigue activo,
   * esta pestaña se limita a unirse a él conservando su revisión: subirla haría
   * que los mensajes de las pestañas que ya estaban dentro —emitidos con la
   * revisión anterior— dejaran de aceptarse.
   */
  if (actual && actual.ciclo === id && actual.estado === "active") {
    revisionLocal = actual.revision;
    return;
  }

  revisionLocal = revisionSiguiente();
  // Igual que en `comenzarCicloDeSesion`: si no se puede persistir, la pestaña
  // queda degradada y opera con el ciclo que acaba de adoptar.
  escribirAutoridad({ ciclo: id, estado: "active", revision: revisionLocal });
}

/** El estado autoritativo del origen. Se expone para las pruebas y la depuración. */
export function autoridadActual(): AutoridadDeSesion | null {
  return leerAutoridad();
}

/**
 * EXCLUSIÓN COMÚN PARA TODO LO QUE TOCA LA COOKIE DE SESIÓN.
 *
 * El cerrojo protegía solo el refresco, y eso dejaba una carrera real: un
 * refresco y un cierre de sesión salían a la vez con la misma cookie; el
 * refresco la consumía y creaba un reemplazo que el cierre —que ya había leído
 * la cookie vieja— no revocaba; y para rematar, la respuesta del refresco podía
 * escribir su `Set-Cookie` DESPUÉS del borrado del cierre. Resultado: el
 * usuario creía haber cerrado sesión y quedaba una sesión renovable.
 *
 * Poniendo refresco, cierre, entrada y cambio de contraseña bajo el MISMO
 * cerrojo, ninguna de ellas puede solaparse con otra, ni entre pestañas.
 *
 * Sin Web Locks no hay exclusión posible entre pestañas: la operación se
 * ejecuta igual, y la limitación está declarada al final del archivo.
 */
export async function conCerrojoDeSesion<T>(operacion: () => Promise<T>): Promise<T> {
  if (!hayCerrojos()) return operacion();
  return navigator.locks.request(NOMBRE_CERROJO, operacion) as Promise<T>;
}

/**
 * Renovación SIN pedir el cerrojo, para usar DESDE DENTRO de una operación que
 * ya lo tiene.
 *
 * Existe por un interbloqueo real. Web Locks no es reentrante: pedir el mismo
 * nombre desde dentro de la sección crítica espera para siempre a quien ya lo
 * tiene, que es uno mismo.
 *
 *   changePassword toma el cerrojo
 *     → POST /auth/change-password responde 401 (access token vencido)
 *       → el cliente HTTP llamaba a renovar()
 *         → renovar() pedía el mismo cerrojo y esperaba a changePassword,
 *           que esperaba a que terminara la petición. Bloqueo mutuo.
 *
 * La salida NO puede ser una bandera "ya lo tengo" de ámbito de módulo: en
 * JavaScript no hay hilo que distinga una llamada ANIDADA de una operación
 * CONCURRENTE de la misma pestaña, así que esa bandera dejaba pasar también a
 * las concurrentes y anulaba la exclusión.
 *
 * La salida es explícita: `/auth/change-password` queda fuera del bucle
 * automático de 401 del cliente HTTP, y quien está dentro del cerrojo llama a
 * ESTA función, que hace la renovación completa —petición, validación,
 * adopción, anuncio— sin volver a pedir el cerrojo que ya sostiene.
 */
export function renovarDentroDelCerrojo(deps: Dependencias): Promise<ResultadoRenovacion> {
  return ejecutarRenovacion(deps);
}

/** ¿Hay una sesión reciente anunciada, del ciclo vigente, que aprovechar? */
function anuncioVigente(): SesionRenovada | null {
  if (!ultimoAnuncio) return null;
  if (ultimoAnuncio.ciclo !== ciclo) return null;
  return Date.now() - ultimoAnuncio.en < VENTANA_REUSO_MS ? ultimoAnuncio.sesion : null;
}

/**
 * Renueva la sesión, serializando con las demás pestañas.
 *
 * @returns la sesión nueva, o `null` si ya no es válida.
 * @throws  si el fallo fue transitorio o de comprobación CSRF.
 */
export function renovarUnaSolaVez(deps: Dependencias): Promise<ResultadoRenovacion> {
  if (enCurso) return enCurso;

  const reciente = anuncioVigente();
  if (reciente) return Promise.resolve({ tipo: "renovada", sesion: reciente });

  /**
   * PRIMERO se comprueba el ciclo, DESPUÉS se adopta (ver `ejecutarRenovacion`).
   *
   * Si cambió mientras la petición estaba en vuelo —otra pestaña cerró sesión,
   * esta misma entró con otra cuenta, o se cambió la contraseña— el resultado
   * pertenece a un ciclo muerto y se descarta por completo. Antes se adoptaba
   * antes de mirar, así que la pestaña que INICIÓ el refresco se quedaba con la
   * sesión vieja aunque el coordinador devolviera `null`.
   */
  const renovarYAnunciar = (): Promise<ResultadoRenovacion> => ejecutarRenovacion(deps);

  enCurso = (async () => {
    try {
      return await conCerrojoDeSesion(async () => {
        // Ya dentro de la sección crítica: el estado del origen puede haber
        // cambiado mientras se esperaba el cerrojo.
        sincronizarConAutoridad();
        /**
         * Doble comprobación DENTRO del cerrojo. Aprovecha el anuncio si ya
         * llegó, pero NO se apoya en que haya llegado: la entrega es asíncrona
         * y esta comprobación puede perdérselo. Cuando eso pasa se renueva otra
         * vez, lo cual es correcto —la cookie ya está rotada en el navegador—
         * solo que innecesario. Ver la nota sobre qué se garantiza, arriba.
         */
        const anunciada = anuncioVigente();
        if (anunciada) return { tipo: "renovada", sesion: anunciada } as ResultadoRenovacion;

        void deps.tokenActual();
        return renovarYAnunciar();
      });
    } finally {
      enCurso = null;
    }
  })();

  return enCurso;
}

/**
 * El cuerpo de una renovación, sin coordinación: pide, valida el ciclo, adopta
 * y anuncia. Lo comparten `renovarUnaSolaVez` (que añade cerrojo y
 * single-flight) y `renovarDentroDelCerrojo` (que ya está en la sección
 * crítica).
 */
async function ejecutarRenovacion(deps: Dependencias): Promise<ResultadoRenovacion> {
  /**
   * Se opera con el ciclo AUTORITATIVO, no con el que esta pestaña tuviera
   * guardado: entre su arranque y este momento otra pudo iniciar sesión.
   */
  sincronizarConAutoridad();

  // Si la autoridad ya enterró este ciclo, no hay nada que renovar: otra pestaña
  // cerró la sesión y el mensaje aún no ha llegado. Ni se pide al servidor.
  if (cicloLocalEnterrado()) return { tipo: "descartada" };

  const cicloAlEmpezar = ciclo;

  const cruda = await deps.pedirRenovacion();
  if (cruda === null) return { tipo: "invalida" };
  if (ciclo !== cicloAlEmpezar) return { tipo: "descartada" };

  const sesion = validarSesion({ ...(cruda as object), ciclo }, ciclo);
  if (!sesion) return { tipo: "descartada" };

  deps.adoptar(sesion);

  const en = Date.now();
  ultimoAnuncio = { sesion, ciclo, en };
  obtenerCanal()?.postMessage({
    tipo: "renovado",
    ciclo,
    revision: revisionLocal,
    sesion,
    en,
  } satisfies MensajeDeSesion);
  return { tipo: "renovada", sesion };
}

/**
 * Olvida la última sesión anunciada, SIN cambiar el ciclo.
 *
 * El coordinador reutiliza durante diez segundos lo que anunció la última
 * renovación, para no rotar sin necesidad. Esto permite pedir una renovación
 * que llegue de verdad al servidor sin esperar esa ventana ni manipular el
 * reloj. Lo usan las pruebas.
 */
export function olvidarUltimoAnuncio(): void {
  ultimoAnuncio = null;
}

/** Solo para las pruebas: olvida el estado y descarta los anuncios anteriores. */
export function reiniciarCoordinador(): void {
  enCurso = null;
  ultimoAnuncio = null;
  alRenovarOtraPestana.length = 0;
  alCerrarOtraPestana.length = 0;
  alIniciarOtraPestana.length = 0;
  borrarAutoridad();
  autoridadFiable = true;
  revisionLocal = 0;
  ciclo = nuevoCiclo();
  avanzarEpoca();
}

/**
 * DEGRADACIÓN EN NAVEGADORES SIN ESTAS APIS
 * -----------------------------------------
 * La serialización descansa en Web Locks (Chrome 69+, Firefox 96+, Safari
 * 15.4+). El ahorro de rotaciones, en BroadcastChannel (Chrome 54+, Firefox
 * 38+, Safari 15.4+).
 *
 *   - SIN canal, CON cerrojo → se conserva la garantía: renovaciones en fila.
 *     Solo se pierden rotaciones ahorradas.
 *   - SIN cerrojo → se pierde la garantía. Dos pestañas que reciban 401 a la
 *     vez pueden renovar simultáneamente con la misma cookie; el backend leerá
 *     la segunda como reuso y cerrará la sesión. El usuario vuelve a entrar.
 *     Y la RECEPCIÓN de mensajes, que normalmente se pone en la fila del
 *     cerrojo, pasa a aplicarse en cuanto llega: se reevalúa igual y las reglas
 *     de autoridad y revisión siguen valiendo, pero **no hay orden fuerte** entre
 *     un mensaje que se está aplicando y una operación local simultánea. Es el
 *     mismo grado de garantía que había antes de encolar la recepción, y no debe
 *     presentarse como más.
 *
 * Se acepta porque la consecuencia máxima es volver a iniciar sesión, y porque
 * el backend hace lo correcto al revocar ante un reuso. Los tres caminos están
 * cubiertos en las pruebas, con el canal entregando de forma asíncrona.
 *
 * SIN `localStorage` —modo privado con almacenamiento bloqueado, políticas del
 * navegador, o un valor corrupto— **NO HAY GARANTÍA DE ORDEN ENTRE PESTAÑAS**, y
 * conviene no presentarlo como si la hubiera. Lo que queda es un camino de
 * reserva declarado:
 *
 *   - la pertenencia se decide contra el ciclo LOCAL, así que un mensaje de otra
 *     pestaña con ciclo distinto se ignora: no se adopta nada ajeno, pero
 *     tampoco se comparte sesión entre pestañas;
 *   - no hay tumba, de modo que la protección contra un `iniciada` atrasado
 *     depende solo de que el ciclo local ya no coincida;
 *   - no hay revisión que comparar, así que esa comprobación se omite.
 *
 * Es conservador, no seguro-por-construcción. La serialización de Web Locks —que
 * es independiente de esto— sigue en pie, y esa sí es la garantía fuerte.
 *
 * CASO INTERMEDIO: SE PUEDE LEER PERO NO ESCRIBIR. Es el más traicionero, porque
 * el registro sigue ahí, legible y creíble, mientras describe un estado ANTERIOR
 * al real. La pestaña que no pudo persistir su transición se marca a sí misma
 * como degradada (`autoridadFiable`) y deja de leerlo: opera con su ciclo local,
 * que es el que corresponde a la cookie vigente. Sus mensajes siguen llevando una
 * revisión mayor que la registrada, así que las demás pestañas —que sí pueden
 * escribir— los aceptan por revisión y registran la transición en su lugar. Lo
 * que no se puede recuperar de ninguna manera es una pestaña que arranque desde
 * cero mientras nadie ha podido actualizar el registro: leerá el estado antiguo.
 *
 * La autoridad definitiva será un `sessionId` emitido por el backend y guardado
 * en una columna nueva de `refresh_tokens`. Está diseñado pero SIN APLICAR: no
 * hay migración creada ni cambios en `schema.prisma`, así que el identificador
 * que se usa aquí se sigue generando en el cliente.
 */
