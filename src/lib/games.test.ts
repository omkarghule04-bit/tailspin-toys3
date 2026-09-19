import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../../db/test-helpers';
import { categories, publishers, games } from '../../db/schema';
import type { Database } from './db';
import {
    getAllGames,
    getAllCategories,
    getAllGameIds,
    getAllPublishers,
    getCatalogSummary,
    getGamesByPublisher,
    getGameById,
    getPaginatedGames,
} from './games';

async function seedGames(db: Database, count: number): Promise<void> {
    const [category] = await db
        .insert(categories)
        .values({ name: 'Strategy', description: 'cat' })
        .returning({ id: categories.id });
    const [publisher] = await db
        .insert(publishers)
        .values({ name: 'Pub One', description: 'pub' })
        .returning({ id: publishers.id });

    // Insert titles in reverse-alphabetical order to prove ordering is applied.
    for (let i = count; i >= 1; i--) {
        await db.insert(games).values({
            title: `Game ${String(i).padStart(2, '0')}`,
            description: `Description ${i}`,
            starRating: 4.2,
            categoryId: category.id,
            publisherId: publisher.id,
        });
    }
}

describe('games data-access helpers', () => {
    let db: Database;

    beforeEach(async () => {
        db = await createTestDatabase();
    });

    it('returns all games ordered by title', async () => {
        await seedGames(db, 3);
        const all = await getAllGames(db);
        expect(all.map((g) => g.title)).toEqual(['Game 01', 'Game 02', 'Game 03']);
        expect(all[0].category).toEqual({ id: expect.any(Number), name: 'Strategy', description: 'cat' });
        expect(all[0].publisher).toEqual({ id: expect.any(Number), name: 'Pub One', description: 'pub' });
    });

    it('returns all game ids ordered by title', async () => {
        await seedGames(db, 3);
        const ids = await getAllGameIds(db);
        const all = await getAllGames(db);
        expect(ids).toEqual(all.map((g) => g.id));
    });

    it('filters games by category and publisher together', async () => {
        await seedGames(db, 2);
        const categoriesList = await getAllCategories(db);
        const publishersList = await getAllPublishers(db);

        const filtered = await getAllGames(db, {
            categoryIds: [categoriesList[0].id],
            publisherId: publishersList[0].id,
        });

        expect(filtered.map((game) => game.title)).toEqual(['Game 01', 'Game 02']);
    });

    it('returns no games when a category filter does not match', async () => {
        await seedGames(db, 1);
        const filtered = await getAllGames(db, { categoryIds: [99999] });
        expect(filtered).toEqual([]);
    });

    it('returns a title-ordered page with navigation metadata', async () => {
        await seedGames(db, 7);

        const result = await getPaginatedGames(db, { page: 2, pageSize: 3 });

        expect(result.totalGames).toBe(7);
        expect(result.totalPages).toBe(3);
        expect(result.page).toBe(2);
        expect(result.games.map((game) => game.title)).toEqual(['Game 04', 'Game 05', 'Game 06']);
    });

    it('clamps pages beyond the available range', async () => {
        await seedGames(db, 2);

        const result = await getPaginatedGames(db, { page: 99, pageSize: 3 });

        expect(result.page).toBe(1);
        expect(result.games).toHaveLength(2);
    });

    it('returns category and publisher options ordered by name', async () => {
        await db.insert(categories).values([
            { name: 'Zigzag', description: 'cat' },
            { name: 'Arcade', description: 'cat' },
        ]);
        await db.insert(publishers).values([
            { name: 'Zeta', description: 'pub' },
            { name: 'Alpha', description: 'pub' },
        ]);

        expect((await getAllCategories(db)).map((item) => item.name)).toEqual(['Arcade', 'Zigzag']);
        expect((await getAllPublishers(db)).map((item) => item.name)).toEqual(['Alpha', 'Zeta']);
    });

    it('fetches a single game by id', async () => {
        await seedGames(db, 2);
        const ids = await getAllGameIds(db);
        const game = await getGameById(db, ids[0]);
        expect(game?.title).toBe('Game 01');
    });

    it('returns null for a non-existent game', async () => {
        await seedGames(db, 2);
        expect(await getGameById(db, 99999)).toBeNull();
    });

    it('returns publisher games and catalog summary', async () => {
        await seedGames(db, 3);
        const publisher = (await getAllPublishers(db))[0];
        expect((await getGamesByPublisher(db, publisher.id)).map((game) => game.title)).toEqual([
            'Game 01',
            'Game 02',
            'Game 03',
        ]);
        expect(await getCatalogSummary(db)).toEqual({ totalGames: 3, averageRating: 4.2 });
    });

    it('returns a null average for an unrated empty catalog', async () => {
        expect(await getCatalogSummary(db)).toEqual({ totalGames: 0, averageRating: null });
    });
});
