import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./modules/auth/AuthContext";
import { ToastProvider } from "./shared/ToastProvider";
import { LoginPage } from "./modules/auth/LoginPage";
import { ForceChangePasswordPage } from "./modules/auth/ForceChangePasswordPage";
import { ProtectedRoute, RequireSession, RutaDeAcceso } from "./modules/auth/ProtectedRoute";
import { AppShell } from "./shared/AppShell";
import { PersonsListPage } from "./modules/persons/PersonsListPage";
import { PersonFormPage } from "./modules/persons/PersonFormPage";
import { PersonsBulkImportPage } from "./modules/persons/PersonsBulkImportPage";
import { ClubsListPage } from "./modules/clubs/ClubsListPage";
import { ClubFormPage } from "./modules/clubs/ClubFormPage";
import { SwimmerAssignmentsPage } from "./modules/swimmer-assignment/SwimmerAssignmentsPage";
import { BulkSwimmerAssignmentPage } from "./modules/swimmer-assignment/BulkSwimmerAssignmentPage";
import { CatalogsPage } from "./modules/catalogs/CatalogsPage";
import { CompetitionsListPage } from "./modules/competitions/CompetitionsListPage";
import { CompetitionDetailPage } from "./modules/competitions/CompetitionDetailPage";
import { CompetitionMeetImportPage } from "./modules/competitions/CompetitionMeetImportPage";
import { RegistrationWizardPage } from "./modules/registrations/RegistrationWizardPage";
import { RegistrationWorkspacePage } from "./modules/registrations/RegistrationWorkspacePage";
import { RelayRegistrationWizardPage } from "./modules/relay-registrations/RelayRegistrationWizardPage";
import { RelayWorkspacePage } from "./modules/relay-registrations/RelayWorkspacePage";
import { ReportsPage } from "./modules/reports/ReportsPage";
import { AuditLogPage } from "./modules/audit/AuditLogPage";
import { AdminDashboardPage } from "./modules/dashboard/AdminDashboardPage";
import { useAuth } from "./modules/auth/AuthContext";
import "./theme.css";

// Bienvenida simple para roles no-admin (club/delegado/entrenador). El
// panel con KPIs (sección 21) es exclusivo del administrador — ver
// AdminDashboardPage / DashboardRouter más abajo.
function WelcomePlaceholder() {
  return (
    <AppShell>
      <h1 style={{ color: "var(--brand-navy)" }}>Bienvenido</h1>
      <p>Seleccione un módulo en el menú lateral para comenzar.</p>
    </AppShell>
  );
}

function DashboardRouter() {
  const { hasRole } = useAuth();
  return hasRole("admin") ? <AdminDashboardPage /> : <WelcomePlaceholder />;
}

function InscripcionesRouter() {
  // El Panel de Inscripción se muestra para todos, incluidos los
  // nadadores — el propio panel se adapta internamente según el rol
  // (ver isPureSwimmer dentro de RegistrationWorkspacePage).
  return <RegistrationWorkspacePage />;
}

function InscripcionesRelevosRouter() {
  return <RelayWorkspacePage />;
}

export function App() {
  return (
    <ToastProvider>
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* El formulario es solo para quien no tiene sesión; con sesión lleva al panel. */}
          <Route element={<RutaDeAcceso />}>
            <Route path="/login" element={<LoginPage />} />
          </Route>
          <Route path="/no-autorizado" element={<p>No autorizado</p>} />

          {/* Exige sesión, pero no que la contraseña ya esté cambiada. */}
          <Route element={<RequireSession />}>
            <Route path="/cambiar-password" element={<ForceChangePasswordPage />} />
          </Route>

          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<DashboardRouter />} />
            <Route path="/inscripciones" element={<InscripcionesRouter />} />
            <Route path="/inscripciones/nueva" element={<RegistrationWizardPage />} />
            <Route path="/inscripciones-relevos" element={<InscripcionesRelevosRouter />} />
            <Route path="/inscripciones-relevos/nueva" element={<RelayRegistrationWizardPage />} />
            <Route path="/reportes" element={<ReportsPage />} />
          </Route>

          <Route element={<ProtectedRoute requiredRole="admin" />}>
            <Route path="/auditoria" element={<AuditLogPage />} />
            <Route path="/personas" element={<PersonsListPage />} />
            <Route path="/personas/carga-masiva" element={<PersonsBulkImportPage />} />
            <Route path="/personas/nueva" element={<PersonFormPage />} />
            <Route path="/personas/:id" element={<PersonFormPage />} />
            <Route path="/clubes" element={<ClubsListPage />} />
            <Route path="/clubes/nuevo" element={<ClubFormPage />} />
            <Route path="/clubes/:id" element={<ClubFormPage />} />
            <Route path="/asignaciones" element={<SwimmerAssignmentsPage />} />
            <Route path="/asignaciones/masiva" element={<BulkSwimmerAssignmentPage />} />
            <Route path="/catalogos" element={<CatalogsPage />} />
            <Route path="/competencias" element={<CompetitionsListPage />} />
            <Route path="/competencias/importar" element={<CompetitionMeetImportPage />} />
            <Route path="/competencias/:id" element={<CompetitionDetailPage />} />
          </Route>

          {/*
            La raíz y cualquier ruta desconocida van al panel, y es `ProtectedRoute` quien
            decide: espera la restauración, ofrece reintentar si falló por red, manda al
            login solo si de verdad no hay sesión, y al cambio de contraseña si está
            pendiente. Antes iban directo a `/login`, y con una sesión válida aparentaba
            un cierre de sesión.
          */}
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
    </ToastProvider>
  );
}
