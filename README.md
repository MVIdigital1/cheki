# Cheki — сканер чеков для акции

PWA-приложение для промоутеров: сканирует QR-код фискального чека (ОФД
«Казахтелеком»), проверяет наличие товара акции в количестве 2 шт и позволяет
выдать бонус. Все данные фиксируются в Supabase, статистика — на `/dashboard`.

## Стек

- Next.js 14 (App Router) + Tailwind
- Supabase (Auth + Postgres) — проект `cheki` (ref `gthhzrqvjzfpisafkyzu`)
- `html5-qrcode` — сканирование QR камерой в браузере
- `playwright-core` + `@sparticuz/chromium` — headless-браузер на сервере,
  который открывает страницу `consumer.oofd.kz` с параметрами чека и
  вытаскивает позиции из отрендеренной страницы (у ОФД нет открытого JSON API)

## Первый запуск локально

```bash
npm install
cp .env.local.example .env.local
# впишите SUPABASE_SERVICE_ROLE_KEY (см. ниже)
npm run dev
```

### Где взять SUPABASE_SERVICE_ROLE_KEY

Supabase Dashboard → проект **cheki** → Project Settings → API →
`service_role` secret. Это приватный ключ, обходит RLS — храните только в
переменных окружения сервера (Vercel Environment Variables), никогда не
коммитьте и не используйте в браузере.

### Создание промоутеров

Самостоятельная регистрация отключена. Добавляйте промоутеров через Supabase
Dashboard → Authentication → Users → Add user (email + пароль). Профиль в
таблице `promoters` создастся автоматически (триггер `on_auth_user_created`).

### Товары и группы акции

Товары объединяются в группы (`promo_groups`): бонус выдаётся, если суммарно
по всем товарам группы в чеке набралось `required_qty` штук — в любой
комбинации. Сейчас настроена группа **«Полотенца Пятый элемент»**
(`required_qty = 2`) с двумя товарами:

```
1) Полотенце бумажное "Пятый элемент" 15 м двухслойное 2 рулона
   ntin: 0200135188196
   match_pattern: Полотенце бумажное "Пятый элемент"

2) Полотенце Бумажное Пятый Элемент 2 слоя, 2 рул, 13,2 м, белая,
   с оранжевым тиснением, 12 шт. в уп
   ntin: не известен (заполните, когда появится чек с этим товаром)
   match_pattern: Полотенце Бумажное Пятый Элемент
```

Например: 1 шт первого вида + 1 шт второго — бонус выдаётся; 2 шт одного
вида — тоже выдаётся.

Добавляйте новые товары/группы через SQL Editor в Supabase:

```sql
insert into promo_products (name, ntin, match_pattern, group_id)
values ('...', '...', '...', (select id from promo_groups where name = 'Полотенца Пятый элемент'));
```

## Деплой на Vercel

```bash
npm i -g vercel
vercel login
cd cheki-app
vercel link
vercel env add NEXT_PUBLIC_SUPABASE_URL
vercel env add NEXT_PUBLIC_SUPABASE_ANON_KEY
vercel env add SUPABASE_SERVICE_ROLE_KEY
vercel --prod
```

## Важно: парсинг ОФД ещё не проверен на живом сайте

У сайта `consumer.oofd.kz` нет документированного API — страница рендерится
Angular-приложением. Парсер (`app/api/parse-receipt/route.ts`) написан по
формату печатного чека (тот же набор полей, что печатает касса: `N. Название
... NTIN:xxx ... qty шт x цена`), но regex может потребовать корректировки
под реальную разметку веб-страницы ОФД.

**Перед раскаткой на промоутеров обязательно:**

1. Задеплоить на Vercel.
2. Отсканировать реальный чек через `/scan`.
3. Если позиции не распознались — открыть чек в таблице `receipts` в
   Supabase, посмотреть колонку `raw_ofd_text` (туда сохраняется сырой текст
   страницы ОФД) и поправить регулярку `parseItemsFromText` в
   `app/api/parse-receipt/route.ts` под реальный формат.

## Структура БД

- `promoters` — профили промоутеров (1:1 с `auth.users`)
- `promo_products` — товары акции (название, NTIN, требуемое кол-во)
- `receipts` — отсканированные чеки (уникальность по `fiscal_sign + rnm`,
  защита от повторного скана)
- `receipt_items` — позиции чека
- `bonuses` — выданные бонусы (уникальность по `receipt_id + promo_product_id`)
- `promo_stats` — view с агрегированной статистикой для дашборда
