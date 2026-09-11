import { z } from "zod";

/**
 * Конфигурация процесса.
 *
 * Валидируется на старте целиком: неверная переменная окружения должна ронять
 * процесс с внятной ошибкой, а не всплывать посреди ночи в виде странного
 * поведения. Дефолты действуют только вне production — в бою обязательны
 * явные значения, иначе dev-секрет молча уезжает на сервер.
 */
const isProduction = process.env.NODE_ENV === "production";

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: isProduction
    ? z.string().min(1, "DATABASE_URL обязателен в production")
    : z.string().default("postgres://postgres@localhost:5432/quizzy"),
  JWT_SECRET: isProduction
    ? z.string().min(32, "JWT_SECRET в production — минимум 32 символа")
    : z.string().default("dev-secret-change-me"),
  /**
   * Слепой индекс телефона — свой секрет, не JWT_SECRET.
   *
   * Почему отдельный. Слепой индекс живёт в базе рядом с шифрованным
   * номером, и весь его смысл в том, что владелец дампа перебрать его не
   * может. Пока он считался на JWT_SECRET, один секрет держал три разных
   * контура сразу: подпись сессий, слепой индекс и код субъекта в
   * выгрузках. Утечка секрета подписи (самого «ходового»: он есть в
   * окружении каждого процесса, в CI, в отладочных дампах) означала, что
   * телефоны из базы восстанавливаются перебором — пространство украинских
   * номеров это примерно 10^9 HMAC, то есть минуты. ENCRYPTION_KEY при этом
   * отделён правильно, и слепой индекс сводил его отделение на нет.
   *
   * Второе: ротация JWT_SECRET — штатная реакция на утечку. С общим
   * секретом она молча меняла все отпечатки: дедупликация номеров переставала
   * находить дубликаты, и один человек заводил второй аккаунт беспрепятственно.
   *
   * Пересчитать индексы при смене секрета можно: номер хранится шифрованным
   * и расшифровывается — `bun run db:reindex-phones`.
   */
  PHONE_INDEX_SECRET: isProduction
    ? z.string().min(32, "PHONE_INDEX_SECRET в production — минимум 32 символа")
    : z.string().default("dev-phone-index-secret-change-me"),
  /**
   * Код субъекта и код наблюдения в выгрузках — тоже свой секрет.
   *
   * Тот же довод, что и у слепого индекса, плюс свой: код субъекта обязан
   * быть стабильным между выгрузками годами (на нём склеивается лонгитюд),
   * а секрет подписи сессий положено менять при любом подозрении. Два
   * требования к одному значению несовместимы, и побеждало бы всегда
   * подписное — то есть лонгитюд ломался бы молча.
   */
  EXPORT_SECRET: isProduction
    ? z.string().min(32, "EXPORT_SECRET в production — минимум 32 символа")
    : z.string().default("dev-export-secret-change-me"),
  /** Разрешённые origin консоли через запятую; пусто в dev = localhost */
  CORS_ORIGINS: z.string().default(""),
  /**
   * Ключи шифрования полей: "v1:<base64 32Б>[,v2:...]", первый — активный.
   * Пусто — поля пишутся открыто; в production пустое значение не принимается.
   */
  ENCRYPTION_KEY: z.string().default(""),
  /**
   * Через сколько дней удалять сырой поток answer_events завершённых
   * прохождений. 0 — хранить вечно. Агрегаты (время, переключения) остаются.
   */
  ANSWER_EVENTS_RETENTION_DAYS: z.coerce.number().int().min(0).default(365),
  /**
   * Пояс учреждения — по нему считаются сутки во всех сводках.
   *
   * Сутки считались двумя способами сразу: сводка резала строку ISO (то есть
   * всегда UTC), аналитика методики — средствами Postgres (то есть по поясу
   * машины с базой). На одном и том же замере в 22:30 по Киеву два экрана
   * показывали РАЗНЫЕ дни, а на разных стендах поведение отличалось ещё и
   * между собой.
   *
   * Учреждение на экземпляр одно (см. план, волна 8), поэтому пояс здесь
   * один. У отделения свой пояс есть в departments.timezone — он для
   * расписания приёма, где важен именно приёмный день конкретного кабинета.
   */
  INSTITUTION_TZ: z.string().default("Europe/Kyiv"),
  /** SMTP для уведомлений: smtp://user:pass@host:587; пусто — только журнал */
  SMTP_URL: z.string().default(""),
  MAIL_FROM: z.string().default("Quizzy <noreply@localhost>"),
  /** Адрес консоли для ссылок в письмах */
  CONSOLE_URL: z.string().default("http://localhost:5199"),
  /**
   * Название учреждения в шапке печатных документов.
   *
   * Отчёт подшивается в дело, и лист без шапки — просто распечатка, а не
   * документ. Настройкой, а не в коде: система ставится не в одну больницу.
   */
  INSTITUTION_NAME: z.string().max(200).optional(),
  INSTITUTION_UNIT: z.string().max(200).optional(),
  /** Каталог записей приёмов; должен попадать в резервное копирование отдельно */
  RECORDINGS_DIR: z.string().max(400).optional(),
  /**
   * Свой whisper.cpp: путь к исполняемому файлу и к модели.
   *
   * Пусто — расшифровки нет, и это видно на экране. Облачные сервисы
   * распознавания сюда не подставляются намеренно: отправить запись
   * психотерапевтической сессии наружу значит раскрыть её третьей стороне.
   */
  WHISPER_BIN: z.string().max(400).optional(),
  WHISPER_MODEL: z.string().max(400).optional(),
  /**
   * Вход через Google. Пусто — способа входа просто нет, и кнопки тоже.
   *
   * Дополнительный способ, а не замена паролю. В учреждении, где по записи
   * работают, потеря доступа из-за сбоя у внешнего поставщика — это
   * несостоявшийся приём; пароль обязан оставаться рабочим всегда.
   */
  GOOGLE_CLIENT_ID: z.string().max(300).optional(),
  GOOGLE_CLIENT_SECRET: z.string().max(300).optional(),
  /**
   * Куда Google возвращает человека. Полный адрес, тот же самый должен быть
   * вписан в консоли Google — расхождение даёт «redirect_uri_mismatch».
   */
  GOOGLE_REDIRECT_URI: z.string().max(500).optional(),
  /**
   * Разрешённые почтовые домены через запятую; пусто — любые.
   *
   * Для персонала это единственное, что отделяет «вошёл сотрудник» от
   * «вошёл кто угодно с почтой Google»: связывание требует уже
   * существующей учётной записи, но лишний рубеж здесь дёшев.
   */
  GOOGLE_ALLOWED_DOMAINS: z.string().default(""),
  /** Открытая регистрация пациентов без приглашения (в бою выключать) */
  OPEN_REGISTRATION: z
    .string()
    .default("1")
    .transform((v) => v !== "0" && v.toLowerCase() !== "false"),
  /** Планировщик тикает только там, где флаг включён (одна реплика) */
  SCHEDULER_ENABLED: z
    .string()
    .default("1")
    .transform((v) => v !== "0" && v.toLowerCase() !== "false"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
  throw new Error(`Конфигурация окружения не прошла проверку:\n${lines.join("\n")}`);
}

const raw = parsed.data;

if (isProduction && raw.JWT_SECRET === "dev-secret-change-me") {
  throw new Error("JWT_SECRET must be set in production");
}

/**
 * Отказ запускаться без ключа шифрования — и текст, по которому понятно, что делать.
 *
 * Почему отказ, а не предупреждение (как было). Без ключа установка пишет
 * ФИО, дату рождения, телефон, свободные ответы, заключения, заметки приёма,
 * планы безопасности, переписку и стенограммы приёмов открытым текстом — и
 * ничем себя не выдаёт: экраны те же, работа та же. Предупреждение в логе
 * при старте видит тот, кто смотрит лог при старте; через неделю в журнале
 * его уже не найти, а база к тому времени открыта целиком. Отсутствие
 * JWT_SECRET процесс роняет — а это защита сессий; защита самих данных
 * пациентов не может стоить дешевле.
 *
 * Почему без флага «да, я согласен на открытый текст». Такой флаг
 * выставляет первый же, кто спешит поднять стенд, — и остаётся в
 * production-окружении навсегда, потому что ничего не ломает.
 *
 * Почему обновление существующей установки не теряет данные. Ключ можно
 * добавить в любой момент: значения без префикса `enc1:` читаются как есть,
 * то есть старые открытые записи продолжают работать, а новые пишутся
 * шифрованными. `bun run db:encrypt` дошифровывает накопленное.
 */
const ENCRYPTION_SETUP = [
  "ENCRYPTION_KEY не задан.",
  "",
  "Без него ФИО, дата рождения, телефон, свободные ответы, заключения,",
  "заметки приёма, планы безопасности, переписка и стенограммы приёмов",
  "хранятся в базе ОТКРЫТЫМ ТЕКСТОМ: дамп, бэкап или доступ администратора",
  "базы раскрывают их целиком.",
  "",
  "Что сделать (данные при этом не теряются):",
  "  1. Сгенерировать ключ:  echo \"v1:$(head -c 32 /dev/urandom | base64)\"",
  "  2. Вписать его в ENCRYPTION_KEY и перезапустить процесс.",
  "  3. Дошифровать накопленное:  bun run --cwd apps/api db:encrypt",
  "",
  "Формат: v1:<32 байта в base64>[,v2:<...>] — первый ключ активный.",
  "Ключ хранится вне базы и попадает в резервное копирование ОТДЕЛЬНО:",
  "бэкап вместе с ключом равнозначен бэкапу без шифрования.",
].join("\n");

export const encryptionSetupHelp = ENCRYPTION_SETUP;

if (isProduction && !raw.ENCRYPTION_KEY.trim()) {
  throw new Error(ENCRYPTION_SETUP);
}

/*
 * Один секрет на три контура — это не «проще в настройке», а общий отказ.
 *
 * Совпадение значений возвращает ровно ту связку, ради разрыва которой
 * заведены отдельные переменные: утечка секрета подписи снова означала бы
 * перебор телефонов, а ротация подписи — молчаливую потерю дедупликации и
 * склейки лонгитюда. Поэтому совпадение — отказ, а не предупреждение.
 */
if (isProduction) {
  const same: string[] = [];
  if (raw.PHONE_INDEX_SECRET === raw.JWT_SECRET) same.push("PHONE_INDEX_SECRET = JWT_SECRET");
  if (raw.EXPORT_SECRET === raw.JWT_SECRET) same.push("EXPORT_SECRET = JWT_SECRET");
  if (raw.EXPORT_SECRET === raw.PHONE_INDEX_SECRET) same.push("EXPORT_SECRET = PHONE_INDEX_SECRET");
  if (same.length) {
    throw new Error(
      [
        `Секреты совпадают: ${same.join(", ")}.`,
        "",
        "Разные контуры обязаны иметь разные секреты: иначе утечка одного",
        "раскрывает остальные, а ротация одного молча ломает остальные.",
        "Сгенерировать: head -c 32 /dev/urandom | base64",
      ].join("\n"),
    );
  }
}

export const env = {
  port: raw.PORT,
  databaseUrl: raw.DATABASE_URL,
  jwtSecret: raw.JWT_SECRET,
  /** Слепой индекс телефона — только он, и больше ничего */
  phoneIndexSecret: raw.PHONE_INDEX_SECRET,
  /** Коды субъекта и наблюдения в выгрузках — только они */
  exportSecret: raw.EXPORT_SECRET,
  schedulerEnabled: raw.SCHEDULER_ENABLED,
  openRegistration: raw.OPEN_REGISTRATION,
  answerEventsRetentionDays: raw.ANSWER_EVENTS_RETENTION_DAYS,
  encryptionKeys: raw.ENCRYPTION_KEY,
  institutionTz: raw.INSTITUTION_TZ,
  smtpUrl: raw.SMTP_URL,
  mailFrom: raw.MAIL_FROM,
  consoleUrl: raw.CONSOLE_URL,
  institutionName: raw.INSTITUTION_NAME,
  institutionUnit: raw.INSTITUTION_UNIT,
  /**
   * Каталог, где лежат записи приёмов.
   *
   * Файлы, а не строки в базе: часовой приём — десятки мегабайт, и класть их
   * в строку значит превратить бэкап базы в неподъёмный. Каталог обязан
   * попадать в резервное копирование отдельно, и об этом сказано в RUNBOOK.
   */
  recordingsDir: raw.RECORDINGS_DIR ?? "./data/recordings",
  /**
   * Путь к своему whisper.cpp. Пусто — расшифровки нет, и это видно на
   * экране: запись остаётся аудио, а не молча числится «в обработке».
   *
   * Облачные сервисы распознавания сюда не подставляются намеренно: отправить
   * запись психотерапевтической сессии наружу значит раскрыть её третьей
   * стороне, и никакая настройка этого не оправдывает.
   */
  googleClientId: raw.GOOGLE_CLIENT_ID,
  googleClientSecret: raw.GOOGLE_CLIENT_SECRET,
  googleRedirectUri: raw.GOOGLE_REDIRECT_URI,
  googleAllowedDomains: raw.GOOGLE_ALLOWED_DOMAINS.split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean),
  whisperBin: raw.WHISPER_BIN,
  whisperModel: raw.WHISPER_MODEL,
  corsOrigins: raw.CORS_ORIGINS
    ? raw.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : isProduction
      ? [] // в production пустой список — значит CORS закрыт совсем
      : ["http://localhost:5199", "http://localhost:8081"],
  isProduction,
};
