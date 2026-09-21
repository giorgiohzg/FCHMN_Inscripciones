import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { usePersonsApi, type Person } from "./personsApi";
import { formatRun, isValidRun } from "./runValidator";
import { SwimmerClubSection } from "./SwimmerClubSection";

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
