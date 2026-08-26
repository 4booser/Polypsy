import type {
  Answer,
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
  AuditPage,
  CreateUserInput,
  RiskAlert,
  UpdateProfileInput,
  RespondentDynamics,
  SurveyVersion,
  BatteryAssignment,
} from "@quizzy/shared";
import { API_URL } from "../config";
import { tokenStorage } from "../storage";

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
  }) =>
    request<AuthPayload>("/api/auth/register", { method: "POST", body: JSON.stringify(input) }),
  login: (input: { email: string; password: string }) =>
    request<AuthPayload>("/api/auth/login", { method: "POST", body: JSON.stringify(input) }),
  me: () => request<User>("/api/auth/me"),
  updateProfile: (input: UpdateProfileInput) =>
    request<User>("/api/auth/me", { method: "PATCH", body: JSON.stringify(input) }),

  listGroups: () => request<SurveyGroupWithCounts[]>("/api/groups"),
  groupAdmins: (groupId: string) => request<GroupAdmin[]>(`/api/groups/${groupId}/admins`),
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

  myBatteries: () => request<BatteryAssignment[]>("/api/batteries/mine"),

  listSurveys: (groupId?: string) =>
    request<SurveyListItem[]>(`/api/surveys${groupId ? `?groupId=${groupId}` : ""}`),
  getSurvey: (id: string) => request<SurveyFull>(`/api/surveys/${id}`),
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
    },
  ) =>
    request<{ id: string; scores: ScoreResult[] }>(`/api/surveys/${surveyId}/responses`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  surveyVersions: (surveyId: string) => request<SurveyVersion[]>(`/api/surveys/${surveyId}/versions`),

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

  alerts: (all = false) => request<RiskAlert[]>(`/api/alerts${all ? "?all=1" : ""}`),
  acknowledgeAlert: (id: string, note?: string) =>
    request<unknown>(`/api/alerts/${id}/acknowledge`, {
      method: "PATCH",
      body: JSON.stringify({ note }),
    }),

  respondents: () =>
    request<{ userId: string; fullName: string; email: string; count: number; last: string | null }[]>(
      "/api/dynamics/respondents",
    ),
  respondentDynamics: (userId: string) =>
    request<RespondentDynamics>(`/api/dynamics/respondents/${userId}`),

  reportUrl: (responseId: string) => `${API_URL}/api/reports/responses/${responseId}`,

  myResponses: () => request<SurveyResponse[]>("/api/me/responses"),
  surveyResponses: (surveyId: string) => request<SurveyResponse[]>(`/api/surveys/${surveyId}/responses`),
  responseDetail: (id: string) => request<ResponseDetail>(`/api/responses/${id}`),

  listUsers: () => request<User[]>("/api/users"),
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
