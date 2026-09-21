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
  hasLegalStatus: z.boolean(),
  rut: z.string().trim().optional(),
  legalName: z.string().trim().optional(),
  email: z.string().email("Correo electrónico inválido"),
  // Sin .default([]) a propósito: en la actualización, "no enviado" (undefined)
  // debe significar "no tocar la lista actual" — el valor por defecto para
  // la creación se aplica aparte, solo en clubCreateSchema.
  delegatePersonIds: z.array(z.string().uuid()).optional(),
  coachPersonIds: z.array(z.string().uuid()).optional(),
  // Solo aplica si hasLegalStatus=true — se ignora/limpia en el servicio si no.
  legalRepresentativePersonId: z.string().uuid().optional().nullable(),
  isAchmnMember: z.boolean().default(false),
  isAchmnCollaborator: z.boolean().default(false),
  isFchmnMember: z.boolean().default(false),
  isFchmnCollaborator: z.boolean().default(false),
};

/**
 * RB-02: el RUT es obligatorio (y se valida formato + dígito verificador)
 * únicamente si el club declara tener personalidad jurídica.
 */
function refineRut<T extends { hasLegalStatus: boolean; rut?: string }>(schema: z.ZodType<T>) {
  return schema.superRefine((data, ctx) => {
    if (data.hasLegalStatus) {
      if (!data.rut || data.rut.trim().length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["rut"], message: "El RUT es obligatorio para clubes con personalidad jurídica" });
        return;
      }
      const result = validateRun(data.rut);
      if (!result.valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rut"],
          message: result.reason === "FORMAT" ? "Formato de RUT inválido (use 12345678-9)" : "El dígito verificador del RUT no es válido",
        });
      }
    }
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

export const clubCreateSchema = refineMembershipExclusivity(refineRut(z.object({ ...baseClubFields, username: usernameField })));
export type ClubCreateInput = z.infer<typeof clubCreateSchema>;

export const clubUpdateSchema = refineMembershipExclusivity(
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
);
export type ClubUpdateInput = z.infer<typeof clubUpdateSchema>;

export const clubListQuerySchema = z.object({
  search: z.string().trim().optional(), // nombre, razón social, sigla o RUT
  status: z.enum(["active", "locked", "disabled"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ClubListQuery = z.infer<typeof clubListQuerySchema>;
