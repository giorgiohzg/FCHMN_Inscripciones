/*
  Warnings:

  - You are about to drop the column `seed_time_seconds` on the `relay_registrations` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "relay_registrations" DROP COLUMN "seed_time_seconds",
ADD COLUMN     "seed_time_centiseconds" INTEGER;
