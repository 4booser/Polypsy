import { Link } from "react-router-dom";
import { api } from "../api";
import { Screen } from "../ui";
import { useLang } from "../lang";
import { useResource } from "../useResource";
import { cx } from "../ui/cx";
import { IconTest } from "./icons";

/**
 * Методики, которые человек может пройти сам.
 *
 * Список отдаёт сервер по тому, к чему у человека есть доступ, — и
 * общедоступные методики каталога сюда попадают наравне с назначенными.
 * Разделять их на экране не стали: для проходящего разницы нет, а «вам
 * назначено» рядом с «можно и так» читается как выговор.
 */
export default function PatientTests() {
  const { ut } = useLang();
  const res = useResource(() => api.surveys(), []);

  return (
    <Screen res={res}>
      {(items) => {
        /*
         * Пройденное не прячем, но и не предлагаем как новое.
         *
         * Сервер откажет в повторной сдаче там, где методика этого не
         * разрешает, — и отказ придёт ПОСЛЕ семидесяти отвеченных пунктов.
         * Человек, потративший десять минут и получивший «уже проходили»,
         * больше сюда не вернётся, и правильно сделает.
         */
        const list = items.filter((s) => s.status === "published");
        const fresh = list.filter((s) => !s.completedByMe);
        const passed = list.filter((s) => s.completedByMe);
        return (
          <div className="flex flex-col gap-2 p-4">
            {list.length === 0 ? (
              <p className="text-muted">{ut("pt.noTests")}</p>
            ) : (
              [...fresh, ...passed].map((s) => (
                <Link
                  key={s.id}
                  to={`/me/tests/${s.id}`}
                  className="flex items-start gap-3 rounded-sm border border-border bg-surface p-3"
                >
                  <span className="mt-0.5 shrink-0 text-muted [&>svg]:size-[20px]">
                    <IconTest />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-small">{s.title}</span>
                    {s.description ? (
                      <span className="mt-0.5 block text-caption text-muted">{s.description}</span>
                    ) : null}
                  </span>
                  <span
                    className={cx(
                      "shrink-0 text-caption",
                      s.completedByMe ? "text-faint" : "text-primary",
                    )}
                  >
                    {s.completedByMe ? ut("pt.passed") : s.assigned ? ut("pt.assigned") : ut("pt.start")}
                  </span>
                </Link>
              ))
            )}
          </div>
        );
      }}
    </Screen>
  );
}
