interface CircledNumberProps {
  n: number | null | undefined;
  size?: number;
}

/** Número de prueba encerrado en un círculo — reemplaza al "#N" en todas las pantallas donde se numeran pruebas. */
export function CircledNumber({ n, size = 18 }: CircledNumberProps) {
  if (n === null || n === undefined) return null;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        minWidth: size,
        borderRadius: "50%",
        border: "1px solid var(--brand-gray-300, #cbd5de)",
        color: "var(--brand-gray-600)",
        fontSize: size * 0.58,
        fontWeight: 600,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {n}
    </span>
  );
}
