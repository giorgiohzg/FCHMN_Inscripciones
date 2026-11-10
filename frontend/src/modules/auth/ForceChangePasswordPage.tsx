import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";

/**
 * Dos usos de la misma pantalla y del mismo flujo (`AuthContext.changePassword` →
 * `/auth/change-password`):
 *
 *   - OBLIGATORIO (`mustChangePassword`): contraseña temporal; no se puede salir sin
 *     cambiarla. No hay `Cancelar`, y el resto de la aplicación redirige aquí.
 *   - VOLUNTARIO (cualquier cuenta con sesión, administración incluida): se llega desde
 *     «Cambiar contraseña» en la cabecera y se puede cancelar para volver al panel sin
 *     enviar nada.
 *
 * El modo se decide con `mustChangePassword` del contexto EN CADA RENDER, no al montar:
 * si otra pestaña o una renovación lo vuelve a poner, el `Cancelar` desaparece.
 */
export function ForceChangePasswordPage() {
  const { changePassword, mustChangePassword } = useAuth();
  const obligatorio = mustChangePassword;
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("Las contraseñas no coinciden");
      return;
    }

    setLoading(true);
    try {
      /**
       * La operación COMPLETA vive en el contexto: petición, cierre del ciclo
       * anterior, adopción de la sesión nueva, token CSRF, perfil persistido y
       * aviso a las demás pestañas, todo bajo el mismo cerrojo que el refresco.
       *
       * Esta página llamaba antes a `apiChangePassword` directamente, así que la
       * petición que reemplaza la cookie de sesión salía FUERA del cerrojo y
       * podía cruzarse con un refresco en vuelo.
       */
      await changePassword({ currentPassword, newPassword, confirmPassword });
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cambiar la contraseña");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="force-change-password-page">
      <form onSubmit={handleSubmit} aria-label={obligatorio ? "Cambio de contraseña obligatorio" : "Cambiar contraseña"}>
        {obligatorio ? (
          <>
            <h1>Debe cambiar su contraseña</h1>
            <p>Por seguridad, debe definir una nueva contraseña antes de continuar.</p>
          </>
        ) : (
          <h1>Cambiar contraseña</h1>
        )}

        <label htmlFor="currentPassword">{obligatorio ? "Contraseña actual (temporal)" : "Contraseña actual"}</label>
        <input
          id="currentPassword"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          required
        />

        <label htmlFor="newPassword">Nueva contraseña</label>
        <input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          required
          minLength={10}
        />
        <small>Mínimo 10 caracteres, con mayúscula, minúscula y número.</small>

        <label htmlFor="confirmPassword">Confirmar nueva contraseña</label>
        <input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          required
        />

        {error && <p role="alert" className="error-message">{error}</p>}

        <div className="force-change-password-acciones">
          <button type="submit" disabled={loading}>
            {loading ? "Guardando..." : obligatorio ? "Guardar y continuar" : "Guardar contraseña"}
          </button>
          {!obligatorio && (
            <button type="button" className="btn-secondary" onClick={() => navigate("/dashboard")} disabled={loading}>
              Cancelar
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
