// Real Auth, PostgREST and Storage against disposable local Supabase only.
// No production keys or application authentication bypass are used.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";

const root = resolve(import.meta.dirname, "../../..");
const { Client } = createRequire(resolve(root, "lib/db/package.json"))("pg");
const { createClient } = createRequire(resolve(root, "artifacts/api-server/package.json"))("@supabase/supabase-js");
const config = JSON.parse(await readFile(process.env.PERTOMAX_LOCAL_STATUS_FILE, "utf8"));
const api = new URL(config.API_URL);
const database = new URL(config.DB_URL);
assert.equal(api.origin, "http://127.0.0.1:54321", "Refuse nonlocal Auth/Storage");
assert.equal(database.hostname, "127.0.0.1", "Refuse nonlocal database");
assert.equal(database.port, "54322");
assert.equal(database.pathname, "/postgres");
assert.ok(config.ANON_KEY && config.SERVICE_ROLE_KEY);
const db = new Client({ connectionString: config.DB_URL });
await db.connect();
const makeClient = (key) => createClient(api.origin, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
const admin = makeClient(config.SERVICE_ROLE_KEY);
const anon = makeClient(config.ANON_KEY);
const ok = (result, context) => {
  if (result.error) throw new Error(context + ": " + result.error.message);
  return result.data;
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTE0AAAAASUVORK5CYII=", "base64");

try {
  // Load project schema without replacing Supabase-managed Auth/Storage.
  const baseline = (await readFile(resolve(root, "lib/db/rebuild/current-schema.sql"), "utf8"))
    .replace(/^CREATE SCHEMA public;$/m, "");
  // Supabase owns its managed-role defaults. Preserve those installed defaults;
  // import only application-owned DDL and postgres defaults into this sandbox.
  // No application object in this suite is created as supabase_admin.
  const managedDefaults = baseline.split("\n").filter(line => line.startsWith("ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin "));
  assert.equal(managedDefaults.length, 12, "Reviewed managed default-ACL statements changed");
  await db.query(baseline.split("\n").filter(line => !line.startsWith("ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin ")).join("\n"));
  await db.query(await readFile(resolve(root, "lib/db/rebuild/local-auth-post-baseline.sql"), "utf8"));
  for (const file of (await readdir(resolve(root, "lib/db/migrations"))).sort()) {
    const number = Number(file.slice(0, 4));
    if (number < 3 || number === 9 || number > 38 || !file.endsWith(".sql")) continue;
    await db.query(await readFile(resolve(root, "lib/db/migrations", file), "utf8"));
  }
  await db.query("NOTIFY pgrst, 'reload schema'");
  await new Promise(resolve => setTimeout(resolve, 1000));

  async function confirmedAccount(username) {
    const email = username + "@example.com";
    const password = randomUUID() + "aA7!";
    const generated = ok(await admin.auth.admin.generateLink({
      type: "signup", email, password,
      options: { data: { username, display_name: "Isolated Auth Storage Test" } },
    }), "Generate isolated signup confirmation");
    assert.ok(generated.properties.hashed_token);
    const client = makeClient(config.ANON_KEY);
    const before = await client.auth.signInWithPassword({ email, password });
    assert.ok(before.error, "Unconfirmed email must not permit password sign-in");
    const verified = ok(await client.auth.verifyOtp({
      token_hash: generated.properties.hashed_token, type: "email",
    }), "Confirm isolated email token");
    assert.ok(verified.session && verified.user.email_confirmed_at);
    const profile = (await db.query("SELECT active,account_status FROM public.petro_profiles WHERE user_id=$1", [verified.user.id])).rows[0];
    assert.equal(profile.active, false, "Email confirmation must not activate the Pertomax account");
    assert.equal(profile.account_status, "pending");
    return { client, id: verified.user.id };
  }

  const owner = await confirmedAccount("isolated_storage_owner");
  const outsider = await confirmedAccount("isolated_storage_outsider");
  const pendingDenied = await owner.client.rpc("petro_admin_fleet_catalog", { p_view: "overview", p_filters: {} });
  assert.ok(pendingDenied.error, "Pending Auth account must not read the admin fleet");

  // Explicit synthetic owner fixture, only after the strict loopback guards.
  await db.query("UPDATE public.petro_profiles SET active=true,account_status='active' WHERE user_id=$1", [owner.id]);
  await db.query("INSERT INTO public.petro_platform_roles(user_id,role,active) VALUES($1,'owner',true)", [owner.id]);
  const org = randomUUID(), branch = randomUUID();
  await db.query("INSERT INTO public.petro_organizations(id,name,kind,code,status,approval_status,operational_status,created_by) VALUES($1,'Isolated Storage Company','company','REAL-STORAGE-CI','active','approved','active',$2)", [org, owner.id]);
  await db.query("INSERT INTO public.petro_branches(id,organization_id,name,code,status,approval_status,operational_status) VALUES($1,$2,'Isolated Storage Branch','REAL-STORAGE-B1','active','approved','active')", [branch, org]);
  const vehicle = ok(await owner.client.rpc("petro_admin_fleet_command", {
    p_action: "vehicle.create",
    p_payload: { organizationId: org, branchId: branch, plateOriginal: "REAL-STORAGE-CI", plateStandard: "REAL-STORAGE-CI", category: "test", vehicleType: "car", brand: "test", model: "test", fuelType: "petrol", tankCapacityLiters: 50 },
    p_reason: "Isolated real Auth Storage acceptance", p_idempotency_key: "real-storage-vehicle-0001",
  }), "Create vehicle using actual PostgREST authorization");

  for (const type of ["vehicle_photo", "odometer_evidence"]) {
    const intent = ok(await owner.client.rpc("petro_fleet_create_vehicle_document_upload", {
      p_vehicle_id: vehicle.id, p_document_type: type, p_file_name: type + ".png",
      p_content_type: "image/png", p_byte_size: png.length, p_expires_on: null,
    }), "Create protected document upload intent");
    const bucket = owner.client.storage.from(intent.bucket);
    ok(await bucket.upload(intent.objectPath, png, { contentType: "image/png", upsert: false }), "Upload protected PNG to real Storage");
    const retry = await bucket.upload(intent.objectPath, png, { contentType: "image/png", upsert: false });
    assert.ok(retry.error, "Retry must not silently overwrite the private object");
    const signed = ok(await bucket.createSignedUrl(intent.objectPath, 60), "Sign protected download");
    const downloaded = await fetch(signed.signedUrl);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
    const denied = await outsider.client.storage.from(intent.bucket).createSignedUrl(intent.objectPath, 60);
    assert.ok(denied.error, "Unprivileged confirmed account must not sign another user's file");
    const deniedUpload = await outsider.client.storage.from(intent.bucket).upload(intent.objectPath + "-other", png, { contentType: "image/png" });
    assert.ok(deniedUpload.error, "Unprivileged account must not upload without an authorized intent");
    const publicUrl = anon.storage.from(intent.bucket).getPublicUrl(intent.objectPath).data.publicUrl;
    assert.notEqual((await fetch(publicUrl)).status, 200, "Private file must not be public");
  }
  const staff=await confirmedAccount("isolated_operational_worker");
  await db.query("UPDATE public.petro_profiles SET active=true,account_status='active',password_change_required=false WHERE user_id=$1",[staff.id]);
  const station=randomUUID(),stationBranch=randomUUID(),membership=randomUUID();
  await db.query("INSERT INTO public.petro_organizations(id,name,kind,code,status,approval_status,operational_status,created_by) VALUES($1,'Isolated Worker Station','station','REAL-WORKER-ST','active','approved','active',$2)",[station,owner.id]);
  await db.query("INSERT INTO public.petro_branches(id,organization_id,name,code,status,approval_status,operational_status) VALUES($1,$2,'Isolated Worker Branch','REAL-WORKER-B1','active','approved','active')",[stationBranch,station]);
  await db.query("INSERT INTO public.petro_memberships(id,user_id,organization_id,role,scope,active) VALUES($1,$2,$3,'worker','branches',true)",[membership,staff.id,station]);
  await db.query("INSERT INTO public.petro_membership_branches(organization_id,membership_id,branch_id) VALUES($1,$2,$3)",[station,membership,stationBranch]);
  const assignmentArgs={p_user_id:staff.id,p_branch_id:stationBranch,p_service_group:"fuel",p_active:true,p_expected_version:0,p_request_key:"real-worker-assignment-create"};
  const assignment=ok(await owner.client.rpc("petro_admin_worker_assignment",assignmentArgs),"Assign actual confirmed worker");
  assert.deepEqual(ok(await owner.client.rpc("petro_admin_worker_assignment",assignmentArgs),"Replay worker assignment"),assignment);
  const capabilities=ok(await staff.client.rpc("petro_worker_capabilities"),"Read actual worker capabilities");
  assert.equal(capabilities.items.length,1);
  assert.equal(capabilities.items[0].assignmentId,assignment.id);
  assert.ok((await staff.client.rpc("petro_admin_worker_assignments",{p_filters:{}})).error,"Worker cannot read central assignments");
  assert.ok((await staff.client.from("petro_worker_assignments").select("*")).error,"Worker cannot bypass RPC authorization with direct table access");
  assert.ok((await staff.client.rpc("petro_admin_worker_assignment",{...assignmentArgs,p_service_group:"wash",p_request_key:"real-worker-self-assignment-denied"})).error,"Worker cannot assign themselves");

  const proofDriver=randomUUID(),proofLink=randomUUID(),proofSecret=randomUUID(),proofCredential=randomUUID();
  const credentialHash=randomBytes(32).toString("hex"),pinHmac=randomBytes(32).toString("hex");
  await db.query("INSERT INTO public.petro_fleet_drivers(id,organization_id,driver_code,full_name,created_by,updated_by) VALUES($1,$2,'REAL-OP-DRIVER','Isolated Operational Driver',$3,$3)",[proofDriver,org,owner.id]);
  await db.query("INSERT INTO public.petro_fleet_driver_links(id,organization_id,vehicle_id,driver_id,reason,created_by) VALUES($1,$2,$3,$4,'Isolated operational proof',$5)",[proofLink,org,vehicle.id,proofDriver,owner.id]);
  await db.query("INSERT INTO petro_private.petro_fleet_driver_pair_secrets(id,link_id,organization_id,vehicle_id,driver_id,pin_hmac,created_by) VALUES($1,$2,$3,$4,$5,decode($6,'hex'),$7)",[proofSecret,proofLink,org,vehicle.id,proofDriver,pinHmac,owner.id]);
  await db.query("INSERT INTO public.petro_vehicle_credentials(id,organization_id,branch_id,vehicle_id,credential_type,token_sha256,token_hint,status,activated_by,reason) VALUES($1,$2,$3,$4,'qr',$5,$6,'active',$7,'Isolated operational credential')",[proofCredential,org,branch,vehicle.id,credentialHash,credentialHash.slice(-6),owner.id]);
  const context=ok(await staff.client.rpc("petro_worker_credential_context",{p_branch_id:stationBranch,p_service_group:"fuel",p_credential_hash:credentialHash}),"Resolve actual worker credential scope");
  assert.equal(context.vehicleId,vehicle.id);
  assert.equal("plate" in context,false);
  const verifyArgs={p_branch_id:stationBranch,p_service_group:"fuel",p_credential_hash:credentialHash,p_pin_hmac:pinHmac,p_request_key:"real-worker-pair-verification-001"};
  const proof=ok(await staff.client.rpc("petro_worker_verify_pair",verifyArgs),"Verify actual worker PIN proof through PostgREST");
  assert.equal(proof.valid,true);
  assert.equal(ok(await staff.client.rpc("petro_worker_verify_pair",verifyArgs),"Replay actual worker PIN proof").verificationId,proof.verificationId);
  assert.equal(ok(await owner.client.rpc("petro_worker_pin_proof",{p_proof_id:proof.verificationId}),"Other actor cannot read proof").valid,false);
  assert.ok((await anon.rpc("petro_worker_pin_proof",{p_proof_id:proof.verificationId})).error,"Anonymous clients cannot read operational proofs");
  assert.ok((await staff.client.schema("petro_private").from("worker_pin_proofs").select("*")).error,"Private proofs cannot be read through Data API");


  const quoteFuel=randomUUID(),quotePrice=randomUUID();
  await db.query("UPDATE public.petro_fleet_vehicles SET fuel_type='real_quote_fuel',tank_capacity_liters=50 WHERE id=$1",[vehicle.id]);
  await db.query("INSERT INTO public.petro_fuel_types(id,code,name_ar,vehicle_fuel_family,unit_code,created_by,updated_by) VALUES($1,'real_quote_fuel','Isolated quote fuel','gasoline','litre',$2,$2)",[quoteFuel,owner.id]);
  await db.query("INSERT INTO public.petro_fuel_price_versions(id,fuel_type_id,version,price_per_unit,unit_code,valid_from,status,reason,created_by,published_at,published_by) VALUES($1,$2,1,12.5,'litre',now()-interval '1 second','published','Isolated actual Auth quotation',$3,now(),$3)",[quotePrice,quoteFuel,owner.id]);
  const choices=ok(await staff.client.rpc("petro_worker_service_options",{p_proof_id:proof.verificationId,p_search:null,p_page:1,p_page_size:20}),"Actual worker service choices");
  assert.equal(choices.total,1);
  assert.equal(choices.items[0].id,quoteFuel);
  const quotation=ok(await staff.client.rpc("petro_worker_quote_service",{p_proof_id:proof.verificationId,p_reference_id:quoteFuel,p_price_version_id:quotePrice,p_input:{amountMinor:"10000"},p_location_id:null}),"Actual worker exact EGP quote");
  assert.equal(quotation.amountMinor,"10000");
  assert.equal(Number(quotation.quantity),8);
  assert.equal(quotation.canReserve,false,"A quote cannot invent missing company coverage/funding");
  assert.ok((await owner.client.rpc("petro_worker_service_options",{p_proof_id:proof.verificationId,p_search:null,p_page:1,p_page_size:20})).error,"Another authenticated actor cannot use worker proof for pricing");
  assert.ok((await anon.rpc("petro_worker_service_options",{p_proof_id:proof.verificationId,p_search:null,p_page:1,p_page_size:20})).error,"Anonymous caller cannot list operational prices");


  // A committed native pg_cron run, in the disposable real Supabase only.
  // Reuse the reviewed covered/financed catalog fixture with the two real Auth
  // principals created above; never create or impersonate a scheduler Auth user.
  let nativeFixture=await readFile(resolve(root,"lib/db/rebuild/service-quotation-0033-api-fixture.sql"),"utf8");
  nativeFixture=nativeFixture
   .replace(/INSERT INTO auth\.users\(id,email,raw_user_meta_data,email_confirmed_at\)[\s\S]*?ON CONFLICT \(id\) DO NOTHING;/,"")
   .replace(/INSERT INTO auth\.users\(id,email,raw_user_meta_data,email_confirmed_at\) VALUES[\s\S]*?;\nUPDATE public\.petro_profiles/,"UPDATE public.petro_profiles")
   .replaceAll("00000000-0000-4000-8000-000000003301",owner.id)
   .replaceAll("00000000-0000-4000-8000-000000003302",staff.id);
  let nativeIds;
  try{
   await db.query(nativeFixture);
   nativeIds=(await db.query("SELECT ids FROM pg_temp.quote_test")).rows[0].ids;
   await db.query("COMMIT");
  }catch(error){await db.query("ROLLBACK");throw error;}
  await db.query("RESET ROLE");
  await db.query("RESET request.jwt.claim.sub");
  const nativeBranch=(await db.query("SELECT merchant_branch_id FROM petro_private.worker_pin_proofs WHERE id=$1",[nativeIds.fuelProof])).rows[0].merchant_branch_id;
  const nativeProof=async(service,requestKey)=>ok(await staff.client.rpc("petro_worker_verify_pair",{p_branch_id:nativeBranch,p_service_group:service,p_credential_hash:"e".repeat(64),p_pin_hmac:"a".repeat(64),p_request_key:requestKey}),"Actual Auth proof for native expiry");
  const fuelIdentity=await nativeProof("fuel","native-fuel-proof-0001");
  const fuelArgs={p_proof_id:fuelIdentity.verificationId,p_reference_id:nativeIds.fuel,p_price_version_id:nativeIds.price,p_input:{amountMinor:"10000"},p_location_id:null,p_request_key:"native-fuel-order-0001"};
  const fuelOrder=ok(await staff.client.rpc("petro_worker_reserve_service_order",fuelArgs),"Reserve actual Auth fuel order");
  assert.equal(fuelOrder.paymentStatus,"held");
  assert.equal(ok(await staff.client.rpc("petro_worker_reserve_service_order",fuelArgs),"Replay consumed proof reservation").id,fuelOrder.id);
  assert.ok((await outsider.client.rpc("petro_service_orders_query",{p_filters:{orderId:fuelOrder.id}})).error,"Outsider must not read an order");
  assert.ok((await staff.client.from("petro_service_orders").select("*")).error,"Direct order table access must be denied");
  assert.ok((await anon.rpc("petro_worker_reserve_service_order",fuelArgs)).error,"Anonymous reservation denied");
  const partIdentity=await nativeProof("parts","native-part-proof-0001");
  const partOrder=ok(await staff.client.rpc("petro_worker_reserve_service_order",{p_proof_id:partIdentity.verificationId,p_reference_id:nativeIds.part,p_price_version_id:nativeIds.partPrice,p_input:{quantity:"1"},p_location_id:nativeIds.location,p_request_key:"native-part-order-0001"}),"Reserve actual Auth product and stock");
  const heldStock=(await db.query("SELECT on_hand::text,reserved::text FROM public.petro_inventory_balances WHERE location_id=$1 AND item_id=$2",[nativeIds.location,nativeIds.part])).rows[0];
  assert.equal(Number(heldStock.on_hand),2);
  assert.equal(Number(heldStock.reserved),2);
  const batchStarted=(await db.query("SELECT clock_timestamp() AS at")).rows[0].at;
  const nativeJob=(await db.query("SELECT jobid,schedule,command,username,active FROM cron.job WHERE jobname='pertomax_service_order_expiry'")).rows[0];
  assert.ok(nativeJob?.active);
  assert.equal(nativeJob.username,"postgres");
  assert.equal(nativeJob.schedule,"* * * * *");
  assert.equal(nativeJob.command,"SELECT petro_private.petro_expire_service_orders(100);");
  try{
   // Only exact synthetic orders, committed so a DIFFERENT cron connection sees them.
   await db.query("UPDATE public.petro_service_orders SET created_at=clock_timestamp()-interval '20 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])",[[fuelOrder.id,partOrder.id]]);
   assert.equal(Number((await db.query("SELECT cron.schedule('pertomax_service_order_expiry','1 second',$1) AS id",[nativeJob.command])).rows[0].id),Number(nativeJob.jobid));
   let released=false;
   for(let i=0;i<30;i++){
    const rows=(await db.query("SELECT status,payment_status,cancelled_by,cancelled_by_system FROM public.petro_service_orders WHERE id=ANY($1::uuid[])",[[fuelOrder.id,partOrder.id]])).rows;
    if(rows.length===2&&rows.every(row=>row.status==="cancelled"&&row.payment_status==="unpaid"&&row.cancelled_by===null&&row.cancelled_by_system==="service_order_expiry")){released=true;break;}
    await new Promise(resolve=>setTimeout(resolve,500));
   }
   const runs=(await db.query("SELECT status,return_message FROM cron.job_run_details WHERE jobid=$1 AND start_time>=$2 ORDER BY runid DESC LIMIT 3",[nativeJob.jobid,batchStarted])).rows;
   assert.equal(released,true,"Native expiry did not release committed held orders: "+JSON.stringify(runs));
   assert.ok(runs.some(run=>run.status==="succeeded"),"Native scheduler must actually commit a successful run");
   const finalStock=(await db.query("SELECT on_hand::text,reserved::text FROM public.petro_inventory_balances WHERE location_id=$1 AND item_id=$2",[nativeIds.location,nativeIds.part])).rows[0];
   assert.equal(Number(finalStock.on_hand),2,"Expiry must never issue physical stock");
   assert.equal(Number(finalStock.reserved),1,"Expiry releases only its own one-unit hold");
   const marker=(await db.query("SELECT m.actor_id,m.system_actor,m.on_hand_delta::text,m.reserved_delta::text FROM public.petro_inventory_movements m JOIN public.petro_service_orders o ON o.inventory_reservation_id=m.reservation_id WHERE o.id=$1 AND m.movement_kind='release'",[partOrder.id])).rows;
   assert.equal(marker.length,1);
   assert.equal(marker[0].actor_id,null);
   assert.equal(marker[0].system_actor,"service_order_expiry");
   assert.equal(Number(marker[0].on_hand_delta),0);
   assert.equal(Number(marker[0].reserved_delta),-1);
   const closures=(await db.query("SELECT f.status,f.closed_by,f.closed_by_system FROM public.petro_finance_reservations f JOIN public.petro_fleet_usage_reservations u ON u.finance_reservation_id=f.id JOIN public.petro_service_orders o ON o.usage_reservation_id=u.id WHERE o.id=ANY($1::uuid[])",[[fuelOrder.id,partOrder.id]])).rows;
   assert.equal(closures.length,2);
   assert.ok(closures.every(row=>row.status==="released"&&row.closed_by===null&&row.closed_by_system==="service_order_expiry"));
   const timeline=ok(await staff.client.rpc("petro_service_orders_query",{p_filters:{orderId:partOrder.id}}),"Read actual system-attributed expiry timeline");
   assert.deepEqual(timeline.timeline.map(event=>event.kind),["reserved","cancelled"]);
   assert.equal(timeline.timeline[1].actorKind,"system");
   assert.equal(timeline.timeline[1].actorName,"النظام");
   const beforeCount=Number((await db.query("SELECT count(*) FROM public.petro_inventory_movements WHERE reservation_id=(SELECT inventory_reservation_id FROM public.petro_service_orders WHERE id=$1)",[partOrder.id])).rows[0].count);
   await new Promise(resolve=>setTimeout(resolve,1500));
   assert.equal(Number((await db.query("SELECT count(*) FROM public.petro_inventory_movements WHERE reservation_id=(SELECT inventory_reservation_id FROM public.petro_service_orders WHERE id=$1)",[partOrder.id])).rows[0].count),beforeCount,"Another scheduler run cannot release a hold twice");
   console.log("PASS: committed real-JWT fuel/product reservations expired through the actual native cron background connection, releasing exact money/stock once with truthful system attribution and unchanged physical stock.");
  }finally{
   await db.query("SELECT cron.schedule('pertomax_service_order_expiry',$1,$2)",[nativeJob.schedule,nativeJob.command]);
  }


  // Two concurrent real PostgREST transactions must never duplicate a proof hold
  // or oversell the single available product unit.
  const raceFuelIdentity=await nativeProof("fuel","native-fuel-proof-race-0001");
  const raceFuelArgs={...fuelArgs,p_proof_id:raceFuelIdentity.verificationId};
  const fuelRace=await Promise.all(["a","b"].map(suffix=>staff.client.rpc("petro_worker_reserve_service_order",{...raceFuelArgs,p_request_key:"native-fuel-race-order-"+suffix})));
  assert.equal(fuelRace.filter(r=>!r.error).length,1,"One proof must have exactly one concurrent winner");
  const fuelWinner=fuelRace.find(r=>!r.error).data;
  ok(await staff.client.rpc("petro_cancel_service_order",{p_order_id:fuelWinner.id,p_expected_version:fuelWinner.version,p_request_key:"native-fuel-race-cancel"}),"Cancel concurrent fuel winner");
  const partRaceProofs=await Promise.all(["a","b"].map(suffix=>nativeProof("parts","native-part-proof-race-"+suffix)));
  const partRace=await Promise.all(partRaceProofs.map((p,index)=>staff.client.rpc("petro_worker_reserve_service_order",{p_proof_id:p.verificationId,p_reference_id:nativeIds.part,p_price_version_id:nativeIds.partPrice,p_input:{quantity:"1"},p_location_id:nativeIds.location,p_request_key:"native-part-race-order-"+index})));
  assert.equal(partRace.filter(r=>!r.error).length,1,"Single available product unit must have exactly one concurrent winner");
  const partWinner=partRace.find(r=>!r.error).data;
  const raceStock=(await db.query("SELECT on_hand::text,reserved::text FROM public.petro_inventory_balances WHERE location_id=$1 AND item_id=$2",[nativeIds.location,nativeIds.part])).rows[0];
  assert.equal(Number(raceStock.on_hand),2);
  assert.equal(Number(raceStock.reserved),2);
  ok(await staff.client.rpc("petro_cancel_service_order",{p_order_id:partWinner.id,p_expected_version:partWinner.version,p_request_key:"native-part-race-cancel"}),"Cancel product winner and release stock");
  assert.equal(Number((await db.query("SELECT reserved::text FROM public.petro_inventory_balances WHERE location_id=$1 AND item_id=$2",[nativeIds.location,nativeIds.part])).rows[0].reserved),1);

  const executionIdentity=await nativeProof("fuel","actual-execution-fuel-proof-01");
  const executionOrder=ok(await staff.client.rpc("petro_worker_reserve_service_order",{...fuelArgs,p_proof_id:executionIdentity.verificationId,p_request_key:"actual-execution-fuel-order-01"}),"Reserve actual execution order");
  const executionStarted=ok(await staff.client.rpc("petro_start_service_order",{p_order_id:executionOrder.id,p_expected_version:1,p_request_key:"actual-execution-start-0001"}),"Actual JWT start");
  assert.equal(executionStarted.status,"in_progress");
  const evidenceArgs={p_order_id:executionOrder.id,p_kind:"odometer",p_file_name:"real-order-meter.png",p_content_type:"image/png",p_byte_size:png.length,p_request_key:"actual-execution-evidence-01"};
  const evidence=ok(await staff.client.rpc("petro_create_service_order_evidence",evidenceArgs),"Create actual private order intent");
  assert.equal(ok(await staff.client.rpc("petro_create_service_order_evidence",evidenceArgs),"Replay actual order intent").id,evidence.id);
  assert.ok((await staff.client.rpc("petro_finalize_service_order_evidence",{p_evidence_id:evidence.id,p_request_key:"actual-execution-finalize-01"})).error,"Missing object cannot be finalized");
  assert.ok((await outsider.client.storage.from(evidence.bucket).upload(evidence.objectPath,png,{contentType:"image/png"})).error,"Outsider cannot upload another order image");
  ok(await staff.client.storage.from(evidence.bucket).upload(evidence.objectPath,png,{contentType:"image/png",upsert:false}),"Actual private order image upload");
  ok(await staff.client.rpc("petro_finalize_service_order_evidence",{p_evidence_id:evidence.id,p_request_key:"actual-execution-finalize-01"}),"Finalize authoritative Storage metadata");
  assert.ok((await staff.client.storage.from(evidence.bucket).upload(evidence.objectPath,png,{contentType:"image/png",upsert:true})).error,"Accepted evidence cannot be overwritten");
  const signedEvidence=ok(await staff.client.storage.from(evidence.bucket).createSignedUrl(evidence.objectPath,60),"Sign own accepted order image");
  assert.deepEqual(Buffer.from(await(await fetch(signedEvidence.signedUrl)).arrayBuffer()),png);
  assert.ok((await outsider.client.storage.from(evidence.bucket).createSignedUrl(evidence.objectPath,60)).error,"Outsider cannot sign order image");
  const deliveryArgs={p_order_id:executionOrder.id,p_expected_version:2,p_input:{actualQuantity:"7",readingKm:"1234"},p_request_key:"actual-execution-delivery-01"};
  const delivery=ok(await staff.client.rpc("petro_deliver_service_order",deliveryArgs),"Actual JWT partial delivery");
  assert.equal(delivery.delivery.actualAmountMinor,"8750");
  assert.equal(delivery.status,"delivered");
  assert.equal(delivery.paymentStatus,"held");
  assert.equal(ok(await staff.client.rpc("petro_deliver_service_order",deliveryArgs),"Replay actual delivery").version,3);
  assert.ok((await staff.client.rpc("petro_cancel_service_order",{p_order_id:executionOrder.id,p_expected_version:3,p_request_key:"actual-executed-cancel-denied"})).error,"Delivered service cannot cancel/release as draft");
  assert.ok((await outsider.client.rpc("petro_service_order_execution",{p_order_id:executionOrder.id})).error,"Outsider execution read denied");

  const wrongPaymentArgs={p_order_id:executionOrder.id,p_expected_version:3,p_pin_hmac:"b".repeat(64),p_request_key:"real-payment-wrong-0001"};
  const wrongPayment=ok(await staff.client.rpc("petro_confirm_service_order",wrongPaymentArgs),"Wrong final PIN commits denial");
  assert.equal(wrongPayment.valid,false);assert.equal(wrongPayment.paid,false);
  assert.equal(ok(await staff.client.rpc("petro_confirm_service_order",wrongPaymentArgs),"Wrong PIN exact retry").valid,false);
  assert.equal(Number((await db.query("SELECT failed_attempts FROM petro_private.petro_fleet_pair_rate_limits WHERE vehicle_id=$1",[nativeIds.vehicle])).rows[0].failed_attempts),1);
  const confirmArgs={p_order_id:executionOrder.id,p_expected_version:3,p_pin_hmac:"a".repeat(64),p_request_key:"real-payment-confirm-0001"};
  assert.ok((await outsider.client.rpc("petro_confirm_service_order",confirmArgs)).error,"Outsider cannot capture delivered order");
  const captureRace=await Promise.all([staff.client.rpc("petro_confirm_service_order",confirmArgs),staff.client.rpc("petro_confirm_service_order",confirmArgs)]);
  const captured=captureRace.map(r=>ok(r,"Concurrent exact confirmation"));
  assert.ok(captured.every(r=>r.paid===true&&r.valid===true&&r.version===4));
  assert.equal(captured[0].payment.receipt.number,captured[1].payment.receipt.number,"Concurrent same key returns one durable receipt");
  assert.equal(captured[0].payment.chargedAmountMinor,"8750");assert.equal(captured[0].payment.releasedAmountMinor,"1250");
  const capturedRows=(await db.query("SELECT count(*)::int AS n,sum(charged_amount_minor)::text AS charged,sum(released_amount_minor)::text AS released FROM petro_private.service_order_payments WHERE order_id=$1",[executionOrder.id])).rows[0];
  assert.deepEqual(capturedRows,{n:1,charged:"8750",released:"1250"});
  assert.equal(Number((await db.query("SELECT count(*) FROM petro_private.service_order_receivables WHERE order_id=$1 AND earned_amount_minor=8750 AND period_end=eligible_at",[executionOrder.id])).rows[0].count),1);
  assert.equal(Number((await db.query("SELECT count(*) FROM public.petro_finance_outbox WHERE event_type='order.paid' AND source_id=$1",[executionOrder.id])).rows[0].count),1);
  assert.equal(captured[0].payment.receipt.snapshot.taxTreatment,"not_configured");
  const genericReversal=await owner.client.rpc("petro_finance_admin_reverse_journal",{p_entry_id:captured[0].payment.journalEntryId,p_reason:"فحص عكس خدمة معزول",p_idempotency_key:"native-generic-reversal-denied"});
  assert.equal(genericReversal.error?.code,"55000");assert.equal(genericReversal.error?.message,"USE_SERVICE_ORDER_REFUND_WORKFLOW");

  assert.ok((await staff.client.rpc("petro_confirm_service_order",{...confirmArgs,p_request_key:"real-payment-second-key-01"})).error,"Another key cannot capture a paid order");
  console.log("PASS: actual JWT final PIN denial/replay commits one attempt; concurrent exact capture commits one balanced actual payment, release, branch receivable, receipt and outbox event.");


  const refundArgs={p_order_id:executionOrder.id,p_amount_minor:"6000",p_category:"quality",p_note:null,p_request_key:"real-refund-race-request-a"};
  assert.ok((await outsider.client.rpc("petro_service_order_refund_requests",{p_order_id:executionOrder.id})).error,"Outsider cannot read refund claims");
  assert.ok((await staff.client.rpc("petro_request_service_refund",refundArgs)).error,"Worker cannot request company money");
  const refundJournalBefore=Number((await db.query("SELECT count(*) FROM public.petro_finance_journal_entries")).rows[0].count);
  const refundRace=await Promise.all([owner.client.rpc("petro_request_service_refund",refundArgs),owner.client.rpc("petro_request_service_refund",{...refundArgs,p_request_key:"real-refund-race-request-b"})]);
  assert.equal(refundRace.filter(r=>!r.error).length,1,"Concurrent requests cannot exceed original paid capacity");
  assert.equal(refundRace.filter(r=>r.error?.code==="23514").length,1);
  const won=ok(refundRace.find(r=>!r.error),"Committed refund request");
  const wonArgs=refundRace[0].error?{...refundArgs,p_request_key:"real-refund-race-request-b"}:refundArgs;
  assert.deepEqual(ok(await owner.client.rpc("petro_request_service_refund",wonArgs),"Exact refund replay"),won);
  const withdrawArgs={p_request_id:won.id,p_expected_version:1,p_request_key:"real-refund-withdraw-0001"};
  const withdrawal=ok(await owner.client.rpc("petro_withdraw_service_refund",withdrawArgs),"Withdraw original refund request");
  assert.equal(withdrawal.status,"withdrawn");assert.equal(withdrawal.moneyRefunded,false);
  assert.deepEqual(ok(await owner.client.rpc("petro_withdraw_service_refund",withdrawArgs),"Replay withdrawal"),withdrawal);
  const refundView=ok(await owner.client.rpc("petro_service_order_refund_requests",{p_order_id:executionOrder.id}),"Read refund history");
  assert.equal(refundView.requestedAmountMinor,"0");assert.equal(refundView.remainingRequestableMinor,"8750");assert.equal(refundView.items.length,1);
  assert.equal(Number((await db.query("SELECT count(*) FROM public.petro_finance_journal_entries")).rows[0].count),refundJournalBefore,"Request workflow does not post money");
  console.log("PASS: actual JWT scoped refund intake denies outsider/worker writes, concurrent over-request loses, exact request/withdrawal replay retains one history without money movement.");
  await db.query("UPDATE public.petro_worker_assignments SET active=false,version=version+1 WHERE user_id=$1 AND branch_id=$2 AND service_group='fuel'",[staff.id,nativeBranch]);
  assert.ok((await staff.client.storage.from(evidence.bucket).createSignedUrl(evidence.objectPath,60)).error,"Revoked assignment loses order image signing");
  assert.ok((await staff.client.rpc("petro_service_order_execution",{p_order_id:executionOrder.id})).error,"Existing JWT loses execution access after assignment revocation");
  assert.ok((await staff.client.rpc("petro_service_order_payment",{p_order_id:executionOrder.id})).error,"Revoked worker loses receipt read");
  assert.ok((await staff.client.rpc("petro_confirm_service_order",confirmArgs)).error,"Revoked worker cannot replay final capture");
  assert.ok((await staff.client.rpc("petro_service_order_refund_requests",{p_order_id:executionOrder.id})).error,"Revoked worker loses refund history read");
  console.log("PASS: real JWT start, actual order image upload/download/metadata/overwrite/outsider guards, partial delivery replay and immediate assignment-revocation denial.");

  await db.query("UPDATE public.petro_memberships SET active=false WHERE user_id=$1 AND organization_id=(SELECT id FROM public.petro_organizations WHERE code='QUOTE-IT-M')",[staff.id]);
  console.log("PASS: concurrent real-JWT transactions produced one proof winner and one last-stock winner; manual cancellations released only those real holds.");

  await db.query("UPDATE public.petro_memberships SET active=false WHERE id=$1",[membership]);
  assert.equal(ok(await staff.client.rpc("petro_worker_pin_proof",{p_proof_id:proof.verificationId}),"Revoked member proof").valid,false);
  assert.equal(ok(await staff.client.rpc("petro_worker_capabilities"),"Recheck revoked real worker").items.length,0,"Existing JWT loses revoked branch permission");
  await db.query("UPDATE public.petro_memberships SET active=true WHERE id=$1",[membership]);
  await db.query("UPDATE public.petro_profiles SET password_change_required=true WHERE user_id=$1",[staff.id]);
  assert.ok((await staff.client.rpc("petro_worker_capabilities")).error,"Direct RPC cannot bypass temporary-password gate");
  await db.query("UPDATE public.petro_profiles SET password_change_required=false WHERE user_id=$1",[staff.id]);
  await db.query("UPDATE public.petro_branches SET operational_status='suspended',status='suspended' WHERE id=$1",[stationBranch]);
  assert.equal(ok(await staff.client.rpc("petro_worker_capabilities"),"Recheck suspended branch").items.length,0);
  await db.query("UPDATE public.petro_profiles SET active=false,account_status='suspended' WHERE user_id=$1", [owner.id]);
  const suspended = await owner.client.rpc("petro_admin_fleet_catalog", { p_view: "overview", p_filters: {} });
  assert.ok(suspended.error, "Existing real JWT must lose project access after suspension");
  console.log("PASS: real isolated Supabase Auth confirmation/pending activation, authenticated project RPC, vehicle/odometer private upload/download, duplicate rejection, outsider/public denial, real worker assignment/role/direct-table denial, actor-bound operational PIN proofs/replay/private-table denial, exact scoped service quotation and stale-JWT membership/password/branch revocation. No production resources or SMTP delivery tested.");
} finally {
  await db.end();
}
