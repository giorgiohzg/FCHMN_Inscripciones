import { useEffect, useRef, useState, type ReactNode } from "react";
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
const SIDEBAR_WIDTH_KEY = "natacion.sidebarWidth";

/**
 * Límites del ancho de la columna lateral.
 *
 * El mínimo deja sitio al icono y a una etiqueta corta sin que el texto se
 * parta letra a letra; el máximo impide que la columna se coma el contenido.
 */
const ANCHO_MINIMO = 160;
const ANCHO_MAXIMO = 420;
const ANCHO_POR_DEFECTO = 220;

function acotarAncho(px: number): number {
  if (!Number.isFinite(px)) return ANCHO_POR_DEFECTO;
  return Math.min(ANCHO_MAXIMO, Math.max(ANCHO_MINIMO, Math.round(px)));
}

export function AppShell({ children }: AppShellProps) {
  const { user, logout, hasRole } = useAuth();
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  const [ancho, setAncho] = useState<number>(() => {
    try {
      const guardado = localStorage.getItem(SIDEBAR_WIDTH_KEY);
      // Se acota también al LEER: un valor manipulado o de una versión
      // anterior con otros límites no puede dejar la columna inservible.
      return guardado ? acotarAncho(Number(guardado)) : ANCHO_POR_DEFECTO;
    } catch {
      return ANCHO_POR_DEFECTO;
    }
  });
  const [redimensionando, setRedimensionando] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);

  /**
   * Arrastre del manillar.
   *
   * Los oyentes van en `window`, no en el manillar: si fueran suyos, sacar el
   * cursor de esos 6 píxeles —cosa que pasa constantemente al arrastrar—
   * cortaría el gesto. Se limpian siempre en el retorno del efecto, incluso
   * si el componente se desmonta a mitad del arrastre.
   */
  useEffect(() => {
    if (!redimensionando) return;

    function alMover(e: MouseEvent) {
      const izquierda = navRef.current?.getBoundingClientRect().left ?? 0;
      setAncho(acotarAncho(e.clientX - izquierda));
    }
    function alSoltar() {
      setRedimensionando(false);
    }

    window.addEventListener("mousemove", alMover);
    window.addEventListener("mouseup", alSoltar);
    // Mientras se arrastra, el cursor manda en toda la ventana y no se
    // selecciona texto por accidente.
    const cursorPrevio = document.body.style.cursor;
    const seleccionPrevia = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    return () => {
      window.removeEventListener("mousemove", alMover);
      window.removeEventListener("mouseup", alSoltar);
      document.body.style.cursor = cursorPrevio;
      document.body.style.userSelect = seleccionPrevia;
    };
  }, [redimensionando]);

  // Se guarda al terminar el arrastre, no en cada píxel: escribir en
  // `localStorage` decenas de veces por segundo es gratuito para nada.
  useEffect(() => {
    if (redimensionando) return;
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(ancho));
    } catch {
      // Sin `localStorage` (modo privado) solo se pierde la preferencia.
    }
  }, [ancho, redimensionando]);

  /** Teclado: el manillar también se opera con las flechas. */
  function alPulsarTecla(e: React.KeyboardEvent<HTMLDivElement>) {
    const paso = e.shiftKey ? 32 : 8;
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      setAncho((a) => acotarAncho(a - paso));
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setAncho((a) => acotarAncho(a + paso));
    } else if (e.key === "Home") {
      e.preventDefault();
      setAncho(ANCHO_POR_DEFECTO);
    }
  }

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
        <nav
          ref={navRef}
          className={`app-sidebar ${collapsed ? "collapsed" : ""} ${redimensionando ? "resizing" : ""}`}
          style={{ ["--app-sidebar-width" as string]: `${ancho}px` }}
        >
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

          {/*
            Manillar de redimensionado. `separator` con `aria-orientation` es
            el rol que describe exactamente esto: un separador movible entre
            dos regiones. Con `tabIndex` se alcanza por teclado, porque
            arrastrar con el ratón no puede ser la única forma de cambiarlo.
          */}
          {!collapsed && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Ajustar ancho del menú"
              aria-valuenow={ancho}
              aria-valuemin={ANCHO_MINIMO}
              aria-valuemax={ANCHO_MAXIMO}
              tabIndex={0}
              className="app-sidebar-resizer"
              title="Arrastre para ajustar el ancho (flechas ← → con el teclado; Inicio restablece)"
              onMouseDown={(e) => {
                e.preventDefault();
                setRedimensionando(true);
              }}
              onDoubleClick={() => setAncho(ANCHO_POR_DEFECTO)}
              onKeyDown={alPulsarTecla}
            />
          )}
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
