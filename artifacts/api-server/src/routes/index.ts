import { Router, type IRouter } from "express";
import authRouter from "./auth";
import billingRouter from "./billing";
import financeRouter from "./finance";
import fleetRouter from "./fleet";
import healthRouter from "./health";
import managementRouter from "./management";
import organizationWorkflowsRouter from "./organization-workflows";
import auditEventsRouter from "./audit-events";
import serviceOrdersRouter from "./service-orders";
import supabaseRouter from "./supabase";

const router: IRouter = Router();

router.use(healthRouter);
router.use(supabaseRouter);
router.use(authRouter);
router.use(managementRouter);
router.use(billingRouter);
router.use(financeRouter);
router.use(fleetRouter);
router.use(organizationWorkflowsRouter);
router.use(serviceOrdersRouter);
router.use(auditEventsRouter);

export default router;
