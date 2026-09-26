import type { Lang } from "./types";

/**
 * Запись словаря оболочки.
 *
 * Английский необязателен — на время перевода, и только он. Словарь в две
 * с половиной тысячи строк переводят отдельно и не за один день, а
 * английский как язык оболочки нужен уже сейчас (решение заказчика
 * 2026-09-26). Непереведённая запись показывает украинский — см. makeUiT;
 * сколько их осталось, считает проверка в uiStrings.test.ts. Когда счёт
 * дойдёт до нуля, `en?` станет `en`, и проверка станет строгой: пропущенный
 * перевод будет ловить компилятор, а не глаз.
 *
 * Украинский и русский обязательны, как и были: тип записан явно, и словарь
 * проверяется им через `satisfies` — запись без русского не соберётся.
 */
export interface UiEntry {
  uk: string;
  ru: string;
  /*
   * Обязательно с тех пор, как словарь переведён целиком (волна 9): новая
   * запись без английского теперь не компилируется, а не всплывает
   * украинским словом посреди английского экрана.
   */
  en: string;
}

/**
 * Записи, у которых английский пуст НАМЕРЕННО: суффикс года рождения
 * («1986р.») в английском не пишется — «female · 1986» читается само, а
 * «1986-born» и «1986 b.» — нет.
 */
export const EMPTY_BY_DESIGN_EN: ReadonlySet<string> = new Set(["pg.yearSuffix", "ppl.yearShort"]);

/**
 * Словарь оболочки.
 *
 * Контент методик двуязычен давно (jsonb {uk, ru} + t()), а интерфейсные
 * строки были прошиты по-русски. Здесь — общий словарь для веба и мобилки:
 * ключ → переводы. Ключи группируются точкой, значения — готовые фразы,
 * без интерполяционного движка: где нужна подстановка, в строке стоит
 * «{имя}», и её заменяет вызывающий.
 */
export const UI = {
  /* общие */
  "common.loading": { uk: "Завантаження…", ru: "Загрузка…", en: "Loading…" },
  "common.error": { uk: "Сталася помилка", ru: "Произошла ошибка", en: "An error occurred" },
  "common.retry": { uk: "Повторити", ru: "Повторить", en: "Retry" },
  "common.cancel": { uk: "Скасувати", ru: "Отмена", en: "Cancel" },
  "bio.prompt": { uk: "Підтвердіть особу", ru: "Подтвердите личность", en: "Confirm your identity" },
  "common.close": { uk: "Закрити", ru: "Закрыть", en: "Close" },
  "common.next": { uk: "Далі", ru: "Дальше", en: "Next" },
  "common.back": { uk: "Назад", ru: "Назад", en: "Back" },
  "common.finish": { uk: "Завершити", ru: "Завершить", en: "Finish" },
  "common.save": { uk: "Зберегти", ru: "Сохранить", en: "Save" },
  "common.of": { uk: "з", ru: "из", en: "of" },

  /* поля паспортной части */
  "person.lastName": { uk: "Прізвище", ru: "Фамилия", en: "Last name" },
  "person.firstName": { uk: "Ім’я", ru: "Имя", en: "First name" },
  "person.middleName": { uk: "По батькові", ru: "Отчество", en: "Patronymic" },
  "person.sex": { uk: "Стать", ru: "Пол", en: "Sex" },
  "person.sex.male": { uk: "чоловіча", ru: "мужской", en: "male" },
  "person.sex.female": { uk: "жіноча", ru: "женский", en: "female" },
  "person.birthDate": { uk: "Дата народження", ru: "Дата рождения", en: "Date of birth" },
  "person.unit": { uk: "Підрозділ", ru: "Подразделение", en: "Unit" },
  /*
   * «Email» не переводится, но идёт через словарь. Это не противоречие.
   *
   * Переводить было чем: «Пошта» / «Почта» — слова живые, и в join.* они уже
   * стоят в связном тексте («Пошта залишається для входу»). Но подпись над
   * полем — не текст, а название того, что в него вводят, и вводят туда
   * строку с собакой. Человек, который ищет глазами, куда набрать
   * ivanov@mil.gov.ua, находит «Email» мгновенно на любом языке; «Пошта» над
   * полем рядом с «Телефон» читается и как «почтовый адрес» — а такое поле в
   * паспортной части тоже мыслимо. Второй довод слабее, но считается:
   * автозаполнение браузера и менеджеры паролей опознают поле в том числе по
   * видимой подписи.
   *
   * Цена решения — ключ, у которого оба перевода совпадают: переводчик видит
   * строку, тратит на неё секунду и идёт дальше, а проверка «переводы не
   * совпадают» такого не запрещает намеренно (см. её комментарий). Цена
   * обратного решения — «Email» остаётся литералом в семи местах разметки,
   * сторож на латиницу его не пропускает, и приходится либо заводить
   * исключение в проверке, либо выключать её. Ключ дешевле исключения:
   * передумать про «Пошту» — это правка одной строки словаря, а не семи
   * экранов.
   */
  "person.email": { uk: "Email", ru: "Email", en: "Email" },
  "person.password": { uk: "Пароль", ru: "Пароль", en: "Password" },
  "person.password8": { uk: "Пароль (мінімум 8 символів)", ru: "Пароль (минимум 8 символов)", en: "Password (at least 8 characters)" },
  "person.normsHint": {
    uk: "Стать і вік потрібні для розрахунку норм за вашою групою.",
    ru: "Пол и возраст нужны для расчёта норм по вашей группе.",
    en: "Sex and age are needed to calculate norms for your group.",
  },

  /* киоск */
  /* планшет без оператора: экран не может ждать, пока кто-нибудь нажмёт кнопку */

  /* регистрация по приглашению */
  "join.checking": { uk: "Перевіряємо запрошення…", ru: "Проверяем приглашение…", en: "Checking the invitation…" },
  "join.invalidTitle": { uk: "Запрошення не діє", ru: "Приглашение не действует", en: "Invitation is not valid" },
  "join.reason.expired": {
    uk: "Строк запрошення минув. Попросіть нове у свого фахівця.",
    ru: "Срок приглашения истёк. Попросите новое у своего специалиста.",
    en: "The invitation has expired. Ask your specialist for a new one.",
  },
  "join.reason.revoked": { uk: "Запрошення відкликано.", ru: "Приглашение отозвано.", en: "The invitation has been revoked." },
  "join.reason.exhausted": { uk: "Запрошення вже використано.", ru: "Приглашение уже использовано.", en: "The invitation has already been used." },
  "join.reason.unknown": {
    uk: "Такого запрошення немає. Перевірте посилання.",
    ru: "Такого приглашения нет. Проверьте ссылку.",
    en: "There is no such invitation. Check the link.",
  },
  "join.doneTitle": { uk: "Готово", ru: "Готово", en: "Done" },
  "join.registerTitle": { uk: "Реєстрація", ru: "Регистрация", en: "Registration" },
  "join.register": { uk: "Зареєструватися", ru: "Зарегистрироваться", en: "Register" },
  "join.creating": { uk: "Створюємо…", ru: "Создаём…", en: "Creating…" },
  "join.anonymous": { uk: "Без імені (у списках — лише код)", ru: "Без имени (в списках — только код)", en: "No name (in lists — code only)" },
  "join.anonymousHint": {
    uk: "Ім’я не зберігається. Пошта залишається для входу — повної анонімності це не дає.",
    ru: "Имя не сохраняется. Почта остаётся для входа — полной анонимности это не даёт.",
    en: "Your name is not stored. Your email is kept for signing in — this does not make you fully anonymous.",
  },
  "join.installApp": {
    uk: "Встановіть мобільний застосунок Quizzy і увійдіть із цією поштою та паролем — обстеження чекатиме на головному екрані.",
    ru: "Установите мобильное приложение Quizzy и войдите с этой почтой и паролем — обследование будет ждать на главном экране.",
    en: "Install the Quizzy mobile app and sign in with this email and password — the assessment will be waiting on the home screen.",
  },
  "join.registerFailed": { uk: "Не вдалося зареєструватися", ru: "Не удалось зарегистрироваться", en: "Registration failed" },

  /* мобилка: вход и регистрация */
  "auth.login": { uk: "Увійти", ru: "Войти", en: "Sign in" },
  "auth.registerTitle": { uk: "Реєстрація", ru: "Регистрация", en: "Registration" },
  "auth.register": { uk: "Зареєструватися", ru: "Зарегистрироваться", en: "Register" },
  "auth.loginFailed": { uk: "Не вдалося увійти", ru: "Не удалось войти", en: "Sign-in failed" },
  "auth.inviteCode": { uk: "Код запрошення (якщо видали)", ru: "Код приглашения (если выдали)", en: "Invitation code (if you were given one)" },
  "auth.logout": { uk: "Вийти", ru: "Выйти", en: "Sign out" },

  /* мобилка: списки методик */
  "surveys.title": { uk: "Методики", ru: "Методики", en: "Instruments" },
  "surveys.empty": { uk: "Доступних методик поки немає. Загляньте пізніше.", ru: "Доступных методик пока нет. Загляните позже.", en: "No instruments are available yet. Check back later." },
  "surveys.questions": { uk: "питань", ru: "вопросов", en: "questions" },
  "surveys.completed": { uk: "Пройдена", ru: "Пройдена", en: "Completed" },
  "surveys.noGroup": { uk: "Без групи", ru: "Без группы", en: "No group" },
  "surveys.loadFailed": { uk: "Не вдалося завантажити методики", ru: "Не удалось загрузить методики", en: "Failed to load instruments" },

  /* мобилка: батарея */
  "battery.progressOf": { uk: "з", ru: "из", en: "of" },
  "battery.overdue": { uk: "Строк минув — пройдіть, будь ласка, найближчим часом", ru: "Срок прошёл — пройдите, пожалуйста, в ближайшее время", en: "Overdue — please complete it as soon as possible" },
  "battery.dueBy": { uk: "Пройти до", ru: "Пройти до", en: "Due by" },
  "battery.noDue": { uk: "Без строку", ru: "Без срока", en: "No deadline" },
  "battery.step.done": { uk: "пройдена", ru: "пройдена", en: "completed" },
  "battery.step.current": { uk: "наступна — натисніть, щоб почати", ru: "следующая — нажмите, чтобы начать", en: "next — tap to start" },
  "battery.step.available": { uk: "доступна", ru: "доступна", en: "available" },
  "battery.step.locked": { uk: "відкриється після попередньої", ru: "откроется после предыдущей", en: "unlocks after the previous one" },
  "battery.step.clinician": { uk: "заповнює фахівець", ru: "заполняет специалист", en: "completed by the specialist" },
  "battery.step.optional": { uk: "можна пропустити", ru: "можно пропустить", en: "can be skipped" },
  "battery.step.usually": { uk: "зазвичай", ru: "обычно", en: "usually" },
  "battery.minutes": { uk: "хв", ru: "мин", en: "min" },
  "battery.clinicianNote": {
    uk: "заповнює фахівець окремо — ваші методики доступні, проходьте їх у своєму порядку.",
    ru: "заполняет специалист отдельно — ваши методики доступны, проходите их в своём порядке.",
    en: "completed separately by the specialist — your instruments are available, take them in any order you like.",
  },

  /* мобилка: прохождение */
  "runner.question": { uk: "Питання", ru: "Вопрос", en: "Question" },
  /* Возврат к пропуску вместо отказа сервера: в опроснике на двести пунктов
     искать пропущенное самому — тупик */
  "runner.missingRequired": {
    uk: "Цей пункт обов’язковий — ми повернули вас до нього",
    ru: "Этот пункт обязателен — мы вернули вас к нему",
    en: "This item is required — we have taken you back to it",
  },
  "runner.info": { uk: "Інформація", ru: "Информация", en: "Information" },
  "runner.submitFailed": { uk: "Не вдалося відправити відповіді", ru: "Не удалось отправить ответы", en: "Failed to submit answers" },

  /* согласие */
  "consent.title": { uk: "Інформована згода", ru: "Информированное согласие", en: "Informed consent" },
  "consent.accept": { uk: "Погоджуюся", ru: "Соглашаюсь", en: "I agree" },
  "consent.decline": { uk: "Не погоджуюся", ru: "Не соглашаюсь", en: "I do not agree" },
  /*
   * Отказ должен быть возможен и не должен выглядеть как поломка. Согласие,
   * от которого нельзя отказаться, — не согласие; а человек, увидевший
   * экран без выхода, просто снесёт приложение.
   */
  "consent.declined": {
    uk: "Без згоди обстеження не проводиться. Ви вийшли з облікового запису — зверніться до свого фахівця, якщо хочете обговорити умови.",
    ru: "Без согласия обследование не проводится. Вы вышли из учётной записи — обратитесь к своему специалисту, если хотите обсудить условия.",
    en: "The assessment is not conducted without consent. You have been signed out — contact your specialist if you would like to discuss the terms.",
  },
  "consent.hint": {
    uk: "Без згоди проходити обстеження не можна. Питання — до вашого фахівця.",
    ru: "Без согласия проходить обследование нельзя. Вопросы — к вашему специалисту.",
    en: "The assessment cannot be taken without consent. Any questions — ask your specialist.",
  },

  /* мобилка: профиль */
  "profile.title": { uk: "Обліковий запис", ru: "Аккаунт", en: "Account" },
  "profile.language": { uk: "Мова застосунку", ru: "Язык приложения", en: "App language" },

  /* ─────────── консоль: навигация ─────────── */
  /*
   * Заголовки групп рельсы.
   *
   * Девятнадцать пунктов подряд человек не читает — он ищет знакомое слово
   * глазами сверху вниз каждый раз заново. Группы названы по работе, а не по
   * сущностям: «Сегодня» — то, с чего начинается смена, «Разбор» — то, что
   * делают, когда приёмы закончились.
   */
  "pt.byMethod": { uk: "За методиками", ru: "По методикам", en: "By instrument" },
  "pt.openCard": { uk: "Відкрити картку", ru: "Открыть карту", en: "Open card" },
  "pt.whoIsThis": { uk: "Хто це", ru: "Кто это", en: "Who is this" },
  "pt.pickRow": { uk: "Виберіть рядок, щоб побачити коротку довідку", ru: "Выберите строку, чтобы увидеть краткую справку", en: "Select a row to see a brief summary" },
  "nav.group.overview": { uk: "Огляд", ru: "Обзор", en: "Summary" },
  "nav.group.people": { uk: "Люди", ru: "Люди", en: "People" },
  "nav.group.methods": { uk: "Методики та збір", ru: "Методики и сбор", en: "Instruments and data collection" },
  "nav.dashboard": { uk: "Зведення", ru: "Сводка", en: "Overview" },
  "nav.worklist": { uk: "Черга роботи", ru: "Очередь работы", en: "Worklist" },
  "nav.surveys": { uk: "Методики", ru: "Методики", en: "Instruments" },
  "nav.batteries": { uk: "Набори", ru: "Наборы", en: "Batteries" },
  "nav.reception": { uk: "Розклад прийому", ru: "Расписание приёма", en: "Appointment schedule" },
  "nav.invites": { uk: "Запрошення", ru: "Приглашения", en: "Invitations" },
  /*
   * Шесть разделов верхнего меню — дословно с макета.
   *
   * Отдельные ключи, а не переиспользование прежних: макет называет вещи
   * своими словами, и они расходятся с принятыми в системе. «Тести» вместо
   * «Методик» — самое заметное расхождение: «методика» это выверенный
   * инструмент с нормами, «тест» — как это называют на макете. Раз решено
   * делать один в один, на экране стоит слово макета; прежний ключ
   * nav.surveys остаётся там, где текст не с макета.
   */
  "top.patients": { uk: "Пацієнти", ru: "Пациенты", en: "Patients" },
  "top.groups": { uk: "Групи", ru: "Группы", en: "Groups" },
  "top.tests": { uk: "Тести", ru: "Тесты", en: "Tests" },
  "top.analytics": { uk: "Аналітика", ru: "Аналитика", en: "Analytics" },
  "top.statistics": { uk: "Статистика", ru: "Статистика", en: "Statistics" },
  "top.messages": { uk: "Повідомлення", ru: "Сообщения", en: "Messages" },
  /*
   * Подпись переключателя языка в полосе — одним словом, как на макете.
   *
   * Ключ называет ТЕКУЩИЙ язык, поэтому «перевод» здесь и есть само значение:
   * на украинской консоли стоит «Укр», на русской — «Рус». Взять готовое
   * LANG_NAMES[lang].short было нельзя — там «УКР» прописными, а на макете
   * слово набрано как обычное слово, и прописные рядом с «Повідомлення»
   * читались бы вторым уровнем громкости.
   *
   * «Eng» — по тому же образцу: три буквы, обычный регистр, язык назван на
   * себе самом. Список всех трёх подписей разом (для раскрывающегося
   * выбора) — это UI["top.lang"][code] по LANGS: запись одна на все языки.
   */
  "top.lang": { uk: "Укр", ru: "Рус", en: "Eng" },
  /** Прочие разделы — за бургером справа, как и нарисовано на макете */
  /*
   * Якоря волны 3. Каждый экран волны добавляет свои ключи ТОЛЬКО под своим
   * якорем: экраны делаются параллельно в отдельных рабочих копиях, и один
   * общий конец файла у четырёх авторов означал бы четыре конфликта при
   * слиянии. Пустой якорь — не мусор, а место, отведённое заранее.
   */
  /* ── wave6:patient ── */
  /*
   * Карточка пациента (кадр f19) — экран /patients/:id раздела «Пацієнти».
   *
   * Подписи плашек и заголовки разделов взяты из соседних словарей
   * (person.*, ppl.*, top.*, pg.*): «Стать», «Тести», «Опис Групи» — те же
   * слова, и второй ключ на них разошёлся бы с первым при первой же правке.
   * Здесь только то, чего в словаре ещё не было. Регистр и написание
   * подписей кадра («телефон», «email», «Населенний») выровнены по словарю.
   */
  "pcard.unsubscribe": { uk: "Відписатись", ru: "Отписаться", en: "Unsubscribe" },
  "pcard.subscribe": { uk: "Підписатись", ru: "Подписаться", en: "Subscribe" },
  "pcard.subscribed": { uk: "Пацієнта закріплено за вами", ru: "Пациент закреплён за вами", en: "The patient is now linked to you" },
  "pcard.unsubscribed": { uk: "Закріплення знято", ru: "Закрепление снято", en: "Link removed" },
  "pcard.conclusions": { uk: "Заключення", ru: "Заключения", en: "Conclusions" },
  "pcard.result": { uk: "Результат тесту", ru: "Результат теста", en: "Test result" },
  "pcard.groupStats": { uk: "Статистика Групи", ru: "Статистика группы", en: "Group statistics" },
  "pcard.composition": { uk: "Список тестів та аналітики", ru: "Список тестов и аналитики", en: "Tests and analytics" },
  "pcard.findings": { uk: "Висновки", ru: "Выводы", en: "Findings" },
  /* имя меню за знаком «+» раздела «Заключення»: пункты — сданные тесты, по которым его можно написать */
  "pcard.newConclusion": { uk: "Нове заключення", ru: "Новое заключение", en: "New conclusion" },
  /* имя меню за шестерёнкой: дверь к прежней карте — огляд, динаміка, хронологія */
  "pcard.clinical": { uk: "Клінічна карта", ru: "Клиническая карта", en: "Clinical record" },
  "pcard.noTests": { uk: "Пройдених тестів ще немає", ru: "Пройденных тестов ещё нет", en: "No completed tests yet" },
  "pcard.noGroups": { uk: "У ваших групах пацієнта немає", ru: "В ваших группах пациента нет", en: "The patient is not in any of your groups" },
  "pcard.noConclusions": { uk: "Заключень ще немає", ru: "Заключений ещё нет", en: "No conclusions yet" },
  "pcard.noScores": { uk: "Балів немає", ru: "Баллов нет", en: "No scores" },
  "pcard.unreliable": { uk: "Протокол недостовірний", ru: "Протокол недостоверный", en: "Invalid protocol" },
  "pcard.draft": { uk: "чернетка", ru: "черновик", en: "draft" },
  /* ── wave6:statistics ── */
  /* ── wave6:messages ── */
  /* ── audit:messages ── */
  /*
   * Розсилки — раздел «Повідомлення» верхней полосы (кадры f11, f20, f26):
   * список «тема · начало текста · дата», форма «Назва / Текст / Відповідь»
   * и меню-шестерня. Заголовок экрана — тот же «top.messages», что и пункт
   * полосы: второго перевода одному слову не заводится.
   *
   * «Відправити» — слово кадра f26 (чернила первого пункта меню 1293…1376).
   * Прежде здесь стояло «Надіслати» с доводом «словарь держит одну форму, и
   * эта форма — надіслати, восемнадцать строк против трёх». Довод верный, а
   * вывод был обратным правилу волны: кадр — истина, и если кадр требует
   * другой формы, меняется весь словарь, а не кадр. Поэтому одним махом
   * переведены ВСЕ вхождения — «надіслати» → «відправити», «надіслано» →
   * «відправлено», «надсилання» → «відправлення», «ненадіслані» →
   * «невідправлені»: runner.submitFailed, cn3.sendMail, cn3.sendMailWhy,
   * pw.sent, ms.savedHereOnly, ms.send, ms.sent, act.response_submit,
   * mq.allSent, mq.title, tab.queue, ob.rejected, ob.rejectedTap,
   * mp.pendingTap, mp.unsentAnswers, mp.unsentHint, mob.sending, role.*
   * пояснение — и весь блок mail.*. Русская половина не трогалась: там
   * «отправить» и была одна форма.
   *
   * Сторож одной формы (uiStrings.test.ts, «отправить») теперь держит
   * «відправити»: вернуть «надіслати» в одну строку он не даст.
   */
  "mail.search": { uk: "Пошук повідомлень", ru: "Поиск сообщений", en: "Search messages" },
  "mail.add": { uk: "Нове повідомлення", ru: "Новое сообщение", en: "New message" },
  "mail.empty": { uk: "Повідомлень ще немає", ru: "Сообщений ещё нет", en: "No messages yet" },
  "mail.emptySearch": { uk: "Нічого не знайдено", ru: "Ничего не найдено", en: "Nothing found" },
  "mail.name": { uk: "Назва повідомлення", ru: "Название сообщения", en: "Message title" },
  "mail.body": { uk: "Текст повідомлення", ru: "Текст сообщения", en: "Message text" },
  "mail.answer": { uk: "Відповідь", ru: "Ответ", en: "Answer" },
  "mail.yes": { uk: "Так", ru: "Да", en: "Yes" },
  "mail.no": { uk: "Ні", ru: "Нет", en: "No" },
  /** Имя поля варианта для диктора: на кадре у вариантов подписи нет, только текст */
  "mail.option": { uk: "Варіант відповіді", ru: "Вариант ответа", en: "Answer option" },
  "mail.addOption": { uk: "Додати варіант відповіді", ru: "Добавить вариант ответа", en: "Add answer option" },
  /**
   * Адресаты: на кадрах их нет, поле с формы убрано, и подпись осталась для
   * окна шага «Відправити» — см. MailingEditor, SendDialog.
   */
  "mail.recipients": { uk: "Група отримувачів", ru: "Группа получателей", en: "Recipient group" },
  "mail.create": { uk: "Створити", ru: "Создать", en: "Create" },
  "mail.menu": { uk: "Дії з повідомленням", ru: "Действия с сообщением", en: "Message actions" },
  "mail.send": { uk: "Відправити", ru: "Отправить", en: "Send" },
  "mail.delete": { uk: "Видалити", ru: "Удалить", en: "Delete" },
  "mail.fillIn": { uk: "Заповніть назву і текст повідомлення", ru: "Заполните название и текст сообщения", en: "Fill in the message title and text" },
  "mail.alreadySent": { uk: "Повідомлення вже відправлено", ru: "Сообщение уже отправлено", en: "The message has already been sent" },
  "mail.confirmSend": {
    uk: "Відправити повідомлення отримувачам? Після цього текст і варіанти відповіді не змінюються.",
    ru: "Отправить сообщение получателям? После этого текст и варианты ответа не меняются.",
    en: "Send the message to the recipients? After that, the text and answer options cannot be changed.",
  },
  "mail.confirmDelete": { uk: "Видалити чернетку повідомлення?", ru: "Удалить черновик сообщения?", en: "Delete the message draft?" },
  "mail.confirmHide": {
    uk: "Відправлене повідомлення не видаляється. Приховати його зі списку?",
    ru: "Отправленное сообщение не удаляется. Скрыть его из списка?",
    en: "A sent message cannot be deleted. Hide it from the list?",
  },
  "mail.created": { uk: "Чернетку створено", ru: "Черновик создан", en: "Draft created" },
  "mail.saved": { uk: "Збережено", ru: "Сохранено", en: "Saved" },
  "mail.sent": { uk: "Повідомлення відправлено", ru: "Сообщение отправлено", en: "Message sent" },
  "mail.deleted": { uk: "Чернетку видалено", ru: "Черновик удалён", en: "Draft deleted" },
  "mail.hidden": { uk: "Повідомлення приховано", ru: "Сообщение скрыто", en: "Message hidden" },
  /* ── wave6:public ── */
  /*
   * Публичная часть — кадры f00 (лендинг «Про кампанію») и f01 (вход).
   *
   * Текст «Про кампанію» на кадре — рыба (Lorem ipsum): настоящий текст
   * заказчик не дал, и здесь стоит ровно то, что нарисовано. Когда текст
   * появится, менять его — в этой строке, а не в экране. Контакты и почта
   * тоже с кадра: на сервере места под реквизиты учреждения нет, и адрес
   * «belivnik@ukr.net» с телефоном живут здесь до появления настроек.
   */
  "pub.about": { uk: "Про кампанію", ru: "О кампании", en: "About the campaign" },
  "pub.aboutText": {
    uk:
      "Lorem ipsum dolor sit amet, consectetuer adipiscing elit, sed diam nonummy nibh euismod tincidunt " +
      "ut laoreet dolore magna aliquam erat volutpat. Ut wisi enim ad minim veniam, quis nostrud exerci " +
      "tation ullamcorper suscipit lobortis nisl ut aliquip ex ea commodo consequat. Duis autem vel",
    ru:
      "Lorem ipsum dolor sit amet, consectetuer adipiscing elit, sed diam nonummy nibh euismod tincidunt " +
      "ut laoreet dolore magna aliquam erat volutpat. Ut wisi enim ad minim veniam, quis nostrud exerci " +
      "tation ullamcorper suscipit lobortis nisl ut aliquip ex ea commodo consequat. Duis autem vel",
    en: "Lorem ipsum dolor sit amet, consectetuer adipiscing elit, sed diam nonummy nibh euismod tincidunt ut laoreet dolore magna aliquam erat volutpat. Ut wisi enim ad minim veniam, quis nostrud exerci tation ullamcorper suscipit lobortis nisl ut aliquip ex ea commodo consequat. Duis autem vel",
  },
  /* на кадре «Введить» — опечатка макета, исправлена на «Введіть» */
  "pub.loginTitle": { uk: "Введіть логін та пароль щоб продовжити", ru: "Введите логин и пароль, чтобы продолжить", en: "Enter your login and password to continue" },
  /* поле подписано «Логін», как на кадре; сервер принимает в него почту (см. Login.tsx) */
  "pub.login": { uk: "Логін", ru: "Логин", en: "Login" },
  "pub.faq": { uk: "FAQ", ru: "FAQ", en: "FAQ" },
  "pub.press": { uk: "Для преси", ru: "Для прессы", en: "For the press" },
  "pub.contacts": { uk: "Контакти:", ru: "Контакты:", en: "Contacts:" },
  /*
   * Номер и город — ДВЕ записи, хотя на кадре это одна строка.
   *
   * Одним ключом «+38 044 123 45 67 — Київ, Україна» ссылкой «позвонить»
   * становилась вся строка вместе с городом: наведение подчёркивало
   * «— Київ, Україна», а диктор читал город как часть номера. На кадре
   * f00 признаков ссылки у строки нет вовсе — она набрана тем же
   * начертанием 14/400, что и соседние. Адрес ссылки при этом получался
   * разрезанием подписи по тире — то есть смысл строки был зашит в её
   * знаки препинания и держался до первой правки реквизитов.
   *
   * Тире между ними ставит разметка (PublicFrame.tsx): оно разделяет две
   * записи и потому принадлежит месту, а не ни одной из них.
   */
  "pub.phone": { uk: "+38 044 123 45 67", ru: "+38 044 123 45 67", en: "+38 044 123 45 67" },
  "pub.city": { uk: "Київ, Україна", ru: "Киев, Украина", en: "Kyiv, Ukraine" },
  "pub.email": { uk: "belivnik@ukr.net", ru: "belivnik@ukr.net", en: "belivnik@ukr.net" },
  "pub.social": { uk: "Ми в соцмережах:", ru: "Мы в соцсетях:", en: "Find us on social media:" },
  /* имена сетей — подписи круглых значков для диктора; не переводятся */
  "pub.facebook": { uk: "Facebook", ru: "Facebook", en: "Facebook" },
  "pub.youtube": { uk: "YouTube", ru: "YouTube", en: "YouTube" },
  "pub.telegram": { uk: "Telegram", ru: "Telegram", en: "Telegram" },
  /* подпись знака POLSY как ссылки и ориентира навигации подвала */
  "pub.home": { uk: "На головну", ru: "На главную", en: "Home" },
  "pub.sections": { uk: "Розділи сайту", ru: "Разделы сайта", en: "Site sections" },
  /* год с кадра, а не текущий: заказчик просил экраны один в один (см. PublicFrame.tsx) */
  "pub.copyright": { uk: "©2023", ru: "©2023", en: "©2023" },
  /* ── audit:public ── */
  /*
   * Сверка публичной части с кадрами f00/f01. Своих новых подписей она
   * не принесла: всё, что нашлось, — промахи по размеру, месту и цвету,
   * и одна строка, которую пришлось разрезать надвое (см. «pub.phone»
   * выше — запись осталась на месте, чтобы контакты подвала лежали
   * рядом, а не в двух концах файла). Якорь заведён пустым нарочно: без
   * него следующая правка публичной части снова дописывала бы ключи в
   * чужой блок.
   */
  /* ── wave4:groups ── */
  /*
   * Группы ПАЦИЕНТОВ (кадры f05, f10, f20) — раздел «Групи» верхней полосы.
   *
   * Словарь говорит «тест», а не «методика», как и каталог: так набраны
   * заголовки на кадрах («Тести Групи»), и так же назван раздел в верхнем
   * меню. «Група» без уточнения здесь всегда означает группу пациентов;
   * группы методик зовутся полным именем (adm.groupsTitle).
   */
  "pg.title": { uk: "Групи", ru: "Группы", en: "Groups" },
  "pg.search": { uk: "Пошук групи", ru: "Поиск группы", en: "Search groups" },
  "pg.add": { uk: "Додати групу", ru: "Добавить группу", en: "Add group" },
  "pg.edit": { uk: "Редагувати групу", ru: "Редактировать группу", en: "Edit group" },
  "pg.create": { uk: "Створити", ru: "Создать", en: "Create" },
  "pg.name": { uk: "Назва групи", ru: "Название группы", en: "Group name" },
  /* подпись поля повторяет формулировку заказчика: описание — это вопрос, ради которого группа собрана */
  "pg.descriptionField": { uk: "Опис групи (питання до групи)", ru: "Описание группы (вопрос к группе)", en: "Group description (question for the group)" },
  "pg.favorite": { uk: "Обрана група", ru: "Избранная группа", en: "Favorite group" },
  "pg.empty": { uk: "Груп ще немає — додайте першу знаком «+»", ru: "Групп ещё нет — добавьте первую знаком «+»", en: "No groups yet — add the first one with “+”" },
  "pg.emptySearch": { uk: "За запитом груп не знайдено", ru: "По запросу групп не найдено", en: "No groups match your search" },
  "pg.noDescription": { uk: "Без опису", ru: "Без описания", en: "No description" },
  /* «12 учасників · 3 тестів» — микроподпись строки; число стоит перед словом, форма одна на все числа */
  "pg.members": { uk: "учасників", ru: "участников", en: "members" },
  "pg.tests": { uk: "тестів", ru: "тестов", en: "tests" },
  /* карточка группы — заголовки блоков дословно с кадра f20 */
  "pg.description": { uk: "Опис Групи", ru: "Описание группы", en: "Group description" },
  "pg.groupTests": { uk: "Тести Групи", ru: "Тесты группы", en: "Group tests" },
  "pg.groupPatients": { uk: "Пацієнти Групи", ru: "Пациенты группы", en: "Group patients" },
  "pg.patient": { uk: "Пацієнт", ru: "Пациент", en: "Patient" },
  "pg.patientSearch": { uk: "Пошук пацієнта", ru: "Поиск пациента", en: "Search patients" },
  "pg.addPatient": { uk: "Додати пацієнта", ru: "Добавить пациента", en: "Add patient" },
  "pg.addOne": { uk: "Додати", ru: "Добавить", en: "Add" },
  "pg.alreadyIn": { uk: "вже в групі", ru: "уже в группе", en: "already in the group" },
  "pg.truncated": { uk: "Показано не всіх — звузьте пошук", ru: "Показаны не все — сузьте поиск", en: "Not everyone is shown — narrow your search" },
  "pg.noTests": { uk: "Тестів групі ще не призначено", ru: "Тесты группе ещё не назначены", en: "No tests have been assigned to the group yet" },
  "pg.noMembers": { uk: "У групі ще немає пацієнтів — додайте знаком «+»", ru: "В группе ещё нет пациентов — добавьте знаком «+»", en: "The group has no patients yet — add them with “+”" },
  /* строка теста группы: «призначено 05.02.2023 · до 01.03.2023 · пройшли 5 з 12» */
  "pg.assignedOn": { uk: "призначено", ru: "назначено", en: "assigned" },
  "pg.until": { uk: "до", ru: "до", en: "due" },
  "pg.completed": { uk: "пройшли", ru: "прошли", en: "completed" },
  "pg.test": { uk: "Тест", ru: "Тест", en: "Test" },
  "pg.assignTest": { uk: "Призначити тест", ru: "Назначить тест", en: "Assign test" },
  "pg.assigned": { uk: "Тест призначено", ru: "Тест назначен", en: "Test assigned" },
  /* выбор галочками: «18 вибрано» — нижний рядок кадра f05 */
  "pg.selected": { uk: "вибрано", ru: "выбрано", en: "selected" },
  "pg.select": { uk: "Вибрати", ru: "Выбрать", en: "Select" },
  "pg.clearSelection": { uk: "Зняти вибір", ru: "Снять выбор", en: "Clear selection" },
  "pg.addToGroup": { uk: "Додати до групи", ru: "Добавить в группу", en: "Add to group" },
  "pg.added": { uk: "Додано до групи", ru: "Добавлены в группу", en: "Added to the group" },
  "pg.removeFromGroup": { uk: "Прибрати з групи", ru: "Убрать из группы", en: "Remove from group" },
  "pg.removed": { uk: "Прибрано з групи", ru: "Убраны из группы", en: "Removed from the group" },
  /* вкладки над списком пациентов */
  "pg.tabsLabel": { uk: "Групи пацієнтів", ru: "Группы пациентов", en: "Patient groups" },
  "pg.allTab": { uk: "Усі", ru: "Все", en: "All" },
  "pg.invite": { uk: "Запросити пацієнта", ru: "Пригласить пациента", en: "Invite patient" },
  /* «1986р.» — суффикс года рождения в мета-строке, слитно с числом, как на макете */
  "pg.yearSuffix": { uk: "р.", ru: "г.", en: "" },
  /* ── wave4:people ── */
  /*
   * Люди: разделы «Лікарі» и «Адміністратори» (кадры f32–f36, f41–f44,
   * f48–f51 макета).
   *
   * Словарь экрана говорит «лікар», как набрано на кадрах, хотя в системе
   * это «сотрудник» — учётная запись класса admin. Разводить слова не
   * стал: раздел в верхнем меню подписан «Лікарі», и второй ярлык для того
   * же списка читался бы как второй список.
   */
  "ppl.staff": { uk: "Лікарі", ru: "Врачи", en: "Clinicians" },
  "ppl.addDoctor": { uk: "Додати лікаря", ru: "Добавить врача", en: "Add clinician" },
  "ppl.tabProfile": { uk: "Профіль", ru: "Профиль", en: "Profile" },
  "ppl.tabsLabel": { uk: "Розділи картки", ru: "Разделы карточки", en: "Card sections" },
  "ppl.actions": { uk: "Дії з карткою", ru: "Действия с карточкой", en: "Card actions" },
  "ppl.edit": { uk: "Редагувати", ru: "Редактировать", en: "Edit" },
  "ppl.onlySelf": { uk: "Доступно лише у власній картці", ru: "Доступно только в своей карточке", en: "Available only on your own card" },
  /* «Ім’я по батькові» — так на кадре; общий ключ person.middleName короче */
  "ppl.middleName": { uk: "Ім’я по батькові", ru: "Отчество", en: "Patronymic" },
  "ppl.specialty": { uk: "Спеціалізація", ru: "Специализация", en: "Specialty" },
  "ppl.organization": { uk: "Організація", ru: "Организация", en: "Organization" },
  /*
   * Со строчной — как на кадре: «телефон» и «email» в плашках полей набраны
   * строчными на всех восьми кадрах карточки и формы (f02, f04, f30, f31,
   * f40, f41, f43, f47, f48, f50). Прежде здесь стояло «Телефон» с
   * оговоркой, что это правописание, а не кадр; оговорка неверна — это
   * подпись поля, а не предложение, и кадр её задаёт целиком. Пара к нему —
   * ppl.email ниже, под якорем audit:people.
   */
  "ppl.phone": { uk: "телефон", ru: "телефон", en: "phone" },
  /*
   * На кадре «Населенний пункт» — с двойным «нн», и так на всех восьми
   * кадрах одинаково. Это описка макета, а не форма слова: в словаре
   * правописание, «Населений».
   */
  "ppl.city": { uk: "Населений пункт", ru: "Населённый пункт", en: "Locality" },
  "ppl.unset": { uk: "не вказано", ru: "не указано", en: "not specified" },
  "ppl.roleNone": { uk: "Без ролі-шаблону", ru: "Без роли-шаблона", en: "No role template" },
  "ppl.notStoredYet": { uk: "Сервер поки не зберігає це поле", ru: "Сервер пока не хранит это поле", en: "The server does not store this field yet" },
  "ppl.disabledFieldsHint": {
    uk: "Затемнені поля сервер поки не зберігає",
    ru: "Затемнённые поля сервер пока не хранит",
    en: "The server does not store the dimmed fields yet",
  },
  "ppl.created": { uk: "Обліковий запис створено", ru: "Учётная запись создана", en: "Account created" },
  "ppl.notFound": {
    uk: "Такого співробітника немає або він вам не видимий",
    ru: "Такого сотрудника нет или он вам не виден",
    en: "This staff member does not exist or is not visible to you",
  },
  "ppl.directoryPartial": {
    uk: "Показано лише тих, кого ви вправі призначати",
    ru: "Показаны только те, кого вы вправе назначать",
    en: "Only people you are allowed to assign are shown",
  },
  "ppl.patientsOthersHint": {
    uk: "Пацієнтів іншого лікаря сервер поки не віддає",
    ru: "Пациентов другого врача сервер пока не отдаёт",
    en: "The server does not yet return another clinician's patients",
  },
  "ppl.groupsOthersHint": {
    uk: "Групи іншого лікаря бачить лише суперадміністратор",
    ru: "Группы другого врача видит только суперадминистратор",
    en: "Only a superadministrator can see another clinician's groups",
  },
  "ppl.noPatients": { uk: "Пацієнтів поки немає", ru: "Пациентов пока нет", en: "No patients yet" },
  "ppl.noGroups": { uk: "Груп поки немає", ru: "Групп пока нет", en: "No groups yet" },
  "ppl.searchGroups": { uk: "Пошук групи", ru: "Поиск группы", en: "Search groups" },
  /* «1986р.» — рік у метарядку списку набирається впритул, як на кадрі */
  "ppl.yearShort": { uk: "р.", ru: "г.", en: "" },

  /* ── audit:people ── */
  /*
   * Сверка раздела «Люди» с кадрами f02, f04, f30, f31, f34, f35, f40–f43,
   * f47–f50. Здесь только то, чего словарь ещё не знал, и подписи мест, куда
   * ушло убранное с глаз.
   */
  /*
   * Подпись поля почты в разделе людей — строчными, как на кадре, и своим
   * ключом, а не правкой общего person.email («Email»). Общий ключ стоит
   * заголовком столбца в трёх таблицах администрирования (Access, Groups,
   * Admin) и подписью на странице приглашения — там заглавная на месте, и
   * кадра, который требовал бы её сменить, у тех экранов нет. Один ключ на
   * две разные подписи был бы дешевле ровно до первого спора о том, чей
   * кадр главнее.
   */
  "ppl.email": { uk: "email", ru: "email", en: "email" },
  /*
   * Заголовок СВОЕЙ карточки — слово роли, а не имя: «Лікар» (f04),
   * «Адміністратор» (f40), «Супер Адміністратор» (f47). Последнее — два
   * слова с заглавной в обоих, именно так на кадре; слитное
   * «Суперадміністратор» (nav.roleSuper) остаётся названием класса учётной
   * записи в поле «Роль» и в правах — это другая роль слова.
   */
  "ppl.roleDoctor": { uk: "Лікар", ru: "Врач", en: "Clinician" },
  "ppl.roleAdmin": { uk: "Адміністратор", ru: "Администратор", en: "Administrator" },
  "ppl.roleSuperTitle": { uk: "Супер Адміністратор", ru: "Супер Администратор", en: "Superadministrator" },
  /* подсказка погашенных пунктов меню на форме заведения (f41/f48) */
  "ppl.notCreatedYet": { uk: "Доступно після створення запису", ru: "Доступно после создания записи", en: "Available after the record is created" },
  /*
   * Секция «Лікарі» в чужой карточке администратора (f50) нарисована, а
   * связи «этот администратор → его лікарі» у сервера нет вовсе. Место на
   * экране остаётся, и вместо чужого списка в нём стоит честный ответ.
   */
  "ppl.staffOfAdminUnknown": {
    uk: "Сервер поки не каже, які лікарі підпорядковані цьому адміністраторові",
    ru: "Сервер пока не говорит, какие врачи подчинены этому администратору",
    en: "The server does not yet report which clinicians report to this administrator",
  },
  /* строка для диктора вместо числа у заголовка: на кадре его нет, а список он не окидывает взглядом */
  "ppl.found": { uk: "Знайдено", ru: "Найдено", en: "Found" },
  /* имя сетки плиток переходов под чужой карточкой (f31) */
  "ppl.tilesLabel": { uk: "Розділи цієї людини", ru: "Разделы этого человека", en: "This person's sections" },

  /* ── wave4:analytics ── */
  /*
   * Раздел «Аналітика» (кадры f08, f15, f27 макета).
   *
   * «Аналітична модель» здесь — правило поддержки решений (decision_rules):
   * своей сущности у модели на сервере нет, а правило уже несёт имя, условия
   * по тестам и шкалам и действия, и экран заключения зовёт его так же.
   * Слова — с кадров: «тест», «параметр», «дія», «правило»; там, где кадр
   * молчит (вид параметра, действия, ошибки формы), взяты слова того же ряда.
   */
  "am.title": { uk: "Перелік аналітики", ru: "Перечень аналитики", en: "Analytics list" },
  "am.search": { uk: "Пошук аналітичної моделі", ru: "Поиск аналитической модели", en: "Search analytics models" },
  "am.add": { uk: "Додати аналітичну модель", ru: "Добавить аналитическую модель", en: "Add analytics model" },
  "am.empty": { uk: "Аналітичних моделей ще немає", ru: "Аналитических моделей ещё нет", en: "No analytics models yet" },
  "am.emptySearch": { uk: "За запитом нічого не знайдено", ru: "По запросу ничего не найдено", en: "Nothing matches your search" },
  "am.modelName": { uk: "Назва аналітичної моделі", ru: "Название аналитической модели", en: "Analytics model name" },
  "am.modelNote": { uk: "Опис аналітичної моделі", ru: "Описание аналитической модели", en: "Analytics model description" },
  "am.structure": { uk: "Структура", ru: "Структура", en: "Structure" },
  "am.structureMenu": { uk: "Дії зі структурою", ru: "Действия со структурой", en: "Structure actions" },
  "am.addAction": { uk: "Додати Дію", ru: "Добавить Действие", en: "Add action" },
  "am.addParam": { uk: "Додати Параметр", ru: "Добавить Параметр", en: "Add parameter" },
  "am.deleteSelected": { uk: "Видалити", ru: "Удалить", en: "Delete" },
  "am.disable": { uk: "Вимкнути модель", ru: "Выключить модель", en: "Disable model" },
  "am.enable": { uk: "Увімкнути модель", ru: "Включить модель", en: "Enable model" },
  "am.noneSelected": { uk: "Спочатку позначте, що видалити", ru: "Сначала отметьте, что удалить", en: "First mark what to delete" },
  "am.testName": { uk: "Назва тесту", ru: "Название теста", en: "Test name" },
  "am.anyTest": { uk: "Будь-який тест", ru: "Любой тест", en: "Any test" },
  "am.testUnavailable": {
    uk: "Недоступний тест (поза вашими групами або видалений)",
    ru: "Недоступный тест (вне ваших групп или удалён)",
    en: "Unavailable test (outside your groups or deleted)",
  },
  "am.testResult": { uk: "Результат тесту", ru: "Результат теста", en: "Test result" },
  "am.scaleCode": { uk: "Код шкали", ru: "Код шкалы", en: "Scale code" },
  "am.scale": { uk: "Шкала", ru: "Шкала", en: "Scale" },
  "am.paramKind": { uk: "Вид параметра", ru: "Вид параметра", en: "Parameter type" },
  "am.kindRisk": { uk: "Прапор ризику", ru: "Флаг риска", en: "Risk flag" },
  "am.kindHistory": { uk: "Кількість проходжень", ru: "Количество прохождений", en: "Number of completions" },
  "am.riskLevel": { uk: "Рівень ризику", ru: "Уровень риска", en: "Risk level" },
  "am.riskModerate": { uk: "Помірний або виражений", ru: "Умеренный или выраженный", en: "Moderate or severe" },
  "am.riskSevere": { uk: "Виражений", ru: "Выраженный", en: "Severe" },
  "am.completedAtLeast": { uk: "Проходжень не менше", ru: "Прохождений не меньше", en: "Minimum completions" },
  "am.metric": { uk: "Що порівнюємо", ru: "Что сравниваем", en: "What to compare" },
  "am.metricRaw": { uk: "Сирий бал", ru: "Сырой балл", en: "Raw score" },
  "am.metricNormed": { uk: "Нормований бал", ru: "Нормированный балл", en: "Normed score" },
  "am.op": { uk: "Умова", ru: "Условие", en: "Condition" },
  "am.opGte": { uk: "Не менше", ru: "Не меньше", en: "At least" },
  "am.opLte": { uk: "Не більше", ru: "Не больше", en: "At most" },
  "am.opGt": { uk: "Більше", ru: "Больше", en: "Greater than" },
  "am.opLt": { uk: "Менше", ru: "Меньше", en: "Less than" },
  "am.threshold": { uk: "Порогове значення", ru: "Пороговое значение", en: "Threshold" },
  "am.together": { uk: "Разом з", ru: "Вместе с", en: "Together with" },
  "am.addRule": { uk: "Додати правило", ru: "Добавить правило", en: "Add rule" },
  "am.pickParam": { uk: "Позначити параметр", ru: "Отметить параметр", en: "Mark parameter" },
  "am.pickAction": { uk: "Позначити дію", ru: "Отметить действие", en: "Mark action" },
  "am.actionKind": { uk: "Вид дії", ru: "Вид действия", en: "Action type" },
  "am.actAdvise": { uk: "Порада фахівцю", ru: "Совет специалисту", en: "Advice to the specialist" },
  "am.actNotify": { uk: "Повідомити чергового", ru: "Уведомить дежурного", en: "Notify the on-call specialist" },
  "am.actSuggest": { uk: "Запропонувати тест", ru: "Предложить тест", en: "Suggest a test" },
  "am.actPathway": { uk: "Запропонувати маршрут", ru: "Предложить маршрут", en: "Suggest a pathway" },
  "am.adviseText": { uk: "Текст поради", ru: "Текст совета", en: "Advice text" },
  "am.suggestTest": { uk: "Який тест запропонувати", ru: "Какой тест предложить", en: "Which test to suggest" },
  "am.pathwayId": { uk: "Ідентифікатор маршруту", ru: "Идентификатор маршрута", en: "Pathway ID" },
  "am.saved": { uk: "Модель збережено", ru: "Модель сохранена", en: "Model saved" },
  "am.notFound": { uk: "Модель не знайдено", ru: "Модель не найдена", en: "Model not found" },
  "am.backToList": { uk: "До переліку аналітики", ru: "К перечню аналитики", en: "Back to analytics list" },
  "am.disabledNote": {
    uk: "Модель вимкнена: на проходження вона не спрацьовує.",
    ru: "Модель выключена: на прохождения она не срабатывает.",
    en: "The model is disabled: it does not trigger on completions.",
  },
  "am.errTitle": { uk: "Вкажіть назву моделі", ru: "Укажите название модели", en: "Enter the model name" },
  "am.errNoParams": { uk: "Додайте хоча б один параметр", ru: "Добавьте хотя бы один параметр", en: "Add at least one parameter" },
  "am.errTest": { uk: "Оберіть тест у кожному параметрі", ru: "Выберите тест в каждом параметре", en: "Select a test in each parameter" },
  "am.errScale": { uk: "Вкажіть шкалу у кожному параметрі", ru: "Укажите шкалу в каждом параметре", en: "Specify a scale in each parameter" },
  "am.errThreshold": { uk: "Порогове значення має бути числом", ru: "Пороговое значение должно быть числом", en: "The threshold must be a number" },
  "am.errCount": { uk: "Кількість проходжень — ціле число від 0 до 100", ru: "Количество прохождений — целое число от 0 до 100", en: "Number of completions — a whole number from 0 to 100" },
  "am.errNoActions": { uk: "Додайте хоча б одну дію", ru: "Добавьте хотя бы одно действие", en: "Add at least one action" },
  "am.errAdvise": { uk: "Впишіть текст поради", ru: "Впишите текст совета", en: "Enter the advice text" },
  "am.errSuggest": { uk: "Оберіть тест, який пропонує дія", ru: "Выберите тест, который предлагает действие", en: "Select the test the action suggests" },
  "am.errPathway": { uk: "Вкажіть маршрут, який пропонує дія", ru: "Укажите маршрут, который предлагает действие", en: "Specify the pathway the action suggests" },
  /* ── wave3:catalogue ── */
  /*
   * Каталог тестов (кадр f11 макета).
   *
   * Словарь экрана говорит «тест», а не «методика», как остальная консоль:
   * так набраны вкладки на макете («Опубліковані тести»), и так же назван
   * раздел в верхнем меню (top.tests). Два слова для одной сущности на одном
   * экране читались бы как две сущности; остальные экраны перейдут на «тест»
   * своими волнами, а старые ключи cl.* остаются у действий строки, пока их
   * не перепишет конструктор.
   */
  "cat.title": { uk: "Тести", ru: "Тесты", en: "Tests" },
  "cat.tabsLabel": { uk: "Стан тестів", ru: "Состояние тестов", en: "Test status" },
  "cat.tabPublished": { uk: "Опубліковані тести", ru: "Опубликованные тесты", en: "Published tests" },
  "cat.tabDrafts": { uk: "Неопубліковані тести", ru: "Неопубликованные тесты", en: "Unpublished tests" },
  "cat.tabRetired": { uk: "Зняті з використання", ru: "Снятые с использования", en: "Retired" },
  /* подпись набирается в два рядка узкой колонкой, как на макете, — перенос делает ширина, а не ключ */
  "cat.perPage": { uk: "елементів на сторінці", ru: "элементов на странице", en: "items per page" },
  "cat.page": { uk: "сторінка", ru: "страница", en: "page" },
  "cat.prevPage": { uk: "Попередня сторінка", ru: "Предыдущая страница", en: "Previous page" },
  "cat.nextPage": { uk: "Наступна сторінка", ru: "Следующая страница", en: "Next page" },
  "cat.search": { uk: "Пошук тестів", ru: "Поиск тестов", en: "Search tests" },
  "cat.add": { uk: "Додати", ru: "Добавить", en: "Add" },
  "cat.newTest": { uk: "Новий тест", ru: "Новый тест", en: "New test" },
  "cat.newFolder": { uk: "Нова папка", ru: "Новая папка", en: "New folder" },
  "cat.root": { uk: "Мої тести", ru: "Мои тесты", en: "My tests" },
  "cat.crumbsLabel": { uk: "Шлях у каталозі", ru: "Путь в каталоге", en: "Catalog path" },
  "cat.folderMenu": { uk: "Інші папки цього рівня та дії з папкою", ru: "Другие папки этого уровня и действия с папкой", en: "Other folders at this level and folder actions" },
  "cat.folders": { uk: "Папки", ru: "Папки", en: "Folders" },
  "cat.resultCol": { uk: "Результат тесту", ru: "Результат теста", en: "Test result" },
  "cat.statsCol": { uk: "Статистика", ru: "Статистика", en: "Statistics" },
  "cat.actionsCol": { uk: "Дії", ru: "Действия", en: "Actions" },
  "cat.noDescription": { uk: "Опис не задано", ru: "Описание не задано", en: "No description provided" },
  "cat.keysVerified": { uk: "ключі звірено", ru: "ключи сверены", en: "scoring keys verified" },
  "cat.keysUnverified": { uk: "ключі не звірено", ru: "ключи не сверены", en: "scoring keys not verified" },
  "cat.scoringOff": { uk: "без підрахунку балів", ru: "без подсчёта баллов", en: "no scoring" },
  "cat.empty": { uk: "У цій папці тестів немає", ru: "В этой папке тестов нет", en: "There are no tests in this folder" },
  "cat.emptySearch": { uk: "За запитом нічого не знайдено", ru: "По запросу ничего не найдено", en: "Nothing matches your search" },
  "cat.rowActions": { uk: "Дії з тестом", ru: "Действия с тестом", en: "Test actions" },
  "cat.move": { uk: "Перемістити в папку", ru: "Переместить в папку", en: "Move to folder" },
  "cat.rootOption": { uk: "Корінь каталогу", ru: "Корень каталога", en: "Catalog root" },
  "cat.moved": { uk: "Тест перенесено", ru: "Тест перенесён", en: "Test moved" },
  "cat.noGroupForFolder": {
    uk: "Тест поза групою методик у папку не кладеться: спочатку задайте групу в конструкторі",
    ru: "Тест вне группы методик в папку не кладётся: сначала задайте группу в конструкторе",
    en: "A test outside an instrument group cannot be placed in a folder: first set its group in the builder",
  },
  "cat.folderTitle": { uk: "Назва папки", ru: "Название папки", en: "Folder name" },
  "cat.folderDate": { uk: "Дата папки", ru: "Дата папки", en: "Folder date" },
  "cat.folderGroup": { uk: "Група методик", ru: "Группа методик", en: "Instrument group" },
  "cat.folderNeedsGroup": {
    uk: "Папка живе в групі методик, а вам не видно жодної",
    ru: "Папка живёт в группе методик, а вам не видна ни одна",
    en: "A folder belongs to an instrument group, but none are visible to you",
  },
  "cat.folderCreated": { uk: "Папку створено", ru: "Папка создана", en: "Folder created" },
  "cat.renameFolder": { uk: "Перейменувати папку", ru: "Переименовать папку", en: "Rename folder" },
  "cat.folderRenamed": { uk: "Папку змінено", ru: "Папка изменена", en: "Folder updated" },
  "cat.deleteFolder": { uk: "Видалити папку", ru: "Удалить папку", en: "Delete folder" },
  "cat.deleteFolderConfirm": {
    uk: "Видалити цю папку? Непорожню папку сервер не видалить",
    ru: "Удалить эту папку? Непустую папку сервер не удалит",
    en: "Delete this folder? The server will not delete a folder that is not empty",
  },
  "cat.folderDeleted": { uk: "Папку видалено", ru: "Папка удалена", en: "Folder deleted" },
  /* ── wave3:constructor ── */
  /*
   * Конструктор теста: вкладки f24/f23, аккордеон питань f12, карточка с
   * таблицей баллов f17/f18/f29/f37, шкала с расчётом балла f30. Слова —
   * с кадров («Відповідність», «розрахунок балу», «від … до»), русский —
   * перевод тех же слов, а не прежних подписей конструктора.
   */
  "cn.specific": { uk: "Конкретний тест", ru: "Конкретный тест", en: "Single test" },
  "cn.complex": { uk: "Комплексний тест", ru: "Комплексный тест", en: "Composite test" },
  "cn.testKind": { uk: "Вид тесту", ru: "Вид теста", en: "Test type" },
  "cn.newTest": { uk: "Новий тест", ru: "Новый тест", en: "New test" },
  "cn.testTitle": { uk: "Назва тесту", ru: "Название теста", en: "Test name" },
  "cn.testDescription": { uk: "Опис тесту", ru: "Описание теста", en: "Test description" },
  "cn.editLang": { uk: "Мова тексту тесту", ru: "Язык текста теста", en: "Test text language" },
  "cn.editLangHint": {
    uk: "Текст зберігається обома мовами: перемкніть мову, щоб заповнити другу",
    ru: "Текст хранится на обоих языках: переключите язык, чтобы заполнить второй",
    en: "The text is stored in both languages: switch the language to fill in the other one",
  },
  "cn.shortDescription": { uk: "короткий опис питання", ru: "краткое описание вопроса", en: "short question description" },
  "cn.questionText": { uk: "Текст питання", ru: "Текст вопроса", en: "Question text" },
  "cn.questionType": { uk: "Тип питання", ru: "Тип вопроса", en: "Question type" },
  "cn.expand": { uk: "Розгорнути питання", ru: "Развернуть вопрос", en: "Expand question" },
  "cn.collapse": { uk: "Згорнути питання", ru: "Свернуть вопрос", en: "Collapse question" },
  "cn.answers": { uk: "Відповіді", ru: "Ответы", en: "Answers" },
  "cn.answerText": { uk: "Текст відповіді", ru: "Текст ответа", en: "Answer text" },
  "cn.addAnswer": { uk: "Додати відповідь", ru: "Добавить ответ", en: "Add answer" },
  "cn.removeOption": { uk: "Прибрати відповідь", ru: "Убрать ответ", en: "Remove answer" },
  "cn.removeLastAnswer": { uk: "Прибрати останню відповідь", ru: "Убрать последний ответ", en: "Remove last answer" },
  "cn.answersHint": {
    uk: "Один набір відповідей на всі питання тесту; зміна поширюється на кожне",
    ru: "Один набор ответов на все вопросы теста; изменение распространяется на каждый",
    en: "One set of answers for all questions in the test; a change applies to every question",
  },
  "cn.answersDiffer": {
    uk: "питань мають власний набір відповідей — зміна набору перепише його",
    ru: "вопросов имеют собственный набор ответов — изменение набора перепишет его",
    en: "questions have their own answer set — changing the set will overwrite it",
  },
  "cn.scale": { uk: "Шкала", ru: "Шкала", en: "Scale" },
  "cn.noScales": { uk: "Шкал поки немає — «+» додасть першу", ru: "Шкал пока нет — «+» добавит первую", en: "No scales yet — “+” adds the first one" },
  "cn.scaleDescription": { uk: "Опис шкали", ru: "Описание шкалы", en: "Scale description" },
  "cn.matching": { uk: "Відповідність", ru: "Соответствие", en: "Mapping" },
  "cn.itemNumbers": { uk: "№Питання", ru: "№Вопроса", en: "Question No." },
  "cn.points": { uk: "Бали", ru: "Баллы", en: "Points" },
  "cn.addItem": { uk: "Додати номер питання", ru: "Добавить номер вопроса", en: "Add question number" },
  "cn.removeItem": { uk: "Прибрати питання", ru: "Убрать вопрос", en: "Remove question" },
  "cn.scoreByOption": { uk: "бал відповіді", ru: "балл ответа", en: "answer score" },
  "cn.danglingItem": { uk: "такого питання в тесті немає", ru: "такого вопроса в тесте нет", en: "there is no such question in the test" },
  "cn.formula": { uk: "розрахунок балу", ru: "расчёт балла", en: "score calculation" },
  "cn.formulaEmpty": { uk: "сума за таблицею балів", ru: "сумма по таблице баллов", en: "sum from the score table" },
  "cn.addTerm": { uk: "Додати поправку від іншої шкали", ru: "Добавить поправку от другой шкалы", en: "Add adjustment from another scale" },
  "cn.removeTerm": { uk: "Прибрати поправку", ru: "Убрать поправку", en: "Remove adjustment" },
  "cn.coefficient": { uk: "Коефіцієнт", ru: "Коэффициент", en: "Coefficient" },
  "cn.results": { uk: "Результати", ru: "Результаты", en: "Results" },
  "cn.resultText": { uk: "Текст результату", ru: "Текст результата", en: "Result text" },
  "cn.from": { uk: "від", ru: "от", en: "from" },
  "cn.to": { uk: "до", ru: "до", en: "to" },
  "cn.addBand": { uk: "Додати діапазон", ru: "Добавить диапазон", en: "Add range" },
  "cn.removeBand": { uk: "Прибрати діапазон", ru: "Убрать диапазон", en: "Remove range" },
  "cn.bandDetails": {
    uk: "Клінічні поля діапазонів: вираженість, оцінка, каскад, повтори, рекомендація",
    ru: "Клинические поля диапазонов: выраженность, оценка, каскад, повторы, рекомендация",
    en: "Clinical range fields: severity, assessment, cascade, repeats, recommendation",
  },
  "cn.recommendation": { uk: "Рекомендація", ru: "Рекомендация", en: "Recommendation" },
  "cn.psychometrics": { uk: "Психометрика шкали", ru: "Психометрика шкалы", en: "Scale psychometrics" },
  "cn.codeHint": {
    uk: "Латиницею; за кодом шкалу впізнають між версіями та в динаміці пацієнта",
    ru: "Латиницей; по коду шкалу узнают между версиями и в динамике пациента",
    en: "In Latin characters; the code identifies the scale across versions and in the patient's dynamics",
  },
  "cn.normsJsonHint": {
    uk: "Норми за статтю та таблиця стенів задаються в блоці «Тест як JSON»",
    ru: "Нормы по полу и таблица стенов задаются в блоке «Тест как JSON»",
    en: "Norms by sex and the sten table are set in the “Test as JSON” block",
  },
  "cn.deleteScale": { uk: "Видалити шкалу", ru: "Удалить шкалу", en: "Delete scale" },
  "cn.publish": { uk: "Опублікувати", ru: "Опубликовать", en: "Publish" },
  "cn.create": { uk: "Створити", ru: "Создать", en: "Create" },
  "cn.assignPatient": { uk: "Призначити пацієнту", ru: "Назначить пациенту", en: "Assign to patient" },
  "cn.settings": { uk: "Налаштування проходження", ru: "Настройки прохождения", en: "Completion settings" },
  "cn.jsonSection": { uk: "Тест як JSON", ru: "Тест как JSON", en: "Test as JSON" },
  "cn.reorderHint": {
    uk: "Таблиця балів посилається на номери питань: перестановка питань зсуває ключ",
    ru: "Таблица баллов ссылается на номера вопросов: перестановка вопросов сдвигает ключ",
    en: "The score table refers to question numbers: reordering questions shifts the scoring key",
  },
  /*
   * Второй значок кадра f17 — «призначити групі». Групповое назначение на
   * сервере есть (POST /api/patient-groups/:id/surveys), окно — прямо в
   * конструкторе. Число адресатов печатается после тире, а не внутри фразы:
   * так слово не требует склонения по числу.
   */
  "cn.assignGroup": { uk: "Призначити групі", ru: "Назначить группе", en: "Assign to group" },
  "cn.assignGroupHint": {
    uk: "Кожен учасник групи отримає окреме призначення зі своїм строком; склад групи береться на момент призначення",
    ru: "Каждый участник группы получит отдельное назначение со своим сроком; состав группы берётся на момент назначения",
    en: "Each group member will receive a separate assignment with its own deadline; group membership is taken as of the moment of assignment",
  },
  "cn.patientGroup": { uk: "Група пацієнтів", ru: "Группа пациентов", en: "Patient group" },
  "cn.groupCountHint": { uk: "У дужках — скільки учасників отримають методику", ru: "В скобках — сколько участников получат методику", en: "In parentheses — how many members will receive the instrument" },
  "cn.noPatientGroups": {
    uk: "Груп пацієнтів поки немає — їх збирають у розділі «Групи»",
    ru: "Групп пациентов пока нет — их собирают в разделе «Группы»",
    en: "No patient groups yet — they are created in the “Groups” section",
  },
  "cn.assignedToGroup": { uk: "Методику призначено групі", ru: "Методика назначена группе", en: "Instrument assigned to group" },
  "cn.recipients": { uk: "адресатів", ru: "адресатов", en: "recipients" },
  /* папка каталога принадлежит группе: смена группы выводит тест из папки */
  "cn.folderFollowsGroup": {
    uk: "Тест буде заведено в папці, з якої ви прийшли; інша група — інший каталог, і тест заведеться в його корені",
    ru: "Тест будет заведён в папке, из которой вы пришли; другая группа — другой каталог, и тест заведётся в его корне",
    en: "The test will be created in the folder you came from; a different group — a different catalog, and the test will be created in its root",
  },
  /* пример формата, а не текст: разделитель списка дней может зависеть от языка */
  "cn.repeatDaysExample": { uk: "7,30", ru: "7,30", en: "7,30" },
  /* ── wave3:view ── */
  /*
   * Экран «пройденный тест» (pages/response). Кадры f31 и f34 макета.
   *
   * Префикс «rsp.» (response), а не напрашивающийся «rv.» (response view):
   * «rv.» ниже уже занят раскрытием учётной записи под кодом (rv.title,
   * rv.why…), и два несвязанных экрана в одном пространстве имён — это
   * ut("rv.title") на экране просмотра, отдающий «Назвати ім’я». Проверка
   * «префикс = экран» в uiStrings.test.ts не заведена, так что сторожит
   * только этот комментарий.
   *
   * «Заключення», а не «висновок», как в остальном словаре (an.conclusion,
   * cn.title): это подпись кнопки с кадра f34, набранная словом заказчика.
   * Сторож одной формы (uiStrings.test.ts, ONE_FORM) эту пару не сторожит
   * намеренно — обе формы живут в украинском, и спор о них решает заказчик,
   * а не проверка. Если решит в пользу «висновку», правка — одна строка здесь.
   */
  "rsp.description": { uk: "Опис тесту", ru: "Описание теста", en: "Test description" },
  "rsp.questionN": { uk: "Питання №{n}", ru: "Вопрос №{n}", en: "Question No. {n}" },
  "rsp.results": { uk: "Результати", ru: "Результаты", en: "Results" },
  "rsp.createConclusion": { uk: "Створити заключення", ru: "Создать заключение", en: "Create conclusion" },
  /* диктору: заливка строки — единственный признак выбора на кадре, словом он не дублируется */
  "rsp.chosen": { uk: "обрано", ru: "выбрано", en: "selected" },
  "rsp.hitBand": { uk: "результат цього проходження", ru: "результат этого прохождения", en: "result of this completion" },
  /*
   * Две разные причины пустого списка баллов — две строки. У методики
   * выключен подсчёт — баллов не будет никогда; прохождение не сдано —
   * подсчёт включён, но response_scores заполняются только при сдаче
   * (apps/api/src/routes/responses.ts). Одна строка «не рахуються» во втором
   * случае врала бы: считаются, просто ещё нечего считать.
   */
  "rsp.scoresOff": {
    uk: "Бали за цим проходженням не рахуються",
    ru: "Баллы по этому прохождению не считаются",
    en: "Scores are not calculated for this completion",
  },
  "rsp.notSubmitted": {
    uk: "Проходження не здано: бали рахуються після здачі",
    ru: "Прохождение не сдано: баллы считаются после сдачи",
    en: "Completion not submitted: scores are calculated after submission",
  },
  /*
   * Баллы вариантов и границы диапазонов берутся из действующей версии
   * методики, а не из той, которую человек проходил: ту версию сервер отдельно
   * не отдаёт. Когда версии разошлись, показывать чужие числа нельзя — отсюда
   * строка-пояснение вместо цифр.
   */
  "rsp.staleVersion": {
    uk: "Методику змінено після цього проходження: бали варіантів і межі діапазонів тієї версії недоступні",
    ru: "Методика изменена после этого прохождения: баллы вариантов и границы диапазонов той версии недоступны",
    en: "The instrument was changed after this completion: option scores and range boundaries of that version are unavailable",
  },
  "rsp.openPage": { uk: "Відкрити сторінкою", ru: "Открыть страницей", en: "Open as page" },
  /* ── wave3:conclusion ── */
  /*
   * Экран «Заключення» (кадры макета f38/f39).
   *
   * Слово «заключення» здесь взято с макета заказчика, хотя словарь в
   * остальных местах говорит «висновок» (cn.*, cnc.*, sum.conclusions).
   * Это не недосмотр: экран делается по картинке один в один, и на нём стоит
   * то, что на картинке написано, — включая «примінених», как набрано у
   * заказчика. Выровнен только регистр: «Назва Заключення» и «Не Відповідає
   * умовам» на кадре — заглавная посреди фразы, описка набора, а не
   * написание. Свести всё к одному слову — решение заказчика, и стоит оно
   * правки словаря, а не экрана.
   */
  "cn3.title": { uk: "Заключення", ru: "Заключение", en: "Conclusion" },
  "cn3.name": { uk: "Назва Заключення", ru: "Название заключения", en: "Conclusion title" },
  "cn3.models": {
    uk: "Список примінених аналітичних моделей",
    ru: "Список применённых аналитических моделей",
    en: "Applied analytics models",
  },
  "cn3.modelsNone": {
    uk: "Для цього тесту аналітичних моделей немає",
    ru: "Для этого теста аналитических моделей нет",
    en: "There are no analytics models for this test",
  },
  /* перед текстом отказа сервера: тот говорит о правах и номере запроса, а не о том, чего не стало на экране */
  "cn3.modelsUnavailable": { uk: "Список моделей недоступний", ru: "Список моделей недоступен", en: "Model list unavailable" },
  "cn3.matched": { uk: "Відповідає умовам", ru: "Соответствует условиям", en: "Meets the conditions" },
  "cn3.notMatched": { uk: "Не Відповідає умовам", ru: "Не соответствует условиям", en: "Does not meet the conditions" },
  "cn3.tests": { uk: "Список тестів", ru: "Список тестов", en: "Test list" },
  "cn3.addTest": { uk: "Додати тест: призначити батарею", ru: "Добавить тест: назначить батарею", en: "Add test: assign a battery" },
  "cn3.scored": { uk: "набраний бал", ru: "набранный балл", en: "score obtained" },
  "cn3.question": { uk: "Питання №", ru: "Вопрос №", en: "Question No." },
  "cn3.results": { uk: "Результати", ru: "Результаты", en: "Results" },
  "cn3.from": { uk: "від", ru: "от", en: "from" },
  "cn3.to": { uk: "до", ru: "до", en: "to" },
  /* скрытые пометки для диктора: заливка и начертание ему не видны */
  "cn3.chosen": { uk: "обрана відповідь", ru: "выбранный ответ", en: "selected answer" },
  "cn3.hit": { uk: "результат пацієнта", ru: "результат пациента", en: "patient's result" },
  "cn3.verdicts": { uk: "Висновки заключення", ru: "Выводы заключения", en: "Conclusion findings" },
  "cn3.form": { uk: "Сформувати заключення", ru: "Сформировать заключение", en: "Generate conclusion" },
  "cn3.actions": { uk: "Дії із заключенням", ru: "Действия с заключением", en: "Conclusion actions" },
  "cn3.savePdf": { uk: "Зберегти як PDF", ru: "Сохранить как PDF", en: "Save as PDF" },
  "cn3.sendMail": { uk: "Відправити поштою", ru: "Отправить почтой", en: "Send by email" },
  "cn3.mailUnavailable": {
    uk: "Відправлення поштою не підключено: заключення з персональними даними не виходить за межі системи",
    ru: "Отправка почтой не подключена: заключение с персональными данными не выходит за пределы системы",
    en: "Sending by email is not connected: a conclusion containing personal data does not leave the system",
  },
  /* ── audit:tests ── */
  /*
   * Сверка раздела «Тести» с кадрами f11/f12/f17/f18/f23/f24/f29/f30/f31/
   * f34/f37/f38/f39. Здесь только то, чего на кадре словарь ещё не знал, и
   * подписи мест, куда ушло убранное с глаз.
   *
   * Украинские подписи набраны дословно с кадра, включая слитное «№Питання»
   * (f37_1) и «Розрахунок балу» с большой буквы в шапке таблицы (f37_2):
   * та же строчная форма у cn.formula — это подпись НАД полем формулы внутри
   * шкалы, а не колонка таблицы, и кадры их пишут по-разному.
   */
  "cn.scoreTable": { uk: "Таблиця балів", ru: "Таблица баллов", en: "Score table" },
  "cn.resultTable": { uk: "Таблиця результатів", ru: "Таблица результатов", en: "Result table" },
  "cn.resultName": { uk: "Назва результату", ru: "Название результата", en: "Result name" },
  "cn.scoreFormula": { uk: "Розрахунок балу", ru: "Расчёт балла", en: "Score calculation" },
  "cn.score": { uk: "Бал", ru: "Балл", en: "Score" },
  "cn.result": { uk: "Результат", ru: "Результат", en: "Result" },
  "cn.resultTableEmpty": {
    uk: "Рядок результату складається з поправок інших шкал: сервер ще не зберігає посилання на рядок чужої шкали",
    ru: "Строка результата складывается из поправок других шкал: сервер ещё не хранит ссылку на ряд чужой шкалы",
    en: "The result row is made up of adjustments from other scales: the server does not yet store a reference to another scale's row",
  },
  /*
   * Меню инструментов конструктора: на кадрах его нет, но и того, что в нём
   * лежит (проверка структуры, отмена, предпросмотр, настройки прохождения,
   * JSON), на кадрах нет тоже. Убранное с глаз собрано в одно место, а не
   * разбросано по экрану.
   */
  "cn.tools": { uk: "Інструменти конструктора", ru: "Инструменты конструктора", en: "Builder tools" },
  "cn.optionSettings": { uk: "Налаштування варіантів", ru: "Настройки вариантов", en: "Option settings" },
  "cn.backToCatalogue": { uk: "До тестів", ru: "К тестам", en: "Back to tests" },
  "cat.marks": { uk: "Позначки тесту", ru: "Пометки теста", en: "Test marks" },
  /*
   * Полные названия языков для раскрытого списка переключателя (кадры
   * f23_1/f24_1): на самой кнопке стоит короткое «Укр», а в списке кадр
   * печатает языки их собственными именами. Поэтому обе формы одинаковы
   * в uk и ru — «Українська» не переводится в «Украинский»: перевод назвал
   * бы язык словом того языка, из которого человек уходит.
   */
  "lang.uk": { uk: "Українська", ru: "Українська", en: "Українська" },
  "lang.ru": { uk: "Русский", ru: "Русский", en: "Русский" },
  /*
   * Полная форма английского — для списка языков интерфейса. В списке языка
   * ТЕКСТА теста её не будет: английского текста у методик нет (CONTENT_LANGS
   * в types.ts), и пункт, выбор которого ничего не меняет, был бы обманом.
   */
  "lang.en": { uk: "English", ru: "English", en: "English" },
  /*
   * Одна строка над методикой, когда интерфейс английский, а пункты — нет.
   *
   * Молчать нельзя: человек, выбравший английский, по-украински скорее всего
   * читает хуже — иначе не выбирал бы, — и без этой строки решит, что
   * перевод сломан. Объяснять больше одной строкой тоже не
   * нужно: почему у методик нет английского текста (нормы сняты с другого
   * текста), интересно специалисту, а не тому, кто проходит.
   *
   * Две записи по языку текста, а не одна «на украинском»: у методики,
   * заведённой строкой, украинского может не быть, и тогда пункты русские.
   * Украинский и русский варианты на экране не появляются (строка стоит
   * только при английском интерфейсе) — они здесь, потому что запись словаря
   * без них не собирается, и переведены честно, а не заглушкой.
   */
  "contentLang.uk": {
    uk: "Англійської версії цієї методики немає — питання показано українською.",
    ru: "Английской версии этой методики нет — вопросы показаны на украинском.",
    en: "This assessment has no English version, so its questions are shown in Ukrainian.",
  },
  "contentLang.ru": {
    uk: "Англійської версії цієї методики немає — питання показано російською.",
    ru: "Английской версии этой методики нет — вопросы показаны на русском.",
    en: "This assessment has no English version, so its questions are shown in Russian.",
  },
  /*
   * Полоса форматирования кадра f39_2. Нарисована целиком и выключена
   * целиком: conclusions.text хранится простым текстом (шифруется и уходит
   * в печатный отчёт как есть), и включённая разметка сломала бы обе дороги.
   * Подписи нужны диктору: на кадре кнопки набраны глифами «B», «I», «U».
   */
  "fmt.unavailable": {
    uk: "Форматування буде доступне, коли сервер оголосить формат зберігання тексту",
    ru: "Форматирование будет доступно, когда сервер объявит формат хранения текста",
    en: "Formatting will be available once the server declares the text storage format",
  },
  "fmt.paragraph": { uk: "Стиль абзацу", ru: "Стиль абзаца", en: "Paragraph style" },
  "fmt.font": { uk: "Гарнітура", ru: "Гарнитура", en: "Typeface" },
  "fmt.weight": { uk: "Накреслення", ru: "Начертание", en: "Font style" },
  "fmt.size": { uk: "Кегль", ru: "Кегль", en: "Font size" },
  "fmt.color": { uk: "Колір тексту", ru: "Цвет текста", en: "Text color" },
  "fmt.highlight": { uk: "Колір тла", ru: "Цвет фона", en: "Background color" },
  "fmt.bold": { uk: "Напівжирний", ru: "Полужирный", en: "Bold" },
  "fmt.italic": { uk: "Курсив", ru: "Курсив", en: "Italic" },
  "fmt.underline": { uk: "Підкреслений", ru: "Подчёркнутый", en: "Underline" },
  "fmt.alignLeft": { uk: "Вирівняти ліворуч", ru: "Выровнять слева", en: "Align left" },
  "fmt.alignCenter": { uk: "Вирівняти по центру", ru: "Выровнять по центру", en: "Align center" },
  "fmt.alignRight": { uk: "Вирівняти праворуч", ru: "Выровнять справа", en: "Align right" },
  "fmt.alignJustify": { uk: "Вирівняти по ширині", ru: "Выровнять по ширине", en: "Justify" },
  /*
   * Второй протокол кадров f38_2/f39_1 — наблюдение специалиста за пациентом
   * тем же бланком. Заключение на сервере привязано к ОДНОМУ прохождению
   * (conclusions.responseId), второго источника у него нет, поэтому блок
   * нарисован, как на кадре, и честно говорит, откуда он пуст.
   */
  "cn3.observation": { uk: "Опитувальник спостереження за пацієнтом", ru: "Опросник наблюдения за пациентом", en: "Patient observation questionnaire" },
  "cn3.observationNone": {
    uk: "Друге проходження до цього заключення не прив’язане: сервер тримає заключення на одному проходженні",
    ru: "Второе прохождение к этому заключению не привязано: сервер держит заключение на одном прохождении",
    en: "No second completion is linked to this conclusion: the server ties a conclusion to a single completion",
  },
  "top.more": { uk: "Ще розділи", ru: "Другие разделы", en: "More sections" },
  "nav.groups": { uk: "Групи", ru: "Группы", en: "Groups" },
  "nav.patients": { uk: "Пацієнти", ru: "Пациенты", en: "Patients" },
  "nav.cases": { uk: "Випадки ризику", ru: "Случаи риска", en: "Risk cases" },
  "nav.referrals": { uk: "Направлення", ru: "Направления", en: "Referrals" },
  "nav.admin": { uk: "Адміністрування", ru: "Администрирование", en: "Administration" },
  /* ── audit:analytics ── */
  /*
   * Сверка раздела «Аналітика» с кадрами f10 (перечень), f19
   * (конструктор с раскрытым меню шестерни) и f25 (тот же
   * конструктор с раскрытым списком тестов). Здесь только то, чего словарь
   * ещё не знал: два пункта меню шестерни с кадра и подписи тех мест, куда
   * ушло убранное с глаз.
   *
   * Прописные буквы во вторых словах пунктов («Додати Оператор») — так на
   * кадре f19, дословно; апостроф в «Об’єднати» — U+2019, как во всём словаре.
   */
  "am.addOperator": { uk: "Додати Оператор", ru: "Добавить Оператор", en: "Add operator" },
  "am.merge": { uk: "Об’єднати", ru: "Объединить", en: "Merge" },
  /*
   * Оба пункта нарисованы на кадре и потому стоят в меню, но сейчас недоступны:
   * правило поддержки решений соединяет условия только «и» (evaluateRules требует
   * every(met)), второго блока и оператора между блоками у него нет. Подсказка
   * говорит причину: пункт, который молча не срабатывает, читается как поломка.
   */
  "am.operatorOnlyAnd": {
    uk: "Умови правила поєднуються лише через «Разом з»: сервер ще не зберігає «Або» між блоками",
    ru: "Условия правила соединяются только через «Вместе с»: сервер ещё не хранит «Или» между блоками",
    en: "Rule conditions can only be combined with “Together with”: the server does not yet store “Or” between blocks",
  },
  "am.mergeUnavailable": {
    uk: "Об’єднувати нічого: сервер тримає умови правила одним блоком",
    ru: "Объединять нечего: сервер держит условия правила одним блоком",
    en: "Nothing to merge: the server keeps rule conditions in a single block",
  },
  /*
   * Окно свойств модели — единственная добавка к пяти пунктам меню с кадра.
   * За ней то, чего кадры раздела не рисуют вовсе, но без чего раздел не работает:
   * описание модели (его печатает перечень f10 второй колонкой) и выключатель
   * модели (выключенная не срабатывает на прохождениях, и без выключателя её
   * нельзя ни выключить, ни вернуть в работу).
   */
  "am.about": { uk: "Про модель", ru: "О модели", en: "About the model" },
  /* Раскрытый список тестов (f25) бывает и пуст: у сотрудника нет групп с методиками */
  "am.noTests": { uk: "Доступних тестів немає", ru: "Доступных тестов нет", en: "No tests available" },
  /* ─────────── кабинет пациента ─────────── */
  "pt.home": { uk: "Головна", ru: "Главная", en: "Home" },
  "pt.tests": { uk: "Тести", ru: "Тесты", en: "Tests" },
  "pt.booking": { uk: "Запис", ru: "Запись", en: "Booking" },
  "pt.me": { uk: "Я", ru: "Я", en: "Me" },
  /*
   * Заголовки экранов кабинета — отдельно от подписей вкладок.
   *
   * Под значком внизу помещается одно слово, и «Я» там читается вместе со
   * значком человека. Заголовком экрана «Я» не называет ничего, а диктор
   * произносит его первым и без значка.
   */
  "pt.titleHome": { uk: "Мій кабінет", ru: "Мой кабинет", en: "My portal" },
  "pt.titleTests": { uk: "Мої тести", ru: "Мои тесты", en: "My tests" },
  "pt.titleBooking": { uk: "Запис на прийом", ru: "Запись на приём", en: "Book an appointment" },
  "pt.titleProfile": { uk: "Мій профіль", ru: "Мой профиль", en: "My profile" },
  "pt.nextVisit": { uk: "Найближчий прийом", ru: "Ближайший приём", en: "Next appointment" },
  "pt.noVisit": { uk: "Прийомів не заплановано", ru: "Приёмов не запланировано", en: "No appointments scheduled" },
  "pt.bookNow": { uk: "Записатися на прийом", ru: "Записаться на приём", en: "Book an appointment" },
  "pt.confirm": { uk: "Підтвердити", ru: "Подтвердить", en: "Confirm" },
  "pt.cancel": { uk: "Скасувати", ru: "Отменить", en: "Cancel" },
  "pt.cancelled": { uk: "Прийом скасовано", ru: "Приём отменён", en: "Appointment cancelled" },
  "pt.confirmed": { uk: "Прийом підтверджено", ru: "Приём подтверждён", en: "Appointment confirmed" },
  "pt.room": { uk: "каб.", ru: "каб.", en: "rm." },
  "pt.remote": { uk: "дистанційно", ru: "дистанционно", en: "remote" },
  "pt.join": { uk: "Приєднатися", ru: "Присоединиться", en: "Join" },
  "pt.available": { uk: "Доступні методики", ru: "Доступные методики", en: "Available instruments" },
  "pt.noTests": { uk: "Поки нічого проходити", ru: "Пока нечего проходить", en: "Nothing to take yet" },
  "pt.start": { uk: "Пройти", ru: "Пройти", en: "Take" },
  "pt.pickSpecialist": { uk: "До кого", ru: "К кому", en: "Who to see" },
  "pt.pickTime": { uk: "Коли", ru: "Когда", en: "When" },
  "pt.noSlots": { uk: "Вільного часу поки немає", ru: "Свободного времени пока нет", en: "No free time slots yet" },
  "pt.reason": { uk: "З чим звертаєтеся", ru: "С чем обращаетесь", en: "Reason for your visit" },
  "pt.reasonHint": {
    uk: "Своїми словами й не обов’язково — але фахівцю це допоможе підготуватися",
    ru: "Своими словами и необязательно — но специалисту это поможет подготовиться",
    en: "In your own words and optional — but it will help the specialist prepare",
  },
  "pt.booked": { uk: "Вас записано", ru: "Вы записаны", en: "You are booked" },
  "pt.anySpecialist": { uk: "будь-хто вільний", ru: "любой свободный", en: "anyone available" },

  /* прохождение методики */
  /* ─────────── учётная запись сотрудника ─────────── */
  "acct.title": { uk: "Обліковий запис", ru: "Учётная запись", en: "Account" },
  "acct.sub": { uk: "Ваші дані, спосіб входу та вигляд застосунку", ru: "Ваши данные, способ входа и вид приложения", en: "Your details, sign-in method and app appearance" },
  "acct.data": { uk: "Дані про себе", ru: "Данные о себе", en: "About you" },
  "acct.password": { uk: "Пароль", ru: "Пароль", en: "Password" },
  "acct.currentPassword": { uk: "Поточний пароль", ru: "Текущий пароль", en: "Current password" },
  "acct.newPassword": { uk: "Новий пароль", ru: "Новый пароль", en: "New password" },
  "acct.changePassword": { uk: "Змінити пароль", ru: "Сменить пароль", en: "Change password" },
  "acct.passwordChanged": { uk: "Пароль змінено", ru: "Пароль изменён", en: "Password changed" },
  "acct.appearance": { uk: "Вигляд", ru: "Внешний вид", en: "Appearance" },
  "acct.density": { uk: "Щільність", ru: "Плотность", en: "Density" },
  "acct.densityCozy": { uk: "Просторо", ru: "Просторно", en: "Comfortable" },
  "acct.densityCompact": { uk: "Щільно", ru: "Плотно", en: "Compact" },
  "acct.motion": { uk: "Рух", ru: "Движение", en: "Motion" },
  "acct.motionSystem": { uk: "Як у системі", ru: "Как в системе", en: "Same as system" },
  "acct.motionReduced": { uk: "Менше руху", ru: "Меньше движения", en: "Reduced motion" },
  "acct.startScreen": { uk: "Стартовий екран", ru: "Стартовый экран", en: "Start screen" },
  "acct.saved": { uk: "Збережено", ru: "Сохранено", en: "Saved" },
  "acct.rail": { uk: "Розділи в бічному меню", ru: "Разделы в боковом меню", en: "Sidebar sections" },
  "acct.railHint": {
    uk: "Прибрані розділи не зникають: вони відкриваються з пошуку команд (Ctrl+K) і за посиланням.",
    ru: "Убранные разделы не исчезают: они открываются из поиска команд (Ctrl+K) и по ссылке.",
    en: "Hidden sections do not disappear: they open from the command search (Ctrl+K) and via a link.",
  },
  "acct.railPinned": {
    uk: "Поруч стоїть число нерозібраного — цей розділ прибрати не можна",
    ru: "Рядом стоит число неразобранного — этот раздел убрать нельзя",
    en: "A count of unresolved items is shown next to it — this section cannot be hidden",
  },
  "acct.deleteTitle": { uk: "Видалення облікового запису", ru: "Удаление учётной записи", en: "Deleting the account" },
  "acct.deleteWhy": {
    uk: "Обліковий запис співробітника видаляє адміністратор, і це не формальність: за вашими записами закріплені підписані висновки та протоколи прийомів, і вони мають лишитися за автором. Звертайтеся до адміністратора.",
    ru: "Учётную запись сотрудника удаляет администратор, и это не формальность: за вашими записями закреплены подписанные заключения и протоколы приёмов, и они должны остаться за автором. Обратитесь к администратору.",
    en: "A staff account is deleted by an administrator, and this is not a formality: signed findings and appointment records are tied to your account, and they must stay attributed to their author. Contact your administrator.",
  },
  "pt.passed": { uk: "пройдено", ru: "пройдено", en: "completed" },
  "pt.assigned": { uk: "призначено", ru: "назначено", en: "assigned" },
  "pt.myData": { uk: "Мої дані", ru: "Мои данные", en: "My details" },
  "pt.google": { uk: "Вхід через Google", ru: "Вход через Google", en: "Sign in with Google" },
  "pt.googleLink": { uk: "Прив’язати", ru: "Привязать", en: "Link" },
  "pt.googleUnlink": { uk: "Відв’язати", ru: "Отвязать", en: "Unlink" },
  "pt.googleLinked": { uk: "прив’язано", ru: "привязано", en: "linked" },
  "pt.appearance": { uk: "Вигляд", ru: "Внешний вид", en: "Appearance" },
  "pt.language": { uk: "Мова", ru: "Язык", en: "Language" },
  "pt.theme": { uk: "Тема", ru: "Тема", en: "Theme" },
  "pt.saved": { uk: "Збережено", ru: "Сохранено", en: "Saved" },
  "pw.thanks": { uk: "Дякуємо", ru: "Спасибо", en: "Thank you" },
  "pw.handed": {
    uk: "Ми передали ваші відповіді фахівцю. Бали тлумачить він — саме тому ми їх тут не показуємо.",
    ru: "Мы передали ваши ответы специалисту. Баллы истолкует он — именно поэтому мы их здесь не показываем.",
    en: "We have passed your answers to the specialist. The specialist interprets the scores — that is why we do not show them here.",
  },
  "pw.leave": { uk: "Вийти з методики", ru: "Выйти из методики", en: "Leave the instrument" },
  /*
   * Подпись полосы прогресса — только для диктора.
   *
   * Зрячему число впереди («вопрос 7 из 20») пугает, поэтому на экране его
   * нет и не будет. Но диктор полосу не видит вовсе: без подписи и
   * aria-valuetext человек отвечает на сорок пять пунктов, не зная, идёт он
   * к концу или стоит на месте.
   */
  "pw.progress": { uk: "Хід проходження", ru: "Ход прохождения", en: "Progress" },
  "pw.backToTests": { uk: "До списку методик", ru: "К списку методик", en: "Back to instruments" },
  "pw.empty": { uk: "У методиці немає питань", ru: "В методике нет вопросов", en: "The instrument has no questions" },
  "pw.finish": { uk: "Завершити", ru: "Завершить", en: "Finish" },
  "pw.sent": { uk: "Відповіді відправлено", ru: "Ответы отправлены", en: "Answers sent" },

  "nav.console": { uk: "Консоль", ru: "Консоль", en: "Console" },
  /* вкладки карты пациента: «що зараз», «як змінювалося», «що відбувалося» */
  "pc.overview": { uk: "Огляд", ru: "Обзор", en: "Summary" },
  /* короткая подпись вкладки: «Динаміка пацієнта» на вкладке карты этого же
     пациента дважды называет, чью динамику показывает */
  "pc.dynamics": { uk: "Динаміка", ru: "Динамика", en: "Dynamics" },
  "con.sub": {
    uk: "Виконуються лише заведені команди; право перевіряється на кожну окремо",
    ru: "Выполняются только заведённые команды; право проверяется на каждую отдельно",
    en: "Only registered commands are executed; permission is checked for each one separately",
  },
  "con.input": { uk: "Рядок команди", ru: "Строка команды", en: "Command line" },
  "con.hello": {
    uk: "Командна консоль. Це не оболонка: виконуються лише заведені команди.",
    ru: "Командная консоль. Это не оболочка: выполняются только заведённые команды.",
    en: "Command console. This is not a shell: only registered commands are executed.",
  },
  "con.hint": {
    uk: "Наберіть help, щоб побачити список. Tab доповнює, ↑ і ↓ гортають історію.",
    ru: "Наберите help, чтобы увидеть список. Tab дополняет, ↑ и ↓ листают историю.",
    en: "Type help to see the list. Tab completes, ↑ and ↓ scroll through history.",
  },
  "nav.logout": { uk: "Вийти", ru: "Выйти", en: "Sign out" },
  "nav.themeLight": { uk: "Світла тема", ru: "Светлая тема", en: "Light theme" },
  "nav.themeDark": { uk: "Темна тема", ru: "Тёмная тема", en: "Dark theme" },
  "nav.roleSuper": { uk: "Суперадміністратор", ru: "Суперадминистратор", en: "Superadministrator" },
  "nav.roleAdmin": { uk: "Адміністратор групи", ru: "Администратор группы", en: "Group administrator" },
  "nav.readOnly": { uk: "Режим перегляду · зміни вимкнено", ru: "Режим просмотра · изменения отключены", en: "Read-only mode · changes disabled" },

  /* ─────────── консоль: общее ─────────── */
  "ui.search": { uk: "Пошук", ru: "Поиск", en: "Search" },
  "ui.loadMore": { uk: "Показати ще", ru: "Показать ещё", en: "Show more" },
  "ui.loading": { uk: "Завантажую…", ru: "Загружаю…", en: "Loading…" },
  "ui.endOfList": { uk: "Більше записів немає", ru: "Больше записей нет", en: "No more records" },
  "ui.cancel": { uk: "Скасувати", ru: "Отмена", en: "Cancel" },
  "ui.close": { uk: "Закрити", ru: "Закрыть", en: "Close" },
  "ui.save": { uk: "Зберегти", ru: "Сохранить", en: "Save" },
  "ui.surname": { uk: "Прізвище", ru: "Фамилия", en: "Last name" },
  "ui.unitAll": { uk: "Усі підрозділи", ru: "Все подразделения", en: "All units" },
  "ui.unit": { uk: "Підрозділ", ru: "Подразделение", en: "Unit" },

  /* ─────────── консоль: сводка ─────────── */
  "dash.title": { uk: "Зведення", ru: "Сводка", en: "Overview" },
  "dash.casesOpen": { uk: "Випадків на розбір", ru: "Случаев на разбор", en: "Cases to review" },
  "dash.casesOldest": { uk: "найдовший чекає {n} дн.", ru: "самый давний ждёт {n} дн.", en: "oldest waiting {n} days" },
  "dash.casesUrgent": { uk: "з них термінових: {n}", ru: "из них срочных: {n}", en: "of which urgent: {n}" },
  "dash.review": { uk: "Розібрати", ru: "Разобрать", en: "Review" },
  "dash.responses": { uk: "Проходжень", ru: "Прохождений", en: "Completions" },
  "dash.respondents": { uk: "Респондентів", ru: "Респондентов", en: "Respondents" },
  "dash.surveys": { uk: "Методик", ru: "Методик", en: "Instruments" },
  "dash.published": { uk: "опубліковано", ru: "опубликовано", en: "published" },
  "dash.completion": { uk: "доходимість", ru: "доходимость", en: "completion rate" },
  "dash.avgTime": { uk: "Середній час", ru: "Среднее время", en: "Average time" },
  "dash.inProgress": { uk: "Проходять зараз", ru: "Проходят сейчас", en: "In progress now" },

  /* ─────────── консоль: случаи риска ─────────── */
  "cases.title": { uk: "Розбір випадків", ru: "Разбор случаев", en: "Case review" },
  "cases.pickOne": { uk: "Оберіть випадок зі списку", ru: "Выберите случай из списка", en: "Select a case from the list" },
  "cases.pickOneHint": { uk: "Ліворуч — черга; праворуч відкриється розбір", ru: "Слева — очередь; справа откроется разбор", en: "Queue on the left; the review opens on the right" },
  "cases.openCount": { uk: "Відкритих", ru: "Открытых", en: "Open" },
  "cases.allSub": { uk: "Усі випадки, зокрема розібрані", ru: "Все случаи, включая разобранные", en: "All cases, including reviewed ones" },
  "cases.overdue": { uk: "прострочено", ru: "просрочено", en: "overdue" },
  "cases.mine": { uk: "на мені", ru: "на мне", en: "mine" },
  "cases.filterOpen": { uk: "Відкриті", ru: "Открытые", en: "Open" },
  "cases.filterAll": { uk: "Усі", ru: "Все", en: "All" },
  "cases.anySeverity": { uk: "Будь-яка терміновість", ru: "Любая срочность", en: "Any urgency" },
  "cases.severeOnly": { uk: "Лише важкі", ru: "Только тяжёлые", en: "Severe only" },
  "cases.moderate": { uk: "Помірні", ru: "Умеренные", en: "Moderate" },
  "cases.assignedAny": { uk: "Усі", ru: "Все", en: "All" },
  "cases.assignedMe": { uk: "На мені", ru: "На мне", en: "Mine" },
  "cases.assignedNone": { uk: "Ніким не взяті", ru: "Никем не взяты", en: "Unassigned" },
  "cases.take": { uk: "Взяти на себе", ru: "Взять на себя", en: "Take on" },
  "cases.release": { uk: "Відпустити", ru: "Отпустить", en: "Release" },
  "cases.taken": { uk: "взяв", ru: "взял", en: "taken by" },
  "cases.signals": { uk: "сигналів", ru: "сигналов", en: "signals" },
  "cases.showSignals": { uk: "Показати сигнали", ru: "Показать сигналы", en: "Show signals" },
  "cases.hideSignals": { uk: "Згорнути сигнали", ru: "Свернуть сигналы", en: "Hide signals" },
  "cases.openedAgo": { uk: "відкритий", ru: "открыт", en: "opened" },
  "cases.ago": { uk: "тому", ru: "назад", en: "ago" },
  "cases.whatDone": { uk: "Що вжито", ru: "Что предпринято", en: "Action taken" },
  "cases.confirmed": { uk: "Ризик підтверджено", ru: "Риск подтверждён", en: "Risk confirmed" },
  "cases.needsFollowup": { uk: "Потребує спостереження", ru: "Требует наблюдения", en: "Needs monitoring" },
  "cases.notConfirmed": { uk: "Не підтверджено", ru: "Не подтверждён", en: "Not confirmed" },
  "cases.emptyOpen": { uk: "Відкритих випадків немає", ru: "Открытых случаев нет", en: "No open cases" },
  "cases.emptyAll": { uk: "Випадків немає", ru: "Случаев нет", en: "No cases" },
  "cases.emptyHint": {
    uk: "Випадок заводиться, коли обстежуваний позначає критичний пункт",
    ru: "Случай заводится, когда обследуемый отмечает критический пункт",
    en: "A case is opened when a respondent marks a critical item",
  },
  "cases.takenByOther": {
    uk: "Випадок узяв інший фахівець. Розбирати одну людину вдвох не потрібно.",
    ru: "Случай взял другой специалист. Разбирать одного человека вдвоём не нужно.",
    en: "Another specialist has taken this case. There is no need for two people to review the same person.",
  },
  "cases.mergedNote": {
    uk: "випадок зібрано автоматично під час переходу на нову модель",
    ru: "случай собран автоматически при переходе на новую модель",
    en: "case assembled automatically during the migration to the new model",
  },

  /* ─────────── консоль: очередь работы ─────────── */
  "work.title": { uk: "Черга роботи", ru: "Очередь работы", en: "Worklist" },
  "work.nothing": { uk: "Нічого не чекає", ru: "Ничего не ждёт", en: "Nothing pending" },
  "work.onReview": { uk: "на розбір", ru: "на разбор", en: "for review" },
  "work.all": { uk: "Усе", ru: "Всё", en: "All" },
  "work.kindReferral": { uk: "направлення", ru: "направление", en: "referral" },
  "ms.savedHere": { uk: "збережено на телефоні", ru: "сохранено на телефоне", en: "saved on the phone" },
  "ms.savedHereOnly": { uk: "Відповіді збережено на телефоні, але ще не відправлені", ru: "Ответы сохранены на телефоне, но ещё не отправлены", en: "Answers are saved on the phone but not sent yet" },
  "co.previewEmpty": { uk: "Додайте перший пункт — тут з’явиться його вигляд", ru: "Добавьте первый пункт — здесь появится его вид", en: "Add the first item — its preview will appear here" },
  "co.previewNoText": { uk: "без формулювання", ru: "без формулировки", en: "no wording" },
  "co.previewNoOptions": { uk: "варіантів немає", ru: "вариантов нет", en: "no options" },
  "co.previewHint": { uk: "Так пункт побачить людина. Ключі та бали не показані — їх вона не бачить", ru: "Так пункт увидит человек. Ключи и баллы не показаны — их он не видит", en: "This is how the person will see the item. Scoring keys and scores are not shown — the person does not see them" },
  "co.keyCheck": { uk: "Перевірка ключа", ru: "Проверка ключа", en: "Scoring key check" },
  "co.keyHint": { uk: "оберіть відповіді — бали рахує той самий рушій, що й сервер", ru: "выберите ответы — баллы считает тот же движок, что и сервер", en: "choose answers — scores are calculated by the same engine as on the server" },
  "co.keyReset": { uk: "Скинути", ru: "Сбросить", en: "Reset" },
  "co.keyNoScales": { uk: "Шкал поки немає — нема чого рахувати", ru: "Шкал пока нет — считать нечего", en: "No scales yet — nothing to calculate" },
  "co.preview": { uk: "Перегляд", ru: "Предпросмотр", en: "Preview" },
  "cb.informantAdmin": { uk: "людина збоку: командир, близький, лікар", ru: "человек со стороны: командир, близкий, врач", en: "an outside observer: commander, relative, clinician" },
  "rounds.fillingFor": { uk: "Заповнюєте за пацієнта:", ru: "Заполняете за пациента:", en: "Filling in for the patient:" },
  "rounds.noDraft": { uk: "Чернетка не зберігається — пройдіть до кінця за один раз", ru: "Черновик не сохраняется — пройдите до конца за один раз", en: "No draft is saved — complete it in one go" },
  "runner.missed": { uk: "пропущено", ru: "пропущено", en: "skipped" },
  "runner.missedGoTo": { uk: "Перейти до першого пропущеного пункту", ru: "Перейти к первому пропущенному пункту", en: "Go to the first skipped item" },
  "mp.themeNight": { uk: "Нічна", ru: "Ночная", en: "Night" },
  "mp.themeNightHint": { uk: "Для обстеження в казармі після відбою: тепла палітра без синього, екран не будить сусідів", ru: "Для обследования в казарме после отбоя: тёплая палитра без синего, экран не будит соседей", en: "For assessments in barracks after lights-out: a warm palette without blue, the screen won't wake anyone nearby" },
  "ec.missed": { uk: "Поки вас не було", ru: "Пока вас не было", en: "While you were away" },
  "ec.since": { uk: "з", ru: "с", en: "since" },
  "ec.nothing": { uk: "Нічого нового", ru: "Ничего нового", en: "Nothing new" },
  "ec.markRead": { uk: "Прочитано", ru: "Прочитано", en: "Mark as read" },
  "ec.caseOpened": { uk: "Нові випадки ризику", ru: "Новые случаи риска", en: "New risk cases" },
  "ec.caseResolved": { uk: "Розібрали колеги", ru: "Разобрали коллеги", en: "Reviewed by colleagues" },
  "ec.referralCreated": { uk: "Нові направлення", ru: "Новые направления", en: "New referrals" },
  "ec.scheduleRun": { uk: "Спрацювали розклади", ru: "Сработали расписания", en: "Schedules triggered" },
  "ec.live": { uk: "Зараз у стрічці", ru: "Сейчас в ленте", en: "In the feed now" },
  "qh.title": { uk: "Карта пунктів", ru: "Карта пунктов", en: "Item map" },
  "qh.empty": { uk: "Проходжень поки немає", ru: "Прохождений пока нет", en: "No completions yet" },
  "qh.hint": { uk: "Рядок — проходження, стовпець — пункт. Позначки не вирок: швидко відповідають і на очевидний пункт, а серія буває й у того, у кого справді все «ні»", ru: "Строка — прохождение, столбец — пункт. Метки не приговор: быстро отвечают и на очевидный пункт, а серия бывает и у того, у кого действительно всё «нет»", en: "Row — completion, column — item. Marks are not a verdict: people answer an obvious item quickly too, and a run can also occur in someone whose answers really are all “no”" },
  "qh.fast": { uk: "швидше медіани пункту", ru: "быстрее медианы пункта", en: "faster than the item median" },
  "qh.run": { uk: "серія однакових", ru: "серия одинаковых", en: "run of identical answers" },
  "qh.both": { uk: "і те, і те", ru: "и то, и то", en: "both" },
  "qh.missing": { uk: "без відповіді", ru: "без ответа", en: "no answer" },
  "qh.sortByMarks": { uk: "Спершу з позначками", ru: "Сначала с метками", en: "Marked first" },
  "qh.fastRule": { uk: "поріг швидкості:", ru: "порог быстроты:", en: "speed threshold:" },
  "qh.runRule": { uk: "довжина серії:", ru: "длина серии:", en: "run length:" },
  "qh.item": { uk: "пункт", ru: "пункт", en: "item" },
  "qh.runOf": { uk: "серія з", ru: "серия из", en: "run of" },
  "rep.purpose": { uk: "Мета вивантаження", ru: "Цель выгрузки", en: "Export purpose" },
  "rep.purposePlaceholder": { uk: "Дисертація, звіт, перевірка", ru: "Диссертация, отчёт, проверка", en: "Dissertation, report, audit" },
  "rep.manifest": { uk: "Маніфест", ru: "Манифест", en: "Manifest" },
  "rep.manifestHint": { uk: "Знімок параметрів: версії методики, норми, профіль знеособлення. Без нього вивантаження не повторити.", ru: "Снимок параметров: версии методики, нормы, профиль обезличивания. Без него выгрузку не повторить.", en: "A snapshot of parameters: instrument versions, norms, de-identification profile. Without it the export cannot be reproduced." },
  "rep.manifestDone": { uk: "Маніфест вивантажено", ru: "Манифест выгружен", en: "Manifest exported" },
  "rep.scriptDone": { uk: "Скрипт завантаження вивантажено", ru: "Скрипт загрузки выгружен", en: "Loading script exported" },
  "eq.title": { uk: "Звести версії", ru: "Свести версии", en: "Equate versions" },
  "eq.hint": { uk: "Бали різних версій формально незрівнянні. Зведення переводить старі в шкалу останньої за середнім і розкидом вибірок — і припускає, що вибірки версій зіставні. Якщо разом із версією змінився контингент, різниця між групами піде в коефіцієнти.", ru: "Баллы разных версий формально несравнимы. Сведение переводит старые в шкалу последней по среднему и разбросу выборок — и предполагает, что выборки версий сопоставимы. Если вместе с версией сменился контингент, разница между группами уйдёт в коэффициенты.", en: "Scores from different versions are formally not comparable. Equating converts older versions to the scale of the latest one using the sample means and spreads — and assumes that the version samples are comparable. If the population changed along with the version, the difference between the groups will end up in the coefficients." },
  "srch.title": { uk: "Пошук по записах", ru: "Поиск по записям", en: "Search records" },
  "srch.sub": { uk: "записи зашифровані, тому шукаються не самі слова, а їх відбитки — знайдене розшифровується вже після відбору", ru: "записи зашифрованы, поэтому ищутся не сами слова, а их отпечатки — найденное расшифровывается уже после отбора", en: "records are encrypted, so the search matches not the words themselves but their fingerprints — matches are decrypted only after selection" },
  "srch.placeholder": { uk: "Слово або кілька: усі мають зустрітися", ru: "Слово или несколько: все должны встретиться", en: "One or more words: all must be present" },
  "srch.go": { uk: "Знайти", ru: "Найти", en: "Find" },
  "srch.nothing": { uk: "Нічого не знайдено", ru: "Ничего не найдено", en: "Nothing found" },
  "srch.found": { uk: "Знайдено записів", ru: "Найдено записей", en: "Records found" },
  "srch.morphNote": { uk: "Морфології немає: слово обрізається до основи, тому «тривожність» і «тривожності» — те саме, а «тривога» — вже інше", ru: "Морфологии нет: слово обрезается до основы, поэтому «тревожность» и «тревожности» — одно, а «тревога» — уже другое", en: "No morphology: a word is cut down to its stem, so “anxiety” and “anxieties” are the same, while “anxious” is already different" },
  "coh.title": { uk: "Добір людей", ru: "Подбор людей", en: "People finder" },
  "coh.size": { uk: "У вибірці", ru: "В выборке", en: "In sample" },
  "coh.tooSmall": { uk: "Вибірка надто мала, щоб назвати число", ru: "Выборка слишком мала, чтобы назвать число", en: "The sample is too small to show a number" },
  "coh.noBreakdown": { uk: "Розбивки не показуються: у малій вибірці вони вказують на конкретних людей", ru: "Разбивки не показываются: в малой выборке они указывают на конкретных людей", en: "Breakdowns are not shown: in a small sample they point to specific people" },
  "coh.anySex": { uk: "будь-яка стать", ru: "любой пол", en: "any sex" },
  "coh.anySurvey": { uk: "будь-яка методика", ru: "любая методика", en: "any instrument" },
  "coh.ageTo": { uk: "до", ru: "до", en: "to" },
  "coh.repeated": { uk: "лише з повторним заміром", ru: "только с повторным замером", en: "only with a repeat measurement" },
  "coh.risk": { uk: "лише з тривогою ризику", ru: "только с тревогой риска", en: "only with a risk alert" },
  "coh.byUnit": { uk: "За підрозділами", ru: "По подразделениям", en: "By unit" },
  "coh.bySex": { uk: "За статтю", ru: "По полу", en: "By sex" },
  "coh.bySeverity": { uk: "За вираженістю", ru: "По выраженности", en: "By severity" },
  "coh.showNames": { uk: "Показати поіменно", ru: "Показать поимённо", en: "Show names" },
  "coh.namesWarn": { uk: "Перегляд поіменно фіксується в журналі окремо від перегляду розподілів", ru: "Просмотр поимённо фиксируется в журнале отдельно от просмотра распределений", en: "Viewing by name is recorded in the audit log separately from viewing distributions" },
  "coh.save": { uk: "Зберегти вибірку", ru: "Сохранить выборку", en: "Save sample" },
  "coh.saved": { uk: "Збережені", ru: "Сохранённые", en: "Saved" },
  "coh.noneSaved": { uk: "Збережених вибірок поки немає", ru: "Сохранённых выборок пока нет", en: "No saved samples yet" },
  "coh.savedHint": { uk: "зберігається правило відбору, а не список людей", ru: "сохраняется правило отбора, а не список людей", en: "the selection rule is saved, not the list of people" },
  "coh.name": { uk: "Назва вибірки", ru: "Название выборки", en: "Sample name" },
  "coh.addCond": { uk: "Додати умову", ru: "Добавить условие", en: "Add condition" },
  "hint.gotIt": { uk: "Зрозуміло", ru: "Понятно", en: "Got it" },
  "hint.stens": { uk: "Стен — це бал за десятибальною шкалою з середнім 5,5. «Високий стен» означає «вище, ніж у більшості вибірки», а не «погано»: що саме означає високий бал, залежить від шкали.", ru: "Стен — это балл по десятибалльной шкале со средним 5,5. «Высокий стен» означает «выше, чем у большинства выборки», а не «плохо»: что именно значит высокий балл, зависит от шкалы.", en: "A sten is a score on a ten-point scale with a mean of 5.5. A “high sten” means “higher than most of the sample”, not “bad”: what a high score actually means depends on the scale." },
  "hint.caseStatus": { uk: "«Підтверджено» означає, що ризик є і з ним працюють. «Потребує спостереження» — ризик не знято, але дій зараз не потрібно. «Без результату» — не вдалося зв’язатися або людина вибула; це теж результат розбору, а не порожнє поле.", ru: "«Подтверждён» означает, что риск есть и с ним работают. «Требует наблюдения» — риск не снят, но действий сейчас не нужно. «Без исхода» — не удалось связаться или человек выбыл; это тоже результат разбора, а не пустое поле.", en: "“Confirmed” means the risk is present and is being worked on. “Needs monitoring” — the risk has not been ruled out, but no action is needed right now. “No outcome” — contact could not be made or the person has left; this is also a result of the review, not an empty field." },
  "hint.rci": { uk: "Достовірність зміни відповідає на питання «це справжня зміна чи шум вимірювання». Різниця в кілька балів між замірами може повністю вкладатися в похибку методики — тоді говорити про поліпшення зарано.", ru: "Достоверность изменения отвечает на вопрос «это настоящее изменение или шум измерения». Разница в несколько баллов между замерами может целиком укладываться в ошибку методики — тогда говорить об улучшении рано.", en: "Reliable change answers the question “is this a real change or measurement noise”. A difference of a few points between measurements may fall entirely within the instrument's measurement error — then it is too early to speak of improvement." },
  "dev.title": { uk: "Пристрої", ru: "Устройства", en: "Devices" },
  "dev.none": { uk: "Пристроїв не зареєстровано", ru: "Устройств не зарегистрировано", en: "No devices registered" },
  "dev.device": { uk: "Пристрій", ru: "Устройство", en: "Device" },
  "dev.lastSeen": { uk: "Був на зв’язку", ru: "Был на связи", en: "Last online" },
  "dev.state": { uk: "Стан", ru: "Состояние", en: "Status" },
  "dev.active": { uk: "працює", ru: "работает", en: "active" },
  "dev.waiting": { uk: "чекає зв’язку", ru: "ждёт связи", en: "waiting for connection" },
  "dev.wiped": { uk: "стерто", ru: "стёрто", en: "wiped" },
  "dev.wipe": { uk: "Стерти дані", ru: "Стереть данные", en: "Wipe data" },
  "dev.wipeHint": { uk: "Дані зітруться, коли пристрій наступного разу вийде на зв’язок. Пристрій, який більше не увімкнуть, цією командою не очистити. Черга нездаваних проходжень теж зітреться.", ru: "Данные сотрутся, когда устройство в следующий раз выйдет на связь. Устройство, которое больше не включат, этой командой не очистить. Очередь несданных прохождений тоже сотрётся.", en: "The data will be wiped the next time the device comes online. A device that is never switched on again cannot be wiped with this command. The queue of unsubmitted completions will be wiped too." },
  "dev.requested": { uk: "Стирання замовлено", ru: "Стирание заказано", en: "Wipe requested" },
  "rounds.title": { uk: "Обхід", ru: "Обход", en: "Rounds" },
  "rounds.sub": { uk: "що від вас чекають сьогодні, по палатах", ru: "что от вас ждут сегодня, по палатам", en: "what is expected of you today, by ward" },
  "rounds.offline": { uk: "Мережі немає, список від", ru: "Сети нет, список от", en: "No network, list as of" },
  "rounds.noUnit": { uk: "Без підрозділу", ru: "Без подразделения", en: "No unit" },
  "rounds.overdue": { uk: "прострочено днів:", ru: "просрочено дней:", en: "days overdue:" },
  "rounds.empty": { uk: "На сьогодні порожньо", ru: "На сегодня пусто", en: "Nothing for today" },
  "rounds.emptyHint": { uk: "Нових випадків і прострочень немає", ru: "Новых случаев и просрочек нет", en: "No new cases or overdue items" },
  "rounds.hint": { uk: "Натисніть на людину — картка відкриється навіть без мережі, якщо ви її вже дивилися", ru: "Нажмите на человека — карта откроется даже без сети, если вы её уже смотрели", en: "Tap a person — the card opens even without a network if you have viewed it before" },
  "rounds.loadFailed": { uk: "Не вдалося завантажити обхід", ru: "Не удалось загрузить обход", en: "Could not load rounds" },
  "rounds.cardOffline": { uk: "Картка з пам’яті пристрою, знято", ru: "Карта из памяти устройства, снята", en: "Card from device memory, saved" },
  "rounds.fill": { uk: "Заповнити за пацієнта", ru: "Заполнить за пациента", en: "Fill in for the patient" },
  "rounds.noData": { uk: "Замірів поки немає", ru: "Замеров пока нет", en: "No measurements yet" },
  "inf.revoked": { uk: "відкликано", ru: "отозвано", en: "revoked" },
  "tbl.columns": { uk: "Колонки", ru: "Колонки", en: "Columns" },
  "tbl.resetFacets": { uk: "Скинути фільтри", ru: "Сбросить фильтры", en: "Reset filters" },
  "ds.title": { uk: "Пропозиції правил", ru: "Предложения правил", en: "Rule suggestions" },
  "ds.sub": { uk: "система пропонує, рішення — за людиною", ru: "система предлагает, решение — за человеком", en: "the system suggests, a person decides" },
  "ds.version": { uk: "версія", ru: "версия", en: "version" },
  "ds.accept": { uk: "Погодитись", ru: "Согласиться", en: "Accept" },
  "ds.decline": { uk: "Відхилити", ru: "Отклонить", en: "Decline" },
  "ds.whyDecline": { uk: "Чому відхиляєте", ru: "Почему отклоняете", en: "Reason for declining" },
  "ds.accepted": { uk: "Пропозицію прийнято", ru: "Предложение принято", en: "Suggestion accepted" },
  "ds.declined": { uk: "Пропозицію відхилено", ru: "Предложение отклонено", en: "Suggestion declined" },
  "ds.actNotifyDuty": { uk: "повідомити чергового", ru: "уведомить дежурного", en: "notify the duty officer" },
  "ds.actSurvey": { uk: "запропонувати методику", ru: "предложить методику", en: "suggest an instrument" },
  "ds.actPathway": { uk: "поставити на маршрут", ru: "поставить на маршрут", en: "put on a pathway" },
  "here.also": { uk: "тут ще", ru: "здесь ещё", en: "also here:" },
  "here.editing": { uk: "зараз редагує", ru: "сейчас редактирует", en: "editing now" },
  "work.kindNoshow": { uk: "неявка", ru: "неявка", en: "no-show" },
  "work.kindMessage": { uk: "повідомлення", ru: "сообщение", en: "message" },
  "work.kindDispensary": { uk: "облік", ru: "учёт", en: "dispensary" },
  "work.dispOverdue": { uk: "прострочено оглядів, днів:", ru: "просрочен осмотр, дней:", en: "check-up overdue, days:" },

  /* диспансерное наблюдение */
  "disp.title": { uk: "Диспансерний облік", ru: "Диспансерный учёт", en: "Dispensary register" },
  "disp.notOn": { uk: "На обліку не перебуває", ru: "На учёте не состоит", en: "Not on the register",  },
  "disp.group": { uk: "Група обліку", ru: "Группа учёта", en: "Register group" },
  "disp.groupHint": {
    uk: "Словами вашого відділення: розряди скрізь різні",
    ru: "Словами вашего отделения: разряды везде разные",
    en: "In your department's own terms: categories differ from place to place",
  },
  "disp.every": { uk: "Показуватися раз на, місяців", ru: "Показываться раз в, месяцев", en: "Check-up interval, months" },
  "disp.put": { uk: "Поставити на облік", ru: "Поставить на учёт", en: "Add to register" },
  "disp.next": { uk: "Наступний огляд", ru: "Следующий осмотр", en: "Next check-up" },
  "disp.lastSeen": { uk: "Останній огляд", ru: "Последний осмотр", en: "Last check-up" },
  "disp.overdue": { uk: "прострочено, днів:", ru: "просрочено, дней:", en: "overdue, days:" },
  "disp.seen": { uk: "Огляд відбувся", ru: "Осмотр состоялся", en: "Check-up done" },
  "disp.remove": { uk: "Зняти з обліку", ru: "Снять с учёта", en: "Remove from register" },
  "disp.seenNote": {
    uk: "Відмічається окремо: людина могла прийти з іншого приводу, і зарахувати це за диспансерний огляд означало б відсунути строк, нічого не перевіривши",
    ru: "Отмечается отдельно: человек мог прийти по другому поводу, и засчитать это за диспансерный осмотр значило бы отодвинуть срок, ничего не проверив",
    en: "Marked separately: the person may have come for a different reason, and counting that as a dispensary check-up would push back the deadline without checking anything",
  },
  "work.msgUnread": { uk: "Непрочитаних:", ru: "Непрочитанных:", en: "Unread:" },
  "work.msgWaiting": { uk: "чекає днів:", ru: "ждёт дней:", en: "waiting, days:" },
  "work.msgToday": { uk: "сьогодні", ru: "сегодня", en: "today" },

  /* переписка */
  /* запись приёма */
  "rec.title": { uk: "Запис прийому", ru: "Запись приёма", en: "Appointment recording" },

  /* быстрый ввод бланка */
  /* обращения */
  "ep.title": { uk: "Звернення", ru: "Обращения", en: "Episodes of care" },
  /*
   * «На печать», а не просто «Амбулаторная карта».
   *
   * Рядом на экране приёма стоит «Открыть карту» — переход на экран
   * пациента. Два названия, звучащие одинаково, для двух разных исходов:
   * одно открывает экран, другое — печатный документ. Название обязано
   * говорить, что произойдёт.
   */
  /*
   * «Печать карты целиком» — а не «Амбулаторная карта на печать».
   *
   * На экране приёма эта кнопка стоит рядом с «Открыть карту», и два действия
   * звучали как одно: обе про карту, обе про открыть. Между тем ведут они в
   * разные места — одна на рабочий экран карты внутри консоли, другая
   * печатает её целиком одним документом. Разница теперь в первом слове, а
   * «целиком» договаривает то, ради чего документ и собирают: на экране карта
   * разложена по разделам, в документе она одна.
   */
  "ep.chart": { uk: "Друк картки повністю", ru: "Печать карты целиком", en: "Print full record" },
  "ep.open": { uk: "Відкрити звернення", ru: "Открыть обращение", en: "Open episode" },
  "ep.reason": { uk: "Привід", ru: "Повод", en: "Reason" },
  "ep.reasonHint": {
    uk: "Своїми словами: «після відрядження», «направлений командиром»",
    ru: "Своими словами: «после командировки», «направлен командиром»",
    en: "In your own words: “after deployment”, “referred by commander”",
  },
  "ep.close": { uk: "Закрити", ru: "Закрыть", en: "Close" },
  "ep.outcome": { uk: "Результат", ru: "Результат", en: "Outcome" },
  "ep.outcomeWords": { uk: "Словами", ru: "Словами", en: "In words" },
  "ep.outImproved": { uk: "покращення", ru: "улучшение", en: "improved" },
  "ep.outStable": { uk: "без змін", ru: "без изменений", en: "no change" },
  "ep.outWorse": { uk: "погіршення", ru: "ухудшение", en: "worsened" },
  "ep.outReferred": { uk: "направлений далі", ru: "направлен дальше", en: "referred on" },
  "ep.outDropped": { uk: "перестав приходити", ru: "перестал приходить", en: "stopped attending" },
  "ep.outTransferred": { uk: "переданий іншому фахівцю", ru: "передан другому специалисту", en: "transferred to another specialist" },
  "ep.openSince": { uk: "триває з", ru: "идёт с", en: "ongoing since" },
  "ep.closedAt": { uk: "закрито", ru: "закрыто", en: "closed" },
  "ep.visits": { uk: "прийомів", ru: "приёмов", en: "appointments" },
  "ep.conclusions": { uk: "висновків", ru: "заключений", en: "conclusions" },
  "ep.referrals": { uk: "направлень", ru: "направлений", en: "referrals" },
  "ep.none": { uk: "Звернень не було", ru: "Обращений не было", en: "No episodes" },
  "ep.extract": { uk: "Витяг", ru: "Выписка", en: "Extract" },
  "ep.attachVisit": { uk: "Віднести цей прийом до звернення", ru: "Отнести этот приём к обращению", en: "Link this appointment to the episode" },
  "ep.attached": { uk: "Прийом віднесено", ru: "Приём отнесён", en: "Appointment linked" },
  "ep.oneOpen": {
    uk: "Одне відкрите звернення на людину: якщо привід новий, попереднє закривають",
    ru: "Одно открытое обращение на человека: если повод новый, прежнее закрывают",
    en: "One open episode per person: if the reason is new, the previous one is closed",
  },

  "fast.mode": { uk: "Швидке введення", ru: "Быстрый ввод", en: "Fast entry" },
  "fast.byMouse": { uk: "Мишею", ru: "Мышью", en: "By mouse" },
  "fast.item": { uk: "Пункт", ru: "Пункт", en: "Item" },
  "fast.of": { uk: "з", ru: "из", en: "of" },
  "fast.hint": {
    uk: "Цифра — відповідь, і одразу наступний пункт. Backspace — на пункт назад",
    ru: "Цифра — ответ, и сразу следующий пункт. Backspace — на пункт назад",
    en: "A digit is the answer, and you move straight to the next item. Backspace goes back one item",
  },
  "fast.typeValue": {
    uk: "Впишіть значення і натисніть Enter",
    ru: "Впишите значение и нажмите Enter",
    en: "Type the value and press Enter",
  },
  "fast.paste": { uk: "Вставити рядок відповідей", ru: "Вставить строку ответов", en: "Paste a row of answers" },
  "fast.pasteHint": {
    uk: "Цифри поспіль або через кому: 1,2,1,1… Порядок — як у бланку",
    ru: "Цифры подряд или через запятую: 1,2,1,1… Порядок — как в бланке",
    en: "Digits in a row or comma-separated: 1,2,1,1… Order as on the answer sheet",
  },
  "fast.pasteApply": { uk: "Заповнити", ru: "Заполнить", en: "Fill in" },
  "fast.pasteCount": {
    uk: "У рядку {got} відповідей, а пунктів {need}. Заповнювати частково не будемо",
    ru: "В строке {got} ответов, а пунктов {need}. Заполнять частично не будем",
    en: "The row has {got} answers, but there are {need} items. It will not be filled in partially",
  },
  "fast.pasteBadAt": {
    uk: "Пункт {n}: «{value}» — такого варіанта немає",
    ru: "Пункт {n}: «{value}» — такого варианта нет",
    en: "Item {n}: “{value}” — no such option",
  },
  "fast.done": { uk: "Усі пункти заповнено", ru: "Все пункты заполнены", en: "All items filled in" },
  "fast.left": { uk: "залишилось", ru: "осталось", en: "remaining:" },
  "rec.consentAsk": {
    uk: "Записати цей прийом? Пацієнт має погодитися саме на цей прийом — не «взагалі»",
    ru: "Записать этот приём? Пациент должен согласиться именно на этот приём — не «вообще»",
    en: "Record this appointment? The patient must consent to this specific appointment — not “in general”",
  },
  "rec.consentGive": { uk: "Погоджуюся на запис", ru: "Согласен на запись", en: "I consent to recording" },
  "rec.consentBySelf": { uk: "погодився сам", ru: "согласился сам", en: "consented personally" },
  "rec.consentByStaff": { uk: "записано з його слів", ru: "записано с его слов", en: "verbal consent noted" },
  "rec.consentMark": { uk: "Позначити згоду з його слів", ru: "Отметить согласие с его слов", en: "Note verbal consent" },
  "rec.consentRevoke": { uk: "Передумав", ru: "Передумал", en: "Withdraw consent" },
  "rec.start": { uk: "Почати запис", ru: "Начать запись", en: "Start recording" },
  "rec.stop": { uk: "Зупинити", ru: "Остановить", en: "Stop" },
  "rec.recording": { uk: "Іде запис", ru: "Идёт запись", en: "Recording" },
  "rec.discard": { uk: "Видалити запис", ru: "Удалить запись", en: "Delete recording" },
  "rec.discardSure": {
    uk: "Видалити запис? Відновити її не можна",
    ru: "Удалить запись? Восстановить её нельзя",
    en: "Delete the recording? It cannot be restored",
  },
  "rec.discarded": { uk: "Запис видалено", ru: "Запись удалена", en: "Recording deleted" },
  "rec.uploaded": { uk: "Записано, чекає розшифровки", ru: "Записано, ждёт расшифровки", en: "Recorded, awaiting transcription" },
  "rec.transcribing": { uk: "Розшифровується", ru: "Расшифровывается", en: "Transcribing" },
  "rec.failed": { uk: "Розшифрувати не вдалося", ru: "Расшифровать не удалось", en: "Transcription failed" },
  "rec.noEngine": {
    uk: "Розшифровки поки немає: своє розпізнавання не налаштовано. Запис зберігається як аудіо",
    ru: "Расшифровки пока нет: своё распознавание не настроено. Запись хранится как аудио",
    en: "No transcription yet: in-house speech recognition is not configured. The recording is stored as audio",
  },
  "rec.queued": { uk: "у черзі:", ru: "в очереди:", en: "in queue:" },
  "rec.toProtocol": { uk: "Вставити в протокол", ru: "Вставить в протокол", en: "Insert into notes" },
  "rec.transcriptIsNotProtocol": {
    uk: "Стенограма — не протокол: протокол це те, що ви з неї винесли",
    ru: "Стенограмма — не протокол: протокол это то, что вы из неё вынесли",
    en: "A transcript is not the notes: the notes are what you took from it",
  },
  "rec.patientNote": {
    uk: "Прийом записується. Зупинити можна будь-якої миті — і вам, і фахівцю",
    ru: "Приём записывается. Остановить можно в любой момент — и вам, и специалисту",
    en: "The appointment is being recorded. You or the specialist can stop it at any moment",
  },
  "rec.micDenied": {
    uk: "Немає доступу до мікрофона. Дозвольте його в налаштуваннях браузера",
    ru: "Нет доступа к микрофону. Разрешите его в настройках браузера",
    en: "No access to the microphone. Allow it in your browser settings",
  },

  "chart.singlePoint": {
    uk: "єдиний вимір — порівнювати нема з чим",
    ru: "единственный замер — сравнивать не с чем",
    en: "single measurement — nothing to compare with",
  },
  "ms.title": { uk: "Листування", ru: "Переписка", en: "Conversations" },
  "ms.none": { uk: "Листування немає", ru: "Переписки нет", en: "No conversations" },
  "ms.pick": { uk: "Оберіть листування зліва", ru: "Выберите переписку слева", en: "Select a conversation on the left" },
  "ms.noLead": {
    uk: "Постійного фахівця поки немає — листуватися нема з ким. Запишіться на прийом",
    ru: "Постоянного специалиста пока нет — переписываться не с кем. Запишитесь на приём",
    en: "You don't have a regular specialist yet, so there is no one to message. Book an appointment",
  },
  "ms.write": { uk: "Написати", ru: "Написать", en: "Write" },
  "ms.placeholder": { uk: "Ваше повідомлення", ru: "Ваше сообщение", en: "Your message" },
  "ms.send": { uk: "Відправити", ru: "Отправить", en: "Send" },
  "ms.read": { uk: "прочитано", ru: "прочитано", en: "read" },
  "ms.sent": { uk: "відправлено", ru: "отправлено", en: "sent" },
  "ms.empty": { uk: "Тут поки порожньо", ru: "Здесь пока пусто", en: "Nothing here yet" },
  /*
   * Границы названы в самом окне переписки, а не в правилах, которые никто
   * не читает. Обещание круглосуточного ответа опаснее отсутствия переписки:
   * человек в кризис напишет и будет ждать вместо того, чтобы позвонить.
   */
  "ms.boundaries": {
    uk: "Відповідь у робочий час. Це не екстрений зв’язок: якщо зараз важко — відкрийте план безпеки або зателефонуйте 7333",
    ru: "Ответ в рабочее время. Это не экстренная связь: если сейчас тяжело — откройте план безопасности или позвоните 7333",
    en: "Replies come during working hours. This is not an emergency line: if things are hard right now, open your safety plan or call 7333",
  },

  /* приём: экран дня */
  "day.title": { uk: "Сьогодні", ru: "Сегодня", en: "Today" },
  "day.nobody": { uk: "На цей день прийомів немає", ru: "На этот день приёмов нет", en: "No appointments on this day" },
  "day.prev": { uk: "Попередній день", ru: "Предыдущий день", en: "Previous day" },
  "day.next": { uk: "Наступний день", ru: "Следующий день", en: "Next day" },
  "day.today": { uk: "Сьогодні", ru: "Сегодня", en: "Today" },
  "day.came": { uk: "Прийшов", ru: "Пришёл", en: "Arrived" },
  "day.start": { uk: "Почати", ru: "Начать", en: "Start" },
  "day.finish": { uk: "Завершити", ru: "Завершить", en: "Finish" },
  "day.noShow": { uk: "Не прийшов", ru: "Не пришёл", en: "No-show" },
  "day.primary": { uk: "первинний", ru: "первичный", en: "initial" },
  "day.repeat": { uk: "повторний", ru: "повторный", en: "follow-up" },
  "day.remote": { uk: "дистанційно", ru: "дистанционно", en: "remote" },
  "day.room": { uk: "каб.", ru: "каб.", en: "room" },
  "day.unconfirmed": { uk: "не підтвердив", ru: "не подтвердил", en: "not confirmed" },
  "day.offSchedule": { uk: "поза розкладом", ru: "вне расписания", en: "off schedule" },
  "day.noLead": { uk: "без ведучого", ru: "без ведущего", en: "no lead clinician" },
  "day.pending": { uk: "не здав методик:", ru: "не сдал методик:", en: "instruments not completed:" },

  /* экран приёма */
  "visit.title": { uk: "Прийом", ru: "Приём", en: "Appointment" },
  "visit.history": { uk: "Що було", ru: "Что было", en: "History" },
  "visit.protocol": { uk: "Протокол прийому", ru: "Протокол приёма", en: "Appointment notes" },
  "visit.actions": { uk: "Дії", ru: "Действия", en: "Actions" },
  "visit.wasWith": { uk: "Був у", ru: "Был у", en: "Previously seen by" },
  "visit.firstVisit": { uk: "Перший прийом тут", ru: "Первый приём здесь", en: "First appointment here" },
  "visit.followedSince": { uk: "Спостерігається з", ru: "Наблюдается с", en: "Under care since" },
  "visit.lead": { uk: "Веде", ru: "Ведёт", en: "Lead clinician:" },
  "visit.noLead": { uk: "Ведучого немає", ru: "Ведущего нет", en: "No lead clinician" },
  "visit.changes": { uk: "Що змінилося з минулого разу", ru: "Что изменилось с прошлого раза", en: "What has changed since last time" },
  "visit.noChanges": { uk: "З минулого прийому нічого не сталося", ru: "С прошлого приёма ничего не произошло", en: "Nothing has happened since the last appointment" },
  "visit.changeResponse": { uk: "Пройшов методику", ru: "Прошёл методику", en: "Completed an instrument" },
  "visit.changeAlert": { uk: "Спрацювала тривога", ru: "Сработала тревога", en: "Alert triggered" },
  "visit.changeNoShow": { uk: "Не прийшов на прийом", ru: "Не пришёл на приём", en: "Missed an appointment" },
  "visit.sourceSelf": { uk: "сам", ru: "сам", en: "self" },
  "visit.sourceAssigned": { uk: "за призначенням", ru: "по назначению", en: "assigned" },
  "visit.sourceIntake": { uk: "скринінг при записі", ru: "скрининг при записи", en: "screening at booking" },
  "visit.sourceKiosk": { uk: "з планшета", ru: "с планшета", en: "from a tablet" },
  "visit.sourceClinician": { uk: "заповнив фахівець", ru: "заполнил специалист", en: "filled in by a specialist" },
  "visit.sourceInformant": { uk: "погляд збоку", ru: "взгляд со стороны", en: "outside view" },
  "visit.reason": { uk: "Зі слів пацієнта", ru: "Со слов пациента", en: "In the patient's words" },
  "visit.save": { uk: "Зберегти", ru: "Сохранить", en: "Save" },
  "visit.saved": { uk: "Протокол збережено", ru: "Протокол сохранён", en: "Notes saved" },
  "visit.template": { uk: "Підставити шаблон", ru: "Подставить шаблон", en: "Insert template" },
  "visit.openCard": { uk: "Відкрити картку", ru: "Открыть карту", en: "Open patient card" },
  "visit.assignDue": { uk: "Пройти до", ru: "Пройти до", en: "Complete by" },
  "visit.assignAttempts": { uk: "Спроб", ru: "Попыток", en: "Attempts" },
  "visit.assignPick": { uk: "Методика", ru: "Методика", en: "Instrument" },
  "visit.assigned": { uk: "Методику призначено", ru: "Методика назначена", en: "Instrument assigned" },
  "visit.referDest": { uk: "Куди", ru: "Куда", en: "Destination" },
  "visit.referUrgency": { uk: "Терміновість", ru: "Срочность", en: "Urgency" },
  "visit.referReason": { uk: "Підстава", ru: "Основание", en: "Grounds" },
  "visit.referred": { uk: "Направлення виписано", ru: "Направление выписано", en: "Referral issued" },
  "visit.cancel": { uk: "Скасувати", ru: "Отменить", en: "Cancel" },

  /* черновик заключения из результатов */
  "cn.fromResults": { uk: "Зібрати з результатів", ru: "Собрать из результатов", en: "Build from results" },
  "cn.draftHeader": { uk: "Обстежений", ru: "Обследованный", en: "Examinee" },
  "cn.draftAge": { uk: "років", ru: "лет", en: "years old" },
  "cn.draftMethod": { uk: "Методика", ru: "Методика", en: "Instrument" },
  "cn.draftDate": { uk: "Дата обстеження", ru: "Дата обследования", en: "Assessment date" },
  "cn.draftScales": { uk: "Показники", ru: "Показатели", en: "Scores" },
  "cn.draftWas": { uk: "було", ru: "было", en: "previously" },
  "cn.draftConclusionHere": {
    uk: "Висновок: ______",
    ru: "Заключение: ______",
    en: "Conclusion: ______",
  },

  /* мобильное приложение: вкладки и главный экран */
  "tab.home": { uk: "Головна", ru: "Главная", en: "Home" },
  "tab.booking": { uk: "Запис", ru: "Запись", en: "Booking" },
  "tab.health": { uk: "Здоров’я", ru: "Здоровье", en: "Health" },
  "hl.dynamics": { uk: "Як змінюється", ru: "Как меняется", en: "How it is changing" },
  "hl.noDynamics": {
    uk: "Динаміка з’явиться після другого проходження: порівнювати поки нема з чим",
    ru: "Динамика появится после второго прохождения: сравнивать пока не с чем",
    en: "Dynamics will appear after the second completion: there is nothing to compare with yet",
  },
  "hl.latest": { uk: "Останнє", ru: "Последнее", en: "Latest" },
  "hl.before": { uk: "До того", ru: "До того", en: "Previous" },

  /* регистрация: телефон и честная оговорка про «анонимно» */
  "reg.phone": { uk: "Телефон", ru: "Телефон", en: "Phone" },
  "reg.phoneWhy": {
    uk: "Потрібен, щоб зв’язатися, якщо стан викличе занепокоєння. Фахівцю в списках не показується",
    ru: "Нужен, чтобы связаться, если состояние вызовет беспокойство. Специалисту в списках не показывается",
    en: "Needed to contact you if your condition gives cause for concern. It is not shown to the specialist in lists",
  },
  "reg.codedMeaning": {
    uk: "Прізвище й ім’я не зберігаються — замість них система видасть код на кшталт «Респондент А-4821». Але це анонімність ДЛЯ ФАХІВЦЯ, а не для установи: пошта й телефон зберігаються в обох випадках",
    ru: "Фамилия и имя не сохраняются — вместо них система выдаст код вида «Респондент А-4821». Но это анонимность ДЛЯ СПЕЦИАЛИСТА, а не для учреждения: почта и телефон хранятся в обоих случаях",
    en: "Your last and first names are not stored — instead, the system will issue a code like “Respondent A-4821”. But this is anonymity FROM THE SPECIALIST, not from the institution: your email and phone are stored in both cases",
  },
  "reg.sex": { uk: "Стать", ru: "Пол", en: "Sex" },
  "sv.assigned": { uk: "Призначено вам", ru: "Назначено вам", en: "Assigned to you" },

  /* раскрытие учётной записи под кодом */
  "rv.title": { uk: "Назвати ім’я", ru: "Назвать имя", en: "Provide name" },
  "rv.why": {
    uk: "Щоб виписати довідку або висновок, за законом потрібне ім’я. Поки його немає, документа не буде",
    ru: "Чтобы выписать справку или заключение, по закону нужно имя. Пока его нет, документа не будет",
    en: "By law, a name is required to issue a certificate or a conclusion. Until there is one, there will be no document",
  },
  "rv.irreversible": {
    uk: "Це незворотно: пройдені під кодом методики прив’яжуться до імені, і повернути код назад не можна",
    ru: "Это необратимо: пройденные под кодом методики привяжутся к имени, и вернуть код обратно нельзя",
    en: "This is irreversible: instruments completed under the code will be linked to the name, and the code cannot be restored",
  },
  "rv.alreadyPassed": {
    uk: "Вже пройдено методик: {n}. Усі вони стануть під іменем",
    ru: "Уже пройдено методик: {n}. Все они станут под именем",
    en: "Instruments already completed: {n}. All of them will be linked to the name",
  },
  "rv.confirm": { uk: "Назвати ім’я", ru: "Назвать имя", en: "Provide name" },
  "rv.done": { uk: "Готово. Тепер документи виписати можна", ru: "Готово. Теперь документы выписать можно", en: "Done. Documents can now be issued" },
  "sv.due": { uk: "до", ru: "до", en: "due" },
  "sv.overdue": { uk: "строк минув", ru: "срок прошёл", en: "past due" },
  "sv.minutes": { uk: "хв", ru: "мин", en: "min" },
  "reg.inviteHint": {
    uk: "Код відкриває призначене обстеження одразу після входу. Якщо розгорнуто закриту реєстрацію — без коду увійти не вийде",
    ru: "Код открывает назначенное обследование сразу после входа. Если развёрнута закрытая регистрация — без кода войти не получится",
    en: "The code opens the assigned assessment right after sign-in. If closed registration is enabled, you cannot sign in without a code",
  },
  "reg.normsHint": {
    uk: "Стать і дата народження не обов’язкові, але частина методик рахує норми за ними — без цих полів результат буде без нормування",
    ru: "Пол и дата рождения не обязательны, но часть методик считает нормы по ним — без этих полей результат будет без нормирования",
    en: "Sex and date of birth are optional, but some instruments calculate norms based on them — without these fields the result will not be normed",
  },
  "home.nextVisit": { uk: "Найближчий прийом", ru: "Ближайший приём", en: "Next appointment" },
  "home.noVisit": { uk: "Прийом не призначено", ru: "Приём не назначен", en: "No appointment scheduled" },
  "home.bookNow": { uk: "Записатися", ru: "Записаться", en: "Book" },
  "home.confirm": { uk: "Підтверджую, прийду", ru: "Подтверждаю, приду", en: "I confirm, I'll be there" },
  "home.confirmed": { uk: "Ви підтвердили", ru: "Вы подтвердили", en: "You have confirmed" },
  "home.reschedule": { uk: "Перенести", ru: "Перенести", en: "Reschedule" },
  "home.cancel": { uk: "Скасувати", ru: "Отменить", en: "Cancel" },
  "home.cancelSure": { uk: "Скасувати прийом?", ru: "Отменить приём?", en: "Cancel the appointment?" },
  "home.cancelLate": {
    uk: "До прийому менш ніж доба. Скасувати можна, але фахівець це побачить",
    ru: "До приёма меньше суток. Отменить можно, но специалист это увидит",
    en: "The appointment is less than 24 hours away. You can cancel, but the specialist will see it",
  },
  "home.room": { uk: "Кабінет", ru: "Кабинет", en: "Room" },
  "home.remote": { uk: "Дистанційно", ru: "Дистанционно", en: "Remote" },
  "home.toDo": { uk: "Пройти до прийому", ru: "Пройти до приёма", en: "Complete before your appointment" },
  "home.nothingToDo": { uk: "Нічого проходити не треба", ru: "Ничего проходить не нужно", en: "Nothing to complete" },
  "home.help": { uk: "Зв’язок і допомога", ru: "Связь и помощь", en: "Contact and help" },
  "home.myLead": { uk: "Ваш фахівець", ru: "Ваш специалист", en: "Your specialist" },
  "home.noLead": { uk: "Постійного фахівця поки немає", ru: "Постоянного специалиста пока нет", en: "You don't have a regular specialist yet" },
  "home.safetyPlan": { uk: "План безпеки", ru: "План безопасности", en: "Safety plan" },
  "home.hotline": { uk: "Телефон довіри", ru: "Телефон доверия", en: "Helpline" },
  "home.hotlineNumber": { uk: "7333", ru: "7333", en: "7333" },

  /* мобильное приложение: запись */
  "bk.pickSpecialist": { uk: "До кого", ru: "К кому", en: "Who to see" },
  "bk.yours": { uk: "ваш фахівець", ru: "ваш специалист", en: "your specialist" },
  "bk.pickTime": { uk: "Коли", ru: "Когда", en: "When" },
  "bk.noFree": {
    uk: "Вільного часу поки немає. Загляньте пізніше або оберіть іншого фахівця",
    ru: "Свободного времени пока нет. Загляните позже или выберите другого специалиста",
    en: "No free time slots yet. Check back later or choose another specialist",
  },
  "bk.reason": { uk: "З чим звертаєтеся", ru: "С чем обращаетесь", en: "Reason for your visit" },
  "bk.reasonHint": {
    uk: "Своїми словами, коротко. Можна не заповнювати",
    ru: "Своими словами, коротко. Можно не заполнять",
    en: "Briefly, in your own words. Optional",
  },
  "bk.book": { uk: "Записатися", ru: "Записаться", en: "Book" },
  "bk.booked": { uk: "Вас записано", ru: "Вы записаны", en: "You are booked" },
  "bk.screeningOffer": {
    uk: "До прийому пройдіть коротке опитування — фахівець почне з розмови, а не з бланків",
    ru: "До приёма пройдите короткий опрос — специалист начнёт с разговора, а не с бланков",
    en: "Before the appointment, take a short questionnaire — the specialist will start with a conversation rather than with forms",
  },
  "bk.screeningStart": { uk: "Пройти зараз", ru: "Пройти сейчас", en: "Take it now" },
  "bk.screeningLater": { uk: "Пізніше", ru: "Позже", en: "Later" },
  "bk.screeningNoScore": {
    uk: "Балів ви не побачите: пояснити їх поки нікому. Відповіді передамо фахівцю",
    ru: "Баллов вы не увидите: объяснить их пока некому. Ответы передадим специалисту",
    en: "You won't see the scores: there is no one to explain them yet. Your answers will be passed on to the specialist",
  },
  "visit.certificate": { uk: "Довідка про відвідування", ru: "Справка о посещении", en: "Certificate of attendance" },

  /* шаблоны и формулировки */
  "tpl.insert": { uk: "Вставити", ru: "Вставить", en: "Insert" },
  "tpl.templates": { uk: "Шаблони", ru: "Шаблоны", en: "Templates" },
  "tpl.phrases": { uk: "Формулювання", ru: "Формулировки", en: "Phrases" },
  "tpl.none": { uk: "Бібліотека порожня", ru: "Библиотека пуста", en: "The library is empty" },
  "tpl.replaces": {
    uk: "Шаблон замінить набране. Продовжити?",
    ru: "Шаблон заменит набранное. Продолжить?",
    en: "The template will replace the text you have typed. Continue?",
  },
  "tpl.add": { uk: "Зберегти як формулювання", ru: "Сохранить как формулировку", en: "Save as phrase" },
  "tpl.addTitle": { uk: "Назва формулювання", ru: "Название формулировки", en: "Phrase name" },
  "tpl.added": { uk: "Збережено в бібліотеку", ru: "Сохранено в библиотеку", en: "Saved to library" },
  "tpl.selectFirst": {
    uk: "Виділіть текст, який треба зберегти",
    ru: "Выделите текст, который надо сохранить",
    en: "Select the text you want to save",
  },
  "cn.draftReplaced": {
    uk: "Набране заміниться зібраним. Продовжити?",
    ru: "Набранное заменится собранным. Продолжить?",
    en: "The text you have typed will be replaced with the generated text. Continue?",
  },
  "visit.assign": { uk: "Призначити методику", ru: "Назначить методику", en: "Assign instrument" },
  "visit.refer": { uk: "Виписати направлення", ru: "Выписать направление", en: "Issue referral" },
  "visit.takeLead": { uk: "Закріпити за собою", ru: "Закрепить за собой", en: "Become lead clinician" },
  "visit.finish": { uk: "Завершити прийом", ru: "Завершить приём", en: "End appointment" },
  "visit.tplIntake": {
    uk: "Скарги:\n\nАнамнез:\n\nПсихічний стан:\n\nВисновок:\n\nПлан:",
    ru: "Жалобы:\n\nАнамнез:\n\nПсихическое состояние:\n\nЗаключение:\n\nПлан:",
    en: "Complaints:\n\nHistory:\n\nMental status:\n\nConclusion:\n\nPlan:",
  },
  "visit.tplSession": {
    uk: "Стан на сьогодні:\n\nЩо змінилося:\n\nРобота на прийомі:\n\nДомовилися:",
    ru: "Состояние на сегодня:\n\nЧто изменилось:\n\nРабота на приёме:\n\nДоговорились:",
    en: "Current state:\n\nWhat has changed:\n\nWork in session:\n\nAgreed:",
  },
  "day.takeLead": { uk: "Закріпити за собою", ru: "Закрепить за собой", en: "Become lead clinician" },
  "day.reason": { uk: "Зі слів пацієнта", ru: "Со слов пациента", en: "In the patient's words" },
  "day.statusBooked": { uk: "записаний", ru: "записан", en: "booked" },
  "day.statusConfirmed": { uk: "підтвердив", ru: "подтвердил", en: "confirmed" },
  "day.statusArrived": { uk: "прийшов", ru: "пришёл", en: "arrived" },
  "day.statusInProgress": { uk: "на прийомі", ru: "на приёме", en: "in appointment" },
  "day.statusDone": { uk: "прийнято", ru: "принят", en: "seen" },
  "day.statusNoShow": { uk: "не прийшов", ru: "не пришёл", en: "no-show" },
  "day.statusCancelled": { uk: "скасовано", ru: "отменён", en: "cancelled" },
  "day.waiting": { uk: "Чекають", ru: "Ждут", en: "Waiting" },
  "day.received": { uk: "Прийнято", ru: "Принято", en: "Seen" },
  "day.inRoom": { uk: "На прийомі", ru: "На приёме", en: "In appointment" },
  "day.absent": { uk: "Не прийшли", ru: "Не пришли", en: "No-shows" },

  /* приём: розклад */
  "sched.title": { uk: "Розклад прийому", ru: "Расписание приёма", en: "Appointment schedule" },
  "sched.week": { uk: "Звичайний тиждень", ru: "Обычная неделя", en: "Regular week" },
  "sched.exceptions": { uk: "Винятки", ru: "Исключения", en: "Exceptions" },
  "sched.addRow": { uk: "Додати години", ru: "Добавить часы", en: "Add hours" },
  /* простая настройка недели: дни · часы · длительность приёма */
  "sched.simple": { uk: "Звичайний тиждень одним рядком", ru: "Обычная неделя одной строкой", en: "Regular week in one line" },
  "sched.simpleHint": {
    uk: "Позначте дні та вкажіть години — з цього складеться тиждень. Окремі дні можна потім виправити нижче.",
    ru: "Отметьте дни и укажите часы — из этого сложится неделя. Отдельные дни можно потом поправить ниже.",
    en: "Tick the days and enter the hours — the week will be built from this. Individual days can be adjusted below afterwards.",
  },
  "sched.apply": { uk: "Скласти тиждень", ru: "Составить неделю", en: "Build week" },
  "sched.applyWarn": {
    uk: "Замінить усі години, що стоять зараз",
    ru: "Заменит все часы, которые стоят сейчас",
    en: "Replaces all hours currently set",
  },
  "sched.byDay": { uk: "По днях окремо", ru: "По дням отдельно", en: "Day by day" },
  "sched.edit": { uk: "Змінити тиждень", ru: "Изменить неделю", en: "Edit week" },
  "sched.cancelEdit": { uk: "Скасувати зміни", ru: "Отменить изменения", en: "Discard changes" },
  "sched.dayOff": { uk: "не приймаю", ru: "не принимаю", en: "not seeing patients" },
  /* в чтении недели подпись столбца не годится: «Приём, мин 50» читается задом наперёд */
  "sched.perSlot": { uk: "по {n} хв", ru: "по {n} мин", en: "{n} min each" },
  "sched.save": { uk: "Зберегти тиждень", ru: "Сохранить неделю", en: "Save week" },
  "sched.saved": { uk: "Розклад збережено", ru: "Расписание сохранено", en: "Schedule saved" },
  "sched.from": { uk: "З", ru: "С", en: "From" },
  "sched.to": { uk: "До", ru: "До", en: "To" },
  "sched.kind": { uk: "Вид", ru: "Вид", en: "Type" },
  "sched.slotMinutes": { uk: "Прийом, хв", ru: "Приём, мин", en: "Appointment, min" },
  "sched.weekday": { uk: "День", ru: "День", en: "Day" },
  "sched.empty": { uk: "Тиждень порожній: прийому немає", ru: "Неделя пуста: приёма нет", en: "The week is empty: no appointments" },
  "sched.horizon": {
    uk: "Час для запису відкривається на {weeks} тижнів уперед",
    ru: "Время для записи открывается на {weeks} недель вперёд",
    en: "Booking opens {weeks} weeks ahead",
  },
  "sched.result": {
    uk: "Додано {added}, знято {removed}, позначено зайнятих поза розкладом: {flagged}",
    ru: "Добавлено {added}, снято {removed}, помечено занятых вне расписания: {flagged}",
    en: "Added {added}, removed {removed}, booked slots flagged as off schedule: {flagged}",
  },
  "sched.offNote": {
    uk: "Зайнятий час поза розкладом не зникає: перенести чи лишити — вирішує людина",
    ru: "Занятое время вне расписания не исчезает: перенести или оставить решает человек",
    en: "Booked time outside the schedule does not disappear: whether to move it or keep it is up to a person",
  },
  "sched.addException": { uk: "Додати виняток", ru: "Добавить исключение", en: "Add exception" },
  "sched.excOff": { uk: "не приймаю", ru: "не принимаю", en: "not seeing patients" },
  "sched.excExtra": { uk: "додаткові години", ru: "дополнительные часы", en: "extra hours" },
  "sched.excAllDay": { uk: "увесь день", ru: "весь день", en: "all day" },
  "sched.excNone": { uk: "Винятків немає", ru: "Исключений нет", en: "No exceptions" },
  "sched.date": { uk: "Дата", ru: "Дата", en: "Date" },
  "sched.note": { uk: "Примітка", ru: "Примечание", en: "Note" },
  "sched.remove": { uk: "Зняти", ru: "Снять", en: "Remove" },
  /*
   * Короткие подписи дней — отдельными строками, а не срезом длинных.
   *
   * `"Понедельник".slice(0, 2)` даёт «По», «Че», «Пя», «Су», «Во» — не
   * сокращения, а обрубки. По-украински обрубки другие, и общего правила
   * среза нет: «неділя» сокращается как «нд», а не «не».
   */
  "wd.1": { uk: "пн", ru: "пн", en: "Mon" },
  "wd.2": { uk: "вт", ru: "вт", en: "Tue" },
  "wd.3": { uk: "ср", ru: "ср", en: "Wed" },
  "wd.4": { uk: "чт", ru: "чт", en: "Thu" },
  "wd.5": { uk: "пт", ru: "пт", en: "Fri" },
  "wd.6": { uk: "сб", ru: "сб", en: "Sat" },
  "wd.7": { uk: "нд", ru: "вс", en: "Sun" },
  "sched.mon": { uk: "Понеділок", ru: "Понедельник", en: "Monday" },
  "sched.tue": { uk: "Вівторок", ru: "Вторник", en: "Tuesday" },
  "sched.wed": { uk: "Середа", ru: "Среда", en: "Wednesday" },
  "sched.thu": { uk: "Четвер", ru: "Четверг", en: "Thursday" },
  "sched.fri": { uk: "П’ятниця", ru: "Пятница", en: "Friday" },
  "sched.sat": { uk: "Субота", ru: "Суббота", en: "Saturday" },
  "sched.sun": { uk: "Неділя", ru: "Воскресенье", en: "Sunday" },
  "work.noshowOnce": { uk: "Не прийшов на прийом", ru: "Не пришёл на приём", en: "Missed an appointment" },
  "work.noshowTimes": { uk: "Не приходив разів:", ru: "Не приходил раз:", en: "Missed appointments:" },
  "work.noshowAfterAlert": {
    uk: "після спрацьованої тривоги",
    ru: "после сработавшей тревоги",
    en: "after a triggered alert",
  },
  "work.kindAssignment": { uk: "призначення", ru: "назначение", en: "assignment" },
  "work.kindFollowup": { uk: "повтор за протоколом", ru: "повтор по протоколу", en: "protocol follow-up" },
  "work.filterNoshows": { uk: "Неявки", ru: "Неявки", en: "No-shows" },
  "work.filterMessages": { uk: "Непрочитані", ru: "Непрочитанные", en: "Unread" },
  "work.filterDispensary": { uk: "Прострочений облік", ru: "Просроченный учёт", en: "Overdue check-ups" },
  "work.filterFollowups": { uk: "Прострочені повтори", ru: "Просроченные повторы", en: "Overdue follow-ups" },
  "work.filterReferrals": { uk: "Направлення", ru: "Направления", en: "Referrals" },
  "work.filterAssignments": { uk: "Прострочені призначення", ru: "Просроченные назначения", en: "Overdue assignments" },
  "work.done": { uk: "Розібрано", ru: "Разобрано", en: "Reviewed" },
  "work.doneHint": {
    uk: "Нове з’явиться тут, щойно надійде — цей екран збирає все вхідне в одному місці",
    ru: "Новое появится здесь, как только придёт — этот экран собирает всё входящее в одном месте",
    en: "New items will appear here as soon as they arrive — this screen gathers everything incoming in one place",
  },
  "work.truncated": {
    uk: "Показано перші 100. Розберіть термінове — решта підтягнеться.",
    ru: "Показаны первые 100. Разберите срочное — остальное подтянется.",
    en: "Showing the first 100. Deal with the urgent ones — the rest will load.",
  },

  /* ─────────── консоль: пациенты ─────────── */
  "patients.title": { uk: "Пацієнти", ru: "Пациенты", en: "Patients" },
  "patients.sub": { uk: "Ті, хто проходив методики ваших груп", ru: "Проходившие методики ваших групп", en: "People who have completed instruments from your groups" },
  "patients.measurements": { uk: "Замірів", ru: "Замеров", en: "Measurements" },
  "patients.last": { uk: "Останнє", ru: "Последнее", en: "Latest" },
  "patients.all": { uk: "← Усі пацієнти", ru: "← Все пациенты", en: "← All patients" },

  /* ── audit:patients ── */
  /*
   * Сверка разделов «Пацієнти» и «Групи» с кадрами f05, f06, f13, f14, f36.
   * Подписи того, что кадр не рисует на виду: меню шестерёнки списка и меню
   * «⋯» над выборкой. Сами действия с экрана не ушли — ушли с глаз.
   */
  "pt.listActions": { uk: "Дії зі списком", ru: "Действия со списком", en: "List actions" },
  "pt.selectionActions": { uk: "Дії з вибраними", ru: "Действия с выбранными", en: "Actions on selected" },
  "views.show": { uk: "Збережені вигляди", ru: "Сохранённые виды", en: "Saved views" },
  /*
   * Раздел бургера с дверями, которых кадр не рисует на самом экране.
   * Два адреса — /responses/:id/conclusion/draft и /patient-groups/:id/edit —
   * были заведены и остались без единой ссылки: попасть можно было только
   * набрав адрес руками. Кадр (f14, f36) в обоих местах рисует строку
   * заголовка чистой, поэтому дверь встала туда же, куда уже встали входы
   * клинической карты, — в бургер.
   */
  "tools.screen": { uk: "Інструменти екрана", ru: "Инструменты экрана", en: "Screen tools" },
  "tools.conclusionDraft": { uk: "Чернетка заключення", ru: "Черновик заключения", en: "Conclusion draft" },

  /* ─────────── направления ─────────── */
  "ref.title": { uk: "Направлення", ru: "Направления", en: "Referrals" },
  "ref.openSub": { uk: "Відкриті: виписані та прийняті", ru: "Открытые: выписанные и принятые", en: "Open: issued and accepted" },
  "ref.allSub": { uk: "Усі направлення", ru: "Все направления", en: "All referrals" },
  "ref.showClosed": { uk: "Показати завершені", ru: "Показать завершённые", en: "Show completed" },
  "ref.onlyOpen": { uk: "Лише відкриті", ru: "Только открытые", en: "Open only" },
  "ref.patient": { uk: "Пацієнт", ru: "Пациент", en: "Patient" },
  "ref.where": { uk: "Куди", ru: "Куда", en: "Destination" },
  "ref.urgency": { uk: "Терміновість", ru: "Срочность", en: "Urgency" },
  "ref.status": { uk: "Статус", ru: "Статус", en: "Status" },
  "ref.reason": { uk: "Підстава", ru: "Основание", en: "Grounds" },
  "ref.issued": { uk: "Виписано", ru: "Выписано", en: "Issued" },
  "ref.none": { uk: "Направлень немає", ru: "Направлений нет", en: "No referrals" },
  "ref.noneOpen": { uk: "Відкритих направлень немає", ru: "Открытых направлений нет", en: "No open referrals" },
  "ref.noneHint": { uk: "Направлення виписується зі зведення пацієнта", ru: "Направление выписывается со сводки пациента", en: "Referrals are issued from the patient overview" },
  "ref.new": { uk: "Виписати направлення", ru: "Выписать направление", en: "Issue referral" },
  "ref.issue": { uk: "Виписати", ru: "Выписать", en: "Issue" },
  "ref.reasonPlaceholder": { uk: "що стало приводом", ru: "что послужило поводом", en: "what prompted it" },
  "ref.accepted": { uk: "Прийнято", ru: "Принято", en: "Accepted" },
  "ref.completed": { uk: "Завершено", ru: "Завершено", en: "Completed" },
  "ref.declined": { uk: "Відхилено", ru: "Отклонено", en: "Declined" },
  "ref.answer": { uk: "Відповідь", ru: "Ответ", en: "Response" },
  "dest.psychiatrist": { uk: "психіатр", ru: "психиатр", en: "psychiatrist" },
  "dest.inpatient": { uk: "стаціонар", ru: "стационар", en: "inpatient" },
  "dest.outpatient": { uk: "амбулаторно", ru: "амбулаторно", en: "outpatient" },
  "dest.commander": { uk: "командиру", ru: "командиру", en: "commander" },
  "dest.other": { uk: "інше", ru: "иное", en: "other" },
  "urg.routine": { uk: "планово", ru: "планово", en: "routine" },
  "urg.urgent": { uk: "терміново", ru: "срочно", en: "urgent" },
  "urg.immediate": { uk: "негайно", ru: "немедленно", en: "immediate" },
  /* статус методики: на экране он должен читаться, а не приезжать кодом */
  "st.created": { uk: "виписано", ru: "выписано", en: "issued" },
  "st.accepted": { uk: "прийнято", ru: "принято", en: "accepted" },
  "st.completed": { uk: "завершено", ru: "завершено", en: "completed" },
  "st.declined": { uk: "відхилено", ru: "отклонено", en: "declined" },

  /*
   * Состояние прохождения: зовётся шаблоном ut(`rstatus.${r.status}`).
   *
   * Отдельное семейство, а не переиспользование st.* и msv.*: там те же
   * слова, но другого рода и в другом регистре — «завершено» со строчной
   * идёт в строку «выписано 3 июня, завершено», а здесь это ячейка колонки
   * «Стан», и строчная буква посреди таблицы читается как обрывок фразы.
   * Делить один ключ на два места значило бы выбирать, какое из них
   * выглядит хуже.
   *
   * Ключи названы именами значений протокола дословно, включая
   * «in_progress» с подчёркиванием: ключ складывается из ответа сервера, и
   * любое «причёсывание» имени потребовало бы таблицы перевода кода в ключ —
   * то есть второго места, где про новое состояние нужно вспомнить.
   */
  "rstatus.in_progress": { uk: "Триває", ru: "Идёт", en: "In progress" },
  "rstatus.completed": { uk: "Завершено", ru: "Завершено", en: "Completed" },
  "rstatus.abandoned": { uk: "Покинуто", ru: "Брошено", en: "Abandoned" },

  /* ─────────── сводка консилиума ─────────── */
  "sum.openAlerts": { uk: "Відкриті тривоги", ru: "Открытые тревоги", en: "Open alerts" },
  "sum.print": { uk: "Друк зведення", ru: "Печать сводки", en: "Print overview" },
  "sum.scale": { uk: "Шкала", ru: "Шкала", en: "Scale" },
  "sum.lastScore": { uk: "Останній бал", ru: "Последний балл", en: "Latest score" },
  "sum.interpretation": { uk: "Інтерпретація", ru: "Интерпретация", en: "Interpretation" },
  "sum.trend": { uk: "Динаміка", ru: "Динамика", en: "Dynamics" },
  "sum.oneMeasure": { uk: "один замір", ru: "один замер", en: "one measurement" },
  "sum.withinError": { uk: "у межах похибки", ru: "в пределах ошибки", en: "within measurement error" },
  "sum.reliableUp": { uk: "достовірне зростання", ru: "достоверный рост", en: "reliable increase" },
  "sum.reliableDown": { uk: "достовірний спад", ru: "достоверный спад", en: "reliable decrease" },
  "sum.conclusions": { uk: "Висновки фахівців", ru: "Заключения специалистов", en: "Specialists' conclusions" },
  "sum.measurements": { uk: "замірів", ru: "замеров", en: "measurements" },
  "sum.lastAt": { uk: "останній", ru: "последний", en: "latest" },
  "sum.formedAt": { uk: "Зведення сформовано", ru: "Сводка сформирована", en: "Overview generated" },

  /* ─────────── состояние подразделения ─────────── */

  /*
   * Якоря волны 9 (аналитика прохождения, графики, оболочка): у каждого
   * сборщика свой участок, далеко от якорей волн 7 и 8. Пустая строка между
   * якорями — не украшение: две вставки в соседние строки git сводит
   * конфликтом, а через неизменённую строку — чисто.
   */
  /* ── wave9:response ── */
  /*
   * Графики одного прохождения — вкладка «Графіки» рядом с «Відповіді»
   * (pages/response/charts.tsx). Своё семейство rch.*, а не rsp.*: там
   * кадр f34, и его ключи сторожит сверка с макетом; здесь экран, которого
   * на кадрах нет, и его слова меняются по другим причинам.
   *
   * Вердикты о сдвиге — полными словами, без «достовірно/недостовірно»:
   * «більше за похибку вимірювання» говорит, ЧТО проверено, а
   * «достовірно» читается как «значит, лечение подействовало», чего RCI не
   * утверждает.
   */
  "rch.tabsLabel": { uk: "Проходження тесту", ru: "Прохождение теста", en: "Test completion" },
  "rch.tabAnswers": { uk: "Відповіді", ru: "Ответы", en: "Answers" },
  "rch.tabCharts": { uk: "Графіки", ru: "Графики", en: "Charts" },
  "rch.result": { uk: "Результат", ru: "Результат", en: "Result" },
  "rch.dynamics": { uk: "Динаміка", ru: "Динамика", en: "Progress" },
  "rch.contribution": { uk: "Внесок пунктів", ru: "Вклад пунктов", en: "Item contributions" },
  "rch.answering": { uk: "Як відповідав", ru: "Как отвечал", en: "How it was answered" },
  "rch.interpretation": { uk: "Що означає результат", ru: "Что означает результат", en: "What the result means" },
  "rch.recommendation": { uk: "Рекомендація", ru: "Рекомендация", en: "Recommendation" },
  "rch.noBands": {
    uk: "без інтерпретаційних меж: методика не задає для цієї шкали полос",
    ru: "без интерпретационных границ: методика не задаёт для этой шкалы полос",
    en: "no interpretation bands: the instrument defines none for this scale",
  },
  "rch.notNormalized": {
    uk: "не нормовано — показано сирий бал; межі інтерпретації задані в інших одиницях і до нього не застосовуються",
    ru: "не нормировано — показан сырой балл; границы интерпретации заданы в других единицах и к нему не применяются",
    en: "not normalised — raw score shown; the interpretation bands use other units and do not apply to it",
  },
  "rch.outside": {
    uk: "значення поза інтерпретаційними межами методики",
    ru: "значение вне интерпретационных границ методики",
    en: "value outside the instrument's interpretation bands",
  },
  "rch.dynamicsHint": {
    uk: "Усі завершені проходження цієї методики цією людиною; кільце — це проходження. Смуга навколо лінії — похибка вимірювання, коли її можна оцінити.",
    ru: "Все завершённые прохождения этой методики этим человеком; кольцо — это прохождение. Полоса вокруг линии — ошибка измерения, когда её можно оценить.",
    en: "All completed runs of this instrument by this person; the ring marks this one. The band around the line is measurement error, where it can be estimated.",
  },
  "rch.single": {
    uk: "Перше проходження цієї методики — порівнювати ні з чим",
    ru: "Первое прохождение этой методики — сравнивать не с чем",
    en: "First completion of this instrument — nothing to compare with",
  },
  "rch.firstInSeries": {
    uk: "це проходження перше — попереднього заміру немає",
    ru: "это прохождение первое — предыдущего замера нет",
    en: "this is the first completion — no previous measurement",
  },
  "rch.notInSeries": {
    uk: "Це проходження не завершене, тому на графіку його немає — показано лише завершені.",
    ru: "Это прохождение не завершено, поэтому на графике его нет — показаны только завершённые.",
    en: "This completion is unfinished, so it is not on the chart — only finished ones are shown.",
  },
  "rch.since": { uk: "з", ru: "с", en: "since" },
  "rch.reliable": { uk: "більше за похибку вимірювання", ru: "больше ошибки измерения", en: "larger than measurement error" },
  "rch.within": { uk: "у межах похибки вимірювання", ru: "в пределах ошибки измерения", en: "within measurement error" },
  "rch.noSem": {
    uk: "оцінити надійність зміни нема з чого",
    ru: "оценить надёжность изменения не из чего",
    en: "no basis to judge whether the change is reliable",
  },
  "rch.versions": {
    uk: "між замірами методику змінено — бали напряму не порівнюються",
    ru: "между замерами методика изменена — баллы напрямую не сравниваются",
    en: "the instrument changed between measurements — scores are not directly comparable",
  },
  "rch.mixedVersions": {
    uk: "Методику змінювали між замірами: межі полос показано за версією цього проходження",
    ru: "Методику меняли между замерами: границы полос показаны по версии этого прохождения",
    en: "The instrument changed between measurements: bands follow the version of this completion",
  },
  "rch.pickScale": { uk: "Шкала на графіку", ru: "Шкала на графике", en: "Scale on the chart" },
  "rch.shifts": { uk: "Зсув від попереднього заміру", ru: "Сдвиг от предыдущего замера", en: "Change since the previous measurement" },
  "rch.contributionHint": {
    uk: "Які відповіді дали бал — за ключем тієї версії методики, яку проходили. Смуга — від нуля до того, що пункт міг дати.",
    ru: "Какие ответы дали балл — по ключу той версии методики, которую проходили. Полоса — от нуля до того, что пункт мог дать.",
    en: "Which answers produced the score, using the key of the version that was taken. Each bar runs from zero to what the item could give.",
  },
  "rch.itemN": { uk: "№{n}", ru: "№{n}", en: "#{n}" },
  "rch.more": { uk: "Ще {n}", ru: "Ещё {n}", en: "{n} more" },
  "rch.less": { uk: "Згорнути", ru: "Свернуть", en: "Collapse" },
  "rch.unanswered": {
    uk: "без відповіді: {n} з {m} пунктів шкали",
    ru: "без ответа: {n} из {m} пунктов шкалы",
    en: "unanswered: {n} of {m} scale items",
  },
  "rch.noContribution": { uk: "жоден пункт шкали не дав балів", ru: "ни один пункт шкалы не дал баллов", en: "no item of this scale scored" },
  "rch.versionMissing": {
    uk: "Методику тієї версії, яку проходили, отримати не вдалося — внесок пунктів не рахується",
    ru: "Методику той версии, которую проходили, получить не удалось — вклад пунктов не считается",
    en: "The version of the instrument that was taken is unavailable — item contributions are not computed",
  },
  "rch.answeringHint": {
    uk: "Це підказка тому, хто розбирає протокол, а не вирок: швидку відповідь дає і людина, яка знає її заздалегідь, а змінена відповідь буває просто уважністю.",
    ru: "Это подсказка тому, кто разбирает протокол, а не приговор: быстрый ответ даёт и человек, который знает его заранее, а изменённый ответ бывает просто внимательностью.",
    en: "A hint for the reviewer, not a verdict: a quick answer can come from someone who knew it in advance, and a changed answer can simply be care.",
  },
  "rch.totalTime": { uk: "Загальний час", ru: "Общее время", en: "Total time" },
  "rch.medianTime": { uk: "Медіана на пункт", ru: "Медиана на пункт", en: "Median per item" },
  "rch.changedCount": { uk: "Змінено відповідей", ru: "Изменено ответов", en: "Answers changed" },
  "rch.skippedCount": { uk: "Пропущено", ru: "Пропущено", en: "Skipped" },
  "rch.timeChart": { uk: "Час на кожен пункт", ru: "Время на каждый пункт", en: "Time per item" },
  "rch.timeCaption": {
    uk: "секунди; порожній стовпець — швидше за поріг {t} с",
    ru: "секунды; пустой столбец — быстрее порога {t} с",
    en: "seconds; a hollow column is faster than the {t} s threshold",
  },
  "rch.threshold": { uk: "поріг", ru: "порог", en: "threshold" },
  "rch.aboveAxis": { uk: "вище за край осі", ru: "выше края оси", en: "above the axis" },
  "rch.fastList": { uk: "Швидше за поріг", ru: "Быстрее порога", en: "Faster than the threshold" },
  "rch.changedList": { uk: "Змінював відповідь", ru: "Менял ответ", en: "Changed the answer" },
  "rch.noneWord": { uk: "немає", ru: "нет", en: "none" },
  "rch.noTimes": {
    uk: "Час на пунктах не записано — проходження вводили без замірів",
    ru: "Время на пунктах не записано — прохождение вводили без замеров",
    en: "No per-item time recorded — the completion was entered without timing",
  },
  "rch.sec": { uk: "с", ru: "с", en: "s" },
  "rch.min": { uk: "хв", ru: "мин", en: "min" },

  /* ── wave9:survey ── */
  "ant.sections": { uk: "Розділи аналітики", ru: "Разделы аналитики", en: "Analytics sections" },
  "ant.tabModels": { uk: "Моделі", ru: "Модели", en: "Models" },
  "ant.tabTests": { uk: "Тести", ru: "Тесты", en: "Tests" },
  "ant.title": { uk: "Аналітика тестів", ru: "Аналитика тестов", en: "Test analytics" },
  "ant.filtersLabel": { uk: "Фільтри аналітики", ru: "Фильтры аналитики", en: "Analytics filters" },
  "ant.test": { uk: "Тест", ru: "Тест", en: "Test" },
  "ant.testSearch": { uk: "Пошук тесту за назвою", ru: "Поиск теста по названию", en: "Find a test by name" },
  "ant.noTests": { uk: "Тестів з такою назвою немає", ru: "Тестов с таким названием нет", en: "No tests with that name" },
  "ant.responsesLower": { uk: "проходжень", ru: "прохождений", en: "completions" },
  "ant.who": { uk: "Хто", ru: "Кто", en: "Who" },
  "ant.allPatients": { uk: "Усі пацієнти", ru: "Все пациенты", en: "All patients" },
  "ant.onePatient": { uk: "Один пацієнт", ru: "Один пациент", en: "One patient" },
  "ant.patient": { uk: "Пацієнт", ru: "Пациент", en: "Patient" },
  "ant.patientSearch": { uk: "Пошук пацієнта за ім’ям", ru: "Поиск пациента по имени", en: "Find a patient by name" },
  "ant.noPatients": { uk: "Нікого не знайдено", ru: "Никого не найдено", en: "Nobody found" },
  "ant.group": { uk: "Група пацієнтів", ru: "Группа пациентов", en: "Patient group" },
  "ant.anyGroup": { uk: "Усі групи", ru: "Все группы", en: "All groups" },
  "ant.from": { uk: "Період від", ru: "Период с", en: "Period from" },
  "ant.to": { uk: "Період до", ru: "Период по", en: "Period to" },
  "ant.active": { uk: "Показано:", ru: "Показано:", en: "Showing:" },
  "ant.reset": { uk: "Скинути", ru: "Сбросить", en: "Reset" },
  "ant.versionN": { uk: "версія {n}", ru: "версия {n}", en: "version {n}" },
  "ant.views": { uk: "Що показати", ru: "Что показать", en: "What to show" },
  "ant.viewOverview": { uk: "Огляд", ru: "Обзор", en: "Overview" },
  "ant.actions": { uk: "Дії та вивантаження", ru: "Действия и выгрузки", en: "Actions and exports" },
  "ant.exportsItem": { uk: "Вивантаження…", ru: "Выгрузки…", en: "Exports…" },
  "ant.scriptR": { uk: "Скрипт для R", ru: "Скрипт для R", en: "R script" },
  "ant.scriptPy": { uk: "Скрипт для Python", ru: "Скрипт для Python", en: "Python script" },
  "ant.noSurvey": {
    uk: "Доступних тестів ще немає — аналітика з’явиться, щойно хтось пройде тест.",
    ru: "Доступных тестов ещё нет — аналитика появится, как только кто-то пройдёт тест.",
    en: "No tests available yet — analytics appear once someone completes a test.",
  },
  "ant.tooFew": { uk: "Замало даних", ru: "Слишком мало данных", en: "Not enough data" },
  "ant.kpiPatients": { uk: "Пацієнтів", ru: "Пациентов", en: "Patients" },
  "ant.kpiPatientsHint": { uk: "різних людей серед завершених", ru: "разных людей среди завершённых", en: "distinct people among completed" },
  "ant.byDay": { uk: "Проходження за днями", ru: "Прохождения по дням", en: "Completions by day" },
  "ant.byWeek": { uk: "Проходження за тижнями", ru: "Прохождения по неделям", en: "Completions by week" },
  "ant.dropOffCaption": {
    uk: "Пункти, після яких люди кидали тест: скільки не дійшло до наступного пункту",
    ru: "Пункты, после которых люди бросали тест: сколько не дошло до следующего пункта",
    en: "Items after which people abandoned the test: how many did not reach the next item",
  },
  "ant.dropOffMore": {
    uk: "Показано {n} пунктів з найбільшими втратами",
    ru: "Показаны {n} пунктов с наибольшими потерями",
    en: "Showing the {n} items with the largest losses",
  },
  "ant.noDropOff": {
    uk: "Ніхто не кинув тест на півдорозі",
    ru: "Никто не бросил тест на полпути",
    en: "Nobody abandoned the test halfway",
  },
  "ant.lostN": { uk: "−{n}", ru: "−{n}", en: "−{n}" },
  "ant.scalesHint": {
    uk: "Загальний стан усіх пацієнтів за шкалами: розподіл завершених проходжень за смугами тяжкості, середнє з квартилями і хід середнього за тижнями",
    ru: "Общее состояние всех пациентов по шкалам: распределение завершённых прохождений по полосам тяжести, среднее с квартилями и ход среднего по неделям",
    en: "Overall state of all patients by scale: completed tests by severity band, mean with quartiles and the weekly course of the mean",
  },
  "ant.statsLine": {
    uk: "середнє {mean} · медіана {median} · квартилі {q1}–{q3} · діапазон {min}–{max} з {top}",
    ru: "среднее {mean} · медиана {median} · квартили {q1}–{q3} · диапазон {min}–{max} из {top}",
    en: "mean {mean} · median {median} · quartiles {q1}–{q3} · range {min}–{max} of {top}",
  },
  "ant.weekly": { uk: "Середнє за тижнями", ru: "Среднее по неделям", en: "Weekly mean" },
  "ant.weeklyHint": {
    uk: "Тижні, де проходжень менше {n}, не показано: середнє трьох людей — це три людини, а не стан",
    ru: "Недели, где прохождений меньше {n}, не показаны: среднее трёх человек — это три человека, а не состояние",
    en: "Weeks with fewer than {n} completions are hidden: the mean of three people is three people, not a state",
  },
  "ant.weeklyTooFew": {
    uk: "Замало даних для ходу за тижнями: потрібно хоча б два тижні по {n} проходжень",
    ru: "Слишком мало данных для хода по неделям: нужно хотя бы две недели по {n} прохождений",
    en: "Not enough data for a weekly course: at least two weeks of {n} completions are needed",
  },
  "ant.alphaHigh": { uk: "Висока узгодженість пунктів", ru: "Высокая согласованность пунктов", en: "High internal consistency" },
  "ant.alphaOk": { uk: "Прийнятна узгодженість пунктів", ru: "Приемлемая согласованность пунктов", en: "Acceptable internal consistency" },
  "ant.alphaLow": { uk: "Низька узгодженість пунктів", ru: "Низкая согласованность пунктов", en: "Low internal consistency" },
  "ant.alphaBasis": {
    uk: "альфа {alpha} · {items} пунктів · {n} проходжень",
    ru: "альфа {alpha} · {items} пунктов · {n} прохождений",
    en: "alpha {alpha} · {items} items · {n} completions",
  },
  "ant.itemsTable": { uk: "Пункти шкали", ru: "Пункты шкалы", en: "Scale items" },
  "ant.validity": {
    uk: "Службова шкала: говорить про заповнення, а не про стан",
    ru: "Служебная шкала: говорит о заполнении, а не о состоянии",
    en: "Validity scale: it describes how the test was filled in, not the person",
  },
  "ant.mdc": {
    uk: "Зміна менша за {n} — у межах похибки вимірювання",
    ru: "Изменение меньше {n} — в пределах погрешности измерения",
    en: "A change smaller than {n} is within measurement error",
  },
  "ant.ceiling": {
    uk: "На стелі шкали {n}% — найважчих вона не розрізняє",
    ru: "На потолке шкалы {n}% — самых тяжёлых она не различает",
    en: "{n}% at the ceiling — the scale does not tell the most severe apart",
  },
  "ant.floor": {
    uk: "На підлозі шкали {n}% — найлегших вона не розрізняє",
    ru: "На полу шкалы {n}% — самых лёгких она не различает",
    en: "{n}% at the floor — the scale does not tell the mildest apart",
  },
  "ant.sortBy": { uk: "Порядок пунктів", ru: "Порядок пунктов", en: "Item order" },
  "ant.sortNumber": { uk: "за номером", ru: "по номеру", en: "by number" },
  "ant.sortSkips": { uk: "за пропусками", ru: "по пропускам", en: "by skips" },
  "ant.sortChanges": { uk: "за змінами відповіді", ru: "по сменам ответа", en: "by answer changes" },
  "ant.sortTime": { uk: "за часом", ru: "по времени", en: "by time" },
  "ant.questionLine": {
    uk: "відповідей {n} · пропуски {skip}% · змінювали відповідь {changed}% · медіана часу {time}",
    ru: "ответов {n} · пропуски {skip}% · меняли ответ {changed}% · медиана времени {time}",
    en: "answers {n} · skipped {skip}% · changed answer {changed}% · median time {time}",
  },
  "ant.numericLine": {
    uk: "середнє {mean} · медіана {median} · діапазон {min}–{max}",
    ru: "среднее {mean} · медиана {median} · диапазон {min}–{max}",
    en: "mean {mean} · median {median} · range {min}–{max}",
  },
  "ant.avgRank": { uk: "середнє місце {n}", ru: "среднее место {n}", en: "average rank {n}" },
  "ant.freeTextNote": {
    uk: "Вільні відповіді можуть містити персональні дані — не виносьте їх за межі системи.",
    ru: "Свободные ответы могут содержать персональные данные — не выносите их за пределы системы.",
    en: "Free-text answers may contain personal data — do not take them outside the system.",
  },
  "ant.showTexts": { uk: "Показати вільні відповіді ({n})", ru: "Показать свободные ответы ({n})", en: "Show free-text answers ({n})" },
  "ant.textsCut": { uk: "Показано перші {n}", ru: "Показаны первые {n}", en: "Showing the first {n}" },
  "ant.noAnswers": { uk: "Відповідей на пункт ще немає", ru: "Ответов на пункт ещё нет", en: "No answers to this item yet" },
  "ant.tooFastTitle": { uk: "Надто швидкі відповіді за пунктами", ru: "Слишком быстрые ответы по пунктам", en: "Too-fast answers by item" },
  "ant.tooFastCaption": {
    uk: "Частка відповідей, швидших за поріг {n} с: пункт не встигли прочитати. Показано пункти, де таке траплялось",
    ru: "Доля ответов быстрее порога {n} с: пункт не успели прочитать. Показаны пункты, где такое случалось",
    en: "Share of answers faster than {n} s: the item could not have been read. Only items where it happened are shown",
  },
  "ant.noFast": { uk: "Надто швидких відповідей немає", ru: "Слишком быстрых ответов нет", en: "No too-fast answers" },
  "ant.durationTitle": { uk: "Тривалість проходження", ru: "Длительность прохождения", en: "Completion time" },
  "ant.durationCaption": {
    uk: "Скільки триває тест від початку до здачі; найдовші 5% — в останньому рядку",
    ru: "Сколько длится тест от начала до сдачи; самые долгие 5% — в последней строке",
    en: "Time from start to submission; the slowest 5% are in the last row",
  },
  "ant.andLonger": { uk: "{n} і довше", ru: "{n} и дольше", en: "{n} and longer" },
  "ant.flaggedLine": {
    uk: "Позначено {n} з {of}. Поріг «надто швидко» — {s} с на пункт.",
    ru: "Помечено {n} из {of}. Порог «слишком быстро» — {s} с на пункт.",
    en: "{n} of {of} flagged. The “too fast” threshold is {s} s per item.",
  },
  "ant.colPatient": { uk: "Пацієнт", ru: "Пациент", en: "Patient" },
  "ant.colDate": { uk: "Дата", ru: "Дата", en: "Date" },
  "ant.rowActions": { uk: "Дії з проходженням", ru: "Действия с прохождением", en: "Completion actions" },
  "ant.openCharts": { uk: "Графіки проходження", ru: "Графики прохождения", en: "Completion charts" },
  "ant.openProtocol": { uk: "Протокол відповідей", ru: "Протокол ответов", en: "Answer record" },
  "ant.noResponses": {
    uk: "Проходжень за цими фільтрами немає",
    ru: "Прохождений по этим фильтрам нет",
    en: "No completions match these filters",
  },
  "ant.pickPatient": {
    uk: "Оберіть пацієнта в полі «Пацієнт» — тут з’являться його проходження цього тесту, динаміка за шкалами і відповіді.",
    ru: "Выберите пациента в поле «Пациент» — здесь появятся его прохождения этого теста, динамика по шкалам и ответы.",
    en: "Pick a patient in the “Patient” field to see their completions of this test, scale dynamics and answers.",
  },
  "ant.openCard": { uk: "Картка пацієнта", ru: "Карточка пациента", en: "Patient card" },
  "ant.patientResponses": { uk: "Проходження пацієнта", ru: "Прохождения пациента", en: "Patient’s completions" },
  "ant.patientDynamics": { uk: "Динаміка за шкалами", ru: "Динамика по шкалам", en: "Dynamics by scale" },
  "ant.dynamicsCaption": {
    uk: "Усі завершені проходження цього тесту за всіма версіями; тло — сходи тяжкості шкали",
    ru: "Все завершённые прохождения этого теста по всем версиям; фон — лестница тяжести шкалы",
    en: "All completed tests across versions; the background is the scale’s severity ladder",
  },
  "ant.answersChange": { uk: "Як змінювались відповіді", ru: "Как менялись ответы", en: "How the answers changed" },
  "ant.answersCaption": {
    uk: "Останні {n} проходжень цієї версії; у клітинці — обраний варіант і його бал, тон — бал від максимуму пункту",
    ru: "Последние {n} прохождений этой версии; в клетке — выбранный вариант и его балл, тон — балл от максимума пункта",
    en: "The last {n} completions of this version; each cell shows the chosen option and its score, shaded by the item maximum",
  },
  "ant.cellSkipped": { uk: "пропуск", ru: "пропуск", en: "skipped" },
  "ant.cellHidden": { uk: "відповідь є", ru: "ответ есть", en: "answered" },
  "ant.cellChanged": { uk: "змінював відповідь", ru: "менял ответ", en: "changed the answer" },
  "ant.timeByResponse": { uk: "Час за проходженнями", ru: "Время по прохождениям", en: "Time per completion" },
  "ant.noPatientResponses": {
    uk: "Цей пацієнт не проходив тест за вибраними фільтрами",
    ru: "Этот пациент не проходил тест по выбранным фильтрам",
    en: "This patient has no completions matching the filters",
  },
  "ant.bandsEmpty": { uk: "Завершених проходжень зі смугою ще немає", ru: "Завершённых прохождений с полосой ещё нет", en: "No completed tests with a band yet" },
  "ant.exportsTitle": { uk: "Вивантаження", ru: "Выгрузки", en: "Exports" },
  "ant.versionsTitle": { uk: "Порівняння версій", ru: "Сравнение версий", en: "Version comparison" },
  "ant.versionFrom": { uk: "Стара версія", ru: "Старая версия", en: "Earlier version" },
  "ant.versionTo": { uk: "Нова версія", ru: "Новая версия", en: "Later version" },
  "ant.profileTitle": { uk: "Медіана за шкалами", ru: "Медиана по шкалам", en: "Median by scale" },
  "ant.profileCaption": {
    uk: "Де на сходах тяжкості кожної шкали лежить медіана всіх завершених проходжень",
    ru: "Где на лестнице тяжести каждой шкалы лежит медиана всех завершённых прохождений",
    en: "Where the median of all completed tests falls on each scale’s severity ladder",
  },

  /* ── wave9:content ── */

  /* ── wave9:kit ── */
  "kit.thisOne": { uk: "це проходження", ru: "это прохождение", en: "this completion" },
  "kit.hidden": { uk: "приховано: замало людей", ru: "скрыто: слишком мало людей", en: "hidden: too few people" },

  /* ── wave9:dashboard ── */
  /*
   * Стартовый экран «Зведення»: шапка, очередь, проходження, стан пацієнтів
   * за напрямами (pages/Dashboard.tsx, pages/dashboard/*). Решение заказчика
   * 2026-09-26: заголовок экрана не повторяет вкладку — первая вкладка
   * называется «Огляд».
   */
  "dash.tabOverview": { uk: "Огляд", ru: "Обзор", en: "Overview" },
  "dash.overdueTag": { uk: "Прострочено", ru: "Просрочено", en: "Overdue" },
  "dash.workAll": { uk: "усі {n}", ru: "все {n}", en: "all {n}" },
  "dash.passes": { uk: "Проходження за останній час", ru: "Прохождения за последнее время", en: "Recent completions" },
  "dash.rangeLabel": { uk: "Період", ru: "Период", en: "Period" },
  "dash.range30d": { uk: "30 днів", ru: "30 дней", en: "30 days" },
  "dash.range90d": { uk: "90 днів", ru: "90 дней", en: "90 days" },
  "dash.range12w": { uk: "12 тижнів", ru: "12 недель", en: "12 weeks" },
  "dash.last30d": { uk: "За 30 днів", ru: "За 30 дней", en: "Last 30 days" },
  "dash.last12w": { uk: "За 12 тижнів", ru: "За 12 недель", en: "Last 12 weeks" },
  "dash.prevPeriod": { uk: "попередній такий самий період: {n}", ru: "предыдущий такой же период: {n}", en: "previous period of the same length: {n}" },
  "dash.halfYear": { uk: "лінія — хід за пів року, за тижнями", ru: "линия — ход за полгода, по неделям", en: "line: the last six months, by week" },
  "dash.byDay": { uk: "Завершені проходження за днями", ru: "Завершённые прохождения по дням", en: "Completed responses by day" },
  "dash.byWeek": { uk: "Завершені проходження за тижнями", ru: "Завершённые прохождения по неделям", en: "Completed responses by week" },
  "dash.byWeekHint": { uk: "тиждень підписано понеділком", ru: "неделя подписана понедельником", en: "each week is labelled by its Monday" },
  "dash.conditions": { uk: "Стан пацієнтів за напрямами", ru: "Состояние пациентов по направлениям", en: "Patient state by domain" },
  "dash.conditionsHint": {
    uk: "Останній замір кожної людини за період. Частка — скільки людей у смугах «помірна» і «виражена» за смугами самої методики. Бали різних методик не додаються, тому середній бал — лише за основною методикою напряму, у відсотках від її максимуму. Групи, менші за 5 людей, не показуються.",
    ru: "Последний замер каждого человека за период. Доля — сколько людей в полосах «умеренная» и «выраженная» по полосам самой методики. Баллы разных методик не складываются, поэтому средний балл — только по основной методике направления, в процентах от её максимума. Группы меньше 5 человек не показываются.",
    en: "Each person's latest measurement in the period. The share is how many people fall in the moderate and severe bands of the instrument itself. Scores of different instruments do not add up, so the mean score is given only for the main instrument of the domain, as a percentage of its maximum. Groups of fewer than 5 people are not shown.",
  },
  "dash.dom.depression": { uk: "Депресія", ru: "Депрессия", en: "Depression" },
  "dash.dom.anxiety": { uk: "Тривога", ru: "Тревога", en: "Anxiety" },
  "dash.dom.stress": { uk: "Стрес", ru: "Стресс", en: "Stress" },
  "dash.dom.ptsd": { uk: "ПТСР", ru: "ПТСР", en: "PTSD" },
  "dash.dom.wellbeing": { uk: "Благополуччя", ru: "Благополучие", en: "Well-being" },
  "dash.dom.burnout": { uk: "Вигорання", ru: "Выгорание", en: "Burnout" },
  "dash.dom.alcohol": { uk: "Алкоголь", ru: "Алкоголь", en: "Alcohol" },
  "dash.clinical": { uk: "у клінічних смугах", ru: "в клинических полосах", en: "in clinical bands" },
  "dash.clinicalWhat": { uk: "помірна або виражена", ru: "умеренная или выраженная", en: "moderate or severe" },
  "dash.people": { uk: "Людей", ru: "Человек", en: "People" },
  "dash.mean": { uk: "Середній бал", ru: "Средний балл", en: "Mean score" },
  "dash.ofMax": { uk: "{p} % від максимуму", ru: "{p} % от максимума", en: "{p}% of maximum" },
  "dash.higherBetter": { uk: "вище — краще", ru: "выше — лучше", en: "higher is better" },
  "dash.higherWorse": { uk: "вище — гірше", ru: "выше — хуже", en: "higher is worse" },
  "dash.meanWeekly": { uk: "середній бал за тижнями; тижні, де менше 5 людей, пропущено", ru: "средний балл по неделям; недели, где меньше 5 человек, пропущены", en: "mean score by week; weeks with fewer than 5 people are skipped" },
  "dash.sources": { uk: "Методики", ru: "Методики", en: "Instruments" },
  "dash.tooFew": { uk: "Замало даних: менше 5 людей, тому числа не показуються", ru: "Слишком мало данных: меньше 5 человек, поэтому числа не показываются", en: "Too little data: fewer than 5 people, so no figures are shown" },
  "dash.shareHidden": { uk: "Частку приховано: в одній зі смуг менше 5 людей", ru: "Доля скрыта: в одной из полос меньше 5 человек", en: "Share hidden: one of the bands has fewer than 5 people" },
  "dash.noBands": { uk: "У методики немає смуг вираженості — частку не пораховано", ru: "У методики нет полос выраженности — доля не посчитана", en: "The instrument has no severity bands, so there is no share" },
  "dash.noMeasures": { uk: "Немає замірів", ru: "Нет замеров", en: "No measurements" },
  "dash.nothingMeasured": { uk: "За період жодна методика напрямів не проходилася", ru: "За период ни одна методика направлений не проходилась", en: "No domain instrument was completed in this period" },
  "dash.overall": { uk: "Усі методики разом", ru: "Все методики вместе", en: "All instruments together" },
  "dash.overallHint": { uk: "кожна людина один раз — за найважчою з останніх оцінок", ru: "каждый человек один раз — по самой тяжёлой из последних оценок", en: "each person once, by the most severe of their latest results" },
  "dash.bandLow": { uk: "Норма або легка", ru: "Норма или лёгкая", en: "Normal or mild" },
  "dash.bandHigh": { uk: "Помірна або виражена", ru: "Умеренная или выраженная", en: "Moderate or severe" },

  /* ── wave9:cohorts ── */
  /* «Добір людей» — решение заказчика 2026-09-26: стиль проекта, адекватные фильтры, понятный результат */
  "coh.lede": {
    uk: "Звужуйте вибірку умовами — число й розподіли оновлюються одразу. Імена показуються окремою дією і фіксуються в журналі.",
    ru: "Сужайте выборку условиями — число и распределения обновляются сразу. Имена показываются отдельным действием и фиксируются в журнале.",
    en: "Narrow the sample with conditions — the count and distributions update at once. Names are a separate action and are logged.",
  },
  "coh.who": { uk: "Кого шукаємо", ru: "Кого ищем", en: "Who we are looking for" },
  "coh.result": { uk: "Що вийшло", ru: "Что получилось", en: "What we found" },
  "coh.actions": { uk: "Що з ними зробити", ru: "Что с ними сделать", en: "What to do with them" },
  "coh.namesTitle": { uk: "Поіменно", ru: "Поимённо", en: "By name" },
  "coh.age": { uk: "Вік", ru: "Возраст", en: "Age" },
  "coh.ageHint": { uk: "повних років на момент проходження", ru: "полных лет на момент прохождения", en: "full years at the time of the assessment" },
  "coh.fromWord": { uk: "від", ru: "от", en: "from" },
  "coh.errAge": { uk: "Вік «від» більший за «до»", ru: "Возраст «от» больше, чем «до»", en: "Age “from” is greater than “to”" },
  "coh.errPeriod": { uk: "Початок періоду пізніше за кінець", ru: "Начало периода позже конца", en: "The period starts after it ends" },
  "coh.anyUnit": { uk: "усі підрозділи", ru: "все подразделения", en: "all units" },
  "coh.anyLocality": { uk: "усі населені пункти", ru: "все населённые пункты", en: "all localities" },
  "coh.pickSearch": { uk: "Пошук у списку", ru: "Поиск в списке", en: "Search the list" },
  "coh.pickClear": { uk: "Зняти всі", ru: "Снять все", en: "Clear all" },
  "coh.noOptions": {
    uk: "Серед людей вашої зони це поле ніхто не заповнив",
    ru: "Среди людей вашей зоны это поле никто не заполнил",
    en: "No one in your scope has this field filled in",
  },
  "coh.survey": { uk: "Методика", ru: "Методика", en: "Assessment" },
  "coh.period": { uk: "Період проходження", ru: "Период прохождения", en: "Completion period" },
  "coh.severity": { uk: "Вираженість", ru: "Выраженность", en: "Severity" },
  "coh.severityAtLeast": { uk: "Вираженість — не нижче", ru: "Выраженность — не ниже", en: "Severity — at least" },
  "coh.anySeverity": { uk: "будь-яка", ru: "любая", en: "any" },
  "coh.andAbove": { uk: "і вище", ru: "и выше", en: "or higher" },
  "coh.severityHint": {
    uk: "найтяжча смуга хоча б однієї шкали в проходженнях вибірки",
    ru: "самая тяжёлая полоса хотя бы одной шкалы в прохождениях выборки",
    en: "the most severe band of at least one scale in the sample’s completions",
  },
  "coh.extra": { uk: "Додатково", ru: "Дополнительно", en: "Also" },
  "coh.scaleConds": { uk: "Умови за шкалами", ru: "Условия по шкалам", en: "Scale conditions" },
  "coh.scaleNeedSurvey": {
    uk: "Оберіть методику, щоб задати умови за її шкалами",
    ru: "Выберите методику, чтобы задать условия по её шкалам",
    en: "Pick an assessment to set conditions on its scales",
  },
  "coh.noScales": { uk: "У цієї методики немає шкал", ru: "У этой методики нет шкал", en: "This assessment has no scales" },
  "coh.scale": { uk: "Шкала", ru: "Шкала", en: "Scale" },
  "coh.operator": { uk: "Умова", ru: "Условие", en: "Condition" },
  "coh.value": { uk: "Бал", ru: "Балл", en: "Score" },
  "coh.opGte": { uk: "не менше ніж", ru: "не меньше чем", en: "at least" },
  "coh.opLte": { uk: "не більше ніж", ru: "не больше чем", en: "at most" },
  "coh.opGt": { uk: "більше ніж", ru: "больше чем", en: "more than" },
  "coh.opLt": { uk: "менше ніж", ru: "меньше чем", en: "less than" },
  "coh.scaleRange": { uk: "межі шкали", ru: "границы шкалы", en: "scale range" },
  "coh.noConditions": {
    uk: "Умов немає — у вибірці всі люди вашої зони",
    ru: "Условий нет — в выборке все люди вашей зоны",
    en: "No conditions — everyone in your scope is in the sample",
  },
  "coh.removeTag": { uk: "Прибрати", ru: "Убрать", en: "Remove" },
  "coh.activeConditions": { uk: "Умови вибірки", ru: "Условия выборки", en: "Sample conditions" },
  "coh.everyone": { uk: "Усі люди вашої зони", ru: "Все люди вашей зоны", en: "Everyone in your scope" },
  "coh.counting": { uk: "Рахуємо…", ru: "Считаем…", en: "Counting…" },
  "coh.floorHint": {
    uk: "Числа, менші за поріг, не показуються: у малій групі вони вказують на конкретних людей. Поріг —",
    ru: "Числа меньше порога не показываются: в малой группе они указывают на конкретных людей. Порог —",
    en: "Numbers below the threshold are not shown: in a small group they point at specific people. Threshold —",
  },
  "coh.nobody": { uk: "Нікого не знайдено — послабте умови", ru: "Никого не найдено — ослабьте условия", en: "Nobody found — loosen the conditions" },
  "coh.byAge": { uk: "За віком", ru: "По возрасту", en: "By age" },
  "coh.byLocality": { uk: "За населеним пунктом", ru: "По населённому пункту", en: "By locality" },
  "coh.ageUnder25": { uk: "до 25", ru: "до 25", en: "under 25" },
  "coh.unknown": { uk: "не вказано", ru: "не указано", en: "not specified" },
  "coh.noBands": { uk: "без смуг", ru: "без полос", en: "no bands" },
  "coh.more": { uk: "ще", ru: "ещё", en: "more" },
  "coh.less": { uk: "згорнути", ru: "свернуть", en: "collapse" },
  "coh.sharesNote": {
    uk: "Частка — від усієї вибірки; довжина смуги — від найбільшого рядка розбивки. Прочерк — приховано порогом.",
    ru: "Доля — от всей выборки; длина полосы — от самой большой строки разбивки. Прочерк — скрыто порогом.",
    en: "Share is of the whole sample; bar length is relative to the largest row. A dash means hidden by the threshold.",
  },
  "coh.csv": { uk: "Вивантажити розбивки (CSV)", ru: "Выгрузить разбивки (CSV)", en: "Export breakdowns (CSV)" },
  "coh.csvSection": { uk: "Розбивка", ru: "Разбивка", en: "Breakdown" },
  "coh.csvValue": { uk: "Значення", ru: "Значение", en: "Value" },
  "coh.csvCount": { uk: "Осіб", ru: "Человек", en: "People" },
  "coh.csvShare": { uk: "Частка, %", ru: "Доля, %", en: "Share, %" },
  "coh.csvHidden": { uk: "Приховано", ru: "Скрыто", en: "Hidden" },
  "coh.csvYes": { uk: "так", ru: "да", en: "yes" },
  "coh.toStats": { uk: "Відкрити у статистиці", ru: "Открыть в статистике", en: "Open in statistics" },
  "coh.toStatsTitle": { uk: "Пресет фільтрів для статистики", ru: "Пресет фильтров для статистики", en: "Filter preset for statistics" },
  "coh.toStatsLede": {
    uk: "Статистика рахує частки за моделлю, а вибірку бере з пресету фільтрів. У пресет перейдуть:",
    ru: "Статистика считает доли по модели, а выборку берёт из пресета фильтров. В пресет перейдут:",
    en: "Statistics counts shares by a model and takes the sample from a filter preset. The preset will get:",
  },
  "coh.toStatsDropped": {
    uk: "Не перейдуть — у пресеті статистики таких умов немає:",
    ru: "Не перейдут — в пресете статистики таких условий нет:",
    en: "Will not carry over — a statistics preset has no such conditions:",
  },
  "coh.toStatsNothing": {
    uk: "Жодна умова не переноситься — пресет відбиратиме всіх",
    ru: "Ни одно условие не переносится — пресет будет отбирать всех",
    en: "No condition carries over — the preset would take everyone",
  },
  "coh.presetName": { uk: "Назва пресету", ru: "Название пресета", en: "Preset name" },
  "coh.createPreset": { uk: "Створити пресет", ru: "Создать пресет", en: "Create preset" },
  "coh.updateSaved": { uk: "Оновити збережену", ru: "Обновить сохранённую", en: "Update saved" },
  "coh.savedDone": { uk: "Вибірку збережено", ru: "Выборка сохранена", en: "Sample saved" },
  "coh.updatedDone": { uk: "Умови збереженої вибірки оновлено", ru: "Условия сохранённой выборки обновлены", en: "Saved sample updated" },
  "coh.namesSuppressed": {
    uk: "Вибірка менша за поріг — імена не показуються. Поріг —",
    ru: "Выборка меньше порога — имена не показываются. Порог —",
    en: "The sample is below the threshold — names are not shown. Threshold —",
  },
  "coh.namesTruncated": {
    uk: "Список обрізано: людей більше, ніж уміщує екран. Звузьте умови.",
    ru: "Список обрезан: людей больше, чем помещается на экране. Сузьте условия.",
    en: "The list is cut: there are more people than fit on screen. Narrow the conditions.",
  },
  "coh.selectAll": { uk: "Вибрати всіх", ru: "Выбрать всех", en: "Select all" },
  "coh.lastResult": { uk: "останнє проходження", ru: "последнее прохождение", en: "latest completion" },
  "coh.hideNames": { uk: "Сховати список", ru: "Скрыть список", en: "Hide the list" },
  "coh.open": { uk: "Відкрити", ru: "Открыть", en: "Open" },
  "coh.rename": { uk: "Перейменувати", ru: "Переименовать", en: "Rename" },
  "coh.deleteConfirm": {
    uk: "Видалити цю збережену вибірку? Люди й результати не зміняться — зникне лише правило відбору.",
    ru: "Удалить эту сохранённую выборку? Люди и результаты не изменятся — исчезнет только правило отбора.",
    en: "Delete this saved sample? People and results stay as they are — only the selection rule goes.",
  },
  "coh.deleted": { uk: "Вибірку видалено", ru: "Выборка удалена", en: "Sample deleted" },
  "coh.renamed": { uk: "Назву змінено", ru: "Название изменено", en: "Renamed" },
  "coh.savedActions": { uk: "Дії зі збереженою вибіркою", ru: "Действия с сохранённой выборкой", en: "Saved sample actions" },
  "coh.opened": { uk: "відкрита", ru: "открыта", en: "open" },
  "coh.changed": { uk: "відкрита, умови змінено", ru: "открыта, условия изменены", en: "open, conditions changed" },
  /* «Статистика»: доводка по замечаниям 2026-09-26 */
  "st.percentPending": {
    uk: "Відсотки з’являться після «Порівняти»",
    ru: "Проценты появятся после «Сравнить»",
    en: "Percentages appear after “Compare”",
  },
  "st.filterEdit": { uk: "Зміна фільтра", ru: "Изменение фильтра", en: "Edit filter" },
  "st.clearDate": { uk: "Очистити", ru: "Очистить", en: "Clear" },

  /* ── wave9:shell ── */

  /* ── wave9:staff ── */

  /*
   * Якоря волны 10 (техпанель для разработчиков, /ops): оболочка — у
   * координатора, наблюдаемость и учётные записи — у своих сборщиков.
   */
  /* ── wave10:ops-shell ── */
  "nav.ops": { uk: "Техпанель", ru: "Техпанель", en: "Tech panel" },
  "ops.title": { uk: "Техпанель", ru: "Техпанель", en: "Tech panel" },
  "ops.tab.overview": { uk: "Огляд", ru: "Обзор", en: "Overview" },
  "ops.tab.requests": { uk: "Запити", ru: "Запросы", en: "Requests" },
  "ops.tab.errors": { uk: "Помилки", ru: "Ошибки", en: "Errors" },
  "ops.tab.logs": { uk: "Логи", ru: "Логи", en: "Logs" },
  "ops.tab.db": { uk: "База", ru: "База", en: "Database" },
  "ops.tab.jobs": { uk: "Фонові задачі", ru: "Фоновые задачи", en: "Background jobs" },
  "ops.tab.users": { uk: "Користувачі", ru: "Пользователи", en: "Users" },
  "ops.tab.sessions": { uk: "Сесії", ru: "Сессии", en: "Sessions" },
  "ops.tab.audit": { uk: "Аудит", ru: "Аудит", en: "Audit" },

  "ops.group.system": { uk: "Система", ru: "Система", en: "System" },
  "ops.group.operations": { uk: "Експлуатація", ru: "Эксплуатация", en: "Operations" },
  "ops.group.people": { uk: "Люди й безпека", ru: "Люди и безопасность", en: "People and security" },
  "ops.group.data": { uk: "Дані й продукт", ru: "Данные и продукт", en: "Data and product" },

  /* ── wave10:ops ── */
  /*
   * Техпанель: наблюдаемость (pages/ops — Огляд, Запити, Помилки, Логи,
   * База, Фонові задачі). Коды сервера (статусы проверок, состояния
   * подключений, уровни лога) переводятся здесь, а не на сервере: фразу
   * собирает консоль на языке того, кто смотрит.
   */
  "ops.since": { uk: "Дані з моменту запуску процесу — {time}. Після перезапуску лічба починається заново.", ru: "Данные с момента запуска процесса — {time}. После перезапуска счёт начинается заново.", en: "Data since the process started — {time}. A restart starts the count over." },
  "ops.updated": { uk: "оновлено о {time}", ru: "обновлено в {time}", en: "updated at {time}" },
  "ops.never": { uk: "ще не було", ru: "ещё не было", en: "not yet" },
  "ops.copyId": { uk: "Скопіювати номер запиту", ru: "Скопировать номер запроса", en: "Copy request ID" },
  "ops.idCopied": { uk: "Номер запиту скопійовано", ru: "Номер запроса скопирован", en: "Request ID copied" },
  "ops.copyFailed": { uk: "Не вдалося скопіювати", ru: "Не удалось скопировать", en: "Could not copy" },
  "ops.status.ok": { uk: "гаразд", ru: "в порядке", en: "ok" },
  "ops.status.warn": { uk: "попередження", ru: "предупреждение", en: "warning" },
  "ops.status.fail": { uk: "збій", ru: "сбой", en: "failure" },

  "ops.kpi.requests": { uk: "Запитів за годину", ru: "Запросов за час", en: "Requests, last hour" },
  "ops.kpi.requestsHint": { uk: "за 5 хв — {m5}, за добу — {h24}", ru: "за 5 мин — {m5}, за сутки — {h24}", en: "{m5} in 5 min, {h24} in 24 h" },
  "ops.kpi.share5xx": { uk: "Частка 5xx за годину", ru: "Доля 5xx за час", en: "5xx share, last hour" },
  "ops.kpi.share5xxHint": { uk: "помилок сервера: {n}", ru: "ошибок сервера: {n}", en: "server errors: {n}" },
  "ops.kpi.p95": { uk: "p95 відповіді за годину", ru: "p95 ответа за час", en: "Response p95, last hour" },
  "ops.kpi.p95Hint": { uk: "p50 {p50} · макс. {max}", ru: "p50 {p50} · макс. {max}", en: "p50 {p50} · max {max}" },
  "ops.kpi.uptime": { uk: "Працює", ru: "Работает", en: "Uptime" },
  "ops.kpi.uptimeHint": { uk: "з {time}", ru: "с {time}", en: "since {time}" },
  "ops.kpi.memory": { uk: "Пам’ять процесу", ru: "Память процесса", en: "Process memory" },
  "ops.kpi.memoryHint": { uk: "купа {used} з {total}", ru: "куча {used} из {total}", en: "heap {used} of {total}" },
  "ops.kpi.dbConn": { uk: "Підключень до бази", ru: "Подключений к базе", en: "Database connections" },
  "ops.kpi.dbConnHint": { uk: "з {max} дозволених", ru: "из {max} разрешённых", en: "of {max} allowed" },
  "ops.kpi.dbConnHidden": { uk: "немає прав на pg_stat_activity", ru: "нет прав на pg_stat_activity", en: "no access to pg_stat_activity" },

  "ops.traffic.title": { uk: "Навантаження", ru: "Нагрузка", en: "Load" },
  "ops.traffic.window": { uk: "Період графіка", ru: "Период графика", en: "Chart period" },
  "ops.window.1h": { uk: "Година", ru: "Час", en: "Hour" },
  "ops.window.24h": { uk: "Доба", ru: "Сутки", en: "24 hours" },
  "ops.traffic.requests": { uk: "Запити", ru: "Запросы", en: "Requests" },
  "ops.traffic.step": { uk: "Стовпець — {step}", ru: "Столбец — {step}", en: "One column per {step}" },
  "ops.traffic.latency": { uk: "Час відповіді", ru: "Время ответа", en: "Response time" },
  "ops.traffic.latencyHint": { uk: "Лінія — p95, смуга — від p50 до p99; лише проміжки, в яких були запити", ru: "Линия — p95, полоса — от p50 до p99; только промежутки, в которых были запросы", en: "Line is p95, band spans p50 to p99; only intervals that had requests" },
  "ops.traffic.p95": { uk: "p95", ru: "p95", en: "p95" },

  "ops.health.title": { uk: "Перевірки", ru: "Проверки", en: "Health checks" },
  "ops.health.hint": { uk: "Про ключі й токени — лише «задано / не задано»: їхні значення сюди не потрапляють ніколи.", ru: "О ключах и токенах — только «задано / не задано»: их значения сюда не попадают никогда.", en: "Keys and tokens are reported only as set or not set; their values never appear here." },
  "ops.health.db": { uk: "База даних", ru: "База данных", en: "Database" },
  "ops.health.db.up": { uk: "відповідає за {n}", ru: "отвечает за {n}", en: "responds in {n}" },
  "ops.health.db.down": { uk: "не відповідає", ru: "не отвечает", en: "not responding" },
  "ops.health.rls": { uk: "Політики рядків (RLS)", ru: "Политики строк (RLS)", en: "Row-level security" },
  "ops.health.rls.active": { uk: "діють для ролі застосунку", ru: "действуют для роли приложения", en: "enforced for the application role" },
  "ops.health.rls.bypass": { uk: "роль застосунку їх обходить — кожен бачить усе", ru: "роль приложения их обходит — каждый видит всё", en: "the application role bypasses them — everyone sees everything" },
  "ops.health.rls.unknown": { uk: "не вдалося перевірити", ru: "не удалось проверить", en: "could not be checked" },
  "ops.health.migrations": { uk: "Міграції", ru: "Миграции", en: "Migrations" },
  "ops.health.migrations.current": { uk: "застосовано всі {n}", ru: "применены все {n}", en: "all {n} applied" },
  "ops.health.migrations.pending": { uk: "не застосовано {n} — код новіший за схему", ru: "не применено {n} — код новее схемы", en: "{n} not applied — the code is newer than the schema" },
  "ops.health.migrations.unknown": { uk: "немає доступу до журналу міграцій", ru: "нет доступа к журналу миграций", en: "no access to the migration log" },
  "ops.health.scheduler": { uk: "Планувальник", ru: "Планировщик", en: "Scheduler" },
  "ops.health.scheduler.fresh": { uk: "останній такт {n} хв тому", ru: "последний такт {n} мин назад", en: "last tick {n} min ago" },
  "ops.health.scheduler.stale": { uk: "останній такт {n} хв тому — довше за два такти", ru: "последний такт {n} мин назад — дольше двух тактов", en: "last tick {n} min ago — longer than two intervals" },
  "ops.health.scheduler.never": { uk: "у цьому процесі ще не запускався", ru: "в этом процессе ещё не запускался", en: "has not run in this process yet" },
  "ops.health.scheduler.disabled": { uk: "вимкнено на цьому екземплярі (SCHEDULER_ENABLED=0)", ru: "выключен на этом экземпляре (SCHEDULER_ENABLED=0)", en: "disabled on this instance (SCHEDULER_ENABLED=0)" },
  "ops.health.encryption": { uk: "Ключ шифрування", ru: "Ключ шифрования", en: "Encryption key" },
  "ops.health.encryption.set": { uk: "задано", ru: "задан", en: "set" },
  "ops.health.encryption.missing": { uk: "не задано — персональні поля пишуться відкритим текстом", ru: "не задан — персональные поля пишутся открытым текстом", en: "not set — personal fields are stored in plain text" },
  "ops.health.errorReport": { uk: "Збір помилок", ru: "Сбор ошибок", en: "Error reporting" },
  "ops.health.errorReport.set": { uk: "SENTRY_DSN задано", ru: "SENTRY_DSN задан", en: "SENTRY_DSN is set" },
  "ops.health.errorReport.missing": { uk: "SENTRY_DSN не задано — помилки видно лише тут і в лозі", ru: "SENTRY_DSN не задан — ошибки видны только здесь и в логе", en: "SENTRY_DSN is not set — errors are visible only here and in the log" },
  "ops.health.metricsToken": { uk: "Токен метрик", ru: "Токен метрик", en: "Metrics token" },
  "ops.health.metricsToken.set": { uk: "METRICS_TOKEN задано", ru: "METRICS_TOKEN задан", en: "METRICS_TOKEN is set" },
  "ops.health.metricsToken.missing": { uk: "METRICS_TOKEN не задано — /metrics вимкнено", ru: "METRICS_TOKEN не задан — /metrics выключен", en: "METRICS_TOKEN is not set — /metrics is off" },
  "ops.health.errorRate": { uk: "Частка помилок сервера", ru: "Доля ошибок сервера", en: "Server error rate" },
  "ops.health.errorRate.low": { uk: "{n} за годину", ru: "{n} за час", en: "{n} in the last hour" },
  "ops.health.errorRate.high": { uk: "{n} за годину — більше за 1%", ru: "{n} за час — больше 1%", en: "{n} in the last hour — above 1%" },
  "ops.health.errorRate.quiet": { uk: "за годину запитів не було", ru: "за час запросов не было", en: "no requests in the last hour" },

  "ops.build.title": { uk: "Збірка", ru: "Сборка", en: "Build" },
  "ops.build.version": { uk: "Версія випуску", ru: "Версия выпуска", en: "Release version" },
  "ops.build.commit": { uk: "Збірка (QUIZZY_BUILD)", ru: "Сборка (QUIZZY_BUILD)", en: "Build (QUIZZY_BUILD)" },
  "ops.build.package": { uk: "Версія пакета", ru: "Версия пакета", en: "Package version" },
  "ops.build.env": { uk: "Режим", ru: "Режим", en: "Mode" },
  "ops.build.runtime": { uk: "Середовище виконання", ru: "Среда выполнения", en: "Runtime" },
  "ops.build.started": { uk: "Процес запущено", ru: "Процесс запущен", en: "Process started" },
  "ops.build.unset": { uk: "не задано", ru: "не задано", en: "not set" },
  "ops.env.production": { uk: "робочий", ru: "боевой", en: "production" },
  "ops.env.development": { uk: "розробка", ru: "разработка", en: "development" },
  "ops.proc.load": { uk: "Навантаження ОС", ru: "Нагрузка ОС", en: "OS load average" },
  "ops.proc.cpus": { uk: "ядер: {n}", ru: "ядер: {n}", en: "{n} cores" },
  "ops.proc.lag": { uk: "Затримка циклу подій", ru: "Задержка цикла событий", en: "Event loop delay" },
  "ops.proc.lagValue": { uk: "у середньому {mean}, найбільша {max}", ru: "в среднем {mean}, наибольшая {max}", en: "mean {mean}, max {max}" },
  "ops.proc.lagNone": { uk: "ще немає замірів", ru: "ещё нет замеров", en: "no samples yet" },

  "ops.data.title": { uk: "База й дані", ru: "База и данные", en: "Database and data" },
  "ops.data.size": { uk: "Розмір бази", ru: "Размер базы", en: "Database size" },
  "ops.data.latency": { uk: "Відповідь бази", ru: "Ответ базы", en: "Database round trip" },
  "ops.data.migration": { uk: "Остання міграція", ru: "Последняя миграция", en: "Latest migration" },
  "ops.data.pending": { uk: "не застосовано: {n}", ru: "не применено: {n}", en: "not applied: {n}" },
  "ops.data.tick": { uk: "Такт планувальника", ru: "Такт планировщика", en: "Scheduler tick" },
  "ops.data.tickOff": { uk: "вимкнено на цьому екземплярі", ru: "выключен на этом экземпляре", en: "disabled on this instance" },
  "ops.data.cases": { uk: "Відкриті випадки ризику", ru: "Открытые случаи риска", en: "Open risk cases" },
  "ops.data.accounts": { uk: "Облікові записи", ru: "Учётные записи", en: "Accounts" },

  "ops.routes.title": { uk: "Маршрути", ru: "Маршруты", en: "Routes" },
  "ops.routes.hint": { uk: "Шаблон маршруту, а не адреса: ідентифікатори людей у зведення не потрапляють. Перцентилі — за кошиками гістограми.", ru: "Шаблон маршрута, а не адрес: идентификаторы людей в сводку не попадают. Перцентили — по корзинам гистограммы.", en: "Route templates, not addresses: people’s identifiers never reach this summary. Percentiles come from histogram buckets." },
  "ops.routes.search": { uk: "Пошук маршруту", ru: "Поиск маршрута", en: "Search routes" },
  "ops.routes.sortLabel": { uk: "Порядок", ru: "Порядок", en: "Order" },
  "ops.routes.byCount": { uk: "За числом", ru: "По числу", en: "By count" },
  "ops.routes.byP95": { uk: "За p95", ru: "По p95", en: "By p95" },
  "ops.routes.byErrors": { uk: "За помилками", ru: "По ошибкам", en: "By errors" },
  "ops.routes.empty": { uk: "Запитів з моменту запуску ще не було", ru: "Запросов с момента запуска ещё не было", en: "No requests since the process started" },
  "ops.routes.noMatch": { uk: "Таких маршрутів немає", ru: "Таких маршрутов нет", en: "No matching routes" },

  "ops.col.route": { uk: "Маршрут", ru: "Маршрут", en: "Route" },
  "ops.col.count": { uk: "Запитів", ru: "Запросов", en: "Requests" },
  "ops.col.c4": { uk: "4xx", ru: "4xx", en: "4xx" },
  "ops.col.c5": { uk: "5xx", ru: "5xx", en: "5xx" },
  "ops.col.avg": { uk: "Середнє", ru: "Среднее", en: "Mean" },
  "ops.col.p50": { uk: "p50", ru: "p50", en: "p50" },
  "ops.col.p95": { uk: "p95", ru: "p95", en: "p95" },
  "ops.col.p99": { uk: "p99", ru: "p99", en: "p99" },
  "ops.col.max": { uk: "Макс.", ru: "Макс.", en: "Max" },
  "ops.col.time": { uk: "Час", ru: "Время", en: "Time" },
  "ops.col.method": { uk: "Метод", ru: "Метод", en: "Method" },
  "ops.col.code": { uk: "Код", ru: "Код", en: "Code" },
  "ops.col.ms": { uk: "мс", ru: "мс", en: "ms" },
  "ops.col.requestId": { uk: "Номер запиту", ru: "Номер запроса", en: "Request ID" },
  "ops.col.table": { uk: "Таблиця", ru: "Таблица", en: "Table" },
  "ops.col.live": { uk: "Живих рядків", ru: "Живых строк", en: "Live rows" },
  "ops.col.dead": { uk: "Мертвих", ru: "Мёртвых", en: "Dead" },
  "ops.col.seqScan": { uk: "Повних читань", ru: "Полных чтений", en: "Seq scans" },
  "ops.col.idxScan": { uk: "За індексом", ru: "По индексу", en: "Index scans" },
  "ops.col.vacuum": { uk: "Автоочищення", ru: "Автоочистка", en: "Autovacuum" },
  "ops.col.pid": { uk: "PID", ru: "PID", en: "PID" },
  "ops.col.lasts": { uk: "Триває", ru: "Длится", en: "Running" },
  "ops.col.state": { uk: "Стан", ru: "Состояние", en: "State" },
  "ops.col.wait": { uk: "Чекає на подію", ru: "Ждёт события", en: "Wait event" },
  "ops.col.query": { uk: "Запит", ru: "Запрос", en: "Query" },
  "ops.col.waits": { uk: "Чекає", ru: "Ждёт", en: "Waiting" },
  "ops.col.lock": { uk: "Блокування", ru: "Блокировка", en: "Lock" },
  "ops.col.blockedBy": { uk: "Чекає на PID", ru: "Ждёт PID", en: "Blocked by" },
  "ops.col.number": { uk: "№", ru: "№", en: "No." },
  "ops.col.migration": { uk: "Міграція", ru: "Миграция", en: "Migration" },
  "ops.col.stamp": { uk: "Мітка в журналі", ru: "Метка в журнале", en: "Journal stamp" },
  "ops.col.job": { uk: "Задача", ru: "Задача", en: "Job" },
  "ops.col.result": { uk: "Результат", ru: "Результат", en: "Result" },
  "ops.col.lastRun": { uk: "Останній прохід", ru: "Последний проход", en: "Last run" },
  "ops.col.took": { uk: "Тривав", ru: "Длился", en: "Took" },
  "ops.col.next": { uk: "Наступний", ru: "Следующий", en: "Next" },
  "ops.col.runs": { uk: "Проходів / збоїв", ru: "Проходов / сбоев", en: "Runs / failures" },
  "ops.col.assigned": { uk: "Призначено", ru: "Назначено", en: "Assigned" },
  "ops.col.skipped": { uk: "Пропущено", ru: "Пропущено", en: "Skipped" },
  "ops.col.note": { uk: "Примітка", ru: "Примечание", en: "Note" },

  "ops.slow.title": { uk: "Повільні запити", ru: "Медленные запросы", en: "Slow requests" },
  "ops.slow.hint": { uk: "Від {ms}, останні {n} з моменту запуску. Номер запиту веде в стрічку логів.", ru: "От {ms}, последние {n} с момента запуска. Номер запроса ведёт в ленту логов.", en: "From {ms}, the latest {n} since the process started. The request ID opens the log feed." },
  "ops.slow.empty": { uk: "Повільних запитів з моменту запуску немає", ru: "Медленных запросов с момента запуска нет", en: "No slow requests since the process started" },

  "ops.errors.title": { uk: "Групи помилок", ru: "Группы ошибок", en: "Error groups" },
  "ops.errors.hint": { uk: "Однакові помилки зведено за відбитком: тип, повідомлення без даних, верхній кадр нашого коду й маршрут. Ідентифікатори, пошту, телефони й значення в лапках вичищено.", ru: "Одинаковые ошибки сведены по отпечатку: тип, сообщение без данных, верхний кадр нашего кода и маршрут. Идентификаторы, почта, телефоны и значения в кавычках вычищены.", en: "Identical errors are grouped by fingerprint: type, message without data, top frame of our code and route. IDs, emails, phone numbers and quoted values are removed." },
  "ops.errors.summary": { uk: "груп {groups}, випадків {n}", ru: "групп {groups}, случаев {n}", en: "{groups} groups, {n} occurrences" },
  "ops.errors.search": { uk: "Пошук за повідомленням чи маршрутом", ru: "Поиск по сообщению или маршруту", en: "Search message or route" },
  "ops.errors.dropped": { uk: "Витіснено давніх груп: {n} — зберігається не більше {cap}", ru: "Вытеснено давних групп: {n} — хранится не больше {cap}", en: "{n} old groups evicted — at most {cap} are kept" },
  "ops.errors.empty": { uk: "Помилок з моменту запуску немає", ru: "Ошибок с момента запуска нет", en: "No errors since the process started" },
  "ops.errors.noMatch": { uk: "Таких помилок немає", ru: "Таких ошибок нет", en: "No matching errors" },
  "ops.errors.outside": { uk: "поза запитом — фонова задача чи запис у лог", ru: "вне запроса — фоновая задача или запись в лог", en: "outside a request — a background job or a log entry" },
  "ops.errors.first": { uk: "уперше {time}", ru: "впервые {time}", en: "first {time}" },
  "ops.errors.showStack": { uk: "Стек", ru: "Стек", en: "Stack" },
  "ops.errors.hideStack": { uk: "Сховати стек", ru: "Скрыть стек", en: "Hide stack" },
  "ops.errors.noStack": { uk: "Стека немає: помилку записано в лог без винятку", ru: "Стека нет: ошибка записана в лог без исключения", en: "No stack: the error was logged without an exception" },

  "ops.logs.title": { uk: "Стрічка логів", ru: "Лента логов", en: "Log feed" },
  "ops.logs.threshold": { uk: "Пишуться рядки від рівня «{level}» (LOG_LEVEL).", ru: "Пишутся строки от уровня «{level}» (LOG_LEVEL).", en: "Lines are written from level “{level}” (LOG_LEVEL)." },
  "ops.logs.capacity": { uk: "У буфері — останні {n}; запити самої панелі в стрічку не потрапляють.", ru: "В буфере — последние {n}; запросы самой панели в ленту не попадают.", en: "The buffer keeps the latest {n}; the panel’s own requests are left out." },
  "ops.logs.pause": { uk: "Пауза", ru: "Пауза", en: "Pause" },
  "ops.logs.resume": { uk: "Продовжити", ru: "Продолжить", en: "Resume" },
  "ops.logs.pausedNote": { uk: "стрічку зупинено", ru: "лента остановлена", en: "feed paused" },
  "ops.logs.level": { uk: "Рівень", ru: "Уровень", en: "Level" },
  "ops.logs.levelAll": { uk: "Усі рівні", ru: "Все уровни", en: "All levels" },
  "ops.logs.levelFrom": { uk: "Від «{level}»", ru: "От «{level}»", en: "From “{level}”" },
  "ops.logs.search": { uk: "Пошук у повідомленні й полях", ru: "Поиск в сообщении и полях", en: "Search message and fields" },
  "ops.logs.requestId": { uk: "Номер запиту", ru: "Номер запроса", en: "Request ID" },
  "ops.logs.clear": { uk: "Скинути фільтри", ru: "Сбросить фильтры", en: "Clear filters" },
  "ops.logs.gap": { uk: "Частину рядків витіснено з буфера, поки стрічка стояла: між ними є розрив.", ru: "Часть строк вытеснена из буфера, пока лента стояла: между ними есть разрыв.", en: "Some lines were evicted from the buffer while the feed was paused; there is a gap." },
  "ops.logs.empty": { uk: "Рядків у буфері ще немає", ru: "Строк в буфере ещё нет", en: "The buffer is empty" },
  "ops.logs.noMatch": { uk: "Рядків за цими фільтрами немає", ru: "Строк по этим фильтрам нет", en: "No lines match these filters" },
  "ops.logs.onlyThis": { uk: "Лише цей запит", ru: "Только этот запрос", en: "Only this request" },
  "ops.level.debug": { uk: "налагодження", ru: "отладка", en: "debug" },
  "ops.level.info": { uk: "інфо", ru: "инфо", en: "info" },
  "ops.level.warn": { uk: "попередження", ru: "предупреждение", en: "warning" },
  "ops.level.error": { uk: "помилка", ru: "ошибка", en: "error" },

  "ops.db.live": { uk: "Стан бази зараз — без історії; оновлюється сам", ru: "Состояние базы сейчас — без истории; обновляется само", en: "Current database state, no history; refreshes itself" },
  "ops.db.note.activityDenied": { uk: "Ролі застосунку не вистачає прав на pg_stat_activity — підключення й довгі запити не показано.", ru: "Роли приложения не хватает прав на pg_stat_activity — подключения и долгие запросы не показаны.", en: "The application role lacks access to pg_stat_activity — connections and long queries are not shown." },
  "ops.db.note.activityPartial": { uk: "Частину сесій приховано: роль застосунку бачить вміст лише своїх (потрібна роль pg_read_all_stats).", ru: "Часть сессий скрыта: роль приложения видит содержимое только своих (нужна роль pg_read_all_stats).", en: "Some sessions are hidden: the application role sees only its own (pg_read_all_stats is needed)." },
  "ops.db.note.tablesFailed": { uk: "Розміри таблиць не прочиталися — подробиці в лозі.", ru: "Размеры таблиц не прочитались — подробности в логе.", en: "Table sizes could not be read — see the log." },
  "ops.db.note.locksFailed": { uk: "Очікування блокувань не прочиталися — бракує прав на pg_locks чи pg_stat_activity.", ru: "Ожидания блокировок не прочитались — не хватает прав на pg_locks или pg_stat_activity.", en: "Lock waits could not be read — pg_locks or pg_stat_activity is not accessible." },
  "ops.db.note.migrationsDenied": { uk: "Немає доступу до журналу міграцій (схема drizzle) — для ролі застосунку це звично.", ru: "Нет доступа к журналу миграций (схема drizzle) — для роли приложения это обычно.", en: "No access to the migration log (schema drizzle) — usual for the application role." },
  "ops.db.note.sizeFailed": { uk: "Розмір бази не прочитався.", ru: "Размер базы не прочитался.", en: "The database size could not be read." },
  "ops.db.tables": { uk: "Таблиці", ru: "Таблицы", en: "Tables" },
  "ops.db.tablesHint": { uk: "25 найбільших: розмір разом з індексами; рядки — оцінка статистики, а не точний підрахунок.", ru: "25 самых больших: размер вместе с индексами; строки — оценка статистики, а не точный подсчёт.", en: "The 25 largest, with indexes; row counts are statistics estimates, not exact counts." },
  "ops.db.total": { uk: "уся база {size}", ru: "вся база {size}", en: "whole database {size}" },
  "ops.db.rowsTitle": { uk: "Рядки й автоочищення", ru: "Строки и автоочистка", en: "Rows and autovacuum" },
  "ops.db.unavailable": { uk: "Недоступно — причину сказано вище.", ru: "Недоступно — причина сказана выше.", en: "Unavailable — the reason is given above." },
  "ops.db.connections": { uk: "Підключення", ru: "Подключения", en: "Connections" },
  "ops.db.connOf": { uk: "{n} з {max}", ru: "{n} из {max}", en: "{n} of {max}" },
  "ops.conn.active": { uk: "виконують запит", ru: "выполняют запрос", en: "active" },
  "ops.conn.idle": { uk: "простоюють", ru: "простаивают", en: "idle" },
  "ops.conn.idleTx": { uk: "простоюють у транзакції", ru: "простаивают в транзакции", en: "idle in transaction" },
  "ops.conn.idleTxAborted": { uk: "у перерваній транзакції", ru: "в прерванной транзакции", en: "idle in aborted transaction" },
  "ops.conn.fastpath": { uk: "виклик fastpath", ru: "вызов fastpath", en: "fastpath call" },
  "ops.conn.disabled": { uk: "стеження вимкнено", ru: "слежение выключено", en: "tracking disabled" },
  "ops.conn.hidden": { uk: "приховано правами", ru: "скрыто правами", en: "hidden by permissions" },
  "ops.db.long": { uk: "Довгі запити", ru: "Долгие запросы", en: "Long queries" },
  "ops.db.longHint": { uk: "Довше за 5 с; текст обрізано до 200 знаків, літерали в лапках замінено на «?».", ru: "Дольше 5 с; текст обрезан до 200 знаков, литералы в кавычках заменены на «?».", en: "Longer than 5 s; text cut to 200 characters, quoted literals replaced with “?”." },
  "ops.db.longEmpty": { uk: "Запитів, довших за 5 с, зараз немає", ru: "Запросов дольше 5 с сейчас нет", en: "No queries longer than 5 s right now" },
  "ops.db.locks": { uk: "Очікування блокувань", ru: "Ожидания блокировок", en: "Lock waits" },
  "ops.db.locksHint": { uk: "Хто чекає на блокування і на кого саме.", ru: "Кто ждёт блокировку и кого именно.", en: "Who is waiting for a lock, and on whom." },
  "ops.db.locksEmpty": { uk: "Ніхто не чекає на блокування", ru: "Никто не ждёт блокировок", en: "Nobody is waiting for a lock" },
  "ops.db.migrations": { uk: "Міграції", ru: "Миграции", en: "Migrations" },
  "ops.db.migrationsSummary": { uk: "застосовано {applied} з {known}", ru: "применено {applied} из {known}", en: "{applied} of {known} applied" },
  "ops.db.migrationsEmpty": { uk: "Жодної міграції не застосовано", ru: "Ни одной миграции не применено", en: "No migrations applied" },
  "ops.db.unknownTag": { uk: "немає в журналі коду", ru: "нет в журнале кода", en: "not in the code journal" },

  "ops.jobs.title": { uk: "Такти процесу", ru: "Такты процесса", en: "Process ticks" },
  "ops.jobs.hint": { uk: "Кожна фонова задача відмічає свій прохід: коли, скільки тривав, чим закінчився.", ru: "Каждая фоновая задача отмечает свой проход: когда, сколько длился, чем закончился.", en: "Each background job records its run: when, how long, and the outcome." },
  "ops.jobs.disabled": { uk: "Фонові задачі на цьому екземплярі вимкнено (SCHEDULER_ENABLED=0) — вони йдуть на іншому.", ru: "Фоновые задачи на этом экземпляре выключены (SCHEDULER_ENABLED=0) — они идут на другом.", en: "Background jobs are disabled on this instance (SCHEDULER_ENABLED=0) — they run on another one." },
  "ops.jobs.empty": { uk: "Жодна фонова задача ще не запускалася", ru: "Ни одна фоновая задача ещё не запускалась", en: "No background job has run yet" },
  "ops.jobs.every": { uk: "кожні {t}", ru: "каждые {t}", en: "every {t}" },
  "ops.jobs.lastError": { uk: "Остання помилка, {time}:", ru: "Последняя ошибка, {time}:", en: "Last error, {time}:" },
  "ops.jobs.transcriber": { uk: "Розшифровка записів прийому йде окремим процесом (transcriber) — тут її не видно.", ru: "Расшифровка записей приёма идёт отдельным процессом (transcriber) — здесь её не видно.", en: "Transcription of appointment recordings runs as a separate process (transcriber) and is not visible here." },
  "ops.jobs.runsTitle": { uk: "Спрацювання розкладів", ru: "Срабатывания расписаний", en: "Schedule runs" },
  "ops.jobs.runsHint": { uk: "Останні 10 з бази — вони переживають перезапуск.", ru: "Последние 10 из базы — они переживают перезапуск.", en: "The latest 10 from the database — these survive restarts." },
  "ops.jobs.runsEmpty": { uk: "Розклади ще не спрацьовували", ru: "Расписания ещё не срабатывали", en: "No schedule has fired yet" },
  "ops.jobs.runsFailed": { uk: "Не прочиталося — подробиці в лозі.", ru: "Не прочиталось — подробности в логе.", en: "Could not be read — see the log." },
  "ops.job.schedules": { uk: "Розклади обстежень", ru: "Расписания обследований", en: "Assessment schedules" },
  "ops.job.presence": { uk: "Прибирання присутності", ru: "Уборка присутствия", en: "Presence sweep" },
  "ops.job.noShows": { uk: "Неявки на прийом", ru: "Неявки на приём", en: "Appointment no-shows" },
  "ops.job.pushReceipts": { uk: "Квитанції пуш-сповіщень", ru: "Квитанции пуш-уведомлений", en: "Push receipts" },
  "ops.job.security": { uk: "Безпека: секрети й цілісність журналу", ru: "Безопасность: секреты и целостность журнала", en: "Security: secrets and audit chain" },
  "ops.job.notifier": { uk: "Розсилка тривог", ru: "Рассылка тревог", en: "Alert notifications" },
  "ops.job.remind": { uk: "Нагадування про прийом", ru: "Напоминания о приёме", en: "Appointment reminders" },
  "ops.job.mailings": { uk: "Пуші розсилок", ru: "Пуши рассылок", en: "Mailing push notifications" },
  "ops.job.retention": { uk: "Очищення потоку подій", ru: "Очистка потока событий", en: "Answer event retention" },
  "ops.result.ok": { uk: "успішно", ru: "успешно", en: "ok" },
  "ops.result.error": { uk: "збій", ru: "сбой", en: "failed" },
  "ops.result.skipped": { uk: "пропущено — попередній ще йде", ru: "пропущено — предыдущий ещё идёт", en: "skipped — previous still running" },
  "ops.result.running": { uk: "виконується", ru: "выполняется", en: "running" },

  /* ── wave10:accounts ── */
  /*
   * Техпанель: «Користувачі», «Сесії», «Аудит» и смена временного пароля.
   * ops.hold.* — «что держит учётку от удаления»: их же читает сервер,
   * собирая текст отказа 409 (apps/api/src/lib/accounts.ts, holdsText), —
   * поэтому это существительные без чисел: число ставится рядом.
   */
  "ops.hold.responses": { uk: "проходження", ru: "прохождения", en: "responses" },
  "ops.hold.conclusions": { uk: "висновки", ru: "заключения", en: "conclusions" },
  "ops.hold.notes": { uk: "записи прийому", ru: "записи приёма", en: "visit notes" },
  "ops.hold.cases": { uk: "випадки ризику", ru: "случаи риска", en: "risk cases" },
  "ops.hold.surveys": { uk: "авторство методик", ru: "авторство методик", en: "authored assessments" },
  "ops.hold.referrals": { uk: "направлення", ru: "направления", en: "referrals" },
  "ops.hold.appointments": { uk: "прийоми", ru: "приёмы", en: "appointments" },
  "ops.hold.episodes": { uk: "звернення", ru: "обращения", en: "episodes of care" },
  "ops.hold.safetyPlans": { uk: "плани безпеки", ru: "планы безопасности", en: "safety plans" },
  "ops.hold.recordings": { uk: "аудіозаписи прийому", ru: "аудиозаписи приёма", en: "visit recordings" },
  "ops.hold.consents": { uk: "прийняті згоди", ru: "принятые согласия", en: "accepted consents" },
  "ops.hold.threads": { uk: "листування", ru: "переписка", en: "message threads" },
  "ops.hold.dispensary": { uk: "диспансерний облік", ru: "диспансерный учёт", en: "dispensary follow-up" },
  "ops.hold.journal": { uk: "записи журналу від його імені", ru: "записи журнала от её имени", en: "audit log entries made by the account" },

  "ops.act.passwordChange": { uk: "Зміна власного пароля", ru: "Смена собственного пароля", en: "Own password change" },
  "ops.act.refreshFailed": { uk: "Відмова в оновленні сесії", ru: "Отказ в обновлении сессии", en: "Session refresh refused" },
  "ops.act.roleChange": { uk: "Зміна ролі", ru: "Смена роли", en: "Role change" },
  "ops.act.rolesChange": { uk: "Зміна ролей-шаблонів", ru: "Смена ролей-шаблонов", en: "Role template change" },
  "ops.act.disable": { uk: "Вимкнення облікового запису", ru: "Отключение учётной записи", en: "Account disabled" },
  "ops.act.enable": { uk: "Увімкнення облікового запису", ru: "Включение учётной записи", en: "Account enabled" },
  "ops.act.delete": { uk: "Видалення облікового запису", ru: "Удаление учётной записи", en: "Account deletion" },
  "ops.act.passwordReset": { uk: "Скидання пароля", ru: "Сброс пароля", en: "Password reset" },
  "ops.act.sessionsRevoke": { uk: "Завершення всіх сесій", ru: "Завершение всех сессий", en: "All sessions ended" },
  "ops.act.sessionList": { uk: "Перегляд сесій", ru: "Просмотр сессий", en: "Viewing sessions" },
  "ops.act.sessionRevoke": { uk: "Завершення сесії", ru: "Завершение сессии", en: "Session ended" },
  "ops.act.permissionException": { uk: "Особистий виняток прав", ru: "Личное исключение прав", en: "Personal permission exception" },
  "ops.act.permissionExceptionRevoke": { uk: "Скасування винятку прав", ru: "Отзыв исключения прав", en: "Permission exception revoked" },
  "ops.act.patientCard": { uk: "Перегляд картки пацієнта", ru: "Просмотр карточки пациента", en: "Viewing patient card" },
  "ops.act.auditExport": { uk: "Вивантаження журналу", ru: "Выгрузка журнала", en: "Audit log export" },
  "ops.act.deviceWipe": { uk: "Замовлено стирання пристрою", ru: "Заказано стирание устройства", en: "Device wipe requested" },

  "ops.users.search": { uk: "Пошук за ПІБ, поштою або номером телефону", ru: "Поиск по ФИО, почте или номеру телефона", en: "Search by name, email or phone number" },
  "ops.users.allRoles": { uk: "Усі ролі", ru: "Все роли", en: "All roles" },
  "ops.users.state": { uk: "Стан", ru: "Состояние", en: "Status" },
  "ops.users.allStates": { uk: "Усі стани", ru: "Все состояния", en: "All statuses" },
  "ops.users.active": { uk: "Активні", ru: "Активные", en: "Active" },
  "ops.users.disabledMany": { uk: "Вимкнені", ru: "Отключённые", en: "Disabled" },
  "ops.users.activeOne": { uk: "активний", ru: "активна", en: "active" },
  "ops.users.disabledOne": { uk: "вимкнено", ru: "отключена", en: "disabled" },
  "ops.users.tempMark": { uk: "тимчасовий пароль", ru: "временный пароль", en: "temporary password" },
  "ops.users.sortCreated": { uk: "Спершу нові", ru: "Сначала новые", en: "Newest first" },
  "ops.users.sortLastSeen": { uk: "За останнім входом", ru: "По последнему входу", en: "By last sign-in" },
  "ops.users.sortRole": { uk: "За роллю", ru: "По роли", en: "By role" },
  "ops.users.account": { uk: "Обліковий запис", ru: "Учётная запись", en: "Account" },
  "ops.users.lastSeen": { uk: "Останній вхід", ru: "Последний вход", en: "Last sign-in" },
  "ops.users.neverSeen": { uk: "ще не входив", ru: "ещё не входил", en: "never signed in" },
  "ops.users.exceptions": { uk: "винятків", ru: "исключений", en: "exceptions" },
  "ops.users.noTrace": { uk: "без клінічного сліду", ru: "без клинического следа", en: "no clinical trace" },
  "ops.users.actions": { uk: "Дії з обліковим записом", ru: "Действия с учётной записью", en: "Account actions" },
  "ops.users.changeRole": { uk: "Змінити роль", ru: "Сменить роль", en: "Change role" },
  "ops.users.permissions": { uk: "Права й винятки", ru: "Права и исключения", en: "Permissions and exceptions" },
  "ops.users.patientNoPerms": { uk: "У пацієнта немає прав персоналу", ru: "У пациента нет прав персонала", en: "Patients have no staff permissions" },
  "ops.users.sessionsOf": { uk: "Сесії людини", ru: "Сессии человека", en: "This person's sessions" },
  "ops.users.actorLog": { uk: "Журнал: дії людини", ru: "Журнал: действия человека", en: "Log: actions by this person" },
  "ops.users.subjectLog": { uk: "Журнал: дії щодо людини", ru: "Журнал: действия в отношении человека", en: "Log: actions about this person" },
  "ops.users.resetPassword": { uk: "Скинути пароль", ru: "Сбросить пароль", en: "Reset password" },
  "ops.users.revokeSessions": { uk: "Завершити всі сесії", ru: "Завершить все сессии", en: "End all sessions" },
  "ops.users.noSessions": { uk: "Активних сесій немає", ru: "Активных сессий нет", en: "No active sessions" },
  "ops.users.disable": { uk: "Вимкнути", ru: "Отключить", en: "Disable" },
  "ops.users.enable": { uk: "Увімкнути", ru: "Включить", en: "Enable" },
  "ops.users.delete": { uk: "Видалити", ru: "Удалить", en: "Delete" },
  "ops.users.notSelf": { uk: "З власним обліковим записом так не можна", ru: "С собственной учётной записью так нельзя", en: "Not allowed on your own account" },
  "ops.users.superOnly": { uk: "Лише суперадміністратору", ru: "Только суперадминистратору", en: "Super administrator only" },
  "ops.users.deleteSuperOnly": { uk: "Видаляє лише суперадміністратор", ru: "Удаляет только суперадминистратор", en: "Only the super administrator can delete" },
  "ops.users.tempPassword": { uk: "Тимчасовий пароль", ru: "Временный пароль", en: "Temporary password" },
  "ops.users.onceHint": { uk: "Показується один раз: скопіюйте й передайте людині. Під час входу система попросить його змінити.", ru: "Показывается один раз: скопируйте и передайте человеку. При входе система попросит его сменить.", en: "Shown only once: copy it and pass it on. The system will ask to change it at sign-in." },
  "ops.users.copied": { uk: "Скопійовано", ru: "Скопировано", en: "Copied" },
  "ops.users.copyFailed": { uk: "Браузер не дав скопіювати — виділіть пароль і скопіюйте вручну", ru: "Браузер не дал скопировать — выделите пароль и скопируйте вручную", en: "The browser didn't allow copying — select the password and copy it manually" },
  "ops.users.regenerate": { uk: "Згенерувати інший", ru: "Сгенерировать другой", en: "Generate another" },
  "ops.users.createdDone": { uk: "обліковий запис створено. Це останній раз, коли видно пароль.", ru: "учётная запись создана. Это последний раз, когда виден пароль.", en: "account created. This is the last time the password is shown." },
  "ops.users.resetDone": { uk: "пароль скинуто, усі сесії завершено. Це єдиний раз, коли видно новий пароль.", ru: "пароль сброшен, все сессии завершены. Это единственный раз, когда виден новый пароль.", en: "password reset, all sessions ended. This is the only time the new password is shown." },
  "ops.users.gotIt": { uk: "Готово", ru: "Готово", en: "Done" },
  "ops.users.roleHint": { uk: "Зміна ролі завершує всі сесії людини: наступний вхід буде вже з новою роллю. Ролі-шаблони й особисті винятки — на екрані прав.", ru: "Смена роли завершает все сессии человека: следующий вход будет уже с новой ролью. Роли-шаблоны и личные исключения — на экране прав.", en: "Changing the role ends all of the person's sessions: the next sign-in uses the new role. Role templates and personal exceptions are on the permissions screen." },
  "ops.users.resetWarn": { uk: "буде видано тимчасовий пароль, а всі сесії — завершено. Старий пароль перестане діяти одразу.", ru: "будет выдан временный пароль, а все сессии — завершены. Старый пароль перестанет действовать сразу.", en: "a temporary password will be issued and all sessions ended. The old password stops working immediately." },
  "ops.users.revokeWarn": { uk: "усі сесії на всіх пристроях завершаться — людині доведеться увійти знову.", ru: "все сессии на всех устройствах завершатся — человеку придётся войти заново.", en: "all sessions on all devices will end — the person will have to sign in again." },
  "ops.users.sessionsEnded": { uk: "Сесії завершено", ru: "Сессии завершены", en: "Sessions ended" },
  "ops.users.disableWarn": { uk: "Вхід, оновлення сесії й вже відкриті сесії буде зупинено одразу — і у вебі, і в застосунку. Історія залишиться на місці, обліковий запис можна буде увімкнути знову.", ru: "Вход, обновление сессии и уже открытые сессии будут остановлены сразу — и в вебе, и в приложении. История останется на месте, учётную запись можно будет включить снова.", en: "Sign-in, session refresh and open sessions stop immediately — on the web and in the app. The history stays in place, and the account can be enabled again." },
  "ops.users.reason": { uk: "Причина — словами, її прочитають у журналі", ru: "Причина — словами, её прочтут в журнале", en: "Reason — in words, it will be read in the log" },
  "ops.users.disabledDone": { uk: "Обліковий запис вимкнено", ru: "Учётная запись отключена", en: "Account disabled" },
  "ops.users.enableWarn": { uk: "Людина знову зможе увійти. Сесії не повертаються — вхід наново.", ru: "Человек снова сможет войти. Сессии не возвращаются — вход заново.", en: "The person will be able to sign in again. Sessions aren't restored — they sign in anew." },
  "ops.users.enabledDone": { uk: "Обліковий запис увімкнено", ru: "Учётная запись включена", en: "Account enabled" },
  "ops.users.deleteWarn": { uk: "Обліковий запис буде видалено назавжди. Це можливо лише для запису без клінічного сліду й без жодного запису в журналі від його імені — тобто для заведеного помилково.", ru: "Учётная запись будет удалена навсегда. Это возможно только для записи без клинического следа и без единой записи в журнале от её имени — то есть для заведённой по ошибке.", en: "The account will be deleted permanently. This is only possible for an account with no clinical trace and no audit log entries of its own — that is, one created by mistake." },
  "ops.users.cannotDelete": { uk: "Видалити не можна", ru: "Удалить нельзя", en: "Can't be deleted" },
  "ops.users.heldBy": { uk: "обліковий запис тримають", ru: "учётную запись держат", en: "the account is held by" },
  "ops.users.heldWhy": { uk: "Клінічні дані не видаляються, а журнал не переписується: видалення забрало б їх разом з обліковим записом. Вимкніть його — вхід буде закрито, історія залишиться.", ru: "Клинические данные не удаляются, а журнал не переписывается: удаление унесло бы их вместе с учётной записью. Отключите её — вход будет закрыт, история останется.", en: "Clinical data is never deleted and the audit log is never rewritten: deletion would take them along with the account. Disable it instead — sign-in will be closed and the history kept." },
  "ops.users.disableInstead": { uk: "Вимкнути замість цього", ru: "Отключить вместо этого", en: "Disable instead" },

  "ops.sessions.search": { uk: "Людина: ПІБ або пошта", ru: "Человек: ФИО или почта", en: "Person: name or email" },
  "ops.sessions.onlyOf": { uk: "Лише сесії", ru: "Только сессии", en: "Only sessions of" },
  "ops.sessions.showAll": { uk: "Показати всі", ru: "Показать все", en: "Show all" },
  "ops.sessions.noDevice": { uk: "Пристрій і адресу сесія не зберігає — лише час входу й оновлення.", ru: "Устройство и адрес сессия не хранит — только время входа и обновления.", en: "A session doesn't store the device or address — only sign-in and refresh times." },
  "ops.sessions.none": { uk: "Активних сесій немає", ru: "Активных сессий нет", en: "No active sessions" },
  "ops.sessions.started": { uk: "Вхід", ru: "Вход", en: "Signed in" },
  "ops.sessions.lastUsed": { uk: "Останнє оновлення", ru: "Последнее обновление", en: "Last refresh" },
  "ops.sessions.expires": { uk: "Діє до", ru: "Действует до", en: "Valid until" },
  "ops.sessions.end": { uk: "Завершити", ru: "Завершить", en: "End" },
  "ops.sessions.ended": { uk: "Сесію завершено", ru: "Сессия завершена", en: "Session ended" },

  "ops.audit.text": { uk: "Текст: дія, ресурс, подробиці", ru: "Текст: действие, ресурс, подробности", en: "Text: action, resource, details" },
  "ops.audit.actor": { uk: "Хто: пошта або id", ru: "Кто: почта или id", en: "Who: email or id" },
  "ops.audit.subject": { uk: "Щодо кого: пошта або id", ru: "В отношении кого: почта или id", en: "About whom: email or id" },
  "ops.audit.allActions": { uk: "Усі дії", ru: "Все действия", en: "All actions" },
  "ops.audit.type": { uk: "Тип ресурсу", ru: "Тип ресурса", en: "Resource type" },
  "ops.audit.allTypes": { uk: "Усі типи ресурсів", ru: "Все типы ресурсов", en: "All resource types" },
  "ops.audit.allOutcomes": { uk: "Будь-який наслідок", ru: "Любой исход", en: "Any outcome" },
  "ops.audit.from": { uk: "З дати", ru: "С даты", en: "From date" },
  "ops.audit.to": { uk: "По дату включно", ru: "По дату включительно", en: "To date, inclusive" },
  "ops.audit.verify": { uk: "Перевірити цілісність", ru: "Проверить целостность", en: "Verify integrity" },
  "ops.audit.export": { uk: "Вивантажити CSV", ru: "Выгрузить CSV", en: "Export CSV" },
  "ops.audit.exported": { uk: "Вивантаження готове — до 10 000 рядків поточного відбору", ru: "Выгрузка готова — до 10 000 строк текущего отбора", en: "Export ready — up to 10,000 rows of the current selection" },
  "ops.audit.showSummary": { uk: "Показати зведення", ru: "Показать сводку", en: "Show summary" },
  "ops.audit.hideSummary": { uk: "Сховати зведення", ru: "Скрыть сводку", en: "Hide summary" },
  "ops.audit.summary": { uk: "Зведення журналу", ru: "Сводка журнала", en: "Log summary" },
  "ops.audit.none": { uk: "Записів за цим відбором немає", ru: "Записей по этому отбору нет", en: "No entries match this selection" },
  "ops.audit.subjectCol": { uk: "Щодо кого", ru: "В отношении кого", en: "About whom" },
  "ops.audit.byThisActor": { uk: "Відібрати дії цієї людини", ru: "Отобрать действия этого человека", en: "Filter by this person's actions" },
  "ops.audit.aboutThisSubject": { uk: "Відібрати дії щодо цієї людини", ru: "Отобрать действия в отношении этого человека", en: "Filter by actions about this person" },
  "ops.audit.system": { uk: "система", ru: "система", en: "system" },
  "ops.audit.resource": { uk: "Ресурс", ru: "Ресурс", en: "Resource" },
  "ops.audit.subjectFull": { uk: "Щодо кого (id)", ru: "В отношении кого (id)", en: "About whom (id)" },
  "ops.audit.actorId": { uk: "Хто (id)", ru: "Кто (id)", en: "Who (id)" },
  "ops.audit.chainOk": { uk: "Ланцюжок журналу цілий. Перевірено записів:", ru: "Цепочка журнала цела. Проверено записей:", en: "The log chain is intact. Entries checked:" },
  "ops.audit.chainHead": { uk: "голова ланцюжка", ru: "голова цепочки", en: "chain head" },
  "ops.audit.chainBroken": { uk: "Ланцюжок журналу розірвано на записі", ru: "Цепочка журнала порвана на записи", en: "The log chain is broken at entry" },
  "ops.audit.chainBrokenWhy": { uk: "Журнал змінювали в обхід застосунку — від цього місця йому не можна вірити.", ru: "Журнал меняли в обход приложения — начиная с этого места ему нельзя верить.", en: "The log was changed bypassing the application — from this point on it can't be trusted." },
  "ops.audit.chainLegacy": { uk: "Записи до запровадження ланцюжка, їхню цілісність не довести", ru: "Записи до внедрения цепочки, их целостность не доказуема", en: "Entries from before the chain was introduced; their integrity can't be proven" },

  "ops.force.title": { uk: "Змініть пароль", ru: "Смените пароль", en: "Change your password" },
  "ops.force.sub": { uk: "Цей пароль видав адміністратор. Придумайте власний — від 10 знаків — і далі входьте з ним.", ru: "Этот пароль выдал администратор. Придумайте свой — от 10 знаков — и дальше входите с ним.", en: "This password was issued by an administrator. Choose your own — at least 10 characters — and use it from now on." },
  "ops.force.temp": { uk: "Тимчасовий пароль", ru: "Временный пароль", en: "Temporary password" },
  "ops.force.repeat": { uk: "Новий пароль ще раз", ru: "Новый пароль ещё раз", en: "New password again" },
  "ops.force.short": { uk: "Щонайменше 10 знаків", ru: "Не меньше 10 знаков", en: "At least 10 characters" },
  "ops.force.mismatch": { uk: "Паролі не збігаються", ru: "Пароли не совпадают", en: "The passwords don't match" },

  /* ── wave10:maint ── */
  "ops.tab.maintenance": { uk: "Обслуговування", ru: "Обслуживание", en: "Maintenance" },
  "ops.tab.flags": { uk: "Прапорці", ru: "Флаги", en: "Feature flags" },
  "ops.tab.releases": { uk: "Випуски", ru: "Выпуски", en: "Releases" },

  /* состояние системы: страница /status и баннер — их читают все, пациенты тоже */
  "svc.title": { uk: "Стан системи", ru: "Состояние системы", en: "System status" },
  "svc.status.ok": { uk: "Працює", ru: "Работает", en: "Operational" },
  "svc.status.maintenance": { uk: "Обслуговування", ru: "Обслуживание", en: "Maintenance" },
  "svc.status.degraded": { uk: "Збої", ru: "Сбои", en: "Disruptions" },
  "svc.since": { uk: "Від", ru: "С", en: "Since" },
  "svc.until": { uk: "Орієнтовно до", ru: "Ориентировочно до", en: "Expected until" },
  "svc.writeClosed": {
    uk: "Зміни зараз не зберігаються. Переглядати можна.",
    ru: "Изменения сейчас не сохраняются. Смотреть можно.",
    en: "Changes can’t be saved right now. Viewing still works.",
  },
  "svc.writeOpen": { uk: "Зміни зберігаються як завжди.", ru: "Изменения сохраняются как обычно.", en: "Changes are saved as usual." },
  "svc.autoDb": {
    uk: "Сервер не отримує відповіді від бази даних.",
    ru: "Сервер не получает ответа от базы данных.",
    en: "The server isn’t getting a response from the database.",
  },
  "svc.unreachable": {
    uk: "Сервер не відповідає. Спробуйте за кілька хвилин.",
    ru: "Сервер не отвечает. Попробуйте через несколько минут.",
    en: "The server isn’t responding. Please try again in a few minutes.",
  },
  "svc.history": { uk: "Історія оголошень", ru: "История объявлений", en: "Announcement history" },
  "svc.noHistory": { uk: "Оголошень ще не було", ru: "Объявлений ещё не было", en: "No announcements yet" },
  "svc.checkedAt": { uk: "Перевірено", ru: "Проверено", en: "Checked" },
  "svc.toLogin": { uk: "До входу", ru: "Ко входу", en: "Back to sign in" },
  "svc.banner.maintenance": { uk: "Тривають технічні роботи", ru: "Идут технические работы", en: "Maintenance in progress" },
  "svc.banner.maintenanceHint": {
    uk: "зміни тимчасово не зберігаються, переглядати можна",
    ru: "изменения временно не сохраняются, смотреть можно",
    en: "changes can’t be saved for now, viewing still works",
  },
  "svc.banner.degraded": { uk: "Можливі збої в роботі", ru: "Возможны сбои в работе", en: "Service disruptions" },
  "svc.details": { uk: "Докладніше", ru: "Подробнее", en: "Details" },

  /* кабинет пациента: сдача, отложенная до конца работ или появления сети */
  "pw.queued": {
    uk: "Відповіді збережено на цьому пристрої й буде відправлено, щойно сервер знову прийматиме зміни.",
    ru: "Ответы сохранены на этом устройстве и будут отправлены, как только сервер снова начнёт принимать изменения.",
    en: "Your answers are saved on this device and will be sent as soon as the server accepts changes again.",
  },
  "pt.outboxWaiting": { uk: "Чекають на відправлення", ru: "Ждут отправки", en: "Waiting to be sent" },
  "pt.outboxRejected": { uk: "Сервер не прийняв", ru: "Сервер не принял", en: "Not accepted by the server" },
  "pt.outboxSend": { uk: "Відправити зараз", ru: "Отправить сейчас", en: "Send now" },

  /* техпанель: обслуживание */
  "mt.mode": { uk: "Режим обслуговування", ru: "Режим обслуживания", en: "Maintenance mode" },
  "mt.modeHint": {
    uk: "Поки режим увімкнено, усі зміни, крім техпанелі та входу, отримують відмову 503, а перегляд працює. Банер бачать усі: консоль, кабінет пацієнта, екран входу. Відповіді пацієнтів чекають на пристроях і відправляються після робіт.",
    ru: "Пока режим включён, все изменения, кроме техпанели и входа, получают отказ 503, а просмотр работает. Баннер видят все: консоль, кабинет пациента, экран входа. Ответы пациентов ждут на устройствах и отправляются после работ.",
    en: "While the mode is on, every change except the tech panel and sign-in is refused with 503, and viewing works. Everyone sees the banner: the console, the patient area, the sign-in screen. Patients’ answers wait on their devices and are sent after the work.",
  },
  "mt.on": { uk: "Увімкнути режим обслуговування", ru: "Включить режим обслуживания", en: "Turn on maintenance mode" },
  "mt.off": { uk: "Вимкнути режим обслуговування", ru: "Выключить режим обслуживания", en: "Turn off maintenance mode" },
  "mt.confirmOn": {
    uk: "Закрити збереження змін для всіх? Переглядати буде можна, зберігати — ні.",
    ru: "Закрыть сохранение изменений для всех? Смотреть будет можно, сохранять — нет.",
    en: "Stop saving changes for everyone? Viewing will still work, saving won’t.",
  },
  "mt.message": { uk: "Текст для людей", ru: "Текст для людей", en: "Message for people" },
  "mt.until": { uk: "Орієнтовне завершення", ru: "Ожидаемое окончание", en: "Expected end" },
  "mt.announce": { uk: "Оголошення про стан", ru: "Объявление о состоянии", en: "Status announcement" },
  "mt.announceHint": {
    uk: "Збої збереження не закривають: люди бачать банер, а зміни зберігаються. «Працює» знімає банер.",
    ru: "Сбои сохранение не закрывают: люди видят баннер, а изменения сохраняются. «Работает» снимает баннер.",
    en: "Disruptions don’t stop saving: people see the banner and changes are still saved. “Operational” removes the banner.",
  },
  "mt.status": { uk: "Стан", ru: "Состояние", en: "Status" },
  "mt.publish": { uk: "Опублікувати", ru: "Опубликовать", en: "Publish" },
  "mt.by": { uk: "Хто", ru: "Кто", en: "By" },
  "mt.when": { uk: "Коли", ru: "Когда", en: "When" },
  "mt.done": { uk: "Стан оновлено", ru: "Состояние обновлено", en: "Status updated" },
  "mt.needManage": {
    uk: "Змінювати стан можна з правом «Керувати роботою системи».",
    ru: "Менять состояние можно с правом «Управлять работой системы».",
    en: "Changing the status requires the “Manage how the system runs” permission.",
  },

  /* техпанель: флаги функций */
  "fl.title": { uk: "Прапорці функцій", ru: "Флаги функций", en: "Feature flags" },
  "fl.hint": {
    uk: "Новий екран чи нову поведінку вмикають окремим людям і групам без викатки. Прапорець — не право: закрите правом лишається закритим на сервері.",
    ru: "Новый экран или новое поведение включают отдельным людям и группам без выкатки. Флаг — не право: закрытое правом остаётся закрытым на сервере.",
    en: "A new screen or behaviour is turned on for particular people and groups without a deployment. A flag isn’t a permission: what a permission closes stays closed on the server.",
  },
  "fl.on": { uk: "Увімкнено", ru: "Включён", en: "On" },
  "fl.off": { uk: "Вимкнено", ru: "Выключен", en: "Off" },
  "fl.audience": { uk: "Кому", ru: "Кому", en: "For whom" },
  "fl.everyone": { uk: "усім", ru: "всем", en: "everyone" },
  "fl.nobody": { uk: "нікому", ru: "никому", en: "no one" },
  "fl.stale": {
    uk: "Застарілий: ключа вже немає в коді, нікому нічого не вмикає",
    ru: "Устаревший: ключа уже нет в коде, никому ничего не включает",
    en: "Stale: the key is gone from the code and turns nothing on",
  },
  "fl.edit": { uk: "Змінити", ru: "Изменить", en: "Edit" },
  "fl.enabled": { uk: "Прапорець увімкнено", ru: "Флаг включён", en: "Flag is on" },
  "fl.all": { uk: "Усім", ru: "Всем", en: "Everyone" },
  "fl.roles": { uk: "Класи облікових записів", ru: "Классы учётных записей", en: "Account classes" },
  "fl.role.superadmin": { uk: "Суперадміністратори", ru: "Суперадминистраторы", en: "Super administrators" },
  "fl.role.admin": { uk: "Співробітники", ru: "Сотрудники", en: "Staff" },
  "fl.role.user": { uk: "Пацієнти", ru: "Пациенты", en: "Patients" },
  "fl.staffRoles": { uk: "Посади", ru: "Должности", en: "Positions" },
  "fl.people": { uk: "Люди", ru: "Люди", en: "People" },
  "fl.surveyGroups": { uk: "Групи методик", ru: "Группы методик", en: "Assessment groups" },
  "fl.departments": { uk: "Відділення", ru: "Отделения", en: "Departments" },
  "fl.add": { uk: "Додати", ru: "Добавить", en: "Add" },
  "fl.remove": { uk: "Прибрати", ru: "Убрать", en: "Remove" },
  "fl.changes": { uk: "Журнал змін", ru: "Журнал изменений", en: "Change log" },
  "fl.noChanges": { uk: "Змін ще не було", ru: "Изменений ещё не было", en: "No changes yet" },
  "fl.before": { uk: "Було", ru: "Было", en: "Before" },
  "fl.after": { uk: "Стало", ru: "Стало", en: "After" },
  "fl.created": { uk: "заведено", ru: "заведён", en: "created" },
  "fl.emptyWarn": {
    uk: "Прапорець увімкнено, але нікого не вибрано — він нікому нічого не вмикає.",
    ru: "Флаг включён, но никто не выбран — он никому ничего не включает.",
    en: "The flag is on but no one is selected, so it turns nothing on.",
  },

  /* техпанель: выпуски */
  "rl.hint": {
    uk: "Кожен запуск нової версії записує сам сервер під час старту: версію, коміт, хто й коли викотив, міграції, прогін CI.",
    ru: "Каждый запуск новой версии записывает сам сервер при старте: версию, коммит, кто и когда выкатил, миграции, прогон CI.",
    en: "The server records every new version itself when it starts: version, commit, who deployed it and when, migrations, the CI run.",
  },
  "rl.running": { uk: "Зараз працює", ru: "Сейчас работает", en: "Running now" },
  "rl.commit": { uk: "Коміт", ru: "Коммит", en: "Commit" },
  "rl.by": { uk: "Хто викотив", ru: "Кто выкатил", en: "Deployed by" },
  "rl.uptime": { uk: "Час роботи", ru: "Время работы", en: "Ran for" },
  "rl.migrations": { uk: "Міграції", ru: "Миграции", en: "Migrations" },
  "rl.noMigrations": { uk: "без нових міграцій", ru: "без новых миграций", en: "no new migrations" },
  "rl.migrationsUnknown": {
    uk: "невідомо: перший записаний випуск",
    ru: "неизвестно: первый записанный выпуск",
    en: "unknown: the first recorded release",
  },
  "rl.run": { uk: "Прогін CI", ru: "Прогон CI", en: "CI run" },
  "rl.now": { uk: "досі працює", ru: "работает до сих пор", en: "still running" },
  "rl.rollback": { uk: "Відкотити на", ru: "Откатить на", en: "Roll back to" },
  "rl.rollbackHint": {
    uk: "Відкат — це викатка попереднього тегу поверх тієї самої бази. Міграції переключенням тегу не відкочуються.",
    ru: "Откат — это выкатка предыдущего тега поверх той же базы. Миграции переключением тега не откатываются.",
    en: "A rollback deploys the previous tag on top of the same database. Migrations aren’t reverted by switching tags.",
  },
  "rl.rollbackLeft": {
    uk: "У базі лишаться міграції, що прийшли після нього:",
    ru: "В базе останутся миграции, пришедшие после него:",
    en: "These migrations, applied after it, will stay in the database:",
  },
  "rl.rollbackNoMig": {
    uk: "Нових міграцій після нього не було — схема та сама.",
    ru: "Новых миграций после него не было — схема та же.",
    en: "No migrations were applied after it, so the schema is the same.",
  },
  "rl.rollbackUnknownMig": {
    uk: "Які міграції прийшли після нього, невідомо — перевірте журнал міграцій перед відкатом.",
    ru: "Какие миграции пришли после него, неизвестно — проверьте журнал миграций перед откатом.",
    en: "It’s unknown which migrations came after it, so check the migration journal before rolling back.",
  },
  "rl.rollbackPage": {
    uk: "На сторінці GitHub натисніть «Run workflow» і впишіть тег",
    ru: "На странице GitHub нажмите «Run workflow» и впишите тег",
    en: "On the GitHub page press “Run workflow” and enter the tag",
  },
  "rl.rollbackOpen": { uk: "Відкрити запуск у GitHub", ru: "Открыть запуск в GitHub", en: "Open the run page on GitHub" },
  "rl.rollbackConfirm": {
    uk: "Запустити викатку попереднього тегу? Старий код стане поверх тієї самої бази.",
    ru: "Запустить выкатку предыдущего тега? Старый код встанет поверх той же базы.",
    en: "Start deploying the previous tag? The old code will run on top of the same database.",
  },
  "rl.rollbackStarted": {
    uk: "Викатку запущено — стежте за прогоном у GitHub",
    ru: "Выкатка запущена — следите за прогоном в GitHub",
    en: "Deployment started — follow the run on GitHub",
  },
  "rl.noPrevious": {
    uk: "Попереднього випуску в історії немає — відкочувати нема на що.",
    ru: "Предыдущего выпуска в истории нет — откатывать не на что.",
    en: "There’s no previous release in the history, so there’s nothing to roll back to.",
  },
  "rl.empty": {
    uk: "Викаток ще не записано. Сервер записує випуск під час старту, якщо викатка передала QUIZZY_VERSION.",
    ru: "Выкаток ещё не записано. Сервер записывает выпуск при старте, если выкатка передала QUIZZY_VERSION.",
    en: "No deployments recorded yet. The server records a release at start-up when the deployment passes QUIZZY_VERSION.",
  },

  /* ── wave10:data ── */
  "opsd.tab.quality": { uk: "Якість даних", ru: "Качество данных", en: "Data quality" },
  "opsd.tab.usage": { uk: "Використання", ru: "Использование", en: "Usage" },
  "opsd.tab.mobile": { uk: "Мобільний застосунок", ru: "Мобильное приложение", en: "Mobile app" },
  "opsd.tab.push": { uk: "Пуш-сповіщення", ru: "Пуш-уведомления", en: "Push notifications" },
  "opsd.range7": { uk: "7 днів", ru: "7 дней", en: "7 days" },
  "opsd.range90": { uk: "90 днів", ru: "90 дней", en: "90 days" },
  "opsd.hiddenBelow": { uk: "«—» — менше {n}, приховано порогом", ru: "«—» — меньше {n}, скрыто порогом", en: "“—” — fewer than {n}, hidden by the threshold" },

  /* якість даних */
  "opsd.q.summary": { uk: "Зведення перевірок", ru: "Сводка проверок", en: "Check summary" },
  "opsd.q.summaryHint": {
    uk: "Кожна перевірка — окремий запит до бази по всіх методиках. Нічого не виправляється автоматично: клінічний запис мовчки не правлять, перевірка лише називає розбіжність і веде туди, де її видно.",
    ru: "Каждая проверка — отдельный запрос к базе по всем методикам. Ничего не исправляется автоматически: клиническую запись молча не правят, проверка лишь называет расхождение и ведёт туда, где его видно.",
    en: "Each check is a separate database query across all instruments. Nothing is fixed automatically: clinical records are never silently edited — a check only names the mismatch and links to where it can be seen.",
  },
  "opsd.q.errors": { uk: "Помилки", ru: "Ошибки", en: "Errors" },
  "opsd.q.errorsHint": { uk: "дані вже розходяться", ru: "данные уже расходятся", en: "the data already disagree" },
  "opsd.q.warnings": { uk: "Попередження", ru: "Предупреждения", en: "Warnings" },
  "opsd.q.warningsHint": { uk: "дані тихо вводять в оману", ru: "данные тихо вводят в заблуждение", en: "the data quietly mislead" },
  "opsd.q.infos": { uk: "До відома", ru: "К сведению", en: "For information" },
  "opsd.q.infosHint": { uk: "не спотворюють зданого, але варто знати", ru: "не искажают сданного, но стоит знать", en: "do not distort submitted data, but worth knowing" },
  "opsd.q.clean": { uk: "Без знахідок", ru: "Без находок", en: "Clean checks" },
  "opsd.q.checkedAt": { uk: "перевірено {at}", ru: "проверено {at}", en: "checked {at}" },
  "opsd.q.surveyQuality": {
    uk: "Дрейф вибірки, частка завершених і тест-ретест окремої методики — в аналітиці тестів, вид «Якість».",
    ru: "Дрейф выборки, доля завершённых и тест-ретест отдельной методики — в аналитике тестов, вид «Качество».",
    en: "Sample drift, completion and test–retest for a single instrument are in test analytics, “Quality” view.",
  },
  "opsd.q.surveyQualityLink": { uk: "Аналітика тестів", ru: "Аналитика тестов", en: "Test analytics" },
  "opsd.q.checks": { uk: "Перевірки", ru: "Проверки", en: "Checks" },
  "opsd.q.cleanOne": { uk: "Чисто", ru: "Чисто", en: "Clean" },
  "opsd.q.danger": { uk: "Чим небезпечно", ru: "Чем опасно", en: "Why it matters" },
  "opsd.q.examples": { uk: "Приклади", ru: "Примеры", en: "Examples" },
  "opsd.q.bySurvey": { uk: "За методиками", ru: "По методикам", en: "By instrument" },
  "opsd.q.unitResponses": { uk: "проходжень", ru: "прохождений", en: "responses" },
  "opsd.q.unitSurveys": { uk: "методик", ru: "методик", en: "instruments" },
  "opsd.level.error": { uk: "Помилка", ru: "Ошибка", en: "Error" },
  "opsd.level.warning": { uk: "Попередження", ru: "Предупреждение", en: "Warning" },
  "opsd.level.info": { uk: "До відома", ru: "К сведению", en: "Info" },
  "opsd.chk.noVersion": { uk: "Проходження без версії", ru: "Прохождения без версии", en: "Responses without a version" },
  "opsd.chk.noVersionWhy": {
    uk: "Версію методики видалено, відповіді залишились: якими питаннями й ключем їх читати — невідомо, перерахувати чи перевірити бали нічим.",
    ru: "Версию методики удалили, ответы остались: какими вопросами и ключом их читать — неизвестно, пересчитать или проверить баллы нечем.",
    en: "The instrument version was deleted but the answers remain: which questions and key they belong to is unknown, and the scores cannot be recalculated or checked.",
  },
  "opsd.chk.foreignVersion": { uk: "Проходження на версії іншої методики", ru: "Прохождения на версии другой методики", en: "Responses on another instrument’s version" },
  "opsd.chk.foreignVersionWhy": {
    uk: "Зовнішній ключ перевіряє, що версія існує, але не що вона своя: проходження тлумачиться чужими питаннями й шкалами.",
    ru: "Внешний ключ проверяет, что версия существует, но не что она своя: прохождение толкуется чужими вопросами и шкалами.",
    en: "The foreign key checks that the version exists, not that it is the right one: the response is read through someone else’s questions and scales.",
  },
  "opsd.chk.foreignAnswer": { uk: "Відповіді на пункти чужої версії", ru: "Ответы на пункты чужой версии", en: "Answers to items of another version" },
  "opsd.chk.foreignAnswerWhy": {
    uk: "Протокол показує питання своєї версії — такої відповіді на ньому не видно зовсім, а в бали вона могла потрапити.",
    ru: "Протокол показывает вопросы своей версии — такого ответа на нём не видно вовсе, а в баллы он мог попасть.",
    en: "The protocol shows its own version’s questions — such an answer is invisible there, yet it may have counted towards the scores.",
  },
  "opsd.chk.foreignScore": { uk: "Бали на шкалах чужої версії", ru: "Баллы на шкалах чужой версии", en: "Scores on scales of another version" },
  "opsd.chk.foreignScoreWhy": {
    uk: "Динаміка зіставляє шкали за кодом, а смуги бере в шкали — смуга виявиться з іншої редакції методики, з іншими межами.",
    ru: "Динамика сопоставляет шкалы по коду, а полосы берёт у шкалы — полоса окажется от другой редакции методики, с другими границами.",
    en: "Dynamics match scales by code but take bands from the scale — the band will come from another edition with different cut-offs.",
  },
  "opsd.chk.dangling": { uk: "Методика посилається на відсутню версію", ru: "Методика ссылается на отсутствующую версию", en: "Instrument points to a missing version" },
  "opsd.chk.danglingWhy": {
    uk: "Чинну версію не тримає жоден зовнішній ключ. Опублікована методика без неї не відкривається ні для проходження, ні в конструкторі.",
    ru: "Действующую версию не держит ни один внешний ключ. Опубликованная методика без неё не открывается ни для прохождения, ни в конструкторе.",
    en: "No foreign key guards the current version. A published instrument without one opens neither for responding nor in the builder.",
  },
  "opsd.chk.keyAcross": { uk: "Ключ шкали через межу версій", ru: "Ключ шкалы через границу версий", en: "Scale key crossing versions" },
  "opsd.chk.keyAcrossWhy": {
    uk: "Нова версія рахує бал за пунктом старої, якого людина не бачила й на який не відповідала: сума тихо занижена.",
    ru: "Новая версия считает балл по пункту старой, которого человек не видел и на который не отвечал: сумма тихо занижена.",
    en: "The new version scores an item of the old one that the person never saw or answered: the sum is quietly too low.",
  },
  "opsd.chk.noScores": { uk: "Здано без балів при ввімкненому підрахунку", ru: "Сдано без баллов при включённом подсчёте", en: "Submitted without scores while scoring is on" },
  "opsd.chk.noScoresWhy": {
    uk: "Проходження є в списку, але його немає в динаміці, аналітиці, когортах і статистиці — вони читають збережені бали.",
    ru: "Прохождение есть в списке, но его нет в динамике, аналитике, когортах и статистике — они читают сохранённые баллы.",
    en: "The response is listed but missing from dynamics, analytics, cohorts and statistics — they read stored scores.",
  },
  "opsd.chk.noBands": { uk: "Підрахунок увімкнено, смуг немає", ru: "Подсчёт включён, полос нет", en: "Scoring on, no bands" },
  "opsd.chk.noBandsWhy": {
    uk: "Бал порахується, але без ступеня: ні «помірна», ні тривоги за смугою, ні каскаду поглибленої діагностики.",
    ru: "Балл посчитается, но без степени: ни «умеренная», ни тревоги по полосе, ни каскада углублённой диагностики.",
    en: "A score is computed but without a level: no “moderate”, no band alerts, no cascade to in-depth assessment.",
  },
  "opsd.chk.unnormalized": { uk: "Ненормовані бали", ru: "Ненормированные баллы", en: "Unnormalized scores" },
  "opsd.chk.unnormalizedWhy": {
    uk: "Немає норм для статі й віку або бал поза таблицею стенів: у значенні лежить сирий бал, який поруч із T-балами сусідів виглядає числом тієї ж шкали.",
    ru: "Нет норм для пола и возраста или балл вне таблицы стенов: в значении лежит сырой балл, который рядом с T-баллами соседей выглядит числом той же шкалы.",
    en: "No norms for this sex and age, or the score is outside the sten table: the value holds a raw score that looks like the neighbours’ T-scores but is not.",
  },
  "opsd.chk.missing": { uk: "Пункти без відповіді у зданих проходженнях", ru: "Пункты без ответа в сданных прохождениях", en: "Unanswered items in submitted responses" },
  "opsd.chk.missingWhy": {
    uk: "Пункт входить у ключ шкали або обов’язковий: сума порахована за неповним набором і занижена, а на вигляд від чесної не відрізняється.",
    ru: "Пункт входит в ключ шкалы или обязателен: сумма посчитана по неполному набору и занижена, а на вид от честной не отличается.",
    en: "The item is keyed to a scale or required: the sum is computed from an incomplete set and is too low, yet looks like an honest one.",
  },
  "opsd.chk.duplicates": { uk: "Та сама методика двічі за хвилину", ru: "Одна методика дважды за минуту", en: "Same instrument twice within a minute" },
  "opsd.chk.duplicatesWhy": {
    uk: "Подвійне натискання або повторна відправка без ідентифікатора спроби: людина у вибірці подвоєна, у динаміці — «зміна» за шістдесят секунд.",
    ru: "Двойное нажатие или повторная отправка без идентификатора попытки: человек в выборке удвоен, в динамике — «изменение» за шестьдесят секунд.",
    en: "A double tap or a resend without an attempt id: the person is counted twice in samples and shows a “change” within sixty seconds.",
  },
  "opsd.chk.stale": { uk: "Незавершені проходження", ru: "Незавершённые прохождения", en: "Unfinished responses" },
  "opsd.chk.staleWhy": {
    uk: "Зданого не спотворюють, але накопичуються: тримають відкритими призначення, занижують частку завершених, а чернетку, що висить тижнями, вже не здадуть.",
    ru: "Сданного не искажают, но копятся: держат открытыми назначения, занижают долю завершённых, а черновик, висящий неделями, уже не сдадут.",
    en: "They do not distort submitted data but pile up: keep assignments open, lower completion, and a draft hanging for weeks will never be submitted.",
  },
  "opsd.x.inProgress": { uk: "у процесі", ru: "в процессе", en: "in progress" },
  "opsd.x.abandoned": { uk: "перервані", ru: "прерваны", en: "interrupted" },
  "opsd.x.lt1d": { uk: "до доби", ru: "до суток", en: "under a day" },
  "opsd.b.1to7d": { uk: "1–7 днів", ru: "1–7 дней", en: "1–7 days" },
  "opsd.x.lt30d": { uk: "7–30 днів", ru: "7–30 дней", en: "7–30 days" },
  "opsd.x.gte30d": { uk: "понад 30 днів", ru: "больше 30 дней", en: "over 30 days" },
  "opsd.x.items": { uk: "пунктів", ru: "пунктов", en: "items" },
  "opsd.x.required": { uk: "з них обов’язкових", ru: "из них обязательных", en: "of them required" },
  "opsd.x.scores": { uk: "балів", ru: "баллов", en: "scores" },
  "opsd.x.scales": { uk: "шкал без смуг", ru: "шкал без полос", en: "scales without bands" },
  "opsd.x.noScales": { uk: "методик без шкал", ru: "методик без шкал", en: "instruments without scales" },
  "opsd.x.links": { uk: "зв’язків через межу", ru: "связей через границу", en: "cross-version links" },

  /* використання */
  "opsd.app.console": { uk: "Консоль", ru: "Консоль", en: "Console" },
  "opsd.app.patient": { uk: "Кабінет пацієнта", ru: "Кабинет пациента", en: "Patient portal" },
  "opsd.app.mobile": { uk: "Застосунок", ru: "Приложение", en: "App" },
  "opsd.u.screens": { uk: "Які екрани відкривають", ru: "Какие экраны открывают", en: "Which screens are opened" },
  "opsd.u.screensHint": {
    uk: "Лічильник за шаблоном маршруту на день — /patients/:userId, а не адреса з ідентифікатором: хто чию картку відкривав, тут не видно й не має бути. Без людей і без тексту.",
    ru: "Счётчик по шаблону маршрута за день — /patients/:userId, а не адрес с идентификатором: кто чью карточку открывал, здесь не видно и не должно быть. Без людей и без текста.",
    en: "A daily counter per route template — /patients/:userId, never an address with an id: who opened whose record is not visible here and must not be. No people, no text.",
  },
  "opsd.u.app": { uk: "Застосунок", ru: "Приложение", en: "App" },
  "opsd.u.route": { uk: "Шаблон маршруту", ru: "Шаблон маршрута", en: "Route template" },
  "opsd.u.views": { uk: "Відкриттів", ru: "Открытий", en: "Opens" },
  "opsd.u.days": { uk: "Днів", ru: "Дней", en: "Days" },
  "opsd.u.noScreens": {
    uk: "Лічильників за вікно ще немає: консоль і застосунок відправляють їх пачками, раз на хвилину.",
    ru: "Счётчиков за окно ещё нет: консоль и приложение отправляют их пачками, раз в минуту.",
    en: "No counters for this window yet: the console and the app send them in batches once a minute.",
  },
  "opsd.u.viewsByDay": { uk: "Відкриття за днями", ru: "Открытия по дням", en: "Opens by day" },
  "opsd.u.total": { uk: "За вікно", ru: "За окно", en: "In window" },
  "opsd.u.active": { uk: "Активні люди", ru: "Активные люди", en: "Active people" },
  "opsd.u.activeHint": {
    uk: "Унікальні за день. Пацієнти — через поріг малих клітинок: «—» означає «менше {n}», а не нуль.",
    ru: "Уникальные за день. Пациенты — через порог малых ячеек: «—» значит «меньше {n}», а не ноль.",
    en: "Unique per day. Patients go through the small-cell threshold: “—” means “fewer than {n}”, not zero.",
  },
  "opsd.u.staff7": { uk: "Фахівці · 7 днів", ru: "Специалисты · 7 дней", en: "Clinicians · 7 days" },
  "opsd.u.staff30": { uk: "Фахівці · 30 днів", ru: "Специалисты · 30 дней", en: "Clinicians · 30 days" },
  "opsd.u.patients7": { uk: "Пацієнти · 7 днів", ru: "Пациенты · 7 дней", en: "Patients · 7 days" },
  "opsd.u.patients30": { uk: "Пацієнти · 30 днів", ru: "Пациенты · 30 дней", en: "Patients · 30 days" },
  "opsd.u.staffByDay": { uk: "Фахівці за днями", ru: "Специалисты по дням", en: "Clinicians by day" },
  "opsd.u.patientsByDay": { uk: "Пацієнти за днями", ru: "Пациенты по дням", en: "Patients by day" },
  "opsd.u.sources": {
    uk: "Звідки сервер знає про активність: входи, оновлення сесій, проходження. Людина за день рахується один раз, скільки б слідів не лишила.",
    ru: "Откуда сервер знает об активности: входы, обновления сессий, прохождения. Человек за день считается один раз, сколько бы следов ни оставил.",
    en: "Where the server learns of activity: sign-ins, session refreshes, responses. A person counts once per day however many traces they leave.",
  },
  "opsd.u.funnel": { uk: "Шлях пацієнта", ru: "Путь пациента", en: "Patient funnel" },
  "opsd.u.funnelHint": {
    uk: "Запрошення, видані за {days} днів, і люди, що прийшли за ними. Повторне проходження — здачі у двох різних днях: батарея з трьох методик за один прихід — не повернення.",
    ru: "Приглашения, выписанные за {days} дней, и люди, пришедшие по ним. Повторное прохождение — сдачи в двух разных днях: батарея из трёх методик за один приход — не возвращение.",
    en: "Invitations issued in the last {days} days and the people who came through them. A repeat means submissions on two different days: a battery of three in one visit is not a return.",
  },
  "opsd.u.invites": { uk: "Запрошень видано", ru: "Приглашений выписано", en: "Invitations issued" },
  "opsd.u.registered": { uk: "Зареєструвалися за запрошенням", ru: "Зарегистрировались по приглашению", en: "Registered via invitation" },
  "opsd.u.first": { uk: "Перше проходження", ru: "Первое прохождение", en: "First response" },
  "opsd.u.repeat": { uk: "Повторне проходження", ru: "Повторное прохождение", en: "Repeat response" },
  "opsd.u.conv": { uk: "{p}% від попереднього кроку", ru: "{p}% от предыдущего шага", en: "{p}% of the previous step" },
  "opsd.u.self": { uk: "Зареєструвалися без запрошення", ru: "Зарегистрировались без приглашения", en: "Registered without an invitation" },
  "opsd.u.invitesNote": {
    uk: "Запрошення — документи, а не люди, тому порогу не підлягають; ступені з людьми — підлягають.",
    ru: "Приглашения — документы, а не люди, поэтому порогу не подлежат; ступени с людьми — подлежат.",
    en: "Invitations are documents, not people, so the threshold does not apply to them; steps counting people are thresholded.",
  },

  /* мобільний застосунок */
  "opsd.m.versions": { uk: "Версії застосунку", ru: "Версии приложения", en: "App versions" },
  "opsd.m.versionsHint": {
    uk: "Застосунок рахує бали офлайн тим самим рушієм, що й сервер: виправлення в рушії доходить до людини лише з новою збіркою. Стара — нижча за найновішу з помічених за вікно.",
    ru: "Приложение считает баллы офлайн тем же движком, что и сервер: исправление в движке доходит до человека только с новой сборкой. Старая — ниже самой новой из замеченных за окно.",
    en: "The app scores offline with the same engine as the server: an engine fix reaches a person only with a new build. Old means below the newest seen in the window.",
  },
  "opsd.m.devices": { uk: "Пристроїв за вікно", ru: "Устройств за окно", en: "Devices in window" },
  "opsd.m.old": { uk: "На старих збірках", ru: "На старых сборках", en: "On old builds" },
  "opsd.m.oldShare": { uk: "{p}% пристроїв із відомою версією", ru: "{p}% устройств с известной версией", en: "{p}% of devices with a known version" },
  "opsd.m.newest": { uk: "Найновіша версія", ru: "Самая новая версия", en: "Newest version" },
  "opsd.m.unknown": { uk: "Версія невідома", ru: "Версия неизвестна", en: "Version unknown" },
  "opsd.m.unknownHint": {
    uk: "відмічалися до оновлення сервера — повідомлять версію при наступному запуску",
    ru: "отмечались до обновления сервера — сообщат версию при следующем запуске",
    en: "checked in before the server update — will report the version on next launch",
  },
  "opsd.m.platform": { uk: "Платформа", ru: "Платформа", en: "Platform" },
  "opsd.m.version": { uk: "Версія", ru: "Версия", en: "Version" },
  "opsd.m.build": { uk: "Збірка", ru: "Сборка", en: "Build" },
  "opsd.m.devicesCol": { uk: "Пристроїв", ru: "Устройств", en: "Devices" },
  "opsd.m.lastSeen": { uk: "Останній вихід на зв’язок", ru: "Последний выход на связь", en: "Last seen" },
  "opsd.m.oldTag": { uk: "стара", ru: "старая", en: "old" },
  "opsd.m.noDevices": { uk: "За вікно жоден пристрій не виходив на зв’язок.", ru: "За окно ни одно устройство не выходило на связь.", en: "No device checked in during this window." },
  "opsd.m.queue": { uk: "Черга на пристроях", ru: "Очередь на устройствах", en: "Queues on devices" },
  "opsd.m.queueHint": {
    uk: "Сервер бачить чергу лише зі слів пристрою — при його наступній відмітці. Відхилені сервером здачі самі не повторюються й чекають, поки людина відкриє екран черги.",
    ru: "Сервер видит очередь только со слов устройства — при его следующей отметке. Отклонённые сервером сдачи сами не повторяются и ждут, пока человек откроет экран очереди.",
    en: "The server sees a queue only as the device reports it — at its next check-in. Submissions rejected by the server are not retried and wait until the person opens the queue screen.",
  },
  "opsd.m.reporting": { uk: "Пристроїв повідомили", ru: "Устройств сообщили", en: "Devices reporting" },
  "opsd.m.pending": { uk: "Чекають відправки", ru: "Ждут отправки", en: "Waiting to send" },
  "opsd.m.rejected": { uk: "Відхилено сервером", ru: "Отклонено сервером", en: "Rejected by server" },
  "opsd.m.onDevices": { uk: "на {n} пристроях", ru: "на {n} устройствах", en: "on {n} devices" },
  "opsd.m.late": { uk: "Запізнілі здачі", ru: "Опоздавшие сдачи", en: "Late submissions" },
  "opsd.m.lateHint": {
    uk: "Досилки з офлайн-черги. Запізнення — час прийому сервером мінус час, коли людина закінчила, за годинником пристрою: він буває неточним на хвилини, тому кошики великі.",
    ru: "Досылки из офлайн-очереди. Опоздание — время приёма сервером минус время, когда человек закончил, по часам устройства: они бывают неточны на минуты, поэтому корзины крупные.",
    en: "Deliveries from the offline queue. Delay is server receipt time minus when the person finished by the device clock — which can be off by minutes, hence the coarse buckets.",
  },
  "opsd.m.lateTotal": { uk: "Досилок", ru: "Досылок", en: "Queued submissions" },
  "opsd.m.lateOf": { uk: "з {n} здач за вікно", ru: "из {n} сдач за окно", en: "of {n} submissions in window" },
  "opsd.m.median": { uk: "Медіана запізнення", ru: "Медиана опоздания", en: "Median delay" },
  "opsd.m.p90": { uk: "9 з 10 — не пізніше", ru: "9 из 10 — не позже", en: "9 in 10 within" },
  "opsd.m.lateBuckets": { uk: "Наскільки запізнились", ru: "Насколько опоздали", en: "How late" },
  "opsd.m.lateByDay": { uk: "Досилки за днями", ru: "Досылки по дням", en: "Queued submissions by day" },
  "opsd.m.lt1h": { uk: "до години", ru: "до часа", en: "under an hour" },
  "opsd.m.lt1d": { uk: "година — доба", ru: "час — сутки", en: "an hour to a day" },
  "opsd.m.gte7d": { uk: "тиждень і більше", ru: "неделя и больше", en: "a week or more" },
  "opsd.lag.min": { uk: "{n} хв", ru: "{n} мин", en: "{n} min" },
  "opsd.lag.h": { uk: "{n} год", ru: "{n} ч", en: "{n} h" },
  "opsd.lag.d": { uk: "{n} дн", ru: "{n} дн", en: "{n} d" },
  "opsd.m.crashes": { uk: "Падіння", ru: "Падения", en: "Crashes" },
  "opsd.m.crashesHint": {
    uk: "Падіння й помилки застосунку збирає розділ помилок клієнта техпанелі; його зведення стане тут. Своїм збором цей розділ не займається, щоб два лічильники не розходилися.",
    ru: "Падения и ошибки приложения собирает раздел ошибок клиента техпанели; его сводка встанет здесь. Своим сбором этот раздел не занимается, чтобы два счётчика не расходились.",
    en: "App crashes and errors are collected by the client-errors section of the tech panel; its summary will appear here. This section keeps no collector of its own, so the two counts never disagree.",
  },
  "opsd.platform.ios": { uk: "iOS", ru: "iOS", en: "iOS" },
  "opsd.platform.android": { uk: "Android", ru: "Android", en: "Android" },
  "opsd.platform.web": { uk: "Веб", ru: "Веб", en: "Web" },

  /* пуш-сповіщення */
  "opsd.p.totals": { uk: "Відправлення", ru: "Отправки", en: "Sends" },
  "opsd.p.totalsHint": {
    uk: "Кожне сповіщення на кожному пристрої. Прийнято — Expo видав квиток; передано Apple/Google — прийшла квитанція. Доставку до самого пристрою не повідомляє ніхто — ні Expo, ні Apple, ні Google, — тому «доставлено» тут не пишемо.",
    ru: "Каждое уведомление на каждом устройстве. Принято — Expo выдал билет; передано Apple/Google — пришла квитанция. Доставку до самого устройства не сообщает никто — ни Expo, ни Apple, ни Google, — поэтому «доставлено» здесь не пишем.",
    en: "Every notification on every device. Accepted means Expo issued a ticket; handed to Apple/Google means a receipt came back. Nobody reports delivery to the device itself — not Expo, Apple or Google — so we never say “delivered”.",
  },
  "opsd.p.noneYet": {
    uk: "Журнал результатів ведеться з міграції 0091; відправлень ще не було.",
    ru: "Журнал исходов ведётся с миграции 0091; отправок ещё не было.",
    en: "Outcomes are logged since migration 0091; nothing has been sent yet.",
  },
  "opsd.p.since": { uk: "Журнал результатів ведеться з {at}.", ru: "Журнал исходов ведётся с {at}.", en: "Outcomes are logged since {at}." },
  "opsd.p.sent": { uk: "Відправлено", ru: "Отправлено", en: "Sent" },
  "opsd.p.accepted": { uk: "Прийнято Expo", ru: "Принято Expo", en: "Accepted by Expo" },
  "opsd.p.delivered": { uk: "Передано Apple/Google", ru: "Передано Apple/Google", en: "Handed to Apple/Google" },
  "opsd.p.awaiting": { uk: "Чекають квитанції", ru: "Ждут квитанции", en: "Awaiting receipt" },
  "opsd.p.awaitingHint": {
    uk: "квитанції забираються щогодини, Expo зберігає їх добу",
    ru: "квитанции забираются ежечасно, Expo хранит их сутки",
    en: "receipts are fetched hourly; Expo keeps them for a day",
  },
  "opsd.p.byDay": { uk: "Відправлено за днями", ru: "Отправлено по дням", en: "Sent by day" },
  "opsd.p.errorsByDay": { uk: "Помилки за днями", ru: "Ошибки по дням", en: "Errors by day" },
  "opsd.p.byKind": { uk: "За типами сповіщень", ru: "По типам уведомлений", en: "By notification type" },
  "opsd.p.kind": { uk: "Тип", ru: "Тип", en: "Type" },
  "opsd.p.errorsCol": { uk: "Помилок", ru: "Ошибок", en: "Errors" },
  "opsd.p.deliveredCol": { uk: "Передано", ru: "Передано", en: "Handed over" },
  "opsd.p.nothing": { uk: "За вікно сповіщень не відправляли.", ru: "За окно уведомлений не отправляли.", en: "No notifications were sent in this window." },
  "opsd.p.errorCodes": { uk: "Помилки за кодами", ru: "Ошибки по кодам", en: "Errors by code" },
  "opsd.p.errorCodesHint": {
    uk: "Коди — як їх пише Expo, і свої: мережа, тайм-аут, відповідь HTTP. Застосунок, про який Expo сказав DeviceNotRegistered, сервер забуває сам.",
    ru: "Коды — как их пишет Expo, и свои: сеть, тайм-аут, ответ HTTP. Устройство, о котором Expo сказал DeviceNotRegistered, сервер забывает сам.",
    en: "Codes as Expo writes them, plus our own: network, timeout, HTTP response. A device Expo reports as DeviceNotRegistered is forgotten by the server automatically.",
  },
  "opsd.p.code": { uk: "Код", ru: "Код", en: "Code" },
  "opsd.p.count": { uk: "Разів", ru: "Раз", en: "Times" },
  "opsd.p.meaning": { uk: "Що це означає", ru: "Что это значит", en: "What it means" },
  "opsd.p.noErrors": { uk: "Помилок за вікно не було.", ru: "Ошибок за окно не было.", en: "No errors in this window." },
  "opsd.p.tokens": { uk: "Токени пристроїв", ru: "Токены устройств", en: "Device tokens" },
  "opsd.p.registered": { uk: "Зареєстровано", ru: "Зарегистрировано", en: "Registered" },
  "opsd.p.stale": { uk: "Давно не оновлювались", ru: "Давно не обновлялись", en: "Not refreshed lately" },
  "opsd.p.staleHint": { uk: "понад 90 днів без перереєстрації", ru: "больше 90 дней без перерегистрации", en: "over 90 days without re-registering" },
  "opsd.p.events": { uk: "Події за типами", ru: "События по типам", en: "Events by type" },
  "opsd.p.eventsHint": {
    uk: "Кому вирішили відправити — одна подія на людину, скільки б у неї не було пристроїв",
    ru: "Кому решили отправить — одно событие на человека, сколько бы у него ни было устройств",
    en: "Who a send was decided for — one event per person, however many devices they have",
  },
  "opsd.p.fingerprints": {
    uk: "Токенів у панелі немає — лише відбитки: токен є адресою пристрою людини, і з ним сповіщення пішло б в обхід системи.",
    ru: "Токенов в панели нет — только отпечатки: токен — адрес устройства человека, и с ним уведомление ушло бы в обход системы.",
    en: "The panel holds no tokens — only fingerprints: a token is the address of a person’s device, and with it a notification could bypass the system.",
  },
  "opsd.kind.alert": { uk: "Тривога", ru: "Тревога", en: "Alert" },
  "opsd.kind.mailing": { uk: "Розсилка", ru: "Рассылка", en: "Mailing" },
  "opsd.kind.appointment": { uk: "Прийом", ru: "Приём", en: "Appointment" },
  "opsd.kind.assignment": { uk: "Призначення", ru: "Назначение", en: "Assignment" },
  "opsd.code.http": { uk: "Expo відповів помилкою HTTP — сервіс лежав або відмовив у запиті", ru: "Expo ответил ошибкой HTTP — сервис лежал или отказал в запросе", en: "Expo answered with an HTTP error — the service was down or refused the request" },
  "opsd.code.deviceNotRegistered": { uk: "Застосунок видалено або перевстановлено: адреси більше немає, токен забуто", ru: "Приложение удалено или переустановлено: адреса больше нет, токен забыт", en: "The app was removed or reinstalled: the address no longer exists, token forgotten" },
  "opsd.code.tooBig": { uk: "Повідомлення завелике для сервісу", ru: "Сообщение слишком велико для сервиса", en: "The message is too large for the service" },
  "opsd.code.rate": { uk: "Забагато сповіщень на один пристрій за короткий час", ru: "Слишком много уведомлений на одно устройство за короткое время", en: "Too many notifications to one device in a short time" },
  "opsd.code.credentials": { uk: "Ключі Apple чи Google у проєкті Expo недійсні — не дійде жодне", ru: "Ключи Apple или Google в проекте Expo недействительны — не дойдёт ни одно", en: "Apple or Google credentials in the Expo project are invalid — nothing will get through" },
  "opsd.code.network": { uk: "До Expo не достукалися: мережа", ru: "До Expo не достучались: сеть", en: "Could not reach Expo: network" },
  "opsd.code.timeout": { uk: "Expo не відповів за 15 секунд", ru: "Expo не ответил за 15 секунд", en: "Expo did not answer within 15 seconds" },

  /* ── wave10:sec ── */
  "ops.tab.keys": { uk: "Ключі й секрети", ru: "Ключи и секреты", en: "Keys and secrets" },
  "ops.tab.integrity": { uk: "Цілісність", ru: "Целостность", en: "Integrity" },
  "ops.tab.sql": { uk: "SQL (читання)", ru: "SQL (чтение)", en: "SQL (read-only)" },
  "ops.sec.superOnly": {
    uk: "Лише суперадмін: розділ не відкривається жодним правом, і перевіряє це сервер.",
    ru: "Только суперадмин: раздел не открывается никаким правом, и проверяет это сервер.",
    en: "Superadmin only: no permission opens this section, and the server enforces it.",
  },
  "ops.sec.none": { uk: "немає", ru: "нет", en: "none" },
  "ops.sec.checkedAt": { uk: "Пораховано", ru: "Посчитано", en: "Counted" },

  "ops.sec.keys.lead": {
    uk: "Самих ключів і секретів панель не бачить і не показує — лише версії, «задано / не задано» і дати.",
    ru: "Самих ключей и секретов панель не видит и не показывает — только версии, «задан / не задан» и даты.",
    en: "The panel never sees or shows keys and secrets themselves — only versions, “set / not set” and dates.",
  },
  "ops.sec.keys.title": { uk: "Ключ шифрування полів", ru: "Ключ шифрования полей", en: "Field encryption key" },
  "ops.sec.keys.active": { uk: "Основний ключ", ru: "Основной ключ", en: "Primary key" },
  "ops.sec.keys.loaded": { uk: "Завантажені з оточення", ru: "Загружены из окружения", en: "Loaded from environment" },
  "ops.sec.keys.activeSince": {
    uk: "основним його видно з {date}",
    ru: "основным его видно с {date}",
    en: "primary since {date}",
  },
  "ops.sec.keys.off": {
    uk: "Шифрування вимкнене: ENCRYPTION_KEY не задано. ПІБ, дата народження, телефон і тексти лягають у базу відкритими.",
    ru: "Шифрование выключено: ENCRYPTION_KEY не задан. ФИО, дата рождения, телефон и тексты ложатся в базу открытыми.",
    en: "Encryption is off: ENCRYPTION_KEY is not set. Names, dates of birth, phones and texts are stored in plain text.",
  },
  "ops.sec.keys.lost": {
    uk: "Втрата даних: {n} значень і файлів зашифровано ключами, яких немає в оточенні ({keys}). Їх не прочитати, доки ключ не повернуто в ENCRYPTION_KEY.",
    ru: "Потеря данных: {n} значений и файлов зашифрованы ключами, которых нет в окружении ({keys}). Их не прочитать, пока ключ не возвращён в ENCRYPTION_KEY.",
    en: "Data loss: {n} values and files are encrypted with keys missing from the environment ({keys}). They cannot be read until the key is back in ENCRYPTION_KEY.",
  },
  "ops.sec.keys.plain": {
    uk: "Відкритим текстом лежить {n} значень — «Перешифрувати» їх зашифрує.",
    ru: "Открытым текстом лежит {n} значений — «Перешифровать» их зашифрует.",
    en: "{n} values are stored in plain text — “Re-encrypt” will encrypt them.",
  },
  "ops.sec.keys.colVersion": { uk: "Версія", ru: "Версия", en: "Version" },
  "ops.sec.keys.colState": { uk: "Стан", ru: "Состояние", en: "State" },
  "ops.sec.keys.colValues": { uk: "Значень", ru: "Значений", en: "Values" },
  "ops.sec.keys.colFiles": { uk: "Файлів записів", ru: "Файлов записей", en: "Recording files" },
  "ops.sec.keys.colOpens": { uk: "Пробне розшифрування", ru: "Пробная расшифровка", en: "Test decryption" },
  "ops.sec.keys.stateActive": { uk: "основний", ru: "основной", en: "primary" },
  "ops.sec.keys.stateOld": { uk: "додатковий", ru: "дополнительный", en: "secondary" },
  "ops.sec.keys.stateMissing": { uk: "немає в оточенні", ru: "нет в окружении", en: "missing from environment" },
  "ops.sec.keys.opensYes": { uk: "відкриває свої значення", ru: "открывает свои значения", en: "opens its values" },
  "ops.sec.keys.opensNo": {
    uk: "НЕ відкриває — вміст ключа змінено за тієї ж назви",
    ru: "НЕ открывает — содержимое ключа изменено при том же имени",
    en: "does NOT open — key content changed under the same name",
  },
  "ops.sec.keys.byColumn": { uk: "За колонками", ru: "По колонкам", en: "By column" },
  "ops.sec.keys.colColumn": { uk: "Таблиця й колонка", ru: "Таблица и колонка", en: "Table and column" },
  "ops.sec.keys.colPlain": { uk: "Відкрито", ru: "Открыто", en: "Plain" },
  "ops.sec.keys.noPk": {
    uk: "без первинного ключа — перешифрування її оминає",
    ru: "без первичного ключа — перешифровка её обходит",
    en: "no primary key — re-encryption skips it",
  },
  "ops.sec.keys.files": { uk: "Файли записів прийому", ru: "Файлы записей приёма", en: "Visit recording files" },
  "ops.sec.keys.filesLegacy": {
    uk: "без заголовка: {n} — читаються лише основним ключем, тож після зміни основного без перешифрування не відкриються",
    ru: "без заголовка: {n} — читаются только основным ключом, так что после смены основного без перешифровки не откроются",
    en: "without header: {n} — readable only with the primary key, so after the primary changes they will not open unless re-encrypted",
  },
  "ops.sec.keys.filesMissing": { uk: "немає на диску: {n}", ru: "нет на диске: {n}", en: "missing on disk: {n}" },

  "ops.sec.rot.title": { uk: "Ротація ключа", ru: "Ротация ключа", en: "Key rotation" },
  "ops.sec.rot.state.done": { uk: "зроблено", ru: "сделано", en: "done" },
  "ops.sec.rot.state.current": { uk: "зараз", ru: "сейчас", en: "now" },
  "ops.sec.rot.state.todo": { uk: "далі", ru: "дальше", en: "next" },
  "ops.sec.rot.state.blocked": { uk: "зупинено", ru: "остановлено", en: "blocked" },
  "ops.sec.rot.step.add": { uk: "Додати новий ключ основним", ru: "Добавить новый ключ основным", en: "Add the new key as primary" },
  "ops.sec.rot.addBody": {
    uk: "На сервері: згенерувати ключ і поставити його ПЕРШИМ у ENCRYPTION_KEY, старий лишити в списку. Панель цього не робить — ключів вона не знає.",
    ru: "На сервере: сгенерировать ключ и поставить его ПЕРВЫМ в ENCRYPTION_KEY, старый оставить в списке. Панель этого не делает — ключей она не знает.",
    en: "On the server: generate a key and put it FIRST in ENCRYPTION_KEY, keeping the old one in the list. The panel does not do this — it does not know the keys.",
  },
  "ops.sec.rot.addCheck": {
    uk: "Перевірте: новий — першим, старий — у списку, ключ записано окремо від бекапів бази.",
    ru: "Проверьте: новый — первым, старый — в списке, ключ записан отдельно от бэкапов базы.",
    en: "Check: new key first, old key still listed, the key is stored separately from database backups.",
  },
  "ops.sec.rot.commands": { uk: "Команди на сервері", ru: "Команды на сервере", en: "Commands on the server" },
  "ops.sec.rot.placeholder": { uk: "ключ", ru: "ключ", en: "key" },
  "ops.sec.rot.step.restart": { uk: "Перезапустити API", ru: "Перезапустить API", en: "Restart the API" },
  "ops.sec.rot.restartBody": {
    uk: "Після перезапуску панель побачить новий ключ основним. Зараз основний — {key}.",
    ru: "После перезапуска панель увидит новый ключ основным. Сейчас основной — {key}.",
    en: "After the restart the panel will see the new key as primary. The primary now is {key}.",
  },
  "ops.sec.rot.step.reencrypt": { uk: "Перешифрувати", ru: "Перешифровать", en: "Re-encrypt" },
  "ops.sec.rot.reencryptBody": {
    uk: "Фоновий прохід переводить на основний ключ усе, що лежить на інших ключах або відкритим текстом, разом із файлами записів прийому. Порціями й у журнал; перерваний прохід можна запустити знову — він продовжить.",
    ru: "Фоновый проход переводит на основной ключ всё, что лежит на других ключах или открытым текстом, вместе с файлами записей приёма. Порциями и в журнал; прерванный проход можно запустить снова — он продолжит.",
    en: "A background pass moves everything on other keys or in plain text to the primary key, recording files included. In batches and logged; an interrupted pass can be started again and will continue.",
  },
  "ops.sec.rot.run": { uk: "Перешифрувати", ru: "Перешифровать", en: "Re-encrypt" },
  "ops.sec.rot.running": { uk: "Іде перешифрування", ru: "Идёт перешифровка", en: "Re-encryption running" },
  "ops.sec.rot.progress": { uk: "оброблено {done} з {total}", ru: "обработано {done} из {total}", en: "{done} of {total} processed" },
  "ops.sec.rot.skipped": {
    uk: "не розшифровано й лишено як було: {n}",
    ru: "не расшифровано и оставлено как было: {n}",
    en: "could not be decrypted and left as is: {n}",
  },
  "ops.sec.rot.jobDone": { uk: "Останній прохід завершено {time}", ru: "Последний проход завершён {time}", en: "Last pass finished {time}" },
  "ops.sec.rot.jobFailed": { uk: "Прохід зупинився з помилкою: {error}", ru: "Проход остановился с ошибкой: {error}", en: "The pass stopped with an error: {error}" },
  "ops.sec.rot.jobInterrupted": {
    uk: "Прохід обірвано: процес перестав відповідати. Запустіть знову — продовжить з місця.",
    ru: "Проход оборван: процесс перестал отвечать. Запустите снова — продолжит с места.",
    en: "The pass was cut off: the process stopped responding. Start it again — it will continue.",
  },
  "ops.sec.rot.nothing": {
    uk: "Перешифровувати нічого: усе на основному ключі.",
    ru: "Перешифровывать нечего: всё на основном ключе.",
    en: "Nothing to re-encrypt: everything is on the primary key.",
  },
  "ops.sec.rot.step.verify": { uk: "Перевірити й прибрати старий", ru: "Проверить и убрать старый", en: "Verify and remove the old key" },
  "ops.sec.rot.removable": {
    uk: "{keys}: нуль значень і файлів — можна прибрати з ENCRYPTION_KEY і перезапустити.",
    ru: "{keys}: ноль значений и файлов — можно убрать из ENCRYPTION_KEY и перезапустить.",
    en: "{keys}: zero values and files — can be removed from ENCRYPTION_KEY, then restart.",
  },
  "ops.sec.rot.busy": {
    uk: "{keys}: ще лежать дані — не прибирати.",
    ru: "{keys}: ещё лежат данные — не убирать.",
    en: "{keys}: data is still there — do not remove.",
  },
  "ops.sec.rot.blocked": {
    uk: "Не прибирати нічого: є дані на ключах, яких немає в оточенні.",
    ru: "Ничего не убирать: есть данные на ключах, которых нет в окружении.",
    en: "Remove nothing: there is data on keys missing from the environment.",
  },
  "ops.sec.rot.idle": {
    uk: "Ротація не йде: в оточенні один ключ.",
    ru: "Ротация не идёт: в окружении один ключ.",
    en: "No rotation in progress: one key in the environment.",
  },

  "ops.sec.secrets.title": { uk: "Інші секрети", ru: "Другие секреты", en: "Other secrets" },
  "ops.sec.secrets.state.set": { uk: "задано", ru: "задан", en: "set" },
  "ops.sec.secrets.state.unset": { uk: "не задано", ru: "не задан", en: "not set" },
  "ops.sec.secrets.state.default": {
    uk: "стоїть значення для розробки",
    ru: "стоит значение для разработки",
    en: "development default in use",
  },
  "ops.sec.secrets.changed": { uk: "змінено {n} дн. тому", ru: "изменён {n} дн. назад", en: "changed {n} days ago" },
  "ops.sec.secrets.tracked": {
    uk: "не менше ніж {n} дн. (стежимо з {date})",
    ru: "не меньше {n} дн. (следим с {date})",
    en: "at least {n} days (tracked since {date})",
  },
  "ops.sec.secrets.unknown": { uk: "вік невідомий", ru: "возраст неизвестен", en: "age unknown" },
  "ops.sec.secrets.gives": { uk: "Що дасть ротація", ru: "Что даст ротация", en: "What rotation gives" },
  "ops.sec.secrets.risks": { uk: "Чим загрожує", ru: "Чем грозит", en: "What it risks" },
  "ops.sec.secrets.JWT_SECRET.gives": {
    uk: "Усі access-токени (30 хв) стануть недійсними: викрадений токен перестане працювати одразу.",
    ru: "Все access-токены (30 мин) станут недействительны: украденный токен перестанет работать сразу.",
    en: "All access tokens (30 min) become invalid: a stolen token stops working at once.",
  },
  "ops.sec.secrets.JWT_SECRET.risks": {
    uk: "Сесії самі не обриваються: консоль і застосунок мовчки обміняють refresh-токен, бо він від секрету не залежить, — щоб справді вивести всіх, окремо відкликати сесії. На цьому ж секреті рахується сліпий індекс пошуку за записами прийому: старі записи перестануть знаходитись до переіндексації (bun src/reindex.ts). Незавершене підключення календаря Google доведеться повторити.",
    ru: "Сессии сами не обрываются: консоль и приложение молча обменяют refresh-токен, потому что он от секрета не зависит, — чтобы действительно вывести всех, отдельно отозвать сессии. На этом же секрете считается слепой индекс поиска по записям приёма: старые записи перестанут находиться до переиндексации (bun src/reindex.ts). Незавершённое подключение календаря Google придётся повторить.",
    en: "Sessions do not end by themselves: the console and app silently exchange the refresh token, which does not depend on this secret — to really sign everyone out, revoke sessions separately. The blind search index over visit notes is computed on this secret too: old notes stop being found until reindexing (bun src/reindex.ts). An unfinished Google Calendar connection has to be repeated.",
  },
  "ops.sec.secrets.PHONE_INDEX_SECRET.gives": {
    uk: "Сліпий індекс телефонів більше не перебрати за старим секретом, якщо той витік.",
    ru: "Слепой индекс телефонов больше не перебрать по старому секрету, если тот утёк.",
    en: "The phone blind index can no longer be brute-forced with the old secret, if it leaked.",
  },
  "ops.sec.secrets.PHONE_INDEX_SECRET.risks": {
    uk: "До переіндексації перевірка «номер вже використовується» мовчки не спрацьовує — одна людина зможе завести другий обліковий запис. Одразу після перезапуску — переіндексувати.",
    ru: "До переиндексации проверка «номер уже используется» молча не срабатывает — один человек сможет завести вторую учётную запись. Сразу после перезапуска — переиндексировать.",
    en: "Until reindexing, the “number already in use” check silently fails — one person could create a second account. Reindex right after the restart.",
  },
  "ops.sec.secrets.EXPORT_SECRET.gives": {
    uk: "Нові вивантаження отримають нові коди суб’єктів.",
    ru: "Новые выгрузки получат новые коды субъектов.",
    en: "New exports get new subject codes.",
  },
  "ops.sec.secrets.EXPORT_SECRET.risks": {
    uk: "НЕ ротувати: коди суб’єктів і спостережень у вже виданих вивантаженнях стануть незрівнянними з новими — лонгітюд перестане склеюватися. Змінювати лише за доведеного витоку й свідомо.",
    ru: "НЕ ротировать: коды субъектов и наблюдений в уже выданных выгрузках станут несравнимы с новыми — лонгитюд перестанет склеиваться. Менять только при доказанной утечке и осознанно.",
    en: "DO NOT rotate: subject and case codes in exports already issued become incomparable with new ones — longitudinal linking breaks. Change only on a proven leak, deliberately.",
  },
  "ops.sec.secrets.METRICS_TOKEN.gives": {
    uk: "Старий токен збирача більше не відкриває /metrics.",
    ru: "Старый токен сборщика больше не открывает /metrics.",
    en: "The old collector token no longer opens /metrics.",
  },
  "ops.sec.secrets.METRICS_TOKEN.risks": {
    uk: "Збирач метрик треба перенастроїти разом із ротацією, інакше метрики й сповіщення за ними замовкнуть. Не задано — /metrics відповідає 404.",
    ru: "Сборщик метрик нужно перенастроить вместе с ротацией, иначе метрики и оповещения по ним замолчат. Не задан — /metrics отвечает 404.",
    en: "Reconfigure the metrics collector together with the rotation, or metrics and alerts on them go silent. Not set — /metrics answers 404.",
  },
  "ops.sec.phones.run": { uk: "Переіндексувати телефони", ru: "Переиндексировать телефоны", en: "Reindex phones" },
  "ops.sec.phones.done": {
    uk: "Переглянуто {total}, перераховано {updated}, знято {cleared}, не розшифровано {unreadable}, номер у двох облікових записів {conflicts}.",
    ru: "Просмотрено {total}, пересчитано {updated}, снято {cleared}, не расшифровано {unreadable}, номер у двух учётных записей {conflicts}.",
    en: "Checked {total}, recomputed {updated}, cleared {cleared}, not decrypted {unreadable}, number shared by two accounts {conflicts}.",
  },

  "ops.sec.int.lead": {
    uk: "Ті самі перевірки, що bun src/rlsReport.ts і bun run audit:verify, — з кнопкою й пам’яттю результатів.",
    ru: "Те же проверки, что bun src/rlsReport.ts и bun run audit:verify, — с кнопкой и памятью результатов.",
    en: "The same checks as bun src/rlsReport.ts and bun run audit:verify — with a button and remembered results.",
  },
  "ops.sec.int.rlsTitle": { uk: "Політики рядків (RLS)", ru: "Политики строк (RLS)", en: "Row-level security (RLS)" },
  "ops.sec.int.rlsRun": { uk: "Перевірити RLS", ru: "Проверить RLS", en: "Check RLS" },
  "ops.sec.int.never": { uk: "Ще не перевіряли.", ru: "Ещё не проверяли.", en: "Not checked yet." },
  "ops.sec.int.rlsOk": {
    uk: "Політики діють: роль «{role}» не обходить RLS, і кожна політика стоїть на увімкненому RLS.",
    ru: "Политики действуют: роль «{role}» не обходит RLS, и каждая политика стоит на включённом RLS.",
    en: "Policies are in force: role “{role}” does not bypass RLS, and every policy sits on enabled RLS.",
  },
  "ops.sec.int.rlsBypass": {
    uk: "Політики НЕ діють для ролі «{role}»: {reason}. Кожен бачить усе, хоча всі політики на місці.",
    ru: "Политики НЕ действуют для роли «{role}»: {reason}. Каждый видит всё, хотя все политики на месте.",
    en: "Policies are NOT in force for role “{role}”: {reason}. Everyone sees everything, although all policies are in place.",
  },
  "ops.sec.int.rlsBroken": {
    uk: "Є політики без увімкненого RLS — вони не діють.",
    ru: "Есть политики без включённого RLS — они не действуют.",
    en: "Some policies sit on tables without RLS enabled — they have no effect.",
  },
  "ops.sec.int.rlsCounts": {
    uk: "Таблиць: {tables}, з RLS: {rls}, політик: {policies}",
    ru: "Таблиц: {tables}, с RLS: {rls}, политик: {policies}",
    en: "Tables: {tables}, with RLS: {rls}, policies: {policies}",
  },
  "ops.sec.int.policiesWithoutRls": {
    uk: "Політики є, RLS вимкнено — політики не діють",
    ru: "Политики есть, RLS выключен — политики не действуют",
    en: "Policies present, RLS disabled — policies have no effect",
  },
  "ops.sec.int.rlsWithoutPolicies": {
    uk: "RLS увімкнено, політик немає — для ролі застосунку таблиця порожня",
    ru: "RLS включён, политик нет — для роли приложения таблица пуста",
    en: "RLS enabled, no policies — the table is empty for the app role",
  },
  "ops.sec.int.personTables": {
    uk: "Посилаються на людину й не закриті RLS — перевірте, чи це свідомо",
    ru: "Ссылаются на человека и не закрыты RLS — проверьте, осознанно ли это",
    en: "Reference a person and are not covered by RLS — check that this is deliberate",
  },
  "ops.sec.int.forced": { uk: "З FORCE ROW LEVEL SECURITY", ru: "С FORCE ROW LEVEL SECURITY", en: "With FORCE ROW LEVEL SECURITY" },
  "ops.sec.int.auditWritable": {
    uk: "Роль може змінювати журнал (UPDATE/DELETE на audit_log): третій пояс незмінності знято, лишився тригер.",
    ru: "Роль может менять журнал (UPDATE/DELETE на audit_log): третий пояс неизменности снят, остался триггер.",
    en: "The role can modify the audit log (UPDATE/DELETE on audit_log): the third immutability layer is gone, the trigger remains.",
  },
  "ops.sec.int.checkedBy": { uk: "Перевірено {time}, {who}", ru: "Проверено {time}, {who}", en: "Checked {time}, {who}" },
  "ops.sec.int.scheduler": { uk: "планувальник", ru: "планировщик", en: "scheduler" },
  "ops.sec.int.auditTitle": { uk: "Журнал доступу", ru: "Журнал доступа", en: "Access log" },
  "ops.sec.int.auditRun": { uk: "Перевірити журнал", ru: "Проверить журнал", en: "Check the log" },
  "ops.sec.int.auditOk": {
    uk: "Ланцюжок цілий: {n} записів, головний хеш {hash}… (seq {seq}).",
    ru: "Цепочка цела: {n} записей, головной хэш {hash}… (seq {seq}).",
    en: "The chain is intact: {n} entries, head hash {hash}… (seq {seq}).",
  },
  "ops.sec.int.auditLegacy": {
    uk: "Записів до впровадження ланцюжка (без хешів): {n}.",
    ru: "Записей до внедрения цепочки (без хэшей): {n}.",
    en: "Entries from before the chain (no hashes): {n}.",
  },
  "ops.sec.int.auditBroken": {
    uk: "Розрив на записі seq {seq}: цілих до розриву — {n}. Записано в журнал і в лог як sec.audit_chain_broken.",
    ru: "Разрыв на записи seq {seq}: целых до разрыва — {n}. Записано в журнал и в лог как sec.audit_chain_broken.",
    en: "Break at entry seq {seq}: {n} intact before it. Logged to the journal and the process log as sec.audit_chain_broken.",
  },
  "ops.sec.int.schedule": {
    uk: "Автоматично — раз на добу, у планувальнику.",
    ru: "Автоматически — раз в сутки, в планировщике.",
    en: "Automatically — once a day, in the scheduler.",
  },
  "ops.sec.int.lastScheduled": { uk: "Остання автоматична: {time} — {verdict}.", ru: "Последняя автоматическая: {time} — {verdict}.", en: "Last automatic: {time} — {verdict}." },
  "ops.sec.int.noScheduled": {
    uk: "Автоматичної перевірки ще не було: планувальник працює лише там, де SCHEDULER_ENABLED.",
    ru: "Автоматической проверки ещё не было: планировщик работает только там, где SCHEDULER_ENABLED.",
    en: "No automatic check yet: the scheduler runs only where SCHEDULER_ENABLED is on.",
  },
  "ops.sec.int.nextAfter": { uk: "Наступна — не раніше {time}.", ru: "Следующая — не раньше {time}.", en: "Next — not before {time}." },
  "ops.sec.int.intact": { uk: "цілий", ru: "цела", en: "intact" },
  "ops.sec.int.broken": { uk: "розрив", ru: "разрыв", en: "broken" },

  "ops.sec.sql.role": {
    uk: "Запит іде від ролі бази «{role}» у транзакції READ ONLY, яка завжди відкочується. Політики рядків — з вашим контекстом суперадміна: видно те саме, що вам у консолі (записи прийому бачать лише двоє учасників, тож їхніх рядків не видно).",
    ru: "Запрос идёт от роли базы «{role}» в транзакции READ ONLY, которая всегда откатывается. Политики строк — с вашим контекстом суперадмина: видно то же, что вам в консоли (записи приёма видят только двое участников, поэтому их строк не видно).",
    en: "The query runs as database role “{role}” in a READ ONLY transaction that is always rolled back. Row policies apply with your superadmin context: you see what the console shows you (visit recordings are visible only to their two participants, so their rows are hidden).",
  },
  "ops.sec.sql.bypass": {
    uk: "Увага: роль «{role}» обходить політики рядків ({reason}) — видно всі рядки всіх таблиць.",
    ru: "Внимание: роль «{role}» обходит политики строк ({reason}) — видны все строки всех таблиц.",
    en: "Attention: role “{role}” bypasses row policies ({reason}) — all rows of all tables are visible.",
  },
  "ops.sec.sql.encrypted": {
    uk: "Зашифровані поля (ПІБ, дата народження, телефон, тексти) лишаються шифротекстом — так і має бути. Хеш пароля й refresh-токена приховано.",
    ru: "Зашифрованные поля (ФИО, дата рождения, телефон, тексты) остаются шифртекстом — так и должно быть. Хэш пароля и refresh-токена скрыт.",
    en: "Encrypted fields (names, date of birth, phone, texts) stay ciphertext — as they should. Password and refresh-token hashes are hidden.",
  },
  "ops.sec.sql.limits": {
    uk: "Один оператор, до {rows} рядків, до {sec} с. Кожен запит іде в журнал: хто, причина, текст, скільки рядків.",
    ru: "Один оператор, до {rows} строк, до {sec} с. Каждый запрос идёт в журнал: кто, причина, текст, сколько строк.",
    en: "One statement, up to {rows} rows, up to {sec} s. Every query goes to the log: who, reason, text, row count.",
  },
  "ops.sec.sql.reason": { uk: "Причина", ru: "Причина", en: "Reason" },
  "ops.sec.sql.reasonHint": {
    uk: "Навіщо цей запит — піде в журнал разом із текстом",
    ru: "Зачем этот запрос — уйдёт в журнал вместе с текстом",
    en: "Why this query — goes to the log with its text",
  },
  "ops.sec.sql.query": { uk: "Запит", ru: "Запрос", en: "Query" },
  "ops.sec.sql.run": { uk: "Виконати", ru: "Выполнить", en: "Run" },
  "ops.sec.sql.hotkey": { uk: "Ctrl+Enter — виконати", ru: "Ctrl+Enter — выполнить", en: "Ctrl+Enter — run" },
  "ops.sec.sql.multipleHint": {
    uk: "Схоже на кілька операторів — сервер такий запит відхилить.",
    ru: "Похоже на несколько операторов — сервер такой запрос отклонит.",
    en: "Looks like several statements — the server will reject it.",
  },
  "ops.sec.sql.reasonNeeded": {
    uk: "Без причини запит не виконується.",
    ru: "Без причины запрос не выполняется.",
    en: "A query does not run without a reason.",
  },
  "ops.sec.sql.meta": { uk: "{n} рядків · {ms} мс", ru: "{n} строк · {ms} мс", en: "{n} rows · {ms} ms" },
  "ops.sec.sql.truncated": { uk: "обрізано до {n}", ru: "обрезано до {n}", en: "cut to {n}" },
  "ops.sec.sql.masked": { uk: "приховано", ru: "скрыто", en: "hidden" },
  "ops.sec.sql.copyCsv": { uk: "Копіювати CSV", ru: "Копировать CSV", en: "Copy CSV" },
  "ops.sec.sql.copied": { uk: "Скопійовано", ru: "Скопировано", en: "Copied" },
  "ops.sec.sql.empty": { uk: "Запит нічого не повернув.", ru: "Запрос ничего не вернул.", en: "The query returned nothing." },
  "ops.sec.sql.error": { uk: "База відхилила запит", ru: "База отклонила запрос", en: "The database rejected the query" },
  "ops.sec.sql.refused": { uk: "Не виконано", ru: "Не выполнено", en: "Not run" },
  "ops.sec.sql.refuse.empty": { uk: "запит порожній", ru: "запрос пуст", en: "the query is empty" },
  "ops.sec.sql.refuse.tooLong": {
    uk: "запит задовгий (понад {detail} знаків)",
    ru: "запрос слишком длинный (больше {detail} знаков)",
    en: "the query is too long (over {detail} characters)",
  },
  "ops.sec.sql.refuse.multiple": {
    uk: "кілька операторів в одному запиті",
    ru: "несколько операторов в одном запросе",
    en: "several statements in one query",
  },
  "ops.sec.sql.refuse.notRead": {
    uk: "дозволено лише читання: SELECT, WITH, VALUES, TABLE, EXPLAIN, SHOW",
    ru: "разрешено только чтение: SELECT, WITH, VALUES, TABLE, EXPLAIN, SHOW",
    en: "only reading is allowed: SELECT, WITH, VALUES, TABLE, EXPLAIN, SHOW",
  },
  "ops.sec.sql.refuse.write": {
    uk: "у запиті є «{detail}» — це не читання",
    ru: "в запросе есть «{detail}» — это не чтение",
    en: "the query contains “{detail}” — that is not reading",
  },
  "ops.sec.sql.refuse.rowLock": {
    uk: "блокування рядків (FOR UPDATE / FOR SHARE) не для консолі читання",
    ru: "блокировка строк (FOR UPDATE / FOR SHARE) не для консоли чтения",
    en: "row locks (FOR UPDATE / FOR SHARE) are not for a read-only console",
  },
  "ops.sec.sql.refuse.sideEffect": {
    uk: "функція {detail}() має побічний ефект",
    ru: "функция {detail}() имеет побочный эффект",
    en: "function {detail}() has a side effect",
  },
  "ops.sec.sql.refuse.placeholder": {
    uk: "параметри $1… консоль не передає — підставте значення",
    ru: "параметры $1… консоль не передаёт — подставьте значения",
    en: "the console passes no $1… parameters — put the values in",
  },
  "ops.sec.sql.history": { uk: "Мої запити за сесію", ru: "Мои запросы за сессию", en: "My queries this session" },
  "ops.sec.sql.historyEmpty": { uk: "Ще нічого.", ru: "Пока ничего.", en: "Nothing yet." },
  "ops.sec.sql.historyUse": { uk: "Повернути в поле", ru: "Вернуть в поле", en: "Put back" },
  "ops.sec.sql.historyRows": { uk: "{n} рядків", ru: "{n} строк", en: "{n} rows" },
  "ops.sec.sql.historyRefused": { uk: "відхилено", ru: "отклонено", en: "refused" },
  "ops.sec.sql.historyError": { uk: "помилка", ru: "ошибка", en: "error" },

  /* ── wave10:obs2 ── */
  /* ── obs2a: история логов и ошибок, трасса запроса, сравнение выкаток, медленный SQL ── */
  /*
   * Вторая половина техпанели (pages/ops/obs2a, вкладки «Логи» и «Помилки»
   * в режиме истории). Коды сервера (сдвиг выкатки, состояние
   * pg_stat_statements, исход записи журнала) переводятся здесь.
   */
  "ops.tab.releaseCompare": { uk: "Порівняння випусків", ru: "Сравнение выпусков", en: "Release comparison" },
  "ops.tab.statements": { uk: "Повільні SQL", ru: "Медленные SQL", en: "Slow SQL" },
  "ops.job.flush": { uk: "Запис історії техпанелі", ru: "Запись истории техпанели", en: "Tech panel history writer" },
  "ops.job.rotate": { uk: "Очищення історії техпанелі", ru: "Очистка истории техпанели", en: "Tech panel history rotation" },

  "ops.period.1h": { uk: "Година", ru: "Час", en: "1 hour" },
  "ops.period.24h": { uk: "Доба", ru: "Сутки", en: "24 hours" },
  "ops.period.7d": { uk: "7 днів", ru: "7 дней", en: "7 days" },
  "ops.period.14d": { uk: "14 днів", ru: "14 дней", en: "14 days" },
  "ops.period.30d": { uk: "30 днів", ru: "30 дней", en: "30 days" },
  "ops.period.90d": { uk: "90 днів", ru: "90 дней", en: "90 days" },

  "ops.history.periodLabel": { uk: "Період", ru: "Период", en: "Period" },
  "ops.history.period": { uk: "Період — {period}, з {time}.", ru: "Период — {period}, с {time}.", en: "Period: {period}, since {time}." },
  "ops.history.keep": {
    uk: "Історія зберігається {n} днів і переживає перезапуск.",
    ru: "История хранится {n} дней и переживает перезапуск.",
    en: "History is kept for {n} days and survives restarts.",
  },
  "ops.history.failing": {
    uk: "Запис історії в базу не вдається з {time}: у черзі {n} рядків",
    ru: "Запись истории в базу не удаётся с {time}: в очереди {n} строк",
    en: "Writing history to the database has been failing since {time}: {n} lines queued",
  },
  "ops.history.dropped": {
    uk: "Не збережено рядків: {n} — база була недоступна довше, ніж тримає черга",
    ru: "Не сохранено строк: {n} — база была недоступна дольше, чем держит очередь",
    en: "{n} lines not saved — the database was down longer than the queue holds",
  },
  "ops.history.off": {
    uk: "Цей процес історію не пише — видно записане іншими й пам’ять процесу.",
    ru: "Этот процесс историю не пишет — видно записанное другими и память процесса.",
    en: "This process does not write history — showing what others saved and process memory.",
  },
  "ops.history.unavailable": {
    uk: "Історія з бази не прочиталася — показано лише пам’ять процесу",
    ru: "История из базы не прочиталась — показана только память процесса",
    en: "Could not read history from the database — showing process memory only",
  },
  "ops.history.older": { uk: "Старіші", ru: "Более старые", en: "Older" },
  "ops.history.shown": { uk: "показано рядків: {n}", ru: "показано строк: {n}", en: "{n} lines shown" },
  "ops.history.capped": {
    uk: "На екрані вже {n} рядків — звузьте період чи фільтр, щоб бачити старіші.",
    ru: "На экране уже {n} строк — сузьте период или фильтр, чтобы видеть более старые.",
    en: "{n} lines are already shown — narrow the period or filter to see older ones.",
  },
  "ops.history.errorsEmpty": { uk: "За цей період помилок немає", ru: "За этот период ошибок нет", en: "No errors in this period" },
  "ops.history.new": { uk: "нова", ru: "новая", en: "new" },
  "ops.history.lastOn": { uk: "востаннє {time}", ru: "последний раз {time}", en: "last {time}" },
  "ops.history.total": { uk: "усього {n}", ru: "всего {n}", en: "{n} in total" },

  "ops.trace.open": { uk: "Траса запиту", ru: "Трасса запроса", en: "Request trace" },
  "ops.trace.search": { uk: "Номер запиту — до траси", ru: "Номер запроса — к трассе", en: "Request ID → trace" },
  "ops.trace.go": { uk: "Відкрити", ru: "Открыть", en: "Open" },
  "ops.trace.badId": {
    uk: "Такого номера не буває: 4–64 знаки — літери, цифри та «._:-»",
    ru: "Такого номера не бывает: 4–64 знака — буквы, цифры и «._:-»",
    en: "Not a valid request ID: 4–64 characters — letters, digits and “._:-”",
  },
  "ops.trace.lead": {
    uk: "Усе про один запит — рядки лога, помилка, журнал і SQL:",
    ru: "Всё об одном запросе — строки лога, ошибка, журнал и SQL:",
    en: "Everything about one request — log lines, error, audit and SQL:",
  },
  "ops.trace.ambiguous": { uk: "Номер неоднозначний", ru: "Номер неоднозначен", en: "Ambiguous request ID" },
  "ops.trace.ambiguousHint": {
    uk: "З такого початку починається кілька запитів — виберіть потрібний.",
    ru: "С такого начала начинается несколько запросов — выберите нужный.",
    en: "Several requests start with this prefix — pick one.",
  },
  "ops.trace.notFound": { uk: "Про цей запит нічого не знайдено", ru: "Об этом запросе ничего не найдено", en: "Nothing found for this request" },
  "ops.trace.notFoundHint": {
    uk: "Рядки лога зберігаються {n} днів і потрапляють у базу раз на 10 секунд. Запити самої техпанелі до стрічки не потрапляють.",
    ru: "Строки лога хранятся {n} дней и попадают в базу раз в 10 секунд. Запросы самой техпанели в ленту не попадают.",
    en: "Log lines are kept for {n} days and reach the database every 10 seconds. The tech panel’s own requests are not logged.",
  },
  "ops.trace.reload": { uk: "Оновити", ru: "Обновить", en: "Refresh" },
  "ops.trace.summary": { uk: "Підсумок", ru: "Итог", en: "Summary" },
  "ops.trace.duration": { uk: "Тривалість", ru: "Длительность", en: "Duration" },
  "ops.trace.sql": { uk: "SQL", ru: "SQL", en: "SQL" },
  "ops.trace.sqlSummary": { uk: "{n} запитів, {ms}", ru: "{n} запросов, {ms}", en: "{n} queries, {ms}" },
  "ops.trace.noSummary": {
    uk: "Рядка з підсумком запиту немає: запит ще триває, його рядок не дійшов або це не HTTP-запит.",
    ru: "Строки с итогом запроса нет: запрос ещё идёт, его строка не дошла или это не HTTP-запрос.",
    en: "No summary line: the request is still running, its line was lost, or this is not an HTTP request.",
  },
  "ops.trace.errors": { uk: "Помилка", ru: "Ошибка", en: "Error" },
  "ops.trace.lines": { uk: "Рядки лога", ru: "Строки лога", en: "Log lines" },
  "ops.trace.toGroup": { uk: "до групи помилок", ru: "к группе ошибок", en: "open error group" },
  "ops.trace.audit": { uk: "Журнал", ru: "Журнал", en: "Audit log" },
  "ops.trace.auditHint": {
    uk: "Записи журналу з цим номером запиту — дія, результат, вид ресурсу й роль. Людей тут немає: подробиці — у вкладці «Аудит» за правом audit.read.",
    ru: "Записи журнала с этим номером запроса — действие, исход, вид ресурса и роль. Людей здесь нет: подробности — во вкладке «Аудит» по праву audit.read.",
    en: "Audit entries with this request ID — action, outcome, resource type and role. No people here: details are in the Audit tab under audit.read.",
  },
  "ops.trace.auditFailed": { uk: "Журнал прочитати не вдалося", ru: "Журнал прочитать не удалось", en: "Could not read the audit log" },
  "ops.trace.auditEmpty": { uk: "Цей запит у журнал нічого не писав", ru: "Этот запрос в журнал ничего не писал", en: "This request wrote nothing to the audit log" },
  "ops.trace.action": { uk: "Дія", ru: "Действие", en: "Action" },
  "ops.trace.outcome": { uk: "Результат", ru: "Исход", en: "Outcome" },
  "ops.trace.resource": { uk: "Ресурс", ru: "Ресурс", en: "Resource" },
  "ops.trace.system": { uk: "система", ru: "система", en: "system" },
  "ops.trace.outcome.success": { uk: "успішно", ru: "успешно", en: "success" },
  "ops.trace.outcome.denied": { uk: "відмовлено", ru: "отказано", en: "denied" },
  "ops.trace.outcome.error": { uk: "збій", ru: "сбой", en: "error" },
  "ops.trace.sqlTitle": { uk: "SQL запиту", ru: "SQL запроса", en: "Request SQL" },
  "ops.trace.sqlMemory": {
    uk: "Тексти параметризовані, без значень; з пам’яті процесу — останні 2000 запитів.",
    ru: "Тексты параметризованные, без значений; из памяти процесса — последние 2000 запросов.",
    en: "Texts are parameterised, with no values; from process memory — the last 2,000 requests.",
  },
  "ops.trace.sqlStored": {
    uk: "Тексти параметризовані, без значень; збережено разом із рядком запиту, бо він був повільним, збійним чи важким.",
    ru: "Тексты параметризованные, без значений; сохранены вместе со строкой запроса, потому что он был медленным, упавшим или тяжёлым.",
    en: "Texts are parameterised, with no values; saved with the request line because it was slow, failed or heavy.",
  },
  "ops.trace.sqlTotals": {
    uk: "{n} запитів · {ms} · різних текстів {distinct}",
    ru: "{n} запросов · {ms} · разных текстов {distinct}",
    en: "{n} queries · {ms} · {distinct} distinct texts",
  },
  "ops.trace.sqlNone": {
    uk: "Розбивки SQL для цього запиту вже немає: тексти тримаються для останніх запитів процесу, а в історії — лише для повільних, збійних і важких. Число й час — у підсумку.",
    ru: "Разбивки SQL для этого запроса уже нет: тексты держатся для последних запросов процесса, а в истории — только для медленных, упавших и тяжёлых. Число и время — в итоге.",
    en: "No SQL breakdown for this request anymore: texts are kept for the process’s latest requests, and in history only for slow, failed and heavy ones. Count and time are in the summary.",
  },
  "ops.trace.calls": { uk: "Викликів", ru: "Вызовов", en: "Calls" },
  "ops.trace.totalMs": { uk: "Сумарно", ru: "Суммарно", en: "Total" },

  "ops.rel.lead": {
    uk: "Версія цього процесу — {current}. Суми запитів за версіями зберігаються {n} днів; викатка — це поява нової версії.",
    ru: "Версия этого процесса — {current}. Суммы запросов по версиям хранятся {n} дней; выкатка — это появление новой версии.",
    en: "This process runs {current}. Request totals per version are kept for {n} days; a release is when a new version appears.",
  },
  "ops.rel.title": { uk: "Година до й година після", ru: "Час до и час после", en: "An hour before and after" },
  "ops.rel.thresholds": {
    uk: "Помітно — це p95 змінився щонайменше на {ratio} і на {ms}, частка 5xx — на {pp} в. п. і щонайменше {errors} помилки. Менше {min} запитів із будь-якого боку — «замало запитів», без відсотків.",
    ru: "Заметно — это p95 изменился минимум на {ratio} и на {ms}, доля 5xx — на {pp} п. п. и минимум {errors} ошибки. Меньше {min} запросов с любой стороны — «мало запросов», без процентов.",
    en: "Noticeable means p95 moved by at least {ratio} and {ms}, and the 5xx share by {pp} pp with at least {errors} errors. Fewer than {min} requests on either side — “too few requests”, no percentages.",
  },
  "ops.rel.none": {
    uk: "Сум запитів ще немає: вони пишуться в базу раз на 10 секунд.",
    ru: "Сумм запросов ещё нет: они пишутся в базу раз в 10 секунд.",
    en: "No request totals yet: they are written every 10 seconds.",
  },
  "ops.rel.single": {
    uk: "Поки є лише одна версія — {version}. Порівняння з’явиться після наступної викатки; версію задає змінна QUIZZY_VERSION.",
    ru: "Пока есть только одна версия — {version}. Сравнение появится после следующей выкатки; версию задаёт переменная QUIZZY_VERSION.",
    en: "Only one version so far — {version}. A comparison appears after the next release; the version comes from QUIZZY_VERSION.",
  },
  "ops.rel.before": { uk: "Було", ru: "Было", en: "Before" },
  "ops.rel.after": { uk: "Стало", ru: "Стало", en: "After" },
  "ops.rel.onlyWorse": { uk: "Лише погіршення", ru: "Только ухудшения", en: "Regressions only" },
  "ops.rel.window": {
    uk: "{version}: з {from} до {to}, запитів {n}",
    ru: "{version}: с {from} до {to}, запросов {n}",
    en: "{version}: {from} to {to}, {n} requests",
  },
  "ops.rel.hourly": {
    uk: "Хвилинні суми цих версій вже видалено — вікна взято за годинними кошиками, межа викатки розмита до години",
    ru: "Минутные суммы этих версий уже удалены — окна взяты по часовым корзинам, граница выкатки размыта до часа",
    en: "Per-minute totals for these versions are gone — windows use hourly buckets, so the release boundary is blurred to an hour",
  },
  "ops.rel.noPair": { uk: "Виберіть дві різні версії", ru: "Выберите две разные версии", en: "Pick two different versions" },
  "ops.rel.empty": { uk: "У цих вікнах запитів немає", ru: "В этих окнах запросов нет", en: "No requests in these windows" },
  "ops.rel.noWorse": { uk: "Помітних погіршень немає", ru: "Заметных ухудшений нет", en: "No noticeable regressions" },
  "ops.rel.requests": { uk: "Запитів", ru: "Запросов", en: "Requests" },
  "ops.rel.p95Before": { uk: "p95 було", ru: "p95 было", en: "p95 before" },
  "ops.rel.p95After": { uk: "p95 стало", ru: "p95 стало", en: "p95 after" },
  "ops.rel.p95Shift": { uk: "Час відповіді", ru: "Время ответа", en: "Latency" },
  "ops.rel.errBefore": { uk: "5xx було", ru: "5xx было", en: "5xx before" },
  "ops.rel.errAfter": { uk: "5xx стало", ru: "5xx стало", en: "5xx after" },
  "ops.rel.errShift": { uk: "Помилки", ru: "Ошибки", en: "Errors" },
  "ops.rel.gone": { uk: "після викатки запитів не було", ru: "после выкатки запросов не было", en: "no requests after the release" },
  "ops.rel.new": { uk: "до викатки запитів не було", ru: "до выкатки запросов не было", en: "no requests before the release" },
  "ops.rel.pp": { uk: "{n} в. п.", ru: "{n} п. п.", en: "{n} pp" },
  "ops.rel.worse": { uk: "гірше", ru: "хуже", en: "worse" },
  "ops.rel.better": { uk: "краще", ru: "лучше", en: "better" },
  "ops.rel.same": { uk: "без змін", ru: "без изменений", en: "no change" },
  "ops.rel.few": { uk: "замало запитів", ru: "мало запросов", en: "too few requests" },

  "ops.sql.title": { uk: "Найдорожчі запити", ru: "Самые дорогие запросы", en: "Most expensive queries" },
  "ops.sql.hint": {
    uk: "Статистика pg_stat_statements своєї бази: тексти нормалізовані, значень у них немає. План — EXPLAIN без ANALYZE: запит не виконується.",
    ru: "Статистика pg_stat_statements своей базы: тексты нормализованы, значений в них нет. План — EXPLAIN без ANALYZE: запрос не выполняется.",
    en: "pg_stat_statements for this database: texts are normalised, with no values. Plans use EXPLAIN without ANALYZE — the query is not run.",
  },
  "ops.sql.since": { uk: "Статистика накопичується з {time}", ru: "Статистика копится с {time}", en: "Statistics accumulated since {time}" },
  "ops.sql.sinceUnknown": {
    uk: "Статистика накопичується з останнього скидання чи перезапуску бази",
    ru: "Статистика копится с последнего сброса или перезапуска базы",
    en: "Statistics accumulate since the last reset or database restart",
  },
  "ops.sql.sortLabel": { uk: "Порядок", ru: "Порядок", en: "Order" },
  "ops.sql.byTotal": { uk: "Сумарний час", ru: "Суммарное время", en: "Total time" },
  "ops.sql.byCalls": { uk: "Викликів", ru: "Вызовов", en: "Calls" },
  "ops.sql.byMean": { uk: "Середній час", ru: "Среднее время", en: "Mean time" },
  "ops.sql.empty": { uk: "Статистика порожня — запитів ще не було", ru: "Статистика пуста — запросов ещё не было", en: "No statistics yet" },
  "ops.sql.hidden": {
    uk: "Ще запитів інших ролей без тексту: {n}. Роль застосунку бачить тексти лише своїх; щоб бачити всі —",
    ru: "Ещё запросов других ролей без текста: {n}. Роль приложения видит тексты только своих; чтобы видеть все —",
    en: "{n} more queries from other roles without text. The app role sees only its own texts; to see all —",
  },
  "ops.sql.notEnabled": { uk: "не ввімкнено", ru: "не включено", en: "not enabled" },
  "ops.sql.state.notInstalled": {
    uk: "Розширення pg_stat_statements у базі не створено.",
    ru: "Расширение pg_stat_statements в базе не создано.",
    en: "The pg_stat_statements extension is not created in this database.",
  },
  "ops.sql.state.notLoaded": {
    uk: "Розширення створено, але сервер бази запущено без shared_preload_libraries — статистика не збирається.",
    ru: "Расширение создано, но сервер базы запущен без shared_preload_libraries — статистика не собирается.",
    en: "The extension exists, but the database server was started without shared_preload_libraries — nothing is collected.",
  },
  "ops.sql.state.denied": {
    uk: "Роль застосунку не має права читати pg_stat_statements.",
    ru: "У роли приложения нет права читать pg_stat_statements.",
    en: "The app role may not read pg_stat_statements.",
  },
  "ops.sql.state.failed": {
    uk: "Статистику прочитати не вдалося — подробиці в стрічці логів (ops.statements_failed).",
    ru: "Статистику прочитать не удалось — подробности в ленте логов (ops.statements_failed).",
    en: "Could not read the statistics — see the log feed (ops.statements_failed).",
  },
  "ops.sql.step.preload": {
    uk: "Завантажити розширення під час запуску сервера бази — у docker-compose.yml, служба postgres:",
    ru: "Загрузить расширение при запуске сервера базы — в docker-compose.yml, служба postgres:",
    en: "Load the extension when the database server starts — in docker-compose.yml, postgres service:",
  },
  "ops.sql.step.restart": {
    uk: "Зміна command перезапускає контейнер бази: кілька секунд застосунок без бази. Робіть у тиху годину (docs/RUNBOOK.md, «Техпанель»).",
    ru: "Смена command перезапускает контейнер базы: несколько секунд приложение без базы. Делайте в тихий час (docs/RUNBOOK.md, «Техпанель»).",
    en: "Changing command restarts the database container: a few seconds without a database. Do it in a quiet hour (docs/RUNBOOK.md, tech panel section).",
  },
  "ops.sql.step.create": {
    uk: "Створити розширення власником бази (міграція 0093 робить це сама, якщо може):",
    ru: "Создать расширение владельцем базы (миграция 0093 делает это сама, если может):",
    en: "Create the extension as the database owner (migration 0093 does it when it can):",
  },
  "ops.sql.step.grant": {
    uk: "Дати ролі застосунку право читати статистику:",
    ru: "Дать роли приложения право читать статистику:",
    en: "Let the app role read the statistics:",
  },
  "ops.sql.total": { uk: "сумарно {v}", ru: "суммарно {v}", en: "total {v}" },
  "ops.sql.calls": { uk: "викликів {v}", ru: "вызовов {v}", en: "{v} calls" },
  "ops.sql.mean": { uk: "у середньому {v}", ru: "в среднем {v}", en: "mean {v}" },
  "ops.sql.rows": { uk: "рядків {v}", ru: "строк {v}", en: "{v} rows" },
  "ops.sql.share": { uk: "{v} часу бази", ru: "{v} времени базы", en: "{v} of database time" },
  "ops.sql.showPlan": { uk: "План", ru: "План", en: "Plan" },
  "ops.sql.hidePlan": { uk: "Сховати план", ru: "Скрыть план", en: "Hide plan" },
  "ops.sql.plan.generic": {
    uk: "Загальний план без значень параметрів (EXPLAIN GENERIC_PLAN) — оцінки можуть відрізнятися від конкретного виклику.",
    ru: "Общий план без значений параметров (EXPLAIN GENERIC_PLAN) — оценки могут отличаться от конкретного вызова.",
    en: "Generic plan without parameter values (EXPLAIN GENERIC_PLAN) — estimates may differ from a specific call.",
  },
  "ops.sql.plan.plain": {
    uk: "План без виконання (EXPLAIN без ANALYZE)",
    ru: "План без выполнения (EXPLAIN без ANALYZE)",
    en: "Plan without running the query (EXPLAIN without ANALYZE)",
  },
  "ops.sql.plan.notFound": {
    uk: "Цього запиту в статистиці вже немає — її скинули чи він витіснився",
    ru: "Этого запроса в статистике уже нет — её сбросили или он вытеснен",
    en: "This query is no longer in the statistics — reset or evicted",
  },
  "ops.sql.plan.refused": {
    uk: "Цей текст не пояснюємо: це не один SELECT, INSERT, UPDATE чи DELETE",
    ru: "Этот текст не объясняем: это не один SELECT, INSERT, UPDATE или DELETE",
    en: "Not explained: this is not a single SELECT, INSERT, UPDATE or DELETE",
  },
  "ops.sql.plan.needsPg16": {
    uk: "У тексті є параметри $1, а план без їхніх значень уміє лише PostgreSQL 16+",
    ru: "В тексте есть параметры $1, а план без их значений умеет только PostgreSQL 16+",
    en: "The text has $1 parameters; planning without values needs PostgreSQL 16+",
  },
  "ops.sql.plan.denied": {
    uk: "Роль застосунку не має прав на таблиці цього запиту",
    ru: "У роли приложения нет прав на таблицы этого запроса",
    en: "The app role has no rights on this query’s tables",
  },
  "ops.sql.plan.failed": {
    uk: "План отримати не вдалося — подробиці в стрічці логів (ops.explain_failed)",
    ru: "План получить не удалось — подробности в ленте логов (ops.explain_failed)",
    en: "Could not get the plan — see the log feed (ops.explain_failed)",
  },
  "ops.sql.plan.unavailable": {
    uk: "Статистика недоступна — плану немає з чого взяти",
    ru: "Статистика недоступна — плану не из чего взяться",
    en: "Statistics unavailable — nothing to explain",
  },

  /*
   * obs2b — техпанель: сигналы и клиент (Сповіщення, Помилки клієнта,
   * Швидкість екранів, Записи прийомів, «Запустити зараз»). Блок отдельно
   * от obs2a, начинается пустой строкой и этим комментарием.
   *
   * Тексты самих оповещений (Telegram, почта) — не здесь, а в словаре
   * уведомлений (pushStrings.ts, push.ops.*): их собирает сервер без
   * запроса, и консоль их не зовёт.
   *
   * «Відправити», а не «надіслати», — и в «Відправити тестове» тоже, хотя
   * заказчик написал «Надіслати тестове»: словарь держит одну форму слова
   * (uiStrings.test.ts, «отправить»), и форма эта задана кадром f26 — см.
   * пояснение у блока mail.*.
   */

  /* разделы техпанели */
  "o2b.tab.alerts": { uk: "Сповіщення", ru: "Оповещения", en: "Alerts" },
  "o2b.tab.recordings": { uk: "Записи прийомів", ru: "Записи приёмов", en: "Appointment recordings" },
  "o2b.tab.clientErrors": { uk: "Помилки клієнта", ru: "Ошибки клиента", en: "Client errors" },
  "o2b.tab.vitals": { uk: "Швидкість екранів", ru: "Скорость экранов", en: "Screen speed" },

  /* граница ошибок: консоль и кабинет пациента */
  "o2b.crash.title": { uk: "Щось пішло не так", ru: "Что-то пошло не так", en: "Something went wrong" },
  "o2b.crash.text": {
    uk: "Цей екран не вдалося показати. Помилку записано — без ваших даних. Спробуйте ще раз або оновіть сторінку.",
    ru: "Этот экран не удалось показать. Ошибка записана — без ваших данных. Попробуйте ещё раз или обновите страницу.",
    en: "This screen couldn’t be shown. The error has been logged — without your data. Try again or reload the page.",
  },
  "o2b.crash.retry": { uk: "Спробувати ще раз", ru: "Попробовать ещё раз", en: "Try again" },
  "o2b.crash.reload": { uk: "Оновити сторінку", ru: "Обновить страницу", en: "Reload the page" },

  /* Сповіщення */
  "o2b.alerts.stamp": {
    uk: "Правила та історія зберігаються в базі й переживають перезапуск.",
    ru: "Правила и история хранятся в базе и переживают перезапуск.",
    en: "Rules and history are stored in the database and survive restarts.",
  },
  "o2b.alerts.rules": { uk: "Правила", ru: "Правила", en: "Rules" },
  "o2b.alerts.rulesHint": {
    uk: "Одне сповіщення на інцидент, повтор — не частіше за вказаний інтервал, «відновлено» — коли сигнал зник.",
    ru: "Одно оповещение на инцидент, повтор — не чаще указанного интервала, «восстановлено» — когда сигнал ушёл.",
    en: "One alert per incident, repeats no more often than the set interval, and “recovered” once the signal clears.",
  },
  "o2b.alerts.checker": {
    uk: "Правила перевіряються кожні {every} на цьому екземплярі; остання перевірка — {last}.",
    ru: "Правила проверяются каждые {every} на этом экземпляре; последняя проверка — {last}.",
    en: "Rules are checked every {every} on this instance; last check {last}.",
  },
  "o2b.alerts.checkerOff": {
    uk: "На цьому екземплярі перевірку вимкнено (SCHEDULER_ENABLED=0) — вона йде там, де працює планувальник.",
    ru: "На этом экземпляре проверка выключена (SCHEDULER_ENABLED=0) — она идёт там, где работает планировщик.",
    en: "Checks are off on this instance (SCHEDULER_ENABLED=0) — they run where the scheduler runs.",
  },
  "o2b.alerts.diskNote": {
    uk: "Місце на диску — на томі каталогу записів (RECORDINGS_DIR): це диск контейнера або тому, а не всієї машини. Місця бази звідси не видно.",
    ru: "Место на диске — на томе каталога записей (RECORDINGS_DIR): это диск контейнера или тома, а не всей машины. Места базы отсюда не видно.",
    en: "Disk space is measured on the recordings directory volume (RECORDINGS_DIR): the container or volume disk, not the whole machine. The database’s disk isn’t visible from here.",
  },
  "o2b.alerts.channels": { uk: "Канали", ru: "Каналы", en: "Channels" },
  "o2b.alerts.channelsHint": {
    uk: "Токен бота, чат і сервер пошти задаються лише змінними оточення. Тут видно одне: чи їх задано.",
    ru: "Токен бота, чат и почтовый сервер задаются только переменными окружения. Здесь видно лишь, заданы ли они.",
    en: "The bot token, chat and mail server are set only through environment variables. This page shows only whether they are set.",
  },
  "o2b.alerts.history": { uk: "Історія", ru: "История", en: "History" },
  "o2b.alerts.historyHint": {
    uk: "Останні 100 подій; зберігаються 90 днів. Для кожного каналу — чи пішло.",
    ru: "Последние 100 событий; хранятся 90 дней. Для каждого канала — ушло ли.",
    en: "The latest 100 events, kept for 90 days, with the outcome for each channel.",
  },
  "o2b.alerts.historyEmpty": { uk: "Сповіщень ще не було", ru: "Оповещений ещё не было", en: "No alerts yet" },
  "o2b.col.rule": { uk: "Правило", ru: "Правило", en: "Rule" },
  "o2b.col.event": { uk: "Подія", ru: "Событие", en: "Event" },
  "o2b.col.value": { uk: "Значення / поріг", ru: "Значение / порог", en: "Value / threshold" },
  "o2b.col.deliveries": { uk: "Канали", ru: "Каналы", en: "Channels" },

  "o2b.rule.errors5xx": { uk: "Сплеск помилок 5xx", ru: "Всплеск ошибок 5xx", en: "5xx error spike" },
  "o2b.rule.errors5xx.hint": {
    uk: "Частка відповідей 5xx за вікно; менше ніж 20 запитів у вікні — тиша, а не сигнал.",
    ru: "Доля ответов 5xx за окно; меньше 20 запросов в окне — тишина, а не сигнал.",
    en: "Share of 5xx responses over the window; fewer than 20 requests is quiet, not a signal.",
  },
  "o2b.rule.schedulerSilent": { uk: "Планувальник мовчить", ru: "Планировщик молчит", en: "Scheduler silent" },
  "o2b.rule.schedulerSilent.hint": {
    uk: "Скільки хвилин від останнього такту розкладів.",
    ru: "Сколько минут с последнего такта расписаний.",
    en: "Minutes since the last schedule tick.",
  },
  "o2b.rule.p95": { uk: "Зростає p95 відповіді", ru: "Растёт p95 ответа", en: "Response p95 rising" },
  "o2b.rule.p95.hint": {
    uk: "p95 часу відповіді за вікно; менше ніж 20 запитів — тиша.",
    ru: "p95 времени ответа за окно; меньше 20 запросов — тишина.",
    en: "Response time p95 over the window; fewer than 20 requests is quiet.",
  },
  "o2b.rule.diskFree": { uk: "Закінчується місце на диску", ru: "Кончается место на диске", en: "Disk running out" },
  "o2b.rule.diskFree.hint": {
    uk: "Вільне місце на томі записів прийомів, у відсотках.",
    ru: "Свободное место на томе записей приёмов, в процентах.",
    en: "Free space on the recordings volume, as a percentage.",
  },
  "o2b.rule.auditChain": { uk: "Ланцюжок журналу порушено", ru: "Цепочка журнала нарушена", en: "Audit chain broken" },
  "o2b.rule.auditChain.hint": {
    uk: "Остання перевірка ланцюжка хешів журналу доступу не пройшла.",
    ru: "Последняя проверка цепочки хэшей журнала доступа не прошла.",
    en: "The latest hash-chain check of the access log failed.",
  },
  "o2b.rule.backup": { uk: "Бекап не пройшов", ru: "Бэкап не прошёл", en: "Backup failed" },
  "o2b.rule.backup.hint": {
    uk: "Бекап знімає cron на хості, а не застосунок.",
    ru: "Бэкап снимает cron на хосте, а не приложение.",
    en: "Backups are taken by cron on the host, not by the application.",
  },
  "o2b.rule.backup.where": {
    uk: "Застосунок не бачить каталогу бекапів. Дивіться вивід scripts/backup.sh і scripts/verify-backup.sh на хості (RUNBOOK, «Перевірка відновлюваності бекапу»): ненульовий код повернення має йти в систему сповіщень хоста.",
    ru: "Приложение не видит каталога бэкапов. Смотрите вывод scripts/backup.sh и scripts/verify-backup.sh на хосте (RUNBOOK, «Проверка восстановимости бэкапа»): ненулевой код возврата должен уходить в систему оповещений хоста.",
    en: "The application can’t see the backup directory. Check the output of scripts/backup.sh and scripts/verify-backup.sh on the host (RUNBOOK, “Backup restore check”): a non-zero exit code should go to the host’s alerting.",
  },
  "o2b.rule.since": { uk: "з {time}", ru: "с {time}", en: "since {time}" },
  "o2b.rule.checked": { uk: "перевірено {time}", ru: "проверено {time}", en: "checked {time}" },
  "o2b.rule.now": { uk: "зараз", ru: "сейчас", en: "now" },
  "o2b.rule.above": { uk: "сигнал, якщо більше", ru: "сигнал, если больше", en: "alert above" },
  "o2b.rule.below": { uk: "сигнал, якщо менше", ru: "сигнал, если меньше", en: "alert below" },
  "o2b.rule.window": { uk: "вікно {n} хв", ru: "окно {n} мин", en: "{n}-min window" },
  "o2b.rule.repeat": { uk: "повтор не частіше ніж раз на {t}", ru: "повтор не чаще раза в {t}", en: "repeat at most once per {t}" },
  "o2b.rule.noThreshold": { uk: "без порога: так чи ні", ru: "без порога: да или нет", en: "no threshold: pass or fail" },
  "o2b.rule.noChannels": { uk: "нікуди — лише в історію", ru: "никуда — только в историю", en: "nowhere — history only" },
  "o2b.rule.edit": { uk: "Змінити", ru: "Изменить", en: "Edit" },
  "o2b.rule.saved": { uk: "Правило збережено", ru: "Правило сохранено", en: "Rule saved" },

  "o2b.state.ok": { uk: "гаразд", ru: "в порядке", en: "ok" },
  "o2b.state.firing": { uk: "збій", ru: "сбой", en: "firing" },
  "o2b.state.unavailable": { uk: "недоступно", ru: "недоступно", en: "unavailable" },
  "o2b.state.off": { uk: "вимкнено", ru: "выключено", en: "off" },
  "o2b.state.unknown": { uk: "ще не перевірялося", ru: "ещё не проверялось", en: "not checked yet" },
  "o2b.state.notFromApp": { uk: "недоступно із застосунку", ru: "недоступно из приложения", en: "not visible to the app" },
  "o2b.unavail.schedulerOff": {
    uk: "планувальник на цьому екземплярі вимкнено",
    ru: "планировщик на этом экземпляре выключен",
    en: "the scheduler is off on this instance",
  },
  "o2b.unavail.diskUnknown": { uk: "місце на диску не прочиталося", ru: "место на диске не прочиталось", en: "disk space couldn’t be read" },
  "o2b.unavail.noSource": {
    uk: "джерело не підключено: результат перевірки ланцюжка ще не передається сповіщенням",
    ru: "источник не подключён: результат проверки цепочки ещё не передаётся оповещениям",
    en: "no source connected: the chain check result isn’t passed to alerts yet",
  },
  "o2b.unavail.neverChecked": { uk: "перевірки ланцюжка ще не було", ru: "проверки цепочки ещё не было", en: "the chain hasn’t been checked yet" },
  "o2b.unavail.noThreshold": { uk: "поріг не задано", ru: "порог не задан", en: "no threshold set" },

  "o2b.form.enabled": { uk: "Правило", ru: "Правило", en: "Rule" },
  "o2b.form.on": { uk: "Увімкнено", ru: "Включено", en: "On" },
  "o2b.form.off": { uk: "Вимкнено", ru: "Выключено", en: "Off" },
  "o2b.form.threshold": { uk: "Поріг", ru: "Порог", en: "Threshold" },
  "o2b.form.window": { uk: "Вікно", ru: "Окно", en: "Window" },
  "o2b.form.repeat": { uk: "Повтор не частіше", ru: "Повтор не чаще", en: "Repeat at most every" },
  "o2b.form.channels": { uk: "Куди відправляти", ru: "Куда отправлять", en: "Send to" },
  "o2b.form.range": { uk: "від {min} до {max}", ru: "от {min} до {max}", en: "from {min} to {max}" },
  "o2b.unit.pct": { uk: "%", ru: "%", en: "%" },
  "o2b.unit.ms": { uk: "мс", ru: "мс", en: "ms" },
  "o2b.unit.min": { uk: "хв", ru: "мин", en: "min" },

  "o2b.channel.telegram": { uk: "Telegram", ru: "Telegram", en: "Telegram" },
  "o2b.channel.email": { uk: "Пошта", ru: "Почта", en: "Email" },
  "o2b.channel.ready": { uk: "налаштовано", ru: "настроено", en: "configured" },
  "o2b.channel.notReady": { uk: "не налаштовано", ru: "не настроено", en: "not configured" },
  "o2b.channel.test": { uk: "Відправити тестове", ru: "Отправить тестовое", en: "Send a test" },
  "o2b.channel.toEnv": { uk: "одержувачі — OPS_ALERT_EMAIL, адрес: {n}", ru: "получатели — OPS_ALERT_EMAIL, адресов: {n}", en: "recipients — OPS_ALERT_EMAIL, addresses: {n}" },
  "o2b.channel.toSupers": { uk: "одержувачі — суперадміни: {n}", ru: "получатели — суперадмины: {n}", en: "recipients — super admins: {n}" },
  "o2b.channel.toNobody": { uk: "одержувачів немає", ru: "получателей нет", en: "no recipients" },
  "o2b.env.set": { uk: "задано", ru: "задано", en: "set" },
  "o2b.env.unset": { uk: "не задано", ru: "не задано", en: "not set" },
  "o2b.test.sent": { uk: "Тестове сповіщення відправлено", ru: "Тестовое оповещение отправлено", en: "Test alert sent" },
  "o2b.test.unset": { uk: "Канал не налаштовано — нічого не відправлено", ru: "Канал не настроен — ничего не отправлено", en: "The channel isn’t configured — nothing was sent" },
  "o2b.test.failed": { uk: "Канал відмовив: {error}", ru: "Канал отказал: {error}", en: "The channel refused: {error}" },

  "o2b.event.fired": { uk: "Збій", ru: "Сбой", en: "Failure" },
  "o2b.event.repeat": { uk: "Досі триває", ru: "Всё ещё идёт", en: "Still ongoing" },
  "o2b.event.resolved": { uk: "Відновлено", ru: "Восстановлено", en: "Recovered" },
  "o2b.event.test": { uk: "Тестове", ru: "Тестовое", en: "Test" },
  "o2b.event.anyRule": { uk: "Перевірка каналу", ru: "Проверка канала", en: "Channel check" },
  "o2b.delivery.sent": { uk: "відправлено", ru: "отправлено", en: "sent" },
  "o2b.delivery.failed": { uk: "відмова", ru: "отказ", en: "refused" },
  "o2b.delivery.unset": { uk: "не налаштовано", ru: "не настроено", en: "not configured" },

  /* Фонові задачі: ручной запуск */
  "o2b.jobs.runNow": { uk: "Запустити зараз", ru: "Запустить сейчас", en: "Run now" },
  "o2b.jobs.started": { uk: "Запущено — підсумок з’явиться в рядку задачі", ru: "Запущено — итог появится в строке задачи", en: "Started — the outcome will appear in the job’s row" },
  "o2b.jobs.byHand": { uk: "запущено вручну", ru: "запущено вручную", en: "run by hand" },
  "o2b.jobs.manualHint": {
    uk: "«Запустити зараз» — лише в задач, які безпечно запускати поза тактом: вони не видають людям ні завдань, ні сповіщень. Запуск іде фоном, один прохід за раз; хто й що запустив — у журналі.",
    ru: "«Запустить сейчас» — только у задач, которые безопасно запускать вне такта: они не выдают людям ни заданий, ни уведомлений. Запуск идёт фоном, один проход за раз; кто и что запустил — в журнале.",
    en: "“Run now” is offered only for jobs that are safe to run out of turn: they send people no tasks or notifications. Runs go in the background, one at a time; who ran what is in the audit log.",
  },
  "o2b.jobs.manualReadOnly": {
    uk: "Частину задач можна запустити вручну — це робить той, хто має право керувати роботою системи.",
    ru: "Часть задач можно запустить вручную — это делает тот, у кого есть право управлять работой системы.",
    en: "Some jobs can be run by hand — by someone with the right to manage the system.",
  },
  "o2b.job.analyticsCache": { uk: "Перерахунок аналітики", ru: "Пересчёт аналитики", en: "Analytics recalculation" },
  "o2b.job.searchReindex": { uk: "Переіндексація пошуку", ru: "Переиндексация поиска", en: "Search reindex" },
  "o2b.job.catalogInstall": { uk: "Встановлення каталогу методик", ru: "Установка каталога методик", en: "Assessment catalogue install" },
  "o2b.job.alerts": { uk: "Перевірка правил сповіщень", ru: "Проверка правил оповещений", en: "Alert rule check" },

  /* Помилки клієнта */
  "o2b.ce.stamp": {
    uk: "Помилки браузера й телефона — з бази, за {days} днів. Без даних людей: адреса — шаблоном, текст вичищено.",
    ru: "Ошибки браузера и телефона — из базы, за {days} дней. Без данных людей: адрес — шаблоном, текст вычищен.",
    en: "Browser and phone errors from the database, last {days} days. No personal data: routes as templates, text scrubbed.",
  },
  "o2b.ce.hint": {
    uk: "Падіння екранів, неперехоплені помилки, мережеві збої консолі (мережа, 5xx) і помилки мобільного застосунку — згруповано за відбитком.",
    ru: "Падения экранов, неперехваченные ошибки, сетевые сбои консоли (сеть, 5xx) и ошибки мобильного приложения — сгруппированы по отпечатку.",
    en: "Screen crashes, uncaught errors, console network failures (network, 5xx) and mobile app errors — grouped by fingerprint.",
  },
  "o2b.ce.search": { uk: "Пошук за текстом, маршрутом, збіркою", ru: "Поиск по тексту, маршруту, сборке", en: "Search text, route, build" },
  "o2b.ce.platform": { uk: "Платформа", ru: "Платформа", en: "Platform" },
  "o2b.ce.kind": { uk: "Вид", ru: "Вид", en: "Kind" },
  "o2b.ce.all": { uk: "Усі", ru: "Все", en: "All" },
  "o2b.ce.empty": { uk: "Помилок клієнта немає", ru: "Ошибок клиента нет", en: "No client errors" },
  "o2b.ce.more": { uk: "Показано {shown} останніх груп із {total}.", ru: "Показаны {shown} последних групп из {total}.", en: "Showing the latest {shown} of {total} groups." },
  "o2b.ce.full": {
    uk: "Сховище груп заповнене ({cap}): нові групи не заводяться, наявні рахуються далі.",
    ru: "Хранилище групп заполнено ({cap}): новые группы не заводятся, существующие считаются дальше.",
    en: "Group storage is full ({cap}): no new groups are created, existing ones keep counting.",
  },
  "o2b.ce.screen": { uk: "Екран, на якому сталася помилка", ru: "Экран, на котором произошла ошибка", en: "Screen where the error happened" },
  "o2b.ce.noResponse": { uk: "без відповіді", ru: "без ответа", en: "no response" },
  "o2b.ce.release": { uk: "збірка {v}", ru: "сборка {v}", en: "build {v}" },
  "o2b.ce.last": { uk: "востаннє {time}", ru: "последний раз {time}", en: "last {time}" },
  "o2b.kind.react": { uk: "падіння екрана", ru: "падение экрана", en: "screen crash" },
  "o2b.kind.error": { uk: "помилка", ru: "ошибка", en: "error" },
  "o2b.kind.rejection": { uk: "відмова промісу", ru: "отказ промиса", en: "promise rejection" },
  "o2b.kind.network": { uk: "мережа", ru: "сеть", en: "network" },
  "o2b.platform.web": { uk: "Консоль", ru: "Консоль", en: "Console" },
  "o2b.platform.mobile": { uk: "Телефон", ru: "Телефон", en: "Mobile app" },

  /* Швидкість екранів */
  "o2b.v.stamp": {
    uk: "Міряється {share} сесій консолі; дані — з бази, за {days} днів.",
    ru: "Измеряется {share} сессий консоли; данные — из базы, за {days} дней.",
    en: "{share} of console sessions are measured; data from the database, last {days} days.",
  },
  "o2b.v.hint": {
    uk: "p75 — три чверті відкриттів екрана швидші за це число. Оцінка — за порогами Web Vitals; «перехід» — наша міра: від зміни адреси до екрана, що заспокоївся.",
    ru: "p75 — три четверти открытий экрана быстрее этого числа. Оценка — по порогам Web Vitals; «переход» — наша мера: от смены адреса до успокоившегося экрана.",
    en: "p75: three quarters of screen visits are faster than this. Ratings use Web Vitals thresholds; “navigation” is our own measure — from the address change to a settled screen.",
  },
  "o2b.v.search": { uk: "Пошук маршруту", ru: "Поиск маршрута", en: "Find a route" },
  "o2b.v.empty": { uk: "Замірів ще немає", ru: "Замеров ещё нет", en: "No measurements yet" },
  "o2b.v.samples": { uk: "Замірів", ru: "Замеров", en: "Samples" },
  "o2b.v.few": { uk: "мало: {n}", ru: "мало: {n}", en: "few: {n}" },
  "o2b.v.pick": { uk: "Показати хід за 30 днів", ru: "Показать ход за 30 дней", en: "Show the 30-day trend" },
  "o2b.v.pickHint": {
    uk: "Натисніть маршрут у таблиці, щоб побачити хід p75 за 30 днів.",
    ru: "Нажмите маршрут в таблице, чтобы увидеть ход p75 за 30 дней.",
    en: "Select a route in the table to see its p75 over 30 days.",
  },
  "o2b.v.metric": { uk: "Міра", ru: "Мера", en: "Metric" },
  "o2b.v.trend": { uk: "p75 {metric} по днях", ru: "p75 {metric} по дням", en: "{metric} p75 by day" },
  "o2b.v.trendCaption": {
    uk: "добре ≤ {good}, погано > {poor}; замірів за період — {n}. Дні без замірів пропущено.",
    ru: "хорошо ≤ {good}, плохо > {poor}; замеров за период — {n}. Дни без замеров пропущены.",
    en: "good ≤ {good}, poor > {poor}; {n} samples in the period. Days without samples are skipped.",
  },
  "o2b.v.noMetric": { uk: "За цією мірою замірів немає", ru: "По этой мере замеров нет", en: "No samples for this metric" },
  "o2b.v.thresholds": { uk: "Пороги", ru: "Пороги", en: "Thresholds" },
  "o2b.v.thresholdsHint": {
    uk: "Між «добре» і «погано» — «потребує уваги». Оцінка стоїть словом поруч із числом.",
    ru: "Между «хорошо» и «плохо» — «требует внимания». Оценка стоит словом рядом с числом.",
    en: "Between “good” and “poor” is “needs attention”. The rating is spelled out next to the number.",
  },
  "o2b.v.what": { uk: "Що міряє", ru: "Что измеряет", en: "What it measures" },
  "o2b.rating.good": { uk: "добре", ru: "хорошо", en: "good" },
  "o2b.rating.needs": { uk: "потребує уваги", ru: "требует внимания", en: "needs attention" },
  "o2b.rating.poor": { uk: "погано", ru: "плохо", en: "poor" },
  "o2b.metric.LCP": { uk: "LCP", ru: "LCP", en: "LCP" },
  "o2b.metric.INP": { uk: "INP", ru: "INP", en: "INP" },
  "o2b.metric.CLS": { uk: "CLS", ru: "CLS", en: "CLS" },
  "o2b.metric.TTFB": { uk: "TTFB", ru: "TTFB", en: "TTFB" },
  "o2b.metric.NAV": { uk: "Перехід", ru: "Переход", en: "Navigation" },
  "o2b.metric.LCP.what": {
    uk: "коли з’явився найбільший елемент першого екрана",
    ru: "когда появился самый большой элемент первого экрана",
    en: "when the largest element of the first screen appeared",
  },
  "o2b.metric.INP.what": {
    uk: "як швидко екран відповідає на натискання й клавіші",
    ru: "как быстро экран отвечает на нажатия и клавиши",
    en: "how quickly the screen responds to clicks and keys",
  },
  "o2b.metric.CLS.what": {
    uk: "наскільки стрибає розмітка під час показу",
    ru: "насколько прыгает разметка при показе",
    en: "how much the layout jumps while showing",
  },
  "o2b.metric.TTFB.what": {
    uk: "коли сервер почав відповідати на завантаження сторінки",
    ru: "когда сервер начал отвечать на загрузку страницы",
    en: "when the server started answering the page load",
  },
  "o2b.metric.NAV.what": {
    uk: "від зміни адреси до екрана, що заспокоївся (пів секунди без змін)",
    ru: "от смены адреса до успокоившегося экрана (полсекунды без изменений)",
    en: "from the address change to a settled screen (half a second without changes)",
  },

  /* Записи прийомів */
  "o2b.rec.stamp": {
    uk: "Лише числа: жодного імені й жодного шляху до файлу запису.",
    ru: "Только числа: ни одного имени и ни одного пути к файлу записи.",
    en: "Numbers only: no names and no paths to recording files.",
  },
  "o2b.rec.kpi.stored": { uk: "Записів із файлом", ru: "Записей с файлом", en: "Recordings with a file" },
  "o2b.rec.kpi.waiting": { uk: "Чекають розшифровки", ru: "Ждут расшифровки", en: "Awaiting transcription" },
  "o2b.rec.kpi.oldest": { uk: "найдовше чекає {t}", ru: "дольше всех ждёт {t}", en: "oldest waiting {t}" },
  "o2b.rec.kpi.queueEmpty": { uk: "черга порожня", ru: "очередь пуста", en: "the queue is empty" },
  "o2b.rec.kpi.transcribing": { uk: "Розшифровується", ru: "Расшифровывается", en: "Transcribing" },
  "o2b.rec.kpi.stuck": {
    uk: "довше 6 год: {n} — ймовірно, процес розшифровки впав",
    ru: "дольше 6 ч: {n} — вероятно, процесс расшифровки упал",
    en: "over 6 h: {n} — the transcriber has probably crashed",
  },
  "o2b.rec.kpi.failed": { uk: "Збоїв розшифровки", ru: "Сбоев расшифровки", en: "Failed transcriptions" },
  "o2b.rec.kpi.free": { uk: "Вільно на томі", ru: "Свободно на томе", en: "Free on the volume" },
  "o2b.rec.kpi.of": { uk: "з {total}", ru: "из {total}", en: "of {total}" },
  "o2b.rec.byStatus": { uk: "За станом", ru: "По состоянию", en: "By status" },
  "o2b.rec.none": { uk: "Записів ще не було", ru: "Записей ещё не было", en: "No recordings yet" },
  "o2b.rec.col.status": { uk: "Стан", ru: "Состояние", en: "Status" },
  "o2b.rec.col.count": { uk: "Записів", ru: "Записей", en: "Recordings" },
  "o2b.rec.col.bytes": { uk: "Обсяг", ru: "Объём", en: "Size" },
  "o2b.rec.col.job": { uk: "Завдання", ru: "Задание", en: "Job" },
  "o2b.rec.col.age": { uk: "Вік", ru: "Возраст", en: "Age" },
  "o2b.rec.col.error": { uk: "Помилка", ru: "Ошибка", en: "Error" },
  "o2b.rec.status.consent_pending": { uk: "чекає згоди", ru: "ждёт согласия", en: "awaiting consent" },
  "o2b.rec.status.ready": { uk: "готово до запису", ru: "готово к записи", en: "ready to record" },
  "o2b.rec.status.recording": { uk: "іде запис", ru: "идёт запись", en: "recording" },
  "o2b.rec.status.uploaded": { uk: "чекає розшифровки", ru: "ждёт расшифровки", en: "awaiting transcription" },
  "o2b.rec.status.transcribing": { uk: "розшифровується", ru: "расшифровывается", en: "transcribing" },
  "o2b.rec.status.done": { uk: "розшифровано", ru: "расшифровано", en: "transcribed" },
  "o2b.rec.status.failed": { uk: "збій розшифровки", ru: "сбой расшифровки", en: "transcription failed" },
  "o2b.rec.status.discarded": { uk: "видалено", ru: "удалено", en: "discarded" },
  "o2b.rec.disk": { uk: "Диск", ru: "Диск", en: "Disk" },
  "o2b.rec.disk.files": { uk: "Файлів на томі", ru: "Файлов на томе", en: "Files on the volume" },
  "o2b.rec.disk.db": { uk: "За базою", ru: "По базе", en: "Per the database" },
  "o2b.rec.disk.match": { uk: "Звірка", ru: "Сверка", en: "Reconciliation" },
  "o2b.rec.disk.matches": { uk: "збігається", ru: "совпадает", en: "matches" },
  "o2b.rec.disk.mismatch": {
    uk: "зайвих файлів: {orphans}, бракує: {missing}",
    ru: "лишних файлов: {orphans}, недостаёт: {missing}",
    en: "extra files: {orphans}, missing: {missing}",
  },
  "o2b.rec.disk.noCompare": { uk: "не звірити", ru: "не сверить", en: "can’t reconcile" },
  "o2b.rec.disk.unread": { uk: "каталог не прочитався", ru: "каталог не прочитался", en: "the directory couldn’t be read" },
  "o2b.rec.disk.note": {
    uk: "Том каталогу записів (RECORDINGS_DIR) — це диск контейнера або тому, а не всієї машини.",
    ru: "Том каталога записей (RECORDINGS_DIR) — это диск контейнера или тома, а не всей машины.",
    en: "The recordings directory volume (RECORDINGS_DIR) is the container or volume disk, not the whole machine.",
  },
  "o2b.rec.transcriber": { uk: "Розшифровка", ru: "Расшифровка", en: "Transcription" },
  "o2b.rec.transcriber.here": {
    uk: "налаштована в цьому процесі; сам розшифровувач — окремий процес, його стан звідси видно лише за чергою",
    ru: "настроена в этом процессе; сам расшифровщик — отдельный процесс, его состояние отсюда видно лишь по очереди",
    en: "configured in this process; the transcriber itself is a separate process, visible from here only through the queue",
  },
  "o2b.rec.transcriber.elsewhere": {
    uk: "іде окремим процесом (transcriber) — звідси видно лише чергу: якщо «чекають» зростає, а «розшифровується» стоїть, процес зупинився",
    ru: "идёт отдельным процессом (transcriber) — отсюда видна лишь очередь: если «ждут» растёт, а «расшифровывается» стоит, процесс остановился",
    en: "runs as a separate process (transcriber) — only the queue is visible from here: if “awaiting” grows while “transcribing” stands still, the process has stopped",
  },
  "o2b.rec.failed": { uk: "Збої розшифровки", ru: "Сбои расшифровки", en: "Failed transcriptions" },
  "o2b.rec.failedHint": {
    uk: "Номер завдання, вік від кінця прийому й текст помилки без шляхів і даних. «Повторити» повертає запис у чергу.",
    ru: "Номер задания, возраст от конца приёма и текст ошибки без путей и данных. «Повторить» возвращает запись в очередь.",
    en: "Job ID, age since the appointment ended and the error text without paths or data. “Retry” puts the recording back in the queue.",
  },
  "o2b.rec.failedNone": { uk: "Збоїв немає", ru: "Сбоев нет", en: "No failures" },
  "o2b.rec.noFile": { uk: "файл стерто", ru: "файл стёрт", en: "file erased" },
  "o2b.rec.retried": { uk: "Повернуто в чергу розшифровки", ru: "Возвращено в очередь расшифровки", en: "Returned to the transcription queue" },

  /* ── wave10:people2 ── */
  /*
   * Техпанель → «Люди й безпека»: вход «от имени», второй фактор,
   * подозрительная активность, временные доступы, массовые действия, импорт,
   * «хто переглядав». Пояснения правил — с числами в {скобках}: «много»
   * экран всегда говорит числом с сервера (SuspiciousThresholds).
   */
  "ops.tab.suspicious": { uk: "Підозріла активність", ru: "Подозрительная активность", en: "Suspicious activity" },
  "ops.tab.grants": { uk: "Тимчасові доступи", ru: "Временные доступы", en: "Temporary access" },
  "ops.tab.whoViewed": { uk: "Хто переглядав", ru: "Кто смотрел", en: "Who viewed" },
  "ops.tab.mfa": { uk: "Другий фактор", ru: "Второй фактор", en: "Second factor" },

  "ops.imp.action": { uk: "Переглянути як ця людина", ru: "Посмотреть глазами этого человека", en: "View as this person" },
  "ops.imp.title": { uk: "Перегляд від імені", ru: "Просмотр от имени", en: "View as another person" },
  "ops.imp.warn": {
    uk: "Ви побачите систему так, як її бачить ця людина. Лише перегляд: зміни, технічна панель і журнал будуть недоступні. Сеанс триває 30 хвилин, кожна дія записується в журнал разом із вашим іменем і причиною.",
    ru: "Вы увидите систему так, как её видит этот человек. Только просмотр: изменения, техническая панель и журнал будут недоступны. Сеанс длится 30 минут, каждое действие пишется в журнал вместе с вашим именем и причиной.",
    en: "You'll see the system the way this person sees it. View only: changes, the technical panel and the audit log are unavailable. The session lasts 30 minutes, and every action is logged with your name and the reason.",
  },
  "ops.imp.start": { uk: "Переглянути", ru: "Посмотреть", en: "View" },
  "ops.imp.notSuper": { uk: "Від імені суперадміністратора переглядати не можна", ru: "Смотреть от имени суперадминистратора нельзя", en: "You can't view as a super administrator" },
  "ops.imp.banner": { uk: "Ви переглядаєте як", ru: "Вы смотрите как", en: "You are viewing as" },
  "ops.imp.until": { uk: "до", ru: "до", en: "until" },
  "ops.imp.readOnly": { uk: "лише перегляд", ru: "только просмотр", en: "view only" },
  "ops.imp.exit": { uk: "Вийти", ru: "Выйти", en: "Exit" },

  "acct.mfa.title": { uk: "Другий фактор", ru: "Второй фактор", en: "Second factor" },
  "acct.mfa.off": { uk: "Вимкнено: після пароля вхід не просить коду.", ru: "Выключен: после пароля вход не просит кода.", en: "Off: sign-in doesn't ask for a code after the password." },
  "acct.mfa.on": { uk: "Увімкнено", ru: "Включён", en: "On since" },
  "acct.mfa.left": { uk: "Кодів відновлення залишилось", ru: "Кодов восстановления осталось", en: "Recovery codes left" },
  "acct.mfa.required": { uk: "Для вашого облікового запису другий фактор обов’язковий.", ru: "Для вашей учётной записи второй фактор обязателен.", en: "A second factor is required for your account." },
  "acct.mfa.enable": { uk: "Увімкнути", ru: "Включить", en: "Turn on" },
  "acct.mfa.scan": {
    uk: "Відскануйте QR-код у застосунку-автентифікаторі (Google Authenticator, Microsoft Authenticator, 1Password тощо) або введіть ключ вручну, а потім — шість цифр, які він покаже.",
    ru: "Отсканируйте QR-код в приложении-аутентификаторе (Google Authenticator, Microsoft Authenticator, 1Password и т. п.) или введите ключ вручную, а затем — шесть цифр, которые оно покажет.",
    en: "Scan the QR code with an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, etc.) or type the key in by hand, then enter the six digits it shows.",
  },
  "acct.mfa.qr": { uk: "QR-код для застосунку-автентифікатора", ru: "QR-код для приложения-аутентификатора", en: "QR code for the authenticator app" },
  "acct.mfa.key": { uk: "Ключ", ru: "Ключ", en: "Key" },
  "acct.mfa.code": { uk: "Код із застосунку", ru: "Код из приложения", en: "Code from the app" },
  "acct.mfa.confirm": { uk: "Підтвердити", ru: "Подтвердить", en: "Confirm" },
  "acct.mfa.codesTitle": { uk: "Коди відновлення", ru: "Коды восстановления", en: "Recovery codes" },
  "acct.mfa.codesHint": {
    uk: "Показуються один раз. Збережіть їх у надійному місці: кожен код відкриває вхід один раз, коли телефону немає під рукою.",
    ru: "Показываются один раз. Сохраните их в надёжном месте: каждый код открывает вход один раз, когда телефона нет под рукой.",
    en: "Shown only once. Keep them somewhere safe: each code opens sign-in once when your phone isn't at hand.",
  },
  "acct.mfa.download": { uk: "Завантажити файлом", ru: "Скачать файлом", en: "Download as a file" },
  "acct.mfa.savedCodes": { uk: "Я зберіг коди", ru: "Я сохранил коды", en: "I've saved the codes" },
  "acct.mfa.disable": { uk: "Вимкнути", ru: "Выключить", en: "Turn off" },
  "acct.mfa.disableHint": { uk: "Щоб вимкнути, введіть пароль і код із застосунку.", ru: "Чтобы выключить, введите пароль и код из приложения.", en: "To turn it off, enter your password and a code from the app." },
  "acct.mfa.enabledDone": { uk: "Другий фактор увімкнено", ru: "Второй фактор включён", en: "Second factor turned on" },
  "acct.mfa.disabledDone": { uk: "Другий фактор вимкнено", ru: "Второй фактор выключен", en: "Second factor turned off" },

  "mfa.gate.title": { uk: "Налаштуйте другий фактор", ru: "Настройте второй фактор", en: "Set up a second factor" },
  "mfa.gate.sub": {
    uk: "Для вашої ролі вхід без другого фактора більше не дозволено. Налаштуйте його — це займе хвилину, — і далі входьте з кодом із застосунку.",
    ru: "Для вашей роли вход без второго фактора больше не разрешён. Настройте его — это займёт минуту, — и дальше входите с кодом из приложения.",
    en: "Your role can no longer sign in without a second factor. Set it up — it takes a minute — and sign in with a code from the app from now on.",
  },

  "lg.mfa.title": { uk: "Код із застосунку", ru: "Код из приложения", en: "Code from the app" },
  "lg.mfa.hint": {
    uk: "Введіть шість цифр із застосунку-автентифікатора. Немає телефону — введіть один із кодів відновлення.",
    ru: "Введите шесть цифр из приложения-аутентификатора. Нет телефона — введите один из кодов восстановления.",
    en: "Enter the six digits from your authenticator app. No phone? Enter one of your recovery codes.",
  },
  "lg.mfa.back": { uk: "Інший обліковий запис", ru: "Другая учётная запись", en: "Another account" },

  "ops.mfa.policy": { uk: "Коли другий фактор обов’язковий", ru: "Когда второй фактор обязателен", en: "When a second factor is required" },
  "ops.mfa.forSuper": { uk: "Для суперадміністраторів", ru: "Для суперадминистраторов", en: "For super administrators" },
  "ops.mfa.forOps": { uk: "Для тих, хто має ops.read або ops.manage", ru: "Для тех, у кого есть ops.read или ops.manage", en: "For holders of ops.read or ops.manage" },
  "ops.mfa.policyHint": {
    uk: "Поки фактор не налаштовано, людина входить, але далі налаштування не проходить. Суперадміністратор має всі права, тож друга позначка стосується і його.",
    ru: "Пока фактор не настроен, человек входит, но дальше настройки не проходит. У суперадминистратора все права, так что вторая отметка касается и его.",
    en: "Until the factor is set up, the person can sign in but can't get past setup. A super administrator holds every permission, so the second option applies to them too.",
  },
  "ops.mfa.saved": { uk: "Політику збережено", ru: "Политика сохранена", en: "Policy saved" },
  "ops.mfa.changed": { uk: "Змінено", ru: "Изменено", en: "Changed" },
  "ops.mfa.coverage": { uk: "Кому потрібен", ru: "Кому нужен", en: "Who needs it" },
  "ops.mfa.because.superadmin": { uk: "суперадміністратор", ru: "суперадминистратор", en: "super administrator" },
  "ops.mfa.because.ops": { uk: "має ops.read / ops.manage", ru: "есть ops.read / ops.manage", en: "holds ops.read / ops.manage" },
  "ops.mfa.enabled": { uk: "налаштовано", ru: "настроен", en: "set up" },
  "ops.mfa.missing": { uk: "не налаштовано", ru: "не настроен", en: "not set up" },
  "ops.mfa.nobody": { uk: "Нікому з персоналу другий фактор за цими правилами не потрібен", ru: "Никому из персонала второй фактор по этим правилам не нужен", en: "No staff member needs a second factor under these rules" },
  "ops.mfa.reset": { uk: "Скинути другий фактор", ru: "Сбросить второй фактор", en: "Reset second factor" },
  "ops.mfa.resetWarn": {
    uk: "другий фактор буде видалено разом із кодами відновлення. Людина увійде паролем і, якщо фактор обов’язковий, налаштує його заново.",
    ru: "второй фактор будет удалён вместе с кодами восстановления. Человек войдёт паролем и, если фактор обязателен, настроит его заново.",
    en: "the second factor will be removed along with the recovery codes. The person signs in with the password and, if the factor is required, sets it up again.",
  },
  "ops.mfa.resetDone": { uk: "Другий фактор скинуто", ru: "Второй фактор сброшен", en: "Second factor reset" },

  "ops.susp.open": { uk: "Нерозібрані", ru: "Неразобранные", en: "Open" },
  "ops.susp.resolvedMany": { uk: "Розібрані", ru: "Разобранные", en: "Reviewed" },
  "ops.susp.all": { uk: "Усі", ru: "Все", en: "All" },
  "ops.susp.allRules": { uk: "Усі правила", ru: "Все правила", en: "All rules" },
  "ops.susp.scan": { uk: "Перевірити зараз", ru: "Проверить сейчас", en: "Check now" },
  "ops.susp.scanned": { uk: "Перевірку виконано", ru: "Проверка выполнена", en: "Check complete" },
  "ops.susp.lastScan": { uk: "Остання перевірка", ru: "Последняя проверка", en: "Last check" },
  "ops.susp.neverScanned": { uk: "від запуску ще не було", ru: "с запуска ещё не было", en: "none since start-up" },
  "ops.susp.openCount": { uk: "Нерозібраних", ru: "Неразобранных", en: "Open" },
  "ops.susp.none": { uk: "Спрацювань за цим відбором немає", ru: "Срабатываний по этому отбору нет", en: "No alerts match this selection" },
  "ops.susp.rule": { uk: "Правило", ru: "Правило", en: "Rule" },
  "ops.susp.who": { uk: "Хто", ru: "Кто", en: "Who" },
  "ops.susp.when": { uk: "Коли", ru: "Когда", en: "When" },
  "ops.susp.new": { uk: "нове", ru: "новое", en: "new" },
  "ops.susp.inLog": { uk: "У журналі", ru: "В журнале", en: "In the log" },
  "ops.susp.resolve": { uk: "Позначити «розібрано»", ru: "Отметить «разобрано»", en: "Mark as reviewed" },
  "ops.susp.resolvedOne": { uk: "розібрано", ru: "разобрано", en: "reviewed" },
  "ops.susp.comment": { uk: "Що з’ясували — словами, це прочитають у журналі", ru: "Что выяснили — словами, это прочтут в журнале", en: "What you found out — in words, it will be read in the log" },
  "ops.susp.resolvedDone": { uk: "Позначено «розібрано»", ru: "Отмечено «разобрано»", en: "Marked as reviewed" },
  "ops.susp.rulesTitle": { uk: "Як працюють правила", ru: "Как работают правила", en: "How the rules work" },
  "ops.susp.hoursSchedule": { uk: "за розкладами фахівців", ru: "по расписаниям специалистов", en: "from specialists' schedules" },
  "ops.susp.hoursDefault": { uk: "типовий, розкладів ще немає", ru: "типовой, расписаний ещё нет", en: "default, no schedules yet" },
  "ops.susp.events": { uk: "подій", ru: "событий", en: "events" },
  "ops.susp.patients": { uk: "пацієнтів", ru: "пациентов", en: "patients" },
  "ops.susp.accounts": { uk: "облікових записів", ru: "учётных записей", en: "accounts" },
  "ops.susp.client": { uk: "клієнт", ru: "клиент", en: "client" },
  "ops.susp.reason": { uk: "причина", ru: "причина", en: "reason" },
  "ops.rule.failedLoginsAccount": { uk: "Невдалі входи в обліковий запис", ru: "Неудачные входы в учётную запись", en: "Failed sign-ins to an account" },
  "ops.rule.failedLoginsIp": { uk: "Невдалі входи з однієї адреси", ru: "Неудачные входы с одного адреса", en: "Failed sign-ins from one address" },
  "ops.rule.newDevice": { uk: "Вхід із нового клієнта", ru: "Вход с нового клиента", en: "Sign-in from a new client" },
  "ops.rule.massReads": { uk: "Масові перегляди карток", ru: "Массовые просмотры карточек", en: "Mass record viewing" },
  "ops.rule.nightActivity": { uk: "Робота з картками вночі", ru: "Работа с карточками ночью", en: "Record access at night" },
  "ops.rule.namedExport": { uk: "Вивантаження з іменами", ru: "Выгрузка с именами", en: "Export with names" },
  "ops.rule.impersonation": { uk: "Перегляд від імені іншої людини", ru: "Просмотр от имени другого человека", en: "Viewing as another person" },
  "ops.ruleWhy.failedLoginsAccount": {
    uk: "{n} невдалих входів за {min} хв — поріг блокування входу. Або людина забула пароль, або пароль підбирають.",
    ru: "{n} неудачных входов за {min} мин — порог блокировки входа. Либо человек забыл пароль, либо пароль подбирают.",
    en: "{n} failed sign-ins in {min} min — the lockout threshold. Either the person forgot the password, or someone is guessing it.",
  },
  "ops.ruleWhy.failedLoginsIp": {
    uk: "{n} невдалих входів з однієї адреси за {min} хв щонайменше до {accounts} різних облікових записів — схоже на підбір пароля за списком людей, а не на забудькуватість.",
    ru: "{n} неудачных входов с одного адреса за {min} мин как минимум в {accounts} разные учётные записи — похоже на подбор пароля по списку людей, а не на забывчивость.",
    en: "{n} failed sign-ins from one address in {min} min to at least {accounts} different accounts — looks like password guessing across a list of people, not forgetfulness.",
  },
  "ops.ruleWhy.newDevice": {
    uk: "Вхід із браузера чи системи, з яких ця людина за 90 днів не входила. Порівнюється сімейство (браузер · система), а не версія.",
    ru: "Вход с браузера или системы, с которых этот человек за 90 дней не входил. Сравнивается семейство (браузер · система), а не версия.",
    en: "A sign-in from a browser or system this person hasn't used in 90 days. The family (browser · system) is compared, not the version.",
  },
  "ops.ruleWhy.massReads": {
    uk: "{n} різних пацієнтів за {min} хв одним співробітником — це вибірка, а не прийом.",
    ru: "{n} разных пациентов за {min} мин одним сотрудником — это выборка, а не приём.",
    en: "{n} different patients in {min} min by one staff member — that's a sweep, not a consultation.",
  },
  "ops.ruleWhy.nightActivity": {
    uk: "Щонайменше {n} переглядів даних пацієнтів між {from} і {to} ({tz}; робочий день {source}). Один перегляд уночі — черговий біля тривоги; серія — вже питання.",
    ru: "Не меньше {n} просмотров данных пациентов между {from} и {to} ({tz}; рабочий день {source}). Один просмотр ночью — дежурный у тревоги; серия — уже вопрос.",
    en: "At least {n} views of patient data between {from} and {to} ({tz}; working day {source}). One view at night is the on-call clinician at an alert; a series is a question.",
  },
  "ops.ruleWhy.namedExport": {
    uk: "Вивантаження, що виносить дані з іменами за межі системи. Кожне — окремим рядком.",
    ru: "Выгрузка, уносящая данные с именами за пределы системы. Каждая — отдельной строкой.",
    en: "An export that takes data with names outside the system. Each one gets its own row.",
  },
  "ops.ruleWhy.impersonation": {
    uk: "Суперадміністратор переглядав систему від імені іншої людини. Навіть законний перегляд має бути на виду.",
    ru: "Суперадминистратор смотрел систему от имени другого человека. Даже законный просмотр должен быть на виду.",
    en: "A super administrator viewed the system as another person. Even a legitimate view should be visible.",
  },

  "ops.grants.active": { uk: "Діють", ru: "Действуют", en: "Active" },
  "ops.grants.expired": { uk: "Закінчилися за 30 днів", ru: "Закончились за 30 дней", en: "Expired in the last 30 days" },
  "ops.grants.noneActive": { uk: "Тимчасових доступів зараз немає", ru: "Временных доступов сейчас нет", en: "No temporary access right now" },
  "ops.grants.noneExpired": { uk: "За 30 днів нічого не закінчилося", ru: "За 30 дней ничего не закончилось", en: "Nothing expired in the last 30 days" },
  "ops.grants.permanent": { uk: "Безстрокових винятків — на екрані прав", ru: "Бессрочных исключений — на экране прав", en: "Permanent exceptions — on the permissions screen" },
  "ops.grants.person": { uk: "Людина", ru: "Человек", en: "Person" },
  "ops.grants.permission": { uk: "Право", ru: "Право", en: "Permission" },
  "ops.grants.given": { uk: "надано", ru: "выдано", en: "granted" },
  "ops.grants.taken": { uk: "відібрано", ru: "отнято", en: "taken away" },
  "ops.grants.ends": { uk: "Закінчується", ru: "Заканчивается", en: "Ends" },
  "ops.grants.ended": { uk: "Закінчився", ru: "Закончился", en: "Ended" },
  "ops.grants.inDays": { uk: "через {n} дн.", ru: "через {n} дн.", en: "in {n} d" },
  "ops.grants.inHours": { uk: "через {n} год", ru: "через {n} ч", en: "in {n} h" },
  "ops.grants.by": { uk: "видав", ru: "выдал", en: "granted by" },
  "ops.grants.extend": { uk: "Продовжити", ru: "Продлить", en: "Extend" },
  "ops.grants.revoke": { uk: "Відкликати", ru: "Отозвать", en: "Revoke" },
  "ops.grants.days": { uk: "На скільки днів", ru: "На сколько дней", en: "For how many days" },
  "ops.grants.extendHint": {
    uk: "Строк рахується від поточного закінчення, а якщо доступ вже закінчився — від сьогодні.",
    ru: "Срок считается от нынешнего окончания, а если доступ уже закончился — от сегодня.",
    en: "The term counts from the current end date, or from today if access has already expired.",
  },
  "ops.grants.extended": { uk: "Доступ продовжено", ru: "Доступ продлён", en: "Access extended" },
  "ops.grants.revoked": { uk: "Доступ відкликано", ru: "Доступ отозван", en: "Access revoked" },
  "ops.grants.revokeWarn": {
    uk: "доступ закінчиться одразу. Відкликане не продовжують — видати знову можна на екрані прав.",
    ru: "доступ закончится сразу. Отозванное не продлевают — выдать снова можно на экране прав.",
    en: "access ends immediately. Revoked access can't be extended — grant it again on the permissions screen.",
  },

  "ops.bulk.selected": { uk: "Вибрано", ru: "Выбрано", en: "Selected" },
  "ops.bulk.selectRow": { uk: "Вибрати", ru: "Выбрать", en: "Select" },
  "ops.bulk.selectPage": { uk: "Вибрати всіх на сторінці", ru: "Выбрать всех на странице", en: "Select all on this page" },
  "ops.bulk.selectFilter": { uk: "Вибрати всіх у відборі", ru: "Выбрать всех в отборе", en: "Select all matching" },
  "ops.bulk.clear": { uk: "Зняти вибір", ru: "Снять выбор", en: "Clear selection" },
  "ops.bulk.actions": { uk: "Дії з вибраними", ru: "Действия с выбранными", en: "Actions on selected" },
  "ops.bulk.disable": { uk: "Вимкнути…", ru: "Отключить…", en: "Disable…" },
  "ops.bulk.enable": { uk: "Увімкнути", ru: "Включить", en: "Enable" },
  "ops.bulk.revoke": { uk: "Завершити сесії", ru: "Завершить сессии", en: "End sessions" },
  "ops.bulk.assignRole": { uk: "Призначити роль-шаблон…", ru: "Назначить роль-шаблон…", en: "Assign a role template…" },
  "ops.bulk.confirm": {
    uk: "Дію буде застосовано до вибраних облікових записів: {n}. Правила ті самі, що й для одного, — кого чіпати не можна, буде пропущено з поясненням.",
    ru: "Действие будет применено к выбранным учётным записям: {n}. Правила те же, что и для одной, — кого трогать нельзя, будет пропущен с объяснением.",
    en: "The action applies to the selected accounts: {n}. The rules are the same as for one — anyone who can't be touched is skipped with an explanation.",
  },
  "ops.bulk.role": { uk: "Роль-шаблон", ru: "Роль-шаблон", en: "Role template" },
  "ops.bulk.notAssigner": {
    uk: "Ролі призначає той, у кого на драбині посад є кому їх призначати",
    ru: "Роли назначает тот, у кого на лестнице должностей есть кому их назначать",
    en: "Roles are assigned by someone with people below them on the job ladder",
  },
  "ops.bulk.done": { uk: "Зроблено", ru: "Сделано", en: "Done" },
  "ops.bulk.skipped": { uk: "Пропущено", ru: "Пропущено", en: "Skipped" },
  "ops.skip.notFound": { uk: "обліковий запис не знайдено", ru: "учётная запись не найдена", en: "account not found" },
  "ops.skip.self": { uk: "з власним обліковим записом так не можна", ru: "с собственной учётной записью так нельзя", en: "not allowed on your own account" },
  "ops.skip.superadminOnly": { uk: "над суперадміністратором — лише суперадміністратор", ru: "над суперадминистратором — только суперадминистратор", en: "only a super administrator can act on a super administrator" },
  "ops.skip.lastSuperadmin": { uk: "останній активний суперадміністратор", ru: "последний активный суперадминистратор", en: "the last active super administrator" },
  "ops.skip.alreadyDisabled": { uk: "вже вимкнено", ru: "уже отключена", en: "already disabled" },
  "ops.skip.notDisabled": { uk: "не вимкнено", ru: "не отключена", en: "not disabled" },
  "ops.skip.patient": { uk: "пацієнтові ролей персоналу не призначають", ru: "пациенту роли персонала не назначают", en: "patients don't get staff roles" },
  "ops.skip.superadminTarget": { uk: "суперадміністраторові ролі-шаблони нічого не дають", ru: "суперадминистратору роли-шаблоны ничего не дают", en: "role templates give a super administrator nothing" },
  "ops.skip.alreadyHasRole": { uk: "роль вже є", ru: "роль уже есть", en: "already has the role" },
  "ops.skip.roleNotInChain": { uk: "роль поза драбиною посад — її призначає лише суперадміністратор", ru: "роль вне лестницы должностей — её назначает только суперадминистратор", en: "the role is outside the job ladder — only a super administrator assigns it" },
  "ops.skip.roleAboveYours": { uk: "роль не нижча за вашу", ru: "роль не ниже вашей", en: "the role isn't below yours" },
  "ops.skip.roleGrantsMore": { uk: "роль дає права, яких немає у вас", ru: "роль даёт права, которых нет у вас", en: "the role grants permissions you don't have" },

  "ops.import.button": { uk: "Імпорт CSV", ru: "Импорт CSV", en: "Import CSV" },
  "ops.import.title": { uk: "Імпорт співробітників", ru: "Импорт сотрудников", en: "Import staff" },
  "ops.import.hint": {
    uk: "Колонки: прізвище, ім’я, по батькові, пошта, роль (порожньо — адміністратор; superadmin — лише суперадміністратору), роль-шаблон (код, напр. specialist), посада, підрозділ. Обов’язкові — прізвище, ім’я, пошта. Роздільник — кома або крапка з комою.",
    ru: "Колонки: фамилия, имя, отчество, почта, роль (пусто — администратор; superadmin — только суперадминистратору), роль-шаблон (код, напр. specialist), должность, подразделение. Обязательные — фамилия, имя, почта. Разделитель — запятая или точка с запятой.",
    en: "Columns: last name, first name, middle name, email, role (empty — administrator; superadmin — super administrators only), role template (a code, e.g. specialist), position, unit. Required: last name, first name, email. Separator: comma or semicolon.",
  },
  "ops.import.template": { uk: "Завантажити шаблон", ru: "Скачать шаблон", en: "Download template" },
  "ops.import.file": { uk: "Файл CSV", ru: "Файл CSV", en: "CSV file" },
  "ops.import.check": { uk: "Перевірити", ru: "Проверить", en: "Check" },
  "ops.import.rows": { uk: "Рядків", ru: "Строк", en: "Rows" },
  "ops.import.valid": { uk: "без помилок", ru: "без ошибок", en: "without errors" },
  "ops.import.line": { uk: "Рядок", ru: "Строка", en: "Line" },
  "ops.import.unknownColumns": { uk: "Невідомі колонки — їх пропущено", ru: "Неизвестные колонки — пропущены", en: "Unknown columns — ignored" },
  "ops.import.missingColumns": { uk: "Немає обов’язкових колонок", ru: "Нет обязательных колонок", en: "Required columns missing" },
  "ops.import.create": { uk: "Створити", ru: "Создать", en: "Create" },
  "ops.import.fixFirst": {
    uk: "Спершу виправте рядки з помилками: імпорт іде всім файлом або ніяк.",
    ru: "Сначала исправьте строки с ошибками: импорт идёт всем файлом или никак.",
    en: "Fix the rows with errors first: the import takes the whole file or nothing.",
  },
  "ops.import.createdTitle": { uk: "Створено", ru: "Создано", en: "Created" },
  "ops.import.createdHint": {
    uk: "Тимчасові паролі показано один раз. Завантажте їх файлом і передайте людям — під час входу система попросить змінити пароль.",
    ru: "Временные пароли показаны один раз. Скачайте их файлом и передайте людям — при входе система попросит сменить пароль.",
    en: "Temporary passwords are shown only once. Download them as a file and pass them on — the system will ask to change the password at sign-in.",
  },
  "ops.import.downloadPasswords": { uk: "Завантажити паролі CSV", ru: "Скачать пароли CSV", en: "Download passwords CSV" },
  "ops.import.ok": { uk: "гаразд", ru: "в порядке", en: "ok" },
  "ops.import.err.lastNameRequired": { uk: "порожнє прізвище", ru: "пустая фамилия", en: "last name is empty" },
  "ops.import.err.firstNameRequired": { uk: "порожнє ім’я", ru: "пустое имя", en: "first name is empty" },
  "ops.import.err.emailRequired": { uk: "порожня пошта", ru: "пустая почта", en: "email is empty" },
  "ops.import.err.emailInvalid": { uk: "пошта з помилкою", ru: "почта с ошибкой", en: "email is malformed" },
  "ops.import.err.emailTaken": { uk: "пошта вже зайнята", ru: "почта уже занята", en: "email is already taken" },
  "ops.import.err.emailDuplicate": { uk: "пошта повторюється у файлі", ru: "почта повторяется в файле", en: "email repeats in the file" },
  "ops.import.err.roleUnknown": { uk: "роль невідома", ru: "роль неизвестна", en: "unknown role" },
  "ops.import.err.roleNotAllowed": { uk: "таку роль тут не видають", ru: "такую роль здесь не выдают", en: "this role can't be given here" },
  "ops.import.err.roleTemplateUnknown": { uk: "роль-шаблон невідома", ru: "роль-шаблон неизвестна", en: "unknown role template" },
  "ops.import.err.roleTemplateAboveYours": { uk: "роль-шаблон не нижча за вашу", ru: "роль-шаблон не ниже вашей", en: "the role template isn't below yours" },

  "ops.who.patient": { uk: "Пацієнт", ru: "Пациент", en: "Patient" },
  "ops.who.search": { uk: "Пошук пацієнта: ПІБ або пошта", ru: "Поиск пациента: ФИО или почта", en: "Find a patient: name or email" },
  "ops.who.change": { uk: "Інший пацієнт", ru: "Другой пациент", en: "Another patient" },
  "ops.who.build": { uk: "Сформувати", ru: "Сформировать", en: "Generate" },
  "ops.who.choose": { uk: "Оберіть пацієнта й період", ru: "Выберите пациента и период", en: "Choose a patient and a period" },
  "ops.who.hint": {
    uk: "Усі записи журналу, де пацієнт — той, чиї дані відкривали: картка, проходження, висновки, записи прийому, вивантаження, перегляд від його імені. Власні дії пацієнта й дії системи до звіту не входять.",
    ru: "Все записи журнала, где пациент — тот, чьи данные открывали: карточка, прохождения, заключения, записи приёма, выгрузки, просмотр от его имени. Собственные действия пациента и действия системы в отчёт не входят.",
    en: "Every audit log entry where the patient is the person whose data was opened: the card, responses, conclusions, visit notes, exports, viewing as them. The patient's own actions and system actions are not included.",
  },
  "ops.who.reportTitle": { uk: "Хто переглядав дані пацієнта", ru: "Кто смотрел данные пациента", en: "Who viewed the patient's data" },
  "ops.who.period": { uk: "Період", ru: "Период", en: "Period" },
  "ops.who.generated": { uk: "Сформовано", ru: "Сформировано", en: "Generated" },
  "ops.who.nobody": { uk: "За цей період ніхто з персоналу даних пацієнта не переглядав", ru: "За этот период никто из персонала данных пациента не смотрел", en: "No staff member viewed the patient's data in this period" },
  "ops.who.print": { uk: "Друкувати", ru: "Печать", en: "Print" },
  "ops.who.staff": { uk: "Співробітник", ru: "Сотрудник", en: "Staff member" },
  "ops.who.day": { uk: "День", ru: "День", en: "Day" },
  "ops.who.action": { uk: "Дія", ru: "Действие", en: "Action" },
  "ops.who.count": { uk: "Разів", ru: "Раз", en: "Times" },
  "ops.who.first": { uk: "Перший раз", ru: "Первый раз", en: "First" },
  "ops.who.last": { uk: "Останній раз", ru: "Последний раз", en: "Last" },
  "ops.who.as": { uk: "від імені", ru: "от имени", en: "as" },
  "ops.who.actions": { uk: "дій", ru: "действий", en: "actions" },

  "ops.act.impStart": { uk: "Початок перегляду від імені", ru: "Начало просмотра от имени", en: "Viewing as another person started" },
  "ops.act.impEnd": { uk: "Завершення перегляду від імені", ru: "Завершение просмотра от имени", en: "Viewing as another person ended" },
  "ops.act.impView": { uk: "Перегляд від імені", ru: "Просмотр от имени", en: "Viewing as another person" },
  "ops.act.mfaChallenge": { uk: "Пароль прийнято, очікується код", ru: "Пароль принят, ожидается код", en: "Password accepted, code awaited" },
  "ops.act.mfaSetup": { uk: "Початок налаштування другого фактора", ru: "Начало настройки второго фактора", en: "Second factor setup started" },
  "ops.act.mfaEnable": { uk: "Увімкнення другого фактора", ru: "Включение второго фактора", en: "Second factor turned on" },
  "ops.act.mfaDisable": { uk: "Вимкнення другого фактора", ru: "Выключение второго фактора", en: "Second factor turned off" },
  "ops.act.mfaReset": { uk: "Скидання другого фактора", ru: "Сброс второго фактора", en: "Second factor reset" },
  "ops.act.policy": { uk: "Зміна політики безпеки", ru: "Смена политики безопасности", en: "Security policy change" },
  "ops.act.suspRead": { uk: "Перегляд підозрілої активності", ru: "Просмотр подозрительной активности", en: "Viewing suspicious activity" },
  "ops.act.suspResolve": { uk: "Розбір спрацювання", ru: "Разбор срабатывания", en: "Alert reviewed" },
  "ops.act.suspScan": { uk: "Перевірка підозрілої активності", ru: "Проверка подозрительной активности", en: "Suspicious activity check" },
  "ops.act.grantsList": { uk: "Перегляд тимчасових доступів", ru: "Просмотр временных доступов", en: "Viewing temporary access" },
  "ops.act.grantExtend": { uk: "Продовження тимчасового доступу", ru: "Продление временного доступа", en: "Temporary access extended" },
  "ops.act.bulk": { uk: "Масова дія з обліковими записами", ru: "Массовое действие с учётными записями", en: "Bulk account action" },
  "ops.act.import": { uk: "Імпорт співробітників", ru: "Импорт сотрудников", en: "Staff import" },
  "ops.act.subjectReport": { uk: "Звіт «хто переглядав»", ru: "Отчёт «кто смотрел»", en: "“Who viewed” report" },

  /* ── w11:people ── */
  /*
   * Графики разделов людей техпанели (волна 11): сводка реестра и сессий,
   * записи журнала во времени, обзор подозрительного и временных доступов,
   * «хто переглядав», охват вторым фактором. Числа в {скобках} — с сервера:
   * окна рядов и порог малых чисел экран своей копией не держит.
   */
  "opsp.overview": { uk: "Огляд", ru: "Обзор", en: "Overview" },
  "opsp.others": { uk: "Інші", ru: "Прочие", en: "Other" },
  "opsp.total": { uk: "Усього", ru: "Всего", en: "Total" },
  "opsp.users.section": { uk: "Зведення реєстру", ru: "Сводка реестра", en: "Registry overview" },
  "opsp.users.sectionHint": {
    uk: "Увесь реєстр, без відбору зі списку нижче. Лише числа; клітинки з пацієнтами, де людей менше {n}, не показано — поріг малих чисел.",
    ru: "Весь реестр, без отбора из списка ниже. Только числа; ячейки с пациентами, где людей меньше {n}, не показаны — порог малых чисел.",
    en: "The whole registry, ignoring the filter of the list below. Numbers only; patient cells with fewer than {n} people are hidden — the small-cell threshold.",
  },
  "opsp.users.states": { uk: "Стан облікових записів", ru: "Состояние учётных записей", en: "Account status" },
  "opsp.users.statesHint": {
    uk: "Кожен запис — в одному стані, за старшинством: вимкнено, заблоковано перебором пароля зараз, жодного входу, діє.",
    ru: "Каждая запись — в одном состоянии, по старшинству: выключена, заблокирована перебором пароля сейчас, ни одного входа, действует.",
    en: "Each account is in exactly one state, by precedence: disabled, locked by failed attempts right now, never signed in, active.",
  },
  "opsp.state.active": { uk: "Діє", ru: "Действует", en: "Active" },
  "opsp.state.never": { uk: "Жодного входу", ru: "Ни одного входа", en: "Never signed in" },
  "opsp.state.locked": { uk: "Заблоковано перебором", ru: "Заблокирована перебором", en: "Locked by failed attempts" },
  "opsp.state.disabled": { uk: "Вимкнено", ru: "Выключена", en: "Disabled" },
  "opsp.users.mfa": { uk: "Другий фактор у персоналу", ru: "Второй фактор у персонала", en: "Second factor among staff" },
  "opsp.users.mfaHint": {
    uk: "Серед облікових записів, що діють; у пацієнтів вимоги немає.",
    ru: "Среди действующих учётных записей; у пациентов требования нет.",
    en: "Among active accounts; patients are not subject to the requirement.",
  },
  "opsp.mfa.on": { uk: "Налаштовано", ru: "Настроен", en: "Set up" },
  "opsp.mfa.off": { uk: "Не налаштовано", ru: "Не настроен", en: "Not set up" },
  "opsp.users.newByWeek": { uk: "Нові облікові записи", ru: "Новые учётные записи", en: "New accounts" },
  "opsp.users.newByWeekHint": {
    uk: "{n} тижнів, тиждень — з понеділка. Де нових пацієнтів менше {floor}, їх не показано — риска над стовпцем.",
    ru: "{n} недель, неделя — с понедельника. Где новых пациентов меньше {floor}, они не показаны — черта над столбцом.",
    en: "{n} weeks, each starting on Monday. Where there are fewer than {floor} new patients they are hidden — a dash above the column.",
  },
  "opsp.series.staff": { uk: "Персонал", ru: "Персонал", en: "Staff" },
  "opsp.series.patients": { uk: "Пацієнти", ru: "Пациенты", en: "Patients" },
  "opsp.users.logins": { uk: "Входи", ru: "Входы", en: "Sign-ins" },
  "opsp.users.loginsHint": {
    uk: "{n} днів: вдалі входи й невдалі спроби — хибний пароль чи код, заблокований або вимкнений запис.",
    ru: "{n} дней: удачные входы и неудачные попытки — неверный пароль или код, заблокированная или выключенная учётка.",
    en: "{n} days: successful sign-ins and failed attempts — wrong password or code, a locked or disabled account.",
  },
  "opsp.series.success": { uk: "Вдалі", ru: "Удачные", en: "Successful" },
  "opsp.series.failed": { uk: "Невдалі", ru: "Неудачные", en: "Failed" },
  "opsp.sess.section": { uk: "Зведення сесій", ru: "Сводка сессий", en: "Sessions overview" },
  "opsp.sess.sectionHint": {
    uk: "Усі сесії, що діють зараз, без відбору зі списку нижче. Розподілу за пристроями немає — чому, сказано над списком.",
    ru: "Все сессии, действующие сейчас, без отбора из списка ниже. Распределения по устройствам нет — почему, сказано над списком.",
    en: "All sessions active right now, ignoring the filter of the list below. There is no breakdown by device — the reason is given above the list.",
  },
  "opsp.sess.byRole": { uk: "Сесії за роллю", ru: "Сессии по роли", en: "Sessions by role" },
  "opsp.sess.byAge": { uk: "Вік сесії", ru: "Возраст сессии", en: "Session age" },
  "opsp.sess.byAgeHint": { uk: "Від входу; окремо в персоналу й пацієнтів.", ru: "От входа; отдельно у персонала и пациентов.", en: "Since sign-in; staff and patients shown separately." },
  "opsp.age.day": { uk: "До доби", ru: "До суток", en: "Under a day" },
  "opsp.age.week": { uk: "1–7 днів", ru: "1–7 дней", en: "1–7 days" },
  "opsp.age.month": { uk: "7–30 днів", ru: "7–30 дней", en: "7–30 days" },
  "opsp.age.older": { uk: "Понад 30 днів", ru: "Больше 30 дней", en: "Over 30 days" },
  "opsp.sess.list": { uk: "Активні сесії", ru: "Активные сессии", en: "Active sessions" },
  "opsp.audit.section": { uk: "Записи за відбором", ru: "Записи по отбору", en: "Entries for this filter" },
  "opsp.audit.chart": { uk: "Записи журналу в часі", ru: "Записи журнала во времени", en: "Journal entries over time" },
  "opsp.audit.chartHint": { uk: "Той самий відбір, що в таблиці нижче.", ru: "Тот же отбор, что в таблице ниже.", en: "The same filter as the table below." },
  "opsp.audit.stepDay": { uk: "за днями", ru: "по дням", en: "by day" },
  "opsp.audit.stepWeek": { uk: "за тижнями, з понеділка", ru: "по неделям, с понедельника", en: "by week, from Monday" },
  "opsp.audit.stepMonth": { uk: "за місяцями", ru: "по месяцам", en: "by month" },
  "opsp.series.ok": { uk: "Успішно", ru: "Успешно", en: "Succeeded" },
  "opsp.series.refused": { uk: "Відмова або збій", ru: "Отказ или сбой", en: "Denied or failed" },
  "opsp.susp.overviewHint": {
    uk: "Усі спрацювання, без відбору зі списку нижче.",
    ru: "Все срабатывания, без отбора из списка ниже.",
    en: "All alerts, ignoring the filter of the list below.",
  },
  "opsp.susp.byRule": { uk: "Спрацювання за правилами", ru: "Срабатывания по правилам", en: "Alerts by rule" },
  "opsp.susp.byRuleHint": {
    uk: "За весь час; жирним — правила з нерозібраними.",
    ru: "За всё время; жирным — правила с неразобранными.",
    en: "All time; rules with unreviewed alerts are in bold.",
  },
  "opsp.susp.newOf": { uk: "нових", ru: "новых", en: "new" },
  "opsp.susp.byDay": { uk: "Спрацювання за днями", ru: "Срабатывания по дням", en: "Alerts by day" },
  "opsp.susp.byDayHint": {
    uk: "{n} днів, за кінцем серії: коли сталося, а не коли помітила перевірка.",
    ru: "{n} дней, по концу серии: когда случилось, а не когда заметила проверка.",
    en: "{n} days, by the end of the series: when it happened, not when the check noticed.",
  },
  "opsp.series.open": { uk: "Нерозібрані", ru: "Неразобранные", en: "Unreviewed" },
  "opsp.series.resolved": { uk: "Розібрані", ru: "Разобранные", en: "Reviewed" },
  "opsp.susp.list": { uk: "Спрацювання", ru: "Срабатывания", en: "Alerts" },
  "opsp.grants.states": { uk: "Усі винятки за станом", ru: "Все исключения по состоянию", en: "All exceptions by status" },
  "opsp.grants.statesHint": {
    uk: "За весь час; відкликане лишається відкликаним, навіть якщо строк теж минув.",
    ru: "За всё время; отозванное остаётся отозванным, даже если срок тоже истёк.",
    en: "All time; a revoked exception stays revoked even if its term has also ended.",
  },
  "opsp.grant.active": { uk: "Діє зі строком", ru: "Действует со сроком", en: "Active, time-limited" },
  "opsp.grant.permanent": { uk: "Безстрокові", ru: "Бессрочные", en: "Permanent" },
  "opsp.grant.expired": { uk: "Строк минув", ru: "Срок истёк", en: "Expired" },
  "opsp.grant.revoked": { uk: "Відкликано", ru: "Отозвано", en: "Revoked" },
  "opsp.grants.byWeek": { uk: "Видано за тижнями", ru: "Выдано по неделям", en: "Granted by week" },
  "opsp.grants.byWeekHint": {
    uk: "{n} тижнів, тиждень — з понеділка; разом із відкликаними.",
    ru: "{n} недель, неделя — с понедельника; вместе с отозванными.",
    en: "{n} weeks, each starting on Monday; revoked ones included.",
  },
  "opsp.who.byDay": { uk: "Дії за днями", ru: "Действия по дням", en: "Actions by day" },
  "opsp.who.byDayHint": { uk: "Усі співробітники разом, за вибраний період.", ru: "Все сотрудники вместе, за выбранный период.", en: "All staff together, over the chosen period." },
  "opsp.who.byAction": { uk: "Що саме робили", ru: "Что именно делали", en: "What was done" },
  "opsp.who.byActionHint": {
    uk: "Дії з даними цієї людини — скільки разів.",
    ru: "Действия с данными этого человека — сколько раз.",
    en: "Actions on this person's data — how many times.",
  },
  "opsp.mfa.coverage": { uk: "Частка з другим фактором", ru: "Доля со вторым фактором", en: "Share with a second factor" },
  "opsp.mfa.coverageHint": {
    uk: "Серед облікових записів, що діють, — за причиною вимоги; вимкнені не рахуються.",
    ru: "Среди действующих учётных записей — по причине требования; выключенные не считаются.",
    en: "Among active accounts, by the reason for the requirement; disabled ones are not counted.",
  },

  "ppl.listsLabel": { uk: "Списки співробітників", ru: "Списки сотрудников", en: "Staff lists" },
  "ppl.searchStaff": { uk: "Пошук за ПІБ, логіном або телефоном", ru: "Поиск по ФИО, логину или телефону", en: "Search by name, login or phone" },
  "ppl.department": { uk: "Відділення", ru: "Отделение", en: "Department" },
  "ppl.allDepartments": { uk: "Усі відділення", ru: "Все отделения", en: "All departments" },
  "ppl.allPositions": { uk: "Усі посади", ru: "Все должности", en: "All positions" },
  "ppl.noDepartment": { uk: "Без відділення", ru: "Без отделения", en: "No department" },
  "ppl.noPosition": { uk: "Без посади", ru: "Без должности", en: "No position" },
  "ppl.sort": { uk: "Сортування", ru: "Сортировка", en: "Sort" },
  "ppl.sortByName": { uk: "Сортування: за ім’ям", ru: "Сортировка: по имени", en: "Sort: by name" },
  "ppl.sortByDepartment": { uk: "Сортування: за відділенням", ru: "Сортировка: по отделению", en: "Sort: by department" },
  "ppl.sortByPosition": { uk: "Сортування: за посадою", ru: "Сортировка: по должности", en: "Sort: by position" },

  /* ─────────── аналитика методики ─────────── */
  "an.version": { uk: "Версія", ru: "Версия", en: "Version" },
  "an.of": { uk: "з", ru: "из", en: "of" },
  "an.allHistory": { uk: "Уся історія", ru: "Вся история", en: "Full history" },
  "an.tabQuestions": { uk: "Питання", ru: "Вопросы", en: "Questions" },
  "an.tabScales": { uk: "Шкали", ru: "Шкалы", en: "Scales" },
  "an.tabQuality": { uk: "Якість", ru: "Качество", en: "Quality" },
  "an.tabResponses": { uk: "Проходження", ru: "Прохождения", en: "Completions" },
  "an.started": { uk: "почато", ru: "начато", en: "started" },
  "an.completion": { uk: "Доходимість", ru: "Доходимость", en: "Completion rate" },
  "an.abandoned": { uk: "покинуто", ru: "брошено", en: "abandoned" },
  "an.dropOff": { uk: "Де губляться респонденти", ru: "Где теряются респонденты", en: "Where respondents drop off" },
  "an.exportsHint": {
    uk: "Вивантаження вивозить персональні дані за межі системи і записується в журнал доступу",
    ru: "Выгрузка увозит персональные данные за пределы системы и записывается в журнал доступа",
    en: "An export takes personal data outside the system and is recorded in the access log",
  },
  "an.profile": { uk: "Профіль даних", ru: "Профиль данных", en: "Data profile" },
  "an.dataCsv": { uk: "Дані, CSV", ru: "Данные, CSV", en: "Data, CSV" },
  /*
   * «Codebook» и «Long-format» стояли на кнопках как есть.
   *
   * Соблазн оставить был: оба слова — термины из статистических пакетов, и
   * тот, кто выгружает данные в SPSS, узнаёт их. Но кнопки живут в одном
   * ряду с «Матриця для SPSS» и «Синтаксис .sps», уже переведёнными, и
   * получался ряд наполовину по-украински. Термин, который нужен для
   * сверки с руководством к пакету, остаётся в подсказке, а не на кнопке.
   */
  "an.codebook": { uk: "Кодувальна книга", ru: "Кодировочная книга", en: "Codebook" },
  "an.codebookHint": {
    uk: "Опис усіх змінних вивантаження: назва, тип, припустимі значення (codebook)",
    ru: "Описание всех переменных выгрузки: название, тип, допустимые значения (codebook)",
    en: "Description of all export variables: name, type, allowed values (codebook)",
  },
  "an.long": { uk: "Довгий формат", ru: "Длинный формат", en: "Long format" },
  "an.longHint": {
    uk: "Один рядок на пару «проходження × шкала» — формат R і pandas (long-format)",
    ru: "Одна строка на пару «прохождение × шкала» — формат R и pandas (long-format)",
    en: "One row per “completion × scale” pair — the format for R and pandas (long-format)",
  },
  "an.keys": { uk: "Ключі для звірки", ru: "Ключи для сверки", en: "Scoring keys for verification" },
  "an.blank": { uk: "Паперовий бланк", ru: "Бумажный бланк", en: "Paper answer sheet" },
  "an.edit": { uk: "Правити методику", ru: "Править методику", en: "Edit instrument" },
  "an.administer": { uk: "Заповнити за пацієнта", ru: "Заполнить за пациента", en: "Fill in for the patient" },
  "an.compareVersions": { uk: "Порівняти версії", ru: "Сравнить версии", en: "Compare versions" },
  "an.pickDifferent": { uk: "Оберіть різні версії", ru: "Выберите разные версии", en: "Select different versions" },
  "an.comparable": { uk: "Бали версій зіставні", ru: "Баллы версий сопоставимы", en: "Version scores are comparable" },
  "an.notComparable": { uk: "Бали напряму не зіставні", ru: "Баллы напрямую не сопоставимы", en: "Scores are not directly comparable" },
  "an.noScoringChange": {
    uk: "Зміни не зачіпають підрахунок: заміри різних версій можна об’єднувати",
    ru: "Изменения не затрагивают подсчёт: замеры разных версий можно объединять",
    en: "The changes do not affect scoring: measurements from different versions can be combined",
  },
  "an.sameContent": { uk: "Вміст версій збігається", ru: "Содержимое версий совпадает", en: "The versions have identical content" },
  "an.item": { uk: "Пункт", ru: "Пункт", en: "Item" },
  "an.scaleWord": { uk: "Шкала", ru: "Шкала", en: "Scale" },
  "an.added": { uk: "додано", ru: "добавлена", en: "added" },
  "an.removed": { uk: "прибрано", ru: "убрана", en: "removed" },
  "an.changed": { uk: "змінено", ru: "изменена", en: "changed" },
  "an.time": { uk: "Час", ru: "Время", en: "Time" },
  "an.scores": { uk: "Бали", ru: "Баллы", en: "Scores" },
  "an.variance": { uk: "Дисперсія", ru: "Дисперсия", en: "Variance" },
  /* доля менявших ответ — не путать с an.changed («версия изменена») */
  "an.fast": { uk: "Швидких", ru: "Быстрых", en: "Fast" },
  "an.versionHint": {
    uk: "Проходження різних версій не змішуються — питання в них різні. Відкрито версію з найбільшим обсягом даних.",
    ru: "Прохождения разных версий не смешиваются — вопросы у них разные. Открыта версия с наибольшим объёмом данных.",
    en: "Completions of different versions are not mixed — their questions differ. The version with the most data is open.",
  },
  /* ─────────── назначения: батареи, расписания, приглашения, киоск ─────────── */
  "bat.archived": { uk: "в архіві", ru: "в архиве", en: "archived" },
  "bat.strictOrder": { uk: "Суворий порядок", ru: "Строгий порядок", en: "Strict order" },
  "bat.progress": { uk: "Прогрес", ru: "Прогресс", en: "Progress" },
  "f.name": { uk: "Назва", ru: "Название", en: "Name" },
  "f.description": { uk: "Опис", ru: "Описание", en: "Description" },
  "f.group": { uk: "Група", ru: "Группа", en: "Group" },
  "f.note": { uk: "Примітка", ru: "Примечание", en: "Note" },
  "f.subject": { uk: "Обстежуваний", ru: "Обследуемый", en: "Respondent" },
  "f.assigned": { uk: "Призначено", ru: "Назначено", en: "Assigned" },
  "f.assignments": { uk: "Призначення", ru: "Назначения", en: "Assignments" },
  "f.hide": { uk: "Сховати", ru: "Скрыть", en: "Hide" },
  "f.edit": { uk: "Правити", ru: "Править", en: "Edit" },
  "bat.nobodyLeft": { uk: "Нікого не знайдено — або набір вже призначено", ru: "Никого не найдено — либо набор уже назначен", en: "No one found — or the battery has already been assigned" },
  "bat.notAssigned": { uk: "Набір поки нікому не призначено", ru: "Набор пока никому не назначен", en: "The battery has not been assigned to anyone yet" },
  "bat.emptyAddBelow": { uk: "Поки порожньо — додайте методики нижче", ru: "Пока пусто — добавьте методики ниже", en: "Empty for now — add instruments below" },
  "inv.ready": { uk: "Запрошення готове", ru: "Приглашение готово", en: "Invitation ready" },
  "inv.batteryOnRegister": { uk: "Набор (призначиться при реєстрації)", ru: "Набор (назначится при регистрации)", en: "Battery (assigned on registration)" },
  "inv.surveyOnRegister": { uk: "Методика (призначиться при реєстрації)", ru: "Методика (назначится при регистрации)", en: "Instrument (assigned on registration)" },
  "inv.noSurveyHint": { uk: "Без методики", ru: "Без методики", en: "No instrument" },
  "inv.specialist": { uk: "Закріпити за лікарем", ru: "Закрепить за врачом", en: "Attach to clinician" },
  "inv.specialistMe": { uk: "За мною", ru: "За мной", en: "To me" },
  "inv.bound": { uk: "Прив’язка", ru: "Привязка", en: "Linked to" },
  "inv.noteStaffOnly": { uk: "Замітка (видно лише персоналу)", ru: "Заметка (видна только персоналу)", en: "Note (visible to staff only)" },
  "inv.manualCode": { uk: "Код для ручного введення", ru: "Код для ручного ввода", en: "Code for manual entry" },
  "inv.printQr": { uk: "Друк з QR", ru: "Печать с QR", en: "Print with QR" },
  "inv.entries": { uk: "Входів", ru: "Входов", en: "Sign-ins" },
  "inv.createdBy": { uk: "Створив", ru: "Создал", en: "Created by" },

  /* ─────────── администрирование, журнал, доступ ─────────── */
  "adm.newGroup": { uk: "Нова група", ru: "Новая группа", en: "New group" },
  "adm.admins": { uk: "Адміністратори", ru: "Администраторы", en: "Administrators" },
  "adm.addAdmin": { uk: "Додати адміністратора", ru: "Добавить администратора", en: "Add administrator" },
  "adm.delete": { uk: "Видалити", ru: "Удалить", en: "Delete" },
  "adm.newUser": { uk: "Новий обліковий запис", ru: "Новая учётная запись", en: "New account" },
  "adm.role": { uk: "Роль", ru: "Роль", en: "Role" },

  "aud.title": { uk: "Журнал доступу", ru: "Журнал доступа", en: "Access log" },
  "aud.when": { uk: "Коли", ru: "Когда", en: "When" },
  "aud.who": { uk: "Хто", ru: "Кто", en: "Who" },
  "aud.details": { uk: "Подробиці", ru: "Подробности", en: "Details" },

  "acc.title": { uk: "Доступ до методики", ru: "Доступ к методике", en: "Instrument access" },
  "acc.granted": { uk: "Кому призначено", ru: "Кому назначено", en: "Assigned to" },
  "acc.grant": { uk: "Призначити", ru: "Назначить", en: "Assign" },
  "acc.revoke": { uk: "Зняти", ru: "Снять", en: "Revoke" },
  "acc.publicHint": {
    uk: "Методика загальнодоступна — її бачать усі пацієнти, і персональні призначення ні на що не впливають",
    ru: "Методика общедоступна — её видят все пациенты, и персональные назначения ни на что не влияют",
    en: "The instrument is public — all patients can see it, and individual assignments have no effect",
  },

  "adn.whoIsTested": { uk: "Кого обстежуємо", ru: "Кого обследуем", en: "Who is being assessed" },
  "adn.pickPatient": { uk: "— оберіть пацієнта —", ru: "— выберите пациента —", en: "— select a patient —" },
  "adn.saved": { uk: "Обстеження збережено", ru: "Обследование сохранено", en: "Assessment saved" },
  "adn.byClinician": { uk: "Заповнення фахівцем", ru: "Заполнение специалистом", en: "Completed by specialist" },
  "adn.items": { uk: "пунктів", ru: "пунктов", en: "items" },

  /* очередь работы: подробности строит клиент, сервер отдаёт факты */
  "work.daysAgo": { uk: "дн. тому", ru: "дн. назад", en: "d ago" },
  "work.daysOverdue": { uk: "дн. прострочення", ru: "дн. просрочки", en: "d overdue" },
  "work.daysNoMove": { uk: "дн. без руху", ru: "дн. без движения", en: "d without progress" },
  "work.dueExpired": { uk: "Строк вийшов", ru: "Срок вышел", en: "Deadline passed" },
  "work.refNotAccepted": { uk: "Направлення не прийнято", ru: "Направление не принято", en: "Referral not accepted" },
  "work.refNotDone": { uk: "Направлення не завершено", ru: "Направление не завершено", en: "Referral not completed" },
  "work.followupMissed": { uk: "Повтор за протоколом не зроблено", ru: "Повтор по протоколу не сделан", en: "Protocol follow-up not done" },


  "inv.title": { uk: "Запрошення", ru: "Приглашения", en: "Invitations" },
  "inv.new": { uk: "Створити запрошення", ru: "Создать приглашение", en: "Create invitation" },
  "inv.none": { uk: "Запрошень немає", ru: "Приглашений нет", en: "No invitations" },
  "inv.revoke": { uk: "Відкликати", ru: "Отозвать", en: "Revoke" },
  "inv.link": { uk: "Посилання", ru: "Ссылка", en: "Link" },
  "inv.uses": { uk: "Використань", ru: "Использований", en: "Uses" },
  "inv.expires": { uk: "Діє до", ru: "Действует до", en: "Valid until" },



  /* ─────────── степени выраженности ───────────
   * Видны на каждом экране с результатом: в таблицах, на графиках, в отчёте.
   * Держать их в отдельном файле консоли значило бы иметь два словаря,
   * которые однажды разойдутся.
   */
  "severity.none": { uk: "Норма", ru: "Норма", en: "Normal" },
  "severity.mild": { uk: "Легка", ru: "Лёгкая", en: "Mild" },
  "severity.moderate": { uk: "Помірна", ru: "Умеренная", en: "Moderate" },
  "severity.severe": { uk: "Виражена", ru: "Выраженная", en: "Severe" },


  /* горячие клавиши разбора */
  "hotkey.next": { uk: "наступний випадок", ru: "следующий случай", en: "next case" },
  "hotkey.take": { uk: "взяти на себе", ru: "взять на себя", en: "take ownership" },
  "hotkey.confirm": { uk: "підтвердити ризик", ru: "подтвердить риск", en: "confirm risk" },
  "hotkey.followup": { uk: "спостереження", ru: "наблюдение", en: "follow-up" },
  "hotkey.reject": { uk: "не підтверджено", ru: "не подтверждён", en: "not confirmed" },
  "hotkey.search": { uk: "пошук", ru: "поиск", en: "search" },

  /* аналитика методики */
  "an.fileExported": { uk: "Файл вивантажено", ru: "Файл выгружен", en: "File exported" },
  "an.matrixExported": { uk: "Матрицю вивантажено", ru: "Матрица выгружена", en: "Matrix exported" },
  "an.syntaxExported": { uk: "Синтаксис вивантажено", ru: "Синтаксис выгружен", en: "Syntax exported" },
  "an.anon": { uk: "анонім", ru: "аноним", en: "anonymous" },
  "an.responses": { uk: "Проходжень", ru: "Прохождений", en: "Completions" },
  "an.spssMatrix": { uk: "Матриця для SPSS", ru: "Матрица для SPSS", en: "SPSS matrix" },
  "an.spssSyntax": { uk: "Синтаксис .sps", ru: "Синтаксис .sps", en: ".sps syntax" },
  "an.localNorms": { uk: "Локальні норми", ru: "Локальные нормы", en: "Local norms" },
  "an.assignments": { uk: "Призначення пацієнтам", ru: "Назначения пациентам", en: "Patient assignments" },
  "an.timePerQuestion": { uk: "Час відповіді за питаннями", ru: "Время ответа по вопросам", en: "Response time by question" },
  "an.spreadNotMean": {
    uk: "Лінія — медіана за пунктом, затінення — міжквартильний розмах: половина людей уклалася в нього",
    ru: "Линия — медиана по пункту, затенение — межквартильный размах: половина людей уложилась в него",
    en: "Line — median per item, shading — interquartile range: half of the people fell within it",
  },
  "an.medianTime": { uk: "Медіана часу", ru: "Медиана времени", en: "Median time" },
  "an.link": { uk: "Зв’язок", ru: "Связь", en: "Item–total r" },
  "an.noReliability": { uk: "Надійність не рахується: менше двох пунктів або немає розкиду відповідей", ru: "Надёжность не считается: меньше двух пунктов или нет разброса ответов", en: "Reliability is not calculated: fewer than two items or no variation in responses" },
  "an.carelessTitle": { uk: "Ознаки недбалого заповнення", ru: "Признаки небрежного заполнения", en: "Signs of careless responding" },
  "an.respondent": { uk: "Респондент", ru: "Респондент", en: "Respondent" },
  "an.streak": { uk: "Серія", ru: "Серия", en: "Streak" },
  "an.reasons": { uk: "Причини", ru: "Причины", en: "Reasons" },
  "an.anonCap": { uk: "Анонім", ru: "Аноним", en: "Anonymous" },
  "an.noSuspicious": { uk: "Підозрілих проходжень не знайдено", ru: "Подозрительных прохождений не найдено", en: "No suspicious completions found" },
  "an.conclusion": { uk: "Висновок", ru: "Заключение", en: "Conclusion" },
  "an.print": { uk: "Друк", ru: "Печать", en: "Print" },

  /* админка, доступ, панели анализа */
  "adm.groupsTitle": { uk: "Групи методик", ru: "Группы методик", en: "Instrument groups" },
  "adm.groupsSub": { uk: "Група — одиниця розмежування доступу: адміністратор бачить лише методики своїх груп", ru: "Группа — единица разграничения доступа: администратор видит только методики своих групп", en: "Group — the unit of access control: an administrator sees only the instruments of their own groups" },
  "adm.groupExample": { uk: "Приймальне відділення", ru: "Приёмное отделение", en: "Admissions department" },
  "adm.groupDeleted": { uk: "Групу видалено", ru: "Группа удалена", en: "Group deleted" },
  "adm.noAdmins": { uk: "Нікого не призначено — групою керує лише суперадміністратор", ru: "Никто не назначен — группой управляет только суперадмин", en: "Nobody is assigned — the group is managed by the superadministrator only" },
  "adm.fullName": { uk: "ПІБ", ru: "ФИО", en: "Full name" },
  "adm.assignedAt": { uk: "Призначено", ru: "Назначен", en: "Assigned" },
  "adm.roleSuper": { uk: "Суперадміністратор", ru: "Суперадминистратор", en: "Superadministrator" },
  "adm.roleAdmin": { uk: "Адміністратор групи", ru: "Администратор группы", en: "Group administrator" },
  "adm.rolePatient": { uk: "Пацієнт", ru: "Пациент", en: "Patient" },
  "adm.accountsSub": { uk: "Єдиний спосіб видати доступ співробітника: самостійна реєстрація завжди створює пацієнта", ru: "Единственный способ выдать доступ сотрудника: самостоятельная регистрация всегда создаёт пациента", en: "The only way to grant staff access: self-registration always creates a patient" },
  "adm.password8": { uk: "Пароль (від 8 знаків)", ru: "Пароль (от 8 знаков)", en: "Password (at least 8 characters)" },
  "adm.createFailed": { uk: "Не вдалося створити", ru: "Не удалось создать", en: "Could not create" },
  "adm.searchPlaceholder": { uk: "Пошук за ПІБ або email", ru: "Поиск по ФИО или email", en: "Search by full name or email" },
  "adm.createdAt": { uk: "Створено", ru: "Создан", en: "Created" },
  "adm.male": { uk: "чол.", ru: "муж.", en: "male" },
  "adm.female": { uk: "жін.", ru: "жен.", en: "female" },
  "adm.consentVersion": { uk: "версія", ru: "версия", en: "version" },
  "adm.consentUnset": { uk: "не налаштовано", ru: "не настроено", en: "not configured" },
  "adm.consentHint": {
    uk: "Показується пацієнтові після входу. Збереження створює нову версію — усі пацієнти підтвердять згоду наново, і в журналі залишиться, яку редакцію читав кожен.",
    ru: "Показывается пациенту после входа. Сохранение создаёт новую версию — все пациенты подтвердят согласие заново, и в журнале останется, какую редакцию читал каждый.",
    en: "Shown to the patient after sign-in. Saving creates a new version — all patients will confirm consent again, and the log will record which version each of them read.",
  },
  "adm.consentSave": { uk: "Зберегти новою версією", ru: "Сохранить новой версией", en: "Save as new version" },
  "adm.consentTitle": { uk: "Інформована згода", ru: "Информированное согласие", en: "Informed consent" },
  "adm.inUkrainian": { uk: "Українською", ru: "Українською", en: "Українською" },
  "adm.inRussian": { uk: "По-русски", ru: "По-русски", en: "По-русски" },
  /*
   * Текст согласия по-английски — необязательный третий.
   *
   * Согласие — не методика: норм у него нет, и довод, по которому у методик
   * нет английского текста, к нему не относится. Зато относится другой:
   * информированное согласие, которое человек не может прочесть, — не
   * информированное. Не заполнен — человеку с английским интерфейсом
   * покажут украинский, как и прочее содержимое.
   */
  "adm.inEnglish": { uk: "In English (необов’язково)", ru: "In English (необязательно)", en: "In English (optional)" },
  "adm.consentSaved": { uk: "Нову версію згоди збережено — пацієнти підтвердять її під час наступного входу", ru: "Новая версия согласия сохранена — пациенты подтвердят её при следующем входе", en: "New consent version saved — patients will confirm it at their next sign-in" },
  "acc.grantFailed": { uk: "Не вдалося призначити", ru: "Не удалось назначить", en: "Could not assign" },
  "acc.visibilityRestricted": { uk: "Видимість: лише за призначенням", ru: "Видимость: только по назначению", en: "Visibility: by assignment only" },
  "acc.visibilityPublic": { uk: "Видимість: загальна", ru: "Видимость: общая", en: "Visibility: public" },
  "acc.grantTo": { uk: "Призначити пацієнтові", ru: "Назначить пациенту", en: "Assign to patient" },
  "acc.grantHint": { uk: "Пацієнт побачить методику в мобільному застосунку одразу після призначення", ru: "Пациент увидит методику в мобильном приложении сразу после назначения", en: "The patient will see the instrument in the mobile app immediately after assignment" },
  "acc.patient": { uk: "Пацієнт", ru: "Пациент", en: "Patient" },
  "acc.comment": { uk: "Коментар", ru: "Комментарий", en: "Comment" },
  "acc.commentExample": { uk: "Наприклад: призначено на прийомі", ru: "Например: назначено на приёме", en: "For example: assigned at an appointment" },
  "acc.until": { uk: "Діє до (необов’язково)", ru: "Действует до (необязательно)", en: "Valid until (optional)" },
  "acc.nobody": { uk: "Поки нікому не призначено", ru: "Пока никому не назначено", en: "Not assigned to anyone yet" },
  "acc.grantedBy": { uk: "Призначив", ru: "Назначил", en: "Assigned by" },
  "acc.when": { uk: "Коли", ru: "Когда", en: "When" },
  "acc.passed": { uk: "Пройдено", ru: "Пройдено", en: "Completed" },
  "acc.forever": { uk: "безстроково", ru: "бессрочно", en: "no expiry" },
  "acc.no": { uk: "ні", ru: "нет", en: "no" },
  "dq.men": { uk: "чоловіки", ru: "мужчины", en: "men" },
  "dq.women": { uk: "жінки", ru: "женщины", en: "women" },
  "dq.groupsSmallerThan": { uk: "групи менші за", ru: "группы меньше", en: "groups smaller than" },
  "dq.areHidden": { uk: "приховано", ru: "скрыты", en: "are hidden" },
  "dq.reaches": { uk: "доходить", ru: "доходит", en: "completion" },
  "dq.underrepresented": {
    uk: "Ця група недопредставлена в нормах — їхні бали пораховано за тими, хто дійшов.",
    ru: "Эта группа недопредставлена в нормах — их баллы посчитаны по тем, кто дошёл.",
    en: "This group is underrepresented in the norms — their scores are calculated from those who finished.",
  },
  "dq.completionTitle": { uk: "Доходимість за групами", ru: "Доходимость по группам", en: "Completion rate by group" },
  "dq.sex": { uk: "Стать", ru: "Пол", en: "Sex" },
  "dq.age": { uk: "Вік", ru: "Возраст", en: "Age" },
  "dq.started": { uk: "Почали", ru: "Начали", en: "Started" },
  "dq.finished": { uk: "Завершили", ru: "Завершили", en: "Finished" },
  "dq.completion": { uk: "Доходимість", ru: "Доходимость", en: "Completion rate" },
  "dq.skippedItems": { uk: "Пропущено пунктів", ru: "Пропущено пунктов", en: "Items skipped" },
  "dq.driftTitle": { uk: "Дрейф вибірки", ru: "Дрейф выборки", en: "Sample drift" },
  "dq.scale": { uk: "Шкала", ru: "Шкала", en: "Scale" },
  "dq.month": { uk: "Місяць", ru: "Месяц", en: "Month" },
  "dq.verdict": { uk: "Висновок", ru: "Вывод", en: "Conclusion" },
  "dq.repeatTitle": { uk: "Повторюваність вимірювання", ru: "Повторяемость измерения", en: "Measurement repeatability" },
  "dq.pairs": { uk: "Пар", ru: "Пар", en: "Pairs" },

  /* конструктор и печать ключей */
  "cs.code": { uk: "Код", ru: "Код", en: "Code" },
  "cs.role": { uk: "Роль", ru: "Роль", en: "Role" },
  "cs.clinical": { uk: "Змістовна", ru: "Содержательная", en: "Clinical" },
  "cs.validity": { uk: "Достовірності", ru: "Достоверности", en: "Validity" },
  "cs.normalization": { uk: "Нормування", ru: "Нормирование", en: "Normalization" },
  "cs.raw": { uk: "Сирий бал", ru: "Сырой балл", en: "Raw score" },
  "cs.ratio": { uk: "Частка від максимуму", ru: "Доля от максимума", en: "Share of maximum" },
  "cs.sten": { uk: "Стени", ru: "Стены", en: "Stens" },
  "cs.denominator": { uk: "Знаменник", ru: "Знаменатель", en: "Denominator" },
  "cs.scaleTitle": { uk: "Назва шкали", ru: "Название шкалы", en: "Scale name" },
  "cs.threshold": { uk: "Поріг", ru: "Порог", en: "Threshold" },
  "cs.violated": { uk: "Порушується", ru: "Нарушается", en: "Violated when" },
  "cs.bands": { uk: "Інтерпретаційні норми", ru: "Интерпретационные нормы", en: "Interpretation bands" },
  "cs.severity": { uk: "Вираженість", ru: "Выраженность", en: "Severity" },
  "cs.grade": { uk: "Оцінка", ru: "Оценка", en: "Grade" },
  "cs.cascade": { uk: "Каскад", ru: "Каскад", en: "Cascade" },
  "cs.repeatDays": { uk: "Повтори, дн.", ru: "Повторы, дн.", en: "Repeats, days" },
  "cs.sevNormal": { uk: "Норма", ru: "Норма", en: "Normal" },
  "cs.sevMild": { uk: "Легка", ru: "Лёгкая", en: "Mild" },
  "cs.sevModerate": { uk: "Помірна", ru: "Умеренная", en: "Moderate" },
  "cs.sevSevere": { uk: "Виражена", ru: "Выраженная", en: "Severe" },
  "cs.cascadeHint": { uk: "Потрапляння в цю смугу призначить набір", ru: "Попадание в эту полосу назначит набор", en: "Landing in this band will assign a battery" },
  "cs.repeatHint": { uk: "Повтори цієї ж методики через N днів", ru: "Повторы этой же методики через N дней", en: "Repeat this same instrument after N days" },
  "cb.instructions": { uk: "Інструкція перед проходженням", ru: "Инструкция перед прохождением", en: "Instructions before starting" },
  "cb.safetyPlan": { uk: "Негайні дії при критичній відповіді (safety-план)", ru: "Немедленные действия при критическом ответе (safety-план)", en: "Immediate actions on a critical answer (safety plan)" },
  "cb.group": { uk: "Група", ru: "Группа", en: "Group" },
  "cb.whoFills": { uk: "Хто заповнює", ru: "Кто заполняет", en: "Who completes it" },
  "cb.selfAdmin": { uk: "Респондент сам", ru: "Респондент сам", en: "The respondent" },
  "cb.clinicianAdmin": { uk: "Фахівець за респондента", ru: "Специалист за респондента", en: "Specialist on behalf of the respondent" },
  "cb.visibility": { uk: "Видимість", ru: "Видимость", en: "Visibility" },
  "cb.allPatients": { uk: "Усім пацієнтам", ru: "Всем пациентам", en: "All patients" },
  "cb.byGrantOnly": { uk: "Лише за призначенням", ru: "Только по назначению", en: "By assignment only" },
  "cb.scoring": { uk: "Рахувати бали за шкалами", ru: "Считать баллы по шкалам", en: "Calculate scale scores" },
  "cb.showProgress": { uk: "Показувати прогрес", ru: "Показывать прогресс", en: "Show progress" },
  "cb.allowBack": { uk: "Дозволити повернення назад", ru: "Разрешить возврат назад", en: "Allow going back" },
  "cb.allowRetake": { uk: "Дозволити повторні проходження", ru: "Разрешить повторные прохождения", en: "Allow repeat completions" },
  "cb.randomize": { uk: "Перемішувати питання", ru: "Перемешивать вопросы", en: "Shuffle questions" },
  "cb.anonymous": { uk: "Анонімно", ru: "Анонимно", en: "Anonymous" },
  "cb.showDynamics": { uk: "Пацієнт бачить свою динаміку", ru: "Пациент видит свою динамику", en: "Patient sees their own dynamics" },
  "cb.timeLimit": { uk: "Ліміт часу, хвилин", ru: "Лимит времени, минут", en: "Time limit, minutes" },
  "cb.escalation": { uk: "Ескалація тривоги, хвилин", ru: "Эскалация тревоги, минут", en: "Alert escalation, minutes" },
  "cb.noEscalation": { uk: "без ескалації", ru: "без эскалации", en: "no escalation" },
  "kp.title": { uk: "Ключі методики", ru: "Ключи методики", en: "Instrument scoring keys" },
  "kp.hideItems": { uk: "Сховати пункти", ru: "Скрыть пункты", en: "Hide items" },
  "kp.showItems": { uk: "Показати пункти", ru: "Показать пункты", en: "Show items" },
  "kp.validityScale": { uk: "шкала достовірності", ru: "шкала достоверности", en: "validity scale" },
  "kp.clinicalScale": { uk: "змістовна", ru: "содержательная", en: "clinical" },
  "kp.rawScore": { uk: "сирий бал", ru: "сырой балл", en: "raw score" },
  "kp.ratio": { uk: "частка", ru: "доля", en: "share" },
  "kp.stens": { uk: "стени", ru: "стены", en: "stens" },
  "kp.answerYes": { uk: "Відповідь «Так»", ru: "Ответ «Да»", en: "Answer “Yes”" },
  "kp.answerNo": { uk: "Відповідь «Ні»", ru: "Ответ «Нет»", en: "Answer “No”" },
  "kp.byOptionScores": { uk: "За балами варіантів", ru: "По баллам вариантов", en: "By option scores" },
  "kp.corrections": { uk: "Поправки", ru: "Поправки", en: "Corrections" },
  "kp.norms": { uk: "Норми", ru: "Нормы", en: "Norms" },
  "kp.interpretation": { uk: "Інтерпретація", ru: "Интерпретация", en: "Interpretation" },
  "kp.items": { uk: "Пункти", ru: "Пункты", en: "Items" },
  "kp.itemsHint": { uk: "Номери — це те, на що посилаються ключі вище", ru: "Номера — это то, на что ссылаются ключи выше", en: "Numbers — these are what the keys above refer to" },

  /* списки методик, расписания, нормы, пациенты, конструктор */
  "cl.badJson": { uk: "Файл не є коректним JSON", ru: "Файл не является корректным JSON", en: "The file is not valid JSON" },
  "cl.imported": { uk: "Методику імпортовано чернеткою — звірте ключі перед публікацією", ru: "Методика импортирована черновиком — сверьте ключи перед публикацией", en: "Instrument imported as a draft — check the scoring keys before publishing" },
  "cl.importFailed": { uk: "Імпорт не вдався", ru: "Импорт не удался", en: "Import failed" },
  "cl.importFile": { uk: "Імпорт з файлу", ru: "Импорт из файла", en: "Import from file" },
  "cl.archiveConfirm": { uk: "Зняти методику з використання", ru: "Снять методику с использования", en: "Retire the instrument from use" },
  "cl.archive": { uk: "Зняти з використання", ru: "Снять с использования", en: "Retire from use" },
  "cl.archived": { uk: "Методику знято з використання", ru: "Методика снята с использования", en: "Instrument retired from use" },
  "cl.fileIssues": { uk: "Зауваження до файлу", ru: "Замечания к файлу", en: "Issues in the file" },
  "cl.name": { uk: "Назва", ru: "Название", en: "Name" },
  "cl.questions": { uk: "Питань", ru: "Вопросов", en: "Questions" },
  "cl.responses": { uk: "Проходжень", ru: "Прохождений", en: "Completions" },
  "sch.to": { uk: "по", ru: "по", en: "to" },
  "nm.men": { uk: "чоловіки", ru: "мужчины", en: "men" },
  "nm.women": { uk: "жінки", ru: "женщины", en: "women" },
  "nm.wholeSample": { uk: "уся вибірка", ru: "вся выборка", en: "whole sample" },
  "nm.title": { uk: "Локальні норми", ru: "Локальные нормы", en: "Local norms" },
  "nm.published": { uk: "Локальні норми опубліковано новою версією", ru: "Локальные нормы опубликованы новой версией", en: "Local norms published as a new version" },
  "nm.nothing": { uk: "Тут нічого перераховувати", ru: "Здесь нечего пересчитывать", en: "Nothing to recalculate here" },
  "nm.nothingHint": { uk: "Локальні норми застосовні лише до шкал з T-балами. У цієї методики таких немає — частки та стени нормуються інакше.", ru: "Локальные нормы применимы только к шкалам с T-баллами. У этой методики таких нет — доли и стены нормируются иначе.", en: "Local norms apply only to scales with T-scores. This instrument has none — shares and stens are normed differently." },
  "nm.group": { uk: "Група", ru: "Группа", en: "Group" },
  "nm.currentNorm": { uk: "Норма зараз (M / SD)", ru: "Норма сейчас (M / SD)", en: "Current norm (M / SD)" },
  "nm.source": { uk: "Джерело", ru: "Источник", en: "Source" },
  "nm.candidate": { uk: "Кандидат (M / SD)", ru: "Кандидат (M / SD)", en: "Candidate (M / SD)" },
  "nm.shift": { uk: "Зсув середнього T", ru: "Сдвиг среднего T", en: "Shift in mean T" },
  "nm.checkKeys": { uk: "Перевірити ключі після публікації", ru: "Проверить ключи после публикации", en: "Check scoring keys after publishing" },
  "nm.noCurves": { uk: "Кривих поки немає", ru: "Кривых пока нет", en: "No curves yet" },
  "nm.menCap": { uk: "Чоловіки", ru: "Мужчины", en: "Men" },
  "nm.womenCap": { uk: "Жінки", ru: "Женщины", en: "Women" },
  "nm.age": { uk: "Вік", ru: "Возраст", en: "Age" },
  "bp.yes": { uk: "Так", ru: "Так", en: "Yes" },
  "bp.no": { uk: "Ні", ru: "Нет", en: "No" },
  "bp.title": { uk: "Вставка пунктів з тексту", ru: "Вставка пунктов из текста", en: "Paste items from text" },
  "bp.lang": { uk: "Мова тексту, що вставляється", ru: "Язык вставляемого текста", en: "Language of the pasted text" },
  "bp.type": { uk: "Тип питань", ru: "Тип вопросов", en: "Question type" },
  "bp.yesNo": { uk: "Так / Ні", ru: "Да / Нет", en: "Yes / No" },
  "bp.single": { uk: "Одна відповідь (варіанти додасте потім)", ru: "Один ответ (варианты добавите после)", en: "Single answer (add options later)" },
  "pt.nobodyFound": { uk: "Нікого не знайдено", ru: "Никого не найдено", en: "No one found" },
  "pt.noCompleted": { uk: "Завершених проходжень немає", ru: "Завершённых прохождений нет", en: "No finished completions" },
  "pt.profileBySubscales": { uk: "Профіль за субшкалами", ru: "Профиль по субшкалам", en: "Subscale profile" },
  "pt.lastVsFirst": { uk: "Останній замір проти першого", ru: "Последний замер против первого", en: "Latest measurement vs. first" },
  "pt.lastMeasure": { uk: "Останній замір", ru: "Последний замер", en: "Latest measurement" },
  "pt.interpretation": { uk: "Інтерпретація", ru: "Интерпретация", en: "Interpretation" },
  "pt.rciTitle": { uk: "Достовірність зсуву", ru: "Достоверность сдвига", en: "Reliable change" },
  "pt.growth": { uk: "зростання", ru: "рост", en: "increase" },
  "pt.decline": { uk: "зниження", ru: "снижение", en: "decrease" },
  "pt.percentile": { uk: "Перцентиль", ru: "Перцентиль", en: "Percentile" },
  "pt.change": { uk: "зміна", ru: "изменение", en: "change" },
  "pt.rciUnknown": {
    uk: "достовірність не оцінити (мала вибірка або однопунктова шкала)",
    ru: "достоверность не оценить (мало выборки или одно-пунктовая шкала)",
    en: "reliable change cannot be assessed (small sample or single-item scale)",
  },
  "pt.rciAbove": { uk: "перевищує похибку вимірювання", ru: "превышает ошибку измерения", en: "exceeds measurement error" },
  "pt.rciWithin": { uk: "у межах похибки вимірювання", ru: "в пределах ошибки измерения", en: "within measurement error" },
  "pt.needSecond": { uk: "потрібен другий замір для динаміки", ru: "нужен второй замер для динамики", en: "a second measurement is needed for dynamics" },
  "pt.alpha": { uk: "альфа Кронбаха", ru: "альфа Кронбаха", en: "Cronbach's alpha" },
  "co.checkFailed": { uk: "Не вдалося перевірити", ru: "Не удалось проверить", en: "Could not check" },
  "co.versionNote": { uk: "Правка через конструктор", ru: "Правка через конструктор", en: "Edited in the builder" },
  "co.saveFailed": { uk: "Не вдалося зберегти", ru: "Не удалось сохранить", en: "Could not save" },
  "co.noTitleField": { uk: "У JSON немає поля title", ru: "В JSON нет поля title", en: "The JSON has no title field" },
  /*
   * Строки, которые до сих пор были зашиты в разметку.
   *
   * Найдены статической проверкой исходников (apps/web/test/strings.test.ts):
   * прежний смоук читал страницу и искал буквы, которых нет в украинском
   * алфавите, — надёжный признак, но слепой к словам вроде «Создать» и
   * «Отозвать», где таких букв нет. И покрывал он четырнадцать экранов из
   * тридцати трёх.
   */

  /* графики */
  "chart.noData": { uk: "Даних поки немає", ru: "Данных пока нет", en: "No data yet" },
  "chart.threshold": { uk: "поріг", ru: "порог", en: "threshold" },
  "chart.ordinary": { uk: "звичайні", ru: "обычные", en: "regular" },
  "chart.current": { uk: "Поточний", ru: "Текущий", en: "Current" },
  "chart.first": { uk: "Перший", ru: "Первый", en: "First" },
  "chart.radarHint": {
    uk: "Профіль будується від трьох субшкал",
    ru: "Профиль строится от трёх субшкал",
    en: "A profile needs at least three subscales",
  },
  "chart.boxHint": {
    uk: "Ящик — міжквартильний розмах, жирна риска — медіана, вуса — крайні значення",
    ru: "Ящик — межквартильный размах, жирная черта — медиана, усы — крайние значения",
    en: "Box — interquartile range, bold line — median, whiskers — extreme values",
  },
  "chart.heatHint": {
    uk: "Насиченість кодує величину; значення продубльовано числом",
    ru: "Насыщенность кодирует величину; значение продублировано числом",
    en: "Color intensity encodes magnitude; the value is also shown as a number",
  },
  "chart.funnelHint": {
    uk: "Звуження показує, на якому питанні припиняють проходження",
    ru: "Сужение показывает, на каком вопросе прекращают прохождение",
    en: "The narrowing shows at which question people stop the test",
  },
  /*
   * Подписи к подогнанной оси.
   *
   * Ось графиков строится по фактическому разбросу, а не по полной шкале
   * методики — иначе замеры прижимаются к низу поля и все графики выглядят
   * одинаково. Но подогнанная ось без подписи обманывает сильнее растянутой:
   * два балла на ней смотрятся как двадцать. Эти три строки — вторая
   * половина решения, и без них первую ставить нельзя.
   */
  "chart.axisCut": { uk: "Вісь не з нуля", ru: "Ось не с нуля", en: "Axis does not start at zero" },
  "chart.actualRange": { uk: "фактичний розкид", ru: "фактический разброс", en: "actual range" },
  "chart.fullScale": { uk: "повна шкала", ru: "полная шкала", en: "full scale" },

  /* возвраты и хлебные крошки */
  "back.toSurvey": { uk: "← До методики", ru: "← К методике", en: "← Back to instrument" },
  "back.toAnalytics": { uk: "← До аналітики", ru: "← К аналитике", en: "← Back to analytics" },
  "back.toSurveyAnalytics": { uk: "← Аналітика методики", ru: "← Аналитика методики", en: "← Instrument analytics" },

  /* пустые выборы */
  "sel.pickPatient": { uk: "виберіть пацієнта", ru: "выберите пациента", en: "select a patient" },
  "sel.pickStaff": { uk: "— виберіть співробітника —", ru: "— выберите сотрудника —", en: "— select a staff member —" },
  "sel.pick": { uk: "— виберіть —", ru: "— выберите —", en: "— select —" },
  "sel.noName": { uk: "· без імені", ru: "· без имени", en: "· no name" },

  /* мелкие пометки в списках */
  "mark.demo": { uk: "демо", ru: "демо", en: "demo" },
  "mark.retired": { uk: "знято з використання", ru: "снята с использования", en: "retired from use" },
  "mark.passed": { uk: "пройдена", ru: "пройдена", en: "completed" },
  "mark.outsideGroups": { uk: "поза групами", ru: "вне групп", en: "outside groups" },
  "mark.optional": { uk: "необов’язково", ru: "необязательно", en: "optional" },
  "mark.above": { uk: "Вище", ru: "Выше", en: "Move up" },
  "mark.below": { uk: "Нижче", ru: "Ниже", en: "Move down" },
  "mark.smallSample": { uk: "вибірка мала", ru: "выборка мала", en: "small sample" },
  "mark.fewData": { uk: "мало даних", ru: "мало данных", en: "too little data" },

  /* приглашения */
  "inv.noBattery": { uk: "без набору", ru: "без набора", en: "no battery" },
  "inv.noBatteryHint": {
    uk: "без набору — лише доступ до системи",
    ru: "без набора — только доступ в систему",
    en: "no battery — system access only",
  },
  "inv.unitToAccount": { uk: "проставиться обліковому запису", ru: "проставится аккаунту", en: "will be set on the account" },
  "inv.reasonExample": {
    uk: "наприклад, «надходження 3-ї роти»",
    ru: "например, «поступление 3-й роты»",
    en: "for example, “3rd company intake”",
  },

  /* аналитика методики */
  "an.draftsAutosaved": {
    uk: "чернетки з автозбереженням за останні 30 хвилин",
    ru: "черновики с автосохранением за последние 30 минут",
    en: "autosaved drafts from the last 30 minutes",
  },
  "an.exportFull": { uk: "повний (для клініки)", ru: "полный (для клиники)", en: "full (for the clinic)" },
  "an.exportDeid": {
    uk: "деідентифікований (для досліджень)",
    ru: "деидентифицированный (для исследований)",
    en: "de-identified (for research)",
  },
  "an.exportAnon": { uk: "анонімний (без суб’єктів)", ru: "анонимный (без субъектов)", en: "anonymous (no subjects)" },
  "an.alphaWithout": { uk: "альфа без нього", ru: "альфа без него", en: "alpha if item removed" },

  /* конструктор */
  "co.tScores": { uk: "T-бали", ru: "T-баллы", en: "T-scores" },
  "co.draftAutosaves": { uk: "чернетка зберігається сама", ru: "черновик сохраняется сам", en: "the draft saves automatically" },

  /* расписание */

  /* качество данных и DIF */
  "dq.psiHint": {
    uk: "Наскільки розподіл балів останнього місяця відрізняється від попередніх.",
    ru: "Насколько распределение баллов последнего месяца отличается от предыдущих.",
    en: "How much the score distribution of the last month differs from previous months.",
  },

  /* печатный бланк */
  "blank.sex": { uk: "Стать", ru: "Пол", en: "Sex" },
  "blank.date": { uk: "Дата", ru: "Дата", en: "Date" },

  /* оболочка */
  "ui.closePanel": { uk: "Закрити панель", ru: "Закрыть панель", en: "Close panel" },

  /* сетевые отказы клиента: видны на каждом экране, где что-то не доехало */
  "net.offline": { uk: "Немає зв’язку з сервером", ru: "Нет связи с сервером", en: "No connection to the server" },
  "net.failed": { uk: "Помилка", ru: "Ошибка", en: "Error" },
  "net.request": { uk: "запит", ru: "запрос", en: "request" },
  "net.loadFailed": { uk: "Не вдалося завантажити", ru: "Не удалось загрузить", en: "Could not load" },

  /* виды вопросов в конструкторе */
  "qt.yesno": { uk: "Так / Ні", ru: "Да / Нет", en: "Yes / No" },
  "qt.single": { uk: "Одна відповідь", ru: "Один ответ", en: "Single answer" },
  "qt.multiple": { uk: "Декілька", ru: "Несколько", en: "Multiple" },
  "qt.scale": { uk: "Шкала", ru: "Шкала", en: "Scale" },
  "qt.slider": { uk: "Повзунок", ru: "Ползунок", en: "Slider" },
  "qt.matrix": { uk: "Матриця", ru: "Матрица", en: "Matrix" },
  "qt.ranking": { uk: "Ранжування", ru: "Ранжирование", en: "Ranking" },
  "qt.number": { uk: "Число", ru: "Число", en: "Number" },
  "qt.text": { uk: "Рядок", ru: "Строка", en: "Single line" },
  "qt.longtext": { uk: "Текст", ru: "Текст", en: "Text" },
  "qt.date": { uk: "Дата", ru: "Дата", en: "Date" },
  "qt.info": { uk: "Інформація", ru: "Информация", en: "Information" },

  /* экран прав */
  "perm.title": { uk: "Права", ru: "Права", en: "Permissions" },
  "perm.sub": {
    uk: "Роль каже, що людина може. Особистий виняток — коли одній людині потрібно інакше",
    ru: "Роль говорит, что человек может. Личное исключение — когда одному человеку нужно иначе",
    en: "A role says what a person can do. A personal exception — for when one person needs something different",
  },
  "perm.roles": { uk: "Ролі", ru: "Роли", en: "Roles" },
  "perm.people": { uk: "людей", ru: "человек", en: "people" },
  "perm.builtin": { uk: "вбудована", ru: "встроенная", en: "built-in" },
  "perm.builtinHint": {
    uk: "Набір вбудованої ролі задається довідником і не змінюється вручну: правка мовчки відкотилася б при наступному запуску",
    ru: "Набор встроенной роли задаётся справочником и не меняется вручную: правка молча откатилась бы при следующем запуске",
    en: "A built-in role's set is defined by the reference catalog and cannot be changed manually: an edit would be silently rolled back on the next startup",
  },
  "perm.newRole": { uk: "Нова роль", ru: "Новая роль", en: "New role" },
  "perm.roleCode": { uk: "Код", ru: "Код", en: "Code" },
  "perm.roleCodeHint": {
    uk: "Латиницею, без пробілів — за ним роль впізнають у журналі",
    ru: "Латиницей, без пробелов — по нему роль узнают в журнале",
    en: "Latin letters, no spaces — the role is identified by it in the audit log",
  },
  "perm.roleTitle": { uk: "Назва", ru: "Название", en: "Name" },
  "perm.saveRole": { uk: "Зберегти набір", ru: "Сохранить набор", en: "Save set" },
  "perm.roleSaved": { uk: "Набір збережено", ru: "Набор сохранён", en: "Set saved" },
  "perm.person": { uk: "Людина", ru: "Человек", en: "Person" },
  "perm.pickPerson": { uk: "Виберіть співробітника", ru: "Выберите сотрудника", en: "Select a staff member" },
  "perm.effective": { uk: "Може зараз", ru: "Может сейчас", en: "Can do now" },
  "perm.fromRoles": { uk: "Ролі людини", ru: "Роли человека", en: "Person's roles" },
  "perm.exceptions": { uk: "Особисті винятки", ru: "Личные исключения", en: "Personal exceptions" },
  "perm.noExceptions": { uk: "Винятків немає", ru: "Исключений нет", en: "No exceptions" },
  "perm.addException": { uk: "Додати виняток", ru: "Добавить исключение", en: "Add exception" },
  "perm.grant": { uk: "Видати", ru: "Выдать", en: "Grant" },
  "perm.revoke": { uk: "Відібрати", ru: "Отнять", en: "Deny" },
  "perm.reason": { uk: "Причина — словами", ru: "Причина — словами", en: "Reason — in words" },
  "perm.reasonHint": {
    uk: "Її читають через рік, коли розбираються, чи був виняток осмисленим. Не менше десяти символів",
    ru: "Её читают через год, когда разбираются, было ли исключение осмысленным. Не меньше десяти символов",
    en: "It will be read a year later, when someone checks whether the exception made sense. At least ten characters",
  },
  "perm.days": { uk: "Строк, днів", ru: "Срок, дней", en: "Duration, days" },
  "perm.forever": { uk: "безстроково", ru: "бессрочно", en: "no expiry" },
  "perm.until": { uk: "до", ru: "до", en: "until" },
  "perm.cancel": { uk: "Відкликати", ru: "Отозвать", en: "Revoke" },
  "perm.cancelled": { uk: "Виняток відкликано", ru: "Исключение отозвано", en: "Exception revoked" },
  "perm.added": { uk: "Виняток додано", ru: "Исключение добавлено", en: "Exception added" },
  "perm.quick": { uk: "Найчастіші винятки", ru: "Самые частые исключения", en: "Most common exceptions" },
  "perm.quickHint": {
    uk: "Решту прав теж можна видати поштучно, але саме ці три випадки трапляються насправді: стажист веде прийоми, але не підписує; ключі підрахунку править наставник; чергування — тимчасове навантаження, а не властивість посади",
    ru: "Остальные права тоже можно выдать поштучно, но именно эти три случая случаются на деле: стажёр ведёт приёмы, но не подписывает; ключи подсчёта правит наставник; дежурство — временная нагрузка, а не свойство должности",
    en: "Other permissions can also be granted one by one, but these three cases are the ones that actually happen: an intern runs appointments but does not sign; a mentor edits the scoring keys; on-call duty — a temporary load, not a property of the position",
  },
  "perm.activeAll": { uk: "Діючі винятки в установі", ru: "Действующие исключения в учреждении", en: "Active exceptions in the institution" },
  "perm.superadminNote": {
    uk: "Суперадміністратор має всі права незалежно від ролей: інакше з’явився б стан, з якого систему не полагодити",
    ru: "Суперадминистратор имеет все права независимо от ролей: иначе появилось бы состояние, из которого систему не починить",
    en: "The superadministrator has all permissions regardless of roles: otherwise the system could end up in a state it cannot be repaired from",
  },

  /* что роль открывает на деле: собирають роль не з кодів прав, а з наслідків */
  "perm.roleGives": { uk: "Що роль дає", ru: "Что роль даёт", en: "What the role grants" },
  "perm.givesNothing": {
    uk: "Поки нічого: жодне право не відмічене, людина з такою роллю не побачить нічого понад свій профіль",
    ru: "Пока ничего: ни одно право не отмечено, человек с такой ролью не увидит ничего сверх своего профиля",
    en: "Nothing yet: no permission is checked, and a person with this role will see nothing beyond their own profile",
  },
  "perm.kind.screen": { uk: "Розділи меню", ru: "Разделы меню", en: "Menu sections" },
  "perm.kind.analysis": { uk: "Аналітика і вивантаження", ru: "Аналитика и выгрузки", en: "Analytics and exports" },
  "perm.kind.action": { uk: "Що зможе робити", ru: "Что сможет делать", en: "What they can do" },
  "perm.configure": { uk: "Налаштувати", ru: "Настроить", en: "Configure" },
  "perm.collapse": { uk: "Згорнути", ru: "Свернуть", en: "Collapse" },
  "perm.chosen": { uk: "прав", ru: "прав", en: "permissions" },

  /* цепочка назначения */
  "perm.chain": { uk: "Ланцюжок призначення", ru: "Цепочка назначения", en: "Assignment chain" },
  "perm.chainNote": {
    uk: "Кожен призначає лише ступінь нижче за свою. Правило перевіряється на сервері, а не хованням кнопки: той самий запит відправляють повз екран, і на прихованій кнопці ланцюжок тримався б до першого, хто спробує.",
    ru: "Каждый назначает только ступень ниже своей. Правило проверяется на сервере, а не прятанием кнопки: тот же запрос отправляют мимо экрана, и на спрятанной кнопке цепочка держалась бы до первого, кто попробует.",
    en: "Everyone assigns only the level below their own. The rule is checked on the server, not by hiding a button: the same request can be sent bypassing the screen, and a chain that relied on a hidden button would hold only until the first person who tries.",
  },
  "perm.superadminTitle": { uk: "Технічний суперадміністратор", ru: "Технический суперадминистратор", en: "Technical superadministrator" },
  "perm.notYours": { uk: "не нижче за вашу — призначає старший", ru: "не ниже вашей — назначает старший", en: "not below yours — assigned by a senior" },
  "perm.outsideChain": { uk: "поза ланцюжком", ru: "вне цепочки", en: "outside the chain" },
  "perm.outsideChainHint": {
    uk: "Роль поза ланцюжком призначає лише технічний адміністратор: її склад довільний, і разом з нею роздали б усе, що в неї покладуть",
    ru: "Роль вне цепочки назначает только технический администратор: её состав произволен, и вместе с ней раздали бы всё, что в неё положат",
    en: "A role outside the chain is assigned only by the technical administrator: its composition is arbitrary, and assigning it would hand out everything put into it",
  },

  /* личные исключения поштучно */
  "perm.anyPermission": { uk: "Будь-яке право поштучно", ru: "Любое право поштучно", en: "Any single permission" },
  "perm.pickPermission": { uk: "— виберіть можливість —", ru: "— выберите возможность —", en: "— select a capability —" },
  "perm.fromException": { uk: "виняток", ru: "исключение", en: "exception" },
  "perm.daysLeft": { uk: "дн. лишилося", ru: "дн. осталось", en: "d left" },
  "perm.lastDay": { uk: "сьогодні останній день", ru: "сегодня последний день", en: "today is the last day" },
  "perm.willOpen": { uk: "Відкриє", ru: "Откроет", en: "Will open" },
  "perm.willClose": { uk: "Закриє", ru: "Закроет", en: "Will close" },
  "perm.closedByException": {
    uk: "Закрито винятком, хоча роль це дає",
    ru: "Закрыто исключением, хотя роль это даёт",
    en: "Closed by an exception, although the role grants it",
  },
  "perm.closedList": { uk: "Не може, хоча роль дає", ru: "Не может, хотя роль даёт", en: "Cannot, although the role grants it" },
  /* соседние вкладки были зашиты по-русски: экран шёл по-украински, а две
     вкладки из четырёх — нет */
  "co.questions": { uk: "Питання", ru: "Вопросы", en: "Questions" },
  "co.undo": { uk: "Скасувати (Ctrl+Z)", ru: "Отменить (Ctrl+Z)", en: "Undo (Ctrl+Z)" },
  "co.redo": { uk: "Повернути (Ctrl+Shift+Z)", ru: "Вернуть (Ctrl+Shift+Z)", en: "Redo (Ctrl+Shift+Z)" },
  "co.noIssues": { uk: "Структурних зауважень немає", ru: "Структурных замечаний нет", en: "No structural issues" },
  "co.wholeJson": { uk: "Опис методики цілком", ru: "Описание методики целиком", en: "Full instrument description" },
  "co.apply": { uk: "Застосувати", ru: "Применить", en: "Apply" },
  "co.copy": { uk: "Скопіювати", ru: "Скопировать", en: "Copy" },
  "co.checkStructure": { uk: "Перевірити структуру", ru: "Проверить структуру", en: "Check structure" },
  "co.saving": { uk: "Збереження…", ru: "Сохранение…", en: "Saving…" },
  "co.bulkPaste": { uk: "Вставити пункти з тексту", ru: "Вставить пункты из текста", en: "Paste items from text" },

  /* журнал действий */
  "act.auth_login": { uk: "Вхід", ru: "Вход", en: "Sign-in" },
  "act.auth_login_failed": { uk: "Невдалий вхід", ru: "Неудачный вход", en: "Failed sign-in" },
  "act.auth_register": { uk: "Реєстрація", ru: "Регистрация", en: "Registration" },
  "act.user_create": { uk: "Створення облікового запису", ru: "Создание учётной записи", en: "Account creation" },
  "act.user_list": { uk: "Перегляд облікових записів", ru: "Просмотр учётных записей", en: "Viewing accounts" },
  "act.survey_create": { uk: "Створення методики", ru: "Создание методики", en: "Instrument creation" },
  "act.survey_catalog_update": { uk: "Оновлення методики з каталогу", ru: "Обновление методики из каталога", en: "Instrument update from catalog" },
  "act.survey_update": { uk: "Правка методики", ru: "Правка методики", en: "Instrument edit" },
  "act.survey_publish": { uk: "Публікація методики", ru: "Публикация методики", en: "Instrument publication" },
  "act.survey_delete": { uk: "Видалення методики", ru: "Удаление методики", en: "Instrument deletion" },
  "act.survey_duplicate": { uk: "Копія методики", ru: "Копия методики", en: "Instrument copy" },
  "act.group_create": { uk: "Створення групи", ru: "Создание группы", en: "Group creation" },
  "act.group_admin_assign": { uk: "Призначення адміністратора групи", ru: "Назначение админа группы", en: "Group administrator assignment" },
  "act.group_admin_revoke": { uk: "Зняття адміністратора групи", ru: "Снятие админа группы", en: "Group administrator removal" },
  "act.access_grant": { uk: "Призначення методики пацієнтові", ru: "Назначение методики пациенту", en: "Instrument assignment to patient" },
  "act.access_revoke": { uk: "Відкликання призначення", ru: "Отзыв назначения", en: "Assignment revocation" },
  "act.access_grant_list": { uk: "Перегляд призначень", ru: "Просмотр назначений", en: "Viewing assignments" },
  "act.access_denied": { uk: "Відмова в доступі", ru: "Отказ в доступе", en: "Access denied" },
  "act.response_submit": { uk: "Проходження відправлено", ru: "Прохождение отправлено", en: "Completion submitted" },
  "act.response_list": { uk: "Перегляд проходжень", ru: "Просмотр прохождений", en: "Viewing completions" },
  "act.response_read": { uk: "Перегляд картки", ru: "Просмотр карты", en: "Viewing card" },
  "act.response_draft": { uk: "Чернетка", ru: "Черновик", en: "Draft" },
  "act.analytics_overview": { uk: "Перегляд зведення", ru: "Просмотр сводки", en: "Viewing overview" },
  "act.analytics_survey": { uk: "Перегляд аналітики", ru: "Просмотр аналитики", en: "Viewing analytics" },
  "act.analytics_export": { uk: "Вивантаження даних", ru: "Выгрузка данных", en: "Data export" },
  "act.report_render": { uk: "Друк висновку", ru: "Печать заключения", en: "Conclusion printing" },
  "act.alert_list": { uk: "Перегляд тривог", ru: "Просмотр тревог", en: "Viewing alerts" },
  "act.alert_acknowledge": { uk: "Розбір тривоги", ru: "Разбор тревоги", en: "Alert review" },
  "act.audit_read": { uk: "Читання журналу", ru: "Чтение журнала", en: "Reading audit log" },

  /* остатки оболочки */
  "bt.assemble": { uk: "Зібрати набір", ru: "Собрать набор", en: "Build battery" },
  "bt.deadline": { uk: "Строк", ru: "Срок", en: "Deadline" },
  "bt.composition": { uk: "Склад", ru: "Состав", en: "Contents" },
  "aud.totalEvents": { uk: "Усього подій", ru: "Всего событий", en: "Total events" },
  "aud.denied": { uk: "Відмов у доступі", ru: "Отказов в доступе", en: "Access denials" },
  "aud.action": { uk: "Дія", ru: "Действие", en: "Action" },
  "aud.outcome": { uk: "Наслідок", ru: "Исход", en: "Outcome" },
  "aud.wholeDatabase": { uk: "база цілком", ru: "база целиком", en: "whole database" },
  "aud.rows": { uk: "рядків", ru: "строк", en: "rows" },
  "aud.storage": { uk: "Сховище", ru: "Хранилище", en: "Storage" },
  "adm.lastName": { uk: "Прізвище", ru: "Фамилия", en: "Last name" },
  "adm.firstName": { uk: "Ім’я", ru: "Имя", en: "First name" },
  "adm.middleName": { uk: "По батькові", ru: "Отчество", en: "Patronymic" },
  "adm.allAccounts": { uk: "Усі облікові записи", ru: "Все учётные записи", en: "All accounts" },
  "ui.typeToConfirm": { uk: "Для підтвердження надрукуйте", ru: "Для подтверждения напечатайте", en: "To confirm, type" },
  "ui.andMore": { uk: "і ще", ru: "и ещё", en: "and another" },
  "ui.delete": { uk: "Видалити", ru: "Удалить", en: "Delete" },
  "ui.min": { uk: "хв", ru: "мин", en: "min" },
  /*
   * Кнопка выгрузки таблицы была подписана одним «CSV · 14».
   *
   * Название формата — не действие: на кнопке не написано, что она делает, и
   * диктор читает её как «си-эс-ви чотирнадцять». Глагол добавлен в саму
   * подпись, а не только в aria-label: зрячий видит ту же загадку, что и
   * незрячий, и разводить два текста ради экономии трёх букв незачем.
   * Название формата при этом остаётся — по нему понимают, что откроется в
   * Excel, а число после точки говорит, сколько строк уедет: выгружается
   * отфильтрованный вид, а не вся таблица.
   */
  "ui.exportCsv": { uk: "Вивантажити CSV", ru: "Выгрузить CSV", en: "Export CSV" },
  "ui.retrying": { uk: "Пробую…", ru: "Пробую…", en: "Retrying…" },
  "ui.offline": { uk: "Немає зв’язку із сервером. Показано останні завантажені дані.", ru: "Нет связи с сервером. Показаны последние загруженные данные.", en: "No connection to the server. Showing the last loaded data." },
  "cl.editAction": { uk: "Правити", ru: "Править", en: "Edit" },
  "cl.keysAction": { uk: "Ключі", ru: "Ключи", en: "Keys" },
  "cl.accessAction": { uk: "Доступ", ru: "Доступ", en: "Access" },
  "cq.score": { uk: "Бал", ru: "Балл", en: "Score" },
  "mv.aboveShare": { uk: "вище, ніж у {n}% обстежених", ru: "выше, чем у {n}% обследованных", en: "higher than {n}% of those assessed" },
  "mv.peakPerDay": { uk: "пік: {n} на день", ru: "пик: {n} в день", en: "peak: {n} per day" },
  "mv.radarNeedsThree": {
    uk: "Профіль будується від трьох субшкал — зараз їх {n}",
    ru: "Профиль строится от трёх субшкал — сейчас их {n}",
    en: "A profile needs at least three subscales — currently there are {n}",
  },
  "mv.threshold": { uk: "поріг", ru: "порог", en: "threshold" },
  "mv.ordinary": { uk: "звичайні", ru: "обычные", en: "regular" },
  "mv.markedCareless": { uk: "позначено як недбалі ({n})", ru: "помечены как небрежные ({n})", en: "flagged as careless ({n})" },
  "mv.lowItemLink": {
    uk: "Пункти зі зв’язком нижче {n} виділено — вони погано узгоджуються зі своєю шкалою",
    ru: "Пункты со связью ниже {n} выделены — они плохо согласуются со своей шкалой",
    en: "Items correlating below {n} with the rest of their scale are highlighted — they fit their scale poorly",
  },
  "ma.casesToReview": { uk: "Випадків на розбір: {n}", ru: "Случаев на разбор: {n}", en: "Cases to review: {n}" },
  "ma.surveyLine": { uk: "{q} питань · {r} проходжень · {s}", ru: "{q} вопросов · {r} прохождений · {s}", en: "{q} questions · {r} completions · {s}" },
  "ma.results": { uk: "результатів", ru: "результатов", en: "results" },
  "ma.completion": { uk: "доходимість {n}%", ru: "доходимость {n}%", en: "completion rate {n}%" },
  "ma.published": { uk: "опубліковано", ru: "опубликовано", en: "published" },
  "mal.caseIsPerson": {
    uk: "Випадок — це людина, а не окремий пункт. Рішення ухвалюється один раз про всі її сигнали.",
    ru: "Случай — это человек, а не отдельный пункт. Решение принимается один раз обо всех его сигналах.",
    en: "A case is a person — not a single item. The decision is made once for all of their signals.",
  },
  "mal.open": { uk: "Відкриті", ru: "Открытые", en: "Open" },
  "mal.all": { uk: "Усі", ru: "Все", en: "All" },
  "mal.overdue": { uk: "прострочений", ru: "просрочен", en: "overdue" },
  "mal.signals": { uk: "сигналів {n}", ru: "сигналов {n}", en: "{n} signals" },
  "mal.andMore": { uk: "…і ще {n}", ru: "…и ещё {n}", en: "…and {n} more" },
  "mal.resolvedBy": { uk: "Розібрано: {who}, {at}", ru: "Разобрано: {who}, {at}", en: "Reviewed: {who}, {at}" },
  "mal.takenBy": { uk: "Взяв: {who}", ru: "Взял: {who}", en: "Taken by: {who}" },
  "mpa.measurements": { uk: "замірів {n}", ru: "замеров {n}", en: "{n} measurements" },
  "msa.versionNote": {
    uk: "Зрізи пораховано за версією {v}. Проходження різних версій не змішуються — питання в них різні.",
    ru: "Срезы посчитаны по версии {v}. Прохождения разных версий не смешиваются — вопросы у них разные.",
    en: "Breakdowns are calculated for version {v}. Completions of different versions are not mixed — their questions differ.",
  },
  "msa.quality": { uk: "Якість", ru: "Качество", en: "Quality" },
  "msa.started": { uk: "почато {n}", ru: "начато {n}", en: "{n} started" },
  "msa.abandoned": { uk: "покинуто {n}", ru: "брошено {n}", en: "{n} abandoned" },
  "msa.reachedEnd": { uk: "дійшли до кінця", ru: "дошли до конца", en: "reached the end" },
  "msa.itemShort": { uk: "П{n}", ru: "В{n}", en: "Q{n}" },
  "msa.spread": {
    uk: "середнє {avg} · медіана {med} · діапазон {min}–{max} з {of}",
    ru: "среднее {avg} · медиана {med} · диапазон {min}–{max} из {of}",
    en: "mean {avg} · median {med} · range {min}–{max} of {of}",
  },
  "msa.spreadNoMax": {
    uk: "середнє {avg} · медіана {med} · діапазон {min}–{max}",
    ru: "среднее {avg} · медиана {med} · диапазон {min}–{max}",
    en: "mean {avg} · median {med} · range {min}–{max}",
  },
  "msa.noSubscales": {
    uk: "У методики немає субшкал — підрахунок балів вимкнено.",
    ru: "У методики нет субшкал — подсчёт баллов отключён.",
    en: "The instrument has no subscales — scoring is turned off.",
  },
  "msa.flaggedNote": {
    uk: "Позначено {n} з {total} проходжень. Поріг «занадто швидко» — {sec} с на питання. Це прапорець для перевірки фахівцем, а не підстава автоматично виключати дані.",
    ru: "Помечено {n} из {total} прохождений. Порог «слишком быстро» — {sec} с на вопрос. Это флаг для проверки специалистом, а не основание автоматически исключать данные.",
    en: "{n} of {total} completions flagged. The “too fast” threshold — {sec} s per question. This is a flag for review by a specialist, not grounds for automatically excluding data.",
  },
  "msa.durationAxis": { uk: "час проходження, с", ru: "время прохождения, с", en: "completion time, s" },
  "msa.fastAxis": { uk: "% швидких", ru: "% быстрых", en: "% fast" },
  "msa.fastAnswers": { uk: "швидких відповідей {n}%", ru: "быстрых ответов {n}%", en: "fast answers {n}%" },
  "msa.straightLine": { uk: "серія однакових: {n}", ru: "серия одинаковых: {n}", en: "identical-answer streak: {n}" },
  "msa.consistencyNote": {
    uk: "Внутрішня узгодженість за {n} пунктами: наскільки вони вимірюють одне й те саме.",
    ru: "Внутренняя согласованность по {n} пунктам: насколько они измеряют одно и то же.",
    en: "Internal consistency across {n} items: how much they measure the same thing.",
  },
  "msa.itemTotal": { uk: "зв’язок з рештою {n}", ru: "связь с остальными {n}", en: "correlation with the rest {n}" },
  "msa.alphaIfDeleted": { uk: "альфа без нього {n}", ru: "альфа без него {n}", en: "alpha if item removed {n}" },
  "msa.reviseItem": {
    uk: "без цього пункту шкала стає узгодженішою — варто переглянути формулювання",
    ru: "без этого пункта шкала становится согласованнее — стоит пересмотреть формулировку",
    en: "without this item the scale becomes more consistent — consider revising the wording",
  },
  "msa.answersCount": { uk: "відповідей {n}", ru: "ответов {n}", en: "{n} answers" },
  "msa.skipsCount": { uk: "пропусків {n}%", ru: "пропусков {n}%", en: "skipped {n}%" },
  "msa.freeText": { uk: "Вільні відповіді ({n})", ru: "Свободные ответы ({n})", en: "Free-text answers ({n})" },
  "msa.rank": { uk: "ранг {n}", ru: "ранг {n}", en: "rank {n}" },
  "mpa.since": { uk: " · з {d}", ru: " · с {d}", en: " · from {d}" },
  "mpa.until": { uk: " по {d}", ru: " по {d}", en: " to {d}" },
  "mpa.needSecond": {
    uk: "потрібен щонайменше другий замір, щоб говорити про динаміку",
    ru: "нужен минимум второй замер, чтобы говорить о динамике",
    en: "at least a second measurement is needed to speak of dynamics",
  },
  "mpa.periodChange": { uk: "зміна за період: {d}", ru: "изменение за период: {d}", en: "change over the period: {d}" },
  "mpa.noPercentile": {
    uk: "Перцентиль не рахується: накопичена вибірка замала, щоб він щось означав",
    ru: "Перцентиль не считается: накопленная выборка слишком мала, чтобы он что-то значил",
    en: "Percentile is not calculated: the accumulated sample is too small for it to mean anything",
  },
  "ma.backToMenu": { uk: "‹ Меню", ru: "‹ Меню", en: "‹ Menu" },
  "ma.edits": { uk: " · правок {n}", ru: " · правок {n}", en: " · {n} edits" },
  "common.minutes": { uk: "{n} хв", ru: "{n} мин", en: "{n} min" },
  "sch.unit": { uk: "Підрозділ", ru: "Подразделение", en: "Unit" },
  "kp.print": { uk: "Друк", ru: "Печать", en: "Print" },
  "kp.blank": { uk: "Порожній бланк", ru: "Пустой бланк", en: "Blank answer sheet" },
  "inv.create": { uk: "Створити запрошення", ru: "Создать приглашение", en: "Create invitation" },
  "inv.code": { uk: "Код", ru: "Код", en: "Code" },
  "inv.days": { uk: "Строк, днів", ru: "Срок, дней", en: "Duration, days" },
  "bf.title": { uk: "Бланк для заповнення", ru: "Бланк для заполнения", en: "Answer sheet to fill in" },
  "app.title": { uk: "Quizzy — консоль аналітики", ru: "Quizzy — консоль аналитики", en: "Quizzy — analytics console" },
  "lg.password": { uk: "Пароль", ru: "Пароль", en: "Password" },
  "ad.unreliable": { uk: "Профіль визнано ненадійним", ru: "Профиль признан ненадёжным", en: "Profile deemed unreliable" },
  "ad.scale": { uk: "Шкала", ru: "Шкала", en: "Scale" },
  "ad.raw": { uk: "Сирий", ru: "Сырой", en: "Raw" },
  "ad.value": { uk: "Значення", ru: "Значение", en: "Value" },
  "ad.interpretation": { uk: "Інтерпретація", ru: "Интерпретация", en: "Interpretation" },
  "ad.recommendation": { uk: "Рекомендація", ru: "Рекомендация", en: "Recommendation" },
  "cn.loadFailed": { uk: "Висновок не завантажився", ru: "Заключение не загрузилось", en: "Conclusion failed to load" },
  "cs.to": { uk: "До", ru: "До", en: "Until" },
  "bp.close": { uk: "Закрити", ru: "Закрыть", en: "Close" },
  "api.download": { uk: "Завантажити openapi.json", ru: "Скачать openapi.json", en: "Download openapi.json" },

  /* остатки оболочки, часть 2 */
  "lg.failed": { uk: "Не вдалося увійти", ru: "Не удалось войти", en: "Could not sign in" },
  /*
   * Кнопка входа была зашита по-русски мимо словаря — на украинском экране
   * подпись под заголовком шла по-украински, а единственная кнопка по-русски.
   */
  "lg.signIn": { uk: "Увійти", ru: "Войти", en: "Sign in" },
  "lg.googleLink": { uk: "Прив’язати Google", ru: "Привязать Google", en: "Link Google" },
  "lg.googleUnlink": { uk: "Відв’язати Google", ru: "Отвязать Google", en: "Unlink Google" },
  "lg.googleUnlinkAsk": { uk: "Введіть пароль, щоб відв’язати Google", ru: "Введите пароль, чтобы отвязать Google", en: "Enter your password to unlink Google" },
  "lg.googleLinked": { uk: "Google прив’язано", ru: "Google привязан", en: "Google linked" },
  "lg.googleFailed": {
    uk: "Не вдалося увійти через Google. Спробуйте пароль.",
    ru: "Не удалось войти через Google. Попробуйте пароль.",
    en: "Could not sign in with Google. Try your password.",
  },
  "lg.staffOnly": {
    uk: "Консоль доступна лише співробітникам. Пацієнти працюють у застосунку.",
    ru: "Консоль доступна только сотрудникам. Пациенты работают в приложении.",
    en: "The console is available to staff only. Patients use the app.",
  },
  "lg.signingIn": { uk: "Входимо…", ru: "Вход…", en: "Signing in…" },
  "aud.allEvents": { uk: "Усе", ru: "Всё", en: "All" },
  "aud.cardAccess": { uk: "Доступ до карток", ru: "Доступ к картам", en: "Card access" },
  "aud.exports": { uk: "Вивантаження", ru: "Выгрузки", en: "Exports" },
  "aud.grants": { uk: "Призначення", ru: "Назначения", en: "Assignments" },
  "aud.denials": { uk: "Відмови", ru: "Отказы", en: "Denials" },
  "aud.failedLogins": { uk: "Невдалі входи", ru: "Неудачные входы", en: "Failed sign-ins" },
  "aud.sub": { uk: "Фіксуються і звернення до даних пацієнтів, а не лише зміни. Записи не редагуються.", ru: "Фиксируются и обращения к данным пациентов, а не только изменения. Записи не редактируются.", en: "Access to patient data is recorded too, not only changes. Entries cannot be edited." },
  "aud.whoOften": { uk: "Хто звертається частіше", ru: "Кто чаще обращается", en: "Who accesses most often" },
  "aud.perAccount": { uk: "Подій на обліковий запис", ru: "Событий на учётную запись", en: "Events per account" },
  "aud.whatDo": { uk: "Що роблять", ru: "Что делают", en: "What people do" },
  "aud.byActionType": { uk: "Розподіл за типами дій", ru: "Распределение по типам действий", en: "Breakdown by action type" },
  "ui.findRespondent": { uk: "Знайти обстежуваного", ru: "Найти обследуемого", en: "Find respondent" },
  "ui.remove": { uk: "Прибрати", ru: "Убрать", en: "Remove" },
  "inv.noneHint": { uk: "Створіть посилання — пацієнт зареєструється сам і одразу отримає призначення", ru: "Создайте ссылку — пациент зарегистрируется сам и сразу получит назначение", en: "Create a link — the patient will register on their own and immediately receive the assignment" },
  "inv.revoked": { uk: "Запрошення відкликано", ru: "Приглашение отозвано", en: "Invitation revoked" },
  "inv.created": { uk: "Запрошення створено", ru: "Приглашение создано", en: "Invitation created" },
  "inv.linkCopied": { uk: "Посилання скопійовано", ru: "Ссылка скопирована", en: "Link copied" },
  "inv.codeCopied": { uk: "Код скопійовано", ru: "Код скопирован", en: "Code copied" },
  "ref.issuedToast": { uk: "Направлення виписано", ru: "Направление выписано", en: "Referral issued" },
  "bf.expand": { uk: "Розгорнути з текстом пунктів", ru: "Развернуть с текстом пунктов", en: "Expand with item text" },
  "bf.collapse": { uk: "Згорнути до сітки відповідей", ru: "Свернуть до сетки ответов", en: "Collapse to answer grid" },
  "bf.fullName": { uk: "Прізвище, ім’я, по батькові", ru: "Фамилия, имя, отчество", en: "Last name, first name, patronymic" },
  "bf.birthDate": { uk: "Дата народження", ru: "Дата рождения", en: "Date of birth" },
  "bf.examDate": { uk: "Дата обстеження", ru: "Дата обследования", en: "Assessment date" },
  "bf.sheetCode": { uk: "Код бланка", ru: "Код бланка", en: "Answer sheet code" },
  "bf.sheetCodeHint": {
    uk: "Наведіть камеру, щоб відкрити введення саме цієї методики цієї версії",
    ru: "Наведите камеру, чтобы открыть ввод именно этой методики этой версии",
    en: "Point the camera to open entry for exactly this instrument and this version",
  },
  "bf.psychologist": { uk: "Психолог", ru: "Психолог", en: "Psychologist" },
  "bf.signature": { uk: "Підпис обстежуваного", ru: "Подпись обследуемого", en: "Respondent's signature" },
  "ad.saveFailed": { uk: "Не вдалося зберегти", ru: "Не удалось сохранить", en: "Could not save" },
  "ad.saving": { uk: "Збереження…", ru: "Сохранение…", en: "Saving…" },
  "ad.save": { uk: "Зберегти обстеження", ru: "Сохранить обследование", en: "Save assessment" },
  "api.title": { uk: "Опис API", ru: "Описание API", en: "API reference" },
  "api.showSchema": { uk: "Показати схему тіла", ru: "Показать схему тела", en: "Show body schema" },
  "api.noBody": { uk: "Тіло не потрібне", ru: "Тело не требуется", en: "No body required" },
  "cmp.rank": { uk: "Звання", ru: "Звание", en: "Rank" },
  "cl.restored": { uk: "Методика повернулася в роботу", ru: "Методика вернулась в работу", en: "Instrument returned to use" },
  "cq.moveUp": { uk: "Зсунути вище", ru: "Сдвинуть выше", en: "Move up" },
  "cq.moveDown": { uk: "Зсунути нижче", ru: "Сдвинуть ниже", en: "Move down" },
  "cq.duplicate": { uk: "Дублювати пункт", ru: "Дублировать пункт", en: "Duplicate item" },
  "cq.required": { uk: "Обов’язковий", ru: "Обязательный", en: "Required" },
  "bt.archived": { uk: "архів", ru: "архив", en: "archived" },
  "bt.assignments": { uk: "Призначення", ru: "Назначения", en: "Assignments" },
  "bt.group": { uk: "Група", ru: "Группа", en: "Group" },
  "bt.strictOrder": { uk: "суворий порядок", ru: "строгий порядок", en: "strict order" },
  "bt.freeOrder": { uk: "вільний порядок", ru: "свободный порядок", en: "any order" },
  "bt.totalItems": { uk: "усього пунктів:", ru: "всего пунктов:", en: "total items:" },
  "bt.approx": { uk: "орієнтовно", ru: "ориентировочно", en: "approx." },
  "bt.items": { uk: "пунктів", ru: "пунктов", en: "items" },
  "bt.median": { uk: "медіана", ru: "медиана", en: "median" },
  "bt.durationUnknown": { uk: "тривалість невідома", ru: "длительность неизвестна", en: "duration unknown" },
  "bt.optional": { uk: "необов’язкова", ru: "необязательная", en: "optional" },
  "bt.byClinician": { uk: "заповнює фахівець", ru: "заполняет специалист", en: "filled in by the specialist" },
  "bt.noDeadline": { uk: "без строку", ru: "без срока", en: "no deadline" },
  "bt.mixedModes": {
    uk: "У наборі змішані режими. Кроки, які заповнює фахівець, обстежуваний побачить, але відкрити не зможе — за суворого порядку вони затримають решту, доки їх не внесуть через «Провести».",
    ru: "В наборе смешаны режимы. Шаги, которые заполняет специалист, обследуемый увидит, но открыть не сможет — при строгом порядке они задержат остальные, пока их не внесут через «Провести».",
    en: "This battery mixes modes. The respondent will see steps filled in by the specialist but will not be able to open them — with strict order they will hold up the rest until they are entered via “Administer”.",
  },
  "bt.title": { uk: "Набори методик", ru: "Наборы методик", en: "Batteries" },
  "bt.sub": { uk: "Набір методик, який призначається і проходиться цілком", ru: "Набор методик, который назначается и проходится целиком", en: "A set of instruments assigned and completed as a whole" },
  "bt.none": { uk: "Наборів поки немає", ru: "Наборов пока нет", en: "No batteries yet" },
  "bt.noneHint": { uk: "Зберіть набір з методик, які завжди йдуть разом, — призначати його доведеться один раз, а не по одній методиці", ru: "Соберите набор из методик, которые всегда идут вместе, — назначать его придётся один раз, а не по одной методике", en: "Build a battery from instruments that always go together — you will assign it once instead of one instrument at a time" },
  "bt.collapseAssignments": { uk: "Згорнути призначення", ru: "Свернуть назначения", en: "Collapse assignments" },
  "bt.deleted": { uk: "Набір видалено", ru: "Набор удалён", en: "Battery deleted" },
  "bt.noGroup": { uk: "Поза групами", ru: "Вне групп", en: "Ungrouped" },
  "bt.assignmentRemoved": { uk: "Призначення знято", ru: "Назначение снято", en: "Assignment removed" },
  "bt.updated": { uk: "Набір оновлено", ru: "Набор обновлён", en: "Battery updated" },
  "bt.assembled": { uk: "Набір зібрано", ru: "Набор собран", en: "Battery created" },
  "bt.editTitle": { uk: "Правка набору", ru: "Правка набора", en: "Edit battery" },
  "bt.newTitle": { uk: "Новий набір", ru: "Новый набор", en: "New battery" },
  "bt.namePlaceholder": { uk: "Наприклад, вхідне обстеження", ru: "Например, входное обследование", en: "For example, intake assessment" },
  "cn.newOverSigned": { uk: "Новий текст поверх підписаної версії…", ru: "Новый текст поверх подписанной версии…", en: "New text over the signed version…" },
  "cn.placeholder": { uk: "Клінічна інтерпретація, рекомендації, призначення…", ru: "Клиническая интерпретация, рекомендации, назначения…", en: "Clinical interpretation, recommendations, prescriptions…" },
  "cn.draftSaved": { uk: "Чернетку збережено", ru: "Черновик сохранён", en: "Draft saved" },
  "cn.signed": { uk: "Висновок підписано — тепер він у друкованому звіті", ru: "Заключение подписано — теперь оно в печатном отчёте", en: "Conclusion signed — it is now in the printed report" },
  "cn.hideHistory": { uk: "Сховати історію", ru: "Скрыть историю", en: "Hide history" },
  "ui.noMoreRecords": { uk: "Більше записів немає", ru: "Больше записей нет", en: "No more records" },
  "ui.loadingMore": { uk: "Завантажую…", ru: "Загружаю…", en: "Loading…" },
  "ui.actionFailed": { uk: "Не вдалося виконати", ru: "Не удалось выполнить", en: "Could not complete the action" },

  /* остатки: приглашение, разбор, отчёт */
  "join.accountCreated": { uk: "Обліковий запис створено", ru: "Учётная запись создана", en: "Account created" },
  "join.invited": { uk: "Вас запросили пройти обстеження", ru: "Вас пригласили пройти обследование", en: "You have been invited to take an assessment" },
  "cases.tookToast": { uk: "Випадок узято", ru: "Случай взят", en: "Case taken" },
  "cases.released": { uk: "Випадок відпущено", ru: "Случай отпущен", en: "Case released" },
  "cases.resolved": { uk: "Випадок розібрано", ru: "Случай разобран", en: "Case resolved" },

  /* мобильное приложение: очередь, профиль, вход, регистрация */
  "ml.createAccount": { uk: "Створити обліковий запис", ru: "Создать аккаунт", en: "Create account" },
  "ml.subtitle": { uk: "Вхід для пацієнтів і фахівців", ru: "Вход для пациентов и специалистов", en: "Sign-in for patients and specialists" },
  "mp.appLock": { uk: "Замок на застосунок", ru: "Замок на приложение", en: "App lock" },
  "mp.lockOff": { uk: "Вимкнути замок", ru: "Выключить замок", en: "Turn off lock" },
  "mp.lockOn": { uk: "Увімкнути замок", ru: "Включить замок", en: "Turn on lock" },
  "mp.myDynamics": { uk: "Моя динаміка", ru: "Моя динамика", en: "My dynamics" },
  "mq.allSent": { uk: "Усе відправлено", ru: "Всё отправлено", en: "Everything sent" },
  "mq.attempts": { uk: "спроб", ru: "попыток", en: "attempts" },
  "mq.rejected": { uk: "Сервер не прийняв", ru: "Сервер не принял", en: "Rejected by the server" },
  "mq.retry": { uk: "Спробувати ще раз", ru: "Попробовать ещё раз", en: "Try again" },
  "mq.title": { uk: "Черга відправлення", ru: "Очередь отправки", en: "Send queue" },
  "mq.tryNow": { uk: "Спробувати зараз", ru: "Попробовать сейчас", en: "Try now" },
  "mq.waiting": { uk: "Чекають на зв’язок", ru: "Ждут связи", en: "Waiting for connection" },
  "mr.backToLogin": { uk: "Назад до входу", ru: "Назад ко входу", en: "Back to sign-in" },
  "mr.createsPatient": { uk: "Реєстрація створює обліковий запис пацієнта", ru: "Регистрация создаёт учётную запись пациента", en: "Registration creates a patient account" },
  "mq.hint": {
    uk: "Відповіді зберігаються на пристрої й підуть самі, щойно з’явиться мережа. Нічого не втрачено.",
    ru: "Ответы сохранены на устройстве и уйдут сами, как только появится сеть. Ничего не потеряно.",
    en: "Answers are stored on the device and will be sent automatically as soon as the network is back. Nothing is lost.",
  },
  "mq.rejectedHint": {
    uk: "Ці відповіді не підуть самі. Покажіть екран фахівцю — видаляти їх самостійно не потрібно.",
    ru: "Эти ответы не уйдут сами. Покажите экран специалисту — удалять их самостоятельно не нужно.",
    en: "These answers will not be sent automatically. Show this screen to a specialist — you do not need to delete them yourself.",
  },
  "mp.lockHint": {
    uk: "Просити відбиток або обличчя при вході. Закриває екран від сторонніх очей — дані й так зберігаються в захищеному сховищі системи.",
    ru: "Спрашивать отпечаток или лицо при входе. Закрывает экран от посторонних глаз — данные и так хранятся в защищённом хранилище системы.",
    en: "Ask for a fingerprint or face on sign-in. Hides the screen from prying eyes — your data is already kept in the system's secure storage.",
  },
  "mp.lockShared": {
    uk: "На спільному планшеті не вмикайте: біометрія там належить не вам.",
    ru: "На общем планшете не включайте: биометрия там принадлежит не вам.",
    en: "Do not turn it on on a shared tablet: the biometrics there are not yours.",
  },

  /* мобильное приложение: вкладки, прохождение, профиль */
  "tab.surveys": { uk: "Опитування", ru: "Опросы", en: "Surveys" },
  "tab.analytics": { uk: "Аналітика", ru: "Аналитика", en: "Analytics" },
  "tab.account": { uk: "Обліковий запис", ru: "Аккаунт", en: "Account" },
  "tab.queue": { uk: "Черга відправлення", ru: "Очередь отправки", en: "Send queue" },
  "mr.accountType": { uk: "Тип облікового запису", ru: "Тип учётной записи", en: "Account type" },
  "mr.regular": { uk: "Звичайний", ru: "Обычная", en: "Standard" },
  "mr.withName": { uk: "З прізвищем та ім’ям", ru: "С фамилией и именем", en: "With last and first name" },
  "mr.noName": { uk: "Без імені", ru: "Без имени", en: "Without a name" },
  "mr.codeInstead": { uk: "Замість ПІБ — код", ru: "Вместо ФИО — код", en: "A code instead of the full name" },
  "ms.abortTitle": { uk: "Перервати проходження?", ru: "Прервать прохождение?", en: "Stop the test?" },
  "ms.abortBody": { uk: "Відповіді цього сеансу не збережуться, починати доведеться заново.", ru: "Ответы этого сеанса не сохранятся, начинать придётся заново.", en: "Answers from this session will not be saved; you will have to start over." },
  "ms.continueTest": { uk: "Продовжити тест", ru: "Продолжить тест", en: "Continue test" },
  "ms.exit": { uk: "Вийти", ru: "Выйти", en: "Exit" },
  "ms.loadFailed": { uk: "Не вдалося завантажити методику", ru: "Не удалось загрузить методику", en: "Could not load the instrument" },
  "ms.done": { uk: "Готово", ru: "Готово", en: "Done" },
  "ms.subscaleResults": { uk: "Результати за субшкалами", ru: "Результаты по субшкалам", en: "Results by subscale" },
  "ms.openConclusion": { uk: "Відкрити висновок", ru: "Открыть заключение", en: "Open conclusion" },
  "ms.unfinishedFound": { uk: "Знайдено незавершене проходження", ru: "Найдено незавершённое прохождение", en: "Unfinished test found" },
  "ms.questions": { uk: "Питань", ru: "Вопросов", en: "Questions" },
  "ms.timeLimit": { uk: "Обмеження часу", ru: "Ограничение времени", en: "Time limit" },
  "ms.continue": { uk: "Продовжити", ru: "Продолжить", en: "Continue" },
  "ms.start": { uk: "Почати", ru: "Начать", en: "Start" },
  "mp.roleSuper": { uk: "Суперадміністратор", ru: "Суперадминистратор", en: "Superadministrator" },
  "mp.roleAdmin": { uk: "Адміністратор групи", ru: "Администратор группы", en: "Group administrator" },
  "mp.rolePatient": { uk: "Пацієнт", ru: "Пациент", en: "Patient" },
  "mp.saveFailed": { uk: "Не вдалося зберегти", ru: "Не удалось сохранить", en: "Could not save" },
  "msv.tookQueued": {
    uk: "Проходження зайняло {d}. Мережі немає — відповіді збережено на пристрої і вони підуть самі, щойно вона з’явиться. Бали нижче пораховано на пристрої тим самим рушієм.",
    ru: "Прохождение заняло {d}. Сети нет — ответы сохранены на устройстве и уйдут сами, как только она появится. Баллы ниже посчитаны на устройстве тем же движком.",
    en: "The test took {d}. There is no network — answers are saved on the device and will be sent automatically as soon as it is back. The scores below were calculated on the device by the same engine.",
  },
  "msv.tookSaved": {
    uk: "Проходження зайняло {d}. Відповіді збережено.",
    ru: "Прохождение заняло {d}. Ответы сохранены.",
    en: "The test took {d}. Answers saved.",
  },
  "msv.alsoAssigned": {
    uk: "За результатом призначено додаткове обстеження: {list}. Воно вже чекає на головному екрані.",
    ru: "По результату назначено дополнительное обследование: {list}. Оно уже ждёт на главном экране.",
    en: "Based on the result, an additional assessment has been assigned: {list}. It is already waiting on the home screen.",
  },
  "msv.importantNow": { uk: "Важливо просто зараз", ru: "Важно прямо сейчас", en: "Important right now" },
  "msv.notDiagnosis": {
    uk: "Результат скринінгу не є діагнозом — його тлумачить фахівець.",
    ru: "Результат скрининга не является диагнозом — его интерпретирует специалист.",
    en: "A screening result is not a diagnosis — it is interpreted by a specialist.",
  },
  "msv.toSurveys": { uk: "До списку методик", ru: "К списку методик", en: "Back to instruments" },
  "msv.resumeAt": {
    uk: "Відповіді збережено{at} — продовжте з того місця, де зупинилися.",
    ru: "Ответы сохранены{at} — продолжите с того места, где остановились.",
    en: "Answers saved{at} — continue from where you left off.",
  },
  "msv.minutesLeft": { uk: "≈{n} хв лишилося", ru: "≈{n} мин осталось", en: "≈{n} min left" },
  "msv.ofMinutes": { uk: " / {n} хв", ru: " / {n} мин", en: " / {n} min" },
  "msv.textSize": {
    uk: "Розмір тексту, зараз {n} відсотків",
    ru: "Размер текста, сейчас {n} процентов",
    en: "Text size, currently {n} percent",
  },
  "qi.pointOf": { uk: "{n} з {max}", ru: "{n} из {max}", en: "{n} of {max}" },
  "qi.remove": { uk: "прибрати", ru: "убрать", en: "remove" },
  "qi.removeHint": { uk: "{n}: {text}. Натисніть, щоб прибрати", ru: "{n}: {text}. Нажмите, чтобы убрать", en: "{n}: {text}. Tap to remove" },
  "qi.placeHint": {
    uk: "{text}. Натисніть, щоб поставити на місце {n}",
    ru: "{text}. Нажмите, чтобы поставить на место {n}",
    en: "{text}. Tap to put it in position {n}",
  },
  "qi.rangeHint": { uk: "від {min} до {max}", ru: "от {min} до {max}", en: "from {min} to {max}" },
  "qi.datePattern": { uk: "РРРР-ММ-ДД", ru: "ГГГГ-ММ-ДД", en: "YYYY-MM-DD" },
  "ob.rejected": { uk: "Не вдалося відправити: {n}", ru: "Не удалось отправить: {n}", en: "Failed to send: {n}" },
  "ob.rejectedHint": {
    uk: "Не вдалося відправити: {n}. Натисніть, щоб подивитися",
    ru: "Не удалось отправить: {n}. Нажмите, чтобы посмотреть",
    en: "Failed to send: {n}. Tap to view",
  },
  "ob.waiting": {
    uk: "Відповіді збережено на пристрої і чекають на зв’язок: {n}",
    ru: "Ответы сохранены на устройстве и ждут связи: {n}",
    en: "Answers saved on the device and waiting for connection: {n}",
  },
  "ob.waitingHint": {
    uk: "Чекають на відправлення: {n}. Натисніть, щоб відправити зараз",
    ru: "Ждут отправки: {n}. Нажмите, чтобы отправить сейчас",
    en: "Waiting to be sent: {n}. Tap to send now",
  },
  "mp.unsentAnswers": { uk: "Є невідправлені відповіді — дочекайтеся мережі, вони підуть самі.", ru: "Есть неотправленные ответы — дождитесь сети, они уйдут сами.", en: "There are unsent answers — wait for the network, they will be sent automatically." },
  "mp.queueLeft": {
    uk: "Не відправлено відповідей: {n}. Підуть самі, щойно з’явиться мережа.",
    ru: "Не отправлено ответов: {n}. Уйдут сами, как только появится сеть.",
    en: "Answers not sent: {n}. They will be sent automatically as soon as the network is back.",
  },
  "mp.noSexBirth": {
    uk: "Не заповнено стать і дату народження. Частина методик користується нормами, що залежать від статі та віку, — без них результат буде порахований без нормування.",
    ru: "Не заполнены пол и дата рождения. Часть методик использует нормы, которые зависят от пола и возраста, — без них результат будет посчитан без нормирования.",
    en: "Sex and date of birth are not filled in. Some instruments use norms that depend on sex and age — without them the result will be calculated without norming.",
  },
  "mp.dynamicsHint": { uk: "Зміна ваших показників від заміру до заміру. Інтерпретацію дає фахівець.", ru: "Изменение ваших показателей от замера к замеру. Интерпретацию даёт специалист.", en: "How your scores change from one measurement to the next. Interpretation is given by a specialist." },
  "mp.male": { uk: "Чоловіча", ru: "Мужской", en: "Male" },
  "mp.female": { uk: "Жіноча", ru: "Женский", en: "Female" },
  "mp.dateFormat": { uk: "РРРР-ММ-ДД", ru: "ГГГГ-ММ-ДД", en: "YYYY-MM-DD" },
  "mp.position": { uk: "Посада", ru: "Должность", en: "Position" },
  "mp.specialty": { uk: "Спеціальність", ru: "Специальность", en: "Specialty" },
  "mp.rank": { uk: "Звання", ru: "Звание", en: "Rank" },
  "mp.age": { uk: "Вік", ru: "Возраст", en: "Age" },
  "mp.since": { uk: "У системі з", ru: "В системе с", en: "In the system since" },
  "mp.edit": { uk: "Редагувати", ru: "Редактировать", en: "Edit" },
  "ms.answersSaved": { uk: "Відповіді збережено", ru: "Ответы сохранены", en: "Answers saved" },
  "ms.saved": { uk: "збережено", ru: "сохранено", en: "saved" },
  "ms.requiredQuestion": { uk: "Обов’язкове питання", ru: "Обязательный вопрос", en: "Required question" },
  "mp.server": { uk: "Сервер", ru: "Сервер", en: "Server" },
  "surveys.emptyAdmin": {
    uk: "Методик поки немає. Створіть першу у вкладці «Конструктор».",
    ru: "Методик пока нет. Создайте первую во вкладке «Конструктор».",
    en: "No instruments yet. Create the first one in the “Builder” tab.",
  },

  /* мобильная аналитика */
  "ma.loadFailed": { uk: "Не вдалося завантажити аналітику", ru: "Не удалось загрузить аналитику", en: "Could not load analytics" },
  "ma.overview": { uk: "Зведення", ru: "Сводка", en: "Overview" },
  "ma.openCases": { uk: "Відкриті випадки ризику", ru: "Открытые случаи риска", en: "Open risk cases" },
  "ma.cases": { uk: "Випадки ризику", ru: "Случаи риска", en: "Risk cases" },
  "ma.responses": { uk: "Проходжень", ru: "Прохождений", en: "Completions" },
  "ma.respondents": { uk: "Респондентів", ru: "Респондентов", en: "Respondents" },
  "ma.surveys": { uk: "Методик", ru: "Методик", en: "Instruments" },
  "ma.avgTime": { uk: "Середній час", ru: "Среднее время", en: "Average time" },
  "ma.trend": { uk: "Динаміка проходжень", ru: "Динамика прохождений", en: "Completion dynamics" },
  "ma.trendHint": { uk: "Завершені проходження за днями", ru: "Завершённые прохождения по дням", en: "Completed tests by day" },
  "ma.severityAll": { uk: "Вираженість за всіма шкалами", ru: "Выраженность по всем шкалам", en: "Severity across all scales" },
  "ma.severityHint": { uk: "Скільки результатів потрапило до кожної категорії норм", ru: "Сколько результатов попало в каждую категорию норм", en: "How many results fell into each norm category" },
  "ma.allSurveys": { uk: "Усі методики", ru: "Все методики", en: "All instruments" },
  "ma.pickSurvey": { uk: "Виберіть методику, щоб відкрити зрізи", ru: "Выберите методику, чтобы открыть срезы", en: "Select an instrument to open its breakdowns" },
  "ma.byResponses": { uk: "Методики за кількістю проходжень", ru: "Методики по числу прохождений", en: "Instruments by number of completions" },
  "mal.confirmed": { uk: "Ризик підтверджено", ru: "Риск подтверждён", en: "Risk confirmed" },
  "mal.needsFollowup": { uk: "Потребує спостереження", ru: "Требует наблюдения", en: "Needs follow-up" },
  "mal.notConfirmed": { uk: "Ризик не підтверджено", ru: "Риск не подтверждён", en: "Risk not confirmed" },
  "mal.loadFailed": { uk: "Не вдалося завантажити випадки", ru: "Не удалось загрузить случаи", en: "Could not load cases" },
  "mal.saveFailed": { uk: "Не вдалося зберегти", ru: "Не удалось сохранить", en: "Could not save" },
  "mal.title": { uk: "Розбір випадків", ru: "Разбор случаев", en: "Case review" },
  "mal.none": { uk: "Випадків немає", ru: "Случаев нет", en: "No cases" },
  "mal.urgent": { uk: "Терміново", ru: "Срочно", en: "Urgent" },
  "mal.attention": { uk: "Увага", ru: "Внимание", en: "Attention" },
  "mal.take": { uk: "Взяти на себе", ru: "Взять на себя", en: "Take on" },
  "mal.whatDone": { uk: "Що вжито", ru: "Что предпринято", en: "Action taken" },
  "mal.example": { uk: "Наприклад: огляд призначено на сьогодні", ru: "Например: осмотр назначен на сегодня", en: "For example: examination scheduled for today" },
  "mal.loadMore": { uk: "Показати ще", ru: "Показать ещё", en: "Show more" },
  "mnav.exit": { uk: "Вийти з аналітики", ru: "Выйти из аналитики", en: "Exit analytics" },
  "mnav.analytics": { uk: "Аналітика", ru: "Аналитика", en: "Analytics" },
  "mnav.survey": { uk: "Методика", ru: "Методика", en: "Instrument" },
  "mnav.responses": { uk: "Проходження", ru: "Прохождения", en: "Completions" },
  "mnav.alerts": { uk: "Тривоги", ru: "Тревоги", en: "Alerts" },
  "mnav.patients": { uk: "Пацієнти", ru: "Пациенты", en: "Patients" },
  "msv.version": { uk: "Версія методики", ru: "Версия методики", en: "Instrument version" },
  "msv.general": { uk: "Загальне", ru: "Общее", en: "General" },
  "msv.questions": { uk: "Питання", ru: "Вопросы", en: "Questions" },
  "msv.scales": { uk: "Шкали", ru: "Шкалы", en: "Scales" },
  "msv.completed": { uk: "Завершено", ru: "Завершено", en: "Completed" },
  "msv.completion": { uk: "Доходимість", ru: "Доходимость", en: "Completion rate" },
  "msv.median": { uk: "Медіана", ru: "Медиана", en: "Median" },
  "msv.dynamics": { uk: "Динаміка", ru: "Динамика", en: "Dynamics" },
  "msv.abandoned": { uk: "Покинуто", ru: "Брошено", en: "Abandoned" },
  "msv.dropoff": { uk: "Де губляться респонденти", ru: "Где теряются респонденты", en: "Where respondents drop off" },
  "msv.dropoffHint": { uk: "Скільки людей дійшло до кожного питання", ru: "Сколько человек дошло до каждого вопроса", en: "How many people reached each question" },
  "msv.responseList": { uk: "Список проходжень", ru: "Список прохождений", en: "Completion list" },
  "msv.timePerQuestion": { uk: "Час відповіді за питаннями", ru: "Время ответа по вопросам", en: "Response time by question" },
  "msv.timeHint": { uk: "Розкид, а не лише середнє: два однакові середні можуть поводитися по-різному", ru: "Разброс, а не только среднее: две одинаковые средние могут вести себя по-разному", en: "Spread, not just the mean: two identical means can behave differently" },
  "msv.optionSpread": { uk: "Розподіл виборів", ru: "Распределение выборов", en: "Choice distribution" },
  "msv.optionSpreadHint": { uk: "Частка респондентів за кожним варіантом, % від тих, хто відповів", ru: "Доля респондентов по каждому варианту, % от ответивших", en: "Share of respondents for each option, % of those who answered" },
  "msv.doubts": { uk: "Сумніви під час відповіді", ru: "Сомнения при ответе", en: "Hesitation while answering" },
  "msv.doubtsHint": { uk: "Частка респондентів, які змінювали відповідь — маркер неоднозначного формулювання", ru: "Доля респондентов, менявших ответ — маркер неоднозначной формулировки", en: "Share of respondents who changed their answer — a marker of ambiguous wording" },
  "msv.subscales": { uk: "Порівняння субшкал", ru: "Сравнение субшкал", en: "Subscale comparison" },
  "msv.subscalesHint": { uk: "Розкид балів за кожною шкалою в одному масштабі", ru: "Разброс баллов по каждой шкале в одном масштабе", en: "Score spread for each scale on a common axis" },
  "msv.itemTotal": { uk: "Зв’язок пункту зі своєю шкалою", ru: "Связь пункта со своей шкалой", en: "Item correlation with its scale" },
  "msv.careless": { uk: "Ознаки недбалого заповнення", ru: "Признаки небрежного заполнения", en: "Signs of careless responding" },
  "msv.timeVsFast": { uk: "Час проти частки швидких відповідей", ru: "Время против доли быстрых ответов", en: "Time vs. share of fast answers" },
  "mrs.loadFailed": { uk: "Не вдалося завантажити проходження", ru: "Не удалось загрузить прохождения", en: "Could not load completions" },
  "mrs.none": { uk: "Проходжень поки немає", ru: "Прохождений пока нет", en: "No completions yet" },
  "mrs.anon": { uk: "Анонім", ru: "Аноним", en: "Anonymous" },
  /*
   * Стояло литералом по-русски рядом с датой сдачи и на украинском экране
   * оставалось русским. Сторож на строки его не увидел: литерал сидит в
   * тернарнике после .replace("T", " "), и разбор кавычек сползает на одну —
   * та же нечётность, из-за которой в самом стороже режут комментарии
   * последними. Чинится строка, а не сторож: подпирать проверку ради одного
   * места дороже, чем убрать это место.
   */
  "mrs.notSubmitted": { uk: "не завершено", ru: "не завершено", en: "not completed" },
  "mrs.answersAndTime": { uk: "Відповіді й час за питаннями", ru: "Ответы и время по вопросам", en: "Answers and time by question" },
  "mdy.loadFailed": { uk: "Не вдалося завантажити динаміку", ru: "Не удалось загрузить динамику", en: "Could not load dynamics" },
  "mdy.noCompleted": { uk: "Завершених проходжень немає", ru: "Завершённых прохождений нет", en: "No completed tests" },
  "mdy.profile": { uk: "Профіль за субшкалами", ru: "Профиль по субшкалам", en: "Subscale profile" },
  "mdy.lastVsFirst": { uk: "Останній замір проти першого", ru: "Последний замер против первого", en: "Latest measurement vs. first" },
  "mdy.last": { uk: "Останній замір", ru: "Последний замер", en: "Latest measurement" },
  "mdy.first": { uk: "Перший замір", ru: "Первый замер", en: "First measurement" },
  "mdy.conclusion": { uk: "Висновок за останнім заміром", ru: "Заключение по последнему замеру", en: "Conclusion for the latest measurement" },

  /* мобильные компоненты и графики */
  "mnav.instrument": { uk: "Методика", ru: "Методика", en: "Instrument" },
  "mpt.loadFailed": { uk: "Не вдалося завантажити список", ru: "Не удалось загрузить список", en: "Could not load the list" },
  "mpt.title": { uk: "Пацієнти", ru: "Пациенты", en: "Patients" },
  "mpt.sub": { uk: "Лише ті, хто проходив методики ваших груп", ru: "Только те, кто проходил методики ваших групп", en: "Only those who have taken instruments of your groups" },
  "msv.completedVsAbandoned": { uk: "Завершені проти покинутих", ru: "Завершённые против брошенных", en: "Completed vs. abandoned" },
  "msv.fastHint": { uk: "Точки біля лівого краю — пройшли методику швидше, ніж її можна прочитати", ru: "Точки у левого края — прошли методику быстрее, чем её можно прочесть", en: "Points near the left edge completed the instrument faster than it can be read" },
  "msv.noSuspicious": { uk: "Підозрілих проходжень не знайдено", ru: "Подозрительных прохождений не найдено", en: "No suspicious completions found" },
  "msv.alpha": { uk: "Альфа Кронбаха", ru: "Альфа Кронбаха", en: "Cronbach's alpha" },
  "msv.spread": { uk: "Розкид", ru: "Разброс", en: "Spread" },
  "msv.thoughtBefore": { uk: "Думав до першого вибору", ru: "Думал до первого выбора", en: "Time before first choice" },
  "msv.changesAvg": { uk: "Змін відповіді в середньому", ru: "Смен ответа в среднем", en: "Answer changes on average" },
  "msv.changedAnswer": { uk: "Змінювали відповідь", ru: "Меняли ответ", en: "Changed their answer" },
  "msv.tooFast": { uk: "Відповіли занадто швидко", ru: "Отвечено слишком быстро", en: "Answered too fast" },
  "mob.resolve": { uk: "Розібрати", ru: "Разобрать", en: "Review" },
  "mob.sending": { uk: "Відправляю…", ru: "Отправляю…", en: "Sending…" },
  "mch.noDistribution": { uk: "Немає даних для розподілу", ru: "Нет данных для распределения", en: "No data for a distribution" },
  "mch.noNumeric": { uk: "Немає числових відповідей", ru: "Нет числовых ответов", en: "No numeric answers" },
  "mch.noResponses": { uk: "Проходжень поки немає", ru: "Прохождений пока нет", en: "No completions yet" },
  "mqi.rankHint": { uk: "Натискайте в порядку важливості — від найважливішого до найменш важливого", ru: "Нажимайте в порядке важности — от самого важного к наименее важному", en: "Tap in order of importance — from most to least important" },
  "mqi.yourAnswer": { uk: "Ваша відповідь", ru: "Ваш ответ", en: "Your answer" },
  "mviz.noData": { uk: "Даних поки немає", ru: "Данных пока нет", en: "No data yet" },
  "mviz.funnelHint": { uk: "Звуження показує, на якому питанні респонденти припиняють проходження", ru: "Сужение показывает, на каком вопросе респонденты прекращают прохождение", en: "The narrowing shows at which question respondents stop the test" },
  "mviz.boxHint": { uk: "Ящик — міжквартильний розмах, жирна риска — медіана, вуса — крайні значення", ru: "Ящик — межквартильный размах, жирная черта — медиана, усы — крайние значения", en: "Box — interquartile range, bold line — median, whiskers — extreme values" },
  "mviz.heatHint": { uk: "Насиченість кодує величину; значення продубльовано числом", ru: "Насыщенность кодирует величину; значение продублировано числом", en: "Saturation encodes magnitude; the value is also shown as a number" },
  "mviz.current": { uk: "Поточний", ru: "Текущий", en: "Current" },
  "mviz.previous": { uk: "Попередній", ru: "Предыдущий", en: "Previous" },
  "mviz.radarHint": { uk: "Осі нормовані до максимуму своєї субшкали, тому порівнянна форма профілю", ru: "Оси нормированы к максимуму своей субшкалы, поэтому сравнима форма профиля", en: "Axes are normalized to the maximum of their subscale, so the profile shape is comparable" },
  "mlock.locked": { uk: "Застосунок замкнено", ru: "Приложение заперто", en: "App locked" },
  "msv.alphaVeryHigh": { uk: "дуже висока", ru: "очень высокая", en: "very high" },
  "msv.alphaGood": { uk: "добра", ru: "хорошая", en: "good" },
  "msv.alphaOk": { uk: "прийнятна", ru: "приемлемая", en: "acceptable" },
  "msv.alphaLow": { uk: "низька", ru: "низкая", en: "low" },

  /* мобильный конструктор и замок */
  "mlock.confirm": { uk: "Підтвердьте особу, щоб продовжити", ru: "Подтвердите личность, чтобы продолжить", en: "Confirm your identity to continue" },
  "mlock.unlock": { uk: "Розблокувати", ru: "Разблокировать", en: "Unlock" },

  /* палитра команд */
  "cmd.title": { uk: "Команди", ru: "Команды", en: "Commands" },
  "cmd.placeholder": { uk: "Прізвище, екран або дія…", ru: "Фамилия, экран или действие…", en: "Last name, screen or action…" },
  "cmd.nothing": { uk: "Нічого не знайдено", ru: "Ничего не найдено", en: "Nothing found" },
  "cmd.people": { uk: "Люди", ru: "Люди", en: "People" },
  "cmd.navigate": { uk: "Перейти", ru: "Перейти", en: "Go to" },
  "cmd.actions": { uk: "Дії", ru: "Действия", en: "Actions" },
  "cmd.view": { uk: "Вигляд", ru: "Вид", en: "View" },
  "cmd.theme": { uk: "Перемкнути тему", ru: "Переключить тему", en: "Toggle theme" },
  "cmd.density": { uk: "Перемкнути щільність", ru: "Переключить плотность", en: "Toggle density" },
  "cmd.newSurvey": { uk: "Створити методику", ru: "Создать методику", en: "Create instrument" },
  "cmd.newInvite": { uk: "Створити запрошення", ru: "Создать приглашение", en: "Create invitation" },
  "cmd.move": { uk: "рух", ru: "движение", en: "move" },
  "cmd.open": { uk: "відкрити", ru: "открыть", en: "open" },
  "cmd.close": { uk: "закрити", ru: "закрыть", en: "close" },
  "shell.search": { uk: "Пошук і команди", ru: "Поиск и команды", en: "Search and commands" },
  /*
   * Имя рельсы. Нужно там, где она выезжает поверх содержимого: ящик,
   * перекрывающий экран, диктор обязан назвать, иначе человек не понимает,
   * почему остальная страница перестала отвечать.
   */
  "shell.sections": { uk: "Розділи консолі", ru: "Разделы консоли", en: "Console sections" },
  "shell.collapse": { uk: "Згорнути меню", ru: "Свернуть меню", en: "Collapse menu" },
  "shell.expand": { uk: "Розгорнути меню", ru: "Развернуть меню", en: "Expand menu" },

  /* хронология пациента */
  "tl.title": { uk: "Хронологія", ru: "Хронология", en: "Timeline" },
  "tl.sub": { uk: "Проходження, тривоги, направлення та висновки на одній осі", ru: "Прохождения, тревоги, направления и заключения на одной оси", en: "Completions, alerts, referrals and conclusions on one axis" },
  "tl.empty": { uk: "Подій немає", ru: "Событий нет", en: "No events" },
  "tl.emptyHint": { uk: "У зоні вашої відповідальності за цією людиною ще нічого не відбувалося", ru: "В зоне вашей ответственности по этому человеку ещё ничего не происходило", en: "Nothing has happened with this person within your area of responsibility yet" },
  "tl.response": { uk: "проходження", ru: "прохождение", en: "completion" },
  "tl.alert": { uk: "тривога", ru: "тревога", en: "alert" },
  "tl.referral": { uk: "направлення", ru: "направление", en: "referral" },
  "tl.conclusion": { uk: "висновок", ru: "заключение", en: "conclusion" },
  "tl.assignment": { uk: "призначення", ru: "назначение", en: "assignment" },
  "mp.theme": { uk: "Тема", ru: "Тема", en: "Theme" },
  "mp.themeSystem": { uk: "Системна", ru: "Системная", en: "System" },
  "mp.themeDark": { uk: "Темна", ru: "Тёмная", en: "Dark" },
  "mp.themeLight": { uk: "Світла", ru: "Светлая", en: "Light" },

  /* центр событий */
  "ev.title": { uk: "Події", ru: "События", en: "Events" },
  "ev.empty": { uk: "Поки тихо", ru: "Пока тихо", en: "All quiet for now" },
  "ev.response": { uk: "здано методику", ru: "сдана методика", en: "instrument submitted" },
  "ev.schedule": { uk: "спрацювало розклад", ru: "сработало расписание", en: "schedule triggered" },
  "ev.presence": { uk: "хтось відкрив той самий екран", ru: "кто-то открыл тот же экран", en: "someone opened the same screen" },
  "ev.action": { uk: "дія в журналі", ru: "действие в журнале", en: "audit log action" },
  "ev.sessionOnly": { uk: "за цю сесію", ru: "за эту сессию", en: "for this session" },
  "ev.alert": { uk: "нова тривога", ru: "новая тревога", en: "new alert" },
  "ev.case": { uk: "випадок змінився", ru: "случай изменился", en: "case changed" },

  /* сохранённые виды */
  "views.save": { uk: "Зберегти вигляд", ru: "Сохранить вид", en: "Save view" },
  "views.saveHint": {
    uk: "Назвати поточний зріз, щоб не збирати його щоразу",
    ru: "Назвать текущий срез, чтобы не собирать его каждый раз",
    en: "Name the current slice so you do not have to rebuild it each time",
  },
  "views.namePlaceholder": { uk: "Наприклад: мої прострочені", ru: "Например: мои просроченные", en: "For example: my overdue" },
  "views.saved": { uk: "Вигляд збережено", ru: "Вид сохранён", en: "View saved" },
  "views.remove": { uk: "Видалити вигляд", ru: "Удалить вид", en: "Delete view" },
  "views.removed": { uk: "Вигляд видалено", ru: "Вид удалён", en: "View deleted" },
  "views.makeShared": { uk: "Відкрити колегам", ru: "Открыть коллегам", en: "Share with colleagues" },
  "views.makePersonal": { uk: "Зробити особистим", ru: "Сделать личным", en: "Make personal" },
  "views.madeShared": { uk: "Вигляд відкрито колегам", ru: "Вид открыт коллегам", en: "View shared with colleagues" },
  "views.madePersonal": { uk: "Вигляд знову особистий", ru: "Вид снова личный", en: "View is personal again" },

  /* маршруты помощи */

  /* заметки приёма */
  "note.title": { uk: "Записи прийому", ru: "Записи приёма", en: "Appointment notes" },
  "note.history": { uk: "Історія", ru: "История", en: "History" },
  "note.version": { uk: "версія", ru: "версия", en: "version" },
  "note.draft": { uk: "чернетка", ru: "черновик", en: "draft" },
  "note.signedAt": { uk: "підписано", ru: "подписано", en: "signed" },
  "note.saveDraft": { uk: "Зберегти чернеткою", ru: "Сохранить черновиком", en: "Save as draft" },
  "note.sign": { uk: "Підписати", ru: "Подписать", en: "Sign" },
  "note.signed": { uk: "Запис підписано", ru: "Запись подписана", en: "Note signed" },
  "note.loadFailed": { uk: "Записи не завантажилися", ru: "Записи не загрузились", en: "Notes did not load" },
  "note.placeholder": {
    uk: "Скарги, спостереження, домовленості, план",
    ru: "Жалобы, наблюдение, договорённости, план",
    en: "Complaints, observations, agreements, plan",
  },
  "note.placeholderNext": {
    uk: "Новий запис поверх підписаного",
    ru: "Новая запись поверх подписанной",
    en: "New note over the signed one",
  },
  "note.intake": { uk: "Первинний", ru: "Первичный", en: "Intake" },
  "note.session": { uk: "Прийом", ru: "Приём", en: "Appointment" },
  "note.observation": { uk: "Спостереження", ru: "Наблюдение", en: "Observation" },
  "note.consult": { uk: "Консультація", ru: "Консультация", en: "Consultation" },

  /* план безопасности */
  "sp.title": { uk: "План безпеки", ru: "План безопасности", en: "Safety plan" },
  "sp.hint": {
    uk: "Особистий план людини, а не інструкція методики: що робити самому, коли поруч нікого немає. Порядок розділів відтворює порядок дій у кризі.",
    ru: "Личный план человека, а не инструкция методики: что делать самому, когда рядом никого нет. Порядок разделов воспроизводит порядок действий в кризисе.",
    en: "The person's own plan, not an instrument's instructions: what to do on their own when no one is around. The order of sections follows the order of actions in a crisis.",
  },
  "sp.none": { uk: "плану немає", ru: "плана нет", en: "no plan" },
  "sp.create": { uk: "Скласти план", ru: "Составить план", en: "Create plan" },
  "sp.revise": { uk: "Переглянути", ru: "Пересмотреть", en: "Revise" },
  "sp.print": { uk: "Друк", ru: "Печать", en: "Print" },
  "sp.version": { uk: "версія", ru: "версия", en: "version" },
  "sp.saved": { uk: "План збережено новою версією", ru: "План сохранён новой версией", en: "Plan saved as a new version" },
  "sp.saveVersion": { uk: "Зберегти новою версією", ru: "Сохранить новой версией", en: "Save as new version" },
  "sp.warningSigns": { uk: "Ознаки, за якими впізнаю кризу", ru: "Признаки, по которым узнаю кризис", en: "Signs by which I recognize a crisis" },
  "sp.coping": { uk: "Що можу зробити сам", ru: "Что могу сделать сам", en: "What I can do myself" },
  "sp.distractions": { uk: "Що відволікає: заняття та місця", ru: "Что отвлекает: занятия и места", en: "What distracts me: activities and places" },
  "sp.people": { uk: "До кого можу звернутися", ru: "К кому могу обратиться", en: "Who I can turn to" },
  "sp.professionals": { uk: "Фахівці та чергові служби", ru: "Специалисты и дежурные службы", en: "Professionals and crisis services" },
  "sp.means": { uk: "Обмеження доступу до засобів", ru: "Ограничение доступа к средствам", en: "Restricting access to means" },
  "sp.meansHint": {
    uk: "Єдиний розділ, який знижує ризик, а не допомагає його пережити. Обговорюється завжди.",
    ru: "Единственный раздел, который снижает риск, а не помогает его пережить. Обсуждается всегда.",
    en: "The only section that lowers the risk rather than helping to get through it. Always discussed.",
  },
  "sp.reasons": { uk: "Заради чого варто жити", ru: "Ради чего стоит жить", en: "What makes life worth living" },
  "sp.addLine": { uk: "Додати рядок", ru: "Добавить строку", en: "Add line" },
  "sp.ownWords": { uk: "Своїми словами", ru: "Своими словами", en: "In your own words" },
  "sp.who": { uk: "Хто", ru: "Кто", en: "Who" },
  "sp.contact": { uk: "Як зв’язатися", ru: "Как связаться", en: "How to contact" },
  "msp.none": {
    uk: "Плану поки немає. Його складають разом із фахівцем — попросіть на найближчому прийомі.",
    ru: "Плана пока нет. Его составляют вместе со специалистом — попросите на ближайшем приёме.",
    en: "There is no plan yet. It is made together with a specialist — ask for it at your next appointment.",
  },
  "msp.offlineHint": {
    uk: "План зберігається на пристрої й відкривається без мережі",
    ru: "План хранится на устройстве и открывается без сети",
    en: "The plan is stored on the device and opens without a network",
  },
  "tab.safety": { uk: "План безпеки", ru: "План безопасности", en: "Safety plan" },

  /* цели лечения */
  /* подтверждаемость тревог: справочная карточка сводки */
  "cl.rightsUnclear": { uk: "права не з’ясовано", ru: "права не выяснены", en: "rights unclear" },
  "cl.rightsHint": {
    uk: "Правовий статус тексту методики не з’ясовано. Перед клінічним застосуванням це треба вирішити.",
    ru: "Правовой статус текста методики не выяснен. Перед клиническим применением это нужно решить.",
    en: "The legal status of the instrument's text has not been clarified. This must be resolved before clinical use.",
  },

  /* консилиум */

  /* редактор маршрута */

  /* строки, вычищенные из разметки: см. apps/web/test/uiStrings.test.ts */
  "acc.restrictHint": {
    uk: "Щоб обмежити доступ, перемкніть видимість методики на «за призначенням».",
    ru: "Чтобы ограничить доступ, переключите видимость методики на «по назначению».",
    en: "To restrict access, switch the instrument's visibility to “by assignment”.",
  },
  "acc.yes": { uk: "так", ru: "да", en: "yes" },
  "adm.confirmDeleteGroup": { uk: "Видалити групу", ru: "Удалить группу", en: "Delete group" },
  "adm.create": { uk: "Створити", ru: "Создать", en: "Create" },
  "adm.methodsCount": { uk: "методик", ru: "методик", en: "instruments" },
  "adm.responsesCount": { uk: "проходжень", ru: "прохождений", en: "completions" },
  "adn.unansweredRequired": { uk: "не заповнено обов’язкових:", ru: "не заполнено обязательных:", en: "required unanswered:" },
  "an.answeredAbbr": { uk: "відп.", ru: "отв.", en: "answered" },
  "an.codebookExported": { uk: "Codebook вивантажено", ru: "Codebook выгружен", en: "Codebook exported" },
  "an.exportsNote": {
    uk: "Матриця та синтаксис — пара: покладіть їх поруч і запустіть синтаксис, він підставить мітки змінних і значень. Пропуски закодовані як −99. Деідентифікований профіль замінює суб’єктів незворотними кодами (стабільними між вивантаженнями — лонгітюд склеюється), вік смугами, дату місяцем; підрозділ і звання не вивантажуються. Кожне вивантаження фіксується в журналі з SHA-256 датасета.",
    ru: "Матрица и синтаксис — пара: положите их рядом и запустите синтаксис, он подставит метки переменных и значений. Пропуски закодированы как −99. Деидентифицированный профиль заменяет субъектов необратимыми кодами (стабильными между выгрузками — лонгитюд склеивается), возраст полосами, дату месяцем; подразделение и звание не выгружаются. Каждая выгрузка фиксируется в журнале с SHA-256 датасета.",
    en: "The matrix and the syntax file are a pair: put them side by side and run the syntax — it will apply the variable and value labels. Missing values are coded as −99. The de-identified profile replaces subjects with irreversible codes (stable across exports, so longitudinal data can be linked), age with bands, and date with month; unit and rank are not exported. Every export is recorded in the audit log with the dataset's SHA-256.",
  },
  "an.flagHint": {
    uk: "Це прапорець для перевірки фахівцем, а не підстава виключати дані.",
    ru: "Это флаг для проверки специалистом, а не основание исключать данные.",
    en: "This is a flag for review by a specialist, not grounds for excluding data.",
  },
  "an.inProgressNow": { uk: "Зараз проходять:", ru: "Сейчас проходят:", en: "In progress now:" },
  "an.longExported": { uk: "Long-format вивантажено", ru: "Long-format выгружен", en: "Long format exported" },
  "an.noInterpretiveNorms": {
    uk: "У шкали немає інтерпретаційних норм — вона використовується як службова",
    ru: "У шкалы нет интерпретационных норм — она используется как служебная",
    en: "The scale has no interpretive norms — it is used as an auxiliary scale",
  },
  "an.questionAbbr": { uk: "П", ru: "В", en: "Q" },
  "an.secAbbr": { uk: "с", ru: "с", en: "s" },
  "api.routesCount": { uk: "маршрутів", ru: "маршрутов", en: "routes" },
  "api.routesDescription": {
    uk: "Шляхи та методи виведені з таблиці маршрутів застосунку, тому розійтися з кодом не можуть. Схеми тіл узяті з перевіряючих схем — тих самих, що застосовуються до запиту.",
    ru: "Пути и методы выведены из таблицы маршрутов приложения, поэтому разойтись с кодом не могут. Схемы тел взяты из проверяющих схем — то же, что применяется к запросу.",
    en: "Paths and methods are derived from the application's route table, so they cannot drift from the code. Body schemas are taken from the validation schemas — the same ones applied to the request.",
  },
  "api.routesFallbackTag": { uk: "інше", ru: "прочее", en: "other" },
  "aud.outcomeDenied": { uk: "відмовлено", ru: "отказано", en: "denied" },
  "aud.outcomeError": { uk: "помилка", ru: "ошибка", en: "error" },
  "aud.outcomeOk": { uk: "ок", ru: "ок", en: "ok" },
  "aud.retentionNote": {
    uk: "answer_events стримується ретенцією; audit_log росте вічно by design — його партиціонування за місяцями стане актуальним після перших мільйонів записів.",
    ru: "answer_events сдерживается ретенцией; audit_log растёт вечно by design — его партиционирование по месяцам станет актуальным после первых миллионов записей.",
    en: "answer_events is kept in check by retention; audit_log grows forever by design — partitioning it by month will become relevant after the first few million records.",
  },
  "blank.answerEachHint": {
    uk: "Відповідайте на кожен пункт. Пропущені пункти знижують достовірність результату.",
    ru: "Отвечайте на каждый пункт. Пропущенные пункты снижают достоверность результата.",
    en: "Answer every item. Skipped items reduce the validity of the result.",
  },
  "blank.differentOptionsNote": {
    uk: "Варіанти в пунктів відрізняються, тому вони надруковані при кожному.",
    ru: "Варианты у пунктов различаются, поэтому они напечатаны при каждом.",
    en: "Answer options differ between items, so they are printed with each item.",
  },
  "blank.paperIntro": {
    uk: "Бланк для паперового проведення. Після заповнення відповіді вносяться через «Провести» — нумерація збігається, звіряти порядок не потрібно.",
    ru: "Бланк для бумажного проведения. После заполнения ответы вносятся через «Провести» — нумерация совпадает, сверять порядок не нужно.",
    en: "Answer sheet for paper administration. Once it is filled in, the answers are entered via “Administer” — the numbering matches, so there is no need to check the order.",
  },
  "blank.sameOptionsNote": {
    uk: "Варіанти однакові в усіх пунктів, тому бланк виведено таблицею.",
    ru: "Варианты одинаковы у всех пунктов, поэтому бланк выведен таблицей.",
    en: "Answer options are the same for all items, so the answer sheet is shown as a table.",
  },
  "bp.addPrefix": { uk: "Додати", ru: "Добавить", en: "Add" },
  "bp.duplicateSuffix": { uk: "зустрічається двічі", ru: "встречается дважды", en: "appears twice" },
  "bp.firstItem": { uk: "перший", ru: "первый", en: "first" },
  "bp.hint": {
    uk: "Скопіюйте пункти з посібника — по одному на рядок, з номерами або без. Номери «1.», «1)» зрізаються; рядок без номера приклеюється до попереднього пункту (переноси з PDF).",
    ru: "Скопируйте пункты из пособия — по одному на строку, с номерами или без. Номера «1.», «1)» срезаются; строка без номера приклеивается к предыдущему пункту (переносы из PDF).",
    en: "Copy the items from the manual — one per line, with or without numbers. Numbers like “1.” or “1)” are stripped; a line without a number is joined to the previous item (line breaks from a PDF).",
  },
  "bp.langRu": { uk: "російська", ru: "русский", en: "Russian" },
  "bp.langUk": { uk: "українська", ru: "украинский", en: "Ukrainian" },
  "bp.lastItem": { uk: "останній", ru: "последний", en: "last" },
  "bp.missingNumber": { uk: "Пропущено номер", ru: "Пропущен номер", en: "Missing number" },
  "bp.numberWord": { uk: "Номер", ru: "Номер", en: "Number" },
  "bp.numberingWarn": {
    uk: "Нумерація підозріла — перевірте вихідний текст:",
    ru: "Нумерация подозрительна — проверьте исходный текст:",
    en: "The numbering looks suspicious — check the source text:",
  },
  "bp.placeholderExample": {
    uk: "1. Чи може життя втратити цінність? / 2. Життя іноді гірше за смерть. / …",
    ru: "1. Может ли жизнь потерять ценность? / 2. Жизнь иногда хуже смерти. / …",
    en: "1. Can life lose its value? / 2. Life is sometimes worse than death. / …",
  },
  "bp.recognizedCount": { uk: "Розпізнано пунктів", ru: "Распознано пунктов", en: "Items recognized" },
  "bt.assignHint": {
    uk: "Призначення відкриває доступ до всіх методик набору. Строк призначення стає строком доступу: після нього методики знову приховані.",
    ru: "Назначение открывает доступ ко всем методикам набора. Срок назначения становится сроком доступа: после него методики снова скрыты.",
    en: "An assignment opens access to all instruments in the battery. The assignment deadline becomes the access deadline: after it, the instruments are hidden again.",
  },
  "bt.assignedToast": { uk: "Набір призначено:", ru: "Набор назначен:", en: "Battery assigned:" },
  "bt.cancelledOn": { uk: "знято", ru: "снято", en: "removed" },
  "bt.overdueNote": { uk: "прострочено", ru: "просрочено", en: "overdue" },
  "bt.required": { uk: "обов’язкова", ru: "обязательная", en: "required" },
  "bt.requiredGen": { uk: "обов’язкових", ru: "обязательных", en: "required" },
  "bt.stepAvailable": { uk: "доступна", ru: "доступна", en: "available" },
  "bt.stepCurrent": { uk: "наступна", ru: "следующая", en: "next" },
  "bt.stepDone": { uk: "пройдена", ru: "пройдена", en: "completed" },
  "bt.stepLocked": { uk: "відкриється пізніше", ru: "откроется позже", en: "opens later" },
  "bt.stepsDoneWord": { uk: "пройдено", ru: "пройдено", en: "completed" },
  "bt.strictOrderHint": {
    uk: "При суворому порядку наступна методика відкривається лише після попередньої. Це важливо там, де втома від довгого опитувальника спотворює результат короткого.",
    ru: "При строгом порядке следующая методика открывается только после предыдущей. Это важно там, где утомление от длинного опросника искажает результат короткого.",
    en: "With strict order, the next instrument opens only after the previous one. This matters where fatigue from a long questionnaire distorts the result of a short one.",
  },
  "cb.thresholdsHint": {
    uk: "Поріг «занадто швидко» задається окремо: матричне питання потребує помітно більше часу, ніж «так/ні», і загальний поріг або пропускає недбалість, або обмовляє",
    ru: "Порог «слишком быстро» задаётся отдельно: матричный вопрос требует заметно больше времени, чем «да/нет», и общий порог либо пропускает небрежность, либо клевещет",
    en: "The “too fast” threshold is set separately: a matrix question takes noticeably longer than a “yes/no” one, and a shared threshold either lets carelessness through or falsely flags honest answers",
  },
  "chart.flaggedCareless": { uk: "позначені як недбалі", ru: "помечены как небрежные", en: "flagged as careless" },
  "chart.lowCorrPrefix": { uk: "Пункти зі зв’язком нижче", ru: "Пункты со связью ниже", en: "Items with a correlation below" },
  "chart.lowCorrSuffix": {
    uk: "виділені — вони погано узгоджуються зі шкалою",
    ru: "выделены — они плохо согласуются со шкалой",
    en: "are highlighted — they fit poorly with the scale",
  },
  "chart.radarNormNote": {
    uk: "Осі нормовані до максимуму своєї субшкали — порівнянна форма профілю цілком",
    ru: "Оси нормированы к максимуму своей субшкалы — сравнима форма профиля целиком",
    en: "Axes are normalized to the maximum of their subscale — the shape of the profile as a whole is comparable",
  },
  "cl.archiveButton": { uk: "Зняти", ru: "Снять", en: "Retire" },
  "cl.archiveWarnBody": {
    uk: "Методику перестануть видавати й проходити: вона зникне зі списків, наборів, кіоска й розкладів.",
    ru: "Методику перестанут выдавать и проходить: она исчезнет из списков, наборов, киоска и расписаний.",
    en: "The instrument will no longer be issued or taken: it will disappear from lists, batteries, the kiosk and schedules.",
  },
  "cl.duplicateAction": { uk: "Копія", ru: "Копия", en: "Copy" },
  "cl.responsesKeptPrefix": { uk: "Зібрані проходження", ru: "Собранные прохождения", en: "Collected completions" },
  "cl.responsesKeptSuffix": {
    uk: "залишаться на місці — у картці пацієнта, аналітиці й журналі. Рішення оборотне.",
    ru: "останутся на месте — в карте пациента, аналитике и журнале. Решение обратимо.",
    en: "will stay in place — in the patient card, analytics and the audit log. This can be undone.",
  },
  "cl.restoreAction": { uk: "Повернути в роботу", ru: "Вернуть в работу", en: "Return to use" },
  "cl.retiredOn": { uk: "Знято", ru: "Снята", en: "Retired on" },
  "cnc.draftWord": { uk: "чернетка", ru: "черновик", en: "draft" },
  "cnc.editCreatesVersion": {
    uk: "Правка створить нову версію — підписаний текст незмінний.",
    ru: "Правка создаст новую версию — подписанный текст неизменен.",
    en: "Editing will create a new version — the signed text stays unchanged.",
  },
  "cnc.onlySignedInReport": {
    uk: "У друкований звіт потрапляє лише підписана версія. Чернетка видна лише персоналу.",
    ru: "В печатный отчёт попадает только подписанная версия. Черновик виден только персоналу.",
    en: "Only the signed version goes into the printed report. The draft is visible to staff only.",
  },
  "cnc.saveDraft": { uk: "Зберегти чернетку", ru: "Сохранить черновик", en: "Save draft" },
  "cnc.showHistory": { uk: "Історія", ru: "История", en: "History" },
  "cnc.signedBy": { uk: "Підписано:", ru: "Подписано:", en: "Signed by:" },
  "cnc.signedOn": { uk: "підписана", ru: "подписана", en: "signed" },
  "cnc.versionN": { uk: "Версія", ru: "Версия", en: "Version" },
  "co.checkHint": {
    uk: "Перевірка формальна: вона ловить помилки перенесення ключів і норм, але не знає змісту методики",
    ru: "Проверка формальная: она ловит ошибки переноса ключей и норм, но не знает содержания методики",
    en: "The check is formal: it catches errors in transferring scoring keys and norms, but it does not know the content of the instrument",
  },
  "co.discardDraft": {
    uk: "Відкинути й завантажити серверну версію",
    ru: "Отбросить и загрузить серверную версию",
    en: "Discard and load the server version",
  },
  "co.draftRestored": {
    uk: "Відновлено незбережену чернетку з цього браузера.",
    ru: "Восстановлен несохранённый черновик из этого браузера.",
    en: "Restored an unsaved draft from this browser.",
  },
  "co.errorsCount": { uk: "помилок", ru: "ошибок", en: "errors" },
  "co.issuesSummary": { uk: "Зауважень", ru: "Замечаний", en: "Issues" },
  "co.itemsGenitive": { uk: "пунктів", ru: "пунктов", en: "items" },
  "co.jsonHint": {
    uk: "Для методик на сотні пунктів заповнювати форму немає сенсу. Вставте сюди опис у тому самому вигляді, який приймає API — з ключами шкал, нормами й таблицями стенів.",
    ru: "Для методик на сотни пунктов заполнять форму бессмысленно. Вставьте сюда описание в том же виде, какой принимает API — с ключами шкал, нормами и таблицами стенов.",
    en: "For instruments with hundreds of items, filling in the form makes no sense. Paste the description here in the same format the API accepts — with scale scoring keys, norms and sten tables.",
  },
  "co.jsonParseError": { uk: "JSON не розібрано", ru: "JSON не разобран", en: "Could not parse JSON" },
  "co.warningsCount": { uk: "попереджень", ru: "предупреждений", en: "warnings" },
  "cq.addQuestion": { uk: "Додати питання", ru: "Добавить вопрос", en: "Add question" },
  "cs.addScale": { uk: "Додати шкалу", ru: "Добавить шкалу", en: "Add scale" },
  "dq.iccHintPart1": {
    uk: "ICC за парами замірів однієї людини з інтервалом",
    ru: "ICC по парам замеров одного человека с интервалом",
    en: "ICC over pairs of measurements of the same person taken",
  },
  "dq.iccHintPart2": {
    uk: "днів: раніше — людина пам’ятає відповіді, пізніше — стан справді змінюється, і те й те вже не про надійність інструмента. Оцінка незалежна від альфи: та каже про узгодженість пунктів, ця — про стабільність у часі.",
    ru: "дней: раньше — человек помнит ответы, позже — состояние реально меняется, и то и другое уже не про надёжность инструмента. Оценка независима от альфы: та говорит о согласованности пунктов, эта — о стабильности во времени.",
    en: "days apart: sooner, the person remembers their answers; later, their state genuinely changes — and neither is about the instrument's reliability any more. This estimate is independent of alpha: alpha speaks to item consistency, this one to stability over time.",
  },
  "dq.lessThan": { uk: "менше", ru: "меньше", en: "fewer than" },
  "dq.needAtLeast": { uk: "потрібно ≥", ru: "нужно ≥", en: "need ≥" },
  "dq.notShownDash": { uk: "— не показується", ru: "— не показывается", en: "— not shown" },
  "dq.pairsLower": { uk: "пар", ru: "пар", en: "pairs" },
  "dur.day": { uk: "дн", ru: "дн", en: "d" },
  "dur.hour": { uk: "год", ru: "ч", en: "h" },
  "dur.min": { uk: "хв", ru: "мин", en: "min" },
  "inv.copyCode": { uk: "Копіювати код", ru: "Копировать код", en: "Copy code" },
  "inv.copyLink": { uk: "Копіювати посилання", ru: "Копировать ссылку", en: "Copy link" },
  "inv.createSubmit": { uk: "Створити", ru: "Создать", en: "Create" },
  "inv.groupHint": {
    uk: "Для групового обстеження виставте кількість використань за числом людей — усі увійдуть за одним посиланням. Підрозділ із запрошення має пріоритет над уведеним пацієнтом.",
    ru: "Для группового обследования поставьте использований по числу людей — все войдут по одной ссылке. Подразделение из приглашения главнее введённого пациентом.",
    en: "For a group assessment, set the number of uses to the number of people — everyone will join via the same link. The unit from the invitation takes priority over the one entered by the patient.",
  },
  "inv.linkWarning": {
    uk: "Посилання показується один раз — у системі зберігається лише його відбиток. Скопіюйте або роздрукуйте зараз. Код залишиться видимим у списку.",
    ru: "Ссылка показывается один раз — в системе хранится только её отпечаток. Скопируйте или распечатайте сейчас. Код останется виден в списке.",
    en: "The link is shown only once — the system stores only its hash. Copy or print it now. The code will remain visible in the list.",
  },
  "join.batteryAssignedPrefix": { uk: ", обстеження «", ru: ", обследование «", en: ", assessment “" },
  "join.batteryAssignedSuffix": { uk: "» вже призначено", ru: "» уже назначено", en: "” has already been assigned" },
  "join.errorPrefix": { uk: "Помилка", ru: "Ошибка", en: "Error" },
  "key.checkInstructions": {
    uk: "Роздрукуйте і звірте з посібником. Автоматична перевірка ловить структурні помилки — вихід номера за діапазон, суперечності, перетини норм, — але переплутані місцями номери виглядають для неї цілком законно.",
    ru: "Распечатайте и сверьте с пособием. Автоматическая проверка ловит структурные ошибки — выход номера за диапазон, противоречия, пересечения норм, — но перепутанные местами номера выглядят для неё совершенно законно.",
    en: "Print it and check it against the manual. The automatic check catches structural errors — item numbers out of range, contradictions, overlapping norms — but swapped numbers look perfectly legitimate to it.",
  },
  "key.exportJson": { uk: "Вивантажити JSON", ru: "Выгрузить JSON", en: "Export JSON" },
  "key.itemsInKey": { uk: "пунктів у ключі", ru: "пунктов в ключе", en: "items in key:" },
  "nm.curveMinPrefix": { uk: "Для кривої потрібно щонайменше", ru: "Для кривой нужно минимум", en: "A curve needs at least" },
  "nm.curveMinSuffix": {
    uk: "проходжень однієї статі із зазначеним віком. Накопичиться — з’являться.",
    ru: "прохождений одного пола с указанным возрастом. Накопится — появятся.",
    en: "completions of one sex with a recorded age. Once enough accumulate, the curves will appear.",
  },
  "nm.publishForCount": { uk: "Опублікувати для", ru: "Опубликовать для", en: "Publish for" },
  "nm.publishNote": {
    uk: "Публікація створює нову версію методики: зібрані проходження залишаються на попередніх нормах, походження кожної норми фіксується («локальна вибірка, N=…»).",
    ru: "Публикация создаёт новую версию методики: собранные прохождения остаются на прежних нормах, происхождение каждой нормы фиксируется («локальная выборка, N=…»).",
    en: "Publishing creates a new version of the instrument: collected completions stay on the previous norms, and the origin of each norm is recorded (“local sample, N=…”).",
  },
  "nm.sampleSmallerThan": { uk: "вибірка менша за", ru: "выборка меньше", en: "sample smaller than" },
  "nm.scalesGen": { uk: "шкал", ru: "шкал", en: "scales" },
  "nm.shiftHint": {
    uk: "«Зсув середнього T» — наскільки середня людина вибірки відхиляється від норми посібника. Більше ±5 T — вибірка систематично відрізняється від нормувальної популяції, і локальні норми мають сенс.",
    ru: "«Сдвиг среднего T» — насколько средний человек выборки отклоняется от нормы пособия. Больше ±5 T — выборка систематически отличается от нормировочной популяции, и локальные нормы имеют смысл.",
    en: "“Mean T shift” shows how far the average person in the sample deviates from the manual's norm. More than ±5 T means the sample differs systematically from the normative population, and local norms make sense.",
  },
  "nm.sub": {
    uk: "M і SD за фактичною вибіркою установи проти норм посібника",
    ru: "M и SD по фактической выборке учреждения против норм пособия",
    en: "M and SD for the institution's actual sample vs. the manual's norms",
  },
  "nm.switchToLocal": { uk: "перевести на локальні", ru: "перевести на локальные", en: "switch to local" },
  "nm.tScores": { uk: "T-бали", ru: "T-баллы", en: "T-scores" },
  "nm.tabAgeCurves": { uk: "Вікові криві", ru: "Возрастные кривые", en: "Age curves" },
  "nm.tabPoolVsSample": { uk: "Посібник проти вибірки", ru: "Пособие против выборки", en: "Manual vs. sample" },
  "nm.tooEarlyPublish": { uk: "— публікувати рано", ru: "— публиковать рано", en: "— too early to publish" },
  "nm.windowPm": { uk: "вікно ±", ru: "окно ±", en: "window ±" },
  "nm.years": { uk: "років", ru: "лет", en: "years" },
  "pt.higherThanPct": { uk: "вище, ніж у", ru: "выше, чем у", en: "higher than" },
  "pt.reliable": { uk: "достовірний", ru: "достоверный", en: "reliable" },
  "ref.csvName": { uk: "направлення", ru: "направления", en: "referrals" },
  "ref.truncatedHint": {
    uk: "Показано перші 200 направлень — найсвіжіші. Щоб побачити інші, звузьте вибірку перемикачем вище.",
    ru: "Показаны первые 200 направлений — самые свежие. Чтобы увидеть остальные, сузьте выборку переключателем выше.",
    en: "Showing the first 200 referrals — the most recent ones. To see the rest, narrow the selection with the switch above.",
  },
  "ui.buildFrom": { uk: "Складання від", ru: "Сборка от", en: "Build of" },

  /* строки, вычищенные из разметки: см. apps/web/test/uiStrings.test.ts */
  "co.aboveThreshold": { uk: "вище порога", ru: "выше порога", en: "above threshold" },
  "co.belowThreshold": { uk: "нижче порога", ru: "ниже порога", en: "below threshold" },
  "co.byDefault1500": { uk: "1500 за замовчуванням", ru: "1500 по умолчанию", en: "1500 by default" },
  "co.noCascade": { uk: "без каскаду", ru: "без каскада", en: "no cascade" },
  "co.safetyShown": {
    uk: "Показується обстежуваному одразу після здачі, якщо спрацював критичний пункт: телефони довіри, черговий психолог, куди звернутися просто зараз.",
    ru: "Показывается обследуемому сразу после сдачи, если сработал критический пункт: телефоны доверия, дежурный психолог, куда обратиться прямо сейчас.",
    en: "Shown to the respondent right after submission if a critical item was triggered: helplines, the on-duty psychologist, where to turn right now.",
  },
  "co.tooFastLabel": { uk: "«Занадто швидко», мс на питання", ru: "«Слишком быстро», мс на вопрос", en: "“Too fast”, ms per question" },
  "mark.critical": { uk: "критичний", ru: "критический", en: "critical" },
  "sel.noGroup": { uk: "— без групи —", ru: "— без группы —", en: "— no group —" },

  /*
   * Ключи, которые зовутся шаблоном: ut(`goal.status.${g.status}`).
   *
   * Проверка на мёртвые ключи однажды сочла их мёртвыми и удалила: она
   * умела распознавать только односоставный префикс перед `.${`, а здесь
   * он из двух частей. Приложение падало пустым экраном на первом же
   * закрытии цели — UI[key] оказывался undefined, и компилятор такого
   * не видит. Проверка исправлена и дополнена отдельной, которая следит,
   * чтобы семейства шаблонных ключей не пустели; комментарий пусть
   * останется — соблазн «почистить неиспользуемое» возникает не в
   * последний раз.
   */

  /* ─────────── группы: администрирование и аналитика ─────────── */
  "grp.filterActive": { uk: "Чинні", ru: "Действующие", en: "Active" },
  "grp.filterAll": { uk: "Усі", ru: "Все", en: "All" },
  "grp.rename": { uk: "Перейменувати", ru: "Переименовать", en: "Rename" },
  "grp.renamed": { uk: "Групу збережено", ru: "Группа сохранена", en: "Group saved" },
  "grp.archive": { uk: "Зняти з використання", ru: "Снять с использования", en: "Retire from use" },
  "grp.restore": { uk: "Повернути в роботу", ru: "Вернуть в работу", en: "Return to use" },
  "grp.archived": { uk: "знято з використання", ru: "снята с использования", en: "retired from use" },
  "grp.archivedToast": { uk: "Групу знято з використання", ru: "Группа снята с использования", en: "Group retired from use" },
  "grp.restoredToast": { uk: "Групу повернуто в роботу", ru: "Группа возвращена в работу", en: "Group returned to use" },
  "grp.archiveHint": {
    uk: "Зняття нічого не забирає: адміністратори й далі бачать методики групи, аналітика рахується, проходження відкриваються. Знята група лише не пропонується під час вибору групи для нової методики чи батареї.",
    ru: "Снятие ничего не отбирает: администраторы по-прежнему видят методики группы, аналитика считается, прохождения открываются. Снятая группа лишь не предлагается при выборе группы для новой методики или батареи.",
    en: "Retiring takes nothing away: administrators still see the group's instruments, analytics is still calculated, completions still open. A retired group is simply not offered when choosing a group for a new instrument or battery.",
  },
  "grp.emptyActive": { uk: "Чинних груп немає", ru: "Действующих групп нет", en: "No active groups" },
  "grp.emptyAll": { uk: "Груп немає", ru: "Групп нет", en: "No groups" },
  "grp.emptyHint": {
    uk: "Група — одиниця розмежування доступу. Поки її немає, кожна методика лишається особистим чернетковим записом свого автора.",
    ru: "Группа — единица разграничения доступа. Пока её нет, каждая методика остаётся личным черновиком своего автора.",
    en: "A group is the unit of access control. Until one exists, each instrument remains a personal draft of its author.",
  },
  "grp.people": { uk: "Людей", ru: "Людей", en: "People" },
  "grp.openCases": { uk: "Відкритих випадків", ru: "Открытых случаев", en: "Open cases" },
  "grp.completion": { uk: "Доходимість", ru: "Доходимость", en: "Completion rate" },
  "grp.avgDuration": { uk: "Середній час", ru: "Среднее время", en: "Average time" },
  "grp.showAnalytics": { uk: "Аналітика групи", ru: "Аналитика группы", en: "Group analytics" },
  "grp.hideAnalytics": { uk: "Згорнути аналітику", ru: "Свернуть аналитику", en: "Collapse analytics" },
  "grp.severityTitle": { uk: "Розподіл за ступенями вираженості", ru: "Распределение по степеням выраженности", en: "Distribution by severity band" },
  "grp.severityHint": {
    uk: "Рахується за смугами змістовних шкал: смуга шкали достовірності говорить про якість протоколу, а не про стан людини.",
    ru: "Считается по полосам содержательных шкал: полоса шкалы достоверности говорит о качестве протокола, а не о состоянии человека.",
    en: "Calculated from the bands of content scales: a band on a validity scale speaks to the quality of the protocol, not to the person's state.",
  },
  "grp.bySurvey": { uk: "За методиками", ru: "По методикам", en: "By instrument" },
  "grp.byDay": { uk: "Проходження за днями", ru: "Прохождения по дням", en: "Completions by day" },
  "grp.noResponses": { uk: "Проходжень у групі ще немає", ru: "Прохождений в группе ещё нет", en: "No completions in the group yet" },
  "grp.surveyRetired": { uk: "знято", ru: "снята", en: "retired" },
  "grp.noPermissionHint": {
    uk: "Заводити, знімати групи та призначати їхніх адміністраторів може той, кому видано право «Вести групи та їхніх адміністраторів».",
    ru: "Заводить, снимать группы и назначать их администраторов может тот, кому выдано право «Вести группы и их администраторов».",
    en: "Creating and retiring groups and assigning their administrators is available to those granted the “Manage groups and their administrators” permission.",
  },

  /*
   * Якоря волны 8 (логика по макету). Стоят далеко от якорей волны 7:
   * соседние вставки git сливает одним конфликтом.
   */
  /* ── wave8:rules ── */
  /* ── wave8:conclusion ── */
  /* ── wave8:engine ── */
  /* ── wave8:people ── */
  /* ── wave8:shell ── */

  /* ─────────── основание тревоги ─────────── */
  "cases.basis": { uk: "Підстава", ru: "Основание", en: "Basis" },
  "cases.basisHint": {
    uk: "На чому ґрунтується висновок про ризик: або людина позначила критичний варіант відповіді, або сумарний бал шкали потрапив у смугу.",
    ru: "На чём основан вывод о риске: либо человек отметил критический вариант ответа, либо суммарный балл шкалы попал в полосу.",
    en: "What the risk finding is based on: either the person marked a critical answer option, or the scale's total score fell into a band.",
  },
  "cases.kind.option": { uk: "За позначеною відповіддю", ru: "По отмеченному ответу", en: "By marked answer" },
  "cases.kind.band": { uk: "За смугою шкали", ru: "По полосе шкалы", en: "By scale band" },
  "cases.item": { uk: "Пункт", ru: "Пункт", en: "Item" },
  "cases.picked": { uk: "Позначено", ru: "Отмечено", en: "Marked" },
  "cases.scale": { uk: "Шкала", ru: "Шкала", en: "Scale" },
  "cases.band": { uk: "Смуга", ru: "Полоса", en: "Band" },
  "cases.rawScore": { uk: "сирий бал", ru: "сырой балл", en: "raw score" },
  "cases.noAnswerStored": {
    uk: "Відповідь не збереглася — сигнал підняли за чернеткою, яку потім переписали.",
    ru: "Ответ не сохранился — сигнал подняли по черновику, который потом переписали.",
    en: "The answer was not saved — the alert was raised from a draft that was later overwritten.",
  },
  "cases.openResponse": { uk: "Відкрити проходження", ru: "Открыть прохождение", en: "Open completion" },
  "cases.responseTitle": { uk: "Проходження цілком", ru: "Прохождение целиком", en: "Full completion" },
  "cases.answersTitle": { uk: "Відповіді за пунктами", ru: "Ответы по пунктам", en: "Answers by item" },
  "cases.scoresTitle": { uk: "Бали за шкалами", ru: "Баллы по шкалам", en: "Scores by scale" },
  "cases.skipped": { uk: "пропущено", ru: "пропущено", en: "skipped" },
  "cases.criticalOption": { uk: "критичний варіант", ru: "критический вариант", en: "critical option" },
  "cases.loadBasisFailed": { uk: "Не вдалося прочитати підставу", ru: "Не удалось прочитать основание", en: "Could not read the basis" },

  /*
   * Одиниці нормування: зовуться шаблоном ut(`norm.${normalization}`).
   * Значення шкали без одиниці нечитабельне — «2» це стен, T-бал чи частка,
   * і від відповіді залежить, багато це чи мало.
   */
  "norm.raw": { uk: "сирий бал", ru: "сырой балл", en: "raw score" },
  "norm.ratio": { uk: "частка", ru: "доля", en: "proportion" },
  "norm.tscore": { uk: "T-бал", ru: "T-балл", en: "T-score" },
  "norm.sten": { uk: "стен", ru: "стен", en: "sten" },
  /*
   * Якоря волны 7 («все экраны один в один»): у каждого параллельного
   * сборщика свой участок словаря, иначе три ветки дописывают ключи в одну
   * и ту же последнюю строку объекта и сливаются только руками.
   */
  /* ── wave7:stats ── */
  /*
   * Раздел «Статистика» — кадры f08, f09, f17, f18, f23, f24, f29. Слова
   * полей — дословно с кадров; «ВШР» — «високий ступінь ризику» (прочтение
   * записано в docs/REWRITE-PLAN.md, волна 5), «ВщВМ» кадр не расшифровывает
   * и печатается как нарисован.
   */
  "st.listTitle": { uk: "Перелік статистики", ru: "Перечень статистики", en: "Statistics list" },
  "st.search": { uk: "Пошук статистичної моделі", ru: "Поиск статистической модели", en: "Search statistical models" },
  "st.add": { uk: "Додати статистичну модель", ru: "Добавить статистическую модель", en: "Add statistical model" },
  "st.empty": { uk: "Статистичних моделей ще немає", ru: "Статистических моделей ещё нет", en: "No statistical models yet" },
  "st.views": { uk: "Вигляд розділу", ru: "Вид раздела", en: "Section view" },
  "st.viewChart": { uk: "Діаграма", ru: "Диаграмма", en: "Chart" },
  "st.viewList": { uk: "Перелік", ru: "Перечень", en: "List" },
  "st.modelName": { uk: "Назва статистичної моделі", ru: "Название статистической модели", en: "Statistical model name" },
  "st.filters": { uk: "Фільтри", ru: "Фильтры", en: "Filters" },
  "st.date": { uk: "Дата", ru: "Дата", en: "Date" },
  "st.dateFrom": { uk: "Від", ru: "С", en: "From" },
  "st.dateTo": { uk: "До", ru: "По", en: "To" },
  "st.patient": { uk: "Пацієнт", ru: "Пациент", en: "Patient" },
  "st.patientUnavailable": { uk: "Пацієнт недоступний", ru: "Пациент недоступен", en: "Patient unavailable" },
  "st.noPatients": { uk: "Нікого не знайдено", ru: "Никого не найдено", en: "No one found" },
  "st.ageFrom": { uk: "Вік від", ru: "Возраст от", en: "Age from" },
  "st.ageTo": { uk: "Вік до", ru: "Возраст до", en: "Age to" },
  "st.ageWord": { uk: "вік", ru: "возраст", en: "age" },
  "st.chipAge": { uk: "Віковий діапазон", ru: "Возрастной диапазон", en: "Age range" },
  "st.locality": { uk: "Населений пункт", ru: "Населённый пункт", en: "Locality" },
  "st.group": { uk: "Група пацієнтів", ru: "Группа пациентов", en: "Patient group" },
  "st.groupUnavailable": { uk: "Група недоступна", ru: "Группа недоступна", en: "Group unavailable" },
  "st.everyone": { uk: "Усі пацієнти", ru: "Все пациенты", en: "All patients" },
  "st.band": { uk: "Варіант результату", ru: "Вариант результата", en: "Result option" },
  "st.percent": { uk: "Відсоток відповідей", ru: "Процент ответов", en: "Percentage of answers" },
  "st.question": { uk: "Текст питання", ru: "Текст вопроса", en: "Question text" },
  "st.answer": { uk: "Текст відповіді", ru: "Текст ответа", en: "Answer text" },
  "st.vshr": { uk: "ВШР", ru: "ВСР", en: "HRL" },
  "st.vshrLong": { uk: "Високий ступінь ризику", ru: "Высокая степень риска", en: "High risk level" },
  "st.vshvm": { uk: "ВщВМ", ru: "ВщВМ", en: "VshVM" },
  "st.linkModel": { uk: "Назва моделі", ru: "Название модели", en: "Model name" },
  "st.linkMailing": { uk: "Назва повідомлення", ru: "Название сообщения", en: "Message name" },
  "st.linksUnavailable": {
    uk: "Зв’язок з іншими моделями та повідомленнями поки не підтримується",
    ru: "Связь с другими моделями и сообщениями пока не поддерживается",
    en: "Linking to other models and messages is not supported yet",
  },
  "st.hidden": {
    uk: "Приховано: разом з іншими числами звіту воно називало б конкретних людей",
    ru: "Скрыто: вместе с другими числами отчёта оно называло бы конкретных людей",
    en: "Hidden: together with other numbers in the report, it would identify specific people",
  },
  "st.diffHint": { uk: "Різниця другої вибірки з першою, в. п.", ru: "Разница второй выборки с первой, п. п.", en: "Difference of the second sample from the first, pp" },
  "st.respondents": { uk: "Респондентів", ru: "Респондентов", en: "Respondents" },
  "st.compare": { uk: "Порівняти", ru: "Сравнить", en: "Compare" },
  "st.addSample": { uk: "Додати вибірку для порівняння", ru: "Добавить выборку для сравнения", en: "Add sample for comparison" },
  "st.sample": { uk: "Вибірка", ru: "Выборка", en: "Sample" },
  "st.samples": { uk: "Вибірки моделі", ru: "Выборки модели", en: "Model samples" },
  "st.removeSample": { uk: "Прибрати вибірку", ru: "Убрать выборку", en: "Remove sample" },
  "st.saved": { uk: "Модель збережено", ru: "Модель сохранена", en: "Model saved" },
  "st.backToList": { uk: "До переліку статистики", ru: "К перечню статистики", en: "Back to statistics list" },
  "st.create": { uk: "Створити", ru: "Создать", en: "Create" },
  "st.description": { uk: "Короткий опис статистичної моделі", ru: "Краткое описание статистической модели", en: "Short description of the statistical model" },
  "st.resetTest": { uk: "Прибрати тест і його рядки", ru: "Убрать тест и его строки", en: "Remove test and its rows" },
  "st.addQuestion": { uk: "Додати питання", ru: "Добавить вопрос", en: "Add question" },
  "st.removeQuestion": { uk: "Прибрати питання", ru: "Убрать вопрос", en: "Remove question" },
  "st.deleteModel": { uk: "Видалити модель", ru: "Удалить модель", en: "Delete model" },
  "st.deleteConfirm": { uk: "Видалити цю статистичну модель?", ru: "Удалить эту статистическую модель?", en: "Delete this statistical model?" },
  "st.deleted": { uk: "Модель видалено", ru: "Модель удалена", en: "Model deleted" },
  "st.errTitle": { uk: "Вкажіть назву моделі", ru: "Укажите название модели", en: "Enter a model name" },
  "st.errSurvey": { uk: "Оберіть тест", ru: "Выберите тест", en: "Select a test" },
  "st.errIndicators": {
    uk: "Оберіть хоча б один варіант результату або відповідь",
    ru: "Выберите хотя бы один вариант результата или ответ",
    en: "Select at least one result option or answer",
  },
  "st.filterNew": { uk: "Створення фільтра", ru: "Создание фильтра", en: "New filter" },
  "st.filterName": { uk: "Назва фільтра", ru: "Название фильтра", en: "Filter name" },
  "st.errFilterName": { uk: "Вкажіть назву фільтра", ru: "Укажите название фильтра", en: "Enter a filter name" },
  "st.clearForm": { uk: "Очистити форму", ru: "Очистить форму", en: "Clear form" },
  "st.deletePreset": { uk: "Видалити пресет", ru: "Удалить пресет", en: "Delete preset" },
  "st.presetDeleteConfirm": { uk: "Видалити цей пресет фільтрів?", ru: "Удалить этот пресет фильтров?", en: "Delete this filter preset?" },
  "st.presetDeleted": { uk: "Пресет видалено", ru: "Пресет удалён", en: "Preset deleted" },
  "st.presetSaved": { uk: "Пресет збережено", ru: "Пресет сохранён", en: "Preset saved" },
  "st.removeCriterion": { uk: "Прибрати умову", ru: "Убрать условие", en: "Remove condition" },
  "st.addCriterion": { uk: "Додати умову", ru: "Добавить условие", en: "Add condition" },
  "st.presets": { uk: "Пресети фільтрів", ru: "Пресеты фильтров", en: "Filter presets" },
  "st.noPresets": { uk: "Пресетів фільтрів ще немає", ru: "Пресетов фильтров ещё нет", en: "No filter presets yet" },
  "st.menu": { uk: "Дії розділу статистики", ru: "Действия раздела статистики", en: "Statistics section actions" },
  "st.manageFilters": { uk: "Керувати фільтрами", ru: "Управлять фильтрами", en: "Manage filters" },
  "st.manageModels": { uk: "Керувати стат. моделями", ru: "Управлять стат. моделями", en: "Manage stat. models" },
  "st.nothingToSave": { uk: "Змін немає — зберігати нічого", ru: "Изменений нет — сохранять нечего", en: "No changes — nothing to save" },
  "st.refresh": { uk: "Оновити", ru: "Обновить", en: "Refresh" },
  "st.chartLabel": { uk: "Діаграма порівняння вибірок", ru: "Диаграмма сравнения выборок", en: "Sample comparison chart" },
  "st.chartEmpty": {
    uk: "Оберіть модель і натисніть «Оновити» — тут з’явиться порівняння",
    ru: "Выберите модель и нажмите «Обновить» — здесь появится сравнение",
    en: "Select a model and click “Refresh” — the comparison will appear here",
  },
  "st.filterManagement": { uk: "Керування фільтрами", ru: "Управление фильтрами", en: "Filter management" },
  "st.presetSearch": { uk: "Пошук пресету фільтрів", ru: "Поиск пресета фильтров", en: "Search filter presets" },
  "st.applyTo": { uk: "До яких вибірок застосувати пресет", ru: "К каким выборкам применить пресет", en: "Which samples to apply the preset to" },
  "st.apply": { uk: "Застосувати", ru: "Применить", en: "Apply" },
  /* ── wave7:orgs ── */
  /* ── wave7:placement ── */
} as const satisfies Record<string, UiEntry>;

export type UiKey = keyof typeof UI;

/*
 * Тот же словарь, увиденный через общий тип записи.
 *
 * `as const` оставляет каждой записи её собственный тип, и у записи без
 * английского поля `en` в типе нет вовсе — чтение UI[key].en компилятор не
 * пропустит. Через UiEntry у всех записей одинаковая форма, и `en` честно
 * необязательно.
 */
const ENTRIES: Readonly<Record<string, UiEntry | undefined>> = UI;

/**
 * Перевод по ключу для выбранного языка.
 *
 * Второй аргумент — чем заменить перевод, если ключа в словаре нет. Нужен он
 * ровно одному виду вызовов: ut(`rstatus.${r.status}`), где ключ складывается
 * из значения, пришедшего с сервера. Компилятор такой ключ не проверяет —
 * тип обещает три состояния, а в базе завтра появится четвёртое, — и UI[key]
 * окажется undefined. Без запасного значения это не «строка осталась
 * непереведённой», а TypeError на чтении [lang]: белый экран вместо таблицы
 * прохождений, причём только у того учреждения, где новое состояние успели
 * завести.
 *
 * Показывается в таком случае сам код («in_progress»), а не пустая строка.
 * Пустота читается как «данных нет», и об этом никто не сообщит — а код
 * человек видит, называет в заявке, и ключ добавляется за пять минут.
 * Вариант «показывать ключ всегда» (без второго аргумента) оставлен на
 * случай, когда звать нечем: имя ключа хотя бы ищется в исходниках.
 *
 * Английский без перевода показывает украинский, а не русский и не ключ.
 * Ключ — это дыра посреди экрана; русский — язык, который англоязычный
 * читатель знает не лучше украинского, а учреждение украинское, и тексты
 * методик ему и так покажут по-украински (LANG_FALLBACK в types.ts): один
 * чужой язык на экране лучше двух.
 */
export function makeUiT(lang: Lang) {
  return (key: UiKey, fallback?: string): string => {
    const entry = ENTRIES[key];
    if (!entry) return fallback ?? key;
    return entry[lang] ?? entry.uk;
  };
}

/** Перевод одного ключа вне React — для тех, кто держит язык в переменной (api.ts, очередь мобилки) */
export function uiText(key: UiKey, lang: Lang): string {
  return makeUiT(lang)(key);
}

/** Записи словаря, у которых ещё нет английского: счёт для переводчиков и проверки */
export function untranslatedEn(): UiKey[] {
  return (Object.keys(UI) as UiKey[]).filter(
    (key) => !EMPTY_BY_DESIGN_EN.has(key) && !ENTRIES[key]?.en?.trim(),
  );
}

/**
 * Список языков из заголовка Accept-Language — по убыванию веса.
 *
 * «en-GB,en;q=0.9,uk;q=0.8» → ["en-GB", "en", "uk"]. Нулевой вес значит
 * «не присылать на этом языке» и выпадает; «*» языком не является и тоже
 * выпадает — решать за него будет умолчание detectLang. Порядок равных
 * весов — порядок в заголовке, как велит RFC 9110.
 */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  return header
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number.parseFloat(q.slice(2)) : 1;
      return { tag: tag.trim(), weight: Number.isFinite(weight) ? weight : 0, i };
    })
    .filter((x) => x.tag && x.tag !== "*" && x.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.i - b.i)
    .map((x) => x.tag);
}

/**
 * Язык интерфейса из настроек браузера или устройства.
 *
 * Первый из списка, который мы умеем, — в порядке, заданном человеком:
 * «en-US, uk» даёт английский, «uk, en-US» — украинский. Порядок — это его
 * собственный ответ на вопрос «на чём мне удобнее», и переспрашивать его
 * своими догадками («раз украинский в списке есть, пусть будет он») значило
 * бы спорить с явной настройкой.
 *
 * Список есть, но ни одного нашего языка в нём нет (de, fr, pl) —
 * английский, а не украинский. Кто держит браузер только на немецком,
 * украинского почти наверняка не читает: это доброволец из-за рубежа, а не
 * сотрудник отделения — у того украинский, русский или английский в списке
 * есть. Английский он прочтёт с куда большей вероятностью.
 *
 * Списка нет вовсе (киоск без настроек, приватный режим, запрос без
 * заголовка) — украинский: о человеке не известно ничего, и умолчание —
 * государственный язык учреждения, как и было.
 */
export function detectLang(candidates: readonly string[]): Lang {
  let anyLanguage = false;
  for (const c of candidates) {
    const lower = c.trim().toLowerCase();
    if (!lower || lower === "*") continue;
    anyLanguage = true;
    if (lower.startsWith("uk")) return "uk";
    if (lower.startsWith("ru")) return "ru";
    if (lower.startsWith("en")) return "en";
  }
  return anyLanguage ? "en" : "uk";
}
