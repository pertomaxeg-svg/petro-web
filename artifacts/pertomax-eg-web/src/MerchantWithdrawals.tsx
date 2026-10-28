import {useEffect,useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
type W={id:string;version:number;status:string;amountMinor:string;originalAmountMinor:string;createdAt:string;createdByName:string;paid:boolean;bank:{name:string;beneficiaryName:string;last4:string};canCancel:boolean;canReview:boolean;items:{paymentId:string;branchName:string;receiptNumber:string;heldMinor:string}[];events:{version:number;kind:string;status:string;amountMinor:string;createdAt:string;actorName:string}[]};
type Page={items:W[];total:number;canSubmit:boolean;banks:{id:string;bankName:string;beneficiaryName:string;last4:string}[]};
type Options={items:{paymentId:string;branchName:string;receiptNumber:string;amountMinor:string;eligibleAt:string}[];total:number};
type Pending={url:string;body:Record<string,unknown>};
const labels:Record<string,string>={submitted:"بانتظار المالية",approved:"معتمد — لم يُسدّد",rejected:"مرفوض",cancelled:"ملغى",refund_adjusted:"تعديل بعد استرداد"};
const money=(v:string)=>{const n=BigInt(v);return new Intl.NumberFormat("ar-EG",{maximumFractionDigits:0}).format(n/100n)+"٫"+new Intl.NumberFormat("ar-EG",{minimumIntegerDigits:2,maximumFractionDigits:0}).format(n%100n)+" ج.م";};
const date=(v:string)=>new Date(v).toLocaleString("ar-EG",{timeZone:"Africa/Cairo",dateStyle:"medium",timeStyle:"short"});
class WithdrawalError extends Error{constructor(message:string,public status:number){super(message);}}
async function call<T>(url:string,body?:unknown,signal?:AbortSignal):Promise<T>{
 const r=await fetch(url,{credentials:"include",signal,...(body?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}:{})});
 const j=await r.json().catch(()=>null);if(!r.ok||!j)throw new WithdrawalError(j?.message??"تعذر تأكيد النتيجة. أعد المحاولة نفسها.",j?r.status:502);return j;
}
export function MerchantWithdrawals({organizationId,userId,onPending}:{organizationId:string;userId:string;onPending:(v:boolean)=>void}){
 const [page,setPage]=useState(1),[optionPage,setOptionPage]=useState(1),[bank,setBank]=useState(""),[selected,setSelected]=useState<Record<string,string>>({}),[pending,setPending]=useState<Pending|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const cache=useQueryClient();const base="/api/finance/merchant-withdrawals/"+organizationId;
 const q=useQuery({queryKey:["merchant-withdrawals",userId,organizationId,page],queryFn:({signal})=>call<Page>(base+"?page="+page,undefined,signal),retry:false,gcTime:0});
 const options=useQuery({queryKey:["merchant-withdrawal-options",userId,organizationId,optionPage],queryFn:({signal})=>call<Options>(base+"/options?page="+optionPage,undefined,signal),enabled:!!q.data?.canSubmit,retry:false,gcTime:0});
 useEffect(()=>{onPending(!!pending);return()=>onPending(false);},[pending,onPending]);
 const refresh=async()=>{await Promise.all([cache.invalidateQueries({queryKey:["merchant-withdrawals",userId,organizationId]}),cache.invalidateQueries({queryKey:["merchant-withdrawal-options",userId,organizationId]}),cache.invalidateQueries({queryKey:["merchant-statement",userId]})]);};
 async function send(command:Pending){
  if(busy)return;setPending(command);setBusy(true);setError("");setNotice("");
  try{await call(command.url,command.body);setPending(null);setSelected({});setNotice("حُفظ الإجراء. لا يعني هذا تحويلًا بنكيًا أو سدادًا.");await refresh();}
  catch(e){const x=e as WithdrawalError;setError(x.message);if(x.status>=400&&x.status<500){setPending(null);await refresh();}}
  finally{setBusy(false);}
 }
 const act=(w:W,action:string)=>void send({url:"/api/finance/merchant-withdrawals/"+w.id+"/review",body:{expectedVersion:w.version,action,idempotencyKey:crypto.randomUUID()}});
 const count=Object.keys(selected).length;const total=Object.values(selected).reduce((n,s)=>n+BigInt(s),0n).toString();
 return <section className="ms-section mw-panel" aria-labelledby="mw-title">
 <header><div><span className="ms-eyebrow">حجز المستحقات والمراجعة</span><h2 id="mw-title">طلبات السحب</h2></div><button disabled={busy} onClick={()=>void refresh()}>تحديث الطلبات</button></header>
 <p className="mw-note">الطلب مركزي للجهة، ويجمع الفروع المختارة مرة واحدة. يلزم حساب بنكي معتمد. الاعتماد هنا لا يثبت الصرف، وتسجيل التحويل بإثباته مرحلة لاحقة.</p>
 {q.isLoading?<p role="status">جارٍ تحميل الطلبات…</p>:q.isError?<div role="alert"><p>{q.error.message}</p>{(q.error as WithdrawalError).status===403?<p>مدير الفرع يتابع كشف فرعه؛ الطلب المركزي يقدمه مدير الجهة أو ماليها المخوّل على مستوى الجهة.</p>:<button onClick={()=>void q.refetch()}>إعادة المحاولة</button>}</div>:q.data&&<>
 {q.data.canSubmit&&<form className="mw-form" onSubmit={e=>{e.preventDefault();if(!pending&&count&&bank)void send({url:base,body:{bankVersionId:bank,paymentIds:Object.keys(selected),idempotencyKey:crypto.randomUUID()}});}}>
 <label>حساب المستفيد المعتمد<select data-testid="withdrawal-bank" disabled={!!pending} value={bank} onChange={e=>setBank(e.target.value)} required><option value="">اختر الحساب البنكي</option>{q.data.banks.map(b=><option value={b.id} key={b.id}>{b.bankName} · {b.beneficiaryName} · •••• {b.last4}</option>)}</select></label>
 {!q.data.banks.length&&<p className="mw-note">لا يوجد حساب بنكي معتمد؛ يلزم استكمال بيانات البنك واعتمادها من قسم بيانات الجهة قبل تقديم الطلب.</p>}
 <fieldset disabled={!!pending}><legend>اختر الخدمات المؤهلة غير المحجوزة</legend>
 {options.isLoading?<p role="status">جارٍ تحميل المؤهل…</p>:options.isError?<div role="alert"><p>{options.error.message}</p><button type="button" onClick={()=>void options.refetch()}>إعادة المحاولة</button></div>:options.data&&!options.data.items.length?<p data-testid="withdrawal-no-options">لا توجد مستحقات مؤهلة غير محجوزة في هذه الصفحة.</p>:options.data?.items.map(x=><label className="mw-option" key={x.paymentId}><input type="checkbox" data-testid="withdrawal-select" data-payment={x.paymentId} checked={selected[x.paymentId]!==undefined} disabled={!selected[x.paymentId]&&count>=100} onChange={e=>setSelected(s=>{const n={...s};if(e.target.checked)n[x.paymentId]=x.amountMinor;else delete n[x.paymentId];return n;})}/><span><b>{x.receiptNumber}</b><small>{x.branchName} · أهلية {date(x.eligibleAt)}</small></span><strong>{money(x.amountMinor)}</strong></label>)}
 {!!options.data?.total&&<div className="ms-pagination"><button type="button" disabled={optionPage===1} onClick={()=>setOptionPage(p=>p-1)}>السابق للمستحقات</button><span>صفحة {optionPage}</span><button type="button" disabled={optionPage*20>=options.data.total} onClick={()=>setOptionPage(p=>p+1)}>التالي للمستحقات</button></div>}
 </fieldset>
 <div className="mw-submit"><span>{count.toLocaleString("ar-EG")} خدمة · {money(total)}</span><button data-testid="withdrawal-submit" disabled={!!pending||!count||!bank}>حجز المستحقات وإرسال الطلب</button></div>
 </form>}
 {error&&<div className="mw-feedback" role="alert">{error}</div>}{notice&&<p className="mw-feedback" role="status">{notice}</p>}
 {pending&&<div className="mw-feedback" role="status"><p>نتيجة المحاولة تحتاج تأكيدًا. أعد نفس المحاولة قبل تغيير الجهة أو إنشاء إجراء آخر.</p><button data-testid="withdrawal-retry" disabled={busy} onClick={()=>void send(pending)}>{busy?"جارٍ التأكيد…":"إعادة المحاولة نفسها"}</button></div>}
 {!q.data.items.length?<p className="ms-empty" data-testid="withdrawal-empty">لا توجد طلبات سحب في هذه الجهة بعد.</p>:<div className="mw-list">{q.data.items.map(w=><article key={w.id} className="mw-request" data-testid="withdrawal-request"><header><div><b>{labels[w.status]??"حالة غير معروفة"}</b><p>{date(w.createdAt)} · {w.createdByName}</p></div><strong>{money(w.amountMinor)}<small>محجوز غير مسدّد</small></strong></header><p>{w.bank.name} · {w.bank.beneficiaryName} · <bdi>•••• {w.bank.last4}</bdi></p><details><summary>تفاصيل الفروع وسجل المراجعة</summary><ul>{w.items.map(x=><li key={x.paymentId}><span>{x.branchName} · {x.receiptNumber}</span><strong>{money(x.heldMinor)}</strong></li>)}</ul><ol>{w.events.map(e=><li key={e.version}>{labels[e.kind]??labels[e.status]} · {date(e.createdAt)} · {e.actorName} · {money(e.amountMinor)}</li>)}</ol><small>مرجع الطلب: {w.id}</small></details><footer>{w.canReview&&<><button data-testid="withdrawal-approve" disabled={!!pending} onClick={()=>act(w,"approve")}>اعتماد الطلب</button><button disabled={!!pending} onClick={()=>act(w,"reject")}>رفض وتحرير الحجز</button></>}{w.canCancel&&<button data-testid="withdrawal-cancel" disabled={!!pending} onClick={()=>act(w,"cancel")}>إلغاء وتحرير الحجز</button>}</footer></article>)}</div>}
 <nav className="ms-pagination" aria-label="صفحات طلبات السحب"><button disabled={!!pending||page===1} onClick={()=>setPage(p=>p-1)}>السابق</button><span>صفحة {page} · {q.data.total.toLocaleString("ar-EG")} طلب</span><button disabled={!!pending||page*20>=q.data.total} onClick={()=>setPage(p=>p+1)}>التالي</button></nav>
 </>}
 </section>;
}
