import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, download } from "../api";
import { useResource } from "../useResource";
import { Loading, useAction } from "../ui";
import { Button } from "../ui/primitives";
import { Page, Panel, Stack } from "../ui/layout";
import { useLang } from "../lang";

/**
 * Печать ключей для сверки с пособием.
 *
 * Структурная проверка ловит форму ключа, но не содержание: если при переносе
 * перепутаны 47 и 74, она промолчит. Единственный способ поймать такое — сесть
 * с распечаткой и оригиналом, поэтому ключи выводятся в том же виде, в каком
 * они напечатаны в пособии.
 */
export default function KeyPrint() {
  const { ut } = useLang();
  const { id } = useParams<{ id: string }>();
  const [showItems, setShowItems] = useState(false);
  const { run } = useAction();
  const { data: sheet, error } = useResource(() => api.keySheet(id!), [id], { enabled: !!id });

  if (error)
    return (
      <p role="alert" className="text-danger">
        {error}
      </p>
    );
  if (!sheet) return <Loading rows={4} />;

  return (
    <Page
      title={ut("kp.title")}
      sub={
        <>
          <Link to={`/surveys/${sheet.surveyId}`}>{sheet.title}</Link> · {ut("ds.version")}{" "}
          {sheet.version} · {sheet.questionCount} {ut("bt.items")}
        </>
      }
      // см. пояснение в BlankForm.tsx: подстраховка от печати только видимой прокрутки
      className="print:overflow-visible"
    >
      <Stack>
        <Panel className="no-print">
          <p className="m-0 text-small text-muted">{ut("key.checkInstructions")}</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => window.print()}>
              {ut("kp.print")}
            </Button>
            <Button onClick={() => run(() => download(api.methodologyUrl(sheet.surveyId), "methodology.json"))}>
              {ut("key.exportJson")}
            </Button>
            <Link className="btn" to={`/surveys/${sheet.surveyId}/blank`}>
              {ut("kp.blank")}
            </Link>
            <Button onClick={() => setShowItems((v) => !v)}>
              {showItems ? ut("kp.hideItems") : ut("kp.showItems")}
            </Button>
          </div>
        </Panel>

        {sheet.scales.map((s) => (
          <Panel
            key={s.code}
            title={
              <>
                {s.code} — {s.title}
              </>
            }
            hint={
              <>
                {s.kind === "validity" ? ut("kp.validityScale") : ut("kp.clinicalScale")} ·{" "}
                {{ raw: ut("kp.rawScore"), ratio: ut("kp.ratio"), tscore: ut("co.tScores"), sten: ut("kp.stens") }[
                  s.normalization
                ] ?? s.normalization}{" "}
                · {ut("key.itemsInKey")} {s.itemCount}
              </>
            }
          >
            <table>
              <tbody>
                {s.yes ? (
                  <tr>
                    <td className="w-[130px]">{ut("kp.answerYes")}</td>
                    <td className="tabular-nums">{s.yes}</td>
                  </tr>
                ) : null}
                {s.no ? (
                  <tr>
                    <td>{ut("kp.answerNo")}</td>
                    <td className="tabular-nums">{s.no}</td>
                  </tr>
                ) : null}
                {s.scored ? (
                  <tr>
                    <td>{ut("kp.byOptionScores")}</td>
                    <td className="tabular-nums">{s.scored}</td>
                  </tr>
                ) : null}
                {s.corrections ? (
                  <tr>
                    <td>{ut("kp.corrections")}</td>
                    <td>{s.corrections}</td>
                  </tr>
                ) : null}
                {s.norms ? (
                  <tr>
                    <td>{ut("kp.norms")}</td>
                    <td>{s.norms}</td>
                  </tr>
                ) : null}
                {s.stens ? (
                  <tr>
                    <td>{ut("cs.sten")}</td>
                    <td className="tabular-nums">{s.stens}</td>
                  </tr>
                ) : null}
                {s.bands ? (
                  <tr>
                    <td>{ut("kp.interpretation")}</td>
                    <td className="text-muted">{s.bands}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </Panel>
        ))}

        {showItems ? (
          <Panel title={ut("kp.items")} hint={ut("kp.itemsHint")}>
            <div className="scroll-x">
              <table>
                <tbody>
                  {sheet.questions.map((q) => (
                    <tr key={q.n}>
                      <td className="num w-[50px]">{q.n}</td>
                      <td>{q.title}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        ) : null}
      </Stack>
    </Page>
  );
}
