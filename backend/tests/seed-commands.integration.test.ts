/**
 * Fase 6, hallazgo 29 — los comandos de instalación, ejecutados de verdad.
 *
 * Las pruebas de `seed-admin.test.ts` cubren la decisión aislada; estas
 * ejecutan los DOS COMANDOS tal como los documenta el README, como procesos
 * hijos y contra la base desechable, y miran qué queda en la base.
 *
 * Importa hacerlo así porque el defecto no estaba en una función sino en el
 * empaquetado: un solo comando hacía las dos cosas, y el contenedor lo corría
 * en cada arranque.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, delimiter } from "node:path";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { parse as parseEnv } from "dotenv";
import { prisma } from "../src/shared/prisma.client";
import { checkDisposableDatabaseUrl, truncateAllTables } from "./helpers/testDb";

const ejecutar = promisify(execFile);
const RAIZ = resolve(__dirname, "..");
const CLAVE_VALIDA = "Marejada2026";

/** Lanza un script del proyecto con el entorno indicado, contra la base de PRUEBAS. */
async function correr(
  script: string,
  extra: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await ejecutar("npx", ["tsx", script], {
      cwd: RAIZ,
      shell: true,
      env: {
        ...process.env,
        // `DATABASE_URL` ya apunta a natacion_test: lo garantiza
        // `integration.env.ts` + `assertDisposableDatabase()`.
        ...extra,
      },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const contarUsuarios = () => prisma.user.count();

beforeEach(async () => {
  await truncateAllTables(prisma);
});

afterAll(async () => {
  await truncateAllTables(prisma);
  await prisma.$disconnect();
});

/**
 * Los comandos documentados se ejecutan a mano, desde la terminal, SIN que
 * `DATABASE_URL` esté en el entorno: es lo que hace quien sigue el instructivo
 * de instalación. Estas pruebas quitan la variable heredada a propósito, porque
 * heredarla ocultaba el defecto: `tsx` NO carga un `.env` por su cuenta
 * —comprobado— y los scripts fallaban con "environment variable not found".
 *
 * Lo que aquí se ejercita es el ENVOLTORIO `dotenv`, no un archivo concreto.
 * Por eso estas pruebas apuntan a `.env.test`, el archivo de la suite, y NUNCA
 * a `backend/.env`:
 *
 *   - `backend/.env` es el archivo privado de quien desarrolla. Una prueba no
 *     debe leerlo, copiarlo, respaldarlo ni reemplazarlo, y menos aún escribir
 *     en la base que ese archivo declare.
 *   - `backend/.env` tampoco existe en CI, así que una prueba que dependiera de
 *     él o se saltaría siempre o rompería la recolección del archivo entero.
 *   - `.env.test` sí está garantizado dondequiera que corra la integración: en
 *     CI lo crea el flujo copiando `.env.test.example`, y en local la suite no
 *     arranca sin él (lo cargan `integration.setup.ts` e `integration.env.ts`,
 *     que acto seguido llaman a `assertDisposableDatabase()`).
 *
 * Que el archivo se nombre con `-e` es imprescindible: `dotenv` SIN `-e` carga
 * `.env` del directorio actual. Omitirlo leería justo el archivo que estas
 * pruebas no deben tocar.
 */
describe("los comandos cargan su archivo de entorno por su cuenta", () => {
  const RUTA_ENV_PRUEBAS = resolve(RAIZ, ".env.test");
  /* El ejecutable se toma de la instalación local, por ruta, y se invoca con
     `node`. Así no interviene `npx` —que ante un paquete ausente intentaría
     DESCARGARLO— ni ningún shell: `execFile` sin `shell` entrega el arreglo de
     argumentos tal cual, con el mismo resultado en Windows y en Linux. */
  const CLI_DOTENV = resolve(RAIZ, "node_modules", "dotenv-cli", "cli.js");
  const BIN_LOCAL = resolve(RAIZ, "node_modules", ".bin");

  /* `seed-admin` exige estas dos variables y `.env.test.example` no las
     declara. Se inyectan con `-v`, que `dotenv` aplica DESPUÉS del archivo, de
     modo que no hace falta crear ni modificar archivo alguno. Son literales
     sintéticos: no son credenciales de nadie ni se escriben en disco. */
  const ADMIN_PRUEBAS = { usuario: "admin.pruebas", clave: "Sintetica2030" };

  /** Clave de PATH tal como la escribe el sistema (`Path` en Windows). */
  function clavePath(entorno: Record<string, string | undefined>): string {
    return Object.keys(entorno).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  }

  /**
   * Guarda fail-closed sobre la URL EFECTIVA del proceso hijo.
   *
   * El hijo no toma la URL del entorno —se la quitamos— sino de `.env.test`.
   * Se valida por tanto ESE valor, con la misma guarda acumulativa que protege
   * al resto de la suite. `checkDisposableDatabaseUrl` informa host, nombre de
   * base y puerto, nunca la cadena de conexión completa.
   */
  function exigirBaseDesechable(): void {
    expect(existsSync(RUTA_ENV_PRUEBAS), "falta backend/.env.test: cópielo de backend/.env.test.example").toBe(true);
    const archivo = parseEnv(readFileSync(RUTA_ENV_PRUEBAS, "utf8"));
    const veredicto = checkDisposableDatabaseUrl(archivo.DATABASE_URL, archivo.ALLOW_DESTRUCTIVE_TESTS);
    expect(veredicto.ok, veredicto.ok ? "" : veredicto.reason).toBe(true);
  }

  /** Corre un script con el envoltorio `dotenv` apuntado a `.env.test`. */
  async function correrConEnvDePruebas(
    script: string,
    inyectadas: Record<string, string> = {}
  ): Promise<{ code: number; salida: string }> {
    exigirBaseDesechable();

    const entorno = { ...process.env } as Record<string, string | undefined>;
    /* Se elimina lo que vendría del archivo: si el script funciona, es porque
       lo cargó él mismo. Además es NECESARIO, no solo demostrativo: `dotenv`
       no pisa una variable ya presente salvo con `--override`, así que una
       `DATABASE_URL` heredada prevalecería sobre la del archivo. */
    delete entorno.DATABASE_URL;
    delete entorno.JWT_ACCESS_SECRET;
    /* `dotenv` lanza el comando con cross-spawn, que resuelve `tsx` por PATH.
       Se antepone el `.bin` local para no depender de que PATH venga de npm. */
    const clave = clavePath(entorno);
    entorno[clave] = `${BIN_LOCAL}${delimiter}${entorno[clave] ?? ""}`;

    const argumentos = [CLI_DOTENV, "-e", ".env.test"];
    for (const [nombre, valor] of Object.entries(inyectadas)) argumentos.push("-v", `${nombre}=${valor}`);
    argumentos.push("--", "tsx", script);

    try {
      const { stdout, stderr } = await ejecutar(process.execPath, argumentos, { cwd: RAIZ, env: entorno });
      return { code: 0, salida: stdout + stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, salida: (e.stdout ?? "") + (e.stderr ?? "") };
    }
  }

  it("el envoltorio dotenv se resuelve de la instalación local", () => {
    // Si no estuviera instalado, `npx` lo descargaría; por ruta, no hay
    // descarga posible y la prueba falla en vez de traer código de la red.
    expect(existsSync(CLI_DOTENV), "dotenv-cli debe estar instalado localmente").toBe(true);
  });

  it("prisma:seed funciona sin DATABASE_URL en el entorno", async () => {
    const r = await correrConEnvDePruebas("prisma/seed.ts");

    expect(r.code, r.salida).toBe(0);
    expect(r.salida, "no puede quejarse de que falte la configuración").not.toMatch(/environment variable not found/i);
    expect(await prisma.role.count(), "sembró de verdad, contra la base de pruebas").toBeGreaterThan(0);
  });

  it("seed:admin funciona sin DATABASE_URL en el entorno", async () => {
    await correrConEnvDePruebas("prisma/seed.ts");

    const r = await correrConEnvDePruebas("prisma/seed-admin.ts", {
      SEED_ADMIN_USERNAME: ADMIN_PRUEBAS.usuario,
      SEED_ADMIN_PASSWORD: ADMIN_PRUEBAS.clave,
    });

    expect(r.code, r.salida).toBe(0);
    expect(r.salida).not.toMatch(/environment variable not found/i);
    expect(await prisma.user.count({ where: { username: ADMIN_PRUEBAS.usuario } })).toBe(1);
  });

  /**
   * La comprobación que SÍ se puede hacer siempre, sin tocar ninguna base:
   * los scripts documentados invocan `dotenv -e .env`. Sin eso, el comando
   * documentado no arranca en una instalación limpia.
   *
   * Se fija la orden ENTERA, no solo el prefijo: las pruebas de arriba corren
   * el mismo `tsx prisma/<script>.ts` bajo el mismo envoltorio, cambiando solo
   * el archivo. Si el script documentado se moviera a otro programa, estas
   * pruebas dejarían de demostrar nada sobre él y nadie se enteraría.
   */
  it("los scripts declaran la carga explícita del archivo", () => {
    const pkg = JSON.parse(readFileSync(resolve(RAIZ, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      prisma: { seed: string };
    };

    expect(pkg.scripts["prisma:seed"], "tsx no carga .env por su cuenta").toBe("dotenv -e .env -- tsx prisma/seed.ts");
    expect(pkg.scripts["seed:admin"]).toBe("dotenv -e .env -- tsx prisma/seed-admin.ts");
    // Dentro del contenedor no hay `.env` y las variables vienen del entorno:
    // ahí `prisma db seed` NO debe depender del archivo.
    expect(pkg.prisma.seed).toBe("tsx prisma/seed.ts");
  });

  /**
   * Estas pruebas no crean, copian ni renombran ningún archivo: por eso no hay
   * nada que restaurar en un `finally` y una terminación abrupta no deja
   * residuo. Se comprueba que la lista de archivos de entorno del proyecto sea
   * la misma antes y después; se miran NOMBRES, nunca contenidos.
   */
  it("no crea, copia ni renombra ningún archivo de entorno", async () => {
    const listar = () => readdirSync(RAIZ).filter((n) => n.startsWith(".env")).sort();
    const antes = listar();

    await correrConEnvDePruebas("prisma/seed.ts");

    expect(listar()).toEqual(antes);
  });
});

describe("prisma:seed — datos de referencia", () => {
  it("siembra roles y permisos y NO crea ningún usuario", async () => {
    const r = await correr("prisma/seed.ts");

    expect(r.code, r.stderr).toBe(0);
    expect(await prisma.role.count(), "los roles son datos de referencia").toBeGreaterThan(0);
    expect(await prisma.permission.count()).toBeGreaterThan(0);
    expect(await prisma.testType.count(), "y los catálogos también").toBeGreaterThan(0);

    // El punto del cambio: sembrar datos de referencia ya no crea cuentas.
    expect(await contarUsuarios(), "crear usuarios es otro comando").toBe(0);
  });

  it("es idempotente: repetirlo no duplica nada", async () => {
    await correr("prisma/seed.ts");
    const roles = await prisma.role.count();
    const permisos = await prisma.permission.count();

    const segunda = await correr("prisma/seed.ts");

    expect(segunda.code, segunda.stderr).toBe(0);
    expect(await prisma.role.count()).toBe(roles);
    expect(await prisma.permission.count()).toBe(permisos);
  });
});

describe("seed:admin — administrador inicial", () => {
  beforeEach(async () => {
    await correr("prisma/seed.ts");
  });

  it("en PRODUCCIÓN sin variables falla y no deja ninguna cuenta", async () => {
    const r = await correr("prisma/seed-admin.ts", {
      NODE_ENV: "production",
      SEED_ADMIN_USERNAME: "",
      SEED_ADMIN_PASSWORD: "",
    });

    expect(r.code, "debe terminar con error, no con éxito silencioso").toBe(1);
    expect(r.stderr + r.stdout).toMatch(/SEED_ADMIN_USERNAME|SEED_ADMIN_PASSWORD/);
    expect(await contarUsuarios(), "ninguna credencial conocida creada").toBe(0);
  });

  it("en producción con variables válidas crea la cuenta correctamente", async () => {
    const r = await correr("prisma/seed-admin.ts", {
      NODE_ENV: "production",
      SEED_ADMIN_USERNAME: "admin.fchmn",
      SEED_ADMIN_PASSWORD: CLAVE_VALIDA,
    });

    expect(r.code, r.stderr).toBe(0);

    // `findFirst`: `username` no es @unique en Prisma (índice parcial en SQL crudo).
    const admin = await prisma.user.findFirstOrThrow({
      where: { username: "admin.fchmn" },
      include: { userRoles: { include: { role: true } } },
    });
    expect(admin.ownerType, "no pertenece a persona ni club (hallazgo 20)").toBe("system");
    expect(admin.mustChangePassword).toBe(true);
    expect(admin.status).toBe("active");
    expect(admin.userRoles.map((ur) => ur.role.name)).toContain("admin");
  });

  it("NO imprime la contraseña", async () => {
    const r = await correr("prisma/seed-admin.ts", {
      NODE_ENV: "production",
      SEED_ADMIN_USERNAME: "admin.fchmn",
      SEED_ADMIN_PASSWORD: CLAVE_VALIDA,
    });

    // La salida de un despliegue queda en los registros del orquestador.
    expect(r.stdout + r.stderr, "la salida del despliegue queda guardada").not.toContain(CLAVE_VALIDA);
  });

  it("es idempotente: repetirlo no duplica la cuenta ni cambia su contraseña", async () => {
    const entorno = { NODE_ENV: "production", SEED_ADMIN_USERNAME: "admin.fchmn", SEED_ADMIN_PASSWORD: CLAVE_VALIDA };
    await correr("prisma/seed-admin.ts", entorno);
    const antes = await prisma.user.findFirstOrThrow({ where: { username: "admin.fchmn" } });

    // Segunda pasada con OTRA contraseña: no debe pisar la que ya está en uso.
    const segunda = await correr("prisma/seed-admin.ts", { ...entorno, SEED_ADMIN_PASSWORD: "OtraClave2026" });

    expect(segunda.code, segunda.stderr).toBe(0);
    expect(await contarUsuarios()).toBe(1);
    const despues = await prisma.user.findFirstOrThrow({ where: { username: "admin.fchmn" } });
    expect(despues.passwordHash, "una cuenta en uso no se pisa").toBe(antes.passwordHash);
  });

  it("una contraseña que no cumple la política detiene el comando", async () => {
    const r = await correr("prisma/seed-admin.ts", {
      NODE_ENV: "production",
      SEED_ADMIN_USERNAME: "admin.fchmn",
      SEED_ADMIN_PASSWORD: "corta",
    });

    expect(r.code).toBe(1);
    expect(await contarUsuarios()).toBe(0);
  });

  /**
   * "Ya existe" no es lo mismo que "ya está bien".
   *
   * Antes bastaba encontrar el nombre de usuario para anunciar éxito. Pero un
   * despliegue puede dejar esa cuenta en un estado con el que NO se puede
   * entrar, y el operador se quedaba creyendo que el administrador estaba listo.
   */
  describe("una cuenta existente se valida antes de declarar éxito", () => {
    const entorno = { NODE_ENV: "production", SEED_ADMIN_USERNAME: "admin.fchmn", SEED_ADMIN_PASSWORD: CLAVE_VALIDA };

    /** Crea la cuenta y luego la deja en el estado que se quiera probar. */
    async function conAdminEn(estropear: (id: string) => Promise<void>) {
      await correr("prisma/seed-admin.ts", entorno);
      const admin = await prisma.user.findFirstOrThrow({ where: { username: "admin.fchmn" } });
      await estropear(admin.id);
      return admin.id;
    }

    it("FALLA si la cuenta perdió el rol admin", async () => {
      await conAdminEn(async (id) => {
        await prisma.userRole.deleteMany({ where: { userId: id } });
      });

      const r = await correr("prisma/seed-admin.ts", entorno);

      // Es el estado que dejaba la versión no transaccional al fallar entre las
      // dos escrituras: cuenta creada, sin rol, e inservible.
      expect(r.code, "una cuenta sin rol no puede hacer nada").toBe(1);
      expect(r.stderr + r.stdout).toMatch(/no tiene el rol 'admin'/i);
    });

    it("FALLA si la cuenta está deshabilitada", async () => {
      await conAdminEn(async (id) => {
        await prisma.user.update({ where: { id }, data: { status: "disabled" } });
      });

      const r = await correr("prisma/seed-admin.ts", entorno);

      expect(r.code).toBe(1);
      expect(r.stderr + r.stdout).toMatch(/disabled/);
    });

    it("FALLA si la cuenta está bloqueada por intentos fallidos", async () => {
      await conAdminEn(async (id) => {
        await prisma.user.update({ where: { id }, data: { lockedUntil: new Date(Date.now() + 3_600_000) } });
      });

      const r = await correr("prisma/seed-admin.ts", entorno);

      expect(r.code).toBe(1);
      expect(r.stderr + r.stdout).toMatch(/bloqueada/i);
    });

    it("NO modifica la cuenta existente al fallar", async () => {
      const id = await conAdminEn(async (uid) => {
        await prisma.user.update({ where: { id: uid }, data: { status: "disabled" } });
      });
      const antes = await prisma.user.findUniqueOrThrow({ where: { id } });

      await correr("prisma/seed-admin.ts", entorno);

      const despues = await prisma.user.findUniqueOrThrow({ where: { id } });
      expect(despues.passwordHash, "el comando informa, no repara por su cuenta").toBe(antes.passwordHash);
      expect(despues.status).toBe("disabled");
    });

    it("tiene éxito, sin tocar nada, si la cuenta SÍ es un administrador válido", async () => {
      await correr("prisma/seed-admin.ts", entorno);

      const r = await correr("prisma/seed-admin.ts", entorno);

      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/ya existe y es un administrador válido/i);
    });
  });

  /**
   * El usuario y su rol se crean en UNA transacción. Antes eran dos escrituras
   * sueltas: un fallo entre medio dejaba un administrador sin rol que ocupaba el
   * nombre de usuario, y el reintento lo daba por bueno.
   */
  it("usuario y rol se crean juntos: o los dos, o ninguno", async () => {
    // Se rompe la segunda escritura con una restricción que ninguna fila puede
    // satisfacer; si no fuera transaccional, el usuario quedaría igualmente.
    await prisma.$executeRawUnsafe(`ALTER TABLE user_roles ADD CONSTRAINT ur_prueba CHECK (role_id IS NULL)`);
    try {
      const r = await correr("prisma/seed-admin.ts", {
        NODE_ENV: "production",
        SEED_ADMIN_USERNAME: "admin.atomico",
        SEED_ADMIN_PASSWORD: CLAVE_VALIDA,
      });

      expect(r.code).toBe(1);
      expect(
        await prisma.user.count({ where: { username: "admin.atomico" } }),
        "sin rol no debe quedar ninguna cuenta ocupando el nombre"
      ).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE user_roles DROP CONSTRAINT ur_prueba`);
    }
  });

  it("FUERA de producción tampoco hay valores por omisión", async () => {
    const r = await correr("prisma/seed-admin.ts", {
      NODE_ENV: "development",
      SEED_ADMIN_USERNAME: "",
      SEED_ADMIN_PASSWORD: "",
    });

    expect(r.code, "el requisito es el mismo en todos los entornos").toBe(1);
    expect(r.stderr + r.stdout).toMatch(/SEED_ADMIN_USERNAME|SEED_ADMIN_PASSWORD/);
    expect(await contarUsuarios(), "no puede quedar ninguna cuenta previsible").toBe(0);
  });

  /**
   * Comportamiento observable del PROCESO REAL ante credenciales ausentes.
   *
   * Lo que esta prueba afirma, y nada más: termina con código 1, no escribe en
   * la base y no deja rechazos sin capturar. **No dice nada sobre el cierre del
   * cliente**: desde fuera del proceso no es observable. Esa garantía la cubre
   * `seed-admin.test.ts`, con un cliente simulado.
   */
  it("con credenciales ausentes termina con 1, sin escribir y sin rechazos sin capturar", async () => {
    const r = await correr("prisma/seed-admin.ts", {
      NODE_ENV: "production",
      SEED_ADMIN_USERNAME: "",
      SEED_ADMIN_PASSWORD: "",
    });

    expect(r.code).toBe(1);
    expect(await contarUsuarios(), "no debe escribir nada").toBe(0);
    expect(r.stderr + r.stdout, "sin rechazos sin capturar").not.toMatch(/UnhandledPromiseRejection|ERR_UNHANDLED/i);
  });

  it("RECHAZA un nombre de usuario que no cumple el formato compartido", async () => {
    const r = await correr("prisma/seed-admin.ts", {
      NODE_ENV: "production",
      SEED_ADMIN_USERNAME: "adm",
      SEED_ADMIN_PASSWORD: CLAVE_VALIDA,
    });

    expect(r.code).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/formato de nombre de usuario/i);
    expect(await contarUsuarios()).toBe(0);
  });

  it("conserva la contraseña con espacios exteriores tal como se entregó", async () => {
    const conEspacios = `  ${CLAVE_VALIDA}  `;
    const r = await correr("prisma/seed-admin.ts", {
      NODE_ENV: "production",
      SEED_ADMIN_USERNAME: "admin.espacios",
      SEED_ADMIN_PASSWORD: conEspacios,
    });

    expect(r.code, r.stderr).toBe(0);
    const admin = await prisma.user.findFirstOrThrow({ where: { username: "admin.espacios" } });

    const { verifyPassword } = await import("../src/modules/auth/password.util");
    expect(await verifyPassword(admin.passwordHash, conEspacios), "el hash es del valor íntegro").toBe(true);
    expect(await verifyPassword(admin.passwordHash, CLAVE_VALIDA), "y no del valor recortado").toBe(false);
  });

  it("NO imprime el nombre de usuario", async () => {
    const r = await correr("prisma/seed-admin.ts", {
      NODE_ENV: "development",
      SEED_ADMIN_USERNAME: "admin.discreto",
      SEED_ADMIN_PASSWORD: CLAVE_VALIDA,
    });

    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout + r.stderr, "la salida del despliegue queda guardada").not.toContain("admin.discreto");
  });
});
