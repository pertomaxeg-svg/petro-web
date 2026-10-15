import { Fragment, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownWideNarrow, Banknote, Building2, CalendarDays, Check, ChevronDown, CircleAlert,
  Clock3, Filter, Layers3, Plus, RefreshCw, Search, ShieldAlert, Tag,
} from "lucide-react";
import {
  getGetAdminBillingCatalogQueryKey, getListBranchesQueryKey, getListOrganizationsQueryKey,
  useCancelAdminSubscription, useCreateAdminBillingPlan, useCreateAdminBillingPlanVersion,
  useCreateAdminSubscriptionRequest, useGetAdminBillingCatalog, useListBranches,
  useListOrganizations, usePublishAdminBillingPlanVersion, useReviewAdminSubscriptionRequest,
  useScheduleAdminBillingPlanStop,
} from "@workspace/api-client-react";
import type {
  AdminPlan, AdminPlanEntitlement, AdminPlanVersion,
  AdminSubscription, AdminSubscriptionRequest,
} from "@workspace/api-client-react";
import "./AdminBilling.css";

type Audience = "company" | "provider" | "station";
type RequestKind = "new" | "renewal" | "plan_change" | "custom_price";
type ReviewDecision = "approve" | "needs_changes" | "reject" | "cancel";
type PlanRecord = AdminPlan;
type PlanVersion = AdminPlanVersion;
type BillingRequest = AdminSubscriptionRequest;
type SubscriptionRecord = AdminSubscription;

const audienceLabel: Record<Audience, string> = {
  company: "شركة",
  provider: "مقدّم خدمة",
  station: "محطة",
};
const requestLabel: Record<RequestKind, string> = {
  new: "اشتراك جديد",
  renewal: "تجديد",
  plan_change: "تغيير خطة",
  custom_price: "سعر مخصص",
};
const statusLabel: Record<string, string> = {
  active: "نشط",
  approved: "معتمد",
  cancelled: "ملغى",
  draft: "مسودة",
  expired: "منتهي",
  needs_changes: "بحاجة لاستكمال",
  pending_payment: "بانتظار التحصيل",
  published: "منشور",
  rejected: "مرفوض",
  scheduled: "مجدول",
  stopped: "موقوف عن استقبال جديد",
  submitted: "مرسل للمراجعة",
  suspended: "موقوف",
  retired: "مؤرشف",
};
const pageSize = 20;
const apiErrorMessage = (error: unknown) => {
  const item = error as { message?: string; data?: { message?: string } };
  return item?.data?.message || item?.message || "تعذر إتمام الطلب. حاول مرة أخرى.";
};
const apiErrorStatus = (error: unknown) => {
  const item = error as { status?: number; response?: { status?: number } };
  return item?.status ?? item?.response?.status ?? 0;
};
const money = (minor: number | null | undefined) =>
  minor == null ? "غير محدد" : `${new Intl.NumberFormat("ar-EG").format(minor / 100)} ج.م`;
const dateLabel = (value: string | null | undefined) =>
  value ? new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "—";
const localDateTime = (date: Date) => {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
};
const defaultEnd = () => {
  const value = new Date();
  value.setFullYear(value.getFullYear() + 1);
  return localDateTime(value);
};
const defaultStart = () => localDateTime(new Date(Date.now() + 60_000));
const snapshotValue = (snapshot: Record<string, unknown>, key: string) => snapshot[key];
const displayValue = (value: unknown) => {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};

function StatusTag({ status }: { status: string }) {
  return <span className={`ac-status ac-status-${status}`}><i/>{statusLabel[status] ?? status}</span>;
}

function LoadingState() {
  return <section className="ac-state" aria-live="polite"><div className="ac-loading"><i/><i/><i/></div><h2>جارٍ تحميل سجل الباقات</h2><p>نعرض السجلات المحفوظة فقط.</p></section>;
}

function CatalogState({ error, retry }: { error: unknown; retry: () => void }) {
  const status = apiErrorStatus(error);
  const schemaUnavailable = status === 503;
  const forbidden = status === 403;
  return <section className={`ac-state ${schemaUnavailable || forbidden ? "" : "ac-state-error"}`} role="alert">
    <span className="ac-state-symbol">{forbidden ? <ShieldAlert size={20}/> : <CircleAlert size={20}/>}</span>
    <h2>{schemaUnavailable ? "مخطط الباقات غير مفعّل" : forbidden ? "لا تملك صلاحية الوصول" : "تعذر تحميل السجل"}</h2>
    <p>{schemaUnavailable
      ? "واجهة الإدارة جاهزة، لكن مخطط قاعدة البيانات لم يُعتمد بعد. لن تُعرض هذه الوظائف على أنها مفعّلة ولن تُنشأ سجلات بديلة."
      : forbidden ? "يتطلب هذا السجل جلسة مالك المنصة. لم تُعرض أي بيانات." : apiErrorMessage(error)}</p>
    {!schemaUnavailable && !forbidden && <button className="ac-button ac-button-quiet" onClick={retry}><RefreshCw size={15}/> إعادة المحاولة</button>}
  </section>;
}

function ReasonField() {
  return <label className="ab-field ab-wide">سبب موثق (5–500 حرف)
    <textarea name="reason" minLength={5} maxLength={500} required placeholder="اكتب سبب القرار أو التغيير بوضوح."/>
  </label>;
}

function JsonArrayField({ name, title }: { name: string; title: string }) {
  return <label className="ab-field ab-wide">{title}
    <textarea name={name} required defaultValue="[]" dir="ltr" spellCheck={false} placeholder="[]"/>
    <small>ابدأ بقائمة فارغة. لا تُعد الحقوق معتمدة ما لم تُسجل الموافقة صراحةً.</small>
  </label>;
}

function parseArray(raw: FormDataEntryValue | null, label: string): AdminPlanEntitlement[] {
  let value: unknown;
  try {
    value = JSON.parse(String(raw ?? ""));
  } catch {
    throw new Error(`${label}: أدخل JSON صالحًا.`);
  }
  if (!Array.isArray(value)) throw new Error(`${label}: القيمة المطلوبة قائمة.`);
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`${label}: استخدم عناصر JSON من نوع object.`);
    }
    const item = candidate as Record<string, unknown>;
    if (typeof item.key !== "string" || typeof item.label !== "string"
      || !Object.hasOwn(item, "value") || typeof item.approved !== "boolean") {
      throw new Error(`${label}: استخدم قائمة بعناصر لها key وlabel وvalue وapproved.`);
    }
  }
  return value as AdminPlanEntitlement[];
}

function PageHeading({
  eyebrow, title, description, action,
}: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="ac-heading-row">
    <div><span className="ac-eyebrow">{eyebrow} <i/></span><h1>{title}</h1><p>{description}</p></div>
    {action && <div className="ab-heading-action">{action}</div>}
  </div>;
}

function FixedPriceNote() {
  return <section className="ab-pricing-note" aria-label="الأسعار المعتمدة">
    <div className="ab-pricing-heading"><Banknote size={17}/><b>مرجع الأسعار المعتمد</b><span>جنيه مصري · سنوي</span></div>
    <div className="ab-pricing-grid">
      <div><span>الشركات</span><b>٥٠٠ / ٧٥٠ / ١٬٠٠٠</b><small>لكل مركبة</small></div>
      <div><span>مقدّمو الخدمات</span><b>٥٬٠٠٠</b><small>لكل فرع</small></div>
      <div><span>المحطات</span><b>مجاني</b><small>بلا عمولة أو رسم غسيل</small></div>
      <div><span>إصدار NFC</span><b>١٠٠</b><small>رسوم إصدار منفصلة</small></div>
    </div>
    <p>لا تشمل الأسعار ضريبة أو تركيبًا أو استبدالًا غير معتمد. لا يوجد احتساب نسبي للترقية أو محفظة مقابل رسوم الاشتراك.</p>
  </section>;
}

function SearchFilter({
  search, onSearch, filter, onFilter, filterOptions, onSort, sortLabel,
}: {
  search: string;
  onSearch: (value: string) => void;
  filter: string;
  onFilter: (value: string) => void;
  filterOptions: Array<[string, string]>;
  onSort: () => void;
  sortLabel: string;
}) {
  return <div className="ab-toolbar">
    <label className="ab-search"><Search size={15}/><input value={search} onChange={event => onSearch(event.target.value)} aria-label="بحث" placeholder="ابحث في السجلات"/></label>
    <label className="ab-filter"><Filter size={15}/><select value={filter} onChange={event => onFilter(event.target.value)} aria-label="تصفية">
      {filterOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select><ChevronDown size={13}/></label>
    <button type="button" className="ac-button ac-button-quiet ab-sort" onClick={onSort}><ArrowDownWideNarrow size={15}/>{sortLabel}</button>
  </div>;
}

function PageControls({
  page, total, onPage,
}: { page: number; total: number; onPage: (value: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return <div className="ab-pagination" aria-label="صفحات النتائج">
    <span>{total.toLocaleString("ar-EG")} سجل ضمن النتائج</span>
    <div><button type="button" className="ac-button ac-button-quiet" disabled={page <= 1} onClick={() => onPage(page - 1)}>السابق</button>
      <span>صفحة {page.toLocaleString("ar-EG")} من {pages.toLocaleString("ar-EG")}</span>
      <button type="button" className="ac-button ac-button-quiet" disabled={page >= pages} onClick={() => onPage(page + 1)}>التالي</button></div>
  </div>;
}

function useBillingCatalog() {
  const query = useGetAdminBillingCatalog({
    query: { queryKey: getGetAdminBillingCatalogQueryKey(), retry: false, refetchOnWindowFocus: false },
  });
  const cache = useQueryClient();
  const refresh = () => cache.invalidateQueries({ queryKey: getGetAdminBillingCatalogQueryKey() });
  return { query, refresh, plans: query.data?.plans ?? [], requests: query.data?.requests ?? [], subscriptions: query.data?.subscriptions ?? [] };
}

export function AdminPlansPage() {
  const { query, refresh, plans } = useBillingCatalog();
  const createPlan = useCreateAdminBillingPlan();
  const createVersion = useCreateAdminBillingPlanVersion();
  const publishVersion = usePublishAdminBillingPlanVersion();
  const scheduleStop = useScheduleAdminBillingPlanStop();
  const [search, setSearch] = useState("");
  const [audienceFilter, setAudienceFilter] = useState("all");
  const [sort, setSort] = useState(false);
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [createAudience, setCreateAudience] = useState<Audience>("company");
  const [versionPlan, setVersionPlan] = useState<PlanRecord | null>(null);
  const [stopPlan, setStopPlan] = useState<PlanRecord | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const values = plans.filter(plan =>
      (audienceFilter === "all" || plan.audience === audienceFilter)
      && (!needle || `${plan.name} ${plan.code} ${audienceLabel[plan.audience]}`.toLocaleLowerCase().includes(needle)),
    );
    return sort ? [...values].sort((left, right) => left.name.localeCompare(right.name, "ar")) : values;
  }, [plans, audienceFilter, search, sort]);
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);

  async function submitPlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    setSuccess("");
    const data = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await createPlan.mutateAsync({ data: {
        name: String(data.get("name")).trim(),
        code: String(data.get("code")).trim(),
        audience: String(data.get("audience")) as Audience,
        annualPriceMinor: Math.round(Number(data.get("price")) * 100),
        reason: String(data.get("reason")).trim(),
      } });
      await refresh();
      setCreateOpen(false);
      setSuccess("حُفظت الخطة كمسودة دون حقوق معتمدة.");
    } catch (error) {
      setFormError(apiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitVersion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!versionPlan) return;
    setFormError("");
    setSuccess("");
    const data = new FormData(event.currentTarget);
    try {
      const effectiveAt = new Date(String(data.get("effectiveAt")));
      if (Number.isNaN(effectiveAt.valueOf())) throw new Error("تاريخ السريان غير صالح.");
      const entitlements = parseArray(data.get("entitlements"), "الاستحقاقات");
      const settings = parseArray(data.get("settings"), "الإعدادات");
      setBusy(true);
      await createVersion.mutateAsync({ planId: versionPlan.id, data: {
        annualPriceMinor: Math.round(Number(data.get("price")) * 100),
        effectiveAt: effectiveAt.toISOString(),
        entitlements,
        settings,
        reason: String(data.get("reason")).trim(),
      } });
      await refresh();
      setVersionPlan(null);
      setSuccess("حُفظ الإصدار كمسودة. لن يُنشر حتى اعتماد كل حق وإعداد صراحةً.");
    } catch (error) {
      setFormError(apiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitStop(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stopPlan) return;
    setFormError("");
    const data = new FormData(event.currentTarget);
    const rawDate = String(data.get("stopNewAt") ?? "");
    const date = rawDate ? new Date(rawDate) : null;
    if (date && Number.isNaN(date.valueOf())) {
      setFormError("تاريخ الإيقاف غير صالح.");
      return;
    }
    setBusy(true);
    try {
      await scheduleStop.mutateAsync({ planId: stopPlan.id, data: {
        stopNewAt: date?.toISOString() ?? null,
        reason: String(data.get("reason")).trim(),
      } });
      await refresh();
      setStopPlan(null);
      setSuccess(date ? "جُدول إيقاف الطلبات الجديدة؛ الاشتراكات القائمة لم تتغير." : "أُلغي موعد الإيقاف.");
    } catch (error) {
      setFormError(apiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitPublish(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!publishSelection) return;
    const data = new FormData(event.currentTarget);
    setFormError("");
    setBusy(true);
    try {
      await publishVersion.mutateAsync({
        planId: publishSelection.plan.id,
        versionId: publishSelection.version.id,
        data: { reason: String(data.get("reason")).trim() },
      });
      await refresh();
      setPublishSelection(null);
      setSuccess("حُفظ قرار النشر أو الجدولة.");
    } catch (error) {
      setFormError(apiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const [publishSelection, setPublishSelection] = useState<{ plan: PlanRecord; version: PlanVersion } | null>(null);
  const closeForms = () => {
    setCreateOpen(false);
    setVersionPlan(null);
    setStopPlan(null);
    setPublishSelection(null);
    setFormError("");
  };
  const errorState = query.isError ? <CatalogState error={query.error} retry={() => void query.refetch()}/> : null;

  return <div className="ac-page-enter ab-billing">
    <PageHeading eyebrow="الكتالوج والتسعير" title="الخطط والإصدارات" description="إدارة نسخة السعر والحقوق. كل إصدار محفوظ كما اعتمد، ولا تُفترض مزايا غير محسومة."
      action={<button className="ac-button" disabled={query.isError} onClick={() => { closeForms(); setCreateAudience("company"); setCreateOpen(true); }}><Plus size={15}/> إنشاء خطة مسودة</button>}/>
    <FixedPriceNote/>
    {success && <p className="ab-notice" role="status"><Check size={15}/>{success}</p>}
    {query.isLoading ? <LoadingState/> : errorState}
    {!query.isLoading && !query.isError && <>
      <SearchFilter search={search} onSearch={value => { setSearch(value); setPage(1); }} filter={audienceFilter}
        onFilter={value => { setAudienceFilter(value); setPage(1); }}
        filterOptions={[["all", "كل الفئات"], ["company", "شركة"], ["provider", "مقدّم خدمة"], ["station", "محطة"]]}
        onSort={() => setSort(!sort)} sortLabel={sort ? "ترتيب الاسم: أ–ي" : "ترتيب الاسم"}/>
      {plans.length === 0 ? <section className="ac-empty"><span><Tag size={18}/></span><h2>لا توجد خطط محفوظة</h2><p>ستظهر هنا بيانات فعلية بعد تهيئة المخطط المعتمد.</p></section>
        : filtered.length === 0 ? <section className="ac-empty"><Search size={20}/><h2>لا توجد نتائج مطابقة</h2><p>غيّر عبارة البحث أو عامل التصفية.</p></section>
        : <div className="ac-table-wrap ab-table-wrap"><div className="ac-table-scroll"><table className="ac-table ab-table">
          <thead><tr><th>الخطة</th><th>الفئة</th><th>الإصدارات</th><th>الحالة</th><th>إيقاف استقبال جديد</th><th>الإجراءات</th></tr></thead>
          <tbody>{visible.map(plan => <PlanRows key={plan.id} plan={plan} expanded={expanded === plan.id}
            onExpand={() => setExpanded(expanded === plan.id ? null : plan.id)}
            onNewVersion={() => { closeForms(); setVersionPlan(plan); }}
            onStop={() => { closeForms(); setStopPlan(plan); }}
            onPublish={version => { closeForms(); setPublishSelection({ plan, version }); }}/>)}</tbody>
        </table></div></div>}
      <PageControls page={page} total={filtered.length} onPage={setPage}/>
      <p className="ab-footnote"><ShieldAlert size={15}/>الميزات النصية القديمة لا تثبت اعتماد الاستحقاقات. لا يمكن نشر نسخة بحقوق فارغة أو غير معتمدة.</p>
    </>}
    {(createOpen || versionPlan || stopPlan || publishSelection) && <section className="ac-panel ab-form-panel">
      <div className="ab-form-head"><div><span className="ac-eyebrow">إجراء إداري موثق</span><h2>{createOpen ? "إنشاء خطة" : versionPlan ? `إصدار جديد · ${versionPlan.name}` : stopPlan ? `إيقاف استقبال جديد · ${stopPlan.name}` : "نشر إصدار"}</h2></div>
        <button type="button" className="ac-button ac-button-quiet" onClick={closeForms}>إغلاق</button></div>
      {createOpen && <form className="ab-form-grid" onSubmit={submitPlan}>
        <label className="ab-field">اسم الخطة<input name="name" required minLength={2} maxLength={100}/></label>
        <label className="ab-field">رمز الخطة<input name="code" required minLength={3} maxLength={48} pattern="[a-z][a-z0-9_-]{2,47}" dir="ltr"/></label>
        <label className="ab-field">الفئة<select name="audience" required value={createAudience} onChange={event => setCreateAudience(event.target.value as Audience)}>
          <option value="company">شركة</option><option value="provider">مقدّم خدمة</option><option value="station">محطة</option>
        </select></label>
        <label className="ab-field">السعر السنوي (ج.م)<select name="price" required key={createAudience} defaultValue={createAudience === "provider" ? "5000" : createAudience === "station" ? "0" : "500"}>
          {(createAudience === "company" ? ["500", "750", "1000"] : createAudience === "provider" ? ["5000"] : ["0"]).map(price => <option key={price} value={price}>{price === "0" ? "مجاني للمحطة" : `${Number(price).toLocaleString("ar-EG")} ${createAudience === "company" ? "لكل مركبة" : "لكل فرع"}`}</option>)}
        </select></label>
        <ReasonField/><FormFeedback error={formError}/>
        <div className="ab-form-actions"><button className="ac-button" disabled={busy}>{busy ? "جارٍ الحفظ…" : "حفظ كمسودة"} <Check size={14}/></button><button type="button" className="ac-button ac-button-quiet" onClick={closeForms}>إلغاء</button></div>
      </form>}
      {versionPlan && <form className="ab-form-grid" onSubmit={submitVersion}>
        <label className="ab-field">السعر السنوي (ج.م)<select name="price" required defaultValue={versionPlan.audience === "provider" ? "5000" : versionPlan.audience === "station" ? "0" : "500"}>
          {(versionPlan.audience === "company" ? ["500", "750", "1000"] : versionPlan.audience === "provider" ? ["5000"] : ["0"]).map(price => <option key={price} value={price}>{price === "0" ? "مجاني للمحطة" : `${Number(price).toLocaleString("ar-EG")} ${versionPlan.audience === "company" ? "لكل مركبة" : "لكل فرع"}`}</option>)}
        </select></label>
        <label className="ab-field">تاريخ السريان<input name="effectiveAt" type="datetime-local" defaultValue={defaultStart()} required/></label>
        <JsonArrayField name="entitlements" title="الاستحقاقات (JSON)"/>
        <JsonArrayField name="settings" title="إعدادات الخطة (JSON)"/>
        <p className="ab-form-note ab-wide">سعر NFC ثابت ١٠٠ ج.م للإصدار ومنفصل عن الاشتراك. وحدة الباقة سنوية، والاستحقاقات لا تُعتمد تلقائيًا.</p>
        <ReasonField/><FormFeedback error={formError}/>
        <div className="ab-form-actions"><button className="ac-button" disabled={busy}>{busy ? "جارٍ الحفظ…" : "حفظ إصدار مسودة"} <Check size={14}/></button><button type="button" className="ac-button ac-button-quiet" onClick={closeForms}>إلغاء</button></div>
      </form>}
      {stopPlan && <form className="ab-form-grid" onSubmit={submitStop}>
        <label className="ab-field ab-wide">إيقاف استقبال الطلبات الجديدة من<input name="stopNewAt" type="datetime-local"/></label>
        <p className="ab-form-note ab-wide">اترك التاريخ فارغًا لإلغاء إيقاف مجدول. لا يتغير أي اشتراك سابق.</p>
        <ReasonField/><FormFeedback error={formError}/>
        <div className="ab-form-actions"><button className="ac-button" disabled={busy}>{busy ? "جارٍ الحفظ…" : "حفظ موعد الإيقاف"} <Check size={14}/></button><button type="button" className="ac-button ac-button-quiet" onClick={closeForms}>إلغاء</button></div>
      </form>}
      {publishSelection && <form className="ab-form-grid" onSubmit={submitPublish}>
        <p className="ab-form-note ab-wide">سيُرفض النشر إذا بقي أي استحقاق أو إعداد غير معتمد. الإصدار ذو تاريخ سريان مستقبلي سيُجدول.</p>
        <ReasonField/><FormFeedback error={formError}/>
        <div className="ab-form-actions"><button className="ac-button" disabled={busy}>{busy ? "جارٍ الحفظ…" : "اعتماد النشر"} <Check size={14}/></button><button type="button" className="ac-button ac-button-quiet" onClick={closeForms}>إلغاء</button></div>
      </form>}
    </section>}
  </div>;
}

function PlanRows({
  plan, expanded, onExpand, onNewVersion, onStop, onPublish,
}: {
  plan: PlanRecord;
  expanded: boolean;
  onExpand: () => void;
  onNewVersion: () => void;
  onStop: () => void;
  onPublish: (version: PlanVersion) => void;
}) {
  return <>
    <tr>
      <td><button className="ab-expand" onClick={onExpand}><ChevronDown className={expanded ? "ab-rotated" : ""} size={14}/><span><b>{plan.name}</b><small dir="ltr">{plan.code}</small></span></button></td>
      <td>{audienceLabel[plan.audience]}</td>
      <td>{plan.versions.length.toLocaleString("ar-EG")} إصدار</td>
      <td><StatusTag status={!plan.active || (plan.stopNewAt != null && new Date(plan.stopNewAt).valueOf() <= Date.now()) ? "stopped" : "active"}/></td>
      <td>{dateLabel(plan.stopNewAt)}</td>
      <td><div className="ab-actions"><button type="button" className="ab-link-button" onClick={onNewVersion}>إصدار جديد <Plus size={13}/></button><button type="button" className="ab-link-button" onClick={onStop}>تعديل الإيقاف</button></div></td>
    </tr>
    {expanded && <tr className="ab-detail-row"><td colSpan={6}>
      <div className="ab-version-list"><h3>سجل الإصدارات</h3>{plan.versions.length === 0 ? <p>لا توجد نسخ محفوظة.</p> : plan.versions.map(version =>
        <article className="ab-version" key={version.id}>
          <div><b>الإصدار {version.version.toLocaleString("ar-EG")}</b><StatusTag status={version.publicationStatus}/><small>ساري من {dateLabel(version.effectiveAt)}</small></div>
          <div><b>{money(version.annualPriceMinor)}</b><small>{version.billingUnit === "vehicle" ? "لكل مركبة" : "لكل فرع"} · سنوي</small></div>
          <div><b>NFC · {money(version.nfcIssuePriceMinor)}</b><small>رسوم إصدار منفصلة</small></div>
          <div className="ab-rights"><b>الحقوق</b>{version.entitlements == null ? <span>غير موثقة لهذا الإصدار القديم</span> : version.entitlements.length === 0 ? <span>لا توجد استحقاقات مسجلة</span> : version.entitlements.map(item => <span key={item.key}>{item.label}: {displayValue(item.value)} · {item.approved ? "معتمد" : "غير معتمد"}</span>)}</div>
          <div className="ab-rights"><b>الإعدادات</b>{version.settings == null ? <span>غير موثقة</span> : version.settings.length === 0 ? <span>لا توجد إعدادات مسجلة</span> : version.settings.map(item => <span key={item.key}>{item.label}: {displayValue(item.value)} · {item.approved ? "معتمد" : "غير معتمد"}</span>)}</div>
          {version.legacyFeatures.length > 0 && <div className="ab-rights ab-wide"><b>نصوص تاريخية غير معتمدة كحقوق</b>{version.legacyFeatures.map((feature, index) => <span key={`${index}-${feature}`}>{feature}</span>)}</div>}
          {version.publicationStatus === "draft" && <button type="button" className="ac-button ac-button-quiet" onClick={() => onPublish(version)}>مراجعة النشر</button>}
        </article>)}</div>
    </td></tr>}
  </>;
}

function FormFeedback({ error }: { error: string }) {
  return error ? <p className="ab-form-error" role="alert"><CircleAlert size={15}/>{error}</p> : null;
}

export function AdminSubscriptionsPage() {
  const { query, refresh, requests, subscriptions, plans } = useBillingCatalog();
  const organizations = useListOrganizations({ page: 1, pageSize: 100 }, {
    query: { queryKey: getListOrganizationsQueryKey({ page: 1, pageSize: 100 }), enabled: true, retry: false },
  });
  const createRequest = useCreateAdminSubscriptionRequest();
  const reviewRequest = useReviewAdminSubscriptionRequest();
  const cancelSubscription = useCancelAdminSubscription();
  const [tab, setTab] = useState<"requests" | "subscriptions">("requests");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sort, setSort] = useState(false);
  const [page, setPage] = useState(1);
  const [requestOpen, setRequestOpen] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState("");
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [requestType, setRequestType] = useState<RequestKind>("new");
  const [selectedBranchId, setSelectedBranchId] = useState("");
  const [selectedRow, setSelectedRow] = useState<BillingRequest | SubscriptionRecord | null>(null);
  const [selectedKind, setSelectedKind] = useState<"review" | "cancel" | null>(null);
  const [formError, setFormError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const queryBranches = useListBranches(selectedOrgId, {
    query: { queryKey: getListBranchesQueryKey(selectedOrgId), enabled: !!selectedOrgId, retry: false },
  });

  const selectedOrganization = organizations.data?.items.find(item => item.id === selectedOrgId);
  const organizationPlans = plans.filter(plan => plan.audience === selectedOrganization?.kind);
  const selectedPlan = organizationPlans.find(plan => plan.id === selectedPlanId);
  const planVersions = selectedPlan?.versions ?? [];
  const currentSubscriptions = subscriptions.filter(record =>
    record.organizationId === selectedOrgId
    && (!selectedBranchId || record.branchId === selectedBranchId)
    && ["active", "scheduled", "pending_payment"].includes(record.status),
  );
  const sourceRows = tab === "requests" ? requests : subscriptions;
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const rows = sourceRows.filter(row => {
      const snapshotName = "planSnapshot" in row ? snapshotValue(row.planSnapshot, "planName") : "";
      const name = `${row.organizationName} ${row.branchName ?? ""} ${row.id} ${row.planId} ${String(snapshotName ?? "")}`.toLocaleLowerCase();
      return (statusFilter === "all" || row.status === statusFilter) && (!needle || name.includes(needle));
    });
    return [...rows].sort((a, b) => sort
      ? a.createdAt.localeCompare(b.createdAt)
      : b.createdAt.localeCompare(a.createdAt));
  }, [sourceRows, search, statusFilter, sort, tab]);
  const visible = filtered.slice((page - 1) * pageSize, page * pageSize);
  const activeOrgBranches = (queryBranches.data?.items ?? []).filter(branch =>
    branch.status === "active" && branch.approval_status === "approved" && branch.operational_status === "active",
  );

  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");
    setSuccess("");
    const data = new FormData(event.currentTarget);
    const date = (name: string) => {
      const parsed = new Date(String(data.get(name)));
      if (Number.isNaN(parsed.valueOf())) throw new Error("تحقق من تاريخي البداية والنهاية.");
      return parsed.toISOString();
    };
    const rawPrice = String(data.get("requestedPrice") ?? "").trim();
    const request = requestType;
    setBusy(true);
    try {
      await createRequest.mutateAsync({ data: {
        organizationId: selectedOrgId,
        branchId: selectedBranchId || null,
        requestType: request,
        currentSubscriptionId: request === "renewal" || request === "plan_change" ? String(data.get("currentSubscriptionId") || "") || null : null,
        planId: String(data.get("planId")),
        planVersionId: String(data.get("planVersionId")),
        requestedPriceMinor: request === "custom_price" && rawPrice ? Math.round(Number(rawPrice) * 100) : null,
        startsAt: date("startsAt"),
        endsAt: date("endsAt"),
        coverageNote: String(data.get("coverageNote") ?? "").trim(),
        reason: String(data.get("reason") ?? "").trim(),
        submit: data.get("submit") === "on",
      } });
      await refresh();
      setRequestOpen(false);
      setSuccess("حُفظ طلب الاشتراك. حالة التغطية والقرار يعرضهما السجل الفعلي.");
    } catch (error) {
      setFormError(apiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRow || selectedKind !== "review") return;
    const data = new FormData(event.currentTarget);
    setFormError("");
    setBusy(true);
    try {
      await reviewRequest.mutateAsync({
        requestId: selectedRow.id,
        data: { decision: String(data.get("decision")) as ReviewDecision, reason: String(data.get("reason")).trim() },
      });
      await refresh();
      setSelectedRow(null);
      setSelectedKind(null);
      setSuccess("حُفظ قرار المراجعة وسببه.");
    } catch (error) {
      setFormError(apiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitCancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedRow || selectedKind !== "cancel") return;
    const data = new FormData(event.currentTarget);
    const effectiveAt = new Date(String(data.get("effectiveAt")));
    if (Number.isNaN(effectiveAt.valueOf())) {
      setFormError("تاريخ الإلغاء غير صالح.");
      return;
    }
    setFormError("");
    setBusy(true);
    try {
      await cancelSubscription.mutateAsync({
        subscriptionId: selectedRow.id,
        data: { effectiveAt: effectiveAt.toISOString(), reason: String(data.get("reason")).trim() },
      });
      await refresh();
      setSelectedRow(null);
      setSelectedKind(null);
      setSuccess("حُفظ موعد الإلغاء؛ لم تتغير نسخة السعر أو الحقوق.");
    } catch (error) {
      setFormError(apiErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const errorState = query.isError ? <CatalogState error={query.error} retry={() => void query.refetch()}/> : null;
  const selectedPlanSnapshot = selectedRow && "planSnapshot" in selectedRow
    ? selectedRow.planSnapshot as Record<string, unknown> : null;

  return <div className="ac-page-enter ab-billing">
    <PageHeading eyebrow="طلبات وسريان" title="الاشتراكات الإدارية" description="طلبات ضمن جهة وفرع معروفين، مع مراجعة وتواريخ ونسخة سعر محفوظة. لا يُسجل قبض دون تكامل المالية."
      action={<button className="ac-button" disabled={query.isError} onClick={() => { setRequestOpen(!requestOpen); setFormError(""); }}><Plus size={15}/> طلب اشتراك</button>}/>
    <section className="ab-guardrails">
      <div><Building2 size={17}/><p><b>تغطية حسب النطاق</b><small>انتهاء اشتراك فرع لا يوقف بقية الفروع.</small></p></div>
      <div><Clock3 size={17}/><p><b>لا محفظة</b><small>الرسوم لا تنشئ رصيدًا أو محفظة.</small></p></div>
      <div><ShieldAlert size={17}/><p><b>التحصيل غير مدمج</b><small>الاشتراك المدفوع يبقى بانتظار المالية.</small></p></div>
    </section>
    <div className="ab-coverage-note"><span>تغطية مركبات الشركات غير متاحة قبل وجود سجل أسطول معتمد. لا تعتبر مرفقات الإثبات قبضًا ماليًا. لا يُنشأ أي اشتراك مدفوع نشط من هذه الواجهة.</span></div>
    {success && <p className="ab-notice" role="status"><Check size={15}/>{success}</p>}
    {query.isLoading ? <LoadingState/> : errorState}
    {!query.isLoading && !query.isError && <>
      <div className="ab-tabs" role="tablist" aria-label="سجلات الاشتراك">
        <button role="tab" aria-selected={tab === "requests"} className={tab === "requests" ? "selected" : ""} onClick={() => { setTab("requests"); setPage(1); setStatusFilter("all"); }}>الطلبات <span>{requests.length.toLocaleString("ar-EG")}</span></button>
        <button role="tab" aria-selected={tab === "subscriptions"} className={tab === "subscriptions" ? "selected" : ""} onClick={() => { setTab("subscriptions"); setPage(1); setStatusFilter("all"); }}>السجلات المحفوظة <span>{subscriptions.length.toLocaleString("ar-EG")}</span></button>
      </div>
      <SearchFilter search={search} onSearch={value => { setSearch(value); setPage(1); }} filter={statusFilter}
        onFilter={value => { setStatusFilter(value); setPage(1); }}
        filterOptions={[
          ["all", "كل الحالات"], ["draft", "مسودة"], ["submitted", "مرسل للمراجعة"],
          ["needs_changes", "بحاجة لاستكمال"], ["pending_payment", "بانتظار التحصيل"],
          ["active", "نشط"], ["scheduled", "مجدول"], ["expired", "منتهي"], ["rejected", "مرفوض"], ["cancelled", "ملغى"],
        ]}
        onSort={() => setSort(!sort)} sortLabel={sort ? "الأحدث أولًا" : "ترتيب التاريخ"}/>
      {sourceRows.length === 0 ? <section className="ac-empty"><span><Layers3 size={18}/></span><h2>{tab === "requests" ? "لا توجد طلبات محفوظة" : "لا توجد اشتراكات محفوظة"}</h2><p>يعرض هذا السجل البيانات الفعلية فقط؛ لا توجد بيانات تجريبية.</p></section>
        : filtered.length === 0 ? <section className="ac-empty"><Search size={20}/><h2>لا توجد نتائج مطابقة</h2><p>غيّر البحث أو عامل التصفية.</p></section>
        : <div className="ac-table-wrap ab-table-wrap"><div className="ac-table-scroll"><table className="ac-table ab-table">
          {tab === "requests" ? <RequestTable rows={visible as BillingRequest[]} plans={plans}
            onReview={row => { setSelectedRow(row); setSelectedKind("review"); setFormError(""); }}/>
            : <SubscriptionTable rows={visible as SubscriptionRecord[]} onCancel={row => { setSelectedRow(row); setSelectedKind("cancel"); setFormError(""); }}/>}
        </table></div></div>}
      <PageControls page={page} total={filtered.length} onPage={setPage}/>
      <p className="ab-footnote"><ShieldAlert size={15}/>يعرض السجل حتى ٥٠٠ طلب واشتراك أحدثًا؛ لا توجد نواة مالية موثوقة أو سجل أسطول هنا، ولا تُعد دورة مدفوعة مكتملة.</p>
    </>}

    {requestOpen && <section className="ac-panel ab-form-panel">
      <div className="ab-form-head"><div><span className="ac-eyebrow">طلب ضمن السجل</span><h2>إنشاء طلب اشتراك أو تغيير</h2></div><button type="button" className="ac-button ac-button-quiet" onClick={() => setRequestOpen(false)}>إغلاق</button></div>
      {organizations.isError ? <p className="ab-form-error" role="alert">{apiErrorMessage(organizations.error)}</p> : <form className="ab-form-grid" onSubmit={submitRequest}>
        <label className="ab-field">الجهة من السجل<select value={selectedOrgId} onChange={event => { setSelectedOrgId(event.target.value); setSelectedBranchId(""); setSelectedPlanId(""); }} required>
          <option value="">اختر جهة محفوظة</option>{(organizations.data?.items ?? []).map(org => <option key={org.id} value={org.id}>{org.name} · {audienceLabel[org.kind as Audience] ?? org.kind}</option>)}
        </select></label>
        <label className="ab-field">الفرع (للاشتراك على مستوى الفرع)<select value={selectedBranchId} onChange={event => setSelectedBranchId(event.target.value)}>
          <option value="">لا يوجد / غير محدد</option>{activeOrgBranches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select><small>{selectedOrganization?.kind === "company" ? "تغطية المركبات تتطلب سجل أسطول؛ الفروع وحدها لا تثبت عدد المركبات." : "تظهر الفروع النشطة المعتمدة فقط؛ سيعيد الخادم التحقق قبل الإرسال."}</small></label>
        {queryBranches.isError && <p className="ab-form-error" role="alert">{apiErrorMessage(queryBranches.error)}</p>}
        <label className="ab-field">نوع الطلب<select value={requestType} onChange={event => setRequestType(event.target.value as RequestKind)}>
          <option value="new">اشتراك جديد</option><option value="renewal">تجديد</option><option value="plan_change">تغيير خطة</option><option value="custom_price">سعر مخصص</option>
        </select></label>
        {(requestType === "renewal" || requestType === "plan_change") && <label className="ab-field">الاشتراك الحالي<select name="currentSubscriptionId" required defaultValue="">
          <option value="">اختر اشتراكًا قائمًا</option>{currentSubscriptions.map(record => <option key={record.id} value={record.id}>{String(snapshotValue(record.planSnapshot, "planName") ?? record.planId)} · {record.branchName ?? "نطاق الجهة"} · {statusLabel[record.status]}</option>)}
        </select></label>}
        <label className="ab-field">الخطة<select name="planId" value={selectedPlanId} onChange={event => setSelectedPlanId(event.target.value)} required disabled={!selectedOrganization}>
          <option value="">اختر خطة من نفس فئة الجهة</option>{organizationPlans.map(plan => <option key={plan.id} value={plan.id}>{plan.name} · {plan.code}</option>)}
        </select></label>
        <label className="ab-field">نسخة الخطة<select name="planVersionId" key={selectedPlanId} required defaultValue="">
          <option value="">اختر نسخة مسجلة</option>{planVersions.map(version => <option key={version.id} value={version.id}>v{version.version} · {money(version.annualPriceMinor)} · {statusLabel[version.publicationStatus] ?? version.publicationStatus}</option>)}
        </select></label>
        {requestType === "custom_price" && <label className="ab-field">السعر المخصص (ج.م)<input name="requestedPrice" type="number" min="0.01" step="0.01" required/></label>}
        <label className="ab-field">بداية التغطية<input name="startsAt" type="datetime-local" defaultValue={defaultStart()} required/></label>
        <label className="ab-field">نهاية التغطية<input name="endsAt" type="datetime-local" defaultValue={defaultEnd()} required/></label>
        <label className="ab-field ab-wide">ملاحظة النطاق والتغطية<textarea name="coverageNote" maxLength={1000} placeholder="سجّل النطاق المطلوب أو سبب تعذر التحقق."/></label>
        <ReasonField/>
        <label className="ab-submit-choice ab-wide"><input name="submit" type="checkbox"/> إرسال للمراجعة الآن <small>اتركه دون تحديد لحفظ مسودة فقط.</small></label>
        <p className="ab-form-note ab-wide">لا يؤدي إنشاء الطلب أو إرفاق مستند إلى تحصيل رسوم أو تفعيل اشتراك. لا يوجد خصم نسبي، ولا تُعد صلاحيات غير معتمدة مزايا فعالة.</p>
        <FormFeedback error={formError}/>
        <div className="ab-form-actions"><button className="ac-button" disabled={busy || organizations.isLoading}>{busy ? "جارٍ الحفظ…" : "حفظ الطلب"} <Check size={14}/></button><button type="button" className="ac-button ac-button-quiet" onClick={() => setRequestOpen(false)}>إلغاء</button></div>
      </form>}
    </section>}
    {selectedKind && selectedRow && <section className="ac-panel ab-form-panel">
      <div className="ab-form-head"><div><span className="ac-eyebrow">قرار محفوظ مع سبب</span><h2>{selectedKind === "review" ? `مراجعة طلب · ${selectedRow.organizationName}` : `إلغاء اشتراك · ${selectedRow.organizationName}`}</h2></div><button type="button" className="ac-button ac-button-quiet" onClick={() => setSelectedKind(null)}>إغلاق</button></div>
      {selectedKind === "review" ? <form className="ab-form-grid" onSubmit={submitReview}>
        <div className="ab-detail-card ab-wide"><b>{(selectedRow as BillingRequest).branchName ?? "نطاق الجهة"}</b><span>{(selectedRow as BillingRequest).coverageState} · {(selectedRow as BillingRequest).coverageNote || "لا توجد ملاحظة"}</span><span>سبب الطلب: {(selectedRow as BillingRequest).reason}</span></div>
        <label className="ab-field">قرار المراجعة<select name="decision" required defaultValue="approve">
          <option value="approve">موافقة</option><option value="needs_changes">طلب استكمال</option><option value="reject">رفض</option><option value="cancel">إلغاء الطلب</option>
        </select></label>
        <p className="ab-form-note ab-wide">الموافقة على طلب مدفوع تحفظه بانتظار الربط المالي؛ لا تسجل قبضًا ولا تفعّله.</p>
        <ReasonField/><FormFeedback error={formError}/>
        <div className="ab-form-actions"><button className="ac-button" disabled={busy}>{busy ? "جارٍ الحفظ…" : "حفظ القرار"} <Check size={14}/></button><button type="button" className="ac-button ac-button-quiet" onClick={() => setSelectedKind(null)}>إلغاء</button></div>
      </form> : <form className="ab-form-grid" onSubmit={submitCancel}>
        <div className="ab-detail-card ab-wide"><b>{String(selectedPlanSnapshot?.["planName"] ?? "نسخة اشتراك محفوظة")}</b><span>{money((selectedRow as SubscriptionRecord).priceSnapshotMinor)} · {(selectedRow as SubscriptionRecord).billingUnit === "branch" ? "فرع" : "مركبة"}</span></div>
        <label className="ab-field ab-wide">تاريخ سريان الإلغاء<input name="effectiveAt" type="datetime-local" defaultValue={defaultStart()} required/></label>
        <ReasonField/><FormFeedback error={formError}/>
        <div className="ab-form-actions"><button className="ac-button" disabled={busy}>{busy ? "جارٍ الحفظ…" : "جدولة الإلغاء"} <Check size={14}/></button><button type="button" className="ac-button ac-button-quiet" onClick={() => setSelectedKind(null)}>إلغاء</button></div>
      </form>}
    </section>}
  </div>;
}

function RequestTable({
  rows, plans, onReview,
}: { rows: BillingRequest[]; plans: PlanRecord[]; onReview: (row: BillingRequest) => void }) {
  return <><thead><tr><th>الجهة والفرع</th><th>نوع الطلب</th><th>الخطة / النسخة</th><th>السعر المطلوب</th><th>التغطية</th><th>الحالة</th><th>الإجراء</th></tr></thead>
    <tbody>{rows.map(row => {
      const plan = plans.find(item => item.id === row.planId);
      const version = plan?.versions.find(item => item.id === row.planVersionId);
      return <tr key={row.id}>
        <td><b>{row.organizationName}</b><small>{row.branchName ?? "نطاق الجهة"}</small></td>
        <td>{requestLabel[row.requestType]}</td>
        <td><b>{plan?.name ?? "خطة غير متاحة"}</b><small>الإصدار {version?.version ?? "—"}</small></td>
        <td>{row.requestedPriceMinor == null ? money(version?.annualPriceMinor) : money(row.requestedPriceMinor)}</td>
        <td><b>{row.coverageState === "verified" ? "متحقق" : row.coverageState === "fleet_registry_missing" ? "سجل الأسطول غير متاح" : "الفرع غير متحقق"}</b><small>{row.coverageNote || "—"}</small></td>
        <td><StatusTag status={row.status}/></td>
        <td>{["submitted", "needs_changes"].includes(row.status) ? <button type="button" className="ab-link-button" onClick={() => onReview(row)}>مراجعة الطلب</button> : "—"}</td>
      </tr>;
    })}</tbody>
  </>;
}

function SubscriptionTable({
  rows, onCancel,
}: { rows: SubscriptionRecord[]; onCancel: (row: SubscriptionRecord) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return <><thead><tr><th>الجهة والفرع</th><th>الخطة المحفوظة</th><th>السعر / الوحدة</th><th>التواريخ</th><th>الحالة</th><th>إجراء</th></tr></thead>
    <tbody>{rows.map(row => <Fragment key={row.id}>
      <tr>
        <td><b>{row.organizationName}</b><small>{row.branchName ?? "نطاق الجهة"}</small></td>
        <td><b>{String(snapshotValue(row.planSnapshot, "planName") ?? "خطة محفوظة")}</b><small>v{String(snapshotValue(row.planSnapshot, "version") ?? "—")} · {row.billingUnit === "branch" ? "فرع" : "مركبة"}</small></td>
        <td><b>{money(row.priceSnapshotMinor)}</b><small>{row.units.toLocaleString("ar-EG")} وحدة · NFC {money(Number(snapshotValue(row.planSnapshot, "nfcIssuePriceMinor") ?? 0))}</small></td>
        <td>{dateLabel(row.startsAt)}<small>حتى {dateLabel(row.endsAt)}{row.cancellationEffectiveAt ? ` · إلغاء ${dateLabel(row.cancellationEffectiveAt)}` : ""}</small></td>
        <td><StatusTag status={row.status}/></td>
        <td><div className="ab-actions"><button type="button" className="ab-link-button" aria-expanded={expanded === row.id} onClick={() => setExpanded(expanded === row.id ? null : row.id)}>{expanded === row.id ? "إخفاء النسخة" : "عرض النسخة"}</button>
          {["active", "scheduled", "pending_payment"].includes(row.status) && !row.cancellationEffectiveAt
            ? <button type="button" className="ab-link-button ab-link-danger" onClick={() => onCancel(row)}>جدولة إلغاء</button> : null}</div></td>
      </tr>
      {expanded === row.id && <tr className="ab-detail-row"><td colSpan={6}><SnapshotDetails record={row}/></td></tr>}
    </Fragment>)}</tbody>
  </>;
}

function SnapshotDetails({ record }: { record: SubscriptionRecord }) {
  const snapshot = record.planSnapshot;
  const entitlements = snapshotValue(snapshot, "entitlements");
  const settings = snapshotValue(snapshot, "settings");
  const legacyFeatures = snapshotValue(snapshot, "legacyFeatures");
  const renderList = (title: string, value: unknown) => {
    const items = Array.isArray(value) ? value as AdminPlanEntitlement[] : null;
    return <div className="ab-rights"><b>{title}</b>{items == null ? <span>غير موثق في النسخة المحفوظة</span> : items.length === 0 ? <span>قائمة فارغة</span> : items.map((item, index) => <span key={`${item.key}-${index}`}>{item.label}: {displayValue(item.value)} · {item.approved ? "معتمد" : "غير معتمد"}</span>)}</div>;
  };
  return <div className="ab-snapshot">
    <div><b>لقطة السعر والشروط عند الإنشاء</b><span>{money(record.priceSnapshotMinor)} · {record.units.toLocaleString("ar-EG")} {record.billingUnit === "branch" ? "فرع" : "مركبة"} · سنوي</span></div>
    {renderList("الحقوق المحفوظة", entitlements)}
    {renderList("الإعدادات المحفوظة", settings)}
    {Array.isArray(legacyFeatures) && legacyFeatures.length > 0 && <div className="ab-rights"><b>نصوص تاريخية</b>{legacyFeatures.map((item, index) => <span key={index}>{String(item)}</span>)}</div>}
    <details className="ab-snapshot-json"><summary>عرض JSON الكامل غير القابل للتحرير</summary><pre dir="ltr">{JSON.stringify(snapshot, null, 2)}</pre></details>
  </div>;
}
