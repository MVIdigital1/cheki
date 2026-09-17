import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

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

function dataUrlToBase64(dataUrl: string): { mediaType: string; data: string } {
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) throw new Error("Некорректный формат фото");
  return { mediaType: m[1], data: m[2] };
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const images: string[] = Array.isArray(body.images) ? body.images : [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const content: any[] = images.map((img) => {
    const { mediaType, data } = dataUrlToBase64(img);
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  });
  content.push({ type: "text", text: PROMPT });

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 2000,
      messages: [{ role: "user", content }],
    }),
  });

  const text = await res.text();
  return NextResponse.json({ status: res.status, body: text });
}
