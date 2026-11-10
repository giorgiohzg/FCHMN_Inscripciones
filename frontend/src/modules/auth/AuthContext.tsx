import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { apiLogin, apiRefresh, apiLogout, apiCsrf, type LoginResponse } from "./authApi";
import { decodeAccessTokenClaims } from "./jwtClaims";
import {
  renovarUnaSolaVez,
  escucharOtrasPestanas,
  anunciarCierreDeSesion,
  anunciarInicioDeSesion,
  comenzarCicloDeSesion,
  conCerrojoDeSesion,
  renovarDentroDelCerrojo,
  cicloActual,
  cicloSigueVigente,
  cerrarSiCicloVigente,
  type SesionRenovada,
  type ResultadoRenovacion,
} from "./refreshCoordinator";
import {
  conectarSesion,
  ApiError,
  SesionCambiadaError,
  esMismaSesion,
  type IdentidadDeSesion,
  type RenovacionParaElCliente,
} from "../../shared/apiClient";
import { apiChangePassword } from "./authApi";
import { asegurarTokenCsrf, renovarTokenCsrf, recordarTokenCsrf, olvidarTokenCsrf } from "./csrf";
import { validarPerfil, validarRespuestaDeSesion, type PerfilDeSesion } from "./sessionSchema";
import { dejarAvisoDeAcceso } from "./avisoDeAcceso";

interface AuthState {
  accessToken: string | null;
  /**
   * `PerfilDeSesion` es el tipo que produce la validación en tiempo de
   * ejecución (`sessionSchema.ts`), no un alias del contrato HTTP. Con él, lo
   * que llega por el canal encaja SIN cast: el `as unknown as` que había aquí
   * era una afirmación sin comprobar.
   */
  user: PerfilDeSesion | null;
  permissions: string[];
  mustChangePassword: boolean;
}

interface AuthContextValue extends AuthState {
  /** Devuelve el resultado del login para poder navegar sin leer estado obsoleto. */
  login: (username: string, password: string) => Promise<LoginResponse>;
  logout: () => Promise<void>;
  hasRole: (role: string) => boolean;
  /**
   * Permisos REALES del token vigente. Solo para mostrar u ocultar interfaz:
   * la autorización de verdad la decide el backend en cada petición.
   */
  hasPermission: (permission: string) => boolean;
  /** True mientras se intenta restaurar la sesión al abrir la aplicación. */
  restaurando: boolean;
  /**
   * True cuando la restauración inicial NO pudo completarse por un fallo
   * transitorio (red caída, 5xx). No significa que la sesión sea inválida: la
   * cookie sigue en el navegador y el intento puede repetirse.
   */
  restauracionFallida: boolean;
  /** Reintenta la restauración. Lo usa la pantalla de "sin conexión". */
  reintentarRestauracion: () => Promise<void>;
  /**
   * Cambia la contraseña y adopta la sesión que devuelve el servidor.
   *
   * La operación COMPLETA vive aquí, no en la pantalla: la petición, el cierre
   * del ciclo anterior, la adopción, el token CSRF, el perfil persistido y el
   * aviso a las demás pestañas ocurren bajo el mismo cerrojo que el refresco.
   * Antes la página llamaba a `apiChangePassword` por su cuenta, así que la
   * petición que reemplaza la cookie salía FUERA del cerrojo y podía cruzarse
   * con un refresco en vuelo.
   */
  changePassword: (payload: { currentPassword: string; newPassword: string; confirmPassword: string }) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Lo ÚNICO que se persiste es el perfil visible (nombre, roles, club), y solo
 * como caché para no pintar la aplicación vacía durante el instante que tarda
 * la renovación al recargar. **No es la fuente de verdad**: el perfil auténtico
 * llega en la respuesta del refresco, así que la sesión se reconstruye igual de
 * bien con este almacenamiento vacío.
 *
 * No hay aquí ninguna credencial:
 *   - el refresh token vive en una cookie `HttpOnly` que este código no puede leer;
 *   - el access token vive en MEMORIA y se pierde al recargar, a propósito.
 *
 * Antes se guardaban los dos tokens en `sessionStorage`, donde cualquier script
 * de la página podía leerlos.
 */
const CLAVE_PERFIL = "natacion.perfil";

const ESTADO_VACIO: AuthState = { accessToken: null, user: null, permissions: [], mustChangePassword: false };

function cargarPerfil(): PerfilDeSesion | null {
  try {
    const raw = sessionStorage.getItem(CLAVE_PERFIL);
    // Se VALIDA lo que se lee: el almacenamiento del navegador lo puede tocar
    // cualquier script, y una versión anterior de la aplicación pudo dejar ahí
    // un perfil con otra forma.
    return raw ? validarPerfil(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function guardarPerfil(user: PerfilDeSesion | null): void {
  try {
    if (user) sessionStorage.setItem(CLAVE_PERFIL, JSON.stringify(user));
    else sessionStorage.removeItem(CLAVE_PERFIL);
  } catch {
    // Almacenamiento bloqueado (modo privado, políticas del navegador): no es
    // motivo para romper la sesión, solo se pierde el perfil precargado.
  }
}

/**
 * ¿Este error significa que la SESIÓN ya no vale, o que algo falló de paso?
 *
 * La distinción decide si se borra la sesión del usuario. Un 401 o un 403 son
 * el servidor diciendo que la credencial no sirve: hay que volver a entrar. Un
 * fallo de red, un timeout o un 5xx no dicen nada sobre la sesión —el servidor
 * ni siquiera llegó a opinar—, y tratarlos igual expulsaba al usuario cada vez
 * que el wifi parpadeaba o el servidor se reiniciaba, perdiendo lo que
 * estuviera haciendo. La cookie sigue ahí y el siguiente intento funcionará.
 */
/**
 * C-04: el servidor terminó la sesión por demasiados intentos con la contraseña actual.
 * Es TERMINAL: renovar no puede devolverla, y reintentar el cambio no tiene sentido. Se
 * reconoce por el código estructurado, no por el texto.
 */
const CODIGO_INTENTOS_AGOTADOS = "PASSWORD_CHANGE_ATTEMPTS_EXCEEDED";
function esCierreTerminalDelCambio(err: unknown): err is ApiError {
  return err instanceof ApiError && err.status === 401 && err.code === CODIGO_INTENTOS_AGOTADOS;
}

function esSesionInvalida(err: unknown): boolean {
  /**
   * SOLO el 401.
   *
   * El 403 de `/auth/refresh` o `/auth/logout` NO es una sesión expirada: es
   * una comprobación CSRF fallida, que ocurre por motivos perfectamente
   * normales —otra pestaña rotó el token, o la página se recargó y el valor en
   * memoria se perdió—. Tratarlo como sesión inválida expulsaba al usuario en
   * esos casos, con la sesión intacta en el servidor. Lo que corresponde ante
   * un 403 es rehacer el bootstrap y reintentar, no borrar nada.
   */
  return err instanceof ApiError && err.status === 401;
}

/** Usuario al que pertenece un access token, o `null` si no hay token o no se puede leer. */
function usuarioDelToken(token: string | null): string | null {
  return token ? (decodeAccessTokenClaims(token)?.sub ?? null) : null;
}

/** Un 403 en las rutas de sesión significa "el token CSRF no cuadra". */
function esFalloCsrf(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>(() => ({ ...ESTADO_VACIO, user: cargarPerfil() }));

  /**
   * Espejo del estado en una ref.
   *
   * El cliente HTTP y el coordinador de renovación necesitan leer el token
   * VIGENTE desde funciones que no se re-crean en cada render. Con el valor
   * capturado por clausura leerían el de hace varios renders.
   *
   * La escritura va en un efecto y en los callbacks, nunca en el cuerpo del
   * componente: tocar una ref durante el render rompe las garantías del modo
   * concurrente de React.
   */
  const estadoRef = useRef(state);
  useEffect(() => {
    estadoRef.current = state;
  }, [state]);

  const [restaurando, setRestaurando] = useState(true);
  const [restauracionFallida, setRestauracionFallida] = useState(false);

  const aplicarSesion = useCallback(
    (datos: { accessToken: string; user?: PerfilDeSesion | null; mustChangePassword?: boolean }) => {
      const claims = decodeAccessTokenClaims(datos.accessToken);
      const permissions = claims?.permissions ?? [];

      /**
       * La ref se adelanta al render: `setState` es asíncrono y entre medio
       * puede salir otra petición, que usaría el token ANTERIOR —el recién
       * vencido— provocando un 401 evitable.
       */
      estadoRef.current = { ...estadoRef.current, accessToken: datos.accessToken, permissions };

      setState((s) => {
        // El backend recalcula roles y permisos vigentes en cada emisión de
        // token: se releen de ahí en vez de conservar los del login original.
        const base = datos.user ?? s.user;
        const actualizado = base && claims ? { ...base, roles: claims.roles, clubId: claims.clubId } : base;
        guardarPerfil(actualizado ?? null);
        return {
          accessToken: datos.accessToken,
          user: actualizado ?? null,
          permissions,
          mustChangePassword: datos.mustChangePassword ?? s.mustChangePassword,
        };
      });
    },
    []
  );

  const limpiarSesion = useCallback((avisarAOtrasPestanas = true) => {
    guardarPerfil(null);
    olvidarTokenCsrf();
    estadoRef.current = ESTADO_VACIO;
    setState(ESTADO_VACIO);
    // Sin esto, cerrar sesión en una pestaña dejaba las demás mostrando una
    // interfaz autenticada contra una cookie ya revocada.
    if (avisarAOtrasPestanas) anunciarCierreDeSesion();
  }, []);

  /**
   * Adopta una sesión YA VALIDADA y del ciclo vigente. Solo la llama el
   * coordinador, después de comprobar el ciclo.
   */
  const adoptarSesion = useCallback(
    (sesion: SesionRenovada) => {
      recordarTokenCsrf(sesion.csrfToken);
      aplicarSesion({
        accessToken: sesion.accessToken,
        user: sesion.user,
        mustChangePassword: sesion.mustChangePassword,
      });
    },
    [aplicarSesion]
  );

  /**
   * Las dependencias de la renovación, las mismas para la coordinada y la
   * anidada dentro del cerrojo.
   *
   * Se declaran AQUÍ, antes que `login`, `logout` y `changePassword`, porque las
   * tres las usan: definirlas después dejaba una referencia a una variable aún
   * no inicializada.
   */
  const dependenciasDeRenovacion = useCallback(
    () => ({
      tokenActual: () => estadoRef.current.accessToken,
      adoptar: adoptarSesion,
      /**
       * Devuelve la respuesta CRUDA. No toca el estado, ni el token CSRF, ni el
       * almacenamiento: de eso se encarga `adoptar`, y solo después de que el
       * coordinador confirme que el ciclo sigue vigente.
       */
      pedirRenovacion: async () => {
        // El token CSRF también se pierde al recargar: hay que reconstruirlo
        // antes del primer refresco. Si el bootstrap falla, se propaga: hacer el
        // refresco a sabiendas de que le faltará la cabecera solo produciría un
        // 403 engañoso.
        await asegurarTokenCsrf(apiCsrf);

        try {
          return await apiRefresh();
        } catch (err) {
          if (esSesionInvalida(err)) return null;

          /**
           * 403: el token CSRF no cuadra. Pasa por motivos normales, así que se
           * rehace el bootstrap y se reintenta UNA vez. Si vuelve a fallar, se
           * propaga: la sesión se conserva y el usuario ve un error, en vez de
           * quedar expulsado.
           */
          if (esFalloCsrf(err)) {
            await renovarTokenCsrf(apiCsrf);
            return await apiRefresh();
          }

          // Red caída, timeout o error del servidor: NO es motivo para expulsar
          // al usuario. Se propaga y la sesión se conserva.
          throw err;
        }
      },
    }),
    [adoptarSesion]
  );

  const login = useCallback(async (username: string, password: string) => {
    /**
     * LA TRANSICIÓN COMPLETA bajo el cerrojo, no solo la petición.
     *
     * Antes solo `apiLogin()` estaba dentro y la adopción ocurría después de
     * soltarlo: entre medias, una operación encolada podía entrar viendo la
     * cookie NUEVA con el ciclo local ANTIGUO. Ahora petición, cambio de ciclo,
     * adopción, CSRF, perfil persistido y anuncio ocurren sin que nadie más
     * pueda intercalarse.
     */
    return conCerrojoDeSesion(async () => {
      const respuesta = await apiLogin(username, password);

      // Validación en tiempo de ejecución, igual que el refresco: los tipos de
      // TypeScript no existen al ejecutar.
      const sesion = validarRespuestaDeSesion(respuesta);
      if (!sesion) {
        throw new Error("El servidor devolvió una sesión que no se puede usar. Inténtelo de nuevo.");
      }

      /**
       * Ciclo nuevo: una renovación atrasada del usuario ANTERIOR no puede
       * llegar por el canal y sobrescribir el perfil del que acaba de entrar.
       */
      const ciclo = comenzarCicloDeSesion();
      recordarTokenCsrf(sesion.csrfToken);

      const claims = decodeAccessTokenClaims(sesion.accessToken);
      const nuevo: AuthState = {
        accessToken: sesion.accessToken,
        user: sesion.user,
        permissions: claims?.permissions ?? [],
        mustChangePassword: sesion.mustChangePassword,
      };
      guardarPerfil(sesion.user);
      estadoRef.current = nuevo;
      setState(nuevo);

      /**
       * Se avisa a las demás pestañas. El navegador tiene UNA cookie: en cuanto
       * esta pestaña entra, la sesión que mostraban las demás dejó de existir.
       * Sin este aviso seguirían pintando al usuario anterior y su botón de
       * cerrar sesión revocaría ESTA sesión creyendo cerrar aquella.
       */
      anunciarInicioDeSesion({ ...sesion, ciclo });

      // Se devuelve el resultado porque `setState` es asíncrono: quien llama
      // necesita el `mustChangePassword` recién obtenido para decidir a dónde
      // navegar.
      return respuesta;
    });
  }, []);

  /**
   * Cierre de sesión.
   *
   * Si la petición NO llega al servidor, esto LANZA en vez de dar el cierre por
   * hecho. La razón es concreta: el refresh token vive en una cookie `HttpOnly`
   * que este código no puede borrar, y solo el servidor puede revocarlo en la
   * base. Limpiar el estado local y decir "listo" dejaría al usuario creyendo
   * que cerró sesión en un equipo compartido mientras su cookie sigue viva y
   * cualquiera podría recargar y seguir dentro.
   *
   * Un 401 sí cuenta como éxito: significa que la sesión ya no existe, que es
   * exactamente lo que se pedía.
   */
  const logout = useCallback(async () => {
    /**
     * Un intento, y ANTE 403 un único reintento tras rehacer el bootstrap.
     *
     * El 403 de `/auth/logout` es una comprobación CSRF fallida, no una sesión
     * expirada: pasa cuando el token en memoria se perdió (recarga) o dejó de
     * coincidir. La versión anterior lo trataba como fallo definitivo y el
     * usuario no podía cerrar sesión sin recargar. El reintento es UNO, contado
     * explícitamente: no hay bucle posible.
     */
    const intentar = async (): Promise<"cerrado" | "csrf" | never> => {
      try {
        await apiLogout();
        return "cerrado";
      } catch (err) {
        // 401: la sesión ya no existía. El objetivo está cumplido.
        if (esSesionInvalida(err)) return "cerrado";
        if (esFalloCsrf(err)) return "csrf";
        throw err;
      }
    };

    try {
      /**
       * UN SOLO cerrojo para toda la operación, incluidos el reintento y la
       * limpieza local.
       *
       * Antes se tomaba y soltaba en CADA intento HTTP, así que entre el primer
       * 403 y el reintento —o entre el éxito y el borrado local— podía colarse
       * un refresco y dejar una cookie nueva sobre una sesión que se estaba
       * cerrando.
       */
      await conCerrojoDeSesion(async () => {
        let resultado = await intentar();

        if (resultado === "csrf") {
          await renovarTokenCsrf(apiCsrf);
          resultado = await intentar();
        }

        if (resultado === "csrf") {
          // Segundo 403: no se insiste más. La sesión sigue viva en el servidor.
          throw new ApiError("Comprobación de seguridad fallida al cerrar sesión.", 403);
        }

        // La limpieza y el anuncio, dentro del cerrojo: nadie puede observar un
        // estado intermedio.
        limpiarSesion();
      });
    } catch (err) {
      const fallo = new Error(
        "No se pudo cerrar la sesión en el servidor: la sesión sigue activa. " +
          "Compruebe su conexión e inténtelo de nuevo."
      );
      /**
       * Se conserva el error original —403 de CSRF, corte de red, 5xx— para que
       * quede en los registros; el mensaje es el que ve el usuario.
       *
       * Se asigna en vez de pasarlo al constructor porque el `lib` de
       * TypeScript de este proyecto no declara todavía `ErrorOptions`.
       */
      (fallo as Error & { cause?: unknown }).cause = err;
      // El estado local NO se limpia: el refresh token vive en una cookie
      // HttpOnly que este código no puede borrar, y solo el servidor puede
      // revocarlo. Decir "sesión cerrada" sería mentir.
      throw fallo;
    }
  }, [limpiarSesion]);

  const changePassword = useCallback(
    async (payload: { currentPassword: string; newPassword: string; confirmPassword: string }): Promise<void> => {
      /**
       * TODA la operación bajo el cerrojo, incluida la petición HTTP.
       *
       * La pantalla llamaba antes a `apiChangePassword` por su cuenta y solo
       * después avisaba al contexto: la petición que REEMPLAZA la cookie salía
       * fuera del cerrojo y podía cruzarse con un refresco en vuelo.
       */
      await conCerrojoDeSesion(async () => {
        /**
         * UN reintento si el access token está vencido.
         *
         * `/auth/change-password` está fuera del bucle automático de 401 del
         * cliente HTTP —si no, la renovación pediría este mismo cerrojo y se
         * quedaría esperándonos—. Así que el 401 se maneja aquí: se renueva
         * SIN volver a pedir el cerrojo y se reintenta una sola vez. El
         * contador es explícito, no hay recursión y la operación termina sí o sí.
         */
        /**
         * Un envío del cambio y su cierre TERMINAL (C-04). Lo usan el primer envío y el
         * reintento tras una renovación válida, cada uno con el ciclo bajo el que sale.
         *
         * Ante `PASSWORD_CHANGE_ATTEMPTS_EXCEEDED` no hay renovación ni otro envío: se
         * limpia la sesión —y se anuncia a las demás pestañas, que comparten la misma— solo
         * si sigue siendo la de ese envío; si entre tanto empezó otra, la respuesta es de la
         * anterior y no se le imputa a la actual. Se sostiene el cerrojo, así que comprobar y
         * limpiar van seguidos, sin punto de suspensión entre medias.
         */
        const enviarCambio = async (cicloDelEnvio: string) => {
          try {
            return await apiChangePassword(payload);
          } catch (err) {
            if (esCierreTerminalDelCambio(err)) {
              if (!cicloSigueVigente(cicloDelEnvio)) throw new SesionCambiadaError();
              limpiarSesion();
              dejarAvisoDeAcceso(err.message);
            }
            throw err;
          }
        };

        let respuesta: Awaited<ReturnType<typeof apiChangePassword>>;
        try {
          respuesta = await enviarCambio(cicloActual());
        } catch (err) {
          // El cierre terminal ya se resolvió en `enviarCambio`: nunca lleva a renovar.
          if (esCierreTerminalDelCambio(err) || !esSesionInvalida(err)) throw err;

          const renovada = await renovarDentroDelCerrojo(dependenciasDeRenovacion());

          /**
           * LOS DOS DESENLACES QUE NO SON "renovada" NO SON LO MISMO.
           *
           * - `invalida`: el servidor confirmó un 401. La sesión terminó, y hay
           *   que hacer exactamente lo mismo que en cualquier otro 401
           *   confirmado: limpiar la sesión y ANUNCIAR EL CIERRE a las demás
           *   pestañas. Antes solo se relanzaba el error, así que el usuario se
           *   quedaba atrapado en la pantalla de cambio obligatorio —sin sesión
           *   válida y sin forma de volver al login— y las otras pestañas
           *   seguían mostrando una sesión muerta.
           * - `descartada`: el ciclo cambió mientras se renovaba (otra pestaña
           *   entró o cerró). No se sabe nada malo de ESTA sesión y no hay nada
           *   que limpiar: quien cambió el ciclo ya hizo lo que tocaba. Se
           *   propaga el error original y ya está.
           */
          if (renovada.tipo === "invalida") {
            /**
             * Se limpia SOLO si el ciclo sigue siendo el de la renovación. Aquí ya
             * se sostiene el cerrojo, así que se usa la comprobación desnuda —la
             * versión con cerrojo esperaría a quien ya lo tiene—: comprobar y
             * limpiar van seguidos, sin punto de suspensión entre medias.
             */
            if (cicloSigueVigente(renovada.ciclo)) limpiarSesion();
            throw err;
          }
          if (renovada.tipo === "descartada") throw err;

          // Único reintento. Su error terminal se trata igual, con el ciclo vigente al
          // reenviar; cualquier otro error se propaga sin una tercera petición.
          respuesta = await enviarCambio(cicloActual());
        }

        const sesion = validarRespuestaDeSesion(respuesta);
        if (!sesion) {
          throw new Error("El servidor devolvió una sesión que no se puede usar. Vuelva a iniciar sesión.");
        }

        /**
         * El backend revoca TODAS las sesiones anteriores y emite otra, así que
         * el ciclo anterior queda muerto: cualquier renovación suya en vuelo
         * pertenece a algo que ya no existe.
         */
        anunciarCierreDeSesion();
        const ciclo = comenzarCicloDeSesion();

        recordarTokenCsrf(sesion.csrfToken);
        aplicarSesion({
          accessToken: sesion.accessToken,
          user: sesion.user,
          mustChangePassword: false,
        });

        // Las demás pestañas adoptan la sesión nueva; la suya está revocada.
        anunciarInicioDeSesion({ ...sesion, ciclo });
      });
    },
    [aplicarSesion, dependenciasDeRenovacion, limpiarSesion]
  );

  const renovar = useCallback(
    /**
     * `sigueVigente` es opcional: la restauración y la renovación periódica
     * renuevan «la sesión que haya», y no la pasan. Las peticiones que reaccionan
     * a un 401 sí la pasan —ver el puente más abajo—, y el coordinador la evalúa
     * dentro de la sección crítica, después de esperar el cerrojo.
     */
    (sigueVigente?: () => boolean): Promise<ResultadoRenovacion> =>
      renovarUnaSolaVez(dependenciasDeRenovacion(), sigueVigente),
    [dependenciasDeRenovacion]
  );

  /**
   * Se conecta el puente ANTES de cualquier petición: el cliente HTTP necesita
   * poder leer el token y pedir la renovación.
   */
  useEffect(() => {
    /** Quién es la sesión vigente AHORA: ciclo y usuario del token en memoria. */
    const identidadAhora = (): IdentidadDeSesion => ({
      ciclo: cicloActual(),
      userId: usuarioDelToken(estadoRef.current.accessToken),
    });

    conectarSesion({
      /**
       * Token e identidad en el mismo instante: son los de la sesión bajo la que
       * nace cada petición, y con esa identidad se compara cuando vuelva un 401.
       */
      obtenerSesion: () => {
        const identidad = identidadAhora();
        return { accessToken: estadoRef.current.accessToken, identidad };
      },
      /**
       * El cliente HTTP solo necesita saber si puede reintentar y con qué token,
       * y la respuesta es siempre sobre LA SESIÓN QUE ENVIÓ la petición.
       *
       * `descartada` ya no devuelve «el token que haya ahora»: significa que el
       * ciclo cambió, es decir, que la sesión actual NO es la que falló, y
       * reenviar con su token ejecutaría una operación de A con credenciales de B.
       * Se responde `cambiada` y no se repite nada.
       */
      renovar: async (identidad): Promise<RenovacionParaElCliente> => {
        /**
         * La comprobación de identidad la hace el COORDINADOR, y la hace en dos
         * momentos: al entrar —si la sesión ya es otra, ni se une a un vuelo— y
         * DENTRO de la sección crítica, tras esperar el cerrojo y antes de
         * reutilizar un anuncio o de emitir la renovación. Una comprobación solo
         * previa no cubre lo que ocurre mientras se espera el cerrojo, que es
         * justo cuando suelen cambiar las cosas (otra pestaña refrescando, un
         * login en cola). `descartada` es lo que devuelve cuando la condición
         * falla, y aquí significa `cambiada`.
         *
         * `identidadAhora()` se lee en ese momento, no se captura: es la sesión
         * vigente al evaluar la condición, que es lo que se quiere comparar.
         */
        const r = await renovar(() => esMismaSesion(identidad, identidadAhora()));
        if (r.tipo === "descartada") return { tipo: "cambiada" };
        if (r.tipo === "invalida") {
          return r.ciclo === identidad.ciclo ? { tipo: "invalida" } : { tipo: "cambiada" };
        }

        // Renovada: solo se entrega si es LA MISMA sesión. La respuesta puede
        // venir de una renovación ya en curso que pertenecía a otro ciclo, o de la
        // cookie de otro usuario.
        const delRenovado: IdentidadDeSesion = { ciclo: r.sesion.ciclo, userId: r.sesion.user.id };
        return esMismaSesion(identidad, delRenovado)
          ? { tipo: "renovada", accessToken: r.sesion.accessToken }
          : { tipo: "cambiada" };
      },
      /**
       * Cierra SOLO si la sesión de `identidad` sigue siendo la vigente: el ciclo
       * Y el usuario. Las dos comprobaciones y la limpieza ocurren juntas, en la
       * misma sección crítica.
       *
       * `esMismaSesion` es lo que da el matiz: si la petición salió con usuario
       * conocido, un usuario distinto NO pierde su sesión aunque el ciclo
       * coincida; si salió sin sesión (`userId: null`, la restauración), la
       * identidad se completa y el cierre procede. Esa tolerancia vale solo para
       * el origen desconocido, no para cualquier identidad.
       */
      cerrarPorSesionInvalida: (identidad) =>
        cerrarSiCicloVigente(
          identidad.ciclo,
          () => limpiarSesion(),
          () => esMismaSesion(identidad, identidadAhora())
        ),
    });
  }, [renovar, limpiarSesion]);

  /** Lo que hagan las demás pestañas se refleja aquí. */
  useEffect(() => {
    return escucharOtrasPestanas({
      /**
       * Se adopta la sesión ENTERA, no solo el token: la respuesta trae también
       * el token CSRF vigente y el perfil. (El refresco **no rota** el CSRF —ver
       * `"conservar"` en `auth.routes.ts`—, pero sí lo devuelve, y esta pestaña
       * puede no tener ninguno todavía.) Quedarse con el access token y
       * conservar el resto dejaba a esta pestaña sin CSRF utilizable —403 en su
       * siguiente operación— y, si acababa de abrirse, sin saber quién es el
       * usuario.
       */
      // `sesion` llega VALIDADA por el esquema (`sessionSchema.ts`): perfil
      // completo, token decodificable y `sub` coincidente con el usuario. Ya no
      // hay cast que afirme sin comprobar.
      alRenovar: adoptarSesion,
      /**
       * Otra pestaña inició sesión: se adopta ESA, sea de quien sea.
       *
       * Es la política única del navegador para el cambio de cuenta. La cookie
       * es una sola: seguir mostrando al usuario anterior sería mostrar algo
       * falso, y su botón de cerrar sesión revocaría la sesión nueva.
       */
      alIniciar: (sesion) => {
        recordarTokenCsrf(sesion.csrfToken);
        adoptarSesion(sesion);
        setState((s) => ({ ...s, mustChangePassword: sesion.mustChangePassword }));
      },
      // `false`: no se reenvía el aviso, o las pestañas se lo rebotarían.
      alCerrar: () => limpiarSesion(false),
    });
  }, [adoptarSesion, limpiarSesion]);

  /**
   * Al ABRIR o RECARGAR la aplicación no hay access token —vive en memoria y se
   * perdió—, pero la cookie del refresh sigue en el navegador. Se intenta
   * restaurar la sesión con ella, y el perfil completo llega en esa respuesta.
   *
   * `intentado` evita que React StrictMode (que en desarrollo ejecuta los
   * efectos dos veces) dispare dos renovaciones seguidas: el refresh token es
   * de un solo uso y la segunda se leería como robo de sesión.
   */
  /**
   * Restaura la sesión y CLASIFICA el desenlace.
   *
   * La versión anterior terminaba igual en los dos casos: sin access token y
   * con `restaurando` en false. Una ruta protegida veía eso y mandaba al login,
   * así que un 5xx momentáneo o un wifi caído expulsaban a un usuario con la
   * sesión intacta en el servidor. Ahora se distingue:
   *
   *   - 401 confirmado → la cookie ya no vale: limpiar y dejar que el
   *     enrutador lleve al login.
   *   - red / 5xx      → no se sabe nada de la sesión: se conserva el perfil y
   *     se marca `restauracionFallida`, para mostrar una pantalla de reintento
   *     en vez de navegar.
   */
  const intentarRestaurar = useCallback(async (): Promise<void> => {
    setRestaurando(true);
    try {
      const resultado = await renovar();

      // "descartada": el ciclo cambió mientras se restauraba. Hay una sesión
      // nueva vigente y no hay nada que limpiar ni que reportar.
      if (resultado.tipo === "descartada") {
        setRestauracionFallida(false);
      } else if (resultado.tipo === "invalida") {
        /**
         * 401 CONFIRMADO por el servidor: se propaga a las demás pestañas.
         *
         * Antes se llamaba con `false` —sin avisar—, y las otras pestañas
         * seguían mostrando una sesión que el servidor ya había declarado
         * inválida. El aviso no puede rebotar en bucle porque la pestaña que lo
         * recibe cierra localmente sin reenviarlo.
         *
         * Y solo si el ciclo del veredicto SIGUE siendo el vigente: el 401 puede
         * llegar cuando ya entró otra sesión (otra cuenta en esta pestaña, o
         * una en otra), y esa no es la que el servidor rechazó. La comprobación
         * y la limpieza van juntas, bajo el cerrojo.
         */
        await cerrarSiCicloVigente(resultado.ciclo, () => limpiarSesion());
        setRestauracionFallida(false);
      } else {
        setRestauracionFallida(false);
      }
    } catch {
      // Fallo transitorio: la cookie sigue ahí y el intento puede repetirse.
      setRestauracionFallida(true);
    } finally {
      setRestaurando(false);
    }
  }, [renovar, limpiarSesion]);

  const intentado = useRef(false);
  useEffect(() => {
    if (intentado.current) return;
    intentado.current = true;

    void intentarRestaurar();
    // Solo al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Renovación proactiva cada 12 minutos (el access token dura 15). Evita que
   * el usuario vea el pequeño retraso del reintento tras un 401.
   */
  useEffect(() => {
    if (!state.accessToken) return;
    const intervalo = setInterval(
      () => {
        renovar()
          .then(async (resultado) => {
            // Solo un 401 confirmado cierra la sesión, y solo si el ciclo del
            // veredicto sigue siendo el vigente (ver `cerrarSiCicloVigente`).
            if (resultado.tipo === "invalida") await cerrarSiCicloVigente(resultado.ciclo, () => limpiarSesion());
          })
          .catch(() => {
            // Fallo transitorio: se conserva la sesión y se reintenta en el
            // siguiente ciclo o en la próxima petición con 401.
          });
      },
      12 * 60_000
    );
    return () => clearInterval(intervalo);
  }, [state.accessToken, renovar, limpiarSesion]);

  const hasRole = useCallback((role: string) => state.user?.roles.includes(role) ?? false, [state.user]);

  /**
   * Antes esto era `() => true`: cualquier comprobación de permiso en la
   * interfaz pasaba siempre, así que no ocultaba nada y daba la falsa impresión
   * de que existía un control. Ahora consulta los permisos que trae el access
   * token vigente, que el backend recalcula en cada emisión.
   *
   * Sigue siendo SOLO presentación: el backend revalida cada petición.
   */
  const hasPermission = useCallback((permission: string) => state.permissions.includes(permission), [state.permissions]);

  return (
    <AuthContext.Provider
      value={{
        ...state,
        restaurando,
        restauracionFallida,
        reintentarRestauracion: intentarRestaurar,
        login,
        logout,
        hasRole,
        hasPermission,
        changePassword,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth debe usarse dentro de <AuthProvider>");
  return ctx;
}
