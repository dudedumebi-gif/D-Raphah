import { Router, type IRouter } from "express";
import healthRouter from "./health";
import consultationsRouter from "./consultations";

const router: IRouter = Router();

router.use(healthRouter);
router.use(consultationsRouter);

export default router;
