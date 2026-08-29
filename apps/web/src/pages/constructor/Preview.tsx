import { useState } from "react";
import { useLang } from "../../lang";
import type { Draft } from "./model";

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
 */
export function Preview({ draft, at: focused }: { draft: Draft; at?: number }) {
  const { ut, lang } = useLang();
  const [at, setAt] = useState(0);

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

  if (!shown.length) {
    return (
      <div className="preview">
        <div className="preview-phone">
          <p className="muted" style={{ margin: "auto", textAlign: "center" }}>
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
                {text(current?.title) || <span className="muted">{ut("co.previewNoText")}</span>}
                {current?.required ? <span className="preview-required"> *</span> : null}
              </p>
              {current?.help ? <p className="preview-help">{text(current.help)}</p> : null}

              {/*
                Варианты не кликаются: это предпросмотр вида, а не прохождение.
                Кликабельный, но ничего не делающий элемент — обещание, которое
                интерфейс не выполняет.
              */}
              <div className="preview-options">
                {current?.options.length ? (
                  current.options.map((o, i) => (
                    <div key={i} className="preview-option">
                      {text(o.text) || <span className="muted">—</span>}
                    </div>
                  ))
                ) : (
                  <p className="muted">{ut("co.previewNoOptions")}</p>
                )}
              </div>
            </>
          )}
        </div>

        <div className="preview-nav">
          <button disabled={at === 0} onClick={() => setAt((v) => Math.max(0, v - 1))}>
            ←
          </button>
          <span className="muted">
            {Math.min(at, shown.length - 1) + 1} / {shown.length}
          </span>
          <button
            disabled={at >= shown.length - 1}
            onClick={() => setAt((v) => Math.min(shown.length - 1, v + 1))}
          >
            →
          </button>
        </div>
      </div>

      <p className="hint" style={{ textAlign: "center" }}>
        {ut("co.previewHint")}
      </p>
    </div>
  );
}
