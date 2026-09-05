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
  const todo = (surveys.data ?? []).filter((s) => s.status === "published").slice(0, 3);

  return (
    <div className="flex flex-col gap-4 p-4">
      <section>
        <h2 className="mb-2 text-caption uppercase tracking-[var(--tracking-label)] text-faint">
          {ut("pt.nextVisit")}
        </h2>
        {next ? (
          <div className="rounded-sm border border-border bg-surface p-4">
            <div className="flex items-center gap-2 font-display text-section font-semibold">
              <IconClock />
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

            <div className="mt-3 flex flex-wrap gap-2">
              {next.status === "booked" ? (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
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
                size="sm"
                variant="quiet"
                disabled={busy}
                onClick={() => run(() => api.cancelAppointment(next.id).then(visits.reload), ut("pt.cancelled"))}
              >
                {ut("pt.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="rounded-sm border border-border bg-surface p-4">
            <p className="m-0 text-muted">{ut("pt.noVisit")}</p>
            <Link className="btn primary mt-3 inline-flex" to="/me/booking">
              {ut("pt.bookNow")}
            </Link>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-caption uppercase tracking-[var(--tracking-label)] text-faint">
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
                className="flex items-center justify-between rounded-sm border border-border bg-surface p-3 text-small"
              >
                <span className="min-w-0 truncate pr-2">{s.title}</span>
                <span className="shrink-0 text-primary">{ut("pt.start")}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
