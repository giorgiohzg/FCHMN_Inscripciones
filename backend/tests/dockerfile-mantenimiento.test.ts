/**
 * GUARDA DEL CONTRATO ENTRE LOS DOS DOCKERFILE DEL BACKEND.
 *
 * POR QUÉ EXISTE. `backend/Dockerfile` produce dos imágenes muy distintas desde
 * el mismo archivo: la que SIRVE la API (`runtime`) y la que trae las
 * herramientas de MIGRACIÓN y seeds (`migrate`). Quién obtiene cuál depende de
 * dos cosas frágiles que nadie ve al leer el código de la aplicación:
 *
 *   - el ORDEN de las etapas, porque construir sin elegir etapa produce la
 *     última;
 *   - el COMANDO POR OMISIÓN de cada imagen.
 *
 * Las dos se pueden romper con una edición inocente —mover un bloque, añadir
 * una etapa al final, cambiar un `CMD`— y el síntoma no sería un error de
 * construcción: la construcción funcionaría y se desplegaría la imagen
 * equivocada, o un servicio programado empezaría a migrar la base por
 * calendario. Esta prueba convierte esas dos propiedades en algo que falla
 * fuerte y temprano.
 *
 * QUÉ NO COMPRUEBA. No construye imágenes: lee los archivos. Que lo construido
 * coincida con lo escrito lo comprueban
 * `scripts/verificar-archivos-de-imagen.mjs` y el procedimiento de
 * `scripts/construir-y-revalidar.md`, con Docker, fuera de la integración
 * continua.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const RAIZ = path.join(__dirname, "..", "..");
const FUENTE = path.join(RAIZ, "backend", "Dockerfile");
const DERIVADO = path.join(RAIZ, "backend", "Dockerfile.mantenimiento");

const fuente = readFileSync(FUENTE, "utf8");
const derivado = readFileSync(DERIVADO, "utf8");

/** Nombres de las etapas, en el orden en que aparecen. */
function etapasDe(contenido: string): string[] {
  return [...contenido.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)\s*$/gim)].map((m) => m[1]!);
}

/** Última instrucción `CMD` del archivo, tal cual. */
function ultimoCmd(contenido: string): string | undefined {
  const todos = [...contenido.matchAll(/^CMD\s+(.+)$/gim)].map((m) => m[1]!.trim());
  return todos.at(-1);
}

describe("backend/Dockerfile: la fuente", () => {
  it("termina en `runtime`, para que construir sin elegir etapa dé la API", () => {
    /**
     * Si esto falla, una plataforma que construya el archivo tal cual
     * desplegaría el contenedor de migraciones: un servicio sin `dist/`, cuyo
     * comando migra y termina, que nunca atendería una petición.
     */
    expect(etapasDe(fuente).at(-1)).toBe("runtime");
  });

  it("conserva `prisma migrate deploy` como comando de la etapa `migrate`", () => {
    /**
     * Es el contrato con `docker-compose.yml`, que construye esa etapa con
     * `target: migrate` y espera que el contenedor efímero migre al arrancar.
     * El endurecimiento del archivo DERIVADO no debe tocar esto.
     */
    const bloqueMigrate = fuente.slice(fuente.search(/^FROM\s+\S+\s+AS\s+migrate\s*$/im));
    expect(bloqueMigrate).toMatch(/^CMD\s+\["prisma",\s*"migrate",\s*"deploy"/im);
  });
});

describe("backend/Dockerfile.mantenimiento: el derivado", () => {
  it("es un archivo generado y contiene la fuente íntegra", () => {
    /**
     * La derivación es: encabezado + la fuente byte a byte + una etapa final.
     * Comprobar que la fuente está entera dentro detecta una edición a mano,
     * que es el modo en que estos dos archivos empezarían a divergir.
     */
    expect(derivado).toContain("ARCHIVO GENERADO. NO EDITAR A MANO.");
    expect(derivado).toContain(fuente);
  });

  it("termina en una etapa que cuelga de `migrate`", () => {
    const etapas = etapasDe(derivado);
    expect(etapas.at(-1)).toBe("mantenimiento");
    expect(derivado).toMatch(/^FROM\s+migrate\s+AS\s+mantenimiento\s*$/im);
  });

  it("su comando por omisión NO toca la base de datos", () => {
    /**
     * El endurecimiento. Este archivo alimenta un servicio PROGRAMADO: su
     * comando por omisión es lo que se ejecutaría si el calendario se dispara y
     * nadie puso un comando explícito. Tiene que ser inocuo.
     *
     * Se comprueba en positivo (es un `echo`) y en negativo (no nombra ninguna
     * de las tres operaciones reales), porque una lista de prohibiciones sola
     * envejecería con el primer comando nuevo.
     */
    const cmd = ultimoCmd(derivado);
    expect(cmd, "el derivado debe declarar un CMD propio").toBeDefined();
    expect(cmd).toMatch(/^\["\/bin\/echo",/);
    expect(cmd).not.toMatch(/prisma|migrate deploy|dist-seed|seed-admin|node /i);
  });

  it("no reutiliza el comando de la etapa `migrate`", () => {
    /**
     * Dicho de otro modo: el último `CMD` del derivado no puede ser el mismo
     * que el último de la fuente. Si lo fuera, el endurecimiento no existe.
     */
    expect(ultimoCmd(derivado)).not.toBe(ultimoCmd(fuente.slice(fuente.search(/^FROM\s+\S+\s+AS\s+migrate\s*$/im))));
  });
});
