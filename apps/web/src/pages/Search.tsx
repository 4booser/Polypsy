import { useEffect, useMemo, useRef, useState } from "react";
import type { UiKey } from "@quizzy/shared";
import { api, type NoteVersion } from "../api";
import { useLang } from "../lang";
import { Avatar, Drawer, DrawerSection, KbdHints, KV, Loading, useAction } from "../ui";
import { cx } from "../ui/cx";
import { FilterChip } from "../ui/filters";
import { Ic } from "../ui/icons";
import { Kbd } from "../ui/kbd";
import { useHotkeys } from "../ui/keys";
import { Page, Panel } from "../ui/layout";
import { MenuButton, menuItemClass } from "../ui/menu";
import { Button, ButtonLink, Checkbox, CheckLabel, Segmented, Tag } from "../ui/primitives";
import { useResource } from "../useResource";
import { Pi } from "./patientGroups/icons";
import { fill, pluralOf, shortDate } from "./patientGroups/model";
import {
  RECENT_KEY,
  facetCounts,
  filterHits,
  groupHits,
  highlight,
  parseRecent,
  pushRecent,
  type Hit,
  type Period,
} from "./search/model";

/**
 * Поиск по записям приёма (patients-search «Виразної»).
 *
 * Записи зашифрованы, и поиск идёт по отпечаткам основ слов, а не по тексту.
 * Об этом сказано прямо на экране — панелью «Як шукаємо»: ограничения поиска
 * — не техническая деталь, а то, что определяет, какой запрос сработает.
 * «Тривожність» найдёт «тривожності», но не «тривогу», и человек должен
 * знать это до того, как решит, что записи нет.
 *
 * Находки — группами по пациенту (или лентой по дате) с уривком и
 * подсветкой основ. Запись целиком открывается в ящике: её читает маршрут
 * записей пациента (GET /api/notes/patients/:id), и прочтение уходит в
 * журнал доступа — это сказано в подвале ящика. Уривок, а не запись целиком
 * в списке: поиск по одному слову выложил бы на экран десяток клинических
 * текстов сразу, а прочитан будет один.
 *
 * Отбор («Звузити знайдене»: вид записи, автор; период и пациент) — по
 * пришедшим находкам, без нового запроса. Нещодавні запити живут до
 * закрытия вкладки (search/model.ts — почему).
 */

const KIND_KEY: Record<string, UiKey> = {
  intake: "note.intake",
  session: "note.session",
  observation: "note.observation",
  consult: "note.consult",
};

const PERIODS: { key: Period; label: UiKey }[] = [
  { key: "all", label: "srch2.periodAll" },
  { key: "30", label: "srch2.period30" },
  { key: "90", label: "srch2.period90" },
  { key: "365", label: "srch2.period365" },
];

/** «05.10.2026, 13:40» — день и время записи, как в строке реестра */
function dateTime(iso: string): string {
  const d = new Date(iso);
  return `${shortDate(iso, new Date(0))}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function readRecent(): string[] {
  try {
    return parseRecent(sessionStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

export default function Search() {
  const { ut, lang } = useLang();
  const { run, busy } = useAction();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const [result, setResult] = useState<Awaited<ReturnType<typeof api.searchNotes>> | null>(null);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const [by, setBy] = useState<"patient" | "date">("patient");
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [hiddenAuthors, setHiddenAuthors] = useState<Set<string>>(new Set());
  const [period, setPeriod] = useState<Period>("all");
  const [patient, setPatient] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const search = (text = q) => {
    const clean = text.trim();
    if (clean.length < 2) return;
    void run(async () => {
      const res = await api.searchNotes(clean);
      setResult(res);
      setAsked(clean);
      setHiddenKinds(new Set());
      setHiddenAuthors(new Set());
      setPatient("");
      setOpenId(null);
      const next = pushRecent(recent, clean);
      setRecent(next);
      try {
        sessionStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* хранилище недоступно — список живёт до перезагрузки */
      }
    });
  };

  const now = Date.now();
  const hits = result?.items ?? [];
  const shown = useMemo(
    () => filterHits(hits, { hiddenKinds, hiddenAuthors, period, patient, now }),
    [hits, hiddenKinds, hiddenAuthors, period, patient, now],
  );
  const groups = groupHits(shown, by);
  const order = groups.flatMap((g) => g.hits);
  const people = useMemo(() => groupHits(hits, "patient"), [hits]);
  const words = result?.words ?? [];
  const current = hits.find((h) => h.id === openId) ?? null;

  const openHit = (h: Hit) => {
    setOpenId(h.id);
    setDrawerOpen(true);
  };
  const nextHit = (dir: 1 | -1) => {
    if (!order.length) return;
    const at = order.findIndex((h) => h.id === openId);
    const next = order[at < 0 ? 0 : (at + dir + order.length) % order.length]!;
    setOpenId(next.id);
    document.querySelector<HTMLElement>(`[data-hit="${next.id}"] button`)?.focus({ preventScroll: false });
  };
  const stepFocus = (dir: 1 | -1) => {
    const list = Array.from(document.querySelectorAll<HTMLElement>("[data-hit] [data-open-hit]"));
    if (!list.length) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    const el = list[at < 0 ? 0 : Math.min(list.length - 1, Math.max(0, at + dir))];
    el?.focus();
    el?.scrollIntoView({ block: "nearest" });
  };
  useHotkeys({ "/": () => inputRef.current?.focus(), j: () => stepFocus(1), k: () => stepFocus(-1), о: () => stepFocus(1), л: () => stepFocus(-1) }, !drawerOpen);
  useHotkeys({ j: () => nextHit(1), k: () => nextHit(-1), о: () => nextHit(1), л: () => nextHit(-1) }, drawerOpen);

  const toggle = (set: Set<string>, value: string) => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  const chipMenu = (label: string, value: string | null, options: { key: string; label: string }[], pick: (k: string) => void, current: string, clear?: () => void) => (
    <MenuButton
      label={label}
      trigger={(p) => <FilterChip label={label} value={value ?? undefined} on={!!clear} onClick={p.onClick} expanded={p["aria-expanded"]} onClear={clear} />}
    >
      {(close) =>
        options.map((o) => (
          <button
            key={o.key}
            type="button"
            role="menuitemradio"
            aria-checked={o.key === current}
            className={menuItemClass("left")}
            onClick={() => {
              close();
              pick(o.key);
            }}
          >
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {o.key === current ? <Ic.check size={15} className="text-violet-ink" /> : null}
          </button>
        ))
      }
    </MenuButton>
  );

  return (
    <Page
      title={ut("srch.title")}
      meta={
        result
          ? [fill(ut(`srch2.recordsN.${pluralOf(hits.length, lang)}`), { n: hits.length }), ut("srch2.metaWhat")]
          : [ut("srch2.metaIdle"), ut("srch2.metaWhat")]
      }
    >
      <Panel>
        <form
          className="flex items-center gap-2.5 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <label className="flex h-[52px] min-w-0 flex-1 cursor-text items-center gap-2.5 rounded-[14px] border border-field-border bg-panel px-4 focus-within:border-violet-ring focus-within:shadow-[0_0_0_3px_var(--vtint)]">
            <Pi.textSearch size={18} className="text-muted" />
            <input
              ref={inputRef}
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label={ut("srch2.words")}
              placeholder={ut("srch.placeholder")}
              autoComplete="off"
              maxLength={200}
              className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-[16px] font-medium text-text outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:appearance-none"
            />
            {result && asked === q.trim() && words.length ? (
              <span className="flex shrink-0 gap-1" title={ut("srch2.stemsHint")}>
                {words.map((w) => (
                  <Tag key={w} tone="primary">
                    {w}…
                  </Tag>
                ))}
              </span>
            ) : (
              <Kbd>/</Kbd>
            )}
          </label>
          <Button type="submit" variant="primary" size="lg" disabled={busy || q.trim().length < 2}>
            {ut("srch.go")}
          </Button>
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {chipMenu(
            ut("srch2.period"),
            ut(PERIODS.find((p) => p.key === period)!.label),
            PERIODS.map((p) => ({ key: p.key, label: ut(p.label) })),
            (k) => setPeriod(k as Period),
            period,
            period !== "all" ? () => setPeriod("all") : undefined,
          )}
          {people.length > 1 || patient
            ? chipMenu(
                ut("pg.patient"),
                patient ? (people.find((p) => p.userId === patient)?.userName ?? null) : null,
                people.map((p) => ({ key: p.userId!, label: p.userName })),
                setPatient,
                patient,
                patient ? () => setPatient("") : undefined,
              )
            : null}
          <span className="ml-auto flex items-center gap-1.5 text-small text-muted">
            <Ic.info size={14} />
            {ut("srch2.allWords")}
          </span>
        </div>
      </Panel>

      <div className="mt-4 grid items-start gap-4 min-[1100px]:grid-cols-[minmax(0,1fr)_320px]">
        <Panel
          title={result ? fill(ut("srch2.found"), { n: shown.length }) : ut("srch2.results")}
          icon={<Pi.files />}
          sub={
            result && shown.length
              ? fill(ut(`srch2.inPatients.${pluralOf(new Set(shown.map((h) => h.userId)).size, lang)}`), {
                  n: new Set(shown.map((h) => h.userId)).size,
                })
              : undefined
          }
          actions={
            result && shown.length ? (
              <Segmented
                label={ut("srch2.groupBy")}
                items={[
                  { key: "patient", label: ut("srch2.byPatient") },
                  { key: "date", label: ut("srch2.byDate") },
                ]}
                value={by}
                onChange={setBy}
              />
            ) : null
          }
          flush
          footer={
            result && shown.length ? (
              <KbdHints keys={[["J K", ut("srch2.kHits")], ["Enter", ut("srch2.kOpen")], ["/", ut("srch2.kNew")]]} />
            ) : undefined
          }
        >
          {busy && !result ? (
            <Loading rows={3} bare />
          ) : !result ? (
            <p className="m-0 px-4 pb-5 text-body text-text-2">{ut("srch2.idle")}</p>
          ) : hits.length === 0 ? (
            <p className="m-0 px-4 pb-5 text-body text-text-2">{fill(ut("srch2.nothing"), { q: asked })}</p>
          ) : shown.length === 0 ? (
            <p className="m-0 px-4 pb-5 text-body text-text-2">{ut("srch2.allFiltered")}</p>
          ) : (
            <div aria-busy={busy || undefined} className={cx(busy && "opacity-60")}>
              {groups.map((g) => (
                <section key={g.userId ?? "date"} className="border-t border-divider px-4 pb-2.5 pt-3.5 first:border-t-0">
                  {g.userId ? (
                    <div className="flex items-center gap-2.5">
                      <Avatar name={g.userName} size={34} />
                      <b className="min-w-0 flex-1 truncate text-body font-bold">{g.userName}</b>
                      <span className="text-small text-muted">{fill(ut(`srch2.recordsN.${pluralOf(g.hits.length, lang)}`), { n: g.hits.length })}</span>
                      <ButtonLink to={`/patients/${g.userId}/case`} size="xs">
                        <Pi.folderOpen size={14} />
                        {ut("ref2.case")}
                      </ButtonLink>
                    </div>
                  ) : null}
                  {g.hits.map((h) => (
                    <article
                      key={h.id}
                      data-hit={h.id}
                      className={cx(
                        "mb-1 mt-2 rounded-[12px] px-3 pb-3 pt-2.5",
                        g.userId && "ml-[44px] max-[700px]:ml-0",
                        drawerOpen && h.id === openId ? "bg-violet-tint" : "hover:bg-panel-2",
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted">
                        <Tag>{KIND_KEY[h.kind] ? ut(KIND_KEY[h.kind]!) : h.kind}</Tag>
                        {g.userId ? null : <b className="font-bold text-text">{h.userName}</b>}
                        <span>{dateTime(h.createdAt)}</span>
                        <span>
                          {ut("note.version")} {h.version}
                        </span>
                        <span>{h.authorName}</span>
                        <Button
                          data-open-hit
                          variant="ghost"
                          size="xs"
                          className="ml-auto"
                          onClick={() => openHit(h)}
                          aria-label={`${ut("srch2.openNote")}: ${h.userName}, ${dateTime(h.createdAt)}`}
                        >
                          {ut("srch2.openNote")}
                          <Pi.arrowUpRight size={14} />
                        </Button>
                      </div>
                      <p className="m-0 mt-1.5 text-body leading-[21px] text-text">
                        <Marked text={h.excerpt} words={words} />
                      </p>
                    </article>
                  ))}
                </section>
              ))}
            </div>
          )}
        </Panel>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel title={ut("srch2.how")} icon={<Pi.lockKeyhole />}>
            <p className="m-0 text-small text-text-2">{ut("srch2.howText")}</p>
            <div className="mt-3 flex gap-2.5 rounded-[12px] bg-sunk p-3 text-small text-text-2">
              <Pi.scissors size={16} className="mt-0.5 text-violet-ink" />
              <span>{ut("srch.morphNote")}</span>
            </div>
            <ul className="m-0 mt-3 flex list-none flex-col gap-1.5 p-0 text-small text-text-2">
              {(["srch2.rule2", "srch2.ruleExcerpt", "srch2.ruleZone"] as const).map((k) => (
                <li key={k} className="flex gap-2">
                  <Ic.check size={14} className="mt-0.5 text-good" />
                  {ut(k)}
                </li>
              ))}
            </ul>
          </Panel>
          {result && hits.length ? (
            <Panel title={ut("srch2.narrow")} icon={<Pi.listFilter />} sub={fill(ut(`srch2.recordsN.${pluralOf(shown.length, lang)}`), { n: shown.length })}>
              <span className="mb-1.5 block text-caption font-bold text-muted">{ut("srch2.kind")}</span>
              <div className="flex flex-col gap-1.5">
                {facetCounts(hits, "kind").map((f) => (
                  <CheckLabel
                    key={f.value}
                    control={<Checkbox checked={!hiddenKinds.has(f.value)} onChange={() => setHiddenKinds((s) => toggle(s, f.value))} />}
                    label={
                      <>
                        {KIND_KEY[f.value] ? ut(KIND_KEY[f.value]!) : f.value} <span className="font-medium text-muted">{f.count}</span>
                      </>
                    }
                  />
                ))}
              </div>
              <span className="mb-1.5 mt-4 block text-caption font-bold text-muted">{ut("srch2.author")}</span>
              <div className="flex flex-col gap-1.5">
                {facetCounts(hits, "authorName").map((f) => (
                  <CheckLabel
                    key={f.value}
                    control={<Checkbox checked={!hiddenAuthors.has(f.value)} onChange={() => setHiddenAuthors((s) => toggle(s, f.value))} />}
                    label={
                      <>
                        {f.value} <span className="font-medium text-muted">{f.count}</span>
                      </>
                    }
                  />
                ))}
              </div>
            </Panel>
          ) : null}
          {recent.length ? (
            <Panel title={ut("srch2.recent")} icon={<Ic.history />}>
              <div className="flex flex-wrap gap-1.5">
                {recent.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => {
                      setQ(r);
                      search(r);
                    }}
                    className="inline-flex h-9 min-h-0 cursor-pointer items-center rounded-[18px] border-0 bg-sunk px-3 text-small font-semibold text-text-2 hover:bg-sunk-2 hover:text-text"
                  >
                    {r}
                  </button>
                ))}
              </div>
              <p className="m-0 mt-2.5 text-caption text-muted">{ut("srch2.recentNote")}</p>
            </Panel>
          ) : null}
        </div>
      </div>

      <NoteDrawer
        open={drawerOpen}
        hit={current}
        words={words}
        onClose={() => setDrawerOpen(false)}
        onReturn={() => setDrawerOpen(true)}
        onNext={() => nextHit(1)}
        hasNext={order.length > 1}
      />
    </Page>
  );
}

/** Уривок с подсветкой основ: <mark> — и для диктора, и для печати */
function Marked({ text, words }: { text: string; words: readonly string[] }) {
  return (
    <>
      {highlight(text, words).map((part, i) =>
        part.hit ? (
          <mark key={i} className="rounded-[4px] bg-violet-tint-2 px-0.5 font-bold text-text">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Запись целиком — в ящике. Читается маршрутом записей пациента: прочтение
 * журналируется (это сказано в подвале). Версия ищется по номеру найденной
 * записи; если запись с тех пор переписали, ящик говорит об этом и
 * показывает уривок.
 */
function NoteDrawer({
  open,
  hit,
  words,
  onClose,
  onReturn,
  onNext,
  hasNext,
}: {
  open: boolean;
  hit: Hit | null;
  words: readonly string[];
  onClose: () => void;
  onReturn: () => void;
  onNext: () => void;
  hasNext: boolean;
}) {
  const { ut } = useLang();
  const notes = useResource(() => api.notes(hit!.userId), [hit?.userId], { enabled: open && !!hit, keep: false });
  const version: NoteVersion | null = notes.data?.versions.find((v) => v.id === hit?.id) ?? null;
  const [shownId, setShownId] = useState<string | null>(null);
  useEffect(() => {
    if (open && hit) setShownId(hit.id);
  }, [open, hit]);

  if (!hit) return <Drawer open={false} onClose={onClose} title={ut("srch2.note")} />;
  const kind = KIND_KEY[hit.kind] ? ut(KIND_KEY[hit.kind]!) : hit.kind;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      onReturn={onReturn}
      wide
      title={fill(ut("srch2.noteTitle"), { kind, date: dateTime(hit.createdAt) })}
      sub={hit.userName}
      icon={<Pi.notebook />}
      note={ut("srch2.auditNote")}
      noteIcon={<Ic.shieldCheck />}
      footer={
        <>
          <ButtonLink to={`/patients/${hit.userId}/case`} variant="primary">
            <Pi.folderOpen size={15} />
            {ut("pg2.openCase")}
          </ButtonLink>
          {hasNext ? (
            <Button onClick={onNext} icon={<Ic.arrowDown />}>
              {ut("srch2.nextHit")}
              <Kbd>J</Kbd>
            </Button>
          ) : null}
        </>
      }
    >
      <DrawerSection
        title={ut("srch2.note")}
        tag={<Tag>{kind}</Tag>}
        right={
          version?.status === "signed" ? (
            <Tag tone="good" icon={<Ic.check />}>
              {ut("note.signedAt")}
            </Tag>
          ) : version ? (
            <Tag tone="attention">{ut("note.draft")}</Tag>
          ) : null
        }
      >
        <p className="m-0 mb-2 text-caption text-muted">
          {dateTime(hit.createdAt)}, {ut("note.version")} {hit.version}, {hit.authorName}
        </p>
        {notes.error ? (
          <Loading error={notes.error} onRetry={notes.reload} bare />
        ) : !notes.data || shownId !== hit.id ? (
          <Loading rows={4} bare />
        ) : version ? (
          <p className="m-0 whitespace-pre-line text-body leading-[22px] text-text">
            <Marked text={version.text} words={words} />
          </p>
        ) : (
          <>
            <p className="m-0 mb-2 text-small font-semibold text-warn">{ut("srch2.noteGone")}</p>
            <p className="m-0 text-body leading-[22px] text-text">
              <Marked text={hit.excerpt} words={words} />
            </p>
          </>
        )}
      </DrawerSection>
      <DrawerSection title={ut("srch2.context")}>
        <KV
          w={110}
          rows={[
            [ut("pg.patient"), hit.userName],
            [ut("srch2.kind"), kind],
            [ut("srch2.foundBy"), words.map((w) => `${w}…`).join(", ")],
          ]}
        />
      </DrawerSection>
    </Drawer>
  );
}
