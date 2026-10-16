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
        AND vehicle.internal_code IN ('FLEET-IT-A-1','FLEET-IT-A-2')
      ORDER BY vehicle.internal_code`,
  );
  vehicles = result.rows;
  assert.equal(vehicles.length, 2, "two covered synthetic company vehicles must exist");
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

console.log("Fleet-finance integration passed: real policy/coverage/funding contracts, user-role denial, transaction rollback, post-commit replay, payload/reason conflict, same-key race, competing available-funds race, non-borrowing service group, release and balanced consumption replay on synthetic PostgreSQL data.");
