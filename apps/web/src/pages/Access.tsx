import { useMemo, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import type { AuditEntry, SurveyGrant } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { ShellIcon } from "../shell/icons";
import { Avatar, eachOf, Modal, Screen, useAction, useToast } from "../ui";
import { DataTable, type Column } from "../ui/DataTable";
import { FilterBar } from "../ui/filters";
import { Ic } from "../ui/icons";
import { KbdHints } from "../ui/kbd";
import { Panel } from "../ui/layout";
import { ActivityList, PersonCell, TextAction } from "../ui/records";
import { Button, Segmented, Tag } from "../ui/primitives";
import { Empty } from "../ui/states";
import { useResource } from "../useResource";
import { Mi } from "./methods/icons";
import { MethodPage } from "./methods/MethodPage";
import { dayDiff, grantCounts, grantState, nextExpiring, shortDate, shortDateTime, splitCode, type GrantState } from "./methods/model";
import { num } from "./methods/useCount";

/*
 * Доступ до методики — UI 3, «Виразна» (methods-access).
 *
 * Сверху три панели: видимость (переключается здесь же, без конструктора),
 * кто ведёт доступ (администраторы группы методики) и назначения сейчас —
 * чинні, пройдено, прострочено, спливають за 7 днів. Ниже — таблица «Кому
 * призначено» с видами и поиском, а под ней — журнал доступу: выдачи и
 * отзывы этой методики из журнала аудита (если у читающего есть право его
 * читать).
 *
 * «Призначити» — в ящике рамки методики (MethodPage): людям поимённо или
 * группе пациентов, со сроком и комментарием. «Відкликати» — с
 * подтверждением окном.
 *
 * Чего здесь нет из макета и почему: «Нагадати» — у сервера нет напоминания
 * о назначении; балла и смуги в строке «пройдено» — список назначений их не
 * отдаёт (только признак и число попыток).
 */

type View = "all" | "open" | "late" | "done";

export default function Access() {
  const { id } = useParams<{ id: string }>();
  const res = useResource(
    async () => {
      // пациенты — не здесь: выбор ищет их на сервере сам (AssignDrawer, #174)
      const [survey, grants, groups, folders] = await Promise.all([
        api.survey(id!),
        api.grants(id!),
        api.groups().catch(() => null),
        api.surveyFolders().catch(() => null),
      ]);
      return { survey, grants, groups, folders };
    },
    [id],
    { enabled: !!id },
  );

  return (
    <Screen res={res}>
      {({ survey, grants, groups, folders }) => (
        <MethodPage
          survey={survey}
          groups={groups}
          folders={folders}
          tab="access"
          counts={{ access: grants.length }}
          grants={grants}
          onAssigned={res.reload}
        >
          <AccessBody
            surveyId={survey.id}
            title={survey.title}
            visibility={survey.visibility}
            group={groups?.find((g) => g.id === survey.groupId) ?? null}
            grants={grants}
            onChanged={res.reload}
          />
        </MethodPage>
      )}
    </Screen>
  );
}

function AccessBody({
  surveyId,
  title,
  visibility,
  group,
  grants,
  onChanged,
}: {
  surveyId: string;
  title: string;
  visibility: "public" | "restricted";
  group: { id: string; title: string; admins: { userId: string; fullName: string }[] } | null;
  grants: SurveyGrant[];
  onChanged: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const toast = useToast();
  const [view, setView] = useState<View>("all");
  const [q, setQ] = useState("");
  const [revoking, setRevoking] = useState<SurveyGrant | null>(null);
  /* отмеченные строки к отзыву и как снять с них отметку, когда отзыв прошёл */
  const [revokingMany, setRevokingMany] = useState<{ rows: SurveyGrant[]; clear: () => void } | null>(null);
  const now = useMemo(() => new Date(), []);
  const counts = grantCounts(grants, now);
  const first = nextExpiring(grants, now);
  const late = grants.filter((g) => grantState(g, now) === "late");
  const { code, name } = splitCode(title);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return grants.filter((g) => {
      const s = grantState(g, now);
      if (view === "open" && s === "done") return false;
      if (view === "late" && s !== "late") return false;
      if (view === "done" && s !== "done") return false;
      return !needle || `${g.fullName} ${g.email}`.toLowerCase().includes(needle);
    });
  }, [grants, view, q, now]);

  const setVisibility = (next: "public" | "restricted") => {
    if (next === visibility) return;
    void run(async () => {
      await api.updateSurvey(surveyId, { visibility: next });
      onChanged();
    }, next === "restricted" ? ut("mc.visSetRestricted") : ut("mc.visSetPublic"));
  };

  const passed = (g: SurveyGrant): ReactNode => {
    const s = grantState(g, now);
    if (s === "done") {
      return (
        <Tag tone="good" icon={<Ic.check />}>
          {g.attemptsAllowed && g.attemptsAllowed > 1
            ? ut("mc.accDoneAttempts").replace("{n}", String(g.attemptsUsed)).replace("{of}", String(g.attemptsAllowed))
            : ut("acc.yes")}
        </Tag>
      );
    }
    if (s === "late") {
      const days = Math.max(1, -dayDiff(now, new Date(g.expiresAt!)));
      return (
        <Tag tone="attention" icon={<ShellIcon name="hourglass" size={12} />}>
          {ut("mc.accLateDays").replace("{n}", String(days))}
        </Tag>
      );
    }
    if (s === "soon") {
      return (
        <Tag tone="attention" icon={<ShellIcon name="hourglass" size={12} />}>
          {dayDiff(now, new Date(g.expiresAt!)) <= 0 ? ut("mc.accEndsToday") : ut("mc.accEndsTomorrow")}
        </Tag>
      );
    }
    return <span className="text-small text-muted">{ut("mc.accNotYet")}</span>;
  };

  const tone = (s: GrantState) => (s === "late" || s === "soon" ? "font-bold text-warn" : "text-text-2");

  const columns: Column<SurveyGrant>[] = [
    {
      key: "patient",
      header: ut("acc.patient"),
      required: true,
      sort: (g) => g.fullName,
      render: (g) => <PersonCell name={g.fullName} sub={g.email} avatar={<Avatar name={g.fullName} size={28} />} to={`/patients/${g.userId}`} />,
    },
    {
      key: "by",
      header: ut("mc.accByWhen"),
      required: true,
      width: 200,
      sort: (g) => g.grantedAt,
      render: (g) =>
        g.grantedByName ? (
          <PersonCell name={g.grantedByName} sub={shortDateTime(g.grantedAt)} avatar={<Avatar name={g.grantedByName} size={28} tone="neutral" />} />
        ) : (
          <span className="flex flex-col">
            <span className="text-muted">{ut("mc.accBySystem")}</span>
            <small className="text-caption text-muted">{shortDateTime(g.grantedAt)}</small>
          </span>
        ),
    },
    {
      key: "until",
      header: ut("mc.accUntil"),
      required: true,
      width: 128,
      sort: (g) => g.expiresAt ?? "9999",
      render: (g) => {
        const s = grantState(g, now);
        return <span className={`whitespace-nowrap tabular-nums ${tone(s)}`}>{g.expiresAt ? shortDate(g.expiresAt) : ut("acc.forever")}</span>;
      },
    },
    {
      key: "passed",
      header: ut("acc.passed"),
      required: true,
      width: 190,
      sort: (g) => ({ late: 0, soon: 1, open: 2, done: 3 })[grantState(g, now)],
      render: passed,
    },
    {
      key: "note",
      header: ut("acc.comment"),
      required: true,
      render: (g) => (g.note ? <span className="text-small text-text-2">{g.note}</span> : <span className="text-muted">—</span>),
    },
  ];

  return (
    <>
      <div className="mb-4 grid grid-cols-3 items-stretch gap-4 max-[1180px]:grid-cols-2 max-[860px]:grid-cols-1">
        <Panel title={ut("mc.peekVisibility")} icon={<Ic.eye />}>
          <Segmented
            wide
            label={ut("mc.peekVisibility")}
            value={visibility}
            onChange={setVisibility}
            items={[
              { key: "public", label: ut("mc.visAll") },
              { key: "restricted", label: ut("mc.visAssigned") },
            ]}
          />
          <p className="m-0 mt-3 text-small text-text-2">
            {visibility === "restricted" ? ut("mc.visRestrictedHint") : ut("acc.publicHint")}
          </p>
        </Panel>
        <Panel
          title={ut("mc.accWho")}
          icon={<ShellIcon name="user-cog" />}
          actions={group ? <TextAction to={`/groups?id=${group.id}`}>{ut("f.group")}</TextAction> : undefined}
        >
          {group && group.admins.length ? (
            <div className="flex items-center gap-2.5">
              <span className="flex -space-x-1.5">
                {group.admins.slice(0, 3).map((a) => (
                  <Avatar key={a.userId} name={a.fullName} size={28} tone="soft" className="ring-2 ring-panel" />
                ))}
              </span>
              <span className="flex min-w-0 flex-col">
                <b className="truncate text-body font-extrabold text-text">{group.admins.map((a) => a.fullName).join(", ")}</b>
                <small className="truncate text-caption text-muted">{ut("mc.accAdminsOf").replace("{group}", group.title)}</small>
              </span>
            </div>
          ) : (
            <p className="m-0 text-small text-muted">{group ? ut("adm.noAdmins") : ut("mc.accNoGroup")}</p>
          )}
          <p className="m-0 mt-3 text-small text-text-2">{ut("mc.accWhoHint")}</p>
        </Panel>
        <Panel title={ut("mc.accNow")} icon={<ShellIcon name="clipboard-check" />}>
          <dl className="m-0">
            <NowRow title={ut("mc.accActive")} sub={counts.forever ? ut("mc.accForeverN").replace("{n}", String(counts.forever)) : null} value={counts.all - counts.late} />
            <NowRow
              title={ut("acc.passed")}
              sub={
                counts.all - counts.late
                  ? ut("mc.accShare").replace("{n}", String(Math.round((100 * counts.done) / (counts.all - counts.late))))
                  : null
              }
              value={counts.done}
            />
            <NowRow
              title={ut("mc.accLate")}
              sub={late.length ? late.slice(0, 2).map((g) => g.fullName).join(", ") + (late.length > 2 ? ` +${late.length - 2}` : "") : null}
              value={counts.late}
              warn={counts.late > 0}
            />
            <NowRow
              title={ut("mc.accExpiring")}
              sub={first ? ut("mc.accFirst").replace("{date}", shortDate(first.expiresAt!)).replace("{name}", first.fullName) : null}
              value={counts.expiring}
            />
          </dl>
        </Panel>
      </div>

      <Panel title={ut("acc.granted")} icon={<Ic.users />} count={grants.length} flush>
        <div className="px-4 pb-3">
          <FilterBar
            search={{ value: q, onChange: setQ, placeholder: ut("mc.accSearch"), width: 260 }}
            views={{
              value: view,
              onChange: (k) => setView(k as View),
              items: [
                { key: "all", label: ut("grp.filterAll"), count: counts.all },
                { key: "open", label: ut("mc.accViewOpen"), count: counts.open },
                { key: "late", label: ut("mc.accLate"), count: counts.late },
                { key: "done", label: ut("acc.passed"), count: counts.done },
              ],
            }}
          />
        </div>
        {grants.length === 0 ? (
          <div className="border-t border-divider">
            <Empty compact title={ut("acc.nobody")} hint={ut("mc.accNobodyHint").replace("{code}", code ?? name)} />
          </div>
        ) : rows.length === 0 ? (
          <div className="border-t border-divider px-4">
            <Empty compact title={ut("cat.emptySearch")} />
          </div>
        ) : (
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(g) => g.userId}
            label={ut("acc.granted")}
            initialSort={{ key: "passed" }}
            pageSize={10}
            selectable
            bulkActions={(picked, clear) => (
              <Button variant="panel" size="xs" icon={<Mi.userX />} disabled={busy} onClick={() => setRevokingMany({ rows: picked, clear })}>
                {ut("mc.accRevoke")}
              </Button>
            )}
            rowActions={(g) => (
              <Button size="xs" variant="ghost" icon={<Mi.userX />} disabled={busy} onClick={() => setRevoking(g)}>
                {ut("mc.accRevoke")}
              </Button>
            )}
          />
        )}
        <KbdHints
          bar
          keys={[
            ["X", ut("mc.keyPick")],
            ["A", ut("mc.keyAssign")],
            ["/", ut("mc.keySearch")],
            ["E", ut("mc.keyEdit")],
          ]}
        />
      </Panel>

      <AccessLog surveyId={surveyId} grants={grants} />

      {revoking ? (
        <Modal
          title={ut("mc.accRevokeTitle").replace("{code}", code ?? name).replace("{name}", revoking.fullName)}
          icon={<Mi.userX />}
          tone="warn"
          onClose={() => setRevoking(null)}
          footer={
            <>
              <Button
                variant="secondary"
                icon={<Mi.userX />}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.revoke(surveyId, revoking.userId);
                    setRevoking(null);
                    onChanged();
                  }, ut("mc.accRevoked"))
                }
              >
                {ut("mc.accRevoke")}
              </Button>
              <Button variant="quiet" onClick={() => setRevoking(null)}>
                {ut("ui.cancel")}
              </Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">{ut("mc.accRevokeText")}</p>
        </Modal>
      ) : null}
      {revokingMany ? (
        <Modal
          title={ut("mc.accRevokeManyTitle").replace("{code}", code ?? name).replace("{n}", String(revokingMany.rows.length))}
          icon={<Mi.userX />}
          tone="warn"
          onClose={() => setRevokingMany(null)}
          footer={
            <>
              <Button
                variant="secondary"
                icon={<Mi.userX />}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    /* каждому по очереди: отказ одному не отменяет остальных */
                    const { done, failed } = await eachOf(revokingMany.rows, (g) => api.revoke(surveyId, g.userId));
                    if (done.length) toast(ut("mc.accRevokedN").replace("{n}", String(done.length)), "ok");
                    if (failed.length) {
                      const names = failed.map((f) => f.item.fullName).join(", ");
                      toast(`${ut("mc.bulkFailed").replace("{n}", String(failed.length))}: ${names}`, "err");
                    }
                    revokingMany.clear();
                    setRevokingMany(null);
                    onChanged();
                  })
                }
              >
                {ut("mc.accRevoke")}
              </Button>
              <Button variant="quiet" onClick={() => setRevokingMany(null)}>
                {ut("ui.cancel")}
              </Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">{ut("mc.accRevokeText")}</p>
          <ul className="m-0 mt-3 flex max-h-48 list-none flex-col gap-1 overflow-y-auto p-0">
            {revokingMany.rows.map((g) => (
              <li key={g.userId} className="truncate text-small text-text">
                {g.fullName}
              </li>
            ))}
          </ul>
        </Modal>
      ) : null}
    </>
  );
}

/** Строка панели «Призначення зараз»: что, пояснение, число справа */
function NowRow({ title, sub, value, warn }: { title: string; sub: string | null; value: number; warn?: boolean }) {
  return (
    <div className="flex items-center gap-3 border-t border-divider py-2.5 first:border-t-0 first:pt-0">
      <dt className="min-w-0 flex-1">
        <span className="block text-body font-semibold text-text">{title}</span>
        {sub ? <small className="block truncate text-caption text-muted">{sub}</small> : null}
      </dt>
      <dd className={`m-0 text-[18px] font-extrabold tabular-nums ${warn ? "text-warn" : "text-text"}`}>{num(value)}</dd>
    </div>
  );
}

/** Действия журнала доступу методики: выдачи и отзывы */
export const ACCESS_LOG_ACTIONS = ["access.grant", "access.revoke"] as const;

/** Журнал доступу методики — восемь последних выдач и отзывов одним чтением; источник подменяется в проверке */
export function loadAccessLog(surveyId: string, src: Pick<typeof api, "auditPage"> = api): Promise<AuditEntry[]> {
  return src
    .auditPage({ actions: ACCESS_LOG_ACTIONS.join(","), resourceType: "survey", q: surveyId, limit: "8" })
    .then((p) => p.entries);
}

/**
 * Журнал доступу: выдачи и отзывы этой методики из журнала аудита.
 *
 * Журнал закрыт правом audit.read — у кого его нет, панели нет (а не пустой
 * панели «змін немає»). Поиск журнала по тексту ищет не дальше 31 дня (сервер,
 * routes/audit.ts), поэтому подпись так и говорит — «за 31 день».
 *
 * Одним чтением на оба действия (волна 27): прежде — два чтения, у каждого
 * свой счёт и своя строка audit.read на каждое открытие экрана. И только с
 * правом: без audit.read оба запроса были заведомым отказом — строкой
 * access.denied в журнале на каждое открытие, а панели не было всё равно.
 */
function AccessLog({ surveyId, grants }: { surveyId: string; grants: SurveyGrant[] }) {
  const { ut } = useLang();
  const { can } = useAuth();
  const canAudit = can("audit.read");
  const log = useResource(() => loadAccessLog(surveyId), [surveyId], { enabled: canAudit });

  if (!canAudit || log.error || !log.data) return null;
  const names = new Map<string, string>();
  for (const g of grants) {
    names.set(g.userId, g.fullName);
    if (g.grantedBy && g.grantedByName) names.set(g.grantedBy, g.grantedByName);
  }
  const who = (e: AuditEntry) => (e.actorId && names.get(e.actorId)) || e.actorEmail || ut("mc.accBySystem");
  const whom = (e: AuditEntry) =>
    (e.subjectUserId && names.get(e.subjectUserId)) || (typeof e.details?.patient === "string" ? e.details.patient : "");

  return (
    <div className="mt-4">
      <Panel
        title={ut("mc.accLog")}
        icon={<ShellIcon name="scroll-text" />}
        sub={ut("mc.accLogSub")}
        actions={<TextAction to="/ops/audit">{ut("mc.accLogAll")}</TextAction>}
        flush
      >
        {log.data.length ? (
          <ActivityList
            className="pb-1"
            events={log.data.map((e) => {
              const d = new Date(e.at);
              const until = typeof e.details?.expiresAt === "string" ? shortDate(e.details.expiresAt) : null;
              return {
                date: shortDate(e.at),
                time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
                icon: e.action === "access.revoke" ? <Mi.userX /> : <Mi.clipboardPlus />,
                text:
                  e.action === "access.revoke" ? (
                    <>
                      <b>{who(e)}</b> {ut("mc.accLogRevoked").replace("{name}", whom(e))}
                    </>
                  ) : (
                    <>
                      <b>{who(e)}</b>{" "}
                      {until
                        ? ut("mc.accLogGrantedUntil").replace("{name}", whom(e)).replace("{date}", until)
                        : ut("mc.accLogGranted").replace("{name}", whom(e))}
                    </>
                  ),
              };
            })}
          />
        ) : (
          <div className="px-4">
            <Empty compact title={ut("mc.accLogEmpty")} />
          </div>
        )}
      </Panel>
    </div>
  );
}
