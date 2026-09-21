import { z } from "zod";
import { validateRun } from "../../shared/run.util";
import { usernameField } from "../../shared/username.schema";

const runField = z.string().superRefine((val, ctx) => {
  const result = validateRun(val);
  if (!result.valid) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        result.reason === "FORMAT"
          ? "Formato de RUN inválido (use 12345678-9)"
          : "El dígito verificador del RUN no es válido",
    });
  }
});

const roleTypeEnum = z.enum(["swimmer", "delegate", "coach", "legal_representative"]);

export const personCreateSchema = z.object({
  run: runField,
  username: usernameField,
  firstName: z.string().trim().min(2, "El nombre es obligatorio"),
  paternalLastName: z.string().trim().min(2, "El apellido paterno es obligatorio"),
  maternalLastName: z.string().trim().optional(),
  birthDate: z.coerce.date({ errorMap: () => ({ message: "Fecha de nacimiento inválida" }) }),
  gender: z.enum(["male", "female"], { errorMap: () => ({ message: "Debe indicar el género de la persona" }) }),
  email: z.union([z.string().trim().email("Correo electrónico inválido"), z.literal("")]).optional().transform((v) => (v ? v : undefined)),
  phone: z.string().trim().optional(),
  /**
   * `roles` SE RECHAZA, no se ignora.
   *
   * Los cuatro `person_roles` se derivan de relaciones reales: `swimmer` de una
   * membresía activa (`syncSwimmerRole`), y delegado, entrenador y
   * representante legal del nombramiento en `club_staff`. Aceptarlos aquí
   * permitía fabricar un rol sin la relación que lo justifica.
   *
   * Descartarlos en silencio —que es lo que hace Zod con un campo desconocido—
   * es peor que rechazarlos: un cliente antiguo enviaría roles, recibiría un
   * 201 y daría por hecha una operación que nunca ocurrió. La carga masiva por
   * Excel ya rechaza su columna en desuso por el mismo motivo; esto lo iguala.
   */
  roles: z
    .undefined({ errorMap: () => ({ message: "Los roles no se asignan desde la ficha de la persona: son derivados. El de nadador se obtiene al incorporarla al plantel de un club, y los de delegado, entrenador y representante legal al nombrarla en la ficha del club. Quite el campo `roles` de la petición." }) })
    .optional(),
});
export type PersonCreateInput = z.infer<typeof personCreateSchema>;

export const personUpdateSchema = z.object({
  firstName: z.string().trim().min(2).optional(),
  paternalLastName: z.string().trim().min(2).optional(),
  maternalLastName: z.string().trim().optional(),
  birthDate: z.coerce.date().optional(),
  gender: z.enum(["male", "female"]).optional(),
  email: z.union([z.string().trim().email("Correo electrónico inválido"), z.literal("")]).optional().transform((v) => (v === "" ? null : v)),
  phone: z.string().trim().optional(),
  // `roles` se rechaza igual que en la creación, y por lo mismo. Ver allí.
  roles: z
    .undefined({ errorMap: () => ({ message: "Los roles no se asignan desde la ficha de la persona: son derivados. El de nadador se obtiene al incorporarla al plantel de un club, y los de delegado, entrenador y representante legal al nombrarla en la ficha del club. Quite el campo `roles` de la petición." }) })
    .optional(),
  // RUN y nombre de usuario deliberadamente no editables tras la creación
  // — el nombre de usuario ya pudo haberse usado para crear credenciales
  // de acceso (User.username), y desincronizarlos rompería el login.
});
export type PersonUpdateInput = z.infer<typeof personUpdateSchema>;

export const personListQuerySchema = z.object({
  search: z.string().trim().optional(), // busca por RUN o nombre
  role: roleTypeEnum.optional(),
  status: z.enum(["active", "locked", "disabled"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PersonListQuery = z.infer<typeof personListQuerySchema>;

export const createCredentialsSchema = z.object({}).optional();
export type CreateCredentialsInput = z.infer<typeof createCredentialsSchema>;
