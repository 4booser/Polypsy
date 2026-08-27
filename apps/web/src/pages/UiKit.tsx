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

/**
 * Витрина библиотеки.
 *
 * Нужна не для красоты: страница не имеет права объявлять свою вёрстку
 * элементов формы, а проверить это можно только там, где все компоненты
 * собраны рядом. Здесь же ловятся расхождения между темами и состояния,
 * которые в живом экране просто не встречаются — недоступная кнопка,
 * загрузка, пустой список.
 *
 * Она же площадка для проверки доступности: смоук гоняет по ней axe.
 */
export default function UiKit() {
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const toast = useToast();
  const run = useAction();

  return (
    <>
      <PageHead
        title="Библиотека компонентов"
        sub="Всё, из чего собираются экраны. Если чего-то не хватает — добавлять сюда, а не в страницу"
        crumbs={<span>Служебное</span>}
        actions={<Search value={q} onChange={setQ} placeholder="Поиск" />}
      />

      <Section title="Типографика" hint="Роли, а не размеры">
        <h1>Заголовок экрана</h1>
        <h2>Заголовок карточки</h2>
        <h3>Подзаголовок</h3>
        <p>Основной текст: им набрано всё содержательное на экране.</p>
        <p className="sub">Пояснение под заголовком</p>
        <p className="hint">Подсказка внутри карточки</p>
        <p className="muted">Приглушённый текст</p>
        <p className="num" style={{ fontSize: "var(--fs-stat)", fontWeight: 700 }}>
          1 234,5
        </p>
      </Section>

      <Section title="Кнопки" hint="Основное действие одно на экран">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button className="primary">Основное</button>
          <button>Обычное</button>
          <button className="ghost">Тихое</button>
          <button className="danger">Опасное</button>
          <button disabled>Недоступно</button>
          <button className="primary" disabled>
            Отправляю…
          </button>
        </div>
      </Section>

      <Section title="Метки состояния" hint="Цвет несёт смысл, но рядом всегда слово">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <Badge>нейтрально</Badge>
          <Badge tone="good">норма</Badge>
          <Badge tone="warn">требует внимания</Badge>
          <Badge tone="bad">просрочен</Badge>
          <Badge tone="accent">выверено</Badge>
        </div>
      </Section>

      <Section title="Поля ввода">
        <div className="form-grid">
          <label className="field">
            <span>Обычное поле</span>
            <input placeholder="Введите значение" />
          </label>
          <label className="field">
            <span>Список</span>
            <select defaultValue="">
              <option value="">Не выбрано</option>
              <option value="a">Первый</option>
            </select>
          </label>
          <label className="field">
            <span>Недоступное</span>
            <input value="только чтение" readOnly disabled />
          </label>
          <label className="field grow">
            <span>Многострочное</span>
            <textarea rows={2} placeholder="Комментарий" />
          </label>
        </div>
      </Section>

      <Section title="Люди">
        <div className="row" style={{ flexWrap: "wrap", gap: 18 }}>
          {["Коваленко Тарас", "Шевченко Оксана", "Бондаренко Ігор"].map((n) => (
            <span className="row tight" key={n}>
              <Avatar name={n} />
              {n}
            </span>
          ))}
        </div>
      </Section>

      <Section title="Таблица" hint="Сортировка и выгрузка встроены">
        <DataTable
          rows={[
            { id: "1", name: "Коваленко Тарас", unit: "1-й батальон", n: 12 },
            { id: "2", name: "Шевченко Оксана", unit: "Медицинская рота", n: 4 },
          ]}
          csvName="пример"
          stateKey="uikit"
          columns={[
            { key: "name", header: "ФИО", sort: (r) => r.name, render: (r) => r.name },
            { key: "unit", header: "Подразделение", sort: (r) => r.unit, render: (r) => r.unit },
            { key: "n", header: "Замеров", num: true, sort: (r) => r.n, render: (r) => r.n },
          ]}
        />
      </Section>

      <Section title="Состояния списка" hint="Загрузка, пустота, конец">
        <Skeleton lines={3} />
        <div style={{ height: 14 }} />
        <Empty
          title="Здесь пока пусто"
          hint="Пустое состояние всегда говорит, что сделать дальше"
          action={<button className="primary">Создать первую запись</button>}
        />
        <LoadMore cursor="есть-ещё" busy={busy} onLoad={() => {
          setBusy(true);
          setTimeout(() => setBusy(false), 900);
        }} />
        <LoadMore cursor={null} busy={false} onLoad={() => {}} />
      </Section>

      <Section title="Сообщения и диалоги">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button onClick={() => toast("Сохранено", "ok")}>Сообщение об успехе</button>
          <button onClick={() => toast("Не удалось сохранить", "err")}>Сообщение об ошибке</button>
          <button onClick={() => void run(async () => { throw new Error("Сервер недоступен"); })}>
            Через useAction
          </button>
          <button onClick={() => setModal(true)}>Диалог</button>
          <button className="danger" onClick={() => setConfirm(true)}>
            Подтверждение печатанием
          </button>
        </div>
        <p className="hint">
          Диалог закрывается по Esc и по щелчку вне окна; фон при этом не прокручивается.
        </p>
      </Section>

      {modal ? (
        <Modal title="Пример диалога" onClose={() => setModal(false)}>
          <p>
            Содержимое диалога. Фокус уходит внутрь, Esc закрывает — без этого окно
            становится ловушкой для клавиатуры.
          </p>
          <div className="row">
            <button className="primary" onClick={() => setModal(false)}>Понятно</button>
          </div>
        </Modal>
      ) : null}

      {confirm ? (
        <ConfirmByName
          title="Необратимое действие"
          name="Пример методики"
          actionLabel="Выполнить"
          warning={
            <p style={{ margin: 0 }}>
              Так подтверждается то, что нельзя откатить. Обычный confirm снимается не
              глядя — рука жмёт «ОК» раньше, чем глаз читает.
            </p>
          }
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            setConfirm(false);
            toast("Выполнено", "ok");
          }}
        />
      ) : null}
    </>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {hint ? <span className="hint" style={{ margin: 0 }}>{hint}</span> : null}
      </div>
      {children}
    </div>
  );
}
