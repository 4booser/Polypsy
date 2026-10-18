import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

/**
 * Значение, живущее в адресной строке.
 *
 * Смысл не в красоте адреса, а в том, что вид экрана можно передать: «открой
 * тревоги за март, отсортированные по дате» становится ссылкой, а не устной
 * инструкцией. Плюс перезагрузка страницы не сбрасывает разбор наполовину.
 *
 * Пишем через replace: каждый щелчок по заголовку столбца не должен добавлять
 * запись в историю браузера — «назад» обязано уводить со страницы, а не
 * отменять сортировку по одному шагу.
 */
export function useUrlState(
  name: string,
  fallback = "",
): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(name) ?? fallback;
  const set = useCallback(
    (next: string) => {
      setParams(
        (prev) => {
          const copy = new URLSearchParams(prev);
          if (!next || next === fallback) copy.delete(name);
          else copy.set(name, next);
          return copy;
        },
        { replace: true },
      );
    },
    [name, fallback, setParams],
  );
  return [value, set];
}
