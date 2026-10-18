import { usePresence } from "../events";
import { useLang } from "../lang";
import { Avatar, Popover } from "../ui";

/**
 * «Здесь же сейчас».
 *
 * Показывает, кто ещё держит открытым тот же экран. Ничего не запрещает:
 * жёсткая блокировка в клинике опаснее конфликта — человек, взявший случай,
 * уходит со смены, и запись остаётся запертой до тех пор, пока кто-нибудь не
 * полезет в базу. От потери правок защищает проверка версии при сохранении.
 *
 * Пусто — не рисуем ничего: в обычный день сотрудник на экране один, и
 * постоянная пустая полоса быстро становится невидимой. Кружки — сотрудники
 * (нейтральные, не фиолетовые: фиолетовый кружок в карточке — пациент),
 * имена целиком — в поповере.
 */
export function Here({ resource }: { resource: string }) {
  const { ut } = useLang();
  const others = usePresence(resource);
  if (!others.length) return null;

  const label = others.length === 1 ? others[0]!.name : `${ut("here.also")} ${others.length}`;
  return (
    <Popover
      title={label}
      content={
        <ul className="m-0 list-none p-0">
          {others.map((o) => (
            <li key={o.id} className="py-0.5 text-text">
              {o.name}
            </li>
          ))}
        </ul>
      }
    >
      <span
        tabIndex={0}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-pill bg-sunk pl-1 pr-2.5 text-caption font-semibold text-text-2 outline-none focus-visible:shadow-[0_0_0_2px_var(--vring)]"
      >
        <span className="flex -space-x-1.5">
          {others.slice(0, 3).map((o) => (
            <Avatar key={o.id} name={o.name} size={24} tone="neutral" className="ring-2 ring-panel" />
          ))}
        </span>
        <span className="max-w-[160px] truncate">{label}</span>
      </span>
    </Popover>
  );
}
