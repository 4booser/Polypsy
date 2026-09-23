
import type { UiKey } from "@quizzy/shared";
import { api, type ConclusionState } from "../api";
import { day } from "../format";
import { useAction } from "../ui";
import { useLang } from "../lang";
import { Button, Textarea } from "../ui/primitives";
import { TemplatePicker } from "./TemplatePicker";

/**
 * Заключение специалиста поверх автоматической интерпретации — блок
 * «Висновки заключення» экрана «Заключення» (кадры f38/f39).
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
 * Что на кадре f39_2 и как это здесь.
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
      {/* 18/700 фиолетовым — вторая ступень заголовков макета, как у панелей */}
      <h2 id="cn-verdicts" className="m-0 mb-[10px] text-[18px] font-bold leading-tight text-primary">
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
        Полоса форматирования кадра f39_2: сиреневая, 34 высотой, с белыми
        плашками. Набрана по замеру — ¶ · гарнитура · начертание · кегль ·
        образец цвета · «A» · B · I · U · четыре выравнивания — и выключена
        целиком: см. пояснение к компоненту. Каждая плашка подписана для
        диктора и несёт причину наведением; глифы кадра («B», «I», «U»,
        полоски выравнивания) нарисованы, а не набраны символами — в
        подключённых подмножествах шрифтов их нет.
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
        Внизу кадра f39_2 одна кнопка — «Сформувати заключення», 294×45 у
        правого края колонки, от поля до неё 64 px. Ширину задаёт текст, а не
        число: на русском надпись длиннее. «Зберегти чернетку» ушла в меню
        шестерёнки экрана, пояснение «у звіт іде лише підписане» — в подпись
        наведения этой кнопки.
      */}
      <div className="mt-[64px] flex justify-end">
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
 * Полоса форматирования кадра f39_2 — нарисованная и выключенная целиком.
 *
 * Почему выключенная, а не отсутствующая: кадр — истина, и полосы на экране
 * не может не быть. Почему не работающая: conclusions.text хранится простым
 * текстом (шифруется целиком, печатный отчёт экранирует его и печатает как
 * есть), формат разметки сервер не объявлял, и включённые кнопки писали бы в
 * подписанный клинический документ теги, которых никто не прочтёт.
 *
 * Плашки набраны по замеру кадра при колонке 1200: ¶ 27 · гарнитура 214 ·
 * начертание 201 · кегль 41 · образец цвета 41 · «A» 42 · B/I/U по 40 ·
 * четыре выравнивания по 35. Все — `disabled`, у каждой своё имя для диктора
 * и общая причина наведением.
 */
function FormatBar() {
  const { ut } = useLang();
  const why = ut("fmt.unavailable");
  /* плашка полосы: белая, радиус 4, высота 26 — замер кадра */
  const chip = (extra: string) =>
    "flex h-[26px] shrink-0 items-center justify-center rounded-[4px] border-0 bg-[var(--bg)] px-[6px] text-[13px] text-text-2 opacity-100 disabled:opacity-60 " +
    extra;
  const boxes: [UiKey, string, string][] = [
    ["fmt.paragraph", "¶", "w-[27px]"],
    ["fmt.font", "Ariel", "w-[214px]"],
    ["fmt.weight", "Regular", "w-[201px]"],
    ["fmt.size", "12", "w-[41px]"],
  ];
  const marks: [UiKey, string, string][] = [
    ["fmt.bold", "B", "font-bold"],
    ["fmt.italic", "I", "italic"],
    ["fmt.underline", "U", "underline"],
  ];
  const aligns: UiKey[] = ["fmt.alignLeft", "fmt.alignCenter", "fmt.alignRight", "fmt.alignJustify"];
  return (
    <div
      role="toolbar"
      aria-label={ut("cn3.verdicts")}
      aria-disabled
      className="flex min-h-[34px] flex-wrap items-center gap-[10px] rounded-t-[5px] bg-primary-soft px-[10px] py-[4px]"
    >
      {boxes.map(([key, glyph, w]) => (
        <button key={key} type="button" disabled title={why} aria-label={ut(key)} className={chip(w)}>
          {glyph}
        </button>
      ))}
      {/* образец цвета — не буква, а заливка: на кадре это прямоугольник */}
      <button type="button" disabled title={why} aria-label={ut("fmt.highlight")} className={chip("w-[41px]")}>
        <span aria-hidden className="block h-[14px] w-[24px] rounded-[3px] bg-primary-dim" />
      </button>
      <button type="button" disabled title={why} aria-label={ut("fmt.color")} className={chip("w-[42px] font-bold text-primary")}>
        A
      </button>
      {marks.map(([key, glyph, look]) => (
        <button key={key} type="button" disabled title={why} aria-label={ut(key)} className={chip(`w-[40px] ${look}`)}>
          {glyph}
        </button>
      ))}
      {aligns.map((key, i) => (
        <button key={key} type="button" disabled title={why} aria-label={ut(key)} className={chip("w-[35px]")}>
          <AlignGlyph at={i} />
        </button>
      ))}
    </div>
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
