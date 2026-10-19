# Набор «Виразна» — `apps/web/src/ui`

Компоненты консоли в стиле «Виразна». Живая витрина со всеми состояниями в обеих темах — `/ui`
(`pages/UiKit.tsx`). Источник вида — `.superdesign/ui3/kit` и `shots/system/design-system-*.png`.

```ts
import { Drawer, DrawerPane, DrawerSection, Popover, Tooltip, DataTable, FilterBar, BulkBar, AlertStrip,
  AlertChip, RiskChip, RiskTimer, ListTile, ListGroup, PersonCell, KV, ActivityList, BigValue, BigValues,
  ChangeCell, CourseDigits, BetterTag, Callout, Empty, Loading, Modal, KbdHints, Kbd, Avatar, Ic,
  useToast, useAction } from "../ui";
import { Button, Input, Select, Textarea, Field, Checkbox, Radio, CheckLabel, Switch, ChoiceCard,
  Segmented, Tag, SeverityTag, Stat, Num, Tabs } from "../ui/primitives";
import { Page, Panel, Count, IconTile, SideLayout, Grid, Stack } from "../ui/layout";
import { ActionMenu, MenuButton } from "../ui/menu";
import { Pager } from "../ui/pager";
```

## Правила, которые держит набор

- **Только токены.** Цвета — классы Tailwind на токенах (`bg-panel`, `text-violet-ink`, `bg-risk-tint` …), ни
  одного шестнадцатеричного цвета в экране. Тени — `shadow-panel|tile|pop|drawer|primary`, радиусы —
  `rounded-control` 10, `rounded-panel` 14, `rounded-drawer` 18.
- **Красный — только риск для человека**: сигнал, критический ответ, «Розібрати». Янтарь — просрочено, неявка,
  внимание. Зелёный — сделано, надёжно лучше. Фиолетовый — бренд, основное действие, выбранное, «ваше».
- **Тяжесть всегда со словом** (`SeverityTag`). Цвет никогда не единственный признак.
- **Одна основная кнопка на область.** Разрушительное (удалить, отозвать) — обычной кнопкой с подтверждением.
- **Действия — в ящике (`Drawer`), а не переходом.** Окно (`Modal`) — только когда шаг обязан прервать работу.
- **Сведения по требованию** — `Popover` на наведении и фокусе, а не всё на странице сразу.
- **Рамка поля — 3:1** (`--field-border`), отказ формы — текстом со значком (`ErrorText`), не красной заливкой.
- Строки — через словарь (`ut()`), ключи набора — `kit.*` в `packages/shared/src/uiStrings.ts`.
- **`className` на компоненте набора дополняет, а не заменяет.** `cx` только склеивает классы: два `h-*` или
  `text-*` в одной строке спорят, и победителя решает порядок правил в собранном CSS, а не в строке. Перебить
  размер, отступ или кегль набора на одном месте — `!` на классе экрана (`className="!mb-0"`). Перебивка,
  которая повторяется на многих экранах, — повод для свойства компонента, а не для слияния классов: слияние
  `text-*` должно знать, что `text-body` — кегль, а `text-muted` — цвет, и ошибка в нём молча съела бы класс.

## Крючки рамки (для оболочки)

| Переменная | Умолчание | Что делает |
|---|---|---|
| `--ah` | 56px | высота шапки приложения: от неё ящик (`top: --ah + 10`) и панель контекста на узком экране |
| `--sticky-top` | 0px | отступ липкого заголовка таблицы и боковой колонки `SideLayout`; если прокручивается окно под липкой шапкой — `var(--ah)` |
| `--toast-left` | 100px | левый край всплывающих сообщений (рельса 80 + 20); в кабинете пациента без рельсы — `20px` |

`Page` заполняет выданную ей колонку и прокручивает своё содержимое сам.

---

## Раскладка (`ui/layout`)

**`Page`** — шапка экрана: заголовок 28/800, мета-строка за волосяной линией, действия справа, строка пояснения,
полоса инструментов, содержимое с полями 20, правая панель контекста.

| Свойство | |
|---|---|
| `title` | имя экрана (h1) |
| `meta` | `[«248 людей», «34 закріплені за вами»]` или своя разметка |
| `sub` / `lead` | одна строка пояснения под заголовком |
| `count` | число рядом с заголовком (вне h1) |
| `back` | `{ to, label }` — шеврон назад перед заголовком |
| `actions` | кнопки справа; основная — одна |
| `toolbar` / `below` | полоса под шапкой: `Tabs`, `FilterBar` |
| `bleed` | экран раскладывает панели сам, без полей и своей прокрутки |
| `titleHidden` | заголовок только для диктора |

Прежние `topGap`, `listGap`, `headGap`, `pagerGap`, `titleSize`, `titleAlign` принимаются и ничего не меняют. Правой
панели контекста у `Page` нет: подробности строки — в `Drawer` или в боковой колонке `SideLayout`.

**`Panel`** — лист 14 с ободом: шапка с квадратом значка 32 (`icon`, `tone`), заголовок 15.5/800 (h2), `count`,
`sub`, `actions`; `hint` — строка под шапкой; `flush` — тело без полей (таблица, строки); `footer` — строка внизу.

```tsx
<Panel title="Методики" icon={<Ic.clipboard />} sub="заміри 24.08, 11.09, 08.10" actions={<TextAction>Усі заміри</TextAction>} flush>
  <BigValues>…</BigValues>
</Panel>
```

**`Count`** — пилюля-счётчик (`tone`: `plain`, `risk` — только риск, `violet`, `tint`). **`IconTile`** — квадрат значка
28–48 (`tone`: `violet`, `risk`, `warn`, `good`, `info`, `neutral`). **`SideLayout`** — главная колонка + боковая 440
(360 при `narrow` и на ≤1360), боковая липнет. **`Grid`**, **`Stack`** — сетка панелей и стопка.

**`RuleSection`** (`ui/section`) — раздел свитка: волосяная линия, заголовок 15.5/800, действия.

## Кнопки и поля (`ui/primitives`)

**`Button`** — `variant`: `primary` (залитая, одна на область) · `secondary` (тонированная, по умолчанию) · `ghost` ·
`quiet` · `risk` (только риск для человека) · `danger` (разрушительное, выглядит обычной) · `paper`/`outline`
(лист с рамкой на тонированном) · `panel` (лист без рамки — полоса массовых действий). `size`: `sm` 40 (по
умолчанию) · `xs` 32 · `md` 48 · `lg` 52 · `icon` 40 · `icon-sm` 32 (у значковой нужен `aria-label`). Прежние
`form`=40, `card`=32, `glyph`=36, `glyph-sm`=32. `icon` — значок слева, `iconEnd` — справа («Далі →»). Раскрытое
меню или ящик — `aria-expanded`: кнопка рисуется «нажатой». **`ButtonLink`** — то же для перехода.
**`buttonClass(variant, size)`** — классы для чужого элемента (label загрузки файла).

**`Field`** — подпись 12/700 над полем, `hint` под ним, `error` — `ErrorText` со значком; полю ставится
`aria-invalid` и `aria-describedby`. `optional` — «— необов’язково». `inline` — поле в строке: подпись скрыта и
встаёт плейсхолдером.

**`Input`** 40 (`look`: `outline` / `fill` — поиск), `icon` слева, `suffix` справа («хв», `<Kbd>/</Kbd>`).
**`Select`** 40 с шевроном. **`Textarea`** от 80. **`Readout`** — значение в силуэте поля без самого поля.
**`Checkbox`** (с `indeterminate`), **`Radio`**, **`CheckLabel`** (подпись + пояснение), **`Switch`** (role=switch),
**`ChoiceCard`** (радио-карточка «Рішення»), **`Segmented`** (выбор вида, aria-pressed), **`Tabs`** (ссылки или
вкладки состояния; `count`), **`ErrorText`** (`tone="warn"` — предупреждение).

```tsx
<Field label="Телефон" error={phoneError}>
  <Input value={phone} onChange={(e) => setPhone(e.target.value)} icon={<Ic.phone />} />
</Field>
```

## Метки и числа

**`Tag`** — пилюля 24: `plain`, `attention` (янтарь), `danger` (риск), `handover` (у чергового — контур), `primary`
(«ваше, сегодня»), `good`, `info`, `done`; `icon`. **`SeverityTag`** — тяжесть со словом: `none`, `mild`, `moderate`,
`modsevere`, `severe`; `small` — 22.

**`BigValue`** — код, «краще ↓/↑», что меряет; 32/800 значение с единицей и словом тяжести; «було 19 → 16»;
изменение с надёжностью. Ничего не считает — шкалы и пороги даёт экран.

```tsx
<BigValues>
  <BigValue code="PHQ-9" measure="депресія" better="down" value={14}
    severity={{ word: "помірна", level: "moderate" }} history={[19, 16]} change={{ delta: -5, threshold: 6 }} />
</BigValues>
```

**`ChangeCell`** — «−14 надійно краще», полоска `RelMeter`, «поріг 11». **`CourseDigits`** — «PHQ-9 19 → 16 → 14» и
плитка направления. **`BetterTag`**. **`Stat`** — число 32/800 с подписью, `null` — прочерк. **`Num`** — табличные
цифры в строке. **`reliabilityOf(delta, threshold, better)`**, **`signed(delta, unit)`** — чистые функции.

Числа — языком экрана: **`decimal(v, lang)`** — дробь запятой в украинском и русском («5,5»), точкой в английском;
**`grouped(n, lang)`** — счёт с разрядами («8 123» неразрывным пробелом, «8,123»). Счётчики набора — вкладки,
пилюли видов, `Count`, число у заголовка `Page`, «з 8 123» пейджера и полосы фильтров, «Вибрано» — уже печатают так.

## Запись о человеке (`ui/records`)

**`AlertStrip`** — строка открытого: всё открытое о человеке одной строкой пилюль, у каждой своё действие.
**`RiskChip`** — красная пилюля сигнала (`timer`, `action`, `state`: `open` / `duty` / `done`, поповер). **`AlertChip`**
— пилюля 34 (`kind`: `neutral`, `message`, `warn`, `good` — только значок), `onClick` или `to`, `pop` — поповер,
`pressed` — её ящик открыт, `draft` — точка черновика, `locked`. **`RiskTimer`** — «2:48 з 4 год» с полоской;
`size="lg"` — плашка в шапке ящика.

```tsx
<AlertStrip>
  <RiskChip title="Сигнал № 214" timer={<RiskTimer elapsed="2:48" of="4 год" pct={70} />}
    action={<Button variant="risk" size="xs" onClick={openReview}>Розібрати</Button>} />
  <AlertChip kind="message" icon={<Ic.message />} label="Повідомлення" detail="учора" onClick={openReply} />
</AlertStrip>
```

**`ListTile`** — плитка списка 12: имя и возраст; пилюля причины и `aside` (мини-курс); `why` — почему сейчас;
`next` — следующий шаг и `when`. `selected`, `unread`, `to` / `onClick`, `peek` — поповер «хто це». **`ListGroup`** —
заголовок группы (маркер, число, пометка). **`PersonCell`** — кружок, имя, строка; `peek`, `to`. **`KV`** — пары
«ключ — значение». **`ActivityList`** — хронология (дата, квадрат 28, текст, действие; `tone`: `risk`, `warn`, `good`).
**`TextAction`** — ссылка-действие в шапке панели и строке.

**`Avatar`** — `name`, `size` (28, 34, 44, 56), `tone` (`violet` пациент, `neutral` сотрудник, `soft`), `initials`.

## Таблица и фильтры

**`DataTable`** — липкий заголовок, сортировка нажатием (`aria-sort`), `selectable` с «выбрать все» и
`bulkActions`, `rowActions` (всплывают на наведении и фокусе), `onRowClick` (нажатие, Enter), J/K и стрелки по
строкам (одна остановка Tab на таблицу), `hotkeys` — J/K с любого места экрана, `pageSize` — страницы снизу,
`rowTone` (`risk`), `isRowActive`, `stateKey` — сортировка, колонки, фасеты и страница в адресе, `facets`,
`csvName`, `dense`, `label`.

```tsx
<Panel flush>
  <FilterBar search={{ value: q, onChange: setQ, placeholder: "ПІБ, картка або телефон" }}
    views={{ items: views, value: view, onChange: setView }} count={{ shown: rows.length, total }}
    sort={{ options, value: sort, onChange: setSort }} />
  <DataTable rows={rows} columns={columns} rowKey={(r) => r.id} stateKey="pt" label="Пацієнти"
    selectable bulkActions={(picked, clear) => <Button variant="panel" size="xs">Написати</Button>}
    rowActions={(r) => <Button variant="quiet" size="icon-sm" aria-label="Відкрити">…</Button>}
    onRowClick={open} pageSize={25} />
  <KbdHints bar keys={[["J K", "рядки"], ["X", "вибрати"], ["Enter", "відкрити"], ["/", "пошук"]]} />
</Panel>
```

Колонка: `{ key, header, render, sort?, num?, width?, csv?, required?, hiddenByDefault? }`. Чистая логика —
`sortRows`, `nextTableSort`, `parseTableSort`, `tableToCsv`, `toggleKey`, `toggleAll`, `selectAllState`, `stepRow`.

**`FilterBar`** — `search` (поле с «/», клавиша «/» ставит туда курсор), `views` (пилюли видов с числами),
`chips`, `count` (`{ shown, total }` → «20 з 248»), `sort` (меню порядка), `right`. По частям: **`SearchField`**,
**`FilterChip`** (`on` + `onClear`, `add`), **`ViewPills`** / **`ViewPill`**, **`SortMenu`**. **`BulkBar`** — «Вибрано: N»,
«Вибрати всіх N», действия, «Зняти вибір»; при 0 не рисуется. **`SavedViews`** (`ui/SavedViews`) — виды с сервера
пилюлями; `counts` — числа, если экран их знает. **`Pager`** — «Показано 1–25 з 248», «По 25 на сторінці», номера.

## Ящик, окно, поповер, сообщения

**`Drawer`** — плавающий справа, 440 (`wide` — 520), углы 18. Модальный по умолчанию (подложка, ловушка фокуса,
возврат фокуса открывшему); `modal={false}` — панель рядом без подложки. Esc, подложка и крестик закрывают;
ящик **не размонтируется** — набранное живёт. Вид с несохранённым вводом (`dirty`) при закрытии говорит
«Чернетку {draftName} збережено» с «Повернутися» (`onReturn`). Фокус при открытии — на `[data-autofocus]` вида или
на крестик.

```tsx
<Drawer open={open} mode={mode} onClose={() => setOpen(false)} onReturn={(m) => { setMode(m); setOpen(true); }}>
  <DrawerPane mode="signal" title="Розбір сигналу № 214" sub="Мельник Андрій, PHQ-9 від 08.10" icon={<Ic.alert />}
    tone="risk" headerExtra={<RiskTimer size="lg" … />} dirty={dirty} draftName="розбору сигналу № 214" kbd="R"
    note="Відкриє підпис № 0451" footer={<Button variant="primary">Зберегти розбір</Button>}>
    <DrawerSection title="Рішення" sub="обов’язково для збереження">…</DrawerSection>
  </DrawerPane>
  <DrawerPane mode="reply" title="Відповідь Андрію">…</DrawerPane>
</Drawer>
```

Один вид — свойства прямо на `Drawer` (`title`, `footer`, `dirty` …) и тело в children.

**`Modal`** — только когда шаг обязан прервать работу. `title`, `sub`, `icon`, `tone`, `footer` (основная первой),
`wide` / `width`. `secret` — подложка не закрывает (одноразовый секрет). `esc={false}` — ни Esc, ни подложка не
закрывают, окно вздрагивает; закрывают только его кнопки. **`ConfirmByName`** — подтверждение перепечатыванием.

**`Popover`** — на наведении и фокусе: `title`, `note`, `content`, `actions`, `side`, `align`, `width`. Ребёнок —
один элемент; не фокусируемому ставится `tabIndex=0`. Tab из триггера уходит в кнопки поповера, Esc закрывает
и возвращает фокус. Место считает `placePopover` (переворот, прижатие к окну). Не класть внутрь `<p>` и
элементов с `transform`. **`Tooltip`** — подпись и клавиша (`kbd`), без действий.

**`useToast()`** — `toast(текст, "ok" | "err" | "info", { action?, icon? })`; сообщение с действием живёт 8 с и
не исчезает под курсором. **`useAction()`** — `run(fn, okText)`: занятость, отказ сообщением, `false` — «не сделал».

Нарисованные открытыми (для `/ui` и справки): **`PopoverCard`**, **`TooltipPlate`**, **`ToastView`**, **`MenuPanel`**
(`ui/menu`), **`DialogFrame`**, **`DrawerPane`** в своей рамке.

**`ActionMenu`** / **`MenuButton`** (`ui/menu`) — меню за глифом: пункты 36 с `icon`, `kbd`, `ruled` (черта перед),
стрелки, Home/End, Esc. **`MenuSeparator`**, **`MenuGroupLabel`**.

## Состояния

**`Loading`** — скелет (`rows`) или отказ (`error`, `title`, `onRetry`); `bare` — внутри панели, без своего листа.
**`Screen`**, **`NotLoaded`**, **`loadView`** — порядок «ждём / отказ / пусто / есть». **`Skeleton`**,
**`SkeletonRows`**. **`Empty`** — квадрат значка, заголовок, одна фраза о том, что сделать, действия; `compact` —
одной строкой внутри панели. **`Callout`** — заметка (`kind`: `neutral`, `violet`, `info`, `warn`, `risk` — только
риск, `good`, `line`), `title`, `actions`. **`NoData`**. **`KbdHints`** / **`Kbd`** — подсказки клавиш
(однобуквенная подсказка обязана быть рабочей клавишей).

## Клавиши экрана (`useHotkeys`)

```ts
useHotkeys({ j: () => step(1), k: () => step(-1), "/": focusSearch, "[": toggleList, Escape: blur }, enabled);
```

- **По месту клавиши, а не по знаку.** Консоль открывают на украинской и русской раскладке: там J печатает «о»,
  «/» — «.», «[» — «х». Набор ищет нажатие под именами по порядку: буква, цифра или знак по месту в английской
  раскладке (`KeyJ` → `j`, с Shift сперва `J`; `Slash` → `/`, с Shift `?`; `BracketLeft` → `[`), потом сам код
  (`KeyJ`, `Digit1` — так пишут карты прежние `useCodeKeys`), потом знак события как есть и строчным (`Escape`,
  стрелки, «?» на Shift+7 русской раскладки). Кириллица в карте рядом с латиницей («о» к `j`) больше не нужна.
- **Молчат в полях ввода**, кроме `Escape`; не трогают сочетаний с ⌘, Ctrl, Alt; не берут нажатие, которое уже
  обработал кто-то ближе к полю (`preventDefault`: меню, строка таблицы, поповер), и набор с подбором.
- Слой поверх экрана (окно, ящик, палитра) клавиши экрана сам не глушит — экран выключает свою карту вторым
  аргументом (`enabled`), пока его слой открыт. Клавиши самого ящика вешает тот, кто ящик рисует.
- Чистые части — `hotkeyNames(e)` и `hotkeyFor(map, e)` (test/kitHotkeys.test.ts).

**`Kbd`** — клавиша-подсказка; `tone`: `panel` (по умолчанию, на листе), `tip` (на плашке подсказки и сообщения),
`fill` (на залитой кнопке — фиолетовой или красной: «Далі Enter»), `appbar` (на полосе приложения).

## Значки

**`Ic`** — значки набора (контуры lucide, штрих 2, `currentColor`): `<Ic.alert size={16} />`. Полный список —
`ui/icons.tsx`. Прежние `Icon*` из `ui/index.tsx` — только те, что ещё стоят на экранах; новое берёт `Ic`. Глифы макета — `ui/glyphs.tsx`.
