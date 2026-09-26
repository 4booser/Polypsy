import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { StatModel, SurveyFull, UiKey } from "@quizzy/shared";
import { api } from "../../api";
import { useLang } from "../../lang";
import { Loading, useAction, useToast } from "../../ui";
import { cx } from "../../ui/cx";
import { IconPlusThick } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { Button, Textarea } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { TestPicker } from "../analytics/Editor";
import { useSurveyAt } from "./data";
import {
  STATS_LIST,
  type BandRow,
  type OptionRow,
  type QuestionBlock,
  type StructureDraft,
  columnsFromDraft,
  emptyStructure,
  newBandRow,
  newOptionRow,
  newQuestionBlock,
  statHref,
  structureFromModel,
  validateStructure,
  withSpare,
} from "./model";
import { GlyphButton, IconMinusThick, Readout, StatSelect, VshrToggle } from "./parts";

/*
 * Створення статистичної моделі — кадр f17; тот же экран на
 * /statistics/:id/edit правит сохранённую модель.
 *
 * Что на кадре и как это легло на код (замеры f17 в координатах кадра 1600,
 * низ полосы шапки = 100; колонка 700 по центру, 450…1149):
 *
 *   «Статистика» 24/700                         → Page `snug tight`
 *   «Назва статистичної моделі» 20/700 (189)    → поле-заголовок: на кадре
 *                                                  это строка, а не поле, и
 *                                                  пустое оно выглядит ровно
 *                                                  так; набранное — тем же
 *                                                  начертанием, это имя модели
 *   карточка теста 230…387, рамка #666666       → «Назва тесту» (выбор теста
 *   (поля 649 шириной, «−» 27 справа,              из аналитики, TestPicker) и
 *   просветы 9/6/7)                                строки «Варіант результату»
 *   карточка вопроса 30 ниже, «+» справа        → блок вопроса
 *   «Створити» 215×45, 23 ниже карточек         → Button size="md"
 *
 * Подписи в полях — 17/400 серым (как ph="plain" общего Input): форма ещё
 * только просит ввода.
 *
 * Глифы карточек. «−» у блока теста сбрасывает тест со всеми строками — это
 * единственное, что можно «убрать» у блока, без которого модель не модель.
 * У блока вопроса глиф зависит от места: у последнего «+» (добавить блок
 * после него — так на кадре, где блок один), у остальных «−» (убрать блок).
 * Отвергнуто: «+» и «−» у каждого блока сразу — на кадре у карточки ровно
 * один глиф.
 *
 * Строк в группе — выбранные плюс одна пустая, не меньше двух, как на
 * кадре: выбрал вариант в пустой — появилась следующая (withSpare).
 * «Відсоток відповідей» в форме пуст всегда: долю считает экран модели, а
 * форма лишь держит место, как на кадре, — поэтому для диктора оно скрыто.
 *
 * Чего кадр не рисует, а здесь есть (только в правке, /:id/edit):
 *   · «Короткий опис» — второй столбец перечня f08; вводить его больше негде;
 *   · «Вибірки» с «−» — убрать выборку, добавленную «+» на экране модели
 *     (f29): иначе раз добавленная выборка оставалась бы навсегда;
 *   · «Видалити модель» слева от «Зберегти».
 * Фильтров в форме нет, как на кадре: выборку задают на экране модели
 * (f09), и при правке структура ложится на каждую колонку, а их выборки
 * остаются (columnsFromDraft).
 */

export default function StatEditorPage() {
  const { id } = useParams<{ id: string }>();
  /* ключ: форма новой модели и правка — один компонент на двух адресах */
  return <Editor key={id ?? "new"} id={id ?? null} />;
}

/** Типы вопросов, по которым сервер считает доли (lib/statModels.ts, QUESTION_TYPES) */
const COUNTED = new Set(["single", "yesno", "multiple"]);

function Editor({ id }: { id: string | null }) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, busy } = useAction();

  const surveys = useResource(() => api.surveys(), []);
  const model = useResource(() => api.statModel(id!), [id], { enabled: id !== null });

  const [draft, setDraft] = useState<StructureDraft | null>(id === null ? emptyStructure() : null);
  const [columns, setColumns] = useState<StatModel["columns"] | null>(null);
  useEffect(() => {
    if (!model.data) return;
    setDraft(tidy(structureFromModel(model.data)));
    setColumns(model.data.columns);
  }, [model.data]);

  /*
   * Версия для подписей и выбора: у правки — версия колонки, пока тест тот
   * же (полосы модели принадлежат ей), у нового теста — действующая.
   */
  const head = model.data?.columns[0];
  const version = head && draft && head.surveyId === draft.surveyId ? head.versionId : null;
  const survey = useSurveyAt(draft?.surveyId || null, version);

  const [errors, setErrors] = useState<UiKey[]>([]);

  if (!draft || !surveys.data || (id !== null && !columns)) {
    return (
      <Page title={ut("top.statistics")} snug tight>
        <Loading
          rows={6}
          error={model.error ?? surveys.error}
          onRetry={() => {
            if (model.error) model.reload();
            if (surveys.error) surveys.reload();
          }}
        />
      </Page>
    );
  }

  const patch = (next: Partial<StructureDraft>) => setDraft((d) => (d ? tidy({ ...d, ...next }) : d));

  const save = () => {
    const errs = validateStructure(draft);
    setErrors(errs);
    if (errs.length) return;
    void run(async () => {
      const body = {
        title: draft.title.trim(),
        description: id === null ? null : draft.description.trim() || null,
        columns: columnsFromDraft(draft, columns),
      };
      if (id === null) {
        const created = await api.createStatModel(body);
        /* replace: «назад» с экрана новой модели ведёт в перечень, а не в пустую форму */
        navigate(statHref(created.id), { replace: true });
      } else {
        await api.updateStatModel(id, body);
        navigate(statHref(id));
      }
    }, ut("st.saved"));
  };

  const remove = () => {
    if (id === null) return;
    void run(async () => {
      if (!window.confirm(ut("st.deleteConfirm"))) return false;
      await api.deleteStatModel(id);
      toast(ut("st.deleted"), "ok");
      navigate(STATS_LIST, { replace: true });
    });
  };

  /* название выбранной методики для выбора теста — даже если её нет в коротком списке (снята) */
  const loaded =
    survey && draft.surveyId
      ? { [draft.surveyId]: { title: survey.title, archivedAt: survey.archivedAt ?? null, scales: survey.scales } }
      : {};

  return (
    <Page title={ut("top.statistics")} snug tight>
      {/*
        Поле-заголовок: 20/700 фиолетовым, строка 24, без рамки, у левого
        края колонки содержимого (f17: чернила с 201), а не формы 700 — на
        кадре здесь строка «Назва статистичної моделі», и пустое поле
        выглядит ровно ею. Не <h2>: это ввод, и диктор обязан услышать «поле».
      */}
      <input
        aria-label={ut("st.modelName")}
        placeholder={ut("st.modelName")}
        value={draft.title}
        maxLength={200}
        onChange={(e) => patch({ title: e.target.value })}
        className={cx(
          "mt-[19px] block h-[24px] w-full border-0 bg-transparent p-0 rounded-[3px]",
          "text-[20px] font-bold leading-[24px] text-primary placeholder:text-primary",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        )}
      />

      <div className="mx-auto w-[700px] max-w-full">
        {/* карточка теста — 17 под заголовком (213 → 230) */}
        <section
          aria-label={ut("am.testName")}
          className="mt-[17px] rounded-[5px] border border-field-border py-[9px] pl-[9px] pr-[7px]"
        >
          <div className="flex flex-col gap-[15px]">
            <div className="flex items-center gap-[6px]">
              <div className="flex w-[649px] min-w-0">
                <TestPicker
                  value={draft.surveyId}
                  surveys={surveys.data}
                  loaded={loaded}
                  /* смена теста сбрасывает строки: полосы и варианты принадлежат методике */
                  onChange={(surveyId) =>
                    patch({
                      surveyId,
                      bands: [newBandRow(), newBandRow()],
                      questions: [newQuestionBlock("", [newOptionRow(), newOptionRow()])],
                    })
                  }
                />
              </div>
              <GlyphButton
                label={ut("st.resetTest")}
                disabled={!draft.surveyId}
                onClick={() => patch({ ...emptyStructure(), title: draft.title, description: draft.description })}
              >
                <IconMinusThick />
              </GlyphButton>
            </div>
            {draft.bands.map((b, i) => (
              <BandLine
                key={b.key}
                n={i + 1}
                row={b}
                survey={survey}
                onChange={(value) => patch({ bands: draft.bands.map((x) => (x.key === b.key ? { ...x, value } : x)) })}
              />
            ))}
          </div>
        </section>

        {draft.questions.map((q, qi) => (
          <QuestionCard
            key={q.key}
            n={qi + 1}
            block={q}
            survey={survey}
            last={qi === draft.questions.length - 1}
            onChange={(next) => patch({ questions: draft.questions.map((x) => (x.key === q.key ? next : x)) })}
            onAdd={() => {
              const at = draft.questions.findIndex((x) => x.key === q.key);
              const questions = [...draft.questions];
              questions.splice(at + 1, 0, newQuestionBlock("", [newOptionRow(), newOptionRow()]));
              patch({ questions });
            }}
            onRemove={() => patch({ questions: draft.questions.filter((x) => x.key !== q.key) })}
          />
        ))}

        {id !== null ? (
          <div className="mt-[30px] flex flex-col gap-[15px]">
            <Textarea
              ph="plain"
              aria-label={ut("st.description")}
              placeholder={ut("st.description")}
              rows={3}
              maxLength={4000}
              value={draft.description}
              onChange={(e) => patch({ description: e.target.value })}
            />
            {columns && columns.length > 1 ? (
              <SamplesList
                count={columns.length}
                titles={columns.map((c) => c.title)}
                onRemove={(i) => setColumns((cs) => (cs ? cs.filter((_, j) => j !== i) : cs))}
              />
            ) : null}
          </div>
        ) : null}

        {errors.length ? (
          /* role="alert" на обёртке: на самом <ul> он заменил бы роль списка */
          <div role="alert">
            <ul className="m-0 mt-[20px] list-none p-0 text-[13px] leading-[19px] text-danger">
              {errors.map((k) => (
                <li key={k}>{ut(k)}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className={cx("mt-[23px] flex items-center gap-[15px]", id === null ? "justify-end" : "justify-between")}>
          {id !== null ? (
            <Button variant="danger" size="sm" disabled={busy} onClick={remove}>
              {ut("st.deleteModel")}
            </Button>
          ) : null}
          <Button size="md" className="w-[215px]" disabled={busy} onClick={save}>
            {id === null ? ut("st.create") : ut("common.save")}
          </Button>
        </div>
      </div>
    </Page>
  );
}

/** Пустые строки подтягиваются к одной в конце группы — и так после каждой правки */
function tidy(d: StructureDraft): StructureDraft {
  return {
    ...d,
    bands: withSpare(d.bands, (b) => !b.value, () => newBandRow()),
    questions: d.questions.map((q) => ({
      ...q,
      options: withSpare(q.options, (o) => !o.optionId, () => newOptionRow()),
    })),
  };
}

/**
 * «Варіант результату N | Відсоток відповідей N» — 317 | 15 | 317 (замер
 * f17: 469…785 и 801…1117). Полосы сгруппированы по шкалам: у методики
 * шкал бывает несколько, и «Середній» без имени шкалы не говорит ничего.
 */
function BandLine({
  n,
  row,
  survey,
  onChange,
}: {
  n: number;
  row: BandRow;
  survey: SurveyFull | null | undefined;
  onChange: (value: string) => void;
}) {
  const { ut } = useLang();
  const many = (survey?.scales.length ?? 0) > 1;
  return (
    <div className="flex w-[649px] max-w-full gap-[15px]">
      <StatSelect
        look="plain"
        label={`${ut("st.band")} ${n}`}
        value={row.value}
        onChange={onChange}
        disabled={!survey}
        className="w-[317px] shrink-0"
      >
        {(survey?.scales ?? []).map((s) =>
          many ? (
            <optgroup key={s.id} label={s.title}>
              {s.bands.map((b) => (
                <option key={b.id} value={`${s.id}:${b.id}`}>
                  {b.label}
                </option>
              ))}
            </optgroup>
          ) : (
            s.bands.map((b) => (
              <option key={b.id} value={`${s.id}:${b.id}`}>
                {b.label}
              </option>
            ))
          ),
        )}
      </StatSelect>
      <div aria-hidden className="min-w-0 flex-1">
        <Readout look="plain" label={`${ut("st.percent")} ${n}`} />
      </div>
    </div>
  );
}

/**
 * Блок вопроса: «Текст питання N» с глифом, ниже ответы «Текст відповіді |
 * Відсоток відповідей | ВШР» — 277 | 15 | 277 | 15 | 65 (замер f17: 469…745,
 * 761…1037, 1053…1117). Карточка 30 ниже предыдущей.
 */
function QuestionCard({
  n,
  block,
  survey,
  last,
  onChange,
  onAdd,
  onRemove,
}: {
  n: number;
  block: QuestionBlock;
  survey: SurveyFull | null | undefined;
  last: boolean;
  onChange: (next: QuestionBlock) => void;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const { ut } = useLang();
  const questions = (survey?.questions ?? []).filter((q) => COUNTED.has(q.type));
  const question = questions.find((q) => q.id === block.questionId);
  const options = (question?.options ?? []).filter((o) => o.kind === "option");
  const setOption = (row: OptionRow, next: Partial<OptionRow>) =>
    onChange({ ...block, options: block.options.map((o) => (o.key === row.key ? { ...o, ...next } : o)) });
  return (
    <section
      aria-label={`${ut("st.question")} ${n}`}
      className="mt-[30px] rounded-[5px] border border-field-border py-[9px] pl-[9px] pr-[7px]"
    >
      <div className="flex flex-col gap-[15px]">
        <div className="flex items-center gap-[6px]">
          <StatSelect
            look="plain"
            label={`${ut("st.question")} ${n}`}
            value={block.questionId}
            disabled={!survey}
            /* смена вопроса сбрасывает ответы: варианты принадлежат вопросу */
            onChange={(questionId) => onChange({ ...block, questionId, options: [newOptionRow(), newOptionRow()] })}
            className="w-[649px] max-w-full shrink-0"
          >
            {questions.map((q) => (
              <option key={q.id} value={q.id}>
                {q.title}
              </option>
            ))}
          </StatSelect>
          {last ? (
            <GlyphButton label={ut("st.addQuestion")} onClick={onAdd}>
              <IconPlusThick />
            </GlyphButton>
          ) : (
            <GlyphButton label={ut("st.removeQuestion")} onClick={onRemove}>
              <IconMinusThick />
            </GlyphButton>
          )}
        </div>
        {block.options.map((o, i) => (
          <div key={o.key} className="flex w-[649px] max-w-full gap-[15px]">
            <StatSelect
              look="plain"
              label={`${ut("st.answer")} ${i + 1}`}
              value={o.optionId}
              disabled={!question}
              onChange={(optionId) => setOption(o, { optionId })}
              className="w-[277px] shrink-0"
            >
              {options.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.text}
                </option>
              ))}
            </StatSelect>
            <div aria-hidden className="min-w-0 flex-1">
              <Readout look="plain" label={`${ut("st.percent")} ${i + 1}`} />
            </div>
            <VshrToggle
              look="plain"
              pressed={o.highRisk}
              onToggle={() => setOption(o, { highRisk: !o.highRisk })}
              className="w-[65px] shrink-0"
            />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * «Вибірки» правки — по строке на колонку модели с «−». Кадром не
 * нарисовано (см. шапку файла); начертание — подпись 16/700 в залитом поле,
 * как строки фильтров f29, откуда выборки и приходят.
 */
function SamplesList({
  count,
  titles,
  onRemove,
}: {
  count: number;
  titles: (string | null)[];
  onRemove: (i: number) => void;
}) {
  const { ut } = useLang();
  return (
    <section aria-label={ut("st.samples")} className="flex flex-col gap-[15px]">
      {Array.from({ length: count }, (_, i) => {
        const name = titles[i] || `${ut("st.sample")} ${i + 1}`;
        return (
          <div key={i} className="flex items-center gap-[6px]">
            <Readout look="fill" label={name} className="w-[649px] max-w-full" />
            <GlyphButton label={`${ut("st.removeSample")}: ${name}`} onClick={() => onRemove(i)}>
              <IconMinusThick />
            </GlyphButton>
          </div>
        );
      })}
    </section>
  );
}
