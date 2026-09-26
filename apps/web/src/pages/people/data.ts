import type { AssignableStaff, StaffDirectoryUser, User } from "@quizzy/shared";
import { api } from "../../api";
import { type StaffRow, fromAssignable, fromUser, isStaff, sortByName } from "./model";

/**
 * Справочник сотрудников — из того, что сервер уже отдаёт.
 *
 * Своего маршрута «список лікарів» у сервера нет (см. api_gaps). Есть два
 * соседних: GET /api/users — реестр, закрытый правом users.manage, и
 * GET /api/permissions/staff — «кого я вправе назначать», открытый
 * заведующему. Первый полнее (пол, дата рождения, специальность), второй
 * доступнее. Оба зовутся с `?directory=1`: так в строке есть телефон и
 * профиль приёма (відділення, посада), по которым раздел ищет, фильтрует и
 * группирует (решение заказчика 2026-09-26), а реестр отдаёт одних
 * сотрудников — без пациентов, которых прежде качал целиком ради отбора в
 * браузере. Чтение справочника сервер пишет в журнал с пометкой `phones`.
 *
 * По какому идти, решается ДО запроса — по праву из карточки прав (useAuth
 * → can), а не пробой реестра с откатом по отказу. Проба стоила дорого не
 * консоли, а журналу: отказ в праве сервер пишет как access.denied, экран
 * «Журнал доступу» считает такие записи в красный счётчик «Відмов», и
 * заведующий, открывший список коллег, выглядел бы там как попытка взлома —
 * на каждом заходе, потому что для него это основной путь, а не исключение.
 *
 * `partial` говорит экрану, что перед ним усечённый ответ: он печатает
 * подсказку, а не притворяется полным реестром.
 */
export interface Directory {
  rows: StaffRow[];
  partial: boolean;
}

/** Кто смотрит: свой id и право на реестр — оба решают, по какому маршруту идти */
export interface Viewer {
  id: string;
  canManageUsers: boolean;
}

/**
 * Откуда берётся справочник. Подменяется в проверке (apps/web/test/people.test.ts):
 * решения «какой маршрут» и «когда не ходить вовсе» — это правила доступа и
 * цены, и проверять их живым сервером значило бы проверять случайно.
 */
export interface DirectorySource {
  staffDirectory: () => Promise<StaffDirectoryUser[]>;
  assignableDirectory: () => Promise<AssignableStaff[]>;
}

async function fetchDirectory(viewer: Viewer, src: DirectorySource): Promise<Directory> {
  if (viewer.canManageUsers) {
    /* пациентов сервер в этом режиме не отдаёт; отбор остаётся страховкой от старого сервера */
    const users = await src.staffDirectory();
    return { rows: sortByName(users.filter(isStaff).map(fromUser)), partial: false };
  }
  const staff = await src.assignableDirectory();
  return { rows: sortByName(staff.map(fromAssignable)), partial: true };
}

/*
 * Последний загруженный справочник — на время сеанса, для карточки.
 *
 * Справочник — дорогой ответ не по байтам, а по существу: сервер
 * расшифровывает ФИО, даты рождения и телефоны каждого сотрудника и пишет
 * user.list в журнал. Качать его ради одной строки при каждом открытии
 * карточки значило бы возить номера всех коллег в браузер и в журнал за
 * каждым щелчком по фамилии. Список этот ответ и так получает — карточка
 * берёт строку из него.
 *
 * Кеш привязан к тому, кто смотрит: вышел суперадмин, вошёл заведующий —
 * ему достаётся не чужой реестр, а свой ответ. Срока годности нет: список
 * перечитывает справочник при каждом открытии и обновляет кеш, а карточка
 * коллеги, отставшая на минуту, не стоит второй выгрузки реестра.
 */
let cached: { viewerId: string; dir: Directory } | null = null;

/** Список: всегда свежий ответ, он же становится кешем для карточек */
export async function loadDirectory(viewer: Viewer, src: DirectorySource = api): Promise<Directory> {
  const dir = await fetchDirectory(viewer, src);
  cached = { viewerId: viewer.id, dir };
  return dir;
}

/**
 * Ступени лестницы у каждой строки — по одному запросу на человека.
 *
 * Иначе нельзя: список учётных записей класса лестницы не несёт, а
 * «администратор» — это ступень, а не класс (см. isAdministrator). Запросы
 * идут разом, отказ по одному человеку (ступень выше моей) не роняет
 * список — такой человек остаётся без лестницы и в реестр администраторов
 * не попадает: суперадмин видит всех, а заведующему вышестоящие и не
 * положены. Сотрудников в учреждении десятки, не тысячи; маршрут отдаёт
 * карточку без записи в журнал, поэтому это дёшево и с обеих сторон.
 */
export async function withLadder(rows: StaffRow[]): Promise<StaffRow[]> {
  const cards = await Promise.allSettled(rows.map((r) => api.userPermissions(r.id)));
  return rows.map((r, i) => {
    const c = cards[i];
    return c?.status === "fulfilled" ? { ...r, ladder: c.value.roles.map((x) => x.code) } : r;
  });
}

/**
 * Один сотрудник — из того же справочника: маршрута GET /api/users/:id нет.
 * Своя запись берётся из профиля напрямую: она полнее и не требует права
 * на реестр — свою карточку открывает и рядовой специалист (кадр f03).
 *
 * Чужая — из кеша списка; нет там человека (карточка открыта по ссылке или
 * сразу после заведения) — справочник читается один раз и остаётся для
 * следующих карточек.
 */
/*
 * Ответ обёрнут, а не отдан голым `StaffRow | null`: у useResource «ещё не
 * загружено» — это тоже null, и экран на первом кадре показывал бы «такого
 * сотрудника нет» вместо скелета. Обёртка делает «загружено, но не найден»
 * отличимым от «не загружено».
 */
export async function loadMember(
  id: string,
  viewer: Viewer,
  src: DirectorySource & { me: () => Promise<User> } = api,
): Promise<{ row: StaffRow | null }> {
  if (viewer.id === id) {
    const user = await src.me();
    return { row: fromUser(user) };
  }
  const hit = cached?.viewerId === viewer.id ? cached.dir.rows.find((r) => r.id === id) : undefined;
  if (hit) return { row: hit };
  const dir = await loadDirectory(viewer, src);
  return { row: dir.rows.find((r) => r.id === id) ?? null };
}
