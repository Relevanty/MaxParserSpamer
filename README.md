# Relevanty Spamer

**Relevanty Spamer** – набор утилит для массовой отправки сообщений и парсинга в Telegram и Discord.

## 📦 Что умеет проект
- **Spammer (Telegram)** – отправка сообщений из «Избранных» (Saved Messages) пользователям Telegram.
- **Spammer (Discord)** – DM‑рассылка участникам выбранного сервера Discord.
- **Parser (Telegram)** – извлечение юзер‑идов из групп/каналов.
- **Parser (Discord)** – сбор `userId:accessHash` из участников Discord‑сервера.
- **Analytics** – сбор и генерация отчётов (CSV + HTML) по разговорам Telegram.
- **Cleanup** – удаление устаревших `userId:accessHash` из списков.
- **Schedule mode** – планирование отправки на пиковые часы (по московскому времени) с случайными интервалами.

## 🛠️ Установка
```bash
# Клонируйте репозиторий (если ещё не сделали)
git clone https://github.com/Relevanty/tgSpamer.git
cd RelevantySpamer

# Установите зависимости (Node.js >= 18)
npm ci
```
> **Важно:** проект использует ESM‑модули, поэтому `package.json` содержит `"type": "module"`.

## ⚙️ Конфигурация
Все параметры задаются в файле `.env` в корне проекта.
```dotenv
API_ID=31140495                     # ID вашего Telegram‑приложения
API_HASH="617b45813c4a3d5dcd090de95dbde4e8"   # Хеш‑ключ Telegram‑приложения
SESSION_STRING="..."               # Сессионная строка Telegram (получить через утилиту tgspamer)
FORCE_SMS=false                     # При `true` использовать SMS‑код вместо QR‑кода
DISCORD_USER_TOKEN="MTQ0..."      # Токен пользователя Discord
DISCORD_GUILD_ID="1451286254519062692"  # ID сервера Discord
SEND_MODE=instant                    # `instant` – мгновенная отправка, `schedule` – планирование
# Доступные переменные, которые можно добавить при необходимости
# ARCHIVE_ONLY=true
```
> **Безопасность:** файл `.env` **не должен** попадать в публичный репозиторий. Добавьте его в `.gitignore`.

## ▶️ Запуск
Для удобства в `tools/start.js` реализован «bootstrap», поэтому основной скрипт запускается так:
```bash
npm start
```
При запуске откроется интерактивное меню (через `input.select`). Выберите нужный пункт стрелками ⬆️⬇️ и нажмите `Enter`.

### Альтернативные сценарии
- **Запуск без меню (для скриптов):**
  - Telegram‑спам: `node src/index.js`
  - Discord‑спам: `node src/discord.js`
  - Парсинг Telegram: `node src/parser.js`
  - Парсинг Discord: `node src/discord-parser.js`
- **Указание режима отправки в командной строке:**
  ```bash
  set SEND_MODE=instant && npm start   # Windows
  SEND_MODE=instant npm start           # *nix
  ```

## 📁 Структура проекта
```
├─ src/                     # Основные модули
│   ├─ console.js          # Точка входа с интерактивным меню
│   ├─ index.js            # Основная логика спама Telegram
│   ├─ discord.js          # Спам Discord
│   ├─ parser.js           # Парсер Telegram‑группы
│   ├─ discord-parser.js   # Парсер Discord‑сервера
│   ├─ analytics-collect.js
│   ├─ analytics-report.js
│   ├─ cleanup-ids.js
│   ├─ config.js           # Конфиги (лог‑моды, rate‑limits, scheduler)
│   ├─ auth.js             # Авторизация Telegram (QR / SMS / QR‑code)
│   └─ …
├─ tools/                  # Вспомогательные скрипты
│   └─ start.js            # Запускает `src/console.js`
├─ .env                    # Переменные окружения (секреты)
├─ package.json            # npm‑скрипты и метаданные
├─ report.csv              # Автоматически формируемый журнал операций
└─ README.md               # Данная инструкция
```

## 🐞 Частые проблемы и их решения
| Проблема | Возможное решение |
|----------|-------------------|
| `SyntaxError: The requested module './index.js' does not provide an export named 'runSpammer'` | Убедитесь, что вы запускаете через `tools/start.js` (он импортирует `src/console.js`). Проверьте, что `package.json` содержит скрипт `"start": "node tools/start.js"`.
| `PEER_FLOOD` в Telegram | Бот автоматически пытается снять ограничение через @SpamBot (если включено `FLOOD_GUARD.CHECK_SPAM_BOT_STATUS`). При неудаче будет сделана пауза `FLOOD_GUARD.BAN_WAIT_MS` (по умолчанию 40 минут). Можно уменьшить количество пользователей в пакете (`RATE_LIMITS.USERS_PER_BATCH`).
| Ошибка авторизации (`SessionString` недействителен) | Перегенерируйте сессию через `tgspamer`‑утилиту или включите `FORCE_SMS=true` для получения кода по SMS.
| Проблемы с Discord‑токеном | Токен должен быть **user‑token**, а не bot‑token. Проверьте, что в `DISCORD_USER_TOKEN` нет лишних пробелов.

## 🤝 Вклад в проект
1. Сделайте форк репозитория.
2. Создайте ветку `feature/your-feature`.
3. Внесите изменения, запустив тесты (`npm test` – если они присутствуют).
4. Откройте Pull Request с подробным описанием.

## 📄 Лицензия
Проект распространяется под лицензией MIT – см. файл `LICENSE` в корне репозитория.

---
*Happy spamming! 🚀*
