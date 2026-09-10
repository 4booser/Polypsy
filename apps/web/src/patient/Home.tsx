import { Link } from "react-router-dom";
import { api } from "../api";
import { dateTime } from "../format";
import { useAction } from "../ui";
import { Button } from "../ui/primitives";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { IconCheck, IconClock, IconPin, IconVideo } from "./icons";

/**
 * Главная кабинета: ближайший приём и что пройти до него.
 *
 * Ровно два блока и ни одного графика. Динамики своего состояния здесь нет
 * намеренно: главный экран открывают по дороге на приём, и нужно «когда и
 * куда», а не кривая тревоги за полгода. Человек, каждый день видящий свой
 * график, — это уже вмешательство, а не наблюдение.
 */
export default function PatientHome() {
  const { ut } = useLang();
  const { run, busy } = useAction();

  const visits = useResource(() => api.myAppointments(), []);
  const surveys = useResource(() => api.surveys(), []);

  const upcoming = (visits.data?.items ?? [])
    .filter((a) => new Date(a.startsAt).getTime() > Date.now() && a.status !== "cancelled")
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const next = upcoming[0];
  /*
   * Только непройденное.
   *
   * Здесь стояло «всё опубликованное», и главная звала проходить то, что
   * человек уже сдал: на соседней вкладке та же методика была помечена
   * «пройдено», а тут — кнопкой «Пройти». Нажав, он отвечал на все пункты —
   * у МЛО их двести — и получал «вы уже проходили эту методику» только при
   * отправке. Экран «Тесты» это разделение делает и объясняет, зачем;
   * главная его не унаследовала.
   */
  const todo = (surveys.data ?? [])
    .filter((s) => s.status === "published" && !s.completedByMe)
    .slice(0, 3);

  return (
    <div className="flex flex-col gap-4 p-4">
      <section>
        <h2 className="mb-2.5 text-micro uppercase tracking-[var(--tracking-label)] text-muted">
          {ut("pt.nextVisit")}
        </h2>
        {next ? (
          <div className="rounded-xl bg-surface-2 p-4 shadow-[0_0_0_1px_var(--border)]">
            <div className="flex items-center gap-2.5 font-display text-section font-medium tracking-tight">
              <span className="text-primary [&>svg]:size-[19px]">
                <IconClock />
              </span>
              {dateTime(next.startsAt)}
            </div>
            <p className="mt-1 text-small text-muted">{next.specialistName}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-small text-muted">
              {next.mode === "remote" ? <IconVideo /> : <IconPin />}
              {next.mode === "remote"
                ? ut("pt.remote")
                : next.room
                  ? `${ut("pt.room")} ${next.room}`
                  : ""}
            </p>

            {/*
              Кнопки ростом 44 px, а не «мелкие».
              Это телефон: 44 — нижняя граница, ниже которой палец
              промахивается. Подтверждение приёма — то действие, ради
              которого экран открывают по дороге, и промах здесь стоит
              несостоявшейся встречи.
            */}
            <div className="mt-3.5 flex flex-wrap items-stretch gap-2">
              {next.status === "booked" ? (
                <Button
                  variant="primary"
                  disabled={busy}
                  className="min-h-[44px] flex-1"
                  onClick={() => run(() => api.confirmAppointment(next.id).then(visits.reload), ut("pt.confirmed"))}
                >
                  {ut("pt.confirm")}
                </Button>
              ) : (
                <span className="flex items-center gap-1 text-caption text-primary">
                  <IconCheck /> {ut("pt.confirmed")}
                </span>
              )}
              {next.mode === "remote" && next.meetingUrl ? (
                <a className="btn" href={next.meetingUrl} target="_blank" rel="noreferrer">
                  {ut("pt.join")}
                </a>
              ) : null}
              <Button
                variant="quiet"
                disabled={busy}
                className="min-h-[44px] px-4"
                onClick={() => run(() => api.cancelAppointment(next.id).then(visits.reload), ut("pt.cancelled"))}
              >
                {ut("pt.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="rounded-xl bg-surface-2 p-4 shadow-[0_0_0_1px_var(--border)]">
            <p className="m-0 text-muted">{ut("pt.noVisit")}</p>
            <Link className="btn primary mt-3 inline-flex" to="/me/booking">
              {ut("pt.bookNow")}
            </Link>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2.5 text-micro uppercase tracking-[var(--tracking-label)] text-muted">
          {ut("pt.available")}
        </h2>
        {todo.length === 0 ? (
          <p className="text-muted">{ut("pt.noTests")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {todo.map((s) => (
              <Link
                key={s.id}
                to={`/me/tests/${s.id}`}
                className="flex min-h-[56px] items-center justify-between gap-3 rounded-xl bg-surface-2 px-3.5 py-2.5 text-small shadow-[0_0_0_1px_var(--border)]"
              >
                <span className="min-w-0 truncate pr-2">{s.title}</span>
                <span className="shrink-0 font-medium text-primary">{ut("pt.start")}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
