import type { ReactNode } from "react";
import type { UiKey } from "@quizzy/shared";
import type { TimelineItem } from "../../api";
import { Ic } from "../../ui";
import type { ActivityTone } from "../../ui/records";
import { ShellIcon } from "../../shell/icons";
import { DESTINATION_KEY, STATUS_KEY } from "../referrals/model";

/*
 * Событие хронологии пациента словами — для «Останні події» быстрого
 * просмотра и ленты «Хронологія» справы. Сервер отдаёт факты (вид, время,
 * название, состояние кодом), подписи собирает клиент на языке консоли.
 *
 * Красный — только тревога; янтарь — неявка и отменённое назначение;
 * зелёный — завершённое направление и подписанное заключение.
 */

/**
 * Вид события, как его показывает лента. Подпись каждого вида, приёма
 * тоже, — у eventView ниже (голова строки) и во множественном числе у
 * EVENT_PLURAL; отдельного словаря «вид → слово», в котором прежде не было
 * приёма, у ленты больше нет.
 */
export type EventKind = TimelineItem["kind"];

export const EVENT_KINDS: readonly EventKind[] = ["response", "alert", "referral", "conclusion", "assignment", "visit"];

/** Множественное название вида — для фильтра ленты и сводки «За курс» */
export const EVENT_PLURAL: Record<EventKind, UiKey> = {
  response: "evt.responses",
  alert: "evt.alerts",
  referral: "evt.referrals",
  conclusion: "evt.conclusions",
  assignment: "evt.assignments",
  visit: "evt.visits",
};

const VISIT_KEY: Record<string, UiKey> = {
  booked: "day.statusBooked",
  confirmed: "day.statusConfirmed",
  arrived: "day.statusArrived",
  in_progress: "day.statusInProgress",
  done: "day.statusDone",
  no_show: "day.statusNoShow",
  cancelled: "day.statusCancelled",
};

export interface EventView {
  kind: EventKind;
  icon: ReactNode;
  tone: ActivityTone;
  /** Жирное начало строки */
  head: string;
  /** Продолжение: что именно, кто, чем кончилось */
  rest: string | null;
  /** Куда ведёт строка; null — некуда */
  href: string | null;
  /** Пометка словом — пилюлей справа: чем кончилось направление, назначение, приём */
  badge: { text: string; tone: "good" | "attention" | "plain" | "info" } | null;
}

/** Что за событие: значок, тон, слова и ссылка. `ut` — перевод консоли. */
export function eventView(e: TimelineItem & { kind: EventKind }, ut: (k: UiKey, fallback?: string) => string): EventView {
  const rid = e.id.slice(e.id.indexOf(":") + 1);
  switch (e.kind) {
    case "response": {
      const surveyId = e.href?.startsWith("/surveys/") ? e.href.slice("/surveys/".length) : null;
      return {
        kind: e.kind,
        icon: <Ic.clipboard />,
        tone: "neutral",
        head: e.title || ut("tl.response"),
        rest: ut("evt.completed"),
        href: surveyId ? `/surveys/${surveyId}/responses/${rid}` : e.href ?? null,
        badge: null,
      };
    }
    case "alert":
      return {
        kind: e.kind,
        icon: <Ic.alert />,
        tone: "risk",
        head: ut("evt.signal"),
        rest: [e.title, e.detail].filter(Boolean).join(", "),
        href: e.href ?? "/alerts",
        badge: null,
      };
    case "referral": {
      const dest = DESTINATION_KEY[e.title as keyof typeof DESTINATION_KEY];
      const status = STATUS_KEY[e.detail as keyof typeof STATUS_KEY];
      return {
        kind: e.kind,
        icon: <ShellIcon name="arrow-right-left" />,
        tone: e.detail === "completed" ? "good" : "neutral",
        head: `${ut("evt.referralTo")} ${dest ? ut(dest).toLowerCase() : e.title}`,
        rest: null,
        href: e.href ?? "/referrals",
        badge: status
          ? { text: ut(status).toLowerCase(), tone: e.detail === "completed" ? "good" : e.detail === "declined" ? "plain" : "info" }
          : null,
      };
    }
    case "conclusion":
      return {
        kind: e.kind,
        icon: <ShellIcon name="file-pen-line" />,
        tone: e.detail === "signed" ? "good" : "neutral",
        head: e.detail === "signed" ? ut("evt.conclusionSigned") : ut("evt.conclusionDraft"),
        rest: e.title ? `«${e.title}»` : null,
        href: e.href ?? null,
        badge: null,
      };
    case "assignment":
      return {
        kind: e.kind,
        icon: <ShellIcon name="clipboard-check" />,
        tone: e.detail === "cancelled" ? "warn" : "neutral",
        head: `${ut("evt.assigned")} «${e.title}»`,
        rest: null,
        href: null,
        badge:
          e.detail === "completed"
            ? { text: ut("evt.done"), tone: "good" }
            : e.detail === "cancelled"
              ? { text: ut("evt.cancelled"), tone: "attention" }
              : { text: ut("evt.open"), tone: "plain" },
      };
    case "visit": {
      const status = VISIT_KEY[e.detail ?? ""];
      const noShow = e.detail === "no_show";
      return {
        kind: e.kind,
        icon: <Ic.calendar />,
        tone: noShow ? "warn" : e.detail === "done" ? "good" : "neutral",
        head: noShow ? ut("evt.noShow") : ut("evt.visitWith"),
        rest: e.title || null,
        href: e.href ?? null,
        badge: status && !noShow ? { text: ut(status), tone: e.detail === "done" ? "good" : "plain" } : null,
      };
    }
  }
}
