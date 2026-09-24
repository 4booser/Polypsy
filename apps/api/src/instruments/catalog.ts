import type { CreateSurveyDraft } from "@quizzy/shared";
import { audit10 } from "./audit10";
import { bigFive } from "./bigFive";
import { gad7 } from "./gad7";
import { pcl5 } from "./pcl5";
import { phq9 } from "./phq9";
import { pq16 } from "./pq16";
import { pss10 } from "./pss10";
import { who5 } from "./who5";
// группа «зависимости, внимание, выгорание» — docs/instruments/dossiers/behaviour.json
import { asrs6 } from "./asrs6";
import { ASSIST_NOT_SCORED, assist } from "./assist";
import { auditc } from "./auditc";
import { cage } from "./cage";
import { cbi } from "./cbi";

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
  /**
   * Пункты вне всех шкал — номерами с единицы и с причиной.
   *
   * По умолчанию каждый пункт методики каталога обязан входить в ключ: пункт вне
   * ключа — вопрос, на который человек отвечает впустую (test/catalog.test.ts).
   * Законное исключение — то, что сама методика запрещает считать: фильтры,
   * уточнение свободным текстом, отдельный пункт риска (ASSIST: Q1 и Q8).
   *
   * Перечисляются явно, а не выводятся из вида пункта. Правило «фильтр — значит
   * можно не считать» пропустило бы забытый в ключе Q2 ASSIST: он тоже фильтр, но
   * обязан считаться. Список же проверяется в обе стороны — пункт из него не
   * может стоять в ключе.
   */
  notScored?: { items: number[]; reason: string };
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

  /*
   * Группа «зависимости, внимание, выгорание» — docs/instruments/dossiers/behaviour.json.
   *
   * Заведены по решению учреждения, заявившего, что разрешения правообладателей у
   * него есть. Это закрывает лицензии, но не пороги и не перевод: каждая полоса
   * здесь сводится к записи досье, чужая норма и рабочий перевод названы в
   * описании самой методики. AIS и MDQ не заведены: текста пунктов в досье нет,
   * его пришлось бы выдумать.
   *
   * ASSIST — единственная методика каталога, которую заполняет специалист
   * (administration: "clinician"): ВОЗ не валидировала её для самозаполнения. В
   * список, доступный человеку без назначения, она поэтому не попадает — фильтр
   * видимости пациента пропускает только самоотчёт.
   */
  {
    key: "cage",
    draft: cage,
    source:
      "CAGE, Ewing, 1984 (JAMA 252:1905–1907; Bowles Center for Alcohol Studies, UNC). Український текст — офіційний: клінічна настанова МОЗ України «Психічні та поведінкові розлади внаслідок вживання алкоголю», КН 2025-1897 від 16.12.2025, додаток «CAGE»; російський — робочий переклад",
  },
  {
    key: "auditc",
    draft: auditc,
    source:
      "AUDIT-C: пункти 1–3 AUDIT (Babor та ін., ВООЗ, 2001); поріг — Bush та ін., Arch Intern Med 1998 (чоловіки); жінки — Bradley та ін., Arch Intern Med 2003. Переклад пунктів — той самий робочий, що в AUDIT каталогу",
  },
  {
    key: "assist",
    draft: assist,
    source:
      "ASSIST v3.1, ВООЗ: Humeniuk, Henry-Edwards, Ali, Poznyak, Monteiro, 2010 (Appendix A); валідація — Humeniuk та ін., Addiction 2008. Переклад робочий (ВООЗ вимагає реєструвати переклади; дозволи — за заявою закладу)",
    notScored: ASSIST_NOT_SCORED,
  },
  {
    key: "asrs6",
    draft: asrs6,
    source:
      "The 6-question Adult Self-Report Scale-Version1.1 (ASRS-V1.1) Screener is a subset of the 18-question Adult ADHD Self-Report Scale-Version1.1 (Adult ASRSV1.1) Symptom Checklist. © New York University and the President and Fellows of Harvard College. The ASRS v1.1 Screener was created by Dr. Lenard Adler of NYU and Dr. Ronald Kessler of Harvard. Психометрика — Kessler та ін., Psychol Med 2005. Переклад робочий",
  },
  {
    key: "cbi",
    draft: cbi,
    source:
      "Copenhagen Burnout Inventory, Kristensen, Borritz, Villadsen, Christensen, Work & Stress 2005 (NFA, Данія); смуги — датська форма самоперевірки NFA (Borritz, Kristensen). Переклад робочий",
  },
];
