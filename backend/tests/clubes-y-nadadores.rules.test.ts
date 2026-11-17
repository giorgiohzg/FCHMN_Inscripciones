/**
 * Reporte «Clubes y nadadores»: reglas puras (grupos, revisión, planillas y páginas del PDF).
 * Todos los datos son SINTÉTICOS.
 */
import { describe, it, expect } from "vitest";
import {
  armarReporte,
  gruposEnOrden,
  csvDelReporte,
  ENCABEZADOS,
  ETIQUETA_REVISION,
  ETIQUETA_SIN_CLUB,
  filasDelReporte,
  LecturaIncoherente,
  nombreDelReporte,
  paginarPdf,
  TEXTO_CLUB_SIN_NADADORES,
  type LineaDelPdf,
  type PersonaDelReporte,
} from "../src/modules/reports/clubesYNadadores.rules";

let secuencia = 0;
function persona(p: Partial<PersonaDelReporte> & { fullName: string }): PersonaDelReporte {
  secuencia++;
  return {
    personId: p.personId ?? `p-${String(secuencia).padStart(4, "0")}`,
    run: p.run ?? `9${String(secuencia).padStart(7, "0")}`,
    firstName: p.firstName ?? null,
    paternalLastName: p.paternalLastName ?? null,
    maternalLastName: p.maternalLastName ?? null,
    fullName: p.fullName,
  };
}

const club = (id: string, name: string, code: string, status: "active" | "locked" | "disabled" = "active") => ({ id, name, code, status });
const en = (c: { id: string; name: string; code: string }, p: PersonaDelReporte, eliminado = false) => ({
  clubId: c.id,
  club: { name: c.name, code: c.code, eliminado },
  persona: p,
});

describe("nombreDelReporte", () => {
  it("usa los campos separados: PATERNO MATERNO, NOMBRE", () => {
    expect(
      nombreDelReporte({ fullName: "Ana Sintética Ejemplo", firstName: "Ana", paternalLastName: "Sintética", maternalLastName: "Ejemplo" })
    ).toBe("SINTÉTICA EJEMPLO, ANA");
  });
  it("registro histórico incompleto: el nombre completo almacenado, sin coma ni apellidos inventados", () => {
    expect(
      nombreDelReporte({ fullName: "María del Carmen Pérez Soto", firstName: null, paternalLastName: null, maternalLastName: null })
    ).toBe("MARÍA DEL CARMEN PÉREZ SOTO");
  });
});

describe("armarReporte", () => {
  const beta = club("c-b", "Beta", "BET");
  const alamo = club("c-a", "Álamo", "ALA", "locked");
  const vacio = club("c-v", "Vacío", "VAC");
  const eliminadoZ = { id: "c-z", name: "Zeta Disuelto", code: "ZD" };
  const eliminadoA = { id: "c-y", name: "Antiguo Disuelto", code: "AD" };

  it("clubes por nombre (con tildes), también vacíos; nadadores por apellidos; sin club y revisión aparte", () => {
    const r = armarReporte({
      clubes: [beta, alamo, vacio],
      membresiasActivas: [
        en(beta, persona({ fullName: "Zoe Ñuñez", firstName: "Zoe", paternalLastName: "Ñuñez" })),
        en(beta, persona({ fullName: "Ana Avila", firstName: "Ana", paternalLastName: "Ávila", maternalLastName: "Soto" })),
        en(beta, persona({ fullName: "Histórico Sin Campos" })),
        en(alamo, persona({ fullName: "Uno Solo", firstName: "Uno", paternalLastName: "Solo" })),
        en(eliminadoZ, persona({ fullName: "Rita Zeta", firstName: "Rita", paternalLastName: "Zeta" }), true),
        en(eliminadoA, persona({ fullName: "Ivo Antiguo", firstName: "Ivo", paternalLastName: "Antiguo" }), true),
        en(eliminadoZ, persona({ fullName: "Ada Arce", firstName: "Ada", paternalLastName: "Arce" }), true),
      ],
      sinClub: [persona({ fullName: "Sin Club", firstName: "Sin", paternalLastName: "Club" })],
    });
    expect(r.clubes.map((c) => c.clubName)).toEqual(["Álamo", "Beta", "Vacío"]);
    expect(r.clubes[1]!.nadadores.map((n) => n.nombre)).toEqual(["ÁVILA SOTO, ANA", "ÑUÑEZ, ZOE", "HISTÓRICO SIN CAMPOS"]);
    expect(r.clubes[2]!.nadadores).toEqual([]);
    expect(r.sinClub.map((n) => n.nombre)).toEqual(["CLUB, SIN"]);
    // Revisión: por nombre del club eliminado; personas por apellidos; no van a «sin club».
    expect(r.revision.map((g) => [g.clubName, g.personas.map((p) => p.nombre)])).toEqual([
      ["Antiguo Disuelto", ["ANTIGUO, IVO"]],
      ["Zeta Disuelto", ["ARCE, ADA", "ZETA, RITA"]],
    ]);
    // Los totales distinguen los tres grupos y suman exactamente las personas recibidas.
    expect(r.totales).toEqual({ clubes: 3, nadadoresConClub: 4, sinClub: 1, enClubesEliminados: 3 });
  });

  it("homónimos completos: desempata el RUN y el orden no depende del de entrada", () => {
    const a = persona({ fullName: "Ana Prueba", firstName: "Ana", paternalLastName: "Prueba", run: "11111111" });
    const b = persona({ fullName: "Ana Prueba", firstName: "Ana", paternalLastName: "Prueba", run: "22222222" });
    const r1 = armarReporte({ clubes: [vacio], membresiasActivas: [a, b].map((p) => en(vacio, p)), sinClub: [] });
    const r2 = armarReporte({ clubes: [vacio], membresiasActivas: [b, a].map((p) => en(vacio, p)), sinClub: [] });
    expect(r1.clubes[0]!.nadadores.map((n) => n.personId)).toEqual([a.personId, b.personId]);
    expect(r2.clubes[0]!.nadadores.map((n) => n.personId)).toEqual([a.personId, b.personId]);
  });

  it("una lectura incoherente se rechaza en vez de corregirse en silencio", () => {
    const p = persona({ fullName: "Repetida Prueba", firstName: "Repetida", paternalLastName: "Prueba" });
    expect(() => armarReporte({ clubes: [beta], membresiasActivas: [en(beta, p), en(beta, p)], sinClub: [] })).toThrow(LecturaIncoherente);
    expect(() => armarReporte({ clubes: [beta], membresiasActivas: [en(beta, p)], sinClub: [p] })).toThrow(LecturaIncoherente);
    expect(() => armarReporte({ clubes: [beta], membresiasActivas: [en(eliminadoZ, p, true)], sinClub: [p] })).toThrow(LecturaIncoherente);
    // Un club que no está en la lectura y que tampoco figura como eliminado.
    expect(() => armarReporte({ clubes: [beta], membresiasActivas: [en(vacio, p)], sinClub: [] })).toThrow(LecturaIncoherente);
  });
});

describe("orden de las secciones: clubes, revisión y «Sin club asignado» SIEMPRE al final", () => {
  const alfa = club("c-a", "Alfa", "ALF");
  const omega = club("c-o", "Omega", "OME");
  const disueltoB = { id: "c-db", name: "Beta Disuelto", code: "BD" };
  const disueltoZ = { id: "c-dz", name: "Zulú Disuelto", code: "ZD" };
  const entrada = {
    clubes: [omega, alfa],
    membresiasActivas: [
      en(alfa, persona({ fullName: "Ana Uno", firstName: "Ana", paternalLastName: "Uno" })),
      en(omega, persona({ fullName: "Omar Dos", firstName: "Omar", paternalLastName: "Dos" })),
      en(disueltoZ, persona({ fullName: "Zoe Tres", firstName: "Zoe", paternalLastName: "Tres" }), true),
      en(disueltoB, persona({ fullName: "Bea Cuatro", firstName: "Bea", paternalLastName: "Cuatro" }), true),
    ],
    sinClub: [
      persona({ fullName: "Sol Cinco", firstName: "Sol", paternalLastName: "Cinco" }),
      persona({ fullName: "Luz Seis", firstName: "Luz", paternalLastName: "Seis" }),
    ],
  };
  const r = armarReporte(entrada);

  it("gruposEnOrden: clubes por nombre, luego la revisión por club eliminado y al final «Sin club asignado»", () => {
    expect(gruposEnOrden(r).map((g) => [g.tipo, g.titulo])).toEqual([
      ["club", "Alfa"],
      ["club", "Omega"],
      ["revision", "Beta Disuelto"],
      ["revision", "Zulú Disuelto"],
      ["sinClub", ETIQUETA_SIN_CLUB],
    ]);
  });

  it("las planillas siguen el mismo orden y la última sección es «Sin club asignado»", () => {
    const secciones = filasDelReporte(r).map((f) => f[0]);
    expect(secciones).toEqual(["Club", "Club", ETIQUETA_REVISION, ETIQUETA_REVISION, ETIQUETA_SIN_CLUB, ETIQUETA_SIN_CLUB]);
    expect(csvDelReporte(r).split("\r\n").at(-1)).toBe(`${ETIQUETA_SIN_CLUB},,,2,"SEIS, LUZ"`);
  });

  it("el PDF también termina con «Sin club asignado», tras la revisión", () => {
    const encabezados = paginarPdf(r, { altoPrimera: 1000, alto: 1000, medir: () => 10 })
      .flat()
      .filter((l) => l.linea.tipo === "encabezado")
      .map((l) => l.linea.texto);
    expect(encabezados.at(-1)).toBe(`${ETIQUETA_SIN_CLUB} — 2 persona(s)`);
    expect(encabezados.at(-2)).toMatch(/^Revisión — club eliminado: Zulú Disuelto/);
  });

  it("el orden no pierde ni duplica personas y no cambia los totales", () => {
    const personas = gruposEnOrden(r).flatMap((g) => g.personas.map((p) => p.personId));
    const esperadas = [...entrada.membresiasActivas.map((m) => m.persona.personId), ...entrada.sinClub.map((p) => p.personId)];
    expect([...personas].sort()).toEqual([...esperadas].sort());
    expect(new Set(personas).size).toBe(personas.length);
    expect(r.totales).toEqual({ clubes: 2, nadadoresConClub: 2, sinClub: 2, enClubesEliminados: 2 });
  });
});

describe("filasDelReporte y CSV", () => {
  const c1 = club("c1", "=HYPERLINK(1)", "X1");
  const c2 = club("c2", "Club Vacío", "CV");
  const disuelto = { id: "c9", name: "Club Disuelto", code: "DIS" };
  const r = armarReporte({
    clubes: [c1, c2],
    membresiasActivas: [
      en(c1, persona({ fullName: "B Prueba", firstName: "B", paternalLastName: "Prueba" })),
      en(c1, persona({ fullName: "A Prueba", firstName: "+A", paternalLastName: "Prueba" })),
      en(disuelto, persona({ fullName: "Inés Ñuñoa", firstName: "Inés", paternalLastName: "Ñuñoa" }), true),
    ],
    sinClub: [],
  });

  it("una fila por persona con su sección; vacíos con su fila; revisión con el club eliminado", () => {
    expect(filasDelReporte(r)).toEqual([
      ["Club", "=HYPERLINK(1)", "X1", "1", "PRUEBA, +A"],
      ["Club", "=HYPERLINK(1)", "X1", "2", "PRUEBA, B"],
      ["Club", "Club Vacío", "CV", "", TEXTO_CLUB_SIN_NADADORES],
      [ETIQUETA_REVISION, "Club Disuelto", "DIS", "1", "ÑUÑOA, INÉS"],
      [ETIQUETA_SIN_CLUB, "", "", "", TEXTO_CLUB_SIN_NADADORES],
    ]);
  });

  it("el CSV neutraliza las fórmulas y escapa los valores", () => {
    const lineas = csvDelReporte(r).split("\r\n");
    expect(lineas[0]).toBe(ENCABEZADOS.join(","));
    expect(lineas[1]).toBe(`Club,'=HYPERLINK(1),X1,1,"PRUEBA, +A"`);
    expect(lineas).toHaveLength(6);
  });
});

describe("paginarPdf por altura real", () => {
  // Medida sintética: encabezado 30 (45 si es largo); línea 15 (30 si es larga, como un nombre que ocupa dos renglones).
  const medir = (l: LineaDelPdf) => (l.tipo === "encabezado" ? (l.texto.length > 60 ? 45 : 30) : l.texto.length > 40 ? 30 : 15);
  const muchos = (n: number, prefijo: string, largoCada = 0) =>
    Array.from({ length: n }, (_, i) =>
      persona({
        fullName: `${prefijo}${i}`,
        firstName:
          largoCada && i % largoCada === 0
            ? `Nombre muy largo número ${String(i).padStart(3, "0")} de prueba`
            : `N${String(i).padStart(3, "0")}`,
        paternalLastName: prefijo,
      })
    );
  const grande = club("c1", "Club Grande con un nombre suficientemente largo para ocupar dos líneas", "GR");
  const chico = club("c2", "Chico", "CH");
  const vacio = club("c3", "Vacio", "VA");
  const disuelto = { id: "c9", name: "Disuelto", code: "DI" };
  const r = armarReporte({
    clubes: [grande, chico, vacio],
    membresiasActivas: [
      ...muchos(23, "Grande", 3).map((p) => en(grande, p)),
      ...muchos(3, "Chico").map((p) => en(chico, p)),
      ...muchos(2, "Disuelto").map((p) => en(disuelto, p, true)),
    ],
    sinClub: muchos(2, "Libre"),
  });
  const opciones = { altoPrimera: 140, alto: 160, medir };
  const paginas = paginarPdf(r, opciones);

  it("no omite ni repite a nadie, y ninguna página supera su altura", () => {
    const personas = paginas.flat().filter((l) => l.linea.tipo === "nadador");
    expect(personas).toHaveLength(23 + 3 + 2 + 2);
    paginas.forEach((p, i) => {
      const usado = p.reduce((s, l) => s + l.alto, 0);
      expect(usado).toBeLessThanOrEqual(i === 0 ? opciones.altoPrimera : opciones.alto);
      expect(p.every((l) => l.alto === medir(l.linea))).toBe(true);
    });
  });

  it("cada página siguiente empieza con un encabezado y ninguno queda solo al pie", () => {
    expect(paginas.length).toBeGreaterThan(3);
    for (const p of paginas.slice(1)) expect(p[0]!.linea.tipo).toBe("encabezado");
    for (const p of paginas) expect(p[p.length - 1]!.linea.tipo).not.toBe("encabezado");
    const continuaciones = paginas.flat().filter((l) => l.linea.tipo === "encabezado" && l.linea.continuacion);
    expect(continuaciones.length).toBeGreaterThan(0);
    expect(continuaciones.every((l) => l.linea.texto.endsWith("(continuación)"))).toBe(true);
  });

  it("los encabezados normales aparecen una vez por grupo, en orden, con «Sin club asignado» al final", () => {
    const encabezados = paginas
      .flat()
      .filter((l) => l.linea.tipo === "encabezado" && !l.linea.continuacion)
      .map((l) => l.linea.texto);
    expect(encabezados).toEqual([
      "Chico (CH) — 3 nadador(es)",
      "Club Grande con un nombre suficientemente largo para ocupar dos líneas (GR) — 23 nadador(es)",
      "Vacio (VA) — 0 nadador(es)",
      "Revisión — club eliminado: Disuelto (DI) — 2 persona(s) con membresía activa",
      `${ETIQUETA_SIN_CLUB} — 2 persona(s)`,
    ]);
  });
});
