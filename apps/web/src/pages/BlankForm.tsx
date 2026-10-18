import { useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { Link, useParams } from "react-router-dom";
import type { SurveyFull } from "@quizzy/shared";
import { api } from "../api";
import { useResource } from "../useResource";
import { useLang } from "../lang";
import { Button } from "../ui/primitives";
import { Page, Panel, Stack } from "../ui/layout";
import { Loading } from "../ui";
import { fill, Mark, Sheet, SheetFoot, SheetHead, Signs } from "./printSheet";

/**
 * Пустой бланк для бумажного проведения.
 *
 * Нужен там, где планшета нет или он неуместен: полевые условия, групповое
 * обследование, отказ обследуемого от электронной формы. Ответы потом заносит
 * психолог через «Провести», поэтому нумерация бланка обязана совпадать с
 * нумерацией на экране — она берётся из той же версии методики.
 *
 * Экран — панель действий и сам лист (UI 3, print-blank): на печать идёт
 * только лист (styles/legacy.css, `data-print-sheet`), его и видно заранее.
 */
export default function BlankForm() {
  const { ut } = useLang();
  const { id } = useParams<{ id: string }>();
  /* null — по умолчанию: короткая методика — таблицей с текстом пунктов, длинная — сеткой номеров */
  const [compact, setCompact] = useState<boolean | null>(null);
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
  const grid = compact ?? asked.length > GRID_FROM;

  return (
    <Page
      title={ut("bf.title")}
      sub={
        <>
          <Link to={`/surveys/${survey.id}`}>{survey.title}</Link> · {asked.length} {ut("bt.items")}
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
            {ut("blank.paperIntro")}
            {shared ? ut("blank.sameOptionsNote") : ut("blank.differentOptionsNote")}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => window.print()}>
              {ut("kp.print")}
            </Button>
            {shared ? (
              <Button onClick={() => setCompact(!grid)}>{grid ? ut("bf.expand") : ut("bf.collapse")}</Button>
            ) : null}
          </div>
        </Panel>
        <BlankPaper survey={survey} asked={asked} shared={shared} grid={grid} />
      </Stack>
    </Page>
  );
}

/** С какого числа пунктов бланк по умолчанию — сеткой номеров (две колонки на лист) */
const GRID_FROM = 30;

function BlankPaper({ survey, asked, shared, grid }: { survey: SurveyFull; asked: Q[]; shared: string[] | null; grid: boolean }) {
  const { ut } = useLang();
  const code = `${survey.id.slice(0, 8)}·v${survey.versionNumber}`;
  const versionLabel = `${ut("ds.version")} ${survey.versionNumber}`;
  const title = fill(ut("bf.titleOf"), { title: survey.title });
  /* критический пункт есть — на бланке телефон помощи и отметка для фахівця */
  const critical = asked.some((q) => q.options.some((o) => o.riskFlag));

  return (
    <Sheet running={`${title} · ${code}`}>
      <SheetHead primary={versionLabel} secondary={survey.title} />
      <div className="ps-th">
        <h1 className="ps-t">{title}</h1>
        {/*
          Метка бланка: какая методика и какой её версии перед вами.

          Нужна прямо сейчас и без всякого распознавания отметок: заполненный
          бланк приносят через неделю, и оператор ищет методику в списке
          руками — а версий у методики несколько, и нумерация пунктов между
          ними отличается. Ввести ответы не в ту версию значит получить
          правдоподобные, но чужие баллы.

          Она же — единственная дешёвая часть фотоввода, которую стоит
          сделать заранее: распознавать отметки без указания, что это за
          лист, всё равно нельзя.
        */}
        <SheetCode surveyId={survey.id} version={survey.versionNumber} code={code} />
      </div>

      {/* строка для заполнения от руки: доли строки — по полю (ФИО шире, пол уже) */}
      <div className="ps-lines">
        <Line label={ut("bf.fullName")} span={7} />
        <Line label={ut("bf.birthDate")} span={3} />
        <Line label={ut("blank.sex")} span={2} />
        <Line label={ut("sch.unit")} span={4} />
        <Line label={ut("cmp.rank")} span={3} />
        <Line label={ut("bf.examDate")} span={2} />
        <Line label={ut("bf.psychologist")} span={3} />
      </div>

      {survey.instructions ? <div className="ps-ask">{survey.instructions}</div> : null}

      <div className="mt-2">
        {shared && grid ? (
          <GridSheet questions={asked} options={shared} />
        ) : shared ? (
          <TextSheet questions={asked} options={shared} />
        ) : (
          <LongSheet questions={asked} />
        )}
      </div>

      <p className="ps-note">{ut("blank.answerEachHint")}</p>
      <Signs items={[{ caption: ut("bf.signature") }, { caption: ut("blank.date") }]} />

      <div className={critical ? "ps-two-box" : undefined}>
        {critical ? (
          <div className="ps-box">
            <h4>{ut("bf.crisisTitle")}</h4>
            <p>
              {fill(ut("bf.crisisText"), { hotline: ut("home.hotlineNumber"), emergency: ut("ps.emergencyNumber") })}
            </p>
          </div>
        ) : null}
        <div className="ps-box ps-staff">
          <h4>{ut("bf.forStaff")}</h4>
          <div className="ps-fill">
            {ut("bf.sum")}
            <i />
          </div>
          {critical ? (
            <div className="ps-fill">
              <span className="ps-sq" aria-hidden />
              {ut("bf.criticalPassed")}
            </div>
          ) : null}
          <div className="ps-fill">
            {ut("bf.entered")}
            <i />
          </div>
        </div>
      </div>

      <div className="ps-end">
        <SheetFoot lines={[ut("bf.footEntry"), ut("bf.footNoData")]} right={code} />
      </div>
    </Sheet>
  );
}

/**
 * Код листа: методика и версия, а не ссылка на прохождение.
 *
 * Именно методика с версией, потому что бланк печатают пачкой заранее и
 * раздают неизвестно кому. Привязать лист к конкретному человеку в момент
 * печати нельзя — а если бы и было можно, пачка одинаковых листов с чужими
 * именами в коридоре хуже, чем её отсутствие.
 */
function SheetCode({ surveyId, version, code }: { surveyId: string; version: number; code: string }) {
  const { ut } = useLang();
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(`${window.location.origin}/surveys/${surveyId}/administer?v=${version}`);
    qr.make();
    return qr.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
  }, [surveyId, version]);

  return (
    <div className="ps-code">
      <div>
        <span className="mute">{ut("bf.sheetCode")}</span>
        <b>{code}</b>
        <small>{ut("bf.sheetCodeHint")}</small>
      </div>
      {/*
        biome-ignore lint/security/noDangerouslySetInnerHtml: SVG кода
        собирается здесь же из идентификатора методики и номера версии,
        никакие внешние данные в разметку не попадают
      */}
      <span className="ps-qr" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
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

/** Таблица с текстом пунктов и кружками под общими вариантами (короткие методики) */
function TextSheet({ questions, options }: { questions: Q[]; options: string[] }) {
  return (
    <table className="ps-tbl ps-form mid">
      <thead>
        <tr>
          <th className="no">№</th>
          <th />
          {options.map((o) => (
            <th key={o} className="c ps-opt">
              {o}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {questions.map((q) => (
          <tr key={q.id}>
            <td className="no">{q.position + 1}</td>
            <td>{q.title}</td>
            {options.map((o) => (
              <td key={o} className="c">
                <Mark />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Сетка номеров: две колонки на лист — 45 пунктов на одной странице вместо двух */
function GridSheet({ questions, options }: { questions: Q[]; options: string[] }) {
  const half = Math.ceil(questions.length / 2);
  const columns = [questions.slice(0, half), questions.slice(half)];
  return (
    <div className="ps-grid2">
      {columns.map((column, i) =>
        column.length ? (
          <table key={i} className="ps-tbl ps-form mid">
            <thead>
              <tr>
                <th className="no">№</th>
                {options.map((o) => (
                  <th key={o} className="c ps-opt">
                    {o}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {column.map((q) => (
                <tr key={q.id}>
                  <td className="no">{q.position + 1}</td>
                  {options.map((o) => (
                    <td key={o} className="c">
                      <Mark />
                    </td>
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

/** Пункты с разными вариантами: у каждого — свои, кружком для отметки */
function LongSheet({ questions }: { questions: Q[] }) {
  return (
    <ol className="ps-long">
      {questions.map((q) => (
        <li key={q.id}>
          <span className="no">{q.position + 1}</span>
          <div>
            <p>{q.title}</p>
            {q.options.length ? (
              <span className="ps-opts">
                {q.options.map((o) => (
                  <span key={o.id}>
                    <Mark />
                    {o.text}
                  </span>
                ))}
              </span>
            ) : (
              /* свободный ответ — место для записи от руки */
              <span aria-hidden className="ps-write" />
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Поле для заполнения от руки: линия и подпись под ней */
function Line({ label, span }: { label: string; span: number }) {
  return (
    <div className="ps-ln" style={{ gridColumn: `span ${span}` }}>
      <i />
      <span>{label}</span>
    </div>
  );
}
