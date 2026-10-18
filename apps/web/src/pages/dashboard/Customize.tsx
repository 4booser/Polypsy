import { useEffect, useRef, useState, type ReactNode } from "react";
import { ALWAYS_VISIBLE_WIDGETS, DASH_WIDGETS, type DashWidget, type UiKey, type WorkspacePrefs } from "@quizzy/shared";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../api";
import { useAuth } from "../../auth";
import { Callout, Drawer, DrawerSection, Tooltip, useAction } from "../../ui";
import { cx } from "../../ui/cx";
import { Ic } from "../../ui/icons";
import { Button, ChoiceCard, Segmented, Switch } from "../../ui/primitives";
import { useLang } from "../../lang";
import { Di } from "../today/icons";
import { dropWidget, fill, moveWidget, widgetLayout, type WidgetLayout } from "./model";

/**
 * «Налаштувати зведення» — ящик справа (кадр day-start-customize).
 *
 * Стартовый экран, віджети с порядком и выключением, плотность и движение.
 * Всё живёт в профиле (PUT /api/auth/me/workspace), а не в браузере:
 * сотрудник садится за разные машины отделения. Изменения применяются
 * сразу — зведення за ящиком перестраивается на глазах; «Скасувати»
 * возвращает то, что было при открытии, «Повернути як було» — порядок по
 * умолчанию.
 */

export const WIDGET_TITLE: Record<DashWidget, UiKey> = {
  cases: "dashA.cases",
  day: "dayA.dayTitle",
  missed: "dashA.missed",
  work: "work.title",
  passes: "dash.passes",
  collect: "dashA.collect",
  conditions: "dash.conditions",
};

const WIDGET_SUB: Partial<Record<DashWidget, UiKey>> = {
  cases: "dashA.wCasesSub",
  missed: "dashA.wMissedSub",
};

type Start = NonNullable<WorkspacePrefs["startScreen"]>;

const STARTS: { key: Start; title: UiKey; sub: UiKey; icon: ReactNode }[] = [
  { key: "dashboard", title: "dash.title", sub: "dashA.startDash", icon: <Di.dashboard size={14} /> },
  { key: "worklist", title: "work.title", sub: "dashA.startWork", icon: <Di.listChecks size={14} /> },
  { key: "alerts", title: "nav.cases", sub: "dashA.startCases", icon: <Ic.alert size={14} /> },
  { key: "patients", title: "nav.patients", sub: "dashA.startPatients", icon: <Ic.users size={14} /> },
];

const LOCKED = new Set<string>(ALWAYS_VISIBLE_WIDGETS);

export function CustomizeDrawer({
  open,
  onClose,
  layout,
  onLayout,
}: {
  open: boolean;
  onClose: () => void;
  layout: WidgetLayout;
  onLayout: (next: WidgetLayout) => void;
}) {
  const { ut } = useLang();
  const { user, refreshUser } = useAuth();
  const { run, busy } = useAction();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const [grab, setGrab] = useState<DashWidget | null>(null);
  /* что было при открытии — для «Скасувати» */
  const snapshot = useRef<{ layout: WidgetLayout; start: Start } | null>(null);
  const start: Start = user?.workspace?.startScreen ?? "dashboard";
  const density = user?.workspace?.density ?? "cozy";
  const motion = user?.workspace?.motion ?? "system";
  useEffect(() => {
    snapshot.current = open ? { layout, start } : null;
  }, [open]);

  const save = (patch: Parameters<typeof api.saveWorkspace>[0]) =>
    run(async () => {
      await api.saveWorkspace(patch);
      await refreshUser();
    });

  const setLayout = (next: WidgetLayout) => {
    onLayout(next);
    void save({ dashboard: { order: next.order, hidden: [...next.hidden] } });
  };
  const toggle = (k: DashWidget, on: boolean) => {
    const hidden = new Set(layout.hidden);
    if (on) hidden.delete(k);
    else hidden.add(k);
    setLayout({ order: layout.order, hidden });
  };
  const applyAttr = (name: string, value: string | null) => {
    if (value === null) delete document.documentElement.dataset[name];
    else document.documentElement.setAttribute(`data-${name}`, value);
  };

  const shown = layout.order.filter((k) => !layout.hidden.has(k)).length;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      wide
      title={ut("dashA.customize")}
      sub={ut("dashA.customizeSub")}
      icon={<Di.dashboard />}
      saved={ut("dashA.appliedNow")}
      footer={
        <>
          <Button variant="primary" onClick={onClose}>
            {ut("dashA.done")}
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              const s = snapshot.current;
              if (s) {
                onLayout(s.layout);
                void save({ dashboard: { order: s.layout.order, hidden: [...s.layout.hidden] }, startScreen: s.start });
              }
              onClose();
            }}
          >
            {ut("dashA.cancel")}
          </Button>
          <Button variant="quiet" disabled={busy} onClick={() => setLayout(widgetLayout(null))}>
            {ut("dashA.reset")}
          </Button>
        </>
      }
    >
      <DrawerSection title={ut("acct.startScreen")} sub={ut("dashA.startSub")}>
        <div role="radiogroup" aria-label={ut("acct.startScreen")} className="grid grid-cols-2 gap-2 max-[560px]:grid-cols-1">
          {STARTS.map((s) => (
            <ChoiceCard
              key={s.key}
              name="start-screen"
              value={s.key}
              checked={start === s.key}
              onChange={(v) => {
                /*
                 * Другой стартовый экран займёт «/» сразу после сохранения.
                 * Огляд с этим ящиком остаётся открытым по своей ссылке —
                 * иначе он исчез бы посреди настройки и стал недостижим.
                 */
                if (v !== "dashboard" && pathname === "/" && params.get("view") !== "overview") {
                  navigate("/?view=overview&customize=1", { replace: true });
                }
                void save({ startScreen: v as Start });
              }}
              title={
                <span className="inline-flex items-center gap-1.5">
                  {s.icon}
                  {ut(s.title)}
                </span>
              }
              sub={ut(s.sub)}
            />
          ))}
        </div>
      </DrawerSection>

      <DrawerSection title={ut("dashA.widgets")} sub={fill(ut("dashA.widgetsShown"), { n: shown, of: DASH_WIDGETS.length })}>
        <ul className="m-0 list-none p-0" aria-label={ut("dashA.widgets")}>
          {layout.order.map((k, i) => {
            const locked = LOCKED.has(k);
            const on = !layout.hidden.has(k);
            const sub = WIDGET_SUB[k];
            return (
              <li
                key={k}
                tabIndex={0}
                draggable
                aria-label={fill(ut("dashA.widgetPos"), { name: ut(WIDGET_TITLE[k]), n: i + 1, of: layout.order.length })}
                onDragStart={(e) => {
                  setGrab(k);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => setGrab(null)}
                onDragOver={(e) => {
                  if (grab && grab !== k) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (grab) setLayout({ order: dropWidget(layout.order, grab, k), hidden: layout.hidden });
                  setGrab(null);
                }}
                onKeyDown={(e) => {
                  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  setLayout({ order: moveWidget(layout.order, k, e.key === "ArrowUp" ? -1 : 1), hidden: layout.hidden });
                  const el = e.currentTarget;
                  requestAnimationFrame(() => el.focus());
                }}
                className={cx(
                  "grid min-h-12 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-0 border-t border-divider px-1 py-2 first:border-t-0",
                  "rounded-[10px] outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]",
                  grab === k && "bg-violet-tint shadow-[inset_0_0_0_1.5px_var(--vring)]",
                )}
              >
                <span aria-hidden className="cursor-grab text-muted">
                  <Di.grip size={15} />
                </span>
                <span className={cx("min-w-0 text-[13.5px] font-bold", on ? "text-text" : "text-muted")}>
                  {ut(WIDGET_TITLE[k])}
                  {sub ? <small className="block text-caption font-medium text-muted">{ut(sub)}</small> : null}
                </span>
                {locked ? (
                  <Tooltip label={ut("dashA.locked")}>
                    <span tabIndex={0} role="img" aria-label={ut("dashA.locked")} className="inline-grid size-8 place-items-center text-muted">
                      <Ic.lock size={15} />
                    </span>
                  </Tooltip>
                ) : (
                  <Switch checked={on} onChange={(v) => toggle(k, v)} label={<span className="sr-only">{ut(WIDGET_TITLE[k])}</span>} />
                )}
              </li>
            );
          })}
        </ul>
        <p className="m-0 mt-2 text-caption text-muted">{ut("dashA.dragHint")}</p>
      </DrawerSection>

      <DrawerSection title={ut("dashA.look")}>
        <div className="grid grid-cols-2 gap-4 max-[560px]:grid-cols-1">
          <div>
            <span className="mb-1.5 block text-caption font-bold text-muted">{ut("acct.density")}</span>
            <Segmented
              wide
              label={ut("acct.density")}
              value={density}
              onChange={(v) => {
                applyAttr("density", v);
                void save({ density: v });
              }}
              items={[
                { key: "cozy", label: ut("acct.densityCozy") },
                { key: "compact", label: ut("acct.densityCompact") },
              ]}
            />
          </div>
          <div>
            <span className="mb-1.5 block text-caption font-bold text-muted">{ut("acct.motion")}</span>
            <Segmented
              wide
              label={ut("acct.motion")}
              value={motion}
              onChange={(v) => {
                applyAttr("motion", v === "reduced" ? "reduced" : null);
                void save({ motion: v });
              }}
              items={[
                { key: "system", label: ut("acct.motionSystem") },
                { key: "reduced", label: ut("acct.motionReduced") },
              ]}
            />
          </div>
        </div>
        <div className="mt-3">
          <Callout kind="info">{ut("dashA.inProfile")}</Callout>
        </div>
      </DrawerSection>
    </Drawer>
  );
}
