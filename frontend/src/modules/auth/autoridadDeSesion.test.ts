/**
 * Fase 6 — LA AUTORIDAD DE SESIÓN DEL ORIGEN.
 *
 * El ciclo de sesión no puede ser una variable local de cada pestaña. Con eso,
 * una pestaña recién abierta durante una sesión en curso arrancaba con un ciclo
 * inventado: sus mensajes no pertenecían a ningún ciclo vigente y los de las
 * demás tampoco al suyo, así que quedaba fuera de la sesión hasta que por
 * casualidad llegara un `iniciada`.
 *
 * El estado vigente vive ahora en `localStorage` como un REGISTRO con tumba:
 *
 *     { ciclo, estado: "active" | "closed", revision }
 *
 * y estas pruebas lo ejercitan por su efecto observable, no por su contenido:
 * **qué ciclo usa una operación LOCAL posterior** —una renovación, un cierre—,
 * que es lo que un mensaje publicado a mano no demuestra.
 *
 * Cada "pestaña" es una instancia FRESCA del módulo (`vi.resetModules`), con su
 * propia memoria, como en el navegador. Lo único que comparten es el
 * `localStorage` del origen y el canal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const CLAVE = "fchmn.ciclo";

type Perfil = import("./sessionSchema").PerfilDeSesion;

const perfilDe = (nombre: string): Perfil => ({
  id: nombre,
  username: nombre,
  ownerType: "club",
  personId: null,
  clubId: "c1",
  roles: ["club"],
});

function tokenDe(id: string, marca: string): string {
  const p = perfilDe(id);
  const payload = btoa(
    JSON.stringify({
      sub: p.id,
      ownerType: p.ownerType,
      personId: p.personId,
      clubId: p.clubId,
      roles: p.roles,
      permissions: [],
      marca,
    })
  );
  return `encabezado.${payload}.firma`;
}

/** El registro tal como lo escribe el coordinador. */
interface Autoridad {
  ciclo: string;
  estado: "active" | "closed";
  revision: number;
}

const leerAutoridad = (): Autoridad | null => {
  const crudo = localStorage.getItem(CLAVE);
  return crudo ? (JSON.parse(crudo) as Autoridad) : null;
};

/** Escribe el registro directamente, como si otra pestaña ya hubiera entrado. */
const sembrarAutoridad = (a: Autoridad) => localStorage.setItem(CLAVE, JSON.stringify(a));

// ---------------------------------------------------------------------------
// Infraestructura: cerrojos, canal espía y pestañas.
// ---------------------------------------------------------------------------

const locksOriginal = globalThis.navigator?.locks;
const canalOriginal = globalThis.BroadcastChannel;

function instalarCerrojos() {
  const cola = new Map<string, Promise<unknown>>();
  const request = async (nombre: string, fn: () => Promise<unknown>) => {
    const anterior = cola.get(nombre) ?? Promise.resolve();
    const propio = anterior.then(fn, fn);
    cola.set(
      nombre,
      propio.catch(() => undefined)
    );
    return propio;
  };
  Object.defineProperty(globalThis.navigator, "locks", { value: { request }, configurable: true });
}

/** Canal con entrega asíncrona —como el real— que además REGISTRA lo publicado. */
function instalarCanal() {
  const abiertos = new Set<FalsoCanal>();
  const publicados: Array<Record<string, unknown>> = [];
  const retenidos: Array<() => void> = [];
  let diferida = false;

  class FalsoCanal {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    constructor(readonly name: string) {
      abiertos.add(this);
    }
    postMessage(data: unknown) {
      publicados.push(data as Record<string, unknown>);
      for (const otro of abiertos) {
        if (otro === this || otro.name !== this.name) continue;
        const entregarA = () => otro.onmessage?.({ data });
        if (diferida) retenidos.push(entregarA);
        else queueMicrotask(entregarA);
      }
    }
    close() {
      abiertos.delete(this);
    }
  }

  Object.defineProperty(globalThis, "BroadcastChannel", { value: FalsoCanal, configurable: true, writable: true });
  return {
    publicados,
    /** Inyecta un mensaje sin pasar por ningún coordinador (mensajes atrasados). */
    inyectar: (data: unknown) => {
      for (const c of abiertos) queueMicrotask(() => c.onmessage?.({ data }));
    },
    /** A partir de aquí lo que se publique queda EN CAMINO hasta `soltar()`. */
    diferir: () => {
      diferida = true;
    },
    soltar: () => {
      diferida = false;
      for (const entregarA of retenidos.splice(0)) queueMicrotask(entregarA);
    },
    limpiar: () => {
      abiertos.clear();
      publicados.length = 0;
      retenidos.length = 0;
      diferida = false;
    },
  };
}

const entregar = () => new Promise((r) => setTimeout(r, 0));

interface Pestana {
  modulo: typeof import("./refreshCoordinator");
  accessToken: string | null;
  user: Perfil | null;
  /** Ciclos con los que esta pestaña llamó al servidor, en orden. */
  ciclosPedidos: string[];
  renovar: () => Promise<import("./refreshCoordinator").ResultadoRenovacion>;
}

let contadorDeSesiones = 0;

/**
 * Abre una pestaña. La renovación REGISTRA el ciclo vigente en el momento de
 * llamar al servidor: es la comprobación que pide el enunciado —qué ciclo usa
 * una operación local— y no se puede falsear publicando mensajes.
 */
async function abrirPestana(nombre = "u"): Promise<Pestana> {
  vi.resetModules();
  const modulo = await import("./refreshCoordinator");

  const p: Pestana = {
    modulo,
    accessToken: "inicial",
    user: null,
    ciclosPedidos: [],
    renovar: async () => ({ tipo: "descartada" }),
  };

  const adoptar = (s: { accessToken: string; user: Perfil }) => {
    p.accessToken = s.accessToken;
    p.user = s.user;
  };

  modulo.escucharOtrasPestanas({
    alRenovar: adoptar,
    alIniciar: adoptar,
    alCerrar: () => {
      p.accessToken = null;
      p.user = null;
    },
  });

  p.renovar = () =>
    modulo.renovarUnaSolaVez({
      tokenActual: () => p.accessToken,
      pedirRenovacion: async () => {
        // El ciclo VIGENTE en el instante de la petición.
        p.ciclosPedidos.push(modulo.cicloActual());
        contadorDeSesiones++;
        const user = perfilDe(`${nombre}-${contadorDeSesiones}`);
        return { accessToken: tokenDe(user.id, `t${contadorDeSesiones}`), csrfToken: "csrf", user, mustChangePassword: false };
      },
      adoptar: (s) => {
        p.accessToken = s.accessToken;
        p.user = s.user as Perfil;
      },
    });

  return p;
}

let canal: ReturnType<typeof instalarCanal>;

beforeEach(() => {
  localStorage.clear();
  contadorDeSesiones = 0;
  instalarCerrojos();
  canal = instalarCanal();
});

afterEach(() => {
  canal.limpiar();
  vi.restoreAllMocks();
  Object.defineProperty(globalThis.navigator, "locks", { value: locksOriginal, configurable: true });
  Object.defineProperty(globalThis, "BroadcastChannel", { value: canalOriginal, configurable: true, writable: true });
});

// ---------------------------------------------------------------------------

describe("una pestaña nueva se incorpora a la sesión en curso", () => {
  it("ADOPTA el ciclo autoritativo al cargarse, en vez de inventarse uno", async () => {
    // Como si otra pestaña ya hubiera iniciado sesión.
    sembrarAutoridad({ ciclo: "S1", estado: "active", revision: 3 });

    const nueva = await abrirPestana();

    expect(nueva.modulo.cicloActual(), "arrancar con un ciclo propio la dejaba fuera de la sesión").toBe("S1");
  });

  it("y su RENOVACIÓN usa ese ciclo, no uno propio", async () => {
    sembrarAutoridad({ ciclo: "S1", estado: "active", revision: 3 });
    const nueva = await abrirPestana();

    await nueva.renovar();

    // Lo que se comprueba es el ciclo con el que la operación LOCAL salió.
    expect(nueva.ciclosPedidos).toEqual(["S1"]);
    const anuncio = canal.publicados.find((m) => m.tipo === "renovado");
    expect(anuncio, "y el anuncio viaja con ese ciclo y esa revisión").toMatchObject({ ciclo: "S1", revision: 3 });
  });

  it("no adopta una TUMBA: contra un ciclo cerrado arranca con el suyo", async () => {
    sembrarAutoridad({ ciclo: "S1", estado: "closed", revision: 3 });

    const nueva = await abrirPestana();

    expect(nueva.modulo.cicloActual(), "esa sesión está cerrada: no hay nada a lo que unirse").not.toBe("S1");
  });

  it("una autoridad CORRUPTA se trata como ausencia", async () => {
    // Lo que dejaría una versión anterior de la aplicación: una cadena suelta.
    localStorage.setItem(CLAVE, "S1");

    const nueva = await abrirPestana();

    expect(nueva.modulo.cicloActual()).not.toBe("S1");
    // Y no explota al operar.
    await expect(nueva.renovar()).resolves.toMatchObject({ tipo: "renovada" });
  });
});

describe("el cierre desde la pestaña nueva alcanza a las anteriores", () => {
  it("la anterior se entera, y la autoridad queda con una TUMBA", async () => {
    const anterior = await abrirPestana("vieja");
    const ciclo = anterior.modulo.comenzarCicloDeSesion();
    const revision = leerAutoridad()!.revision;

    // La pestaña nueva llega después y se une a la sesión en curso.
    const nueva = await abrirPestana("nueva");
    expect(nueva.modulo.cicloActual()).toBe(ciclo);

    nueva.modulo.anunciarCierreDeSesion();
    await entregar();

    expect(anterior.accessToken, "la pestaña anterior tiene que quedarse sin sesión").toBeNull();
    /**
     * La tumba lleva la revisión SIGUIENTE, no la del registro activo. El cierre
     * es una transición del origen como cualquier otra, y necesita su propio
     * número: si reutilizara el del estado activo, un fallo de escritura dejaría
     * `{ciclo, active, N}` con esa misma revisión y la recuperación de confianza
     * lo daría por bueno, devolviendo a la pestaña a la sesión que cerró.
     */
    expect(leerAutoridad(), "y el ciclo queda ENTERRADO, no borrado").toEqual({
      ciclo,
      estado: "closed",
      revision: revision + 1,
    });
  });

  it("un `iniciada` ATRASADO del ciclo cerrado no resucita la sesión", async () => {
    const receptora = await abrirPestana("receptora");
    const ciclo = receptora.modulo.comenzarCicloDeSesion();
    const revision = leerAutoridad()!.revision;

    const otra = await abrirPestana("otra");
    otra.modulo.anunciarCierreDeSesion();
    await entregar();
    expect(receptora.accessToken).toBeNull();

    /**
     * El mensaje que se quedó en el camino. Antes la autoridad se BORRABA al
     * cerrar, y "sin autoridad" era indistinguible de "nunca hubo sesión": este
     * mensaje caía en el camino de reserva y devolvía al usuario a una sesión
     * que ya no existía. Con la tumba se rechaza explícitamente.
     */
    const user = perfilDe("resucitado");
    canal.inyectar({
      tipo: "iniciada",
      ciclo,
      revision,
      en: Date.now(),
      sesion: { accessToken: tokenDe(user.id, "tarde"), csrfToken: "csrf", user, mustChangePassword: false, ciclo },
    });
    await entregar();

    expect(receptora.accessToken, "una sesión enterrada no se reabre").toBeNull();
  });

  /**
   * ESTE es el caso que separa la tumba del borrado, y el que ninguna prueba
   * anterior cubría.
   *
   * La receptora todavía NO ha procesado el cierre —viaja por el canal— cuando
   * le llega un `renovado` atrasado de ese mismo ciclo. Su ciclo local sigue
   * siendo el cerrado, así que la comparación local dice "coincide".
   *
   * Con la autoridad BORRADA no había nada más que consultar: se caía al camino
   * de reserva, el ciclo coincidía y la sesión revivía. La tumba lo contradice de
   * forma explícita: ese ciclo existe y está cerrado.
   */
  it("un `renovado` atrasado NO revive la sesión mientras el cierre viaja por el canal", async () => {
    const receptora = await abrirPestana("receptora");
    const ciclo = receptora.modulo.comenzarCicloDeSesion();
    const revision = leerAutoridad()!.revision;

    const otra = await abrirPestana("otra");
    expect(otra.modulo.cicloActual()).toBe(ciclo);

    // El cierre queda EN CAMINO: la receptora aún no se ha enterado.
    canal.diferir();
    otra.modulo.anunciarCierreDeSesion();
    expect(leerAutoridad(), "la tumba ya está escrita, aunque el mensaje no haya llegado").toMatchObject({
      ciclo,
      estado: "closed",
    });

    const user = perfilDe("tardio");
    canal.inyectar({
      tipo: "renovado",
      ciclo,
      revision,
      en: Date.now(),
      sesion: { accessToken: tokenDe(user.id, "tardia"), csrfToken: "csrf", user, mustChangePassword: false, ciclo },
    });
    await entregar();

    expect(receptora.accessToken, "el ciclo está enterrado: nada de ese ciclo se adopta ya").toBe("inicial");

    // Y cuando por fin llega el cierre, se aplica igualmente.
    canal.soltar();
    await entregar();
    expect(receptora.accessToken).toBeNull();
  });

  it("un `renovado` de un ciclo ANTIGUO no vuelve tras empezar otro", async () => {
    const receptora = await abrirPestana("receptora");
    const viejo = receptora.modulo.comenzarCicloDeSesion();
    const revisionVieja = leerAutoridad()!.revision;

    // Entra otro usuario: ciclo nuevo y revisión mayor.
    const segunda = await abrirPestana("segunda");
    const nuevo = segunda.modulo.comenzarCicloDeSesion();
    expect(nuevo).not.toBe(viejo);

    const user = perfilDe("del-viejo");
    canal.inyectar({
      tipo: "renovado",
      ciclo: viejo,
      revision: revisionVieja,
      en: Date.now(),
      sesion: { accessToken: tokenDe(user.id, "vieja"), csrfToken: "csrf", user, mustChangePassword: false, ciclo: viejo },
    });
    await entregar();

    expect(receptora.accessToken, "el mensaje pertenece a un ciclo que ya no es el vigente").toBe("inicial");

    // Y la operación local siguiente usa el ciclo NUEVO, no el suyo antiguo.
    await receptora.renovar();
    expect(receptora.ciclosPedidos).toEqual([nuevo]);
  });
});

describe("el orden de carga de los módulos no cambia el resultado", () => {
  it("primero la que inicia, después la que se une", async () => {
    const primera = await abrirPestana("p1");
    const ciclo = primera.modulo.comenzarCicloDeSesion();

    const segunda = await abrirPestana("p2");

    await segunda.renovar();
    await entregar();

    expect(segunda.ciclosPedidos, "la que llegó después opera en el ciclo en curso").toEqual([ciclo]);
    expect(primera.accessToken, "y la primera adopta lo que anunció la segunda").not.toBe("inicial");
  });

  it("primero la que se une, después la que ya estaba (mismo resultado)", async () => {
    // La autoridad existe antes de que se cargue ningún módulo: es el caso de
    // una pestaña abierta desde cero mientras otra ventana ya tenía sesión.
    sembrarAutoridad({ ciclo: "S9", estado: "active", revision: 7 });

    const segunda = await abrirPestana("p2");
    const primera = await abrirPestana("p1");

    expect(segunda.modulo.cicloActual()).toBe("S9");
    expect(primera.modulo.cicloActual()).toBe("S9");

    await primera.renovar();
    await entregar();

    expect(primera.ciclosPedidos).toEqual(["S9"]);
    expect(segunda.accessToken, "se reconocen entre sí sin depender del orden de carga").not.toBe("inicial");
  });
});

describe("camino de RESERVA cuando localStorage no está disponible", () => {
  /**
   * Lo que se comprueba aquí es la degradación DECLARADA, no una garantía: sin
   * almacenamiento no hay autoridad compartida, así que no hay orden entre
   * pestañas. Lo que sí debe cumplirse es que nada explote y que no se adopte
   * nada ajeno.
   */
  it("si `getItem` LANZA, la pestaña sigue funcionando con su ciclo local", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("acceso denegado", "SecurityError");
    });

    const p = await abrirPestana();
    const propio = p.modulo.cicloActual();
    expect(propio, "hay ciclo, aunque no se pueda compartir").toMatch(/.+/);

    await expect(p.renovar(), "y se puede renovar").resolves.toMatchObject({ tipo: "renovada" });
    expect(p.ciclosPedidos).toEqual([propio]);
  });

  it("si `setItem` LANZA, iniciar sesión no rompe: solo deja de persistirse", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("cuota excedida", "QuotaExceededError");
    });

    const p = await abrirPestana();
    const ciclo = p.modulo.comenzarCicloDeSesion();

    expect(ciclo).toMatch(/.+/);
    expect(localStorage.getItem(CLAVE), "no se pudo escribir, y se acepta").toBeNull();

    await p.renovar();
    expect(p.ciclosPedidos, "la operación local usa el ciclo que la pestaña tiene").toEqual([ciclo]);
  });

  it("SIN autoridad, un mensaje de OTRO ciclo se ignora (conservador, no compartido)", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("acceso denegado", "SecurityError");
    });

    const p = await abrirPestana();
    const user = perfilDe("ajeno");
    canal.inyectar({
      tipo: "renovado",
      ciclo: "ciclo-ajeno",
      revision: 1,
      en: Date.now(),
      sesion: {
        accessToken: tokenDe(user.id, "ajena"),
        csrfToken: "csrf",
        user,
        mustChangePassword: false,
        ciclo: "ciclo-ajeno",
      },
    });
    await entregar();

    expect(p.accessToken, "sin autoridad se compara con el ciclo local: no se adopta nada ajeno").toBe("inicial");
  });

  it("SIN autoridad, un mensaje del PROPIO ciclo sí se acepta", async () => {
    // El contraste: la reserva no bloquea lo legítimo, solo deja de ordenar.
    const p = await abrirPestana();
    const propio = p.modulo.cicloActual();

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("acceso denegado", "SecurityError");
    });

    const user = perfilDe("propio");
    canal.inyectar({
      tipo: "renovado",
      ciclo: propio,
      revision: 1,
      en: Date.now(),
      sesion: { accessToken: tokenDe(user.id, "propia"), csrfToken: "csrf", user, mustChangePassword: false, ciclo: propio },
    });
    await entregar();

    expect(p.accessToken).toBe(tokenDe("propio", "propia"));
  });
});

/**
 * EL CASO INTERMEDIO: SE PUEDE LEER, PERO NO ESCRIBIR.
 *
 * Es distinto de "no hay almacenamiento" y mucho más traicionero: el registro
 * sigue ahí, legible y creíble, mientras describe un estado ANTERIOR al real.
 * Con `escribirAutoridad` devolviendo un booleano que nadie miraba, la pestaña
 * que iniciaba sesión como B y no podía persistirlo volvía al ciclo A en la
 * siguiente sincronización —el registro seguía diciendo A— y operaba con una
 * sesión que la cookie del navegador ya no respaldaba.
 */
describe("cuando `setItem` falla durante una transición", () => {
  /** Permite fallar solo durante la ventana que interesa. */
  function conEscrituraQuePuedeFallar() {
    const original = Storage.prototype.setItem;
    const estado = { fallando: false };
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (estado.fallando) throw new DOMException("cuota excedida", "QuotaExceededError");
      original.call(this, k, v);
    });
    return estado;
  }

  const sesionDe = (ciclo: string, quien: string) => {
    const user = perfilDe(quien);
    return { accessToken: tokenDe(user.id, quien), csrfToken: `csrf-${quien}`, user, mustChangePassword: false, ciclo };
  };

  it("la iniciadora NO vuelve al ciclo anterior, y la otra pestaña adopta el nuevo", async () => {
    // 1) Sesión A, activa y persistida.
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 5 });

    // 2) Dos pestañas ya cargadas, ambas en A.
    const otra = await abrirPestana("otra");
    const iniciadora = await abrirPestana("iniciadora");
    expect(otra.modulo.cicloActual()).toBe("A");
    expect(iniciadora.modulo.cicloActual()).toBe("A");

    /**
     * 3) Entra B en la iniciadora y la escritura falla EN ESE MOMENTO.
     *
     * Los mensajes quedan retenidos a propósito: así la fase siguiente ocurre
     * con el registro todavía en A y nadie que pueda haberlo corregido, que es
     * el estado en el que el defecto se manifiesta.
     */
    canal.diferir();
    const escritura = conEscrituraQuePuedeFallar();
    escritura.fallando = true;
    const cicloB = iniciadora.modulo.comenzarCicloDeSesion();
    expect(cicloB).not.toBe("A");
    expect(leerAutoridad(), "no se pudo persistir: el registro sigue en A").toEqual({
      ciclo: "A",
      estado: "active",
      revision: 5,
    });

    iniciadora.modulo.anunciarInicioDeSesion(sesionDe(cicloB, "usuario-b"));

    /**
     * 4) Una operación local ANTES de que nadie más haya podido tocar el
     * registro. Aquí el registro todavía dice A, así que es donde el defecto se
     * ve desnudo: sin el modo degradado, la sincronización devolvía la pestaña al
     * ciclo A y la renovación salía etiquetada con una sesión que la cookie ya no
     * respalda.
     */
    iniciadora.modulo.olvidarUltimoAnuncio();
    await iniciadora.renovar();
    expect(iniciadora.ciclosPedidos, "el registro dice A, pero la cookie es de B").toEqual([cicloB]);

    // 5) Se recupera el almacenamiento y por fin se entregan los mensajes.
    escritura.fallando = false;
    canal.soltar();
    await entregar();

    /**
     * 6) El comportamiento EXPLÍCITO de la otra pestaña: adopta la sesión de B
     * —el mensaje trae una revisión mayor que la registrada— y PERSISTE POR ELLA
     * la transición que la iniciadora no pudo escribir. Sin esta regla se
     * quedaría mostrando la sesión A, que la cookie del navegador ya no
     * respalda, y ninguna pestaña futura sabría de B.
     */
    expect(otra.accessToken, "la otra pestaña no puede seguir en una sesión que ya no existe").not.toBe("inicial");
    expect(otra.user?.username, "adopta lo que anunció la iniciadora, en su ciclo nuevo").toBe("iniciadora-1");
    expect(otra.modulo.cicloActual()).toBe(cicloB);
    expect(leerAutoridad(), "quien sí puede escribir registra la transición ajena").toEqual({
      ciclo: cicloB,
      estado: "active",
      revision: 6,
    });

    /**
     * 7) Y LA COMPROBACIÓN QUE PIDE EL ORDEN DEL ENUNCIADO: otra operación
     * local, ya después de la entrega del mensaje. No basta con mirar mensajes; lo que importa es con qué ciclo
     * habla con el servidor, porque de eso depende que su resultado se adopte.
     */
    iniciadora.modulo.olvidarUltimoAnuncio(); // si no, reutiliza lo recién anunciado
    await iniciadora.renovar();
    expect(iniciadora.ciclosPedidos, "no puede volver al ciclo A: la cookie es la de B").toEqual([cicloB, cicloB]);

    // Y esa renovación llega a la otra pestaña, que sigue en el mismo ciclo.
    await entregar();
    expect(otra.modulo.cicloActual(), "las dos pestañas siguen viéndose").toBe(cicloB);
  });

  it("sin nadie que la rescate, sigue operando en su ciclo (y el registro queda atrasado)", async () => {
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 5 });
    const iniciadora = await abrirPestana("sola");

    const escritura = conEscrituraQuePuedeFallar();
    escritura.fallando = true;
    const cicloB = iniciadora.modulo.comenzarCicloDeSesion();

    // Dos renovaciones seguidas: la segunda comprueba que no ha "vuelto" a A
    // entre medias, que es exactamente lo que hacía la sincronización.
    await iniciadora.renovar();
    iniciadora.modulo.olvidarUltimoAnuncio();
    await iniciadora.renovar();

    expect(iniciadora.ciclosPedidos).toEqual([cicloB, cicloB]);

    /**
     * LIMITACIÓN DECLARADA, comprobada aquí para que quede por escrito: nadie
     * pudo actualizar el registro, así que una pestaña que arranque desde cero
     * leerá el estado antiguo. No es recuperable desde el cliente; lo resuelve
     * el `sessionId` del backend.
     */
    expect(leerAutoridad()).toEqual({ ciclo: "A", estado: "active", revision: 5 });
    escritura.fallando = false;
    const nueva = await abrirPestana("nueva");
    expect(nueva.modulo.cicloActual(), "arranca en el estado que el registro pudo conservar").toBe("A");
  });

  it("al conseguir escribir de nuevo, la pestaña vuelve a fiarse del registro", async () => {
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 5 });
    const p = await abrirPestana("p");

    const escritura = conEscrituraQuePuedeFallar();
    escritura.fallando = true;
    p.modulo.comenzarCicloDeSesion();

    // El almacenamiento se recupera y la pestaña hace otra transición.
    escritura.fallando = false;
    const cicloC = p.modulo.comenzarCicloDeSesion();

    expect(leerAutoridad()).toEqual({ ciclo: cicloC, estado: "active", revision: 7 });

    // Y vuelve a aceptar lo que dice el registro: otra pestaña entra y esta la sigue.
    const otra = await abrirPestana("otra");
    const cicloD = otra.modulo.comenzarCicloDeSesion();
    await p.renovar();
    expect(p.ciclosPedidos, "el modo degradado no es permanente").toEqual([cicloD]);
  });
});

/**
 * LA RECEPCIÓN, DENTRO DEL CERROJO.
 *
 * `onmessage` hacía todo su trabajo fuera de la sección crítica: evaluaba el
 * mensaje, persistía la autoridad, cambiaba el ciclo y adoptaba o cerraba la
 * sesión. Entre esos pasos otra pestaña podía avanzar la autoridad, y el mensaje
 * acababa aplicándose contra un estado que ya no existía cuando se decidió que
 * era válido.
 */
describe("carreras entre la recepción y las demás operaciones", () => {
  /**
   * Simula que **otra pestaña, en otro hilo**, escribe en `localStorage` entre
   * dos lecturas nuestras. Es la única forma de reproducirlo en un entorno de un
   * solo hilo, donde nada puede intercalarse entre dos sentencias síncronas.
   *
   * @param aPartirDe a partir de qué lectura del registro se devuelve `despues`.
   */
  function registroQueCambiaEntreLecturas(antes: Autoridad, despues: Autoridad, aPartirDe = 2) {
    const original = Storage.prototype.getItem;
    let lecturas = 0;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, k: string) {
      if (k !== CLAVE) return original.call(this, k);
      lecturas++;
      return JSON.stringify(lecturas < aPartirDe ? antes : despues);
    });
  }

  const sobre = (tipo: "iniciada" | "renovado", ciclo: string, revision: number, quien: string) => {
    const user = perfilDe(quien);
    return {
      tipo,
      ciclo,
      revision,
      en: Date.now(),
      sesion: { accessToken: tokenDe(user.id, quien), csrfToken: "csrf", user, mustChangePassword: false, ciclo },
    };
  };

  it("(a) B iba a adoptarse, pero C gana la escritura: B se descarta y NINGÚN callback lo ve", async () => {
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 5 });
    const receptora = await abrirPestana("receptora");
    expect(receptora.modulo.cicloActual()).toBe("A");

    /**
     * INTERCALACIÓN EXACTA:
     *   1.ª lectura (evaluar el mensaje) → el registro dice A, revisión 5.
     *      El mensaje de B trae revisión 6 > 5 y ciclo distinto → "adoptar".
     *   entre medias, otra pestaña escribe C con revisión 7.
     *   2.ª lectura (dentro de `escribirAutoridad`) → ya dice C, revisión 7.
     *      La escritura de B (revisión 6) queda "rechazada" por monotonicidad.
     */
    registroQueCambiaEntreLecturas(
      { ciclo: "A", estado: "active", revision: 5 },
      { ciclo: "C", estado: "active", revision: 7 }
    );

    canal.inyectar(sobre("iniciada", "B", 6, "usuario-b"));
    await entregar();

    expect(receptora.accessToken, "la sesión perdedora no puede llegar a los callbacks").toBe("inicial");
    expect(receptora.user, "ni su perfil").toBeNull();
    expect(receptora.modulo.cicloActual(), "y la pestaña se pone al día con la autoridad que ganó").toBe("C");
  });

  it("(c) lo mismo con un CIERRE atrasado: no cierra una autoridad posterior", async () => {
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 5 });
    const receptora = await abrirPestana("receptora");

    let cierres = 0;
    receptora.modulo.escucharOtrasPestanas({
      alRenovar: () => undefined,
      alIniciar: () => undefined,
      alCerrar: () => {
        cierres++;
      },
    });

    registroQueCambiaEntreLecturas(
      { ciclo: "A", estado: "active", revision: 5 },
      { ciclo: "C", estado: "active", revision: 7 }
    );

    canal.inyectar({ tipo: "cerrada", ciclo: "B", revision: 6, en: Date.now() });
    await entregar();

    expect(cierres, "una tumba de un ciclo anterior no puede cerrar la sesión vigente").toBe(0);
    expect(receptora.accessToken).toBe("inicial");
    expect(receptora.modulo.cicloActual()).toBe("C");
  });

  it("(b) una pestaña DEGRADADA se recupera cuando otra registra una transición válida", async () => {
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 5 });
    const degradada = await abrirPestana("degradada");
    const otra = await abrirPestana("otra");

    // 1) La degradada intenta entrar como B y no puede persistirlo.
    const original = Storage.prototype.setItem;
    const estado = { fallando: true };
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (estado.fallando) throw new DOMException("cuota excedida", "QuotaExceededError");
      original.call(this, k, v);
    });
    const cicloB = degradada.modulo.comenzarCicloDeSesion();
    expect(leerAutoridad()?.ciclo, "no se persistió").toBe("A");

    // 2) El almacenamiento se recupera y OTRA pestaña entra como C.
    estado.fallando = false;
    const cicloC = otra.modulo.comenzarCicloDeSesion();
    otra.modulo.anunciarInicioDeSesion({
      accessToken: tokenDe("usuario-c", "c"),
      csrfToken: "csrf-c",
      user: perfilDe("usuario-c"),
      mustChangePassword: false,
      ciclo: cicloC,
    });
    expect(cicloC).not.toBe(cicloB);
    await entregar();

    /**
     * 3) La degradada tiene que salir de su aislamiento. Antes no podía: su
     * bandera solo se restauraba escribiendo ella misma, así que comparaba los
     * mensajes con su ciclo local (B) y descartaba el de C para siempre.
     */
    expect(degradada.accessToken, "adopta la sesión de C").toBe(tokenDe("usuario-c", "c"));
    expect(degradada.modulo.cicloActual()).toBe(cicloC);

    // 4) Y la comprobación que de verdad importa: con qué ciclo opera después.
    degradada.modulo.olvidarUltimoAnuncio();
    await degradada.renovar();
    expect(degradada.ciclosPedidos, "su siguiente renovación pide con el ciclo C").toEqual([cicloC]);
  });

  it("(d) el procesamiento ESPERA al cerrojo, no se cuela por delante", async () => {
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 5 });
    const receptora = await abrirPestana("receptora");

    // Una operación local retiene el cerrojo hasta que la prueba lo suelte.
    let soltar!: () => void;
    const enCurso = receptora.modulo.conCerrojoDeSesion(() => new Promise<void>((r) => (soltar = r)));
    await entregar();

    // Llega un mensaje perfectamente válido del ciclo vigente.
    canal.inyectar(sobre("renovado", "A", 5, "usuario-a"));
    await entregar();
    await entregar();

    expect(
      receptora.accessToken,
      "con el cerrojo ocupado, el mensaje NO puede haberse aplicado todavía"
    ).toBe("inicial");

    // Al soltarlo, le llega el turno.
    soltar();
    await enCurso;
    await entregar();

    expect(receptora.accessToken, "y entonces sí se aplica").toBe(tokenDe("usuario-a", "usuario-a"));
  });

  it("(e) SIN Web Locks el mensaje se aplica igual, pero sin orden fuerte", async () => {
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 5 });
    // Se retira la API antes de cargar el módulo: es el navegador que no la trae.
    Object.defineProperty(globalThis.navigator, "locks", { value: undefined, configurable: true });

    const receptora = await abrirPestana("receptora");
    canal.inyectar(sobre("renovado", "A", 5, "usuario-a"));
    await entregar();

    /**
     * Las reglas de autoridad y revisión siguen aplicándose —se reevalúa igual—,
     * y por eso el mensaje legítimo se adopta. Lo que se pierde es el ORDEN: no
     * hay nada que impida que una operación local simultánea se intercale. Es la
     * misma garantía que había antes de encolar la recepción, y no se promete
     * más.
     */
    expect(receptora.accessToken).toBe(tokenDe("usuario-a", "usuario-a"));

    /**
     * Y un mensaje ATRASADO se sigue rechazando: revisión anterior a la vigente.
     * (Uno de ciclo distinto pero revisión SUPERIOR sí se adoptaría, con cerrojo
     * o sin él: es la regla que permite recuperar una transición que su emisora
     * no pudo persistir.)
     */
    canal.inyectar(sobre("renovado", "ciclo-viejo", 4, "atrasado"));
    await entregar();
    expect(receptora.accessToken, "sin cerrojo no se relajan las reglas").toBe(tokenDe("usuario-a", "usuario-a"));
  });
});

/**
 * EL CIERRE ES UNA TRANSICIÓN AUTORITATIVA, NO UNA ETIQUETA SOBRE LA ANTERIOR.
 *
 * Mientras la tumba reutilizaba la revisión del estado activo, un fallo de
 * escritura al cerrar dejaba el registro en `{ciclo, active, N}` con la MISMA
 * revisión que la pestaña creía tener. `intentarRecuperarConfianza` acepta
 * `>= revisionLocal`, así que lo daba por bueno de inmediato y la pestaña volvía
 * a la sesión que acababa de cerrar. Con la revisión siguiente, ese registro
 * queda por detrás y ya no se acepta.
 */
describe("el cierre avanza la revisión del origen", () => {
  function conEscrituraQueFalla() {
    const original = Storage.prototype.setItem;
    const estado = { fallando: false };
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (estado.fallando) throw new DOMException("cuota excedida", "QuotaExceededError");
      original.call(this, k, v);
    });
    return estado;
  }

  const sobreDe = (tipo: "iniciada" | "renovado", ciclo: string, revision: number, quien: string) => {
    const user = perfilDe(quien);
    return {
      tipo,
      ciclo,
      revision,
      en: Date.now(),
      sesion: { accessToken: tokenDe(user.id, quien), csrfToken: "csrf", user, mustChangePassword: false, ciclo },
    };
  };

  it("(a) si falla la escritura de la tumba, NO se recupera el registro activo anterior", async () => {
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 5 });
    const p = await abrirPestana("cierra");
    expect(p.modulo.cicloActual()).toBe("A");

    // El cierre no puede persistirse: el registro se queda en {A, active, 5}.
    const escritura = conEscrituraQueFalla();
    escritura.fallando = true;
    p.modulo.anunciarCierreDeSesion();
    expect(leerAutoridad(), "no se pudo escribir la tumba").toEqual({ ciclo: "A", estado: "active", revision: 5 });

    /**
     * La pestaña está cerrada localmente y con revisión 6. El registro dice 5,
     * que es ANTERIOR, así que la recuperación de confianza no puede aceptarlo.
     * Reutilizando la revisión del estado activo, este registro habría empatado
     * en 5 y la pestaña habría vuelto a la sesión A.
     */
    escritura.fallando = false;
    p.modulo.olvidarUltimoAnuncio();
    await p.renovar();

    expect(p.ciclosPedidos, "una operación posterior NO puede volver a la sesión cerrada").not.toContain("A");
    expect(p.modulo.cicloActual()).not.toBe("A");
  });

  it("(b) otra pestaña recibe la tumba con revisión mayor y la persiste", async () => {
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 5 });
    const receptora = await abrirPestana("receptora");

    /**
     * El registro sigue en `{A, active, 5}` —la emisora no pudo escribirlo— y
     * llega `{cerrada, A, 6}`. Es el MISMO ciclo con revisión mayor: antes se
     * comprobaba el ciclo primero y ese caso caía en "revisiones distintas →
     * ignorar", así que la sesión seguía viva aquí.
     */
    canal.inyectar({ tipo: "cerrada", ciclo: "A", revision: 6, en: Date.now() });
    await entregar();

    expect(receptora.accessToken, "la sesión se cierra").toBeNull();
    expect(leerAutoridad(), "y la tumba queda registrada por quien sí puede escribir").toEqual({
      ciclo: "A",
      estado: "closed",
      revision: 6,
    });
  });

  it("(c) una pestaña abierta DESPUÉS del rescate no adopta A", async () => {
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 5 });
    const receptora = await abrirPestana("receptora");
    canal.inyectar({ tipo: "cerrada", ciclo: "A", revision: 6, en: Date.now() });
    await entregar();

    const nueva = await abrirPestana("nueva");

    expect(nueva.modulo.cicloActual(), "contra una tumba no se adopta nada").not.toBe("A");
    expect(receptora.accessToken).toBeNull();
  });

  it("(d) tras la tumba, un `renovado` o `iniciada` de A/5 no revive la sesión", async () => {
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 5 });
    const receptora = await abrirPestana("receptora");
    canal.inyectar({ tipo: "cerrada", ciclo: "A", revision: 6, en: Date.now() });
    await entregar();

    // Mensajes de la vida anterior de A, con la revisión de entonces.
    canal.inyectar(sobreDe("renovado", "A", 5, "zombi-1"));
    await entregar();
    expect(receptora.accessToken, "revisión anterior a la tumba").toBeNull();

    canal.inyectar(sobreDe("iniciada", "A", 5, "zombi-2"));
    await entregar();
    expect(receptora.accessToken, "tampoco un inicio atrasado").toBeNull();
  });

  it("(e) un login posterior sube a 7, y la tumba A/6 atrasada no lo cierra", async () => {
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 5 });
    const receptora = await abrirPestana("receptora");
    const otra = await abrirPestana("otra");

    // Cierre de A (revisión 6) y, después, login nuevo (revisión 7).
    otra.modulo.anunciarCierreDeSesion();
    await entregar();
    const cicloNuevo = otra.modulo.comenzarCicloDeSesion();
    expect(leerAutoridad()).toEqual({ ciclo: cicloNuevo, estado: "active", revision: 7 });

    otra.modulo.anunciarInicioDeSesion({
      accessToken: tokenDe("usuario-nuevo", "n"),
      csrfToken: "csrf-n",
      user: perfilDe("usuario-nuevo"),
      mustChangePassword: false,
      ciclo: cicloNuevo,
    });
    await entregar();
    expect(receptora.accessToken).toBe(tokenDe("usuario-nuevo", "n"));

    // Y ahora llega, tarde, el cierre de A. Su revisión (6) es anterior a la 7.
    canal.inyectar({ tipo: "cerrada", ciclo: "A", revision: 6, en: Date.now() });
    await entregar();

    expect(receptora.accessToken, "una tumba atrasada no cierra la sesión posterior").toBe(
      tokenDe("usuario-nuevo", "n")
    );
    expect(leerAutoridad()).toEqual({ ciclo: cicloNuevo, estado: "active", revision: 7 });
  });
});

/**
 * EL RELOJ LOCAL DE LA RECEPTORA, cuando tampoco ella puede escribir.
 *
 * Es el caso simétrico del cierre degradado. La rama `cerrada` de
 * `procesarMensaje` iba ANTES de actualizar `revisionLocal`, así que una pestaña
 * que recibía `{cerrada, A, 6}` y no podía persistirla seguía con su reloj en 5.
 * El registro guardado —`{A, active, 5}`— empataba entonces con ese reloj y
 * `intentarRecuperarConfianza` lo daba por bueno: la pestaña volvía a la sesión
 * que acababa de cerrar.
 */
describe("el reloj local avanza con todo mensaje aplicado", () => {
  function conEscrituraQueFalla(fallandoDeInicio = false) {
    const original = Storage.prototype.setItem;
    const estado = { fallando: fallandoDeInicio };
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (estado.fallando) throw new DOMException("cuota excedida", "QuotaExceededError");
      original.call(this, k, v);
    });
    return estado;
  }

  const sobreDe = (tipo: "iniciada" | "renovado", ciclo: string, revision: number, quien: string) => {
    const user = perfilDe(quien);
    return {
      tipo,
      ciclo,
      revision,
      en: Date.now(),
      sesion: { accessToken: tokenDe(user.id, quien), csrfToken: "csrf", user, mustChangePassword: false, ciclo },
    };
  };

  /** (a) + (b) + (c): la misma pestaña a lo largo de las tres fases. */
  it("(a,b,c) recibe una tumba que no puede persistir, y ni vuelve a A ni la reabre al recuperarse", async () => {
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 5 });
    const receptora = await abrirPestana("receptora");
    expect(receptora.modulo.cicloActual()).toBe("A");

    // (a) Llega el cierre con revisión 6 y esta pestaña TAMPOCO puede escribir.
    const escritura = conEscrituraQueFalla(true);
    canal.inyectar({ tipo: "cerrada", ciclo: "A", revision: 6, en: Date.now() });
    await entregar();

    expect(receptora.accessToken, "el cierre se aplica localmente").toBeNull();
    expect(leerAutoridad(), "aunque no se haya podido registrar").toEqual({
      ciclo: "A",
      estado: "active",
      revision: 5,
    });

    /**
     * (b) Se recupera el almacenamiento, pero el registro sigue en 5. Como el
     * reloj local ya avanzó a 6, ese registro es ANTERIOR y no puede recuperarse:
     * volver a él sería volver a la sesión cerrada.
     */
    escritura.fallando = false;
    receptora.modulo.olvidarUltimoAnuncio();
    await receptora.renovar();
    expect(receptora.ciclosPedidos, "una operación posterior no puede volver a A").not.toContain("A");

    /**
     * (c) Otra pestaña sí consigue registrar la tumba. La receptora recupera la
     * confianza —el registro ya no está por detrás— pero no reabre nada: contra
     * una tumba no se adopta ciclo.
     */
    sembrarAutoridad({ ciclo: "A", estado: "closed", revision: 6 });
    receptora.modulo.olvidarUltimoAnuncio();
    await receptora.renovar();

    expect(receptora.ciclosPedidos, "la tumba no devuelve a la sesión cerrada").not.toContain("A");
    expect(receptora.modulo.cicloActual()).not.toBe("A");
  });

  it("(d) degradada en B/7: un `renovado` de B/6 se ignora, y la transición siguiente es la 8", async () => {
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 6 });
    const p = await abrirPestana("degradada");

    // Entra en B con revisión 7 y no puede persistirlo: queda degradada.
    const escritura = conEscrituraQueFalla(true);
    const cicloB = p.modulo.comenzarCicloDeSesion();
    p.modulo.anunciarInicioDeSesion({
      accessToken: tokenDe("usuario-b", "b"),
      csrfToken: "csrf-b",
      user: perfilDe("usuario-b"),
      mustChangePassword: false,
      ciclo: cicloB,
    });

    /**
     * Llega un mensaje de SU MISMO ciclo pero de una revisión anterior. Sin
     * comparar la revisión en el camino de reserva, se aceptaba —el ciclo
     * coincide— y una sesión atrasada volvía a aplicarse como si fuera nueva.
     */
    canal.inyectar(sobreDe("renovado", cicloB, 6, "atrasado"));
    await entregar();
    expect(p.accessToken, "revisión anterior a la que esta pestaña ya emitió").not.toBe(
      tokenDe("atrasado", "atrasado")
    );

    // Y el reloj no ha retrocedido: la transición siguiente es la 8, no otra 7.
    escritura.fallando = false;
    p.modulo.comenzarCicloDeSesion();
    expect(leerAutoridad()?.revision, "nunca se reutiliza una revisión ya emitida").toBe(8);
  });

  it("(e) del mismo ciclo con revisión superior: avanza si está activo, no si hay tumba", async () => {
    // Mitad 1: sobre estado ACTIVO, el mensaje avanza el estado local.
    sembrarAutoridad({ ciclo: "A", estado: "active", revision: 5 });
    const receptora = await abrirPestana("receptora");

    canal.inyectar(sobreDe("renovado", "A", 6, "al-dia"));
    await entregar();

    expect(receptora.accessToken, "una revisión posterior del mismo ciclo sí se aplica").toBe(
      tokenDe("al-dia", "al-dia")
    );
    expect(leerAutoridad()).toEqual({ ciclo: "A", estado: "active", revision: 6 });

    // Mitad 2: sobre una TUMBA del mismo ciclo, ni con revisión mayor.
    sembrarAutoridad({ ciclo: "A", estado: "closed", revision: 7 });
    canal.inyectar(sobreDe("iniciada", "A", 8, "zombi"));
    await entregar();

    expect(receptora.accessToken, "un ciclo enterrado no se reabre por su propio ciclo").not.toBe(
      tokenDe("zombi", "zombi")
    );
    expect(leerAutoridad(), "y la tumba no se convierte en activa").toMatchObject({ ciclo: "A", estado: "closed" });
  });
});

describe("los fallos del procesamiento no se tragan en silencio", () => {
  it("un suscriptor que LANZA no impide que los demás reciban el aviso", async () => {
    const receptora = await abrirPestana("receptora");
    const ciclo = receptora.modulo.comenzarCicloDeSesion();

    const recibidos: string[] = [];
    receptora.modulo.escucharOtrasPestanas({
      alRenovar: () => undefined,
      alIniciar: () => undefined,
      alCerrar: () => {
        throw new Error("suscriptor roto");
      },
    });
    receptora.modulo.escucharOtrasPestanas({
      alRenovar: () => undefined,
      alIniciar: () => undefined,
      alCerrar: () => recibidos.push("segundo"),
    });

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    canal.inyectar({ tipo: "cerrada", ciclo, revision: leerAutoridad()!.revision, en: Date.now() });
    await entregar();

    /**
     * Sin aislar los suscriptores, la excepción del primero cortaba el bucle y
     * el segundo —y la propia pestaña— nunca se enteraban de un CIERRE DE
     * SESIÓN, que es justo el aviso que no se puede perder.
     */
    expect(recibidos, "los demás suscriptores siguen recibiendo").toContain("segundo");
    expect(receptora.accessToken, "y la pestaña cierra igualmente").toBeNull();
    expect(error, "el fallo se registra, no se absorbe").toHaveBeenCalled();
  });
});

describe("monotonicidad de la revisión", () => {
  it("cada inicio de ciclo SUBE la revisión", async () => {
    const p = await abrirPestana();

    p.modulo.comenzarCicloDeSesion();
    const primera = leerAutoridad()!.revision;
    p.modulo.comenzarCicloDeSesion();

    expect(leerAutoridad()!.revision).toBe(primera + 1);
  });

  it("un mensaje con revisión ANTERIOR se ignora aunque el ciclo coincida", async () => {
    const receptora = await abrirPestana("receptora");
    const ciclo = receptora.modulo.comenzarCicloDeSesion();
    const revision = leerAutoridad()!.revision;

    // El origen avanza: otra pestaña vuelve a entrar en el MISMO ciclo.
    sembrarAutoridad({ ciclo, estado: "active", revision: revision + 5 });

    const user = perfilDe("atrasado");
    canal.inyectar({
      tipo: "renovado",
      ciclo,
      revision,
      en: Date.now(),
      sesion: { accessToken: tokenDe(user.id, "atrasada"), csrfToken: "csrf", user, mustChangePassword: false, ciclo },
    });
    await entregar();

    expect(receptora.accessToken, "mismo ciclo, momento anterior del origen").toBe("inicial");
  });

  it("un mensaje SIN revisión —de una versión anterior— se ignora", async () => {
    const receptora = await abrirPestana("receptora");
    const ciclo = receptora.modulo.comenzarCicloDeSesion();

    const user = perfilDe("sin-revision");
    canal.inyectar({
      tipo: "renovado",
      ciclo,
      en: Date.now(),
      sesion: { accessToken: tokenDe(user.id, "sr"), csrfToken: "csrf", user, mustChangePassword: false, ciclo },
    });
    await entregar();

    expect(receptora.accessToken, "no se puede situar en la historia del origen").toBe("inicial");
  });
});
