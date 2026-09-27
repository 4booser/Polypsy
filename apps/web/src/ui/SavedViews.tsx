import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api, type SavedView } from "../api";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { loadView, useAction } from "./index";
import { IconClose } from "./glyphs";
import { Button } from "./primitives";
import { openView } from "./viewParams";

/**
 * Сохранённые виды экрана.
 *
 * Фильтры уже живут в адресе и передаются ссылкой; здесь снимается вторая
 * половина работы — не собирать «мои просроченные по третьей роте» заново
 * каждое утро.
 *
 * Хранится строка запроса, а не результат. Поэтому общий вид безопасен:
 * открыв его, коллега получит тот же фильтр, но выборку сервер соберёт по
 * его правам — вид не может показать больше, чем человеку положено.
 */
export function SavedViews({ scope }: { scope: string }) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const location = useLocation();
  const { run, busy } = useAction();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");

  const res = useResource(() => api.views(scope), [scope]);
  const views = res.data ?? [];
  const current = location.search.replace(/^\?/, "");
  /* узнаётся по составу отбора, а не посимвольно: порядок параметров — это порядок, в котором трогали фильтры */
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
    <div className="views">
      {/*
        Отказ загрузки — не «видов нет»: строка без видов при отказе
        выглядела ровно как у человека, который их не заводил, и свои виды
        считались пропавшими. Здесь — сказать и дать повторить.
      */}
      {loadView(res) === "failed" ? (
        <Button variant="quiet" size="sm" onClick={res.reload}>
          {ut("uit.views.loadFailed")}
        </Button>
      ) : null}
      {views.map((v) => (
        <button
          key={v.id}
          className={`chip${active?.id === v.id ? " active" : ""}`}
          onClick={() => apply(v)}
          title={v.mine ? v.name : `${v.name} · ${v.ownerName}`}
        >
          {v.shared && !v.mine ? <IconShared /> : null}
          {v.name}
        </button>
      ))}

      {naming ? (
        <span className="views-form">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={ut("views.namePlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) save();
              if (e.key === "Escape") setNaming(false);
            }}
          />
          <button className="primary" disabled={busy || !name.trim()} onClick={save}>
            {ut("common.save")}
          </button>
          <button className="ghost" onClick={() => setNaming(false)}>
            {ut("common.cancel")}
          </button>
        </span>
      ) : (
        <button className="chip views-add" onClick={() => setNaming(true)} title={ut("views.saveHint")}>
          + {ut("views.save")}
        </button>
      )}

      {active?.mine ? (
        <>
          <button
            disabled={busy}
            className="chip"
            onClick={() =>
              void run(async () => {
                await api.updateView(active.id, { shared: !active.shared });
                res.reload();
              }, active.shared ? ut("views.madePersonal") : ut("views.madeShared"))
            }
          >
            {active.shared ? ut("views.makePersonal") : ut("views.makeShared")}
          </button>
          <button
            disabled={busy}
            className="chip-x"
            aria-label={ut("views.remove")}
            title={ut("views.remove")}
            onClick={() =>
              void run(async () => {
                await api.deleteView(active.id);
                res.reload();
              }, ut("views.removed"))
            }
          >
            <IconClose />
          </button>
        </>
      ) : null}
    </div>
  );
}

/** Общий вид помечается: важно понимать, что срез собрал не ты */
function IconShared() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="m8.6 13.5 6.8 4M15.4 6.5 8.6 10.5" />
    </svg>
  );
}
