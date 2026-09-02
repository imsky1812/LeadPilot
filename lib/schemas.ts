import { z } from "zod";

export const SourceSchema = z.object({
  title: z.string(),
  url: z.string(),
});

export const LeadSchema = z.object({
  company_name: z.string(),
  company_domain: z.string().nullable(),
  contact_name: z.string().nullable(),
  contact_role: z.string(),
  location: z.string().nullable(),
  fit_reason: z.string(),
  fit_score: z.number().int().min(0).max(100),
  sources: z.array(SourceSchema),
});

export const LeadsSchema = z.object({
  leads: z.array(LeadSchema),
});

export const DraftSchema = z.object({
  subject: z.string(),
  body: z.string(),
  personalization_note: z.string(),
});

export const RESEARCH_MODES = ["simulated", "web"] as const;
export const LEAD_STATUSES = ["new", "contacted", "follow_up", "replied"] as const;
export const MESSAGE_STATUSES = ["draft", "approved", "sent"] as const;

export const CreateCampaignSchema = z.object({
  name: z.string().min(1).max(200),
  product_name: z.string().min(1).max(200),
  product_description: z.string().min(1).max(5000),
  target_market: z.string().min(1).max(2000),
  extra_context: z.string().max(20000).optional(),
  research_mode: z.enum(RESEARCH_MODES).default("simulated"),
  lead_count: z.number().int().min(1).max(25).default(10),
});

export const UpdateLeadSchema = z
  .object({
    status: z.enum(LEAD_STATUSES).optional(),
    follow_up_at: z.string().date().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export const UpdateMessageSchema = z
  .object({
    subject: z.string().max(300).optional(),
    body: z.string().max(20000).optional(),
    status: z.enum(MESSAGE_STATUSES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export type Lead = z.infer<typeof LeadSchema>;
export type Draft = z.infer<typeof DraftSchema>;
export type CreateCampaignInput = z.infer<typeof CreateCampaignSchema>;
export type ResearchMode = (typeof RESEARCH_MODES)[number];
export type LeadStatus = (typeof LEAD_STATUSES)[number];
