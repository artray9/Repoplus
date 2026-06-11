# Repoplus — Архитектура платформы

## Концепция

Repoplus — SaaS-платформа сквозной аналитики для маркетинговых агентств.
Агентство (администратор) подключает рекламные кабинеты клиентов и видит
единый дашборд по всем источникам: FB Ads, Google Ads, TikTok Ads, amoCRM.

---

## Стек технологий

| Слой        | Технология                          | Почему                                  |
|-------------|-------------------------------------|-----------------------------------------|
| Frontend    | React + Vite + Tailwind CSS         | SPA, быстрая разработка, гибкий UI     |
| Backend     | Node.js + Express                   | Быстро, JS-стек, хорошие OAuth libs    |
| База данных | PostgreSQL (Supabase)               | Реляционная, бесплатный tier, REST API |
| Авторизация | JWT + bcrypt                        | Stateless, мультиклиентность           |
| Хостинг FE  | GitHub Pages / Vercel               | Текущий домен, бесплатно               |
| Хостинг BE  | Railway / Render                    | Бесплатный tier, авто-деплой из GitHub |
| Очередь     | node-cron (потом Bull + Redis)      | Scheduled pulls из API                 |

---

## Структура проекта

```
repoplus/
├── frontend/                    # React SPA
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Landing.jsx      # Лендинг repoplus.kz
│   │   │   ├── Login.jsx        # Авторизация
│   │   │   ├── Dashboard.jsx    # Главный дашборд
│   │   │   ├── Clients.jsx      # Управление клиентами (admin)
│   │   │   ├── ClientView.jsx   # Личный кабинет клиента
│   │   │   └── Settings.jsx     # Настройки интеграций
│   │   ├── components/
│   │   │   ├── KPICard.jsx
│   │   │   ├── SpendChart.jsx
│   │   │   ├── CampaignTable.jsx
│   │   │   ├── FilterBar.jsx
│   │   │   └── SourceTabs.jsx
│   │   ├── api/
│   │   │   └── client.js        # Axios wrapper
│   │   └── store/               # Zustand / Context
│   └── package.json
│
├── backend/                     # Node.js API
│   ├── src/
│   │   ├── routes/
│   │   │   ├── auth.js          # POST /login, /register, /refresh
│   │   │   ├── clients.js       # CRUD клиентов
│   │   │   ├── analytics.js     # GET /analytics?client=&from=&to=&source=
│   │   │   └── integrations.js  # Подключение кабинетов
│   │   ├── services/
│   │   │   ├── facebook.js      # FB Marketing API
│   │   │   ├── google.js        # Google Ads API
│   │   │   ├── tiktok.js        # TikTok Ads API
│   │   │   └── amocrm.js        # amoCRM API
│   │   ├── jobs/
│   │   │   └── sync.js          # Cron: ежедневная выгрузка
│   │   ├── models/              # Sequelize или raw SQL
│   │   │   ├── User.js
│   │   │   ├── Client.js
│   │   │   └── Metric.js
│   │   └── middleware/
│   │       ├── auth.js          # JWT verify
│   │       └── rbac.js          # admin / client roles
│   └── package.json
│
└── docs/
    └── ARCHITECTURE.md          # Этот файл
```

---

## Схема базы данных

```sql
-- Пользователи (admin + клиенты)
CREATE TABLE users (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,         -- bcrypt hash
  role        TEXT NOT NULL,         -- 'admin' | 'client'
  name        TEXT,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- Клиенты агентства
CREATE TABLE clients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id),  -- личный кабинет клиента
  name        TEXT NOT NULL,
  fb_account_id   TEXT,
  google_account_id TEXT,
  tt_account_id   TEXT,
  amo_subdomain   TEXT,
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- Токены интеграций (зашифрованы)
CREATE TABLE integration_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID REFERENCES clients(id),
  source      TEXT NOT NULL,   -- 'facebook' | 'google' | 'tiktok' | 'amocrm'
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  expires_at  TIMESTAMP,
  updated_at  TIMESTAMP DEFAULT NOW()
);

-- Метрики рекламных кампаний (ежедневный снапшот)
CREATE TABLE ad_metrics (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID REFERENCES clients(id),
  source        TEXT NOT NULL,     -- 'facebook' | 'google' | 'tiktok'
  date          DATE NOT NULL,
  campaign_id   TEXT,
  campaign_name TEXT,
  impressions   NUMERIC DEFAULT 0,
  clicks        NUMERIC DEFAULT 0,
  spend         NUMERIC DEFAULT 0,
  leads         NUMERIC DEFAULT 0,
  conversions   NUMERIC DEFAULT 0,
  ctr           NUMERIC DEFAULT 0,
  cpm           NUMERIC DEFAULT 0,
  cpl           NUMERIC DEFAULT 0,
  result_type   TEXT,              -- FB: lead | messaging | contact
  created_at    TIMESTAMP DEFAULT NOW(),
  UNIQUE(client_id, source, date, campaign_id)
);

-- amoCRM лиды
CREATE TABLE crm_leads (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID REFERENCES clients(id),
  amo_lead_id   TEXT,
  date          DATE,
  status        TEXT,
  pipeline      TEXT,
  price         NUMERIC,
  utm_source    TEXT,
  created_at    TIMESTAMP DEFAULT NOW()
);
```

---

## API эндпоинты

```
POST   /api/auth/login              # email + password → JWT
POST   /api/auth/refresh            # refresh token
GET    /api/clients                 # список клиентов (admin only)
POST   /api/clients                 # создать клиента (admin only)
PATCH  /api/clients/:id             # обновить клиента
DELETE /api/clients/:id             # удалить клиента

GET    /api/analytics
         ?client_id=UUID
         &from=2024-01-01
         &to=2024-01-31
         &source=facebook|google|tiktok|all
         &group_by=day|week|campaign
         # → KPI + временные ряды + топ кампаний

POST   /api/integrations/facebook/connect   # OAuth FB
POST   /api/integrations/google/connect     # OAuth Google
POST   /api/integrations/tiktok/connect     # OAuth TikTok
POST   /api/integrations/amocrm/connect     # amoCRM OAuth

POST   /api/sync/manual             # ручная синхронизация (admin)
```

---

## Роли и доступ

| Роль    | Доступ                                                      |
|---------|-------------------------------------------------------------|
| admin   | Все клиенты, все данные, управление пользователями, sync   |
| client  | Только свои данные, только просмотр                        |

---

## Фазы разработки

### Фаза 1 — MVP (2-3 недели)
- [x] Архитектура и планирование
- [ ] Лендинг на GitHub Pages
- [ ] Прототип дашборда (статичные данные)
- [ ] Бэкенд: auth + clients CRUD
- [ ] Ручная загрузка CSV (как замена API)

### Фаза 2 — Интеграции (3-4 недели)
- [ ] FB Marketing API (прямой коннектор)
- [ ] Google Ads API
- [ ] TikTok Ads API
- [ ] Cron-синхронизация ежедневно в 06:00 UTC+5

### Фаза 3 — amoCRM + Сквозная аналитика (2-3 недели)
- [ ] amoCRM OAuth + leads pull
- [ ] Сшивка лидов с рекламными источниками по UTM
- [ ] Воронка: клики → лиды → сделки → выручка

### Фаза 4 — Кабинет клиента (1-2 недели)
- [ ] Регистрация/приглашение клиентов
- [ ] Персональный кабинет с ограниченным доступом
- [ ] White-label настройки

---

## Переменные окружения (.env)

```env
# Backend
DATABASE_URL=postgresql://...
JWT_SECRET=...
JWT_REFRESH_SECRET=...

# Facebook
FB_APP_ID=...
FB_APP_SECRET=...

# Google
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_DEVELOPER_TOKEN=...
GOOGLE_MCC_ID=...

# TikTok
TT_APP_ID=...
TT_APP_SECRET=...

# amoCRM
AMO_CLIENT_ID=...
AMO_CLIENT_SECRET=...
AMO_REDIRECT_URI=...

# Telegram (алерты системы)
TG_BOT_TOKEN=...
TG_ADMIN_CHAT_ID=...
```
