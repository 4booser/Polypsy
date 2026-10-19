import { useEffect, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useLang } from "../../lang";
import { useServiceStatus } from "../../service/status";
import { ShellIcon } from "../../shell/icons";
import { Ic } from "../../ui";
import { cx } from "../../ui/cx";
import { buttonClass } from "../../ui/primitives";
import { AccessIcon } from "./accessIcons";
import { CrisisNote, rich } from "./authParts";
import {
  AuditSample,
  Faq,
  HeroPatientCard,
  QuestionPhone,
  RolePatientHome,
  RoleTeam,
  RoleWorklist,
  SampleCourse,
  SampleValues,
  Shot,
  SignalReview,
  SignalSteps,
} from "./landingParts";
import { PublicFrame } from "./PublicFrame";

/*
 * Лендинг Polypsy (набор «Виразна», access-landing) — страница «убедить» в
 * том же мире, что и консоль: продукт показан его же деталями (landingParts),
 * а не карточками-заглушками.
 *
 * Порядок — от главного обещания к делу: первый экран с плиткой «Дія зараз»;
 * для кого (фахівець, завідувач, пацієнт); числа со сравнением; как идёт
 * сигнал ризику; застосунок пацієнта; безпека; как підключити відділення;
 * запитання; финал и кому звонить, если плохо сейчас.
 *
 * Здесь только то, что система умеет: заявки на подключение с сервером нет —
 * вместо формы контакты учреждения (те же, что в подвале); ссылок на магазины
 * приложений нет — их адресов в системе нет; прогноза курса нет — приложение
 * его не считает (charts/README.md).
 *
 * Якоря: #about — подвал «Про кампанію», #app — «Пацієнтам — застосунок» со
 * входа, #connect — «Як підключити відділення».
 */

const WRAP = "mx-auto w-full max-w-[1232px] px-4";

export default function Landing() {
  const { ut } = useLang();
  const { hash } = useLocation();
  const { status } = useServiceStatus();

  /* переход по ссылке с якорем из другого экрана (вход, подвал): роутер сам к якорю не прокручивает */
  useEffect(() => {
    if (!hash) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [hash]);

  const ok = !status || status.status === "ok";
  const phone = ut("pub.phone");
  const email = ut("pub.email");

  return (
    <PublicFrame bleed>
      {/* ── первый экран: обещание и плитка «Дія зараз» ── */}
      <section id="about" aria-labelledby="lp-h1" className="scroll-mt-4 bg-appbar text-appbar-ink">
        <div
          className={cx(
            WRAP,
            "grid grid-cols-[minmax(0,1fr)_560px] items-center gap-12 pb-16 pt-12 max-[1180px]:grid-cols-[minmax(0,1fr)_480px] max-[1000px]:grid-cols-1",
          )}
        >
          <div className="min-w-0">
            <h1
              id="lp-h1"
              className="m-0 max-w-[620px] text-hero font-extrabold text-appbar-ink [text-wrap:balance] max-[600px]:text-[40px] max-[600px]:leading-[46px]"
            >
              {ut("lp.h1")}
            </h1>
            <p className="m-0 mt-[18px] max-w-[540px] text-lead font-semibold text-appbar-muted">{ut("lp.lead")}</p>
            <div className="mt-[30px] flex flex-wrap gap-2.5">
              <Link
                to="/login"
                className={buttonClass(
                  "primary",
                  "md",
                  "!bg-appbar-ink !text-appbar !shadow-none hover:!bg-appbar-muted",
                )}
              >
                <ShellIcon name="log-in" size={18} />
                {ut("lg.signIn")}
              </Link>
              <a
                href="#connect"
                className={buttonClass(
                  "secondary",
                  "md",
                  "!bg-appbar-field !text-appbar-ink shadow-[inset_0_0_0_1px_var(--appline)] hover:!bg-appbar-hover",
                )}
              >
                <AccessIcon name="building-2" size={18} />
                {ut("lp.connect")}
              </a>
            </div>
            <div className="mt-[22px] flex flex-wrap gap-x-[22px] gap-y-2 text-[13px] font-semibold text-appbar-muted">
              <a href="#app" className="inline-flex items-center gap-1.5 rounded-[6px] text-appbar-muted no-underline hover:text-appbar-ink">
                <ShellIcon name="smartphone" size={15} />
                {ut("ax.lg.app")}
              </a>
              <Link to="/status" className="inline-flex items-center gap-1.5 rounded-[6px] text-appbar-muted no-underline hover:text-appbar-ink">
                <ShellIcon name={ok ? "circle-check" : "circle-alert"} size={15} />
                {ok ? ut("lp.statusOk") : ut("svc.title")}
              </Link>
            </div>
          </div>
          <div className="min-w-0">
            <Shot label={ut("lp.cardAlt")}>
              <HeroPatientCard />
            </Shot>
            <p className="m-0 mt-3.5 max-w-[560px] text-[13px] leading-[19px] text-appbar-muted">{ut("lp.caption")}</p>
          </div>
        </div>
      </section>

      {/* ── для кого ── */}
      <section aria-label={ut("lp.rolesLabel")} className={cx(WRAP, "pt-14")}>
        <div className="grid grid-cols-[340px_minmax(0,1fr)_290px] items-stretch gap-6 max-[1180px]:grid-cols-2 max-[760px]:grid-cols-1">
          <RoleWorklist />
          <RoleTeam />
          <div className="max-[1180px]:col-span-2 max-[1180px]:mx-auto max-[1180px]:w-full max-[1180px]:max-w-[420px] max-[760px]:col-span-1">
            <RolePatientHome />
          </div>
        </div>
      </section>

      {/* ── числа ── */}
      <section aria-labelledby="lp-n" className={cx(WRAP, "pt-[88px]")}>
        <div className="grid grid-cols-[minmax(0,1fr)_600px] items-center gap-14 max-[1180px]:grid-cols-[minmax(0,1fr)_520px] max-[1000px]:grid-cols-1">
          <div className="min-w-0">
            <Head id="lp-n" title={ut("lp.numH")} lead={ut("lp.numLead")} />
            <Points
              items={[
                [<AccessIcon key="a" name="arrow-down-right" size={17} />, ut("lp.num1t"), ut("lp.num1")],
                [<ShellIcon key="b" name="ruler" size={17} />, ut("lp.num2t"), ut("lp.num2")],
                [<Ic.type key="c" size={17} />, ut("lp.num3t"), ut("lp.num3")],
                [<ShellIcon key="d" name="calendar-days" size={17} />, ut("lp.num4t"), ut("lp.num4")],
              ]}
            />
          </div>
          <SampleCourse />
        </div>
        <div className="mt-5">
          <SampleValues />
        </div>
      </section>

      {/* ── сигнал ризику ── */}
      <section aria-labelledby="lp-r" className={cx(WRAP, "pt-[88px]")}>
        <div className="grid grid-cols-[minmax(0,1fr)_440px] items-start gap-14 max-[1000px]:grid-cols-1">
          <div className="min-w-0">
            <Head id="lp-r" title={ut("lp.riskH")} lead={ut("lp.riskLead")} />
            <SignalSteps />
          </div>
          <SignalReview />
        </div>
      </section>

      {/* ── застосунок ── */}
      <section id="app" aria-labelledby="lp-m" className={cx(WRAP, "scroll-mt-4 pt-[88px]")}>
        <div className="grid grid-cols-[minmax(0,1fr)_330px] items-center gap-14 max-[1000px]:grid-cols-1">
          <div className="min-w-0">
            <Head id="lp-m" title={ut("lp.appH")} lead={ut("lp.appLead")} />
            <Points
              items={[
                [<ShellIcon key="a" name="bell-ring" size={17} />, ut("lp.a1t"), ut("lp.a1")],
                [<AccessIcon key="b" name="calendar-check" size={17} />, ut("lp.a2t"), ut("lp.a2")],
                [<ShellIcon key="c" name="messages-square" size={17} />, ut("lp.a3t"), ut("lp.a3")],
                [<Ic.cloudOff key="d" size={17} />, ut("lp.a4t"), ut("lp.a4")],
                [
                  <ShellIcon key="e" name="life-buoy" size={17} />,
                  ut("lp.a5t"),
                  rich(ut("lp.a5"), { hotline: ut("home.hotlineNumber"), emergency: ut("pt.emergencyNumber") }),
                ],
              ]}
            />
          </div>
          <QuestionPhone />
        </div>
      </section>

      {/* ── безпека ── */}
      <section aria-labelledby="lp-s" className="mt-24 border-y border-band-card-line bg-band py-[72px]">
        <div className={cx(WRAP, "grid grid-cols-[minmax(0,1fr)_600px] items-start gap-14 max-[1180px]:grid-cols-[minmax(0,1fr)_520px] max-[1000px]:grid-cols-1")}>
          <div className="min-w-0">
            <Head id="lp-s" title={ut("lp.secH")} lead={ut("lp.secLead")} />
            <ul className="m-0 mt-7 grid list-none grid-cols-2 gap-x-7 gap-y-[18px] p-0 max-[600px]:grid-cols-1">
              {(
                [
                  [<AccessIcon key="1" name="lock-keyhole" size={18} />, ut("lp.f1t"), ut("lp.f1")],
                  [<ShellIcon key="2" name="file-search" size={18} />, ut("lp.f2t"), ut("lp.f2")],
                  [<ShellIcon key="3" name="key-round" size={18} />, ut("lp.f3t"), ut("lp.f3")],
                  [<ShellIcon key="4" name="smartphone-nfc" size={18} />, ut("lp.f4t"), ut("lp.f4")],
                  [<AccessIcon key="5" name="link-2" size={18} />, ut("lp.f5t"), ut("lp.f5")],
                  [<ShellIcon key="6" name="file-signature" size={18} />, ut("lp.f6t"), ut("lp.f6")],
                  [<ShellIcon key="7" name="shield-check" size={18} />, ut("lp.f7t"), ut("lp.f7")],
                ] as [ReactNode, string, string][]
              ).map(([icon, t, d]) => (
                <li key={t} className="flex items-start gap-2.5 text-[13px] leading-[19px] text-text-2">
                  <span aria-hidden className="mt-px inline-flex text-violet-ink">
                    {icon}
                  </span>
                  <span>
                    <b className="block text-[14px] font-extrabold leading-5 text-text">{t}</b>
                    {d}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <AuditSample />
        </div>
      </section>

      {/* ── підключення ── */}
      <section id="connect" aria-labelledby="lp-c" className={cx(WRAP, "scroll-mt-4 pt-[88px]")}>
        <div className="grid grid-cols-[minmax(0,1fr)_480px] items-start gap-14 max-[1000px]:grid-cols-1">
          <div className="min-w-0">
            <Head id="lp-c" title={ut("lp.conH")} lead={ut("lp.conLead")} />
            <ol className="m-0 mt-7 flex list-none flex-col gap-[18px] p-0">
              {(
                [
                  [ut("lp.c1t"), ut("lp.c1")],
                  [ut("lp.c2t"), ut("lp.c2")],
                  [ut("lp.c3t"), ut("lp.c3")],
                ] as const
              ).map(([t, d], i) => (
                <li key={t} className="grid grid-cols-[40px_minmax(0,1fr)] items-start gap-3.5 text-[14px] leading-[21px] text-text-2">
                  <span aria-hidden className="grid size-10 place-items-center rounded-full bg-violet text-[15px] font-extrabold text-onfill">
                    {i + 1}
                  </span>
                  <span>
                    <b className="block pt-[9px] text-[16px] font-extrabold leading-[22px] text-text">{t}</b>
                    {d}
                  </span>
                </li>
              ))}
            </ol>
            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[15px] font-extrabold">
              <a
                href={`tel:${phone.replace(/\s+/g, "")}`}
                className="inline-flex items-center gap-2 rounded-[8px] text-text no-underline hover:text-violet-ink"
              >
                <ShellIcon name="phone" size={17} className="text-violet-ink" />
                {phone}
              </a>
              <a href={`mailto:${email}`} className="inline-flex items-center gap-2 rounded-[8px] text-text no-underline hover:text-violet-ink">
                <AccessIcon name="mail" size={17} className="text-violet-ink" />
                {email}
              </a>
            </div>
          </div>
          <div className="rounded-drawer border border-border bg-panel px-7 pb-[26px] pt-7 shadow-banner">
            <h3 className="m-0 text-big font-extrabold text-text">{ut("lp.prepT")}</h3>
            <ul className="m-0 mt-4 flex list-none flex-col gap-2.5 p-0">
              {[ut("lp.prep1"), ut("lp.prep2"), ut("lp.prep3")].map((x) => (
                <li key={x} className="flex items-start gap-2.5 text-[14px] font-semibold leading-5 text-text">
                  <Ic.check size={16} className="mt-0.5 text-good" />
                  {x}
                </li>
              ))}
            </ul>
            <div className="mt-6 flex flex-wrap gap-2">
              <a href={`tel:${phone.replace(/\s+/g, "")}`} className={buttonClass("primary", "md")}>
                <ShellIcon name="phone" size={18} />
                {phone}
              </a>
              <a href={`mailto:${email}`} className={buttonClass("secondary", "md")}>
                <AccessIcon name="mail" size={18} />
                {ut("ax.jn.mail")}
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── запитання ── */}
      <section aria-labelledby="lp-q" className={cx(WRAP, "pt-[88px]")}>
        <div className="grid grid-cols-[380px_minmax(0,1fr)] items-start gap-14 max-[1000px]:grid-cols-1">
          <div className="min-w-0">
            <Head id="lp-q" title={ut("lp.faqH")} lead={ut("lp.faqLead")} />
            <a href={`mailto:${email}`} className={buttonClass("secondary", "sm", "mt-5")}>
              <AccessIcon name="mail" size={15} />
              {ut("lp.ask")}
            </a>
          </div>
          <Faq />
        </div>
      </section>

      {/* ── финал ── */}
      <section aria-labelledby="lp-e" className={cx(WRAP, "pb-[72px] pt-[88px]")}>
        <div className="flex flex-wrap items-center gap-10 rounded-[24px] bg-appbar px-11 py-10 text-appbar-ink max-[700px]:px-6">
          <div className="min-w-0 flex-1 basis-[420px]">
            <h2 id="lp-e" className="m-0 max-w-[640px] text-[36px] font-extrabold leading-[42px] tracking-[-0.03em] text-appbar-ink [text-wrap:balance]">
              {ut("lp.endH")}
            </h2>
            <p className="m-0 mt-2 text-lead font-semibold text-appbar-muted">{ut("lp.endLead")}</p>
          </div>
          <div className="flex flex-wrap gap-2.5">
            <a
              href="#connect"
              className={buttonClass("primary", "md", "!bg-appbar-ink !text-appbar !shadow-none hover:!bg-appbar-muted")}
            >
              <AccessIcon name="building-2" size={18} />
              {ut("lp.connect")}
            </a>
            <Link
              to="/login"
              className={buttonClass(
                "secondary",
                "md",
                "!bg-appbar-field !text-appbar-ink shadow-[inset_0_0_0_1px_var(--appline)] hover:!bg-appbar-hover",
              )}
            >
              <ShellIcon name="log-in" size={18} />
              {ut("lg.signIn")}
            </Link>
          </div>
        </div>
        <CrisisNote template={ut("lp.crisis")} className="mt-4" />
      </section>
    </PublicFrame>
  );
}

/** Заголовок раздела лендинга: 36/42 и строка под ним */
function Head({ id, title, lead }: { id: string; title: string; lead: string }) {
  return (
    <>
      <h2 id={id} className="m-0 max-w-[640px] text-[36px] font-extrabold leading-[42px] tracking-[-0.03em] text-text [text-wrap:balance] max-[600px]:text-[30px] max-[600px]:leading-9">
        {title}
      </h2>
      <p className="m-0 mt-3 max-w-[600px] text-[17px] font-semibold leading-[26px] text-text-2">{lead}</p>
    </>
  );
}

/** Пункты раздела: квадрат значка, жирное начало, пояснение */
function Points({ items }: { items: [ReactNode, string, ReactNode][] }) {
  return (
    <ul className="m-0 mt-7 flex max-w-[560px] list-none flex-col gap-4 p-0">
      {items.map(([icon, t, d]) => (
        <li key={t} className="grid grid-cols-[36px_minmax(0,1fr)] items-start gap-3.5 text-[14px] leading-[21px] text-text-2">
          <span aria-hidden className="grid size-9 place-items-center rounded-[11px] bg-violet-tint text-violet-ink">
            {icon}
          </span>
          <span>
            <b className="block text-h3 font-extrabold leading-[21px] text-text">{t}</b>
            {d}
          </span>
        </li>
      ))}
    </ul>
  );
}
