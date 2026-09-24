import { Link } from "react-router-dom";
import type { AppointmentView, UiKey } from "@quizzy/shared";
import { api } from "../api";
import { dayFull } from "../format";
import { Avatar, Badge, Empty, Screen, useAction, useUrlState } from "../ui";
import { Panel } from "../ui/layout";
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

/** Одно действие: куда двинуть приём и как это называется на кнопке */
interface Act {
  to: Move;
  key: UiKey;
}

/**
 * Следующее действие для приёма — ровно одно.
 *
 * Список кнопок на каждой строке превратил бы экран в панель управления, где
 * надо выбирать. Специалисту в этот момент нужно одно нажатие: человек вошёл
 * в кабинет. Всё остальное — либо уже случилось, либо случится позже.
 */
const NEXT: Partial<Record<Status, Act>> = {
  booked: { to: "arrived", key: "day.came" },
  confirmed: { to: "arrived", key: "day.came" },
  arrived: { to: "in_progress", key: "day.start" },
  in_progress: { to: "done", key: "day.finish" },
  /*
   * Неявку можно исправить, и делается это тем же самым «Пришёл».
   *
   * Ставит неявку не только человек: через два часа после конца приёма её
   * ставит фоновый проход — по тому, что никто ничего не нажал. Ошибается он
   * ровно там, где специалист забыл нажать «пришёл» между двумя приёмами.
   *
   * Поправка стоит там же, где обычный ход, а не отдельной кнопкой сбоку:
   * действие одно и то же — человек в кабинете, — и разводить его по разным
   * местам значило бы возвращать ту самую пляску, ради которой места и
   * закреплены. Редкость случая видна не по положению кнопки, а по строке:
   * «не пришёл» написано рядом, в состоянии приёма.
   */
  no_show: { to: "arrived", key: "day.came" },
};

/**
 * Уход с обычного хода — единственный, который делают отсюда.
 *
 * Отмена приёма сюда не относится: её делают из расписания и по другой
 * причине (слот освобождается для другого человека), а неявка — это отметка
 * факта, что человек не дошёл.
 */
const OFF_PATH: Partial<Record<Status, Act>> = {
  booked: { to: "no_show", key: "day.noShow" },
  confirmed: { to: "no_show", key: "day.noShow" },
};

/**
 * Места в столбце действий, слева направо.
 *
 * Мест всегда столько, сколько здесь перечислено, — независимо от того,
 * сколько действий доступно в конкретной строке. Раньше кнопки просто
 * прижимались вправо, и положение каждой зависело от числа соседей: «Не
 * пришёл» стоял то у правого края, то на кнопку левее, и столбец нельзя было
 * читать сверху вниз — глаз каждый раз заново разбирал, что где.
 *
 * Альтернатива — общая сетка на всю панель (grid + subgrid), где ширину
 * колонки задаёт самая длинная надпись во всём списке. Она точнее по ширине,
 * но связывает строки между собой: строка перестаёт быть самостоятельной, а
 * ширина столбца начинает зависеть от того, какие приёмы попали в день.
 */
const SLOTS = ["offPath", "step"] as const;
type Slot = (typeof SLOTS)[number];

/**
 * Что можно нажать по строке: по действию на каждое место, пустые — тоже места.
 *
 * Отдельная функция, а не выражение в разметке, ради проверки: правило
 * «одинаковое действие — всегда в одном месте» иначе держалось бы на глазах
 * ревьюера (см. test/dayActions.test.tsx).
 */
export function rowActions(status: Status): Record<Slot, Act | null> {
  return { offPath: OFF_PATH[status] ?? null, step: NEXT[status] ?? null };
}

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
        /*
         * Сводка дня разбивает день без остатка.
         *
         * Раньше считались только ждущие и принятые, а пришедший и сидящий
         * на приёме не попадали никуда: рядом с числом 4 стояло «Ждут 2 ·
         * Принято 1», и человек за стойкой искал четвёртого. Пустые группы
         * не показываются, но каждый приём попадает ровно в одну — сумма
         * показанных всегда равна числу приёмов.
         */
        const groups: Array<[string, number]> = [
          [ut("day.waiting"), data.items.filter((a) => a.status === "booked" || a.status === "confirmed").length],
          [ut("day.inRoom"), data.items.filter((a) => a.status === "arrived" || a.status === "in_progress").length],
          [ut("day.received"), data.items.filter((a) => a.status === "done").length],
          [ut("day.absent"), data.items.filter((a) => a.status === "no_show" || a.status === "cancelled").length],
        ];
        return (
          <>
            {/*
              Листание дней стоит над списком, а не в панели экрана: оно
              относится к этому списку, а панель теперь общая у сводки и
              приёма — кнопки «вчера/завтра» рядом со сводкой означали бы,
              что и её можно листать.
            */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setDate(shiftDate(data.date, -1))}>
                {ut("day.prev")}
              </Button>
              <span className="min-w-[132px] text-center text-caption text-muted">{dayFull(data.date)}</span>
              <Button size="sm" variant="ghost" onClick={() => setDate(shiftDate(data.date, 1))}>
                {ut("day.next")}
              </Button>
              {dateParam ? (
                <Button size="sm" variant="ghost" onClick={() => setDate("")}>
                  {ut("day.today")}
                </Button>
              ) : null}
              {data.items.length ? (
                <span className="ml-auto text-caption text-muted">
                  {groups.filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n}`).join(" · ")}
                </span>
              ) : null}
            </div>
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
          </>
        );
      }}
    </Screen>
  );
}

/** Строка дня. Вынесена наружу ради проверки мест в столбце действий */
export function AppointmentRow({
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
  const acts = rowActions(a.status);

  return (
    /*
      Признак с идентификатором приёма — точка опоры для смоука.

      День общий, и проверка, ищущая «первую строку с кнопкой «Пришёл»»,
      проверяет не экран, а то, что до неё туда не дотянулся соседний
      сценарий. Со своим приёмом ей нужна СВОЯ строка, а искать её по имени
      нельзя: тёзки в списке — обычное дело. Классы здесь менять можно,
      признак — нет (тот же уговор, что у data-patients в сетке пациентов).
    */
    <div
      data-appointment={a.id}
      className="flex items-start gap-3 border-t border-hairline px-4 py-3 first:border-t-0"
    >
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
          {a.leadSpecialistId === null ? (
            <span className="inline-flex items-center gap-1">
              <Badge>{ut("day.noLead")}</Badge>
              {/*
                Кнопка стоит вплотную к пометке, а не в общем строю действий
                справа. Там она пряталась среди «Пришёл» и «Не пришёл» и
                вдобавок сдвигала их: в строке без ведущего кнопок было три,
                в строке с ведущим — две, и одно и то же действие оказывалось
                на разном отступе в соседних строках.

                Здесь связь видна глазом: пометка называет недостачу, кнопка
                рядом её закрывает.
              */}
              <Button size="sm" variant="ghost" onClick={onLead} disabled={busy}>
                {ut("day.takeLead")}
              </Button>
            </span>
          ) : null}
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

      {/*
        Справа остаются только действия над самим приёмом: действия над
        человеком (закрепить за собой) стоят выше, у своей пометки.

        У каждого места свой смысл: слева уходят с обычного хода («Не
        пришёл»), справа идут по нему дальше. Место остаётся на строке и
        пустым — на строке принятого приёма это выглядит расточительно, но
        именно пустое место и делает столбец столбцом: «Пришёл» у записанного
        и «Пришёл» у неявки стоят на одном отступе, а не разъезжаются на
        ширину соседней кнопки.

        Ширина места задана числом, а не подгоняется под надпись: иначе она
        поехала бы на украинском («Завершити» длиннее «Завершить») и строки
        снова разошлись бы между собой. 96 px — самая длинная из надписей
        столбца плюс поля кнопки.
      */}
      <div className="flex shrink-0 items-center gap-2">
        {SLOTS.map((slot) => {
          const act = acts[slot];
          return (
            /* data-slot — опора для проверки: классы менять можно, признак мест нет */
            <div key={slot} data-slot={slot} className="w-[96px]">
              {act ? (
                <Button size="sm" className="w-full" onClick={() => onStatus(act.to)} disabled={busy}>
                  {ut(act.key)}
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
