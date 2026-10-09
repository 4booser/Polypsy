import { useState } from "react";
import { Link } from "react-router-dom";
import type { RuleHit } from "@quizzy/shared";
import { api, ApiError } from "../api";
import { dateTime } from "../format";
import { useLang } from "../lang";
import type { UiKey } from "@quizzy/shared";
import { useResource, type Resource } from "../useResource";
import { NotLoaded, useAction } from "../ui";
import { Panel } from "../ui/layout";
import { Button, Input } from "../ui/primitives";

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
  const res = useResource(() => api.ruleHits(), []);
  return <SuggestionsBody res={res} />;
}

/**
 * Решение по предложению — и что делать, если его успел принять другой.
 *
 * Сервер записывает решение только поверх «предложено» (#104): второй из
 * двух одновременных получает 409 err.hitDecidedMeanwhile. Прежде экран
 * показывал отказ всплывающим уведомлением и оставлял в списке уже
 * решённое предложение с живыми кнопками; следующее нажатие получало 400
 * «уже решено», и так до ручного обновления страницы. Теперь на 409 список
 * перечитывается (решённое из него уходит), а фраза сервера возвращается
 * экрану — он ставит её над списком, а не в исчезающее уведомление (w19:ui).
 * Прочие отказы уходят дальше как были: их показывает useAction.
 *
 * Без React — ради проверки на подставном запросе (test/suggestions.test.ts).
 */
export async function decideHit(
  send: () => Promise<unknown>,
  reload: () => void,
): Promise<{ meanwhile: string | null }> {
  try {
    await send();
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 409) throw e;
    reload();
    return { meanwhile: e.message };
  }
  reload();
  return { meanwhile: null };
}

/**
 * Показывать ли панель: есть предложения — или есть что сказать о том, куда
 * делось последнее (его решил другой, и список опустел).
 */
export function suggestionsShown(count: number, meanwhile: string | null): boolean {
  return count > 0 || !!meanwhile;
}

/**
 * Панель по загрузке — без запроса внутри (test/loadStates.test.tsx).
 *
 * Пустой ответ — панели нет: предложений нет, и говорить не о чем. Отказ
 * — панель есть и говорит об отказе. Раньше отказ выглядел так же, как
 * «предложений нет»: панель просто не появлялась, и сработавшие правила
 * (повод пересмотреть случай) не видел никто, включая того, кто их завёл.
 */
export function SuggestionsBody({
  res,
}: {
  res: Pick<Resource<RuleHit[]>, "data" | "error" | "loading" | "reload">;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [declining, setDeclining] = useState<string | null>(null);
  const [note, setNote] = useState("");
  /* фраза сервера о решении, принятом другим, пока человек смотрел (409, см. decideHit) */
  const [meanwhile, setMeanwhile] = useState<string | null>(null);

  /*
   * Одно действие на обе кнопки. На 409 нечего подтверждать: run получает
   * false и молчит, а фраза встаёт над списком; набранное возражение
   * к исчезнувшему предложению сбрасывается вместе с ним.
   */
  const decide = (hit: RuleHit, status: "accepted" | "declined", done: string, why?: string) =>
    void run(async () => {
      setMeanwhile(null);
      const outcome = await decideHit(() => api.decideHit(hit.id, status, why), res.reload);
      if (declining === hit.id) {
        setDeclining(null);
        setNote("");
      }
      if (!outcome.meanwhile) return true;
      setMeanwhile(outcome.meanwhile);
      return false;
    }, done);

  if (res.data === null) {
    return res.error ? (
      <Panel title={ut("ds.title")}>
        <NotLoaded res={res} />
      </Panel>
    ) : null;
  }
  const items = res.data;
  if (!suggestionsShown(items.length, meanwhile)) return null;

  return (
    <Panel title={ut("ds.title")} actions={<span className="text-caption text-muted">{ut("ds.sub")}</span>}>
      <div className="suggestions">
        {/*
          Не цвет внимания: предложение — не тревога (см. .suggestion), и
          сообщение о нём тоже. role="status" — диктор прочтёт, почему
          строка, на которую нажимали, пропала.
        */}
        {meanwhile ? (
          <p role="status" className="m-0 text-caption">
            {meanwhile}
          </p>
        ) : null}
        {items.map((hit: RuleHit) => (
          <article key={hit.id} className="suggestion">
            <div className="row tight">
              <strong>{hit.ruleTitle}</strong>
              <span className="text-muted">
                {ut("ds.version")} {hit.ruleVersion} · {dateTime(hit.createdAt)}
              </span>
            </div>

            <Link to={`/patients/${hit.userId}`}>{hit.userName}</Link>

            {/* объяснение — то, на основании чего человек примет решение */}
            <ul className="because">
              {hit.explanation.because.map((b, i) => (
                <li key={i}>{b.text}</li>
              ))}
            </ul>

            <p className="text-caption text-muted">
              {hit.explanation.actions.map((a) => actionText(a, ut)).join(" · ")}
            </p>

            {declining === hit.id ? (
              <div className="row tight">
                <Input
                  autoFocus
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={ut("ds.whyDecline")}
                />
                <Button
                  disabled={busy || !note.trim()}
                  onClick={() => decide(hit, "declined", ut("ds.declined"), note.trim())}
                >
                  {ut("ds.decline")}
                </Button>
                <Button variant="quiet" onClick={() => setDeclining(null)}>
                  {ut("common.cancel")}
                </Button>
              </div>
            ) : (
              <div className="row tight">
                <Button variant="primary" disabled={busy} onClick={() => decide(hit, "accepted", ut("ds.accepted"))}>
                  {ut("ds.accept")}
                </Button>
                <Button disabled={busy} onClick={() => setDeclining(hit.id)}>
                  {ut("ds.decline")}
                </Button>
              </div>
            )}
          </article>
        ))}
      </div>
    </Panel>
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
