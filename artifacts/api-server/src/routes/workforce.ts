import { createHash } from "node:crypto";
import { fleetHmacSecret, pairPinDigest } from "../lib/fleetPairIdentity";
import { Router, type IRouter, type Request, type Response } from "express";
import { ListAdminWorkforceQueryParams, SetAdminWorkerAssignmentBody, VerifyWorkerDriverPairBody, GetWorkerServiceOptionsQueryParams, QuoteWorkerServiceBody } from "@workspace/api-zod";
import { requireSession } from "./management";
import { isRecord, setNoStore } from "../lib/supabaseServer";

const router: IRouter = Router();
type Session = NonNullable<Awaited<ReturnType<typeof requireSession>>>;
async function rpc(session: Session, name: string, args: Record<string, unknown>) {
 return (session.supabase.rpc as unknown as (name:string,args:Record<string,unknown>)=>Promise<{data:unknown;error:{code?:string;message?:string}|null}>).call(session.supabase,name,args);
}
function reply(res: Response, result: Awaited<ReturnType<typeof rpc>>) {
 if(!result.error) { res.json(result.data); return; }
 const code=result.error.code;
 const status=code==="42501"?403:code==="P0002"?404:code==="22023"?400:["40001","23505","23514"].includes(code??"")?409:500;
 res.status(status).json({message:status===403?"لا يتوفر التفويض أو نطاق العضوية المطلوب لهذا الإجراء.":status===409?"تعارضت النسخة أو الخدمة مع شروط التكليف؛ حدّث البيانات وراجع نطاق العضوية.":status===404?"لم يُعثر على الفرع أو التكليف.":status===400?"راجع حقول التكليف.":"تعذر إتمام الطلب الآن."});
}
router.get("/admin/workforce",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const parsed=ListAdminWorkforceQueryParams.safeParse(req.query);
 if(!parsed.success||(parsed.data.view==="candidates"&&!parsed.data.branchId)) {res.status(400).json({message:"معايير تكليفات العمال غير صالحة."});return;}
 reply(res,await rpc(session,"petro_admin_worker_assignments",{p_filters:parsed.data}));
});
router.post("/admin/workforce/assignments",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const parsed=SetAdminWorkerAssignmentBody.strict().safeParse(req.body);
 if(!parsed.success||!Number.isSafeInteger(parsed.data.expectedVersion)||parsed.data.idempotencyKey.trim().length<12) {
 res.status(400).json({message:"بيانات تكليف العامل غير صالحة."});return;
 }
 const body=parsed.data;
 reply(res,await rpc(session,"petro_admin_worker_assignment",{p_user_id:body.userId,p_branch_id:body.branchId,p_service_group:body.serviceGroup,p_active:body.active,p_expected_version:body.expectedVersion,p_request_key:body.idempotencyKey}));
});
router.get("/operations/capabilities",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const result=await rpc(session,"petro_worker_capabilities",{});
 if(!result.error&&isRecord(result.data))result.data={...result.data,pinVerificationReady:!!fleetHmacSecret()};
 reply(res,result);
});
const operationUUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
router.post("/operations/pair-verifications",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const parsed=VerifyWorkerDriverPairBody.strict().safeParse(req.body);
 if(!parsed.success||parsed.data.idempotencyKey.trim().length<16){
 res.status(400).json({message:"اختر الفرع والخدمة وأدخل تعريف المركبة ورمز التعبئة المكون من أربعة أرقام."});return;
 }
 const input=parsed.data;
 if(!fleetHmacSecret()){res.status(503).json({message:"التحقق غير متاح مؤقتًا؛ راجع مسؤول التشغيل."});return;}
 const credentialHash=createHash("sha256").update(input.credentialToken.trim(),"utf8").digest("hex");
 const context=await rpc(session,"petro_worker_credential_context",{p_branch_id:input.branchId,p_service_group:input.serviceGroup,p_credential_hash:credentialHash});
 if(context.error){reply(res,context);return;}
 if(!isRecord(context.data)||context.data.recognized!==true){res.json({valid:false,locked:false,retryAt:null});return;}
 if(typeof context.data.vehicleId!=="string"||!operationUUID.test(context.data.vehicleId)){res.status(502).json({message:"تعذر التحقق من بيانات التعريف."});return;}
 const digest=pairPinDigest(context.data.vehicleId,input.pinCode);
 reply(res,await rpc(session,"petro_worker_verify_pair",{p_branch_id:input.branchId,p_service_group:input.serviceGroup,p_credential_hash:credentialHash,p_pin_hmac:digest,p_request_key:input.idempotencyKey}));
});
router.get("/operations/pair-verifications/:id",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const id=req.params.id;
 if(typeof id!=="string"||!operationUUID.test(id)){res.status(400).json({message:"مرجع التحقق غير صالح."});return;}
 reply(res,await rpc(session,"petro_worker_pin_proof",{p_proof_id:id}));
});

function quoteReply(res:Response,result:Awaited<ReturnType<typeof rpc>>){
 if(!result.error){res.json(result.data);return;}
 const messages:Record<string,string>={
 OPERATIONAL_PROOF_REQUIRED:"انتهى التحقق أو تغيّر التفويض؛ أدخل رمز التعبئة من جديد.",
 PROVIDER_SUBSCRIPTION_REQUIRED:"اشتراك فرع مقدم الخدمة غير فعال.",
 SERVICE_PRICE_UNAVAILABLE:"الصنف أو سعره المعتمد غير متاح لهذا الفرع والخدمة.",
 SERVICE_PRICE_CHANGED:"تغيّر السعر؛ حدّث الأصناف ثم احسب السعر مجددًا.",
 INVENTORY_LOCATION_REQUIRED:"اختر مخزن البيع.",
 };
 const known=Object.keys(messages).find(key=>result.error?.message===key);
 const status=result.error.code==="42501"?403:result.error.code==="22023"?400:["40001","23514","23505"].includes(result.error.code??"")?409:500;
 res.status(status).json({code:known??(status===400?"INVALID_QUOTE_INPUT":"QUOTATION_UNAVAILABLE"),message:known?messages[known]:status===400?"راجع الصنف والكمية والمبلغ.":"تعذر حساب السعر الآن."});
}
router.get("/operations/service-options",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const parsed=GetWorkerServiceOptionsQueryParams.strict().safeParse(req.query);
 if(!parsed.success){res.status(400).json({message:"معايير اختيار الخدمة غير صالحة."});return;}
 const q=parsed.data;
 quoteReply(res,await rpc(session,"petro_worker_service_options",{p_proof_id:q.proofId,p_search:q.search??null,p_page:q.page,p_page_size:q.pageSize}));
});
router.post("/operations/service-quotes",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const parsed=QuoteWorkerServiceBody.strict().safeParse(req.body);
 if(!parsed.success||!isRecord(req.body.input)||Object.keys(req.body.input).length!==1){
 res.status(400).json({message:"اختر صنفًا وسعرًا حاليًا وأدخل كمية أو مبلغًا صالحًا."});return;}
 const q=parsed.data;
 quoteReply(res,await rpc(session,"petro_worker_quote_service",{p_proof_id:q.proofId,p_reference_id:q.referenceId,p_price_version_id:q.priceVersionId,p_input:q.input,p_location_id:q.locationId??null}));
});
export default router;
