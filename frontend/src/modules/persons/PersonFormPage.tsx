import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { usePersonsApi, type Person } from "./personsApi";
import { formatRun, isValidRun } from "./runValidator";
import { SwimmerClubSection } from "./SwimmerClubSection";
import { useAuth } from "../auth/AuthContext";

export function PersonFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id) && id !== "nueva";
  const api = usePersonsApi();
  const navigate = useNavigate();

  const [run, setRun] = useState("");
  const [username, setUsername] = useState("");
  const [firstName, setFirstName] = useState("");
  const [paternalLastName, setPaternalLastName] = useState("");
  const [maternalLastName, setMaternalLastName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [gender, setGender] = useState<"male" | "female" | "">("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [person, setPerson] = useState<Person | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [credentialsMsg, setCredentialsMsg] = useState<string | null>(null);

  const { hasRole, user: usuarioActual, logout, reintentarRestauracion } = useAuth();
  const esAdministrador = hasRole("admin");
  /** ¿La ficha abierta es la de quien está usando el sistema? */
  const esUnoMismo = Boolean(id) && usuarioActual?.personId === id;
  const [adminAccess, setAdminAccess] = useState(false);
  const [guardandoAdmin, setGuardandoAdmin] = useState(false);
  const [adminMsg, setAdminMsg] = useState<string | null>(null);

  /**
   * Concede o retira los permisos, y hace que la sesión afectada deje de
   * mostrar acceso administrativo aparente.
   *
   * SOBRE LA SESIÓN, con precisión. El backend pierde los permisos en la
   * SIGUIENTE solicitud, porque recarga roles de la base en cada una; la
   * revocación de los refresh tokens impide renovar la sesión, pero **no
   * invalida el access token ya emitido**. Lo que evita que la interfaz siga
   * enseñando menús de administrador es esto de aquí:
   *
   *   - si el administrador se quita el permiso A SÍ MISMO, se cierra su
   *     sesión: seguir navegando con una interfaz que promete lo que el
   *     backend ya rechaza es peor que pedirle entrar de nuevo;
   *   - si se lo quita a otra persona, se refresca la ficha; la sesión de esa
   *     persona se corrige en su siguiente recarga de sesión, y mientras
   *     tanto el backend ya la rechaza.
   */
  async function handleAdminAccess(valor: boolean) {
    if (!id) return;
    setAdminMsg(null);
    setGuardandoAdmin(true);
    const anterior = adminAccess;
    setAdminAccess(valor);
    try {
      const resultado = await api.setAdminAccess(id, valor);
      setPerson((p) => (p ? { ...p, adminAccess: resultado.adminAccess } : p));

      if (!valor && esUnoMismo) {
        setAdminMsg("Se retiraron sus propios permisos de administrador. Se cerrará su sesión.");
        await logout();
        return;
      }

      // Recarga la sesión desde el backend para que el menú refleje el
      // cambio sin esperar al próximo refresco automático.
      if (esUnoMismo) await reintentarRestauracion();
      setAdminMsg(
        valor
          ? resultado.tieneCuenta
            ? "Permisos de administrador concedidos."
            : "Marcado. La persona aún no tiene cuenta: use «Crear credenciales» para que el permiso surta efecto."
          : `Permisos de administrador retirados.${resultado.sesionesRevocadas > 0 ? " Se revocaron sus sesiones." : ""}`
      );
    } catch (err) {
      // La casilla vuelve a su valor real: dejarla como la dejó el clic
      // afirmaría un cambio que no ocurrió.
      setAdminAccess(anterior);
      setAdminMsg(err instanceof Error ? err.message : "No se pudo cambiar el permiso de administrador");
    } finally {
      setGuardandoAdmin(false);
    }
  }

  useEffect(() => {
    if (!isEdit) return;
    api.get(id!).then((p) => {
      setPerson(p);
      setRun(p.run);
      setUsername(p.username);
      setFirstName(p.firstName ?? "");
      setPaternalLastName(p.paternalLastName ?? "");
      setMaternalLastName(p.maternalLastName ?? "");
      setBirthDate(p.birthDate.slice(0, 10));
      setGender(p.gender);
      setEmail(p.email ?? "");
      setPhone(p.phone ?? "");
      setAdminAccess(p.adminAccess);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const runValid = isEdit || run.length === 0 || isValidRun(run);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!isEdit && (!firstName.trim() || !paternalLastName.trim())) {
      setError("El nombre y el apellido paterno son obligatorios");
      return;
    }
    if (!gender) {
      setError("Debe indicar el género");
      return;
    }
    if (!isEdit && !isValidRun(run)) {
      setError("El RUN ingresado no es válido");
      return;
    }
    if (!isEdit && username.trim().length < 4) {
      setError("El nombre de usuario debe tener al menos 4 caracteres");
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        // Solo se envían los campos de nombre si el admin realmente los
        // modificó respecto a lo cargado — evita forzar a completar el
        // nombre/apellido paterno de una persona creada antes de este
        // cambio (que puede tenerlos vacíos) solo por editar otro dato
        // sin relación, como el teléfono.
        const nameChanged =
          firstName !== (person?.firstName ?? "") ||
          paternalLastName !== (person?.paternalLastName ?? "") ||
          maternalLastName !== (person?.maternalLastName ?? "");

        await api.update(id!, {
          ...(nameChanged ? { firstName, paternalLastName, maternalLastName: maternalLastName || undefined } : {}),
          birthDate,
          gender,
          email,
          phone: phone || undefined,
        });
      } else {
        await api.create({
          run,
          username,
          firstName,
          paternalLastName,
          maternalLastName: maternalLastName || undefined,
          birthDate,
          gender,
          email,
          phone: phone || undefined,
        });
      }
      navigate("/personas");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la persona");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateCredentials() {
    if (!id) return;
    try {
      const result = await api.createCredentials(id);
      setCredentialsMsg(
        `Credenciales creadas. Usuario: ${result.username} — Contraseña temporal: ${result.temporaryPassword} (comunicar de forma segura; se solicitará cambio en el primer ingreso).`
      );
      const refreshed = await api.get(id);
      setPerson(refreshed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron crear las credenciales");
    }
  }

  async function handleResetCredentials() {
    if (!id) return;
    try {
      const result = await api.resetCredentials(id);
      setCredentialsMsg(
        `Contraseña restablecida. Nueva contraseña temporal: ${result.temporaryPassword} (comunicar de forma segura).`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo restablecer la contraseña");
    }
  }

  return (
    <AppShell>
      <h1 style={{ color: "var(--brand-navy)" }}>{isEdit ? "Editar persona" : "Nueva persona"}</h1>

      <form onSubmit={handleSubmit} style={{ maxWidth: 520 }}>
        <label htmlFor="run">RUN</label>
        <input
          id="run"
          value={run}
          onChange={(e) => setRun(e.target.value)}
          onBlur={() => setRun((r) => (isValidRun(r) ? formatRun(r) : r))}
          placeholder="12.345.678-9"
          disabled={isEdit}
          required
        />
        {!runValid && <p className="error-message">El RUN ingresado no es válido</p>}

        <label htmlFor="username">Nombre de usuario (para iniciar sesión)</label>
        <input
          id="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="ej: jperez"
          disabled={isEdit}
          required
        />
        {isEdit && (
          <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginTop: "-0.4rem" }}>
            El nombre de usuario no se puede modificar una vez creado.
          </p>
        )}

        <label htmlFor="firstName">Nombre</label>
        <input id="firstName" value={firstName} onChange={(e) => setFirstName(e.target.value)} />

        <label htmlFor="paternalLastName">Apellido paterno</label>
        <input id="paternalLastName" value={paternalLastName} onChange={(e) => setPaternalLastName(e.target.value)} />

        <label htmlFor="maternalLastName">Apellido materno (opcional)</label>
        <input id="maternalLastName" value={maternalLastName} onChange={(e) => setMaternalLastName(e.target.value)} />
        {isEdit && !person?.firstName && (
          <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginTop: "-0.4rem" }}>
            Esta persona fue creada antes de separar el nombre en estos 3 campos — actualmente muestra "{person?.fullName}" como nombre completo.
            Complete estos campos si desea actualizarlo.
          </p>
        )}

        <label htmlFor="birthDate">Fecha de nacimiento</label>
        <input id="birthDate" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} required />

        <label htmlFor="gender">Género</label>
        <select id="gender" value={gender} onChange={(e) => setGender(e.target.value as "male" | "female" | "")} required>
          <option value="">Seleccionar...</option>
          <option value="female">Femenino</option>
          <option value="male">Masculino</option>
        </select>

        <label htmlFor="email">Correo electrónico (contacto, opcional)</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />

        <label htmlFor="phone">Teléfono de contacto</label>
        <input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} />

        {error && <p role="alert" className="error-message">{error}</p>}

        <div style={{ display: "flex", gap: "0.75rem", marginTop: "1.5rem" }}>
          <button type="submit" disabled={saving}>
            {saving ? "Guardando..." : "Guardar"}
          </button>
          <button type="button" className="btn-secondary" onClick={() => navigate("/personas")}>
            Cancelar
          </button>
        </div>
      </form>

      {/*
        PERMISOS DE ADMINISTRADOR.
        Solo lo ve un administrador. Ocultarlo no es la barrera: el endpoint
        exige el rol `admin` además del permiso de escritura, así que llamarlo
        directamente tampoco sirve.
      */}
      {isEdit && esAdministrador && (
        <div style={{ marginTop: "2rem", paddingTop: "1.5rem", borderTop: "1px solid var(--brand-gray-100)", maxWidth: 520 }}>
          <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>Permisos de administrador</h2>

          <label style={{ display: "flex", alignItems: "flex-start", gap: "0.5rem", fontWeight: "normal", marginTop: "0.5rem" }}>
            <input
              type="checkbox"
              checked={adminAccess}
              disabled={guardandoAdmin}
              onChange={(e) => handleAdminAccess(e.target.checked)}
              style={{ marginTop: "0.2rem", width: "auto" }}
            />
            <span style={{ fontSize: "0.9rem" }}>Habilitar permisos de administrador</span>
          </label>

          {/*
            Cada estado se explica distinto, y las diferencias importan:

              - con la casilla puesta y sin cuenta NO hay acceso todavía, y
                nadie debe creer que sí;
              - el cierre de sesión solo ocurre cuando uno se retira los
                permisos A SÍ MISMO. Anunciarlo en la ficha de otra persona
                —o cuando no hay nada que retirar— prometía algo que no pasa.
          */}
          <p style={{ fontSize: "0.82rem", color: "var(--brand-gray-600)", marginTop: "0.4rem" }}>
            {adminAccess && !person?.user ? (
              <>
                <strong>Marcado, pero todavía sin acceso.</strong> Esta persona no tiene credenciales, así que aún no puede entrar.
                Guardar la casilla <em>no</em> crea la cuenta ni genera ninguna contraseña. Use «Crear credenciales» más abajo: la cuenta
                nacerá con permisos de administrador, con contraseña temporal y cambio obligatorio en el primer ingreso.
              </>
            ) : adminAccess ? (
              <>
                Su cuenta tiene el rol de administrador. El alcance administrativo prevalece sobre sus demás roles y vínculos con clubes,
                que se conservan. Al retirarlo se quita <em>solo</em> el rol administrativo.
                {esUnoMismo && <> Como son sus propios permisos, se cerrará su sesión.</>}
              </>
            ) : (
              <>
                Esta persona no tiene permisos de administrador. Al concederlos se agrega el rol a su cuenta y conserva los que ya tenga.
              </>
            )}
          </p>

          {adminMsg && (
            <p style={{ fontSize: "0.85rem", background: "var(--brand-bg)", padding: "0.6rem 0.75rem", borderRadius: 6, marginTop: "0.5rem" }}>
              {adminMsg}
            </p>
          )}
        </div>
      )}

      {isEdit && (
        <div style={{ marginTop: "2rem", paddingTop: "1.5rem", borderTop: "1px solid var(--brand-gray-100)", maxWidth: 520 }}>
          <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>Credenciales de acceso</h2>
          {person?.user ? (
            <>
              <p style={{ fontSize: "0.9rem" }}>
                Cuenta activa: <strong>{person.user.username}</strong>{" "}
                <span className={`badge ${person.user.status === "active" ? "badge-active" : "badge-locked"}`}>
                  {person.user.status}
                </span>
              </p>
              <button className="btn-secondary" onClick={handleResetCredentials}>
                Restablecer contraseña
              </button>
            </>
          ) : (
            <>
              <p style={{ fontSize: "0.9rem", color: "var(--brand-gray-600)" }}>
                Esta persona no tiene credenciales de acceso al sistema. Se creará con el nombre de usuario: <strong>{username || "(defina el nombre de usuario arriba)"}</strong>.
              </p>
              <button className="btn-secondary" onClick={handleCreateCredentials}>
                Crear credenciales
              </button>
            </>
          )}
          {credentialsMsg && (
            <p style={{ fontSize: "0.85rem", background: "var(--brand-bg)", padding: "0.75rem", borderRadius: 6, marginTop: "0.75rem" }}>
              {credentialsMsg}
            </p>
          )}
        </div>
      )}

      {isEdit && <SwimmerClubSection personId={id!} />}
    </AppShell>
  );
}
