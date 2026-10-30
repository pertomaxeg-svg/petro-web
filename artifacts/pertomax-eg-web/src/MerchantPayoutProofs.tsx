import {useEffect,useState} from "react";
import {useQuery} from "@tanstack/react-query";
type Proof={id:string;withdrawalVersion:number;fileName:string;contentType:string;byteSize:number;status:"pending"|"accepted";current:boolean;uploadAllowed:boolean;expiresAt:string;createdAt:string;acceptedAt:string|null;uploaderName:string;sha256:string|null};
type View={withdrawalId:string;version:number;canUpload:boolean;items:Proof[];bankPayoutEnabled:boolean};
type Pending={file:File;key:string;id?:string};
class ProofError extends Error{constructor(message:string,public status:number){super(message);}}
async function json<T>(url:string,options?:RequestInit):Promise<T>{const r=await fetch(url,{credentials:"include",...options});const d=await r.json().catch(()=>null);if(!r.ok||!d)throw new ProofError(d?.message??"تعذر تأكيد النتيجة؛ أعد المحاولة نفسها.",d?r.status:502);return d;}
const date=(s:string)=>new Date(s).toLocaleString("ar-EG",{timeZone:"Africa/Cairo",dateStyle:"medium",timeStyle:"short"});
export function MerchantPayoutProofs({withdrawalId,version,userId,onPending}:{withdrawalId:string;version:number;userId:string;onPending:(value:boolean)=>void}){
 const [fileInputKey,setFileInputKey]=useState(0);
 const [file,setFile]=useState<File|null>(null),[pending,setPending]=useState<Pending|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const url="/api/finance/merchant-withdrawals/"+withdrawalId+"/proofs";
 const q=useQuery({queryKey:["merchant-payout-proofs",userId,withdrawalId,version],queryFn:({signal})=>json<View>(url,{signal}),retry:false,gcTime:0});
 useEffect(()=>{onPending(!!pending);return()=>onPending(false);},[pending,onPending]);
 async function upload(attempt:Pending){
 if(busy)return;setPending(attempt);setBusy(true);setError("");setNotice("");
 try{
 let id=attempt.id;if(!id){const intent=await json<{id:string}>(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({expectedVersion:version,fileName:attempt.file.name,contentType:attempt.file.type,byteSize:attempt.file.size,idempotencyKey:attempt.key})});id=intent.id;attempt={...attempt,id};setPending(attempt);}
 await json("/api/finance/merchant-payout-proofs/"+id+"/content",{method:"PUT",headers:{"Content-Type":"application/octet-stream"},body:attempt.file});
 setPending(null);setFile(null);setFileInputKey(k=>k+1);setNotice("قُبل الملف الخاص وحُفظت بصمته. حالة الطلب المالية لم تتغير.");await q.refetch();
 }catch(e){const x=e as ProofError;setError(x.message);if(x.status>=400&&x.status<500){setPending(null);await q.refetch();}}
 finally{setBusy(false);}
 }
 const valid=!!file&&["application/pdf","image/png","image/jpeg"].includes(file.type)&&file.size>0&&file.size<=10485760;
 return <section className="mw-proof" aria-label="إثبات التحويل البنكي">
 <h3>إثبات التحويل البنكي</h3><p>ملف خاص للمراجعة. قبول الملف لا يثبت السداد ولا ينشئ تحويلًا بنكيًا. يرتبط الإثبات بنسخة الاعتماد الحالية؛ أي تعديل لاحق يظهر في السجل.</p>
 {q.isLoading?<p role="status">جارٍ تحميل الإثباتات…</p>:q.isError?<div role="alert"><p>{q.error.message}</p><button type="button" onClick={()=>void q.refetch()}>إعادة المحاولة</button></div>:q.data&&<>
 {q.data.canUpload&&<div className="mw-proof-form"><label>ملف PDF أو PNG أو JPEG حتى10 ميجابايت<input key={fileInputKey} data-testid="payout-proof-file" type="file" accept="application/pdf,image/png,image/jpeg" disabled={!!pending} onChange={e=>{setFile(e.target.files?.[0]??null);setError("");setNotice("");}}/></label>{file&&!valid&&<p role="alert">نوع الملف أو حجمه غير مسموح.</p>}<button data-testid="payout-proof-upload" type="button" disabled={!valid||!!pending} onClick={()=>file&&void upload({file,key:crypto.randomUUID()})}>رفع الإثبات الخاص</button></div>}
 {error&&<p role="alert" className="mw-feedback">{error}</p>}{notice&&<p role="status" className="mw-feedback">{notice}</p>}
 {pending&&<div className="mw-feedback" role="status"><p>{busy?"جارٍ التحقق من الملف وحفظه…":"نتيجة المحاولة تحتاج تأكيدًا؛ أعد رفع الملف نفسه."}</p><button data-testid="payout-proof-retry" type="button" disabled={busy} onClick={()=>void upload(pending)}>إعادة المحاولة نفسها</button></div>}
 {!q.data.items.length?<p data-testid="payout-proof-empty">لا توجد إثباتات على هذا الطلب.</p>:<ul className="mw-proof-list">{q.data.items.map(p=><li key={p.id} data-testid="payout-proof-row"><div><b>{p.fileName}</b><small>{p.uploaderName} · {date(p.createdAt)} · نسخة {p.withdrawalVersion.toLocaleString("ar-EG")}</small><strong>{p.status==="pending"?(p.uploadAllowed?"لم يكتمل الرفع":"تحتاج محاولة رفع جديدة"):p.current?"مقبول للنسخة الحالية":"محفوظ لنسخة سابقة"}</strong></div>{p.status==="accepted"?<a data-testid="payout-proof-download" href={"/api/finance/merchant-payout-proofs/"+p.id+"/content"} target="_blank" rel="noopener noreferrer">تنزيل الإثبات</a>:q.data.canUpload&&p.uploadAllowed&&p.withdrawalVersion===version&&<button type="button" disabled={!!pending||!file||file.name!==p.fileName||file.size!==p.byteSize||file.type!==p.contentType} onClick={()=>file&&void upload({file,key:crypto.randomUUID(),id:p.id})}>إكمال الملف المحدد</button>}</li>)}</ul>}
 </>}
 </section>;
}
