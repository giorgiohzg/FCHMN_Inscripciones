-- AlterTable
ALTER TABLE "categories" ADD COLUMN     "category_group_id" TEXT;

-- AlterTable
ALTER TABLE "competitions" ADD COLUMN     "max_individual_events_per_swimmer" INTEGER;

-- AlterTable
ALTER TABLE "registrations" ADD COLUMN     "seed_time_seconds" INTEGER;

-- CreateTable
CREATE TABLE "category_groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "category_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "category_groups_name_key" ON "category_groups"("name");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_category_group_id_fkey" FOREIGN KEY ("category_group_id") REFERENCES "category_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
