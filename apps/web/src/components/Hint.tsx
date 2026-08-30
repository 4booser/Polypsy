import type { UiKey } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { Button } from "../ui/primitives";

/**
 * Точечная подсказка.
 *
 * Не тур по экранам и не всплывающее окно при первом входе: и то, и другое
 * человек закрывает не читая, потому что показывается это до того, как вопрос
 * возник. Подсказка стоит там, где вопрос возникает, — рядом со стеном, рядом
 * со шкалой достоверности, рядом со статусом случая.
 *
 * Хранится список ЗАКРЫТЫХ подсказок, а не показанных. Разница существенная:
 * подсказка по умолчанию видна, и человек, впервые открывший экран, увидит
 * объяснение, даже если запись о показе где-то потерялась. Обратный порядок
 * означал бы, что потерянная запись навсегда прячет объяснение.
 */
export function Hint({ id, text }: { id: string; text: UiKey }) {
  const { ut } = useLang();
  const { user, refreshUser } = useAuth();

  const dismissed = user?.workspace?.dismissedHints ?? [];
  if (dismissed.includes(id)) return null;

  return (
    <aside className="hint-box" role="note">
      <p>{ut(text)}</p>
      <Button
        variant="quiet"
        onClick={() => {
          /*
           * Закрытие сохраняется на сервере: сотрудник садится за разные
           * машины, и объяснять ему одно и то же на каждой — то же самое, что
           * не объяснить ни разу.
           */
          void api
            .saveWorkspace({ dismissedHints: [...dismissed, id] })
            .then(refreshUser)
            .catch(() => {});
        }}
      >
        {ut("hint.gotIt")}
      </Button>
    </aside>
  );
}
