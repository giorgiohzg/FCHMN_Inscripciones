-- CreateEnum
CREATE TYPE "PoolCourseLength" AS ENUM ('short_25m', 'long_50m');

-- AlterTable
ALTER TABLE "competitions" ADD COLUMN     "pool_id" TEXT;

-- CreateTable
CREATE TABLE "pools" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "is_heated" BOOLEAN NOT NULL DEFAULT false,
    "is_covered" BOOLEAN NOT NULL DEFAULT false,
    "course_length" "PoolCourseLength" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "pools_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "competitions" ADD CONSTRAINT "competitions_pool_id_fkey" FOREIGN KEY ("pool_id") REFERENCES "pools"("id") ON DELETE SET NULL ON UPDATE CASCADE;
