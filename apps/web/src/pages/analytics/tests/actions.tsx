import { useState, type ReactNode } from "react";
import type { SurveyAnalytics } from "@quizzy/shared";
import { api, download, type VersionDiffResult } from "../../../api";
import { useAuth } from "../../../auth";
import { useLang } from "../../../lang";
import { useShellNav } from "../../../shell/useShellNav";
import { Callout, Modal, useAction, useHotkeys } from "../../../ui";
import { cx } from "../../../ui/cx";
import { Ic } from "../../../ui/icons";
import { IconTile } from "../../../ui/layout";
import { ActionMenu, type MenuEntry } from "../../../ui/menu";
import { Button, ChoiceCard, Field, Input, Select, Tag } from "../../../ui/primitives";
import { useResource } from "../../../useResource";
import { AIc } from "../icons";
import { dayText, exportCount, fill, kyivDay } from "./model";
import { nf } from "./views";

/*
 * Действия с методикой у заголовка «Аналітики тестів».
 *
 * «Вивантаження» — отдельной кнопкой (и клавишей E): за ней окно с целью,
 * профилем и восемью файлами. Окно — не ящик: выгрузка увозит персональные
 * данные за пределы системы, и шаг обязан прервать работу, а не стоять
 * сбоку. Остальные двери прежней страницы методики — нормы, назначения,
 * «заповнити за пацієнта», конструктор, бланк, ключ, сравнение версий — в
 * «⋯» рядом.
 */

export function SurveyActions({ data }: { data: SurveyAnalytics }) {
  const { ut } = useLang();
  const [dialog, setDialog] = useState<"exports" | "versions" | null>(null);
  const id = data.surveyId;

  useHotkeys({ e: () => setDialog("exports") }, dialog === null);

  const entries: MenuEntry[] = [
    { label: ut("ant.exportsItem"), onSelect: () => setDialog("exports"), icon: <Ic.download size={15} />, kbd: "E" },
    ...(data.versions.length > 1
      ? [{ label: ut("an.compareVersions"), onSelect: () => setDialog("versions"), icon: <AIc.gitCompare size={15} /> }]
      : []),
    { label: ut("an.localNorms"), to: `/surveys/${id}/norms`, icon: <AIc.ruler size={15} />, ruled: true },
    { label: ut("an.assignments"), to: `/surveys/${id}/access`, icon: <AIc.usersRound size={15} /> },
    { label: ut("an.administer"), to: `/surveys/${id}/administer`, icon: <AIc.filePen size={15} /> },
    { label: ut("an.edit"), to: `/constructor/${id}`, icon: <Ic.pen size={15} /> },
    { label: ut("an.blank"), to: `/surveys/${id}/blank`, icon: <AIc.printer size={15} /> },
    { label: ut("an.keys"), to: `/surveys/${id}/key`, icon: <AIc.keyRound size={15} /> },
  ];

  return (
    <>
      <Button icon={<Ic.download />} onClick={() => setDialog("exports")} aria-expanded={dialog === "exports"} title={ut("ant.exportsTitle")}>
        {ut("ant.exportsTitle")}
      </Button>
      <ActionMenu label={ut("ant.actions")} entries={entries} plateClassName="min-w-[270px]" triggerSize="icon" />
      {dialog === "exports" ? <Exports data={data} onClose={() => setDialog(null)} /> : null}
      {dialog === "versions" ? (
        <Modal title={ut("ant.versionsTitle")} onClose={() => setDialog(null)} wide icon={<AIc.gitCompare />}>
          <VersionDiff surveyId={id} versions={data.versions} />
        </Modal>
      ) : null}
    </>
  );
}

type Profile = "full" | "deidentified" | "anonymous";

/** Цель выгрузки — в адрес файла: сервер пишет её в журнал доступа рядом с составом выгрузки */
function withPurpose(url: string, purpose: string): string {
  const p = purpose.trim();
  return p ? `${url}${url.includes("?") ? "&" : "?"}purpose=${encodeURIComponent(p)}` : url;
}

/** Кнопка файла (.fbtn): значок, имя и файл, одна строка пояснения, стрелка загрузки */
function FileButton({
  icon,
  tone = "neutral",
  title,
  file,
  note,
  warn,
  disabled,
  hint,
  onClick,
}: {
  icon: ReactNode;
  tone?: "neutral" | "violet" | "warn";
  title: string;
  file: string;
  note: string;
  warn?: boolean;
  disabled?: boolean;
  hint?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={hint}
      onClick={onClick}
      className={cx(
        "grid min-h-0 cursor-pointer grid-cols-[32px_minmax(0,1fr)_20px] items-start gap-2.5 whitespace-normal rounded-[12px] border-0 bg-panel px-3 py-2.5 text-left",
        "shadow-[inset_0_0_0_1px_var(--border)] transition-[background-color,box-shadow] duration-[var(--dur-fast)]",
        "hover:bg-panel-2 hover:shadow-[inset_0_0_0_1px_var(--ctl)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        "disabled:cursor-not-allowed disabled:opacity-48",
      )}
    >
      <IconTile icon={icon} tone={tone} />
      <span className="min-w-0">
        <b className="text-[13px] font-extrabold leading-[18px] text-text">{title}</b>
        <code className="ml-1.5 font-mono text-[11.5px] font-semibold text-muted">{file}</code>
        <small className={cx("mt-0.5 block text-caption leading-4", warn ? "text-warn" : "text-muted")}>{note}</small>
      </span>
      <Ic.download size={16} className="mt-2 text-muted" />
    </button>
  );
}

/**
 * Выгрузки: цель, профиль знеособлення и файлы.
 *
 * Цель выгрузки — не формальность: «кто и когда» без «зачем» не отвечает ни
 * на один вопрос разбора через год. Она уходит в адрес каждого файла и
 * ложится в журнал доступа рядом с составом выгрузки, а в манифесте — ещё
 * и в сам файл. Манифест и скрипты загрузки — рядом с данными, а не в
 * документации: воспроизводимость обеспечивают тем, что забирают вместе с
 * файлом.
 */
function Exports({ data, onClose }: { data: SurveyAnalytics; onClose: () => void }) {
  const { ut } = useLang();
  const { user } = useAuth();
  const nav = useShellNav();
  const { run, busy } = useAction();
  /* поимённая выгрузка и профиль «повний» — право export.full; без него сервер откажет */
  const full = nav ? nav.access.can("export.full") : true;
  /*
   * Обезличенная — по умолчанию, как и на сервере (exportQuery): с фамилиями
   * файл уезжает только по выбору «повний», сделанному руками.
   */
  const [profile, setProfile] = useState<Profile>("deidentified");
  const [purpose, setPurpose] = useState("");
  const sid = data.surveyId;
  const go = (url: string, name: string, done: string) => () => void run(() => download(withPurpose(url, purpose), name), done);

  const files: { key: string; icon: ReactNode; tone?: "neutral" | "violet" | "warn"; title: string; file: string; note: string; warn?: boolean; disabled?: boolean; onClick: () => void }[] = [
    {
      key: "csv",
      icon: <AIc.sheet />,
      tone: "warn",
      title: ut("an.dataCsv"),
      file: "data.csv",
      note: ut("ant.fileCsvNote"),
      warn: true,
      disabled: !full,
      onClick: go(api.exportUrl(sid), "data.csv", ut("an.fileExported")),
    },
    { key: "spss", icon: <AIc.table2 />, title: ut("an.spssMatrix"), file: "spss-data.csv", note: ut("ant.fileSpssNote"), onClick: go(api.spssDataUrl(sid, profile), "spss-data.csv", ut("an.matrixExported")) },
    { key: "sps", icon: <AIc.fileCode />, title: ut("an.spssSyntax"), file: "syntax.sps", note: ut("ant.fileSyntaxNote"), onClick: go(api.spssSyntaxUrl(sid, profile), "syntax.sps", ut("an.syntaxExported")) },
    { key: "codebook", icon: <AIc.bookOpen />, title: ut("an.codebook"), file: "codebook.csv", note: ut("an.codebookHint"), onClick: go(api.codebookUrl(sid, profile), "codebook.csv", ut("an.codebookExported")) },
    { key: "long", icon: <AIc.rows />, title: ut("an.long"), file: "long.csv", note: ut("an.longHint"), onClick: go(api.longUrl(sid, profile), "long.csv", ut("an.longExported")) },
    {
      key: "manifest",
      icon: <AIc.fileJson />,
      tone: "violet",
      title: ut("rep.manifest"),
      file: "manifest.json",
      note: ut("rep.manifestHint"),
      /* у манифеста цель — свой параметр адреса, его же сервер кладёт и в файл */
      onClick: () => void run(() => download(api.manifestUrl(sid, profile, purpose), "manifest.json"), ut("rep.manifestDone")),
    },
    { key: "r", icon: <AIc.fileCode />, title: ut("ant.scriptR"), file: "load.r", note: ut("ant.fileRNote"), onClick: go(api.loadScriptUrl(sid, "r", profile), "load.r", ut("rep.scriptDone")) },
    { key: "py", icon: <AIc.fileCode />, title: ut("ant.scriptPy"), file: "load.py", note: ut("ant.filePyNote"), onClick: go(api.loadScriptUrl(sid, "py", profile), "load.py", ut("rep.scriptDone")) },
  ];

  const profiles: { key: Profile; title: string; sub: string }[] = [
    { key: "full", title: ut("an.exportFull"), sub: ut("ant.profFullSub") },
    { key: "deidentified", title: ut("an.exportDeid"), sub: ut("ant.profDeidSub") },
    { key: "anonymous", title: ut("an.exportAnon"), sub: ut("ant.profAnonSub") },
  ];

  return (
    <Modal
      title={ut("ant.exportsTitle")}
      sub={ut("an.exportsHint")}
      icon={<Ic.download />}
      width={780}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{ut("common.close")}</Button>
          {user ? (
            <span className="ml-auto text-small text-muted">
              {ut("ant.exportBy").replace("{name}", user.fullName).replace("{date}", dayText(kyivDay()))}
            </span>
          ) : null}
        </>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 max-[640px]:grid-cols-1">
        <Field label={ut("rep.purpose")} hint={ut("ant.purposeHint")}>
          <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder={ut("rep.purposePlaceholder")} maxLength={200} />
        </Field>
        <span className="pt-[26px]">
          {/* что увозят файлы — вся методика, а не срез экрана: выгрузка срез не принимает (exportCount) */}
          <Tag tone="primary" icon={<Ic.clipboard />}>
            {fill(ut("ant.exportScope"), { title: data.title, n: nf(exportCount(data.versions)) })}
          </Tag>
        </span>
      </div>
      <div role="radiogroup" aria-label={ut("an.profile")} className="mb-3.5">
        <span className="mb-1.5 block text-caption font-bold text-muted">{ut("an.profile")}</span>
        <div className="grid grid-cols-3 gap-2 max-[640px]:grid-cols-1">
          {profiles.map((p) =>
            p.key === "full" && !full ? (
              <div key={p.key} title={ut("ant.profFullDenied")} className="opacity-48">
                <ChoiceCard name="exp-profile" value={p.key} checked={false} onChange={() => {}} title={p.title} sub={ut("ant.profFullDenied")} />
              </div>
            ) : (
              <ChoiceCard key={p.key} name="exp-profile" value={p.key} checked={profile === p.key} onChange={() => setProfile(p.key)} title={p.title} sub={p.sub} />
            ),
          )}
        </div>
      </div>
      <span className="mb-1.5 block text-caption font-bold text-muted">{ut("ant.filesLabel")}</span>
      <div className="grid grid-cols-2 gap-2 max-[640px]:grid-cols-1">
        {files.map(({ key, ...f }) => (
          <FileButton key={key} {...f} disabled={busy || f.disabled} hint={f.disabled ? ut("ant.profFullDenied") : undefined} />
        ))}
      </div>
      <Callout kind="neutral" icon={<Ic.shieldCheck />} className="mt-3">
        {ut("an.exportsNote")}
      </Callout>
    </Modal>
  );
}

/**
 * Что изменилось между двумя версиями.
 *
 * Главный ответ здесь один: сопоставимы ли баллы. Перечень правок — лишь
 * обоснование этого ответа, поэтому вывод стоит первым и крупно, а список
 * изменений — под ним и мелко.
 */
function VersionDiff({ surveyId, versions }: { surveyId: string; versions: { id: string; version: number }[] }) {
  const { ut } = useLang();
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const [a, setA] = useState(sorted[sorted.length - 2]?.id ?? sorted[0]!.id);
  const [b, setB] = useState(sorted[sorted.length - 1]!.id);
  /*
   * Загрузкой: сравнение прежней пары версий не встанет под новую, отказ
   * сбросится удачным повтором. Пока новая пара считается, прежнего
   * сравнения на экране нет (keep: false) — оно было бы ответом не на тот
   * вопрос.
   */
  const res = useResource(() => api.versionDiff(surveyId, a, b), [surveyId, a, b], { enabled: a !== b, keep: false });
  const diff: VersionDiffResult | null = a !== b ? res.data : null;
  const error = res.error;

  const pick = (label: string, value: string, onChange: (v: string) => void) => (
    <Field label={label} className="w-[180px]">
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
    <div key={ch.field} className="grid grid-cols-[140px_minmax(0,1fr)_16px_minmax(0,1fr)] gap-x-2 text-small leading-[18px]">
      <span className={cx("truncate font-mono", ch.scoring ? "font-bold text-text" : "text-muted")}>{ch.field}</span>
      <span className="text-muted line-through">{ch.before ?? "—"}</span>
      <span aria-hidden className="text-muted">
        →
      </span>
      <span className="text-text">{ch.after ?? "—"}</span>
    </div>
  );

  return (
    <div className="flex flex-col gap-3.5">
      <p className="m-0 text-small text-text-2">{ut("an.versionHint")}</p>
      <div className="flex items-end gap-3">
        {pick(ut("ant.versionFrom"), a, setA)}
        <span aria-hidden className="pb-6 text-muted">
          →
        </span>
        {pick(ut("ant.versionTo"), b, setB)}
      </div>
      {error ? <p className="m-0 text-small font-bold text-risk-ink">{error}</p> : null}
      {a === b ? <p className="m-0 text-small text-muted">{ut("an.pickDifferent")}</p> : null}
      {diff ? (
        <>
          {/* вывод — словом и тоном: сопоставимо — «сделано», нет — «требует внимания» */}
          <Callout kind={diff.comparable ? "good" : "warn"} title={ut(diff.comparable ? "an.comparable" : "an.notComparable")}>
            {diff.reasons.length ? diff.reasons.join("; ") : ut("an.noScoringChange")}
          </Callout>
          {diff.scales.map((sc) => (
            <div key={sc.code} className="border-t border-divider pt-2">
              <p className="m-0 mb-1 text-body font-extrabold text-text">
                {ut("an.scaleWord")} {sc.code} <span className="font-semibold text-muted">{ut(KIND[sc.kind])}</span>
              </p>
              {sc.changes.map(change)}
            </div>
          ))}
          {diff.questions.map((q, i) => (
            <div key={`${q.position}-${i}`} className="border-t border-divider pt-2">
              <p className="m-0 text-body font-extrabold text-text">
                {ut("an.item")} {q.position} <span className="font-semibold text-muted">{ut(KIND[q.kind])}</span>
              </p>
              <p className="m-0 mb-1 text-small text-muted">{q.title}</p>
              {q.changes.map(change)}
            </div>
          ))}
          {!diff.scales.length && !diff.questions.length ? <p className="m-0 text-small text-muted">{ut("an.sameContent")}</p> : null}
        </>
      ) : null}
    </div>
  );
}
