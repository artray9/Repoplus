# Repoplus — Deployment Checklist

Финальный чеклист перед `git push origin main`. Пройдись по пунктам сверху вниз.

---

## 1. Railway — переменные окружения

Текущие переменные (из твоего скриншота — всё это уже есть, переименовывать не надо):

```
✓ ADMIN_SECRET
✓ AMO_CLIENT_ID
✓ AMO_CLIENT_SECRET
✓ BACKEND_URL              = https://repoplus-production.up.railway.app
✓ DATABASE_URL             (Railway проставил автоматически)
✓ FB_APP_ID
✓ FB_APP_SECRET
✓ FRONTEND_URL             = https://repoplus.kz
✓ GOOGLE_CLIENT_ID
✓ GOOGLE_CLIENT_SECRET
✓ GOOGLE_DEVELOPER_TOKEN   (код умеет читать это имя)
✓ JWT_REFRESH_SECRET
✓ JWT_SECRET
✓ PORT                     = 3001
✓ TT_APP_ID
✓ TT_APP_SECRET
```

**Добавить (опционально, но рекомендуется):**

```
➕ SUPER_ADMIN_EMAIL       = greenlantern1122@gmail.com
   Без этой переменной у тебя не будет суперадмина с глобальным доступом ко всем тенантам.

➕ OPEN_SIGNUP             = true
   По умолчанию true (можно не ставить). Если хочешь модерацию регистраций — поставь false.

➕ TZ                      = Asia/Almaty
   Для логов (cron уже привязан явно к Asia/Almaty в коде).

➕ EXTRA_ORIGINS           = https://your-domain.com,https://staging.repoplus.kz
   Дополнительные домены для CORS. *.github.io, *.up.railway.app, *.vercel.app
   уже разрешены автоматически.

➕ LOW_BALANCE_THRESHOLD   = 100
   Порог в USD, ниже которого приходит TG-алерт "Низкий баланс". По умолчанию 100.

➕ CPL_ALERT_THRESHOLD     = 50
   Порог CPL для TG-алертов "Высокий CPL". По умолчанию 50.
```

**НЕ нужно (не используются больше):**

```
✗ GOOGLE_ADS_MANAGER_ID    — теперь per-client в clients.google_manager_id
✗ GOOGLE_LOGIN_CLIENT_ID   — fallback на GOOGLE_CLIENT_ID
✗ GOOGLE_LOGIN_CLIENT_SECRET — fallback на GOOGLE_CLIENT_SECRET
✗ GOOGLE_ADS_DEVELOPER_TOKEN — fallback на GOOGLE_DEVELOPER_TOKEN
```

---

## 2. Google Cloud Console — настройка OAuth

Зайди в [console.cloud.google.com](https://console.cloud.google.com) → твой проект → **APIs & Services → Credentials** → клик по OAuth 2.0 Client ID.

### 2.1 Authorized redirect URIs

Должно быть ОБА URI:

```
✓ https://repoplus-production.up.railway.app/api/oauth/google/callback   (уже добавлен — для Google Ads подключения)
➕ https://repoplus-production.up.railway.app/api/auth/google/callback   (НОВЫЙ — для Sign in with Google)
```

Заметь — разные пути: `/api/oauth/...` vs `/api/auth/...`.

### 2.2 Authorized JavaScript origins

```
✓ https://repoplus.kz
✓ https://www.repoplus.kz
✓ https://<твой_username>.github.io   (если используешь GH Pages напрямую)
```

### 2.3 OAuth consent screen → Scopes

Должны быть добавлены:

```
✓ openid                             (non-sensitive — мгновенно)
✓ .../auth/userinfo.email            (non-sensitive — мгновенно)
✓ .../auth/userinfo.profile          (non-sensitive — мгновенно)
✓ .../auth/adwords                   (sensitive — для production требует верификации Google)
```

### 2.4 OAuth consent screen → Test users (если в Testing mode)

Добавь свой email и emails тех, кто будет тестировать. В Testing mode Google не пустит юзеров вне этого списка.

Когда захочешь сделать публичным — нажми "PUBLISH APP" (для scope `adwords` придётся пройти верификацию Google, но `email`/`profile` доступны сразу).

---

## 3. Git push

```bash
cd Repoplus
git add .
git commit -m "feat: open signup + Google login + Telegram bot + multi-tenant isolation"
git push origin main
```

Это запустит:
- **GitHub Actions: pages.yml** → деплой статики на GitHub Pages (5-10 сек)
- **GitHub Actions: deploy.yml** → деплой backend на Railway (1-2 минуты)

Проверь логи на Railway: должно быть `[MIGRATE] complete` и `Repoplus API running on 0.0.0.0:3001`.

---

## 4. Smoke test после деплоя

Открой в браузере по очереди:

```
✓ https://repoplus.kz/                                       — лендинг открывается
✓ https://repoplus.kz/register.html                          — есть кнопка "Зарегистрироваться через Google"
✓ https://repoplus-production.up.railway.app/api/health      — {"status":"ok", ...}
```

Зарегистрируйся через email:
```
✓ register.html → ввести email/пароль/имя/компанию → "Создать аккаунт"
✓ должен сразу залогинить и открыть dashboard.html
```

Зарегистрируйся через Google:
```
✓ register.html → "Зарегистрироваться через Google" → Google OAuth → разрешить
✓ редирект на auth-callback.html → автоматически → dashboard.html
```

Добавь первого клиента:
```
✓ В dashboard: страница "Клиенты" → "+ Добавить клиента"
✓ Имя + (опционально) FB Account ID + Google Customer ID + TT Advertiser ID
✓ Если без MCC — Manager (MCC) ID оставь пустым
✓ Сохранить
```

Подключи Google Ads OAuth:
```
✓ Кнопка "🔑 Токен" у клиента → выбрать Google → "🔐 Подключить через OAuth"
✓ Google OAuth → разрешить
✓ Редирект на dashboard.html?oauth_success=google → toast "Google Ads подключён"
```

Запусти ручную синхронизацию:
```
✓ Страница "Балансы" → "🔄 Обновить" → toast "Синхронизация запущена"
✓ Через ~30 сек обнови страницу — должны появиться балансы FB/TT (Google = n/a)
```

---

## 5. Подключение Telegram-бота (опционально, для уведомлений)

### 5.1 Создать бота

В Telegram: написать `@BotFather` → `/newbot` → придумать имя → получить токен.

Токен выглядит как: `1234567890:AAAaaaBbbCccDddEeeFff_GgGgGgGgGg`

### 5.2 Подключить в Repoplus

```
✓ В dashboard: страница "Настройки" → блок "🤖 Telegram-бот" → "Подключить бота"
✓ Вставить токен → "ОК"
✓ Toast "Бот @your_bot подключён"
```

Backend автоматически:
- Проверит токен через Telegram API getMe
- Установит webhook на `${BACKEND_URL}/api/telegram/webhook`
- Сохранит в БД

### 5.3 Добавить чат для уведомлений

Вариант А (автоматически):
```
✓ В Telegram найди своего бота → /start
✓ Бот пришлёт Chat ID и автоматически добавит чат в подписчиков (тип: daily_report)
```

Вариант Б (вручную):
```
✓ В Repoplus: Настройки → блок "📬 Подписчики" → "+ Добавить чат"
✓ Вставить Chat ID + название + выбрать типы уведомлений
```

Для группового чата:
```
✓ Добавь бота в группу
✓ В группе: /start  (или /id)
✓ Бот пришлёт Chat ID группы (обычно отрицательный, например -100123456789)
✓ В Repoplus: "+ Добавить чат" → вставь этот ID
```

### 5.4 Проверить уведомления

```
✓ Настройки → "🔔" (колокольчик) рядом с чатом — тестовое сообщение
✓ Должно прийти в Telegram: "✅ Repoplus — Тестовое сообщение. Бот работает!"
```

### 5.5 Типы уведомлений

В чекбоксах при добавлении подписчика:
- 📊 `daily_report`   — ежедневный отчёт (cron 06:00 Asia/Almaty)
- ⚠️ `budget_alert`   — низкий баланс (< $100 по умолчанию)
- 🚨 `cpl_alert`      — высокий CPL (> $50 по умолчанию)
- 😶 `zero_leads`     — за день не было лидов
- ✅ `sync_done`      — синхронизация завершена

Триггеры:
- `daily_report` — приходит каждое утро в 06:00 Asia/Almaty, если за вчера были расходы или лиды
- `cpl_alert` — рассылается сразу после синхронизации, для каждой кампании где CPL > порога
- `budget_alert` — рассылается при синхронизации балансов, если balance < $100
- Регистрация нового юзера — рассылается всем подписчикам при создании аккаунта (любой тип)

### 5.6 Ручная рассылка

```
✓ Настройки → блок "📢 Ручная рассылка" → вставить текст (поддерживается HTML)
✓ "📤 Отправить" → toast "Отправлено: N, ошибок: M"
```

---

## 6. Что протестировать ещё (опционально)

```
✓ /api/auth/refresh — ротация токенов (когда access истечёт)
✓ Backfill за период (Клиенты → "Историческая выгрузка")
✓ Telegram webhook — отправь команду /start боту, должен прийти ответ с Chat ID
✓ Logout — кнопка ⏏ в sidebar
✓ Multi-tenant: зарегистрируй второй аккаунт под другим email,
   убедись что не видишь клиентов первого аккаунта
```

---

## 7. Откатить, если что-то пошло не так

```bash
git log --oneline  # найти предыдущий коммит
git reset --hard <hash>
git push --force origin main
```

Railway автоматически переразвернётся на старом коммите.

---

## 8. Известные ограничения (не блокеры)

1. **Google Ads баланс через GAQL не отдаётся** — на UI показываем "n/a", это by design Google.
2. **Один Telegram-бот на всю систему** — multi-tenant не поддерживается для бота (один токен в `telegram_settings`). Если нужно несколько ботов на разные тенанты — это отдельная фича.
3. **Auto-refresh JWT** — на фронте сейчас при 401 редирект на login.html. Можно добавить силент refresh через `/api/auth/refresh`, но это UX-улучшение, не баг.
4. **amoCRM unique по email в invitations** — один email можно пригласить только к одному клиенту одновременно.
5. **Google Ads scope `adwords`** — sensitive scope, в Production режиме Google требует верификацию. До верификации работает только для Test users.

---

Готово. Удачи с деплоем 🚀
