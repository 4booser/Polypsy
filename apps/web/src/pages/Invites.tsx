import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import type { Battery, Invite, SurveyListItem } from "@quizzy/shared";
import { api } from "../api";
import { useAuth } from "../auth";
import { day } from "../format";
import { Avatar, Callout, DataTable, Empty, FilterBar, Loading, Modal, Screen, Tooltip, useAction, useUrlState, type Column } from "../ui";
import { cx } from "../ui/cx";
import { Ic } from "../ui/icons";
import { Panel } from "../ui/layout";
import { Button, Field, Input, Select, Tag } from "../ui/primitives";
import { useLang } from "../lang";
import { usePagedResource, useResource } from "../useResource";
import { listBody } from "../ui/paging";
import { StartHead } from "./Start";
import { fill } from "./dashboard/model";
import { Di } from "./today/icons";
import { hhmm } from "./today/model";
import {
  INVITE_VIEWS,
  inviteCounts,
  inviteState,
  isInviteView,
  joinedSince,
  placesLeft,
  shownInvites,
  type InviteView,
} from "./invites/model";

/** Строка справочника специалистов — ровно то, что нужно выпадающему списку */
type Specialist = { userId: string; fullName: string };

/** Только что созданное приглашение: ссылка живёт лишь до закрытия этой панели */
interface Fresh {
  token: string;
  code: string;
  bound: string | null;
  battery: boolean;
  unit: string | null;
  maxUses: number;
  ttlDays: number;
  specialist: string | null;
  at: string;
}

const VIEW_KEY: Record<InviteView, "invA.viewLive" | "invA.viewUsed" | "invA.viewExpired" | "invA.viewRevoked" | "invA.viewAll"> = {
  live: "invA.viewLive",
  used: "invA.viewUsed",
  expired: "invA.viewExpired",
  revoked: "invA.viewRevoked",
  all: "invA.viewAll",
};

/**
 * Запрошення — вход пациента по ссылке, QR или короткому коду (кадр
 * day-invites Polypsy 2.0): слева — только что созданное и список, справа —
 * форма нового.
 *
 * Токен показывается один раз при создании — в базе только хеш, и «посмотреть
 * ссылку ещё раз» невозможно намеренно. Код остаётся видимым: он для диктовки
 * по телефону и ввода руками, его перехват без пары email+пароль бесполезен.
 *
 * Изменить строк и лимит у выписанной ссылки сервер не умеет, и кнопки для
 * этого здесь нет; отозвать — можно, с подтверждением.
 */
export default function Invites() {
  const { ut } = useLang();
  const { user } = useAuth();
  const [fresh, setFresh] = useState<Fresh | null>(null);
  const [viewRaw, setView] = useUrlState("view");
  const [q, setQ] = useUrlState("q");
  const [wantsNew, setWantsNew] = useUrlState("new");
  const [revoking, setRevoking] = useState<Invite | null>(null);
  const { run, busy } = useAction();
  const formRef = useRef<HTMLDivElement>(null);

  /*
   * Выписанные ссылки — страницами: приглашения копятся годами. Справочники
   * формы грузятся отдельно и по-прежнему разом: их десятки.
   */
  const list = usePagedResource<Invite>((cursor) => api.invites(cursor), []);
  const rows = list.items;
  const reload = list.reload;
  const body = listBody(rows, list.error);
  const now = Date.now();
  const view: InviteView = isInviteView(viewRaw) ? viewRaw : "live";
  const counts = rows ? inviteCounts(rows, now) : null;
  const shown = rows ? shownInvites(rows, view, q, now) : [];

  /*
   * Справочники нужны только форме, и каждый падает молча по отдельности:
   * список выписанных ссылок важнее любого из них.
   */
  const res = useResource(async () => {
    const [batteries, surveys, specialists] = await Promise.all([
      api.batteries().then((b) => b.filter((x) => !x.archived)).catch(() => [] as Battery[]),
      api.surveys().then((r) => r.filter((x) => !x.archivedAt)).catch(() => [] as SurveyListItem[]),
      api.specialists().then((r) => r.items).catch(() => [] as Specialist[]),
    ]);
    return { batteries, surveys, specialists };
  }, []);

  /* «Створити запрошення» со зведення ведёт сюда с ?new=1 — сразу к форме */
  const focusForm = () => {
    formRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    formRef.current?.querySelector<HTMLElement>("select, input")?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (wantsNew && res.data) {
      focusForm();
      setWantsNew("");
    }
  }, [wantsNew, res.data]);

  const columns: Column<Invite>[] = [
    {
      key: "code",
      header: ut("inv.code"),
      required: true,
      sort: (r) => r.code,
      width: 170,
      render: (r) => (
        <span className="block min-w-0">
          <span className="font-mono text-[14px] font-bold tracking-[0.04em] text-text">{r.code}</span>
          {r.note ? <small className="block truncate text-caption text-muted">{r.note}</small> : null}
        </span>
      ),
    },
    {
      key: "bound",
      header: ut("inv.bound"),
      sort: (r) => r.batteryTitle ?? r.surveyTitle ?? "",
      render: (r) => (
        <span className="block min-w-0">
          {r.batteryTitle ?? r.surveyTitle ? (
            <b className="flex min-w-0 items-center gap-1.5 font-bold text-text">
              {r.batteryTitle ? <Ic.layers size={14} className="shrink-0 text-muted" /> : null}
              <span className="truncate">{r.batteryTitle ?? r.surveyTitle}</span>
            </b>
          ) : (
            <span className="text-text-2">{ut("inv.noBattery")}</span>
          )}
          <small className="block truncate text-caption text-muted">
            {[r.batteryTitle ? ut("invA.battery") : r.surveyTitle ? ut("invA.survey") : ut("invA.accessOnly"), r.unit].filter(Boolean).join(", ")}
          </small>
        </span>
      ),
    },
    {
      key: "uses",
      header: ut("inv.entries"),
      sort: (r) => r.usedCount,
      width: 230,
      render: (r) => {
        const state = inviteState(r, now);
        const left = state === "live" ? placesLeft(r) : null;
        return (
          <span className="block min-w-0 text-left">
            <span className="flex items-center gap-2.5">
              <b className="font-extrabold text-text tabular-nums">
                {r.usedCount}/{r.maxUses}
              </b>
              <span aria-hidden className="block h-1.5 w-[72px] overflow-hidden rounded-[3px] bg-track">
                <i
                  className={cx("block h-full rounded-[3px]", state !== "live" ? "bg-muted" : left !== null ? "bg-warn" : "bg-violet")}
                  style={{ width: `${Math.min(100, (r.usedCount / Math.max(1, r.maxUses)) * 100)}%` }}
                />
              </span>
            </span>
            <small className="block truncate text-caption text-muted">
              {r.uses.length
                ? r.uses.length > 2
                  ? `${r.uses
                      .slice(0, 2)
                      .map((u) => u.fullName)
                      .join(", ")}${fill(ut("dashA.andMore"), { n: r.uses.length - 2 })}`
                  : r.uses.map((u) => u.fullName).join(", ")
                : ut("invA.nobodyYet")}
            </small>
          </span>
        );
      },
    },
    {
      key: "expires",
      header: ut("inv.expires"),
      sort: (r) => r.revokedAt ?? r.expiresAt,
      width: 160,
      render: (r) => <ValidCell inv={r} now={now} fresh={fresh?.code === r.code} />,
    },
    {
      key: "by",
      header: ut("invA.who"),
      width: 64,
      sort: (r) => r.createdByName,
      render: (r) => (
        <Tooltip label={fill(ut("invA.createdBy"), { name: r.createdByName, d: day(r.createdAt) })}>
          <span tabIndex={0} role="img" aria-label={r.createdByName} className="inline-flex rounded-full">
            <Avatar name={r.createdByName} size={28} tone={user && r.createdByName === user.fullName ? "violet" : "neutral"} />
          </span>
        </Tooltip>
      ),
    },
  ];

  return (
    <>
      <StartHead
        meta={
          counts ? (
            <>
              <b className="font-extrabold text-text">{fill(ut("invA.liveN"), { n: counts.live })}</b>
              <span>{fill(ut("invA.joined30"), { n: joinedSince(rows ?? [], now) })}</span>
            </>
          ) : (
            <span>{ut("common.loading")}</span>
          )
        }
        actions={
          <Button variant="primary" icon={<Di.link />} onClick={focusForm}>
            {ut("inv.create")}
          </Button>
        }
      />
      <div className="grid grid-cols-[minmax(0,1fr)_380px] items-start gap-4 max-[1360px]:grid-cols-[minmax(0,1fr)_340px] max-[1080px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          {fresh ? <FreshInvite fresh={fresh} onClose={() => setFresh(null)} /> : null}

          {body.body === "failed" || body.body === "loading" ? (
            <Loading error={list.error} onRetry={list.reload} busy={list.loading} />
          ) : null}
          {/*
            Отказ поверх уже показанных ссылок — строкой с «повторити»
            (listBody в ui/paging.ts): отозванная ссылка не должна оставаться
            в списке живой, а «ще» — молча ничего не делать.
          */}
          {body.stale ? (
            <div role="alert" className="flex items-center gap-[10px]">
              <p className="m-0 min-w-0 flex-1 text-caption text-danger">{body.stale}</p>
              <Button variant="quiet" size="sm" onClick={list.reload}>
                {ut("common.retry")}
              </Button>
            </div>
          ) : null}
          {body.body === "empty" ? <Empty title={ut("inv.none")} hint={ut("inv.noneHint")} /> : null}

          {rows?.length ? (
            <Panel flush>
              <div className="px-4 pb-3 pt-3.5">
                <FilterBar
                  search={{ value: q, onChange: setQ, placeholder: ut("invA.searchPh") }}
                  views={{
                    items: INVITE_VIEWS.map((v) => ({ key: v, label: ut(VIEW_KEY[v]), count: counts?.[v] ?? null })),
                    value: view,
                    onChange: (k) => setView(k === "live" ? "" : k),
                    label: ut("invA.views"),
                  }}
                />
              </div>
              <DataTable
                rows={shown}
                columns={columns}
                rowKey={(r) => r.id}
                label={ut("inv.title")}
                initialSort={{ key: "expires" }}
                isRowActive={(r) => fresh?.code === r.code}
                empty={<Empty compact title={ut("invA.noneInView")} />}
                rowActions={(r) =>
                  inviteState(r, now) === "live" ? (
                    <>
                      <Tooltip label={ut("inv.copyCode")}>
                        <Button
                          variant="quiet"
                          size="icon-sm"
                          aria-label={ut("inv.copyCode")}
                          onClick={() => run(async () => navigator.clipboard.writeText(r.code), ut("inv.codeCopied"))}
                        >
                          <Di.copy />
                        </Button>
                      </Tooltip>
                      <Tooltip label={ut("inv.revoke")}>
                        <Button variant="quiet" size="icon-sm" aria-label={ut("inv.revoke")} onClick={() => setRevoking(r)}>
                          <Ic.ban />
                        </Button>
                      </Tooltip>
                    </>
                  ) : null
                }
              />
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-divider px-4 py-2.5 text-caption text-text-2">
                <span>{fill(ut("invA.shown"), { n: shown.length, of: list.total ?? rows.length })}</span>
                <span className="ml-auto inline-flex items-center gap-1.5 text-muted">
                  <Ic.info size={13} />
                  {ut("invA.linkOnce")}
                </span>
              </div>
            </Panel>
          ) : null}
          {list.hasMore ? (
            <div className="flex justify-center">
              <Button variant="ghost" disabled={list.loadingMore} onClick={list.loadMore}>
                {list.loadingMore ? ut("ui.loadingMore") : ut("ui.loadMore")}
              </Button>
            </div>
          ) : null}
        </div>

        <div ref={formRef} className="sticky top-4 min-w-0 max-[1080px]:static">
          <Screen res={res} rows={4}>
            {({ batteries, surveys, specialists }) => (
              <InviteForm
                batteries={batteries}
                surveys={surveys}
                specialists={specialists}
                me={user?.fullName ?? ""}
                onCreated={(t) => {
                  setFresh(t);
                  setView("");
                  reload();
                }}
              />
            )}
          </Screen>
        </div>
      </div>

      {revoking ? (
        <Modal
          title={fill(ut("invA.revokeTitle"), { code: revoking.code })}
          sub={revoking.batteryTitle ?? revoking.surveyTitle ?? ut("inv.noBattery")}
          icon={<Ic.ban />}
          onClose={() => setRevoking(null)}
          footer={
            <>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api.revokeInvite(revoking.id);
                    setRevoking(null);
                    await reload();
                  }, ut("inv.revoked"))
                }
              >
                {ut("inv.revoke")}
              </Button>
              <Button variant="quiet" onClick={() => setRevoking(null)}>
                {ut("invA.keep")}
              </Button>
            </>
          }
        >
          <p className="m-0 text-body text-text-2">
            {fill(ut("invA.revokeText"), { used: revoking.usedCount, max: revoking.maxUses })}
          </p>
        </Modal>
      ) : null}
    </>
  );
}

/** «Діє до» и состояние словом: діє, лишилось N місць, вичерпано, строк вийшов, відкликано */
function ValidCell({ inv, now, fresh }: { inv: Invite; now: number; fresh: boolean }) {
  const { ut } = useLang();
  const state = inviteState(inv, now);
  const left = state === "live" ? placesLeft(inv) : null;
  return (
    <span className="block">
      <span className={cx("block whitespace-nowrap font-bold tabular-nums", state === "live" ? "text-text" : "text-text-2")}>
        {state === "revoked" && inv.revokedAt ? fill(ut("invA.revokedOn"), { d: day(inv.revokedAt) }) : day(inv.expiresAt)}
      </span>
      <span className="mt-1 block">
        {fresh ? (
          <Tag tone="primary" icon={<Ic.sparkle />}>
            {ut("invA.justCreated")}
          </Tag>
        ) : state === "live" ? (
          left !== null ? (
            <Tag tone="attention" icon={<Ic.circleAlert />}>
              {fill(ut("invA.placesLeft"), { n: left })}
            </Tag>
          ) : (
            <Tag tone="good" icon={<Ic.check />}>
              {ut("invA.stateLive")}
            </Tag>
          )
        ) : state === "used" ? (
          <Tag tone="done">{ut("invA.stateUsed")}</Tag>
        ) : state === "expired" ? (
          <Tag tone="attention" icon={<Di.clockAlert />}>
            {ut("invA.stateExpired")}
          </Tag>
        ) : (
          <Tag tone="done" icon={<Ic.ban />}>
            {ut("inf.revoked")}
          </Tag>
        )}
      </span>
    </span>
  );
}

function InviteForm({
  batteries,
  surveys,
  specialists,
  me,
  onCreated,
}: {
  batteries: Battery[];
  surveys: SurveyListItem[];
  specialists: Specialist[];
  me: string;
  onCreated: (t: Fresh) => void;
}) {
  const { ut } = useLang();
  /*
   * Набор ИЛИ методика, и это видно по форме: выбор одного гасит другой.
   * «Набор и ещё одна методика» дало бы назначение, состав которого не виден
   * ни из приглашения, ни из карты, — сервер такое и не примет.
   */
  const [batteryId, setBatteryId] = useState("");
  const [surveyId, setSurveyId] = useState("");
  const [specialistId, setSpecialistId] = useState("");
  const [unit, setUnit] = useState("");
  const [note, setNote] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [ttlDays, setTtlDays] = useState(14);
  const { run, busy } = useAction();
  const battery = batteries.find((b) => b.id === batteryId);
  const until = day(new Date(Date.now() + ttlDays * 86_400_000).toISOString());
  const clear = () => {
    setBatteryId("");
    setSurveyId("");
    setSpecialistId("");
    setUnit("");
    setNote("");
    setMaxUses(1);
    setTtlDays(14);
  };

  return (
    <Panel
      title={ut("invA.newTitle")}
      icon={<Di.link />}
      footer={
        <>
          <Button
            variant="primary"
            icon={<Di.link />}
            disabled={busy}
            onClick={() =>
              run(async () => {
                const res = await api.createInvite({
                  batteryId: batteryId || null,
                  surveyId: surveyId || null,
                  specialistId: specialistId || null,
                  unit: unit || null,
                  note: note || null,
                  maxUses,
                  ttlDays,
                });
                onCreated({
                  token: res.token,
                  code: res.code,
                  bound: battery?.title ?? surveys.find((s) => s.id === surveyId)?.title ?? null,
                  battery: !!battery,
                  unit: unit || null,
                  maxUses,
                  ttlDays,
                  specialist: specialists.find((p) => p.userId === specialistId)?.fullName ?? (me || null),
                  at: new Date().toISOString(),
                });
                clear();
              }, ut("inv.created"))
            }
          >
            {ut("inv.createSubmit")}
          </Button>
          <Button variant="quiet" onClick={clear}>
            {ut("invA.clear")}
          </Button>
        </>
      }
    >
      <p className="m-0 -mt-1 mb-3.5 text-small text-text-2">{ut("invA.formLead")}</p>
      <div className="flex flex-col gap-3.5">
        <Field
          label={ut("inv.batteryOnRegister")}
          hint={battery ? fill(ut("invA.batteryHint"), { list: battery.items.map((i) => i.title).join(", ") }) : undefined}
        >
          <Select
            value={batteryId}
            onChange={(e) => {
              setBatteryId(e.target.value);
              if (e.target.value) setSurveyId("");
            }}
          >
            <option value="">{ut("inv.noBatteryHint")}</option>
            {batteries.map((b) => (
              <option key={b.id} value={b.id}>
                {b.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={ut("inv.surveyOnRegister")} optional>
          <Select
            value={surveyId}
            onChange={(e) => {
              setSurveyId(e.target.value);
              if (e.target.value) setBatteryId("");
            }}
          >
            <option value="">{ut("inv.noSurveyHint")}</option>
            {surveys.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </Select>
        </Field>
        {/*
          Врач, за которым закрепится пришедший. По умолчанию — тот, кто
          выписывает: ссылку под случай выписывают себе.
        */}
        <Field label={ut("inv.specialist")}>
          <Select value={specialistId} onChange={(e) => setSpecialistId(e.target.value)}>
            <option value="">{me ? fill(ut("invA.me"), { name: me }) : ut("inv.specialistMe")}</option>
            {specialists.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.fullName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={ut("ui.unit")} optional>
          <Input value={unit} onChange={(e) => setUnit(e.target.value)} placeholder={ut("inv.unitToAccount")} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={ut("inv.uses")}>
            <Input
              type="number"
              min={1}
              max={500}
              value={maxUses}
              suffix={ut("invA.people")}
              onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))}
            />
          </Field>
          <Field label={ut("inv.days")}>
            <Input
              type="number"
              min={1}
              max={365}
              value={ttlDays}
              suffix={fill(ut("invA.until"), { d: until })}
              onChange={(e) => setTtlDays(Math.max(1, Number(e.target.value) || 1))}
            />
          </Field>
        </div>
        <Field label={ut("invA.note")} optional hint={ut("invA.noteHint")}>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={ut("inv.reasonExample")} />
        </Field>
        <Callout kind="info">{ut("inv.groupHint")}</Callout>
      </div>
    </Panel>
  );
}

/** Показ ссылки и QR один раз после создания */
function FreshInvite({ fresh, onClose }: { fresh: Fresh; onClose: () => void }) {
  const { ut } = useLang();
  const url = `${location.origin}/join/${fresh.token}`;
  const { run } = useAction();

  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [url]);
  const until = day(new Date(Date.parse(fresh.at) + fresh.ttlDays * 86_400_000).toISOString());

  return (
    <Panel
      title={ut("inv.ready")}
      icon={<Ic.circleCheck />}
      tone="good"
      sub={[fill(ut("invA.createdAt"), { t: hhmm(fresh.at) }), fresh.unit].filter(Boolean).join(", ")}
    >
      <div className="flex flex-wrap items-start gap-5">
        {/*
          biome-ignore lint/security/noDangerouslySetInnerHtml: SVG кода собирается
          здесь же из ссылки, никакие внешние данные в разметку не попадают
        */}
        <div className="w-[150px] shrink-0 overflow-hidden rounded-[12px] border border-border" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="flex min-w-[280px] flex-1 flex-col gap-3">
          <div className="flex flex-wrap gap-1.5">
            {fresh.bound ? (
              <Tag tone="primary" icon={fresh.battery ? <Ic.layers /> : undefined}>
                {fresh.bound}
              </Tag>
            ) : null}
            {fresh.unit ? <Tag>{fresh.unit}</Tag> : null}
            <Tag>{fill(ut("invA.entriesOf"), { n: 0, of: fresh.maxUses })}</Tag>
            <Tag>{fill(ut("invA.validTo"), { d: until })}</Tag>
            {fresh.specialist ? <Tag>{fill(ut("invA.boundTo"), { name: fresh.specialist })}</Tag> : null}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_200px] gap-3 max-[1360px]:grid-cols-1">
            <Field label={ut("inv.link")}>
              <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-small" />
            </Field>
            <Field label={ut("inv.manualCode")}>
              <Input readOnly value={fresh.code} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[17px] font-bold tracking-[0.08em]" />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" icon={<Di.copy />} onClick={() => run(async () => navigator.clipboard.writeText(url), ut("inv.linkCopied"))}>
              {ut("inv.copyLink")}
            </Button>
            <Button icon={<Di.copy />} onClick={() => run(async () => navigator.clipboard.writeText(fresh.code), ut("inv.codeCopied"))}>
              {ut("inv.copyCode")}
            </Button>
            <Button icon={<Di.printer />} onClick={() => window.print()}>
              {ut("inv.printQr")}
            </Button>
            <Button variant="quiet" icon={<Di.eyeOff />} onClick={onClose}>
              {ut("f.hide")}
            </Button>
          </div>
          <Callout kind="violet">{ut("inv.linkWarning")}</Callout>
        </div>
      </div>
    </Panel>
  );
}
