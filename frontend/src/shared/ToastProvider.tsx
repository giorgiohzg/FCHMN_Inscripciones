import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  kind: "success" | "error" | "info";
  message: string;
  action?: ToastAction;
}

interface ToastContextValue {
  showToast: (message: string, kind?: ToastItem["kind"], action?: ToastAction) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

const KIND_COLOR: Record<ToastItem["kind"], string> = {
  success: "var(--state-success)",
  error: "var(--state-danger)",
  info: "var(--brand-blue)",
};

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string, kind: ToastItem["kind"] = "success", action?: ToastAction) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, kind, message, action }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), action ? 6000 : 3500);
  }, []);

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div style={{ position: "fixed", bottom: "1.25rem", right: "1.25rem", display: "flex", flexDirection: "column", gap: "0.5rem", zIndex: 1000 }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              background: "white",
              border: `1px solid ${KIND_COLOR[t.kind]}`,
              borderLeft: `4px solid ${KIND_COLOR[t.kind]}`,
              borderRadius: 6,
              padding: "0.6rem 0.9rem",
              boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              minWidth: 260,
              fontSize: "0.88rem",
            }}
          >
            <span>{t.message}</span>
            {t.action && (
              <button
                className="btn-secondary"
                style={{ padding: "0.2rem 0.6rem", fontSize: "0.8rem" }}
                onClick={() => {
                  t.action!.onClick();
                  setToasts((prev) => prev.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast debe usarse dentro de <ToastProvider>");
  return ctx;
}
