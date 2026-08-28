import { api } from "../api";
import { useLang } from "../lang";
import { useResource } from "../useResource";

/**
 * Кто сейчас на дежурной смене.
 *
 * Строка, а не карточка: это справка, а не работа. Смысл в том, чтобы на
 * вопрос «кому звонить в три часа ночи» отвечал экран, а не память.
 */
export function DutyNow() {
  const { ut } = useLang();
  const res = useResource(() => api.duty(), []);
  const items = res.data ?? [];

  return (
    <p className="duty-line">
      <span className="muted">{ut("duty.title")}:</span>{" "}
      {items.length ? items.map((d) => d.name).join(", ") : <span className="muted">{ut("duty.nobody")}</span>}
    </p>
  );
}
