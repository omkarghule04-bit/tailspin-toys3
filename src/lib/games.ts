import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { Database } from './db';
import { games, categories, publishers } from '../../db/schema';
import type { Game } from '../types/game';

const gameSelection = {
    id: games.id,
    title: games.title,
    description: games.description,
    starRating: games.starRating,
    categoryId: categories.id,
    categoryName: categories.name,
    publisherId: publishers.id,
    publisherName: publishers.name,
};

type GameSelectionRow = {
    id: number;
    title: string;
    description: string;
    starRating: number | null;
    categoryId: number | null;
    categoryName: string | null;
    publisherId: number | null;
    publisherName: string | null;
};

export interface GameFilters {
    categoryIds?: number[];
    publisherId?: number;
}

export interface Pagination {
    page: number;
    pageSize: number;
}

export interface PaginatedGames {
    games: Game[];
    page: number;
    pageSize: number;
    totalGames: number;
    totalPages: number;
}

function mapGame(row: GameSelectionRow): Game {
    return {
        id: row.id,
        title: row.title,
        description: row.description,
        starRating: row.starRating,
        category:
            row.categoryId !== null && row.categoryName !== null
                ? { id: row.categoryId, name: row.categoryName }
                : null,
        publisher:
            row.publisherId !== null && row.publisherName !== null
                ? { id: row.publisherId, name: row.publisherName }
                : null,
    };
}

function baseGamesQuery(db: Database) {
    return db
        .select(gameSelection)
        .from(games)
        .leftJoin(categories, eq(games.categoryId, categories.id))
        .leftJoin(publishers, eq(games.publisherId, publishers.id));
}

/**
 * Returns games matching optional category and publisher filters, ordered by title.
 *
 * @param db Injectable Drizzle database instance.
 * @param filters Optional category IDs and publisher ID to constrain the results.
 * @returns Games matching every supplied filter.
 */
export async function getAllGames(db: Database, filters: GameFilters = {}): Promise<Game[]> {
    const conditions = [];
    if (filters.categoryIds && filters.categoryIds.length > 0) {
        conditions.push(inArray(games.categoryId, filters.categoryIds));
    }
    if (filters.publisherId !== undefined) {
        conditions.push(eq(games.publisherId, filters.publisherId));
    }

    const rows = await baseGamesQuery(db)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(asc(games.title));
    return rows.map(mapGame);
}

/**
 * Returns one stable, title-ordered page of games and its navigation metadata.
 *
 * @param db Injectable Drizzle database instance.
 * @param pagination One-based page number and positive page size.
 * @param filters Optional category IDs and publisher ID to constrain the results.
 * @returns The requested page, clamped to the available page range, and totals.
 */
export async function getPaginatedGames(
    db: Database,
    pagination: Pagination,
    filters: GameFilters = {},
): Promise<PaginatedGames> {
    const pageSize = Math.max(1, Math.floor(pagination.pageSize));
    const requestedPage = Math.max(1, Math.floor(pagination.page));
    const conditions = [];
    if (filters.categoryIds && filters.categoryIds.length > 0) {
        conditions.push(inArray(games.categoryId, filters.categoryIds));
    }
    if (filters.publisherId !== undefined) {
        conditions.push(eq(games.publisherId, filters.publisherId));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const [{ totalGames }] = await db
        .select({ totalGames: count(games.id) })
        .from(games)
        .where(where);
    const totalPages = Math.max(1, Math.ceil(totalGames / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const rows = await baseGamesQuery(db)
        .where(where)
        .orderBy(asc(games.title))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

    return {
        games: rows.map(mapGame),
        page,
        pageSize,
        totalGames,
        totalPages,
    };
}

/**
 * Returns all category options ordered alphabetically by name.
 *
 * @param db Injectable Drizzle database instance.
 * @returns Category IDs and names for filter controls.
 */
export async function getAllCategories(db: Database): Promise<{ id: number; name: string }[]> {
    return db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .orderBy(asc(categories.name));
}

/**
 * Returns all publisher options ordered alphabetically by name.
 *
 * @param db Injectable Drizzle database instance.
 * @returns Publisher IDs and names for filter controls.
 */
export async function getAllPublishers(db: Database): Promise<{ id: number; name: string }[]> {
    return db
        .select({ id: publishers.id, name: publishers.name })
        .from(publishers)
        .orderBy(asc(publishers.name));
}

/**
 * Returns all game IDs ordered by title.
 *
 * @param db Injectable Drizzle database instance.
 * @returns Game IDs in title order.
 */
export async function getAllGameIds(db: Database): Promise<number[]> {
    const rows = await db.select({ id: games.id }).from(games).orderBy(asc(games.title));
    return rows.map((row) => row.id);
}

/**
 * Returns a single game by ID, or null when it does not exist.
 *
 * @param db Injectable Drizzle database instance.
 * @param id Game ID to look up.
 * @returns The matching game or null.
 */
export async function getGameById(db: Database, id: number): Promise<Game | null> {
    const row = await baseGamesQuery(db).where(eq(games.id, id)).get();
    return row ? mapGame(row) : null;
}
