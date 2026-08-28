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
};
