import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { SurveyFolder, SurveyFull, SurveyGrant, SurveyGroupWithCounts } from "@quizzy/shared";
import { api, download } from "../../api";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import { ShellIcon } from "../../shell/icons";
import { Modal, useAction } from "../../ui";
import { Ic } from "../../ui/icons";
import { useHotkeys } from "../../ui/keys";
import { Page } from "../../ui/layout";
import { ActionMenu, type MenuEntry } from "../../ui/menu";
import { Button, ButtonLink, ChoiceCard, Tabs, Tag } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { testsHref } from "../analytics/tests/model";
import { ArchiveDialog } from "./ArchiveDialog";
import { AssignDrawer, type ExistingAssignment } from "./AssignDrawer";
import { ExportsDrawer } from "./ExportsDrawer";
import { Mi } from "./icons";
import { rightsKey } from "./labels";
import { grantState, shortDate, splitCode } from "./model";
import { useCount } from "./useCount";

/*
 * Рамка экрана методики (methods-method, methods-access, methods-norms):
 * код крупно, имя и строка состава за линией, «Правити» (E), «Призначити»
 * (A) и меню; ниже — паспорт строкой (состояние, группа и папка,
 * видимость, права, ключи) и вкладки методики.
 *
 * Вкладки «Шкали … Проходження» ведут во вкладку «Тести» аналитики — там
 * эти виды живут (pages/analytics/tests); «Огляд», «Доступ» и «Норми» —
 * здесь. Действия меню и ящики (призначення, вивантаження, зняття) —
 * общие для всех трёх экранов.
 */

export type MethodTab = "overview" | "access" | "norms";

/** Паспорт методики, которого нет в SurveyFull по типу: сервер его отдаёт (lib/surveys.ts, getSurvey) */
type WithKeys = SurveyFull & { keysVerifiedAt?: string | null };

export function MethodPage({
  survey,
  groups,
  folders,
  tab,
  counts,
  grants,
  responseCount,
  assignPrimary = true,
  onAssigned,
  leadAction,
  children,
}: {
  survey: WithKeys;
  groups: SurveyGroupWithCounts[] | null;
  folders: SurveyFolder[] | null;
  tab: MethodTab;
  counts?: { access?: number | null; responses?: number | null; quality?: number | null };
  /** Назначения, если экран их уже загрузил: ящик скажет, у кого они есть */
  grants?: SurveyGrant[] | null;
  /** Собранных проходжень — для окна «Зняти з використання» */
  responseCount?: number | null;
  /** «Призначити» — основная кнопка (на «Нормах» основная — публикация) */
  assignPrimary?: boolean;
  onAssigned?: () => void;
  /** Своя кнопка перед «Правити» — «Заповнити за пацієнта» на огляді */
  leadAction?: ReactNode;
  children: ReactNode;
}) {
  const { ut } = useLang();
  const count = useCount();
  const navigate = useNavigate();
  const { run } = useAction();
  const [drawer, setDrawer] = useState<"assign" | "exports" | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [rightsOpen, setRightsOpen] = useState(false);
  const { user } = useAuth();

  const id = survey.id;
  const { code, name } = splitCode(survey.title);
  const asked = survey.questions.filter((q) => q.type !== "info").length;
  const group = groups?.find((g) => g.id === survey.groupId) ?? null;
  const folder = folders?.find((f) => f.id === survey.folderId) ?? null;
  const retired = !!survey.archivedAt;
  const clinician = survey.administration === "clinician";
  const canAssign = !retired && !clinician && survey.status === "published";

  /* назначения — только когда открыт ящик и экран их не принёс: право assignments.manage есть не у всех */
  const ownGrants = useResource(() => api.grants(id).catch(() => [] as SurveyGrant[]), [id], {
    enabled: drawer === "assign" && grants === undefined,
  });
  const existing = useMemo(() => {
    const list = grants ?? ownGrants.data ?? [];
    const now = new Date();
    return new Map<string, ExistingAssignment>(
      list
        .filter((g) => grantState(g, now) !== "late")
        .map((g) => [g.userId, { until: g.expiresAt, done: g.completed }] as const),
    );
  }, [grants, ownGrants.data]);

  useHotkeys({
    e: () => navigate(`/constructor/${id}`),
    a: () => {
      if (canAssign) setDrawer("assign");
    },
  });

  const sub = [count(asked, "items"), survey.scales.length ? count(survey.scales.length, "scales") : null].filter(Boolean).join(", ");

  const rights = rightsKey(survey.rightsStatus);
  const facts: ReactNode[] = [
    survey.status === "published" && !retired ? (
      <Tag key="st" tone="good" icon={<Ic.check />}>
        {ut("mc.factPublished").replace("{n}", String(survey.versionNumber))}
      </Tag>
    ) : retired ? (
      <Tag key="st" tone="done" icon={<Ic.archive />}>
        {ut("mark.retired")}
      </Tag>
    ) : (
      <Tag key="st" tone="primary" icon={<ShellIcon name="file-pen-line" size={12} />}>
        {ut("mc.factDraft")}
      </Tag>
    ),
    survey.isDemo ? (
      <Tag key="demo" tone="attention">
        {ut("mark.demo")}
      </Tag>
    ) : null,
    group ? (
      <Fact key="grp" icon={<Mi.folder size={15} />}>
        {folder ? `${group.title}, «${folder.title}»` : group.title}
      </Fact>
    ) : null,
    <Fact key="vis" icon={survey.visibility === "restricted" ? <Ic.lock size={15} /> : <Mi.globe size={15} />}>
      {survey.visibility === "restricted" ? ut("mc.visRestricted") : ut("mc.visPublic")}
    </Fact>,
    clinician ? (
      <Fact key="adm" icon={<ShellIcon name="stethoscope" size={15} />}>
        {ut("bt.byClinician")}
      </Fact>
    ) : null,
    rights ? (
      <Fact key="rights" icon={<Mi.scale size={15} />}>
        {ut(rights)}
      </Fact>
    ) : (
      <Fact key="rights" icon={<Mi.scale size={15} />} warn>
        {ut("cl.rightsUnclear")}
      </Fact>
    ),
    !survey.scoringEnabled ? (
      <Fact key="keys" icon={<ShellIcon name="key-round" size={15} />}>
        {ut("cat.scoringOff")}
      </Fact>
    ) : survey.keysVerifiedAt ? (
      <Fact key="keys" icon={<ShellIcon name="badge-check" size={15} />}>
        {`${ut("cat.keysVerified")} ${shortDate(survey.keysVerifiedAt)}`}
      </Fact>
    ) : (
      <Fact key="keys" icon={<ShellIcon name="key-round" size={15} />} warn>
        {ut("cat.keysUnverified")}
      </Fact>
    ),
  ].filter(Boolean);

  const tabs = [
    { to: `/surveys/${id}`, label: ut("ant.viewOverview"), end: true },
    { to: testsHref(id, { view: "scales" }), label: ut("mc.tabScales"), count: survey.scales.length || null },
    { to: testsHref(id, { view: "questions" }), label: ut("mc.tabItems"), count: asked || null },
    { to: testsHref(id, { view: "time" }), label: ut("mc.tabTime") },
    { to: testsHref(id, { view: "quality" }), label: ut("mc.tabQuality"), count: counts?.quality ?? null },
    { to: testsHref(id, { view: "responses" }), label: ut("mc.tabResponses"), count: counts?.responses ?? null },
    { to: `/surveys/${id}/access`, label: ut("mc.tabAccess"), count: counts?.access ?? null },
    { to: `/surveys/${id}/norms`, label: ut("sn.norms") },
  ];

  const menu: MenuEntry[] = [
    { label: ut("mc.menuExports"), icon: <Mi.fileDown size={16} />, onSelect: () => setDrawer("exports") },
    { label: ut("mc.menuBlank"), icon: <Mi.printer size={16} />, to: `/surveys/${id}/blank` },
    { label: ut("mc.menuKeys"), icon: <ShellIcon name="key-round" size={16} />, to: `/surveys/${id}/key` },
    ...(!retired && survey.status === "published"
      ? [{ label: ut("mc.menuAdminister"), icon: <Ic.keyboard size={16} />, to: `/surveys/${id}/administer` }]
      : []),
    {
      label: ut("cl.duplicateAction"),
      icon: <Mi.copy size={16} />,
      onSelect: () =>
        void run(async () => {
          const copy = await api.duplicateSurvey(id);
          navigate(`/constructor/${copy.id}`);
        }),
    },
    {
      label: ut("key.exportJson"),
      icon: <Mi.fileJson size={16} />,
      onSelect: () => void run(() => download(api.methodologyUrl(id), "methodology.json")),
    },
    /* права на текст правит только суперадмин (PATCH /api/surveys/:id/rights) */
    ...(user?.role === "superadmin"
      ? [{ label: ut("mc.menuRights"), icon: <Mi.scale size={16} />, onSelect: () => setRightsOpen(true) }]
      : []),
    retired
      ? {
          label: ut("cl.restoreAction"),
          icon: <Mi.archiveRestore size={16} />,
          ruled: true,
          onSelect: () =>
            void run(async () => {
              await api.restoreSurvey(id);
              navigate(0);
            }, ut("cl.restored")),
        }
      : { label: ut("cl.archive"), icon: <Ic.archive size={16} />, ruled: true, onSelect: () => setArchiving(true) },
  ];

  return (
    <Page
      back={{ to: "/surveys", label: ut("mc.backCatalog") }}
      title={code ?? name}
      meta={code ? [name, sub] : sub}
      actions={
        <>
          {leadAction}
          <ButtonLink to={`/constructor/${id}`} variant="secondary" title={ut("mc.editHint")}>
            <ShellIcon name="pencil" size={16} />
            {ut("cl.editAction")}
          </ButtonLink>
          {canAssign ? (
            <Button
              variant={assignPrimary ? "primary" : "secondary"}
              icon={<Mi.clipboardPlus />}
              aria-expanded={drawer === "assign"}
              onClick={() => setDrawer("assign")}
              title={ut("mc.assignHint")}
            >
              {ut("acc.grant")}
            </Button>
          ) : null}
          <ActionMenu
            label={ut("mc.menuLabel")}
            entries={menu}
            triggerSize="icon"
            triggerClassName="bg-violet-tint hover:bg-violet-tint-2"
            plateClassName="min-w-[260px]"
          />
        </>
      }
      below={
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-small text-text-2">{facts}</div>
          <Tabs label={ut("mc.methodTabs")} items={tabs} />
        </>
      }
    >
      {children}
      <AssignDrawer
        key={id}
        open={drawer === "assign"}
        onClose={() => setDrawer(null)}
        onReturn={() => setDrawer("assign")}
        title={ut("mc.assignTitle").replace("{code}", code ?? name)}
        sub={code ? `${name}, ${ut("ant.versionN").replace("{n}", String(survey.versionNumber))}` : ut("ant.versionN").replace("{n}", String(survey.versionNumber))}
        note={ut("mc.assignNote").replace("{items}", count(asked, "items"))}
        draftName={ut("mc.assignDraft").replace("{code}", code ?? name)}
        existing={existing}
        assignOne={(userId, due, note) => api.grant(id, userId, note ?? undefined, due)}
        assignGroup={(groupId, due, note) =>
          api.assignSurveyToPatientGroup(groupId, { surveyId: id, expiresAt: due, note })
        }
        onAssigned={() => {
          void ownGrants.reload();
          onAssigned?.();
        }}
      />
      <ExportsDrawer
        open={drawer === "exports"}
        onClose={() => setDrawer(null)}
        surveyId={id}
        sub={ut("mc.exSub").replace("{code}", code ?? name)}
        scope={responseCount !== undefined && responseCount !== null ? `${code ?? name}, ${count(responseCount, "responses")}` : undefined}
      />
      {rightsOpen ? (
        <RightsDialog
          surveyId={id}
          title={code ?? name}
          current={survey.rightsStatus ?? "unclear"}
          onClose={() => setRightsOpen(false)}
          onSaved={() => {
            setRightsOpen(false);
            navigate(0);
          }}
        />
      ) : null}
      {archiving ? (
        <ArchiveDialog
          survey={{ id, title: survey.title, versionNumber: survey.versionNumber, responseCount: responseCount ?? 0 }}
          onClose={() => setArchiving(false)}
          onDone={() => {
            setArchiving(false);
            navigate("/surveys/retired");
          }}
        />
      ) : null}
    </Page>
  );
}

/** Одна позиция паспорта: значок и текст; `warn` — янтарём (не сверено, не выяснено) */
export function Fact({ icon, children, warn }: { icon: ReactNode; children: ReactNode; warn?: boolean }) {
  return (
    <span className={warn ? "inline-flex items-center gap-1.5 whitespace-nowrap font-bold text-warn" : "inline-flex items-center gap-1.5 whitespace-nowrap"}>
      <span className={warn ? "inline-flex" : "inline-flex text-muted"}>{icon}</span>
      {children}
    </span>
  );
}

type Rights = "own" | "licensed" | "public_domain" | "unclear";

/**
 * Права на текст методики — окно суперадмина. От прав зависит, можно ли
 * применять методику клинически: «не з’ясовано» оставляет пометку в каталоге
 * и в строке внимания.
 */
function RightsDialog({
  surveyId,
  title,
  current,
  onClose,
  onSaved,
}: {
  surveyId: string;
  title: string;
  current: Rights;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const [value, setValue] = useState<Rights>(current);
  const options: [Rights, Parameters<typeof ut>[0], Parameters<typeof ut>[0]][] = [
    ["own", "mc.rightsOwn", "mc.rightsOwnSub"],
    ["licensed", "mc.rightsLicensed", "mc.rightsLicensedSub"],
    ["public_domain", "mc.rightsPublic", "mc.rightsPublicSub"],
    ["unclear", "cl.rightsUnclear", "mc.rightsUnclearSub"],
  ];
  return (
    <Modal
      title={ut("mc.rightsTitle").replace("{code}", title)}
      icon={<Mi.scale />}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="primary"
            disabled={busy || value === current}
            onClick={() =>
              void run(async () => {
                await api.surveyRights(surveyId, { rightsStatus: value });
                onSaved();
              }, ut("mc.rightsSaved"))
            }
          >
            {ut("ui.save")}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            {ut("ui.cancel")}
          </Button>
        </>
      }
    >
      <p className="m-0 mb-3 text-body text-text-2">{ut("mc.rightsText")}</p>
      <div role="radiogroup" aria-label={ut("mc.menuRights")} className="flex flex-col gap-1.5">
        {options.map(([key, label, sub]) => (
          <ChoiceCard
            key={key}
            name="survey-rights"
            value={key}
            checked={value === key}
            onChange={(v) => setValue(v as Rights)}
            title={ut(label)}
            sub={ut(sub)}
          />
        ))}
      </div>
    </Modal>
  );
}
