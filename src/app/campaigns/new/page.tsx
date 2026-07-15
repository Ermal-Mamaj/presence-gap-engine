"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function NewCampaignPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [niche, setNiche] = useState("");
  const [source, setSource] = useState<"OSM" | "GOOGLE_MAPS_SCRAPER">("OSM");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, region, niche, source }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Failed to create campaign");
      }
      const campaign = await res.json();
      router.push(`/campaigns/${campaign.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <main className="mx-auto w-full max-w-lg flex-1 px-6 py-12">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">New campaign</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Pick one target box. Not &ldquo;businesses in Europe&rdquo; — something like &ldquo;dentists in Tirana&rdquo;.
        </p>

        <form onSubmit={handleSubmit} className="mt-8 space-y-5">
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Campaign name</label>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tirana dentists, no-website"
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Region</label>
            <input
              required
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              placeholder="Tirana, Albania"
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Niche</label>
            <input
              required
              value={niche}
              onChange={(e) => setNiche(e.target.value)}
              placeholder="dentist"
              className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
            <p className="mt-1 text-xs text-zinc-500">
              OSM source works best with common terms: dentist, restaurant, hairdresser, lawyer, gym, cafe, etc.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-300">Data source</label>
            <div className="mt-2 space-y-2">
              <label className="flex items-start gap-2 rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700">
                <input
                  type="radio"
                  checked={source === "OSM"}
                  onChange={() => setSource("OSM")}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-50">OpenStreetMap (recommended)</span>
                  <br />
                  <span className="text-zinc-500">Free, no ToS risk. Coverage varies by region.</span>
                </span>
              </label>
              <label className="flex items-start gap-2 rounded-md border border-zinc-300 p-3 text-sm dark:border-zinc-700">
                <input
                  type="radio"
                  checked={source === "GOOGLE_MAPS_SCRAPER"}
                  onChange={() => setSource("GOOGLE_MAPS_SCRAPER")}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium text-zinc-900 dark:text-zinc-50">Google Maps scraper (experimental)</span>
                  <br />
                  <span className="text-zinc-500">
                    Richer data, but violates Google&rsquo;s ToS and may break or get rate-limited. Small volumes only.
                  </span>
                </span>
              </label>
            </div>
          </div>

          {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {submitting ? "Creating…" : "Create campaign"}
          </button>
        </form>
      </main>
    </div>
  );
}
