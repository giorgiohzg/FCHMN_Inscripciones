import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { descartarAvisoDeAcceso, leerAvisoDeAcceso } from "./avisoDeAcceso";
import { AvisosTerceros } from "../../shared/AvisosTerceros";
import { MENSAJE_DE_ACCESO_POR_DEFECTO, leerMensajeDeAcceso } from "./mensajeDeAcceso";
import logo from "../../assets/logo-fchmn.png";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Motivo por el que el servidor terminó la sesión anterior (C-04), si lo hubo.
  const [aviso, setAviso] = useState<string | null>(() => leerAvisoDeAcceso());
  // Mensaje bajo «Ingresar», editable por administración. Empieza con el texto por defecto y lo
  // conserva si la lectura pública falla: el formulario no espera ni depende de ella.
  const [mensaje, setMensaje] = useState(MENSAJE_DE_ACCESO_POR_DEFECTO);

  useEffect(() => {
    const control = new AbortController();
    void leerMensajeDeAcceso(control.signal).then((texto) => {
      if (texto !== null && !control.signal.aborted) setMensaje(texto);
    });
    return () => control.abort();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    descartarAvisoDeAcceso();
    setAviso(null);
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

          {aviso && !error && (
            <p role="status" className="error-message">
              {aviso}
            </p>
          )}

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
            ofrecer un enlace roto. El texto lo edita administración
            (`mensajeDeAcceso.ts`); es texto plano y conserva sus saltos de línea.
          */}
          <p className="auth-help" data-testid="mensaje-de-acceso" style={{ whiteSpace: "pre-line" }}>
            {mensaje}
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
