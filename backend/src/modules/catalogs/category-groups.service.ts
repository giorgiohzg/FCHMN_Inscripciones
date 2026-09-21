import { prisma } from "../../shared/prisma.client";
import { withAudit } from "../audit/audit.service";
import { ValidationError, NotFoundError, ConflictError } from "../../shared/errors";
import { withTranslatedPrismaErrors } from "../../shared/prismaErrors";

interface ActorContext {
  userId: string;
  ipAddress?: string;
}

export function listCategoryGroups() {
  return prisma.categoryGroup.findMany({ where: { deletedAt: null }, orderBy: { name: "asc" } });
}

/**
 * La comprobación previa de nombre duplicado sigue existiendo para dar un
 * mensaje claro en el caso normal, pero NO es la garantía: entre el
 * `findFirst` y el `create` cabe otra solicitud con el mismo nombre. Quien
 * garantiza la unicidad es el índice parcial `category_groups_name_unique_active`,
 * y su P2002 se traduce aquí a un 409 con el mismo texto, para que dos
 * usuarios creando el grupo a la vez reciban un conflicto entendible en vez
 * de un error interno.
 *
 * La clave del override es `Modelo.columnas` —lo único que Prisma informa en
 * `meta`—, no el nombre del índice: con el nombre no coincidía nunca y el
 * conflicto salía con el texto genérico.
 */
const NOMBRE_DUPLICADO = new ConflictError("Ya existe un grupo de categorías con ese nombre");

export async function createCategoryGroup(name: string, actor: ActorContext) {
  const existing = await prisma.categoryGroup.findFirst({ where: { name, deletedAt: null } });
  if (existing) throw new ValidationError("Ya existe un grupo de categorías con ese nombre");

  return withTranslatedPrismaErrors(
    () =>
      withAudit(
        (tx) => tx.categoryGroup.create({ data: { name } }),
        (group) => ({ userId: actor.userId, action: "CATEGORY_GROUP_CREATED", entityType: "CategoryGroup", entityId: group.id, ipAddress: actor.ipAddress, after: group })
      ),
    { "CategoryGroup.name": NOMBRE_DUPLICADO }
  );
}

export async function updateCategoryGroup(id: string, name: string, actor: ActorContext) {
  const before = await prisma.categoryGroup.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw new NotFoundError("Grupo de categorías");

  const duplicate = await prisma.categoryGroup.findFirst({ where: { name, deletedAt: null, id: { not: id } } });
  if (duplicate) throw new ValidationError("Ya existe otro grupo de categorías con ese nombre");

  return withTranslatedPrismaErrors(
    () =>
      withAudit(
        (tx) => tx.categoryGroup.update({ where: { id }, data: { name } }),
        (group) => ({ userId: actor.userId, action: "CATEGORY_GROUP_UPDATED", entityType: "CategoryGroup", entityId: id, ipAddress: actor.ipAddress, before, after: group })
      ),
    { "CategoryGroup.name": new ConflictError("Ya existe otro grupo de categorías con ese nombre") }
  );
}

/**
 * Eliminación lógica. Las categorías que pertenecían al grupo NO se
 * eliminan ni quedan huérfanas de forma inválida — simplemente su
 * `categoryGroupId` queda apuntando a un grupo ya inactivo; se
 * desvinculan explícitamente para mantener la lista de grupos "limpia".
 */
export async function deleteCategoryGroup(id: string, actor: ActorContext) {
  const before = await prisma.categoryGroup.findFirst({ where: { id, deletedAt: null } });
  if (!before) throw new NotFoundError("Grupo de categorías");

  await withAudit(
    async (tx) => {
      await tx.category.updateMany({ where: { categoryGroupId: id }, data: { categoryGroupId: null } });
      return tx.categoryGroup.update({ where: { id }, data: { deletedAt: new Date() } });
    },
    () => ({ userId: actor.userId, action: "CATEGORY_GROUP_DELETED", entityType: "CategoryGroup", entityId: id, ipAddress: actor.ipAddress, before })
  );
}
