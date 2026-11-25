import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { fetchTrialStats, orderPageCandidates } from "@/lib/orderPage";
import { prisma } from "@/lib/prisma";
import { safeHttpUrl } from "@/lib/url";

export const metadata: Metadata = { title: "Order page shops" };

const CELL = "border-b border-zinc-200 px-3 py-3 align-top dark:border-zinc-800";
const LINK = "underline underline-offset-2 hover:text-zinc-900 dark:hover:text-zinc-50";

/** The leads that could use an order page, each with its own link and what came of it. */
export default async function OrderPageShops() {
  await connection();
  const { stats, problem } = await fetchTrialStats();
  const shops = await orderPageCandidates(prisma, stats);

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 dark:bg-black">
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-12 text-zinc-700 dark:text-zinc-300">
        <Link href="/" className="text-sm text-zinc-500 hover:underline">
          ← Campaigns
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Order page shops</h1>
            <p className="mt-1 max-w-xl text-sm text-zinc-500 dark:text-zinc-400">
              Shops from your scans that sell goods that go in a parcel, have no website on record, and can be reached.
              Read each one before writing to it; nothing is sent from here.
            </p>
          </div>
          {shops.length > 0 && (
            // A download, not a page: a plain link, so the router doesn't try to navigate to it.
            <a href="/api/order-page/export" download className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
              Export CSV
            </a>
          )}
        </div>

        {problem && (
          <p role="status" className="mt-6 rounded-md bg-amber-100 px-4 py-3 text-sm text-amber-900 dark:bg-amber-900/40 dark:text-amber-200">
            {problem}
          </p>
        )}

        {shops.length === 0 ? (
          <p className="mt-8 text-sm">
            None yet. Run a campaign for a shop type such as <code>clothes</code>, or several at once with{" "}
            <code>shop=clothes,shop=shoes,shop=cosmetics,shop=jewelry</code>.
          </p>
        ) : (
          <div className="mt-8 overflow-x-auto">
            <table className="w-full min-w-3xl text-left text-sm">
              <caption className="sr-only">Shops an order page could suit, best first</caption>
              <thead>
                <tr className="text-zinc-500">
                  {["Shop", "Why", "Reach", "Its link", "Opened", "Demo orders", "Signed up"].map((h) => (
                    <th key={h} scope="col" className={CELL}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shops.map((s) => (
                  <tr key={s.leadId}>
                    <td className={CELL}>
                      <Link href={`/leads/${s.leadId}`} className={`font-medium ${LINK}`}>
                        {s.name}
                      </Link>
                      <div className="text-zinc-500">
                        {s.campaign.name}, {s.crmStage.toLowerCase()}
                      </div>
                    </td>
                    <td className={CELL}>{s.reasons.join("; ")}</td>
                    <td className={CELL}>
                      {[
                        ["Instagram", s.instagram],
                        ["Facebook", s.facebook],
                      ].map(([label, url]) => {
                        const href = safeHttpUrl(url);
                        return (
                          href && (
                            <a key={label} href={href} target="_blank" rel="noreferrer" className={`block ${LINK}`}>
                              {label}
                            </a>
                          )
                        );
                      })}
                      {s.phone}
                    </td>
                    <td className={`${CELL} font-mono text-xs break-all select-all`}>{s.link ?? "—"}</td>
                    <td className={CELL}>{s.visits ? s.visits.view : "—"}</td>
                    <td className={CELL}>{s.visits ? s.visits.demo_order : "—"}</td>
                    <td className={CELL}>{s.visits ? s.visits.signup : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
