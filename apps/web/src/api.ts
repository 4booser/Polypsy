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
  if (!res.ok) throw new ApiError(body?.error ?? `Ошибка ${res.status}`, res.status);
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

export interface Patient {
  id: string;
  fullName: string;
  email: string;
  /** Подразделение: по нему строится охват расписания */
  unit: string | null;
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
  surveys: () => request<SurveyListItem[]>("/api/surveys"),
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
  duplicateSurvey: (id: string) =>
    request<SurveyFull>(`/api/surveys/${id}/duplicate`, { method: "POST" }),
  deleteSurvey: (id: string) => request<void>(`/api/surveys/${id}`, { method: "DELETE" }),
  submitFor: (surveyId: string, payload: unknown) =>
    request<{ id: string; scores: unknown[]; reliable: boolean; warnings: string[] }>(
      `/api/surveys/${surveyId}/responses`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  versions: (id: string) => request<SurveyVersion[]>(`/api/surveys/${id}/versions`),

  overview: () => request<OverviewAnalytics>("/api/analytics/overview"),
  analytics: (id: string, versionId?: string) =>
    request<SurveyAnalytics>(
      `/api/analytics/surveys/${id}${versionId ? `?versionId=${versionId}` : ""}`,
    ),
  responses: (id: string) => request<SurveyResponse[]>(`/api/surveys/${id}/responses`),
  exportUrl: (id: string) => `/api/analytics/surveys/${id}/export`,
  spssDataUrl: (id: string) => `/api/spss/surveys/${id}/data.csv`,
  spssSyntaxUrl: (id: string) => `/api/spss/surveys/${id}/syntax.sps`,
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

  schedules: () => request<Schedule[]>("/api/schedules"),
  scheduleUnits: () => request<string[]>("/api/schedules/units"),
  createSchedule: (input: ScheduleInput) =>
    request<{ id: string }>("/api/schedules", { method: "POST", body: JSON.stringify(input) }),
  updateSchedule: (id: string, input: ScheduleInput) =>
    request<{ ok: true }>(`/api/schedules/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteSchedule: (id: string) => request<void>(`/api/schedules/${id}`, { method: "DELETE" }),
  runSchedule: (id: string) =>
    request<Schedule>(`/api/schedules/${id}/run`, { method: "POST" }),

  compare: (surveyId: string, by: string) =>
    request<ComparisonResult>(`/api/compare/surveys/${surveyId}?by=${by}`),
  correlations: (surveyId: string) =>
    request<CorrelationMatrix>(`/api/compare/surveys/${surveyId}/correlations`),

  respondents: () =>
    request<{ userId: string; fullName: string; email: string; count: number; last: string | null }[]>(
      "/api/dynamics/respondents",
    ),
  dynamics: (userId: string) => request<RespondentDynamics>(`/api/dynamics/respondents/${userId}`),

  alerts: (all = false) => request<RiskAlert[]>(`/api/alerts${all ? "?all=1" : ""}`),
  acknowledgeAlert: (id: string, note?: string) =>
    request<unknown>(`/api/alerts/${id}/acknowledge`, {
      method: "PATCH",
      body: JSON.stringify({ note }),
    }),

  grants: (surveyId: string) => request<SurveyGrant[]>(`/api/access/surveys/${surveyId}/grants`),
  grant: (surveyId: string, userId: string, note?: string, expiresAt?: string | null) =>
    request<unknown>(`/api/access/surveys/${surveyId}/grants`, {
      method: "POST",
      body: JSON.stringify({ userId, note, expiresAt }),
    }),
  revoke: (surveyId: string, userId: string) =>
    request<void>(`/api/access/surveys/${surveyId}/grants/${userId}`, { method: "DELETE" }),
  patients: () => request<Patient[]>("/api/access/patients"),

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
