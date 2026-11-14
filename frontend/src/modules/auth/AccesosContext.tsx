import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, alDenegarFuncion } from "../../shared/apiClient";
import { useAuth } from "./AuthContext";

/**
 * FUNCIONES EFECTIVAS de la sesión (accesos por rol, opción A: solo restringir).
 *
 * Es PRESENTACIÓN: oculta menús y botones de funciones que la administración apagó para los
 * roles de esta cuenta. La protección de verdad está en el servidor, que evalúa la
 * configuración VIGENTE en cada solicitud (también con tokens ya emitidos y por llamada directa).
 *
 * CUÁNDO SE PIDEN (`GET /auth/accesos`): al iniciar o restaurar la sesión y en cada renovación
 * —las tres cambian el access token— y al recibir un 403 `FUNCION_DESHABILITADA`. Con el cambio
 * OBLIGATORIO de contraseña pendiente no se piden: esa pantalla no depende de esta configuración.
 *
 * RETRASO POSIBLE. En una sesión abierta, un cambio de la administración se ve en los menús en la
 * siguiente renovación (programada cada 12 minutos: es el intervalo previsto, no un plazo
 * garantizado), al recibir una denegación o al recargar la página. Hasta entonces un control puede seguir a la vista, pero el servidor ya aplica la
 * configuración nueva desde la siguiente solicitud y responde `FUNCION_DESHABILITADA`.
 *
 * RESPUESTAS TARDÍAS. Cada pedido lleva la GENERACIÓN de la sesión en que salió (cambia con el
 * contexto de autorización o el token) y la respuesta trae la cuenta y la versión: se descarta si
 * la generación ya no es la vigente, si es de otra cuenta o si su versión es anterior a la que ya
 * se tiene.
 *
 * CONTEXTO DE AUTORIZACIÓN. Lo cargado pertenece a la cuenta CON SUS ROLES efectivos y su club,
 * no solo a `userId`: los roles pueden cambiar sin cambiar la cuenta (por ejemplo, recibe
 * administración o el club deja de estar operativo). Al cambiar el contexto se descarta lo
 * cargado y se vuelve a pedir; lo último sabido solo se conserva mientras el contexto sea el
 * mismo (una renovación con los mismos roles, o un fallo de la consulta).
 *
 * ADMINISTRACIÓN tiene prioridad: con el rol `admin` nada se considera apagado, haya datos o no,
 * igual que en el servidor.
 *
 * SIN DATOS (todavía cargando, o la carga falló): no se oculta nada adicional y la interfaz se
 * comporta como siempre; el servidor sigue decidiendo. Un fallo no cierra la sesión.
 */
interface EstadoDeAccesos {
  /** Contexto de autorización al que pertenece lo cargado (ver `contextoDe`). */
  contexto: string | null;
  version: number;
  deshabilitadas: ReadonlySet<string>;
  /** `cargado` solo con una respuesta válida de ESTA cuenta. */
  estado: "sin-sesion" | "cargando" | "cargado" | "error";
}

interface AccesosValue {
  /** ¿La función está APAGADA para esta cuenta? Sin datos responde `false`: decide el servidor. */
  deshabilitada: (funcion: string) => boolean;
  estado: EstadoDeAccesos["estado"];
  version: number;
  refrescar: () => void;
}

const VACIO: EstadoDeAccesos = { contexto: null, version: -1, deshabilitadas: new Set(), estado: "sin-sesion" };

/** Cuenta, roles efectivos (sin importar el orden) y club: identidad de lo que se evalúa. */
function contextoDe(user: { id: string; roles: readonly string[]; clubId?: string | null } | null): string | null {
  if (!user) return null;
  return JSON.stringify([user.id, [...user.roles].sort(), user.clubId ?? null]);
}

const AccesosContext = createContext<AccesosValue | undefined>(undefined);

interface RespuestaDeAccesos {
  userId: string;
  version: number;
  deshabilitadas: string[];
}

function esRespuestaValida(r: unknown): r is RespuestaDeAccesos {
  const x = r as RespuestaDeAccesos | null;
  return (
    typeof x === "object" &&
    x !== null &&
    typeof x.userId === "string" &&
    Number.isInteger(x.version) &&
    Array.isArray(x.deshabilitadas) &&
    x.deshabilitadas.every((f) => typeof f === "string")
  );
}

export function AccesosProvider({ children }: { children: ReactNode }) {
  const { user, accessToken, mustChangePassword } = useAuth();
  const userId = user?.id ?? null;
  const contexto = contextoDe(user);
  const esAdministracion = user?.roles.includes("admin") ?? false;
  const [estado, setEstado] = useState<EstadoDeAccesos>(VACIO);
  /** Generación de la sesión vigente: cambia con el contexto de autorización y con cada token. */
  const generacion = useRef(0);
  const identidad = useRef<{ userId: string | null; contexto: string | null; activa: boolean }>({ userId: null, contexto: null, activa: false });

  const pedir = useCallback(() => {
    const gen = generacion.current;
    const { userId: esperado, contexto: contextoEsperado, activa } = identidad.current;
    if (!activa || !esperado) return;
    api
      .get<unknown>("/auth/accesos")
      .then((r) => {
        if (gen !== generacion.current || !esRespuestaValida(r) || r.userId !== esperado) return;
        setEstado((actual) => {
          // Una respuesta de una versión ANTERIOR a la que ya se tiene de este contexto se descarta.
          if (actual.contexto === contextoEsperado && actual.estado === "cargado" && r.version < actual.version) return actual;
          return { contexto: contextoEsperado, version: r.version, deshabilitadas: new Set(r.deshabilitadas), estado: "cargado" };
        });
      })
      .catch(() => {
        if (gen !== generacion.current) return;
        // Se conserva lo último que se supo de ESTE contexto; si no había nada, queda sin datos.
        setEstado((actual) =>
          actual.contexto === contextoEsperado && actual.estado === "cargado" ? actual : { ...VACIO, contexto: contextoEsperado, estado: "error" }
        );
      });
  }, []);

  useEffect(() => {
    generacion.current += 1;
    const activa = Boolean(userId && accessToken && !mustChangePassword);
    identidad.current = { userId, contexto, activa };
    if (!activa) {
      // Otra cuenta u otros roles, sin sesión o con el cambio obligatorio: nada del contexto anterior se conserva.
      setEstado((actual) => (actual.contexto === contexto ? actual : { ...VACIO, contexto }));
      return;
    }
    setEstado((actual) => (actual.contexto === contexto ? actual : { ...VACIO, contexto, estado: "cargando" }));
    pedir();
  }, [userId, contexto, accessToken, mustChangePassword, pedir]);

  // Una denegación por función significa que lo que se muestra está atrasado: se vuelve a pedir.
  useEffect(() => alDenegarFuncion(() => pedir()), [pedir]);

  const deshabilitada = useCallback(
    // El contexto se compara en el MISMO dibujo: entre el cambio de roles y el efecto que limpia el
    // estado, lo cargado para el contexto anterior ya no se aplica.
    (funcion: string) => !esAdministracion && estado.estado === "cargado" && estado.contexto === contexto && estado.deshabilitadas.has(funcion),
    [estado, contexto, esAdministracion]
  );

  return (
    <AccesosContext.Provider value={{ deshabilitada, estado: estado.estado, version: estado.version, refrescar: pedir }}>{children}</AccesosContext.Provider>
  );
}

export function useAccesos(): AccesosValue {
  const ctx = useContext(AccesosContext);
  // Fuera del proveedor (pruebas de una pantalla aislada): sin datos, decide el servidor.
  return ctx ?? { deshabilitada: () => false, estado: "sin-sesion", version: -1, refrescar: () => undefined };
}

