import {useRef,useState,type FormEvent} from "react";
import {useQuery} from "@tanstack/react-query";
import {formatOrderMoney as money} from "./orderDisplay";
import {parseRefundAmount} from "./refundRequestInput";
type Refund={id:string;amountMinor:string;category:string;note:string|null;status:"requested"|"withdrawn";version:number;createdAt:string;withdrawnAt:string|null;requestedByName:string;canWithdraw:boolean};
type View={paid:boolean;chargedAmountMinor:string;requestedAmountMinor:string;remainingRequestableMinor:string;receiptNumber:string|null;canRequest:boolean;items:Refund[];total:number;financialRefundEnabled:boolean};
type Pending={kind:"request";body:{amountMinor:string;category:string;note:string|null;idempotencyKey:string}}|{kind:"withdraw";id:string;body:{expectedVersion:number;idempotencyKey:string}};
const categories=[["not_received","لم تُستلم الخدمة"],["quality","جودة التنفيذ"],["quantity","اختلاف الكمية"],["billing","اختلاف الفوترة"]] as const;
class RefundError extends Error{constructor(message:string,public status:number){super(message);}}
async function request<T>(url:string,body?:unknown):Promise<T>{
 const r=await fetch(url,{credentials:"include",...(body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})});
 const data=await r.json().catch(()=>null);
 if(!r.ok||!data)throw new RefundError(data?.message??"تعذر التأكد من نتيجة المحاولة. أعد المحاولة بالمرجع نفسه.",data?r.status:502);
 return data;
}
export function ServiceRefundRequests({orderId,userId}:{orderId:string;userId:string}){
 const api="/api/admin/service-orders/"+encodeURIComponent(orderId)+"/refunds";
 const query=useQuery({queryKey:["service-refund-requests",userId,orderId],queryFn:()=>request<View>(api),retry:false,gcTime:0});
 const [amount,setAmount]=useState(""),[category,setCategory]=useState("quality"),[note,setNote]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[success,setSuccess]=useState("");
 const pending=useRef<Pending|null>(null);
 async function execute(command:Pending){
  if(busy)return;pending.current=command;setBusy(true);setError("");setSuccess("");
  try{
   const result=await request<{id:string;status:string;moneyRefunded:boolean}>(command.kind==="request"?api:"/api/service-refund-requests/"+encodeURIComponent(command.id)+"/withdraw",command.body);
   if(result.status!==(command.kind==="request"?"requested":"withdrawn")||result.moneyRefunded!==false)throw new RefundError("تعذر تأكيد حالة طلب الاسترداد. أعد التحقق بالمحاولة نفسها.",502);
   pending.current=null;setAmount("");setNote("");setSuccess(command.kind==="request"?"سُجّل طلب الاسترداد للمراجعة. لم يُردّ أي مبلغ بعد.":"سُحب طلب الاسترداد وحُفظ تاريخه.");
   await query.refetch();
  }catch(e){
   if(e instanceof RefundError&&e.status<500){pending.current=null;await query.refetch();}
   setError(e instanceof Error?e.message:"تعذر تسجيل الطلب.");
  }finally{setBusy(false);}
 }
 function submit(e:FormEvent){
  e.preventDefault();if(busy||pending.current)return;
  const minor=parseRefundAmount(amount);
  if(!minor){setError("أدخل مبلغًا أكبر من صفر وبحد أقصى منزلتين عشريتين.");return;}
  if(query.data&&BigInt(minor)>BigInt(query.data.remainingRequestableMinor)){setError("المبلغ يتجاوز الجزء المتاح بعد الطلبات القائمة.");return;}
  void execute({kind:"request",body:{amountMinor:minor,category,note:note.trim()||null,idempotencyKey:crypto.randomUUID()}});
 }
 const d=query.data;
 return <section className="so-refund-panel" data-testid="service-refund-panel" aria-label="طلبات استرداد قيمة الخدمة">
 <header><div><span className="fleet-eyebrow">الردود والمراجعة</span><h3>طلبات استرداد قيمة الخدمة</h3></div><button type="button" className="fleet-button fleet-quiet" disabled={busy||query.isFetching} onClick={()=>void query.refetch()}>تحديث الطلبات</button></header>
 {query.isLoading?<p role="status">جارٍ تحميل طلبات الاسترداد…</p>:query.isError?<div role="alert"><p>{query.error.message}</p><button type="button" className="fleet-button" onClick={()=>void query.refetch()}>إعادة المحاولة</button></div>:d&&<>
 {!d.paid?<p className="so-notice">يُتاح طلب رد قيمة الخدمة بعد تسجيل الدفع الفعلي.</p>:<>
 <dl className="so-facts"><div><dt>المدفوع الأصلي</dt><dd>{money(d.chargedAmountMinor)}</dd></div><div><dt>طلبات قائمة للمراجعة</dt><dd>{money(d.requestedAmountMinor)}</dd></div><div><dt>المتاح لطلب استرداد</dt><dd>{money(d.remainingRequestableMinor)}</dd></div><div><dt>الإيصال الأصلي</dt><dd dir="ltr">{d.receiptNumber??"—"}</dd></div></dl>
 <p className="so-notice">الطلب ينتظر مراجعة المالية. تسجيله أو سحبه لا يحرك الأموال ولا يعيد قطعًا إلى المخزون.</p>
 {d.canRequest&&<form className="so-refund-form" onSubmit={submit}><label className="fleet-field">المبلغ المطلوب بالجنيه<input data-testid="refund-amount" inputMode="decimal" maxLength={20} value={amount} onChange={e=>setAmount(e.target.value)} disabled={busy||!!pending.current} required/></label><label className="fleet-field">نوع المشكلة<select value={category} onChange={e=>setCategory(e.target.value)} disabled={busy||!!pending.current}>{categories.map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label><label className="fleet-field so-refund-note">تفاصيل إضافية (اختياري)<textarea maxLength={1000} value={note} onChange={e=>setNote(e.target.value)} disabled={busy||!!pending.current}/></label><button data-testid="refund-submit" className="fleet-button" disabled={busy||!!pending.current}>{busy?"جارٍ التحقق…":"إرسال طلب للمراجعة"}</button></form>}
 {d.items.length?<ol className="so-refund-list">{d.items.map(r=><li key={r.id} data-testid="refund-request"><div><b>{money(r.amountMinor)}</b><span>{r.status==="withdrawn"?"مسحوب":"بانتظار مراجعة المالية"}</span></div><p>{categories.find(([v])=>v===r.category)?.[1]??"مشكلة مسجلة"} · {r.requestedByName} · {new Date(r.createdAt).toLocaleString("ar-EG",{timeZone:"Africa/Cairo"})}</p>{r.note&&<p>{r.note}</p>}{r.canWithdraw&&<button type="button" data-testid="refund-withdraw" className="fleet-button fleet-quiet" disabled={busy||!!pending.current} onClick={()=>void execute({kind:"withdraw",id:r.id,body:{expectedVersion:r.version,idempotencyKey:crypto.randomUUID()}})}>سحب الطلب</button>}</li>)}</ol>:<p>لا توجد طلبات استرداد لهذا الدفع.</p>}
 {d.total>d.items.length&&<p>تُعرض الطلبات المفتوحة ثم أحدث السجلات، بإجمالي {d.items.length} من أصل {d.total}.</p>}
 </>}
 </>}
 {success&&<p role="status" className="so-notice">{success}</p>}
 {error&&<p role="alert" className="fleet-feedback is-error">{error}</p>}
 {pending.current&&!busy&&<div className="so-notice"><p>نتيجة المحاولة لم تتأكد. استخدم المحاولة نفسها قبل إرسال طلب جديد.</p><button type="button" data-testid="refund-retry" className="fleet-button" onClick={()=>pending.current&&void execute(pending.current)}>التحقق من نتيجة المحاولة</button></div>}
 </section>;
}
