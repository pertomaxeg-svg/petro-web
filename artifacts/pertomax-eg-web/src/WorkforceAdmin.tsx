import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FleetReferencePicker } from "./FleetReferencePicker";
import "./FleetAdmin.css";
type Row=Record<string,unknown>;
type Page={items:Row[];total:number;page:number;pageSize:number;canManage?:boolean;organizationKind?:string};
const labels:Record<string,string>={fuel:"الوقود",wash:"الغسيل",oils:"الزيوت",batteries:"البطاريات",filters:"الفلاتر",parts:"قطع الغيار",consumables:"المستهلكات",card_issuance:"إصدار وتركيب البطاقات"};
async function read(url:string):Promise<Page>{
 const response=await fetch(url,{credentials:"include"});const body=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(body.message??"تعذر تحميل تكليفات العمال.");return body;
}
export function WorkforceAdmin({canManage}:{canManage:boolean}){
 const cache=useQueryClient();const [organization,setOrganization]=useState("");const [branch,setBranch]=useState("");
 const [candidateSearch,setCandidateSearch]=useState("");const [candidatePage,setCandidatePage]=useState(1);
 const [user,setUser]=useState("");const [group,setGroup]=useState("fuel");const [page,setPage]=useState(1);
 const [search,setSearch]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [notice,setNotice]=useState("");
 const pending=useRef<{signature:string;key:string}|null>(null);
 const assignments=useQuery({queryKey:["workforce",branch,page,search],queryFn:()=>read("/api/admin/workforce?"+new URLSearchParams({page:String(page),pageSize:"20",...(branch?{branchId:branch}:{}),...(search.trim()?{search:search.trim()}:{} )})),retry:false});
 const candidates=useQuery({queryKey:["workforce-candidates",branch,candidatePage,candidateSearch],queryFn:()=>read("/api/admin/workforce?"+new URLSearchParams({view:"candidates",branchId:branch,pageSize:"20",page:String(candidatePage),...(candidateSearch.trim()?{search:candidateSearch.trim()}:{})})),enabled:canManage&&!!branch,retry:false});
 useEffect(()=>{setBranch("");setUser("");setPage(1);},[organization]);
 useEffect(()=>{setUser("");setCandidateSearch("");setCandidatePage(1);setPage(1);pending.current=null;setError("");},[branch]);
 useEffect(()=>{if(candidates.data?.organizationKind==="provider"&&["fuel","card_issuance"].includes(group))setGroup("oils");},[candidates.data?.organizationKind,group]);
 async function save(payload:{userId:string;branchId:string;serviceGroup:string;active:boolean;expectedVersion:number}){
  setBusy(true);setError("");setNotice("");const signature=JSON.stringify(payload);
  if(pending.current?.signature!==signature)pending.current={signature,key:crypto.randomUUID()};
  try{
   const response=await fetch("/api/admin/workforce/assignments",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({...payload,idempotencyKey:pending.current.key})});
   const body=await response.json().catch(()=>({}));
   if(!response.ok){if(response.status<500)pending.current=null;throw new Error(body.message??"تعذر حفظ التكليف.");}
   pending.current=null;setNotice("حُفظ التكليف. صلاحية التنفيذ تُراجع مع حالة العضوية والفرع عند كل طلب.");
   await cache.invalidateQueries({queryKey:["workforce"]});
  }catch(reason){setError(reason instanceof Error?reason.message:"تعذر حفظ التكليف.");}
  finally{setBusy(false);}
 }
 async function submit(event:FormEvent){event.preventDefault();if(!user||!branch)return;await save({userId:user,branchId:branch,serviceGroup:group,active:true,expectedVersion:0});}
 const items=assignments.data?.items??[];const pages=Math.max(1,Math.ceil((assignments.data?.total??0)/20));
 return <div className="fleet-page" dir="rtl">
 <header className="fleet-heading"><div><span className="fleet-eyebrow">تشغيل الفروع</span><h1>تكليفات العمال</h1><p>حدد العامل والفرع والخدمة. عضوية الجهة وحدها لا تمنح تنفيذ الخدمات أو الوصول إلى أسطول الشركات.</p></div></header>
 <section className="fleet-panel">
 <div className="fleet-form">
 <FleetReferencePicker kind="organization" label="المحطة أو مقدم الخدمة" organizationKinds={["station","provider"]} value={organization} onChange={setOrganization} allowAll testId="workforce-organization"/>
 {organization&&<FleetReferencePicker kind="branch" label="الفرع" organizationId={organization} value={branch} onChange={setBranch} allowAll testId="workforce-branch"/>}
 <label className="fleet-field">البحث في التكليفات<input type="search" data-testid="workforce-search" value={search} onChange={event=>{setSearch(event.target.value);setPage(1);}} placeholder="اسم العامل أو الجهة أو الفرع"/></label>
 </div>
 {canManage&&branch&&<form className="fleet-form" onSubmit={submit} aria-label="إضافة تكليف عامل">
 <label className="fleet-field">بحث باسم العامل<input value={candidateSearch} onChange={event=>{setCandidateSearch(event.target.value);setCandidatePage(1);setUser("");}} placeholder="اسم العامل أو اسم المستخدم"/></label>
 <label className="fleet-field">العامل المؤهل في الفرع<select data-testid="workforce-user" value={user} onChange={event=>setUser(event.target.value)} required disabled={busy||candidates.isLoading||candidates.isError}><option value="">{candidates.isLoading?"جارٍ تحميل أعضاء الفرع…":"اختر عضوًا مؤهلًا"}</option>{(candidates.data?.items??[]).map(row=><option key={String(row.userId)} value={String(row.userId)}>{String(row.displayName)} · {String(row.username)}</option>)}</select></label>
 <label className="fleet-field">الخدمة<select data-testid="workforce-service" value={group} onChange={event=>setGroup(event.target.value)} disabled={busy}>{Object.entries(labels).map(([key,label])=><option key={key} value={key} disabled={candidates.data?.organizationKind==="provider"&&["fuel","card_issuance"].includes(key)}>{label}</option>)}</select></label>
 <button className="fleet-button" data-testid="workforce-submit" disabled={busy||!user}>{busy?"جارٍ الحفظ…":"إضافة التكليف"}</button>
 {candidates.data&&candidates.data.total>20&&<div className="fleet-pagination"><span>{candidates.data.total} عضو مؤهل</span><button type="button" disabled={candidatePage<=1||busy} onClick={()=>{setCandidatePage(value=>value-1);setUser("");}}>السابق</button><button type="button" disabled={candidatePage*20>=candidates.data.total||busy} onClick={()=>{setCandidatePage(value=>value+1);setUser("");}}>التالي</button></div>}
 </form>}
 {candidates.isError&&branch&&<p role="alert" className="fleet-feedback is-error">{candidates.error.message}<button onClick={()=>void candidates.refetch()}>إعادة المحاولة</button></p>}
 {canManage&&branch&&candidates.isSuccess&&!candidates.data.items.length&&<p className="fleet-muted">لا يوجد عضو تشغيل مؤهل في الفرع. أضف عضوية فعالة بنطاق الفرع من إدارة فريق الجهة، ثم حدّث القائمة.</p>}
 <p className="fleet-muted">الوقود وإصدار البطاقات للمحطات فقط. لا يمنح هذا التكليف تفعيلًا ميدانيًا أو صلاحية مالية أو إدارية.</p>
 </section>
 {error&&<p role="alert" className="fleet-feedback is-error">{error}</p>}{notice&&<p role="status" className="fleet-feedback">{notice}</p>}
 <section className="fleet-table-card"><div className="fleet-table-head"><h2>سجل التكليفات</h2><button className="fleet-button fleet-quiet" onClick={()=>{void assignments.refetch();if(branch)void candidates.refetch();}}>تحديث</button></div>
 {assignments.isLoading?<p role="status">جارٍ تحميل التكليفات…</p>:assignments.isError?<p role="alert" className="fleet-feedback is-error">{assignments.error.message}</p>:!items.length?<p role="status" className="fleet-muted">لا توجد تكليفات مطابقة. اختر الفرع لإضافة تكليف لعامل مؤهل.</p>:<div className="fleet-table-scroll"><table className="fleet-record-table"><thead><tr><th>العامل</th><th>الجهة والفرع</th><th>الخدمة</th><th>حالة التكليف</th><th>التنفيذ الآن</th>{canManage&&<th>الإجراء</th>}</tr></thead><tbody>{items.map(row=><tr key={String(row.id)} data-testid="workforce-row">
 <td data-label="العامل">{String(row.displayName)}</td><td data-label="الجهة والفرع">{String(row.organizationName)} · {String(row.branchName)}</td><td data-label="الخدمة">{labels[String(row.serviceGroup)]??"خدمة غير معروفة"}</td>
 <td data-label="التكليف">{row.active?"فعال":"موقوف"}</td><td data-label="التنفيذ الآن">{row.canExecute?"مسموح ضمن الخدمة":"غير مسموح؛ راجع العضوية والفرع"}</td>
 {canManage&&<td><button className="fleet-row-action" disabled={busy} onClick={()=>void save({userId:String(row.userId),branchId:String(row.branchId),serviceGroup:String(row.serviceGroup),active:!row.active,expectedVersion:Number(row.version)})}>{row.active?"إيقاف":"إعادة تفعيل"}</button></td>}
 </tr>)}</tbody></table></div>}
 <footer className="fleet-pagination"><span>{assignments.data?.total??0} تكليف · صفحة {page} من {pages}</span><div><button disabled={page<=1||busy} onClick={()=>setPage(value=>value-1)}>السابق</button><button disabled={page>=pages||busy} onClick={()=>setPage(value=>value+1)}>التالي</button></div></footer>
 </section></div>;
}
