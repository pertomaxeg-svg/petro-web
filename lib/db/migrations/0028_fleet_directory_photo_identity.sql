BEGIN;

DO $fleet_directory_photos$
DECLARE
  definition text := pg_catalog.pg_get_functiondef('public.petro_admin_fleet_catalog(text,jsonb)'::regprocedure);
  vehicle_target text := $vehicle_target$'activeCredentialCount', f.active_credential_count, 'createdAt', f.created_at,$vehicle_target$;
  vehicle_replacement text := $vehicle_replacement$'activeCredentialCount', f.active_credential_count,
        'photoDocumentId', (SELECT photo.id FROM public.petro_documents photo
          WHERE photo.vehicle_id=f.id AND photo.document_type='vehicle_photo'
            AND photo.uploaded_at IS NOT NULL
            AND photo.status IN ('attached','pending_review','approved')
            AND photo.content_type IN ('image/png','image/jpeg')
          ORDER BY photo.uploaded_at DESC,photo.id DESC LIMIT 1), 'createdAt', f.created_at,$vehicle_replacement$;
  driver_target text := $driver_target$'version',f.version,'activeLinkCount',f.active_link_count,'createdAt',f.created_at,$driver_target$;
  driver_replacement text := $driver_replacement$'version',f.version,'activeLinkCount',f.active_link_count,
      'activeVehicles',coalesce((SELECT jsonb_agg(jsonb_build_object(
        'id',vehicle.id,'plate',vehicle.plate_original,'branchName',branch.name,
        'photoDocumentId',(SELECT photo.id FROM public.petro_documents photo
          WHERE photo.vehicle_id=vehicle.id AND photo.document_type='vehicle_photo'
            AND photo.uploaded_at IS NOT NULL
            AND photo.status IN ('attached','pending_review','approved')
            AND photo.content_type IN ('image/png','image/jpeg')
          ORDER BY photo.uploaded_at DESC,photo.id DESC LIMIT 1))
        ORDER BY vehicle.plate_normalized,vehicle.id)
        FROM public.petro_fleet_driver_links link
        JOIN public.petro_fleet_vehicles vehicle ON vehicle.id=link.vehicle_id
        JOIN public.petro_branches branch ON branch.id=vehicle.branch_id
        WHERE link.driver_id=f.id AND link.status='active'
          AND link.starts_at<=now() AND (link.ends_at IS NULL OR link.ends_at>now())),'[]'::jsonb),
      'createdAt',f.created_at,$driver_replacement$;
BEGIN
  IF md5(definition)<>'2d2df7243983c0f823eede60ae4b7d68'
    OR cardinality(string_to_array(definition,vehicle_target))<>2
    OR cardinality(string_to_array(definition,driver_target))<>2 THEN
    RAISE EXCEPTION '0028 fleet catalog differs from reviewed source';
  END IF;
  EXECUTE replace(replace(definition,vehicle_target,vehicle_replacement),driver_target,driver_replacement);
END
$fleet_directory_photos$;

COMMIT;
