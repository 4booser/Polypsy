import { useEffect, useState } from "react";
import { api } from "../api";
import { useResource } from "../useResource";
import { useAction } from "../ui";
import { Page, Panel } from "../ui/layout";
import { Button, Field, Tag, Textarea } from "../ui/primitives";
import { useLang } from "../lang";

/*
 * Экран групп переехал в собственный файл.
 *
 * Он вырос из «списка с кнопкой удалить» в администрирование плюс аналитику
 * и рядом с учётными записями держаться перестал: два несвязанных экрана в
 * одном файле — это диффы, в которых не видно, что менялось.
 *
 * Реэкспорт остаётся: маршрут «/groups» в App.tsx подгружает `Groups`
 * именно отсюда, и убрать эту строку значит сломать его — а App.tsx сейчас
 * правят другие.
 */
export { default as Groups } from "./Groups";

/*
 * Экран учётных записей (`Users`) отсюда снят (волна 10): весь реестр,
 * заведение, устройства и остальное живут во вкладке «Користувачі»
 * техпанели (pages/ops/Users.tsx), а /users перенаправляет туда. Текст
 * согласия остался здесь — дверь к нему стоит на той же вкладке.
 */

/**
 * Текст информированного согласия. Правка создаёт новую версию, и все
 * пациенты увидят экран согласия заново — у каждого принятия зафиксировано,
 * какую редакцию человек читал.
 */
export function ConsentText() {
  const { ut } = useLang();
  const [uk, setUk] = useState("");
  const [ru, setRu] = useState("");
  // английский необязателен: пустое поле — «не задан», и человеку с английским интерфейсом покажут украинский
  const [en, setEn] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const { run } = useAction();

  const current = useResource(() => api.consentText(), []).data;
  useEffect(() => {
    if (!current) return;
    setVersion(current.version);
    setUk(current.body.uk ?? "");
    setRu(current.body.ru ?? "");
    setEn(current.body.en ?? "");
  }, [current]);

  /*
   * Отдельный экран открывается по своему адресу — значит у него должен быть
   * заголовок экрана, а не заголовок панели.
   *
   * Панель без страницы вокруг оставляла консоль без единственного h1: экран
   * выглядел цельным, но читалка с экрана начинала с поля ввода, а проверка
   * полноты перевода, ждущая заголовок, зависала именно здесь.
   */
  return (
    <Page
      title={ut("adm.consentTitle")}
      sub={ut("adm.consentHint")}
      actions={
        <Tag tone="plain">
          {version ? `${ut("adm.consentVersion")} ${version}` : ut("adm.consentUnset")}
        </Tag>
      }
    >
      <Panel>
      <div className="grid gap-3 sm:grid-cols-2 min-[900px]:grid-cols-3">
        <Field label={ut("adm.inUkrainian")}>
          <Textarea rows={5} value={uk} onChange={(e) => setUk(e.target.value)} />
        </Field>
        <Field label={ut("adm.inRussian")}>
          <Textarea rows={5} value={ru} onChange={(e) => setRu(e.target.value)} />
        </Field>
        <Field label={ut("adm.inEnglish")}>
          <Textarea rows={5} value={en} onChange={(e) => setEn(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3">
        <Button
          variant="primary"
          disabled={
            uk.trim().length < 10 ||
            ru.trim().length < 10 ||
            // начатый английский должен быть текстом, а не парой букв — ту же границу держит сервер
            (en.trim().length > 0 && en.trim().length < 10)
          }
          onClick={() =>
            run(async () => {
              const res = await api.saveConsentText({ uk: uk.trim(), ru: ru.trim(), en: en.trim() });
              setVersion(res.version);
            }, ut("adm.consentSaved"))
          }
        >
          {ut("adm.consentSave")}
        </Button>
      </div>
      </Panel>
    </Page>
  );
}
