import { Router, raw, type IRouter, type Request, type Response } from "express";
import { ReserveWorkerServiceOrderBody, CancelWorkerServiceOrderBody, StartWorkerServiceOrderBody, DeliverWorkerServiceOrderBody, CreateWorkerServiceOrderEvidenceBody, ConfirmWorkerServiceOrderPaymentBody } from "@workspace/api-zod";
import { pairPinDigest, fleetHmacSecret } from "../lib/fleetPairIdentity";
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
 FORBIDDEN_REFUND:"لا تملك صلاحية طلب الاسترداد أو مراجعته لهذا الطلب.",
 REFUND_REQUIRES_PAID_ORDER:"يمكن طلب رد قيمة خدمة مدفوعة فقط.",
 REFUND_EXCEEDS_REMAINING_PAYMENT:"المبلغ يتجاوز الجزء المتاح من الدفعة بعد الطلبات القائمة.",
 REFUND_OPEN_REQUEST_LIMIT:"وصل الطلب إلى حد طلبات الاسترداد المفتوحة. راجع الطلبات السابقة.",
 REFUND_VERSION_CONFLICT:"تغير طلب الاسترداد؛ حدّث السجل قبل المتابعة.",
 INVALID_REFUND_REQUEST:"راجع مبلغ الاسترداد ونوع المشكلة ومرجع المحاولة.",
 ORDER_NOT_CONFIRMABLE:"حالة الطلب لا تسمح بتأكيد الدفع الآن.",
 DELIVERY_REQUIRES_REVIEW:"التنفيذ يحتاج مراجعة العمليات قبل الدفع.",
 ODOMETER_REQUIRES_REVIEW:"قراءة العداد تحتاج اعتمادًا قبل الدفع.",
 ORDER_EVIDENCE_REQUIRES_REVIEW:"صور التنفيذ لم تعد متاحة للتحقق؛ راجع العمليات.",
 INSUFFICIENT_CAPTURE_FUNDS:"الرصيد المتاح لا يسمح بتأكيد القيمة الفعلية.",
 PHYSICAL_DELIVERY_REQUIRES_REVIEW:"صرف المخزون يحتاج مراجعة قبل الدفع.",
 ORDER_NOT_STARTABLE:"انتهت مهلة الحجز أو بدأت الخدمة بالفعل. حدّث الطلب.",
 ORDER_NOT_DELIVERABLE:"حالة الطلب لا تسمح بتسجيل التنفيذ الآن.",
 ORDER_IDENTITY_CHANGED:"تغيّر ربط السائق أو المركبة أو التعريف؛ راجع العمليات.",
 WASH_BEFORE_REQUIRED:"ارفع صورة الغسيل قبل البدء أولًا.",
 WASH_AFTER_REQUIRED:"ارفع صورة الغسيل بعد التنفيذ أولًا.",
 ODOMETER_REQUIRED:"أدخل قراءة العداد الفعلية.",
 ODOMETER_IMAGE_REQUIRED:"ارفع صورة العداد أولًا.",
 SERIAL_EVIDENCE_REQUIRED:"أدخل الرقم التسلسلي وارفع صورته.",
 DELIVERY_EXCEEDS_AUTHORIZATION:"الكمية الفعلية تتجاوز الحجز أو لا توافق وحدة الصنف.",
 EVIDENCE_UPLOAD_UNVERIFIED:"لم يُتحقق من الملف وحجمه ونوعه في التخزين. أعد رفع الملف نفسه.",
 ORDER_EVIDENCE_PHASE:"لا يمكن إرفاق هذه الصورة في حالة الطلب الحالية.",
 ORDER_EVIDENCE_LIMIT:"وصل الطلب إلى الحد المسموح للمرفقات.",
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

const requestKey=/^[A-Za-z0-9._:-]{16,120}$/;
const evidenceKinds=["odometer","wash_before","wash_after","serial"];
function validVersionBody(body:unknown,delivery=false){
 if(!(delivery?DeliverWorkerServiceOrderBody:StartWorkerServiceOrderBody).strict().safeParse(body).success)return false;
 if(!isRecord(body)||Object.keys(body).some(k=>!(delivery?["expectedVersion","idempotencyKey","input"]:["expectedVersion","idempotencyKey"]).includes(k))
 ||!Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<1||typeof body.idempotencyKey!=="string"||!requestKey.test(body.idempotencyKey))return false;
 if(!delivery)return true;
 const i=body.input;
 return isRecord(i)&&Object.keys(i).every(k=>["actualQuantity","readingKm","serialNumber"].includes(k))
 &&typeof i.actualQuantity==="string"&&/^[0-9]{1,9}(\.[0-9]{1,3})?$/.test(i.actualQuantity)
 &&(i.readingKm===undefined||i.readingKm===null||typeof i.readingKm==="string"&&/^[0-9]{1,11}(\.[0-9]{1,3})?$/.test(i.readingKm))
 &&(i.serialNumber===undefined||i.serialNumber===null||typeof i.serialNumber==="string"&&i.serialNumber.trim().length<=120);
}
for(const mode of ["operations","admin"]as const){
 router.get("/"+mode+"/service-orders/:id/execution",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 if(typeof req.params.id!=="string"||!uuid.test(req.params.id)||Object.keys(req.query).length){res.status(400).json({message:"مرجع الطلب غير صالح."});return;}
 if(mode==="admin"){const permission=await rpc(session,"petro_service_orders_query",{p_filters:{view:"central",orderId:req.params.id}});if(permission.error){reply(res,permission);return;}}
 reply(res,await rpc(session,"petro_service_order_execution",{p_order_id:req.params.id}));
 });
}
for(const action of ["start","deliver"]as const){
 router.post("/operations/service-orders/:id/"+action,async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 if(typeof req.params.id!=="string"||!uuid.test(req.params.id)||!validVersionBody(req.body,action==="deliver")){res.status(400).json({message:"راجع نسخة الطلب والكمية والعداد ومرجع المحاولة."});return;}
 reply(res,await rpc(session,action==="start"?"petro_start_service_order":"petro_deliver_service_order",{p_order_id:req.params.id,p_expected_version:req.body.expectedVersion,p_request_key:req.body.idempotencyKey,...(action==="deliver"?{p_input:req.body.input}:{})}));
 });
}
router.post("/operations/service-orders/:id/evidence",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const b=req.body;
 if(!CreateWorkerServiceOrderEvidenceBody.strict().safeParse(b).success){res.status(400).json({message:"بيانات الصورة غير صالحة."});return;}
 if(typeof req.params.id!=="string"||!uuid.test(req.params.id)||!isRecord(b)||Object.keys(b).some(k=>!["kind","fileName","contentType","byteSize","idempotencyKey"].includes(k))
 ||typeof b.kind!=="string"||!evidenceKinds.includes(b.kind)||typeof b.fileName!=="string"||b.fileName.length<1||b.fileName.length>160
 ||!["image/png","image/jpeg"].includes(String(b.contentType))||!Number.isSafeInteger(b.byteSize)||Number(b.byteSize)<1||Number(b.byteSize)>10485760
 ||typeof b.idempotencyKey!=="string"||!requestKey.test(b.idempotencyKey)){res.status(400).json({message:"اختر صورة PNG أو JPEG لا تتجاوز 10 ميجابايت."});return;}
 reply(res,await rpc(session,"petro_create_service_order_evidence",{p_order_id:req.params.id,p_kind:b.kind,p_file_name:b.fileName,p_content_type:b.contentType,p_byte_size:b.byteSize,p_request_key:b.idempotencyKey}));
});
function isImage(type:string,bytes:Buffer){
 return type==="image/png"?bytes.length>=8&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):type==="image/jpeg"&&bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
}
router.put("/operations/service-order-evidence/:id/content",raw({type:"application/octet-stream",limit:"10mb"}),async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const id=req.params.id;
 if(typeof id!=="string"||!uuid.test(id)||!Buffer.isBuffer(req.body)){res.status(400).json({message:"الصورة غير صالحة."});return;}
 const file=await rpc(session,"petro_service_order_evidence_file",{p_evidence_id:id,p_action:"read"});
 if(file.error){reply(res,file);return;}const data=file.data;
 if(!isRecord(data)||data.bucket!=="petro-private-documents"||typeof data.objectPath!=="string"||typeof data.contentType!=="string"){res.status(502).json({message:"تعذر التحقق من بيانات المرفق."});return;}
 const bytes=req.body as Buffer;
 if(bytes.length!==Number(data.byteSize)||!isImage(data.contentType,bytes)){res.status(400).json({message:"حجم الصورة أو محتواها لا يطابق طلب الرفع."});return;}
 const bucket=session.supabase.storage.from("petro-private-documents");
 let needsExisting=data.status==="accepted";
 if(!needsExisting){
 const allowed=await rpc(session,"petro_service_order_evidence_file",{p_evidence_id:id,p_action:"upload"});
 if(allowed.error){reply(res,allowed);return;}
 const uploaded=await bucket.upload(data.objectPath,bytes,{contentType:data.contentType,upsert:false,cacheControl:"0"});
 if(uploaded.error){
 const status=String((uploaded.error as unknown as {statusCode?:string}).statusCode??"");
 if(status==="409"||status==="400"&&/already exists|Duplicate/i.test(uploaded.error.message))needsExisting=true;
 else {res.status(503).json({message:"تعذر تأكيد حفظ الصورة؛ أعد رفع الملف نفسه للمحاولة ذاتها."});return;}
 }
 }
 if(needsExisting){
 const existing=await bucket.download(data.objectPath);
 if(existing.error||!existing.data){res.status(503).json({message:"تعذر التأكد من الصورة المحفوظة؛ أعد المحاولة."});return;}
 const stored=Buffer.from(await existing.data.arrayBuffer());
 if(!stored.equals(bytes)){res.status(409).json({message:"هذا المرفق يحوي صورة مختلفة؛ أنشئ مرفقًا جديدًا دون استبدال الصورة السابقة."});return;}
 }
 reply(res,await rpc(session,"petro_finalize_service_order_evidence",{p_evidence_id:id,p_request_key:"order-evidence-finalize:"+id}));
});
router.get("/operations/service-order-evidence/:id/download",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 if(typeof req.params.id!=="string"||!uuid.test(req.params.id)){res.status(400).json({message:"مرجع المرفق غير صالح."});return;}
 const result=await rpc(session,"petro_service_order_evidence_file",{p_evidence_id:req.params.id,p_action:"read"});
 if(result.error){reply(res,result);return;}const d=result.data;
 if(!isRecord(d)||typeof d.objectPath!=="string"||d.status!=="accepted"){res.status(409).json({message:"لم يكتمل رفع الصورة بعد."});return;}
 const signed=await session.supabase.storage.from("petro-private-documents").createSignedUrl(d.objectPath,60);
 if(signed.error||!signed.data?.signedUrl){res.status(503).json({message:"تعذر فتح الصورة الخاصة؛ أعد المحاولة."});return;}
 res.json({url:signed.data.signedUrl,expiresInSeconds:60});
});


for(const mode of ["operations","admin"]as const){
 router.get("/"+mode+"/service-orders/:id/payment",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 if(typeof req.params.id!=="string"||!uuid.test(req.params.id)||Object.keys(req.query).length){res.status(400).json({message:"مرجع الطلب غير صالح."});return;}
 if(mode==="admin"){const permission=await rpc(session,"petro_service_orders_query",{p_filters:{view:"central",orderId:req.params.id}});if(permission.error){reply(res,permission);return;}}
 const result=await rpc(session,"petro_service_order_payment",{p_order_id:req.params.id});
 if(result.error){reply(res,result);return;}if(!isRecord(result.data)){res.status(502).json({message:"تعذر قراءة الدفع."});return;}
 res.json({...result.data,pinConfirmationReady:mode==="operations"&&!!fleetHmacSecret()});
 });
}
router.post("/operations/service-orders/:id/confirm",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const b=req.body;
 if(!ConfirmWorkerServiceOrderPaymentBody.strict().safeParse(b).success||typeof req.params.id!=="string"||!uuid.test(req.params.id)||!isRecord(b)||Object.keys(b).some(k=>!["expectedVersion","idempotencyKey","pinCode"].includes(k))
 ||!Number.isSafeInteger(b.expectedVersion)||Number(b.expectedVersion)<1||typeof b.idempotencyKey!=="string"||!requestKey.test(b.idempotencyKey)
 ||typeof b.pinCode!=="string"||!/^\d{4}$/.test(b.pinCode)){res.status(400).json({message:"أدخل رمز التعبئة المكون من أربعة أرقام ومرجع المحاولة الصالح."});return;}
 if(!fleetHmacSecret()){res.status(503).json({message:"تأكيد الرمز غير متاح حاليًا."});return;}
 const context=await rpc(session,"petro_service_order_payment_context",{p_order_id:req.params.id});
 if(context.error){reply(res,context);return;}
 if(!isRecord(context.data)||typeof context.data.vehicleId!=="string"||!uuid.test(context.data.vehicleId)){res.status(502).json({message:"تعذر التحقق من مرجع المركبة."});return;}
 const digest=pairPinDigest(context.data.vehicleId,b.pinCode);
 reply(res,await rpc(session,"petro_confirm_service_order",{p_order_id:req.params.id,p_expected_version:b.expectedVersion,p_pin_hmac:digest,p_request_key:b.idempotencyKey}));
});


for(const central of [false,true]){
 const path=(central?"/admin":"")+"/service-orders/:id/refunds";
 async function authorizeRefund(req:Request,res:Response):Promise<Session|null>{
  setNoStore(res);const session=await requireSession(req,res);if(!session)return null;
  if(typeof req.params.id!=="string"||!uuid.test(req.params.id)||Object.keys(req.query).length){res.status(400).json({message:"مرجع الطلب غير صالح."});return null;}
  if(central){const permission=await rpc(session,"petro_service_orders_query",{p_filters:{view:"central",orderId:req.params.id}});if(permission.error){reply(res,permission);return null;}}
  return session;
 }
 router.get(path,async(req:Request,res:Response)=>{
  const session=await authorizeRefund(req,res);if(!session)return;
  reply(res,await rpc(session,"petro_service_order_refund_requests",{p_order_id:req.params.id}));
 });
 router.post(path,async(req:Request,res:Response)=>{
  const session=await authorizeRefund(req,res);if(!session)return;
  const b=req.body;
  if(!isRecord(b)||Object.keys(b).some(k=>!["amountMinor","category","note","idempotencyKey"].includes(k))
   ||typeof b.amountMinor!=="string"||!/^[1-9][0-9]{0,17}$/.test(b.amountMinor)
   ||typeof b.category!=="string"||!["not_received","quality","quantity","billing"].includes(b.category)
   ||(b.note!==undefined&&b.note!==null&&(typeof b.note!=="string"||b.note.length>1000))
   ||typeof b.idempotencyKey!=="string"||!requestKey.test(b.idempotencyKey)){
   res.status(400).json({message:"أدخل مبلغًا صحيحًا ونوع المشكلة، واجعل الملاحظة اختيارية وبحد أقصى ألف حرف."});return;
  }
  reply(res,await rpc(session,"petro_request_service_refund",{p_order_id:req.params.id,p_amount_minor:b.amountMinor,p_category:b.category,p_note:b.note??null,p_request_key:b.idempotencyKey}));
 });
}
router.post("/service-refund-requests/:id/withdraw",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const b=req.body;
 if(typeof req.params.id!=="string"||!uuid.test(req.params.id)||Object.keys(req.query).length
 ||!isRecord(b)||Object.keys(b).some(k=>!["expectedVersion","idempotencyKey"].includes(k))
 ||!Number.isSafeInteger(b.expectedVersion)||Number(b.expectedVersion)<1
 ||typeof b.idempotencyKey!=="string"||!requestKey.test(b.idempotencyKey)){
 res.status(400).json({message:"مرجع طلب الاسترداد أو نسخته غير صالح."});return;
 }
 reply(res,await rpc(session,"petro_withdraw_service_refund",{p_request_id:req.params.id,p_expected_version:b.expectedVersion,p_request_key:b.idempotencyKey}));
});

export default router;
