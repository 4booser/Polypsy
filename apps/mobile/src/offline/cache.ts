import type {
  BatteryAssignment,
  SafetyPlan,
  SurveyFull,
  SurveyGroupWithCounts,
  SurveyListItem,
  User,
} from "@quizzy/shared";
import { store } from "./store";
import { StoreWriteError } from "./writeError";

/**
 * Кэш последнего успешного чтения — офлайн приложение показывает то, что
 * видело в последний раз, а не пустой экран. Контент конкретной версии
 * методики иммутабелен, остальное честно устаревает и обновится при сети.
 *
 * Всё — под владельцем (owner.ts): ключ `u:<владелец>:<имя>`. Раньше ключи
 * были общими на устройство, и после смены учётной записи офлайн-запасной
 * путь отдавал новому человеку список методик, назначения, карты обхода и
 * план безопасности предыдущего. Под владельцем лежит и контент методик:
 * это не личные данные, но доступ к методикам у разных людей разный, а
 * правило «всё чужое не видно» проще проверить, чем правило с исключениями.
 * Общий на устройство только его идентификатор (device.ts).
 *
 * Без владельца (никто не вошёл) кэш ничего не отдаёт и ничего не пишет:
 * ответ сервера, пришедший после выхода, не должен лечь «ничьим» и всплыть
 * у следующего.
 *
 * Отказ записи кэш глотает сам и осознанно (writeError.ts): кэш — копия того,
 * что лежит на сервере, и его потеря стоит лишь офлайн-показа; ронять из-за
 * неё успешный запрос нельзя. Черновики ниже — не кэш, и там отказ летит
 * дальше.
 */

const ownKey = (owner: string, name: string) => `u:${owner}:${name}`;

function put(owner: string | null, name: string, value: unknown): void {
  if (!owner) return;
  try {
    store.write(ownKey(owner, name), value);
  } catch {
    /* кэш — копия серверного; без неё офлайн покажет меньше, но ничего не потеряно */
  }
}

function get<T>(owner: string | null, name: string): T | null {
  return owner ? store.read<T>(ownKey(owner, name)) : null;
}

type Owner = string | null;

export const cache = {
  saveSurveyList: (owner: Owner, rows: SurveyListItem[]) => put(owner, "list:surveys", rows),
  surveyList: (owner: Owner) => get<SurveyListItem[]>(owner, "list:surveys"),

  saveGroups: (owner: Owner, rows: SurveyGroupWithCounts[]) => put(owner, "list:groups", rows),
  groups: (owner: Owner) => get<SurveyGroupWithCounts[]>(owner, "list:groups"),

  saveBatteries: (owner: Owner, rows: BatteryAssignment[]) => put(owner, "list:batteries", rows),
  batteries: (owner: Owner) => get<BatteryAssignment[]>(owner, "list:batteries"),

  /*
   * План безопасности хранится офлайн намеренно и отдельно от прочего кэша:
   * он нужен в кризис, а кризис не спрашивает, есть ли сеть. Это
   * единственный документ, который приложение обязано показать в самолётном
   * режиме — своему владельцу и никому больше.
   */
  saveSafetyPlan: (owner: Owner, plan: SafetyPlan | null) => put(owner, "safety:plan", plan),
  safetyPlan: (owner: Owner) => get<SafetyPlan>(owner, "safety:plan"),

  saveSurvey: (owner: Owner, survey: SurveyFull) => put(owner, `survey:${survey.id}`, survey),
  survey: (owner: Owner, id: string) => get<SurveyFull>(owner, `survey:${id}`),

  /**
   * Название методики из того, что уже лежит офлайн.
   *
   * Нужно экрану очереди: без сети спросить название негде, а показывать
   * человеку идентификатор — то же, что не показывать ничего.
   */
  surveyTitle: (owner: Owner, id: string): string | null =>
    get<SurveyFull>(owner, `survey:${id}`)?.title ??
    get<SurveyListItem[]>(owner, "list:surveys")?.find((s) => s.id === id)?.title ??
    null,

  /** Свой профиль: владелец — тот, кого вернул сервер, а не тот, кто спрашивал */
  saveMe: (user: User) => put(user.id, "me", user),
  me: (owner: Owner) => get<User>(owner, "me"),

  /*
   * Обход. Планшет в палате — это место, где сети нет чаще, чем есть:
   * толстые стены, подвал, отделение без точки доступа. Список на сегодня и
   * открытые карты кладутся в кэш, чтобы обход не останавливался.
   *
   * Кэш честно устаревает: рядом со списком показывается, когда он снят.
   * Молча показывать вчерашнюю очередь хуже, чем показать пустой экран.
   *
   * Карты — тоже под владельцем: планшет один на отделение, а зона
   * ответственности у двух специалистов разная, и карта, снятая одним,
   * другому может быть не положена вовсе.
   */
  saveRounds: (owner: Owner, rows: unknown) => put(owner, "rounds:list", { at: new Date().toISOString(), rows }),
  rounds: (owner: Owner) => get<{ at: string; rows: unknown }>(owner, "rounds:list"),

  savePatientCard: (owner: Owner, userId: string, card: unknown) =>
    put(owner, `rounds:card:${userId}`, { at: new Date().toISOString(), card }),
  patientCard: (owner: Owner, userId: string) =>
    get<{ at: string; card: unknown }>(owner, `rounds:card:${userId}`),
};

/**
 * Записи, лежавшие под общими ключами до появления владельца.
 *
 * Чьи они — не узнать: `me` рядом с ними мог быть уже следующего человека,
 * а список методик — ещё предыдущего. Отдать их текущему нельзя (ровно это
 * и было ошибкой), угадывать — тоже, поэтому они стираются при первом же
 * запуске. Кэш восстановится с первым онлайном. Черновики без владельца
 * стираются по той же причине: продолжить чужое незавершённое прохождение
 * хуже, чем начать своё заново, — а серверная копия черновика, если была,
 * привязана к учётной записи и никуда не делась.
 *
 * Очередь сдач здесь не трогается: это не копия серверного, а единственный
 * экземпляр ответов (queue.ts, ownerless).
 */
const LEGACY_SINGLE = ["list:surveys", "list:groups", "list:batteries", "safety:plan", "me", "rounds:list"];
const LEGACY_FAMILIES = ["survey:", "rounds:card:", "draft:"];

export function dropLegacyCache(): number {
  let removed = 0;
  for (const name of LEGACY_SINGLE) {
    if (store.read(name) !== null) {
      store.remove(name);
      removed++;
    }
  }
  for (const prefix of LEGACY_FAMILIES) {
    for (const name of store.keys(prefix)) {
      store.remove(name);
      removed++;
    }
  }
  return removed;
}

/**
 * Незавершённое прохождение на устройстве.
 *
 * До этого черновик жил только на сервере, и офлайн автосохранение молча
 * ничего не делало: телефон, севший на сто восьмидесятом пункте МЛО-200 в
 * подвале без связи, стоил человеку всего прохождения. Теперь локальная копия
 * пишется всегда, а серверная — когда получится.
 *
 * Ключ — владелец и методика: одно незавершённое прохождение на методику у
 * каждого, ровно как на сервере. Черновик без владельца открылся бы
 * следующему вошедшему как «ваше незавершённое прохождение» — с чужими
 * ответами внутри.
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
  /**
   * Номер правки: растёт с каждым автосохранением прохождения.
   *
   * Автосохранения шли параллельно, и старый запрос, ответивший позже
   * нового, записывал на устройство свою копию и помечал её
   * синхронизированной — последние ответы пропадали после перезапуска.
   * Время ответа сервера порядок правок не говорит; номер — говорит.
   * У черновиков до его появления номера нет — это правка 0.
   */
  revision?: number;
  /**
   * lastSavedAt сервера из последнего подтверждённого сохранения. По нему
   * pickDraft понимает, менялся ли серверный черновик с тех пор (другим
   * устройством), или локальная неотправленная правка просто новее.
   */
  serverSavedAt?: string | null;
}

const draftName = (surveyId: string) => `draft:${surveyId}`;

export const drafts = {
  /**
   * Бросает StoreWriteError: черновик — не кэш, а часто единственная копия
   * ответов, и экран обязан знать, что она не легла (см. writeError.ts).
   * Без владельца писать некуда — это тоже отказ, а не тишина.
   */
  save: (owner: Owner, draft: LocalDraft) => {
    if (!owner) throw new StoreWriteError(draftName(draft.surveyId));
    store.write(ownKey(owner, draftName(draft.surveyId)), draft);
  },
  /**
   * Записать, только если правка новее лежащей. Старая копия, чья запись
   * почему-то запоздала, свежую не затирает. Возвращает, легла ли запись;
   * отказ хранилища — как у save.
   */
  saveIfNewer: (owner: Owner, draft: LocalDraft): boolean => {
    if (!owner) throw new StoreWriteError(draftName(draft.surveyId));
    const stored = get<LocalDraft>(owner, draftName(draft.surveyId));
    if (stored && (stored.revision ?? 0) >= (draft.revision ?? 0)) return false;
    store.write(ownKey(owner, draftName(draft.surveyId)), {
      ...draft,
      serverSavedAt: draft.serverSavedAt ?? stored?.serverSavedAt ?? null,
    });
    return true;
  },
  /**
   * Сервер подтвердил правку `revision` (его lastSavedAt — `serverSavedAt`).
   *
   * Отметка «синхронизирован» ставится только той самой правке, что ушла:
   * лежит новее — она остаётся неотправленной и уйдёт своим ходом; лежит
   * старее (свежая копия не легла на устройство) — она стёрта, иначе прогон
   * очереди дослал бы её и откатил серверный черновик назад. Время сервера
   * запоминается в любом случае — см. serverSavedAt.
   */
  confirm: (owner: Owner, surveyId: string, revision: number, serverSavedAt: string | null) => {
    if (!owner) return;
    const name = ownKey(owner, draftName(surveyId));
    const stored = store.read<LocalDraft>(name);
    if (!stored) return;
    const rev = stored.revision ?? 0;
    if (rev < revision) {
      store.remove(name);
      return;
    }
    const seen =
      serverSavedAt && (!stored.serverSavedAt || serverSavedAt > stored.serverSavedAt)
        ? serverSavedAt
        : (stored.serverSavedAt ?? null);
    store.write(name, { ...stored, synced: stored.synced || rev === revision, serverSavedAt: seen });
  },
  get: (owner: Owner, surveyId: string) => get<LocalDraft>(owner, draftName(surveyId)),
  drop: (owner: Owner, surveyId: string) => {
    if (owner) store.remove(ownKey(owner, draftName(surveyId)));
  },
  /** Черновики владельца, не дошедшие до сервера, — их досылает тот же проход, что и сдачи */
  unsynced: (owner: Owner): LocalDraft[] =>
    owner
      ? store
          .keys(ownKey(owner, "draft:"))
          .map((k) => store.read<LocalDraft>(k))
          .filter((d): d is LocalDraft => !!d && !d.synced)
      : [],
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
 *
 * Время устройства и время сервера сравнивать честно лишь тогда, когда о
 * сервере ничего не известно. Если локальная правка не отправлена, а
 * серверный черновик не менялся с последнего подтверждённого сохранения
 * (serverSavedAt), локальная новее по построению — даже если сервер
 * получил предыдущую правку позже, чем была сделана эта: ответ медленной
 * сети приходит позже, чем человек успевает ответить на следующий вопрос.
 */
export function pickDraft(
  local: LocalDraft | null,
  remote: ResumableDraft | null,
): ResumableDraft | null {
  const localUsable = local && local.answers.length > 0;
  const remoteUsable = remote && remote.answers.length > 0;

  if (!localUsable) return remoteUsable ? remote : null;

  const unchangedRemote =
    remoteUsable &&
    !local!.synced &&
    !!local!.serverSavedAt &&
    !!remote!.lastSavedAt &&
    remote!.lastSavedAt <= local!.serverSavedAt;
  if (unchangedRemote) {
    return {
      answers: local!.answers,
      startedAt: local!.startedAt,
      durationMs: local!.durationMs,
      lastSavedAt: local!.savedAt,
    };
  }
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
