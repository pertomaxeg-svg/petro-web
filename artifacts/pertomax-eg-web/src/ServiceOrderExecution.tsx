import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
type Evidence={id:string;kind:string;fileName:string;contentType:string;byteSize:number;status:"pending"|"accepted"};
type Execution={id:string;status:string;version:number;quantity:string;amountMinor:string;serviceGroup:string;kind:string;canStart:boolean;canDeliver:boolean;documentationRule:{odometerRequired:boolean;washBeforeRequired:boolean;washAfterRequired:boolean;serialRequired:boolean};evidence:Evidence[];delivery:null|{actualQuantity:string;actualAmountMinor:string;readingKm:string|null;odometerStatus:string|null;serialNumber:string|null;identityCurrent:boolean}};
class ExecutionError extends Error{constructor(message:string,public status:number){super(message);}}
async function request<T>(url:string,body?:unknown,bytes?:File):Promise<T>{
 const response=await fetch(url,{credentials:"include",...(bytes?{method:"PUT",headers:{"Content-Type":"application/octet-stream"},body:bytes}:body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})});
 const data=await response.json().catch(()=>null);
 if(!response.ok||!data)throw new ExecutionError(data?.message??"تعذر التأكد من نتيجة الحفظ. أعد المحاولة نفسها.",!data?502:response.status);
 return data;
}
const names:Record<string,string>={odometer:"صورة العداد",wash_before:"الغسيل قبل التنفيذ",wash_after:"الغسيل بعد التنفيذ",serial:"صورة الرقم التسلسلي"};
const money=(s:string)=>/^[0-9]+$/.test(s)?(BigInt(s)/100n).toLocaleString("ar-EG")+"."+String(BigInt(s)%100n).padStart(2,"0")+" جنيه":"—";
const digits=(s:string)=>s.replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/٫/g,".");
export function ServiceOrderExecution({orderId,userId,central=false}:{orderId:string;userId:string;central?:boolean}){
 const cache=useQueryClient();const api=(central?"/api/admin":"/api/operations")+"/service-orders/"+orderId;
 const query=useQuery({queryKey:["service-order-execution",userId,orderId,central],queryFn:()=>request<Execution>(api+"/execution"),retry:false,gcTime:0,refetchOnWindowFocus:true});
 const [quantity,setQuantity]=useState("");const [reading,setReading]=useState("");const [serial,setSerial]=useState("");
 const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [image,setImage]=useState<{url:string;name:string}|null>(null);const [imageBusy,setImageBusy]=useState("");
 const [uncertain,setUncertain]=useState(false);
 const focusReturn=useRef<HTMLElement|null>(null);
 useEffect(()=>{if(!image)return;const old=document.body.style.overflow;document.body.style.overflow="hidden";const key=(event:KeyboardEvent)=>{if(event.key==="Escape")setImage(null);if(event.key==="Tab"){event.preventDefault();document.querySelector<HTMLButtonElement>(".so-image-dialog button")?.focus();}};document.addEventListener("keydown",key);return()=>{document.removeEventListener("keydown",key);document.body.style.overflow=old;focusReturn.current?.focus();};},[image]);
 const pending=useRef<{action:"start"|"deliver";body:Record<string,unknown>}|null>(null);
 const uploads=useRef<Record<string,{fingerprint:string;key:string;id?:string}>>({});
 const [files,setFiles]=useState<Record<string,File>>({});
 const data=query.data;const editable=!central&&(data?.canStart||data?.canDeliver);
 async function refresh(){await Promise.all([cache.invalidateQueries({queryKey:["service-orders"]}),cache.invalidateQueries({queryKey:["service-order-execution"]})]);}
 async function submit(action:"start"|"deliver"){
 if(!data||busy)return;setError("");setBusy(true);
 if(!pending.current)pending.current={action,body:{expectedVersion:data.version,idempotencyKey:crypto.randomUUID(),...(action==="deliver"?{input:{actualQuantity:digits(quantity),...(reading?{readingKm:digits(reading)}:{}),...(serial.trim()?{serialNumber:serial.trim()}:{})}}:{})}};
 const command=pending.current;
 try{await request<Execution>("/api/operations/service-orders/"+orderId+"/"+command.action,command.body);pending.current=null;setUncertain(false);await refresh();}
 catch(e){if(e instanceof ExecutionError&&e.status<500){pending.current=null;setUncertain(false);await refresh();}else setUncertain(true);setError(e instanceof Error?e.message:"تعذر الحفظ.");}
 finally{setBusy(false);}
 }
 function selectFile(kind:string,event:ChangeEvent<HTMLInputElement>){const file=event.target.files?.[0];if(!file)return;if(!["image/png","image/jpeg"].includes(file.type)||file.size<1||file.size>10485760){setError("اختر صورة PNG أو JPEG لا تتجاوز 10 ميجابايت.");return;}setFiles(p=>({...p,[kind]:file}));setError("");}
 async function upload(kind:string,evidenceId?:string){
 const file=files[evidenceId??kind];if(!file||busy)return;setBusy(true);setError("");
 try{
 const checksum=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer())),b=>b.toString(16).padStart(2,"0")).join("");
 const fingerprint=JSON.stringify([file.name,file.type,file.size,checksum]);
 const slot=evidenceId??kind;
 if(!uploads.current[slot]||uploads.current[slot].fingerprint!==fingerprint)uploads.current[slot]={fingerprint,key:crypto.randomUUID(),id:evidenceId};
 const attempt=uploads.current[slot];
 if(!attempt.id){const intent=await request<{id:string}>("/api/operations/service-orders/"+orderId+"/evidence",{kind,fileName:file.name,contentType:file.type,byteSize:file.size,idempotencyKey:attempt.key});attempt.id=intent.id;}
 await request("/api/operations/service-order-evidence/"+attempt.id+"/content",undefined,file);
 delete uploads.current[slot];setFiles(old=>{const n={...old};delete n[slot];return n;});await refresh();
 }catch(e){setError(e instanceof Error?e.message:"تعذر حفظ الصورة. أعد رفع الملف نفسه.");await query.refetch();}
 finally{setBusy(false);}
 }
 async function show(e:Evidence){
 focusReturn.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setImageBusy(e.id);setError("");
 try{const result=await request<{url:string}>("/api/operations/service-order-evidence/"+e.id+"/download");setImage({url:result.url,name:names[e.kind]??e.fileName});}
 catch(e){setError(e instanceof Error?e.message:"تعذر فتح الصورة.");}finally{setImageBusy("");}
 }
 if(query.isLoading)return <section className="so-execution" role="status">جارٍ تحميل توثيق التنفيذ…</section>;
 if(query.isError)return <section className="so-execution" role="alert"><p>{query.error.message}</p><button className="fleet-button fleet-quiet" onClick={()=>void query.refetch()}>إعادة المحاولة</button></section>;
 if(!data)return null;
 const rule=data.documentationRule;
 const kinds=[...(rule.odometerRequired?["odometer"]:[]),...(rule.washBeforeRequired?["wash_before"]:[]),...(rule.washAfterRequired?["wash_after"]:[]),...(rule.serialRequired?["serial"]:[])];
 return <section className="so-execution" data-testid="order-execution"><h3>تنفيذ الخدمة وتوثيقها</h3>
 <p className="fleet-muted">{data.status==="reserved"?"راجع متطلبات التوثيق ثم ابدأ قبل انتهاء مهلة الحجز.":data.status==="in_progress"?"سجّل ما نُفّذ فعليًا وارفع الصور المطلوبة.":data.delivery?"التنفيذ مسجل؛ حالة الدفع تُعرض مستقلة في الطلب.":"لا يوجد تنفيذ مسجل لهذا الطلب."}</p>
 {kinds.length>0&&<div className="so-requirements">{kinds.map(kind=><span key={kind}>{names[kind]}: {data.evidence.some(e=>e.kind===kind&&e.status==="accepted")?"مرفقة":"مطلوبة"}</span>)}</div>}
 {data.evidence.length>0&&<div className="so-evidence-grid">{data.evidence.map(e=><article key={e.id}><b>{names[e.kind]}</b><small>{e.fileName}</small>{e.status==="accepted"?<button className="fleet-button fleet-quiet" data-testid={"evidence-open-"+e.kind} disabled={imageBusy===e.id} onClick={()=>void show(e)}>{imageBusy===e.id?"جارٍ فتح الصورة…":"عرض وتكبير"}</button>:<><span>الرفع غير مكتمل</span>{editable&&<><input type="file" accept="image/png,image/jpeg" aria-label={"إعادة رفع "+e.fileName} disabled={busy||uncertain} onChange={event=>selectFile(e.id,event)}/><button className="fleet-button fleet-quiet" disabled={!files[e.id]||busy||uncertain} onClick={()=>void upload(e.kind,e.id)}>إعادة رفع الملف نفسه</button></>}</>}</article>)}</div>}
 {editable&&!uncertain&&<div className="so-evidence-inputs">{kinds.filter(kind=>kind!=="wash_before"||data.status==="reserved").filter(kind=>kind!=="wash_after"||data.status==="in_progress").map(kind=><div key={kind} className="so-upload"><label className="fleet-field">{names[kind]}<input type="file" data-testid={"evidence-file-"+kind} accept="image/png,image/jpeg" capture="environment" disabled={busy} onChange={e=>selectFile(kind,e)}/></label><button className="fleet-button fleet-quiet" data-testid={"evidence-upload-"+kind} disabled={!files[kind]||busy} onClick={()=>void upload(kind)}>{busy?"جارٍ حفظ الصورة…":"حفظ الصورة"}</button></div>)}</div>}
 {data.canStart&&!uncertain&&<button className="fleet-button" data-testid="execution-start" disabled={busy||rule.washBeforeRequired&&!data.evidence.some(e=>e.kind==="wash_before"&&e.status==="accepted")} onClick={()=>void submit("start")}>{busy?"جارٍ بدء الخدمة…":"بدء تنفيذ الخدمة"}</button>}
 {data.canDeliver&&!uncertain&&<form className="fleet-form" onSubmit={e=>{e.preventDefault();void submit("deliver");}}><label className="fleet-field">الكمية المنفذة فعليًا<input data-testid="execution-quantity" value={quantity} placeholder={data.quantity} onChange={e=>setQuantity(digits(e.target.value))} inputMode="decimal" required disabled={busy} dir="ltr"/><small>الحد المحجوز {data.quantity}؛ لا يمكن تجاوز الحجز.</small></label>
 {rule.odometerRequired&&<label className="fleet-field">قراءة العداد (كم)<input data-testid="execution-reading" value={reading} onChange={e=>setReading(digits(e.target.value))} inputMode="decimal" required disabled={busy} dir="ltr"/></label>}
 {rule.serialRequired&&<label className="fleet-field">الرقم التسلسلي<input value={serial} onChange={e=>setSerial(e.target.value)} maxLength={120} required disabled={busy}/></label>}
 <button data-testid="execution-deliver" className="fleet-button" disabled={busy}>{busy?"جارٍ تسجيل التنفيذ…":"تأكيد الكمية والتوثيق"}</button></form>}
 {uncertain&&pending.current&&<div role="status" className="so-notice"><p>نتيجة الحفظ لم تتأكد. احتُفظ بالمحاولة نفسها لمنع تكرار التنفيذ أو صرف القطع.</p><button className="fleet-button" data-testid="execution-retry" disabled={busy} onClick={()=>void submit(pending.current!.action)}>{busy?"جارٍ التحقق…":"التحقق من نتيجة الحفظ"}</button></div>}
 {data.delivery&&<div className="so-notice" data-testid="execution-delivered"><h4>التنفيذ الفعلي محفوظ</h4><p>{data.delivery.actualQuantity} · {money(data.delivery.actualAmountMinor)}</p>{data.delivery.readingKm&&<p>قراءة العداد: {data.delivery.readingKm} كم {data.delivery.odometerStatus==="pending_review"?"· تحتاج مراجعة":""}</p>}{data.kind==="product"&&<p>صُرفت الكمية المنفذة فقط، وحُرّر الجزء غير المنفذ من المخزون.</p>}<p>المبلغ المحجوز {money(data.amountMinor)}؛ لم يُسجّل دفع نهائي بعد.</p>{!data.delivery.identityCurrent&&<p role="alert">تغيّر ربط الهوية أثناء التنفيذ؛ يحتاج الطلب مراجعة قبل الدفع.</p>}</div>}
 {error&&<p role="alert" className="fleet-feedback is-error">{error}</p>}
 {image&&<div className="so-image-backdrop" role="presentation" onClick={()=>setImage(null)}><section role="dialog" aria-modal="true" aria-label={image.name} className="so-image-dialog" onClick={e=>e.stopPropagation()}><button autoFocus className="fleet-button" onClick={()=>setImage(null)}>إغلاق الصورة</button><h4>{image.name}</h4><img src={image.url} alt={image.name} onError={()=>setError("تعذر عرض الصورة أو انتهت صلاحية الرابط. أغلقها وافتحها مجددًا.")}/></section></div>}
 </section>;
}
