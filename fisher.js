const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

// ===== Конфиг =====
const CONFIG = {
    host: 'localhost',
    port: 25565,
    username: 'FisherBot',
    version: false,
    auth: 'offline',

    searchRadius: 32,
    standDistance: 3,

    fishTimeout: 40000,
    catchCooldown: 800,
    statusInterval: 60000,

    chestSearchRadius: 64,          // радиус поиска сундуков
    depositAfterCatches: 1,        // складывать каждые N рыб
    rodDurabilityThreshold: 0.05,   // менять удочку при остатке <5%

    itemsToStore: [
        'cod', 'salmon', 'tropical_fish', 'pufferfish',
        'raw_cod', 'raw_salmon',
        'leather_boots', 'leather', 'bone', 'string',
        'bowl', 'stick', 'ink_sac',
    ],
};

// ===== Создание бота =====
const bot = mineflayer.createBot({
    host: CONFIG.host,
    port: CONFIG.port,
    username: CONFIG.username,
    version: CONFIG.version,
    auth: CONFIG.auth,
    hideErrors: false,
});

bot.loadPlugin(pathfinder);

// ===== Состояние =====
const state = {
    fishing: false,
    waterBlock: null,
    lastCatchAt: 0,
    totalCaught: 0,
    catchesSinceDeposit: 0,
    startedAt: Date.now(),
    busy: false,
};

let running = true;

// ===== События бота =====
bot.once('spawn', () => {
    console.log('✅ Бот подключён к серверу');
    console.log(`📦 Версия: ${bot.version}`);
    console.log(`👤 Ник: ${bot.username}`);
    setupMovements();
    setTimeout(mainLoop, 2000);
});

bot.on('error', err => console.log('❌ Ошибка:', err.message));
bot.on('kicked', reason => console.log('👢 Кикнут:', reason));

bot.on('end', () => {
    console.log('🔌 Отключён. Переподключение через 10 сек...');
    running = false;
    setTimeout(() => process.exit(1), 10000);
});

process.on('SIGINT', () => {
    console.log('\n👋 Останавливаю бота...');
    running = false;
    try { bot.end(); } catch { /* ignore */ }
    setTimeout(() => process.exit(0), 1000);
});

// ===== Настройка движений =====
function setupMovements() {
    const moves = new Movements(bot);
    moves.canDig = false;
    moves.allow1by1towers = false;
    moves.allowParkour = true;
    moves.allowSprinting = true;
    moves.maxDropDown = 2;
    moves.liquidCost = 500;
    moves.aquaticAvoidance = true;
    bot.pathfinder.setMovements(moves);
}

// ===== Основной цикл =====
async function mainLoop() {
    while (running) {
        try {
            await tick();
        } catch (err) {
            console.log('⚠️ Ошибка в цикле:', err.message);
            await sleep(2000);
        }
    }
    console.log('🛑 mainLoop остановлен');
}

// Один шаг цикла
async function tick() {
    if (state.busy) {
        await sleep(500);
        return;
    }

    // 1. Удочка в руке
    if (!(await ensureRodInHand())) {
        const gotRod = await fetchRodFromChest();
        if (!gotRod) {
            console.log('❌ Не нашёл удочку. Жду 5 сек...');
            await sleep(5000);
        }
        return;
    }

    // 2. Пора ли сложить улов
    if (shouldDeposit()) {
        await depositLoot();
        state.catchesSinceDeposit = 0;
        return;
    }

    // 3. Ищем воду
    const water = findWaterSmart();
    if (!water) {
        console.log('💧 Вода не найдена. Жду 3 сек...');
        await sleep(3000);
        return;
    }

    // 4. Подход к воде
    if (!(await approachWater(water))) {
        state.waterBlock = null;
        await sleep(1000);
        return;
    }

    // 5. Рыбалка
    await faceWater(water);
    await sleep(300);
    await fishOnce();
    await sleep(CONFIG.catchCooldown);
}

function shouldDeposit() {
    return state.catchesSinceDeposit >= CONFIG.depositAfterCatches ||
           bot.inventory.emptySlotCount() <= 2;
}

async function approachWater(water) {
    const dist = bot.entity.position.distanceTo(water.position);
    if (dist <= 4) return true;

    console.log(`🚶 Иду к воде (${dist.toFixed(1)} блоков)...`);
    const reached = await goToWater(water);
    if (!reached) {
        console.log('⚠️ Не смог дойти, ищу другую воду...');
    }
    return reached;
}

// ===== Общая функция ожидания цели =====
function waitForGoal(goal, timeout = 20000) {
    return new Promise((resolve) => {
        bot.pathfinder.setGoal(goal);

        const timer = setTimeout(() => {
            bot.pathfinder.setGoal(null);
            bot.removeListener('goal_reached', onReach);
            resolve(false);
        }, timeout);

        function onReach() {
            clearTimeout(timer);
            bot.removeListener('goal_reached', onReach);
            bot.pathfinder.setGoal(null);
            resolve(true);
        }

        bot.once('goal_reached', onReach);
    });
}

async function goToBlock(block) {
    const { x, y, z } = block.position;
    return waitForGoal(new goals.GoalNear(x, y, z, 2), 20000);
}

async function goToWater(waterBlock) {
    const standPos = findSafeStandPosition(waterBlock);

    if (standPos) {
        console.log(`🎯 Иду на берег: ${standPos.x}, ${standPos.y}, ${standPos.z}`);
        return waitForGoal(
            new goals.GoalBlock(standPos.x, standPos.y, standPos.z),
            15000
        );
    }

    const { x, y, z } = waterBlock.position;
    return waitForGoal(
        new goals.GoalNear(x, y, z, CONFIG.standDistance),
        15000
    );
}

// ===== Удочка =====
function hasRodInHand() {
    return bot.heldItem?.name.includes('fishing_rod') ?? false;
}

function findBestRodInInventory() {
    return bot.inventory.items()
        .filter(i => i.name.includes('fishing_rod'))
        .sort((a, b) => getDurability(b) - getDurability(a))[0] || null;
}

function getDurability(item) {
    if (!item) return 0;
    const max = item.maxDurability || 64;
    const used = item.durabilityUsed || 0;
    return Math.max(0, (max - used) / max);
}

async function ensureRodInHand() {
    if (hasRodInHand()) {
        const dur = getDurability(bot.heldItem);
        if (dur < CONFIG.rodDurabilityThreshold) {
            console.log(`🔧 Удочка изношена (${(dur * 100).toFixed(1)}%), меняю...`);
            return false;
        }
        return true;
    }

    const rod = findBestRodInInventory();
    if (!rod) {
        console.log('❌ Удочки нет в инвентаре!');
        return false;
    }

    try {
        await bot.equip(rod, 'hand');
        console.log(`🎣 Взял удочку (прочность ${(getDurability(rod) * 100).toFixed(1)}%)`);
        return true;
    } catch (err) {
        console.log('⚠️ Не смог взять удочку:', err.message);
        return false;
    }
}

// ===== Поиск ВСЕХ сундуков рядом =====
function findAllChests() {
    const chests = [];
    const radius = CONFIG.chestSearchRadius;
    const origin = bot.entity.position.floored();

    // Сканируем "коробку" вокруг бота
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -8; dy <= 8; dy++) {
            for (let dz = -radius; dz <= radius; dz++) {
                const pos = origin.offset(dx, dy, dz);
                const block = bot.blockAt(pos);
                if (!block) continue;
                if (block.name === 'chest' || block.name === 'trapped_chest') {
                    chests.push(block);
                }
            }
        }
    }

    // Сортируем по расстоянию — ближайшие первыми
    chests.sort((a, b) =>
        bot.entity.position.distanceTo(a.position) -
        bot.entity.position.distanceTo(b.position)
    );

    return chests;
}

// ===== Открыть сундук и посмотреть содержимое =====
async function peekChest(chestBlock) {
    try {
        const chest = await bot.openContainer(chestBlock);
        const items = chest.containerItems();
        return { chest, items };
    } catch (err) {
        console.log(`⚠️ Не смог открыть сундук:`, err.message);
        return null;
    }
}

// ===== Найти сундук-склад (без удочек) =====
async function findStorageChest() {
    const chests = findAllChests();
    if (chests.length === 0) {
        console.log('❌ Сундуки не найдены');
        return null;
    }

    for (const chestBlock of chests) {
        const peek = await peekChest(chestBlock);
        if (!peek) continue;

        const { chest, items } = peek;
        const hasRods = items.some(i => i.name.includes('fishing_rod'));

        chest.close();
        await sleep(200);

        if (!hasRods) {
            console.log(`📦 Нашёл сундук-склад (без удочек), предметов: ${items.length}`);
            return chestBlock;
        }
        console.log(`🎣 Пропускаю сундук с удочками`);
    }

    console.log('❌ Не нашёл подходящий сундук-склад');
    return null;
}

// ===== Найти сундук-снабженец (с удочками) =====
async function findRodChest() {
    const chests = findAllChests();
    if (chests.length === 0) {
        console.log('❌ Сундуки не найдены');
        return null;
    }

    for (const chestBlock of chests) {
        const peek = await peekChest(chestBlock);
        if (!peek) continue;

        const { chest, items } = peek;
        const rods = items.filter(i => i.name.includes('fishing_rod'));

        chest.close();
        await sleep(200);

        if (rods.length > 0) {
            console.log(`🎣 Нашёл сундук с удочками (${rods.length} шт.)`);
            return chestBlock;
        }
    }

    console.log('❌ Не нашёл сундук с удочками');
    return null;
}

function isStorable(item) {
    return CONFIG.itemsToStore.some(name => item.name.includes(name));
}

// ===== Складирование улова =====
async function depositLoot() {
    if (state.busy) return;
    state.busy = true;

    try {
        const itemsToStore = bot.inventory.items().filter(isStorable);

        if (itemsToStore.length === 0) {
            console.log('📦 Нечего складывать');
            return;
        }

        const chestBlock = await findStorageChest();
        if (!chestBlock) {
            console.log('❌ Сундук-склад не найден');
            return;
        }

        console.log(`📦 Иду к сундуку-складу: ${chestBlock.position.x}, ${chestBlock.position.y}, ${chestBlock.position.z}`);

        if (!(await goToBlock(chestBlock))) {
            console.log('⚠️ Не смог дойти до сундука');
            return;
        }

        const chest = await bot.openContainer(chestBlock);
        console.log('📂 Сундук открыт');

        let stored = 0;
        for (const item of itemsToStore) {
            try {
                await chest.deposit(item.type, null, item.count);
                stored += item.count;
            } catch (err) {
                console.log(`⚠️ Не смог положить ${item.name}:`, err.message);
            }
        }

        console.log(`📦 Сложил ${stored} предметов в сундук-склад`);
        chest.close();
        await sleep(300);

    } catch (err) {
        console.log('⚠️ Ошибка при складывании:', err.message);
    } finally {
        state.busy = false;
    }
}

// ===== Взять удочку из сундука-снабженца =====
async function fetchRodFromChest() {
    if (state.busy) return false;
    state.busy = true;

    try {
        const chestBlock = await findRodChest();
        if (!chestBlock) {
            console.log('❌ Сундук с удочками не найден');
            return false;
        }

        console.log('🔍 Иду к сундуку за удочкой...');
        if (!(await goToBlock(chestBlock))) return false;

        const chest = await bot.openContainer(chestBlock);
        console.log('📂 Сундук открыт, ищу удочку...');

        const rods = chest.containerItems()
            .filter(i => i.name.includes('fishing_rod'))
            .sort((a, b) => getDurability(b) - getDurability(a));

        if (rods.length === 0) {
            console.log('❌ В сундуке нет удочек');
            chest.close();
            return false;
        }

        const bestRod = rods[0];
        console.log(`🎣 Нашёл удочку (прочность ${(getDurability(bestRod) * 100).toFixed(1)}%)`);

        await chest.withdraw(bestRod.type, null, 1);
        console.log('✅ Удочка забрана из сундука');

        chest.close();
        await sleep(500);
        return await ensureRodInHand();

    } catch (err) {
        console.log('⚠️ Ошибка при взятии удочки:', err.message);
        return false;
    } finally {
        state.busy = false;
    }
}

// ===== Поиск воды =====
function findWaterSmart() {
    const cached = getCachedWater();
    if (cached) return cached;
    return spiralSearchWater();
}

function getCachedWater() {
    if (!state.waterBlock) return null;

    const b = bot.blockAt(state.waterBlock.position);
    if (!b || !isWater(b)) {
        state.waterBlock = null;
        return null;
    }

    const d = bot.entity.position.distanceTo(b.position);
    if (d >= 20) {
        state.waterBlock = null;
        return null;
    }
    return b;
}

function spiralSearchWater() {
    const origin = bot.entity.position.floored();
    for (let radius = 0; radius <= CONFIG.searchRadius; radius++) {
        const found = searchRing(origin, radius);
        if (found) {
            state.waterBlock = found;
            return found;
        }
    }
    return null;
}

function searchRing(origin, radius) {
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;
            const block = findWaterInColumn(origin, dx, dz);
            if (block) return block;
        }
    }
    return null;
}

function findWaterInColumn(origin, dx, dz) {
    for (let dy = -2; dy <= 1; dy++) {
        const pos = origin.offset(dx, dy, dz);
        const block = bot.blockAt(pos);
        if (isWaterSurface(block, pos)) return block;
    }
    return null;
}

function isWaterSurface(block, pos) {
    if (!block || !isWater(block)) return false;
    return bot.blockAt(pos.offset(0, 1, 0))?.name === 'air';
}

function isWater(block) {
    return block.name === 'water' || block.name === 'flowing_water';
}

// ===== Безопасная позиция на берегу =====
function findSafeStandPosition(waterBlock) {
    const around = [
        { dx:  1, dz:  0 }, { dx: -1, dz:  0 },
        { dx:  0, dz:  1 }, { dx:  0, dz: -1 },
        { dx:  1, dz:  1 }, { dx:  1, dz: -1 },
        { dx: -1, dz:  1 }, { dx: -1, dz: -1 },
    ];

    for (const { dx, dz } of around) {
        const pos = waterBlock.position.offset(dx, 0, dz);
        const below = bot.blockAt(pos.offset(0, -1, 0));
        const at = bot.blockAt(pos);
        const above = bot.blockAt(pos.offset(0, 1, 0));

        if (!below || below.name === 'air') continue;
        if (isWater(below) || isWater(at) || isWater(above)) continue;
        if (at?.name !== 'air' || above?.name !== 'air') continue;

        return pos;
    }
    return null;
}

// ===== Поворот к воде =====
async function faceWater(waterBlock) {
    const target = waterBlock.position.offset(0.5, 1.2, 0.5);
    await bot.lookAt(target, true);
}

// ===== Рыбалка =====
async function fishOnce() {
    if (state.fishing) return;
    if (!hasRodInHand()) return;

    state.fishing = true;
    console.log('🎣 Забрасываю...');

    try {
        const fish = await bot.fish();
        state.totalCaught++;
        state.catchesSinceDeposit++;
        state.lastCatchAt = Date.now();
        console.log(
            `🐟 Поймал: ${fish?.name || 'что-то'}! ` +
            `Всего: ${state.totalCaught} | ` +
            `до сундука: ${CONFIG.depositAfterCatches - state.catchesSinceDeposit}`
        );
    } catch (err) {
        console.log('⚠️ Ошибка рыбалки:', err.message || err);
    } finally {
        state.fishing = false;
    }
}

// ===== Утилиты =====
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ===== Статус =====
setInterval(() => {
    const uptime = Math.floor((Date.now() - state.startedAt) / 1000);
    console.log(
        `📊 Поймано: ${state.totalCaught} | ` +
        `аптайм: ${uptime}с | ` +
        `свободно слотов: ${bot.inventory.emptySlotCount()} | ` +
        `рыбалка: ${state.fishing ? 'да' : 'нет'}`
    );
}, CONFIG.statusInterval);