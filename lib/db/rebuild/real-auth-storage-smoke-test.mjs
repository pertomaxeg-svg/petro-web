// Real Auth, PostgREST and Storage against disposable local Supabase only.
// No production keys or application authentication bypass are used.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

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
  await db.query(baseline);
  await db.query(await readFile(resolve(root, "lib/db/rebuild/local-auth-post-baseline.sql"), "utf8"));
  for (const file of (await readdir(resolve(root, "lib/db/migrations"))).sort()) {
    const number = Number(file.slice(0, 4));
    if (number < 3 || number === 9 || number > 26 || !file.endsWith(".sql")) continue;
    await db.query(await readFile(resolve(root, "lib/db/migrations", file), "utf8"));
  }
  await db.query("NOTIFY pgrst, 'reload schema'");
  await new Promise(resolve => setTimeout(resolve, 1000));

  async function confirmedAccount(username) {
    const email = username + "@example.invalid";
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
  await db.query("UPDATE public.petro_profiles SET active=false,account_status='suspended' WHERE user_id=$1", [owner.id]);
  const suspended = await owner.client.rpc("petro_admin_fleet_catalog", { p_view: "overview", p_filters: {} });
  assert.ok(suspended.error, "Existing real JWT must lose project access after suspension");
  console.log("PASS: real isolated Supabase Auth confirmation/pending activation, authenticated project RPC, vehicle/odometer private upload/download, duplicate rejection, outsider/public denial and stale-session suspension. No production resources or SMTP delivery tested.");
} finally {
  await db.end();
}
