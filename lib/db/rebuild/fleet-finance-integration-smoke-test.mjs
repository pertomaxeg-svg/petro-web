// End-to-end local integration against the actual fleet and finance SQL
// contracts. The caller creates and discards a throwaway PostgreSQL cluster.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const dbRequire = createRequire(resolve(repoRoot, "lib/db/package.json"));
const { Client } = dbRequire("pg");
const owner = "00000000-0000-4000-8000-000000001601";
let merchantOrganization;
let merchantBranch;
let followupChecks = 0;

function checkEqual(actual, expected, message) {
  assert.equal(actual, expected, message);
  followupChecks += 1;
}

function checkOk(value, message) {
  assert.ok(value, message);
  followupChecks += 1;
}

async function checkRejected(promise, code, message) {
  await assert.rejects(promise, (error) => error.code === code, message);
  followupChecks += 1;
}

function client() {
  return new Client({
    host: process.env["PGHOST"],
    port: Number(process.env["PGPORT"]),
    database: process.env["PGDATABASE"],
    user: process.env["PGUSER"],
  });
}

async function inRole(role, actor, callback) {
  const db = client();
  await db.connect();
  try {
    await db.query("BEGIN");
    await db.query(`SET LOCAL ROLE ${role}`);
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor]);
    if (role === "service_role") {
      await db.query("SELECT set_config('request.jwt.claim.role','service_role',true)");
    }
    const value = await callback(db);
    await db.query("COMMIT");
    return value;
  } catch (error) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await db.end();
  }
}

async function verify(linkId, pinHmac) {
  return inRole("authenticated", owner, async (db) => {
    const result = await db.query(
      "SELECT public.petro_admin_fleet_verify_driver_pair($1::uuid,$2) AS result",
      [linkId, pinHmac],
    );
    assert.equal(result.rows[0].result.valid, true);
    return result.rows[0].result.verificationId;
  });
}

function reserve(vehicle, pair, amountMinor, key, pin) {
  return inRole("service_role", owner, async (db) => {
    const result = await db.query(
      `SELECT public.petro_fleet_reserve_usage(
        $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,
        'fuel',$6::bigint,1::numeric,$7,'تكامل أسطول محلي لاختبار الحجز',$8::uuid
      ) AS result`,
      [vehicle.id, vehicle.link_id, pair, merchantOrganization, merchantBranch, amountMinor, key, owner],
    );
    return result.rows[0].result;
  });
}

const admin = client();
await admin.connect();
let vehicles;
let branchAccount;
try {
  const result = await admin.query(
    `SELECT vehicle.id, vehicle.internal_code,
            link.id AS link_id,
            organization.id AS organization_id,
            branch.id AS branch_id
       FROM public.petro_fleet_vehicles vehicle
       JOIN public.petro_organizations organization ON organization.id=vehicle.organization_id
       JOIN public.petro_branches branch ON branch.id=vehicle.branch_id
       JOIN public.petro_fleet_driver_links link ON link.vehicle_id=vehicle.id AND link.status='active'
      WHERE organization.code='FLEET-IT-A'
       AND vehicle.internal_code IN ('FLEET-IT-A-1','FLEET-IT-A-2','FLEET-IT-A-3')
      ORDER BY vehicle.internal_code`,
  );
  vehicles = result.rows;
  assert.equal(vehicles.length, 3, "three covered synthetic company vehicles must exist");
  const merchant = await admin.query(
    `SELECT organization.id AS organization_id, branch.id AS branch_id
       FROM public.petro_organizations organization
       JOIN public.petro_branches branch ON branch.organization_id=organization.id
      WHERE organization.code='FLEET-IT-M' AND branch.code='FLEET-IT-M1'`,
  );
  assert.equal(merchant.rowCount, 1);
  merchantOrganization = merchant.rows[0].organization_id;
  merchantBranch = merchant.rows[0].branch_id;
  const account = await admin.query(
    `SELECT id FROM public.petro_finance_accounts
      WHERE organization_id=$1::uuid AND branch_id=$2::uuid AND account_kind='branch_funding'`,
    [vehicles[0].organization_id, vehicles[0].branch_id],
  );
  assert.equal(account.rowCount, 1);
  branchAccount = account.rows[0].id;
} finally {
  await admin.end();
}

const driverListResult = await inRole("authenticated", owner, (db) => db.query(
  `SELECT public.petro_admin_fleet_catalog('drivers',
    '{"query":"FLEET-IT-D1","page":1,"pageSize":20}'::jsonb) AS result`,
));
const driverRows = driverListResult.rows[0].result.items;
checkEqual(driverRows.length, 1, "driver fixture must be reachable through the authorized catalog");
const driverDetailResult = await inRole("authenticated", owner, (db) => db.query(
  "SELECT public.petro_admin_fleet_driver_detail($1::uuid) AS detail",
  [driverRows[0].id],
));
const driverDetail = driverDetailResult.rows[0].detail;
checkEqual(driverDetail.links.length, 1, "driver detail must include its scoped dated vehicle link");
checkEqual(
  Date.parse(driverDetail.links[0].startsAt),
  Date.parse("2024-07-01T12:00:00Z"),
  "driver link must preserve the submitted start timestamp",
);
checkOk(
  ![...Object.keys(driverDetail), ...Object.keys(driverDetail.links[0])]
    .some((key) => /pin|hmac|secret/i.test(key)),
  "driver detail must not disclose a PIN, verifier, or secret",
);

const unauthenticated = client();
await unauthenticated.connect();
try {
  await unauthenticated.query("BEGIN");
  await unauthenticated.query("SET LOCAL ROLE authenticated");
  await unauthenticated.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
  await unauthenticated.query("SAVEPOINT before_reserve_denial");
  await assert.rejects(
    unauthenticated.query(
      `SELECT public.petro_fleet_reserve_usage(
        $1::uuid,$2::uuid,gen_random_uuid(),$3::uuid,$4::uuid,
        'fuel',100,1,'fleet-it-auth-denied-0001','اختبار صلاحية', $5::uuid
      )`,
      [vehicles[0].id, vehicles[0].link_id, merchantOrganization, merchantBranch, owner],
    ),
    (error) => error.code === "42501",
    "authenticated human role must not have direct access to internal reservation",
  );
  await unauthenticated.query("ROLLBACK TO SAVEPOINT before_reserve_denial");
  await unauthenticated.query("SAVEPOINT before_consume_denial");
  await assert.rejects(
    unauthenticated.query(
      `SELECT public.petro_fleet_consume_usage(
        gen_random_uuid(),gen_random_uuid(),$1::uuid
      )`,
      [owner],
    ),
    (error) => error.code === "42501",
    "authenticated human role must not have direct access to internal consumption",
  );
  await unauthenticated.query("ROLLBACK TO SAVEPOINT before_consume_denial");
  await unauthenticated.query("ROLLBACK");
} finally {
  await unauthenticated.end();
}

const check = client();
await check.connect();
try {
  const policy = await check.query(
    `SELECT petro_private.fleet_check_usage_policy(
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,'fuel',1000,1
    ) AS fuel,
    petro_private.fleet_check_usage_policy(
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,'oils',1000,1
    ) AS oils`,
    [vehicles[0].id, vehicles[0].link_id, merchantOrganization, merchantBranch],
  );
  assert.equal(policy.rows[0].fuel.allowed, true, "covered fuel path should satisfy intersected policy");
  assert.equal(policy.rows[0].oils.allowed, false, "disabled oils must not borrow the fuel limit");
  assert.equal(policy.rows[0].oils.reason, "service_group_not_allowed");
} finally {
  await check.end();
}

// A rolled-back attempt must leave neither usage record nor finance reservation.
const rollbackPair = await verify(vehicles[0].link_id, "a".repeat(64));
const rollbackClient = client();
await rollbackClient.connect();
try {
  await rollbackClient.query("BEGIN");
  await rollbackClient.query("SET LOCAL ROLE service_role");
  await rollbackClient.query("SELECT set_config('request.jwt.claim.role','service_role',true)");
  await rollbackClient.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner]);
  await rollbackClient.query(
    `SELECT public.petro_fleet_reserve_usage(
      $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,
      'fuel',200000,1,'fleet-it-precommit-retry-0001','اختبار فشل قبل الحفظ',$6::uuid
    )`,
    [vehicles[0].id, vehicles[0].link_id, rollbackPair, merchantOrganization, merchantBranch, owner],
  );
  await rollbackClient.query("ROLLBACK");
} finally {
  await rollbackClient.end();
}

const afterRollback = client();
await afterRollback.connect();
try {
  const rows = await afterRollback.query(
    `SELECT count(*)::integer AS count FROM public.petro_fleet_usage_reservations
      WHERE organization_id=$1::uuid AND request_key='fleet-it-precommit-retry-0001'`,
    [vehicles[0].organization_id],
  );
  assert.equal(rows.rows[0].count, 0, "rolled-back reservation must leave no durable half-state");
} finally {
  await afterRollback.end();
}

const savedPair = await verify(vehicles[0].link_id, "a".repeat(64));
const saved = await reserve(vehicles[0], savedPair, 200000, "fleet-it-precommit-retry-0001");
assert.equal(saved.status, "reserved");
assert.equal(saved.replayed, false);
// Model a committed reply lost in transit: retry by the same key and payload.
const replay = await reserve(vehicles[0], savedPair, 200000, "fleet-it-precommit-retry-0001");
assert.equal(replay.id, saved.id);
assert.equal(replay.replayed, true);
await assert.rejects(
  reserve(vehicles[0], savedPair, 200001, "fleet-it-precommit-retry-0001"),
  (error) => error.code === "23505",
  "same idempotency key with a changed amount must be refused",
);

const sameKeyPair = await verify(vehicles[0].link_id, "a".repeat(64));
const sameKey = "fleet-it-concurrent-idempotency-0001";
const sameKeyResults = await Promise.all([
  reserve(vehicles[0], sameKeyPair, 100000, sameKey),
  reserve(vehicles[0], sameKeyPair, 100000, sameKey),
]);
assert.equal(sameKeyResults[0].id, sameKeyResults[1].id);
assert.equal(sameKeyResults.filter((result) => result.replayed === false).length, 1);
assert.equal(sameKeyResults.filter((result) => result.replayed === true).length, 1);

// Competing accounts/policy windows are serialized by the real reservation RPC.
const pairOne = await verify(vehicles[0].link_id, "a".repeat(64));
const pairTwo = await verify(vehicles[1].link_id, "b".repeat(64));
const competed = await Promise.allSettled([
  reserve(vehicles[0], pairOne, 400000, "fleet-it-funds-race-a-0001"),
  reserve(vehicles[1], pairTwo, 400000, "fleet-it-funds-race-b-0001"),
]);
assert.equal(competed.filter((result) => result.status === "fulfilled").length, 1);
assert.equal(competed.filter((result) => result.status === "rejected").length, 1);
const failedRace = competed.find((result) => result.status === "rejected");
assert.equal(failedRace.reason.code, "23514");
assert.match(failedRace.reason.message, /INSUFFICIENT_AVAILABLE_FUNDS/);

const balance = client();
await balance.connect();
try {
  const beforeRelease = await balance.query(
    `SELECT ledger_balance_minor,reserved_minor,available_minor
       FROM public.petro_finance_account_balances WHERE account_id=$1::uuid`,
    [branchAccount],
  );
  assert.equal(Number(beforeRelease.rows[0].ledger_balance_minor), 1000000);
  assert.equal(Number(beforeRelease.rows[0].reserved_minor), 700000);
  assert.equal(Number(beforeRelease.rows[0].available_minor), 300000);
  const releaseResult = await balance.query(
    `SELECT id FROM public.petro_fleet_usage_reservations
      WHERE request_key='fleet-it-precommit-retry-0001'`,
  );
  assert.equal(releaseResult.rowCount, 1);
  await inRole("service_role", owner, async (db) => {
    const released = await db.query(
      "SELECT public.petro_fleet_release_usage($1::uuid,$2::uuid) AS result",
      [releaseResult.rows[0].id, owner],
    );
    assert.equal(released.rows[0].result.status, "released");
    const repeated = await db.query(
      "SELECT public.petro_fleet_release_usage($1::uuid,$2::uuid) AS result",
      [releaseResult.rows[0].id, owner],
    );
    assert.equal(repeated.rows[0].result.replayed, true);
  });
  const afterRelease = await balance.query(
    `SELECT ledger_balance_minor,reserved_minor,available_minor
       FROM public.petro_finance_account_balances WHERE account_id=$1::uuid`,
    [branchAccount],
  );
  assert.equal(Number(afterRelease.rows[0].ledger_balance_minor), 1000000);
  assert.equal(Number(afterRelease.rows[0].reserved_minor), 500000);
  assert.equal(Number(afterRelease.rows[0].available_minor), 500000);
  assert.ok(Number(afterRelease.rows[0].available_minor) >= 0);

  const usage = await balance.query(
    `SELECT usage.id, usage.finance_reservation_id, usage.organization_id,
            reservation.source_id, reservation.amount_minor
       FROM public.petro_fleet_usage_reservations usage
       JOIN public.petro_finance_reservations reservation ON reservation.id=usage.finance_reservation_id
      WHERE usage.request_key IN ('fleet-it-funds-race-a-0001','fleet-it-funds-race-b-0001')
        AND usage.status='reserved'`,
  );
  assert.equal(usage.rowCount, 1);
  const control = await balance.query(
    "SELECT id FROM public.petro_finance_accounts WHERE account_code='SYS-MERCHANT-PAYABLE'",
  );
  assert.equal(control.rowCount, 1);
  const journalEntryId = (await balance.query("SELECT gen_random_uuid() AS id")).rows[0].id;
  await balance.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [owner]);
  const entry = await balance.query(
    `SELECT petro_private.finance_post_entry(
      $1::uuid,'reservation_consumption',$2::uuid,$3::uuid,$4,$5,$6::jsonb
    ) AS id`,
    [
      journalEntryId,
      usage.rows[0].source_id,
      usage.rows[0].organization_id,
      "FLEET-IT-CONSUME-2000",
      "قيد متوازن اصطناعي لاختبار استهلاك حجز الأسطول",
      JSON.stringify([
        { accountId: branchAccount, side: "debit", amountMinor: String(usage.rows[0].amount_minor) },
        { accountId: control.rows[0].id, side: "credit", amountMinor: String(usage.rows[0].amount_minor) },
      ]),
    ],
  );
  assert.equal(entry.rows[0].id, journalEntryId);
  await inRole("service_role", owner, async (db) => {
    const consumed = await db.query(
      "SELECT public.petro_fleet_consume_usage($1::uuid,$2::uuid,$3::uuid) AS result",
      [usage.rows[0].id, journalEntryId, owner],
    );
    assert.equal(consumed.rows[0].result.status, "consumed");
    assert.equal(consumed.rows[0].result.replayed, false);
    const repeated = await db.query(
      "SELECT public.petro_fleet_consume_usage($1::uuid,$2::uuid,$3::uuid) AS result",
      [usage.rows[0].id, journalEntryId, owner],
    );
    assert.equal(repeated.rows[0].result.replayed, true);
  });
  const afterConsume = await balance.query(
    `SELECT ledger_balance_minor,reserved_minor,available_minor
       FROM public.petro_finance_account_balances WHERE account_id=$1::uuid`,
    [branchAccount],
  );
  assert.equal(Number(afterConsume.rows[0].ledger_balance_minor), 600000);
  assert.equal(Number(afterConsume.rows[0].reserved_minor), 100000);
  assert.equal(Number(afterConsume.rows[0].available_minor), 500000);
} finally {
  await balance.end();
}

const summaries = client();
await summaries.connect();
let branchA2;
let branchB1;
try {
  const directory = await inRole("authenticated", owner, async (db) => {
    const result = await db.query(
      "SELECT public.petro_admin_fleet_company_summaries(NULL,'FLEET-IT-A',1,20) AS result",
    );
    return result.rows[0].result;
  });
  checkEqual(directory.items.length, 1, "company directory must filter by the requested code");
  checkEqual(directory.items[0].code, "FLEET-IT-A", "company directory must return the actual company");
  checkEqual(directory.items[0].vehicleCount, 3, "company vehicle count must come from the isolated fixture");
  checkOk(Number(directory.nfcIssuePriceMinor) > 0, "NFC issue price must come from configured billing settings");

  const organizationId = vehicles[0].organization_id;
  const detail = await inRole("authenticated", owner, async (db) => {
    const result = await db.query(
      "SELECT public.petro_admin_fleet_company_summaries($1::uuid,NULL,1,20) AS result",
      [organizationId],
    );
    return result.rows[0].result;
  });
  checkEqual(detail.branchTotal, 2, "company detail must include the two actual branches");
  checkEqual(detail.branches.length, 2, "company detail branch page must contain both branches");

  const branchResult = await summaries.query(
    "SELECT id FROM public.petro_branches WHERE organization_id=$1::uuid AND code='FLEET-IT-A2'",
    [organizationId],
  );
  checkEqual(branchResult.rowCount, 1, "second same-company branch fixture must exist");
  branchA2 = branchResult.rows[0].id;
  const foreignBranch = await summaries.query(
    "SELECT branch.id FROM public.petro_branches branch JOIN public.petro_organizations organization ON organization.id=branch.organization_id WHERE organization.code='FLEET-IT-B' AND branch.code='FLEET-IT-B1'",
  );
  checkEqual(foreignBranch.rowCount, 1, "cross-company branch fixture must exist");
  branchB1 = foreignBranch.rows[0].id;

  const authenticatedActor = await inRole("authenticated", owner, async (db) => {
    const identity = await db.query("SELECT auth.uid()::text AS actor");
    return identity.rows[0].actor;
  });
  checkEqual(authenticatedActor, owner, "rate writes must use the authenticated owner claim as the audited actor");

  const rate = await inRole("authenticated", owner, async (db) => {
    const savedRate = await db.query(
      "SELECT public.petro_admin_fleet_set_consumption_rate($1::uuid,NULL,8.125,'معدل شركة اصطناعي للاختبار','fleet-it-rate-company-v1') AS result",
      [organizationId],
    );
    const replay = await db.query(
      "SELECT public.petro_admin_fleet_set_consumption_rate($1::uuid,NULL,8.125,'معدل شركة اصطناعي للاختبار','fleet-it-rate-company-v1') AS result",
      [organizationId],
    );
    return { saved: savedRate.rows[0].result, replayed: replay.rows[0].result };
  });
  checkEqual(rate.saved.version, 1, "first company rate must create version one");
  checkEqual(rate.saved.litersPer100Km, 8.125, "rate must preserve thousandth precision");
  checkEqual(rate.replayed.id, rate.saved.id, "same idempotency request must return the original rate");
  checkEqual(rate.replayed.replayed, true, "same idempotency request must be marked as replayed");
  await checkRejected(
    inRole("authenticated", owner, (db) => db.query(
      "SELECT public.petro_admin_fleet_set_consumption_rate($1::uuid,NULL,9.125,'معدل مختلف','fleet-it-rate-company-v1')",
      [organizationId],
    )),
    "23505",
    "changed rate payload must not reuse an idempotency key",
  );

  const branchRate = await inRole("authenticated", owner, async (db) => {
    const saved = await db.query(
      "SELECT public.petro_admin_fleet_set_consumption_rate($1::uuid,$2::uuid,9.5,'تخصيص فرع اصطناعي للاختبار','fleet-it-rate-branch-v1') AS result",
      [organizationId, branchA2],
    );
    const effective = await db.query(
      "SELECT public.petro_admin_fleet_consumption_rates($1::uuid,$2::uuid) AS result",
      [organizationId, branchA2],
    );
    return { saved: saved.rows[0].result, effective: effective.rows[0].result };
  });
  checkEqual(branchRate.saved.scope, "branch", "branch override must be scoped to the selected branch");
  checkEqual(branchRate.effective.current.litersPer100Km, 9.5, "branch override must be the effective rate");
  checkEqual(branchRate.effective.history.length, 2, "branch history must include branch and company versions");
  await checkRejected(
    inRole("authenticated", owner, (db) => db.query(
      "SELECT public.petro_admin_fleet_set_consumption_rate($1::uuid,$2::uuid,7,'فرع شركة أخرى','fleet-it-rate-cross-scope-001')",
      [organizationId, branchB1],
    )),
    "23514",
    "rate must reject a branch belonging to another company scope",
  );
  await checkRejected(
    inRole("authenticated", "00000000-0000-4000-8000-000000001699", (db) => db.query(
      "SELECT public.petro_admin_fleet_set_consumption_rate($1::uuid,NULL,7,'غير مخول','fleet-it-rate-denied-0001')",
      [organizationId],
    )),
    "42501",
    "an authenticated user without fleet management role must not write rate versions",
  );
  await checkRejected(
    inRole("authenticated", owner, (db) => db.query(
      "SELECT * FROM public.petro_fleet_consumption_rate_versions LIMIT 1",
    )),
    "42501",
    "fleet managers must not directly read the protected rate-version table",
  );
} finally {
  await summaries.end();
}

const movedVehicle = vehicles[2];
await inRole("authenticated", owner, async (db) => {
  await db.query(
    "SELECT public.petro_admin_fleet_command('odometer.record',$1::jsonb,'قراءة عداد اصطناعية قبل النقل','fleet-it-move-odo-0001')",
    [JSON.stringify({ vehicleId: movedVehicle.id, readingKm: 12000, recordedAt: new Date().toISOString(), source: "synthetic" })],
  );
  await db.query(
    "SELECT public.petro_admin_fleet_command('maintenance.create',$1::jsonb,'صيانة اصطناعية قبل النقل','fleet-it-move-service-0001')",
    [JSON.stringify({ vehicleId: movedVehicle.id, maintenanceType: "oil", performedAt: new Date().toISOString(), notes: "isolated fixture", nextDueKm: 24000 })],
  );
  await db.query(
    "SELECT public.petro_admin_fleet_command('credential.request',$1::jsonb,'طلب بطاقة اصطناعي قبل النقل','fleet-it-move-card-0001')",
    [JSON.stringify({ vehicleId: movedVehicle.id, credentialType: "qr", requestType: "issue" })],
  );
});

const movePair = await verify(movedVehicle.link_id, "c".repeat(64));
const moveReservation = await reserve(
  movedVehicle,
  movePair,
  100000,
  "fleet-it-branch-move-reserved-0001",
);
checkEqual(moveReservation.status, "reserved", "move fixture must reserve real branch funds before the move");

const beforeMove = client();
await beforeMove.connect();
let currentPolicyVersion;
let financeAccountCountBefore;
try {
  const current = await beforeMove.query(
    "SELECT version FROM public.petro_fleet_vehicles WHERE id=$1::uuid",
    [movedVehicle.id],
  );
  const policy = await beforeMove.query(
    "SELECT id,version_no FROM public.petro_fleet_policy_versions WHERE vehicle_id=$1::uuid AND scope_kind='vehicle' ORDER BY version_no",
    [movedVehicle.id],
  );
  currentPolicyVersion = policy.rows[0].id;
  checkEqual(policy.rows.length, 1, "pre-move vehicle must have one immutable policy version");
  const accountCount = await beforeMove.query(
    "SELECT count(*)::integer AS count FROM public.petro_finance_accounts WHERE organization_id=$1::uuid AND account_kind='branch_funding'",
    [movedVehicle.organization_id],
  );
  financeAccountCountBefore = accountCount.rows[0].count;
  const blockedPayload = {
    vehicleId: movedVehicle.id,
    targetBranchId: branchA2,
    expectedVersion: current.rows[0].version,
  };
  await checkRejected(
    inRole("authenticated", owner, (db) => db.query(
      "SELECT public.petro_admin_fleet_command('vehicle.move',$1::jsonb,'محاولة نقل أثناء حجز نشط','fleet-it-move-blocked-0001')",
      [JSON.stringify(blockedPayload)],
    )),
    "23514",
    "vehicle move must be blocked while a service reservation is active",
  );

  const nextPolicy = await beforeMove.query(
    `INSERT INTO public.petro_fleet_policy_versions(
       id,organization_id,branch_id,vehicle_id,scope_kind,version_no,status,effective_from,
       allowed_weekdays,start_time,end_time,allowed_merchant_organization_ids,
       allowed_merchant_branch_ids,max_operation_minor,max_operation_quantity,
       daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
       daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit,
       reason,created_by,published_by,published_at
     )
     SELECT gen_random_uuid(),organization_id,branch_id,vehicle_id,scope_kind,2,'published',now()-interval '1 second',
       allowed_weekdays,start_time,end_time,allowed_merchant_organization_ids,
       allowed_merchant_branch_ids,max_operation_minor,max_operation_quantity,
       daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
       daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit,
       'نسخة سياسة جديدة أثناء حجز اصطناعي',created_by,created_by,now()
     FROM public.petro_fleet_policy_versions
     WHERE id=$1::uuid
     RETURNING id`,
    [currentPolicyVersion],
  );
  checkEqual(nextPolicy.rowCount, 1, "a new published policy version must append without rewriting history");
  await beforeMove.query(
    `INSERT INTO public.petro_fleet_policy_rules(
       policy_version_id,service_group,enabled,max_operation_minor,max_operation_quantity,
       daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
       daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit
     )
     SELECT $1::uuid,service_group,enabled,max_operation_minor,max_operation_quantity,
       daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
       daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit
     FROM public.petro_fleet_policy_rules
     WHERE policy_version_id=$2::uuid`,
    [nextPolicy.rows[0].id, currentPolicyVersion],
  );
  const evaluation = await beforeMove.query(
    `SELECT petro_private.fleet_check_usage_policy(
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,'fuel',1000,1
     ) AS result`,
    [movedVehicle.id, movedVehicle.link_id, merchantOrganization, merchantBranch],
  );
  checkEqual(
    evaluation.rows[0].result.allowed,
    true,
    `current effective policy must still allow an in-limit operation: ${JSON.stringify(evaluation.rows[0].result)}`,
  );
  checkEqual(
    evaluation.rows[0].result.vehiclePolicyVersionId,
    nextPolicy.rows[0].id,
    "policy evaluation must use the newly effective version",
  );
  const cairoClock = await beforeMove.query(
    `SELECT extract(isodow FROM now() AT TIME ZONE 'Africa/Cairo')::smallint AS weekday,
            (now() AT TIME ZONE 'Africa/Cairo')::time AS local_time`,
  );
  const cairoWeekday = Number(cairoClock.rows[0].weekday);
  const excludedWeekday = cairoWeekday === 1 ? 7 : cairoWeekday - 1;
  const blockedWeekdayPolicy = await beforeMove.query(
    `INSERT INTO public.petro_fleet_policy_versions(
       id,organization_id,branch_id,vehicle_id,scope_kind,version_no,status,effective_from,
       allowed_weekdays,start_time,end_time,allowed_merchant_organization_ids,
       allowed_merchant_branch_ids,max_operation_minor,max_operation_quantity,
       daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
       daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit,
       reason,created_by,published_by,published_at
     )
     SELECT gen_random_uuid(),organization_id,branch_id,vehicle_id,scope_kind,3,'published',now()-interval '1 second',
       ARRAY[$2::smallint],start_time,end_time,allowed_merchant_organization_ids,
       allowed_merchant_branch_ids,max_operation_minor,max_operation_quantity,
       daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
       daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit,
       'اختبار يوم القاهرة السابق',created_by,created_by,now()
     FROM public.petro_fleet_policy_versions WHERE id=$1::uuid RETURNING id`,
    [nextPolicy.rows[0].id, excludedWeekday],
  );
  await beforeMove.query(
    `INSERT INTO public.petro_fleet_policy_rules(
       policy_version_id,service_group,enabled,max_operation_minor,max_operation_quantity,
       daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
       daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit
     )
     SELECT $1::uuid,service_group,enabled,max_operation_minor,max_operation_quantity,
       daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
       daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit
     FROM public.petro_fleet_policy_rules WHERE policy_version_id=$2::uuid`,
    [blockedWeekdayPolicy.rows[0].id, nextPolicy.rows[0].id],
  );
  const blockedByCairoWeekday = await beforeMove.query(
    `SELECT petro_private.fleet_check_usage_policy(
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,'fuel',1000,1
     ) AS result`,
    [movedVehicle.id, movedVehicle.link_id, merchantOrganization, merchantBranch],
  );
  checkEqual(
    blockedByCairoWeekday.rows[0].result.reason,
    "outside_allowed_schedule",
    "policy weekday evaluation must use Africa/Cairo rather than server-local weekday",
  );

  const allowedCairoPolicy = await beforeMove.query(
    `INSERT INTO public.petro_fleet_policy_versions(
       id,organization_id,branch_id,vehicle_id,scope_kind,version_no,status,effective_from,
       allowed_weekdays,start_time,end_time,allowed_merchant_organization_ids,
       allowed_merchant_branch_ids,max_operation_minor,max_operation_quantity,
       daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
       daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit,
       reason,created_by,published_by,published_at
     )
     SELECT gen_random_uuid(),organization_id,branch_id,vehicle_id,scope_kind,4,'published',now()-interval '1 second',
       ARRAY[$2::smallint],
       CASE WHEN $3::time > time '00:01' THEN $3::time - interval '1 minute' ELSE time '00:00' END,
       CASE WHEN $3::time < time '23:58' THEN $3::time + interval '1 minute' ELSE time '23:59:59.999999' END,
       allowed_merchant_organization_ids,allowed_merchant_branch_ids,
       max_operation_minor,max_operation_quantity,daily_amount_limit_minor,
       weekly_amount_limit_minor,monthly_amount_limit_minor,daily_quantity_limit,
       weekly_quantity_limit,monthly_quantity_limit,'اختبار وقت القاهرة الحالي',
       created_by,created_by,now()
     FROM public.petro_fleet_policy_versions WHERE id=$1::uuid RETURNING id`,
    [blockedWeekdayPolicy.rows[0].id, cairoWeekday, cairoClock.rows[0].local_time],
  );
  await beforeMove.query(
    `INSERT INTO public.petro_fleet_policy_rules(
       policy_version_id,service_group,enabled,max_operation_minor,max_operation_quantity,
       daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
       daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit
     )
     SELECT $1::uuid,service_group,enabled,max_operation_minor,max_operation_quantity,
       daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
       daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit
     FROM public.petro_fleet_policy_rules WHERE policy_version_id=$2::uuid`,
    [allowedCairoPolicy.rows[0].id, nextPolicy.rows[0].id],
  );
  const allowedAtCairoWindow = await beforeMove.query(
    `SELECT petro_private.fleet_check_usage_policy(
       $1::uuid,$2::uuid,$3::uuid,$4::uuid,'fuel',1000,1
     ) AS result`,
    [movedVehicle.id, movedVehicle.link_id, merchantOrganization, merchantBranch],
  );
  checkEqual(
    allowedAtCairoWindow.rows[0].result.vehiclePolicyVersionId,
    allowedCairoPolicy.rows[0].id,
    "policy evaluation must use the active Africa/Cairo weekday and local-time window",
  );

  const cairoBoundaries = await beforeMove.query(
    `SELECT
       (date_trunc('day',now() AT TIME ZONE 'Africa/Cairo') + interval '1 day') AT TIME ZONE 'Africa/Cairo' AS day_start,
       (date_trunc('week',now() AT TIME ZONE 'Africa/Cairo') + interval '1 week') AT TIME ZONE 'Africa/Cairo' AS week_start,
       (date_trunc('month',now() AT TIME ZONE 'Africa/Cairo') + interval '1 month') AT TIME ZONE 'Africa/Cairo' AS month_start`,
  );
  const boundaries = cairoBoundaries.rows[0];
  const periodCases = [
    { name: "day", boundary: boundaries.day_start, offsetMs: -1000,
      dayLimit: 150000, weekLimit: 1000000, monthLimit: 1000000, allowed: true },
    { name: "week", boundary: boundaries.week_start, offsetMs: 3600000,
      dayLimit: 1000000, weekLimit: 150000, monthLimit: 1000000, allowed: false },
    { name: "month", boundary: boundaries.month_start, offsetMs: 3600000,
      dayLimit: 1000000, weekLimit: 1000000, monthLimit: 150000, allowed: false },
  ].sort((left, right) => left.boundary.getTime() - right.boundary.getTime());
  for (const [index, period] of periodCases.entries()) {
    const asOf = new Date(period.boundary.getTime() + 2 * 3600000 + index * 15 * 60000);
    const eventAt = new Date(period.boundary.getTime() + period.offsetMs);
    await beforeMove.query(
      `UPDATE public.petro_fleet_usage_reservations SET created_at=$1::timestamptz
        WHERE request_key='fleet-it-branch-move-reserved-0001'`,
      [eventAt.toISOString()],
    );
    const periodPolicy = await beforeMove.query(
      `INSERT INTO public.petro_fleet_policy_versions(
         id,organization_id,branch_id,vehicle_id,scope_kind,version_no,status,effective_from,
         allowed_weekdays,start_time,end_time,allowed_merchant_organization_ids,
         allowed_merchant_branch_ids,max_operation_minor,max_operation_quantity,
         daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
         daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit,
         reason,created_by,published_by,published_at
       )
       SELECT gen_random_uuid(),organization_id,branch_id,vehicle_id,scope_kind,$2,'published',$3::timestamptz,
         ARRAY[1,2,3,4,5,6,7]::smallint[],'00:00','23:59:59.999999',
         allowed_merchant_organization_ids,allowed_merchant_branch_ids,
         max_operation_minor,max_operation_quantity,$4::bigint,$5::bigint,$6::bigint,
         daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit,
         $7,created_by,created_by,$3::timestamptz
       FROM public.petro_fleet_policy_versions WHERE id=$1::uuid RETURNING id`,
      [
        allowedCairoPolicy.rows[0].id,
        5 + index,
        new Date(asOf.getTime() - 60000).toISOString(),
        period.dayLimit,
        period.weekLimit,
        period.monthLimit,
        `حد ${period.name} اصطناعي لاختبار بداية فترة القاهرة`,
      ],
    );
    await beforeMove.query(
      `INSERT INTO public.petro_fleet_policy_rules(
         policy_version_id,service_group,enabled,max_operation_minor,max_operation_quantity,
         daily_amount_limit_minor,weekly_amount_limit_minor,monthly_amount_limit_minor,
         daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit
       )
       SELECT $1::uuid,service_group,enabled,max_operation_minor,max_operation_quantity,
         CASE WHEN service_group='fuel' THEN $2::bigint ELSE daily_amount_limit_minor END,
         CASE WHEN service_group='fuel' THEN $3::bigint ELSE weekly_amount_limit_minor END,
         CASE WHEN service_group='fuel' THEN $4::bigint ELSE monthly_amount_limit_minor END,
         daily_quantity_limit,weekly_quantity_limit,monthly_quantity_limit
       FROM public.petro_fleet_policy_rules WHERE policy_version_id=$5::uuid`,
      [
        periodPolicy.rows[0].id,
        period.dayLimit,
        period.weekLimit,
        period.monthLimit,
        allowedCairoPolicy.rows[0].id,
      ],
    );
    const periodResult = await beforeMove.query(
      `SELECT petro_private.fleet_check_usage_policy_at(
         $1::uuid,$2::uuid,$3::uuid,$4::uuid,'fuel',100000,1,$5::timestamptz
       ) AS result`,
      [movedVehicle.id, movedVehicle.link_id, merchantOrganization, merchantBranch, asOf.toISOString()],
    );
    checkEqual(
      periodResult.rows[0].result.allowed,
      period.allowed,
      `${period.name} limit must use the Africa/Cairo period start: ${JSON.stringify(periodResult.rows[0].result)}`,
    );
    const selectedPolicy = await beforeMove.query(
      `SELECT id FROM public.petro_fleet_policy_versions
        WHERE vehicle_id=$1::uuid AND scope_kind='vehicle' AND status='published'
          AND effective_from<=$2::timestamptz
        ORDER BY effective_from DESC,version_no DESC LIMIT 1`,
      [movedVehicle.id, asOf.toISOString()],
    );
    checkEqual(
      selectedPolicy.rows[0].id,
      periodPolicy.rows[0].id,
      `${period.name} evaluation must select the policy effective at its simulated instant`,
    );
    if (!period.allowed) {
      checkEqual(
        periodResult.rows[0].result.reason,
        "vehicle_total_limit_exceeded",
        `${period.name} boundary denial must be caused by that period's total limit`,
      );
    }
  }

  const historic = await beforeMove.query(
    `SELECT usage.branch_id,usage.vehicle_policy_version_id,usage.status
       FROM public.petro_fleet_usage_reservations usage
      WHERE usage.request_key='fleet-it-branch-move-reserved-0001'`,
  );
  checkEqual(historic.rowCount, 1, "reserved operation must remain traceable by its request key");
  checkEqual(historic.rows[0].vehicle_policy_version_id, currentPolicyVersion, "reservation must retain the policy version it used");
  checkEqual(historic.rows[0].branch_id, movedVehicle.branch_id, "reservation must retain its original branch snapshot");

  await inRole("service_role", owner, async (db) => {
    const released = await db.query(
      "SELECT public.petro_fleet_release_usage($1::uuid,$2::uuid) AS result",
      [moveReservation.id, owner],
    );
    checkEqual(released.rows[0].result.status, "released", "reservation release must complete before moving");
  });
  const moved = await inRole("authenticated", owner, async (db) => {
    const result = await db.query(
      "SELECT public.petro_admin_fleet_command('vehicle.move',$1::jsonb,'نقل مركبة اصطناعي داخل الشركة','fleet-it-move-success-0001') AS result",
      [JSON.stringify({ ...blockedPayload, expectedVersion: current.rows[0].version })],
    );
    return result.rows[0].result;
  });
  checkEqual(moved.branchId, branchA2, "authorized move must update the current branch");
  checkEqual(moved.historyPreserved, true, "move command must report preserved history");

  const snapshots = await beforeMove.query(
    `SELECT
       (SELECT count(*)::integer FROM public.petro_fleet_policy_versions WHERE vehicle_id=$1::uuid AND branch_id=$2::uuid) AS policy_count,
       (SELECT count(*)::integer FROM public.petro_vehicle_odometer_events WHERE vehicle_id=$1::uuid AND branch_id=$2::uuid) AS odometer_count,
       (SELECT count(*)::integer FROM public.petro_vehicle_maintenance_records WHERE vehicle_id=$1::uuid AND branch_id=$2::uuid) AS maintenance_count,
       (SELECT count(*)::integer FROM public.petro_fleet_credential_requests WHERE vehicle_id=$1::uuid AND branch_id=$2::uuid) AS card_request_count,
       (SELECT count(*)::integer FROM public.petro_fleet_usage_reservations WHERE vehicle_id=$1::uuid AND branch_id=$2::uuid) AS usage_count`,
    [movedVehicle.id, movedVehicle.branch_id],
  );
  for (const field of ["policy_count", "odometer_count", "maintenance_count", "card_request_count", "usage_count"]) {
    checkOk(snapshots.rows[0][field] > 0, `${field} must retain its original branch snapshot`);
  }
  const movedAccountCount = await beforeMove.query(
    "SELECT count(*)::integer AS count FROM public.petro_finance_accounts WHERE organization_id=$1::uuid AND account_kind='branch_funding'",
    [movedVehicle.organization_id],
  );
  checkEqual(movedAccountCount.rows[0].count, financeAccountCountBefore, "vehicle move must not create or transfer a vehicle wallet");
} finally {
  await beforeMove.end();
}

console.log(`Fleet-finance integration passed: baseline policy/coverage/funding and finance concurrency checks; ${followupChecks} follow-up assertions for company/branch summaries, configured NFC price, scoped versioned consumption rates, idempotency and permission denial, reserved-move blocking, policy-version snapshot, and historic branch snapshots on synthetic PostgreSQL data.`);
