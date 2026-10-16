import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ArrowLeft, Building2, CircleAlert, CircleCheck, Clock3, FileText, Landmark, LockKeyhole, MapPin, RefreshCw, ShieldCheck, Upload, X } from "lucide-react";
import {
  createOrganizationJoinRequest, updateOrganizationJoinRequest, submitOrganizationJoinRequest, withdrawOrganizationJoinRequest,
  decideAdminOrganizationRequest, createOrganizationChangeRequest, resubmitOrganizationChangeRequest, withdrawOrganizationChangeRequest,
  proposeOrganizationBankAccount, withdrawOrganizationBankAccountVersion, createDocumentUploadIntent, uploadOrganizationDocumentContent,
  useGetAuthMe, useListOrganizationJoinRequests, useGetOrganizationJoinRequest, useListAdminOrganizationRequests,
  useListOrganizationChangeRequests, useListOrganizationBankAccounts, useGetOrganizationBankAccountVersionDetails,
  useListOrganizationDocuments, useListOrganizationJoinRequestDocuments, useCreateOrganizationDocumentDownload, useListBranches, useGetOrganization,
  getListOrganizationJoinRequestsQueryKey, getGetOrganizationJoinRequestQueryKey, getListAdminOrganizationRequestsQueryKey,
  getListOrganizationChangeRequestsQueryKey, getListOrganizationBankAccountsQueryKey, getGetOrganizationBankAccountVersionDetailsQueryKey,
  getListOrganizationDocumentsQueryKey, getListOrganizationJoinRequestDocumentsQueryKey, getGetAuthMeQueryKey, getCreateOrganizationDocumentDownloadQueryKey,
  getListBranchesQueryKey, getGetOrganizationQueryKey,
} from "@workspace/api-client-react";
import type { CreateOrganizationJoinRequest, OrganizationJoinRequest, AdminOrganizationRequest, PlatformRole } from "@workspace/api-client-react";
import { AdminShell } from "./AdminCentral";

const labels: Record<string,string> = {
  draft:"مسودة", submitted:"قيد المراجعة", needs_completion:"تحتاج استكمالًا", approved:"معتمد",
  rejected:"مرفوض", withdrawn:"مسحوب", pending:"قيد المراجعة", pending_upload:"بانتظار الرفع",
  pending_review:"بانتظار المراجعة", superseded:"نسخة سابقة", conflict:"تعارض إصدار",
  upload_failed:"تعذر الرفع", organization:"بيانات الجهة", branch:"بيانات الفرع",
  join:"انضمام جهة", change:"تعديل بيانات", bank:"حساب بنكي", document:"مستند", attached:"مرفق بالطلب",
};
const kinds: Record<string,string> = {company:"شركة",station:"محطة",provider:"مقدّم خدمة"};
const errorMessage=(e:unknown)=>{const x=e as {status?:number;message?:string;data?:{message?:string}};return x?.status===409?"تغيّرت النسخة منذ فتح السجل. حدّث البيانات ثم أعد المحاولة.":x?.status===403?"لا تملك صلاحية تنفيذ هذا الإجراء.":x?.data?.message||x?.message||"تعذر إتمام العملية. حاول مرة أخرى.";};
const field=(o:unknown,k:string)=>o&&typeof o==="object"?(o as Record<string,unknown>)[k]:undefined;
function Pill({value}:{value:string}){return <span className={`ow-pill ow-${value}`}>{labels[value]??value}</span>}
function Alert({error,children}:{error?:boolean;children:string}){return <div className={error?"ow-alert":"ow-success"} role={error?"alert":"status"}>{error?<CircleAlert size={17}/>:<CircleCheck size={17}/>}<span>{children}</span></div>}
function Loading(){return <div className="ow-loading" aria-label="جارٍ تحميل السجلات"><i/><i/><i/></div>}
const days:[string,string][]=[["sun","الأحد"],["mon","الاثنين"],["tue","الثلاثاء"],["wed","الأربعاء"],["thu","الخميس"],["fri","الجمعة"],["sat","السبت"]];
function joinPayload(d:FormData):CreateOrganizationJoinRequest {
  const hours=Object.fromEntries(days.map(([day])=>[day,{closed:d.get(`${day}_closed`)==="on",...(d.get(`${day}_closed`)==="on"?{}:{open:String(d.get(`${day}_open`)),close:String(d.get(`${day}_close`))})}]));
  return {
    organization:{name:String(d.get("name")).trim(),kind:String(d.get("kind")) as "company"|"station"|"provider",code:String(d.get("code")).trim(),legalName:String(d.get("legalName")).trim()||null,contactName:String(d.get("contactName")).trim()||null,contactPhone:String(d.get("contactPhone")).trim()||null,contactEmail:String(d.get("contactEmail")).trim()||null,address:String(d.get("address")).trim()},
    initialBranch:{code:String(d.get("branchCode")).trim(),name:String(d.get("branchName")).trim(),address:String(d.get("branchAddress")).trim(),governorate:String(d.get("governorate")).trim()||null,latitude:String(d.get("latitude")).trim()?Number(d.get("latitude")):null,longitude:String(d.get("longitude")).trim()?Number(d.get("longitude")):null,hours,contactName:String(d.get("branchContactName")).trim()||null,contactPhone:String(d.get("branchContactPhone")).trim()||null}
  };
}
function JoinForm({request,centralMode=false,onClose,onSaved}:{request?:OrganizationJoinRequest;centralMode?:boolean;onClose:()=>void;onSaved:()=>Promise<void>}) {
  const [problem,setProblem]=useState(""); const [notice,setNotice]=useState(""); const [working,setWorking]=useState(false); const [targetUsername,setTargetUsername]=useState(""); const submitLock=useRef(false); const saveIntent=useRef<"draft"|"submit">("draft");
  const [draftId,setDraftId]=useState<string>(); const [draftVersion,setDraftVersion]=useState<number>(); const [uploadedFiles,setUploadedFiles]=useState<Set<string>>(()=>new Set());
  const create=useMutation({mutationFn:(data:CreateOrganizationJoinRequest)=>createOrganizationJoinRequest(data)}); const update=useMutation({mutationFn:({id,data}: {id:string;data:Parameters<typeof updateOrganizationJoinRequest>[1]})=>updateOrganizationJoinRequest(id,data)});
  const send=useMutation({mutationFn:({id,version}: {id:string;version:number})=>submitOrganizationJoinRequest(id,{expectedVersion:version})});
  const org=(request?.organization_data??{}) as Record<string,unknown>, branch=(request?.initial_branch_data??{}) as Record<string,unknown>;
  const hours=(branch.hours??{}) as Record<string,{closed?:boolean;open?:string;close?:string}>;
  async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();if(submitLock.current)return;const intent=saveIntent.current;saveIntent.current="draft";submitLock.current=true;setWorking(true);setProblem("");setNotice("");const form=e.currentTarget,data=new FormData(form),payload=joinPayload(data);let id=request?.id??draftId;try{
    if(id){
      const current=await import("@workspace/api-client-react").then(m=>m.getOrganizationJoinRequest(id!));
      if(current.status==="submitted"||current.status==="approved"){setNotice("تم إرسال هذا الطلب بالفعل.");await onSaved();onClose();return;}
      if(current.status!=="draft"&&current.status!=="needs_completion")throw new Error("لا يمكن تعديل الطلب في حالته الحالية.");
      await update.mutateAsync({id,data:{expectedVersion:draftVersion??request?.version??current.version,...payload}});
    }
    else {const created=await create.mutateAsync(centralMode?{...payload,applicantUsername:targetUsername.trim().toLowerCase()}:payload);id=created.id;if(id){setDraftId(id);setDraftVersion(1);}}
    if(!id)throw new Error("لم يُرجع الخادم معرّف الطلب.");
    const files=data.getAll("supportingDocuments").filter((entry):entry is File=>entry instanceof File&&entry.size>0);
    const documentType=String(data.get("supportingDocumentType")??"").trim();
    if(files.length&&!documentType)throw new Error("اكتب نوع المستند المرفق.");
    const completed=new Set(uploadedFiles);
    for(const file of files){
      const key=`${file.name}|${file.size}|${file.lastModified}`;
      if(completed.has(key))continue;
      const contentType=file.type as "application/pdf"|"image/png"|"image/jpeg";
      if(file.size>10485760||!["application/pdf","image/png","image/jpeg"].includes(contentType))throw new Error("المرفقات تقبل PDF أو PNG أو JPEG وبحد أقصى 10 ميغابايت لكل ملف.");
      const intent=await createDocumentUploadIntent({contextType:"join_request",contextId:id,documentType,fileName:file.name.slice(0,160),contentType,byteSize:file.size});
      await uploadOrganizationDocumentContent(intent.id,file);
      completed.add(key);setUploadedFiles(new Set(completed));
    }
    const details=await import("@workspace/api-client-react").then(m=>m.getOrganizationJoinRequest(id!));setDraftVersion(details.version);
    if(intent==="draft"){setNotice("تم حفظ المسودة. لم تُرسل للمراجعة ولم تُنشأ جهة أو عضوية.");await onSaved();return;}
    await send.mutateAsync({id,version:details.version});
    setNotice("تم إرسال طلب الانضمام والمرفقات للمراجعة.");await onSaved();onClose();
  }catch(err){setProblem(errorMessage(err));if(id)await onSaved();}finally{submitLock.current=false;setWorking(false);}}
  const busy=working||create.isPending||update.isPending||send.isPending;
  return <section className="ow-form-card" aria-labelledby="ow-join-title">
    <header className="ow-card-head"><div><span className="ow-eyebrow">طلب انضمام جهة</span><h2 id="ow-join-title">{request?"استكمال بيانات الطلب":"تسجيل جهة وفَرع أولي"}</h2><p>أدخل البيانات كما هي في سجلاتكم. سيظل الطلب خاضعًا للمراجعة.</p></div><button type="button" className="ow-icon" onClick={onClose} aria-label="إغلاق"><X size={18}/></button></header>
    <form onSubmit={submit}>{centralMode&&<div className="ow-central-applicant"><label>اسم مستخدم صاحب الطلب<input name="applicantUsername" value={targetUsername} onChange={e=>setTargetUsername(e.target.value)} minLength={3} maxLength={64} autoComplete="off" dir="ltr" required disabled={!!draftId}/></label><small>يجب أن يكون الحساب مسجلًا ومؤكد البريد ولا يملك عضوية جهة. لا يُعرض البريد ولا تُرسل رسالة تلقائيًا.</small></div>}<h3><Building2 size={17}/> بيانات الجهة</h3><div className="ow-fields">
      <label>الاسم التجاري<input name="name" required minLength={2} maxLength={160} defaultValue={String(org.name??"")}/></label>
      <label>النوع<select name="kind" defaultValue={String(org.kind??"company")}><option value="company">شركة</option><option value="station">محطة</option><option value="provider">مقدّم خدمة</option></select></label>
      <label>كود الجهة<input name="code" required pattern="[A-Za-z0-9_-]+" minLength={2} maxLength={40} dir="ltr" defaultValue={String(org.code??"")}/></label>
      <label>الاسم القانوني<input name="legalName" maxLength={200} defaultValue={String(org.legalName??"")}/></label>
      <label>مسؤول التواصل<input name="contactName" maxLength={160} defaultValue={String(org.contactName??"")}/></label>
      <label>هاتف التواصل<input name="contactPhone" maxLength={24} dir="ltr" defaultValue={String(org.contactPhone??"")}/></label>
      <label>البريد الإلكتروني<input name="contactEmail" type="email" maxLength={320} dir="ltr" defaultValue={String(org.contactEmail??"")}/></label>
      <label className="ow-wide">عنوان الجهة<input name="address" required maxLength={500} defaultValue={String(org.address??"")}/></label>
    </div><h3><MapPin size={17}/> الفرع الأولي</h3><div className="ow-fields">
      <label>اسم الفرع<input name="branchName" required minLength={2} defaultValue={String(branch.name??"")}/></label><label>كود الفرع<input name="branchCode" required pattern="[A-Za-z0-9_-]+" dir="ltr" defaultValue={String(branch.code??"")}/></label>
      <label>المحافظة<input name="governorate" defaultValue={String(branch.governorate??"")}/></label><label className="ow-wide">العنوان<input name="branchAddress" required defaultValue={String(branch.address??"")}/></label>
      <label>خط العرض<input name="latitude" type="number" step="any" min="-90" max="90" dir="ltr" defaultValue={String(branch.latitude??"")}/></label><label>خط الطول<input name="longitude" type="number" step="any" min="-180" max="180" dir="ltr" defaultValue={String(branch.longitude??"")}/></label>
      <label>مسؤول الفرع<input name="branchContactName" defaultValue={String(branch.contactName??"")}/></label><label>هاتف الفرع<input name="branchContactPhone" dir="ltr" defaultValue={String(branch.contactPhone??"")}/></label>
     </div><fieldset className="ow-hours"><legend>ساعات العمل</legend>{days.map(([key,name])=><div className="ow-day" key={key}><b>{name}</b><label><input type="checkbox" name={`${key}_closed`} defaultChecked={!!hours[key]?.closed}/> مغلق</label><label>يفتح<input name={`${key}_open`} type="time" defaultValue={hours[key]?.open??""}/></label><label>يغلق<input name={`${key}_close`} type="time" defaultValue={hours[key]?.close??""}/></label></div>)}</fieldset>
     <fieldset className="ow-supporting-docs"><legend>مستندات داعمة (اختياري)</legend><div className="ow-fields"><label>نوع المستند<input name="supportingDocumentType" minLength={2} maxLength={80} placeholder="اكتب وصفًا واضحًا"/></label><label className="ow-file-label"><Upload size={16}/> اختر ملفات<input name="supportingDocuments" type="file" multiple accept="application/pdf,image/png,image/jpeg"/></label></div><small>تُحفظ الملفات في المخزن الخاص وترتبط بالطلب؛ لا تُراجع إلا بعد إرساله. الملفات المقبولة PDF أو PNG أو JPEG.</small></fieldset>
    {problem&&<Alert error>{problem}</Alert>}{notice&&<Alert>{notice}</Alert>}<div className="ow-actions"><button className="ow-button ow-quiet" disabled={busy} onClick={()=>{saveIntent.current="draft";}}>{busy?"جارٍ الحفظ…":"حفظ المسودة"}</button><button className="ow-button" disabled={busy} onClick={()=>{saveIntent.current="submit";}}>{busy?"جارٍ الحفظ والإرسال…":"حفظ وإرسال للمراجعة"}</button><button type="button" className="ow-button ow-quiet" onClick={onClose}>إلغاء</button></div></form>
  </section>;
}

export function OrganizationJoinWorkspace() {
  const cache=useQueryClient(), query=useListOrganizationJoinRequests(undefined,{query:{queryKey:getListOrganizationJoinRequestsQueryKey(),refetchOnMount:"always"}});
  const [show,setShow]=useState(false),[selected,setSelected]=useState("");
  const withdraw=useMutation({mutationFn:({id,version}:{id:string;version:number})=>withdrawOrganizationJoinRequest(id,{expectedVersion:version})});
  const items=query.data?.items??[];
  const refresh=async()=>{await cache.invalidateQueries({queryKey:getListOrganizationJoinRequestsQueryKey()});};
  return <section className="ow-workspace" aria-labelledby="ow-workspace-title">
    <div className="ow-section-heading"><div><span className="ow-eyebrow">طلبات الجهات</span><h2 id="ow-workspace-title">الانضمام إلى المنصة</h2><p>قدّم بيانات جهة وفرعها الأولي، ثم تابع حالة المراجعة من هنا.</p></div><button className="ow-button" onClick={()=>{setShow(v=>!v);setSelected("");}}><Building2 size={16}/>{show?"إغلاق النموذج":"طلب انضمام"}</button></div>
    {show&&<JoinForm request={items.find(x=>x.id===selected)} onClose={()=>setShow(false)} onSaved={refresh}/>}
    {query.isLoading?<Loading/>:query.isError?<div className="ow-state"><CircleAlert/><h3>تعذر تحميل سجل الطلبات</h3><p>{errorMessage(query.error)}</p><button className="ow-button ow-quiet" onClick={()=>void query.refetch()}><RefreshCw size={15}/> إعادة المحاولة</button></div>:items.length===0?<div className="ow-empty"><span><Building2 size={22}/></span><div><b>لا توجد طلبات انضمام</b><p>يمكنك حفظ مسودة أو إرسال طلب للمراجعة. لا تُنشأ جهة أو عضوية قبل اعتماد الإدارة.</p></div></div>:<div className="ow-request-list">{items.map(item=><JoinHistoryRow key={item.id} item={item} editing={selected===item.id} onEdit={()=>{setSelected(item.id);setShow(true);}} onWithdraw={async()=>{await withdraw.mutateAsync({id:item.id,version:item.version});await refresh();}} busy={withdraw.isPending}/>)}</div>}
  </section>;
}
function JoinHistoryRow({item,editing,onEdit,onWithdraw,busy}:{item:OrganizationJoinRequest;editing:boolean;onEdit:()=>void;onWithdraw:()=>Promise<void>;busy:boolean}){
  const [error,setError]=useState(""),[showDocs,setShowDocs]=useState(false);
  const detail=useGetOrganizationJoinRequest(item.id,{query:{queryKey:getGetOrganizationJoinRequestQueryKey(item.id),enabled:editing,refetchOnMount:"always"}});
  const docs=useListOrganizationJoinRequestDocuments(item.id,{query:{queryKey:getListOrganizationJoinRequestDocumentsQueryKey(item.id),enabled:showDocs,refetchOnMount:"always"}});
  const org=(item.organization_data??{}) as Record<string,unknown>;
  return <article className="ow-history-row"><div className="ow-record-icon"><FileText size={18}/></div><div className="ow-record-main"><b>{String(org.name??"طلب جهة")}</b><span>{kinds[String(org.kind)]??"جهة"} · نسخة {item.version}</span>{item.decision_reason&&<small>{item.decision_reason}</small>}</div><Pill value={item.status}/><time>{new Date(item.updated_at).toLocaleDateString("ar-EG")}</time>
    {(item.status==="draft"||item.status==="needs_completion")&&<button className="ow-text-action" onClick={onEdit}>{item.status==="draft"?"استكمال وإرسال":"تحديث وإعادة الإرسال"}</button>}
    {["draft","submitted","needs_completion"].includes(item.status)&&<button className="ow-text-action ow-danger-text" disabled={busy} onClick={async()=>{setError("");try{await onWithdraw()}catch(e){setError(errorMessage(e))}}}>سحب</button>}
    <button className="ow-text-action" onClick={()=>setShowDocs(value=>!value)}>{showDocs?"إخفاء الملفات":"المستندات المرفقة"}</button>
    {showDocs&&(docs.isLoading?<Loading/>:docs.isError?<small className="ow-inline-error">{errorMessage(docs.error)}</small>:!(docs.data?.items??[]).length?<small>لا توجد مستندات مرفقة.</small>:<div className="ow-version-list">{docs.data?.items.map(d=><DocumentRow key={d.id} document={d} contextLabel="مرفق بطلب الانضمام"/>)}</div>)}
    {editing&&detail.isError&&<small className="ow-inline-error">{errorMessage(detail.error)}</small>}
    {error&&<small className="ow-inline-error" role="alert">{error}</small>}
  </article>;
}

export function AdminOrganizationInbox(){
  const me=useGetAuthMe({query:{queryKey:getGetAuthMeQueryKey(),retry:false,staleTime:20000}});
  const roles=field(me.data?.accessContext,"platform_roles")??field(me.data?.accessContext,"platformRoles");
  const allowed=Array.isArray(roles)&&roles.some(r=>typeof r==="string"&&["owner","operations","finance"].includes(r.toLowerCase()));
  const [filter,setFilter]=useState(""),[selected,setSelected]=useState<AdminOrganizationRequest|null>(null),[showJoinForm,setShowJoinForm]=useState(false);
  const canInitiateJoin=Array.isArray(roles)&&roles.some(r=>typeof r==="string"&&["owner","operations"].includes(r.toLowerCase()));
  const params=useMemo(()=>({...filter?{requestType:filter as "join"|"change"|"bank"|"document"}:{}}),[filter]);
  const list=useListAdminOrganizationRequests(params,{query:{queryKey:getListAdminOrganizationRequestsQueryKey(params),enabled:!!me.data&&me.data.state==="active"&&allowed,refetchOnMount:"always"}});
  if(me.isLoading)return <div className="ow-admin-shell" dir="rtl"><Loading/></div>;
  if(me.isError||!me.data)return <Guard signedOut title="يلزم تسجيل الدخول" body="سجّل الدخول بحساب مخوّل للوصول إلى صندوق مراجعة الطلبات."/>;
  if(me.data.state!=="active"||!allowed)return <Guard title="هذه المساحة غير متاحة" body="صندوق المراجعة مخصص للمستخدمين ذوي صلاحية الإدارة المركزية." />;
   const roleSource=field(me.data.accessContext,"platform_roles")??field(me.data.accessContext,"platformRoles");
   const userRoles=Array.isArray(roleSource)?roleSource.filter((role):role is PlatformRole=>["owner","operations","finance","support","auditor"].includes(String(role))):[];
   return <AdminShell name={me.data.displayName} userRoles={userRoles}><div className="ow-admin-content"><div className="ow-admin-title"><div><span className="ow-eyebrow">صندوق المراجعة / {me.data.displayName}</span><h1>طلبات الجهات</h1><p>مراجعة الطلبات والتغييرات والمستندات ضمن صلاحيتك.</p></div><div className="ow-admin-actions">{canInitiateJoin&&<button className="ow-button" onClick={()=>setShowJoinForm(value=>!value)}>{showJoinForm?"إغلاق":"بدء طلب نيابةً عن مستخدم"}</button>}<div className="ow-secure-mark"><ShieldCheck size={18}/> وصول مركزي موثّق</div></div></div>
       {showJoinForm&&canInitiateJoin&&<JoinForm centralMode onClose={()=>setShowJoinForm(false)} onSaved={async()=>{await list.refetch();}}/>}
      <div className="ow-filter-tabs" role="group" aria-label="تصفية الطلبات">{[["","الكل"],["join","انضمام"],["change","تعديلات"],["bank","حسابات بنكية"],["document","مستندات"]].map(([v,l])=><button key={v} className={filter===v?"active":""} onClick={()=>setFilter(v)}>{l}</button>)}</div>
      {list.isLoading?<Loading/>:list.isError?<div className="ow-state"><CircleAlert/><h3>تعذر تحميل صندوق المراجعة</h3><p>{errorMessage(list.error)}</p><button className="ow-button" onClick={()=>void list.refetch()}>إعادة المحاولة</button></div>:(list.data?.items??[]).length===0?<div className="ow-empty"><span><ShieldCheck size={22}/></span><div><b>لا توجد طلبات في هذا العرض</b><p>ستظهر السجلات المرسلة هنا بعد وصولها إلى المراجعة.</p></div></div>:<div className="ow-admin-list">{list.data?.items.map(item=><button className="ow-admin-row" key={`${item.requestType}-${item.id}`} onClick={()=>setSelected(item)}><span className="ow-record-icon">{item.requestType==="bank"?<Landmark size={18}/>:item.requestType==="document"?<FileText size={18}/>:<Building2 size={18}/>}</span><span className="ow-record-main"><b>{item.title}</b><small>{labels[item.requestType]??item.requestType} · نسخة {item.version} · {new Date(item.createdAt).toLocaleDateString("ar-EG")}</small></span><Pill value={item.status}/><ArrowLeft size={16}/></button>)}</div>}
     </div>{selected&&<AdminReviewDialog item={selected} onClose={()=>setSelected(null)} onComplete={async()=>{setSelected(null);await list.refetch();}}/>}
   </AdminShell>;
}
function Guard({title,body,signedOut=false}:{title:string;body:string;signedOut?:boolean}){return <main className="ow-guard" dir="rtl"><span><LockKeyhole size={22}/></span><h1>{title}</h1><p>{body}</p><Link href={signedOut?"/sign-in":"/workspace"} className="ow-button">{signedOut?"تسجيل الدخول":"العودة إلى مساحة العمل"}</Link></main>}
function AdminReviewDialog({item,onClose,onComplete}:{item:AdminOrganizationRequest;onClose:()=>void;onComplete:()=>Promise<void>}){
  const [reason,setReason]=useState(""),[action,setAction]=useState<"approve"|"needs_completion"|"reject">("approve"),[error,setError]=useState("");
  const [linkOrganizationId,setLinkOrganizationId]=useState(""),[linkBranchId,setLinkBranchId]=useState(""),[membershipRole,setMembershipRole]=useState("");
  const summary=item.summary??{};
  const expectedAccountVersion=field(summary,"accountVersion");
  const bankDetails=useGetOrganizationBankAccountVersionDetails(item.id,{query:{queryKey:getGetOrganizationBankAccountVersionDetailsQueryKey(item.id),enabled:item.requestType==="bank",retry:false}});
  const decision=useMutation({mutationFn:()=>decideAdminOrganizationRequest(item.requestType,item.id,({
    expectedVersion:item.version,action,reason:reason.trim(),
    ...(item.requestType==="bank"&&Number.isInteger(expectedAccountVersion)?{expectedAccountVersion}:{}),
    ...(item.requestType==="join"&&action==="approve"&&linkOrganizationId.trim()?{
      linkOrganizationId:linkOrganizationId.trim(),
      ...(linkBranchId.trim()?{linkBranchId:linkBranchId.trim()}:{}),
      ...(membershipRole?{membershipRole}:{}),
    }:{}),
  } as unknown as Parameters<typeof decideAdminOrganizationRequest>[2]))});
  async function submit(e:FormEvent){e.preventDefault();setError("");if(item.requestType==="join"&&action==="approve"&&linkOrganizationId.trim()&&!membershipRole){setError("اختر دور العضوية عند ربط الطلب بجهة قائمة.");return;}if(item.requestType==="join"&&action==="approve"&&membershipRole&&!linkOrganizationId.trim()){setError("أدخل معرّف الجهة قبل إسناد دور عضوية.");return;}if(item.requestType==="join"&&action==="approve"&&membershipRole!=="organization_owner"&&linkOrganizationId.trim()&&!linkBranchId.trim()){setError("أدخل معرّف الفرع لدور العضوية المحدود بالفروع.");return;}if(item.requestType==="bank"&&!Number.isInteger(expectedAccountVersion)){setError("تعذر قراءة إصدار الحساب البنكي. حدّث الطلب قبل اتخاذ القرار.");return;}try{await decision.mutateAsync();await onComplete();}catch(x){setError(errorMessage(x));}}
  return <div className="ow-overlay" role="presentation" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="ow-dialog" role="dialog" aria-modal="true" aria-labelledby="ow-review-title"><button className="ow-icon" onClick={onClose} aria-label="إغلاق"><X size={18}/></button><span className="ow-eyebrow">مراجعة {labels[item.requestType]??item.requestType} · نسخة {item.version}</span><h2 id="ow-review-title">{item.title}</h2><p className="ow-dialog-summary">{Object.entries(summary).filter(([k])=>!/(identifier|accountNumber|secret|url)/i.test(k)).map(([key,value])=><span key={key}><b>{key}</b> {typeof value==="object"?JSON.stringify(value):String(value)}</span>)}</p><form onSubmit={submit}><div className="ow-decision-options">{([["approve","اعتماد"],["needs_completion","طلب استكمال"],["reject","رفض"]] as const).map(([v,label])=><label key={v} className={action===v?"selected":""}><input type="radio" name="action" value={v} checked={action===v} onChange={()=>setAction(v)}/>{label}</label>)}</div>
     {item.requestType==="bank"&&<section className="ow-bank-review" aria-live="polite"><h3><Landmark size={16}/> تفاصيل النسخة البنكية</h3>{bankDetails.isLoading?<Loading/>:bankDetails.isError?<InlineError text={errorMessage(bankDetails.error)} retry={()=>void bankDetails.refetch()}/>:bankDetails.data&&<div><span>البنك: {bankDetails.data.bankName}</span><span>المستفيد: {bankDetails.data.beneficiaryName}</span><code dir="ltr">{bankDetails.data.accountIdentifier}</code><small>نسخة الحساب الحالية: {String(expectedAccountVersion??"غير متاحة")}</small></div>}</section>}
    {item.requestType==="document"&&<DocumentRow document={{id:item.id,document_type:item.title.replace(/^مستند\s*/,""),file_name:String(field(summary,"fileName")??""),content_type:String(field(summary,"contentType")??"application/pdf"),byte_size:Number(field(summary,"byteSize")??0),expires_on:field(summary,"expiresOn") as string|null|undefined,status:item.status,version:item.version,review_reason:field(summary,"reviewReason") as string|null|undefined}} contextLabel="مستند للمراجعة"/>}
    {item.requestType==="join"&&action==="approve"&&<fieldset className="ow-link-membership"><legend>ربط اختياري بعضوية جهة قائمة</legend><label>معرّف الجهة<input dir="ltr" value={linkOrganizationId} onChange={e=>setLinkOrganizationId(e.target.value)} placeholder="اتركه فارغًا لإنشاء الجهة من الطلب"/></label><label>الدور عند الربط<select value={membershipRole} onChange={e=>setMembershipRole(e.target.value)}><option value="">اختر دورًا عند إدخال جهة قائمة</option><option value="organization_owner">مالك الجهة (نطاق الجهة فقط)</option><option value="manager">مدير</option><option value="finance">مالي</option><option value="worker">موظف</option><option value="viewer">مشاهد</option></select></label>{membershipRole&&membershipRole!=="organization_owner"&&<label>معرّف الفرع (مطلوب لهذا الدور)<input dir="ltr" value={linkBranchId} onChange={e=>setLinkBranchId(e.target.value)} placeholder="معرّف فرع تابع للجهة"/></label>}<small>هذه أدوار داخل الجهة فقط؛ لا يُمنح أي دور لمالك المنصة. مالك الجهة يكون على نطاق الجهة فقط.</small></fieldset>}
    <label className="ow-reason">سبب القرار<textarea required minLength={5} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} placeholder="اكتب سببًا واضحًا لا يقل عن خمسة أحرف"/></label>{error&&<Alert error>{error}</Alert>}<p className="ow-note"><ShieldCheck size={14}/> يتطلب القرار سببًا. الموافقة على طلب الانضمام لا تمنح ملكية المنصة.</p><button className="ow-button" disabled={decision.isPending||reason.trim().length<5}>{decision.isPending?"جارٍ تسجيل القرار…":"تسجيل القرار"}</button></form></section></div>;
}

export function OrganizationRecords({organizationId,canManage,canManageBank,managedBranchIds}:{organizationId:string;canManage:boolean;canManageBank:boolean;managedBranchIds:string[]}){
  const cache=useQueryClient();
  const org=useGetOrganization(organizationId,{query:{queryKey:getGetOrganizationQueryKey(organizationId),enabled:!!organizationId}});
  const branches=useListBranches(organizationId,{query:{queryKey:getListBranchesQueryKey(organizationId),enabled:!!organizationId}});
  const changes=useListOrganizationChangeRequests({organizationId},{query:{queryKey:getListOrganizationChangeRequestsQueryKey({organizationId}),enabled:!!organizationId,refetchOnMount:"always"}});
  const banks=useListOrganizationBankAccounts(organizationId,{query:{queryKey:getListOrganizationBankAccountsQueryKey(organizationId),enabled:!!organizationId,refetchOnMount:"always"}});
  const docs=useListOrganizationDocuments({organizationId},{query:{queryKey:getListOrganizationDocumentsQueryKey({organizationId}),enabled:!!organizationId,refetchOnMount:"always"}});
  const [bankForm,setBankForm]=useState(false),[changeForm,setChangeForm]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const branchItems=branches.data?.items??[];
  const documentBranches=canManage?branchItems:branchItems.filter(branch=>managedBranchIds.includes(branch.id));
  const mayManageDocuments=canManage||documentBranches.length>0;
  const mayRequestChanges=canManage||documentBranches.length>0;
  const refresh=async()=>{await Promise.all([cache.invalidateQueries({queryKey:getListOrganizationChangeRequestsQueryKey({organizationId})}),cache.invalidateQueries({queryKey:getListOrganizationBankAccountsQueryKey(organizationId)}),cache.invalidateQueries({queryKey:getListOrganizationDocumentsQueryKey({organizationId})})]);};
  return <section className="ow-records"><header className="ow-section-heading"><div><span className="ow-eyebrow">السجل الموثّق</span><h2>المستندات والتغييرات والحسابات</h2><p>البيانات الحساسة تظهر بحسب التفويض. تُحفظ التعديلات كطلبات مراجعة.</p></div><div className="ow-record-actions">{mayRequestChanges&&<button className="ow-button ow-quiet" onClick={()=>setChangeForm(v=>!v)}>طلب تغيير بيانات</button>}{canManageBank&&<button className="ow-button" onClick={()=>setBankForm(v=>!v)}><Landmark size={15}/> اقتراح حساب بنكي</button>}</div></header>
    {error&&<Alert error>{error}</Alert>}{notice&&<Alert>{notice}</Alert>}
    {changeForm&&mayRequestChanges&&<ChangeRequestForm organizationId={organizationId} organization={org.data} branches={documentBranches} canChangeOrganization={canManage} onClose={()=>setChangeForm(false)} onDone={async()=>{setChangeForm(false);await refresh();}}/>}
    {bankForm&&canManageBank&&<BankProposalForm organizationId={organizationId} bankAccountId={banks.data?.items?.[0]?.bank_account_id} version={banks.data?.items?.[0]?.account_version} onClose={()=>setBankForm(false)} onDone={async()=>{setBankForm(false);setNotice("تم تسجيل نسخة الحساب المقترحة.");await refresh();}}/>}
    <div className="ow-record-columns"><section className="ow-record-panel"><h3><Landmark size={17}/> سجل الحسابات البنكية</h3>{banks.isLoading?<Loading/>:banks.isError?<InlineError text={errorMessage(banks.error)} retry={()=>void banks.refetch()}/>:!(banks.data?.items??[]).length?<MiniEmpty text="لا توجد نسخ حساب بنكي مسجلة."/>:<div className="ow-version-list">{banks.data?.items.map(v=><BankVersion key={v.id} version={v} canManage={canManageBank} refresh={refresh}/>)}</div>}</section>
       <section className="ow-record-panel"><h3><FileText size={17}/> المستندات الخاصة</h3><DocumentUploader organizationId={organizationId} branches={documentBranches} canManageOrg={canManage} canManage={mayManageDocuments} onDone={async()=>{await refresh();}}/>{docs.isLoading?<Loading/>:docs.isError?<InlineError text={errorMessage(docs.error)} retry={()=>void docs.refetch()}/>:!(docs.data?.items??[]).length?<MiniEmpty text="لا توجد مستندات لهذا السجل."/>:<div className="ow-version-list">{docs.data?.items.map(d=><DocumentRow key={d.id} document={d} contextLabel={d.branch_id?(documentBranches.find(b=>b.id===d.branch_id)?.name??"فرع مصرح"): "ملف الجهة"}/>)}</div>}</section></div>
    <section className="ow-record-panel ow-change-panel"><h3><RefreshCw size={17}/> طلبات تغيير البيانات</h3>{changes.isLoading?<Loading/>:changes.isError?<InlineError text={errorMessage(changes.error)} retry={()=>void changes.refetch()}/>:!(changes.data?.items??[]).length?<MiniEmpty text="لا توجد طلبات تغيير."/>:<div className="ow-change-list">{changes.data?.items.map(c=><article className="ow-change-item" key={c.id}><div><Pill value={c.status}/><span>{labels[c.target_type]} · نسخة الطلب {c.version} · نسخة السجل {c.expected_entity_version}</span></div><Snapshot current={c.current_snapshot} proposed={c.proposed_data}/>{c.decision_reason&&<small>{c.decision_reason}</small>}{canManage&&["needs_completion","conflict"].includes(c.status)&&<ChangeResubmit request={c} done={refresh}/>}<ChangeWithdraw request={c} canManage={canManage} done={refresh}/></article>)}</div>}</section>
  </section>;
}
function Snapshot({current,proposed}:{current:Record<string,unknown>;proposed:Record<string,unknown>}){return <div className="ow-snapshots"><div><small>الحالي</small>{Object.entries(current).slice(0,6).map(([k,v])=><span key={k}>{k}: {String(v??"—")}</span>)}</div><div><small>المقترح</small>{Object.entries(proposed).slice(0,6).map(([k,v])=><span key={k}>{k}: {String(v??"—")}</span>)}</div></div>}
function ChangeRequestForm({organizationId,organization,branches,canChangeOrganization,onClose,onDone}:{organizationId:string;organization?:{version:number;name:string;kind:"company"|"station"|"provider";code:string|null;address:string;legal_name:string|null;contact_name:string|null;contact_phone:string|null;contact_email:string|null};branches:{id:string;version:number;name:string;code:string|null;address:string;governorate:string|null;latitude:number|null;longitude:number|null;contact_name:string|null;contact_phone:string|null;hours:unknown}[];canChangeOrganization:boolean;onClose:()=>void;onDone:()=>Promise<void>}){
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[target,setTarget]=useState<"organization"|"branch">(canChangeOrganization?"organization":"branch"),[branchId,setBranchId]=useState(branches[0]?.id??"");
 const branch=branches.find(b=>b.id===branchId);
 async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();setBusy(true);setError("");const d=new FormData(e.currentTarget);try{
   if(target==="organization"){
     if(!organization)throw new Error("بيانات الجهة غير متاحة؛ أعد تحميل السجل.");
      const proposedData={name:String(d.get("name")).trim(),kind:String(d.get("kind")) as "company"|"station"|"provider",code:String(d.get("code")).trim(),address:String(d.get("address")).trim(),legalName:String(d.get("legalName")).trim()||null};
     await createOrganizationChangeRequest({organizationId,expectedEntityVersion:organization.version,proposedData});
   } else {
     if(!branch)throw new Error("اختر فرعًا قبل تقديم طلب التغيير.");
      const proposedData={code:String(d.get("code")).trim(),name:String(d.get("name")).trim(),address:String(d.get("address")).trim(),governorate:String(d.get("governorate")).trim()||null,latitude:String(d.get("latitude")).trim()?Number(d.get("latitude")):null,longitude:String(d.get("longitude")).trim()?Number(d.get("longitude")):null};
     await createOrganizationChangeRequest({organizationId,branchId:branch.id,expectedEntityVersion:branch.version,proposedData});
   }
   await onDone();
 }catch(e){setError(errorMessage(e));}finally{setBusy(false)}}
  return <form className="ow-inline-form" onSubmit={submit}><b>اقتراح تغيير بيانات</b><div className="ow-fields" key={`${target}-${branch?.id??""}`}>{canChangeOrganization&&<label>نوع السجل<select value={target} onChange={e=>setTarget(e.target.value as "organization"|"branch")}><option value="organization">الجهة</option><option value="branch" disabled={!branches.length}>فرع</option></select></label>}{target==="branch"&&<label>الفرع<select value={branchId} onChange={e=>setBranchId(e.target.value)}>{branches.map(b=><option value={b.id} key={b.id}>{b.name}</option>)}</select></label>}
  {target==="organization"?<><label>الاسم التجاري<input name="name" required defaultValue={organization?.name??""}/></label><label>النوع<select name="kind" defaultValue={organization?.kind??"company"}><option value="company">شركة</option><option value="station">محطة</option><option value="provider">مقدّم خدمة</option></select></label><label>كود الجهة<input name="code" required dir="ltr" defaultValue={organization?.code??""}/></label><label className="ow-wide">العنوان<input name="address" required defaultValue={organization?.address??""}/></label><label>الاسم القانوني<input name="legalName" defaultValue={organization?.legal_name??""}/></label></>:<><label>اسم الفرع<input name="name" required defaultValue={branch?.name??""}/></label><label>كود الفرع<input name="code" required dir="ltr" defaultValue={branch?.code??""}/></label><label>المحافظة<input name="governorate" defaultValue={branch?.governorate??""}/></label><label className="ow-wide">العنوان<input name="address" required defaultValue={branch?.address??""}/></label><label>خط العرض<input name="latitude" type="number" step="any" dir="ltr" defaultValue={branch?.latitude??""}/></label><label>خط الطول<input name="longitude" type="number" step="any" dir="ltr" defaultValue={branch?.longitude??""}/></label></>}</div>
 {target==="branch"&&branches.length===0&&<Alert error>لا توجد فروع يمكن تقديم طلب تعديل لها.</Alert>}{error&&<Alert error>{error}</Alert>}<div className="ow-actions"><button className="ow-button" disabled={busy||(target==="branch"&&!branch)}>{busy?"جارٍ الإرسال…":"إرسال للمراجعة"}</button><button type="button" className="ow-button ow-quiet" onClick={onClose}>إلغاء</button></div></form>;
}
function ChangeResubmit({request,done}:{request: {id:string;version:number;target_type:"organization"|"branch";proposed_data:Record<string,unknown>};done:()=>Promise<void>}){
 const [open,setOpen]=useState(false),[error,setError]=useState("");
 const mutation=useMutation({mutationFn:(proposedData:Record<string,unknown>)=>resubmitOrganizationChangeRequest(request.id,{expectedRequestVersion:request.version,proposedData})});
  const keys=request.target_type==="branch"?["code","name","address","governorate","latitude","longitude"]:["name","kind","code","address","legalName"];
  const names:Record<string,string>={name:"الاسم",kind:"النوع",code:"الكود",address:"العنوان",governorate:"المحافظة",latitude:"خط العرض",longitude:"خط الطول",legalName:"الاسم القانوني"};
  return open?<form className="ow-inline-form" onSubmit={async e=>{e.preventDefault();setError("");const d=new FormData(e.currentTarget),proposed:Record<string,unknown>={};for(const key of keys){const value=String(d.get(key)??"").trim();proposed[key]=["latitude","longitude"].includes(key)?(value?Number(value):null):value||null;}try{await mutation.mutateAsync(proposed);await done();setOpen(false)}catch(x){setError(errorMessage(x))}}}><b>استكمال الطلب وإعادة الإرسال</b><div className="ow-fields">{keys.map(key=><label key={key}>{names[key]}{key==="kind"?<select name={key} defaultValue={String(request.proposed_data[key]??"company")}><option value="company">شركة</option><option value="station">محطة</option><option value="provider">مقدّم خدمة</option></select>:<input name={key} type={["latitude","longitude"].includes(key)?"number":"text"} step={["latitude","longitude"].includes(key)?"any":undefined} dir={["code","latitude","longitude"].includes(key)?"ltr":undefined} defaultValue={String(request.proposed_data[key]??"")} required={["name","address","code"].includes(key)}/>}</label>)}</div>{error&&<Alert error>{error}</Alert>}<button className="ow-button" disabled={mutation.isPending}>إعادة الإرسال</button><button type="button" className="ow-button ow-quiet" onClick={()=>setOpen(false)}>إلغاء</button></form>:<button className="ow-text-action" onClick={()=>setOpen(true)}>استكمال الطلب</button>;
}
function ChangeWithdraw({request,canManage,done}:{request:{id:string;version:number;status:string};canManage:boolean;done:()=>Promise<void>}){
 const [error,setError]=useState("");
 const mutation=useMutation({mutationFn:()=>withdrawOrganizationChangeRequest(request.id,{expectedVersion:request.version})});
 if(!canManage||!["submitted","needs_completion","conflict"].includes(request.status))return null;
 return <div className="ow-withdraw-action"><button className="ow-text-action ow-danger-text" disabled={mutation.isPending} onClick={async()=>{setError("");try{await mutation.mutateAsync();await done()}catch(e){setError(errorMessage(e))}}}>{mutation.isPending?"جارٍ السحب…":"سحب الطلب"}</button>{error&&<small className="ow-inline-error" role="alert">{error}</small>}</div>;
}
function BankProposalForm({organizationId,bankAccountId,version,onClose,onDone}:{organizationId:string;bankAccountId?:string;version?:number;onClose:()=>void;onDone:()=>Promise<void>}){
 const [error,setError]=useState("");const mutation=useMutation({mutationFn:(body:Parameters<typeof proposeOrganizationBankAccount>[1])=>proposeOrganizationBankAccount(organizationId,body)});
  return <form className="ow-inline-form" onSubmit={async e=>{e.preventDefault();setError("");const d=new FormData(e.currentTarget);try{await mutation.mutateAsync({...(bankAccountId?{bankAccountId}:{}),...(version!==undefined?{expectedAccountVersion:version}:{}),bankName:String(d.get("bankName")).trim(),beneficiaryName:String(d.get("beneficiaryName")).trim(),accountIdentifier:String(d.get("accountIdentifier")).replace(/\s/g,"")});await onDone()}catch(x){setError(errorMessage(x))}}}><b>إضافة نسخة حساب مقترحة</b><div className="ow-fields"><label>اسم البنك<input name="bankName" required minLength={2}/></label><label>اسم المستفيد<input name="beneficiaryName" required minLength={2}/></label><label className="ow-wide">رقم الحساب<input name="accountIdentifier" required minLength={5} maxLength={64} dir="ltr" autoComplete="off"/></label></div><p className="ow-note"><LockKeyhole size={14}/> الرقم الكامل لا يظهر في سجل النسخ؛ يظل متاحًا فقط لتفويض التفاصيل المصرّح به.</p>{error&&<Alert error>{error}</Alert>}<div className="ow-actions"><button className="ow-button" disabled={mutation.isPending}>{mutation.isPending?"جارٍ الحفظ…":"حفظ النسخة المقترحة"}</button><button type="button" className="ow-button ow-quiet" onClick={onClose}>إلغاء</button></div></form>;
}
function BankVersion({version,canManage,refresh}:{version:{id:string;version:number;bank_name:string;beneficiary_name:string;account_last4:string;status:string;decision_reason?:string|null};canManage:boolean;refresh:()=>Promise<void>}){
 const [show,setShow]=useState(false),[error,setError]=useState("");
 const details=useGetOrganizationBankAccountVersionDetails(version.id,{query:{queryKey:getGetOrganizationBankAccountVersionDetailsQueryKey(version.id),enabled:show,refetchOnMount:"always"}});
 const withdraw=useMutation({mutationFn:()=>withdrawOrganizationBankAccountVersion(version.id,{expectedVersion:version.version})});
 return <article className="ow-version"><div className="ow-version-head"><div><b>{version.bank_name}</b><span>{version.beneficiary_name}</span></div><Pill value={version.status}/></div><div className="ow-version-meta"><span>نسخة {version.version}</span><span dir="ltr">•••• {version.account_last4}</span><button className="ow-text-action" onClick={()=>setShow(v=>!v)}>{show?"إخفاء التفاصيل المصرّح بها":"تفاصيل الحساب"}</button>{canManage&&version.status==="pending"&&<button className="ow-text-action ow-danger-text" onClick={async()=>{setError("");try{await withdraw.mutateAsync();await refresh()}catch(e){setError(errorMessage(e))}}} disabled={withdraw.isPending}>سحب النسخة</button>}</div>{show&&<div className="ow-bank-detail">{details.isLoading?<Loading/>:details.isError?<InlineError text={errorMessage(details.error)} retry={()=>void details.refetch()}/>:<><span>رقم الحساب الكامل</span><b dir="ltr">{details.data?.accountIdentifier}</b></>}</div>}{error&&<small className="ow-inline-error">{error}</small>}</article>;
}
function DocumentUploader({organizationId,branches,canManageOrg,canManage,onDone}:{organizationId:string;branches:{id:string;name:string}[];canManageOrg:boolean;canManage:boolean;onDone:()=>Promise<void>}){
 const [error,setError]=useState(""),[busy,setBusy]=useState(false),[target,setTarget]=useState(canManageOrg?`org:${organizationId}`:branches[0]?`branch:${branches[0].id}`:"");
 useEffect(()=>{if(canManageOrg){if(target!=="org:"+organizationId)setTarget(`org:${organizationId}`);}else if(!branches.some(branch=>target===`branch:${branch.id}`))setTarget(branches[0]?`branch:${branches[0].id}`:"");},[canManageOrg,organizationId,branches,target]);
 if(!canManage)return <p className="ow-note"><LockKeyhole size={14}/> الرفع متاح للمستخدمين المخوّلين بإدارة سجل الجهة أو فروعهم المصرح بها.</p>;
  return <form className="ow-upload" onSubmit={async e=>{e.preventDefault();setError("");setBusy(true);const form=e.currentTarget,d=new FormData(form),file=d.get("file");if(!(file instanceof File)){setError("اختر ملفًا أولًا.");setBusy(false);return;}if(file.size>10485760){setError("حجم الملف يتجاوز الحد الأقصى البالغ 10 ميغابايت.");setBusy(false);return;}const contentType=file.type as "application/pdf"|"image/png"|"image/jpeg";if(!["application/pdf","image/png","image/jpeg"].includes(contentType)){setError("الصيغ المقبولة: PDF أو PNG أو JPEG.");setBusy(false);return;}try{const rawTarget=String(d.get("contextId")??"");const isOrg=rawTarget.startsWith("org:");const contextId=rawTarget.slice(isOrg?4:7);if(!contextId)throw new Error("اختر الجهة أو الفرع أولًا.");const contextType=isOrg?"organization":"branch";const intent=await createDocumentUploadIntent({contextType,contextId,documentType:String(d.get("documentType")).trim(),fileName:file.name.slice(0,160),contentType,byteSize:file.size,expiresOn:String(d.get("expiresOn")||"")||null});await uploadOrganizationDocumentContent(intent.id,file);form.reset();setTarget(canManageOrg?`org:${organizationId}`:branches[0]?`branch:${branches[0].id}`:"");await onDone();}catch(x){setError(errorMessage(x));}finally{setBusy(false)}}}><div className="ow-upload-fields"><label>السجل<select name="contextId" value={target} onChange={e=>setTarget(e.target.value)} required><>{canManageOrg&&<option value={`org:${organizationId}`}>ملف الجهة</option>}{branches.map(branch=><option key={branch.id} value={`branch:${branch.id}`}>فرع: {branch.name}</option>)}</></select></label><label>نوع المستند<input name="documentType" required minLength={2} maxLength={80} placeholder="اكتب نوع المستند"/></label><label>تاريخ الانتهاء (اختياري)<input type="date" name="expiresOn"/></label><label className="ow-file-label"><Upload size={16}/> اختر PDF أو صورة<input name="file" type="file" accept="application/pdf,image/png,image/jpeg" required/></label></div><small>الحد الأقصى لحجم الملف 10 ميغابايت. الملفات خاصة ولا تُعرض إلا عبر رابط تنزيل مؤقت ومصرّح.</small>{error&&<Alert error>{error}</Alert>}<button className="ow-button" disabled={busy||!target}>{busy?"جارٍ رفع الملف…":"رفع مستند"}</button></form>;
}
function DocumentRow({document:d,contextLabel=""}:{document:{id:string;document_type:string;file_name:string;content_type:string;byte_size:number;expires_on?:string|null;status:string;version:number;review_reason?:string|null};contextLabel?:string}){
 const download=useCreateOrganizationDocumentDownload(d.id,{query:{enabled:false,queryKey:getCreateOrganizationDocumentDownloadQueryKey(d.id)}});
 return <article className="ow-version"><div className="ow-version-head"><div><b>{d.document_type}</b><span>{contextLabel&&`${contextLabel} · `}{d.file_name} · {Math.ceil(d.byte_size/1024)} كيلوبايت · نسخة {d.version}</span></div><Pill value={d.status}/></div><div className="ow-version-meta">{d.expires_on&&<span>ينتهي {new Date(d.expires_on).toLocaleDateString("ar-EG")}</span>}{d.review_reason&&<small>{d.review_reason}</small>}<button className="ow-text-action" disabled={download.isFetching} onClick={async()=>{try{const result=await download.refetch();if(result.data?.url){const a=document.createElement("a");a.href=result.data.url;a.download=d.file_name;a.rel="noreferrer";document.body.appendChild(a);a.click();a.remove();}}catch{/* query exposes an accessible error state below */}}}>{download.isFetching?"جارٍ تجهيز التنزيل…":"تنزيل خاص"}</button></div>{download.isError&&<small className="ow-inline-error">{errorMessage(download.error)}</small>}</article>;
}
function InlineError({text,retry}:{text:string;retry:()=>void}){return <div className="ow-inline-error" role="alert">{text}<button className="ow-text-action" onClick={retry}>إعادة المحاولة</button></div>}
function MiniEmpty({text}:{text:string}){return <div className="ow-mini-empty"><Clock3 size={16}/>{text}</div>}
