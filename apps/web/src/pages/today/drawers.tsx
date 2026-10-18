import { useCallback, useEffect, useState } from "react";
import { api, type NoteState } from "../../api";
import { Drawer, DrawerPane, DrawerSection, Loading, Skeleton, useAction, useToast } from "../../ui";
import { Button, Field, Textarea } from "../../ui/primitives";
import { cx } from "../../ui/cx";
import { Ic } from "../../ui/icons";
import { useLang } from "../../lang";
import { day } from "../../format";
import { fill } from "../dashboard/model";
import { Di } from "./icons";
import { hhmm } from "./model";

/**
 * Действия дня в ящике справа: ответ пациенту и нотатка до сесії.
 *
 * Страница остаётся на месте (KIT § 2): специалист между двумя людьми, и
 * переход на экран переписки и обратно стоил бы ему места в дне. Ящик не
 * размонтируется — набранное живёт до отправки; Esc закрывает его и
 * говорит «Чернетку … збережено» с «Повернутися».
 *
 * Только существующие маршруты: письмо — POST /api/messages, нотатка — та
 * же запись о человеке, что протокол приёма (PUT /api/notes/patients/:id с
 * приёмом), сверка версии — как на экране приёма.
 */

export interface DrawerTarget {
  patientId: string;
  patientName: string;
  /** Разговор, если он уже известен (письмо из очереди) */
  threadId?: string | null;
  /** Приём, к которому пишется нотатка */
  appointmentId?: string | null;
  appointmentAt?: string | null;
}

type Mode = "reply" | "note";

/**
 * Ящик экрана и две двери в него. Экран рисует `drawer` один раз и зовёт
 * `openReply` / `openNote` из строк и клавиш.
 */
export function useDayDrawer(onDone?: () => void) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("reply");
  const [reply, setReply] = useState<DrawerTarget | null>(null);
  const [note, setNote] = useState<DrawerTarget | null>(null);
  const [replyDirty, setReplyDirty] = useState(false);
  const [noteDirty, setNoteDirty] = useState(false);

  const openReply = useCallback((t: DrawerTarget) => {
    setReply((prev) => (prev?.patientId === t.patientId ? { ...prev, ...t } : t));
    setMode("reply");
    setOpen(true);
  }, []);
  const openNote = useCallback((t: DrawerTarget) => {
    setNote((prev) => (prev?.patientId === t.patientId && prev.appointmentId === t.appointmentId ? prev : t));
    setMode("note");
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  const finished = useCallback(() => {
    setOpen(false);
    onDone?.();
  }, [onDone]);

  const { ut } = useLang();
  const drawer = (
    <Drawer open={open} mode={mode} onClose={close} onReturn={(m) => { setMode((m as Mode) ?? "reply"); setOpen(true); }}>
      <DrawerPane
        mode="reply"
        title={reply ? fill(ut("dayA.replyTo"), { name: reply.patientName }) : ut("dayA.reply")}
        sub={ut("dayA.replySub")}
        icon={<Ic.message />}
        tone="info"
        dirty={replyDirty}
        draftName={reply ? fill(ut("dayA.replyDraft"), { name: reply.patientName }) : undefined}
        kbd="M"
      >
        {reply ? (
          <ReplyBody key={reply.patientId} target={reply} active={open && mode === "reply"} onDirty={setReplyDirty} onSent={finished} />
        ) : null}
      </DrawerPane>
      <DrawerPane
        mode="note"
        title={note ? fill(ut("dayA.noteTo"), { name: note.patientName }) : ut("dayA.note")}
        sub={note?.appointmentAt ? fill(ut("dayA.noteSub"), { d: day(note.appointmentAt), t: hhmm(note.appointmentAt) }) : undefined}
        icon={<Di.notebook />}
        dirty={noteDirty}
        draftName={note ? fill(ut("dayA.noteDraft"), { name: note.patientName }) : undefined}
        kbd="N"
      >
        {note ? (
          <NoteBody
            key={`${note.patientId}-${note.appointmentId ?? ""}`}
            target={note}
            active={open && mode === "note"}
            onDirty={setNoteDirty}
            onSaved={finished}
          />
        ) : null}
      </DrawerPane>
    </Drawer>
  );
  return { drawer, openReply, openNote, close, isOpen: open };
}

type Message = { id: string; mine: boolean; text: string; sentAt: string; readAt: string | null };

/** Ответ: последние письма разговора и поле. Прочитанным помечается то, что показано */
function ReplyBody({
  target,
  active,
  onDirty,
  onSent,
}: {
  target: DrawerTarget;
  active: boolean;
  onDirty: (v: boolean) => void;
  onSent: () => void;
}) {
  const { ut } = useLang();
  const toast = useToast();
  const { run, busy } = useAction();
  const [text, setText] = useState("");
  const [state, setState] = useState<{ items: Message[] | null; error: string | null }>({ items: null, error: null });
  const [threadId, setThreadId] = useState<string | null>(target.threadId ?? null);

  const load = useCallback(async () => {
    setState({ items: null, error: null });
    try {
      let id = target.threadId ?? null;
      if (!id) {
        const list = await api.threads();
        id = list.items.find((t) => t.patientId === target.patientId)?.id ?? null;
      }
      setThreadId(id);
      if (!id) {
        setState({ items: [], error: null });
        return;
      }
      const thread = await api.thread(id);
      setState({ items: thread.items, error: null });
      const unread = thread.items.filter((m) => !m.mine && !m.readAt).map((m) => m.id);
      if (unread.length) void api.markRead(id, unread).catch(() => {});
    } catch (e) {
      setState({ items: null, error: e instanceof Error ? e.message : String(e) });
    }
  }, [target.patientId, target.threadId]);

  useEffect(() => {
    if (active && state.items === null && state.error === null) void load();
  }, [active, load, state.items, state.error]);

  useEffect(() => onDirty(text.trim().length > 0), [text, onDirty]);

  const send = () =>
    run(async () => {
      await api.sendMessage({ patientId: target.patientId, text: text.trim() });
      setText("");
      onDirty(false);
      toast(fill(ut("dayA.replySent"), { name: target.patientName }), "ok");
      onSent();
    });

  const items = state.items ?? [];
  const last = items.slice(-6);
  return (
    <>
      <DrawerSection
        title={ut("dayA.thread")}
        sub={threadId ? fill(ut("dayA.threadCount"), { n: items.length }) : ut("dayA.threadNew")}
      >
        {state.items === null && !state.error ? (
          <div role="status" aria-label={ut("common.loading")}>
            <Skeleton lines={3} />
          </div>
        ) : state.error ? (
          <Loading bare error={state.error} onRetry={load} />
        ) : last.length === 0 ? (
          <p className="m-0 text-small text-muted">{ut("dayA.threadEmpty")}</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {last.map((m) => (
              <li key={m.id} className={cx("flex", m.mine ? "justify-end" : "justify-start")}>
                <div
                  className={cx(
                    "max-w-[88%] rounded-[12px] px-3 py-2 text-small",
                    m.mine ? "bg-violet-tint text-text" : "bg-sunk text-text",
                  )}
                >
                  <p className="m-0 whitespace-pre-wrap break-words">{m.text}</p>
                  <span className="mt-1 block text-micro font-semibold text-muted tabular-nums">
                    {day(m.sentAt)}, {hhmm(m.sentAt)}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </DrawerSection>
      <DrawerSection title={ut("dayA.answer")}>
        <Field label={ut("dayA.answer")} inline>
          <Textarea
            data-autofocus
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={ut("dayA.answerPh")}
          />
        </Field>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" icon={<Di.send />} disabled={busy || !text.trim()} onClick={send}>
            {ut("dayA.send")}
          </Button>
        </div>
      </DrawerSection>
    </>
  );
}

/**
 * Нотатка до сесії — запись о человеке, привязанная к приёму. Черновик
 * дописывается на месте; подписанная запись не трогается — набранное ляжет
 * новой версией (так же, как протокол на экране приёма).
 */
function NoteBody({
  target,
  active,
  onDirty,
  onSaved,
}: {
  target: DrawerTarget;
  active: boolean;
  onDirty: (v: boolean) => void;
  onSaved: () => void;
}) {
  const { ut } = useLang();
  const toast = useToast();
  const { run, busy } = useAction();
  const [state, setState] = useState<{ notes: NoteState | null; error: string | null }>({ notes: null, error: null });
  const [text, setText] = useState<string | null>(null);
  const [seen, setSeen] = useState("");

  const load = useCallback(async () => {
    setState({ notes: null, error: null });
    try {
      const notes = await api.notes(target.patientId);
      setState({ notes, error: null });
      const draft = notes.current?.status === "draft" ? notes.current.text : "";
      setText((prev) => prev ?? draft);
      setSeen(draft);
    } catch (e) {
      setState({ notes: null, error: e instanceof Error ? e.message : String(e) });
    }
  }, [target.patientId]);

  useEffect(() => {
    if (active && state.notes === null && state.error === null) void load();
  }, [active, load, state.notes, state.error]);

  useEffect(() => onDirty(text !== null && text.trim() !== seen.trim()), [text, seen, onDirty]);

  const current = state.notes?.current ?? null;
  const save = () =>
    run(async () => {
      const saved = await api.saveNote(
        target.patientId,
        (text ?? "").trim(),
        current ? { version: current.version, revision: current.revision } : null,
        "session",
        target.appointmentId ?? undefined,
      );
      setState({ notes: saved, error: null });
      const body = saved.current?.text ?? "";
      setText(body);
      setSeen(body);
      onDirty(false);
      toast(fill(ut("dayA.noteSaved"), { name: target.patientName }), "ok");
      onSaved();
    });

  return (
    <>
      {current ? (
        <DrawerSection
          title={ut("dayA.noteCurrent")}
          sub={fill(ut("dayA.noteVersion"), { v: current.version, d: day(current.createdAt) })}
          right={
            <span className={cx("text-caption font-bold", current.status === "signed" ? "text-good" : "text-muted")}>
              {ut(current.status === "signed" ? "dayA.noteSigned" : "dayA.noteDraftWord")}
            </span>
          }
        >
          {current.status === "signed" ? (
            <p className="m-0 line-clamp-6 whitespace-pre-wrap text-small text-text-2">{current.text}</p>
          ) : (
            <p className="m-0 text-small text-text-2">{ut("dayA.noteDraftHint")}</p>
          )}
        </DrawerSection>
      ) : null}
      <DrawerSection title={ut("dayA.noteText")} sub={current?.status === "signed" ? ut("dayA.noteNewVersion") : undefined}>
        {state.error ? (
          <Loading bare error={state.error} onRetry={load} />
        ) : text === null ? (
          <div role="status" aria-label={ut("common.loading")}>
            <Skeleton lines={4} />
          </div>
        ) : (
          <Field label={ut("dayA.noteText")} inline>
            <Textarea data-autofocus rows={9} value={text} onChange={(e) => setText(e.target.value)} placeholder={ut("dayA.notePh")} />
          </Field>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" icon={<Di.notebook />} disabled={busy || !text?.trim() || text.trim() === seen.trim()} onClick={save}>
            {ut("dayA.noteSave")}
          </Button>
        </div>
      </DrawerSection>
    </>
  );
}
