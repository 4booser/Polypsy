import { useState, type FormEvent, type InputHTMLAttributes } from "react";
import { useAuth } from "../auth";
import { useLang } from "../lang";
import { Button, Field } from "../ui/primitives";
import { PublicFrame } from "./public/PublicFrame";

/**
 * Вход — кадр f01: под знаком POLSY заголовок «Введіть логін та пароль щоб
 * продовжити» в две строки и два белых поля «Логін» и «Пароль». Больше на
 * кадре ничего нет — и здесь ничего больше нет.
 *
 * Что ушло с экрана вместе с этим и почему.
 *
 * Карточка на пустом фоне, знак «Q» и подпись «консоль аналитики для
 * сотрудников» — это был экран другого продукта; макет рисует вход тем же
 * листом, что и лендинг, с той же иллюстрацией и подвалом.
 *
 * Вход через Google и самостоятельная регистрация с полями фамилия / имя /
 * телефон. На кадре их нет, а заказчик просил экран один в один и логику под
 * него. Маршруты на сервере (/api/auth/google/*, /api/auth/register) при
 * этом остались как были — их снимать здесь не место, и связь с Google у
 * вошедшего по-прежнему живёт в бургере (App.tsx). Регистрация пациента
 * идёт по приглашению (/join/:token), как и шла.
 *
 * Чего это стоило, названо прямо, потому что экрана под это нет ни одного.
 *
 * 1. Учреждение, поднятое с OPEN_REGISTRATION, из веба учётную запись больше
 *    не заводит: формы нет, а приглашение выписывает сотрудник изнутри.
 *    Признак `openRegistration` из GET /api/auth/google/status с тех пор не
 *    читает никто (клиент берёт из ответа одно поле `enabled`). Взаперти при
 *    этом никто не остаётся, но способность осталась без экрана — нужен
 *    кадр, и это вопрос к заказчику, а не к сборщику.
 * 2. Вход через Google начинается кнопкой, которой на кадре нет. Возврат от
 *    Google при этом починен (App.tsx: «/auth/google» пускается мимо гейта —
 *    раньше не пускался, и код из адреса не разменивался на токены вовсе).
 *    Никто не заперт и здесь: googleCallback учётных записей не заводит и
 *    без привязки отвечает googleNotLinked — значит пароль есть у каждого,
 *    кому Google был доступен.
 *
 * Возвращать снятое «на всякий случай» нельзя: кадр — это и есть задание, а
 * лишняя кнопка на нём — такой же брак, как недостающая.
 *
 * Что осталось сверх кадра, и это названо: кнопка «Увійти» под полями —
 * форма без кнопки не отправляется мышью, а Enter знают не все; и строка
 * отказа под полями с role="alert" — без неё человек перед не сработавшей
 * формой не узнает, почему. Кнопка — та же белая плашка 215 × 45, что и
 * «Увійти» на лендинге: экран входа продолжает лендинг, а не спорит с ним.
 *
 * Поле подписано «Логін», как на кадре, но принимает почту: отдельного
 * логина у учётной записи нет (users.email — единственный ключ входа, по
 * нему же считается защита от перебора), и заводить его — миграция, а не
 * экран. type="email" оставлен ради автозаполнения и клавиатуры телефона;
 * проверку формы браузер не делает (noValidate) — отказ приходит с сервера
 * одной и той же строкой.
 */
export default function Login() {
  const { ut } = useLang();
  const { login, mfa } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * Второй шаг — «код із застосунку» (техпанель, people2): пароль верный, у
   * учётки включён второй фактор. Тот же лист, те же плашки полей — это
   * продолжение входа, а не другой экран.
   */
  if (mfa) return <MfaStep />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : ut("lg.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PublicFrame>
      {/*
        В две строки — не переносом руками, а шириной: 400 вмещает «Введіть
        логін та пароль» (374 на кадре) и не вмещает следующее слово. Перенос
        <br> сломался бы на русском, где строки делятся иначе.
      */}
      <h1 className="m-0 mt-[57px] max-w-[400px] text-[32px] font-bold leading-[44px] text-primary">
        {ut("pub.loginTitle")}
      </h1>
      {/*
        48 от коробки заголовка до первого поля, 22 между полями — с кадра.

        Было 50 при интерлиньяже 43; интерлиньяж выправлен на 44 (см. h1
        выше), заголовок здесь в две строки, и его коробка выросла на 2 —
        отсюда 48. Первое поле как стояло на 503, так и стоит: на кадре его
        белая плашка идёт 503…547 (215 × 45). Отвергнуто: оставить 50 —
        поле уехало бы на два пикселя ниже кадра.

        `[&>label]:mb-0` — снятие чужого отступа, а не украшение: в слое
        наследия у каждой `label` стоит `margin-bottom: 5px`, а поле у Field
        лежит внутри подписи. Коробка поля выходила на 5 выше самого поля, и
        шаг «Логін» → «Пароль» получался 72 вместо 67 с кадра. Снято здесь, на
        двух полях этого экрана, а не в Field: те же 5 заложены в шаг строк
        формы (51 = поле 36 + 15) на остальных экранах консоли, и правка в
        каркасе сдвинула бы их все.
      */}
      <form className="mt-[48px] flex flex-col items-start gap-[22px]" onSubmit={submit} noValidate>
        <Field inline label={ut("pub.login")} className="w-[215px] [&>label]:mb-0">
          <PlateInput
            label={ut("pub.login")}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="username"
            autoFocus
          />
        </Field>
        <Field inline label={ut("lg.password")} className="w-[215px] [&>label]:mb-0">
          <PlateInput
            label={ut("lg.password")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="current-password"
          />
        </Field>

        {/*
          Ошибка стоит между полями и кнопкой: смотрят туда, куда только что
          нажали. Роль alert — чтобы диктор прочитал причину отказа, а не
          оставил человека перед не сработавшей кнопкой.
        */}
        {error ? (
          <p role="alert" className="m-0 max-w-[510px] text-[14px] leading-[22px] text-danger">
            {error}
          </p>
        ) : null}

        <Button type="submit" size="md" variant="paper" disabled={busy} className="w-[215px]">
          {busy ? ut("lg.signingIn") : ut("lg.signIn")}
        </Button>
      </form>
    </PublicFrame>
  );
}

/**
 * Белое поле 215 × 45 на сиреневом листе — так нарисованы «Логін» и
 * «Пароль» на кадре f01: без рамки, радиус 5, подпись внутри 20/400 серым.
 *
 * Это не Input из примитивов, и не потому, что тот плох. У Input два
 * начертания консоли — контурное 36 с рамкой #666666 и залитое сиреневым, —
 * и оба с подписью 17/700 фиолетовым. Здесь другая подпись, другая высота и
 * нет рамки: три спорящих класса поверх Input решались бы порядком утилит в
 * собранном CSS, а не тем, что написано в разметке (см. пояснение к высоте
 * полей в primitives.tsx). Поле лежит в Field: подпись остаётся именем для
 * диктора, плейсхолдер — тем, что видно глазу.
 *
 * Набранный текст — фиолетовым, как всё на этом листе; серым набран только
 * плейсхолдер, иначе пустое поле не отличить от заполненного.
 *
 * Подпись приходит пропсом от того, кто поле ставит, а не угадывается по
 * `type`. Угадывание («type === password» → «Пароль», иначе «Логін») делало
 * из одной строки экрана две правды в семи строках друг от друга: подпись
 * стояла и у Field, и здесь, а связывало их совпадение типа. Третье поле с
 * type="text" молча подписалось бы «Логін».
 */
/**
 * Второй шаг входа (people2): одно поле на оба случая — шесть цифр из
 * приложения и код восстановления. Человек с потерянным телефоном вводит то,
 * что у него есть; различает их сервер (lib/totp.ts, looksLikeRecovery).
 * `autocomplete=one-time-code` — телефон сам предложит код.
 */
function MfaStep() {
  const { ut } = useLang();
  const { completeMfa, cancelMfa } = useAuth();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = code.trim().length >= 6;
  return (
    <PublicFrame>
      <h1 className="m-0 mt-[57px] max-w-[400px] text-[32px] font-bold leading-[44px] text-primary">{ut("lg.mfa.title")}</h1>
      <form
        className="mt-[24px] flex flex-col items-start gap-[22px]"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || busy) return;
          setBusy(true);
          setError(null);
          completeMfa(code.trim())
            .catch((err) => setError(err instanceof Error ? err.message : ut("lg.failed")))
            .finally(() => setBusy(false));
        }}
      >
        <p className="m-0 max-w-[420px] text-[15px] leading-[21px] text-primary">{ut("lg.mfa.hint")}</p>
        <Field inline label={ut("lg.mfa.title")} className="w-[215px] [&>label]:mb-0">
          <PlateInput
            label={ut("lg.mfa.title")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            maxLength={12}
            autoFocus
            className="font-mono tabular-nums"
          />
        </Field>
        {error ? (
          <p role="alert" className="m-0 max-w-[510px] text-[14px] leading-[22px] text-danger">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="md" variant="paper" disabled={busy || !ready} className="w-[215px]">
          {busy ? ut("lg.signingIn") : ut("lg.signIn")}
        </Button>
        <Button variant="quiet" onClick={cancelMfa}>
          {ut("lg.mfa.back")}
        </Button>
      </form>
    </PublicFrame>
  );
}

function PlateInput({
  label,
  className,
  ...rest
}: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      placeholder={label}
      /*
       * `block`: строчное поле оставляет под собой место под выносные буквы
       * строки, и подпись-обёртка становится выше своих 45.
       */
      className={
        "block h-[45px] w-[215px] rounded-[5px] border-0 bg-[var(--bg)] px-[14px] text-[20px] text-primary " +
        /*
         * Подпись в пустом поле — #666666 с кадра f01 (роль --placeholder,
         * см. tokens.css). Стоял --muted, приглушённый консоли: он на
         * тринадцать единиц темнее, потому что поднят ради сиреневых
         * поверхностей, которых у этого поля нет.
         */
        "placeholder:text-[20px] placeholder:font-normal placeholder:text-[var(--placeholder)] " +
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 " +
        "focus-visible:ring-offset-[var(--surface-2)] " +
        (className ?? "")
      }
      {...rest}
    />
  );
}
