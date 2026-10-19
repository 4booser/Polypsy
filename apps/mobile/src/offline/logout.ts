import { heads } from "../staff/people";
import { reviewDrafts } from "../staff/reviewDrafts";
import { forgetOwnerCache } from "./cache";
import { draftLanes, ownerLanePrefix } from "./draftLane";
import { signedOut } from "./owner";

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

/**
 * Что выход делает с офлайн-слоем вышедшего (#130).
 *
 * Запись за него закрывается первой (owner.ts, signedOut): ответ, запрошенный
 * до выхода, не положит его данные обратно. Потом уходят копии с сервера
 * (cache.ts, forgetOwnerCache) — остаются очередь сдач и неотправленные
 * черновики. Дорожки его черновиков сбрасываются: дошедший черновик стёрт
 * с устройства, и при следующем входе экран продолжит его с сервера,
 * считая правки заново (offline/draftLane.ts, #129).
 *
 * Черновики разбора сигналов (решение и заметка о пациенте) живут в памяти
 * и уходят все: следующий на этом планшете не должен найти их в листе
 * разбора того же случая (staff/reviewDrafts.ts). С ними — запомненные
 * шапки открытых людей (staff/people.ts).
 */
export function leaveDevice(owner: string | null): void {
  reviewDrafts.forgetAll();
  heads.forgetAll();
  if (!owner) return;
  signedOut(owner);
  try {
    forgetOwnerCache(owner);
  } catch {
    /* хранилище не ответило — запись за вышедшего закрыта, следующий выход дочистит */
  }
  draftLanes.resetAll(ownerLanePrefix(owner));
}
