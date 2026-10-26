import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import qrcode from "qrcode-generator";
import { LOCALE_OF, instrumentCode, type Battery, type SurveyListItem } from "@quizzy/shared";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { useLang } from "../../lang";
import { Callout, Ic, KV, Modal, useAction } from "../../ui";
import { Button, Field, Input, Segmented, Select } from "../../ui/primitives";
import { useResource } from "../../useResource";
import { ShellIcon } from "../../shell/icons";
import { ddmm } from "./model";

/*
 * «Запросити пацієнта» из реестра — окно, а не ящик: шаг короткий и
 * заканчивается тем, что второй раз не показать (кадры patients-invite и
 * patients-invite-ready). Форма — та же, что на «Сьогодні → Запрошення»
 * (pages/Invites.tsx): набор ИЛИ методика ИЛИ ничего, ведущий, подразделение,
 * сколько входов и сколько дней, заметка для персонала.
 *
 * Справа — что получит пациент: от этого вопроса и выбирают набор.
 * После создания ссылка показывается один раз (в базе только её
 * отпечаток), поэтому окно готового приглашения не закрывается подложкой.
 */

type Assign = "battery" | "survey" | "none";

/** Строка справочника специалистов — ровно то, что нужно выпадающему списку */
type Specialist = { userId: string; fullName: string };

export function InviteDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [fresh, setFresh] = useState<{ token: string; code: string; summary: Summary } | null>(null);
  return fresh ? (
    <ReadyDialog
      {...fresh}
      onClose={onClose}
      onAnother={() => setFresh(null)}
    />
  ) : (
    <FormDialog
      onClose={onClose}
      onCreated={(t) => {
        setFresh(t);
        onCreated();
      }}
    />
  );
}

interface Summary {
  what: string;
  who: string;
  until: string;
  uses: number;
  unit: string | null;
}

function Stepper({
  value,
  onChange,
  min,
  max,
  label,
}: {
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  label: string;
}) {
  const { ut } = useLang();
  const clamp = (n: number) => Math.min(max, Math.max(min, Number.isFinite(n) ? Math.round(n) : min));
  return (
    <div className="flex h-10 items-center rounded-control border border-field-border bg-panel">
      <Button
        variant="quiet"
        size="icon"
        aria-label={`${label}: ${ut("inv2.less")}`}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - 1))}
      >
        <Ic.minus />
      </Button>
      <input
        type="number"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        className="h-full min-h-0 w-full min-w-0 border-0 bg-transparent p-0 text-center text-body font-extrabold tabular-nums text-text outline-none [appearance:textfield] focus-visible:outline-none [&::-webkit-inner-spin-button]:appearance-none"
      />
      <Button
        variant="quiet"
        size="icon"
        aria-label={`${label}: ${ut("inv2.more")}`}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + 1))}
      >
        <Ic.plus />
      </Button>
    </div>
  );
}

function FormDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (t: { token: string; code: string; summary: Summary }) => void;
}) {
  const { ut, lang } = useLang();
  const locale = LOCALE_OF[lang];
  const { user } = useAuth();
  const { run, busy } = useAction();
  /*
   * Справочники формы падают по отдельности и молча: отказ в правах на
   * методики (их видит не всякий, кто выписывает приглашения) не должен
   * закрывать форму целиком — останется «Нічого», то есть доступ.
   */
  const refs = useResource(async () => {
    const [batteries, surveys, specialists] = await Promise.all([
      api.batteries().then((b) => b.filter((x) => !x.archived)).catch(() => [] as Battery[]),
      api.surveys().then((r) => r.filter((x) => x.status === "published" && !x.archivedAt)).catch(() => [] as SurveyListItem[]),
      api.specialists().then((r) => r.items).catch(() => [] as Specialist[]),
    ]);
    return { batteries, surveys, specialists };
  }, []);
  const batteries = refs.data?.batteries ?? [];
  const surveys = refs.data?.surveys ?? [];
  const specialists = (refs.data?.specialists ?? []).filter((s) => s.userId !== user?.id);

  const [assign, setAssign] = useState<Assign>("battery");
  const [batteryId, setBatteryId] = useState("");
  const [surveyId, setSurveyId] = useState("");
  const [specialistId, setSpecialistId] = useState("");
  const [unit, setUnit] = useState("");
  const [note, setNote] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [ttlDays, setTtlDays] = useState(14);

  const battery = batteries.find((b) => b.id === batteryId) ?? null;
  const survey = surveys.find((s) => s.id === surveyId) ?? null;
  const until = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + ttlDays);
    return d.toISOString();
  }, [ttlDays]);
  const untilText = `${new Date(until).toLocaleDateString(locale, { weekday: "short" })} ${ddmm(until, locale)}`;
  const specialistName = specialistId ? (specialists.find((s) => s.userId === specialistId)?.fullName ?? "") : ut("inv2.me");
  const items = assign === "battery" ? (battery?.items ?? []) : assign === "survey" && survey ? [{ surveyId: survey.id, title: survey.title }] : [];
  const missing = (assign === "battery" && !batteryId) || (assign === "survey" && !surveyId);

  const create = () =>
    run(async () => {
      const res = await api.createInvite({
        batteryId: assign === "battery" ? batteryId || null : null,
        surveyId: assign === "survey" ? surveyId || null : null,
        specialistId: specialistId || null,
        unit: unit.trim() || null,
        note: note.trim() || null,
        maxUses,
        ttlDays,
      });
      onCreated({
        token: res.token,
        code: res.code,
        summary: {
          what:
            assign === "battery" && battery
              ? `${ut("inv2.battery").toLowerCase()} «${battery.title}»`
              : assign === "survey" && survey
                ? `${ut("inv2.survey").toLowerCase()} «${survey.title}»`
                : ut("inv2.accessOnly"),
          who: specialistName,
          until: untilText,
          uses: maxUses,
          unit: unit.trim() || null,
        },
      });
    }, ut("inv.created"));

  return (
    <Modal
      title={ut("pg.invite")}
      sub={ut("inv2.sub")}
      icon={<ShellIcon name="user-plus" />}
      width={780}
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" icon={<Ic.external />} disabled={busy || missing} onClick={() => void create()}>
            {ut("inv.create")}
          </Button>
          <Button onClick={onClose}>{ut("common.cancel")}</Button>
          <Link to="/invites" className="ml-auto inline-flex items-center gap-1.5 text-small font-bold text-violet-ink no-underline hover:underline">
            <Ic.list size={15} />
            {ut("inv2.all")}
          </Link>
        </>
      }
    >
      <div className="grid gap-5 [grid-template-columns:minmax(0,1fr)_248px] max-[760px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-3.5">
          <div>
            <span className="mb-1.5 block text-caption font-bold text-text">{ut("inv2.onRegister")}</span>
            <Segmented
              wide
              label={ut("inv2.onRegister")}
              value={assign}
              onChange={setAssign}
              items={[
                { key: "battery", label: ut("inv2.battery") },
                { key: "survey", label: ut("inv2.survey") },
                { key: "none", label: ut("inv2.nothing") },
              ]}
            />
          </div>
          {assign === "battery" ? (
            <Field label={ut("inv2.battery")} hint={ut("inv2.exclusive")}>
              <Select value={batteryId} onChange={(e) => setBatteryId(e.target.value)} data-autofocus>
                <option value="">{ut("sel.pick")}</option>
                {batteries.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.title} — {ut("inv2.itemsN").replace("{n}", String(b.items.length))}
                  </option>
                ))}
              </Select>
            </Field>
          ) : assign === "survey" ? (
            <Field label={ut("inv2.survey")} hint={ut("inv2.exclusive")}>
              <Select value={surveyId} onChange={(e) => setSurveyId(e.target.value)}>
                <option value="">{ut("sel.pick")}</option>
                {surveys.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <p className="m-0 text-small text-text-2">{ut("inv.noBatteryHint")}</p>
          )}
          <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
            <Field label={ut("inv.specialist")}>
              <Select value={specialistId} onChange={(e) => setSpecialistId(e.target.value)}>
                <option value="">{ut("inv2.me")}</option>
                {specialists.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.fullName}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={ut("ui.unit")} hint={ut("inv.unitToAccount")} optional>
              <Input value={unit} maxLength={200} onChange={(e) => setUnit(e.target.value)} />
            </Field>
            <Field label={ut("inv.uses")} hint={maxUses === 1 ? ut("inv2.onePerson") : ut("inv2.manyPeople")}>
              <Stepper value={maxUses} onChange={setMaxUses} min={1} max={500} label={ut("inv.uses")} />
            </Field>
            <Field label={ut("inv.days")} hint={ut("inv2.validUntil").replace("{d}", untilText)}>
              <Stepper value={ttlDays} onChange={setTtlDays} min={1} max={365} label={ut("inv.days")} />
            </Field>
          </div>
          {/*
            Выноски «Для групового обстеження…» больше нет: о группе говорит
            подсказка у числа входов, о подразделении — у подразделения.
          */}
          <Field label={ut("inv2.note")} hint={ut("inv2.noteHint")} optional>
            <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder={ut("inv.reasonExample")} />
          </Field>
        </div>

        <aside className="self-start rounded-panel bg-sunk p-4">
          <h3 className="m-0 mb-3 text-small font-extrabold text-text">{ut("inv2.whatPatientGets")}</h3>
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            <Step n={1}>
              {ut("inv2.step1")
                .replace("{days}", String(ttlDays))
                .replace("{uses}", String(maxUses))}
            </Step>
            <Step n={2}>{ut("inv2.step2")}</Step>
            <Step n={3} on>
              {items.length ? (
                <>
                  {ut("inv2.step3")}
                  <span className="mt-1.5 flex flex-wrap gap-1">
                    {items.map((it) => (
                      <span
                        key={it.surveyId}
                        className="inline-flex h-6 items-center rounded-pill bg-panel px-2 text-[11.5px] font-bold text-text"
                        title={it.title}
                      >
                        {instrumentCode(it.title, it.title.slice(0, 12))}
                      </span>
                    ))}
                  </span>
                </>
              ) : (
                ut("inv2.step3none")
              )}
            </Step>
            <Step n={4}>{specialistId ? ut("home.inviteOther").replace("{who}", specialistName) : ut("home.inviteMine")}</Step>
          </ol>
        </aside>
      </div>
    </Modal>
  );
}

function Step({ n, on, children }: { n: number; on?: boolean; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[22px_minmax(0,1fr)] items-start gap-2.5 text-small text-text-2">
      <span
        aria-hidden
        className={`grid size-[22px] place-items-center rounded-[7px] text-[11.5px] font-extrabold ${on ? "bg-violet text-onfill" : "bg-panel text-text-2"}`}
      >
        {n}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** Готовое приглашение: ссылка один раз, QR, код для диктовки, итог */
function ReadyDialog({
  token,
  code,
  summary,
  onClose,
  onAnother,
}: {
  token: string;
  code: string;
  summary: Summary;
  onClose: () => void;
  onAnother: () => void;
}) {
  const { ut } = useLang();
  const { run, busy } = useAction();
  const url = `${location.origin}/join/${token}`;
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }, [url]);

  return (
    <Modal
      title={ut("inv.ready")}
      sub={[summary.unit, ut("inv2.createdAt").replace("{t}", new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }))]
        .filter(Boolean)
        .join(", ")}
      icon={<Ic.circleCheck />}
      tone="good"
      width={680}
      secret
      onClose={onClose}
      footer={
        <>
          <Button variant="primary" onClick={onClose}>
            {ut("inv2.done")}
          </Button>
          <Button icon={<Ic.file />} onClick={() => window.print()}>
            {ut("inv.printQr")}
          </Button>
          <Button variant="ghost" icon={<Ic.plus />} onClick={onAnother}>
            {ut("inv2.another")}
          </Button>
        </>
      }
    >
      <Callout kind="violet" icon={<Ic.eye />} title={ut("inv2.onceTitle")}>
        {ut("inv2.onceText")}
      </Callout>
      <div className="mt-4 grid gap-5 [grid-template-columns:184px_minmax(0,1fr)] max-[600px]:grid-cols-1">
        <figure className="m-0 flex flex-col items-center gap-2">
          {/*
            biome-ignore lint/security/noDangerouslySetInnerHtml: SVG кода собирается
            здесь же из ссылки, никакие внешние данные в разметку не попадают
          */}
          <div className="qr size-[184px] rounded-panel border border-border bg-panel p-3 [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: svg }} />
          <figcaption className="text-caption text-muted">{ut("inv2.scan")}</figcaption>
        </figure>
        <div className="flex min-w-0 flex-col gap-3.5">
          <Field label={ut("inv.link")}>
            <div className="flex gap-2">
              <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12.5px]" />
              <Button
                icon={<CopyIcon />}
                disabled={busy}
                onClick={() => run(async () => navigator.clipboard.writeText(url), ut("inv.linkCopied"))}
              >
                {ut("inv2.copy")}
              </Button>
            </div>
          </Field>
          <div>
            <span className="mb-1.5 block text-caption font-bold text-text">{ut("inv.manualCode")}</span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex h-12 items-center rounded-control bg-sunk px-4 font-mono text-[24px] font-bold tracking-[0.18em] text-text">
                {code}
              </span>
              <Button
                icon={<CopyIcon />}
                disabled={busy}
                onClick={() => run(async () => navigator.clipboard.writeText(code), ut("inv.codeCopied"))}
              >
                {ut("inv.copyCode")}
              </Button>
            </div>
            <span className="mt-1.5 block text-caption text-muted">{ut("inv2.codeHint")}</span>
          </div>
          <KV
            w={110}
            rows={[
              [ut("inv2.willAssign"), summary.what],
              [ut("inv2.pinned"), summary.who],
              [ut("inv.expires"), `${summary.until}, ${ut("inv2.usesN").replace("{n}", String(summary.uses))}`],
            ]}
          />
        </div>
      </div>
    </Modal>
  );
}

/** Два листа внахлёст — «копіювати» (контур lucide, как значки набора) */
function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect width="14" height="14" x="8" y="8" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}
