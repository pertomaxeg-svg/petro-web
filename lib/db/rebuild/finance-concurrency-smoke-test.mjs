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

const approve = () => withActor(
  ids.finance,
  `SELECT public.petro_finance_admin_approve_topup(
    $1::uuid,$2::uuid,1000000,1000000,'تأكيد اختبار مصرفي معزول',
    true,'race-topup-approve-same-key'
  ) AS result`,
  [topupId, bankId],
);
const approvals = await Promise.all([approve(), approve()]);
assert.deepEqual(approvals[0], approvals[1], "concurrent duplicate approvals must replay the same result");
assert.equal(approvals[0].status, "funded");

const transfer = (branchId, reference, idempotencyKey) => withActor(
  ids.finance,
  `SELECT public.petro_finance_admin_transfer(
    $1::uuid,NULL,$2::uuid,600000,$3,$4,$5
  ) AS result`,
  [
    organizationId,
    branchId,
    reference,
    "تحويل متزامن يتنافس على المتاح في الفرع",
    idempotencyKey,
  ],
);
const competing = await Promise.allSettled([
  transfer(firstBranchId, "FIN-RACE-MOVE-A", "race-transfer-a-01"),
  transfer(secondBranchId, "FIN-RACE-MOVE-B", "race-transfer-b-01"),
]);
assert.equal(competing.filter((item) => item.status === "fulfilled").length, 1);
assert.equal(competing.filter((item) => item.status === "rejected").length, 1);
const rejected = competing.find((item) => item.status === "rejected");
assert.equal(rejected.reason.code, "23514", "the second transfer must fail on insufficient available funds");

const accounts = await withActor(
  ids.owner,
  "SELECT public.petro_finance_admin_accounts(NULL,1,100) AS result",
);
const companyAccounts = accounts.items.filter((account) => account.organizationId === organizationId);
const mainAccount = companyAccounts.find((account) => account.branchId === null);
const branchAccounts = companyAccounts.filter((account) => account.branchId !== null);
assert.equal(mainAccount.ledgerBalanceMinor, "400000");
assert.equal(
  branchAccounts.reduce((sum, account) => sum + BigInt(account.ledgerBalanceMinor), 0n).toString(),
  "600000",
);
assert.equal(
  BigInt(mainAccount.ledgerBalanceMinor)
    + branchAccounts.reduce((sum, account) => sum + BigInt(account.ledgerBalanceMinor), 0n),
  1000000n,
);

console.log(
  "Finance concurrency passed: concurrent duplicate top-up approval replayed one result; competing transfers serialized, one rejected, and company funds remained exactly 1000000 piasters.",
);
