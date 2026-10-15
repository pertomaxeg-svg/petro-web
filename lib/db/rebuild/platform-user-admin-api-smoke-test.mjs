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
]);
let simulatePre0008 = true;

process.env["NODE_ENV"] = "test";
process.env["SUPABASE_URL"] = approvedOrigin;
process.env["SUPABASE_ANON_KEY"] = "sb_publishable_localtest";

const routerBundle = resolve(apiRoot, "dist/platform-user-admin-test.mjs");
const billingRouterBundle = resolve(apiRoot, "dist/platform-billing-admin-test.mjs");
mkdirSync(resolve(apiRoot, "dist"), { recursive: true });
for (const [entryPoint, outfile] of [
  [resolve(apiRoot, "src/routes/management.ts"), routerBundle],
  [resolve(apiRoot, "src/routes/billing.ts"), billingRouterBundle],
]) {
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["express", "@supabase/ssr"],
  });
}

const { default: managementRouter } = await import(pathToFileURL(routerBundle).href);
const { default: billingRouter } = await import(pathToFileURL(billingRouterBundle).href);

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
         ($3::uuid, 'api-operations@example.invalid', '{"username":"api_operations","display_name":"API Operations"}', now())`,
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
       VALUES ($1::uuid, 'owner', true), ($2::uuid, 'operations', true)`,
      [...actorIds].slice(0, 1).concat([...actorIds].slice(2)),
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
const app = express();
app.use(cookieParser());
app.use(express.json({ limit: "32kb" }));
app.use("/api", managementRouter);
app.use("/api", billingRouter);
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

  const directory = await request(port, "/api/admin/platform-users?page=1&pageSize=2", {
    actorId: ownerId,
  });
  assert.equal(directory.status, 200);
  assert.equal(directory.body.total, 3);
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

  console.log(
    "API integration passed: 0008 session/directory/role/status checks; owner-only billing catalog; draft creation/edit; separate provider branch-price scheduling; and request-type separation. All writes used local synthetic fixtures.",
  );
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
