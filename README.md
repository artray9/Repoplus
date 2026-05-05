# Repoplus — Analytics Platform

Сквозная аналитика для маркетинговых агентств: FB Ads, Google Ads, TikTok Ads, amoCRM.

---

## Быстрый старт

### 1. Создать GitHub репозиторий

```bash
cd Repoplus
git init
git add .
git commit -m "feat: initial platform setup"
git branch -M main
git remote add origin https://github.com/ВАШ_USERNAME/repoplus.git
git push -u origin main
```

### 2. Включить GitHub Pages

В репозитории → **Settings → Pages**:
- Source: `GitHub Actions`
- Готово! Лендинг появится на `https://ВАШ_USERNAME.github.io/repoplus/`

Чтобы привязать домен **repoplus.kz**:
- Settings → Pages → Custom domain: `repoplus.kz`
- У регистратора домена добавьте DNS записи:
  ```
  A     @    185.199.108.153
  A     @    185.199.109.153
  A     @    185.199.110.153
  A     @    185.199.111.153
  CNAME www  ВАШ_USERNAME.github.io
  ```

---

### 3. Поднять бэкенд на Railway

#### 3.1 Регистрация
Зайдите на [railway.app](https://railway.app) → Sign up with GitHub.

#### 3.2 Создать проект
```
New Project → Deploy from GitHub repo → выбрать repoplus → выбрать папку /backend
```

#### 3.3 Добавить PostgreSQL
В проекте Railway:
```
+ New → Database → Add PostgreSQL
```
Railway автоматически добавит `DATABASE_URL` в переменные окружения.

#### 3.4 Прописать переменные окружения
В Railway → сервис `repoplus-api` → **Variables**:

```
JWT_SECRET           = <придумайте длинную случайную строку>
JWT_REFRESH_SECRET   = <ещё одна случайная строка>
ADMIN_SECRET         = <секрет для создания первого admin>
FRONTEND_URL         = https://repoplus.kz
PORT                 = 3001
```

Остальные (FB, Google, TikTok, amoCRM) — добавляйте по мере подключения интеграций.

#### 3.5 Запустить миграцию БД
В Railway → сервис → **Settings → Deploy → Start Command** временно поставьте:
```
node src/db/migrate.js
```
Нажмите Deploy, дождитесь `✅ Migration complete` в логах.
Затем верните: `node src/index.js`

#### 3.6 Получить Railway Token для GitHub Actions
Railway → **Account Settings → Tokens → New Token**
Скопируйте токен.

В GitHub репозитории → **Settings → Secrets → Actions**:
```
RAILWAY_TOKEN = <токен из Railway>
```

Теперь при каждом `git push` в `main` бэкенд деплоится автоматически.

---

### 4. Создать первого Admin

После того как бэкенд поднят (Railway даст URL вида `repoplus-api.up.railway.app`):

```bash
curl -X POST https://repoplus-api.up.railway.app/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@repoplus.kz",
    "password": "ВАШЕ_СИЛЬНОЕ_ПАРОЛЬ",
    "name": "Dr. Kapanov",
    "role": "admin",
    "adminSecret": "ЗНАЧЕНИЕ_ADMIN_SECRET_ИЗ_ENV"
  }'
```

---

### 5. Подключить URL бэкенда во фронтенде

В `dashboard.html` найдите и замените:
```js
const API_BASE = 'https://repoplus-api.up.railway.app/api';
```
(Эта константа будет добавлена когда перейдём к реальным API-вызовам вместо mock-данных)

---

## Структура репозитория

```
repoplus/
├── index.html          # Лендинг (GitHub Pages)
├── dashboard.html      # Admin дашборд
├── .github/
│   └── workflows/
│       ├── pages.yml   # Автодеплой фронта на GitHub Pages
│       └── deploy.yml  # Автодеплой бэкенда на Railway
├── backend/
│   ├── Dockerfile
│   ├── railway.toml
│   ├── package.json
│   ├── .env.example    # Шаблон переменных (НЕ коммитить .env!)
│   └── src/
│       ├── index.js
│       ├── db/
│       │   ├── index.js
│       │   └── migrate.js
│       ├── routes/
│       │   ├── auth.js
│       │   ├── clients.js
│       │   ├── analytics.js
│       │   └── integrations.js
│       ├── services/
│       │   ├── facebook.js
│       │   ├── amocrm.js
│       │   ├── google.js      # TODO
│       │   └── tiktok.js      # TODO
│       ├── middleware/
│       │   └── auth.js
│       └── jobs/
│           └── sync.js
└── ARCHITECTURE.md
```

---

## Следующие шаги

- [ ] Подключить реальный FB токен (из Script Properties вашего Apps Script)
- [ ] Подключить Google Ads API
- [ ] Подключить TikTok Ads API  
- [ ] Подключить amoCRM OAuth
- [ ] Реализовать страницу `/login` с реальной авторизацией
- [ ] Заменить mock-данные в dashboard.html на реальные API-вызовы

---

## Контакты

hi@repoplus.kz
