import { useEffect, useState, type ReactNode } from "react";
import {
  ActivityList,
  AlertChip,
  AlertStrip,
  Avatar,
  BigValue,
  BigValues,
  BulkBar,
  Callout,
  ConfirmByName,
  CourseDigits,
  DataTable,
  DialogFrame,
  Drawer,
  DrawerPane,
  DrawerSection,
  Empty,
  FilterBar,
  FilterChip,
  Ic,
  Kbd,
  KbdHints,
  KV,
  ListGroup,
  ListTile,
  Loading,
  Modal,
  PersonCell,
  Popover,
  PopoverCard,
  RiskChip,
  RiskTimer,
  Skeleton,
  TextAction,
  ToastView,
  Tooltip,
  TooltipPlate,
  BetterTag,
  ChangeCell,
  useAction,
  useToast,
  type Column,
} from "../ui";
import { Count, Page, Panel, Stack } from "../ui/layout";
import { MenuGroupLabel, MenuPanel, MenuSeparator, menuItemClass } from "../ui/menu";
import {
  Button,
  CheckLabel,
  Checkbox,
  ChoiceCard,
  ErrorText,
  Field,
  Input,
  Radio,
  Segmented,
  Select,
  SeverityTag,
  Stat,
  Switch,
  Tabs,
  Tag,
  Textarea,
} from "../ui/primitives";

/**
 * Страница дизайн-системы «Виразна» — живая: каждый компонент набора во всех
 * состояниях, в той теме, что включена (переключатель — в шапке страницы).
 *
 * Нужна не для красоты. Увидев здесь нужный кусок, его берут отсюда, а не
 * рисуют заново — так согласованность держится без договорённостей. По этой
 * странице снимаются эталонные снимки и прогоняется проверка доступности в
 * обеих темах: расхождение видно до того, как попадёт к человеку.
 *
 * Данные — демонстрационные (набор: Мельник Андрій, сигнал № 214, PHQ-9
 * 19 → 16 → 14). Строки страницы словарём не переводятся: её читает
 * разработчик (см. noRawStrings.test.ts).
 */

/* ─────────── данные витрины ─────────── */

type Swatch = [token: string, name: string, note: string];

const SURFACES: Swatch[] = [
  ["--ground", "ground", "тло сторінки"],
  ["--panel", "panel", "панель, поле, меню"],
  ["--panel2", "panel2", "шапки таблиць"],
  ["--sunk", "sunk", "заглиблене, наведення"],
  ["--border", "border", "межа панелі"],
  ["--text", "text", "текст"],
  ["--text-2", "text2", "другорядний"],
  ["--muted", "muted", "підписи"],
];

const BRAND: Swatch[] = [
  ["--appbar", "appbar", "панель застосунку"],
  ["--v", "v", "основна дія, вибране"],
  ["--vink", "vink", "фіолетовий текст, посилання"],
  ["--vtint", "vtint", "вибраний рядок"],
  ["--band", "band", "смуга картки"],
  ["--vline", "vline", "обвідка вибраного"],
  ["--field-border", "field-border", "межі полів, 3:1"],
  ["--series", "series", "одна серія графіка"],
];

const STATES: Swatch[] = [
  ["--risk", "risk", "лише ризик"],
  ["--riskink", "riskink", "текст ризику"],
  ["--risktint", "risktint", "тло ризику"],
  ["--warn", "warn", "прострочено, неявка"],
  ["--warntint", "warntint", "тло уваги"],
  ["--good", "good", "надійно краще, готово"],
  ["--goodtint", "goodtint", "тло готового"],
  ["--info", "info", "повідомлення"],
];

const TYPE: [cls: string, spec: string, sample: string][] = [
  ["text-page", "28 / 32, 800 — заголовок сторінки", "Сьогодні"],
  ["text-title", "26 / 30, 800 — людина в смузі картки", "Мельник Андрій Олегович"],
  ["text-big", "22 / 28, 800 — ключовий факт", "Сб 10.10, 10:30–11:20"],
  ["text-section", "15.5 / 20, 800 — заголовок панелі", "Методики"],
  ["text-h3", "15 / 20, 800 — розділ панелі дії", "План безпеки"],
  ["text-body", "13.5 / 20, 500 — основний текст", "Сума PHQ-9 водночас знизилась 16 → 14; сон без змін (3 бали)."],
  ["text-small", "12.5 / 18 — пояснення, підписи", "Зміна надійна, коли перевищує поріг RCI (95 %)."],
  ["text-caption", "12 / 16, 700, muted — підпис поля", "Відповідь Андрія"],
  ["text-stat", "32, 800 — велике значення", "14"],
];

interface Patient {
  id: string;
  name: string;
  initials: string;
  age: number;
  card: string;
  reason: ReactNode;
  score: number;
  sev: { word: string; level: "none" | "mild" | "moderate" | "modsevere" | "severe" };
  course: number[];
  next: string;
  risk?: boolean;
}

const PATIENTS: Patient[] = [
  {
    id: "p1",
    name: "Мельник Андрій Олегович",
    initials: "МА",
    age: 38,
    card: "0117",
    reason: (
      <Tag tone="danger" icon={<Ic.alert />}>
        сигнал № 214
      </Tag>
    ),
    score: 14,
    sev: { word: "помірна", level: "moderate" },
    course: [19, 16, 14],
    next: "сб 10.10, 10:30",
    risk: true,
  },
  {
    id: "p2",
    name: "Бойко Тарас Ігорович",
    initials: "БТ",
    age: 45,
    card: "0089",
    reason: (
      <Tag tone="handover" icon={<Ic.phone />}>
        № 213 у чергового
      </Tag>
    ),
    score: 23,
    sev: { word: "тяжка", level: "severe" },
    course: [21, 22, 23],
    next: "сьогодні, 18:00, онлайн",
  },
  {
    id: "p3",
    name: "Шевченко Марія Василівна",
    initials: "ШМ",
    age: 52,
    card: "0142",
    reason: (
      <Tag tone="info" icon={<Ic.message />}>
        повідомлення 16:20
      </Tag>
    ),
    score: 13,
    sev: { word: "помірна", level: "moderate" },
    course: [15, 13, 13],
    next: "пн 12.10, 09:30",
  },
  {
    id: "p4",
    name: "Гончаренко Віра Степанівна",
    initials: "ГВ",
    age: 63,
    card: "0071",
    reason: (
      <Tag tone="plain" icon={<Ic.clipboard />}>
        PHQ-9 учора
      </Tag>
    ),
    score: 12,
    sev: { word: "помірна", level: "moderate" },
    course: [13, 14, 12],
    next: "пн 12.10, 13:00",
  },
  {
    id: "p5",
    name: "Ткаченко Сергій Іванович",
    initials: "ТС",
    age: 57,
    card: "0058",
    reason: (
      <Tag tone="attention" icon={<Ic.calendar />}>
        неявка 07.10
      </Tag>
    ),
    score: 11,
    sev: { word: "помірна", level: "moderate" },
    course: [10, 10, 11],
    next: "не записано",
  },
];

const PEEK = (
  <>
    <span className="block">PHQ-9 від 08.10, пункт 9 — «кілька днів», 1 бал. Уперше за курс.</span>
    <span className="mt-1.5 block">
      Норма розбору 4 год: минуло <b className="font-extrabold text-text">2:48</b>, лишилося 1:12, до 18:12.
    </span>
    <span className="mt-1.5 block text-muted">Черговий Олег Бондар, до 08:00.</span>
  </>
);

/* ─────────── витрина ─────────── */

/** Текущая тема страницы (data-theme на <html>), живая */
function useTheme(): ["light" | "dark", (t: "light" | "dark") => void] {
  const read = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
  const [theme, setTheme] = useState<"light" | "dark">(read);
  useEffect(() => {
    const mo = new MutationObserver(() => setTheme(read()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  const set = (t: "light" | "dark") => {
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("quizzy.theme.v2", t);
    } catch {
      /* закрытое хранилище: тема живёт до перезагрузки */
    }
  };
  return [theme, set];
}

/** Значение токена в текущей теме — для подписи образца цвета */
function useTokenValue(token: string, theme: string): string {
  const [value, setValue] = useState("");
  useEffect(() => {
    setValue(getComputedStyle(document.documentElement).getPropertyValue(token).trim().toUpperCase());
  }, [token, theme]);
  return value;
}

function SwatchTile({ token, name, note, theme }: { token: string; name: string; note: string; theme: string }) {
  const value = useTokenValue(token, theme);
  return (
    <div className="min-w-0">
      <div className="h-14 rounded-control border border-border" style={{ background: `var(${token})` }} />
      <b className="mt-2 block text-[13px] font-extrabold text-text">{name}</b>
      <span className="block text-caption text-muted">{note}</span>
      <span className="block font-mono text-[11px] text-muted">{value}</span>
    </div>
  );
}

function SwatchRow({ title, items, theme }: { title: string; items: Swatch[]; theme: string }) {
  return (
    <div>
      <p className="m-0 mb-2 text-caption font-bold text-muted">{title}</p>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
        {items.map(([token, name, note]) => (
          <SwatchTile key={token} token={token} name={name} note={note} theme={theme} />
        ))}
      </div>
    </div>
  );
}

/** Раздел страницы: заголовок 22/800 и приглушённая подпись, как на макете дизайн-системы */
function Section({ id, title, sub, children }: { id: string; title: string; sub: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-4">
      <div className="mb-3 mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`${id}-h`} className="m-0 text-big font-extrabold text-text">
          {title}
        </h2>
        <span className="text-small text-text-2">{sub}</span>
      </div>
      {children}
    </section>
  );
}

/** Подпись группы примеров внутри панели */
function Label({ children }: { children: ReactNode }) {
  return <p className="m-0 mb-2 text-caption font-bold text-muted">{children}</p>;
}

const INDEX: [id: string, label: string, icon: ReactNode][] = [
  ["colors", "Кольори", <Ic.palette key="i" />],
  ["type", "Шрифт", <Ic.type key="i" />],
  ["buttons", "Кнопки", <Ic.mousePointer key="i" />],
  ["pills", "Пігулки", <Ic.layers key="i" />],
  ["record", "Список і запис", <Ic.list key="i" />],
  ["table", "Таблиця й фільтри", <Ic.table key="i" />],
  ["fields", "Поля", <Ic.pen key="i" />],
  ["numbers", "Числа", <Ic.hash key="i" />],
  ["states", "Стани", <Ic.inbox key="i" />],
  ["overlays", "Накладки", <Ic.layers key="i" />],
  ["rules", "Правила", <Ic.list key="i" />],
];

export default function UiKit() {
  const [theme, setTheme] = useTheme();
  const toast = useToast();
  const { run } = useAction();

  /* ящик: два вида, у каждого свой черновик */
  const [drawer, setDrawer] = useState<{ open: boolean; mode: string }>({ open: false, mode: "signal" });
  const [decision, setDecision] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [reply, setReply] = useState("");
  const openDrawer = (mode: string) => setDrawer({ open: true, mode });

  /* окна */
  const [modal, setModal] = useState(false);
  const [codes, setCodes] = useState(false);
  const [confirm, setConfirm] = useState(false);

  /* поля и таблица */
  const [query, setQuery] = useState("");
  const [view, setView] = useState("mine");
  const [sort, setSort] = useState("risk");
  const [mine, setMine] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(["p3", "p4"]));
  const [remind, setRemind] = useState(true);
  const [notify, setNotify] = useState(true);
  const [quiet, setQuiet] = useState(false);
  const [place, setPlace] = useState("office");
  const [seg, setSeg] = useState<"phq" | "gad" | "pcl" | "who">("phq");
  const [tab, setTab] = useState("overview");
  const [choice, setChoice] = useState("low");

  const columns: Column<Patient>[] = [
    {
      key: "name",
      header: "Пацієнт",
      required: true,
      sort: (r) => r.name,
      render: (r) => (
        <PersonCell
          name={r.name}
          sub={`${r.age} р., карта ${r.card}`}
          avatar={<Avatar name={r.name} initials={r.initials} size={28} />}
          peek={r.risk ? PEEK : undefined}
          peekTitle={r.risk ? "Сигнал ризику № 214" : undefined}
        />
      ),
    },
    { key: "reason", header: "Причина", render: (r) => r.reason },
    {
      key: "score",
      header: "Останній замір",
      sort: (r) => r.score,
      render: (r) => (
        <span className="inline-flex items-center gap-2">
          <b className="text-[15px] font-extrabold">{r.score}</b>
          <SeverityTag level={r.sev.level} small>
            {r.sev.word}
          </SeverityTag>
        </span>
      ),
    },
    { key: "course", header: "Курс", render: (r) => <CourseDigits code="PHQ-9" values={r.course} better="down" /> },
    { key: "next", header: "Наступний прийом", sort: (r) => r.next, render: (r) => <span className="text-text-2">{r.next}</span> },
  ];

  const draftDirty = decision !== "" || reviewNote.trim() !== "";

  return (
    <Page
      title="Дизайн-система"
      meta={["«Виразна»", "Токени, шрифт, компоненти, стани, накладки й правила"]}
      actions={
        <Segmented
          label="Тема"
          value={theme}
          onChange={setTheme}
          items={[
            { key: "light", label: "Світла" },
            { key: "dark", label: "Темна" },
          ]}
        />
      }
    >
      <div className="grid grid-cols-[200px_minmax(0,1fr)] items-start gap-6 max-[1100px]:grid-cols-1">
        <nav aria-label="Розділи дизайн-системи" className="sticky top-0 flex flex-col gap-0.5 max-[1100px]:hidden">
          {INDEX.map(([id, label, icon]) => (
            <a
              key={id}
              href={`#${id}`}
              className="flex h-[38px] items-center gap-2.5 rounded-[11px] px-2.5 text-body font-semibold text-text-2 no-underline hover:bg-sunk hover:text-text hover:no-underline [&>svg]:size-4 [&>svg]:text-muted"
            >
              {icon}
              {label}
            </a>
          ))}
        </nav>

        <div className="flex min-w-0 flex-col gap-7">
          {/* ─────────── кольори ─────────── */}
          <Section id="colors" title="Кольори" sub="світла й темна тема; у модулях — лише токени">
            <Panel>
              <Stack>
                <SwatchRow title="Поверхні й текст" items={SURFACES} theme={theme} />
                <SwatchRow title="Бренд" items={BRAND} theme={theme} />
                <SwatchRow title="Стан" items={STATES} theme={theme} />
                <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-6">
                  <div>
                    <Label>Тяжкість — завжди зі словом</Label>
                    <div className="flex flex-wrap gap-1.5">
                      <SeverityTag level="none">мінімальна</SeverityTag>
                      <SeverityTag level="mild">легка</SeverityTag>
                      <SeverityTag level="moderate">помірна</SeverityTag>
                      <SeverityTag level="modsevere">помірно тяжка</SeverityTag>
                      <SeverityTag level="severe">тяжка</SeverityTag>
                    </div>
                    <p className="m-0 mt-2 text-small text-text-2">Колір підказує, слово каже. Червоний відтінок — лише «тяжка».</p>
                  </div>
                  <div>
                    <Label>Серії графіків, перевірені валідатором</Label>
                    <div className="grid grid-cols-5 gap-2">
                      {[
                        ["--c1", "c1", "PHQ-9"],
                        ["--c2", "c2", "GAD-7"],
                        ["--c3", "c3", "PCL-5"],
                        ["--c4", "c4", "WHO-5"],
                        ["--c5", "c5", "інше"],
                      ].map(([t, n, what]) => (
                        <div key={t}>
                          <div className="h-12 rounded-control" style={{ background: `var(${t})` }} />
                          <b className="mt-1.5 block text-caption font-extrabold">{n}</b>
                          <span className="block text-caption text-muted">{what}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <Label>Теплова шкала (значення в кожній клітинці)</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <span
                          key={n}
                          className="inline-grid h-6 w-11 place-items-center rounded-[6px] text-caption font-bold"
                          style={{ background: `var(--h${n})`, color: `var(--h${n}i)` }}
                        >
                          {n - 1}
                        </span>
                      ))}
                      <span className="inline-grid h-6 w-11 place-items-center rounded-[6px] bg-risk text-caption font-bold text-onfill">1</span>
                    </div>
                    <p className="m-0 mt-2 text-small text-text-2">Остання — критична відповідь, лише для ризику.</p>
                  </div>
                </div>
              </Stack>
            </Panel>
          </Section>

          {/* ─────────── шрифт ─────────── */}
          <Section id="type" title="Шрифт" sub="Manrope, табличні цифри">
            <Panel flush>
              <dl className="m-0">
                {TYPE.map(([cls, spec, sample]) => (
                  <div key={cls} className="grid grid-cols-[230px_minmax(0,1fr)] items-baseline gap-4 border-t border-divider px-4 py-3 first:border-t-0">
                    <dt className="text-caption text-muted">
                      <code className="rounded-[5px] bg-sunk px-1.5 py-0.5 font-mono text-[11.5px] font-bold text-text-2">.{cls}</code>
                      <span className="mt-1 block">{spec}</span>
                    </dt>
                    <dd className={`m-0 ${cls} ${cls === "text-caption" ? "font-bold text-muted" : cls === "text-body" || cls === "text-small" ? "text-text" : "font-extrabold text-text"}`}>
                      {sample}
                    </dd>
                  </div>
                ))}
              </dl>
            </Panel>
          </Section>

          {/* ─────────── кнопки ─────────── */}
          <Section id="buttons" title="Кнопки" sub="40 і 32 px, радіус 10; основна залита, другорядні тоновані">
            <Panel>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(380px,1fr))] gap-6">
                <Stack className="gap-3">
                  <Label>40 px: основна, тонована, тиха, ризик</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="primary">Зберегти розбір</Button>
                    <Button icon={<Ic.message />}>Написати</Button>
                    <Button variant="ghost">Хронологія</Button>
                    <Button variant="risk">Розібрати</Button>
                    <Tooltip label="Записати на прийом" kbd="C">
                      <Button size="icon" aria-label="Записати на прийом">
                        <Ic.calendar />
                      </Button>
                    </Tooltip>
                  </div>
                  <Label>32 px</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="primary" size="xs" icon={<Ic.pen />}>
                      Підписати
                    </Button>
                    <Button size="xs">Продовжити</Button>
                    <Button variant="ghost" size="xs" icon={<Ic.reply />}>
                      Відповісти
                    </Button>
                    <Button variant="risk" size="xs">
                      Розібрати
                    </Button>
                    <Button variant="quiet" size="icon-sm" aria-label="Ще дії">
                      <Ic.ellipsis />
                    </Button>
                  </div>
                  <Label>48 і 52 px (пацієнт), значок у кінці</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="primary" size="md" iconEnd={<Ic.arrowRight />}>
                      Почати
                    </Button>
                    <Button size="md" icon={<Ic.bell />}>
                      Пізніше
                    </Button>
                    <Button variant="primary" size="lg" iconEnd={<Ic.arrowRight />}>
                      Далі: GAD-7
                    </Button>
                  </div>
                </Stack>
                <Stack className="gap-3">
                  <Label>Стани</Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="primary" disabled icon={<Ic.pen />}>
                      Підписати
                    </Button>
                    <Button aria-expanded icon={<Ic.message />}>
                      Відкрито в панелі
                    </Button>
                    <Button variant="primary" icon={<Ic.calendar />}>
                      Перенести й відповісти
                    </Button>
                    <Kbd>M</Kbd>
                  </div>
                  <Label>На тонованому тлі</Label>
                  <div className="flex flex-wrap items-center gap-2 rounded-panel bg-sunk p-3">
                    <Button variant="paper" size="xs">
                      Відкрити
                    </Button>
                    <Button variant="paper" size="xs" icon={<Ic.plus />}>
                      Призначити
                    </Button>
                    <Button variant="panel" size="xs" icon={<Ic.clipboard />}>
                      Призначити методику
                    </Button>
                  </div>
                  <p className="m-0 text-small text-text-2">
                    Одна основна дія на область. Кнопка називає дію. Червона — лише дія над ризиком для людини; видалення й
                    скасування — звичайні кнопки з підтвердженням (variant=&quot;danger&quot; виглядає звичайною).
                  </p>
                </Stack>
              </div>
            </Panel>
          </Section>

          {/* ─────────── пігулки й рядок відкритого ─────────── */}
          <Section id="pills" title="Пігулки й рядок відкритого" sub="причина, стан, тяжкість">
            <Panel>
              <Stack>
                <div>
                  <Label>Пігулки причини й стану (24 px)</Label>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Tag tone="danger" icon={<Ic.timer />}>
                      сигнал 2:48 з 4 год
                    </Tag>
                    <Tag tone="handover" icon={<Ic.phone />}>
                      у чергового
                    </Tag>
                    <Tag tone="attention" icon={<Ic.calendar />}>
                      неявка 07.10
                    </Tag>
                    <Tag tone="primary" icon={<Ic.calendar />}>
                      прийом 17:30
                    </Tag>
                    <Tag tone="info" icon={<Ic.message />}>
                      повідомлення 16:20
                    </Tag>
                    <Tag icon={<Ic.clipboard />}>PHQ-9 учора</Tag>
                    <Tag tone="good" icon={<Ic.check />}>
                      підписано
                    </Tag>
                    <Tag icon={<Ic.pen />}>чернетка</Tag>
                    <Tag tone="done" icon={<Ic.check />}>
                      стабільно
                    </Tag>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <BetterTag direction="down" />
                  <BetterTag direction="up" />
                  <Count n={7} />
                  <Count n={2} tone="risk" />
                  <Count n={2} tone="violet" />
                  <Count n={14} tone="tint" />
                  <CourseDigits code="PHQ-9" values={[19, 16, 14]} better="down" />
                  <CourseDigits code="GAD-7" values={[12, 13, 15]} better="down" />
                  <CourseDigits code="PHQ-9" values={[16]} better="down" />
                </div>
                <div>
                  <Label>Рядок відкритого — підпис стилю: кожна відкрита річ про людину з власною дією</Label>
                  <div className="rounded-drawer border border-band-card-line bg-band-card p-3 shadow-banner">
                    <AlertStrip>
                      <RiskChip
                        title="Сигнал № 214"
                        timer={<RiskTimer elapsed="2:48" of="4 год" pct={70} />}
                        pop={PEEK}
                        popTitle="Сигнал ризику № 214"
                        popNote="о 14:12"
                        action={
                          <Tooltip label="Розібрати сигнал" kbd="R">
                            <Button variant="risk" size="xs" className="rounded-2xl" onClick={() => openDrawer("signal")}>
                              Розібрати
                            </Button>
                          </Tooltip>
                        }
                      />
                      <AlertChip
                        kind="message"
                        icon={<Ic.message />}
                        label="Повідомлення"
                        detail="учора"
                        onClick={() => openDrawer("reply")}
                        pressed={drawer.open && drawer.mode === "reply"}
                        draft={!drawer.open && reply.trim() !== ""}
                        pop="Просить перенести суботу на вечір. Без відповіді 1 день."
                      />
                      <AlertChip kind="warn" icon={<Ic.calendar />} label="Неявка 02.10" pop="Неявка на сесію 6: «викликали на зміну»." />
                      <AlertChip icon={<Ic.pen />} label="Чернетка № 0451" locked pop="Підпис відкриється після розбору сигналу № 214." />
                      <AlertChip icon={<Ic.clipboard />} label="ISI до 15.10" pop="Призначено 08.10, не розпочато." />
                      <AlertChip kind="good" icon={<Ic.shieldCheck />} label="Згода на обробку даних підписана" />
                    </AlertStrip>
                  </div>
                </div>
              </Stack>
            </Panel>
          </Section>

          {/* ─────────── список і запис ─────────── */}
          <Section id="record" title="Список і запис" sub="плитки з причиною, хронологія, люди">
            <div className="grid grid-cols-[340px_minmax(0,1fr)] items-start gap-5 max-[1280px]:grid-cols-1">
              <Panel flush>
                <div className="pb-2 pt-1">
                  <ListGroup label="Дія зараз" count={2} mark="risk" note="норма розбору 4 год" />
                  <ListTile
                    title="Мельник Андрій Олегович"
                    meta="38 р."
                    selected
                    reason={
                      <Tag tone="danger" icon={<Ic.timer />}>
                        сигнал 2:48 з 4 год
                      </Tag>
                    }
                    aside={<CourseDigits code="PHQ-9" values={[19, 16, 14]} better="down" />}
                    next="Розібрати № 214 до 18:12"
                    nextIcon={<Ic.alert />}
                    when="сб 10.10, 10:30"
                    peek={PEEK}
                    peekTitle="Мельник Андрій Олегович"
                  />
                  <ListTile
                    title="Поліщук Анна Олексіївна"
                    meta="19 р."
                    reason={
                      <Tag tone="attention" icon={<Ic.timer />}>
                        план безпеки, −2 дн.
                      </Tag>
                    }
                    aside={<CourseDigits code="PHQ-9" values={[17, 20]} better="down" />}
                    next="Оновити план після № 211"
                    nextIcon={<Ic.shieldCheck />}
                    when="пт 09.10, 10:00"
                  />
                  <ListGroup label="Прийом сьогодні" count={3} mark="violet" note="до 20:00" />
                  <ListTile
                    title="Коваленко Оксана Петрівна"
                    meta="29 р."
                    unread
                    reason={
                      <Tag tone="primary" icon={<Ic.calendar />}>
                        прийом 17:30
                      </Tag>
                    }
                    aside={<CourseDigits code="GAD-7" values={[14, 12, 9]} better="down" />}
                    why="Сесія 4: план готовий, щоденник сну здано."
                    next="Провести сесію 4"
                    nextIcon={<Ic.clipboard />}
                    when="каб. 214"
                    whenToday
                  />
                </div>
              </Panel>
              <Stack>
                <Panel
                  title="Після сесії 5"
                  icon={<Ic.history />}
                  sub="25.09, 13 днів тому"
                  actions={<TextAction>Хронологія</TextAction>}
                  flush
                >
                  <ActivityList
                    events={[
                      { date: "25.09", icon: <Ic.circleCheck />, tone: "good", text: <>Сесія 5. Щоденник сну здано; дихання 4-7-8 <span className="text-muted">не відмічено</span></> },
                      { date: "02.10", time: "10:30", icon: <Ic.calendar />, tone: "warn", text: <><b>Неявка на сесію 6</b> «викликали на зміну»</> },
                      {
                        date: "08.10",
                        time: "14:12",
                        icon: <Ic.alert />,
                        tone: "risk",
                        text: <><b>Сигнал № 214</b>: пункт 9 «кілька днів»</>,
                        action: <TextAction onClick={() => openDrawer("signal")}>Розібрати</TextAction>,
                      },
                      { date: "08.10", time: "14:20", icon: <Ic.clipboard />, text: <>Призначено ISI до 15.10 <span className="text-muted">не розпочато</span></> },
                    ]}
                  />
                </Panel>
                <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] items-start gap-4">
                  <Panel title="Коротко" icon={<Ic.idCard />}>
                    <KV
                      rows={[
                        ["Народження", <><b className="font-extrabold">12.05.1988</b>, 38 р.</>],
                        ["Телефон", "+380 67 482 19 06"],
                        ["Веде", "Ірина Савчук, з 24.08"],
                      ]}
                    />
                  </Panel>
                  <Panel title="Люди" icon={<Ic.users />}>
                    <Stack className="gap-3">
                      <PersonCell
                        name="Мельник Андрій Олегович"
                        sub="38 р., карта 0117"
                        avatar={<Avatar name="Мельник Андрій" size={34} />}
                      />
                      <PersonCell
                        name="Олег Бондар"
                        sub="черговий психолог, до 08:00"
                        avatar={<Avatar name="Олег Бондар" size={34} tone="neutral" initials="ОБ" />}
                      />
                      <div className="flex items-center gap-2">
                        <Avatar name="Мельник Андрій" size={28} />
                        <Avatar name="Мельник Андрій" size={34} />
                        <Avatar name="Мельник Андрій" size={44} />
                        <Avatar name="Мельник Андрій" size={56} />
                        <Avatar name="Олег Бондар" size={34} tone="soft" initials="ОБ" />
                        <Avatar name="Віктор Ткач" size={34} tone="neutral" initials="ВТ" />
                      </div>
                    </Stack>
                  </Panel>
                </div>
                <p className="m-0 text-small text-text-2">
                  Плитка списку: ім’я й вік; пігулка причини й мінікурс; наступна дія й прийом. Наведення чи фокус на імені — короткий
                  огляд. J/K ходять рядками, «/» шукає.
                </p>
              </Stack>
            </div>
          </Section>

          {/* ─────────── таблиця й фільтри ─────────── */}
          <Section id="table" title="Таблиця й фільтри" sub="щільна таблиця: сортування, вибір, дії рядка, сторінки">
            <Panel flush>
              <div className="px-4 pb-2 pt-4">
                <FilterBar
                  search={{ value: query, onChange: setQuery, placeholder: "ПІБ, картка або телефон" }}
                  chips={
                    <>
                      <FilterChip label="Закріплені за мною" on={mine} onClear={() => setMine(false)} onClick={() => setMine(true)} />
                      <FilterChip label="Методика" value="PHQ-9" />
                      <FilterChip label="Фахівець" />
                      <FilterChip add />
                    </>
                  }
                  sort={{
                    value: sort,
                    onChange: setSort,
                    options: [
                      { key: "risk", label: "ризик спершу" },
                      { key: "next", label: "найближчий прийом" },
                      { key: "name", label: "за прізвищем" },
                    ],
                  }}
                />
                <FilterBar
                  className="mt-2"
                  views={{
                    value: view,
                    onChange: setView,
                    label: "Збережені перегляди списку",
                    items: [
                      { key: "mine", label: "Мої", count: 34 },
                      { key: "risk", label: "Ризик", count: 2, risk: true },
                      { key: "today", label: "Сьогодні", count: 3 },
                      { key: "all", label: "Усі", count: 248 },
                    ],
                  }}
                  count={{ shown: 5, total: 248 }}
                />
              </div>
              <DataTable
                rows={PATIENTS.filter((p) => !query || p.name.toLowerCase().includes(query.toLowerCase()))}
                columns={columns}
                rowKey={(r) => r.id}
                selectable
                selected={picked}
                onSelectedChange={setPicked}
                rowTone={(r) => (r.risk ? "risk" : undefined)}
                isRowActive={(r) => drawer.open && r.id === "p1"}
                onRowClick={() => openDrawer("signal")}
                bulkActions={() => (
                  <>
                    <Button variant="panel" size="xs" icon={<Ic.clipboard />}>
                      Призначити методику
                    </Button>
                    <Button variant="panel" size="xs" icon={<Ic.message />}>
                      Написати
                    </Button>
                  </>
                )}
                rowActions={(r) => (
                  <>
                    <Tooltip label="Відкрити в панелі">
                      <Button variant="quiet" size="icon-sm" aria-label={`Відкрити в панелі: ${r.name}`} onClick={() => openDrawer("signal")}>
                        <Ic.eye />
                      </Button>
                    </Tooltip>
                    <Tooltip label="Написати">
                      <Button variant="quiet" size="icon-sm" aria-label={`Написати: ${r.name}`} onClick={() => openDrawer("reply")}>
                        <Ic.message />
                      </Button>
                    </Tooltip>
                  </>
                )}
                pageSize={10}
                label="Пацієнти"
              />
              <KbdHints
                bar
                keys={[
                  ["J K", "рядки"],
                  ["X", "вибрати"],
                  ["Enter", "відкрити"],
                  ["/", "пошук"],
                ]}
              />
            </Panel>
            <div className="mt-3">
              <BulkBar count={2} total={34} onSelectAll={() => {}} onClear={() => {}}>
                <Button variant="panel" size="xs" icon={<Ic.users />}>
                  Додати до групи
                </Button>
              </BulkBar>
            </div>
          </Section>

          {/* ─────────── поля ─────────── */}
          <Section id="fields" title="Поля" sub="стани: звичайне, фокус, помилка, недоступне">
            <Panel>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-x-5 max-[1100px]:grid-cols-1">
                <div>
                  <Field label="Прізвище й ім’я">
                    <Input defaultValue="Мельник Андрій" icon={<Ic.user />} />
                  </Field>
                  <Field label="Фахівець" hint="Можна змінити пізніше в картці">
                    <Select defaultValue="is">
                      <option value="is">Ірина Савчук</option>
                      <option value="ob">Олег Бондар</option>
                    </Select>
                  </Field>
                  <Field label="Картка" hint="Номер призначає система">
                    <Input defaultValue="0117" disabled />
                  </Field>
                </div>
                <div>
                  <Field label="Телефон" error="Номер неповний: потрібно 12 цифр після +">
                    <Input defaultValue="+380 67 482 19" />
                  </Field>
                  <Field label="Дата прийому">
                    <Input type="date" defaultValue="2026-10-10" />
                  </Field>
                  <Field label="Тривалість" optional>
                    <Input defaultValue="50" suffix="хв" />
                  </Field>
                </div>
                <Stack className="gap-3 pt-5">
                  <CheckLabel control={<Checkbox checked={remind} onChange={(e) => setRemind(e.target.checked)} />} label="Нагадати Андрію за 2 год до сесії" />
                  <CheckLabel control={<Checkbox />} label="Додати пунктом до плану сесії 6" />
                  <CheckLabel control={<Checkbox />} label="Надіслати SMS" sub="якщо немає застосунку" />
                  <div role="radiogroup" aria-label="Формат прийому" className="flex flex-col gap-2">
                    <CheckLabel
                      control={<Radio name="place" checked={place === "office"} onChange={() => setPlace("office")} />}
                      label="Очно, каб. 214"
                    />
                    <CheckLabel
                      control={<Radio name="place" checked={place === "online"} onChange={() => setPlace("online")} />}
                      label="Онлайн"
                    />
                  </div>
                  <Switch checked={notify} onChange={setNotify} label="Сповіщати про нові результати" />
                  <Switch checked={quiet} onChange={setQuiet} label="Тиха година 22:00–08:00" sub="сповіщення про ризик приходять завжди" />
                </Stack>
              </div>
              <Field label="Нотатка до розбору">
                <Textarea
                  rows={3}
                  defaultValue="Розмова телефоном о 16:52. C-SSRS: пасивне бажання «заснути й не прокинутися»; думок про самогубство, плану й наміру немає."
                />
              </Field>
              <div className="mt-2 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-5">
                <div>
                  <Label>Вибір рішення</Label>
                  <div role="radiogroup" aria-label="Рішення" className="flex flex-col gap-1.5">
                    <ChoiceCard name="dec" value="low" checked={choice === "low"} onChange={setChoice} title="Ризик низький — план на сесії 6" sub="обговорити пункт 9 і план безпеки в сб 10.10" />
                    <ChoiceCard name="dec" value="call" checked={choice === "call"} onChange={setChoice} title="Потрібен контакт сьогодні" sub="дзвінок Андрію до 18:12, після нього повторний розбір" />
                    <ChoiceCard name="dec" value="duty" checked={choice === "duty"} onChange={setChoice} title="Передати черговому" sub="Олег Бондар веде випадок далі, на зміні до 08:00" />
                  </div>
                  <ErrorText className="mt-2">Оберіть рішення, щоб зберегти розбір</ErrorText>
                </div>
                <Stack className="gap-3">
                  <Label>Сегменти й вкладки</Label>
                  <Segmented
                    label="Методика"
                    value={seg}
                    onChange={setSeg}
                    items={[
                      { key: "phq", label: "PHQ-9" },
                      { key: "gad", label: "GAD-7" },
                      { key: "pcl", label: "PCL-5" },
                      { key: "who", label: "WHO-5" },
                    ]}
                  />
                  <Tabs
                    label="Розділи картки"
                    items={[
                      { id: "uk-tab-overview", label: "Огляд", active: tab === "overview", onSelect: () => setTab("overview") },
                      { id: "uk-tab-measures", label: "Заміри", count: 12, active: tab === "measures", onSelect: () => setTab("measures") },
                      { id: "uk-tab-concl", label: "Заключення", count: 2, active: tab === "concl", onSelect: () => setTab("concl") },
                    ]}
                  />
                </Stack>
              </div>
            </Panel>
          </Section>

          {/* ─────────── числа ─────────── */}
          <Section id="numbers" title="Числа" sub="велике значення зі зміною й надійністю">
            <Panel title="Методики" icon={<Ic.clipboard />} sub="заміри 24.08, 11.09, 08.10" flush footer={<span className="flex items-center gap-1.5 text-caption text-muted"><Ic.info size={13} />Зміна надійна, коли перевищує поріг RCI (95 %): риска на смужці.</span>}>
              <BigValues>
                <BigValue code="PHQ-9" measure="депресія" better="down" value={14} severity={{ word: "помірна", level: "moderate" }} history={[19, 16]} change={{ delta: -5, threshold: 6 }} />
                <BigValue code="GAD-7" measure="тривога" better="down" value={11} severity={{ word: "помірна", level: "moderate" }} history={[15, 13]} change={{ delta: -4, threshold: 5 }} />
                <BigValue code="PCL-5" measure="ПТСР" better="down" value={38} severity={{ word: "вище порогу 33", level: "modsevere" }} history={[52, 44]} change={{ delta: -14, threshold: 11 }} />
                <BigValue code="WHO-5" measure="благополуччя" better="up" value={40} unit="%" severity={{ word: "знижене", level: "moderate" }} history={["24 %", "32 %"]} change={{ delta: 16, threshold: 14, unit: " в. п." }} />
              </BigValues>
            </Panel>
            <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
              <Panel>
                <Stat value={14} label="PHQ-9, останній замір" />
              </Panel>
              <Panel>
                <Stat value="2:48" tone="danger" label="минуло з 4 год розбору" />
              </Panel>
              <Panel>
                <ChangeCell delta={-14} threshold={11} better="down" />
              </Panel>
              <Panel>
                <Stat value={null} unit="бали" label="ще не проходив" />
              </Panel>
            </div>
          </Section>

          {/* ─────────── стани ─────────── */}
          <Section id="states" title="Стани" sub="порожньо, примітки, завантаження, помилка">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(250px,1fr))] items-start gap-4">
              <Panel title="Заключення" icon={<Ic.file />}>
                <Empty
                  title="Заключень ще немає"
                  hint="Перше заключення з’явиться після підпису. Почніть із чернетки за останнім заміром."
                  action={
                    <>
                      <Button variant="primary" icon={<Ic.file />}>
                        Нове заключення
                      </Button>
                      <Button variant="ghost">Шаблони</Button>
                    </>
                  }
                />
              </Panel>
              <Stack className="gap-2.5">
                <Callout kind="warn" title="Доступ до засобів">
                  Табельну зброю здано в частині 14.08; вдома зброї немає.
                </Callout>
                <Callout kind="good" title="Розбір збережено о 17:01">
                  Ризик низький, план на сесії 6. Підпис заключення № 0451 відкрито.
                </Callout>
                <Callout kind="risk" title="Сигнал не розібрано" actions={<Button variant="risk" size="xs">Розібрати</Button>}>
                  Підпис відкриється після розбору сигналу № 214.
                </Callout>
                <Callout kind="info" icon={<Ic.bell />}>
                  Андрій отримає сповіщення і SMS.
                </Callout>
                <Callout kind="line">Тренд — лінійна екстраполяція, не оцінка.</Callout>
              </Stack>
              <Panel title="Завантаження" icon={<Ic.refresh />} flush>
                <Loading rows={3} bare />
                <div className="p-4">
                  <Skeleton lines={3} />
                </div>
              </Panel>
              <Loading
                title="Не вдалося завантажити заміри"
                error="Сервер не відповів за 10 секунд. Дані не втрачено: спробуйте ще раз або відкрийте картку пізніше."
                onRetry={() => toast("Повторний запит надіслано", "info")}
              />
            </div>
            <div className="mt-4">
              <Empty compact title="З минулого прийому нічого не сталося" hint="Нових замірів, повідомлень і сигналів немає." />
            </div>
          </Section>

          {/* ─────────── накладки ─────────── */}
          <Section id="overlays" title="Накладки" sub="панель дії, поповер, підказка, меню, сповіщення, діалог">
            <Panel>
              <Label>Живі: відкрийте й закрийте клавішею Esc</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" icon={<Ic.alert />} onClick={() => openDrawer("signal")} aria-expanded={drawer.open && drawer.mode === "signal"}>
                  Панель дії
                </Button>
                <Button onClick={() => openDrawer("reply")} aria-expanded={drawer.open && drawer.mode === "reply"}>
                  Відповідь у панелі
                </Button>
                <Button onClick={() => setModal(true)}>Діалог</Button>
                <Button onClick={() => setCodes(true)}>Вікно без Esc</Button>
                <Button onClick={() => setConfirm(true)}>Підтвердження назвою</Button>
                <Button onClick={() => toast("Збережено", "ok")}>Сповіщення</Button>
                <Button
                  onClick={() =>
                    toast("Чернетку розбору сигналу № 214 збережено", "info", {
                      icon: <Ic.cloudCheck />,
                      action: { label: "Повернутися", kbd: "R", onClick: () => openDrawer("signal") },
                    })
                  }
                >
                  Сповіщення з поверненням
                </Button>
                <Button variant="quiet" onClick={() => void run(async () => { throw new Error("Сервер відхилив запит: спробуйте ще раз"); })}>
                  Відмова
                </Button>
                <Popover title="Сигнал ризику № 214" note="о 14:12" content={PEEK} actions={<Button variant="risk" size="xs">Розібрати</Button>}>
                  <Button variant="ghost" icon={<Ic.alert />}>
                    Поповер на фокусі
                  </Button>
                </Popover>
              </div>
              {confirm ? (
                <div className="mt-4 max-w-[560px]">
                  <ConfirmByName
                    title="Видалити групу «Ветерани після ротації»"
                    name="Ветерани після ротації"
                    warning="Група зникне з усіх списків; люди в ній лишаться в своїх картках."
                    actionLabel="Видалити групу"
                    onConfirm={() => {
                      setConfirm(false);
                      toast("Групу видалено", "ok");
                    }}
                    onCancel={() => setConfirm(false)}
                  />
                </div>
              ) : null}
            </Panel>

            <div className="mt-4 grid grid-cols-[440px_minmax(0,1fr)] items-start gap-5 max-[1280px]:grid-cols-1">
              <div>
                <Label>Панель дії: 440 px, кути 18, режими; Esc закриває й зберігає чернетку</Label>
                <div className="flex h-[600px] flex-col overflow-hidden rounded-drawer border border-border bg-panel shadow-banner">
                  <DrawerPane
                    title="Розбір сигналу № 214"
                    sub="Мельник Андрій, PHQ-9 від 08.10, 14:12"
                    icon={<Ic.alert />}
                    tone="risk"
                    headerExtra={<RiskTimer size="lg" elapsed="2:48" of="4 год" pct={70} note={<>до <b className="font-extrabold text-text">18:12</b>, лишилось 1:12</>} />}
                    note="Відкриє підпис № 0451"
                    saved="чернетку збережено, 16:58"
                    footer={
                      <>
                        <Button variant="primary">Зберегти розбір</Button>
                        <Button>Передати черговому</Button>
                      </>
                    }
                    onRequestClose={() => {}}
                  >
                    <DrawerSection title="PHQ-9, пункт 9" sub="уперше не 0">
                      <p className="m-0 rounded-panel bg-sunk px-3.5 py-3 text-[13px] leading-5 text-text-2">
                        Як часто за останні 2 тижні вас турбували думки, що вам було б краще померти, або думки про те, щоб якось собі
                        зашкодити?
                      </p>
                      <p className="m-0 mt-3 flex items-center gap-2 text-small text-text-2">
                        Відповідь Андрія <Tag tone="danger">кілька днів</Tag> <span className="text-muted">1 бал з 3</span>
                      </p>
                    </DrawerSection>
                    <DrawerSection title="Рішення" sub="обов’язково для збереження">
                      <div className="flex flex-col gap-1.5">
                        <ChoiceCard name="static-dec" value="low" checked onChange={() => {}} title="Ризик низький — план на сесії 6" sub="обговорити пункт 9 і план безпеки" />
                        <ChoiceCard name="static-dec" value="duty" checked={false} onChange={() => {}} title="Передати черговому" sub="Олег Бондар, на зміні до 08:00" />
                      </div>
                    </DrawerSection>
                  </DrawerPane>
                </div>
              </div>
              <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] items-start gap-5">
                <div>
                  <Label>Поповер на наведення або фокус</Label>
                  <PopoverCard
                    title="Сигнал ризику № 214"
                    note="о 14:12"
                    content={PEEK}
                    actions={
                      <>
                        <Button variant="risk" size="xs">
                          Розібрати
                        </Button>
                        <Kbd>R</Kbd>
                      </>
                    }
                  />
                </div>
                <Stack className="gap-3">
                  <div>
                    <Label>Підказка з клавішею</Label>
                    <TooltipPlate label="Розібрати сигнал" kbd="R" />
                  </div>
                  <div>
                    <Label>Меню</Label>
                    <MenuPanel label="Дії з пацієнтом (зразок)">
                      <MenuGroupLabel>Дії з пацієнтом</MenuGroupLabel>
                      <button type="button" role="menuitem" className={menuItemClass()}>
                        <Ic.clipboard />
                        <span className="flex-1">Призначити методику</span>
                      </button>
                      <button type="button" role="menuitem" className={menuItemClass()}>
                        <Ic.calendar />
                        <span className="flex-1">Записати на прийом</span>
                        <Kbd>C</Kbd>
                      </button>
                      <button type="button" role="menuitem" className={menuItemClass()}>
                        <Ic.file />
                        <span className="flex-1">Нове заключення</span>
                      </button>
                      <MenuSeparator />
                      <button type="button" role="menuitem" className={menuItemClass()}>
                        <Ic.user />
                        <span className="flex-1">Зняти закріплення</span>
                      </button>
                      <button type="button" role="menuitem" aria-disabled className={menuItemClass("left", "disabled")}>
                        <Ic.lock />
                        <span className="flex-1">Підписати № 0451</span>
                      </button>
                    </MenuPanel>
                  </div>
                </Stack>
                <div className="col-span-full">
                  <Label>Сповіщення внизу ліворуч, з поверненням до чернетки</Label>
                  <ToastView
                    text="Чернетку розбору сигналу № 214 збережено"
                    icon={<Ic.cloudCheck />}
                    action={{ label: "Повернутися", kbd: "R", onClick: () => openDrawer("signal") }}
                  />
                </div>
                <div className="col-span-full">
                  <Label>Діалог — лише коли дію треба підтвердити</Label>
                  <div className="flex max-w-[560px] flex-col overflow-hidden rounded-drawer border border-border bg-panel shadow-banner">
                    <DialogFrame
                      title="Зняти методику з використання"
                      sub="PSQI, 0 призначень за 30 днів"
                      icon={<Ic.archive />}
                      tone="warn"
                      footer={
                        <>
                          <Button variant="primary">Зняти з використання</Button>
                          <Button>Скасувати</Button>
                        </>
                      }
                    >
                      <p className="m-0 text-text-2">Нові призначення стануть недоступні. Відповіді й заключення лишаться в картках. Повернути можна з архіву.</p>
                    </DialogFrame>
                  </div>
                </div>
              </div>
            </div>
          </Section>

          {/* ─────────── правила ─────────── */}
          <Section id="rules" title="Правила" sub="світ «Клінічна карта»">
            <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] items-start gap-4">
              <Panel title="Робимо" icon={<Ic.thumbsUp />} tone="good">
                <ul className="m-0 flex list-none flex-col p-0">
                  {[
                    ["Список і запис", "ліворуч — хто потребує уваги й чому, праворуч — вибраний запис."],
                    ["Дія в панелі", "розбір, відповідь, перенесення, заключення, нотатка відкриваються праворуч без переходу; Esc зберігає чернетку."],
                    ["Інформація на вимогу", "деталі — у поповері на наведенні чи фокусі, розгорнуті рядки, панелі."],
                    ["Рядок відкритого", "усе відкрите про людину — пігулка з власною дією."],
                    ["Кожне число з порівнянням", "зміна від старту, поріг надійної зміни, тяжкість словом, «краще ↓/↑»."],
                    ["Мова", "українська, речення з великої лише на початку, кнопка називає дію, підписи з uiStrings.ts."],
                  ].map(([b, t]) => (
                    <li key={b} className="flex gap-2.5 border-t border-divider py-2.5 text-[13px] leading-[19px] first:border-t-0 first:pt-0">
                      <Ic.circleCheck size={15} className="mt-0.5 text-good" />
                      <span className="text-text-2">
                        <b className="font-extrabold text-text">{b}</b> — {t}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
              <Panel title="Не робимо" icon={<Ic.ban />} tone="warn">
                <ul className="m-0 flex list-none flex-col p-0">
                  {[
                    ["Червоний не для ризику", "помилки форм — текстом із значком, видалення — звичайною кнопкою з підтвердженням."],
                    ["Тяжкість без слова", "лише колір не каже нічого людині з порушенням кольорового зору."],
                    ["Крапка-розділювач між словами", "кома або окремі елементи."],
                    ["Надписи над заголовками, номери розділів", "заголовок говорить сам."],
                    ["Ряди KPI-плиток, спарклайни для краси", "число стоїть там, де по ньому діють."],
                    ["Градієнти, скло, емодзі, кольорова смуга зліва товща за 1 px", "глибина — лише м’які тіні на плаваючих поверхнях."],
                  ].map(([b, t]) => (
                    <li key={b} className="flex gap-2.5 border-t border-divider py-2.5 text-[13px] leading-[19px] first:border-t-0 first:pt-0">
                      <Ic.circleX size={15} className="mt-0.5 text-warn" />
                      <span className="text-text-2">
                        <b className="font-extrabold text-text">{b}</b> — {t}
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            </div>
          </Section>
        </div>
      </div>

      {/* ─────────── живые слои ─────────── */}
      <Drawer
        open={drawer.open}
        mode={drawer.mode}
        onClose={() => setDrawer((d) => ({ ...d, open: false }))}
        onReturn={(m) => openDrawer(m ?? "signal")}
      >
        <DrawerPane
          mode="signal"
          title="Розбір сигналу № 214"
          sub="Мельник Андрій, PHQ-9 від 08.10, 14:12"
          icon={<Ic.alert />}
          tone="risk"
          kbd="R"
          headerExtra={<RiskTimer size="lg" elapsed="2:48" of="4 год" pct={70} note={<>до <b className="font-extrabold text-text">18:12</b>, лишилось 1:12</>} />}
          dirty={draftDirty}
          draftName="розбору сигналу № 214"
          note="Відкриє підпис № 0451"
          footer={
            <>
              <Button
                variant="primary"
                disabled={!decision}
                onClick={() => {
                  setDecision("");
                  setReviewNote("");
                  setDrawer((d) => ({ ...d, open: false }));
                  toast("Розбір збережено", "ok");
                }}
              >
                Зберегти розбір
              </Button>
              <Button>Передати черговому</Button>
            </>
          }
        >
          <DrawerSection title="PHQ-9, пункт 9" sub="уперше не 0">
            <p className="m-0 rounded-panel bg-sunk px-3.5 py-3 text-[13px] leading-5 text-text-2">
              Як часто за останні 2 тижні вас турбували думки, що вам було б краще померти, або думки про те, щоб якось собі зашкодити?
            </p>
          </DrawerSection>
          <DrawerSection title="Рішення" sub="обов’язково для збереження">
            <div role="radiogroup" aria-label="Рішення розбору" className="flex flex-col gap-1.5">
              <ChoiceCard name="live-dec" value="low" checked={decision === "low"} onChange={setDecision} title="Ризик низький — план на сесії 6" sub="обговорити пункт 9 і план безпеки" />
              <ChoiceCard name="live-dec" value="duty" checked={decision === "duty"} onChange={setDecision} title="Передати черговому" sub="Олег Бондар, на зміні до 08:00" />
            </div>
          </DrawerSection>
          <DrawerSection title="Нотатка">
            <Field label="Нотатка до розбору">
              <Textarea data-autofocus rows={4} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} />
            </Field>
          </DrawerSection>
        </DrawerPane>
        <DrawerPane
          mode="reply"
          title="Відповідь Андрію"
          sub="Просить перенести суботу на вечір"
          icon={<Ic.message />}
          tone="info"
          dirty={reply.trim() !== ""}
          draftName="відповіді Андрію"
          footer={
            <Button
              variant="primary"
              disabled={!reply.trim()}
              onClick={() => {
                setReply("");
                setDrawer((d) => ({ ...d, open: false }));
                toast("Відповідь надіслано", "ok");
              }}
            >
              Надіслати
            </Button>
          }
        >
          <DrawerSection title="Листування">
            <p className="m-0 max-w-[84%] rounded-[16px] rounded-bl-[6px] bg-sunk px-[13px] py-[9px] text-[13px] leading-[19px] text-text">
              Добрий день. Можна перенести суботу на вечір? Мене ставлять на зміну.
              <small className="mt-1 block text-[11.5px] text-muted">учора, 18:40</small>
            </p>
          </DrawerSection>
          <DrawerSection title="Відповідь">
            <Field label="Текст відповіді">
              <Textarea data-autofocus rows={5} value={reply} onChange={(e) => setReply(e.target.value)} />
            </Field>
          </DrawerSection>
        </DrawerPane>
      </Drawer>

      {modal ? (
        <Modal
          title="Зняти методику з використання"
          sub="PSQI, 0 призначень за 30 днів"
          icon={<Ic.archive />}
          tone="warn"
          onClose={() => setModal(false)}
          footer={
            <>
              <Button variant="primary" onClick={() => setModal(false)}>
                Зняти з використання
              </Button>
              <Button onClick={() => setModal(false)}>Скасувати</Button>
            </>
          }
        >
          <p className="m-0 mb-3 text-text-2">Нові призначення стануть недоступні. Відповіді й заключення лишаться в картках.</p>
          <Field label="Причина">
            <Select defaultValue="old">
              <option value="old">Застаріла версія</option>
              <option value="dup">Дублює іншу методику</option>
            </Select>
          </Field>
        </Modal>
      ) : null}

      {codes ? (
        <Modal
          title="Коди відновлення"
          sub="Збережіть їх, перш ніж закрити"
          icon={<Ic.lock />}
          esc={false}
          onClose={() => setCodes(false)}
          footer={
            <Button variant="primary" onClick={() => setCodes(false)}>
              Я зберіг коди
            </Button>
          }
        >
          <p className="m-0 text-text-2">Esc і клік поза вікном його не закривають — вікно здригається. Закриває лише кнопка.</p>
          <p className="m-0 mt-3 font-mono text-[13px] text-text">4F7K-92QD · 7XLM-1PAC · QW3E-8ZNB</p>
        </Modal>
      ) : null}

    </Page>
  );
}
