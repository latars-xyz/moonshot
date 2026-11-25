import { ArrowUpRight } from "lucide-react";
import { adminGate } from "@/components/admin-gate";
import { AdminShell, AdminTitle } from "@/components/adminx/shell";
import { Card } from "@/components/ui";

export const metadata = { title: "Rates · Admin", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const RATES_SITE = "https://rates.latars.xyz";

// Rates (rates.latars.xyz): rate cards for creators and media firms. The site is still static (sample data and
// published rate cards live in its own repo), so there are no sign-ups or usage numbers to show yet.
export default async function RatesAdmin() {
  const gate = await adminGate();
  if (gate) return gate;
  return (
    <AdminShell project="rates" section="rates">
      <AdminTitle
        title="Rates"
        sub="rates.latars.xyz: rate cards and benchmarks for creators and media firms."
        action={
          <a href={RATES_SITE} target="_blank" rel="noopener" className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-3 py-1.5 text-sm font-semibold hover:border-ink/30">
            Open site <ArrowUpRight size={14} aria-hidden />
          </a>
        }
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-5">
          <h3 className="font-extrabold">Pages</h3>
          <ul className="mt-2 divide-y divide-line text-sm">
            {[
              ["Search and profiles", "/"],
              ["Rate estimator", "/estimate"],
              ["Benchmarks", "/benchmarks"],
            ].map(([name, path]) => (
              <li key={path}>
                <a href={`${RATES_SITE}${path}`} target="_blank" rel="noopener" className="flex items-center justify-between py-1.5 hover:text-flame">
                  <span>{name}</span>
                  <ArrowUpRight size={14} aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </Card>
        <Card className="p-5">
          <h3 className="font-extrabold">Status</h3>
          <p className="mt-2 text-sm text-muted">
            Rates has no database yet, so claims, rate submissions and enquiries (from the plan) can&apos;t be reviewed here. Once the site stores them, they get their own sections in this admin.
          </p>
        </Card>
      </div>
    </AdminShell>
  );
}
