import type { SurveyListItem, UiKey } from "@quizzy/shared";
import type { NoteState, NoteVersion } from "../api";
import { pastDeadline } from "../components/deadline";

/**
 * Протокол экрана приёма без React: что стоит в поле и поверх какой версии
 * записи оно набрано (w14:webtails).
 *
 * Протокол приёма — та же заметка о человеке, что правит NotesEditor в
 * карте, и сервер сверяет сохранение с версией и редакцией, которые человек
 * видел (routes/notes.ts): переписали запись, пока она была открыта, —
 * отказ 409, а не молчаливая замена. Но сверка защищает ровно настолько,
 * насколько честна база, которую экран шлёт. Экран приёма слал не то, что
 * видел человек, а последнее, что пришло:
 *
 *  - запись не загрузилась (отказ сервера) — поле стояло пустым, как у
 *    человека без записей. Специалист писал протокол с нуля, не зная, что
 *    черновик уже есть;
 *  - запись ещё грузилась — поле уже было открыто для набора, и пришедший
 *    потом черновик в него не вставал (набранное не затирается). Человек
 *    черновика не видел, а сохранение уходило с базой пришедшего — сервер
 *    принимал, и чужой черновик молча заменялся;
 *  - запись перечитывалась сама (вернулась связь) — база сдвигалась на
 *    свежую редакцию коллеги под текстом, набранным поверх прежней: снова
 *    замена без 409;
 *  - после своего сохранения база обновлялась лишь перечитыванием, которое
 *    шло следом: «Зберегти» ещё раз до его конца уходило со старой
 *    редакцией и упиралось в 409 с самим собой.
 *
 * Отсюда устройство: поле открывается только ответом сервера, и вместе с
 * текстом запоминается база (`seen`) — версия, чей текст лёг в поле. Её
 * сдвигает только то, что человек увидел или сделал сам: своё сохранение
 * (ответ сервера) и «перечитати». Перечитывание само по себе базу не трогает.
 *
 * Проверяется без браузера: apps/web/test/visitProtocol.test.tsx.
 */

export type NoteBase = Pick<NoteVersion, "version" | "revision">;

export interface Protocol {
  /** Текст поля; null — ответа о записи ещё не было, и поля нет */
  text: string | null;
  /** Версия и редакция, поверх которых набран текст; null — записей не было вовсе */
  seen: NoteBase | null;
  /**
   * Стенограмма, вставленная до ответа о записи: встанет после текста
   * записи, когда он придёт, — а не вместо него.
   */
  pending: string;
}

export type ProtocolEvent =
  /** Пришла запись (первый ответ или перечитывание само собой) */
  | { type: "loaded"; state: NoteState }
  | { type: "edit"; text: string }
  /** Вставка стенограммы: в конец набранного */
  | { type: "append"; text: string }
  /** Своё сохранение прошло: база — то, что вернул сервер */
  | { type: "saved"; state: NoteState }
  /** «Перечитати» после 409: набранное заменяется записью сервера */
  | { type: "reread"; state: NoteState };

export const EMPTY_PROTOCOL: Protocol = { text: null, seen: null, pending: "" };

const baseOf = (state: NoteState): NoteBase | null =>
  state.current ? { version: state.current.version, revision: state.current.revision } : null;

const join = (a: string, b: string) => (a && b ? `${a}\n\n${b}` : a || b);

export function protocolStep(p: Protocol, e: ProtocolEvent): Protocol {
  switch (e.type) {
    case "loaded":
      // поле уже открыто — набранное не затирается, и база остаётся той, что видел человек
      if (p.text !== null) return p;
      return { text: join(e.state.current?.text ?? "", p.pending), seen: baseOf(e.state), pending: "" };
    case "edit":
      return p.text === null ? p : { ...p, text: e.text };
    case "append":
      return p.text === null ? { ...p, pending: join(p.pending, e.text) } : { ...p, text: join(p.text, e.text) };
    case "saved":
      return { ...p, seen: baseOf(e.state) };
    case "reread":
      return { text: e.state.current?.text ?? "", seen: baseOf(e.state), pending: "" };
  }
}

/**
 * Можно ли сохранять: поле открыто ответом сервера и в нём есть текст.
 * Пробелы — не текст: сервер их примет, и пустая запись легла бы поверх
 * настоящего черновика (то же правило, что draftSavable у заметок в карте).
 */
export function protocolSavable(p: Protocol): boolean {
  return p.text !== null && p.text.trim().length > 0;
}

/* ─────────── «Призначити методику» на приёме ─────────── */

/**
 * Форма назначения на экране приёма — как набрано в полях (w14:webtails).
 *
 * Та же выдача методики человеку, что окно «Призначити тест» в карте
 * (patientGroups/dialogs.tsx, AssignSurveyDialog), но своей формой — и
 * правила того окна до неё не дошли:
 *  - срок в прошлом уходил на сервер, и он его принимал: доступ истекал
 *    раньше, чем человек о нём узнавал (components/deadline.ts);
 *  - стёртое поле «Спроб» становилось нулём, и сервер отвечал отказом схемы
 *    — строкой разработчика в сообщении об ошибке;
 *  - отказ загрузки методик выглядел пустым выбором — будто назначать нечего.
 * Число попыток хранится строкой поля: иначе стёртое значение нельзя
 * отличить от набранного нуля и нельзя показать как есть.
 */
export interface AssignDraft {
  surveyId: string;
  /** «YYYY-MM-DD» из поля даты; пусто — без срока */
  due: string;
  attempts: string;
}

export const NEW_ASSIGN: AssignDraft = { surveyId: "", due: "", attempts: "1" };

/** Пределы сервера (grantAccessSchema): попыток — целое от 1 до 10 */
export const ATTEMPTS_MAX = 10;

function attemptsOf(raw: string): number | null {
  const n = Number(raw.trim());
  return raw.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= ATTEMPTS_MAX ? n : null;
}

/** Что не так с полями — ключи словаря у полей; методика не выбрана — не ошибка, кнопка просто ждёт */
export function assignProblems(d: AssignDraft, todayKey: string): { due?: UiKey; attempts?: UiKey } {
  const out: { due?: UiKey; attempts?: UiKey } = {};
  if (pastDeadline(d.due, todayKey)) out.due = "uit.form.pastDeadline";
  if (attemptsOf(d.attempts) === null) out.attempts = "wt.visit.attempts";
  return out;
}

export function assignReady(d: AssignDraft, todayKey: string): boolean {
  const p = assignProblems(d, todayKey);
  return !!d.surveyId && !p.due && !p.attempts;
}

/** Что уходит в api.grant — только из готовой формы */
export function assignBody(d: AssignDraft): { surveyId: string; expiresAt: string | null; attempts: number } {
  return { surveyId: d.surveyId, expiresAt: d.due || null, attempts: attemptsOf(d.attempts) ?? 1 };
}

/** В выборе — только опубликованные и не снятые: черновик и снятую сервер назначить не даст */
export function assignable(surveys: readonly SurveyListItem[]): SurveyListItem[] {
  return surveys.filter((s) => s.status === "published" && !s.archivedAt);
}
