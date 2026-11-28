# Промпт для виконавця: скролбар у стилі PFT + скидання забутого пароля з Налаштувань

> Це єдиний документ, за яким ти працюєш. Він самодостатній: не шукай додаткових
> інструкцій, не вигадуй фіч поза ним і не «покращуй» сусідній код.
> Якщо щось у документі суперечить коду — пріоритет такий: **1) цей файл,
> 2) `CLAUDE.md` + `DESIGN.md`, 3) існуючий код**. Суперечність зафіксуй у звіті,
> не вирішуй мовчки.

---

## 0. Контекст

**Продукт:** PFT.2 — prop-trading платформа. Дві правки: глобальний вигляд скролбара
(зараз це системна сіра «крутилка» Windows, яка вибивається з космічної палітри) і
скидання забутого пароля з розділу **Settings → Security** (зараз там вимагають
поточний пароль, а людина його саме й забула).

**Стек:** Next.js 16 (App Router) + React 19 + TypeScript, Tailwind v4,
Prisma + Postgres (Neon), пошта через **Resend**, деплой Vercel.
**У цій сесії нічого не пушиш у `main` і не деплоїш.**

**Файли, з якими працюєш:**

| Файл | Роль |
|---|---|
| `app/globals.css` | токени палітри, `@layer base` (курсор/caret), `@layer utilities` |
| `components/settings/security-panel.tsx` | панель Security: зміна пароля, сесія, 2FA, історія |
| `components/settings/ui.tsx` | примітиви `Panel`, `Field`, `Notice`, `INPUT_CLASS` |
| `components/settings/settings-view.tsx` | вкладки Settings, передає `data.security` у панель |
| `app/api/settings/route.ts` | payload налаштувань (`profile`, `preferences`, `security`, `history`) |
| `app/api/settings/password/route.ts` | зміна пароля: `{currentPassword}` **або** `{code}` + новий пароль |
| `app/api/settings/password/request-step-up/route.ts` | надсилає 6-значний код на власну пошту |
| `app/api/auth/forgot-password/route.ts` | шлях зі сторінки входу: лист із посиланням на `/set-password` |
| `lib/email/resend.ts` | транспорт пошти (Resend), fail-closed у проді |
| `lib/trader/email-codes.ts` | `issueStepUpEmailCode`, TTL 10 хв, ресенд не частіше 60 с |
| `scripts/auth-password-step-up.test.ts` | наявні тести STEP_UP-шляху (`npm run test:auth`) |

**Перед першим рядком коду обов'язково:**

1. Прочитай `AGENTS.md`, `CLAUDE.md`, `DESIGN.md` у корені.
2. Прочитай `node_modules/next/dist/docs/` — у цій версії Next.js є breaking changes
   відносно твоїх тренувальних даних. Не пиши код «по пам'яті».
3. Запусти `npm run dev`, залогінься тестовим трейдером і **відтвори обидва дефекти
   в браузері до того, як щось змінювати**. Правка без відтворення не приймається.

---

## 1. Жорсткі правила (порушення = робота не приймається)

1. **Схема БД не змінюється.** Жодних `prisma/schema.prisma`, `prisma/sql/*.sql`,
   `ALLOWED_SQL_FILES`. Обидві правки — CSS + один компонент + одне additive поле в API.
2. **Жодних нових залежностей.** Ні `simplebar`, ні `overlayscrollbars`, ні
   `nodemailer`, ні Gmail SMTP/OAuth. Пошта вже працює через Resend — див. §3.6.
3. **Не чіпай** білінг, платежі, AI-підтримку, правило-бук, reset акаунта, `middleware.ts`,
   `/api/auth/forgot-password`, `/set-password`, `/login`.
4. **Кольори — тільки з `DESIGN.md`** (ті самі hex, що в `app/globals.css`).
   Не вигадуй нових відтінків і не вводь «напівпрозорий білий».
5. **Жодного `any`, жодного `@ts-ignore`.** `npx tsc --noEmit` мусить бути чистий.
6. `npm run lint` — **0 errors**, кількість попереджень не збільшувати.
7. UI — **англійською**. Коментарі в коді — англійською, коротко, по суті.
8. Один commit на одну правку: `fix(ui): …` і `feat(settings): …`. Діф має читатися;
   не переписуй файл цілком, якщо можна змінити функцію.

---

## 2. Правка 1 — скролбар у стилі сайту

### 2.1 Що зараз (відтворення)

Відкрий `/dashboard/settings` у Chrome на Windows і подивись на правий край вікна:
вузька світло-сіра смуга з квадратними кінцями й трикутними стрілками вгорі/внизу,
на темно-синьому `#070b16` вона читається як чужий елемент. Те саме — у будь-якому
контейнері з `overflow-y-auto`: навігація в сайдбарі, підтримка, модалки, дропдауни.

### 2.2 Корінь

У `app/globals.css` **немає жодного правила для скролбара** — перевірено `grep -n scrollbar`.
`:root { color-scheme: dark }` (рядок 58) лише каже браузеру, що тема темна; на Windows
це віддає **системний** скролбар, а не стилізований. Тому колір, ширина, форма й
стрілки — з ОС, а не з палітри.

Другий шар: контейнерів зі скролом понад двадцять, і два з них резервують місце
через `scrollbar-gutter: stable`:
- `components/admin/support-desk.tsx:532`
- `components/support/trader-support-view.tsx:347`

Тобто ширина скролбара — це вже частина layout, і її не можна міняти «на око».

### 2.3 Має бути

Один глобальний блок у `app/globals.css`, у `@layer base`, **одразу після блоку
курсора/caret (він закінчується на рядку 133), перед `@layer utilities`**.

Специфікація (дотримуйся значень, не підбирай свої):

```css
/* Scrollbars: the OS default is a light slab with arrow buttons on Windows and
   breaks the instrument look. Width is fixed so `scrollbar-gutter` reservations
   stay aligned with the painted track. */
@layer base {
  :root {
    --scrollbar-size: 10px;
  }

  ::-webkit-scrollbar {
    width: var(--scrollbar-size);
    height: var(--scrollbar-size);
  }
  ::-webkit-scrollbar-track {
    background: transparent;
  }
  ::-webkit-scrollbar-thumb {
    background-color: #223052; /* deep-grid */
    background-clip: content-box;
    border: 2px solid transparent;
    border-radius: 5px;
  }
  ::-webkit-scrollbar-thumb:hover {
    background-color: #4388ff; /* signal-blue */
  }
  ::-webkit-scrollbar-thumb:active {
    background-color: #2a3a5e;
  }
  ::-webkit-scrollbar-corner {
    background: transparent;
  }
}

/* Firefox has no pseudo-elements: thin + token colours, no radius, no hover. */
@supports not selector(::-webkit-scrollbar) {
  @layer base {
    * {
      scrollbar-width: thin;
      scrollbar-color: #223052 transparent;
    }
  }
}
```

Чому саме так — три пастки, на яких легко зробити гірше:

1. **`scrollbar-color` і `::-webkit-scrollbar` не співіснують.** Щойно в Chrome
   з'являється `scrollbar-color` зі значенням, відмінним від `auto`, він перемикається
   на стандартний рендер і **ігнорує** `::-webkit-scrollbar` — разом із радіусом,
   відступами й `:hover`. Тому стандартні властивості живуть **тільки** всередині
   `@supports not selector(::-webkit-scrollbar)`.
2. **`border: 2px solid transparent` + `background-clip: content-box`** дають 6-піксельний
   повзунок у 10-піксельній доріжці — саме та «тонка смуга», а не стовп.
3. **`color-scheme: dark` на `:root` не прибирати.** Він тримає темними нативні
   контроли й дефолтний скролбар там, де стилізація ігнорується (наприклад, overlay-
   скролбари на macOS).

Додатково:
- `scrollbar-gutter: stable` у двох файлах вище **не чіпай**, але перевір: після правки
  зарезервоване місце має дорівнювати 10px, а не 17px, як у системного. Якщо у цих
  двох в'юхах контент почав «стрибати» при появі скролу — вирівняй резерв явно
  (`scrollbar-gutter: stable` + той самий `--scrollbar-size`), але не прибирай резерв.
- Ніяких `transition` на псевдоелементах скролбара: у Chrome вони не анімуються,
  а в Safari дають артефакти.

### 2.4 Де змінювати

- `app/globals.css` — єдине місце. Якщо довелося торкнутись `support-desk.tsx` або
  `trader-support-view.tsx` — тільки через резерв місця, і це треба пояснити у звіті.

### 2.5 Критерії приймання

1. На `/dashboard/settings` правий скролбар — 10px, темно-синій повзунок `#223052`,
   трек прозорий, **без трикутних стрілок** і без світло-сірого.
2. При наведенні повзунок стає `#4388ff`; при перетягуванні — `#2a3a5e`.
   Layout при наведенні не зсувається ні на піксель.
3. Той самий вигляд у Firefox: тонкий, повзунок `#223052`, трек прозорий
   (радіуса й hover там немає — це очікувано, зафіксуй у звіті).
4. Внутрішні скроли збігаються зі сторінковим: навігація сайдбара, `/dashboard/support`,
   `/staff` (support desk), дропдаун вибору таймзони, модалка історії торгів.
5. Термінал: скрол у таблиці позицій, у менеджері сповіщень і в тікеті — той самий
   вигляд. Чарт (lightweight-charts) не змінився: у нього власна шкала, скролбара немає.
6. У двох в'юхах зі `scrollbar-gutter: stable` контент не зсувається, коли список
   стає довшим за екран.
7. Ніде не додано `overflow: hidden`, щоб «сховати» скролбар.
8. Скріншоти: до/після на `/dashboard/settings` при 100% зуму + кроп смуги у 4×.

### 2.6 Чого не робити

- Не стилізуй скролбар окремо для кожного компонента — правило одне, глобальне.
- Не роби повзунок синім за замовчуванням: `signal-blue` — це «активний» акцент
  (`The One Light Rule` у `DESIGN.md`), тому він лише на hover/active.
- Не додавай світлу тему й не перевіряй `prefers-color-scheme: light` — її не існує,
  `color-scheme: dark` стоїть на `:root` навмисно.

---

## 3. Правка 2 — скинути забутий пароль із Settings → Security

### 3.1 Що зараз (відтворення)

`/dashboard/settings` → вкладка **Security** → панель **Password**: три поля
(`Current password`, `New password`, `Confirm new password`) і кнопка `Update password`.
Якщо поточний пароль забутий — зробити нічого не можна: форма вимагає його знати.
У користувача він записаний як «сміття», і саме це він хоче виправити.

### 3.2 Корінь — фіча вже написана, але недосяжна

Це не «треба зробити з нуля». Бекенд повністю готовий і покритий тестами; зламаний
лише вхід у нього.

`components/settings/security-panel.tsx`:

- рядок 56: `const [codeMode, setCodeMode] = useState(false)`
- рядок 70: `const emailProof = !hasPassword || codeMode`
- рядки 149–206: якщо `emailProof` — рендериться блок «Forgot your current password?»
  з кнопкою `Email a verification code`; інакше — поле `Current password`
- рядок 78: `requestStepUpCode()` уже викликає `POST /api/settings/password/request-step-up`

**Але `setCodeMode(true)` не викликається ніде.** Єдиний виклик сеттера — рядок 115
(скидання після успіху) і рядок 183 (кнопка «Use current password instead», теж `false`).
Отже для акаунта **з** паролем `emailProof` завжди `false`, блок «Forgot…» ніколи не
рендериться, а `requestStepUpCode()` — мертвий код з погляду UI. Це видно в браузері:
на скріншоті користувача між `Very weak` і `Show passwords` порожньо.

Що вже працює і **переписувати не треба**:

- `POST /api/settings/password` (`app/api/settings/password/route.ts:55-70`) приймає
  `{ code, newPassword, confirmPassword }` без поточного пароля: код одноразовий,
  5 спроб, TTL 10 хв, у транзакції; після успіху ротує `tokenVersion` (інші пристрої
  вилітають), цьому пристрою видає свіжий cookie.
- `POST /api/settings/password/request-step-up` шле код на власну адресу сесії,
  ліміти 5/15 хв на користувача і 30/15 хв на IP, ресенд не частіше **60 с**
  (`EMAIL_CODE_RESEND_INTERVAL_MS`), віддає `429` + `Retry-After` або `503`,
  якщо пошта не налаштована.
- Окремий шлях зі сторінки входу (`/login` → «Forgot your password?» →
  `/api/auth/forgot-password` → лист із посиланням → `/set-password`) — **не чіпати**.

### 3.3 Має бути

Один явний вхід у вже наявний кодовий шлях, зрозумілий без документації.

**Стан форми** (заміни `codeMode: boolean` на явний `proof: 'password' | 'email'`,
щоб не було третього неявного стану):

- `hasPassword === false` → `proof` завжди `'email'` (як зараз), лінка «Forgot…» немає.
- `hasPassword === true` → `proof` стартує з `'password'`.

**Перехід у кодовий режим.** Під полем `Current password` — помітний, але не кричущий
контрол-лінка:

> `Forgot your current password?`

Клік робить **дві дії одразу**: перемикає `proof` у `'email'` і викликає
`requestStepUpCode()` — щоб людині не треба було ще шукати другу кнопку. Поле
`Current password` при цьому зникає, замість нього — поле коду.

**Стан «код надіслано»:**

- Плашка: `We sent a 6-digit code to a•••@gmail.com. It expires in 10 minutes.`
  Адреса маскується: перший символ + `•••@` + домен (домен видно навмисно — людина
  перевіряє, що це її Gmail).
- Поле `Verification code`: `inputMode="numeric"`, `autoComplete="one-time-code"`,
  `maxLength={6}`, вставка `123 456` має стати `123456` (фільтр уже є, не ламай).
- Кнопка ресенду: `Send a new code`, після кліку — `Send a new code in 42s`,
  неактивна, поки не мине 60 с. Відлік — з `Retry-After`, якщо прийшов `429`.
- Лінка назад: `Use current password instead` — повертає `proof: 'password'`,
  чистить код і `codeSent`, **не стирає** вже набраний новий пароль.

**Помилки — з дією, а не «щось пішло не так»:**

| Відповідь | Що показати |
|---|---|
| `400` «This code is incorrect or has expired.» | текст із сервера, форма лишається заповненою |
| `429` + `Retry-After` | `Too many requests. Try again in {n}s.` + ресенд заблокований на цей час |
| `503` (пошта не налаштована) | `We can't send email right now.` + лінка `Reset it from the sign-in page` на `/login` |
| `401` на `currentPassword` | наявний текст сервера, плюс підказка `Forgot it? Use an emailed code.` |

**Після успіху:** повідомлення з сервера (`Password updated. Other devices have been
signed out.`), поля очищені, `onReload()` + `router.refresh()` — щоб `Password last
changed` у картці «Active session» оновився без перезавантаження сторінки.

**Доступність і дрібниці:**

- `Notice` з `components/settings/ui.tsx` уже має `role="alert"`/`role="status"` — не
  дублюй власні `aria-live`.
- Розділи `busy` на два: `sendingCode` і `submitting`. Зараз один `busy` блокує всю
  форму, поки йде лист (до 8 с таймауту) — це виглядає як зависання.
- Кнопки з іконкою `Loader2` у стані очікування; `disabled` на час запиту.
- Код ніколи не логується і не показується в UI.

**Дані для маски.** У `app/api/settings/route.ts` в об'єкт `security` додай
`email: user.email` (additive, без зміни схеми), у тип `SecuritySummary` —
`email: string`. Нічого іншого в payload не чіпай.

### 3.4 Де змінювати

- `components/settings/security-panel.tsx` — основна робота.
- `app/api/settings/route.ts` — одне поле `email` у `security`.
- `app/api/settings/password/request-step-up/route.ts` і
  `app/api/settings/password/route.ts` — **не змінюй**. Якщо знайшов там баг —
  опиши його у звіті, але не прав без окремої вказівки.

### 3.5 Критерії приймання

1. Акаунт **з** паролем: у панелі Security видно `Forgot your current password?`.
   Сьогодні цього контролу немає — це головний критерій.
2. Один клік по ньому → лист із 6-значним кодом пішов, поле `Current password` зникло,
   з'явилось поле коду і маскована адреса.
3. Невірний код → `This code is incorrect or has expired.`, форма не очищується,
   лічильник спроб на сервері зменшується (після 5 — відмова).
4. Правильний код + новий пароль ≥8 + збіг → успіх, поля чисті, `Password last changed`
   оновився без reload, цей пристрій лишився залогіненим.
5. Інші пристрої після успіху розлогінені (`tokenVersion` ротований) — перевір у
   двох браузерах або в звичайному + інкогніто.
6. `Use current password instead` повертає форму до пароля, набраний новий пароль
   не зникає.
7. Ресенд заблокований 60 с із видимим відліком; `429` з `Retry-After` показує
   залишок часу, а не глухий текст.
8. `503` показує робочу лінку на `/login`, а не мертву форму.
9. Акаунт **без** пароля: лінки «Forgot…» немає, наявний блок і потік працюють як раніше.
10. Клавіатура: лінка досяжна Tab, Enter відправляє, код приймає вставку з пробілом.
11. `npm run test:auth` — зелена (там `auth-password-step-up.test.ts`), `test:auth-routes`
    — зелена.

### 3.6 Чого не робити

- **Не додавай Gmail SMTP.** Користувач каже «через Gmail», але це означає «на мою
  пошту»: транспорт — Resend (`lib/email/resend.ts`), у проді вже налаштовані
  `RESEND_API_KEY` і `RESEND_FROM_EMAIL`. Новий транспорт = дублювання й ризик
  fail-open у проді.
- Не створюй нову таблицю токенів і не додавай колонок — `emailLoginCode` уже є,
  код зберігається як HMAC, а не відкритим текстом.
- Не роби другу кнопку «надіслати лист із посиланням» у налаштуваннях: цей шлях
  (`/api/auth/forgot-password` → `/set-password`) існує для сторінки входу і видає
  нову сесію, що для залогіненої людини гірше, ніж код. У Settings — тільки код.
- Не показуй код у UI, не логуй його, не додавай «показати код».
- Не змінюй тексти існуючих повідомлень сервера — клієнт показує те, що прийшло.

---

## 4. Перевірки перед здачею

```bash
npx tsc --noEmit
npm run lint
npm run build
npm run test:auth
npm run test:auth-routes
npm run test:security
```

Очікування: `tsc` чисто; `lint` — 0 errors (попереджень не більше, ніж було до тебе);
`build` зелений; усі чотири сюїти зелені.

Якщо `npm run build` падає з `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]` на
`.next/trace-build` — це пісочниця, а не твій код: перейменуй `.next` у тимчасову
теку, збери, потім прибери.

---

## 5. Звіт (обов'язковий)

Пиши українською, коротко, без «все готово» без доказів.

1. **Коміти** — хеш + одне речення, що саме змінилось.
2. **Скріншоти** — скролбар до/після (сторінка + кроп 4×), і чотири стани панелі
   Security: режим пароля, кодовий режим до надсилання, після надсилання, успіх.
3. **Матриця станів пароля** — що бачив і що натискав, по пунктах 3.5.
4. **Що не вдалося перевірити і чому** — окремим списком. «Не перевіряв» — це
   нормальна відповідь; вигадане «перевірено» — ні.
5. **Знайдене по дорозі** — баги поза скоупом, які помітив, але не правив.
6. **Чи змінював файли поза списком §2.4 / §3.4** — якщо так, поясни навіщо.
