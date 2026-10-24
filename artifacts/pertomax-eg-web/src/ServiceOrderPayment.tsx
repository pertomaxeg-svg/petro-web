import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatOrderMoney as money } from "./orderDisplay";
type Snapshot={item?:{name?:string};vehicle?:{plate?:string;driverName?:string};merchant?:{organizationName?:string;branchName?:string};company?:{name?:string};companyBranch?:{name?:string};quantity?:string;workerName?:string};
type Payment={bookedAmountMinor:string;chargedAmountMinor:string;releasedAmountMinor:string;confirmedAt:string;receipt:{number:string;issuedAt:string;snapshot:Snapshot};receivable:{earnedAmountMinor:string;eligibleAt:string}};
type State={orderId:string;status:string;paymentStatus:string;version:number;paid:boolean;valid?:boolean;locked?:boolean;retryAt?:string|null;bookedAmountMinor:string;actualAmountMinor:string|null;canConfirm:boolean;pinConfirmationReady:boolean;payment:Payment|null};
class PaymentError extends Error{constructor(message:string,public status:number){super(message);}}
async function request(url:string,body?:unknown):Promise<State>{
 const response=await fetch(url,{credentials:"include",...(body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})});
 const data=await response.json().catch(()=>null);
 if(!response.ok||!data)throw new PaymentError(data?.message??"تعذر التأكد من نتيجة الدفع؛ أعد المحاولة نفسها.",!data?502:response.status);
 return data;
}
const digits=(s:string)=>s.replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776));
const date=(s:string)=>new Date(s).toLocaleString("ar-EG",{dateStyle:"medium",timeStyle:"short",timeZone:"Africa/Cairo"});
export function ServiceOrderPayment({orderId,userId,central=false}:{orderId:string;userId:string;central?:boolean}){
 const cache=useQueryClient();const api=(central?"/api/admin":"/api/operations")+"/service-orders/"+orderId;
 const query=useQuery({queryKey:["service-order-payment",userId,orderId,central],queryFn:()=>request(api+"/payment"),retry:false,gcTime:0,refetchOnWindowFocus:true});
 const [pin,setPin]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [uncertain,setUncertain]=useState(false);
 const pending=useRef<{fingerprint:string;key:string;expectedVersion:number}|null>(null);
 const data=query.data;
 async function confirm(event:FormEvent){
 event.preventDefault();if(!data||busy||!/^\d{4}$/.test(pin))return;
 const entered=pin;setPin("");setError("");setBusy(true);
 try{
 const fingerprint=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(orderId+"\0"+entered))),b=>b.toString(16).padStart(2,"0")).join("");
 if(pending.current&&pending.current.fingerprint!==fingerprint){setError("أعد إدخال الرمز نفسه الذي استُخدم في المحاولة غير المؤكدة للتحقق من نتيجتها.");return;}
 if(!pending.current)pending.current={fingerprint,key:crypto.randomUUID(),expectedVersion:data.version};
 const command=pending.current;
 const result=await request("/api/operations/service-orders/"+orderId+"/confirm",{expectedVersion:command.expectedVersion,idempotencyKey:command.key,pinCode:entered});
 if(result.paid!==true&&result.valid!==false)throw new PaymentError("استجابة الدفع غير مكتملة؛ أعد التحقق بالمحاولة نفسها.",502);
 pending.current=null;setUncertain(false);
 if(!result.paid)setError(result.locked?"توقف التحقق مؤقتًا بعد محاولات غير صحيحة."+ (result.retryAt?" أعد المحاولة بعد "+date(result.retryAt):""):"رمز التعبئة غير صحيح. لم يُخصم مبلغ.");
 await Promise.all([cache.invalidateQueries({queryKey:["service-orders"]}),cache.invalidateQueries({queryKey:["service-order-execution"]}),cache.invalidateQueries({queryKey:["service-order-payment"]})]);
 }catch(e){
 if(e instanceof PaymentError&&e.status<500){pending.current=null;setUncertain(false);await query.refetch();}
 else setUncertain(true);
 setError(e instanceof Error?e.message:"تعذر التحقق من الدفع.");
 }finally{setBusy(false);}
 }
 if(query.isLoading)return <section className="so-execution" role="status">جارٍ تحميل حالة الدفع…</section>;
 if(query.isError)return <section className="so-execution" role="alert"><p>{query.error.message}</p><button className="fleet-button fleet-quiet" onClick={()=>void query.refetch()}>إعادة تحميل الدفع</button></section>;
 if(!data)return null;
 const payment=data.payment;const receipt=payment?.receipt;const snapshot=receipt?.snapshot;
 return <section className="so-execution" data-testid="order-payment"><h3>تأكيد الدفع والإيصال</h3>
 {payment&&receipt?<><div className="so-notice" data-testid="payment-paid"><b>تم الدفع وتسجيل الإيصال</b><p>خُصم {money(payment.chargedAmountMinor)}، وحُرّر من الحجز {money(payment.releasedAmountMinor)}.</p></div>
 <article className="so-receipt" aria-label="إيصال الخدمة" data-testid="payment-receipt"><header><h3>بتروماكس · إيصال خدمة</h3><b dir="ltr">{receipt.number}</b><p>{date(receipt.issuedAt)}</p></header>
 <dl className="so-facts"><div><dt>الجهة والفرع</dt><dd>{snapshot?.company?.name??"—"} · {snapshot?.companyBranch?.name??"—"}</dd></div><div><dt>مقدم الخدمة</dt><dd>{snapshot?.merchant?.organizationName??"—"} · {snapshot?.merchant?.branchName??"—"}</dd></div><div><dt>المركبة والسائق</dt><dd>{snapshot?.vehicle?.plate??"—"} · {snapshot?.vehicle?.driverName??"—"}</dd></div><div><dt>الخدمة</dt><dd>{snapshot?.item?.name??"—"} · {snapshot?.quantity??"—"}</dd></div><div><dt>قيمة الحجز</dt><dd>{money(payment.bookedAmountMinor)}</dd></div><div><dt>المدفوع فعليًا</dt><dd>{money(payment.chargedAmountMinor)}</dd></div><div><dt>المبلغ المحرر</dt><dd>{money(payment.releasedAmountMinor)}</dd></div><div><dt>العامل</dt><dd>{snapshot?.workerName??"—"}</dd></div></dl><small>إيصال خدمة؛ لا يمثل فاتورة ضريبية. مرجع الطلب: <span dir="ltr">{orderId}</span></small>
 </article><button className="fleet-button fleet-quiet so-no-print" data-testid="payment-print" onClick={()=>window.print()}>طباعة الإيصال</button></>:<><p className="fleet-muted">{data.actualAmountMinor?"قيمة التنفيذ الفعلية "+money(data.actualAmountMinor)+" من حجز "+money(data.bookedAmountMinor)+".":"يظهر تأكيد الدفع بعد تسجيل التنفيذ وتوثيقه."}</p>{data.status==="review_required"&&<p role="status">التنفيذ يحتاج مراجعة العمليات قبل إتاحة الدفع.</p>}</>}
 {!central&&(data.canConfirm||uncertain)&&<>{!data.pinConfirmationReady&&!uncertain?<p role="status">تأكيد الرمز غير متاح حاليًا. أعد تحميل حالة الدفع لاحقًا.</p>:<form className="fleet-form so-payment-form" onSubmit={e=>void confirm(e)}><label className="fleet-field">رمز التعبئة للتأكيد النهائي<input data-testid="payment-pin" type="password" value={pin} onChange={e=>setPin(digits(e.target.value).replace(/[^0-9]/g,"").slice(0,4))} inputMode="numeric" autoComplete="off" maxLength={4} pattern="[0-9]{4}" required disabled={busy} dir="ltr"/><small>{uncertain?"أعد إدخال الرمز نفسه للتحقق من المحاولة السابقة.":"أعد إدخال الرمز المستخدم عند بدء الطلب بعد مراجعة التنفيذ."}</small></label><button className="fleet-button" data-testid="payment-confirm" disabled={busy||pin.length!==4}>{busy?"جارٍ التحقق من الدفع…":uncertain?"التحقق من نتيجة الدفع":"تأكيد الدفع وإصدار الإيصال"}</button></form>}</>}
 {uncertain&&<p role="status" data-testid="payment-uncertain">لم تتأكد استجابة الدفع. احتُفظ بمرجع المحاولة دون حفظ الرمز لمنع تكرار الخصم.</p>}
 {error&&<p role="alert" className="fleet-feedback is-error">{error}</p>}
 </section>;
}
