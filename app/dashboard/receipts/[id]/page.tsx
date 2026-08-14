import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ReceiptDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: receipt } = await supabase
    .from("receipts")
    .select(
      "id, store_name, sum, fiscal_time, status, parse_error, created_at, customer_phone"
    )
    .eq("id", id)
    .maybeSingle();

  if (!receipt) {
    notFound();
  }

  const { data: items } = await supabase
    .from("receipt_items")
    .select("name, qty, price, sum, promo_product_id")
    .eq("receipt_id", id)
    .order("name");

  const { data: bonuses } = await supabase
    .from("bonuses")
    .select("id, bonus_units, qty_matched, status, created_at, promo_groups(name)")
    .eq("receipt_id", id);

  return (
    <div className="min-h-screen bg-slate-50 p-4">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Детали чека</h1>
        <a href="/dashboard" className="text-sm text-indigo-600">
          К статистике
        </a>
      </header>

      <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-sm text-slate-500">{receipt.store_name ?? "Магазин не определён"}</p>
        <p className="mt-1 text-2xl font-bold text-slate-900">
          {receipt.sum ?? "—"} ₸
        </p>
        <p className="mt-1 text-sm text-slate-500">
          {receipt.fiscal_time
            ? new Date(receipt.fiscal_time).toLocaleString("ru-RU")
            : "—"}
        </p>
        <p className="mt-2 text-xs text-slate-400">
          Статус: {receipt.status}
          {receipt.parse_error ? ` · ${receipt.parse_error}` : ""}
        </p>
        {receipt.customer_phone && (
          <p className="mt-2 text-sm font-medium text-indigo-700">
            Телефон покупателя: {receipt.customer_phone}
          </p>
        )}
      </div>

      <h2 className="mb-3 text-sm font-medium text-slate-500">Товары в чеке</h2>
      <div className="mb-6 space-y-2">
        {(items ?? []).map((it: any, idx: number) => (
          <div
            key={idx}
            className={
              "rounded-lg border p-3 text-sm shadow-sm " +
              (it.promo_product_id
                ? "border-indigo-200 bg-indigo-50"
                : "border-slate-200 bg-white")
            }
          >
            <div className="flex justify-between">
              <span
                className={
                  it.promo_product_id
                    ? "font-medium text-indigo-700"
                    : "text-slate-700"
                }
              >
                {it.name}
              </span>
              <span className="text-slate-500">{it.qty} шт</span>
            </div>
            {(it.price || it.sum) && (
              <div className="mt-1 text-xs text-slate-400">
                {it.price ? `цена ${it.price} ₸` : ""}
                {it.sum ? ` · сумма ${it.sum} ₸` : ""}
              </div>
            )}
          </div>
        ))}
        {(!items || items.length === 0) && (
          <p className="text-sm text-slate-400">
            Товары не распознаны (см. сырой текст в базе, поле raw_ofd_text).
          </p>
        )}
      </div>

      <h2 className="mb-3 text-sm font-medium text-slate-500">Выданные бонусы</h2>
      <div className="space-y-2">
        {(bonuses ?? []).map((b: any) => (
          <div
            key={b.id}
            className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700"
          >
            {b.promo_groups?.name ?? "—"} · {b.bonus_units} шт бонуса ·{" "}
            {new Date(b.created_at).toLocaleString("ru-RU")}
          </div>
        ))}
        {(!bonuses || bonuses.length === 0) && (
          <p className="text-sm text-slate-400">По этому чеку бонус не выдавался.</p>
        )}
      </div>
    </div>
  );
}
