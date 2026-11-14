import { z } from "zod";
import { validateRun } from "../../shared/run.util";
import { usernameOpcionalField } from "../../shared/username.schema";
import { uuidField } from "../../shared/uuid.schema";

const runField = z.string().superRefine((val, ctx) => {
  const result = validateRun(val);
  if (!result.valid) {
    ctx.addIssue({
      code: "custom",
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
  // Opcional: registrar a una persona no exige darle nombre de acceso, ni se
  // le genera uno. Ausente, `null`, vacío o espacios = sin nombre (`null`).
  username: usernameOpcionalField.optional(),
  firstName: z.string().trim().min(2, "El nombre es obligatorio"),
  paternalLastName: z.string().trim().min(2, "El apellido paterno es obligatorio"),
  maternalLastName: z.string().trim().optional(),
  birthDate: z.coerce.date({ error: "Fecha de nacimiento inválida" }),
  gender: z.enum(["male", "female"], { error: "Debe indicar el género de la persona" }),
  email: z.union([z.string().trim().email("Correo electrónico inválido"), z.literal("")]).optional().transform((v) => (v ? v : undefined)).optional(),
  phone: z.string().trim().optional(),
  /**
   * «Asignación a club» del alta: ausente o `null` = sin asignación. Con un club, la persona se
   * crea con su membresía ACTIVA en ese club desde hoy (America/Santiago), con las reglas de la
   * asignación directa de C-05 y en la MISMA transacción (`createPersonWithOptionalClub`). Solo
   * existe en el alta: la edición no es un mecanismo de traslado.
   */
  clubId: uuidField("Club inválido").nullable().optional(),
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
    .undefined({ error: "Los roles no se asignan desde la ficha de la persona: son derivados. El de nadador se obtiene al incorporarla al plantel de un club, y los de delegado, entrenador y representante legal al nombrarla en la ficha del club. Quite el campo `roles` de la petición." })
    .optional(),
});
export type PersonCreateInput = z.infer<typeof personCreateSchema>;

export const personUpdateSchema = z.object({
  firstName: z.string().trim().min(2).optional(),
  paternalLastName: z.string().trim().min(2).optional(),
  maternalLastName: z.string().trim().optional(),
  birthDate: z.coerce.date().optional(),
  gender: z.enum(["male", "female"]).optional(),
  email: z.union([z.string().trim().email("Correo electrónico inválido"), z.literal("")]).optional().transform((v) => (v === "" ? null : v)).optional(),
  phone: z.string().trim().optional(),
  // `roles` se rechaza igual que en la creación, y por lo mismo. Ver allí.
  roles: z
    .undefined({ error: "Los roles no se asignan desde la ficha de la persona: son derivados. El de nadador se obtiene al incorporarla al plantel de un club, y los de delegado, entrenador y representante legal al nombrarla en la ficha del club. Quite el campo `roles` de la petición." })
    .optional(),
  /**
   * Nombre de usuario: editable SOLO mientras la persona no tenga una cuenta
   * vigente (activa, bloqueada o inhabilitada). Con cuenta ya es el nombre con
   * el que entra, y cambiarlo rompería el inicio de sesión; lo rechaza el
   * servicio y, por debajo, `titular_forbid_rename_con_cuenta`.
   * Omitido = no tocar; `null`, vacío o espacios = quitarlo.
   */
  username: usernameOpcionalField.optional(),
  // El RUN sigue sin ser editable tras la creación.
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

/**
 * Casilla «Habilitar permisos de administrador».
 *
 * Va en su propio endpoint y no dentro de `personUpdateSchema` a propósito:
 * conceder administración exige el ROL `admin`, mientras que editar la ficha
 * se conforma con el permiso `persons:write`. Mezclarlos obligaría a que un
 * solo guard cubriera dos niveles de autorización distintos, y la parte más
 * sensible quedaría protegida por la más laxa.
 *
 * El booleano es obligatorio: un campo ausente significaría «no cambiar», y
 * para una operación cuyo único objeto es cambiarlo eso solo puede ser un
 * error de quien llama.
 */
export const adminAccessSchema = z.object({
  adminAccess: z.boolean({ error: "Indique si la persona debe tener permisos de administrador" }),
});
export type AdminAccessInput = z.infer<typeof adminAccessSchema>;

/**
 * Cuerpo de «Crear credenciales» (personas y clubes). Todo opcional.
 *
 * `username`: si viene, se asigna al titular EN LA MISMA TRANSACCIÓN que crea
 * la cuenta; si no viene —o viene `null`, vacío o de espacios—, se usa el que
 * el titular ya tenga guardado. Sin ninguno de los dos, la operación responde
 * 400 y no escribe nada. Los clientes anteriores, que no envían cuerpo, siguen
 * funcionando igual.
 */
export const createCredentialsSchema = z.object({ username: usernameOpcionalField.optional() }).optional();
export type CreateCredentialsInput = z.infer<typeof createCredentialsSchema>;
