import type { MailingCard, PatientGroupWithCounts } from "@quizzy/shared";
import { api } from "../../api";
import { HBars } from "../../charts/clinical";
import { day, timeOfDay } from "../../format";
import { useLang } from "../../lang";
import { Avatar, Drawer, DrawerSection, Ic, Loading, useAction } from "../../ui";
import { Button, Tag } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { Mi } from "./icons";

/*
 * Ответы на отправленную розсилку: полосы по вариантам с «ще не
 * відповіли», и кто именно молчит. Одни и те же куски в ящике списка
 * (comms-mailings, «Відповіді на розсилку») и на странице отправленной.
 *
 * Счётчики — по всем получателям (MailingCard.counts), имена — только из
 * нынешней зоны читателя: выбывшего из зоны человека нет в списке, но его
 * ответ остаётся в числах. Поэтому «і ще N» считается от счётчиков, а не
 * от длины списка.
 */

const stamp = (iso: string) => `${day(iso)}, ${timeOfDay(iso)}`;

/** Сколько имён показать, остальное — «і ще N» */
const NAMES = 8;

/** Полосы ответов: варианты фиолетовым, «ще не відповіли» — тихим */
export function AnswerBars({ card }: { card: MailingCard }) {
  const { ut } = useLang();
  const counts = card.counts;
  if (!counts || !card.answers) return null;
  const silent = Math.max(0, counts.recipients - counts.answered);
  return (
    <HBars
      max={Math.max(1, counts.recipients)}
      items={[
        ...card.answers.map((a) => ({ key: `o${a.index}`, label: a.text, value: a.count, strong: true })),
        { key: "silent", label: ut("mlx.silent"), value: silent },
      ]}
    />
  );
}

/** «18 з 24, 75 %» — сколько ответили */
export function answeredLine(card: MailingCard, words: { of: string }): string | null {
  const c = card.counts;
  if (!c || c.recipients === 0) return null;
  const pct = Math.round((c.answered / c.recipients) * 100);
  return `${words.of.replace("{n}", String(c.answered)).replace("{total}", String(c.recipients))}, ${pct} %`;
}

/**
 * Кто ещё не ответил (у розсилки с вариантами) или не прочитал (без
 * вариантов): имя и прочитал ли. Список — из зоны видимости читателя.
 */
export function SilentList({ card }: { card: MailingCard }) {
  const { ut } = useLang();
  const counts = card.counts;
  if (!counts || !card.recipients) return null;
  const asks = card.options.length > 0;
  const waiting = card.recipients.filter((r) => (asks ? r.answer === null : r.readAt === null));
  const total = asks ? counts.recipients - counts.answered : counts.recipients - counts.read;
  if (total <= 0) return <p className="m-0 text-small text-text-2">{ut(asks ? "mlx.allAnswered" : "mlx.allRead")}</p>;
  const more = Math.max(0, total - Math.min(NAMES, waiting.length));
  return (
    <>
      <ul className="m-0 list-none p-0">
        {waiting.slice(0, NAMES).map((r) => (
          <li key={r.userId} className="flex items-center gap-2.5 border-t border-divider py-2 first:border-t-0 first:pt-0">
            <Avatar name={r.fullName} size={28} tone="soft" />
            <span className="min-w-0 flex-1">
              <b className="block truncate text-body text-text">{r.fullName}</b>
              <small className="block text-caption text-muted">
                {r.readAt ? ut("mlx.readAt").replace("{d}", stamp(r.readAt)) : ut("msx.notRead")}
              </small>
            </span>
          </li>
        ))}
      </ul>
      {more > 0 ? <p className="m-0 mt-2 text-small text-muted">{ut("mlx.andMore").replace("{n}", String(more))}</p> : null}
    </>
  );
}

/** Ящик «Відповіді на розсилку» — открывается из строки отправленной */
export function AnswersDrawer({
  id,
  onClose,
  group,
  onHidden,
}: {
  id: string | null;
  onClose: () => void;
  group: PatientGroupWithCounts | null;
  onHidden: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const card = useResource(() => api.mailing(id!), [id], { enabled: id !== null, keep: false });
  const m = card.data && card.data.id === id ? card.data : null;
  const asks = (m?.options.length ?? 0) > 0;
  const hide = () =>
    id &&
    void run(async () => {
      await api.hideMailing(id);
      onHidden();
    }, ut("mail.hidden"));

  return (
    <Drawer
      open={id !== null}
      onClose={onClose}
      title={ut("mlx.answersTitle")}
      sub={m?.sentAt ? `${group?.title ? `${group.title}, ` : ""}${stamp(m.sentAt)}` : undefined}
      icon={<Mi.megaphone />}
      note={ut("mlx.frozen")}
      noteIcon={<Ic.lock />}
      footer={
        m && !m.hiddenAt ? (
          <Button icon={<Mi.eyeOff />} disabled={busy} onClick={hide}>
            {ut("mlx.hide")}
          </Button>
        ) : null
      }
    >
      {card.error ? (
        <DrawerSection>
          <Loading error={card.error} onRetry={card.reload} bare />
        </DrawerSection>
      ) : !m ? (
        <DrawerSection>
          <Loading rows={4} bare />
        </DrawerSection>
      ) : (
        <>
          <DrawerSection>
            <h3 className="m-0 text-h3 font-extrabold text-text">{m.title}</h3>
            <p className="m-0 mt-1.5 whitespace-pre-wrap break-words text-body text-text-2">{m.body}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {group ? (
                <Tag tone="primary" icon={<Ic.users />}>
                  {group.title}
                </Tag>
              ) : null}
              {m.counts ? <Tag>{ut("mlx.people").replace("{n}", String(m.counts.recipients))}</Tag> : null}
              {m.counts ? (
                <Tag icon={<Ic.checkCheck />}>{ut("mlx.readCount").replace("{n}", String(m.counts.read))}</Tag>
              ) : null}
            </div>
          </DrawerSection>
          {asks ? (
            <DrawerSection title={ut("mlx.colAnswers")} sub={answeredLine(m, { of: ut("mlx.answeredOf") }) ?? undefined}>
              <AnswerBars card={m} />
            </DrawerSection>
          ) : null}
          <DrawerSection title={ut(asks ? "mlx.whoSilent" : "mlx.whoUnread")}>
            <SilentList card={m} />
          </DrawerSection>
        </>
      )}
    </Drawer>
  );
}
