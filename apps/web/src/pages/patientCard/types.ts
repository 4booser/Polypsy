import type { AlertCase, PatientCard, Permission, Referral, RespondentDynamics, SafetyPlan } from "@quizzy/shared";
import type { ConclusionState, NoteState } from "../../api";
import type { Assignment, PictureGroup, TimelineRow, Visit } from "./clinical";
import type { ThreadLike } from "./listModel";

/**
 * Виды ящика рабочего места: разбор сигнала, переписка, заключение, запись
 * прийому, запись на приём, план безпеки, звернення, направлення.
 */
export type PaneMode = "signal" | "thread" | "concl" | "note" | "book" | "plan" | "episode" | "referral";

/**
 * Вкладки рабочего места пациента — одна на каждый вид сведений о человеке.
 * Прежние «Графіки», «Заключення», «Нотатки», «Прийоми» и вкладки
 * клинической карты («Огляд справи», «Динаміка», «Хронологія») сошлись сюда:
 * у каждого сведения один дом (tabs.ts — какой прежний адрес куда ведёт).
 */
export type CardTab = "overview" | "dynamics" | "measures" | "records" | "referrals" | "messages" | "timeline";

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

/** Всё, что рабочее место знает об одном человеке, — одним объектом для вкладок и видов ящика */
export interface CardView {
  id: string;
  card: PatientCard;
  now: number;
  dynamics: RespondentDynamics | null;
  /** Динамика не пришла — панели говорят об этом и дают «Повторити», а не крутят скелет вечно */
  dynamicsError: string | null;
  reloadDynamics: () => void;
  /** Клиническая картина по доменам — из динамики и доменов карточки (clinical.ts) */
  picture: PictureGroup[];
  timeline: TimelineRow[] | null;
  timelineError: string | null;
  reloadTimeline: () => void;
  visits: Visit[];
  /** Ближайший записанный приём — по хронологии: она перечитывается после записи и переноса */
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
  notesError: string | null;
  reloadNotes: () => void;
  /** Действующая версия плана безпеки; null — плана нет или он ещё не пришёл (см. planKnown) */
  plan: SafetyPlan | null;
  /** Версии плана пришли: только тогда «плану немає» — правда */
  planKnown: boolean;
  planError: string | null;
  reloadPlan: () => void;
  /** Я ли веду ближайший приём: перенос — только в свои окна */
  nextIsMine: boolean;
  /** Выбранный слот переноса — общий у ящика переписки и его вида переноса */
  slotId: string | null;
  setSlotId: (id: string | null) => void;
  open: (mode: PaneMode, opts?: OpenOpts) => void;
  /** «Призначити методику» — общий ящик назначения; null — нет права назначать */
  onAssign: (() => void) | null;
  /** Перейти на вкладку; `extra` — её отбор в адресе (методика «Динаміки», вид «Записів») */
  goTab: (tab: CardTab, extra?: Record<string, string | null>) => void;
  /** Открыт ли ящик и на каком виде — кнопки шапки рисуются «нажатыми» */
  pane: PaneMode | null;
  can: (p: Permission) => boolean;
  refresh: CardRefresh;
}

/**
 * Что перечитать после действия в ящике — только то, что действие меняет
 * (волна 27).
 *
 * Прежде любое действие перечитывало всё: карточку, хронологию, разговоры,
 * письма, нотатки, случаи и план безпеки. Пять из этих чтений пишут журнал
 * (карточка — patient.card_read, хронология, нотатки, план — response.read,
 * случаи — alert.list), и «Зберегти чернетку» нотатки оставляло пять строк о
 * чтениях, которых человек не делал, — а подпись после сохранения десять.
 * Чтение карточки — одно на открытие.
 */
export interface CardRefresh {
  /** Разговоры; письма открытого разговора идут за ним сами — их загрузка ключена временем последнего письма и непрочитанным */
  messages: () => void;
  /** Хронология: в ней приёмы (записали, перенесли) и события заключений */
  timeline: () => void;
  /** Нотатки: ответ сохранения или подписи — их новое состояние; без него — перечитать (чужая правка, 409) */
  notes: (state?: NoteState) => void;
  /** Строки «Заключення» карточки — из ответа сохранения или подписи, без нового чтения карточки */
  conclusion: (responseId: string, state: ConclusionState) => void;
  /** Обращение открыли или закрыли — карточка правится на месте тем, что знает ящик */
  episode: (episode: PatientCard["episode"]) => void;
  /** Направление выписали или сдвинули — «План» огляда правится по ответу действия */
  referral: (r: Referral) => void;
}
