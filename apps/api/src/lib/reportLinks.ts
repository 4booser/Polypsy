import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { Lang } from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import { reportLinks } from "../db/schema";

/**
 * Одноразовые ссылки на печатный лист прохождения (волна 14, мобилка).
 *
 * Зачем. Лист отдаёт GET /api/reports/responses/:id, закрытый входом:
 * токен — в заголовке Authorization. Консоль забирает лист запросом с
 * заголовками и открывает из памяти (apps/web/src/api.ts, openInTab).
 * Мобилка открывала тот же адрес браузером телефона (Linking.openURL): без
 * токена — 401, без языка приложения — лист на языке браузера. Токен в
 * адрес класть нельзя: адрес оседает в истории, логах прокси и Referer, а
 * access-токен полчаса открывает всё, что открывает его владелец.
 *
 * Почему ссылка, а не «скачать и показать внутри приложения». Показать HTML
 * внутри — это WebView или модуль печати, то есть новая нативная
 * зависимость и новая сборка; файл с листом, сохранённый на устройство,
 * пережил бы смену человека на общем телефоне обхода (offline/owner.ts), а
 * стирать его пришлось бы отдельно от всего остального. Браузер телефона
 * уже умеет показать, распечатать, сохранить в PDF и отправить — а
 * ссылка на минуту и один раз даёт ему ровно один лист.
 *
 * Свойства ссылки:
 *   — 256 случайных бит; в базе — sha256 (утечка таблицы ссылок не даёт);
 *   — живёт REPORT_LINK_TTL_MS: утёкшая через историю или лог — уже мертва;
 *   — гасится первым открытием, условием самого UPDATE (как claimRotation в
 *     lib/refresh.ts): два одновременных открытия одной ссылки — одно
 *     проходит, второе получает отказ;
 *   — привязана к человеку и прохождению: лист собирается от имени
 *     выдавшего, с его зоной видимости и правилом показа результатов;
 *   — язык листа запомнен при выдаче: это язык приложения.
 */

/** Минута: хватает открыть браузер на медленном телефоне, мало для чего-то ещё */
export const REPORT_LINK_TTL_MS = 60_000;

/**
 * Сколько держать отжившие ссылки. Сутки — чтобы повтор погашенной ссылки
 * в тот же день был опознан как ПОВТОР (строка журнала «reused»: ссылка
 * утекла или открыта дважды), а не как незнакомая.
 */
const KEEP_SPENT_MS = 86_400_000;

/** Адрес, который открывает браузер; префикс знает и мобилка (src/report/model.ts) */
export const REPORT_LINK_PREFIX = "/api/report-links/";

export function hashLinkToken(raw: string): string {
  return new Bun.CryptoHasher("sha256").update(raw).digest("hex");
}

function newRawToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export interface IssuedReportLink {
  id: string;
  /** Сама ссылка — отдаётся один раз, в ответе выдачи, и больше нигде не хранится */
  raw: string;
}

/**
 * Выдача ссылки — в транзакции запроса выдающего.
 *
 * Вставка идёт под его ролью: политика report_links_issue пускает только
 * ссылку на себя (миграция 0109). Чистка отживших — системной ролью, не
 * выходя из транзакции (asSystem): читать и удалять чужие ссылки человеку
 * не положено, а отдельный фоновый такт ради таблицы в сотню строк в день
 * был бы тяжелее самой чистки — по индексу срока она почти всегда пустая.
 */
export async function issueReportLink(input: {
  userId: string;
  responseId: string;
  lang: Lang;
}): Promise<IssuedReportLink> {
  const raw = newRawToken();
  const id = crypto.randomUUID();
  /*
   * Выдача и срок — по часам базы, как и гашение (claimReportLink): выдать
   * может один экземпляр API, а открыть — другой, и минута не тот срок, на
   * котором расхождением их часов можно пренебречь. Без RETURNING: вставка
   * идёт под ролью выдающего, а читать строку ссылки ему политика не даёт —
   * INSERT … RETURNING упал бы на ней (та же ловушка, что в 0108).
   */
  await db.insert(reportLinks).values({
    id,
    tokenHash: hashLinkToken(raw),
    userId: input.userId,
    responseId: input.responseId,
    lang: input.lang,
    expiresAt: sql`now() + make_interval(secs => ${REPORT_LINK_TTL_MS / 1000})`,
  });
  await asSystem(() =>
    db.delete(reportLinks).where(lt(reportLinks.expiresAt, sql`now() - make_interval(secs => ${KEEP_SPENT_MS / 1000})`)),
  );
  return { id, raw };
}

export type ReportLinkRow = typeof reportLinks.$inferSelect;

export type ClaimedReportLink =
  | { ok: true; link: ReportLinkRow }
  /*
   * unknown — такой ссылки нет (или её уже вычистили); used — открыта раньше;
   * expired — минута прошла. Наружу все три — один и тот же отказ: причина
   * нужна журналу, а не тому, кто держит ссылку.
   */
  | { ok: false; reason: "unknown" | "used" | "expired"; link: ReportLinkRow | null };

/**
 * Погасить ссылку первым открытием.
 *
 * Вызывающий оборачивает в systemContext: браузер приходит без входа, и чья
 * это ссылка, становится известно только отсюда. Гашение — своей
 * транзакцией, до того как собирается лист: откат запроса (лист не
 * собрался, результаты скрыты) не должен оживлять ссылку.
 *
 * Время — базы (now()), как и при выдаче: см. issueReportLink.
 */
export async function claimReportLink(raw: string): Promise<ClaimedReportLink> {
  const hash = hashLinkToken(raw);
  const [taken] = await db
    .update(reportLinks)
    .set({ usedAt: sql`now()` })
    .where(and(eq(reportLinks.tokenHash, hash), isNull(reportLinks.usedAt), gt(reportLinks.expiresAt, sql`now()`)))
    .returning();
  if (taken) return { ok: true, link: taken };
  const row = await db.query.reportLinks.findFirst({ where: eq(reportLinks.tokenHash, hash) });
  if (!row) return { ok: false, reason: "unknown", link: null };
  return { ok: false, reason: row.usedAt ? "used" : "expired", link: row };
}
