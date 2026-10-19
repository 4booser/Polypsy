import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import type { UiKey } from "@quizzy/shared";
import { api } from "../api";
import { connection } from "../connection";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { MaintenanceBanner } from "../service/MaintenanceBanner";
import { ShellIcon, type IconName } from "../shell/icons";
import { LogoTile } from "../shell/Logo";
import { initials } from "../shell/UserMenu";
import { Drawer } from "../ui";
import { ConnectionLine } from "../ui/ConnectionLine";
import { cx } from "../ui/cx";
import { TouchArea } from "../ui/primitives";
import { outbox, type OutboxItem } from "./outbox";
import { ConsentGate, useRecheckConsent } from "./ConsentGate";
import { OutboxStrip, type OutboxView } from "./OutboxStrip";
import { CallRows, HelpProvider } from "./parts";

/**
 * Кабинет пациента.
 *
 * Отдельная оболочка, а не консоль с урезанным меню: человек, вошедший
 * пациентом, видел бы разделы специалиста и получал отказ на каждом — и
 * мог бы решить, что его карту читает кто угодно.
 *
 * Polypsy 2.0 (patient() в kit/shell.py): шапка на сиреневой полосе —
 * знак, четыре вкладки, всегда видимая «Допомога» и имя; одна
 * колонка 1120, основной текст 16, мишени от 44. На телефоне вкладки
 * уходят вниз, под большой палец, а «Допомога» остаётся в шапке: её ищут в
 * тяжёлую минуту, и искать её не должно быть нужно.
 */
export default function PatientApp() {
  // сначала согласие: без принятой редакции сервер ответов не примет (ConsentGate)
  return (
    <ConsentGate frame={(screen) => <PatientFrame focus>{screen}</PatientFrame>}>
      <PatientShell />
    </ConsentGate>
  );
}

interface Tab {
  to: string;
  end?: boolean;
  /** Подпись вкладки — короткая, внизу телефона помещается одно слово */
  label: UiKey;
  /** Подпись вкладки в шапке — на широком окне место есть */
  wide: UiKey;
  icon: IconName;
}

const TABS: Tab[] = [
  { to: "/me", end: true, label: "pt.home", wide: "pt.home", icon: "house" },
  { to: "/me/tests", label: "pt.tests", wide: "pt.titleTests", icon: "clipboard-check" },
  { to: "/me/booking", label: "pt.booking", wide: "pt.titleBooking", icon: "calendar-plus" },
  { to: "/me/profile", label: "pt.tabProfile", wide: "pt.tabProfile", icon: "circle-user-round" },
];

/**
 * Что кабинет отдаёт экранам через Outlet: очередь несданных ответов.
 * «Мої тести» рисуют её панелью с решениями (OutboxPanel), остальные
 * экраны — строкой на полосе (OutboxStrip).
 */
export interface PatientOutlet {
  outbox: OutboxState;
}

function PatientShell() {
  const { user } = useAuth();
  const { pathname } = useLocation();
  const pending = useOutbox(user?.id ?? null);
  /* на «Моїх тестах» очередь — панелью с решениями по каждой сдаче; строка на полосе её бы повторила */
  const onTests = pathname.startsWith("/me/tests");
  const context = useMemo<PatientOutlet>(() => ({ outbox: pending }), [pending]);

  return (
    <PatientFrame>
      {onTests ? null : <OutboxStrip outbox={pending} />}
      <Outlet context={context} />
    </PatientFrame>
  );
}

/**
 * Рамка кабинета: шапка на сиреневой полосе, строка связи, подвал, нижние
 * вкладки на телефоне и ящик «Допомога».
 *
 * Отдельно от маршрутов, потому что в неё встают и экраны вне вкладок:
 * согласие до входа в кабинет и прохождение методики. Им — `focus`: вкладки
 * кабинета уступают одной задаче на экране (kit patient_web, .fo), а
 * «Допомога» остаётся в шапке на любом экране.
 *
 * Заголовок экрана рисует сам экран — полосой под шапкой (parts.tsx, Hero):
 * у каждого экрана свой заголовок, пояснение и карточка главного.
 */
export function PatientFrame({ focus, children }: { focus?: boolean; children: ReactNode }) {
  const { ut } = useLang();
  const { user } = useAuth();
  const [help, setHelp] = useState(false);
  const closeHelp = useCallback(() => setHelp(false), []);
  const openHelp = useCallback(() => setHelp(true), []);

  return (
    /*
      Весь кабинет — территория пальца: телефон, одна рука, человек в
      тяжёлом состоянии. Отсюда 44 px у любой мишени внутри, включая чужие
      компоненты вроде переключателя языка. См. TouchArea.
    */
    <TouchArea className="flex min-h-dvh flex-col bg-ground text-[16px] leading-6 text-text">
      <HelpProvider value={openHelp}>
        <MaintenanceBanner place="patient" />
        {/* полоса продолжается заголовком экрана (Hero) — линия внизу у него */}
        <div className="bg-band">
          <header className="mx-auto flex h-[76px] w-full max-w-[1152px] items-center gap-7 px-4 max-[1099px]:gap-4 max-[600px]:gap-2">
            <Link
              to="/me"
              aria-label={ut("shell.home")}
              className="flex shrink-0 items-center gap-[10px] rounded-[12px] text-text no-underline hover:no-underline"
            >
              <LogoTile size={40} ring />
              <span className="text-[18px] font-extrabold leading-none tracking-[-0.015em] max-[1099px]:hidden">
                {ut("shell.brand")}
              </span>
            </Link>
            {focus ? null : (
              <nav aria-label={ut("pt.cabinet")} className="flex items-center gap-1 max-[899px]:hidden">
                {TABS.map((t) => (
                  <NavLink
                    key={t.to}
                    to={t.to}
                    end={t.end}
                    className={({ isActive }) =>
                      cx(
                        "group inline-flex h-11 items-center gap-2 whitespace-nowrap rounded-[12px] px-4 text-[15px] leading-none no-underline hover:no-underline",
                        "transition-colors duration-[var(--dur-fast)] ease-[var(--ease)] max-[1099px]:px-3",
                        isActive
                          ? "bg-band-card font-extrabold text-violet-ink shadow-tile"
                          : "font-bold text-text-2 hover:bg-tab-hover hover:text-text",
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <ShellIcon name={t.icon} size={18} className={isActive ? "text-violet-ink" : "text-muted"} />
                        {ut(t.wide)}
                      </>
                    )}
                  </NavLink>
                ))}
              </nav>
            )}
            <div className="ml-auto flex items-center gap-[10px] max-[600px]:gap-[6px]">
              {/*
                «Допомога» — всегда в шапке, на любой ширине и любом экране
                кабинета: кому сейчас плохо, тот не должен искать, где позвонить.
              */}
              <button
                type="button"
                onClick={() => setHelp((v) => !v)}
                aria-haspopup="dialog"
                aria-expanded={help}
                className={cx(
                  "inline-flex h-11 shrink-0 items-center gap-[7px] rounded-[22px] border-0 bg-band-card pl-[13px] pr-4",
                  "text-[15px] font-bold leading-none text-violet-ink shadow-[inset_0_0_0_1px_var(--bcardline)]",
                  "transition-colors hover:bg-violet-tint-2 aria-expanded:bg-violet-tint-2 aria-expanded:shadow-[inset_0_0_0_1.5px_var(--v)]",
                )}
              >
                <ShellIcon name="life-buoy" size={18} />
                {ut("pt.help")}
              </button>
              {/*
                Язык и тема — в профиле (выбор языка и темы): в шапке им
                не хватило бы места рядом с «Допомогою» при мишенях 44, а
                кабинет — место спокойное, без лишних кнопок на каждом экране.
              */}
              <Link
                to="/me/profile"
                aria-label={user?.fullName ?? ut("pt.tabProfile")}
                className="flex h-11 shrink-0 items-center gap-[10px] rounded-[12px] pl-[5px] pr-3 text-[14px] font-bold text-text no-underline hover:bg-tab-hover hover:no-underline max-[899px]:pr-[5px]"
              >
                <span
                  aria-hidden
                  className="grid size-[34px] shrink-0 place-items-center rounded-full bg-violet text-[12px] font-extrabold text-onfill"
                >
                  {initials(user?.fullName ?? "")}
                </span>
                <span className="max-w-[160px] truncate max-[899px]:hidden">{user?.fullName ?? ""}</span>
              </Link>
            </div>
          </header>
        </div>
        <ConnectionLine place="patient" />

        {/* внизу на телефоне — место под полосу вкладок, иначе последняя кнопка экрана под ней */}
        <main className={cx("flex w-full flex-1 flex-col", !focus && "max-[899px]:pb-20")}>{children}</main>

        <footer className="border-t border-border bg-panel max-[899px]:hidden">
          <div className="mx-auto flex h-16 w-full max-w-[1152px] items-center gap-6 whitespace-nowrap px-4 text-[13.5px] text-muted">
            <a
              href={`tel:${ut("home.hotlineNumber")}`}
              className="inline-flex items-center gap-[6px] text-muted no-underline hover:text-text hover:no-underline"
            >
              <ShellIcon name="phone" size={14} />
              {ut("home.hotline")}
              <b className="font-extrabold text-text-2">{ut("home.hotlineNumber")}</b>
            </a>
            <Link to="/status" className="ml-auto inline-flex items-center gap-[6px] text-text-2 no-underline hover:underline">
              <ShellIcon name="circle-check" size={14} className="text-good" />
              {ut("svc.title")}
            </Link>
          </div>
        </footer>

        {/*
          Вкладки на телефоне — внизу, под большим пальцем. Полоса отступает
          снизу на безопасную зону: вкладка, прижатая к самому краю, попадает
          под домашнюю черту телефона, и нажатие уходит системе.

          Слой — ниже подложки ящика набора (Drawer, z-[34]): ящик идёт до
          низа экрана, и полоса поверх него закрывала его подвал — на 390
          кнопку «Змінити пароль» в профиле было не нажать (ревью волны 26).
        */}
        {focus ? null : (
          <nav
            aria-label={ut("pt.cabinet")}
            className="fixed inset-x-0 bottom-0 z-30 hidden border-t border-border bg-panel pb-[max(env(safe-area-inset-bottom),8px)] max-[899px]:flex"
          >
            {TABS.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.end}
                className={({ isActive }) =>
                  cx(
                    "flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 pt-2 text-[12px] leading-4 no-underline hover:no-underline",
                    isActive ? "font-extrabold text-violet-ink" : "font-semibold text-text-2",
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      aria-hidden
                      className={cx(
                        "grid h-[30px] w-[52px] place-items-center rounded-[15px]",
                        isActive ? "bg-violet text-onfill" : "text-muted",
                      )}
                    >
                      <ShellIcon name={t.icon} size={21} />
                    </span>
                    {ut(t.label)}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        )}

        <HelpDrawer open={help} onClose={closeHelp} />
      </HelpProvider>
    </TouchArea>
  );
}

/**
 * «Потрібна допомога зараз» — кому звонить, одним нажатием (help_pane
 * набора). Строки — общие с экранами кабинета (parts.tsx, CallRows): красным
 * только 103, номера — настоящими ссылками tel:, без подтверждения.
 */
function HelpDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { ut } = useLang();
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={ut("pt.helpTitle")}
      sub={ut("pt.helpSub")}
      icon={<ShellIcon name="life-buoy" size={18} />}
    >
      <div className="pb-[18px] pt-[14px]">
        <CallRows autoFocus />
        <p className="m-0 mt-3 text-[14px] leading-5 text-muted">{ut("pt.helpNote")}</p>
      </div>
    </Drawer>
  );
}

/**
 * Досылка отложенных сдач (patient/outbox.ts): при входе в кабинет, при
 * возвращении сети и раз в минуту, пока кабинет открыт, — и по кнопке.
 * Отвергнутые — по решению человека: повторить или отказаться (OutboxStrip).
 *
 * Раз в минуту, а не по Retry-After: работы заканчивают и раньше
 * объявленного, а минута ожидания после конца работ никого не задевает.
 * Прохождение отложенной сдачи через тот же маршрут сдачи, с тем же
 * clientRequestId: сервер отбросит дубль, если первая попытка всё же дошла.
 *
 * Проход встал на 403 «нужно согласие» (#201) — ворота кабинета
 * перепроверяют согласие и встают его экраном. Запись цела; после принятия
 * кабинет монтируется снова, и первый же проход отправляет её — те же
 * ответы, тот же clientRequestId.
 */
/** Очередь кабинета для экранов — то, что рисуют OutboxPanel и OutboxStrip */
export type OutboxState = OutboxView;

function useOutbox(userId: string | null): OutboxState {
  const [counts, setCounts] = useState<{ waiting: OutboxItem[]; rejected: OutboxItem[] }>({ waiting: [], rejected: [] });
  const [busy, setBusy] = useState(false);
  const recheckConsent = useRecheckConsent();

  const recount = useCallback(() => {
    if (userId) setCounts({ waiting: outbox.waiting(userId), rejected: outbox.rejected(userId) });
  }, [userId]);

  const flush = useCallback(() => {
    if (!userId) return;
    recount();
    if (!outbox.waiting(userId).length) return;
    setBusy(true);
    void outbox
      .flush(userId, (item: OutboxItem) => api.submitResponse(item.surveyId, item.payload as never))
      .then((result) => {
        if (result.consent) recheckConsent();
      })
      .finally(() => {
        recount();
        setBusy(false);
      });
  }, [userId, recount, recheckConsent]);

  /* отвергнутую — обратно в очередь и сразу в проход; не примет и теперь — снова строкой с причиной (#172) */
  const retry = useCallback(
    (id: string) => {
      if (!userId) return;
      outbox.retry(userId, id);
      flush();
    },
    [userId, flush],
  );

  const discard = useCallback(
    (id: string) => {
      if (!userId) return;
      outbox.discard(userId, id);
      recount();
    },
    [userId, recount],
  );

  useEffect(() => {
    flush();
    const timer = setInterval(flush, 60_000);
    /*
     * Связь вернулась — досылаем сразу. По знанию вкладки о связи
     * (connection.ts), а не по событию браузера «online»: браузер молчит,
     * когда сеть была, а сервера за ней не было (перезапуск, VPN), — а
     * ответы в очереди ждут как раз этого.
     */
    let wasOnline = connection.isOnline();
    const off = connection.subscribe(() => {
      const online = connection.isOnline();
      if (online && !wasOnline) flush();
      wasOnline = online;
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [flush]);

  return useMemo(() => ({ ...counts, busy, flush, retry, discard }), [counts, busy, flush, retry, discard]);
}
