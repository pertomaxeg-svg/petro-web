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
  "00000000-0000-4000-8000-000000000607",
]);
let simulatePre0008 = true;

process.env["NODE_ENV"] = "test";
process.env["SUPABASE_URL"] = approvedOrigin;
process.env["SUPABASE_ANON_KEY"] = "sb_publishable_localtest";

const routerBundle = resolve(apiRoot, "dist/platform-user-admin-test.mjs");
const billingRouterBundle = resolve(apiRoot, "dist/platform-billing-admin-test.mjs");
const financeRouterBundle = resolve(apiRoot, "dist/platform-finance-admin-test.mjs");
const fleetRouterBundle = resolve(apiRoot, "dist/platform-fleet-admin-test.mjs");
const catalogRouterBundle = resolve(apiRoot, "dist/platform-catalog-admin-test.mjs");
mkdirSync(resolve(apiRoot, "dist"), { recursive: true });
for (const [entryPoint, outfile] of [
  [resolve(apiRoot, "src/routes/management.ts"), routerBundle],
  [resolve(apiRoot, "src/routes/billing.ts"), billingRouterBundle],
  [resolve(apiRoot, "src/routes/finance.ts"), financeRouterBundle],
  [resolve(apiRoot, "src/routes/fleet.ts"), fleetRouterBundle],
  [resolve(apiRoot, "src/routes/catalog.ts"), catalogRouterBundle],
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
const { default: catalogRouter } = await import(pathToFileURL(catalogRouterBundle).href);

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
    const profileIds = parseInFilter(filter);
    try {
      if (profileIds.length) {
        const result = await withActor(
          actorId,
          "SELECT user_id, display_name, username, active, account_status FROM public.petro_profiles WHERE user_id = ANY($1::uuid[])",
          [profileIds],
        );
        return jsonResponse(result.rows);
      }
      const result = await withActor(actorId,
        "SELECT active, account_status FROM public.petro_profiles WHERE user_id = $1::uuid",
        [profileId]);
      const row = result.rows[0] ?? null;
      if (headers.get("accept")?.includes("vnd.pgrst.object+json")) return row ? jsonResponse(row) : jsonResponse({ message: "No rows" }, 406);
      return jsonResponse(row ? [row] : []);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "XX000";
      return jsonResponse({ code, message: String(error?.message ?? "DB error") }, errorStatus(code));
    }
  }
  if (path === "/rest/v1/petro_organizations" && method === "GET") {
    const filter = url.searchParams.get("id") ?? "";
    const organizationId = filter.startsWith("eq.") ? filter.slice(3) : "";
    const organizationIds = parseInFilter(filter);
    try {
      const result = organizationIds.length
        ? await withActor(actorId,
          "SELECT id, name, code FROM public.petro_organizations WHERE id = ANY($1::uuid[])",
          [organizationIds])
        : await withActor(actorId,
          "SELECT id, name, code FROM public.petro_organizations WHERE id = $1::uuid",
          [organizationId]);
      const row = result.rows[0] ?? null;
      return headers.get("accept")?.includes("vnd.pgrst.object+json")
        ? row ? jsonResponse(row) : jsonResponse({ message: "No rows" }, 406)
        : jsonResponse(organizationIds.length ? result.rows : row ? [row] : []);
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
          ($6::uuid, 'api-support@example.invalid', '{"username":"api_support","display_name":"API Support"}', now()),
          ($7::uuid, 'api-catalog-manager@example.invalid', '{"username":"api_catalog_manager","display_name":"مسؤول كتالوج اختبار"}', now())`,
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
app.use("/api", managementRouter);
app.use("/api", billingRouter);
app.use("/api", financeRouter);
app.use("/api", fleetRouter);
app.use("/api", catalogRouter);
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
  const catalogFuel = await request(port, "/api/admin/catalog/fuel?page=1&pageSize=20", { actorId: ownerId });
  assert.equal(catalogFuel.status, 200, "owner should read configured fuel types and reference-price history");
  assert.ok(catalogFuel.body.items.some((item) => item.code === "gasoline_92"),
    "fuel endpoint should return the configured 92-octane type");
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
      attributes: { vehicleTypes: ["نوع اختبار"], durationMinutes: 20, included: "اختبار محلي" },
    },
    reason: "اختبار API معزول",
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
  assert.equal(directory.body.total, 7);
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

  console.log(
    "API integration passed: 0008 user administration and billing; finance role gates, receipt detail with balanced journal lines, auditor masking, missing-resource handling, top-up queue, masked bank account setup with independent approval, and read-only auditor reconciliation. All writes used local synthetic fixtures.",
  );
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
}
