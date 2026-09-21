import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { AvisosTerceros } from "../../shared/AvisosTerceros";
import logo from "../../assets/logo-fchmn.png";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // Se navega con el valor que devuelve `login`, no con el del contexto:
      // ese todavía tiene el estado ANTERIOR al login (React aplica
      // `setState` después de este `await`), así que un usuario con cambio de
      // contraseña pendiente era enviado al panel.
      const session = await login(username, password);
      navigate(session.mustChangePassword ? "/cambiar-password" : "/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al iniciar sesión");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <img src={logo} alt="Federación Chilena Máster de Natación" className="auth-logo" />
        <h1>Sistema de Gestión de Competencias</h1>
        <p className="auth-subtitle">Federación Chilena Máster de Natación</p>

        <form onSubmit={handleSubmit} aria-label="Formulario de inicio de sesión">
          <label htmlFor="username">Nombre de usuario</label>
          <input
            id="username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
          />

          <label htmlFor="password">Contraseña</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />

          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}

          <button type="submit" disabled={loading}>
            {loading ? "Ingresando..." : "Ingresar"}
          </button>

          {/*
            Antes había aquí un enlace a `/olvide-password`, una ruta que
            nunca existió. La recuperación es administrativa: no hay
            auto-servicio por correo, así que se explica qué hacer en vez de
            ofrecer un enlace roto.
          */}
          <p className="auth-help">
            <strong>¿Olvidó su contraseña?</strong> Solicite a un administrador de la Federación que restablezca su acceso: recibirá
            una contraseña temporal y el sistema le pedirá definir una nueva al ingresar.
          </p>
        </form>

        {/*
          También aquí: el JavaScript con código de terceros se descarga ANTES
          de iniciar sesión, así que su atribución no puede quedar detrás de
          una pantalla de acceso.
        */}
        <p className="auth-help auth-avisos">
          <AvisosTerceros />
        </p>
      </div>
    </div>
  );
}
