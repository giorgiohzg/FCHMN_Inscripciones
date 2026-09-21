/**
 * Reglas de transición de estado para una solicitud de asignación de
 * nadador a club (A-05: el club propone, el administrador aprueba/rechaza).
 *
 * Se aísla como función pura (sin acceso a base de datos) para poder
 * testear la lógica de negocio de forma determinística y rápida.
 */
export type ClubSwimmerStatus = "pending" | "active" | "rejected" | "ended";
export type ClubSwimmerAction = "approve" | "reject" | "end";

export interface TransitionResult {
  allowed: boolean;
  nextStatus?: ClubSwimmerStatus;
  reason?: string;
}

const TRANSITIONS: Record<ClubSwimmerAction, { from: ClubSwimmerStatus; to: ClubSwimmerStatus }> = {
  approve: { from: "pending", to: "active" },
  reject: { from: "pending", to: "rejected" },
  end: { from: "active", to: "ended" },
};

export function evaluateTransition(current: ClubSwimmerStatus, action: ClubSwimmerAction): TransitionResult {
  const rule = TRANSITIONS[action];

  if (current !== rule.from) {
    return {
      allowed: false,
      reason: `No se puede ${actionLabel(action)} una solicitud en estado '${current}' (se esperaba '${rule.from}')`,
    };
  }

  return { allowed: true, nextStatus: rule.to };
}

function actionLabel(action: ClubSwimmerAction): string {
  switch (action) {
    case "approve":
      return "aprobar";
    case "reject":
      return "rechazar";
    case "end":
      return "finalizar";
  }
}

/** true si el estado es terminal (no admite más transiciones). */
export function isTerminalStatus(status: ClubSwimmerStatus): boolean {
  return status === "rejected" || status === "ended";
}
