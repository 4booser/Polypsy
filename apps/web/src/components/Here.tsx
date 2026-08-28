import { usePresence } from "../events";
import { useLang } from "../lang";
import { Avatar } from "../ui";

/**
 * «Здесь же сейчас».
 *
 * Показывает, кто ещё держит открытым тот же экран. Ничего не запрещает:
 * жёсткая блокировка в клинике опаснее конфликта — человек, взявший случай,
 * уходит со смены, и запись остаётся запертой до тех пор, пока кто-нибудь не
 * полезет в базу. От потери правок защищает проверка версии при сохранении.
 *
 * Пусто — не рисуем ничего: в обычный день сотрудник на экране один, и
 * постоянная пустая полоса быстро становится невидимой.
 */
export function Here({ resource }: { resource: string }) {
  const { ut } = useLang();
  const others = usePresence(resource);
  if (!others.length) return null;

  return (
    <div className="here" title={others.map((o) => o.name).join(", ")}>
      <div className="here-faces">
        {others.slice(0, 3).map((o) => (
          <Avatar key={o.id} name={o.name} size={22} />
        ))}
      </div>
      <span className="muted">
        {others.length === 1 ? others[0]!.name : `${ut("here.also")} ${others.length}`}
      </span>
    </div>
  );
}
