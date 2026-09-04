import type { CreateSurveyDraft } from "@quizzy/shared";
import { audit10 } from "./audit10";
import { bigFive } from "./bigFive";
import { gad7 } from "./gad7";
import { pcl5 } from "./pcl5";
import { phq9 } from "./phq9";
import { pq16 } from "./pq16";
import { pss10 } from "./pss10";
import { who5 } from "./who5";

/**
 * Общий каталог общедоступных методик.
 *
 * Восемь опросников, которые ставятся в каждый экземпляр по умолчанию и
 * доступны человеку без назначения. Отбор шёл по одному жёсткому условию:
 * **методику должно быть законно воспроизводить и переводить бесплатно**.
 * Опросник, за который платят за прохождение, в общедоступный список
 * попасть не может — не потому, что дорого, а потому, что список,
 * работающий пока не кончится лицензия, хуже отсутствующего.
 *
 * Что из этого следует и о чём нельзя молчать: пороги всех восьми
 * установлены для оригинала и его официальных переводов, а текст пунктов
 * здесь переведён при сборке каталога. Проект уже принимал это решение в
 * другую сторону — английскую локализацию отложили именно потому, что свой
 * перевод пунктов означает инструмент, считающий людей по нормам, снятым с
 * другого текста. Здесь то же самое, и оговорка едет вместе с методикой, в
 * её описании (см. WORKING_TRANSLATION в ./common). Исключение одно:
 * пункты IPIP — общественное достояние и переводятся без оговорок о
 * лицензии, но валидированных украиноязычных норм у них тоже нет, поэтому
 * «велика п’ятірка» отдаёт сырые баллы, а не стены.
 *
 * Ключ (`key`) — устойчивое имя методики. Именно по нему установщик узнаёт
 * уже поставленную методику на повторном выкате; переименование в консоли
 * его не задевает.
 */
export interface CatalogEntry {
  key: string;
  draft: CreateSurveyDraft;
  /** Откуда взята методика — попадает в журнал установки */
  source: string;
}

export const CATALOG: CatalogEntry[] = [
  {
    key: "who5",
    draft: who5,
    source: "WHO-5 Well-Being Index, ВООЗ (Європейське регіональне бюро), 1998",
  },
  {
    key: "gad7",
    draft: gad7,
    source: "GAD-7, Spitzer, Kroenke, Williams, Löwe, 2006",
  },
  {
    key: "phq9",
    draft: phq9,
    source: "PHQ-9, Kroenke, Spitzer, Williams, 2001",
  },
  {
    key: "pss10",
    draft: pss10,
    source: "PSS-10, Cohen, Kamarck, Mermelstein, 1983/1988",
  },
  {
    key: "pcl5",
    draft: pcl5,
    source: "PCL-5, Weathers та ін., National Center for PTSD, 2013 (public domain)",
  },
  {
    key: "audit",
    draft: audit10,
    source: "AUDIT, Saunders та ін. для ВООЗ, 1993",
  },
  {
    key: "pq16",
    draft: pq16,
    source: "PQ-16, Ising, Veling, Loewy та ін., 2012",
  },
  {
    key: "big-five",
    draft: bigFive,
    source: "IPIP Big-Five Factor Markers, Goldberg, 1992 (public domain)",
  },
];
