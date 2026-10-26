import { ServiceRefundRequests } from "./ServiceRefundRequests";
import { useRef, useState, type FormEvent } from "react";
import { Link, useRoute } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGetAuthMe, getGetAuthMeQueryKey } from "@workspace/api-client-react";
import "./FleetAdmin.css";
import "./ServiceOrders.css";
import { formatOrderMoney as money } from "./orderDisplay";
import { ServiceOrderPayment } from "./ServiceOrderPayment";
import { ServiceOrderExecution } from "./ServiceOrderExecution";

type Order={
 id:string;status:string;paymentStatus:string;version:number;serviceGroup:string;kind:string;
 quantity:string;amountMinor:string;currency:string;
 itemSnapshot:{name?:string;unitCode?:string};vehicleSnapshot:{plate?:string;brand?:string;model?:string;driverName?:string};
 merchantSnapshot:{organizationName?:string;branchName?:string};
 createdAt:string;expiresAt:string;startedAt:string|null;cancelledAt:string|null;cancelCode:string|null;cancelledByKind:string|null;
 canCancel:boolean;requiresReview:boolean;expiryAttempts:number;
 timeline?:{id:string;kind:string;version:number;createdAt:string;actorKind:string;actorName:string;detail:Record<string,unknown>}[];
};
type List={items:Order[];total:number;page:number;pageSize:number;canManage:boolean};
const states:Record<string,string>={reserved:"محجوز",in_progress:"قيد التنفيذ",delivered:"تم التسليم",review_required:"يحتاج مراجعة",cancelled:"ملغى"};
const payments:Record<string,string>={held:"المبلغ محجوز",unpaid:"غير مدفوع",paid:"مدفوع"};
const services:Record<string,string>={fuel:"وقود",wash:"غسيل",oils:"زيوت",parts:"قطع غيار",batteries:"بطاريات",filters:"فلاتر",consumables:"مستهلكات"};
const eventNames:Record<string,string>={paid:"تأكيد الدفع وإصدار الإيصال",started:"بدء تنفيذ الخدمة",delivered:"تسجيل التنفيذ الفعلي",reserved:"حجز المال والمخزون المطلوب",cancelled:"إلغاء الحجز وتحرير الموارد",expiry_failed:"تعذّر تحرير الحجز تلقائيًا"};
const units:Record<string,string>={litre:"لتر",piece:"قطعة",service:"خدمة",pack:"عبوة"};
const date=(value:string|null)=>value?new Date(value).toLocaleString("ar-EG",{dateStyle:"medium",timeStyle:"short",timeZone:"Africa/Cairo"}):"—";
class OrderError extends Error{constructor(message:string,public status:number){super(message);}}
async function request<T>(url:string,body?:unknown):Promise<T>{
 const r=await fetch(url,{credentials:"include",...(body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})});
 const d=await r.json().catch(()=>null);
 if(!r.ok||!d)throw new OrderError(d?.message??"تعذر التأكد من نتيجة الطلب. أعد المحاولة.",!d?502:r.status);
 return d;
}
function Summary({order:o}:{order:Order}){
 return <><div className="so-status-row"><span className={"so-badge so-"+o.status}>{states[o.status]??"حالة غير معروفة"}</span><span className="so-payment">{payments[o.paymentStatus]??"حالة دفع غير معروفة"}</span><span>{services[o.serviceGroup]??"خدمة"}</span></div>
 <h2>{o.itemSnapshot.name??"صنف الطلب"}</h2><small className="so-amount-caption">قيمة الحجز</small><div className="so-amount">{money(o.amountMinor)}</div>
 <dl className="so-facts"><div><dt>المركبة</dt><dd>{o.vehicleSnapshot.plate??"—"} · {[o.vehicleSnapshot.brand,o.vehicleSnapshot.model].filter(Boolean).join(" ")}</dd></div>
 <div><dt>السائق</dt><dd>{o.vehicleSnapshot.driverName??"—"}</dd></div>
 <div><dt>مقدم الخدمة والفرع</dt><dd>{o.merchantSnapshot.organizationName??"—"} · {o.merchantSnapshot.branchName??"—"}</dd></div>
 <div><dt>الكمية</dt><dd>{o.quantity} {units[o.itemSnapshot.unitCode??""]??o.itemSnapshot.unitCode??""}</dd></div>
 <div><dt>وقت الحجز</dt><dd>{date(o.createdAt)}</dd></div><div><dt>مهلة بدء الخدمة</dt><dd>{date(o.expiresAt)}</dd></div></dl></>;
}
export function ServiceOrdersPage({central=false,canManage=true}:{central?:boolean;canManage?:boolean}){
 const me=useGetAuthMe({query:{queryKey:getGetAuthMeQueryKey(),retry:false}});
 const prefix=central?"/admin/service-orders":"/operations/orders";
 const api=central?"/api/admin/service-orders":"/api/operations/service-orders";
 const [,workerParams]=useRoute("/operations/orders/:id");const [,centralParams]=useRoute("/admin/service-orders/:id");const id=central?centralParams?.id:workerParams?.id;
 const userId=me.data?.id;const active=me.data?.state==="active"&&!me.data?.passwordChangeRequired;
 const cache=useQueryClient();const [page,setPage]=useState(1);const [status,setStatus]=useState("");const [search,setSearch]=useState("");const [draft,setDraft]=useState("");
 const [error,setError]=useState("");const [busy,setBusy]=useState(false);
 const pending=useRef<{id:string;expectedVersion:number;idempotencyKey:string}|null>(null);
 const query=useQuery({queryKey:["service-orders",central?"central":"mine",userId,id??"",page,status,search],enabled:!!active,retry:false,gcTime:0,
 queryFn:()=>request<Order|List>(api+(id?"/"+encodeURIComponent(id):"?"+new URLSearchParams({page:String(page),pageSize:"20",...(status?{status}:{}),...(search?{search}:{})}))),
 refetchOnWindowFocus:true,refetchInterval:q=>{
 const d=q.state.data;return d&&("items"in d?d.items.some(o=>o.paymentStatus==="held"):d.paymentStatus==="held")?10000:false;
 }});
 const order=query.data&&!("items"in query.data)?query.data:null;
 const list=query.data&&"items"in query.data?query.data:null;
 async function cancel(){
 if(!order||busy)return;
 if(pending.current&&pending.current.id!==order.id){setError("توجد محاولة إلغاء لم تتأكد لطلب آخر. ارجع إلى الطلب السابق للتحقق من نتيجتها أولًا.");return;}
 setError("");setBusy(true);
 if(!pending.current)pending.current={id:order.id,expectedVersion:order.version,idempotencyKey:crypto.randomUUID()};
 const command=pending.current;
 try{
 const result=await request<Order>(api+"/"+command.id+"/cancel",{expectedVersion:command.expectedVersion,idempotencyKey:command.idempotencyKey});
 if(result.status!=="cancelled")throw new OrderError("لم تتأكد نتيجة الإلغاء؛ أعد التحقق بالمرجع نفسه.",502);
 pending.current=null;await cache.invalidateQueries({queryKey:["service-orders"]});
 }catch(e){
 if(e instanceof OrderError&&e.status<500){pending.current=null;await query.refetch();}
 setError(e instanceof Error?e.message:"تعذر إلغاء الحجز.");
 }finally{setBusy(false);}
 }
 function filter(e:FormEvent){e.preventDefault();setSearch(draft.trim());setPage(1);}
 if(me.isLoading)return <main className="so-page" dir="rtl" role="status">جارٍ تحميل حسابك…</main>;
 if(!active)return <main className="so-page" dir="rtl"><h1>يلزم حساب فعال</h1><Link href={me.data?.passwordChangeRequired?"/reset-password?update=1":"/sign-in"}>متابعة تسجيل الدخول</Link></main>;
 return <section className="so-page" dir="rtl" data-testid="service-orders-page">
 <header className="so-heading"><div><span className="fleet-eyebrow">{central?"مركز العمليات":"مساحة العامل"}</span><h1>{id?"تفاصيل طلب الخدمة":central?"طلبات الخدمة":"طلباتي"}</h1><p>حالة التنفيذ والدفع من السجل الفعلي، مع تفاصيل الحجز والإلغاء.</p></div><Link className="fleet-button fleet-quiet" href={id?prefix:central?"/admin":"/operations"}>{id?"كل الطلبات":central?"لوحة الإدارة":"خدمة جديدة"}</Link></header>
 {!id&&<form className="so-filters" onSubmit={filter}><label className="fleet-field">ابحث بالمركبة أو الخدمة أو الفرع<input value={draft} maxLength={160} onChange={e=>setDraft(e.target.value)} data-testid="orders-search"/></label><label className="fleet-field">حالة الطلب<select value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="">كل الحالات</option>{Object.entries(states).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label><button className="fleet-button">بحث</button></form>}
 {query.isLoading?<div className="so-state" role="status">جارٍ تحميل الطلبات…</div>:query.isError?<div className="so-state" role="alert"><p>{query.error.message}</p><button className="fleet-button" onClick={()=>void query.refetch()}>إعادة المحاولة</button></div>:order?<article className="so-detail" data-testid="order-detail"><Summary order={order}/>
 {order.status==="reserved"&&<p className="so-notice">تم حجز المبلغ{order.kind==="product"?" والكمية في المخزن":""}. لم يُسجّل دفع أو تسليم بعد. إذا انتهت المهلة قبل البدء، يُحرّر الحجز تلقائيًا؛ تعرض الصفحة النتيجة بعد تسجيلها.</p>}
 {userId&&<ServiceOrderExecution key={order.id} orderId={order.id} userId={userId} central={central}/>}
 {userId&&<ServiceOrderPayment key={"payment-"+order.id} orderId={order.id} userId={userId} central={central}/>}
 {userId&&<ServiceRefundRequests key={"refund-"+order.id+"-"+order.paymentStatus} orderId={order.id} userId={userId} central={central}/>}
 {order.cancelledAt&&<p className="so-notice" data-testid="order-cancelled">أُلغي الحجز {date(order.cancelledAt)} {order.cancelCode==="reservation_expired"?"بسبب انتهاء المهلة، بواسطة النظام.":"بواسطة مستخدم مخول."} المبلغ غير مدفوع، وقد حُرّر الرصيد{order.kind==="product"?" والمخزون المحجوز":""}.</p>}
 {order.requiresReview&&<p role="alert" className="fleet-feedback is-error">توقف التحرير التلقائي بعد تعذّر إتمامه. ما زال المبلغ محجوزًا لحين المراجعة. محاولات التحرير: {order.expiryAttempts}.</p>}
 <div className="so-actions"><button className="fleet-button fleet-quiet" disabled={busy} onClick={()=>void query.refetch()}>تحديث الحالة</button>
 {(order.canCancel&&canManage||pending.current?.id===order.id)&&<button data-testid="order-cancel" className="fleet-button so-danger" disabled={busy} onClick={()=>void cancel()}>{busy?"جارٍ التحقق من الإلغاء…":pending.current?"التحقق من نتيجة الإلغاء":"إلغاء الحجز وتحرير الموارد"}</button>}</div>
 {error&&<p role="alert" className="fleet-feedback is-error">{error}</p>}
 <section className="so-timeline" aria-label="سجل الطلب"><h3>سجل الطلب</h3>{order.timeline?.length?<ol>{order.timeline.map(event=><li key={event.id}><div><b>{eventNames[event.kind]??"حدث مسجل"}</b><time>{date(event.createdAt)}</time></div><p>{event.actorKind==="system"?"النظام":event.actorName} · النسخة {event.version}</p></li>)}</ol>:<p>لا يوجد حدث متاح للعرض.</p>}</section>
 <p className="so-reference">مرجع الطلب <b dir="ltr">{order.id}</b> · النسخة {order.version}</p></article>:list?<>{!list.items.length?<div className="so-state" role="status"><h2>لا توجد طلبات مطابقة</h2><p>ستظهر هنا الحجوزات التي تُنشأ ضمن نطاقك. يمكنك تعديل البحث والمرشحات.</p></div>:<div className="so-grid">{list.items.map(o=><article key={o.id} className="so-card" data-testid="order-card"><Summary order={o}/><Link className="fleet-button fleet-quiet" href={prefix+"/"+o.id}>عرض الطلب والسجل</Link></article>)}</div>}
 <div className="fleet-pagination"><button className="fleet-button fleet-quiet" disabled={page<=1} onClick={()=>setPage(p=>p-1)}>السابق</button><span>{list.total} طلب · صفحة {page}</span><button className="fleet-button fleet-quiet" disabled={page*20>=list.total} onClick={()=>setPage(p=>p+1)}>التالي</button></div></>:null}
 </section>;
}
