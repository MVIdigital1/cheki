import { SupabaseClient } from "@supabase/supabase-js";

export type MatchableItem = {
  name: string;
  code: string | null;
  qty: number;
};

export type AnnotatedItem<T extends MatchableItem> = T & {
  isPromo: boolean;
  matchedProductId: string | null;
};

export type GroupTally = {
  groupId: string;
  groupName: string;
  requiredQty: number;
  matchedQty: number;
  matchedProductId: string;
};

export type MatchResult<T extends MatchableItem> = {
  annotatedItems: AnnotatedItem<T>[];
  bestGroup: GroupTally | null;
  bonusEligible: boolean;
};

// Общая логика сопоставления позиций чека с товарами акции — используется и при
// разборе через ОФД (parse-receipt), и при распознавании по фото (parse-receipt-photo),
// чтобы правила сопоставления (код товара -> название -> подсчёт по группе) не расходились.
export async function matchPromoItems<T extends MatchableItem>(
  admin: SupabaseClient,
  items: T[]
): Promise<MatchResult<T>> {
  const { data: promoProducts } = await admin
    .from("promo_products")
    .select("id, name, ntin, match_pattern, group_id, promo_groups(id, name, required_qty)")
    .eq("is_active", true);

  const { data: productCodes } = await admin
    .from("promo_product_codes")
    .select("code, product_id");
  const codeToProductId = new Map<string, string>();
  for (const c of productCodes ?? []) {
    codeToProductId.set(c.code, c.product_id);
  }
  const promoProductsById = new Map((promoProducts ?? []).map((pp) => [pp.id, pp]));

  const groupTallies = new Map<string, GroupTally>();

  const annotatedItems = items.map((it) => {
    let isPromo = false;
    let matchedProductId: string | null = null;

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

  const eligibleGroup = [...groupTallies.values()].find((g) => g.matchedQty >= g.requiredQty);
  const bestGroup = eligibleGroup ?? groupTallies.values().next().value ?? null;
  const bonusEligible = !!eligibleGroup;

  return { annotatedItems, bestGroup, bonusEligible };
}
