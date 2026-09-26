import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLang } from "../lang";
import { Button } from "../ui/primitives";
import { reportReactError } from "./client";

/**
 * Граница ошибок: упал экран — падает экран, а не консоль.
 *
 * Своей границы в консоли не было: исключение при отрисовке любого экрана
 * снимало всё дерево React, и человек видел белый лист — без полосы, без
 * меню, без способа уйти на другой экран, кроме перезагрузки. Здесь три
 * границы (решение заказчика 2026-09-26, техпанель, участок obs2b):
 *
 *   — вокруг содержимого консоли (App.tsx): полоса и меню остаются, упавший
 *     экран заменяется этим листом, а переход на другой адрес сбрасывает
 *     его сам (`resetKey` — путь);
 *   — вокруг кабинета пациента — то же для него;
 *   — корневая (main.tsx) — последний рубеж, если упала сама оболочка.
 *
 * Каждое падение уходит в «Помилки клієнта» техпанели (client.ts) — без
 * данных: адрес шаблоном, текст вычищен.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportReactError(error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: string }): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  render(): ReactNode {
    if (this.state.failed) return <CrashScreen onRetry={() => this.setState({ failed: false })} />;
    return this.props.children;
  }
}

/*
 * Лист падения — словами, без технических подробностей: человеку за
 * консолью стек ничего не скажет, а разработчику он уже ушёл в техпанель.
 * Две кнопки: «спробувати ще раз» перерисовывает экран (помогает, если
 * упало на данных, которые уже обновились), «оновити сторінку» — полная
 * перезагрузка.
 */
function CrashScreen({ onRetry }: { onRetry: () => void }) {
  const { ut } = useLang();
  return (
    <div role="alert" className="mx-auto w-full max-w-[640px] px-[16px] py-[48px]">
      <h2 className="m-0 text-[20px] font-bold leading-[24px] text-primary">{ut("o2b.crash.title")}</h2>
      <p className="m-0 mt-[12px] text-[15px] leading-[21px] text-muted">{ut("o2b.crash.text")}</p>
      <div className="mt-[24px] flex flex-wrap gap-[12px]">
        <Button onClick={onRetry}>{ut("o2b.crash.retry")}</Button>
        <Button variant="quiet" onClick={() => location.reload()}>
          {ut("o2b.crash.reload")}
        </Button>
      </div>
    </div>
  );
}
