import { ArrowUpRight, Download, Eye, EyeOff, Trash2 } from "lucide-react";
import { getDb } from "@/lib/db";
import { adminGate } from "@/components/admin-gate";
import { AdminSection, AdminShell, AdminTitle, StatTile } from "@/components/adminx/shell";
import { AddCreatorForm } from "@/components/adminx/rates-client";
import { ratesAdminStats } from "@/lib/rates";
import { deleteCreatorAction, hideCreatorAction } from "@/lib/rates-actions";
import { Card, Tag } from "@/components/ui";
import { timeAgo } from "@/lib/time";

export const metadata = { title: "Rates · Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const RATES_SITE = "https://rates.latars.xyz";

// Rates by Latars (rates.latars.xyz): who signed up, which creators people added, and what rates they came with.
export default async function RatesAdmin() {
  const gate = await adminGate();
  if (gate) return gate;
  const s = await ratesAdminStats(await getDb());
  return (
    <AdminShell project="rates" section="rates">
      <AdminTitle
        title="Rates"
        sub="rates.latars.xyz: creators, rate cards and sign-ups."
        action={
          <div className="flex gap-2 text-sm font-semibold">
            <a href={RATES_SITE} target="_blank" rel="noopener" className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-3 py-1.5 hover:border-ink/30">
              Open site <ArrowUpRight size={14} aria-hidden />
            </a>
            <a href="/adminx/rates-users.csv" className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-3 py-1.5 hover:border-ink/30">
              <Download size={14} aria-hidden /> Sign-ups (CSV)
            </a>
          </div>
        }
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile label="Creators added" value={s.creators} />
        <StatTile label="With rates" value={s.withRates} hint={`${s.rateItems} rates · ${s.files} files`} />
        <StatTile label="Sign-ups" value={s.users} />
        <StatTile label="New in 7 days" value={s.newUsers7} />
        <StatTile label="Hidden" value={s.hidden} alert={s.hidden > 0} />
      </div>
      <div className="mt-8 space-y-8">
        <AdminSection title="Add a creator" note="Just a link is enough. Add rates or a rate card if you have them.">
          <Card className="p-5">
            <AddCreatorForm />
          </Card>
        </AdminSection>
        <AdminSection title="Added on the site" note="The newest 200. Hide something to take it off the site without losing it.">
          {s.recent.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-line px-4 py-6 text-center text-sm text-muted">Nobody has added a creator yet. Creators from the directory itself aren&apos;t listed here.</p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
              {s.recent.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      <a href={`${RATES_SITE}/profile/${c.slug}`} target="_blank" rel="noopener" className="hover:underline">
                        {c.name}
                      </a>
                      <Tag>{c.niche}</Tag>
                      {c.hidden && <Tag tone="flame">Hidden</Tag>}
                    </p>
                    <p className="text-xs text-muted">
                      {c.platform}
                      {c.handle ? ` @${c.handle}` : ""} · {c.items.length} rate{c.items.length === 1 ? "" : "s"}
                      {c.files.length ? ` · ${c.files.length} file${c.files.length === 1 ? "" : "s"}` : ""} · {c.addedBy ?? "Deleted account"} · {timeAgo(new Date(c.createdAt))}
                    </p>
                  </div>
                  <form action={hideCreatorAction}>
                    <input type="hidden" name="id" value={c.id} />
                    <input type="hidden" name="hidden" value={c.hidden ? "0" : "1"} />
                    <button type="submit" className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1.5 text-sm font-semibold hover:border-ink/30">
                      {c.hidden ? <Eye size={14} aria-hidden /> : <EyeOff size={14} aria-hidden />} {c.hidden ? "Show" : "Hide"}
                    </button>
                  </form>
                  <form action={deleteCreatorAction}>
                    <input type="hidden" name="id" value={c.id} />
                    <button type="submit" className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-white px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50">
                      <Trash2 size={14} aria-hidden /> Delete
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </AdminSection>
      </div>
    </AdminShell>
  );
}
