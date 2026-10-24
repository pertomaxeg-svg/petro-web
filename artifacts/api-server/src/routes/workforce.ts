import { createHash } from "node:crypto";
import { fleetHmacSecret, pairPinDigest } from "../lib/fleetPairIdentity";
import { Router, type IRouter, type Request, type Response } from "express";
import { ListAdminWorkforceQueryParams, SetAdminWorkerAssignmentBody } from "@workspace/api-zod";
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
const operationGroups=new Set(["fuel","wash","oils","batteries","filters","parts","consumables"]);
router.post("/operations/pair-verifications",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const input=req.body;
 if(!isRecord(input)||Object.keys(input).some(key=>!["branchId","serviceGroup","credentialToken","pinCode","idempotencyKey"].includes(key))
 ||typeof input.branchId!=="string"||!operationUUID.test(input.branchId)||typeof input.serviceGroup!=="string"||!operationGroups.has(input.serviceGroup)
 ||typeof input.credentialToken!=="string"||!/^[A-Za-z0-9_-]{16,512}$/.test(input.credentialToken.trim())
 ||typeof input.pinCode!=="string"||!/^\d{4}$/.test(input.pinCode)
 ||typeof input.idempotencyKey!=="string"||input.idempotencyKey.trim().length<16||input.idempotencyKey.length>120){
 res.status(400).json({message:"اختر الفرع والخدمة وأدخل تعريف المركبة ورمز التعبئة المكون من أربعة أرقام."});return;
 }
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
export default router;
