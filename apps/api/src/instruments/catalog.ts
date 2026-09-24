import type { CreateSurveyDraft } from "@quizzy/shared";
import { audit10 } from "./audit10";
import { bigFive } from "./bigFive";
import { briefCope } from "./briefCope";
import { gad7 } from "./gad7";
import { mspss } from "./mspss";
import { osss3 } from "./osss3";
import { pcl5 } from "./pcl5";
import { phq9 } from "./phq9";
import { pq16 } from "./pq16";
import { pss10 } from "./pss10";
import { rses } from "./rses";
import { ucla3 } from "./ucla3";
import { who5 } from "./who5";
// группа «mood» — отдельным блоком, как и её записи в конце CATALOG
import { cesdr } from "./cesdr";
import { dass42 } from "./dass42";
import { gds15 } from "./gds15";
import { phq4 } from "./phq4";
import { phq8 } from "./phq8";
import { srq20 } from "./srq20";
// группа «травма и военный контекст» — см. заголовок её блока в CATALOG
import { ces } from "./ces";
import { pcptsd5 } from "./pcptsd5";
import { sbqr } from "./sbqr";
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
    source:
      "PHQ-9, Kroenke, Spitzer, Williams, 2001; український текст — додаток 1 до УКПМД «Депресія», наказ МОЗ України №1003 від 25.12.2014",
  },
  {
    key: "pss10",
    draft: pss10,
    source: "PSS-10, Cohen, Kamarck, Mermelstein, 1983/1988 (без смуг: у розробника порогів немає)",
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
   * ── Группа «mood»: настроение, тревога, дистресс ──
   *
   * Каждая запись сверена с досье docs/instruments/dossiers/mood.json:
   * пункты, ключ, полосы и пункты риска — оттуда, а не из памяти. Из досье
   * НЕ заведены: STAI, CES-D, HSCL-25, BDI-II, BAI, HADS, GHQ-12, MADRS —
   * у одних нет текста (лицензия), у других нет разрешения на онлайн-
   * публикацию; CESD-R с доказанным public domain заменяет CES-D.
   */
  {
    key: "phq4",
    draft: phq4,
    source:
      "PHQ-4, Kroenke, Spitzer, Williams, Löwe, 2009 (public domain); PHQ-2 — текст з наказу МОЗ України №1003 від 25.12.2014",
  },
  {
    key: "phq8",
    draft: phq8,
    source:
      "PHQ-8, Kroenke, Strine та ін., 2009 (public domain); текст — пункти 1–8 PHQ-9 з наказу МОЗ України №1003 від 25.12.2014",
  },
  {
    key: "cesdr",
    draft: cesdr,
    source: "CESD-R, Eaton, Smith, Ybarra, Muntaner, Tien, 2004 (public domain)",
  },
  {
    key: "srq20",
    draft: srq20,
    source: "SRQ-20, ВООЗ, Beusenberg, Orley, 1994 (WHO/MNH/PSF/94.8; лише некомерційне використання)",
  },
  {
    key: "gds15",
    draft: gds15,
    source: "GDS-15, Sheikh, Yesavage, 1986 (public domain)",
  },
  {
    key: "dass42",
    draft: dass42,
    source: "DASS-42, Lovibond, Lovibond, 1995 (public domain; без смуг — пороги лише в платному посібнику)",
  },

  /*
   * ─── Травма и военный контекст (docs/instruments/dossiers/trauma.json) ───
   *
   * Добавлены по решению учреждения, заявившего, что разрешения
   * правообладателей у него есть. Заявление закрывает вопрос лицензий, но не
   * вопрос порогов и не вопрос перевода: у всех трёх пороги установлены в
   * США, а текст пунктов переведён при сборке каталога (официального
   * украинского текста правообладатели не выпускали) — и то и другое
   * написано в описании самой методики, где его видит выбирающий, а не
   * только здесь. Украинская версия PC-PTSD-5 от ТОВ «ЮЕЙ-ТЕСТ» не взята:
   * это не перевод правообладателя, и её текст закрыт «Всі права
   * застережено».
   *
   * Остальные три карточки досье не заведены: у IES-6 и C-SSRS Screen
   * текст пунктов в досье не приведён (без бланка правообладателя его
   * пришлось бы выдумать), у MIES нет порогов, а первоисточник противоречит
   * сам себе в направлении шкалы ответов. Ключи каталога совпадают с
   * ключами досье — по ним запись каталога сводится к первоисточнику.
   *
   * Эта группа расширяет исходные восемь, о которых говорит заголовок
   * файла: те же правила, но решение о лицензии принято учреждением.
   */
  {
    key: "pcptsd5",
    draft: pcptsd5,
    source:
      "PC-PTSD-5, Prins та ін., National Center for PTSD, 2015 (бланк 2022) — public domain за заявою правовласника; переклад пунктів робочий, офіційного україномовного тексту правовласник не випускав",
  },
  {
    key: "ces",
    draft: ces,
    source:
      "Combat Exposure Scale, Keane та ін., National Center for PTSD, 1989 — вільне поширення правовласником (прямий PDF без плати); переклад пунктів робочий, офіційного україномовного тексту немає",
  },
  {
    key: "sbqr",
    draft: sbqr,
    source:
      "SBQ-R, Osman та ін., 2001 — «© Osman et al (1999) Revised. Permission for use granted by A. Osman, MD» (на бланку), дозвіл отримано закладом; переклад пунктів робочий, офіційного україномовного тексту немає",
  },

  /*
   * ── Группа «function»: функционирование, ресурсы, поддержка ──
   *
   * Источник каждой записи — docs/instruments/dossiers/function.json; ключ
   * каталога равен ключу досье, чтобы от методики в базе до цитаты
   * правообладателя был один поиск. Полосы есть только у двух (MSPSS —
   * ориентир автора в средних баллах, OSSS-3 — Bøen et al. через
   * Kocalevent et al.); RSES, UCLA-3 и Brief COPE отдают сырые баллы,
   * потому что порогов у них нет в первоисточнике.
   *
   * Не заведены из той же группы досье: WHODAS 2.0 (текст пунктов не
   * воспроизводится без лицензии ВОЗ — в досье его нет) и BRS (заявления
   * правообладателя нет, текста пунктов в досье нет). Карточка без пунктов
   * здесь хуже отсутствующей: её можно назначить, а пройти нельзя.
   */
  {
    key: "mspss",
    draft: mspss,
    source: "MSPSS, Zimet, Dahlem, Zimet, Farley, 1988 (вільне використання з посиланням)",
  },
  {
    key: "osss3",
    draft: osss3,
    source: "OSSS-3, Kocalevent та ін., BMC Psychology, 2018 (CC BY 4.0); смуги — Bøen та ін., 2012",
  },
  {
    key: "rses",
    draft: rses,
    source: "Rosenberg Self-Esteem Scale, Rosenberg, 1965 (public domain, University of Maryland)",
  },
  {
    key: "ucla3",
    draft: ucla3,
    source: "Three-Item Loneliness Scale, Hughes, Waite, Hawkley, Cacioppo, 2004 (UCLA)",
  },
  {
    key: "brief_cope",
    draft: briefCope,
    source: "Brief COPE, Carver, 1997 (дозвіл автора, University of Miami)",
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
