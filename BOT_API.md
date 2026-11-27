# Zumo Bot API

Бота создают в чате с @botfather: /newbot → имя → юзернейм, оканчивающийся на _bot.
BotFather выдаёт токен вида `shop_bot:секрет`. Токен — пароль бота, никому его не передавай.
Новый токен: /token shop_bot (старый перестаёт работать).

Базовый адрес: https://ВАШ_ДОМЕН/bot<токен>/<метод>
Методы принимают JSON-тело или query-параметры.

## Методы
- getMe — данные бота.
- getUpdates {offset, limit, timeout} — входящие сообщения. timeout до 25 сек (long polling).
  offset = update_id последнего обработанного + 1: подтверждает всё, что меньше него.
- sendMessage {chat_id, text, reply_markup} — отправить сообщение. chat_id — юзернейм пользователя,
  который уже писал боту. text — до 2000 символов. reply_markup: {inline_keyboard: [[{text: "..."}]]}
  — кнопки отображаются под сообщением; нажатие отправляет боту текст кнопки как обычное сообщение.

## Ограничения
- Пользователь должен сам написать боту первым.
- Не более 20 сообщений в минуту одному пользователю.
- Очередь апдейтов хранит последние 1000 сообщений на бота.
- Webhook пока не поддерживается, используйте getUpdates.
- Режим бота: builder (ответы из конструктора) или api (ответы только через API). В режиме api
  автоответы конструктора отключены.

## Пример (Python)
    import requests, time
    TOKEN = "shop_bot:секрет"
    URL = f"https://ВАШ_ДОМЕН/bot{TOKEN}"
    offset = 0
    while True:
        r = requests.post(f"{URL}/getUpdates", json={"offset": offset, "timeout": 25}).json()
        for u in r["result"]:
            offset = u["update_id"] + 1
            m = u["message"]
            requests.post(f"{URL}/sendMessage", json={"chat_id": m["chat"]["username"], "text": "Вы написали: " + m["text"]})
