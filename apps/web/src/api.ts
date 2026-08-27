import type {
  AuditPage,
  OverviewAnalytics,
  RespondentDynamics,
  RiskAlert,
  SurveyAnalytics,
  SurveyFull,
  SurveyGrant,
  SurveyGroupWithCounts,
  SurveyListItem,
  SurveyResponse,
  SurveyVersion,
  User,
  Issue,
  CreateUserInput,
  GroupInput,
  SurveyGroup,
  ComparisonResult,
  CorrelationMatrix,
  Battery,
  BatteryAssignment,
  BatteryInput,
  Schedule,
  ScheduleInput,
  Invite,
  CreateInviteInput,
  KioskSession,
  CreateKioskSessionInput,
  Referral,
  CreateReferralInput,
  CaseSummary,
  VersionDiff,
  AlertCase,
  Page,
  Respondent,
  UnitReport,
  Worklist,
} from "@quizzy/shared";

const TOKEN_KEY = "quizzy.web.token";
const REFRESH_KEY = "quizzy.web.refresh";

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  getRefresh: () => localStorage.getItem(REFRESH_KEY),
  setRefresh: (t: string) => localStorage.setItem(REFRESH_KEY, t),
  clear: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Тело ответа с деталями: например, список Issues при импорте */
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/**
 * Тихое продление сессии.
 *
 * Access-токен живёт 30 минут; на 401 пробуем обменять refresh и повторить
 * запрос один раз. Обмен общий на все параллельные запросы — иначе пачка
 * одновременных 401 сожжёт одноразовый refresh-токен на первом же обмене,
 * а остальные обмены сервер прочтёт как кражу и разлогинит всех.
 */
let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const raw = tokenStore.getRefresh();
    if (!raw) return false;
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: raw }),
      });
      if (!res.ok) return false;
      const pair = (await res.json()) as { token: string; refreshToken: string };
      tokenStore.set(pair.token);
      tokenStore.setRefresh(pair.refreshToken);
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
  const token = tokenStore.get();
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string>),
    },
  });
  if (res.status === 401 && !retried && !path.startsWith("/api/auth/")) {
    if (await tryRefresh()) return request<T>(path, init, true);
    tokenStore.clear();
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    /*
     * Номер запроса приходит и в заголовке, и в теле. Он приклеивается к
     * сообщению, потому что пользователь пересказывает ошибку словами, а
     * номер позволяет найти запись в логе одним поиском — вместо «вчера
     * вечером что-то не сохранилось».
     */
    const requestId = res.headers.get("x-request-id") ?? body?.requestId ?? null;
    const text = body?.error ?? `Ошибка ${res.status}`;
    throw new ApiError(requestId ? `${text} · запрос ${requestId.slice(0, 8)}` : text, res.status, body);
  }
  return body as T;
}

/**
 * Скачивание файла с сервера.
 *
 * Обычная ссылка сюда не годится: токен лежит в заголовке Authorization,
 * а навигация браузера его не отправит. Перекладывать токен в адрес нельзя —
 * он осядет в истории и в логах прокси, — поэтому файл забирается запросом,
 * а сохраняется уже из памяти.
 */
export async function download(path: string, fallbackName: string): Promise<void> {
  const token = tokenStore.get();
  const res = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error ?? `Ошибка ${res.status}`, res.status);
  }
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Открытие HTML-заключения в новой вкладке: тот же обход заголовка */
export async function openInTab(path: string): Promise<void> {
  const token = tokenStore.get();
  const res = await fetch(path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(body?.error ?? `Ошибка ${res.status}`, res.status);
  }
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  // вкладка успевает забрать содержимое; ссылку освобождаем, чтобы не течь
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface ConclusionVersion {
  id: string;
  version: number;
  text: string;
  status: "draft" | "signed";
  createdAt: string;
  authorName: string;
  signedAt: string | null;
}
export interface ConclusionState {
  current: ConclusionVersion | null;
  versions: ConclusionVersion[];
}

export interface Patient {
  id: string;
  fullName: string;
  email: string;
  /** Подразделение: по нему строится охват расписания */
  unit: string | null;
}

export interface VersionDiffResult extends VersionDiff {
  before: { versionId: string | null; versionNumber: number };
  after: { versionId: string | null; versionNumber: number };
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; refreshToken: string; user: User }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: (refreshToken: string) =>
    request<{ ok: true }>("/api/auth/logout", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  me: () => request<User>("/api/auth/me"),

  groups: () => request<SurveyGroupWithCounts[]>("/api/groups"),
  surveys: (archived = false) =>
    request<SurveyListItem[]>(`/api/surveys${archived ? "?archived=1" : ""}`),
  survey: (id: string) => request<SurveyFull>(`/api/surveys/${id}`),
  /** Методика в редактируемом виде: локализованные объекты вместо строк */
  keySheet: (id: string) => request<never>(`/api/surveys/${id}/key?lang=ru`),
  surveyRaw: (id: string) => request<SurveyFull>(`/api/surveys/${id}?raw=1`),
  validateSurvey: (draft: unknown) =>
    request<{ issues: Issue[] }>("/api/surveys/validate", {
      method: "POST",
      body: JSON.stringify(draft),
    }),
  createSurvey: (draft: unknown) =>
    request<SurveyFull>("/api/surveys", { method: "POST", body: JSON.stringify(draft) }),
  updateSurvey: (id: string, patch: unknown) =>
    request<SurveyFull>(`/api/surveys/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  importSurvey: (draft: unknown) =>
    request<{ id: string; issues: Issue[] }>("/api/surveys/import", {
      method: "POST",
      body: JSON.stringify(draft),
    }),
  duplicateSurvey: (id: string) =>
    request<SurveyFull>(`/api/surveys/${id}/duplicate`, { method: "POST" }),
  /** Снимает методику с использования. Данные не удаляются — см. surveyPurge на сервере. */
  archiveSurvey: (id: string) => request<void>(`/api/surveys/${id}`, { method: "DELETE" }),
  restoreSurvey: (id: string) => request<void>(`/api/surveys/${id}/restore`, { method: "POST" }),
  submitFor: (surveyId: string, payload: unknown) =>
    request<{ id: string; scores: unknown[]; reliable: boolean; warnings: string[] }>(
      `/api/surveys/${surveyId}/responses`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  versions: (id: string) => request<SurveyVersion[]>(`/api/surveys/${id}/versions`),
  versionDiff: (id: string, a: string, b: string) =>
    request<VersionDiffResult>(`/api/surveys/${id}/versions/${a}/diff/${b}`),

  overview: () => request<OverviewAnalytics>("/api/analytics/overview"),
  analytics: (id: string, versionId?: string, range?: { from?: string; to?: string }) => {
    const params = new URLSearchParams();
    if (versionId) params.set("versionId", versionId);
    if (range?.from) params.set("from", range.from);
    if (range?.to) params.set("to", range.to);
    const qs = params.toString();
    return request<SurveyAnalytics>(`/api/analytics/surveys/${id}${qs ? `?${qs}` : ""}`);
  },
  responses: (id: string, before?: string | null) =>
    request<{ rows: SurveyResponse[]; hasMore: boolean; nextBefore: string | null }>(
      `/api/surveys/${id}/responses?limit=50${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    ),
  exportUrl: (id: string) => `/api/analytics/surveys/${id}/export`,
  spssDataUrl: (id: string, profile = "full") => `/api/spss/surveys/${id}/data.csv?profile=${profile}`,
  spssSyntaxUrl: (id: string, profile = "full") => `/api/spss/surveys/${id}/syntax.sps?profile=${profile}`,
  codebookUrl: (id: string, profile = "full") => `/api/spss/surveys/${id}/codebook.csv?profile=${profile}`,
  longUrl: (id: string, profile = "full") => `/api/spss/surveys/${id}/long.csv?profile=${profile}`,
  methodologyUrl: (id: string) => `/api/surveys/${id}/export`,
  reportUrl: (responseId: string) => `/api/reports/responses/${responseId}`,

  batteries: () => request<Battery[]>("/api/batteries"),
  createBattery: (input: BatteryInput) =>
    request<{ id: string }>("/api/batteries", { method: "POST", body: JSON.stringify(input) }),
  updateBattery: (id: string, input: BatteryInput) =>
    request<{ ok: true }>(`/api/batteries/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteBattery: (id: string) => request<void>(`/api/batteries/${id}`, { method: "DELETE" }),
  batteryAssignments: (id: string) =>
    request<BatteryAssignment[]>(`/api/batteries/${id}/assignments`),
  assignBattery: (id: string, userId: string, dueAt: string | null, note: string | null) =>
    request<{ id: string }>(`/api/batteries/${id}/assign`, {
      method: "POST",
      body: JSON.stringify({ userId, dueAt, note }),
    }),
  cancelAssignment: (assignmentId: string) =>
    request<{ ok: true }>(`/api/batteries/assignments/${assignmentId}/cancel`, { method: "POST" }),

  kioskSessions: () => request<KioskSession[]>("/api/kiosk/sessions"),
  createKioskSession: (input: CreateKioskSessionInput) =>
    request<{ id: string; token: string }>("/api/kiosk/sessions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  closeKioskSession: (id: string) =>
    request<{ ok: true }>(`/api/kiosk/sessions/${id}/close`, { method: "POST" }),

  invites: () => request<Invite[]>("/api/invites"),
  createInvite: (input: CreateInviteInput) =>
    request<{ id: string; token: string; code: string }>("/api/invites", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeInvite: (id: string) =>
    request<{ ok: true }>(`/api/invites/${id}/revoke`, { method: "POST" }),

  /** Случаи риска: страница с курсором */
  alertCases: (params: Record<string, string | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<Page<AlertCase>>(`/api/alert-cases?${qs}`);
  },
  alertCaseUnits: () => request<string[]>("/api/alert-cases/units"),
  worklist: () => request<Worklist>("/api/worklist"),
  unitReportUnits: () => request<string[]>("/api/unit-report/units"),
  unitReport: (unit: string, from?: string, to?: string) => {
    const qs = new URLSearchParams({ unit });
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    return request<UnitReport>(`/api/unit-report?${qs}`);
  },
  assignCase: (id: string, release = false) =>
    request<void>(`/api/alert-cases/${id}/assign`, {
      method: "POST",
      body: JSON.stringify({ release }),
    }),
  resolveCase: (id: string, outcome: string, note: string) =>
    request<void>(`/api/alert-cases/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ outcome, note }),
    }),

  openapi: () => request<never>("/api/openapi.json"),
  downloadOpenapi: () => download("/api/openapi.json", "openapi.json"),

  referrals: (all = false) => request<Referral[]>(`/api/referrals${all ? "?all=1" : ""}`),
  createReferral: (input: CreateReferralInput) =>
    request<Referral>("/api/referrals", { method: "POST", body: JSON.stringify(input) }),
  updateReferral: (id: string, status: string, outcomeNote?: string) =>
    request<Referral>(`/api/referrals/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status, outcomeNote }),
    }),
  caseSummary: (userId: string) => request<CaseSummary>(`/api/referrals/summary/${userId}`),

  dataQuality: (surveyId: string) =>
    request<{
      smallCellFloor: number;
      retestWindow: { minDays: number; maxDays: number; minPairs: number };
      strata: {
        sex: string;
        band: string;
        suppressed: boolean;
        started?: number;
        completed?: number;
        completionRate?: number;
        avgSkipped?: number;
      }[];
      drift: { code: string; title: string; month: string; psi: number; n: number; verdict: string }[];
      retest: { code: string; title: string; pairs: number; icc: number | null }[];
    }>(`/api/data-quality/surveys/${surveyId}`),

  calibration: (surveyId: string) =>
    request<{
      minPerOutcome: number;
      cases: number;
      scales: {
        code: string;
        title: string;
        normalization: string;
        strata: {
          stratum: string;
          confirmed: number;
          notConfirmed: number;
          enough: boolean;
          currentThreshold: number | null;
          currentSensitivity: number | null;
          currentSpecificity: number | null;
          roc: {
            auc: number;
            bestThreshold: number;
            bestSensitivity: number;
            bestSpecificity: number;
            points: { threshold: number; tpr: number; fpr: number }[];
          } | null;
        }[];
      }[];
    }>(`/api/calibration/surveys/${surveyId}`),
  ppv: () =>
    request<{
      overall: { n: number; confirmed: number; ppv: number } | null;
      withoutOutcome: number;
      bySurvey: { surveyId: string; title: string; n: number; confirmed: number; ppv: number }[];
      byMonth: { month: string; n: number; confirmed: number; ppv: number }[];
    }>("/api/calibration/ppv"),

  dif: (surveyId: string) =>
    request<{
      surveyId: string;
      title: string;
      sample: number;
      minGroup: number;
      solidGroup: number;
      scales: {
        code: string;
        title: string;
        items: {
          questionId: string;
          position: number;
          title: string;
          entries: {
            factor: "sex" | "age" | "lang";
            reference: string;
            focal: string;
            refN: number;
            focalN: number;
            preliminary: boolean;
            result: { chi2: number; alphaMH: number; deltaMH: number; etsClass: "A" | "B" | "C"; significant: boolean } | null;
          }[];
        }[];
      }[];
      reliability: {
        code: string;
        title: string;
        groups: { group: string; n: number; alpha: number | null }[];
        alphaSpread: number | null;
      }[];
    }>(`/api/dif/surveys/${surveyId}`),
  ageCurves: (surveyId: string) =>
    request<{
      minWindow: number;
      scales: {
        code: string;
        title: string;
        normalization: string;
        bySex: {
          sex: "male" | "female";
          enough: boolean;
          points: { age: number; n: number; halfWidth: number; percentiles: { q: number; value: number }[] }[];
        }[];
      }[];
    }>(`/api/norms/surveys/${surveyId}/age-curves`),

  surveillance: (surveyId: string) =>
    request<{
      surveyId: string;
      title: string;
      minWeekN: number;
      series: {
        unit: string | null;
        center: number;
        weeks: { week: string; n: number; x: number; p: number; ucl: number; beyondLimits: boolean; runSignal: boolean }[];
      }[];
    }>(`/api/surveillance/surveys/${surveyId}`),

  normCandidates: (surveyId: string) =>
    request<{
      minGroup: number;
      scales: {
        code: string;
        title: string;
        current: { sex: string | null; mean: number; sd: number; source: string | null }[];
        candidate: { sex: string | null; n: number; mean: number; sd: number; publishable: boolean }[];
      }[];
    }>(`/api/norms/surveys/${surveyId}/candidates`),
  applyNorms: (surveyId: string, scaleCodes: string[]) =>
    request<{ versionId: string }>(`/api/norms/surveys/${surveyId}/apply`, {
      method: "POST",
      body: JSON.stringify({ scaleCodes }),
    }),

  storageStats: () =>
    request<{ database: string; tables: { table: string; bytes: number; pretty: string; rows: number }[] }>(
      "/api/audit/storage",
    ),

  consentText: () =>
    request<{ version: number; body: Record<string, string>; createdAt: string } | null>("/api/consents/text"),
  saveConsentText: (body: Record<string, string>) =>
    request<{ version: number }>("/api/consents/text", { method: "PUT", body: JSON.stringify({ body }) }),

  schedules: () => request<Schedule[]>("/api/schedules"),
  scheduleUnits: () => request<string[]>("/api/schedules/units"),
  createSchedule: (input: ScheduleInput) =>
    request<{ id: string }>("/api/schedules", { method: "POST", body: JSON.stringify(input) }),
  updateSchedule: (id: string, input: ScheduleInput) =>
    request<{ ok: true }>(`/api/schedules/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteSchedule: (id: string) => request<void>(`/api/schedules/${id}`, { method: "DELETE" }),
  runSchedule: (id: string) =>
    request<Schedule>(`/api/schedules/${id}/run`, { method: "POST" }),

  conclusion: (responseId: string) =>
    request<ConclusionState>(`/api/conclusions/responses/${responseId}/conclusion`),
  saveConclusion: (responseId: string, text: string) =>
    request<ConclusionState>(`/api/conclusions/responses/${responseId}/conclusion`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),
  signConclusion: (responseId: string) =>
    request<ConclusionState>(`/api/conclusions/responses/${responseId}/conclusion/sign`, {
      method: "POST",
    }),

  compare: (surveyId: string, by: string) =>
    request<ComparisonResult>(`/api/compare/surveys/${surveyId}?by=${by}`),
  correlations: (surveyId: string) =>
    request<CorrelationMatrix>(`/api/compare/surveys/${surveyId}/correlations`),

  respondents: (params: { search?: string; cursor?: string; limit?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<Page<Respondent>>(`/api/dynamics/respondents?${qs}`);
  },
  dynamics: (userId: string) => request<RespondentDynamics>(`/api/dynamics/respondents/${userId}`),

  alerts: (all = false) => request<RiskAlert[]>(`/api/alerts${all ? "?all=1" : ""}`),
  acknowledgeAlert: (id: string, note?: string, outcome?: "confirmed" | "not_confirmed" | "needs_followup") =>
    request<unknown>(`/api/alerts/${id}/acknowledge`, {
      method: "PATCH",
      body: JSON.stringify({ note, outcome }),
    }),

  grants: (surveyId: string) => request<SurveyGrant[]>(`/api/access/surveys/${surveyId}/grants`),
  grant: (surveyId: string, userId: string, note?: string, expiresAt?: string | null) =>
    request<unknown>(`/api/access/surveys/${surveyId}/grants`, {
      method: "POST",
      body: JSON.stringify({ userId, note, expiresAt }),
    }),
  revoke: (surveyId: string, userId: string) =>
    request<void>(`/api/access/surveys/${surveyId}/grants/${userId}`, { method: "DELETE" }),
  /**
   * Пациенты. Отдаётся не всё: список упорядочен по ФИО, а оно зашифровано —
   * упорядочить его в SQL нечем, поэтому сервер ищет и обрезает выдачу.
   */
  patients: (params: { search?: string; unit?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<{ items: Patient[]; total: number; truncated: boolean }>(
      `/api/access/patients?${qs}`,
    );
  },

  users: () => request<User[]>("/api/users"),
  createUser: (input: CreateUserInput) =>
    request<User>("/api/users", { method: "POST", body: JSON.stringify(input) }),
  createGroup: (input: GroupInput) =>
    request<SurveyGroup>("/api/groups", { method: "POST", body: JSON.stringify(input) }),
  deleteGroup: (id: string) => request<void>(`/api/groups/${id}`, { method: "DELETE" }),
  assignGroupAdmin: (groupId: string, userId: string) =>
    request<unknown>(`/api/groups/${groupId}/admins`, { method: "POST", body: JSON.stringify({ userId }) }),
  revokeGroupAdmin: (groupId: string, userId: string) =>
    request<void>(`/api/groups/${groupId}/admins/${userId}`, { method: "DELETE" }),
  audit: (params: { action?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.action) q.set("action", params.action);
    q.set("limit", String(params.limit ?? 200));
    return request<AuditPage>(`/api/audit?${q}`);
  },
  auditSummary: () =>
    request<{
      byAction: { action: string; count: number }[];
      byActor: { actorEmail: string; count: number }[];
      deniedCount: number;
    }>("/api/audit/summary"),
};
