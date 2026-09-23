import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useLang } from "../../lang";
import { LangToggle, Logo } from "../../shell/Topbar";
import { cx } from "../../ui/cx";
import { IconFacebook, IconTelegram, IconYouTube } from "./social";

/*
 * Рамка публичных страниц — кадры f00 (лендинг) и f01 (вход).
 *
 * Оба кадра — один лист: «Укр» в левом верхнем углу, круглый знак POLSY над
 * содержимым, справа силуэт головы со звёздным небом, по всему полю волны,
 * внизу подвал с разделами, контактами и соцсетями. Различаются кадры только
 * тем, что стоит под знаком, — это и есть `children`. Рисовать лист дважды
 * значило бы получить два подвала, которые разъедутся на первой же правке
 * телефона.
 *
 * Замеры кадра (1600 × 900, колонка 1200 с полями по 200 — та же, что у
 * полосы консоли):
 *
 *   «Укр»        20/700, верх строки 57, отступ 117 от левого края колонки
 *   знак         136 × 136, верх 174 (97 под словом «Укр»)
 *   заголовок    32/700, интерлиньяж 43, 57 под знаком
 *   подвал       130 высотой, заливка #f0ecff, текст 14/400 с шагом 22;
 *                колонки на 0, 254 и 657 от края колонки; знак 80 × 80 у
 *                правого края; «©год» по центру у нижней кромки
 *
 * Иллюстрация — растр, а не SVG, и это единственная картинка в консоли.
 * Силуэт залит фотографией галактики; нарисовать её штрихом нельзя, а без
 * неё кадр — не тот кадр. Файл public/landing.webp вырезан из макета
 * заказчика (текст и кнопки с кадра затёрты), лежит рядом со шрифтами и
 * отдаётся с того же адреса — внешних источников по-прежнему нет. Он
 * подложен фоном, а не поставлен <img>: у него нет содержания, о котором
 * стоило бы сказать диктору, и он обязан подстраиваться под ширину окна,
 * что фон делает сам (`cover`): на 1600 совпадает с кадром пиксель в
 * пиксель, на другой ширине голова остаётся у правого края, а текст — в
 * колонке.
 *
 * Цвета — токенами светлой темы. Тёмной темы у публичных страниц нет: App
 * ставит светлую, пока никто не вошёл (см. App.tsx), поэтому `text-primary`
 * здесь всегда #663399 с кадра, а не осветлённый фиолетовый тёмной земли
 * поверх сиреневого фона.
 */

/** Колонка 1200 по центру — та же, что у полосы консоли (Topbar.tsx) */
const COLUMN = "mx-auto w-full max-w-[1232px] px-4";

/*
 * 117 — отступ содержимого от левого края колонки, снятый с кадра. На узком
 * окне он снимается: 117 плюс поля съели бы у телефона треть ширины.
 */
const INDENT = "pl-[117px] max-[900px]:pl-0";

export function PublicFrame({ children }: { children: ReactNode }) {
  const { ut } = useLang();
  return (
    <div className="flex min-h-screen flex-col bg-surface-2 text-primary">
      {/*
        Фон лежит на обёртке шапки и содержимого, а не на <main>: слово «Укр»
        стоит в <header> вне <main> — так оно остаётся ориентиром banner для
        диктора и смоука (helpers.langToggle ищет его именно там), а картинка
        при этом одна на всю верхнюю часть листа, без шва между шапкой и
        содержимым.
      */}
      <div className="flex flex-1 flex-col bg-[url('/landing.webp')] bg-cover bg-top">
        <header className={COLUMN}>
          {/*
            flex, а не блок: у блока строка «Укр» получила бы интерлиньяж
            листа (22 на 14-й кегль) и стала бы выше своих 20, а от её низа
            считается отступ до знака.
          */}
          <div className={cx(INDENT, "flex pt-[57px]")}>
            <LangToggle />
          </div>
        </header>
        <main className={cx(COLUMN, "flex-1")}>
          {/* 66 под последним элементом — расстояние от кнопки «Увійти» до подвала на кадре */}
          <div className={cx(INDENT, "pb-[66px]")}>
            <Link
              to="/"
              aria-label={ut("pub.home")}
              className={
                "mt-[97px] block w-fit rounded-full outline-none " +
                "focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
              }
            >
              <Logo size={136} />
            </Link>
            {children}
          </div>
        </main>
      </div>
      <Footer />
    </div>
  );
}

/*
 * Подвал. Три колонки текста и знак справа — ровно как на кадре.
 *
 * «FAQ» и «Для преси» набраны текстом, а не ссылкой. Своих кадров у них нет,
 * блоков на лендинге — тоже (единственный якорь листа — «about»), и ссылка
 * вела в никуда: на лендинге нажатие не двигало страницу вовсе, а с экрана
 * входа уводило на лендинг без единого признака, что раздела нет. Заводить
 * разделы наугад нельзя — страница без кадра нарисована наугад, — но ссылка,
 * которая не работает, хуже её отсутствия: она обещает переход и не делает
 * его. Строки остались на своих местах и своим начертанием, как на кадре;
 * когда заказчик даст тексты, здесь появятся <Link> на новые якоря.
 *
 * Телефон и почта — настоящие ссылки (tel:, mailto:), а не текст: на
 * телефоне по контакту нажимают, а не переписывают.
 *
 * «©2023» — дословно с кадра. Подставлять текущий год (застывший год читается
 * как заброшенный сайт) — разумно, но это решение заказчика, а не сборщика:
 * он просил экраны один в один, и это было единственное место, где текст
 * кадра на экране не воспроизведён.
 */
function Footer() {
  const { ut } = useLang();
  /*
   * Адреса ссылок — из тех же строк словаря, что и подписи: телефон до тире,
   * без пробелов. Второй записи номера в коде нет — иначе подпись и ссылка
   * разошлись бы при первой же правке реквизитов.
   */
  const phone = ut("pub.phone");
  const tel = `tel:${phone.split("—")[0]!.replace(/\s+/g, "")}`;
  const mail = `mailto:${ut("pub.email")}`;
  const link =
    "text-primary no-underline outline-none hover:underline " +
    "focus-visible:ring-2 focus-visible:ring-[var(--focus)]";
  return (
    <footer className="bg-surface-2">
      <div
        className={cx(
          COLUMN,
          "flex min-h-[130px] flex-col pb-[12px] pt-[20px] text-[14px] leading-[22px]",
        )}
      >
        {/*
          Высота ряда задана (66 = три строки по 22), и знак 80 её не
          раздвигает: на кадре он свисает ниже последней строки и заходит в
          полосу, где по центру стоит «©год», — по горизонтали они не
          встречаются. Оставить ряду расти по содержимому значило бы получить
          подвал 139 вместо 130 с кадра: знак утолкал бы «©» вниз, а с ним
          уехала бы вверх кромка сиреневой заливки.

          На узком окне высота снимается: там колонки переносятся, и обрезать
          их ради числа с кадра нельзя.
        */}
        <div className="flex h-[66px] flex-wrap gap-y-4 max-[900px]:h-auto">
          <nav aria-label={ut("pub.sections")} className="w-[254px] shrink-0 max-[900px]:w-full">
            <ul className="m-0 flex list-none flex-col p-0">
              <li>
                <Link to="/#about" className={link}>
                  {ut("pub.about")}
                </Link>
              </li>
              {/* без <Link>: якорей «faq» и «press» на листе нет — см. пояснение выше */}
              <li>{ut("pub.faq")}</li>
              <li>{ut("pub.press")}</li>
            </ul>
          </nav>
          <address className="w-[403px] shrink-0 not-italic max-[900px]:w-full">
            <div>{ut("pub.contacts")}</div>
            <div>
              <a href={tel} className={link}>
                {ut("pub.phone")}
              </a>
            </div>
            <div>
              <a href={mail} className={link}>
                {ut("pub.email")}
              </a>
            </div>
          </address>
          <div className="min-w-0 flex-1 max-[900px]:w-full max-[900px]:flex-none">
            <div>{ut("pub.social")}</div>
            {/*
              Значки 28 × 28 с зазором 8, как на кадре, а нажимается 44: ссылка
              занимает 44 × 44 и втянута отрицательными полями на 8 с каждой
              стороны, так что в потоке она занимает ровно свои 28. Соседние
              области нажатия при этом перекрываются на 8 — как у стрелок
              страниц в консоли, промах достаётся ближайшему значку.

              Адреса страниц учреждения в сетях заказчик не дал; до них
              значки ведут на сами сети (см. social.tsx).
            */}
            <div className="mt-[3px] flex gap-[8px]">
              <SocialLink href="https://www.facebook.com/" label={ut("pub.facebook")}>
                <IconFacebook />
              </SocialLink>
              <SocialLink href="https://www.youtube.com/" label={ut("pub.youtube")}>
                <IconYouTube />
              </SocialLink>
              <SocialLink href="https://t.me/" label={ut("pub.telegram")}>
                <IconTelegram />
              </SocialLink>
            </div>
          </div>
          {/* верх знака на 27 ниже кромки подвала: 20 отступа плюс 7 */}
          <Link
            to="/"
            aria-label={ut("pub.home")}
            className={
              "mt-[7px] block shrink-0 self-start rounded-full outline-none " +
              "focus-visible:ring-2 focus-visible:ring-[var(--focus)] max-[900px]:ml-auto"
            }
          >
            <Logo size={80} />
          </Link>
        </div>
        <div className="mt-auto text-center">{ut("pub.copyright")}</div>
      </div>
    </footer>
  );
}

function SocialLink({ href, label, children }: { href: string; label: string; children: ReactNode }) {
  return (
    <a
      href={href}
      aria-label={label}
      target="_blank"
      rel="noreferrer"
      className={
        "-m-[8px] flex size-[44px] items-center justify-center rounded-full text-primary " +
        "outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
      }
    >
      {children}
    </a>
  );
}
