/**
 * Las 8 rutas JSON con listas (SEC-01), por HTTP (`app.inject`) pero SIN base de datos.
 *
 * SIMULADO: la autenticación (`rbac.middleware`) y los servicios de negocio están sustituidos. Los
 * servicios son espías que registran cualquier llamada, así que «ninguna función de negocio se
 * llamó tras el rechazo» es una afirmación sobre el código real de las rutas y los esquemas.
 * Lo observado con la autenticación real y la base real está en `listas-json.integration.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { appConRutas } from "./helpers/app-rutas";
import { LIMITES_CUERPO_JSON, LIMITES_LISTAS } from "../src/shared/limites-listas";
import { relayRegistrationsRoutes } from "../src/modules/relay-registrations/relay-registrations.routes";
import { swimmerAssignmentRoutes } from "../src/modules/swimmer-assignment/assignment.routes";
import { clubsRoutes } from "../src/modules/clubs/clubs.routes";
import { competitionsRoutes } from "../src/modules/competitions/competitions.routes";

const sim = vi.hoisted(() => {
  const espias = new Map<string, { mock: { calls: unknown[][] } }>();
  /** Un módulo de servicio donde CUALQUIER función pedida es un espía compartido. */
  const servicio = () =>
    new Proxy({} as Record<string, unknown>, {
      has: () => true,
      get(_destino, nombre) {
        if (typeof nombre === "symbol" || nombre === "then" || nombre === "__esModule") return undefined;
        let espia = espias.get(nombre);
        if (!espia) {
          espia = vi.fn(async (..._argumentos: unknown[]) => ({ ok: true }));
          espias.set(nombre, espia);
        }
        return espia;
      },
    });
  const requireAuth = vi.fn(async (req: { authUser?: unknown }) => {
    req.authUser = { sub: "usuario-sintetico", ownerType: "user", personId: null, clubId: null, roles: ["admin"], permissions: [] };
  });
  return { espias, servicio, requireAuth };
});

vi.mock("../src/modules/auth/rbac.middleware", () => ({
  requireAuth: sim.requireAuth,
  requirePermission: () => async () => undefined,
  requireRole: () => async () => undefined,
}));
vi.mock("../src/modules/relay-registrations/relay-registrations.service", () => sim.servicio());
vi.mock("../src/modules/swimmer-assignment/assignment.service", () => sim.servicio());
vi.mock("../src/modules/clubs/clubs.service", () => sim.servicio());
vi.mock("../src/modules/competitions/competitions.service", () => sim.servicio());
vi.mock("../src/modules/competitions/competition-structure.service", () => sim.servicio());
vi.mock("../src/modules/competitions/competition-events.service", () => sim.servicio());

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const uuids = (cantidad: number) => Array.from({ length: cantidad }, (_, i) => uuid(i + 1));
const llamadasDeNegocio = () => [...sim.espias].filter(([, espia]) => espia.mock.calls.length > 0).map(([nombre]) => nombre);

interface RutaConLista {
  nombre: string;
  metodo: "POST" | "PUT";
  url: string;
  plugin: Parameters<typeof appConRutas>[0][number];
  /** Cuerpo válido con la lista indicada. */
  cuerpo: (lista: unknown, campo?: string) => Record<string, unknown>;
  campos: string[];
  tope: (campo: string) => number;
  limiteDelCuerpo: number;
}

const baseClub = { name: "Club Sintético", code: "SINT", hasLegalStatus: false, isAchmnMember: false, isFchmnMember: false, isFchmnCollaborator: false };

const RUTAS: RutaConLista[] = [
  {
    nombre: "crear inscripción de relevo",
    metodo: "POST",
    url: "/relay-registrations",
    plugin: relayRegistrationsRoutes,
    cuerpo: (lista) => ({ competitionEventId: uuid(900), clubId: uuid(901), personIds: lista }),
    campos: ["personIds"],
    tope: () => LIMITES_LISTAS.integrantesDeRelevo,
    limiteDelCuerpo: LIMITES_CUERPO_JSON.relevos,
  },
  {
    nombre: "editar inscripción de relevo",
    metodo: "PUT",
    url: `/relay-registrations/${uuid(800)}`,
    plugin: relayRegistrationsRoutes,
    cuerpo: (lista) => ({ personIds: lista }),
    campos: ["personIds"],
    tope: () => LIMITES_LISTAS.integrantesDeRelevo,
    limiteDelCuerpo: LIMITES_CUERPO_JSON.relevos,
  },
  {
    nombre: "asignación masiva",
    metodo: "POST",
    url: "/swimmer-assignments/bulk-assign",
    plugin: swimmerAssignmentRoutes,
    cuerpo: (lista) => ({ targetClubId: uuid(900), personIds: lista }),
    campos: ["personIds"],
    tope: () => LIMITES_LISTAS.asignacionMasiva,
    limiteDelCuerpo: LIMITES_CUERPO_JSON.asignacionMasiva,
  },
  {
    nombre: "crear club",
    metodo: "POST",
    url: "/clubs",
    plugin: clubsRoutes,
    cuerpo: (lista, campo = "delegatePersonIds") => ({ ...baseClub, [campo]: lista }),
    campos: ["delegatePersonIds", "coachPersonIds"],
    tope: (campo) => (campo === "delegatePersonIds" ? LIMITES_LISTAS.delegadosPorClub : LIMITES_LISTAS.entrenadoresPorClub),
    limiteDelCuerpo: LIMITES_CUERPO_JSON.clubes,
  },
  {
    nombre: "editar club",
    metodo: "PUT",
    url: `/clubs/${uuid(800)}`,
    plugin: clubsRoutes,
    cuerpo: (lista, campo = "delegatePersonIds") => ({ hasLegalStatus: false, [campo]: lista }),
    campos: ["delegatePersonIds", "coachPersonIds"],
    tope: (campo) => (campo === "delegatePersonIds" ? LIMITES_LISTAS.delegadosPorClub : LIMITES_LISTAS.entrenadoresPorClub),
    limiteDelCuerpo: LIMITES_CUERPO_JSON.clubes,
  },
  {
    nombre: "agregar prueba a la competencia",
    metodo: "POST",
    url: `/competitions/${uuid(800)}/events`,
    plugin: competitionsRoutes,
    cuerpo: (lista) => ({ eventId: uuid(900), competitionSessionId: uuid(901), categoryIds: lista }),
    campos: ["categoryIds"],
    tope: () => LIMITES_LISTAS.categoriasPorPrueba,
    limiteDelCuerpo: LIMITES_CUERPO_JSON.categoriasPorPrueba,
  },
  {
    nombre: "editar prueba de la competencia",
    metodo: "PUT",
    url: `/competition-events/${uuid(800)}`,
    plugin: competitionsRoutes,
    cuerpo: (lista) => ({ categoryIds: lista }),
    campos: ["categoryIds"],
    tope: () => LIMITES_LISTAS.categoriasPorPrueba,
    limiteDelCuerpo: LIMITES_CUERPO_JSON.categoriasPorPrueba,
  },
  {
    nombre: "reordenar pruebas",
    metodo: "PUT",
    url: "/competition-events/reorder",
    plugin: competitionsRoutes,
    cuerpo: (lista) => ({ updates: lista }),
    campos: ["updates"],
    tope: () => LIMITES_LISTAS.reordenamientos,
    limiteDelCuerpo: LIMITES_CUERPO_JSON.reordenamientos,
  },
];

/** Una lista de `n` elementos válidos para el campo (los reordenamientos son objetos, las demás UUID). */
const listaValida = (campo: string, n: number) => (campo === "updates" ? Array.from({ length: n }, (_, i) => ({ id: uuid(i + 1), displayOrder: i + 1 })) : uuids(n));
const listaInvalida = (campo: string, n: number) => (campo === "updates" ? Array.from({ length: n }, () => ({ id: "x", displayOrder: "y" })) : Array.from({ length: n }, () => "no-es-uuid"));

let apps: Map<unknown, FastifyInstance>;

beforeEach(() => {
  sim.espias.clear();
  sim.requireAuth.mockClear();
  apps = new Map();
});

async function appDe(ruta: RutaConLista) {
  const existente = apps.get(ruta.plugin);
  if (existente) return existente;
  const app = await appConRutas([ruta.plugin]);
  apps.set(ruta.plugin, app);
  return app;
}

async function enviar(ruta: RutaConLista, cuerpo: unknown) {
  const app = await appDe(ruta);
  return app.inject({ method: ruta.metodo, url: ruta.url, headers: { "content-type": "application/json" }, payload: JSON.stringify(cuerpo) });
}

describe.each(RUTAS)("$metodo $url ($nombre)", (ruta) => {
  describe.each(ruta.campos)("lista %s", (campo) => {
    const tope = ruta.tope(campo);

    it("en el tope exacto con elementos válidos: llega al servicio (límite válido)", async () => {
      const res = await enviar(ruta, ruta.cuerpo(listaValida(campo, tope), campo));

      expect(res.statusCode).toBeLessThan(400);
      expect(llamadasDeNegocio()).toHaveLength(1);
    });

    it("tope + 1 con elementos válidos: 400, un único error, el servicio NO se llama", async () => {
      const res = await enviar(ruta, ruta.cuerpo(listaValida(campo, tope + 1), campo));

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("VALIDATION_ERROR");
      expect(res.json().details.fieldErrors[campo]).toHaveLength(1);
      expect(llamadasDeNegocio()).toEqual([]);
    });

    it("tope + 1 con elementos INVÁLIDOS: sigue siendo un único error y la respuesta queda acotada", async () => {
      const res = await enviar(ruta, ruta.cuerpo(listaInvalida(campo, tope + 1), campo));

      expect(res.statusCode).toBe(400);
      expect(res.json().details.fieldErrors[campo]).toHaveLength(1);
      expect(res.body.length).toBeLessThan(1_000);
      expect(llamadasDeNegocio()).toEqual([]);
    });

    it("dentro del tope con un elemento inválido: 400 por elemento, como siempre, sin llegar al servicio", async () => {
      const lista = listaValida(campo, 2);
      const invalida = [...lista.slice(0, 1), ...listaInvalida(campo, 1)];
      const res = await enviar(ruta, ruta.cuerpo(invalida, campo));

      expect(res.statusCode).toBe(400);
      expect(res.json().details.fieldErrors[campo]).toBeDefined();
      expect(llamadasDeNegocio()).toEqual([]);
    });
  });

  describe("límite del cuerpo (bodyLimit de la ruta)", () => {
    /** Un cuerpo JSON válido de exactamente `bytes` bytes (relleno en un campo ajeno al esquema). */
    const cuerpoDeBytes = (bytes: number) => {
      const vacio = JSON.stringify({ relleno: "" });
      return JSON.stringify({ relleno: "a".repeat(bytes - Buffer.byteLength(vacio)) });
    };

    it("un cuerpo de límite + 1 bytes recibe 413 y NI SIQUIERA se autentica", async () => {
      const app = await appDe(ruta);
      const payload = cuerpoDeBytes(ruta.limiteDelCuerpo + 1);
      expect(Buffer.byteLength(payload)).toBe(ruta.limiteDelCuerpo + 1);

      const res = await app.inject({ method: ruta.metodo, url: ruta.url, headers: { "content-type": "application/json" }, payload });

      expect(res.statusCode).toBe(413);
      expect(res.body.length).toBeLessThan(400);
      expect(sim.requireAuth).not.toHaveBeenCalled();
      expect(llamadasDeNegocio()).toEqual([]);
    });

    it("un cuerpo de exactamente el límite NO recibe 413: pasa por la autenticación y llega a la validación", async () => {
      const app = await appDe(ruta);
      const payload = cuerpoDeBytes(ruta.limiteDelCuerpo);
      expect(Buffer.byteLength(payload)).toBe(ruta.limiteDelCuerpo);

      const res = await app.inject({ method: ruta.metodo, url: ruta.url, headers: { "content-type": "application/json" }, payload });

      expect(res.statusCode).not.toBe(413);
      expect(sim.requireAuth).toHaveBeenCalledTimes(1);
    });

    it("el peor caso legítimo (lista en su tope) cabe en el límite del cuerpo", () => {
      for (const campo of ruta.campos) {
        const bytes = Buffer.byteLength(JSON.stringify(ruta.cuerpo(listaValida(campo, ruta.tope(campo)), campo)));
        expect(bytes).toBeLessThanOrEqual(ruta.limiteDelCuerpo);
      }
    });
  });
});

describe("los límites del cuerpo aprobados", () => {
  it("coinciden con lo autorizado", () => {
    expect(LIMITES_CUERPO_JSON).toEqual({
      relevos: 4 * 1024,
      asignacionMasiva: 512 * 1024,
      clubes: 32 * 1024,
      categoriasPorPrueba: 16 * 1024,
      reordenamientos: 256 * 1024,
    });
  });
});
