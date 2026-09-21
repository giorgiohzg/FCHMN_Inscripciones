/**
 * Credenciales del administrador inicial.
 *
 * `SEED_ADMIN_USERNAME` y `SEED_ADMIN_PASSWORD` son obligatorias en TODOS los
 * entornos y no existen valores por omisión: una cuenta de administrador con
 * credenciales previsibles es explotable apenas el puerto queda accesible, y
 * `mustChangePassword` no lo impide porque quien la conoce puede usarla antes
 * que su dueño legítimo.
 *
 * Aquí se prueba la decisión aislada de la base de datos: qué credenciales se
 * aceptan y cuáles hacen fallar el comando.
 */
import { describe, it, expect, vi } from "vitest";
import { resolverCredencialesDeAdmin, ejecutarSeedAdmin } from "../prisma/seed-admin";

const CLAVE_VALIDA = "Marejada2026";

describe("las credenciales son obligatorias en todos los entornos", () => {
  it.each([["production"], ["development"], ["test"]])("sin ninguna de las dos variables se niega a crear nada (NODE_ENV=%s)", (entorno) => {
    const r = resolverCredencialesDeAdmin({ NODE_ENV: entorno });

    expect(r.ok, "no hay credenciales por omisión en ningún entorno").toBe(false);
    if (!r.ok) {
      expect(r.errores.join(" ")).toMatch(/SEED_ADMIN_USERNAME/);
      expect(r.errores.join(" ")).toMatch(/SEED_ADMIN_PASSWORD/);
    }
  });

  it("un entorno SIN NODE_ENV tampoco admite valores por omisión", () => {
    const r = resolverCredencialesDeAdmin({});
    expect(r.ok).toBe(false);
  });

  it.each([["production"], ["development"]])("sin SEED_ADMIN_PASSWORD no procede, aunque el usuario esté definido (%s)", (entorno) => {
    const r = resolverCredencialesDeAdmin({ NODE_ENV: entorno, SEED_ADMIN_USERNAME: "admin.fchmn" });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores.join(" ")).toMatch(/SEED_ADMIN_PASSWORD/);
  });

  it.each([["production"], ["development"]])("sin SEED_ADMIN_USERNAME no procede, aunque la contraseña esté definida (%s)", (entorno) => {
    const r = resolverCredencialesDeAdmin({ NODE_ENV: entorno, SEED_ADMIN_PASSWORD: CLAVE_VALIDA });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores.join(" ")).toMatch(/SEED_ADMIN_USERNAME/);
  });

  it("con ambas definidas y una contraseña que cumple la política, procede", () => {
    const r = resolverCredencialesDeAdmin({
      NODE_ENV: "production",
      SEED_ADMIN_USERNAME: "admin.fchmn",
      SEED_ADMIN_PASSWORD: CLAVE_VALIDA,
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.username).toBe("admin.fchmn");
  });

  /**
   * Una variable DEFINIDA PERO VACÍA llega como `""`, no como `undefined`.
   * Cuenta como ausente, y el motivo del rechazo debe ser la ausencia.
   */
  it.each([
    ["ambas vacías", { SEED_ADMIN_USERNAME: "", SEED_ADMIN_PASSWORD: "" }],
    ["solo espacios", { SEED_ADMIN_USERNAME: "   ", SEED_ADMIN_PASSWORD: "  " }],
    ["contraseña vacía", { SEED_ADMIN_USERNAME: "admin.fchmn", SEED_ADMIN_PASSWORD: "" }],
    ["usuario vacío", { SEED_ADMIN_USERNAME: "", SEED_ADMIN_PASSWORD: CLAVE_VALIDA }],
  ])("una variable definida pero vacía cuenta como ausente (%s)", (_caso, vars) => {
    const r = resolverCredencialesDeAdmin({ NODE_ENV: "development", ...vars });
    expect(r.ok).toBe(false);
  });

  it("una variable vacía se rechaza POR AUSENTE, no por débil", () => {
    const r = resolverCredencialesDeAdmin({
      NODE_ENV: "production",
      SEED_ADMIN_USERNAME: "admin.fchmn",
      SEED_ADMIN_PASSWORD: "",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      const texto = r.errores.join(" ");
      expect(texto, "el motivo debe ser el correcto").toMatch(/obligatoria/i);
      expect(texto).not.toMatch(/política de contraseñas/i);
    }
  });

  it("NINGÚN camino devuelve credenciales por omisión", () => {
    const casos = [
      {},
      { SEED_ADMIN_USERNAME: "admin" },
      { SEED_ADMIN_PASSWORD: "" },
      { SEED_ADMIN_USERNAME: "" },
      { SEED_ADMIN_USERNAME: "   " },
    ];

    for (const entorno of ["production", "development", "test"]) {
      for (const caso of casos) {
        const r = resolverCredencialesDeAdmin({ NODE_ENV: entorno, ...caso });
        expect(r.ok, `caso ${JSON.stringify(caso)} en ${entorno} no puede prosperar`).toBe(false);
      }
    }
  });

  it("el nombre de usuario se normaliza (espacios exteriores)", () => {
    const r = resolverCredencialesDeAdmin({
      NODE_ENV: "development",
      SEED_ADMIN_USERNAME: "  admin.fchmn  ",
      SEED_ADMIN_PASSWORD: CLAVE_VALIDA,
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.username).toBe("admin.fchmn");
  });
});

describe("el nombre de usuario cumple el mismo formato que personas y clubes", () => {
  const base = { NODE_ENV: "production", SEED_ADMIN_PASSWORD: CLAVE_VALIDA };

  it.each([
    ["demasiado corto", "abc"],
    ["demasiado largo", "a".repeat(31)],
    ["con espacio interior", "admin fchmn"],
    ["con arroba (parece correo)", "admin@fchmn.cl"],
    ["con acento", "admín.fchmn"],
    ["con barra", "admin/fchmn"],
  ])("RECHAZA un nombre de usuario %s", (_caso, usuario) => {
    const r = resolverCredencialesDeAdmin({ ...base, SEED_ADMIN_USERNAME: usuario });

    expect(r.ok, "el seed no puede crear un nombre que ningún otro camino admitiría").toBe(false);
    if (!r.ok) expect(r.errores.join(" ")).toMatch(/formato de nombre de usuario/i);
  });

  it.each([["admin.fchmn"], ["admin_fchmn"], ["admin-fchmn"], ["adm1"], ["a".repeat(30)]])(
    "ACEPTA un nombre de usuario válido (%s)",
    (usuario) => {
      const r = resolverCredencialesDeAdmin({ ...base, SEED_ADMIN_USERNAME: usuario });
      expect(r.ok).toBe(true);
    }
  );
});

describe("la contraseña se conserva exactamente como se entregó", () => {
  /**
   * Los espacios exteriores son caracteres legítimos de una contraseña y forman
   * parte del secreto. Recortarlos guardaría el hash de algo distinto de lo que
   * el operador escribió, y el primer ingreso fallaría sin explicación.
   */
  it("NO recorta los espacios exteriores de una contraseña válida", () => {
    const conEspacios = "  Marejada2026  ";
    const r = resolverCredencialesDeAdmin({
      NODE_ENV: "production",
      SEED_ADMIN_USERNAME: "admin.fchmn",
      SEED_ADMIN_PASSWORD: conEspacios,
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.password, "el valor debe llegar intacto al hash").toBe(conEspacios);
      expect(r.password).not.toBe("Marejada2026");
    }
  });

  it("una contraseña que SOLO tiene espacios cuenta como ausente", () => {
    const r = resolverCredencialesDeAdmin({
      NODE_ENV: "production",
      SEED_ADMIN_USERNAME: "admin.fchmn",
      SEED_ADMIN_PASSWORD: "    ",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      const texto = r.errores.join(" ");
      expect(texto).toMatch(/obligatoria/i);
      expect(texto, "el motivo es la ausencia, no la debilidad").not.toMatch(/política de contraseñas/i);
    }
  });

  it("los espacios interiores también se conservan", () => {
    const conEspacioInterior = "Mare jada2026";
    const r = resolverCredencialesDeAdmin({
      NODE_ENV: "production",
      SEED_ADMIN_USERNAME: "admin.fchmn",
      SEED_ADMIN_PASSWORD: conEspacioInterior,
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.password).toBe(conEspacioInterior);
  });
});

/**
 * El ejecutor cierra el cliente SIEMPRE.
 *
 * Con un cliente simulado la desconexión se observa directamente, cosa que
 * desde fuera del proceso es imposible: el código de salida no distingue
 * "cerró y salió" de "salió sin cerrar". Ese era justamente el defecto de
 * `process.exit(1)`, que terminaba el proceso antes del cierre.
 */
describe("el ejecutor desconecta el cliente en todos los caminos", () => {
  const VALIDAS = {
    NODE_ENV: "production",
    SEED_ADMIN_USERNAME: "admin.fchmn",
    SEED_ADMIN_PASSWORD: CLAVE_VALIDA,
  };

  /** Cliente simulado: solo necesita poder cerrarse. */
  function clienteFalso() {
    return { $disconnect: vi.fn().mockResolvedValue(undefined) };
  }

  it("ÉXITO: ejecuta el trabajo, devuelve 0 y desconecta", async () => {
    const cliente = clienteFalso();
    const trabajo = vi.fn().mockResolvedValue(undefined);

    const codigo = await ejecutarSeedAdmin({ cliente, vars: VALIDAS, trabajo, registrarError: () => {} });

    expect(codigo).toBe(0);
    expect(trabajo).toHaveBeenCalledTimes(1);
    expect(trabajo).toHaveBeenCalledWith({ username: "admin.fchmn", password: CLAVE_VALIDA });
    expect(cliente.$disconnect, "el cliente debe cerrarse").toHaveBeenCalledTimes(1);
  });

  it("CREDENCIALES INVÁLIDAS: devuelve 1, NO ejecuta el trabajo y desconecta", async () => {
    const cliente = clienteFalso();
    const trabajo = vi.fn().mockResolvedValue(undefined);
    const errores: string[] = [];

    const codigo = await ejecutarSeedAdmin({
      cliente,
      vars: { NODE_ENV: "production" },
      trabajo,
      registrarError: (m) => errores.push(m),
    });

    expect(codigo).toBe(1);
    expect(trabajo, "sin credenciales no se toca la base").not.toHaveBeenCalled();
    expect(cliente.$disconnect, "aun fallando, el cliente debe cerrarse").toHaveBeenCalledTimes(1);
    expect(errores.join(" ")).toMatch(/SEED_ADMIN_USERNAME/);
    expect(errores.join(" ")).toMatch(/SEED_ADMIN_PASSWORD/);
  });

  it("ERROR DEL TRABAJO: devuelve 1, registra el motivo y desconecta", async () => {
    const cliente = clienteFalso();
    const trabajo = vi.fn().mockRejectedValue(new Error("no existe el rol admin"));
    const errores: string[] = [];

    const codigo = await ejecutarSeedAdmin({ cliente, vars: VALIDAS, trabajo, registrarError: (m) => errores.push(m) });

    expect(codigo).toBe(1);
    expect(cliente.$disconnect, "una excepción tampoco puede saltarse el cierre").toHaveBeenCalledTimes(1);
    expect(errores.join(" ")).toContain("no existe el rol admin");
  });

  it("el motivo registrado nunca incluye la contraseña", async () => {
    const cliente = clienteFalso();
    const trabajo = vi.fn().mockRejectedValue(new Error("fallo cualquiera"));
    const errores: string[] = [];

    await ejecutarSeedAdmin({ cliente, vars: VALIDAS, trabajo, registrarError: (m) => errores.push(m) });

    expect(errores.join(" ")).not.toContain(CLAVE_VALIDA);
  });

  it("si el CIERRE falla tras un trabajo correcto, devuelve 1 y lo registra", async () => {
    const cliente = { $disconnect: vi.fn().mockRejectedValue(new Error("socket ya cerrado")) };
    const trabajo = vi.fn().mockResolvedValue(undefined);
    const errores: string[] = [];

    const codigo = await ejecutarSeedAdmin({ cliente, vars: VALIDAS, trabajo, registrarError: (m) => errores.push(m) });

    expect(trabajo, "el trabajo sí se hizo").toHaveBeenCalledTimes(1);
    expect(codigo, "no puede declararse correcto si la conexión quedó en estado desconocido").toBe(1);
    expect(errores.join(" ")).toMatch(/No se pudo cerrar la conexión/i);
    expect(errores.join(" ")).toContain("socket ya cerrado");
  });

  it("si el CIERRE falla tras un error previo, NO oculta el motivo original", async () => {
    const cliente = { $disconnect: vi.fn().mockRejectedValue(new Error("socket ya cerrado")) };
    const trabajo = vi.fn().mockRejectedValue(new Error("no existe el rol admin"));
    const errores: string[] = [];

    const codigo = await ejecutarSeedAdmin({ cliente, vars: VALIDAS, trabajo, registrarError: (m) => errores.push(m) });

    expect(codigo).toBe(1);
    const texto = errores.join(" ");
    expect(texto, "el motivo original sigue visible").toContain("no existe el rol admin");
    expect(texto, "y el del cierre también").toMatch(/No se pudo cerrar la conexión/i);
  });

  it("un cierre que falla no produce un rechazo sin controlar", async () => {
    const cliente = { $disconnect: vi.fn().mockRejectedValue(new Error("socket ya cerrado")) };
    const trabajo = vi.fn().mockResolvedValue(undefined);

    // Si `ejecutarSeedAdmin` no capturara el fallo del cierre, este `await`
    // rechazaría en vez de resolver con un código.
    await expect(
      ejecutarSeedAdmin({ cliente, vars: VALIDAS, trabajo, registrarError: () => {} })
    ).resolves.toBe(1);
  });
});

describe("la contraseña del administrador cumple la misma política que las demás", () => {
  const base = { NODE_ENV: "production", SEED_ADMIN_USERNAME: "admin.fchmn" };

  it.each([
    ["corta", "Abc12345"],
    ["sin mayúscula", "marejada2026"],
    ["sin minúscula", "MAREJADA2026"],
    ["sin número", "MarejadaChile"],
  ])("RECHAZA una contraseña %s", (_caso, clave) => {
    const r = resolverCredencialesDeAdmin({ ...base, SEED_ADMIN_PASSWORD: clave });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores.join(" ")).toMatch(/política de contraseñas/i);
  });

  it("el mensaje de rechazo no repite la contraseña", () => {
    const r = resolverCredencialesDeAdmin({ ...base, SEED_ADMIN_PASSWORD: "Abc12345" });

    expect(r.ok).toBe(false);
    // El error va a la salida del despliegue, que suele quedar registrada.
    if (!r.ok) expect(r.errores.join(" ")).not.toContain("Abc12345");
  });

  it("la política se aplica también fuera de producción", () => {
    const r = resolverCredencialesDeAdmin({
      NODE_ENV: "development",
      SEED_ADMIN_USERNAME: "admin.fchmn",
      SEED_ADMIN_PASSWORD: "corta",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errores.join(" ")).toMatch(/política de contraseñas/i);
  });
});
