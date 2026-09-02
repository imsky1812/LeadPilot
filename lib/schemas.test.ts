import { describe, it, expect } from "vitest";
import { LeadsSchema, DraftSchema, CreateCampaignSchema } from "./schemas";

describe("LeadsSchema", () => {
  it("accepts a well-formed lead", () => {
    const parsed = LeadsSchema.parse({
      leads: [
        {
          company_name: "Northwind Logistics",
          company_domain: "northwind.example",
          contact_name: null,
          contact_role: "VP of Operations",
          location: "Rotterdam, NL",
          fit_reason: "Runs a cold chain fleet and publicly posts about route waste.",
          fit_score: 82,
          sources: [{ title: "Northwind about page", url: "https://northwind.example/about" }],
        },
      ],
    });
    expect(parsed.leads[0].company_name).toBe("Northwind Logistics");
    expect(parsed.leads[0].sources).toHaveLength(1);
  });

  it("rejects a fit_score above 100", () => {
    expect(() =>
      LeadsSchema.parse({
        leads: [
          {
            company_name: "X",
            company_domain: null,
            contact_name: null,
            contact_role: "CTO",
            location: null,
            fit_reason: "reason",
            fit_score: 140,
            sources: [],
          },
        ],
      }),
    ).toThrow();
  });
});

describe("DraftSchema", () => {
  it("requires subject, body and personalization_note", () => {
    expect(() => DraftSchema.parse({ subject: "Hi", body: "Hello" })).toThrow();
  });
});

describe("CreateCampaignSchema", () => {
  it("defaults research_mode to simulated and lead_count to 10", () => {
    const parsed = CreateCampaignSchema.parse({
      name: "Q3 cold chain",
      product_name: "RouteIQ",
      product_description: "Route optimization for refrigerated fleets.",
      target_market: "Mid-size European cold chain logistics operators",
    });
    expect(parsed.research_mode).toBe("simulated");
    expect(parsed.lead_count).toBe(10);
  });

  it("rejects lead_count above 25", () => {
    expect(() =>
      CreateCampaignSchema.parse({
        name: "n",
        product_name: "p",
        product_description: "d",
        target_market: "t",
        lead_count: 99,
      }),
    ).toThrow();
  });
});
