import { useState } from "react";
import { Link } from "react-router-dom";
import type { RuleHit } from "@quizzy/shared";
import { api, ApiError } from "../api";
import { useLang } from "../lang";
import type { UiKey } from "@quizzy/shared";
import { useResource, type Resource } from "../useResource";
import { shortDate, splitCode } from "../pages/methods/model";
import { basisText, suggestionOpen } from "../pages/methods/passport";
import { Ic, NotLoaded, useAction } from "../ui";
import { Panel } from "../ui/layout";
import { Button, Input, Tag } from "../ui/primitives";

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

/** Сколько предложений видно сразу: остальные — по «Показати всі» */
const SHOWN = 5;

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
 * «Призначити PHQ-9» одним нажатием: выдать предложенную методику человеку и
 * принять предложение (ступенчатый скрининг каталога — протокол короткой
 * формы, ящик назначения в карточке).
 *
 * Сначала выдача, потом решение: не выданную методику нельзя записать как
 * «прийнято» — специалист согласился именно назначить. Выдача отказала (нет
 * права, человек вне зоны) — предложение остаётся предложенным, отказ уходит
 * выше. Решение тем временем принял другой (409) — выдача уже сделана, и она
 * верна: список перечитывается, фраза сервера возвращается (decideHit).
 */
export async function assignSuggested(
  hit: Pick<RuleHit, "id" | "userId">,
  surveyId: string,
  grant: (surveyId: string, userId: string) => Promise<unknown>,
  accept: () => Promise<unknown>,
  reload: () => void,
): Promise<{ meanwhile: string | null }> {
  await grant(surveyId, hit.userId);
  return decideHit(accept, reload);
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
  const { ut, lang } = useLang();
  const { run, busy } = useAction();
  const [declining, setDeclining] = useState<string | null>(null);
  /* все предложения или первые SHOWN: десять правил каталога на отделение — это десятки строк, а не одна */
  const [all, setAll] = useState(false);
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

  /* «Призначити PHQ-9»: выдать предложенную методику и принять предложение разом (assignSuggested) */
  const assign = (hit: RuleHit, surveyId: string, code: string) =>
    void run(async () => {
      setMeanwhile(null);
      const outcome = await assignSuggested(
        hit,
        surveyId,
        (sid, userId) => api.grant(sid, userId, undefined, null),
        () => api.decideHit(hit.id, "accepted"),
        res.reload,
      );
      if (!outcome.meanwhile) return true;
      setMeanwhile(outcome.meanwhile);
      return false;
    }, ut("dpc.assignedToast").replace("{code}", code));

  if (res.data === null) {
    return res.error ? (
      <Panel title={ut("rp.rules")}>
        <NotLoaded res={res} />
      </Panel>
    ) : null;
  }
  const items = res.data;
  if (!suggestionsShown(items.length, meanwhile)) return null;

  return (
    <Panel title={ut("rp.rules")} icon={<Ic.sparkle />} sub={ut("ds.sub")} flush>
      <div className="flex flex-col border-t border-divider">
        {/*
          Не цвет внимания: предложение — не тревога, и сообщение о нём тоже.
          role="status" — диктор прочтёт, почему строка, на которую нажимали,
          пропала.
        */}
        {meanwhile ? (
          <p role="status" className="m-0 border-b border-divider px-4 py-2.5 text-small text-text-2">
            {meanwhile}
          </p>
        ) : null}
        {(all ? items : items.slice(0, SHOWN)).map((hit: RuleHit) => {
          /* предложенная методика, которую можно назначить одним нажатием: самоотчёт, не назначена и не пройдена */
          const target = hit.suggested?.find((x) => !x.clinician && suggestionOpen(x)) ?? null;
          const code = target ? (splitCode(target.title).code ?? target.title) : null;
          return (
            <article key={hit.id} data-suggestion="" className="flex flex-col gap-1.5 border-b border-divider px-4 py-2.5 last:border-b-0">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                  <Link to={`/patients/${hit.userId}`} className="font-extrabold text-violet-ink">
                    {hit.userName}
                  </Link>
                  <b className="font-bold text-text">{hit.ruleTitle}</b>
                  <span className="text-small text-muted">{shortDate(hit.createdAt)}</span>
                </div>
                {declining === hit.id ? null : (
                  <div className="flex shrink-0 flex-wrap gap-1.5">
                    {target && code ? (
                      <Button size="xs" variant="primary" disabled={busy} onClick={() => assign(hit, target.surveyId, code)}>
                        {ut("dpc.assignOne").replace("{code}", code)}
                      </Button>
                    ) : (
                      <Button size="xs" variant="primary" disabled={busy} onClick={() => decide(hit, "accepted", ut("ds.accepted"))}>
                        {ut("ds.accept")}
                      </Button>
                    )}
                    <Button size="xs" disabled={busy} onClick={() => setDeclining(hit.id)}>
                      {ut("ds.decline")}
                    </Button>
                  </div>
                )}
              </div>

              {/*
                Объяснение — то, на основании чего человек примет решение. У
                предложения методики (шаг скрининга каталога) — баллом методики
                («PHQ-2 = 4»), а не условием движка («PHQ2: сирий бал 4 >= 3»);
                у остальных правил отделения — их фразами, со шкалой и порогом:
                у многошкальной методики балл без шкалы ничего не объясняет.
              */}
              <ul data-because="" className="m-0 flex list-none flex-col gap-0.5 p-0 text-small text-text-2">
                {hit.suggested?.length && hit.basis?.length ? (
                  <li>{basisText(hit, lang)}</li>
                ) : (
                  hit.explanation.because.map((b, i) => <li key={i}>{b.text}</li>)
                )}
              </ul>

              {!target && hit.explanation.actions.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {hit.explanation.actions.map((a, i) => (
                    <Tag key={i} tone="primary">
                      {actionText(a, ut, hit)}
                    </Tag>
                  ))}
                </div>
              ) : null}

              {declining === hit.id ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    autoFocus
                    className="min-w-[220px] flex-1"
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
              ) : null}
            </article>
          );
        })}
        {items.length > SHOWN ? (
          <button
            type="button"
            onClick={() => setAll((v) => !v)}
            className="cursor-pointer border-0 bg-transparent px-4 py-2.5 text-left text-small font-bold text-violet-ink hover:underline"
          >
            {all ? ut("ds.showFewer") : ut("ds.showAll").replace("{n}", String(items.length))}
          </button>
        ) : null}
      </div>
    </Panel>
  );
}

function actionText(
  action: RuleHit["explanation"]["actions"][number],
  ut: (key: UiKey) => string,
  hit: Pick<RuleHit, "suggested">,
): string {
  switch (action.kind) {
    case "notify_duty":
      return ut("ds.actNotifyDuty");
    case "suggest_survey": {
      // предложенная методика — кодом («Рекомендовано: PHQ-9»), а не «запропонувати методику»
      const title = hit.suggested?.find((x) => x.surveyId === action.surveyId)?.title;
      return title ? ut("dpc.recommended").replace("{code}", splitCode(title).code ?? title) : ut("ds.actSurvey");
    }
    case "suggest_pathway":
      return ut("ds.actPathway");
    case "advise":
      return action.text;
  }
}
