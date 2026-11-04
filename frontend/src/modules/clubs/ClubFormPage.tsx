import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { useClubsApi, type Club } from "./clubsApi";
import { formatRun, isValidRun } from "../persons/runValidator";
import { PersonPicker } from "./PersonPicker";
import { PersonMultiPicker } from "./PersonMultiPicker";
import { ClubSwimmersSection } from "../swimmer-assignment/ClubSwimmersSection";
import { CredencialesDeAcceso } from "../../shared/CredencialesDeAcceso";
import { evaluarUsernameEditado, problemaDeUsername } from "../../shared/usernameFormato";

/**
 * Los DOS estados de la personalidad jurídica, como los ve el formulario.
 *
 * Vive como un valor con nombre y no como un booleano suelto para que ninguna
 * comparación por veracidad pueda confundir un club cuyo dato aún no llegó
 * (`undefined`) con «No tiene».
 */
type EstadoPj = "si" | "no";

/**
 * El contrato público solo admite `true` y `false`, y desde la migración 10b la
 * base tampoco admite NULL. Se conserva la tolerancia a un valor ausente (`undefined`
 * mientras la ficha carga, o una respuesta de una API anterior): se presenta como «No
 * tiene», que es en lo que la migración 10a convirtió el antiguo «pendiente».
 */
const aEstadoPj = (v: boolean | null | undefined): EstadoPj => (v === true ? "si" : "no");
const aValorPj = (e: EstadoPj): boolean => e === "si";

export function ClubFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id) && id !== "nuevo";
  const api = useClubsApi();
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [code, setCode] = useState("");
  // Un club nuevo comienza con «No tiene» seleccionado (decisión del usuario).
  const [pjEstado, setPjEstado] = useState<EstadoPj>("no");
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
  const [creandoCredenciales, setCreandoCredenciales] = useState(false);
  /**
   * Cuenta cuya creación CONFIRMÓ el servidor, antes de volver a leer la ficha.
   * Solo lleva lo que la respuesta del POST afirma (el nombre); el estado de la
   * cuenta no se inventa. Bloquea el nombre y el botón aunque la lectura
   * posterior falle o tarde.
   */
  const [cuentaCreada, setCuentaCreada] = useState<{ username: string } | null>(null);
  const cuentaVigente = club?.user ?? cuentaCreada;

  useEffect(() => {
    if (!isEdit) return;
    api.get(id!).then((c) => {
      setClub(c);
      setName(c.name);
      setUsername(c.username ?? "");
      setCode(c.code);
      setPjEstado(aEstadoPj(c.hasLegalStatus));
      setRut(c.rut ?? "");
      setLegalName(c.legalName ?? "");
      setEmail(c.email ?? "");
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
    if (pjEstado !== "si" && representanteActual) {
      setError(
        `Este club tiene a ${representanteActual.person.fullName} designado(a) como representante legal. ` +
          "Retírelo expresamente —con la personalidad jurídica todavía en «Sí»— antes de cambiar el estado."
      );
      return;
    }
    // El nombre de usuario es OPCIONAL. En el alta, si se escribe debe tener
    // formato válido. Al editar solo se valida si CAMBIÓ: un nombre antiguo sin
    // tocar se conserva y no impide guardar otros datos.
    const usernameEditado = evaluarUsernameEditado(club?.username, username);
    const problemaUsername = cuentaVigente ? null : isEdit ? usernameEditado.problema : problemaDeUsername(username);
    if (problemaUsername) {
      setError(problemaUsername);
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
          // Vacío = quitar el correo (`null`); nunca se envía una cadena vacía.
          email: email.trim() || null,
          // Solo si CAMBIÓ y mientras no haya cuenta: sin cambios no se envía
          // (así un nombre antiguo se conserva intacto); con cuenta está
          // bloqueado. Vacío = quitarlo.
          ...(cuentaVigente || !usernameEditado.cambio ? {} : { username: usernameEditado.valor }),
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
          // Vacío = sin nombre de usuario: no se genera ninguno.
          username: username.trim() || null,
          code,
          hasLegalStatus: aValorPj(pjEstado),
          rut: pjEstado === "no" ? undefined : rut.trim() || undefined,
          legalName: legalName || undefined,
          email: email.trim() || null,
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

  /**
   * Asigna el nombre escrito y crea la cuenta en UNA operación del servidor.
   * Si falla, nada cambia: el campo conserva lo escrito y sigue editable.
   */
  async function handleCreateCredentials() {
    if (!id || cuentaVigente) return;
    setError(null);
    setCredentialsMsg(null);
    setCreandoCredenciales(true);

    // 1. Crear la cuenta. Si esto falla, nada cambió: el campo sigue editable.
    //    Sin cambios en el campo se usa el nombre guardado (no se reenvía).
    const editado = evaluarUsernameEditado(club?.username, username);
    let creada: { username: string; temporaryPassword: string };
    try {
      creada = await api.createCredentials(id, editado.cambio ? editado.valor : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron crear las credenciales");
      setCreandoCredenciales(false);
      return;
    }

    // 2. El servidor CONFIRMÓ la creación: se registra antes de depender de
    //    nada más. Desde aquí el nombre está bloqueado y no se ofrece repetirla.
    setCuentaCreada({ username: creada.username });
    setUsername(creada.username);
    setCredentialsMsg(`Credenciales creadas. Usuario: ${creada.username} — Contraseña temporal: ${creada.temporaryPassword}`);
    setCreandoCredenciales(false);

    // 3. Releer la ficha. Un fallo aquí NO es un fallo de la creación.
    try {
      setClub(await api.get(id));
    } catch (err) {
      setError(
        `Las credenciales se crearon correctamente, pero no se pudo actualizar la ficha${err instanceof Error ? `: ${err.message}` : ""}. ` +
          "Recargue la página para ver el estado actual."
      );
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

        <label htmlFor="code">Sigla (máx. 5 caracteres)</label>
        <input
          id="code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={5}
          placeholder="ej: SINT"
          required
        />

        <label style={{ marginTop: "1rem" }}>Personalidad jurídica</label>
        <div style={{ display: "flex", gap: "1.25rem", flexWrap: "wrap" }}>
          {([
            ["si", "Sí, tiene"],
            ["no", "No tiene"],
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
        {pjEstado !== "no" && (
          <>
            <label htmlFor="rut">RUT</label>
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

        <label htmlFor="email">Correo electrónico (contacto, opcional)</label>
        <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />

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
            Solo los clubes con personalidad jurídica pueden tener representante legal.
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

        <CredencialesDeAcceso
          modo={isEdit ? "edicion" : "alta"}
          username={username}
          onUsernameChange={setUsername}
          usernameOriginal={club?.username}
          cuenta={cuentaVigente}
          onCrearCredenciales={handleCreateCredentials}
          onRestablecerContrasena={handleResetCredentials}
          creando={creandoCredenciales}
          mensaje={credentialsMsg}
        />

        {error && <p role="alert" className="error-message">{error}</p>}

        <div style={{ display: "flex", gap: "0.75rem", marginTop: "1.5rem" }}>
          <button type="submit" disabled={saving}>{saving ? "Guardando..." : "Guardar"}</button>
          <button type="button" className="btn-secondary" onClick={() => navigate("/clubes")}>Cancelar</button>
        </div>
      </form>

      {isEdit && <ClubSwimmersSection clubId={id!} />}
    </AppShell>
  );
}
