import type {
  Answer,
  SafetyPlan,
  AnswerEvent,
  AuthPayload,
  CreateSurveyInput,
  GroupInput,
  OverviewAnalytics,
  ScoreResult,
  SurveyAnalytics,
  SurveyFull,
  SurveyGroup,
  SurveyGroupWithCounts,
  GroupAdmin,
  SurveyListItem,
  SurveyResponse,
  UpdateSurveyInput,
  User,
  AlertCase,
  AuditPage,
  Worklist,
  WorkItem,
  Page,
  Respondent,
  CreateUserInput,
  RiskAlert,
  UpdateProfileInput,
  RespondentDynamics,
  SurveyVersion,
  BatteryAssignment,
  MyDynamics,
} from "@quizzy/shared";
import { API_URL } from "../config";
import { tokenStorage } from "../storage";
import { currentLang } from "../lang";
import { cache, drafts } from "../offline/cache";
import { respondentFor } from "../offline/respondent";
import { deviceId, platformName, wipeLocalData } from "../offline/device";
import { enqueue, flush, pending, pendingCount, rejectedItems, retryRejected, type QueuedSubmission } from "../offline/queue";
import { ageAt, computeProfile } from "@quizzy/shared";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Общий на все запросы обмен refresh: одноразовый токен нельзя жечь параллельно */
let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const raw = await tokenStorage.getRefresh();
    if (!raw) return false;
    try {
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: raw }),
      });
      if (!res.ok) return false;
      const pair = (await res.json()) as { token: string; refreshToken: string };
      await tokenStorage.set(pair.token);
      await tokenStorage.setRefresh(pair.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        refreshing = null;
      }, 0);
    }
  })();
  return refreshing;
}

async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const token = await tokenStorage.get();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // язык интерфейса определяет и язык контента методик
    "Accept-Language": currentLang,
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(`Не удалось связаться с сервером (${API_URL})`, 0);
  }

  // истёкший access продлеваем молча и повторяем запрос один раз
  if (res.status === 401 && !retried && !path.startsWith("/api/auth/")) {
    if (await tryRefresh()) return request<T>(path, init, true);
  }

  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(body?.error ?? `Ошибка ${res.status}`, res.status);
  return body as T;
}

/** Подробный разбор одного прохождения */
export interface ResponseDetail {
  id: string;
  survey: { id: string; title: string; scoringEnabled: boolean };
  status: string;
  startedAt: string;
  submittedAt: string | null;
  durationMs: number;
  scores: ScoreResult[];
  answers: {
    questionId: string;
    title: string;
    type: string;
    position: number;
    answered: boolean;
    optionIds: string[] | null;
    text: string | null;
    number: number | null;
    matrix: Record<string, string> | null;
    ranking: string[] | null;
    score: number | null;
    durationMs: number;
    changeCount: number;
    visitCount: number;
  }[];
}

interface SubmitResult {
  id: string;
  scores: ScoreResult[];
  safetyPlan?: string | null;
  /** Что назначила автоматика по полосам; офлайн — неизвестно до синка */
  cascade?: { assignedBatteries: string[]; scheduledFollowUps: number };
  /** Ответы легли в офлайн-очередь, а не на сервер */
  queued?: boolean;
}

/** Сетевая ошибка → кэш; кэша нет — исходная ошибка честно всплывает */
function offlineFallback<T>(error: unknown, cached: T | null): T {
  if ((error as ApiError).status === 0 && cached !== null) return cached;
  throw error;
}

/** Фоновая догрузка контента методик в кэш; ошибки не мешают основному пути */
async function prefetchSurveys(ids: string[]): Promise<void> {
  for (const id of ids) {
    if (cache.survey(id)) continue;
    try {
      cache.saveSurvey(await request<SurveyFull>(`/api/surveys/${id}`));
    } catch {
      return; // сеть пропала — дозакачаем в следующий раз
    }
  }
}

/**
 * Списочный ответ API — объект, а не голый массив: в массив нельзя добавить
 * ни «всего», ни курсор, ни признак усечения, не сломав всех читателей.
 * Разворачивается здесь, чтобы экраны не знали про обёртку.
 */
interface Items<T> {
  items: T[];
}

const unwrap = <T>(p: Promise<Items<T>>): Promise<T[]> => p.then((r) => r.items);

export const api = {
  // роль в регистрации не передаётся: её назначает только администратор
  register: (input: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
    middleName?: string | null;
    anonymous?: boolean;
    sex?: "male" | "female" | null;
    birthDate?: string | null;
    inviteCode?: string | null;
  }) =>
    request<AuthPayload>("/api/auth/register", { method: "POST", body: JSON.stringify(input) }),
  login: (input: { email: string; password: string }) =>
    request<AuthPayload>("/api/auth/login", { method: "POST", body: JSON.stringify(input) }),
  me: () =>
    request<User>("/api/auth/me").then((u) => {
      cache.saveMe(u);
      return u;
    }),
  updateProfile: (input: UpdateProfileInput) =>
    request<User>("/api/auth/me", { method: "PATCH", body: JSON.stringify(input) }),

  listGroups: () =>
    request<Items<SurveyGroupWithCounts>>("/api/groups").then(
      ({ items: rows }) => {
        cache.saveGroups(rows);
        return rows;
      },
      (error) => offlineFallback(error, cache.groups()),
    ),
  groupAdmins: (groupId: string) => unwrap(request<Items<GroupAdmin>>(`/api/groups/${groupId}/admins`)),
  assignGroupAdmin: (groupId: string, userId: string) =>
    request<{ groupId: string; userId: string }>(`/api/groups/${groupId}/admins`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
  revokeGroupAdmin: (groupId: string, userId: string) =>
    request<void>(`/api/groups/${groupId}/admins/${userId}`, { method: "DELETE" }),
  createGroup: (input: GroupInput) =>
    request<SurveyGroup>("/api/groups", { method: "POST", body: JSON.stringify(input) }),
  updateGroup: (id: string, input: Partial<GroupInput>) =>
    request<SurveyGroup>(`/api/groups/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteGroup: (id: string) => request<void>(`/api/groups/${id}`, { method: "DELETE" }),

  myBatteries: () =>
    request<Items<BatteryAssignment>>("/api/batteries/mine").then(
      ({ items: rows }) => {
        cache.saveBatteries(rows);
        return rows;
      },
      (error) => offlineFallback(error, cache.batteries()),
    ),
  myDynamics: () => request<MyDynamics>("/api/me/dynamics"),
  registerPush: (token: string, platform: "ios" | "android") =>
    request<{ ok: true }>("/api/push/register", {
      method: "POST",
      body: JSON.stringify({ token, platform }),
    }),
  forgetPush: (token: string) =>
    request<{ ok: true }>("/api/push/forget", { method: "POST", body: JSON.stringify({ token }) }),
  /**
   * Свой план безопасности.
   *
   * Кэшируется на устройство сразу после загрузки: план нужен в кризис, а
   * кризис не спрашивает, есть ли сеть. Это единственный документ, который
   * приложение обязано показать даже в самолётном режиме.
   */
  mySafetyPlan: () =>
    request<{ plan: SafetyPlan | null }>("/api/safety/me").then(
      (res) => {
        cache.saveSafetyPlan(res.plan);
        return res;
      },
      (error) => offlineFallback(error, { plan: cache.safetyPlan() }),
    ),
  consentStatus: () =>
    request<{ required: boolean; accepted: boolean; version: number | null; text: string | null }>(
      "/api/consents/me",
    ),
  acceptConsent: () => request<{ ok: true }>("/api/consents/me/accept", { method: "POST" }),

  listSurveys: (groupId?: string) =>
    request<Items<SurveyListItem>>(`/api/surveys${groupId ? `?groupId=${groupId}` : ""}`).then(
      ({ items: rows }) => {
        // кэшируем только полный список: срез по группе не должен затирать общий
        if (!groupId) {
          cache.saveSurveyList(rows);
          // контент методик подтягиваем в кэш заранее — офлайн начнётся не
          // с открытия методики, а раньше, и к этому моменту она уже на диске
          void prefetchSurveys(rows.map((r) => r.id));
        }
        return rows;
      },
      (error) => offlineFallback(error, groupId ? null : cache.surveyList()),
    ),
  getSurvey: (id: string) =>
    request<SurveyFull>(`/api/surveys/${id}`).then(
      (survey) => {
        cache.saveSurvey(survey);
        return survey;
      },
      (error) => offlineFallback(error, cache.survey(id)),
    ),
  createSurvey: (input: CreateSurveyInput) =>
    request<SurveyFull>("/api/surveys", { method: "POST", body: JSON.stringify(input) }),
  updateSurvey: (id: string, input: UpdateSurveyInput) =>
    request<SurveyFull>(`/api/surveys/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  duplicateSurvey: (id: string) =>
    request<SurveyFull>(`/api/surveys/${id}/duplicate`, { method: "POST" }),
  deleteSurvey: (id: string) => request<void>(`/api/surveys/${id}`, { method: "DELETE" }),

  submitResponse: (
    surveyId: string,
    payload: {
      answers: Answer[];
      startedAt: string;
      durationMs: number;
      status?: "completed" | "abandoned";
      events: AnswerEvent[];
      /**
       * Заполнено специалистом за пациента (режим обхода).
       *
       * Прохождение записывается на пациента, а в журнал уходит, кто его внёс.
       * Локальный подсчёт при этом ведётся по паспортным данным ПАЦИЕНТА, а не
       * заполняющего: нормы у методик по полу и возрасту, и посчитать чужие
       * баллы по своему полу значит выдать неверный профиль.
       */
      onBehalfOf?: string | null;
      /** Пол и возраст пациента — для офлайн-подсчёта в режиме обхода */
      subject?: { sex: "male" | "female" | null; age: number | null } | null;
    },
  ) =>
    request<SubmitResult>(`/api/surveys/${surveyId}/responses`, {
      method: "POST",
      body: JSON.stringify(payload),
    }).catch((error) => {
      if ((error as ApiError).status !== 0) throw error;
      /*
       * Сети нет. Ответы — клинические данные, терять их нельзя: кладём в
       * очередь (уйдёт при первой возможности, с идемпотентным id) и считаем
       * баллы локально тем же движком, что на сервере, — computeProfile общий,
       * расхождений быть не может по построению.
       */
      const item = enqueue(surveyId, { ...payload });
      const survey = cache.survey(surveyId);
      // чей пол и возраст берём для норм — см. respondentFor
      const respondent = respondentFor(payload.subject, cache.me());
      const profile =
        survey && survey.scoringEnabled
          ? computeProfile(survey, payload.answers, {
              sex: respondent.sex,
              age: respondent.age,
            })
          : null;
      const risky = profile
        ? payload.answers.some((a) =>
            survey!.questions.some((q) =>
              q.options.some((o) => o.riskFlag && (a.optionIds ?? []).includes(o.id)),
            ),
          )
        : false;
      // офлайн каскады не выполняются: назначения делает сервер при синке
      const offline: SubmitResult = {
        id: item.id,
        scores: profile?.scores ?? [],
        safetyPlan: risky ? (survey?.safetyPlan ?? null) : null,
        queued: true,
      };
      return offline;
    }),

  /**
   * Прогон офлайн-очереди; вызывается при старте, из тика и по возвращению сети.
   *
   * Сдачи идут первыми: незавершённый черновик подождёт, а сданное
   * прохождение — это уже результат, который ждут в консоли. Черновики
   * досылаются тем же проходом, чтобы не заводить второй механизм синка с
   * собственными ошибками.
   */
  flushQueue: async () => {
    const result = await flush((item: QueuedSubmission) =>
      request<SubmitResult>(`/api/surveys/${item.surveyId}/responses`, {
        method: "POST",
        body: JSON.stringify(item.payload),
      }).then(() => undefined),
    );

    for (const draft of drafts.unsynced()) {
      try {
        await request(`/api/surveys/${draft.surveyId}/draft`, {
          method: "PUT",
          body: JSON.stringify({
            answers: draft.answers,
            startedAt: draft.startedAt,
            durationMs: draft.durationMs,
            events: draft.events,
          }),
        });
        drafts.save({ ...draft, synced: true });
      } catch (error) {
        // сети по-прежнему нет — остальные тоже не уйдут
        if (((error as { status?: number }).status ?? 0) === 0) break;
        /*
         * Отказ по существу черновик не роняет: он всё равно лежит на
         * устройстве, а прохождение можно продолжить и сдать целиком.
         */
      }
    }

    return result;
  },

  pendingCount,
  /**
   * Содержимое очереди для экрана «что не ушло».
   *
   * Название методики берётся из офлайн-кэша: без сети запросить его негде,
   * а показывать человеку идентификатор — то же, что не показывать ничего.
   */
  queueItems: () =>
    pending().map((i) => ({
      id: i.id,
      surveyId: i.surveyId,
      surveyTitle: cache.surveyTitle(i.surveyId),
      queuedAt: i.queuedAt,
      attempts: i.attempts,
      rejectedReason: i.rejectedReason,
    })),
  /** Вернуть отвергнутую сдачу в очередь: решение принимает человек, а не код */
  retryQueued: retryRejected,
  /** Сколько отправок сервер отверг — их надо разбирать руками */
  rejectedCount: () => rejectedItems().length,

  surveyVersions: (surveyId: string) =>
    unwrap(request<Items<SurveyVersion>>(`/api/surveys/${surveyId}/versions`)),

  saveDraft: (
    surveyId: string,
    payload: { answers: Answer[]; startedAt: string; durationMs: number; events: unknown[] },
  ) =>
    request<{ id: string; lastSavedAt: string; answers: number }>(
      `/api/surveys/${surveyId}/draft`,
      { method: "PUT", body: JSON.stringify(payload) },
    ),
  getDraft: (surveyId: string) =>
    request<{
      id: string;
      startedAt: string;
      lastSavedAt: string | null;
      durationMs: number;
      answers: Answer[];
    } | null>(`/api/surveys/${surveyId}/draft`),

  alerts: (all = false) => unwrap(request<Items<RiskAlert>>(`/api/alerts${all ? "?all=1" : ""}`)),
  /** Случаи риска: страница с курсором */
  alertCases: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<Page<AlertCase>>(`/api/alert-cases?${qs}`);
  },
  /**
   * Разбор случая. Исход обязателен: без него разбор — это «посмотрел и
   * закрыл», а по исходам калибруются пороги скрининга.
   */
  resolveCase: (id: string, outcome: string, note?: string) =>
    request<unknown>(`/api/alert-cases/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ outcome, note }),
    }),
  assignCase: (id: string, release = false) =>
    request<unknown>(`/api/alert-cases/${id}/assign`, {
      method: "POST",
      body: JSON.stringify({ release }),
    }),

  respondents: (params: { search?: string; cursor?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<Page<Respondent>>(`/api/dynamics/respondents?${qs}`);
  },
  respondentDynamics: (userId: string) =>
    request<RespondentDynamics>(`/api/dynamics/respondents/${userId}`),

  /**
   * Обход: что от специалиста ждут сегодня.
   *
   * При отказе сети отдаётся кэш с отметкой, когда он снят. Планшет в палате —
   * место, где сети нет чаще, чем есть, и обход не должен останавливаться.
   * Отметка обязательна: молча показанная вчерашняя очередь хуже пустого
   * экрана, потому что по ней ходят как по сегодняшней.
   */
  /**
   * Отметка устройства. Вызывается при запуске и при возвращении сети.
   *
   * Если сервер просит стереть данные — стираем и подтверждаем. Подтверждение
   * отправляется ДО очистки идентификатора: после стирания устройство
   * представится новым, и подтвердить будет нечем.
   */
  deviceCheckin: async (label: string | null): Promise<boolean> => {
    const id = deviceId();
    try {
      const res = await request<{ wipe: boolean }>("/api/devices/checkin", {
        method: "POST",
        body: JSON.stringify({ deviceId: id, label, platform: platformName() }),
      });
      if (!res.wipe) return false;

      await request("/api/devices/wiped", {
        method: "POST",
        body: JSON.stringify({ deviceId: id }),
      }).catch(() => {
        /* подтверждение не дошло — стираем всё равно: это важнее отчётности */
      });
      wipeLocalData();
      /*
       * Токены тоже. Стёртое устройство, оставшееся в системе залогиненным, —
       * это ровно та ситуация, ради которой команду и отдавали: нашедший
       * планшет открывает приложение и снова видит отделение, просто без
       * кэша.
       */
      await tokenStorage.clear().catch(() => {});
      return true;
    } catch {
      // нет сети — не повод ничего стирать
      return false;
    }
  },

  rounds: async (): Promise<{ list: Worklist; cachedAt: string | null }> => {
    try {
      const list = await request<Worklist>("/api/worklist");
      cache.saveRounds(list);
      return { list, cachedAt: null };
    } catch (error) {
      const saved = cache.rounds();
      if (!saved) throw error;
      return { list: saved.rows as Worklist, cachedAt: saved.at };
    }
  },

  /** Карта пациента для обхода; тот же приём с кэшем и отметкой */
  roundsCard: async (
    userId: string,
  ): Promise<{ card: RespondentDynamics; cachedAt: string | null }> => {
    try {
      const card = await request<RespondentDynamics>(`/api/dynamics/respondents/${userId}`);
      cache.savePatientCard(userId, card);
      return { card, cachedAt: null };
    } catch (error) {
      const saved = cache.patientCard(userId);
      if (!saved) throw error;
      return { card: saved.card as RespondentDynamics, cachedAt: saved.at };
    }
  },

  reportUrl: (responseId: string) => `${API_URL}/api/reports/responses/${responseId}`,

  myResponses: () => unwrap(request<Items<SurveyResponse>>("/api/me/responses")),
  surveyResponses: (surveyId: string) =>
    request<{ rows: SurveyResponse[]; hasMore: boolean; nextBefore: string | null }>(
      `/api/surveys/${surveyId}/responses?limit=50`,
    ).then((page) => page.rows),
  responseDetail: (id: string) => request<ResponseDetail>(`/api/responses/${id}`),

  listUsers: () => unwrap(request<Items<User>>("/api/users")),
  createUser: (input: CreateUserInput) =>
    request<User>("/api/users", { method: "POST", body: JSON.stringify(input) }),

  auditLog: (params: { action?: string; limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.action) q.set("action", params.action);
    q.set("limit", String(params.limit ?? 100));
    q.set("offset", String(params.offset ?? 0));
    return request<AuditPage>(`/api/audit?${q}`);
  },
  auditSummary: () =>
    request<{
      byAction: { action: string; count: number }[];
      byActor: { actorEmail: string; count: number }[];
      deniedCount: number;
    }>("/api/audit/summary"),

  overview: () => request<OverviewAnalytics>("/api/analytics/overview"),
  surveyAnalytics: (surveyId: string, versionId?: string) =>
    request<SurveyAnalytics>(
      `/api/analytics/surveys/${surveyId}${versionId ? `?versionId=${versionId}` : ""}`,
    ),
  exportUrl: (surveyId: string) => `${API_URL}/api/analytics/surveys/${surveyId}/export`,
};
