BEGIN;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM petro_private.merchant_payout_proof_intents) OR EXISTS(SELECT 1 FROM petro_private.merchant_payout_proof_acceptances) OR EXISTS(SELECT 1 FROM petro_private.merchant_payout_proof_commands) THEN RAISE EXCEPTION '0044 rollback refuses to remove bank proof history';END IF;END $$;
DROP POLICY petro_merchant_payout_proof_read ON storage.objects;
DROP POLICY petro_merchant_payout_proof_upload ON storage.objects;
DROP FUNCTION public.petro_merchant_payout_proof_file(uuid,text),public.petro_merchant_payout_proofs(uuid),public.petro_create_merchant_payout_proof(uuid,bigint,text,text,bigint,text),public.petro_accept_merchant_payout_proof(uuid,text,text);
DROP FUNCTION petro_private.can_access_merchant_payout_proof(text,text),petro_private.merchant_payout_proof_current(uuid,bigint),petro_private.merchant_payout_proof_version_current(uuid,bigint);
DROP TABLE petro_private.merchant_payout_proof_commands,petro_private.merchant_payout_proof_acceptances,petro_private.merchant_payout_proof_intents;
COMMIT;
