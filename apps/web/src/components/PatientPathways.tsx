import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { day } from "../format";
import { useAction } from "../ui";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { Panel } from "../ui/layout";
import { Button, Select } from "../ui/primitives";

/**
 * Маршруты этого человека.
 *
 * Поставить на маршрут можно было только запросом к API. Здесь это делается
 * там, где принимают решение, — в карте: видно, что уже идёт, и можно начать
 * новый путь, не уходя с экрана.
 */
export function PatientPathways({ userId }: { userId: string }) {
  const { ut } = useLang();
  const { run } = useAction();
  const [pick, setPick] = useState("");

  const templates = useResource(() => api.pathways(), []).data ?? [];
  const instances = useResource(() => api.pathwayInstances(true), []);
  const mine = (instances.data ?? []).filter((i) => i.userId === userId);
  const openIds = new Set(mine.filter((i) => !i.closedAt).map((i) => i.pathwayTitle));

  return (
    <Panel title={ut("pw.title")}>
      {mine.length === 0 ? (
        <p className="m-0 text-caption text-muted">{ut("ppw.none")}</p>
      ) : (
        mine.map((i) => (
          <Link key={i.id} to={`/pathways/${i.id}`} className="duty-row">
            <span className="grow">{i.pathwayTitle}</span>
            <span className="text-muted">
              {i.done}/{i.total}
            </span>
            {i.overdue ? <span className="badge bad">{i.overdue}</span> : null}
            <span className="text-muted">
              {i.closedAt ? ut("pw.closed") : (i.currentStep ?? ut("pw.allDone"))}
            </span>
            <span className="text-muted">{day(i.startedAt)}</span>
          </Link>
        ))
      )}

      <div className="row tight mt-2.5">
        <Select value={pick} onChange={(e) => setPick(e.target.value)} aria-label={ut("ppw.start")}>
          <option value="">{ut("ppw.choose")}</option>
          {templates.map((t) => (
            // уже открытый маршрут того же вида второй раз не ставится
            <option key={t.id} value={t.id} disabled={openIds.has(t.title)}>
              {t.title}
              {openIds.has(t.title) ? ` — ${ut("ppw.alreadyOpen")}` : ""}
            </option>
          ))}
        </Select>
        <Button
          disabled={!pick}
          onClick={() =>
            void run(async () => {
              await api.startPathway(pick, userId);
              setPick("");
              instances.reload();
            }, ut("ppw.started"))
          }
        >
          {ut("ppw.start")}
        </Button>
      </div>
    </Panel>
  );
}
