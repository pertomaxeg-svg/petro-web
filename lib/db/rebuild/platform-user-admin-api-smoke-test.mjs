// Exercises the actual Express management router against the isolated PostgreSQL
// cluster. A local fake Supabase HTTP transport maps Auth/PostgREST calls to that
// cluster; it never forwards a request to the approved hosted Supabase URL.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { request as httpRequest } from "node:http";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
]);
let simulatePre0008 = true;

process.env["NODE_ENV"] = "test";
process.env["SUPABASE_URL"] = approvedOrigin;
process.env["SUPABASE_ANON_KEY"] = "sb_publishable_localtest";

const routerBundle = resolve(apiRoot, "dist/platform-user-admin-test.mjs");
const billingRouterBundle = resolve(apiRoot, "dist/platform-billing-admin-test.mjs");
const financeRouterBundle = resolve(apiRoot, "dist/platform-finance-admin-test.mjs");
const fleetRouterBundle = resolve(apiRoot, "dist/platform-fleet-admin-test.mjs");
mkdirSync(resolve(apiRoot, "dist"), { recursive: true });
for (const [entryPoint, outfile] of [
  [resolve(apiRoot, "src/routes/management.ts"), routerBundle],
  [resolve(apiRoot, "src/routes/billing.ts"), billingRouterBundle],
  [resolve(apiRoot, "src/routes/finance.ts"), financeRouterBundle],
  [resolve(apiRoot, "src/routes/fleet.ts"), fleetRouterBundle],
]) {
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["express", "@supabase/ssr", "exceljs"],
  });
}

const { default: managementRouter } = await import(pathToFileURL(routerBundle).href);
const { default: billingRouter } = await import(pathToFileURL(billingRouterBundle).href);
const { default: financeRouter } = await import(pathToFileURL(financeRouterBundle).href);
const { default: fleetRouter } = await import(pathToFileURL(fleetRouterBundle).href);

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
    return typeof claims.sub === "string" && actorIds.has(claims.sub)
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

  if (!actorId) return jsonResponse({ message: "Missing test session" }, 401);
  if (path === "/rest/v1/petro_profiles" && method === "GET") {
    const filter = url.searchParams.get("user_id") ?? "";
    const profileId = filter.startsWith("eq.") ? filter.slice(3) : "";
    try {
      const result = await withActor(
        actorId,
        "SELECT active, account_status FROM public.petro_profiles WHERE user_id = $1::uuid",
        [profileId],
      );
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

function request(port, path, { actorId, method = "GET", body } = {}) {
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  const auth = actorId ? authCookie(actorId) : null;
  return new Promise((resolveRequest, rejectRequest) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          ...(auth ? { cookie: auth.cookie } : {}),
          ...(bodyText
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(bodyText),
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
            rejectRequest(new Error(`API returned non-JSON response: ${text.slice(0, 100)}`));
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
         ($6::uuid, 'api-support@example.invalid', '{"username":"api_support","display_name":"API Support"}', now())`,
      [...actorIds],
    );
    await client.query(
      `UPDATE public.petro_profiles
       SET active = true, account_status = 'active'
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
app.use("/api", managementRouter);
app.use("/api", billingRouter);
app.use("/api", financeRouter);
app.use("/api", fleetRouter);
const server = app.listen(0, "127.0.0.1");

try {
  await new Promise((resolveListen, rejectListen) => {
    server.once("listening", resolveListen);
    server.once("error", rejectListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  const [ownerId, targetId, operationsId] = [...actorIds];
  const [, , , financeId, auditorId, supportId] = [...actorIds];

  const preMigration = await request(port, "/api/admin/platform-users", {
    actorId: ownerId,
  });
  assert.equal(
    preMigration.status,
    503,
    "pre-0008 callers should receive a clear staged-feature response",
  );
  simulatePre0008 = false;

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
      startsAt: "2024-07-01T12:00:00Z",
    },
    reason: "ربط سائق اختبار API دون رمز اختياري",
    idempotencyKey: "api-fleet-driver-link-001",
  };
  const linkCreated = await request(port, "/api/admin/fleet/commands", {
    actorId: ownerId,
    method: "POST",
    body: linkCreateBody,
  });
  assert.equal(linkCreated.status, 200);
  assert.ok(linkCreated.body.id);
  const linkReplay = await request(port, "/api/admin/fleet/commands", {
    actorId: ownerId,
    method: "POST",
    body: linkCreateBody,
  });
  assert.equal(linkReplay.status, 200);
  assert.equal(linkReplay.body.id, linkCreated.body.id);
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
  assert.equal(directory.body.total, 6);
  assert.equal(directory.body.items.length, 2);
  assert.equal(directory.body.pageSize, 2);

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
      annualPriceMinor: 63500,
      billingUnit: "vehicle",
      billingCycle: "annual",
      currency: "EGP",
      effectiveAt: new Date(Date.now() + 60_000).toISOString(),
      entitlements: [{ key: "api_right", label: "API test right", value: true, approved: false }],
      settings: [],
      reason: "Isolated API plan creation",
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
  assert.equal(createdPlan.versions[0].annualPriceMinor, 63500);
  assert.equal("nfcIssuePriceMinor" in createdPlan.versions[0], false);

  const updatedDraft = await request(
    port,
    `/api/admin/billing/plans/${createdPlanId}/versions/${createdPlan.versions[0].id}`,
    {
      actorId: ownerId,
      method: "PATCH",
      body: {
        displayName: "API company draft revised",
        description: "Updated synthetic API draft",
        annualPriceMinor: 64500,
        billingUnit: "vehicle",
        billingCycle: "annual",
        currency: "EGP",
        effectiveAt: new Date(Date.now() + 120_000).toISOString(),
        entitlements: [{ key: "api_right", label: "API test right", value: true, approved: true }],
        settings: [],
        reason: "Isolated API draft edit",
      },
    },
  );
  assert.equal(updatedDraft.status, 200);
  assert.equal(updatedDraft.body.status, "draft");

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

  const defaultsUpdated = await request(port, "/api/admin/billing/pricing-defaults", {
    actorId: ownerId,
    method: "PATCH",
    body: {
      companyAnnualPricesMinor: [50000, 75000, 100000],
      providerAnnualPriceMinor: 500000,
      nfcIssuePriceMinor: 10000,
      reason: "Isolated API defaults no-op",
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

  console.log(
    "API integration passed: 0008 user administration and billing; finance role gates, receipt detail with balanced journal lines, auditor masking, missing-resource handling, top-up queue, masked bank account setup with independent approval, and read-only auditor reconciliation. All writes used local synthetic fixtures.",
  );
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
