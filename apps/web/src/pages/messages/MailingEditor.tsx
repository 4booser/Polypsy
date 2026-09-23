import { useEffect, useId, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { MailingCard } from "@quizzy/shared";
import { api } from "../../api";
import { useLang } from "../../lang";
import { Loading, useAction, useToast } from "../../ui";
import { IconGear, IconPlusThick } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { ActionMenu, type MenuEntry } from "../../ui/menu";
import { Button, Field, Input, Readout, Select, Textarea } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { MAX_OPTIONS, type MailingDraft, draftFromMailing, draftToInput, isFilled, mailingHref } from "./model";

/*
 * Повідомлення (розсилка) — кадры f16 и f22 макета, один экран.
 *
 * Два кадра — одна форма в двух состояниях:
 *
 *   f16 — новое: «Назва повідомлення», «Текст повідомлення», рамка «Відповідь»
 *         с полями «Так» / «Ні» и «+», кнопка «Створити». Шестерёнки нет.
 *   f22 — существующее: та же форма, справа над колонкой шестерёнка с меню
 *         «Відправити / Видалити / Зберегти»; варианты ответа — залитые плашки
 *         по центру рамки, без «+» и без «Створити».
 *
 * Где кадры расходятся, взято более полное прочтение, и вот как:
 *
 * 1. Черновик открывается редактируемым (f16: контурные поля вариантов и
 *    «+»), потому что в его меню есть «Зберегти» — сохранять нечего, если
 *    править нельзя. Отправленное открывается как f22 буквально: текст
 *    заморожен (сервер отвечает 409 на правку), варианты — залитые плашки.
 * 2. Подписи полей на f16 набраны серым обычным, на f22 — фиолетовым
 *    полужирным. Взят f22: так набраны подписи-плейсхолдеры на всех прочих
 *    кадрах, и так их печатает Field/Input каркаса.
 * 3. В меню стоит «Надіслати», а не «Відправити» с кадра: словарь держит одну
 *    форму слова (см. uiStrings.ts у якоря wave6:messages).
 *
 * Чего на кадрах нет, а здесь есть — ровно одно поле: «Група отримувачів».
 * На f16/f22 адресатов нет вовсе, а сервер без них отправлять отказывается
 * (err.mailingNoRecipients) — «Надіслати» было бы обещанием без исполнения.
 * Поле стоит последним, под рамкой «Відповідь», выбирает одну группу
 * пациентов (GET /api/patient-groups); поимённого списка нет — его нечем
 * нарисовать, не добавляя второй экран. У отправленного поле не печатается:
 * адресаты уже развёрнуты в получателей на сервере, и менять их нечем.
 *
 * Чего на кадрах нет и здесь НЕТ, хотя сервер отдаёт: счётчиков по
 * вариантам, числа получателей и их списка на карточке отправленного
 * (MailingCard.counts / answers / recipients). Правило волны — на экране
 * ровно то, что нарисовано; данные ждут своего кадра.
 *
 * Убрать вариант ответа можно, стерев его текст: глифа «убрать» на кадре нет,
 * пустые варианты выбрасываются при сохранении (model.ts, cleanOptions).
 *
 * Колонка 700 по центру — замер обоих кадров (455→1155 на 1600); шестерёнка —
 * у правого края колонки 1200, в строке над содержимым (Page.actions), как у
 * карточек людей и модели аналитики.
 */

/**
 * Обёртка с ключом: форма нового повідомлення и форма существующего — один
 * компонент на двух маршрутах, и без ключа переход с /mailings/:id на
 * /mailings/new оставил бы в полях чужой текст.
 */
export default function MailingPage() {
  const { id } = useParams<{ id: string }>();
  return <MailingEditor key={id ?? "new"} id={id ?? null} />;
}

/** Плейсхолдер селекта — фиолетовым полужирным, как подпись поля на макете */
const PLACEHOLDER = { color: "var(--primary)", fontWeight: 700 } as const;

/*
 * Рамка «Відповідь»: линия #666666 (как у полей), радиус 5. Поля замерены по
 * обоим кадрам: рамка 455…1154, подпись и варианты начинаются на 476…477 —
 * слева 21; нижняя линия 526 при низе вариантов 507 — снизу 18.
 */
const answerBox = "rounded-[5px] border border-border px-[21px] pb-[18px] pt-[19px]";
const answerHeading = "m-0 text-[17px] font-bold leading-[20px] text-primary";

/** Ширина варианта — 137 (f22: плашка 659…795; f16: поле 477…611 в рамке) */
const optionWidth = "w-[137px]";

function MailingEditor({ id }: { id: string | null }) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, busy } = useAction();
  const answerId = useId();

  const card = useResource(() => api.mailing(id!), [id], { enabled: id !== null });
  /*
   * Группы — для поля адресатов. Отказ списка форму не запирает: черновик
   * сохраняется и без группы, а «Надіслати» ответит отказом сервера словами.
   */
  const groups = useResource(() => api.patientGroups(), []);

  /*
   * «Так» и «Ні» — умолчание нового повідомлення, как на f16: два варианта
   * вписаны заранее, автор их правит или добавляет третий.
   */
  const [draft, setDraft] = useState<MailingDraft | null>(() =>
    id === null ? { title: "", body: "", options: [ut("mail.yes"), ut("mail.no")], patientGroupId: "" } : null,
  );
  /* черновик заполняется из карточки один раз: перечитывание карточки набранное не затирает */
  useEffect(() => {
    if (card.data && draft === null) setDraft(draftFromMailing(card.data));
  }, [card.data, draft]);

  const sent = card.data?.status === "sent";
  const patch = (next: Partial<MailingDraft>) => setDraft((d) => (d ? { ...d, ...next } : d));
  const setOption = (i: number, text: string) =>
    setDraft((d) => (d ? { ...d, options: d.options.map((o, k) => (k === i ? text : o)) } : d));
  const addOption = () =>
    setDraft((d) => (d && d.options.length < MAX_OPTIONS ? { ...d, options: [...d.options, ""] } : d));

  /* «Створити» — черновик; отправка отдельным действием из меню-шестерни, как задумано сервером */
  const create = () => {
    if (!draft) return;
    void run(async () => {
      const created = await api.createMailing(draftToInput(draft));
      /* replace: «назад» из карточки нового повідомлення ведёт в список, а не в пустую форму */
      navigate(mailingHref(created.id), { replace: true });
    }, ut("mail.created"));
  };

  const save = () => {
    if (!draft || id === null) return;
    void run(async () => {
      const updated = await api.updateMailing(id, draftToInput(draft));
      /* сервер вернул вычищенные варианты (без пустых) — форма показывает их, а не набранное */
      setDraft(draftFromMailing(updated));
    }, ut("mail.saved"));
  };

  /*
   * Отправка сначала сохраняет: человек правил текст и нажал «Надіслати», не
   * нажимая «Зберегти», — уйти должно то, что он видит, а не то, что лежало
   * на сервере с прошлого раза. Вопрос задаётся до запросов: run считает
   * действие несделанным по false.
   */
  const send = () => {
    if (!draft || id === null) return;
    void run(async () => {
      if (!window.confirm(ut("mail.confirmSend"))) return false;
      await api.updateMailing(id, draftToInput(draft));
      await api.sendMailing(id);
      card.reload();
    }, ut("mail.sent"));
  };

  /*
   * «Видалити» у отправленного превращается в «приховати»: сервер отправленное
   * не удаляет (409 err.mailingSentNotDeletable — его уже читали и на него
   * отвечали), а скрывает у автора. Пункт меню один, как на кадре; разницу
   * называет вопрос перед действием.
   */
  const remove = () => {
    if (id === null) return;
    void run(async () => {
      if (sent) {
        if (!window.confirm(ut("mail.confirmHide"))) return false;
        await api.hideMailing(id);
        toast(ut("mail.hidden"), "ok");
      } else {
        if (!window.confirm(ut("mail.confirmDelete"))) return false;
        await api.deleteMailing(id);
        toast(ut("mail.deleted"), "ok");
      }
      navigate("/mailings", { replace: true });
    });
  };

  if (id !== null && card.error) {
    return (
      <Page title={ut("top.messages")} titleHidden>
        <Loading error={card.error} onRetry={card.reload} />
      </Page>
    );
  }
  if (!draft || (id !== null && !card.data)) {
    return (
      <Page title={ut("top.messages")} titleHidden>
        <Loading rows={6} />
      </Page>
    );
  }

  const filled = isFilled(draft);
  /* недоступный пункт остаётся в меню с подсказкой, почему: на кадре все три нарисованы всегда */
  const lock = sent ? ut("mail.alreadySent") : !filled ? ut("mail.fillIn") : undefined;
  const entries: MenuEntry[] = [
    { label: ut("mail.send"), onSelect: send, disabled: busy || !!lock, hint: lock },
    { label: ut("mail.delete"), onSelect: remove, disabled: busy },
    { label: ut("common.save"), onSelect: save, disabled: busy || !!lock, hint: lock },
  ];

  return (
    <Page
      title={ut("top.messages")}
      titleHidden
      /*
       * У нового повідомлення шестерёнки нет (f16) — на её месте распорка той
       * же высоты, чтобы форма стояла на одном уровне на обоих маршрутах:
       * иначе после «Створити» она прыгала бы вниз на высоту глифа.
       */
      actions={
        id === null ? (
          <span aria-hidden className="block h-[27px]" />
        ) : (
          <ActionMenu label={ut("mail.menu")} glyph={<IconGear />} entries={entries} />
        )
      }
    >
      <form
        className="mx-auto w-full max-w-[700px]"
        onSubmit={(e) => {
          e.preventDefault();
          if (id === null) create();
          else if (!sent) save();
        }}
      >
        {sent && card.data ? (
          <SentView m={card.data} answerId={answerId} />
        ) : (
          <>
            <Field label={ut("mail.name")}>
              <Input value={draft.title} onChange={(e) => patch({ title: e.target.value })} maxLength={200} autoComplete="off" />
            </Field>
            {/* 195 — высота текстовой области на кадре (207→401); тянуть вниз можно, ужать ниже нельзя */}
            <Field label={ut("mail.body")}>
              <Textarea
                value={draft.body}
                onChange={(e) => patch({ body: e.target.value })}
                maxLength={4000}
                className="h-[195px] resize-y"
              />
            </Field>
            <div role="group" aria-labelledby={answerId} className={answerBox}>
              <p id={answerId} className={answerHeading}>
                {ut("mail.answer")}
              </p>
              {/*
                Варианты — контурные поля 137×36, как на f16. Имя каждому даёт
                aria-label с номером: подписи у них нет, а два безымянных поля
                подряд диктор различить не может. Ширина — обёрткой: у Input
                стоит w-full, и второй класс ширины с ним спорил бы порядком в
                собранном CSS.

                Два зазора, а не один, и это замер: между полями 21 (правая
                линия первого 611, левая второго 633), а до «+» 18 (поле
                кончается на 767, квадрат глифа 27 начинается на 785). Один
                общий зазор пришлось бы выбрать неверным в одном из двух мест.
              */}
              <div className="mt-[18px] flex items-start gap-[18px]">
                <div className="flex flex-wrap items-center gap-[21px]">
                  {draft.options.map((o, i) => (
                    <div key={i} className={optionWidth}>
                      <Input
                        aria-label={`${ut("mail.option")} ${i + 1}`}
                        value={o}
                        onChange={(e) => setOption(i, e.target.value)}
                        maxLength={100}
                        autoComplete="off"
                        className="text-center"
                      />
                    </div>
                  ))}
                </div>
                {/* глиф встаёт по верху ряда: при переносе вариантов он остаётся у первой строки */}
                <Button
                  size="glyph"
                  variant="ghost"
                  className="mt-[4px] shrink-0"
                  aria-label={ut("mail.addOption")}
                  disabled={draft.options.length >= MAX_OPTIONS}
                  onClick={addOption}
                >
                  <IconPlusThick />
                </Button>
              </div>
            </div>
            {/* единственное поле не с кадра — см. заголовок файла; inline: отступы здесь свои */}
            <Field inline label={ut("mail.recipients")} className="mt-[15px]">
              <Select
                value={draft.patientGroupId}
                style={draft.patientGroupId ? undefined : PLACEHOLDER}
                onChange={(e) => patch({ patientGroupId: e.target.value })}
              >
                <option value="">{ut("mail.recipients")}</option>
                {(groups.data ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.title}
                  </option>
                ))}
              </Select>
            </Field>
            {id === null ? (
              /* 215×45 у правого края колонки, 46 от рамки — замер f16 */
              <div className="mt-[46px] flex justify-end">
                <Button type="submit" size="md" className="w-[215px]" disabled={busy || !filled}>
                  {ut("mail.create")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </form>
    </Page>
  );
}

/**
 * Отправленное — кадр f22 буквально: название в силуэте поля фиолетовым
 * полужирным, текст серым в рамке, варианты — залитые плашки 139×36 по
 * центру рамки «Відповідь». Не поля, а показ (Readout): править нечего, и
 * диктору незачем объявлять «поле ввода, только чтение» трижды.
 */
function SentView({ m, answerId }: { m: MailingCard; answerId: string }) {
  const { ut } = useLang();
  return (
    <>
      <Readout look="outline" className="font-bold text-primary">
        {m.title}
      </Readout>
      <div className="mt-[15px] min-h-[195px] whitespace-pre-wrap break-words rounded-[5px] border border-border px-[12px] py-[8px] text-[17px] leading-[22px] text-muted">
        {m.body}
      </div>
      <div role="group" aria-labelledby={answerId} className={`mt-[15px] ${answerBox}`}>
        <p id={answerId} className={answerHeading}>
          {ut("mail.answer")}
        </p>
        {m.options.length ? (
          /* зазор 19: плашки на f22 стоят 659…795 и 815…951, по центру рамки */
          <ul className="m-0 mt-[18px] flex list-none flex-wrap justify-center gap-[19px] p-0">
            {m.options.map((o, i) => (
              <Readout key={i} as="li" look="fill" className={`${optionWidth} justify-center font-bold text-primary`}>
                {o}
              </Readout>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}
