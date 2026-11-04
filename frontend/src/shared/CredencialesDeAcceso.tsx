import type { AccountStatus } from "../modules/persons/personsApi";
import { evaluarUsernameEditado, problemaDeUsername } from "./usernameFormato";

/**
 * Sección «Credenciales de acceso» de las fichas de persona y de club.
 *
 * Reúne el nombre de usuario y la cuenta, que antes vivían separados: el nombre
 * arriba del formulario —obligatorio e inmutable desde el alta— y la cuenta en
 * una sección aparte, solo al editar. Desde la etapa 9 el nombre es OPCIONAL y
 * se puede asignar, cambiar o quitar mientras no haya cuenta; por eso va aquí,
 * junto al botón que la crea.
 *
 * Tres estados, y cada uno se explica:
 *   - ALTA: el campo es editable y opcional; las credenciales se crean después
 *     de guardar. Registrar y dar acceso siguen siendo pasos separados.
 *   - SIN CUENTA: el campo es editable; «Guardar» lo persiste y «Crear
 *     credenciales» lo asigna y crea la cuenta en una sola operación. El botón
 *     no se puede pulsar mientras el nombre esté vacío o mal formado.
 *   - CON CUENTA: el campo queda de solo lectura. Ya es el nombre con el que se
 *     entra; restablecer la contraseña no lo cambia.
 *
 * La validación de aquí (`usernameFormato.ts`) es solo ayuda: quien decide es
 * el servidor.
 */

interface Cuenta {
  username: string;
  /**
   * Desconocido (`undefined`) cuando la cuenta se acaba de crear y la ficha
   * aún no se ha vuelto a leer: la respuesta de la creación confirma el nombre,
   * no el estado, y no se inventa.
   */
  status?: AccountStatus;
}

interface Props {
  /** `alta` en una ficha nueva; `edicion` en una existente. */
  modo: "alta" | "edicion";
  username: string;
  /**
   * Nombre cargado de la ficha. Un nombre anterior a la regla de formato que el
   * usuario no ha tocado no se marca como inválido: se conserva tal cual.
   */
  usernameOriginal?: string | null;
  onUsernameChange: (valor: string) => void;
  /** Cuenta vigente del titular, si la tiene. */
  cuenta: Cuenta | null | undefined;
  onCrearCredenciales: () => void;
  onRestablecerContrasena: () => void;
  creando: boolean;
  mensaje: string | null;
}

export function CredencialesDeAcceso({ modo, username, usernameOriginal, onUsernameChange, cuenta, onCrearCredenciales, onRestablecerContrasena, creando, mensaje }: Props) {
  // En edición, un nombre sin tocar no se valida (ver `evaluarUsernameEditado`).
  const problema = modo === "edicion" ? evaluarUsernameEditado(usernameOriginal, username).problema : problemaDeUsername(username);
  const vacio = username.trim() === "";
  const bloqueado = Boolean(cuenta);

  return (
    <section aria-labelledby="titulo-credenciales" style={{ marginTop: "1.5rem", paddingTop: "1rem", borderTop: "1px solid var(--brand-gray-100)" }}>
      <h2 id="titulo-credenciales" style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>
        Credenciales de acceso
      </h2>

      <label htmlFor="username">Nombre de usuario (para iniciar sesión{bloqueado ? "" : ", opcional"})</label>
      <input
        id="username"
        value={bloqueado ? cuenta!.username : username}
        onChange={(e) => onUsernameChange(e.target.value)}
        placeholder="ej: jperez"
        readOnly={bloqueado}
        disabled={bloqueado}
        aria-invalid={problema ? true : undefined}
        aria-describedby="ayuda-username"
      />
      {problema && !bloqueado && <p className="error-message">{problema}</p>}

      <p id="ayuda-username" style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginTop: "-0.4rem" }}>
        {bloqueado
          ? "No se puede modificar: las credenciales de acceso se crearon con este nombre."
          : modo === "alta"
            ? "Puede dejarlo vacío. Las credenciales se crean después de guardar, con el botón «Crear credenciales»."
            : "Puede asignarlo, cambiarlo o dejarlo vacío mientras no haya credenciales. Una vez creadas, ya no se puede modificar."}
      </p>

      {modo === "edicion" &&
        (bloqueado ? (
          <>
            <p style={{ fontSize: "0.9rem" }}>
              Cuenta activa: <strong>{cuenta!.username}</strong>{" "}
              {cuenta!.status && (
                <span className={`badge ${cuenta!.status === "active" ? "badge-active" : "badge-locked"}`}>{cuenta!.status}</span>
              )}
            </p>
            <button type="button" className="btn-secondary" onClick={onRestablecerContrasena}>
              Restablecer contraseña
            </button>
          </>
        ) : (
          <>
            <p style={{ fontSize: "0.9rem", color: "var(--brand-gray-600)" }}>
              {vacio
                ? "No tiene credenciales de acceso. Escriba un nombre de usuario para poder crearlas."
                : "No tiene credenciales de acceso. Se crearán con el nombre de usuario escrito arriba."}
            </p>
            <button type="button" className="btn-secondary" onClick={onCrearCredenciales} disabled={vacio || Boolean(problema) || creando}>
              {creando ? "Creando..." : "Crear credenciales"}
            </button>
          </>
        ))}

      {mensaje && (
        <p style={{ fontSize: "0.85rem", background: "var(--brand-bg)", padding: "0.75rem", borderRadius: 6, marginTop: "0.75rem" }}>{mensaje}</p>
      )}
    </section>
  );
}
