import type { FilaDeHistorial, PaginaDeHistorial } from "./PanelDeHistorial";
import { validarPaginaRecibida, type PaginaDe } from "./paginacion";
import { formatEventLabel } from "./eventLabel";
import { formatCalendarDate } from "./calendarDate";
import { formatShortName } from "./personDisplayName";
import { formatSwimTimeReadable } from "./swimTime";
import type { RegistrationItem } from "../modules/registrations/registrationsApi";
import type { RelayRegistrationItem } from "../modules/relay-registrations/relayRegistrationsApi";

/**
 * Fase 6, hallazgo 31 — el paso de RESPUESTA DEL API a FILA DEL HISTORIAL.
 *
 * Estaba escrito dentro del JSX de cada Workspace, y ahí no se podía probar sin
 * montar la pantalla entera con todos sus contextos. Como lo que hay que
 * demostrar es la EQUIVALENCIA con las páginas retiradas —las mismas columnas, en
 * el mismo orden, con el mismo formato—, el mapeo vive aquí y se prueba solo.
 *
 * Las columnas replican exactamente las de `RegistrationsListPage` y
 * `RelayRegistrationsListPage`, que es lo que se eliminó.
 */

/** Encabezados de inscripciones individuales, en el orden de la página retirada. */
export const COLUMNAS_INSCRIPCIONES = ["Nadador", "Club", "Prueba", "Fecha / Jornada", "Categoría", "Tiempo estimado"];

/** Encabezados de relevos. Sin "Nadador": un relevo es un equipo. */
export const COLUMNAS_RELEVOS = ["Club", "Prueba", "Fecha / Jornada", "Categoría", "Nadadores", "Tiempo estimado"];

export function filaDeInscripcion(r: RegistrationItem): FilaDeHistorial {
  const ce = r.competitionEvent;
  return {
    id: r.id,
    cancelada: r.status === "cancelled",
    celdas: [
      `${formatShortName(r.person)} (${r.person.run})`,
      r.club.name,
      formatEventLabel({
        distanceMeters: ce.event.distance.meters,
        strokeName: ce.event.stroke.name,
        gender: ce.event.gender,
        isRelay: ce.event.testType.swimmersCount > 1,
      }),
      `${formatCalendarDate(ce.competitionSession.competitionDate.date)} — ${ce.competitionSession.sessionType.name}`,
      r.category.name,
      formatSwimTimeReadable(r.seedTimeCentiseconds),
    ],
  };
}

export function filaDeRelevo(r: RelayRegistrationItem): FilaDeHistorial {
  const ce = r.competitionEvent;
  return {
    id: r.id,
    cancelada: r.status === "cancelled",
    celdas: [
      r.club.name,
      formatEventLabel({
        distanceMeters: ce.event.distance.meters,
        strokeName: ce.event.stroke.name,
        gender: ce.event.gender,
        isRelay: true,
      }),
      `${formatCalendarDate(ce.competitionSession.competitionDate.date)} — ${ce.competitionSession.sessionType.name}`,
      r.category.name,
      // El equipo, en su orden de nado: es lo que distingue a un relevo.
      // `members` solo trae `fullName`, no las partes del nombre, así que aquí
      // no se puede aplicar el formato corto.
      [...r.members]
        .sort((a, b) => a.orderPosition - b.orderPosition)
        .map((m) => m.person.fullName)
        .join(", "),
      formatSwimTimeReadable(r.seedTimeCentiseconds),
    ],
  };
}

/**
 * LOS CARGADORES, para que la pantalla y la prueba usen EL MISMO código.
 *
 * Antes cada Workspace armaba su `cargar` dentro del JSX y la prueba lo
 * reconstruía a mano: dos copias que podían divergir sin que nada avisara —y una
 * prueba que reconstruye el código productivo no prueba el código productivo—.
 *
 * PIDEN UNA PÁGINA, NO TODAS. La versión anterior usaba `traerTodasLasPaginas`,
 * que su propio archivo reserva para **selectores y conjuntos de decisión, no
 * para tablas**: abrir el historial costaba hasta 100 peticiones y montaba hasta
 * 10 000 filas de golpe, y por encima de esa cifra fallaba entero en vez de
 * mostrar la primera página. El panel navega, así que pide lo que muestra.
 *
 * Fail-closed igual que antes, pero sobre UNA página: si la recibida no es la
 * pedida —un servidor que ignora `page`, un proxy que cachea la primera— o el
 * tamaño no es el solicitado, **se lanza** y el panel muestra el error. Una
 * página equivocada con apariencia de correcta es lo que hace que alguien
 * concluya que una inscripción no existió.
 */

/** Lo mínimo que se le pide a un API de listado paginado. */
type ListaPaginada<T> = (params: {
  competitionId: string;
  clubId?: string;
  status?: "confirmed" | "cancelled";
  page: number;
  pageSize: number;
}) => Promise<PaginaDe<T>>;

function cargadorDe<T extends { id: string }>(
  list: ListaPaginada<T>,
  competitionId: string,
  clubId: string | null | undefined,
  aFila: (item: T) => FilaDeHistorial
) {
  return async (
    estado: "confirmed" | "cancelled" | undefined,
    page: number,
    pageSize: number
  ): Promise<PaginaDeHistorial> => {
    const cruda = await list({ competitionId, clubId: clubId || undefined, status: estado, page, pageSize });
    const p = validarPaginaRecibida<T>(cruda, page, pageSize);
    return { filas: p.items.map(aFila), total: p.total, page: p.page, pageSize: p.pageSize };
  };
}

export const cargadorDeInscripciones = (
  list: ListaPaginada<RegistrationItem>,
  competitionId: string,
  clubId: string | null | undefined
) => cargadorDe(list, competitionId, clubId, filaDeInscripcion);

export const cargadorDeRelevos = (
  list: ListaPaginada<RelayRegistrationItem>,
  competitionId: string,
  clubId: string | null | undefined
) => cargadorDe(list, competitionId, clubId, filaDeRelevo);
