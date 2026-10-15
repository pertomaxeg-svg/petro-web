import { Router, type IRouter } from "express";
import authRouter from "./auth";
import healthRouter from "./health";
import managementRouter from "./management";
import organizationWorkflowsRouter from "./organization-workflows";
import supabaseRouter from "./supabase";

const router: IRouter = Router();

router.use(healthRouter);
router.use(supabaseRouter);
router.use(authRouter);
router.use(managementRouter);
router.use(organizationWorkflowsRouter);

export default router;
