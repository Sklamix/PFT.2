# Support Desk — APK-оболонка

Нативна оболонка (Capacitor) навколо співробітницького PWA `/staff`. APK не зберігає
даних: він відкриває сайт у WebView.

## Змінити адресу сайту

`capacitor.config.ts` → `server.url`, або без правок:

```bash
CAPACITOR_SERVER_URL=https://your-domain.com/staff ./rebuild-apk.sh
```

## Перебудувати APK

Потрібні: Java 17+ (Є), Android SDK у `%LOCALAPPDATA%\Android\Sdk` (встановлено 2026):
platform-tools, platforms;android-35(+36, підтягнув Gradle), build-tools.

```bash
CAPACITOR_SERVER_URL=https://your-domain.com/staff ./rebuild-apk.sh
```

Результат: `dist/SupportDesk-debug.apk`. Debug-підпис достатній для роздачі з рук у руки;
перед публічним поширенням з держаєте release-збірку з власним ключем.

## Встановлення у працівника

1. Надіслати APK (месенджер/файлопомійка).
2. На телефоні: відкрити → дозволити "Встановити з невідомих джерел".
3. Увійти даними, створеними в адмін-панелі (роль SUPPORT).

## Обмеження

- PWA-пуші (web-push) не працюють у Android WebView: у застосунку список
  автоматично оновлюється кожні 30 с. Нативні пуші потребують FCM-канала —
  обговорюємо окремо, якщо потрібні.
- Адреса сайту зашита в APK: зміна домена = перезбірка (одна команда).
