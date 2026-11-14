/**
 * ACCESOS POR ROL — catálogo y evaluación, como funciones puras (sin base de datos).
 *
 *  - El catálogo es coherente: identificadores únicos, acciones con su menú, agrupación completa.
 *  - Su techo no supera la matriz real del código (`rbac.definitions.ts`): cada rol al que una
 *    función APLICA ya tiene el permiso que exige cada una de sus rutas.
 *  - Team Manager queda fuera del catálogo y sus rutas no llevan guarda de función.
 *  - La evaluación suma roles, respeta a administración y a los roles no configurables, aplica la
 *    regla jerárquica menú → acción y nunca concede lo que no aplica.
 *  - La validación rechaza roles, funciones y combinaciones fuera del catálogo.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGO, GRUPOS, NO_CONFIGURABLES, ROLES_CONFIGURABLES, aplica, celdasConfigurables } from "../src/modules/accesos/catalogo";
import { evaluarFuncion, evaluarAlgunaFuncion, funcionesDeshabilitadas, validarValores, type ConfiguracionVigente } from "../src/modules/accesos/accesos.service";
import { ROLES } from "../src/modules/auth/rbac.definitions";

const sin = (version = 0): ConfiguracionVigente => ({ version, deshabilitadas: new Set() });
const con = (...claves: string[]): ConfiguracionVigente => ({ version: 1, deshabilitadas: new Set(claves) });

describe("catálogo", () => {
  it("identificadores únicos y estables, con menú válido en cada acción", () => {
    const ids = CATALOGO.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of CATALOGO) {
      expect(f.id).toMatch(/^[a-z_]+\.[a-z_]+$/);
      if (f.menu !== null) {
        const menu = CATALOGO.find((m) => m.id === f.menu);
        expect(menu, `${f.id} → ${f.menu}`).toBeDefined();
        expect(menu!.menu, `${f.menu} debe ser un menú`).toBeNull();
        // Una acción no puede aplicar a un rol al que su menú no aplica.
        for (const r of f.aplicaA) expect(menu!.aplicaA, `${f.id} en ${r}`).toContain(r);
      }
    }
  });

  it("la agrupación de la pantalla cubre cada función exactamente una vez", () => {
    const agrupadas = GRUPOS.flatMap((g) => [...(g.menu ? [g.menu] : []), ...g.acciones]);
    expect([...agrupadas].sort()).toEqual(CATALOGO.map((f) => f.id).sort());
  });

  it("el techo no supera la matriz del código: cada rol que aplica ya tiene el permiso de cada ruta", () => {
    for (const f of CATALOGO) {
      for (const ruta of f.rutas) {
        if (ruta.permiso.startsWith("(")) continue; // la sesión propia: no es un permiso
        for (const rol of f.aplicaA) expect(ROLES[rol], `${f.id} ${ruta.metodo} ${ruta.ruta} en ${rol}`).toContain(ruta.permiso);
      }
    }
  });

  it("los roles configurables son exactamente nadador, delegado y entrenador", () => {
    expect([...ROLES_CONFIGURABLES]).toEqual(["swimmer", "delegate", "coach"]);
  });

  it("«No aplica» donde el rol no tiene la función hoy", () => {
    expect(aplica("relevos.armar", "swimmer")).toBe(false);
    expect(aplica("relevos.editar", "swimmer")).toBe(false);
    expect(aplica("relevos.cancelar", "swimmer")).toBe(false);
    expect(aplica("relevos.historial", "swimmer")).toBe(true);
    expect(aplica("menu.incorporaciones", "swimmer")).toBe(false);
    expect(aplica("incorporaciones.postular", "swimmer")).toBe(false);
    expect(aplica("cuenta.cambio_voluntario_contrasena", "swimmer")).toBe(true);
    expect(celdasConfigurables().some((c) => c.rol === "swimmer" && c.funcion === "relevos.armar")).toBe(false);
  });

  it("Team Manager queda FUERA: ni en el catálogo ni con guarda de función en sus rutas", () => {
    for (const f of CATALOGO) {
      expect(f.id).not.toMatch(/team/i);
      for (const r of f.rutas) expect(r.ruta).not.toMatch(/team-manager/);
    }
    expect(NO_CONFIGURABLES.map((n) => n.id)).toEqual(["reportes.team_manager"]);
    expect(NO_CONFIGURABLES[0]!.nota).toBe("No configurable: conserva sus permisos actuales.");
    const fuente = readFileSync(join(__dirname, "../src/modules/team-manager-export/team-manager-export.routes.ts"), "utf8");
    expect(fuente).not.toMatch(/requireFuncion|accesos\.middleware/);
  });

  it("cerrar sesión, /auth/me, /auth/refresh y /auth/csrf no llevan guarda de función", () => {
    const fuente = readFileSync(join(__dirname, "../src/modules/auth/auth.routes.ts"), "utf8");
    const usos = fuente.match(/requireFuncion|verificarFunciones\(/g) ?? [];
    // Solo la comprobación del cambio VOLUNTARIO de contraseña.
    expect(usos).toEqual(["verificarFunciones("]);
    expect(fuente).toMatch(/if \(req\.authState\?\.mustChangePassword\) return;/);
  });
});

describe("evaluación", () => {
  it("sin restricciones, todo lo que aplica está permitido y nada se deniega", () => {
    for (const rol of ["swimmer", "delegate", "coach", "club", "legal_representative"]) {
      expect(funcionesDeshabilitadas([rol], sin())).toEqual([]);
    }
  });

  it("administración: permitida siempre, aunque tenga otros roles y todas las casillas apagadas", () => {
    const todo = con(...celdasConfigurables().map((c) => `${c.rol}:${c.funcion}`));
    for (const f of CATALOGO) expect(evaluarFuncion(f.id, ["admin", "delegate", "swimmer"], todo)).toBe("permitida");
  });

  it("cada rol configurable: acción apagada → denegada; restituida → permitida", () => {
    expect(evaluarFuncion("reportes.exportar", ["swimmer"], con("swimmer:reportes.exportar"))).toBe("denegada");
    expect(evaluarFuncion("reportes.exportar", ["delegate"], con("delegate:reportes.exportar"))).toBe("denegada");
    expect(evaluarFuncion("reportes.exportar", ["coach"], con("coach:reportes.exportar"))).toBe("denegada");
    expect(evaluarFuncion("reportes.exportar", ["coach"], sin(2))).toBe("permitida");
  });

  it("menú apagado: sus acciones quedan denegadas sin tocar sus casillas; al encenderlo vuelven", () => {
    const apagado = con("delegate:menu.reportes");
    expect(evaluarFuncion("reportes.generar", ["delegate"], apagado)).toBe("denegada");
    expect(evaluarFuncion("reportes.exportar", ["delegate"], apagado)).toBe("denegada");
    // La casilla de la acción sigue encendida: solo rige mientras el menú esté apagado.
    expect(evaluarFuncion("reportes.generar", ["delegate"], sin())).toBe("permitida");
  });

  it("se SUMAN los roles efectivos: basta que uno lo permita", () => {
    const soloDelegado = con("delegate:inscripciones.crear");
    expect(evaluarFuncion("inscripciones.crear", ["delegate", "swimmer"], soloDelegado)).toBe("permitida");
    expect(evaluarFuncion("inscripciones.crear", ["delegate", "coach"], soloDelegado)).toBe("permitida");
    expect(evaluarFuncion("inscripciones.crear", ["delegate"], soloDelegado)).toBe("denegada");
    expect(evaluarFuncion("inscripciones.crear", ["delegate", "swimmer"], con("delegate:inscripciones.crear", "swimmer:inscripciones.crear"))).toBe("denegada");
  });

  it("un rol al que la función no aplica no suma: nadador + delegado con «Armar» apagado para delegado", () => {
    expect(evaluarFuncion("relevos.armar", ["swimmer", "delegate"], con("delegate:relevos.armar"))).toBe("denegada");
  });

  it("cuenta de club y representante legal conservan sus atribuciones, y suman", () => {
    const todo = con(...celdasConfigurables().map((c) => `${c.rol}:${c.funcion}`));
    for (const f of CATALOGO.filter((x) => x.aplicaA.includes("club"))) {
      expect(evaluarFuncion(f.id, ["club"], todo)).toBe("permitida");
      expect(evaluarFuncion(f.id, ["legal_representative"], todo)).toBe("permitida");
      expect(evaluarFuncion(f.id, ["delegate", "legal_representative"], todo)).toBe("permitida");
    }
  });

  it("nunca concede: sin roles aplicables la guarda no decide (no_aplica)", () => {
    expect(evaluarFuncion("incorporaciones.postular", ["swimmer"], sin())).toBe("no_aplica");
    expect(evaluarFuncion("relevos.armar", ["swimmer"], con("swimmer:menu.relevos"))).toBe("no_aplica");
    expect(evaluarFuncion("reportes.generar", [], sin())).toBe("no_aplica");
  });

  it("club no operativo: sin los roles de personal (ya reducidos), decide el rol que queda", () => {
    // `resolverAutorizacionEfectiva` quitó `delegate`: solo queda `swimmer`.
    expect(evaluarFuncion("reportes.generar", ["swimmer"], con("swimmer:reportes.generar"))).toBe("denegada");
    expect(evaluarFuncion("incorporaciones.postular", ["swimmer"], con("delegate:incorporaciones.postular"))).toBe("no_aplica");
  });

  it("endpoints compartidos: apagar un menú no rompe el otro que usa la misma ruta", () => {
    const sinInscripciones = con("delegate:menu.inscripciones");
    expect(evaluarAlgunaFuncion(["menu.inscripciones", "menu.relevos"], ["delegate"], sinInscripciones).decision).toBe("permitida");
    const ambos = con("delegate:menu.inscripciones", "delegate:menu.relevos");
    expect(evaluarAlgunaFuncion(["menu.inscripciones", "menu.relevos"], ["delegate"], ambos)).toEqual({ decision: "denegada", funcion: "menu.inscripciones" });
  });

  it("cambio voluntario de contraseña apagado: denegado para el rol, no para administración", () => {
    const cfg = con("swimmer:cuenta.cambio_voluntario_contrasena");
    expect(evaluarFuncion("cuenta.cambio_voluntario_contrasena", ["swimmer"], cfg)).toBe("denegada");
    expect(evaluarFuncion("cuenta.cambio_voluntario_contrasena", ["admin"], cfg)).toBe("permitida");
  });

  it("una función fuera del catálogo es un error de programación, no una decisión", () => {
    expect(() => evaluarFuncion("reportes.team_manager", ["delegate"], sin())).toThrow(/fuera del catálogo/);
  });
});

describe("validación del estado enviado", () => {
  const completo = () => {
    const v: Record<string, Record<string, boolean>> = { swimmer: {}, delegate: {}, coach: {} };
    for (const c of celdasConfigurables()) v[c.rol]![c.funcion] = true;
    return v;
  };

  it("acepta el estado completo y devuelve las apagadas", () => {
    const v = completo();
    v.coach!["reportes.exportar"] = false;
    expect([...validarValores(v)]).toEqual(["coach:reportes.exportar"]);
  });

  it("rechaza roles no configurables, funciones ajenas, combinaciones que no aplican y huecos", () => {
    expect(() => validarValores({ ...completo(), admin: {} })).toThrow(/no es válida/);
    expect(() => validarValores({ ...completo(), club: { "reportes.generar": false } })).toThrow(/no es válida/);
    const ajena = completo();
    ajena.delegate!["reportes.team_manager"] = false;
    expect(() => validarValores(ajena)).toThrow(/no es válida/);
    const noAplica = completo();
    noAplica.swimmer!["relevos.armar"] = false;
    expect(() => validarValores(noAplica)).toThrow(/no es válida/);
    const hueco = completo();
    delete hueco.delegate!["inscripciones.crear"];
    expect(() => validarValores(hueco)).toThrow(/no es válida/);
    const noBooleano = completo() as Record<string, Record<string, unknown>>;
    noBooleano.coach!["reportes.generar"] = "no";
    expect(() => validarValores(noBooleano)).toThrow(/no es válida/);
    expect(() => validarValores(null)).toThrow();
    expect(() => validarValores([])).toThrow();
  });
});
