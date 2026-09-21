/*
  Warnings:

  - You are about to drop the column `cutoff_date` on the `categories` table. All the data in the column will be lost.
  - You are about to drop the `event_categories` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "event_categories" DROP CONSTRAINT "event_categories_category_id_fkey";

-- DropForeignKey
ALTER TABLE "event_categories" DROP CONSTRAINT "event_categories_event_id_fkey";

-- AlterTable
ALTER TABLE "categories" DROP COLUMN "cutoff_date";

-- DropTable
DROP TABLE "event_categories";
