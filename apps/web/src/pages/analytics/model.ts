import type { DecisionRule, RuleAction, RuleCondition, ScaleCondition, UiKey } from "@quizzy/shared";

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

export type SavedModel = DecisionRule & { note: string | null };

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
 * Что мешает сохранить — ключами словаря, по одному на причину.
 *
 * Проверяется то же, что проверит сервер (ruleSchema в routes/decisions.ts),
 * но раньше и словами: отказ 400 с именем поля zod человеку в кабинете не
 * читается. Порог у истории — 0…100, как в схеме.
 */
export function validateDraft(d: ModelDraft): UiKey[] {
  const errs = new Set<UiKey>();
  if (!d.title.trim()) errs.add("am.errTitle");
  if (d.params.length === 0) errs.add("am.errNoParams");
  for (const p of d.params) {
    if (p.kind === "scale") {
      if (!p.surveyId) errs.add("am.errTest");
      if (!p.scaleCode.trim()) errs.add("am.errScale");
      if (p.value.trim() === "" || !Number.isFinite(Number(p.value))) errs.add("am.errThreshold");
    } else if (p.kind === "history") {
      const n = Number(p.completedAtLeast);
      if (p.completedAtLeast.trim() === "" || !Number.isInteger(n) || n < 0 || n > 100) errs.add("am.errCount");
    }
  }
  if (d.actions.length === 0) errs.add("am.errNoActions");
  for (const a of d.actions) {
    if (a.kind === "advise" && !a.text.trim()) errs.add("am.errAdvise");
    if (a.kind === "suggest_survey" && !a.surveyId) errs.add("am.errSuggest");
    if (a.kind === "suggest_pathway" && !a.pathwayId.trim()) errs.add("am.errPathway");
  }
  return [...errs];
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
