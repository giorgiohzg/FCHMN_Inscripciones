import { useState, type ReactNode } from "react";

export type SortDir = "asc" | "desc";

/**
 * Hook de ordenamiento por columna: guarda qué columna está activa y en
 * qué dirección. Un mismo clic en la columna activa invierte la
 * dirección; un clic en otra columna la activa en ascendente.
 */
export function useSort<K extends string>(initialKey: K | null = null, initialDir: SortDir = "asc") {
  const [sortKey, setSortKey] = useState<K | null>(initialKey);
  const [sortDir, setSortDir] = useState<SortDir>(initialDir);

  function onSort(key: K) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  return { sortKey, sortDir, onSort };
}

/**
 * Ordena una copia del arreglo según `key`/`dir`, usando `getValue` para
 * extraer el valor comparable de cada fila para esa columna. `null`/`undefined`
 * siempre quedan al final, sin importar la dirección. Strings se comparan
 * con `localeCompare("es")` (acentos y mayúsculas correctos en español).
 */
export function sortItems<T, K extends string>(
  items: T[],
  sortKey: K | null,
  sortDir: SortDir,
  getValue: (item: T, key: K) => string | number | Date | null | undefined
): T[] {
  if (!sortKey) return items;
  const withIndex = items.map((item, index) => ({ item, index }));
  withIndex.sort((a, b) => {
    const va = getValue(a.item, sortKey);
    const vb = getValue(b.item, sortKey);
    const aEmpty = va === null || va === undefined;
    const bEmpty = vb === null || vb === undefined;
    if (aEmpty && bEmpty) return a.index - b.index; // orden estable
    if (aEmpty) return 1;
    if (bEmpty) return -1;

    let cmp: number;
    if (va instanceof Date && vb instanceof Date) cmp = va.getTime() - vb.getTime();
    else if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
    else cmp = String(va).localeCompare(String(vb), "es", { sensitivity: "base" });

    if (cmp === 0) return a.index - b.index; // orden estable ante empates
    return sortDir === "asc" ? cmp : -cmp;
  });
  return withIndex.map((w) => w.item);
}

/**
 * Encabezado de columna ordenable: clic para ordenar, con una flechita
 * que muestra la dirección activa (o un ícono neutro si esta columna no
 * es la que está ordenando la tabla en este momento).
 */
export function SortableTh<K extends string>({
  label,
  sortKey,
  activeKey,
  activeDir,
  onSort,
}: {
  label: ReactNode;
  sortKey: K;
  activeKey: K | null;
  activeDir: SortDir;
  onSort: (key: K) => void;
}) {
  const isActive = activeKey === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      style={{ cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}
      title="Clic para ordenar"
    >
      {label}{" "}
      <span style={{ fontSize: "0.72em", color: isActive ? "inherit" : "var(--brand-gray-300, #bbb)" }}>
        {isActive ? (activeDir === "asc" ? "▲" : "▼") : "⇅"}
      </span>
    </th>
  );
}
