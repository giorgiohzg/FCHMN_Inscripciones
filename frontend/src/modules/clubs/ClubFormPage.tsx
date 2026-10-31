import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { useClubsApi, type Club } from "./clubsApi";
import { formatRun, isValidRun } from "../persons/runValidator";
import { PersonPicker } from "./PersonPicker";
import { PersonMultiPicker } from "./PersonMultiPicker";
import { ClubSwimmersSection } from "../swimmer-assignment/ClubSwimmersSection";

/**
 * Los TRES estados de la personalidad jurídica, como los ve el formulario.
 *
 * Una casilla de verificación no puede expresar tres cosas, y el estado
 * «pendiente de verificar» no es «no»: el booleano del servidor es
 * `true | false | null` y aquí vive como un valor con nombre, para que ninguna
 * comparación por veracidad pueda confundir «pendiente» con «no».
 */
type EstadoPj = "si" | "no" | "pendiente";

const aEstadoPj = (v: boolean | null | undefined): EstadoPj => (v === true ? "si" : v === false ? "no" : "pendiente");
const aValorPj = (e: EstadoPj): boolean | null => (e === "si" ? true : e === "no" ? false : null);

export function ClubFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id) && id !== "nuevo";
  const api = useClubsApi();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  // Un club nuevo nace PENDIENTE: nadie ha verificado nada todavía. Antes nacía
  // en `false`, que afirmaba «no tiene personalidad jurídica» sin comprobarlo.
  const [pjEstado, setPjEstado] = useState<EstadoPj>("pendiente");
  const [rut, setRut] = useState("");
  const [legalName, setLegalName] = useState("");
  const [email, setEmail] = useState("");
  const [delegatePersonIds, setDelegatePersonIds] = useState<string[]>([]);
  const [coachPersonIds, setCoachPersonIds] = useState<string[]>([]);
  const [legalRepresentativePersonId, setLegalRepresentativePersonId] = useState<string | null>(null);
  const [achmnStatus, setAchmnStatus] = useState<"member" | "collaborator" | "">("");
  const [fchmnStatus, setFchmnStatus] = useState<"member" | "collaborator" | "">("");
  const [club, setClub] = useState<Club | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [credentialsMsg, setCredentialsMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit) return;
    api.get(id!).then((c) => {
      setClub(c);
      setName(c.name);
      setUsername(c.username);
      setCode(c.code);
      setPjEstado(aEstadoPj(c.hasLegalStatus));
      setRut(c.rut ?? "");
      setLegalName(c.legalName ?? "");
      setEmail(c.email);
      setDelegatePersonIds(c.staff.filter((s) => s.roleType === "delegate").map((s) => s.person.id));
      setCoachPersonIds(c.staff.filter((s) => s.roleType === "coach").map((s) => s.person.id));
      setLegalRepresentativePersonId(c.staff.find((s) => s.roleType === "legal_representative")?.person.id ?? null);
      setAchmnStatus(c.isAchmnMember ? "member" : c.isAchmnCollaborator ? "collaborator" : "");
      setFchmnStatus(c.isFchmnMember ? "member" : c.isFchmnCollaborator ? "collaborator" : "");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // El RUT se valida siempre que haya uno, salvo cuando el club está verificado
  // como SIN personalidad jurídica (ahí no se guarda).
  const rutValid = pjEstado === "no" || rut.length === 0 || isValidRun(rut);
  const representanteActual = club?.staff.find((s) => s.roleType === "legal_representative") ?? null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (pjEstado === "si" && !isValidRun(rut)) {
      setError("El RUT es obligatorio y debe ser válido para clubes con personalidad jurídica");
      return;
    }
    // Pendiente: el RUT es opcional, pero si se escribe uno tiene que ser válido.
    if (pjEstado === "pendiente" && rut.trim().length > 0 && !isValidRun(rut)) {
      setError("El RUT ingresado no es válido. Déjelo en blanco si todavía no lo tiene.");
      return;
    }
    if (pjEstado !== "si" && representanteActual) {
      setError(
        `Este club tiene a ${representanteActual.person.fullName} designado(a) como representante legal. ` +
          "Retírelo expresamente —con la personalidad jurídica todavía en «Sí»— antes de cambiar el estado."
      );
      return;
    }
    if (!isEdit && username.trim().length < 4) {
      setError("El nombre de usuario debe tener al menos 4 caracteres");
      return;
    }
    if (code.trim().length === 0 || code.trim().length > 5) {
      setError("La sigla es obligatoria y debe tener máximo 5 caracteres");
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        await api.update(id!, {
          name,
          code,
          hasLegalStatus: aValorPj(pjEstado),
          rut: pjEstado === "no" ? undefined : rut.trim() || undefined,
          legalName: legalName || undefined,
          email,
          delegatePersonIds,
          coachPersonIds,
          legalRepresentativePersonId: pjEstado === "si" ? legalRepresentativePersonId : null,
          isAchmnMember: achmnStatus === "member",
          isAchmnCollaborator: achmnStatus === "collaborator",
          isFchmnMember: fchmnStatus === "member",
          isFchmnCollaborator: fchmnStatus === "collaborator",
        });
      } else {
        await api.create({
          name,
          username,
          code,
          hasLegalStatus: aValorPj(pjEstado),
          rut: pjEstado === "no" ? undefined : rut.trim() || undefined,
          legalName: legalName || undefined,
          email,
          delegatePersonIds,
          coachPersonIds,
          legalRepresentativePersonId: pjEstado === "si" ? legalRepresentativePersonId : null,
          isAchmnMember: achmnStatus === "member",
          isAchmnCollaborator: achmnStatus === "collaborator",
          isFchmnMember: fchmnStatus === "member",
          isFchmnCollaborator: fchmnStatus === "collaborator",
        });
      }
      navigate("/clubes");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el club");
    } finally {
      setSaving(false);
    }
  }

  async function handleCreateCredentials() {
    if (!id) return;
    try {
      const result = await api.createCredentials(id);
      setCredentialsMsg(`Credenciales creadas. Usuario: ${result.username} — Contraseña temporal: ${result.temporaryPassword}`);
      setClub(await api.get(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron crear las credenciales");
    }
  }

  async function handleResetCredentials() {
    if (!id) return;
    try {
      const result = await api.resetCredentials(id);
      setCredentialsMsg(`Contraseña restablecida. Nueva contraseña temporal: ${result.temporaryPassword}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo restablecer la contraseña");
    }
  }

  return (
    <AppShell>
      <h1 style={{ color: "var(--brand-navy)" }}>{isEdit ? "Editar club" : "Nuevo club"}</h1>

      <form onSubmit={handleSubmit} style={{ maxWidth: 560 }}>
        <label htmlFor="name">Nombre del club</label>
        <input id="name" value={name} onChange={(e) => setName(e.target.value)} required />

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "0.75rem" }}>
          <div>
            <label htmlFor="username">Nombre de usuario (para iniciar sesión)</label>
            <input
              id="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="ej: club_delfines"
              disabled={isEdit}
              required
            />
          </div>
          <div>
            <label htmlFor="code">Sigla (máx. 5 caracteres)</label>
            <input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={5}
              placeholder="ej: SINT"
              required
            />
          </div>
        </div>
        {isEdit && (
          <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginTop: "-0.4rem" }}>
            El nombre de usuario no se puede modificar una vez creado.
          </p>
        )}

        <label style={{ marginTop: "1rem" }}>Personalidad jurídica</label>
        <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap" }}>
          {([
            ["si", "Sí, tiene"],
            ["no", "No tiene"],
            ["pendiente", "Pendiente de verificar"],
          ] as [EstadoPj, string][]).map(([valor, etiqueta]) => (
            <label key={valor} style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
              <input
                type="radio"
                name="personalidadJuridica"
                checked={pjEstado === valor}
                onChange={() => setPjEstado(valor)}
                style={{ width: "auto" }}
              />
              {etiqueta}
            </label>
          ))}
        </div>
        {pjEstado === "pendiente" && (
          <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginTop: "0.25rem" }}>
            «Pendiente de verificar» no es lo mismo que «No tiene»: queda registrado que el dato todavía no se ha comprobado.
            El RUT es opcional y no se puede designar representante legal.
          </p>
        )}

        {pjEstado !== "no" && (
          <>
            <label htmlFor="rut">RUT{pjEstado === "pendiente" && " (opcional mientras esté pendiente)"}</label>
            <input
              id="rut"
              value={rut}
              onChange={(e) => setRut(e.target.value)}
              onBlur={() => setRut((r) => (isValidRun(r) ? formatRun(r) : r))}
              placeholder="76.123.456-7"
              required={pjEstado === "si"}
            />
            {!rutValid && <p className="error-message">El RUT ingresado no es válido</p>}

            <label htmlFor="legalName">Razón social</label>
            <input id="legalName" value={legalName} onChange={(e) => setLegalName(e.target.value)} />
          </>
        )}

        <label htmlFor="email">Correo electrónico (contacto)</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />

        <div style={{ marginTop: "0.9rem" }}>
          <PersonMultiPicker label="Delegado(a) — puede agregar más de uno" values={delegatePersonIds} onChange={setDelegatePersonIds} />
        </div>
        <div style={{ marginTop: "0.9rem" }}>
          <PersonMultiPicker label="Entrenador(a) — puede agregar más de uno" values={coachPersonIds} onChange={setCoachPersonIds} />
        </div>
        {pjEstado === "si" ? (
          <div style={{ marginTop: "0.9rem" }}>
            <PersonPicker label="Representante legal" value={legalRepresentativePersonId} onChange={setLegalRepresentativePersonId} />
          </div>
        ) : (
          <p style={{ fontSize: "0.78rem", color: "var(--brand-gray-600)", marginTop: "0.9rem" }}>
            {pjEstado === "pendiente"
              ? "No se puede designar representante legal mientras la personalidad jurídica esté pendiente de verificar: es un rol con acceso al sistema."
              : "Solo los clubes con personalidad jurídica pueden tener representante legal."}
            {representanteActual &&
              ` Actualmente está designado(a) ${representanteActual.person.fullName}; hay que retirarlo con el estado en «Sí» antes de cambiarlo.`}
          </p>
        )}

        <label style={{ marginTop: "1rem" }}>Membresía ACHMN</label>
        <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
            <input type="radio" name="achmnStatus" checked={achmnStatus === ""} onChange={() => setAchmnStatus("")} style={{ width: "auto" }} />
            Ninguno
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
            <input type="radio" name="achmnStatus" checked={achmnStatus === "member"} onChange={() => setAchmnStatus("member")} style={{ width: "auto" }} />
            Socio ACHMN
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
            <input type="radio" name="achmnStatus" checked={achmnStatus === "collaborator"} onChange={() => setAchmnStatus("collaborator")} style={{ width: "auto" }} />
            Colaborador ACHMN
          </label>
        </div>

        <label style={{ marginTop: "1rem" }}>Membresía FCHMN</label>
        <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
            <input type="radio" name="fchmnStatus" checked={fchmnStatus === ""} onChange={() => setFchmnStatus("")} style={{ width: "auto" }} />
            Ninguno
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
            <input type="radio" name="fchmnStatus" checked={fchmnStatus === "member"} onChange={() => setFchmnStatus("member")} style={{ width: "auto" }} />
            Socio FCHMN
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontWeight: 400 }}>
            <input type="radio" name="fchmnStatus" checked={fchmnStatus === "collaborator"} onChange={() => setFchmnStatus("collaborator")} style={{ width: "auto" }} />
            Colaborador FCHMN
          </label>
        </div>

        {error && <p role="alert" className="error-message">{error}</p>}

        <div style={{ display: "flex", gap: "0.75rem", marginTop: "1.5rem" }}>
          <button type="submit" disabled={saving}>{saving ? "Guardando..." : "Guardar"}</button>
          <button type="button" className="btn-secondary" onClick={() => navigate("/clubes")}>Cancelar</button>
        </div>
      </form>

      {isEdit && (
        <div style={{ marginTop: "2rem", paddingTop: "1.5rem", borderTop: "1px solid var(--brand-gray-100)", maxWidth: 560 }}>
          <h2 style={{ fontSize: "1.05rem", color: "var(--brand-navy)" }}>Credenciales de acceso</h2>
          {club?.user ? (
            <>
              <p style={{ fontSize: "0.9rem" }}>
                Cuenta activa: <strong>{club.user.username}</strong>{" "}
                <span className={`badge ${club.user.status === "active" ? "badge-active" : "badge-locked"}`}>{club.user.status}</span>
              </p>
              <button className="btn-secondary" onClick={handleResetCredentials}>Restablecer contraseña</button>
            </>
          ) : (
            <>
              <p style={{ fontSize: "0.9rem", color: "var(--brand-gray-600)" }}>Este club no tiene credenciales de acceso al sistema.</p>
              <button className="btn-secondary" onClick={handleCreateCredentials}>Crear credenciales</button>
            </>
          )}
          {credentialsMsg && (
            <p style={{ fontSize: "0.85rem", background: "var(--brand-bg)", padding: "0.75rem", borderRadius: 6, marginTop: "0.75rem" }}>
              {credentialsMsg}
            </p>
          )}
        </div>
      )}

      {isEdit && <ClubSwimmersSection clubId={id!} />}
    </AppShell>
  );
}
