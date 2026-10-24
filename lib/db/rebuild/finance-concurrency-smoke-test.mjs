// Local-only concurrency tests; the temporary PostgreSQL cluster is discarded after the suite.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const dbRequire = createRequire(resolve(repoRoot, "lib/db/package.json"));
const { Client } = dbRequire("pg");
const ids = {
  owner: "00000000-0000-4000-8000-000000001301",
  finance: "00000000-0000-4000-8000-000000001302",
  reviewer: "00000000-0000-4000-8000-000000001303",
};

function createClient() {
  return new Client({
    host: process.env["PGHOST"],
    port: Number(process.env["PGPORT"]),
    database: process.env["PGDATABASE"],
    user: process.env["PGUSER"],
  });
}

async function withActor(actorId, sql, params = []) {
  const client = createClient();
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actorId]);
    const result = await client.query(sql, params);
    await client.query("COMMIT");
    return result.rows[0]?.result ?? null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function withActorAndDropCommittedReply(actorId, sql, params = []) {
  const committedResult = await withActor(actorId, sql, params);
  const error = new Error("Synthetic client disconnect after database commit");
  error.code = "ECONNRESET";
  error.committedResult = committedResult;
  throw error;
}

const admin = createClient();
await admin.connect();
let organizationId;
let firstBranchId;
let secondBranchId;
let bankId;
let topupId;
try {
  await admin.query(
    `INSERT INTO auth.users (id,email,raw_user_meta_data,email_confirmed_at) VALUES
      ($1,'finance-race-owner@example.invalid','{"username":"race_owner"}',now()),
      ($2,'finance-race-reviewer@example.invalid','{"username":"race_reviewer"}',now()),
      ($3,'finance-race-finance@example.invalid','{"username":"race_finance"}',now())
     ON CONFLICT (id) DO NOTHING`,
    [ids.owner, ids.reviewer, ids.finance],
  );
  await admin.query(
    "UPDATE public.petro_profiles SET active=true,account_status='active' WHERE user_id=ANY($1::uuid[])",
    [[ids.owner, ids.finance, ids.reviewer]],
  );
  await admin.query(
    `INSERT INTO public.petro_platform_roles(user_id,role,active) VALUES
      ($1,'owner',true),($2,'finance',true),($3,'finance',true)
     ON CONFLICT (user_id,role) DO UPDATE SET active=true`,
    [ids.owner, ids.finance, ids.reviewer],
  );
} finally {
  await admin.end();
}

organizationId = (
  await withActor(
    ids.owner,
    `SELECT public.petro_create_organization_details(
      'شركة سباق مالي معزول','company','FIN-RACE-COMPANY',NULL,
      'مسؤول اختبار','+201000001301','finance-race@example.invalid','عنوان اختبار'
    ) AS result`,
  )
);
await withActor(ids.owner, "SELECT public.petro_approve_organization($1::uuid,1,$2) AS result", [
  organizationId,
  "اعتماد شركة اختبار التزامن",
]);
await withActor(ids.owner, "SELECT public.petro_set_organization_operational_status($1::uuid,2,'active',$2) AS result", [
  organizationId,
  "تفعيل شركة اختبار التزامن",
]);

firstBranchId = await withActor(
  ids.owner,
  `SELECT public.petro_create_branch_details(
    $1::uuid,'FIN-RACE-B1','فرع اختبار أول','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول الفرع الأول','+201000001311'
  ) AS result`,
  [organizationId],
);
secondBranchId = await withActor(
  ids.owner,
  `SELECT public.petro_create_branch_details(
    $1::uuid,'FIN-RACE-B2','فرع اختبار ثان','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول الفرع الثاني','+201000001312'
  ) AS result`,
  [organizationId],
);
for (const branchId of [firstBranchId, secondBranchId]) {
  await withActor(ids.owner, "SELECT public.petro_approve_branch($1::uuid,$2::uuid,1,$3) AS result", [
    organizationId,
    branchId,
    "اعتماد فرع اختبار التزامن",
  ]);
  await withActor(ids.owner, "SELECT public.petro_set_branch_operational_status($1::uuid,$2::uuid,2,'active',$3) AS result", [
    organizationId,
    branchId,
    "تفعيل فرع اختبار التزامن",
  ]);
}

const pendingBank = await withActor(
  ids.owner,
  "SELECT public.petro_finance_admin_add_bank_account($1,$2,$3,$4,$5) AS result",
  ["بنك اختبار التزامن", "وجهة تحصيل محلية", "1301", "إعداد وجهة اختبار", "race-bank-create-01"],
);
bankId = pendingBank.id;
await withActor(ids.finance, "SELECT public.petro_finance_admin_approve_bank_account($1::uuid,$2,$3) AS result", [
  bankId,
  "اعتماد مستقل لوجهة الاختبار",
  "race-bank-approve-01",
]);

const topup = await withActor(
  ids.owner,
  `SELECT public.petro_finance_admin_create_topup(
    $1::uuid,1000000,'بنك الشركة','FIN-RACE-TOPUP-10000',
    'طلب شحن محلي لاختبار التزامن','race-topup-create-01'
  ) AS result`,
  [organizationId],
);
topupId = topup.id;
const evidence = createClient();
await evidence.connect();
try {
  await evidence.query(
    `INSERT INTO public.petro_documents(
       uploader_id,organization_id,finance_topup_request_id,document_type,file_name,content_type,
       byte_size,storage_path,status,uploaded_at
     ) VALUES ($1::uuid,$2::uuid,$3::uuid,'إثبات تحويل','race-topup.pdf','application/pdf',
       32,'finance-race/topup-evidence.pdf','pending_review',now())`,
    [ids.owner, organizationId, topupId],
  );
} finally {
  await evidence.end();
}
await withActor(
  ids.owner,
  "SELECT public.petro_finance_admin_submit_topup($1::uuid,1,$2,$3) AS result",
  [topupId, "إرسال طلب اختبار التزامن", "race-topup-submit-01"],
);

const approvalSql = `SELECT public.petro_finance_admin_approve_topup(
  $1::uuid,$2::uuid,1000000,1000000,'تأكيد اختبار مصرفي معزول',
  true,'race-topup-approve-same-key'
) AS result`;
const approvalParams = [topupId, bankId];
const approve = () => withActor(ids.finance, approvalSql, approvalParams);
const approvalAttempts = await Promise.allSettled([
  withActorAndDropCommittedReply(ids.finance, approvalSql, approvalParams),
  approve(),
]);
const droppedApproval = approvalAttempts.find((item) => item.status === "rejected");
const successfulApproval = approvalAttempts.find((item) => item.status === "fulfilled");
assert.ok(droppedApproval && successfulApproval);
assert.equal(droppedApproval.reason.code, "ECONNRESET");
assert.deepEqual(droppedApproval.reason.committedResult, successfulApproval.value);
assert.equal(successfulApproval.value.status, "funded");
assert.deepEqual(await approve(), successfulApproval.value, "retry after the simulated lost post-commit reply must replay the same result");
await assert.rejects(
  withActor(
    ids.finance,
    `SELECT public.petro_finance_admin_approve_topup(
      $1::uuid,$2::uuid,1000001,1000000,'محتوى مختلف بعد نجاح سابق',
      true,'race-topup-approve-same-key'
    ) AS result`,
    [topupId, bankId],
  ),
  (error) => error.code === "23505",
  "top-up approval must reject a changed payload for a committed idempotency key",
);

const transferBetween = (sourceBranchId, targetBranchId, reference, idempotencyKey, amountMinor, reason = "تحويل اختباري داخل الشركة") => withActor(
  ids.finance,
  `SELECT public.petro_finance_admin_transfer(
    $1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7
  ) AS result`,
  [
    organizationId,
    sourceBranchId,
    targetBranchId,
    amountMinor,
    reference,
    reason,
    idempotencyKey,
  ],
);
const transfer = (branchId, reference, idempotencyKey, amountMinor = 600000) =>
  transferBetween(null, branchId, reference, idempotencyKey, amountMinor, "تحويل متزامن يتنافس على المتاح في الفرع");
await assert.rejects(
  transfer(firstBranchId, "FIN-RACE-PREWRITE", "race-transfer-prewrite", 1000001),
  (error) => error.code === "23514",
  "an overdrawn transfer must fail before any durable write",
);
const correctedTransfer = await transfer(firstBranchId, "FIN-RACE-PREWRITE", "race-transfer-prewrite", 1000);
assert.equal(correctedTransfer.amountMinor, "1000", "a failed transfer must not reserve its idempotency key");
await transferBetween(firstBranchId, null, "FIN-RACE-PREWRITE-RETURN", "race-transfer-prewrite-return", 1000);
const competing = await Promise.allSettled([
  transfer(firstBranchId, "FIN-RACE-MOVE-A", "race-transfer-a-01"),
  transfer(secondBranchId, "FIN-RACE-MOVE-B", "race-transfer-b-01"),
]);
assert.equal(competing.filter((item) => item.status === "fulfilled").length, 1);
assert.equal(competing.filter((item) => item.status === "rejected").length, 1);
const rejected = competing.find((item) => item.status === "rejected");
assert.equal(rejected.reason.code, "23514", "the second transfer must fail on insufficient available funds");
const transferInputs = [
  [firstBranchId, "FIN-RACE-MOVE-A", "race-transfer-a-01"],
  [secondBranchId, "FIN-RACE-MOVE-B", "race-transfer-b-01"],
];
const winnerIndex = competing.findIndex((item) => item.status === "fulfilled");
const winnerInput = transferInputs[winnerIndex];
assert.ok(winnerInput);
const transferReplay = await transfer(...winnerInput);
assert.deepEqual(transferReplay, competing[winnerIndex].value, "committed transfer retry must replay its original result");
await assert.rejects(
  transfer(winnerInput[0], winnerInput[1], winnerInput[2], 500000),
  (error) => error.code === "23505",
  "transfer must reject changed payload for a committed idempotency key",
);
const otherBranchId = winnerInput[0] === firstBranchId ? secondBranchId : firstBranchId;
const postCommitTransferSql = `SELECT public.petro_finance_admin_transfer(
  $1::uuid,$2::uuid,$3::uuid,100000,$4,$5,$6
) AS result`;
const postCommitTransferParams = [
  organizationId, null, otherBranchId, "FIN-RACE-POSTCOMMIT-MOVE",
  "تحويل اختبار لاستعادة استجابة مفقودة بعد الحفظ", "race-transfer-postcommit",
];
let droppedTransferResult;
try {
  await withActorAndDropCommittedReply(ids.finance, postCommitTransferSql, postCommitTransferParams);
  assert.fail("synthetic post-commit disconnect should hide the committed response");
} catch (error) {
  assert.equal(error.code, "ECONNRESET");
  droppedTransferResult = error.committedResult;
}
const transferAfterLostReply = await withActor(ids.finance, postCommitTransferSql, postCommitTransferParams);
assert.deepEqual(transferAfterLostReply, droppedTransferResult, "transfer retry after a lost post-commit reply must replay once");
await assert.rejects(
  withActor(ids.finance, postCommitTransferSql.replace("100000", "90000"), postCommitTransferParams),
  (error) => error.code === "23505",
  "a transfer retry with a changed amount and the same committed key must be rejected",
);

const providerId = await withActor(
  ids.owner,
  `SELECT public.petro_create_organization_details(
    'مقدم اختبار تحصيل متزامن','provider','FIN-RACE-PROVIDER',NULL,
    'مسؤول اختبار','+201000001321','finance-race-provider@example.invalid','عنوان اختبار'
  ) AS result`,
);
await withActor(ids.owner, "SELECT public.petro_approve_organization($1::uuid,1,$2) AS result", [
  providerId, "اعتماد مقدم اختبار التحصيل",
]);
await withActor(ids.owner, "SELECT public.petro_set_organization_operational_status($1::uuid,2,'active',$2) AS result", [
  providerId, "تفعيل مقدم اختبار التحصيل",
]);
const providerBranchId = await withActor(
  ids.owner,
  `SELECT public.petro_create_branch_details(
    $1::uuid,'FIN-RACE-PROVIDER-B1','فرع تحصيل متزامن','عنوان اختبار','القاهرة',
    NULL,NULL,'{}'::jsonb,'مسؤول فرع التحصيل','+201000001322'
  ) AS result`,
  [providerId],
);
await withActor(ids.owner, "SELECT public.petro_approve_branch($1::uuid,$2::uuid,1,$3) AS result", [
  providerId, providerBranchId, "اعتماد فرع التحصيل",
]);
await withActor(ids.owner, "SELECT public.petro_set_branch_operational_status($1::uuid,$2::uuid,2,'active',$3) AS result", [
  providerId, providerBranchId, "تفعيل فرع التحصيل",
]);
const planId = await withActor(
  ids.owner,
  "SELECT public.petro_billing_admin_create_plan($1,'provider',$2,500000,$3) AS result",
  ["finance-race-provider-plan", "خطة اختبار التحصيل", "إعداد خطة معزولة"],
);
const versionId = await withActor(
  ids.owner,
  `SELECT public.petro_billing_admin_add_plan_version(
    $1::uuid,500000,now(),
    '[{"key":"race_entitlement","label":"استحقاق اختبار","value":true,"approved":true}]'::jsonb,
    '[]'::jsonb,'نسخة خطة اختبار'
  ) AS result`,
  [planId],
);
await withActor(ids.owner, "SELECT public.petro_billing_admin_publish_plan_version($1::uuid,$2::uuid,$3) AS result", [
  planId, versionId, "نشر نسخة خطة معزولة",
]);
const requestId = await withActor(
  ids.owner,
  `SELECT public.petro_billing_admin_create_request(
    $1::uuid,$2::uuid,'new',NULL,$3::uuid,$4::uuid,NULL,
    now()+interval '2 days',now()+interval '367 days',
    'تغطية فرع اختبار معزول','طلب اختبار تحصيل متزامن',true
  ) AS result`,
  [providerId, providerBranchId, planId, versionId],
);
const subscriptionId = await withActor(
  ids.owner,
  "SELECT public.petro_billing_admin_review_request($1::uuid,'approve',$2) AS result",
  [requestId, "اعتماد طلب اختبار التحصيل"],
);
const subscriptionEvidence = createClient();
await subscriptionEvidence.connect();
try {
  await subscriptionEvidence.query(
    `INSERT INTO public.petro_documents(
       uploader_id,organization_id,branch_id,finance_subscription_request_id,
       document_type,file_name,content_type,byte_size,storage_path,status,uploaded_at
     ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'إثبات اشتراك',
       'race-subscription.pdf','application/pdf',32,
       'finance-race/subscription-evidence.pdf','pending_review',now())`,
    [ids.owner, providerId, providerBranchId, requestId],
  );
} finally {
  await subscriptionEvidence.end();
}
const unallocatedBeforeSubscriptionReceipt = await withActor(
  ids.owner,
  "SELECT public.petro_finance_admin_summary() AS result",
);
const receiptSql = `SELECT public.petro_finance_admin_record_receipt(
  $1::uuid,$2::uuid,$3::uuid,'بنك مقدم الاختبار','FIN-RACE-SUBSCRIPTION-RECEIPT',
  $4::bigint,$5,true,$6
) AS result`;
const receiptParams = (amountMinor, reason, key, receiptBankId = bankId) =>
  [providerId, providerBranchId, receiptBankId, amountMinor, reason, key];
const recordSubscriptionReceipt = (amountMinor, reason, key, receiptBankId = bankId) => withActor(
  ids.finance,
  receiptSql,
  receiptParams(amountMinor, reason, key, receiptBankId),
);
await assert.rejects(
  recordSubscriptionReceipt(
    500000, "مطابقة قبض اشتراك اختبار", "race-subscription-receipt-01",
    "00000000-0000-4000-8000-000000009999",
  ),
  (error) => error.code === "55000",
  "a receipt with an unapproved bank account must fail before saving",
);
let droppedReceiptResult;
try {
  await withActorAndDropCommittedReply(
    ids.finance,
    receiptSql,
    receiptParams(500000, "مطابقة قبض اشتراك اختبار", "race-subscription-receipt-01"),
  );
  assert.fail("synthetic post-commit disconnect should hide the committed receipt response");
} catch (error) {
  assert.equal(error.code, "ECONNRESET");
  droppedReceiptResult = error.committedResult;
}
const recordedReceipt = await recordSubscriptionReceipt(
  500000, "مطابقة قبض اشتراك اختبار", "race-subscription-receipt-01",
);
assert.deepEqual(recordedReceipt, droppedReceiptResult, "receipt retry after a lost post-commit reply must replay once");
assert.deepEqual(
  await recordSubscriptionReceipt(500000, "مطابقة قبض اشتراك اختبار", "race-subscription-receipt-01"),
  recordedReceipt,
  "a committed subscription receipt retry must replay the original result",
);
await assert.rejects(
  recordSubscriptionReceipt(400000, "محتوى قبض مختلف", "race-subscription-receipt-01"),
  (error) => error.code === "23505",
  "receipt must reject a changed payload for a committed idempotency key",
);
const allocationSql = `SELECT public.petro_finance_admin_allocate_receipt(
  $1::uuid,'subscription',$2::uuid,$3::bigint,$4,$5
) AS result`;
const allocationParams = (amountMinor, key) =>
  [recordedReceipt.id, subscriptionId, amountMinor, "تخصيص اشتراك اختبار متزامن", key];
const allocateSubscription = (amountMinor, key) => withActor(
  ids.reviewer,
  allocationSql,
  allocationParams(amountMinor, key),
);
await assert.rejects(
  allocateSubscription(500001, "race-subscription-allocate-01"),
  (error) => error.code === "23514",
  "an over-allocation must fail before committing an entry or reserving its idempotency key",
);
let droppedAllocationResult;
try {
  await withActorAndDropCommittedReply(
    ids.reviewer,
    allocationSql,
    allocationParams(500000, "race-subscription-allocate-01"),
  );
  assert.fail("synthetic post-commit disconnect should hide the committed allocation response");
} catch (error) {
  assert.equal(error.code, "ECONNRESET");
  droppedAllocationResult = error.committedResult;
}
const allocatedSubscription = await allocateSubscription(500000, "race-subscription-allocate-01");
assert.deepEqual(allocatedSubscription, droppedAllocationResult, "allocation retry after a lost post-commit reply must replay once");
assert.deepEqual(
  await allocateSubscription(500000, "race-subscription-allocate-01"),
  allocatedSubscription,
  "a committed subscription allocation retry must replay the original result",
);
await assert.rejects(
  allocateSubscription(400000, "race-subscription-allocate-01"),
  (error) => error.code === "23505",
  "subscription allocation must reject changed payload for a committed idempotency key",
);
const financeSummary = await withActor(ids.owner, "SELECT public.petro_finance_admin_summary() AS result");
assert.equal(BigInt(financeSummary.subscriptionHeldMinor),
  BigInt(unallocatedBeforeSubscriptionReceipt.subscriptionHeldMinor)+500000n,
  "Subscription collection adds exactly its own held amount, preserving other tenants.");
assert.equal(financeSummary.companyFundsMinor,unallocatedBeforeSubscriptionReceipt.companyFundsMinor,
  "Subscription allocation must leave all existing company funding unchanged.");
const receiptSnapshot = await withActor(
  ids.owner,
  "SELECT public.petro_finance_admin_receipt_detail($1::uuid) AS result",
  [recordedReceipt.id],
);
assert.equal(
  financeSummary.unallocatedReceiptsMinor,
  unallocatedBeforeSubscriptionReceipt.unallocatedReceiptsMinor,
  "subscription allocation must consume only its new receipt, not alter pre-existing unallocated receipts",
);
assert.equal(receiptSnapshot.allocations.length, 1);
assert.equal(receiptSnapshot.allocations[0].amountMinor, "500000");
assert.equal(receiptSnapshot.journal.debitMinor, "500000");
assert.equal(receiptSnapshot.journal.creditMinor, "500000");
const subscriptions = await withActor(
  ids.owner,
  "SELECT public.petro_finance_admin_list_subscriptions(NULL,NULL,1,20) AS result",
);
const collectedSubscription = subscriptions.items.find((item) => item.subscriptionId === subscriptionId);
assert.equal(collectedSubscription.subscriptionStatus, "pending_payment");
assert.equal(collectedSubscription.collectionStatus, "collected_on_hold");

const accounts = await withActor(
  ids.owner,
  "SELECT public.petro_finance_admin_accounts(NULL,1,100) AS result",
);
const companyAccounts = accounts.items.filter((account) => account.organizationId === organizationId);
const mainAccount = companyAccounts.find((account) => account.branchId === null);
const branchAccounts = companyAccounts.filter((account) => account.branchId !== null);
assert.equal(mainAccount.ledgerBalanceMinor, "300000");
assert.equal(
  branchAccounts.reduce((sum, account) => sum + BigInt(account.ledgerBalanceMinor), 0n).toString(),
  "700000",
);
assert.equal(
  BigInt(mainAccount.ledgerBalanceMinor)
    + branchAccounts.reduce((sum, account) => sum + BigInt(account.ledgerBalanceMinor), 0n),
  1000000n,
);

console.log(
  "Finance concurrency passed: duplicate top-up approvals replayed one result; competing transfers serialized; committed receipt and subscription-allocation retries replayed once, changed payloads were rejected, subscription cash stayed on hold, and company funds remained exactly 1000000 piasters.",
);
