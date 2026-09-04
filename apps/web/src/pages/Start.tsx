import { Outlet } from "react-router-dom";
import { dayFull } from "../format";
import { Page } from "../ui/layout";
import { Tabs } from "../ui/primitives";
import { useLang } from "../lang";

/**
 * Начало смены: сводка и приём одного дня на одном экране.
 *
 * Были два пункта рельсы подряд — «Сводка» и «Сегодня», — и оба отвечали на
 * один вопрос: с чего начать. Выбирать между двумя ответами на один вопрос
 * человеку незачем, а разница между ними не та, ради которой заводят
 * отдельный экран: сводка говорит, как идут дела вообще, приём — кто придёт
 * сегодня.
 *
 * Заголовком стоит дата, а не название экрана. Название («Начало») ничего не
 * сообщает тому, кто уже здесь, а дата отвечает на вопрос, который на этом
 * экране действительно задают, — особенно когда листаешь приём на другой
 * день и надо понимать, где ты.
 */
export default function Start() {
  const { ut } = useLang();
  return (
    <Page
      title={dayFull(new Date().toISOString().slice(0, 10))}
      toolbar={
        <Tabs
          items={[
            { to: "/", label: ut("dash.title"), end: true },
            { to: "/today", label: ut("day.title") },
          ]}
        />
      }
    >
      <Outlet />
    </Page>
  );
}
