import { useEffect, useRef, useState } from "react";
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
 * Что на макете и как это здесь.
 *
 * На макете над текстом стоит панель форматирования (Ariel, Regular, 12, B,
 * I, U, выравнивание). Её нет намеренно: conclusions.text — простой текст,
 * он шифруется целиком, а печатный отчёт экранирует его и печатает как есть.
 * Разметка в этом поле сломала бы печать и подписанные записи в бою. На месте
 * панели стоят настоящие инструменты этого редактора — сборка черновика из
 * фактов, библиотека формулировок и история версий. Полоса форматирования
 * вернётся сюда в тот день, когда сервер объявит формат хранения.
 *
 * На макете одна кнопка — «Сформувати заключення». Здесь она подписывает:
 * сформированное заключение — то, что идёт в отчёт и в подшивку, а туда идёт
 * только подписанное. Рядом остаётся «Зберегти чернетку» призрачной: стажёр
 * готовит текст без права подписи, и без черновика ему некуда сохранять
 * работу. Свести обе к одной значило бы либо отобрать у стажёра сохранение,
 * либо пускать в отчёт неподписанное.
 */
export function ConclusionEditor({
  responseId,
  state,
  error,
  onState,
  title,
}: {
  responseId: string;
  state: ConclusionState | null;
  error: string | null;
  /** Сохранение и подпись возвращают новое состояние целиком — сюда */
  onState: (next: ConclusionState) => void;
  /** Название документа с поля вверху экрана: уходит на сервер вместе с текстом */
  title: string;
}) {
  const { ut } = useLang();
  const [text, setText] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const { run } = useAction();

  /*
   * Черновик подставляется в поле один раз на загрузку. Делать это на каждый
   * рендер значило бы затирать то, что специалист печатает прямо сейчас.
   */
  useEffect(() => {
    const current = state?.current;
    setText(current?.status === "draft" ? current.text : "");
  }, [state]);

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
        Полоса инструментов над текстом: сиреневая, с белыми плашками — как
        полоса форматирования на макете, только с инструментами, которые у
        этого редактора есть на самом деле (см. пояснение к компоненту).
        Скругление только сверху: снизу к ней вплотную стоит поле текста.
      */}
      <div className="flex min-h-9 flex-wrap items-center gap-[10px] rounded-t-[5px] bg-primary-soft px-[10px] py-[4px]">
        {/*
          Черновик собирается по нажатию и не сохраняется сам.
          Сохранённый автоматически, он стал бы клиническим документом,
          которого никто не писал: лежал бы в карте, выглядел бы как работа
          специалиста и попал бы в историю версий раньше, чем его прочитали.
        */}
        <Button
          variant="paper"
          onClick={() =>
            run(async () => {
              if (text.trim() && !window.confirm(ut("cn.draftReplaced"))) return false;
              setText(await buildDraft(responseId, ut));
            })
          }
        >
          {ut("cn.fromResults")}
        </Button>
        <TemplatePicker kind="conclusion" value={text} onChange={setText} textareaRef={areaRef} variant="paper" />
        {state.versions.length > 1 ? (
          <Button variant="paper" onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? ut("cn.hideHistory") : `${ut("cnc.showHistory")} (${state.versions.length})`}
          </Button>
        ) : null}
      </div>
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
      <p className="m-0 mt-[6px] text-[13px] text-muted">{ut("cnc.onlySignedInReport")}</p>

      {showHistory
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
        Кнопка формы прижата вправо, как на макете (293×45 у правого края
        колонки). Ширину задаёт текст, а не число: на русском надпись длиннее.
      */}
      <div className="mt-[40px] flex flex-wrap items-center justify-end gap-[14px]">
        <Button
          variant="ghost"
          size="md"
          disabled={!text.trim()}
          onClick={() =>
            run(async () => {
              onState(await save());
            }, ut("cn.draftSaved"))
          }
        >
          {ut("cnc.saveDraft")}
        </Button>
        <Button
          size="md"
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
async function buildDraft(responseId: string, ut: (k: never) => string): Promise<string> {
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
