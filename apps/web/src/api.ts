import type {
  AppointmentView,
  ScheduleExceptionView,
  ScheduleTemplateView,
  LocalizedText,
  OpsDb,
  OpsErrors,
  OpsErrorWindow,
  OpsJobs,
  OpsLogs,
  OpsLogWindow,
  OpsOverview,
  OpsReleaseCompare,
  OpsReleases,
  OpsRoutes,
  OpsSlow,
  OpsStatementPlan,
  OpsStatementSort,
  OpsStatements,
  OpsTrace,
  OpsTraffic,
  OpsWindow,
  PermissionEffectKind,
  SafetyPlan,
  SafetyPlanContent,
  AuditPage,
  AuditChainReport,
  OpsSessionPage,
  OpsUserPage,
  OpsAuditChainReport,
  OpsIntegrityState,
  OpsKeysReport,
  OpsPhoneReindexReport,
  OpsReencryptJob,
  OpsRlsReport,
  OpsSqlInfo,
  OpsSqlResult,
  AuthPayload,
  BulkResult,
  BulkUsersInput,
  ImpersonationStart,
  ImportCreated,
  ImportPreview,
  LoginResult,
  MfaChallenge,
  MfaPolicyView,
  MfaSetup,
  MfaStatus,
  PatientPick,
  SuspiciousPage,
  TemporaryGrants,
  WhoViewedReport,
  OverviewAnalytics,
  RespondentDynamics,
  RiskAlert,
  SeverityTrendResult,
  ConditionsResult,
  SurveyAnalytics,
  SurveyFull,
  SurveyGrant,
  SurveyGroupWithCounts,
  SurveyFolder,
  SurveyFolderWithCounts,
  PatientCard,
  PatientGroup,
  PatientGroupCard,
  PatientGroupInput,
  PatientGroupWithCounts,
  AssignSurveyToPatientGroupInput,
  SurveyListItem,
  SurveyListPage,
  SurveyResponse,
  SurveyStatus,
  SurveyVersion,
  User,
  StaffDirectoryUser,
  AssignableStaff,
  Issue,
  CreateUserInput,
  UpdateProfileInput,
  GroupInput,
  SurveyGroup,
  Battery,
  BatteryAssignment,
  BatteryInput,
  Invite,
  CreateInviteInput,
  Referral,
  CreateReferralInput,
  CaseSummary,
  VersionDiff,
  AlertCase,
  AlertSignalBasis,
  GroupAnalytics,
  ResponseDetail,
  Page,
  Respondent,
  Worklist,
  RuleHit,
  DecisionRule,
  RuleAction,
  RuleCondition,
  WorkspacePrefs,
  CohortSpec,
  CohortPreview,
  CohortRow,
  CohortMembers,
  CohortOptions,
  Mailing,
  MailingCard,
  MailingListPage,
  MailingInput,
  MailingUpdateInput,
  FilterPreset,
  FilterPresetInput,
  FilterPresetListItem,
  FilterPresetUpdateInput,
  StatModel,
  StatModelColumnInput,
  StatModelInput,
  StatModelListPage,
  StatModelUpdateInput,
  StatRunResult,
  DataQualityReport,
  UsageReport,
  MobileReport,
  PushReport,
  ScreenViewsInput,
  PublicServiceStatus,
  OpsServiceStatus,
  OpsFlagsView,
  FlagChange,
  FlagAudienceOptions,
  FeatureFlagKey,
  FeatureFlagUpdate,
  ReleasesView,
  ServiceStatusInput,
} from "@quizzy/shared";
import { MAINTENANCE_CODE, uiText } from "@quizzy/shared";
import type {
  OpsAlertChannel,
  OpsAlertDelivery,
  OpsAlertHistory,
  OpsAlertRule,
  OpsAlertRuleInput,
  OpsAlertRuleKey,
  OpsAlerts,
  OpsClientErrors,
  OpsRecordings,
  OpsVitals,
} from "@quizzy/shared";
import { currentLang } from "./lang";
import { noteNetworkFailure } from "./telemetry/bus";

/*
 * Текст сетевого отказа.
 *
 * Клиент живёт вне React, хука здесь нет — язык берётся из того же значения,
 * которое уходит в Accept-Language. Строки были написаны прямо здесь
 * по-русски и показывались на украинском экране при каждом обрыве связи.
 */
function netText(key: "net.offline" | "net.failed" | "net.request"): string {
  // через uiText, а не UI[key][lang]: у записи без английского поля en нет, и прямое чтение отдало бы undefined
  return uiText(key, currentLang);
}

const TOKEN_KEY = "quizzy.web.token";
const REFRESH_KEY = "quizzy.web.refresh";
const IMPERSONATION_KEY = "quizzy.web.impersonation";

/**
 * Вход «от имени» (техпанель, people2) — токен в хранилище ВКЛАДКИ.
 *
 * sessionStorage, а не localStorage: суперадмин смотрит чужими глазами в
 * одной вкладке, а в соседних остаётся собой. В общем хранилище токен «от
 * имени» подхватили бы все открытые вкладки, и в той, где суперадмин
 * работает своими правами, запросы вдруг пошли бы под чужим именем — и
 * отказывали бы в записи без видимой причины. Своя пара токенов при этом не
 * трогается: «вийти» возвращает к ней без нового входа.
 */
export interface ImpersonationSlot {
  token: string;
  sessionId: string;
  expiresAt: string;
}

export const impersonationStore = {
  get(): ImpersonationSlot | null {
    try {
      const raw = sessionStorage.getItem(IMPERSONATION_KEY);
      if (!raw) return null;
      const slot = JSON.parse(raw) as ImpersonationSlot;
      return activeSlot(slot, Date.now()) ? slot : null;
    } catch {
      return null;
    }
  },
  set(slot: ImpersonationSlot): void {
    sessionStorage.setItem(IMPERSONATION_KEY, JSON.stringify(slot));
  },
  clear(): void {
    sessionStorage.removeItem(IMPERSONATION_KEY);
  },
};

/** Жив ли токен «от имени» — по сроку; погашенный сервером узнаётся по 401 */
export function activeSlot(slot: ImpersonationSlot | null, now: number): boolean {
  return Boolean(slot?.token) && new Date(slot!.expiresAt).getTime() > now;
}

export const tokenStore = {
  /* под входом «от имени» запросы идут его токеном; свой — только для «вийти» */
  get: () => impersonationStore.get()?.token ?? localStorage.getItem(TOKEN_KEY),
  own: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  getRefresh: () => localStorage.getItem(REFRESH_KEY),
  setRefresh: (t: string) => localStorage.setItem(REFRESH_KEY, t),
  clear: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    impersonationStore.clear();
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

/**
 * Событие окна «сервер закрыл запись на обслуживание».
 *
 * Отказ 503 с кодом `maintenance` может прийти на любом экране, а баннер
 * живёт в оболочке и опрашивает состояние раз в пару минут. Событие будит
 * его сразу: человек, нажавший «Зберегти» во время работ, видит баннер
 * вместе с отказом, а не через две минуты. Событием, а не вызовом модуля
 * баннера: тот сам ходит сюда за состоянием, и прямой вызов замкнул бы
 * импорты в круг.
 */
export const MAINTENANCE_EVENT = "quizzy:maintenance";

async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const token = tokenStore.get();

  /*
   * Отсутствие связи — не то же самое, что ошибка сервера, и говорить о нём
   * надо иначе: «нет связи, повторим» вместо технического отказа. Раньше
   * fetch бросал TypeError наружу, и экран показывал «Failed to fetch».
   *
   * status 0 — та же условность, что в мобильном клиенте: единый признак
   * «до сервера не дошли».
   */
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        /*
         * Язык консоли сообщается серверу.
         *
         * По нему сервер выбирает язык названий методик, инструкций и текстов
         * отказов. Без заголовка он отвечает по-украински — и переключатель в
         * консоли менял только оболочку: специалист переключался на русский,
         * а названия методик и сообщения об ошибках оставались украинскими.
         * Мобильный клиент заголовок слал давно, веб — нет, хотя комментарий
         * в lang.tsx уверял, что слал.
         */
        "Accept-Language": currentLang,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers as Record<string, string>),
      },
    });
  } catch {
    /* сбой сети — в «Помилки клієнта» техпанели (telemetry/): шаблоном адреса, без тела */
    noteNetworkFailure({ method: init.method ?? "GET", path, status: 0 });
    throw new ApiError(netText("net.offline"), 0);
  }
  /* пятисотка — тоже сбой, а не бизнес-отказ; 4xx туда не идут — это поведение, не поломка */
  if (res.status >= 500) noteNetworkFailure({ method: init.method ?? "GET", path, status: res.status });
  /*
   * Вход «от имени» кончился (полчаса прошли, суперадмин нажал «вийти» в
   * другой вкладке или вышел из своей сессии) — возвращаемся к себе, а не
   * меняем refresh: у токена «от имени» его нет, а свой обмен ничего бы не
   * поправил — запросы шли бы тем же погашенным токеном.
   */
  if (res.status === 401 && impersonationStore.get()) {
    impersonationStore.clear();
    window.location.assign("/ops/users");
  } else if (res.status === 401 && !retried && !path.startsWith("/api/auth/")) {
    if (await tryRefresh()) return request<T>(path, init, true);
    tokenStore.clear();
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null);
  if (res.status === 503 && body?.code === MAINTENANCE_CODE && typeof window !== "undefined") {
    window.dispatchEvent(new Event(MAINTENANCE_EVENT));
  }
  if (!res.ok) {
    /*
     * Номер запроса приходит и в заголовке, и в теле. Он приклеивается к
     * сообщению, потому что пользователь пересказывает ошибку словами, а
     * номер позволяет найти запись в логе одним поиском — вместо «вчера
     * вечером что-то не сохранилось».
     */
    const requestId = res.headers.get("x-request-id") ?? body?.requestId ?? null;
    const text = body?.error ?? `${netText("net.failed")} ${res.status}`;
    throw new ApiError(
      requestId ? `${text} · ${netText("net.request")} ${requestId.slice(0, 8)}` : text,
      res.status,
      body,
    );
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
    throw new ApiError(body?.error ?? `${netText("net.failed")} ${res.status}`, res.status);
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
    throw new ApiError(body?.error ?? `${netText("net.failed")} ${res.status}`, res.status);
  }
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  // вкладка успевает забрать содержимое; ссылку освобождаем, чтобы не течь
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export interface ConclusionVersion {
  id: string;
  version: number;
  /**
   * Название документа с экрана «Заключення» (кадр f38, поле «Назва
   * заключення»). Столбца title в таблице conclusions пока нет, поэтому поле
   * необязательное: пока сервер его не отдаёт, экран держит набранное
   * название у себя и не затирает его пустотой из ответа.
   */
  title?: string | null;
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

/** Срез аналитики методики и списка её прохождений: период, человек, группа людей */
export interface AnalyticsSlice {
  from?: string;
  to?: string;
  userId?: string;
  patientGroup?: string;
}

function sliceParams(slice?: AnalyticsSlice): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of ["from", "to", "userId", "patientGroup"] as const) {
    const v = slice?.[key];
    if (v) params.set(key, v);
  }
  return params;
}

export interface VersionDiffResult extends VersionDiff {
  before: { versionId: string | null; versionNumber: number };
  after: { versionId: string | null; versionNumber: number };
}

/**
 * Печатный лист ключей. Описание жило на странице печати, а клиент объявлял
 * ответ как never — страница это скрывала, приводя данные к своему типу у себя
 * в состоянии, и рассинхронизация с сервером не обнаружилась бы ничем.
 */
export interface KeySheet {
  surveyId: string;
  title: string;
  version: number;
  questionCount: number;
  questions: { n: number; title: string }[];
  scales: {
    code: string;
    title: string;
    kind: string;
    normalization: string;
    itemCount: number;
    yes: string;
    no: string;
    scored: string;
    corrections: string;
    norms: string;
    stens: string;
    bands: string;
  }[];
}

/** Описание API: форма ответа /api/openapi.json — та часть, которую читает консоль */
export interface OpenApiOperation {
  summary: string;
  description: string;
  tags: string[];
  security: unknown[];
  requestBody?: {
    content: { "application/json": { schema: Record<string, unknown> } };
  };
}
export type OpenApiSpec = {
  info: { title: string; version: string };
  paths: Record<string, Record<string, OpenApiOperation>>;
};

export interface NoteVersion {
  id: string;
  version: number;
  kind: "intake" | "session" | "observation" | "consult";
  text: string;
  status: "draft" | "signed";
  createdAt: string;
  authorName: string;
  signedAt: string | null;
}

export interface NoteState {
  current: NoteVersion | null;
  versions: NoteVersion[];
}

export interface SavedView {
  id: string;
  scope: string;
  name: string;
  /** Строка запроса без «?» — то, что восстанавливает срез экрана */
  params: string;
  shared: boolean;
  mine: boolean;
  ownerName: string;
  createdAt: string;
}

export interface TimelineItem {
  id: string;
  kind: "response" | "alert" | "referral" | "conclusion" | "assignment";
  at: string;
  title: string;
  detail?: string | null;
  severity?: "none" | "mild" | "moderate" | "severe" | null;
  href?: string | null;
}

/**
 * Списочный ответ API.
 *
 * Списки отдаются объектом, а не голым массивом: в массив нельзя добавить ни
 * «всего», ни курсор, ни признак усечения, не сломав всех, кто его читает.
 * Реестр направлений — как раз тот случай: двухсотое направление раньше
 * молча исчезало, и экран выглядел полным.
 *
 * Разворачивается здесь, чтобы страницы не знали про обёртку там, где им от
 * неё ничего не нужно.
 */
export interface Items<T> {
  items: T[];
}

/*
 * ── Каталог тестов: страницы и папки ──
 *
 * Договор — apps/api/src/routes/surveys.ts (GET /api/surveys с
 * ?limit&offset&folder&status&q, PUT /api/surveys/:id/folder) и
 * apps/api/src/routes/surveyFolders.ts (/api/survey-folders); типы ответа
 * (SurveyFolder, SurveyFolderWithCounts, SurveyListPage) — из @quizzy/shared,
 * как и у остальных маршрутов.
 */
export interface SurveyPageQuery {
  /** Без limit — весь список: так его зовут выборы методики на других экранах */
  limit?: number;
  offset?: number;
  /** Идентификатор папки или `root` — методики вне папок; без него — все */
  folder?: string;
  status?: SurveyStatus;
  /** Подстрока названия на любом из языков */
  q?: string;
  /** Показать и снятые с использования (сервер добавляет их к остальным) */
  archived?: boolean;
}

/**
 * Тело правила поддержки решений — «аналитической модели» раздела
 * /analytics. Поля те же, что у ruleSchema в apps/api/src/routes/decisions.ts.
 * groupId здесь нет намеренно: экран моделей область правила не показывает,
 * а PATCH без поля оставляет её как была.
 */
export interface DecisionRuleInput {
  title: string;
  note: string | null;
  enabled: boolean;
  conditions: RuleCondition[];
  actions: RuleAction[];
}

const unwrap = <T>(p: Promise<Items<T>>): Promise<T[]> => p.then((r) => r.items);

export const api = {
  /** Вход: пара токенов или, если включён второй фактор, просьба о коде (MfaChallenge) */
  login: (email: string, password: string) =>
    request<LoginResult>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  /* ── второй фактор (people2) ── */
  loginMfa: (mfaToken: string, code: string) =>
    request<AuthPayload>("/api/auth/mfa/login", { method: "POST", body: JSON.stringify({ mfaToken, code }) }),
  mfaStatus: () => request<MfaStatus>("/api/auth/mfa"),
  mfaSetup: () => request<MfaSetup>("/api/auth/mfa/setup", { method: "POST" }),
  /** Коды восстановления — в ответе один раз */
  mfaConfirm: (code: string) =>
    request<{ recoveryCodes: string[] }>("/api/auth/mfa/confirm", { method: "POST", body: JSON.stringify({ code }) }),
  mfaDisable: (password: string, code: string) =>
    request<{ ok: true }>("/api/auth/mfa/disable", { method: "POST", body: JSON.stringify({ password, code }) }),
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
  register: (body: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone: string;
  }) =>
    request<{ token: string; refreshToken: string; user: User }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ ...body, anonymous: false }),
    }),
  /*
   * Всё, что принимает PATCH /api/auth/me (updateProfileSchema), а не только
   * ФИО: карточка сотрудника правит пол, дату рождения, специальность и
   * подразделение — сервер их давно принимает, узким был только этот тип.
   */
  updateMe: (body: UpdateProfileInput) =>
    request<{ user: User }>("/api/auth/me", { method: "PATCH", body: JSON.stringify(body) }),
  googleUnlink: (password: string) =>
    request<{ ok: true }>("/api/auth/google/unlink", {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  googleLinkUrl: () => request<{ url: string }>("/api/auth/google/link", { method: "POST" }),
  /* при включённом втором факторе вместо пары приходит просьба о коде */
  googleExchange: (code: string) =>
    request<{ token: string; refreshToken: string } | MfaChallenge>("/api/auth/google/exchange", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  googleStatus: () => request<{ enabled: boolean }>("/api/auth/google/status"),

  groups: () => unwrap(request<Items<SurveyGroupWithCounts>>("/api/groups")),
  groupAnalytics: (id: string) => request<GroupAnalytics>(`/api/analytics/groups/${id}`),
  surveys: (archived = false) =>
    unwrap(request<Items<SurveyListItem>>(`/api/surveys${archived ? "?archived=1" : ""}`)),
  /**
   * Страница каталога — для экрана каталога; остальные зовут surveys()
   * выше и про страницы не знают. Пустые параметры в адрес не попадают:
   * сервер читает «?q=» как «искать пустую строку», а не как «без поиска».
   */
  surveyPage: (query: SurveyPageQuery) => {
    const qs = new URLSearchParams();
    if (query.limit !== undefined) qs.set("limit", String(query.limit));
    if (query.offset) qs.set("offset", String(query.offset));
    if (query.folder) qs.set("folder", query.folder);
    if (query.status) qs.set("status", query.status);
    if (query.q) qs.set("q", query.q);
    if (query.archived) qs.set("archived", "1");
    const tail = qs.toString();
    return request<SurveyListPage>(`/api/surveys${tail ? `?${tail}` : ""}`);
  },
  /** Все видимые папки плоским списком: дерево и крошки клиент собирает сам */
  surveyFolders: () => unwrap(request<Items<SurveyFolderWithCounts>>("/api/survey-folders")),
  createSurveyFolder: (input: { groupId: string; title: string; startsOn?: string; parentId?: string | null }) =>
    request<SurveyFolder>("/api/survey-folders", { method: "POST", body: JSON.stringify(input) }),
  updateSurveyFolder: (
    id: string,
    patch: { title?: string; startsOn?: string; parentId?: string | null; position?: number },
  ) => request<SurveyFolder>(`/api/survey-folders/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSurveyFolder: (id: string) => request<void>(`/api/survey-folders/${id}`, { method: "DELETE" }),
  /** Перенос методики в папку; null — в корень каталога её группы */
  moveSurvey: (id: string, folderId: string | null) =>
    request<{ id: string; folderId: string | null }>(`/api/surveys/${id}/folder`, {
      method: "PUT",
      body: JSON.stringify({ folderId }),
    }),
  /**
   * Методика; с `version` — содержимое той версии, которую человек проходил
   * (графики прохождения считают вклад пунктов по её ключу, а не по
   * действующему). Без номера — действующая, как и раньше.
   */
  survey: (id: string, version?: number) =>
    request<SurveyFull>(`/api/surveys/${id}${version ? `?version=${version}` : ""}`),
  /** Методика в редактируемом виде: локализованные объекты вместо строк */
  keySheet: (id: string) => request<KeySheet>(`/api/surveys/${id}/key?lang=ru`),
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
  versions: (id: string) => unwrap(request<Items<SurveyVersion>>(`/api/surveys/${id}/versions`)),
  versionDiff: (id: string, a: string, b: string) =>
    request<VersionDiffResult>(`/api/surveys/${id}/versions/${a}/diff/${b}`),

  overview: () => request<OverviewAnalytics>("/api/analytics/overview"),
  severityTrend: () => request<SeverityTrendResult>("/api/analytics/severity-trend"),
  /** Состояние пациентов по направлениям за период — стартовый экран «Зведення» */
  dashboardConditions: (days: number) => request<ConditionsResult>(`/api/dashboard/conditions?days=${days}`),
  /**
   * Аналитика методики. Срез (`slice`) — тот же, что у списка прохождений
   * ниже: вкладка «Тести» ставит их рядом под одной строкой фильтров, и
   * разойтись им нельзя. Пустые значения в адрес не попадают — сервер
   * читает «?userId=» как «человек с пустым идентификатором».
   */
  analytics: (id: string, versionId?: string, slice?: AnalyticsSlice) => {
    const params = sliceParams(slice);
    if (versionId) params.set("versionId", versionId);
    const qs = params.toString();
    return request<SurveyAnalytics>(`/api/analytics/surveys/${id}${qs ? `?${qs}` : ""}`);
  },
  responses: (id: string, before?: string | null, slice?: AnalyticsSlice & { versionId?: string }) => {
    const params = sliceParams(slice);
    params.set("limit", "50");
    if (slice?.versionId) params.set("versionId", slice.versionId);
    if (before) params.set("before", before);
    return request<{ rows: SurveyResponse[]; hasMore: boolean; nextBefore: string | null }>(
      `/api/surveys/${id}/responses?${params.toString()}`,
    );
  },
  exportUrl: (id: string) => `/api/analytics/surveys/${id}/export`,
  spssDataUrl: (id: string, profile = "full") => `/api/spss/surveys/${id}/data.csv?profile=${profile}`,
  spssSyntaxUrl: (id: string, profile = "full") => `/api/spss/surveys/${id}/syntax.sps?profile=${profile}`,
  codebookUrl: (id: string, profile = "full") => `/api/spss/surveys/${id}/codebook.csv?profile=${profile}`,
  longUrl: (id: string, profile = "full") => `/api/spss/surveys/${id}/long.csv?profile=${profile}`,
  manifestUrl: (id: string, profile = "full", purpose = "") =>
    `/api/spss/surveys/${id}/manifest.json?profile=${profile}${purpose ? `&purpose=${encodeURIComponent(purpose)}` : ""}`,
  loadScriptUrl: (id: string, ext: "r" | "py", profile = "full") =>
    `/api/spss/surveys/${id}/load/${ext}?profile=${profile}`,
  methodologyUrl: (id: string) => `/api/surveys/${id}/export`,
  reportUrl: (responseId: string) => `/api/reports/responses/${responseId}`,

  batteries: () => unwrap(request<Items<Battery>>("/api/batteries")),
  createBattery: (input: BatteryInput) =>
    request<{ id: string }>("/api/batteries", { method: "POST", body: JSON.stringify(input) }),
  updateBattery: (id: string, input: BatteryInput) =>
    request<{ ok: true }>(`/api/batteries/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteBattery: (id: string) => request<void>(`/api/batteries/${id}`, { method: "DELETE" }),
  batteryAssignments: (id: string) =>
    unwrap(request<Items<BatteryAssignment>>(`/api/batteries/${id}/assignments`)),
  assignBattery: (id: string, userId: string, dueAt: string | null, note: string | null) =>
    request<{ id: string }>(`/api/batteries/${id}/assign`, {
      method: "POST",
      body: JSON.stringify({ userId, dueAt, note }),
    }),
  cancelAssignment: (assignmentId: string) =>
    request<{ ok: true }>(`/api/batteries/assignments/${assignmentId}/cancel`, { method: "POST" }),

  invites: () => unwrap(request<Items<Invite>>("/api/invites")),
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
  alertCaseUnits: () => unwrap(request<Items<string>>("/api/alert-cases/units")),
  /** Основание тревог случая: пункт с отмеченным вариантом либо полоса шкалы */
  alertCaseSignals: (id: string) =>
    unwrap(request<Items<AlertSignalBasis>>(`/api/alert-cases/${id}/signals`)),
  /** Прохождение целиком: ответы по пунктам вместе с вариантами той же версии */
  responseDetail: (id: string) => request<ResponseDetail>(`/api/responses/${id}`),
  worklist: () => request<Worklist>("/api/worklist"),

  ruleHits: (status: RuleHit["status"] = "suggested") =>
    request<{ items: RuleHit[] }>(`/api/decisions/hits?status=${status}`).then((r) => r.items),
  /**
   * Правила поддержки решений — «аналитические модели» экрана заключения.
   * Сервер отдаёт строки таблицы целиком; здесь объявлено то, что читает
   * экран: пояснение (note) идёт описанием модели в списке.
   */
  decisionRules: () =>
    unwrap(request<Items<DecisionRule & { note: string | null }>>("/api/decisions/rules")),
  /** Завести модель; сервер отвечает идентификатором новой строки */
  createDecisionRule: (input: DecisionRuleInput) =>
    request<{ id: string }>("/api/decisions/rules", { method: "POST", body: JSON.stringify(input) }),
  /** Правка поднимает версию правила — срабатывания помнят, при какой версии сработали */
  updateDecisionRule: (id: string, input: Partial<DecisionRuleInput>) =>
    request<{ ok: true; version: number }>(`/api/decisions/rules/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  decideHit: (id: string, status: "accepted" | "declined", note?: string) =>
    request<{ ok: true }>(`/api/decisions/hits/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status, note: note ?? null }),
    }),
  conclusionBatch: (unit: string, from: string, to: string) => {
    const q = new URLSearchParams();
    if (unit) q.set("unit", unit);
    if (from) q.set("from", from);
    if (to) q.set("to", to);
    return request<{
      unit: string | null;
      from: string | null;
      to: string | null;
      items: {
        id: string;
        responseId: string;
        version: number;
        signedAt: string | null;
        text: string;
        authorName: string;
        patientName: string;
        unit: string | null;
        surveyTitle: string;
        submittedAt: string | null;
      }[];
    }>(`/api/conclusions/batch?${q}`);
  },

  missed: (since: string) =>
    request<{
      since: string;
      groups: {
        kind: "case.opened" | "case.resolved" | "referral.created" | "schedule.run";
        count: number;
        items: {
          id: string;
          at: string;
          title: string;
          detail: string;
          severity: "moderate" | "severe" | null;
          href: string;
        }[];
      }[];
    }>(`/api/missed?since=${encodeURIComponent(since)}`),

  itemQuality: (surveyId: string) =>
    request<{
      questions: { number: number; title: string }[];
      medians: number[];
      rows: {
        responseId: string;
        submittedAt: string | null;
        durationMs: number;
        cells: { answered: boolean; rel: number | null; run: number }[];
      }[];
    }>(`/api/data-quality/surveys/${surveyId}/items`),

  searchNotes: (q: string) =>
    request<{
      words: string[];
      items: {
        id: string;
        userId: string;
        userName: string;
        kind: string;
        version: number;
        status: string;
        createdAt: string;
        excerpt: string;
      }[];
    }>(`/api/search/notes?q=${encodeURIComponent(q)}`),

  cohortPreview: (spec: CohortSpec) =>
    request<CohortPreview>("/api/cohorts/preview", { method: "POST", body: JSON.stringify(spec) }),
  /*
   * Ответ целиком, а не только items: «ниже порога» (suppressed) и «пусто» —
   * разные ответы, и экран обязан их различать. Прежде флаг отрезался здесь,
   * и малая когорта показывалась пустым списком, как будто никого нет.
   */
  cohortMembers: (spec: CohortSpec) =>
    request<CohortMembers>("/api/cohorts/members", { method: "POST", body: JSON.stringify(spec) }),
  /** Подразделения и населённые пункты зоны — из чего выбирать в подборе */
  cohortOptions: () => request<CohortOptions>("/api/cohorts/options"),
  cohorts: () => request<{ items: CohortRow[] }>("/api/cohorts").then((r) => r.items),
  saveCohort: (title: string, spec: CohortSpec) =>
    request<{ id: string }>("/api/cohorts", {
      method: "POST",
      body: JSON.stringify({ title, spec }),
    }),
  updateCohort: (id: string, patch: { title?: string; spec?: CohortSpec }) =>
    request<CohortRow>(`/api/cohorts/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteCohort: (id: string) => request<{ ok: true }>(`/api/cohorts/${id}`, { method: "DELETE" }),

  devices: (userId?: string) =>
    request<{
      items: {
        id: string;
        label: string | null;
        platform: string | null;
        ownerName: string;
        lastSeenAt: string;
        wipeRequestedAt: string | null;
        wipedAt: string | null;
      }[];
    }>(`/api/devices${userId ? `?userId=${userId}` : ""}`).then((r) => r.items),
  wipeDevice: (id: string) =>
    request<{ ok: true; note: string }>(`/api/devices/${id}/wipe`, { method: "POST" }),

  saveWorkspace: (prefs: WorkspacePrefs) =>
    request<WorkspacePrefs>("/api/auth/me/workspace", {
      method: "PUT",
      body: JSON.stringify(prefs),
    }),

  presenceHere: (resource: string) =>
    request<{ ok: true }>("/api/presence", { method: "POST", body: JSON.stringify({ resource }) }),
  presenceOthers: (resource: string) =>
    request<{ others: { id: string; name: string }[] }>(
      `/api/presence?resource=${encodeURIComponent(resource)}`,
    ),
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

  openapi: () => request<OpenApiSpec>("/api/openapi.json"),
  downloadOpenapi: () => download("/api/openapi.json", "openapi.json"),

  referrals: (all = false) =>
    request<Items<Referral> & { truncated: boolean }>(`/api/referrals${all ? "?all=1" : ""}`),
  createReferral: (input: CreateReferralInput) =>
    request<Referral>("/api/referrals", { method: "POST", body: JSON.stringify(input) }),
  updateReferral: (id: string, status: string, outcomeNote?: string) =>
    request<Referral>(`/api/referrals/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status, outcomeNote }),
    }),
  caseSummary: (userId: string) => request<CaseSummary>(`/api/referrals/summary/${userId}`),
  safetyPlans: (userId: string) =>
    request<{ versions: SafetyPlan[] }>(`/api/safety/patients/${userId}`),
  saveSafetyPlan: (userId: string, content: SafetyPlanContent) =>
    request<{ id: string; version: number }>(`/api/safety/patients/${userId}`, {
      method: "PUT",
      body: JSON.stringify(content),
    }),

  notes: (userId: string) => request<NoteState>(`/api/notes/patients/${userId}`),
  saveNote: (
    userId: string,
    text: string,
    baseVersion: number,
    kind?: string,
    appointmentId?: string,
  ) =>
    request<NoteState>(`/api/notes/patients/${userId}`, {
      method: "PUT",
      body: JSON.stringify({ text, baseVersion, kind, appointmentId }),
    }),
  signNote: (userId: string, version: number) =>
    request<NoteState>(`/api/notes/patients/${userId}/sign`, {
      method: "POST",
      body: JSON.stringify({ version }),
    }),

  /* ── права ── */
  permissionCatalogue: () =>
    request<{
      groups: {
        code: string;
        title: LocalizedText;
        permissions: {
          code: string;
          title: LocalizedText;
          /* что право открывает на деле: раздел меню, аналитика или действие */
          effect: { kind: PermissionEffectKind; opens: LocalizedText };
        }[];
      }[];
      exceptionable: string[];
    }>("/api/permissions/catalogue"),
  permissionRoles: () =>
    unwrap(
      request<Items<{
        id: string;
        code: string;
        title: LocalizedText;
        isBuiltin: boolean;
        permissions: string[];
        people: number;
        /** вправе ли я выдать эту роль — считает сервер по лестнице должностей */
        assignable: boolean;
      }>>("/api/permissions/roles"),
    ),
  createRole: (input: { code: string; title: LocalizedText; permissions: string[] }) =>
    request<{ id: string }>("/api/permissions/roles", { method: "POST", body: JSON.stringify(input) }),
  setRolePermissions: (id: string, permissions: string[]) =>
    request<{ ok: true }>(`/api/permissions/roles/${id}/permissions`, {
      method: "PUT",
      body: JSON.stringify({ permissions }),
    }),
  userPermissions: (id: string) =>
    request<{
      userId: string;
      fullName: string;
      role: string;
      readOnly: boolean;
      roles: { roleId: string; code: string; title: LocalizedText; isBuiltin: boolean }[];
      exceptions: {
        id: string;
        permission: string;
        mode: "grant" | "revoke";
        reason: string;
        grantedAt: string;
        expiresAt: string | null;
        revokedAt: string | null;
      }[];
      effective: string[];
    }>(`/api/permissions/users/${id}`),
  setUserRoles: (id: string, roleIds: string[]) =>
    request<{ ok: true }>(`/api/permissions/users/${id}/roles`, {
      method: "PUT",
      body: JSON.stringify({ roleIds }),
    }),
  addException: (
    id: string,
    input: { permission: string; mode: "grant" | "revoke"; reason: string; days?: number },
  ) =>
    request<{ id: string }>(`/api/permissions/users/${id}/exceptions`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeException: (id: string) =>
    request<{ ok: true }>(`/api/permissions/exceptions/${id}/revoke`, { method: "POST" }),
  /* люди, которых я вправе назначать: не список учёток, а моя часть лестницы */
  assignableStaff: () =>
    unwrap(
      request<Items<{ id: string; email: string; role: string; fullName: string }>>(
        "/api/permissions/staff",
      ),
    ),
  /* те же люди справочником раздела «Лікарі»: с профилем приёма и телефоном, чтение в журнале */
  assignableDirectory: () => unwrap(request<Items<AssignableStaff>>("/api/permissions/staff?directory=1")),
  activeExceptions: () =>
    unwrap(
      request<Items<{
        id: string;
        userId: string;
        userName: string;
        permission: string;
        mode: "grant" | "revoke";
        reason: string;
        grantedAt: string;
        expiresAt: string | null;
      }>>("/api/permissions/exceptions"),
    ),

  views: (scope: string) => unwrap(request<Items<SavedView>>(`/api/views?scope=${scope}`)),
  saveView: (input: { scope: string; name: string; params: string; shared?: boolean }) =>
    request<{ id: string }>("/api/views", { method: "POST", body: JSON.stringify(input) }),
  updateView: (id: string, patch: { name?: string; shared?: boolean; params?: string }) =>
    request<{ ok: true }>(`/api/views/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteView: (id: string) => request<void>(`/api/views/${id}`, { method: "DELETE" }),

  /** Хронология пациента: прохождения, тревоги, направления, заключения на одной оси */
  timeline: (userId: string) => unwrap(request<Items<TimelineItem>>(`/api/timeline/${userId}`)),

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

  /*
   * Техпанель, «Дані й продукт»: проверки целостности по всей базе,
   * использование, мобильное приложение, пуши. Рядом с качеством данных
   * методики: вопрос родственный, масштаб другой.
   */
  opsDataQuality: () => request<DataQualityReport>("/api/ops/data/quality"),
  opsUsage: (days: 7 | 30 | 90) => request<UsageReport>(`/api/ops/data/usage?days=${days}`),
  opsMobile: (days: 7 | 30 | 90) => request<MobileReport>(`/api/ops/data/mobile?days=${days}`),
  opsPush: (days: 7 | 30 | 90) => request<PushReport>(`/api/ops/data/push?days=${days}`),
  /**
   * Пачка счётчиков открытия экранов (telemetry/screens.ts).
   *
   * `keepalive` — чтобы последняя пачка ушла и при закрытии вкладки: без
   * него браузер обрывает запрос вместе со страницей.
   */
  sendScreenViews: (input: ScreenViewsInput, keepalive = false) =>
    request<{ ok: true }>("/api/usage/screens", { method: "POST", body: JSON.stringify(input), keepalive }),

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

  /**
   * Размеры таблиц. Был второй такой же обработчик в /api/audit/storage —
   * и в нём `relname` не был уточнён именем таблицы, из-за чего запрос падал
   * пятисоткой: у pg_class и pg_stat_user_tables колонка называется одинаково.
   * Дубль удалён, остался этот.
   */
  storageStats: () =>
    request<{
      database: { bytes: number; pretty: string };
      tables: { table: string; rows: number; totalBytes: number; totalPretty: string }[];
      auditGrowth: { month: string; entries: number }[];
    }>("/api/stats/storage"),

  /*
   * Техпанель: наблюдаемость (/api/ops, право ops.read). Всё — память
   * процесса API до его перезапуска; `since` в каждом ответе.
   */
  opsOverview: () => request<OpsOverview>("/api/ops/overview"),
  opsTraffic: (window: OpsWindow) => request<OpsTraffic>(`/api/ops/traffic?window=${window}`),
  opsRoutes: () => request<OpsRoutes>("/api/ops/routes"),
  opsSlow: () => request<OpsSlow>("/api/ops/slow"),
  /** Группы ошибок: без `window` — память процесса, с ним — история из базы за период */
  opsErrors: (window?: OpsErrorWindow) => request<OpsErrors>(`/api/ops/errors${window ? `?window=${window}` : ""}`),
  /**
   * Лента логов: без `after` — последние строки, с `after` — только новее
   * курсора. `window` — история из базы за период (первая страница),
   * `before` — её более старая страница.
   */
  opsLogs: (params: {
    level?: string;
    q?: string;
    requestId?: string;
    after?: number;
    limit?: number;
    window?: OpsLogWindow;
    before?: string;
  }) => {
    const q = new URLSearchParams();
    if (params.level) q.set("level", params.level);
    if (params.q) q.set("q", params.q);
    if (params.requestId) q.set("requestId", params.requestId);
    if (params.after !== undefined) q.set("after", String(params.after));
    if (params.limit !== undefined) q.set("limit", String(params.limit));
    if (params.window) q.set("window", params.window);
    if (params.before) q.set("before", params.before);
    return request<OpsLogs>(`/api/ops/logs?${q}`);
  },
  /* трасса запроса, сравнение выкаток, медленные SQL — история из базы (участок obs2a) */
  opsTrace: (requestId: string) => request<OpsTrace>(`/api/ops/trace/${encodeURIComponent(requestId)}`),
  /* версии в истории запросов — для выбора пары в «Порівнянні випусків» (не путать с историей выкаток opsReleases ниже) */
  opsReleaseVersions: () => request<OpsReleases>("/api/ops/releases"),
  opsReleaseCompare: (before?: string, after?: string) => {
    const q = new URLSearchParams();
    if (before) q.set("before", before);
    if (after) q.set("after", after);
    return request<OpsReleaseCompare>(`/api/ops/releases/compare?${q}`);
  },
  opsStatements: (sort: OpsStatementSort) => request<OpsStatements>(`/api/ops/statements?sort=${sort}`),
  opsStatementPlan: (id: string) => request<OpsStatementPlan>(`/api/ops/statements/${encodeURIComponent(id)}/plan`),
  opsDb: () => request<OpsDb>("/api/ops/db"),
  opsJobs: () => request<OpsJobs>("/api/ops/jobs"),
  /*
   * Техпанель, участок obs2b: оповещения, ошибки клиента, скорость экранов,
   * записи приёмов, ручной запуск задач. В отличие от методов выше — из
   * базы (миграция 0095), а не из памяти процесса.
   */
  opsAlerts: () => request<OpsAlerts>("/api/ops/alerts"),
  opsAlertHistory: () => request<OpsAlertHistory>("/api/ops/alerts/history"),
  opsSaveAlertRule: (key: OpsAlertRuleKey, input: OpsAlertRuleInput) =>
    request<OpsAlertRule>(`/api/ops/alerts/rules/${key}`, { method: "PUT", body: JSON.stringify(input) }),
  opsTestAlert: (channel: OpsAlertChannel) =>
    request<OpsAlertDelivery>("/api/ops/alerts/test", { method: "POST", body: JSON.stringify({ channel }) }),
  opsClientErrors: () => request<OpsClientErrors>("/api/ops/client-errors"),
  opsVitals: (days = 30) => request<OpsVitals>(`/api/ops/vitals?days=${days}`),
  opsRecordings: () => request<OpsRecordings>("/api/ops/recordings"),
  opsRetryRecording: (id: string) =>
    request<{ ok: true }>(`/api/ops/recordings/${encodeURIComponent(id)}/retry`, { method: "POST", body: "{}" }),
  opsRunJob: (name: string) =>
    request<{ started: true }>(`/api/ops/jobs/${encodeURIComponent(name)}/run`, { method: "POST", body: "{}" }),

  consentText: () =>
    request<{ version: number; body: Record<string, string>; createdAt: string } | null>("/api/consents/text"),
  saveConsentText: (body: Record<string, string>) =>
    request<{ version: number }>("/api/consents/text", { method: "PUT", body: JSON.stringify({ body }) }),

  conclusion: (responseId: string) =>
    request<ConclusionState>(`/api/conclusions/responses/${responseId}/conclusion`),
  conclusionDraft: (responseId: string) =>
    request<{
      patient: { fullName: string; age: number | null; unit: string | null } | null;
      surveyTitle: string;
      submittedAt: string | null;
      scales: {
        scaleId: string;
        title: string;
        value: number;
        normalization: "raw" | "ratio" | "tscore" | "sten";
        percent: number;
        band: string | null;
        severity: "none" | "mild" | "moderate" | "severe" | null;
        previousValue: number | null;
      }[];
      previousAt: string | null;
    }>(`/api/conclusions/responses/${responseId}/conclusion/draft`),
  /** baseVersion — версия, поверх которой правили: сервер не даст затереть чужую работу */
  saveConclusion: (responseId: string, text: string, baseVersion: number, title?: string) =>
    request<ConclusionState>(`/api/conclusions/responses/${responseId}/conclusion`, {
      method: "PUT",
      /*
       * Название уходит вместе с текстом по описанному договору (столбец
       * conclusions.title). Сегодняшний сервер лишнее поле отбрасывает при
       * разборе тела — запрос от этого не ломается, а в день, когда столбец
       * появится, клиент править не придётся.
       */
      body: JSON.stringify({ text, baseVersion, ...(title !== undefined ? { title } : {}) }),
    }),
  /** Подписывается конкретная версия — та, что была на экране */
  signConclusion: (responseId: string, version: number) =>
    request<ConclusionState>(`/api/conclusions/responses/${responseId}/conclusion/sign`, {
      method: "POST",
      body: JSON.stringify({ version }),
    }),

  respondents: (params: { search?: string; cursor?: string; limit?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<Page<Respondent>>(`/api/dynamics/respondents?${qs}`);
  },
  /** Динамика человека; с `surveyId` — только по одной методике (сервер не считает альфу по остальным) */
  dynamics: (userId: string, surveyId?: string) =>
    request<RespondentDynamics>(
      `/api/dynamics/respondents/${userId}${surveyId ? `?survey=${encodeURIComponent(surveyId)}` : ""}`,
    ),

  alerts: (all = false) => unwrap(request<Items<RiskAlert>>(`/api/alerts${all ? "?all=1" : ""}`)),

  grants: (surveyId: string) => unwrap(request<Items<SurveyGrant>>(`/api/access/surveys/${surveyId}/grants`)),
  grant: (
    surveyId: string,
    userId: string,
    note?: string,
    expiresAt?: string | null,
    attemptsAllowed?: number,
  ) =>
    request<unknown>(`/api/access/surveys/${surveyId}/grants`, {
      method: "POST",
      body: JSON.stringify({ userId, note, expiresAt, attemptsAllowed }),
    }),
  revoke: (surveyId: string, userId: string) =>
    request<void>(`/api/access/surveys/${surveyId}/grants/${userId}`, { method: "DELETE" }),
  /*
   * Группы ПАЦИЕНТОВ — рабочие списки специалиста, не группы методик
   * (`groups` выше). Назначение на группу сервер разворачивает в поимённые
   * назначения и отвечает числом адресатов.
   */
  patientGroups: () => unwrap(request<Items<PatientGroupWithCounts>>("/api/patient-groups")),
  /*
   * Карточка пациента (кадр f19) — персональные данные, «Тести», «Групи»,
   * «Заключення» и ведущий одним ответом. Не caseSummary: тот отвечает на
   * вопрос «что с человеком сейчас» (тревоги, направления) для прежней
   * карты /patients/:id/case, а этот — на вопрос кадра.
   */
  patientCard: (userId: string) => request<PatientCard>(`/api/patients/${userId}/card`),
  assignSurveyToPatientGroup: (groupId: string, body: AssignSurveyToPatientGroupInput) =>
    request<{ groupId: string; surveyId: string; recipients: number }>(`/api/patient-groups/${groupId}/surveys`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Карточка группы: описание, «Пацієнти Групи» и «Тести Групи» одним ответом */
  patientGroup: (id: string) => request<PatientGroupCard>(`/api/patient-groups/${id}`),
  createPatientGroup: (input: PatientGroupInput) =>
    request<PatientGroup>("/api/patient-groups", { method: "POST", body: JSON.stringify(input) }),
  updatePatientGroup: (id: string, patch: Partial<PatientGroupInput>) =>
    request<PatientGroup>(`/api/patient-groups/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  /* повторное добавление сервер читает как «уже там», а не как ошибку */
  addPatientGroupMember: (groupId: string, userId: string) =>
    request<{ groupId: string; userId: string }>(`/api/patient-groups/${groupId}/members`, {
      method: "POST",
      body: JSON.stringify({ userId }),
    }),
  /** Выданные человеку назначения при этом остаются — см. routes/patientGroups.ts */
  removePatientGroupMember: (groupId: string, userId: string) =>
    request<void>(`/api/patient-groups/${groupId}/members/${userId}`, { method: "DELETE" }),
  /**
   * Пациенты. Отдаётся не всё: список упорядочен по ФИО, а оно зашифровано —
   * упорядочить его в SQL нечем, поэтому сервер ищет и обрезает выдачу.
   * `patientGroup` сужает выдачу до состава группы пациентов.
   */
  patients: (params: { search?: string; unit?: string; patientGroup?: string } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<{ items: Patient[]; total: number; truncated: boolean }>(
      `/api/access/patients?${qs}`,
    );
  },

  users: () => unwrap(request<Items<User>>("/api/users")),
  /* справочник сотрудников: без пациентов, с профилем приёма и телефоном; чтение в журнале */
  staffDirectory: () => unwrap(request<Items<StaffDirectoryUser>>("/api/users?directory=1")),
  createUser: (input: CreateUserInput) =>
    request<User>("/api/users", { method: "POST", body: JSON.stringify(input) }),
  /* ── техпанель: учётные записи и сессии (волна 10) ── */
  setUserRole: (id: string, role: User["role"]) =>
    request<User>(`/api/users/${id}/role`, { method: "PATCH", body: JSON.stringify({ role }) }),
  opsUsers: (params: Record<string, string | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<OpsUserPage>(`/api/ops/users?${qs}`);
  },
  disableUser: (id: string, reason: string) =>
    request<{ ok: true; disabledAt: string }>(`/api/ops/users/${id}/disable`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  enableUser: (id: string) => request<{ ok: true }>(`/api/ops/users/${id}/enable`, { method: "POST" }),
  revokeUserSessions: (id: string) =>
    request<{ ok: true; revokedTokens: number }>(`/api/ops/users/${id}/revoke-sessions`, { method: "POST" }),
  /** Временный пароль приходит в ответе один раз — экран показывает его и забывает */
  resetUserPassword: (id: string) =>
    request<{ password: string; revokedTokens: number }>(`/api/ops/users/${id}/reset-password`, { method: "POST" }),
  /** 409 несёт в теле `holds` — что держит учётку; экран читает их из ApiError.body */
  deleteUser: (id: string) => request<{ ok: true }>(`/api/ops/users/${id}`, { method: "DELETE" }),
  opsSessions: (params: Record<string, string | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<OpsSessionPage>(`/api/ops/sessions?${qs}`);
  },
  revokeSession: (id: string) => request<{ ok: true }>(`/api/ops/sessions/${id}/revoke`, { method: "POST" }),
  /* ── техпанель: люди и безопасность (people2) ── */
  /** Токен «от имени» — в ответе один раз; экран кладёт его в хранилище вкладки */
  impersonate: (userId: string, reason: string) =>
    request<ImpersonationStart>(`/api/ops/people/impersonate/${userId}`, { method: "POST", body: JSON.stringify({ reason }) }),
  endImpersonation: (sessionId: string) =>
    request<{ ok: true; ended: boolean }>(`/api/ops/people/impersonate/${sessionId}/end`, { method: "POST" }),
  mfaPolicy: () => request<MfaPolicyView>("/api/ops/people/mfa"),
  saveMfaPolicy: (policy: { superadmins: boolean; ops: boolean }) =>
    request<{ ok: true }>("/api/ops/people/mfa", { method: "PUT", body: JSON.stringify(policy) }),
  resetUserMfa: (id: string) =>
    request<{ ok: true; hadFactor: boolean }>(`/api/ops/people/users/${id}/mfa-reset`, { method: "POST" }),
  suspicious: (params: Record<string, string | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<SuspiciousPage>(`/api/ops/people/suspicious?${qs}`);
  },
  resolveFinding: (id: string, comment: string) =>
    request<{ ok: true }>(`/api/ops/people/suspicious/${id}/resolve`, { method: "POST", body: JSON.stringify({ comment }) }),
  scanSuspicious: () =>
    request<{ found: number; created: number; updated: number }>("/api/ops/people/suspicious/scan", { method: "POST" }),
  temporaryGrants: () => request<TemporaryGrants>("/api/ops/people/grants"),
  extendGrant: (id: string, days: number) =>
    request<{ ok: true; expiresAt: string }>(`/api/ops/people/grants/${id}/extend`, { method: "POST", body: JSON.stringify({ days }) }),
  opsUserIds: (params: Record<string, string | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<{ ids: string[]; total: number }>(`/api/ops/people/users/ids?${qs}`);
  },
  bulkUsers: (body: BulkUsersInput) =>
    request<BulkResult>("/api/ops/people/users/bulk", { method: "POST", body: JSON.stringify(body) }),
  importPreview: (csv: string) =>
    request<ImportPreview>("/api/ops/people/users/import/preview", { method: "POST", body: JSON.stringify({ csv }) }),
  /** 400 несёт в теле `preview` — ошибки по строкам; пароли созданных — в ответе один раз */
  importUsers: (csv: string) =>
    request<ImportCreated>("/api/ops/people/users/import", { method: "POST", body: JSON.stringify({ csv }) }),
  patientPick: (q: string) =>
    request<{ items: PatientPick[] }>(`/api/ops/people/patients?${new URLSearchParams({ q })}`).then((r) => r.items),
  whoViewed: (patientId: string, from: string, to: string) =>
    request<WhoViewedReport>(`/api/ops/people/who-viewed?${new URLSearchParams({ patientId, from, to })}`),
  createGroup: (input: GroupInput) =>
    request<SurveyGroup>("/api/groups", { method: "POST", body: JSON.stringify(input) }),
  updateGroup: (id: string, input: Partial<GroupInput>) =>
    request<SurveyGroup>(`/api/groups/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  /** Снять группу с использования или вернуть в работу — одним маршрутом со знаком */
  archiveGroup: (id: string, archived: boolean) =>
    request<SurveyGroup>(`/api/groups/${id}/archive`, {
      method: "POST",
      body: JSON.stringify({ archived }),
    }),
  deleteGroup: (id: string) => request<void>(`/api/groups/${id}`, { method: "DELETE" }),
  assignGroupAdmin: (groupId: string, userId: string) =>
    request<unknown>(`/api/groups/${groupId}/admins`, { method: "POST", body: JSON.stringify({ userId }) }),
  revokeGroupAdmin: (groupId: string, userId: string) =>
    request<void>(`/api/groups/${groupId}/admins/${userId}`, { method: "DELETE" }),
  /** Журнал с отбором техпанели: кто, над кем, действие, тип ресурса, исход, период, текст; страницы курсором */
  auditPage: (params: Record<string, string | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return request<AuditPage>(`/api/audit?${qs}`);
  },
  /** 409 — цепочка порвана; отчёт тогда в ApiError.body */
  auditVerify: () => request<AuditChainReport>("/api/audit/verify"),
  /** Выгрузка текущего отбора: собирает сервер, с потолком строк и записью в журнал */
  auditExport: (params: Record<string, string | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return download(`/api/audit/export.csv?${qs}`, "audit.csv");
  },
  auditSummary: () =>
    request<{
      byAction: { action: string; count: number }[];
      byActor: { actorEmail: string; count: number }[];
      deniedCount: number;
    }>("/api/audit/summary"),

  /* ── техпанель, безопасность: только суперадмин, проверка на сервере ── */
  opsSecKeys: () => request<OpsKeysReport>("/api/ops/sec/keys"),
  opsSecJob: () => request<{ job: OpsReencryptJob | null }>("/api/ops/sec/keys/job"),
  opsSecReencrypt: () =>
    request<{ job: OpsReencryptJob; outcome: "started" }>("/api/ops/sec/keys/reencrypt", { method: "POST" }),
  opsSecReindexPhones: () =>
    request<OpsPhoneReindexReport>("/api/ops/sec/keys/reindex-phones", { method: "POST" }),
  opsSecIntegrity: () => request<OpsIntegrityState>("/api/ops/sec/integrity"),
  opsSecCheckRls: () => request<OpsRlsReport>("/api/ops/sec/integrity/rls", { method: "POST" }),
  opsSecCheckAudit: () => request<OpsAuditChainReport>("/api/ops/sec/integrity/audit", { method: "POST" }),
  opsSecSqlInfo: () => request<OpsSqlInfo>("/api/ops/sec/sql"),
  opsSecSql: (query: string, reason: string) =>
    request<OpsSqlResult>("/api/ops/sec/sql", { method: "POST", body: JSON.stringify({ query, reason }) }),

  /* ── командная консоль ── */
  consoleCommands: () =>
    request<{
      items: {
        name: string;
        usage: string;
        summary: string;
        permission: string | null;
        allowed: boolean;
      }[];
    }>("/api/console/commands"),
  consoleRun: (line: string) =>
    request<{ lines: string[]; ok: boolean }>("/api/console/run", {
      method: "POST",
      body: JSON.stringify({ line }),
    }),

  /* ── техпанель, эксплуатация: состояние системы, флаги функций, выкатки ── */
  /** Состояние системы: открыто без входа — баннер нужен и на экране входа */
  serviceStatus: () => request<PublicServiceStatus>("/api/status"),
  /** Флаги, включённые мне: только ключи (см. service/flags.ts) */
  myFlags: () => request<{ flags: FeatureFlagKey[] }>("/api/flags"),
  opsStatus: () => request<OpsServiceStatus>("/api/ops/maint/status"),
  opsAnnounce: (input: ServiceStatusInput) =>
    request<{ current: PublicServiceStatus }>("/api/ops/maint/status", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  opsFlags: () => request<OpsFlagsView>("/api/ops/maint/flags"),
  opsFlagChanges: () => request<{ items: FlagChange[] }>("/api/ops/maint/flags/changes?limit=50"),
  opsFlagAudience: () => request<FlagAudienceOptions>("/api/ops/maint/flags/audience"),
  opsSaveFlag: (key: string, input: FeatureFlagUpdate) =>
    request<Pick<FlagChange, "before" | "after">>(`/api/ops/maint/flags/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  opsReleases: () => request<ReleasesView>("/api/ops/maint/releases"),
  opsRollback: (version: string) =>
    request<{ ok: true; workflowUrl: string | null }>("/api/ops/maint/releases/rollback", {
      method: "POST",
      body: JSON.stringify({ version }),
    }),

  /* ── поликлиника ── */
  threads: () =>
    request<{
      items: {
        id: string;
        withName: string;
        patientId?: string;
        lastMessageAt: string;
        unread: number;
      }[];
      lead: string | null;
    }>("/api/messages"),
  thread: (id: string) =>
    request<{
      id: string;
      items: { id: string; mine: boolean; text: string; sentAt: string; readAt: string | null }[];
    }>(`/api/messages/${id}`),
  sendMessage: (input: { patientId?: string; text: string }) =>
    request<{ id: string; threadId: string }>("/api/messages", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /*
   * Рассылки «Повідомлення» (кадры f09/f16/f22) — не переписка выше: один
   * автор, много получателей, у получателя кнопки «Так / Ні». Страницы и
   * поиск — на сервере (limit/offset, q): тема и текст шифруются, и список
   * всё равно расшифровывается там; тянуть его целиком ради страницы 3
   * значило бы расшифровывать всё на каждую букву поиска.
   */
  mailings: (params: { q?: string; hidden?: boolean; limit: number; offset: number }) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    /* «скрытые» — отдельный список, а не вперемешку: так устроен сервер (?hidden=1) */
    if (params.hidden) qs.set("hidden", "1");
    qs.set("limit", String(params.limit));
    qs.set("offset", String(params.offset));
    return request<MailingListPage>(`/api/mailings?${qs}`);
  },
  mailing: (id: string) => request<MailingCard>(`/api/mailings/${id}`),
  /** «Створити» — черновик; отправка отдельным действием из меню-шестерни */
  createMailing: (input: MailingInput) =>
    request<Mailing>("/api/mailings", { method: "POST", body: JSON.stringify(input) }),
  /** «Зберегти»: только черновик, отправленная отвечает 409 */
  updateMailing: (id: string, patch: MailingUpdateInput) =>
    request<Mailing>(`/api/mailings/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  sendMailing: (id: string) =>
    request<{ id: string; status: "sent"; sentAt: string; recipients: number }>(`/api/mailings/${id}/send`, {
      method: "POST",
    }),
  /** «Видалити» — черновик; отправленную сервер не удаляет (409), её скрывают */
  deleteMailing: (id: string) => request<void>(`/api/mailings/${id}`, { method: "DELETE" }),
  hideMailing: (id: string) => request<Mailing>(`/api/mailings/${id}/hide`, { method: "POST" }),
  /*
   * Раздел «Статистика» (кадры f08, f09, f17, f18, f23, f24, f29): модели и
   * пресеты фильтров. Имён сервер здесь не отдаёт никогда — только доли с
   * прочерками там, где число вместе с соседними называло бы людей.
   *
   * Страницы перечня — на сервере (limit/offset, q), как у рассылок: без
   * ?limit= маршрут отдаёт весь список, и диаграмма f24 берёт его так.
   */
  statModels: (params: { q?: string; limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    if (params.offset !== undefined) qs.set("offset", String(params.offset));
    return request<StatModelListPage>(`/api/stat-models?${qs}`);
  },
  statModel: (id: string) => request<StatModel>(`/api/stat-models/${id}`),
  createStatModel: (input: StatModelInput) =>
    request<StatModel>("/api/stat-models", { method: "POST", body: JSON.stringify(input) }),
  updateStatModel: (id: string, patch: StatModelUpdateInput) =>
    request<StatModel>(`/api/stat-models/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteStatModel: (id: string) => request<void>(`/api/stat-models/${id}`, { method: "DELETE" }),
  /** «Порівняти» / «Оновити» по сохранённой модели — без правок на экране */
  runStatModel: (id: string) => request<StatRunResult>(`/api/stat-models/${id}/run`, { method: "POST" }),
  /**
   * Тот же расчёт по колонкам с экрана, без сохранения: выборку поправили,
   * а сохранять не просили. Каждый расчёт — строка журнала с фильтрами.
   */
  previewStatModel: (columns: StatModelColumnInput[], title?: string) =>
    request<StatRunResult>("/api/stat-models/run", {
      method: "POST",
      body: JSON.stringify({ columns, title: title ?? null }),
    }),
  filterPresets: (q?: string) =>
    unwrap(request<Items<FilterPresetListItem>>(`/api/filter-presets${q ? `?q=${encodeURIComponent(q)}` : ""}`)),
  filterPreset: (id: string) => request<FilterPresetListItem>(`/api/filter-presets/${id}`),
  createFilterPreset: (input: FilterPresetInput) =>
    request<FilterPreset>("/api/filter-presets", { method: "POST", body: JSON.stringify(input) }),
  updateFilterPreset: (id: string, patch: FilterPresetUpdateInput) =>
    request<FilterPreset>(`/api/filter-presets/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteFilterPreset: (id: string) => request<void>(`/api/filter-presets/${id}`, { method: "DELETE" }),
  /** Содержимое методики в конкретной версии: подписи строк модели до первого расчёта */
  surveyAtVersion: (id: string, version: number) => request<SurveyFull>(`/api/surveys/${id}?version=${version}`),
  episodes: (userId: string) =>
    request<{
      items: {
        id: string;
        openedAt: string;
        closedAt: string | null;
        reason: string | null;
        outcome: string | null;
        outcomeKind: string | null;
        leadName: string | null;
        visits: number;
        conclusions: number;
        referrals: number;
      }[];
    }>(`/api/episodes/patients/${userId}`),
  dispensary: (userId: string) =>
    request<{
      on: boolean;
      groupLabel?: string;
      intervalMonths?: number;
      lastSeenAt?: string | null;
      nextDueAt?: string;
      note?: string | null;
      overdueDays?: number;
    }>(`/api/episodes/dispensary/${userId}`),
  setDispensary: (input: {
    patientId: string;
    groupLabel: string;
    intervalMonths: number;
    note?: string | null;
  }) => request<{ ok: true }>("/api/episodes/dispensary", { method: "PUT", body: JSON.stringify(input) }),
  dispensarySeen: (userId: string) =>
    request<{ ok: true }>(`/api/episodes/dispensary/${userId}/seen`, { method: "POST" }),
  dispensaryRemove: (userId: string) =>
    request<{ ok: true }>(`/api/episodes/dispensary/${userId}`, { method: "DELETE" }),
  openEpisode: (input: { patientId: string; reason?: string | null }) =>
    request<{ id: string }>("/api/episodes", { method: "POST", body: JSON.stringify(input) }),
  closeEpisode: (id: string, outcomeKind: string, outcome?: string | null) =>
    request<{ ok: true }>(`/api/episodes/${id}/close`, {
      method: "POST",
      body: JSON.stringify({ outcomeKind, outcome }),
    }),
  attachVisit: (episodeId: string, appointmentId: string) =>
    request<{ ok: true }>(`/api/episodes/${episodeId}/appointments/${appointmentId}`, {
      method: "POST",
    }),
  recording: (appointmentId: string) =>
    request<{
      id: string;
      status: string;
      consentAt: string | null;
      consentBySelf: boolean;
      startedAt: string | null;
      durationMs: number | null;
      transcript: string | null;
      transcriptEngine: string | null;
      failure: string | null;
      transcriptionAvailable: boolean;
      queued: number;
    }>(`/api/recordings/${appointmentId}`),
  recordingConsent: (appointmentId: string) =>
    request<{ ok: true }>(`/api/recordings/${appointmentId}/consent`, { method: "POST" }),
  recordingRevoke: (appointmentId: string) =>
    request<{ ok: true }>(`/api/recordings/${appointmentId}/consent/revoke`, { method: "POST" }),
  recordingStart: (appointmentId: string) =>
    request<{ ok: true }>(`/api/recordings/${appointmentId}/start`, { method: "POST" }),
  /**
   * Остановить и передать аудио.
   *
   * Мимо общего request: тот ставит Content-Type: application/json, а
   * multipart требует границы, которую браузер вписывает сам. Подставить
   * заголовок руками значит сломать разбор на сервере.
   */
  recordingStop: async (appointmentId: string, audio: Blob | null) => {
    const form = new FormData();
    if (audio) form.append("audio", audio, "visit.webm");
    const res = await fetch(`/api/recordings/${appointmentId}/stop`, {
      method: "POST",
      headers: {
        "Accept-Language": currentLang,
        ...(tokenStore.get() ? { Authorization: `Bearer ${tokenStore.get()}` } : {}),
      },
      body: form,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new ApiError(body?.error ?? `HTTP ${res.status}`, res.status);
    }
  },
  recordingDiscard: (appointmentId: string) =>
    request<{ ok: true }>(`/api/recordings/${appointmentId}/discard`, { method: "POST" }),
  templates: () =>
    request<{
      items: {
        id: string;
        kind: "conclusion" | "note" | "phrase";
        title: string;
        body: string;
        departmentId: string | null;
      }[];
    }>("/api/templates"),
  /*
   * Отделение не передаётся: сервер берёт его из профиля автора. Позволить
   * клиенту назвать чужое отделение значило бы дать писать в его библиотеку,
   * а разбираться, откуда взялась строка, потом пришлось бы по журналу.
   */
  createTemplate: (input: {
    kind: "conclusion" | "note" | "phrase";
    title: string;
    body: string;
  }) => request<{ id: string }>("/api/templates", { method: "POST", body: JSON.stringify(input) }),
  visitContext: (id: string) =>
    request<{
      appointment: {
        id: string;
        startsAt: string;
        endsAt: string;
        kind: "primary" | "repeat";
        mode: "onsite" | "remote";
        status: string;
        reason: string | null;
      };
      patient: {
        id: string;
        fullName: string;
        unit: string | null;
        leadSpecialistId: string | null;
        leadName: string | null;
      };
      previous: { at: string; specialistName: string; status: string } | null;
      followedSince: string | null;
      changes: { kind: string; at: string; title: string; detail?: string | null }[];
      note: { id: string; version: number; status: string } | null;
    }>(`/api/clinic/appointments/${id}/context`),
  today: (params: { date?: string; specialistId?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.date) q.set("date", params.date);
    if (params.specialistId) q.set("specialistId", params.specialistId);
    return request<{ date: string; items: AppointmentView[] }>(`/api/clinic/today?${q}`);
  },
  appointmentStatus: (id: string, status: "arrived" | "in_progress" | "done" | "no_show") =>
    request<{ ok: true }>(`/api/clinic/appointments/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    }),
  takeLead: (userId: string, take: boolean) =>
    request<{ ok: true }>(`/api/clinic/patients/${userId}/lead`, {
      method: "POST",
      body: JSON.stringify({ take }),
    }),
  schedule: (specialistId?: string) => {
    const q = specialistId ? `?specialistId=${encodeURIComponent(specialistId)}` : "";
    return request<{
      specialistId: string;
      templates: ScheduleTemplateView[];
      exceptions: ScheduleExceptionView[];
      horizonWeeks: number;
    }>(`/api/clinic/schedule${q}`);
  },
  saveSchedule: (templates: Omit<ScheduleTemplateView, "id">[]) =>
    request<{ ok: true; added: number; removed: number; flagged: number }>("/api/clinic/schedule", {
      method: "PUT",
      body: JSON.stringify({ templates }),
    }),
  addScheduleException: (input: {
    date: string;
    kind: "off" | "extra";
    startsAt?: string | null;
    endsAt?: string | null;
    slotMinutes?: number | null;
    note?: string | null;
  }) =>
    request<{ id: string; added: number; removed: number; flagged: number }>(
      "/api/clinic/schedule/exceptions",
      { method: "POST", body: JSON.stringify(input) },
    ),
  removeScheduleException: (id: string) =>
    request<{ ok: true }>(`/api/clinic/schedule/exceptions/${id}`, { method: "DELETE" }),
  departments: () =>
    request<{ items: { id: string; title: string; timezone: string }[] }>("/api/clinic/departments"),
  specialists: (departmentId?: string) => {
    const q = departmentId ? `?departmentId=${encodeURIComponent(departmentId)}` : "";
    return request<{
      items: {
        userId: string;
        fullName: string;
        departmentId: string;
        position: string | null;
        room: string | null;
        isLead: boolean;
      }[];
    }>(`/api/clinic/specialists${q}`);
  },

  /* ── кабинет пациента ── */
  submitResponse: (
    surveyId: string,
    /*
     * clientRequestId — с первой попытки: сдача, отложенная до конца работ,
     * уходит с тем же id, и сервер узнает дубль, если первая попытка всё же
     * успела записаться (patient/outbox.ts).
     */
    body: { startedAt: string; durationMs: number; answers: unknown[]; events: unknown[]; clientRequestId?: string },
  ) =>
    request<{ id: string; safetyPlan: string | null }>(`/api/surveys/${surveyId}/responses`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  freeSlots: (params: { specialistId?: string; departmentId?: string } = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    return request<{
      items: {
        id: string;
        specialistId: string;
        specialistName: string;
        room: string | null;
        startsAt: string;
        endsAt: string;
      }[];
    }>(`/api/clinic/slots?${q}`);
  },
  myAppointments: () =>
    request<{
      items: {
        id: string;
        startsAt: string;
        endsAt: string;
        specialistName: string;
        room: string | null;
        status: string;
        mode: string;
        meetingUrl: string | null;
      }[];
    }>("/api/clinic/appointments/mine"),
  book: (body: { slotId: string; reason?: string | null; mode?: "onsite" | "remote" }) =>
    request<{ id: string; screeningSurveyId: string | null }>("/api/clinic/appointments", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  confirmAppointment: (id: string) =>
    request<{ ok: true }>(`/api/clinic/appointments/${id}/confirm`, { method: "POST" }),
  cancelAppointment: (id: string, reason?: string) =>
    request<{ ok: true; late: boolean }>(`/api/clinic/appointments/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason: reason ?? null }),
    }),
};
