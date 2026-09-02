import { NewCampaignForm } from "./form";

export default function NewCampaignPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <h1 className="text-2xl font-semibold text-neutral-900">New campaign</h1>
      <p className="mt-1 mb-8 text-sm text-neutral-600">
        Describe what you sell and who you sell it to. LeadPilot researches matching leads from this.
      </p>
      <NewCampaignForm />
    </main>
  );
}
