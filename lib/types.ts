import type { LeadStatus, ResearchMode } from "./schemas";

// Re-exported so route handlers and components have one import site for row
// types and the status unions they are keyed by.
export type { LeadStatus, ResearchMode } from "./schemas";

export interface CampaignRow {
  id: string;
  name: string;
  product_name: string;
  product_description: string;
  target_market: string;
  extra_context: string | null;
  research_mode: ResearchMode;
  lead_count: number;
  status: "draft" | "researching" | "ready" | "failed";
  created_at: string;
  updated_at: string;
}

export interface LeadRow {
  id: string;
  campaign_id: string;
  company_name: string;
  company_domain: string | null;
  contact_name: string | null;
  contact_role: string;
  location: string | null;
  fit_reason: string;
  fit_score: number | null;
  sourced: boolean;
  sources: { title: string; url: string }[];
  status: LeadStatus;
  follow_up_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  lead_id: string;
  campaign_id: string;
  channel: string;
  subject: string | null;
  body: string;
  status: "draft" | "approved" | "sent";
  is_edited: boolean;
  model: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRunRow {
  id: string;
  campaign_id: string | null;
  kind: "research" | "draft";
  status: "running" | "succeeded" | "failed";
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
  finished_at: string | null;
}
