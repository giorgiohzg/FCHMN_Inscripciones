import { useEffect, useState } from "react";
import { AppShell } from "../../shared/AppShell";
import { useMensajeDeAccesoApi, type MensajeDeAccesoAdministrativo } from "../auth/mensajeDeAcceso";

/**
 * MENSAJE DEL LOGIN (exclusiva de administración): el texto que aparece bajo «Ingresar».
 *
 * Texto plano con saltos de línea; no se interpreta HTML. La vista previa lo muestra igual que el
 * login. Un cambio guardado se ve al volver a cargar el login, sin reconstruir ni desplegar la web.
 * La ruta del servidor exige el rol `admin`: esta pantalla solo es la interfaz.
 */
export function MensajeDeAccesoPage() {
  const api = useMensajeDeAccesoApi();
  const [estado, setEstado] = useState<MensajeDeAccesoAdministrativo | null>(null);
  const [texto, setTexto] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    let vigente = true;
    api
      .leer()
      .then((e) => {
        if (!vigente) return;
        setEstado(e);
        setTexto(e.texto);
      })
      .catch((err) => {
        if (vigente) setError(err instanceof Error ? err.message : "No se pudo leer el mensaje del login");
      });
    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const maximo = estado?.maximo ?? 1000;
  const largo = [...texto.replace(/\r\n?/g, "\n").trim()].length;
  const vacio = texto.trim() === "";
  const excede = largo > maximo;
  const sinCambios = estado !== null && texto === estado.texto;
  const problema = vacio ? "El mensaje no puede quedar vacío." : excede ? `El mensaje no puede superar los ${maximo} caracteres.` : null;

  async function guardar() {
    if (problema || guardando) return;
    setGuardando(true);
    setError(null);
    setAviso(null);
    try {
      const r = await api.guardar(texto);
      setEstado(r.mensaje);
      setTexto(r.mensaje.texto);
      setAviso(r.cambio ? "Mensaje guardado. Se verá al volver a cargar la página de inicio de sesión." : "No había cambios que guardar.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar el mensaje");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <AppShell>
      <h1 style={{ color: "var(--brand-navy)" }}>Mensaje del inicio de sesión</h1>
      <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem" }}>
        Texto que aparece en la página de inicio de sesión, debajo del botón «Ingresar». Es texto plano: se conservan los saltos de
        línea y no se interpreta HTML.
      </p>

      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}

      {estado && (
        <div style={{ maxWidth: 720 }}>
          <label htmlFor="mensaje-login">Mensaje</label>
          <textarea
            id="mensaje-login"
            value={texto}
            onChange={(e) => {
              // Bloqueado mientras se guarda: la respuesta reemplaza el texto por el guardado, y
              // una edición hecha entretanto se perdería sin aviso.
              if (guardando) return;
              setTexto(e.target.value);
              setAviso(null);
            }}
            disabled={guardando}
            aria-busy={guardando || undefined}
            rows={6}
            aria-invalid={problema ? true : undefined}
            aria-describedby="mensaje-login-largo"
            style={{ width: "100%", fontFamily: "inherit" }}
          />
          <p id="mensaje-login-largo" style={{ fontSize: "0.78rem", color: excede ? "var(--state-danger)" : "var(--brand-gray-600)", marginTop: "0.25rem" }}>
            {largo} de {maximo} caracteres{estado.porDefecto ? " · Se muestra el texto por defecto." : ""}
          </p>
          {problema && <p className="error-message">{problema}</p>}
          {aviso && <p role="status">{aviso}</p>}

          <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
            <button type="button" className="btn-primary" onClick={() => void guardar()} disabled={Boolean(problema) || guardando || sinCambios}>
              {guardando ? "Guardando..." : "Guardar"}
            </button>
            <button type="button" className="btn-secondary" onClick={() => setTexto(estado.texto)} disabled={guardando || sinCambios}>
              Descartar cambios
            </button>
            <button type="button" className="btn-secondary" onClick={() => setTexto(estado.textoPorDefecto)} disabled={guardando || texto === estado.textoPorDefecto}>
              Usar el texto por defecto
            </button>
          </div>

          <h2 style={{ fontSize: "1rem", color: "var(--brand-navy)", marginTop: "1.5rem" }}>Vista previa</h2>
          <div style={{ background: "var(--brand-white)", border: "1px solid var(--brand-gray-100)", borderRadius: 8, padding: "1rem", maxWidth: 420 }}>
            <p className="auth-help" data-testid="vista-previa-mensaje" style={{ whiteSpace: "pre-line", margin: 0 }}>
              {texto}
            </p>
          </div>
        </div>
      )}
    </AppShell>
  );
}
