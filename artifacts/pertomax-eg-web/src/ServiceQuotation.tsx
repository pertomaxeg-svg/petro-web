import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
type Item={id:string;name:string;kind:"fuel"|"service"|"product";brandName?:string|null;unitCode:string;quantityScale:number;priceVersionId:string;unitPriceMinor:string;locations:{id:string;name:string;availableQuantity:string}[]};
type Options={items:Item[];total:number;page:number;pageSize:number;expiresAt:string};
type Quote={item:Item;quantity:string;amountMinor:string;canReserve:boolean;denialCode?:string|null;expiresAt:string};
const units:Record<string,string>={litre:"لتر",piece:"قطعة",service:"خدمة",pack:"عبوة"};
const reasons:Record<string,string>={insufficient_funds:"الرصيد المتاح لا يكفي.",out_of_stock:"الكمية غير متاحة في مخزن البيع المختار.",fuel_tank_capacity_exceeded:"الكمية تتجاوز سعة خزان المركبة.",operation_limit_exceeded:"القيمة أو الكمية تتجاوز حد العملية.",vehicle_total_limit_exceeded:"الطلب يتجاوز الحد المتبقي للمركبة.",branch_total_limit_exceeded:"الطلب يتجاوز الحد المتبقي للفرع.",vehicle_service_limit_exceeded:"الطلب يتجاوز حد هذه الخدمة للمركبة.",branch_service_limit_exceeded:"الطلب يتجاوز حد الخدمة للفرع.",subscription_coverage_required:"المركبة غير مغطاة باشتراك فعال.",merchant_not_allowed:"الفرع خارج شبكة الاستخدام المسموحة.",service_group_not_allowed:"الخدمة غير مسموحة بسياسة المركبة.",outside_allowed_schedule:"اليوم خارج أيام الاستخدام المسموحة.",policy_not_configured:"سياسة الاستخدام غير مكتملة."};
function digits(value:string){return value.replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-1632)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-1776)).replace(/٫/g,".");}
function egp(value:string){const [whole="0",fraction=""]=value.split(".");if(!/^[0-9]+$/.test(whole)||!/^[0-9]*$/.test(fraction))return "—";const amount=BigInt(whole);return (amount/100n).toString()+"."+((amount%100n).toString().padStart(2,"0")+fraction).replace(/0+$/,"").padEnd(2,"0");}
function amountMinor(value:string){const match=digits(value).match(/^([0-9]{1,12})(?:\.([0-9]{1,2}))?$/);return match?(BigInt(match[1])*100n+BigInt((match[2]??"").padEnd(2,"0"))).toString():null;}
async function request<T>(url:string,body?:unknown):Promise<T>{const r=await fetch(url,{credentials:"include",...(body===undefined?{}:{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)})});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.message??"تعذر تحميل بيانات الخدمة.");return data;}
export function ServiceQuotation({proofId}:{proofId:string}){
 const [search,setSearch]=useState("");const [page,setPage]=useState(1);const [selected,setSelected]=useState("");const [value,setValue]=useState("");const [location,setLocation]=useState("");
 const [quote,setQuote]=useState<Quote|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState("");const epoch=useRef(0);
 const query=useQuery({queryKey:["worker-service-options",proofId,search,page],queryFn:()=>request<Options>("/api/operations/service-options?"+new URLSearchParams({proofId,search,page:String(page),pageSize:"20"})),retry:false,gcTime:0,refetchOnWindowFocus:true});
 const items=query.data?.items??[];const item=items.find(i=>i.id===selected);
 useEffect(()=>{if(!items.some(i=>i.id===selected))setSelected(items[0]?.id??"");},[query.data,selected]);
 useEffect(()=>{setValue("");setLocation("");setQuote(null);setError("");epoch.current++;},[selected]);
 useEffect(()=>{setQuote(null);setError("");epoch.current++;},[value,location,query.data]);
 async function calculate(event:FormEvent){event.preventDefault();if(!item)return;setError("");setQuote(null);const expected=++epoch.current;setBusy(true);
 try{const money=item.kind==="fuel"?amountMinor(value):null;if(item.kind==="fuel"&&!money)throw new Error("أدخل مبلغًا بالجنيه حتى منزلتين عشريتين.");
 const result=await request<Quote>("/api/operations/service-quotes",{proofId,referenceId:item.id,priceVersionId:item.priceVersionId,input:item.kind==="fuel"?{amountMinor:money}:{quantity:digits(value)},locationId:item.kind==="product"?location:null});
 if(epoch.current===expected)setQuote(result);
 }catch(e){if(epoch.current===expected)setError(e instanceof Error?e.message:"تعذر حساب السعر.");}finally{setBusy(false);}}
 return <section className="fleet-panel" aria-label="اختيار الخدمة وتسعيرها" data-testid="service-quotation"><h2>اختر الخدمة واعرف تكلفتها</h2>
 <p className="fleet-muted">السعر من القائمة المعتمدة. عرض السعر لا يحجز الرصيد أو المخزون.</p>
 <label className="fleet-field fleet-wide">ابحث عن الخدمة أو المنتج<input data-testid="quote-search" value={search} maxLength={160} onChange={e=>{setSearch(e.target.value);setPage(1);}} disabled={busy}/></label>
 {query.isLoading?<p role="status">جارٍ تحميل الخدمات والأسعار…</p>:query.isError?<p role="alert">{query.error.message}<button className="fleet-button fleet-quiet" onClick={()=>void query.refetch()}>إعادة المحاولة</button></p>:!items.length?<p role="status">لا يوجد صنف بسعر معتمد متاح لهذه المركبة والخدمة والفرع. راجع إعداد الوقود أو إتاحة الأصناف والأسعار.</p>:<>
 <form className="fleet-form" onSubmit={calculate}><label className="fleet-field fleet-wide">الخدمة أو المنتج<select data-testid="quote-item" value={selected} onChange={e=>setSelected(e.target.value)} disabled={busy}>{items.map(i=><option key={i.id} value={i.id}>{i.name}{i.brandName?" · "+i.brandName:""} · {egp(i.unitPriceMinor)} جنيه / {units[i.unitCode]??i.unitCode}</option>)}</select></label>
 {item&&<><label className="fleet-field">{item.kind==="fuel"?"مبلغ التعبئة (جنيه)":"الكمية ("+(units[item.unitCode]??item.unitCode)+")"}<input data-testid="quote-value" value={value} onChange={e=>setValue(digits(e.target.value))} inputMode="decimal" maxLength={16} required disabled={busy} dir="ltr"/></label>
 {item.kind==="product"&&<label className="fleet-field">مخزن البيع<select data-testid="quote-location" value={location} onChange={e=>setLocation(e.target.value)} required disabled={busy}><option value="">اختر المخزن</option>{item.locations.map(l=><option key={l.id} value={l.id}>{l.name} · المتاح {l.availableQuantity}</option>)}</select></label>}
 <button data-testid="quote-submit" className="fleet-button" disabled={busy||!value||item.kind==="product"&&!location}>{busy?"جارٍ حساب السعر…":"حساب السعر وفحص الحدود"}</button></>}
 </form>
 <div className="fleet-pagination"><button className="fleet-button fleet-quiet" disabled={page<=1||busy} onClick={()=>setPage(p=>p-1)}>السابق</button><span>صفحة {page} · {query.data?.total??0} صنف</span><button className="fleet-button fleet-quiet" disabled={page*20>=(query.data?.total??0)||busy} onClick={()=>setPage(p=>p+1)}>التالي</button></div>
 </>}
 {error&&<p role="alert" className="fleet-feedback is-error">{error}</p>}
 {quote&&<div data-testid="quote-result" className="fleet-panel"><h3>{quote.item.name}</h3><div className="fleet-facts"><div><small>الكمية المقدرة</small><b>{quote.quantity} {units[quote.item.unitCode]??quote.item.unitCode}</b></div><div><small>الإجمالي</small><b data-testid="quote-total">{egp(quote.amountMinor)} جنيه</b></div><div><small>فحص الحجز الآن</small><b>{quote.canReserve?"متاح ضمن الحدود الحالية":"يتعذر الحجز"}</b></div></div>{!quote.canReserve&&<p role="alert">{reasons[quote.denialCode??""]??"راجع السياسة والتغطية والرصيد والتوفر قبل الحجز."}</p>}</div>}
 </section>;
}
