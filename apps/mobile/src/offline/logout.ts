/**
 * Что сказать человеку, который выходит, пока его ответы ещё на устройстве.
 *
 * Раньше выход с непустой очередью просто запрещался («дочекайтеся мережі»).
 * На общем планшете это ловушка: пациент А не может выйти, пока нет сети, а
 * пациент Б не может войти. Отвергнутые сервером сдачи при этом не считались
 * вовсе — с ними выйти было можно, и они доставались следующему.
 *
 * Теперь выйти можно всегда, а неотправленное остаётся за владельцем и ждёт
 * его следующего входа на этом устройстве (offline/queue.ts — почему именно
 * так). Человеку перед выходом говорят, сколько его ответов остаётся здесь и
 * что с ними будет, — чтобы он не ушёл в уверенности, что всё отправлено, и
 * не удалил приложение вместе с ними.
 *
 * Ничего нет — и говорить нечего: выход без лишнего вопроса.
 */
export type LogoutLine =
  | { key: "mp.logoutKeepsAnswers"; n: number }
  | { key: "mp.logoutKeepsDrafts"; n: number };

export function logoutNotice(unsent: { submissions: number; drafts: number }): LogoutLine[] | null {
  const lines: LogoutLine[] = [];
  if (unsent.submissions > 0) lines.push({ key: "mp.logoutKeepsAnswers", n: unsent.submissions });
  if (unsent.drafts > 0) lines.push({ key: "mp.logoutKeepsDrafts", n: unsent.drafts });
  return lines.length ? lines : null;
}
