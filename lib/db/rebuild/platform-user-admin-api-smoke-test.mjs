// Exercises the actual Express management router against the isolated PostgreSQL
// cluster. A local fake Supabase HTTP transport maps Auth/PostgREST calls to that
// cluster; it never forwards a request to the approved hosted Supabase URL.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomBytes, createHash, createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runAdminUiLocalSmoke } from "./admin-ui-local-smoke-test.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const apiRoot = resolve(repoRoot, "artifacts/api-server");
const apiRequire = createRequire(resolve(apiRoot, "package.json"));
const dbRequire = createRequire(resolve(repoRoot, "lib/db/package.json"));
const { build } = apiRequire("esbuild");
const express = apiRequire("express");
const cookieParser = apiRequire("cookie-parser");
const { Client } = dbRequire("pg");

const projectRef = "msvgzsfzrqlrfpstthhe";
const approvedOrigin = `https://${projectRef}.supabase.co`;
const actorIds = new Set([
  "00000000-0000-4000-8000-000000000601",
  "00000000-0000-4000-8000-000000000602",
  "00000000-0000-4000-8000-000000000603",
  "00000000-0000-4000-8000-000000000604",
  "00000000-0000-4000-8000-000000000605",
  "00000000-0000-4000-8000-000000000606",
  "00000000-0000-4000-8000-000000000607",
]);
const createdPlatformUserId = "00000000-0000-4000-8000-000000000608";
let simulatePre0008 = true;
let inventoryApiAssertions = 0;
const isolatedStorageObjects = new Map();
const isolatedStorageToken = randomBytes(24).toString("hex");
let isolatedStorageBaseUrl = "";
let failNextStorageUpload = false;
let failNextStorageSign = false;
let failNextOrderReserveResponse=false;
let failNextOrderCancelResponse=false;
let failNextDeliveryResponse=false;
let failNextConfirmationResponse=false;

function inventoryEqual(actual, expected, message) {
  inventoryApiAssertions += 1;
  assert.equal(actual, expected, message);
}

function inventoryOk(value, message) {
  inventoryApiAssertions += 1;
  assert.ok(value, message);
}

process.env["NODE_ENV"] = "test";
process.env["SESSION_SECRET"] = randomBytes(32).toString("base64");
process.env["FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V1"] = randomBytes(32).toString("base64");
process.env["SUPABASE_URL"] = approvedOrigin;
process.env["SUPABASE_ANON_KEY"] = "sb_publishable_localtest";

const routerBundle = resolve(apiRoot, "dist/platform-user-admin-test.mjs");
const authRouterBundle = resolve(apiRoot, "dist/platform-user-auth-test.mjs");
const billingRouterBundle = resolve(apiRoot, "dist/platform-billing-admin-test.mjs");
const financeRouterBundle = resolve(apiRoot, "dist/platform-finance-admin-test.mjs");
const serviceOrdersRouterBundle = resolve(apiRoot, "dist/platform-service-orders-test.mjs");
const workforceRouterBundle = resolve(apiRoot, "dist/platform-workforce-test.mjs");
const fleetRouterBundle = resolve(apiRoot, "dist/platform-fleet-admin-test.mjs");
const catalogRouterBundle = resolve(apiRoot, "dist/platform-catalog-admin-test.mjs");
const inventoryRouterBundle = resolve(apiRoot, "dist/platform-inventory-admin-test.mjs");
const organizationWorkflowsRouterBundle = resolve(apiRoot, "dist/platform-organization-workflows-test.mjs");
mkdirSync(resolve(apiRoot, "dist"), { recursive: true });
for (const [entryPoint, outfile] of [
  [resolve(apiRoot, "src/routes/auth.ts"), authRouterBundle],
  [resolve(apiRoot, "src/routes/management.ts"), routerBundle],
  [resolve(apiRoot, "src/routes/billing.ts"), billingRouterBundle],
  [resolve(apiRoot, "src/routes/finance.ts"), financeRouterBundle],
  [resolve(apiRoot, "src/routes/fleet.ts"), fleetRouterBundle],
  [resolve(apiRoot, "src/routes/workforce.ts"), workforceRouterBundle],
  [resolve(apiRoot, "src/routes/service-orders.ts"), serviceOrdersRouterBundle],
  [resolve(apiRoot, "src/routes/catalog.ts"), catalogRouterBundle],
  [resolve(apiRoot, "src/routes/inventory.ts"), inventoryRouterBundle],
  [resolve(apiRoot, "src/routes/organization-workflows.ts"), organizationWorkflowsRouterBundle],
]) {
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["express", "@supabase/ssr", "exceljs"],
    banner: {
      js: `import { createRequire as createNodeRequire } from "node:module"; const require = createNodeRequire(import.meta.url);`,
    },
    plugins: [{
      name: "isolated-api-database",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@workspace\/db$/ }, () => ({
          path: resolve(repoRoot, "lib/db/rebuild/api-db-test-shim.mjs"),
        }));
      },
    }],
  });
}

const { default: managementRouter } = await import(pathToFileURL(routerBundle).href);
const { default: authRouter } = await import(pathToFileURL(authRouterBundle).href);
const { default: billingRouter } = await import(pathToFileURL(billingRouterBundle).href);
const { default: financeRouter } = await import(pathToFileURL(financeRouterBundle).href);
const { default: serviceOrdersRouter } = await import(pathToFileURL(serviceOrdersRouterBundle).href);
const { default: workforceRouter } = await import(pathToFileURL(workforceRouterBundle).href);
const { default: fleetRouter } = await import(pathToFileURL(fleetRouterBundle).href);
const { default: catalogRouter } = await import(pathToFileURL(catalogRouterBundle).href);
const { default: inventoryRouter } = await import(pathToFileURL(inventoryRouterBundle).href);
const { default: organizationWorkflowsRouter } = await import(pathToFileURL(organizationWorkflowsRouterBundle).href);

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function decodeUserId(token) {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof claims.sub === "string" && (actorIds.has(claims.sub) || claims.sub === createdPlatformUserId)
      ? claims.sub
      : null;
  } catch {
    return null;
  }
}

async function withActor(actorId, query, values = []) {
  const client = new Client({
    host: process.env["PGHOST"],
    port: Number(process.env["PGPORT"]),
    database: process.env["PGDATABASE"],
    user: process.env["PGUSER"],
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    await client.query(
      "SELECT set_config('request.jwt.claim.sub', $1, true)",
      [actorId],
    );
    const result = await client.query(query, values);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function errorStatus(code) {
  if (code === "42501") return 403;
  if (code === "P0002") return 404;
  if (["23505", "23514", "40001", "55000"].includes(code)) return 409;
  return 400;
}

function parseInFilter(value) {
  if (typeof value !== "string" || !value.startsWith("in.(") || !value.endsWith(")")) return [];
  return value.slice(4, -1).split(",").map((item) => item.trim()).filter(Boolean);
}

function parseRange(headers, fallbackSize = 100) {
  const raw = headers.get("range") ?? headers.get("range-unit");
  if (typeof raw !== "string") return { from: 0, to: fallbackSize - 1 };
  const match = raw.match(/(?:items=)?(\d+)-(\d+)/);
  return match ? { from: Number(match[1]), to: Number(match[2]) } : { from: 0, to: fallbackSize - 1 };
}

function rangedRows(rows, count, headers) {
  const { from, to } = parseRange(headers);
  const selected = rows.slice(from, to + 1);
  return new Response(JSON.stringify(selected), {
    status: 206,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-range": `${from}-${Math.max(from, from + selected.length - 1)}/${count}`,
      "accept-ranges": "items",
    },
  });
}

async function mockSupabaseFetch(input, init = {}) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== approvedOrigin) {
    throw new Error(`Blocked unexpected network origin: ${url.origin}`);
  }
  const request = input instanceof Request ? input : null;
  const headers = new Headers(init.headers ?? request?.headers);
  const method = String(init.method ?? request?.method ?? "GET").toUpperCase();
  const token = headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const actorId = decodeUserId(token);
  const path = url.pathname;

  if (path.startsWith("/storage/v1/object/")) {
    if (!actorId) return jsonResponse({ message: "Missing isolated storage session" }, 401);
    if (path.startsWith("/storage/v1/object/sign/") && method === "POST") {
      if (failNextStorageSign) {
        failNextStorageSign = false;
        return jsonResponse({ message: "Synthetic isolated signed-url failure" }, 503);
      }
      const objectPath = path.slice("/storage/v1/object/sign/".length);
      const separator = objectPath.indexOf("/");
      if (separator < 1 || !isolatedStorageBaseUrl) return jsonResponse({ message: "Invalid isolated storage request" }, 400);
      const bucket = decodeURIComponent(objectPath.slice(0, separator));
      const key = objectPath.slice(separator + 1).split("/").map(decodeURIComponent).join("/");
      if (bucket !== "petro-private-documents" || !isolatedStorageObjects.has(`${bucket}/${key}`)) {
        return jsonResponse({ message: "Private isolated object was not found" }, 404);
      }
      if(key.startsWith("orders/")&&!(await withActor(actorId,"SELECT petro_private.can_access_service_order_evidence($1,'read') AS allowed",[key])).rows[0].allowed)return jsonResponse({message:"Order evidence denied"},403);
      const signedURL = `/object/sign/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}?token=isolated-test`;
      return jsonResponse({ signedURL });
    }
    const objectPath = path.slice("/storage/v1/object/".length).replace(/^authenticated\//,"");
    const separator = objectPath.indexOf("/");
    if (separator < 1) return jsonResponse({ message: "Invalid isolated storage object" }, 400);
    const bucket = decodeURIComponent(objectPath.slice(0, separator));
    const key = objectPath.slice(separator + 1).split("/").map(decodeURIComponent).join("/");
    if (bucket !== "petro-private-documents") return jsonResponse({ message: "Bucket is private and unavailable" }, 403);
    const storageKey = `${bucket}/${key}`;
    if (method === "POST" || method === "PUT") {
      if (failNextStorageUpload) {
        failNextStorageUpload = false;
        return jsonResponse({ message: "Synthetic isolated upload failure" }, 503);
      }
      const body = Buffer.isBuffer(init.body)
        ? Buffer.from(init.body)
        : init.body instanceof Uint8Array
          ? Buffer.from(init.body)
          : request
            ? Buffer.from(await request.clone().arrayBuffer())
            : Buffer.alloc(0);
      if (isolatedStorageObjects.has(storageKey)) return jsonResponse({ message: "Object already exists" }, 409);
      if(key.startsWith("orders/")){
        try{await withActor(actorId,"INSERT INTO storage.objects(bucket_id,name,owner_id,metadata) VALUES($1,$2,$3::uuid,$4::jsonb)",[bucket,key,actorId,JSON.stringify({size:body.length,mimetype:headers.get("content-type")??"application/octet-stream"})]);}
        catch(error){return jsonResponse({message:error.message},403);}
      }
      isolatedStorageObjects.set(storageKey, {
        bytes: body,
        contentType: headers.get("content-type") ?? "application/octet-stream",
      });
      return jsonResponse({ Key: storageKey });
    }
    if(method==="GET"){
      const object=isolatedStorageObjects.get(storageKey);
      if(!object)return jsonResponse({message:"Object not found"},404);
      if(key.startsWith("orders/")&&!(await withActor(actorId,"SELECT petro_private.can_access_service_order_evidence($1,'read') AS allowed",[key])).rows[0].allowed)return jsonResponse({message:"Order evidence denied"},403);
      return new Response(object.bytes,{status:200,headers:{"Content-Type":object.contentType}});
    }
    if (method === "DELETE") {
      if(key.startsWith("orders/"))return jsonResponse({message:"Order evidence immutable"},403);
      isolatedStorageObjects.delete(storageKey);
      return jsonResponse({ message: "Removed" });
    }
    return jsonResponse({ message: "Unsupported isolated storage method" }, 405);
  }

  if (path === "/auth/v1/signup" && method === "POST") {
    const rawBody =
      typeof init.body === "string"
        ? init.body
        : request
          ? await request.clone().text()
          : "{}";
    const signup = JSON.parse(rawBody);
    const metadata = signup.data && typeof signup.data === "object" ? signup.data : {};
    const email = String(signup.email ?? "");
    const client = new Client({
      host: process.env["PGHOST"],
      port: Number(process.env["PGPORT"]),
      database: process.env["PGDATABASE"],
      user: process.env["PGUSER"],
    });
    await client.connect();
    try {
      await client.query(
        `INSERT INTO auth.users (id, email, raw_user_meta_data)
         VALUES ($1::uuid, $2, $3::jsonb)`,
        [createdPlatformUserId, email, JSON.stringify(metadata)],
      );
      await client.query(
        "UPDATE auth.users SET email_confirmed_at = now() WHERE id = $1::uuid",
        [createdPlatformUserId],
      );
    } finally {
      await client.end();
    }
    actorIds.add(createdPlatformUserId);
    return jsonResponse({
      user: {
        id: createdPlatformUserId,
        email,
        identities: [{ identity_id: "synthetic-platform-identity" }],
        email_confirmed_at: new Date().toISOString(),
        user_metadata: metadata,
      },
      session: null,
    });
  }

  if (path === "/auth/v1/user" && method === "GET") {
    if (!actorId) return jsonResponse({ message: "Invalid test session" }, 401);
    return jsonResponse({
      id: actorId,
      aud: "authenticated",
      role: "authenticated",
      email: `${actorId}@example.invalid`,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: { username: "synthetic_test_user" },
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
  }
  if (path === "/auth/v1/user" && method === "PUT") {
    if (!actorId) return jsonResponse({ message: "Invalid test session" }, 401);
    return jsonResponse({
      id: actorId,
      aud: "authenticated",
      role: "authenticated",
      email: `${actorId}@example.invalid`,
      email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: { username: "synthetic_test_user" },
    });
  }

  if (!actorId) return jsonResponse({ message: "Missing test session" }, 401);
  if (path === "/rest/v1/petro_profiles" && method === "GET") {
    const filter = url.searchParams.get("user_id") ?? "";
    const profileId = filter.startsWith("eq.") ? filter.slice(3) : "";
    const profileIds = parseInFilter(filter);
    try {
      if (profileIds.length) {
        const result = await withActor(
          actorId,
          "SELECT user_id, display_name, username, active, account_status, login_identifier_type, password_change_required FROM public.petro_profiles WHERE user_id = ANY($1::uuid[])",
          [profileIds],
        );
        return jsonResponse(result.rows);
      }
      const result = await withActor(actorId,
        "SELECT user_id, display_name, username, active, account_status, login_identifier_type, password_change_required FROM public.petro_profiles WHERE user_id = $1::uuid",
        [profileId]);
      const row = result.rows[0] ?? null;
      if (headers.get("accept")?.includes("vnd.pgrst.object+json")) return row ? jsonResponse(row) : jsonResponse({ message: "No rows" }, 406);
      return jsonResponse(row ? [row] : []);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "XX000";
      console.error(`[local-api-rpc] ${functionName} ${code}: ${String(error?.message ?? "DB error")}`);
      return jsonResponse({ code, message: String(error?.message ?? "DB error") }, errorStatus(code));
    }
  }
  if (path === "/rest/v1/petro_organizations" && method === "GET") {
    const filter = url.searchParams.get("id") ?? "";
    const organizationId = filter.startsWith("eq.") ? filter.slice(3) : "";
    const organizationIds = parseInFilter(filter);
    try {
      if (organizationId || organizationIds.length) {
        const result = organizationIds.length
          ? await withActor(actorId,
            "SELECT id, name, code FROM public.petro_organizations WHERE id = ANY($1::uuid[])",
            [organizationIds])
          : await withActor(actorId,
            `SELECT id, name, kind, code, legal_name, contact_name, contact_phone, contact_email,
              address, country_code, currency, status, approval_status, operational_status,
              created_at, updated_at, version
             FROM public.petro_organizations
             WHERE id = $1::uuid`,
            [organizationId]);
        const row = result.rows[0] ?? null;
        return headers.get("accept")?.includes("vnd.pgrst.object+json")
          ? row ? jsonResponse(row) : jsonResponse({ message: "No rows" }, 406)
          : jsonResponse(organizationIds.length ? result.rows : row ? [row] : []);
      }

      const predicates = ["TRUE"];
      const values = [];
      const addEqFilter = (queryName, columnName) => {
        const raw = url.searchParams.get(queryName) ?? "";
        if (!raw.startsWith("eq.")) return;
        values.push(raw.slice(3));
        predicates.push(`${columnName} = $${values.length}`);
      };
      addEqFilter("kind", "kind");
      addEqFilter("approval_status", "approval_status");
      addEqFilter("operational_status", "operational_status");
      const orFilter = url.searchParams.get("or") ?? "";
      const searchMatch = orFilter.match(/(?:name|code|legal_name)\.ilike\.%([^%]+)%/);
      if (searchMatch?.[1]) {
        values.push(`%${searchMatch[1].replace(/[%_\\]/g, "")}%`);
        const index = values.length;
        predicates.push(`(name ILIKE $${index} OR code ILIKE $${index} OR legal_name ILIKE $${index})`);
      }
      const orderColumnMap = {
        id: "id",
        name: "name",
        code: "code",
        kind: "kind",
        approval_status: "approval_status",
        operational_status: "operational_status",
        created_at: "created_at",
      };
      const requestedOrder = (url.searchParams.get("order") ?? "created_at.desc")
        .split(",")
        .map((item) => {
          const [column, direction] = item.trim().split(".");
          const safeColumn = orderColumnMap[column];
          if (!safeColumn || !["asc", "desc"].includes(direction)) return null;
          return `${safeColumn} ${direction.toUpperCase()}`;
        })
        .filter(Boolean);
      const orderBy = requestedOrder.length ? requestedOrder.join(", ") : "created_at DESC, id ASC";
      const whereClause = predicates.join(" AND ");
      const countResult = await withActor(actorId,
        `SELECT count(*)::int AS count FROM public.petro_organizations WHERE ${whereClause}`,
        values);
      const count = Number(countResult.rows[0]?.count ?? 0);
      const { from, to } = parseRange(headers);
      const result = await withActor(actorId,
        `SELECT id, name, kind, code, legal_name, contact_name, contact_phone, contact_email,
          address, country_code, currency, status, approval_status, operational_status,
          created_at, updated_at, version
         FROM public.petro_organizations
         WHERE ${whereClause}
         ORDER BY ${orderBy}
         LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, Math.max(0, to - from + 1), from]);
      return rangedRows(result.rows, count, headers);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "XX000";
      return jsonResponse({ code, message: String(error?.message ?? "DB error") }, errorStatus(code));
    }
  }
  if (path === "/rest/v1/petro_memberships" && method === "GET") {
    const organizationFilter = url.searchParams.get("organization_id") ?? "";
    const userFilter = url.searchParams.get("user_id") ?? "";
    const organizationId = organizationFilter.startsWith("eq.") ? organizationFilter.slice(3) : "";
    const userId = userFilter.startsWith("eq.") ? userFilter.slice(3) : "";
    const { from, to } = parseRange(headers);
    try {
      const scope = organizationId ? "organization_id = $1::uuid" : "user_id = $1::uuid";
      const scopeValue = organizationId || userId;
      const countResult = await withActor(actorId,
        `SELECT count(*)::int AS count FROM public.petro_memberships WHERE ${scope}`,
        [scopeValue]);
      const result = await withActor(actorId,
        `SELECT id, user_id, organization_id, role, scope, active FROM public.petro_memberships WHERE ${scope} ORDER BY role LIMIT $2 OFFSET $3`,
        [scopeValue, to - from + 1, from]);
      return organizationId
        ? rangedRows(result.rows, Number(countResult.rows[0]?.count ?? 0), headers)
        : jsonResponse(result.rows);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "XX000";
      return jsonResponse({ code, message: String(error?.message ?? "DB error") }, errorStatus(code));
    }
  }
  if (path === "/rest/v1/petro_membership_branches" && method === "GET") {
    const membershipIds = parseInFilter(url.searchParams.get("membership_id"));
    try {
      const result = membershipIds.length
        ? await withActor(actorId,
          "SELECT membership_id, branch_id FROM public.petro_membership_branches WHERE membership_id = ANY($1::uuid[])",
          [membershipIds])
        : { rows: [] };
      return jsonResponse(result.rows);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "XX000";
      return jsonResponse({ code, message: String(error?.message ?? "DB error") }, errorStatus(code));
    }
  }
  if (path === "/rest/v1/petro_branches" && method === "GET") {
    const organizationFilter = url.searchParams.get("organization_id") ?? "";
    const organizationId = organizationFilter.startsWith("eq.") ? organizationFilter.slice(3) : "";
    const idFilter = url.searchParams.get("id") ?? "";
    const branchId = idFilter.startsWith("eq.") ? idFilter.slice(3) : "";
    const branchIds = parseInFilter(idFilter);
    try {
      const result = branchId
        ? await withActor(actorId,
          "SELECT * FROM public.petro_branches WHERE organization_id = $1::uuid AND id = $2::uuid",
          [organizationId, branchId])
        : branchIds.length
          ? organizationId
            ? await withActor(actorId,
              "SELECT id, name, code FROM public.petro_branches WHERE organization_id = $1::uuid AND id = ANY($2::uuid[])",
              [organizationId, branchIds])
            : await withActor(actorId,
              "SELECT id, name, code FROM public.petro_branches WHERE id = ANY($1::uuid[])",
              [branchIds])
          : await withActor(actorId,
            "SELECT * FROM public.petro_branches WHERE organization_id = $1::uuid",
            [organizationId]);
      const row = result.rows[0] ?? null;
      if (headers.get("accept")?.includes("vnd.pgrst.object+json")) {
        return row ? jsonResponse(row) : jsonResponse({ message: "No rows" }, 406);
      }
      return jsonResponse(result.rows);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "XX000";
      return jsonResponse({ code, message: String(error?.message ?? "DB error") }, errorStatus(code));
    }
  }

  const inboxColumns={
    petro_org_join_requests:"id,applicant_id,status,version,created_at,organization_data,initial_branch_data,decision_reason",
    petro_org_change_requests:"id,organization_id,branch_id,target_type,applicant_id,status,version,created_at,current_snapshot,proposed_data,decision_reason",
    petro_bank_account_versions:"id,bank_account_id,organization_id,version,bank_name,beneficiary_name,account_last4,status,created_by,created_at,reviewed_by,reviewed_at,decision_reason",
    petro_documents:"id,uploader_id,organization_id,branch_id,join_request_id,change_request_id,bank_account_version_id,finance_topup_request_id,finance_subscription_request_id,finance_bank_receipt_id,document_type,file_name,content_type,byte_size,expires_on,status,uploaded_at,reviewed_by,reviewed_at,review_reason,version,created_at"
  };
  const inboxTable=path.startsWith("/rest/v1/")?path.slice("/rest/v1/".length):"";
  if(method==="GET"&&Object.hasOwn(inboxColumns,inboxTable)&&!url.searchParams.has("id")){
    const filter=url.searchParams.get("status")??"";
    const states=filter.startsWith("eq.")?[filter.slice(3)]:parseInFilter(filter);
    if(!states.length||states.some(value=>!/^[_a-z]{1,40}$/.test(value)))return jsonResponse({message:"Unsupported isolated inbox status filter"},400);
    try{
      const rows=await withActor(actorId,`SELECT ${inboxColumns[inboxTable]} FROM public.${inboxTable} WHERE status=ANY($1::text[]) ORDER BY created_at ASC LIMIT 100`,[states]);
      return jsonResponse(rows.rows);
    }catch(error){return jsonResponse({code:error.code??"XX000",message:String(error.message??"DB error")},errorStatus(error.code));}
  }
  if(method==="GET"&&path==="/rest/v1/petro_bank_accounts"){
    const ids=parseInFilter(url.searchParams.get("id"));
    if(!ids.length)return jsonResponse({message:"Missing isolated bank ids"},400);
    try{return jsonResponse((await withActor(actorId,"SELECT id,version FROM public.petro_bank_accounts WHERE id=ANY($1::uuid[])",[ids])).rows);}
    catch(error){return jsonResponse({code:error.code??"XX000",message:String(error.message??"DB error")},errorStatus(error.code));}
  }

  if (path === "/rest/v1/petro_documents" && method === "GET") {
    const filter = url.searchParams.get("id") ?? "";
    const documentId = filter.startsWith("eq.") ? filter.slice(3) : "";
    if (!documentId) return jsonResponse({ message: "The isolated document adapter requires a document id." }, 400);
    try {
      const result = await withActor(actorId,
        `SELECT id, uploader_id, storage_path, content_type, byte_size, file_name, status, upload_expires_at
         FROM public.petro_documents WHERE id = $1::uuid`,
        [documentId]);
      const row = result.rows[0] ?? null;
      if (headers.get("accept")?.includes("vnd.pgrst.object+json")) {
        return row ? jsonResponse(row) : jsonResponse({ message: "No rows" }, 406);
      }
      return jsonResponse(row ? [row] : []);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "XX000";
      return jsonResponse({ code, message: String(error?.message ?? "DB error") }, errorStatus(code));
    }
  }

  if (path.startsWith("/rest/v1/rpc/") && method === "POST") {
    const functionName = path.slice("/rest/v1/rpc/".length);
    const rawBody =
      typeof init.body === "string"
        ? init.body
        : request
          ? await request.clone().text()
          : "{}";
    const args = JSON.parse(rawBody);
    const queries = {
      petro_service_order_payment:["SELECT public.petro_service_order_payment($1::uuid) AS result",[args.p_order_id],"scalar"],
      petro_service_order_payment_context:["SELECT public.petro_service_order_payment_context($1::uuid) AS result",[args.p_order_id],"scalar"],
      petro_confirm_service_order:["SELECT public.petro_confirm_service_order($1::uuid,$2::bigint,$3,$4) AS result",[args.p_order_id,args.p_expected_version,args.p_pin_hmac,args.p_request_key],"scalar"],
      petro_service_order_execution:["SELECT public.petro_service_order_execution($1::uuid) AS result",[args.p_order_id],"scalar"],
      petro_start_service_order:["SELECT public.petro_start_service_order($1::uuid,$2::bigint,$3) AS result",[args.p_order_id,args.p_expected_version,args.p_request_key],"scalar"],
      petro_deliver_service_order:["SELECT public.petro_deliver_service_order($1::uuid,$2::bigint,$3::jsonb,$4) AS result",[args.p_order_id,args.p_expected_version,args.p_input,args.p_request_key],"scalar"],
      petro_create_service_order_evidence:["SELECT public.petro_create_service_order_evidence($1::uuid,$2,$3,$4,$5::bigint,$6) AS result",[args.p_order_id,args.p_kind,args.p_file_name,args.p_content_type,args.p_byte_size,args.p_request_key],"scalar"],
      petro_finalize_service_order_evidence:["SELECT public.petro_finalize_service_order_evidence($1::uuid,$2) AS result",[args.p_evidence_id,args.p_request_key],"scalar"],
      petro_service_order_evidence_file:["SELECT public.petro_service_order_evidence_file($1::uuid,$2) AS result",[args.p_evidence_id,args.p_action],"scalar"],
      petro_worker_reserve_service_order:["SELECT public.petro_worker_reserve_service_order($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::uuid,$6) AS result",[args.p_proof_id,args.p_reference_id,args.p_price_version_id,JSON.stringify(args.p_input),args.p_location_id,args.p_request_key],"scalar"],
      petro_service_orders_query:["SELECT public.petro_service_orders_query($1::jsonb) AS result",[args.p_filters],"scalar"],
      petro_cancel_service_order:["SELECT public.petro_cancel_service_order($1::uuid,$2::bigint,$3) AS result",[args.p_order_id,args.p_expected_version,args.p_request_key],"scalar"],
      petro_worker_service_options: ["SELECT public.petro_worker_service_options($1::uuid,$2,$3::integer,$4::integer) AS result",[args.p_proof_id,args.p_search,args.p_page,args.p_page_size],"scalar"],
      petro_worker_quote_service: ["SELECT public.petro_worker_quote_service($1::uuid,$2::uuid,$3::uuid,$4::jsonb,$5::uuid) AS result",[args.p_proof_id,args.p_reference_id,args.p_price_version_id,JSON.stringify(args.p_input),args.p_location_id],"scalar"],
      petro_worker_credential_context: ["SELECT public.petro_worker_credential_context($1::uuid,$2,$3) AS result",[args.p_branch_id,args.p_service_group,args.p_credential_hash],"scalar"],
      petro_worker_verify_pair: ["SELECT public.petro_worker_verify_pair($1::uuid,$2,$3,$4,$5) AS result",[args.p_branch_id,args.p_service_group,args.p_credential_hash,args.p_pin_hmac,args.p_request_key],"scalar"],
      petro_worker_pin_proof: ["SELECT public.petro_worker_pin_proof($1::uuid) AS result",[args.p_proof_id],"scalar"],
      petro_admin_worker_assignments: ["SELECT public.petro_admin_worker_assignments($1::jsonb) AS result",[args.p_filters],"scalar"],
      petro_admin_worker_assignment: ["SELECT public.petro_admin_worker_assignment($1::uuid,$2::uuid,$3,$4::boolean,$5::bigint,$6) AS result",[args.p_user_id,args.p_branch_id,args.p_service_group,args.p_active,args.p_expected_version,args.p_request_key],"scalar"],
      petro_worker_capabilities: ["SELECT public.petro_worker_capabilities() AS result",[],"scalar"],
      petro_access_context: [
        "SELECT public.petro_access_context() AS result",
        [],
        "scalar",
      ],
      petro_admin_list_platform_users: [
        "SELECT * FROM public.petro_admin_list_platform_users($1, $2, $3, $4, $5)",
        [args.p_page, args.p_page_size, args.p_search, args.p_account_status, args.p_role],
        "rows",
      ],
      petro_admin_get_platform_user: [
        "SELECT public.petro_admin_get_platform_user($1::uuid) AS result",
        [args.p_user_id],
        "scalar",
      ],
      petro_admin_set_platform_roles: [
        "SELECT public.petro_admin_set_platform_roles($1::uuid, $2::text[], $3::text) AS result",
        [args.p_user_id, args.p_roles, args.p_reason],
        "scalar",
      ],
      petro_admin_create_platform_user_access: [
        "SELECT public.petro_admin_create_platform_user_access($1::uuid, $2::text[], $3::text) AS result",
        [args.p_user_id, args.p_roles, args.p_reason],
        "scalar",
      ],
      petro_admin_set_account_status: [
        "SELECT public.petro_admin_set_account_status($1::uuid, $2::text, $3::text)",
        [args.p_user_id, args.p_status, args.p_reason],
        "void",
      ],
      petro_billing_admin_catalog_v2: [
        "SELECT public.petro_billing_admin_catalog_v2() AS result",
        [],
        "scalar",
      ],
      petro_billing_admin_create_request: [
        `SELECT public.petro_billing_admin_create_request(
          $1::uuid,$2::uuid,$3,$4::uuid,$5::uuid,$6::uuid,$7::bigint,
          $8::timestamptz,$9::timestamptz,$10,$11,$12::boolean
        ) AS result`,
        [args.p_organization_id, args.p_branch_id, args.p_request_type,
          args.p_current_subscription_id, args.p_plan_id, args.p_plan_version_id,
          args.p_requested_price_minor, args.p_starts_at, args.p_ends_at,
          args.p_coverage_note, args.p_reason, args.p_submit],
        "scalar",
      ],
      petro_billing_admin_review_request: [
        "SELECT public.petro_billing_admin_review_request($1::uuid,$2,$3) AS result",
        [args.p_request_id, args.p_decision, args.p_reason],
        "scalar",
      ],
      petro_billing_admin_create_plan_v2: [
        `SELECT public.petro_billing_admin_create_plan_v2(
          $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::jsonb, $11::jsonb, $12
        ) AS result`,
        [args.p_code, args.p_audience, args.p_name, args.p_description, args.p_price_minor,
          args.p_billing_unit, args.p_billing_cycle, args.p_currency, args.p_effective_at,
          JSON.stringify(args.p_entitlements), JSON.stringify(args.p_settings), args.p_reason],
        "scalar",
      ],
      petro_billing_admin_add_plan_version_v2: [
        `SELECT public.petro_billing_admin_add_plan_version_v2(
          $1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb, $10::jsonb, $11
        ) AS result`,
        [args.p_plan_id, args.p_display_name, args.p_description, args.p_price_minor,
          args.p_billing_unit, args.p_billing_cycle, args.p_currency, args.p_effective_at,
          JSON.stringify(args.p_entitlements), JSON.stringify(args.p_settings), args.p_reason],
        "scalar",
      ],
      petro_billing_admin_update_draft_version: [
        `SELECT public.petro_billing_admin_update_draft_version(
          $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::timestamptz,
          $10::jsonb, $11::jsonb, $12
        ) AS result`,
        [args.p_plan_id, args.p_version_id, args.p_display_name, args.p_description,
          args.p_price_minor, args.p_billing_unit, args.p_billing_cycle, args.p_currency,
          args.p_effective_at, JSON.stringify(args.p_entitlements), JSON.stringify(args.p_settings),
          args.p_reason],
        "scalar",
      ],
      petro_billing_admin_update_price_defaults: [
        "SELECT public.petro_billing_admin_update_price_defaults($1::bigint[], $2, $3, $4) AS result",
        [args.p_company_prices_minor, args.p_provider_price_minor, args.p_nfc_issue_price_minor, args.p_reason],
        "scalar",
      ],
      petro_billing_admin_set_provider_price_override: [
        `SELECT public.petro_billing_admin_set_provider_price_override(
          $1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6::timestamptz,
          $7::uuid, $8
        ) AS result`,
        [args.p_organization_id, args.p_branch_id, args.p_plan_id, args.p_price_minor,
          args.p_effective_from, args.p_effective_to, args.p_supersedes_override_id, args.p_reason],
        "scalar",
      ],
      petro_billing_admin_publish_plan_version: [
        "SELECT public.petro_billing_admin_publish_plan_version($1::uuid, $2::uuid, $3) AS result",
        [args.p_plan_id, args.p_version_id, args.p_reason],
        "scalar",
      ],
      petro_billing_admin_set_plan_stop: [
        "SELECT public.petro_billing_admin_set_plan_stop($1::uuid, $2::timestamptz, $3) AS result",
        [args.p_plan_id, args.p_stop_new_at, args.p_reason],
        "scalar",
      ],
      petro_finance_admin_summary: [
        "SELECT public.petro_finance_admin_summary() AS result",
        [],
        "scalar",
      ],
      petro_finance_admin_accounts: [
        "SELECT public.petro_finance_admin_accounts($1,$2::integer,$3::integer) AS result",
        [args.p_search, args.p_page, args.p_page_size],
        "scalar",
      ],
      petro_finance_admin_reconciliation: [
        "SELECT public.petro_finance_admin_reconciliation() AS result",
        [],
        "scalar",
      ],
      petro_finance_admin_list_topups: [
        "SELECT public.petro_finance_admin_list_topups($1::text,$2::text,$3::integer,$4::integer) AS result",
        [args.p_status, args.p_search, args.p_page, args.p_page_size],
        "scalar",
      ],
      petro_finance_admin_record_receipt: [
        `SELECT public.petro_finance_admin_record_receipt(
          $1::uuid,$2::uuid,$3::uuid,$4,$5,$6::bigint,$7,$8::boolean,$9
        ) AS result`,
        [args.p_organization_id, args.p_branch_id, args.p_receiving_bank_account_id,
          args.p_payer_bank_name, args.p_bank_reference, args.p_amount_minor,
          args.p_reason, args.p_confirmed_against_bank, args.p_idempotency_key],
        "scalar",
      ],
      petro_finance_admin_receipt_detail: [
        "SELECT public.petro_finance_admin_receipt_detail($1::uuid) AS result",
        [args.p_receipt_id],
        "scalar",
      ],
      petro_finance_admin_bank_accounts: [
        "SELECT public.petro_finance_admin_bank_accounts() AS result",
        [],
        "scalar",
      ],
      petro_finance_admin_add_bank_account: [
        "SELECT public.petro_finance_admin_add_bank_account($1,$2,$3,$4,$5) AS result",
        [args.p_bank_name, args.p_display_label, args.p_account_last4,
          args.p_reason, args.p_idempotency_key],
        "scalar",
      ],
      petro_finance_admin_approve_bank_account: [
        "SELECT public.petro_finance_admin_approve_bank_account($1::uuid,$2,$3) AS result",
        [args.p_bank_account_id, args.p_reason, args.p_idempotency_key],
        "scalar",
      ],
      petro_admin_fleet_catalog: [
        "SELECT public.petro_admin_fleet_catalog($1,$2::jsonb) AS result",
        [args.p_view, JSON.stringify(args.p_filters)],
        "scalar",
      ],
      petro_admin_fleet_company_summaries: [
        "SELECT public.petro_admin_fleet_company_summaries($1::uuid,$2,$3::integer,$4::integer) AS result",
        [args.p_organization_id, args.p_query, args.p_page, args.p_page_size],
        "scalar",
      ],
      petro_admin_fleet_driver_detail: [
        "SELECT public.petro_admin_fleet_driver_detail($1::uuid) AS result",
        [args.p_driver_id],
        "scalar",
      ],
      petro_admin_fleet_stock_reservations: [
        "SELECT public.petro_admin_fleet_stock_reservations($1,$2::integer,$3::integer) AS result",
        [args.p_search, args.p_page, args.p_page_size],
        "scalar",
      ],
      petro_admin_fleet_consumption_rates: [
        "SELECT public.petro_admin_fleet_consumption_rates($1::uuid,$2::uuid) AS result",
        [args.p_organization_id, args.p_branch_id],
        "scalar",
      ],
      petro_admin_fleet_set_consumption_rate: [
        "SELECT public.petro_admin_fleet_set_consumption_rate($1::uuid,$2::uuid,$3::numeric,$4,$5) AS result",
        [args.p_organization_id, args.p_branch_id, args.p_liters_per_100km, args.p_reason, args.p_idempotency_key],
        "scalar",
      ],
      petro_admin_fleet_command: [
        "SELECT public.petro_admin_fleet_command($1,$2::jsonb,$3,$4) AS result",
        [args.p_action, JSON.stringify(args.p_payload), args.p_reason, args.p_idempotency_key],
        "scalar",
      ],
      petro_admin_fleet_verify_driver_pair: [
        "SELECT public.petro_admin_fleet_verify_driver_pair($1::uuid,$2) AS result",
        [args.p_link_id, args.p_pin_hmac],
        "scalar",
      ],
      petro_admin_fleet_pair_pin_reveal: [
        "SELECT public.petro_admin_fleet_pair_pin_reveal($1::uuid,$2) AS result",
        [args.p_link_id, args.p_reason],
        "scalar",
      ],
      petro_fleet_create_vehicle_document_upload: [
        "SELECT public.petro_fleet_create_vehicle_document_upload($1::uuid,$2,$3,$4,$5::bigint,$6::date) AS result",
        [args.p_vehicle_id,args.p_document_type,args.p_file_name,args.p_content_type,args.p_byte_size,args.p_expires_on],
        "scalar",
      ],
      petro_complete_document_upload: [
        "SELECT public.petro_complete_document_upload($1::uuid,$2)",
        [args.p_document_id,args.p_sha256],
        "void",
      ],
      petro_fail_document_upload: [
        "SELECT public.petro_fail_document_upload($1::uuid)",
        [args.p_document_id],
        "void",
      ],
      petro_admin_fleet_cards_catalog: [
        "SELECT public.petro_admin_fleet_cards_catalog($1,$2::jsonb) AS result",
        [args.p_view, JSON.stringify(args.p_filters)],
        "scalar",
      ],
      petro_admin_fleet_card_history: [
        "SELECT public.petro_admin_fleet_card_history($1::jsonb) AS result",
        [JSON.stringify(args.p_filters)],
        "scalar",
      ],
      petro_catalog_reference_data: [
        "SELECT public.petro_catalog_reference_data() AS result",
        [],
        "scalar",
      ],
      petro_catalog_admin_categories: [
        "SELECT public.petro_catalog_admin_categories() AS result",
        [],
        "scalar",
      ],
      petro_catalog_admin_organizations: [
        "SELECT public.petro_catalog_admin_organizations($1,$2,$3::integer,$4::integer) AS result",
        [args.p_search,args.p_kind,args.p_page,args.p_page_size],
        "scalar",
      ],
      petro_catalog_admin_fuel_list: [
        "SELECT public.petro_catalog_admin_fuel_list($1,$2::integer,$3::integer) AS result",
        [args.p_search,args.p_page,args.p_page_size],
        "scalar",
      ],
      petro_catalog_list_items: [
        "SELECT public.petro_catalog_list_items($1::uuid,$2::uuid,$3,$4,$5,$6,$7::integer,$8::integer) AS result",
        [args.p_organization_id,args.p_branch_id,args.p_category_code,args.p_item_kind,
          args.p_status,args.p_search,args.p_page,args.p_page_size],
        "scalar",
      ],
      petro_catalog_item_detail: [
        "SELECT public.petro_catalog_item_detail($1::uuid) AS result",
        [args.p_item_id],
        "scalar",
      ],
      petro_catalog_fuel_preview: [
        "SELECT public.petro_catalog_fuel_preview($1::uuid,$2::numeric,$3::bigint) AS result",
        [args.p_fuel_type_id,args.p_quantity,args.p_amount_minor],
        "scalar",
      ],
      petro_catalog_command: [
        "SELECT public.petro_catalog_command($1,$2::jsonb,$3,$4) AS result",
        [args.p_action,JSON.stringify(args.p_payload),args.p_reason,args.p_idempotency_key],
        "scalar",
      ],
      petro_inventory_admin_query: [
        "SELECT public.petro_inventory_admin_query($1,$2::jsonb) AS result",
        [args.p_action, JSON.stringify(args.p_payload ?? {})],
        "scalar",
      ],
      petro_inventory_admin_command: [
        "SELECT public.petro_inventory_admin_command($1,$2::jsonb,$3) AS result",
        [args.p_action, JSON.stringify(args.p_payload), args.p_idempotency_key],
        "scalar",
      ],
    };
    const selected = queries[functionName];
    if (!selected) return jsonResponse({ message: "Unknown test RPC" }, 404);
    if (simulatePre0008 && functionName.startsWith("petro_admin_")) {
      return jsonResponse(
        {
          code: "PGRST202",
          message: "Could not find public.petro_admin_list_platform_users in the pre-migration schema.",
        },
        404,
      );
    }
    try {
      const result = await withActor(actorId, selected[0], selected[1]);
      if (selected[2] === "void") return new Response(null, { status: 204 });
      return jsonResponse(selected[2] === "rows" ? result.rows : result.rows[0]?.result ?? null);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "XX000";
      return jsonResponse({ code, message: String(error?.message ?? "DB error") }, errorStatus(code));
    }
  }

  return jsonResponse({ message: "Unexpected local Supabase request" }, 404);
}

globalThis.fetch = mockSupabaseFetch;

function authCookie(actorId) {
  const now = Math.floor(Date.now() / 1000);
  const tokenPayload = Buffer.from(
    JSON.stringify({
      sub: actorId,
      aud: "authenticated",
      role: "authenticated",
      exp: now + 3600,
    }),
  ).toString("base64url");
  const token = `eyJhbGciOiJub25lIn0.${tokenPayload}.local-test`;
  const session = {
    access_token: token,
    refresh_token: "local-test",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: now + 3600,
    user: { id: actorId, aud: "authenticated", role: "authenticated" },
  };
  const value = Buffer.from(JSON.stringify(session)).toString("base64url");
  return { cookie: `sb-${projectRef}-auth-token=base64-${value}`, token };
}

function request(port, path, { actorId, method = "GET", body, rawBody, headers:extraHeaders={} } = {}) {
  const bodyText = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  const auth = actorId ? authCookie(actorId) : null;
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          origin: `http://127.0.0.1:${port}`,
          referer: `http://127.0.0.1:${port}/admin/platform-users`,
          ...(auth ? { cookie: auth.cookie } : {}),
          ...(bodyText
            ? {
                "content-type": rawBody ? "application/octet-stream" : "application/json",
                "content-length": Buffer.byteLength(bodyText),
                ...extraHeaders,
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            rejectRequest(new Error(`API returned non-JSON response for ${method} ${path} (${res.statusCode}): ${text.slice(0, 300)}`));
            return;
          }
          resolveRequest({ status: res.statusCode, body: json });
        });
      },
    );
    req.on("error", rejectRequest);
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

async function seedFixtures() {
  const client = new Client({
    host: process.env["PGHOST"],
    port: Number(process.env["PGPORT"]),
    database: process.env["PGDATABASE"],
    user: process.env["PGUSER"],
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at)
       VALUES
         ($1::uuid, 'api-admin@example.invalid', '{"username":"api_admin","display_name":"API Admin"}', now()),
         ($2::uuid, 'api-target@example.invalid', '{"username":"api_target","display_name":"API Target"}', now()),
         ($3::uuid, 'api-operations@example.invalid', '{"username":"api_operations","display_name":"API Operations"}', now()),
         ($4::uuid, 'api-finance@example.invalid', '{"username":"api_finance","display_name":"API Finance"}', now()),
         ($5::uuid, 'api-auditor@example.invalid', '{"username":"api_auditor","display_name":"API Auditor"}', now()),
          ($6::uuid, 'api-support@example.invalid', '{"username":"api_support","display_name":"API Support"}', now()),
          ($7::uuid, 'api-catalog-manager@example.invalid', '{"username":"api_catalog_manager","display_name":"مسؤول كتالوج اختبار"}', now())`,
      [...actorIds],
    );
    await client.query(
      `UPDATE public.petro_profiles
       SET active = true, account_status = 'active', login_identifier_type = 'username'
       WHERE user_id = ANY($1::uuid[])`,
      [[...actorIds]],
    );
    await client.query(
      `INSERT INTO public.petro_platform_roles (user_id, role, active)
       VALUES ($1::uuid, 'owner', true), ($2::uuid, 'operations', true),
              ($3::uuid, 'finance', true), ($4::uuid, 'auditor', true),
              ($5::uuid, 'support', true)`,
      [[...actorIds][0], [...actorIds][2], [...actorIds][3], [...actorIds][4], [...actorIds][5]],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

await seedFixtures();
const ownerIdForBilling = [...actorIds][0];
const providerOrganizationId = (
  await withActor(
    ownerIdForBilling,
    `SELECT public.petro_create_organization_details(
      $1, 'provider', $2, NULL, $3, $4, $5, $6
    ) AS result`,
    ["API Billing Provider", "API-BILLING-PROVIDER", "API Billing Contact",
      "+201000000601", "api-billing@example.invalid", "Isolated test address"],
  )
).rows[0].result;
const providerBranchId = (
  await withActor(
    ownerIdForBilling,
    `SELECT public.petro_create_branch_details(
      $1::uuid, $2, $3, $4, $5, NULL, NULL, '{}'::jsonb, $6, $7
    ) AS result`,
    [providerOrganizationId, "API-BILLING-BRANCH", "API Billing Branch",
      "Isolated test address", "Cairo", "API Billing Contact", "+201000000602"],
  )
).rows[0].result;
await withActor(ownerIdForBilling, "SELECT public.petro_approve_organization($1::uuid,1,$2) AS result", [
  providerOrganizationId, "اعتماد مقدم اختبار API",
]);
await withActor(ownerIdForBilling, "SELECT public.petro_set_organization_operational_status($1::uuid,2,'active',$2) AS result", [
  providerOrganizationId, "تفعيل مقدم اختبار API",
]);
await withActor(ownerIdForBilling, "SELECT public.petro_approve_branch($1::uuid,$2::uuid,1,$3) AS result", [
  providerOrganizationId, providerBranchId, "اعتماد فرع اختبار API",
]);
await withActor(ownerIdForBilling, "SELECT public.petro_set_branch_operational_status($1::uuid,$2::uuid,2,'active',$3) AS result", [
  providerOrganizationId, providerBranchId, "تفعيل فرع اختبار API",
]);
const fleetCompanyId = (
  await withActor(
    ownerIdForBilling,
    `SELECT public.petro_create_organization_details(
      $1, 'company', $2, NULL, $3, $4, $5, $6
    ) AS result`,
    ["API Fleet Company", "API-FLEET-COMPANY", "API Fleet Contact",
      "+201000000603", "api-fleet@example.invalid", "Isolated test address"],
  )
).rows[0].result;
await withActor(ownerIdForBilling, "SELECT public.petro_approve_organization($1::uuid,1,$2) AS result", [
  fleetCompanyId, "اعتماد شركة أسطول API معزولة",
]);
await withActor(ownerIdForBilling, "SELECT public.petro_set_organization_operational_status($1::uuid,2,'active',$2) AS result", [
  fleetCompanyId, "تفعيل شركة أسطول API معزولة",
]);
const fleetBranchId = (
  await withActor(
    ownerIdForBilling,
    `SELECT public.petro_create_branch_details(
      $1::uuid,$2,$3,$4,$5,NULL,NULL,'{}'::jsonb,$6,$7
    ) AS result`,
    [fleetCompanyId, "API-FLEET-BRANCH", "فرع أسطول API", "عنوان اختبار",
      "القاهرة", "مسؤول الفرع", "+201000000604"],
  )
).rows[0].result;
await withActor(ownerIdForBilling, "SELECT public.petro_approve_branch($1::uuid,$2::uuid,1,$3) AS result", [
  fleetCompanyId, fleetBranchId, "اعتماد فرع أسطول API معزول",
]);
await withActor(ownerIdForBilling, "SELECT public.petro_set_branch_operational_status($1::uuid,$2::uuid,2,'active',$3) AS result", [
  fleetCompanyId, fleetBranchId, "تفعيل فرع أسطول API معزول",
]);
{
  const fixtureClient = new Client({
    host: process.env["PGHOST"],
    port: Number(process.env["PGPORT"]),
    database: process.env["PGDATABASE"],
    user: process.env["PGUSER"],
  });
  await fixtureClient.connect();
  try {
    await fixtureClient.query("BEGIN");
    const [, targetUserId] = [...actorIds];
    const companyMembership = await fixtureClient.query(
      `INSERT INTO public.petro_memberships(user_id,organization_id,role,scope,active)
       VALUES ($1::uuid,$2::uuid,'manager','branches',true) RETURNING id`,
      [targetUserId, fleetCompanyId],
    );
    await fixtureClient.query(
      `INSERT INTO public.petro_membership_branches(organization_id,membership_id,branch_id)
       VALUES ($1::uuid,$2::uuid,$3::uuid)`,
      [fleetCompanyId, companyMembership.rows[0].id, fleetBranchId],
    );
    await fixtureClient.query(
      `INSERT INTO public.petro_memberships(user_id,organization_id,role,scope,active)
       VALUES ($1::uuid,$2::uuid,'viewer','organization',true)`,
      [targetUserId, providerOrganizationId],
    );
    await fixtureClient.query(
      `INSERT INTO public.petro_memberships(user_id,organization_id,role,scope,active)
       VALUES ($1::uuid,$2::uuid,'manager','organization',true)`,
      [[...actorIds][6], providerOrganizationId],
    );
    await fixtureClient.query(
      "SELECT petro_private.finance_account_for_scope($1::uuid,NULL::uuid)",
      [fleetCompanyId],
    );
    await fixtureClient.query(
      "SELECT petro_private.finance_account_for_scope($1::uuid,$2::uuid)",
      [fleetCompanyId, fleetBranchId],
    );
    await fixtureClient.query("COMMIT");
  } catch (error) {
    await fixtureClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await fixtureClient.end();
  }
}
const apiFleetDriver = (
  await withActor(
    ownerIdForBilling,
    `SELECT public.petro_admin_fleet_command(
      'driver.create',$1::jsonb,$2,$3
    ) AS result`,
    [
      JSON.stringify({
        organizationId: fleetCompanyId,
        driverCode: "API-FLEET-DRIVER",
        fullName: "سائق اختبار API",
        phone: "+201000000605",
      }),
      "إنشاء سائق اختبار API معزول",
      "api-fleet-driver-create-001",
    ],
  )
).rows[0].result;
const apiFleetVehicle = (
  await withActor(
    ownerIdForBilling,
    `SELECT public.petro_admin_fleet_command(
      'vehicle.create',$1::jsonb,$2,$3
    ) AS result`,
    [
      JSON.stringify({
        organizationId: fleetCompanyId,
        branchId: fleetBranchId,
        plateOriginal: "API-FLEET-1",
        plateStandard: "APIFLEET1",
        category: "sedan",
        vehicleType: "car",
        brand: "Test",
        model: "API",
        fuelType: "petrol",
        internalCode: "API-FLEET-VEHICLE-1",
      }),
      "إنشاء مركبة اختبار API معزولة",
      "api-fleet-vehicle-create-001",
    ],
  )
).rows[0].result;
const app = express();
app.use(cookieParser());
app.use(express.json({ limit: "32kb" }));
app.get(/^\/__local-test-storage\/([^/]+)\/(.+)$/, (req, res) => {
  const requestUrl = new URL(req.originalUrl, "http://local.test");
  const match = requestUrl.pathname.match(/^\/__local-test-storage\/([^/]+)\/(.+)$/);
  if (!match || requestUrl.searchParams.get("token") !== isolatedStorageToken) {
    res.status(403).end();
    return;
  }
  const bucket = decodeURIComponent(match[1]);
  const key = match[2].split("/").map(decodeURIComponent).join("/");
  const object = isolatedStorageObjects.get(`${bucket}/${key}`);
  if (!object || bucket !== "petro-private-documents") {
    res.status(404).end();
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", object.contentType);
  res.end(object.bytes);
});
app.use((req,res,next)=>{
  const sendJson=res.json.bind(res);
  res.json=(body)=>{
    // Drop only the successful RESPONSE after the disposable database committed.
    // This verifies browser retries against the real receipt, not a mocked order.
    if(req.method==="POST"&&res.statusCode===200&&(body?.id||body?.paid===true&&body?.orderId)&&(
      failNextOrderReserveResponse&&req.originalUrl==="/api/operations/service-orders"
      ||failNextOrderCancelResponse&&/^\/api\/operations\/service-orders\/[^/]+\/cancel$/.test(req.originalUrl)
      ||failNextConfirmationResponse&&/^\/api\/operations\/service-orders\/[^/]+\/confirm$/.test(req.originalUrl)
      ||failNextDeliveryResponse&&/^\/api\/operations\/service-orders\/[^/]+\/deliver$/.test(req.originalUrl))){
      if(req.originalUrl.endsWith("/confirm"))failNextConfirmationResponse=false;else if(req.originalUrl.endsWith("/deliver"))failNextDeliveryResponse=false;else if(req.originalUrl.endsWith("/cancel"))failNextOrderCancelResponse=false;else failNextOrderReserveResponse=false;
      res.status(503);return sendJson({message:"انقطع تأكيد الاستجابة بعد الحفظ؛ أعد المحاولة بالمرجع نفسه."});
    }
    return sendJson(body);
  };
  next();
});
app.use(["/api/documents/:documentId/download","/api/operations/service-order-evidence/:id/download"], (req, res, next) => {
  const sendJson = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body.url === "string") {
      try {
        const signed = new URL(body.url);
        const prefix = "/storage/v1/object/sign/";
        if (signed.origin === approvedOrigin && signed.pathname.startsWith(prefix)) {
          const parts = signed.pathname.slice(prefix.length).split("/");
          const bucket = decodeURIComponent(parts.shift() ?? "");
          const key = parts.map(decodeURIComponent).join("/");
          if (bucket === "petro-private-documents" && key) {
            body = {
              ...body,
              url: `${isolatedStorageBaseUrl}/__local-test-storage/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}?token=${isolatedStorageToken}`,
            };
          }
        }
      } catch {
        // Keep the actual route response intact if the synthetic URL is malformed.
      }
    }
    return sendJson(body);
  };
  next();
});
app.use("/api", authRouter);
app.use("/api", managementRouter);
app.use("/api", billingRouter);
app.use("/api", financeRouter);
app.use("/api", fleetRouter);
app.use("/api", workforceRouter);
app.use("/api", serviceOrdersRouter);
app.use("/api", catalogRouter);
app.use("/api", inventoryRouter);
app.use("/api", organizationWorkflowsRouter);
const server = app.listen(0, "127.0.0.1");

try {
  await new Promise((resolveListen, rejectListen) => {
    server.once("listening", resolveListen);
    server.once("error", rejectListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  isolatedStorageBaseUrl = `http://127.0.0.1:${port}`;
  const [ownerId, targetId, operationsId] = [...actorIds];
  const [, , , financeId, auditorId, supportId] = [...actorIds];
  const catalogManagerId = [...actorIds][6];

  const preMigration = await request(port, "/api/admin/platform-users", {
    actorId: ownerId,
  });
  assert.equal(
    preMigration.status,
    503,
    "pre-0008 callers should receive a clear staged-feature response",
  );
  simulatePre0008 = false;

  const catalogDirectory = await request(port, "/api/admin/catalog/organizations?search=API&page=1&pageSize=20", {
    actorId: ownerId,
  });
  assert.equal(catalogDirectory.status, 200, "owner should read the central merchant directory through the actual API");
  assert.ok(catalogDirectory.body.items.some((item) => item.id === providerOrganizationId),
    "central directory should include the isolated provider with its stable organization id");
  const adminCategories = await request(port, "/api/admin/catalog/categories", { actorId: ownerId });
  assert.equal(adminCategories.status, 200, "authorized owner should read the central category and unit reference");
  const adminWash = adminCategories.body.categories.find((item) => item.code === "wash");
  assert.equal(adminWash?.nameAr, "الغسيل", "the real 0017 SQL payload should retain its Arabic category name through API mapping");
  assert.equal(adminWash?.serviceGroup, "wash", "the API contract should expose the category group in camelCase");
  assert.ok(adminWash?.allowedItemKinds.includes("service"), "allowed item kinds should survive the SQL-to-API mapping");
  const adminLitre = adminCategories.body.units.find((item) => item.code === "litre");
  assert.equal(adminLitre?.nameAr, "لتر", "the real 0017 SQL payload should retain its Arabic unit name through API mapping");
  assert.equal(adminLitre?.quantityScale, 3, "the API should preserve the reference unit's decimal scale");
  const catalogFuel = await request(port, "/api/admin/catalog/fuel?page=1&pageSize=20", { actorId: ownerId });
  assert.equal(catalogFuel.status, 200, "owner should read configured fuel types and reference-price history");
  assert.ok(catalogFuel.body.items.some((item) => item.code === "gasoline_92"),
    "fuel endpoint should return the configured 92-octane type");
  const gasoline92 = catalogFuel.body.items.find((item) => item.code === "gasoline_92");
  assert.equal(gasoline92?.unitCode, "litre", "the seeded liquid fuel should use the approved litre unit");
  assert.equal(gasoline92?.currentPrice, null, "the database must not seed an unapproved live reference price");
  const badFuelUnit = await request(port, "/api/catalog/commands", {
    actorId: ownerId, method: "POST", body: {
      action: "fuel.type.create",
      payload: { code: "api_bad_fuel_unit", nameAr: "وقود بوحدة غير متوافقة", vehicleFuelFamily: "gasoline", unitCode: "piece" },
      reason: "اختبار وحدة وقود غير صالحة",
      idempotencyKey: "api-fuel-piece-unit-rejected-001",
    },
  });
  assert.equal(badFuelUnit.status, 400, "the API must reject gasoline defined with a piece unit before calling the database");
  const unmappedFuelFamily = await request(port, "/api/catalog/commands", {
    actorId: ownerId, method: "POST", body: {
      action: "fuel.type.create",
      payload: { code: "api_unmapped_fuel", nameAr: "نوع وقود غير مضبوط", vehicleFuelFamily: "natural_gas", unitCode: "litre" },
      reason: "اختبار منع تخمين الوحدة",
      idempotencyKey: "api-unmapped-fuel-family-rejected-01",
    },
  });
  assert.equal(unmappedFuelFamily.status, 400, "unsupported fuel family/unit pairs must be explicitly configured rather than guessed");
  const catalogReference = await request(port, "/api/catalog/reference-data", { actorId: targetId });
  assert.equal(catalogReference.status, 200, "an authenticated merchant user should receive active catalog reference data");
  const washCategory = catalogReference.body.categories.find((item) => item.code === "wash");
  assert.ok(washCategory?.id, "wash category should be selected from API-provided reference data");
  const itemCommand = {
    action: "item.create",
    payload: {
      organizationId: providerOrganizationId,
      categoryId: washCategory.id,
      kind: "service",
      name: "خدمة غسيل اختبار API",
      description: "سجل اصطناعي في PostgreSQL المحلي فقط",
      internalCode: "API-CATALOG-WASH-1",
      unitCode: "service",
      attributes: { washMode: "exterior", vehicleType: "سيارة اختبار", vehicleSize: "متوسطة",
        vehicleTypes: ["نوع اختبار"], durationMinutes: 20, included: "اختبار محلي", addOns: ["تلميع اختباري"] },
    },
    idempotencyKey: "catalog-api-item-create-0001",
  };
  const itemCreated = await request(port, "/api/catalog/commands", {
    actorId: catalogManagerId, method: "POST", body: itemCommand,
  });
  assert.equal(itemCreated.status, 200, "authorized catalog command should reach the actual PostgreSQL RPC");
  assert.equal(itemCreated.body.status, "draft", "new merchant item must remain a draft");
  const itemReplay = await request(port, "/api/catalog/commands", {
    actorId: catalogManagerId, method: "POST", body: itemCommand,
  });
  assert.equal(itemReplay.status, 200, "same API command should replay its original result");
  assert.equal(itemReplay.body.id, itemCreated.body.id, "same idempotency key must not create another item");
  assert.equal(itemReplay.body.replayed, true, "replayed API command should be explicitly marked");
  const oilsCategory = catalogReference.body.categories.find((item) => item.code === "oils");
  assert.ok(oilsCategory?.id, "oil category should be available for isolated stock integration");
  const inventoryProduct = await request(port, "/api/catalog/commands", {
    actorId: catalogManagerId, method: "POST", body: {
      action: "item.create",
      payload: {
        organizationId: providerOrganizationId, categoryId: oilsCategory.id, kind: "product",
        name: "زيت مخزون اختبار API", description: "بيانات اصطناعية لقاعدة PostgreSQL المحلية",
        internalCode: "API-INVENTORY-OIL-1", unitCode: "litre", attributes: {},
      },
      reason: "إنشاء صنف مخزون للاختبار المعزول",
      idempotencyKey: "inventory-api-product-create-001",
    },
  });
  assert.equal(inventoryProduct.status, 200, "merchant manager should create the stock product through the real catalog RPC");
  assert.equal(inventoryProduct.body.status, "draft");
  const productReview = await request(port, "/api/catalog/commands", {
    actorId: ownerId, method: "POST", body: {
      action: "item.review",
      payload: { itemId: inventoryProduct.body.id, expectedVersion: 1, reviewStatus: "approved" },
      reason: "اعتماد صنف اصطناعي لاختبار المخزون المحلي",
      idempotencyKey: "inventory-api-product-review-001",
    },
  });
  assert.equal(productReview.status, 200, "authorized central reviewer should approve the synthetic stock product");
  const activationWithoutReason = await request(port, "/api/catalog/commands", {
    actorId: catalogManagerId, method: "POST", body: {
      action: "item.status",
      payload: { itemId: inventoryProduct.body.id, expectedVersion: 2, status: "active" },
      idempotencyKey: "inventory-api-product-activate-missing-reason",
    },
  });
  assert.equal(activationWithoutReason.status, 400, "status changes must still require an explicit reason");
  const productActivation = await request(port, "/api/catalog/commands", {
    actorId: catalogManagerId, method: "POST", body: {
      action: "item.status",
      payload: { itemId: inventoryProduct.body.id, expectedVersion: 2, status: "active" },
      reason: "تفعيل صنف اصطناعي لاختبار المخزون المحلي",
      idempotencyKey: "inventory-api-product-activate-001",
    },
  });
  assert.equal(productActivation.status, 200, "merchant owner should activate its approved stock product through the real catalog RPC");
  const itemList = await request(port,
    `/api/admin/catalog/items?organizationId=${encodeURIComponent(providerOrganizationId)}&page=1&pageSize=20`,
    { actorId: ownerId });
  assert.equal(itemList.status, 200, "owner should read the organization-scoped merchant item list");
  assert.ok(itemList.body.items.some((item) => item.id === itemCreated.body.id),
    "organization item query should return only through the server's authorized scope");
  const viewerItems = await request(port,
    `/api/admin/catalog/items?organizationId=${encodeURIComponent(providerOrganizationId)}&page=1&pageSize=20`,
    { actorId: targetId });
  assert.equal(viewerItems.status, 200, "merchant viewer may read the provider's own catalog");
  assert.ok(viewerItems.body.items.some((item) => item.id === itemCreated.body.id),
    "authorized merchant read should show the saved item");
  const companyCatalog = await request(port,
    `/api/admin/catalog/items?organizationId=${encodeURIComponent(fleetCompanyId)}&page=1&pageSize=20`,
    { actorId: targetId });
  assert.equal(companyCatalog.status, 404, "company consumer must not read merchant catalogs");
  const outsiderWrite = await request(port, "/api/catalog/commands", {
    actorId: targetId, method: "POST", body: {
      ...itemCommand,
      idempotencyKey: "catalog-api-viewer-write-0001",
      payload: { ...itemCommand.payload, name: "محاولة كتابة غير مخولة" },
    },
  });
  assert.equal(outsiderWrite.status, 403, "merchant viewer must not mutate catalog data");
  const centralMerchantWrite = await request(port, "/api/catalog/commands", {
    actorId: ownerId, method: "POST", body: {
      ...itemCommand,
      idempotencyKey: "catalog-api-central-write-0001",
      payload: { ...itemCommand.payload, name: "محاولة تعديل مركزي دون تفويض" },
    },
  });
  assert.equal(centralMerchantWrite.status, 403,
    "central administrator without a merchant membership/delegation must not edit merchant-owned catalogs");
  const financeWrite = await request(port, "/api/catalog/commands", {
    actorId: financeId, method: "POST", body: {
      action: "fuel.type.create",
      payload: { code: "finance_prohibited_fuel", nameAr: "وقود غير مخول", vehicleFuelFamily: "other", unitCode: "litre" },
      reason: "اختبار منع تحرير المالية",
      idempotencyKey: "catalog-api-finance-write-001",
    },
  });
  assert.equal(financeWrite.status, 403, "finance read access must not grant fuel-catalog write permission");
  const missingFuelPrice = await request(port, "/api/admin/catalog/fuel/preview", {
    actorId: ownerId,
    method: "POST",
    body: { fuelTypeId: catalogFuel.body.items.find((item) => item.code === "gasoline_92").id, quantity: 2 },
  });
  assert.equal(missingFuelPrice.status, 200, "fuel calculator should return an explicit unavailable result without a price");
  assert.equal(missingFuelPrice.body.available, false, "no reference price must not be represented as zero");

  const inventoryAnonymous = await request(port, "/api/admin/inventory?view=organizations&page=1&pageSize=20");
  inventoryEqual(inventoryAnonymous.status, 401, "inventory directory must require an authenticated session");
  const inventoryOutsider = await request(
    port,
    `/api/admin/inventory?view=items&organizationId=${providerOrganizationId}&page=1&pageSize=20`,
    { actorId: supportId },
  );
  inventoryEqual(inventoryOutsider.status, 403, "an unrelated support account must not read a provider's stock catalog");
  const inventoryProductList = await request(
    port,
    `/api/admin/inventory?view=items&organizationId=${providerOrganizationId}&page=1&pageSize=20`,
    { actorId: catalogManagerId },
  );
  inventoryEqual(inventoryProductList.status, 200, "authorized merchant manager should read products from the real catalog query");
  inventoryOk(
    inventoryProductList.body.items.some((item) => item.itemId === inventoryProduct.body.id && item.name === "زيت مخزون اختبار API"),
    "inventory item view should return the actual approved product through the HTTP/RPC path",
  );
  const inventoryLocation = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "location.create",
      payload: {
        organizationId: providerOrganizationId,
        branchId: providerBranchId,
        name: "مخزن اختبار معزول",
        kind: "sellable",
        reason: "موقع اختباري لقياس صلاحيات المخزون",
      },
      idempotencyKey: "inventory-api-location-create-001",
    },
  });
  inventoryEqual(inventoryLocation.status, 201, "authorized central administrator should create a stock location via the live API route");
  inventoryEqual(inventoryLocation.body.status, "active");
  const locationReplay = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "location.create",
      payload: {
        organizationId: providerOrganizationId,
        branchId: providerBranchId,
        name: "مخزن اختبار معزول",
        kind: "sellable",
        reason: "موقع اختباري لقياس صلاحيات المخزون",
      },
      idempotencyKey: "inventory-api-location-create-001",
    },
  });
  inventoryEqual(locationReplay.status, 201, "same location request key should return the original created result");
  inventoryEqual(locationReplay.body.id, inventoryLocation.body.id);
  const concurrentLocationPayload = {
    organizationId: providerOrganizationId,
    branchId: providerBranchId,
    name: "مخزن تكرار متزامن",
    kind: "sellable",
    reason: "التحقق من تكرار الإنشاء المتزامن",
  };
  const concurrentLocationRequests = await Promise.all([
    request(port, "/api/admin/inventory", {
      actorId: ownerId,
      method: "POST",
      body: { action: "location.create", payload: concurrentLocationPayload, idempotencyKey: "inventory-api-location-race-001" },
    }),
    request(port, "/api/admin/inventory", {
      actorId: ownerId,
      method: "POST",
      body: { action: "location.create", payload: concurrentLocationPayload, idempotencyKey: "inventory-api-location-race-001" },
    }),
  ]);
  inventoryEqual(concurrentLocationRequests[0].status, 201);
  inventoryEqual(concurrentLocationRequests[1].status, 201);
  inventoryEqual(concurrentLocationRequests[0].body.id, concurrentLocationRequests[1].body.id,
    "concurrent retries with one key must resolve to one created location");
  const conflictingLocationReplay = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "location.create",
      payload: {
        organizationId: providerOrganizationId,
        branchId: providerBranchId,
        name: "اسم مختلف بنفس المفتاح",
        kind: "sellable",
        reason: "محاولة إعادة استخدام مفتاح مختلف",
      },
      idempotencyKey: "inventory-api-location-create-001",
    },
  });
  inventoryEqual(conflictingLocationReplay.status, 409, "same idempotency key with a changed payload must be rejected");
  const inventoryLocationList = await request(
    port,
    `/api/admin/inventory?view=locations&organizationId=${providerOrganizationId}&page=1&pageSize=20`,
    { actorId: ownerId },
  );
  inventoryEqual(inventoryLocationList.status, 200);
  inventoryOk(inventoryLocationList.body.items.some((item) => item.id === inventoryLocation.body.id));
  const inventoryBranches = await request(
    port,
    `/api/admin/inventory?view=branches&organizationId=${providerOrganizationId}&page=1&pageSize=20`,
    { actorId: catalogManagerId },
  );
  inventoryEqual(inventoryBranches.status, 200, "merchant manager should read only the scoped branch choices");
  inventoryOk(inventoryBranches.body.items.some((item) => item.id === providerBranchId));
  const stockReceiptPayload = {
    organizationId: providerOrganizationId,
    sourceLocationId: inventoryLocation.body.id,
    type: "receipt",
    reason: "استلام زيت اصطناعي للمخزن المحلي",
    lines: [{ itemId: inventoryProduct.body.id, quantity: "3.125" }],
  };
  const stockReceipt = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: { action: "document.create", payload: stockReceiptPayload, idempotencyKey: "inventory-api-receipt-001" },
  });
  inventoryEqual(stockReceipt.status, 201, "authorized receipt should create a pending document through the actual inventory RPC");
  inventoryEqual(stockReceipt.body.status, "pending", "receiving stock must await an authorized review");
  const pendingBalances = await request(
    port,
    `/api/admin/inventory?view=balances&locationId=${inventoryLocation.body.id}&page=1&pageSize=20`,
    { actorId: ownerId },
  );
  inventoryEqual(pendingBalances.status, 200);
  inventoryEqual(pendingBalances.body.total, 0, "pending receipt must not change on-hand stock");
  const receiptReviewPayload = {
    documentId: stockReceipt.body.id,
    decision: "approve",
    reason: "مطابقة استلام اصطناعي في البيئة المحلية",
  };
  const receiptApproval = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: { action: "document.review", payload: receiptReviewPayload, idempotencyKey: "inventory-api-receipt-review-001" },
  });
  inventoryEqual(receiptApproval.status, 200, "authorized reviewer should post the receipt atomically");
  inventoryEqual(receiptApproval.body.status, "approved");
  const approvedBalances = await request(
    port,
    `/api/admin/inventory?view=balances&locationId=${inventoryLocation.body.id}&page=1&pageSize=20&search=${encodeURIComponent("زيت مخزون")}`,
    { actorId: ownerId },
  );
  inventoryEqual(approvedBalances.status, 200);
  inventoryEqual(approvedBalances.body.items.length, 1, "approved stock should appear in the paginated balance list");
  inventoryEqual(approvedBalances.body.items[0].onHand, "3.125000", "API should preserve exact numeric quantity as decimal text");
  inventoryEqual(Number(approvedBalances.body.items[0].onHand), 3.125, "quantity precision should preserve three decimal places");
  inventoryEqual(Number(approvedBalances.body.items[0].available), 3.125);
  const receiptReplay = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: { action: "document.create", payload: stockReceiptPayload, idempotencyKey: "inventory-api-receipt-001" },
  });
  inventoryEqual(receiptReplay.status, 201);
  inventoryEqual(receiptReplay.body.id, stockReceipt.body.id, "retry after commit should return the original receipt");
  const conflictingReceiptReplay = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "document.create",
      payload: { ...stockReceiptPayload, lines: [{ itemId: inventoryProduct.body.id, quantity: "3.124" }] },
      idempotencyKey: "inventory-api-receipt-001",
    },
  });
  inventoryEqual(conflictingReceiptReplay.status, 409, "changed receipt payload must not reuse the committed request key");
  const invalidItemReceipt = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "document.create",
      payload: { ...stockReceiptPayload, lines: [{ itemId: "00000000-0000-4000-8000-000000008999", quantity: "1" }] },
      idempotencyKey: "inventory-api-invalid-product-001",
    },
  });
  inventoryEqual(invalidItemReceipt.status, 400, "invalid product must fail before a document can commit");
  const stockDocuments = await request(
    port,
    `/api/admin/inventory?view=documents&locationId=${inventoryLocation.body.id}&page=1&pageSize=20`,
    { actorId: ownerId },
  );
  inventoryEqual(stockDocuments.status, 200);
  inventoryOk(stockDocuments.body.items.some((item) => item.id === stockReceipt.body.id
    && item.sourceLocationName === "مخزن اختبار معزول" && item.status === "approved"));
  inventoryEqual(stockDocuments.body.total, 1, "a failed document command must leave no partial document or line");
  const stockDocumentDetail = await request(
    port,
    `/api/admin/inventory?view=document&documentId=${stockReceipt.body.id}`,
    { actorId: ownerId },
  );
  inventoryEqual(stockDocumentDetail.status, 200);
  inventoryEqual(stockDocumentDetail.body.document.id, stockReceipt.body.id);
  inventoryEqual(stockDocumentDetail.body.lines[0].itemName, "زيت مخزون اختبار API");
  inventoryEqual(stockDocumentDetail.body.lines[0].quantity, "3.125000", "document detail should preserve the ledger quantity exactly");
  const stockMovements = await request(
    port,
    `/api/admin/inventory?view=movements&locationId=${inventoryLocation.body.id}&page=1&pageSize=20`,
    { actorId: ownerId },
  );
  inventoryEqual(stockMovements.status, 200);
  inventoryOk(stockMovements.body.items.some((item) => item.kind === "receipt"
    && item.itemName === "زيت مخزون اختبار API" && item.locationName === "مخزن اختبار معزول"));
  const negativeAdjustmentPayload = {
    ...stockReceiptPayload,
    type: "adjustment",
    reason: "تصحيح نقص كمية موثق",
    lines: [{ itemId: inventoryProduct.body.id, quantity: "-0.125" }],
  };
  const negativeAdjustment = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: { action: "document.create", payload: negativeAdjustmentPayload, idempotencyKey: "inventory-api-adjustment-negative-001" },
  });
  inventoryEqual(negativeAdjustment.status, 201, "authorized negative adjustment should create a pending document");
  const negativeAdjustmentApproval = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: {
      action: "document.review",
      payload: { documentId: negativeAdjustment.body.id, decision: "approve", reason: "اعتماد فرق النقص الاصطناعي" },
      idempotencyKey: "inventory-api-adjustment-negative-review-001",
    },
  });
  inventoryEqual(negativeAdjustmentApproval.status, 200, "negative adjustment should post through the ledger");
  const restoreAdjustment = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: {
      action: "document.create",
      payload: {
        ...stockReceiptPayload,
        type: "adjustment",
        reason: "إعادة كمية اختبارية إلى المستوى السابق",
        lines: [{ itemId: inventoryProduct.body.id, quantity: "0.125" }],
      },
      idempotencyKey: "inventory-api-adjustment-restore-001",
    },
  });
  inventoryEqual(restoreAdjustment.status, 201);
  const restoreAdjustmentApproval = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: {
      action: "document.review",
      payload: { documentId: restoreAdjustment.body.id, decision: "approve", reason: "اعتماد استعادة الكمية الاصطناعية" },
      idempotencyKey: "inventory-api-adjustment-restore-review-001",
    },
  });
  inventoryEqual(restoreAdjustmentApproval.status, 200);
  const restoredBalances = await request(
    port,
    `/api/admin/inventory?view=balances&locationId=${inventoryLocation.body.id}&page=1&pageSize=20`,
    { actorId: ownerId },
  );
  inventoryEqual(Number(restoredBalances.body.items[0].onHand), 3.125, "signed adjustments should post the exact decrease and restore");
  const oversizeIssue = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "document.create",
      payload: {
        ...stockReceiptPayload,
        type: "issue",
        reason: "طلب صرف أكبر من المتاح",
        lines: [{ itemId: inventoryProduct.body.id, quantity: "9" }],
      },
      idempotencyKey: "inventory-api-oversize-issue-001",
    },
  });
  inventoryEqual(oversizeIssue.status, 201, "issue request should be recorded pending without prematurely changing stock");
  const oversizeApproval = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "document.review",
      payload: {
        documentId: oversizeIssue.body.id,
        decision: "approve",
        reason: "محاولة اعتماد كمية أكبر من الرصيد",
      },
      idempotencyKey: "inventory-api-oversize-issue-review-001",
    },
  });
  inventoryEqual(oversizeApproval.status, 409, "oversized issue must fail atomically instead of creating negative stock");
  const concurrentReservationPayload = (quantity) => ({
    organizationId: providerOrganizationId,
    locationId: inventoryLocation.body.id,
    itemId: inventoryProduct.body.id,
    sourceReference: "00000000-0000-4000-8000-000000000777",
    quantity,
    reason: "حجز تنافسي معزول للتحقق من الرصيد المتاح",
  });
  const reservationRequests = await Promise.all([
    request(port, "/api/admin/inventory", {
      actorId: ownerId, method: "POST",
      body: { action: "reservation.reserve", payload: concurrentReservationPayload("2"), idempotencyKey: "inventory-api-reserve-race-a" },
    }),
    request(port, "/api/admin/inventory", {
      actorId: ownerId, method: "POST",
      body: { action: "reservation.reserve", payload: concurrentReservationPayload("2"), idempotencyKey: "inventory-api-reserve-race-b" },
    }),
  ]);
  inventoryEqual(reservationRequests.filter((response) => response.status === 200).length, 1,
    "only one concurrent reservation may consume the available quantity");
  inventoryEqual(reservationRequests.filter((response) => response.status === 409).length, 1,
    "the competing reservation must receive a conflict after the stock row lock");
  const successfulReservation = reservationRequests.find((response) => response.status === 200);
  inventoryOk(successfulReservation?.body.id, "successful reservation should return its durable reference");
  const reservationRetry = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: {
      action: "reservation.reserve",
      payload: concurrentReservationPayload("2"),
      idempotencyKey: successfulReservation === reservationRequests[0]
        ? "inventory-api-reserve-race-a" : "inventory-api-reserve-race-b",
    },
  });
  inventoryEqual(reservationRetry.status, 200);
  inventoryEqual(reservationRetry.body.id, successfulReservation.body.id, "post-commit retry should return the same reservation");
  const reservationKey = successfulReservation === reservationRequests[0]
    ? "inventory-api-reserve-race-a" : "inventory-api-reserve-race-b";
  const reservationConflictRetry = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: {
      action: "reservation.reserve",
      payload: concurrentReservationPayload("1.5"),
      idempotencyKey: reservationKey,
    },
  });
  inventoryEqual(reservationConflictRetry.status, 409, "same reservation key with different quantity must be rejected");
  const releaseReservation = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: {
      action: "reservation.release",
      payload: { reservationId: successfulReservation.body.id, reason: "تحرير الحجز الاختباري بعد التحقق" },
      idempotencyKey: "inventory-api-reserve-release-001",
    },
  });
  inventoryEqual(releaseReservation.status, 200);
  inventoryEqual(releaseReservation.body.status, "released");
  const consumableReservation = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "reservation.reserve",
      payload: {
        ...concurrentReservationPayload("1"),
        sourceReference: "00000000-0000-4000-8000-000000000778",
      },
      idempotencyKey: "inventory-api-reserve-consume-001",
    },
  });
  inventoryEqual(consumableReservation.status, 200);
  const consumeReservation = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "reservation.consume",
      payload: { reservationId: consumableReservation.body.id, reason: "استهلاك الحجز الاختباري المحلي" },
      idempotencyKey: "inventory-api-reservation-consume-001",
    },
  });
  inventoryEqual(consumeReservation.status, 200);
  inventoryEqual(consumeReservation.body.status, "consumed");
  const finalBalances = await request(
    port,
    `/api/admin/inventory?view=balances&locationId=${inventoryLocation.body.id}&page=1&pageSize=20`,
    { actorId: ownerId },
  );
  inventoryEqual(Number(finalBalances.body.items[0].onHand), 2.125, "failed issue and reservation release must preserve stock; consumption posts exactly once");
  inventoryEqual(Number(finalBalances.body.items[0].reserved), 0, "released reservations must leave no reserved balance");

  const inventorySummary = await request(
    port,
    `/api/admin/inventory?view=summary&locationId=${inventoryLocation.body.id}`,
    { actorId: ownerId },
  );
  inventoryEqual(inventorySummary.status, 200, "authorized inventory manager should read location summary");
  inventoryEqual(inventorySummary.body.summary.locationId, inventoryLocation.body.id);
  const inventoryReorderRule = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "reorder.set",
      payload: {
        organizationId: providerOrganizationId,
        locationId: inventoryLocation.body.id,
        itemId: inventoryProduct.body.id,
        reorderLevel: "3",
        reason: "حد تنبيه اختبار API محلي",
      },
      idempotencyKey: "inventory-api-reorder-rule-001",
    },
  });
  inventoryEqual(inventoryReorderRule.status, 200);
  const inventoryAlerts = await request(
    port,
    `/api/admin/inventory?view=alerts&locationId=${inventoryLocation.body.id}&page=1&pageSize=20`,
    { actorId: ownerId },
  );
  inventoryEqual(inventoryAlerts.status, 200);
  inventoryOk(inventoryAlerts.body.items.some((item) => item.itemId === inventoryProduct.body.id && item.status === "low"),
    "threshold rules should produce an alert from the derived available balance");
  const unauthorizedReorderRule = await request(port, "/api/admin/inventory", {
    actorId: supportId,
    method: "POST",
    body: {
      action: "reorder.set",
      payload: {
        organizationId: providerOrganizationId,
        locationId: inventoryLocation.body.id,
        itemId: inventoryProduct.body.id,
        reorderLevel: "1",
        reason: "محاولة كتابة غير مخولة",
      },
      idempotencyKey: "inventory-api-reorder-denied-001",
    },
  });
  inventoryEqual(unauthorizedReorderRule.status, 403, "read-only support role cannot alter inventory thresholds");

  const openingLocation = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "location.create",
      payload: {
        organizationId: providerOrganizationId,
        branchId: providerBranchId,
        name: "مخزن رصيد افتتاحي محلي",
        kind: "sellable",
        reason: "موقع معزول لاختبار الرصيد الافتتاحي",
      },
      idempotencyKey: "inventory-api-opening-location-001",
    },
  });
  inventoryEqual(openingLocation.status, 201);
  const openingPayload = {
    organizationId: providerOrganizationId,
    sourceLocationId: openingLocation.body.id,
    type: "opening",
    reason: "رصيد افتتاحي اصطناعي محلي",
    lines: [{ itemId: inventoryProduct.body.id, quantity: "2.500" }],
  };
  const openingDocument = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: { action: "document.create", payload: openingPayload, idempotencyKey: "inventory-api-opening-create-001" },
  });
  inventoryEqual(openingDocument.status, 201);
  const openingApproval = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: {
      action: "document.review",
      payload: { documentId: openingDocument.body.id, decision: "approve", reason: "اعتماد رصيد افتتاحي محلي" },
      idempotencyKey: "inventory-api-opening-review-001",
    },
  });
  inventoryEqual(openingApproval.status, 200);
  const duplicateOpening = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: { action: "document.create", payload: openingPayload, idempotencyKey: "inventory-api-opening-duplicate-001" },
  });
  inventoryEqual(duplicateOpening.status, 409, "a location/item can have only one opening balance");
  const openingBalance = await request(
    port,
    `/api/admin/inventory?view=balances&locationId=${openingLocation.body.id}&page=1&pageSize=20`,
    { actorId: ownerId },
  );
  inventoryEqual(openingBalance.status, 200);
  inventoryEqual(openingBalance.body.items[0].onHand, "2.500000");

  const staleCount = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "document.create",
      payload: {
        organizationId: providerOrganizationId,
        sourceLocationId: inventoryLocation.body.id,
        type: "count",
        reason: "لقطة جرد لاختبار تغير الإصدار",
        lines: [{ itemId: inventoryProduct.body.id, quantity: "2.125" }],
      },
      idempotencyKey: "inventory-api-count-snapshot-001",
    },
  });
  inventoryEqual(staleCount.status, 201);
  const receiptAfterCount = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "document.create",
      payload: { ...stockReceiptPayload, reason: "استلام بعد لقطة الجرد", lines: [{ itemId: inventoryProduct.body.id, quantity: "1" }] },
      idempotencyKey: "inventory-api-receipt-after-count-001",
    },
  });
  inventoryEqual(receiptAfterCount.status, 201);
  const receiptAfterCountApproval = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "document.review",
      payload: { documentId: receiptAfterCount.body.id, decision: "approve", reason: "اعتماد استلام بعد الجرد" },
      idempotencyKey: "inventory-api-receipt-after-count-review-001",
    },
  });
  inventoryEqual(receiptAfterCountApproval.status, 200);
  const staleCountApproval = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "document.review",
      payload: { documentId: staleCount.body.id, decision: "approve", reason: "محاولة اعتماد لقطة قديمة" },
      idempotencyKey: "inventory-api-count-stale-review-001",
    },
  });
  inventoryEqual(staleCountApproval.status, 409, "stale count version must be rejected without a partial posting");

  const quarantineLocation = await request(port, "/api/admin/inventory", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "location.create",
      payload: {
        organizationId: providerOrganizationId,
        branchId: providerBranchId,
        name: "منطقة مرتجعات محلية",
        kind: "quarantine",
        reason: "موقع معزول لاختبار ربط المرتجع",
      },
      idempotencyKey: "inventory-api-return-location-001",
    },
  });
  inventoryEqual(quarantineLocation.status, 201);
  const issueSource = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: {
      action: "document.create",
      payload: { ...stockReceiptPayload, type: "issue", reason: "صرف لاختبار مرجع المرتجع", lines: [{ itemId: inventoryProduct.body.id, quantity: "1" }] },
      idempotencyKey: "inventory-api-return-source-create-001",
    },
  });
  inventoryEqual(issueSource.status, 201);
  const issueSourceApproval = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: {
      action: "document.review",
      payload: { documentId: issueSource.body.id, decision: "approve", reason: "اعتماد الصرف الأصلي" },
      idempotencyKey: "inventory-api-return-source-review-001",
    },
  });
  inventoryEqual(issueSourceApproval.status, 200);
  const issueMovements = await request(
    port,
    `/api/admin/inventory?view=movements&locationId=${inventoryLocation.body.id}&page=1&pageSize=100`,
    { actorId: ownerId },
  );
  const originalIssueMovement = issueMovements.body.items.find((item) => item.documentId === issueSource.body.id);
  inventoryOk(originalIssueMovement?.id, "a posted issue must expose its internal movement reference to authorized return selection");
  const overReturn = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: {
      action: "document.create",
      payload: {
        organizationId: providerOrganizationId,
        sourceLocationId: inventoryLocation.body.id,
        targetLocationId: quarantineLocation.body.id,
        type: "return",
        reason: "محاولة إرجاع تتجاوز الصرف الأصلي",
        lines: [{ itemId: inventoryProduct.body.id, quantity: "1.1", sourceMovementId: String(originalIssueMovement.id) }],
      },
      idempotencyKey: "inventory-api-over-return-001",
    },
  });
  inventoryEqual(overReturn.status, 409, "return quantity cannot exceed its original issue");
  const linkedReturn = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: {
      action: "document.create",
      payload: {
        organizationId: providerOrganizationId,
        sourceLocationId: inventoryLocation.body.id,
        targetLocationId: quarantineLocation.body.id,
        type: "return",
        reason: "مرتجع مرتبط بالصرف الأصلي",
        lines: [{ itemId: inventoryProduct.body.id, quantity: "1", sourceMovementId: String(originalIssueMovement.id) }],
      },
      idempotencyKey: "inventory-api-linked-return-001",
    },
  });
  inventoryEqual(linkedReturn.status, 201);
  const linkedReturnApproval = await request(port, "/api/admin/inventory", {
    actorId: ownerId, method: "POST",
    body: {
      action: "document.review",
      payload: { documentId: linkedReturn.body.id, decision: "approve", reason: "اعتماد المرتجع المرتبط" },
      idempotencyKey: "inventory-api-linked-return-review-001",
    },
  });
  inventoryEqual(linkedReturnApproval.status, 200);
  const remainingReturnSources = await request(
    port,
    `/api/admin/inventory?view=return_sources&locationId=${inventoryLocation.body.id}&page=1&pageSize=20`,
    { actorId: ownerId },
  );
  inventoryEqual(remainingReturnSources.status, 200);
  inventoryEqual(remainingReturnSources.body.items.some((item) => item.movementId === originalIssueMovement.id), false,
    "a fully returned issue must not remain selectable as a return source");
  const pendingOnlyDocuments = await request(
    port,
    `/api/admin/inventory?view=documents&locationId=${inventoryLocation.body.id}&status=pending&sortBy=status&sortDirection=asc&page=1&pageSize=20`,
    { actorId: ownerId },
  );
  inventoryEqual(pendingOnlyDocuments.status, 200);
  inventoryOk(pendingOnlyDocuments.body.items.every((item) => item.status === "pending"),
    "server-side document status filter should constrain results before pagination");
  const sortedDocuments = await request(
    port,
    `/api/admin/inventory?view=documents&locationId=${inventoryLocation.body.id}&sortBy=status&sortDirection=asc&page=1&pageSize=100`,
    { actorId: ownerId },
  );
  inventoryEqual(sortedDocuments.status, 200);
  const sortedDocumentStatuses = sortedDocuments.body.items.map((item) => item.status);
  inventoryEqual(sortedDocumentStatuses[0], "approved", "status sorting should order approved documents before pending ones");
  inventoryEqual(sortedDocumentStatuses.at(-1), "pending", "status sorting should retain pending items after approved ones");

  const anonymous = await request(port, "/api/admin/platform-users");
  assert.equal(anonymous.status, 401, "anonymous directory access must be denied");

  const fleetAnonymous = await request(port, "/api/admin/fleet/catalog?view=vehicles");
  assert.equal(fleetAnonymous.status, 401, "anonymous fleet access must be denied");
  const fleetCatalog = await request(port, "/api/admin/fleet/catalog?view=vehicles&page=1&pageSize=20", {
    actorId: ownerId,
  });
  assert.equal(fleetCatalog.status, 200, "authorized owner should read the fleet catalog");
  assert.equal(Array.isArray(fleetCatalog.body.items), true, "fleet catalog should return a paged item list");
  const financeFleetAccess = await request(port, "/api/admin/fleet/catalog?view=vehicles", {
    actorId: financeId,
  });
  assert.equal(financeFleetAccess.status, 403, "finance-only actor must not receive fleet-admin access");
  const fleetCompanyDirectory = await request(
    port,
    "/api/admin/fleet/company-summaries?query=API-FLEET&page=1&pageSize=20",
    { actorId: ownerId },
  );
  assert.equal(fleetCompanyDirectory.status, 200);
  assert.equal(fleetCompanyDirectory.body.items.length, 1);
  assert.equal(fleetCompanyDirectory.body.items[0].code, "API-FLEET-COMPANY");
  assert.equal(fleetCompanyDirectory.body.items[0].branchCount, 1);
  assert.ok(Number(fleetCompanyDirectory.body.nfcIssuePriceMinor) > 0);
  const fleetCompanyDetail = await request(
    port,
    `/api/admin/fleet/company-summaries?organizationId=${fleetCompanyId}&page=1&pageSize=20`,
    { actorId: ownerId },
  );
  assert.equal(fleetCompanyDetail.status, 200);
  assert.equal(fleetCompanyDetail.body.branches[0].id, fleetBranchId);
  const scopedMemberships = await request(
    port,
    `/api/admin/organizations/memberships?organizationId=${fleetCompanyId}&page=1&pageSize=10`,
    { actorId: ownerId },
  );
  assert.equal(scopedMemberships.status, 200);
  assert.equal(scopedMemberships.body.total, 1);
  assert.equal(scopedMemberships.body.items[0].userId, targetId);
  assert.equal(scopedMemberships.body.items[0].organizationId, fleetCompanyId);
  assert.equal(scopedMemberships.body.items[0].profile.display_name, "API Target");
  assert.equal(scopedMemberships.body.items[0].branches[0].branchId, fleetBranchId);
  const otherOrganizationMemberships = await request(
    port,
    `/api/admin/organizations/memberships?organizationId=${providerOrganizationId}&page=1&pageSize=10`,
    { actorId: ownerId },
  );
  assert.equal(otherOrganizationMemberships.status, 200);
  assert.equal(otherOrganizationMemberships.body.total, 2);
  assert.deepEqual(
    otherOrganizationMemberships.body.items.map((membership) => membership.userId).sort(),
    [targetId, catalogManagerId].sort(),
  );
  assert.equal(otherOrganizationMemberships.body.items[0].organizationId, providerOrganizationId);
  const operationsMemberships = await request(
    port,
    `/api/admin/organizations/memberships?organizationId=${fleetCompanyId}`,
    { actorId: operationsId },
  );
  assert.equal(operationsMemberships.status, 200, "authorized operations role can read organization memberships");
  const financeMembershipsDenied = await request(
    port,
    `/api/admin/organizations/memberships?organizationId=${fleetCompanyId}`,
    { actorId: financeId },
  );
  assert.equal(financeMembershipsDenied.status, 403, "finance role cannot read organization memberships");
  const exactBranch = await request(
    port,
    `/api/admin/organizations/${fleetCompanyId}/branches/${fleetBranchId}`,
    { actorId: ownerId },
  );
  assert.equal(exactBranch.status, 200);
  assert.equal(exactBranch.body.branch.id, fleetBranchId);
  assert.equal(exactBranch.body.organizationId, fleetCompanyId);
  const crossOrganizationBranch = await request(
    port,
    `/api/admin/organizations/${fleetCompanyId}/branches/${providerBranchId}`,
    { actorId: ownerId },
  );
  assert.equal(crossOrganizationBranch.status, 404, "branch lookup must enforce both organization and branch identity");
  const exactCompanyVehicles = await request(
    port,
    `/api/admin/fleet/catalog?view=vehicles&organizationId=${fleetCompanyId}&page=1&pageSize=10`,
    { actorId: ownerId },
  );
  assert.equal(exactCompanyVehicles.status, 200);
  assert.ok(exactCompanyVehicles.body.items.some((item) => item.id === apiFleetVehicle.id));
  assert.equal(exactCompanyVehicles.body.items.every((item) => item.organizationId === fleetCompanyId), true);
  const malformedFleetCompany = await request(
    port,
    "/api/admin/fleet/company-summaries?organizationId=not-a-uuid",
    { actorId: ownerId },
  );
  assert.equal(malformedFleetCompany.status, 400);
  const linkCreateBody = {
    action: "driver.link.create",
    payload: {
      vehicleId: apiFleetVehicle.id,
      driverId: apiFleetDriver.id,
      pinCode: "0427",
      startsAt: "2024-07-01T12:00:00Z",
    },
    reason: "ربط سائق اختبار API مع رمز تعبئة تجريبي",
    idempotencyKey: "api-fleet-driver-link-001",
  };
  const linkCreated = await request(port, "/api/admin/fleet/commands", {
    actorId: ownerId,
    method: "POST",
    body: linkCreateBody,
  });
  assert.equal(
    linkCreated.status,
    200,
    `driver link request failed: ${String(linkCreated.body?.code ?? "unknown")}: ${String(linkCreated.body?.message ?? "no safe error message")}`,
  );
  assert.ok(linkCreated.body.id);
  const linkReplay = await request(port, "/api/admin/fleet/commands", {
    actorId: ownerId,
    method: "POST",
    body: linkCreateBody,
  });
  assert.equal(linkReplay.status, 200);
  assert.equal(linkReplay.body.id, linkCreated.body.id);
  const linkPayloadConflict = await request(port, "/api/admin/fleet/commands", {
    actorId: ownerId,
    method: "POST",
    body: {
      ...linkCreateBody,
      payload: { ...linkCreateBody.payload, pinCode: "9999" },
    },
  });
  assert.equal(linkPayloadConflict.status, 409);
  const initialPinReveal = await request(port, "/api/admin/fleet/driver-pairs/reveal", {
    actorId: ownerId,
    method: "POST",
    body: { linkId: linkCreated.body.id, reason: "مراجعة رمز الإسناد قبل التسليم" },
  });
  assert.equal(initialPinReveal.status, 200);
  assert.equal(initialPinReveal.body.pinCode, "0427");
  const cardsOverview = await request(
    port,
    "/api/admin/fleet/cards?view=overview&page=1&pageSize=20",
    { actorId: ownerId },
  );
  assert.equal(cardsOverview.status, 200);
  assert.equal(cardsOverview.body.view, "overview");
  assert.equal(cardsOverview.body.items.length, 0);
  assert.equal(
    JSON.stringify(cardsOverview.body).includes("pinHmac")
      || JSON.stringify(cardsOverview.body).includes("tokenSha256"),
    false,
  );
  const financeCardsDenied = await request(
    port,
    "/api/admin/fleet/cards?view=overview&page=1&pageSize=20",
    { actorId: financeId },
  );
  assert.equal(financeCardsDenied.status, 403);
  const financePinRevealDenied = await request(port, "/api/admin/fleet/driver-pairs/reveal", {
    actorId: financeId,
    method: "POST",
    body: { linkId: linkCreated.body.id, reason: "محاولة غير مخولة" },
  });
  assert.equal(financePinRevealDenied.status, 403);
  const rotatedPin = await request(port, "/api/admin/fleet/commands", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "driver.pin.rotate",
      payload: { linkId: linkCreated.body.id, vehicleId: apiFleetVehicle.id, pinCode: "0136" },
      reason: "تدوير رمز تعبئة بعد التسليم",
      idempotencyKey: "api-fleet-driver-pin-rotate-001",
    },
  });
  assert.equal(rotatedPin.status, 200);
  const rotatedPinReplay = await request(port, "/api/admin/fleet/commands", {
    actorId: ownerId,
    method: "POST",
    body: {
      action: "driver.pin.rotate",
      payload: { linkId: linkCreated.body.id, vehicleId: apiFleetVehicle.id, pinCode: "0136" },
      reason: "تدوير رمز تعبئة بعد التسليم",
      idempotencyKey: "api-fleet-driver-pin-rotate-001",
    },
  });
  assert.equal(rotatedPinReplay.status, 200);
  const rotatedPinReveal = await request(port, "/api/admin/fleet/driver-pairs/reveal", {
    actorId: ownerId,
    method: "POST",
    body: { linkId: linkCreated.body.id, reason: "التحقق من التدوير المعتمد" },
  });
  assert.equal(rotatedPinReveal.status, 200);
  assert.equal(rotatedPinReveal.body.pinCode, "0136");
  const stockReservations = await request(
    port,
    "/api/admin/fleet/stock-reservations?page=1&pageSize=20",
    { actorId: ownerId },
  );
  assert.equal(stockReservations.status, 200);
  assert.equal(stockReservations.body.items.length, 0);
  const anonymousStockReservations = await request(port, "/api/admin/fleet/stock-reservations");
  assert.equal(anonymousStockReservations.status, 401);
  const financeStockReservations = await request(
    port,
    "/api/admin/fleet/stock-reservations",
    { actorId: financeId },
  );
  assert.equal(financeStockReservations.status, 403);
  const driverDetail = await request(
    port,
    `/api/admin/fleet/drivers/${apiFleetDriver.id}`,
    { actorId: ownerId },
  );
  assert.equal(driverDetail.status, 200);
  assert.equal(driverDetail.body.driverCode, "API-FLEET-DRIVER");
  assert.equal(driverDetail.body.links.length, 1);
  assert.equal(Date.parse(driverDetail.body.links[0].startsAt), Date.parse("2024-07-01T12:00:00Z"));
  assert.equal(Object.keys(driverDetail.body).some((key) => /pin|hmac|secret/i.test(key)), false);
  const anonymousDriverDetail = await request(
    port,
    `/api/admin/fleet/drivers/${apiFleetDriver.id}`,
  );
  assert.equal(anonymousDriverDetail.status, 401);
  const financeDriverDetail = await request(
    port,
    `/api/admin/fleet/drivers/${apiFleetDriver.id}`,
    { actorId: financeId },
  );
  assert.equal(financeDriverDetail.status, 403);
  const financeFleetDirectory = await request(
    port,
    "/api/admin/fleet/company-summaries?page=1&pageSize=20",
    { actorId: financeId },
  );
  assert.equal(financeFleetDirectory.status, 403);
  const emptyRates = await request(
    port,
    `/api/admin/fleet/consumption-rates?organizationId=${fleetCompanyId}&branchId=${fleetBranchId}`,
    { actorId: ownerId },
  );
  assert.equal(emptyRates.status, 200);
  assert.equal(emptyRates.body.current, null);
  const savedRate = await request(port, "/api/admin/fleet/consumption-rates", {
    actorId: ownerId,
    method: "POST",
    body: {
      organizationId: fleetCompanyId,
      branchId: fleetBranchId,
      litersPer100Km: 8.125,
      reason: "اختبار معدل استهلاك API معزول",
      idempotencyKey: "api-fleet-rate-create-001",
    },
  });
  assert.equal(savedRate.status, 201);
  assert.equal(savedRate.body.version, 1);
  assert.equal(savedRate.body.litersPer100Km, 8.125);
  const replayRate = await request(port, "/api/admin/fleet/consumption-rates", {
    actorId: ownerId,
    method: "POST",
    body: {
      organizationId: fleetCompanyId,
      branchId: fleetBranchId,
      litersPer100Km: 8.125,
      reason: "اختبار معدل استهلاك API معزول",
      idempotencyKey: "api-fleet-rate-create-001",
    },
  });
  assert.equal(replayRate.status, 201);
  assert.equal(replayRate.body.id, savedRate.body.id);
  assert.equal(replayRate.body.replayed, true);

  const directory = await request(port, "/api/admin/platform-users?page=1&pageSize=2", {
    actorId: ownerId,
  });
  assert.equal(directory.status, 200);
  assert.equal(directory.body.total, 7);
  assert.equal(directory.body.items.length, 2);
  assert.equal(directory.body.pageSize, 2);
  assert.ok(directory.body.roleCatalog.some((item) => item.role === "operations"));
  assert.ok(directory.body.roleCatalog.find((item) => item.role === "finance")
    ?.permissions.some((permission) => permission.code === "bank_changes.review"));

  const search = await request(port, "/api/admin/platform-users?search=API%20Target", {
    actorId: ownerId,
  });
  assert.equal(search.status, 200);
  assert.equal(search.body.total, 1);
  assert.equal(search.body.items[0].username, "api_target");

  const detail = await request(port, `/api/admin/platform-users/${targetId}`, {
    actorId: ownerId,
  });
  assert.equal(detail.status, 200);
  const positiveUserMemberships = await request(
    port,
    `/api/admin/platform-users/${targetId}/memberships`,
    { actorId: ownerId },
  );
  assert.equal(positiveUserMemberships.status, 200);
  assert.equal(positiveUserMemberships.body.items.length, 2);
  assert.ok(positiveUserMemberships.body.items.some((item) =>
    item.organizationId === fleetCompanyId &&
    item.organizationName === "API Fleet Company" &&
    item.branches.some((branch) => branch.branchId === fleetBranchId),
  ));
  const operationsUserMemberships = await request(
    port,
    `/api/admin/platform-users/${targetId}/memberships`,
    { actorId: operationsId },
  );
  assert.equal(operationsUserMemberships.status, 403, "non-owner must not read the central platform-user profile");
  assert.equal(detail.body.user.username, "api_target");
  assert.equal("email" in detail.body.user, false, "Auth email must not be returned");
  assert.ok(detail.body.roleCatalog.some((item) => item.role === "owner"));

  const roleChange = await request(
    port,
    `/api/admin/platform-users/${targetId}/roles`,
    {
      actorId: ownerId,
      method: "PATCH",
      body: { roles: ["finance"], reason: "Isolated API role test" },
    },
  );
  assert.equal(roleChange.status, 200);
  assert.deepEqual(roleChange.body.roles, ["finance"]);

  const statusChange = await request(port, `/api/users/${targetId}/status`, {
    actorId: ownerId,
    method: "PATCH",
    body: { status: "suspended", reason: "Isolated API status test" },
  });
  assert.equal(statusChange.status, 200);

  const suspended = await request(
    port,
    "/api/admin/platform-users?accountStatus=suspended",
    { actorId: ownerId },
  );
  assert.equal(suspended.status, 200);
  assert.equal(suspended.body.total, 1);
  assert.equal(suspended.body.items[0].userId, targetId);

  const detailAfter = await request(port, `/api/admin/platform-users/${targetId}`, {
    actorId: ownerId,
  });
  assert.equal(detailAfter.status, 200);
  assert.equal(detailAfter.body.user.accountStatus, "suspended");
  assert.ok(
    detailAfter.body.activity.some((event) => event.reason === "Isolated API status test"),
  );

  const missingReason = await request(port, `/api/users/${targetId}/status`, {
    actorId: ownerId,
    method: "PATCH",
    body: { status: "active" },
  });
  assert.equal(missingReason.status, 400, "reasonless status changes must be rejected");

  const selfChange = await request(
    port,
    `/api/admin/platform-users/${ownerId}/roles`,
    {
      actorId: ownerId,
      method: "PATCH",
      body: { roles: ["owner", "finance"], reason: "Self escalation test" },
    },
  );
  assert.equal(selfChange.status, 403, "self role changes must be denied");

  const operationsDenied = await request(port, "/api/admin/platform-users", {
    actorId: operationsId,
  });
  assert.equal(operationsDenied.status, 403, "operations cannot use the owner-only directory");

  const invalidPlatformCreate = await request(port, "/api/admin/platform-users", {
    actorId: ownerId,
    method: "POST",
    body: {
      username: "bad role",
      displayName: "Synthetic Platform User",
      email: "platform-new@example.invalid",
      password: "Synthetic-Temporary-Password-1",
      roles: ["admin"],
      reason: "Synthetic role validation",
    },
  });
  assert.equal(invalidPlatformCreate.status, 400, "unsupported roles must be rejected before signup");

  const createdPlatformUser = await request(port, "/api/admin/platform-users", {
    actorId: ownerId,
    method: "POST",
    body: {
      username: "platform_new",
      displayName: "Synthetic Platform User",
      email: "platform-new@example.invalid",
      password: "Synthetic-Temporary-Password-1",
      roles: ["finance", "auditor"],
      reason: "Synthetic initial platform access",
    },
  });
  assert.equal(createdPlatformUser.status, 201, JSON.stringify(createdPlatformUser.body));
  assert.equal(createdPlatformUser.body.status, "confirmation_required");
  assert.equal("password" in createdPlatformUser.body, false, "temporary password must never be returned");
  assert.equal("email" in createdPlatformUser.body, false, "account email must not be returned in the creation result");

  const createdDuplicate = await request(port, "/api/admin/platform-users", {
    actorId: ownerId,
    method: "POST",
    body: {
      username: "platform_new",
      displayName: "Synthetic Platform User",
      email: "platform-new@example.invalid",
      password: "Another-Synthetic-Password-2",
      roles: ["finance"],
      reason: "Synthetic duplicate account test",
    },
  });
  assert.equal(createdDuplicate.status, 409, "duplicate email or username must not re-create or reset an account");

  const activateCreatedUser = await request(port, `/api/users/${createdPlatformUserId}/status`, {
    actorId: ownerId,
    method: "PATCH",
    body: { status: "active", reason: "Synthetic activation after email confirmation" },
  });
  assert.equal(activateCreatedUser.status, 200, "owner activation remains a separate audited step");

  const forcedResetGate = await request(port, "/api/admin/platform-users", {
    actorId: createdPlatformUserId,
  });
  assert.equal(forcedResetGate.status, 428, "a new user must change the temporary password before protected routes");

  const passwordUpdated = await request(port, "/api/auth/password", {
    actorId: createdPlatformUserId,
    method: "POST",
    body: { password: "Synthetic-New-Password-3" },
  });
  assert.equal(passwordUpdated.status, 200);
  const afterTemporaryPasswordChange = await request(port, "/api/admin/platform-users", {
    actorId: createdPlatformUserId,
  });
  assert.equal(afterTemporaryPasswordChange.status, 403, "password reset unlocks the session but does not grant owner access");

  const billingDenied = await request(port, "/api/admin/billing/catalog", {
    actorId: operationsId,
  });
  assert.equal(billingDenied.status, 403, "operations cannot use owner-only billing controls");

  const billingCatalog = await request(port, "/api/admin/billing/catalog", {
    actorId: ownerId,
  });
  assert.equal(billingCatalog.status, 200);
  assert.equal(billingCatalog.body.pricingDefaults.stationAnnualPriceMinor, 0);
  assert.equal(billingCatalog.body.pricingDefaults.nfcIssuePriceMinor, 10000);

  const planDraft = await request(port, "/api/admin/billing/plans", {
    actorId: ownerId,
    method: "POST",
    body: {
      code: "api-company-custom",
      audience: "company",
      name: "API company draft",
      description: "Synthetic API draft",
      annualPriceMinor: 50000,
      billingUnit: "vehicle",
      billingCycle: "annual",
      currency: "EGP",
      effectiveAt: new Date(Date.now() + 60_000).toISOString(),
      entitlements: [{ key: "api_right", label: "API test right", value: true, approved: false }],
      settings: [],
    },
  });
  assert.equal(planDraft.status, 201);
  const createdPlanId = planDraft.body.id;

  const catalogWithDraft = await request(port, "/api/admin/billing/catalog", {
    actorId: ownerId,
  });
  assert.equal(catalogWithDraft.status, 200);
  const createdPlan = catalogWithDraft.body.plans.find((item) => item.id === createdPlanId);
  assert.ok(createdPlan, "created plan must be visible in the live API catalog");
  assert.equal(createdPlan.versions[0].annualPriceMinor, 50000);
  assert.equal("nfcIssuePriceMinor" in createdPlan.versions[0], false);
  const publishWithoutReason = await request(
    port,
    `/api/admin/billing/plans/${createdPlanId}/versions/${createdPlan.versions[0].id}/publish`,
    { actorId: ownerId, method: "POST", body: {} },
  );
  assert.equal(publishWithoutReason.status, 400, "sensitive plan publication still requires a reason");

  const updatedDraft = await request(
    port,
    `/api/admin/billing/plans/${createdPlanId}/versions/${createdPlan.versions[0].id}`,
    {
      actorId: ownerId,
      method: "PATCH",
      body: {
        displayName: "API company draft revised",
        description: "وصف مسودة تم تعديله",
        annualPriceMinor: 57525,
        billingUnit: "vehicle",
        billingCycle: "annual",
        currency: "EGP",
        effectiveAt: new Date(Date.now() - 60_000).toISOString(),
        entitlements: [
          { key: "api_right", label: "API test right", value: false, approved: true },
          { key: "second_right", label: "Second API test right", value: 3, approved: false },
        ],
        settings: [{ key: "api_setting", label: "API test setting", value: "saved", approved: false }],
      },
    },
  );
  assert.equal(updatedDraft.status, 200);
  assert.equal(updatedDraft.body.status, "draft");

  const updatedCatalog = await request(port, "/api/admin/billing/catalog", {
    actorId: ownerId,
  });
  assert.equal(updatedCatalog.status, 200);
  const savedDraft = updatedCatalog.body.plans.find((item) => item.id === createdPlanId);
  assert.equal(savedDraft.versions[0].annualPriceMinor, 57525);
  assert.equal(savedDraft.versions[0].description, "وصف مسودة تم تعديله");
  assert.equal(savedDraft.versions[0].publicationStatus, "draft");
  assert.deepEqual(savedDraft.versions[0].entitlements, [
    { key: "api_right", label: "API test right", value: false, approved: true },
    { key: "second_right", label: "Second API test right", value: 3, approved: false },
  ], "re-reading the catalog must preserve each edited entitlement");
  assert.deepEqual(savedDraft.versions[0].settings, [
    { key: "api_setting", label: "API test setting", value: "saved", approved: false },
  ], "re-reading the catalog must preserve settings");

  const draftRetry = await request(
    port,
    `/api/admin/billing/plans/${createdPlanId}/versions/${createdPlan.versions[0].id}`,
    {
      actorId: ownerId,
      method: "PATCH",
      body: {
        displayName: "API company draft revised",
        description: "وصف مسودة تم تعديله",
        annualPriceMinor: 57525,
        billingUnit: "vehicle",
        billingCycle: "annual",
        currency: "EGP",
        effectiveAt: new Date(Date.now() - 60_000).toISOString(),
        entitlements: [
          { key: "api_right", label: "API test right", value: false, approved: true },
          { key: "second_right", label: "Second API test right", value: 3, approved: false },
        ],
        settings: [{ key: "api_setting", label: "API test setting", value: "saved", approved: false }],
      },
    },
  );
  assert.equal(draftRetry.status, 200);
  const afterRetryCatalog = await request(port, "/api/admin/billing/catalog", {
    actorId: ownerId,
  });
  assert.equal(afterRetryCatalog.status, 200);
  const afterRetryDraft = afterRetryCatalog.body.plans.find((item) => item.id === createdPlanId);
  assert.equal(afterRetryDraft.versions.length, 1);
  assert.equal(afterRetryDraft.versions[0].annualPriceMinor, 57525);
  assert.equal(afterRetryDraft.versions[0].description, "وصف مسودة تم تعديله");
  assert.deepEqual(afterRetryDraft.versions[0].entitlements, savedDraft.versions[0].entitlements);
  assert.deepEqual(afterRetryDraft.versions[0].settings, savedDraft.versions[0].settings);

  const providerDraft = await request(port, "/api/admin/billing/plans", {
    actorId: ownerId,
    method: "POST",
    body: {
      code: "api-provider-custom",
      audience: "provider",
      name: "API provider draft",
      description: "Provider API draft",
      annualPriceMinor: 500000,
      billingUnit: "branch",
      billingCycle: "annual",
      currency: "EGP",
      effectiveAt: new Date(Date.now() + 60_000).toISOString(),
      entitlements: [],
      settings: [],
      reason: "Isolated provider plan creation",
    },
  });
  assert.equal(providerDraft.status, 201);
  const providerPrice = await request(port, "/api/admin/billing/provider-price-overrides", {
    actorId: ownerId,
    method: "POST",
    body: {
      organizationId: providerOrganizationId,
      branchId: providerBranchId,
      planId: providerDraft.body.id,
      priceMinor: 490000,
      effectiveFrom: new Date(Date.now() + 86_400_000).toISOString(),
      effectiveTo: null,
      supersedesOverrideId: null,
      reason: "Isolated provider branch price",
    },
  });
  assert.equal(providerPrice.status, 201);
  const billingAfterPrice = await request(port, "/api/admin/billing/catalog", {
    actorId: ownerId,
  });
  assert.equal(billingAfterPrice.status, 200);
  assert.ok(billingAfterPrice.body.priceOverrides.some((item) => item.id === providerPrice.body.id));
  const providerProfilePricing = await request(
    port,
    `/api/admin/billing/organization?organizationId=${providerOrganizationId}&section=priceOverrides&page=1&pageSize=10`,
    { actorId: ownerId },
  );
  assert.equal(providerProfilePricing.status, 200);
  assert.equal(providerProfilePricing.body.organizationId, providerOrganizationId);
  assert.equal(providerProfilePricing.body.items.some((item) => item.id === providerPrice.body.id), true);
  assert.equal(providerProfilePricing.body.items.every((item) => item.organizationId === providerOrganizationId), true);
  const companyProfilePricing = await request(
    port,
    `/api/admin/billing/organization?organizationId=${fleetCompanyId}&section=priceOverrides&page=1&pageSize=10`,
    { actorId: ownerId },
  );
  assert.equal(companyProfilePricing.status, 200);
  assert.equal(companyProfilePricing.body.total, 0, "a different organization's override must not leak into the company profile");
  const providerPlan = billingAfterPrice.body.plans.find((item) => item.id === providerDraft.body.id);
  assert.ok(providerPlan, "synthetic provider plan should be present for subscription-read fixture");
  const providerVersion = providerPlan.versions[0];
  const preparedProviderVersion = await request(
    port,
    `/api/admin/billing/plans/${providerPlan.id}/versions/${providerVersion.id}`,
    {
      actorId: ownerId,
      method: "PATCH",
      body: {
        displayName: "API provider isolated version",
        description: "Synthetic provider subscription read fixture",
        annualPriceMinor: 500000,
        billingUnit: "branch",
        billingCycle: "annual",
        currency: "EGP",
        effectiveAt: new Date(Date.now() + 60_000).toISOString(),
        entitlements: [{ key: "test_right", label: "Synthetic test right", value: true, approved: true }],
        settings: [],
        reason: "Prepare isolated provider subscription fixture",
      },
    },
  );
  assert.equal(preparedProviderVersion.status, 200);
  const publishedProviderVersion = await request(
    port,
    `/api/admin/billing/plans/${providerPlan.id}/versions/${providerVersion.id}/publish`,
    {
      actorId: ownerId,
      method: "POST",
      body: { reason: "Publish isolated provider subscription fixture" },
    },
  );
  assert.equal(publishedProviderVersion.status, 200);
  const requestStart = new Date(Date.now() + 2 * 86_400_000);
  const providerSubscriptionRequest = await request(port, "/api/admin/billing/subscription-requests", {
    actorId: ownerId,
    method: "POST",
    body: {
      organizationId: providerOrganizationId,
      branchId: providerBranchId,
      requestType: "new",
      currentSubscriptionId: null,
      planId: providerPlan.id,
      planVersionId: providerVersion.id,
      requestedPriceMinor: null,
      startsAt: requestStart.toISOString(),
      endsAt: new Date(requestStart.getTime() + 366 * 86_400_000).toISOString(),
      coverageNote: "Synthetic verified branch coverage",
      reason: "Create isolated subscription request",
      submit: true,
    },
  });
  assert.equal(providerSubscriptionRequest.status, 201);
  const approvedPendingPayment = await request(
    port,
    `/api/admin/billing/subscription-requests/${providerSubscriptionRequest.body.id}/review`,
    {
      actorId: ownerId,
      method: "POST",
      body: { decision: "approve", reason: "Approve isolated request pending payment" },
    },
  );
  assert.equal(approvedPendingPayment.status, 200);
  assert.equal(approvedPendingPayment.body.message.includes("ينتظر ربط التحصيل المالي"), true);
  const providerProfileSubscriptions = await request(
    port,
    `/api/admin/billing/organization?organizationId=${providerOrganizationId}&section=subscriptions&page=1&pageSize=10`,
    { actorId: ownerId },
  );
  assert.equal(providerProfileSubscriptions.status, 200);
  assert.equal(providerProfileSubscriptions.body.total, 1);
  assert.equal(providerProfileSubscriptions.body.items[0].status, "pending_payment");
  assert.equal(providerProfileSubscriptions.body.items[0].organizationId, providerOrganizationId);
  const subscriptionSnapshotBeforeNewPlanVersion = structuredClone(providerProfileSubscriptions.body.items[0].planSnapshot);
  const subscriptionPriceBeforeNewPlanVersion = providerProfileSubscriptions.body.items[0].priceSnapshotMinor;
  const companyProfileSubscriptions = await request(
    port,
    `/api/admin/billing/organization?organizationId=${fleetCompanyId}&section=subscriptions&page=1&pageSize=10`,
    { actorId: ownerId },
  );
  assert.equal(companyProfileSubscriptions.status, 200);
  assert.equal(companyProfileSubscriptions.body.total, 0, "provider subscription must not leak into the company profile");
  const operationsBillingProfile = await request(
    port,
    `/api/admin/billing/organization?organizationId=${providerOrganizationId}&section=subscriptions`,
    { actorId: operationsId },
  );
  assert.equal(operationsBillingProfile.status, 403, "billing profile data remains owner-only");
  const nextProviderVersion = await request(port, `/api/admin/billing/plans/${providerPlan.id}/versions`, {
    actorId: ownerId,
    method: "POST",
    body: {
      displayName: "API provider version after subscription request",
      description: "New isolated version must not rewrite existing request snapshots",
      annualPriceMinor: 650000,
      billingUnit: "branch",
      billingCycle: "annual",
      currency: "EGP",
      effectiveAt: new Date(Date.now() + 86_400_000).toISOString(),
      entitlements: [{ key: "later_right", label: "Later isolated right", value: true, approved: true }],
      settings: [{ key: "later_setting", label: "Later isolated setting", value: 7, approved: true }],
    },
  });
  assert.equal(nextProviderVersion.status, 201);
  assert.ok(subscriptionSnapshotBeforeNewPlanVersion, "the synthetic subscription must have a saved terms snapshot");
  assert.equal(typeof subscriptionPriceBeforeNewPlanVersion, "number");
  const publishedNextProviderVersion = await request(
    port,
    `/api/admin/billing/plans/${providerPlan.id}/versions/${nextProviderVersion.body.id}/publish`,
    {
      actorId: ownerId,
      method: "POST",
      body: { reason: "Synthetic API test: publish future plan version without changing existing subscription" },
    },
  );
  assert.equal(publishedNextProviderVersion.status, 200);
  assert.equal(publishedNextProviderVersion.body.status, "scheduled");
  const subscriptionsAfterNewPlanVersion = await request(
    port,
    `/api/admin/billing/organization?organizationId=${providerOrganizationId}&section=subscriptions&page=1&pageSize=10`,
    { actorId: ownerId },
  );
  assert.equal(subscriptionsAfterNewPlanVersion.status, 200);
  assert.deepEqual(
    subscriptionsAfterNewPlanVersion.body.items[0].planSnapshot,
    subscriptionSnapshotBeforeNewPlanVersion,
    "adding a later plan version must not rewrite the already-saved subscription snapshot",
  );
  assert.equal(
    subscriptionsAfterNewPlanVersion.body.items[0].priceSnapshotMinor,
    subscriptionPriceBeforeNewPlanVersion,
    "later plan prices must not change an existing subscription price snapshot",
  );

  const defaultsUpdated = await request(port, "/api/admin/billing/pricing-defaults", {
    actorId: ownerId,
    method: "PATCH",
    body: {
      companyAnnualPricesMinor: [50000, 75000, 100000],
      providerAnnualPriceMinor: 500000,
      nfcIssuePriceMinor: 10000,
    },
  });
  assert.equal(defaultsUpdated.status, 200);

  const conflatedCustomRequest = await request(port, "/api/admin/billing/subscription-requests", {
    actorId: ownerId,
    method: "POST",
    body: {
      organizationId: providerOrganizationId,
      branchId: providerBranchId,
      requestType: "custom_price",
      currentSubscriptionId: null,
      planId: providerDraft.body.id,
      planVersionId: providerDraft.body.id,
      requestedPriceMinor: 490000,
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      endsAt: new Date(Date.now() + 366 * 86_400_000).toISOString(),
      coverageNote: "Synthetic test",
      reason: "Must not be accepted",
      submit: false,
    },
  });
  assert.equal(conflatedCustomRequest.status, 400, "custom prices must not create subscription requests");

  const financeSummary = await request(port, "/api/admin/finance/summary", {
    actorId: financeId,
  });
  assert.equal(financeSummary.status, 200);
  assert.equal(financeSummary.body.currency, "EGP");
  assert.equal(financeSummary.body.companyFundsMinor, "0");
  assert.equal(financeSummary.body.subscriptionHeldMinor, "0");
  const scopedCompanyAccounts = await request(
    port,
    `/api/admin/finance/organization-accounts?organizationId=${fleetCompanyId}&page=1&pageSize=10`,
    { actorId: financeId },
  );
  assert.equal(scopedCompanyAccounts.status, 200);
  assert.equal(scopedCompanyAccounts.body.accountState, "available");
  assert.equal(scopedCompanyAccounts.body.total, 2);
  assert.equal(scopedCompanyAccounts.body.items.every((item) => item.organizationId === fleetCompanyId), true);
  assert.equal(scopedCompanyAccounts.body.balancesMinor.ledgerBalanceMinor, "0");
  const operationsCompanyAccounts = await request(
    port,
    `/api/admin/finance/organization-accounts?organizationId=${fleetCompanyId}`,
    { actorId: operationsId },
  );
  assert.equal(operationsCompanyAccounts.status, 403, "organization funding statements require finance read permission");

  const operationsTopups = await request(port, "/api/admin/finance/topups", {
    actorId: operationsId,
  });
  assert.equal(operationsTopups.status, 200, "operations can read its submitted top-up queue");
  assert.deepEqual(operationsTopups.body.items, []);
  const operationsTransfer = await request(port, "/api/admin/finance/transfers", {
    actorId: operationsId,
    method: "POST",
    body: {
      organizationId: providerOrganizationId,
      amountMinor: 1,
      reference: "API-OPS-DENIED",
      reason: "Operations must not transfer funds",
      idempotencyKey: "api-ops-transfer-denied",
    },
  });
  assert.equal(operationsTransfer.status, 403, "operations cannot execute financial transfers");

  const auditorReconciliation = await request(port, "/api/admin/finance/reconciliation", {
    actorId: auditorId,
  });
  assert.equal(auditorReconciliation.status, 200, "auditors have read-only reconciliation access");
  assert.equal(auditorReconciliation.body.status, "balanced");
  const supportDenied = await request(port, "/api/admin/finance/summary", {
    actorId: supportId,
  });
  assert.equal(supportDenied.status, 403, "support has no finance visibility");

  const bankPending = await request(port, "/api/admin/finance/bank-accounts", {
    actorId: ownerId,
    method: "POST",
    body: {
      bankName: "API Test Bank",
      displayLabel: "Masked test collection account",
      accountLast4: "0601",
      reason: "Isolated API bank-account configuration",
      idempotencyKey: "api-finance-bank-create",
    },
  });
  assert.equal(bankPending.status, 201);
  assert.equal(bankPending.body.status, "pending");
  const bankApproved = await request(
    port,
    `/api/admin/finance/bank-accounts/${bankPending.body.id}/approve`,
    {
      actorId: financeId,
      method: "POST",
      body: { reason: "Independent API approval", idempotencyKey: "api-finance-bank-approve" },
    },
  );
  assert.equal(bankApproved.status, 200);
  assert.equal(bankApproved.body.status, "active");
  const bankList = await request(port, "/api/admin/finance/bank-accounts", {
    actorId: financeId,
  });
  assert.equal(bankList.status, 200);
  assert.ok(bankList.body.items.some((item) => item.id === bankPending.body.id && item.accountLast4 === "0601"));
  assert.equal("accountNumber" in bankList.body.items[0], false);
  const receipt = await request(port, "/api/admin/finance/receipts", {
    actorId: financeId,
    method: "POST",
    body: {
      organizationId: providerOrganizationId,
      branchId: providerBranchId,
      bankAccountId: bankPending.body.id,
      payerBankName: "بنك اختبار API",
      bankReference: "API-RECEIPT-DETAIL-5000",
      amountMinor: 500000,
      reason: "مطابقة إيصال API محلي",
      confirmedAgainstBank: true,
      idempotencyKey: "api-finance-receipt-record-01",
    },
  });
  assert.equal(receipt.status, 201);
  assert.equal(receipt.body.status, "confirmed");
  const financeReceiptDetail = await request(
    port,
    `/api/admin/finance/receipts/${receipt.body.id}`,
    { actorId: financeId },
  );
  assert.equal(financeReceiptDetail.status, 200);
  assert.equal(financeReceiptDetail.body.bankReference, "API-RECEIPT-DETAIL-5000");
  assert.equal(financeReceiptDetail.body.receivingAccountLast4, "0601");
  assert.equal(financeReceiptDetail.body.journal.debitMinor, "500000");
  assert.equal(financeReceiptDetail.body.journal.creditMinor, "500000");
  assert.equal(financeReceiptDetail.body.journal.lines.length, 2);
  const auditorReceiptDetail = await request(
    port,
    `/api/admin/finance/receipts/${receipt.body.id}`,
    { actorId: auditorId },
  );
  assert.equal(auditorReceiptDetail.status, 200);
  assert.equal(auditorReceiptDetail.body.bankReference, null);
  assert.equal(auditorReceiptDetail.body.receivingAccountLast4, null);
  assert.equal(auditorReceiptDetail.body.maskedReference, "5000");
  const missingReceiptDetail = await request(
    port,
    "/api/admin/finance/receipts/00000000-0000-4000-8000-000000009999",
    { actorId: financeId },
  );
  assert.equal(missingReceiptDetail.status, 404);

  // Onboarding inherits the explicit branch service network. Prepare that
  // prerequisite in the disposable database, never by widening merchant access.
  const branchLimits = { maxOperationMinor: 10000000, maxOperationQuantity: 1000,
    dailyAmountLimitMinor: 10000000, weeklyAmountLimitMinor: 70000000,
    monthlyAmountLimitMinor: 0, dailyQuantityLimit: 0, weeklyQuantityLimit: 0, monthlyQuantityLimit: 0 };
  const branchPolicy = (await withActor(ownerId, `SELECT public.petro_admin_fleet_command(
    'policy.create',$1::jsonb,$2,$3) AS result`, [JSON.stringify({
      scope: "branch", organizationId: fleetCompanyId, branchId: fleetBranchId,
      effectiveFrom: new Date(Date.now() + 60_000).toISOString(),
      allowedWeekdays: [1,2,3,4,5,6,7], startTime: "00:00", endTime: "24:00",
      allowedMerchantOrganizationIds: [providerOrganizationId], allowedMerchantBranchIds: [providerBranchId],
      ...branchLimits,
      rules: ["fuel","wash","oils","parts","batteries","filters","consumables"].map(serviceGroup => ({
        serviceGroup, enabled: true, ...branchLimits,
      })),
    }), "شبكة فرع للاختبار المعزول", "ui-branch-policy-inheritance-fixture"])).rows[0].result;
  await withActor(ownerId, `SELECT public.petro_admin_fleet_command(
    'policy.publish',$1::jsonb,$2,$3)`, [JSON.stringify({policyVersionId: branchPolicy.id}),
    "نشر شبكة اختبار معزول", "ui-branch-policy-inheritance-publish"]);

  const workerPayload={userId:catalogManagerId,branchId:providerBranchId,serviceGroup:"oils",active:true,expectedVersion:0,idempotencyKey:"api-worker-oils-assignment-001"};
  const workerCreate=await request(port,"/api/admin/workforce/assignments",{actorId:ownerId,method:"POST",body:workerPayload});
  assert.equal(workerCreate.status,200,JSON.stringify(workerCreate.body));
  const workerReplay=await request(port,"/api/admin/workforce/assignments",{actorId:ownerId,method:"POST",body:workerPayload});
  assert.deepEqual(workerReplay.body,workerCreate.body);
  const workerOwn=await request(port,"/api/operations/capabilities",{actorId:catalogManagerId});
  assert.equal(workerOwn.status,200);
  assert.ok(workerOwn.body.items.some(item=>item.branchId===providerBranchId&&item.serviceGroup==="oils"));
  assert.equal((await request(port,"/api/admin/workforce",{actorId:catalogManagerId})).status,403);
  assert.equal((await request(port,"/api/admin/workforce/assignments",{actorId:catalogManagerId,method:"POST",body:{...workerPayload,serviceGroup:"wash",idempotencyKey:"api-worker-self-denied-001"}})).status,403);
  assert.equal((await request(port,"/api/admin/workforce/assignments",{actorId:ownerId,method:"POST",body:{...workerPayload,serviceGroup:"fuel",idempotencyKey:"api-worker-provider-fuel-001"}})).status,409);
  assert.equal((await request(port,"/api/admin/workforce/assignments",{actorId:ownerId,method:"POST",body:{...workerPayload,expectedVersion:-1,idempotencyKey:"api-worker-invalid-version-001"}})).status,400);
  assert.equal(workerOwn.body.pinVerificationReady,true,"Worker endpoint must expose runtime PIN readiness without exposing a secret.");
  assert.equal((await request(port,"/api/operations/pair-verifications",{actorId:catalogManagerId,method:"POST",body:{}})).status,400,"Operational verification must validate its HTTP contract.");

  // Disposable fixture only: never forwards to hosted Supabase or creates real accounts.
  const operationToken=randomBytes(32).toString("base64url");
  const operationPin="0042";
  const operationVehicleId="00000000-0000-4000-8000-000000003201";
  const operationTokenHash=createHash("sha256").update(operationToken).digest("hex");
  const operationPinDigest=createHmac("sha256",process.env.SESSION_SECRET).update("pertomax-eg:fleet:driver-pair:v1\0").update(operationVehicleId).update("\0").update(operationPin).digest("hex");
  const operationFixture=new Client({host:process.env.PGHOST,port:Number(process.env.PGPORT),database:process.env.PGDATABASE,user:process.env.PGUSER});
  await operationFixture.connect();
  try {await operationFixture.query(`INSERT INTO public.petro_fleet_vehicles(id,organization_id,branch_id,plate_original,plate_standard,vehicle_category,vehicle_type,brand,model,fuel_type,created_by,updated_by)
VALUES('00000000-0000-4000-8000-000000003201','${fleetCompanyId}','${fleetBranchId}','API-OP-PIN','API-OP-PIN','car','car','test','test','petrol','${ownerId}','${ownerId}');
INSERT INTO public.petro_fleet_drivers(id,organization_id,driver_code,full_name,created_by,updated_by)
VALUES('00000000-0000-4000-8000-000000003202','${fleetCompanyId}','API-OP-DRIVER','سائق تشغيل اختباري','${ownerId}','${ownerId}');
INSERT INTO public.petro_fleet_driver_links(id,organization_id,vehicle_id,driver_id,reason,created_by)
VALUES('00000000-0000-4000-8000-000000003203','${fleetCompanyId}','00000000-0000-4000-8000-000000003201','00000000-0000-4000-8000-000000003202','اختبار تحقق التشغيل','${ownerId}');
INSERT INTO petro_private.petro_fleet_driver_pair_secrets(id,link_id,organization_id,vehicle_id,driver_id,pin_hmac,created_by)
VALUES('00000000-0000-4000-8000-000000003204','00000000-0000-4000-8000-000000003203','${fleetCompanyId}','00000000-0000-4000-8000-000000003201','00000000-0000-4000-8000-000000003202',decode('${operationPinDigest}','hex'),'${ownerId}');
INSERT INTO public.petro_vehicle_credentials(id,organization_id,branch_id,vehicle_id,credential_type,token_sha256,token_hint,status,activated_by,reason)
VALUES('00000000-0000-4000-8000-000000003205','${fleetCompanyId}','${fleetBranchId}','00000000-0000-4000-8000-000000003201','qr','${operationTokenHash}','${operationTokenHash.slice(-6)}','active','${ownerId}','اختبار تعريف التشغيل');
`);} finally {await operationFixture.end();}
  const operationPayload={branchId:providerBranchId,serviceGroup:"oils",credentialToken:operationToken,pinCode:operationPin,idempotencyKey:"api-operation-pair-success-01"};
  const wrongOperation=await request(port,"/api/operations/pair-verifications",{actorId:catalogManagerId,method:"POST",body:{...operationPayload,pinCode:"0043",idempotencyKey:"api-operation-pair-wrong-001"}});
  assert.equal(wrongOperation.status,200,JSON.stringify(wrongOperation.body));
  assert.equal(wrongOperation.body.valid,false);
  assert.equal("vehicle" in wrongOperation.body,false,"Wrong PIN must not disclose vehicle details.");
  assert.equal("driverName" in wrongOperation.body,false);
  const operationGood=await request(port,"/api/operations/pair-verifications",{actorId:catalogManagerId,method:"POST",body:operationPayload});
  assert.equal(operationGood.status,200,JSON.stringify(operationGood.body));
  assert.equal(operationGood.body.valid,true);
  assert.equal(operationGood.body.vehicle.plate,"API-OP-PIN");
  assert.equal("pinCode" in operationGood.body,false);
  assert.equal("pinHmac" in operationGood.body,false);
  const operationReplay=await request(port,"/api/operations/pair-verifications",{actorId:catalogManagerId,method:"POST",body:operationPayload});
  assert.equal(operationReplay.body.verificationId,operationGood.body.verificationId,"Lost-response retry must reuse one proof.");
  const operationRead=await request(port,`/api/operations/pair-verifications/${operationGood.body.verificationId}`,{actorId:catalogManagerId});
  assert.equal(operationRead.body.valid,true);
  const otherRead=await request(port,`/api/operations/pair-verifications/${operationGood.body.verificationId}`,{actorId:ownerId});
  assert.equal(otherRead.body.valid,false,"Proof must belong to its worker even for central owner.");
  assert.equal((await request(port,"/api/operations/pair-verifications",{actorId:ownerId,method:"POST",body:operationPayload})).status,403);
  assert.equal((await request(port,"/api/operations/pair-verifications",{actorId:catalogManagerId,method:"POST",body:{...operationPayload,pinCode:"42"}})).status,400);
  assert.equal((await request(port,"/api/operations/pair-verifications",{actorId:catalogManagerId,method:"POST",body:{...operationPayload,unexpected:true}})).status,400);
  const workerStop=await request(port,"/api/admin/workforce/assignments",{actorId:ownerId,method:"POST",body:{...workerPayload,active:false,expectedVersion:1,idempotencyKey:"api-worker-stop-assignment-001"}});
  assert.equal(workerStop.status,200);
  assert.equal(workerStop.body.version,2);
  const stoppedProof=await request(port,`/api/operations/pair-verifications/${operationGood.body.verificationId}`,{actorId:catalogManagerId});
  assert.equal(stoppedProof.body.valid,false,"Stopping an assignment must immediately invalidate its proofs.");
  const workerRevoked=await request(port,"/api/operations/capabilities",{actorId:catalogManagerId});
  assert.ok(!workerRevoked.body.items.some(item=>item.serviceGroup==="oils"));
  const workerList=await request(port,"/api/admin/workforce?page=1&pageSize=1",{actorId:auditorId});
  assert.equal(workerList.status,200);
  assert.equal(workerList.body.total,1);
  assert.equal(workerList.body.items.length,1);
  assert.equal(workerList.body.canManage,false);

  // Independent covered station/fleet fixtures for actual service quote HTTP and browser checks.
  const quoteWorkerId="00000000-0000-4000-8000-000000003302";
  const quoteToken=randomBytes(32).toString("base64url");
  const quoteTokenHash=createHash("sha256").update(quoteToken).digest("hex");
  const quoteFixtureClient=new Client({host:process.env.PGHOST,port:Number(process.env.PGPORT),database:process.env.PGDATABASE,user:process.env.PGUSER});
  await quoteFixtureClient.connect();
  let quoteFixture;
  let quotePlate;
  try {
   await quoteFixtureClient.query(readFileSync(resolve(repoRoot,"lib/db/rebuild/service-quotation-0033-api-fixture.sql"),"utf8"));
   quoteFixture=(await quoteFixtureClient.query("SELECT ids FROM pg_temp.quote_test")).rows[0].ids;
   quotePlate=(await quoteFixtureClient.query("SELECT plate_original FROM public.petro_fleet_vehicles WHERE id=$1",[quoteFixture.vehicle])).rows[0].plate_original;
   const quoteHmac=createHmac("sha256",process.env.SESSION_SECRET).update("pertomax-eg:fleet:driver-pair:v1\0").update(quoteFixture.vehicle).update("\0").update("0042").digest("hex");
   await quoteFixtureClient.query("UPDATE petro_private.petro_fleet_driver_pair_secrets SET pin_hmac=decode($1,'hex') WHERE vehicle_id=$2 AND active",[quoteHmac,quoteFixture.vehicle]);
   await quoteFixtureClient.query("UPDATE public.petro_vehicle_credentials SET token_sha256=$1,token_hint=$2 WHERE vehicle_id=$3 AND status='active'",[quoteTokenHash,quoteTokenHash.slice(-6),quoteFixture.vehicle]);
   await quoteFixtureClient.query("COMMIT");
  }catch(error){await quoteFixtureClient.query("ROLLBACK").catch(()=>{});throw error;}finally{await quoteFixtureClient.end();}
  actorIds.add(quoteWorkerId);
  const quoteOptions=await request(port,`/api/operations/service-options?proofId=${quoteFixture.fuelProof}`,{actorId:quoteWorkerId});
  assert.equal(quoteOptions.status,200,JSON.stringify(quoteOptions.body));
  assert.equal(quoteOptions.body.total,1);
  assert.equal(quoteOptions.body.items[0].id,quoteFixture.fuel);
  const quoteRequest={proofId:quoteFixture.fuelProof,referenceId:quoteFixture.fuel,priceVersionId:quoteFixture.price,input:{amountMinor:"10000"},locationId:null};
  const quoteResponse=await request(port,"/api/operations/service-quotes",{actorId:quoteWorkerId,method:"POST",body:quoteRequest});
  assert.equal(quoteResponse.status,200,JSON.stringify(quoteResponse.body));
  assert.equal(quoteResponse.body.canReserve,true);
  assert.equal(quoteResponse.body.amountMinor,"10000");
  assert.equal(Number(quoteResponse.body.quantity),8);
  assert.equal((await request(port,"/api/operations/service-quotes",{actorId:ownerId,method:"POST",body:quoteRequest})).status,403);
  assert.equal((await request(port,"/api/operations/service-quotes",{actorId:quoteWorkerId,method:"POST",body:{...quoteRequest,clientPriceMinor:"1"}})).status,400);
  assert.equal((await request(port,"/api/operations/service-quotes",{actorId:quoteWorkerId,method:"POST",body:{...quoteRequest,input:{quantity:"1.0001"}}})).status,400);
  assert.equal((await request(port,`/api/operations/service-options?proofId=${quoteFixture.fuelProof}&pageSize=51`,{actorId:quoteWorkerId})).status,400);


  // Actual service order API gate; no production writes or manufactured claims.
  const reserveInput={...quoteRequest,idempotencyKey:"api-order-reserve-"+randomBytes(12).toString("hex")};
  const reserved=await request(port,"/api/operations/service-orders",{actorId:quoteWorkerId,method:"POST",body:reserveInput});
  assert.equal(reserved.status,200,"Actual service-order API missing or failed: "+JSON.stringify(reserved.body));
  assert.equal(reserved.body.status,"reserved");
  assert.equal(reserved.body.paymentStatus,"held");
  assert.equal(reserved.body.amountMinor,"10000");
  assert.equal(Number(reserved.body.quantity),8);
  const orderId=reserved.body.id;
  const reserveRetry=await request(port,"/api/operations/service-orders",{actorId:quoteWorkerId,method:"POST",body:reserveInput});
  assert.equal(reserveRetry.status,200);
  assert.equal(reserveRetry.body.id,orderId);
  assert.equal((await request(port,"/api/operations/service-orders",{actorId:quoteWorkerId,method:"POST",body:{...reserveInput,input:{amountMinor:"9999"}}})).status,409);
  assert.equal((await request(port,"/api/operations/service-orders",{actorId:quoteWorkerId,method:"POST",body:{...reserveInput,idempotencyKey:"api-order-second-"+randomBytes(12).toString("hex")}})).status,403);
  assert.equal((await request(port,"/api/operations/service-orders",{actorId:quoteWorkerId,method:"POST",body:{...reserveInput,amountMinor:"1"}})).status,400);
  assert.equal((await request(port,`/api/operations/service-orders/${orderId}`,{actorId:quoteWorkerId})).body.id,orderId);
  const centralOrders=await request(port,"/api/admin/service-orders",{actorId:ownerId});
  assert.equal(centralOrders.status,200);
  assert.equal(centralOrders.body.canManage,true);
  assert.ok(centralOrders.body.items.some(item=>item.id===orderId));
  assert.equal((await request(port,"/api/admin/service-orders",{actorId:quoteWorkerId})).status,403);
  assert.equal((await request(port,"/api/admin/service-orders",{actorId:auditorId})).status,200);
  assert.equal((await request(port,`/api/admin/service-orders/${orderId}/cancel`,{actorId:auditorId,method:"POST",body:{expectedVersion:1,idempotencyKey:"auditor-order-cancel-0001"}})).status,403);
  assert.equal((await request(port,`/api/operations/service-orders/${orderId}`,{actorId:[...actorIds][1]})).status,403);
  assert.equal((await request(port,"/api/operations/service-orders?view=central",{actorId:quoteWorkerId})).status,400);
  assert.equal((await request(port,"/api/operations/service-orders?pageSize=51",{actorId:quoteWorkerId})).status,400);
  const cancelInput={expectedVersion:reserved.body.version,idempotencyKey:"api-order-cancel-"+randomBytes(12).toString("hex")};
  assert.equal((await request(port,`/api/operations/service-orders/${orderId}/cancel`,{actorId:quoteWorkerId,method:"POST",body:{...cancelInput,expectedVersion:99}})).status,409);
  const cancelled=await request(port,`/api/operations/service-orders/${orderId}/cancel`,{actorId:quoteWorkerId,method:"POST",body:cancelInput});
  assert.equal(cancelled.status,200,JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.status,"cancelled");
  assert.equal(cancelled.body.paymentStatus,"unpaid");
  assert.equal((await request(port,`/api/operations/service-orders/${orderId}/cancel`,{actorId:quoteWorkerId,method:"POST",body:cancelInput})).body.version,cancelled.body.version);
  const history=await request(port,`/api/operations/service-orders/${orderId}`,{actorId:quoteWorkerId});
  assert.deepEqual(history.body.timeline.map(event=>event.kind),["reserved","cancelled"]);
  assert.equal(history.body.cancelledByKind,"user");

  const executionCapabilities=(await request(port,"/api/operations/capabilities",{actorId:quoteWorkerId})).body.items;
  const executionBranch=executionCapabilities.find(item=>item.serviceGroup==="fuel").branchId;
  const newExecutionProof=(await request(port,"/api/operations/pair-verifications",{actorId:quoteWorkerId,method:"POST",body:{branchId:executionBranch,serviceGroup:"fuel",credentialToken:quoteToken,pinCode:"0042",idempotencyKey:"http-execution-proof-"+randomBytes(12).toString("hex")}})).body;
  assert.equal(newExecutionProof.valid,true);
  const newExecutionOrder=await request(port,"/api/operations/service-orders",{actorId:quoteWorkerId,method:"POST",body:{...quoteRequest,proofId:newExecutionProof.verificationId,idempotencyKey:"http-execution-reserve-"+randomBytes(12).toString("hex")}});
  assert.equal(newExecutionOrder.status,200);
  const executionId=newExecutionOrder.body.id;
  const startBody={expectedVersion:1,idempotencyKey:"http-execution-start-0001"};
  assert.equal((await request(port,`/api/operations/service-orders/${executionId}/start`,{actorId:ownerId,method:"POST",body:startBody})).status,403);
  assert.equal((await request(port,`/api/admin/service-orders/${executionId}/execution`,{actorId:quoteWorkerId})).status,403);
  assert.equal((await request(port,`/api/operations/service-orders/${executionId}/start`,{actorId:quoteWorkerId,method:"POST",body:{...startBody,expectedVersion:99}})).status,409);
  const started=await request(port,`/api/operations/service-orders/${executionId}/start`,{actorId:quoteWorkerId,method:"POST",body:startBody});
  assert.equal(started.status,200,JSON.stringify(started.body));
  assert.equal(started.body.status,"in_progress");
  assert.equal((await request(port,`/api/operations/service-orders/${executionId}/start`,{actorId:quoteWorkerId,method:"POST",body:startBody})).body.version,2);
  const meterBytes=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTE0AAAAASUVORK5CYII=","base64");
  const meterIntentBody={kind:"odometer",fileName:"actual-meter.png",contentType:"image/png",byteSize:meterBytes.length,idempotencyKey:"http-execution-meter-0001"};
  const meterIntent=await request(port,`/api/operations/service-orders/${executionId}/evidence`,{actorId:quoteWorkerId,method:"POST",body:meterIntentBody});
  assert.equal(meterIntent.status,200,JSON.stringify(meterIntent.body));
  assert.equal((await request(port,`/api/operations/service-orders/${executionId}/evidence`,{actorId:quoteWorkerId,method:"POST",body:meterIntentBody})).body.id,meterIntent.body.id);
  const meterContent=`/api/operations/service-order-evidence/${meterIntent.body.id}/content`;
  const meterUpload=await request(port,meterContent,{actorId:quoteWorkerId,method:"PUT",rawBody:meterBytes,headers:{"content-type":"application/octet-stream"}});
  assert.equal(meterUpload.status,200,JSON.stringify(meterUpload.body));
  assert.equal((await request(port,meterContent,{actorId:quoteWorkerId,method:"PUT",rawBody:meterBytes,headers:{"content-type":"application/octet-stream"}})).status,200,"Same image retry must not duplicate/overwrite");
  const download=await request(port,`/api/operations/service-order-evidence/${meterIntent.body.id}/download`,{actorId:quoteWorkerId});
  assert.equal(download.status,200);
  assert.equal((await request(port,`/api/operations/service-order-evidence/${meterIntent.body.id}/download`,{actorId:targetId})).status,403);
  const deliverBody={expectedVersion:2,input:{actualQuantity:"7",readingKm:"1500"},idempotencyKey:"http-execution-deliver-01"};
  assert.equal((await request(port,`/api/operations/service-orders/${executionId}/deliver`,{actorId:quoteWorkerId,method:"POST",body:{...deliverBody,input:{...deliverBody.input,actualQuantity:"9"}}})).status,409);
  const delivered=await request(port,`/api/operations/service-orders/${executionId}/deliver`,{actorId:quoteWorkerId,method:"POST",body:deliverBody});
  assert.equal(delivered.status,200,JSON.stringify(delivered.body));
  assert.equal(delivered.body.status,"delivered");
  assert.equal(delivered.body.paymentStatus,"held");
  assert.equal(delivered.body.delivery.actualAmountMinor,"8750");
  assert.equal((await request(port,`/api/operations/service-orders/${executionId}/deliver`,{actorId:quoteWorkerId,method:"POST",body:deliverBody})).body.version,3);
  assert.equal((await request(port,`/api/operations/service-orders/${executionId}/cancel`,{actorId:quoteWorkerId,method:"POST",body:{expectedVersion:3,idempotencyKey:"http-delivered-cancel-01"}})).status,409);
  const executionRead=await request(port,`/api/admin/service-orders/${executionId}/execution`,{actorId:auditorId});
  assert.equal(executionRead.status,200);
  assert.equal(executionRead.body.canDeliver,false);
  console.log("PASS: actual execution HTTP start, private image upload/retry/download, scoped denial, immutable partial delivery and held-payment separation.");

  console.log("PASS: actual order HTTP booking, consumed-proof replay, payload conflict, role isolation, CAS cancellation, reload and truthful timeline.");


  const paymentUrl=`/api/operations/service-orders/${executionId}/confirm`;
  const confirmation={expectedVersion:3,pinCode:"0042",idempotencyKey:"http-confirm-payment-0001"};
  assert.equal((await request(port,paymentUrl,{actorId:ownerId,method:"POST",body:confirmation})).status,403);
  assert.equal((await request(port,paymentUrl,{actorId:quoteWorkerId,method:"POST",body:{...confirmation,pinCode:"42"}})).status,400);
  assert.equal((await request(port,paymentUrl,{actorId:quoteWorkerId,method:"POST",body:{...confirmation,amountMinor:"1"}})).status,400);
  const wrongConfirmation={...confirmation,pinCode:"9999",idempotencyKey:"http-confirm-wrong-0001"};
  const wrongFinal=await request(port,paymentUrl,{actorId:quoteWorkerId,method:"POST",body:wrongConfirmation});
  assert.equal(wrongFinal.status,200,JSON.stringify(wrongFinal.body));assert.equal(wrongFinal.body.valid,false);
  assert.deepEqual((await request(port,paymentUrl,{actorId:quoteWorkerId,method:"POST",body:wrongConfirmation})).body,wrongFinal.body);
  const finalPayment=await request(port,paymentUrl,{actorId:quoteWorkerId,method:"POST",body:confirmation});
  assert.equal(finalPayment.status,200,JSON.stringify(finalPayment.body));assert.equal(finalPayment.body.paid,true);
  assert.equal(finalPayment.body.payment.chargedAmountMinor,"8750");assert.equal(finalPayment.body.payment.releasedAmountMinor,"1250");
  assert.equal(finalPayment.body.payment.receipt.snapshot.documentKind,"service_receipt");
  assert.deepEqual((await request(port,paymentUrl,{actorId:quoteWorkerId,method:"POST",body:confirmation})).body,finalPayment.body);
  const auditPayment=await request(port,`/api/admin/service-orders/${executionId}/payment`,{actorId:auditorId});
  assert.equal(auditPayment.status,200);assert.equal(auditPayment.body.payment.receipt.number,finalPayment.body.payment.receipt.number);
  assert.equal(auditPayment.body.pinConfirmationReady,false);
  assert.equal((await request(port,`/api/admin/service-orders/${executionId}/payment`,{actorId:quoteWorkerId})).status,403);
  assert.equal((await request(port,`/api/operations/service-orders/${executionId}/payment`,{actorId:targetId})).status,403);
  console.log("PASS: final-payment HTTP strict inputs, real HMAC PIN denial/replay, actual capture/release/receipt and central read-only permission.");

  failNextStorageUpload = true;
  failNextOrderReserveResponse=true;failNextOrderCancelResponse=true;failNextDeliveryResponse=true;failNextConfirmationResponse=true;
  const adminUiResult = await runAdminUiLocalSmoke({
    repoRoot,
    apiPort: port,
    projectRef,
    ownerId,
    setStorageSignFailure: () => { failNextStorageSign = true; },
    workerVerification: {workerId:quoteWorkerId,token:quoteToken,pin:"0042",plate:quotePlate,quote:true},
  });
  const browserOrders=await request(port,"/api/operations/service-orders",{actorId:quoteWorkerId});
  assert.equal(browserOrders.status,200);
  assert.equal(browserOrders.body.total,4,"Lost HTTP responses must not create another booking");
  assert.equal(browserOrders.body.items.filter(order=>order.status==="cancelled"&&order.paymentStatus==="unpaid").length,2);
  assert.equal(browserOrders.body.items.filter(order=>order.status==="delivered"&&order.paymentStatus==="paid").length,2);
  assert.equal(failNextConfirmationResponse,false);
  assert.equal(failNextDeliveryResponse,false);
  assert.equal(failNextOrderReserveResponse,false);
  assert.equal(failNextOrderCancelResponse,false);
  const uiPlans = await request(port, "/api/admin/billing/catalog", { actorId: ownerId });
  assert.equal(uiPlans.status, 200);
  const uiPlan = uiPlans.body.plans.find((item) => item.code === adminUiResult.planCode);
  assert.ok(uiPlan, "Plan created and edited through the browser was not persisted.");
  assert.equal(uiPlan.versions[0].annualPriceMinor, 52575);
  assert.equal(uiPlan.versions[0].entitlements[0].label, "ميزة واجهة اختبارية");
  assert.equal(uiPlan.versions[0].entitlements[0].value, "متاحة");
  assert.equal(uiPlan.versions[0].entitlements[0].approved, true);
  assert.equal(uiPlan.versions[0].settings[0].label, "حد واجهة اختباري");
  assert.equal(uiPlan.versions[0].settings[0].value, 25);
  assert.equal(uiPlan.versions[0].settings[0].approved, true);
  const uiFuel = await request(
    port,
    `/api/admin/catalog/fuel?page=1&pageSize=20&search=${encodeURIComponent(adminUiResult.fuelCode)}`,
    { actorId: ownerId },
  );
  assert.equal(uiFuel.status, 200);
  const uiFuelRow = uiFuel.body.items.find((item) => item.code === adminUiResult.fuelCode);
  assert.ok(uiFuelRow, "Fuel type created and priced through the browser was not persisted.");
  assert.equal(uiFuelRow.unitCode, "litre");
  const uiFuelDraft = uiFuelRow.priceHistory.find((item) => item.status === "draft");
  assert.ok(uiFuelDraft, "Fuel price draft saved from the browser was not persisted.");
  assert.equal(Number(uiFuelDraft.pricePerUnit), 4.2375);

  console.log(
    `API integration passed: 0008 user administration and billing; platform-user creation, reset and role catalog; finance receipt/journal and masking; fleet/catalog scopes; inventory real HTTP/RPC path with ${inventoryApiAssertions} focused assertions covering role and tenant denial, location and product lists, exact decimal quantities, opening-balance uniqueness, count-version conflicts, linked returns, reorder alerts and summaries, status filtering/sorting, signed adjustments, document/movement details, idempotency, atomic insufficient-stock rejection, concurrent reservations, and post-commit retry. All writes used local synthetic fixtures.`,
  );
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
