BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE petro_private.merchant_payout_proof_intents(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),withdrawal_id uuid NOT NULL REFERENCES petro_private.merchant_withdrawals(id) ON DELETE RESTRICT,
 withdrawal_version bigint NOT NULL CHECK(withdrawal_version>0),bank_version_id uuid NOT NULL REFERENCES public.petro_bank_account_versions(id) ON DELETE RESTRICT,
 uploader_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,file_name text NOT NULL CHECK(char_length(file_name) BETWEEN 1 AND 160),
 content_type text NOT NULL CHECK(content_type IN('application/pdf','image/png','image/jpeg')),byte_size bigint NOT NULL CHECK(byte_size BETWEEN 1 AND 10485760),
 object_path text NOT NULL UNIQUE,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '20 minutes'
);
CREATE INDEX merchant_payout_proof_request ON petro_private.merchant_payout_proof_intents(withdrawal_id,created_at DESC,id);
CREATE TABLE petro_private.merchant_payout_proof_acceptances(
 proof_id uuid PRIMARY KEY REFERENCES petro_private.merchant_payout_proof_intents(id) ON DELETE RESTRICT,
 storage_object_id uuid NOT NULL UNIQUE,storage_etag text,sha256 text NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
 accepted_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,accepted_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE petro_private.merchant_payout_proof_commands(
 actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,request_key text NOT NULL CHECK(char_length(request_key) BETWEEN 16 AND 120),
 fingerprint text NOT NULL CHECK(fingerprint~'^[0-9a-f]{64}$'),proof_id uuid NOT NULL REFERENCES petro_private.merchant_payout_proof_intents(id) ON DELETE RESTRICT,
 PRIMARY KEY(actor_id,request_key));
DO $$ DECLARE t text;BEGIN FOREACH t IN ARRAY ARRAY['merchant_payout_proof_intents','merchant_payout_proof_acceptances','merchant_payout_proof_commands'] LOOP
 EXECUTE format('ALTER TABLE petro_private.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON petro_private.%I FROM PUBLIC,anon,authenticated,service_role',t);
 EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON petro_private.%I FOR EACH ROW EXECUTE FUNCTION petro_private.guard_service_payment_history()',t||'_immutable',t);
END LOOP;END $$;
CREATE FUNCTION petro_private.merchant_payout_proof_version_current(p_withdrawal uuid,p_version bigint) RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM petro_private.merchant_withdrawals w
 JOIN public.petro_bank_account_versions b ON b.id=w.bank_version_id
 JOIN public.petro_bank_accounts a ON a.id=b.bank_account_id AND a.organization_id=w.organization_id
 CROSS JOIN LATERAL(SELECT * FROM petro_private.merchant_withdrawal_events WHERE withdrawal_id=w.id ORDER BY version DESC LIMIT 1)e
 WHERE w.id=p_withdrawal AND e.version=p_version AND e.state='approved' AND e.remaining_minor>0 AND b.status='approved' AND a.status='active'
 AND a.version=(w.bank_snapshot->>'accountRevision')::bigint)
$$;
REVOKE ALL ON FUNCTION petro_private.merchant_payout_proof_version_current(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION petro_private.merchant_payout_proof_current(p_withdrawal uuid,p_version bigint) RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT coalesce(petro_private.workforce_user_active(auth.uid()),false) AND petro_private.platform_has(ARRAY['owner','finance']::text[]) AND petro_private.merchant_payout_proof_version_current(p_withdrawal,p_version)
$$;
REVOKE ALL ON FUNCTION petro_private.merchant_payout_proof_current(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION petro_private.can_access_merchant_payout_proof(p_path text,p_action text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM petro_private.merchant_payout_proof_intents i JOIN petro_private.merchant_withdrawals w ON w.id=i.withdrawal_id
 LEFT JOIN petro_private.merchant_payout_proof_acceptances a ON a.proof_id=i.id
 WHERE i.object_path=p_path AND(
 (p_action='upload' AND a.proof_id IS NULL AND i.uploader_id=auth.uid() AND i.expires_at>clock_timestamp()
 AND petro_private.merchant_payout_proof_current(i.withdrawal_id,i.withdrawal_version))
 OR(p_action='read' AND((a.proof_id IS NOT NULL AND petro_private.merchant_withdrawal_scope(w.organization_id,false))
 OR(a.proof_id IS NULL AND i.uploader_id=auth.uid() AND coalesce(petro_private.workforce_user_active(auth.uid()),false) AND petro_private.platform_has(ARRAY['owner','finance']::text[]))))))
$$;
REVOKE ALL ON FUNCTION petro_private.can_access_merchant_payout_proof(text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION petro_private.can_access_merchant_payout_proof(text,text) TO authenticated;
CREATE POLICY petro_merchant_payout_proof_read ON storage.objects FOR SELECT TO authenticated USING(bucket_id='petro-private-documents' AND petro_private.can_access_merchant_payout_proof(name,'read'));
CREATE POLICY petro_merchant_payout_proof_upload ON storage.objects FOR INSERT TO authenticated WITH CHECK(bucket_id='petro-private-documents' AND petro_private.can_access_merchant_payout_proof(name,'upload'));

CREATE FUNCTION public.petro_merchant_payout_proof_file(p_id uuid,p_action text DEFAULT 'read') RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE i petro_private.merchant_payout_proof_intents%ROWTYPE;a petro_private.merchant_payout_proof_acceptances%ROWTYPE;BEGIN
 SELECT * INTO i FROM petro_private.merchant_payout_proof_intents WHERE id=p_id;
 IF NOT FOUND OR p_action IS NULL OR p_action NOT IN('read','upload') OR NOT coalesce(petro_private.can_access_merchant_payout_proof(i.object_path,p_action),false) THEN RAISE EXCEPTION 'FORBIDDEN_PAYOUT_PROOF' USING ERRCODE='42501';END IF;
 SELECT * INTO a FROM petro_private.merchant_payout_proof_acceptances WHERE proof_id=i.id;
 RETURN jsonb_build_object('id',i.id,'withdrawalId',i.withdrawal_id,'withdrawalVersion',i.withdrawal_version,'bankVersionId',i.bank_version_id,
 'fileName',i.file_name,'contentType',i.content_type,'byteSize',i.byte_size,'bucket','petro-private-documents','objectPath',i.object_path,
 'status',CASE WHEN a.proof_id IS NULL THEN 'pending' ELSE 'accepted' END,'sha256',a.sha256,'acceptedAt',a.accepted_at,'current',a.proof_id IS NOT NULL AND petro_private.merchant_payout_proof_version_current(i.withdrawal_id,i.withdrawal_version));
END $$;
CREATE FUNCTION public.petro_merchant_payout_proofs(p_withdrawal_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE w petro_private.merchant_withdrawals%ROWTYPE;e petro_private.merchant_withdrawal_events%ROWTYPE;items jsonb;BEGIN
 SELECT * INTO w FROM petro_private.merchant_withdrawals WHERE id=p_withdrawal_id;
 IF NOT FOUND OR NOT coalesce(petro_private.merchant_withdrawal_scope(w.organization_id,false),false) THEN RAISE EXCEPTION 'FORBIDDEN_PAYOUT_PROOF' USING ERRCODE='42501';END IF;
 SELECT * INTO STRICT e FROM petro_private.merchant_withdrawal_events WHERE withdrawal_id=w.id ORDER BY version DESC LIMIT 1;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'withdrawalVersion',i.withdrawal_version,'fileName',i.file_name,'contentType',i.content_type,'byteSize',i.byte_size,
 'status',CASE WHEN a.proof_id IS NULL THEN 'pending' ELSE 'accepted' END,'acceptedAt',a.accepted_at,'createdAt',i.created_at,'uploaderName',p.display_name,
 'current',a.proof_id IS NOT NULL AND petro_private.merchant_payout_proof_version_current(i.withdrawal_id,i.withdrawal_version),'sha256',a.sha256) ORDER BY i.created_at DESC,i.id),'[]'::jsonb)
 INTO items FROM petro_private.merchant_payout_proof_intents i JOIN public.petro_profiles p ON p.user_id=i.uploader_id
 LEFT JOIN petro_private.merchant_payout_proof_acceptances a ON a.proof_id=i.id WHERE i.withdrawal_id=w.id AND(a.proof_id IS NOT NULL OR i.uploader_id=auth.uid() AND petro_private.platform_has(ARRAY['owner','finance']::text[]));
 RETURN jsonb_build_object('withdrawalId',w.id,'version',e.version,'canUpload',petro_private.merchant_payout_proof_current(w.id,e.version),'items',items,'bankPayoutEnabled',false);
END $$;
CREATE FUNCTION public.petro_create_merchant_payout_proof(p_withdrawal_id uuid,p_expected_version bigint,p_file_name text,p_content_type text,p_byte_size bigint,p_request_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=auth.uid();w petro_private.merchant_withdrawals%ROWTYPE;c petro_private.merchant_payout_proof_commands%ROWTYPE;fp text;id_value uuid:=gen_random_uuid();BEGIN
 IF NOT coalesce(petro_private.workforce_user_active(actor),false) OR NOT petro_private.platform_has(ARRAY['owner','finance']::text[]) THEN RAISE EXCEPTION 'FORBIDDEN_PAYOUT_PROOF' USING ERRCODE='42501';END IF;
 IF p_expected_version IS NULL OR p_expected_version<1 OR p_file_name IS NULL OR char_length(btrim(p_file_name)) NOT BETWEEN 1 AND 160
 OR p_content_type IS NULL OR p_content_type NOT IN('application/pdf','image/png','image/jpeg') OR p_byte_size IS NULL OR p_byte_size NOT BETWEEN 1 AND 10485760
 OR p_request_key IS NULL OR p_request_key!~'^[A-Za-z0-9._:-]{16,120}$' THEN RAISE EXCEPTION 'INVALID_PAYOUT_PROOF' USING ERRCODE='22023';END IF;
 fp:=encode(sha256(convert_to(jsonb_build_array('create',p_withdrawal_id,p_expected_version,p_file_name,p_content_type,p_byte_size)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('payout-proof:'||actor::text||':'||p_request_key,0));
 SELECT * INTO c FROM petro_private.merchant_payout_proof_commands WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN IF c.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';END IF;RETURN public.petro_merchant_payout_proof_file(c.proof_id,'read');END IF;
 SELECT * INTO w FROM petro_private.merchant_withdrawals WHERE id=p_withdrawal_id FOR UPDATE;
 IF NOT FOUND OR NOT coalesce(petro_private.merchant_payout_proof_current(w.id,p_expected_version),false) THEN RAISE EXCEPTION 'PAYOUT_PROOF_VERSION_CONFLICT' USING ERRCODE='PT409';END IF;
 IF(SELECT count(*) FROM petro_private.merchant_payout_proof_intents WHERE withdrawal_id=w.id)>=20 THEN RAISE EXCEPTION 'PAYOUT_PROOF_LIMIT' USING ERRCODE='23514';END IF;
 INSERT INTO petro_private.merchant_payout_proof_intents(id,withdrawal_id,withdrawal_version,bank_version_id,uploader_id,file_name,content_type,byte_size,object_path)
 VALUES(id_value,w.id,p_expected_version,w.bank_version_id,actor,p_file_name,p_content_type,p_byte_size,'merchant-payout-proof/'||w.id||'/'||id_value);
 INSERT INTO petro_private.merchant_payout_proof_commands VALUES(actor,p_request_key,fp,id_value);
 RETURN public.petro_merchant_payout_proof_file(id_value,'upload');
END $$;
CREATE FUNCTION public.petro_accept_merchant_payout_proof(p_id uuid,p_sha256 text,p_request_key text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE i petro_private.merchant_payout_proof_intents%ROWTYPE;c petro_private.merchant_payout_proof_commands%ROWTYPE;a petro_private.merchant_payout_proof_acceptances%ROWTYPE;obj storage.objects%ROWTYPE;fp text;actor uuid:=auth.uid();BEGIN
 SELECT * INTO i FROM petro_private.merchant_payout_proof_intents WHERE id=p_id;
 IF NOT FOUND OR i.uploader_id IS DISTINCT FROM actor OR NOT coalesce(petro_private.workforce_user_active(actor),false) OR NOT petro_private.platform_has(ARRAY['owner','finance']::text[]) THEN RAISE EXCEPTION 'FORBIDDEN_PAYOUT_PROOF' USING ERRCODE='42501';END IF;
 IF p_sha256 IS NULL OR p_sha256!~'^[0-9a-f]{64}$' OR p_request_key IS NULL OR p_request_key!~'^[A-Za-z0-9._:-]{16,120}$' THEN RAISE EXCEPTION 'INVALID_PAYOUT_PROOF' USING ERRCODE='22023';END IF;
 fp:=encode(sha256(convert_to(jsonb_build_array('accept',p_id,p_sha256)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended('payout-proof:'||actor::text||':'||p_request_key,0));
 SELECT * INTO c FROM petro_private.merchant_payout_proof_commands WHERE actor_id=actor AND request_key=p_request_key;
 IF FOUND THEN IF c.fingerprint<>fp THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE='23505';END IF;RETURN public.petro_merchant_payout_proof_file(p_id,'read');END IF;
 PERFORM 1 FROM petro_private.merchant_withdrawals WHERE id=i.withdrawal_id FOR UPDATE;
 PERFORM 1 FROM petro_private.merchant_payout_proof_intents WHERE id=i.id FOR UPDATE;
 SELECT * INTO a FROM petro_private.merchant_payout_proof_acceptances WHERE proof_id=i.id;
 IF FOUND THEN
 IF a.sha256<>p_sha256 THEN RAISE EXCEPTION 'PAYOUT_PROOF_CONTENT_CONFLICT' USING ERRCODE='PT409';END IF;
 RETURN public.petro_merchant_payout_proof_file(p_id,'read');END IF;
 IF NOT coalesce(petro_private.can_access_merchant_payout_proof(i.object_path,'upload'),false) THEN RAISE EXCEPTION 'PAYOUT_PROOF_VERSION_CONFLICT' USING ERRCODE='PT409';END IF;
 SELECT * INTO obj FROM storage.objects WHERE bucket_id='petro-private-documents' AND name=i.object_path;
 IF NOT FOUND OR obj.owner_id::text IS DISTINCT FROM actor::text OR coalesce(obj.metadata->>'size','')!~'^[0-9]+$'
 OR(obj.metadata->>'size')::numeric<>i.byte_size OR obj.metadata->>'mimetype' IS DISTINCT FROM i.content_type THEN RAISE EXCEPTION 'PAYOUT_PROOF_UPLOAD_UNVERIFIED' USING ERRCODE='23514';END IF;
 INSERT INTO petro_private.merchant_payout_proof_acceptances(proof_id,storage_object_id,storage_etag,sha256,accepted_by)
 VALUES(i.id,obj.id,obj.metadata->>'eTag',p_sha256,actor);
 INSERT INTO petro_private.merchant_payout_proof_commands VALUES(actor,p_request_key,fp,i.id);
 RETURN public.petro_merchant_payout_proof_file(i.id,'read');
END $$;
REVOKE ALL ON FUNCTION public.petro_merchant_payout_proof_file(uuid,text),public.petro_merchant_payout_proofs(uuid),public.petro_create_merchant_payout_proof(uuid,bigint,text,text,bigint,text),public.petro_accept_merchant_payout_proof(uuid,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.petro_merchant_payout_proof_file(uuid,text),public.petro_merchant_payout_proofs(uuid),public.petro_create_merchant_payout_proof(uuid,bigint,text,text,bigint,text),public.petro_accept_merchant_payout_proof(uuid,text,text) TO authenticated;
COMMIT;
