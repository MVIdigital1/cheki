import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ReportPage() {
  const supabase = await createClient();

  const { data: stats } = await supabase
    .from("promo_stats")
    .select("*")
    .single();

  // Продано по каждой позиции акции.
  const { data: soldItems } = await supabase
    .from("receipt_items")
    .select("qty, promo_product_id, promo_products(name)")
    .not("promo_product_id", "is", null);

  const soldByProduct = new Map<string, { name: string; qty: number }>();
  for (const it of soldItems ?? []) {
    const pp: any = Array.isArray((it as any).promo_products)
      ? (it as any).promo_products[0]
      : (it as any).promo_products;
    const id = (it as any).promo_product_id as string;
    const name = pp?.name ?? "Без названия";
    const existing = soldByProduct.get(id);
    if (existing) {
      existing.qty += Number(it.qty);
    } else {
      soldByProduct.set(id, { name, qty: Number(it.qty) });
    }
  }

  // Бонусов выдано по каждой акции (группе товаров).
  const { data: bonuses } = await supabase
    .from("bonuses")
    .select("bonus_units, group_id, promo_groups(name)")
    .eq("status", "issued");

  const bonusByGroup = new Map<string, { name: string; units: number; events: number }>();
  for (const b of bonuses ?? []) {
    const g: any = Array.isArray((b as any).promo_groups)
      ? (b as any).promo_groups[0]
      : (b as any).promo_groups;
    const id = (b as any).group_id as string;
    const name = g?.name ?? "—";
    const existing = bonusByGroup.get(id);
    if (existing) {
      existing.units += Number(b.bonus_units ?? 0);
      existing.events += 1;
    } else {
      bonusByGroup.set(id, { name, units: Number(b.bonus_units ?? 0), events: 1 });
    }
  }

  const soldRows = Array.from(soldByProduct.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  const bonusRows = Array.from(bonusByGroup.values());
  const totalSold = soldRows.reduce((sum, r) => sum + r.qty, 0);
  const totalBonusUnits = bonusRows.reduce((sum, r) => sum + r.units, 0);
  const totalBonusEvents = bonusRows.reduce((sum, r) => sum + r.events, 0);

  const today = new Date().toLocaleDateString("ru-RU");

  return (
    <div className="min-h-screen bg-slate-50 p-4 print:bg-white">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <a href="/dashboard" className="text-sm text-indigo-600">
          К статистике
        </a>
        <button
          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm"
          data-print
        >
          Печать / сохранить PDF
        </button>
      </div>

      <div className="mx-auto max-w-2xl rounded-xl border border-slate-200 bg-white p-6 shadow-sm print:border-0 print:shadow-none">
        <h1 className="text-center text-lg font-semibold">ТОО «Пятый элемент»</h1>
        <p className="mb-6 text-center text-sm text-slate-500">
          Отчёт по промо-акции на дату {today}
        </p>

        <h2 className="mb-2 text-sm font-medium text-slate-600">
          Продано позиций акции
        </h2>
        <table className="mb-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th className="py-2 pr-2">Наименование</th>
              <th className="py-2 text-right">Продано, шт</th>
            </tr>
          </thead>
          <tbody>
            {soldRows.map((r, idx) => (
              <tr key={idx} className="border-b border-slate-100">
                <td className="py-2 pr-2">{r.name}</td>
                <td className="py-2 text-right">{r.qty}</td>
              </tr>
            ))}
            {soldRows.length === 0 && (
              <tr>
                <td colSpan={2} className="py-3 text-center text-slate-400">
                  Пока нет данных
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-300 font-semibold">
              <td className="py-2 pr-2">Итого</td>
              <td className="py-2 text-right">{totalSold}</td>
            </tr>
          </tfoot>
        </table>

        <h2 className="mb-2 text-sm font-medium text-slate-600">
          Выдано бонусов по акции
        </h2>
        <table className="mb-6 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-300 text-left">
              <th className="py-2 pr-2">Акция</th>
              <th className="py-2 text-right">Чеков с бонусом</th>
              <th className="py-2 text-right">Бонусов, шт</th>
            </tr>
          </thead>
          <tbody>
            {bonusRows.map((r, idx) => (
              <tr key={idx} className="border-b border-slate-100">
                <td className="py-2 pr-2">{r.name}</td>
                <td className="py-2 text-right">{r.events}</td>
                <td className="py-2 text-right">{r.units}</td>
              </tr>
            ))}
            {bonusRows.length === 0 && (
              <tr>
                <td colSpan={3} className="py-3 text-center text-slate-400">
                  Пока нет данных
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr className="border-t border-slate-300 font-semibold">
              <td className="py-2 pr-2">Итого</td>
              <td className="py-2 text-right">{totalBonusEvents}</td>
              <td className="py-2 text-right">{totalBonusUnits}</td>
            </tr>
          </tfoot>
        </table>

        <p className="text-sm text-slate-500">
          Всего отсканировано чеков: {stats?.total_receipts ?? 0}
        </p>
      </div>

      <PrintScript />
    </div>
  );
}

function PrintScript() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `document.querySelector('[data-print]')?.addEventListener('click', function () { window.print(); });`,
      }}
    />
  );
}
