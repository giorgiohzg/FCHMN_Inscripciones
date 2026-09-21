/*
  Warnings:

  - You are about to drop the column `coach_person_id` on the `clubs` table. All the data in the column will be lost.
  - You are about to drop the column `delegate_person_id` on the `clubs` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "ClubStaffRole" AS ENUM ('delegate', 'coach', 'legal_representative');

-- DropForeignKey
ALTER TABLE "clubs" DROP CONSTRAINT "clubs_coach_person_id_fkey";

-- DropForeignKey
ALTER TABLE "clubs" DROP CONSTRAINT "clubs_delegate_person_id_fkey";

-- AlterTable
ALTER TABLE "clubs" DROP COLUMN "coach_person_id",
DROP COLUMN "delegate_person_id",
ADD COLUMN     "is_achmn_collaborator" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "persons" ALTER COLUMN "email" DROP NOT NULL;

-- CreateTable
CREATE TABLE "club_staff" (
    "id" TEXT NOT NULL,
    "club_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "role_type" "ClubStaffRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_staff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "club_staff_club_id_person_id_role_type_key" ON "club_staff"("club_id", "person_id", "role_type");

-- AddForeignKey
ALTER TABLE "club_staff" ADD CONSTRAINT "club_staff_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "clubs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_staff" ADD CONSTRAINT "club_staff_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
