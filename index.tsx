
import React, { useState, useEffect, ReactNode, FC, useMemo, useCallback, useRef, Component, ErrorInfo } from "react";
import { createRoot } from "react-dom/client";
import {TOTAL_NUMBERS, WINNING_PATTERNS, SUPPORT_PHONE, getNickname } from "./constants";
import { api, GameState, Ticket, TicketGrid, Winners, TicketCell, PrizeConfig } from "./api";
import { createPortal } from "react-dom";
import { GoogleGenAI, Modality } from "@google/genai";
import { db, isFirebaseConfigured } from './firebaseConfig';
import { ref, onValue, runTransaction, set, get, Unsubscribe, update } from "firebase/database";
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

const formatTime = (totalSeconds: number): string => {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
};

// --- Audio Decoding Helpers for TTS ---
function decode(base64: string) {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

async function decodeAudioData(
    data: Uint8Array,
    ctx: AudioContext,
    sampleRate: number,
    numChannels: number,
): Promise<AudioBuffer> {
    const dataInt16 = new Int16Array(data.buffer);
    const frameCount = dataInt16.length / numChannels;
    const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

    for (let channel = 0; channel < numChannels; channel++) {
        const channelData = buffer.getChannelData(channel);
        for (let i = 0; i < frameCount; i++) {
            channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
        }
    }
    return buffer;
}


// --- Reusable UI Components ---

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

// Moved from inside SettingsModal to prevent re-creation on every render
const TabButton: FC<{
    tab: 'housie' | 'teenpatti' | 'spades' | 'rummy';
    activeTab: 'housie' | 'teenpatti' | 'spades' | 'rummy';
    onClick: (tab: 'housie' | 'teenpatti' | 'spades' | 'rummy') => void;
    children: ReactNode;
}> = ({ tab, activeTab, onClick, children }) => (
    <button 
        onClick={() => onClick(tab)}
        className={`px-4 py-2 text-sm font-bold rounded-t-lg transition-colors ${activeTab === tab ? 'bg-gray-100 text-blue-600' : 'bg-gray-200 text-gray-500 hover:bg-gray-300'}`}
    >{children}</button>
);

// Moved from inside SettingsModal to prevent re-creation on every render
const NumberDisplay: FC<{label: string, value: number | null}> = ({label, value}) => (
    <div className="flex flex-col items-center justify-center bg-gray-100 p-2 rounded-lg text-center h-24">
        <span className="text-xs font-bold text-gray-500 uppercase">{label}</span>
        <span className="text-4xl font-black text-gray-800">{value ?? '-'}</span>
    </div>
);


// Help & Support Modal
const SettingsModal = ({ 
    isOpen, onClose, 
    // Housie Props
    housieGameState, onUpdateHousieSettings, onResetHousieGame, onCallNextHousieNumber,
    // Teen Patti Props
    tpGameIds, onRegenerateTPIds, tpPlayerConfigs, tpBookedTables, tpTableTimers, onSaveTPSettingsAsync
}: { 
    isOpen: boolean, 
    onClose: () => void,
    housieGameState: GameState | null,
    onUpdateHousieSettings: (settings: Partial<GameState>) => Promise<void>,
    onResetHousieGame: () => Promise<void>,
    onCallNextHousieNumber: () => void,
    tpGameIds: Record<number, string[]>,
    onRegenerateTPIds: (boot: number) => Promise<void>,
    tpPlayerConfigs: AllPlayerConfigs,
    tpBookedTables: Record<number, boolean>,
    tpTableTimers: Record<number, number>,
    onSaveTPSettingsAsync: (settings: { configs: AllPlayerConfigs, booked: Record<number, boolean>, timers: Record<number, number> }) => Promise<void>
}) => {
    const [query, setQuery] = useState('');
    const [isAdmin, setIsAdmin] = useState(false);
    const [activeTab, setActiveTab] = useState<'housie' | 'teenpatti' | 'spades' | 'rummy'>('housie');
    const [isConfirmingReset, setIsConfirmingReset] = useState(false);

    // Housie local state
    const [localPrizes, setLocalPrizes] = useState<Record<string, PrizeConfig>>({});
    const [localTicketLimit, setLocalTicketLimit] = useState(100);
    const [localScheduledTime, setLocalScheduledTime] = useState('');
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
                setLocalPrizes(JSON.parse(JSON.stringify(housieGameState.prizesConfig || {})));
                setLocalTicketLimit(housieGameState.activeTicketLimit);
                setLocalScheduledTime(housieGameState.scheduledStartTime || '');
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
            setIsConfirmingReset(false);
        }
    }, [isOpen, housieGameState, tpPlayerConfigs, tpBookedTables, tpTableTimers]);
    
    useEffect(() => {
        if (query === (process.env.ADMIN_PASSWORD || 'admin')) { setIsAdmin(true); }
    }, [query]);

    const handleSendSupport = () => {
        if (!query.trim()) return alert("Please enter your message.");
        const text = `Hi Support! I have a query:\n\n${query}`;
        window.open(`https://wa.me/${SUPPORT_PHONE}?text=${encodeURIComponent(text)}`, '_blank');
        onClose(); setQuery('');
    };

    const handleBookTickets = async () => {
        if (!housieGameState) return;
        if (!bookName.trim() || !bookTicketNumbers.trim()) {
            alert("Please provide both player name and ticket IDs to book.");
            return;
        }
        
        const newTickets = structuredClone(housieGameState.extraTickets);
        const ticketIdsToBook = bookTicketNumbers.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id) && id > 0);
        
        const booked = [];
        const alreadyOwned = [];
        
        for(const ticketId of ticketIdsToBook) {
            const ticket = newTickets.find((t) => t.id === ticketId);
            if (ticket) {
                if (ticket.owner === null) {
                    ticket.owner = bookName.trim();
                    booked.push(ticketId);
                } else {
                    alreadyOwned.push(ticketId);
                }
            }
        }
        
        try {
            await onUpdateHousieSettings({ extraTickets: newTickets });
            let message = '';
            if (booked.length > 0) message += `Booked tickets: ${booked.join(', ')} for ${bookName.trim()}\n`;
            if (alreadyOwned.length > 0) message += `Could not book tickets ${alreadyOwned.join(', ')} as they are already owned.`;
            if (message) alert(message.trim());
            setBookName('');
            setBookTicketNumbers('');
        } catch (error) {
            console.error("Error booking tickets:", error);
            alert("Failed to book tickets. Please check your Firebase Database rules to ensure you have write permissions.");
        }
    };

    const handleUnbookTickets = async () => {
        if (!housieGameState) return;
        if (!unbookName.trim() && !unbookTicketNumbers.trim()) {
            alert("Please provide either ticket IDs or a player name to unbook.");
            return;
        }
    
        const newTickets = structuredClone(housieGameState.extraTickets);
        const ticketIdsToUnbook = unbookTicketNumbers.split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id) && id > 0);
    
        let unbookedCount = 0;
        
        // Unbooking by numbers
        if (ticketIdsToUnbook.length > 0) {
            for (const ticketId of ticketIdsToUnbook) {
                const ticket = newTickets.find((t) => t.id === ticketId);
                if (ticket && ticket.owner) {
                    ticket.owner = null;
                    unbookedCount++;
                }
            }
        }
    
        // Unbooking by name
        if (unbookName.trim()) {
            for(const ticket of newTickets) {
                if (ticket.owner === unbookName.trim()) {
                    ticket.owner = null;
                    if (!ticketIdsToUnbook.includes(ticket.id)) unbookedCount++;
                }
            }
        }
    
        try {
            await onUpdateHousieSettings({ extraTickets: newTickets });
            if (unbookedCount > 0) {
                alert(`Successfully unbooked ${unbookedCount} ticket(s).`);
            } else {
                alert("No matching tickets found to unbook.");
            }
            setUnbookName('');
            setUnbookTicketNumbers('');
        } catch (error) {
            console.error("Error unbooking tickets:", error);
            alert("Failed to unbook tickets. Please check your Firebase Database rules to ensure you have write permissions.");
        }
    };
    
    const handleHousieSave = async () => {
        if (!housieGameState) return;
        try {
            await onUpdateHousieSettings({
                prizesConfig: localPrizes,
                activeTicketLimit: localTicketLimit,
                scheduledStartTime: localScheduledTime
            });
            alert("Housie settings saved successfully.");
            onClose();
        } catch (error) {
            console.error("Error saving Housie settings:", error);
            alert("Failed to save Housie settings. Please check your Firebase Database rules to ensure you have write permissions.");
        }
    };

    const handleTPSave = async () => {
        await onSaveTPSettingsAsync({
            configs: localTPPlayerConfigs,
            booked: localTPBookedTables,
            timers: localTPTableTimers
        });
        // Feedback is handled in the passed function
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
                    <div className="flex justify-center items-center gap-2 flex-wrap pt-2">
                        <button onClick={() => onUpdateHousieSettings({ isAutoPlaying: !housieGameState?.isAutoPlaying })} className={`px-4 py-2 rounded-lg text-xs font-bold border shadow-sm active:scale-95 ${housieGameState?.isAutoPlaying ? 'bg-red-50 text-red-600 border-red-200' : 'bg-white text-gray-700 border-gray-300'}`}>
                            {housieGameState?.isAutoPlaying ? 'Stop Auto' : 'Auto Play'}
                        </button>
                        
                        {!isConfirmingReset ? (
                            <button 
                                onClick={() => setIsConfirmingReset(true)} 
                                className="px-4 py-2 rounded-lg text-xs font-bold border shadow-sm active:scale-95 bg-red-600 hover:bg-red-700 text-white border-red-700"
                            >
                                Reset Game
                            </button>
                        ) : (
                            <div className="flex items-center gap-2 bg-red-50 border border-red-200 p-2 rounded-lg">
                                <span className="text-xs font-bold text-red-700">Are you sure?</span>
                                <button
                                    onClick={async () => {
                                        try {
                                            await onResetHousieGame();
                                            alert("Housie game has been reset successfully.");
                                            setIsConfirmingReset(false);
                                            onClose();
                                        } catch (error) {
                                            console.error("Failed to reset Housie game:", error);
                                            alert("Failed to reset game. Please check your Firebase Database rules to ensure you have write permissions.");
                                        }
                                    }}
                                    className="px-3 py-1 rounded-md text-xs font-bold border shadow-sm active:scale-95 bg-red-600 hover:bg-red-700 text-white border-red-700"
                                >
                                    Yes, Reset
                                </button>
                                <button
                                    onClick={() => setIsConfirmingReset(false)}
                                    className="px-3 py-1 rounded-md text-xs font-bold border shadow-sm active:scale-95 bg-white hover:bg-gray-100 text-gray-700 border-gray-300"
                                >
                                    Cancel
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div>
                <h3 className="font-bold text-gray-700 mb-2 border-b pb-2">Game Start Time</h3>
                <p className="text-xs text-gray-500 mb-3">Set a time for the game to start automatically. The first number will be called at this time.</p>
                <input 
                    type="datetime-local"
                    value={localScheduledTime}
                    onChange={e => setLocalScheduledTime(e.target.value)}
                    className="w-full p-2 border rounded"
                />
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
                        <div className="flex gap-2 items-center">
                             <input type="text" placeholder="Ticket IDs, e.g., 1, 8" value={bookTicketNumbers} onChange={e => setBookTicketNumbers(e.target.value)} className="w-2/5 p-2 border rounded text-sm" />
                             <input type="text" placeholder="Player Name" value={bookName} onChange={e => setBookName(e.target.value)} className="flex-1 p-2 border rounded text-sm" />
                             <button onClick={handleBookTickets} className="bg-blue-600 text-white font-bold px-4 py-2 rounded-lg text-xs active:scale-95">Book</button>
                        </div>
                     </div>
                     <div className="bg-gray-50 p-3 rounded-lg border space-y-2">
                        <h4 className="text-sm font-bold">Unbook Tickets</h4>
                        <div className="flex gap-2 items-center">
                            <input type="text" placeholder="Ticket IDs or Player's Name" value={unbookTicketNumbers} onChange={e => setUnbookTicketNumbers(e.target.value)} className="w-2/5 p-2 border rounded text-sm" />
                            <input type="text" placeholder="Player's Name" value={unbookName} onChange={e => setUnbookName(e.target.value)} className="flex-1 p-2 border rounded text-sm" />
                            <button onClick={handleUnbookTickets} className="bg-red-600 text-white font-bold px-4 py-2 rounded-lg text-xs active:scale-95">Unbook</button>
                        </div>
                     </div>
                 </div>
            </div>

             <button onClick={handleHousieSave} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-black py-3 rounded-xl shadow-lg active:scale-95 transition-all text-sm uppercase">Save Housie Settings</button>
        </div>
    );

    const renderTPAdmin = () => (
        <div className="space-y-6">
            <div>
                <h3 className="font-bold text-gray-700 mb-2">Player & Table Configuration</h3>
                {[10, 50, 100, 500].map(boot => (
                    <div key={boot} className="mb-4 p-3 bg-gray-100 rounded-lg border">
                        <div className="flex justify-between items-center mb-3 pb-3 border-b">
                            <h4 className="font-bold text-sm text-gray-800">Boot Table: ₹{boot}</h4>
                            <div className="flex items-center gap-3">
                                <div className="flex items-center gap-2">
                                     <label className="text-xs font-bold text-gray-600">Timer (mins):</label>
                                    <input
                                        type="number"
                                        min="0"
                                        value={localTPTableTimers[boot] || 0}
                                        onChange={(e) => setLocalTPTableTimers(prev => ({...prev, [boot]: parseInt(e.target.value) || 0}))}
                                        className="w-16 p-1 text-center font-bold border rounded"
                                        placeholder="0 for unlimited"
                                    />
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className={`text-xs font-bold ${localTPBookedTables[boot] ? 'text-red-500' : 'text-green-500'}`}>
                                        {localTPBookedTables[boot] ? 'BOOKED' : 'AVAILABLE'}
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
                                <button 
                                    onClick={() => onRegenerateTPIds(boot)} 
                                    className="text-xs bg-blue-500 text-white px-2 py-1 rounded hover:bg-blue-600 active:scale-95 transition-all"
                                >
                                    New IDs
                                </button>
                            </div>
                        </div>

                        <div className="grid grid-cols-[auto,1fr,1fr,1fr] gap-x-4 gap-y-2 text-xs font-bold text-gray-500 mb-1 px-2 items-center">
                            <span>Slot</span>
                            <span>Unique ID</span>
                            <span>Player Name</span>
                            <span>Starting Chips</span>
                        </div>
                        {(tpGameIds[boot] || []).map((id, index) => (
                            <div key={id} className="grid grid-cols-[auto,1fr,1fr,1fr] items-center gap-x-4 gap-y-1 mb-1 bg-white p-2 rounded-lg border">
                                <span className="font-bold text-gray-600">{index + 1}.</span>
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
                               <TabButton tab="housie" activeTab={activeTab} onClick={setActiveTab}>Housie</TabButton>
                               <TabButton tab="teenpatti" activeTab={activeTab} onClick={setActiveTab}>Teen Patti</TabButton>
                               <TabButton tab="spades" activeTab={activeTab} onClick={setActiveTab}>Spades</TabButton>
                               <TabButton tab="rummy" activeTab={activeTab} onClick={setActiveTab}>Rummy</TabButton>
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
                            <textarea value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Type your query here. Our support executive team will contact you soon." className="w-full h-40 bg-gray-50 rounded-2xl p-5 text-gray-700 font-bold border-2 border-gray-100 outline-none focus:border-blue-400 transition-all resize-none shadow-inner" />
                            <div className="flex gap-4 mt-8">
                                <button onClick={() => { onClose(); setQuery(''); }} className="flex-1 bg-gray-100 text-gray-500 font-black py-4 rounded-2xl uppercase text-xs active:scale-95 transition-all">Close</button>
                                <button onClick={handleSendSupport} className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-black py-4 rounded-2xl uppercase text-xs shadow-xl active:scale-95 transition-all">Submit</button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </div>, document.body
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
    onLogout,
    centerContent
}: { 
    currentGame: GameCategory, 
    onHome: () => void, 
    onSupport: () => void, 
    onSwitchToggle: () => void, 
    menuOpen: boolean,
    onGameChange: (g: GameCategory) => void,
    onLogout?: () => void,
    centerContent?: ReactNode,
}) => {
    return (
        <header className="relative z-[100] bg-black/40 backdrop-blur-2xl border-b border-white/10 px-4 py-3 flex justify-between items-center h-20 shrink-0 w-full"> 
            <div className="flex items-center gap-4">
                <button onClick={onHome} className="w-12 h-12 flex items-center justify-center bg-white/5 hover:bg-white/10 text-white rounded-2xl border border-white/10 transition-all active:scale-90 shadow-xl" title="Back to Hub">
                    <span className="text-2xl">🏠</span>
                </button>
                <div className="h-8 w-px bg-white/10 hidden md:block"></div>
                <div className="flex flex-col">
                    <h1 className="text-xl font-black text-white tracking-widest uppercase drop-shadow-lg hidden md:block">
                        {gameCategories.find(c => c.key === currentGame)?.label}
                    </h1>
                </div>
            </div>
            
            {centerContent && (
                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50">
                    {centerContent}
                </div>
            )}
            
            <div className="flex items-center gap-2 relative">
                 {onLogout && (
                    <button onClick={onLogout} className="w-8 h-8 flex items-center justify-center bg-red-600/50 hover:bg-red-600 text-white rounded-lg border border-red-400/50 transition-all active:scale-90" title="Logout">
                        <span className="text-lg">🚪</span>
                    </button>
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
};

// Error Boundary
interface ErrorBoundaryProps { children?: ReactNode; }
interface ErrorBoundaryState { hasError: boolean; error: string; }
// FIX: Explicitly extend React.Component to resolve TypeScript errors where `this.setState` and `this.props` were not found.
class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
    public state: ErrorBoundaryState = { hasError: false, error: "" };
    
    static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> { 
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { hasError: true, error: errorMessage };
    }
    
    componentDidCatch(error: Error, errorInfo: ErrorInfo) { 
        console.error("Uncaught error:", error, errorInfo);
        const fullError = `${error.stack || error.message}\n\nComponent Stack:\n${errorInfo.componentStack}`;
        this.setState({ error: fullError });
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="w-screen h-screen bg-red-100 text-red-800 flex flex-col items-center justify-center p-4 z-[9999] relative">
                    <h1 className="text-2xl font-black">Oops! Something went wrong.</h1>
                    <p className="mt-2 text-center">An unexpected error occurred. Please try refreshing the page.</p>
                    <pre className="mt-4 p-4 bg-red-200 rounded-md text-xs w-full max-w-2xl overflow-auto whitespace-pre-wrap">{this.state.error}</pre>
                </div>
            );
        }
        return this.props.children; 
    }
}

const GameHub: FC<{ onSelectGame: (game: GameCategory) => void, isConnected: boolean }> = ({ onSelectGame, isConnected }) => {
    const [currentTime, setCurrentTime] = useState(new Date());

    useEffect(() => {
        const timerId = setInterval(() => setCurrentTime(new Date()), 1000);
        return () => clearInterval(timerId);
    }, []);

    const getGreeting = () => {
        const hour = currentTime.getHours();
        if (hour < 12) return "Good Morning";
        if (hour < 18) return "Good Afternoon";
        return "Good Evening";
    };

    const formattedTime = currentTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    const formattedDate = currentTime.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    return (
        <div className="w-full h-full bg-slate-900 flex flex-col">
            {/* Header */}
            <header 
                className="relative p-4 sm:p-6 bg-slate-800 border-b border-white/10 shadow-lg bg-cover bg-center"
                style={{ backgroundImage: `url('https://www.transparenttextures.com/patterns/dark-denim.png')`}}
            >
                <div className="absolute inset-0 bg-black/30"></div>

                {/* Centered Connection Status */}
                <div className="absolute left-1/2 top-4 -translate-x-1/2 z-10">
                    <div className={`flex items-center gap-2 px-3 py-1 rounded-lg text-xs font-bold border bg-black/30 backdrop-blur-sm ${isConnected ? 'text-green-300 border-green-500/30' : 'text-red-300 border-red-500/30'}`}>
                        <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-400 animate-pulse' : 'bg-red-400'}`}></div>
                        <span className="uppercase tracking-wider">{isConnected ? 'Connected' : 'Offline'}</span>
                    </div>
                </div>

                <div className="relative flex justify-between items-center">
                    <div>
                        <h1 className="text-xl sm:text-2xl font-bold text-white drop-shadow-md">{getGreeting()}</h1>
                        <p className="text-xs sm:text-sm text-slate-300">Welcome to the Game Hub</p>
                    </div>
                    
                    <div className="text-right">
                         <p className="font-bold text-white text-base">{formattedTime}</p>
                         <p className="text-xs text-slate-400">{formattedDate}</p>
                    </div>
                </div>
            </header>

            {/* Body */}
            <main className="flex-1 flex flex-col items-center justify-center p-4 md:p-8 overflow-y-auto">
                 <div className="w-full max-w-6xl grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
                    {gameCategories.map((cat) => (
                        <button
                            key={cat.key}
                            onClick={() => onSelectGame(cat.key)}
                            className={`group relative aspect-square sm:h-64 rounded-2xl sm:rounded-3xl overflow-hidden shadow-2xl transition-all duration-300 hover:scale-105 active:scale-95 border border-white/10`}
                        >
                            <div className={`absolute inset-0 bg-gradient-to-br ${cat.color} opacity-20 group-hover:opacity-100 transition-opacity duration-500`}></div>
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 sm:gap-4 p-4 z-10">
                                <span className="text-4xl sm:text-6xl group-hover:scale-110 transition-transform duration-300 filter drop-shadow-lg">{cat.icon}</span>
                                <span className="text-lg sm:text-2xl font-black text-white uppercase tracking-wider shadow-black drop-shadow-md text-center">{cat.label}</span>
                            </div>
                        </button>
                    ))}
                </div>
            </main>
        </div>
    );
};

// --- Rummy Game ---
const RummyGame: FC = () => <div className="w-full h-full bg-red-800 flex items-center justify-center text-white text-3xl font-black">Rummy - Coming Soon!</div>;
// --- Spades Game ---
const SpadesGame: FC = () => <div className="w-full h-full bg-gray-800 flex items-center justify-center text-white text-3xl font-black">Spades - Coming Soon!</div>;

// --- Housie Game Helpers ---

const CurrentNumberBubble: FC<{ currentNumber: number | null }> = ({ currentNumber }) => {
    if (currentNumber === null) return null;

    return (
        <div key={currentNumber} className="fixed top-24 right-4 z-[150] w-20 h-20 bg-white rounded-full flex flex-col items-center justify-center shadow-2xl border-4 border-red-500 animate-pop">
            <span className="text-4xl font-black text-gray-800 tracking-tight">{currentNumber}</span>
        </div>
    );
};

const HousieBoard: FC<{ calledNumbers: number[], currentNumber: number | null }> = ({ calledNumbers, currentNumber }) => {
    return (
        <div className="rounded-xl shadow-lg overflow-hidden relative">
            <div className="bg-teal-700 text-white p-3 relative z-10">
                 <h2 className="text-sm font-bold uppercase tracking-widest">Master Board (1-90)</h2>
            </div>
            <div className="grid grid-cols-10 gap-1 content-start bg-[#1a4d2e] p-3 border-2 border-t-0 border-[#143d24] rounded-b-xl relative">
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0">
                    <span className="text-[20rem] font-black text-white opacity-5 -rotate-12 select-none">SG</span>
                </div>
                {Array.from({ length: 90 }, (_, i) => i + 1).map(num => {
                    const isCalled = calledNumbers ? calledNumbers.includes(num) : false;
                    const isCurrent = num === currentNumber;
                    return (
                        <div 
                            key={num} 
                            className={`
                                aspect-square flex items-center justify-center rounded text-sm sm:text-base font-black transition-all duration-300 relative z-10
                                ${isCalled ? 'bg-white text-[#1a4d2e] shadow-md scale-100' : 'bg-black/20 text-white/20'}
                                ${isCurrent ? 'ring-2 ring-yellow-400 scale-110 z-20' : ''}
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

const HousieTicket: FC<{ ticket: Ticket, calledNumbers: number[], onBookTicket?: (ticket: Ticket) => void }> = ({ ticket, calledNumbers, onBookTicket }) => {
    const isBooked = ticket.owner !== null;
    // CRITICAL FIX: Ensure ticket.grid exists before rendering to prevent white screen crash
    if (!ticket || !ticket.grid) return null; 

    return (
        <div className="bg-pink-50 rounded-lg shadow-md w-full overflow-hidden mb-4 border-4 border-double border-gray-300">
            <div className="flex justify-between items-center px-3 py-1.5 border-b-2 border-violet-300 bg-violet-200">
                 <span className="font-bold text-violet-800 text-sm">TICKET NO. {ticket.id}</span>
                 {isBooked ? (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded uppercase bg-gray-800 text-white">
                        BOOKED: {ticket.owner}
                    </span>
                 ) : (
                    onBookTicket && <button onClick={() => onBookTicket(ticket)} className="bg-green-500 hover:bg-green-600 text-white font-bold text-xs px-4 py-2 rounded-lg shadow transition-transform active:scale-95">
                        Book Now
                    </button>
                 )}
            </div>
            <div className="p-2">
                <div className="border border-gray-300 rounded overflow-hidden">
                    {ticket.grid.map((row, rIdx) => (
                        <div key={rIdx} className="grid grid-cols-9">
                            {row.map((cell, cIdx) => {
                                const isMarked = cell !== null && Array.isArray(calledNumbers) && calledNumbers.includes(cell);
                                return (
                                    <div
                                        key={cIdx}
                                        className={`
                                            flex items-center justify-center h-8 sm:h-10 text-sm sm:text-base
                                            border-r border-gray-300 last:border-r-0
                                            ${rIdx < 2 ? 'border-b border-gray-300' : ''}
                                            ${isMarked ? 'bg-yellow-300 text-black font-black' : 'text-gray-800 font-bold'}
                                            ${cell === null ? 'bg-pink-100/70' : ''}
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

const HousieGame: FC<{ gameState: GameState | null, onBookTicket: (ticket: Ticket) => void }> = ({ gameState, onBookTicket }) => {
    const [currentTime, setCurrentTime] = useState(new Date());
    const [showAllCalled, setShowAllCalled] = useState(false);
    const [ticketFilter, setTicketFilter] = useState('');
    const audioContextRef = useRef<AudioContext | null>(null);

    useEffect(() => {
        const timer = setInterval(() => setCurrentTime(new Date()), 1000);
        return () => clearInterval(timer);
    }, []);

    // TTS Logic
    useEffect(() => {
        // Initialize AudioContext once
        if (!audioContextRef.current) {
            audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        }
        const audioContext = audioContextRef.current;
        if (!audioContext) return;

        const speakNumber = async (num: number) => {
            const fallbackTTS = () => {
                const nickname = getNickname(num);
                const text = `${nickname}. ${num}`;
                const utterance = new SpeechSynthesisUtterance(text);
                utterance.rate = 1.1;
                window.speechSynthesis.cancel(); 
                window.speechSynthesis.speak(utterance);
            };

            try {
                // Check if API key is configured. If not, fallback to browser's speech synthesis.
                if (!process.env.API_KEY || process.env.API_KEY === 'undefined') {
                    console.warn("Gemini API key not configured. Falling back to browser TTS for announcements.");
                    fallbackTTS();
                    return;
                }

                const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
                const nickname = getNickname(num);
                const textToSpeak = `${nickname}. ${num}`;

                const response = await ai.models.generateContent({
                    model: "gemini-2.5-flash-preview-tts",
                    contents: [{ parts: [{ text: textToSpeak }] }],
                    config: {
                        responseModalities: [Modality.AUDIO],
                        speechConfig: {
                            voiceConfig: {
                                prebuiltVoiceConfig: { voiceName: 'Kore' },
                            },
                        },
                    },
                });
                
                const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

                if (base64Audio) {
                    const audioBuffer = await decodeAudioData(
                        decode(base64Audio),
                        audioContext,
                        24000,
                        1,
                    );
                    const source = audioContext.createBufferSource();
                    source.buffer = audioBuffer;
                    source.connect(audioContext.destination);
                    source.start();
                } else {
                    console.error("No audio data received from TTS API. Falling back.");
                    fallbackTTS();
                }
            } catch (error) {
                console.error("Error with TTS API, falling back to browser TTS:", error);
                fallbackTTS();
            }
        };

        if (gameState?.currentNumber) {
            speakNumber(gameState.currentNumber);
        }
    }, [gameState?.currentNumber]);

    // Auto play logic
    useEffect(() => {
        let interval: any;
        if (gameState?.isAutoPlaying && !gameState.isGameOver) {
            interval = setInterval(() => {
                api.callNumber();
            }, 5000); 
        }
        return () => clearInterval(interval);
    }, [gameState?.isAutoPlaying, gameState?.isGameOver]);
    
    const filteredTickets = useMemo(() => {
        if (!gameState?.extraTickets || !Array.isArray(gameState.extraTickets)) {
            return [];
        }

        const activeTickets = gameState.extraTickets.slice(0, gameState.activeTicketLimit);
        
        const trimmedFilter = ticketFilter.trim();
        if (!trimmedFilter) {
            return activeTickets;
        }

        const isNumericFilter = /^[0-9, ]+$/.test(trimmedFilter);

        if (isNumericFilter) {
            const searchIds = trimmedFilter.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
            if (searchIds.length === 0) return activeTickets;
            return activeTickets.filter(ticket => searchIds.includes(ticket.id));
        } else {
            return activeTickets.filter(ticket => 
                ticket.owner?.toLowerCase().includes(trimmedFilter.toLowerCase())
            );
        }
    }, [gameState, ticketFilter]);

    if (!gameState || !Array.isArray(gameState.calledNumbers) || !Array.isArray(gameState.extraTickets)) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center bg-slate-900 text-white">
                <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <h2 className="text-xl font-black uppercase tracking-widest animate-pulse">Loading Game...</h2>
                <p className="text-sm text-slate-400 mt-2">If this persists, the database may be empty or inaccessible.</p>
            </div>
        );
    }
    
    const displayedCalls = showAllCalled ? gameState.calledNumbers : gameState.calledNumbers.slice(-11);
    const formattedTime = currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const formattedDate = currentTime.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

    return (
        <div className="w-full h-full bg-slate-50 flex flex-col font-sans relative overflow-hidden">
             <CurrentNumberBubble currentNumber={gameState.currentNumber} />
            <div className="bg-[#1e3a8a] text-white px-4 py-2 flex justify-between items-center text-[10px] sm:text-xs font-bold tracking-widest shrink-0 z-50 shadow-md">
                <span className="uppercase text-yellow-400">Official Game Time</span>
                <span>{formattedDate} • {formattedTime}</span>
            </div>

            <div className="flex-1 overflow-y-auto pb-8 custom-scrollbar pt-6">
                
                <div className="text-center px-4 mb-6 space-y-2">
                    <h1 className="text-2xl font-black text-gray-800 uppercase tracking-tight">Welcome to the Game</h1>
                    <p className="text-blue-600 font-bold text-sm mb-2">Live Tambola Experience</p>
                    {gameState.calledNumbers.length > 0 && !gameState.isGameOver && (
                        <div className="flex items-center justify-center gap-2 bg-red-500 text-white font-bold text-xs px-4 py-1 rounded-full mx-auto w-fit">
                            <span className="w-2 h-2 bg-white rounded-full animate-blink"></span>
                            LIVE
                        </div>
                    )}
                </div>

                <div className="px-4 mb-6">
                    <HousieBoard calledNumbers={gameState.calledNumbers} currentNumber={gameState.currentNumber} />
                </div>

                <div className="px-4 mb-6">
                    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
                        <div className="bg-indigo-700 text-white p-3 flex justify-between items-center">
                            <h3 className="text-sm font-black uppercase tracking-widest">Recent Calls</h3>
                            <button onClick={() => setShowAllCalled(!showAllCalled)} className="text-xs bg-white/20 hover:bg-white/30 px-3 py-1 rounded-full font-bold">
                                {showAllCalled ? 'Hide' : `Show All (${gameState.calledNumbers.length})`}
                            </button>
                        </div>
                        <div className="p-3">
                            {displayedCalls.length === 0 ? (
                                <div className="flex min-h-[3rem] items-center justify-center">
                                    <span className="text-gray-400 text-xs italic">Waiting for first number...</span>
                                </div>
                            ) : (
                                <div className={`pb-1 ${showAllCalled ? 'grid grid-cols-11 gap-2' : 'flex items-center gap-2'}`}>
                                    {displayedCalls.map((num, i, arr) => {
                                        const isHighlighted = i === arr.length - 1;
                                        return (
                                            <div key={`${num}-${i}`} className={`
                                                flex-1 aspect-square rounded-full flex items-center justify-center font-black text-xs border shadow-sm transition-all duration-200
                                                ${isHighlighted
                                                    ? 'bg-yellow-400 text-blue-900 border-yellow-500 scale-110'
                                                    : 'bg-gray-100 text-gray-600 border-gray-200'
                                                }
                                            `}>
                                                {num}
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                <div className="px-4">
                    <div className="bg-slate-700 text-white p-3 rounded-t-xl flex justify-between items-center">
                        <h3 className="text-sm font-black uppercase tracking-wide">All Tickets <span className="text-slate-400 text-xs">({filteredTickets.length})</span></h3>
                        <div className="flex gap-2 items-center">
                            <input 
                                type="text" 
                                placeholder="Filter by name or Ticket numbers like 1,3,5" 
                                value={ticketFilter}
                                onChange={e => setTicketFilter(e.target.value)}
                                className="text-xs p-1.5 rounded border border-slate-500 bg-slate-600 text-white placeholder-slate-400 w-36 focus:w-48 transition-all outline-none" 
                            />
                            {ticketFilter && (
                                <button onClick={() => setTicketFilter('')} className="text-xs bg-slate-500 hover:bg-slate-400 px-2 py-1 rounded">Clear</button>
                            )}
                        </div>
                    </div>
                    
                    <div className="space-y-3 pt-3 bg-white rounded-b-xl shadow-sm border border-gray-200 p-2">
                        {filteredTickets.map(ticket => (
                            <HousieTicket key={ticket.id} ticket={ticket} calledNumbers={gameState.calledNumbers} onBookTicket={onBookTicket} />
                        ))}
                    </div>
                </div>

                <div className="px-4 mt-6">
                    <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
                        <div className="bg-amber-600 text-white p-4 text-center rounded-t-xl">
                            <h3 className="text-lg font-black uppercase tracking-wide">Winners Board</h3>
                        </div>
                        <div className="space-y-2 p-4">
                            {WINNING_PATTERNS
                                .filter(p => (gameState.prizesConfig?.[p.key]?.count ?? 1) > 0)
                                .map(pattern => {
                                    const winners = gameState.winners?.[pattern.key] || [];
                                    const prizeLimit = gameState.prizesConfig?.[pattern.key]?.count || 1;
                                    const isClosed = winners.length >= prizeLimit;

                                    return (
                                        <div key={pattern.key} className={`
                                            rounded-lg p-3 flex justify-between items-center shadow-sm border transition-all
                                            ${isClosed ? 'bg-green-50 border-green-200' : 'bg-gray-50 border-gray-200'}
                                        `}>
                                            <div className="flex flex-col flex-1 min-w-0 mr-2">
                                                <span className="text-xs font-bold text-gray-800 uppercase">{pattern.label}</span>
                                                {winners.length > 0 && 
                                                    <span className="text-[10px] text-green-700 font-semibold truncate">
                                                        Won by: {winners.map(w => `TICKET NO. ${w.id}`).join(', ')}
                                                    </span>
                                                }
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className={`text-xs font-black px-2 py-1 rounded-full ${isClosed ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                                                    {winners.length}/{prizeLimit}
                                                </span>
                                            </div>
                                        </div>
                                    );
                            })}
                        </div>
                    </div>
                </div>
            </div>
             <footer className="sticky bottom-0 bg-gray-800 text-white text-center p-2 text-sm font-bold z-10 shrink-0">
                🎉 Good Luck to all Players! 🎉
            </footer>
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
    const avatarSize = isMainPlayer ? 64 : 64; // Smaller profile for all
    
    const NameTag = (
        <div className="bg-black/50 rounded-lg px-2 py-1 text-center shadow-lg relative min-w-[80px]">
            <p className="font-bold text-xs text-white truncate max-w-[100px]">{player.name}</p>
            <p className="text-[10px] text-yellow-400">₹{player.chips}</p>
        </div>
    );

    const Avatar = (
        <div className="relative">
            {isActive && (
                <CircularTimer 
                    timeLeft={turnTimeLeft} 
                    maxTime={turnDuration} 
                    size={avatarSize + 12} // Ring slightly larger than avatar
                    strokeWidth={4} 
                />
            )}
            <div className={`rounded-full border-4 bg-gray-900 overflow-hidden shadow-2xl transition-all duration-300 relative z-10 ${isMainPlayer ? 'w-16 h-16' : 'w-16 h-16'} ${isActive ? 'border-yellow-400 scale-105' : 'border-gray-600'}`}>
                <img src={`https://api.dicebear.com/9.x/avataaars/svg?seed=${player.avatarSeed}`} alt="avatar" className="w-full h-full object-cover" />
            </div>
            
            {isFolded ? <PackedStamp /> : player.status === 'playing' && !player.isFolded && player.cards && (
                <div className={`absolute -bottom-2 left-1/2 -translate-x-1/2 text-white text-[10px] font-black px-2 py-0.5 rounded-full shadow-md uppercase whitespace-nowrap z-20 ${isSideShowInitiator ? 'bg-purple-600 animate-pulse ring-2 ring-purple-400' : 'bg-blue-600'}`}>
                    {isSideShowInitiator ? 'SIDE SHOW' : (player.isSeen ? 'SEEN' : 'BLIND')}
                </div>
            )}
        </div>
    );

    // Opponent cards with wider fanning
    const OpponentCards = player.cards ? (
         <div className="relative h-20 w-32 mt-2">
            {player.cards.map((card, i) => (
                <div key={card.id} className="absolute bottom-0 left-1/2 origin-bottom transition-transform duration-300" style={{
                    // Wider spread for opponents
                    transform: `translateX(calc(-50% + ${(i - 1) * 20}px)) rotate(${(i - 1) * 25}deg)`,
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
    ) : null;
    
    // Main player cards are rendered separately in the main component
    const MainPlayerPlaceHolder = null;

    return (
        <div className={`flex flex-col items-center gap-1 relative transition-all duration-300 ${isFolded ? 'opacity-50 grayscale' : ''}`}>
            {position === 'bottom' ? (<>{MainPlayerPlaceHolder}{Avatar}{NameTag}</>) : (<>{NameTag}{Avatar}{OpponentCards}</>)}
        </div>
    );
};

const GameOverModal: FC<{players: Player[], winner: Player | null, handName: string, onAdminReset: () => void, isDemo: boolean, isSessionExpired: boolean, onViewDashboard: () => void}> = ({ players, winner, handName, onAdminReset, isDemo, isSessionExpired, onViewDashboard }) => {
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
                
                {isDemo || !isSessionExpired ? (
                    <div className="mt-8">
                        <button onClick={onAdminReset} className="bg-green-600 hover:bg-green-700 text-white font-black py-3 px-8 rounded-lg shadow-lg active:scale-95 transition-all text-sm uppercase">
                            Play Again
                        </button>
                    </div>
                ) : (
                    <div className="mt-8 border-t pt-6">
                         <button
                            className="w-full bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-3 rounded-lg shadow-sm transition-all active:scale-95 mb-4"
                            onClick={onViewDashboard}
                        >
                            View my Dashboard
                        </button>
                        <p className="text-sm font-bold text-red-600 text-center mb-2 uppercase tracking-widest">Table Time Expired</p>
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

// Moved from inside SideShowComparisonModal to prevent re-creation on every render
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


// --- Side Show Modals ---
const SideShowRequestModal: FC<{
    initiatorName: string, 
    betAmount: number, 
    onAccept: () => void, 
    onDeny: () => void 
}> = ({ initiatorName, betAmount, onAccept, onDeny }) => {
    const [countdown, setCountdown] = useState(10);

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
    gamePhase: 'id_entry' | 'lobby' | 'betting' | 'showdown';
    currentPlayerIndex: number;
    isGameOver: boolean;
    winnerInfo: { winner: Player | null, handName: string };
    localPlayerUniqueId: string | null;
    onJoin: (uid: string, bootAmount: number) => void;
    onPlayerAction: (action: 'see' | 'chaal' | 'fold' | 'sideShow' | 'show' | 'deal', localPlayerId?: string) => void;
    onPlayAgain: () => void;
    onAdminReset: () => void;
    showdownReveal: boolean;
    isMultiplayer: boolean;
    
    // Side Show specific props
    sideShowRequest: { initiatorId: number, targetId: number, amount: number } | null;
    sideShowResult: { initiator: Player, target: Player, winner: Player, loser: Player } | null;
    onSideShowResponse: (accepted: boolean, localPlayerId?: string) => void;
    onCloseSideShowResult: () => void;
    turnTimeLeft: number;
    turnDuration: number;
    isSessionExpired: boolean;
    onViewDashboard: () => void;
}

const TeenPattiGame: FC<TeenPattiGameProps> = ({ 
    players, pot, bootAmount, gamePhase, currentPlayerIndex, isGameOver, winnerInfo, localPlayerUniqueId,
    onJoin, onPlayerAction, onPlayAgain, onAdminReset, showdownReveal, isMultiplayer,
    sideShowRequest, sideShowResult, onSideShowResponse, onCloseSideShowResult,
    turnTimeLeft, turnDuration, isSessionExpired, onViewDashboard
}) => {
    
    const [joinId, setJoinId] = useState('');
    const [selectedBoot, setSelectedBoot] = useState(10);
    const [isGameOverDelayed, setIsGameOverDelayed] = useState(false);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout>;
        // If the game is over and there is no side show result modal active,
        // then start the 5-second timer to show the game over modal.
        if (isGameOver && !sideShowResult) {
            timer = setTimeout(() => {
                setIsGameOverDelayed(true);
            }, 5000);
        } else {
            // If a new game starts or a side show modal is active, ensure the delayed state is false.
            setIsGameOverDelayed(false);
        }
        return () => clearTimeout(timer);
    }, [isGameOver, sideShowResult]); // Add sideShowResult to the dependency array

    const displayPlayers = useMemo(() => {
        if (!localPlayerUniqueId || players.length < 1) return players;

        const localPlayerIndex = players.findIndex(p => p.uniqueId === localPlayerUniqueId);
        if (localPlayerIndex === -1) {
             const lobbyPlayer = players.find(p => p.uniqueId === localPlayerUniqueId);
             if (lobbyPlayer) {
                 return [lobbyPlayer, ...players.filter(p => p.uniqueId !== localPlayerUniqueId)];
             }
             return players;
        }

        const reordered = [];
        for (let i = 0; i < players.length; i++) {
            reordered.push(players[(localPlayerIndex + i) % players.length]);
        }
        return reordered;
    }, [players, localPlayerUniqueId]);

    const mainPlayer = displayPlayers.find(p => p.uniqueId === localPlayerUniqueId);
    const opponents = displayPlayers.filter(p => p.uniqueId !== mainPlayer?.uniqueId);

    const getOpponentPosition = (player: Player) => {
        const mainPlayerIndex = players.findIndex(p => p.uniqueId === localPlayerUniqueId);
        if (mainPlayerIndex === -1 || players.length <= 1) return { style: 'top-8 left-1/2 -translate-x-1/2', position: 'top' as 'top' };
    
        const playerIndex = players.findIndex(p => p.uniqueId === player.uniqueId);
    
        const diff = (playerIndex - mainPlayerIndex + players.length) % players.length;
    
        if (players.length === 2) {
             return { style: 'top-8 left-1/2 -translate-x-1/2', position: 'top' as 'top' };
        }
        if (players.length === 3) {
            if (diff === 1) return { style: 'left-2 top-1/2 -translate-y-1/2', position: 'left' as 'left' };
            if (diff === 2) return { style: 'right-2 top-1/2 -translate-y-1/2', position: 'right' as 'right' };
        }
        if (players.length === 4) {
            if (diff === 1) return { style: 'left-2 top-1/2 -translate-y-1/2', position: 'left' as 'left' };
            if (diff === 2) return { style: 'top-8 left-1/2 -translate-x-1/2', position: 'top' as 'top' };
            if (diff === 3) return { style: 'right-2 top-1/2 -translate-y-1/2', position: 'right' as 'right' };
        }
        
        return { style: '', position: 'top' as 'top' }; // Fallback
    };
    
    const isMyTurn = mainPlayer && players[currentPlayerIndex]?.id === mainPlayer.id;
    const showRequestModal = sideShowRequest && mainPlayer && sideShowRequest.targetId === mainPlayer.id;
    const initiatorName = showRequestModal ? players.find(p => p.id === sideShowRequest!.initiatorId)?.name || 'Player' : '';
    const isWaitingForSideShowResponse = sideShowRequest && mainPlayer?.id === sideShowRequest.initiatorId;
    const activePlayersCount = players.filter(p => !p.isFolded).length;
    const chaalAmount = mainPlayer?.isSeen ? bootAmount * 2 : bootAmount;
    const actionAmount = chaalAmount * 2;

    if (gamePhase === 'id_entry') {
        return (
             <div className="w-full h-full tp-background-gradient flex flex-col items-center justify-center text-white p-8">
                 <h2 className="text-4xl font-black uppercase mb-4 tracking-wider text-yellow-400 drop-shadow-lg">Teen Patti</h2>
                 <p className="text-lg text-gray-300 mb-8 font-semibold">Join a game or play a demo.</p>

                 <div className="flex flex-col gap-4 items-center w-full max-w-sm">
                    <button 
                        onClick={() => onJoin(`GUEST_${Math.floor(1000 + Math.random() * 9000)}`, 10)}
                        className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold text-lg uppercase py-4 px-10 rounded-lg shadow-lg active:scale-95 transition-all flex items-center justify-center gap-2"
                    >
                        <span>🎮</span> Play Demo
                    </button>
                    
                    <div className="w-full border-t border-white/10 my-4 text-center text-gray-400 font-bold">OR</div>
                    
                    <div className="flex flex-col sm:flex-row gap-4 items-center w-full max-w-md mx-auto">
                         <select 
                            value={selectedBoot}
                            onChange={e => setSelectedBoot(Number(e.target.value))}
                            className="w-full sm:w-auto bg-black/20 border-2 border-dashed border-white/30 rounded-lg px-3 py-3 text-white font-bold focus:border-yellow-400 outline-none transition-colors"
                        >
                            <option value={10}>Boot ₹10</option>
                            <option value={50}>Boot ₹50</option>
                            <option value={100}>Boot ₹100</option>
                            <option value={500}>Boot ₹500</option>
                        </select>
                        <input 
                            value={joinId}
                            onChange={e => setJoinId(e.target.value.toUpperCase())}
                            maxLength={12}
                            placeholder="UNIQUE ID"
                            className="w-full sm:flex-1 bg-black/20 border-2 border-dashed border-white/30 rounded-lg px-3 py-3 text-white placeholder-gray-500 text-center font-mono text-lg tracking-widest uppercase slashed-zero focus:border-yellow-400 outline-none transition-colors"
                        />
                        <button onClick={() => onJoin(joinId, selectedBoot)} disabled={!joinId.trim()} className="w-full sm:w-auto bg-yellow-500 hover:bg-yellow-400 text-black font-bold px-8 py-3 rounded-lg text-base disabled:bg-gray-500 disabled:cursor-not-allowed shadow-lg active:scale-95 transition-all">
                            PLAY
                        </button>
                    </div>
                 </div>
            </div>
        );
    }
    
    return (
        <div className="w-full h-full tp-background-gradient flex items-center justify-center text-white relative overflow-hidden">
            {isGameOverDelayed && (
                <GameOverModal 
                    players={players} 
                    winner={winnerInfo.winner} 
                    handName={winnerInfo.handName} 
                    onAdminReset={isMultiplayer ? onPlayAgain : onAdminReset}
                    isDemo={!isMultiplayer}
                    isSessionExpired={isSessionExpired}
                    onViewDashboard={onViewDashboard}
                />
            )}
            
            {showRequestModal && (
                <SideShowRequestModal 
                    initiatorName={initiatorName} 
                    betAmount={sideShowRequest!.amount} 
                    onAccept={() => onSideShowResponse(true, localPlayerUniqueId!)} 
                    onDeny={() => onSideShowResponse(false, localPlayerUniqueId!)} 
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
                                {players.length < 4 ? 'Waiting for players...' : 'Table Full'}
                            </p>
                            <p className="text-white text-3xl font-black mt-1">
                                {players.length}/4
                            </p>
                        </>
                    ) : (
                        <>
                            <p className="text-yellow-400 text-xs font-bold uppercase tracking-widest">Current Pot</p>
                            <p className="text-5xl font-black text-white">₹{pot}</p>
                            <p className="text-gray-400 text-xs mt-1">Boot: ₹{bootAmount}</p>
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
                    {/* Main player cards moved further left */}
                    <div className="absolute bottom-4 left-0 pl-2 flex flex-col items-center gap-2">
                        {mainPlayer.cards && mainPlayer.cards.length > 0 && (
                            <div className="relative w-80 h-56 -mt-16">
                                {mainPlayer.cards.map((card, i) => (
                                    <div key={card.id} className="absolute bottom-0 left-1/2 origin-bottom transition-transform duration-300" style={{ transform: `translateX(-50%) rotate(${(i - 1) * 20}deg) translateY(-10%)`, zIndex: i }}>
                                        <PlayingCard card={card} faceUp={(showdownReveal && !mainPlayer.isFolded) || (!showdownReveal && mainPlayer.isSeen)} size="xl" className="shadow-2xl" />
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
            
                    {/* Action buttons and profile made smaller and adjusted position */}
                    <div className="absolute bottom-4 right-2 flex flex-col items-end gap-2">
                        <div className={`flex items-center gap-2 transition-all duration-300 ${mainPlayer.isFolded ? 'opacity-50 grayscale' : ''}`}>
                            <div className="bg-black/50 rounded-lg px-3 py-1 text-right shadow-lg">
                                <p className="font-bold text-sm text-white">{mainPlayer.name}</p>
                                <p className="text-xs text-yellow-400">₹{mainPlayer.chips}</p>
                            </div>
                            <div className="relative">
                                {/* Main Player Avatar with Timer */}
                                {isMyTurn && gamePhase === 'betting' && (
                                    <CircularTimer 
                                        timeLeft={turnTimeLeft} 
                                        maxTime={turnDuration} 
                                        size={72} // Adjusted size
                                        strokeWidth={4} 
                                    />
                                )}
                                <div className={`w-16 h-16 rounded-full border-4 bg-gray-900 overflow-hidden shadow-2xl transition-all duration-300 relative z-10 ${isMyTurn && gamePhase === 'betting' ? 'border-yellow-400 scale-105' : 'border-gray-600'}`}>
                                    <img src={`https://api.dicebear.com/9.x/avataaars/svg?seed=${mainPlayer.avatarSeed}`} alt="avatar" className="w-full h-full object-cover" />
                                </div>
                                
                                {mainPlayer.isFolded ? (
                                    <PackedStamp />
                                ) : (mainPlayer.status === 'playing' && mainPlayer.cards &&
                                    <div className={`absolute -bottom-2 left-1/2 -translate-x-1/2 text-white text-[10px] font-black px-2 py-0.5 rounded-full shadow-md uppercase whitespace-nowrap z-20 ${isWaitingForSideShowResponse ? 'bg-purple-600 animate-pulse ring-2 ring-purple-400' : 'bg-blue-600'}`}>
                                        {isWaitingForSideShowResponse ? 'SIDE SHOW' : (mainPlayer.isSeen ? 'SEEN' : 'BLIND')}
                                    </div>
                                )}
                            </div>
                        </div>
                        {gamePhase === 'betting' && !mainPlayer.isFolded && (
                            isWaitingForSideShowResponse ? (
                                <div className="bg-black/30 backdrop-blur-sm border border-white/10 p-2 rounded-2xl shadow-lg h-24 flex items-center justify-center w-64">
                                    <p className="text-yellow-400 font-bold animate-pulse text-sm">Waiting for response...</p>
                                </div>
                            ) : (
                                <div className={`bg-black/30 backdrop-blur-sm border border-white/10 p-2 rounded-2xl flex items-end justify-center gap-2 shadow-lg transition-all duration-300 ${!isMyTurn ? 'grayscale opacity-60' : ''}`}>
                                    <button onClick={() => onPlayerAction('fold', localPlayerUniqueId!)} disabled={!isMyTurn} className="w-12 h-12 bg-red-600 rounded-full flex items-center justify-center font-black text-xs uppercase shadow-lg transition-transform active:scale-95 disabled:cursor-not-allowed">Pack</button>
                                    {!mainPlayer.isSeen && <button onClick={() => onPlayerAction('see', localPlayerUniqueId!)} disabled={!isMyTurn} className="w-12 h-12 bg-yellow-500 rounded-full flex items-center justify-center font-black text-xs uppercase shadow-lg transition-transform active:scale-95 disabled:cursor-not-allowed">See</button>}
                                    
                                    {mainPlayer.isSeen && activePlayersCount > 2 &&
                                        <button onClick={() => onPlayerAction('sideShow', localPlayerUniqueId!)} disabled={!isMyTurn} className="w-12 h-12 bg-purple-600 rounded-full flex flex-col items-center justify-center font-black text-[10px] uppercase shadow-lg transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-gray-500">
                                            Side Show
                                            <span className="text-[9px]">₹{actionAmount}</span>
                                        </button>
                                    }
                                    
                                    {activePlayersCount === 2 &&
                                        <button onClick={() => onPlayerAction('show', localPlayerUniqueId!)} disabled={!isMyTurn} className="w-12 h-12 bg-blue-600 rounded-full flex flex-col items-center justify-center font-black text-[10px] uppercase shadow-lg transition-transform active:scale-95 disabled:cursor-not-allowed disabled:bg-gray-500">
                                            Show
                                            <span className="text-[9px]">₹{actionAmount}</span>
                                        </button>
                                    }

                                    <button onClick={() => onPlayerAction('chaal', localPlayerUniqueId!)} disabled={!isMyTurn} className="w-16 h-16 bg-green-600 rounded-full flex flex-col items-center justify-center font-black text-sm uppercase shadow-lg transition-transform active:scale-95 disabled:cursor-not-allowed">
                                        {mainPlayer.isSeen ? 'Chaal' : 'Blind'}
                                        <span className="text-xs">₹{chaalAmount}</span>
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

// --- Housie Ticket Status Modal ---
const AvailableTicketsModal: FC<{
    isOpen: boolean;
    onClose: () => void;
    gameState: GameState | null;
}> = ({ isOpen, onClose, gameState }) => {
    const [selectedTicketIds, setSelectedTicketIds] = useState<number[]>([]);
    const [bookingName, setBookingName] = useState('');

    useEffect(() => {
        // Reset state when modal opens/closes
        if (!isOpen) {
            setSelectedTicketIds([]);
            setBookingName('');
        }
    }, [isOpen]);

    if (!isOpen || !gameState) return null;

    const activeTickets = gameState.extraTickets.slice(0, gameState.activeTicketLimit);
    const isGameStarted = gameState.calledNumbers.length > 0;

    const handleTicketClick = (ticketId: number) => {
        if (isGameStarted) return;
        
        const ticket = activeTickets.find(t => t.id === ticketId);
        if (ticket && ticket.owner === null) {
            setSelectedTicketIds(prev =>
                prev.includes(ticketId)
                    ? prev.filter(id => id !== ticketId)
                    : [...prev, ticketId]
            );
        }
    };

    const handleBookOnWhatsApp = () => {
        if (!bookingName.trim() || selectedTicketIds.length === 0) return;
        
        const ticketNumbers = selectedTicketIds.join(', ');
        const text = `Hi, I'd like to book Housie ticket(s): ${ticketNumbers} for the name: ${bookingName}.`;
        
        window.open(`https://wa.me/${SUPPORT_PHONE}?text=${encodeURIComponent(text)}`, '_blank');
        onClose();
    };

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-pop">
            <div className="bg-slate-50 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden border-2 border-white/10">
                <div className="p-6 border-b border-slate-200 flex justify-between items-center">
                    <h2 className="text-xl font-bold text-blue-800">Select Available Tickets</h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-slate-700 transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
                <div className="p-6 space-y-6">
                    {isGameStarted && (
                        <div className="bg-red-100 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm font-semibold text-center">
                            You cannot book tickets now. Please wait for the next round.
                        </div>
                    )}
                     <div className="flex items-center justify-center gap-4 text-xs font-bold uppercase tracking-wider text-slate-600 pb-2 border-b">
                        <div className="flex items-center gap-2"><div className="w-4 h-4 bg-green-500 rounded-sm border border-green-600"></div><span>Available</span></div>
                        <div className="flex items-center gap-2"><div className="w-4 h-4 bg-red-500 rounded-sm border border-red-600"></div><span>Booked</span></div>
                        <div className="flex items-center gap-2"><div className="w-4 h-4 bg-blue-500 rounded-sm border border-blue-600"></div><span>Selected</span></div>
                    </div>
                    <div className="grid grid-cols-5 sm:grid-cols-8 lg:grid-cols-10 gap-2 max-h-[50vh] overflow-y-auto custom-scrollbar p-2 bg-slate-100 rounded-lg border">
                        {activeTickets.map(ticket => {
                            const isBooked = ticket.owner !== null;
                            const isSelected = selectedTicketIds.includes(ticket.id);

                            let buttonClass = 'bg-green-500 border-green-700 text-white'; // Available
                            if (isBooked) buttonClass = 'bg-red-500 border-red-700 text-white cursor-not-allowed';
                            else if (isSelected) buttonClass = 'bg-blue-500 border-blue-700 text-white ring-2 ring-offset-1 ring-blue-500';
                            else if (!isGameStarted) buttonClass += ' hover:bg-green-600';

                            if(isGameStarted && !isBooked) buttonClass = 'bg-green-200 border-green-300 text-green-600 cursor-not-allowed';
                            
                            return (
                                <button
                                    key={ticket.id}
                                    onClick={() => handleTicketClick(ticket.id)}
                                    disabled={isBooked || isGameStarted}
                                    title={isBooked ? `Booked by: ${ticket.owner}` : isSelected ? 'Selected' : 'Available'}
                                    className={`
                                        aspect-square flex flex-col items-center justify-center rounded-md font-black
                                        border shadow-sm transition-all duration-200 p-1 text-center
                                        ${buttonClass}
                                    `}
                                >
                                    <span className="text-base">{ticket.id}</span>
                                     {isBooked && (
                                        <span className="text-[8px] leading-tight font-semibold truncate w-full text-center text-red-100 mt-0.5">
                                            {ticket.owner}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                     <div className="space-y-4 pt-4 border-t">
                        <div>
                            <label className="text-xs font-semibold text-slate-500 uppercase">Your Name</label>
                            <input
                                type="text"
                                value={bookingName}
                                onChange={e => setBookingName(e.target.value)}
                                placeholder="Enter Name for Booking"
                                disabled={isGameStarted}
                                className="w-full mt-1 p-3 bg-white border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition disabled:bg-slate-200 disabled:cursor-not-allowed"
                            />
                        </div>
                        <div className="flex justify-between items-center">
                            <p className="text-sm font-bold text-slate-700">Selected: {selectedTicketIds.length}</p>
                            <button
                                onClick={handleBookOnWhatsApp}
                                disabled={isGameStarted || !bookingName.trim() || selectedTicketIds.length === 0}
                                className="bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-6 rounded-lg shadow-lg transition-all active:scale-95 disabled:bg-slate-300 disabled:cursor-not-allowed"
                            >
                                Book on WhatsApp
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>,
        document.body
    );
};

const SingleTicketBookingModal: FC<{
    ticket: Ticket | null;
    onClose: () => void;
}> = ({ ticket, onClose }) => {
    const [name, setName] = useState('');

    useEffect(() => {
        if (ticket) {
            setName(''); // Reset name when a new ticket is selected
        }
    }, [ticket]);

    if (!ticket) return null;

    const handleBook = () => {
        if (!name.trim()) {
            alert('Please enter a name.');
            return;
        }
        const text = `Hi, I'd like to book Housie ticket number: ${ticket.id} for the name: ${name}.`;
        window.open(`https://wa.me/${SUPPORT_PHONE}?text=${encodeURIComponent(text)}`, '_blank');
        onClose();
    };

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-pop">
            <div className="bg-white rounded-2xl w-full max-w-sm shadow-2xl overflow-hidden">
                <div className="p-6 border-b">
                    <h2 className="text-xl font-bold text-blue-800">Book Ticket No. {ticket.id}</h2>
                </div>
                <div className="p-6 space-y-4">
                    <div>
                        <label htmlFor="booking-name" className="text-sm font-semibold text-slate-600">Enter Your Name</label>
                        <input
                            id="booking-name"
                            type="text"
                            value={name}
                            onChange={e => setName(e.target.value)}
                            placeholder="Enter Name for Booking"
                            className="w-full mt-2 p-3 bg-slate-50 border border-slate-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none transition"
                        />
                    </div>
                    <div className="flex gap-4 pt-2">
                        <button
                            onClick={onClose}
                            className="flex-1 bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold py-3 rounded-lg transition-all active:scale-95"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleBook}
                            disabled={!name.trim()}
                            className="flex-1 bg-green-500 hover:bg-green-600 text-white font-bold py-3 rounded-lg shadow-lg transition-all active:scale-95 disabled:bg-slate-300 disabled:cursor-not-allowed"
                        >
                            Book Now
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body
    );
};

const ViewTicketModal: FC<{
    isOpen: boolean;
    onClose: () => void;
    ticket: Ticket | null;
    calledNumbers: number[] | null;
}> = ({ isOpen, onClose, ticket, calledNumbers }) => {
    if (!isOpen || !ticket || !calledNumbers) return null;

    return createPortal(
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-pop">
            <div className="bg-slate-100 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden relative p-4">
                 <button onClick={onClose} className="absolute top-2 right-2 text-slate-400 hover:text-slate-700 transition-colors z-10">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
                <HousieTicket ticket={ticket} calledNumbers={calledNumbers} />
            </div>
        </div>, document.body
    );
};

const HousieGameOverModal: FC<{
    isOpen: boolean;
    onClose: () => void;
    gameState: GameState | null;
    onViewTicket: (ticket: Ticket) => void;
    onResetRequest: () => void;
}> = ({ isOpen, onClose, gameState, onViewTicket, onResetRequest }) => {
    const [password, setPassword] = useState('');

    if (!isOpen || !gameState) return null;

    const handleReset = () => {
        if(password === (process.env.RESET_PASSWORD || 'admin')) {
            onResetRequest();
            setPassword('');
        } else {
            alert('Incorrect password!');
        }
    };

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
            <div className="bg-white rounded-[2.5rem] w-full max-w-lg text-center overflow-hidden shadow-2xl animate-pop border-8 border-white/10 p-8 relative">
                <h2 className="text-4xl font-black text-gray-800">Game Over!</h2>
                <p className="text-lg text-gray-600 mt-2">Congratulations to all the winners!</p>

                <div className="mt-6 w-full text-left max-h-60 overflow-y-auto custom-scrollbar pr-2">
                    <h3 className="font-bold text-gray-700 mb-2 text-center uppercase tracking-wider">Winners Board</h3>
                    <ul className="space-y-2">
                        {WINNING_PATTERNS
                            .filter(p => (gameState.prizesConfig?.[p.key]?.count ?? 0) > 0)
                            .map(pattern => {
                                const winners = gameState.winners?.[pattern.key] || [];
                                return (
                                    <li key={pattern.key} className="bg-gray-50 p-3 rounded-lg border">
                                        <p className="font-bold text-sm text-blue-700">{pattern.label}</p>
                                        {winners.length > 0 ? (
                                            winners.map(w => (
                                                <div key={w.id} className="text-xs text-gray-600 flex justify-between items-center mt-1">
                                                    <span>Winner: <span className="font-semibold">{w.owner}</span> (Ticket #{w.id})</span>
                                                    <button onClick={() => onViewTicket(w)} className="text-blue-500 hover:underline text-[10px] font-bold">View</button>
                                                </div>
                                            ))
                                        ) : (
                                            <p className="text-xs text-gray-400 italic">No winner for this prize.</p>
                                        )}
                                    </li>
                                )
                        })}
                    </ul>
                </div>

                <div className="mt-8 border-t pt-6">
                    <button
                        className="w-full bg-gray-200 hover:bg-gray-300 text-gray-800 font-bold py-3 rounded-lg shadow-sm transition-all active:scale-95 mb-4"
                        onClick={onClose}
                    >
                        View my Dashboard
                    </button>
                    <div className="flex gap-2 justify-center">
                        <input
                            type="password"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            placeholder="Admin Password to Reset"
                            className="flex-1 bg-gray-100 text-gray-800 placeholder-gray-400 rounded-lg px-4 py-2 border-2 border-gray-300 outline-none focus:border-blue-500 transition-all shadow-inner"
                        />
                        <button
                            onClick={handleReset}
                            disabled={!password}
                            className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-6 rounded-lg shadow-lg transition-all active:scale-95 disabled:bg-gray-400 disabled:cursor-not-allowed"
                        >
                            Reset Game
                        </button>
                    </div>
                </div>
            </div>
        </div>, document.body
    );
};

const TPAvailableTablesModal: FC<{
    isOpen: boolean;
    onClose: () => void;
    bootAmounts: number[];
    bookedTables: Record<number, boolean>;
    playerConfigs: AllPlayerConfigs;
    gameIds: Record<number, string[]>;
}> = ({ isOpen, onClose, bootAmounts, bookedTables, playerConfigs, gameIds }) => {
    const [selectedSlots, setSelectedSlots] = useState<{ boot: number; id: string }[]>([]);
    const [bookingName, setBookingName] = useState('');

    useEffect(() => {
        if (isOpen) {
            setSelectedSlots([]);
            setBookingName('');
        }
    }, [isOpen]);

    const handleSlotClick = (boot: number, id: string) => {
        setSelectedSlots(prev => {
            const isSelected = prev.some(s => s.id === id);
            if (isSelected) {
                return prev.filter(s => s.id !== id);
            } else {
                return [...prev, { boot, id }];
            }
        });
    };

    const handleBookOnWhatsApp = () => {
        if (!bookingName.trim() || selectedSlots.length === 0) {
            alert('Please enter your name and select at least one slot.');
            return;
        }

        const groupedByBoot = selectedSlots.reduce((acc, slot) => {
            if (!acc[slot.boot]) {
                acc[slot.boot] = [];
            }
            acc[slot.boot].push(slot.id);
            return acc;
        }, {} as Record<number, string[]>);

        let message = `Hi, I'd like to book Teen Patti slot(s) for the name: ${bookingName}.\n\n`;
        for (const boot in groupedByBoot) {
            message += `Boot ₹${boot} Table - Slot IDs: ${groupedByBoot[boot].join(', ')}\n`;
        }

        window.open(`https://wa.me/${SUPPORT_PHONE}?text=${encodeURIComponent(message)}`, '_blank');
        onClose();
    };


    if (!isOpen) return null;

    return createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-pop">
            <div className="bg-slate-900 border-2 border-yellow-400 rounded-2xl w-full max-w-4xl shadow-2xl flex flex-col">
                <div className="p-4 border-b border-slate-700 flex justify-between items-center">
                    <h2 className="text-2xl font-bold text-yellow-400">Available Tables</h2>
                    <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>
                <div className="p-6 space-y-4">
                     <div className="flex items-center justify-center gap-4 text-xs font-bold uppercase tracking-wider text-slate-400 pb-2 border-b border-slate-700">
                        <div className="flex items-center gap-2"><div className="w-4 h-4 bg-green-500/50 rounded-sm border border-green-500"></div><span>Available</span></div>
                        <div className="flex items-center gap-2"><div className="w-4 h-4 bg-red-500/50 rounded-sm border border-red-500"></div><span>Booked</span></div>
                        <div className="flex items-center gap-2"><div className="w-4 h-4 bg-blue-500/50 rounded-sm border border-blue-500"></div><span>Selected</span></div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-h-[60vh] overflow-y-auto custom-scrollbar pr-2">
                        {bootAmounts.map(boot => {
                            const isTableBooked = bookedTables[boot];
                            const tableGameIds = gameIds[boot] || [];
                            const tablePlayerConfigs = playerConfigs[boot] || {};

                            return (
                                <div key={boot} className={`bg-black/20 rounded-xl border border-white/10 p-4 transition-opacity ${isTableBooked ? 'opacity-50' : ''}`}>
                                    <h3 className="font-bold text-white text-lg border-b border-white/10 pb-2 mb-3">Boot: <span className="text-yellow-400">₹{boot}</span></h3>
                                    {isTableBooked ? (
                                        <div className="text-center text-red-500 font-bold py-8 uppercase">Table Booked</div>
                                    ) : (
                                        <div className="space-y-2">
                                            {Array.from({ length: 4 }).map((_, i) => {
                                                const gameId = tableGameIds[i];
                                                const playerConfig = gameId ? tablePlayerConfigs[gameId] : null;
                                                const isSlotBooked = !!(playerConfig && playerConfig.name);
                                                const isSelected = selectedSlots.some(s => s.id === gameId);

                                                let slotClass = "bg-green-500/20 border-green-500 hover:bg-green-500/40";
                                                if (isSlotBooked) slotClass = "bg-red-500/20 border-red-500 cursor-not-allowed";
                                                if (isSelected) slotClass = "bg-blue-500/20 border-blue-500 ring-2 ring-blue-400";

                                                return (
                                                    <button 
                                                        key={i} 
                                                        disabled={isSlotBooked}
                                                        onClick={() => gameId && !isSlotBooked && handleSlotClick(boot, gameId)}
                                                        className={`w-full flex items-center justify-between p-3 rounded-lg border text-left transition-colors ${slotClass}`}
                                                    >
                                                        <div className="flex items-center gap-3">
                                                            <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center font-bold text-slate-400">{i + 1}</div>
                                                            <span className="font-semibold text-white">{isSlotBooked ? playerConfig.name : 'Available Slot'}</span>
                                                        </div>
                                                        {isSlotBooked && <span className="text-xs font-bold text-gray-500 uppercase">Booked</span>}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
                <div className="p-4 border-t border-slate-700 mt-auto bg-slate-800/50">
                    <div className="flex gap-4 items-center">
                        <input
                            type="text"
                            value={bookingName}
                            onChange={e => setBookingName(e.target.value)}
                            placeholder="Enter Your Name for Booking"
                            className="flex-1 p-3 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:ring-2 focus:ring-yellow-400 outline-none transition"
                        />
                        <button
                            onClick={handleBookOnWhatsApp}
                            disabled={!bookingName.trim() || selectedSlots.length === 0}
                            className="bg-green-600 hover:bg-green-700 text-white font-bold py-3 px-6 rounded-lg shadow-lg transition-all active:scale-95 disabled:bg-slate-500 disabled:cursor-not-allowed"
                        >
                            Book on WhatsApp ({selectedSlots.length})
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body
    );
};

const App: FC = () => {
    const [currentGame, setCurrentGame] = useState<GameCategory | null>(null);
    const [isSupportOpen, setIsSupportOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [isTicketSelectorOpen, setIsTicketSelectorOpen] = useState(false);
    const [bookingTicket, setBookingTicket] = useState<Ticket | null>(null);
    const [viewingTicketDetails, setViewingTicketDetails] = useState<{ticket: Ticket, calledNumbers: number[]}|null>(null);
    const [isTablesModalOpen, setIsTablesModalOpen] = useState(false);
    const [sessionTimeLeft, setSessionTimeLeft] = useState<number | null>(null);
    
    // Housie Game State
    const [housieGameState, setHousieGameState] = useState<GameState | null>(null);
    const [isGameOverModalOpen, setIsGameOverModalOpen] = useState(false);
    const [scheduleDisplay, setScheduleDisplay] = useState('');

    // Teen Patti Admin state
    const [tpGameIds, setTPGameIds] = useState<Record<number, string[]>>({});
    const [tpPlayerConfigs, setTPPlayerConfigs] = useState<AllPlayerConfigs>({});
    const [tpBookedTables, setTPBookedTables] = useState<Record<number, boolean>>({});
    const [tpTableTimers, setTPTableTimers] = useState<Record<number, number>>({});
    
    const activeTableRef = useRef<any>(null);
    const firebaseListener = useRef<Unsubscribe | null>(null);
    const adminConfigListener = useRef<Unsubscribe | null>(null);

    // Load TP Admin Config on App Mount
    useEffect(() => {
        if (!isFirebaseConfigured) {
            // If firebase is not configured, set default game IDs for demo mode
             const initialGameIds: Record<number, string[]> = {};
             [10, 50, 100, 500].forEach(boot => {
                 initialGameIds[boot] = Array.from({ length: 4 }, generateGameId);
             });
             setTPGameIds(initialGameIds);
            return;
        };

        const adminConfigRef = ref(db, 'teenpatti/adminConfig');
        
        // Listen for real-time updates to admin config
        adminConfigListener.current = onValue(adminConfigRef, (snapshot) => {
            if (snapshot.exists()) {
                const config = snapshot.val();
                setTPGameIds(config.gameIds || {});
                setTPPlayerConfigs(config.playerConfigs || {});
                setTPBookedTables(config.bookedTables || {});
                setTPTableTimers(config.tableTimers || {});
            } else {
                // If no config exists, initialize it
                const initialGameIds: Record<number, string[]> = {};
                [10, 50, 100, 500].forEach(boot => {
                    initialGameIds[boot] = Array.from({ length: 4 }, generateGameId);
                });
                set(adminConfigRef, {
                    gameIds: initialGameIds,
                    playerConfigs: {},
                    bookedTables: {},
                    tableTimers: {}
                });
            }
        });

        return () => {
            if (adminConfigListener.current) {
                adminConfigListener.current();
            }
        };

    }, []);

    const handleSaveTPSettings = async (settings: { configs: AllPlayerConfigs, booked: Record<number, boolean>, timers: Record<number, number> }) => {
        if (!isFirebaseConfigured) {
            alert("Cannot save settings. Firebase is not configured.");
            return;
        }
        try {
            const adminConfigRef = ref(db, 'teenpatti/adminConfig');
            await update(adminConfigRef, {
                playerConfigs: settings.configs,
                bookedTables: settings.booked,
                tableTimers: settings.timers
            });
            alert("Teen Patti settings saved successfully!");
        } catch (error) {
            console.error("Error saving Teen Patti settings:", error);
            alert("Failed to save Teen Patti settings. Please check your Firebase Database rules and ensure you have write permissions.");
        }
    };

    const handleRegenerateTPIds = async (boot: number) => {
        if (!isFirebaseConfigured) {
            alert("Cannot regenerate IDs. Firebase is not configured.");
            return;
        }
        if (!confirm(`Are you sure you want to regenerate all Unique IDs for the ₹${boot} table? This will also clear any player names and chip counts for this table.`)) {
            return;
        }
        try {
            const newIds = Array.from({ length: 4 }, generateGameId);
            const updates: any = {};
            updates[`teenpatti/adminConfig/gameIds/${boot}`] = newIds;
            updates[`teenpatti/adminConfig/playerConfigs/${boot}`] = null; // Clear configs for the old IDs
            await update(ref(db), updates);
            alert(`Successfully regenerated IDs for the ₹${boot} table.`);
        } catch (error) {
            console.error("Error regenerating Teen Patti IDs:", error);
            alert(`Failed to regenerate IDs for the ₹${boot} table. Please check your Firebase Database rules and ensure you have write permissions.`);
        }
    };

    useEffect(() => {
        if (currentGame === 'housie') {
            const unsub = api.subscribe(setHousieGameState);
            return unsub;
        } else {
            // Cleanup Firebase listener when switching away from Teen Patti
            if(firebaseListener.current) {
                firebaseListener.current();
                firebaseListener.current = null;
                activeTableRef.current = null;
            }
        }
    }, [currentGame]);
    
    useEffect(() => {
        let timeout: ReturnType<typeof setTimeout>;
        if (currentGame === 'housie' && housieGameState?.scheduledStartTime) {
            const startTime = new Date(housieGameState.scheduledStartTime).getTime();
            const now = Date.now();
            if (startTime > now && (housieGameState.calledNumbers?.length ?? 0) === 0) {
                timeout = setTimeout(() => {
                    api.callNumber();
                    api.updateSettings({ isAutoPlaying: true });
                }, startTime - now);
            }
        }
        return () => clearTimeout(timeout);
    }, [currentGame, housieGameState?.scheduledStartTime, housieGameState?.calledNumbers.length]);
    
    useEffect(() => {
        let interval: ReturnType<typeof setInterval> | undefined;

        const updateDisplay = () => {
            if (!housieGameState?.scheduledStartTime) {
                setScheduleDisplay('');
                return;
            }
            const startTime = new Date(housieGameState.scheduledStartTime).getTime();
            const now = Date.now();

            if (now > startTime) {
                setScheduleDisplay('');
                clearInterval(interval);
                return;
            }
            
            const formattedTime = new Date(startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
            setScheduleDisplay(`GAME STARTS AT ${formattedTime}`);
        };

        updateDisplay();
        interval = setInterval(updateDisplay, 1000 * 30); // Update every 30 seconds

        return () => clearInterval(interval);
    }, [housieGameState?.scheduledStartTime]);

    useEffect(() => {
        // Show the modal only when the game is over.
        if (housieGameState?.isGameOver) {
            setIsGameOverModalOpen(true);
        }
    }, [housieGameState?.isGameOver]);

    // TP Game State
    const [tpState, setTpState] = useState({
        players: [] as Player[],
        pot: 0,
        bootAmount: 0,
        gamePhase: 'id_entry' as 'id_entry' | 'lobby' | 'betting' | 'showdown',
        currentPlayerIndex: 0,
        isGameOver: false,
        winnerInfo: { winner: null as Player | null, handName: '' },
        localPlayerUniqueId: null as string | null,
        showdownReveal: false,
        isMultiplayer: false,
        sideShowRequest: null as any,
        sideShowResult: null as any,
        turnTimeLeft: 30,
        turnDuration: 30,
        isSessionExpired: false,
        sessionEndTime: null as number | null
    });

    // Session timer effect
    useEffect(() => {
        if (tpState.sessionEndTime) {
            const interval = setInterval(() => {
                const now = Date.now();
                const timeLeft = Math.max(0, Math.floor((tpState.sessionEndTime - now) / 1000));
                setSessionTimeLeft(timeLeft);
                if (timeLeft === 0) {
                    clearInterval(interval);
                }
            }, 1000);
            return () => clearInterval(interval);
        } else {
            setSessionTimeLeft(null);
        }
    }, [tpState.sessionEndTime]);

    const bettingRoundRef = useRef(0);

    const executePlayerAction = useCallback((action: 'see' | 'chaal' | 'fold' | 'sideShow' | 'show' | 'deal', localPlayerId?: string) => {
       if (tpState.isMultiplayer) {
            if (!activeTableRef.current) return;
            runTransaction(activeTableRef.current, (tableState) => {
                if (!tableState) return tableState;
                 if (tableState.isGameOver || (action !== 'see' && tableState.sideShowRequest)) return;

                const playerIndex = tableState.players.findIndex((p: Player) => p.uniqueId === localPlayerId);
                const isMyTurn = tableState.currentPlayerIndex === playerIndex;

                if (action === 'deal') {
                    if (tableState.gamePhase !== 'lobby' || tableState.players.length < 2) return tableState;
                     const deck = generateDeckTP();
                     const bootAmount = tableState.bootAmount;
                     let potContribution = 0;
                     tableState.players = tableState.players.map((p: Player) => {
                         if (!p.isFolded) { // Only active players contribute and get cards
                             potContribution += bootAmount;
                             return {
                                ...p,
                                cards: [deck.pop()!, deck.pop()!, deck.pop()!],
                                chips: p.chips - bootAmount,
                                isSeen: false,
                                status: 'playing'
                             }
                         }
                         return p;
                     });
                     tableState.pot = (tableState.pot || 0) + potContribution;
                     tableState.gamePhase = 'betting';
                     tableState.currentPlayerIndex = 0;
                     tableState.isGameOver = false;
                     tableState.winnerInfo = { winner: null, handName: '' };
                     tableState.showdownReveal = false;
                     tableState.turnTimeLeft = 30;
                     tableState.turnDuration = 30;
                     return tableState;
                }

                if (!isMyTurn || playerIndex === -1) return;
                const currentPlayer = tableState.players[playerIndex];
                if (currentPlayer.isFolded) return;

                 if (action === 'see') {
                     if (!currentPlayer.isSeen) {
                         currentPlayer.isSeen = true;
                     }
                     // Seeing cards doesn't advance the turn
                     return tableState;
                 }
                //... rest of multiplayer actions
                return tableState;
            });
            return;
        }

        // --- DEMO MODE LOGIC ---
        if (tpState.isGameOver || (action !== 'see' && tpState.sideShowRequest)) return;

        setTpState(prev => {
            const newState = JSON.parse(JSON.stringify(prev));
            let { players, currentPlayerIndex, bootAmount, pot } = newState;
            const currentPlayer = players[currentPlayerIndex];
    
            if (!currentPlayer || currentPlayer.isFolded) return newState;
    
            if (action === 'see') {
                if (!currentPlayer.isSeen) {
                    currentPlayer.isSeen = true;
                }
                return { ...newState, players, turnTimeLeft: prev.turnDuration, turnDuration: prev.turnDuration };
            }

            if (action === 'sideShow') {
                if (!currentPlayer.isSeen || players.filter((p: Player) => !p.isFolded).length <= 2) return newState;

                let prevPlayerIndex = currentPlayerIndex;
                let targetPlayer = null;
                let loopGuard = 0;
                do {
                    prevPlayerIndex = (prevPlayerIndex - 1 + players.length) % players.length;
                    if (!players[prevPlayerIndex].isFolded && prevPlayerIndex !== currentPlayerIndex) {
                        targetPlayer = players[prevPlayerIndex];
                        break;
                    }
                    loopGuard++;
                } while (loopGuard < players.length);
                
                if (targetPlayer && currentPlayer.isSeen && targetPlayer.isSeen) {
                    const amount = (currentPlayer.isSeen ? bootAmount * 2 : bootAmount) * 2;
                    newState.sideShowRequest = {
                        initiatorId: currentPlayer.id,
                        targetId: targetPlayer.id,
                        amount: amount,
                    };
                }
                return newState;
            }
    
            // --- Actions that consume a turn ---
            let betAmount = 0;
            if (action === 'chaal') {
                betAmount = currentPlayer.isSeen ? bootAmount * 2 : bootAmount;
            } else if (action === 'show') {
                if (players.filter((p: Player) => !p.isFolded).length !== 2) return newState;
                betAmount = (currentPlayer.isSeen ? bootAmount * 2 : bootAmount) * 2;
            }

            if (action === 'chaal' || action === 'show') {
                if (currentPlayer.chips >= betAmount) {
                    currentPlayer.chips -= betAmount;
                    pot += betAmount;
                } else {
                    action = 'fold'; // Not enough chips, force fold
                }
            }
            
            if (action === 'fold') {
                currentPlayer.isFolded = true;
            }
    
            const activePlayers = players.filter((p: Player) => !p.isFolded);
            let isGameOver = false;
            let winnerInfo: { winner: Player | null; handName: string; } = { winner: null, handName: '' };
    
            if (activePlayers.length <= 1 || action === 'show') {
                isGameOver = true;
                newState.showdownReveal = true;
                let winner = null;
                
                if (activePlayers.length === 1) {
                    winner = activePlayers[0];
                    winnerInfo = { winner, handName: 'Last remaining player' };
                } else if (action === 'show') {
                    // Showdown between the last two
                    const player1 = activePlayers[0];
                    const player2 = activePlayers[1];
                    const hand1 = evaluateHand(player1.cards);
                    const hand2 = evaluateHand(player2.cards);

                    if (hand1.rank >= hand2.rank) {
                        winner = player1;
                        winnerInfo = { winner, handName: hand1.name };
                    } else {
                        winner = player2;
                        winnerInfo = { winner, handName: hand2.name };
                    }
                }

                if (winner) {
                    const winnerInState = players.find((p: Player) => p.id === winner.id)!;
                    winnerInState.chips += pot;
                    winnerInfo.winner = winnerInState;
                }
                pot = 0;
            }
    
            let nextPlayerIndex = currentPlayerIndex;
            if (!isGameOver) {
                let loopGuard = 0;
                do {
                    nextPlayerIndex = (nextPlayerIndex + 1) % players.length;
                    loopGuard++;
                } while (players[nextPlayerIndex].isFolded && loopGuard < players.length * 2);
    
                const nextPlayer = players[nextPlayerIndex];
                const nextTurnDuration = 30;
                newState.turnDuration = nextTurnDuration;
                newState.turnTimeLeft = nextTurnDuration;
            }
    
            return {
                ...newState,
                players,
                pot,
                currentPlayerIndex: nextPlayerIndex,
                isGameOver,
                winnerInfo
            };
        });
    }, [tpState.isGameOver, tpState.sideShowRequest, tpState.isMultiplayer]);

    const onSideShowResponse = useCallback((accepted: boolean, localPlayerId?: string) => {
        if(tpState.isMultiplayer) {
            // ... firebase transaction
            return;
        }

        // Demo mode
        setTpState(prev => {
            if (!prev.sideShowRequest) return prev;
        
            const { initiatorId, targetId, amount } = prev.sideShowRequest;
    
            const newState = JSON.parse(JSON.stringify(prev));
            newState.sideShowRequest = null;
            
            if (!accepted) {
                return newState; // No change, initiator's turn continues.
            }
    
            const initiator = newState.players.find((p: Player) => p.id === initiatorId);
            const target = newState.players.find((p: Player) => p.id === targetId);
            
            if (!initiator || !target || initiator.chips < amount) {
                return newState; // Safeguard
            }
    
            initiator.chips -= amount;
            newState.pot += amount;
    
            const initiatorHand = evaluateHand(initiator.cards);
            const targetHand = evaluateHand(target.cards);
    
            let winner, loser;
            if (initiatorHand.rank > targetHand.rank) {
                winner = initiator;
                loser = target;
            } else {
                winner = target;
                loser = initiator;
            }
            
            const loserInState = newState.players.find((p: Player) => p.id === loser.id);
            if(loserInState) loserInState.isFolded = true;
    
            newState.sideShowResult = { initiator, target, winner, loser };
            
            const activePlayers = newState.players.filter((p: Player) => !p.isFolded);
            if (activePlayers.length <= 1) {
                newState.isGameOver = true;
                if (activePlayers.length === 1) {
                    const finalWinner = activePlayers[0];
                    const winnerInState = newState.players.find((p: Player) => p.id === finalWinner.id)!;
                    winnerInState.chips += newState.pot;
                    newState.winnerInfo = { winner: winnerInState, handName: 'Last remaining player' };
                }
                newState.pot = 0;
            } else {
                 let nextPlayerIndex = newState.currentPlayerIndex;
                 let loopGuard = 0;
                 do {
                     nextPlayerIndex = (nextPlayerIndex + 1) % newState.players.length;
                     loopGuard++;
                 } while (newState.players[nextPlayerIndex].isFolded && loopGuard < newState.players.length * 2);
                 newState.currentPlayerIndex = nextPlayerIndex;
            }
            
            return newState;
        });
    }, [tpState.isMultiplayer]);

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
            executePlayerAction('fold', tpState.localPlayerUniqueId!);
        }
    }, [tpState.turnTimeLeft, tpState.gamePhase, tpState.isGameOver, executePlayerAction, tpState.localPlayerUniqueId]);


    useEffect(() => {
        if (tpState.isMultiplayer || tpState.gamePhase !== 'betting' || tpState.isGameOver) return;
        
        if (tpState.currentPlayerIndex === 0) {
            bettingRoundRef.current += 1;
        }

        const currentPlayer = tpState.players[tpState.currentPlayerIndex];
        if (currentPlayer && currentPlayer.isBot && !currentPlayer.isFolded) {
            const botTurnTimeout = setTimeout(() => {
                const activePlayerCount = tpState.players.filter((p: Player) => !p.isFolded).length;
                const action = getBotAction(
                    currentPlayer,
                    activePlayerCount,
                    tpState.pot,
                    tpState.bootAmount,
                    bettingRoundRef.current
                );
                
                if (action === 'sideShow') {
                    // Bot side show logic
                    let nextPlayerIndex = tpState.currentPlayerIndex;
                    let targetPlayer = null;
                     for (let i = 1; i < tpState.players.length; i++) {
                         nextPlayerIndex = (tpState.currentPlayerIndex + i) % tpState.players.length;
                         if (!tpState.players[nextPlayerIndex].isFolded) {
                             targetPlayer = tpState.players[nextPlayerIndex];
                             break;
                         }
                     }
                    if (targetPlayer && !targetPlayer.isBot) { // Bot only side-shows to human for demo
                        executePlayerAction('sideShow');
                    } else {
                        executePlayerAction('chaal'); // fallback to chaal
                    }
                } else {
                    executePlayerAction(action);
                }

            }, 1000 + Math.random() * 1500);

            return () => clearTimeout(botTurnTimeout);
        }
    }, [tpState.isMultiplayer, tpState.currentPlayerIndex, tpState.gamePhase, tpState.isGameOver, tpState.players, executePlayerAction, tpState.pot, tpState.bootAmount]);

    // Effect to handle bot responses to side show requests
    useEffect(() => {
        if (tpState.isMultiplayer || !tpState.sideShowRequest) return;
    
        const targetPlayer = tpState.players.find(p => p.id === tpState.sideShowRequest.targetId);
    
        if (targetPlayer && targetPlayer.isBot) {
            const sideShowTimeout = setTimeout(() => {
                const hand = evaluateHand(targetPlayer.cards);
                let tier = 0;
                if (hand.rank >= 200000) tier = 2; // Pair or better
                const accepted = tier >= 2 || (Math.random() < 0.2);
                onSideShowResponse(accepted);
    
            }, 1000 + Math.random() * 1000);
    
            return () => clearTimeout(sideShowTimeout);
        }
    }, [tpState.sideShowRequest, tpState.isMultiplayer, tpState.players, onSideShowResponse]);

    const handleTPJoin = async (uid: string, bootAmount: number) => {
        if (uid.startsWith('GUEST_')) {
            bettingRoundRef.current = 0;
            const deck = generateDeckTP();
            const initialChips = 10000;
            setTpState(prev => {
                const players: Player[] = [
                    { id: 0, positionId: 0, uniqueId: uid, name: 'Guest', isBot: false, cards: [deck.pop()!, deck.pop()!, deck.pop()!], chips: initialChips - bootAmount, initialChips, avatarSeed: uid, status: 'playing', isSeen: false, isFolded: false },
                    { id: 1, positionId: 1, uniqueId: 'bot1', name: getRandomBotName(), isBot: true, cards: [deck.pop()!, deck.pop()!, deck.pop()!], chips: 10000 - bootAmount, initialChips: 10000, avatarSeed: 'bot1', status: 'playing', isSeen: false, isFolded: false },
                    { id: 2, positionId: 2, uniqueId: 'bot2', name: getRandomBotName(), isBot: true, cards: [deck.pop()!, deck.pop()!, deck.pop()!], chips: 10000 - bootAmount, initialChips: 10000, avatarSeed: 'bot2', status: 'playing', isSeen: false, isFolded: false },
                    { id: 3, positionId: 3, uniqueId: 'bot3', name: getRandomBotName(), isBot: true, cards: [deck.pop()!, deck.pop()!, deck.pop()!], chips: 10000 - bootAmount, initialChips: 10000, avatarSeed: 'bot3', status: 'playing', isSeen: false, isFolded: false },
                ];
                return { ...prev, players, bootAmount, gamePhase: 'betting', localPlayerUniqueId: uid, pot: bootAmount * players.length, currentPlayerIndex: 0, isGameOver: false, winnerInfo: { winner: null, handName: '' }, showdownReveal: false, isMultiplayer: false };
            });
            setIsTablesModalOpen(false);
            return;
        }

        if (!isFirebaseConfigured) {
            alert("Multiplayer is not available. Please configure Firebase. Running in demo mode.");
            handleTPJoin(`GUEST_${uid}`, bootAmount);
            return;
        }

        const validIdsForBoot = tpGameIds[bootAmount] || [];
        if (!validIdsForBoot.includes(uid)) {
            alert("Access Denied. The Unique ID is not valid for the selected Boot Table.");
            return;
        }

        const tableRef = ref(db, `teenpatti/tables/${bootAmount}`);
        activeTableRef.current = tableRef;
        const playerConfig = tpPlayerConfigs[bootAmount]?.[uid];
        const playerName = playerConfig?.name || `Player ${uid.slice(0, 4)}`;
        const initialChips = playerConfig?.chips ? Number(playerConfig.chips) : 10000;

        try {
            let joinError: string | null = null;
            await runTransaction(tableRef, (currentTableData) => {
                if (currentTableData === null) {
                    const timerMins = tpTableTimers[bootAmount] || 0;
                    const newTableData: any = { gamePhase: 'lobby', bootAmount, players: [{ id: 0, uniqueId: uid, name: playerName, chips: initialChips, initialChips, avatarSeed: uid, status: 'joined' }] };
                    if (timerMins > 0) {
                        newTableData.sessionEndTime = Date.now() + timerMins * 60 * 1000;
                    }
                    return newTableData;
                }
                const players = currentTableData.players || [];
                if (players.some((p: Player) => p.uniqueId === uid)) {
                    return currentTableData; // Already in, no change
                }
                if (players.length >= 4) {
                    joinError = "Access Denied. Table is full.";
                    return; // Abort transaction
                }
                players.push({ id: players.length, uniqueId: uid, name: playerName, chips: initialChips, initialChips, avatarSeed: uid, status: 'joined' });
                currentTableData.players = players;
                return currentTableData;
            });

            if (joinError) {
                alert(joinError);
                return;
            }

        } catch (error) {
            console.error("Failed to join table:", error);
            alert("Error joining table. Please try again.");
            return;
        }
        
        if (firebaseListener.current) {
            firebaseListener.current();
        }
        firebaseListener.current = onValue(tableRef, (snapshot) => {
            const tableState = snapshot.val();
            if (tableState) {
                const isExpired = tableState.sessionEndTime ? Date.now() > tableState.sessionEndTime : false;
                // Session is expired ONLY if the timer has passed AND the current game is over.
                const sessionExpiredAndGameOver = isExpired && tableState.isGameOver;

                setTpState(prevState => ({
                    ...prevState,
                    players: tableState.players || [],
                    pot: tableState.pot || 0,
                    bootAmount: tableState.bootAmount,
                    gamePhase: tableState.gamePhase,
                    currentPlayerIndex: tableState.currentPlayerIndex ?? 0,
                    isGameOver: tableState.isGameOver ?? false,
                    winnerInfo: tableState.winnerInfo || { winner: null, handName: '' },
                    showdownReveal: tableState.showdownReveal ?? false,
                    isSessionExpired: sessionExpiredAndGameOver,
                    sessionEndTime: tableState.sessionEndTime || null
                }));
            } else {
                handleLeaveGame();
            }
        });
        setTpState(prev => ({ ...prev, localPlayerUniqueId: uid, isMultiplayer: true, gamePhase: 'lobby' }));
    };
    
    const handleLeaveGame = () => {
        const localId = tpState.localPlayerUniqueId;

        if (tpState.isMultiplayer && activeTableRef.current && localId) {
             runTransaction(activeTableRef.current, (tableState) => {
                if (!tableState || !tableState.players) return null;

                const playerIndex = tableState.players.findIndex((p: Player) => p.uniqueId === localId);
                if (playerIndex === -1) return tableState;

                if (tableState.gamePhase === 'betting' && !tableState.players[playerIndex].isFolded) {
                    tableState.players[playerIndex].isFolded = true;
                    const activePlayers = tableState.players.filter((p: Player) => !p.isFolded);
                    if (activePlayers.length <= 1) {
                        tableState.isGameOver = true;
                        tableState.showdownReveal = false; 
                        if (activePlayers.length === 1) {
                            const winner = activePlayers[0];
                            const winnerInState = tableState.players.find((p: Player) => p.id === winner.id);
                            if(winnerInState) winnerInState.chips += tableState.pot;
                            tableState.winnerInfo = { winner: winnerInState, handName: 'Last remaining player' };
                        }
                        tableState.pot = 0;
                    } else if (tableState.currentPlayerIndex === playerIndex) {
                        let nextPlayerIndex = playerIndex;
                        do {
                            nextPlayerIndex = (nextPlayerIndex + 1) % tableState.players.length;
                        } while (tableState.players[nextPlayerIndex].isFolded);
                        tableState.currentPlayerIndex = nextPlayerIndex;
                        tableState.turnTimeLeft = tableState.turnDuration;
                    }
                }
                
                const newPlayers = tableState.players.filter((p: Player) => p.uniqueId !== localId);
                
                if (newPlayers.length === 0) {
                    return null; 
                }
                
                tableState.players = newPlayers;
                return tableState;
            });
        }
        
        // Reset local state for everyone
        if (firebaseListener.current) firebaseListener.current();
        firebaseListener.current = null;
        activeTableRef.current = null;
        setTpState({
            players: [], pot: 0, bootAmount: 0, gamePhase: 'id_entry', currentPlayerIndex: 0,
            isGameOver: false, winnerInfo: { winner: null, handName: '' }, localPlayerUniqueId: null,
            showdownReveal: false, isMultiplayer: false, sideShowRequest: null, sideShowResult: null,
            turnTimeLeft: 30, turnDuration: 30, isSessionExpired: false, sessionEndTime: null
        });
    };

    const handlePlayAgainMultiplayer = () => {
        if (!tpState.isMultiplayer || !activeTableRef.current) return;
        
        runTransaction(activeTableRef.current, (tableState) => {
            if (!tableState || !tableState.isGameOver) return tableState; // Can only play again if game is over
    
            // Reset game state for a new round
            tableState.gamePhase = 'lobby';
            tableState.isGameOver = false;
            tableState.pot = 0;
            tableState.currentPlayerIndex = 0;
            tableState.winnerInfo = { winner: null, handName: '' };
            tableState.showdownReveal = false;
            tableState.sideShowRequest = null;
            tableState.sideShowResult = null;
    
            // Reset player states for the new round, keeping their chips
            tableState.players = tableState.players.map((p: Player) => ({
                ...p,
                cards: [],
                isFolded: false,
                isSeen: false,
                status: 'joined' // Back to lobby status
            }));
    
            return tableState;
        });
    };

    const handleHome = () => {
        if (currentGame === 'teenpatti' && tpState.localPlayerUniqueId) {
             handleLeaveGame();
        }
        setCurrentGame(null);
    }

    const renderTPHeaderContent = () => {
        const timerDisplay = sessionTimeLeft !== null && tpState.sessionEndTime && (
            <div className="flex flex-col items-center bg-black/20 px-4 py-1 rounded-lg border border-white/10">
                <span className="text-yellow-400 text-[10px] font-bold uppercase">Session Time</span>
                <span className="text-white font-black text-xl tracking-widest">{formatTime(sessionTimeLeft)}</span>
            </div>
        );
    
        const dealButton = (
            <button 
                onClick={() => executePlayerAction('deal', tpState.localPlayerUniqueId!)} 
                className="bg-green-600 hover:bg-green-500 text-white font-bold px-6 py-2 rounded-lg text-sm uppercase shadow-lg active:scale-95 transition-all animate-pulse"
            >
                DEAL CARDS
            </button>
        );
    
        if (tpState.gamePhase === 'lobby' && tpState.players.length === 4 && !tpState.isGameOver) {
            return dealButton;
        }
        
        if ((tpState.gamePhase === 'betting' || tpState.gamePhase === 'showdown') && tpState.sessionEndTime) {
            return timerDisplay;
        }
    
        return null;
    };

    return (
        <ErrorBoundary>
            <div className="w-full h-full bg-slate-900 overflow-hidden relative font-sans select-none text-slate-900">
                {currentGame ? (
                    <div className="w-full h-full flex flex-col">
                        <GameHeader 
                            currentGame={currentGame}
                            onHome={handleHome}
                            onSupport={() => setIsSupportOpen(true)}
                            onSwitchToggle={() => setMenuOpen(!menuOpen)}
                            menuOpen={menuOpen}
                            onGameChange={(g) => { setCurrentGame(g); setMenuOpen(false); }}
                            onLogout={currentGame === 'teenpatti' && tpState.gamePhase !== 'id_entry' ? handleLeaveGame : undefined}
                            centerContent={
                                currentGame === 'housie' ? (
                                    <div className="flex flex-col items-center gap-1">
                                        <button onClick={() => setIsTicketSelectorOpen(true)} className="bg-yellow-400 hover:bg-yellow-300 text-[#1e3a8a] font-black px-4 py-1.5 rounded-full shadow-lg uppercase text-[10px] tracking-wider transform transition hover:scale-105 active:scale-95 border-2 border-yellow-200">
                                            Available Tickets
                                        </button>
                                        {scheduleDisplay && (
                                            <div className="text-yellow-300 text-[10px] font-bold bg-black/50 px-2 py-0.5 rounded-full">
                                                {scheduleDisplay}
                                            </div>
                                        )}
                                    </div>
                                ) : currentGame === 'teenpatti' && tpState.gamePhase !== 'id_entry' ? (
                                    renderTPHeaderContent()
                                ) : currentGame === 'teenpatti' ? (
                                    <button onClick={() => setIsTablesModalOpen(true)} className="bg-yellow-400 hover:bg-yellow-300 text-blue-900 font-black px-6 py-2 rounded-full shadow-lg uppercase text-xs tracking-wider transform transition hover:scale-105 active:scale-95 border-2 border-yellow-200">
                                        Available Tables
                                    </button>
                                ) : null
                            }
                        />
                        <div className="flex-1 relative overflow-hidden">
                            {currentGame === 'housie' && <HousieGame gameState={housieGameState} onBookTicket={setBookingTicket} />}
                            {currentGame === 'teenpatti' && (
                                <TeenPattiGame 
                                    {...tpState}
                                    onJoin={handleTPJoin}
                                    onPlayerAction={executePlayerAction}
                                    onPlayAgain={handlePlayAgainMultiplayer}
                                    onAdminReset={handleLeaveGame} // Demo mode reset
                                    onSideShowResponse={onSideShowResponse}
                                    onCloseSideShowResult={() => setTpState(prev => ({...prev, sideShowResult: null}))}
                                    onViewDashboard={() => setCurrentGame(null)}
                                />
                            )}
                            {currentGame === 'rummy' && <RummyGame />}
                            {currentGame === 'spades' && <SpadesGame />}
                        </div>
                    </div>
                ) : (
                    <GameHub onSelectGame={setCurrentGame} isConnected={isFirebaseConfigured} />
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
                    tpBookedTables={tpBookedTables}
                    tpTableTimers={tpTableTimers}
                    onSaveTPSettingsAsync={handleSaveTPSettings}
                />
                <TPAvailableTablesModal
                    isOpen={isTablesModalOpen}
                    onClose={() => setIsTablesModalOpen(false)}
                    bootAmounts={[10, 50, 100, 500]}
                    bookedTables={tpBookedTables}
                    playerConfigs={tpPlayerConfigs}
                    gameIds={tpGameIds}
                />
                 <AvailableTicketsModal 
                    isOpen={isTicketSelectorOpen && currentGame === 'housie'}
                    onClose={() => setIsTicketSelectorOpen(false)}
                    gameState={housieGameState}
                />
                <SingleTicketBookingModal ticket={bookingTicket} onClose={() => setBookingTicket(null)} />
                <HousieGameOverModal
                    isOpen={(housieGameState?.isGameOver ?? false) && isGameOverModalOpen}
                    onClose={() => setIsGameOverModalOpen(false)}
                    gameState={housieGameState}
                    onResetRequest={() => api.resetGame()}
                    onViewTicket={(ticket) => setViewingTicketDetails({ ticket, calledNumbers: housieGameState?.calledNumbers || [] })}
                />
                <ViewTicketModal 
                    isOpen={!!viewingTicketDetails}
                    onClose={() => setViewingTicketDetails(null)}
                    ticket={viewingTicketDetails?.ticket ?? null}
                    calledNumbers={viewingTicketDetails?.calledNumbers ?? null}
                />
            </div>
        </ErrorBoundary>
    );
};

const root = createRoot(document.getElementById("root")!);
root.render(<App />);