import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { SurveyFull } from "@quizzy/shared";
import { api } from "../api";
import { useResource } from "../useResource";
import { useLang } from "../lang";

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

  if (error) return <p className="error">{error}</p>;
  if (!survey) return <p className="muted">{ut("common.loading")}</p>;

  const asked = survey.questions.filter((q) => q.type !== "info");
  /* Одинаковый набор вариантов на всю методику — тогда шапку можно вынести
     в заголовок таблицы и бланк сжимается с десяти листов до одного-двух */
  const shared = sharedOptions(asked);

  return (
    <>
      <h1>{ut("bf.title")}</h1>
      <p className="sub">
        <Link to={`/surveys/${survey.id}`}>{survey.title}</Link> · {asked.length} пунктов
      </p>

      <div className="card no-print">
        <p style={{ margin: 0 }}>
          Бланк для бумажного проведения. После заполнения ответы вносятся через
          «Провести» — нумерация совпадает, сверять порядок не нужно.
          {shared
            ? " Варианты одинаковы у всех пунктов, поэтому бланк выведен таблицей."
            : " Варианты у пунктов различаются, поэтому они напечатаны при каждом."}
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={() => window.print()}>{ut("kp.print")}</button>
          {shared ? (
            <button onClick={() => setCompact((v) => !v)}>
              {compact ? ut("bf.expand") : ut("bf.collapse")}
            </button>
          ) : null}
        </div>
      </div>

      <div className="card sheet">
        <div className="sheet-head">
          <h2 style={{ margin: 0 }}>{survey.title}</h2>
          {survey.instructions ? <p className="hint">{survey.instructions}</p> : null}
          <div className="fields">
            <Blank label={ut("bf.fullName")} width="100%" />
            <Blank label={ut("sch.unit")} width="55%" />
            <Blank label={ut("cmp.rank")} width="40%" />
            <Blank label={ut("bf.birthDate")} width="30%" />
            <Blank label="Пол" width="20%" />
            <Blank label={ut("bf.examDate")} width="30%" />
            <Blank label={ut("bf.psychologist")} width="45%" />
          </div>
        </div>

        {shared && compact ? (
          <GridSheet questions={asked} options={shared} />
        ) : (
          <LongSheet questions={asked} />
        )}

        <p className="hint" style={{ marginTop: 20 }}>
          Отвечайте на каждый пункт. Пропущенные пункты снижают достоверность результата.
        </p>
        <div className="fields" style={{ marginTop: 12 }}>
          <Blank label={ut("bf.signature")} width="45%" />
          <Blank label="Дата" width="25%" />
        </div>
      </div>
    </>
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
                <th style={{ width: 34 }}>№</th>
                {options.map((o) => (
                  <th key={o}>{o}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {column.map((q) => (
                <tr key={q.id}>
                  <td className="num">{q.position + 1}</td>
                  {options.map((o) => (
                    <td key={o} className="box" />
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
          <span className="q">{q.title}</span>
          {q.options.length ? (
            <span className="opts">
              {q.options.map((o) => (
                <span key={o.id} className="opt">
                  <i className="box" />
                  {o.text}
                </span>
              ))}
            </span>
          ) : (
            <span className="write-in" />
          )}
        </li>
      ))}
    </ol>
  );
}

function Blank({ label, width }: { label: string; width: string }) {
  return (
    <label className="blank" style={{ width }}>
      <span>{label}</span>
      <i />
    </label>
  );
}
