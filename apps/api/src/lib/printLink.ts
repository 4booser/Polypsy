import { renderError, serverText, uiText, type Lang } from "@quizzy/shared";
import { esc, icon, logo, sheetDocument, type IconName } from "./printSheet";

/**
 * Страница одноразовой ссылки на лист (мобилка, волна 14) — гостевая
 * страница «Виразной» (UI 3, print-report-link и print-report-link-gone).
 *
 * Открывает её браузер телефона, без входа и без консоли: поэтому здесь своя
 * рамка — знак, полоса «ссылка одноразовая» с «Зберегти PDF», лист слева и
 * пояснения справа (на телефоне — одной колонкой: полоса, лист, пояснения).
 * Тема — по настройке телефона (prefers-color-scheme); печать и «Зберегти
 * PDF» — всегда светлый лист без рамки, тем же видом, что из консоли.
 *
 * «Зберегти PDF» и «Друкувати» — одно и то же окно печати браузера: в нём
 * PDF выбирают адресатом. Своего PDF сервер не собирает (см. routes/reports.ts,
 * «отдаём разметку, а не готовый PDF»).
 */

const LINK_CSS = `
body.lk-body{background:#F5F3FA}
.lk{--g-ground:#F5F3FA;--g-panel:#FFFFFF;--g-panel2:#FAF8FD;--g-sunk:#F3EFF9;--g-border:#E6E1F0;--g-text:#221A33;--g-text2:#433A57;--g-muted:#695F80;--g-v:#663399;--g-vink:#5A2C8E;--g-vtint:#EFE8F7;--g-warn:#8A5300;--g-warntint:#FFF1D9;--g-good:#2E7D32;--g-goodtint:#E7F3E8;--g-risk:#C62828;--g-riskink:#B71C1C;max-width:1232px;margin:0 auto;padding:12px 16px 56px;color:var(--g-text);font:500 15px/22px var(--ff)}
.lk-top{display:flex;align-items:center;gap:12px;height:64px}
.lk-top .mark{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:#fff;color:#663399;box-shadow:0 1px 2px rgba(34,26,51,.1),0 0 0 1px rgba(102,51,153,.12)}
.lk-top b{font-size:18px;line-height:24px}
.lk-once{display:flex;align-items:center;gap:14px;margin-top:12px;padding:14px 16px 14px 18px;border-radius:16px;background:var(--g-warntint);color:var(--g-text2)}
.lk-once>.ic{color:var(--g-warn)}
.lk-once b{color:var(--g-warn)}
.lk-btn{height:44px;padding:0 18px;border:0;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;gap:8px;font:700 15px/1 var(--ff);background:var(--g-vtint);color:var(--g-vink);cursor:pointer;white-space:nowrap;text-decoration:none}
.lk-btn:focus-visible{outline:2px solid var(--g-v);outline-offset:2px}
.lk-btn.p{height:48px;background:var(--g-v);color:#fff;box-shadow:0 1px 2px rgba(102,51,153,.25),0 6px 14px -6px rgba(102,51,153,.55)}
.lk-once .lk-btn{margin-left:auto;background:var(--g-panel)}
.lk-grid{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:20px;margin-top:20px;align-items:start}
.lk-side{display:flex;flex-direction:column;gap:16px;min-width:0}
.lk-panel{padding:18px 18px 20px;border-radius:16px;background:var(--g-panel);border:1px solid var(--g-border)}
.lk-panel>h2{display:flex;align-items:center;gap:10px;margin-bottom:12px;font:800 18px/24px var(--ff);letter-spacing:-.01em}
.phi{width:32px;height:32px;border-radius:10px;display:inline-grid;place-items:center;flex-shrink:0;background:var(--g-vtint);color:var(--g-vink)}
.phi.wn{background:var(--g-warntint);color:var(--g-warn)}
.phi.n{background:var(--g-sunk);color:var(--g-text2)}
.lk-panel p{color:var(--g-text2)}
.lk-stack{display:flex;flex-direction:column;gap:8px;margin-top:16px}
.lk-small{margin-top:12px;font-size:14px;line-height:20px;color:var(--g-muted)!important}
.lk-li{display:flex;flex-direction:column;gap:14px}
.lk-li>div{display:flex;gap:12px;align-items:flex-start}
.lk-li>div>span:last-child{padding-top:4px}
.lk-calls{margin-top:12px;border:1px solid var(--g-border);border-radius:14px;overflow:hidden}
.lk-call{display:grid;grid-template-columns:minmax(0,1fr) auto 44px;align-items:center;gap:12px;padding:12px 12px 12px 16px;color:inherit;text-decoration:none}
.lk-call+.lk-call{border-top:1px solid var(--g-border)}
.lk-call b{display:block;font-weight:800}
.lk-call small{display:block;font-size:13px;line-height:18px;color:var(--g-muted)}
.lk-call .num{font:800 20px/1 var(--ff);color:var(--g-vink)}
.lk-call .cb{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:var(--g-vtint);color:var(--g-vink)}
.lk-call.r b,.lk-call.r .num{color:var(--g-riskink)}
.lk-call.r .cb{background:var(--g-risk);color:#fff}
.lk-doc .ps{width:auto;min-height:0;margin:0;padding:28px 32px;border-radius:16px;border:1px solid var(--g-border);box-shadow:none;zoom:1.1}
.lk-more{display:inline-flex;align-items:center;gap:8px;margin-top:10px;padding:8px 2px;font:700 13px/18px var(--ff);color:var(--vink);cursor:pointer}
.lk-all{position:absolute;width:1px;height:1px;margin:0;opacity:0}
.lk-all:focus-visible~.lk-more{outline:2px solid var(--v);outline-offset:2px;border-radius:6px}
.lk-all:not(:checked)~table tr.more{display:none}
.lk-all:checked~.lk-more{display:none}
.lk-gone{padding:36px 36px 32px}
.lk-gone .gi{width:64px;height:64px;border-radius:20px;display:grid;place-items:center;background:var(--g-warntint);color:var(--g-warn)}
.lk-gone h1{margin-top:20px;font:800 34px/40px var(--ff);letter-spacing:-.03em}
.lk-lead{margin-top:6px;max-width:640px;font-size:17px;line-height:26px;color:var(--g-text2)}
.lk-callout{max-width:640px;margin-top:16px;padding:14px 16px;border-radius:14px;background:var(--g-goodtint)}
.lk-callout b{display:flex;align-items:center;gap:8px;color:var(--g-good)}
.lk-callout p{margin-top:4px;color:var(--g-text2)}
.lk-h{margin-top:28px;padding-bottom:8px;border-bottom:1px solid var(--g-border);font:800 18px/24px var(--ff)}
.lk-steps{display:flex;flex-direction:column;gap:12px;margin-top:14px}
.lk-steps>div{display:flex;align-items:center;gap:14px;padding:12px 14px;border-radius:14px;background:var(--g-panel2);border:1px solid var(--g-border)}
.lk-steps b{display:block}
.lk-steps small{display:block;font-size:14px;line-height:20px;color:var(--g-muted);font-weight:600}
.lk-steps .k{margin-left:auto;font-weight:700;color:var(--g-muted)}
@media screen{.lk-doc .ps-end .ps-signs{display:none}}
@media screen and (prefers-color-scheme:dark){
  .lk{--g-ground:#141019;--g-panel:#1E1826;--g-panel2:#221B2B;--g-sunk:#272030;--g-border:#2E2638;--g-text:#EDE8F5;--g-text2:#CEC5DD;--g-muted:#A79CBA;--g-v:#7443AD;--g-vink:#C3A6F0;--g-vtint:#2C2140;--g-warn:#F0B957;--g-warntint:#2E2516;--g-good:#74D19C;--g-goodtint:#15281E;--g-risk:#CF3434;--g-riskink:#FF8F86}
  body.lk-body{background:#141019}
  .lk-doc .ps{--paper:#1E1826;--text:#EDE8F5;--text2:#CEC5DD;--muted:#A79CBA;--border:#2E2638;--divider:#2A2232;--ctl:#463A56;--panel2:#221B2B;--sunk:#272030;--track:#3A3047;--v:#C3A6F0;--vink:#C3A6F0;--vline:#4D3B70;--riskink:#FF8F86;--riskline:#6E2B36;--warn:#F0B957;--warnline:#5A4626;--good:#74D19C;--goodline:#24462F;--sline:#463A56;--s0:#74D19C;--s1:#C9D56E;--s2:#F3B25B;--s3:#FF9F7F;--s4:#FF8A80;--s0b:#15281E;--s1b:#262A14;--s2b:#33250F;--s3b:#3A2117;--s4b:#3A1A1C}
  .lk-top .mark{background:#fff}
}
@media screen and (max-width:900px){
  .lk-grid{grid-template-columns:minmax(0,1fr)}
  .lk-once{flex-wrap:wrap}
  .lk-once .lk-btn{margin-left:0}
  .lk-gone{padding:24px 20px}
  .lk-gone h1{font-size:28px;line-height:34px}
}
@media screen and (max-width:820px){
  body.lk-body{background:#F5F3FA}
  .lk-doc .ps{padding:20px 16px 24px;zoom:1.06}
}
@media screen and (max-width:820px) and (prefers-color-scheme:dark){body.lk-body{background:#141019}}
@media print{
  .lk-top,.lk-once,.lk-side,.lk-more{display:none!important}
  .lk{max-width:none;margin:0;padding:0}
  .lk-grid{display:block;margin:0}
  .lk-doc .ps{zoom:1;border:0;border-radius:0;padding:0}
  .lk-all~table tr.more{display:table-row!important}
  body.lk-body{background:#fff}
}
`;

/** «Зберегти PDF» и «Друкувати» — окно печати; разметка кнопок — data-print */
const PRINT_SCRIPT = `<script>document.querySelectorAll("[data-print]").forEach(function(b){b.addEventListener("click",function(){window.print()})})</script>`;

function frame(lang: Lang, title: string, running: string, inner: string): string {
  return sheetDocument({
    lang,
    title,
    running,
    css: LINK_CSS,
    bodyAttrs: 'class="lk-body"',
    body: `<div class="lk"><header class="lk-top"><span class="mark">${logo(28)}</span><b>Polypsy</b></header>${inner}</div>${PRINT_SCRIPT}`,
  });
}

/** Панель с заголовком и значком */
export function panel(title: string, ic: IconName, body: string, tone = ""): string {
  return `<section class="lk-panel"><h2><span class="phi${tone ? ` ${tone}` : ""}">${icon(ic, 17)}</span>${esc(title)}</h2>${body}</section>`;
}

/** Строка пояснения со значком */
export function point(ic: IconName, html: string, tone = ""): string {
  return `<div><span class="phi${tone ? ` ${tone}` : ""}">${icon(ic, 17)}</span><span>${html}</span></div>`;
}

/**
 * «Якщо стане важко»: телефон довіри и экстренная помощь. Номер доверия —
 * тот же, что на главной приложения (home.hotlineNumber): один номер на всё.
 */
export function helpPanel(lang: Lang): string {
  const say = (key: string) => serverText(key, lang);
  const hotline = uiText("home.hotlineNumber", lang);
  const emergency = say("print.link.emergencyNumber");
  const call = (name: string, sub: string, num: string, red: boolean) =>
    `<a class="lk-call${red ? " r" : ""}" href="tel:${esc(num)}"><span><b>${esc(name)}</b><small>${esc(sub)}</small></span><span class="num">${esc(num)}</span><span class="cb">${icon("phone", 19)}</span></a>`;
  return panel(
    say("print.link.hard"),
    "heart",
    `<p>${esc(say("print.link.hardLead"))}</p><div class="lk-calls">${call(uiText("home.hotline", lang), say("print.link.allDay"), hotline, false)}${call(say("print.link.emergency"), say("print.link.emergencySub"), emergency, true)}</div>`,
  );
}

/** Лист, открытый ссылкой: полоса, лист, пояснения */
export function linkPage(opts: { lang: Lang; title: string; running: string; sheet: string; side: string }): string {
  const say = (key: string) => serverText(key, opts.lang);
  const save = say("print.link.savePdf");
  const banner = `<div class="lk-once" role="status">${icon("timer", 20)}<span><b>${esc(say("print.link.onceTitle"))}</b> ${esc(say("print.link.onceBody"))}</span><button type="button" class="lk-btn" data-print>${icon("fileDown", 16)}${esc(save)}</button></div>`;
  return frame(
    opts.lang,
    opts.title,
    opts.running,
    `${banner}<div class="lk-grid"><div class="lk-doc">${opts.sheet}</div><aside class="lk-side">${opts.side}${helpPanel(opts.lang)}</aside></div>`,
  );
}

/** Кнопки окна печати для панели «Одноразове посилання» */
export function printButtons(lang: Lang): string {
  const say = (key: string) => serverText(key, lang);
  return `<div class="lk-stack"><button type="button" class="lk-btn p" data-print>${icon("fileDown", 18)}${esc(say("print.link.savePdf"))}</button><button type="button" class="lk-btn" data-print>${icon("printer", 18)}${esc(say("print.link.print"))}</button></div>`;
}

/**
 * Ссылка мёртвая (410): одна фраза об этом — та же для всех причин, —
 * как открыть заключение снова и почему ссылка короткая. Причина отказа
 * нужна журналу, а не тому, кто держит ссылку: возможные причины перечислены
 * все, без указания, какая сработала.
 */
export function gonePage(lang: Lang): string {
  const say = (key: string, params?: Record<string, string>) => serverText(key, lang, params);
  const text = renderError("err.reportLinkGone", lang);
  const step = (ic: IconName, title: string, sub: string, n: number) =>
    `<div><span class="phi">${icon(ic, 17)}</span><span><b>${esc(title)}</b><small>${esc(sub)}</small></span><span class="k">${n}</span></div>`;
  const main = `<section class="lk-panel lk-gone"><span class="gi">${icon("linkOff", 28)}</span>
<h1>${esc(say("print.gone.title"))}</h1>
<p class="lk-lead">${esc(text)}</p>
<div class="lk-callout"><b>${icon("shield", 16)}${esc(say("print.gone.whyTitle"))}</b><p>${esc(say("print.gone.why"))}</p></div>
<h2 class="lk-h">${esc(say("print.gone.howTitle"))}</h2>
<div class="lk-steps">${step("smartphone", say("print.gone.step1"), say("print.gone.step1Sub"), 1)}${step("clipboard", say("print.gone.step2", { section: uiText("tab.surveys", lang) }), say("print.gone.step2Sub"), 2)}${step("external", say("print.gone.step3", { button: uiText("ms.openConclusion", lang) }), say("print.gone.step3Sub"), 3)}</div>
</section>`;
  const causes = panel(
    say("print.gone.causes"),
    "help",
    `<div class="lk-li">${point("checkCheck", esc(say("print.gone.cause1")), "n")}${point("timer", esc(say("print.gone.cause2")), "n")}${point("userX", esc(say("print.gone.cause3")), "n")}</div>`,
  );
  return frame(lang, text, text, `<div class="lk-grid"><div>${main}</div><aside class="lk-side">${causes}${helpPanel(lang)}</aside></div>`);
}

/** Отказ при открытии живой ссылки (показ результатов выключили и т. п.): одна фраза на языке ссылки */
export function noticePage(lang: Lang, text: string): string {
  const title = serverText("print.notice.title", lang);
  const main = `<section class="lk-panel lk-gone"><span class="gi">${icon("help", 28)}</span><h1>${esc(title)}</h1><p class="lk-lead">${esc(text)}</p></section>`;
  return frame(lang, text, text, `<div class="lk-grid"><div>${main}</div><aside class="lk-side">${helpPanel(lang)}</aside></div>`);
}
