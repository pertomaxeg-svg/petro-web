import { Router, type IRouter } from "express";
import authRouter from "./auth";
import billingRouter from "./billing";
import catalogRouter from "./catalog";
import financeRouter from "./finance";
import fleetRouter from "./fleet";
import healthRouter from "./health";
import inventoryRouter from "./inventory";
import managementRouter from "./management";
import organizationWorkflowsRouter from "./organization-workflows";
import supabaseRouter from "./supabase";

const router: IRouter = Router();

router.use(healthRouter);
router.use(supabaseRouter);
router.use(authRouter);
router.use(managementRouter);
router.use(billingRouter);
router.use(catalogRouter);
router.use(financeRouter);
router.use(fleetRouter);
router.use(inventoryRouter);
router.use(organizationWorkflowsRouter);

export default router;
