import { useEffect, useState } from "react";
import type { SurveyAnalytics } from "@quizzy/shared";
import { api, download, type VersionDiffResult } from "../../../api";
import { useLang } from "../../../lang";
import { Modal, useAction } from "../../../ui";
import { cx } from "../../../ui/cx";
import { IconGear } from "../../../ui/glyphs";
import { ActionMenu, type MenuEntry } from "../../../ui/menu";
import { Button, Field, Input, Select } from "../../../ui/primitives";
import { fill } from "./model";

/*
 * «Дії та вивантаження» — все двери прежней страницы аналитики методики
 * (/surveys/:id) в меню шестерёнки у заголовка.
 *
 * Прежде они стояли на экране рядами кнопок: девять выгрузок в панели
 * «Загальне» и ещё четыре ссылки под ней. Экран аналитики — про картину,
 * а не про действия с методикой, и тринадцать кнопок над графиками
 * отбирали у картины первый экран. Шестерёнка у заголовка — то место, где
 * консоль держит действия с объектом экрана (карточки людей, заключение,
 * модель): её там ищут.
 *
 * Ничего не потеряно: нормы, назначения, «заповнити за пацієнта»,
 * конструктор, бланк, ключ — переходы; выгрузки и сравнение версий —
 * окна, потому что просят выбора (профиль, цель, пара версий) до действия.
 */

export function SurveyActions({ data }: { data: SurveyAnalytics }) {
  const { ut } = useLang();
  const [dialog, setDialog] = useState<"exports" | "versions" | null>(null);
  const id = data.surveyId;

  const entries: MenuEntry[] = [
    { label: ut("ant.exportsItem"), onSelect: () => setDialog("exports") },
    ...(data.versions.length > 1 ? [{ label: ut("an.compareVersions"), onSelect: () => setDialog("versions") }] : []),
    { label: ut("an.localNorms"), to: `/surveys/${id}/norms` },
    { label: ut("an.assignments"), to: `/surveys/${id}/access` },
    { label: ut("an.administer"), to: `/surveys/${id}/administer` },
    { label: ut("an.edit"), to: `/constructor/${id}` },
    { label: ut("an.blank"), to: `/surveys/${id}/blank` },
    { label: ut("an.keys"), to: `/surveys/${id}/key` },
  ];

  return (
    <>
      {/* плашка шире кадровых 142: подписи пунктов здесь длиннее, чем у карточек людей */}
      <ActionMenu label={ut("ant.actions")} glyph={<IconGear />} entries={entries} plateClassName="min-w-[260px]" />
      {dialog === "exports" ? (
        <Modal title={ut("ant.exportsTitle")} onClose={() => setDialog(null)}>
          <Exports surveyId={id} />
        </Modal>
      ) : null}
      {dialog === "versions" ? (
        <Modal title={ut("ant.versionsTitle")} onClose={() => setDialog(null)} wide>
          <VersionDiff surveyId={id} versions={data.versions} />
        </Modal>
      ) : null}
    </>
  );
}

type Profile = "full" | "deidentified" | "anonymous";

/**
 * Выгрузки: цель, профиль знеособлення и файлы.
 *
 * Цель выгрузки — не формальность: «кто и когда» без «зачем» не отвечает ни
 * на один вопрос разбора через год. Манифест и скрипты загрузки — рядом с
 * данными, а не в документации: воспроизводимость обеспечивают тем, что
 * забирают вместе с файлом, а не тем, о чём вспоминают потом.
 */
function Exports({ surveyId }: { surveyId: string }) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [profile, setProfile] = useState<Profile>("full");
  const [purpose, setPurpose] = useState("");

  const files: { label: string; hint?: string; go: () => Promise<unknown>; done: string }[] = [
    { label: ut("an.dataCsv"), go: () => download(api.exportUrl(surveyId), "data.csv"), done: ut("an.fileExported") },
    { label: ut("an.spssMatrix"), go: () => download(api.spssDataUrl(surveyId, profile), "spss-data.csv"), done: ut("an.matrixExported") },
    { label: ut("an.spssSyntax"), go: () => download(api.spssSyntaxUrl(surveyId, profile), "syntax.sps"), done: ut("an.syntaxExported") },
    {
      label: ut("an.codebook"),
      hint: ut("an.codebookHint"),
      go: () => download(api.codebookUrl(surveyId, profile), "codebook.csv"),
      done: ut("an.codebookExported"),
    },
    {
      label: ut("an.long"),
      hint: ut("an.longHint"),
      go: () => download(api.longUrl(surveyId, profile), "long.csv"),
      done: ut("an.longExported"),
    },
    {
      label: ut("rep.manifest"),
      hint: ut("rep.manifestHint"),
      go: () => download(api.manifestUrl(surveyId, profile, purpose), "manifest.json"),
      done: ut("rep.manifestDone"),
    },
    { label: ut("ant.scriptR"), go: () => download(api.loadScriptUrl(surveyId, "r", profile), "load.r"), done: ut("rep.scriptDone") },
    { label: ut("ant.scriptPy"), go: () => download(api.loadScriptUrl(surveyId, "py", profile), "load.py"), done: ut("rep.scriptDone") },
  ];

  return (
    <div className="flex max-w-[640px] flex-col gap-[14px]">
      <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("an.exportsHint")}</p>
      <div className="grid grid-cols-2 gap-x-[15px] max-[600px]:grid-cols-1">
        <Field label={ut("rep.purpose")}>
          <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder={ut("rep.purposePlaceholder")} maxLength={200} />
        </Field>
        <Field label={ut("an.profile")}>
          <Select value={profile} onChange={(e) => setProfile(e.target.value as Profile)}>
            <option value="full">{ut("an.exportFull")}</option>
            <option value="deidentified">{ut("an.exportDeid")}</option>
            <option value="anonymous">{ut("an.exportAnon")}</option>
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap gap-[8px]">
        {files.map((f) => (
          <Button key={f.label} variant="ghost" disabled={busy} title={f.hint} onClick={() => run(f.go, f.done)}>
            {f.label}
          </Button>
        ))}
      </div>
      <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("an.exportsNote")}</p>
    </div>
  );
}

/**
 * Что изменилось между двумя версиями.
 *
 * Главный ответ здесь один: сопоставимы ли баллы. Перечень правок — лишь
 * обоснование этого ответа, поэтому вывод стоит первым и крупно, а список
 * изменений — под ним и мелко. Перенесено с прежней страницы аналитики
 * методики вместе с доводом; поменялся только вид.
 */
function VersionDiff({ surveyId, versions }: { surveyId: string; versions: { id: string; version: number }[] }) {
  const { ut } = useLang();
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const [a, setA] = useState(sorted[sorted.length - 2]?.id ?? sorted[0]!.id);
  const [b, setB] = useState(sorted[sorted.length - 1]!.id);
  const [diff, setDiff] = useState<VersionDiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (a === b) return;
    let live = true;
    setDiff(null);
    setError(null);
    api
      .versionDiff(surveyId, a, b)
      .then((d) => live && setDiff(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [surveyId, a, b]);

  const pick = (label: string, value: string, onChange: (v: string) => void) => (
    /* подпись видима: у выбора версии нет плейсхолдера, и два одинаковых поля без неё не различить */
    <Field label={label} inline className="w-[160px]" labelClassName="mb-[4px] block text-[13px] font-bold text-muted">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {sorted.map((v) => (
          <option key={v.id} value={v.id}>
            {fill(ut("ant.versionN"), { n: v.version })}
          </option>
        ))}
      </Select>
    </Field>
  );

  const KIND = { added: "an.added", removed: "an.removed", changed: "an.changed" } as const;
  const change = (ch: VersionDiffResult["questions"][number]["changes"][number]) => (
    <div key={ch.field} className="grid grid-cols-[140px_minmax(0,1fr)_16px_minmax(0,1fr)] gap-x-[8px] text-[13px] leading-[18px]">
      <span className={cx("truncate font-mono", ch.scoring ? "font-bold text-text" : "text-muted")}>{ch.field}</span>
      <span className="text-muted line-through">{ch.before ?? "—"}</span>
      <span aria-hidden className="text-muted">→</span>
      <span className="text-text">{ch.after ?? "—"}</span>
    </div>
  );

  return (
    <div className="flex max-w-[760px] flex-col gap-[14px]">
      <p className="m-0 text-[13px] leading-[18px] text-muted">{ut("an.versionHint")}</p>
      <div className="flex items-end gap-[12px]">
        {pick(ut("ant.versionFrom"), a, setA)}
        <span aria-hidden className="pb-[8px] text-muted">→</span>
        {pick(ut("ant.versionTo"), b, setB)}
      </div>
      {error ? <p className="m-0 text-[13px] text-danger">{error}</p> : null}
      {a === b ? <p className="m-0 text-[13px] text-muted">{ut("an.pickDifferent")}</p> : null}
      {diff ? (
        <>
          <p className="m-0 text-[17px] font-bold">
            {/* вывод — словом и цветом тона шкалы тяжести, но не одним цветом: слово сказано полностью */}
            {diff.comparable ? (
              <span className="text-[var(--sev-none-text)]">{ut("an.comparable")}</span>
            ) : (
              <span className="text-[var(--sev-moderate-text)]">{ut("an.notComparable")}</span>
            )}
          </p>
          <p className="m-0 text-[13px] leading-[18px] text-muted">
            {diff.reasons.length ? diff.reasons.join(" · ") : ut("an.noScoringChange")}
          </p>
          {diff.scales.map((sc) => (
            <div key={sc.code} className="border-t border-hairline pt-[8px]">
              <p className="m-0 mb-[4px] text-[15px] font-bold text-primary">
                {ut("an.scaleWord")} {sc.code} <span className="font-normal text-muted">{ut(KIND[sc.kind])}</span>
              </p>
              {sc.changes.map(change)}
            </div>
          ))}
          {diff.questions.map((q, i) => (
            <div key={`${q.position}-${i}`} className="border-t border-hairline pt-[8px]">
              <p className="m-0 text-[15px] font-bold text-primary">
                {ut("an.item")} {q.position} <span className="font-normal text-muted">{ut(KIND[q.kind])}</span>
              </p>
              <p className="m-0 mb-[4px] text-[13px] text-muted">{q.title}</p>
              {q.changes.map(change)}
            </div>
          ))}
          {!diff.scales.length && !diff.questions.length ? (
            <p className="m-0 text-[13px] text-muted">{ut("an.sameContent")}</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
