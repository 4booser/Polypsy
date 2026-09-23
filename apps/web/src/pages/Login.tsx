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
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      <h1 className="m-0 mt-[57px] max-w-[400px] text-[32px] font-bold leading-[43px] text-primary">
        {ut("pub.loginTitle")}
      </h1>
      {/*
        50 от коробки заголовка до первого поля, 22 между полями — с кадра.

        `[&>label]:mb-0` — снятие чужого отступа, а не украшение: в слое
        наследия у каждой `label` стоит `margin-bottom: 5px`, а поле у Field
        лежит внутри подписи. Коробка поля выходила на 5 выше самого поля, и
        шаг «Логін» → «Пароль» получался 72 вместо 67 с кадра. Снято здесь, на
        двух полях этого экрана, а не в Field: те же 5 заложены в шаг строк
        формы (51 = поле 36 + 15) на остальных экранах консоли, и правка в
        каркасе сдвинула бы их все.
      */}
      <form className="mt-[50px] flex flex-col items-start gap-[22px]" onSubmit={submit} noValidate>
        <Field inline label={ut("pub.login")} className="w-[215px] [&>label]:mb-0">
          <PlateInput
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            autoComplete="username"
            autoFocus
          />
        </Field>
        <Field inline label={ut("lg.password")} className="w-[215px] [&>label]:mb-0">
          <PlateInput
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
 */
function PlateInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const { ut } = useLang();
  const label = rest.type === "password" ? ut("lg.password") : ut("pub.login");
  return (
    <input
      placeholder={label}
      /*
       * `block`: строчное поле оставляет под собой место под выносные буквы
       * строки, и подпись-обёртка становится выше своих 45.
       */
      className={
        "block h-[45px] w-[215px] rounded-[5px] border-0 bg-[var(--bg)] px-[14px] text-[20px] text-primary " +
        "placeholder:text-[20px] placeholder:font-normal placeholder:text-muted " +
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-offset-2 " +
        "focus-visible:ring-offset-[var(--surface-2)] " +
        (className ?? "")
      }
      {...rest}
    />
  );
}
