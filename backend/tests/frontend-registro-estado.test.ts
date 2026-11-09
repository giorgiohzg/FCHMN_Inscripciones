/**
 * GUARDA DEL CAMPO `estado` DEL REGISTRO DE ACCESO (`fchmn_acceso`).
 *
 * REGRESIÓN QUE VIGILA. `"estado":$status` escribía el código tal cual. Con una respuesta HTTP/0.9 del
 * upstream `$status` vale `009` (y `000` si la petición no llegó a procesarse): `"estado":009` no es JSON
 * válido y la línea entera deja de poder leerse. La plantilla normaliza ahora con un `map`.
 *
 * CÓMO SE COMPRUEBA, sin limitarse a buscar un texto. Se extrae de la PLANTILLA REAL el `map $status
 * $estado_json`, se evalúa con la semántica de Nginx (reglas con `~` en orden de aparición, la primera que
 * coincide gana; si ninguna, `default`) y se arma la línea con el `log_format` real. El resultado debe ser JSON
 * que `JSON.parse` acepte, con `estado` numérico o `null`. Las expresiones usan solo construcciones comunes a
 * PCRE y a JavaScript (aserción de anticipación y captura con nombre).
 *
 * QUÉ NO COMPRUEBA. No ejecuta Nginx: que el `map` procesado por el entrypoint real y por Nginx 1.30.6 produzca
 * lo mismo se comprobó con la imagen candidata y un upstream sintético, fuera de la integración continua (ver el
 * plan de seguridad).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const RAIZ = path.join(__dirname, "..", "..");
const PLANTILLA = readFileSync(path.join(RAIZ, "frontend", "nginx", "default.conf.template"), "utf8").replace(/\r\n/g, "\n");

/** El cuerpo de un bloque `map` por su encabezado exacto. */
function cuerpoDeMap(encabezado: string): string {
  const inicio = PLANTILLA.indexOf(`${encabezado} {`);
  if (inicio < 0) throw new Error(`no hay «${encabezado}»`);
  return PLANTILLA.slice(PLANTILLA.indexOf("{", inicio) + 1, PLANTILLA.indexOf("\n}", inicio));
}

type Regla = { patron: RegExp | null; valor: string };
/** Reglas del `map`, en orden: `default` y las de expresión regular con `~`. */
function reglas(cuerpo: string): Regla[] {
  const r: Regla[] = [];
  for (const linea of cuerpo.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) {
    const m = /^(default|"~(.+)")\s+(\S+?);$/.exec(linea);
    if (!m) throw new Error(`regla no reconocida: ${linea}`);
    r.push({ patron: m[1] === "default" ? null : new RegExp(m[2]!), valor: m[3]! });
  }
  return r;
}

const MAPA = reglas(cuerpoDeMap("map $status $estado_json"));

/** Semántica de Nginx: la primera expresión que coincide; si no, `default`. El valor puede ser una captura con nombre. */
function estadoJson(status: string): string {
  for (const { patron, valor } of MAPA) {
    if (!patron) continue;
    const m = patron.exec(status);
    if (m) return valor.startsWith("$") ? (m.groups?.[valor.slice(1)] ?? "") : valor;
  }
  return MAPA.find((r) => !r.patron)!.valor;
}

/** La línea del `log_format` real, con `$status` reemplazado por el valor de `estado_json` (resto: marcadores fijos). */
function lineaDeRegistro(status: string): string {
  const formato = /log_format fchmn_acceso escape=json\n([\s\S]*?);\n/.exec(PLANTILLA)![1]!;
  const texto = [...formato.matchAll(/'([^']*)'/g)].map((m) => m[1]).join("");
  const valores: Record<string, string> = {
    estado_json: estadoJson(status),
    time_iso8601: "2026-01-01T00:00:00+00:00", remote_addr: "127.0.0.1", http_x_forwarded_for: "", request_method: "GET",
    ruta_original: "/x", server_protocol: "HTTP/1.1", body_bytes_sent: "25", request_time: "0.001", http_user_agent: "a",
    upstream_status: "-", upstream_connect_time: "-", upstream_header_time: "-", upstream_response_time: "-",
  };
  return texto.replace(/\$([a-z_0-9]+)/g, (_t, nombre: string) => {
    if (!(nombre in valores)) throw new Error(`variable inesperada en el formato: $${nombre}`);
    return valores[nombre]!;
  });
}

describe("normalización del estado", () => {
  const casos: [string, number | null][] = [
    ["009", 9], ["000", 0], ["099", 99], ["010", 10], ["001", 1],
    ["100", 100], ["200", 200], ["201", 201], ["204", 204], ["301", 301], ["304", 304], ["400", 400], ["401", 401],
    ["403", 403], ["404", 404], ["499", 499], ["500", 500], ["502", 502], ["503", 503], ["504", 504], ["999", 999],
    // No reconocidos: JSON válido y explícito.
    ["", null], ["abc", null], ["0", null], ["00", null], ["0000", null], ["0200", null], ["1000", null],
    ["2x0", null], ["-01", null], [" 200", null], ["200 ", null], ["2\n00", null],
  ];
  for (const [entrada, esperado] of casos) {
    it(`${JSON.stringify(entrada)} → ${esperado}`, () => {
      const linea = lineaDeRegistro(entrada);
      const objeto = JSON.parse(linea) as { estado: unknown };
      expect(objeto.estado).toBe(esperado);
      expect(typeof objeto.estado === "number" || objeto.estado === null).toBe(true);
    });
  }

  it("ninguna entrada de tres cifras produce un estado con ceros iniciales ni un valor fuera de 0-999", () => {
    for (let n = 0; n < 1000; n++) {
      const entrada = String(n).padStart(3, "0");
      const texto = estadoJson(entrada);
      expect(texto).toBe(String(n));
      expect(() => JSON.parse(`{"estado":${texto}}`)).not.toThrow();
    }
  });

  it("el control: la línea anterior (`$status` sin normalizar) es rechazada por JSON.parse con 009", () => {
    const anterior = lineaDeRegistro("009").replace('"estado":9', '"estado":009');
    expect(() => JSON.parse(anterior)).toThrow();
  });

  it("el formato conserva el resto de campos y sus tipos", () => {
    const o = JSON.parse(lineaDeRegistro("200")) as Record<string, unknown>;
    expect(Object.keys(o)).toEqual([
      "hora", "direccion", "reenviada", "metodo", "ruta", "protocolo", "estado", "bytes", "tiempo",
      "upstream_status", "upstream_connect_time", "upstream_header_time", "upstream_response_time", "agente",
    ]);
    // Los cuatro campos del upstream son CADENAS (pueden valer "-", llevar ceros iniciales o listas de intentos).
    for (const k of ["hora", "direccion", "reenviada", "metodo", "ruta", "protocolo", "agente", "upstream_status", "upstream_connect_time", "upstream_header_time", "upstream_response_time"]) expect(typeof o[k], k).toBe("string");
    for (const k of ["estado", "bytes", "tiempo"]) expect(typeof o[k], k).toBe("number");
  });

  it("los campos del upstream son cadenas JSON escapadas: valores ausentes, ceros iniciales y listas de intentos", () => {
    const formato = /log_format fchmn_acceso escape=json\n([\s\S]*?);\n/.exec(PLANTILLA)![1]!;
    for (const v of ["upstream_status", "upstream_connect_time", "upstream_header_time", "upstream_response_time"]) {
      // Entre comillas en el formato: nunca como número desnudo.
      expect(formato, v).toContain(`"${v}":"$${v}",`);
    }
    // Con escape=json, Nginx escapa el valor: una lista de intentos o un valor raro no rompe la línea.
    for (const valor of ["-", "009", "502, 200", "502 : 200", "0.000, 10.001", "-, 0.002", 'a"b\\c']) {
      const escapado = valor.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const o = JSON.parse(`{"x":"${escapado}"}`) as { x: string };
      expect(o.x).toBe(valor);
    }
  });

  it("no registra la dirección del upstream ni otros campos nuevos", () => {
    const formato = /log_format fchmn_acceso escape=json\n([\s\S]*?);\n/.exec(PLANTILLA)![1]!;
    expect(formato).not.toMatch(/\$upstream_addr|\$upstream_bytes|\$proxy_host|\$upstream_cache/);
    const delUpstream = [...formato.matchAll(/\$([a-z_0-9]+)/g)].map((m) => m[1]!).filter((n) => n.startsWith("upstream"));
    expect(delUpstream).toEqual(["upstream_status", "upstream_connect_time", "upstream_header_time", "upstream_response_time"]);
  });

  it("sigue sin consulta, `$request`, `$args` ni `Referer`, y el estado sale del `map` y no de `$status` directo", () => {
    const formato = /log_format fchmn_acceso escape=json\n([\s\S]*?);\n/.exec(PLANTILLA)![1]!;
    expect(formato).not.toMatch(/\$(request\b|args|query_string|request_uri|http_referer)/);
    expect(formato).toContain('"estado":$estado_json');
    expect(formato).not.toMatch(/\$status/);
    // El `map` toma el código real de Nginx: producción sigue usando `$status`.
    expect(PLANTILLA).toMatch(/^map \$status \$estado_json \{/m);
  });
});
