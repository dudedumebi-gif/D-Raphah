import { Router, type IRouter } from "express";
import { db, consultationsTable } from "@workspace/db";
import {
  CreateConsultationBody,
  CreateConsultationResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.post("/consultations", async (req, res): Promise<void> => {
  const parsed = CreateConsultationBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid consultation request");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [consultation] = await db
    .insert(consultationsTable)
    .values(parsed.data)
    .returning();

  req.log.info({ consultationId: consultation.id }, "Consultation request received");
  res.status(201).json(CreateConsultationResponse.parse(consultation));
});

export default router;