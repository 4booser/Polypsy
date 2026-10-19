import type { DecisionRule, RuleAction, RuleCondition, ScaleCondition, UiKey } from "@quizzy/shared";
import { numText } from "./tests/model";

/**
 * Чистая часть раздела «Аналітика»: поиск и страницы перечня, черновик
 * модели ↔ правило на сервере, проверка перед сохранением.
 *
 * Вынесено из экранов ради проверки без React и сервера
 * (apps/web/test/analytics.test.ts): обратный перевод «правило → черновик →
 * правило» обязан быть тождеством, иначе открыть и сохранить чужую модель
 * значило бы её молча испортить.
 *
 * ── Что такое «аналітична модель» в этой системе ──
 *
 * Своей таблицы у модели на сервере нет. Ближайшая сущность, которая уже
 * есть и уже считается на каждой сдаче, — правило поддержки решений
 * (decision_rules, packages/shared/src/rules.ts): имя + условия по тестам и
 * шкалам + действия. Экран заключения (Conclusion.tsx) так его и называет —
 * «аналитическая модель» с вердиктом. Поэтому раздел строится на правилах, а
 * не на новой сущности, которую пришлось бы выдумать вместе с маршрутами.
 *
 * Чего правило не умеет, а кадр f19 рисует (записано в api_gaps отчёта):
 *   · «Або» между блоками — условия соединяются только «Разом з»
 *     (evaluateRules требует every(met)); уровня блоков у правила нет, и
 *     блок здесь один;
 *   · условие по вопросу, ответу и «Час реакції» — таких видов условия нет
 *     вовсе (RuleCondition — только scale, risk, history);
 *   · «Об’єднати» и «Додати Оператор» — при одном блоке объединять и
 *     выбирать нечего.
 * Первых двух экран не рисует: поле без действия хуже отсутствия поля — его
 * заполнят и не сохранят. Два пункта меню остаются на своих местах кадра
 * недоступными, с подсказкой о причине (см. Editor.tsx).
 */

/* ─────────── перечень ─────────── */

/**
 * Модель с сервера. Даты строки — из того же GET /api/decisions/rules
 * (маршрут отдаёт строку таблицы целиком): перечень печатает «змінено …», а
 * окно «Про модель» — когда создана и когда правлена.
 */
export type SavedModel = DecisionRule & { note: string | null; createdAt?: string; updatedAt?: string };

/**
 * Поиск — на клиенте, по названию и описанию.
 *
 * GET /api/decisions/rules не знает ни ?q=, ни страниц и отдаёт все строки
 * сразу; правил в учреждении единицы-десятки, и второй механизм страниц на
 * сервере ради них не стоит — так же решено для снятых методик каталога.
 * Регистр не важен: «ризик» и «Ризик» — один запрос.
 */
export function filterModels<T extends { title: string; note: string | null }>(rows: readonly T[], q: string): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter(
    (r) => r.title.toLowerCase().includes(needle) || (r.note ?? "").toLowerCase().includes(needle),
  );
}

/** Строки одной страницы; страница за концом списка — пустая, а не ошибка */
export function pageSlice<T>(rows: readonly T[], page: number, per: number): T[] {
  const from = (page - 1) * per;
  return rows.slice(from, from + per);
}

/** Адрес модели; "new" — форма новой */
export function modelHref(id: string | "new"): string {
  return `/analytics/${id}`;
}

/* ─────────── черновик ─────────── */

export type Op = ScaleCondition["op"];

/** Порядок — как в селекте: от самого частого («не менше») к редким */
export const OPS: readonly Op[] = [">=", "<=", ">", "<"];

/**
 * Сравнение — словами, а не знаком: «Не менше» читается, знак «≥» человек в
 * кабинете переводит в голове. Самих слов на кадрах раздела нет — условие и
 * порог убраны с глаз в окно «Результат тесту» (см. Editor.tsx), — но текстом
 * условия строка подписана именно ими.
 */
export const OP_KEY: Record<Op, UiKey> = {
  ">=": "am.opGte",
  "<=": "am.opLte",
  ">": "am.opGt",
  "<": "am.opLt",
};

/**
 * Порог условия — языком страницы: «2,5» по-украински и по-русски, «2.5»
 * по-английски.
 *
 * Сервер хранит число, а поле числа отдаёт набранное с точкой при любом
 * языке; печатать как есть значило ставить точку в украинском перечне.
 * Знаков — сколько записано (до шести): порог округлением не подменяется.
 * Не число (поле ещё набирают, «-») — как набрано.
 */
export function thresholdText(v: string | number): string {
  const n = typeof v === "number" ? v : v.trim() === "" ? Number.NaN : Number(v);
  return Number.isFinite(n) ? numText(n, 6) : String(v).trim();
}

/**
 * «Будь-який тест»: условие по коду шкалы в той методике, которую сдали.
 *
 * Правило хранит surveyId: null именно с таким смыслом (rules.ts,
 * ScaleCondition). В черновике это отдельное значение, а не пустая строка:
 * пустая строка — «тест ещё не выбран», и её сохранять нельзя.
 *
 * В раскрытом списке тестов (кадр f25) такого пункта нет — там только
 * названия методик, — поэтому вид условия выбирают при добавлении параметра
 * (окно «Додати Параметр» в Editor.tsx).
 */
export const ANY_TEST = "*";

export type ParamKind = RuleCondition["kind"];

export interface DraftParam {
  /** Ключ строки для React и для отметки: индексы при удалении плывут */
  key: string;
  kind: ParamKind;
  /** "" — не выбран, ANY_TEST — любой, иначе идентификатор методики */
  surveyId: string;
  scaleCode: string;
  metric: "raw" | "normed";
  op: Op;
  /**
   * Числа хранятся строками, пока человек набирает: «-» и пустое поле —
   * законные промежуточные состояния, а Number от них даёт NaN, который
   * React не принимает значением поля.
   */
  value: string;
  severity: "moderate" | "severe";
  completedAtLeast: string;
  /** Отмечен квадратиком справа — для «Видалити» из меню шестерёнки */
  picked: boolean;
}

export interface DraftAction {
  key: string;
  kind: RuleAction["kind"];
  text: string;
  surveyId: string;
  pathwayId: string;
  picked: boolean;
}

export interface ModelDraft {
  title: string;
  note: string;
  enabled: boolean;
  params: DraftParam[];
  actions: DraftAction[];
}

let seq = 0;
/** Ключ новой строки: уникален в пределах вкладки, большего не нужно */
export const nextKey = (): string => `k${++seq}`;

export function newParam(over: Partial<DraftParam> = {}): DraftParam {
  return {
    key: nextKey(),
    kind: "scale",
    surveyId: "",
    scaleCode: "",
    metric: "raw",
    op: ">=",
    value: "",
    severity: "moderate",
    completedAtLeast: "1",
    picked: false,
    ...over,
  };
}

export function newAction(over: Partial<DraftAction> = {}): DraftAction {
  return { key: nextKey(), kind: "advise", text: "", surveyId: "", pathwayId: "", picked: false, ...over };
}

/**
 * Новая модель начинается с одного параметра и одного действия, а не пустой.
 *
 * Сервер не принимает правило без условий и без действий (ruleSchema:
 * min(1) у обоих), и пустая форма означала бы два обязательных нажатия в
 * меню шестерёнки до первого поля. На кадре f19 карточка тоже нарисована уже
 * с параметрами внутри.
 */
export function emptyDraft(): ModelDraft {
  return { title: "", note: "", enabled: true, params: [newParam()], actions: [newAction()] };
}

/** Правило с сервера → черновик. Ничего не теряет: см. проверку тождества в тесте */
export function draftFromRule(rule: SavedModel): ModelDraft {
  return {
    title: rule.title,
    note: rule.note ?? "",
    enabled: rule.enabled,
    params: rule.conditions.map((c) => {
      switch (c.kind) {
        case "scale":
          return newParam({
            kind: "scale",
            surveyId: c.surveyId ?? ANY_TEST,
            scaleCode: c.scaleCode,
            metric: c.metric,
            op: c.op,
            value: String(c.value),
          });
        case "risk":
          return newParam({ kind: "risk", severity: c.severity });
        case "history":
          return newParam({ kind: "history", completedAtLeast: String(c.completedAtLeast) });
      }
    }),
    actions: rule.actions.map((a) => {
      switch (a.kind) {
        case "advise":
          return newAction({ kind: "advise", text: a.text });
        case "suggest_survey":
          return newAction({ kind: "suggest_survey", surveyId: a.surveyId });
        case "suggest_pathway":
          return newAction({ kind: "suggest_pathway", pathwayId: a.pathwayId });
        case "notify_duty":
          return newAction({ kind: "notify_duty" });
      }
    }),
  };
}

/** Тело POST/PATCH /api/decisions/rules — ровно то, что понимает ruleSchema */
export interface ModelPayload {
  title: string;
  note: string | null;
  enabled: boolean;
  conditions: RuleCondition[];
  actions: RuleAction[];
}

/**
 * Черновик → тело запроса. Зовётся только после validateDraft: здесь числа
 * уже разбираются, а невыбранный тест не встречается.
 */
export function draftToPayload(d: ModelDraft): ModelPayload {
  return {
    title: d.title.trim(),
    note: d.note.trim() || null,
    enabled: d.enabled,
    conditions: d.params.map((p): RuleCondition => {
      switch (p.kind) {
        case "scale":
          return {
            kind: "scale",
            surveyId: p.surveyId === ANY_TEST ? null : p.surveyId,
            scaleCode: p.scaleCode.trim(),
            metric: p.metric,
            op: p.op,
            value: Number(p.value),
          };
        case "risk":
          return { kind: "risk", severity: p.severity };
        case "history":
          return { kind: "history", completedAtLeast: Number(p.completedAtLeast) };
      }
    }),
    actions: d.actions.map((a): RuleAction => {
      switch (a.kind) {
        case "advise":
          return { kind: "advise", text: a.text.trim() };
        case "suggest_survey":
          return { kind: "suggest_survey", surveyId: a.surveyId };
        case "suggest_pathway":
          return { kind: "suggest_pathway", pathwayId: a.pathwayId.trim() };
        case "notify_duty":
          return { kind: "notify_duty" };
      }
    }),
  };
}

/**
 * Где именно черновик не готов: ключ словаря и место — поле формы, условие
 * или действие по номеру. Форма ставит отказ под самим полем, а сводка над
 * формой ведёт к нему ссылкой («Умова 1: вкажіть шкалу»).
 */
export type IssueField =
  | "title"
  | "params"
  | "actions"
  | "test"
  | "scale"
  | "threshold"
  | "count"
  | "advise"
  | "suggest"
  | "pathway";

export interface DraftIssue {
  key: UiKey;
  field: IssueField;
  /** Номер условия (с нуля), если отказ — у условия */
  param?: number;
  /** Номер действия (с нуля), если отказ — у действия */
  action?: number;
}

/**
 * Все отказы черновика по местам — в порядке формы: название, условия
 * сверху вниз, действия.
 *
 * Проверяется то же, что проверит сервер (ruleSchema в routes/decisions.ts),
 * но раньше и словами: отказ 400 с именем поля zod человеку в кабинете не
 * читается. Порог у истории — 0…100, как в схеме.
 */
export function draftIssues(d: ModelDraft): DraftIssue[] {
  const out: DraftIssue[] = [];
  if (!d.title.trim()) out.push({ key: "am.errTitle", field: "title" });
  if (d.params.length === 0) out.push({ key: "am.errNoParams", field: "params" });
  d.params.forEach((p, i) => {
    if (p.kind === "scale") {
      if (!p.surveyId) out.push({ key: "am.errTest", field: "test", param: i });
      if (!p.scaleCode.trim()) out.push({ key: "am.errScale", field: "scale", param: i });
      if (p.value.trim() === "" || !Number.isFinite(Number(p.value))) out.push({ key: "am.errThreshold", field: "threshold", param: i });
    } else if (p.kind === "history") {
      const n = Number(p.completedAtLeast);
      if (p.completedAtLeast.trim() === "" || !Number.isInteger(n) || n < 0 || n > 100) {
        out.push({ key: "am.errCount", field: "count", param: i });
      }
    }
  });
  if (d.actions.length === 0) out.push({ key: "am.errNoActions", field: "actions" });
  d.actions.forEach((a, i) => {
    if (a.kind === "advise" && !a.text.trim()) out.push({ key: "am.errAdvise", field: "advise", action: i });
    if (a.kind === "suggest_survey" && !a.surveyId) out.push({ key: "am.errSuggest", field: "suggest", action: i });
    if (a.kind === "suggest_pathway" && !a.pathwayId.trim()) out.push({ key: "am.errPathway", field: "pathway", action: i });
  });
  return out;
}

/**
 * Что мешает сохранить — ключами словаря, по одному на причину: та же
 * проверка, что draftIssues, без мест. Одна причина не повторяется по числу
 * строк — для сводки «чего не хватает» это одно и то же.
 */
export function validateDraft(d: ModelDraft): UiKey[] {
  return [...new Set(draftIssues(d).map((i) => i.key))];
}

/** Убрать отмеченные строки; ничего не отмечено — черновик тот же объект */
export function dropPicked(d: ModelDraft): ModelDraft {
  const params = d.params.filter((p) => !p.picked);
  const actions = d.actions.filter((a) => !a.picked);
  if (params.length === d.params.length && actions.length === d.actions.length) return d;
  return { ...d, params, actions };
}

/**
 * Идентификаторы методик, которые редактору нужно дочитать целиком, — без
 * повторов, без «любой» и пустых:
 *   · выбранные в параметрах — ради их шкал (в списке методик шкал нет);
 *   · предложенные в действиях, но отсутствующие в списке api.surveys(), —
 *     ради названия: снятую с использования или чужую методику список не
 *     отдаёт, а поле должно показать, что в нём стоит (SurveyOptions в
 *     Editor.tsx). Те, что в списке есть, названы уже им, и второй запрос
 *     на каждое действие был бы впустую.
 */
export function surveysToLoad(d: ModelDraft, listed: ReadonlySet<string>): string[] {
  const ids = new Set<string>();
  for (const p of d.params) {
    if (p.kind === "scale" && p.surveyId && p.surveyId !== ANY_TEST) ids.add(p.surveyId);
  }
  for (const a of d.actions) {
    if (a.kind === "suggest_survey" && a.surveyId && !listed.has(a.surveyId)) ids.add(a.surveyId);
  }
  return [...ids];
}

/* ─────────── перечень: виды, порядок, фильтры ─────────── */

/** Виды перечня: все, только включённые, только выключенные */
export type ModelView = "all" | "on" | "off";

export function viewFrom(raw: string | null): ModelView {
  return raw === "on" || raw === "off" ? raw : "all";
}

export function inView(m: Pick<SavedModel, "enabled">, view: ModelView): boolean {
  return view === "all" || (view === "on" ? m.enabled : !m.enabled);
}

/**
 * Порядок перечня. «Спершу нові» — порядок сервера (createdAt по убыванию),
 * поэтому и умолчание: его не пишут в адрес. «Спершу змінені» — по дате
 * правки; у строки без даты (старый сервер) порядок сервера сохраняется.
 */
export type ModelSort = "new" | "changed" | "title";
export const MODEL_SORTS: readonly ModelSort[] = ["new", "changed", "title"];

export function sortFrom(raw: string | null): ModelSort {
  return raw === "changed" || raw === "title" ? raw : "new";
}

export function sortModels<T extends Pick<SavedModel, "title" | "createdAt" | "updatedAt">>(rows: readonly T[], sort: ModelSort): T[] {
  const at = (v: string | undefined) => (v ? Date.parse(v) || 0 : 0);
  const list = [...rows];
  if (sort === "title") return list.sort((a, b) => a.title.localeCompare(b.title));
  if (sort === "changed") return list.sort((a, b) => at(b.updatedAt) - at(a.updatedAt));
  return list.sort((a, b) => at(b.createdAt) - at(a.createdAt));
}

/**
 * Методики, о которых говорят условия модели: идентификаторы без повторов,
 * ANY_TEST — условие «будь-який тест». Флаг риска и число прохождений
 * методики не называют.
 */
export function ruleTests(rule: Pick<SavedModel, "conditions">): string[] {
  const out = new Set<string>();
  for (const c of rule.conditions) if (c.kind === "scale") out.add(c.surveyId ?? ANY_TEST);
  return [...out];
}

export interface ModelQuery {
  q: string;
  view: ModelView;
  /** Методика в условиях (или ANY_TEST); null — любая */
  test: string | null;
  /** Вид действия; null — любой */
  act: RuleAction["kind"] | null;
}

/** Все фильтры перечня разом: поиск, вид, методика в условиях, вид действия */
export function selectModels<T extends SavedModel>(rows: readonly T[], query: ModelQuery): T[] {
  return filterModels(rows, query.q).filter(
    (m) =>
      inView(m, query.view) &&
      (query.test === null || ruleTests(m).includes(query.test)) &&
      (query.act === null || m.actions.some((a) => a.kind === query.act)),
  );
}

/** Строка «Під моделями»: методика (или ANY_TEST) и модели, которые её проверяют */
export interface CoverRow {
  key: string;
  on: SavedModel[];
  off: SavedModel[];
}

/**
 * Какие методики под моделями. Сначала те, где включённых больше; «будь-який
 * тест» — после названных методик: он покрывает всё понемногу и читается
 * как страховка, а не как ответ про конкретный тест. Методика, у которой
 * только выключенные модели, — в конце: под защитой она формально, а не на
 * деле.
 */
export function coverage(rows: readonly SavedModel[]): CoverRow[] {
  const by = new Map<string, CoverRow>();
  for (const m of rows) {
    for (const key of ruleTests(m)) {
      const row = by.get(key) ?? { key, on: [], off: [] };
      (m.enabled ? row.on : row.off).push(m);
      by.set(key, row);
    }
  }
  const rank = (r: CoverRow) => (r.on.length === 0 ? 2 : r.key === ANY_TEST ? 1 : 0);
  return [...by.values()].sort((a, b) => rank(a) - rank(b) || b.on.length - a.on.length);
}

/** Методики из списка, которых не называет ни одна модель, — в порядке списка */
export function uncovered<T extends { id: string }>(surveys: readonly T[], rows: readonly SavedModel[]): T[] {
  const named = new Set(rows.flatMap((m) => ruleTests(m)));
  return surveys.filter((s) => !named.has(s.id));
}

/* ─────────── черновик: изменения и копия ─────────── */

/** Черновик без служебного: ключи строк и отметки не меняют модель */
function plain(d: ModelDraft) {
  return {
    title: d.title,
    note: d.note,
    enabled: d.enabled,
    params: d.params.map(({ key: _k, picked: _p, ...rest }) => rest),
    actions: d.actions.map(({ key: _k, picked: _p, ...rest }) => rest),
  };
}

/** Одна ли модель в двух черновиках — по смыслу, а не по ключам строк */
export function sameDraft(a: ModelDraft, b: ModelDraft): boolean {
  return JSON.stringify(plain(a)) === JSON.stringify(plain(b));
}

export type DraftChange =
  | { kind: "title" }
  | { kind: "note" }
  | { kind: "enabled"; on: boolean }
  | { kind: "threshold"; index: number; from: string; to: string }
  | { kind: "param"; index: number }
  | { kind: "paramsAdded"; n: number }
  | { kind: "paramsRemoved"; n: number }
  | { kind: "action"; index: number }
  | { kind: "actionsAdded"; n: number }
  | { kind: "actionsRemoved"; n: number };

/**
 * Что поменялось относительно сохранённой модели — для строки «Зміни»
 * панели «Про модель». Строки сравниваются по месту: условие, у которого
 * сменился только порог, называется порогом «19 → 20» — это самая частая
 * правка, и её важно видеть числом.
 */
export function draftChanges(saved: ModelDraft, now: ModelDraft): DraftChange[] {
  const a = plain(saved);
  const b = plain(now);
  const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
  const out: DraftChange[] = [];
  if (a.title.trim() !== b.title.trim()) out.push({ kind: "title" });
  if (a.note.trim() !== b.note.trim()) out.push({ kind: "note" });
  if (a.enabled !== b.enabled) out.push({ kind: "enabled", on: b.enabled });
  for (let i = 0; i < Math.min(a.params.length, b.params.length); i++) {
    const x = a.params[i]!;
    const y = b.params[i]!;
    if (same(x, y)) continue;
    if (same({ ...x, value: "" }, { ...y, value: "" })) out.push({ kind: "threshold", index: i, from: x.value, to: y.value });
    else out.push({ kind: "param", index: i });
  }
  if (b.params.length > a.params.length) out.push({ kind: "paramsAdded", n: b.params.length - a.params.length });
  if (b.params.length < a.params.length) out.push({ kind: "paramsRemoved", n: a.params.length - b.params.length });
  for (let i = 0; i < Math.min(a.actions.length, b.actions.length); i++) {
    if (!same(a.actions[i], b.actions[i])) out.push({ kind: "action", index: i });
  }
  if (b.actions.length > a.actions.length) out.push({ kind: "actionsAdded", n: b.actions.length - a.actions.length });
  if (b.actions.length < a.actions.length) out.push({ kind: "actionsRemoved", n: a.actions.length - b.actions.length });
  return out;
}

/**
 * Черновик новой модели по образцу: условия, действия и описание — как у
 * образца, имя — с пометкой копии (`title` уже собран экраном на языке
 * человека), включена. Сохраняется новой строкой — образец не меняется.
 */
export function copyDraft(rule: SavedModel, title: string): ModelDraft {
  return { ...draftFromRule(rule), title, enabled: true };
}

/** Адрес формы новой модели по образцу */
export function copyHref(id: string): string {
  return `${modelHref("new")}?copy=${encodeURIComponent(id)}`;
}
