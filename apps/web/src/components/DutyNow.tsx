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
    /*
      Имена дежурных набраны обычным текстом, а подпись — приглушённым: в
      три часа ночи глазу нужно имя, а не слово «дежурная смена». Когда
      дежурных нет, приглушено всё — сообщать нечего, и строка не должна
      перетягивать внимание с того, что ниже.
    */
    <p className="duty-line m-0 text-small">
      <span className="text-faint">{ut("duty.title")}:</span>{" "}
      {items.length ? (
        <span className="text-text">{items.map((d) => d.name).join(", ")}</span>
      ) : (
        <span className="text-muted">{ut("duty.nobody")}</span>
      )}
    </p>
  );
}
