# RepoPlus — Чеклист состояния и дорожная карта

_Обновлено: 11.06.2026. Составлено по факту анализа репозитория._

---

## 0. Где мы сейчас (краткий вывод)

В проекте фактически **две параллельные реализации** одного ETL-комбайна:

1. **Apps Script (`/Repoplus/Apps script/`)** — зрелое, рабочее «коробочное» решение на Google Sheets. ~1570 строк основного модуля + 768 строк аналитики. Это то, что уже продаётся/используется.
2. **Backend на Railway (`/Repoplus/backend/`)** — multi-tenant SaaS на Node/Express + PostgreSQL. Перенос логики Apps Script на сервер **уже идёт и продвинут далеко**, а не только планируется.

То есть «ближайший фокус» из инструкций (перенос на Railway + Workspace Marketplace) частично выполнен: бэкенд поднят, БД мигрирует, OAuth и Telegram есть. Осталась стабилизация, фронтенд и упаковка.

---

## 1. ✅ Что СДЕЛАНО

### Apps Script (коробка) — стабильно
- [x] Выгрузка FB Ads (insights, кампании, парсинг 30+ типов action, лиды/messaging/LPV/IG)
- [x] Выгрузка Google Ads (GAQL v22, CTR/CPM/конверсии)
- [x] Выгрузка TikTok Ads (report/integrated, кампании)
- [x] Биллинг по трём платформам (долг, порог, ASL-лимит, виртуальный баланс, прогноз остатка)
- [x] Telegram-рассылка: отчёты по лидам, биллинг, графики CTR (QuickChart)
- [x] Аналитика: аномалии CPL, стоп рекламы, падение CTR, день/неделя к периоду, топ кампаний
- [x] Контроль срока жизни FB-токена с алертом за 5 дней
- [x] Лист `Settings` как конфиг клиентов, меню, авто-триггеры, онбординг клиента

### Backend / Railway — поднят
- [x] Express-сервер, CORS-вайтлист, health-check, логирование запросов
- [x] Авто-миграция БД при старте (users, clients, integration_tokens, ad_metrics, crm_leads, account_balances, api_keys, client_access, telegram_*, invitations, user_oauth_tokens, wishes)
- [x] Auth: email+пароль (JWT+refresh), «Войти через Google», приглашения viewer-ов
- [x] Multi-tenant изоляция (owner_id, superadmin, viewer через client_access)
- [x] Сервисы FB / Google / TikTok / amoCRM / balances / telegram
- [x] OAuth-подключение кабинетов клиентов (FB/Google/TikTok/amoCRM)
- [x] Cron daily sync 06:00 Asia/Almaty + ручной sync + backfill
- [x] Telegram-бот (подключение токена, webhook, подписчики, рассылка, типы алертов)
- [x] CI/CD: GitHub Actions (Pages для статики + deploy на Railway), Dockerfile, railway.toml

### Frontend (статика)
- [x] Лендинг, login, register, dashboard, invite, privacy, auth-callback (статические HTML)

### Документация
- [x] ARCHITECTURE.md, README.md, DEPLOY.md (подробный чеклист деплоя и smoke-тесты)

---

## 2. ⚠️ СРОЧНО / БЛОКЕРЫ

- [ ] **БЕЗОПАСНОСТЬ: `get_tokens.py` содержит реальные секреты** — `client_secret` и `auth_code` amoCRM в открытом виде. Нужно: удалить из репозитория, **отозвать и перевыпустить** интеграцию amoCRM, добавить файл в `.gitignore`, почистить историю git (`git filter-repo` / BFG). Это критично перед любой продажей кода клиентам.
- [ ] **`amocrm_sync.py` не дописан** — запись в БД помечена как «здесь будет код» (строки 110-115), нет пагинации (limit 50), токен захардкожен-заглушкой. Либо доделать, либо удалить (логика amoCRM уже есть в backend).
- [ ] **Расхождение «коробка ↔ SaaS»** — две кодовые базы дублируют логику. Решить стратегию: что продаём как On-Premise (Apps Script), а что как облако (Railway), и как их синхронизировать.

---

## 3. 🔧 Что НУЖНО СДЕЛАТЬ (backend / SaaS)

- [ ] Шифрование токенов в `integration_tokens` / `user_oauth_tokens` (в схеме «зашифрованы», по факту — открытый текст)
- [ ] Rate limiting и валидация входных данных на роутах (express-rate-limit, zod/joi)
- [ ] Полноценные миграции вместо `CREATE TABLE IF NOT EXISTS` в `index.js` (есть `db/migrate.js` — консолидировать)
- [ ] Тесты (unit на парсинг FB actions, e2e на auth + multi-tenant изоляцию)
- [ ] Обработка истечения и авто-refresh OAuth-токенов (FB long-lived, Google/TikTok refresh)
- [ ] Перенос недостающей аналитики из Apps Script в backend (топ кампаний, графики, неделя-к-неделе)
- [ ] Полноценный React-фронтенд (в ARCHITECTURE описан, по факту — статические HTML)
- [ ] Логи и мониторинг (Sentry / структурные логи вместо console.log)

---

## 4. 🚀 Что НУЖНО для Google Workspace Marketplace (коробка)

- [ ] Опубликовать Apps Script как Editor Add-on (манифест `appsscript.json`, OAuth scopes)
- [ ] OAuth consent screen: верификация Google для sensitive scope `adwords`
- [ ] Privacy Policy + Terms (privacy.html есть — довести до требований Google)
- [ ] Иконки, скриншоты, описание листинга, демо-видео
- [ ] Механизм лицензирования/активации для платных коробочных установок
- [ ] Документация для клиента: установка токенов FB/Google/TikTok на своей стороне

---

## 5. 🔭 Видение проекта (куда движемся)

**Двухпродуктовая модель:**

- **RepoPlus Box (On-Premise)** — Apps Script в Workspace Marketplace. Клиент ставит на свой Google-аккаунт, токены настраивает сам, данные не уходят к вам. Низкий порог входа, разовая/подписочная лицензия. Это «вход» в воронку.

- **RepoPlus Cloud (SaaS)** — Railway-платформа для агентств: единый дашборд по всем клиентам, сквозная аналитика реклама→CRM→выручка, Telegram-алерты, white-label. Подписка per-seat / per-client.

**Технический вектор:**
1. Стабилизировать backend как единый источник истины (шифрование, тесты, миграции, мониторинг).
2. Полноценный React-дашборд вместо статических HTML.
3. Сквозная аналитика: сшивка лидов amoCRM с рекламой по UTM → воронка клики→лиды→сделки→выручка, расчёт ROMI/ROAS.
4. Расширить CRM-коннекторы (Bitrix24, Kommo, AmoCRM) — заявлено «и CRM-системы».
5. AI-слой: авто-инсайты и рекомендации по бюджетам поверх собранных данных.

**Продуктовый вектор:**
- Box как лид-магнит → апселл в Cloud при росте числа клиентов у агентства.
- Биллинг и подписки внутри платформы.
- Маркетплейс интеграций.

---

## 6. Рекомендуемый порядок действий

1. Закрыть утечку секретов (`get_tokens.py`) — **сегодня**.
2. Решить судьбу `amocrm_sync.py` (доделать или удалить).
3. Зафиксировать стратегию Box vs Cloud.
4. Backend: шифрование токенов + тесты multi-tenant изоляции.
5. React-дашборд.
6. Упаковка Apps Script под Workspace Marketplace.
