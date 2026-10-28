import { useState } from "react";
import { Link } from "react-router-dom";
import type { PatientCardConclusion } from "@quizzy/shared";
import type { NoteVersion } from "../../api";
import { timeOfDay } from "../../format";
import { useLang } from "../../lang";
import { Empty, Loading, ViewPills } from "../../ui";
import { cx } from "../../ui/cx";
import { IconTile, Panel } from "../../ui/layout";
import { Button, Tag } from "../../ui/primitives";
import { useUrlState } from "../../ui/urlState";
import { initialsName } from "../patients/model";
import { InlineAction } from "./Banner";
import { dm } from "./format";
import { Pi } from "./icons";
import { recordKindOf, type RecordKind } from "./tabs";
import type { CardView } from "./types";

/*
 * «Записи» — всё, что специалисты написали о человеке, одной лентой от
 * свежего: записи прийому (первинний, прийом, спостереження, консультація)
 * и заключения по методикам. Прежде записи жили во вкладке «Нотатки»
 * карточки и в панели «Записи прийому» клинической карты, заключения — во
 * вкладке «Заключення», в «Огляді справи» и в правой колонке «Огляду», и
 * одно и то же подписанное заключение стояло в трёх местах.
 *
 * Пишут здесь в ящике — тем же видом, что открывают «Запис прийому» (N) и
 * «Заключення» шапки: редактор один.
 */

type Item =
  | { kind: "note"; key: string; at: string; note: NoteVersion }
  | { kind: "concl"; key: string; at: string; concl: PatientCardConclusion };

const NOTE_KIND = { intake: "note.intake", session: "note.session", observation: "note.observation", consult: "note.consult" } as const;

/** «28.10, 14:20» — коротко, как даты по всей вкладке */
const stamp = (iso: string) => `${dm(iso)}, ${timeOfDay(iso)}`;

/** Записи и заключения одной лентой, свежие первыми */
export function recordItems(notes: readonly NoteVersion[], conclusions: readonly PatientCardConclusion[]): Item[] {
  return [
    ...notes.map((n): Item => ({ kind: "note", key: `n:${n.id}`, at: n.signedAt ?? n.createdAt, note: n })),
    ...conclusions.map((c): Item => ({ kind: "concl", key: `c:${c.id}`, at: c.signedAt ?? c.createdAt, concl: c })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

export function RecordsTab({ v }: { v: CardView }) {
  const { ut } = useLang();
  const [raw, setKind] = useUrlState("kind", "all");
  const kind = recordKindOf(raw);
  if (!v.notes && v.notesError) return <Loading rows={1} error={v.notesError} onRetry={v.reloadNotes} />;
  if (!v.notes) return <Loading rows={4} />;
  const items = recordItems(v.notes.versions, v.card.conclusions);
  const shown = kind === "all" ? items : items.filter((i) => i.kind === (kind === "notes" ? "note" : "concl"));
  const count = (k: Item["kind"]) => items.filter((i) => i.kind === k).length;
  return (
    <Panel
      title={ut("ws.tRecords")}
      icon={<Pi.notebookText />}
      count={items.length || null}
      actions={
        <>
          {v.can("conclusions.write") && v.card.responses.length ? (
            <Button size="xs" icon={<Pi.filePlus />} onClick={() => v.open("concl")}>
              {ut("pcard.newConclusion")}
            </Button>
          ) : null}
          {v.can("notes.write") ? (
            <Button variant="primary" size="xs" icon={<Pi.notebookPen />} onClick={() => v.open("note")}>
              {ut("ws.newNote")}
            </Button>
          ) : null}
        </>
      }
      flush
    >
      <div className="px-4 pb-3">
        <ViewPills
          label={ut("ws.recordKinds")}
          value={kind}
          onChange={(k) => setKind(k as RecordKind)}
          items={[
            { key: "all", label: ut("pg.allTab"), count: items.length },
            { key: "notes", label: ut("note.title"), count: count("note") },
            { key: "concl", label: ut("pcard.conclusions"), count: count("concl") },
          ]}
        />
      </div>
      {!shown.length ? (
        <div className="border-t border-divider px-4 pb-2">
          <Empty compact title={kind === "concl" ? ut("pcard.noConclusions") : ut("ws.noRecords")} />
        </div>
      ) : (
        <ol className="m-0 list-none p-0">
          {shown.map((i) => (i.kind === "note" ? <NoteRow key={i.key} n={i.note} v={v} /> : <ConclRow key={i.key} c={i.concl} v={v} />))}
        </ol>
      )}
    </Panel>
  );
}

/** Текст записи: длинный — шестью строками и «Показати повністю» */
function RecordText({ text }: { text: string }) {
  const { ut } = useLang();
  const [all, setAll] = useState(false);
  const long = text.length > 420 || text.split("\n").length > 6;
  if (!text) return null;
  return (
    <>
      <p className={cx("m-0 mt-1.5 whitespace-pre-wrap text-body leading-[21px] text-text", !all && long && "line-clamp-6")}>{text}</p>
      {long ? (
        <InlineAction onClick={() => setAll((x) => !x)}>{all ? ut("ws.collapse") : ut("ws.showAll")}</InlineAction>
      ) : null}
    </>
  );
}

function RowShell({
  icon,
  tone,
  title,
  status,
  meta,
  action,
  children,
}: {
  icon: React.ReactNode;
  tone: "violet" | "good" | "neutral";
  title: React.ReactNode;
  status: "draft" | "signed";
  meta: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const { ut } = useLang();
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-3 gap-y-0 border-t border-divider px-4 py-3.5">
      <IconTile icon={icon} tone={tone} />
      <article className="min-w-0">
        <header className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="m-0 min-w-0 text-[14px] font-extrabold text-text">{title}</h3>
          {status === "draft" ? <Tag icon={<Pi.filePen />}>{ut("card.draft")}</Tag> : <Tag tone="good">{ut("card.signed")}</Tag>}
          {action ? <span className="ml-auto flex items-center gap-2">{action}</span> : null}
        </header>
        <p className="m-0 mt-0.5 text-caption text-muted">{meta}</p>
        {children}
      </article>
    </li>
  );
}

function NoteRow({ n, v }: { n: NoteVersion; v: CardView }) {
  const { ut } = useLang();
  const meta = [
    n.status === "signed" && n.signedAt ? `${ut("ws.signedOn")} ${stamp(n.signedAt)}` : stamp(n.createdAt),
    initialsName(n.authorName),
    ut("card.version").replace("{v}", String(n.version)),
  ].join(" · ");
  return (
    <RowShell
      icon={<Pi.notebookText />}
      tone={n.status === "signed" ? "violet" : "neutral"}
      title={`${ut("ws.note")} · ${ut(NOTE_KIND[n.kind]).toLowerCase()}`}
      status={n.status}
      meta={meta}
      action={
        n.status === "draft" && v.can("notes.write") ? (
          <Button size="xs" onClick={() => v.open("note")}>
            {ut("card.continue")}
          </Button>
        ) : undefined
      }
    >
      <RecordText text={n.text} />
    </RowShell>
  );
}

function ConclRow({ c, v }: { c: PatientCardConclusion; v: CardView }) {
  const { ut } = useLang();
  const response = v.card.responses.find((r) => r.responseId === c.responseId);
  const meta = [
    c.status === "signed" && c.signedAt ? `${ut("ws.signedOn")} ${stamp(c.signedAt)}` : stamp(c.createdAt),
    initialsName(c.authorName),
    response?.submittedAt ? ut("ws.measuredOn").replace("{d}", dm(response.submittedAt)) : null,
    ut("card.version").replace("{v}", String(c.version)),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <RowShell
      icon={<Pi.filePen />}
      tone={c.status === "signed" ? "good" : "neutral"}
      title={ut("ws.conclOf").replace("{s}", c.surveyTitle)}
      status={c.status}
      meta={meta}
      action={
        <>
          {c.status === "draft" && v.can("conclusions.write") ? (
            <Button size="xs" onClick={() => v.open("concl", { responseId: c.responseId })}>
              {ut("card.continue")}
            </Button>
          ) : null}
          <Link to={`/responses/${c.responseId}/conclusion`} className="text-small font-bold text-violet-ink">
            {ut("ws.openSheet")}
          </Link>
        </>
      }
    >
      <RecordText text={c.text} />
    </RowShell>
  );
}
