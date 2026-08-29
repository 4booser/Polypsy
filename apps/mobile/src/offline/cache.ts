import type {
  BatteryAssignment,
  SafetyPlan,
  SurveyFull,
  SurveyGroupWithCounts,
  SurveyListItem,
  User,
} from "@quizzy/shared";
import { store } from "./store";

/**
 * Кэш последнего успешного чтения — офлайн приложение показывает то, что
 * видело в последний раз, а не пустой экран. Контент конкретной версии
 * методики иммутабелен, остальное честно устаревает и обновится при сети.
 */

export const cache = {
  saveSurveyList: (rows: SurveyListItem[]) => store.write("list:surveys", rows),
  surveyList: () => store.read<SurveyListItem[]>("list:surveys"),

  saveGroups: (rows: SurveyGroupWithCounts[]) => store.write("list:groups", rows),
  groups: () => store.read<SurveyGroupWithCounts[]>("list:groups"),

  saveBatteries: (rows: BatteryAssignment[]) => store.write("list:batteries", rows),
  batteries: () => store.read<BatteryAssignment[]>("list:batteries"),

  /*
   * План безопасности хранится офлайн намеренно и отдельно от прочего кэша:
   * он нужен в кризис, а кризис не спрашивает, есть ли сеть. Это
   * единственный документ, который приложение обязано показать в самолётном
   * режиме.
   */
  saveSafetyPlan: (plan: SafetyPlan | null) => store.write("safety:plan", plan),
  safetyPlan: () => store.read<SafetyPlan>("safety:plan"),

  saveSurvey: (survey: SurveyFull) => store.write(`survey:${survey.id}`, survey),
  survey: (id: string) => store.read<SurveyFull>(`survey:${id}`),

  /**
   * Название методики из того, что уже лежит офлайн.
   *
   * Нужно экрану очереди: без сети спросить название негде, а показывать
   * человеку идентификатор — то же, что не показывать ничего.
   */
  surveyTitle: (id: string): string | null =>
    store.read<SurveyFull>(`survey:${id}`)?.title ??
    store.read<SurveyListItem[]>("list:surveys")?.find((s) => s.id === id)?.title ??
    null,

  saveMe: (user: User) => store.write("me", user),
  me: () => store.read<User>("me"),

  /*
   * Обход. Планшет в палате — это место, где сети нет чаще, чем есть:
   * толстые стены, подвал, отделение без точки доступа. Список на сегодня и
   * открытые карты кладутся в кэш, чтобы обход не останавливался.
   *
   * Кэш честно устаревает: рядом со списком показывается, когда он снят.
   * Молча показывать вчерашнюю очередь хуже, чем показать пустой экран.
   */
  saveRounds: (rows: unknown) => store.write("rounds:list", { at: new Date().toISOString(), rows }),
  rounds: () => store.read<{ at: string; rows: unknown }>("rounds:list"),

  savePatientCard: (userId: string, card: unknown) =>
    store.write(`rounds:card:${userId}`, { at: new Date().toISOString(), card }),
  patientCard: (userId: string) =>
    store.read<{ at: string; card: unknown }>(`rounds:card:${userId}`),
};

/**
 * Незавершённое прохождение на устройстве.
 *
 * До этого черновик жил только на сервере, и офлайн автосохранение молча
 * ничего не делало: телефон, севший на сто восьмидесятом пункте МЛО-200 в
 * подвале без связи, стоил человеку всего прохождения. Теперь локальная копия
 * пишется всегда, а серверная — когда получится.
 *
 * Ключ — методика: одно незавершённое прохождение на методику, ровно как на
 * сервере.
 */
export interface LocalDraft {
  surveyId: string;
  answers: unknown[];
  startedAt: string;
  durationMs: number;
  events: unknown[];
  savedAt: string;
  /** Ушёл ли черновик на сервер: непосланные догоняются при сети */
  synced: boolean;
}

const draftKey = (surveyId: string) => `draft:${surveyId}`;

export const drafts = {
  save: (draft: LocalDraft) => store.write(draftKey(draft.surveyId), draft),
  get: (surveyId: string) => store.read<LocalDraft>(draftKey(surveyId)),
  drop: (surveyId: string) => store.remove(draftKey(surveyId)),
  /** Черновики, не дошедшие до сервера — их досылает тот же проход, что и сдачи */
  unsynced: (): LocalDraft[] =>
    store
      .keys("draft:")
      .map((k) => store.read<LocalDraft>(k))
      .filter((d): d is LocalDraft => !!d && !d.synced),
};

export interface ResumableDraft {
  answers: unknown[];
  startedAt: string;
  durationMs: number;
  lastSavedAt: string | null;
}

/**
 * Какой черновик показывать при возобновлении.
 *
 * Берётся тот, что новее. Локальный свежее серверного ровно тогда, когда
 * человек отвечал без сети, — и именно его терять нельзя. При равенстве
 * выигрывает серверный: он уже пережил синхронизацию, и продолжать разумнее
 * с той копии, которую видят обе стороны.
 *
 * Пустой черновик не считается: «продолжить» с нуля ответов — это не
 * продолжение, а лишний экран между человеком и первым вопросом.
 */
export function pickDraft(
  local: LocalDraft | null,
  remote: ResumableDraft | null,
): ResumableDraft | null {
  const localUsable = local && local.answers.length > 0;
  const remoteUsable = remote && remote.answers.length > 0;

  if (!localUsable) return remoteUsable ? remote : null;
  if (!remoteUsable) {
    return {
      answers: local!.answers,
      startedAt: local!.startedAt,
      durationMs: local!.durationMs,
      lastSavedAt: local!.savedAt,
    };
  }

  return local!.savedAt > (remote!.lastSavedAt ?? "")
    ? {
        answers: local!.answers,
        startedAt: local!.startedAt,
        durationMs: local!.durationMs,
        lastSavedAt: local!.savedAt,
      }
    : remote;
}
