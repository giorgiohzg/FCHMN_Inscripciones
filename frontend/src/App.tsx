import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "./modules/auth/AuthContext";
import { AccesosProvider } from "./modules/auth/AccesosContext";
import { RequiereFuncion, CambioDeContrasenaPermitido } from "./modules/auth/RequiereFuncion";
import { AccesosPorRolPage } from "./modules/accesos/AccesosPorRolPage";
import { MensajeDeAccesoPage } from "./modules/accesos/MensajeDeAccesoPage";
import { ToastProvider } from "./shared/ToastProvider";
import { LoginPage } from "./modules/auth/LoginPage";
import { ForceChangePasswordPage } from "./modules/auth/ForceChangePasswordPage";
import { ProtectedRoute, RequireSession, RutaDeAcceso, SoloPostulacionDelClub } from "./modules/auth/ProtectedRoute";
import { AppShell } from "./shared/AppShell";
import { PersonsListPage } from "./modules/persons/PersonsListPage";
import { PersonFormPage } from "./modules/persons/PersonFormPage";
import { PersonsBulkImportPage } from "./modules/persons/PersonsBulkImportPage";
import { ClubsListPage } from "./modules/clubs/ClubsListPage";
import { ClubFormPage } from "./modules/clubs/ClubFormPage";
import { SwimmerAssignmentsPage } from "./modules/swimmer-assignment/SwimmerAssignmentsPage";
import { BulkSwimmerAssignmentPage } from "./modules/swimmer-assignment/BulkSwimmerAssignmentPage";
import { PeriodosDeCambioPage } from "./modules/swimmer-assignment/PeriodosDeCambioPage";
import { SolicitudesDeAltaPage } from "./modules/swimmer-assignment/SolicitudesDeAltaPage";
import { IncorporacionesClubPage } from "./modules/swimmer-assignment/IncorporacionesClubPage";
import { CatalogsPage } from "./modules/catalogs/CatalogsPage";
import { CompetitionsListPage } from "./modules/competitions/CompetitionsListPage";
import { CompetitionDetailPage } from "./modules/competitions/CompetitionDetailPage";
import { CompetitionMeetImportPage } from "./modules/competitions/CompetitionMeetImportPage";
import { RegistrationWizardPage } from "./modules/registrations/RegistrationWizardPage";
import { RegistrationWorkspacePage } from "./modules/registrations/RegistrationWorkspacePage";
import { RelayRegistrationWizardPage } from "./modules/relay-registrations/RelayRegistrationWizardPage";
import { RelayWorkspacePage } from "./modules/relay-registrations/RelayWorkspacePage";
import { ReportsPage } from "./modules/reports/ReportsPage";
import { ClubSummaryReportPage } from "./modules/reports/ClubSummaryReportPage";
import { ClubesYNadadoresReportPage } from "./modules/reports/ClubesYNadadoresReportPage";
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
    <AccesosProvider>
      <BrowserRouter>
        <Routes>
          {/* El formulario es solo para quien no tiene sesión; con sesión lleva al panel. */}
          <Route element={<RutaDeAcceso />}>
            <Route path="/login" element={<LoginPage />} />
          </Route>
          <Route path="/no-autorizado" element={<p>No autorizado</p>} />

          {/* Exige sesión, pero no que la contraseña ya esté cambiada. */}
          <Route element={<RequireSession />}>
            {/* El cambio VOLUNTARIO se puede apagar por rol; el obligatorio, nunca. */}
            <Route element={<CambioDeContrasenaPermitido />}>
              <Route path="/cambiar-password" element={<ForceChangePasswordPage />} />
            </Route>
          </Route>

          <Route element={<ProtectedRoute />}>
            <Route path="/dashboard" element={<DashboardRouter />} />
            {/* Accesos por rol: cada pantalla y su asistente, también por URL directa. */}
            <Route element={<RequiereFuncion funciones={["menu.inscripciones"]} titulo="Inscripciones" />}>
              <Route path="/inscripciones" element={<InscripcionesRouter />} />
            </Route>
            <Route element={<RequiereFuncion funciones={["menu.inscripciones", "inscripciones.crear"]} titulo="Nueva inscripción" />}>
              <Route path="/inscripciones/nueva" element={<RegistrationWizardPage />} />
            </Route>
            <Route element={<RequiereFuncion funciones={["menu.relevos"]} titulo="Inscripciones de Relevo" />}>
              <Route path="/inscripciones-relevos" element={<InscripcionesRelevosRouter />} />
            </Route>
            <Route element={<RequiereFuncion funciones={["menu.relevos", "relevos.armar"]} titulo="Nuevo relevo" />}>
              <Route path="/inscripciones-relevos/nueva" element={<RelayRegistrationWizardPage />} />
            </Route>
            <Route element={<RequiereFuncion funciones={["menu.reportes"]} titulo="Reportes" />}>
              <Route path="/reportes" element={<ReportsPage />} />
            </Route>
            {/* C-05, fase 4: cuenta del club y su personal vigente, en su club. No administración ni nadadores. */}
            <Route element={<SoloPostulacionDelClub />}>
              <Route element={<RequiereFuncion funciones={["menu.incorporaciones"]} titulo="Incorporaciones" />}>
                <Route path="/incorporaciones" element={<IncorporacionesClubPage />} />
              </Route>
            </Route>
          </Route>

          <Route element={<ProtectedRoute requiredRole="admin" />}>
            <Route path="/auditoria" element={<AuditLogPage />} />
            {/* Accesos por rol: exclusiva de administración (la API también lo exige). */}
            <Route path="/administracion/accesos" element={<AccesosPorRolPage />} />
            <Route path="/administracion/mensaje-de-acceso" element={<MensajeDeAccesoPage />} />
            {/* Resumen por club: exclusivo de administración (la API también lo exige). */}
            <Route path="/reportes/resumen-por-club" element={<ClubSummaryReportPage />} />
            {/* Clubes y nadadores: exclusivo de administración (la API también lo exige). */}
            <Route path="/reportes/clubes-y-nadadores" element={<ClubesYNadadoresReportPage />} />
            <Route path="/personas" element={<PersonsListPage />} />
            <Route path="/personas/carga-masiva" element={<PersonsBulkImportPage />} />
            <Route path="/personas/nueva" element={<PersonFormPage />} />
            <Route path="/personas/:id" element={<PersonFormPage />} />
            <Route path="/clubes" element={<ClubsListPage />} />
            <Route path="/clubes/nuevo" element={<ClubFormPage />} />
            <Route path="/clubes/:id" element={<ClubFormPage />} />
            <Route path="/asignaciones" element={<SwimmerAssignmentsPage />} />
            <Route path="/asignaciones/masiva" element={<BulkSwimmerAssignmentPage />} />
            {/* C-05: exclusivas de administración (la API también lo exige). */}
            <Route path="/asignaciones/periodos" element={<PeriodosDeCambioPage />} />
            <Route path="/asignaciones/altas" element={<SolicitudesDeAltaPage />} />
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
    </AccesosProvider>
    </AuthProvider>
    </ToastProvider>
  );
}
