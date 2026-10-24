import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
type Item={id:string;name:string;kind:"fuel"|"service"|"product";brandName?:string|null;unitCode:string;quantityScale:number;priceVersionId:string;unitPriceMinor:string;locations:{id:string;name:string;availableQuantity:string}[]};
type Options={items:Item[];total:number;page:number;pageSize:number;expiresAt:string};
type Quote={item:Item;quantity:string;amountMinor:string;canReserve:boolean;denialCode?:string|null;expiresAt:string};
const units:Record<string,string>={litre:"لتر",piece:"قطعة",service:"خدمة",pack:"عبوة"};
const reasons:Record<string,string>={insufficient_funds:"الرصيد المتاح لا يكفي.",out_of_stock:"الكمية غير متاحة في مخزن البيع المختار.",fuel_tank_capacity_exceeded:"الكمية تتجاوز سعة خزان المركبة.",operation_limit_exceeded:"القيمة أو الكمية تتجاوز حد العملية.",vehicle_total_limit_exceeded:"الطلب يتجاوز الحد المتبقي للمركبة.",branch_total_limit_exceeded:"الطلب يتجاوز الحد المتبقي للفرع.",vehicle_service_limit_exceeded:"الطلب يتجاوز حد هذه الخدمة للمركبة.",branch_service_limit_exceeded:"الطلب يتجاوز حد الخدمة للفرع.",subscription_coverage_required:"المركبة غير مغطاة باشتراك فعال.",merchant_not_allowed:"الفرع خارج شبكة الاستخدام المسموحة.",service_group_not_allowed:"الخدمة غير مسموحة بسياسة المركبة.",outside_allowed_schedule:"اليوم خارج أيام الاستخدام المسموحة.",policy_not_configured:"سياسة الاستخدام غير مكتملة."};
function digits(value:string){return value.replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/٫/g,".");}
function egp(value:string){const [whole="0",fraction=""]=value.split(".");if(!/^[0-9]+$/.test(whole)||!/^[0-9]*$/.test(fraction))return "—";const amount=BigInt(whole);return (amount/100n).toString()+"."+((amount%100n).toString().padStart(2,"0")+fraction).replace(/0+$/,"").padEnd(2,"0");}
function amountMinor(value:string){const match=digits(value).match(/^([0-9]{1,12})(?:\.([0-9]{1,2}))?$/);return match?(BigInt(match[1])*100n+BigInt((match[2]??"").padEnd(2,"0"))).toString():null;}
async function request<T>(url:string,body?:unknown):Promise<T>{const r=await fetch(url,{credentials:"include",...(body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.message??"تعذر تحميل بيانات الخدمة.");return data;}
export function ServiceQuotation({proofId,onReservationPending}:{proofId:string;onReservationPending?:(pending:boolean)=>void}){
 const [,navigate]=useLocation();
 const [reserving,setReserving]=useState(false);const [uncertain,setUncertain]=useState(false);
 const quotedInput=useRef<Record<string,unknown>|null>(null);const reservation=useRef<Record<string,unknown>|null>(null);
 const [search,setSearch]=useState("");const [page,setPage]=useState(1);const [selected,setSelected]=useState("");const [value,setValue]=useState("");const [location,setLocation]=useState("");
 const [quote,setQuote]=useState<Quote|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState("");const epoch=useRef(0);
 const query=useQuery({queryKey:["worker-service-options",proofId,search,page],queryFn:()=>request<Options>("/api/operations/service-options?"+new URLSearchParams({proofId,search,page:String(page),pageSize:"20"})),retry:false,gcTime:0,refetchOnWindowFocus:!reserving&&!uncertain});
 const items=query.data?.items??[];const item=items.find(i=>i.id===selected);
 useEffect(()=>{if(!reservation.current&&!items.some(i=>i.id===selected))setSelected(items[0]?.id??"");},[query.data,selected]);
 useEffect(()=>{setValue("");setLocation("");setQuote(null);setError("");epoch.current++;},[selected]);
 useEffect(()=>{if(!reservation.current){setQuote(null);setError("");epoch.current++;}},[value,location,query.data]);
 async function calculate(event:FormEvent){event.preventDefault();if(!item)return;setError("");setQuote(null);const expected=++epoch.current;setBusy(true);
 try{const money=item.kind==="fuel"?amountMinor(value):null;if(item.kind==="fuel"&&!money)throw new Error("أدخل مبلغًا بالجنيه حتى منزلتين عشريتين.");
 const result=await request<Quote>("/api/operations/service-quotes",{proofId,referenceId:item.id,priceVersionId:item.priceVersionId,input:item.kind==="fuel"?{amountMinor:money}:{quantity:digits(value)},locationId:item.kind==="product"?location:null});
 if(epoch.current===expected){quotedInput.current={proofId,referenceId:item.id,priceVersionId:item.priceVersionId,input:item.kind==="fuel"?{amountMinor:money}:{quantity:digits(value)},locationId:item.kind==="product"?location:null};setQuote(result);}
 }catch(e){if(epoch.current===expected)setError(e instanceof Error?e.message:"تعذر حساب السعر.");}finally{setBusy(false);}}
 async function reserve(){
 if(reserving||(!reservation.current&&(!quote?.canReserve||!quotedInput.current)))return;
 setError("");setReserving(true);onReservationPending?.(true);
 if(!reservation.current)reservation.current={...quotedInput.current,idempotencyKey:crypto.randomUUID()};
 try{
 const response=await fetch("/api/operations/service-orders",{method:"POST",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify(reservation.current)});
 const data=await response.json().catch(()=>null);
 if(!response.ok||!data?.id){
 if(response.status<500&&data){reservation.current=null;setUncertain(false);onReservationPending?.(false);setQuote(null);}
 throw new Error(data?.message??"لم تتأكد نتيجة الحجز. أعد التحقق بالمحاولة نفسها أو راجع طلباتك.");
 }
 reservation.current=null;onReservationPending?.(false);navigate("/operations/orders/"+data.id);
 }catch(e){setUncertain(!!reservation.current);setError(e instanceof Error?e.message:"تعذر التأكد من نتيجة الحجز. أعد المحاولة بالمرجع نفسه.");}
 finally{setReserving(false);}
 }
 const locked=busy||reserving||uncertain;
 return <section className="fleet-panel" aria-label="اختيار الخدمة وتسعيرها" data-testid="service-quotation"><h2>اختر الخدمة واعرف تكلفتها</h2>
 <p className="fleet-muted">السعر من القائمة المعتمدة. عرض السعر لا يحجز الرصيد أو المخزون؛ يبدأ الحجز بعد تأكيدك.</p>
 <label className="fleet-field fleet-wide">ابحث عن الخدمة أو المنتج<input data-testid="quote-search" value={search} maxLength={160} onChange={e=>{setSearch(e.target.value);setPage(1);}} disabled={locked}/></label>
 {query.isLoading?<p role="status">جارٍ تحميل الخدمات والأسعار…</p>:query.isError?<p role="alert">{query.error.message}<button className="fleet-button fleet-quiet" onClick={()=>void query.refetch()}>إعادة المحاولة</button></p>:!items.length?<p role="status">لا يوجد صنف بسعر معتمد متاح لهذه المركبة والخدمة والفرع. راجع إعداد الوقود أو إتاحة الأصناف والأسعار.</p>:<>
 <form className="fleet-form" onSubmit={calculate}><label className="fleet-field fleet-wide">الخدمة أو المنتج<select data-testid="quote-item" value={selected} onChange={e=>setSelected(e.target.value)} disabled={locked}>{items.map(i=><option key={i.id} value={i.id}>{i.name}{i.brandName?" · "+i.brandName:""} · {egp(i.unitPriceMinor)} جنيه / {units[i.unitCode]??i.unitCode}</option>)}</select></label>
 {item&&<><label className="fleet-field">{item.kind==="fuel"?"مبلغ التعبئة (جنيه)":"الكمية ("+(units[item.unitCode]??item.unitCode)+")"}<input data-testid="quote-value" value={value} onChange={e=>setValue(digits(e.target.value))} inputMode="decimal" maxLength={16} required disabled={locked} dir="ltr"/></label>
 {item.kind==="product"&&<label className="fleet-field">مخزن البيع<select data-testid="quote-location" value={location} onChange={e=>setLocation(e.target.value)} required disabled={locked}><option value="">اختر المخزن</option>{item.locations.map(l=><option key={l.id} value={l.id}>{l.name} · المتاح {l.availableQuantity}</option>)}</select></label>}
 <button data-testid="quote-submit" className="fleet-button" disabled={locked||!value||item.kind==="product"&&!location}>{busy?"جارٍ حساب السعر…":"حساب السعر وفحص الحدود"}</button></>}
 </form>
 <div className="fleet-pagination"><button className="fleet-button fleet-quiet" disabled={page<=1||locked} onClick={()=>setPage(p=>p-1)}>السابق</button><span>صفحة {page} · {query.data?.total??0} صنف</span><button className="fleet-button fleet-quiet" disabled={page*20>=(query.data?.total??0)||locked} onClick={()=>setPage(p=>p+1)}>التالي</button></div>
 </>}
 {uncertain&&<p role="status" className="fleet-feedback">نتيجة الحجز لم تتأكد. احتُفظ بمرجع المحاولة نفسه لمنع تكرار الحجز. لا تدخل طلبًا جديدًا قبل مراجعة النتيجة. <Link href="/operations/orders">راجع طلباتي</Link></p>}
 {error&&<p role="alert" className="fleet-feedback is-error">{error}</p>}
 {quote&&<div data-testid="quote-result" className="fleet-panel"><h3>{quote.item.name}</h3><div className="fleet-facts"><div><small>الكمية المقدرة</small><b>{quote.quantity} {units[quote.item.unitCode]??quote.item.unitCode}</b></div><div><small>الإجمالي</small><b data-testid="quote-total">{egp(quote.amountMinor)} جنيه</b></div><div><small>فحص الحجز الآن</small><b>{quote.canReserve?"متاح ضمن الحدود الحالية":"يتعذر الحجز"}</b></div></div>{!quote.canReserve&&<p role="alert">{reasons[quote.denialCode??""]??"راجع السياسة والتغطية والرصيد والتوفر قبل الحجز."}</p>}{(quote.canReserve||uncertain)&&<div className="fleet-actions"><button type="button" data-testid="order-reserve" className="fleet-button" onClick={()=>void reserve()} disabled={reserving}>{reserving?"جارٍ التحقق من الحجز…":uncertain?"التحقق من نتيجة الحجز":"تأكيد حجز الخدمة"}</button><p className="fleet-muted">يُحجز المبلغ والكمية المطلوبة لمدة 15 دقيقة لبدء الخدمة. الحجز لا يعني الدفع أو التسليم.</p></div>}</div>}
 </section>;
}
