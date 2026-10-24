import { Router, type IRouter, type Request, type Response } from "express";
import { ReserveWorkerServiceOrderBody, CancelWorkerServiceOrderBody } from "@workspace/api-zod";
import { requireSession } from "./management";
import { isRecord, setNoStore } from "../lib/supabaseServer";

const router: IRouter = Router();
type Session = NonNullable<Awaited<ReturnType<typeof requireSession>>>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses=["reserved","in_progress","delivered","review_required","cancelled"];
async function rpc(session:Session,name:string,args:Record<string,unknown>){
 return (session.supabase.rpc as unknown as (name:string,args:Record<string,unknown>)=>Promise<{data:unknown;error:{code?:string;message?:string}|null}>).call(session.supabase,name,args);
}
function reply(res:Response,result:Awaited<ReturnType<typeof rpc>>){
 if(!result.error){res.json(result.data);return;}
 const code=result.error.code??"";
 const status=code==="42501"?403:code==="P0002"?404:code==="22023"?400:["40001","23505","23514","55000"].includes(code)?409:["PGRST202","42883"].includes(code)?503:500;
 const messages:Record<string,string>={
 OPERATIONAL_PROOF_REQUIRED:"انتهى التحقق أو تغيّر التفويض؛ تحقق من المركبة والسائق مجددًا.",
 OPERATIONAL_PROOF_ALREADY_USED:"استُخدم التحقق في حجز آخر؛ راجع طلباتك قبل إعادة التحقق.",
 IDEMPOTENCY_CONFLICT:"استُخدم مرجع المحاولة مع بيانات مختلفة. راجع نتيجة المحاولة السابقة.",
 ORDER_VERSION_CONFLICT:"تغيّر الطلب؛ حدّث تفاصيله ثم أعد المحاولة.",
 ORDER_NOT_CANCELLABLE:"بدأ تنفيذ الطلب أو تغيّرت حالته؛ لا يمكن إلغاء الحجز الآن.",
 ORDER_HOLD_REQUIRES_REVIEW:"الحجز يحتاج مراجعة العمليات قبل تحريره.",
 ORDER_STOCK_REQUIRES_REVIEW:"حجز المخزون يحتاج مراجعة العمليات قبل تحريره.",
 SERVICE_PRICE_CHANGED:"تغيّر السعر؛ احسب عرض السعر مجددًا.",
 SERVICE_PRICE_UNAVAILABLE:"الصنف أو سعره المعتمد غير متاح.",
 };
 const known=Object.hasOwn(messages,result.error.message??"")?result.error.message!:null;
 res.status(status).json({code:known??(status===503?"SERVICE_ORDERS_UNAVAILABLE":"SERVICE_ORDER_REJECTED"),message:known?messages[known]:status===403?"لا تملك التفويض الحالي لقراءة هذا الطلب أو تعديله.":status===404?"لم يُعثر على الطلب.":status===400?"راجع بيانات الطلب.":status===409?"تعذر الحجز بسبب تغيّر الحدود أو الرصيد أو المخزون. حدّث البيانات وراجع طلباتك.":status===503?"طلبات الخدمة غير متاحة مؤقتًا.":"تعذر التأكد من نتيجة الطلب الآن؛ أعد المحاولة بالمرجع نفسه."});
}
router.post("/operations/service-orders",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const parsed=ReserveWorkerServiceOrderBody.strict().safeParse(req.body);
 if(!parsed.success||!isRecord(req.body.input)||Object.keys(req.body.input).length!==1){res.status(400).json({message:"اختر خدمة وسعرًا حاليًا وأدخل مبلغًا أو كمية صالحة."});return;}
 const q=parsed.data;
 reply(res,await rpc(session,"petro_worker_reserve_service_order",{p_proof_id:q.proofId,p_reference_id:q.referenceId,p_price_version_id:q.priceVersionId,p_input:q.input,p_location_id:q.locationId??null,p_request_key:q.idempotencyKey}));
});
function filters(query:Request["query"]):Record<string,unknown>|null{
 if(Object.keys(query).some(k=>!["page","pageSize","status","search"].includes(k)))return null;
 const result:Record<string,unknown>={};
 for(const [name,max]of [["page",100000],["pageSize",50]]as const){
 const raw=query[name];if(raw===undefined)continue;
 if(typeof raw!=="string"||!/^\d{1,6}$/.test(raw)||Number(raw)<1||Number(raw)>max)return null;
 result[name]=Number(raw);
 }
 if(query.status!==undefined){if(typeof query.status!=="string"||!statuses.includes(query.status))return null;result.status=query.status;}
 if(query.search!==undefined){if(typeof query.search!=="string"||query.search.length>160)return null;result.search=query.search.trim();}
 return result;
}
for(const mode of ["operations","admin"]as const){
 const prefix="/"+mode+"/service-orders";
 const view=mode==="admin"?"central":"mine";
 router.get(prefix,async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const input=filters(req.query);if(!input){res.status(400).json({message:"مرشحات الطلبات غير صالحة."});return;}
 reply(res,await rpc(session,"petro_service_orders_query",{p_filters:{...input,view}}));
 });
 router.get(prefix+"/:id",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 if(typeof req.params.id!=="string"||!uuid.test(req.params.id)||Object.keys(req.query).length){res.status(400).json({message:"مرجع الطلب غير صالح."});return;}
 reply(res,await rpc(session,"petro_service_orders_query",{p_filters:{view,orderId:req.params.id}}));
 });
 router.post(prefix+"/:id/cancel",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const parsed=CancelWorkerServiceOrderBody.strict().safeParse(req.body);
 if(typeof req.params.id!=="string"||!uuid.test(req.params.id)||!parsed.success||!Number.isSafeInteger(parsed.data.expectedVersion)){res.status(400).json({message:"مرجع الطلب أو نسخته أو مرجع المحاولة غير صالح."});return;}
 const b=parsed.data;
 if(mode==="admin"){
 const permission=await rpc(session,"petro_service_orders_query",{p_filters:{view:"central",page:1,pageSize:1}});
 if(permission.error){reply(res,permission);return;}
 if(!isRecord(permission.data)||permission.data.canManage!==true){res.status(403).json({message:"عرض الطلبات متاح للمراجع؛ الإلغاء يحتاج تفويض العمليات أو المالية."});return;}
 }
 reply(res,await rpc(session,"petro_cancel_service_order",{p_order_id:req.params.id,p_expected_version:b.expectedVersion,p_request_key:b.idempotencyKey}));
 });
}
export default router;
