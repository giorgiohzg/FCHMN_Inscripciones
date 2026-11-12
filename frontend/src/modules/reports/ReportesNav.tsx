import { NavLink } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export const RUTA_RESUMEN_POR_CLUB = "/reportes/resumen-por-club";

/**
 * Pestañas de Reportes. Solo administración las ve: los demás roles tienen un único reporte
 * (el listado, acotado a su club o a su persona) y no se les ofrece el resumen. Ocultarlas no
 * es la protección: la ruta del resumen exige el rol y el servidor también lo exige.
 */
export function ReportesNav() {
  const { hasRole } = useAuth();
  if (!hasRole("admin")) return null;

  const estilo = ({ isActive }: { isActive: boolean }) => ({
    padding: "0.4rem 0.8rem",
    borderRadius: "var(--radius-md)",
    textDecoration: "none",
    fontSize: "0.9rem",
    fontWeight: isActive ? 600 : 400,
    color: isActive ? "var(--brand-white)" : "var(--brand-navy)",
    background: isActive ? "var(--brand-navy)" : "transparent",
    border: "1px solid var(--brand-navy)",
  });

  return (
    <nav aria-label="Tipos de reporte" style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", margin: "0.5rem 0 1rem" }}>
      <NavLink to="/reportes" end style={estilo}>
        Listado de inscritos
      </NavLink>
      <NavLink to={RUTA_RESUMEN_POR_CLUB} end style={estilo}>
        Resumen por club
      </NavLink>
    </nav>
  );
}
