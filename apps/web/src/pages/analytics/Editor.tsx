import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Scale, SurveyListItem, UiKey } from "@quizzy/shared";
import { api } from "../../api";
import { useLang } from "../../lang";
import { Loading, Modal, useAction, useToast } from "../../ui";
import { cx } from "../../ui/cx";
import { IconGear } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { MenuButton, menuItemClass } from "../../ui/menu";
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
 * Аналитическая модель — кадры f19 и f25 макета, один экран.
 *
 * Два кадра — одна форма в двух состояниях: f19 — структура целиком с
 * раскрытым меню шестерёнки, f25 — та же форма с раскрытым списком выбора
 * теста поверх блоков. Взят f19 как более полный (на f25 карточки притемнены
 * и перекрыты, замерять по ним нельзя); из f25 взята только спецификация
 * раскрытого списка.
 *
 * Что на кадре и как это легло на код (все числа — замеры f19, колонка формы
 * 700 по центру кадра 1600, то есть 450…1149):
 *
 *   «Аналітика» на оси колонки формы (450)      → видимый заголовок ВНУТРИ
 *                                                  колонки, а не в строке
 *                                                  рамки Page (см. ниже)
 *   поле «Назва аналітичної моделі» 195…230     → Field/Input, подпись
 *                                                  плейсхолдером 17/400 серым
 *   «Структура» (чернила 273…290) + шестерня    → h2 20/700 + MenuButton,
 *   1125…1149 у правого края колонки               плашка от левого края
 *                                                  шестерни вправо
 *   рамка карточки 450…1149, линия #666666      → карточка условий, поле 20
 *                                                  слева, 10 справа под
 *                                                  квадратик отметки
 *   «Назва тесту» 470…1109 + квадратик          → свой список тестов + Pick
 *   1120…1139
 *   «Результат тесту» 525…1109 (отступ 55)      → строка условия: открывает
 *                                                  окно «Результат тесту»
 *   «Разом з» 1030…1109 между параметрами       → чип, оператор «и»
 *   «Додати правило» 960…1109 внутри карточки   → новый параметр
 *
 * Чего кадр рисует, а здесь нет, — и это граница сервера, а не пропуск
 * (правило поддержки решений, packages/shared/src/rules.ts):
 *
 *   · второй блок и чип «Або» между блоками (f19: карточка 754…926 и чип
 *     1070…1149): условия правила соединяются только «и» — evaluateRules
 *     требует every(met), уровня блоков у правила нет. Нарисовать «Або»,
 *     который на сервере станет «и», значило бы молча подменить смысл
 *     модели;
 *   · нижняя кнопка «Додати правило» (999…1148): она добавляет БЛОК, а
 *     блоков нет — вторая такая же кнопка добавляла бы то же, что
 *     внутрикарточная, и читалась бы как другое действие;
 *   · параметр «Питання / Відповідь / Час реакції» (f19, вторая половина
 *     первой карточки): условий по отдельному ответу и по времени реакции в
 *     правиле нет вовсе (RuleCondition — только scale, risk, history).
 *
 * Пункты «Додати Оператор» и «Об’єднати» при этом на экране ЕСТЬ: они
 * нарисованы на кадре, и меню без них читалось бы как поломанное. Они стоят
 * недоступными с подсказкой о причине — так же, как недоступный пункт меню
 * карточки в каталоге (см. ActionMenu в ui/menu.tsx).
 *
 * Чего на кадре нет, а здесь есть, — и почему:
 *   · окно «Про модель» шестым пунктом меню: за ним описание модели (его
 *     печатает перечень f10 второй колонкой, а вводить его больше негде) и
 *     выключатель модели. Единственная добавка к пяти пунктам кадра;
 *   · окно за строкой параметра: его вид, а для условия по шкале — ещё
 *     шкала, что сравниваем, условие и порог. На кадре строка одна, а
 *     правилу нужны все четыре значения; вид же обязан меняться и после
 *     добавления — иначе строку пришлось бы удалять и заводить заново,
 *     теряя вместе с ней заполненное;
 *   · окно «Додати Параметр» с выбором вида: кадр рисует только условие по
 *     шкале, а правило умеет ещё флаг риска и число прохождений, и открытую
 *     модель с таким условием иначе нельзя было бы ни прочитать, ни сохранить;
 *   · карточка действий: сервер не принимает правило без действия
 *     (ruleSchema, min(1)), а «Додати Дію» стоит в меню шестерёнки на самом
 *     кадре — значит, действия задумывались, только нарисовать их не успели.
 *     Ни заголовка «Дії», ни пустой рамки, ни второй кнопки у неё нет: на
 *     кадре после структуры чистый лист;
 *   · кнопка «Зберегти» — форма без сохранения не форма. Вид и размер —
 *     кнопка формы макета (45px, 22/700), правый край по 1149.
 *
 * Заголовок стоит ВНУТРИ колонки формы, а не в строке рамки Page: на кадре
 * чернила «Аналітика» начинаются на 450, то есть на оси колонки 700, а не
 * колонки 1200 (там было бы 200). Рамке он отдан скрытым (`titleHidden`) —
 * диктор и поиск по странице ищут экран по <h1>, и порядок заголовков обязан
 * начинаться с первого.
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

/**
 * Методика, дочитанная целиком ради шкал и названия; null — сервер её не
 * отдал: она вне групп сотрудника или её уже нет.
 */
type LoadedSurvey = { title: string; archivedAt: string | null; scales: Scale[] } | null;

/* Силуэт поля кадра: 36 высотой, радиус 5, рамка #666666 — для строк, которые полем не являются */
const FIELD_SHELL =
  "flex h-9 w-full items-center rounded-[5px] border border-field-border bg-[var(--bg)] px-[10px] text-left text-[17px]";
/* Обводка фокуса для тех же строк: у <button> её нет там, где нет рамки браузера */
const FIELD_FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]";

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
   * Методики целиком — по требованию и один раз: выбранные в параметрах
   * (ради шкал — в SurveyListItem их нет) и стоящие в действиях, но
   * отсутствующие в коротком списке (ради названия — см. SurveyOptions).
   * Грузить все методики ради селекта шкал — это сотня запросов при открытии
   * формы; грузятся только нужные, и только когда понадобились.
   *
   * Отказ запоминается как null, а не пропускается: чужую или удалённую
   * методику сервер не отдаст и со второго раза, а без записи об отказе она
   * запрашивалась бы заново на каждой перерисовке.
   */
  const [loaded, setLoaded] = useState<Record<string, LoadedSurvey>>({});
  const inFlight = useRef(new Set<string>());
  const wanted = draft && surveys.data ? surveysToLoad(draft, new Set(surveys.data.map((s) => s.id))).join(",") : "";
  useEffect(() => {
    for (const surveyId of wanted.split(",").filter(Boolean)) {
      if (surveyId in loaded || inFlight.current.has(surveyId)) continue;
      inFlight.current.add(surveyId);
      void api
        .survey(surveyId)
        .then((s) =>
          setLoaded((prev) => ({ ...prev, [surveyId]: { title: s.title, archivedAt: s.archivedAt ?? null, scales: s.scales } })),
        )
        .catch(() => setLoaded((prev) => ({ ...prev, [surveyId]: null })))
        .finally(() => inFlight.current.delete(surveyId));
    }
  }, [wanted, loaded]);

  /*
   * Ключи словаря, а не готовые строки: переводятся при печати. Готовые
   * строки после неудачной попытки сохранить оставались бы на прежнем языке
   * до следующего нажатия «Зберегти», хотя весь экран уже переключился.
   */
  const [errors, setErrors] = useState<UiKey[]>([]);

  /*
   * Три окна — три состояния, а не одно с видом внутри: «Про модель»
   * открывается из меню, «Додати Параметр» — тоже, а окно условия привязано
   * к строке и помнит, к какой именно (ключ параметра).
   */
  const [about, setAbout] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

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
    const errs = validateDraft(draft);
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
  const edited = draft.params.find((p) => p.key === editing) ?? null;

  return (
    /*
     * `snug tight`: 40 от полосы шапки до содержимого и ни пикселя ниже —
     * замер f19 (коробка заголовка 140…170 при полосе 0…99). Заголовок отдан
     * рамке скрытым, а видимый напечатан внутри колонки формы, на её оси.
     */
    <Page title={ut("top.analytics")} titleHidden snug tight>
      <div className="mx-auto w-full max-w-[700px]">
        {/*
          Видимый заголовок 24/700 фиолетовым. Не второй <h1>: имя экрана уже
          объявлено скрытым заголовком рамки ровно этими же словами, и второй
          заголовок диктор прочитал бы дважды, а порядок заголовков получил бы
          два первых уровня подряд.

          Строка заголовка 36 высотой, текст в ней по центру — как в строке
          заголовка перечня. Иначе не сходятся чернила: содержимое начинается
          на 140, а капитель «А» на обоих кадрах стоит на 147 (f10: 147…163,
          f19: 147…163 — при засечках «і» на 147…149 и основной массе с 151).
          Голый <p> с leading-tight даёт коробку 140…170 и чернила примерно с
          144 — те же 24/700 попадают на 147 только внутри строки 36.
        */}
        <p aria-hidden className="m-0 flex h-9 items-center text-[24px] font-bold leading-tight text-primary">
          {ut("top.analytics")}
        </p>

        {/* 19 от строки заголовка до поля — замер f19 (низ строки 176, верх поля 195) */}
        <div className="mt-[19px]">
          <Field label={ut("am.modelName")} inline>
            <Input
              ph="plain"
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              maxLength={200}
            />
          </Field>
        </div>

        {/* 40 от низа поля до коробки h2 — замер f19 (231 → 270) */}
        <section aria-labelledby="am-structure" className="mt-[40px]">
          {/* «Структура» слева, шестерёнка у правого края колонки — как на кадре */}
          <div className="flex items-center justify-between">
            {/*
              20/700 — замер f19: капитель «С» занимает 273…286 (14 при
              отношении 0,708 → 19,8; ниже 287…290 — выносные «р» и «у»), а
              чернила 451…543 дают 93 на девять знаков против 18-го кегля,
              которым это было бы ≈84.
            */}
            <h2 id="am-structure" className="m-0 text-[20px] font-bold leading-tight text-primary">
              {ut("am.structure")}
            </h2>
            {/*
              Плашка (align="right-out") висит под шестерней и уходит вправо
              от колонки формы: на кадре её левый край 1125 совпадает с ЛЕВЫМ
              краем шестерни (чернила 1125…1149), а правый — 1283, то есть
              ширина 159. Порядок пунктов — с кадра, дословно.
            */}
            <MenuButton label={ut("am.structureMenu")} glyph={<IconGear />} align="right-out">
              {(close) => (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItemClass("right-out")}
                    onClick={() => {
                      close();
                      patch({ actions: [...draft.actions, newAction()] });
                    }}
                  >
                    {ut("am.addAction")}
                  </button>
                  {/*
                    Оператор между блоками и объединение блоков: пункты с
                    кадра, оба сейчас недоступны — уровня блоков у правила
                    нет (см. шапку файла). Остаются в меню с aria-disabled и
                    подсказкой о причине: пропавший пункт читался бы как
                    поломка меню, а молча не срабатывающий — как поломка
                    модели.
                  */}
                  <button
                    type="button"
                    role="menuitem"
                    aria-disabled
                    title={ut("am.operatorOnlyAnd")}
                    className={menuItemClass("right-out", "disabled")}
                  >
                    {ut("am.addOperator")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItemClass("right-out")}
                    onClick={() => {
                      close();
                      setAdding(true);
                    }}
                  >
                    {ut("am.addParam")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    aria-disabled
                    title={ut("am.mergeUnavailable")}
                    className={menuItemClass("right-out", "disabled")}
                  >
                    {ut("am.merge")}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItemClass("right-out")}
                    onClick={() => {
                      close();
                      removePicked();
                    }}
                  >
                    {ut("am.deleteSelected")}
                  </button>
                  {/* единственная добавка к пяти пунктам кадра: описание модели и выключатель */}
                  <button
                    type="button"
                    role="menuitem"
                    className={menuItemClass("right-out")}
                    onClick={() => {
                      close();
                      setAbout(true);
                    }}
                  >
                    {ut("am.about")}
                  </button>
                </>
              )}
            </MenuButton>
          </div>

          {/*
            Карточка условий: рамка #666666 (замер f19 — 102,102,102 по всем
            четырём сторонам), радиус 5, 9 от коробки шестерни до рамки
            (297 → 306). Поле слева 20, справа 10: справа зарезервирована
            колонка квадратика отметки (поле кончается на 1109, квадратик
            1120…1139, рамка 1149). Между строками 15: вместе с полем 36 это
            шаг 51, ритм формы макета.
          */}
          <div className="mt-[9px] flex flex-col gap-[15px] rounded-[5px] border border-field-border py-[20px] pl-[20px] pr-[10px]">
            {draft.params.map((p, i) => (
              <Fragment key={p.key}>
                {i > 0 ? (
                  /*
                    «Разом з» — чип 80×36 у правого края поля (1030…1109),
                    рамка #666666, текст 17/400 серым. Не кнопка: оператор в
                    правиле один, переключать нечего. Читается диктором как
                    текст между параметрами — так и задумано, это и есть
                    смысл строки.
                  */
                  <div className="flex justify-end pr-[30px]">
                    {/*
                      Ширина чипа 80 — замер f19: рамки 1030 и 1109 по
                      горизонтали, 428 и 463 по вертикали, чернила 1042…1098
                      (57). То есть поля по 11, а не 14: при 14 чип выходил
                      бы ≈87 и уползал влево от правого края поля, который на
                      кадре стоит.

                      `min-w` с центровкой, а не жёсткие 80: перевод («Вместе
                      с») длиннее украинского, и фиксированная ширина резала
                      бы слово.
                    */}
                    <span
                      className={cx(
                        "inline-flex h-9 min-w-[80px] items-center justify-center rounded-[5px]",
                        "border border-field-border px-[10px] text-[17px] text-muted",
                      )}
                    >
                      {ut("am.together")}
                    </span>
                  </div>
                ) : null}
                <ParamRow
                  p={p}
                  surveys={surveyList}
                  loaded={loaded}
                  onChange={(next) => patchParam(p.key, next)}
                  onOpenCondition={() => setEditing(p.key)}
                />
              </Fragment>
            ))}
            {/*
              Кнопка карточки добавляет условие по шкале — тот вид, который и
              нарисован на кадре. Остальные виды лежат в окне «Додати
              Параметр» меню шестерёнки: частый случай — одно нажатие, редкий
              — через выбор вида.
            */}
            <div className="flex justify-end pr-[30px]">
              {/* size="card": 36 высотой и 17/700 — замер заливки f19, см. sizes в primitives.tsx */}
              <Button size="card" onClick={() => patch({ params: [...draft.params, newParam()] })}>
                {ut("am.addRule")}
              </Button>
            </div>
          </div>

          {/*
            Действия — такой же карточкой в той же стопке, шаг 15. Заголовка
            у неё нет: на кадре после структуры чистый лист, а добавляют
            действие единственным входом — пунктом «Додати Дію» меню
            шестерёнки, который на кадре и нарисован.
          */}
          {draft.actions.length ? (
            <div className="mt-[15px] flex flex-col gap-[15px] rounded-[5px] border border-field-border py-[20px] pl-[20px] pr-[10px]">
              {draft.actions.map((a) => (
                <ActionRow
                  key={a.key}
                  a={a}
                  surveys={surveyList}
                  loaded={loaded}
                  onChange={(next) => patchAction(a.key, next)}
                />
              ))}
            </div>
          ) : null}
        </section>

        {errors.length ? (
          /*
            role="alert" — на обёртке, а не на самом <ul>: роль alert замещает
            роль list, и диктор объявил бы текст, но перестал бы сообщать
            «список из N элементов». Обёртка сохраняет и объявление, и перечень.
          */
          <div role="alert">
            <ul className="m-0 mt-[20px] list-none p-0 text-[13px] leading-[19px] text-danger">
              {errors.map((k) => (
                <li key={k}>{ut(k)}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-[30px] flex justify-end">
          <Button size="md" disabled={busy} onClick={save}>
            {ut("common.save")}
          </Button>
        </div>
      </div>

      {about ? (
        <AboutModel
          draft={draft}
          onChange={patch}
          onClose={() => setAbout(false)}
        />
      ) : null}
      {adding ? (
        <AddParam
          onPick={(over) => {
            patch({ params: [...draft.params, newParam(over)] });
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {edited ? (
        <ConditionWindow
          p={edited}
          scales={edited.surveyId && edited.surveyId !== ANY_TEST ? loaded[edited.surveyId]?.scales : undefined}
          onChange={(next) => patchParam(edited.key, next)}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </Page>
  );
}

/* ─────────── параметр ─────────── */

/**
 * Квадратик отметки справа от «Назва тесту» — 20×20, замер f19 (рамка
 * 1120…1139, у отмеченного заливка 1124…1136, то есть 12×12 внутри);
 * отмеченный залит фиолетовым внутри рамки, как на кадре (не галочка
 * браузера).
 *
 * Сам флажок — настоящий <input type="checkbox">, скрытый визуально: диктор
 * и клавиатура получают штатный флажок, глаз — квадрат макета. Область
 * нажатия дорисована псевдоэлементом, как у глифов (см. Button
 * size="glyph"): отступами она раздвинула бы зазор 10 до поля.
 *
 * Но не квадратом 44: 44 по центру квадратика 20 вылезает на 12 в каждую
 * сторону, а слева до поля всего 10 — последние 2px правого края поля (и
 * кнопки выбора теста внутри него) доставались бы флажку. Поэтому по
 * горизонтали накладка растянута на 36 (по 8 в сторону — на 2 меньше
 * зазора, то есть чужого края не касается), по вертикали на 44: строки
 * стоят шагом 51 при высоте 36, между ними 15, и 4 выноса сверху и снизу
 * не дотягиваются даже до соседней строки. 36×44 — это по-прежнему выше
 * порога 2.5.8 (24) и вдвое больше самого квадратика.
 */
function Pick({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label
      className={cx(
        "relative inline-flex size-[20px] shrink-0 cursor-pointer items-center justify-center",
        "after:absolute after:left-1/2 after:top-1/2 after:h-[44px] after:w-[36px] after:content-['']",
        "after:-translate-x-1/2 after:-translate-y-1/2",
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

/**
 * Опции селекта методик: список api.surveys() и — если выбранной в нём нет —
 * она сама, отдельной опцией впереди.
 *
 * Список не отдаёт снятые с использования (GET /api/surveys без ?archived=1)
 * и методики вне групп сотрудника, а в сохранённом правиле такой
 * идентификатор — обычное дело: модель пережила методику. Без своей опции
 * контролируемый <select> не совпадает ни с одной и рисуется пустым, а при
 * сохранении идентификатор уходит на сервер молча — та же ловушка, что у
 * шкалы-сироты в ConditionWindow. Подпись — название с пометкой «знято з
 * використання», когда методику удалось дочитать (GET /api/surveys/:id
 * снятые отдаёт), и «недоступний», когда сервер отказал: чужая группа или
 * методики уже нет. Показывать голый идентификатор, как у шкалы, нельзя:
 * код шкалы человек узнаёт, uuid — нет.
 */
export function SurveyOptions({
  surveys,
  current,
  loaded,
}: {
  surveys: SurveyListItem[];
  /** Значение селекта: "", ANY_TEST или идентификатор методики */
  current: string;
  loaded: Record<string, LoadedSurvey>;
}) {
  const { ut } = useLang();
  const orphan = current && current !== ANY_TEST && !surveys.some((s) => s.id === current) ? current : null;
  return (
    <>
      {orphan ? <option value={orphan}>{surveyLabel(ut, loaded, orphan)}</option> : null}
      {surveys.map((s) => (
        <option key={s.id} value={s.id}>
          {s.title}
        </option>
      ))}
    </>
  );
}

/** Подпись методики, которой нет в коротком списке: название, пометка или отказ сервера */
function surveyLabel(ut: (k: UiKey) => string, loaded: Record<string, LoadedSurvey>, id: string): string {
  const meta = loaded[id];
  if (meta === undefined) return ut("common.loading");
  if (meta === null) return ut("am.testUnavailable");
  return meta.archivedAt ? `${meta.title} (${ut("mark.retired")})` : meta.title;
}

/**
 * Выбор теста — собственный раскрывающийся список, а не <select>.
 *
 * Кадр f25 задаёт его целиком, и штатным списком ОС ни одного из этих чисел
 * не задать: панель 470…1109 × 326…999 — ровно по рамке поля и от его
 * верхнего края вниз, рамка #666666, радиус 5, пункты 17/700 фиолетовым с
 * шагом 30, текст в 13 от левого края, своя полоса прокрутки с ползунком
 * #999999 (--polsy-edge, замер: 1100…1104).
 *
 * Поле 11 сверху — единственное число этой панели, которого кадр НЕ даёт, и
 * менять его не на что. Список на f25 прокручен: ползунок стоит на 442…599
 * при дорожке 326…999, то есть примерно на 22% пути, а не у края. Значит
 * расстояние «верх панели → первые чернила» (11) — это остаток прокрутки, а
 * не поле, и ровно так же не поле — любое другое число, которое из него
 * выведут: 22 пункта шагом 30 (660) внутри 672 не закрепляют ни 7, ни 11,
 * пока положение прокрутки свободно. Оставлено 11 как есть; закрыть этот
 * замер сможет только кадр с нераскрученным списком.
 *
 * Что обещает клавиатуре и диктору: role="combobox" с aria-expanded и
 * aria-controls, role="listbox"/"option" внутри, обход стрелками, Home,
 * End, выбор по Enter и пробелу, Esc и Tab закрывают, подсвеченный пункт
 * назван через aria-activedescendant, выбранный помечен aria-selected.
 * Фокус остаётся на самом поле — панель закрывает его собой, как на кадре, и
 * уводить фокус под неё некуда.
 *
 * Высота пункта 30, а не 44: область нажатия, дорисованная до 44 при шаге
 * 30, перекрывала бы соседние пункты на 7 сверху и снизу — промах выбрал бы
 * ЧУЖОЙ тест, то есть лечение оказалось бы опаснее болезни (у глифов
 * перекрытие безобидно: рядом с ними либо ничего, либо соседняя стрелка
 * страницы). 30 берёт порог 2.5.8 (24px) и совпадает с кадром.
 */
export function TestPicker({
  value,
  surveys,
  loaded,
  onChange,
}: {
  value: string;
  surveys: SurveyListItem[];
  loaded: Record<string, LoadedSurvey>;
  onChange: (id: string) => void;
}) {
  const { ut } = useLang();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const panel = useRef<HTMLDivElement>(null);

  const orphan = value && value !== ANY_TEST && !surveys.some((s) => s.id === value) ? value : null;
  const items: { id: string; title: string }[] = orphan
    ? [{ id: orphan, title: surveyLabel(ut, loaded, orphan) }, ...surveys.map((s) => ({ id: s.id, title: s.title }))]
    : surveys.map((s) => ({ id: s.id, title: s.title }));

  /* подсвеченный пункт при раскрытии — текущий выбор, а не первый в списке */
  const show = () => {
    const i = items.findIndex((it) => it.id === value);
    setAt(i < 0 ? 0 : i);
    setOpen(true);
  };

  /* подсвеченный пункт держим в виду: обход стрелками уходит за край панели */
  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>('[data-at="1"]')?.scrollIntoView({ block: "nearest" });
  }, [open, at]);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape" || e.key === "Tab") {
      /* Tab не гасим: он уходит дальше по форме, но список за собой закрывает */
      if (e.key === "Escape") e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const it = items[at];
      if (it) choose(it.id);
      return;
    }
    const next =
      e.key === "ArrowDown"
        ? at + 1
        : e.key === "ArrowUp"
          ? at - 1
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? items.length - 1
              : null;
    if (next === null) return;
    e.preventDefault();
    setAt(Math.max(0, Math.min(items.length - 1, next)));
  };

  const chosen =
    value === "" ? null : value === ANY_TEST ? ut("am.anyTest") : (surveys.find((s) => s.id === value)?.title ?? surveyLabel(ut, loaded, value));

  return (
    <div className="relative min-w-0 flex-1">
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={open ? `${id}-${at}` : undefined}
        aria-label={ut("am.testName")}
        className={cx(FIELD_SHELL, "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]")}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        {/* пустое поле — подпись внутри него, 17/400 серым, как на кадре */}
        <span className={cx("truncate", chosen ? "text-text" : "text-muted")}>{chosen ?? ut("am.testName")}</span>
      </button>
      {open ? (
        <>
          {/* подложка: нажатие мимо панели закрывает список, а не попадает в поле под ним */}
          <div aria-hidden onClick={() => setOpen(false)} className="fixed inset-0 z-40" />
          <div
            ref={panel}
            id={id}
            role="listbox"
            aria-label={ut("am.testName")}
            className={cx(
              "absolute left-0 top-0 z-50 max-h-[674px] w-full overflow-y-auto rounded-[5px]",
              "border border-field-border bg-[var(--bg)] py-[11px] shadow-pop",
              "[scrollbar-color:var(--polsy-edge)_transparent] [scrollbar-width:thin]",
            )}
          >
            {items.length === 0 ? (
              <p className="m-0 px-[13px] text-[17px] text-muted">{ut("am.noTests")}</p>
            ) : (
              items.map((it, i) => (
                <div
                  key={it.id}
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={it.id === value}
                  data-at={i === at ? "1" : undefined}
                  onClick={() => choose(it.id)}
                  className={cx(
                    "flex h-[30px] cursor-pointer items-center px-[13px] text-[17px] font-bold text-primary",
                    i === at && "bg-primary-tint",
                  )}
                >
                  <span className="truncate">{it.title}</span>
                </div>
              ))
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

function ParamRow({
  p,
  surveys,
  loaded,
  onChange,
  onOpenCondition,
}: {
  p: DraftParam;
  surveys: SurveyListItem[];
  loaded: Record<string, LoadedSurvey>;
  onChange: (next: Partial<DraftParam>) => void;
  onOpenCondition: () => void;
}) {
  const { ut } = useLang();
  const isScale = p.kind === "scale";
  const pick = <Pick checked={p.picked} label={ut("am.pickParam")} onChange={(v) => onChange({ picked: v })} />;

  if (!isScale) {
    /*
     * Флаг риска и число прохождений кадр не рисует вовсе (там только
     * условие по шкале), но сервер их умеет, и открытая модель с таким
     * условием обязана читаться и сохраняться. Рисуются тем же силуэтом,
     * что и строка условия кадра: поле 36, рамка #666666, значение словами
     * внутри, а сами поля — в окне за строкой. Так вид параметра меняется
     * из любой строки, а не только из строки со шкалой.
     */
    const said = paramText(ut, p, loaded);
    return (
      <div className="flex items-center gap-[10px]">
        <div className="flex min-w-0 flex-1">
          <button
            type="button"
            aria-label={`${ut(PARAM_PICK_KEY[paramPick(p)])}: ${said}`}
            onClick={onOpenCondition}
            className={cx(FIELD_SHELL, FIELD_FOCUS)}
          >
            <span className="truncate text-text">{said}</span>
          </button>
        </div>
        {pick}
      </div>
    );
  }

  /*
   * Строка условия: на кадре это одно поле «Результат тесту» 525…1109 с
   * отступом 55 от внутреннего края карточки. Шкала, что сравниваем,
   * условие и порог правилу нужны все четыре, а поле на кадре одно —
   * поэтому строка открывает окно, а показывает собранное условие словами.
   * Имя для диктора начинается с видимой подписи (WCAG 2.5.3): управляющий
   * голосом попадает по тому, что читает глазами.
   */
  const condition = conditionText(ut, p, loaded);

  return (
    <div className="flex flex-col gap-[15px]">
      <div className="flex items-center gap-[10px]">
        <TestPicker
          value={p.surveyId}
          surveys={surveys}
          loaded={loaded}
          /* смена теста сбрасывает шкалу: коды шкал у методик разные */
          onChange={(v) => onChange({ surveyId: v, scaleCode: "" })}
        />
        {pick}
      </div>
      <div className="flex pl-[55px] pr-[30px]">
        <button
          type="button"
          aria-label={condition ? `${ut("am.testResult")}: ${condition}` : ut("am.testResult")}
          onClick={onOpenCondition}
          className={cx(FIELD_SHELL, FIELD_FOCUS)}
        >
          <span className={cx("truncate", condition ? "text-text" : "text-muted")}>
            {condition || ut("am.testResult")}
          </span>
        </button>
      </div>
    </div>
  );
}

/**
 * Вид параметра одним значением — тем, каким его выбирают и человек, и код.
 *
 * «Будь-який тест» — не отдельный вид условия: сервер держит его как то же
 * условие по шкале с surveyId: null (см. ANY_TEST в model.ts). Но выбирают
 * его наравне с остальными видами, поэтому здесь четыре значения, а не три:
 * иначе «будь-який тест» пришлось бы задавать двумя полями подряд, а
 * вернуться к нему — нечем (ровно это и вышло у первой редакции: методику в
 * строке меняли через список тестов, а пункта «Будь-який тест» в списке нет,
 * и обратной дороги не было).
 */
export type ParamPick = "scale" | "any" | "risk" | "history";

export const PARAM_PICKS: readonly ParamPick[] = ["scale", "any", "risk", "history"];

export const PARAM_PICK_KEY: Record<ParamPick, UiKey> = {
  scale: "am.testResult",
  any: "am.anyTest",
  risk: "am.kindRisk",
  history: "am.kindHistory",
};

export function paramPick(p: DraftParam): ParamPick {
  if (p.kind === "risk") return "risk";
  if (p.kind === "history") return "history";
  return p.surveyId === ANY_TEST ? "any" : "scale";
}

/**
 * Смена вида уже заведённого параметра.
 *
 * Возвращает ровно то, что меняется, и НЕ трогает остального: строка,
 * переведённая на флаг риска и обратно, возвращается со своей шкалой,
 * условием и порогом. Сбрасывается только то, что после смены заведомо
 * бессмысленно: методика при переходе на «будь-який тест» и обратно (это
 * разные вопросы — «какой тест» и «любой»), а вместе с ней код шкалы,
 * потому что коды у методик свои.
 */
export function paramKindOver(p: DraftParam, next: ParamPick): Partial<DraftParam> {
  const now = paramPick(p);
  if (now === next) return {};
  switch (next) {
    case "risk":
      return { kind: "risk" };
    case "history":
      return { kind: "history" };
    case "any":
      return { kind: "scale", surveyId: ANY_TEST, scaleCode: now === "scale" ? "" : p.scaleCode };
    case "scale":
      return now === "any" ? { kind: "scale", surveyId: "", scaleCode: "" } : { kind: "scale" };
  }
}

/** Что строка параметра говорит о себе, когда её поля убраны в окно */
function paramText(ut: (k: UiKey) => string, p: DraftParam, loaded: Record<string, LoadedSurvey>): string {
  const name = ut(PARAM_PICK_KEY[paramPick(p)]);
  if (p.kind === "risk") return `${name} · ${ut(p.severity === "severe" ? "am.riskSevere" : "am.riskModerate")}`;
  if (p.kind === "history") return `${name} · ${p.completedAtLeast}`;
  const condition = conditionText(ut, p, loaded);
  return condition ? `${name} · ${condition}` : name;
}

/** Условие по шкале словами: «Тривога · Не менше 12 · Сирий бал»; пусто — шкала не выбрана */
function conditionText(
  ut: (k: UiKey) => string,
  p: DraftParam,
  loaded: Record<string, LoadedSurvey>,
): string {
  if (!p.scaleCode) return "";
  const scales = p.surveyId && p.surveyId !== ANY_TEST ? loaded[p.surveyId]?.scales : undefined;
  const scale = scales?.find((s) => s.code === p.scaleCode);
  const name = scale ? `${scale.code} — ${scale.title}` : p.scaleCode;
  const metric = ut(p.metric === "raw" ? "am.metricRaw" : "am.metricNormed");
  return `${name} · ${ut(OP_KEY[p.op])} ${p.value} · ${metric}`;
}

/**
 * Окно параметра: его вид и поля этого вида.
 *
 * Своим окном, а не рядами полей в карточке: кадры раздела (и f19, и f25)
 * таких рядов не показывают ни в одной карточке — после «Результат тесту»
 * идёт сразу чип или кнопка. Убрать их с глаз, не потеряв, можно только
 * сюда: без порога и условия правило не срабатывает ни разу, а без смены
 * вида заведённый параметр остаётся тем, чем родился.
 *
 * Открывает его ЛЮБАЯ строка параметра: и та, что нарисована на кадре
 * (условие по шкале), и две, которых кадр не рисует (флаг риска, число
 * прохождений). Заголовок окна — имя вида, поэтому меняется вместе с ним.
 */
function ConditionWindow({
  p,
  scales,
  onChange,
  onClose,
}: {
  p: DraftParam;
  scales: Scale[] | undefined;
  onChange: (next: Partial<DraftParam>) => void;
  onClose: () => void;
}) {
  const { ut } = useLang();
  const list = scales ?? [];
  /* шкала из сохранённого правила, которой у методики уже нет, остаётся видимой — иначе её потеряют молча */
  const orphan = p.scaleCode && !list.some((s) => s.code === p.scaleCode) ? p.scaleCode : null;
  const kind = paramPick(p);

  return (
    <Modal title={ut(PARAM_PICK_KEY[kind])} onClose={onClose}>
      <div className="flex flex-col">
        {/*
          Вид параметра — здесь, а не на форме: кадр f19 рисует в карточке
          одно поле «Результат тесту», второго поля рядом с ним нет. Но
          заведённый параметр обязан менять вид, а не только рождаться с ним:
          окно «Додати Параметр» задаёт вид один раз, и без этого селекта
          строку пришлось бы удалять и заводить заново, теряя вместе с ней
          шкалу, условие и порог. Само окно открывает ЛЮБАЯ строка
          параметра — и та, что на кадре, и те два вида, которых кадр не
          рисует.
        */}
        <Field label={ut("am.paramKind")}>
          <Select value={kind} onChange={(e) => onChange(paramKindOver(p, e.target.value as ParamPick))}>
            {PARAM_PICKS.map((k) => (
              <option key={k} value={k}>
                {ut(PARAM_PICK_KEY[k])}
              </option>
            ))}
          </Select>
        </Field>
        {kind === "risk" ? (
          <Field label={ut("am.riskLevel")}>
            <Select
              value={p.severity}
              onChange={(e) => onChange({ severity: e.target.value as DraftParam["severity"] })}
            >
              <option value="moderate">{ut("am.riskModerate")}</option>
              <option value="severe">{ut("am.riskSevere")}</option>
            </Select>
          </Field>
        ) : kind === "history" ? (
          <Field label={ut("am.completedAtLeast")}>
            <Input
              type="number"
              min={0}
              max={100}
              step={1}
              value={p.completedAtLeast}
              onChange={(e) => onChange({ completedAtLeast: e.target.value })}
            />
          </Field>
        ) : (
          <ScaleCondFields p={p} list={list} orphan={orphan} onChange={onChange} />
        )}
        <div className="mt-[15px] flex justify-end">
          <Button onClick={onClose}>{ut("common.close")}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Четыре поля условия по шкале: сама шкала (или её код), что сравниваем, условие и порог */
function ScaleCondFields({
  p,
  list,
  orphan,
  onChange,
}: {
  p: DraftParam;
  list: Scale[];
  orphan: string | null;
  onChange: (next: Partial<DraftParam>) => void;
}) {
  const { ut } = useLang();
  return (
    <>
      {p.surveyId === ANY_TEST ? (
        /* «будь-який тест»: перечислять нечего — правило сверяет код в той методике, которую сдали */
        <Field label={ut("am.scaleCode")}>
          <Input value={p.scaleCode} maxLength={40} onChange={(e) => onChange({ scaleCode: e.target.value })} />
        </Field>
      ) : (
        <Field label={ut("am.scale")}>
          <Select value={p.scaleCode} disabled={!p.surveyId} onChange={(e) => onChange({ scaleCode: e.target.value })}>
            <option value="" disabled>
              {ut("am.scale")}
            </option>
            {orphan ? <option value={orphan}>{orphan}</option> : null}
            {list.map((s) => (
              <option key={s.code} value={s.code}>
                {s.code} — {s.title}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={ut("am.metric")}>
        <Select value={p.metric} onChange={(e) => onChange({ metric: e.target.value as DraftParam["metric"] })}>
          <option value="raw">{ut("am.metricRaw")}</option>
          <option value="normed">{ut("am.metricNormed")}</option>
        </Select>
      </Field>
      <Field label={ut("am.op")}>
        <Select value={p.op} onChange={(e) => onChange({ op: e.target.value as DraftParam["op"] })}>
          {OPS.map((op) => (
            <option key={op} value={op}>
              {ut(OP_KEY[op])}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={ut("am.threshold")}>
        <Input type="number" step="any" value={p.value} onChange={(e) => onChange({ value: e.target.value })} />
      </Field>
    </>
  );
}

/**
 * Окно «Додати Параметр»: вид условия выбирают при добавлении.
 *
 * На кадре видов нет вовсе — там один вид, условие по шкале, и второго
 * поля «Вид параметра» в ряду тоже нет. Поэтому вид при добавлении выбирают
 * здесь, а у заведённой строки его меняет окно за самой строкой (селект
 * «Вид параметра» в ConditionWindow): удалять и заводить заново, теряя
 * шкалу, условие и порог, человека заставлять нельзя.
 */
function AddParam({
  onPick,
  onClose,
}: {
  onPick: (over: Partial<DraftParam>) => void;
  onClose: () => void;
}) {
  const { ut } = useLang();
  /* Тот же список видов, что и в селекте окна строки: два места, где виды расходятся, — два разных продукта */
  return (
    <Modal title={ut("am.addParam")} onClose={onClose}>
      <div className="flex flex-col gap-[10px]" role="group" aria-label={ut("am.paramKind")}>
        {PARAM_PICKS.map((k) => (
          <Button key={k} variant="ghost" onClick={() => onPick(paramKindOver(newParam(), k))}>
            {ut(PARAM_PICK_KEY[k])}
          </Button>
        ))}
      </div>
    </Modal>
  );
}

/**
 * Окно «Про модель»: описание и выключатель.
 *
 * Обоего на кадрах раздела нет, а без них раздел не работает: описание
 * печатает перечень (f10) второй колонкой, и вводить его больше негде, а
 * выключенная модель, которую нельзя включить обратно, — ловушка. Убраны с
 * глаз одним окном, чтобы не заводить на форме двух полей, которых кадр не
 * рисует.
 */
function AboutModel({
  draft,
  onChange,
  onClose,
}: {
  draft: ModelDraft;
  onChange: (next: Partial<ModelDraft>) => void;
  onClose: () => void;
}) {
  const { ut } = useLang();
  return (
    <Modal title={ut("am.about")} onClose={onClose}>
      <div className="flex flex-col">
        <Field label={ut("am.modelNote")}>
          <Textarea rows={4} value={draft.note} onChange={(e) => onChange({ note: e.target.value })} maxLength={2000} />
        </Field>
        {!draft.enabled ? (
          <p className="m-0 mb-[15px] text-[13px] leading-[19px] text-muted">{ut("am.disabledNote")}</p>
        ) : null}
        <div className="flex justify-end gap-[14px]">
          <Button variant="ghost" onClick={() => onChange({ enabled: !draft.enabled })}>
            {draft.enabled ? ut("am.disable") : ut("am.enable")}
          </Button>
          <Button onClick={onClose}>{ut("common.close")}</Button>
        </div>
      </div>
    </Modal>
  );
}

/* ─────────── действие ─────────── */

function ActionRow({
  a,
  surveys,
  loaded,
  onChange,
}: {
  a: DraftAction;
  surveys: SurveyListItem[];
  loaded: Record<string, LoadedSurvey>;
  onChange: (next: Partial<DraftAction>) => void;
}) {
  const { ut } = useLang();
  return (
    <div className="flex items-center gap-[10px]">
      <Field label={ut("am.actionKind")} inline className="w-[190px] shrink-0">
        <Select ph="plain" value={a.kind} onChange={(e) => onChange({ kind: e.target.value as DraftAction["kind"] })}>
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
          <Input ph="plain" value={a.text} maxLength={2000} onChange={(e) => onChange({ text: e.target.value })} />
        </Field>
      ) : a.kind === "suggest_survey" ? (
        <Field label={ut("am.suggestTest")} inline className="min-w-0 flex-1">
          <Select ph="plain" value={a.surveyId} onChange={(e) => onChange({ surveyId: e.target.value })}>
            <option value="" disabled>
              {ut("am.suggestTest")}
            </option>
            <SurveyOptions surveys={surveys} current={a.surveyId} loaded={loaded} />
          </Select>
        </Field>
      ) : a.kind === "suggest_pathway" ? (
        <Field label={ut("am.pathwayId")} inline className="min-w-0 flex-1">
          <Input ph="plain" value={a.pathwayId} onChange={(e) => onChange({ pathwayId: e.target.value })} />
        </Field>
      ) : (
        /* «повідомити чергового» параметров не имеет — место остаётся пустым, отметка на своём краю */
        <span className="min-w-0 flex-1" />
      )}
      <Pick checked={a.picked} label={ut("am.pickAction")} onChange={(v) => onChange({ picked: v })} />
    </div>
  );
}
