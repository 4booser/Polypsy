import { useEffect, useState } from "react";
import { api, type NoteVersion } from "../api";
import { day } from "../format";
import { useAction } from "../ui";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import type { UiKey } from "@quizzy/shared";

/**
 * Заметки приёма.
 *
 * Заключение отвечает на вопрос «что показала методика»; приём бывает и без
 * методики — беседа, наблюдение, звонок командиру. Раньше такую запись было
 * некуда положить, и она уходила в тетрадь, где её не видит ни второй
 * специалист, ни консилиум.
 *
 * Правила те же, что у заключения: подписанное неизменно, правка создаёт
 * новую версию, подписывается ровно та версия, что была на экране.
 */

const KIND_KEY = {
  intake: "note.intake",
  session: "note.session",
  observation: "note.observation",
  consult: "note.consult",
} as const satisfies Record<NoteVersion["kind"], UiKey>;

export function NotesEditor({ userId }: { userId: string }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [text, setText] = useState("");
  const [kind, setKind] = useState<NoteVersion["kind"]>("session");
  const [showHistory, setShowHistory] = useState(false);

  const res = useResource(() => api.notes(userId), [userId]);
  const state = res.data;

  // черновик подставляется один раз на загрузку: иначе затирался бы набор
  useEffect(() => {
    const current = res.data?.current;
    setText(current?.status === "draft" ? current.text : "");
    if (current?.status === "draft") setKind(current.kind);
  }, [res.data]);

  if (!state) {
    return res.error ? (
      <p className="muted">
        {ut("note.loadFailed")}: {res.error}
      </p>
    ) : (
      <p className="muted">{ut("common.loading")}</p>
    );
  }

  const draft = state.current?.status === "draft" ? state.current : null;
  const signed = state.versions.find((v) => v.status === "signed");

  return (
    <div className="nested">
      <div className="card-head">
        <h3>{ut("note.title")}</h3>
        {state.versions.length > 1 ? (
          <button className="ghost" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? ut("cn.hideHistory") : `${ut("note.history")} (${state.versions.length})`}
          </button>
        ) : null}
      </div>

      {signed && !draft ? (
        <div className="conclusion-view">
          <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{state.current!.text}</p>
          <p className="hint">
            {ut(KIND_KEY[state.current!.kind])} · {state.current!.authorName},{" "}
            {day(state.current!.signedAt!)} · {ut("note.version")} {state.current!.version}
          </p>
        </div>
      ) : null}

      <div className="row tight" style={{ marginBottom: 8 }}>
        {(Object.keys(KIND_KEY) as NoteVersion["kind"][]).map((k) => (
          <button
            key={k}
            className={`chip${kind === k ? " active" : ""}`}
            onClick={() => setKind(k)}
          >
            {ut(KIND_KEY[k])}
          </button>
        ))}
      </div>

      <textarea
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={signed ? ut("note.placeholderNext") : ut("note.placeholder")}
      />

      <div className="row" style={{ marginTop: 8 }}>
        <button
          disabled={busy || (!text.trim())}
          onClick={() =>
            void run(async () => {
              res.patch(await api.saveNote(userId, text, state.current?.version ?? 0, kind));
            }, ut("cn.draftSaved"))
          }
        >
          {ut("note.saveDraft")}
        </button>
        <button
          className="primary"
          disabled={busy || (!draft && !text.trim())}
          onClick={() =>
            void run(async () => {
              let latest = state;
              if (text.trim() && text !== draft?.text) {
                latest = await api.saveNote(userId, text, state.current?.version ?? 0, kind);
              }
              // подписываем ровно ту версию, что вернуло сохранение
              res.patch(await api.signNote(userId, latest.current!.version));
              setText("");
            }, ut("note.signed"))
          }
        >
          {ut("note.sign")}
        </button>
      </div>

      {showHistory
        ? state.versions.map((v) => (
            <div key={v.id} className="conclusion-view" style={{ marginTop: 8 }}>
              <p style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13 }}>{v.text}</p>
              <p className="hint">
                {ut("note.version")} {v.version} · {ut(KIND_KEY[v.kind])} ·{" "}
                {v.status === "signed" ? `${ut("note.signedAt")} ${day(v.signedAt!)}` : ut("note.draft")} ·{" "}
                {v.authorName}
              </p>
            </div>
          ))
        : null}
    </div>
  );
}
