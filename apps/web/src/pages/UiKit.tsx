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

const SWATCHES: [string, string][] = [
  ["--bg", "земля: самое тёмное на экране"],
  ["--surface", "панель: лежит НА земле"],
  ["--surface-2", "ступень выше: поля, боковые панели"],
  ["--border", "граница"],
  ["--accent", "янтарь: только «требует внимания»"],
  ["--primary", "бирюза: действие и состояние"],
  ["--sev-none", "норма"],
  ["--sev-mild", "лёгкая"],
  ["--sev-moderate", "умеренная"],
  ["--sev-severe", "выраженная"],
];

/**
 * Категориальные слоты графиков в их единственно верном порядке.
 *
 * Подобраны перебором, а не на глаз: соседние пары различимы при
 * протанопии, дейтеранопии и тританопии (худшая — 9,1 при пороге 8), при
 * обычном зрении не ближе 18 при пороге 15, и каждый даёт не меньше 6,6:1
 * на тёмной земле. Девятого ряда не бывает — он сворачивается в «прочие».
 */
const CATEGORICAL = ["--cat-1", "--cat-2", "--cat-3", "--cat-4", "--cat-5", "--cat-6"];

const TYPE_SCALE: [string, string, string][] = [
  ["--fs-hero", "52", "число во весь экран киоска"],
  ["--fs-stat", "34", "показатель на панели"],
  ["--fs-page", "26", "заголовок экрана"],
  ["--fs-section", "17", "заголовок раздела"],
  ["--fs-body", "15", "основной текст"],
  ["--fs-small", "13", "таблицы и вторичный текст"],
  ["--fs-caption", "12", "подписи полей и колонок"],
  ["--fs-micro", "11", "служебное, клавиши"],
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
      <Panel title="Палитра" hint="Янтарь занят смыслом и на кнопки не идёт. Бирюза — действие и состояние: выбранная строка, включённый фильтр, активная вкладка.">
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
            Соседние пары различимы при трёх видах дальтонизма: худшая — 9,1 при пороге 8.
            Прежняя палитра порог не проходила — оранжевый с зелёным сливались при протанопии.
            Девятого ряда не бывает: он сворачивается в «прочие».
          </p>
        </div>
      </Panel>

      <Panel title="Типографика" hint="Шесть рабочих ступеней. Восемь никто не удерживает в голове, и половина выбиралась наугад.">
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
          <kbd>⌘K</kbd>
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
