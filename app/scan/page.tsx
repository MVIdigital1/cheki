"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";

type ParsedItem = {
  name: string;
  qty: number;
  price: number | null;
  sum: number | null;
  isPromo: boolean;
};

type ParseResult = {
  receiptId: string;
  storeName: string | null;
  sum: number | null;
  fiscalTime: string | null;
  items: ParsedItem[];
  bonusEligible: boolean;
  groupId: string | null;
  groupName: string | null;
  matchedQty: number;
  requiredQty: number | null;
  bonusUnits: number;
  customerPhone: string | null;
  alreadyIssued: boolean;
  alreadyIssuedUnits: number;
  alreadyScanned: boolean;
};

function pluralBonus(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return "бонусов";
  if (last === 1) return "бонус";
  if (last >= 2 && last <= 4) return "бонуса";
  return "бонусов";
}

export default function ScanPage() {
  const supabase = createClient();
  const [scanning, setScanning] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [bonusIssued, setBonusIssued] = useState(false);
  const [phone, setPhone] = useState("");
  const scannerRef = useRef<any>(null);
  const containerId = "qr-reader";

  const stopScanner = useCallback(async () => {
    if (scannerRef.current) {
      try {
        await scannerRef.current.stop();
        scannerRef.current.clear();
      } catch {
        // already stopped
      }
      scannerRef.current = null;
    }
  }, []);

  const handleDecoded = useCallback(
    async (decodedText: string) => {
      if (!scanning) return;
      setScanning(false);
      await stopScanner();
      setLoading(true);
      setError(null);
      setResult(null);
      setBonusIssued(false);

      try {
        const res = await fetch("/api/parse-receipt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ qrRaw: decodedText }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Не удалось разобрать чек");
        } else {
          setResult(data);
          setPhone(data.customerPhone || "");
        }
      } catch (e) {
        setError("Ошибка сети при обращении к серверу");
      } finally {
        setLoading(false);
      }
    },
    [scanning, stopScanner]
  );

  useEffect(() => {
    if (!scanning) return;
    let cancelled = false;

    import("html5-qrcode").then(({ Html5Qrcode }) => {
      if (cancelled) return;
      const scanner = new Html5Qrcode(containerId);
      scannerRef.current = scanner;
      scanner
        .start(
          { facingMode: "environment" },
          { fps: 10, qrbox: { width: 260, height: 260 } },
          (decodedText: string) => {
            handleDecoded(decodedText);
          },
          () => {
            // ignore per-frame decode failures
          }
        )
        .catch((err: unknown) => {
          setError("Не удалось получить доступ к камере: " + String(err));
        });
    });

    return () => {
      cancelled = true;
      stopScanner();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning]);

  async function handleIssueBonus() {
    if (!result || !result.groupId) return;
    if (!phone.trim()) {
      setError("Укажите номер телефона покупателя");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/issue-bonus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          receiptId: result.receiptId,
          groupId: result.groupId,
          matchedQty: result.matchedQty,
          phone: phone.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Не удалось выдать бонус");
      } else {
        setBonusIssued(true);
      }
    } catch {
      setError("Ошибка сети при выдаче бонуса");
    } finally {
      setLoading(false);
    }
  }

  function scanNext() {
    setResult(null);
    setError(null);
    setBonusIssued(false);
    setPhone("");
    setScanning(true);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <h1 className="text-lg font-semibold">Cheki — скан чека</h1>
        <div className="flex gap-3 text-sm">
          <a href="/dashboard" className="text-indigo-600">
            Статистика
          </a>
          <button onClick={handleLogout} className="text-slate-500">
            Выйти
          </button>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center gap-4 p-4">
        {scanning && (
          <div className="w-full max-w-sm overflow-hidden rounded-xl border border-slate-200">
            <div id={containerId} className="w-full" />
          </div>
        )}

        {loading && (
          <p className="text-sm text-slate-500">Проверяем чек в ОФД…</p>
        )}

        {error && (
          <div className="w-full max-w-sm rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
            <button
              onClick={scanNext}
              className="mt-3 block w-full rounded-lg bg-red-600 px-4 py-2 text-center text-sm text-white"
            >
              Сканировать ещё раз
            </button>
          </div>
        )}

        {result && !error && (
          <div className="w-full max-w-sm space-y-4">
            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-sm text-slate-500">{result.storeName}</p>
              <p className="text-sm text-slate-500">
                Сумма чека: {result.sum ?? "—"} ₸
              </p>
              {result.alreadyScanned && (
                <p className="mt-2 text-sm text-amber-600">
                  Этот чек уже был отсканирован ранее.
                </p>
              )}
              <ul className="mt-3 space-y-1 text-sm">
                {result.items.map((item, idx) => (
                  <li
                    key={idx}
                    className={
                      item.isPromo
                        ? "font-medium text-indigo-700"
                        : "text-slate-600"
                    }
                  >
                    {item.name} — {item.qty} шт
                  </li>
                ))}
              </ul>
            </div>

            {result.bonusEligible && !result.alreadyIssued && !bonusIssued && (
              <>
                <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-center text-sm text-emerald-700">
                  Вам положено {result.bonusUnits} {pluralBonus(result.bonusUnits)} (найдено {result.matchedQty} из {result.requiredQty} шт).
                </p>
                <div>
                  <label className="mb-1 block text-sm text-slate-500">
                    Номер телефона покупателя
                  </label>
                  <input
                    type="tel"
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+7 7__ ___ __ __"
                    className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none focus:border-indigo-500"
                  />
                </div>
                <button
                  onClick={handleIssueBonus}
                  disabled={loading || !phone.trim()}
                  className="w-full rounded-lg bg-emerald-600 px-4 py-4 text-lg font-semibold text-white disabled:opacity-50"
                >
                  Выдать {result.bonusUnits} {pluralBonus(result.bonusUnits)}
                </button>
              </>
            )}

            {(result.alreadyIssued || bonusIssued) && (
              <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-center text-sm text-emerald-700">
                Бонус по этому чеку уже выдан: {result.alreadyIssuedUnits || result.bonusUnits}{" "}
                {pluralBonus(result.alreadyIssuedUnits || result.bonusUnits)} ✓
              </p>
            )}

            {!result.bonusEligible && (
              <p className="rounded-lg border border-slate-200 bg-white p-3 text-center text-sm text-slate-500">
                {result.groupName
                  ? `В чеке недостаточно товаров акции «${result.groupName}»: найдено ${result.matchedQty} из ${result.requiredQty} шт (учитывается любая комбинация видов).`
                  : "В чеке не найдено товаров акции."}
              </p>
            )}

            <button
              onClick={scanNext}
              className="w-full rounded-lg border border-slate-300 px-4 py-3 text-sm"
            >
              Сканировать следующий чек
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
