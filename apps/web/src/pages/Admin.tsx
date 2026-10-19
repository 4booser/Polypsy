import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ConsentVersions } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { useResource, type Resource } from "../useResource";
import { Callout, Empty, Ic, Loading, Modal, NotLoaded, TextAction, loadView, useAction } from "../ui";
import { cx } from "../ui/cx";
import { Page, Panel } from "../ui/layout";
import { Button, Segmented, Switch, Tag, Textarea } from "../ui/primitives";
import { AIc, dmy, fill, shortName } from "./people/parts";
import { withCount } from "../ui/plural";

/*
 * Экран групп переехал в собственный файл.
 *
 * Реэкспорт остаётся: маршрут «/groups» в App.tsx подгружает `Groups`
 * именно отсюда, и убрать эту строку значит сломать его.
 */
export { default as Groups } from "./Groups";

/*
 * Экран учётных записей (`Users`) отсюда снят (волна 10): весь реестр,
 * заведение, устройства и остальное живут во вкладке «Користувачі»
 * техпанели (pages/ops/Users.tsx), а /users перенаправляет туда. Текст
 * согласия остался здесь — дверь к нему стоит на той же вкладке.
 */

type Lang3 = "uk" | "ru" | "en";
const LANGS: Lang3[] = ["uk", "ru", "en"];

/**
 * Текст информированного согласия — Polypsy 2.0, макеты admin-consent-text и
 * admin-consent-publish-dialog.
 *
 * Правка создаёт новую версию, и все пациенты увидят экран согласия заново —
 * у каждого принятия зафиксировано, какую редакцию человек читал. Поэтому
 * экран — черновик следующей версии со сравнением, предпросмотр «как увидит
 * пациент», версии со счётом принявших и публикация через окно, которое
 * говорит, что изменится и скольких людей это коснётся.
 *
 * Черновика на сервере нет: он живёт в форме, пока экран открыт, и
 * публикуется одним PUT /api/consents/text. «Хто прийняв» — только числа
 * (GET /api/consents/versions): имён пациентов с их решениями экран согласия
 * не показывает — это ещё один путь к персональным данным, а поимённо
 * решения лежат в журнале доступа (consent.accept / consent.decline).
 */
export function ConsentText() {
  /* источник черновика: сам не перечитывается — правку не затрёт (useResource, manual) */
  const res = useResource(() => api.consentText(), [], { manual: true });
  const { can } = useAuth();
  return <ConsentTextBody res={res} canAudit={can("audit.read")} />;
}

/**
 * Правка текста — только поверх известного текущего.
 *
 * «Не задано» — ответ сервера (текст согласия ещё не заводили), а не
 * отсутствие ответа. Раньше экран не различал их: пока текст ехал, на
 * отказе и без связи он показывал пустые поля с меткой «не задано» и живой
 * кнопкой сохранения. Администратор, поверивший метке, писал текст заново —
 * и сохранение выпускало новую редакцию поверх настоящей, а все пациенты
 * снова видели экран согласия. Теперь до ответа полей нет вовсе — скелет, на
 * отказе — отказ с «Повторити».
 */
export function ConsentTextBody({
  res,
  canAudit = false,
}: {
  res: Pick<Resource<Awaited<ReturnType<typeof api.consentText>>>, "data" | "error" | "loading" | "reload" | "updatedAt">;
  canAudit?: boolean;
}) {
  const { ut, lang } = useLang();
  const { run, busy } = useAction();
  const versions = useResource(() => api.consentVersions(), []);
  const current = res.data;
  const view = loadView(res);
  const known = view === "ready" || view === "empty";
  const saved: Record<Lang3, string> = { uk: current?.body.uk ?? "", ru: current?.body.ru ?? "", en: current?.body.en ?? "" };
  const [draft, setDraft] = useState<Record<Lang3, string>>(saved);
  const [tab, setTab] = useState<Lang3>(LANGS.includes(lang as Lang3) ? (lang as Lang3) : "uk");
  const [showDiff, setShowDiff] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<number | null>(null);
  useEffect(() => {
    if (!current) return;
    setDraft({ uk: current.body.uk ?? "", ru: current.body.ru ?? "", en: current.body.en ?? "" });
  }, [current]);

  const version = published ?? current?.version ?? null;
  const next = (version ?? 0) + 1;
  const changed = (l: Lang3) => draft[l].trim() !== saved[l].trim();
  const dirty = LANGS.some(changed);
  /* та же граница, что держит сервер: украинский и русский от 10 знаков, начатый английский — тоже */
  const valid = draft.uk.trim().length >= 10 && draft.ru.trim().length >= 10 && (draft.en.trim().length === 0 || draft.en.trim().length >= 10);
  /* русский не тронут, а украинский поменялся — редакции разошлись; публиковать можно, но с предупреждением */
  const ruStale = changed("uk") && !changed("ru") && !!saved.ru.trim();
  const v = versions.data;
  const accepted = v?.versions.find((x) => x.version === version)?.accepted ?? null;
  const waiting = v && accepted !== null ? Math.max(0, v.patients - accepted) : null;

  const meta: [ReactNode, ReactNode] | undefined = !known
    ? undefined
    : version
      ? [
          fill(ut("adm2.consentCurrent"), { version: ut("adm.consentVersion"), n: version, date: current ? dmy(current.createdAt) : "" }),
          v && accepted !== null
            ? fill(ut("adm2.consentAccepted"), {
                n: accepted,
                total: v.patients,
                pct: v.patients ? Math.round((accepted / v.patients) * 100) : 0,
                waiting: waiting ?? 0,
              })
            : ut("adm.consentHint"),
        ]
      : [ut("adm.consentUnset"), ut("adm.consentHint")];

  return (
    <Page
      title={ut("adm.consentTitle")}
      meta={meta}
      actions={
        known ? (
          <Button variant="primary" icon={<AIc.send size={15} />} disabled={!dirty || !valid || busy} onClick={() => setPublishing(true)}>
            {`${ut("adm2.publish")} ${next}`}
          </Button>
        ) : null
      }
    >
      {!known ? (
        <Panel>
          <NotLoaded res={res} rows={5} />
        </Panel>
      ) : (
        <div className="grid items-start gap-4 min-[1180px]:grid-cols-[minmax(0,1fr)_360px]">
          <div className="flex min-w-0 flex-col gap-4">
            <Panel
              title={fill(ut("adm2.draftOf"), { n: next })}
              icon={<AIc.signature />}
              sub={ut("adm2.draftSub")}
              actions={
                dirty ? (
                  <Button variant="ghost" size="xs" icon={<AIc.trash size={14} />} onClick={() => setDraft(saved)}>
                    {ut("adm2.dropDraft")}
                  </Button>
                ) : null
              }
              footer={<DraftFooter draft={draft[tab]} saved={saved[tab]} ruStale={ruStale} />}
            >
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div role="tablist" aria-label={ut("adm2.languages")} className="flex flex-wrap gap-1">
                  {LANGS.map((l) => (
                    <button
                      key={l}
                      type="button"
                      role="tab"
                      id={`consent-tab-${l}`}
                      aria-selected={tab === l}
                      aria-controls={`consent-${l}`}
                      onClick={() => setTab(l)}
                      className={cx(
                        "inline-flex h-9 min-h-0 cursor-pointer items-center gap-2 rounded-control border-0 px-3 text-body",
                        tab === l ? "bg-panel font-extrabold text-violet-ink shadow-tile" : "bg-transparent font-semibold text-text-2 hover:bg-tab-hover",
                      )}
                    >
                      {ut(l === "uk" ? "adm.inUkrainian" : l === "ru" ? "adm.inRussian" : "adm2.inEnglish")}
                      <LangState l={l} draft={draft[l]} saved={saved[l]} ruStale={l === "ru" && ruStale} />
                    </button>
                  ))}
                </div>
                {version ? (
                  <Switch
                    className="ml-auto"
                    checked={showDiff}
                    onChange={setShowDiff}
                    label={fill(ut("adm2.changesSince"), { n: version })}
                  />
                ) : null}
              </div>
              {LANGS.map((l) => (
                <div key={l} id={`consent-${l}`} role="tabpanel" aria-labelledby={`consent-tab-${l}`} hidden={tab !== l}>
                  {showDiff && version ? (
                    <WordDiff before={saved[l]} after={draft[l]} />
                  ) : (
                    <Textarea
                      rows={14}
                      value={draft[l]}
                      onChange={(e) => setDraft((d) => ({ ...d, [l]: e.target.value }))}
                      aria-label={ut(l === "uk" ? "adm.inUkrainian" : l === "ru" ? "adm.inRussian" : "adm2.inEnglish")}
                      className="text-body leading-[22px]"
                    />
                  )}
                </div>
              ))}
            </Panel>
            <AcceptPanel versions={versions} version={version} canAudit={canAudit} />
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <Callout kind="warn" icon={<Ic.users size={16} />} title={fill(ut("adm2.publishAsks"), { n: v ? withCount(ut("adm2.nPatientsAll"), v.patients, lang) : "" })}>
              {ut("adm2.publishAsksBody")}
            </Callout>
            <PreviewPanel text={draft[tab].trim() || draft.uk} />
            <VersionsPanel versions={versions} draftVersion={dirty ? next : null} />
          </div>
        </div>
      )}
      {publishing ? (
        <PublishModal
          next={next}
          version={version}
          draft={draft}
          saved={saved}
          ruStale={ruStale}
          patients={v?.patients ?? null}
          busy={busy}
          onClose={() => setPublishing(false)}
          onPublish={() =>
            void run(async () => {
              const r = await api.saveConsentText({ uk: draft.uk.trim(), ru: draft.ru.trim(), en: draft.en.trim() });
              setPublished(r.version);
              setPublishing(false);
              res.reload();
              versions.reload();
            }, ut("adm.consentSaved"))
          }
        />
      ) : null}
    </Page>
  );
}

/** Состояние языка на вкладке: заполнен, не обновлён вслед за украинским, не задан */
function LangState({ l, draft, saved, ruStale }: { l: Lang3; draft: string; saved: string; ruStale: boolean }) {
  const { ut } = useLang();
  if (ruStale) return <Tag tone="attention">{ut("adm2.notUpdated")}</Tag>;
  if (l === "en" && !draft.trim()) return <span className="text-caption font-medium text-muted">{ut("kit.optional")}</span>;
  if (draft.trim().length >= 10) {
    return draft.trim() !== saved.trim() ? <Ic.pen size={13} className="text-violet-ink" /> : <Ic.circleCheck size={14} className="text-good" />;
  }
  return <AIc.shieldAlert size={14} className="text-warn" />;
}

/* ─────────── сравнение по словам ─────────── */

type Piece = { kind: "same" | "ins" | "del"; text: string };

/**
 * Сравнение двух текстов по словам — наибольшая общая подпоследовательность.
 * Текст согласия — сотни слов, таблица m×n здесь копеечная; пробелы и
 * переводы строк сохраняются вместе со словом, чтобы абзацы не слипались.
 */
export function wordDiff(before: string, after: string): Piece[] {
  const a = before.split(/(?<=\s)/);
  const b = after.split(/(?<=\s)/);
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i]![j] = a[i]!.trim() === b[j]!.trim() ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: Piece[] = [];
  const push = (kind: Piece["kind"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i]!.trim() === b[j]!.trim()) {
      push("same", b[j]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push("del", a[i]!);
      i++;
    } else {
      push("ins", b[j]!);
      j++;
    }
  }
  while (i < m) push("del", a[i++]!);
  while (j < n) push("ins", b[j++]!);
  return out;
}

function WordDiff({ before, after }: { before: string; after: string }) {
  const pieces = useMemo(() => wordDiff(before, after), [before, after]);
  return (
    <div className="min-h-[200px] whitespace-pre-wrap rounded-control border border-field-border bg-panel px-3.5 py-3 text-body leading-[22px] text-text">
      {pieces.map((p, i) =>
        p.kind === "same" ? (
          <span key={i}>{p.text}</span>
        ) : p.kind === "ins" ? (
          <ins key={i} className="rounded-[3px] bg-violet-tint text-violet-ink underline decoration-violet-line">
            {p.text}
          </ins>
        ) : (
          <del key={i} className="text-muted">
            {p.text}
          </del>
        ),
      )}
    </div>
  );
}

function DraftFooter({ draft, saved, ruStale }: { draft: string; saved: string; ruStale: boolean }) {
  const { ut, lang } = useLang();
  const pieces = useMemo(() => wordDiff(saved, draft), [saved, draft]);
  const ins = pieces.filter((p) => p.kind === "ins").length;
  const del = pieces.filter((p) => p.kind === "del").length;
  return (
    <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 text-small text-text-2">
      <span className="tabular-nums">{withCount(ut("adm2.nChars"), draft.length, lang)}</span>
      {ins ? (
        <span className="inline-flex items-center gap-1 font-bold text-violet-ink">
          <Ic.plus size={13} />
          {withCount(ut("adm2.nInserts"), ins, lang)}
        </span>
      ) : null}
      {del ? (
        <span className="inline-flex items-center gap-1 text-muted">
          <Ic.minus size={13} />
          {withCount(ut("adm2.nDeletes"), del, lang)}
        </span>
      ) : null}
      {ruStale ? (
        <span className="inline-flex items-center gap-1 font-bold text-warn">
          <Ic.alert size={13} />
          {ut("adm2.ruStale")}
        </span>
      ) : null}
    </div>
  );
}

/* ─────────── кто принял ─────────── */

function AcceptPanel({ versions, version, canAudit }: { versions: Resource<ConsentVersions>; version: number | null; canAudit: boolean }) {
  const { ut } = useLang();
  const v = versions.data;
  const accepted = v?.versions.find((x) => x.version === version)?.accepted ?? 0;
  const rows: { key: string; label: string; n: number; tone: string }[] = v
    ? [
        { key: "acc", label: ut("adm2.acceptedState"), n: accepted, tone: "bg-good" },
        { key: "wait", label: ut("adm2.waitingState"), n: Math.max(0, v.patients - accepted - v.declined), tone: "bg-warn" },
        { key: "dec", label: ut("adm2.declinedState"), n: v.declined, tone: "bg-text-2" },
      ]
    : [];
  return (
    <Panel
      title={ut("adm2.whoAccepted")}
      icon={<Ic.users />}
      sub={ut("adm2.whoAcceptedSub")}
      actions={canAudit ? <TextAction to="/ops/audit?action=consent.accept">{ut("adm2.byName")}</TextAction> : null}
    >
      {!v ? (
        <Loading rows={2} bare error={versions.error} onRetry={versions.reload} />
      ) : !version ? (
        <Empty compact title={ut("adm.consentUnset")} />
      ) : (
        <>
          <div className="flex h-3 overflow-hidden rounded-[6px] bg-track" aria-hidden>
            {rows.map((r) => (
              <span key={r.key} className={r.tone} style={{ width: `${v.patients ? (r.n / v.patients) * 100 : 0}%` }} />
            ))}
          </div>
          <dl className="m-0 mt-3 grid grid-cols-3 gap-3 max-[700px]:grid-cols-1">
            {rows.map((r) => (
              <div key={r.key} className="flex flex-col gap-0.5">
                <dt className="flex items-center gap-1.5 text-caption font-bold text-muted">
                  <span className={cx("size-2 rounded-full", r.tone)} />
                  {r.label}
                </dt>
                <dd className="m-0 text-[26px] font-extrabold leading-none tabular-nums text-text">{r.n}</dd>
              </div>
            ))}
          </dl>
          <p className="m-0 mt-3 text-small text-muted">{fill(ut("adm2.ofPatients"), { n: v.patients })}</p>
        </>
      )}
    </Panel>
  );
}

/* ─────────── предпросмотр ─────────── */

function PreviewPanel({ text }: { text: string }) {
  const { ut } = useLang();
  const [device, setDevice] = useState<"phone" | "web">("phone");
  const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const head = lines[0] && lines[0].length <= 120 ? lines[0] : ut("consent.title");
  const body = lines[0] && lines[0].length <= 120 ? lines.slice(1) : lines;
  return (
    <Panel
      title={ut("adm2.patientSees")}
      icon={<AIc.smartphone />}
      actions={
        <Segmented
          label={ut("adm2.patientSees")}
          value={device}
          onChange={setDevice}
          items={[
            { key: "phone", label: ut("adm2.phoneView") },
            { key: "web", label: ut("adm2.webView") },
          ]}
        />
      }
    >
      <div
        aria-hidden
        className={cx(
          "mx-auto flex flex-col overflow-hidden border border-border bg-ground",
          device === "phone" ? "w-[260px] rounded-[30px] px-3 pb-3 pt-4" : "w-full rounded-panel p-4",
        )}
      >
        <span className="text-[19px] font-extrabold leading-[23px] text-text">{head}</span>
        <div className={cx("mt-2.5 flex flex-col gap-1.5 overflow-hidden text-[11.5px] leading-[16px] text-text-2", device === "phone" ? "max-h-[260px]" : "max-h-[300px]")}>
          {body.length ? body.map((p, i) => <p key={i} className="m-0">{p}</p>) : <p className="m-0 text-muted">{ut("adm2.emptyPreview")}</p>}
        </div>
        <span className="mt-3 flex items-start gap-2 text-[11.5px] font-bold text-text">
          <span className="mt-px inline-grid size-4 shrink-0 place-items-center rounded-[4px] bg-violet text-onfill">
            <Ic.check size={11} />
          </span>
          {ut("adm2.readAndUnderstand")}
        </span>
        <span className="mt-1.5 text-[11px] text-muted">{ut("consent.hint")}</span>
        <span className="mt-3 grid grid-cols-2 gap-2">
          <span className="inline-grid h-9 place-items-center rounded-[10px] bg-violet-tint text-[12px] font-bold text-violet-ink">{ut("consent.decline")}</span>
          <span className="inline-grid h-9 place-items-center rounded-[10px] bg-violet text-[12px] font-bold text-onfill">{ut("consent.accept")}</span>
        </span>
      </div>
    </Panel>
  );
}

/* ─────────── версии ─────────── */

function VersionsPanel({ versions, draftVersion }: { versions: Resource<ConsentVersions>; draftVersion: number | null }) {
  const { ut, lang } = useLang();
  const list = versions.data?.versions ?? [];
  return (
    <Panel title={ut("adm2.versions")} icon={<Ic.history />} flush>
      {!versions.data ? (
        <div className="px-4 pb-4">
          <Loading rows={3} bare error={versions.error} onRetry={versions.reload} />
        </div>
      ) : (
        <ol className="m-0 list-none p-0">
          {draftVersion ? (
            <VersionRow badge={`v${draftVersion}`} title={fill(ut("adm2.versionN"), { n: draftVersion })} tag={<Tag tone="primary">{ut("adm2.draftTag")}</Tag>} sub={ut("adm2.draftNotPublished")} />
          ) : null}
          {list.map((x, i) => {
            const until = i > 0 ? list[i - 1]!.createdAt : null;
            return (
              <VersionRow
                key={x.id}
                badge={`v${x.version}`}
                title={fill(ut("adm2.versionN"), { n: x.version })}
                tag={i === 0 ? <Tag tone="good">{ut("adm2.currentTag")}</Tag> : null}
                sub={`${until ? `${dmy(x.createdAt)} — ${dmy(until)}` : fill(ut("adm2.sinceDate"), { date: dmy(x.createdAt) })}${x.author ? `, ${shortName(x.author)}` : ""}`}
                right={withCount(ut("adm2.nAccepted"), x.accepted, lang)}
              />
            );
          })}
          {!list.length && !draftVersion ? (
            <li className="px-4 pb-4">
              <Empty compact title={ut("adm.consentUnset")} />
            </li>
          ) : null}
        </ol>
      )}
    </Panel>
  );
}

function VersionRow({ badge, title, tag, sub, right }: { badge: string; title: string; tag?: ReactNode; sub: string; right?: string }) {
  return (
    <li className="flex items-center gap-3 border-t border-divider px-4 py-2.5">
      <span className="inline-grid size-9 shrink-0 place-items-center rounded-[10px] bg-sunk text-small font-extrabold text-text-2">{badge}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <b className="text-small font-extrabold text-text">{title}</b>
          {tag}
        </span>
        <small className="block truncate text-caption text-muted">{sub}</small>
      </span>
      {right ? <span className="whitespace-nowrap text-small tabular-nums text-text-2">{right}</span> : null}
    </li>
  );
}

/* ─────────── публикация ─────────── */

/** Абзацы, которые появились или изменились, и которые ушли — «що зміниться» */
export function paragraphChanges(before: string, after: string): { kind: "add" | "remove"; text: string }[] {
  const split = (s: string) => s.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const a = split(before);
  const b = split(after);
  return [
    ...b.filter((p) => !a.includes(p)).map((text) => ({ kind: "add" as const, text })),
    ...a.filter((p) => !b.includes(p)).map((text) => ({ kind: "remove" as const, text })),
  ];
}

function PublishModal({
  next,
  version,
  draft,
  saved,
  ruStale,
  patients,
  busy,
  onClose,
  onPublish,
}: {
  next: number;
  version: number | null;
  draft: Record<Lang3, string>;
  saved: Record<Lang3, string>;
  ruStale: boolean;
  patients: number | null;
  busy: boolean;
  onClose: () => void;
  onPublish: () => void;
}) {
  const { ut, lang } = useLang();
  const changes = paragraphChanges(saved.uk, draft.uk).slice(0, 6);
  const langRow = (l: Lang3): { icon: ReactNode; note: ReactNode } => {
    if (!draft[l].trim()) return { icon: <Ic.minus size={15} className="text-muted" />, note: <span className="text-muted">{ut("adm2.enFallback")}</span> };
    if (l === "ru" && ruStale) return { icon: <Ic.alert size={15} className="text-warn" />, note: <b className="font-bold text-warn">{ut("adm2.notUpdated")}</b> };
    if (draft[l].trim() !== saved[l].trim()) return { icon: <Ic.circleCheck size={15} className="text-good" />, note: <span className="text-text-2">{ut("adm2.updated")}</span> };
    return { icon: <Ic.circleCheck size={15} className="text-muted" />, note: <span className="text-muted">{ut("adm2.unchanged")}</span> };
  };
  return (
    <Modal
      title={fill(ut("adm2.publishQ"), { n: next })}
      sub={ruStale ? ut("adm2.ruStale") : ut("adm2.publishSub")}
      icon={<AIc.send />}
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" icon={<AIc.send size={15} />} disabled={busy} onClick={onPublish}>
            {`${ut("adm2.publish")} ${next}`}
          </Button>
          <Button onClick={onClose}>{ut("adm2.backToDraft")}</Button>
          <span className="ml-auto text-caption text-muted max-[600px]:hidden">{ut("adm2.rollbackNote")}</span>
        </>
      }
    >
      <section className="border-b border-divider pb-3.5">
        <h3 className="m-0 flex items-baseline gap-2 text-h3 font-extrabold text-text">
          {ut("adm2.whatChanges")}
          {version ? <span className="text-small font-medium text-muted">{fill(ut("adm2.comparedTo"), { n: version })}</span> : null}
        </h3>
        {changes.length ? (
          <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
            {changes.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-small text-text">
                {c.kind === "add" ? <Ic.plus size={15} className="mt-0.5 shrink-0 text-violet-ink" /> : <Ic.minus size={15} className="mt-0.5 shrink-0 text-muted" />}
                <span className={cx("line-clamp-2", c.kind === "remove" && "text-muted line-through")}>{c.text}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 mt-2 text-small text-muted">{ut("adm2.onlyTranslations")}</p>
        )}
      </section>
      <section className="border-b border-divider py-3.5">
        <h3 className="m-0 flex items-baseline gap-2 text-h3 font-extrabold text-text">
          {ut("adm2.languages")}
          <span className="text-small font-medium text-muted">{ut("adm2.languagesSub")}</span>
        </h3>
        <ul className="m-0 mt-2 list-none overflow-hidden rounded-panel border border-border p-0">
          {LANGS.map((l) => {
            const r = langRow(l);
            return (
              <li key={l} className="flex items-center gap-2.5 border-b border-divider px-3 py-2.5 text-small last:border-0">
                {r.icon}
                <b className="font-bold text-text">{ut(l === "uk" ? "adm.inUkrainian" : l === "ru" ? "adm.inRussian" : "adm2.inEnglish")}</b>
                <span className="ml-auto">{r.note}</span>
              </li>
            );
          })}
        </ul>
      </section>
      <div className="pt-3.5">
        <Callout kind="warn" icon={<Ic.users size={16} />} title={patients !== null ? fill(ut("adm2.willSee"), { n: withCount(ut("adm2.nPatientsAll"), patients, lang) }) : undefined}>
          {ut("adm2.willSeeBody")}
        </Callout>
      </div>
    </Modal>
  );
}
