
import { useId, type ReactNode } from "react";
import type { UiKey } from "@quizzy/shared";
import { api, type ConclusionState } from "../api";
import { cx } from "../ui/cx";
import { day } from "../format";
import { useAction } from "../ui";
import { useLang } from "../lang";
import { Button, Textarea } from "../ui/primitives";
import { TemplatePicker } from "./TemplatePicker";

/**
 * Заключение специалиста поверх автоматической интерпретации — блок
 * «Висновки заключення» экрана «Заключення» (кадры f36/f37).
 *
 * Черновик правится свободно; подпись фиксирует версию навсегда — дальше
 * только новая версия поверх. В печатный отчёт попадает только подписанное:
 * рабочий текст не должен утекать в документ, который подошьют в дело.
 *
 * Состояние заключения приходит снаружи, а не грузится здесь: экрану оно
 * нужно раньше редактора — название документа стоит в самом верху страницы,
 * а лежит в той же записи. Грузить одну запись дважды ради двух мест на
 * экране значило бы, что после сохранения два места расходятся.
 *
 * Что на кадре f37_2 и как это здесь.
 *
 * Над текстом стоит полоса форматирования: ¶, гарнитура, начертание, кегль,
 * образец цвета, «A», B / I / U и четыре выравнивания. Она нарисована ровно
 * так — и выключена целиком. conclusions.text хранится простым текстом: он
 * шифруется целиком, а печатный отчёт экранирует его и печатает как есть;
 * разметка в этом поле сломала бы обе дороги. Формат хранения объявляет
 * сервер, и до тех пор кнопки стоят на кадре, но не работают — это честнее,
 * чем полоса, которой на экране нет, и честнее, чем кнопки, которые молча
 * ничего не делают.
 *
 * НЕХВАТКА СЕРВЕРА (в отчёте сверки — строкой «сервер»): формат хранения
 * текста заключения не объявлен. Пока он не объявлен, полоса остаётся
 * нарисованной и выключенной; включать её раньше — значит писать в
 * подписанный клинический документ разметку, которую никто не прочтёт.
 *
 * Настоящие инструменты этого редактора — сборка черновика из фактов,
 * библиотека формулировок и история версий — ушли с полосы в меню шестерёнки
 * экрана (Conclusion.tsx, DocumentMenu): на кадре их там нет, а полоса занята
 * форматированием. Туда же ушла кнопка «Зберегти чернетку»: внизу кадра одна
 * кнопка — «Сформувати заключення». Черновик при этом никуда не делся —
 * стажёр готовит текст без права подписи, и без сохранения ему некуда деть
 * работу.
 *
 * Строка «у звіт іде лише підписане» под полем тоже убрана с глаз: на кадре
 * между полем и кнопкой пусто. Она стала подписью наведения самой кнопки —
 * там, где о ней и вспоминают.
 */
export function ConclusionEditor({
  responseId,
  state,
  error,
  onState,
  title,
  text,
  setText,
  areaRef,
  tool,
  setTool,
}: {
  responseId: string;
  state: ConclusionState | null;
  error: string | null;
  /** Сохранение и подпись возвращают новое состояние целиком — сюда */
  onState: (next: ConclusionState) => void;
  /** Название документа с поля вверху экрана: уходит на сервер вместе с текстом */
  title: string;
  /**
   * Текст черновика живёт на экране, а не здесь: его правят в этом поле, но
   * зовут из меню шестерёнки экрана (сборка из фактов, библиотека, черновик).
   * Держать его в двух местах значило бы расходиться после каждой вставки.
   */
  text: string;
  setText: (next: string) => void;
  areaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Что открыто из меню шестерёнки: библиотека формулировок или история версий */
  tool: null | "templates" | "history";
  setTool: (next: null | "templates" | "history") => void;
}) {
  const { ut } = useLang();
  const { run } = useAction();

  if (!state) {
    // отказ загрузки — не повод прятать редактор: заключение можно написать заново
    return error ? (
      <p className="text-muted">
        {ut("cn.loadFailed")}: {error}
      </p>
    ) : (
      <p className="text-muted">{ut("common.loading")}</p>
    );
  }

  const signed = state.versions.find((v) => v.status === "signed");
  const draft = state.current?.status === "draft" ? state.current : null;
  const save = () => api.saveConclusion(responseId, text, state.current?.version ?? 0, title);

  return (
    <section aria-labelledby="cn-verdicts" className="mt-[50px]">
      {/* 20/700 фиолетовым — ступень заголовков свитка: прописная «В» на кадре f36 — 14 px */}
      <h2 id="cn-verdicts" className="m-0 mb-[10px] text-[20px] font-bold leading-[24px] text-primary">
        {ut("cn3.verdicts")}
      </h2>

      {signed && !draft ? (
        <div className="mb-[14px] rounded-[5px] bg-primary-soft px-[14px] py-[10px]">
          <p className="m-0 whitespace-pre-wrap text-[15px] leading-[20px] text-text">{state.current!.text}</p>
          <p className="m-0 mt-[6px] text-[13px] text-muted">
            {ut("cnc.signedBy")} {state.current!.authorName}, {day(state.current!.signedAt!)} ·{" "}
            {ut("ds.version")} {state.current!.version}. {ut("cnc.editCreatesVersion")}
          </p>
        </div>
      ) : null}

      {/*
        Полоса форматирования кадра f37_2/f36_3: сиреневая, 40 высотой, с
        белыми плашками 30. Набрана по замеру — ¶ · гарнитура · начертание ·
        кегль · образец цвета · «A» · B · I · U · четыре выравнивания — и
        выключена целиком: см. пояснение к компоненту. Каждая плашка подписана
        для диктора; причину недоступности человек видит подсказкой над любой
        плашкой (подпись на обёртке, а не на выключенной кнопке), диктор —
        через aria-describedby панели. Глифы кадра («B», «I», «U», полоски
        выравнивания) нарисованы, а не набраны символами — в подключённых
        подмножествах шрифтов их нет.
      */}
      <FormatBar />
      {/*
        Имя поля — видимый заголовок блока, а не скрытая подпись: заголовок
        на экране уже есть, и второе имя тем же словом диктор прочёл бы дважды.
      */}
      <Textarea
        ref={areaRef}
        rows={7}
        aria-labelledby="cn-verdicts"
        className="rounded-t-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={signed ? ut("cn.newOverSigned") : ut("cn.placeholder")}
      />
      {tool === "templates" ? (
        <div className="mt-[10px]">
          <TemplatePicker kind="conclusion" value={text} onChange={setText} textareaRef={areaRef} />
        </div>
      ) : null}

      {tool === "history"
        ? state.versions.map((v) => (
            <div key={v.id} className="mt-[10px] rounded-[5px] bg-primary-soft px-[14px] py-[10px]">
              <p className="m-0 whitespace-pre-wrap text-[13px] leading-[18px] text-text">{v.text}</p>
              <p className="m-0 mt-[4px] text-[13px] text-muted">
                {ut("cnc.versionN")} {v.version} ·{" "}
                {v.status === "signed" ? `${ut("cnc.signedOn")} ${day(v.signedAt!)}` : ut("cnc.draftWord")} ·{" "}
                {v.authorName}
              </p>
            </div>
          ))
        : null}

      {/*
        Внизу кадра f36_3 одна кнопка — «Сформувати заключення», 294×45 у
        правого края колонки, от поля до неё 78 px. Ширину задаёт текст, а не
        число: на русском надпись длиннее. «Зберегти чернетку» ушла в меню
        шестерёнки экрана, пояснение «у звіт іде лише підписане» — в подпись
        наведения этой кнопки.

        78, а не 64: нижняя рамка поля текста на кадре стоит на 680, верх
        плашки кнопки — на 758 (вырезка хвоста экрана, 1500×320 от 10600).
      */}
      <div className="mt-[78px] flex justify-end">
        <Button
          size="md"
          title={ut("cnc.onlySignedInReport")}
          disabled={!draft && !text.trim()}
          onClick={() =>
            run(async () => {
              // подпись всегда фиксирует последний сохранённый текст
              let latest = state;
              if (text.trim() && text !== draft?.text) latest = await save();
              /*
               * Подписываем именно ту версию, которую вернуло сохранение.
               * Если между открытием экрана и подписью успел сохранить кто-то
               * другой, сервер откажет — лучше отказ, чем подпись под чужим
               * текстом.
               */
              onState(await api.signConclusion(responseId, latest.current!.version));
              setText("");
            }, ut("cn.signed"))
          }
        >
          {ut("cn3.form")}
        </Button>
      </div>
    </section>
  );
}

/**
 * Полоса форматирования кадра f37_2/f36_3 — нарисованная и выключенная целиком.
 *
 * Почему выключенная, а не отсутствующая: кадр — истина, и полосы на экране
 * не может не быть. Почему не работающая: conclusions.text хранится простым
 * текстом (шифруется целиком, печатный отчёт экранирует его и печатает как
 * есть), формат разметки сервер не объявлял, и включённые кнопки писали бы в
 * подписанный клинический документ теги, которых никто не прочтёт.
 *
 * Плашки пересобраны по вырезке кадра при колонке 1200 (полоса ровно 1200 в
 * ширину, поля по 16, высота 40, плашка 30): ¶ 30 · 61 · гарнитура 213 · 18 ·
 * начертание 195 · 15 · кегль 45 · 61 · образец цвета 45 · 15 · «A» 45 · 55 ·
 * B 45 · 2 · I 44 · 2 · U 45 · 50 · четыре выравнивания 45/44/44/43 через 2.
 * Числа в сумме с полями дают ровно 1200, и колонка страницы ровно 1200
 * (max-w-1248 минус поля 24) — поэтому ширины заданы пикселями, а не долями.
 * Прежняя редакция держала один зазор 10 на все плашки и размеры 27/214/201/
 * 41/41/42/40/35: полоса собиралась в ту же ширину, но ни одна группа не
 * стояла там, где нарисована.
 *
 * ПРИЧИНА НЕДОСТУПНОСТИ. Прежде она висела `title` на самой `disabled`-кнопке
 * — и не показывалась никогда: выключенной кнопке браузер не доставляет
 * события мыши, а всплывающую подпись рисует по ним. Теперь подпись стоит на
 * ОБЁРТКЕ плашки — обёртка не выключена, наведение до неё доходит, и причина
 * всплывает над любой плашкой полосы. Диктору та же причина дана иначе:
 * `aria-describedby` с панели на скрытый абзац под ней — `title` на
 * выключенной кнопке многие дикторы не читают вовсе.
 */
function FormatBar() {
  const { ut } = useLang();
  const why = ut("fmt.unavailable");
  const whyId = useId();
  /* плашка полосы: белая, радиус 4, высота 30 — замер кадра */
  const chip = (extra: string) =>
    "flex h-[30px] w-full items-center justify-center rounded-[4px] border-0 bg-[var(--bg)] px-[6px] text-[13px] text-text-2 opacity-100 disabled:opacity-60 " +
    extra;
  /*
   * [ключ, рисунок, класс места (левый отступ и ширина), класс начертания].
   * Отступ слева, а не общий `gap`: зазоры на кадре разные (61 между группами,
   * 2 внутри группы), и один `gap` их не выражает.
   */
  const plates: [UiKey, ReactNode, string, string][] = [
    ["fmt.paragraph", "¶", "w-[30px]", ""],
    ["fmt.font", "Ariel", "ml-[61px] w-[213px]", ""],
    ["fmt.weight", "Regular", "ml-[18px] w-[195px]", ""],
    ["fmt.size", "12", "ml-[15px] w-[45px]", ""],
    /* образец цвета — не буква, а заливка: на кадре это прямоугольник */
    [
      "fmt.highlight",
      <span aria-hidden className="block h-[14px] w-[24px] rounded-[3px] bg-primary-dim" />,
      "ml-[61px] w-[45px]",
      "",
    ],
    ["fmt.color", "A", "ml-[15px] w-[45px]", "font-bold text-primary"],
    ["fmt.bold", "B", "ml-[55px] w-[45px]", "font-bold"],
    ["fmt.italic", "I", "ml-[2px] w-[44px]", "italic"],
    ["fmt.underline", "U", "ml-[2px] w-[45px]", "underline"],
    ["fmt.alignLeft", <AlignGlyph at={0} />, "ml-[50px] w-[45px]", ""],
    ["fmt.alignCenter", <AlignGlyph at={1} />, "ml-[2px] w-[44px]", ""],
    ["fmt.alignRight", <AlignGlyph at={2} />, "ml-[2px] w-[44px]", ""],
    ["fmt.alignJustify", <AlignGlyph at={3} />, "ml-[2px] w-[43px]", ""],
  ];
  return (
    <>
      <div
        role="toolbar"
        aria-label={ut("cn3.verdicts")}
        aria-disabled
        aria-describedby={whyId}
        className="flex min-h-[40px] flex-wrap items-center gap-y-[5px] rounded-t-[5px] bg-primary-soft px-[16px] py-[5px]"
      >
        {plates.map(([key, glyph, box, look]) => (
          <span key={key} title={why} className={cx("flex shrink-0", box)}>
            <button type="button" disabled aria-label={ut(key)} className={chip(look)}>
              {glyph}
            </button>
          </span>
        ))}
      </div>
      {/* причина — словами, а не только подсказкой наведения: см. пояснение выше */}
      <p id={whyId} className="sr-only">
        {why}
      </p>
    </>
  );
}

/** Четыре полоски выравнивания: последняя строка короче у всех, кроме «по ширине» */
function AlignGlyph({ at }: { at: number }) {
  const widths = [
    [14, 10, 14, 8],
    [14, 10, 14, 10],
    [14, 10, 14, 8],
    [14, 14, 14, 14],
  ][at]!;
  const shift = (w: number) => (at === 1 ? (14 - w) / 2 : at === 2 ? 14 - w : 0);
  return (
    <svg viewBox="0 0 14 12" aria-hidden focusable="false" className="size-[14px]" fill="currentColor">
      {widths.map((w, i) => (
        <rect key={i} x={shift(w)} y={i * 3} width={w} height={1.5} rx={0.7} />
      ))}
    </svg>
  );
}

/**
 * Собрать черновик из фактов.
 *
 * Фразу собирает клиент, а не сервер: у сервера нет языка интерфейса, и
 * собранный там текст пришлось бы переводить вторым словарём. Здесь тот же
 * механизм, которым переведено всё остальное.
 *
 * Подставляется только то, что система знает наверняка: кто, сколько лет,
 * какие баллы, что говорят полосы норм, как изменилось с прошлого раза.
 * Вывод не подставляется вовсе — его пишет человек, и место под него
 * оставлено пустым намеренно: заготовка вывода читалась бы как вывод.
 */
export async function buildDraft(responseId: string, ut: (k: never) => string): Promise<string> {
  const t = (k: string) => ut(k as never);
  const d = await api.conclusionDraft(responseId);
  const lines: string[] = [];

  if (d.patient) {
    const age = d.patient.age !== null ? `, ${d.patient.age} ${t("cn.draftAge")}` : "";
    const unit = d.patient.unit ? `, ${d.patient.unit}` : "";
    lines.push(`${t("cn.draftHeader")}: ${d.patient.fullName}${age}${unit}`);
  }
  lines.push(`${t("cn.draftMethod")}: ${d.surveyTitle}`);
  if (d.submittedAt) lines.push(`${t("cn.draftDate")}: ${day(d.submittedAt)}`);

  if (d.scales.length) {
    lines.push("", `${t("cn.draftScales")}:`);
    for (const s of d.scales) {
      /*
       * Значение печатается в том виде, в каком шкала нормирована: доля в
       * процентах, T-балл и стен — числом. Приводить всё к процентам значило
       * бы напечатать «T-балл 65 %» — правдоподобно и неверно.
       */
      const shown =
        s.normalization === "ratio"
          ? `${Math.round(s.percent)} %`
          : String(Math.round(s.value * 10) / 10);
      const band = s.band ? ` — ${s.band}` : "";
      const before =
        s.previousValue !== null
          ? ` (${t("cn.draftWas")} ${
              s.normalization === "ratio"
                ? `${Math.round(s.previousValue * 100)} %`
                : Math.round(s.previousValue * 10) / 10
            }${d.previousAt ? `, ${day(d.previousAt)}` : ""})`
          : "";
      lines.push(`· ${s.title}: ${shown}${band}${before}`);
    }
  }

  lines.push("", t("cn.draftConclusionHere"));
  return lines.join("\n");
}
