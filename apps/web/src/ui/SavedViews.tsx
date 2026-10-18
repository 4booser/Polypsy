import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, type SavedView } from "../api";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { loadView, useAction } from "./index";
import { ViewPill } from "./filters";
import { Ic } from "./icons";
import { Button, Input } from "./primitives";
import { openView } from "./viewParams";

/**
 * Сохранённые виды экрана — пилюлями набора (.vw): открытый — фиолетовой
 * заливкой, общий чужой — со значком «поделено».
 *
 * Вид хранит адрес целиком (viewParams.ts) и узнаётся открытым при любом
 * порядке параметров. Число строк в виде — `counts`, если экран его знает:
 * сервер видов числа не считает.
 */
export function SavedViews({ scope, counts }: { scope: string; counts?: Record<string, number | null | undefined> }) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const location = useLocation();
  const { run, busy } = useAction();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const res = useResource(() => api.views(scope), [scope]);
  const views = res.data ?? [];
  const current = location.search.replace(/^\?/, "");
  const active = openView(views, current);

  const apply = (v: SavedView) => navigate({ search: v.params ? `?${v.params}` : "" });

  const save = () =>
    void run(async () => {
      await api.saveView({ scope, name: name.trim(), params: current });
      setName("");
      setNaming(false);
      res.reload();
    }, ut("views.saved"));

  return (
    <div role="group" aria-label={ut("kit.savedViews")} className="flex flex-wrap items-center gap-x-[5px] gap-y-1.5">
      {/*
        Отказ загрузки — не «видов нет»: строка без видов при отказе
        выглядела ровно как у человека, который их не заводил, и свои виды
        считались пропавшими. Здесь — сказать и дать повторить.
      */}
      {loadView(res) === "failed" ? (
        <Button variant="quiet" size="xs" onClick={res.reload}>
          {ut("uit.views.loadFailed")}
        </Button>
      ) : null}
      {views.map((v) => (
        <ViewPill
          key={v.id}
          label={v.name}
          count={counts?.[v.id]}
          on={active?.id === v.id}
          onClick={() => apply(v)}
          title={v.mine ? v.name : `${v.name} · ${v.ownerName}`}
          icon={v.shared && !v.mine ? <IconShared /> : null}
        />
      ))}
      {naming ? (
        <span className="inline-flex items-center gap-1.5">
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={ut("views.namePlaceholder")}
            className="h-8 w-[190px] rounded-[9px]"
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) save();
              if (e.key === "Escape") setNaming(false);
            }}
          />
          <Button variant="primary" size="xs" disabled={busy || !name.trim()} onClick={save}>
            {ut("common.save")}
          </Button>
          <Button variant="quiet" size="xs" onClick={() => setNaming(false)}>
            {ut("common.cancel")}
          </Button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setNaming(true)}
          title={ut("views.saveHint")}
          className="inline-flex h-8 min-h-0 cursor-pointer items-center gap-1 rounded-2xl border-0 bg-transparent pl-2 pr-2.5 text-small font-semibold text-text-2 shadow-[inset_0_0_0_1.5px_var(--ctl)] hover:bg-sunk"
        >
          <Ic.plus size={14} />
          {ut("views.save")}
        </button>
      )}
      {active?.mine ? (
        <>
          <Button
            variant="quiet"
            size="xs"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.updateView(active.id, { shared: !active.shared });
                res.reload();
              }, active.shared ? ut("views.madePersonal") : ut("views.madeShared"))
            }
          >
            {active.shared ? ut("views.makePersonal") : ut("views.makeShared")}
          </Button>
          <Button
            variant="quiet"
            size="icon-sm"
            disabled={busy}
            aria-label={ut("views.remove")}
            title={ut("views.remove")}
            onClick={() =>
              void run(async () => {
                await api.deleteView(active.id);
                res.reload();
              }, ut("views.removed"))
            }
          >
            <Ic.x size={15} />
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** Значок «вид поделён»: три узла — кто-то из коллег завёл его для всех */
function IconShared() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.6 13.5 6.8 4M15.4 6.5 8.6 10.5" />
    </svg>
  );
}
