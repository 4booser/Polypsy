import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { renderPush, type MailingCard, type PatientGroupWithCounts } from "@quizzy/shared";
import { api } from "../../api";
import { HBars } from "../../charts/clinical";
import { staleMessage } from "../../components/versioned";
import { day, timeOfDay } from "../../format";
import { useLang } from "../../lang";
import { Callout, Ic, Loading, Modal, Tooltip, useAction, useHotkeys, useToast } from "../../ui";
import { Page, Panel } from "../../ui/layout";
import { Button, Field, Input, Select, Tag, Textarea } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { AnswerBars, SilentList, answeredLine } from "./answers";
import { Mi } from "./icons";
import {
  MAX_OPTIONS,
  type MailingDraft,
  draftFromMailing,
  draftToInput,
  draftToUpdate,
  isFilled,
  mailingHref,
  optionPreset,
  saveThenSend,
  withoutOption,
} from "./model";

/*
 * Розсилка — редактор чернетки и сторінка відправленої (comms-mailing-editor).
 *
 * Чернетка: слева само повідомлення — назва, текст із лічильником, варіанти
 * відповіді (до десяти, з шаблонами «Так / Ні», «Так / Ні / Ще не знаю»,
 * «Без відповіді»), под ним — как будут выглядеть ответы и что раньше
 * уходило этой группе; справа — кому отправить, сколько людей получат,
 * предупреждение о незмінності и «Відправити N людям» с подтверждением, и
 * что пациент увидит на телефоне.
 *
 * Відправлена: то же место, только для чтения, и вместо формы — ответы:
 * полосы по вариантам и кто ещё молчит. Текст после отправки сервер не
 * меняет (409), поэтому и экран не притворяется формой.
 *
 * Редакция черновика уходит в правку и отправку (волна 15): поверх чужой
 * правки сервер отвечает 409, и экран предлагает перечитать.
 */

export default function MailingPage() {
  const { id } = useParams<{ id: string }>();
  /*
   * Форма пересоздаётся по адресу: правки черновика A не переезжают в
   * черновик B, когда человек переходит по ссылке, не уходя с экрана.
   */
  return <MailingEditor key={id ?? "new"} id={id ?? null} />;
}

/** Предел текста сервера (mailingInputSchema: body ≤ 4000) */
const BODY_MAX = 4000;

const stamp = (iso: string) => `${day(iso)}, ${timeOfDay(iso)}`;

function MailingEditor({ id }: { id: string | null }) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, busy } = useAction();
  const card = useResource(() => api.mailing(id!), [id], { enabled: id !== null, keep: false });
  const groups = useResource(() => api.patientGroups(), []);
  const [confirming, setConfirming] = useState<"send" | "delete" | null>(null);
  const [draft, setDraft] = useState<MailingDraft | null>(() =>
    id === null
      ? { title: "", body: "", options: [ut("mail.yes"), ut("mail.no")], patientGroupId: "", revision: null }
      : null,
  );
  /* отказ «черновик изменили» (409) — словами сервера, до перечитывания */
  const [stale, setStale] = useState<string | null>(null);
  /* когда последний раз сохранено — из ответа сервера, а не из часов клиента */
  const [savedAt, setSavedAt] = useState<string | null>(null);

  useEffect(() => {
    if (card.data && draft === null) {
      setDraft(draftFromMailing(card.data));
      setSavedAt(card.data.updatedAt);
    }
  }, [card.data, draft]);

  const sent = card.data?.status === "sent";
  const patch = (next: Partial<MailingDraft>) => setDraft((d) => (d ? { ...d, ...next } : d));
  const setOption = (i: number, text: string) =>
    setDraft((d) => (d ? { ...d, options: d.options.map((o, k) => (k === i ? text : o)) } : d));
  const addOption = () =>
    setDraft((d) => (d && d.options.length < MAX_OPTIONS ? { ...d, options: [...d.options, ""] } : d));
  const preset = (kind: "yesNo" | "yesNoMaybe" | "none") =>
    patch({ options: optionPreset(kind, { yes: ut("mail.yes"), no: ut("mail.no"), maybe: ut("mlx.maybe") }) });

  const onStale = (e: unknown) => {
    const message = staleMessage(e);
    if (message === null) throw e;
    setStale(message);
    setConfirming(null);
    card.reload();
    return false;
  };

  const create = () => {
    if (!draft) return;
    void run(async () => {
      const created = await api.createMailing(draftToInput(draft));
      navigate(mailingHref(created.id), { replace: true });
    }, ut("mail.created"));
  };

  const save = () => {
    if (!draft) return;
    if (id === null) return create();
    void run(async () => {
      try {
        const updated = await api.updateMailing(id, draftToUpdate(draft));
        setDraft(draftFromMailing(updated));
        setSavedAt(updated.updatedAt);
        setStale(null);
      } catch (e) {
        return onStale(e);
      }
    }, ut("mail.saved"));
  };

  /*
   * «Відправити»: сохранить то, что видно, и отправить ровно сохранённую
   * редакцию (saveThenSend). Новое повідомлення сначала заводится — тем же
   * действием, человек не обязан помнить про «Зберегти».
   */
  const send = () => {
    if (!draft) return;
    void run(async () => {
      try {
        let target = id;
        let base = draft;
        if (target === null) {
          const created = await api.createMailing(draftToInput(draft));
          target = created.id;
          base = draftFromMailing(created);
        }
        const mailingId = target;
        await saveThenSend(base, {
          save: (input) => api.updateMailing(mailingId, input),
          send: (revision) => api.sendMailing(mailingId, revision),
          apply: (saved) => setDraft(draftFromMailing(saved)),
        });
        setConfirming(null);
        setStale(null);
        if (id === null) navigate(mailingHref(mailingId), { replace: true });
        else card.reload();
      } catch (e) {
        return onStale(e);
      }
    }, ut("mail.sent"));
  };

  const reread = () => {
    if (id === null) return;
    void run(async () => {
      const fresh = await api.mailing(id);
      card.patch(fresh);
      setDraft(draftFromMailing(fresh));
      setSavedAt(fresh.updatedAt);
      setStale(null);
    });
  };

  const remove = () => {
    if (id === null) return;
    void run(async () => {
      await api.deleteMailing(id);
      toast(ut("mail.deleted"), "ok");
      navigate("/mailings", { replace: true });
    });
  };

  const hide = (back: boolean) => {
    if (id === null) return;
    void run(
      async () => {
        if (back) await api.unhideMailing(id);
        else await api.hideMailing(id);
        card.reload();
      },
      ut(back ? "mlx.unhidden" : "mail.hidden"),
    );
  };

  useHotkeys({ s: save }, !sent && confirming === null && !!draft);

  const back = { to: "/mailings", label: ut("sn.mailings") };

  if (id !== null && card.error) {
    return (
      <Page title={ut("mail.add")} titleHidden back={back}>
        <Loading error={card.error} onRetry={card.reload} />
      </Page>
    );
  }
  if (!draft || (id !== null && !card.data)) {
    return (
      <Page title={ut("mail.add")} titleHidden back={back}>
        <Loading rows={6} />
      </Page>
    );
  }

  const group = draft.patientGroupId ? ((groups.data ?? []).find((g) => g.id === draft.patientGroupId) ?? null) : null;

  if (sent && card.data) {
    return <SentPage m={card.data} group={group} busy={busy} onHide={hide} back={back} stale={stale} />;
  }

  const filled = isFilled(draft);
  const people = group?.memberCount ?? 0;
  const sendLock = !filled ? ut("mail.fillIn") : !draft.patientGroupId ? ut("mlx.pickGroup") : people === 0 ? ut("mlx.emptyGroup") : null;

  return (
    <Page
      title={draft.title.trim() || ut("mail.add")}
      back={back}
      meta={
        <>
          <span>
            <Tag icon={<Ic.pen />}>{ut("mlx.draft")}</Tag>
          </span>
          <span className="inline-flex items-center gap-1.5">
            {savedAt ? (
              <>
                <Ic.cloudCheck size={13} className="text-good" />
                {ut("mlx.savedAt").replace("{t}", stamp(savedAt))}
              </>
            ) : (
              ut("mlx.notSaved")
            )}
          </span>
        </>
      }
      actions={
        <>
          {id !== null ? (
            <Button variant="danger" icon={<Mi.trash />} disabled={busy} onClick={() => setConfirming("delete")}>
              {ut("mail.delete")}
            </Button>
          ) : null}
          <Tooltip label={id === null ? ut("mlx.createTip") : ut("mlx.saveTip")} kbd="S" side="bottom" align="end">
            <Button icon={<Mi.save />} disabled={busy || !filled} onClick={save}>
              {id === null ? ut("mail.create") : ut("common.save")}
            </Button>
          </Tooltip>
        </>
      }
    >
      {stale ? (
        <Callout
          kind="warn"
          role="alert"
          title={stale}
          className="mb-4"
          actions={
            <Button size="xs" disabled={busy} onClick={reread}>
              {ut("integrity.reread")}
            </Button>
          }
        >
          <p className="m-0 mt-0.5">{ut("mail.rereadHint")}</p>
        </Callout>
      ) : null}
      <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-4 max-[1180px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title={ut("mlx.message")} icon={<Mi.megaphone />}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
            >
              <Field label={ut("mail.name")} hint={ut("mlx.nameHint")}>
                <Input
                  value={draft.title}
                  onChange={(e) => patch({ title: e.target.value })}
                  maxLength={200}
                  autoComplete="off"
                  className="h-12 text-[15px]"
                />
              </Field>
              <Field
                label={ut("mail.body")}
                hint={`${ut("mlx.bodyHint")} ${ut("mlx.chars").replace("{n}", String(draft.body.length)).replace("{max}", String(BODY_MAX))}`}
              >
                <Textarea
                  rows={6}
                  value={draft.body}
                  onChange={(e) => patch({ body: e.target.value })}
                  maxLength={BODY_MAX}
                  className="resize-y"
                />
              </Field>
              <OptionsBox
                options={draft.options}
                onChange={setOption}
                onAdd={addOption}
                onRemove={(i) => patch({ options: withoutOption(draft.options, i) })}
                onPreset={preset}
              />
            </form>
          </Panel>
          <Panel title={ut("mlx.after")} icon={<Mi.chartBars />} sub={ut("mlx.afterSub")}>
            {draft.options.some((o) => o.trim()) ? (
              <>
                <HBars
                  max={Math.max(1, people)}
                  items={[
                    ...draft.options
                      .map((o, i) => ({ o: o.trim(), i }))
                      .filter((x) => x.o)
                      .map((x) => ({ key: `o${x.i}`, label: x.o, value: 0, strong: true })),
                    { key: "silent", label: ut("mlx.silent"), value: people },
                  ]}
                />
                <p className="m-0 mt-2.5 text-small text-muted">{ut("mlx.afterHint")}</p>
              </>
            ) : (
              <p className="m-0 text-small text-text-2">{ut("mlx.afterNoOptions")}</p>
            )}
            {draft.patientGroupId ? <Earlier group={draft.patientGroupId} skip={id} /> : null}
          </Panel>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title={ut("mlx.whom")} icon={<Mi.send />}>
            <GroupSelect
              groups={groups.data}
              error={groups.error}
              onRetry={groups.reload}
              value={draft.patientGroupId}
              onPick={(patientGroupId) => patch({ patientGroupId })}
            />
            {group ? (
              <p className="m-0 mt-1 flex items-center gap-2 text-small text-text-2">
                <Ic.users size={14} className="text-violet-ink" />
                {ut("mlx.inGroup").replace("{n}", String(people))}
              </p>
            ) : null}
            <Callout kind="warn" icon={<Ic.lock />} className="mt-3">
              <p className="m-0">{ut("mlx.immutableLong")}</p>
            </Callout>
            <Button
              variant="primary"
              icon={<Mi.send />}
              className="mt-3 w-full"
              disabled={busy || !!sendLock}
              onClick={() => setConfirming("send")}
            >
              {people ? ut("mlx.sendTo").replace("{n}", String(people)) : ut("mail.send")}
            </Button>
            {sendLock ? <p className="m-0 mt-2 text-small text-muted">{sendLock}</p> : null}
          </Panel>
          <PatientPreview />
        </div>
      </div>

      {confirming === "send" ? (
        <Modal
          title={ut("mlx.sendConfirm").replace("{n}", String(people))}
          onClose={() => setConfirming(null)}
          icon={<Mi.send />}
          sub={group?.title}
          width={480}
          footer={
            <>
              <Button variant="primary" icon={<Mi.send />} disabled={busy} onClick={send}>
                {ut("mail.send")}
              </Button>
              <Button onClick={() => setConfirming(null)}>{ut("mlx.checkAgain")}</Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">
            {ut("mlx.sendBody").replace("{title}", draft.title.trim()).replace("{group}", group?.title ?? "")}
          </p>
        </Modal>
      ) : null}
      {confirming === "delete" ? (
        <Modal
          title={ut("mail.confirmDelete")}
          onClose={() => setConfirming(null)}
          icon={<Mi.trash />}
          tone="warn"
          width={460}
          footer={
            <>
              <Button variant="danger" icon={<Mi.trash />} disabled={busy} onClick={remove}>
                {ut("mail.delete")}
              </Button>
              <Button onClick={() => setConfirming(null)}>{ut("mlx.keep")}</Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">{ut("mlx.deleteBody").replace("{title}", draft.title.trim())}</p>
        </Modal>
      ) : null}
    </Page>
  );
}

/**
 * Варианты ответа: номер, поле, «прибрати». Пустой вариант на сервер не
 * уходит (cleanOptions), но убрать его можно и крестиком. Шаблоны
 * подменяют весь набор: «Без відповіді» — просто повідомлення.
 */
function OptionsBox({
  options,
  onChange,
  onAdd,
  onRemove,
  onPreset,
}: {
  options: string[];
  onChange: (i: number, text: string) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  onPreset: (kind: "yesNo" | "yesNoMaybe" | "none") => void;
}) {
  const { ut } = useLang();
  return (
    <div role="group" aria-labelledby="ml-answer" className="mt-1 rounded-panel p-3.5 shadow-[inset_0_0_0_1px_var(--border)]">
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0">
          <b id="ml-answer" className="block text-h3 font-extrabold text-text">
            {ut("mail.answer")}
          </b>
          <small className="block text-small text-muted">{ut("mlx.answerHint")}</small>
        </div>
        <span className="ml-auto whitespace-nowrap text-caption font-bold tabular-nums text-muted">
          {ut("mlx.optionsOf").replace("{n}", String(options.length)).replace("{max}", String(MAX_OPTIONS))}
        </span>
      </div>
      {options.length ? (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {options.map((o, i) => (
            <li key={i} className="grid grid-cols-[18px_minmax(0,1fr)_32px] items-center gap-2">
              <span className="text-caption font-extrabold tabular-nums text-muted">{i + 1}</span>
              <Input
                aria-label={`${ut("mail.option")} ${i + 1}`}
                value={o}
                onChange={(e) => onChange(i, e.target.value)}
                maxLength={100}
                autoComplete="off"
              />
              <Button
                variant="quiet"
                size="icon-sm"
                aria-label={ut("mlx.removeOption").replace("{n}", String(i + 1))}
                onClick={() => onRemove(i)}
              >
                <Ic.x size={15} />
              </Button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="m-0 text-small text-text-2">{ut("mlx.noOptionsHint")}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Button size="xs" icon={<Ic.plus />} disabled={options.length >= MAX_OPTIONS} onClick={onAdd}>
          {ut("mail.addOption")}
        </Button>
        <span className="ml-auto text-small text-muted">{ut("mlx.presets")}</span>
        <Button size="xs" variant="quiet" onClick={() => onPreset("yesNo")}>
          {ut("mlx.presetYesNo")}
        </Button>
        <Button size="xs" variant="quiet" onClick={() => onPreset("yesNoMaybe")}>
          {ut("mlx.presetYesNoMaybe")}
        </Button>
        <Button size="xs" variant="quiet" onClick={() => onPreset("none")}>
          {ut("mlx.presetNone")}
        </Button>
      </div>
    </div>
  );
}

/** Группа получателей. Отказ списка групп не запирает форму молча: видно, почему выбирать не из чего */
function GroupSelect({
  groups,
  error,
  onRetry,
  value,
  onPick,
}: {
  groups: PatientGroupWithCounts[] | null;
  error: string | null;
  onRetry: () => void;
  value: string;
  onPick: (id: string) => void;
}) {
  const { ut } = useLang();
  if (error) return <Loading error={error} onRetry={onRetry} bare />;
  return (
    <Field label={ut("mail.recipients")}>
      <Select value={value} onChange={(e) => onPick(e.target.value)}>
        <option value="">{ut("mlx.pickGroupOption")}</option>
        {(groups ?? []).map((g) => (
          <option key={g.id} value={g.id}>
            {g.title} ({g.memberCount})
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** «Раніше цій групі» — последние отправленные той же группе */
function Earlier({ group, skip }: { group: string; skip: string | null }) {
  const { ut } = useLang();
  const prev = useResource(() => api.mailings({ group, status: "sent", limit: 4, offset: 0 }), [group]);
  const items = (prev.data?.items ?? []).filter((m) => m.id !== skip).slice(0, 3);
  if (!items.length) return null;
  return (
    <div className="mt-4 border-t border-divider pt-3">
      <b className="block text-h3 font-extrabold text-text">{ut("mlx.earlier")}</b>
      <ul className="m-0 mt-1 list-none p-0">
        {items.map((m) => (
          <li key={m.id} className="grid grid-cols-[64px_minmax(0,1fr)] gap-2 py-1.5 text-small leading-[17px]">
            <span className="font-extrabold tabular-nums text-muted">{day(m.at)}</span>
            <span className="min-w-0">
              <Link to={mailingHref(m.id)} className="block truncate font-bold text-text">
                {m.title}
              </Link>
              <small className="block text-caption text-muted">
                {ut("mlx.readOf").replace("{n}", String(m.readCount)).replace("{total}", String(m.recipientCount))}
              </small>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Что пациент увидит на телефоне: уведомление без названия и текста —
 * «Група ризику: анкета настрою» на экране блокировки сообщила бы соседу
 * то, чего сообщать нельзя (push.mailingTitle / push.mailingBody). Тексты
 * — те же, что уходят в уведомление, на языке консоли.
 */
function PatientPreview() {
  const { ut, lang } = useLang();
  return (
    <Panel title={ut("mlx.preview")} icon={<Mi.smartphone />}>
      <div className="flex justify-center rounded-panel bg-appbar px-4 pb-6 pt-8">
        <div className="w-full max-w-[290px]">
          <p className="m-0 text-center text-[34px] font-extrabold leading-none tabular-nums text-appbar-ink">
            {timeOfDay(new Date().toISOString())}
          </p>
          <div className="mt-6 flex items-start gap-2.5 rounded-[18px] bg-panel px-3.5 py-3 shadow-pop">
            <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-violet text-onfill">
              <Mi.megaphone size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-2">
                <b className="text-body font-extrabold text-text">{renderPush("push.mailingTitle", lang)}</b>
                <small className="ml-auto text-caption text-muted">{ut("mlx.now")}</small>
              </span>
              <span className="block text-small text-text-2">{renderPush("push.mailingBody", lang)}</span>
            </span>
          </div>
        </div>
      </div>
      <p className="m-0 mt-3 text-small text-text-2">{ut("mlx.previewNote")}</p>
    </Panel>
  );
}

/** Відправлена розсилка: только чтение, ответы и кто молчит */
function SentPage({
  m,
  group,
  busy,
  onHide,
  back,
  stale,
}: {
  m: MailingCard;
  group: PatientGroupWithCounts | null;
  busy: boolean;
  onHide: (back: boolean) => void;
  back: { to: string; label: string };
  stale: string | null;
}) {
  const { ut } = useLang();
  const asks = m.options.length > 0;
  return (
    <Page
      title={m.title}
      back={back}
      meta={
        <>
          <span>
            <Tag tone="good" icon={<Mi.send />}>
              {ut("mlx.sentTag")}
            </Tag>
          </span>
          <span>{m.sentAt ? stamp(m.sentAt) : null}</span>
        </>
      }
      actions={
        <Button icon={m.hiddenAt ? <Ic.undo /> : <Mi.eyeOff />} disabled={busy} onClick={() => onHide(!!m.hiddenAt)}>
          {m.hiddenAt ? ut("mlx.unhide") : ut("mlx.hide")}
        </Button>
      }
    >
      {stale ? (
        <Callout kind="warn" role="alert" title={stale} className="mb-4">
          <p className="m-0 mt-0.5">{ut("mail.alreadySent")}</p>
        </Callout>
      ) : null}
      <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-4 max-[1180px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title={ut("mlx.message")} icon={<Mi.megaphone />} sub={ut("mlx.frozen")}>
            <p className="m-0 whitespace-pre-wrap break-words text-body text-text">{m.body}</p>
            {asks ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {m.options.map((o, i) => (
                  <Tag key={i}>{o}</Tag>
                ))}
              </div>
            ) : null}
          </Panel>
          {asks ? (
            <Panel title={ut("mlx.colAnswers")} icon={<Mi.chartBars />} sub={answeredLine(m, { of: ut("mlx.answeredOf") }) ?? undefined}>
              <AnswerBars card={m} />
            </Panel>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Panel title={ut("mlx.whom")} icon={<Mi.send />}>
            <div className="flex flex-wrap gap-1.5">
              {group ? (
                <Tag tone="primary" icon={<Ic.users />}>
                  {group.title}
                </Tag>
              ) : null}
              {m.counts ? <Tag>{ut("mlx.people").replace("{n}", String(m.counts.recipients))}</Tag> : null}
              {m.counts ? <Tag icon={<Ic.checkCheck />}>{ut("mlx.readCount").replace("{n}", String(m.counts.read))}</Tag> : null}
            </div>
            <Callout kind="line" icon={<Ic.lock />} className="mt-3">
              <p className="m-0">{ut("mlx.immutable")}</p>
            </Callout>
          </Panel>
          <Panel title={ut(asks ? "mlx.whoSilent" : "mlx.whoUnread")} icon={<Ic.users />}>
            <SilentList card={m} />
          </Panel>
        </div>
      </div>
    </Page>
  );
}
