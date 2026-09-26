import { useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { UiKey } from "@quizzy/shared";
import { api, type SavedView } from "../../api";
import { useLang } from "../../lang";
import { Modal, useAction } from "../../ui";
import type { MenuEntry } from "../../ui/menu";
import { Button, Field, Input } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { activeView, viewParams, viewSearch } from "../../ui/viewParams";

/*
 * Сохранённые виды списка пациентов — пунктами меню шестерёнки.
 *
 * Волна 12, разбор кода: «редизайн удалил сохранённые виды списка
 * пациентов». Удалить не удалил — спрятал, и спрятал так, что пользоваться
 * было почти нечем. Строка чипсов старого образца (ui/SavedViews.tsx, классы
 * наследия) открывалась пунктом «Збережені вигляди» и закрывалась сама при
 * первом же выборе вида на другую группу: вкладка группы пересобирает экран,
 * и состояние «строка открыта» терялось вместе с ним. Открытый вид после
 * этого нельзя было ни увидеть, ни удалить, не зовя строку снова; к тому же
 * вид хранил номер страницы и переставал узнаваться после листания (см.
 * ui/viewParams.ts).
 *
 * Теперь всё — в той же шестерёнке и одним списком: виды (открытый погашен
 * с подсказкой), «Зберегти відбір…», а для открытого своего — «Відкрити
 * колегам»/«Зробити особистим» и «Видалити». Строки над сеткой по-прежнему
 * нет: на кадре f05 между вкладками и сеткой чистое поле, и решение
 * заказчика держать там пустоту остаётся в силе. Виды лежат на сервере
 * (saved_views, scope «patients») — сохранённые людьми раньше видны и
 * открываются, лишние в них ?page и ?per просто не читаются.
 *
 * Отбор — это группа и поиск. Строк на странице — не отбор, а привычка
 * глаза: вид «Вечірня група» не должен менять человеку размер страницы.
 */
const SCOPE = "patients";
export const PATIENT_VIEW_KEYS = ["group", "q"] as const;

export function usePatientViews(): { entries: MenuEntry[]; dialog: ReactNode } {
  const { ut } = useLang();
  const navigate = useNavigate();
  const { search } = useLocation();
  const { run } = useAction();
  const [naming, setNaming] = useState(false);

  const res = useResource(() => api.views(SCOPE), []);
  const views = res.data ?? [];
  const current = viewParams(search, PATIENT_VIEW_KEYS);

  /* переход, а не замена адреса: «назад» возвращает к отбору, с которого открыли вид */
  const open = (v: SavedView) => {
    const next = viewSearch(search, v.params, PATIENT_VIEW_KEYS);
    navigate({ search: next ? `?${next}` : "" });
  };

  const entries = viewMenu(views, search, ut, {
    open,
    save: () => setNaming(true),
    share: (v) =>
      void run(async () => {
        await api.updateView(v.id, { shared: !v.shared });
        res.reload();
      }, v.shared ? ut("views.madePersonal") : ut("views.madeShared")),
    remove: (v) =>
      void run(async () => {
        await api.deleteView(v.id);
        res.reload();
      }, ut("views.removed")),
  });

  const dialog = naming ? (
    <SaveViewDialog
      params={current}
      onClose={() => setNaming(false)}
      onSaved={() => {
        setNaming(false);
        res.reload();
      }}
    />
  ) : null;

  return { entries, dialog };
}

/**
 * Пункты шестерёнки для видов — чистая функция: что в меню при каком адресе,
 * проверяется без браузера (apps/web/test/savedViews.test.ts).
 */
export function viewMenu(
  views: readonly SavedView[],
  search: string,
  ut: (key: UiKey) => string,
  act: { open: (v: SavedView) => void; save: () => void; share: (v: SavedView) => void; remove: (v: SavedView) => void },
): MenuEntry[] {
  const current = viewParams(search, PATIENT_VIEW_KEYS);
  const active = activeView(views, search, PATIENT_VIEW_KEYS);
  const entries: MenuEntry[] = views.map((v) => ({
    key: `view:${v.id}`,
    /* чужой общий вид подписан хозяином: важно понимать, что срез собрал не ты */
    label: v.mine ? v.name : `${v.name} · ${v.ownerName}`,
    onSelect: () => act.open(v),
    disabled: v.id === active?.id,
    hint: ut("views.current"),
  }));
  entries.push({
    key: "view:save",
    label: ut("views.saveCurrent"),
    onSelect: act.save,
    /* «все пациенты без поиска» — не отбор: такой вид открывал бы то же, что пункт «Усі» */
    disabled: !current,
    hint: ut("views.nothingToSave"),
  });
  if (active?.mine) {
    entries.push(
      {
        key: "view:share",
        label: active.shared ? ut("views.makePersonal") : ut("views.makeShared"),
        onSelect: () => act.share(active),
      },
      { key: "view:remove", label: `${ut("views.remove")}: ${active.name}`, danger: true, onSelect: () => act.remove(active) },
    );
  }
  return entries;
}

/** «Зберегти відбір»: одно поле имени, как переименование отбора людей (Cohorts, RenameDialog) */
function SaveViewDialog({ params, onClose, onSaved }: { params: string; onClose: () => void; onSaved: () => void }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [name, setName] = useState("");
  const clean = name.trim();
  return (
    <Modal title={ut("views.save")} onClose={onClose}>
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          if (!clean) return;
          void run(async () => {
            await api.saveView({ scope: SCOPE, name: clean, params });
            onSaved();
          }, ut("views.saved"));
        }}
      >
        <p className="m-0 mb-[12px] text-[13px] leading-[18px] text-muted">{ut("views.saveHint")}</p>
        <Field label={ut("f.name")}>
          {/* предел сервера — 80 знаков (routes/views.ts, saveSchema) */}
          <Input
            look="outline"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={ut("views.namePlaceholder")}
            maxLength={80}
            autoFocus
            required
          />
        </Field>
        <div className="mt-[15px] flex justify-end gap-[14px]">
          <Button variant="ghost" onClick={onClose}>
            {ut("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || !clean}>
            {ut("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
