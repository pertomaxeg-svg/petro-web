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
    if (number < 3 || number === 9 || number > 35 || !file.endsWith(".sql")) continue;
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
