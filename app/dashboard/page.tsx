import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await createClient();

  const { data: stats } = await supabase
    .from("promo_stats")
    .select("*")
    .single();

  const { data: recentBonuses } = await supabase
    .from("bonuses")
    .select(
      "id, created_at, qty_matched, bonus_units, receipts(store_name, sum), promo_groups(name)"
    )
    .order("created_at", { ascending: false })
    .limit(20);

  return (
    <div className="min-h-screen p-4">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Статистика акции</h1>
        <a href="/scan" className="text-sm text-indigo-400">
          К сканеру
        </a>
      </header>

      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Чеков отсканировано" value={stats?.total_receipts ?? 0} />
        <StatCard
          label="Позиций акции продано"
          value={stats?.total_promo_items_sold ?? 0}
        />
        <StatCard label="Бонусов выдано" value={stats?.total_bonuses_issued ?? 0} />
      </div>

      <h2 className="mb-3 text-sm font-medium text-gray-400">
        Последние выданные бонусы
      </h2>
      <div className="space-y-2">
        {(recentBonuses ?? []).map((b: any) => (
          <div
            key={b.id}
            className="rounded-lg border border-gray-800 bg-gray-900 p-3 text-sm"
          >
            <div className="flex justify-between">
              <span>{b.promo_groups?.name ?? "—"} · {b.bonus_units ?? 1} шт бонуса</span>
              <span className="text-gray-500">
                {new Date(b.created_at).toLocaleString("ru-RU")}
              </span>
            </div>
            <div className="text-gray-500">
              {b.receipts?.store_name} · чек на {b.receipts?.sum} ₸
            </div>
          </div>
        ))}
        {(!recentBonuses || recentBonuses.length === 0) && (
          <p className="text-sm text-gray-500">Пока нет выданных бонусов.</p>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <div className="text-3xl font-bold">{value}</div>
      <div className="mt-1 text-sm text-gray-400">{label}</div>
    </div>
  );
}
