import { api } from "../../shared/apiClient";

export type RolConfigurable = "swimmer" | "delegate" | "coach";
export const ROLES: readonly RolConfigurable[] = ["swimmer", "delegate", "coach"];
export const NOMBRE_DEL_ROL: Record<RolConfigurable, string> = { swimmer: "Nadador", delegate: "Delegado", coach: "Entrenador" };

export interface FuncionDescrita {
  id: string;
  etiqueta: string;
  menu: string | null;
  /** Roles configurables en que la función existe hoy. Fuera de ellos: «No aplica». */
  aplicaA: RolConfigurable[];
}

export interface GrupoDeFunciones {
  menu: FuncionDescrita | null;
  acciones: FuncionDescrita[];
  noConfigurables: { id: string; etiqueta: string; nota: string }[];
}

export type Valores = Record<RolConfigurable, Record<string, boolean>>;

export interface ConfiguracionDeAccesos {
  version: number;
  valores: Valores;
  ultimaModificacion: { en: string; por: { id: string; username: string } | null } | null;
  roles: RolConfigurable[];
  grupos: GrupoDeFunciones[];
  siempreDisponibles: string[];
}

export function useAccesosApi() {
  return {
    leer: () => api.get<ConfiguracionDeAccesos>("/accesos-por-rol"),
    guardar: (version: number, valores: Valores) =>
      api.put<{ configuracion: ConfiguracionDeAccesos; cambios: number }>("/accesos-por-rol", { version, valores }),
  };
}

export interface Cambio {
  rol: RolConfigurable;
  funcion: string;
  etiqueta: string;
  antes: boolean;
  despues: boolean;
}

/** Celdas que difieren entre dos estados, en el orden de la pantalla. */
export function diferencias(antes: Valores, despues: Valores, grupos: GrupoDeFunciones[]): Cambio[] {
  const cambios: Cambio[] = [];
  for (const g of grupos) {
    for (const f of [...(g.menu ? [g.menu] : []), ...g.acciones]) {
      for (const rol of f.aplicaA) {
        const a = antes[rol]?.[f.id];
        const d = despues[rol]?.[f.id];
        if (typeof a === "boolean" && typeof d === "boolean" && a !== d) {
          cambios.push({ rol, funcion: f.id, etiqueta: g.menu && f.id !== g.menu.id ? `${g.menu.etiqueta}: ${f.etiqueta}` : f.etiqueta, antes: a, despues: d });
        }
      }
    }
  }
  return cambios;
}
