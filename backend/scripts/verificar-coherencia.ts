import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse } from "dotenv";

/**
 * Comprueba que la contraseña de PostgreSQL sea COHERENTE entre los dos sitios
 * donde vive: `POSTGRES_PASSWORD` en el `.env` de la RAÍZ —que Compose sustituye
 * en `${POSTGRES_PASSWORD}`— y la contraseña embebida en `DATABASE_URL` de
 * `backend/.env`, que usan Prisma y las herramientas del host.
 *
 * La duplicación no puede eliminarse: `dotenv` no expande variables entre
 * archivos, y Prisma exige la URL completa en una sola variable. Lo que sí puede
 * hacerse es detectar la divergencia en cuanto aparezca, en vez de descubrirla
 * cuando el backend deje de autenticar.
 *
 * NO imprime ningún valor: solo veredictos. Los dos operandos de la comparación
 * de coherencia son secretos, así que el booleano no revela ninguno.
 */

export interface Veredictos {
  passwordDefinida: boolean;
  urlAnalizable: boolean;
  coherente: boolean;
  alfabetoUrlSafe: boolean;
  distintaDePruebas: boolean;
}

export interface RutasDelProyecto {
  raiz: string;
  envRaiz: string;
  envBackend: string;
  envPruebas: string;
}

/**
 * Resuelve las rutas desde la UBICACIÓN DEL MÓDULO (`backend/scripts`), nunca
 * desde el directorio de trabajo: `npm run` lo invoca desde `backend`, pero nada
 * impide ejecutarlo desde otro sitio, y entonces las rutas relativas apuntarían
 * a archivos que no existen y el verificador daría un falso negativo.
 */
export function resolverRutas(dirDelModulo: string): RutasDelProyecto {
  const raiz = resolve(dirDelModulo, "..", "..");
  return {
    raiz,
    envRaiz: join(raiz, ".env"),
    envBackend: join(raiz, "backend", ".env"),
    envPruebas: join(raiz, "backend", ".env.test"),
  };
}

/** Los caracteres «unreserved» de la RFC 3986: no requieren codificación en una URL. */
const URL_SAFE = /^[A-Za-z0-9._~-]+$/;

/** Contraseña de una URL de conexión, ya decodificada. `null` si no se puede leer. */
function claveDeUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return null;
  }
}

export function compararCoherencia(
  raiz: Record<string, string | undefined>,
  backend: Record<string, string | undefined>,
  pruebas: Record<string, string | undefined>
): Veredictos {
  const password = raiz.POSTGRES_PASSWORD ?? "";
  const passwordDefinida = password.length > 0;

  const claveBackend = claveDeUrl(backend.DATABASE_URL);
  const clavePruebas = claveDeUrl(pruebas.DATABASE_URL);

  return {
    passwordDefinida,
    urlAnalizable: claveBackend !== null,
    coherente: passwordDefinida && claveBackend !== null && claveBackend === password,
    alfabetoUrlSafe: passwordDefinida && URL_SAFE.test(password),
    // La de pruebas es pública y desechable: que coincidan sería un error grave.
    distintaDePruebas: passwordDefinida && clavePruebas !== null && clavePruebas !== password,
  };
}

function leer(ruta: string): Record<string, string | undefined> {
  try {
    return parse(readFileSync(ruta));
  } catch {
    return {};
  }
}

if (require.main === module) {
  const rutas = resolverRutas(__dirname);
  const v = compararCoherencia(leer(rutas.envRaiz), leer(rutas.envBackend), leer(rutas.envPruebas));
  console.log(`POSTGRES_PASSWORD definida y no vacia              : ${v.passwordDefinida}`);
  console.log(`DATABASE_URL analizable como URL                   : ${v.urlAnalizable}`);
  console.log(`coherencia raiz <-> backend/.env                   : ${v.coherente}`);
  console.log(`alfabeto URL-safe (no requiere codificacion)       : ${v.alfabetoUrlSafe}`);
  console.log(`credencial de desarrollo distinta de la de pruebas : ${v.distintaDePruebas}`);
  const todo = Object.values(v).every(Boolean);
  console.log(todo ? "COHERENCIA OK" : "COHERENCIA CON PROBLEMAS");
  process.exitCode = todo ? 0 : 1;
}
