import { useEffect, useId, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import type {
  PatientGroupWithCounts,
  SampleFilters,
  StatModelColumn,
  StatRunColumn,
  StatRunResult,
  SurveyFull,
} from "@quizzy/shared";
import { api } from "../../api";
import { useLang } from "../../lang";
import { Loading, useAction } from "../../ui";
import { cx } from "../../ui/cx";
import { IconPlusThick } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { Button } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { useSurveyAt } from "./data";
import {
  MAX_SAMPLES,
  STATS_LIST,
  addSample,
  columnInput,
  columnsChanged,
  diffText,
  statEditHref,
} from "./model";
import {
  AgeRow,
  CellText,
  DateField,
  GlyphButton,
  GroupSelect,
  type Look,
  PatientField,
  Readout,
  SexSelect,
  StatInput,
  VshrToggle,
  patchFilters,
} from "./parts";

/*
 * Статистическая модель — кадры f09, f18 и f29, один экран.
 *
 *   f09 — одна выборка, карточка «Фільтри» раскрыта;
 *   f18 — то же, карточка свёрнута в полосу #f0ecff (нажатие на «Фільтри»);
 *   f29 — две выборки рядом и узкая колонка плашек справа: «+» строки
 *         заголовка добавляет выборку, плашки печатают разность долей.
 *
 * Что на кадре и как это легло на код (замеры в координатах кадра 1600,
 * низ полосы шапки = 100; колонка f09 — 700 по центру, 450…1149):
 *
 *   «Статистика» 24/700, «+» справа              → Page `snug tight`: строка
 *                                                   140…170, «+» — действие
 *   «Назва статистичної моделі» 20/700           → <h2> 189…213 (19 от строки)
 *   карточка «Фільтри» 238…498, рамка #666666    → <section>, шапка-кнопка 36
 *   (поля 295, 349, 400, 451: шаг 54, потом 51)     и поля с шагом кадра
 *   полоса «Фільтри» 239…274 (f18)               → та же кнопка, свёрнутая
 *   черта #cccccc 2px на 528 (29 после карточки) → <hr>
 *   «Назва тесту» 559…594, шаг строк 51          → строки отчёта, 29 после черты
 *   «Порівняти» 215×45 на 30 ниже строк          → Button size="md"
 *
 * Все поля на f09/f29 — подпись 16/700 фиолетовым: у фильтров это
 * плейсхолдер (поле просит ввода), у строк отчёта — показ значения
 * (Readout): название теста, подпись полосы, текст ответа, доля.
 *
 * Чего кадры не рисуют, а здесь есть, — и почему:
 *   · строка итога под выборкой после расчёта — основание и доля «ВШР», и
 *     фраза сервера о скрытом (note). Без основания доли не читаются, а
 *     молча нарисованные прочерки читались бы как «данных нет»;
 *   · «Зберегти» слева от «Порівняти» — только пока выборка или пометки
 *     «ВШР» изменены против сохранённых: расчёт по правленой выборке идёт
 *     превью (POST /api/stat-models/run) и ничего не сохраняет — «сохранил,
 *     потому что хотел посмотреть» случаться не должно;
 *   · название модели — ссылка на её правку (/statistics/:id/edit, форма
 *     f17): там тест и строки, описание для перечня f08 и удаление. Своей
 *     двери у правки на кадрах нет, а «+» уже занят выборкой;
 *   · «Порівняти» и на двух выборках: на f29 кнопки нет, но без неё
 *     правленые фильтры двух колонок нечем пересчитать. Отвергнуто:
 *     считать на каждую правку — каждый расчёт пишется в журнал, и поток
 *     соседних запросов — ровно то, что журнал обязан показать разбору, а
 *     не то, что экран обязан порождать сам.
 *
 * Строки «Назва моделі / ВщВМ / ВШР» и «Назва повідомлення / ВщВМ / ВШР»
 * f29 нарисованы, но сервер связи модели с другими моделями и рассылками не
 * знает, а «ВщВМ» из кадра не расшифровывается (docs/REWRITE-PLAN.md, волна
 * 5). Они стоят недоступными с подсказкой о причине — как пункты «Додати
 * Оператор» / «Об’єднати» меню аналитики: пропавшая строка читалась бы
 * как поломка, а молча не работающая — как поломка модели.
 */

export default function StatModelPage() {
  const { id } = useParams<{ id: string }>();
  /* ключ: переход между моделями не должен оставлять в полях чужую выборку */
  return <ModelScreen key={id} id={id!} />;
}

function ModelScreen({ id }: { id: string }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const model = useResource(() => api.statModel(id), [id]);
  const groups = useResource(() => api.patientGroups(), []);
  const presets = useResource(() => api.filterPresets(), []);

  const [saved, setSaved] = useState<StatModelColumn[] | null>(null);
  const [work, setWork] = useState<StatModelColumn[] | null>(null);
  useEffect(() => {
    if (!model.data) return;
    setSaved(model.data.columns);
    setWork(model.data.columns);
  }, [model.data]);

  /*
   * Результат живёт до первой правки выборки: доли рядом с изменёнными
   * фильтрами печатали бы ответ на вопрос, которого на экране уже нет.
   */
  const [result, setResult] = useState<StatRunResult | null>(null);
  const [open, setOpen] = useState(true);

  const edit = (next: StatModelColumn[]) => {
    setWork(next);
    setResult(null);
  };

  /*
   * Пресеты — до первого показа: у выборки с пресетом поля показывают его
   * критерии, и правка раньше их приезда начиналась бы с пустого места —
   * то есть молча выбрасывала бы критерии пресета из выборки.
   */
  const waiting = !presets.data && !presets.error;
  if (model.error || !model.data || !work || !saved || waiting) {
    return (
      <Page title={ut("top.statistics")} snug tight>
        {model.error ? (
          <div className="mt-[19px]">
            <Loading error={model.error} onRetry={model.reload} />
            <Link to={STATS_LIST} className="mt-[12px] inline-block text-[15px] font-bold text-primary">
              {ut("st.backToList")}
            </Link>
          </div>
        ) : (
          <Loading rows={6} />
        )}
      </Page>
    );
  }

  const dirty = columnsChanged(saved, work);
  const presetOf = (c: StatModelColumn) => (c.presetId ? presets.data?.find((p) => p.id === c.presetId) : undefined);

  const compare = () =>
    void run(async () => {
      /* правленая выборка — превью; нетронутая — расчёт сохранённой модели, с её id в журнале */
      setResult(dirty ? await api.previewStatModel(work.map(columnInput), model.data!.title) : await api.runStatModel(id));
    });

  const save = () =>
    void run(async () => {
      const next = await api.updateStatModel(id, { columns: work.map(columnInput) });
      setSaved(next.columns);
      setWork(next.columns);
    }, ut("st.saved"));

  /*
   * Правка фильтров выборки с пресетом превращает её в свои фильтры,
   * начиная с критериев пресета: колонка на сервере берёт либо пресет, либо
   * свои (одно из двух), а править пресет отсюда значило бы молча поменять
   * все модели, которые на него ссылаются.
   */
  const setFilters = (i: number, patch: Partial<SampleFilters>) =>
    edit(
      work.map((c, j) => {
        if (j !== i) return c;
        const base = c.presetId ? (presetOf(c)?.criteria ?? {}) : (c.filters ?? {});
        return { ...c, presetId: null, filters: patchFilters(base, patch) };
      }),
    );

  /* «ВШР» — у одного и того же варианта во всех выборках: показатели модели одни на все колонки */
  const toggleRisk = (questionId: string, optionId: string) => {
    const now = work[0]?.questions
      .find((q) => q.questionId === questionId)
      ?.options.find((o) => o.optionId === optionId)?.highRisk;
    edit(
      work.map((c) => ({
        ...c,
        questions: c.questions.map((q) =>
          q.questionId !== questionId
            ? q
            : { ...q, options: q.options.map((o) => (o.optionId === optionId ? { ...o, highRisk: !now } : o)) },
        ),
      })),
    );
  };

  const two = work.length > 1;
  const filtersOf = (c: StatModelColumn): SampleFilters => (c.presetId ? (presetOf(c)?.criteria ?? {}) : (c.filters ?? {}));

  return (
    <Page
      title={ut("top.statistics")}
      snug
      tight
      actions={
        <GlyphButton
          label={ut("st.addSample")}
          onClick={() => edit(addSample(work))}
          disabled={work.length >= MAX_SAMPLES}
        >
          <IconPlusThick />
        </GlyphButton>
      }
    >
      {/*
        Название модели 20/700 — ссылка на её правку (форма f17): своей
        двери у правки на кадре нет, а заголовок модели — первое, куда
        нажимают, чтобы её переименовать.
      */}
      <h2 className="m-0 mt-[19px] text-[20px] font-bold leading-[24px]">
        <Link to={statEditHref(id)} className="text-primary no-underline hover:underline">
          {model.data.title}
        </Link>
      </h2>

      {two ? (
        <Samples
          columns={work}
          result={result}
          open={open}
          onToggle={() => setOpen((v) => !v)}
          filtersOf={filtersOf}
          onFilters={setFilters}
          onRisk={toggleRisk}
          groups={groups.data}
        />
      ) : (
        <Single
          column={work[0]!}
          result={result?.columns[0]}
          open={open}
          onToggle={() => setOpen((v) => !v)}
          filters={filtersOf(work[0]!)}
          onFilters={(patch) => setFilters(0, patch)}
          onRisk={toggleRisk}
          groups={groups.data}
        />
      )}

      <div
        className={cx(
          "mt-[30px] flex items-start justify-end gap-[15px]",
          /* под парой — правым краем по второй колонке (1224); под одной — по строкам 698 (1147) */
          two ? "w-[1025px] max-w-full" : "mx-auto w-[698px] max-w-full -translate-x-px",
        )}
      >
        {dirty ? (
          <Button size="md" variant="ghost" className="w-[215px]" disabled={busy} onClick={save}>
            {ut("common.save")}
          </Button>
        ) : null}
        <Button size="md" className="w-[215px]" disabled={busy} onClick={compare}>
          {ut("st.compare")}
        </Button>
      </div>
    </Page>
  );
}

/* ─────────── строки отчёта ─────────── */

type Row =
  | { kind: "test"; key: string; text?: string }
  | { kind: "band"; key: string; n: number; text?: string; cell?: StatRunColumn["respondents"] }
  | { kind: "question"; key: string; n: number; text?: string }
  | {
      kind: "option";
      key: string;
      n: number;
      questionId: string;
      optionId: string;
      text?: string;
      cell?: StatRunColumn["respondents"];
      highRisk: boolean;
    };

/**
 * Строки выборки в порядке кадра: тест, варианты результата, затем каждый
 * вопрос со своими ответами. Подписи — из расчёта, когда он есть (он
 * присылает их на языке запроса), иначе из версии методики.
 */
function rowsOf(col: StatModelColumn, survey: SurveyFull | null | undefined, res: StatRunColumn | undefined): Row[] {
  const rows: Row[] = [{ kind: "test", key: "test", text: res?.surveyTitle ?? survey?.title }];
  col.bands.forEach((b, i) => {
    const got = res?.scales.flatMap((s) => s.bands).find((x) => x.bandId === b.bandId);
    const label = got?.label ?? survey?.scales.find((s) => s.id === b.scaleId)?.bands.find((x) => x.id === b.bandId)?.label;
    rows.push({ kind: "band", key: `b:${b.bandId}`, n: i + 1, text: label, cell: got?.cell });
  });
  col.questions.forEach((q, qi) => {
    const gotQ = res?.questions.find((x) => x.questionId === q.questionId);
    const question = survey?.questions.find((x) => x.id === q.questionId);
    rows.push({ kind: "question", key: `q:${q.questionId}`, n: qi + 1, text: gotQ?.title ?? question?.title });
    q.options.forEach((o, oi) => {
      const got = gotQ?.options.find((x) => x.optionId === o.optionId);
      rows.push({
        kind: "option",
        key: `o:${q.questionId}:${o.optionId}`,
        n: oi + 1,
        questionId: q.questionId,
        optionId: o.optionId,
        text: got?.text ?? question?.options.find((x) => x.id === o.optionId)?.text,
        cell: got?.cell,
        highRisk: o.highRisk,
      });
    });
  });
  return rows;
}

/**
 * Итог выборки после расчёта: основание, «ВШР» и фраза сервера.
 *
 * Основание печатается прочерком, если сервер его спрятал; фраза — дословно
 * та, что прислал сервер (err.statColumnClosed и соседи в errorStrings.ts):
 * причину скрытого знает он, и второй словарь на клиенте её бы переврал.
 */
function Summary({ res }: { res: StatRunColumn | undefined }) {
  const { ut } = useLang();
  if (!res) return null;
  return (
    <div role="status" className="text-[13px] leading-[19px] text-muted">
      <p className="m-0">
        {ut("st.respondents")}: <CellText cell={res.respondents} />
        {res.highRisk ? (
          <>
            {" · "}
            {ut("st.vshr")}: <CellText cell={res.highRisk} />
          </>
        ) : null}
      </p>
      {res.note ? <p className="m-0">{res.note}</p> : null}
    </div>
  );
}

/* ─────────── одна выборка: f09 / f18 ─────────── */

function Single({
  column,
  result,
  open,
  onToggle,
  filters,
  onFilters,
  onRisk,
  groups,
}: {
  column: StatModelColumn;
  result: StatRunColumn | undefined;
  open: boolean;
  onToggle: () => void;
  filters: SampleFilters;
  onFilters: (patch: Partial<SampleFilters>) => void;
  onRisk: (questionId: string, optionId: string) => void;
  groups: PatientGroupWithCounts[] | null;
}) {
  const survey = useSurveyAt(column.surveyId, column.versionId);
  const rows = rowsOf(column, survey, result);
  const fieldsId = useId();
  return (
    <div className="mx-auto w-[700px] max-w-full">
      {open ? (
        /*
          Карточка 238…498: рамка #666666, шапка-кнопка 36 (текст с 10 от
          рамки), поля — 20 под шапкой, по 9 от рамки слева и справа
          (460…1139), 11 от нижней рамки.
        */
        <section className="mt-[25px] rounded-[5px] border border-field-border">
          <h3 className="m-0">
            <FiltersToggle open onToggle={onToggle} controls={fieldsId} />
          </h3>
          <div id={fieldsId} className="px-[9px] pb-[11px] pt-[20px]">
            <FilterFields look="outline" filters={filters} onChange={onFilters} groups={groups} wide />
          </div>
        </section>
      ) : (
        /* полоса f18 — 239…274, на пиксель ниже рамки раскрытой карточки */
        <h3 className="m-0 mt-[26px]">
          <FiltersToggle open={false} onToggle={onToggle} controls={fieldsId} />
        </h3>
      )}

      <hr className="m-0 mt-[29px] h-[2px] border-0 bg-hairline" />

      {/*
        Строки отчёта. «Назва тесту» — во всю колонку 700, остальные — на 2
        уже (правый край 1147 против 1149): так на f09 и f18, у всех строк
        ниже теста и у кнопки.
      */}
      <div className="mt-[29px] flex flex-col gap-[15px]">
        {rows.map((r) => (
          <SingleRow key={r.key} row={r} onRisk={onRisk} />
        ))}
      </div>
      {result ? (
        <div className="mt-[15px] w-[698px] max-w-full">
          <Summary res={result} />
        </div>
      ) : null}
    </div>
  );
}

/** Строка отчёта одной выборки — ширины f09: 700 у теста, 698 у остальных */
function SingleRow({ row, onRisk }: { row: Row; onRisk: (questionId: string, optionId: string) => void }) {
  const { ut } = useLang();
  const L: Look = "outline";
  switch (row.kind) {
    case "test":
      return <Readout look={L} label={ut("am.testName")} text={row.text} />;
    case "band":
      /* 338 | 15 | 345 — замер f09 (459…796 и 812…1156) */
      return (
        <div className="flex w-[698px] max-w-full gap-[15px]">
          <Readout look={L} label={`${ut("st.band")} ${row.n}`} text={row.text} className="w-[338px] shrink-0" />
          <Readout look={L} label={`${ut("st.percent")} ${row.n}`} text={cellNode(row.cell)} className="min-w-0 flex-1" />
        </div>
      );
    case "question":
      return <Readout look={L} label={`${ut("st.question")} ${row.n}`} text={row.text} className="w-[698px] max-w-full" />;
    case "option":
      /* 255 | 15 | 323 | 15 | 90 — замер f09 (459…713, 729…1051, 1067…1156); «ВШР» с отступом 10 слева */
      return (
        <div className="flex w-[698px] max-w-full gap-[15px]">
          <Readout look={L} label={`${ut("st.answer")} ${row.n}`} text={row.text} className="w-[255px] shrink-0" />
          <Readout look={L} label={`${ut("st.percent")} ${row.n}`} text={cellNode(row.cell)} className="min-w-0 flex-1" />
          <VshrToggle
            look={L}
            pressed={row.highRisk}
            align="start"
            onToggle={() => onRisk(row.questionId, row.optionId)}
            className="w-[90px] shrink-0"
          />
        </div>
      );
  }
}

/** Доля в поле: пусто до расчёта, «42%» или прочерк после */
function cellNode(cell: StatRunColumn["respondents"] | undefined): ReactNode {
  return cell ? <CellText cell={cell} /> : undefined;
}

/**
 * «Фільтри» — заголовок-кнопка, сворачивающая карточку (f09 ↔ f18).
 *
 * Кнопка внутри <h3>, а не заголовок с обработчиком: диктор объявляет
 * «кнопка, развёрнуто» и находит её в списке заголовков. Свёрнутая —
 * полоса #f0ecff 36 высотой (f18: 459…1158 × 250…285), раскрытая — шапка
 * карточки без заливки.
 */
function FiltersToggle({
  open,
  onToggle,
  controls,
  bare,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
  /*
   * Раскрытый заголовок колонки f29: без рамки и без полей — строка 24,
   * чернила «Ф» с 201 при левом крае колонки 200 (235…259 по высоте). У
   * карточки f09 он же стоит в шапке 36 с отступом 10.
   */
  bare?: boolean;
}) {
  const { ut } = useLang();
  const flat = bare && open;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      onClick={onToggle}
      className={cx(
        "flex w-full items-center rounded-[5px] border-0 text-left text-[20px] font-bold leading-[24px] text-primary",
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        flat ? "h-[24px] px-0" : "h-9 px-[10px]",
        open ? "bg-transparent" : "bg-primary-soft",
      )}
    >
      {ut("st.filters")}
    </button>
  );
}

/**
 * Поля фильтра выборки в порядке кадра: «Дата», «Пацієнт», «Вік від — Вік
 * до», «Стать» + «Населений пункт». Шаг после «Дата» — 54, дальше 51: так
 * на обоих кадрах с карточкой (f09: 311→365→416→467, f29: 291→345→396→447),
 * то есть это рисунок, а не случайность одного кадра.
 *
 * `wide` — геометрия f09 (колонка 680): тире 25 с просветами 10, «Стать»
 * 140 и 15 до «Населений пункт». Без него — f29 (колонка 456): тире 17 с
 * просветами 6, «Стать» 96 и 20.
 */
function FilterFields({
  look,
  filters,
  onChange,
  groups,
  wide,
}: {
  look: Look;
  filters: SampleFilters;
  onChange: (patch: Partial<SampleFilters>) => void;
  groups: PatientGroupWithCounts[] | null;
  wide?: boolean;
}) {
  const { ut } = useLang();
  return (
    <div className="flex flex-col">
      <div className="mb-[18px] flex">
        <DateField look={look} from={filters.from} to={filters.to} onChange={(p) => onChange(p)} />
      </div>
      <div className="mb-[15px] flex">
        <PatientField look={look} value={filters.patientId} onChange={(patientId) => onChange({ patientId })} />
      </div>
      <div className="mb-[15px] flex">
        <AgeRow
          look={look}
          min={filters.ageMin}
          max={filters.ageMax}
          onChange={(p) => onChange(p)}
          dash={wide ? 25 : 17}
          gap={wide ? 10 : 6}
        />
      </div>
      {filters.patientGroupId ? (
        <div className="mb-[15px] flex">
          <GroupSelect
            look={look}
            value={filters.patientGroupId}
            onChange={(patientGroupId) => onChange({ patientGroupId })}
            groups={groups}
          />
        </div>
      ) : null}
      <div className={cx("flex", wide ? "gap-[15px]" : "gap-[20px]")}>
        <SexSelect
          look={look}
          value={filters.sex}
          onChange={(sex) => onChange({ sex })}
          className={wide ? "w-[140px] shrink-0" : "w-[96px] shrink-0"}
        />
        <StatInput
          look={look}
          label={ut("st.locality")}
          value={filters.locality ?? ""}
          maxLength={160}
          onChange={(e) => onChange({ locality: e.target.value })}
        />
      </div>
    </div>
  );
}

/* ─────────── выборки рядом: f29 ─────────── */

/**
 * Две выборки и колонка плашек — замер f29: колонки по 456 (200…655 и
 * 769…1224), просветы 113, плашки 62 (1338…1399) — ровно 1200. Сеткой, а не
 * тремя стопками: строки обязаны стоять вровень по всей ширине.
 *
 * Плашка печатает разность долей правой и левой выборки (diffText) — только
 * когда обе ячейки показаны. У строки теста плашки нет, у строк вопросов —
 * пустая, как на кадре.
 *
 * Третья и следующие выборки (сервер позволяет восемь) встают тем же шагом
 * вправо с прокруткой; плашек у них нет — разность определена для пары, и
 * сравнивать «третью с кем» кадр не говорит.
 */
function Samples({
  columns,
  result,
  open,
  onToggle,
  filtersOf,
  onFilters,
  onRisk,
  groups,
}: {
  columns: StatModelColumn[];
  result: StatRunResult | null;
  open: boolean;
  onToggle: () => void;
  filtersOf: (c: StatModelColumn) => SampleFilters;
  onFilters: (i: number, patch: Partial<SampleFilters>) => void;
  onRisk: (questionId: string, optionId: string) => void;
  groups: PatientGroupWithCounts[] | null;
}) {
  const { ut } = useLang();
  const pair = columns.length === 2;
  /*
   * Версии методик — две загрузки на весь экран, а не по одной на колонку:
   * показатели у колонок модели одни (их задаёт форма f17), и восьмая
   * колонка той же версии не должна тянуть её восьмой раз. Вторая —
   * на случай модели, собранной мимо формы, где колонки разошлись.
   */
  const head = columns[0]!;
  const other = columns.find((c) => c.surveyId !== head.surveyId || c.versionId !== head.versionId) ?? null;
  const surveyA = useSurveyAt(head.surveyId, head.versionId);
  const surveyB = useSurveyAt(other?.surveyId ?? null, other?.versionId ?? null);
  const surveyOf = (c: StatModelColumn) =>
    c.surveyId === head.surveyId && c.versionId === head.versionId ? surveyA : surveyB;
  const rowsBy = columns.map((c, i) => rowsOf(c, surveyOf(c), result?.columns[i]));
  const depth = Math.max(...rowsBy.map((r) => r.length));
  const fieldsId = useId();

  return (
    <div className="mt-[22px] overflow-x-auto">
      <div
        className="grid gap-x-[113px] gap-y-[15px]"
        style={{ gridTemplateColumns: pair ? "456px 456px 62px" : `repeat(${columns.length}, 456px)` }}
      >
        {columns.map((c, i) => (
          /*
            «Фільтри» 20/700 без рамки (строка 235…259), поля 16 ниже, шаг как
            у f09, черта #cccccc 2px на 29 ниже полей и 29 до первой строки
            (14 здесь + 15 шага сетки).
          */
          <section key={`f${i}`} aria-label={`${ut("st.sample")} ${i + 1}`} className="mb-[14px]">
            <h3 className="m-0">
              <FiltersToggle open={open} onToggle={onToggle} controls={`${fieldsId}-${i}`} bare />
            </h3>
            {open ? (
              <div id={`${fieldsId}-${i}`} className="mt-[16px]">
                <FilterFields look="fill" filters={filtersOf(c)} onChange={(p) => onFilters(i, p)} groups={groups} />
              </div>
            ) : null}
            <hr className="m-0 mt-[29px] h-[2px] border-0 bg-hairline" />
          </section>
        ))}
        {pair ? <div aria-hidden /> : null}

        {Array.from({ length: depth }, (_, r) => (
          <RowCells key={`r${r}`} rows={rowsBy.map((rows) => rows[r])} pair={pair} onRisk={onRisk} />
        ))}

        {/* строки связей с моделями и рассылками — недоступны, см. шапку файла */}
        <LinkRow label={ut("st.linkModel")} count={columns.length} pair={pair} />
        <LinkRow label={ut("st.linkMailing")} count={columns.length} pair={pair} />

        {result ? columns.map((_, i) => <Summary key={`s${i}`} res={result.columns[i]} />) : null}
        {result && pair ? <div aria-hidden /> : null}
      </div>
    </div>
  );
}

/** Плашка колонки разности: 62×36, #f0ecff, число по центру 16/700 */
function Plate({ text }: { text?: string }) {
  const { ut } = useLang();
  return (
    <div
      className={cx(
        "flex h-9 w-[62px] items-center justify-center rounded-[5px]",
        "bg-primary-soft text-[16px] font-bold text-primary",
      )}
    >
      {text ? (
        <span title={ut("st.diffHint")}>
          <span className="sr-only">{ut("st.diffHint")}: </span>
          {text}
        </span>
      ) : null}
    </div>
  );
}

/** Одна строка сетки f29: ячейка каждой выборки и плашка разности */
function RowCells({
  rows,
  pair,
  onRisk,
}: {
  rows: (Row | undefined)[];
  pair: boolean;
  onRisk: (questionId: string, optionId: string) => void;
}) {
  const { ut } = useLang();
  const L: Look = "fill";
  const cell = (row: Row | undefined, i: number) => {
    if (!row) return <div key={i} />;
    switch (row.kind) {
      case "test":
        return <Readout key={i} look={L} label={ut("am.testName")} text={row.text} />;
      case "band":
        /* 215 | 15 | 226 — замер f29 (215…429 и 445…669) */
        return (
          <div key={i} className="flex gap-[15px]">
            <Readout look={L} label={`${ut("st.band")} ${row.n}`} text={row.text} className="w-[215px] shrink-0" />
            <Readout look={L} label={`${ut("st.percent")} ${row.n}`} text={cellNode(row.cell)} className="min-w-0 flex-1" />
          </div>
        );
      case "question":
        return <Readout key={i} look={L} label={`${ut("st.question")} ${row.n}`} text={row.text} />;
      case "option":
        /* 159 | 16 | 204 | 15 | 62 — замер f29 (215…373, 391…593, 609…670) */
        return (
          <div key={i} className="flex">
            <Readout look={L} label={`${ut("st.answer")} ${row.n}`} text={row.text} className="w-[159px] shrink-0" />
            <Readout
              look={L}
              label={`${ut("st.percent")} ${row.n}`}
              text={cellNode(row.cell)}
              className="ml-[16px] min-w-0 flex-1"
            />
            <VshrToggle
              look={L}
              pressed={row.highRisk}
              onToggle={() => onRisk(row.questionId, row.optionId)}
              className="ml-[15px] w-[62px] shrink-0"
            />
          </div>
        );
    }
  };
  const [a, b] = rows;
  const diff =
    a && b && a.key === b.key && (a.kind === "band" || a.kind === "option") && (b.kind === "band" || b.kind === "option")
      ? diffText(a.cell, b.cell)
      : "";
  return (
    <>
      {rows.map(cell)}
      {pair ? a?.kind === "test" ? <div aria-hidden /> : <Plate text={diff} /> : null}
    </>
  );
}

/**
 * «Назва моделі · ВщВМ · ВШР» — 302 | 15 | 62 | 15 | 62 (замер f29,
 * 215…516, 532…593, 609…670). Недоступна: см. шапку файла. Причина — в
 * подсказке и для диктора; поля не принимают фокус, потому что нажимать в
 * них нечего.
 */
function LinkRow({ label, count, pair }: { label: string; count: number; pair: boolean }) {
  const { ut } = useLang();
  const hint = ut("st.linksUnavailable");
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-disabled title={hint} className="flex gap-[15px]">
          <Readout look="fill" label={label} className="min-w-0 flex-1" />
          <Readout look="fill" label={ut("st.vshvm")} align="center" className="w-[62px] shrink-0" />
          <Readout look="fill" label={ut("st.vshr")} align="center" className="w-[62px] shrink-0" />
          <span className="sr-only">{hint}</span>
        </div>
      ))}
      {pair ? <Plate /> : null}
    </>
  );
}
