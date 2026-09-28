import type { Mailing, MailingInput, MailingUpdateInput } from "@quizzy/shared";

/**
 * Чистая часть раздела «Повідомлення» (розсилки): что лежит в черновике
 * формы и как он превращается в запрос. Вынесено из экранов ради проверки без
 * React и сервера (apps/web/test/mailings.test.ts): у пустых вариантов и
 * потолка на их число есть граничные случаи, которые на живом экране
 * воспроизводятся только руками.
 */

/** Потолок сервера (mailingInputSchema: options ≤ 10) — глиф «+» гаснет на нём */
export const MAX_OPTIONS = 10;

export interface MailingDraft {
  title: string;
  body: string;
  options: string[];
  /** Пустая строка — адресат не выбран: селект не умеет null */
  patientGroupId: string;
  /**
   * Редакция, с которой черновик открыт (Mailing.revision); null — повідомлення
   * ещё не заведено. Уходит в правку и отправку: сервер сверяет её с тем, что
   * лежит у него, и поверх чужой правки отвечает 409 (волна 15).
   */
  revision: number | null;
}

export const mailingHref = (id: string) => `/mailings/${id}`;

/**
 * Варианты ответа, какими они уйдут на сервер: без пробелов по краям, без
 * пустых, не больше потолка.
 *
 * Пустой вариант выбрасывается, а не отклоняется. На кадре у варианта нет
 * глифа «убрать» — только «+» добавить, — и единственный способ избавиться
 * от лишней кнопки «Так / Ні / …» у человека — стереть текст. Ругаться на
 * пустое поле значило бы запереть его в форме без выхода.
 */
export function cleanOptions(options: readonly string[]): string[] {
  return options
    .map((o) => o.trim())
    .filter((o) => o.length > 0)
    .slice(0, MAX_OPTIONS);
}

export function draftFromMailing(m: Mailing): MailingDraft {
  return {
    title: m.title,
    body: m.body,
    options: [...m.options],
    patientGroupId: m.patientGroupId ?? "",
    revision: m.revision,
  };
}

/**
 * Тело запроса из черновика. Поимённый список адресатов (patientIds) не
 * посылается вовсе: на кадрах его нет, экран его не ведёт, а прислать пустой
 * массив значило бы стереть список, заведённый другим способом.
 */
export function draftToInput(d: MailingDraft): MailingInput {
  return {
    title: d.title.trim(),
    body: d.body.trim(),
    options: cleanOptions(d.options),
    patientGroupId: d.patientGroupId || null,
  };
}

/** Есть ли что сохранять: сервер требует непустые название и текст (min(1)) */
export const isFilled = (d: MailingDraft) => d.title.trim().length > 0 && d.body.trim().length > 0;

/**
 * Тело «Зберегти»: то, что на экране, и редакция, поверх которой правили.
 *
 * Без редакции две вкладки (или автор и суперадмин) молча затирали правки
 * друг друга: побеждал нажавший вторым. С ней сервер отвечает 409, и экран
 * предлагает перечитать.
 */
export function draftToUpdate(d: MailingDraft): MailingUpdateInput {
  return { ...draftToInput(d), ...(d.revision !== null && { baseRevision: d.revision }) };
}

export interface SendIo {
  /** «Зберегти» — ответ: сохранённая рассылка с новой редакцией */
  save: (input: MailingUpdateInput) => Promise<Mailing>;
  /** «Відправити» ровно эту редакцию */
  send: (revision: number) => Promise<unknown>;
  /** Положить сохранённое на экран */
  apply: (saved: Mailing) => void;
}

/**
 * «Відправити» с экрана: сохранить то, что видно, и отправить ровно
 * сохранённую редакцию.
 *
 * Сохранение нужно, потому что человек мог править и не нажать «Зберегти»:
 * уйти должно то, что он видит. Отправка называет редакцию, которую вернуло
 * сохранение, — если между двумя запросами черновик переписал кто-то
 * другой (внешний разбор 2026-09-28, п. 1: иначе уходил чужой текст, да ещё
 * прежним адресатам), сервер откажет 409, и не уйдёт ничего. Сохранённое
 * ложится на экран сразу, до отправки: не удалась отправка — повтор не
 * упрётся в конфликт с собственной правкой.
 */
export async function saveThenSend(d: MailingDraft, io: SendIo): Promise<void> {
  const saved = await io.save(draftToUpdate(d));
  io.apply(saved);
  await io.send(saved.revision);
}
