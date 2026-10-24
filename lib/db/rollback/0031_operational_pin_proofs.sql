BEGIN;
DO $preserve_pin_records$ BEGIN
 IF EXISTS(SELECT 1 FROM petro_private.worker_pin_proofs) OR EXISTS(SELECT 1 FROM petro_private.worker_pin_commands) THEN
 RAISE EXCEPTION '0031 rollback refuses to delete operational proof records'; END IF;
END $preserve_pin_records$;
DROP FUNCTION public.petro_worker_verify_pair(uuid,text,text,text,text);
DROP FUNCTION public.petro_worker_pin_proof(uuid);
DROP FUNCTION public.petro_worker_credential_context(uuid,text,text);
DROP FUNCTION petro_private.worker_pin_proof_valid(uuid,uuid,uuid,text);
DROP TABLE petro_private.worker_pin_commands,petro_private.worker_pin_proofs;
COMMIT;
