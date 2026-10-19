import type { AlertCase, PatientCard, Permission, RespondentDynamics, ResponseDetail, SafetyPlan } from "@quizzy/shared";
import type { NoteState } from "../../api";
import type { Assignment, InstrumentRow, TimelineRow, Visit } from "./clinical";
import type { ThreadLike } from "./listModel";

/** Виды ящика карточки: разбор, переписка, заключение, нотатка, запись на приём */
export type PaneMode = "signal" | "thread" | "concl" | "note" | "book";

export interface OpenOpts {
  /** Заключение — по этому прохождению */
  responseId?: string;
  /** Переписка — с этим слотом переноса */
  slotId?: string;
}

export interface ThreadMessage {
  id: string;
  mine: boolean;
  text: string;
  sentAt: string;
  readAt: string | null;
}

/** Всё, что знает карточка об одном человеке, — одним объектом для панелей и видов ящика */
export interface CardView {
  id: string;
  card: PatientCard;
  now: number;
  dynamics: RespondentDynamics | null;
  /** Динамика не пришла — панели говорят об этом и дают «Повторити», а не крутят скелет вечно */
  dynamicsError: string | null;
  reloadDynamics: () => void;
  timeline: TimelineRow[] | null;
  visits: Visit[];
  next: Visit | null;
  last: { visit: Visit; n: number } | null;
  noShow: Visit | null;
  assignments: Assignment[];
  /** Открытые случаи риска; null — грузятся или не пришли (см. casesError), [] — нет или нет права */
  cases: AlertCase[] | null;
  /** Случаи не пришли: открытый риск неизвестен — это не «нічого відкритого» */
  casesError: string | null;
  reloadCases: () => void;
  thread: ThreadLike | null;
  messages: ThreadMessage[] | null;
  notes: NoteState | null;
  /** Действующая версия плана безпеки; null — плана нет или он ещё не пришёл (см. planKnown) */
  plan: SafetyPlan | null;
  /** Версии плана пришли: только тогда «плану немає» — правда */
  planKnown: boolean;
  planError: string | null;
  reloadPlan: () => void;
  details: Record<string, ResponseDetail | null>;
  rows: InstrumentRow[];
  /** Я ли веду ближайший приём: перенос — только в свои окна */
  nextIsMine: boolean;
  /** Выбранный слот переноса — общий у панели «Наступний прийом» и ящика */
  slotId: string | null;
  setSlotId: (id: string | null) => void;
  open: (mode: PaneMode, opts?: OpenOpts) => void;
  /** Перейти на вкладку карточки («Хронологія», «Заключення») */
  goTab: (tab: "overview" | "measures" | "dynamics" | "conclusions" | "visits" | "messages" | "notes" | "timeline") => void;
  /** Открыт ли ящик и на каком виде — пилюли строки рисуются «нажатыми» */
  pane: PaneMode | null;
  can: (p: Permission) => boolean;
  reload: () => void;
}
