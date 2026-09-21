import { useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import logo from "../assets/logo-fchmn.png";
import { AvisosTerceros } from "./AvisosTerceros";
import { useAuth } from "../modules/auth/AuthContext";
import {
  HomeIcon,
  PersonsIcon,
  ClubIcon,
  SwimmerIcon,
  CatalogIcon,
  CompetitionIcon,
  RegistrationIcon,
  RelayIcon,
  ReportsIcon,
  AuditIcon,
  CollapseIcon,
} from "./icons";

interface AppShellProps {
  children: ReactNode;
}

const NAV_ITEMS = [
  { to: "/dashboard", label: "Inicio", icon: HomeIcon, roles: undefined },
  { to: "/personas", label: "Personas", icon: PersonsIcon, roles: ["admin"] },
  { to: "/clubes", label: "Clubes", icon: ClubIcon, roles: ["admin"] },
  { to: "/asignaciones", label: "Asignación de Nadadores", icon: SwimmerIcon, roles: ["admin"] },
  { to: "/catalogos", label: "Catálogos", icon: CatalogIcon, roles: ["admin"] },
  { to: "/competencias", label: "Competencias", icon: CompetitionIcon, roles: ["admin"] },
  { to: "/inscripciones", label: "Inscripciones", icon: RegistrationIcon, roles: undefined },
  { to: "/inscripciones-relevos", label: "Inscripciones de Relevo", icon: RelayIcon, roles: undefined },
  { to: "/reportes", label: "Reportes", icon: ReportsIcon, roles: undefined },
  { to: "/auditoria", label: "Auditoría", icon: AuditIcon, roles: ["admin"] },
];

const SIDEBAR_COLLAPSED_KEY = "natacion.sidebarCollapsed";

export function AppShell({ children }: AppShellProps) {
  const { user, logout, hasRole } = useAuth();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // localStorage puede no estar disponible (modo privado, etc.) — no es crítico, solo no se recuerda la preferencia.
      }
      return next;
    });
  }

  return (
    <div>
      <header className="app-header">
        <img src={logo} alt="Federación Chilena Máster de Natación" />
        <div>
          <div className="app-title">FCHMN — Gestión de Competencias</div>
          <div className="app-subtitle">Federación Chilena Máster de Natación</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "1rem" }}>
          <span style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>{user?.username}</span>
          <button className="btn-secondary" onClick={() => logout()}>
            Cerrar sesión
          </button>
        </div>
      </header>

      <div className="app-shell">
        <nav className={`app-sidebar ${collapsed ? "collapsed" : ""}`}>
          <button
            type="button"
            className="app-sidebar-toggle"
            onClick={toggleCollapsed}
            title={collapsed ? "Expandir menú" : "Contraer menú"}
            aria-label={collapsed ? "Expandir menú" : "Contraer menú"}
          >
            <CollapseIcon />
          </button>
          {NAV_ITEMS.filter((item) => !item.roles || item.roles.some((r) => hasRole(r))).map((item) => {
            const ItemIcon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")} title={collapsed ? item.label : undefined}>
                <ItemIcon className="app-sidebar-icon" />
                <span className="app-sidebar-label">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <main className="app-content">{children}</main>
      </div>

      {/*
        El aviso de terceros acompaña a la aplicación en todas sus vistas: el
        código de terceros se entrega en cada visita, así que su atribución
        debe estar siempre al alcance, no escondida en una pantalla concreta.
      */}
      <footer className="app-footer">
        <AvisosTerceros />
      </footer>
    </div>
  );
}
