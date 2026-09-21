import { prisma } from "../../shared/prisma.client";
import { withAudit } from "../audit/audit.service";
import { ValidationError, NotFoundError } from "../../shared/errors";
import type { CategoryCreateInput, CategoryUpdateInput, CategoryListQuery } from "./catalogs.schemas";

interface ActorContext {
  userId: string;
  ipAddress?: string;
}

const categoryInclude = {
  testType: { select: { id: true, name: true } },
  categoryGroup: { select: { id: true, name: true } },
} as const;

async function assertTestTypeExists(testTypeId: string) {
  const testType = await prisma.testType.findUnique({ where: { id: testTypeId } });
  if (!testType) throw new ValidationError("El tipo de prueba seleccionado no existe");
  return testType;
}

async function assertCategoryGroupExists(categoryGroupId: string | null | undefined) {
  if (!categoryGroupId) return;
  const group = await prisma.categoryGroup.findFirst({ where: { id: categoryGroupId, deletedAt: null } });
  if (!group) throw new ValidationError("El grupo de categorías seleccionado no existe");
}

export async function listCategories(query: CategoryListQuery) {
  const where: any = { deletedAt: null };
  if (query.testTypeId) where.testTypeId = query.testTypeId;
  if (query.categoryGroupId) where.categoryGroupId = query.categoryGroupId;

  const [items, total] = await Promise.all([
    prisma.category.findMany({
      where,
      include: categoryInclude,
      // Tipo de prueba y edad mínima pueden coincidir entre categorías.
      orderBy: [{ testTypeId: "asc" }, { minAge: "asc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
    prisma.category.count({ where }),
  ]);

  return { items, total, page: query.page, pageSize: query.pageSize };
}

export async function getCategoryById(id: string) {
  const category = await prisma.category.findFirst({ where: { id, deletedAt: null }, include: categoryInclude });
  if (!category) throw new NotFoundError("Categoría");
  return category;
}

export async function createCategory(input: CategoryCreateInput, actor: ActorContext) {
  await assertTestTypeExists(input.testTypeId);
  await assertCategoryGroupExists(input.categoryGroupId);

  const duplicate = await prisma.category.findFirst({
    where: { testTypeId: input.testTypeId, name: input.name, deletedAt: null },
  });
  if (duplicate) throw new ValidationError("Ya existe una categoría con ese nombre para este tipo de prueba");

  return withAudit(
    (tx) =>
      tx.category.create({
        data: {
          testTypeId: input.testTypeId,
          categoryGroupId: input.categoryGroupId || null,
          name: input.name,
          minAge: input.minAge,
          maxAge: input.maxAge,
          createdBy: actor.userId,
          updatedBy: actor.userId,
        },
        include: categoryInclude,
      }),
    (category) => ({ userId: actor.userId, action: "CATEGORY_CREATED", entityType: "Category", entityId: category.id, ipAddress: actor.ipAddress, after: category })
  );
}

/**
 * A-08: modificar una categoría (ej. su rango de edad) NO revalida
 * retroactivamente las inscripciones ya confirmadas bajo esa categoría —
 * solo aplica a nuevas inscripciones a partir de este momento. El cambio
 * queda auditado igualmente.
 */
export async function updateCategory(id: string, input: CategoryUpdateInput, actor: ActorContext) {
  const before = await getCategoryById(id);
  if (input.testTypeId) await assertTestTypeExists(input.testTypeId);
  if (input.categoryGroupId !== undefined) await assertCategoryGroupExists(input.categoryGroupId);

  // Hallazgo 12: el rango se valida sobre los valores COMBINADOS. El esquema
  // Zod solo puede comparar cuando ambas edades vienen en la misma
  // solicitud; enviar únicamente `minAge: 40` sobre una categoría cuyo
  // `maxAge` guardado es 34 pasaba sin objeción y dejaba un rango imposible
  // que jamás resolvería una categoría para ningún nadador.
  const effectiveMinAge = input.minAge ?? before.minAge;
  const effectiveMaxAge = input.maxAge ?? before.maxAge;
  if (effectiveMaxAge < effectiveMinAge) {
    throw new ValidationError(
      `La edad máxima debe ser mayor o igual a la mínima. Con este cambio quedarían: mínima ${effectiveMinAge} y máxima ${effectiveMaxAge}.`
    );
  }

  return withAudit(
    (tx) =>
      tx.category.update({
        where: { id },
        data: {
          testTypeId: input.testTypeId ?? undefined,
          categoryGroupId: input.categoryGroupId !== undefined ? input.categoryGroupId || null : undefined,
          name: input.name ?? undefined,
          minAge: input.minAge ?? undefined,
          maxAge: input.maxAge ?? undefined,
          updatedBy: actor.userId,
        },
        include: categoryInclude,
      }),
    (category) => ({ userId: actor.userId, action: "CATEGORY_UPDATED", entityType: "Category", entityId: id, ipAddress: actor.ipAddress, before, after: category })
  );
}

export async function softDeleteCategory(id: string, actor: ActorContext) {
  const before = await getCategoryById(id);
  const category = await withAudit(
    (tx) => tx.category.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: actor.userId } }),
    (category) => ({ userId: actor.userId, action: "CATEGORY_DELETED", entityType: "Category", entityId: id, ipAddress: actor.ipAddress, before, after: category })
  );
  return category;
}
