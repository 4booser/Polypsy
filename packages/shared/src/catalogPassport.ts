import type { Administration } from "./types";

/**
 * Клинический паспорт методики каталога — то, что специалист читает, когда
 * выбирает методику: роль, объём и время, что она измеряет, пороги и куда
 * ведёт положительный результат короткой формы.
 *
 * Содержимое паспорта — в apps/api/src/instruments/catalogPassport.ts (по
 * ключу каталога), здесь — только форма ответа сервера и общий для сервера и
 * клиента расчёт времени. Отдаётся только сотруднику: обследуемому ни роль, ни
 * пороги ни к чему, а пороги — часть ключа (#141).
 */

/**
 * Роль методики в каталоге:
 *
 *   full      — полная методика: меряет выраженность или профиль, ею
 *               подтверждают и отслеживают;
 *   short     — скринінгова (скорочена) форма: отвечает на вопрос «смотреть ли
 *               дальше»; если полная методика есть в каталоге, строка короткой
 *               стоит под ней;
 *   clinician — оценка фахівцем: шкалу заполняет специалист наблюдением или
 *               интервью (4AT, CIWA-Ar, COWS, ASSIST, C-SSRS).
 *
 * Порядок перечня — порядок в направлении каталога: полные первыми.
 */
export const CATALOG_ROLES = ["full", "short", "clinician"] as const;

export type CatalogRole = (typeof CATALOG_ROLES)[number];

/** Сравнение порога: «≥ 3», «≤ 2», «< 3» — как в ключе полос */
export type CutoffOp = ">=" | "<=" | "<" | ">";

/**
 * Ссылка на другую методику каталога — полную, короткую или следующий шаг.
 * `surveyId` null — методики нет в учреждении или она вне зоны читающего:
 * тогда показывается название из каталога, без перехода.
 */
export interface CatalogLink {
  key: string;
  surveyId: string | null;
  /** Название на языке читающего — из строки учреждения, иначе из каталога */
  title: string;
}

/** Порог методики и что он значит — на языке читающего */
export interface CatalogCutoff {
  /** Шкала названием; null — у методики одна шкала с полосами или порог общий для всех шкал */
  scale: string | null;
  op: CutoffOp;
  value: number;
  means: string;
}

/**
 * Шаг ступенчатого скрининга: положительный результат короткой формы ведёт к
 * полной методике. Порог — из первоисточника (`source`), не выдуманный; по
 * этому же шагу установщик каталога заводит правило поддержки решений
 * (lib/catalogInstall.ts, installRules).
 */
export interface CatalogStep {
  scale: string | null;
  op: CutoffOp;
  value: number;
  next: CatalogLink;
  /** Откуда порог — ссылка на первоисточник, по-украински, как «Джерело» паспорта */
  source: string;
}

export interface CatalogPassport {
  role: CatalogRole;
  /** Обычное время заполнения, минут (≈) */
  minutes: number;
  /**
   * Что измеряет — одна клиническая строка для специалиста (не описание для
   * обследуемого); null — у методики учреждения паспорта каталога нет
   */
  purpose: string | null;
  cutoffs: CatalogCutoff[];
  /** Полная методика — у короткой формы (первая — под которой стоит строка в каталоге) */
  fullForms: CatalogLink[];
  /** Короткие формы — у полной методики, от короткой к длинной */
  shortForms: CatalogLink[];
  steps: CatalogStep[];
}

/**
 * Паспорт строки каталога: то же без ссылок на короткие формы — строка
 * короткой формы сама стоит под полной. `parent` — ключ полной методики, под
 * которой строку вкладывают.
 */
export interface CatalogRowPassport {
  role: CatalogRole;
  minutes: number;
  /** null — у методики учреждения клинического описания нет */
  purpose: string | null;
  cutoffs: CatalogCutoff[];
  parent: string | null;
  steps: CatalogStep[];
}

/**
 * Время заполнения по числу пунктов — когда руководство времени не называет.
 *
 * Самоотчёт — около 15 секунд на пункт вместе с чтением инструкции (PHQ-9:
 * девять пунктов — около трёх минут, PCL-5: двадцать — около пяти), оценка
 * специалистом — около 20 секунд: он спрашивает и наблюдает. Округляется
 * вверх до минуты, меньше минуты не бывает. Это ориентир для выбора, а не
 * норматив: строка паспорта пишет «≈».
 */
export function estimateMinutes(items: number, administration: Administration): number {
  const perItem = administration === "clinician" ? 20 : 15;
  return Math.max(1, Math.ceil((Math.max(0, items) * perItem) / 60));
}

/** Роль методики, у которой паспорта каталога нет: по тому, кто её заполняет */
export function fallbackRole(administration: Administration): CatalogRole {
  return administration === "clinician" ? "clinician" : "full";
}
