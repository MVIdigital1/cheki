import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 60;

type QrParams = {
  fiscalSign: string; // i
  rnm: string; // f
  sum: string; // s
  time: string; // t, format 20260812T102557
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
    return { fiscalSign: i, rnm: f, sum: s ?? "", time: t ?? "" };
  } catch {
    return null;
  }
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

type ParsedLine = { name: string; ntin: string | null; qty: number; price: number | null; sum: number | null };

function parseItemsFromText(text: string): ParsedLine[] {
  const items: ParsedLine[] = [];

  // Strategy 1: fiscal-document style blocks, e.g.
  // "1. Полотенце бумажное ... NTIN:0200135188196 1 дана/шт x 550,00 Стоимость 550,00"
  const blockRe =
    /(\d+)\.\s+([\s\S]{3,300}?)(?:NTIN[:\s]*([0-9]{6,20}))?\s*(\d+(?:[.,]\d+)?)\s*(?:дана\/шт|шт|дана)\s*[x×]\s*([\d\s]+[.,]\d{2})/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const name = m[2].replace(/\s+/g, " ").trim();
    const ntin = m[3] ?? null;
    const qty = parseFloat(m[4].replace(",", "."));
    const price = parseFloat(m[5].replace(/\s/g, "").replace(",", "."));
    items.push({ name, ntin, qty, price, sum: null });
  }

  return items;
}

async function fetchOfdText(params: QrParams): Promise<string> {
  const { chromium: playwright } = await import("playwright-core");

  const browserlessToken = process.env.BROWSERLESS_TOKEN;
  if (!browserlessToken) {
    throw new Error("BROWSERLESS_TOKEN не задан в переменных окружения");
  }

  const browser = await playwright.connectOverCDP(
    `wss://chrome.browserless.io?token=${browserlessToken}`
  );

  try {
    const page = await browser.newPage();
    const url = `https://consumer.oofd.kz/ru?i=${encodeURIComponent(
      params.fiscalSign
    )}&f=${encodeURIComponent(params.rnm)}&s=${encodeURIComponent(
      params.sum
    )}&t=${encodeURIComponent(params.time)}`;

    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    // Angular SPA render — give it a moment beyond networkidle.
    await page.waitForTimeout(2500);

    const text = await page.evaluate(() => document.body.innerText);
    return text;
  } finally {
    await browser.close();
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
  const qrRaw: string = body.qrRaw;
  if (!qrRaw) {
    return NextResponse.json({ error: "Пустой QR" }, { status: 400 });
  }

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
    .select("id, store_name, sum, fiscal_time, customer_phone")
    .eq("fiscal_sign", params.fiscalSign)
    .eq("rnm", params.rnm)
    .maybeSingle();

  let receiptId: string;
  let items: ParsedLine[] = [];
  let storeName: string | null = null;
  let rawText = "";

  if (existing) {
    receiptId = existing.id;
    storeName = existing.store_name;
    const { data: existingItems } = await admin
      .from("receipt_items")
      .select("name, ntin, qty, price, sum, promo_product_id")
      .eq("receipt_id", receiptId);
    items = (existingItems ?? []).map((it) => ({
      name: it.name,
      ntin: it.ntin,
      qty: Number(it.qty),
      price: it.price ? Number(it.price) : null,
      sum: it.sum ? Number(it.sum) : null,
    }));
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

    const storeMatch = rawText.match(/^(ТОО|ИП|АО)[^\n]{0,120}/m);
    storeName = storeMatch ? storeMatch[0].trim() : null;

    const { data: inserted, error: insertErr } = await admin
      .from("receipts")
      .insert({
        promoter_id: user.id,
        fiscal_sign: params.fiscalSign,
        rnm: params.rnm,
        sum: params.sum ? parseFloat(params.sum) : null,
        fiscal_time: toIso(params.time),
        qr_raw: qrRaw,
        store_name: storeName,
        status: items.length > 0 ? "parsed" : "error",
        parse_error: items.length === 0 ? "Позиции не найдены в тексте ОФД" : null,
        raw_ofd_text: rawText.slice(0, 20000),
      })
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

  // Load active promo products (with their group) to match against.
  // Products in the same group count together — any combination of them
  // reaching the group's required_qty makes the receipt bonus-eligible.
  const { data: promoProducts } = await admin
    .from("promo_products")
    .select("id, name, ntin, match_pattern, group_id, promo_groups(id, name, required_qty)")
    .eq("is_active", true);

  type GroupTally = { groupId: string; groupName: string; requiredQty: number; matchedQty: number; matchedProductId: string };
  const groupTallies = new Map<string, GroupTally>();

  const annotatedItems = items.map((it) => {
    let isPromo = false;
    let matchedProductId: string | null = null;

    for (const pp of promoProducts ?? []) {
      const byNtin = pp.ntin && it.ntin && pp.ntin === it.ntin;
      const byName =
        it.name && pp.match_pattern
          ? it.name.toLowerCase().includes(pp.match_pattern.toLowerCase())
          : false;
      if (byNtin || byName) {
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

  // Persist matched items (only if newly parsed, i.e. table was empty for this receipt).
  if (!existing && annotatedItems.length > 0) {
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
    alreadyScanned: !!existing,
  });
}
