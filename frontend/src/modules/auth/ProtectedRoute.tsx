import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "./AuthContext";

interface ProtectedRouteProps {
  requiredRole?: string;
}

/**
 * Mientras se restaura la sesión no se decide nada.
 *
 * Al recargar la página no hay access token —vive en memoria y se perdió—, pero
 * la cookie del refresh sigue ahí y la sesión se está recuperando. Sin esta
 * espera, recargar en cualquier pantalla mandaba al usuario al login durante el
 * instante que tarda la renovación, aunque su sesión fuera perfectamente válida.
 */
function Esperando() {
  return <p style={{ padding: "2rem" }}>Restaurando sesión…</p>;
}

/**
 * La restauración falló por algo que NO es una sesión inválida.
 *
 * Antes este caso terminaba igual que "sin sesión" —sin access token y con
 * `restaurando` en false—, así que el guard redirigía a `/login`. Es decir: un
 * 5xx momentáneo o un corte de red expulsaban a un usuario cuya sesión seguía
 * viva en el servidor, perdiendo lo que estuviera haciendo. Aquí no se navega:
 * se explica y se ofrece reintentar.
 */
function SinConexion() {
  const { reintentarRestauracion } = useAuth();
  return (
    <div style={{ padding: "2rem" }} role="alert">
      <h1 style={{ color: "var(--brand-navy)" }}>No se pudo contactar al servidor</h1>
      <p>Su sesión no se ha cerrado. Compruebe su conexión y vuelva a intentarlo.</p>
      <button className="btn-primary" onClick={() => void reintentarRestauracion()}>
        Reintentar
      </button>
    </div>
  );
}

export function ProtectedRoute({ requiredRole }: ProtectedRouteProps) {
  const { accessToken, mustChangePassword, hasRole, restaurando, restauracionFallida } = useAuth();

  if (restaurando) return <Esperando />;

  // Antes de decidir que no hay sesión: ¿es que no la hay, o que no se pudo
  // preguntar?
  if (!accessToken && restauracionFallida) return <SinConexion />;

  if (!accessToken) {
    return <Navigate to="/login" replace />;
  }

  if (mustChangePassword) {
    return <Navigate to="/cambiar-password" replace />;
  }

  if (requiredRole && !hasRole(requiredRole)) {
    return <Navigate to="/no-autorizado" replace />;
  }

  return <Outlet />;
}

/**
 * Exige sesión iniciada pero NO que la contraseña ya esté cambiada.
 *
 * Es el guard de `/cambiar-password`: esa ruta estaba fuera de todo guard, de
 * modo que se podía abrir sin sesión (y el formulario intentaba cambiar la
 * contraseña con `accessToken` nulo). Con `ProtectedRoute` no serviría,
 * porque redirige a `/cambiar-password` justamente cuando el cambio está
 * pendiente, y quedaría en un bucle.
 */
export function RequireSession() {
  const { accessToken, restaurando, restauracionFallida } = useAuth();
  if (restaurando) return <Esperando />;
  if (!accessToken && restauracionFallida) return <SinConexion />;
  if (!accessToken) {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
}
