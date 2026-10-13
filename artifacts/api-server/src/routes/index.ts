import { Router, type IRouter } from "express";
import healthRouter from "./health";
import supabaseRouter from "./supabase";

const router: IRouter = Router();

router.use(healthRouter);
router.use(supabaseRouter);

export default router;
