import type { ReactNode } from "react";
import type { NativeStackHeaderProps } from "expo-router";
import type { BottomTabHeaderProps } from "expo-router/js-tabs";
import { OfflineBar } from "../components/OfflineBar";
import { useLang } from "../lang";
import { useColors } from "../theme";
import { BackButton, HelpPill, NavBar } from "./NavBar";

/*
 * Шапки навигаторов на полосе «Виразной».
 *
 * Навигаторы (Stack, Tabs) рисуют шапку сами, и их шапка — белая строка с
 * системной стрелкой. Здесь — адаптеры: опции экрана (title, headerLeft,
 * headerRight, headerBackTitle) переводятся в NavBar, поэтому экраны, которые
 * ставят заголовок через navigation.setOptions({ title }), продолжают его
 * ставить и получают новую шапку без правок.
 */

type HeaderSlot = ((props: { canGoBack: boolean; tintColor?: string }) => ReactNode) | undefined;

function titleOf(options: { title?: string; headerTitle?: unknown }, fallback: string): string {
  return typeof options.headerTitle === "string" ? options.headerTitle : (options.title ?? fallback);
}

/**
 * Шапка вложенного экрана: «‹ Назад» (или своё слева), компактный заголовок
 * по центру, справа — headerRight экрана; help — «Допомога» справа, если
 * своего действия нет (прохождение методики).
 */
export function StackHeader({ navigation, route, options, back, help }: NativeStackHeaderProps & { help?: boolean }) {
  const c = useColors();
  const { ut } = useLang();
  const canGoBack = !!back;
  const custom = (options.headerLeft as HeaderSlot)?.({ canGoBack, tintColor: c.vink });
  /*
   * Подпись стрелки — имя экрана, куда она вернёт. У группы вкладок имени
   * нет («(app)»), и тогда — просто «Назад».
   */
  const backTitle = options.headerBackTitle ?? back?.title;
  const label = backTitle && !backTitle.startsWith("(") ? backTitle : ut("common.back");
  const left = custom ?? (back ? <BackButton label={label} onPress={navigation.goBack} /> : null);
  const right = (options.headerRight as HeaderSlot)?.({ canGoBack, tintColor: c.vink }) ?? (help ? <HelpPill /> : null);
  return <NavBar title={titleOf(options, route.name)} left={left} right={right} />;
}

/**
 * Шапка корневого экрана вкладки: крупный заголовок на полосе и
 * «Допомога» справа у пациента — помощь видна с любой вкладки. Под
 * заголовком — полоса «нет связи», если в очереди что-то ждёт: она видна на
 * любой вкладке, а не только там, куда человек догадается зайти.
 */
export function TabHeader({ navigation, route, options, help }: BottomTabHeaderProps & { help?: boolean }) {
  const c = useColors();
  const { ut } = useLang();
  const right = (options.headerRight as HeaderSlot)?.({ canGoBack: false, tintColor: c.vink }) ?? (help ? <HelpPill /> : null);
  /*
   * Экран-не-вкладка (href: null — переписка, план, очередь) открывают
   * кнопкой с другого экрана, и вернуться с него надо той же дорогой: у него
   * «‹ Назад», а полосы очереди нет — с очереди она вела бы на саму себя.
   */
  const hidden = (options.tabBarItemStyle as { display?: string } | undefined)?.display === "none";
  if (hidden) {
    const back = { label: ut("common.back"), onPress: () => navigation.goBack() };
    return <NavBar large title={titleOf(options, route.name)} back={back} right={right} />;
  }
  return <NavBar large title={titleOf(options, route.name)} right={right} below={<OfflineBar />} />;
}
