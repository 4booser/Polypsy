import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { day } from "../format";
import { useAction } from "../ui";
import { useResource } from "../useResource";
import { useLang } from "../lang";
import { Button, Textarea } from "../ui/primitives";
import { TemplatePicker } from "./TemplatePicker";

/**
 * Заключение специалиста поверх автоматической интерпретации.
 *
 * Черновик правится свободно; подпись фиксирует версию навсегда — дальше
 * только новая версия поверх. В печатный отчёт попадает только подписанное:
 * рабочий текст не должен утекать в документ, который подошьют в дело.
 */
export function ConclusionEditor({ responseId }: { responseId: string }) {
  const { ut } = useLang();
  const [text, setText] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const { run } = useAction();

  const res = useResource(() => api.conclusion(responseId), [responseId]);
  // сохранение и подпись возвращают новое состояние целиком — кладём его в
  // ресурс, а не рядом: отдельная копия пережила бы смену прохождения
  const state = res.data;

  /*
   * Черновик подставляется в поле один раз на загрузку. Делать это на каждый
   * рендер значило бы затирать то, что специалист печатает прямо сейчас.
   */
  useEffect(() => {
    const current = res.data?.current;
    setText(current?.status === "draft" ? current.text : "");
  }, [res.data]);

  if (!state) {
    // отказ загрузки — не повод прятать редактор: заключение можно написать заново
    return res.error ? (
      <p className="text-muted">
        {ut("cn.loadFailed")}: {res.error}
      </p>
    ) : (
      <p className="text-muted">{ut("common.loading")}</p>
    );
  }

  const signed = state.versions.find((v) => v.status === "signed");
  const draft = state.current?.status === "draft" ? state.current : null;

  return (
    <div className="nested">
      <h3>{ut("cn.title")}</h3>

      {signed && !draft ? (
        <div className="conclusion-view">
          <p className="m-0 whitespace-pre-wrap">{state.current!.text}</p>
          <p className="text-caption text-muted">
            {ut("cnc.signedBy")} {state.current!.authorName}, {day(state.current!.signedAt!)} ·{" "}
            {ut("ds.version")} {state.current!.version}. {ut("cnc.editCreatesVersion")}
          </p>
        </div>
      ) : null}

      <Textarea
        ref={areaRef}
        rows={5}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          signed
            ? ut("cn.newOverSigned")
            : ut("cn.placeholder")
        }
      />
      <div className="row mt-2">
        {/*
          Черновик собирается по нажатию и не сохраняется сам.
          Сохранённый автоматически, он стал бы клиническим документом,
          которого никто не писал: лежал бы в карте, выглядел бы как работа
          специалиста и попал бы в историю версий раньше, чем его прочитали.
        */}
        <Button
          onClick={() =>
            run(async () => {
              if (text.trim() && !window.confirm(ut("cn.draftReplaced"))) return false;
              setText(await buildDraft(responseId, ut));
            })
          }
        >
          {ut("cn.fromResults")}
        </Button>
        <TemplatePicker kind="conclusion" value={text} onChange={setText} textareaRef={areaRef} />
        <Button
          disabled={!text.trim()}
          onClick={() =>
            run(async () => {
              res.patch(await api.saveConclusion(responseId, text, state.current?.version ?? 0));
            }, ut("cn.draftSaved"))
          }
        >
          {ut("cnc.saveDraft")}
        </Button>
        <Button
          variant="primary"
          disabled={!draft && !text.trim()}
          onClick={() =>
            run(async () => {
              // подпись всегда фиксирует последний сохранённый текст
              let latest = state;
              if (text.trim() && text !== draft?.text) {
                latest = await api.saveConclusion(responseId, text, state.current?.version ?? 0);
              }
              /*
               * Подписываем именно ту версию, которую вернуло сохранение.
               * Если между открытием экрана и подписью успел сохранить кто-то
               * другой, сервер откажет — лучше отказ, чем подпись под чужим
               * текстом.
               */
              const s = await api.signConclusion(responseId, latest.current!.version);
              res.patch(s);
              setText("");
            }, ut("cn.signed"))
          }
        >
          {ut("cnc.sign")}
        </Button>
        {state.versions.length > 1 ? (
          <Button onClick={() => setShowHistory((v) => !v)}>
            {showHistory ? ut("cn.hideHistory") : `${ut("cnc.showHistory")} (${state.versions.length})`}
          </Button>
        ) : null}
      </div>
      <p className="text-caption text-muted">{ut("cnc.onlySignedInReport")}</p>

      {showHistory
        ? state.versions.map((v) => (
            <div key={v.id} className="conclusion-view mt-2">
              <p className="m-0 whitespace-pre-wrap text-small">{v.text}</p>
              <p className="text-caption text-muted">
                {ut("cnc.versionN")} {v.version} ·{" "}
                {v.status === "signed" ? `${ut("cnc.signedOn")} ${day(v.signedAt!)}` : ut("cnc.draftWord")} ·{" "}
                {v.authorName}
              </p>
            </div>
          ))
        : null}
    </div>
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
