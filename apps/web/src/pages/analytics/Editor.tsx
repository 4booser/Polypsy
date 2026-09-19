import { Fragment, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Scale, SurveyListItem } from "@quizzy/shared";
import { api } from "../../api";
import { useLang } from "../../lang";
import { Loading, useAction, useToast } from "../../ui";
import { cx } from "../../ui/cx";
import { GearGlyph } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { MenuButton, dangerItem, menuItemClass } from "../../ui/menu";
import { Button, Field, Input, Select, Textarea } from "../../ui/primitives";
import { useResource } from "../../useResource";
import {
  ANY_TEST,
  OPS,
  OP_KEY,
  type DraftAction,
  type DraftParam,
  type ModelDraft,
  draftFromRule,
  draftToPayload,
  dropPicked,
  emptyDraft,
  modelHref,
  newAction,
  newParam,
  surveysToLoad,
  validateDraft,
} from "./model";

/*
 * Аналитическая модель — кадры f15 и f27 макета, один экран.
 *
 * Два кадра — одна форма в двух состояниях: f15 — структура целиком с
 * раскрытым меню шестерёнки, f27 — та же форма с раскрытым списком выбора
 * теста поверх блоков. Взят f15 как более полный; из f27 добавлено то, чего
 * на f15 не видно: сравнение словами («Не менше») и узкое числовое поле
 * порога рядом с ним.
 *
 * Что на кадре и как это легло на код:
 *
 *   «Аналітика», поле «Назва аналітичної моделі»  → Page + Field/Input
 *   «Структура» + шестерёнка с меню                → h2 + MenuButton
 *   рамка блока                                     → один блок условий
 *   «Назва тесту» + квадратик справа               → Select методик + Pick
 *   «Результат тесту» с отступом                    → вид параметра + шкала,
 *                                                     ниже — что сравниваем,
 *                                                     условие, порог
 *   «Разом з» между параметрами                     → чип, оператор «и»
 *   «Додати правило» внутри блока                   → новый параметр
 *
 * Чего на кадре есть, а здесь нет, — и это не пропуск, а граница сервера
 * (подробно в model.ts и в отчёте волны): второй блок с «Або» между блоками,
 * параметр «Питання / Відповідь / Час реакції», пункты «Додати Оператор» и
 * «Об'єднати». Правило поддержки решений соединяет условия только «и», а
 * условий по отдельному ответу и времени реакции в нём нет. Рисовать эти
 * элементы без действия значило бы, что их нажмут.
 *
 * Чего на кадре нет, а здесь есть:
 *   · описание модели — перечень (f08) печатает «Опис аналітичної моделі»,
 *     значит вводят его где-то, и единственное место — эта форма;
 *   · раздел «Дії» — сервер не принимает правило без действия (min(1)), а
 *     «Додати Дію» стоит в меню шестерёнки на самом кадре: значит, действия
 *     задумывались, только нарисовать их не успели;
 *   · кнопка «Зберегти» — форма без сохранения не форма; кнопка формы макета,
 *     45px, 22/700, у правого края колонки.
 *
 * Колонка 700 по центру — замер f15 (455→1155 на кадре 1600); заголовок
 * стоит на оси общей колонки 1200, как у всех экранов рамки Page и как у
 * просмотра теста (f34).
 */

/**
 * Обёртка с ключом: форма новой модели и форма правки — один компонент на
 * двух маршрутах, и без ключа переход с /analytics/:id на /analytics/new
 * оставил бы в полях чужую модель.
 */
export default function AnalyticsModelPage() {
  const { id } = useParams<{ id: string }>();
  return <ModelEditor key={id ?? "new"} id={id ?? null} />;
}

/** Плейсхолдер селекта — фиолетовым полужирным, как подпись поля на макете */
const PLACEHOLDER = { color: "var(--primary)", fontWeight: 700 } as const;

function ModelEditor({ id }: { id: string | null }) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, busy } = useAction();

  const surveys = useResource(() => api.surveys(), []);
  /*
   * Правило читается из общего списка: маршрута «одно правило» на сервере
   * нет (см. api_gaps). Список короткий, и второй запрос не стоит того,
   * чтобы заводить маршрут ради него.
   */
  const rules = useResource(() => api.decisionRules(), [], { enabled: id !== null });

  const [draft, setDraft] = useState<ModelDraft | null>(id === null ? emptyDraft() : null);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (id === null || !rules.data) return;
    const rule = rules.data.find((r) => r.id === id);
    if (rule) setDraft(draftFromRule(rule));
    else setMissing(true);
  }, [id, rules.data]);

  /*
   * Шкалы каждой выбранной методики — по требованию и один раз.
   *
   * В списке методик шкал нет (SurveyListItem), они приходят с методикой
   * целиком. Грузить все методики ради селекта шкал — это сотня запросов при
   * открытии формы; грузятся только те, что стоят в параметрах, и только
   * когда их выбрали.
   */
  const [scales, setScales] = useState<Record<string, Scale[]>>({});
  const inFlight = useRef(new Set<string>());
  const wanted = draft ? surveysToLoad(draft).join(",") : "";
  useEffect(() => {
    for (const surveyId of wanted.split(",").filter(Boolean)) {
      if (scales[surveyId] || inFlight.current.has(surveyId)) continue;
      inFlight.current.add(surveyId);
      void api
        .survey(surveyId)
        .then((s) => setScales((prev) => ({ ...prev, [surveyId]: s.scales })))
        /* отказ — не поломка формы: код шкалы можно вписать руками */
        .catch(() => setScales((prev) => ({ ...prev, [surveyId]: [] })))
        .finally(() => inFlight.current.delete(surveyId));
    }
  }, [wanted, scales]);

  const [errors, setErrors] = useState<string[]>([]);

  const patch = (next: Partial<ModelDraft>) => setDraft((d) => (d ? { ...d, ...next } : d));
  const patchParam = (key: string, next: Partial<DraftParam>) =>
    setDraft((d) => (d ? { ...d, params: d.params.map((p) => (p.key === key ? { ...p, ...next } : p)) } : d));
  const patchAction = (key: string, next: Partial<DraftAction>) =>
    setDraft((d) => (d ? { ...d, actions: d.actions.map((a) => (a.key === key ? { ...a, ...next } : a)) } : d));

  const removePicked = () => {
    if (!draft) return;
    const next = dropPicked(draft);
    if (next === draft) {
      toast(ut("am.noneSelected"), "info");
      return;
    }
    setDraft(next);
  };

  const save = () => {
    if (!draft) return;
    const errs = validateDraft(draft).map((k) => ut(k));
    setErrors(errs);
    if (errs.length) return;
    void run(async () => {
      const payload = draftToPayload(draft);
      if (id === null) {
        const created = await api.createDecisionRule(payload);
        /* replace: «назад» из правки новой модели ведёт в перечень, а не в пустую форму */
        navigate(modelHref(created.id), { replace: true });
      } else {
        await api.updateDecisionRule(id, payload);
        rules.reload();
      }
    }, ut("am.saved"));
  };

  if (missing) {
    return (
      <Page title={ut("top.analytics")}>
        <p className="m-0 text-[13px] text-muted">{ut("am.notFound")}</p>
        <Link to="/analytics" className="mt-[12px] inline-block text-[15px] font-bold text-primary">
          {ut("am.backToList")}
        </Link>
      </Page>
    );
  }
  if (!draft || !surveys.data) {
    return (
      <Page title={ut("top.analytics")}>
        <Loading
          rows={6}
          error={rules.error ?? surveys.error}
          onRetry={() => {
            if (rules.error) rules.reload();
            if (surveys.error) surveys.reload();
          }}
        />
      </Page>
    );
  }

  /* сужение типа не доживает до замыканий ниже — берём список в константу */
  const surveyList = surveys.data;

  return (
    <Page title={ut("top.analytics")}>
      <div className="mx-auto w-full max-w-[700px]">
        <Field label={ut("am.modelName")}>
          <Input value={draft.title} onChange={(e) => patch({ title: e.target.value })} maxLength={200} />
        </Field>
        <Field label={ut("am.modelNote")}>
          <Textarea rows={2} value={draft.note} onChange={(e) => patch({ note: e.target.value })} maxLength={2000} />
        </Field>

        <section aria-labelledby="am-structure" className="mt-[50px]">
          {/* «Структура» слева, шестерёнка у правого края колонки — как на кадре */}
          <div className="flex items-center justify-between">
            <h2 id="am-structure" className="m-0 text-[18px] font-bold leading-tight text-primary">
              {ut("am.structure")}
            </h2>
            <MenuButton label={ut("am.structureMenu")} glyph={<GearGlyph />}>
              {(close) => (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItemClass("right")}
                    onClick={() => {
                      close();
                      patch({ actions: [...draft.actions, newAction()] });
                    }}
                  >
                    {ut("am.addAction")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItemClass("right")}
                    onClick={() => {
                      close();
                      patch({ params: [...draft.params, newParam()] });
                    }}
                  >
                    {ut("am.addParam")}
                  </button>
                  {/*
                    Включение модели — здесь, а не отдельным переключателем
                    на форме: на кадре его нет, а выключенное правило, которое
                    нельзя включить обратно, — ловушка.
                  */}
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItemClass("right")}
                    onClick={() => {
                      close();
                      patch({ enabled: !draft.enabled });
                    }}
                  >
                    {draft.enabled ? ut("am.disable") : ut("am.enable")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={cx(menuItemClass("right"), dangerItem)}
                    onClick={() => {
                      close();
                      removePicked();
                    }}
                  >
                    {ut("am.deleteSelected")}
                  </button>
                </>
              )}
            </MenuButton>
          </div>

          {/*
            Рамка блока: линия #cccccc, радиус 5, поле 20 — замер f15
            (455→1155 рамка, 475 первое поле). Между строками 15: вместе с
            полем 36 это шаг 51, ритм формы макета.
          */}
          <div className="mt-[14px] flex flex-col gap-[15px] rounded-[5px] border border-hairline p-[20px]">
            {draft.params.map((p, i) => (
              <Fragment key={p.key}>
                {i > 0 ? (
                  /*
                    «Разом з» — чип 36 высотой у правого края, как на кадре.
                    Не кнопка: оператор в правиле один, переключать нечего.
                    Читается диктором как текст между параметрами — так и
                    задумано, это и есть смысл строки.
                  */
                  <div className="flex justify-end">
                    <span className="inline-flex h-9 items-center rounded-[5px] border border-hairline px-[14px] text-[17px] text-muted">
                      {ut("am.together")}
                    </span>
                  </div>
                ) : null}
                <ParamRow
                  p={p}
                  surveys={surveyList}
                  scales={p.surveyId === ANY_TEST || !p.surveyId ? undefined : scales[p.surveyId]}
                  onChange={(next) => patchParam(p.key, next)}
                />
              </Fragment>
            ))}
            <div className="flex justify-end">
              <Button onClick={() => patch({ params: [...draft.params, newParam()] })}>{ut("am.addRule")}</Button>
            </div>
          </div>
        </section>

        <section aria-labelledby="am-actions" className="mt-[40px]">
          <h2 id="am-actions" className="m-0 text-[18px] font-bold leading-tight text-primary">
            {ut("am.actions")}
          </h2>
          <div className="mt-[14px] flex flex-col gap-[15px] rounded-[5px] border border-hairline p-[20px]">
            {draft.actions.length === 0 ? (
              <p className="m-0 text-[13px] leading-[19px] text-muted">{ut("am.noActions")}</p>
            ) : null}
            {draft.actions.map((a) => (
              <ActionRow key={a.key} a={a} surveys={surveyList} onChange={(next) => patchAction(a.key, next)} />
            ))}
            <div className="flex justify-end">
              <Button onClick={() => patch({ actions: [...draft.actions, newAction()] })}>{ut("am.addAction")}</Button>
            </div>
          </div>
        </section>

        {!draft.enabled ? <p className="m-0 mt-[20px] text-[13px] leading-[19px] text-muted">{ut("am.disabledNote")}</p> : null}
        {errors.length ? (
          <ul role="alert" className="m-0 mt-[20px] list-none p-0 text-[13px] leading-[19px] text-danger">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ) : null}

        <div className="mt-[30px] flex justify-end">
          <Button size="md" disabled={busy} onClick={save}>
            {ut("common.save")}
          </Button>
        </div>
      </div>
    </Page>
  );
}

/* ─────────── параметр ─────────── */

/**
 * Квадратик отметки справа от «Назва тесту» — 20×20, замер f15; отмеченный
 * залит фиолетовым внутри рамки, как на кадре (не галочка браузера).
 *
 * Сам флажок — настоящий <input type="checkbox">, скрытый визуально: диктор
 * и клавиатура получают штатный флажок, глаз — квадрат макета. Область
 * нажатия дорисована до 44 псевдоэлементом, как у глифов (см. Button
 * size="glyph"): отступами она раздвинула бы зазор 12 до поля.
 */
function Pick({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label
      className={cx(
        "relative inline-flex size-[20px] shrink-0 cursor-pointer items-center justify-center",
        "after:absolute after:left-1/2 after:top-1/2 after:size-[44px] after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
      )}
    >
      <input
        type="checkbox"
        className="peer sr-only"
        checked={checked}
        aria-label={label}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className={cx(
          "size-[20px] rounded-[3px] border border-hairline bg-[var(--bg)]",
          "transition-colors duration-[var(--dur-fast)] peer-checked:border-primary",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--focus)] peer-focus-visible:ring-offset-2",
        )}
      />
      <span
        aria-hidden
        className="absolute size-[12px] rounded-[2px] bg-primary opacity-0 transition-opacity duration-[var(--dur-fast)] peer-checked:opacity-100"
      />
    </label>
  );
}

function ParamRow({
  p,
  surveys,
  scales,
  onChange,
}: {
  p: DraftParam;
  surveys: SurveyListItem[];
  /** Шкалы выбранной методики; undefined — ещё грузятся или методика «любая» */
  scales: Scale[] | undefined;
  onChange: (next: Partial<DraftParam>) => void;
}) {
  const { ut } = useLang();
  const isScale = p.kind === "scale";
  const pick = <Pick checked={p.picked} label={ut("am.pickParam")} onChange={(v) => onChange({ picked: v })} />;

  /*
   * Вид параметра стоит на месте «Результат тесту» кадра: для условия по
   * шкале селект так и читается — «Результат тесту», — а два других вида
   * (флаг риска, число прохождений) сервер умеет, и прятать их значило бы,
   * что открытое правило с таким условием нельзя ни прочитать, ни сохранить.
   */
  const kind = (
    <Field label={ut("am.paramKind")} inline className="w-[190px] shrink-0">
      <Select value={p.kind} onChange={(e) => onChange({ kind: e.target.value as DraftParam["kind"] })}>
        <option value="scale">{ut("am.testResult")}</option>
        <option value="risk">{ut("am.kindRisk")}</option>
        <option value="history">{ut("am.kindHistory")}</option>
      </Select>
    </Field>
  );

  return (
    <div className="flex flex-col gap-[15px]">
      {isScale ? (
        <div className="flex items-center gap-[12px]">
          <Field label={ut("am.testName")} inline className="min-w-0 flex-1">
            <Select
              value={p.surveyId}
              style={p.surveyId ? undefined : PLACEHOLDER}
              /* смена теста сбрасывает шкалу: коды шкал у методик разные */
              onChange={(e) => onChange({ surveyId: e.target.value, scaleCode: "" })}
            >
              <option value="" disabled>
                {ut("am.testName")}
              </option>
              <option value={ANY_TEST}>{ut("am.anyTest")}</option>
              {surveys.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </Select>
          </Field>
          {pick}
        </div>
      ) : null}

      {/* вложенная строка — с отступом 55, как «Результат тесту» под «Назва тесту» на кадре */}
      <div className={cx("flex items-center gap-[12px]", isScale && "pl-[55px]")}>
        {kind}
        {isScale ? (
          <ScalePicker p={p} scales={scales} onChange={onChange} />
        ) : p.kind === "risk" ? (
          <Field label={ut("am.riskLevel")} inline className="min-w-0 flex-1">
            <Select value={p.severity} onChange={(e) => onChange({ severity: e.target.value as DraftParam["severity"] })}>
              <option value="moderate">{ut("am.riskModerate")}</option>
              <option value="severe">{ut("am.riskSevere")}</option>
            </Select>
          </Field>
        ) : (
          <Field label={ut("am.completedAtLeast")} inline className="min-w-0 flex-1">
            <Input
              type="number"
              min={0}
              max={100}
              step={1}
              value={p.completedAtLeast}
              onChange={(e) => onChange({ completedAtLeast: e.target.value })}
            />
          </Field>
        )}
        {isScale ? null : pick}
      </div>

      {isScale ? (
        /* третья строка: что сравниваем · условие словами · узкое поле порога (f27) */
        <div className="flex items-center gap-[12px] pl-[55px]">
          <Field label={ut("am.metric")} inline className="min-w-0 flex-1">
            <Select value={p.metric} onChange={(e) => onChange({ metric: e.target.value as DraftParam["metric"] })}>
              <option value="raw">{ut("am.metricRaw")}</option>
              <option value="normed">{ut("am.metricNormed")}</option>
            </Select>
          </Field>
          <Field label={ut("am.op")} inline className="w-[160px] shrink-0">
            <Select value={p.op} onChange={(e) => onChange({ op: e.target.value as DraftParam["op"] })}>
              {OPS.map((op) => (
                <option key={op} value={op}>
                  {ut(OP_KEY[op])}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={ut("am.threshold")} inline className="w-[80px] shrink-0">
            <Input type="number" step="any" value={p.value} onChange={(e) => onChange({ value: e.target.value })} />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Шкала: селект по шкалам выбранной методики; при «будь-який тест» — код
 * шкалы руками, потому что перечислять нечего (правило сверяет код в той
 * методике, которую сдали). Пока методика не выбрана, поле стоит пустым
 * силуэтом с подписью, как «Результат тесту» на кадре.
 */
function ScalePicker({
  p,
  scales,
  onChange,
}: {
  p: DraftParam;
  scales: Scale[] | undefined;
  onChange: (next: Partial<DraftParam>) => void;
}) {
  const { ut } = useLang();
  if (p.surveyId === ANY_TEST) {
    return (
      <Field label={ut("am.scaleCode")} inline className="min-w-0 flex-1">
        <Input value={p.scaleCode} maxLength={40} onChange={(e) => onChange({ scaleCode: e.target.value })} />
      </Field>
    );
  }
  const list = scales ?? [];
  /* шкала из сохранённого правила, которой у методики уже нет, остаётся видимой — иначе её потеряют молча */
  const orphan = p.scaleCode && !list.some((s) => s.code === p.scaleCode) ? p.scaleCode : null;
  return (
    <Field label={ut("am.testResult")} inline className="min-w-0 flex-1">
      <Select
        value={p.scaleCode}
        disabled={!p.surveyId}
        style={p.scaleCode ? undefined : PLACEHOLDER}
        onChange={(e) => onChange({ scaleCode: e.target.value })}
      >
        <option value="" disabled>
          {ut("am.testResult")}
        </option>
        {orphan ? <option value={orphan}>{orphan}</option> : null}
        {list.map((s) => (
          <option key={s.code} value={s.code}>
            {s.code} — {s.title}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/* ─────────── действие ─────────── */

function ActionRow({
  a,
  surveys,
  onChange,
}: {
  a: DraftAction;
  surveys: SurveyListItem[];
  onChange: (next: Partial<DraftAction>) => void;
}) {
  const { ut } = useLang();
  return (
    <div className="flex items-center gap-[12px]">
      <Field label={ut("am.actionKind")} inline className="w-[190px] shrink-0">
        <Select value={a.kind} onChange={(e) => onChange({ kind: e.target.value as DraftAction["kind"] })}>
          <option value="advise">{ut("am.actAdvise")}</option>
          <option value="notify_duty">{ut("am.actNotify")}</option>
          <option value="suggest_survey">{ut("am.actSuggest")}</option>
          {/*
           * Маршрут помощи — только у уже сохранённого действия: справочника
           * маршрутов в консоли нет, и выбрать новый неоткуда, а старый
           * должен пережить открытие и сохранение формы.
           */}
          {a.kind === "suggest_pathway" ? <option value="suggest_pathway">{ut("am.actPathway")}</option> : null}
        </Select>
      </Field>
      {a.kind === "advise" ? (
        <Field label={ut("am.adviseText")} inline className="min-w-0 flex-1">
          <Input value={a.text} maxLength={2000} onChange={(e) => onChange({ text: e.target.value })} />
        </Field>
      ) : a.kind === "suggest_survey" ? (
        <Field label={ut("am.suggestTest")} inline className="min-w-0 flex-1">
          <Select
            value={a.surveyId}
            style={a.surveyId ? undefined : PLACEHOLDER}
            onChange={(e) => onChange({ surveyId: e.target.value })}
          >
            <option value="" disabled>
              {ut("am.suggestTest")}
            </option>
            {surveys.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </Select>
        </Field>
      ) : a.kind === "suggest_pathway" ? (
        <Field label={ut("am.pathwayId")} inline className="min-w-0 flex-1">
          <Input value={a.pathwayId} onChange={(e) => onChange({ pathwayId: e.target.value })} />
        </Field>
      ) : (
        /* «повідомити чергового» параметров не имеет — место остаётся пустым, отметка на своём краю */
        <span className="min-w-0 flex-1" />
      )}
      <Pick checked={a.picked} label={ut("am.pickAction")} onChange={(v) => onChange({ picked: v })} />
    </div>
  );
}
