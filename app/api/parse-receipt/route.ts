import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 150;

type QrParams = {
  fiscalSign: string; // i
  rnm: string; // f
  sum: string; // s
  time: string; // t, format 20260812T102557
  url: string; // исходная ссылка ОФД из QR — у разных операторов разные домены (oofd.kz, kofd.kz и т.д.)
};

function parseQr(qrRaw: string): QrParams | null {
  try {
    const url = new URL(
      qrRaw.includes("://") ? qrRaw : `https://${qrRaw}`
    );
    const i = url.searchParams.get("i");
    const f = url.searchParams.get("f");
    const s = url.searchParams.get("s");
    const t = url.searchParams.get("t");
    if (!i || !f) return null;
    return { fiscalSign: i, rnm: f, sum: s ?? "", time: t ?? "", url: url.toString() };
  } catch {
    return null;
  }
}

// Разные ОФД по-разному верстают страницу проверки чека. Пробуем несколько
// стратегий по очереди, а не завязываемся на конкретные слова формы собственности.
function extractStoreName(text: string): string | null {
  // Стратегия A: Казахтелеком (consumer.oofd.kz) — название всегда идёт сразу
  // после строки "FP <номер>" и перед адресом.
  const mA = text.match(
    /FP\s+\d+\s*\n\n([\s\S]{3,200}?)\n\n(?:обл\.|г\.|с\.|ЖСН|БСН|БИН)/
  );
  if (mA) {
    const raw = mA[1].replace(/\s+/g, " ").trim();
    const quoted = raw.match(/"([^"]{2,120})"/);
    return quoted ? `ТОО "${quoted[1].trim()}"` : raw;
  }

  // Стратегия B: Jusan Mobile (consumer.kofd.kz) и похожие — ASCII-чек с
  // центрированной строкой вида '   ТОО "СУПЕРМАРКЕТ "СОЛНЕЧНЫЙ""   '.
  const mB = text.match(/^[ \t]*(ТОО|ИП|АО)[^\n]{0,150}/m);
  if (mB) {
    return mB[0]
      .replace(/\s+/g, " ")
      .replace(/"{2,}/g, '"')
      .trim();
  }

  return null;
}

// Порядковый номер чека — есть не у всех ОФД (напр. у Jusan Mobile есть,
// у Казахтелекома на странице проверки нет — тогда используем fiscal_sign).
function extractReceiptNumber(text: string): string | null {
  const m = text.match(/[Пп]орядковый номер чека\s+(\S+)/);
  return m ? m[1] : null;
}

function toIso(t: string): string | null {
  // format: 20260812T102557
  const m = t.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}`;
}

type ParsedLine = {
  name: string;
  ntin: string | null;
  code: string | null; // любой найденный код товара (NTIN или штрихкод) — сверяется с promo_product_codes
  qty: number;
  price: number | null;
  sum: number | null;
};

function parseItemsFromText(text: string): ParsedLine[] {
  const items: ParsedLine[] = [];

  // Strategy 1: новый формат Казахтелеком ОФД (consumer.oofd.kz, React-версия сайта) —
  // каждая позиция начинается с "N.\n\n" и дальше поля (название/NTIN/XTIN/количество)
  // идут каждое на отдельной строке. Между кодом товара и итоговым количеством может
  // встретиться произвольное число строк скидок ("Жеңілдік/Скидка ... ₸"), поэтому не
  // завязываемся на соседство полей — режем текст на блоки по маркерам позиций и внутри
  // каждого блока ищем название/код/количество независимо друг от друга.
  const itemStartRe = /(?:^|\n)(\d{1,3})\.\s*\n+/g;
  const starts: number[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = itemStartRe.exec(text)) !== null) {
    starts.push(sm.index + sm[0].length);
  }

  for (let i = 0; i < starts.length; i++) {
    const blockStart = starts[i];
    const blockEnd = i + 1 < starts.length ? starts[i + 1] : text.length;
    const block = text.slice(blockStart, blockEnd);

    const qtyMatch = block.match(
      /(\d+(?:[.,]\d+)?)\s*(?:дана\/шт|шт|кг|дана)\s*[x×]\s*([\d\s]+[.,]\d{2})/i
    );
    if (!qtyMatch) continue; // похоже, это не товарная позиция (или формат не распознан)

    const codeMatch = block.match(/(?:NTIN|XTIN)\s+([0-9]{6,20})/i);

    const labelRe = /(?:NTIN|XTIN)\b|\d+(?:[.,]\d+)?\s*(?:дана\/шт|шт|кг|дана)\s*[x×]/i;
    const nameEndIdx = block.search(labelRe);
    const name = block
      .slice(0, nameEndIdx > 0 ? nameEndIdx : block.length)
      .replace(/\s+/g, " ")
      .trim();

    const code = codeMatch ? codeMatch[1] : null;
    const qty = parseFloat(qtyMatch[1].replace(",", "."));
    const price = parseFloat(qtyMatch[2].replace(/\s/g, "").replace(",", "."));
    items.push({ name, ntin: code, code, qty, price, sum: null });
  }

  if (items.length > 0) return items;

  // Strategy 1b: старый однострочный формат Казахтелеком (на случай если сайт снова
  // изменится или откатится) — "1. Полотенце бумажное ... NTIN:0200135188196 1 дана/шт x 550,00".
  const blockRe =
    /(\d+)\.\s+([\s\S]{3,300}?)(?:NTIN[:\s]*([0-9]{6,20}))?\s*(\d+(?:[.,]\d+)?)\s*(?:дана\/шт|шт|дана)\s*[x×]\s*([\d\s]+[.,]\d{2})/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const name = m[2].replace(/\s+/g, " ").trim();
    const ntin = m[3] ?? null;
    const qty = parseFloat(m[4].replace(",", "."));
    const price = parseFloat(m[5].replace(/\s/g, "").replace(",", "."));
    items.push({ name, ntin, code: ntin, qty, price, sum: null });
  }

  if (items.length > 0) return items;

  // Strategy 2: формат других ОФД (напр. Jusan Mobile, consumer.kofd.kz), напр.
  // "1. 4660105673859: Полотенце бумажное Пятый элемент 2сл 2рул ... =628.00"
  // Код товара (штрихкод/NTIN) идёт сразу после номера позиции, количество часто не указано явно (по умолчанию 1).
  const blockRe2 =
    /(\d+)\.\s*(\d{6,20})\s*:\s*([\s\S]{3,300}?)\s*=\s*([\d\s]+[.,]\d{2})/g;
  while ((m = blockRe2.exec(text)) !== null) {
    const code = m[2];
    const name = m[3].replace(/\s+/g, " ").trim();
    const price = parseFloat(m[4].replace(/\s/g, "").replace(",", "."));
    items.push({ name, ntin: null, code, qty: 1, price, sum: null });
  }

  return items;
}

function looksLikeRealContent(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.includes("FP ") ||
    trimmed.includes("Fiscal receipt preview") ||
    trimmed.includes("Порядковый номер чека") ||
    trimmed.length > 400
  );
}

// Один заход через резидентный прокси: открываем страницу и ждём, пока сайт
// отрисует сам чек (а не просто форму-заглушку "Дата покупки / Время покупки / ...").
async function fetchOfdTextOnce(
  playwright: typeof import("playwright-core").chromium,
  browserlessToken: string,
  url: string,
  gotoTimeoutMs: number,
  pollDeadlineMs: number
): Promise<string> {
  // Сайт ОФД включает защиту от ботов (риск-скоринг по IP) и с обычных дата-центровых
  // адресов Browserless стабильно отдаёт только пустую страницу-заглушку, не показывая
  // сам чек. Резидентный прокси Browserless делает запрос похожим на обычного
  // пользователя (домашний/мобильный IP) — никакую капчу мы при этом не решаем и не
  // обходим, сайт просто не помечает такой трафик как подозрительный и не блокирует его.
  // proxySticky не задаём намеренно: при повторной попытке (см. fetchOfdText) новая
  // сессия должна получить новый IP из пула — часть IP пула тоже может быть в бане.
  const browser = await playwright.connectOverCDP(
    `wss://chrome.browserless.io?token=${browserlessToken}&proxy=residential&proxyCountry=kz&ignoreHTTPSErrors=true`
  );

  try {
    const page = await browser.newPage();
    // networkidle часто не наступает на этих сайтах (фоновые запросы/аналитика
    // не дают сети "успокоиться"), из-за чего page.goto стабильно падает по
    // таймауту. domcontentloaded надёжнее — дальше ждём появления текста чека
    // явным поллингом, а не фиксированной паузой.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: gotoTimeoutMs });

    let text = "";
    const deadline = Date.now() + pollDeadlineMs;
    while (Date.now() < deadline) {
      text = await page.evaluate(() => document.body.innerText);
      if (looksLikeRealContent(text)) break;
      await page.waitForTimeout(500);
    }
    return text;
  } finally {
    await browser.close();
  }
}

async function fetchOfdText(params: QrParams): Promise<string> {
  const { chromium: playwright } = await import("playwright-core");

  const browserlessToken = process.env.BROWSERLESS_TOKEN;
  if (!browserlessToken) {
    throw new Error("BROWSERLESS_TOKEN не задан в переменных окружения");
  }

  // Резидентные IP выдаются из общего пула Browserless, и часть из них тоже уже
  // может быть заблокирована защитой ОФД от ботов. Поэтому делаем до 2 попыток
  // с НОВОЙ сессией (= новым IP) каждая — если первая попытка попала на "плохой"
  // IP и вернула только страницу-заглушку, вторая попытка может получить другой IP
  // и пройти успешно. Бюджет подобран так, чтобы уложиться в maxDuration (90с).
  let lastText = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    lastText = await fetchOfdTextOnce(playwright, browserlessToken, params.url, 20000, 20000);
    if (looksLikeRealContent(lastText)) return lastText;
  }
  return lastText;
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
  const qrRaw: string = body.qrRaw;
  if (!qrRaw) {
    return NextResponse.json({ error: "Пустой QR" }, { status: 400 });
  }
  // Ручной ввод: если сайт ОФД показал капчу промоутеру и авто-проверка не проходит,
  // промоутер сам смотрит на открытый им же чек и вводит количество товара акции —
  // никакого скрапинга в этом случае не делаем, просто считаем бонус по этому числу.
  const manualQty: number | null =
    typeof body.manualQty === "number" && body.manualQty > 0 ? body.manualQty : null;

  const params = parseQr(qrRaw);
  if (!params) {
    return NextResponse.json(
      { error: "QR-код не похож на ссылку ОФД Казахтелекома" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  // Already scanned before?
  const { data: existing } = await admin
    .from("receipts")
    .select("id, store_name, sum, fiscal_time, customer_phone, receipt_number, status")
    .eq("fiscal_sign", params.fiscalSign)
    .eq("rnm", params.rnm)
    .maybeSingle();

  // Успешно распознанный раньше чек — просто переиспользуем сохранённые позиции.
  // Если в прошлый раз была ошибка (0 позиций), пробуем загрузить заново, а не
  // возвращаем тот же пустой результат навсегда.
  const useCached = !!existing && existing.status === "parsed";

  let receiptId: string;
  let items: ParsedLine[] = [];
  let storeName: string | null = null;
  let receiptNumber: string | null = null;
  let rawText = "";

  if (useCached) {
    receiptId = existing!.id;
    storeName = existing!.store_name;
    receiptNumber = existing!.receipt_number;
    const { data: existingItems } = await admin
      .from("receipt_items")
      .select("name, ntin, qty, price, sum, promo_product_id")
      .eq("receipt_id", receiptId);
    items = (existingItems ?? []).map((it) => ({
      name: it.name,
      ntin: it.ntin,
      code: it.ntin,
      qty: Number(it.qty),
      price: it.price ? Number(it.price) : null,
      sum: it.sum ? Number(it.sum) : null,
    }));
  } else if (manualQty !== null) {
    // Промоутер сам открыл чек по ссылке, прошёл капчу и посмотрел на позиции глазами —
    // просто фиксируем указанное им количество товара акции как одну позицию.
    // Название специально совпадает с шаблоном сопоставления товара акции
    // (match_pattern), чтобы позиция сопоставилась так же, как при авто-разборе.
    items = [
      {
        name: `Полотенце бумажное "Пятый элемент" (${manualQty} шт, введено вручную промоутером)`,
        ntin: null,
        code: null,
        qty: manualQty,
        price: null,
        sum: null,
      },
    ];
    storeName = existing?.store_name ?? null;
    receiptNumber = existing?.receipt_number ?? null;

    const payload = {
      promoter_id: user.id,
      fiscal_sign: params.fiscalSign,
      rnm: params.rnm,
      sum: params.sum ? parseFloat(params.sum) : null,
      fiscal_time: toIso(params.time),
      qr_raw: qrRaw,
      store_name: storeName,
      receipt_number: receiptNumber,
      status: "parsed",
      parse_error: "Количество введено вручную промоутером (капча ОФД)",
      raw_ofd_text: existing ? undefined : null,
    };

    if (existing) {
      const { error: updateErr } = await admin
        .from("receipts")
        .update(payload)
        .eq("id", existing.id);
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
  } else {
    try {
      rawText = await fetchOfdText(params);
    } catch (e: any) {
      return NextResponse.json(
        { error: "Не удалось загрузить чек с сайта ОФД: " + String(e?.message ?? e) },
        { status: 502 }
      );
    }

    items = parseItemsFromText(rawText);

    storeName = extractStoreName(rawText);
    receiptNumber = extractReceiptNumber(rawText);

    const payload = {
      promoter_id: user.id,
      fiscal_sign: params.fiscalSign,
      rnm: params.rnm,
      sum: params.sum ? parseFloat(params.sum) : null,
      fiscal_time: toIso(params.time),
      qr_raw: qrRaw,
      store_name: storeName,
      receipt_number: receiptNumber,
      status: items.length > 0 ? "parsed" : "error",
      parse_error: items.length === 0 ? "Позиции не найдены в тексте ОФД" : null,
      raw_ofd_text: rawText.slice(0, 20000),
    };

    if (existing) {
      // Повторная попытка: обновляем ранее неудачную запись вместо создания дубля.
      const { error: updateErr } = await admin
        .from("receipts")
        .update(payload)
        .eq("id", existing.id);
      if (updateErr) {
        return NextResponse.json(
          { error: "Ошибка обновления чека в базе: " + updateErr.message },
          { status: 500 }
        );
      }
      receiptId = existing.id;
      // На случай если при прошлой (неудачной) попытке что-то всё же записалось.
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

  // Load active promo products (with their group) to match against.
  // Products in the same group count together — any combination of them
  // reaching the group's required_qty makes the receipt bonus-eligible.
  const { data: promoProducts } = await admin
    .from("promo_products")
    .select("id, name, ntin, match_pattern, group_id, promo_groups(id, name, required_qty)")
    .eq("is_active", true);

  // Все известные коды (NTIN/GTIN) для акционных товаров — накапливаются по мере
  // сканирования в разных магазинах, где на одном и том же товаре могут быть разные коды.
  const { data: productCodes } = await admin
    .from("promo_product_codes")
    .select("code, product_id");
  const codeToProductId = new Map<string, string>();
  for (const c of productCodes ?? []) {
    codeToProductId.set(c.code, c.product_id);
  }
  const promoProductsById = new Map((promoProducts ?? []).map((pp) => [pp.id, pp]));

  type GroupTally = { groupId: string; groupName: string; requiredQty: number; matchedQty: number; matchedProductId: string };
  const groupTallies = new Map<string, GroupTally>();

  const annotatedItems = items.map((it) => {
    let isPromo = false;
    let matchedProductId: string | null = null;

    // 1) Сначала точное совпадение по коду товара (NTIN или штрихкод) — самый надёжный способ,
    //    не зависит от того, как магазин подписал название на кассе.
    const codeMatchId = it.code ? codeToProductId.get(it.code) : undefined;
    if (codeMatchId && promoProductsById.has(codeMatchId)) {
      const pp = promoProductsById.get(codeMatchId)!;
      isPromo = true;
      matchedProductId = pp.id;
      const group: any = Array.isArray(pp.promo_groups) ? pp.promo_groups[0] : pp.promo_groups;
      if (group) {
        const existingTally = groupTallies.get(group.id);
        if (existingTally) {
          existingTally.matchedQty += it.qty;
        } else {
          groupTallies.set(group.id, {
            groupId: group.id,
            groupName: group.name,
            requiredQty: group.required_qty,
            matchedQty: it.qty,
            matchedProductId: pp.id,
          });
        }
      }
      return { ...it, isPromo, matchedProductId };
    }

    // 2) Иначе — по названию (подстрока match_pattern), как подстраховка для новых магазинов,
    //    коды которых мы ещё не зарегистрировали.
    for (const pp of promoProducts ?? []) {
      const byName =
        it.name && pp.match_pattern
          ? it.name.toLowerCase().includes(pp.match_pattern.toLowerCase())
          : false;
      if (byName) {
        isPromo = true;
        matchedProductId = pp.id;
        const group: any = Array.isArray(pp.promo_groups) ? pp.promo_groups[0] : pp.promo_groups;
        if (group) {
          const existingTally = groupTallies.get(group.id);
          if (existingTally) {
            existingTally.matchedQty += it.qty;
          } else {
            groupTallies.set(group.id, {
              groupId: group.id,
              groupName: group.name,
              requiredQty: group.required_qty,
              matchedQty: it.qty,
              matchedProductId: pp.id,
            });
          }
        }
        break;
      }
    }
    return { ...it, isPromo, matchedProductId };
  });

  // Pick the first group that reached its threshold (usually there's only one active group).
  const eligibleGroup = [...groupTallies.values()].find(
    (g) => g.matchedQty >= g.requiredQty
  );
  const bestGroup = eligibleGroup ?? groupTallies.values().next().value ?? null;
  const bonusEligible = !!eligibleGroup;

  // Persist matched items (только если реально сходили за новым текстом чека —
  // при useCached позиции уже есть в базе и пересохранять их не нужно).
  if (!useCached && annotatedItems.length > 0) {
    await admin.from("receipt_items").insert(
      annotatedItems.map((it) => ({
        receipt_id: receiptId,
        name: it.name,
        ntin: it.ntin,
        qty: it.qty,
        price: it.price,
        sum: it.sum,
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
    bestGroup && bestGroup.requiredQty > 0
      ? Math.floor(bestGroup.matchedQty / bestGroup.requiredQty)
      : 0;

  return NextResponse.json({
    receiptId,
    storeName,
    receiptNumber,
    fiscalSign: params.fiscalSign,
    sum: params.sum ? parseFloat(params.sum) : null,
    fiscalTime: toIso(params.time),
    items: annotatedItems.map((it) => ({
      name: it.name,
      qty: it.qty,
      price: it.price,
      sum: it.sum,
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
