import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useGetAuthMe, getGetAuthMeQueryKey } from "@workspace/api-client-react";
import { formatFleetField } from "./fleetDisplay";
import "./FleetAdmin.css";
type Capability={assignmentId:string;branchId:string;branchName:string;organizationName:string;serviceGroup:string};
type Capabilities={items:Capability[];pinVerificationReady?:boolean};
type Proof={valid:boolean;locked?:boolean;retryAt?:string|null;verificationId?:string;expiresAt?:string;driverName?:string;vehicle?:{plate:string;brand:string;model:string;fuelType:string;tankCapacityLiters?:number|null}};
const names:Record<string,string>={fuel:"الوقود",wash:"الغسيل",oils:"الزيوت",parts:"قطع الغيار",batteries:"البطاريات",filters:"الفلاتر",consumables:"المستهلكات"};
async function capabilities():Promise<Capabilities>{
 const response=await fetch("/api/operations/capabilities",{credentials:"include"});const body=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(body.message??"تعذر تحميل تكليفات التشغيل.");return body;
}
export function OperationsEntry(){
 const query=useQuery({queryKey:["operations-capabilities"],queryFn:capabilities,retry:false});
 if(!query.data?.items.some(item=>item.serviceGroup in names))return null;
 return <Link className="button" href="/operations">تشغيل الخدمات</Link>;
}
export function OperationsPage(){
 const me=useGetAuthMe({query:{queryKey:getGetAuthMeQueryKey(),retry:false}});
 const active=me.data?.state==="active"&&!me.data?.passwordChangeRequired;
 const query=useQuery({queryKey:["operations-capabilities"],queryFn:capabilities,enabled:active,retry:false,refetchOnMount:"always"});
 const [assignment,setAssignment]=useState("");const [token,setToken]=useState("");const [pin,setPin]=useState("");
 const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [proof,setProof]=useState<Proof|null>(null);
 const pending=useRef<{fingerprint:string;key:string}|null>(null);
 const items=(query.data?.items??[]).filter(item=>item.serviceGroup in names);
 useEffect(()=>{if(!items.some(item=>item.assignmentId===assignment))setAssignment(items[0]?.assignmentId??"");},[query.data,assignment]);
 useEffect(()=>{setPin("");setProof(null);setError("");pending.current=null;},[assignment]);
 useEffect(()=>{
  if(!proof?.valid||!proof.expiresAt)return;
  const expire=()=>{setProof(null);setError("انتهت مهلة التحقق؛ أدخل الرمز من جديد.");};
  const timeout=window.setTimeout(expire,Math.max(0,new Date(proof.expiresAt).getTime()-Date.now()));
  const check=()=>{if(new Date(proof.expiresAt!).getTime()<=Date.now())expire();};
  document.addEventListener("visibilitychange",check);
  return()=>{window.clearTimeout(timeout);document.removeEventListener("visibilitychange",check);};
 },[proof]);
 async function verify(event:FormEvent){
  event.preventDefault();setError("");setProof(null);const selected=items.find(item=>item.assignmentId===assignment);if(!selected)return;
  const submittedPin=pin;setPin("");setBusy(true);
  try{
   const payload={branchId:selected.branchId,serviceGroup:selected.serviceGroup,credentialToken:token.trim(),pinCode:submittedPin};
   const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(payload)));
   const fingerprint=Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,"0")).join("");
   if(pending.current?.fingerprint!==fingerprint)pending.current={fingerprint,key:crypto.randomUUID()};
   const response=await fetch("/api/operations/pair-verifications",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({...payload,idempotencyKey:pending.current.key})});
   const body=await response.json().catch(()=>({}));
   if(!response.ok){if(response.status<500)pending.current=null;throw new Error(body.message??"تعذر التأكد من نتيجة التحقق؛ أعد إدخال الرمز نفسه للمحاولة مجددًا.");}
   pending.current=null;
   if(body.valid===true){setProof(body);setToken("");}
   else setError(body.locked?"توقف التحقق مؤقتًا بسبب المحاولات المتكررة. حاول بعد انتهاء فترة الانتظار.":"تعذر التحقق من تعريف المركبة أو الرمز.");
  }catch(reason){setError(reason instanceof Error?reason.message:"تعذر التحقق الآن.");}
  finally{setBusy(false);}
 }
 if(me.isLoading)return <main className="workspace-loading" dir="rtl">جارٍ تحميل حساب التشغيل…</main>;
 if(!active)return <main className="fleet-page" dir="rtl"><h1>يلزم حساب تشغيل فعال</h1><Link href={me.data?.passwordChangeRequired?"/reset-password?update=1":"/sign-in"}>متابعة تسجيل الدخول</Link></main>;
 return <main className="fleet-page operations-page" dir="rtl" style={{maxWidth:920,margin:"0 auto",padding:"24px 16px"}}>
 <header className="fleet-heading"><div><span className="fleet-eyebrow">مساحة العامل</span><h1>التحقق من المركبة والسائق</h1><p>اختر تكليفك ثم اقرأ تعريف المركبة وأدخل رمز التعبئة.</p></div><Link className="fleet-row-action" href="/workspace">مساحة العمل</Link></header>
 {query.isLoading?<p role="status">جارٍ تحميل تكليفاتك…</p>:query.isError?<section role="alert" className="fleet-feedback is-error">{query.error.message}<button onClick={()=>void query.refetch()}>إعادة المحاولة</button></section>:!items.length?<section className="fleet-panel"><h2>لا توجد تكليفات خدمات فعالة</h2><p>راجع مسؤول الفرع لتحديد الخدمة ونطاق عملك.</p></section>:<>
 {!query.data?.pinVerificationReady&&<p role="alert" className="fleet-feedback is-error">التحقق غير متاح مؤقتًا؛ راجع مسؤول التشغيل.</p>}
 <form className="fleet-panel fleet-form" onSubmit={verify} autoComplete="off">
 <label className="fleet-field fleet-wide">الفرع والخدمة<select data-testid="operations-assignment" value={assignment} onChange={event=>setAssignment(event.target.value)} disabled={busy}>{items.map(item=><option key={item.assignmentId} value={item.assignmentId}>{item.organizationName} · {item.branchName} · {names[item.serviceGroup]}</option>)}</select></label>
 <label className="fleet-field fleet-wide">تعريف المركبة<input data-testid="operations-token" value={token} onChange={event=>setToken(event.target.value)} placeholder="اقرأ QR أو شريحة المركبة" autoComplete="off" minLength={16} maxLength={512} required dir="ltr" disabled={busy}/></label>
 <label className="fleet-field">رمز التعبئة<input data-testid="operations-pin" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{4}" minLength={4} maxLength={4} required value={pin} onChange={event=>setPin(event.target.value.replace(/[٠-٩]/g,char=>String(char.charCodeAt(0)-1632)).replace(/[۰-۹]/g,char=>String(char.charCodeAt(0)-1776)).replace(/[^0-9]/g,"").slice(0,4))} disabled={busy}/></label>
 <button className="fleet-button" data-testid="operations-verify" disabled={busy||!query.data?.pinVerificationReady||!assignment}>{busy?"جارٍ التحقق…":"التحقق من الرمز"}</button>
 </form>
 </>}
 {error&&<p role="alert" className="fleet-feedback is-error">{error}</p>}
 {proof?.valid&&proof.vehicle&&<section className="fleet-panel" data-testid="operations-proof"><h2>تم التحقق من المركبة والسائق</h2><div className="fleet-facts">
 <div><small>المركبة</small><bdi dir="ltr">{proof.vehicle.plate}</bdi></div><div><small>الماركة والطراز</small><b>{proof.vehicle.brand} · {proof.vehicle.model}</b></div>
 <div><small>فئة الوقود</small><b>{formatFleetField("fuelType",proof.vehicle.fuelType)}</b></div><div><small>سعة الخزان</small><b>{formatFleetField("tankCapacityLiters",proof.vehicle.tankCapacityLiters)}</b></div>
 <div><small>السائق</small><b>{proof.driverName}</b></div><div><small>مهلة التحقق</small><b>{proof.expiresAt?new Intl.DateTimeFormat("ar-EG",{timeStyle:"short",timeZone:"Africa/Cairo"}).format(new Date(proof.expiresAt)):"—"}</b></div>
 </div><p className="fleet-muted">هذا تحقق هوية فقط. تنفيذ الخدمة والدفع يحتاجان اعتماد الطلب.</p><button className="fleet-button fleet-quiet" onClick={()=>setProof(null)}>تحقق جديد</button></section>}
 </main>;
}
