import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "../../shared/AppShell";
import { ApiError } from "../../shared/apiClient";
import {
  NOMBRE_DEL_ROL,
  ROLES,
  diferencias,
  useAccesosApi,
  type Cambio,
  type ConfiguracionDeAccesos,
  type FuncionDescrita,
  type RolConfigurable,
  type Valores,
} from "./accesosApi";

/**
 * ACCESOS POR ROL — pantalla exclusiva de administración (opción A: solo restringir y restituir).
 *
 * Filas: menús con sus acciones anidadas, y las funciones de cuenta. Columnas: Nadador, Delegado y
 * Entrenador. Administración no es una columna: su acceso es siempre completo. La cuenta de club y
 * el representante legal no se configuran.
 *
 *  - «No aplica»: la función no existe hoy para ese rol; no hay casilla (la configuración nunca
 *    concede).
 *  - Apagar un menú desactiva sus acciones sin borrar sus casillas: al volver a encenderlo, se
 *    conservan.
 *  - Guardar muestra antes un resumen de los cambios. Se guarda el estado completo con la versión
 *    leída: si otra administración guardó entretanto, el servidor responde 409; la pantalla carga el
 *    estado vigente, muestra qué cambió la otra persona y conserva lo que se estaba marcando para
 *    revisarlo. No hay reintentos automáticos.
 */

const SISTEMA = true; // valor del sistema de cada celda configurable: encendida

function copiar(v: Valores): Valores {
  return { swimmer: { ...v.swimmer }, delegate: { ...v.delegate }, coach: { ...v.coach } };
}

function fechaLegible(iso: string): string {
  return new Date(iso).toLocaleString("es-CL", { dateStyle: "long", timeStyle: "short", timeZone: "America/Santiago" });
}

type Aviso = { tipo: "exito" | "error" | "conflicto"; texto: string } | null;

export function AccesosPorRolPage() {
  const api = useAccesosApi();
  const [config, setConfig] = useState<ConfiguracionDeAccesos | null>(null);
  const [borrador, setBorrador] = useState<Valores | null>(null);
  const [cargando, setCargando] = useState(true);
  const [errorDeCarga, setErrorDeCarga] = useState<string | null>(null);
  const [revisando, setRevisando] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<Aviso>(null);
  /** Lo que cambió OTRA administración, tras un 409. */
  const [cambiosAjenos, setCambiosAjenos] = useState<Cambio[]>([]);
  /** Lecturas superpuestas: solo la última se aplica. */
  const lectura = useRef(0);

  const cargar = useCallback(() => {
    const n = ++lectura.current;
    setCargando(true);
    setErrorDeCarga(null);
    api
      .leer()
      .then((c) => {
        if (n !== lectura.current) return;
        setConfig(c);
        setBorrador(copiar(c.valores));
        setCambiosAjenos([]);
      })
      .catch((err) => {
        if (n !== lectura.current) return;
        setErrorDeCarga(err instanceof Error ? err.message : "No se pudo cargar la configuración de accesos.");
      })
      .finally(() => {
        if (n === lectura.current) setCargando(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  const pendientes = config && borrador ? diferencias(config.valores, borrador, config.grupos) : [];

  function marcar(rol: RolConfigurable, funcion: string, valor: boolean) {
    if (guardando) return;
    setBorrador((b) => (b ? { ...b, [rol]: { ...b[rol], [funcion]: valor } } : b));
    setRevisando(false);
    setAviso(null);
  }

  function restablecerRol(rol: RolConfigurable) {
    if (!config || guardando) return;
    setBorrador((b) => (b ? { ...b, [rol]: Object.fromEntries(Object.keys(config.valores[rol]).map((f) => [f, SISTEMA])) } : b));
    setRevisando(false);
    setAviso(null);
  }

  function cancelarCambios() {
    if (!config || guardando) return;
    setBorrador(copiar(config.valores));
    setRevisando(false);
    setAviso(null);
  }

  async function confirmarGuardado() {
    if (!config || !borrador || guardando || pendientes.length === 0) return;
    setGuardando(true);
    setAviso(null);
    try {
      const r = await api.guardar(config.version, borrador);
      setConfig(r.configuracion);
      setBorrador(copiar(r.configuracion.valores));
      setCambiosAjenos([]);
      setRevisando(false);
      setAviso({ tipo: "exito", texto: `Cambios guardados (versión ${r.configuracion.version}). Rigen desde la siguiente solicitud de cada cuenta.` });
    } catch (err) {
      const vigente = err instanceof ApiError && err.status === 409 && err.code === "CONFIGURACION_CAMBIADA" ? (err.details as { vigente?: unknown } | undefined)?.vigente : undefined;
      if (vigente && typeof vigente === "object" && "valores" in vigente && "version" in vigente) {
        const v = vigente as Pick<ConfiguracionDeAccesos, "version" | "valores" | "ultimaModificacion">;
        // El catálogo no cambia entre versiones: se conserva el de la lectura anterior.
        setCambiosAjenos(diferencias(config.valores, v.valores, config.grupos));
        /**
         * El borrador se REHACE sobre el estado vigente con SOLO los cambios de esta persona
         * (respecto de lo que leyó). Conservar el borrador entero revertiría, al confirmar, lo que
         * la otra persona cambió en celdas que esta no tocó.
         */
        const propios = diferencias(config.valores, borrador, config.grupos);
        const rehecho = copiar(v.valores);
        for (const c of propios) rehecho[c.rol][c.funcion] = c.despues;
        setBorrador(rehecho);
        setConfig({ ...config, version: v.version, valores: v.valores, ultimaModificacion: v.ultimaModificacion });
        setRevisando(true);
        setAviso({
          tipo: "conflicto",
          texto: `Otra persona guardó cambios mientras usted editaba (versión ${v.version}). No se guardó nada suyo. Revise los cambios de la otra persona y los suyos, y vuelva a confirmar si corresponde.`,
        });
      } else {
        setAviso({ tipo: "error", texto: err instanceof Error ? err.message : "No se pudo guardar la configuración." });
      }
    } finally {
      setGuardando(false);
    }
  }

  return (
    <AppShell>
      <h1 style={{ color: "var(--brand-navy)" }}>Accesos por rol</h1>
      <p style={{ color: "var(--brand-gray-600)", fontSize: "0.9rem", maxWidth: 820 }}>
        Elija qué menús y acciones tienen disponibles el nadador, el delegado y el entrenador. Solo se pueden <strong>restringir y restituir</strong> los
        accesos que cada rol ya tiene: nada se concede. Si una persona tiene varios roles, se suman. Administración conserva siempre el acceso completo; la
        cuenta de club y el representante legal conservan sus atribuciones actuales.
      </p>

      {cargando && !config && <p role="status">Cargando configuración…</p>}
      {errorDeCarga && (
        <p className="error-message" role="alert">
          {errorDeCarga}{" "}
          <button type="button" className="btn-secondary" onClick={cargar}>
            Reintentar
          </button>
        </p>
      )}

      {config && borrador && (
        <>
          <p style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }} aria-live="polite">
            {config.ultimaModificacion
              ? `Última modificación: ${fechaLegible(config.ultimaModificacion.en)}${config.ultimaModificacion.por ? `, por ${config.ultimaModificacion.por.username}` : ""} (versión ${config.version}).`
              : "Sin modificaciones: rigen los valores del sistema."}
          </p>

          <div className="accesos-contenedor">
            <table className="data-table accesos-tabla">
              <caption className="sr-only">Funciones configurables por rol</caption>
              <thead>
                <tr>
                  <th scope="col">Función</th>
                  {ROLES.map((rol) => (
                    <th scope="col" key={rol} style={{ textAlign: "center" }}>
                      {NOMBRE_DEL_ROL[rol]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {config.grupos.map((g) => (
                  <FilasDelGrupo key={g.menu?.id ?? "cuenta"} grupo={g} borrador={borrador} marcar={marcar} deshabilitado={guardando} />
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Restablecer</th>
                  {ROLES.map((rol) => (
                    <td key={rol} style={{ textAlign: "center" }} data-rol={NOMBRE_DEL_ROL[rol]}>
                      <button type="button" className="btn-secondary accesos-restablecer" onClick={() => restablecerRol(rol)} disabled={guardando}>
                        Valores del sistema: {NOMBRE_DEL_ROL[rol]}
                      </button>
                    </td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>

          <p style={{ fontSize: "0.8rem", color: "var(--brand-gray-600)", maxWidth: 820 }}>
            Siempre disponibles, fuera de esta configuración: {config.siempreDisponibles.join("; ")}. Los cambios rigen en el servidor desde la siguiente
            solicitud de cada cuenta; en una sesión abierta, los menús pueden tardar hasta la siguiente renovación en reflejarlos.
          </p>

          {aviso && (
            <p className={aviso.tipo === "exito" ? "aviso" : "error-message"} role={aviso.tipo === "exito" ? "status" : "alert"}>
              {aviso.texto}
            </p>
          )}

          {cambiosAjenos.length > 0 && (
            <section aria-label="Cambios de la otra persona" className="aviso">
              <strong>Cambios de la otra persona:</strong>
              <ListaDeCambios cambios={cambiosAjenos} />
            </section>
          )}

          {revisando && pendientes.length > 0 && (
            <section aria-label="Resumen de cambios" className="aviso" style={{ marginTop: "0.75rem" }}>
              <strong>Se guardarán {pendientes.length === 1 ? "este cambio" : `estos ${pendientes.length} cambios`}:</strong>
              <ListaDeCambios cambios={pendientes} />
            </section>
          )}
          {revisando && pendientes.length === 0 && <p className="aviso">No quedan cambios pendientes respecto del estado vigente.</p>}

          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", marginTop: "1rem" }}>
            {!revisando ? (
              <button type="button" className="btn-primary" onClick={() => setRevisando(true)} disabled={pendientes.length === 0 || guardando}>
                Revisar y guardar{pendientes.length > 0 ? ` (${pendientes.length})` : ""}
              </button>
            ) : (
              <button type="button" className="btn-primary" onClick={() => void confirmarGuardado()} disabled={pendientes.length === 0 || guardando}>
                {guardando ? "Guardando…" : "Confirmar y guardar"}
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={cancelarCambios} disabled={pendientes.length === 0 || guardando}>
              Cancelar cambios
            </button>
          </div>
        </>
      )}
    </AppShell>
  );
}

function ListaDeCambios({ cambios }: { cambios: Cambio[] }) {
  return (
    <ul style={{ margin: "0.35rem 0 0", paddingLeft: "1.2rem" }}>
      {cambios.map((c) => (
        <li key={`${c.rol}:${c.funcion}`}>
          {NOMBRE_DEL_ROL[c.rol]} — {c.etiqueta}: {c.despues ? "se restituye" : "se restringe"}
        </li>
      ))}
    </ul>
  );
}

function FilasDelGrupo({
  grupo,
  borrador,
  marcar,
  deshabilitado,
}: {
  grupo: ConfiguracionDeAccesos["grupos"][number];
  borrador: Valores;
  marcar: (rol: RolConfigurable, funcion: string, valor: boolean) => void;
  deshabilitado: boolean;
}) {
  const menu = grupo.menu;
  return (
    <>
      {menu ? (
        <tr className="accesos-menu">
          <th scope="row">Menú «{menu.etiqueta}»</th>
          {ROLES.map((rol) => (
            <Celda key={rol} rol={rol} funcion={menu} etiqueta={`Menú ${menu.etiqueta}`} borrador={borrador} marcar={marcar} deshabilitado={deshabilitado} />
          ))}
        </tr>
      ) : (
        <tr className="accesos-menu">
          <th scope="row" colSpan={ROLES.length + 1}>
            Cuenta
          </th>
        </tr>
      )}
      {grupo.acciones.map((accion) => (
        <tr key={accion.id}>
          <th scope="row" className="accesos-accion">
            {accion.etiqueta}
          </th>
          {ROLES.map((rol) => {
            const menuApagado = Boolean(menu && menu.aplicaA.includes(rol) && borrador[rol][menu.id] === false);
            return (
              <Celda
                key={rol}
                rol={rol}
                funcion={accion}
                etiqueta={menu ? `${menu.etiqueta}: ${accion.etiqueta}` : accion.etiqueta}
                borrador={borrador}
                marcar={marcar}
                deshabilitado={deshabilitado || menuApagado}
                menuApagado={menuApagado}
              />
            );
          })}
        </tr>
      ))}
      {grupo.noConfigurables.map((n) => (
        <tr key={n.id}>
          <th scope="row" className="accesos-accion">
            {n.etiqueta}
          </th>
          <td colSpan={ROLES.length} className="accesos-no-configurable">
            {n.nota}
          </td>
        </tr>
      ))}
    </>
  );
}

function Celda({
  rol,
  funcion,
  etiqueta,
  borrador,
  marcar,
  deshabilitado,
  menuApagado = false,
}: {
  rol: RolConfigurable;
  funcion: FuncionDescrita;
  etiqueta: string;
  borrador: Valores;
  marcar: (rol: RolConfigurable, funcion: string, valor: boolean) => void;
  deshabilitado: boolean;
  menuApagado?: boolean;
}) {
  if (!funcion.aplicaA.includes(rol)) {
    return (
      <td className="accesos-no-aplica" style={{ textAlign: "center" }} data-rol={NOMBRE_DEL_ROL[rol]}>
        No aplica
      </td>
    );
  }
  const marcada = borrador[rol][funcion.id] !== false;
  const idNota = `accesos-${rol}-${funcion.id.replace(/[^a-z_]/g, "-")}-menu-apagado`;
  return (
    <td style={{ textAlign: "center" }} className={menuApagado ? "accesos-atenuada" : undefined} data-rol={NOMBRE_DEL_ROL[rol]}>
      <input
        type="checkbox"
        checked={marcada}
        disabled={deshabilitado}
        onChange={(e) => marcar(rol, funcion.id, e.target.checked)}
        aria-label={`${NOMBRE_DEL_ROL[rol]} — ${etiqueta}`}
        aria-describedby={menuApagado ? idNota : undefined}
      />
      {menuApagado && (
        <span className="accesos-nota-menu" id={idNota}>
          Menú apagado
        </span>
      )}
    </td>
  );
}
