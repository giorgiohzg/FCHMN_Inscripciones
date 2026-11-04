/**
 * Hallazgo 19 — el representante legal como rol de acceso.
 *
 * La regla de negocio confirmada es que el representante legal SÍ es un rol de
 * acceso y opera sobre el club donde fue nombrado con **las mismas
 * atribuciones que un delegado**. Eso estaba escrito en un comentario de
 * `rbac.definitions.ts` y en ninguna prueba: una edición de la matriz de
 * permisos podía separar los tres roles sin que nada lo advirtiera.
 *
 * Aquí se fija la equivalencia como invariante comprobable, junto con lo que
 * el rol NO debe poder hacer nunca.
 */
import { describe, it, expect } from "vitest";
import { PERMISSIONS, ROLES, CLUB_STAFF_PERMISSIONS } from "../src/modules/auth/rbac.definitions";

describe("matriz de permisos por rol", () => {
  it("delegado, entrenador y representante legal tienen EXACTAMENTE los mismos permisos", () => {
    const ordenado = (permisos: string[]) => [...permisos].sort();

    expect(ordenado(ROLES.legal_representative!)).toEqual(ordenado(ROLES.delegate!));
    expect(ordenado(ROLES.coach!)).toEqual(ordenado(ROLES.delegate!));
    expect(ordenado(ROLES.delegate!)).toEqual(ordenado(CLUB_STAFF_PERMISSIONS));
  });

  it("el representante legal NO recibe permisos de administración", () => {
    // La decisión fue "mismas atribuciones que un delegado", no "más": si
    // alguien le agregara uno de estos, deja de ser personal de club.
    for (const prohibido of ["persons:write", "clubs:write", "catalogs:write", "competitions:write", "audit:read", "swimmer-assignment:approve"]) {
      expect(ROLES.legal_representative, `no debe tener ${prohibido}`).not.toContain(prohibido);
    }
  });

  it("exportar a Team Manager: administrador, rol `club` y personal de club sí; nadador no", () => {
    // El alcance (solo SU club) lo aplica el servicio exportador, no la matriz.
    for (const rol of ["admin", "club", "delegate", "coach", "legal_representative"]) {
      expect(ROLES[rol], `${rol} debe poder exportar`).toContain("export:team-manager");
    }
    expect(ROLES.swimmer, "swimmer NO debe poder exportar").not.toContain("export:team-manager");
  });

  it("agregar la exportación al rol `club` no le amplía ningún otro permiso", () => {
    // Fija el conjunto completo: lo único que el rol `club` tiene de más respecto de antes es la exportación.
    expect([...ROLES.club!].sort()).toEqual(
      [
        "catalogs:read",
        "clubs:read",
        "competitions:read",
        "export:team-manager",
        "registrations:read",
        "registrations:write",
        "reports:read",
        "swimmer-assignment:read",
        "swimmer-assignment:write",
      ].sort()
    );
    // Y sigue siendo el mismo conjunto que el personal de club: la exportación no abre una diferencia nueva.
    expect([...ROLES.club!].sort()).toEqual([...CLUB_STAFF_PERMISSIONS].sort());
  });

  it("todo permiso asignado a un rol existe en el catálogo", () => {
    const catalogo = new Set<string>(PERMISSIONS);
    for (const [rol, permisos] of Object.entries(ROLES)) {
      for (const permiso of permisos) {
        expect(catalogo.has(permiso), `el rol ${rol} referencia un permiso inexistente: ${permiso}`).toBe(true);
      }
    }
  });

  it("solo el administrador tiene el catálogo completo", () => {
    expect([...ROLES.admin!].sort()).toEqual([...PERMISSIONS].sort());
    for (const [rol, permisos] of Object.entries(ROLES)) {
      if (rol === "admin") continue;
      expect(permisos.length, `${rol} no puede tener todos los permisos`).toBeLessThan(PERMISSIONS.length);
    }
  });
});
