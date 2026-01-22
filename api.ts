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
    while (true) {
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
};


/**
 * Standard 3x9 Housie Ticket Generator (Improved Layout)
 * - 3 rows, 9 columns.
 * - Each row has exactly 5 numbers.
 * - Each column has at least 1 number, and no more than 2.
 * - Horizontally, no more than 2 consecutive numbers or blanks.
 */
const generateTicket = (): TicketGrid => {
    let layout: boolean[][];
    
    // This loop continues until a valid ticket layout is generated.
    while (true) {
        // Generate 3 rows, each with a valid horizontal pattern.
        layout = [
            generateValidRowPattern(),
            generateValidRowPattern(),
            generateValidRowPattern()
        ];

        // Validate the column constraints for the generated 3x9 layout.
        let isLayoutValid = true;
        for (let c = 0; c < 9; c++) {
            const colSum = (layout[0][c] ? 1 : 0) + (layout[1][c] ? 1 : 0) + (layout[2][c] ? 1 : 0);
            
            // Each column must have 1 or 2 numbers. Not 0 or 3.
            if (colSum === 0 || colSum === 3) {
                isLayoutValid = false;
                break;
            }
        }

        // If all columns are valid, we have a good layout.
        if (isLayoutValid) {
            break; 
        }
    }

    // Now, populate the valid layout with numbers.
    const grid: TicketGrid = Array.from({ length: 3 }, () => Array(9).fill(null));

    // Prepare shuffled number pools for each column.
    const colNumbers = Array.from({ length: 9 }, (_, i) => {
        const min = i * 10 + 1;
        const max = i === 8 ? 90 : (i + 1) * 10;
        const nums = Array.from({ length: max - min + 1 }, (_, k) => min + k);
        // Fisher-Yates shuffle
        for (let j = nums.length - 1; j > 0; j--) {
            const k = Math.floor(Math.random() * (j + 1));
            [nums[j], nums[k]] = [nums[k], nums[j]];
        }
        return nums;
    });

    // Place numbers from the pools into the grid based on the generated layout.
    for (let c = 0; c < 9; c++) {
        for (let r = 0; r < 3; r++) {
            if (layout[r][c]) {
                grid[r][c] = colNumbers[c].pop()!;
            }
        }
    }

    // Finally, sort the numbers within each column vertically.
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
    mockListeners.forEach(cb => cb(stateToSend));
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
          const rowNums = t.grid[rowIdx].filter(n => n !== null) as number[];
          return rowNums.every(n => called.has(n));
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

    // Check Game Over (Full House limits met)
    const fhLimit = prizeConfig['fullHouse']?.count || 1;
    const isGameOver = newWinners['fullHouse'].length >=fhLimit;

    return { winners: newWinners, isGameOver };
};

/**
 * Creates and returns a complete, fresh initial state for a new Housie game.
 */
const getInitialGameState = (): GameState => {
    // 1. Generate a fresh, shuffled queue of numbers (1-90).
    const nums = Array.from({ length: TOTAL_NUMBERS }, (_, i) => i + 1);
    for (let i = nums.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [nums[i], nums[j]] = [nums[j], nums[i]];
    }

    // 2. Generate 100 new, unbooked tickets.
    const tickets: Ticket[] = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        grid: generateTicket(),
        owner: null
    }));

    // 3. Create the default configuration for prizes.
    const defaultPrizesConfig: Record<string, PrizeConfig> = {};
    WINNING_PATTERNS.forEach(p => {
        defaultPrizesConfig[p.key] = { label: p.label, count: 1 };
    });
    
    // 4. Assemble and return the complete initial game state object.
    return {
        calledNumbers: [],
        currentNumber: null,
        previousNumber: null,
        shuffledQueue: nums,
        extraTickets: tickets,
        winners: {}, // Winners list is cleared
        prizesConfig: defaultPrizesConfig,
        isGameOver: false,
        activeTicketLimit: 100,
        isAutoPlaying: false,
        lastCallTimestamp: Date.now(),
        scheduledStartTime: null
    };
};


export const api = {
    subscribe: (callback: (state: GameState | null) => void) => {
        if (USE_MOCK) {
            if (!mockState) {
                // Create the initial state using the new helper function
                mockState = getInitialGameState();
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
                    val.winners = sanitizeWinners(val.winners);
                    val.prizesConfig = sanitizePrizeConfig(val.prizesConfig);
                    callback(val);
                } else {
                    callback(null);
                }
            });
            return unsub;
        }
    },

    callNumber: async () => {
        if (USE_MOCK) {
            if (!mockState || mockState.isGameOver || mockState.shuffledQueue.length === 0) return;
            
            const nextNum = mockState.shuffledQueue.shift()!;
            const prev = mockState.currentNumber;
            mockState.previousNumber = prev;
            mockState.currentNumber = nextNum;
            mockState.calledNumbers.push(nextNum);
            
            // Check Winners
            const { winners, isGameOver } = checkAllWinners(
                mockState.extraTickets, 
                mockState.calledNumbers, 
                mockState.activeTicketLimit,
                mockState.winners,
                sanitizePrizeConfig(mockState.prizesConfig)
            );
            
            mockState.winners = winners;
            mockState.isGameOver = isGameOver;

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
                 
                 const { winners, isGameOver } = checkAllWinners(
                     currentData.extraTickets || [],
                     called,
                     currentData.activeTicketLimit,
                     currentData.winners || {},
                     sanitizePrizeConfig(currentData.prizesConfig)
                 );

                 return {
                     ...currentData,
                     shuffledQueue: queue,
                     currentNumber: nextNum,
                     previousNumber: prev,
                     calledNumbers: called,
                     winners: winners,
                     isGameOver: isGameOver,
                     lastCallTimestamp: Date.now()
                 };
             });
        }
    },

    resetGame: async () => {
        // Generate a completely fresh initial state for the game.
        const freshState = getInitialGameState();
    
        // Overwrite the entire game state in the database or mock state.
        if (USE_MOCK) {
            // In local mock mode, directly replace the state object and notify listeners.
            mockState = freshState;
            notifyMockListeners();
        } else {
            // In Firebase mode, completely overwrite the gameState node.
            if (!db) return;
            await set(ref(db, 'housie/gameState'), freshState);
        }
    },

    updateSettings: async (settings: Partial<GameState>) => {
        if (USE_MOCK) {
            if (mockState) {
                Object.assign(mockState, settings);
                notifyMockListeners();
            }
        } else {
            if (!db) return;
            await update(ref(db, 'housie/gameState'), settings);
        }
    }
};