import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { SurveyFull } from "@quizzy/shared";
import { api } from "../api";
import { useResource } from "../useResource";
import { useLang } from "../lang";
import { Button } from "../ui/primitives";
import { Page, Panel, Stack } from "../ui/layout";
import { Loading } from "../ui";

/**
 * Пустой бланк для бумажного проведения.
 *
 * Нужен там, где планшета нет или он неуместен: полевые условия, групповое
 * обследование, отказ обследуемого от электронной формы. Ответы потом заносит
 * психолог через «Провести», поэтому нумерация бланка обязана совпадать с
 * нумерацией на экране — она берётся из той же версии методики.
 */
export default function BlankForm() {
  const { ut } = useLang();
  const { id } = useParams<{ id: string }>();
  const [compact, setCompact] = useState(true);
  const { data: survey, error } = useResource(() => api.survey(id!), [id], { enabled: !!id });

  if (error)
    return (
      <p role="alert" className="text-danger">
        {error}
      </p>
    );
  if (!survey) return <Loading rows={4} />;

  const asked = survey.questions.filter((q) => q.type !== "info");
  /* Одинаковый набор вариантов на всю методику — тогда шапку можно вынести
     в заголовок таблицы и бланк сжимается с десяти листов до одного-двух */
  const shared = sharedOptions(asked);

  return (
    <Page
      title={ut("bf.title")}
      sub={
        <>
          <Link to={`/surveys/${survey.id}`}>{survey.title}</Link> · {asked.length} пунктов
        </>
      }
      /*
       * Рамка экрана прокручивает содержимое сама (`overflow-y-auto`) — приём
       * для ещё не перенесённых соседей, у бумажного бланка внутри неё нет
       * своей высоты, только длинный список пунктов. При печати это не должно
       * означать «видна только прокрученная страница»: подстраховываемся явным
       * `overflow: visible` под печать, не трогая styles/*.css.
       */
      className="print:overflow-visible"
    >
      <Stack>
        <Panel className="no-print">
          <p className="m-0 text-small text-muted">
            Бланк для бумажного проведения. После заполнения ответы вносятся через
            «Провести» — нумерация совпадает, сверять порядок не нужно.
            {shared
              ? " Варианты одинаковы у всех пунктов, поэтому бланк выведен таблицей."
              : " Варианты у пунктов различаются, поэтому они напечатаны при каждом."}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => window.print()}>
              {ut("kp.print")}
            </Button>
            {shared ? (
              <Button onClick={() => setCompact((v) => !v)}>
                {compact ? ut("bf.expand") : ut("bf.collapse")}
              </Button>
            ) : null}
          </div>
        </Panel>

        <Panel title={survey.title} hint={survey.instructions}>
          {/*
            Раньше строка вёрсталась CSS-гридом (.fields), где явная ширина
            каждого поля ничего не решала — грид сам режет на равные колонки,
            и «ФИО на всю строку, дата рождения/пол/дата обследования в одну»
            не собиралось. Флекс с переносом — то, что действительно уважает
            проценты ширины ниже.
          */}
          <div className="flex flex-wrap gap-3">
            <Blank label={ut("bf.fullName")} width="100%" />
            <Blank label={ut("sch.unit")} width="55%" />
            <Blank label={ut("cmp.rank")} width="40%" />
            <Blank label={ut("bf.birthDate")} width="30%" />
            <Blank label="Пол" width="20%" />
            <Blank label={ut("bf.examDate")} width="30%" />
            <Blank label={ut("bf.psychologist")} width="45%" />
          </div>

          <div className="mt-5">
            {shared && compact ? (
              <GridSheet questions={asked} options={shared} />
            ) : (
              <LongSheet questions={asked} />
            )}
          </div>

          <p className="mt-5 text-caption text-muted">
            Отвечайте на каждый пункт. Пропущенные пункты снижают достоверность результата.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Blank label={ut("bf.signature")} width="45%" />
            <Blank label="Дата" width="25%" />
          </div>
        </Panel>
      </Stack>
    </Page>
  );
}

type Q = SurveyFull["questions"][number];

/** Общий набор вариантов, если он один на всю методику */
function sharedOptions(questions: Q[]): string[] | null {
  const withOptions = questions.filter((q) => q.options.length);
  if (withOptions.length !== questions.length || !withOptions.length) return null;
  const first = withOptions[0]!.options.map((o) => o.text);
  const same = withOptions.every(
    (q) =>
      q.options.length === first.length && q.options.every((o, i) => o.text === first[i]),
  );
  return same ? first : null;
}

function GridSheet({ questions, options }: { questions: Q[]; options: string[] }) {
  /* Две колонки на лист: 45 пунктов помещаются на одну страницу вместо двух */
  const half = Math.ceil(questions.length / 2);
  const columns = [questions.slice(0, half), questions.slice(half)];
  return (
    <div className="grid-sheet">
      {columns.map((column, i) =>
        column.length ? (
          <table key={i} className="blank-grid">
            <thead>
              <tr>
                <th className="w-[34px]">№</th>
                {options.map((o) => (
                  <th key={o}>{o}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {column.map((q) => (
                <tr key={q.id}>
                  <td className="num">{q.position + 1}</td>
                  {/* клетка отмечается прямо в рамке ячейки .blank-grid td — своя рамка внутри не нужна */}
                  {options.map((o) => (
                    <td key={o} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : null,
      )}
    </div>
  );
}

function LongSheet({ questions }: { questions: Q[] }) {
  return (
    <ol className="blank-list">
      {questions.map((q) => (
        <li key={q.id} value={q.position + 1}>
          <span className="text-small">{q.title}</span>
          {q.options.length ? (
            <span className="mt-1 flex flex-col gap-1">
              {q.options.map((o) => (
                <span key={o.id} className="opt">
                  {/*
                    Квадрат для отметки. У .box в наследии не было ни рамки, ни
                    размера — на бумаге печаталось пустое место без метки,
                    ставить крестик было некуда. Рамка держится на токене
                    границы, который печать переопределяет в #777 — видна и на
                    экране, и на бумаге.
                  */}
                  <i aria-hidden className="inline-block size-3 shrink-0 border border-border-strong align-middle" />
                  {o.text}
                </span>
              ))}
            </span>
          ) : (
            <span
              aria-hidden
              className="mt-1 block h-9 rounded-sm border border-dashed border-border-strong"
            />
          )}
        </li>
      ))}
    </ol>
  );
}

function Blank({ label, width }: { label: string; width: string }) {
  return (
    /*
     * Ширина — доля строки конкретного поля бланка (ФИО во всю строку,
     * подразделение и звание делят строку пополам), у неё нет своего
     * тейлвиновского шага: это тот самый «рантайм»-случай из REDESIGN.md —
     * параметр компонента, а не константа разметки.
     */
    <label className="blank" style={{ width }}>
      <span>{label}</span>
      {/* строка для заполнения от руки — раньше здесь не было ни рамки, ни высоты */}
      <i aria-hidden className="mt-1 block h-5 border-b border-border-strong" />
    </label>
  );
}
