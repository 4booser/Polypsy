import { useEffect, useId, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { MailingCard } from "@quizzy/shared";
import { api } from "../../api";
import { useLang } from "../../lang";
import { Loading, Modal, useAction, useToast } from "../../ui";
import { IconGear, IconPlusThick } from "../../ui/glyphs";
import { Page } from "../../ui/layout";
import { ActionMenu, type MenuEntry } from "../../ui/menu";
import { Button, Field, Input, Readout, Select, Textarea } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { MAX_OPTIONS, type MailingDraft, draftFromMailing, draftToInput, isFilled, mailingHref } from "./model";

/*
 * Повідомлення (розсилка) — кадры f20 и f26 макета, один экран.
 *
 * Два кадра — одна форма в двух состояниях:
 *
 *   f20 — новое: «Назва повідомлення», «Текст повідомлення», рамка «Відповідь»
 *         с полями «Так» / «Ні» и «+», кнопка «Створити». Шестерёнки нет.
 *   f26 — существующее: та же форма, справа над колонкой шестерёнка с меню
 *         «Відправити / Видалити / Зберегти»; варианты ответа — залитые плашки
 *         по центру рамки, без «+» и без «Створити».
 *
 * Где кадры расходятся, взято более полное прочтение, и вот как:
 *
 * 1. Черновик открывается редактируемым (f20: контурные поля вариантов и
 *    «+»), потому что в его меню есть «Зберегти» — сохранять нечего, если
 *    править нельзя. Отправленное открывается как f26 буквально: текст
 *    заморожен (сервер отвечает 409 на правку), варианты — залитые плашки.
 * 2. Кегль и цвет у двух состояний РАЗНЫЕ, и это тоже два кадра, а не
 *    разнобой. Пустая форма (f20) набрана 17 серым обычным: подпись-
 *    плейсхолдер «Назва повідомлення» — чернила 460…615 цветом (102,102,102)
 *    при кап-высоте «Н» 157…167. Заполненное (f26) набрано 20: та же строка
 *    идёт 460…655 фиолетовым полужирным при кап-высоте 156…169. Отношение
 *    кап/кегль 0,70 сверено на двух известных константах кадра — меню 20/700
 *    (кап 13–14) и заголовок 24/700 (кап 17). Отсюда `ph="plain"` у полей
 *    черновика и 20-й кегль у показа.
 * 3. В меню стоит «Відправити» — слово кадра f26 (чернила пункта 1293…1376).
 *    Словарь держит одну форму слова на весь интерфейс, поэтому вместе с
 *    этим пунктом на «відправити/відправлення/відправлено» переведены ВСЕ
 *    строки словаря (см. uiStrings.ts у якоря audit:messages).
 *
 * Чего на кадрах нет — того нет и на экране. Поле «Група отримувачів» с
 * формы убрано: на f20 под рамкой «Відповідь» сразу кнопка «Створити»
 * (заливка #f0ecff 935…1149 × 561…605 при нижней линии рамки 515), то есть
 * просвет ровно 46, а поле с его шагом 51 давало 97. Сама возможность при
 * этом никуда не делась: группа спрашивается в окне шага «Відправити» из
 * меню-шестерни, перед api.sendMailing, — сервер без адресатов отправлять
 * отказывается (err.mailingNoRecipients), и обещание без исполнения тут
 * было бы хуже лишнего поля.
 *
 * Чего на кадрах нет и здесь НЕТ, хотя сервер отдаёт: счётчиков по
 * вариантам, числа получателей и их списка на карточке отправленного
 * (MailingCard.counts / answers / recipients). Правило волны — на экране
 * ровно то, что нарисовано; данные ждут своего кадра.
 *
 * Убрать вариант ответа можно, стерев его текст: глифа «убрать» на кадре нет,
 * пустые варианты выбрасываются при сохранении (model.ts, cleanOptions).
 *
 * Колонка формы 700 по центру — замер обоих кадров: левая рамка полей стоит
 * на 450, правая на 1149 при кадре 1600, то есть центр колонки 800 = центр
 * кадра. Шестерёнка на f26 стоит НЕ у самого края колонки: её чернила идут
 * 1355…1380 при правом крае колонки 1400, то есть в 20 от него.
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
 * Рамка «Відповідь»: линия #666666, та же, что у полей, радиус 5. Все поля —
 * от рамок, а не от внутренней белизны: во всём проекте box-sizing: border-box
 * (legacy.css), и число в классе — это border-box.
 *
 * Тон рамки — --field-border (#666666), а не --border (#cccccc): на обоих
 * кадрах горизонтальные линии рамки (f20: y = 406 и 515) и боковые (x = 450 и
 * 1149) идут ровно (102,102,102), как и рамки полей вариантов внутри неё.
 * Комментарий здесь это и говорил, а класс брал тон линий-разделителей.
 *
 * f20: рамка 406…515 (110 по border-box), border-box первого варианта
 * начинается на 470 → слева 19, а не 21: 476 — это уже чернила буквы «В», у
 * неё свой отступ внутри знака. Верх: 406 + 1 + 19 = 426, подпись ростом 17,
 * зазор 18 — вариант встаёт на 461; та же арифметика сходится и на f26
 * (407 + 1 + 19 + 17 + 18 = 462 при плашках 470…505 и нижней линии 516).
 */
const answerBox = "rounded-[5px] border border-field-border px-[19px] pb-[18px] pt-[19px]";
/*
 * Рост строки подписи 17 — не вкус, а условие: высота рамки на обоих кадрах
 * ровно 110, и 1+19+17+18+36+18+1 = 110. Кегль внутрь этой строки помещается
 * любой: она задаёт шаг, а не рост знака.
 *
 * Кегль и начертание у подписи разные, и это два разных состояния, а не
 * разнобой макета. Пустая форма (f20): чернила «Відповідь» 471…543 (73px)
 * цветом (102,102,102), кап-высота «В» 430…440 — это 17/400. Отправленное
 * (f26): 471…563 (93px) фиолетовым, кап-высота «В» 429…442 — это 20/700.
 * Прежний вывод «13» для f20 был сделан из отношения ширин 73/93, а ширины
 * здесь мерить нельзя: слова набраны разным начертанием, и полужирный шире
 * обычного сам по себе. Мерить надо кап-высоту, что и сделано.
 */
const answerHeadingBase = "m-0 leading-[17px]";
const answerHeadingDraft = `${answerHeadingBase} text-[17px] text-muted`;
const answerHeadingSent = `${answerHeadingBase} text-[20px] font-bold text-primary`;

/**
 * Ширина варианта — 139, замер по рамкам: f20 первый вариант 470…608, второй
 * 626…764; f26 заливка #f0ecff 653…791 и 809…947 при середине колонки 800.
 * Белое нутро у́же на 2 — это рамки, и в border-box они входят в ширину.
 */
const optionWidth = "w-[139px]";

/*
 * Набор ЗАПОЛНЕННОГО повідомлення — кадр f26: 20-й кегль там, где пустая
 * форма (f20) набрана 17-м.
 *
 * Замер по кап-высоте, а не по ширине строки (начертание разное): «Назва
 * повідомлення» на f26 — чернила 460…655, кап «Н» 156…169 = 14, то есть 20
 * при отношении кап/кегль 0,70; на f20 та же строка — 460…615, кап 157…167 =
 * 11, то есть 17. Текст письма на f26 — кап 224…237 = 14 при шаге строк 22,
 * цвет (102,102,102).
 *
 * Высоты коробок от смены кегля не едут и потому не трогаются: у названия 36
 * (24 строка + 6 + 6 у Readout), у текста 195, у рамки «Відповідь» 110, у
 * плашек вариантов 139×36. Кегль просится свойством `size` у Readout, а не
 * классом снаружи: два `text-[…]` в одной строке классов спорят.
 */

function MailingEditor({ id }: { id: string | null }) {
  const { ut } = useLang();
  const navigate = useNavigate();
  const toast = useToast();
  const { run, busy } = useAction();
  const answerId = useId();

  const card = useResource(() => api.mailing(id!), [id], { enabled: id !== null });
  /*
   * Группы — для окна отправки, а не для формы: на кадрах поля адресатов нет,
   * и оно убрано с глаз (см. шапку файла). Отказ списка форму не запирает:
   * черновик сохраняется и без группы, а в окне отправки виден честный отказ.
   */
  const groups = useResource(() => api.patientGroups(), []);
  /* окно шага «Відправити»: выбор группы + подтверждение, вместо поля в форме */
  const [sending, setSending] = useState(false);

  /*
   * «Так» и «Ні» — умолчание нового повідомлення, как на f20: два варианта
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
   * Отправка сначала сохраняет: человек правил текст и нажал «Відправити», не
   * нажимая «Зберегти», — уйти должно то, что он видит, а не то, что лежало
   * на сервере с прошлого раза. Группа адресатов уходит тем же сохранением:
   * поля на экране нет, и выбранное в окне надо донести до сервера до
   * api.sendMailing, иначе он ответит err.mailingNoRecipients.
   */
  const send = () => {
    if (!draft || id === null) return;
    void run(async () => {
      await api.updateMailing(id, draftToInput(draft));
      await api.sendMailing(id);
      setSending(false);
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
    { label: ut("mail.send"), onSelect: () => setSending(true), disabled: busy || !!lock, hint: lock },
    { label: ut("mail.delete"), onSelect: remove, disabled: busy },
    { label: ut("common.save"), onSelect: save, disabled: busy || !!lock, hint: lock },
  ];

  return (
    <Page
      title={ut("top.messages")}
      titleHidden
      /*
       * tight: от нижнего края верхней панели до первого поля ровно 50 (f20:
       * полоса 0…94, верхняя рамка поля 145; f26: 0…95 и 146). Обычная шапка
       * добавляет строку и 28 снизу — форма уезжала на 55 ниже кадра. Распорки
       * у нового повідомлення больше нет и не нужно: при tight строка действий
       * высоты не занимает, и форма стоит одинаково на обоих маршрутах —
       * прыжка после «Створити» нет.
       */
      tight
      actions={
        id === null ? undefined : (
          <ActionMenu
            label={ut("mail.menu")}
            glyph={<IconGear />}
            entries={entries}
            /*
             * Шестерня отодвинута от края колонки на 20: её чернила на f26
             * идут 1355…1380 при правом крае колонки 1400, тогда как у
             * карточек людей (f47, f50) шестерня стоит вплотную (1368…1392 и
             * 1374…1398 при том же крае). Отступ местный, у общего каркаса
             * умолчание не меняется.
             */
            className="mr-[20px]"
            /*
             * Плашка меню на f26 — 209×95 (рамка #999999 идёт 1179…1387 ×
             * 139…233) против 142×94 на кадрах людей; пункты 17/400 против 15
             * (кап «В» у «Відправити» 150…161 при шаге пунктов 30). Оба числа
             * просит экран — умолчания ветки остаются людям.
             *
             * Наезд плашки на глиф (её верх 139 при нижнем крае шестерни 150)
             * не повторяется: это небрежность рисунка, а зазор 8 из каркаса
             * читается и не прячет знак, которым меню открыли.
             */
            plateClassName="min-w-[209px]"
            itemSize={17}
          />
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
            {/*
              ph="plain" — 17/400 серым: так подпись-плейсхолдер набрана на
              кадре ЭТОГО экрана. «Назва повідомлення» на f20 — чернила
              460…615 цветом (102,102,102), «Текст повідомлення» — 459…609 тем
              же цветом и весом. Общая константа задания («плейсхолдер 17/700»,
              фиолетовый полужирный, как на f02/f41/f19) здесь отступает перед
              кадром экрана, и отступление записано.
            */}
            <Field label={ut("mail.name")}>
              <Input
                ph="plain"
                value={draft.title}
                onChange={(e) => patch({ title: e.target.value })}
                maxLength={200}
                autoComplete="off"
              />
            </Field>
            {/* 195 — высота текстовой области на кадре (197→391); тянуть вниз можно, ужать ниже нельзя */}
            <Field label={ut("mail.body")}>
              <Textarea
                ph="plain"
                value={draft.body}
                onChange={(e) => patch({ body: e.target.value })}
                maxLength={4000}
                className="h-[195px] resize-y"
              />
            </Field>
            <div role="group" aria-labelledby={answerId} className={answerBox}>
              <p id={answerId} className={answerHeadingDraft}>
                {ut("mail.answer")}
              </p>
              {/*
                Варианты — контурные поля 139×36, как на f20. Имя каждому даёт
                aria-label с номером: подписи у них нет, а два безымянных поля
                подряд диктор различить не может. Ширина — обёрткой: у Input
                стоит w-full, и второй класс ширины с ним спорил бы порядком в
                собранном CSS.

                Два зазора, а не один, и это замер по рамкам: между вариантами
                17 (правая рамка первого на 608, левая второго на 626 — белого
                609…625), а до «+» 15 (второй вариант кончается рамкой на 764,
                чернила креста идут с 781, а у глифа 27 крест начинается на
                2,5 от края — значит квадрат стоит с 778). Один общий зазор
                пришлось бы выбрать неверным в одном из двух мест.

                Глиф остаётся 27, хотя на этом кадре его чернила 781…804 ×
                467…490, то есть 24: f11 рисует тот же знак у поля поиска
                размером 1043…1069 × 143…169 (27), и общая константа глифа —
                тоже 27. Один кадр против двух — небрежность рисунка.
              */}
              <div className="mt-[18px] flex items-start gap-[15px]">
                <div className="flex flex-wrap items-center gap-[17px]">
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
            {/*
              Поля «Група отримувачів» здесь нет: на f20 под рамкой «Відповідь»
              сразу кнопка. Выбор группы переехал в окно шага «Відправити» —
              см. <SendDialog> ниже и шапку файла.
            */}
            {id === null ? (
              /* 215×45 у правого края колонки, 46 от рамки — замер f20 */
              <div className="mt-[46px] flex justify-end">
                <Button type="submit" size="md" className="w-[215px]" disabled={busy || !filled}>
                  {ut("mail.create")}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </form>
      {sending ? (
        <SendDialog
          groups={groups.data ?? null}
          error={groups.error}
          onRetry={groups.reload}
          value={draft.patientGroupId}
          busy={busy}
          onPick={(patientGroupId) => patch({ patientGroupId })}
          onClose={() => setSending(false)}
          onSend={send}
        />
      ) : null}
    </Page>
  );
}

/**
 * Шаг «Відправити»: выбор группы адресатов и подтверждение.
 *
 * Поля адресатов на кадрах формы нет (ни на f20, ни на f26) — под рамкой
 * «Відповідь» сразу кнопка. Но сервер без адресатов отправлять отказывается
 * (err.mailingNoRecipients), и пункт меню без них был бы обещанием без
 * исполнения. Поэтому выбор переехал сюда: форма исполняет кадр буквально, а
 * возможность осталась на том же экране, за тем же действием.
 *
 * Окно же и подтверждает: прежний window.confirm задавал тот же вопрос, а
 * теперь рядом с вопросом стоит и ответ на «кому».
 */
function SendDialog({
  groups,
  error,
  onRetry,
  value,
  busy,
  onPick,
  onClose,
  onSend,
}: {
  groups: { id: string; title: string }[] | null;
  error: string | null;
  onRetry: () => void;
  value: string;
  busy: boolean;
  onPick: (id: string) => void;
  onClose: () => void;
  onSend: () => void;
}) {
  const { ut } = useLang();
  return (
    <Modal title={ut("mail.send")} onClose={onClose}>
      <p className="m-0 mb-[15px] text-[13px] leading-[19px] text-muted">{ut("mail.confirmSend")}</p>
      {/*
        Отказ списка групп не запирает окно молча: человек видит, почему
        выбирать не из чего, и может попробовать снова, не закрывая
        повідомлення.
      */}
      {error ? (
        <Loading error={error} onRetry={onRetry} />
      ) : (
        <Field inline label={ut("mail.recipients")}>
          <Select
            value={value}
            style={value ? undefined : PLACEHOLDER}
            onChange={(e) => onPick(e.target.value)}
          >
            <option value="">{ut("mail.recipients")}</option>
            {(groups ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.title}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="mt-[24px] flex justify-end gap-[12px]">
        <Button type="button" variant="ghost" onClick={onClose}>
          {ut("common.cancel")}
        </Button>
        {/* без группы сервер откажет словами — кнопка не притворяется, что отправит */}
        <Button type="button" disabled={busy || !value} onClick={onSend}>
          {ut("mail.send")}
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Отправленное — кадр f26 буквально: название в силуэте поля фиолетовым
 * полужирным, текст серым в рамке, варианты — залитые плашки 139×36 по
 * центру рамки «Відповідь» (653…791 и 809…947 при середине колонки 800).
 * Не поля, а показ (Readout): править нечего, и диктору незачем объявлять
 * «поле ввода, только чтение» трижды.
 *
 * Весь набор здесь 20-й, а не 17-й (см. пояснение к кеглю выше): это кадр
 * заполненного повідомлення, и он набран крупнее пустой формы.
 */
function SentView({ m, answerId }: { m: MailingCard; answerId: string }) {
  const { ut } = useLang();
  return (
    <>
      <Readout look="outline" size={20} className="font-bold text-primary">
        {m.title}
      </Readout>
      {/*
        Текст письма: 20/22 серым, первая строка в 22 от нутра верхней рамки.
        Замер f26: верхняя линия коробки на 197, кап первой строки 224…237,
        шаг строк 22 (223, 245, 267, 289, 311, 333, 355), низ коробки 391.
        Прежние py-[8px] ставили первую строку примерно на 213 — на десяток
        пикселей выше кадра. Левый отступ 12 с кадром сходится: чернила «Т»
        стоят на 459 при рамке на 450.

        Рамка — #666666, как у полей и у рамки «Відповідь» (на кадре
        (102,102,102) по всем четырём сторонам), а не тон линий-разделителей.
      */}
      <div className="mt-[15px] min-h-[195px] whitespace-pre-wrap break-words rounded-[5px] border border-field-border px-[12px] pb-[8px] pt-[22px] text-[20px] leading-[22px] text-muted">
        {m.body}
      </div>
      <div role="group" aria-labelledby={answerId} className={`mt-[15px] ${answerBox}`}>
        <p id={answerId} className={answerHeadingSent}>
          {ut("mail.answer")}
        </p>
        {m.options.length ? (
          /* зазор 17: заливка на f26 идёт 653…791 и 809…947, белого между ними 792…808 */
          <ul className="m-0 mt-[18px] flex list-none flex-wrap justify-center gap-[17px] p-0">
            {m.options.map((o, i) => (
              <Readout
                key={i}
                as="li"
                look="fill"
                size={20}
                className={`${optionWidth} justify-center font-bold text-primary`}
              >
                {o}
              </Readout>
            ))}
          </ul>
        ) : null}
      </div>
    </>
  );
}
