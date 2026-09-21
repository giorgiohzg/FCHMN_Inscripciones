-- DropForeignKey
ALTER TABLE "registrations" DROP CONSTRAINT "registrations_competition_event_id_fkey";

-- DropForeignKey
ALTER TABLE "relay_registrations" DROP CONSTRAINT "relay_registrations_competition_event_id_fkey";

-- AddForeignKey
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_competition_event_id_fkey" FOREIGN KEY ("competition_event_id") REFERENCES "competition_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relay_registrations" ADD CONSTRAINT "relay_registrations_competition_event_id_fkey" FOREIGN KEY ("competition_event_id") REFERENCES "competition_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
