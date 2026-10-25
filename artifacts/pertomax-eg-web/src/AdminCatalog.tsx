import { useDeferredValue, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, Boxes, CircleAlert, Clock3, Fuel, Layers3, Plus, RefreshCw, Search, X } from "lucide-react";
import type { PlatformRole } from "@workspace/api-client-react";
import "./AdminCatalog.css";

type Row = Record<string, unknown>;
type PageResult = { items: Row[]; total?: number; page?: number; pageSize?: number; totalPages?: number; canManage?: boolean };
type CategoryResult = { categories: Row[]; units: Row[]; canManage?: boolean };
type Command = { action: string; payload: Row; reason: string };
type Tab = "items" | "fuel" | "categories";
const API_ROOT = import.meta.env.BASE_URL.replace(/\/$/, "") + "/api";
const errorMessage = (error: unknown) => {
  const item = error as { status?: number; message?: string; data?: { message?: string } };
  if (item?.status === 403) return "لا تملك صلاحية تنفيذ هذا الإجراء.";
  if (item?.status === 409) return "تغير السجل أو تعارضت فترة السعر. حدّث البيانات ثم أعد المحاولة.";
  return item?.data?.message || item?.message || "تعذر إتمام الطلب. حاول مرة أخرى.";
};
const get = (row: unknown, ...keys: string[]): unknown => {
  if (!row || typeof row !== "object") return undefined;
  const value = row as Row;
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
  return undefined;
};
const text = (value: unknown, fallback = "—") => typeof value === "string" && value.trim() ? value : fallback;
const number = (value: unknown) => typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined;
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((item): item is Row => !!item && typeof item === "object") : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const labels: Record<string, string> = {
  active: "نشط", approved: "معتمد", canceled: "ملغى", draft: "مسودة", rejected: "مرفوض",
  suspended: "موقوف", not_reviewed: "بانتظار المراجعة", product: "منتج", service: "خدمة",
  station: "محطة", provider: "مقدّم خدمة", gasoline: "بنزين", diesel: "سولار",
  natural_gas: "غاز طبيعي", other: "أخرى", wash: "غسيل", oils: "زيوت", parts: "قطع غيار",
};
const label = (value: unknown) => typeof value === "string" ? labels[value] ?? value : "—";
const dateText = (value: unknown) => typeof value === "string" && value ? new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(value)) : "—";
const priceText = (value: unknown) => value == null ? "لا يوجد سعر منشور" : Number(value).toLocaleString("ar-EG", { maximumFractionDigits: 4 }) + " ج.م";
const minorPriceText = (value: unknown) => value == null ? "لا يوجد سعر منشور" : (Number(value) / 100).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ج.م";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(API_ROOT + path, {
    ...init,
    credentials: "include",
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = isRow(data) && typeof data["message"] === "string" ? data["message"] : "تعذر الوصول إلى الكتالوج.";
    throw Object.assign(new Error(message), { status: response.status, data });
  }
  return data as T;
}
function isRow(value: unknown): value is Row { return !!value && typeof value === "object" && !Array.isArray(value); }

function Status({ value }: { value: unknown }) {
  return <span className={"cat-status cat-status-" + String(value ?? "unknown")}><i/>{label(value)}</span>;
}
function Loading() {
  return <section className="cat-state" aria-busy="true"><span className="cat-spinner"/><b>جارٍ تحميل البيانات</b></section>;
}
function ErrorState({ error, retry }: { error: unknown; retry: () => void }) {
  return <section className="cat-state cat-state-error" role="alert"><CircleAlert size={20}/><b>{errorMessage(error)}</b><button className="cat-button cat-button-quiet" onClick={retry}><RefreshCw size={15}/> إعادة المحاولة</button></section>;
}
function Empty({ title, copy }: { title: string; copy: string }) {
  return <div className="cat-empty"><span><Boxes size={20}/></span><b>{title}</b><p>{copy}</p></div>;
}
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="cat-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="cat-modal" role="dialog" aria-modal="true" aria-label={title}>
      <header><div><span className="cat-eyebrow">إجراء مركزي موثق</span><h2>{title}</h2></div><button className="cat-icon-button" aria-label="إغلاق" onClick={onClose}><X size={18}/></button></header>
      {children}
    </section>
  </div>;
}
function useCatalogCommand() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: (command: Command) => api<Row>("/admin/catalog/commands", {
      method: "POST",
      body: JSON.stringify({ ...command, idempotencyKey: crypto.randomUUID() }),
    }),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: ["admin-catalog"] }); },
  });
}
function CommandError({ error }: { error: unknown }) {
  return error ? <div className="cat-alert" role="alert"><CircleAlert size={16}/><span>{errorMessage(error)}</span></div> : null;
}

export default function AdminCatalog({ roles }: { roles: PlatformRole[] }) {
  const canManage = roles.some(role => role === "owner" || role === "operations");
  const [tab, setTab] = useState<Tab>("items");
  const [search, setSearch] = useState("");
  const delayedSearch = useDeferredValue(search);
  const [organizationId, setOrganizationId] = useState("");
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<"fuel" | "price" | "category" | "review" | "command" | null>(null);
  const [selected, setSelected] = useState<Row | null>(null);
  const [selectedAction, setSelectedAction] = useState("");
  const command = useCatalogCommand();
  const params = new URLSearchParams({ pageSize: "100" });
  const orgQuery = useQuery({
    queryKey: ["admin-catalog", "organizations"],
    queryFn: () => api<PageResult>("/admin/catalog/organizations?" + params.toString()),
    enabled: tab === "items",
  });
  const organizations = orgQuery.data?.items ?? [];
  const effectiveOrgId = organizationId || String(organizations[0]?.["id"] ?? "");
  const itemParams = new URLSearchParams({ organizationId: effectiveOrgId, search: delayedSearch, page: String(page), pageSize: "20" });
  const itemQuery = useQuery({
    queryKey: ["admin-catalog", "items", effectiveOrgId, delayedSearch, page],
    queryFn: () => api<PageResult>("/admin/catalog/items?" + itemParams.toString()),
    enabled: tab === "items" && !!effectiveOrgId,
  });
  const fuelParams = new URLSearchParams({ search: delayedSearch, page: String(page), pageSize: "20" });
  const fuelQuery = useQuery({
    queryKey: ["admin-catalog", "fuel", delayedSearch, page],
    queryFn: () => api<PageResult>("/admin/catalog/fuel-types?" + fuelParams.toString()),
    enabled: tab === "fuel",
  });
  const categoryQuery = useQuery({
    queryKey: ["admin-catalog", "categories"],
    queryFn: () => api<CategoryResult>("/admin/catalog/categories"),
    enabled: tab === "categories" || modal === "fuel",
  });
  const total = tab === "fuel" ? number(fuelQuery.data?.total) ?? 0 : number(itemQuery.data?.total) ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / 20));
  const request = (action: string, payload: Row, reason: string) => command.mutateAsync({ action, payload, reason });

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    try {
      const reason = String(data.get("reason") ?? "").trim();
      if (modal === "fuel") {
        await request("fuel.type.create", {
          code: String(data.get("code")).trim(),
          nameAr: String(data.get("nameAr")).trim(),
          vehicleFuelFamily: String(data.get("vehicleFuelFamily")),
          unitCode: String(data.get("unitCode")),
        }, reason);
      } else if (modal === "price" && selected) {
        await request("fuel.price.create_draft", {
          fuelTypeId: String(selected["id"]),
          pricePerUnit: String(data.get("pricePerUnit")).trim(),
          validFromLocal: String(data.get("validFromLocal")),
          validToLocal: String(data.get("validToLocal") || ""),
        }, reason);
      } else if (modal === "category") {
        const kinds = data.getAll("allowedItemKinds").map(String);
        await request("category.create", {
          code: String(data.get("code")).trim(),
          nameAr: String(data.get("nameAr")).trim(),
          serviceGroup: String(data.get("serviceGroup")),
          allowedItemKinds: kinds,
        }, reason);
      } else if (modal === "review" && selected) {
        await request("item.review", {
          itemId: String(selected["id"]),
          expectedVersion: number(selected["version"]),
          reviewStatus: String(data.get("reviewStatus")),
        }, reason);
      } else if (modal === "command" && selected && selectedAction) {
        const payload = selectedAction.startsWith("fuel.price.")
          ? { priceVersionId: String(selected["id"]) }
          : selectedAction === "fuel.type.status"
            ? { fuelTypeId: String(selected["id"]), status: selected["active"] ? "suspended" : "active", expectedVersion: number(selected["version"]) }
            : { categoryId: String(selected["id"]), status: get(selected, "active") ? "suspended" : "active", expectedVersion: number(selected["version"]) };
        await request(selectedAction, payload, reason);
      }
      setModal(null);
      setSelected(null);
      setSelectedAction("");
      command.reset();
    } catch { /* mutation error is rendered in the open dialog */ }
  }

  return <div className="cat-page cat-page-enter" dir="rtl">
    <div className="cat-heading">
      <div><span className="cat-eyebrow">الإدارة المركزية / المنتجات والأسعار</span><h1>الكتالوج المركزي</h1><p>راجع أصناف الجهات وأسعار الوقود من السجلات المعتمدة، مع حفظ كل قرار وسببه.</p></div>
      <div className="cat-heading-mark"><Layers3 size={20}/><span>CATALOG / PRICING</span></div>
    </div>
    <section className="cat-summary" aria-label="ملخص الكتالوج">
      <div><span className="cat-summary-icon"><Boxes size={17}/></span><small>الجهات المسجلة</small><b>{orgQuery.data?.total ?? "—"}</b><em>محطات ومقدمو خدمات</em></div>
      <div><span className="cat-summary-icon"><Fuel size={17}/></span><small>أنواع الوقود</small><b>{fuelQuery.data?.total ?? "—"}</b><em>قائمة الأسعار المركزية</em></div>
      <div><span className="cat-summary-icon"><Clock3 size={17}/></span><small>بانتظار مراجعة</small><b>{itemQuery.data?.items?.filter(item => get(item, "reviewStatus", "review_status") === "not_reviewed").length ?? "—"}</b><em>ضمن الصفحة المعروضة</em></div>
    </section>
    <nav className="cat-tabs" aria-label="أقسام الكتالوج">
      <button className={tab === "items" ? "active" : ""} onClick={() => { setTab("items"); setPage(1); }}><Boxes size={16}/> أصناف الجهات</button>
      <button className={tab === "fuel" ? "active" : ""} onClick={() => { setTab("fuel"); setPage(1); }}><Fuel size={16}/> الوقود والأسعار</button>
      <button className={tab === "categories" ? "active" : ""} onClick={() => setTab("categories")}><Layers3 size={16}/> التصنيفات والوحدات</button>
    </nav>
    <section className="cat-panel">
      <div className="cat-toolbar">
        <div className="cat-toolbar-copy"><span className="cat-eyebrow">{tab === "items" ? "كتالوج الجهات" : tab === "fuel" ? "أسعار مركزية" : "تعريفات مشتركة"}</span><h2>{tab === "items" ? "مراجعة الأصناف" : tab === "fuel" ? "أنواع الوقود والأسعار" : "التصنيفات ووحدات القياس"}</h2></div>
        <div className="cat-actions">
          {(tab === "items" || tab === "fuel") && <label className="cat-search"><Search size={16}/><span className="cat-visually-hidden">بحث</span><input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder={tab === "items" ? "ابحث باسم الصنف" : "ابحث بنوع الوقود"}/></label>}
          {canManage && tab === "fuel" && <button className="cat-button" onClick={() => { command.reset(); setSelected(null); setModal("fuel"); }}><Plus size={16}/> نوع وقود</button>}
          {canManage && tab === "categories" && <button className="cat-button" onClick={() => { command.reset(); setModal("category"); }}><Plus size={16}/> تصنيف</button>}
        </div>
      </div>
      {tab === "items" && <>
        <div className="cat-org-select"><label htmlFor="cat-organization">الجهة</label><select id="cat-organization" value={effectiveOrgId} onChange={e => { setOrganizationId(e.target.value); setPage(1); }}><option value="">اختر جهة</option>{organizations.map(org => <option key={String(org["id"])} value={String(org["id"])}>{text(org["name"])} · {label(org["kind"])}</option>)}</select><span>{orgQuery.data?.total ?? 0} جهة</span></div>
        {orgQuery.isLoading ? <Loading/> : orgQuery.isError ? <ErrorState error={orgQuery.error} retry={() => void orgQuery.refetch()}/> : organizations.length === 0 ? <Empty title="لا توجد جهات كتالوج" copy="ستظهر المحطات ومقدمو الخدمات هنا بعد وجود كتالوج مرتبط بجهة."/> :
        itemQuery.isLoading ? <Loading/> : itemQuery.isError ? <ErrorState error={itemQuery.error} retry={() => void itemQuery.refetch()}/> : (itemQuery.data?.items ?? []).length === 0 ? <Empty title="لا توجد أصناف في هذه الجهة" copy="لا توجد أصناف محفوظة تطابق البحث الحالي."/> :
          <div className="cat-table-wrap"><table className="cat-table"><thead><tr><th>الصنف</th><th>التصنيف</th><th>النوع</th><th>السعر المنشور</th><th>المراجعة</th><th>إجراء</th></tr></thead><tbody>{(itemQuery.data?.items ?? []).map(item => <tr key={String(item["id"])}><td data-label="الصنف"><b>{text(item["name"])}</b><small>{text(item["brandName"])} · {text(item["internalCode"])}</small></td><td data-label="التصنيف">{text(item["categoryName"])}</td><td data-label="النوع">{label(item["kind"])}</td><td data-label="السعر">{minorPriceText(item["priceMinor"])}</td><td data-label="المراجعة"><Status value={item["reviewStatus"]}/></td><td data-label="الإجراء">{canManage && item["reviewStatus"] !== "approved" ? <button className="cat-text-action" onClick={() => { setSelected(item); command.reset(); setModal("review"); }}>مراجعة الصنف</button> : <span className="cat-muted">{canManage ? "معتمد" : "عرض فقط"}</span>}</td></tr>)}</tbody></table></div>}
      </>}
      {tab === "fuel" && (fuelQuery.isLoading ? <Loading/> : fuelQuery.isError ? <ErrorState error={fuelQuery.error} retry={() => void fuelQuery.refetch()}/> : (fuelQuery.data?.items ?? []).length === 0 ? <Empty title="لا توجد أنواع وقود" copy="أضف تعريفًا بعد مراجعة قائمة الوقود المعتمدة للمشروع."/> :
        <div className="cat-fuel-list">{(fuelQuery.data?.items ?? []).map(fuel => <article className="cat-fuel-card" key={String(fuel["id"])}>
          <div className="cat-fuel-main"><span className="cat-fuel-icon"><Fuel size={18}/></span><div><div className="cat-fuel-title"><h3>{text(fuel["nameAr"])}</h3><Status value={fuel["active"] ? "active" : "suspended"}/></div><p>{text(fuel["code"])} · {label(fuel["vehicleFuelFamily"])} · {text(fuel["unitCode"])}</p></div></div>
          <div className="cat-fuel-prices"><div><small>السعر الساري</small><b>{priceText(fuel["currentPrice"])}</b><span>{dateText(fuel["currentPriceValidFrom"])}</span></div><div><small>السعر التالي</small><b>{priceText(fuel["nextPrice"])}</b><span>{dateText(fuel["nextPriceValidFrom"])}</span></div></div>
          <div className="cat-fuel-actions">{canManage && <><button className="cat-button cat-button-quiet" onClick={() => { command.reset(); setSelected(fuel); setModal("price"); }}><Banknote size={15}/> إضافة سعر</button><button className="cat-text-action" disabled={command.isPending} onClick={() => { command.reset(); setSelected(fuel); setSelectedAction("fuel.type.status"); setModal("command"); }}>{fuel["active"] ? "إيقاف" : "إعادة تفعيل"}</button></>}</div>
          <details className="cat-history"><summary>سجل الأسعار</summary><div className="cat-table-wrap"><table className="cat-table"><thead><tr><th>الإصدار</th><th>السعر</th><th>السريان</th><th>الحالة</th><th>الإجراء</th></tr></thead><tbody>{rows(fuel["priceHistory"]).map(price => <tr key={String(price["id"])}><td data-label="الإصدار">v{String(price["version"] ?? "—")}</td><td data-label="السعر">{priceText(price["pricePerUnit"])}</td><td data-label="السريان">{dateText(price["validFrom"])}</td><td data-label="الحالة"><Status value={price["status"]}/></td><td data-label="الإجراء">{canManage && price["status"] === "draft" ? <div className="cat-inline-actions"><button className="cat-text-action" onClick={() => { command.reset(); setSelected(price); setSelectedAction("fuel.price.publish"); setModal("command"); }}>نشر</button><button className="cat-text-action cat-danger-action" onClick={() => { command.reset(); setSelected(price); setSelectedAction("fuel.price.cancel"); setModal("command"); }}>إلغاء</button></div> : <span className="cat-muted">—</span>}</td></tr>)}</tbody></table></div></details>
        </article>)}</div>)}
      {tab === "categories" && (categoryQuery.isLoading ? <Loading/> : categoryQuery.isError ? <ErrorState error={categoryQuery.error} retry={() => void categoryQuery.refetch()}/> : <>
        <div className="cat-definition-grid"><section><h3>التصنيفات</h3><div className="cat-table-wrap"><table className="cat-table"><thead><tr><th>الاسم</th><th>المجموعة</th><th>الأنواع المسموحة</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{rows(categoryQuery.data?.categories).map(category => <tr key={String(category["id"])}><td data-label="الاسم"><b>{text(get(category,"name_ar","nameAr"))}</b><small>{text(category["code"])}</small></td><td data-label="المجموعة">{label(get(category,"service_group","serviceGroup"))}</td><td data-label="الأنواع">{strings(get(category,"allowed_item_kinds","allowedItemKinds")).map(x => label(x)).join("، ") || "—"}</td><td data-label="الحالة"><Status value={get(category,"active") ? "active" : "suspended"}/></td><td data-label="إجراء">{canManage ? <button className="cat-text-action" disabled={command.isPending} onClick={()=>{command.reset();setSelected(category);setSelectedAction("category.status");setModal("command")}}>{get(category,"active")?"إيقاف":"تفعيل"}</button>:"عرض فقط"}</td></tr>)}</tbody></table></div></section>
          <section><h3>وحدات القياس</h3><div className="cat-units">{rows(categoryQuery.data?.units).map(unit=><div key={String(unit["code"])}><b>{text(get(unit,"name_ar","nameAr"))}</b><span>{text(unit["code"])}</span></div>)}</div></section></div>
      </>)}
    </section>
    {(tab === "items" || tab === "fuel") && <div className="cat-pagination"><span>{total.toLocaleString("ar-EG")} سجل</span><div><button className="cat-button cat-button-quiet" disabled={page <= 1} onClick={() => setPage(value => Math.max(1, value - 1))}>السابق</button><span>صفحة {page} من {totalPages}</span><button className="cat-button cat-button-quiet" disabled={page >= totalPages} onClick={() => setPage(value => Math.min(totalPages, value + 1))}>التالي</button></div></div>}
    {command.error && !modal && <CommandError error={command.error}/>}
    {modal && <Modal title={modal === "fuel" ? "تعريف نوع وقود" : modal === "price" ? "إضافة نسخة سعر" : modal === "category" ? "تعريف تصنيف" : modal === "review" ? "مراجعة صنف جهة" : selectedAction === "fuel.price.publish" ? "نشر نسخة السعر" : selectedAction === "fuel.price.cancel" ? "إلغاء نسخة السعر" : selectedAction === "fuel.type.status" ? (selected?.["active"] ? "إيقاف نوع الوقود" : "إعادة تفعيل نوع الوقود") : (get(selected, "active") ? "إيقاف التصنيف" : "تفعيل التصنيف")} onClose={() => { setModal(null); setSelected(null); setSelectedAction(""); command.reset(); }}>
      <CommandError error={command.error}/>
      <form className="cat-form" onSubmit={submit}>
        {modal === "fuel" && <><label>رمز الوقود<input name="code" required minLength={2} maxLength={40} pattern="[a-z][a-z0-9_]{1,39}" placeholder="gasoline_95"/></label><label>الاسم بالعربية<input name="nameAr" required minLength={2} maxLength={80}/></label><label>العائلة<select name="vehicleFuelFamily"><option value="gasoline">بنزين</option><option value="diesel">سولار</option><option value="natural_gas">غاز طبيعي</option><option value="other">أخرى</option></select></label><label>وحدة القياس<select name="unitCode">{rows(categoryQuery.data?.units).map(unit=><option key={String(unit["code"])} value={String(unit["code"])}>{text(get(unit,"name_ar","nameAr"))}</option>)}</select></label></>}
        {modal === "price" && selected && <><div className="cat-selected-record"><b>{text(selected["nameAr"])}</b><span>تاريخ السريان بتوقيت القاهرة</span></div><label>السعر لكل وحدة (ج.م)<input name="pricePerUnit" inputMode="decimal" required pattern="[0-9]+(\.[0-9]{1,6})?" placeholder="17.25"/></label><label>يبدأ في القاهرة<input name="validFromLocal" type="datetime-local" required/></label><label>ينتهي في القاهرة <small>اختياري</small><input name="validToLocal" type="datetime-local"/></label></>}
        {modal === "category" && <><label>رمز التصنيف<input name="code" required minLength={2} maxLength={40} pattern="[a-z][a-z0-9_-]{1,39}"/></label><label>الاسم بالعربية<input name="nameAr" required minLength={2} maxLength={100}/></label><label>مجموعة الخدمة<select name="serviceGroup"><option value="wash">غسيل</option><option value="oils">زيوت</option><option value="parts">قطع</option></select></label><fieldset><legend>أنواع الأصناف</legend><label className="cat-check"><input type="checkbox" name="allowedItemKinds" value="product" defaultChecked/> منتج</label><label className="cat-check"><input type="checkbox" name="allowedItemKinds" value="service"/> خدمة</label></fieldset></>}
        {modal === "review" && selected && <><div className="cat-selected-record"><b>{text(selected["name"])}</b><span>{text(get(selected,"categoryName","category_name"))} · {text(selected["organizationId"])}</span></div><label>قرار المراجعة<select name="reviewStatus" defaultValue="approved"><option value="approved">اعتماد</option><option value="rejected">رفض</option><option value="not_reviewed">إعادة للمراجعة</option></select></label></>}
        {modal === "command" && selected && <div className="cat-selected-record"><b>{text(get(selected,"nameAr","name_ar","name","code"))}</b><span>{selectedAction.startsWith("fuel.price.") ? priceText(get(selected,"pricePerUnit","price_per_unit")) : "الحالة الحالية: " + label(get(selected,"active") ? "active" : "suspended")}</span></div>}
        <label className="cat-reason">سبب القرار أو التغيير<textarea name="reason" minLength={3} maxLength={500} required placeholder="سجّل سببًا واضحًا يظهر في سجل التدقيق."/></label>
        <div className="cat-form-actions"><button className="cat-button" disabled={command.isPending}>{command.isPending ? "جارٍ الحفظ…" : "حفظ القرار"}</button><button type="button" className="cat-button cat-button-quiet" onClick={() => { setModal(null); setSelected(null); setSelectedAction(""); command.reset(); }}>إلغاء</button></div>
      </form>
    </Modal>}
  </div>;
}
