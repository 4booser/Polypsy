import { type UiKey, isDateInput } from "@quizzy/shared";
import type { AuditFilters } from "./model";

/**
 * Отбор журнала → запрос к серверу: что из адреса уходит в GET /api/audit.
 *
 * Отдельно от ops/model.ts: тот в начальном куске консоли, а проверка даты
 * берётся из общего пакета вместе с zod (dates.ts) — начальному куску она
 * не нужна (test/bundle.test.ts). Экран журнала грузится по требованию.
 *
 * Зачем разбор, если поля и так дают правильные значения. Отбор журнала
 * живёт в адресе, и в адрес он попадает не только из полей: ссылки из
 * «Користувачів» (?actor=, ?subject=), из «Підозрілої активності» (период
 * днями), из закладок и переписки. Сервер проверяет отбор строго — кривая
 * дата, незнакомый исход, слишком длинный текст дают 400, — и прежде этот
 * отказ становился отказом всего экрана: вместо журнала «Невірний запит» и
 * «повторити», которое повторяло тот же отказ. Здесь кривое значение
 * значит «условия нет»: журнал открывается, а поле показывает, что условие
 * не применено.
 */

/* пределы — те же, что у auditQuery сервера; совпадение держит тест */
const TEXT_MAX = 200;
const CODE_MAX = 64;
const OUTCOMES = ["success", "denied", "error"] as const;

/** День периода — первые десять знаков: у дня и момента ISO они одного вида */
const dayOf = (v: string) => v.slice(0, 10);

/** Период перевёрнут: начало позже конца — ошибка набора, а не пустой журнал */
export function auditPeriodError(f: AuditFilters): UiKey | null {
  const from = f.from && isDateInput(f.from) ? f.from : null;
  const to = f.to && isDateInput(f.to) ? f.to : null;
  return from && to && dayOf(from) > dayOf(to) ? "coh.errPeriod" : null;
}

/**
 * Параметры запроса журнала (таблица, график по дням, выгрузка — одни и те
 * же: выгружается ровно то, что на экране).
 *
 * Свободный текст длиннее предела обрезается — первые двести знаков ищут
 * почти то же самое. Код действия и тип ресурса длиннее предела не
 * обрезаются, а снимаются: обрезанный код не совпал бы ни с чем, и пустой
 * журнал выдавал бы себя за ответ. Перевёрнутый период теряет конец — так
 * же, как у очереди случаев (alerts/model.ts): начало человек обычно ставит
 * первым, и журнал с него честнее пустого.
 */
export function auditQueryOf(f: AuditFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["q", "actor", "subject"] as const) {
    const v = f[key]?.trim().slice(0, TEXT_MAX);
    if (v) out[key] = v;
  }
  for (const key of ["action", "resourceType"] as const) {
    const v = f[key]?.trim();
    if (v && v.length <= CODE_MAX) out[key] = v;
  }
  if (f.outcome && (OUTCOMES as readonly string[]).includes(f.outcome)) out.outcome = f.outcome;
  if (f.from && isDateInput(f.from)) out.from = f.from;
  if (f.to && isDateInput(f.to) && !auditPeriodError(f)) out.to = f.to;
  return out;
}
