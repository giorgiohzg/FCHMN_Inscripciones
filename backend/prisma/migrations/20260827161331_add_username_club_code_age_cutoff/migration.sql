/*
  Warnings:

  - You are about to drop the column `email` on the `users` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[username]` on the table `clubs` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[username]` on the table `persons` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[username]` on the table `users` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `code` to the `clubs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `username` to the `clubs` table without a default value. This is not possible if the table is not empty.
  - Added the required column `username` to the `persons` table without a default value. This is not possible if the table is not empty.
  - Added the required column `username` to the `users` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "users_email_key";

-- AlterTable
ALTER TABLE "clubs" ADD COLUMN     "code" TEXT NOT NULL,
ADD COLUMN     "username" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "competitions" ADD COLUMN     "age_cutoff_date" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "persons" ADD COLUMN     "username" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "email",
ADD COLUMN     "username" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "clubs_username_key" ON "clubs"("username");

-- CreateIndex
CREATE UNIQUE INDEX "persons_username_key" ON "persons"("username");

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
