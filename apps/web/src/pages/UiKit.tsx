import { useState } from "react";
import {
  Avatar,
  Badge,
  ConfirmByName,
  DataTable,
  Empty,
  LoadMore,
  Modal,
  Search,
  Skeleton,
  useAction,
  useToast,
} from "../ui";
import { Chart, LineChart, BarList, Donut } from "../charts";
import { severityColor } from "../format";
import { IconCommand } from "../ui/glyphs";
import { Page, Panel, Grid, Stack } from "../ui/layout";
import { Button, Field, Input, Num, SectionLabel, SeverityTag, Stat, Tag } from "../ui/primitives";

/**
 * Витрина языка интерфейса.
 *
 * Нужна не для красоты. Во-первых, страница не имеет права объявлять свою
 * вёрстку: увидев здесь нужный кусок, его берут отсюда, а не рисуют заново —
 * так согласованность держится без договорённостей. Во-вторых, по этой
 * странице снимаются эталонные скриншоты: расхождение видно до того, как
 * попадёт на глаза человеку в кабинете.
 *
 * Показаны все состояния, включая пустые и отказные: именно они обычно
 * забываются и обнаруживаются в проде.
 */

/* Имена набора «Виразна» (styles/tokens.css, слой 1); прежние имена ведут на них же */
const SWATCHES: [string, string][] = [
  ["--ground", "земля страницы"],
  ["--panel", "лист: панели, поля, меню (--bg, --surface)"],
  ["--sunk", "залитые плашки, наведение (--surface-2)"],
  ["--sunk2", "выбранное (--surface-3)"],
  ["--border", "обод панели"],
  ["--ctl", "рамка поля и управления"],
  ["--v", "заливка основного действия"],
  ["--vtint", "мягкая заливка: кнопка, выбранная строка"],
  ["--primary", "фиолетовый текст: бренд, действие, «моё»"],
  ["--accent", "янтарь: только «требует внимания»"],
  ["--risk", "риск для человека — и только"],
  ["--good", "сделано, надёжное улучшение"],
  ["--info", "сведения, сообщение"],
  ["--sev-0", "минимальная"],
  ["--sev-1", "лёгкая"],
  ["--sev-2", "умеренная"],
  ["--sev-3", "умеренно тяжёлая"],
  ["--sev-4", "тяжёлая"],
];

/**
 * Ряды графиков в их единственно верном порядке.
 *
 * Проверены валидатором палитры набора: на светлой теме различимы все пары,
 * на тёмной — соседние, а все пары — только первые три. За методиками
 * закреплены навсегда: PHQ-9, GAD-7, PCL-5, WHO-5; пятый — прочее и
 * сравнение.
 */
const CATEGORICAL = ["--c1", "--c2", "--c3", "--c4", "--c5"];

const TYPE_SCALE: [string, string, string][] = [
  ["--fs-hero", "56", "вход и киоск"],
  ["--fs-stat", "32", "число, которое читают с расстояния"],
  ["--fs-page", "28", "заголовок экрана"],
  ["--fs-title", "26", "имя в карточке пациента"],
  ["--fs-big", "22", "крупное число, заголовок ящика"],
  ["--fs-lead", "18", "вводная строка"],
  ["--fs-patient", "16", "основной текст кабинета пациента"],
  ["--fs-section", "15.5", "заголовок панели"],
  ["--fs-h3", "15", "заголовок внутри панели"],
  ["--fs-body", "13.5", "основной текст консоли"],
  ["--fs-small", "12.5", "вторичный текст"],
  ["--fs-caption", "12", "подписи полей и колонок"],
  ["--fs-micro", "11", "оси графиков, клавиши"],
];

export default function UiKit() {
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const toast = useToast();
  const { run } = useAction();

  return (
    <Page
      title="Язык интерфейса"
      sub="Токены, типографика и компоненты. Всё, что показано здесь, берётся отсюда, а не рисуется заново."
    >
      <Stack>
      <Panel title="Палитра" hint="Янтарь занят смыслом и на кнопки не идёт. Фиолетовый — бренд, действие и выбор: выбранная строка, включённый фильтр, активная вкладка. Красный — только риск для человека.">
        <Grid min={230}>
          {SWATCHES.map(([token, meaning]) => (
            <div key={token} className="flex items-start gap-2.5">
              <i
                aria-hidden
                className="mt-0.5 size-7 shrink-0 rounded-sm border border-border-strong"
                style={{ background: `var(${token})` }}
              />
              <span className="min-w-0">
                <code className="block font-mono text-micro">{token}</code>
                <span className="block text-caption text-muted">{meaning}</span>
              </span>
            </div>
          ))}
        </Grid>

        <div className="mt-5 border-t border-hairline pt-4">
          <SectionLabel className="mb-2">Ряды графиков · порядок фиксирован</SectionLabel>
          <div className="flex flex-wrap items-center gap-2">
            {CATEGORICAL.map((token, i) => (
              <span key={token} className="flex items-center gap-1.5">
                <i
                  aria-hidden
                  className="size-5 rounded-sm"
                  style={{ background: `var(${token})` }}
                />
                <Num className="text-micro text-faint">{i + 1}</Num>
              </span>
            ))}
          </div>
          <p className="m-0 mt-2 max-w-[68ch] text-caption text-muted">
            PHQ-9, GAD-7, PCL-5, WHO-5 и «прочее» — в этом порядке и с этими цветами
            везде. На тёмной теме различимы соседние пары, а все пары — только первые
            три: в точечных формах там не больше трёх цветов, четвёртый ряд держится
            формой метки.
          </p>
        </div>
      </Panel>

      <Panel title="Типографика" hint="Одна гарнитура — Manrope 400–800, цифры моноширинные. Шкала набора «Виразна»: консоль плотная, 13.5 текста и 40 управления.">
        <table>
          <tbody>
            {TYPE_SCALE.map(([token, px, use]) => (
              <tr key={token}>
                <td style={{ width: 120 }}>
                  <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{token}</code>
                </td>
                <td className="num" style={{ width: 60 }}>{px}</td>
                <td>
                  <span style={{ fontSize: `var(${token})`, fontFamily: "var(--font-display)" }}>
                    Психодіагностика
                  </span>
                </td>
                <td className="muted">{use}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Кнопки и метки" hint="Янтарного варианта у кнопки нет вовсе. Если он кажется нужным, экран сообщает о проблеме не тем способом.">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Первичное действие</Button>
          <Button>Обычное</Button>
          <Button variant="quiet">Тихая</Button>
          <Button variant="danger">Опасное</Button>
          <Button disabled>Недоступно</Button>
          <Button size="sm">Мелкая</Button>
          <kbd><IconCommand />K</kbd>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge>обычная</Badge>
          <Badge tone="good">норма</Badge>
          <Badge tone="warn">внимание</Badge>
          <Badge tone="bad">тревога</Badge>
          <Badge tone="accent">требует разбора</Badge>
          <span className="chip">фильтр</span>
          <span className="chip active">выбранный</span>
          <Tag>нейтральная</Tag>
          <Tag tone="primary">состояние</Tag>
          <Tag tone="attention">внимание</Tag>
          <Avatar name="Петров Дмитрий" />
        </div>
        {/*
          Выраженность показана и цветом, и подписью, и формой точки: круг,
          круг, квадрат, ромб. Тот, кто не различает красный и зелёный, читает
          ту же разницу по форме.
        */}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SeverityTag level="none">норма</SeverityTag>
          <SeverityTag level="mild">лёгкая</SeverityTag>
          <SeverityTag level="moderate">умеренная</SeverityTag>
          <SeverityTag level="severe">выраженная</SeverityTag>
        </div>
        <div className="mt-3">
          <div className="segmented" role="group">
            <button className="active">Открытые</button>
            <button>Все</button>
          </div>
        </div>
      </Panel>

      <Panel title="Числа" hint="Моноширинные и в колонку: в столбце баллов разной ширины глаз теряет разряд, и 128 читается как 12,8.">
        <div className="flex flex-wrap gap-10">
          <Stat value={14108} label="проходжень" />
          <Stat value={317} label="в очереди" tone="attention" />
          <Stat value={null} label="нечего считать" />
          <Stat value="5" unit="мин" label="среднее время" />
        </div>
        <p className="m-0 mt-3 max-w-[68ch] text-caption text-muted">
          Прочерк вместо нуля — не мелочь: ноль это результат, прочерк —
          его отсутствие, и в клинических данных путать их нельзя.
        </p>
      </Panel>

      <Grid min={340}>
        <Panel title="Поля">
          <div className="flex flex-col gap-3">
            <Field label="Фамилия" htmlFor="uikit-name">
              <Input id="uikit-name" placeholder="Петров" />
            </Field>
            <Field
              label="Подразделение"
              htmlFor="uikit-sel"
              hint="Пояснение стоит под полем всегда, а не только вместе с ошибкой"
            >
              <select id="uikit-sel">
                <option>Все</option>
                <option>Рота обеспечения</option>
              </select>
            </Field>
            <Field label="Срок" htmlFor="uikit-err" error="Дата уже прошла">
              <Input id="uikit-err" defaultValue="2020-01-01" />
            </Field>
            <Search value={query} onChange={setQuery} placeholder="Поиск" />
            <label className="check">
              <input type="checkbox" defaultChecked /> Считать баллы по шкалам
            </label>
          </div>
        </Panel>

        <Panel title="Состояния" hint="Пустое, загрузка и отказ — их забывают чаще всего и обнаруживают в проде">
          <Skeleton lines={3} />
          <div className="mt-3">
            <Empty title="Ничего не найдено" hint="Смягчите фильтры или проверьте период" />
          </div>
          <p className="mt-2 text-small text-danger">Не удалось загрузить</p>
          <LoadMore cursor="есть-ещё" busy={busy} onLoad={() => {
            setBusy(true);
            setTimeout(() => setBusy(false), 800);
          }} />
        </Panel>
      </Grid>

      <Panel
        title="Выраженность"
        hint="Отдельная шкала, не пересекающаяся с акцентом. В печати заменяется штриховкой: монохромный принтер не различает красное и жёлтое."
      >
        <div className="sev-bar-row">
          <i className="sev-seg" style={{ background: severityColor.none, width: "45%" }} />
          <i className="sev-seg" style={{ background: severityColor.mild, width: "25%" }} />
          <i className="sev-seg" style={{ background: severityColor.moderate, width: "20%" }} />
          <i className="sev-seg" style={{ background: severityColor.severe, width: "10%" }} />
        </div>
      </Panel>

      <Grid min={380}>
        <Chart title="Временной ряд" hint="Перекрестье и подсказка — по наведению">
          <LineChart
            area
            series={[
              {
                label: "Прохождения",
                points: Array.from({ length: 14 }, (_, i) => ({
                  x: `05-${String(i + 1).padStart(2, "0")}`,
                  y: 20 + Math.round(18 * Math.sin(i / 2) + i),
                })),
              },
            ]}
          />
        </Chart>
        <Chart title="Распределение" hint="Категориальные слоты в фиксированном порядке">
          <Donut
            center="168"
            centerLabel="случаев"
            slices={[
              { label: "норма", value: 96, color: severityColor.none },
              { label: "лёгкая", value: 38, color: severityColor.mild },
              { label: "умеренная", value: 22, color: severityColor.moderate },
              { label: "выраженная", value: 12, color: severityColor.severe },
            ]}
          />
        </Chart>
      </Grid>

      <Panel title="Нагрузка по методикам">
        <BarList
          items={[
            { label: "СР-45", value: 4820, caption: "в среднем 6 мин" },
            { label: "Мини-мульт", value: 2140, caption: "в среднем 21 мин" },
            { label: "МЛО-200", value: 980, caption: "в среднем 38 мин" },
          ]}
        />
      </Panel>

      <Panel title="Таблица" flush>
        <DataTable
          csvName="витрина"
          rows={[
            { id: "1", name: "Петров Дмитрий", unit: "Рота связи", n: 5 },
            { id: "2", name: "Коваленко Андрій", unit: "3-й батальон", n: 2 },
            { id: "3", name: "Шевченко Юлія", unit: "Артдивизион", n: 9 },
          ]}
          columns={[
            { key: "name", header: "ПИБ", render: (r) => r.name, sort: (r) => r.name },
            { key: "unit", header: "Подразделение", render: (r) => r.unit, sort: (r) => r.unit },
            { key: "n", header: "Замеров", num: true, render: (r) => r.n, sort: (r) => r.n },
          ]}
        />
      </Panel>

      <Panel title="Всплывающие слои" hint="Единственное место, где осталась тень: она сообщает о высоте, а не украшает.">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setModal(true)}>Диалог</Button>
          <Button onClick={() => setConfirm(true)}>Подтверждение печатанием</Button>
          <Button onClick={() => toast("Сохранено", "ok")}>Уведомление</Button>
          <Button variant="danger" onClick={() => void run(async () => { throw new Error("Пример отказа"); })}>
            Отказ
          </Button>
        </div>
      </Panel>
      </Stack>

      {modal ? (
        <Modal title="Диалог" onClose={() => setModal(false)}>
          <p className="hint">
            Фокус заперт внутри, Esc закрывает, возврат фокуса — на кнопку, которая открыла.
          </p>
          <div className="row">
            <button className="primary" onClick={() => setModal(false)}>Понятно</button>
          </div>
        </Modal>
      ) : null}

      {confirm ? (
        <ConfirmByName
          title="Снять методику с использования"
          name="СР-45"
          warning={<p className="hint">Прохождения останутся, выдача прекратится.</p>}
          actionLabel="Снять"
          onConfirm={() => setConfirm(false)}
          onCancel={() => setConfirm(false)}
        />
      ) : null}
    </Page>
  );
}
