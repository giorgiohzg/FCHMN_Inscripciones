/**
 * A1 — el coordinador: cierre condicional y orden de clasificación.
 *
 * Dos garantías nuevas en `refreshCoordinator.ts`:
 *
 *  1. `ejecutarRenovacion` comprueba el CICLO antes de clasificar el resultado.
 *     Un 401 que llega después de que el ciclo cambió es `descartada`, no
 *     `invalida`; y `invalida` lleva el ciclo al que se refiere.
 *  2. `cerrarSiCicloVigente` comprueba y cierra juntos, bajo el cerrojo, y se
 *     niega si el ciclo cambió o fue enterrado — incluso cuando el aviso de otra
 *     pestaña todavía no ha llegado, porque consulta la autoridad del origen.
 *
 * Cada «pestaña» es una instancia FRESCA del módulo (`vi.resetModules`), con su
 * propia memoria de ciclo, y comparten el `localStorage` como en el navegador.
 * Todo es simulado: cerrojos, canal y almacenamiento. No hay red ni servidor.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type Modulo = typeof import("./refreshCoordinator");

const perfilDe = (nombre: string) => ({
  id: nombre,
  username: nombre,
  ownerType: "club" as const,
  personId: null,
  clubId: "c1",
  roles: ["club"],
});

/** Access token legible cuyo `sub` y claims coinciden con el perfil. */
function tokenDe(id: string): string {
  const p = perfilDe(id);
  const payload = btoa(
    JSON.stringify({ sub: p.id, ownerType: p.ownerType, personId: p.personId, clubId: p.clubId, roles: p.roles, permissions: [] })
  );
  return `encabezado.${payload}.firma`;
}

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

function quitarCerrojos() {
  Object.defineProperty(globalThis.navigator, "locks", { value: undefined, configurable: true });
}

/** Canal con el comportamiento real —asíncrono, sin eco— y entrega diferible. */
function instalarCanal() {
  const abiertos = new Set<FalsoCanal>();
  const pendientes: Array<() => void> = [];
  let diferida = false;
  const vaciar = () => pendientes.splice(0).forEach((f) => f());

  class FalsoCanal {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    constructor(readonly name: string) {
      abiertos.add(this);
    }
    postMessage(data: unknown) {
      for (const otro of abiertos) {
        if (otro !== this && otro.name === this.name) pendientes.push(() => otro.onmessage?.({ data }));
      }
      if (!diferida) queueMicrotask(vaciar);
    }
    close() {
      abiertos.delete(this);
    }
  }

  Object.defineProperty(globalThis, "BroadcastChannel", { value: FalsoCanal, configurable: true, writable: true });
  return {
    diferirEntrega: () => {
      diferida = true;
    },
    entregarPendientes: () => {
      diferida = false;
      vaciar();
    },
  };
}

/** Deja que corra la cola de microtareas y la de macrotareas inmediatas. */
const dejarCorrer = () => new Promise((r) => setTimeout(r, 0));

async function abrirPestana(): Promise<Modulo> {
  vi.resetModules();
  return import("./refreshCoordinator");
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis.navigator, "locks", { value: locksOriginal, configurable: true });
  Object.defineProperty(globalThis, "BroadcastChannel", { value: canalOriginal, configurable: true, writable: true });
});

describe("cerrarSiCicloVigente — con Web Locks", () => {
  beforeEach(() => {
    instalarCerrojos();
    instalarCanal();
  });

  it("cierra, y devuelve true, cuando el ciclo SIGUE siendo el vigente", async () => {
    const a = await abrirPestana();
    const c = a.comenzarCicloDeSesion();
    const cerrar = vi.fn();

    await expect(a.cerrarSiCicloVigente(c, cerrar)).resolves.toBe(true);

    expect(cerrar).toHaveBeenCalledTimes(1);
  });

  it("NO cierra si el ciclo cambió en ESTA pestaña (un login posterior)", async () => {
    const a = await abrirPestana();
    const antiguo = a.comenzarCicloDeSesion();
    a.comenzarCicloDeSesion(); // entra otra sesión
    const cerrar = vi.fn();

    await expect(a.cerrarSiCicloVigente(antiguo, cerrar)).resolves.toBe(false);

    expect(cerrar).not.toHaveBeenCalled();
  });

  it("NO cierra si OTRA pestaña ya inició sesión, aunque su aviso no haya llegado", async () => {
    const canal = instalarCanal();
    canal.diferirEntrega(); // el aviso queda retenido: la autoridad es lo único que sabe
    const a = await abrirPestana();
    const cicloDeA = a.comenzarCicloDeSesion();
    const b = await abrirPestana();
    b.comenzarCicloDeSesion(); // B entra: escribe la autoridad, y su aviso sigue en vuelo
    const cerrar = vi.fn();

    await expect(a.cerrarSiCicloVigente(cicloDeA, cerrar)).resolves.toBe(false);

    expect(cerrar, "consultó la autoridad en vez de fiarse de su ciclo local").not.toHaveBeenCalled();
  });

  it("NO cierra si OTRA pestaña ya cerró ese ciclo (la tumba): evita un segundo anuncio", async () => {
    const canal = instalarCanal();
    canal.diferirEntrega();
    const a = await abrirPestana();
    const ciclo = a.comenzarCicloDeSesion();
    const b = await abrirPestana(); // adopta el ciclo activo de A
    b.anunciarCierreDeSesion();
    const cerrar = vi.fn();

    await expect(a.cerrarSiCicloVigente(ciclo, cerrar)).resolves.toBe(false);

    expect(cerrar).not.toHaveBeenCalled();
  });

  it("un inicio de sesión de otra pestaña ENTREGADO FUERA DE ORDEN no produce el cierre", async () => {
    const canal = instalarCanal();
    canal.diferirEntrega();
    const a = await abrirPestana();
    const cicloDeA = a.comenzarCicloDeSesion();

    const iniciadas: unknown[] = [];
    const ningunaOtra = vi.fn();
    a.escucharOtrasPestanas({ alRenovar: ningunaOtra, alCerrar: ningunaOtra, alIniciar: (s) => iniciadas.push(s) });

    const b = await abrirPestana();
    const cicloDeB = b.comenzarCicloDeSesion();
    b.anunciarInicioDeSesion({
      accessToken: tokenDe("uB"),
      csrfToken: "csrf-B",
      user: perfilDe("uB"),
      mustChangePassword: false,
      ciclo: cicloDeB,
    });

    // El aviso llega ahora, ya encolado detrás del cerrojo, y justo después se
    // pide el cierre del ciclo de A.
    canal.entregarPendientes();
    const cerrar = vi.fn();
    await expect(a.cerrarSiCicloVigente(cicloDeA, cerrar)).resolves.toBe(false);
    await dejarCorrer();

    expect(iniciadas, "la pestaña adoptó la sesión de B").toHaveLength(1);
    expect(cerrar, "y el 401 atrasado de A no cerró nada").not.toHaveBeenCalled();
  });

  it("dos cierres condicionales seguidos del mismo ciclo: solo el primero actúa si el primero lo entierra", async () => {
    const a = await abrirPestana();
    const ciclo = a.comenzarCicloDeSesion();
    // Como `limpiarSesion`: cerrar = anunciar el cierre, que entierra el ciclo.
    const cerrar = vi.fn(() => a.anunciarCierreDeSesion());

    const resultados = await Promise.all([a.cerrarSiCicloVigente(ciclo, cerrar), a.cerrarSiCicloVigente(ciclo, cerrar)]);

    expect(resultados).toEqual([true, false]);
    expect(cerrar).toHaveBeenCalledTimes(1);
  });
});

describe("cerrarSiCicloVigente — SIN Web Locks", () => {
  beforeEach(() => {
    quitarCerrojos();
    instalarCanal();
  });

  it("sigue comprobando y cerrando juntos dentro de la pestaña", async () => {
    const a = await abrirPestana();
    const antiguo = a.comenzarCicloDeSesion();
    const cerrar = vi.fn();

    await expect(a.cerrarSiCicloVigente(antiguo, cerrar)).resolves.toBe(true);
    const nuevo = a.comenzarCicloDeSesion();
    await expect(a.cerrarSiCicloVigente(antiguo, cerrar)).resolves.toBe(false);
    await expect(a.cerrarSiCicloVigente(nuevo, cerrar)).resolves.toBe(true);

    expect(cerrar).toHaveBeenCalledTimes(2);
  });

  it("y sigue consultando la autoridad: no actúa sobre un ciclo que otra pestaña ya sustituyó", async () => {
    const a = await abrirPestana();
    const cicloDeA = a.comenzarCicloDeSesion();
    const b = await abrirPestana();
    b.comenzarCicloDeSesion();
    const cerrar = vi.fn();

    await expect(a.cerrarSiCicloVigente(cicloDeA, cerrar)).resolves.toBe(false);

    expect(cerrar).not.toHaveBeenCalled();
  });
});

describe("cerrarSiCicloVigente — SIN almacenamiento disponible", () => {
  beforeEach(() => {
    instalarCerrojos();
    instalarCanal();
    const bloqueado = () => {
      throw new Error("almacenamiento bloqueado");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(bloqueado);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(bloqueado);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(bloqueado);
  });

  it("decide con el ciclo LOCAL: camino de reserva, conservador", async () => {
    const a = await abrirPestana();
    const antiguo = a.comenzarCicloDeSesion();
    const cerrar = vi.fn();

    await expect(a.cerrarSiCicloVigente(antiguo, cerrar)).resolves.toBe(true);

    const nuevo = a.comenzarCicloDeSesion();
    await expect(a.cerrarSiCicloVigente(antiguo, cerrar), "el ciclo local ya es otro").resolves.toBe(false);
    await expect(a.cerrarSiCicloVigente(nuevo, cerrar)).resolves.toBe(true);
    expect(cerrar).toHaveBeenCalledTimes(2);
  });
});

/**
 * Orden de clasificación en `ejecutarRenovacion`, ejercitado a través de
 * `renovarUnaSolaVez` con un `pedirRenovacion` controlado.
 */
describe("la renovación comprueba el ciclo ANTES de clasificar", () => {
  beforeEach(() => {
    instalarCerrojos();
    instalarCanal();
  });

  const dependencias = (pedir: () => Promise<unknown>) => ({
    tokenActual: () => null,
    adoptar: vi.fn(),
    pedirRenovacion: pedir,
  });

  it("un 401 con el ciclo SIN cambios es `invalida` y trae el ciclo al que se refiere", async () => {
    const a = await abrirPestana();
    const ciclo = a.comenzarCicloDeSesion();

    const r = await a.renovarUnaSolaVez(dependencias(async () => null));

    expect(r).toEqual({ tipo: "invalida", ciclo });
  });

  it("un 401 que llega con el ciclo YA CAMBIADO es `descartada`, no `invalida`", async () => {
    const a = await abrirPestana();
    a.comenzarCicloDeSesion();

    const r = await a.renovarUnaSolaVez(
      dependencias(async () => {
        a.comenzarCicloDeSesion(); // entra otra sesión mientras la petición viaja
        return null; // y entonces llega el 401
      })
    );

    expect(r, "antes se devolvía `invalida` y quien lo recibía cerraba la sesión nueva").toEqual({ tipo: "descartada" });
  });

  it("un 401 que llega con el ciclo ENTERRADO por otra pestaña es `descartada`", async () => {
    const a = await abrirPestana();
    a.comenzarCicloDeSesion();
    const b = await abrirPestana(); // adopta el ciclo de A

    const r = await a.renovarUnaSolaVez(
      dependencias(async () => {
        b.anunciarCierreDeSesion(); // la otra pestaña cerró; su aviso no ha llegado
        return null;
      })
    );

    expect(r).toEqual({ tipo: "descartada" });
  });

  it("una renovación EXITOSA con el ciclo cambiado tampoco se adopta", async () => {
    const a = await abrirPestana();
    a.comenzarCicloDeSesion();
    const deps = dependencias(async () => {
      a.comenzarCicloDeSesion();
      return { accessToken: tokenDe("uA"), csrfToken: "c", user: perfilDe("uA"), mustChangePassword: false };
    });

    const r = await a.renovarUnaSolaVez(deps);

    expect(r).toEqual({ tipo: "descartada" });
    expect(deps.adoptar).not.toHaveBeenCalled();
  });

  it("sin Web Locks el orden es el mismo", async () => {
    quitarCerrojos();
    const a = await abrirPestana();
    a.comenzarCicloDeSesion();

    const r = await a.renovarUnaSolaVez(
      dependencias(async () => {
        a.comenzarCicloDeSesion();
        return null;
      })
    );

    expect(r).toEqual({ tipo: "descartada" });
  });
});

/** Promesa que resolvemos nosotros: la BARRERA con la que se retiene el cerrojo. */
function puerta() {
  let abrir!: () => void;
  const promesa = new Promise<void>((r) => (abrir = r));
  return { promesa, abrir };
}

/** Sesión completa y coherente para anunciarla como lo haría un login. */
const sesionDe = (id: string, ciclo: string) => ({
  accessToken: tokenDe(id),
  csrfToken: `csrf-${id}`,
  user: perfilDe(id),
  mustChangePassword: false,
  ciclo,
});

/**
 * A1 (corrección) — la identidad se comprueba DENTRO de la sección crítica.
 *
 * Una comprobación hecha antes de pedir el cerrojo no cubre lo que ocurre mientras
 * se espera: otra operación de sesión puede tenerlo, y cuando suelta, la sesión
 * ya es otra. Aquí un «retenedor» toma el cerrojo, y es QUIEN CAMBIA LA SESIÓN
 * antes de soltarlo, así que el orden está fijado por la barrera, no por el reloj.
 */
describe("la renovación comprueba la identidad DENTRO del cerrojo", () => {
  beforeEach(() => {
    instalarCerrojos();
    instalarCanal();
  });

  // `pedirRenovacion` es un espía: varias pruebas comprueban que NO se llamó.
  const dependencias = (pedir: () => Promise<unknown>) => ({
    tokenActual: () => null,
    adoptar: vi.fn(),
    pedirRenovacion: vi.fn(pedir),
  });

  it("cambia la sesión mientras ESPERA el cerrojo: no reutiliza el anuncio de la nueva ni pide nada", async () => {
    const a = await abrirPestana();
    const cicloDeA = a.comenzarCicloDeSesion();
    const barrera = puerta();

    // El retenedor tiene el cerrojo y, al soltarlo, deja una sesión NUEVA ya anunciada.
    const retenedor = a.conCerrojoDeSesion(async () => {
      await barrera.promesa;
      const cicloDeB = a.comenzarCicloDeSesion();
      a.anunciarInicioDeSesion(sesionDe("uB", cicloDeB));
    });

    const deps = dependencias(async () => ({ accessToken: tokenDe("uB"), csrfToken: "x", user: perfilDe("uB"), mustChangePassword: false }));
    // Al pedirla, la sesión de A SIGUE siendo la vigente: la comprobación de entrada pasa.
    const sigueSiendoA = () => a.cicloActual() === cicloDeA;
    const renovacion = a.renovarUnaSolaVez(deps, sigueSiendoA);

    barrera.abrir();
    await retenedor;

    await expect(renovacion, "antes devolvía el anuncio de B como si fuera la renovación pedida").resolves.toEqual({
      tipo: "descartada",
    });
    expect(deps.pedirRenovacion, "no se emitió ninguna petición").not.toHaveBeenCalled();
    expect(deps.adoptar, "y no se adoptó nada").not.toHaveBeenCalled();
  });

  it("lo mismo cuando no hay anuncio que reutilizar: no emite la renovación", async () => {
    const a = await abrirPestana();
    const cicloDeA = a.comenzarCicloDeSesion();
    const barrera = puerta();
    const retenedor = a.conCerrojoDeSesion(async () => {
      await barrera.promesa;
      a.comenzarCicloDeSesion(); // otra sesión, sin anunciar
    });
    const pedir = vi.fn(async () => null);

    const renovacion = a.renovarUnaSolaVez(dependencias(pedir), () => a.cicloActual() === cicloDeA);
    barrera.abrir();
    await retenedor;

    await expect(renovacion).resolves.toEqual({ tipo: "descartada" });
    expect(pedir).not.toHaveBeenCalled();
  });

  it("contraste: si la sesión NO cambió mientras esperaba, renueva con normalidad", async () => {
    const a = await abrirPestana();
    const cicloDeA = a.comenzarCicloDeSesion();
    const barrera = puerta();
    const retenedor = a.conCerrojoDeSesion(async () => {
      await barrera.promesa;
    });
    const deps = dependencias(async () => ({ accessToken: tokenDe("uA"), csrfToken: "x", user: perfilDe("uA"), mustChangePassword: false }));

    const renovacion = a.renovarUnaSolaVez(deps, () => a.cicloActual() === cicloDeA);
    barrera.abrir();
    await retenedor;

    await expect(renovacion).resolves.toMatchObject({ tipo: "renovada" });
    expect(deps.pedirRenovacion).toHaveBeenCalledTimes(1);
    expect(deps.adoptar).toHaveBeenCalledTimes(1);
  });

  it("se comprueba también AL ENTRAR: una petición ya antigua no pide el cerrojo ni se une a un vuelo", async () => {
    const a = await abrirPestana();
    a.comenzarCicloDeSesion();
    const pedir = vi.fn(async () => null);

    const r = await a.renovarUnaSolaVez(dependencias(pedir), () => false);

    expect(r).toEqual({ tipo: "descartada" });
    expect(pedir).not.toHaveBeenCalled();
    // Y no deja nada bloqueado: una renovación posterior sale con normalidad.
    await expect(a.renovarUnaSolaVez(dependencias(async () => null))).resolves.toMatchObject({ tipo: "invalida" });
  });

  describe("varias peticiones comparten UN vuelo", () => {
    it("si TODAS son de una sesión que ya no es la vigente, no sale; y el vuelo siguiente es nuevo", async () => {
      const a = await abrirPestana();
      const cicloDeA = a.comenzarCicloDeSesion();
      const barrera = puerta();
      const retenedor = a.conCerrojoDeSesion(async () => {
        await barrera.promesa;
        a.comenzarCicloDeSesion();
      });
      const pedir = vi.fn(async () => null);
      const deps = dependencias(pedir);
      const sigueSiendoA = () => a.cicloActual() === cicloDeA;

      const primera = a.renovarUnaSolaVez(deps, sigueSiendoA);
      const segunda = a.renovarUnaSolaVez(deps, sigueSiendoA); // se une al vuelo de la primera
      barrera.abrir();
      await retenedor;

      await expect(Promise.all([primera, segunda])).resolves.toEqual([{ tipo: "descartada" }, { tipo: "descartada" }]);
      expect(pedir).not.toHaveBeenCalled();

      // Quien llega después NO hereda un vuelo que decidió no salir.
      const cicloActual = a.cicloActual();
      await expect(a.renovarUnaSolaVez(deps, () => a.cicloActual() === cicloActual)).resolves.toEqual({
        tipo: "invalida",
        ciclo: cicloActual,
      });
      expect(pedir).toHaveBeenCalledTimes(1);
    });

    it("si una de ellas SÍ es de la sesión vigente, el vuelo sale UNA vez para todas", async () => {
      const a = await abrirPestana();
      const cicloDeA = a.comenzarCicloDeSesion();
      const barrera = puerta();
      let creadoraVigente = true;
      const retenedor = a.conCerrojoDeSesion(async () => {
        await barrera.promesa;
        creadoraVigente = false; // la petición que ABRIÓ el vuelo ya es antigua
      });
      const deps = dependencias(async () => ({ accessToken: tokenDe("uA"), csrfToken: "x", user: perfilDe("uA"), mustChangePassword: false }));

      const creadora = a.renovarUnaSolaVez(deps, () => creadoraVigente && a.cicloActual() === cicloDeA);
      const unida = a.renovarUnaSolaVez(deps, () => a.cicloActual() === cicloDeA); // vigente
      barrera.abrir();
      await retenedor;

      const [r1, r2] = await Promise.all([creadora, unida]);
      expect(r1, "una petición antigua no cancela la renovación que otra vigente necesita").toMatchObject({ tipo: "renovada" });
      expect(r2).toBe(r1);
      expect(deps.pedirRenovacion, "UNA sola petición al servidor").toHaveBeenCalledTimes(1);
    });
  });
});

/**
 * A1 (corrección) — el cierre exige la identidad COMPLETA en la misma sección
 * crítica. El coordinador solo conoce el ciclo; el usuario lo aporta el
 * llamador con `identidadCorresponde`.
 */
describe("cerrarSiCicloVigente con identidad completa", () => {
  beforeEach(() => {
    instalarCerrojos();
    instalarCanal();
  });

  it("mismo ciclo pero OTRO usuario: no cierra", async () => {
    const a = await abrirPestana();
    const ciclo = a.comenzarCicloDeSesion();
    const cerrar = vi.fn();

    await expect(a.cerrarSiCicloVigente(ciclo, cerrar, () => false)).resolves.toBe(false);

    expect(cerrar).not.toHaveBeenCalled();
  });

  it("mismo ciclo y mismo usuario: cierra", async () => {
    const a = await abrirPestana();
    const ciclo = a.comenzarCicloDeSesion();
    const cerrar = vi.fn();

    await expect(a.cerrarSiCicloVigente(ciclo, cerrar, () => true)).resolves.toBe(true);

    expect(cerrar).toHaveBeenCalledTimes(1);
  });

  it("el usuario se evalúa DENTRO de la sección crítica, después de esperar el cerrojo", async () => {
    const a = await abrirPestana();
    const ciclo = a.comenzarCicloDeSesion();
    let usuario = "uA";
    const barrera = puerta();
    const retenedor = a.conCerrojoDeSesion(async () => {
      await barrera.promesa;
      usuario = "uB"; // otro usuario, MISMO ciclo, mientras se esperaba
    });
    const cerrar = vi.fn();

    const cierre = a.cerrarSiCicloVigente(ciclo, cerrar, () => usuario === "uA");
    barrera.abrir();
    await retenedor;

    await expect(cierre).resolves.toBe(false);
    expect(cerrar, "se decidió con el usuario de AHORA, no con el de cuando se pidió").not.toHaveBeenCalled();
  });

  it("si el ciclo ya no es el esperado, ni siquiera se consulta al usuario", async () => {
    const a = await abrirPestana();
    const antiguo = a.comenzarCicloDeSesion();
    a.comenzarCicloDeSesion();
    const usuario = vi.fn(() => true);

    await expect(a.cerrarSiCicloVigente(antiguo, vi.fn(), usuario)).resolves.toBe(false);

    expect(usuario).not.toHaveBeenCalled();
  });
});
