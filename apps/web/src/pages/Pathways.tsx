import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type PathwayInstance } from "../api";
import { day, dateTime } from "../format";
import { Avatar, Empty, Loading, Screen, useAction } from "../ui";
import { Page, Panel } from "../ui/layout";
import { Button, Input, Tag } from "../ui/primitives";
import { cx } from "../ui/cx";
import { SavedViews } from "../ui/SavedViews";
import { useLang } from "../lang";
import { useResource } from "../useResource";

/**
 * Кто на маршрутах помощи.
 *
 * Смысл экрана не в том, чтобы перечислить назначенное, а в том, чтобы
 * застрявший стал виден. Поэтому сортировка по просрочке, а главная колонка —
 * «где стоим»: первый незакрытый шаг и его срок. «Отправили к психиатру и
 * забыли» перестаёт обнаруживаться случайно.
 */
export default function Pathways() {
  const { ut } = useLang();
  const [all, setAll] = useState(false);
  const res = useResource(() => api.pathwayInstances(all), [all]);

  return (
    <Page
      title={ut("pw.title")}
      sub={ut("pw.sub")}
      actions={
        <div className="flex items-center gap-2">
          <Link className="btn primary" to="/pathways/new">
            {ut("pw.newTemplate")}
          </Link>
          {/*
            Не .segmented: у него активный сегмент отмечен янтарной точкой,
            а переключение «открытые/все» — состояние экрана, а не то, что
            требует внимания. .chip уже переведён на бирюзу для активного
            состояния, поэтому переключатель собран из пары фишек.
          */}
          <div className="flex gap-1.5" role="group" aria-label={ut("pw.title")}>
            <button type="button" className={cx("chip", !all && "active")} aria-pressed={!all} onClick={() => setAll(false)}>
              {ut("pw.open")}
            </button>
            <button type="button" className={cx("chip", all && "active")} aria-pressed={all} onClick={() => setAll(true)}>
              {ut("pw.allInstances")}
            </button>
          </div>
        </div>
      }
      toolbar={<SavedViews scope="pathways" />}
    >
      <Screen res={res} rows={6}>
        {(items) => (
          <Panel flush>
            {items.length === 0 ? (
              <Empty title={ut("pw.empty")} hint={ut("pw.emptyHint")} />
            ) : (
              // просроченные сверху: экран нужен, чтобы видеть застрявших
              [...items]
                .sort((a, b) => b.overdue - a.overdue || a.startedAt.localeCompare(b.startedAt))
                .map((i) => <Row key={i.id} i={i} />)
            )}
          </Panel>
        )}
      </Screen>
    </Page>
  );
}

function Row({ i }: { i: PathwayInstance }) {
  const { ut } = useLang();
  const share = i.total ? Math.round((i.done / i.total) * 100) : 0;

  return (
    <Link to={`/pathways/${i.id}`} className={`pw-row${i.overdue ? " overdue" : ""}`}>
      <Avatar name={i.userName} size={28} />
      <span className="pw-main">
        <span className="pw-name">{i.userName}</span>
        <span className="pw-meta">
          {i.pathwayTitle}
          {i.unit ? ` · ${i.unit}` : ""}
        </span>
      </span>

      <span className="pw-step">
        {i.closedAt ? (
          <span className="text-muted">{ut("pw.closed")}</span>
        ) : (
          <>
            <span className="pw-step-title">{i.currentStep ?? ut("pw.allDone")}</span>
            {i.currentDueAt ? <span className="text-muted"> · {day(i.currentDueAt)}</span> : null}
          </>
        )}
      </span>

      <span className="pw-progress" title={`${i.done} / ${i.total}`}>
        <i style={{ width: `${share}%` }} />
      </span>
      <span className="pw-count">
        {i.done}/{i.total}
      </span>
      {i.overdue ? <span className="badge bad">{i.overdue}</span> : null}
    </Link>
  );
}

/** Маршрут одного человека по шагам */
export function PathwayDetailPage() {
  const { ut } = useLang();
  const { run } = useAction();
  const id = window.location.pathname.split("/").pop()!;
  const res = useResource(() => api.pathwayInstance(id), [id]);
  const [note, setNote] = useState("");

  if (!res.data) return <Loading rows={5} error={res.error} />;
  const data = res.data;
  const closed = !!data.closedAt;

  const set = (progressId: string, state: "done" | "skipped" | "pending", explain?: string) =>
    void run(async () => {
      await api.setPathwayStep(progressId, state, explain);
      setNote("");
      res.reload();
    }, ut("pw.stepSaved"));

  return (
    <Page
      title={data.pathwayTitle}
      crumbs={<Link to="/pathways">← {ut("pw.title")}</Link>}
      sub={`${data.userName} · ${ut("pw.startedAt")} ${day(data.startedAt)}`}
      actions={
        closed ? (
          <Tag tone="plain">{ut("pw.closed")}</Tag>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {(["resolved", "referred", "ongoing", "dropped"] as const).map((o) => (
              <Button
                key={o}
                variant={o === "resolved" ? "primary" : "ghost"}
                onClick={() =>
                  void run(async () => {
                    await api.closePathway(data.id, o, note.trim() || undefined);
                    res.reload();
                  }, ut("pw.closedToast"))
                }
              >
                {ut(`pw.outcome.${o}` as never)}
              </Button>
            ))}
          </div>
        )
      }
    >
      <Panel>
        <ol className="pw-steps">
          {data.steps.map((s) => {
            const overdue = s.state === "pending" && s.dueAt !== null && s.dueAt < new Date().toISOString();
            return (
              <li key={s.id} className={`pw-step-row s-${s.state}${overdue ? " overdue" : ""}`}>
                <i className="pw-mark" />
                <div className="flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{s.title}</strong>
                    <span className="text-muted">{ut(`pw.kind.${s.kind}` as never)}</span>
                    {!s.required ? <span className="text-muted">· {ut("pw.optional")}</span> : null}
                  </div>
                  <div className="m-0 text-caption text-muted">
                    {s.state === "pending"
                      ? s.dueAt
                        ? `${ut("pw.due")} ${day(s.dueAt)}`
                        : ut("pw.noDue")
                      : `${s.state === "done" ? ut("pw.done") : ut("pw.skipped")} · ${dateTime(s.doneAt ?? "")} · ${s.doneByName ?? ""}`}
                    {s.note ? ` · ${s.note}` : ""}
                  </div>
                </div>

                {!closed && s.state === "pending" ? (
                  <div className="flex flex-wrap gap-1.5">
                    <Button variant="quiet" size="sm" onClick={() => set(s.id, "done")}>{ut("pw.markDone")}</Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        /*
                         * Пропуск обязательного шага сервер не примет без
                         * объяснения — спрашиваем здесь, чтобы человек не
                         * упёрся в отказ после нажатия.
                         */
                        const why = s.required ? window.prompt(ut("pw.whySkip")) : "";
                        if (s.required && !why?.trim()) return;
                        set(s.id, "skipped", why ?? undefined);
                      }}
                    >
                      {ut("pw.markSkipped")}
                    </Button>
                  </div>
                ) : null}
                {!closed && s.state !== "pending" ? (
                  <Button variant="ghost" size="sm" onClick={() => set(s.id, "pending")}>
                    {ut("pw.undo")}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>

        {!closed ? (
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={ut("pw.closingNote")}
            className="mt-3"
          />
        ) : data.note ? (
          <p className="text-caption text-muted">{data.note}</p>
        ) : null}
      </Panel>
    </Page>
  );
}
