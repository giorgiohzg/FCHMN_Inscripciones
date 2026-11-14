import { Outlet } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { useAuth } from "./AuthContext";
import { useAccesos } from "./AccesosContext";
import { MENSAJE_FUNCION_DESHABILITADA } from "./mensajeFuncionDeshabilitada";

/** Aviso de pantalla deshabilitada, dentro del marco normal de la aplicación. */
export function AvisoFuncionDeshabilitada({ titulo }: { titulo: string }) {
  return (
    <AppShell>
      <h1 style={{ color: "var(--brand-navy)" }}>{titulo}</h1>
      <p role="alert" style={{ color: "var(--brand-gray-600)" }}>
        {MENSAJE_FUNCION_DESHABILITADA}
      </p>
    </AppShell>
  );
}

/**
 * Aviso de que un editor ABIERTO se cerró porque su acción se deshabilitó para la cuenta mientras
 * se usaba (llegaron funciones efectivas nuevas sin desmontar la pantalla). No se envió nada.
 */
export function AvisoEditorCerrado({ mensaje, alCerrar }: { mensaje: string; alCerrar: () => void }) {
  return (
    <p
      role="status"
      style={{ fontSize: "0.78rem", margin: "0 0 0.5rem", padding: "0.35rem 0.55rem", borderLeft: "3px solid var(--state-warning)", background: "var(--brand-bg)", display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}
    >
      <span>{mensaje}</span>
      <button type="button" className="btn-secondary" style={{ padding: "0.05rem 0.4rem", fontSize: "0.72rem" }} onClick={alCerrar}>
        Entendido
      </button>
    </p>
  );
}

/**
 * Protege una RUTA de la interfaz con funciones del catálogo: si alguna está apagada para esta
 * cuenta, muestra el aviso en vez de la pantalla. Cubre también el acceso por URL directa
 * (por ejemplo, los asistentes `/inscripciones/nueva`, que no tienen enlace). Es solo
 * presentación: el servidor deniega igual las operaciones.
 */
export function RequiereFuncion({ funciones, titulo }: { funciones: string[]; titulo: string }) {
  const { deshabilitada } = useAccesos();
  if (funciones.some(deshabilitada)) return <AvisoFuncionDeshabilitada titulo={titulo} />;
  return <Outlet />;
}

/**
 * La pantalla de cambio de contraseña sirve al cambio OBLIGATORIO y al VOLUNTARIO. Solo el
 * voluntario se puede apagar: con el obligatorio pendiente, la pantalla se muestra siempre, sin
 * mirar la configuración de accesos.
 */
export function CambioDeContrasenaPermitido() {
  const { mustChangePassword } = useAuth();
  const { deshabilitada } = useAccesos();
  if (!mustChangePassword && deshabilitada("cuenta.cambio_voluntario_contrasena")) return <AvisoFuncionDeshabilitada titulo="Cambiar contraseña" />;
  return <Outlet />;
}
