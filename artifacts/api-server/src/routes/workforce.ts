import { Router, type IRouter, type Request, type Response } from "express";
import { requireSession } from "./management";
import { isRecord, setNoStore } from "../lib/supabaseServer";

const router: IRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const groups = new Set(["fuel","wash","oils","batteries","filters","parts","consumables","card_issuance"]);
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
 const view=req.query.view??"assignments";
 const page=Number(req.query.page??1),pageSize=Number(req.query.pageSize??20);
 const search=req.query.search;
 if(!["assignments","candidates"].includes(String(view))||!Number.isInteger(page)||page<1||page>100000||!Number.isInteger(pageSize)||pageSize<1||pageSize>100
 ||(search!==undefined&&(typeof search!=="string"||search.length>160))
 ||["branchId","userId"].some(key=>req.query[key]!==undefined&&(typeof req.query[key]!=="string"||!UUID.test(String(req.query[key]))))
 ||(view==="candidates"&&!req.query.branchId)) {res.status(400).json({message:"معايير تكليفات العمال غير صالحة."});return;}
 reply(res,await rpc(session,"petro_admin_worker_assignments",{p_filters:{view,page,pageSize,search:search??null,branchId:req.query.branchId??null,userId:req.query.userId??null}}));
});
router.post("/admin/workforce/assignments",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 const body=req.body;
 if(!isRecord(body)||Object.keys(body).some(key=>!["userId","branchId","serviceGroup","active","expectedVersion","idempotencyKey"].includes(key))
 ||typeof body.userId!=="string"||!UUID.test(body.userId)||typeof body.branchId!=="string"||!UUID.test(body.branchId)
 ||typeof body.serviceGroup!=="string"||!groups.has(body.serviceGroup)||typeof body.active!=="boolean"
 ||!Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<0
 ||typeof body.idempotencyKey!=="string"||body.idempotencyKey.trim().length<12||body.idempotencyKey.length>160) {
 res.status(400).json({message:"بيانات تكليف العامل غير صالحة."});return;
 }
 reply(res,await rpc(session,"petro_admin_worker_assignment",{p_user_id:body.userId,p_branch_id:body.branchId,p_service_group:body.serviceGroup,p_active:body.active,p_expected_version:body.expectedVersion,p_request_key:body.idempotencyKey}));
});
router.get("/operations/capabilities",async(req:Request,res:Response)=>{
 setNoStore(res);const session=await requireSession(req,res);if(!session)return;
 reply(res,await rpc(session,"petro_worker_capabilities",{}));
});
export default router;
