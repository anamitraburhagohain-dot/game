import { db, isFirebaseConfigured } from './firebaseConfig';
import { ref, get, set, update, runTransaction, onValue } from "firebase/database";
import { TOTAL_NUMBERS, WINNING_PATTERNS } from './constants';

// --- CONFIG ---
const USE_MOCK = !isFirebaseConfigured; 

// --- Types ---
export type TicketCell = number | null;
export type TicketGrid = TicketCell[][];

export interface Ticket {
    id: number;
    grid: TicketGrid;
    owner: string | null;
}

export type Winners = Record<string, Ticket[]>;

export interface PrizeConfig {
    label: string;
    count: number;
}

export interface PriorityConfig {
    ticketId: number;
    category: string; 
}

export interface GameState {
    calledNumbers: number[];
    currentNumber: number | null;
    previousNumber: number | null;
    shuffledQueue: number[];
    extraTickets: Ticket[];
    winners: Winners;
    prizesConfig: Record<string, PrizeConfig>;
    priorityConfigs?: PriorityConfig[];
    isGameOver: boolean;
    activeTicketLimit: number;
    isAutoPlaying: boolean;
    lastCallTimestamp: number;
    scheduledStartTime: string | null;
}

// Helper function to generate a single valid row pattern
const generateValidRowPattern = (): boolean[] => {
    // A row has 5 numbers (true) and 4 blanks (false)
    const pattern = [true, true, true, true, true, false, false, false, false];
    
    // Keep shuffling until a valid pattern is found
    // Loop max 100 times to prevent infinite loops in rare cases
    for (let attempts = 0; attempts < 100; attempts++) {
        // Fisher-Yates shuffle
        for (let i = pattern.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pattern[i], pattern[j]] = [pattern[j], pattern[i]];
        }

        // Check for three consecutive identical values
        let hasTriple = false;
        for (let i = 0; i <= pattern.length - 3; i++) {
            if (pattern[i] === pattern[i+1] && pattern[i+1] === pattern[i+2]) {
                hasTriple = true;
                break;
            }
        }

        if (!hasTriple) {
            return pattern;
        }
    }
    // Fallback if loop exceeded (very unlikely) - return a simple valid pattern
    return [true, false, true, false, true, false, true, false, true];
};


/**
 * Standard 3x9 Housie Ticket Generator (Improved Layout)
 */
const generateTicket = (): TicketGrid => {
    let layout: boolean[][];
    
    // Safety break after 50 attempts to prevent hanging
    for(let attempts = 0; attempts < 50; attempts++) {
        layout = [
            generateValidRowPattern(),
            generateValidRowPattern(),
            generateValidRowPattern()
        ];

        let isLayoutValid = true;
        // Validate column constraints
        for (let c = 0; c < 9; c++) {
            const colSum = (layout[0][c] ? 1 : 0) + (layout[1][c] ? 1 : 0) + (layout[2][c] ? 1 : 0);
            if (colSum === 0 || colSum === 3) {
                isLayoutValid = false;
                break;
            }
        }
        if (!isLayoutValid) continue;

        // NEW SPREAD VALIDATION: Prevent 2x2 blocks of empty cells
        let hasEmptyPatch = false;
        for (let r = 0; r <= 1; r++) { 
            for (let c = 0; c <= 7; c++) { 
                if (!layout[r][c] && !layout[r][c + 1] && !layout[r + 1][c] && !layout[r + 1][c + 1]) {
                    hasEmptyPatch = true;
                    break;
                }
            }
            if (hasEmptyPatch) break;
        }
        
        if (hasEmptyPatch) {
            isLayoutValid = false;
        }

        if (isLayoutValid) {
            // Found a valid layout, populate numbers
            const grid: TicketGrid = Array.from({ length: 3 }, () => Array(9).fill(null));
            const colNumbers = Array.from({ length: 9 }, (_, i) => {
                const min = i * 10 + 1;
                const max = i === 8 ? 90 : (i + 1) * 10;
                const nums = Array.from({ length: max - min + 1 }, (_, k) => min + k);
                for (let j = nums.length - 1; j > 0; j--) {
                    const k = Math.floor(Math.random() * (j + 1));
                    [nums[j], nums[k]] = [nums[k], nums[j]];
                }
                return nums;
            });

            for (let c = 0; c < 9; c++) {
                for (let r = 0; r < 3; r++) {
                    if (layout[r][c]) {
                        grid[r][c] = colNumbers[c].pop()!;
                    }
                }
            }

            for (let c = 0; c < 9; c++) {
                const valsInCol = [grid[0][c], grid[1][c], grid[2][c]].filter(v => v !== null) as number[];
                valsInCol.sort((a, b) => a - b);
                let vIdx = 0;
                for (let r = 0; r < 3; r++) {
                    if (grid[r][c] !== null) {
                        grid[r][c] = valsInCol[vIdx++];
                    }
                }
            }
            return grid;
        }
    }
    
    // Fallback grid if generation fails after attempts (prevents infinite loop white screen)
    return [
        [1, null, 20, null, 42, null, 61, null, 85],
        [null, 15, null, 33, null, 55, null, 77, null],
        [8, null, 25, null, 48, null, 66, null, 90]
    ];
};

const sanitizeWinners = (w: any): Winners => {
    const safeWinners: Winners = {};
    WINNING_PATTERNS.forEach(pattern => {
        const val = w ? w[pattern.key] : undefined;
        if (!val) {
            safeWinners[pattern.key] = [];
        } else if (Array.isArray(val)) {
            safeWinners[pattern.key] = val;
        } else if (typeof val === 'object') {
            safeWinners[pattern.key] = Object.values(val);
        } else {
            safeWinners[pattern.key] = [];
        }
    });
    return safeWinners;
};

const sanitizePrizeConfig = (p: any): Record<string, PrizeConfig> => {
    const config: Record<string, PrizeConfig> = {};
    WINNING_PATTERNS.forEach(pattern => {
        if (p && p[pattern.key]) {
            config[pattern.key] = p[pattern.key];
        } else {
            config[pattern.key] = { label: pattern.label, count: 1 };
        }
    });
    return config;
};

let mockState: GameState | null = null;
const mockListeners: ((state: GameState | null) => void)[] = [];

const notifyMockListeners = () => {
    const stateToSend = mockState ? JSON.parse(JSON.stringify(mockState)) : null;
    if (stateToSend) {
        stateToSend.winners = sanitizeWinners(stateToSend.winners);
        stateToSend.prizesConfig = sanitizePrizeConfig(stateToSend.prizesConfig);
    }
    // Make notification asynchronous to avoid state updates during render cycles.
    setTimeout(() => {
        mockListeners.forEach(cb => cb(stateToSend));
    }, 0);
};

const checkAllWinners = (
    tickets: Ticket[], 
    calledNumbersArr: number[], 
    limit: number, 
    previousWinners: Winners, 
    prizeConfig: Record<string, PrizeConfig>
): { winners: Winners, isGameOver: boolean } => {
    const called = new Set(calledNumbersArr);
    const effectiveLimit = (!limit || limit < 1) ? tickets.length : limit;
    const activeTickets = (tickets || []).slice(0, effectiveLimit);
    const safePrevWinners = sanitizeWinners(previousWinners);
    let newWinners: Winners = {};

    WINNING_PATTERNS.forEach(p => newWinners[p.key] = [...safePrevWinners[p.key]]);

    const currentStatus: Record<string, Ticket[]> = {};
    WINNING_PATTERNS.forEach(p => currentStatus[p.key] = []);

    activeTickets.forEach(t => {
        if (!t.grid) return;
        const flat = t.grid.flat().filter(n => n !== null) as number[];
        const markedCount = flat.filter(n => called.has(n)).length;

        // Early Seven
        if (markedCount >= 7) currentStatus['earlySeven'].push(t);
        
        // Full House
        if (markedCount === 15) currentStatus['fullHouse'].push(t);
        
        // Row Lines
        const checkRow = (rowIdx: number) => {
          if (!t.grid[rowIdx]) return false;
          const rowNums = t.grid[rowIdx].filter(n => n !== null) as number[];
          return rowNums.length > 0 && rowNums.every(n => called.has(n));
        };
        if (checkRow(0)) currentStatus['topLine'].push(t);
        if (checkRow(1)) currentStatus['middleLine'].push(t);
        if (checkRow(2)) currentStatus['bottomLine'].push(t);
    });

    WINNING_PATTERNS.forEach(p => {
        const key = p.key;
        const limit = prizeConfig[key]?.count || 0;
        if (limit === 0) return; // Skip checking for disabled prizes

        const existing = newWinners[key];
        
        if (existing.length < limit) {
             const candidates = currentStatus[key];
             candidates.forEach(cand => {
                 if (!existing.some(w => w.id === cand.id)) {
                     if (existing.length < limit) {
                         existing.push(cand);
                     }
                 }
             });
             newWinners[key] = existing;
        }
    });

    // Check Game Over (Full House limits met) - this is just one condition for game over
    const fhLimit = prizeConfig['fullHouse']?.count ?? 1;
    const isFullHouseOver = newWinners['fullHouse'].length >=fhLimit;

    return { winners: newWinners, isGameOver: isFullHouseOver };
};


export const api = {
    subscribe: (callback: (state: GameState | null) => void) => {
        if (USE_MOCK) {
            if (!mockState) {
                // Initial Mock State
                const nums = Array.from({ length: 90 }, (_, i) => i + 1);
                // Shuffle for queue
                for (let i = nums.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [nums[i], nums[j]] = [nums[j], nums[i]];
                }
                
                // Generate 100 tickets
                const tickets: Ticket[] = Array.from({ length: 100 }, (_, i) => ({
                    id: i + 1,
                    grid: generateTicket(),
                    owner: null
                }));

                mockState = {
                    calledNumbers: [],
                    currentNumber: null,
                    previousNumber: null,
                    shuffledQueue: nums,
                    extraTickets: tickets,
                    winners: {}, // Will be populated by sanitizeWinners
                    prizesConfig: {}, // Will be populated by sanitizePrizeConfig
                    isGameOver: false,
                    activeTicketLimit: 100,
                    isAutoPlaying: false,
                    lastCallTimestamp: Date.now(),
                    scheduledStartTime: null
                };
            }
            mockListeners.push(callback);
            notifyMockListeners();
            return () => {
                const idx = mockListeners.indexOf(callback);
                if (idx !== -1) mockListeners.splice(idx, 1);
            };
        } else {
            // Firebase Logic
            if (!db) return () => {};
            const gameRef = ref(db, 'housie/gameState');
            const unsub = onValue(gameRef, (snapshot) => {
                const val = snapshot.val();
                if (val) {
                    // Defensively ensure essential arrays and objects exist to prevent render crashes from partial data
                    if (!val.calledNumbers) val.calledNumbers = [];
                    if (!val.extraTickets) val.extraTickets = [];
                    if (!val.shuffledQueue) val.shuffledQueue = [];
                    if (!val.winners) val.winners = {};
                    if (!val.prizesConfig) val.prizesConfig = {};

                    val.winners = sanitizeWinners(val.winners);
                    val.prizesConfig = sanitizePrizeConfig(val.prizesConfig);
                    callback(val);
                } else {
                    // If no game state exists in Firebase, create one.
                    console.log("No Housie game state found. Initializing a new game...");
                    api.resetGame().catch(error => {
                        console.error("Failed to initialize game state:", error);
                    });
                }
            });
            return unsub;
        }
    },

    callNumber: async () => {
        if (USE_MOCK) {
            if (!mockState || mockState.isGameOver || mockState.shuffledQueue.length === 0) return;
            
            const newQueue = [...mockState.shuffledQueue];
            const nextNum = newQueue.shift()!;
            const prev = mockState.currentNumber;
            const newCalledNumbers = [...mockState.calledNumbers, nextNum];

            const sanitizedPrizes = sanitizePrizeConfig(mockState.prizesConfig);
            const { winners, isGameOver: isFullHouseOver } = checkAllWinners(
                mockState.extraTickets, 
                newCalledNumbers, 
                mockState.activeTicketLimit,
                mockState.winners,
                sanitizedPrizes
            );
            
            let allPrizesClaimed = true;
            for (const p of WINNING_PATTERNS) {
                const key = p.key;
                const prizeConfig = sanitizedPrizes[key];
                if (prizeConfig && prizeConfig.count > 0) { // Only check enabled prizes
                    const winnersForKey = winners[key] || [];
                    if (winnersForKey.length < prizeConfig.count) {
                        allPrizesClaimed = false;
                        break;
                    }
                }
            }
            const finalIsGameOver = isFullHouseOver || newQueue.length === 0 || allPrizesClaimed;

            // Create a new state object instead of mutating the old one
            mockState = {
                ...mockState,
                shuffledQueue: newQueue,
                currentNumber: nextNum,
                previousNumber: prev,
                calledNumbers: newCalledNumbers,
                winners: winners,
                isGameOver: finalIsGameOver,
                lastCallTimestamp: Date.now()
            };

            notifyMockListeners();
        } else {
             // Firebase Transaction
             if (!db) return;
             const gameRef = ref(db, 'housie/gameState');
             await runTransaction(gameRef, (currentData) => {
                 if (!currentData || currentData.isGameOver || !currentData.shuffledQueue || currentData.shuffledQueue.length === 0) {
                     return currentData;
                 }
                 
                 const queue = [...currentData.shuffledQueue];
                 const nextNum = queue.shift();
                 const called = [...(currentData.calledNumbers || []), nextNum];
                 const prev = currentData.currentNumber || null;

                 const sanitizedPrizes = sanitizePrizeConfig(currentData.prizesConfig);
                 const { winners, isGameOver: isFullHouseOver } = checkAllWinners(
                     currentData.extraTickets || [],
                     called,
                     currentData.activeTicketLimit,
                     currentData.winners || {},
                     sanitizedPrizes
                 );
                 
                 let allPrizesClaimed = true;
                 for (const p of WINNING_PATTERNS) {
                     const key = p.key;
                     const prizeConfig = sanitizedPrizes[key];
                     if (prizeConfig && prizeConfig.count > 0) {
                         const winnersForKey = winners[key] || [];
                         if (winnersForKey.length < prizeConfig.count) {
                             allPrizesClaimed = false;
                             break;
                         }
                     }
                 }
                 const finalIsGameOver = isFullHouseOver || queue.length === 0 || allPrizesClaimed;

                 return {
                     ...currentData,
                     shuffledQueue: queue,
                     currentNumber: nextNum,
                     previousNumber: prev,
                     calledNumbers: called,
                     winners: winners,
                     isGameOver: finalIsGameOver,
                     lastCallTimestamp: Date.now()
                 };
             });
        }
    },

    resetGame: async () => {
        // 1. Generate a fresh, shuffled queue of numbers for the new game.
        const nums = Array.from({ length: 90 }, (_, i) => i + 1);
        for (let i = nums.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [nums[i], nums[j]] = [nums[j], nums[i]];
        }
    
        // 2. Unbook all tickets by generating a fresh set.
        const tickets: Ticket[] = Array.from({ length: 100 }, (_, i) => ({
            id: i + 1,
            grid: generateTicket(),
            owner: null
        }));
    
        // 3. Reset all prize categories to their default winner counts (which is 1).
        const defaultPrizesConfig: Record<string, PrizeConfig> = {};
        WINNING_PATTERNS.forEach(p => {
            defaultPrizesConfig[p.key] = { label: p.label, count: 1 };
        });
    
        // 4. Assemble the complete fresh game state.
        const freshState: GameState = {
            calledNumbers: [],          // Clear all called numbers.
            currentNumber: null,
            previousNumber: null,
            shuffledQueue: nums,        // Use the new shuffled queue.
            extraTickets: tickets,      // Use the new, unbooked tickets.
            winners: {},                // Wipe the winners board clean.
            prizesConfig: defaultPrizesConfig, // Use the explicit default prize config.
            isGameOver: false,
            activeTicketLimit: 100,
            isAutoPlaying: false,
            lastCallTimestamp: Date.now(),
            scheduledStartTime: null
        };
    
        // 5. Overwrite the entire game state in the database or mock.
        if (USE_MOCK) {
            mockState = freshState;
            notifyMockListeners();
        } else {
            if (!db) return Promise.reject(new Error("Firebase is not initialized."));
            // For Firebase, completely overwrite the gameState with the fresh state.
            await set(ref(db, 'housie/gameState'), freshState);
        }
    },

    updateSettings: async (settings: Partial<GameState>) => {
        if (USE_MOCK) {
            if (mockState) {
                // Create a new state object with updated settings
                mockState = {
                    ...mockState,
                    ...settings
                };
                notifyMockListeners();
            }
        } else {
            if (!db) return Promise.reject(new Error("Firebase is not initialized."));
            await update(ref(db, 'housie/gameState'), settings);
        }
    }
};