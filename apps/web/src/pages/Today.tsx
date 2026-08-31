import { Link } from "react-router-dom";
import type { AppointmentView, UiKey } from "@quizzy/shared";
import { api } from "../api";
import { Avatar, Badge, Empty, Screen, useAction, useUrlState } from "../ui";
import { Page, Panel } from "../ui/layout";
import { Button, Num, SectionLabel } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";

/** То, куда приём можно двинуть отсюда: остальные переходы этому экрану не принадлежат */
type Move = "arrived" | "in_progress" | "done" | "no_show";
type Status = AppointmentView["status"];

const STATUS_KEY: Record<Status, UiKey> = {
  booked: "day.statusBooked",
  confirmed: "day.statusConfirmed",
  arrived: "day.statusArrived",
  in_progress: "day.statusInProgress",
  done: "day.statusDone",
  no_show: "day.statusNoShow",
  cancelled: "day.statusCancelled",
};

/**
 * Следующее действие для приёма — ровно одно.
 *
 * Список кнопок на каждой строке превратил бы экран в панель управления, где
 * надо выбирать. Специалисту в этот момент нужно одно нажатие: человек вошёл
 * в кабинет. Всё остальное — либо уже случилось, либо случится позже.
 */
const NEXT: Partial<Record<Status, { to: Move; key: UiKey }>> = {
  booked: { to: "arrived", key: "day.came" },
  confirmed: { to: "arrived", key: "day.came" },
  arrived: { to: "in_progress", key: "day.start" },
  in_progress: { to: "done", key: "day.finish" },
};

/** Часы и минуты по часам того, кто смотрит: время приёма — это стенное время */
function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Приёмы дня.
 *
 * Экран, ради которого затевалось расписание. Он отвечает на один вопрос —
 * кто сегодня придёт и что с ним уже произошло, — и делает это так, чтобы
 * отметка явки стоила одного нажатия.
 *
 * День показывается целиком, включая уже принятых. Убери отработанные — и
 * специалист потеряет возможность вернуться к предыдущему приёму, а картина
 * дня превратится в убывающую очередь, по которой не видно, сколько сделано.
 */
export default function TodayPage() {
  const [dateParam, setDate] = useUrlState("date");
  const { ut } = useLang();
  const { run, busy } = useAction();

  const res = useResource(() => api.today(dateParam ? { date: dateParam } : {}), [dateParam]);
  const reload = res.reload;

  return (
    <Screen res={res} rows={5}>
      {(data) => {
        const waiting = data.items.filter((a) => a.status === "booked" || a.status === "confirmed");
        const received = data.items.filter((a) => a.status === "done");
        return (
          <Page
            title={ut("day.title")}
            count={data.items.length || null}
            sub={
              data.items.length
                ? `${ut("day.waiting")} ${waiting.length} · ${ut("day.received")} ${received.length}`
                : null
            }
            toolbar={
              <div className="flex items-center gap-2">
                <Button size="sm" variant="ghost" onClick={() => setDate(shiftDate(data.date, -1))}>
                  {ut("day.prev")}
                </Button>
                <Num className="min-w-[92px] text-center text-caption text-muted">{data.date}</Num>
                <Button size="sm" variant="ghost" onClick={() => setDate(shiftDate(data.date, 1))}>
                  {ut("day.next")}
                </Button>
                {dateParam ? (
                  <Button size="sm" variant="ghost" onClick={() => setDate("")}>
                    {ut("day.today")}
                  </Button>
                ) : null}
              </div>
            }
          >
            {data.items.length === 0 ? (
              <Empty title={ut("day.nobody")} />
            ) : (
              <Panel>
                {data.items.map((a) => (
                  <AppointmentRow
                    key={a.id}
                    a={a}
                    busy={busy}
                    onStatus={(to) => run(() => api.appointmentStatus(a.id, to).then(reload))}
                    onLead={() => run(() => api.takeLead(a.patientId, true).then(reload))}
                  />
                ))}
              </Panel>
            )}
          </Page>
        );
      }}
    </Screen>
  );
}

function AppointmentRow({
  a,
  busy,
  onStatus,
  onLead,
}: {
  a: AppointmentView;
  busy: boolean;
  onStatus: (to: Move) => void;
  onLead: () => void;
}) {
  const { ut } = useLang();
  const next = NEXT[a.status];

  return (
    <div className="flex items-start gap-3 border-t border-hairline px-4 py-3 first:border-t-0">
      {/*
        Время — первое и моноширинным: колонка времени читается сверху вниз,
        а не по строкам, и глаз ищет в ней ближайший приём.
      */}
      {/*
        Время ведёт на экран приёма: именно с него начинается работа, а имя
        по-прежнему ведёт в карту. Две разные цели в одной строке — потому
        что и вопроса тут два: «принять этого человека» и «посмотреть, кто
        он».
      */}
      <Link to={`/visit/${a.id}`} className="w-[52px] shrink-0 pt-0.5">
        <Num className="text-body">{clock(a.startsAt)}</Num>
      </Link>

      <Avatar name={a.patientName} />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to={`/patients/${a.patientId}`} className="truncate font-medium">
            {a.patientName}
          </Link>
          <span className="text-micro uppercase tracking-[var(--tracking-label)] text-faint">
            {ut(a.kind === "primary" ? "day.primary" : "day.repeat")}
          </span>
          {a.mode === "remote" ? <Badge>{ut("day.remote")}</Badge> : null}
          {/*
            «Не подтвердил» — не упрёк, а рабочий признак: по нему видно, кому
            стоит позвонить до того, как слот пропадёт впустую. Показывается
            только пока приём впереди: после явки он ничего не значит.
          */}
          {a.status === "booked" ? <Badge tone="warn">{ut("day.unconfirmed")}</Badge> : null}
          {a.offSchedule ? <Badge tone="warn">{ut("day.offSchedule")}</Badge> : null}
          {/*
            Без ведущего — не ошибка и не тревога, а факт, который иначе
            пришлось бы искать. Записаться можно к любому свободному, и
            человек легко проходит несколько приёмов, так и не став ничьим.
          */}
          {a.leadSpecialistId === null ? <Badge>{ut("day.noLead")}</Badge> : null}
          {/*
            Несданное назначенное — единственная пометка здесь, которая
            требует внимания до приёма, а не после: без неё специалист узнаёт
            о ней в момент, когда собирался обсуждать результат, то есть
            когда время приёма уже идёт.
          */}
          {a.pendingAssignments > 0 ? (
            <Badge tone="warn">
              {ut("day.pending")} {a.pendingAssignments}
            </Badge>
          ) : null}
        </div>

        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-caption text-muted">
          <span>{ut(STATUS_KEY[a.status])}</span>
          {a.room ? (
            <span>
              {ut("day.room")} {a.room}
            </span>
          ) : null}
        </div>

        {a.reason ? (
          <p className="mt-1 max-w-[70ch] text-caption text-muted">
            <SectionLabel>{ut("day.reason")}</SectionLabel> {a.reason}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {/* закрепить предлагаем только тем, у кого ведущего нет: остальным это
            означало бы перевод человека, а он делается не кнопкой в списке */}
        {a.leadSpecialistId === null ? (
          <Button size="sm" variant="ghost" onClick={onLead} disabled={busy}>
            {ut("day.takeLead")}
          </Button>
        ) : null}
        {a.status === "booked" || a.status === "confirmed" ? (
          <Button size="sm" variant="ghost" onClick={() => onStatus("no_show")} disabled={busy}>
            {ut("day.noShow")}
          </Button>
        ) : null}
        {/*
          Неявку можно исправить, и кнопка для этого обязана быть здесь.
          Ставит неявку не только человек: через два часа после конца приёма
          её ставит фоновый проход — по тому, что никто ничего не нажал.
          Ошибается он ровно там, где специалист забыл нажать «пришёл» между
          двумя приёмами, и без этой кнопки исправить это было бы негде.

          Второстепенной: исправление — редкий случай, и делать его самым
          заметным действием строки значило бы звать нажать не глядя.
        */}
        {a.status === "no_show" ? (
          <Button size="sm" variant="ghost" onClick={() => onStatus("arrived")} disabled={busy}>
            {ut("day.came")}
          </Button>
        ) : null}
        {next ? (
          <Button size="sm" onClick={() => onStatus(next.to)} disabled={busy}>
            {ut(next.key)}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
