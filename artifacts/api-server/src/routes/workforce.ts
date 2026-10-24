import { Router, type IRouter, type Request, type Response } from "express";
import { ListAdminWorkforceQueryParams, SetAdminWorkerAssignmentBody } from "@workspace/api-zod";
import { requireSession } from "./management";
import { setNoStore } from "../lib/supabaseServer";

const router: IRouter = Router();
type Session = NonNullable<Awaited<ReturnType<typeof requireSession>>>;
async function rpc(session: Session, name: string, args: Record<string, unknown>) {
 return (session.supabase.rpc as unknown as (name:string,args:Record<string,unknown>)=>Promise<{data:unknown;error:{code?:string;message?:string}|null}>).call(session.supabase,name,args);
}
function reply(res: Response, result: Awaited<ReturnType<typeof rpc>>) {
 if(!result.error) { res.json(result.data); return; }
 const code=result.error.code;
 const status=code==="42501"?403:code==="P0002"?404:code==="22023"?400:["40001","23505","23514"].includes(code??"")?409:500;
 res.status(status).json({message:status===403?"يلزم تفويض الإدارة وعضوية تشغيل فعالة في الفرع.":status===409?"تعارضت النسخة أو الخدمة مع شروط التكليف؛ حدّث البيانات وراجع نطاق العضوية.":status===404?"لم يُعثر على الفرع أو التكليف.":status===400?"راجع حقول التكليف.":"تعذر إتمام الطلب الآن."});
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
 reply(res,await rpc(session,"petro_worker_capabilities",{}));
});
export default router;
