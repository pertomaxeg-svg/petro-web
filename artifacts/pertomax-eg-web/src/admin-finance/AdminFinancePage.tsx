import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity, ArrowDownLeft, ArrowLeftRight, Banknote, Check, ChevronLeft,
  CircleAlert, ClipboardList, Clock3, FileCheck2, FileText, Landmark, LockKeyhole, Plus, RefreshCw,
  Search, ShieldCheck, Upload, WalletCards, X,
} from "lucide-react";
import {
  createDocumentUploadIntent, getGetAdminFinanceJournalEntryQueryKey, getGetAdminFinanceReconciliationQueryKey,
  getGetAdminFinanceSummaryQueryKey, getGetAdminFinanceTopupQueryKey, getListAdminFinanceAccountsQueryKey,
  getListAdminFinanceBankAccountsQueryKey, getListAdminFinanceJournalQueryKey, getListAdminFinanceOrganizationsQueryKey,
  getListAdminFinanceReceiptsQueryKey, getListAdminFinanceSubscriptionsQueryKey, getListAdminFinanceTopupsQueryKey,
  getListAdminFinanceTransfersQueryKey, getListOrganizationDocumentsQueryKey, uploadOrganizationDocumentContent,
  useAllocateAdminFinanceReceipt, useApproveAdminFinanceBankAccount, useApproveAdminFinanceTopup,
  useCreateAdminFinanceBankAccount, useCreateAdminFinanceTopup, useCreateAdminFinanceTransfer,
  useCreateDocumentUploadIntent, useDisableAdminFinanceBankAccount, useGetAdminFinanceJournalEntry,
  useGetAdminFinanceReconciliation, useGetAdminFinanceSummary, useGetAdminFinanceTopup,
  useListAdminFinanceAccounts, useListAdminFinanceBankAccounts, useListAdminFinanceJournal,
  useListAdminFinanceOrganizations, useListAdminFinanceReceipts, useListAdminFinanceSubscriptions,
  useListAdminFinanceTopups, useListAdminFinanceTransfers, useListOrganizationDocuments,
  useRecordAdminFinanceReceipt, useReverseAdminFinanceJournalEntry, useReviewAdminFinanceTopup,
  useSubmitAdminFinanceTopup, useUpdateAdminFinanceTopup,
} from "@workspace/api-client-react";
import type { CreateDocumentUploadIntent } from "@workspace/api-client-react";
import "./AdminFinancePage.css";

type Section = "overview" | "accounts" | "banks" | "topups" | "receipts" | "subscriptions" | "journal" | "reconciliation";
type Row = Record<string, unknown>;
type ActionKind = "bank" | "bankApprove" | "bankDisable" | "topup" | "topupEdit" | "topupSubmit" | "receipt" | "transfer" | "review" | "approve" | "allocate" | "reverse" | null;
const pageSize = 20;
const get = (row: unknown, ...keys: string[]): unknown => {
  if (!row || typeof row !== "object") return undefined;
  const value = row as Row;
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
  return undefined;
};
const text = (value: unknown, fallback = "—") => typeof value === "string" && value.trim() ? value : fallback;
const num = (value: unknown) => typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined;
const rows = (value: unknown): Row[] => {
  if (Array.isArray(value)) return value.filter((item): item is Row => !!item && typeof item === "object");
  const items = get(value, "items");
  return Array.isArray(items) ? items.filter((item): item is Row => !!item && typeof item === "object") : [];
};
const currency = (value: unknown) => {
  if (value === undefined || value === null || value === "") return "—";
  try {
    const minor = BigInt(String(value));
    const egp = minor / 100n;
    const piasters = (minor % 100n).toString().padStart(2, "0");
    return `${new Intl.NumberFormat("ar-EG").format(egp)}.${piasters} ج.م`;
  } catch { return "—"; }
};
const parseMinor = (input: string): number | null => {
  const normalized = input.trim()
    .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[٬,]/g, "").replace(/[٫،]/g, ".");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [whole, fraction = ""] = normalized.split(".");
  try {
    const value = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0");
    return value > 0n && value <= 1_000_000_000_000n ? Number(value) : null;
  } catch { return null; }
};
const dateText = (value: unknown) => typeof value === "string" && value ? new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
const label: Record<string, string> = {
  active: "نشط", approved: "معتمد", attached: "مرفق", bank_receipt: "إيصال بنكي", cancelled: "ملغى",
  branch_funding: "تمويل فرع", company_funding: "تمويل شركة",
  collected_on_hold: "محصّل — معلّق", draft: "مسودة", funded: "مموّل", internal_transfer: "تحويل داخلي",
  balanced: "متوازن", issues_found: "توجد فروق",
  needs_info: "بحاجة إلى معلومات", partial: "جزئي", partially_collected: "محصّل جزئيًا", partially_funded: "تمويل جزئي",
  pending: "بانتظار المراجعة", pending_upload: "بانتظار الرفع", pending_payment: "بانتظار التحصيل",
  rejected: "مرفوض", reversal: "قيد عكسي", reversed: "معكوس", submitted: "مرسل للمراجعة",
  subscription_collection: "تحصيل اشتراك", topup_allocation: "تخصيص شحن", unpaid: "غير محصّل", upload_failed: "تعذّر الرفع",
};
const statusName = (value: unknown) => {
  const key = String(value ?? "");
  return label[key] ?? (key ? key.replaceAll("_", " ") : "غير محدد");
};
const apiStatus = (error: unknown) => {
  const e = error as { status?: number; response?: { status?: number } };
  return e?.status ?? e?.response?.status ?? 0;
};
const errorText = (error: unknown) => {
  const status = apiStatus(error);
  if (status === 403) return "رفض الخادم هذا الإجراء؛ لا تملك الصلاحية المطلوبة.";
  if (status === 409) return "تعارض مع سجل أو رصيد أحدث. حدّث البيانات وراجعها قبل إعادة المحاولة.";
  if (status === 503) return "الخدمة المالية غير متاحة حاليًا. لم تُعرض بيانات بديلة؛ أعد المحاولة لاحقًا.";
  const e = error as { message?: string; data?: { message?: string } };
  return e?.data?.message || e?.message || "تعذر إتمام العملية. حاول مرة أخرى.";
};
const newKey = () => crypto.randomUUID();
const activeStatus = (row: Row) => String(get(row, "status", "accountStatus", "state") ?? "").toLowerCase() === "active"
  || String(get(row, "status", "accountStatus", "state") ?? "").toLowerCase() === "approved";

function StateMessage({ title, children, error, retry }: { title: string; children?: ReactNode; error?: boolean; retry?: () => void }) {
  return <div className={`af-state ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}>
    <span className="af-state-mark">{error ? <CircleAlert size={20}/> : <FileCheck2 size={20}/>}</span>
    <b>{title}</b>{children && <p>{children}</p>}
    {retry && <button className="af-button af-button-soft" onClick={retry}><RefreshCw size={15}/>إعادة المحاولة</button>}
  </div>;
}
function Skeletons() { return <div className="af-skeletons" aria-label="جارٍ تحميل السجلات"><i/><i/><i/><i/></div>; }
function Status({ value }: { value: unknown }) { return <span className={`af-status af-status-${String(value ?? "unknown")}`}><i/>{statusName(value)}</span>; }
function Reason({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label className="af-field af-wide">سبب موثّق <small>من ٥ إلى ٥٠٠ حرف</small><textarea required minLength={5} maxLength={500} value={value} onChange={event => onChange(event.target.value)} placeholder="اكتب سبب الإجراء بما يسمح بتتبّعه." /></label>;
}
function Field({ title, children, wide = false }: { title: string; children: ReactNode; wide?: boolean }) { return <label className={`af-field ${wide ? "af-wide" : ""}`}>{title}{children}</label>; }

export function AdminFinancePage({ roles }: { roles: string[] }) {
  const roleSet = new Set(roles.map(role => role.toLowerCase()));
  const owner = roleSet.has("owner");
  const finance = owner || roleSet.has("finance");
  const operations = roleSet.has("operations");
  const auditor = roleSet.has("auditor");
  const canRead = finance || auditor;
  const canSubmit = finance || operations;
  const cache = useQueryClient();
  const [section, setSection] = useState<Section>(canRead ? "overview" : "topups");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<ActionKind>(null);
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [selected, setSelected] = useState<Row | null>(null);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedTopup, setSelectedTopup] = useState("");
  const [selectedReceipt, setSelectedReceipt] = useState("");
  const [pendingReceiptEvidence, setPendingReceiptEvidence] = useState("");
  const [receiptRecorded, setReceiptRecorded] = useState(false);
  const [allocateReceiptId, setAllocateReceiptId] = useState("");
  const [allocationType, setAllocationType] = useState<"topup" | "subscription">("topup");
  const [allocationTargetId, setAllocationTargetId] = useState("");
  const [transferOrg, setTransferOrg] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [branchId, setBranchId] = useState("");
  const [bankId, setBankId] = useState("");
  const [file, setFile] = useState<File | null>(null);

  const financeQuery = { enabled: canRead, retry: false, refetchOnMount: "always" as const };
  const summary = useGetAdminFinanceSummary({ query: { queryKey: getGetAdminFinanceSummaryQueryKey(), ...financeQuery } });
  const orgParams = useMemo(() => ({ page: 1, pageSize: 100, ...(search.trim().length >= 2 && section === "accounts" ? { search: search.trim() } : {}) }), [search, section]);
  const organizations = useListAdminFinanceOrganizations(orgParams, { query: { queryKey: getListAdminFinanceOrganizationsQueryKey(orgParams), enabled: canSubmit && ["accounts", "topups", "receipts"].includes(section), retry: false } });
  const accountsParams = useMemo(() => ({ page, pageSize, ...(search.trim().length >= 2 ? { search: search.trim() } : {}) }), [page, search]);
  const accounts = useListAdminFinanceAccounts(accountsParams, { query: { queryKey: getListAdminFinanceAccountsQueryKey(accountsParams), enabled: canRead && section === "accounts", retry: false, refetchOnMount: "always" } });
  const selectedOrganizationName = rows(organizations.data).find(item => String(get(item, "id")) === organizationId)?.name;
  const accountScopesParams = useMemo(() => ({ page: 1, pageSize: 100, ...(selectedOrganizationName ? { search: String(selectedOrganizationName) } : {}) }), [selectedOrganizationName]);
  const accountScopes = useListAdminFinanceAccounts(accountScopesParams, { query: { queryKey: getListAdminFinanceAccountsQueryKey(accountScopesParams), enabled: canRead && section === "accounts", retry: false } });
  const banks = useListAdminFinanceBankAccounts({ query: { queryKey: getListAdminFinanceBankAccountsQueryKey(), enabled: canRead && ["banks", "topups", "receipts"].includes(section), retry: false, refetchOnMount: "always" } });
  const topupParams = useMemo(() => ({ page, pageSize, ...(search.trim().length >= 2 ? { search: search.trim() } : {}), ...(statusFilter ? { status: statusFilter as "draft" | "submitted" | "needs_info" | "rejected" | "partially_funded" | "funded" | "cancelled" } : {}) }), [page, search, statusFilter]);
  const topups = useListAdminFinanceTopups(topupParams, { query: { queryKey: getListAdminFinanceTopupsQueryKey(topupParams), enabled: canSubmit && section === "topups", retry: false, refetchOnMount: "always" } });
  const allocationTopupParams = useMemo(() => ({ page: 1, pageSize: 100 }), []);
  const allocationTopups = useListAdminFinanceTopups(allocationTopupParams, { query: { queryKey: getListAdminFinanceTopupsQueryKey(allocationTopupParams), enabled: finance && action === "allocate" && section === "receipts", retry: false } });
  const topupDetail = useGetAdminFinanceTopup(selectedTopup, { query: { queryKey: getGetAdminFinanceTopupQueryKey(selectedTopup), enabled: !!selectedTopup && section === "topups", retry: false } });
  const receiptParams = useMemo(() => ({ page, pageSize, ...(search.trim().length >= 2 ? { search: search.trim() } : {}) }), [page, search]);
  const receipts = useListAdminFinanceReceipts(receiptParams, { query: { queryKey: getListAdminFinanceReceiptsQueryKey(receiptParams), enabled: canRead && ["receipts", "subscriptions"].includes(section), retry: false, refetchOnMount: "always" } });
  const allocationReceiptParams = useMemo(() => ({ page: 1, pageSize: 100 }), []);
  const allocationReceipts = useListAdminFinanceReceipts(allocationReceiptParams, { query: { queryKey: getListAdminFinanceReceiptsQueryKey(allocationReceiptParams), enabled: finance && action === "allocate", retry: false } });
  const receiptDocsParams = useMemo(() => ({ receiptId: selectedReceipt }), [selectedReceipt]);
  const receiptDocs = useListOrganizationDocuments(receiptDocsParams, { query: { queryKey: getListOrganizationDocumentsQueryKey(receiptDocsParams), enabled: !!selectedReceipt && section === "receipts", retry: false } });
  const subscriptionsParams = useMemo(() => ({ page, pageSize, ...(search.trim().length >= 2 ? { search: search.trim() } : {}), status: "unpaid" as const }), [page, search]);
  const subscriptions = useListAdminFinanceSubscriptions(subscriptionsParams, { query: { queryKey: getListAdminFinanceSubscriptionsQueryKey(subscriptionsParams), enabled: canRead && section === "subscriptions", retry: false, refetchOnMount: "always" } });
  const allocationSubscriptionParams = useMemo(() => ({ page: 1, pageSize: 100, status: "unpaid" as const }), []);
  const allocationSubscriptions = useListAdminFinanceSubscriptions(allocationSubscriptionParams, { query: { queryKey: getListAdminFinanceSubscriptionsQueryKey(allocationSubscriptionParams), enabled: finance && action === "allocate" && section === "receipts", retry: false } });
  const transfersParams = useMemo(() => ({ page, pageSize, ...(transferOrg ? { organizationId: transferOrg } : {}) }), [page, transferOrg]);
  const transfers = useListAdminFinanceTransfers(transfersParams, { query: { queryKey: getListAdminFinanceTransfersQueryKey(transfersParams), enabled: canRead && section === "accounts", retry: false } });
  const journalParams = useMemo(() => ({ page, pageSize, ...(search.trim().length >= 2 ? { search: search.trim() } : {}) }), [page, search]);
  const journal = useListAdminFinanceJournal(journalParams, { query: { queryKey: getListAdminFinanceJournalQueryKey(journalParams), enabled: canRead && section === "journal", retry: false, refetchOnMount: "always" } });
  const [entryId, setEntryId] = useState("");
  const journalDetail = useGetAdminFinanceJournalEntry(entryId, { query: { queryKey: getGetAdminFinanceJournalEntryQueryKey(entryId), enabled: !!entryId, retry: false } });
  const reconciliation = useGetAdminFinanceReconciliation({ query: { queryKey: getGetAdminFinanceReconciliationQueryKey(), enabled: canRead && section === "reconciliation", retry: false, refetchOnMount: "always" } });

  const createBank = useCreateAdminFinanceBankAccount();
  const approveBank = useApproveAdminFinanceBankAccount();
  const disableBank = useDisableAdminFinanceBankAccount();
  const createTopup = useCreateAdminFinanceTopup();
  const updateTopup = useUpdateAdminFinanceTopup();
  const submitTopup = useSubmitAdminFinanceTopup();
  const reviewTopup = useReviewAdminFinanceTopup();
  const approveTopup = useApproveAdminFinanceTopup();
  const recordReceipt = useRecordAdminFinanceReceipt();
  const allocateReceipt = useAllocateAdminFinanceReceipt();
  const createTransfer = useCreateAdminFinanceTransfer();
  const reverseJournal = useReverseAdminFinanceJournalEntry();
  const uploadIntent = useCreateDocumentUploadIntent();

  const nav: Array<[Section, string, ReactNode]> = [
    ["overview", "الملخص", <Activity size={17}/>],
    ["accounts", "الأرصدة والتحويلات", <WalletCards size={17}/>],
    ["banks", "حسابات الاستقبال", <Landmark size={17}/>],
    ["topups", "طلبات الشحن", <Banknote size={17}/>],
    ["receipts", "الإيصالات والتخصيص", <FileCheck2 size={17}/>],
    ["subscriptions", "تحصيل الاشتراكات", <Clock3 size={17}/>],
    ["journal", "دفتر القيود", <ClipboardList size={17}/>],
    ["reconciliation", "المطابقة", <ShieldCheck size={17}/>],
  ];
  const title = nav.find(item => item[0] === section)?.[1] ?? "المالية";
  const refreshAll = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: getGetAdminFinanceSummaryQueryKey() }),
      cache.invalidateQueries({ queryKey: getListAdminFinanceAccountsQueryKey() }),
      cache.invalidateQueries({ queryKey: getListAdminFinanceBankAccountsQueryKey() }),
      cache.invalidateQueries({ queryKey: getListAdminFinanceTopupsQueryKey() }),
      cache.invalidateQueries({ queryKey: getListAdminFinanceReceiptsQueryKey() }),
      cache.invalidateQueries({ queryKey: getListAdminFinanceTransfersQueryKey() }),
      cache.invalidateQueries({ queryKey: getListAdminFinanceSubscriptionsQueryKey() }),
      cache.invalidateQueries({ queryKey: getListAdminFinanceJournalQueryKey() }),
      cache.invalidateQueries({ queryKey: getGetAdminFinanceReconciliationQueryKey() }),
    ]);
  };
  const openAction = (kind: Exclude<ActionKind, null>, row?: Row) => {
    setAction(kind); setSelected(row ?? null); setReason(""); setProblem(""); setMessage(""); setFile(null);
    setIdempotencyKey(newKey());
    setReceiptRecorded(false); setPendingReceiptEvidence("");
    setAllocateReceiptId("");
    const subscriptionId = String(get(row, "subscriptionId", "subscription_id") ?? "");
    setAllocationType(subscriptionId ? "subscription" : "topup");
    setAllocationTargetId(subscriptionId);
    setOrganizationId(String(get(row, "organizationId", "organization_id") ?? ""));
    setBranchId(""); setBankId("");
  };
  const closeAction = () => { setAction(null); setSelected(null); setProblem(""); setFile(null); setIdempotencyKey(""); };
  const submitForm = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!action) return;
    setProblem(""); setMessage(""); setBusy(true);
    const data = new FormData(event.currentTarget);
    let newlyRecordedReceiptId = "";
    const requestKey = idempotencyKey || newKey();
    if (!idempotencyKey) setIdempotencyKey(requestKey);
    const value = (key: string) => String(data.get(key) ?? "").trim();
    const amount = (key: string) => parseMinor(value(key));
    const validReason = reason.trim().length >= 5 && reason.trim().length <= 500;
    try {
      if (!validReason) throw new Error("سبب الإجراء مطلوب، من ٥ إلى ٥٠٠ حرف.");
      if (action === "bank") {
         await createBank.mutateAsync({ data: { bankName: value("bankName"), displayLabel: value("displayLabel"), accountLast4: value("accountLast4"), reason: reason.trim(), idempotencyKey: requestKey } });
        setMessage("تم تسجيل حساب الاستقبال كمسودة مراجعة؛ لا يُستخدم قبل اعتماده.");
      }
      if (action === "bankApprove" || action === "bankDisable") {
        if (!selected) return;
         const payload = { reason: reason.trim(), idempotencyKey: requestKey };
        const bankAccountId = String(get(selected, "bankAccountId", "bank_account_id", "id") ?? "");
        if (action === "bankApprove") await approveBank.mutateAsync({ bankAccountId, data: payload });
        else await disableBank.mutateAsync({ bankAccountId, data: payload });
        setMessage(action === "bankApprove" ? "تم اعتماد حساب الاستقبال." : "تم إيقاف حساب الاستقبال.");
      }
      if (action === "topup") {
        const minor = amount("amount");
        if (!minor) throw new Error("أدخل مبلغًا صحيحًا بالجنيه حتى منزلتين عشريتين.");
        if (!organizationId) throw new Error("اختر جهة معتمدة.");
        const selectedOrganization = orgRows.find(item => String(get(item, "id")) === organizationId);
        if (get(selectedOrganization, "kind", "organizationKind", "organization_kind") !== "company") throw new Error("طلب شحن رصيد الخدمة متاح للشركات فقط.");
         const created = await createTopup.mutateAsync({ data: { organizationId, amountMinor: minor, payerBankName: value("payerBankName"), bankReference: value("bankReference"), reason: reason.trim(), idempotencyKey: requestKey } });
        const id = String(get(created, "id") ?? "");
        if (id) setSelectedTopup(id);
        setMessage("حُفظ طلب الشحن كمسودة. لا يمثل ذلك إثباتًا للتحصيل.");
      }
      if (action === "topupEdit") {
        if (!selected) return;
        const minor = amount("amount");
        if (!minor) throw new Error("أدخل مبلغًا صحيحًا بالجنيه حتى منزلتين عشريتين.");
         await updateTopup.mutateAsync({ topupId: String(get(selected, "id")), data: { expectedVersion: num(get(selected, "version")) ?? 1, amountMinor: minor, payerBankName: value("payerBankName"), bankReference: value("bankReference"), reason: reason.trim(), idempotencyKey: requestKey } });
        setMessage("تم تحديث مسودة طلب الشحن.");
      }
      if (action === "topupSubmit") {
        if (!selected || !docsReady(selected)) throw new Error("لا يمكن الإرسال قبل وجود مستند مساند مرفوع بالكامل.");
         await submitTopup.mutateAsync({ topupId: String(get(selected, "id")), data: { expectedVersion: num(get(selected, "version")) ?? 1, reason: reason.trim(), idempotencyKey: requestKey } });
        setMessage("تم إرسال طلب الشحن للمراجعة.");
      }
      if (action === "review") {
        if (!selected) return;
         await reviewTopup.mutateAsync({ topupId: String(get(selected, "id")), data: { expectedVersion: num(get(selected, "version")) ?? 1, decision: value("decision") as "needs_info" | "reject", reason: reason.trim(), idempotencyKey: requestKey } });
        setMessage("تم تسجيل قرار المراجعة.");
      }
      if (action === "approve") {
        if (!selected) return;
        const actual = amount("actualAmount");
        const allocationRaw = value("allocationAmount");
        const allocation = allocationRaw ? parseMinor(allocationRaw) : null;
        if (!bankId || !actual || (allocationRaw && !allocation)) throw new Error("اختر حساب استقبال نشطًا وأدخل المبالغ الصحيحة.");
        if (allocation && allocation > actual) throw new Error("لا يمكن أن يتجاوز مبلغ التخصيص المبلغ المطابق فعليًا.");
        if (!data.get("confirmed")) throw new Error("أكد المطابقة اليدوية مع كشف البنك قبل المتابعة.");
         await approveTopup.mutateAsync({ topupId: String(get(selected, "id")), data: { bankAccountId: bankId, actualAmountMinor: actual, ...(allocation ? { allocationAmountMinor: allocation } : {}), reason: reason.trim(), confirmedAgainstBank: true, idempotencyKey: requestKey } });
        setMessage("تم تسجيل اعتماد التحصيل وفق المطابقة اليدوية.");
      }
      if (action === "receipt") {
        const minor = amount("amount");
        if (!minor || !organizationId || !bankId) throw new Error("اختر الجهة وحساب استقبال نشطًا وأدخل مبلغًا صحيحًا.");
        if (String(get(organizations.data?.items?.find(item => String(get(item, "id")) === organizationId), "kind")) === "provider" && !branchId) throw new Error("اختيار فرع مزوّد الخدمة المؤهل مطلوب لتسجيل القبض.");
        if (!value("bankReference")) throw new Error("المرجع البنكي مطلوب.");
        if (!data.get("confirmed")) throw new Error("أكد المطابقة اليدوية مع كشف البنك قبل تسجيل القبض.");
         const result = await recordReceipt.mutateAsync({ data: { organizationId, ...(branchId ? { branchId } : {}), bankAccountId: bankId, payerBankName: value("payerBankName"), bankReference: value("bankReference"), amountMinor: minor, reason: reason.trim(), confirmedAgainstBank: true, idempotencyKey: requestKey } });
        const id = String(get(result, "id", "receiptId") ?? "");
        newlyRecordedReceiptId = id;
        setPendingReceiptEvidence(id);
        setReceiptRecorded(true);
        if (file && id) await uploadFile("receipt", id, file);
        if (id) setSelectedReceipt(id);
        setMessage("تم تسجيل الإيصال البنكي فعليًا. المرفق لا يثبت المال، ويمكن إعادة رفعه دون تكرار تسجيل القبض.");
      }
      if (action === "transfer") {
        const minor = amount("amount");
        if (!minor || !organizationId) throw new Error("اختر جهة وأدخل مبلغًا صحيحًا.");
        const selectedOrganization = orgRows.find(item => String(get(item, "id")) === organizationId);
        if (get(selectedOrganization, "kind", "organizationKind", "organization_kind") !== "company") throw new Error("التحويل الداخلي متاح بين حسابات الشركة نفسها فقط.");
        const source = value("sourceBranchId") || null;
        const target = value("targetBranchId") || null;
        if (source === target) throw new Error("يجب أن يكون مصدر التحويل ووجهته مختلفين.");
         await createTransfer.mutateAsync({ data: { organizationId, sourceBranchId: source, targetBranchId: target, amountMinor: minor, reference: value("reference"), reason: reason.trim(), idempotencyKey: requestKey } });
        setMessage("تم تسجيل التحويل الداخلي بين حسابات الجهة.");
      }
      if (action === "allocate") {
        const minor = amount("amount");
        if (!allocateReceiptId || !minor || !value("targetId")) throw new Error("اختر إيصالًا مسجلًا وأدخل هدفًا ومبلغ تخصيص صحيحًا.");
         await allocateReceipt.mutateAsync({ receiptId: allocateReceiptId, data: { targetType: value("targetType") as "topup" | "subscription", targetId: value("targetId"), amountMinor: minor, reason: reason.trim(), idempotencyKey: requestKey } });
        setMessage("تم تخصيص المبلغ. أي تحصيل اشتراك يبقى معلّقًا ولا يفعّل الاشتراك.");
      }
      if (action === "reverse") {
        if (!selected) return;
         await reverseJournal.mutateAsync({ entryId: String(get(selected, "id", "entryId")), data: { reason: reason.trim(), idempotencyKey: requestKey } });
        setMessage("تم تسجيل القيد العكسي؛ القيد الأصلي ما زال محفوظًا.");
      }
      await refreshAll();
      if (newlyRecordedReceiptId) setSelectedReceipt(newlyRecordedReceiptId);
      closeAction();
    } catch (error) {
      setProblem(error instanceof Error && !(error as { status?: number }).status ? error.message : errorText(error));
    } finally { setBusy(false); }
  };
  async function uploadFile(contextType: "topup_request" | "receipt", contextId: string, selectedFile: File) {
    if (selectedFile.size < 1 || selectedFile.size > 10 * 1024 * 1024 || !["application/pdf", "image/png", "image/jpeg"].includes(selectedFile.type)) {
      throw new Error("تقبل المرفقات PDF أو PNG أو JPEG حتى ١٠ ميغابايت.");
    }
    const input: CreateDocumentUploadIntent = { contextType, contextId, documentType: contextType === "receipt" ? "إثبات إيصال بنكي" : "مستند طلب شحن", fileName: selectedFile.name.slice(0, 160), contentType: selectedFile.type as CreateDocumentUploadIntent["contentType"], byteSize: selectedFile.size };
    const intent = contextType === "receipt" ? await createDocumentUploadIntent(input) : await uploadIntent.mutateAsync({ data: input });
    await uploadOrganizationDocumentContent(intent.id, selectedFile);
  }

  const queryForSection = section === "overview" ? summary : section === "accounts" ? accounts : section === "banks" ? banks : section === "topups" ? topups : section === "receipts" ? receipts : section === "subscriptions" ? subscriptions : section === "journal" ? journal : reconciliation;
  const dataRows = section === "accounts" ? rows(accounts.data) : section === "banks" ? rows(banks.data) : section === "topups" ? rows(topups.data) : section === "receipts" ? rows(receipts.data) : section === "subscriptions" ? rows(subscriptions.data) : section === "journal" ? rows(journal.data) : rows(transfers.data);
  const pageInfo = (section === "accounts" ? accounts.data : section === "topups" ? topups.data : section === "receipts" ? receipts.data : section === "subscriptions" ? subscriptions.data : section === "journal" ? journal.data : transfers.data) as Row | undefined;
  const total = num(get(pageInfo, "total")) ?? dataRows.length;
  const totalPages = num(get(pageInfo, "totalPages")) ?? Math.max(1, Math.ceil(total / pageSize));
  const orgRows = rows(organizations.data);
  const eligibleOrganizations = orgRows.filter(item => ["company", "provider"].includes(String(get(item, "kind", "organizationKind", "organization_kind"))) && (finance || get(item, "kind", "organizationKind", "organization_kind") === "company"));
  const receiptItems = rows(receipts.data);
  const accountScopeRows = rows(accountScopes.data);
  const filteredBankRows = useMemo(() => rows(banks.data).filter(row => {
    const haystack = `${get(row, "bankName", "bank_name") ?? ""} ${get(row, "displayLabel", "display_label") ?? ""} ${get(row, "accountLast4", "account_last4") ?? ""}`.toLocaleLowerCase();
    return (!search.trim() || haystack.includes(search.trim().toLocaleLowerCase()))
      && (!statusFilter || String(get(row, "status")) === statusFilter);
  }), [banks.data, search, statusFilter]);
  const visibleBankRows = filteredBankRows.slice((page - 1) * pageSize, page * pageSize);
  const bankRows = rows(banks.data).filter(activeStatus);
  const fieldName = (row: Row) => text(get(row, "organizationName", "organization_name", "name", "displayLabel", "display_label", "bankName", "bank_name"), "سجل مالي");
  const summaryData = summary.data as Row | undefined;
  const summaryMetrics: Array<[string, string, string, ReactNode]> = [
    ["أموال الشركات", currency(get(summaryData, "companyFundsMinor")), "الرصيد الدفتري لحسابات التمويل", <Banknote size={18}/>],
    ["محجوز", currency(get(summaryData, "reservedMinor")), "جزء غير متاح من الرصيد", <LockKeyhole size={18}/>],
    ["المتاح", currency(get(summaryData, "availableMinor")), "بعد احتساب المبالغ المحجوزة", <WalletCards size={18}/>],
    ["غير مخصّص", currency(get(summaryData, "unallocatedReceiptsMinor")), "إيصالات لم تُربط بعد", <ArrowDownLeft size={18}/>],
    ["معلّق للاشتراكات", currency(get(summaryData, "subscriptionHeldMinor")), "لا يفعّل الاشتراك", <Clock3 size={18}/>],
    ["مستحق للتجار", currency(get(summaryData, "merchantPayableMinor")), "التزام محاسبي قائم", <ArrowLeftRight size={18}/>],
  ];
  const queryError = (queryForSection as { isError?: boolean; error?: unknown }).isError;
  const queryLoading = (queryForSection as { isLoading?: boolean }).isLoading;
  const retryCurrent = () => void (queryForSection as { refetch: () => Promise<unknown> }).refetch();

  if (!canSubmit && !canRead) return <main className="af-page" dir="rtl"><StateMessage title="هذه المساحة غير متاحة">لا يملك الحساب الحالي دورًا مخولًا للوصول إلى السجلات المالية.</StateMessage></main>;
  return <main className="af-page" dir="rtl">
    <header className="af-heading">
      <div><span className="af-kicker"><i/>Pertomax EG / الإدارة المالية</span><h1>مكتب الضبط المالي</h1><p>سجل حيّ للتحصيلات والأرصدة والقرارات. كل تغيير موثّق، ولا يُفترض إثبات المال.</p></div>
      <div className="af-security"><LockKeyhole size={16}/><span><b>بيانات خاصة</b><small>{finance ? "وصول مالي موثّق" : auditor ? "وصول تدقيق للقراءة فقط" : "نطاق العمليات"}</small></span></div>
    </header>
    <nav className="af-tabs" aria-label="أقسام المكتب المالي">
      {nav.filter(([key]) => key === "topups" ? canSubmit : canRead).map(([key, caption, icon]) =>
        <button key={key} type="button" className={section === key ? "is-active" : ""} aria-current={section === key ? "page" : undefined} onClick={() => { setSection(key); setPage(1); setSearch(""); setStatusFilter(""); }}><span>{icon}</span>{caption}</button>)}
    </nav>
    {message && !action && <div className="af-notice" role="status"><Check size={16}/>{message}<button onClick={() => setMessage("")} aria-label="إخفاء"><X size={15}/></button></div>}
    {problem && !action && <div className="af-alert" role="alert"><CircleAlert size={16}/>{problem}<button onClick={() => setProblem("")} aria-label="إخفاء"><X size={15}/></button></div>}

    {section === "overview" && <section className="af-overview af-enter">
      <div className="af-overview-intro"><div><span className="af-kicker">قراءة مباشرة من السجل</span><h2>الصورة المالية الآن</h2><p>الأرقام كما أعادها الخادم؛ المبالغ معروضة بالجنيه والقرش دون تقريب عشري.</p></div><button className="af-button af-button-soft" onClick={() => void summary.refetch()}><RefreshCw size={15}/>تحديث الملخص</button></div>
      {summary.isLoading ? <Skeletons/> : summary.isError ? <StateMessage title={apiStatus(summary.error) === 403 ? "غير مخوّل بقراءة الملخص" : "تعذر تحميل الملخص"} error retry={() => void summary.refetch()}>{errorText(summary.error)}</StateMessage> : <>
        <div className="af-metrics">{summaryMetrics.map(([name, value, note, icon]) => <article key={name} className="af-metric"><div><span>{name}</span><i>{icon}</i></div><strong dir="auto">{value}</strong><small>{note}</small></article>)}</div>
        <div className="af-count-strip"><span><b>{num(get(summaryData, "pendingTopups"))?.toLocaleString("ar-EG") ?? "—"}</b> طلب شحن بانتظار القرار</span><span><b>{num(get(summaryData, "pendingBankAccounts"))?.toLocaleString("ar-EG") ?? "—"}</b> حساب استقبال بانتظار الاعتماد</span><span><b>{num(get(summaryData, "collectedSubscriptionsOnHold"))?.toLocaleString("ar-EG") ?? "—"}</b> تحصيل اشتراك معلّق</span></div>
        <div className="af-overview-grid"><article className="af-panel af-ledger-note"><span className="af-kicker">قاعدة تشغيل</span><h3>المطابقة اليدوية تسبق القيد.</h3><p>المرفقات وثائق مساندة فقط. تسجيل الإيصال أو اعتماد الشحن يتطلب مراجعة المرجع في كشف البنك وتأكيدًا صريحًا.</p><span className="af-ledger-rule"><ShieldCheck size={16}/>لا تكامل مصرفي خارجي</span></article>
          <article className="af-panel af-quick"><span className="af-kicker">مسارات العمل</span><button onClick={() => setSection("topups")}><Banknote size={17}/><span><b>طلبات الشحن</b><small>مسودة، مستندات، مراجعة واعتماد</small></span><ChevronLeft size={15}/></button><button onClick={() => setSection("receipts")}><FileCheck2 size={17}/><span><b>الإيصالات</b><small>تسجيل القبض ثم تخصيص الرصيد</small></span><ChevronLeft size={15}/></button><button onClick={() => setSection("journal")}><ClipboardList size={17}/><span><b>دفتر القيود</b><small>سجل غير قابل للتعديل مع عكس موثّق</small></span><ChevronLeft size={15}/></button></article>
        </div>
        <div className="af-footnote"><LockKeyhole size={14}/> صلاحية مستقلة للمراجعة، والاعتماد النهائي يخضع لفصل المهام الذي يفرضه الخادم.</div>
      </>}
    </section>}

    {section !== "overview" && <>
      <div className="af-section-head"><div><span className="af-kicker">سجل فعلي · لا بيانات افتراضية</span><h2>{title}</h2><p>{section === "reconciliation" ? "قراءة فقط لمجاميع المطابقة. لا تُنشأ قيود من شاشة المطابقة." : "ابحث وصفِّ السجل ثم افتح التفاصيل أو الإجراء المخوّل."}</p></div>
        <div className="af-head-actions">
          {section === "topups" && canSubmit && <button className="af-button" onClick={() => openAction("topup")}><Plus size={16}/>طلب شحن</button>}
          {section === "receipts" && finance && <button className="af-button" onClick={() => openAction("receipt")}><Plus size={16}/>تسجيل إيصال</button>}
          {section === "accounts" && finance && <button className="af-button af-button-soft" onClick={() => openAction("transfer")}><ArrowLeftRight size={16}/>تحويل داخلي</button>}
          {section === "banks" && finance && <button className="af-button" onClick={() => openAction("bank")}><Plus size={16}/>إضافة حساب استقبال</button>}
          <button className="af-icon-button" aria-label="تحديث السجل" onClick={retryCurrent}><RefreshCw size={16}/></button>
        </div>
      </div>
      {["accounts", "banks", "topups", "receipts", "subscriptions", "journal"].includes(section) && <div className="af-tools">
        <label className="af-search"><Search size={16}/><input value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} placeholder="بحث في السجل" aria-label="بحث في السجل"/></label>
        {(section === "topups" || section === "banks") && <label className="af-filter">الحالة<select value={statusFilter} onChange={event => { setStatusFilter(event.target.value); setPage(1); }}><option value="">كل الحالات</option>{(section === "topups" ? ["draft", "submitted", "needs_info", "rejected", "partially_funded", "funded"] : ["pending", "active", "disabled"]).map(value => <option key={value} value={value}>{statusName(value)}</option>)}</select></label>}
        {section === "accounts" && canRead && <label className="af-filter">الجهة<select value={transferOrg} onChange={event => { setTransferOrg(event.target.value); setPage(1); }}><option value="">كل الجهات</option>{orgRows.map(row => <option key={String(get(row, "id"))} value={String(get(row, "id"))}>{fieldName(row)}</option>)}</select></label>}
      </div>}

      {section === "reconciliation" ? queryLoading ? <Skeletons/> : queryError ? <StateMessage title={apiStatus(reconciliation.error) === 403 ? "غير مخوّل بقراءة المطابقة" : "تعذر تحميل المطابقة"} error retry={() => void reconciliation.refetch()}>{errorText(reconciliation.error)}</StateMessage> : <Reconciliation data={reconciliation.data}/> :
      queryLoading ? <Skeletons/> : queryError ? <StateMessage title={apiStatus((queryForSection as { error?: unknown }).error) === 403 ? "غير مخوّل بقراءة هذا السجل" : "تعذر تحميل السجل"} error retry={retryCurrent}>{errorText((queryForSection as { error?: unknown }).error)}</StateMessage> :
      section === "accounts" ? <AccountsTable accounts={dataRows} transfers={rows(transfers.data)} canMutate={finance} loading={transfers.isLoading} onTransfer={() => openAction("transfer")} onOrg={setTransferOrg} onPage={setPage} page={page} total={total} pages={totalPages} /> :
      section === "banks" ? <BanksTable items={visibleBankRows} total={filteredBankRows.length} page={page} pages={Math.max(1, Math.ceil(filteredBankRows.length / pageSize))} onPage={setPage} canMutate={finance} onAction={(kind, item) => openAction(kind === "approve" ? "bankApprove" : "bankDisable", item)} /> :
      section === "topups" ? <TopupsTable items={dataRows} page={page} total={total} pages={totalPages} onPage={setPage} onOpen={row => { setSelectedTopup(String(get(row, "id") ?? "")); setSelected(row); setMessage(""); setProblem(""); }} canReview={finance} canSubmit={canSubmit} /> :
       section === "receipts" ? <ReceiptsTable items={dataRows} page={page} total={total} pages={totalPages} onPage={setPage} canAllocate={finance} onAllocate={row => { openAction("allocate", row); setAllocateReceiptId(String(get(row, "id") ?? "")); }} onSelect={row => setSelectedReceipt(String(get(row, "id") ?? ""))} /> :
      section === "subscriptions" ? <SubscriptionsTable items={dataRows} page={page} total={total} pages={totalPages} onPage={setPage} canAllocate={finance} onAllocate={row => openAction("allocate", row)} /> :
      <JournalTable items={dataRows} page={page} total={total} pages={totalPages} onPage={setPage} canReverse={finance} onDetail={row => setEntryId(String(get(row, "id", "entryId") ?? ""))} onReverse={row => openAction("reverse", row)} />}
    </>}

    {section === "topups" && selectedTopup && <TopupDetail detail={topupDetail.data} loading={topupDetail.isLoading} error={topupDetail.error} canReview={finance} canSubmit={canSubmit} canApprove={finance} onClose={() => { setSelectedTopup(""); setSelected(null); }} onSubmit={row => openAction("topupSubmit", row)} onEdit={row => openAction("topupEdit", row)} onReview={row => openAction("review", row)} onApprove={row => openAction("approve", row)} onUpload={async (row, selectedFile) => { setBusy(true); setProblem(""); try { if (!["draft", "needs_info"].includes(String(get(row, "status")))) throw new Error("يمكن رفع الدليل للمسودة أو للطلب المستكمل فقط."); await uploadFile("topup_request", String(get(row, "id")), selectedFile); await cache.invalidateQueries({ queryKey: getGetAdminFinanceTopupQueryKey(String(get(row, "id"))) }); setMessage("تم رفع المستند الخاص. لا يُعدّ المرفق إثباتًا للتحصيل."); } catch (error) { setProblem(errorText(error)); } finally { setBusy(false); } }} busy={busy} />}
    {section === "receipts" && selectedReceipt && <ReceiptEvidence receiptId={selectedReceipt} query={receiptDocs} canUpload={finance} onClose={() => setSelectedReceipt("")}/>}
    {entryId && <JournalDetail detail={journalDetail.data} loading={journalDetail.isLoading} error={journalDetail.error} onClose={() => setEntryId("")}/>}
    {action && <ActionDialog kind={action} selected={selected} organizations={eligibleOrganizations} banks={bankRows} receipts={action === "allocate" ? rows(allocationReceipts.data) : receiptItems} topups={rows(allocationTopups.data)} subscriptions={rows(allocationSubscriptions.data)} allocationType={allocationType} setAllocationType={setAllocationType} allocationTargetId={allocationTargetId} setAllocationTargetId={setAllocationTargetId} allocateReceiptId={allocateReceiptId} setAllocateReceiptId={setAllocateReceiptId} accountRows={accountScopeRows} reason={reason} setReason={setReason} organizationId={organizationId} setOrganizationId={setOrganizationId} branchId={branchId} setBranchId={setBranchId} bankId={bankId} setBankId={setBankId} file={file} setFile={setFile} problem={problem} message={message} busy={busy} receiptRecorded={receiptRecorded} onClose={closeAction} onSubmit={submitForm} pendingReceiptEvidence={pendingReceiptEvidence} onRetryEvidence={async () => { if (!pendingReceiptEvidence || !file) return; setBusy(true); setProblem(""); try { await uploadFile("receipt", pendingReceiptEvidence, file); setMessage("تم رفع المستند للإيصال المسجّل مسبقًا."); setSelectedReceipt(pendingReceiptEvidence); await cache.invalidateQueries({ queryKey: getListOrganizationDocumentsQueryKey({ receiptId: pendingReceiptEvidence }) }); closeAction(); } catch (error) { setProblem(errorText(error)); } finally { setBusy(false); } }} />}
  </main>;

  function docsReady(row: Row) {
    const docs = get(row, "documents", "evidence", "attachments");
    return Array.isArray(docs) && docs.some(doc =>
      ["pending_review", "approved"].includes(String(get(doc, "status")))
      && !!get(doc, "uploadedAt", "uploaded_at"),
    );
  }
}

function PageControls({ page, total, pages, onPage }: { page: number; total: number; pages: number; onPage: (page: number) => void }) {
  return <div className="af-pagination"><span>{total.toLocaleString("ar-EG")} سجل</span><div><button disabled={page <= 1} onClick={() => onPage(page - 1)}>السابق</button><b>صفحة {page.toLocaleString("ar-EG")} من {pages.toLocaleString("ar-EG")}</b><button disabled={page >= pages} onClick={() => onPage(page + 1)}>التالي</button></div></div>;
}
function Empty({ title, detail }: { title: string; detail: string }) { return <StateMessage title={title}>{detail}</StateMessage>; }
function AccountsTable({ accounts, transfers, canMutate, loading, onTransfer, onPage, page, total, pages }: { accounts: Row[]; transfers: Row[]; canMutate: boolean; loading: boolean; onTransfer: () => void; onOrg: (value: string) => void; onPage: (page: number) => void; page: number; total: number; pages: number }) {
  return <div className="af-stack"><RecordTable title="أرصدة الجهات والفروع" items={accounts} empty="لا توجد حسابات مالية في هذا العرض." columns={["الجهة", "النطاق", "الرصيد", "محجوز", "متاح", "نوع الحساب"]} render={row => <><td><b>{text(get(row, "organizationName", "organization_name", "name"))}</b><small>{text(get(row, "organizationKind", "organization_kind", "kind"), "")}</small></td><td>{text(get(row, "branchName", "branch_name"), "الحساب الرئيسي")}</td><td className="af-money">{currency(get(row, "ledgerBalanceMinor", "balanceMinor", "balance_minor"))}</td><td className="af-money">{currency(get(row, "reservedMinor", "reserved_minor"))}</td><td className="af-money">{currency(get(row, "availableMinor", "available_minor"))}</td><td>{statusName(get(row, "accountKind", "account_kind"))}</td></>} page={page} total={total} pages={pages} onPage={onPage}/><section className="af-panel"><header className="af-panel-title"><div><span className="af-kicker">الحركات بين الفروع</span><h3>تحويلات داخلية حديثة</h3></div>{canMutate && <button className="af-button af-button-soft" onClick={onTransfer}><ArrowLeftRight size={15}/>تحويل داخلي</button>}</header>{loading ? <Skeletons/> : transfers.length ? <div className="af-record-list">{transfers.slice(0, 8).map((item, index) => <article className="af-record" key={String(get(item, "id") ?? index)}><span className="af-record-icon"><ArrowLeftRight size={16}/></span><div><b>{text(get(item, "reference", "transferReference"), "تحويل")}</b><small>{text(get(item, "sourceAccountName", "source_account_name"), "الحساب الرئيسي")} ← {text(get(item, "targetAccountName", "target_account_name"), "الحساب الرئيسي")}</small></div><strong className="af-money">{currency(get(item, "amountMinor", "amount_minor"))}</strong><time>{dateText(get(item, "createdAt", "created_at"))}</time></article>)}</div> : <Empty title="لا توجد تحويلات في هذا السجل" detail="ستظهر التحويلات بعد تسجيلها من حساب مالي مخوّل."/>}</section></div>;
}
function RecordTable({ title, items, columns, render, empty, page, total, pages, onPage }: { title: string; items: Row[]; columns: string[]; render: (row: Row) => ReactNode; empty: string; page: number; total: number; pages: number; onPage: (page: number) => void }) {
  return <section className="af-panel af-table-panel"><header className="af-panel-title"><div><span className="af-kicker">السجلات المعتمدة</span><h3>{title}</h3></div><span className="af-count">{total.toLocaleString("ar-EG")} سجل</span></header>{items.length === 0 ? <Empty title="لا توجد سجلات مطابقة" detail={empty}/> : <><div className="af-table-scroll"><table><thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{items.map((row, index) => <tr key={String(get(row, "id") ?? index)}>{render(row)}</tr>)}</tbody></table></div><PageControls page={page} total={total} pages={pages} onPage={onPage}/></>}</section>;
}
function BanksTable({ items, total, page, pages, onPage, canMutate, onAction }: { items: Row[]; total: number; page: number; pages: number; onPage: (page: number) => void; canMutate: boolean; onAction: (kind: "approve" | "disable", item: Row) => void }) {
  return <RecordTable title="حسابات الاستقبال البنكية" items={items} empty="لا توجد حسابات استقبال مطابقة." columns={["الحساب", "البنك", "آخر أرقام", "الحالة", "سبب الإجراء", ...(canMutate ? ["الإجراء"] : [])]} page={page} total={total} pages={pages} onPage={onPage} render={row => <><td><b>{text(get(row, "displayLabel", "display_label", "label"))}</b><small>بيانات حساسة محدودة العرض</small></td><td>{text(get(row, "bankName", "bank_name"))}</td><td dir="ltr">•••• {text(get(row, "accountLast4", "account_last4"))}</td><td><Status value={get(row, "status")}/></td><td>{text(get(row, "reason", "decisionReason", "decision_reason"))}</td>{canMutate && <td><div className="af-row-actions">{["pending", "needs_completion"].includes(String(get(row, "status"))) && <button onClick={() => onAction("approve", row)}>اعتماد</button>}{activeStatus(row) && <button className="af-danger-link" onClick={() => onAction("disable", row)}>إيقاف</button>}</div></td>}</>} />;
}
function TopupsTable({ items, page, total, pages, onPage, onOpen, canReview, canSubmit }: { items: Row[]; page: number; total: number; pages: number; onPage: (page: number) => void; onOpen: (row: Row) => void; canReview: boolean; canSubmit: boolean }) {
  return <RecordTable title="طلبات شحن الأرصدة" items={items} empty="لا توجد طلبات شحن مطابقة." columns={["الجهة", "المرجع", "المبلغ", "الحالة", "تاريخ الإنشاء", "السجل"]} page={page} total={total} pages={pages} onPage={onPage} render={row => <><td><b>{text(get(row, "organizationName", "organization_name"))}</b><small>{text(get(row, "payerBankName", "payer_bank_name"), "—")}</small></td><td dir="ltr">{text(get(row, "bankReference", "bank_reference", "maskedReference"), "—")}</td><td className="af-money">{currency(get(row, "requestedAmountMinor", "amountMinor", "amount_minor"))}</td><td><Status value={get(row, "status")}/></td><td>{dateText(get(row, "createdAt", "created_at"))}</td><td><button className="af-link-button" onClick={() => onOpen(row)}>{canSubmit && ["draft", "needs_info"].includes(String(get(row, "status"))) ? "استكمال الطلب" : canReview ? "مراجعة التفاصيل" : "عرض التفاصيل"}<ChevronLeft size={14}/></button></td></>} />;
}
function TopupDetail({ detail, loading, error, canReview, canSubmit, canApprove, onClose, onSubmit, onEdit, onReview, onApprove, onUpload, busy }: { detail: unknown; loading: boolean; error: unknown; canReview: boolean; canSubmit: boolean; canApprove: boolean; onClose: () => void; onSubmit: (row: Row) => void; onEdit: (row: Row) => void; onReview: (row: Row) => void; onApprove: (row: Row) => void; onUpload: (row: Row, file: File) => void; busy: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  if (loading) return <div className="af-overlay"><section className="af-dialog"><Skeletons/></section></div>;
  if (apiStatus(error) || !detail) return <div className="af-overlay"><section className="af-dialog"><button className="af-icon-button" onClick={onClose} aria-label="إغلاق"><X/></button><StateMessage title="تعذر تحميل تفاصيل طلب الشحن" error>{errorText(error)}</StateMessage></section></div>;
  const row = detail as Row;
  const docs = rows(get(row, "documents", "evidence", "attachments"));
  const status = String(get(row, "status"));
  return <div className="af-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="af-dialog af-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="af-topup-title">
    <header className="af-dialog-head"><div><span className="af-kicker">تفاصيل طلب الشحن · نسخة {text(get(row, "version"), "—")}</span><h2 id="af-topup-title">{text(get(row, "organizationName", "organization_name"), "طلب شحن")}</h2></div><button className="af-icon-button" onClick={onClose} aria-label="إغلاق"><X size={18}/></button></header>
    <div className="af-detail-grid">{[["الحالة", statusName(status)], ["المبلغ المطلوب", currency(get(row, "requestedAmountMinor", "amountMinor", "amount_minor"))], ["اسم بنك الدافع", text(get(row, "payerBankName", "payer_bank_name"))], ["المرجع البنكي", text(get(row, "bankReference", "bank_reference"))], ["تاريخ الإنشاء", dateText(get(row, "createdAt", "created_at"))], ["السبب", text(get(row, "reason"))]].map(([title, value]) => <div key={title}><small>{title}</small><b dir={title.includes("المرجع") ? "ltr" : "auto"}>{value}</b></div>)}</div>
    <section className="af-evidence"><header><div><span className="af-kicker">مستند خاص</span><h3>أدلة الطلب</h3></div>{["draft", "needs_info"].includes(status) && canSubmit && <label className="af-button af-button-soft"><Upload size={15}/>رفع مستند<input type="file" accept="application/pdf,image/png,image/jpeg" onChange={event => { const selected = event.target.files?.[0]; if (selected) { setFile(selected); onUpload(row, selected); } }}/></label>}</header>
      <p>الملف مساند فقط ولا يُعدّ إثباتًا لوصول المال. لا يمكن إرسال الطلب حتى يظهر مستند مرفوع في سجل الخادم.</p>
      {docs.length ? docs.map((doc, index) => <div className="af-doc" key={String(get(doc, "id") ?? index)}><FileText size={16}/><span><b>{text(get(doc, "file_name", "fileName"), "مستند")}</b><small>{statusName(get(doc, "status"))} · {text(get(doc, "content_type", "contentType"))}</small></span></div>) : <div className="af-evidence-empty">لا توجد مستندات مرفوعة بعد.</div>}
      {file && <small className="af-muted">آخر ملف مختار: {file.name}</small>}
    </section>
    <div className="af-dialog-actions">
      {["draft", "needs_info"].includes(status) && canSubmit && <><button className="af-button af-button-soft" onClick={() => onEdit(row)}>تعديل الطلب</button><button className="af-button" disabled={busy || !docs.some(doc => ["pending_review", "approved"].includes(String(get(doc, "status"))) && !!get(doc, "uploadedAt", "uploaded_at"))} onClick={() => onSubmit(row)}>إرسال للمراجعة</button></>}
      {status === "submitted" && canReview && <button className="af-button af-button-soft" onClick={() => onReview(row)}>قرار مراجعة</button>}
      {status === "submitted" && canApprove && <button className="af-button" onClick={() => onApprove(row)}>اعتماد التحصيل</button>}
      <button className="af-button af-button-soft" onClick={onClose}>إغلاق</button>
    </div>
  </section></div>;
}
function ReceiptsTable({ items, page, total, pages, onPage, canAllocate, onAllocate, onSelect }: { items: Row[]; page: number; total: number; pages: number; onPage: (page: number) => void; canAllocate: boolean; onAllocate: (row: Row) => void; onSelect: (row: Row) => void }) {
  return <RecordTable title="الإيصالات البنكية المسجلة" items={items} empty="لا توجد إيصالات مسجلة." columns={["الجهة", "المرجع البنكي", "المبلغ", "غير مخصص", "تاريخ القبض", "إجراء"]} page={page} total={total} pages={pages} onPage={onPage} render={row => <><td><b>{text(get(row, "organizationName", "organization_name"))}</b><small>{text(get(row, "branchName", "branch_name"), "الحساب الرئيسي")}</small></td><td dir="ltr">{text(get(row, "bankReference", "bank_reference"))}</td><td className="af-money">{currency(get(row, "amountMinor", "amount_minor"))}</td><td className="af-money">{currency(get(row, "unallocatedMinor", "unallocated_minor"))}</td><td>{dateText(get(row, "receivedAt", "createdAt", "created_at"))}</td><td><div className="af-row-actions"><button onClick={() => onSelect(row)}>المستندات</button>{canAllocate && <button onClick={() => onAllocate(row)}>تخصيص</button>}</div></td></>} />;
}
function ReceiptEvidence({ receiptId, query, canUpload, onClose }: { receiptId: string; query: { data?: unknown; isLoading: boolean; isError: boolean; error: unknown; refetch: () => Promise<unknown> }; canUpload: boolean; onClose: () => void }) {
  const items = rows(query.data);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  async function upload() {
    if (!file) return;
    setBusy(true); setProblem(""); setNotice("");
    try {
      if (file.size < 1 || file.size > 10 * 1024 * 1024 || !["application/pdf", "image/png", "image/jpeg"].includes(file.type)) throw new Error("تقبل المرفقات PDF أو PNG أو JPEG حتى ١٠ ميغابايت.");
      const payload: CreateDocumentUploadIntent = { contextType: "receipt", contextId: receiptId, documentType: "إثبات إيصال بنكي", fileName: file.name.slice(0, 160), contentType: file.type as CreateDocumentUploadIntent["contentType"], byteSize: file.size };
      const intent = await createDocumentUploadIntent(payload);
      await uploadOrganizationDocumentContent(intent.id, file);
      setNotice("تم رفع المستند إلى الإيصال المسجل؛ لم يُسجّل أي مبلغ جديد.");
      setFile(null); await query.refetch();
    } catch (error) { setProblem(errorText(error)); }
    finally { setBusy(false); }
  }
  return <div className="af-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="af-dialog" role="dialog" aria-modal="true" aria-labelledby="af-receipt-docs"><header className="af-dialog-head"><div><span className="af-kicker">إيصال مُسجّل · {receiptId.slice(0, 8)}</span><h2 id="af-receipt-docs">مستندات المساندة</h2></div><button className="af-icon-button" onClick={onClose} aria-label="إغلاق"><X size={18}/></button></header>{canUpload && <div className="af-upload-row"><label className="af-button af-button-soft"><Upload size={15}/>اختيار ملف<input type="file" accept="application/pdf,image/png,image/jpeg" onChange={event => setFile(event.target.files?.[0] ?? null)}/></label><button className="af-button" disabled={!file || busy} onClick={() => void upload()}>{busy ? "جارٍ الرفع…" : "رفع مستند"}</button><small>PDF أو PNG أو JPEG حتى ١٠ ميغابايت. الإيصال مسجل بالفعل ولا يُعاد تسجيل المال.</small></div>}{problem && <div className="af-alert" role="alert"><CircleAlert size={16}/>{problem}</div>}{notice && <div className="af-notice" role="status"><Check size={16}/>{notice}</div>}{query.isLoading ? <Skeletons/> : query.isError ? <StateMessage title="تعذر تحميل المستندات" error retry={() => void query.refetch()}>{errorText(query.error)}</StateMessage> : items.length === 0 ? <Empty title="لا توجد مستندات مرفوعة" detail="يمكن إرفاق مستند مساند دون تغيير سجل القبض."/> : items.map((doc, index) => <div className="af-doc" key={String(get(doc, "id") ?? index)}><FileText size={16}/><span><b>{text(get(doc, "file_name", "fileName"))}</b><small>{statusName(get(doc, "status"))} · {dateText(get(doc, "uploaded_at", "created_at"))}</small></span></div>)}</section></div>;
}
function SubscriptionsTable({ items, page, total, pages, onPage, canAllocate, onAllocate }: { items: Row[]; page: number; total: number; pages: number; onPage: (page: number) => void; canAllocate: boolean; onAllocate: (row: Row) => void }) {
  return <><div className="af-hold-note"><Clock3 size={17}/><span><b>المبالغ المحصّلة تبقى معلّقة</b><small>تخصيص المقبوض لا يفعّل الاشتراك؛ المعروض لقطة pending_payment محفوظة من الخادم.</small></span></div><RecordTable title="طلبات الاشتراك بانتظار التحصيل" items={items} empty="لا توجد سجلات pending_payment في هذا العرض." columns={["الجهة", "الخطة المحفوظة", "الفرع", "المبلغ في اللقطة", "الحالة", "الإجراء"]} page={page} total={total} pages={pages} onPage={onPage} render={row => <><td><b>{text(get(row, "organizationName", "organization_name"))}</b></td><td>{text(get(row, "planName", "plan_name"), "الخطة المحفوظة")}</td><td>{text(get(row, "branchName", "branch_name"), "—")}</td><td className="af-money">{currency(get(row, "amountDueMinor", "snapshotPriceMinor", "priceSnapshotMinor", "amountMinor", "amount_minor"))}</td><td><Status value={get(row, "collectionStatus", "status")}/></td><td>{canAllocate && <button className="af-link-button" onClick={() => onAllocate(row)}>تخصيص إيصال<ChevronLeft size={14}/></button>}</td></>} /></>;
}
function JournalTable({ items, page, total, pages, onPage, canReverse, onDetail, onReverse }: { items: Row[]; page: number; total: number; pages: number; onPage: (page: number) => void; canReverse: boolean; onDetail: (row: Row) => void; onReverse: (row: Row) => void }) {
  return <RecordTable title="القيود المحاسبية غير القابلة للتعديل" items={items} empty="لا توجد قيود في هذا العرض." columns={["معرّف القيد", "النوع", "الجهة", "مدين", "دائن", "تاريخ القيد", "السجل"]} page={page} total={total} pages={pages} onPage={onPage} render={row => <><td dir="ltr">{text(get(row, "id", "entryId"), "—").slice(0, 12)}</td><td><Status value={get(row, "entryType", "entry_type")}/></td><td>{text(get(row, "organizationName", "organization_name"))}</td><td className="af-money">{currency(get(row, "debitMinor", "debit_minor"))}</td><td className="af-money">{currency(get(row, "creditMinor", "credit_minor"))}</td><td>{dateText(get(row, "createdAt", "created_at"))}</td><td><div className="af-row-actions"><button onClick={() => onDetail(row)}>التفاصيل</button>{canReverse && !get(row, "reversedBy", "reversed_by") && <button className="af-danger-link" onClick={() => onReverse(row)}>عكس</button>}</div></td></>} />;
}
function JournalDetail({ detail, loading, error, onClose }: { detail: unknown; loading: boolean; error: unknown; onClose: () => void }) {
  const row = detail as Row | undefined;
  return <div className="af-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section className="af-dialog" role="dialog" aria-modal="true" aria-labelledby="af-journal-detail"><header className="af-dialog-head"><div><span className="af-kicker">دفتر القيود · تفاصيل محفوظة</span><h2 id="af-journal-detail">القيد المحاسبي</h2></div><button className="af-icon-button" onClick={onClose} aria-label="إغلاق"><X size={18}/></button></header>{loading ? <Skeletons/> : error ? <StateMessage title="تعذر تحميل تفاصيل القيد" error>{errorText(error)}</StateMessage> : <div className="af-detail-grid">{Object.entries(row ?? {}).filter(([key]) => !/secret|token|url|accountIdentifier/i.test(key)).map(([key, value]) => <div key={key}><small>{key.replaceAll(/([A-Z])/g, " $1")}</small><b>{typeof value === "string" && /minor|amount|debit|credit/i.test(key) ? currency(value) : typeof value === "object" ? JSON.stringify(value) : String(value ?? "—")}</b></div>)}</div>}</section></div>;
}
function Reconciliation({ data }: { data: unknown }) {
  const root = data && typeof data === "object" && !Array.isArray(data) ? data as Row : {};
  const metrics = Object.entries(root).filter(([key]) => key !== "issues");
  const issues = rows(get(root, "issues"));
  return <section className="af-panel af-recon"><header className="af-panel-title"><div><span className="af-kicker">قراءة فقط</span><h3>مؤشرات المطابقة</h3></div><Status value={get(root, "status")}/></header>{metrics.length === 0 ? <Empty title="لا توجد نتائج مطابقة" detail="لم يُرجع الخادم عناصر في هذا العرض."/> : <div className="af-recon-grid">{metrics.map(([key, value]) => <article key={key}><small>{key.replaceAll(/([A-Z])/g, " $1").replaceAll("_", " ")}</small><b>{/minor|amount/i.test(key) ? currency(value) : typeof value === "string" && !/^\d+$/.test(value) ? statusName(value) : String(value ?? "—")}</b></article>)}</div>}{issues.length > 0 && <div className="af-table-scroll"><table><thead><tr><th>الحساب</th><th>نوع الحساب</th><th>الرصيد الدفتري</th><th>محجوز</th><th>متاح</th></tr></thead><tbody>{issues.map((issue, index) => <tr key={String(get(issue, "accountId", "account_id") ?? index)}><td>{text(get(issue, "accountName", "account_name"))}</td><td>{statusName(get(issue, "accountKind", "account_kind"))}</td><td className="af-money">{currency(get(issue, "ledgerBalanceMinor", "ledger_balance_minor"))}</td><td className="af-money">{currency(get(issue, "reservedMinor", "reserved_minor"))}</td><td className="af-money">{currency(get(issue, "availableMinor", "available_minor"))}</td></tr>)}</tbody></table></div>}<p className="af-muted">لا تنشئ هذه الشاشة قيدًا ولا تغيّر الرصيد.</p></section>;
}

function decimalInput(value: unknown) {
  try {
    const minor = BigInt(String(value ?? ""));
    return `${minor / 100n}.${(minor % 100n).toString().padStart(2, "0")}`;
  } catch { return ""; }
}
function normalizedReference(value: unknown) {
  return String(value ?? "").trim().toLocaleLowerCase().replace(/\s+/g, "");
}
function ActionDialog({
  kind, selected, organizations, banks, receipts, topups, subscriptions, allocationType, setAllocationType, allocationTargetId, setAllocationTargetId,
  accountRows, allocateReceiptId, setAllocateReceiptId, reason, setReason, organizationId, setOrganizationId,
  branchId, setBranchId, bankId, setBankId, file, setFile, problem, message, busy,
  receiptRecorded, pendingReceiptEvidence, onClose, onSubmit, onRetryEvidence,
}: {
  kind: Exclude<ActionKind, null>; selected: Row | null; organizations: Row[]; banks: Row[]; receipts: Row[]; topups: Row[]; subscriptions: Row[];
  allocationType: "topup" | "subscription"; setAllocationType: (value: "topup" | "subscription") => void;
  allocationTargetId: string; setAllocationTargetId: (value: string) => void; accountRows: Row[];
  allocateReceiptId: string; setAllocateReceiptId: (value: string) => void;
  reason: string; setReason: (value: string) => void; organizationId: string; setOrganizationId: (value: string) => void;
  branchId: string; setBranchId: (value: string) => void; bankId: string; setBankId: (value: string) => void;
  file: File | null; setFile: (value: File | null) => void; problem: string; message: string; busy: boolean;
  receiptRecorded: boolean; pendingReceiptEvidence: string; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRetryEvidence: () => void;
}) {
  const selectedOrg = organizations.find(row => String(get(row, "id", "organizationId")) === organizationId);
  const selectedOrgKind = String(get(selectedOrg, "kind", "organizationKind", "organization_kind") ?? "");
  const listedBranches = rows(get(selectedOrg, "branches", "eligibleBranches", "eligible_branches"));
  const selectableOrganizations = organizations.filter(row => {
    const rowKind = String(get(row, "kind", "organizationKind", "organization_kind") ?? "");
    return kind === "receipt" ? ["company", "provider"].includes(rowKind) : rowKind === "company";
  });
  const branches = kind === "receipt" && selectedOrgKind !== "provider" ? [] : listedBranches;
  const scopeAccount = (scopeBranchId: string | null) => accountRows.find(account =>
    String(get(account, "organizationId", "organization_id")) === organizationId
    && String(get(account, "branchId", "branch_id") ?? "") === String(scopeBranchId ?? ""),
  );
  const scopeLabel = (branch: Row | null) => {
    const account = scopeAccount(branch ? String(get(branch, "id", "branchId", "branch_id")) : null);
    const name = branch ? text(get(branch, "name", "branchName", "branch_name")) : "الحساب الرئيسي";
    return `${name} · متاح ${currency(get(account, "availableMinor", "available_minor") ?? "0")}`;
  };
  const targetIsSubscription = allocationType === "subscription";
  const isSelectedReceipt = !!selected && (
    get(selected, "receiptNumber", "receipt_number") != null
    || get(selected, "unallocatedMinor", "unallocated_minor") != null
  );
  const selectedReceipt = receipts.find(row => String(get(row, "id", "receiptId", "receipt_id")) === allocateReceiptId)
    ?? (isSelectedReceipt ? selected : undefined);
  const selectedSubscriptionId = String(get(selected, "subscriptionId", "subscription_id") ?? "");
  const targets = targetIsSubscription
    ? (selectedSubscriptionId ? [selected as Row] : subscriptions)
    : topups.filter(row => ["submitted", "partially_funded"].includes(String(get(row, "status"))));
  const eligibleTargets = targets.filter(row => {
    if (selectedReceipt) {
      if (String(get(row, "organizationId", "organization_id")) !== String(get(selectedReceipt, "organizationId", "organization_id"))) return false;
      if (targetIsSubscription && String(get(row, "branchId", "branch_id") ?? "") !== String(get(selectedReceipt, "branchId", "branch_id") ?? "")) return false;
      if (!targetIsSubscription && normalizedReference(get(row, "bankReference", "bank_reference")) !== normalizedReference(get(selectedReceipt, "bankReference", "bank_reference"))) return false;
    }
    return true;
  });
  const targetRow = eligibleTargets.find(row => String(get(row, "subscriptionId", "subscription_id", "id")) === allocationTargetId);
  const sourceReceipts = selectedReceipt && !receipts.some(row =>
    String(get(row, "id", "receiptId", "receipt_id")) === String(get(selectedReceipt, "id", "receiptId", "receipt_id")),
  ) ? [...receipts, selectedReceipt] : receipts;
  const eligibleReceipts = sourceReceipts.filter(row => {
    const unallocated = get(row, "unallocatedMinor", "unallocated_minor");
    if (unallocated == null || BigInt(String(unallocated)) <= 0n) return false;
    if (selectedReceipt && String(get(row, "id", "receiptId", "receipt_id")) !== String(get(selectedReceipt, "id", "receiptId", "receipt_id"))) return false;
    if (targetRow) {
      if (String(get(row, "organizationId", "organization_id")) !== String(get(targetRow, "organizationId", "organization_id"))) return false;
      if (targetIsSubscription && String(get(row, "branchId", "branch_id") ?? "") !== String(get(targetRow, "branchId", "branch_id") ?? "")) return false;
      if (!targetIsSubscription && normalizedReference(get(row, "bankReference", "bank_reference")) !== normalizedReference(get(targetRow, "bankReference", "bank_reference"))) return false;
    }
    return true;
  });
  const defaults = selected ?? {};
  const titles: Record<Exclude<ActionKind, null>, string> = {
    bank: "إضافة حساب استقبال", bankApprove: "اعتماد حساب استقبال", bankDisable: "إيقاف حساب استقبال",
    topup: "إنشاء طلب شحن", topupEdit: "تعديل مسودة الشحن", topupSubmit: "إرسال طلب الشحن",
    receipt: "تسجيل إيصال بنكي", transfer: "تحويل داخلي بين الفروع", review: "قرار مراجعة طلب الشحن",
    approve: "اعتماد التحصيل", allocate: "تخصيص إيصال", reverse: "إنشاء قيد عكسي",
  };
  const uploadOnly = receiptRecorded && kind === "receipt";
  return <div className="af-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="af-dialog" role="dialog" aria-modal="true" aria-labelledby="af-action-title">
      <header className="af-dialog-head"><div><span className="af-kicker">إجراء مالي موثّق</span><h2 id="af-action-title">{titles[kind]}</h2><p>المبلغ بالجنيه والقرش. إذا تعذر تأكيد النتيجة، أعد المحاولة بالحقول نفسها ثم راجع الحالة قبل أي إجراء جديد.</p></div><button type="button" className="af-icon-button" onClick={onClose} aria-label="إغلاق" disabled={busy}><X size={18}/></button></header>
      {uploadOnly && <div className="af-posted-note" role="status"><Check size={17}/><span><b>تم تسجيل القبض بالفعل</b><small>رفع المستند إجراء منفصل؛ لن يعاد تسجيل أي مبلغ عند إعادة المحاولة. رقم الإيصال {pendingReceiptEvidence || "—"}</small></span></div>}
      <form className="af-form-grid" onSubmit={onSubmit}>
        {kind === "bank" && <>
          <Field title="اسم البنك"><input name="bankName" required minLength={2} maxLength={100}/></Field>
          <Field title="وصف الحساب"><input name="displayLabel" required minLength={2} maxLength={100} placeholder="حساب التحصيل الرئيسي"/></Field>
          <Field title="آخر أربعة أرقام"><input name="accountLast4" required pattern="[0-9]{4}" maxLength={4} dir="ltr" inputMode="numeric"/></Field>
        </>}
        {(kind === "topup" || kind === "receipt" || kind === "transfer") && <Field title="الجهة المؤهلة" wide>
          <select required value={organizationId} onChange={event => { setOrganizationId(event.target.value); setBranchId(""); }}>
            <option value="">اختر جهة من السجل الفعلي</option>{selectableOrganizations.map(row => <option key={String(get(row, "id"))} value={String(get(row, "id"))}>{text(get(row, "name", "organizationName", "organization_name"))} · {String(get(row, "kind", "organizationKind", "organization_kind")) === "provider" ? "مقدّم خدمة" : "شركة"}</option>)}
          </select>
        </Field>}
        {(kind === "topup" || kind === "topupEdit") && <>
          <Field title="المبلغ المطلوب (جنيه)"><input name="amount" type="text" inputMode="decimal" dir="ltr" required defaultValue={kind === "topupEdit" ? decimalInput(get(defaults, "requestedAmountMinor", "amountMinor", "amount_minor")) : ""} placeholder="مثال: 1250.50"/></Field>
          <Field title="بنك الدافع"><input name="payerBankName" required minLength={2} maxLength={100} defaultValue={String(get(defaults, "payerBankName", "payer_bank_name") ?? "")}/></Field>
          <Field title="المرجع البنكي" wide><input name="bankReference" required minLength={2} maxLength={160} dir="ltr" defaultValue={String(get(defaults, "bankReference", "bank_reference") ?? "")}/></Field>
        </>}
        {kind === "receipt" && <>
          {!uploadOnly && <>
            <Field title="فرع الجهة (اختياري)"><select value={branchId} onChange={event => setBranchId(event.target.value)}><option value="">الحساب الرئيسي</option>{branches.map(row => <option key={String(get(row, "id", "branchId"))} value={String(get(row, "id", "branchId"))}>{text(get(row, "name", "branchName", "branch_name"))}</option>)}</select></Field>
            <Field title="حساب الاستقبال النشط"><select required value={bankId} onChange={event => setBankId(event.target.value)}><option value="">اختر حسابًا معتمدًا</option>{banks.map(row => <option key={String(get(row, "bankAccountId", "bank_account_id", "id"))} value={String(get(row, "bankAccountId", "bank_account_id", "id"))}>{text(get(row, "displayLabel", "display_label"))} · {text(get(row, "bankName", "bank_name"))} · •••• {text(get(row, "accountLast4", "account_last4"))}</option>)}</select></Field>
            <Field title="المبلغ المقبوض (جنيه)"><input name="amount" type="text" inputMode="decimal" dir="ltr" required placeholder="0.00"/></Field>
            <Field title="بنك الدافع"><input name="payerBankName" required minLength={2} maxLength={100}/></Field>
            <Field title="المرجع البنكي"><input name="bankReference" required minLength={2} maxLength={160} dir="ltr"/></Field>
            <label className="af-confirm af-wide"><input type="checkbox" name="confirmed" required/><span><b>أؤكد مطابقة المبلغ والمرجع يدويًا مع كشف البنك</b><small>لا يوجد تكامل مصرفي؛ المرفق وحده ليس إثباتًا للمال.</small></span></label>
          </>}
          <Field title="مستند مساند (اختياري)" wide><input type="file" accept="application/pdf,image/png,image/jpeg" onChange={event => setFile(event.target.files?.[0] ?? null)}/><small>PDF أو PNG أو JPEG حتى ١٠ ميغابايت. {uploadOnly ? "الإيصال مسجل بالفعل." : "يرفع بعد تأكيد تسجيل الإيصال."}</small></Field>
          {uploadOnly && <button type="button" className="af-button" disabled={busy || !file} onClick={onRetryEvidence}><Upload size={15}/>رفع / إعادة محاولة المستند دون تسجيل المال مجددًا</button>}
        </>}
        {kind === "transfer" && <>
          <Field title="من الحساب / الفرع"><select name="sourceBranchId"><option value="">{scopeLabel(null)}</option>{branches.map(row => <option key={String(get(row, "id", "branchId"))} value={String(get(row, "id", "branchId"))}>{scopeLabel(row)}</option>)}</select></Field>
          <Field title="إلى الحساب / الفرع"><select name="targetBranchId"><option value="">{scopeLabel(null)}</option>{branches.map(row => <option key={String(get(row, "id", "branchId"))} value={String(get(row, "id", "branchId"))}>{scopeLabel(row)}</option>)}</select></Field>
          <Field title="المبلغ (جنيه)"><input name="amount" type="text" inputMode="decimal" dir="ltr" required placeholder="0.00"/></Field>
          <Field title="مرجع التحويل"><input name="reference" required minLength={2} maxLength={160} dir="ltr"/></Field>
          <p className="af-hint af-wide">المصدر والوجهة فروع من الجهة المختارة فقط؛ القيمة الفارغة تمثل الحساب الرئيسي. تُرسل معرّفات الفروع، لا معرّفات الحسابات المالية.</p>
        </>}
        {kind === "bankApprove" && <p className="af-hint af-wide">سيظل الاعتماد خاضعًا لفصل المهام والتحقق المستقل على الخادم.</p>}
        {kind === "bankDisable" && <p className="af-hint af-wide">لن يُستخدم هذا الحساب كوجهة لقبض جديد بعد الإيقاف.</p>}
        {kind === "review" && <Field title="قرار المراجعة"><select name="decision" defaultValue="needs_info"><option value="needs_info">بحاجة إلى معلومات</option><option value="reject">رفض</option></select></Field>}
        {kind === "approve" && <>
          <Field title="حساب الاستقبال النشط" wide><select required value={bankId} onChange={event => setBankId(event.target.value)}><option value="">اختر حسابًا معتمدًا</option>{banks.map(row => <option key={String(get(row, "bankAccountId", "bank_account_id", "id"))} value={String(get(row, "bankAccountId", "bank_account_id", "id"))}>{text(get(row, "displayLabel", "display_label"))} · {text(get(row, "bankName", "bank_name"))} · •••• {text(get(row, "accountLast4", "account_last4"))}</option>)}</select></Field>
          <Field title="المبلغ الفعلي المطابق (جنيه)"><input name="actualAmount" type="text" inputMode="decimal" dir="ltr" required placeholder="0.00"/></Field>
          <Field title="مبلغ التخصيص (اختياري)"><input name="allocationAmount" type="text" inputMode="decimal" dir="ltr" placeholder="اتركه فارغًا للتخصيص الافتراضي"/></Field>
          <label className="af-confirm af-wide"><input type="checkbox" name="confirmed" required/><span><b>أؤكد مطابقة المبلغ والمرجع يدويًا مع كشف البنك</b><small>الاعتماد المالي لا يعتمد على ملف مرفق.</small></span></label>
        </>}
        {kind === "allocate" && <>
          <Field title="الإيصال المصدر" wide><select required value={allocateReceiptId} onChange={event => setAllocateReceiptId(event.target.value)}><option value="">اختر إيصالًا مسجلًا</option>{eligibleReceipts.map(row => <option key={String(get(row, "id", "receiptId", "receipt_id"))} value={String(get(row, "id", "receiptId", "receipt_id"))}>{text(get(row, "receiptNumber", "receipt_number"), "إيصال")} · {text(get(row, "organizationName", "organization_name"))} · {currency(get(row, "unallocatedMinor", "unallocated_minor"))} غير مخصص</option>)}</select>{eligibleReceipts.length === 0 && <small>لا يوجد إيصال غير مخصص ضمن نطاق الطلب المحدد.</small>}</Field>
          <Field title="نوع التخصيص"><select name="targetType" value={allocationType} onChange={event => { setAllocationType(event.target.value as "topup" | "subscription"); setAllocationTargetId(""); }} disabled={!!selectedSubscriptionId}><option value="topup">طلب شحن</option><option value="subscription">اشتراك بانتظار التحصيل</option></select>{selectedSubscriptionId && <input type="hidden" name="targetType" value="subscription"/>}</Field>
          <Field title={targetIsSubscription ? "الاشتراك بانتظار التحصيل" : "طلب الشحن"}>
            <select name="targetId" required value={allocationTargetId} onChange={event => setAllocationTargetId(event.target.value)}>
              <option value="">{targetIsSubscription ? "اختر اشتراكًا مستحقًا" : "اختر طلب شحن مطابقًا"}</option>
              {eligibleTargets.map(row => {
                const id = String(get(row, "subscriptionId", "subscription_id", "id"));
                return <option key={id} value={id}>{text(get(row, "organizationName", "organization_name"))} · {targetIsSubscription ? text(get(row, "planName", "plan_name"), "اشتراك") : text(get(row, "bankReference", "bank_reference"), "طلب شحن")} · {currency(get(row, "amountDueMinor", "requestedAmountMinor", "amount_minor"))}</option>;
              })}
            </select>
            {eligibleTargets.length === 0 && <small>لا توجد أهداف مفتوحة مطابقة للجهة والفرع والمرجع.</small>}
          </Field>
          <Field title="المبلغ المخصص (جنيه)"><input name="amount" type="text" inputMode="decimal" dir="ltr" required placeholder="0.00"/></Field>
          <p className="af-hint af-wide">تخصيص الاشتراك يترك المبلغ معلّقًا ولا يفعّل الاشتراك.</p>
        </>}
        {kind === "reverse" && <p className="af-hint af-wide">القيد الأصلي غير قابل للتعديل؛ سيُنشأ قيد عكسي منفصل ومترابط.</p>}
        {!(kind === "receipt" && uploadOnly) && <Reason value={reason} onChange={setReason}/>}
        {problem && <div className="af-alert af-wide" role="alert"><CircleAlert size={16}/>{problem}</div>}
        {message && <div className="af-notice af-wide" role="status"><Check size={16}/>{message}</div>}
        {!uploadOnly && <div className="af-dialog-actions af-wide"><button className="af-button" disabled={busy || reason.trim().length < 5}>{busy ? "جارٍ تسجيل الإجراء…" : titles[kind]}</button><button type="button" className="af-button af-button-soft" disabled={busy} onClick={onClose}>إلغاء</button></div>}
      </form>
    </section>
  </div>;
}
