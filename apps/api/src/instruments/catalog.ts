import type { CreateSurveyDraft } from "@quizzy/shared";
import { audit10, audit10Note } from "./audit10";
import { bigFive, bigFiveNote } from "./bigFive";
import { briefCope, briefCopeNote } from "./briefCope";
import { gad7, gad7Note } from "./gad7";
import { mspss, mspssNote } from "./mspss";
import { osss3, osss3Note } from "./osss3";
import { pcl5, pcl5Note } from "./pcl5";
import { phq9, phq9Note } from "./phq9";
import { pq16, pq16Note } from "./pq16";
import { pss10, pss10Note } from "./pss10";
import { rses, rsesNote } from "./rses";
import { ucla3, ucla3Note } from "./ucla3";
import { who5, who5Note } from "./who5";
// группа «mood» — отдельным блоком, как и её записи в конце CATALOG
import { cesdr, cesdrNote } from "./cesdr";
import { dass42, dass42Note } from "./dass42";
import { gds15, gds15Note } from "./gds15";
import { phq4, phq4Note } from "./phq4";
import { phq8, phq8Note } from "./phq8";
import { srq20, srq20Note } from "./srq20";
// группа «травма и военный контекст» — см. заголовок её блока в CATALOG
import { ces, cesNote } from "./ces";
import { pcptsd5, pcptsd5Note } from "./pcptsd5";
import { sbqr, sbqrNote } from "./sbqr";
// группа «зависимости, внимание, выгорание» — docs/instruments/dossiers/behaviour.json
import { asrs6, asrs6Note } from "./asrs6";
import { ASSIST_NOT_SCORED, assist, assistNote } from "./assist";
import { auditc, auditcNote } from "./auditc";
import { cage, cageNote } from "./cage";
import { cbi, cbiNote } from "./cbi";
// ── k-sleep ──
import { fas, fasNote } from "./fas";
import { ris, risNote } from "./ris";
import { sci, sciNote } from "./sci";
import { sci02, sci02Note } from "./sci02";
// ── /k-sleep ──
// ── k-wellbeing ──
import { flourishing, flourishingNote } from "./flourishing";
import { mlq, mlqNote } from "./mlq";
import { pss4, pss4Note } from "./pss4";
import { spane, spaneNote } from "./spane";
import { swls, swlsNote } from "./swls";
// ── /k-wellbeing ──
// ── k-staff ──
import { bat, bat12, batNote, bat12Note } from "./bat";
import { MIOS_NOT_SCORED, mios, miosNote } from "./mios";
import { proqol5, proqol5Note } from "./proqol5";
// ── /k-staff ──
// ── k-cognitive ──
import { adexi, adexiNote } from "./adexi";
import { fourAt, fourAtNote } from "./fourAt";
// ── /k-cognitive ──
// ── k-distress ──
import { core10, core10Note } from "./core10";
import { dass21, dass21Note } from "./dass21";
import { gad2, gad2Note } from "./gad2";
import { k10, k10Note } from "./k10";
import { k6, k6Note } from "./k6";
import { phq15, phq15Note } from "./phq15";
import { phq2, phq2Note } from "./phq2";
// ── /k-distress ──
// ── k-personality ──
import { aaq2, aaq2Note } from "./aaq2";
import { aq10, aq10Note } from "./aq10";
import { maas, maasNote } from "./maas";
import { scsSf, scsSfNote } from "./scsSf";
import { tipi, tipiNote } from "./tipi";
// ── /k-personality ──
// ── k-addiction ──
import { ciwaar, ciwaarNote } from "./ciwaar";
import { cows, cowsNote } from "./cows";
import { cuditr, cuditrNote } from "./cuditr";
// ── /k-addiction ──
// ── k-suicide ──
import { ASQ_NOT_SCORED, asq, asqNote } from "./asq";
import { CSSRS_NOT_SCORED, cssrs, cssrsNote } from "./cssrs";
import { sidas, sidasNote } from "./sidas";
// ── /k-suicide ──
// ── k-trauma ──
import { ctsrUa, ctsrUaNote } from "./ctsrUa";
import { ITQ_NOT_SCORED, itq, itqNote } from "./itq";
import { LEC5_NOT_SCORED, lec5, lec5Note } from "./lec5";
import { tgiSrPlus, tgiSrPlusNote } from "./tgiSrPlus";
// ── /k-trauma ──
// ── dp-scales ──
import { bprs, bprsNote } from "./bprs";
import { cgiI, cgiINote, cgiS, cgiSNote } from "./cgi";
import { hama, hamaNote } from "./hama";
import { hamd17, hamd17Note } from "./hamd17";
// ── /dp-scales ──

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
   * Примечание для персонала: чей текст и перевод, откуда пороги и на какой
   * выборке, чего система не считает.
   *
   * Раньше всё это стояло в описании, а описание читает обследуемый на
   * первом экране методики (patient/Runner.tsx, мобилка): человек перед
   * опросником о суициде читал про выборку ветеранов США и номера приказов.
   * Теперь описание — две строки о том, что и за какой срок спрашивают, а
   * это — специалисту: установщик кладёт его в surveys.source_note («Джерело»
   * в паспорте методики), правку суперадмина не перетирает
   * (lib/catalogInstall.ts, catalogSettings). Язык — украинский, как у
   * `source`: поле одно и не локализовано. Текст — в файле методики
   * (`<черновик>Note`), рядом с её решениями.
   */
  note: string;
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
    note: who5Note,
    source:
      "WHO-5 Well-Being Index, ВООЗ (Європейське регіональне бюро), 1998; з 2024 — ВООЗ, WHO/UCN/MSD/MHE/2024.1, CC BY-NC-SA 3.0 IGO; російський текст — переклад Psychiatric Research Unit (варіант 1999 р.), український — робочий",
  },
  {
    key: "gad7",
    draft: gad7,
    note: gad7Note,
    source:
      "GAD-7, Spitzer, Kroenke, Williams, Löwe, 2006; тексти пунктів — офіційні переклади правовласника «Ukrainian for Ukraine» і «Russian for Ukraine» (phqscreeners.com), українські відповіді — з PHQ-9 наказу МОЗ України №1003",
  },
  {
    key: "phq9",
    draft: phq9,
    note: phq9Note,
    source:
      "PHQ-9, Kroenke, Spitzer, Williams, 2001; український текст — додаток 1 до УКПМД «Депресія», наказ МОЗ України №1003 від 25.12.2014; російський — офіційний переклад правовласника «Russian for Ukraine» (phqscreeners.com)",
  },
  {
    key: "pss10",
    draft: pss10,
    note: pss10Note,
    source: "PSS-10, Cohen, Kamarck, Mermelstein, 1983/1988 (без смуг: у розробника порогів немає)",
  },
  {
    key: "pcl5",
    draft: pcl5,
    note: pcl5Note,
    source: "PCL-5, Weathers та ін., National Center for PTSD, 2013 (public domain)",
  },
  {
    key: "audit",
    draft: audit10,
    note: audit10Note,
    source:
      "AUDIT, Saunders та ін. для ВООЗ, 1993; посібник Babor та ін., ВООЗ, 2001. Пункти 1–3 — офіційний текст AUDIT-C: клінічна настанова МОЗ України КН 2025-1897, рисунок 4.1; пункти 4–10 — робочий переклад",
  },
  {
    key: "pq16",
    draft: pq16,
    note: pq16Note,
    source: "PQ-16, Ising, Veling, Loewy та ін., 2012",
  },
  {
    key: "big-five",
    draft: bigFive,
    note: bigFiveNote,
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
    note: phq4Note,
    source:
      "PHQ-4, Kroenke, Spitzer, Williams, Löwe, 2009 (public domain); PHQ-2 — текст з наказу МОЗ України №1003 від 25.12.2014, GAD-2 — український GAD-7 правовласника; російський — «Russian for Ukraine» (phqscreeners.com)",
  },
  {
    key: "phq8",
    draft: phq8,
    note: phq8Note,
    source:
      "PHQ-8, Kroenke, Strine та ін., 2009 (public domain); текст — пункти 1–8 PHQ-9 з наказу МОЗ України №1003 від 25.12.2014 і з російського перекладу правовласника «Russian for Ukraine» (phqscreeners.com)",
  },
  {
    key: "cesdr",
    draft: cesdr,
    note: cesdrNote,
    source: "CESD-R, Eaton, Smith, Ybarra, Muntaner, Tien, 2004 (public domain)",
  },
  {
    key: "srq20",
    draft: srq20,
    note: srq20Note,
    source: "SRQ-20, ВООЗ, Beusenberg, Orley, 1994 (WHO/MNH/PSF/94.8; лише некомерційне використання)",
  },
  {
    key: "gds15",
    draft: gds15,
    note: gds15Note,
    source: "GDS-15, Sheikh, Yesavage, 1986 (public domain)",
  },
  {
    key: "dass42",
    draft: dass42,
    note: dass42Note,
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
    note: pcptsd5Note,
    source:
      "PC-PTSD-5, Prins та ін., National Center for PTSD, 2015 (бланк 2022) — public domain за заявою правовласника; переклад пунктів робочий, офіційного україномовного тексту правовласник не випускав",
  },
  {
    key: "ces",
    draft: ces,
    note: cesNote,
    source:
      "Combat Exposure Scale, Keane та ін., National Center for PTSD, 1989 — вільне поширення правовласником (прямий PDF без плати); переклад пунктів робочий, офіційного україномовного тексту немає",
  },
  {
    key: "sbqr",
    draft: sbqr,
    note: sbqrNote,
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
    note: mspssNote,
    source: "MSPSS, Zimet, Dahlem, Zimet, Farley, 1988 (вільне використання з посиланням)",
  },
  {
    key: "osss3",
    draft: osss3,
    note: osss3Note,
    source: "OSSS-3, Kocalevent та ін., BMC Psychology, 2018 (CC BY 4.0); смуги — Bøen та ін., 2012",
  },
  {
    key: "rses",
    draft: rses,
    note: rsesNote,
    source: "Rosenberg Self-Esteem Scale, Rosenberg, 1965 (public domain, University of Maryland)",
  },
  {
    key: "ucla3",
    draft: ucla3,
    note: ucla3Note,
    source: "Three-Item Loneliness Scale, Hughes, Waite, Hawkley, Cacioppo, 2004 (UCLA)",
  },
  {
    key: "brief_cope",
    draft: briefCope,
    note: briefCopeNote,
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
    note: cageNote,
    source:
      "CAGE, Ewing, 1984 (JAMA 252:1905–1907; Bowles Center for Alcohol Studies, UNC). Український текст — офіційний: клінічна настанова МОЗ України «Психічні та поведінкові розлади внаслідок вживання алкоголю», КН 2025-1897 від 16.12.2025, додаток «CAGE»; російський — робочий переклад",
  },
  {
    key: "auditc",
    draft: auditc,
    note: auditcNote,
    source:
      "AUDIT-C: пункти 1–3 AUDIT (Babor та ін., ВООЗ, 2001); поріг — Bush та ін., Arch Intern Med 1998 (чоловіки); жінки — Bradley та ін., Arch Intern Med 2003. Український текст — офіційний: клінічна настанова МОЗ України КН 2025-1897, рисунок 4.1 «AUDIT-C»; російський — робочий переклад",
  },
  {
    key: "assist",
    draft: assist,
    note: assistNote,
    source:
      "ASSIST v3.1, ВООЗ: Humeniuk, Henry-Edwards, Ali, Poznyak, Monteiro, 2010 (Appendix A); валідація — Humeniuk та ін., Addiction 2008. Переклад робочий (ВООЗ вимагає реєструвати переклади; дозволи — за заявою закладу)",
    notScored: ASSIST_NOT_SCORED,
  },
  {
    key: "asrs6",
    draft: asrs6,
    note: asrs6Note,
    source:
      "The 6-question Adult Self-Report Scale-Version1.1 (ASRS-V1.1) Screener is a subset of the 18-question Adult ADHD Self-Report Scale-Version1.1 (Adult ASRSV1.1) Symptom Checklist. © New York University and the President and Fellows of Harvard College. The ASRS v1.1 Screener was created by Dr. Lenard Adler of NYU and Dr. Ronald Kessler of Harvard. Психометрика — Kessler та ін., Psychol Med 2005. Переклад робочий",
  },
  {
    key: "cbi",
    draft: cbi,
    note: cbiNote,
    source:
      "Copenhagen Burnout Inventory, Kristensen, Borritz, Villadsen, Christensen, Work & Stress 2005 (NFA, Данія); смуги — датська форма самоперевірки NFA (Borritz, Kristensen). Переклад робочий",
  },

  // ── k-sleep ──
  /*
   * Группа «сон и утомление» — docs/instruments/dossiers/sleep.json.
   *
   * Заведены только методики, у которых свободное использование в клинике
   * подтверждено словами правообладателя: SCI и её двухпунктовая версия
   * SCI-02 (Sleepio, CC BY-NC 4.0 — некоммерчески), FAS (ild care foundation:
   * «usage in clinical settings is permitted without restrictions»,
   * официальные украинский и русский тексты) и RIS (авторы, статья под
   * CC BY 2.0). Остальные карточки досье не заведены:
   * PROMIS Sleep Disturbance 8a, Sleep-Related Impairment 8a и Fatigue 7a для
   * рутинной оценки в своей цифровой платформе требуют разрешения HEAP и платы
   * (а таблицу T-баллов PROMIS движок не воспроизводит); STOP-Bang — разрешения
   * University Health Network для скрининга пациентов; ISI — договора с Mapi;
   * PSQI — платы за клиническое использование, и его компонентный подсчёт
   * моделью каталога не выражается; FSS — заявления правообладателя нет; AIS
   * не заведена ещё в группе behaviour по той же причине. Epworth исключена
   * брифом (платная).
   */
  {
    key: "sci",
    draft: sci,
    note: sciNote,
    source:
      "Sleep Condition Indicator, Espie, Kyle, Hames, Gardani, Fleming, Cape, BMJ Open 2014;4:e004183 — © Sleepio Limited, безкоштовно лише для некомерційного використання (CC BY-NC 4.0). Переклад робочий",
  },
  {
    key: "sci02",
    draft: sci02,
    note: sci02Note,
    source:
      "SCI-02: пункти 7 і 3 Sleep Condition Indicator; поріг ≤2 — Luik, Machado, Siriwardena, Espie, Br J Gen Pract 2019;69(679):79-80 — © Sleepio Limited, безкоштовно лише для некомерційного використання (CC BY-NC 4.0). Переклад робочий (той самий, що в SCI)",
  },
  {
    key: "fas",
    draft: fas,
    note: fasNote,
    source:
      "Fatigue Assessment Scale, Michielsen, De Vries, Van Heck, J Psychosom Res 2003 — © ild care foundation: використання в клінічних умовах дозволене без обмежень. Український і російський тексти — офіційні переклади правовласника (ildcare.nl; в українському виправлено дві орфографічні описки); смуги — настанови правовласника",
  },
  {
    key: "ris",
    draft: ris,
    note: risNote,
    source:
      "Regensburg Insomnia Scale, Crönlein, Langguth, Popp, Lukesch, Pieh, Hajak, Geisler, Health Qual Life Outcomes 2013;11:65 (CC BY 2.0). Переклад робочий — з німецького оригіналу зі звіркою за англійською версією авторів",
  },
  // ── /k-sleep ──
  // ── k-wellbeing ──
  /*
   * Группа «wellbeing»: благополучие, смысл, стресс —
   * docs/instruments/dossiers/wellbeing.json. Ключ каталога равен ключу досье.
   *
   * Полосы есть только у SWLS — описательные категории автора с его бланка,
   * «mild» без тревоги у двух нижних (решение каталога). Шкала процветания,
   * SPANE, MLQ и PSS-4 отдают сырые баллы: порогов у них нет в первоисточнике.
   *
   * Не заведены из той же группы досье: GSE (правообладатель разрешает только
   * некоммерческие исследования и запрещает публиковать шкалу в интернете, а
   * тексты пунктов каталога лежат в публичном репозитории), LOT-R (автор:
   * «not intended for clinical applications»), MHC-SF (заявления
   * правообладателя нет), EUROHIS-QOL 8 (пункты WHOQOL-BREF, нужна письменная
   * лицензия ВОЗ). BRS и WHODAS 2.0 перепроверены — основания по-прежнему нет
   * (карточки в function.json).
   */
  {
    key: "swls",
    draft: swls,
    note: swlsNote,
    source:
      "SWLS, Diener, Emmons, Larsen, Griffin, 1985 (вільне використання з посиланням); смуги — бланк правовласника; український текст — адаптація Олефіра, Боснюка, 2024 (CC BY 4.0), російський — робочий переклад з неї",
  },
  {
    key: "flourishing",
    draft: flourishing,
    note: flourishingNote,
    source:
      "Flourishing Scale, Diener та ін., 2009/2010 (вільне використання з посиланням); пункти 1, 3–8 — версії Юхименко-Лескроарт, Воєділової, 2024 (CC BY-NC 4.0) і Didino та ін., 2019 (CC BY 4.0), пункт 2 — робочий переклад",
  },
  {
    key: "spane",
    draft: spane,
    note: spaneNote,
    source:
      "SPANE, Diener та ін., 2009/2010 (вільне використання з посиланням); український текст — адаптація Олефіра, Боснюка, Малофейкіної, 2021 (CC BY 4.0), російський — робочий переклад з неї",
  },
  {
    key: "mlq",
    draft: mlq,
    note: mlqNote,
    source:
      "Meaning in Life Questionnaire, Steger, Frazier, Oishi, Kaler, 2006 (безкоштовно для терапевтичного використання без плати для клієнта); переклад робочий",
  },
  {
    key: "pss4",
    draft: pss4,
    note: pss4Note,
    source:
      "PSS-4, Cohen, Kamarck, Mermelstein, 1983 (без смуг: у розробника порогів немає); пункти — ті самі, що в PSS-10 каталогу",
  },
  // ── /k-wellbeing ──
  // ── k-staff ──
  /*
   * Группа «персонал»: выгорание, усталость от сострадания, вторичный
   * травматический стресс и моральная травма у сотрудников самого госпиталя —
   * психологов, медиков, командиров. Досье — docs/instruments/dossiers/staff.json;
   * ключи каталога равны ключам досье.
   *
   * Лицензии здесь не заявление учреждения, а слова правообладателей: BAT —
   * «non-proprietary and may be used free of charge without requesting permission»,
   * ProQOL — «may be freely copied» при указании автора и без продажи, MIOS —
   * «a public domain scale». У BAT украинский и русский тексты официальные (сайт
   * правообладателя), у ProQOL 5 и MIOS перевод рабочий — сказано в описании.
   *
   * Не заведены — с причиной в досье: UWES-9 (только научное использование), OLBI,
   * STSS, MMD-HP, MISS-HP, термометр морального дистресса (свободной лицензии нет),
   * Mini Z (разрешение не покрывает индивидуальный скрининг), ProQOL Health (сам
   * правообладатель: «still under development»), MIDS (лицензия и порог есть, но
   * её правило «часть 2 — если хоть один пункт части 1 больше нуля» движок без
   * условий «ИЛИ» выразить не может). Maslach — платный, по заданию не заводился.
   */
  {
    key: "bat",
    draft: bat,
    note: batNote,
    source:
      "Burnout Assessment Tool (BAT-23), Schaufeli, De Witte, Desart, KU Leuven, 2020 — non-proprietary, вільне використання без запиту дозволу (без змін, з посиланням на Schaufeli, Desart, De Witte, IJERPH 2020;17:9495). Український і російський тексти — офіційні переклади з сайту правовласника; пороги — клінічні фламандські (Test Manual v2.0, табл. 66)",
  },
  {
    key: "bat12",
    draft: bat12,
    note: bat12Note,
    source:
      "Burnout Assessment Tool, коротка версія (BAT-12), Schaufeli, De Witte, Desart, KU Leuven, 2020 — non-proprietary, вільне використання без запиту дозволу (без змін, з посиланням на IJERPH 2020;17:9495). Офіційні український і російський тексти правовласника; пороги — клінічні фламандські (Test Manual v2.0, табл. 73)",
  },
  {
    key: "proqol5",
    draft: proqol5,
    note: proqol5Note,
    source:
      "ProQOL 5, B. H. Stamm, 2009; правовласник — Center for Victims of Torture, www.ProQOL.org: «may be freely copied as long as (i) the author is credited, (ii) no changes are made, and (iii) that it is not sold». Смуги — офіційна форма самооцінки. Переклад робочий: українського ProQOL 5 немає, російський 2012 р. містить змістові помилки й не взятий",
  },
  {
    key: "mios",
    draft: mios,
    note: miosNote,
    source:
      "Moral Injury Outcome Scale, коротка клінічна версія: Litz та ін., MIOS Consortium, Frontiers in Psychiatry 2022;13:923928 (CC BY; «the MIOS is a public domain scale»). Без смуг: правовласник — «There are currently no proposed scoring categories or cut offs». Переклад робочий",
    notScored: MIOS_NOT_SCORED,
  },
  // ── /k-staff ──
  // ── k-cognitive ──
  /*
   * Группа «когнитивные функции, внимание, последствия ЧМТ» —
   * docs/instruments/dossiers/cognitive.json.
   *
   * Заведены две методики, у которых право на перевод и электронную форму
   * следует из слов самого правообладателя, а не из заявления учреждения:
   * 4AT — CC BY 4.0 (атрибуция с перечнем изменений стоит в описании),
   * ADEXI — «freely available for both researchers and clinicians». 4AT
   * заполняет специалист у постели больного (administration: "clinician"), и в
   * список, доступный человеку без назначения, она не попадает. У ADEXI полос
   * нет — норм нет у самого разработчика.
   *
   * Из того же досье не заведены, каждая с причиной в карточке: ASRS-18
   * (электронные версии запрещены правообладателем), AD8 (переводы и встраивание
   * в электронные системы исключены), 6CIT (права не подтверждены, центр закрыт),
   * SLUMS (рисунок, стимул, отсчёт времени, пороги по образованию), NSI, RPQ,
   * CFQ, MARS/O-Log (нет разрешения правообладателя), PROMIS (перевод только с
   * разрешения PHO), MPAI-4 (подсчёт движок не воспроизводит), DIVA-5 (плата за
   * каждое проведение).
   */
  {
    key: "4at",
    draft: fourAt,
    note: fourAtNote,
    source:
      "4AT, версія 1.2: MacLullich, Ryan, Cash, 2011–2014 (the4at.com), ліцензія CC BY 4.0; валідація — Bellelli та ін., Age Ageing 2014; метааналіз — Tieges та ін., Age Ageing 2021. Український текст — робочий переклад, російський — переклад із сайту правовласника (версія 1.1), виправлений за англійським оригіналом",
  },
  {
    key: "adexi",
    draft: adexi,
    note: adexiNote,
    source:
      "ADEXI (Adult Executive Functioning Inventory), Holst, Thorell, Int J Methods Psychiatr Res 2018 (Karolinska Institutet, www.chexi.se) — вільне використання для клініцистів і дослідників за заявою правовласника; без смуг — норм у розробника немає. Український текст — робочий переклад, російський — переклад із сайту правовласника (Zarina, Stanevich, Korman)",
  },
  // ── /k-cognitive ──
  // ── k-distress ──
  /*
   * Группа «distress»: дистресс, тревога, депрессия (каталог 2.1) —
   * docs/instruments/dossiers/distress.json. Каждая полоса, ключ и пункт
   * риска сведены к карточке досье; чужая норма и статус перевода названы в
   * описании методики. PHQ-2 и GAD-2 берут пункты из phq9.ts и gad7.ts, K6 — из
   * k10.ts: своего текста у них нет. Не заведены (в досье — почему): OASIS,
   * ODSIS, CAPE-P15, QIDS-SR16 — лицензия не подтверждена правообладателем
   * (у QIDS к тому же подсчёт по максимуму групп, которого нет в движке),
   * WSAS — копирайт I. M. Marks без свободного разрешения; MDQ — платная
   * лицензия (карточка в behaviour.json).
   */
  {
    key: "dass21",
    draft: dass21,
    note: dass21Note,
    source:
      "DASS-21, Lovibond, Lovibond, 1995 (public domain; без смуг — пороги лише в платному посібнику; бали × 2 за правилом розробників). Український текст — переклад Галецької, Кліманської, Перун (ЛНУ ім. І. Франка) із сайту розробників, п. 18 — робочий переклад; російський — переклад Фаттахова, Горобець, 2024, із сайту розробників",
  },
  {
    key: "k10",
    draft: k10,
    note: k10Note,
    source:
      "K10, Kessler та ін., Psychol Med 2002; Kessler та ін., Arch Gen Psychiatry 2003;60:184–189 — вільне використання за заявою розробника, Copyright © Ronald C. Kessler, PhD. Смуги — групування австралійських служб, ABS 4817.0.55.001 (2012), табл. F–G. Переклад робочий",
  },
  {
    key: "k6",
    draft: k6,
    note: k6Note,
    source:
      "K6, Kessler та ін., Arch Gen Psychiatry 2003;60:184–189 — вільне використання за заявою розробника, Copyright © Ronald C. Kessler, PhD; поріг 19+ у шкалі 1–5 — розробник (13+ у шкалі 0–24). Пункти 2, 4, 5, 8, 9, 10 K10; переклад робочий",
  },
  {
    key: "phq15",
    draft: phq15,
    note: phq15Note,
    source:
      "PHQ-15, Kroenke, Spitzer, Williams, 2002 (public domain); пороги 5/10/15 — посібник видавця. Російський текст — офіційний переклад видавця (MAPI, «Russian for Russia»), український — робочий",
  },
  {
    key: "phq2",
    draft: phq2,
    note: phq2Note,
    source:
      "PHQ-2, Kroenke, Spitzer, Williams, 2003 (public domain); текст — пункти 1–2 PHQ-9 з наказу МОЗ України №1003 від 25.12.2014",
  },
  {
    key: "gad2",
    draft: gad2,
    note: gad2Note,
    source:
      "GAD-2, Kroenke, Spitzer, Williams, Monahan, Löwe, 2007 (public domain); текст — пункти 1–2 GAD-7 каталогу, переклад робочий",
  },
  {
    key: "core10",
    draft: core10,
    note: core10Note,
    source:
      "CORE-10, Barkham та ін., Counselling and Psychotherapy Research 2013; © CORE System Trust, CC BY-NC-ND 4.0 — лише некомерційне використання, текст не змінювати. Український і російський тексти — затверджені переклади CST (2024); смуги — Connell, Barkham, CORE-10 User Manual, 2007",
  },
  // ── /k-distress ──
  // ── k-personality ──
  /*
   * Группа «personality»: черты, регуляция эмоций, осознанность,
   * самосострадание, привязанность, импульсивность —
   * docs/instruments/dossiers/personality.json.
   *
   * Отбор строже прежних групп: заводится только то, что правообладатель
   * своими словами разрешает в клинике (или «for any purpose»); разрешение
   * «для исследований» здесь не засчитано. Полосы — только опубликованные
   * правообладателем: у TIPI и MAAS их нет вовсе, у SCS-SF — «ad hoc rubric»
   * автора без тяжести, у AAQ-II — предварительный диапазон авторов без
   * тревоги, у AQ-10 — порог направления с бланка ARC.
   *
   * Не заведены, причины — в карточках досье: Mini-IPIP (все 20 пунктов уже
   * стоят в big-five), PID-5-BF (APA требует письменного разрешения на
   * перевод), DERS-16 (заявления правообладателя нет), ERQ (только «academic
   * research», лицензируется Stanford OTL), ECR-RS (о применении автор пишет
   * только для исследований), BIS-11 и BIS-15 («All Rights Reserved» без
   * разрешения), BIS/BAS (только «research and teaching»). Для
   * импульсивности свободной методики с разрешением на клинику не нашлось.
   */
  {
    key: "tipi",
    draft: tipi,
    note: tipiNote,
    source:
      "TIPI, Gosling, Rentfrow, Swann, J Res Pers 2003 («Anyone can use it for any purpose», S. D. Gosling). Український текст — TIPI-UKR, Кліманська, Галецька, Psychological Journal 2019 (CC BY-NC-SA 4.0); російський — TIPI-RU, Сергеєва, Кириллов, Джумагулова, Experimental Psychology (Russia) 2016; обидві адаптації перелічено на сторінці автора. Без смуг: порогів у автора немає",
  },
  {
    key: "scs_sf",
    draft: scsSf,
    note: scsSfNote,
    source:
      "SCS-SF, Raes, Pommier, Neff, Van Gucht, Clin Psychol Psychother 2011 (дозвіл K. Neff: «for any purpose whatsoever, including research, clinical work, teaching»); смуги — «ad hoc rubric» авторки. Переклад робочий",
  },
  {
    key: "maas",
    draft: maas,
    note: maasNote,
    source:
      "MAAS (trait), Brown, Ryan, J Pers Soc Psychol 2003 (public domain за листом K. W. Brown: «special permission is not required to use it for research or clinical purposes»). Без смуг: порогів у автора немає. Переклад робочий",
  },
  {
    key: "aaq2",
    draft: aaq2,
    note: aaq2Note,
    source:
      "AAQ-II, Bond, Hayes, Baer та ін., Behavior Therapy 2011 (дозвіл F. Bond: «for research and with clients»); смуги — попередній діапазон 24–28 авторів. Український текст пунктів — Широка, Миколайчук, Науковий вісник ХДУ 2021 (УКУ); російський — робочий переклад",
  },
  {
    key: "aq10",
    draft: aq10,
    note: aq10Note,
    source:
      "AQ-10 (Adult), Allison, Auyeung, Baron-Cohen, JAACAP 2012; Autism Research Centre, University of Cambridge — безкоштовно для некомерційного використання, переклад для некомерційних цілей без запиту (комерційне — ліцензія через ePROVIDE). Поріг ≥ 6 — з бланка ARC. Переклад робочий",
  },
  // ── /k-personality ──
  // ── k-addiction ──
  /*
   * Группа «addiction»: вещества и поведенческие зависимости, каталог 2.1 —
   * docs/instruments/dossiers/addiction.json. Ключ каталога равен ключу досье.
   *
   * Заведены три методики, у каждой — слова правообладателя о свободном
   * воспроизведении: CUDIT-R (public domain на авторском бланке), CIWA-Ar («not
   * copyrighted and may be reproduced freely») и COWS («may be copied and used
   * clinically»). У двух последних украинский текст официальный — из стандартов
   * медицинской помощи МЗ Украины 2025 г., и полосы тяжести тоже оттуда.
   *
   * Не заведены — каждая с цитатой и причиной в досье: DAST-10 (CAMH лицензирует
   * по запросу с расценкой), FTND и HSI (свободу воспроизведения утверждает NIDA,
   * не правообладатель), SDS, PGSI (CCSA требует письменного разрешения),
   * IGDS9-SF (CC BY-NC-ND, перевод — только с автором), BSMAS, CAGE-AID, DUDIT
   * (пороги по полу), SADQ-C и LDQ (официальный украинский текст есть, лицензии
   * оригинала нет), BBGS. Поведенческих зависимостей поэтому в группе нет: ни у
   * одного проверенного скринера гемблинга, игр или соцсетей нет свободного
   * разрешения правообладателя.
   *
   * CIWA-Ar и COWS заполняет специалист (administration: "clinician"), CUDIT-R —
   * самоотчёт.
   */
  {
    key: "cuditr",
    draft: cuditr,
    note: cuditrNote,
    source:
      "CUDIT-R, Adamson, Kay-Lambkin, Baker, Lewin, Thornton, Kelly, Sellman, Drug Alcohol Depend 2010;110:137–143 — «This scale is in the public domain and is free to use with appropriate citation» (бланк авторів); пороги 8 і 12 — з бланка. Переклад робочий",
  },
  {
    key: "ciwaar",
    draft: ciwaar,
    note: ciwaarNote,
    source:
      "CIWA-Ar, Sullivan, Sykora, Schneiderman, Naranjo, Sellers, Br J Addict 1989;84:1353–1357 — «The CIWA-Ar is not copyrighted and may be reproduced freely». Український текст і межі тяжкості — офіційні: додаток 9, розділ II і додаток 13 Стандарту медичної допомоги «Психічні та поведінкові розлади внаслідок вживання алкоголю», ГС 2025-1897, наказ МОЗ України від 16.12.2025 № 1897; російський — робочий переклад",
  },
  {
    key: "cows",
    draft: cows,
    note: cowsNote,
    source:
      "COWS, Wesson, Ling, J Psychoactive Drugs 2003;35(2):253–259 — «This version may be copied and used clinically» (Appendix 1). Український текст — офіційний: додаток 6 до Стандарту медичної допомоги «Психічні та поведінкові розлади внаслідок вживання опіоїдів», ГС 2025-1102, наказ МОЗ України від 11.07.2025 № 1102 (виправлено чотири друкарські помилки); російський — робочий переклад",
  },
  // ── /k-addiction ──
  // ── k-suicide ──
  /*
   * Группа «суицидальный риск» — docs/instruments/dossiers/suicide.json. Каждый пункт,
   * ключ, порог и пункт риска сводятся к карточке досье с цитатой правообладателя.
   *
   * ASQ и C-SSRS Screener проводит специалист (administration: "clinician"): у ASQ бланк
   * начинается с «Ask the patient» и валидирован опросом персоналом; у C-SSRS разрешение
   * правообладателя покрывает встраивание в систему учреждения, а самозаполнение на
   * устройстве — это eC-SSRS под лицензией Clario. SIDAS — самоотчёт, как в валидации.
   *
   * Суммы нет у C-SSRS вовсе (уровень риска — по самому тяжёлому «да»), у ASQ шкала — лишь
   * правило «да хотя бы на один из вопросов 1–4», записанное числом; острота у обеих — в
   * сигналах риска по пунктам. Не заведены (карточки досье с причиной): DSI-SS, P4, PSS-3 —
   * нет заявления правообладателя о свободном воспроизведении; SIBS — украинская и русская
   * версии не валидированы и выдаются только после регистрации.
   */
  {
    key: "asq",
    draft: asq,
    note: asqNote,
    source:
      "ASQ (Ask Suicide-Screening Questions), NIMH: Horowitz та ін., Arch Pediatr Adolesc Med 2012; дорослі — Horowitz та ін., Psychosomatics 2020. Бланк NIMH Toolkit 9/29/25, public domain. Російський текст запитань — офіційний переклад NIMH (2017); український — робочий переклад",
    notScored: ASQ_NOT_SCORED,
  },
  {
    key: "cssrs",
    draft: cssrs,
    note: cssrsNote,
    source:
      "C-SSRS Screener (Screen Version — Recent, з точками сортування ризику), Posner та ін., The Research Foundation for Mental Hygiene, 2008; валідизація — Posner та ін., Am J Psychiatry 2011. Український і російський тексти — офіційні переклади правовласника (The Columbia Lighthouse Project). Вільне використання й вбудовування в електронну систему закладу охорони здоров’я — за заявою правовласника",
    notScored: CSSRS_NOT_SCORED,
  },
  {
    key: "sidas",
    draft: sidas,
    note: sidasNote,
    source:
      "SIDAS, van Spijker, Batterham, Calear, Farrer, Christensen, Reynolds, Kerkhof, Suicide and Life-Threatening Behavior 2014 (Centre for Mental Health Research, ANU): «No permission required – please cite reference». Переклад робочий",
  },
  // ── /k-suicide ──
  // ── k-trauma ──
  /*
   * Травма, горе и война — каталог 2.1 (docs/instruments/dossiers/trauma.json; ключ каталога
   * равен ключу карточки).
   *
   * В отличие от первых трёх методик группы, лицензия здесь не держится на заявлении
   * учреждения: у каждой — слова правообладателя в карточке досье. Чей текст — бланк
   * правообладателя или наш рабочий перевод — сказано в описании самой методики. Там же
   * сказано, что методика считает меньше, чем на бумаге, если так: диагностические алгоритмы с
   * порогом по пункту и «И» по кластерам движку не выразить — его шкала линейна.
   *
   * Не заведены (причины — в карточках досье): PG-13-R (воспроизведение только с разрешения
   * авторов по запросу), DAR-5 и TSQ (нет заявления правообладателя о свободном
   * воспроизведении), PTGI-SF (выдаётся по запросу), IES-R (правообладатель отказал), MISS-M-SF
   * (нет порога и разрешения), IPGDS (ключ подсчёта «у розробці»), MIDS (правило «все ответы
   * части 1 — ноль, дальше не заполнять» требует «ИЛИ» по шести пунктам, а условия показа
   * движка соединяются только через «И»).
   */
  {
    key: "itq",
    draft: itq,
    note: itqNote,
    source:
      "ITQ, Cloitre, Shevlin, Brewin, Bisson, Roberts, Maercker, Karatzias, Hyland, International Trauma Consortium, Acta Psychiatr Scand 2018 — public domain за заявою правовласника; український і російський тексти — бланки ITC (українську версію досліджено: Ho та ін., J Trauma Stress 2023). Рахуються розмірні бали; діагностичний алгоритм система не обчислює",
    notScored: ITQ_NOT_SCORED,
  },
  {
    key: "tgi_sr_plus",
    draft: tgiSrPlus,
    note: tgiSrPlusNote,
    source:
      "TGI-SR+, Lenferink, Eisma, Smid, de Keijser, Boelen, Compr Psychiatry 2022 — CC BY 4.0 (https://osf.io/rqn5k/); український і російський тексти — переклад Boelen та ін., 2022, виправлено друкарські помилки бланків; український поріг — Rispa Hoyos та ін., Clin Psychol Eur 2026",
  },
  {
    key: "ctsr_ua",
    draft: ctsrUa,
    note: ctsrUaNote,
    source:
      "CTSR, оновлена українська версія: Frankova, Senyk, Avramchuk, Leshchuk, Rudys, Kurapov, Goral, Eur J Psychotraumatol 2025 — CC BY-NC 4.0, лише некомерційне використання; оригінал — Goral та ін., PLoS One 2021. Російський текст — робочий переклад",
  },
  {
    key: "lec5",
    draft: lec5,
    note: lec5Note,
    source:
      "LEC-5 (стандартна версія), Weathers, Blake, Schnurr, Kaloupek, Marx, Keane, National Center for PTSD, 2013 (бланк 2018) — public domain за заявою правовласника; балу немає за визначенням правовласника; переклад робочий",
    notScored: LEC5_NOT_SCORED,
  },
  // ── /k-trauma ──
  // ── dp-scales ──
  /*
   * Группа «шкалы, которые заполняет специалист» — стандартные клинические
   * шкалы психиатрического отделения; docs/instruments/dossiers/clinician.json,
   * ключ каталога равен ключу карточки.
   *
   * Основание у каждой — заявление NINDS CDE (NIH, США) о том, что шкала —
   * общественное достояние; текст — редакция руководства ECDEU (Guy, 1976,
   * издание Минздрава США), перевод — собственный рабочий на оба языка. Все
   * заполняет специалист (administration: "clinician"), результат пациенту не
   * показывается. Полосы случая риска не открывают — это собственная оценка
   * того, кто заполнил (обоснование — в hamd17.ts); тревогу поднимают только
   * суицидальные ответы.
   */
  {
    key: "hamd17",
    draft: hamd17,
    note: hamd17Note,
    source:
      "HAM-D-17, Hamilton, J Neurol Neurosurg Psychiatry 1960; Br J Soc Clin Psychol 1967 — суспільне надбання за NINDS CDE; текст — редакція ECDEU Assessment Manual for Psychopharmacology (Guy, 1976, DHEW (ADM) 76-338). Смуги — Zimmerman та ін., J Affect Disord 2013. Переклад робочий",
  },
  {
    key: "hama",
    draft: hama,
    note: hamaNote,
    source:
      "HAM-A, Hamilton, Br J Med Psychol 1959 — суспільне надбання за NINDS CDE; текст — редакція ECDEU Assessment Manual for Psychopharmacology (Guy, 1976, DHEW (ADM) 76-338). Смуги — Matza та ін., Int J Methods Psychiatr Res 2010. Переклад робочий",
  },
  {
    key: "cgi_s",
    draft: cgiS,
    note: cgiSNote,
    source:
      "CGI-S (Clinical Global Impression — Severity of Illness), Guy, ECDEU Assessment Manual for Psychopharmacology, 1976, DHEW (ADM) 76-338, с. 217–222 — видання уряду США, суспільне надбання за NINDS CDE; клінічне застосування — Busner, Targum, Psychiatry (Edgmont) 2007. Переклад робочий",
  },
  {
    key: "cgi_i",
    draft: cgiI,
    note: cgiINote,
    source:
      "CGI-I (Clinical Global Impression — Global Improvement), Guy, ECDEU Assessment Manual for Psychopharmacology, 1976, DHEW (ADM) 76-338, с. 217–222 — видання уряду США, суспільне надбання за NINDS CDE; клінічне застосування — Busner, Targum, Psychiatry (Edgmont) 2007. Переклад робочий",
  },
  {
    key: "bprs",
    draft: bprs,
    note: bprsNote,
    source:
      "BPRS (18 пунктів), Overall, Gorham, Psychol Rep 1962 — суспільне надбання за NINDS CDE; текст — редакція ECDEU Assessment Manual for Psychopharmacology (Guy, 1976, DHEW (ADM) 76-338). Без смуг: опублікованих порогів немає; орієнтир CGI — Leucht та ін., Br J Psychiatry 2005. Переклад робочий",
  },
  // ── /dp-scales ──
];
