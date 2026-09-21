/**
 * Fase 6, hallazgo 27 — coordinación de la renovación entre pestañas.
 *
 * El refresh token es de UN SOLO USO: cada renovación revoca la anterior, y el
 * backend interpreta el uso de un token ya rotado como robo de sesión,
 * revocando TODAS las sesiones del usuario.
 *
 * DOS DECISIONES DE MÉTODO, ambas por defectos encontrados en revisión:
 *
 *  1. Cada pestaña carga su PROPIA instancia del módulo (`vi.resetModules`) y
 *     tiene su propio estado de sesión —token, CSRF y perfil—. Una versión
 *     anterior compartía la variable `token` entre las dos, lo que hacía pasar
 *     la prueba por una razón falsa: la segunda pestaña veía el valor nuevo
 *     porque leía la misma variable, no porque la coordinación funcionara.
 *
 *  2. El canal entrega de forma ASÍNCRONA, como el real. La entrega síncrona
 *     ocultaba el problema que causó pruebas intermitentes: un anuncio emitido
 *     por un caso llegaba ya empezado el siguiente. Aquí eso es una regresión
 *     explícita, no algo que se desactive.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Perfil COMPLETO, como exige `sessionSchema`: id, username, ownerType válido,
 * personId/clubId explícitos y roles. Un perfil a medias ya no se adopta.
 */
const perfilDe = (nombre: string) => ({
  id: nombre,
  username: nombre,
  ownerType: "club" as const,
  personId: null,
  clubId: "c1",
  roles: ["club"],
});

/** El tipo validado, no el literal del helper. */
type Perfil = import("./sessionSchema").PerfilDeSesion;

/**
 * Access token decodificable cuyo `sub` coincide con el id del perfil. La
 * validación rechaza un token que no se pueda leer o que sea de otro usuario.
 */
function tokenDe(idUsuario: string, marca: string): string {
  // Los claims describen exactamente al perfil: la validación los compara.
  const perfil = perfilDe(idUsuario);
  const payload = btoa(
    JSON.stringify({
      sub: perfil.id,
      ownerType: perfil.ownerType,
      personId: perfil.personId,
      clubId: perfil.clubId,
      roles: perfil.roles,
      permissions: [],
      marca,
    })
  );
  return `encabezado.${payload}.firma`;
}

/**
 * Fija el ciclo autoritativo del origen, como haría la pestaña que entra dentro
 * de su cerrojo. Sin esto, un mensaje publicado a mano no pertenece al ciclo
 * vigente y se ignora, que es justamente la protección nueva.
 */
/** La misma clave que usa el coordinador (`refreshCoordinator.ts`). */
const CLAVE_AUTORIDAD = "fchmn.ciclo";

function fijarAutoridadDePrueba(ciclo: string | null, estado: "active" | "closed" = "active", revision?: number): void {
  if (ciclo === null) {
    localStorage.removeItem(CLAVE_AUTORIDAD);
    return;
  }
  const actual = autoridadDePrueba();
  // Conserva la revisión si es el mismo ciclo; si es otro, avanza.
  const rev = revision ?? (actual && actual.ciclo === ciclo ? actual.revision : (actual?.revision ?? 0) + 1);
  localStorage.setItem(CLAVE_AUTORIDAD, JSON.stringify({ ciclo, estado, revision: rev }));
}

/** Lee el registro autoritativo tal como lo escribe el coordinador. */
function autoridadDePrueba(): { ciclo: string; estado: "active" | "closed"; revision: number } | null {
  const crudo = localStorage.getItem(CLAVE_AUTORIDAD);
  return crudo ? JSON.parse(crudo) : null;
}

/** La revisión vigente del origen, para etiquetar los mensajes de prueba. */
function revisionVigente(): number {
  return autoridadDePrueba()?.revision ?? 1;
}

/** Estado de UNA pestaña: memoria propia, como en el navegador. */
interface Pestana {
  modulo: typeof import("./refreshCoordinator");
  accessToken: string | null;
  csrfToken: string | null;
  user: Perfil | null;
  renovaciones: number;
}

const locksOriginal = globalThis.navigator?.locks;
const canalOriginal = globalThis.BroadcastChannel;

/** Web Locks: cerrojo exclusivo por nombre, con cola, compartido por el "origen". */
function instalarCerrojos() {
  const cola = new Map<string, Promise<unknown>>();
  const request = vi.fn(async (nombre: string, fn: () => Promise<unknown>) => {
    const anterior = cola.get(nombre) ?? Promise.resolve();
    const propio = anterior.then(fn, fn);
    cola.set(
      nombre,
      propio.catch(() => undefined)
    );
    return propio;
  });
  Object.defineProperty(globalThis.navigator, "locks", { value: { request }, configurable: true });
  return request;
}

function quitarCerrojos() {
  Object.defineProperty(globalThis.navigator, "locks", { value: undefined, configurable: true });
}

/**
 * BroadcastChannel de mentira con el comportamiento REAL:
 *   - quien publica NO se recibe a sí mismo;
 *   - la entrega es ASÍNCRONA (el navegador la encola).
 */
function instalarCanal() {
  const abiertos = new Set<FalsoCanal>();
  const pendientes: Array<() => void> = [];
  /**
   * Con `entregaDiferida` los mensajes se quedan encolados hasta que la prueba
   * los suelte. Sirve para el caso que más importa: un anuncio que llega mucho
   * después de emitirse, cuando la pestaña receptora ya empezó otra vida.
   */
  let entregaDiferida = false;

  const vaciar = () => {
    const cola = pendientes.splice(0);
    for (const entregar of cola) entregar();
  };

  class FalsoCanal {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    constructor(readonly name: string) {
      abiertos.add(this);
    }
    postMessage(data: unknown) {
      for (const otro of abiertos) {
        if (otro !== this && otro.name === this.name) {
          pendientes.push(() => otro.onmessage?.({ data }));
        }
      }
      // Asíncrono, como el real: nunca en el mismo tick.
      if (!entregaDiferida) queueMicrotask(vaciar);
    }
    close() {
      abiertos.delete(this);
    }
  }

  Object.defineProperty(globalThis, "BroadcastChannel", { value: FalsoCanal, configurable: true, writable: true });
  return {
    limpiar: () => abiertos.clear(),
    entregarPendientes: vaciar,
    /** A partir de aquí los mensajes se retienen hasta `entregarPendientes()`. */
    diferirEntrega: () => {
      entregaDiferida = true;
    },
    /** Publica un mensaje CRUDO, sin pasar por el coordinador (mensajes malformados). */
    publicarCrudo: (data: unknown) => {
      for (const c of abiertos) queueMicrotask(() => c.onmessage?.({ data }));
    },
    reanudarEntrega: () => {
      entregaDiferida = false;
    },
    hayPendientes: () => pendientes.length,
  };
}

function quitarCanal() {
  Object.defineProperty(globalThis, "BroadcastChannel", { value: undefined, configurable: true, writable: true });
}

/** Deja que se vacíe la cola de microtareas, donde vive la entrega del canal. */
const dejarLlegarMensajes = () => new Promise((r) => setTimeout(r, 0));

/**
 * Abre una pestaña: instancia FRESCA del módulo, con su propia memoria de
 * sesión. Es lo que distingue una pestaña de otra.
 */
async function abrirPestana(servidor: Servidor): Promise<Pestana> {
  vi.resetModules();
  const modulo = await import("./refreshCoordinator");
  const p: Pestana = { modulo, accessToken: "viejo", csrfToken: "csrf-viejo", user: null, renovaciones: 0 };
  // Cada pestaña arranca con su propio ciclo, como en el navegador.

  // Adopta la sesión COMPLETA que anuncien las demás, igual que AuthContext.
  const adoptar = (sesion: { accessToken: string; csrfToken: string; user: Perfil }) => {
    p.accessToken = sesion.accessToken;
    p.csrfToken = sesion.csrfToken;
    p.user = sesion.user;
  };

  modulo.escucharOtrasPestanas({
    alRenovar: adoptar,
    // Otra pestaña inició sesión: se adopta ESA, sea de quien sea.
    alIniciar: adoptar,
    alCerrar: () => {
      p.accessToken = null;
      p.csrfToken = null;
      p.user = null;
    },
  });

  Object.defineProperty(p, "renovar", {
    value: () =>
      modulo.renovarUnaSolaVez({
        tokenActual: () => p.accessToken,
        /**
         * `pedirRenovacion` SOLO pide: no adopta nada. Es el cambio que impide
         * que una renovación que termina después de un logout deje su resultado
         * escrito en la pestaña que la inició.
         */
        pedirRenovacion: async () => {
          p.renovaciones++;
          return servidor.emitir();
        },
        // El coordinador llama a esto únicamente si el ciclo sigue vigente.
        adoptar: (sesion) => {
          p.accessToken = sesion.accessToken;
          p.csrfToken = sesion.csrfToken;
          p.user = sesion.user as Perfil;
        },
      }),
  });
  return p;
}

const renovar = (p: Pestana) => (p as unknown as { renovar: () => Promise<unknown> }).renovar();

/**
 * Pone a varias pestañas en el MISMO ciclo.
 *
 * Es lo que hará el `sessionId` emitido por el backend cuando exista: todas las
 * pestañas de una misma sesión comparten identidad. Mientras tanto el ciclo se
 * genera en el cliente y cada pestaña tiene el suyo, así que aquí se iguala a
 * mano para poder ejercitar el comportamiento entre pestañas.
 */
function mismoCiclo(...pestanas: Pestana[]): string {
  const id = pestanas[0]!.modulo.comenzarCicloDeSesion();
  for (const p of pestanas.slice(1)) p.modulo.fijarCicloDeSesion(id);
  // `comenzarCicloDeSesion` ya fija la autoridad; se deja explícito para que la
  // intención de la prueba se lea sin tener que mirar la implementación.
  fijarAutoridadDePrueba(id);
  return id;
}

interface Servidor {
  llamadas: { total: number };
  /** Respuesta CRUDA de /auth/refresh, sin el ciclo (lo pone el coordinador). */
  emitir: () => Promise<unknown>;
}

/** Servidor que emite una sesión nueva en cada refresco. */
function servidorQueRota(): Servidor {
  let n = 0;
  const llamadas = { total: 0 };
  return {
    llamadas,
    emitir: async () => {
      llamadas.total++;
      n++;
      const user = perfilDe(`usuario-${n}`);
      return { accessToken: tokenDe(user.id, `t${n}`), csrfToken: `csrf-${n}`, user, mustChangePassword: false };
    },
  };
}

/**
 * Construye el sobre que viaja por el canal, ya con su ciclo y su REVISIÓN.
 *
 * La revisión se toma de la autoridad vigente: un mensaje etiquetado con otra
 * pertenece a un momento anterior del origen y el coordinador lo ignora, que es
 * justamente lo que comprueban las pruebas de mensajes atrasados.
 */
function sobreDe(ciclo: string, nombre: string, marca = "x", revision = revisionVigente()) {
  const user = perfilDe(nombre);
  return {
    tipo: "renovado",
    ciclo,
    revision,
    en: Date.now(),
    sesion: {
      accessToken: tokenDe(user.id, marca),
      csrfToken: "csrf-canal",
      user,
      mustChangePassword: false,
      ciclo,
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "locks", { value: locksOriginal, configurable: true });
  Object.defineProperty(globalThis, "BroadcastChannel", { value: canalOriginal, configurable: true, writable: true });
});

describe("dentro de una pestaña", () => {
  beforeEach(() => {
    quitarCerrojos();
    quitarCanal();
  });

  it("cinco peticiones que fallan a la vez producen UNA sola renovación", async () => {
    const servidor = servidorQueRota();
    const p = await abrirPestana(servidor);

    const resultados = await Promise.all([1, 2, 3, 4, 5].map(() => renovar(p)));

    expect(servidor.llamadas.total, "una segunda llamada usaría un token ya revocado").toBe(1);
    expect(new Set(resultados).size, "todas reciben la misma sesión").toBe(1);
  });

  it("todas reciben el mismo resultado cuando la sesión ya no vale", async () => {
    const p = await abrirPestana({ llamadas: { total: 0 }, emitir: async () => null });

    const resultados = await Promise.all([1, 2, 3].map(() => renovar(p)));

    // "invalida" = 401 confirmado. Se distingue de "descartada" (el ciclo
    // cambió), que NO debe hacer que el llamador borre la sesión.
    expect(resultados).toEqual([{ tipo: "invalida" }, { tipo: "invalida" }, { tipo: "invalida" }]);
    expect(p.renovaciones).toBe(1);
  });

  it("un fallo TRANSITORIO se propaga y no deja el coordinador bloqueado", async () => {
    let primera = true;
    const user = perfilDe("u");
    const servidor: Servidor = {
      llamadas: { total: 0 },
      emitir: async () => {
        if (primera) {
          primera = false;
          throw new Error("red caída");
        }
        return { accessToken: tokenDe(user.id, "ok"), csrfToken: "c", user, mustChangePassword: false };
      },
    };
    const p = await abrirPestana(servidor);

    await expect(renovar(p)).rejects.toThrow("red caída");

    // Sin el `finally` que limpia el estado, la segunda llamada devolvería para
    // siempre la promesa rechazada de la primera.
    await expect(renovar(p)).resolves.toMatchObject({ tipo: "renovada", sesion: { accessToken: tokenDe(user.id, "ok") } });
  });
});

describe("dos pestañas con perfil y CSRF independientes", () => {
  beforeEach(() => {
    instalarCerrojos();
    instalarCanal();
  });

  it("con el MISMO ciclo, la otra pestaña adopta la sesión completa", async () => {
    const servidor = servidorQueRota();
    const a = await abrirPestana(servidor);
    const b = await abrirPestana(servidor);
    expect(a.modulo, "memorias distintas").not.toBe(b.modulo);
    mismoCiclo(a, b);

    await renovar(a);
    await dejarLlegarMensajes();

    expect(servidor.llamadas.total).toBe(1);
    expect(b.accessToken, "b no pidió nada y está al día").toBe(a.accessToken);
  });

  /**
   * LIMITACIÓN ACTUAL, declarada como comportamiento.
   *
   * El ciclo se genera en el CLIENTE, así que dos pestañas que arrancan por
   * separado tienen identidades distintas y no se reconocen: la segunda ignora
   * el anuncio de la primera y renueva por su cuenta. Es conservador —nunca
   * adopta algo que no le corresponde— pero pierde el ahorro de rotaciones.
   *
   * Se resuelve con un `sessionId` emitido por el backend y estable durante las
   * rotaciones; requiere una columna nueva en `refresh_tokens` y está
   * presentado como propuesta, sin aplicar.
   */
  it("con ciclos DISTINTOS no se comparte la sesión (limitación conocida)", async () => {
    const servidor = servidorQueRota();
    const a = await abrirPestana(servidor);
    const b = await abrirPestana(servidor);

    await renovar(a);
    await dejarLlegarMensajes();

    expect(b.accessToken, "b ignora un anuncio de otro ciclo").toBe("viejo");
    // La garantía real —serialización— no se ve afectada; ver las pruebas de
    // la carrera cerrojo/canal.
  });

  /**
   * El canal transporta la SESIÓN ENTERA, y el token CSRF es parte de ella.
   *
   * El refresco no rota el CSRF —ver `"conservar"` en `auth.routes.ts`—, pero la
   * respuesta sí trae el vigente, y la receptora tiene que quedarse con ese y no
   * con el que tuviera de antes: si por el canal viajara solo el access token,
   * bastaría un cambio de token CSRF por cualquier otra vía para que la
   * siguiente operación de sesión de esa pestaña fallara con 403.
   */
  it("el CSRF viaja con la sesión a la otra pestaña", async () => {
    const servidor = servidorQueRota();
    const a = await abrirPestana(servidor);
    const b = await abrirPestana(servidor);
    mismoCiclo(a, b);
    expect(b.csrfToken, "punto de partida: el suyo, antiguo").toBe("csrf-viejo");

    await renovar(a);
    await dejarLlegarMensajes();

    expect(a.csrfToken).toBe("csrf-1");
    expect(b.csrfToken, "el sobre lleva la sesión entera, no solo el token").toBe("csrf-1");
  });

  /**
   * Una pestaña recién abierta no tiene perfil: lo trae la respuesta del
   * refresco. Si el canal no lo transmite, queda autenticada sin saber quién es.
   */
  it("el PERFIL también llega a la pestaña que no renovó", async () => {
    const servidor = servidorQueRota();
    const a = await abrirPestana(servidor);
    const b = await abrirPestana(servidor);
    mismoCiclo(a, b);
    expect(b.user, "pestaña nueva: sin perfil").toBeNull();

    await renovar(a);
    await dejarLlegarMensajes();

    expect(b.renovaciones, "no pidió nada").toBe(0);
    expect(b.user, "y aun así sabe quién es el usuario").toEqual(perfilDe("usuario-1"));
  });

  it("una renovación posterior, ya fuera de la ventana, sí ocurre", async () => {
    const servidor = servidorQueRota();
    const a = await abrirPestana(servidor);
    await renovar(a);
    await dejarLlegarMensajes();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 11_000);
      await renovar(a);
    } finally {
      vi.useRealTimers();
    }

    expect(servidor.llamadas.total).toBe(2);
  });

  it("el CIERRE de sesión se propaga a las demás pestañas", async () => {
    const servidor = servidorQueRota();
    const a = await abrirPestana(servidor);
    const b = await abrirPestana(servidor);
    mismoCiclo(a, b);
    await renovar(a);
    await dejarLlegarMensajes();
    expect(b.accessToken).not.toBeNull();

    a.modulo.anunciarCierreDeSesion();
    await dejarLlegarMensajes();

    expect(b.accessToken, "la otra pestaña debe quedar sin sesión").toBeNull();
    expect(b.csrfToken).toBeNull();
  });

  it("usa el cerrojo con un nombre estable y de ámbito origen", async () => {
    const request = instalarCerrojos();
    const a = await abrirPestana(servidorQueRota());

    await renovar(a);

    expect(request).toHaveBeenCalledWith("fchmn-refresh-sesion", expect.any(Function));
  });
});

/**
 * REGRESIÓN de la intermitencia.
 *
 * `BroadcastChannel` entrega de forma asíncrona, así que un anuncio emitido
 * antes puede llegar después. Antes eso contaminaba el estado —la pestaña
 * adoptaba una sesión que ya no correspondía— y se manifestaba como pruebas
 * que fallaban dos de cada tres veces. La solución NO es desactivar el canal:
 * es descartar los anuncios anteriores al arranque de la pestaña.
 */
describe("entrega asíncrona: un anuncio que llega tarde no contamina", () => {
  let canalFalso: ReturnType<typeof instalarCanal>;

  beforeEach(() => {
    instalarCerrojos();
    canalFalso = instalarCanal();
  });

  it("un anuncio emitido ANTES del reinicio se descarta al llegar", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const servidor = servidorQueRota();
    const emisora = await abrirPestana(servidor);
    const receptora = await abrirPestana(servidor);

    // El anuncio queda en vuelo, sin entregarse todavía.
    canalFalso.diferirEntrega();
    await renovar(emisora);
    expect(canalFalso.hayPendientes(), "hay un anuncio en vuelo").toBeGreaterThan(0);

    /**
     * Mientras el mensaje viaja, la receptora empieza otra vida: una pestaña
     * que se recarga, o —en la suite— el caso de prueba siguiente. Todo lo
     * anterior a este momento deja de aplicarle.
     *
     * Se adelanta el reloj para que el anuncio sea CLARAMENTE anterior. Es lo
     * que ocurre de verdad: un mensaje que se cruza con una recarga llega
     * decenas o cientos de milisegundos después de emitirse, no en el mismo.
     */
    vi.setSystemTime(Date.now() + 1_000);
    receptora.modulo.reiniciarCoordinador();
    const adoptarEnReceptora = (s2: { accessToken: string; csrfToken: string }) => {
      receptora.accessToken = s2.accessToken;
      receptora.csrfToken = s2.csrfToken;
    };
    receptora.modulo.escucharOtrasPestanas({
      alRenovar: adoptarEnReceptora,
      alIniciar: adoptarEnReceptora,
      alCerrar: () => {
        receptora.accessToken = null;
      },
    });

    // Ahora sí llega el mensaje viejo.
    canalFalso.reanudarEntrega();
    canalFalso.entregarPendientes();
    await dejarLlegarMensajes();

    expect(receptora.accessToken, "un anuncio previo a su arranque no le sirve").toBe("viejo");
    expect(receptora.csrfToken).toBe("csrf-viejo");
    vi.useRealTimers();
  });

  it("un anuncio POSTERIOR al arranque sí se adopta", async () => {
    const servidor = servidorQueRota();
    const a = await abrirPestana(servidor);
    const b = await abrirPestana(servidor);
    mismoCiclo(a, b);

    await renovar(a);
    canalFalso.entregarPendientes();
    await dejarLlegarMensajes();

    // El contraste con el caso anterior: la regla descarta por antigüedad, no
    // por desconfianza general del canal.
    expect(b.accessToken, "un anuncio del ciclo vigente sí se adopta").toBe(a.accessToken);
  });
});

/**
 * LA CARRERA CERROJO/CANAL, demostrada.
 *
 * Publicar en `BroadcastChannel` NO significa que el siguiente poseedor del
 * cerrojo se haya enterado: la entrega es asíncrona. Estas pruebas fuerzan
 * exactamente esa ventana y afirman la garantía REAL —serialización— en vez de
 * una unicidad que no se cumple.
 */
describe("carrera entre el cerrojo y la entrega del canal", () => {
  let canalFalso: ReturnType<typeof instalarCanal>;

  beforeEach(() => {
    instalarCerrojos();
    canalFalso = instalarCanal();
  });

  it("con la entrega DEMORADA, la segunda pestaña renueva igualmente", async () => {
    const servidor = servidorQueRota();
    const a = await abrirPestana(servidor);
    const b = await abrirPestana(servidor);

    // El aviso de la primera no llega hasta que la segunda ya pasó por el
    // cerrojo: es la ventana real entre liberar el lock y recibir el mensaje.
    canalFalso.diferirEntrega();

    await renovar(a);
    await renovar(b);

    /**
     * DOS renovaciones. Es el comportamiento real y por eso NO se promete "una
     * sola renovación en total": el canal ahorra rotaciones cuando el mensaje
     * llega a tiempo, no siempre.
     */
    expect(servidor.llamadas.total, "la segunda no se enteró a tiempo").toBe(2);

    // Lo que SÍ se garantiza y es lo que importa: nunca hubo dos renovaciones
    // en vuelo a la vez, así que ninguna usó un refresh token ya rotado.
    canalFalso.reanudarEntrega();
    canalFalso.entregarPendientes();
    await dejarLlegarMensajes();
  });

  it("las renovaciones NUNCA se solapan: el cerrojo las pone en fila", async () => {
    let enVuelo = 0;
    let maximoSimultaneo = 0;
    const llamadas = { total: 0 };
    const servidor: Servidor = {
      llamadas,
      emitir: async () => {
        llamadas.total++;
        enVuelo++;
        maximoSimultaneo = Math.max(maximoSimultaneo, enVuelo);
        // Cede el control: si hubiera solapamiento, aquí se vería.
        await new Promise((r) => setTimeout(r, 5));
        enVuelo--;
        return { accessToken: `t-${llamadas.total}`, csrfToken: "csrf", user: perfilDe("u"), mustChangePassword: false };
      },
    };

    canalFalso.diferirEntrega();
    const a = await abrirPestana(servidor);
    const b = await abrirPestana(servidor);
    const c = await abrirPestana(servidor);

    await Promise.all([renovar(a), renovar(b), renovar(c)]);

    /**
     * Ésta es LA garantía. Con dos peticiones simultáneas, ambas enviarían la
     * misma cookie de refresco y el backend leería la segunda como robo de
     * sesión, cerrándola entera.
     */
    expect(maximoSimultaneo, "dos renovaciones a la vez usarían el mismo refresh token").toBe(1);
  });

  it("cuando el mensaje SÍ llega a tiempo, se ahorra la rotación", async () => {
    const servidor = servidorQueRota();
    const a = await abrirPestana(servidor);
    const b = await abrirPestana(servidor);
    mismoCiclo(a, b);

    await renovar(a);
    // Entrega normal (asíncrona pero inmediata): b se entera antes de pedir.
    await dejarLlegarMensajes();
    await renovar(b);

    expect(servidor.llamadas.total, "el canal es una optimización, y aquí funciona").toBe(1);
  });
});

/**
 * GENERACIÓN DE SESIÓN.
 *
 * Un mensaje atrasado no puede revivir una sesión cerrada ni pisar la de otro
 * usuario. La generación avanza en login y logout, y todo lo anterior se
 * descarta.
 */
describe("mensajes atrasados y ciclos de sesión", () => {
  let canalFalso: ReturnType<typeof instalarCanal>;

  beforeEach(() => {
    instalarCerrojos();
    canalFalso = instalarCanal();
  });

  it("renovación publicada → logout → la renovación atrasada NO revive la sesión", async () => {
    const receptora = await abrirPestana(servidorQueRota());
    const cicloVivo = receptora.modulo.cicloActual();
    fijarAutoridadDePrueba(cicloVivo);

    // 1) Llega una renovación de MI ciclo: la sesión queda activa.
    const primera = sobreDe(cicloVivo, "u1", "viva");
    canalFalso.publicarCrudo(primera);
    await dejarLlegarMensajes();
    expect(receptora.accessToken).toBe(primera.sesion.accessToken);

    // 2) Otra pestaña cierra sesión. El cierre se acepta siempre y abre ciclo.
    canalFalso.publicarCrudo({ tipo: "cerrada", ciclo: cicloVivo, revision: revisionVigente(), en: Date.now() });
    await dejarLlegarMensajes();
    expect(receptora.accessToken).toBeNull();

    // 3) Llega, TARDE, otra renovación del ciclo YA CERRADO. Su ciclo ya no es
    //    el autoritativo, así que ni siquiera se mira su contenido.
    canalFalso.publicarCrudo(sobreDe(cicloVivo, "u1", "atrasada"));
    await dejarLlegarMensajes();

    expect(receptora.accessToken, "sigue deslogueado: el mensaje es de un ciclo ya cerrado").toBeNull();
  });

  it("el logout de otra pestaña vence a una renovación anterior", async () => {
    const servidor = servidorQueRota();
    const a = await abrirPestana(servidor);
    const b = await abrirPestana(servidor);
    mismoCiclo(a, b);

    await renovar(a);
    await dejarLlegarMensajes();
    expect(b.accessToken).not.toBe("viejo");

    a.modulo.anunciarCierreDeSesion();
    await dejarLlegarMensajes();

    expect(b.accessToken).toBeNull();
    expect(b.csrfToken).toBeNull();
  });

  it("una renovación del usuario A no puede sustituir el login del usuario B", async () => {
    const servidor = servidorQueRota();
    const a = await abrirPestana(servidor);
    const b = await abrirPestana(servidor);

    mismoCiclo(a, b);

    // A renueva; su anuncio queda en vuelo.
    canalFalso.diferirEntrega();
    await renovar(a);

    // Mientras tanto, en B entra OTRO usuario: ciclo nuevo.
    b.modulo.comenzarCicloDeSesion();
    b.accessToken = "token-de-B";
    b.user = perfilDe("usuario-B");

    canalFalso.reanudarEntrega();
    canalFalso.entregarPendientes();
    await dejarLlegarMensajes();

    expect(b.accessToken, "el perfil del usuario nuevo no se pisa").toBe("token-de-B");
    expect(b.user).toEqual(perfilDe("usuario-B"));
  });

  /**
   * ORDEN GLOBAL ENTRE EMISORES DISTINTOS.
   *
   * `BroadcastChannel` no ordena los mensajes de emisores distintos: la
   * receptora puede recibir el inicio de B y después el de A, aunque A entrara
   * primero. Quien decide no es el orden de entrega sino la AUTORIDAD del
   * origen, escrita dentro del cerrojo.
   *
   * Tres módulos independientes: dos que inician sesión y uno que recibe.
   */
  it("A inicia, B inicia después; llegan B y luego A → permanece B", async () => {
    const servidor = servidorQueRota();
    const pestanaA = await abrirPestana(servidor);
    const pestanaB = await abrirPestana(servidor);
    const receptora = await abrirPestana(servidor);

    // A entra primero: fija la autoridad y publica.
    const cicloA = pestanaA.modulo.comenzarCicloDeSesion();
    const sobreA = sobreDe(cicloA, "usuario-A", "inicioA");

    // B entra DESPUÉS: sobrescribe la autoridad dentro de su cerrojo.
    const cicloB = pestanaB.modulo.comenzarCicloDeSesion();
    const sobreB = sobreDe(cicloB, "usuario-B", "inicioB");

    // La entrega llega AL REVÉS: primero B, después A.
    canalFalso.publicarCrudo({ ...sobreB, tipo: "iniciada" });
    await dejarLlegarMensajes();
    canalFalso.publicarCrudo({ ...sobreA, tipo: "iniciada" });
    await dejarLlegarMensajes();

    expect(receptora.accessToken, "el inicio más reciente es el de B, aunque llegara antes").toBe(sobreB.sesion.accessToken);
    expect((receptora.user as { username: string }).username).toBe("usuario-B");
  });

  it("logout de A y login de B después; llegan login B y luego cierre A → permanece B", async () => {
    const servidor = servidorQueRota();
    const pestanaA = await abrirPestana(servidor);
    const pestanaB = await abrirPestana(servidor);
    const receptora = await abrirPestana(servidor);

    // A tenía sesión y la cierra.
    const cicloA = pestanaA.modulo.comenzarCicloDeSesion();
    const cierreA = { tipo: "cerrada", ciclo: cicloA, revision: revisionVigente(), en: Date.now() };
    pestanaA.modulo.anunciarCierreDeSesion();

    // B entra DESPUÉS: su ciclo pasa a ser el autoritativo.
    const cicloB = pestanaB.modulo.comenzarCicloDeSesion();
    const sobreB = sobreDe(cicloB, "usuario-B", "inicioB");

    // Entrega fuera de orden: primero el login de B, después el cierre de A.
    canalFalso.publicarCrudo({ ...sobreB, tipo: "iniciada" });
    await dejarLlegarMensajes();
    canalFalso.publicarCrudo(cierreA);
    await dejarLlegarMensajes();

    /**
     * El cierre de A pertenece a un ciclo que ya no es el autoritativo, así que
     * no puede cerrar la sesión de B. Antes `cerrada` se aceptaba siempre y este
     * mensaje tardío cerraba una sesión que no era la suya.
     */
    expect(receptora.accessToken, "el cierre de A no puede cerrar la sesión de B").toBe(sobreB.sesion.accessToken);
  });

  it("el cierre del ciclo VIGENTE sí cierra", async () => {
    const servidor = servidorQueRota();
    const pestanaA = await abrirPestana(servidor);
    const receptora = await abrirPestana(servidor);

    const cicloA = pestanaA.modulo.comenzarCicloDeSesion();
    canalFalso.publicarCrudo({ ...sobreDe(cicloA, "usuario-A", "inicio"), tipo: "iniciada" });
    await dejarLlegarMensajes();
    expect(receptora.accessToken).not.toBe("viejo");

    // Contraste con el caso anterior: aquí el cierre SÍ es del ciclo vigente.
    canalFalso.publicarCrudo({ tipo: "cerrada", ciclo: cicloA, revision: revisionVigente(), en: Date.now() });
    await dejarLlegarMensajes();

    expect(receptora.accessToken).toBeNull();
  });

  it("una renovación que termina DESPUÉS de un cierre no se publica", async () => {
    let resolver!: (v: unknown) => void;
    const llamadas = { total: 0 };
    const servidor: Servidor = {
      llamadas,
      emitir: () => {
        llamadas.total++;
        return new Promise((r) => {
          resolver = r as (v: unknown) => void;
        }) as Promise<null>;
      },
    };
    const a = await abrirPestana(servidor);
    const b = await abrirPestana(servidor);
    mismoCiclo(a, b);

    const pendiente = renovar(a);
    // Se espera a que la petición esté realmente en vuelo antes de cerrar.
    await vi.waitFor(() => expect(typeof resolver).toBe("function"));

    // El cierre ocurre mientras la renovación sigue en vuelo.
    a.modulo.anunciarCierreDeSesion();
    resolver({ accessToken: tokenDe(perfilDe("u").id, "tarde"), csrfToken: "c", user: perfilDe("u"), mustChangePassword: false });
    await pendiente;
    await dejarLlegarMensajes();

    // Ni se adopta localmente ni se anuncia: pertenece al ciclo ya cerrado.
    expect(b.accessToken, "una sesión cerrada no se revive").toBeNull();
  });
});

/**
 * VALIDACIÓN DE LO QUE LLEGA POR EL CANAL. Cualquier código del mismo origen
 * puede publicar: otra versión tras un despliegue, una extensión, un script
 * inyectado. Un mensaje que no encaje se ignora sin tocar nada.
 */
describe("mensajes malformados se ignoran", () => {
  let canalFalso: ReturnType<typeof instalarCanal>;

  beforeEach(() => {
    instalarCerrojos();
    canalFalso = instalarCanal();
  });

  /** Sobre válido del ciclo de la receptora, para mutarlo campo a campo. */
  function sobreValido(ciclo: string) {
    fijarAutoridadDePrueba(ciclo);
    return sobreDe(ciclo, "usuario-valido", "ok");
  }

  it("un mensaje BIEN formado sí se adopta (la validación no bloquea lo legítimo)", async () => {
    const receptora = await abrirPestana(servidorQueRota());
    const sobre = sobreValido(receptora.modulo.cicloActual());

    canalFalso.publicarCrudo(sobre);
    await dejarLlegarMensajes();

    expect(receptora.accessToken).toBe(sobre.sesion.accessToken);
  });

  /**
   * Cada caso rompe UN campo del sobre válido. La validación anterior solo
   * miraba `id`, `username` y `roles`, y aceptaba cualquier cadena como access
   * token: `ownerType`, `personId` y `clubId` —de los que dependen el enrutado y
   * el aislamiento entre clubes— pasaban sin comprobar.
   */
  it.each([
    ["nulo", () => null],
    ["texto suelto", () => "hola"],
    ["sin tipo", (s: any) => ({ ...s, tipo: undefined })],
    ["tipo desconocido", (s: any) => ({ ...s, tipo: "otra-cosa" })],
    ["sin ciclo", (s: any) => ({ ...s, ciclo: undefined })],
    ["sin marca de tiempo", (s: any) => ({ ...s, en: "ayer" })],
    ["sin sesión", (s: any) => ({ ...s, sesion: undefined })],
    ["sesión sin accessToken", (s: any) => ({ ...s, sesion: { ...s.sesion, accessToken: undefined } })],
    ["access token no decodificable", (s: any) => ({ ...s, sesion: { ...s.sesion, accessToken: "no-es-un-jwt" } })],
    ["sin csrfToken", (s: any) => ({ ...s, sesion: { ...s.sesion, csrfToken: null } })],
    ["mustChangePassword no booleano", (s: any) => ({ ...s, sesion: { ...s.sesion, mustChangePassword: "si" } })],
    ["ciclo del sobre distinto al de la sesión", (s: any) => ({ ...s, sesion: { ...s.sesion, ciclo: "otro" } })],
    ["perfil ausente", (s: any) => ({ ...s, sesion: { ...s.sesion, user: null } })],
    ["perfil sin id", (s: any) => ({ ...s, sesion: { ...s.sesion, user: { ...s.sesion.user, id: undefined } } })],
    ["perfil sin username", (s: any) => ({ ...s, sesion: { ...s.sesion, user: { ...s.sesion.user, username: "" } } })],
    ["ownerType fuera del enum", (s: any) => ({ ...s, sesion: { ...s.sesion, user: { ...s.sesion.user, ownerType: "otro" } } })],
    ["ownerType ausente", (s: any) => ({ ...s, sesion: { ...s.sesion, user: { ...s.sesion.user, ownerType: undefined } } })],
    ["personId indefinido", (s: any) => ({ ...s, sesion: { ...s.sesion, user: { ...s.sesion.user, personId: undefined } } })],
    ["clubId numérico", (s: any) => ({ ...s, sesion: { ...s.sesion, user: { ...s.sesion.user, clubId: 42 } } })],
    ["roles que no son cadenas", (s: any) => ({ ...s, sesion: { ...s.sesion, user: { ...s.sesion.user, roles: [1, 2] } } })],
    ["roles ausentes", (s: any) => ({ ...s, sesion: { ...s.sesion, user: { ...s.sesion.user, roles: undefined } } })],
    [
      "token de OTRO usuario que el perfil",
      (s: any) => ({ ...s, sesion: { ...s.sesion, accessToken: tokenDe("otro-usuario", "x") } }),
    ],
  ])("ignora un mensaje: %s", async (_caso, romper) => {
    const receptora = await abrirPestana(servidorQueRota());
    const antes = { token: receptora.accessToken, csrf: receptora.csrfToken, user: receptora.user };

    canalFalso.publicarCrudo(romper(sobreValido(receptora.modulo.cicloActual()) as any));
    await dejarLlegarMensajes();

    expect(receptora.accessToken, "un mensaje inválido no puede alterar la sesión").toBe(antes.token);
    expect(receptora.csrfToken).toBe(antes.csrf);
    expect(receptora.user).toBe(antes.user);
  });
});

/**
 * SIN Web Locks NI BroadcastChannel.
 *
 * Ninguna de las dos APIs es universal, así que el coordinador tiene que seguir
 * funcionando sin ellas. Lo que se pierde está acotado y estas pruebas lo fijan:
 * sin canal se rota de más, sin cerrojo no hay exclusión ENTRE pestañas, pero
 * dentro de una misma pestaña la coordinación se mantiene siempre.
 */
describe("degradación en navegadores sin estas APIs", () => {
  it("con cerrojo pero SIN canal: SERIALIZACIÓN segura, no unicidad", async () => {
    instalarCerrojos();
    quitarCanal();
    const servidor = servidorQueRota();
    const a = await abrirPestana(servidor);
    const b = await abrirPestana(servidor);

    await Promise.all([renovar(a), renovar(b)]);

    // Dos rotaciones, una tras otra, nunca simultáneas. Cada una emite una
    // sesión válida: no hay reuso ni pérdida de sesión, solo rotación de más.
    expect(servidor.llamadas.total).toBe(2);
  });

  it("sin cerrojo NI canal: dos pestañas pueden renovar a la vez", async () => {
    quitarCerrojos();
    quitarCanal();
    const servidor = servidorQueRota();
    const a = await abrirPestana(servidor);
    const b = await abrirPestana(servidor);

    await Promise.all([renovar(a), renovar(b)]);

    // El backend leerá la segunda como reuso y cerrará la sesión. El usuario
    // vuelve a entrar. Se afirma el comportamiento real, no uno deseado.
    expect(servidor.llamadas.total).toBe(2);
  });

  it("sin canal, la coordinación DENTRO de la pestaña sigue funcionando", async () => {
    quitarCerrojos();
    quitarCanal();
    const servidor = servidorQueRota();
    const a = await abrirPestana(servidor);

    await Promise.all([renovar(a), renovar(a)]);

    expect(servidor.llamadas.total).toBe(1);
  });
});
