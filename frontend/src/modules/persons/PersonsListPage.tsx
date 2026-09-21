import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "../../shared/AppShell";
import { usePersonsApi, type Person, type PersonRoleType, type AccountStatus } from "./personsApi";
import { InlineEditableCell } from "../../shared/InlineEditableCell";
import { useSort, sortItems, SortableTh } from "../../shared/sortableTable";

const ROLE_LABELS: Record<PersonRoleType, string> = {
  swimmer: "Nadador",
  delegate: "Delegado",
  coach: "Entrenador",
  legal_representative: "Representante legal",
};

const STATUS_LABELS: Record<AccountStatus, string> = {
  active: "Activo",
  locked: "Bloqueado",
  disabled: "Inhabilitado",
};
const STATUS_BADGE: Record<AccountStatus, string> = {
  active: "badge-active",
  locked: "badge-locked",
  disabled: "badge-disabled",
};

export function PersonsListPage() {
  const api = usePersonsApi();
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<PersonRoleType | "">("");
  const [status, setStatus] = useState<AccountStatus | "">("");
  const [data, setData] = useState<{ items: Person[]; total: number; page: number; pageSize: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const { sortKey, sortDir, onSort } = useSort<"run" | "fullName" | "roles" | "email" | "phone" | "status">();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.list({
        search: search || undefined,
        role: (role || undefined) as PersonRoleType | undefined,
        status: (status || undefined) as AccountStatus | undefined,
        page,
      });
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error al cargar personas");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, role, status, page]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleAction(action: "block" | "disable" | "reactivate" | "remove", person: Person) {
    const confirmMsg: Record<string, string> = {
      block: `¿Bloquear a ${person.fullName}?`,
      disable: `¿Inhabilitar a ${person.fullName}?`,
      reactivate: `¿Reactivar a ${person.fullName}?`,
      remove: `¿Eliminar a ${person.fullName}? Esta acción no se puede deshacer desde la interfaz.`,
    };
    if (!window.confirm(confirmMsg[action])) return;

    try {
      if (action === "block") await api.block(person.id);
      if (action === "disable") await api.disable(person.id);
      if (action === "reactivate") await api.reactivate(person.id);
      if (action === "remove") await api.remove(person.id);
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "No se pudo completar la acción");
    }
  }

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h1 style={{ color: "var(--brand-navy)" }}>Personas</h1>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <Link to="/personas/carga-masiva" className="btn-secondary" style={{ textDecoration: "none" }}>
            Carga masiva
          </Link>
          <Link to="/personas/nueva" className="btn-primary" style={{ textDecoration: "none" }}>
            + Nueva persona
          </Link>
        </div>
      </div>

      <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        <input
          placeholder="Buscar por nombre o RUN..."
          value={search}
          onChange={(e) => {
            setPage(1);
            setSearch(e.target.value);
          }}
          style={{ maxWidth: 280 }}
        />
        <select value={role} onChange={(e) => { setPage(1); setRole(e.target.value as PersonRoleType | ""); }} style={{ maxWidth: 180 }}>
          <option value="">Todos los roles</option>
          <option value="swimmer">Nadador</option>
          <option value="delegate">Delegado</option>
          <option value="coach">Entrenador</option>
          <option value="legal_representative">Representante legal</option>
        </select>
        <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value as AccountStatus | ""); }} style={{ maxWidth: 180 }}>
          <option value="">Todos los estados</option>
          <option value="active">Activo</option>
          <option value="locked">Bloqueado</option>
          <option value="disabled">Inhabilitado</option>
        </select>
      </div>

      {error && <p className="error-message">{error}</p>}
      {loading && <p>Cargando...</p>}

      {data && (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh label="RUN" sortKey="run" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Nombre completo" sortKey="fullName" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Roles" sortKey="roles" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Correo" sortKey="email" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Teléfono" sortKey="phone" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <SortableTh label="Estado" sortKey="status" activeKey={sortKey} activeDir={sortDir} onSort={onSort} />
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {sortItems(data.items, sortKey, sortDir, (p, key) => {
                switch (key) {
                  case "run": return p.run;
                  case "fullName": return p.fullName;
                  case "roles": return p.roles.filter((r) => r.active).map((r) => ROLE_LABELS[r.roleType]).join(", ");
                  case "email": return p.email;
                  case "phone": return p.phone ?? null;
                  case "status": return STATUS_LABELS[p.status];
                }
              }).map((p) => (
                <tr key={p.id}>
                  <td>{p.run}</td>
                  <td>
                    <Link to={`/personas/${p.id}`}>{p.fullName}</Link>
                  </td>
                  <td>{p.roles.filter((r) => r.active).map((r) => ROLE_LABELS[r.roleType]).join(", ")}</td>
                  <td>
                    <InlineEditableCell
                      value={p.email ?? ""}
                      onSave={async (v) => {
                        if (v.trim() && !v.includes("@")) throw new Error("Correo inválido");
                        await api.update(p.id, { email: v.trim() });
                        load();
                      }}
                    />
                  </td>
                  <td>
                    <InlineEditableCell
                      value={p.phone ?? ""}
                      emptyLabel="Agregar teléfono"
                      onSave={async (v) => {
                        await api.update(p.id, { phone: v.trim() || undefined });
                        load();
                      }}
                    />
                  </td>
                  <td>
                    <span className={`badge ${STATUS_BADGE[p.status]}`}>{STATUS_LABELS[p.status]}</span>
                  </td>
                  <td style={{ display: "flex", gap: "0.4rem" }}>
                    {p.status === "active" && (
                      <button className="btn-secondary" onClick={() => handleAction("block", p)}>
                        Bloquear
                      </button>
                    )}
                    {p.status !== "disabled" && (
                      <button className="btn-secondary" onClick={() => handleAction("disable", p)}>
                        Inhabilitar
                      </button>
                    )}
                    {p.status !== "active" && (
                      <button className="btn-secondary" onClick={() => handleAction("reactivate", p)}>
                        Reactivar
                      </button>
                    )}
                    <button className="btn-danger" onClick={() => handleAction("remove", p)}>
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
              {data.items.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", color: "var(--brand-gray-600)", padding: "1.5rem" }}>
                    No se encontraron personas con los filtros aplicados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div style={{ marginTop: "1rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.85rem", color: "var(--brand-gray-600)" }}>
              {data.total} persona(s) — página {data.page}
            </span>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Anterior
              </button>
              <button
                className="btn-secondary"
                disabled={page * data.pageSize >= data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Siguiente
              </button>
            </div>
          </div>
        </>
      )}
    </AppShell>
  );
}
