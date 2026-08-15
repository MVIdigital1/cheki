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
      "id, created_at, qty_matched, bonus_units, receipt_id, receipts(store_name, sum), promo_groups(name)"
    )
    .order("created_at", { ascending: false })
    .limit(20);

  const { data: recentReceipts } = await supabase
    .from("receipts")
    .select("id, store_name, sum, status, created_at")
    .order("created_at", { ascending: false })
    .limit(30);

  return (
    <div className="min-h-screen bg-slate-50 p-4">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Статистика акции</h1>
        <div className="flex gap-3 text-sm">
          <a href="/dashboard/report" className="text-indigo-600">
            Отчёт
          </a>
          <a href="/scan" className="text-indigo-600">
            К сканеру
          </a>
        </div>
      </header>

      <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="Чеков отсканировано" value={stats?.total_receipts ?? 0} />
        <StatCard
          label="Позиций акции продано"
          value={stats?.total_promo_items_sold ?? 0}
        />
        <StatCard label="Бонусов выдано" value={stats?.total_bonuses_issued ?? 0} />
      </div>

      <h2 className="mb-3 text-sm font-medium text-slate-500">
        Последние выданные бонусы
      </h2>
      <div className="mb-8 space-y-2">
        {(recentBonuses ?? []).map((b: any) => (
          <a
            key={b.id}
            href={`/dashboard/receipts/${b.receipt_id}`}
            className="block rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-sm transition hover:border-indigo-300"
          >
            <div className="flex justify-between">
              <span>{b.promo_groups?.name ?? "—"} · {b.bonus_units ?? 1} шт бонуса</span>
              <span className="text-slate-400">
                {new Date(b.created_at).toLocaleString("ru-RU")}
              </span>
            </div>
            <div className="text-slate-500">
              {b.receipts?.store_name} · чек на {b.receipts?.sum} ₸
            </div>
          </a>
        ))}
        {(!recentBonuses || recentBonuses.length === 0) && (
          <p className="text-sm text-slate-400">Пока нет выданных бонусов.</p>
        )}
      </div>

      <h2 className="mb-3 text-sm font-medium text-slate-500">
        Все отсканированные чеки
      </h2>
      <div className="space-y-2">
        {(recentReceipts ?? []).map((r: any) => (
          <a
            key={r.id}
            href={`/dashboard/receipts/${r.id}`}
            className="block rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-sm transition hover:border-indigo-300"
          >
            <div className="flex justify-between">
              <span>{r.store_name ?? "—"}</span>
              <span className="text-slate-400">
                {new Date(r.created_at).toLocaleString("ru-RU")}
              </span>
            </div>
            <div className="text-slate-500">
              чек на {r.sum ?? "—"} ₸ · статус: {r.status}
            </div>
          </a>
        ))}
        {(!recentReceipts || recentReceipts.length === 0) && (
          <p className="text-sm text-slate-400">Пока нет отсканированных чеков.</p>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-3xl font-bold text-slate-900">{value}</div>
      <div className="mt-1 text-sm text-slate-500">{label}</div>
    </div>
  );
}
