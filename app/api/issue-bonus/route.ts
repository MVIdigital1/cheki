import { NextRequest, NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Не авторизован" }, { status: 401 });
  }

  const { receiptId, groupId, matchedQty, phone } = await req.json();
  if (!receiptId || !groupId) {
    return NextResponse.json({ error: "Не хватает данных" }, { status: 400 });
  }
  const cleanPhone = typeof phone === "string" ? phone.trim() : "";
  if (!cleanPhone) {
    return NextResponse.json(
      { error: "Укажите номер телефона покупателя" },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("bonuses")
    .select("id")
    .eq("receipt_id", receiptId)
    .eq("group_id", groupId)
    .maybeSingle();

  if (existing) {
    return NextResponse.json({ ok: true, alreadyIssued: true });
  }

  const { data: group } = await admin
    .from("promo_groups")
    .select("required_qty")
    .eq("id", groupId)
    .maybeSingle();

  const requiredQty = group?.required_qty ?? 1;
  const bonusUnits = requiredQty > 0 ? Math.max(1, Math.floor((matchedQty ?? 0) / requiredQty)) : 1;

  const { error } = await admin.from("bonuses").insert({
    receipt_id: receiptId,
    group_id: groupId,
    promoter_id: user.id,
    qty_matched: matchedQty ?? 0,
    bonus_units: bonusUnits,
    status: "issued",
  });

  if (error) {
    return NextResponse.json(
      { error: "Не удалось сохранить бонус: " + error.message },
      { status: 500 }
    );
  }

  await admin
    .from("receipts")
    .update({ customer_phone: cleanPhone })
    .eq("id", receiptId);

  return NextResponse.json({ ok: true });
}
