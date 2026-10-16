import { isValidElement, useMemo, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { ArrowRight, Box, CircleAlert, Fuel, ImagePlus, LoaderCircle, PackagePlus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Tag, X } from "lucide-react";
import {
  getGetCatalogItemQueryKey, getGetMerchantCatalogItemsQueryKey, getGetAdminCatalogCategoriesQueryKey, getGetCatalogReferenceDataQueryKey,
  getListAdminCatalogFuelQueryKey, getListAdminCatalogOrganizationsQueryKey,
  getListBranchesPaginatedQueryKey,
  useGetCatalogReferenceData, useGetAdminCatalogCategories, useListAdminCatalogOrganizations,
  useListAdminCatalogFuel, usePreviewAdminCatalogFuel, useGetMerchantCatalogItems, useGetCatalogItem,
  useExecuteCatalogCommand, useUploadCatalogImageContent, useDownloadCatalogImage, useListBranchesPaginated,
} from "@workspace/api-client-react";
import type { CatalogCommandRequestAction, GetMerchantCatalogItemsParams, ListBranchesPaginatedParams } from "@workspace/api-client-react";
import "./CatalogAdmin.css";

type Row = Record<string, unknown>;
const row = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const rows = (v: unknown): Row[] => Array.isArray(v) ? v.map(row) : [];
const str = (v: unknown, fallback = "—") => typeof v === "string" && v.trim() ? v.trim() : fallback;
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
const errText = (e: unknown) => {
  const x = row(e); const data = row(x.data);
  return str(data.message, str(x.message, "تعذر إتمام الطلب. احتفظ بالمدخلات وحاول مجددًا."));
};
const idempotency = () => `${crypto.randomUUID()}-${crypto.randomUUID()}`;
const money = (minor: unknown) => {
  if (minor === null || minor === undefined || minor === "") return "غير متاح";
  try {
    const raw = String(minor);
    if (!/^\d+$/.test(raw)) return "غير متاح";
    const value = BigInt(raw);
    const whole = value / 100n;
    const fraction = Number(value % 100n);
    const wholeText = new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 0 }).format(whole);
    const zero = new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 0 }).format(0);
    const fractionDigits = fraction ? new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 0 }).format(fraction) : "";
    const fractionText = fraction ? `${fraction<10?zero:""}${fractionDigits}` : "";
    return `${wholeText}${fractionText ? `٫${fractionText}` : ""} جنيه`;
  } catch { return "غير متاح"; }
};
const localizeInteger = (value: bigint) => new Intl.NumberFormat("ar-EG", { maximumFractionDigits: 0 }).format(value);
const formatEgpUnit = (value: string) => {
  const match=value.match(/^(\d+)(?:\.(\d{1,6}))?$/);
  if(!match)return "غير متاح";
  const whole=localizeInteger(BigInt(match[1]));
  let fraction=(match[2]??"").replace(/0+$/,"");
  if(fraction) {
    fraction=fraction.padEnd(2,"0").split("").map(d=>localizeInteger(BigInt(d))).join("");
    return `${whole}٫${fraction} جنيه`;
  }
  return `${whole} جنيه`;
};
const fuelMoney = (price: unknown) => {
  const p=row(price);
  const minor=p.priceMinor ?? p.amountMinor;
  if(minor!==undefined) return money(minor);
  const decimal=typeof price==="string"?price:typeof price==="number"?String(price)
    :typeof p.pricePerUnit==="string"?p.pricePerUnit:typeof p.price==="number"?String(p.price)
    :typeof p.amount==="number"?String(p.amount):"";
  return formatEgpUnit(decimal);
};
const date = (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeZone: "Africa/Cairo" }).format(new Date(v)) : "—";
const kindName: Record<string,string> = { station: "محطة", provider: "مقدّم خدمة" };
const fuelFamilyName: Record<string,string> = { gasoline: "بنزين", diesel: "ديزل", natural_gas: "غاز طبيعي", other: "نوع وقود آخر" };
const priceScopeName: Record<string,string> = { branch: "سعر خاص بالفرع", organization: "سعر على مستوى الجهة" };
const unitName = (code:unknown, units:Row[]) => str(units.find(unit=>str(unit.code,"")===str(code,""))?.nameAr,"وحدة غير متاحة");
const statusName: Record<string,string> = { active: "نشط", inactive: "غير نشط", pending: "قيد المراجعة", not_reviewed: "بانتظار المراجعة", suspended: "موقوف", approved: "معتمد", draft: "مسودة", published: "ساري", scheduled: "مجدول", rejected: "مرفوض" };
const toMinor = (value: string) => {
  const match = value.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error("اكتب مبلغًا بالجنيه بحد أقصى خانتين عشريتين.");
  return (BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0")).toString();
};
const sortRows = (list:Row[],key:string,direction:"asc"|"desc") => [...list].sort((a,b)=>{
  const left=a[key],right=b[key];
  const cmp=typeof left==="number"&&typeof right==="number"?left-right:String(left??"").localeCompare(String(right??""),"ar",{numeric:true,sensitivity:"base"});
  return direction==="asc"?cmp:-cmp;
});
function readCatalogAttributes(form: FormData, categoryCode: string): Row {
  const attributes: Row = {};
  const addText=(key:string)=>{const value=String(form.get(key)??"").trim();if(value)attributes[key]=value;};
  const addNumber=(key:string)=>{const value=String(form.get(key)??"").trim();if(value&&Number.isFinite(Number(value)))attributes[key]=Number(value);};
  switch(categoryCode){
    case "wash": {
      const vehicleTypes=String(form.get("vehicleTypes")??"").split(/[،,]/).map(v=>v.trim()).filter(Boolean);
      if(vehicleTypes.length)attributes.vehicleTypes=vehicleTypes;
      if(String(form.get("durationMinutes")??"").trim())addNumber("durationMinutes");
      addText("included");break;
    }
    case "oils": addText("viscosity");addText("specification");if(String(form.get("volumeMl")??"").trim())addNumber("volumeMl");break;
    case "batteries": if(String(form.get("capacityAh")??"").trim())addNumber("capacityAh");if(String(form.get("voltage")??"").trim())addNumber("voltage");if(String(form.get("warrantyMonths")??"").trim())addNumber("warrantyMonths");addText("specification");break;
    case "filters": case "parts": case "consumables": addText("partNumber");addText("compatibility");addText("specification");break;
    case "other_services": addText("included");if(String(form.get("durationMinutes")??"").trim())addNumber("durationMinutes");break;
  }
  return attributes;
}

function State({ title, detail, retry, error = false }: { title: string; detail?: string; retry?: () => void; error?: boolean }) {
  return <div className={`cat-state ${error ? "is-error" : ""}`} role={error ? "alert" : "status"}><span>{error ? <CircleAlert/> : <Box/>}</span><b>{title}</b>{detail && <p>{detail}</p>}{retry && <button className="cat-button cat-quiet" onClick={retry}><RefreshCw size={15}/> إعادة المحاولة</button>}</div>;
}
function SortableHeader({label,field,sortKey,direction,onToggle}:{label:string;field:string;sortKey:string;direction:"asc"|"desc";onToggle:(field:string)=>void}) {
  return <th aria-sort={sortKey===field?(direction==="asc"?"ascending":"descending"):"none"}><button className="cat-sort" onClick={()=>onToggle(field)}>{label}<span aria-hidden="true">{sortKey===field?(direction==="asc"?"↑":"↓"):"↕"}</span></button></th>;
}
function Field({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  const required=isValidElement(children)&&Boolean((children.props as {required?:unknown}).required);
  return <label className={`cat-field ${className}`}><span>{label}{required&&<b className="cat-required" aria-hidden="true"> *</b>}</span>{children}</label>;
}
const formValidationEvents = {
  onInvalidCapture: (event:FormEvent<HTMLFormElement>) => {
    const target=event.target;
    if(target instanceof HTMLInputElement||target instanceof HTMLSelectElement||target instanceof HTMLTextAreaElement){
      const label=target.closest("label")?.querySelector("span")?.textContent?.replace("*","").trim()||target.getAttribute("aria-label")||"هذا الحقل";
      const validity=target.validity;
      target.setCustomValidity(validity.valueMissing?`يرجى إدخال ${label}.`:validity.rangeUnderflow||validity.rangeOverflow?`القيمة خارج النطاق المسموح لـ${label}.`:validity.stepMismatch?`استخدم قيمة صحيحة لـ${label}.`:validity.patternMismatch?`صيغة ${label} غير صحيحة.`:`راجع قيمة ${label}.`);
    }
  },
  onInputCapture: (event:FormEvent<HTMLFormElement>) => {
    const target=event.target;
    if(target instanceof HTMLInputElement||target instanceof HTMLSelectElement||target instanceof HTMLTextAreaElement)target.setCustomValidity("");
  },
  onChangeCapture: (event:FormEvent<HTMLFormElement>) => {
    const target=event.target;
    if(target instanceof HTMLInputElement||target instanceof HTMLSelectElement||target instanceof HTMLTextAreaElement)target.setCustomValidity("");
  },
};
function AuditReason() { return <Field label="سبب الإجراء (3–500 حرف)"><textarea name="reason" required minLength={3} maxLength={500} rows={2} placeholder="اكتب سببًا واضحًا للتغيير"/></Field>; }

function useCatalogCommandSender() {
  const command = useExecuteCatalogCommand();
  const retryKeys = useRef(new Map<string, string>());
  const send = async (action: CatalogCommandRequestAction, payload: Row, reason: string) => {
    const fingerprint = JSON.stringify([action, payload, reason]);
    const key = retryKeys.current.get(fingerprint) ?? idempotency();
    retryKeys.current.set(fingerprint, key);
    const result = await command.mutateAsync({ data: { action, payload, reason, idempotencyKey: key } });
    retryKeys.current.delete(fingerprint);
    return result;
  };
  return { command, send };
}

function CategoryAdminPanel({ categories, units, canManage, onSend, onError, onNotice }: {
  categories: Row[]; units: Row[]; canManage: boolean;
  onSend: (action: CatalogCommandRequestAction, payload: Row, reason: string) => Promise<unknown>;
  onError: (message: string) => void; onNotice: (message: string) => void;
}) {
  const [categoryForm,setCategoryForm]=useState(false);
  const [unitForm,setUnitForm]=useState(false);
  const [editCategoryId,setEditCategoryId]=useState("");
  const [editCategoryName,setEditCategoryName]=useState("");
  const [busy,setBusy]=useState(false);
  const [reason,setReason]=useState("");
  const groupName:Record<string,string>={wash:"غسيل",oils:"زيوت",parts:"قطع واستهلاكيات"};
  async function submit(e:FormEvent<HTMLFormElement>, action:CatalogCommandRequestAction) {
    e.preventDefault(); const form=e.currentTarget; const d=new FormData(form); const why=String(d.get("reason")??"").trim();
    onError(""); setBusy(true);
    try {
      if(action==="category.create") {
        await onSend(action,{code:String(d.get("code")).trim(),nameAr:String(d.get("nameAr")).trim(),
          serviceGroup:String(d.get("serviceGroup")),allowedItemKinds:d.getAll("allowedItemKinds").map(String)},why);
      } else {
        await onSend(action,{code:String(d.get("code")).trim(),nameAr:String(d.get("nameAr")).trim(),
          quantityScale:Number(d.get("quantityScale"))},why);
      }
      form.reset(); setCategoryForm(false); setUnitForm(false); onNotice("تم حفظ بيانات التصنيف أو وحدة القياس.");
    } catch(x) { onError(errText(x)); } finally { setBusy(false); }
  }
  async function updateCategory(category:Row, statusOnly:boolean) {
    if(reason.trim().length<3){onError("سبب الإجراء مطلوب، من ثلاثة أحرف على الأقل.");return;}
    setBusy(true);onError("");
    try {
      const action:CatalogCommandRequestAction=statusOnly?"category.status":"category.update";
      const payload:Row=statusOnly
        ? {categoryId:category.id,expectedVersion:category.version,status:category.active===true?"suspended":"active"}
        : {categoryId:category.id,expectedVersion:category.version,nameAr:editCategoryName};
      await onSend(action,payload,reason.trim());
      setReason("");setEditCategoryId("");setEditCategoryName("");onNotice(statusOnly?"تم تحديث حالة التصنيف.":"تم تحديث اسم التصنيف.");
    } catch(x) { onError(errText(x)); } finally { setBusy(false); }
  }
  async function updateUnit(unit:Row) {
    if(reason.trim().length<3){onError("سبب الإجراء مطلوب، من ثلاثة أحرف على الأقل.");return;}
    setBusy(true);onError("");
    try {
      await onSend("unit.status",{code:unit.code,status:unit.active===true?"suspended":"active"},reason.trim());
      setReason("");onNotice("تم تحديث حالة وحدة القياس.");
    } catch(x) { onError(errText(x)); } finally { setBusy(false); }
  }
  return <section className="cat-panel cat-taxonomy">
    <div className="cat-panel-head"><div><span className="cat-kicker">مرجع موحد</span><h2>التصنيفات ووحدات القياس</h2><p>توقف التصنيف يمنع الاستخدام الجديد ولا يمس السجلات السابقة.</p></div>
      {canManage&&<div className="cat-actions"><button className="cat-button cat-quiet" onClick={()=>setCategoryForm(v=>!v)}>إضافة تصنيف</button><button className="cat-button cat-quiet" onClick={()=>setUnitForm(v=>!v)}>إضافة وحدة</button></div>}
    </div>
    {categoryForm&&canManage&&<form className="cat-form" {...formValidationEvents} onSubmit={e=>void submit(e,"category.create")}><div className="cat-form-grid">
      <Field label="الاسم"><input name="nameAr" required minLength={2} maxLength={100}/></Field><Field label="رمز التصنيف"><input name="code" required dir="ltr" pattern="[a-z][a-z0-9_]{1,39}"/></Field>
      <Field label="المجموعة"><select name="serviceGroup" required><option value="">اختر مجموعة</option><option value="wash">غسيل</option><option value="oils">زيوت</option><option value="parts">قطع واستهلاكيات</option></select></Field>
      <Field label="الأنواع المسموحة"><select name="allowedItemKinds" multiple required><option value="product">منتج</option><option value="service">خدمة</option></select></Field>
    </div><AuditReason/><button className="cat-button" disabled={busy}>حفظ التصنيف</button></form>}
    {unitForm&&canManage&&<form className="cat-form" {...formValidationEvents} onSubmit={e=>void submit(e,"unit.create")}><div className="cat-form-grid">
      <Field label="اسم الوحدة"><input name="nameAr" required minLength={2} maxLength={80}/></Field><Field label="رمز الوحدة"><input name="code" required dir="ltr" pattern="[a-z][a-z0-9_]{1,39}"/></Field>
      <Field label="دقة الكمية (الخانات العشرية)"><input name="quantityScale" type="number" min="0" max="6" step="1" defaultValue="0" required/></Field>
    </div><AuditReason/><button className="cat-button" disabled={busy}>حفظ وحدة القياس</button></form>}
    <div className="cat-taxonomy-grid"><div className="cat-table-scroll"><table className="cat-table"><thead><tr><th>التصنيف</th><th>المجموعة</th><th>النوع</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>
      {categories.map((c,i)=>{const id=str(c.id,str(c.code,String(i)));return <tr key={id}><td>{editCategoryId===id?<input value={editCategoryName} onChange={e=>setEditCategoryName(e.target.value)} aria-label="اسم التصنيف"/>:<b>{str(c.nameAr)}</b>}<small dir="ltr">{str(c.code)}</small></td><td>{groupName[str(c.serviceGroup)]??str(c.serviceGroup)}</td><td>{Array.isArray(c.allowedItemKinds)?c.allowedItemKinds.map(String).join("، "):"—"}</td><td>{c.active===true?"نشط":"موقوف"}</td><td>{canManage&&<div className="cat-actions">{editCategoryId===id?<><button className="cat-text-button" disabled={busy} onClick={()=>void updateCategory(c,false)}>حفظ</button><button className="cat-text-button" onClick={()=>{setEditCategoryId("");setEditCategoryName("");}}>إلغاء</button></>:<button className="cat-text-button" onClick={()=>{setEditCategoryId(id);setEditCategoryName(str(c.nameAr,""));}}>تعديل الاسم</button>}<button className="cat-text-button" disabled={busy} onClick={()=>void updateCategory(c,true)}>{c.active===true?"إيقاف":"تفعيل"}</button></div>}</td></tr>})}
    </tbody></table></div><div className="cat-unit-list"><h3>وحدات القياس</h3>{units.map((u,i)=><div key={str(u.code,String(i))}><span><b>{str(u.nameAr)}</b><small dir="ltr">{str(u.code)} · {str(u.quantityScale)} خانات</small></span><span>{u.active===true?"نشط":"موقوف"}</span>{canManage&&!["litre","piece","service","pack"].includes(str(u.code))&&<button className="cat-text-button" disabled={busy} onClick={()=>void updateUnit(u)}>{u.active===true?"إيقاف":"تفعيل"}</button>}</div>)}</div></div>
    {canManage&&<div className="cat-reason-inline"><label>سبب التصنيف أو الوحدة<input value={reason} onChange={e=>setReason(e.target.value)} placeholder="سبب الإجراء"/></label></div>}
  </section>;
}

export function CatalogAdminPage() {
  const [tab, setTab] = useState<"directory"|"fuel"|"categories">("directory");
  const [search, setSearch] = useState("");
  const [fuelSearch,setFuelSearch]=useState("");
  const [kind, setKind] = useState("");
  const [page, setPage] = useState(1);
  const [fuelPage, setFuelPage] = useState(1);
  const [orgSort,setOrgSort]=useState({key:"name",direction:"asc" as "asc"|"desc"});
  const [fuelSort,setFuelSort]=useState({key:"nameAr",direction:"asc" as "asc"|"desc"});
  const params = useMemo(() => ({ page, pageSize: 20, ...(search.trim() ? { search: search.trim() } : {}), ...(kind ? { kind: kind as "station"|"provider" } : {}) }), [page, search, kind]);
  const organizations = useListAdminCatalogOrganizations(params, { query: { queryKey: getListAdminCatalogOrganizationsQueryKey(params), retry: false, refetchOnMount: "always" } });
  const fuelParams = { page: fuelPage, pageSize: 20, ...(fuelSearch.trim()?{search:fuelSearch.trim()}:{}) };
  const fuel = useListAdminCatalogFuel(fuelParams, { query: { queryKey: getListAdminCatalogFuelQueryKey(fuelParams), retry: false, enabled: tab === "fuel" } });
  const reference = useGetCatalogReferenceData({ query: { queryKey: getGetCatalogReferenceDataQueryKey(), retry: false } });
  const categories = useGetAdminCatalogCategories({ query: { queryKey: getGetAdminCatalogCategoriesQueryKey(), retry: false } });
  const preview = usePreviewAdminCatalogFuel();
  const { command, send } = useCatalogCommandSender();
  const cache = useQueryClient();
  const [activeFuel, setActiveFuel] = useState<Row|null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [calc, setCalc] = useState({ fuelTypeId: "", quantity: "", amount: "" });
  const [previewResult, setPreviewResult] = useState<Row|null>(null);
  const [fuelForm, setFuelForm] = useState(false);
  async function refreshCatalog() {
    await Promise.all([
      cache.invalidateQueries({ queryKey: getListAdminCatalogFuelQueryKey() }),
      cache.invalidateQueries({ queryKey: getGetAdminCatalogCategoriesQueryKey() }),
      cache.invalidateQueries({ queryKey: getListAdminCatalogOrganizationsQueryKey() }),
    ]);
  }
  async function sendAndRefresh(action: CatalogCommandRequestAction, payload: Row, reason: string) {
    const result = await send(action, payload, reason);
    await refreshCatalog();
    return result;
  }
  async function createFuel(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(""); setNotice("");
    const d = new FormData(e.currentTarget);
    try {
      await sendAndRefresh("fuel.type.create", { code: String(d.get("code")).trim(), nameAr: String(d.get("nameAr")).trim(), vehicleFuelFamily: String(d.get("family")), unitCode: String(d.get("unitCode")) }, String(d.get("reason")).trim());
      setNotice("تم حفظ تعريف الوقود."); setFuelForm(false);
    } catch (x) { setError(errText(x)); }
  }
  async function previewFuel(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const qty = Number(calc.quantity); const amount = Number(calc.amount);
    if (!calc.fuelTypeId || (qty <= 0 && amount <= 0)) return;
    try {
      const result = await preview.mutateAsync({ data: { fuelTypeId: calc.fuelTypeId, ...(qty > 0 ? { quantity: qty } : { amountMinor: toMinor(calc.amount) }) } });
      setPreviewResult(row(result)); setError("");
    } catch (x) { setError(errText(x)); setPreviewResult(null); }
  }
  const fuelRows = rows(fuel.data?.items);
  const directoryRows = useMemo(()=>sortRows(rows(organizations.data?.items),orgSort.key,orgSort.direction),[organizations.data,orgSort]);
  const sortedFuelRows = useMemo(()=>sortRows(fuelRows,fuelSort.key,fuelSort.direction),[fuel.data,fuelSort]);
  const referenceCategories = rows(reference.data?.categories);
  const categoryRows = rows(categories.data?.categories);
  const units = rows(categories.data?.units);
  const activeUnits = units.filter((u) => u.active === true);
  return <div className="cat-page" dir="rtl">
    <header className="cat-heading"><div><span className="cat-kicker">السجل المركزي / 04</span><h1>الكتالوج والخدمات</h1><p>مرجع المنصة المركزي منفصل عن أصناف وأسعار كل جهة مالكة.</p></div><span className="cat-seal"><ShieldCheck size={16}/> إدارة موثقة</span></header>
    <nav className="cat-tabs" role="tablist" aria-label="أقسام الكتالوج">
      <button role="tab" aria-selected={tab==="directory"} className={tab==="directory"?"selected":""} onClick={()=>setTab("directory")}><Box size={16}/> دليل الجهات</button>
      <button role="tab" aria-selected={tab==="categories"} className={tab==="categories"?"selected":""} onClick={()=>setTab("categories")}><SlidersHorizontal size={16}/> التصنيفات والوحدات</button>
      <button role="tab" aria-selected={tab==="fuel"} className={tab==="fuel"?"selected":""} onClick={()=>setTab("fuel")}><Fuel size={16}/> تعريف الوقود والأسعار المرجعية</button>
    </nav>
    {error && <div className="cat-alert" role="alert"><CircleAlert size={17}/>{error}</div>}
    {notice && <div className="cat-success" role="status">{notice}</div>}
    {tab==="directory" ? <section className="cat-panel">
      <div className="cat-panel-head"><div><span className="cat-kicker">كتالوج مملوك للجهة</span><h2>دليل المحطات ومقدّمي الخدمات</h2><p>فتح جهة يعرض عناصرها وأسعارها الخاصة فقط.</p></div><span className="cat-count">{organizations.data?.total?.toLocaleString("ar-EG") ?? "—"} جهة</span></div>
      <div className="cat-tools"><label className="cat-search"><Search size={17}/><input value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} placeholder="ابحث بالاسم أو الكود" aria-label="البحث في الجهات"/></label><Field label="نوع الجهة"><select value={kind} onChange={e=>{setKind(e.target.value);setPage(1);}}><option value="">كل الجهات</option><option value="station">محطات</option><option value="provider">مقدّمو الخدمات</option></select></Field></div>
      {organizations.isLoading ? <div className="cat-skeleton"><i/><i/><i/></div> : organizations.isError ? <State error title="تعذر تحميل دليل الجهات" detail={errText(organizations.error)} retry={()=>void organizations.refetch()}/> :
        rows(organizations.data?.items).length === 0 ? <State title="لا توجد جهات مطابقة" detail="ستظهر الجهات المسجلة فعليًا هنا. لا توجد بيانات تجريبية."/> :
         <div className="cat-table-scroll"><table className="cat-table"><thead><tr><SortableHeader label="الجهة" field="name" sortKey={orgSort.key} direction={orgSort.direction} onToggle={field=>setOrgSort(s=>({key:field,direction:s.key===field&&s.direction==="asc"?"desc":"asc"}))}/><SortableHeader label="النوع" field="kind" sortKey={orgSort.key} direction={orgSort.direction} onToggle={field=>setOrgSort(s=>({key:field,direction:s.key===field&&s.direction==="asc"?"desc":"asc"}))}/><SortableHeader label="الفروع" field="branchCount" sortKey={orgSort.key} direction={orgSort.direction} onToggle={field=>setOrgSort(s=>({key:field,direction:s.key===field&&s.direction==="asc"?"desc":"asc"}))}/><SortableHeader label="الأصناف" field="itemCount" sortKey={orgSort.key} direction={orgSort.direction} onToggle={field=>setOrgSort(s=>({key:field,direction:s.key===field&&s.direction==="asc"?"desc":"asc"}))}/><SortableHeader label="النشطة" field="activeItemCount" sortKey={orgSort.key} direction={orgSort.direction} onToggle={field=>setOrgSort(s=>({key:field,direction:s.key===field&&s.direction==="asc"?"desc":"asc"}))}/><th>الملف</th></tr></thead><tbody>
           {directoryRows.map((org, i) => <tr key={str(org.id, String(i))}><td><b>{str(org.name)}</b><small dir="ltr">{str(org.code)}</small></td><td>{kindName[str(org.kind)] ?? str(org.kind)}</td><td>{num(org.branchCount)?.toLocaleString("ar-EG") ?? "—"}</td><td>{num(org.itemCount)?.toLocaleString("ar-EG") ?? "—"}</td><td>{num(org.activeItemCount)?.toLocaleString("ar-EG") ?? "—"}</td><td><Link className="cat-link" href={`/admin/organizations/${encodeURIComponent(str(org.id))}?section=catalog`}>فتح الكتالوج ←</Link></td></tr>)}
        </tbody></table></div>}
      {organizations.data && (num(organizations.data.totalPages) ?? 1) > 1 && <div className="cat-pagination"><button className="cat-button cat-quiet" disabled={page<=1} onClick={()=>setPage(p=>Math.max(1,p-1))}>السابق</button><span>صفحة {page.toLocaleString("ar-EG")} من {(num(organizations.data.totalPages)??1).toLocaleString("ar-EG")}</span><button className="cat-button cat-quiet" disabled={page>=(num(organizations.data.totalPages)??1)} onClick={()=>setPage(p=>p+1)}>التالي</button></div>}
      <p className="cat-scope"><ShieldCheck size={15}/> المحطات مجانية بلا عمولة. لا يمكن لمقدّم الخدمة إنشاء أصناف وقود.</p>
     </section> : tab==="categories" ? <section className="cat-panel"><div className="cat-panel-head"><div><span className="cat-kicker">إدارة مركزية</span><h2>تصنيفات الخدمات ووحدات القياس</h2><p>إيقاف التصنيف يمنع الاستخدام الجديد ويحفظ السجلات التاريخية.</p></div></div>{categories.isLoading?<div className="cat-skeleton"><i/><i/></div>:categories.isError?<State error title="تعذر تحميل التصنيفات" detail={errText(categories.error)} retry={()=>void categories.refetch()}/>:categories.data&&<CategoryAdminPanel categories={categoryRows} units={units} canManage={row(categories.data).canManage===true} onSend={sendAndRefresh} onError={setError} onNotice={setNotice}/>}</section> : <div className="cat-fuel-layout">
      <section className="cat-panel">
        <div className="cat-panel-head"><div><span className="cat-kicker">وقود مركزي</span><h2>أنواع الوقود وأسعار المرجع</h2><p>إدارة تعريف النوع وسجل السعر المرجعي بإصداراته. لا تُنشأ أسعار تلقائيًا.</p></div>{fuel.data?.canManage===true&&<button className="cat-button" onClick={()=>setFuelForm(!fuelForm)}><PackagePlus size={16}/>{fuelForm?"إغلاق":"إضافة نوع وقود"}</button>}</div>
         {fuelForm && fuel.data?.canManage===true && <form className="cat-form" {...formValidationEvents} onSubmit={createFuel}><div className="cat-form-grid"><Field label="الاسم بالعربية"><input name="nameAr" required maxLength={100}/></Field><Field label="الكود"><input name="code" required dir="ltr" pattern="[A-Za-z0-9_-]+" maxLength={40}/></Field><Field label="عائلة الوقود للمركبة"><select name="family" required><option value="">اختر عائلة</option><option value="gasoline">بنزين</option><option value="diesel">ديزل</option><option value="natural_gas">غاز طبيعي</option><option value="other">أخرى</option></select></Field><Field label="وحدة القياس"><select name="unitCode" required><option value="">اختر وحدة</option>{activeUnits.map((u,i)=><option key={str(u.code,String(i))} value={str(u.code,"")}>{str(u.nameAr)} · {str(u.code)}</option>)}</select></Field></div><AuditReason/><button className="cat-button" disabled={command.isPending}>{command.isPending?"جارٍ الحفظ…":"حفظ تعريف الوقود"}</button></form>}
        {fuel.isLoading ? <div className="cat-skeleton"><i/><i/><i/></div> : fuel.isError ? <State error title="تعذر تحميل أنواع الوقود" detail={errText(fuel.error)} retry={()=>void fuel.refetch()}/> : fuelRows.length === 0 ? <State title="لا توجد أنواع وقود مسجلة" detail="لا يوجد سعر مرجعي متاح حتى تُسجّل البيانات المعتمدة."/> :
            <><div className="cat-tools"><label className="cat-search"><Search size={17}/><input value={fuelSearch} onChange={e=>{setFuelSearch(e.target.value);setFuelPage(1);}} placeholder="ابحث بنوع الوقود أو رمزه" aria-label="بحث في أنواع الوقود"/></label></div>
            <div className="cat-table-scroll"><table className="cat-table"><thead><tr><SortableHeader label="النوع" field="nameAr" sortKey={fuelSort.key} direction={fuelSort.direction} onToggle={field=>setFuelSort(s=>({key:field,direction:s.key===field&&s.direction==="asc"?"desc":"asc"}))}/><SortableHeader label="نوع الاستخدام" field="vehicleFuelFamily" sortKey={fuelSort.key} direction={fuelSort.direction} onToggle={field=>setFuelSort(s=>({key:field,direction:s.key===field&&s.direction==="asc"?"desc":"asc"}))}/><th>الوحدة</th><th>السعر المرجعي الحالي</th><th>الإصدار</th><th>الحالة</th><th/></tr></thead><tbody>{sortedFuelRows.map((f,i)=><tr key={str(f.id,String(i))}><td><b>{str(f.nameAr)}</b><small dir="ltr">{str(f.code)}</small></td><td>{fuelFamilyName[str(f.vehicleFuelFamily)]??"غير محدد"}</td><td>{unitName(f.unitCode,units)}</td><td>{fuelMoney(f.currentPrice)}</td><td>{f.currentPriceVersionId?"سعر مرجعي ساري":"لا يوجد"}</td><td>{f.active===true?"نشط":"موقوف"}</td><td><button className="cat-text-button" onClick={()=>setActiveFuel(activeFuel?.id===f.id?null:f)}>{activeFuel?.id===f.id?"إغلاق":"عرض السجل"}</button></td></tr>)}</tbody></table></div></>}
         {fuel.data && (num(fuel.data.totalPages)??1)>1 && <div className="cat-pagination"><button className="cat-button cat-quiet" disabled={fuelPage<=1} onClick={()=>setFuelPage(p=>Math.max(1,p-1))}>السابق</button><span>صفحة {fuelPage.toLocaleString("ar-EG")} من {(num(fuel.data.totalPages)??1).toLocaleString("ar-EG")}</span><button className="cat-button cat-quiet" disabled={fuelPage>=(num(fuel.data.totalPages)??1)} onClick={()=>setFuelPage(p=>p+1)}>التالي</button></div>}
         {activeFuel && <FuelPriceEditor fuel={activeFuel} units={units} canManage={fuel.data?.canManage===true} onSave={sendAndRefresh} onDone={()=>{setActiveFuel(null);setNotice("تم تسجيل الإجراء على الوقود.");}} onError={setError}/>}
        <p className="cat-reference-note">الفئات المرجعية المتاحة: {categoryRows.length || referenceCategories.length ? [...(categoryRows.length?categoryRows:referenceCategories)].map(c=>str(c.nameAr)).join("، ") : "غير متاحة"} · لا يُفترض وجود سعر.</p>
      </section>
      <section className="cat-panel cat-calculator">
        <span className="cat-kicker">أداة غير مالية</span><h2>حاسبة الوقود</h2><p>تقدير كمية أو تكلفة من السعر المركزي الحالي. لا ينشئ طلبًا أو عملية تشغيل.</p>
        {fuelRows.length === 0 ? <State title="الحاسبة غير متاحة" detail="لا توجد أنواع وقود وأسعار مرجعية حالية."/> : <form {...formValidationEvents} onSubmit={previewFuel}>
          <Field label="نوع الوقود"><select required value={calc.fuelTypeId} onChange={e=>setCalc({...calc,fuelTypeId:e.target.value})}><option value="">اختر نوعًا</option>{fuelRows.map((f,i)=><option key={str(f.id,String(i))} value={str(f.id,"")}>{str(f.nameAr)}</option>)}</select></Field>
          <Field label="الكمية (اختياري)"><input type="number" min="0.001" step="any" value={calc.quantity} onChange={e=>setCalc({...calc,quantity:e.target.value,amount:""})}/></Field>
          <div className="cat-or">أو</div>
          <Field label="المبلغ بالجنيه (اختياري)"><input type="number" min="0.01" step="0.01" value={calc.amount} onChange={e=>setCalc({...calc,amount:e.target.value,quantity:""})}/></Field>
          <button className="cat-button" disabled={preview.isPending||(!calc.quantity&&!calc.amount)}>{preview.isPending?"جارٍ الحساب…":"احسب تقديريًا"}</button>
        </form>}
        {previewResult && <div className="cat-preview" role="status"><b>نتيجة المعاينة</b><span>{str(previewResult.quantity)} {unitName(previewResult.unitCode,units)}</span><small>{money(previewResult.amountMinor)} · سعر المرجع {money(previewResult.unitPriceMinor)} لكل {unitName(previewResult.unitCode,units)} · تقريب المبلغ إلى أقرب قرش والنصف لأعلى.</small></div>}
      </section>
    </div>}
  </div>;
}

function FuelPriceEditor({ fuel, units, canManage, onSave, onDone, onError }: { fuel: Row; units: Row[]; canManage: boolean; onSave: (a: CatalogCommandRequestAction,p:Row,r:string)=>Promise<unknown>; onDone:()=>void; onError:(s:string)=>void }) {
  const [draft, setDraft] = useState(false);
  const [editType, setEditType] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionReason,setActionReason]=useState("");
  const history = rows(fuel.priceHistory);
  const selectableUnits = units.filter(u=>u.active===true||str(u.code,"")===str(fuel.unitCode,""));
  const pendingVersion = history.find(h=>h.status==="draft");
  async function action(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const d = new FormData(e.currentTarget); const reason = String(d.get("reason")).trim();
    const price = String(d.get("price")).trim();
    if (!/^\d+(?:\.\d{1,6})?$/.test(price) || Number(price) <= 0) { onError("أدخل سعرًا موجبًا بالجنيه، حتى ست خانات عشرية للوحدة."); return; }
    setBusy(true);
    try { await onSave("fuel.price.create_draft", { fuelTypeId: fuel.id, pricePerUnit:price, validFromLocal:String(d.get("effectiveAt")) }, reason); onDone(); }
    catch (e) { onError(errText(e)); } finally { setBusy(false); }
  }
  async function status(actionName: CatalogCommandRequestAction) {
    if(actionReason.trim().length<3){onError("سبب الإجراء مطلوب، من ثلاثة أحرف على الأقل.");return;}
    setBusy(true); onError("");
    try { await onSave(actionName, { fuelTypeId:fuel.id, priceVersionId:pendingVersion?.id }, actionReason.trim()); onDone(); }
    catch(e) { onError(errText(e)); } finally { setBusy(false); }
  }
  async function saveType(e:FormEvent<HTMLFormElement>){e.preventDefault();const d=new FormData(e.currentTarget);setBusy(true);try{await onSave("fuel.type.update",{fuelTypeId:fuel.id,expectedVersion:fuel.version,code:String(d.get("code")).trim(),nameAr:String(d.get("nameAr")).trim(),vehicleFuelFamily:String(d.get("family")),unitCode:String(d.get("unitCode"))},String(d.get("reason")).trim());onDone();}catch(e){onError(errText(e));}finally{setBusy(false);}}
  async function changeTypeStatus(){if(actionReason.trim().length<3){onError("سبب الإجراء مطلوب.");return;}setBusy(true);try{await onSave("fuel.type.status",{fuelTypeId:fuel.id,expectedVersion:fuel.version,status:fuel.active===false?"active":"suspended"},actionReason.trim());onDone();}catch(e){onError(errText(e));}finally{setBusy(false);}}
  return <div className="cat-editor"><div className="cat-editor-head"><div><b>سجل السعر · {str(fuel.nameAr)}</b><small>السعر الحالي: {fuelMoney(fuel.currentPrice)}</small></div>{canManage&&<button type="button" className="cat-text-button" onClick={()=>setDraft(!draft)}>{draft?"إغلاق":"إنشاء نسخة سعر"}</button>}</div>
    {canManage&&<div className="cat-actions cat-type-actions"><button type="button" className="cat-button cat-quiet" onClick={()=>setEditType(!editType)}>{editType?"إغلاق":"تعديل تعريف الوقود"}</button><span className="cat-type-state">{fuel.active===false?"موقوف":"نشط"}</span><button type="button" className="cat-text-button" onClick={()=>void changeTypeStatus()}>{fuel.active===false?"إعادة تفعيل النوع":"إيقاف النوع"}</button></div>}
    {editType&&canManage&&<form className="cat-form" {...formValidationEvents} onSubmit={saveType}><div className="cat-form-grid"><Field label="الاسم بالعربية"><input name="nameAr" required defaultValue={str(fuel.nameAr,"")}/></Field><Field label="الكود"><input name="code" required defaultValue={str(fuel.code,"")} dir="ltr" pattern="[a-z][a-z0-9_]{1,39}"/></Field><Field label="عائلة الوقود للمركبة"><select name="family" required defaultValue={str(fuel.vehicleFuelFamily,"")}><option value="gasoline">بنزين</option><option value="diesel">ديزل</option><option value="natural_gas">غاز طبيعي</option><option value="other">أخرى</option></select></Field><Field label="الوحدة"><select name="unitCode" required defaultValue={str(fuel.unitCode,"")}>{selectableUnits.map((u,i)=><option key={str(u.code,String(i))} value={str(u.code,"")} disabled={u.active!==true}>{str(u.nameAr)}</option>)}</select></Field></div><AuditReason/><button className="cat-button" disabled={busy}>حفظ التعديل</button></form>}
    {canManage&&<div className="cat-pending-price"><label>سبب الإجراء على النوع أو السعر<input value={actionReason} onChange={e=>setActionReason(e.target.value)} placeholder="سبب موثق"/></label></div>}
    {draft && canManage && <form className="cat-form" {...formValidationEvents} onSubmit={action}><div className="cat-form-grid"><Field label="السعر بالجنيه لكل وحدة"><input name="price" type="number" min="0.000001" step="0.000001" required/></Field><Field label="بدء السريان بتوقيت القاهرة"><input name="effectiveAt" type="datetime-local" required/></Field></div><AuditReason/><button className="cat-button" disabled={busy}>حفظ مسودة السعر</button></form>}
    {pendingVersion && canManage && <div className="cat-pending-price"><span>مسودة سعر: {fuelMoney(pendingVersion.pricePerUnit)} بدءًا من {date(pendingVersion.validFrom)}</span><button disabled={busy} onClick={()=>void status("fuel.price.publish")}>نشر النسخة</button><button disabled={busy} onClick={()=>void status("fuel.price.cancel")}>إلغاء المسودة</button></div>}
    {history.length>0 && <div className="cat-history"><b>سجل الإصدارات</b>{history.map((h,i)=><div key={str(h.id,String(i))}><span>نسخة {str(h.version)}</span><strong>{fuelMoney(h.pricePerUnit)}</strong><small>{statusName[str(h.status)]??str(h.status)} · {date(h.validFrom)}</small></div>)}</div>}
  </div>;
}

export function OrganizationCatalogPanel({ organizationId, organizationKind, organizationName }: { organizationId: string; organizationKind: string; organizationName: string }) {
  const [search,setSearch]=useState(""); const [category,setCategory]=useState(""); const [selected,setSelected]=useState("");
  const [form,setForm]=useState(false); const [error,setError]=useState(""); const [notice,setNotice]=useState("");
  const [newCategoryId,setNewCategoryId]=useState(""); const [newKind,setNewKind]=useState("");
  const [page,setPage]=useState(1);const [branchFilter,setBranchFilter]=useState("");const [kindFilter,setKindFilter]=useState("");const [statusFilter,setStatusFilter]=useState("");const [sort,setSort]=useState({key:"name",direction:"asc" as "asc"|"desc"});
  const cache=useQueryClient(); const [,navigate]=useLocation();
  const branchParams:ListBranchesPaginatedParams={organizationId,page:1,pageSize:100,sortBy:"name",sortDirection:"asc"};
  const branchQuery=useListBranchesPaginated(branchParams,{query:{queryKey:getListBranchesPaginatedQueryKey(branchParams),retry:false,refetchOnMount:"always"}});
  const merchantBranches=rows(branchQuery.data?.items);
  const params: GetMerchantCatalogItemsParams={organizationId,page,pageSize:20,...(search.trim()?{search:search.trim()}:{}),...(category?{categoryCode:category}:{}),...(branchFilter?{branchId:branchFilter}:{}),...(kindFilter?{kind:kindFilter as "product"|"service"}:{}),...(statusFilter?{status:statusFilter as "active"|"draft"|"suspended"}:{})};
  const query=useGetMerchantCatalogItems(params,{query:{queryKey:getGetMerchantCatalogItemsQueryKey(params),retry:false,refetchOnMount:"always"}});
  const refs=useGetCatalogReferenceData({query:{queryKey:getGetCatalogReferenceDataQueryKey(),retry:false}});
  const cats=rows(refs.data?.categories);
  const sortedItems=useMemo(()=>sortRows(rows(query.data?.items),sort.key,sort.direction),[query.data,sort]);
  const selectedCategory=cats.find(c=>str(c.id,"")===newCategoryId);
  const allowedKinds=Array.isArray(selectedCategory?.allowedItemKinds)?selectedCategory.allowedItemKinds.map(String):[];
  const {command,send}=useCatalogCommandSender();
  async function refresh(itemId?:string) { await cache.invalidateQueries({queryKey:getGetMerchantCatalogItemsQueryKey()}); if(itemId) await cache.invalidateQueries({queryKey:getGetCatalogItemQueryKey(itemId)}); }
  async function createItem(e:FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError(""); const d=new FormData(e.currentTarget);
    const categoryId=String(d.get("categoryId")??"");
    const selected=cats.find(c=>str(c.id,"")===categoryId);
    const kind=String(d.get("kind")??"");
    if(!selected||!Array.isArray(selected.allowedItemKinds)||!selected.allowedItemKinds.map(String).includes(kind)){setError("اختر تصنيفًا ونوع صنف مسموحًا به.");return;}
    const attributes=readCatalogAttributes(d,str(selected.code));
    const payload:Row={organizationId,categoryId,kind,name:String(d.get("name")).trim(),description:String(d.get("description")).trim(),internalCode:String(d.get("internalCode")).trim()||null,barcode:String(d.get("barcode")).trim()||null,brandName:String(d.get("brandName")).trim()||null,unitCode:String(d.get("unitCode")),attributes};
    try { const result=await send("item.create",payload,String(d.get("reason")).trim()); const id=str(row(result).itemId,str(row(result).id,"")); await refresh(id||undefined); setNotice("تم إنشاء الصنف في كتالوج الجهة."); setForm(false); if(id){setSelected(id);navigate(`/admin/organizations/${encodeURIComponent(organizationId)}?section=catalog&item=${encodeURIComponent(id)}`);} }
    catch(x){setError(errText(x));}
  }
  const selectedParam=new URLSearchParams(typeof window==="undefined"?"":window.location.search).get("item")||selected;
  return <section className="cat-merchant">
    <header className="cat-merchant-heading"><div><span className="cat-kicker">كتالوج الجهة / {kindName[organizationKind]??organizationKind}</span><h2>{organizationName}</h2><p>الأصناف والتوافر والأسعار مملوكة لهذه الجهة وحدها.</p></div>{query.data?.canManageOrganization===true&&<button className="cat-button" onClick={()=>{setForm(!form);setError("");}}><PackagePlus size={16}/>{form?"إغلاق":"إضافة صنف"}</button>}</header>
    <div className="cat-private-callout"><ShieldCheck size={17}/><span>{organizationKind==="station"?"المحطات مجانية ولا تُحمّل عمولة.":"مقدّمو الخدمات لا ينشئون أصناف وقود."} الصور خاصة ولا تُعرض إلا برابط موقّع مؤقت.</span></div>
    {error&&<div className="cat-alert" role="alert">{error}</div>}{notice&&<div className="cat-success" role="status">{notice}</div>}
    {query.data?.canManage===true&&!query.data?.canManageOrganization&&<div className="cat-scope">صلاحياتك على مستوى فرع محدد فقط؛ إدارة بيانات الصنف العامة غير متاحة.</div>}
    {query.data?.canManage!==true&&<div className="cat-scope">عرض ومراجعة فقط. لا تملك هذه الجلسة تفويض إدارة كتالوج الجهة.</div>}
    {form&&query.data?.canManageOrganization===true&&<form className="cat-form cat-item-form" {...formValidationEvents} onSubmit={createItem}><div className="cat-form-grid">
      <Field label="اسم الصنف"><input name="name" required minLength={2} maxLength={160}/></Field>
      <Field label="التصنيف"><select name="categoryId" value={newCategoryId} required onChange={e=>{const id=e.target.value;setNewCategoryId(id);const c=cats.find(v=>str(v.id,"")===id);const kinds=Array.isArray(c?.allowedItemKinds)?c.allowedItemKinds.map(String):[];setNewKind(kinds[0]??"");}}><option value="">اختر تصنيفًا</option>{cats.map((c,i)=><option key={str(c.id,String(i))} value={str(c.id,"")}>{str(c.nameAr)}</option>)}</select></Field>
      <Field label="نوع الصنف"><select name="kind" value={newKind} required onChange={e=>setNewKind(e.target.value)}><option value="">اختر نوعًا</option>{allowedKinds.map(k=><option key={k} value={k}>{k==="service"?"خدمة":"منتج"}</option>)}</select></Field>
      <Field label="وحدة القياس"><select name="unitCode" required><option value="">اختر وحدة</option>{rows(refs.data?.units).map((u,i)=><option key={str(u.code,String(i))} value={str(u.code,"")}>{str(u.nameAr)}</option>)}</select></Field>
      <Field label="كود داخلي"><input name="internalCode" maxLength={80}/></Field><Field label="الباركود"><input name="barcode" maxLength={80}/></Field><Field label="العلامة التجارية"><input name="brandName" maxLength={120}/></Field>
      <Field label="الوصف" className="wide"><textarea name="description" maxLength={2000} rows={3}/></Field>
      {selectedCategory?.code==="wash"&&<><Field label="أنواع المركبات المناسبة (افصل بينها بفاصلة)"><input name="vehicleTypes" placeholder="مثل: سيدان، دفع رباعي"/></Field><Field label="المدة بالدقائق"><input name="durationMinutes" type="number" min="1" step="1"/></Field><Field label="ما يشمله الغسيل" className="wide"><textarea name="included" maxLength={2000} rows={2}/></Field></>}
      {selectedCategory?.code==="oils"&&<><Field label="اللزوجة"><input name="viscosity" maxLength={40} placeholder="مثال حسب المنتج"/></Field><Field label="المواصفة"><input name="specification" maxLength={120}/></Field><Field label="الحجم بالملليلتر"><input name="volumeMl" type="number" min="1" step="1"/></Field></>}
      {selectedCategory?.code==="batteries"&&<><Field label="السعة بالأمبير-ساعة"><input name="capacityAh" type="number" min="0.1" step="0.1"/></Field><Field label="الجهد بالفولت"><input name="voltage" type="number" min="0.1" step="0.1"/></Field><Field label="الضمان بالأشهر"><input name="warrantyMonths" type="number" min="1" step="1"/></Field><Field label="المواصفة"><input name="specification" maxLength={120}/></Field></>}
      {["filters","parts","consumables"].includes(str(selectedCategory?.code))&&<><Field label="رقم الصنف"><input name="partNumber" maxLength={100}/></Field><Field label="التوافق مع المركبات"><input name="compatibility" maxLength={1000}/></Field><Field label="المواصفة"><input name="specification" maxLength={500}/></Field></>}
      {selectedCategory?.code==="other_services"&&<><Field label="المدة بالدقائق"><input name="durationMinutes" type="number" min="1" step="1"/></Field><Field label="ما تشمله الخدمة" className="wide"><textarea name="included" maxLength={2000} rows={2}/></Field></>}
    </div><AuditReason/><div className="cat-actions"><button className="cat-button" disabled={command.isPending||refs.isLoading}>{command.isPending?"جارٍ الإنشاء…":"إنشاء الصنف"}</button><button type="button" className="cat-button cat-quiet" onClick={()=>setForm(false)}>إلغاء</button></div></form>}
    <div className="cat-tools"><label className="cat-search"><Search size={17}/><input value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}} placeholder="ابحث ضمن أصناف هذه الجهة" aria-label="البحث في الأصناف"/></label><Field label="التصنيف"><select value={category} onChange={e=>{setCategory(e.target.value);setPage(1);}}><option value="">كل التصنيفات</option>{cats.map((c,i)=><option key={str(c.code,String(i))} value={str(c.code,"")}>{str(c.nameAr)}</option>)}</select></Field><Field label="الفرع"><select value={branchFilter} onChange={e=>{setBranchFilter(e.target.value);setPage(1);}}><option value="">كل الفروع</option>{merchantBranches.map((b,i)=><option key={str(b.id,String(i))} value={str(b.id,"")}>{str(b.name)}</option>)}</select></Field><Field label="نوع العنصر"><select value={kindFilter} onChange={e=>{setKindFilter(e.target.value);setPage(1);}}><option value="">كل الأنواع</option><option value="product">منتجات</option><option value="service">خدمات</option></select></Field><Field label="الحالة"><select value={statusFilter} onChange={e=>{setStatusFilter(e.target.value);setPage(1);}}><option value="">كل الحالات</option><option value="draft">مسودة</option><option value="active">نشط</option><option value="suspended">موقوف</option></select></Field></div>
    {query.isLoading?<div className="cat-skeleton"><i/><i/><i/></div>:query.isError?<State error title="تعذر تحميل أصناف الجهة" detail={errText(query.error)} retry={()=>void query.refetch()}/>:rows(query.data?.items).length===0?<State title="لا توجد أصناف مسجلة" detail="ستظهر العناصر التابعة لهذه الجهة والفرع فقط."/>:
      <div className="cat-table-scroll"><table className="cat-table"><thead><tr><SortableHeader label="الصنف" field="name" sortKey={sort.key} direction={sort.direction} onToggle={field=>setSort(s=>({key:field,direction:s.key===field&&s.direction==="asc"?"desc":"asc"}))}/><SortableHeader label="الفئة" field="categoryName" sortKey={sort.key} direction={sort.direction} onToggle={field=>setSort(s=>({key:field,direction:s.key===field&&s.direction==="asc"?"desc":"asc"}))}/><SortableHeader label="الحالة" field="status" sortKey={sort.key} direction={sort.direction} onToggle={field=>setSort(s=>({key:field,direction:s.key===field&&s.direction==="asc"?"desc":"asc"}))}/><th>نطاق السعر</th><th>السعر</th><th>النسخة</th><th/></tr></thead><tbody>{sortedItems.map((item,i)=><tr key={str(item.id,String(i))}><td><b>{str(item.name)}</b><small>{str(item.internalCode)}</small></td><td>{str(item.categoryName)}</td><td><span className="cat-status">{statusName[str(item.status)]??str(item.status)}</span></td><td>{priceScopeName[str(item.priceScope)]??"لا يوجد سعر"}</td><td>{money(item.priceMinor)}</td><td>{item.priceVersionId?"سعر مسجل":"لا يوجد"}</td><td><button className="cat-text-button" onClick={()=>{setSelected(str(item.id,""));navigate(`/admin/organizations/${encodeURIComponent(organizationId)}?section=catalog&item=${encodeURIComponent(str(item.id,""))}`)}}>تفاصيل ←</button></td></tr>)}</tbody></table></div>}
    {query.data&&(num(query.data.totalPages)??1)>1&&<div className="cat-pagination"><button className="cat-button cat-quiet" disabled={page<=1} onClick={()=>setPage(p=>Math.max(1,p-1))}>السابق</button><span>صفحة {page.toLocaleString("ar-EG")} من {(num(query.data.totalPages)??1).toLocaleString("ar-EG")}</span><button className="cat-button cat-quiet" disabled={page>=(num(query.data.totalPages)??1)} onClick={()=>setPage(p=>p+1)}>التالي</button></div>}
    {selectedParam && <CatalogItemEditor key={selectedParam} itemId={selectedParam} organizationKind={organizationKind} onError={setError} onNotice={setNotice} onRefresh={refresh}/>}
  </section>;
}

function CatalogItemEditor({itemId,organizationKind,onError,onNotice,onRefresh}:{itemId:string;organizationKind:string;onError:(s:string)=>void;onNotice:(s:string)=>void;onRefresh:(id?:string)=>Promise<void>}) {
  const detail=useGetCatalogItem(itemId,{query:{queryKey:getGetCatalogItemQueryKey(itemId),retry:false,refetchOnMount:"always"}});
  const {command,send:sendCommand}=useCatalogCommandSender();const uploadPng=useUploadCatalogImageContent({request:{headers:{"Content-Type":"image/png"}}});const uploadJpeg=useUploadCatalogImageContent({request:{headers:{"Content-Type":"image/jpeg"}}});const cache=useQueryClient();
  const [edit,setEdit]=useState(false);const [branchId,setBranchId]=useState("");const [enabled,setEnabled]=useState(true);const [price,setPrice]=useState("");const [effective,setEffective]=useState("");const [imageBusy,setImageBusy]=useState(false);const [statusReason,setStatusReason]=useState("");
  const data=row(detail.data);const item=row(data.item ?? data); const availability=rows(data.availability); const prices=rows(data.prices); const images=rows(data.images ?? data.readyImages);
  const branches=rows(data.manageableBranches);const canManage=item.canManage===true;const canManageOrganization=item.canManageOrganization===true;const canReview=item.canReview===true;
  async function send(action:CatalogCommandRequestAction,payload:Row,why:string){const result=await sendCommand(action,payload,why);await onRefresh(itemId);await cache.invalidateQueries({queryKey:getGetCatalogItemQueryKey(itemId)});return result;}
  async function update(e:FormEvent<HTMLFormElement>){e.preventDefault();const d=new FormData(e.currentTarget);const why=String(d.get("reason")).trim();try{await send("item.update",{itemId,expectedVersion:item.version,name:String(d.get("name")).trim(),description:String(d.get("description")).trim(),internalCode:String(d.get("internalCode")).trim()||null,barcode:String(d.get("barcode")).trim()||null,brandName:String(d.get("brandName")).trim()||null,attributes:readCatalogAttributes(d,str(item.categoryCode))},why);setEdit(false);onNotice("تم تحديث بيانات الصنف.");}catch(x){onError(errText(x));}}
  async function changeStatus(){if(statusReason.trim().length<3){onError("سبب الإجراء مطلوب.");return;}const status=canReview?(item.centralSuspended===true?"active":"suspended"):item.status==="active"?"draft":"active";try{await send("item.status",{itemId,expectedVersion:item.version,status},statusReason.trim());onNotice(status==="suspended"?"تم إيقاف الصنف مركزيًا.":canReview?"تم رفع الإيقاف المركزي.":"تم تحديث حالة الصنف.");}catch(x){onError(errText(x));}}
  async function review(reviewStatus:"approved"|"rejected"){if(statusReason.trim().length<3){onError("سبب المراجعة مطلوب.");return;}try{await send("item.review",{itemId,expectedVersion:item.version,reviewStatus},statusReason.trim());onNotice(reviewStatus==="approved"?"تم اعتماد الصنف للمراجعة المركزية.":"تم رفض الصنف مع حفظ السبب.");}catch(x){onError(errText(x));}}
  async function createPrice(e:FormEvent<HTMLFormElement>){e.preventDefault();const d=new FormData(e.currentTarget);try{await send("item.price.create_draft",{itemId,priceMinor:toMinor(String(d.get("price"))),branchId:String(d.get("branchId"))||null,validFromLocal:String(d.get("effectiveAt"))},String(d.get("reason")).trim());onNotice("تم حفظ مسودة السعر.");}catch(x){onError(errText(x));}}
  async function availabilitySubmit(e:FormEvent<HTMLFormElement>){e.preventDefault();const d=new FormData(e.currentTarget);const branch=String(d.get("branchId"));const current=availability.find(a=>str(a.branchId,"")===branch);try{await send("item.branch_availability",{itemId,branchId:branch,expectedVersion:num(current?.version)??0,available:d.get("available")==="on"},String(d.get("reason")).trim());onNotice("تم تحديث توافر الصنف للفرع.");}catch(x){onError(errText(x));}}
  async function imageSubmit(e:FormEvent<HTMLFormElement>){e.preventDefault();const form=e.currentTarget;const formData=new FormData(form);const file=formData.get("image") as File|null;if(!file)return;
    if(!["image/png","image/jpeg"].includes(file.type)||file.size>5*1024*1024){onError("يسمح بصور PNG أو JPEG فقط وبحد أقصى 5 ميغابايت.");return;}
    const why=String(formData.get("reason")).trim();const uploadBranch=String(formData.get("branchId")??"");setImageBusy(true);onError("");
    try{const intent=await sendCommand("item.image.intent",{itemId,expectedVersion:item.version,fileName:file.name,contentType:file.type,byteSize:file.size,branchId:uploadBranch||null},why);
      const result=row(intent);const imageId=str(result.imageId,str(row(result.image).id,str(result.id,"")));
      if(!imageId)throw new Error("لم يُرجع الخادم معرّف الصورة لبدء الرفع.");
      await (file.type==="image/png"?uploadPng:uploadJpeg).mutateAsync({imageId,data:file});
      await onRefresh(itemId);await cache.invalidateQueries({queryKey:getGetCatalogItemQueryKey(itemId)});form.reset();onNotice("اكتمل رفع الصورة الخاصة والتحقق من مسارها.");
    }catch(x){onError(errText(x));}finally{setImageBusy(false);}
  }
  if(detail.isLoading)return <div className="cat-skeleton"><i/><i/></div>;
  if(detail.isError||!detail.data)return <State error title="تعذر تحميل تفاصيل الصنف" detail={detail.isError?errText(detail.error):"الصنف غير متاح"} retry={()=>void detail.refetch()}/>;
  return <section className="cat-item-detail" aria-label="تفاصيل الصنف">
     <div className="cat-detail-head"><div><span className="cat-kicker">تفاصيل الصنف · الإصدار {str(item.version)}</span><h3>{str(item.name)}</h3><small>{str(item.categoryName)} · {str(item.kind==="service"?"خدمة":"منتج")} · {str(item.unitCode)}</small></div><div className="cat-actions">{canManageOrganization&&<button className="cat-text-button" onClick={()=>setEdit(!edit)}>{edit?"إغلاق":"تعديل الصنف"}</button>}{canReview?<button type="button" className="cat-text-button" disabled={item.centralSuspended===true&&item.reviewStatus!=="approved"} onClick={()=>void changeStatus()}>{item.centralSuspended===true?"رفع الإيقاف المركزي":"إيقاف مركزي"}</button>:canManage&&!item.centralSuspended&&<button type="button" className="cat-text-button" disabled={item.status!=="active"&&item.reviewStatus!=="approved"} onClick={()=>void changeStatus()}>{item.status==="active"?"إيقاف العرض":"إعادة العرض"}</button>}</div></div>
    {(canManage||canReview)&&<div className="cat-item-status-action"><input value={statusReason} onChange={e=>setStatusReason(e.target.value)} placeholder="سبب الإجراء أو قرار المراجعة" aria-label="سبب الإجراء أو قرار المراجعة"/></div>}
    {canReview&&item.reviewStatus!=="approved"&&<div className="cat-actions"><button type="button" className="cat-button" onClick={()=>void review("approved")}>اعتماد للمراجعة</button><button type="button" className="cat-button cat-quiet" onClick={()=>void review("rejected")}>رفض مع السبب</button></div>}
    {edit&&canManageOrganization&&<form className="cat-form" {...formValidationEvents} onSubmit={update}><div className="cat-form-grid"><Field label="الاسم"><input name="name" defaultValue={str(item.name,"")} required/></Field><Field label="الكود الداخلي"><input name="internalCode" defaultValue={str(item.internalCode,"")}/></Field><Field label="الباركود"><input name="barcode" defaultValue={str(item.barcode,"")}/></Field><Field label="العلامة التجارية"><input name="brandName" defaultValue={str(item.brandName,"")}/></Field><Field label="الوصف" className="wide"><textarea name="description" defaultValue={str(item.description,"")} rows={3}/></Field><CatalogAttributeFields categoryCode={str(item.categoryCode)} attributes={row(item.attributes)}/></div><AuditReason/><button className="cat-button" disabled={command.isPending}>حفظ التعديلات</button></form>}
    <div className="cat-detail-grid"><article><span>الحالة</span><b>{statusName[str(item.status)]??str(item.status)}</b></article><article><span>مراجعة</span><b>{statusName[str(item.reviewStatus)]??str(item.reviewStatus)}</b></article><article><span>السعر الحالي</span><b>{money(item.priceMinor)}</b></article><article><span>نطاق السعر</span><b>{priceScopeName[str(item.priceScope)]??"لا يوجد سعر"}</b></article><article><span>آخر تحديث</span><b>{date(item.updatedAt)}</b></article></div>
    <div className="cat-management-grid">
      {canManage&&branches.length>0&&<form className="cat-form" {...formValidationEvents} onSubmit={availabilitySubmit}><h4>توافر الفروع</h4><Field label="الفرع"><select name="branchId" value={branchId} onChange={e=>setBranchId(e.target.value)} required><option value="">اختر فرعًا مخولًا</option>{branches.map((b,i)=><option key={str(b.id,String(i))} value={str(b.id,"")}>{str(b.name)}</option>)}</select></Field><label className="cat-check"><input name="available" type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/> متاح في هذا الفرع</label><AuditReason/><button className="cat-button" disabled={command.isPending||!branchId}>حفظ التوافر</button>{availability.map((a,i)=><small key={str(a.branchId,String(i))}>{str(a.branchName)} · {a.available===true?"متاح":"غير متاح"}</small>)}</form>}
      {canManage&&<form className="cat-form" {...formValidationEvents} onSubmit={createPrice}><h4>نسخة سعر جديدة</h4><Field label="السعر بالجنيه"><input name="price" type="number" min="0.01" step="0.01" value={price} onChange={e=>setPrice(e.target.value)} required/></Field><Field label="نطاق الفرع"><select name="branchId" required={!canManageOrganization}><option value="">نطاق الجهة</option>{branches.map((b,i)=><option key={str(b.id,String(i))} value={str(b.id,"")}>{str(b.name)}</option>)}</select></Field><Field label="بدء السريان بتوقيت القاهرة"><input name="effectiveAt" type="datetime-local" value={effective} onChange={e=>setEffective(e.target.value)} required/></Field><AuditReason/><button className="cat-button" disabled={command.isPending}>إنشاء مسودة سعر</button></form>}
    </div>
    {prices.length>0&&<div className="cat-history"><b>سجل الأسعار والإصدارات</b>{prices.map((p,i)=>{const branch=branches.find(b=>str(b.id,"")===str(p.branchId,""));const canManagePrice=canManageOrganization||(typeof p.branchId==="string"&&Boolean(branch));return <PriceRow key={str(p.id,String(i))} price={p} itemId={itemId} branchName={p.branchId?str(branch?.name,"فرع غير متاح لهذا النطاق"):"مستوى الجهة"} canManage={canManagePrice} onCommand={send} onRefresh={onRefresh} onError={onError} onNotice={onNotice}/>})}</div>}
    {Object.keys(row(item.attributes)).length>0&&<section className="cat-attribute-summary"><h4>المواصفات</h4><dl>{Object.entries(row(item.attributes)).map(([key,value])=><div key={key}><dt>{({vehicleTypes:"أنواع المركبات",durationMinutes:"المدة بالدقائق",included:"المشمول",viscosity:"اللزوجة",specification:"المواصفة",volumeMl:"الحجم بالملليلتر",capacityAh:"السعة أمبير-ساعة",voltage:"الجهد",warrantyMonths:"الضمان بالأشهر",partNumber:"رقم الصنف",compatibility:"التوافق"})[key]??"مواصفة إضافية"}</dt><dd>{Array.isArray(value)?value.map(String).join("، "):String(value)}</dd></div>)}</dl></section>}
    {canManage&&<form className="cat-form cat-image-form" {...formValidationEvents} onSubmit={imageSubmit}><h4><ImagePlus size={16}/> صور خاصة</h4><p>صور PNG/JPEG فقط، حتى 5 ميغابايت. لا يكتمل الحفظ إلا بعد نجاح الرفع والتحقق.</p>{!canManageOrganization&&<Field label="الفرع"><select name="branchId" required><option value="">اختر فرعًا مخولًا</option>{branches.map((b,i)=><option key={str(b.id,String(i))} value={str(b.id,"")}>{str(b.name)}</option>)}</select></Field>}<Field label="اختيار صورة"><input name="image" type="file" accept="image/png,image/jpeg" required/></Field><AuditReason/><button className="cat-button" disabled={imageBusy||command.isPending||uploadPng.isPending||uploadJpeg.isPending}>{imageBusy?<><LoaderCircle className="cat-spin" size={15}/> جارٍ رفع الصورة…</>:"بدء الرفع الخاص"}</button></form>}
    {images.map((im,i)=><PrivateImage key={str(im.id,String(i))} image={im}/>)}
    <p className="cat-version-note">نسخة الصنف {str(item.version)} · {canManage||canReview?"تظهر الإجراءات التي تسمح بها صلاحيتك فقط.":"وضع عرض فقط؛ لا توجد صلاحية إدارة لهذه الجهة."} لا توجد هنا مبيعات أو مخزون أو طلبات.</p>
  </section>;
}
function PriceRow({price,itemId,branchName,canManage,onCommand,onRefresh,onError,onNotice}:{price:Row;itemId:string;branchName:string;canManage:boolean;onCommand:(a:CatalogCommandRequestAction,p:Row,r:string)=>Promise<unknown>;onRefresh:(id?:string)=>Promise<void>;onError:(s:string)=>void;onNotice:(s:string)=>void}) {
  const [reason,setReason]=useState(""); const [busy,setBusy]=useState(false);
  async function action(actionName:CatalogCommandRequestAction){if(reason.trim().length<3){onError("سبب الإجراء مطلوب.");return;}setBusy(true);try{await onCommand(actionName,{priceVersionId:price.id},reason.trim());await onRefresh(itemId);onNotice(actionName==="item.price.publish"?"تم نشر نسخة السعر.":"تم إلغاء نسخة السعر.");}catch(x){onError(errText(x));}finally{setBusy(false);}}
  return <div className="cat-price-row"><span>نسخة {str(price.version)} · {branchName} · {statusName[str(price.status)]??str(price.status)}</span><b>{money(price.priceMinor)}</b><small>{date(price.validFrom)}</small>{str(price.reason,"")&&<small>{str(price.reason)}</small>}{canManage&&price.status==="draft"&&<><input value={reason} onChange={e=>setReason(e.target.value)} placeholder="سبب الإجراء" aria-label="سبب إجراء السعر"/><button disabled={busy} onClick={()=>void action("item.price.publish")}>نشر</button><button disabled={busy} onClick={()=>void action("item.price.cancel")}>إلغاء</button></>}</div>;
}

function CatalogAttributeFields({categoryCode,attributes}:{categoryCode:string;attributes:Row}) {
  if(categoryCode==="wash") return <><Field label="أنواع المركبات المناسبة"><input name="vehicleTypes" defaultValue={Array.isArray(attributes.vehicleTypes)?attributes.vehicleTypes.map(String).join("، "):""} placeholder="افصل الأنواع بفاصلة"/></Field><Field label="المدة بالدقائق"><input name="durationMinutes" type="number" min="1" step="1" defaultValue={String(attributes.durationMinutes??"")}/></Field><Field label="ما يشمله الغسيل" className="wide"><textarea name="included" maxLength={2000} rows={2} defaultValue={str(attributes.included,"")}/></Field></>;
  if(categoryCode==="oils") return <><Field label="اللزوجة"><input name="viscosity" maxLength={40} defaultValue={str(attributes.viscosity,"")}/></Field><Field label="المواصفة"><input name="specification" maxLength={120} defaultValue={str(attributes.specification,"")}/></Field><Field label="الحجم بالملليلتر"><input name="volumeMl" type="number" min="1" step="1" defaultValue={String(attributes.volumeMl??"")}/></Field></>;
  if(categoryCode==="batteries") return <><Field label="السعة بالأمبير-ساعة"><input name="capacityAh" type="number" min="0.1" step="0.1" defaultValue={String(attributes.capacityAh??"")}/></Field><Field label="الجهد بالفولت"><input name="voltage" type="number" min="0.1" step="0.1" defaultValue={String(attributes.voltage??"")}/></Field><Field label="الضمان بالأشهر"><input name="warrantyMonths" type="number" min="1" step="1" defaultValue={String(attributes.warrantyMonths??"")}/></Field><Field label="المواصفة"><input name="specification" maxLength={120} defaultValue={str(attributes.specification,"")}/></Field></>;
  if(["filters","parts","consumables"].includes(categoryCode)) return <><Field label="رقم الصنف"><input name="partNumber" maxLength={100} defaultValue={str(attributes.partNumber,"")}/></Field><Field label="التوافق مع المركبات"><input name="compatibility" maxLength={1000} defaultValue={Array.isArray(attributes.compatibility)?attributes.compatibility.map(String).join("، "):str(attributes.compatibility,"")}/></Field><Field label="المواصفة"><input name="specification" maxLength={500} defaultValue={str(attributes.specification,"")}/></Field></>;
  if(categoryCode==="other_services") return <><Field label="المدة بالدقائق"><input name="durationMinutes" type="number" min="1" step="1" defaultValue={String(attributes.durationMinutes??"")}/></Field><Field label="ما تشمله الخدمة" className="wide"><textarea name="included" maxLength={2000} rows={2} defaultValue={str(attributes.included,"")}/></Field></>;
  return null;
}

function PrivateImage({image}:{image:Row}) {
  const imageId=str(image.id,"");
  const download=useDownloadCatalogImage(imageId,{query:{queryKey:["download-catalog-image",imageId],enabled:!!imageId,retry:false,staleTime:0}});
  const url=download.data?.signedUrl;
  return <div className="cat-private-image">{url?<img src={url} alt={str(image.fileName,"صورة الصنف")} referrerPolicy="no-referrer"/>:<span><ImagePlus size={20}/></span>}<div><b>{str(image.fileName,"صورة خاصة")}</b><small>{download.isLoading?"جارٍ إنشاء رابط خاص":download.isError?"تعذر إنشاء رابط خاص":"رابط خاص مؤقت"}</small></div>{download.isError&&<button type="button" onClick={()=>void download.refetch()}>إعادة المحاولة</button>}</div>;
}
