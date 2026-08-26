import type { BatteryAssignment, SurveyFull, SurveyGroupWithCounts, SurveyListItem, User } from "@quizzy/shared";
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

  saveSurvey: (survey: SurveyFull) => store.write(`survey:${survey.id}`, survey),
  survey: (id: string) => store.read<SurveyFull>(`survey:${id}`),

  saveMe: (user: User) => store.write("me", user),
  me: () => store.read<User>("me"),
};
