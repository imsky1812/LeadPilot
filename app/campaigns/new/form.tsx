"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewCampaignForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true);
    setError(null);

    const fd = new FormData(e.currentTarget);
    const payload = {
      name: String(fd.get("name") ?? ""),
      product_name: String(fd.get("product_name") ?? ""),
      product_description: String(fd.get("product_description") ?? ""),
      target_market: String(fd.get("target_market") ?? ""),
      extra_context: String(fd.get("extra_context") ?? "") || undefined,
      research_mode: String(fd.get("research_mode") ?? "simulated"),
      lead_count: Number(fd.get("lead_count") ?? 10),
    };

    const res = await fetch("/api/campaigns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    setPending(false);

    if (!res.ok) {
      setError(json.detail ?? json.error ?? "Something went wrong");
      return;
    }
    router.push(`/campaigns/${json.campaign.id}`);
  }

  const field = "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm";
  const label = "block text-sm font-medium text-neutral-700 mb-1";

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div>
        <label className={label} htmlFor="name">Campaign name</label>
        <input id="name" name="name" required className={field} placeholder="Q3 cold chain outreach" />
      </div>
      <div>
        <label className={label} htmlFor="product_name">Product name</label>
        <input id="product_name" name="product_name" required className={field} placeholder="RouteIQ" />
      </div>
      <div>
        <label className={label} htmlFor="product_description">Product description</label>
        <textarea id="product_description" name="product_description" required rows={4} className={field}
          placeholder="Route optimization for refrigerated fleets. Cuts spoilage by predicting thermal risk per leg." />
      </div>
      <div>
        <label className={label} htmlFor="target_market">Target market</label>
        <textarea id="target_market" name="target_market" required rows={2} className={field}
          placeholder="Mid-size European cold chain logistics operators, 50-500 vehicles" />
      </div>
      <div>
        <label className={label} htmlFor="extra_context">Catalog or extra context (optional)</label>
        <textarea id="extra_context" name="extra_context" rows={6} className={field}
          placeholder="Paste a product catalog, pricing sheet, or positioning notes." />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={label} htmlFor="research_mode">Research mode</label>
          <select id="research_mode" name="research_mode" className={field} defaultValue="simulated">
            <option value="simulated">Simulated — no web search</option>
            <option value="web">Web search — real companies</option>
          </select>
        </div>
        <div>
          <label className={label} htmlFor="lead_count">Number of leads</label>
          <input id="lead_count" name="lead_count" type="number" min={1} max={25} defaultValue={10} className={field} />
        </div>
      </div>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <button type="submit" disabled={pending}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
        {pending ? "Creating…" : "Create campaign"}
      </button>
    </form>
  );
}
