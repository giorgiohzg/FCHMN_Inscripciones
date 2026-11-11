/**
 * IP DEL CLIENTE: de dónde sale `req.ip` y cómo se escribe.
 *
 * Antes, `req.ip` salía de la cadena `X-Forwarded-For` contando un número fijo de saltos
 * (`TRUST_PROXY_HOPS`). Detrás de Render eso daba la dirección de un nodo del borde, no la del
 * cliente, y una cuenta fija de saltos no puede validar quién escribió cada entrada.
 *
 * Ahora la fuente es explícita y la elige la configuración (`IP_CLIENTE_FUENTE`):
 *
 *  - `socket` (por omisión: local y pruebas): la dirección del par TCP. Se ignoran todas las
 *    cabeceras de identidad reenviadas (`X-Forwarded-For`, `X-Forwarded-Host`,
 *    `X-Forwarded-Proto`, `X-Real-IP`, `CF-Connecting-IP`).
 *  - `cf-connecting-ip` (Render): la cabecera `CF-Connecting-IP`, que es la que Render recomienda
 *    para identificar al cliente público. Si falta, está repetida, es ambigua o no es una IP
 *    aceptable, se usa el RESPALDO: la dirección del socket (el Nginx propio), un origen
 *    compartido que nunca es un valor declarado por el cliente.
 *
 * FRONTERA DE CONFIANZA (decisión documentada en `docs/seguridad/PLAN_SEGURIDAD.md`). Las
 * conexiones por la red privada de Render no pasan por Cloudflare: cualquier servicio del mismo
 * workspace y región puede llamar a la API, o al Nginx que la reenvía, con un `CF-Connecting-IP`
 * inventado. Se acepta para los servicios propios actuales (web, API y mantenimiento); un
 * servicio comprometido podría suplantar la IP auditada, y la decisión debe reevaluarse ANTES de
 * incorporar cualquier servicio nuevo al workspace en esa región.
 *
 * CÓMO SE APLICA. `opcionesDeOrigenIp` devuelve dos opciones de Fastify que van JUNTAS:
 *
 *  - `rewriteUrl`, que Fastify ejecuta antes de enrutar —también para rutas inexistentes y en
 *    `inject`— y ANTES del registro «incoming request». No cambia la URL: reescribe
 *    `X-Forwarded-For` con UNA sola dirección ya validada y canónica (la aceptada o la del
 *    socket) y borra las demás cabeceras de identidad. Ninguna cadena del cliente sobrevive.
 *  - `trustProxy` que confía solo en el salto 0: con la cabecera ya reescrita, `req.ip` es
 *    exactamente esa dirección. Sin `rewriteUrl` esta confianza no sería segura; por eso nunca
 *    se configura una sin la otra.
 *
 * `req.ip` es perezoso en Fastify 5 (se calcula desde `raw.headers` en cada lectura), así que los
 * usos existentes de `req.ip` —auditoría, límite de tasa, registro— reciben el valor saneado sin
 * cambiar.
 *
 * La fuente y el motivo quedan como METADATO INTERNO en un símbolo de la petición cruda: no se
 * pueden fijar desde una cabecera. Se leen con `origenIpDe`.
 *
 * El análisis sintáctico (`analizarIp`) está separado de las restricciones para aceptar
 * `CF-Connecting-IP` (`aceptableComoClientePublico`): el respaldo por socket admite cualquier
 * dirección legítima, también loopback, privadas e IPv4 mapeadas. Normalizar NO autentica nada.
 */
import { isIP } from "node:net";
import type { IncomingMessage } from "node:http";

export type FuenteIpCliente = "socket" | "cf-connecting-ip";

export type MotivoDeRespaldo = "ausente" | "invalida" | "repetida" | "no-aceptable";

export type OrigenIp = { fuente: "socket" } | { fuente: "cf-connecting-ip" } | { fuente: "respaldo"; motivo: MotivoDeRespaldo };

export interface DireccionIp {
  familia: 4 | 6;
  /** Forma canónica: decimal con puntos para IPv4 (también las mapeadas) y RFC 5952 para IPv6. */
  texto: string;
}

/** Una IPv6 en texto ocupa como mucho 45 caracteres (con IPv4 al final). Más largo no es una IP. */
const LARGO_MAXIMO = 45;

const ORIGEN_IP = Symbol("fchmn.origenIp");

type PeticionMarcada = IncomingMessage & { [ORIGEN_IP]?: OrigenIp };

/** Los 8 grupos de 16 bits de una IPv6 que `isIP` ya validó. */
function gruposIpv6(texto: string): number[] | null {
  let entrada = texto;
  const grupos: number[] = [];
  // Cola IPv4 incrustada (`::ffff:192.0.2.1`, `64:ff9b::192.0.2.1`): se convierte en dos grupos.
  const ultimo = entrada.lastIndexOf(":");
  const cola = entrada.slice(ultimo + 1);
  let colaIpv4: number[] = [];
  if (cola.includes(".")) {
    if (isIP(cola) !== 4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = cola.split(".").map(Number);
    colaIpv4 = [(a << 8) | b, (c << 8) | d];
    entrada = entrada.slice(0, ultimo + 1) + "0";
  }

  const mitades = entrada.split("::");
  if (mitades.length > 2) return null;
  const aGrupos = (parte: string) => (parte === "" ? [] : parte.split(":").map((g) => parseInt(g, 16)));
  const izquierda = aGrupos(mitades[0] ?? "");
  const derecha = mitades.length === 2 ? aGrupos(mitades[1] ?? "") : [];
  if (colaIpv4.length > 0) {
    // El "0" provisional ocupa un grupo; la cola IPv4 ocupa dos.
    (mitades.length === 2 ? derecha : izquierda).pop();
  }
  const conocidos = izquierda.length + derecha.length + colaIpv4.length;
  const faltan = mitades.length === 2 ? 8 - conocidos : 0;
  if (faltan < 0 || (mitades.length === 1 && conocidos !== 8)) return null;
  grupos.push(...izquierda, ...new Array<number>(faltan).fill(0), ...derecha, ...colaIpv4);
  if (grupos.length !== 8 || grupos.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return grupos;
}

/** RFC 5952: minúsculas, sin ceros a la izquierda y `::` en la racha de ceros más larga (≥ 2). */
function textoIpv6(grupos: number[]): string {
  let mejorInicio = -1;
  let mejorLargo = 0;
  for (let i = 0; i < 8;) {
    if (grupos[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && grupos[j] === 0) j++;
    if (j - i > mejorLargo) {
      mejorInicio = i;
      mejorLargo = j - i;
    }
    i = j;
  }
  const partes = grupos.map((g) => g.toString(16));
  if (mejorLargo < 2) return partes.join(":");
  return `${partes.slice(0, mejorInicio).join(":")}::${partes.slice(mejorInicio + mejorLargo).join(":")}`;
}

/**
 * Analiza una dirección IP en texto y la devuelve en forma canónica, o `null` si no lo es.
 *
 * Solo sintaxis: no dice nada de quién la declaró. Rechaza zonas IPv6 (`%eth0`), corchetes,
 * puertos, espacios y lo que `net.isIP` no reconozca (que ya rechaza ceros a la izquierda en
 * IPv4). Las IPv4 mapeadas (`::ffff:0:0/96`, en cualquier escritura) se devuelven como IPv4.
 */
export function analizarIp(entrada: string | undefined | null): DireccionIp | null {
  if (typeof entrada !== "string" || entrada.length === 0 || entrada.length > LARGO_MAXIMO) return null;
  if (entrada.includes("%")) return null;
  const familia = isIP(entrada);
  if (familia === 4) return { familia: 4, texto: entrada };
  if (familia !== 6) return null;

  const grupos = gruposIpv6(entrada.toLowerCase());
  if (!grupos) return null;
  const esMapeada = grupos.slice(0, 5).every((g) => g === 0) && grupos[5] === 0xffff;
  if (esMapeada) {
    const [g6 = 0, g7 = 0] = [grupos[6], grupos[7]];
    return { familia: 4, texto: `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}` };
  }
  return { familia: 6, texto: textoIpv6(grupos) };
}

/**
 * ORIGEN PARA LOS LÍMITES DE LOGIN (C-02). Es una clave de agrupación, no una dirección:
 *
 *  - IPv4 (también las IPv4 mapeadas, que `analizarIp` ya devuelve como IPv4): la dirección.
 *  - IPv6: su prefijo /64 (`2001:db8:1:2::/64`). Un cliente suele recibir un /64 completo, y
 *    contar por /128 dejaría rotar direcciones dentro de él para eludir el límite.
 *  - Respaldo (`CF-Connecting-IP` ausente, repetida o inválida): UN origen compartido, sin
 *    ningún valor del cliente.
 *  - Una dirección que no se pueda analizar (no debería ocurrir: `req.ip` ya es canónica):
 *    otro origen compartido.
 *
 * Solo se usa para las claves de los límites. La auditoría conserva la IP completa.
 */
export function origenParaLimites(ip: string | undefined, origen: OrigenIp | undefined): string {
  if (origen?.fuente === "respaldo") return "respaldo";
  const analizada = analizarIp(ip);
  if (!analizada) return "desconocido";
  if (analizada.familia === 4) return `4:${analizada.texto}`;
  const grupos = gruposIpv6(analizada.texto);
  if (!grupos) return "desconocido";
  return `6:${textoIpv6([...grupos.slice(0, 4), 0, 0, 0, 0])}/64`;
}

/**
 * Restricción para ACEPTAR `CF-Connecting-IP`, separada del análisis: una dirección que no puede
 * ser la de un cliente que se conecta a Cloudflare por internet (sin especificar, loopback,
 * multicast o difusión). Es saneamiento, no autenticación. Las privadas y el rango 240/4 (pseudo
 * IPv4 de Cloudflare) se aceptan.
 */
export function aceptableComoClientePublico(ip: DireccionIp): boolean {
  if (ip.familia === 4) {
    const primero = Number(ip.texto.split(".")[0]);
    if (primero === 0 || primero === 127) return false;
    if (primero >= 224 && primero <= 239) return false;
    return ip.texto !== "255.255.255.255";
  }
  if (ip.texto === "::" || ip.texto === "::1") return false;
  return !/^ff[0-9a-f]{2}:/.test(ip.texto);
}

type LecturaDeCabecera = { ok: true; ip: string } | { ok: false; motivo: MotivoDeRespaldo };

/**
 * Lee `CF-Connecting-IP` de las cabeceras CRUDAS, línea por línea. No se usa `headers`, donde Node
 * une las líneas repetidas: aquí se cuentan, y más de una línea —o una sola con una lista— es
 * ambigua y no se elige ninguna.
 */
function leerCfConnectingIp(cabecerasCrudas: string[] | undefined): LecturaDeCabecera {
  const valores: string[] = [];
  const crudas = cabecerasCrudas ?? [];
  for (let i = 0; i + 1 < crudas.length; i += 2) {
    if (crudas[i]?.toLowerCase() === "cf-connecting-ip") valores.push(crudas[i + 1] ?? "");
  }
  if (valores.length === 0) return { ok: false, motivo: "ausente" };
  if (valores.length > 1) return { ok: false, motivo: "repetida" };
  const valor = (valores[0] ?? "").replace(/^[ \t]+|[ \t]+$/g, "");
  if (valor.includes(",")) return { ok: false, motivo: "repetida" };
  const ip = analizarIp(valor);
  if (!ip) return { ok: false, motivo: "invalida" };
  if (!aceptableComoClientePublico(ip)) return { ok: false, motivo: "no-aceptable" };
  return { ok: true, ip: ip.texto };
}

/** Cabeceras de identidad que el cliente podría declarar y que nada aguas abajo debe leer. */
const CABECERAS_DE_IDENTIDAD = ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"] as const;

/**
 * Decide el origen de la petición y reescribe sus cabeceras para que `req.ip` sea esa dirección.
 * Se llama desde `rewriteUrl`, antes de enrutar y de registrar nada.
 */
export function sanearOrigenIp(peticion: IncomingMessage, fuente: FuenteIpCliente): OrigenIp {
  const cabeceras = peticion.headers;
  const delSocket = analizarIp(peticion.socket?.remoteAddress);

  let origen: OrigenIp;
  let direccion: string | undefined;
  if (fuente === "cf-connecting-ip") {
    const lectura = leerCfConnectingIp(peticion.rawHeaders);
    if (lectura.ok) {
      origen = { fuente: "cf-connecting-ip" };
      direccion = lectura.ip;
    } else {
      origen = { fuente: "respaldo", motivo: lectura.motivo };
      direccion = delSocket?.texto;
    }
  } else {
    origen = { fuente: "socket" };
    direccion = delSocket?.texto;
    // En modo socket no hay proxy de confianza: tampoco se aceptan esquema ni host reenviados.
    delete cabeceras["x-forwarded-host"];
    delete cabeceras["x-forwarded-proto"];
  }

  for (const nombre of CABECERAS_DE_IDENTIDAD) delete cabeceras[nombre];
  // Una sola dirección, ya canónica. Si el socket no tuviera una dirección analizable, no se
  // escribe nada y Fastify devuelve la del socket tal cual.
  if (direccion !== undefined) cabeceras["x-forwarded-for"] = direccion;

  (peticion as PeticionMarcada)[ORIGEN_IP] = origen;
  return origen;
}

/** Fuente y motivo del `req.ip` de esta petición (metadato interno, nunca una cabecera). */
export function origenIpDe(peticion: IncomingMessage | undefined): OrigenIp | undefined {
  return peticion ? (peticion as PeticionMarcada)[ORIGEN_IP] : undefined;
}

/**
 * Las dos opciones de Fastify que fijan `req.ip`. Van siempre juntas: confiar en el salto 0 solo
 * es seguro porque `rewriteUrl` ya dejó en `X-Forwarded-For` una única dirección decidida aquí.
 */
export function opcionesDeOrigenIp(fuente: FuenteIpCliente) {
  return {
    trustProxy: (_direccion: string, salto: number) => salto === 0,
    rewriteUrl: (peticion: IncomingMessage): string => {
      sanearOrigenIp(peticion, fuente);
      return peticion.url ?? "/";
    },
  };
}
