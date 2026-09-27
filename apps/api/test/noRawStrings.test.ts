import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Exception, judge, rawStrings, sourceFiles } from "../../web/test/rawStrings";

/**
 * Сторож сырых строк сервера: текст, который собирает сервер или общий
 * пакет, — через словарь.
 *
 * Серверный близнец apps/web/test/noRawStrings.test.ts, и заведён по его же
 * находке. Интерфейс веба оказался чист, а «сотни строк вне словаря» жили
 * там, где текст складывает сервер: проблемы методики, сравнение версий,
 * предупреждения подсчёта и объяснения правил, печатные листы, подписи
 * SPSS, вывод командной консоли, сообщения схем. Всё это было по-русски на
 * любом языке интерфейса (волна 13, srv-i18n) и теперь идёт через
 * packages/shared/src/serverStrings.ts и ERRORS.
 *
 * Правило строже, чем у клиента, и проще: в охраняемом модуле кириллица
 * допустима только в комментарии и в выводе разработчику (console.* и
 * журнал процесса log.*) — любой другой кириллический литерал есть фраза,
 * которую прочтёт человек, или ошибка. Разбор — тем же компилятором
 * (rawStrings.ts): регулярка здесь промахнулась бы на шаблонах разметки
 * печатных листов, где русские слова стояли прямо в тексте HTML.
 *
 * Волна 13 охраняла семь модулей поимённо и оставила хвост: заметки версий
 * и названия копий, подписи норм, отказы с русской подробностью, примечания
 * назначений, письма тревог. Волна 14 (srvstrings) перевела хвост, и
 * охрана теперь — каталогами: все маршруты, вся библиотека сервера,
 * посредники и сборка приложения. Новый файл там охраняется с первого дня,
 * без записи в список. Что не охраняется — перечислено ниже поимённо и с
 * причиной: целые файлы (документация OpenAPI, демоданные) и отдельные
 * места (сообщения исключений разработчику, вывод командных скриптов,
 * журнал, распознавание ввода и старых записей). Командные скрипты верхнего
 * уровня (install.ts, contentCheck.ts, surveyPurge.ts и соседи) остаются
 * русскими по решению участка srv-i18n — их читает в терминале тот, кто
 * выкатывает, — и в охрану не входят; тексты методик (instruments/) —
 * контент каталога.
 */

const ROOT = resolve(import.meta.dir, "../../..");
const rel = (file: string) => file.slice(ROOT.length + 1);

/*
 * Вывод разработчику: у сервера это не только console.*, но и структурный
 * журнал процесса log.* (lib/log.ts) — причина пропуска каскада или
 * подсказка к заблокированному событию уходят в лог, а не человеку.
 */
const DEV_CALLS = /^(?:console|log)\.\w+$/;

/* ─── сервер: каталогами ─── */

const SERVER_DIRS = ["apps/api/src/routes", "apps/api/src/lib", "apps/api/src/middleware"];
const SERVER_FILES = ["apps/api/src/app.ts"];

/*
 * Файлы сервера вне охраны — целиком. Каждый обязан существовать и нести
 * кириллицу: пропуск файла, в котором её не осталось, — мёртвый, он молча
 * разрешил бы там первую же новую фразу.
 */
const SERVER_SKIPPED = new Map<string, string>([
  [
    "apps/api/src/lib/openapi.ts",
    "документация OpenAPI: описания маршрутов читает разработчик клиента в /api/docs, а не человек в кабинете",
  ],
  ["apps/api/src/lib/demoPeople.ts", "демоданные: имена, подразделения и заметки демонстрационных людей — содержимое витрины"],
  ["apps/api/src/lib/demoFill.ts", "демоданные: наполнение демонстрационной установки (тексты заключений, заметок, обращений)"],
]);

/* ─── общий пакет: целиком ─── */

/*
 * Общий пакет работает и на сервере, и в клиентах, и фраза, набранная в
 * нём, приезжает готовой туда, где её уже не перевести. Словари и
 * справочники на трёх языках — сами по себе место для кириллицы; их
 * полноту и буквы проверяют свои тесты.
 */
const SHARED_DIR = "packages/shared/src";
const SHARED_SKIPPED = new Map<string, string>([
  ["packages/shared/src/uiStrings.ts", "словарь оболочки — uiStrings.test.ts, langLetters.test.ts"],
  ["packages/shared/src/errorStrings.ts", "словарь отказов — apps/api/test/errorStrings.test.ts"],
  ["packages/shared/src/pushStrings.ts", "словарь уведомлений — uiStrings.test.ts, «английский в словарях сервера»"],
  ["packages/shared/src/serverStrings.ts", "словарь сервера — packages/shared/test/serverStrings.test.ts"],
  ["packages/shared/src/permissions.ts", "справочник прав на трёх языках — apps/web/test/noRawStrings.test.ts"],
  ["packages/shared/src/featureFlags.ts", "справочник флагов на трёх языках — apps/web/test/noRawStrings.test.ts"],
]);

/* ─── исключения по местам ─── */

/*
 * Причины — одними словами на весь список: мест много, а родов у них
 * немного, и причина, записанная сорок раз по-разному, перестаёт читаться.
 */
const WHY = {
  thrown:
    "сообщение исключения — разработчику: до человека доходит err.internal (app.onError), текст — в лог и в группы ошибок техпанели",
  job: "сообщение исключения фоновой задачи: лог и строка «последняя ошибка» в техпанели моноширинным, как ошибка любой библиотеки",
  google:
    "ошибка обмена с Google: вход ловит её и отвечает err.googleBadCallback (routes/auth.ts), календарь — err.internal; текст — в лог",
  startup:
    "отказ при старте процесса: печатается в терминал того, кто выкатывает, до первого запроса и языка интерфейса — по-русски, как вывод командных скриптов (решение участка srv-i18n)",
  cli: "вывод командного скрипта (surveyPurge.ts, installCatalog.ts): терминал эксплуатации — по-русски по решению участка srv-i18n",
  journal: "запись журнала аудита: поле события, а не фраза экрана; журнал хранит то, что произошло, как произошло",
  legacy:
    "распознавание записей до кодов (волна 14): по этому началу узнаются строки, записанные русской фразой; наружу оно не выводится",
  input:
    "распознавание ввода: слова, которыми человек называет столбец или роль в файле импорта, — на обоих языках, это то, что он пишет, а не то, что ему показывают",
  letters: "нормализация слова для поискового индекса (ё → е, ъ → ь): буквы, которые сводятся друг к другу, а не фраза",
  transcribe:
    "подробность отказа расшифровки после кода (TranscribeFailure): экран приёма объясняет отказ по коду (rec.fail.*), подробность — для разбора в техпанели рядом с выводом ffmpeg и whisper",
} as const;

const EXCEPTIONS: Exception[] = [
  /* ─── общий пакет (волна 13) ─── */
  {
    file: "packages/shared/src/types.ts",
    text: "Українська",
    why: "название языка на самом себе (LANG_NAMES): по нему человек находит свой язык в переключателе — переводу не подлежит",
  },
  { file: "packages/shared/src/types.ts", text: "УКР", why: "то же, короткая подпись переключателя" },
  { file: "packages/shared/src/types.ts", text: "Русский", why: "то же, LANG_NAMES" },
  { file: "packages/shared/src/types.ts", text: "РУС", why: "то же, короткая подпись переключателя" },
  {
    file: "packages/shared/src/types.ts",
    text: "Мова / Язык / Language",
    why: "имя переключателя языка на всех языках сразу (LANG_SELF_LABEL): его ищут по слову, которое читают",
  },
  {
    file: "packages/shared/src/format.ts",
    text: "с",
    why: "таблица единиц длительности по языкам (DURATION_UNITS): это и есть перевод, по записи на язык",
  },
  { file: "packages/shared/src/format.ts", text: "хв", why: "то же: украинская минута" },
  { file: "packages/shared/src/format.ts", text: "мин", why: "то же: русская минута" },
  {
    file: "packages/shared/src/dates.ts",
    text: "ожидается существующая дата ГГГГ-ММ-ДД",
    why: "сообщение разработчику в проблеме zod; человеку уходит перевод по params.errorKey (err.invalidDateParam, lib/http.ts)",
  },
  {
    file: "packages/shared/src/wireSchemas.ts",
    text: "ожидается существующий момент ISO 8601",
    why: "то же: сообщение разработчику, человеку — err.invalidDateParam по params.errorKey",
  },

  /* ─── маршруты ─── */
  { file: "apps/api/src/routes/auth.ts", text: "нечего менять", why: WHY.journal },

  /* ─── библиотека сервера ─── */
  { file: "apps/api/src/lib/audit.ts", text: "система", why: `${WHY.journal} (user_agent фонового прохода)` },
  {
    file: "apps/api/src/lib/auth.ts",
    text: "Респондент",
    why: "псевдоним учётной записи под кодом — её имя: хранится, ищется и называется как есть; «Респондент» одинаков по-украински и по-русски",
  },
  { file: "apps/api/src/lib/auth.ts", text: "АБВГДЕЖЗИКЛМНПРСТУФХЦЧШЭЮЯ", why: "алфавит буквы псевдонима — код, а не слово" },
  { file: "apps/api/src/lib/catalogInstall.ts", text: "Каталог", why: WHY.legacy },
  { file: "apps/api/src/lib/catalogInstall.ts", text: "в базе нет ни одного сотрудника", why: `${WHY.cli}; ручной запуск из техпанели кладёт её в лог` },
  { file: "apps/api/src/lib/crypto.ts", text: "ENCRYPTION_KEY", why: WHY.startup },
  { file: "apps/api/src/lib/crypto.ts", text: "Ожидается v1:", why: WHY.startup },
  {
    file: "apps/api/src/lib/crypto.ts",
    text: "«не расшифровано»",
    why: "аварийная пометка на месте ФИО при утраченном ключе: decryptField не знает, кто читает, а значение расходится по всем выдачам, поиску и печати; протаскивать язык через каждое чтение ФИО ради сбоя, о котором техпанель кричит отдельно (ключи), — не в пользу человека",
  },
  { file: "apps/api/src/lib/encryptBackfill.ts", text: "ENCRYPTION_KEY не задан", why: WHY.job },
  { file: "apps/api/src/lib/followup.ts", text: "Протокол наблюдения", why: WHY.legacy },
  { file: "apps/api/src/lib/google.ts", text: "google: ", why: WHY.google },
  { file: "apps/api/src/lib/jobLock.ts", text: "задача ${…} уже выполняется", why: WHY.job },
  { file: "apps/api/src/lib/keyInventory.ts", text: "недопустимое имя в описи шифрования", why: WHY.thrown },
  { file: "apps/api/src/lib/keyInventory.ts", text: "нет файла", why: `${WHY.thrown} (ловится тут же и считается «файла нет»)` },
  { file: "apps/api/src/lib/meet.ts", text: "google: разрешение выдано без refresh-токена", why: WHY.google },
  /* столбцы и роли файла импорта: «адмін» покрывает и «адміністратор», «суперадмін» — «суперадміністратор» */
  { file: "apps/api/src/lib/people.ts", text: "ім'я", why: WHY.input },
  { file: "apps/api/src/lib/people.ts", text: "адмін", why: WHY.input },
  { file: "apps/api/src/lib/people.ts", text: "админ", why: WHY.input },
  { file: "apps/api/src/lib/people.ts", text: "співробітник", why: WHY.input },
  { file: "apps/api/src/lib/people.ts", text: "сотрудник", why: WHY.input },
  { file: "apps/api/src/lib/people.ts", text: "суперадмін", why: WHY.input },
  { file: "apps/api/src/lib/people.ts", text: "суперадмин", why: WHY.input },
  { file: "apps/api/src/lib/people.ts", text: "пацієнт", why: WHY.input },
  { file: "apps/api/src/lib/people.ts", text: "пациент", why: WHY.input },
  { file: "apps/api/src/lib/recordings.ts", text: "ключ ${…} не найден", why: WHY.job },
  { file: "apps/api/src/lib/recordings.ts", text: "шифрование не настроено", why: WHY.thrown },
  { file: "apps/api/src/lib/recordings.ts", text: "aborted: ", why: "признак отмены расшифровки (AbortError): ловится проходом и в строку отказа не попадает" },
  { file: "apps/api/src/lib/recordings.ts", text: "ffmpeg ", why: WHY.transcribe },
  { file: "apps/api/src/lib/recordings.ts", text: "после преобразования звука нет", why: WHY.transcribe },
  { file: "apps/api/src/lib/recordings.ts", text: "whisper ", why: WHY.transcribe },
  { file: "apps/api/src/lib/rlsGuard.ts", text: "Приложение подключено к базе ролью", why: WHY.startup },
  { file: "apps/api/src/lib/rlsGuard.ts", text: "Для такой роли политики строк", why: WHY.startup },
  { file: "apps/api/src/lib/rlsGuard.ts", text: "но каждый видит всё", why: WHY.startup },
  { file: "apps/api/src/lib/rlsGuard.ts", text: "Заведите роль приложения", why: WHY.startup },
  { file: "apps/api/src/lib/rlsGuard.ts", text: 'psql "$OWNER_DATABASE_URL"', why: WHY.startup },
  { file: "apps/api/src/lib/rlsGuard.ts", text: "Миграции по-прежнему", why: WHY.startup },
  { file: "apps/api/src/lib/schedule.ts", text: "сетку не удалось продлить", why: WHY.job },
  /* нормализация слова для поиска: «ё» к «е», «ъ» к «ь» */
  { file: "apps/api/src/lib/searchIndex.ts", text: "ё", why: WHY.letters },
  { file: "apps/api/src/lib/searchIndex.ts", text: "е", why: WHY.letters },
  { file: "apps/api/src/lib/searchIndex.ts", text: "ъ", why: WHY.letters },
  { file: "apps/api/src/lib/searchIndex.ts", text: "ь", why: WHY.letters },
  { file: "apps/api/src/lib/surveyPurge.ts", text: "Методика ${…} не найдена", why: WHY.cli },
  { file: "apps/api/src/lib/surveyPurge.ts", text: "«${…}» в работе", why: WHY.cli },
  { file: "apps/api/src/lib/surveyPurge.ts", text: "Название не совпало", why: WHY.cli },
  { file: "apps/api/src/lib/surveyPurge.ts", text: "Есть подписанные заключения", why: WHY.cli },
  { file: "apps/api/src/lib/surveyPurge.ts", text: "Запись о чистке не легла в журнал", why: WHY.cli },
  { file: "apps/api/src/lib/surveys.ts", text: "copyVersion: у методики", why: WHY.thrown },
  { file: "apps/api/src/lib/surveys.ts", text: "локальная выборка", why: WHY.legacy },
  { file: "apps/api/src/lib/totp.ts", text: "base32: недопустимый знак", why: WHY.thrown },
];

function scan() {
  const server = [
    ...SERVER_DIRS.flatMap((d) => sourceFiles(join(ROOT, d))),
    ...SERVER_FILES.map((f) => join(ROOT, f)),
  ].filter((f) => !/\.test\.tsx?$/.test(f) && !SERVER_SKIPPED.has(rel(f)));
  const shared = sourceFiles(join(ROOT, SHARED_DIR)).filter(
    (f) => !/\.test\.tsx?$/.test(f) && !SHARED_SKIPPED.has(rel(f)),
  );
  const files = [...server, ...shared];
  const found = files
    .flatMap((f) => rawStrings(rel(f), readFileSync(f, "utf8"), { devCalls: DEV_CALLS }))
    // латиница на сервере — это код, протокол и имена переменных выгрузки; фразы ищем по кириллице
    .filter((x) => x.kind === "cyrillic");
  return { server, shared, files, found };
}

describe("сервер и общий пакет: фразы — через словарь", () => {
  test("кириллица в охраняемых модулях — только в комментариях, выводе разработчику и исключениях", () => {
    const { server, shared, found } = scan();
    // сначала — что файлы нашлись: иначе проверка обошла бы пустой список и объявила победу
    expect(server.length).toBeGreaterThan(150);
    expect(server.some((f) => rel(f) === "apps/api/src/routes/surveys.ts")).toBe(true);
    expect(server.some((f) => rel(f) === "apps/api/src/lib/notify.ts")).toBe(true);
    expect(shared.length).toBeGreaterThan(20);
    const { offenders } = judge(found, EXCEPTIONS, []);
    expect(
      offenders,
      "фраза мимо словаря: вынеси её в packages/shared/src/serverStrings.ts (или ERRORS) и собирай на языке запроса; хранимую — кодом (noteCode)",
    ).toEqual([]);
  });

  test("каждое исключение срабатывает", () => {
    const { found } = scan();
    const { deadExceptions } = judge(found, EXCEPTIONS, []);
    expect(deadExceptions, "исключение ничего не разрешает — убери его").toEqual([]);
  });

  test("у каждого исключения есть причина", () => {
    expect(EXCEPTIONS.filter((e) => e.why.trim().length < 10).map((e) => `${e.file}: ${e.text}`)).toEqual([]);
  });

  test("пропущенные целиком файлы существуют и в них есть что пропускать", () => {
    /*
     * Файл без кириллицы в пропуске — мёртвый пропуск: его пора охранять.
     * Словари общего пакета проверяются тем же правилом — они кириллицей и
     * живут.
     */
    const dead: string[] = [];
    for (const file of [...SERVER_SKIPPED.keys(), ...SHARED_SKIPPED.keys()]) {
      let source = "";
      expect(() => {
        source = readFileSync(join(ROOT, file), "utf8");
      }, `${file} пропал — поправь список`).not.toThrow();
      const cyrillic = rawStrings(file, source, { devCalls: DEV_CALLS }).filter((x) => x.kind === "cyrillic");
      if (!cyrillic.length) dead.push(file);
    }
    expect(dead, "в пропущенном файле не осталось кириллицы — верни его под охрану").toEqual([]);
  });

  test("охраняемые каталоги существуют", () => {
    for (const dir of SERVER_DIRS) {
      expect(sourceFiles(join(ROOT, dir)).length, `${dir} пуст или пропал`).toBeGreaterThan(0);
    }
    for (const file of SERVER_FILES) {
      expect(() => readFileSync(join(ROOT, file)), `${file} пропал — поправь список`).not.toThrow();
    }
  });
});

/*
 * Сторож проверяется на том, что пропускал бы глаз: русские слова внутри
 * шаблона разметки печатного листа и внутри CSS-комментария, который
 * уезжает вместе со страницей.
 */
describe("сторож сервера ловит то, ради чего заведён", () => {
  const scanOne = (src: string) =>
    rawStrings("x.ts", src, { devCalls: DEV_CALLS })
      .filter((f) => f.kind === "cyrillic")
      .map((f) => f.text);

  test("фраза в шаблоне разметки — нарушение", () => {
    expect(scanOne("const html = `<h2>Ответы</h2><td>${n} из ${m}</td>`;")).toEqual([
      "<h2>Ответы</h2><td>${…} из ${…}</td>",
    ]);
  });

  test("CSS-комментарий внутри шаблона — тоже текст страницы", () => {
    expect(scanOne("const css = `/* таблицы не рвутся */ tr { break-inside: avoid; }`;")).toHaveLength(1);
  });

  test("комментарий кода, console.* и журнал процесса log.* — не фраза для человека", () => {
    expect(scanOne(`// «пояснение»\n/* довод */\nconsole.log("Готово: шагов", n);`)).toEqual([]);
    expect(scanOne(`log.warn("cascade.loop", { batteryId, reason: "батарея содержит методику-источник" });`)).toEqual([]);
  });

  test("ключ словаря вместо фразы проходит", () => {
    expect(scanOne(`throw new CommandError("cmd.notFound", { email });`)).toEqual([]);
  });

  test("пометка, которую сервер пишет в базу, — тоже фраза, если набрана литералом", () => {
    // именно так жили «Первая версия» и «Батарея «…»» до волны 14
    expect(scanOne(`await createVersion(id, input, user.id, "Первая версия");`)).toEqual(["Первая версия"]);
    expect(scanOne('note: `Батарея «${battery.title}»`,')).toEqual(["Батарея «${…}»"]);
    expect(scanOne(`note: noteCode("note.battery", { title: battery.title }),`)).toEqual([]);
  });
});
