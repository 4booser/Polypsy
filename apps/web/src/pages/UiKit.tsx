import { useState } from "react";
import {
  Avatar,
  Badge,
  ConfirmByName,
  DataTable,
  Empty,
  LoadMore,
  Modal,
  PageHead,
  Search,
  Skeleton,
  useAction,
  useToast,
} from "../ui";
import { Chart, LineChart, BarList, Donut } from "../charts";
import { severityColor } from "../format";

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
  ["--bg", "основание"],
  ["--surface", "поверхность"],
  ["--surface-2", "приподнятая"],
  ["--border", "граница"],
  ["--accent", "акцент: требует внимания"],
  ["--primary", "интерактив"],
  ["--sev-none", "норма"],
  ["--sev-mild", "лёгкая"],
  ["--sev-moderate", "умеренная"],
  ["--sev-severe", "выраженная"],
];

const TYPE_SCALE: [string, string, string][] = [
  ["--fs-hero", "50", "число во весь экран киоска"],
  ["--fs-stat", "34", "показатель на панели"],
  ["--fs-page", "25", "заголовок экрана"],
  ["--fs-section", "17", "заголовок раздела"],
  ["--fs-body", "15", "основной текст"],
  ["--fs-small", "13", "таблицы и подписи"],
  ["--fs-caption", "12", "пояснения"],
  ["--fs-micro", "11", "служебное"],
];

export default function UiKit() {
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const toast = useToast();
  const { run } = useAction();

  return (
    <>
      <PageHead
        title="Язык интерфейса"
        sub="Токены, типографика и компоненты. Всё, что показано здесь, берётся отсюда, а не рисуется заново."
      />

      <div className="card">
        <div className="card-head">
          <h2>Палитра</h2>
          <span className="hint">Акцент занят смыслом и на кнопки не идёт</span>
        </div>
        <div className="grid cols-4">
          {SWATCHES.map(([token, meaning]) => (
            <div key={token} className="row tight" style={{ alignItems: "center" }}>
              <i
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  background: `var(${token})`,
                  border: "1px solid var(--border-strong)",
                  flex: "none",
                }}
              />
              <span style={{ display: "grid" }}>
                <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{token}</code>
                <span className="muted" style={{ fontSize: 12 }}>{meaning}</span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Типографика</h2>
          <span className="hint">Модульная шкала 1.2 — ни одного размера вне её</span>
        </div>
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
      </div>

      <div className="card">
        <h2>Кнопки и метки</h2>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="primary">Первичное действие</button>
          <button>Обычное</button>
          <button className="ghost">Призрачная</button>
          <button className="danger">Опасное</button>
          <button disabled>Недоступно</button>
          <kbd>⌘K</kbd>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <Badge>обычная</Badge>
          <Badge tone="good">норма</Badge>
          <Badge tone="warn">внимание</Badge>
          <Badge tone="bad">тревога</Badge>
          <Badge tone="accent">требует разбора</Badge>
          <span className="chip">фильтр</span>
          <span className="chip active">выбранный</span>
          <Avatar name="Петров Дмитрий" />
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <div className="segmented" role="group">
            <button className="active">Открытые</button>
            <button>Все</button>
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Поля</h2>
          <div className="fields" style={{ marginTop: 10 }}>
            <div className="field">
              <label htmlFor="uikit-name">Фамилия</label>
              <input id="uikit-name" placeholder="Петров" />
            </div>
            <div className="field">
              <label htmlFor="uikit-sel">Подразделение</label>
              <select id="uikit-sel">
                <option>Все</option>
                <option>Рота обеспечения</option>
              </select>
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            <Search value={query} onChange={setQuery} placeholder="Поиск" />
          </div>
          <label className="check" style={{ marginTop: 12 }}>
            <input type="checkbox" defaultChecked /> Считать баллы по шкалам
          </label>
        </div>

        <div className="card">
          <h2>Состояния</h2>
          <p className="hint">Пустое, загрузка и отказ — их забывают чаще всего</p>
          <Skeleton lines={3} />
          <div style={{ marginTop: 12 }}>
            <Empty title="Ничего не найдено" hint="Смягчите фильтры или проверьте период" />
          </div>
          <p className="error" style={{ marginTop: 8 }}>Не удалось загрузить</p>
          <LoadMore cursor="есть-ещё" busy={busy} onLoad={() => {
            setBusy(true);
            setTimeout(() => setBusy(false), 800);
          }} />
        </div>
      </div>

      <div className="card">
        <h2>Выраженность</h2>
        <p className="hint">
          Отдельная шкала, не пересекающаяся с акцентом. В печати заменяется штриховкой:
          монохромный принтер не различает красное и жёлтое.
        </p>
        <div className="sev-bar-row" style={{ marginTop: 10 }}>
          <i className="sev-seg" style={{ background: severityColor.none, width: "45%" }} />
          <i className="sev-seg" style={{ background: severityColor.mild, width: "25%" }} />
          <i className="sev-seg" style={{ background: severityColor.moderate, width: "20%" }} />
          <i className="sev-seg" style={{ background: severityColor.severe, width: "10%" }} />
        </div>
      </div>

      <div className="grid cols-2">
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
      </div>

      <div className="card">
        <h2>Нагрузка по методикам</h2>
        <BarList
          items={[
            { label: "СР-45", value: 4820, caption: "в среднем 6 мин" },
            { label: "Мини-мульт", value: 2140, caption: "в среднем 21 мин" },
            { label: "МЛО-200", value: 980, caption: "в среднем 38 мин" },
          ]}
        />
      </div>

      <div className="card">
        <h2>Таблица</h2>
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
      </div>

      <div className="card">
        <h2>Всплывающие слои</h2>
        <div className="row" style={{ marginTop: 10 }}>
          <button onClick={() => setModal(true)}>Диалог</button>
          <button onClick={() => setConfirm(true)}>Подтверждение печатанием</button>
          <button onClick={() => toast("Сохранено", "ok")}>Уведомление</button>
          <button onClick={() => void run(async () => { throw new Error("Пример отказа"); })}>
            Отказ
          </button>
        </div>
      </div>

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
    </>
  );
}
