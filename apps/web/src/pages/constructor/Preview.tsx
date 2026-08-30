import { useMemo, useState } from "react";
import { computeProfile, type Answer } from "@quizzy/shared";
import { useLang } from "../../lang";
import { draftToSurvey, type Draft } from "./model";
import { Button } from "../../ui/primitives";

/**
 * Живой предпросмотр методики.
 *
 * Раньше методику собирали вслепую: как выглядит пункт на телефоне, было
 * видно только после публикации и прохождения. Длинная формулировка,
 * не влезающая в экран, обнаруживалась на пациенте.
 *
 * Показывается ровно то, что увидит человек: заголовок, пояснение, варианты в
 * заданном порядке. Ключи, баллы и флаги риска сюда не попадают намеренно —
 * пациент их не видит, и предпросмотр, показывающий больше, чем реальность,
 * не отвечает на вопрос, ради которого существует.
 *
 * Второй режим — проверка ключа. Там варианты выбираются, и внизу считаются
 * баллы тем же движком, что и на сервере: перенос методики из пособия иначе
 * проверялся только после публикации — заполнить, сдать, посмотреть, вернуться
 * в конструктор. Общий движок важен: своя реализация подсчёта в редакторе
 * отвечала бы на вопрос «сходятся ли две реализации», а не «верен ли ключ».
 */
export function Preview({ draft, at: focused }: { draft: Draft; at?: number }) {
  const { ut, lang } = useLang();
  const [at, setAt] = useState(0);
  const [checking, setChecking] = useState(false);
  const [picked, setPicked] = useState<Map<string, string>>(new Map());

  /*
   * Предпросмотр идёт за правкой, но человек может листать его и сам. Поэтому
   * внешний номер не подменяет внутренний, а сдвигает его: перелистнул —
   * смотришь туда, куда перелистнул, пока не тронешь другой пункт.
   */
  const [lastFocused, setLastFocused] = useState(focused ?? 0);
  if (focused !== undefined && focused !== lastFocused) {
    setLastFocused(focused);
    setAt(focused);
  }

  const asked = draft.questions.filter((q) => q.type !== "info");
  const shown = draft.questions;
  const current = shown[Math.min(at, Math.max(0, shown.length - 1))];

  const text = (value: Record<string, string> | null | undefined): string =>
    value?.[lang] || value?.uk || value?.ru || "";

  /*
   * Профиль пересчитывается на каждый выбор. Дёшево: методика уже в памяти, а
   * подсчёт — чистая функция без обращений к сети.
   */
  const profile = useMemo(() => {
    if (!checking) return null;
    const survey = draftToSurvey(draft, lang);
    const answers: Answer[] = [...picked.entries()].map(([questionId, optionId]) => ({
      questionId,
      optionIds: [optionId],
    }));
    try {
      return computeProfile(survey, answers);
    } catch {
      // недостроенный ключ — не повод ронять редактор
      return null;
    }
  }, [checking, draft, lang, picked]);

  if (!shown.length) {
    return (
      <div className="preview">
        <div className="preview-phone">
          <p className="m-auto text-center text-muted">
            {ut("co.previewEmpty")}
          </p>
        </div>
      </div>
    );
  }

  const askedIndex = asked.findIndex((q) => q.uid === current?.uid);

  return (
    <div className="preview">
      <div className="preview-phone">
        {draft.showProgress && askedIndex >= 0 ? (
          <div className="preview-progress">
            <div
              className="preview-progress-fill"
              style={{ width: `${((askedIndex + 1) / Math.max(1, asked.length)) * 100}%` }}
            />
          </div>
        ) : null}

        <div className="preview-screen">
          {current?.type === "info" ? (
            <p className="preview-info">{text(current.title)}</p>
          ) : (
            <>
              <p className="preview-question">
                {text(current?.title) || <span className="text-muted">{ut("co.previewNoText")}</span>}
                {current?.required ? <span className="preview-required"> *</span> : null}
              </p>
              {current?.help ? <p className="preview-help">{text(current.help)}</p> : null}

              {/*
                В режиме вида варианты не кликаются: кликабельный, но ничего не
                делающий элемент — обещание, которое интерфейс не выполняет.
                В режиме проверки ключа они выбираются, потому что там это и
                есть работа.
              */}
              <div className="preview-options">
                {current?.options.length ? (
                  current.options.map((o, i) => {
                    const qid = `q${shown.indexOf(current) + 1}`;
                    const oid = `${qid}o${i + 1}`;
                    const on = picked.get(qid) === oid;
                    return checking ? (
                      <button
                        key={i}
                        className={`preview-option${on ? " on" : ""}`}
                        aria-pressed={on}
                        onClick={() =>
                          setPicked((prev) => {
                            const next = new Map(prev);
                            next.set(qid, oid);
                            return next;
                          })
                        }
                      >
                        {text(o.text) || "—"}
                        {o.score !== undefined ? <span className="text-muted"> {o.score}</span> : null}
                      </button>
                    ) : (
                      <div key={i} className="preview-option">
                        {text(o.text) || <span className="text-muted">—</span>}
                      </div>
                    );
                  })
                ) : (
                  <p className="text-muted">{ut("co.previewNoOptions")}</p>
                )}
              </div>
            </>
          )}
        </div>

        <div className="preview-nav">
          <Button variant="quiet" size="sm" disabled={at === 0} onClick={() => setAt((v) => Math.max(0, v - 1))}>
            ←
          </Button>
          <span className="text-muted">
            {Math.min(at, shown.length - 1) + 1} / {shown.length}
          </span>
          <Button
            variant="quiet"
            size="sm"
            disabled={at >= shown.length - 1}
            onClick={() => setAt((v) => Math.min(shown.length - 1, v + 1))}
          >
            →
          </Button>
        </div>
      </div>

      {/* переключатель режима — тот же язык, что у вкладок экрана: активная
          вкладка держится бирюзовым подчёркиванием, а не янтарём */}
      <div className="tabs mb-0">
        <button className={checking ? "" : "active"} onClick={() => setChecking(false)}>
          {ut("co.preview")}
        </button>
        <button className={checking ? "active" : ""} onClick={() => setChecking(true)}>
          {ut("co.keyCheck")}
        </button>
      </div>
      {checking && picked.size ? (
        <Button variant="quiet" size="sm" onClick={() => setPicked(new Map())}>
          {ut("co.keyReset")}
        </Button>
      ) : null}

      {checking ? (
        <div className="key-check">
          <p className="m-0 text-caption text-muted">
            {ut("co.keyHint")} · {picked.size}/{asked.length}
          </p>
          {profile?.scores.length ? (
            <table>
              <tbody>
                {profile.scores.map((sc) => (
                  <tr key={sc.scaleCode}>
                    <td>{sc.scaleCode}</td>
                    <td className="num">{sc.rawScore}</td>
                    <td className="num">
                      {sc.normalization === "raw" ? "—" : sc.value}
                    </td>
                    <td className="text-muted">{sc.band?.label ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="m-0 text-muted">{ut("co.keyNoScales")}</p>
          )}
          {profile?.warnings.length ? (
            <ul className="key-warn">
              {profile.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <p className="text-center text-caption text-muted">
          {ut("co.previewHint")}
        </p>
      )}
    </div>
  );
}
