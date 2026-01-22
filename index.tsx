import React, { Component, useState, useEffect, ReactNode, FC, useMemo, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import {TOTAL_NUMBERS, WINNING_PATTERNS, SUPPORT_PHONE, getNickname } from "./constants";
import { api, GameState, Ticket, TicketGrid, Winners, TicketCell, PrizeConfig } from "./api";
import { createPortal } from "react-dom";
import './index.css';

// --- Types ---
type GameCategory = 'housie' | 'teenpatti' | 'spades' | 'rummy';
const gameCategories: { key: GameCategory, label: string, color: string, icon: string }[] = [
    { key: 'housie', label: 'Housie', color: 'from-blue-600 to-indigo-600', icon: '🎱' },
    { key: 'teenpatti', label: 'Teen Patti', color: 'from-green-600 to-emerald-600', icon: '🃏' },
    { key: 'spades', label: 'Spades', color: 'from-gray-700 to-gray-900', icon: '♠️' },
    { key: 'rummy', label: 'Rummy', color: 'from-red-600 to-rose-600', icon: '🀄' },
];

interface Card {
    suit: string;
    rank: string;
    value: number;
    id: string;
}

interface Player {
    id: number;
    positionId: number; // 0: bottom, 1: top, 2: right, 3: left
    uniqueId: string;
    name: string;
    isBot: boolean;
    cards: Card[];
    chips: number;
    initialChips?: number;
    avatarSeed: string;
    isFolded?: boolean;
    isSeen?: boolean;
    status?: 'waiting' | 'joined' | 'playing';
}

type PlayerConfig = { name: string; chips: number | string };
type AllPlayerConfigs = Record<number, Record<string, PlayerConfig>>;


// --- Helpers ---
const generateUniqueId = () => `id_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
const generateShortUniqueId = () => Math.random().toString(36).substring(2, 10).toUpperCase();

// Generates an ID in the format of NN-AA-NN-AA
const generateGameId = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const nums = '0123456789';
    const randomChar = () => chars[Math.floor(Math.random() * chars.length)];
    const randomNum = () => nums[Math.floor(Math.random() * nums.length)];
    return `${randomNum()}${randomNum()}${randomChar()}${randomChar()}${randomNum()}${randomNum()}${randomChar()}${randomChar()}`;
};

const getRandomBotName = () => {
    const names = ['Viper', 'Maverick', 'Goose', 'Iceman', 'Rooster', 'Phoenix', 'Bob', 'Alice', 'Charlie', 'Delta', 'Rocky', 'Ace', 'King', 'Queen', 'Jack'];
    return names[Math.floor(Math.random() * names.length)];
};


const getSuitSymbol = (suit: string) => {
    switch(suit) {
        case 'H': case '♥': return '♥';
        case 'D': case '♦': return '♦';
        case 'C': case '♣': return '♣';
        case 'S': case '♠': return '♠';
        default: return suit;
    }
};

const getSuitColor = (suit: string) => {
    return ['H', 'D', '♥', '♦'].includes(suit) ? 'text-red-600' : 'text-slate-900';
}

// Fisher-Yates Shuffle Implementation
const generateDeckTP = (): Card[] => {
    const suits = ['♥', '♦', '♣', '♠'];
    const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const values: Record<string, number> = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
    
    let deck: Card[] = [];
    suits.forEach(suit => {
        ranks.forEach(rank => {
            deck.push({ suit, rank, value: values[rank], id: `${rank}${suit}-${Math.random()}` });
        });
    });

    // Industry Standard Fisher-Yates Shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
};

const evaluateHand = (cards: Card[]): { rank: number, name: string } => {
    if (!cards || cards.length !== 3) return { rank: 0, name: 'Invalid Hand' };
    
    const sorted = [...cards].sort((a, b) => b.value - a.value);
    const v = sorted.map(c => c.value);
    const isFlush = cards.every(c => c.suit === cards[0].suit);
    const isStraight = (v[0] === v[1] + 1 && v[1] === v[2] + 1) || (v[0] === 14 && v[1] === 3 && v[2] === 2); 
    
    if (v[0] === v[1] && v[1] === v[2]) return { rank: 600000 + v[0], name: 'Trio' };
    if (isFlush && isStraight) return { rank: 500000 + v[0], name: 'Straight Flush' };
    if (isStraight) return { rank: 400000 + v[0], name: 'Straight' };
    if (isFlush) return { rank: 300000 + v[0] * 100 + v[1] * 10 + v[2], name: 'Flush' };
    if (v[0] === v[1] || v[1] === v[2]) return { rank: 200000 + (v[0] === v[1] ? v[0] : v[1]) * 100 + v[2], name: 'Pair' };
    return { rank: 100000 + v[0] * 100 + v[1] * 10 + v[2], name: 'High Card' };
};

// --- Reusable UI Components ---

const ConfirmationModal: FC<{
    isOpen: boolean;
    message: string;
    confirmText?: string;
    onConfirm: () => void;
    onCancel: () => void;
}> = ({ isOpen, message, confirmText = 'Confirm', onConfirm, onCancel }) => {
    if (!isOpen) return null;

    return createPortal(
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-pop">
            <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-sm text-center">
                <h3 className="text-lg font-bold text-gray-800 mb-4">Are you sure?</h3>
                <p className="text-sm text-gray-600 mb-6">{message}</p>
                <div className="flex gap-4">
                    <button onClick={onCancel} className="flex-1 bg-gray-200 text-gray-700 font-bold py-2 px-4 rounded-lg hover:bg-gray-300 transition-colors active:scale-95">
                        Cancel
                    </button>
                    <button onClick={onConfirm} className="flex-1 bg-red-600 text-white font-bold py-2 px-4 rounded-lg hover:bg-red-700 transition-colors active:scale-95">
                        {confirmText}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
};

const OrientationGuard = ({ children }: { children?: ReactNode }) => {
    return <>{children}</>;
};

interface PlayingCardProps {
    card?: Card;
    faceUp?: boolean;
    size?: 'sm' | 'md' | 'lg' | 'xl' | 'giant';
    highlight?: boolean;
    className?: string;
}

const PlayingCard: FC<PlayingCardProps> = ({ 
    card, 
    faceUp = true, 
    size = 'md', 
    highlight = false,
    className = "" 
}) => {
    const dims = {
        sm: 'w-12 h-16 text-[10px] rounded-md',
        md: 'w-16 h-24 text-lg rounded-lg',
        lg: 'w-20 h-28 text-xl rounded-xl',
        xl: 'w-28 h-40 text-2xl rounded-2xl',
        giant: 'w-40 h-56 text-3xl rounded-2xl'
    }[size];

    const logoSize = {
        sm: 'text-lg',
        md: 'text-2xl', // Opponent cards
        lg: 'text-3xl',
        xl: 'text-4xl', // Main player cards
        giant: 'text-5xl'
    }[size];

    if (!faceUp) {
        return (
            <div className={`${dims} bg-[#2c3e50] border-2 border-[#5c6b7a] flex items-center justify-center relative overflow-hidden shadow-2xl ${className}`}>
                 <div className="absolute inset-0 opacity-20 bg-[repeating-linear-gradient(45deg,_transparent,_transparent_3px,_rgba(255,255,255,0.1)_3px,_rgba(255,255,255,0.1)_4px)]"></div>
                <div className="w-2/3 h-2/3 bg-black/20 rounded-full flex items-center justify-center border-2 border-white/10">
                    <div className={`text-white/20 font-serif font-black ${logoSize}`}>SG</div>
                </div>
            </div>
        );
    }

    if (!card) {
        return <div className={`${dims} bg-slate-800 rounded-lg animate-pulse ${className}`}></div>;
    }

    return (
        <div className={`${dims} bg-white border border-gray-200 shadow-2xl flex flex-col justify-between p-2 md:p-3 select-none relative transition-transform duration-200 ${highlight ? 'ring-4 ring-yellow-400 scale-105' : ''} ${className}`}>
            <div className="flex flex-col items-center leading-none absolute top-2 left-2">
                <span className={`font-black ${getSuitColor(card.suit)}`}>{card.rank}</span>
                <span className={`${getSuitColor(card.suit)} text-sm mt-1`}>{getSuitSymbol(card.suit)}</span>
            </div>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                 <div className={`scale-[2.5] opacity-10 ${getSuitColor(card.suit)}`}>{getSuitSymbol(card.suit)}</div>
            </div>
            <div className="flex flex-col items-center leading-none rotate-180 absolute bottom-2 right-2">
                <span className={`font-black ${getSuitColor(card.suit)}`}>{card.rank}</span>
                <span className={`${getSuitColor(card.suit)} text-sm mt-1`}>{getSuitSymbol(card.suit)}</span>
            </div>
        </div>
    );
};

// Help & Support Modal
const SettingsModal = ({ 
    isOpen, onClose, 
    // Housie Props
    housieGameState, onUpdateHousieSettings, onResetHousieGame, onCallNextHousieNumber,
    // Teen Patti Props
    tpGameIds, onRegenerateTPIds, tpPlayerConfigs, setTPPlayerConfigs, 
    tpBookedTables, setTPBookedTables, tpTableTimers, setTPTableTimers
}: { 
    isOpen: boolean, 
    onClose: () => void,
    housieGameState: GameState | null,
    onUpdateHousieSettings: (settings: Partial<GameState>) => void,
    onResetHousieGame: () => Promise<void>,
    onCallNextHousieNumber: () => void,
    tpGameIds: Record<number, string[]>,
    onRegenerateTPIds: (boot: number) => void,
    tpPlayerConfigs: AllPlayerConfigs,
    setTPPlayerConfigs: React.Dispatch<React.SetStateAction<AllPlayerConfigs>>,
    tpBookedTables: Record<number, boolean>,
    setTPBookedTables: React.Dispatch<React.SetStateAction<Record<number, boolean>>>,
    tpTableTimers: Record<number, number>,
    setTPTableTimers: React.Dispatch<React.SetStateAction<Record<number, number>>>
}) => {
    const [query, setQuery] = useState('');
    const [isAdmin, setIsAdmin] = useState(false);
    const [activeTab, setActiveTab] = useState<'housie' | 'teenpatti' | 'spades' | 'rummy'>('housie');
    const [isResetConfirmOpen, setIsResetConfirmOpen] = useState(false);

    // Housie local state
    const [localPrizes, setLocalPrizes] = useState<Record<string, PrizeConfig>>({});
    const [localTicketLimit, setLocalTicketLimit] = useState(100);
    const [bookName, setBookName] = useState('');
    const [bookTicketNumbers, setBookTicketNumbers] = useState('');
    const [unbookName, setUnbookName] = useState('');
    const [unbookTicketNumbers, setUnbookTicketNumbers] = useState('');
    
    // Teen Patti local state
    const [localTPPlayerConfigs, setLocalTPPlayerConfigs] = useState<AllPlayerConfigs>({});
    const [localTPBookedTables, setLocalTPBookedTables] = useState<Record<number, boolean>>({});
    const [localTPTableTimers, setLocalTPTableTimers] = useState<Record<number, number>>({});
    
    useEffect(() => {
        if (isOpen) {
            // housie
            if (housieGameState) {
                setLocalPrizes(JSON.parse(JSON.stringify(housieGameState.prizesConfig)));
                setLocalTicketLimit(housieGameState.activeTicketLimit);
            }
            // teen patti
            setLocalTPPlayerConfigs(JSON.parse(JSON.stringify(tpPlayerConfigs)));
            setLocalTPBookedTables(JSON.parse(JSON.stringify(tpBookedTables)));
            setLocalTPTableTimers(JSON.parse(JSON.stringify(tpTableTimers)));
        } else {
            // Reset local state on close
            setBookName('');
            setBookTicketNumbers('');
            setUnbookName('');
            setUnbookTicketNumbers('');
        }
    }, [isOpen, housieGameState, tpPlayerConfigs, tpBookedTables, tpTableTimers]);
    
    useEffect(() => {
        if (query === 'DiluMack54321') { setIsAdmin(true); }
    }, [query]);

    const handleSendSupport = () => {
        if (!query.trim()) return alert("Please enter your message.");
        const text = `Hi Support! I have a query:\n\n${query}`;
        window.open(`https://wa.me/${SUPPORT_PHONE}?text=${encodeURIComponent(text)}`, '_blank');
        onClose(); setQuery('');
    };
    
    const handleHousieSave = () => {
        if (!housieGameState) return;

        const newTickets = JSON.parse(JSON.stringify(housieGameState.extraTickets));
        
        const parseTicketIds = (ids: string) => ids.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id) && id > 0);

        // Booking logic
        const ticketIdsToBook = parseTicketIds(bookTicketNumbers);
        if (bookName.trim() && ticketIdsToBook.length > 0) {
            const booked = [];
            const alreadyOwned = [];
            for(const ticketId of ticketIdsToBook) {
                const ticket = newTickets.find((t: Ticket) => t.id === ticketId);
                if (ticket) {
                    if (ticket.owner === null) {
                        ticket.owner = bookName.trim();
                        booked.push(ticketId);
                    } else {
                        alreadyOwned.push(ticketId);
                    }
                }
            }
            if(booked.length > 0) alert(`Booked tickets: ${booked.join(', ')} for ${bookName.trim()}`);
            if(alreadyOwned.length > 0) alert(`Could not book tickets ${alreadyOwned.join(', ')} as they are already owned.`);
        }

        // Unbooking by numbers
        const ticketIdsToUnbook = parseTicketIds(unbookTicketNumbers);
        if (ticketIdsToUnbook.length > 0) {
            const unbooked = [];
            for (const ticketId of ticketIdsToUnbook) {
                const ticket = newTickets.find((t: Ticket) => t.id === ticketId);
                if (ticket) {
                    ticket.owner = null;
                    unbooked.push(ticketId);
                }
            }
             if(unbooked.length > 0) alert(`Unbooked tickets: ${unbooked.join(', ')}`);
        }

        // Unbooking by name
        if (unbookName.trim()) {
            let unbookedCount = 0;
            for(const ticket of newTickets) {
                if (ticket.owner === unbookName.trim()) {
                    ticket.owner = null;
                    unbookedCount++;
                }
            }
            if(unbookedCount > 0) alert(`Unbooked ${unbookedCount} tickets for ${unbookName.trim()}`);
        }

        const updates: Partial<GameState> = {
            prizesConfig: localPrizes,
            activeTicketLimit: localTicketLimit,
            extraTickets: newTickets
        };
        onUpdateHousieSettings(updates);
        onClose();
    };

    const handleTPSave = () => {
        setTPPlayerConfigs(localTPPlayerConfigs);
        setTPBookedTables(localTPBookedTables);
        setTPTableTimers(localTPTableTimers);
        onClose();
    };
    
    const handleTPConfigChange = (boot: number, id: string, field: keyof PlayerConfig, value: string) => {
        setLocalTPPlayerConfigs(prev => ({
            ...prev,
            [boot]: {
                ...prev[boot],
                [id]: {
                    ...(prev[boot]?.[id] || { name: '', chips: '' }),
                    [field]: value
                }
            }
        }));
    };

    if (!isOpen) return null;

    const TabButton: FC<{tab: typeof activeTab, children: ReactNode}> = ({ tab, children }) => (
        <button 
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-bold rounded-t-lg transition-colors ${activeTab === tab ? 'bg-gray-100 text-blue-600' : 'bg-gray-200 text-gray-500 hover:bg-gray-300'}`}
        >{children}</button>
    );

    const NumberDisplay: FC<{label: string, value: number | null}> = ({label, value}) => (
        <div className="flex flex-col items-center justify-center bg-gray-100 p-2 rounded-lg text-center h-24">
            <span className="text-xs font-bold text-gray-500 uppercase">{label}</span>
            <span className="text-4xl font-black text-gray-800">{value ?? '-'}</span>
        </div>
    );

    const renderHousieAdmin = () => (
        <div className="space-y-6">
            <div>
                <h3 className="font-bold text-gray-700 mb-2 border-b pb-2">Game Actions</h3>
                <div className="bg-blue-50 border border-blue-200 p-4 rounded-xl space-y-4">
                    <div className="grid grid-cols-3 gap-2">
                        <NumberDisplay label="Previous" value={housieGameState?.previousNumber || null} />
                        <NumberDisplay label="Current" value={housieGameState?.currentNumber || null} />
                        <NumberDisplay label="Next" value={housieGameState?.shuffledQueue?.[0] || null} />
                    </div>
                     <button 
                        onClick={onCallNextHousieNumber} 
                        className="w-full bg-blue-600 text-white px-4 py-3 rounded-lg text-sm font-bold shadow active:scale-95 disabled:opacity-50" 
                        disabled={housieGameState?.isGameOver || (housieGameState?.shuffledQueue?.length ?? 0) === 0}
                    >
                        CALL NEXT NUMBER
                    </button>
                    <div className="flex justify-center gap-2 flex-wrap pt-2">
                        <button onClick={() => onUpdateHousieSettings({ isAutoPlaying: !housieGameState?.isAutoPlaying })} className={`px-4 py-2 rounded-lg text-xs font-bold border shadow-sm active:scale-95 ${housieGameState?.isAutoPlaying ? 'bg-red-50 text-red-600 border-red-200' : 'bg-white text-gray-700 border-gray-300'}`}>
                            {housieGameState?.isAutoPlaying ? 'Stop Auto' : 'Auto Play'}
                        </button>
                        <button 
                            onClick={() => setIsResetConfirmOpen(true)}
                            className="px-4 py-2 rounded-lg text-xs font-bold border shadow-sm active:scale-95 bg-red-600 hover:bg-red-700 text-white border-red-700"
                        >
                            Reset Game
                        </button>
                    </div>
                </div>
            </div>
            
            <div>
                <h3 className="font-bold text-gray-700 mb-2 border-b pb-2">Prizes Configuration</h3>
                <p className="text-xs text-gray-500 mb-3">Set winner count for each prize. Set to 0 to disable a prize.</p>
                <div className="grid grid-cols-2 gap-4">
                    {WINNING_PATTERNS.map(p => (
                        <div key={p.key} className="flex items-center justify-between bg-gray-50 p-2 rounded border">
                            <label className="text-sm font-semibold text-gray-600">{p.label}</label>
                            <input 
                                type="number" 
                                min="0"
                                value={localPrizes[p.key]?.count ?? 1}
                                onChange={e => setLocalPrizes(prev => ({...prev, [p.key]: {...(prev[p.key] || {label: p.label}), count: parseInt(e.target.value) || 0 }}))}
                                className="w-16 p-1 text-center font-bold border rounded"
                            />
                        </div>
                    ))}
                </div>
            </div>

            <div>
                 <h3 className="font-bold text-gray-700 mb-2 border-b pb-2">Ticket Management</h3>
                 <div className="space-y-4">
                     <div className="flex items-center justify-between">
                         <label className="text-sm font-semibold text-gray-600">Active Tickets Limit</label>
                         <input type="number" min="1" max={housieGameState?.extraTickets.length || 100} value={localTicketLimit} onChange={e => setLocalTicketLimit(parseInt(e.target.value))} className="w-24 p-1 text-center font-bold border rounded" />
                     </div>
                     <div className="bg-gray-50 p-3 rounded-lg border space-y-2">
                        <h4 className="text-sm font-bold">Book Tickets</h4>
                        <div className="flex gap-2">
                             <input type="text" placeholder="Ticket IDs, e.g., 1, 8, 15" value={bookTicketNumbers} onChange={e => setBookTicketNumbers(e.target.value)} className="flex-1 p-1 border rounded text-sm" />
                             <input type="text" placeholder="Player Name" value={bookName} onChange={e => setBookName(e.target.value)} className="flex-1 p-1 border rounded text-sm" />
                        </div>
                     </div>
                     <div className="bg-gray-50 p-3 rounded-lg border space-y-2">
                        <h4 className="text-sm font-bold">Unbook Tickets</h4>
                        <div className="flex gap-2">
                            <input type="text" placeholder="Ticket IDs, e.g., 2, 9" value={unbookTicketNumbers} onChange={e => setUnbookTicketNumbers(e.target.value)} className="flex-1 p-1 border rounded text-sm" />
                            <input type="text" placeholder="Or by player name" value={unbookName} onChange={e => setUnbookName(e.target.value)} className="flex-1 p-1 border rounded text-sm" />
                        </div>
                     </div>
                 </div>
            </div>
            
             <button
                onClick={() => setIsResetConfirmOpen(true)}
                className="w-full bg-red-600 hover:bg-red-700 text-white font-black py-3 rounded-xl shadow-lg active:scale-95 transition-all text-sm uppercase mb-4"
            >
                Reset Housie Game
            </button>

             <button onClick={handleHousieSave} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-black py-3 rounded-xl shadow-lg active:scale-95 transition-all text-sm uppercase">Save Housie Settings</button>
        </div>
    );

    const renderTPAdmin = () => (
         <div className="space-y-6">
            <div>
                <h3 className="font-bold text-gray-700 mb-2">Boot Table Configuration</h3>
                <p className="text-xs text-gray-500 mb-3">Enable/Disable tables and set session duration (in minutes).</p>
                {[10, 50, 100, 500].map(boot => (
                    <div key={boot} className="flex justify-between items-center mb-2 p-3 bg-gray-100 rounded-lg border">
                        <div className="flex flex-col">
                            <span className="font-bold text-sm text-gray-800">Boot Table: ₹{boot}</span>
                            <div className="flex items-center gap-1 mt-1">
                                <input 
                                    type="number"
                                    min="1"
                                    value={localTPTableTimers[boot] ?? 30}
                                    onChange={(e) => setLocalTPTableTimers(prev => ({...prev, [boot]: parseInt(e.target.value) || 30}))}
                                    className="w-12 h-6 text-xs text-center border rounded border-gray-300"
                                />
                                <span className="text-[10px] uppercase font-bold text-gray-500">Mins</span>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            <span className={`text-xs font-bold ${localTPBookedTables[boot] ? 'text-red-500' : 'text-green-500'}`}>
                                {localTPBookedTables[boot] ? 'BOOKED' : 'UNBOOKED'}
                            </span>
                            <label className="relative inline-flex items-center cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={localTPBookedTables[boot] || false}
                                    onChange={() => setLocalTPBookedTables(prev => ({ ...prev, [boot]: !prev[boot] }))}
                                    className="sr-only peer"
                                />
                                <div className="w-11 h-6 bg-gray-200 rounded-full peer peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
                            </label>
                        </div>
                    </div>
                ))}
            </div>
            <hr/>
            <div>
                <h3 className="font-bold text-gray-700 mb-2">Unique Game IDs</h3>
                {[10, 50, 100, 500].map(boot => (
                    <div key={boot} className="mb-4 p-3 bg-gray-100 rounded-lg border">
                        <div className="flex justify-between items-center mb-2">
                            <h4 className="font-bold text-sm text-gray-800">Boot Table: ₹{boot}</h4>
                            <button 
                                onClick={() => onRegenerateTPIds(boot)} 
                                className="text-xs bg-blue-500 text-white px-2 py-1 rounded hover:bg-blue-600 active:scale-95 transition-all"
                            >
                                Regenerate
                            </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            {(tpGameIds[boot] || []).map(id => (
                                <div key={id} className="text-xs font-mono bg-white p-2 rounded border flex items-center justify-between shadow-sm">
                                    <span className="text-blue-700 font-bold tracking-wider">{id}</span>
                                    <button 
                                        onClick={() => navigator.clipboard.writeText(id)} 
                                        className="text-gray-400 hover:text-black ml-2"
                                        title="Copy ID"
                                    >
                                       <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                ))}
            </div>
            <hr/>
            <div>
                <h3 className="font-bold text-gray-700 mb-2">Player Configuration</h3>
                {[10, 50, 100, 500].map(boot => (
                    <div key={boot} className="mb-4 p-3 bg-gray-100 rounded-lg border">
                        <h4 className="font-bold text-sm text-gray-800 mb-2">Boot Table: ₹{boot}</h4>
                        <div className="grid grid-cols-[1fr,1fr,1fr] gap-2 text-xs font-bold text-gray-500 mb-1 px-2">
                            <span>Unique ID</span>
                            <span>Player Name</span>
                            <span>Starting Chips</span>
                        </div>
                        {(tpGameIds[boot] || []).map(id => (
                            <div key={id} className="grid grid-cols-[1fr,1fr,1fr] items-center gap-2 mb-1 bg-white p-2 rounded-lg border">
                                <div className="text-xs font-mono text-blue-600 truncate slashed-zero" title={id}>{id}</div>
                                <input 
                                    type="text" 
                                    value={localTPPlayerConfigs[boot]?.[id]?.name || ''} 
                                    onChange={e => handleTPConfigChange(boot, id, 'name', e.target.value)}
                                    className="w-full bg-white rounded-md p-1 text-sm font-bold border" 
                                    placeholder="Player Name" 
                                />
                                <input 
                                    type="number" 
                                    value={localTPPlayerConfigs[boot]?.[id]?.chips || ''} 
                                    onChange={e => handleTPConfigChange(boot, id, 'chips', e.target.value)}
                                    className="w-full bg-white rounded-md p-1 text-sm font-bold border" 
                                    placeholder="Chips" 
                                />
                            </div>
                        ))}
                    </div>
                ))}
            </div>
            <button onClick={handleTPSave} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-black py-3 rounded-xl shadow-lg active:scale-95 transition-all text-sm uppercase">Save Teen Patti Settings</button>
        </div>
    );

    return createPortal(
        <>
            <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
                <div className="bg-white rounded-[2.5rem] w-full max-w-2xl overflow-hidden shadow-2xl animate-pop border-8 border-white/10">
                    <div className={`p-8 text-center text-white ${isAdmin ? 'bg-red-600' : 'bg-blue-600'}`}>
                        <h2 className="text-3xl font-black uppercase tracking-tighter">{isAdmin ? '🛡️ Admin Panel' : '💬 Support'}</h2>
                        <p className="text-white/80 text-xs font-bold uppercase mt-1">{isAdmin ? 'System Override Enabled' : 'Ask us anything on WhatsApp'}</p>
                    </div>
                    <div className="p-4 sm:p-8">
                        {isAdmin ? (
                            <div>
                                <div className="flex border-b mb-4">
                                <TabButton tab="housie">Housie</TabButton>
                                <TabButton tab="teenpatti">Teen Patti</TabButton>
                                <TabButton tab="spades">Spades</TabButton>
                                <TabButton tab="rummy">Rummy</TabButton>
                                </div>
                                <div className="max-h-[60vh] overflow-y-auto custom-scrollbar p-2">
                                    {activeTab === 'housie' && renderHousieAdmin()}
                                    {activeTab === 'teenpatti' && renderTPAdmin()}
                                    {activeTab === 'spades' && <div className="text-center p-8 text-gray-500">Spades settings coming soon.</div>}
                                    {activeTab === 'rummy' && <div className="text-center p-8 text-gray-500">Rummy settings coming soon.</div>}
                                </div>
                                <div className="mt-4 text-center">
                                    <button onClick={() => { setIsAdmin(false); setQuery(''); }} className="text-gray-400 font-bold text-xs uppercase hover:text-gray-600 transition-colors">Exit Admin Mode</button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <textarea value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type your query here, or enter admin code..." className="w-full h-40 bg-gray-50 rounded-2xl p-5 text-gray-700 font-bold border-2 border-gray-100 outline-none focus:border-blue-400 transition-all resize-none shadow-inner" />
                                <div className="flex gap-4 mt-8">
                                    <button onClick={() => { onClose(); setQuery(''); }} className="flex-1 bg-gray-100 text-gray-500 font-black py-4 rounded-2xl uppercase text-xs active:scale-95 transition-all">Close</button>
                                    <button onClick={handleSendSupport} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-black py-4 rounded-2xl uppercase text-xs shadow-xl active:scale-95 transition-all">Submit</button>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>
            <ConfirmationModal
                isOpen={isResetConfirmOpen}
                message="This will clear all called numbers, winners, and ticket bookings. This action cannot be undone."
                confirmText="Reset"
                onConfirm={async () => {
                    await onResetHousieGame();
                    setIsResetConfirmOpen(false);
                    onClose();
                }}
                onCancel={() => setIsResetConfirmOpen(false)}
            />
        </>,
        document.body
    );
};


// Universal Header
const GameHeader = ({ 
    currentGame, 
    onHome, 
    onSupport, 
    onSwitchToggle, 
    menuOpen, 
    onGameChange,
    centerContent,
    isMultiplayer
}: { 
    currentGame: GameCategory, 
    onHome: () => void, 
    onSupport: () => void, 
    onSwitchToggle: () => void, 
    menuOpen: boolean,
    onGameChange: (g: GameCategory) => void,
    centerContent?: ReactNode,
    isMultiplayer?: boolean
}) => (
    <header className="relative z-[100] bg-black/40 backdrop-blur-2xl border-b border-white/10 px-4 py-3 flex justify-between items-center h-20 shrink-0 w-full"> 
        <div className="flex items-center gap-4">
            <button onClick={onHome} className="w-12 h-12 flex items-center justify-center bg-white/5 hover:bg-white/10 text-white rounded-2xl border border-white/10 transition-all active:scale-90 shadow-xl" title="Back to Hub">
                <span className="text-2xl">🏠</span>
            </button>
            <div className="h-8 w-px bg-white/10 hidden md:block"></div>
            <h1 className="text-xl font-black text-white tracking-widest uppercase drop-shadow-lg hidden md:block">
                {gameCategories.find(c => c.key === currentGame)?.label}
            </h1>
        </div>
        
        {centerContent && (
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50">
                {centerContent}
            </div>
        )}
        
        <div className="flex items-center gap-2 relative">
             {currentGame === 'teenpatti' && (
                <div className={`border-2 text-white text-xs font-black uppercase px-3 py-1 rounded-md rotate-[-3deg] shadow-lg ${isMultiplayer ? 'bg-red-800 border-red-500' : 'bg-blue-800 border-blue-500'}`}>
                    {isMultiplayer ? 'Multiplayer' : 'Single Player'}
                </div>
            )}
            <button onClick={onSupport} className="w-8 h-8 flex items-center justify-center bg-white/5 hover:bg-white/10 text-white rounded-lg border border-white/10 transition-all active:scale-90" title="Help & Support">
                <span className="text-lg">❓</span>
            </button>
            <button onClick={onSwitchToggle} className="w-8 h-8 flex items-center justify-center bg-blue-600 hover:bg-blue-500 text-white rounded-lg shadow-lg border border-blue-400 transition-all active:scale-90" title="Switch Game">
                <span className="text-lg">🔄</span>
            </button>
            
            {menuOpen && (
                <div className="absolute right-0 top-full mt-4 w-52 bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden animate-pop z-[1100]">
                    <div className="bg-slate-800 p-2 text-[10px] uppercase font-black text-slate-500 tracking-tighter text-center">Switch Game</div>
                    {gameCategories.map(cat => (
                        <button
                            key={cat.key}
                            onClick={() => onGameChange(cat.key)}
                            className={`w-full px-5 py-4 text-left flex items-center gap-3 transition-colors text-sm font-bold border-b border-white/5 last:border-0 ${cat.key === currentGame ? 'bg-white/10 text-green-400' : 'hover:bg-white/5 text-white'}`}
                        >
                            <span className="text-xl">{cat.icon}</span>
                            <span>{cat.label}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
    </header>
);

// Error Boundary
interface ErrorBoundaryProps { children?: ReactNode; }
interface ErrorBoundaryState { hasError: boolean; error: string; }
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    public state: ErrorBoundaryState = { hasError: false, error: "" };
    
    static getDerivedStateFromError(error: any): ErrorBoundaryState { return { hasError: true, error: error.toString() }; }
    componentDidCatch(error: any, errorInfo: any) { console.error("Uncaught error:", error, errorInfo); }
    render() {
        if (this.state.hasError) {
            return (
                <div className="w-screen h-screen bg-red-100 text-red-800 flex flex-col items-center justify-center p-4">
                    <h1 className="text-2xl font-black">Oops! Something went wrong.</h1>
                    <p className="mt-2 text-center">An unexpected error occurred. Please try refreshing the page.</p>
                    <pre className="mt-4 p-4 bg-red-200 rounded-md text-xs w-full max-w-2xl overflow-auto">{this.state.error}</pre>
                </div>
            );
        }
        return (this as any).props.children; 
    }
}

const GameHub: FC<{ onSelectGame: (game: GameCategory) => void }> = ({ onSelectGame }) => (
    <div className="w-full h-full bg-slate-900 flex flex-col items-center justify-center p-8 overflow-y-auto">
        <h1 className="text-5xl md:text-7xl font-black text-transparent bg-clip-text bg-gradient-to-r from-blue-400 to-purple-600 mb-12 uppercase tracking-tighter drop-shadow-2xl text-center">
            Game Hub
        </h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 w-full max-w-6xl">
            {gameCategories.map((cat) => (
                <button
                    key={cat.key}
                    onClick={() => onSelectGame(cat.key)}
                    className={`group relative h-64 rounded-3xl overflow-hidden shadow-2xl transition-all duration-300 hover:scale-105 active:scale-95 border border-white/10`}
                >
                    <div className={`absolute inset-0 bg-gradient-to-br ${cat.color} opacity-20 group-hover:opacity-100 transition-opacity duration-500`}></div>
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-4 z-10">
                        <span className="text-6xl group-hover:scale-110 transition-transform duration-300 filter drop-shadow-lg">{cat.icon}</span>
                        <span className="text-2xl font-black text-white uppercase tracking-wider shadow-black drop-shadow-md">{cat.label}</span>
                    </div>
                </button>
            ))}
        </div>
        <p className="mt-12 text-slate-500 text-xs font-bold uppercase tracking-[0.3em]">Select a game to begin</p>
    </div>
);

// --- Rummy Game ---
const RummyGame: FC = () => <div className="w-full h-full bg-red-800 flex items-center justify-center text-white text-3xl font-black">Rummy - Coming Soon!</div>;
// --- Spades Game ---
const SpadesGame: FC = () => <div className="w-full h-full bg-gray-800 flex items-center justify-center text-white text-3xl font-black">Spades - Coming Soon!</div>;

// --- Housie Game Helpers ---

const HousieBoard: FC<{ calledNumbers: number[], currentNumber: number | null }> = ({ calledNumbers, currentNumber }) => {
    return (
        <div className="bg-[#1a4d2e] rounded-xl p-3 shadow-lg border-2 border-[#143d24]">
            <h2 className="text-white text-xs font-bold uppercase tracking-widest mb-3 pl-1">Master Board (1-90)</h2>
            <div className="grid grid-cols-10 gap-1 content-start">
                {Array.from({ length: 90 }, (_, i) => i + 1).map(num => {
                    const isCalled = calledNumbers.includes(num);
                    const isCurrent = num === currentNumber;
                    return (
                        <div 
                            key={num} 
                            className={`
                                aspect-square flex items-center justify-center rounded text-sm sm:text-base font-black transition-all duration-300 relative
                                ${isCalled ? 'bg-white text-[#1a4d2e] shadow-md scale-100' : 'bg-black/20 text-white/20'}
                                ${isCurrent ? 'ring-2 ring-yellow-400 scale-110 z-10' : ''}
                            `}
                        >
                            {num}
                            {isCurrent && <div className="absolute inset-0 bg-yellow-400 rounded opacity-30 animate-ping"></div>}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

const HousieTicket: FC<{ ticket: Ticket, calledNumbers: number[] }> = ({ ticket, calledNumbers }) => {
    const isBooked = ticket.owner !== null;
    const statusText = isBooked ? `BOOKED: ${ticket.owner}` : 'UNBOOKED';
    const statusColor = isBooked ? 'bg-gray-800 text-white' : 'bg-green-100 text-green-800'; 

    return (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 w-full overflow-hidden mb-3">
            <div className="flex justify-between items-center px-3 py-1.5 bg-gray-50 border-b border-gray-100">
                 <span className="font-bold text-gray-700 text-xs">TICKET NO. {ticket.id}</span>
                 <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${statusColor}`}>
                    {statusText}
                </span>
            </div>
            <div className="p-2">
                <div className="border border-gray-300 rounded overflow-hidden">
                    {ticket.grid.map((row, rIdx) => (
                        <div key={rIdx} className="grid grid-cols-9">
                            {row.map((cell, cIdx) => {
                                const isMarked = cell !== null && calledNumbers.includes(cell);
                                return (
                                    <div
                                        key={cIdx}
                                        className={`
                                            flex items-center justify-center h-8 sm:h-10 text-sm sm:text-base
                                            border-r border-gray-300 last:border-r-0
                                            ${rIdx < 2 ? 'border-b border-gray-300' : ''}
                                            ${isMarked ? 'bg-yellow-300 text-black font-black' : 'bg-white text-gray-800 font-bold'}
                                            ${cell === null ? 'bg-gray-50' : ''}
                                        `}
                                    >
                                        {cell}
                                    </div>
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

const HousieGame: FC<{ gameState: GameState | null }> = ({ gameState }) => {
    const [currentTime, setCurrentTime] = useState(new Date());

    useEffect(() => {
        const timer = setInterval(() => setCurrentTime(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    // TTS Logic
    useEffect(() => {
        if (gameState?.currentNumber) {
            const nickname = getNickname(gameState.currentNumber);
            const text = `${nickname}. ${gameState.currentNumber}`;
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.rate = 1.1;
            window.speechSynthesis.cancel(); 
            window.speechSynthesis.speak(utterance);
        }
    }, [gameState?.currentNumber]);

    // Auto play logic
    useEffect(() => {
        let interval: any;
        if (gameState?.isAutoPlaying && !gameState.isGameOver) {
            interval = setInterval(() => {
                api.callNumber();
            }, 3500); 
        }
        return () => clearInterval(interval);
    }, [gameState?.isAutoPlaying, gameState?.isGameOver]);
    
    // Loading State
    if (!gameState) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900 text-white">
                <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <h2 className="text-xl font-black uppercase tracking-widest animate-pulse">Loading Game...</h2>
            </div>
        );
    }
    
    // Recent Calls (Last 9 based on image)
    const recentCalls = [...gameState.calledNumbers].reverse().slice(0, 9);

    const formattedTime = currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const formattedDate = currentTime.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

    return (
        <div className="w-full h-full bg-slate-50 flex flex-col font-sans relative overflow-hidden">
            {/* Top Bar - Sticky */}
            <div className="bg-[#1e3a8a] text-white px-4 py-2 flex justify-between items-center text-[10px] sm:text-xs font-bold tracking-widest shrink-0 z-50 shadow-md">
                <span className="uppercase text-yellow-400">Official Game Time</span>
                <span>{formattedDate} • {formattedTime}</span>
            </div>

            {/* Main Scrollable Content Area */}
            <div className="flex-1 overflow-y-auto pb-8 custom-scrollbar">
                
                {/* Hero Header */}
                <div className="relative h-48 w-full bg-cover bg-center shrink-0 mb-4" style={{ backgroundImage: "url('https://images.unsplash.com/photo-1596464716127-f2a82984de30?ixlib=rb-4.0.3&auto=format&fit=crop&w=1000&q=80')" }}>
                    <div className="absolute inset-0 bg-gradient-to-t from-[#1e3a8a]/90 to-transparent"></div>
                    <div className="relative z-10 h-full flex flex-col items-center justify-center p-4">
                        <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center shadow-xl border-4 border-yellow-400 mb-4">
                            <span className="text-3xl font-black text-[#1e3a8a] tracking-tighter">SG</span>
                        </div>
                        <button className="bg-yellow-400 hover:bg-yellow-300 text-[#1e3a8a] font-black px-6 py-2 rounded-full shadow-lg uppercase text-xs tracking-wider transform transition hover:scale-105 active:scale-95 border-2 border-yellow-200">
                            Available Tickets
                        </button>
                    </div>
                </div>

                {/* Welcome & Admin Controls */}
                <div className="text-center px-4 mb-6">
                    <h1 className="text-xl font-black text-gray-800 uppercase tracking-tight">Welcome to the Game</h1>
                    <p className="text-blue-600 font-bold text-xs mb-4">Live Tambola Experience</p>
                </div>

                {/* Master Board */}
                <div className="px-4 mb-6">
                    <HousieBoard calledNumbers={gameState.calledNumbers} currentNumber={gameState.currentNumber} />
                </div>

                {/* Called History */}
                <div className="px-4 mb-6">
                    <div className="bg-white border border-gray-200 rounded-xl p-3 shadow-sm">
                        <div className="flex justify-between items-center mb-2">
                            <h3 className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Recent Calls</h3>
                            <span className="text-[10px] bg-blue-50 text-blue-600 px-2 py-0.5 rounded font-bold">Total: {gameState.calledNumbers.length}</span>
                        </div>
                        <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1 min-h-[3rem] items-center">
                            {recentCalls.length === 0 ? (
                                <span className="text-gray-400 text-xs italic w-full text-center">Waiting for first number...</span>
                            ) : (
                                recentCalls.map((num, i) => (
                                    <div key={i} className={`
                                        w-10 h-10 rounded-full flex shrink-0 items-center justify-center font-black text-sm border shadow-sm
                                        ${i === 0 ? 'bg-yellow-400 text-blue-900 border-yellow-500 scale-110' : 'bg-gray-100 text-gray-600 border-gray-200'}
                                    `}>
                                        {num}
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>

                {/* Tickets Section */}
                <div className="px-4">
                    <div className="flex justify-between items-center mb-3">
                        <h3 className="text-sm font-black text-gray-800 uppercase tracking-wide">All Tickets <span className="text-gray-400 text-xs">({gameState.extraTickets.length})</span></h3>
                        <div className="flex gap-2">
                            <input type="text" placeholder="Search..." className="text-xs p-1.5 rounded border border-gray-300 w-24 focus:w-32 transition-all outline-none" />
                        </div>
                    </div>
                    
                    <div className="space-y-3">
                        {gameState.extraTickets.map(ticket => (
                            <HousieTicket key={ticket.id} ticket={ticket} calledNumbers={gameState.calledNumbers} />
                        ))}
                    </div>
                </div>

                {/* Winners Board */}
                <div className="px-4 mt-6">
                    <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
                        <h3 className="text-lg font-black text-gray-800 uppercase tracking-wide mb-4 text-center">Winners Board</h3>
                        <div className="space-y-2">
                            {WINNING_PATTERNS
                                .filter(p => (gameState.prizesConfig[p.key]?.count ?? 1) > 0)
                                .map(pattern => {
                                    const winners = gameState.winners[pattern.key] || [];
                                    const isWon = winners.length > 0;
                                    const prizeLimit = gameState.prizesConfig[pattern.key]?.count || 1;
                                    const isClosed = winners.length >= prizeLimit;

                                    return (
                                        <div key={pattern.key} className={`
                                            rounded-lg p-3 flex justify-between items-center shadow-sm border transition-all
                                            ${isClosed ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-200'}
                                        `}>
                                            <div className="flex flex-col">
                                                <span className="text-xs font-bold text-gray-800 uppercase">{pattern.label}</span>
                                                {isWon && <span className="text-[10px] text-green-700 font-semibold truncate max-w-[150px]">
                                                    Won by: {winners.map(w => `TICKET NO. ${w.id}`).join(', ')}
                                                </span>}
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className={`text-[10px] font-black px-2 py-1 rounded uppercase tracking-wider ${isClosed ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-700'}`}>
                                                    {isClosed ? 'CLOSED' : 'OPEN'}
                                                </span>
                                            </div>
                                        </div>
                                    );
                            })}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

const PackedStamp: FC = () => (
    <div className="absolute inset-0 bg-black/60 flex items-center justify-center rounded-full z-20">
        <span className="text-red-500 font-black text-lg uppercase tracking-wider -rotate-12 border-2 border-red-500 px-2 py-0.5 rounded-md shadow-lg">PACKED</span>
    </div>
);

const CircularTimer: FC<{ timeLeft: number, maxTime: number, size: number, strokeWidth: number }> = ({ timeLeft, maxTime, size, strokeWidth }) => {
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const progress = Math.max(0, timeLeft / maxTime);
    const dashOffset = circumference - progress * circumference;
    
    const isRed = timeLeft <= maxTime * 0.25;

    const colorClass = isRed ? 'text-red-500' : 'text-green-500';

    return (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none" style={{ width: size, height: size }}>
            <svg className="rotate-[-90deg] w-full h-full" viewBox={`0 0 ${size} ${size}`}>
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={strokeWidth}
                    className="text-gray-700 opacity-50"
                />
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={strokeWidth}
                    strokeDasharray={circumference}
                    strokeDashoffset={dashOffset}
                    strokeLinecap="round"
                    className={`transition-all duration-1000 ease-linear ${colorClass}`}
                />
            </svg>
        </div>
    );
};

const TPPlayerSlot: FC<{ player?: Player; isActive: boolean; revealCards: boolean; position: 'top' | 'right' | 'bottom' | 'left'; turnTimeLeft: number; turnDuration: number; isSideShowInitiator: boolean }> = ({ player, isActive, revealCards, position, turnTimeLeft, turnDuration, isSideShowInitiator }) => {
    if (!player || player.status === 'waiting') {
        return (
             <div className="flex flex-col items-center gap-2 p-4 bg-black/20 rounded-2xl border border-dashed border-white/10 w-48 text-center">
                <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center text-slate-500 font-bold text-3xl">?</div>
                <p className="text-slate-400 text-xs font-bold">Waiting for player...</p>
                <div className="h-4 w-20 bg-slate-800 rounded animate-pulse"></div>
            </div>
        );
    }

    const isFolded = player.isFolded;
    const isMainPlayer = position === 'bottom';
    const avatarSize = isMainPlayer ? 80 : 64; // w-20 = 80px, w-16 = 64px
    
    const NameTag = (
        <div className="bg-black/50 rounded-lg px-3 py-1 text-center shadow-lg relative">
            <p className="font-bold text-sm text-white">{player.name}</p>
            <p className="text-xs text-yellow-400">₹{player.chips}</p>
        </div>
    );

    const Avatar = (
        <div className="relative">
            {isActive && (
                <CircularTimer 
                    timeLeft={turnTimeLeft} 
                    maxTime={turnDuration} 
                    size={avatarSize + 16} // Ring larger than avatar
                    strokeWidth={6} 
                />
            )}
            <div className={`rounded-full border-4 bg-gray-900 overflow-hidden shadow-2xl transition-all duration-300 relative z-10 ${isMainPlayer ? 'w-20 h-20' : 'w-16 h-16'} ${isActive ? 'border-yellow-400 scale-105' : 'border-gray-600'}`}>
                <img src={`https://api.dicebear.com/9.x/avataaars/svg?seed=${player.avatarSeed}`} alt="avatar" className="w-full h-full object-cover" />
            </div>
            
            {isFolded ? <PackedStamp /> : player.status === 'playing' && !player.isFolded && (
                <div className={`absolute -bottom-2 left-1/2 -translate-x-1/2 text-white text-[10px] font-black px-2 py-0.5 rounded-full shadow-md uppercase whitespace-nowrap z-20 ${isSideShowInitiator ? 'bg-purple-600 animate-pulse ring-2 ring-purple-400' : 'bg-blue-600'}`}>
                    {isSideShowInitiator ? 'SIDE SHOW' : (player.isSeen ? 'SEEN' : 'BLIND')}
                </div>
            )}
        </div>
    );

    // Updated Cards Layout: Fanned style identical to main player but scaled for opponents
    const Cards = (
         <div className="relative h-24 w-32 mt-2">
            {player.cards.map((card, i) => (
                <div key={card.id} className="absolute bottom-0 left-1/2 origin-bottom transition-transform duration-300" style={{
                    // Identical fanned logic: Center X, Rotate based on index
                    transform: `translateX(-50%) rotate(${(i - 1) * 15}deg)`,
                    zIndex: i
                }}>
                    <PlayingCard 
                        card={card} 
                        // CRITICAL: Only reveal if game is over (revealCards) AND player did not fold (!isFolded)
                        faceUp={revealCards && !isFolded} 
                        size="md" 
                        className="shadow-md"
                    />
                </div>
            ))}
        </div>
    );
    
    return (
        <div className={`flex flex-col items-center gap-2 relative transition-all duration-300 ${isFolded ? 'opacity-50 grayscale' : ''}`}>
            {position === 'bottom' ? (<>{Cards}{Avatar}{NameTag}</>) : (<>{NameTag}{Avatar}{Cards}</>)}
        </div>
    );
};

const GameOverModal: FC<{players: Player[], winner: Player | null, handName: string, onAdminReset: () => void, isDemo: boolean, isSessionExpired: boolean}> = ({ players, winner, handName, onAdminReset, isDemo, isSessionExpired }) => {
    const [password, setPassword] = useState('');

    const handleReset = () => {
        if (password === (process.env.RESET_PASSWORD || 'admin')) {
            onAdminReset();
        } else {
            alert('Incorrect Password');
            setPassword('');
        }
    };

    if (!winner) return null;

    const netAmountWon = winner.chips - (winner.initialChips ?? winner.chips);

    return createPortal(
         <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
            <div className="bg-white rounded-[2.5rem] w-full max-w-md text-center overflow-hidden shadow-2xl animate-pop border-8 border-white/10 p-8 relative">
                <h2 className="text-4xl font-black text-gray-800">Game Over!</h2>
                <div className="mt-4">
                    <p className="text-lg text-gray-600">
                        <span className="font-bold text-blue-600">{winner.name}</span> wins with a <span className="font-bold text-blue-600">{handName}</span>!
                    </p>
                    <div className="mt-2 bg-yellow-100 border border-yellow-300 text-yellow-800 px-4 py-2 rounded-xl inline-block">
                        <span className="text-xs font-bold uppercase tracking-wider">Net Amount Won</span>
                        <p className="text-3xl font-black">₹{netAmountWon}</p>
                    </div>
                </div>

                <div className="mt-6 w-full text-left">
                    <h3 className="font-bold text-gray-700 mb-2 text-center uppercase tracking-wider">Final Balances</h3>
                    <ul className="space-y-1">
                        {players.map(p => (
                            <li key={p.id} className="flex justify-between items-center bg-gray-50 p-3 rounded-lg border">
                                <span className="font-bold text-gray-800">{p.name}</span>
                                <span className="font-semibold text-blue-600">₹{p.chips}</span>
                            </li>
                        ))}
                    </ul>
                </div>
                
                {isDemo || (!isDemo && !isSessionExpired) ? (
                    <div className="mt-8">
                        <button onClick={onAdminReset} className="bg-green-600 hover:bg-green-700 text-white font-black py-3 px-8 rounded-lg shadow-lg active:scale-95 transition-all text-sm uppercase">
                            Play Again
                        </button>
                    </div>
                ) : (
                    <div className="mt-8 border-t pt-6">
                        <p className="text-sm font-bold text-red-600 text-center mb-4 uppercase tracking-widest">Table Time Expired</p>
                        <p className="text-xs text-gray-500 text-center mb-4">Enter Password to Reset Table</p>
                        <div className="flex gap-2">
                            <input
                                type="password"
                                value={password}
                                onChange={e => setPassword(e.target.value)}
                                placeholder="Admin Password"
                                className="flex-1 bg-gray-100 rounded-lg px-4 py-2 text-gray-700 font-bold border-2 border-gray-200 outline-none focus:border-blue-400 transition-all shadow-inner"
                            />
                            <button onClick={handleReset} disabled={!password} className="bg-green-600 hover:bg-green-700 text-white font-black py-2 px-4 rounded-lg shadow-lg active:scale-95 transition-all text-sm uppercase disabled:bg-gray-400 disabled:cursor-not-allowed">
                                Reset
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>,
        document.body
    );
};

const getBotAction = (player: Player, activePlayerCount: number, pot: number, bootAmount: number, bettingRound: number): 'see' | 'chaal' | 'fold' | 'sideShow' => {
    const canAffordBlind = player.chips >= bootAmount;
    const canAffordSeen = player.chips >= bootAmount * 2;

    // --- BLIND BOT LOGIC ---
    if (!player.isSeen) {
        if (!canAffordBlind) return 'fold';

        // More likely to see cards as rounds progress
        const seeChance = 0.10 + (bettingRound * 0.15); // Starts at 10%, increases by 15% each round
        if (Math.random() < seeChance) {
            return 'see';
        }
        
        // If pot is getting big, bot might get nervous and see cards
        if (player.initialChips && pot > player.initialChips * 0.25 && Math.random() < 0.3) {
             return 'see';
        }

        return 'chaal';
    }

    // --- SEEN BOT LOGIC ---
    if (!canAffordSeen) return 'fold';

    const hand = evaluateHand(player.cards);
    let tier = 0;
    if (hand.rank >= 600000) tier = 5; // Trio
    else if (hand.rank >= 500000) tier = 5; // Straight Flush
    else if (hand.rank >= 400000) tier = 4; // Straight
    else if (hand.rank >= 300000) tier = 3; // Flush
    else if (hand.rank >= 200000) tier = 2; // Pair
    else tier = 1; // High Card

    // Side show logic: Only if more than 2 players are active.
    // More likely with better hands.
    if (activePlayerCount > 2 && tier >= 2) { 
        const sideShowChance = [0, 0, 0.2, 0.3, 0.5, 0.6][tier]; 
        if (Math.random() < sideShowChance) {
            return 'sideShow';
        }
    }

    // --- FOLD/CHAAL LOGIC based on hand strength and situation ---

    // Tier 1 (High Card): High chance to fold, but might bluff.
    if (tier === 1) {
        // Bluff if few players are left and pot isn't huge
        const bluffChance = (activePlayerCount <= 2) ? 0.25 : 0.10;
        if (player.initialChips && pot < player.initialChips * 0.3 && Math.random() < bluffChance) {
            return 'chaal'; // Bluff!
        }
        return 'fold';
    }

    // Tier 2 (Pair): Generally play, but might fold if pot gets too big for a weak pair.
    if (tier === 2) {
        const pairValue = Math.floor((hand.rank - 200000) / 100);
        // Fold low pairs if the pot is large
        if (player.initialChips && pairValue < 8 && pot > player.initialChips * 0.5 && Math.random() < 0.4) {
            return 'fold';
        }
        return 'chaal';
    }
    
    // Tier 3+ (Flush or better): Almost never fold.
    return 'chaal';
};

// --- Side Show Modals ---
const SideShowRequestModal: FC<{
    initiatorName: string, 
    betAmount: number, 
    onAccept: () => void, 
    onDeny: () => void 
}> = ({ initiatorName, betAmount, onAccept, onDeny }) => {
    const [countdown, setCountdown] = useState(15);

    useEffect(() => {
        if (countdown <= 0) {
            onDeny();
            return;
        }
        const timerId = setTimeout(() => setCountdown(c => c - 1), 1000);
        return () => clearTimeout(timerId);
    }, [countdown, onDeny]);

    return createPortal(
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-pop">
            <div className="bg-gradient-to-br from-indigo-900 to-purple-900 rounded-[2rem] w-full max-w-sm text-center overflow-hidden shadow-2xl border-4 border-yellow-400 p-8 text-white relative">
                <div className="absolute top-0 left-0 w-full h-2 bg-yellow-400"></div>
                <h3 className="text-2xl font-black uppercase mb-4 text-yellow-400 tracking-wider">Side Show Request</h3>
                <p className="text-lg font-bold mb-2">{initiatorName} wants to compare cards.</p>
                <p className="text-sm text-white/70 mb-4">Cost to them: ₹{betAmount}</p>
                <p className="text-xs text-yellow-300/80 mb-8 animate-pulse">
                    This request will be automatically denied in {countdown} seconds.
                </p>
                <div className="flex gap-4">
                    <button onClick={onDeny} className="flex-1 bg-red-600 hover:bg-red-700 py-3 rounded-xl font-bold uppercase text-sm shadow-lg active:scale-95 transition-all">Deny</button>
                    <button onClick={onAccept} className="flex-1 bg-green-600 hover:bg-green-700 py-3 rounded-xl font-bold uppercase text-sm shadow-lg active:scale-95 transition-all">Accept</button>
                </div>
            </div>
        </div>,
        document.body
    );
};

const SideShowComparisonModal: FC<{
    result: { initiator: Player, target: Player, winner: Player, loser: Player },
    mainPlayerId?: number,
    onClose: () => void
}> = ({ result, mainPlayerId, onClose }) => {
    useEffect(() => {
        const timer = setTimeout(onClose, 10000);
        return () => clearTimeout(timer);
    }, [onClose]);

    const { initiator, target, winner } = result;

    const PlayerDisplay = ({ player, label, isWinner }: { player: Player, label: string, isWinner: boolean }) => (
        <div className={`flex flex-col items-center transition-opacity duration-500 ${!isWinner && 'opacity-60 grayscale'}`}>
            <div className="relative mb-4">
                <img src={`https://api.dicebear.com/9.x/avataaars/svg?seed=${player.avatarSeed}`} alt={player.name} className={`w-24 h-24 rounded-full border-4 bg-gray-900 ${isWinner ? 'border-green-500 shadow-[0_0_30px_rgba(34,197,94,0.6)]' : 'border-red-500'}`} />
                <div className={`absolute -bottom-3 left-1/2 -translate-x-1/2 text-white font-black px-3 py-1 rounded text-xs uppercase shadow-lg ${isWinner ? 'bg-green-600' : 'bg-red-600'}`}>{isWinner ? 'Winner' : 'Loser'}</div>
            </div>
            <p className="text-white font-bold text-lg mb-2">{player.name}</p>
            <p className="text-yellow-400 font-semibold text-sm mb-4">{label}</p>
            <div className="flex justify-center -space-x-4">
                {player.cards.map((c, i) => (
                    <div key={c.id} style={{transform: `rotate(${(i-1)*10}deg)`}} className="origin-bottom">
                        <PlayingCard card={c} size="md" />
                    </div>
                ))}
            </div>
        </div>
    );

    const isMainPlayerInitiator = mainPlayerId === initiator.id;
    const p1 = initiator;
    const p2 = target;
    // p1 is Initiator, p2 is Target
    // Display: Top = Target (p2), Bottom = Initiator (p1)
    
    const targetLabel = mainPlayerId === p2.id ? "Your Cards (Asked)" : `${p2.name}'s Cards (Asked)`;
    const initiatorLabel = mainPlayerId === p1.id ? "Your Cards (Giver)" : `${p1.name}'s Cards (Giver)`;

    return createPortal(
        <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/95 backdrop-blur-xl p-4 animate-pop">
            <div className="w-full max-w-3xl flex flex-col items-center h-full justify-center">
                <h2 className="text-3xl font-black text-yellow-400 uppercase tracking-widest mb-8">Private Showdown</h2>
                <div className="flex flex-col gap-12 w-full items-center">
                    {/* Upper cards - Target (Asked) */}
                    <div className="bg-white/5 p-6 rounded-3xl border border-white/10 w-full max-w-md">
                        <PlayerDisplay player={p2} label={targetLabel} isWinner={p2.id === winner.id} />
                    </div>
                    
                    <div className="text-4xl font-black text-white/20">VS</div>
                    
                    {/* Bottom cards - Initiator (Given) */}
                    <div className="bg-white/5 p-6 rounded-3xl border border-white/10 w-full max-w-md">
                        <PlayerDisplay player={p1} label={initiatorLabel} isWinner={p1.id === winner.id} />
                    </div>
                </div>
                <p className="text-white/50 text-sm font-bold animate-pulse mt-8">Closing in 10 seconds...</p>
            </div>
        </div>,
        document.body
    );
};

// --- Teen Patti Game ---
interface TeenPattiGameProps { 
    players: Player[];
    pot: number;
    bootAmount: number;
    gamePhase: 'table_selection' | 'id_entry' | 'lobby' | 'betting' | 'showdown';
    currentPlayerIndex: number;
    isGameOver: boolean;
    winnerInfo: { winner: Player | null, handName: string };
    localPlayerUniqueId: string | null;
    onTableSelect: (amount: number) => void;
    onJoin: (uniqueId: string) => void;
    onPlayerAction: (action: 'see' | 'chaal' | 'fold' | 'sideShow') => void;
    onAdminReset: () => void;
    onBack: () => void;
    showdownReveal: boolean;
    isMultiplayer: boolean;
    bookedTables: Record<number, boolean>;
    
    // Side Show specific props
    sideShowRequest: { initiatorId: number, targetId: number, amount: number } | null;
    sideShowResult: { initiator: Player, target: Player, winner: Player, loser: Player } | null;
    onSideShowResponse: (accepted: boolean) => void;
    onCloseSideShowResult: () => void;
    turnTimeLeft: number;
    turnDuration: number;
    isSessionExpired: boolean;
}

const TeenPattiGame: FC<TeenPattiGameProps> = ({ 
    players, pot, bootAmount, gamePhase, currentPlayerIndex, isGameOver, winnerInfo, localPlayerUniqueId,
    onTableSelect, onJoin, onPlayerAction, onAdminReset, onBack, showdownReveal, isMultiplayer, bookedTables,
    sideShowRequest, sideShowResult, onSideShowResponse, onCloseSideShowResult,
    turnTimeLeft, turnDuration, isSessionExpired
}) => {
    const [joinId, setJoinId] = useState('');
    
    const displayPlayers = useMemo(() => {
        if (!localPlayerUniqueId || players.length < 4) return players;

        const localPlayerIndex = players.findIndex(p => p.uniqueId === localPlayerUniqueId);
        if (localPlayerIndex === -1) return players;

        const reordered = [];
        for (let i = 0; i < players.length; i++) {
            reordered.push(players[(localPlayerIndex + i) % players.length]);
        }
        return reordered;
    }, [players, localPlayerUniqueId]);

    const mainPlayer = displayPlayers.find(p => p.status !== 'waiting');
    const opponents = displayPlayers.filter(p => p.uniqueId !== mainPlayer?.uniqueId);

    const getOpponentPosition = (player: Player) => {
        const mainPlayerIndex = players.findIndex(p => p.uniqueId === localPlayerUniqueId);
        if (mainPlayerIndex === -1) return { style: '', position: 'top' as 'top' };
    
        const playerIndex = players.findIndex(p => p.uniqueId === player.uniqueId);
    
        const diff = (playerIndex - mainPlayerIndex + 4) % 4;
    
        if (diff === 1) return { style: 'left-2 top-1/2 -translate-y-1/2', position: 'left' as 'left' };
        if (diff === 2) return { style: 'top-8 left-1/2 -translate-x-1/2', position: 'top' as 'top' };
        if (diff === 3) return { style: 'right-2 top-1/2 -translate-y-1/2', position: 'right' as 'right' };
        
        return { style: '', position: 'top' as 'top' }; // Fallback
    };
    
    const isMyTurn = mainPlayer && players[currentPlayerIndex]?.id === mainPlayer.id;
    const showRequestModal = sideShowRequest && mainPlayer && sideShowRequest.targetId === mainPlayer.id;
    const initiatorName = showRequestModal ? players.find(p => p.id === sideShowRequest!.initiatorId)?.name || 'Player' : '';
    const isWaitingForSideShowResponse = sideShowRequest && mainPlayer?.id === sideShowRequest.initiatorId;

    if (gamePhase === 'table_selection') {
        const tables = [10, 50, 100, 500];
        return (
            <div className="w-full h-full tp-background-gradient flex flex-col items-center justify-center text-white p-8">
                <h2 className="text-4xl font-black uppercase mb-12 tracking-wider text-yellow-400 drop-shadow-lg">Select Table Boot</h2>
                <div className="grid grid-cols-2 gap-6 max-w-2xl w-full">
                    {tables.map(amount => {
                        const isBooked = bookedTables[amount];
                        return (
                            <button 
                                key={amount}
                                onClick={() => onTableSelect(amount)}
                                disabled={isBooked}
                                className="relative bg-white/10 hover:bg-white/20 border-2 border-white/30 rounded-2xl p-8 flex flex-col items-center justify-center gap-2 transition-all active:scale-95 shadow-xl group disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-white/10"
                            >
                                <div className={`absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 text-white text-xs font-black uppercase px-4 py-1 rounded-full shadow-lg border-2 border-white/50 ${isBooked ? 'bg-red-600' : 'bg-green-600'}`}>
                                    {isBooked ? 'Booked' : 'Unbooked'}
                                </div>
                                <span className="text-yellow-400 text-lg font-bold uppercase tracking-widest group-hover:text-yellow-300 mt-4">Boot Amount</span>
                                <span className="text-5xl font-black">₹{amount}</span>
                                <span className="text-xs text-gray-400 font-bold mt-2 uppercase">4 Players</span>
                            </button>
                        )
                    })}
                </div>
            </div>
        );
    }

    if (gamePhase === 'id_entry') {
        return (
             <div className="w-full h-full tp-background-gradient flex flex-col items-center justify-center text-white p-8">
                 <button onClick={onBack} className="absolute top-4 left-4 text-white bg-white/10 hover:bg-white/20 px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                    Back
                 </button>
                 <p className="text-lg text-gray-300 mb-6 font-semibold uppercase tracking-widest">Enter your Unique ID to play the game</p>
                 <div className="flex flex-col gap-4 items-center w-full max-w-md">
                    <div className="flex gap-2 w-full">
                        <input 
                            value={joinId}
                            onChange={e => setJoinId(e.target.value.toUpperCase())}
                            maxLength={12}
                            placeholder="UNIQUE ID"
                            className="bg-black/20 border-2 border-dashed border-white/30 rounded-lg px-4 py-3 text-white placeholder-gray-500 flex-1 text-center font-mono text-xl tracking-widest uppercase slashed-zero focus:border-yellow-400 outline-none transition-colors"
                        />
                        <button onClick={() => onJoin(joinId)} disabled={!joinId.trim()} className="bg-yellow-500 hover:bg-yellow-400 text-black font-bold px-8 py-3 rounded-lg text-lg disabled:bg-gray-500 disabled:cursor-not-allowed shadow-lg active:scale-95 transition-all">
                            PLAY
                        </button>
                    </div>
                    
                    <div className="w-full border-t border-white/10 my-4"></div>
                    
                    <button 
                        onClick={() => onJoin(`GUEST_${Math.floor(1000 + Math.random() * 9000)}`)}
                        className="bg-blue-600 hover:bg-blue-500 text-white font-bold text-lg uppercase py-4 px-10 rounded-lg shadow-lg active:scale-95 transition-all flex items-center gap-2"
                    >
                        <span>🎮</span> Play Demo
                    </button>
                 </div>
                 
                 <p className="mt-8 text-xs text-gray-500 font-mono">Current Boot: ₹{bootAmount}</p>
            </div>
        );
    }
    
    return (
        <div className="w-full h-full tp-background-gradient flex items-center justify-center text-white relative overflow-hidden">
            {isGameOver && (
                <GameOverModal 
                    players={players} 
                    winner={winnerInfo.winner} 
                    handName={winnerInfo.handName} 
                    onAdminReset={onAdminReset}
                    isDemo={!isMultiplayer}
                    isSessionExpired={isSessionExpired}
                />
            )}
            
            {showRequestModal && (
                <SideShowRequestModal 
                    initiatorName={initiatorName} 
                    betAmount={sideShowRequest!.amount} 
                    onAccept={() => onSideShowResponse(true)} 
                    onDeny={() => onSideShowResponse(false)} 
                />
            )}

            {sideShowResult && mainPlayer && [sideShowResult.initiator.id, sideShowResult.target.id].includes(mainPlayer.id) && (
                <SideShowComparisonModal 
                    result={sideShowResult}
                    mainPlayerId={mainPlayer?.id}
                    onClose={onCloseSideShowResult} 
                />
            )}

            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 flex flex-col items-center">
                 <div className="bg-black/20 rounded-2xl px-12 py-4 text-center border-2 border-white/10 shadow-2xl backdrop-blur-md">
                    {gamePhase === 'lobby' ? (
                        <>
                            <p className="text-yellow-400 text-xs font-bold uppercase tracking-widest animate-pulse">
                                {players.filter(p => p.status === 'joined').length < 4 ? 'Waiting for players...' : 'Table Full'}
                            </p>
                            <p className="text-white text-3xl font-black mt-1">
                                {players.filter(p => p.status === 'joined').length}/4
                            </p>
                            <p className="text-gray-400 text-[10px] mt-1 font-mono">Boot: ₹{bootAmount}</p>
                        </>
                    ) : (
                        <>
                            <p className="text-yellow-400 text-xs font-bold uppercase tracking-widest">Current Pot</p>
                            <p className="text-5xl font-black text-white">₹{pot}</p>
                            {gamePhase !== 'lobby' && <p className="text-gray-400 text-xs mt-1">Boot: ₹{bootAmount}</p>}
                        </>
                    )}
                 </div>
            </div>
            
            {opponents.map((opponent) => {
                const { style, position } = getOpponentPosition(opponent);
                const isActive = players[currentPlayerIndex]?.id === opponent.id && gamePhase === 'betting';
                return (
                    <div key={opponent.uniqueId} className={`absolute ${style}`}>
                        <TPPlayerSlot 
                            player={opponent} 
                            isActive={isActive} 
                            revealCards={showdownReveal} 
                            position={position} 
                            turnTimeLeft={turnTimeLeft}
                            turnDuration={turnDuration}
                            isSideShowInitiator={sideShowRequest?.initiatorId === opponent.id}
                        />
                    </div>
                )
            })}
            
            {mainPlayer && (
                <>
                    <div className="absolute bottom-8 left-4 flex flex-col items-center gap-2">
                        {mainPlayer.cards.length > 0 && (
                            <div className="relative w-80 h-56 -mt-16">
                                {mainPlayer.cards.map((card, i) => (
                                    <div key={card.id} className="absolute bottom-0 left-1/2 origin-bottom transition-transform duration-300" style={{ transform: `translateX(-50%) rotate(${(i - 1) * 20}deg) translateY(-10%)`, zIndex: i }}>
                                        <PlayingCard card={card} faceUp={(showdownReveal && !mainPlayer.isFolded) || (!showdownReveal && mainPlayer.isSeen)} size="xl" className="shadow-2xl" />
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
            
                    <div className="absolute bottom-8 right-8 flex flex-col items-end gap-4">
                        <div className={`flex items-center gap-3 transition-all duration-300 ${mainPlayer.isFolded ? 'opacity-50 grayscale' : ''}`}>
                            <div className="bg-black/50 rounded-lg px-4 py-2 text-right shadow-lg">
                                <p className="font-bold text-md text-white">{mainPlayer.name}</p>
                                <p className="text-sm text-yellow-400">₹{mainPlayer.chips}</p>
                            </div>
                            <div className="relative">
                                {/* Main Player Avatar with Timer */}
                                {isMyTurn && gamePhase === 'betting' && (
                                    <CircularTimer 
                                        timeLeft={turnTimeLeft} 
                                        maxTime={turnDuration} 
                                        size={96} // 80px avatar + padding
                                        strokeWidth={6} 
                                    />
                                )}
                                <div className={`w-20 h-20 rounded-full border-4 bg-gray-900 overflow-hidden shadow-2xl transition-all duration-300 relative z-10 ${isMyTurn && gamePhase === 'betting' ? 'border-yellow-400 scale-105' : 'border-gray-600'}`}>
                                    <img src={`https://api.dicebear.com/9.x/avataaars/svg?seed=${mainPlayer.avatarSeed}`} alt="avatar" className="w-full h-full object-cover" />
                                </div>
                                
                                {mainPlayer.isFolded ? (
                                    <PackedStamp />
                                ) : (mainPlayer.status === 'playing' &&
                                    <div className={`absolute -bottom-2 left-1/2 -translate-x-1/2 text-white text-xs font-black px-3 py-1 rounded-full shadow-md uppercase whitespace-nowrap z-20 ${isWaitingForSideShowResponse ? 'bg-purple-600 animate-pulse ring-2 ring-purple-400' : 'bg-blue-600'}`}>
                                        {isWaitingForSideShowResponse ? 'SIDE SHOW' : (mainPlayer.isSeen ? 'SEEN' : 'BLIND')}
                                    </div>
                                )}
                            </div>
                        </div>
                        {gamePhase === 'betting' && !mainPlayer.isFolded && (
                            isWaitingForSideShowResponse ? (
                                <div className="bg-black/30 backdrop-blur-sm border border-white/10 p-4 rounded-2xl shadow-lg h-32 flex items-center justify-center w-80">
                                    <p className="text-yellow-400 font-bold animate-pulse text-lg">Waiting for response...</p>
                                </div>
                            ) : (
                                <div className={`bg-black/30 backdrop-blur-sm border border-white/10 p-4 rounded-2xl flex items-end gap-2 shadow-lg transition-all duration-300 ${!isMyTurn ? 'grayscale opacity-60' : ''}`}>
                                    <button onClick={() => onPlayerAction('fold')} disabled={!isMyTurn} className="w-16 h-16 bg-red-600 rounded-full flex items-center justify-center font-black text-md uppercase shadow-lg transition-transform active:scale-95 disabled:cursor-not-allowed">Pack</button>
                                    {!mainPlayer.isSeen && <button onClick={() => onPlayerAction('see')} disabled={!isMyTurn} className="w-16 h-16 bg-yellow-500 rounded-full flex items-center justify-center font-black text-md uppercase shadow-lg transition-transform active:scale-95 disabled:cursor-not-allowed">See</button>}
                                    {mainPlayer.isSeen && <button onClick={() => onPlayerAction('sideShow')} disabled={!isMyTurn || players.filter(p => !p.isFolded).length <= 2} className="w-16 h-16 bg-purple-600 rounded-full flex items-center justify-center font-black text-sm uppercase shadow-lg transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-gray-500">Side Show</button>}
                                    <button onClick={() => onPlayerAction('chaal')} disabled={!isMyTurn} className="w-24 h-24 bg-green-600 rounded-full flex flex-col items-center justify-center font-black text-lg uppercase shadow-lg transition-transform active:scale-95 disabled:cursor-not-allowed">
                                        {mainPlayer.isSeen ? 'Chaal' : 'Blind'}
                                        <span className="text-2xl">₹{mainPlayer.isSeen ? bootAmount * 2 : bootAmount}</span>
                                    </button>
                                </div>
                            )
                        )}
                    </div>
                </>
            )}
        </div>
    );
};

const App: FC = () => {
    const [currentGame, setCurrentGame] = useState<GameCategory | null>(null);
    const [isSupportOpen, setIsSupportOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    
    // Housie Game State
    const [housieGameState, setHousieGameState] = useState<GameState | null>(null);

    // Teen Patti Admin state
    const [tpGameIds, setTPGameIds] = useState<Record<number, string[]>>({});
    const [tpPlayerConfigs, setTPPlayerConfigs] = useState<AllPlayerConfigs>({});
    const [tpBookedTables, setTPBookedTables] = useState<Record<number, boolean>>({});
    const [tpTableTimers, setTPTableTimers] = useState<Record<number, number>>({});

    useEffect(() => {
        if (currentGame === 'housie') {
            const unsub = api.subscribe(setHousieGameState);
            return unsub;
        }
    }, [currentGame]);

    const handleRegenerateTPIds = (boot: number) => {
        const newIds = Array.from({ length: 4 }, generateGameId);
        setTPGameIds(prev => ({ ...prev, [boot]: newIds }));
    };

    // TP Game State
    const [tpState, setTpState] = useState({
        players: [] as Player[],
        pot: 0,
        bootAmount: 0,
        gamePhase: 'table_selection' as 'table_selection' | 'id_entry' | 'lobby' | 'betting' | 'showdown',
        currentPlayerIndex: 0,
        isGameOver: false,
        winnerInfo: { winner: null as Player | null, handName: '' },
        localPlayerUniqueId: null as string | null,
        showdownReveal: false,
        isMultiplayer: false,
        sideShowRequest: null as any,
        sideShowResult: null as any,
        turnTimeLeft: 120,
        turnDuration: 120,
        isSessionExpired: false
    });

    const bettingRoundRef = useRef(0);

    const executePlayerAction = useCallback((action: 'see' | 'chaal' | 'fold' | 'sideShow') => {
        setTpState(prev => {
            if (prev.isGameOver) return prev;
    
            const newState = JSON.parse(JSON.stringify(prev));
            let { players, currentPlayerIndex, bootAmount, pot } = newState;
            const currentPlayer = players[currentPlayerIndex];
    
            if (!currentPlayer) return newState;
    
            // Handle 'see' action: it doesn't end the turn, just reveals cards.
            if (action === 'see') {
                if (!currentPlayer.isSeen) {
                    currentPlayer.isSeen = true;
                }
                // Reset timer for the same player to make their next move with cards seen
                const currentTurnDuration = currentPlayer.chips <= 0 ? 300 : 120;
                return { ...newState, players, turnTimeLeft: currentTurnDuration, turnDuration: currentTurnDuration };
            }
    
            // --- Actions that end the turn ---
            if (action === 'chaal' || action === 'sideShow') {
                const betAmount = currentPlayer.isSeen ? bootAmount * 2 : bootAmount;
                if (currentPlayer.chips >= betAmount) {
                    currentPlayer.chips -= betAmount;
                    pot += betAmount;
                } else {
                    currentPlayer.isFolded = true; // Not enough chips, force fold
                }
            } else if (action === 'fold') {
                currentPlayer.isFolded = true;
            }
    
            const activePlayers = players.filter((p: Player) => !p.isFolded);
            let isGameOver = false;
            // FIX: Explicitly type the local `winnerInfo` variable to prevent potential type inference issues,
            // especially after using JSON.parse/stringify which erases type information from the state.
            let winnerInfo: { winner: Player | null; handName: string; } = { winner: null, handName: '' };
    
            if (activePlayers.length <= 1) {
                isGameOver = true;
                if (activePlayers.length === 1) {
                    const winner = activePlayers[0];
                    const winnerPlayer = players.find((p: Player) => p.id === winner.id)!;
                    winnerPlayer.chips += pot;
                    winnerInfo = { winner: winnerPlayer, handName: 'being the last player' };
                }
                pot = 0; // Pot is awarded
            }
    
            let nextPlayerIndex = currentPlayerIndex;
            if (!isGameOver) {
                let loopGuard = 0;
                do {
                    nextPlayerIndex = (nextPlayerIndex + 1) % players.length;
                    loopGuard++;
                } while (players[nextPlayerIndex].isFolded && loopGuard < players.length * 2);
    
                // Set timer for the next player
                const nextPlayer = players[nextPlayerIndex];
                const nextTurnDuration = nextPlayer.chips <= 0 ? 300 : 120;
                newState.turnDuration = nextTurnDuration;
                newState.turnTimeLeft = nextTurnDuration;
            }
    
            return {
                ...newState,
                players,
                pot,
                currentPlayerIndex: nextPlayerIndex,
                isGameOver,
                winnerInfo,
                showdownReveal: isGameOver,
            };
        });
    }, []);

    // Effect for turn timer countdown
    useEffect(() => {
        if (tpState.gamePhase !== 'betting' || tpState.isGameOver) {
            return;
        }
        const timerId = setInterval(() => {
            setTpState(prev => ({ ...prev, turnTimeLeft: Math.max(0, prev.turnTimeLeft - 1) }));
        }, 1000);
        return () => clearInterval(timerId);
    }, [tpState.gamePhase, tpState.isGameOver, tpState.currentPlayerIndex]);

    // Effect to handle auto-fold on timeout
    useEffect(() => {
        if (tpState.turnTimeLeft === 0 && tpState.gamePhase === 'betting' && !tpState.isGameOver) {
            executePlayerAction('fold');
        }
    }, [tpState.turnTimeLeft, tpState.gamePhase, tpState.isGameOver, executePlayerAction]);


    useEffect(() => {
        if (tpState.gamePhase !== 'betting' || tpState.isGameOver) return;
        
        if (tpState.currentPlayerIndex === 0) {
            bettingRoundRef.current += 1;
        }

        const currentPlayer = tpState.players[tpState.currentPlayerIndex];
        if (currentPlayer && currentPlayer.isBot && !currentPlayer.isFolded) {
            const botTurnTimeout = setTimeout(() => {
                const activePlayerCount = tpState.players.filter(p => !p.isFolded).length;
                const action = getBotAction(
                    currentPlayer,
                    activePlayerCount,
                    tpState.pot,
                    tpState.bootAmount,
                    bettingRoundRef.current
                );
                executePlayerAction(action);
            }, 1000 + Math.random() * 1500);

            return () => clearTimeout(botTurnTimeout);
        }
    }, [tpState.currentPlayerIndex, tpState.gamePhase, tpState.isGameOver, tpState.players, executePlayerAction]);


    // Mock TP Logic for Demo
    const handleTPJoin = (uid: string) => {
        bettingRoundRef.current = 0;
        const deck = generateDeckTP();
        
        setTpState(prev => {
            const bootAmount = prev.bootAmount;
            const initialChips = 10000;
            const turnDuration = 120; // Default turn duration
            
            const players: Player[] = [
                { id: 0, positionId: 0, uniqueId: uid, name: 'You', isBot: false, cards: [deck.pop()!, deck.pop()!, deck.pop()!], chips: initialChips - bootAmount, initialChips: initialChips, avatarSeed: 'me', status: 'playing', isSeen: false, isFolded: false },
                { id: 1, positionId: 1, uniqueId: 'bot1', name: getRandomBotName(), isBot: true, cards: [deck.pop()!, deck.pop()!, deck.pop()!], chips: initialChips - bootAmount, initialChips: initialChips, avatarSeed: 'bot1', status: 'playing', isSeen: false, isFolded: false },
                { id: 2, positionId: 2, uniqueId: 'bot2', name: getRandomBotName(), isBot: true, cards: [deck.pop()!, deck.pop()!, deck.pop()!], chips: initialChips - bootAmount, initialChips: initialChips, avatarSeed: 'bot2', status: 'playing', isSeen: false, isFolded: false },
                { id: 3, positionId: 3, uniqueId: 'bot3', name: getRandomBotName(), isBot: true, cards: [deck.pop()!, deck.pop()!, deck.pop()!], chips: initialChips - bootAmount, initialChips: initialChips, avatarSeed: 'bot3', status: 'playing', isSeen: false, isFolded: false },
            ];

            const firstPlayer = players[0];
            const firstTurnDuration = firstPlayer.chips <= 0 ? 300 : 120;

            return {
                ...prev, 
                players, 
                gamePhase: 'betting', 
                localPlayerUniqueId: uid, 
                pot: bootAmount * players.length,
                currentPlayerIndex: 0,
                isGameOver: false,
                winnerInfo: { winner: null, handName: '' },
                showdownReveal: false,
                turnDuration: firstTurnDuration,
                turnTimeLeft: firstTurnDuration,
            };
        });
    };
    
    const handlePlayAgain = () => {
        setTpState(prev => ({
            ...prev,
            gamePhase: 'table_selection',
            isGameOver: false,
            winnerInfo: { winner: null, handName: '' },
            players: []
        }));
    };

    return (
        <ErrorBoundary>
            <div className="w-full h-full bg-slate-900 overflow-hidden relative font-sans select-none text-slate-900">
                {currentGame ? (
                    <div className="w-full h-full flex flex-col">
                        <GameHeader 
                            currentGame={currentGame}
                            onHome={() => setCurrentGame(null)}
                            onSupport={() => setIsSupportOpen(true)}
                            onSwitchToggle={() => setMenuOpen(!menuOpen)}
                            menuOpen={menuOpen}
                            onGameChange={(g) => { setCurrentGame(g); setMenuOpen(false); }}
                            isMultiplayer={currentGame === 'teenpatti' && tpState.isMultiplayer}
                        />
                        <div className="flex-1 relative overflow-hidden">
                            {currentGame === 'housie' && <HousieGame gameState={housieGameState} />}
                            {currentGame === 'teenpatti' && (
                                <TeenPattiGame 
                                    {...tpState}
                                    onTableSelect={(a) => setTpState(prev => ({...prev, bootAmount: a, gamePhase: 'id_entry'}))}
                                    onJoin={handleTPJoin}
                                    onPlayerAction={executePlayerAction}
                                    onAdminReset={handlePlayAgain}
                                    onBack={() => setTpState(prev => ({...prev, gamePhase: 'table_selection'}))}
                                    bookedTables={tpBookedTables}
                                    onSideShowResponse={() => {}}
                                    onCloseSideShowResult={() => {}}
                                />
                            )}
                            {currentGame === 'rummy' && <RummyGame />}
                            {currentGame === 'spades' && <SpadesGame />}
                        </div>
                    </div>
                ) : (
                    <GameHub onSelectGame={setCurrentGame} />
                )}
                
                <SettingsModal 
                    isOpen={isSupportOpen}
                    onClose={() => setIsSupportOpen(false)}
                    housieGameState={housieGameState}
                    onUpdateHousieSettings={(settings) => api.updateSettings(settings)}
                    onResetHousieGame={() => api.resetGame()}
                    onCallNextHousieNumber={() => api.callNumber()}
                    tpGameIds={tpGameIds}
                    onRegenerateTPIds={handleRegenerateTPIds}
                    tpPlayerConfigs={tpPlayerConfigs}
                    setTPPlayerConfigs={setTPPlayerConfigs}
                    tpBookedTables={tpBookedTables}
                    setTPBookedTables={setTPBookedTables}
                    tpTableTimers={tpTableTimers}
                    setTPTableTimers={setTPTableTimers}
                />
            </div>
        </ErrorBoundary>
    );
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);