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
  /** Разрешённые origin консоли через запятую; пусто в dev = localhost */
  CORS_ORIGINS: z.string().default(""),
  /**
   * Ключи шифрования полей: "v1:<base64 32Б>[,v2:...]", первый — активный.
   * Пусто — поля пишутся открыто (dev); в production это громкое предупреждение.
   */
  ENCRYPTION_KEY: z.string().default(""),
  /** SMTP для уведомлений: smtp://user:pass@host:587; пусто — только журнал */
  SMTP_URL: z.string().default(""),
  MAIL_FROM: z.string().default("Quizzy <noreply@localhost>"),
  /** Адрес консоли для ссылок в письмах */
  CONSOLE_URL: z.string().default("http://localhost:5199"),
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

export const env = {
  port: raw.PORT,
  databaseUrl: raw.DATABASE_URL,
  jwtSecret: raw.JWT_SECRET,
  schedulerEnabled: raw.SCHEDULER_ENABLED,
  openRegistration: raw.OPEN_REGISTRATION,
  encryptionKeys: raw.ENCRYPTION_KEY,
  smtpUrl: raw.SMTP_URL,
  mailFrom: raw.MAIL_FROM,
  consoleUrl: raw.CONSOLE_URL,
  corsOrigins: raw.CORS_ORIGINS
    ? raw.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
    : isProduction
      ? [] // в production пустой список — значит CORS закрыт совсем
      : ["http://localhost:5199", "http://localhost:8081"],
  isProduction,
};
