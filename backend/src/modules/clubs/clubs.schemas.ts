import { z } from "zod";
import { validateRun } from "../../shared/run.util";
import { usernameField } from "../../shared/username.schema";

const codeField = z
  .string()
  .trim()
  .min(1, "La sigla es obligatoria")
  .max(5, "La sigla no puede tener más de 5 caracteres")
  .regex(/^[a-zA-Z0-9]+$/, "La sigla solo puede tener letras y números");

const baseClubFields = {
  name: z.string().trim().min(2, "El nombre del club es obligatorio"),
  code: codeField,
  /**
   * TRES estados, y `null` NO es `false`:
   *   `true`  — tiene personalidad jurídica
   *   `false` — se verificó que no la tiene
   *   `null`  — **pendiente de verificar**
   *
   * `.nullable()` y no `.optional()`: omitir el campo no puede significar
   * «pendiente», porque entonces un cliente que no lo envíe estaría declarando
   * algo sin querer. Para dejarlo pendiente hay que enviar `null` a propósito.
   */
  hasLegalStatus: z.boolean().nullable(),
  rut: z.string().trim().optional(),
  legalName: z.string().trim().optional(),
  email: z.string().email("Correo electrónico inválido"),
  // Sin .default([]) a propósito: en la actualización, "no enviado" (undefined)
  // debe significar "no tocar la lista actual" — el valor por defecto para
  // la creación se aplica aparte, solo en clubCreateSchema.
  delegatePersonIds: z.array(z.string().uuid()).optional(),
  coachPersonIds: z.array(z.string().uuid()).optional(),
  // Solo aplica si hasLegalStatus === true. En los otros dos estados la
  // designación se RECHAZA (ver refineRepresentanteLegal), no se descarta.
  legalRepresentativePersonId: z.string().uuid().optional().nullable(),
  isAchmnMember: z.boolean().default(false),
  isAchmnCollaborator: z.boolean().default(false),
  isFchmnMember: z.boolean().default(false),
  isFchmnCollaborator: z.boolean().default(false),
};

/**
 * RB-02 con tres estados. El RUT se comporta distinto en cada uno:
 *
 * | personalidad jurídica | RUT |
 * |---|---|
 * | `true`  | **obligatorio**, con formato y dígito verificador válidos |
 * | `null`  | **opcional**, y validado igual si viene |
 * | `false` | no aplica: el servicio lo descarta, así que no se valida |
 *
 * Que un club pendiente pueda guardar su RUT es deliberado: el RUT es
 * precisamente la evidencia que permite CERRAR la verificación, y descartarlo
 * obligaría a volver a pedirlo. **Tener RUT no cambia el estado por su cuenta:**
 * pasar a `true` sigue siendo una decisión que alguien toma explícitamente.
 *
 * Las comparaciones son `=== true` / `=== false` a propósito. Con
 * `boolean | null`, un `if (data.hasLegalStatus)` seguiría compilando y trataría
 * «pendiente» como «no» en silencio, que es justo lo que este cambio evita.
 */
function refineRut<T extends { hasLegalStatus: boolean | null; rut?: string }>(schema: z.ZodType<T>) {
  return schema.superRefine((data, ctx) => {
    if (data.hasLegalStatus === false) return; // el RUT no se guarda: nada que validar
    const rut = data.rut?.trim() ?? "";

    if (data.hasLegalStatus === true && rut.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rut"], message: "El RUT es obligatorio para clubes con personalidad jurídica" });
      return;
    }
    if (rut.length === 0) return; // pendiente y sin RUT: válido

    const result = validateRun(rut);
    if (!result.valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rut"],
        message: result.reason === "FORMAT" ? "Formato de RUT inválido (use 12345678-9)" : "El dígito verificador del RUT no es válido",
      });
    }
  });
}

/**
 * No se designa representante legal sin personalidad jurídica CONFIRMADA.
 *
 * Mientras está pendiente de verificar, tampoco: el representante legal no es
 * un dato decorativo —comparte `CLUB_STAFF_PERMISSIONS` con el delegado, o sea
 * que es una vía de acceso al sistema— y nombrarlo apoyándose en una
 * personalidad jurídica que nadie comprobó sería conceder ese acceso sobre un
 * supuesto.
 *
 * Esto cubre la designación NUEVA. Que un representante ya designado impida
 * cambiar el estado se comprueba en el servicio, que es quien ve la plantilla
 * actual del club.
 */
function refineRepresentanteLegal<T extends { hasLegalStatus: boolean | null; legalRepresentativePersonId?: string | null }>(schema: z.ZodType<T>) {
  return schema.superRefine((data, ctx) => {
    if (!data.legalRepresentativePersonId) return;
    if (data.hasLegalStatus === true) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["legalRepresentativePersonId"],
      message:
        data.hasLegalStatus === null
          ? "No se puede designar un representante legal mientras la personalidad jurídica esté pendiente de verificar. Confirme primero la personalidad jurídica."
          : "Solo los clubes con personalidad jurídica pueden tener representante legal",
    });
  });
}

/**
 * Cada membresía (ACHMN / FCHMN) es Socio o Colaborador, nunca ambas a la
 * vez — la interfaz ya lo exige con radiobutton, esto es una segunda
 * validación en el servidor por si acaso.
 */
function refineMembershipExclusivity<T extends { isAchmnMember?: boolean; isAchmnCollaborator?: boolean; isFchmnMember?: boolean; isFchmnCollaborator?: boolean }>(
  schema: z.ZodType<T>
) {
  return schema.superRefine((data, ctx) => {
    if (data.isAchmnMember && data.isAchmnCollaborator) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["isAchmnCollaborator"], message: "Un club no puede ser Socio y Colaborador ACHMN a la vez" });
    }
    if (data.isFchmnMember && data.isFchmnCollaborator) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["isFchmnCollaborator"], message: "Un club no puede ser Socio y Colaborador FCHMN a la vez" });
    }
  });
}

export const clubCreateSchema = refineMembershipExclusivity(
  refineRepresentanteLegal(refineRut(z.object({ ...baseClubFields, username: usernameField })))
);
export type ClubCreateInput = z.infer<typeof clubCreateSchema>;

export const clubUpdateSchema = refineMembershipExclusivity(
  refineRepresentanteLegal(
  refineRut(
    z.object({
      ...baseClubFields,
      name: baseClubFields.name.optional(),
      email: baseClubFields.email.optional(),
      code: baseClubFields.code.optional(),
      hasLegalStatus: baseClubFields.hasLegalStatus, // siempre presente para poder re-evaluar la regla RB-02
      // username deliberadamente no editable — ver misma razón que en Personas.
    }).partial({ name: true, email: true, code: true, isAchmnMember: true, isAchmnCollaborator: true, isFchmnMember: true, isFchmnCollaborator: true })
  )
  )
);
export type ClubUpdateInput = z.infer<typeof clubUpdateSchema>;

export const clubListQuerySchema = z.object({
  search: z.string().trim().optional(), // nombre, razón social, sigla o RUT
  status: z.enum(["active", "locked", "disabled"]).optional(),
  /**
   * Filtro por personalidad jurídica, con sus tres estados.
   *
   * Se resuelve en la CONSULTA, no en la página ya cargada: un filtro que solo
   * tamizara los 20 registros visibles diría «no hay clubes pendientes» cuando
   * lo único cierto es que no hay ninguno en esa página.
   */
  personalidadJuridica: z.enum(["si", "no", "pendiente"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ClubListQuery = z.infer<typeof clubListQuerySchema>;
