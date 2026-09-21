import { useState, type KeyboardEvent } from "react";

interface InlineEditableCellProps {
  value: string;
  onSave: (newValue: string) => Promise<void>;
  type?: "text" | "number";
  placeholder?: string;
  emptyLabel?: string;
}

/**
 * Celda de tabla editable en el lugar: se muestra como texto normal; al
 * hacer clic, se convierte en un campo editable. Enter o perder el foco
 * guarda (solo si el valor cambió); Escape cancela sin guardar. Evita
 * tener que abrir un formulario aparte para cambiar un solo dato.
 */
export function InlineEditableCell({ value, onSave, type = "text", placeholder, emptyLabel = "—" }: InlineEditableCellProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  function startEdit() {
    setDraft(value);
    setEditing(true);
  }

  async function commit() {
    if (draft === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      setEditing(false);
    } catch {
      // Si falla, se deja el campo abierto con lo que el usuario escribió, para que pueda corregir y reintentar.
    } finally {
      setSaving(false);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    } else if (e.key === "Escape") {
      setDraft(value);
      setEditing(false);
    }
  }

  if (!editing) {
    return (
      <span
        onClick={startEdit}
        title="Clic para editar"
        style={{
          cursor: "pointer",
          borderBottom: "1px dashed var(--brand-gray-300, #ccc)",
          paddingBottom: 1,
          color: value ? "inherit" : "var(--brand-gray-600)",
        }}
      >
        {value || emptyLabel}
      </span>
    );
  }

  return (
    <input
      autoFocus
      type={type}
      value={draft}
      disabled={saving}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      style={{ padding: "0.2rem 0.4rem", fontSize: "0.85rem", maxWidth: 160 }}
    />
  );
}
