import { Outlet, useLocation } from "react-router-dom";
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
 * Заголовок называет экран, дата стоит подзаголовком.
 *
 * Сначала было наоборот — датой вместо названия, из соображения «название
 * ничего не сообщает тому, кто уже здесь». Соображение верное, а решение
 * било мимо: над вкладками «Сводка» и «Сегодня» висело «чт, 10 сентября», и
 * заголовок экрана не совпадал ни с одной из них. Дата отвечает на свой
 * вопрос и подзаголовком — там она ничего не заслоняет.
 */
export default function Start() {
  const { ut } = useLang();
  const onToday = useLocation().pathname.startsWith("/today");
  return (
    <Page
      title={ut(onToday ? "day.title" : "dash.title")}
      sub={dayFull(new Date().toISOString().slice(0, 10))}
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
