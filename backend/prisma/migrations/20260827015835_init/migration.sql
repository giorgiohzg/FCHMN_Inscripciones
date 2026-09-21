-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'locked', 'disabled');

-- CreateEnum
CREATE TYPE "OwnerType" AS ENUM ('person', 'club');

-- CreateEnum
CREATE TYPE "PersonRoleType" AS ENUM ('swimmer', 'delegate', 'coach');

-- CreateEnum
CREATE TYPE "PersonGender" AS ENUM ('male', 'female');

-- CreateEnum
CREATE TYPE "ClubSwimmerStatus" AS ENUM ('pending', 'active', 'rejected', 'ended');

-- CreateEnum
CREATE TYPE "EventGender" AS ENUM ('male', 'female', 'mixed');

-- CreateEnum
CREATE TYPE "CompetitionStatus" AS ENUM ('draft', 'scheduled', 'open', 'closed', 'in_progress', 'finished', 'cancelled');

-- CreateEnum
CREATE TYPE "CompetitionEventStatus" AS ENUM ('enabled', 'disabled');

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('confirmed', 'cancelled');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "owner_type" "OwnerType" NOT NULL,
    "person_id" TEXT,
    "club_id" TEXT,
    "last_login_at" TIMESTAMP(3),
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "replaced_by" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "ip_address" TEXT,
    "before" JSONB,
    "after" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "persons" (
    "id" TEXT NOT NULL,
    "run" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "birth_date" TIMESTAMP(3) NOT NULL,
    "gender" "PersonGender" NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_roles" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "role_type" "PersonRoleType" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "person_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clubs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "has_legal_status" BOOLEAN NOT NULL DEFAULT false,
    "rut" TEXT,
    "legal_name" TEXT,
    "email" TEXT NOT NULL,
    "delegate_person_id" TEXT,
    "coach_person_id" TEXT,
    "is_achmn_member" BOOLEAN NOT NULL DEFAULT false,
    "is_fchmn_member" BOOLEAN NOT NULL DEFAULT false,
    "is_fchmn_collaborator" BOOLEAN NOT NULL DEFAULT false,
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "clubs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "club_swimmers" (
    "id" TEXT NOT NULL,
    "club_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "status" "ClubSwimmerStatus" NOT NULL DEFAULT 'pending',
    "requested_by_user_id" TEXT NOT NULL,
    "reviewed_by_user_id" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "club_swimmers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "test_types" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "swimmers_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "test_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "distances" (
    "id" TEXT NOT NULL,
    "meters" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "distances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strokes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strokes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" TEXT NOT NULL,
    "test_type_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "min_age" INTEGER NOT NULL,
    "max_age" INTEGER NOT NULL,
    "cutoff_date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" TEXT NOT NULL,
    "test_type_id" TEXT NOT NULL,
    "distance_id" TEXT NOT NULL,
    "stroke_id" TEXT NOT NULL,
    "gender" "EventGender" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_categories" (
    "event_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,

    CONSTRAINT "event_categories_pkey" PRIMARY KEY ("event_id","category_id")
);

-- CreateTable
CREATE TABLE "competitions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "CompetitionStatus" NOT NULL DEFAULT 'draft',
    "registration_start_at" TIMESTAMP(3) NOT NULL,
    "registration_end_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,

    CONSTRAINT "competitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_dates" (
    "id" TEXT NOT NULL,
    "competition_id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competition_dates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_types" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_sessions" (
    "id" TEXT NOT NULL,
    "competition_date_id" TEXT NOT NULL,
    "session_type_id" TEXT NOT NULL,

    CONSTRAINT "competition_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_limits" (
    "id" TEXT NOT NULL,
    "competition_session_id" TEXT NOT NULL,
    "max_individual_events" INTEGER,
    "max_relay_events" INTEGER,

    CONSTRAINT "session_limits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_events" (
    "id" TEXT NOT NULL,
    "competition_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "competition_session_id" TEXT NOT NULL,
    "status" "CompetitionEventStatus" NOT NULL DEFAULT 'enabled',
    "display_order" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "competition_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "competition_event_categories" (
    "competition_event_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,

    CONSTRAINT "competition_event_categories_pkey" PRIMARY KEY ("competition_event_id","category_id")
);

-- CreateTable
CREATE TABLE "registrations" (
    "id" TEXT NOT NULL,
    "competition_event_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "club_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'confirmed',
    "registered_by_user_id" TEXT NOT NULL,
    "cancelled_by_user_id" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "is_post_close_exception" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relay_registrations" (
    "id" TEXT NOT NULL,
    "competition_event_id" TEXT NOT NULL,
    "club_id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'confirmed',
    "registered_by_user_id" TEXT NOT NULL,
    "cancelled_by_user_id" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "is_post_close_exception" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "relay_registrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relay_registration_members" (
    "id" TEXT NOT NULL,
    "relay_registration_id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "order_position" INTEGER NOT NULL,

    CONSTRAINT "relay_registration_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_person_id_key" ON "users"("person_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_club_id_key" ON "users"("club_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "persons_run_key" ON "persons"("run");

-- CreateIndex
CREATE INDEX "persons_status_idx" ON "persons"("status");

-- CreateIndex
CREATE UNIQUE INDEX "person_roles_person_id_role_type_key" ON "person_roles"("person_id", "role_type");

-- CreateIndex
CREATE INDEX "clubs_status_idx" ON "clubs"("status");

-- CreateIndex
CREATE INDEX "club_swimmers_club_id_idx" ON "club_swimmers"("club_id");

-- CreateIndex
CREATE INDEX "club_swimmers_person_id_idx" ON "club_swimmers"("person_id");

-- CreateIndex
CREATE INDEX "club_swimmers_status_idx" ON "club_swimmers"("status");

-- CreateIndex
CREATE UNIQUE INDEX "test_types_name_key" ON "test_types"("name");

-- CreateIndex
CREATE UNIQUE INDEX "distances_meters_key" ON "distances"("meters");

-- CreateIndex
CREATE UNIQUE INDEX "strokes_name_key" ON "strokes"("name");

-- CreateIndex
CREATE UNIQUE INDEX "categories_test_type_id_name_key" ON "categories"("test_type_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "events_test_type_id_distance_id_stroke_id_gender_key" ON "events"("test_type_id", "distance_id", "stroke_id", "gender");

-- CreateIndex
CREATE UNIQUE INDEX "competition_dates_competition_id_date_key" ON "competition_dates"("competition_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "session_types_name_key" ON "session_types"("name");

-- CreateIndex
CREATE UNIQUE INDEX "competition_sessions_competition_date_id_session_type_id_key" ON "competition_sessions"("competition_date_id", "session_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_limits_competition_session_id_key" ON "session_limits"("competition_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "competition_events_competition_id_event_id_competition_sess_key" ON "competition_events"("competition_id", "event_id", "competition_session_id");

-- CreateIndex
CREATE INDEX "registrations_competition_event_id_idx" ON "registrations"("competition_event_id");

-- CreateIndex
CREATE INDEX "registrations_person_id_idx" ON "registrations"("person_id");

-- CreateIndex
CREATE INDEX "registrations_club_id_idx" ON "registrations"("club_id");

-- CreateIndex
CREATE INDEX "relay_registrations_competition_event_id_idx" ON "relay_registrations"("competition_event_id");

-- CreateIndex
CREATE INDEX "relay_registrations_club_id_idx" ON "relay_registrations"("club_id");

-- CreateIndex
CREATE UNIQUE INDEX "relay_registration_members_relay_registration_id_person_id_key" ON "relay_registration_members"("relay_registration_id", "person_id");

-- CreateIndex
CREATE UNIQUE INDEX "relay_registration_members_relay_registration_id_order_posi_key" ON "relay_registration_members"("relay_registration_id", "order_position");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "clubs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "person_roles" ADD CONSTRAINT "person_roles_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_delegate_person_id_fkey" FOREIGN KEY ("delegate_person_id") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_coach_person_id_fkey" FOREIGN KEY ("coach_person_id") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_swimmers" ADD CONSTRAINT "club_swimmers_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "club_swimmers" ADD CONSTRAINT "club_swimmers_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_test_type_id_fkey" FOREIGN KEY ("test_type_id") REFERENCES "test_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_test_type_id_fkey" FOREIGN KEY ("test_type_id") REFERENCES "test_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_distance_id_fkey" FOREIGN KEY ("distance_id") REFERENCES "distances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_stroke_id_fkey" FOREIGN KEY ("stroke_id") REFERENCES "strokes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_categories" ADD CONSTRAINT "event_categories_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_categories" ADD CONSTRAINT "event_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_dates" ADD CONSTRAINT "competition_dates_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_sessions" ADD CONSTRAINT "competition_sessions_competition_date_id_fkey" FOREIGN KEY ("competition_date_id") REFERENCES "competition_dates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_sessions" ADD CONSTRAINT "competition_sessions_session_type_id_fkey" FOREIGN KEY ("session_type_id") REFERENCES "session_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_limits" ADD CONSTRAINT "session_limits_competition_session_id_fkey" FOREIGN KEY ("competition_session_id") REFERENCES "competition_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_events" ADD CONSTRAINT "competition_events_competition_id_fkey" FOREIGN KEY ("competition_id") REFERENCES "competitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_events" ADD CONSTRAINT "competition_events_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_events" ADD CONSTRAINT "competition_events_competition_session_id_fkey" FOREIGN KEY ("competition_session_id") REFERENCES "competition_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_event_categories" ADD CONSTRAINT "competition_event_categories_competition_event_id_fkey" FOREIGN KEY ("competition_event_id") REFERENCES "competition_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "competition_event_categories" ADD CONSTRAINT "competition_event_categories_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_competition_event_id_fkey" FOREIGN KEY ("competition_event_id") REFERENCES "competition_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relay_registrations" ADD CONSTRAINT "relay_registrations_competition_event_id_fkey" FOREIGN KEY ("competition_event_id") REFERENCES "competition_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relay_registrations" ADD CONSTRAINT "relay_registrations_club_id_fkey" FOREIGN KEY ("club_id") REFERENCES "clubs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relay_registrations" ADD CONSTRAINT "relay_registrations_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relay_registration_members" ADD CONSTRAINT "relay_registration_members_relay_registration_id_fkey" FOREIGN KEY ("relay_registration_id") REFERENCES "relay_registrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relay_registration_members" ADD CONSTRAINT "relay_registration_members_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
