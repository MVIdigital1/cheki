"use client";

type SoldRow = { name: string; qty: number };
type BonusRow = { name: string; events: number; units: number };

export default function ReportActions({
  soldRows,
  bonusRows,
  promoterLabel,
}: {
  soldRows: SoldRow[];
  bonusRows: BonusRow[];
  promoterLabel: string;
}) {
  function handlePrint() {
    window.print();
  }

  function handleExport() {
    const lines: string[] = [];
    lines.push(`Отчёт по промо-акции;${promoterLabel}`);
    lines.push("");
    lines.push("Продано позиций акции");
    lines.push("Наименование;Продано, шт");
    for (const r of soldRows) {
      lines.push(`${r.name};${r.qty}`);
    }
    lines.push("");
    lines.push("Выдано бонусов по акции");
    lines.push("Акция;Чеков с бонусом;Бонусов, шт");
    for (const r of bonusRows) {
      lines.push(`${r.name};${r.events};${r.units}`);
    }

    const csv = "﻿" + lines.join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `otchet-promo-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex gap-2">
      <button
        onClick={handleExport}
        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm"
      >
        Экспорт (CSV)
      </button>
      <button
        onClick={handlePrint}
        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm"
      >
        Печать / сохранить PDF
      </button>
    </div>
  );
}
