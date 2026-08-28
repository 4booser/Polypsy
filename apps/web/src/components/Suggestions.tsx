import { useState } from "react";
import { Link } from "react-router-dom";
import type { RuleHit } from "@quizzy/shared";
import { api } from "../api";
import { dateTime } from "../format";
import { useLang } from "../lang";
import type { UiKey } from "@quizzy/shared";
import { useResource } from "../useResource";
import { useAction } from "../ui";

/**
 * Предложения правил.
 *
 * Система предлагает, человек решает. Поэтому здесь нет ничего похожего на
 * «применить» одним нажатием без разбора: сначала видно, почему правило
 * сработало — с числами, а не со словом «сработало», — и только потом две
 * равноправные кнопки.
 *
 * Отклонение требует объяснения, принятие — нет. Принять значит согласиться с
 * уже написанным объяснением; отклонить — возразить ему, и возражение должно
 * остаться в истории случая: иначе разобрать потом, почему сигнал
 * проигнорировали, будет не по чему.
 */
export function Suggestions() {
  const { ut } = useLang();
  const res = useResource(() => api.ruleHits(), []);
  const { run, busy } = useAction();
  const [declining, setDeclining] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const items = res.data ?? [];
  if (!items.length) return null;

  return (
    <section className="card">
      <div className="card-head">
        <h3>{ut("ds.title")}</h3>
        <span className="muted">{ut("ds.sub")}</span>
      </div>

      <div className="suggestions">
        {items.map((hit: RuleHit) => (
          <article key={hit.id} className="suggestion">
            <div className="row tight">
              <strong>{hit.ruleTitle}</strong>
              <span className="muted">
                {ut("ds.version")} {hit.ruleVersion} · {dateTime(hit.createdAt)}
              </span>
            </div>

            <Link to={`/patients/${hit.userId}/summary`}>{hit.userName}</Link>

            {/* объяснение — то, на основании чего человек примет решение */}
            <ul className="because">
              {hit.explanation.because.map((b, i) => (
                <li key={i}>{b.text}</li>
              ))}
            </ul>

            <p className="hint">
              {hit.explanation.actions.map((a) => actionText(a, ut)).join(" · ")}
            </p>

            {declining === hit.id ? (
              <div className="row tight">
                <input
                  autoFocus
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={ut("ds.whyDecline")}
                />
                <button
                  disabled={busy || !note.trim()}
                  onClick={() =>
                    void run(async () => {
                      await api.decideHit(hit.id, "declined", note.trim());
                      setDeclining(null);
                      setNote("");
                      res.reload();
                    }, ut("ds.declined"))
                  }
                >
                  {ut("ds.decline")}
                </button>
                <button className="ghost" onClick={() => setDeclining(null)}>
                  {ut("common.cancel")}
                </button>
              </div>
            ) : (
              <div className="row tight">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api.decideHit(hit.id, "accepted");
                      res.reload();
                    }, ut("ds.accepted"))
                  }
                >
                  {ut("ds.accept")}
                </button>
                <button disabled={busy} onClick={() => setDeclining(hit.id)}>
                  {ut("ds.decline")}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function actionText(
  action: RuleHit["explanation"]["actions"][number],
  ut: (key: UiKey) => string,
): string {
  switch (action.kind) {
    case "notify_duty":
      return ut("ds.actNotifyDuty");
    case "suggest_survey":
      return ut("ds.actSurvey");
    case "suggest_pathway":
      return ut("ds.actPathway");
    case "advise":
      return action.text;
  }
}
