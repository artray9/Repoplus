# Repoplus — Analytics Platform

Сквозная аналитика для маркетинговых агентств: FB Ads, Google Ads, TikTok Ads, amoCRM.
Multi-tenant SaaS: любой человек может зарегистрироваться, создать свой аккаунт-агентство и подключить рекламные кабинеты клиентов.

---

## Авторизация (для пользователей)

После последнего деплоя зайти и пользоваться может **кто угодно**. Доступны:

- **Регистрация через email + пароль** — открытая, без модерации (ENV `OPEN_SIGNUP=true` по умолчанию).
- **Войти через Google** — кнопка на `/login.html` и `/register.html`. Аккаунт создаётся автоматически по email из Google профиля.
- **Приглашение клиента** (старый flow) — админ генерирует ссылку, клиент создаёт пароль и попадает в свой viewer-кабинет.

Каждый зарегистрированный пользователь:
- получает роль **admin** (изолированный тенант),
- видит ТОЛЬКО своих клиентов (фильтр по `clients.owner_id`),
- может добавлять/удалять собственных клиентов, подключать к ним FB/Google/TT/amoCRM,
- может приглашать viewer-ов к КОНКРЕТНЫМ клиентам.

**superadmin** (whitelist в `SUPER_ADMIN_EMAIL`) видит данные всех тенантов.

---

## Быстрый старт

### 1. GitHub репозиторий
```bash
cd Repoplus
git init && git add . && git commit -m "feat: production-ready"
git branch -M main
git remote add origin https://github.com/<USERNAME>/repoplus.git
git push -u origin main
```

### 2. GitHub Pages
В репозитории: **Settings → Pages → Source: GitHub Actions**. Лендинг появится на `https://<USERNAME>.github.io/repoplus/`.

Для домена `repoplus.kz`: **Settings → Pages → Custom domain**, DNS:
```
A     @    185.199.108.153
A     @    185.199.109.153
A     @    185.199.110.153
A     @    185.199.111.153
CNAME www  <USERNAME>.github.io
```

### 3. Backend на Railway

Создайте проект → Deploy from GitHub repo → выберите папку `/backend`. Добавьте PostgreSQL.

#### Переменные окружения

```
# Обязательные
DATABASE_URL          = (Railway проставит сам)
JWT_SECRET            = <длинная случайная строка>
JWT_REFRESH_SECRET    = <другая длинная случайная строка>
FRONTEND_URL          = https://repoplus.kz
BACKEND_URL           = https://repoplus-production.up.railway.app
PORT                  = 3001

# Открытая регистрация (по умолчанию true)
OPEN_SIGNUP           = true

# Супер-админ (один или несколько email через запятую)
SUPER_ADMIN_EMAIL     = your@email.com

# CORS — доп. домены через запятую (опционально)
EXTRA_ORIGINS         = https://staging.repoplus.kz

# Google Login (Sign in with Google) — см. секцию ниже
GOOGLE_LOGIN_CLIENT_ID     = <Client ID из Google Cloud Console>
GOOGLE_LOGIN_CLIENT_SECRET = <Client Secret>

# Google Ads API (для подключения кабинетов клиентов)
GOOGLE_CLIENT_ID           = <можно тот же>
GOOGLE_CLIENT_SECRET       = <можно тот же>
GOOGLE_ADS_DEVELOPER_TOKEN = <developer token>
GOOGLE_ADS_MANAGER_ID      = <MCC ID без дефисов>

# Facebook Ads
FB_APP_ID             = <FB App ID>
FB_APP_SECRET         = <FB App Secret>

# TikTok Ads
TT_APP_ID             = <TT App ID>
TT_APP_SECRET         = <TT App Secret>

# amoCRM
AMO_CLIENT_ID         = <amoCRM Integration ID>
AMO_CLIENT_SECRET     = <amoCRM Secret>

# Cron timezone (для логов)
TZ                    = Asia/Almaty
```

База мигрирует автоматически при старте (см. `autoMigrate` в `index.js`). Cron sync настроен на **06:00 Asia/Almaty** ежедневно.

---

## Настройка «Войти через Google»

1. Зайдите в [Google Cloud Console](https://console.cloud.google.com/) → создайте проект.
2. **APIs & Services → Credentials → Create Credentials → OAuth Client ID**:
   - Application type: `Web application`
   - Authorized JavaScript origins: `https://repoplus.kz`, `https://<USERNAME>.github.io`
   - Authorized redirect URIs: `https://repoplus-production.up.railway.app/api/auth/google/callback`
3. Скопируйте `Client ID` и `Client Secret` → положите в Railway как `GOOGLE_LOGIN_CLIENT_ID` и `GOOGLE_LOGIN_CLIENT_SECRET`.
4. В **OAuth consent screen** добавьте scope `email`, `profile`, `openid`.
5. Если пока в Testing — добавьте Test users.
6. Для подключения Google Ads API (выгрузка кабинетов клиентов) можно использовать тот же ID или отдельный — переменные `GOOGLE_CLIENT_ID`/`SECRET`.

После этого кнопка «Войти через Google» на `/login.html` начнёт работать.

---

## Структура

```
repoplus/
├── index.html              # Лендинг
├── login.html              # Вход (email + Google)
├── register.html           # Регистрация (email + Google)
├── auth-callback.html      # Callback страница после Google OAuth
├── dashboard.html          # Главный SPA
├── invite.html             # Приглашение клиента
├── privacy.html            # Политика
├── backend/
│   └── src/
│       ├── index.js
│       ├── db/{index,migrate}.js
│       ├── routes/{auth,clients,analytics,integrations,settings,users,telegram,oauth}.js
│       ├── services/{facebook,google,tiktok,amocrm,telegram,balances}.js
│       ├── middleware/auth.js
│       └── jobs/sync.js
└── ARCHITECTURE.md
```

---

## Эндпоинты

```
POST   /api/auth/login                     email + password → JWT
POST   /api/auth/register                  открытая регистрация
POST   /api/auth/refresh                   ротация обоих токенов
GET    /api/auth/google/init               редирект в Google OAuth
GET    /api/auth/google/callback           callback от Google

POST   /api/auth/invite                    создать приглашение клиента
GET    /api/auth/invite/:token             проверка ссылки
POST   /api/auth/invite/:token/accept      акцепт + установка пароля

GET    /api/clients                        список своих клиентов
POST   /api/clients                        создать (owner_id = я)
PATCH  /api/clients/:id                    редактировать (только своего)
DELETE /api/clients/:id                    удалить (только своего)

GET    /api/analytics?from&to&source&client_id
GET    /api/analytics/balances

POST   /api/integrations/token             вручную сохранить токен
POST   /api/integrations/sync/manual       синк МОИХ клиентов
POST   /api/integrations/sync/backfill     backfill за период (только мои)

GET    /api/oauth/{facebook|google|tiktok|amocrm}/init?client_id=...&token=JWT
GET    /api/oauth/{...}/callback           подключение кабинета клиента

GET    /api/settings/api-keys              мои сохранённые API-ключи
POST   /api/settings/api-keys              сохранить новый ключ
POST   /api/settings/apply-key             применить ключ к моему клиенту
DELETE /api/settings/api-keys/:id          удалить мой ключ

GET    /api/users                          только viewer-ы моих клиентов
POST   /api/users                          создать viewer
PATCH  /api/users/:id
DELETE /api/users/:id

GET    /api/telegram/settings              настройки бота (admin only)
POST   /api/telegram/settings              сохранить bot_token
GET    /api/telegram/subscribers
POST   /api/telegram/subscribers
PATCH  /api/telegram/subscribers/:id
POST   /api/telegram/broadcast
POST   /api/telegram/test
POST   /api/telegram/webhook               публичный — Telegram сюда POST-ит

POST   /api/wishes                         публичная форма "Предложить функцию"
GET    /api/health                         healthcheck
```

---

## Multi-tenant изоляция

| Роль        | Что видит                                                  |
|-------------|------------------------------------------------------------|
| superadmin  | Всё. Email из `SUPER_ADMIN_EMAIL` env.                     |
| admin       | Только клиентов где `owner_id = userId`, и своих viewers.  |
| viewer      | Только клиентов из `client_access`.                        |

Фильтры применяются на каждом запросе. См. `routes/clients.js#ownsClient` и проверки в `analytics.js`, `integrations.js`, `settings.js`.

---

## Telegram бот (опционально)

- Создайте бота через `@BotFather` → `/newbot` → получите токен.
- В дашборде: **Настройки → Подключить бота** → вставьте токен.
- Webhook регистрируется автоматически на `${BACKEND_URL}/api/telegram/webhook`.
- В Telegram-чате (личный или группа) напишите `/start` боту — он пришлёт Chat ID.
- Добавьте этот Chat ID в подписчики на странице Настройки.

Типы уведомлений:
- 📊 Ежедневный отчёт (cron в 06:00 Asia/Almaty)
- ⚠️ Низкий баланс
- 🚨 Высокий CPL
- 🆕 Новая регистрация (в чате суперадмина)

---

## Контакты

hi@repoplus.kz
