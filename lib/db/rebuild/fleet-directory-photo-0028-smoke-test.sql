-- Runs only inside the disposable PostgreSQL cluster after the browser fixture.
BEGIN;
CREATE TEMP TABLE directory_photo_fixture ON COMMIT DROP AS
SELECT vehicle.id AS vehicle_id,vehicle.created_by AS actor_id,photo.id AS photo_id
FROM public.petro_fleet_vehicles vehicle
JOIN public.petro_documents photo ON photo.vehicle_id=vehicle.id
WHERE vehicle.plate_original='TEST-UI-VEHICLE-01' AND photo.document_type='vehicle_photo'
  AND photo.uploaded_at IS NOT NULL;
DO $fixture$ BEGIN
  IF (SELECT count(*) FROM pg_temp.directory_photo_fixture)<>1 THEN
    RAISE EXCEPTION 'Expected exactly one uploaded isolated vehicle photo';
  END IF;
END $fixture$;
GRANT SELECT ON pg_temp.directory_photo_fixture TO authenticated;

-- A review rejection must remove an uploaded image from directory previews.
UPDATE public.petro_documents SET status='rejected'
WHERE id=(SELECT photo_id FROM pg_temp.directory_photo_fixture);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',(SELECT actor_id::text FROM pg_temp.directory_photo_fixture),true);
DO $rejected_photo$
DECLARE item jsonb;
BEGIN
  SELECT value INTO item FROM jsonb_array_elements(public.petro_admin_fleet_catalog(
    'vehicles',jsonb_build_object('query','TEST-UI-VEHICLE-01'))->'items') AS entries(value)
  WHERE value->>'id'=(SELECT vehicle_id::text FROM pg_temp.directory_photo_fixture);
  IF item IS NULL OR item->'photoDocumentId' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'Rejected photo remains visible in directory';
  END IF;
END $rejected_photo$;
RESET ROLE;

-- An unfinished upload must never masquerade as a stored photo.
UPDATE public.petro_documents SET status='pending_upload',uploaded_at=NULL
WHERE id=(SELECT photo_id FROM pg_temp.directory_photo_fixture);
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub',(SELECT actor_id::text FROM pg_temp.directory_photo_fixture),true);
DO $unfinished_photo$
DECLARE item jsonb;
BEGIN
  SELECT value INTO item FROM jsonb_array_elements(public.petro_admin_fleet_catalog(
    'vehicles',jsonb_build_object('query','TEST-UI-VEHICLE-01'))->'items') AS entries(value)
  WHERE value->>'id'=(SELECT vehicle_id::text FROM pg_temp.directory_photo_fixture);
  IF item IS NULL OR item->'photoDocumentId' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'Unfinished upload remains visible in directory';
  END IF;
END $unfinished_photo$;
RESET ROLE;
ROLLBACK;
