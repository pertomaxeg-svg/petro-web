import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useLocation, useRoute } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Building2, ChevronLeft, CircleAlert, CircleCheck, MapPin, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Truck, Users, Wallet, X } from "lucide-react";
import {
  useGetAuthMe, useListOrganizations, useCreateOrganization, useGetOrganization, useUpdateOrganization,
  useApproveOrganization, useUpdateOrganizationStatus, useListBranchesPaginated, useCreateBranch,
  useUpdateBranch, useApproveBranch, useUpdateBranchStatus,
  useListMemberships, getListMembershipsQueryKey,
  getListOrganizationsQueryKey, getGetOrganizationQueryKey, getListBranchesPaginatedQueryKey, getListBranchesQueryKey,
  getGetAuthMeQueryKey,
  getGetAdminOrganizationBranchQueryKey, getGetAdminOrganizationFinanceAccountsQueryKey,
  getListAdminOrganizationMembershipsQueryKey, useGetAdminOrganizationBranch,
  useGetAdminOrganizationFinanceAccounts, useListAdminOrganizationMemberships,
} from "@workspace/api-client-react";
import type { Organization, Branch, ListOrganizationsParams, ListBranchesPaginatedParams, CreateOrganizationRequest, UpdateOrganizationRequest, CreateBranchRequest, UpdateBranchRequest } from "@workspace/api-client-react";
import { OrganizationRecords } from "./OrganizationWorkflow";
import {
  OrganizationBillingPanel,
  OrganizationFinancePanel,
  OrganizationFleetPanel,
  OrganizationMembersPanel,
  OrganizationSummaryPanel,
} from "./OrganizationAdminProfilePanels";
import "./CentralOrganizationsAdmin.css";

const kindLabels: Record<string,string> = { company: "شركة", station: "محطة وقود", provider: "مقدّم خدمة" };
const weekdays = [["sun","الأحد"],["mon","الاثنين"],["tue","الثلاثاء"],["wed","الأربعاء"],["thu","الخميس"],["fri","الجمعة"],["sat","السبت"]] as const;
const approvalLabels = { pending: "بانتظار الاعتماد", approved: "معتمدة" };
const operationLabels = { inactive: "غير مفعّلة", active: "تعمل", suspended: "موقوفة" };
function statusLabel(value: string, kind: "approval"|"operation") { return kind === "approval" ? (approvalLabels as Record<string,string>)[value] ?? value : (operationLabels as Record<string,string>)[value] ?? value; }
function apiError(error: unknown) {
  const e = error as {status?:number; message?:string; data?:{message?:string}};
  if (e?.status === 409) return "تغيّرت البيانات منذ فتح هذه الصفحة. أعد تحميلها قبل إجراء أي تعديل.";
  const message = e?.data?.message ?? e?.message ?? "تعذّر إتمام العملية. حاول مرة أخرى.";
  if (/unique|duplicate|already exists|code/i.test(message)) return "هذا الكود مستخدم بالفعل. اختر كودًا آخر.";
  if (e?.status === 403) return "ليست لديك صلاحية لتنفيذ هذا الإجراء.";
  return message;
}
function isAdmin(context: unknown) {
  const c = context as {platform_roles?:unknown; platformRoles?:unknown} | null;
  const roles = c?.platform_roles ?? c?.platformRoles;
  return Array.isArray(roles) && roles.some(r => typeof r === "string" && ["owner","operations"].includes(r.toLowerCase()));
}
function Pill({value, kind}: {value:string;kind:"approval"|"operation"}) { return <span className={`co-pill co-${kind}-${value}`}><i/>{statusLabel(value,kind)}</span>; }
function Toast({children, error=false}: {children:ReactNode;error?:boolean}) { const conflict=error&&children==="تغيّرت البيانات منذ فتح هذه الصفحة. أعد تحميلها قبل إجراء أي تعديل.";return <div className={error?"co-alert":"co-success"} role={error?"alert":"status"}>{error?<CircleAlert size={17}/>:<CircleCheck size={17}/>}<span>{children}</span>{conflict&&<button className="co-reload" onClick={()=>window.location.reload()}>إعادة تحميل السجل</button>}</div>; }
function LoadingRows() { return <div className="co-skeletons" aria-label="جارٍ تحميل البيانات">{[1,2,3,4].map(i=><div key={i} className="co-skeleton-row"><i/><i/><i/></div>)}</div>; }

export default function CentralOrganizations() {
  const [,adminDetailRoute] = useRoute("/admin/organizations/:id");
  const [,workspaceDetailRoute] = useRoute("/workspace/organizations/:id");
  const [,adminListRoute] = useRoute("/admin/organizations");
  const adminMode=!!adminDetailRoute||!!adminListRoute;
  const id = adminDetailRoute?.id??workspaceDetailRoute?.id;
  const me = useGetAuthMe({query:{queryKey:getGetAuthMeQueryKey(),retry:false,staleTime:20000}});
  const [,setLocation] = useLocation();
  const permitted = !!me.data && me.data.state === "active" && (adminMode?isAdmin(me.data.accessContext):!!workspaceDetailRoute);
  if (me.isLoading) return <main className="co-loading" dir="rtl"><div className="co-loader"><span/><span/><span/></div><p>جارٍ التحقق من صلاحية الوصول</p></main>;
  if (me.isError || !me.data) return <main className="co-guard" dir="rtl"><header><img src="/petro-max-lockup.png" alt="Petro Max EG"/></header><section><ShieldCheck/><h1>يلزم تسجيل الدخول</h1><p>سجّل الدخول بحساب مخوّل للوصول إلى إدارة الجهات والفروع.</p><Link className="co-button" href="/sign-in">تسجيل الدخول <ArrowRight size={16}/></Link></section></main>;
  if (!permitted) return <main className="co-guard" dir="rtl"><header><img src="/petro-max-lockup.png" alt="Petro Max EG"/></header><section><ShieldCheck/><h1>هذه المساحة غير متاحة</h1><p>لا يملك الحساب الحالي صلاحية الوصول إلى هذا المسار.</p><Link className="co-button" href="/workspace">العودة إلى مساحة العمل <ArrowRight size={16}/></Link></section></main>;
   const organizationContent = <div className="co-frame">
     {!adminMode&&<div className="co-crumb"><span>مساحة العمل</span><ChevronLeft size={14}/><span>الجهات</span>{id&&<><ChevronLeft size={14}/><span>تفاصيل الجهة</span></>}</div>}
     {id ? <OrganizationDetail id={id} adminMode={adminMode} userId={me.data.id} accessContext={me.data.accessContext}/> : <OrganizationList/>}
     {!adminMode&&<footer className="co-footer"><span>Pertomax EG</span><span>البيانات والصلاحيات تخضع للتحقق من الخادم</span></footer>}
   </div>;
   if (adminMode) return organizationContent;
   return <div className="central-admin" dir="rtl">
     <header className="co-topbar"><Link href="/workspace" aria-label="Pertomax EG"><img src="/petro-max-lockup.png" alt="Pertomax EG"/></Link><div className="co-topbar-label"><span>مساحة العمل</span><b>الجهات والفروع</b></div><div className="co-user"><span className="co-user-mark"><ShieldCheck size={16}/></span><span>{me.data.displayName}<small>عضوية الجهة</small></span><button onClick={()=>setLocation("/workspace")} aria-label="العودة إلى مساحة العمل">مساحة العمل</button></div></header>
     {organizationContent}
   </div>;
}

function OrganizationList() {
  const [search,setSearch] = useState("");
  const [kind,setKind] = useState("");
  const [approval,setApproval] = useState("");
  const [operation,setOperation] = useState("");
  const [sortBy,setSortBy] = useState<NonNullable<ListOrganizationsParams["sortBy"]>>("createdAt");
  const [sortDirection,setSortDirection] = useState<NonNullable<ListOrganizationsParams["sortDirection"]>>("desc");
  const [page,setPage] = useState(1);
  const [form,setForm] = useState(false);
  const [notice,setNotice] = useState("");
  const [error,setError] = useState("");
  const params = useMemo<ListOrganizationsParams>(()=>({page,pageSize:10,...(search.trim()?{search:search.trim()}:{}),...(kind?{kind:kind as ListOrganizationsParams["kind"]}:{}),...(approval?{approvalStatus:approval as ListOrganizationsParams["approvalStatus"]}:{}),...(operation?{operationalStatus:operation as ListOrganizationsParams["operationalStatus"]}:{}),sortBy,sortDirection}),[page,search,kind,approval,operation,sortBy,sortDirection]);
  const query = useListOrganizations(params,{query:{queryKey:getListOrganizationsQueryKey(params),refetchOnMount:"always"}});
  const create = useCreateOrganization();
  const cache=useQueryClient();
  async function submit(e:FormEvent<HTMLFormElement>) {
    e.preventDefault();setError("");setNotice("");
    const d=new FormData(e.currentTarget);
    const data:CreateOrganizationRequest={name:String(d.get("name")).trim(),kind:String(d.get("kind")) as CreateOrganizationRequest["kind"],code:String(d.get("code")).trim(),address:String(d.get("address")).trim(),legalName:String(d.get("legalName")).trim()||null,contactName:String(d.get("contactName")).trim()||null,contactPhone:String(d.get("contactPhone")).trim()||null,contactEmail:String(d.get("contactEmail")).trim()||null};
    try { await create.mutateAsync({data});await cache.invalidateQueries({queryKey:getListOrganizationsQueryKey()});setForm(false);setNotice("تم إرسال بيانات الجهة بنجاح."); }
    catch(x){setError(apiError(x));}
  }
  const pageData=query.data;
  return <section className="co-content">
    <section className="co-page-heading"><div><span className="co-eyebrow">سجل المنصة <i/></span><h1>الجهات</h1><p>إدارة الجهات المسجّلة ومراجعة اعتمادها وحالتها التشغيلية.</p></div><div className="co-heading-count"><small>إجمالي النتائج</small><b>{pageData?.total ?? "—"}</b><span>جهة</span></div></section>
    <div className="co-list-actions"><div className="co-search"><Search size={18}/><input value={search} onChange={e=>{setPage(1);setSearch(e.target.value)}} placeholder="ابحث بالاسم أو الكود" aria-label="ابحث بالاسم أو الكود"/></div><button className="co-button" onClick={()=>{setForm(!form);setError("");setNotice("")}}><Plus size={17}/>{form?"إغلاق النموذج":"إضافة جهة"}</button></div>
    {form&&<form className="co-form-card" onSubmit={submit}><div className="co-form-heading"><div><span className="co-eyebrow">تسجيل جهة</span><h2>بيانات الجهة الجديدة</h2></div><button type="button" className="co-icon-button" aria-label="إغلاق" onClick={()=>setForm(false)}><X size={18}/></button></div><div className="co-fields">
      <label>الاسم التجاري<input name="name" required minLength={2} maxLength={160} autoFocus/></label>
      <label>الكود الفريد<input name="code" required minLength={2} maxLength={40} pattern="[A-Za-z0-9_-]+" dir="ltr" placeholder="مثال: CAIRO-01"/><small>أحرف لاتينية وأرقام وشرطة فقط</small></label>
      <label>نوع الجهة<select name="kind"><option value="company">شركة</option><option value="station">محطة وقود</option><option value="provider">مقدّم خدمة</option></select></label>
      <label>الاسم القانوني<input name="legalName" maxLength={200}/></label>
      <label>اسم مسؤول التواصل<input name="contactName" maxLength={160}/></label>
      <label>رقم الهاتف<input name="contactPhone" maxLength={24} dir="ltr"/></label>
      <label>البريد الإلكتروني<input name="contactEmail" type="email" maxLength={320} dir="ltr"/></label>
      <label className="co-field-wide">العنوان<input name="address" required maxLength={500}/></label>
    </div>{error&&<Toast error>{error}</Toast>}<div className="co-form-actions"><button className="co-button" disabled={create.isPending}>{create.isPending?"جارٍ الحفظ…":"حفظ الجهة"}</button><button type="button" className="co-button co-secondary" onClick={()=>setForm(false)}>إلغاء</button></div></form>}
    {notice&&<Toast>{notice}</Toast>}{error&&!form&&<Toast error>{error}</Toast>}
    <section className="co-table-card"><div className="co-filterbar"><span><SlidersHorizontal size={16}/> تصفية وفرز</span>
      <label>النوع<select value={kind} onChange={e=>{setPage(1);setKind(e.target.value)}}><option value="">كل الأنواع</option><option value="company">شركة</option><option value="station">محطة وقود</option><option value="provider">مقدّم خدمة</option></select></label>
      <label>الاعتماد<select value={approval} onChange={e=>{setPage(1);setApproval(e.target.value)}}><option value="">كل حالات الاعتماد</option><option value="pending">بانتظار الاعتماد</option><option value="approved">معتمدة</option></select></label>
      <label>التشغيل<select value={operation} onChange={e=>{setPage(1);setOperation(e.target.value)}}><option value="">كل الحالات التشغيلية</option><option value="inactive">غير مفعّلة</option><option value="active">تعمل</option><option value="suspended">موقوفة</option></select></label>
      <label>ترتيب حسب<select value={sortBy} onChange={e=>setSortBy(e.target.value as NonNullable<ListOrganizationsParams["sortBy"]>)}><option value="createdAt">تاريخ الإضافة</option><option value="name">الاسم</option><option value="code">الكود</option><option value="kind">النوع</option><option value="approvalStatus">الاعتماد</option><option value="operationalStatus">التشغيل</option></select></label>
      <button className="co-sort" onClick={()=>setSortDirection(sortDirection==="asc"?"desc":"asc")} aria-label="تغيير اتجاه الترتيب">{sortDirection==="asc"?"تصاعدي ↑":"تنازلي ↓"}</button>
    </div>
    {query.isLoading?<LoadingRows/>:query.isError?<div className="co-state"><CircleAlert/><h2>تعذر تحميل الجهات</h2><p>{apiError(query.error)}</p><button className="co-button co-secondary" onClick={()=>void query.refetch()}><RefreshCw size={16}/> إعادة المحاولة</button></div>:pageData?.items.length===0?<div className="co-state co-empty"><span className="co-empty-mark"><Building2 size={27}/></span><h2>لم تُضف جهات بعد</h2><p>ستظهر الجهات هنا بعد تسجيلها. أضف الجهة الأولى لتبدأ إدارة فروعها واعتمادها.</p><button className="co-button" onClick={()=>setForm(true)}><Plus size={17}/> إضافة جهة</button></div>:<>
       <div className="co-table-scroll"><table><thead><tr><th>الجهة</th><th>النوع</th><th>الاعتماد</th><th>التشغيل</th><th>تاريخ الإضافة</th><th><span className="sr-only">التفاصيل</span></th></tr></thead><tbody>{(pageData?.items??[]).map(o=><tr key={o.id} data-testid={`organization-row-${o.id}`}><td><Link className="co-org-cell" href={`/admin/organizations/${o.id}`}><span className="co-org-icon"><Building2 size={18}/></span><span><b>{o.name}</b><small dir="ltr">{o.code||"—"}</small></span></Link></td><td>{kindLabels[o.kind]??o.kind}</td><td><Pill kind="approval" value={o.approval_status}/></td><td><Pill kind="operation" value={o.operational_status}/></td><td>{new Date(o.created_at).toLocaleDateString("ar-EG")}</td><td><Link className="co-row-open" href={`/admin/organizations/${o.id}`}>التفاصيل <ChevronLeft size={15}/></Link></td></tr>)}</tbody></table></div>
      <div className="co-pagination"><span>عرض {pageData?.items.length} من {pageData?.total} جهة</span><div><button disabled={page<=1} onClick={()=>setPage(page-1)}>السابق</button><b>{pageData?.page} / {Math.max(1,pageData?.totalPages??1)}</b><button disabled={page>=(pageData?.totalPages??1)} onClick={()=>setPage(page+1)}>التالي</button></div></div>
    </>}
    </section>
  </section>;
}

function OrganizationDetail({id,adminMode,userId,accessContext}:{id:string;adminMode:boolean;userId:string;accessContext:unknown}) {
  const cache=useQueryClient();
  const [,setLocation]=useLocation();
  const [adminTab,setAdminTab]=useState<"overview"|"branches"|"users"|"fleet"|"subscriptions"|"finance"|"records">(()=>{const params=new URLSearchParams(typeof window==="undefined"?"":window.location.search);const tab=params.get("section");return params.get("createBranch")==="1"?"branches":tab==="branches"||tab==="users"||tab==="fleet"||tab==="subscriptions"||tab==="finance"||tab==="records"?tab:"overview";});
  const orgQ=useGetOrganization(id,{query:{queryKey:getGetOrganizationQueryKey(id),refetchOnMount:"always"}});
  const membershipQ=useListMemberships(id,{query:{queryKey:getListMembershipsQueryKey(id),enabled:!adminMode,refetchOnMount:"always",retry:false}});
  const canManage=adminMode||(membershipQ.data?.items??[]).some(member=>member.user_id===userId&&member.active&&member.scope==="organization"&&["organization_owner","manager"].includes(member.role));
  const managedBranchIds=[...new Set((membershipQ.data?.items??[]).filter(member=>member.user_id===userId&&member.active&&member.scope==="branches"&&["organization_owner","manager"].includes(member.role)).flatMap(member=>member.branchIds??[]))];
  const context=accessContext as {platform_roles?:unknown;platformRoles?:unknown}|undefined;
  const platformRoles=context?.platform_roles??context?.platformRoles;
  const canManageBank=(Array.isArray(platformRoles)&&platformRoles.some(role=>typeof role==="string"&&["owner","finance"].includes(role.toLowerCase())))||(membershipQ.data?.items??[]).some(member=>member.user_id===userId&&member.active&&member.scope==="organization"&&["organization_owner","finance"].includes(member.role));
  const [search,setSearch]=useState("");const [approval,setApproval]=useState("");const [operation,setOperation]=useState("");const [sortBy,setSortBy]=useState<NonNullable<ListBranchesPaginatedParams["sortBy"]>>("createdAt");const [sortDirection,setSortDirection]=useState<NonNullable<ListBranchesPaginatedParams["sortDirection"]>>("desc");const [page,setPage]=useState(1);
  const params=useMemo<ListBranchesPaginatedParams>(()=>({organizationId:id,page,pageSize:10,...(search.trim()?{search:search.trim()}:{}),...(approval?{approvalStatus:approval as ListBranchesPaginatedParams["approvalStatus"]}:{}),...(operation?{operationalStatus:operation as ListBranchesPaginatedParams["operationalStatus"]}:{}),sortBy,sortDirection}),[id,page,search,approval,operation,sortBy,sortDirection]);
  const branchesQ=useListBranchesPaginated(params,{query:{queryKey:getListBranchesPaginatedQueryKey(params),refetchOnMount:"always"}});
  const scopeBranchParams=useMemo<ListBranchesPaginatedParams>(()=>({organizationId:id,page:1,pageSize:100,sortBy:"name",sortDirection:"asc"}),[id]);
  const needsBranchNames=(membershipQ.data?.items??[]).some(member=>member.scope==="branches"&&(member.branchIds??[]).length>0);
  const scopeBranchesQ=useListBranchesPaginated(scopeBranchParams,{query:{queryKey:getListBranchesPaginatedQueryKey(scopeBranchParams),enabled:!adminMode&&needsBranchNames,retry:false}});
  const branchNameById=new Map((scopeBranchesQ.data?.items??branchesQ.data?.items??[]).map(branch=>[branch.id,branch.name]));
  const searchParams=new URLSearchParams(typeof window==="undefined"?"":window.location.search);
  const fleetReturnPath=`/admin/fleet/companies/${encodeURIComponent(id)}`;
  const returnToFleet=adminMode&&searchParams.get("returnTo")===fleetReturnPath;
  const createBranchRequested=adminMode&&searchParams.get("createBranch")==="1";
  const [editOrg,setEditOrg]=useState(false);const [branchForm,setBranchForm]=useState(false);const [editingBranch,setEditingBranch]=useState<Branch|null>(null);const [action,setAction]=useState<{target:"org"|"branch";id:string;type:"approve"|"active"|"suspended"}|null>(null);const [error,setError]=useState("");const [notice,setNotice]=useState("");
   useEffect(()=>{if(createBranchRequested){setAdminTab("branches");setBranchForm(true);setEditingBranch(null);}},[createBranchRequested,id]);
  useEffect(()=>{if(!branchForm)return;const fieldset=document.querySelector(".co-hours");if(!fieldset)return;const updateRequired=(event:Event)=>{const input=event.target as HTMLInputElement;if(input.type!=="checkbox"||!input.name.endsWith("_closed"))return;input.closest("div")?.querySelectorAll<HTMLInputElement>('input[type="time"]').forEach(time=>{time.required=!input.checked;});};fieldset.addEventListener("change",updateRequired);return()=>fieldset.removeEventListener("change",updateRequired);},[branchForm]);
  const edit=useUpdateOrganization();const approve=useApproveOrganization();const orgStatus=useUpdateOrganizationStatus();const createBranch=useCreateBranch();const updateBranch=useUpdateBranch();const approveBranch=useApproveBranch();const branchStatus=useUpdateBranchStatus();
  const org=orgQ.data as Organization|undefined;const branches=branchesQ.data;
  async function invalidateAll(){await Promise.all([cache.invalidateQueries({queryKey:getListOrganizationsQueryKey()}),cache.invalidateQueries({queryKey:getGetOrganizationQueryKey(id)}),cache.invalidateQueries({queryKey:getListBranchesPaginatedQueryKey()}),cache.invalidateQueries({queryKey:getListBranchesQueryKey(id)})]);}
  async function saveOrg(e:FormEvent<HTMLFormElement>){e.preventDefault();if(!org||!canManage)return;setError("");const d=new FormData(e.currentTarget);const reason=String(d.get("reason")).trim();if(reason.length<5||reason.length>500){setError("سبب التعديل مطلوب، من 5 إلى 500 حرف.");return;}try{await edit.mutateAsync({organizationId:id,data:{expectedVersion:org.version,name:String(d.get("name")).trim(),kind:String(d.get("kind")) as UpdateOrganizationRequest["kind"],code:String(d.get("code")).trim(),legalName:String(d.get("legalName")).trim()||null,contactName:String(d.get("contactName")).trim()||null,contactPhone:String(d.get("contactPhone")).trim()||null,contactEmail:String(d.get("contactEmail")).trim()||null,address:String(d.get("address")).trim(),reason}});await invalidateAll();setEditOrg(false);setNotice("تم حفظ بيانات الجهة.");}catch(x){setError(apiError(x));}}
  async function saveBranch(e:FormEvent<HTMLFormElement>){e.preventDefault();if(!org||!canManage)return;setError("");const d=new FormData(e.currentTarget);const reason=String(d.get("reason")).trim();if(editingBranch&&(reason.length<5||reason.length>500)){setError("سبب تعديل الفرع مطلوب، من 5 إلى 500 حرف.");return;}for(const [key,label] of weekdays){if(d.get(`${key}_closed`)!=="on"&&(!d.get(`${key}_open`)||!d.get(`${key}_close`))){setError(`أدخل ساعات العمل ليوم ${label} أو حدّد أنه مغلق.`);return;}}const hours=Object.fromEntries(weekdays.map(([key])=>{const closed=d.get(`${key}_closed`)==="on";return [key,closed?{closed:true}:{closed:false,open:String(d.get(`${key}_open`)),close:String(d.get(`${key}_close`))}]})) as CreateBranchRequest["hours"];
    const common={code:String(d.get("code")).trim(),name:String(d.get("name")).trim(),address:String(d.get("address")).trim(),governorate:String(d.get("governorate")).trim()||null,latitude:String(d.get("latitude")).trim()?Number(d.get("latitude")):null,longitude:String(d.get("longitude")).trim()?Number(d.get("longitude")):null,hours,contactName:String(d.get("contactName")).trim()||null,contactPhone:String(d.get("contactPhone")).trim()||null};
     try {if(editingBranch){const payload:UpdateBranchRequest={expectedVersion:editingBranch.version,organizationId:id,...common,reason};await updateBranch.mutateAsync({branchId:editingBranch.id,data:payload});}else{await createBranch.mutateAsync({organizationId:id,data:common as CreateBranchRequest});}await invalidateAll();setBranchForm(false);setEditingBranch(null);setNotice(editingBranch?"تم تحديث بيانات الفرع.":"تمت إضافة الفرع.");if(!editingBranch&&returnToFleet)setLocation(fleetReturnPath);}catch(x){setError(apiError(x));}}
  async function runAction(e:FormEvent<HTMLFormElement>){e.preventDefault();if(!adminMode||!action||!org)return;setError("");const d=new FormData(e.currentTarget);const reason=String(d.get("reason")).trim();if(reason.length<5){setError("اكتب سببًا لا يقل عن خمسة أحرف.");return;}try{
      if(action.target==="org"&&action.type==="approve") await approve.mutateAsync({organizationId:id,data:{expectedVersion:org.version,reason}});
      else if(action.target==="org") await orgStatus.mutateAsync({organizationId:id,data:{expectedVersion:org.version,operationalStatus:action.type as "active"|"suspended",reason}});
      else {const branch=(branches?.items??[]).find(b=>b.id===action.id);if(!branch)throw new Error("تعذر العثور على الفرع؛ أعد تحميل البيانات.");if(action.type==="approve")await approveBranch.mutateAsync({branchId:branch.id,data:{organizationId:id,expectedVersion:branch.version,reason}});else await branchStatus.mutateAsync({branchId:branch.id,data:{organizationId:id,expectedVersion:branch.version,operationalStatus:action.type,reason}});}
      await invalidateAll();setAction(null);setNotice("تم تسجيل الإجراء بنجاح.");
    }catch(x){setError(apiError(x));}}
  if(orgQ.isLoading)return <section className="co-content"><LoadingRows/></section>;
  if(orgQ.isError||!org)return <section className="co-content"><div className="co-state"><CircleAlert/><h2>تعذر تحميل بيانات الجهة</h2><p>{orgQ.isError?apiError(orgQ.error):"الجهة غير متاحة."}</p><button className="co-button co-secondary" onClick={()=>void orgQ.refetch()}><RefreshCw size={16}/> إعادة تحميل</button></div></section>;
  if(adminMode){
    const adminTabs:Array<{id:"overview"|"branches"|"users"|"fleet"|"subscriptions"|"finance"|"records";label:string}>=[
      {id:"overview",label:"الملخص"},
      {id:"branches",label:"الفروع"},
      {id:"users",label:"المستخدمون"},
      ...(org.kind==="company"?[{id:"fleet" as const,label:"الأسطول"}]:[]),
      ...((org.kind==="company"||org.kind==="provider")?[{id:"subscriptions" as const,label:"الاشتراكات"}]:[]),
      ...(org.kind==="company"?[{id:"finance" as const,label:"المالية"}]:[]),
      {id:"records",label:"المستندات والطلبات"},
    ];
    const changeTab=(tab:typeof adminTabs[number]["id"])=>{setAdminTab(tab);setLocation(`/admin/organizations/${encodeURIComponent(id)}?section=${tab}`);};
    return <section className="co-content co-admin-entity">
      <nav className="co-entity-breadcrumb" aria-label="مسار الصفحة"><Link href="/admin/organizations">الجهات والفروع</Link><ChevronLeft size={15}/><span>{org.name}</span></nav>
      <header className="co-entity-header">
        <div className="co-detail-symbol"><Building2 size={25}/></div>
        <div className="co-entity-title"><span className="co-eyebrow">{kindLabels[org.kind]} · {org.code||"بدون كود"}</span><h1>{org.name}</h1><p>{org.contact_name||"مسؤول التواصل غير مسجل"}{org.contact_phone?` · ${org.contact_phone}`:""}</p></div>
        <div className="co-detail-status"><Pill value={org.approval_status} kind="approval"/><Pill value={org.operational_status} kind="operation"/></div>
        <div className="co-entity-actions">
          {canManage&&<button className="co-button co-secondary" onClick={()=>{setEditOrg(!editOrg);setError("")}}>تعديل بيانات الجهة</button>}
          {org.approval_status==="pending"&&<button className="co-button" onClick={()=>{setAction({target:"org",id,type:"approve"});setError("")}}>اعتماد الجهة</button>}
          {org.approval_status==="approved"&&org.operational_status!=="suspended"&&<button className="co-button co-danger" onClick={()=>{setAction({target:"org",id,type:"suspended"});setError("")}}>إيقاف التشغيل</button>}
          {org.approval_status==="approved"&&org.operational_status!=="active"&&<button className="co-button" onClick={()=>{setAction({target:"org",id,type:"active"});setError("")}}>إعادة التشغيل</button>}
        </div>
      </header>
      {notice&&<Toast>{notice}</Toast>}{error&&<Toast error>{error}</Toast>}
      {editOrg&&canManage&&<form className="co-form-card" onSubmit={saveOrg}><div className="co-form-heading"><div><span className="co-eyebrow">تحديث السجل</span><h2>بيانات الجهة</h2></div><button type="button" className="co-icon-button" onClick={()=>setEditOrg(false)} aria-label="إغلاق"><X size={18}/></button></div><div className="co-fields">
        <label>الاسم التجاري<input name="name" required defaultValue={org.name}/></label><label>الكود الفريد<input name="code" required pattern="[A-Za-z0-9_-]+" dir="ltr" defaultValue={org.code??""}/></label><label>النوع<select name="kind" defaultValue={org.kind}><option value="company">شركة</option><option value="station">محطة وقود</option><option value="provider">مقدّم خدمة</option></select></label><label>الاسم القانوني<input name="legalName" defaultValue={org.legal_name??""}/></label><label>مسؤول التواصل<input name="contactName" defaultValue={org.contact_name??""}/></label><label>الهاتف<input name="contactPhone" dir="ltr" defaultValue={org.contact_phone??""}/></label><label>البريد الإلكتروني<input name="contactEmail" type="email" dir="ltr" defaultValue={org.contact_email??""}/></label><label className="co-field-wide">العنوان<input name="address" required defaultValue={org.address}/></label>
      </div><label className="co-audit-reason">سبب التعديل (5–500 حرف)<textarea name="reason" required minLength={5} maxLength={500} rows={3} placeholder="اشرح سبب تحديث بيانات الجهة"/></label><p className="co-version-note">نسخة السجل الحالية: {org.version} · يتحقق الخادم من عدم وجود تعديل أحدث.</p><div className="co-form-actions"><button className="co-button" disabled={edit.isPending}>{edit.isPending?"جارٍ الحفظ…":"حفظ التعديلات"}</button><button className="co-button co-secondary" type="button" onClick={()=>setEditOrg(false)}>إلغاء</button></div></form>}
      <nav className="co-entity-tabs" role="tablist" aria-label="أقسام ملف الجهة">{adminTabs.map(tab=><button key={tab.id} type="button" role="tab" aria-selected={adminTab===tab.id} className={adminTab===tab.id?"is-active":""} onClick={()=>changeTab(tab.id)}>{tab.label}</button>)}</nav>
      {adminTab==="overview"&&<div className="co-entity-tab-content">
        <OrganizationSummaryPanel organizationId={id} organizationName={org.name} kind={org.kind} branchCount={branchesQ.isError?null:branches?.total??null} branchesFailed={branchesQ.isError} branchesLoading={branchesQ.isLoading}/>
        {branchesQ.isError&&<div className="co-data-state co-data-state-error" role="alert">تعذر التحقق من عدد الفروع؛ أعد تحميل الصفحة.</div>}
        <section className="co-profile-contact-grid" aria-label="بيانات التواصل والعنوان">
          <article><span>الاسم القانوني</span><strong>{org.legal_name||"غير مسجل"}</strong></article>
          <article><span>مسؤول التواصل</span><strong>{org.contact_name||"غير مسجل"}</strong></article>
          <article><span>الهاتف</span><strong dir="ltr">{org.contact_phone||"غير مسجل"}</strong></article>
          <article><span>البريد الإلكتروني</span><strong dir="ltr">{org.contact_email||"غير مسجل"}</strong></article>
          <article className="co-contact-address"><span>العنوان</span><strong><MapPin size={15}/>{org.address||"غير مسجل"}</strong></article>
        </section>
        {org.kind==="station"&&<div className="co-profile-callout"><ShieldCheck size={18}/><span><b>المحطات مجانية</b><small>لا تُعرض باقة مدفوعة أو عمولة للمحطة.</small></span></div>}
        {org.kind==="provider"&&<div className="co-profile-callout"><ShieldCheck size={18}/><span><b>مقدم خدمات</b><small>لا يتضمن الملف وقودًا أو عمليات غير مبنية.</small></span></div>}
      </div>}
      {adminTab==="branches"&&<section className="co-branches-section co-entity-tab-content"><div className="co-branches-head"><div><span className="co-eyebrow">البنية التشغيلية</span><h2>الفروع <small>{branches?.total??"—"}</small></h2><p>كل فرع مرتبط بهذه الجهة فقط.</p></div>{canManage&&<button className="co-button" onClick={()=>{setEditingBranch(null);setBranchForm(!branchForm);setError("")}}><Plus size={17}/>{branchForm?"إغلاق":"إضافة فرع"}</button>}</div>
        {branchForm&&<form className="co-form-card" onSubmit={saveBranch}><div className="co-form-heading"><div><span className="co-eyebrow">{editingBranch?"تحديث بيانات":"فرع جديد"}</span><h2>{editingBranch?editingBranch.name:"إضافة فرع إلى "+org.name}</h2></div><button type="button" className="co-icon-button" onClick={()=>{setBranchForm(false);setEditingBranch(null)}} aria-label="إغلاق"><X size={18}/></button></div><div className="co-fields"><label>اسم الفرع<input name="name" required defaultValue={editingBranch?.name}/></label><label>الكود الفريد<input name="code" required minLength={2} maxLength={40} pattern="[A-Za-z0-9_-]+" dir="ltr" defaultValue={editingBranch?.code??""}/></label><label>المحافظة<input name="governorate" defaultValue={editingBranch?.governorate??""}/></label><label className="co-field-wide">العنوان<input name="address" required defaultValue={editingBranch?.address}/></label><label>خط العرض<input name="latitude" type="number" step="any" min="-90" max="90" dir="ltr" defaultValue={editingBranch?.latitude??""}/></label><label>خط الطول<input name="longitude" type="number" step="any" min="-180" max="180" dir="ltr" defaultValue={editingBranch?.longitude??""}/></label><label>مسؤول الفرع<input name="contactName" defaultValue={editingBranch?.contact_name??""}/></label><label>هاتف الفرع<input name="contactPhone" dir="ltr" defaultValue={editingBranch?.contact_phone??""}/></label></div><fieldset className="co-hours"><legend>ساعات العمل حسب اليوم</legend>{weekdays.map(([key,label])=>{const day=editingBranch?.hours?.[key];return <div key={key}><b>{label}</b><label className="co-closed"><input type="checkbox" name={`${key}_closed`} defaultChecked={day?.closed??false}/> مغلق</label><label>يفتح<input name={`${key}_open`} type="time" required={!day?.closed} defaultValue={day?.open??""}/></label><label>يغلق<input name={`${key}_close`} type="time" required={!day?.closed} defaultValue={day?.close??""}/></label></div>})}</fieldset>{editingBranch&&<label className="co-audit-reason">سبب التعديل (5–500 حرف)<textarea name="reason" required minLength={5} maxLength={500} rows={3} placeholder="اشرح سبب تحديث بيانات الفرع"/></label>}<p className="co-version-note">الجهة المرتبطة: <b>{org.name}</b> · لا يمكن تغييرها من نموذج الفرع.</p><div className="co-form-actions"><button className="co-button" disabled={createBranch.isPending||updateBranch.isPending}>{createBranch.isPending||updateBranch.isPending?"جارٍ الحفظ…":"حفظ الفرع"}</button><button className="co-button co-secondary" type="button" onClick={()=>{setBranchForm(false);setEditingBranch(null)}}>إلغاء</button></div></form>}
        <div className="co-filterbar co-branch-filters"><div className="co-search"><Search size={16}/><input value={search} onChange={e=>{setPage(1);setSearch(e.target.value)}} placeholder="ابحث باسم الفرع أو الكود" aria-label="ابحث عن فرع"/></div><label>الاعتماد<select value={approval} onChange={e=>{setPage(1);setApproval(e.target.value)}}><option value="">كل حالات الاعتماد</option><option value="pending">بانتظار الاعتماد</option><option value="approved">معتمدة</option></select></label><label>التشغيل<select value={operation} onChange={e=>{setPage(1);setOperation(e.target.value)}}><option value="">كل الحالات</option><option value="inactive">غير مفعّلة</option><option value="active">تعمل</option><option value="suspended">موقوفة</option></select></label><label>ترتيب حسب<select value={sortBy} onChange={e=>setSortBy(e.target.value as NonNullable<ListBranchesPaginatedParams["sortBy"]>)}><option value="createdAt">تاريخ الإضافة</option><option value="name">الاسم</option><option value="code">الكود</option><option value="approvalStatus">الاعتماد</option><option value="operationalStatus">التشغيل</option></select></label><button className="co-sort" type="button" onClick={()=>setSortDirection(sortDirection==="asc"?"desc":"asc")}>{sortDirection==="asc"?"تصاعدي ↑":"تنازلي ↓"}</button></div>
        {branchesQ.isLoading?<LoadingRows/>:branchesQ.isError?<div className="co-state"><CircleAlert/><h2>تعذر تحميل الفروع</h2><p>{apiError(branchesQ.error)}</p><button className="co-button co-secondary" onClick={()=>void branchesQ.refetch()}><RefreshCw size={16}/> إعادة المحاولة</button></div>:branches?.items.length===0?<div className="co-state co-empty"><span className="co-empty-mark"><MapPin size={26}/></span><h2>لا توجد فروع مسجّلة</h2><p>{canManage?"أضف أول فرع لهذه الجهة.":"لا توجد فروع متاحة ضمن نطاق عضويتك."}</p>{canManage&&<button className="co-button" onClick={()=>setBranchForm(true)}><Plus size={16}/> إضافة فرع</button>}</div>:<div className="co-table-scroll"><table><thead><tr><th>الفرع</th><th>المحافظة</th><th>الاعتماد</th><th>التشغيل</th><th>جهة الاتصال</th><th>الملف والإجراءات</th></tr></thead><tbody>{branches?.items.map(b=><tr key={b.id} data-testid={`branch-row-${b.id}`}><td><span className="co-branch-cell"><span className="co-org-icon"><MapPin size={17}/></span><span><b>{b.name}</b><small dir="ltr">{b.code||"—"}</small></span></span></td><td>{b.governorate||"—"}</td><td><Pill value={b.approval_status} kind="approval"/></td><td><Pill value={b.operational_status} kind="operation"/></td><td>{b.contact_name||b.contact_phone||"—"}</td><td><div className="co-row-actions"><Link href={`/admin/organizations/${encodeURIComponent(id)}/branches/${encodeURIComponent(b.id)}`} className="co-row-link">فتح الملف</Link>{canManage&&<button onClick={()=>{setEditingBranch(b);setBranchForm(true);setError("")}}>تعديل</button>}{b.approval_status==="pending"&&<button onClick={()=>setAction({target:"branch",id:b.id,type:"approve"})}>اعتماد</button>}{b.approval_status==="approved"&&b.operational_status!=="suspended"&&<button className="co-action-danger" onClick={()=>setAction({target:"branch",id:b.id,type:"suspended"})}>إيقاف</button>}{b.approval_status==="approved"&&b.operational_status!=="active"&&<button onClick={()=>setAction({target:"branch",id:b.id,type:"active"})}>إعادة التشغيل</button>}</div></td></tr>)}</tbody></table></div>}
        {branches&&branches.totalPages>1&&<div className="co-pagination"><span>عرض {branches.items.length} من {branches.total} فرعًا</span><div><button disabled={page<=1} onClick={()=>setPage(page-1)}>السابق</button><b>{branches.page} / {branches.totalPages}</b><button disabled={page>=branches.totalPages} onClick={()=>setPage(page+1)}>التالي</button></div></div>}
      </section>}
      {adminTab==="users"&&<OrganizationMembersPanel organizationId={id}/>}
      {adminTab==="fleet"&&org.kind==="company"&&<OrganizationFleetPanel organizationId={id}/>}
      {adminTab==="subscriptions"&&(org.kind==="company"||org.kind==="provider")&&<OrganizationBillingPanel organizationId={id}/>}
      {adminTab==="finance"&&org.kind==="company"&&<OrganizationFinancePanel organizationId={id}/>}
      {adminTab==="records"&&<OrganizationRecords organizationId={id} canManage={canManage} canManageBank={canManageBank} managedBranchIds={managedBranchIds}/>}
      {action&&<div className="co-modal-backdrop" role="presentation"><section className="co-modal" role="dialog" aria-modal="true" aria-labelledby="co-action-title"><button className="co-icon-button co-modal-close" onClick={()=>setAction(null)} aria-label="إغلاق"><X size={18}/></button><span className="co-modal-mark"><ShieldCheck size={22}/></span><h2 id="co-action-title">{action.type==="approve"?"اعتماد "+(action.target==="org"?"الجهة":"الفرع"):action.type==="suspended"?"إيقاف التشغيل":"إعادة التشغيل"}</h2><p>سجّل سبب الإجراء. سيُحفظ السبب ضمن سجل التدقيق.</p><form onSubmit={runAction}><label>سبب الإجراء<textarea name="reason" required minLength={5} maxLength={500} rows={4} placeholder="اكتب سببًا واضحًا لا يقل عن خمسة أحرف" autoFocus/></label>{error&&<Toast error>{error}</Toast>}<div className="co-form-actions"><button className="co-button" disabled={approve.isPending||orgStatus.isPending||approveBranch.isPending||branchStatus.isPending}>{approve.isPending||orgStatus.isPending||approveBranch.isPending||branchStatus.isPending?"جارٍ التنفيذ…":"تأكيد الإجراء"}</button><button type="button" className="co-button co-secondary" onClick={()=>setAction(null)}>إلغاء</button></div></form></section></div>}
    </section>;
  }
  return <section className="co-content">
    {!adminMode&&<Link className="co-back" href="/workspace"><ArrowRight size={16}/> العودة إلى مساحة العمل</Link>}
    {!adminMode&&membershipQ.isLoading&&<div className="co-membership-check">جارٍ التحقق من نطاق عضويتك…</div>}
    {!adminMode&&membershipQ.isError&&<div className="co-state"><CircleAlert/><h2>تعذر التحقق من العضوية</h2><p>{apiError(membershipQ.error)}</p><button className="co-button co-secondary" onClick={()=>void membershipQ.refetch()}><RefreshCw size={16}/> إعادة المحاولة</button></div>}
    {!adminMode&&!membershipQ.isLoading&&!membershipQ.isError&&!canManage&&<div className="co-readonly-note"><ShieldCheck size={16}/> عرض فقط بحسب صلاحيات العضوية. لا يمكن تعديل بيانات الجهة أو فروعها.</div>}
    <section className="co-detail-hero"><div className="co-detail-symbol"><Building2 size={27}/></div><div className="co-detail-title"><span className="co-eyebrow">{kindLabels[org.kind]} <i/> مصر · الجنيه المصري</span><h1>{org.name}</h1><div className="co-code"><span>كود الجهة</span><b dir="ltr">{org.code||"غير مسجل"}</b></div></div><div className="co-detail-status"><Pill value={org.approval_status} kind="approval"/><Pill value={org.operational_status} kind="operation"/></div><div className="co-detail-buttons">{canManage&&<button className="co-button co-secondary" onClick={()=>{setEditOrg(!editOrg);setError("")}}>تعديل البيانات</button>}{adminMode&&org.approval_status==="pending"&&<button className="co-button" onClick={()=>{setAction({target:"org",id,type:"approve"});setError("")}}>اعتماد الجهة</button>}{adminMode&&org.approval_status==="approved"&&org.operational_status!=="suspended"&&<button className="co-button co-danger" onClick={()=>{setAction({target:"org",id,type:"suspended"});setError("")}}>إيقاف التشغيل</button>}{adminMode&&org.approval_status==="approved"&&org.operational_status!=="active"&&<button className="co-button" onClick={()=>{setAction({target:"org",id,type:"active"});setError("")}}>إعادة التشغيل</button>}</div></section>
    {notice&&<Toast>{notice}</Toast>}{error&&<Toast error>{error}</Toast>}
    {adminMode&&<section className="co-linked-records" aria-label="السجلات المرتبطة بالجهة">
      {org.kind==="company"&&<Link href={`/admin/fleet/companies/${encodeURIComponent(id)}`}><Truck size={17}/><span><b>الأسطول والتغطية</b><small>المركبات والفروع المسجلة لهذه الشركة</small></span><ChevronLeft size={16}/></Link>}
      {(org.kind==="company"||org.kind==="provider")&&<Link href={`/admin/subscriptions?organizationId=${encodeURIComponent(id)}`}><ShieldCheck size={17}/><span><b>الطلبات والاشتراكات</b><small>سجلات الجهة ونسخ شروطها المحفوظة</small></span><ChevronLeft size={16}/></Link>}
    {org.kind==="company"&&<Link href={`/admin/finance?section=accounts&search=${encodeURIComponent(org.code??org.name)}`}><Wallet size={17}/><span><b>الحسابات المالية</b><small>دفتر التمويل باسم الجهة ورمزها</small></span><ChevronLeft size={16}/></Link>}
      {org.kind==="station"&&<div className="co-linked-note"><ShieldCheck size={17}/><span><b>المحطة مجانية</b><small>لا توجد باقة مدفوعة أو عمولة محطة.</small></span></div>}
      {org.kind==="provider"&&<div className="co-linked-note"><ShieldCheck size={17}/><span><b>مقدم خدمات</b><small>تُدار اشتراكاته حسب الفروع؛ لا يتضمن هذا الملف خدمة وقود.</small></span></div>}
    </section>}
    {editOrg&&canManage&&<form className="co-form-card" onSubmit={saveOrg}><div className="co-form-heading"><div><span className="co-eyebrow">تحديث السجل</span><h2>بيانات الجهة</h2></div><button type="button" className="co-icon-button" onClick={()=>setEditOrg(false)} aria-label="إغلاق"><X size={18}/></button></div><div className="co-fields">
      <label>الاسم التجاري<input name="name" required defaultValue={org.name}/></label><label>الكود الفريد<input name="code" required pattern="[A-Za-z0-9_-]+" dir="ltr" defaultValue={org.code??""}/></label><label>النوع<select name="kind" defaultValue={org.kind}><option value="company">شركة</option><option value="station">محطة وقود</option><option value="provider">مقدّم خدمة</option></select></label><label>الاسم القانوني<input name="legalName" defaultValue={org.legal_name??""}/></label><label>مسؤول التواصل<input name="contactName" defaultValue={org.contact_name??""}/></label><label>الهاتف<input name="contactPhone" dir="ltr" defaultValue={org.contact_phone??""}/></label><label>البريد الإلكتروني<input name="contactEmail" type="email" dir="ltr" defaultValue={org.contact_email??""}/></label><label className="co-field-wide">العنوان<input name="address" required defaultValue={org.address}/></label>
    </div><label className="co-audit-reason">سبب التعديل (5–500 حرف)<textarea name="reason" required minLength={5} maxLength={500} rows={3} placeholder="اشرح سبب تحديث بيانات الجهة"/></label><p className="co-version-note">نسخة السجل الحالية: {org.version} · يتحقق الخادم من عدم وجود تعديل أحدث.</p><div className="co-form-actions"><button className="co-button" disabled={edit.isPending}>{edit.isPending?"جارٍ الحفظ…":"حفظ التعديلات"}</button><button className="co-button co-secondary" type="button" onClick={()=>setEditOrg(false)}>إلغاء</button></div></form>}
    <section className="co-info-grid"><article className="co-info-card"><span>الاسم القانوني</span><b>{org.legal_name||"غير مسجل"}</b></article><article className="co-info-card"><span>مسؤول التواصل</span><b>{org.contact_name||"غير مسجل"}</b></article><article className="co-info-card"><span>رقم الهاتف</span><b dir="ltr">{org.contact_phone||"غير مسجل"}</b></article><article className="co-info-card"><span>البريد الإلكتروني</span><b dir="ltr">{org.contact_email||"غير مسجل"}</b></article><article className="co-info-card co-address"><span>العنوان</span><b><MapPin size={15}/>{org.address||"غير مسجل"}</b></article></section>
    <section className="co-branches-section"><div className="co-branches-head"><div><span className="co-eyebrow">البنية التشغيلية</span><h2>الفروع <small>{branches?.total??"—"}</small></h2><p>كل فرع يتبع هذه الجهة ولا يمكن تغيير ارتباطه.</p></div>{canManage&&<button className="co-button" onClick={()=>{setEditingBranch(null);setBranchForm(!branchForm);setError("")}}><Plus size={17}/>{branchForm?"إغلاق":"إضافة فرع"}</button>}</div>
      {branchForm&&<form className="co-form-card" onSubmit={saveBranch}><div className="co-form-heading"><div><span className="co-eyebrow">{editingBranch?"تحديث بيانات":"فرع جديد"}</span><h2>{editingBranch?editingBranch.name:"إضافة فرع إلى "+org.name}</h2></div><button type="button" className="co-icon-button" onClick={()=>{setBranchForm(false);setEditingBranch(null)}} aria-label="إغلاق"><X size={18}/></button></div><div className="co-fields"><label>اسم الفرع<input name="name" required defaultValue={editingBranch?.name}/></label><label>الكود الفريد<input name="code" required minLength={2} maxLength={40} pattern="[A-Za-z0-9_-]+" dir="ltr" defaultValue={editingBranch?.code??""}/></label><label>المحافظة<input name="governorate" defaultValue={editingBranch?.governorate??""}/></label><label className="co-field-wide">العنوان<input name="address" required defaultValue={editingBranch?.address}/></label><label>خط العرض<input name="latitude" type="number" step="any" min="-90" max="90" dir="ltr" defaultValue={editingBranch?.latitude??""}/></label><label>خط الطول<input name="longitude" type="number" step="any" min="-180" max="180" dir="ltr" defaultValue={editingBranch?.longitude??""}/></label><label>مسؤول الفرع<input name="contactName" defaultValue={editingBranch?.contact_name??""}/></label><label>هاتف الفرع<input name="contactPhone" dir="ltr" defaultValue={editingBranch?.contact_phone??""}/></label></div><fieldset className="co-hours"><legend>ساعات العمل حسب اليوم</legend>{weekdays.map(([key,label])=>{const day=editingBranch?.hours?.[key];return <div key={key}><b>{label}</b><label className="co-closed"><input type="checkbox" name={`${key}_closed`} defaultChecked={day?.closed??false}/> مغلق</label><label>يفتح<input name={`${key}_open`} type="time" required={!day?.closed} defaultValue={day?.open??""}/></label><label>يغلق<input name={`${key}_close`} type="time" required={!day?.closed} defaultValue={day?.close??""}/></label></div>})}</fieldset>{editingBranch&&<label className="co-audit-reason">سبب التعديل (5–500 حرف)<textarea name="reason" required minLength={5} maxLength={500} rows={3} placeholder="اشرح سبب تحديث بيانات الفرع"/></label>}<p className="co-version-note">الجهة المرتبطة: <b>{org.name}</b> · لا يمكن تعديلها من نموذج الفرع.</p><div className="co-form-actions"><button className="co-button" disabled={createBranch.isPending||updateBranch.isPending}>{createBranch.isPending||updateBranch.isPending?"جارٍ الحفظ…":"حفظ الفرع"}</button><button className="co-button co-secondary" type="button" onClick={()=>{setBranchForm(false);setEditingBranch(null)}}>إلغاء</button></div></form>}
      <div className="co-filterbar co-branch-filters"><div className="co-search"><Search size={16}/><input value={search} onChange={e=>{setPage(1);setSearch(e.target.value)}} placeholder="ابحث باسم الفرع أو الكود" aria-label="ابحث عن فرع"/></div><label>الاعتماد<select value={approval} onChange={e=>{setPage(1);setApproval(e.target.value)}}><option value="">كل حالات الاعتماد</option><option value="pending">بانتظار الاعتماد</option><option value="approved">معتمدة</option></select></label><label>التشغيل<select value={operation} onChange={e=>{setPage(1);setOperation(e.target.value)}}><option value="">كل الحالات</option><option value="inactive">غير مفعّلة</option><option value="active">تعمل</option><option value="suspended">موقوفة</option></select></label><label>ترتيب حسب<select value={sortBy} onChange={e=>setSortBy(e.target.value as NonNullable<ListBranchesPaginatedParams["sortBy"]>)}><option value="createdAt">تاريخ الإضافة</option><option value="name">الاسم</option><option value="code">الكود</option><option value="approvalStatus">الاعتماد</option><option value="operationalStatus">التشغيل</option></select></label><button className="co-sort" onClick={()=>setSortDirection(sortDirection==="asc"?"desc":"asc")}>{sortDirection==="asc"?"تصاعدي ↑":"تنازلي ↓"}</button></div>
      {branchesQ.isLoading?<LoadingRows/>:branchesQ.isError?<div className="co-state"><CircleAlert/><h2>تعذر تحميل الفروع</h2><p>{apiError(branchesQ.error)}</p><button className="co-button co-secondary" onClick={()=>void branchesQ.refetch()}><RefreshCw size={16}/> إعادة المحاولة</button></div>:branches?.items.length===0?<div className="co-state co-empty"><span className="co-empty-mark"><MapPin size={26}/></span><h2>لا توجد فروع مسجّلة</h2><p>{canManage?"أضف أول فرع لهذه الجهة.":"لا توجد فروع متاحة ضمن نطاق عضويتك."}</p>{canManage&&<button className="co-button" onClick={()=>setBranchForm(true)}><Plus size={16}/> إضافة فرع</button>}</div>:<div className="co-table-scroll"><table><thead><tr><th>الفرع</th><th>المحافظة</th><th>الاعتماد</th><th>التشغيل</th><th>جهة الاتصال</th><th><span className="sr-only">الإجراءات</span></th></tr></thead><tbody>{branches?.items.map(b=><tr key={b.id} data-testid={`branch-row-${b.id}`}><td><span className="co-branch-cell"><span className="co-org-icon"><MapPin size={17}/></span><span><b>{b.name}</b><small dir="ltr">{b.code||"—"}</small></span></span></td><td>{b.governorate||"—"}</td><td><Pill value={b.approval_status} kind="approval"/></td><td><Pill value={b.operational_status} kind="operation"/></td><td>{b.contact_name||b.contact_phone||"—"}</td><td>{canManage&&<div className="co-row-actions"><button onClick={()=>{setEditingBranch(b);setBranchForm(true);setError("")}}>تعديل</button>{adminMode&&b.approval_status==="pending"&&<button onClick={()=>setAction({target:"branch",id:b.id,type:"approve"})}>اعتماد</button>}{adminMode&&b.approval_status==="approved"&&b.operational_status!=="suspended"&&<button className="co-action-danger" onClick={()=>setAction({target:"branch",id:b.id,type:"suspended"})}>إيقاف</button>}{adminMode&&b.approval_status==="approved"&&b.operational_status!=="active"&&<button onClick={()=>setAction({target:"branch",id:b.id,type:"active"})}>إعادة التشغيل</button>}</div>}</td></tr>)}</tbody></table></div>}
      {branches&&branches.totalPages>1&&<div className="co-pagination"><span>عرض {branches.items.length} من {branches.total} فرعًا</span><div><button disabled={page<=1} onClick={()=>setPage(page-1)}>السابق</button><b>{branches.page} / {branches.totalPages}</b><button disabled={page>=branches.totalPages} onClick={()=>setPage(page+1)}>التالي</button></div></div>}
    </section>
    <OrganizationRecords organizationId={id} canManage={canManage} canManageBank={canManageBank} managedBranchIds={managedBranchIds}/>
    {adminMode&&action&&<div className="co-modal-backdrop" role="presentation"><section className="co-modal" role="dialog" aria-modal="true" aria-labelledby="co-action-title"><button className="co-icon-button co-modal-close" onClick={()=>setAction(null)} aria-label="إغلاق"><X size={18}/></button><span className="co-modal-mark"><ShieldCheck size={22}/></span><h2 id="co-action-title">{action.type==="approve"?"اعتماد "+(action.target==="org"?"الجهة":"الفرع"):action.type==="suspended"?"إيقاف التشغيل":"إعادة التشغيل"}</h2><p>سجّل سبب الإجراء. سيُحفظ السبب ضمن سجل التدقيق.</p><form onSubmit={runAction}><label>سبب الإجراء<textarea name="reason" required minLength={5} maxLength={500} rows={4} placeholder="اكتب سببًا واضحًا لا يقل عن خمسة أحرف" autoFocus/></label>{error&&<Toast error>{error}</Toast>}<div className="co-form-actions"><button className="co-button" disabled={approve.isPending||orgStatus.isPending||approveBranch.isPending||branchStatus.isPending}>{approve.isPending||orgStatus.isPending||approveBranch.isPending||branchStatus.isPending?"جارٍ التنفيذ…":"تأكيد الإجراء"}</button><button type="button" className="co-button co-secondary" onClick={()=>setAction(null)}>إلغاء</button></div></form></section></div>}
    {adminMode&&<section className="co-memberships" aria-labelledby="co-memberships-heading">
      <div className="co-branches-head"><div><span className="co-eyebrow">عضويات الجهة</span><h2 id="co-memberships-heading">المستخدمون والنطاقات <small>{membershipQ.data?.items.length??"—"}</small></h2><p>الدور ونطاق الفروع مستقلان عن أدوار المنصة.</p></div></div>
      {membershipQ.isLoading?<LoadingRows/>:membershipQ.isError?<div className="co-state"><CircleAlert/><h2>تعذر تحميل عضويات الجهة</h2><p>{apiError(membershipQ.error)}</p><button className="co-button co-secondary" onClick={()=>void membershipQ.refetch()}><RefreshCw size={16}/> إعادة المحاولة</button></div>:
        membershipQ.data?.items.length?<div className="co-membership-list">{membershipQ.data.items.map(member=>{const assigned=member.branchIds??[];const branchNames=assigned.map(branchId=>branchNameById.get(branchId)).filter((name):name is string=>Boolean(name));return <article key={member.id}><div><b>{member.profile?.display_name??"مستخدم الجهة"}</b>{member.profile?.username&&<small dir="ltr">@{member.profile.username}</small>}</div><span>{member.role==="organization_owner"?"مالك الجهة":member.role==="manager"?"مدير":member.role==="finance"?"المالية":member.role==="worker"?"موظف":"مشاهد"}</span><span>{member.scope==="organization"?"نطاق الجهة بالكامل":`نطاق ${assigned.length.toLocaleString("ar-EG")} فرع`}</span><span>{member.scope==="organization"?"كل الفروع":branchNames.length?branchNames.join("، "):"أسماء الفروع غير متاحة في هذه الصفحة"}</span><Pill value={member.active?"active":"suspended"} kind="operation"/></article>})}</div>:<div className="co-state co-empty"><Users size={22}/><h2>لا توجد عضويات مسجلة</h2><p>لا توجد حسابات مرتبطة بهذه الجهة في السجل الحالي.</p></div>}
    </section>}
  </section>;
}

export function AdminOrganizationBranchPage() {
  const [matched, params] = useRoute("/admin/organizations/:organizationId/branches/:branchId");
  const organizationId = params?.organizationId ?? "";
  const branchId = params?.branchId ?? "";
  const branchQuery = useGetAdminOrganizationBranch(organizationId, branchId, {
    query: {
      queryKey: getGetAdminOrganizationBranchQueryKey(organizationId, branchId),
      enabled: matched && Boolean(organizationId && branchId),
      retry: false,
    },
  });
  const organizationQuery = useGetOrganization(organizationId, {
    query: { queryKey: getGetOrganizationQueryKey(organizationId), enabled: matched && Boolean(organizationId), retry: false },
  });
  const [memberPage, setMemberPage] = useState(1);
  const memberParams = { organizationId, page: memberPage, pageSize: 10 };
  const memberQuery = useListAdminOrganizationMemberships(memberParams, {
    query: { queryKey: getListAdminOrganizationMembershipsQueryKey(memberParams), enabled: matched && Boolean(organizationId), retry: false },
  });
  const financeParams = { organizationId, page: 1, pageSize: 100 };
  const financeQuery = useGetAdminOrganizationFinanceAccounts(financeParams, {
    query: {
      queryKey: getGetAdminOrganizationFinanceAccountsQueryKey(financeParams),
      enabled: matched && organizationQuery.data?.kind === "company",
      retry: false,
    },
  });
  if (!matched) return <section className="co-content"><div className="co-state"><h1>تعذر تحديد الفرع</h1><p>افتح ملف الفرع من قائمة فروع الجهة.</p><Link className="co-button" href="/admin/organizations">العودة إلى الجهات</Link></div></section>;
  if (branchQuery.isLoading) return <section className="co-content"><LoadingRows/></section>;
  if (branchQuery.isError || !branchQuery.data?.branch) return <section className="co-content"><div className="co-state"><CircleAlert/><h1>تعذر تحميل ملف الفرع</h1><p>تحقق من صلاحيتك أو أعد تحميل بيانات الفرع.</p><button className="co-button co-secondary" onClick={()=>void branchQuery.refetch()}><RefreshCw size={16}/> إعادة المحاولة</button></div></section>;
  const branch = branchQuery.data.branch as Branch;
  const organizationKind = organizationQuery.data?.kind;
  const membershipRows = memberQuery.data?.items ?? [];
  const branchMembers = membershipRows.filter((row) => {
    const member = row as Record<string, unknown>;
    if (member["scope"] === "organization") return true;
    const branches = Array.isArray(member["branches"]) ? member["branches"] as Array<Record<string, unknown>> : [];
    return branches.some((item) => item["branchId"] === branch.id);
  });
  const accountRows = Array.isArray(financeQuery.data?.["items"])
    ? (financeQuery.data["items"] as Array<Record<string, unknown>>).filter((row) => row["branchId"] === branch.id)
    : [];
  const account = accountRows[0];
  const minor = (value: unknown) => {
    const raw = typeof value === "number" ? String(value) : value;
    if (typeof raw !== "string" || !/^-?\d+$/.test(raw)) return "غير متاح";
    const amount = BigInt(raw);
    const absolute = amount < 0n ? -amount : amount;
    const fraction = Number(absolute % 100n);
    return `${amount < 0n ? "−" : ""}${new Intl.NumberFormat("ar-EG").format(absolute / 100n)}${fraction ? `٫${new Intl.NumberFormat("ar-EG",{minimumIntegerDigits:2}).format(fraction)}` : ""} جنيه`;
  };
  return <section className="co-content co-branch-profile">
    <nav className="co-entity-breadcrumb" aria-label="مسار الصفحة"><Link href="/admin/organizations">الجهات</Link><ChevronLeft size={15}/><Link href={`/admin/organizations/${encodeURIComponent(organizationId)}?section=branches`}>{organizationQuery.data?.name??"ملف الجهة"}</Link><ChevronLeft size={15}/><span>{branch.name}</span></nav>
    <header className="co-entity-header">
      <div className="co-detail-symbol"><MapPin size={24}/></div>
      <div className="co-entity-title"><span className="co-eyebrow">فرع · {branch.code||"بدون كود"}</span><h1>{branch.name}</h1><p>{organizationQuery.data?.name??"الجهة المرتبطة"}</p></div>
      <div className="co-detail-status"><Pill value={branch.approval_status} kind="approval"/><Pill value={branch.operational_status} kind="operation"/></div>
      {organizationKind==="company"&&<Link className="co-button" href={`/admin/fleet/companies/${encodeURIComponent(organizationId)}/branches/${encodeURIComponent(branch.id)}`}><Truck size={16}/> مركبات الفرع</Link>}
    </header>
    <div className="co-branch-profile-grid">
      <article><span>العنوان</span><strong>{branch.address||"غير مسجل"}</strong></article>
      <article><span>المحافظة</span><strong>{branch.governorate||"غير مسجلة"}</strong></article>
      <article><span>مسؤول الفرع</span><strong>{branch.contact_name||"غير مسجل"}</strong></article>
      <article><span>هاتف الفرع</span><strong dir="ltr">{branch.contact_phone||"غير مسجل"}</strong></article>
      <article><span>الفروع لا تحمل تمويلًا مستقلًا عن الشركة</span><strong>{organizationKind==="company"?(financeQuery.isLoading?"جارٍ التحقق":financeQuery.isError?"تعذر تحميل كشف الحساب":account?`المتاح ${minor(account["availableMinor"])} · المحجوز ${minor(account["reservedMinor"])}`:"لا يوجد حساب فرعي مسجل"):"لا ينطبق حساب تمويل الشركة على هذا النوع."}</strong></article>
    </div>
    {organizationKind==="company"&&<section className="co-profile-panel">
      <div className="co-profile-section-title"><div><h2>مستخدمو الفرع</h2><p>العضويات المحصورة بهذا الفرع، إضافة إلى عضويات نطاق الجهة.</p></div></div>
      {memberQuery.isLoading?<LoadingRows/>:memberQuery.isError?<div className="co-data-state co-data-state-error" role="alert">تعذر تحميل عضويات الفرع.</div>:branchMembers.length===0?<div className="co-data-state">لا توجد عضويات ظاهرة في هذه الصفحة لهذا الفرع.</div>:<div className="co-membership-list">{branchMembers.map((item,index)=>{const member=item as Record<string,unknown>;const profile=(member["profile"]&&typeof member["profile"]==="object"?member["profile"]:{}) as Record<string,unknown>;const username=typeof profile["username"]==="string"?profile["username"]:"";return <article key={String(member["id"]??index)}><div><b>{String(profile["display_name"]??"مستخدم الجهة")}</b>{username&&<small dir="ltr">@{username}</small>}</div><span>{String(member["role"]??"")}</span><span>{member["scope"]==="organization"?"كل فروع الجهة":branch.name}</span><span>{member["active"]===true?"نشط":"موقوف"}</span><Link href={`/admin/platform-users/${encodeURIComponent(String(member["userId"]??""))}`}>ملف المستخدم</Link></article>})}</div>}
      {memberQuery.data&&memberQuery.data.totalPages>1&&<div className="co-pagination"><span>عضويات الجهة: {memberQuery.data.total}</span><div><button disabled={memberPage<=1} onClick={()=>setMemberPage(memberPage-1)}>السابق</button><b>{memberQuery.data.page} / {memberQuery.data.totalPages}</b><button disabled={memberPage>=memberQuery.data.totalPages} onClick={()=>setMemberPage(memberPage+1)}>التالي</button></div></div>}
    </section>}
    <div className="co-branch-profile-actions"><Link className="co-button co-secondary" href={`/admin/organizations/${encodeURIComponent(organizationId)}?section=branches`}><ArrowRight size={16}/> العودة إلى الجهة والفروع</Link></div>
  </section>;
}
