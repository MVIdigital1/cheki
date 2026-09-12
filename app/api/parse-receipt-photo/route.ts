import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/server";
import { matchPromoItems, type MatchableItem } from "@/lib/matchPromoItems";

export const runtime = "nodejs";
export const maxDuration = 60;

type VisionItem = {
  name: string;
  qty: number;
  price: number | null;
  code: string | null;
};

type VisionResult = {
  storeName: string | null;
  fiscalSign: string | null;
  kkmCode: string | null;
  sum: number | null;
  items: VisionItem[];
};

const PROMPT = `Ты распознаёшь казахстанский фискальный чек по фото (может быть несколько фото одного и того же чека — разные его части, чек длинный и не помещается в один кадр).

Верни СТРОГО один JSON-объект (без markdown, без пояснений, без обратных кавычек) вида:
{
  "storeName": "название магазина (ТОО/ИП/АО ...) или null",
  "fiscalSign": "номер фискального чека — ищи подпись 'Фискальный чек №' или 'ФБ/ФП' (только цифры) или null",
  "kkmCode": "код ККМ — подпись 'Код ККМ:' (только цифры) или null",
  "sum": число — итоговая сумма чека ('Итого' / 'Барлығы') или null,
  "items": [
    { "name": "название товара", "qty": число (штук или кг), "price": число или null (цена за единицу), "code": "NTIN или штрихкод товара, если виден рядом с позицией, иначе null" }
  ]
}

Правила:
- Если на разных фото видны разные позиции одного чека — объедини их все в один список items без повторов.
- Игнорируй строки "Скидка"/"Жеңілдік" — это не отдельные товары, а корректировка цены уже перечисленной выше позиции; на итоговое qty/price позиции они не влияют (бери количество и цену из строки вида "N шт × цена").
- Числа пиши как обычные числа (используй точку как разделитель дробной части), без пробелов и знака ₸.
- Если что-то не удалось прочитать — используй null, не выдумывай значения.`;

function extractJson(text: string): any {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("В ответе модели нет JSON");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function parseVisionJson(text: string): VisionResult {
  const parsed = extractJson(text);
  return {
    storeName: parsed.storeName ?? null,
    fiscalSign: parsed.fiscalSign ? String(parsed.fiscalSign).replace(/\D/g, "") : null,
    kkmCode: parsed.kkmCode ? String(parsed.kkmCode).replace(/\D/g, "") : null,
    sum: typeof parsed.sum === "number" ? parsed.sum : null,
    items: Array.isArray(parsed.items)
      ? parsed.items.map((it: any) => ({
          name: String(it.name ?? "").trim(),
          qty: typeof it.qty === "number" ? it.qty : parseFloat(it.qty) || 1,
          price: typeof it.price === "number" ? it.price : it.price ? parseFloat(it.price) : null,
          code: it.code ? String(it.code).replace(/\D/g, "") || null : null,
        }))
      : [],
  };
}

function dataUrlToBase64(dataUrl: string): { mediaType: string; data: string } {
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) throw new Error("Некорректный формат фото");
  return { mediaType: m[1], data: m[2] };
}

// Основной способ — Claude (Anthropic), точнее читает мелкий шрифт на длинных чеках.
async function callClaudeVision(images: string[]): Promise<VisionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY не задан в переменных окружения");
  }

  const content: any[] = images.map((img) => {
    const { mediaType, data } = dataUrlToBase64(img);
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  });
  content.push({ type: "text", text: PROMPT });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 2000,
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API вернул ошибку ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text: string = (data?.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  return parseVisionJson(text);
}

// Резервный способ — DeepSeek. Используется только если запрос к Claude не удался
// (сбой сети, лимит и т.п.), чтобы не звать оба ИИ на каждый чек без необходимости.
async function callDeepSeekVision(images: string[]): Promise<VisionResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY не задан в переменных окружения");
  }

  const content: any[] = [{ type: "text", text: PROMPT }];
  for (const img of images) {
    content.push({ type: "image_url", image_url: { url: img } });
  }

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash-vision-exp",
      messages: [{ role: "user", content }],
      temperature: 0,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API вернул ошибку ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text: string = data?.choices?.[0]?.message?.content ?? "";
  return parseVisionJson(text);
}

async function callVision(images: string[]): Promise<VisionResult> {
  try {
    return await callClaudeVision(images);
  } catch (claudeErr) {
    try {
      return await callDeepSeekVision(images);
    } catch (deepseekErr: any) {
      throw new Error(
        `Claude: ${String((claudeErr as any)?.message ?? claudeErr)}; DeepSeek: ${String(
          deepseekErr?.message ?? deepseekErr
        )}`
      );
    }
  }
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }

  const body = await req.json();
  const images: string[] = Array.isArray(body.images) ? body.images : [];
  if (images.length === 0) {
    return NextResponse.json({ error: "Нет фото чека" }, { status: 400 });
  }

  let vision: VisionResult;
  try {
    vision = await callVision(images);
  } catch (e: any) {
    return NextResponse.json(
      { error: "Не удалось распознать фото: " + String(e?.message ?? e) },
      { status: 502 }
    );
  }

  if (!vision.fiscalSign) {
    return NextResponse.json(
      { error: "Не удалось найти номер чека на фото — переснимите так, чтобы он попал в кадр" },
      { status: 422 }
    );
  }

  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("receipts")
    .select("id, store_name, sum, customer_phone, receipt_number, status")
    .eq("fiscal_sign", vision.fiscalSign)
    .maybeSingle();

  const useCached = !!existing && existing.status === "parsed";

  let receiptId: string;
  let items: MatchableItem[];
  let storeName: string | null;
  let receiptNumber: string | null;

  if (useCached) {
    receiptId = existing!.id;
    storeName = existing!.store_name;
    receiptNumber = existing!.receipt_number;
    const { data: existingItems } = await admin
      .from("receipt_items")
      .select("name, ntin, qty, promo_product_id")
      .eq("receipt_id", receiptId);
    items = (existingItems ?? []).map((it) => ({
      name: it.name,
      code: it.ntin,
      qty: Number(it.qty),
    }));
  } else {
    items = vision.items.map((it) => ({ name: it.name, code: it.code, qty: it.qty }));
    storeName = vision.storeName;
    receiptNumber = vision.fiscalSign;

    const payload = {
      promoter_id: user.id,
      fiscal_sign: vision.fiscalSign,
      rnm: vision.kkmCode ?? `photo-${vision.fiscalSign}`,
      sum: vision.sum,
      qr_raw: `photo:${vision.fiscalSign}`,
      store_name: storeName,
      receipt_number: receiptNumber,
      status: items.length > 0 ? "parsed" : "error",
      parse_error:
        items.length === 0 ? "Позиции не распознаны на фото" : "Распознано по фото (DeepSeek Vision)",
    };

    if (existing) {
      const { error: updateErr } = await admin.from("receipts").update(payload).eq("id", existing.id);
      if (updateErr) {
        return NextResponse.json(
          { error: "Ошибка обновления чека в базе: " + updateErr.message },
          { status: 500 }
        );
      }
      receiptId = existing.id;
      await admin.from("receipt_items").delete().eq("receipt_id", receiptId);
    } else {
      const { data: inserted, error: insertErr } = await admin
        .from("receipts")
        .insert(payload)
        .select("id")
        .single();
      if (insertErr || !inserted) {
        return NextResponse.json(
          { error: "Ошибка записи чека в базу: " + insertErr?.message },
          { status: 500 }
        );
      }
      receiptId = inserted.id;
    }
  }

  const { annotatedItems, bestGroup, bonusEligible } = await matchPromoItems(admin, items);

  if (!useCached && annotatedItems.length > 0) {
    await admin.from("receipt_items").insert(
      annotatedItems.map((it) => ({
        receipt_id: receiptId,
        name: it.name,
        ntin: it.code,
        qty: it.qty,
        promo_product_id: it.isPromo ? it.matchedProductId : null,
      }))
    );
  }

  const { data: existingBonus } = await admin
    .from("bonuses")
    .select("id, bonus_units")
    .eq("receipt_id", receiptId)
    .eq("status", "issued")
    .maybeSingle();

  const bonusUnits =
    bestGroup && bestGroup.requiredQty > 0 ? Math.floor(bestGroup.matchedQty / bestGroup.requiredQty) : 0;

  return NextResponse.json({
    receiptId,
    storeName,
    receiptNumber,
    fiscalSign: vision.fiscalSign,
    sum: vision.sum,
    fiscalTime: null,
    items: annotatedItems.map((it) => ({
      name: it.name,
      qty: it.qty,
      price: null,
      sum: null,
      isPromo: it.isPromo,
    })),
    bonusEligible,
    groupId: bestGroup ? bestGroup.groupId : null,
    groupName: bestGroup ? bestGroup.groupName : null,
    matchedQty: bestGroup ? bestGroup.matchedQty : 0,
    requiredQty: bestGroup ? bestGroup.requiredQty : null,
    bonusUnits,
    customerPhone: existing?.customer_phone ?? null,
    alreadyIssued: !!existingBonus,
    alreadyIssuedUnits: existingBonus?.bonus_units ?? 0,
    alreadyScanned: useCached,
  });
}
