import {useCallback,useEffect,useRef,useState,type FormEvent} from "react";
import {useQuery} from "@tanstack/react-query";
import {formatOrderMoney as money} from "./orderDisplay";
import {parseRefundAmount} from "./refundRequestInput";
type CreditDocument={number:string;issuedAt:string;snapshot:{documentNumber:string;originalReceiptNumber:string;orderId:string;refundedAmountMinor:string;requestedAmountMinor:string;company?:{name?:string};companyBranch?:{name?:string};merchant?:{organizationName?:string;branchName?:string};vehicle?:{plate?:string};decidedBy:string;issuedAt:string}};
type Refund={id:string;amountMinor:string;category:string;note:string|null;status:"requested"|"withdrawn"|"refunded"|"rejected";version:number;createdAt:string;withdrawnAt:string|null;requestedByName:string;canWithdraw:boolean;canDecide:boolean;decision:{action:"refund"|"reject";amountMinor:string;note:string|null;decidedAt:string;decidedByName:string;document:CreditDocument|null}|null};
type View={paid:boolean;chargedAmountMinor:string;requestedAmountMinor:string;refundedAmountMinor:string;remainingRefundableMinor:string;remainingRequestableMinor:string;receiptNumber:string|null;canRequest:boolean;items:Refund[];total:number;financialRefundEnabled:boolean};
type DecisionBody={action:"refund"|"reject";amountMinor:string|null;note:string|null;expectedVersion:number;idempotencyKey:string};
type Pending={kind:"request";body:{amountMinor:string;category:string;note:string|null;idempotencyKey:string}}|{kind:"withdraw";id:string;body:{expectedVersion:number;idempotencyKey:string}}|{kind:"decide";id:string;body:DecisionBody};
const categories=[["not_received","لم تُستلم الخدمة"],["quality","جودة التنفيذ"],["quantity","اختلاف الكمية"],["billing","اختلاف الفوترة"]] as const;
const date=(value:string)=>new Date(value).toLocaleString("ar-EG",{timeZone:"Africa/Cairo",dateStyle:"medium",timeStyle:"short"});
class RefundError extends Error{constructor(message:string,public status:number){super(message);}}
async function request<T>(url:string,body?:unknown):Promise<T>{
 const r=await fetch(url,{credentials:"include",...(body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})});
 const data=await r.json().catch(()=>null);
 if(!r.ok||!data)throw new RefundError(data?.message??"تعذر التأكد من نتيجة المحاولة. أعد المحاولة بالمرجع نفسه.",data?r.status:502);
 return data;
}
function DecisionForm({refund,disabled,onSubmit}:{refund:Refund;disabled:boolean;onSubmit:(body:DecisionBody)=>void}){
 const [action,setAction]=useState<"refund"|"reject">("refund"),[amount,setAmount]=useState(()=>{const n=BigInt(refund.amountMinor);return(n/100n).toString()+"."+(n%100n).toString().padStart(2,"0");}),[note,setNote]=useState(""),[error,setError]=useState("");
 function submit(e:FormEvent){e.preventDefault();setError("");const minor=action==="refund"?parseRefundAmount(amount):null;
 if(action==="refund"&&(!minor||BigInt(minor)>BigInt(refund.amountMinor))){setError("حدّد مبلغًا موجبًا لا يتجاوز المبلغ المطلوب.");return;}
 onSubmit({action,amountMinor:minor,note:note.trim()||null,expectedVersion:refund.version,idempotencyKey:crypto.randomUUID()});}
 return <form className="so-refund-form so-refund-decision" onSubmit={submit} data-testid="refund-decision-form">
 <label className="fleet-field">قرار المالية<select data-testid="refund-decision-action" value={action} onChange={e=>setAction(e.target.value as "refund"|"reject")} disabled={disabled}><option value="refund">رد الرصيد للشركة</option><option value="reject">رفض الطلب</option></select></label>
 {action==="refund"&&<label className="fleet-field">المبلغ المعتمد بالجنيه<input data-testid="refund-decision-amount" inputMode="decimal" maxLength={20} required value={amount} onChange={e=>setAmount(e.target.value)} disabled={disabled}/></label>}
 <label className="fleet-field so-refund-note">ملاحظة للمراجعة (اختياري)<textarea maxLength={1000} value={note} onChange={e=>setNote(e.target.value)} disabled={disabled}/></label>
 <p className="so-notice so-refund-note">{action==="refund"?"تنفيذ القرار يعيد المبلغ المعتمد إلى حساب تمويل الشركة الذي خُصمت منه الخدمة، ويسجل قيدًا وإشعار رد.":"رفض الطلب يغلق المراجعة ويحفظ القرار دون تحريك رصيد."}</p>
 {error&&<p role="alert" className="fleet-feedback is-error">{error}</p>}
 <button data-testid="refund-decide" className="fleet-button" disabled={disabled}>{action==="refund"?"تنفيذ رد الرصيد":"رفض الطلب"}</button></form>;
}
function CreditDialog({document:d,onClose}:{document:CreditDocument;onClose:()=>void}){
 const close=useRef<HTMLButtonElement>(null);
 useEffect(()=>{const original=document.activeElement instanceof HTMLElement?document.activeElement:null;const overflow=document.body.style.overflow;document.body.style.overflow="hidden";close.current?.focus();
 const key=(e:KeyboardEvent)=>{if(e.key==="Escape"){e.preventDefault();onClose();}else if(e.key==="Tab"){const buttons=close.current?.closest('[role="dialog"]')?.querySelectorAll<HTMLButtonElement>("button");if(!buttons?.length)return;const first=buttons[0],last=buttons[buttons.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};
 document.addEventListener("keydown",key);return()=>{document.removeEventListener("keydown",key);document.body.style.overflow=overflow;original?.focus();};},[onClose]);
 const s=d.snapshot;
 return <div className="so-credit-overlay" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><article className="so-receipt so-credit-sheet so-credit-dialog" role="dialog" aria-modal="true" aria-labelledby="credit-title" data-testid="refund-credit-document">
 <div className="so-actions so-no-print"><button ref={close} type="button" className="fleet-button fleet-quiet" onClick={onClose}>إغلاق الإشعار</button><button type="button" className="fleet-button" onClick={()=>window.print()}>طباعة الإشعار</button></div>
 <header><div><span>PetroMax EG</span><h2 id="credit-title">إشعار رد رصيد خدمة</h2></div><b dir="ltr">{d.number}</b></header>
 <p>أُعيد المبلغ التالي إلى رصيد تمويل الشركة المرتبط بالخدمة.</p><div className="so-amount">{money(s.refundedAmountMinor)}</div>
 <dl className="so-facts"><div><dt>الشركة</dt><dd>{s.company?.name??"—"}</dd></div><div><dt>فرع الشركة</dt><dd>{s.companyBranch?.name??"—"}</dd></div><div><dt>مقدم الخدمة</dt><dd>{s.merchant?.organizationName??"—"}</dd></div><div><dt>فرع الخدمة</dt><dd>{s.merchant?.branchName??"—"}</dd></div><div><dt>المركبة</dt><dd>{s.vehicle?.plate??"—"}</dd></div><div><dt>الإيصال الأصلي</dt><dd dir="ltr">{s.originalReceiptNumber}</dd></div><div><dt>المبلغ المطلوب</dt><dd>{money(s.requestedAmountMinor)}</dd></div><div><dt>المردود الفعلي</dt><dd>{money(s.refundedAmountMinor)}</dd></div><div><dt>اعتمده</dt><dd>{s.decidedBy}</dd></div><div><dt>التاريخ</dt><dd>{date(d.issuedAt)}</dd></div></dl>
 <p className="so-reference">مرجع الخدمة <b dir="ltr">{s.orderId}</b></p><small>بيانات الضريبة غير مُعدّة لهذا المستند.</small>
 </article></div>;
}
export function ServiceRefundRequests({orderId,userId}:{orderId:string;userId:string}){
 const api="/api/admin/service-orders/"+encodeURIComponent(orderId)+"/refunds";
 const query=useQuery({queryKey:["service-refund-requests",userId,orderId],queryFn:()=>request<View>(api),retry:false,gcTime:0});
 const [amount,setAmount]=useState(""),[category,setCategory]=useState("quality"),[note,setNote]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[success,setSuccess]=useState(""),[credit,setCredit]=useState<CreditDocument|null>(null);
 const closeCredit=useCallback(()=>setCredit(null),[]);
 const pending=useRef<Pending|null>(null);
 async function execute(command:Pending){
  if(busy)return;pending.current=command;setBusy(true);setError("");setSuccess("");
  try{
   const expected=command.kind==="request"?"requested":command.kind==="withdraw"?"withdrawn":command.body.action==="refund"?"refunded":"rejected";
   const url=command.kind==="request"?api:"/api/service-refund-requests/"+encodeURIComponent(command.id)+(command.kind==="decide"?"/decide":"/withdraw");
   const result=await request<{id:string;status:string;moneyRefunded:boolean}>(url,command.body);
   if(result.status!==expected||result.moneyRefunded!==(expected==="refunded"))throw new RefundError("تعذر تأكيد نتيجة المحاولة. أعد التحقق بالمحاولة نفسها.",502);
   pending.current=null;setAmount("");setNote("");setSuccess(expected==="requested"?"سُجّل الطلب للمراجعة. لم يُردّ أي مبلغ بعد.":expected==="withdrawn"?"سُحب الطلب وحُفظ تاريخه.":expected==="refunded"?"أُعيد المبلغ المعتمد إلى رصيد تمويل الشركة، وحُفظ إشعار الرد.":"رُفض الطلب وحُفظ قرار المراجعة.");
   await query.refetch();
  }catch(e){if(e instanceof RefundError&&e.status<500){pending.current=null;await query.refetch();}setError(e instanceof Error?e.message:"تعذر إتمام المحاولة.");}
  finally{setBusy(false);}
 }
 function submit(e:FormEvent){e.preventDefault();if(busy||pending.current)return;const minor=parseRefundAmount(amount);
  if(!minor){setError("أدخل مبلغًا أكبر من صفر وبحد أقصى منزلتين عشريتين.");return;}
  if(query.data&&BigInt(minor)>BigInt(query.data.remainingRequestableMinor)){setError("المبلغ يتجاوز المتبقي بعد المبالغ المردودة والطلبات القائمة.");return;}
  void execute({kind:"request",body:{amountMinor:minor,category,note:note.trim()||null,idempotencyKey:crypto.randomUUID()}});
 }
 const d=query.data,disabled=busy||!!pending.current;
 return <><section className="so-refund-panel" data-testid="service-refund-panel" aria-label="طلبات استرداد قيمة الخدمة">
 <header><div><span className="fleet-eyebrow">الردود والمراجعة</span><h3>طلبات استرداد قيمة الخدمة</h3></div><button type="button" className="fleet-button fleet-quiet" disabled={busy||query.isFetching} onClick={()=>void query.refetch()}>تحديث الطلبات</button></header>
 {query.isLoading?<p role="status">جارٍ تحميل طلبات الاسترداد…</p>:query.isError?<div role="alert"><p>{query.error.message}</p><button type="button" className="fleet-button" onClick={()=>void query.refetch()}>إعادة المحاولة</button></div>:d&&<>
 {!d.paid?<p className="so-notice">يُتاح طلب رد قيمة الخدمة بعد تسجيل الدفع الفعلي.</p>:<>
 <dl className="so-facts"><div><dt>المدفوع الأصلي</dt><dd>{money(d.chargedAmountMinor)}</dd></div><div><dt>المردود فعليًا</dt><dd>{money(d.refundedAmountMinor)}</dd></div><div><dt>طلبات قائمة للمراجعة</dt><dd>{money(d.requestedAmountMinor)}</dd></div><div><dt>المتاح لطلب استرداد</dt><dd>{money(d.remainingRequestableMinor)}</dd></div><div><dt>الإيصال الأصلي</dt><dd dir="ltr">{d.receiptNumber??"—"}</dd></div></dl>
 <p className="so-notice">تسجيل الطلب أو سحبه لا يحرّك الأموال. يظهر المبلغ ضمن «المردود فعليًا» بعد تنفيذ قرار المالية. رد الرصيد لا يعيد قطعًا إلى المخزون.</p>
 {d.canRequest&&<form className="so-refund-form" onSubmit={submit}><label className="fleet-field">المبلغ المطلوب بالجنيه<input data-testid="refund-amount" inputMode="decimal" maxLength={20} value={amount} onChange={e=>setAmount(e.target.value)} disabled={disabled} required/></label><label className="fleet-field">نوع المشكلة<select value={category} onChange={e=>setCategory(e.target.value)} disabled={disabled}>{categories.map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label><label className="fleet-field so-refund-note">تفاصيل إضافية (اختياري)<textarea maxLength={1000} value={note} onChange={e=>setNote(e.target.value)} disabled={disabled}/></label><button data-testid="refund-submit" className="fleet-button" disabled={disabled}>{busy?"جارٍ التحقق…":"إرسال طلب للمراجعة"}</button></form>}
 {d.items.length?<ol className="so-refund-list">{d.items.map(r=><li key={r.id} data-testid="refund-request"><div><b>المطلوب: {money(r.amountMinor)}</b><span>{r.status==="withdrawn"?"مسحوب":r.status==="refunded"?"تم رد الرصيد":r.status==="rejected"?"مرفوض":"بانتظار مراجعة المالية"}</span></div><p>{categories.find(([v])=>v===r.category)?.[1]??"مشكلة مسجلة"} · {r.requestedByName} · {date(r.createdAt)}</p>{r.note&&<p>{r.note}</p>}
 {r.canWithdraw&&<button type="button" data-testid="refund-withdraw" className="fleet-button fleet-quiet" disabled={disabled} onClick={()=>void execute({kind:"withdraw",id:r.id,body:{expectedVersion:r.version,idempotencyKey:crypto.randomUUID()}})}>سحب الطلب</button>}
 {r.canDecide&&<DecisionForm refund={r} disabled={disabled} onSubmit={body=>void execute({kind:"decide",id:r.id,body})}/>}
 {r.decision&&<div className="so-refund-resolution" data-testid="refund-decision"><b>{r.decision.action==="refund"?"المردود فعليًا: "+money(r.decision.amountMinor):"لم يُعتمد رد رصيد لهذا الطلب"}</b><p>{r.decision.decidedByName} · {date(r.decision.decidedAt)}</p>{r.decision.note&&<p>{r.decision.note}</p>}{r.decision.document&&<button data-testid="refund-credit-open" type="button" className="fleet-button fleet-quiet" onClick={()=>setCredit(r.decision!.document)}>عرض إشعار الرد</button>}</div>}</li>)}</ol>:<p>لا توجد طلبات استرداد لهذا الدفع.</p>}
 {d.total>d.items.length&&<p>تُعرض الطلبات المفتوحة ثم أحدث السجلات، بإجمالي {d.items.length} من أصل {d.total}.</p>}
 </>}</>}
 {success&&<p role="status" className="so-notice">{success}</p>}{error&&<p role="alert" className="fleet-feedback is-error">{error}</p>}
 {pending.current&&!busy&&<div className="so-notice"><p>نتيجة المحاولة لم تتأكد. استخدم المحاولة نفسها قبل إرسال إجراء جديد.</p><button type="button" data-testid="refund-retry" className="fleet-button" onClick={()=>pending.current&&void execute(pending.current)}>التحقق من نتيجة المحاولة</button></div>}
 </section>{credit&&<CreditDialog document={credit} onClose={closeCredit}/>}</>;
}
