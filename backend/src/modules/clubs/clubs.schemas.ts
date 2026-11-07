import { z } from "zod";
import { uuidField } from "../../shared/uuid.schema";
import { validateRun } from "../../shared/run.util";
import { usernameOpcionalField } from "../../shared/username.schema";
import { listaAcotada } from "../../shared/listaAcotada";
import { LIMITES_LISTAS } from "../../shared/limites-listas";

const codeField = z
  .string()
  .trim()
  .min(1, "La sigla es obligatoria")
  .max(5, "La sigla no puede tener más de 5 caracteres")
  .regex(/^[a-zA-Z0-9]+$/, "La sigla solo puede tener letras y números");

/**
 * Correo de contacto OPCIONAL. La ausencia es `null`, nunca una cadena vacía.
 *
 *   - ausente (`undefined`): en el alta equivale a «sin correo»; en la edición
 *     significa «no tocar» (lo decide quien usa el esquema, ver abajo);
 *   - `null`, `""` o solo espacios: «sin correo» (en la edición, lo elimina);
 *   - cualquier otro valor: se recorta y debe tener formato de correo.
 */
const emailOpcional = z
  .string()
  .nullable()
  .transform((valor) => (valor === null ? null : valor.trim() === "" ? null : valor.trim()))
  .refine((valor) => valor === null || z.string().email().safeParse(valor).success, "Correo electrónico inválido");

const MENSAJE_PERSONALIDAD_OBLIGATORIA =
  "Indique si el club tiene personalidad jurídica (Sí o No). El estado «pendiente de verificar» ya no existe: " +
  "si esta pantalla es anterior a ese cambio, recargue la página.";

const baseClubFields = {
  name: z.string().trim().min(2, "El nombre del club es obligatorio"),
  code: codeField,
  /**
   * DOS estados: `true` (tiene personalidad jurídica) y `false` (no tiene).
   *
   * Obligatorio y sin valor por omisión: omitirlo no puede significar «no
   * tiene», porque entonces un cliente que no lo envíe estaría afirmando algo
   * sin querer. `null` se rechaza con un mensaje que lo explica: hasta la
   * etapa 10a existía un tercer estado, «pendiente de verificar», que se
   * retiró; un cliente anterior que lo envíe debe enterarse en vez de recibir
   * un error de tipos.
   *
   * La columna es `NOT NULL` y sin valor por omisión (migración 10b): la base
   * tampoco admite «pendiente». Este rechazo con mensaje claro sigue siendo la
   * respuesta de la API (400) a un cuerpo anterior que envíe `null` u omita el campo.
   */
  hasLegalStatus: z.boolean({ error: MENSAJE_PERSONALIDAD_OBLIGATORIA }),
  rut: z.string().trim().optional(),
  legalName: z.string().trim().optional(),
  email: emailOpcional,
  // Sin .default([]) a propósito: en la actualización, "no enviado" (undefined)
  // debe significar "no tocar la lista actual" — el valor por defecto para
  // la creación se aplica aparte, solo en clubCreateSchema.
  // Tope de longitud comprobado ANTES de validar elementos (SEC-01); «no enviado» sigue siendo «no tocar».
  delegatePersonIds: listaAcotada(LIMITES_LISTAS.delegadosPorClub, z.array(uuidField()), "Un club admite como máximo 50 delegados").optional(),
  coachPersonIds: listaAcotada(LIMITES_LISTAS.entrenadoresPorClub, z.array(uuidField()), "Un club admite como máximo 50 entrenadores").optional(),
  // Solo aplica si hasLegalStatus === true. Con false la designación se
  // RECHAZA (ver refineRepresentanteLegal), no se descarta.
  legalRepresentativePersonId: uuidField().optional().nullable(),
  // SIN valor por omisión a propósito (SEC-03 C): Zod 4 aplica los `.default()` también dentro de campos opcionales, así que
  // si estos cuatro lo llevaran, `.partial()` en la actualización los rellenaría con `false` y restablecería las membresías
  // de un club que solo cambió su nombre. El `false` de la CREACIÓN se declara en `clubCreateSchema`.
  isAchmnMember: z.boolean(),
  isAchmnCollaborator: z.boolean(),
  isFchmnMember: z.boolean(),
  isFchmnCollaborator: z.boolean(),
};

/**
 * RB-02 con dos estados. El RUT se comporta distinto en cada uno:
 *
 * | personalidad jurídica | RUT |
 * |---|---|
 * | `true`  | **obligatorio**, con formato y dígito verificador válidos |
 * | `false` | no aplica: el servicio lo descarta, así que no se valida |
 */
function refineRut<T extends { hasLegalStatus: boolean; rut?: string }>(schema: z.ZodType<T>) {
  return schema.superRefine((data, ctx) => {
    if (data.hasLegalStatus === false) return; // el RUT no se guarda: nada que validar
    const rut = data.rut?.trim() ?? "";

    if (rut.length === 0) {
      ctx.addIssue({ code: "custom", path: ["rut"], message: "El RUT es obligatorio para clubes con personalidad jurídica" });
      return;
    }

    const result = validateRun(rut);
    if (!result.valid) {
      ctx.addIssue({
        code: "custom",
        path: ["rut"],
        message: result.reason === "FORMAT" ? "Formato de RUT inválido (use 12345678-9)" : "El dígito verificador del RUT no es válido",
      });
    }
  });
}

/**
 * Solo un club con personalidad jurídica puede tener representante legal.
 *
 * El representante legal no es un dato decorativo —comparte
 * `CLUB_STAFF_PERMISSIONS` con el delegado, o sea que es una vía de acceso al
 * sistema—, así que designarlo en un club «No tiene» se RECHAZA en vez de
 * descartarse en silencio.
 *
 * Esto cubre la designación NUEVA. Que un representante ya designado impida
 * cambiar el estado se comprueba en el servicio, que es quien ve la plantilla
 * actual del club.
 */
function refineRepresentanteLegal<T extends { hasLegalStatus: boolean; legalRepresentativePersonId?: string | null }>(schema: z.ZodType<T>) {
  return schema.superRefine((data, ctx) => {
    if (!data.legalRepresentativePersonId) return;
    if (data.hasLegalStatus === true) return;
    ctx.addIssue({
      code: "custom",
      path: ["legalRepresentativePersonId"],
      message: "Solo los clubes con personalidad jurídica pueden tener representante legal",
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
      ctx.addIssue({ code: "custom", path: ["isAchmnCollaborator"], message: "Un club no puede ser Socio y Colaborador ACHMN a la vez" });
    }
    if (data.isFchmnMember && data.isFchmnCollaborator) {
      ctx.addIssue({ code: "custom", path: ["isFchmnCollaborator"], message: "Un club no puede ser Socio y Colaborador FCHMN a la vez" });
    }
  });
}

export const clubCreateSchema = refineMembershipExclusivity(
  // `username` opcional: registrar un club no exige darle nombre de acceso.
  refineRepresentanteLegal(
    refineRut(
      z.object({
        ...baseClubFields,
        // En la creación, omitir una membresía equivale a «ninguna» (false). En la actualización, omitirla es «no modificar».
        isAchmnMember: z.boolean().default(false),
        isAchmnCollaborator: z.boolean().default(false),
        isFchmnMember: z.boolean().default(false),
        isFchmnCollaborator: z.boolean().default(false),
        email: emailOpcional.optional(),
        username: usernameOpcionalField.optional(),
      })
    )
  )
);
type ClubCreateSalida = z.infer<typeof clubCreateSchema>;
type IndicadoresDeMembresia = "isAchmnMember" | "isAchmnCollaborator" | "isFchmnMember" | "isFchmnCollaborator";
/**
 * Con Zod 3 los indicadores de membresía eran opcionales en este tipo (la entrada los admite omitidos y la creación los pone en
 * `false`); con Zod 4 la inferencia los volvería obligatorios. Se conserva la forma histórica: quien llama al servicio sin pasar
 * por HTTP puede omitirlos. Los datos que salen de `clubCreateSchema.parse` siempre los traen.
 */
export type ClubCreateInput = Omit<ClubCreateSalida, IndicadoresDeMembresia> & Partial<Pick<ClubCreateSalida, IndicadoresDeMembresia>>;

export const clubUpdateSchema = refineMembershipExclusivity(
  refineRepresentanteLegal(
  refineRut(
    z.object({
      ...baseClubFields,
      name: baseClubFields.name.optional(),
      // Omitido = conservar el valor; `null`, vacío o espacios = eliminarlo.
      email: emailOpcional.optional(),
      code: baseClubFields.code.optional(),
      hasLegalStatus: baseClubFields.hasLegalStatus, // siempre presente para poder re-evaluar la regla RB-02
      // Editable SOLO mientras el club no tenga cuenta vigente; lo decide el
      // servicio. Omitido = no tocar; `null`, vacío o espacios = quitarlo.
      username: usernameOpcionalField.optional(),
    }).partial({ name: true, email: true, code: true, isAchmnMember: true, isAchmnCollaborator: true, isFchmnMember: true, isFchmnCollaborator: true })
  )
  )
);
export type ClubUpdateInput = z.infer<typeof clubUpdateSchema>;

export const clubListQuerySchema = z.object({
  search: z.string().trim().optional(), // nombre, razón social, sigla o RUT
  status: z.enum(["active", "locked", "disabled"]).optional(),
  /**
   * Filtro por personalidad jurídica: `si` o `no`. «pendiente» ya no existe y se
   * rechaza con un mensaje que lo dice.
   *
   * Se resuelve en la CONSULTA, no en la página ya cargada: un filtro que solo
   * tamizara los 20 registros visibles diría «no hay clubes» cuando lo único
   * cierto es que no hay ninguno en esa página.
   */
  personalidadJuridica: z
    .enum(["si", "no"], {
      error: 'El filtro de personalidad jurídica solo admite "si" o "no". El estado "pendiente" ya no existe.',
    })
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ClubListQuery = z.infer<typeof clubListQuerySchema>;
