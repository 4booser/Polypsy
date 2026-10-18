import { useEffect, useRef, useState } from "react";
import { api, type NoteVersion } from "../api";
import { day } from "../format";
import { Loading, useAction } from "../ui";
import { usePresence } from "../events";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import type { UiKey } from "@quizzy/shared";
import { Button, ErrorText, Segmented, Textarea } from "../ui/primitives";
import { draftOf, draftSavable, saveThenSign, signPlan, staleMessage } from "./versioned";

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
  const alsoHere = usePresence(`note:${userId}`);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<NoteVersion["kind"]>("session");
  const [showHistory, setShowHistory] = useState(false);
  /*
   * Тронул ли человек поле с момента загрузки.
   *
   * В комментарии рядом было написано «подставляется один раз на загрузку»,
   * но зависимостью стояло `res.data` — то есть подставлялось на КАЖДОЕ
   * обновление записей. Обновление же случается само: по событию от другого
   * сотрудника, после назначения методики, после любого действия на экране
   * приёма. Специалист печатал протокол, коллега в соседнем кабинете что-то
   * делал — и набранное молча заменялось сохранённым черновиком.
   *
   * Потеря не видна: поле не пустеет, а показывает прежний текст, и
   * заметить подмену можно только вспомнив, что писал. Признак «тронуто»
   * закрывает это: пока человек не печатал, поле следует за сервером; как
   * начал — сервер в него больше не пишет.
   */
  const touched = useRef(false);
  /*
   * Отказ 409 — запись переписали, пока она была открыта (сменилась версия
   * или редакция черновика). Строкой у кнопок, с кнопкой «перечитать»: так
   * же, как в редакторе заключения (ConclusionEditor, `stale`).
   */
  const [stale, setStale] = useState<string | null>(null);

  const res = useResource(() => api.notes(userId), [userId]);
  const state = res.data;

  useEffect(() => {
    if (touched.current) return;
    const current = res.data?.current;
    setText(current?.status === "draft" ? current.text : "");
    if (current?.status === "draft") setKind(current.kind);
  }, [res.data]);

  // смена пациента — это другой протокол: признак сбрасывается вместе с ним
  useEffect(() => {
    touched.current = false;
  }, [userId]);

  if (!state) {
    /* отказ — словами со значком и «повторити», а не строкой «Загрузка», которая висит вечно */
    return res.error ? (
      <Loading rows={2} error={`${ut("note.loadFailed")}: ${res.error}`} onRetry={res.reload} busy={res.loading} />
    ) : (
      <Loading rows={2} />
    );
  }

  const draft = draftOf(state);
  const signed = state.versions.find((v) => v.status === "signed");
  /*
   * Вид записи сохраняется вместе с текстом: сменили только вид — это тоже
   * правка, и подпись без сохранения ушла бы с прежним (versioned.ts).
   */
  const plan = signPlan(text, draft, !draft || draft.kind === kind);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="m-0 text-h3 font-extrabold text-text">{ut("note.title")}</h3>
        {state.versions.length > 1 ? (
          <Button size="xs" variant="ghost" className="ml-auto" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? ut("cn.hideHistory") : `${ut("note.history")} (${state.versions.length})`}
          </Button>
        ) : null}
      </div>

      {signed && !draft ? (
        <div className="rounded-panel bg-sunk px-3.5 py-3">
          <p className="m-0 whitespace-pre-wrap text-body text-text">{state.current!.text}</p>
          <p className="m-0 mt-1.5 text-caption text-muted">
            {ut(KIND_KEY[state.current!.kind])}, {state.current!.authorName}, {day(state.current!.signedAt!)}, {ut("note.version")}{" "}
            {state.current!.version}
          </p>
        </div>
      ) : null}

      <Segmented
        label={ut("note.title")}
        value={kind}
        onChange={setKind}
        items={(Object.keys(KIND_KEY) as NoteVersion["kind"][]).map((k) => ({ key: k, label: ut(KIND_KEY[k]) }))}
      />

      {alsoHere.length ? (
        /*
         * Предупреждение стоит над полем, а не под кнопкой: смысл в том,
         * чтобы человек узнал до того, как напишет абзац, а не после того,
         * как сохранение упало на проверке версии.
         */
        <ErrorText tone="warn">
          {alsoHere.map((o) => o.name).join(", ")} — {ut("here.editing")}
        </ErrorText>
      ) : null}

      <Textarea
        rows={4}
        value={text}
        aria-label={ut("note.title")}
        onChange={(e) => {
          touched.current = true;
          setText(e.target.value);
        }}
        placeholder={signed ? ut("note.placeholderNext") : ut("note.placeholder")}
      />

      {stale ? (
        <div role="alert" className="rounded-panel bg-warn-tint px-3.5 py-3 text-small text-text-2">
          <p className="m-0 font-bold text-text">{stale}</p>
          <p className="m-0 mt-1">{ut("integrity.rereadHint")}</p>
          <Button
            size="xs"
            className="mt-2"
            onClick={() => {
              setStale(null);
              // перечитанное должно встать в поле: признак «тронуто» его бы не пустил
              touched.current = false;
              res.reload();
            }}
          >
            {ut("integrity.reread")}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          disabled={busy || !plan.canSign}
          onClick={() =>
            void run(async () => {
              try {
                // подписываем ровно ту версию и ту редакцию, что вернуло сохранение
                await saveThenSign(state, plan, {
                  save: () => api.saveNote(userId, text, state.current, kind),
                  sign: (seen) => api.signNote(userId, seen),
                  apply: res.patch,
                });
                // подписано — набранного больше нет, и поле снова следует за
                // сервером: иначе следующий протокол начинался бы с прежнего
                touched.current = false;
                setText("");
                setStale(null);
              } catch (e) {
                const message = staleMessage(e);
                if (message === null) throw e;
                setStale(message);
                return false;
              }
            }, ut("note.signed"))
          }
        >
          {ut("note.sign")}
        </Button>
        <Button
          disabled={busy || !draftSavable(text)}
          onClick={() =>
            void run(async () => {
              try {
                res.patch(await api.saveNote(userId, text, state.current, kind));
                setStale(null);
              } catch (e) {
                const message = staleMessage(e);
                if (message === null) throw e;
                setStale(message);
                return false;
              }
            }, ut("cn.draftSaved"))
          }
        >
          {ut("note.saveDraft")}
        </Button>
      </div>

      {showHistory ? (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {state.versions.map((v) => (
            <li key={v.id} className="rounded-panel bg-sunk px-3.5 py-3">
              <p className="m-0 whitespace-pre-wrap text-small text-text">{v.text}</p>
              <p className="m-0 mt-1.5 text-caption text-muted">
                {ut("note.version")} {v.version}, {ut(KIND_KEY[v.kind])},{" "}
                {v.status === "signed" ? `${ut("note.signedAt")} ${day(v.signedAt!)}` : ut("note.draft")}, {v.authorName}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
