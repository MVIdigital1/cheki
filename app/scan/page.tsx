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

// Приводит ввод к 10 цифрам локальной части (без кода страны +7).
function formatPhoneInput(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("7") || digits.startsWith("8")) {
    digits = digits.slice(1);
  }
  return digits.slice(0, 10);
}

function formatPhoneDisplay(digits: string): string {
  const parts = [
    digits.slice(0, 3),
    digits.slice(3, 6),
    digits.slice(6, 8),
    digits.slice(8, 10),
  ].filter(Boolean);
  return "+7 " + parts.join(" ");
}

function isValidPhone(digits: string): boolean {
  return digits.length === 10;
}

function pluralBonus(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return "бонусов";
  if (last === 1) return "бонус";
  if (last >= 2 && last <= 4) return "бонуса";
  return "бонусов";
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Фото с телефона весят по несколько МБ — сервер отклоняет слишком большие запросы.
// Сжимаем на устройстве перед отправкой: текст на чеке остаётся читаемым, а вес падает
// в несколько раз.
async function compressImage(file: File, maxDimension = 1600, quality = 0.75): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file);
  const img = document.createElement("img");
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = reject;
    img.src = dataUrl;
  });

  let { width, height } = img;
  if (width > maxDimension || height > maxDimension) {
    if (width > height) {
      height = Math.round((height * maxDimension) / width);
      width = maxDimension;
    } else {
      width = Math.round((width * maxDimension) / height);
      height = maxDimension;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

type Mode = "qr" | "photo";

export default function ScanPage() {
  const supabase = createClient();
  const [mode, setMode] = useState<Mode>("qr");

  // Общее для обоих способов
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ParseResult | null>(null);
  const [bonusIssued, setBonusIssued] = useState(false);
  const [phone, setPhone] = useState("");

  // QR-сканер
  const [scanning, setScanning] = useState(true);
  const [lastQrRaw, setLastQrRaw] = useState<string | null>(null);
  const [manualQtyInput, setManualQtyInput] = useState("");
  const [manualLoading, setManualLoading] = useState(false);
  const scannerRef = useRef<any>(null);
  const containerId = "qr-reader";

  // Фото чека
  const [photos, setPhotos] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      setLastQrRaw(decodedText);
      setManualQtyInput("");

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
          setPhone(formatPhoneInput(data.customerPhone || ""));
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
    if (mode !== "qr" || !scanning) return;
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
  }, [mode, scanning]);

  async function handleManualEntry() {
    const qty = parseInt(manualQtyInput, 10);
    if (!lastQrRaw || !qty || qty <= 0) {
      setError("Укажите количество полотенец (число больше 0)");
      return;
    }
    setManualLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/parse-receipt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qrRaw: lastQrRaw, manualQty: qty }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Не удалось сохранить чек");
      } else {
        setResult(data);
        setPhone(formatPhoneInput(data.customerPhone || ""));
      }
    } catch {
      setError("Ошибка сети при обращении к серверу");
    } finally {
      setManualLoading(false);
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await compressImage(file);
      setPhotos((prev) => [...prev, dataUrl]);
    } catch {
      setError("Не удалось прочитать фото");
    }
  }

  function removePhoto(idx: number) {
    setPhotos((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleAnalyzePhoto() {
    if (photos.length === 0) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setBonusIssued(false);
    try {
      const res = await fetch("/api/parse-receipt-photo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: photos }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Не удалось распознать чек");
      } else {
        setResult(data);
        setPhone(formatPhoneInput(data.customerPhone || ""));
      }
    } catch {
      setError("Ошибка сети при обращении к серверу");
    } finally {
      setLoading(false);
    }
  }

  async function handleIssueBonus() {
    if (!result || !result.groupId) return;
    if (!isValidPhone(phone)) {
      setError("Введите номер телефона полностью: +7 и 10 цифр");
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
          phone: "+7" + phone,
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
    setLastQrRaw(null);
    setManualQtyInput("");
    setPhotos([]);
    setScanning(true);
  }

  function switchMode(next: Mode) {
    setMode(next);
    scanNext();
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    window.location.href = "/login";
  }

  const showCapture = !result && !error && !loading;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white px-4 py-3">
        <div>
          <h1 className="whitespace-nowrap text-sm font-semibold leading-tight sm:text-base">
            ТОО «Пятый элемент KZ»
          </h1>
          <p className="text-xs text-slate-500">Сканирование чеков промо акций</p>
        </div>
        <div className="mt-2 flex gap-3 text-sm">
          <a href="/dashboard" className="text-indigo-600">
            Статистика
          </a>
          <a href="/dashboard/report" className="text-indigo-600">
            Отчёт
          </a>
          <button onClick={handleLogout} className="text-slate-500">
            Выйти
          </button>
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center gap-4 p-4">
        {showCapture && mode === "qr" && scanning && (
          <div className="w-full max-w-sm space-y-3">
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <div id={containerId} className="w-full" />
            </div>
            <button
              onClick={() => switchMode("photo")}
              className="w-full rounded-lg border border-indigo-300 px-4 py-3 text-sm font-medium text-indigo-700"
            >
              Если QR не сканирует — сфоткать чек
            </button>
          </div>
        )}

        {showCapture && mode === "photo" && (
          <div className="w-full max-w-sm space-y-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleFileChange}
            />
            <button
              onClick={() => switchMode("qr")}
              className="text-sm text-indigo-600"
            >
              ← Сканировать QR
            </button>
            <p className="text-sm text-slate-500">
              Сфотографируйте чек. Если он длинный — сделайте несколько фото по частям.
            </p>
            {photos.length > 0 && (
              <div className="grid grid-cols-3 gap-2">
                {photos.map((p, idx) => (
                  <div key={idx} className="relative">
                    <img src={p} alt={`Фото ${idx + 1}`} className="h-24 w-full rounded-lg object-cover" />
                    <button
                      onClick={() => removePhoto(idx)}
                      className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs text-white"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="w-full rounded-lg border border-indigo-300 px-4 py-3 text-sm font-medium text-indigo-700"
            >
              {photos.length === 0 ? "Сфотографировать чек" : "Добавить ещё фото"}
            </button>
            {photos.length > 0 && (
              <button
                onClick={handleAnalyzePhoto}
                className="w-full rounded-lg bg-indigo-600 px-4 py-4 text-lg font-semibold text-white"
              >
                Распознать чек ({photos.length} фото)
              </button>
            )}
          </div>
        )}

        {loading && (
          <p className="text-sm text-slate-500">
            {mode === "qr" ? "Проверяем чек в ОФД…" : "Распознаём чек…"}
          </p>
        )}

        {error && (
          <div className="w-full max-w-sm space-y-3">
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              {error}
              <button
                onClick={scanNext}
                className="mt-3 block w-full rounded-lg bg-red-600 px-4 py-2 text-center text-sm text-white"
              >
                Начать заново
              </button>
            </div>

            {mode === "qr" && lastQrRaw && (
              <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
                <p className="mb-2 text-slate-600">
                  Не получилось проверить автоматически (сайт ОФД показывает капчу). Откройте чек
                  сами, пройдите капчу и посмотрите, есть ли полотенца «Пятый элемент»:
                </p>
                <a
                  href={lastQrRaw}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mb-3 block w-full rounded-lg border border-indigo-300 px-4 py-2 text-center text-indigo-700"
                >
                  Открыть чек в браузере
                </a>
                <label className="mb-1 block text-slate-500">
                  Сколько штук полотенец в чеке? (0, если нет)
                </label>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={manualQtyInput}
                  onChange={(e) => setManualQtyInput(e.target.value)}
                  placeholder="0"
                  className="mb-2 w-full rounded-lg border border-slate-300 px-4 py-3 text-base text-slate-900 outline-none focus:border-indigo-500"
                />
                <button
                  onClick={handleManualEntry}
                  disabled={manualLoading || !manualQtyInput}
                  className="w-full rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {manualLoading ? "Сохраняем…" : "Указать вручную"}
                </button>
              </div>
            )}

            {mode === "qr" && (
              <button
                onClick={() => switchMode("photo")}
                className="w-full rounded-lg border border-slate-300 px-4 py-3 text-sm text-slate-600"
              >
                Или сфотографировать чек вместо QR
              </button>
            )}
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
                    inputMode="numeric"
                    required
                    value={formatPhoneDisplay(phone)}
                    onChange={(e) => setPhone(formatPhoneInput(e.target.value))}
                    placeholder="+7 ___ ___ __ __"
                    className="w-full rounded-lg border border-slate-300 bg-white px-4 py-3 text-base text-slate-900 outline-none focus:border-indigo-500"
                  />
                </div>
                <button
                  onClick={handleIssueBonus}
                  disabled={loading || !isValidPhone(phone)}
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
