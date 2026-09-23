import { Link } from "react-router-dom";
import { useLang } from "../../lang";
import { PublicFrame } from "./PublicFrame";

/*
 * Лендинг «Про кампанію» — кадр f00. Что видит тот, кто открыл корень, не
 * войдя: до этого корень отдавал сразу форму входа, и шага «прочитал → нажал
 * «Увійти» → попал на вход» в системе не было.
 *
 * Под знаком (его рисует рамка): заголовок 32/700, абзац 20/400 с
 * интерлиньяжем 29 в колонке 510 — ровно ширина текста на кадре, при которой
 * строки ложатся так же, — и белая кнопка 215 × 45 с «Увійти» 22/700 — та же
 * кнопка формы, что и в консоли, только белой плашкой на сиреневом (вариант
 * paper у Button), потому что это ссылка на экран входа, а не действие.
 *
 * Отступы сверху вниз — с кадра: 57 от знака до заголовка, 42 до абзаца, 33
 * до кнопки. Считаются от коробок строк с интерлиньяжем 43 и 29, поэтому
 * выглядят не круглыми: круглить их значило бы сдвинуть текст на кадре.
 */
export default function Landing() {
  const { ut } = useLang();
  return (
    <PublicFrame>
      <section id="about" aria-labelledby="about-title" className="mt-[57px]">
        <h1 id="about-title" className="m-0 text-[32px] font-bold leading-[43px] text-primary">
          {ut("pub.about")}
        </h1>
        <p className="m-0 mt-[42px] max-w-[510px] text-[20px] leading-[29px] text-primary">
          {ut("pub.aboutText")}
        </p>
        <Link
          to="/login"
          className={
            "mt-[33px] inline-flex h-[45px] w-[215px] items-center justify-center rounded-[5px] " +
            "bg-[var(--bg)] text-[22px] font-bold leading-none text-primary no-underline " +
            "transition-[filter] duration-[var(--dur-fast)] hover:no-underline hover:brightness-95 " +
            "active:brightness-90 outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] " +
            "focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-2)]"
          }
        >
          {ut("lg.signIn")}
        </Link>
      </section>
    </PublicFrame>
  );
}
