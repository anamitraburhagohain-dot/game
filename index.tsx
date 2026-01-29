
import React, { useState, useEffect, useMemo, useRef, Component, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { GoogleGenAI } from "@google/genai";
import { INITIAL_BOOKS, CATEGORIES } from "./constants";
import { api, Book } from "./api";

// --- Error Boundary ---
interface ErrorBoundaryProps { children?: ReactNode; }
interface ErrorBoundaryState { hasError: boolean; error: string; }

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    constructor(props: ErrorBoundaryProps) {
        super(props);
        this.state = { hasError: false, error: "" };
    }

    static getDerivedStateFromError(error: any): ErrorBoundaryState { 
        return { hasError: true, error: error.toString() }; 
    }

    componentDidCatch(error: any, errorInfo: any) { 
        console.error("Uncaught error:", error, errorInfo); 
    }

    render() {
        if (this.state.hasError) {
            return (
                <div className="min-h-screen flex flex-col items-center justify-center bg-red-50 p-6 text-center text-red-900">
                    <h1 className="text-2xl font-black mb-2">Something went wrong</h1>
                    <button onClick={() => window.location.reload()} className="px-4 py-2 bg-red-600 text-white rounded font-bold">Reload</button>
                    <pre className="mt-4 text-xs opacity-50">{this.state.error}</pre>
                </div>
            );
        }
        return this.props.children;
    }
}

// --- Icons ---
const Icons = {
    Cart: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" /></svg>,
    Search: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>,
    Star: () => <svg className="w-4 h-4 text-yellow-400 fill-current" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>,
    Close: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>,
    Chat: () => <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg>,
    Send: () => <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>,
};

// --- Components ---

const BookCard = ({ book, onAdd, onClick }: { book: Book, onAdd: (e: React.MouseEvent) => void, onClick: () => void }) => (
    <div onClick={onClick} className="group bg-white rounded-xl shadow-sm hover:shadow-xl transition-all duration-300 overflow-hidden cursor-pointer border border-slate-100 flex flex-col h-full">
        <div className="relative aspect-[2/3] overflow-hidden bg-slate-100">
            <img src={book.cover} alt={book.title} className="object-cover w-full h-full group-hover:scale-105 transition-transform duration-500" />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
            <div className="absolute top-3 right-3 bg-white/90 backdrop-blur-sm px-2 py-1 rounded-lg text-xs font-bold shadow-sm flex items-center gap-1">
                <Icons.Star /> {book.rating}
            </div>
        </div>
        <div className="p-4 flex flex-col flex-1">
            <div className="text-xs font-bold text-indigo-500 uppercase tracking-wider mb-1">{book.category}</div>
            <h3 className="font-bold text-slate-900 text-lg leading-tight mb-1">{book.title}</h3>
            <p className="text-slate-500 text-sm mb-4">{book.author}</p>
            <div className="mt-auto flex items-center justify-between">
                <span className="font-black text-slate-900 text-lg">Rs. {book.price.toFixed(2)}</span>
                <button 
                    onClick={onAdd}
                    className="bg-slate-900 hover:bg-indigo-600 text-white p-2.5 rounded-lg transition-colors active:scale-95"
                >
                    <span className="sr-only">Add to cart</span>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                </button>
            </div>
        </div>
    </div>
);

const CartDrawer = ({ isOpen, onClose, cart, updateQuantity, checkout }: any) => {
    const total = cart.reduce((sum: number, item: any) => sum + (item.price * item.quantity), 0);

    return (
        <>
            {isOpen && <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[100]" onClick={onClose} />}
            <div className={`fixed inset-y-0 right-0 w-full max-w-md bg-white shadow-2xl z-[101] transform transition-transform duration-300 ease-in-out ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
                <div className="h-full flex flex-col">
                    <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                        <h2 className="text-xl font-black text-slate-900">Your Cart ({cart.length})</h2>
                        <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-full transition-colors"><Icons.Close /></button>
                    </div>
                    
                    <div className="flex-1 overflow-y-auto p-5 space-y-6">
                        {cart.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-center space-y-4 opacity-50">
                                <Icons.Cart />
                                <p className="font-bold">Your cart is empty</p>
                            </div>
                        ) : (
                            cart.map((item: any) => (
                                <div key={item.id} className="flex gap-4">
                                    <img src={item.cover} alt={item.title} className="w-20 h-28 object-cover rounded-lg shadow-sm" />
                                    <div className="flex-1 flex flex-col">
                                        <h3 className="font-bold text-slate-900 leading-tight">{item.title}</h3>
                                        <p className="text-sm text-slate-500 mb-2">{item.author}</p>
                                        <div className="mt-auto flex items-center justify-between">
                                            <span className="font-bold text-slate-900">Rs. {item.price}</span>
                                            <div className="flex items-center gap-3 bg-slate-100 rounded-lg px-2 py-1">
                                                <button onClick={() => updateQuantity(item.id, -1)} className="w-6 h-6 flex items-center justify-center hover:bg-white rounded-md text-sm font-bold">-</button>
                                                <span className="text-sm font-bold w-4 text-center">{item.quantity}</span>
                                                <button onClick={() => updateQuantity(item.id, 1)} className="w-6 h-6 flex items-center justify-center hover:bg-white rounded-md text-sm font-bold">+</button>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>

                    <div className="p-6 border-t border-slate-100 bg-slate-50">
                        <div className="flex justify-between items-center mb-4">
                            <span className="text-slate-500 font-medium">Subtotal</span>
                            <span className="text-2xl font-black text-slate-900">Rs. {total.toFixed(2)}</span>
                        </div>
                        <button 
                            disabled={cart.length === 0}
                            onClick={checkout}
                            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white py-4 rounded-xl font-bold shadow-lg shadow-indigo-200 transition-all active:scale-[0.98]"
                        >
                            Checkout Now
                        </button>
                    </div>
                </div>
            </div>
        </>
    );
};

const BookDetailsModal = ({ book, onClose, onAdd }: any) => {
    if (!book) return null;
    return createPortal(
        <div className="fixed inset-0 z-[150] bg-black/60 backdrop-blur-md flex items-center justify-center p-4" onClick={onClose}>
            <div className="bg-white rounded-2xl w-full max-w-4xl overflow-hidden shadow-2xl flex flex-col md:flex-row max-h-[90vh]" onClick={e => e.stopPropagation()}>
                <div className="w-full md:w-2/5 bg-slate-100 relative">
                    <img src={book.cover} alt={book.title} className="w-full h-full object-cover" />
                    <button onClick={onClose} className="absolute top-4 left-4 md:hidden bg-white/50 backdrop-blur p-2 rounded-full"><Icons.Close /></button>
                </div>
                <div className="flex-1 p-8 flex flex-col overflow-y-auto">
                    <div className="flex justify-between items-start mb-2">
                        <span className="text-sm font-bold text-indigo-600 bg-indigo-50 px-3 py-1 rounded-full uppercase tracking-wider">{book.category}</span>
                        <button onClick={onClose} className="hidden md:block hover:bg-slate-100 p-2 rounded-full"><Icons.Close /></button>
                    </div>
                    <h2 className="text-3xl md:text-4xl font-black text-slate-900 mb-2 leading-tight">{book.title}</h2>
                    <p className="text-lg text-slate-500 font-medium mb-6">by {book.author}</p>
                    
                    <div className="flex items-center gap-4 mb-8">
                        <div className="flex items-center gap-1 text-yellow-400">
                            {[...Array(5)].map((_, i) => (
                                <svg key={i} className={`w-5 h-5 ${i < Math.floor(book.rating) ? 'fill-current' : 'text-slate-200'}`} viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" /></svg>
                            ))}
                        </div>
                        <span className="text-slate-400 font-bold text-sm">({book.rating}/5.0)</span>
                    </div>

                    <p className="text-slate-600 leading-relaxed mb-8 text-lg">{book.description}</p>

                    <div className="mt-auto pt-6 border-t border-slate-100 flex items-center justify-between gap-4">
                        <span className="text-3xl font-black text-slate-900">Rs. {book.price}</span>
                        <button onClick={(e) => { onAdd(e); onClose(); }} className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-4 rounded-xl font-bold text-lg shadow-lg shadow-indigo-200 transition-all active:scale-[0.98]">
                            Add to Library
                        </button>
                    </div>
                </div>
            </div>
        </div>, document.body
    );
}

const AIChat = ({ isOpen, onClose, books }: { isOpen: boolean, onClose: () => void, books: Book[] }) => {
    const [messages, setMessages] = useState<{role: 'user' | 'model', text: string}[]>([
        { role: 'model', text: "Hello! I'm your AI Librarian. Looking for a specific genre or need a recommendation based on your mood?" }
    ]);
    const [input, setInput] = useState("");
    const [isThinking, setIsThinking] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [messages]);

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim()) return;
        
        const userMsg = input;
        setInput("");
        setMessages(prev => [...prev, { role: 'user', text: userMsg }]);
        setIsThinking(true);

        try {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const inventoryContext = books.map(b => `${b.title} by ${b.author} (${b.category}) - Rs. ${b.price}: ${b.description}`).join('\n');
            const systemInstruction = `You are a helpful and knowledgeable Bookstore Librarian. 
            You have access to the following inventory:\n${inventoryContext}\n
            Recommend books from this inventory when relevant. If the user asks for something we don't have, politely suggest the closest match from our inventory. 
            Keep responses concise, friendly, and encouraging. Use emojis sparingly.`;

            const model = ai.models.getGenerativeModel({ model: "gemini-3-flash-preview", systemInstruction });
            const chat = model.startChat({
                history: messages.map(m => ({ role: m.role, parts: [{ text: m.text }] }))
            });

            const result = await chat.sendMessage(userMsg);
            const responseText = result.response.text();
            
            setMessages(prev => [...prev, { role: 'model', text: responseText }]);
        } catch (error) {
            setMessages(prev => [...prev, { role: 'model', text: "I'm having a little trouble checking the shelves right now. Please try again later!" }]);
        } finally {
            setIsThinking(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed bottom-24 right-6 w-96 h-[500px] bg-white rounded-2xl shadow-2xl border border-slate-200 z-50 flex flex-col overflow-hidden animate-pop">
            <div className="bg-indigo-600 p-4 text-white flex justify-between items-center">
                <div className="flex items-center gap-2">
                    <span className="text-2xl">🤖</span>
                    <div>
                        <h3 className="font-bold text-sm">AI Librarian</h3>
                        <p className="text-[10px] opacity-80">Powered by Gemini</p>
                    </div>
                </div>
                <button onClick={onClose} className="hover:bg-white/20 p-1 rounded"><Icons.Close /></button>
            </div>
            <div className="flex-1 bg-slate-50 p-4 overflow-y-auto space-y-3" ref={scrollRef}>
                {messages.map((m, i) => (
                    <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                        <div className={`max-w-[85%] p-3 rounded-2xl text-sm leading-relaxed ${m.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-white border border-slate-200 text-slate-700 rounded-tl-none shadow-sm'}`}>
                            {m.text}
                        </div>
                    </div>
                ))}
                {isThinking && (
                    <div className="flex justify-start">
                        <div className="bg-white border border-slate-200 px-4 py-3 rounded-2xl rounded-tl-none shadow-sm flex gap-1">
                            <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"></span>
                            <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce delay-75"></span>
                            <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce delay-150"></span>
                        </div>
                    </div>
                )}
            </div>
            <form onSubmit={handleSend} className="p-3 bg-white border-t border-slate-100 flex gap-2">
                <input 
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="Ask for a recommendation..."
                    className="flex-1 bg-slate-100 border-0 rounded-xl px-4 py-2.5 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                />
                <button type="submit" disabled={!input.trim() || isThinking} className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white p-2.5 rounded-xl transition-colors">
                    <Icons.Send />
                </button>
            </form>
        </div>
    );
};

const Bookstore = () => {
    const [books, setBooks] = useState<Book[]>([]);
    const [cart, setCart] = useState<any[]>([]);
    const [search, setSearch] = useState("");
    const [category, setCategory] = useState("All");
    const [isCartOpen, setIsCartOpen] = useState(false);
    const [selectedBook, setSelectedBook] = useState<Book | null>(null);
    const [isChatOpen, setIsChatOpen] = useState(false);

    useEffect(() => {
        const unsubscribe = api.subscribeToBooks((data) => setBooks(data));
        return () => unsubscribe();
    }, []);

    const filteredBooks = useMemo(() => {
        return books.filter(b => {
            const matchesSearch = b.title.toLowerCase().includes(search.toLowerCase()) || b.author.toLowerCase().includes(search.toLowerCase());
            const matchesCategory = category === "All" || b.category === category;
            return matchesSearch && matchesCategory;
        });
    }, [books, search, category]);

    const addToCart = (e: React.MouseEvent, book: Book) => {
        e.stopPropagation();
        setCart(prev => {
            const existing = prev.find(item => item.id === book.id);
            if (existing) {
                return prev.map(item => item.id === book.id ? { ...item, quantity: item.quantity + 1 } : item);
            }
            return [...prev, { ...book, quantity: 1 }];
        });
        setIsCartOpen(true);
    };

    const updateQuantity = (id: string, delta: number) => {
        setCart(prev => prev.map(item => {
            if (item.id === id) {
                const newQ = item.quantity + delta;
                return newQ > 0 ? { ...item, quantity: newQ } : null;
            }
            return item;
        }).filter(Boolean));
    };

    const checkout = async () => {
        if(confirm(`Proceed to checkout? Total: Rs. ${cart.reduce((sum, i) => sum + i.price * i.quantity, 0).toFixed(2)}`)) {
            await api.placeOrder(cart.map(i => ({ bookId: i.id, quantity: i.quantity, price: i.price })));
            setCart([]);
            setIsCartOpen(false);
            alert("Thank you for your order! Your books are on the way.");
        }
    }

    return (
        <ErrorBoundary>
            <div className="min-h-screen bg-slate-50 font-inter text-slate-900 pb-20">
                {/* Navbar */}
                <nav className="sticky top-0 z-40 bg-white/80 backdrop-blur-md border-b border-slate-200">
                    <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-black text-lg">B</div>
                            <span className="font-black text-xl tracking-tight text-slate-900">Book<span className="text-indigo-600">Nook</span></span>
                        </div>

                        <div className="hidden md:flex flex-1 max-w-md mx-8 relative">
                            <input 
                                type="text" 
                                placeholder="Search by title or author..." 
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                className="w-full bg-slate-100 border-none rounded-full py-2 pl-10 pr-4 text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                            />
                            <div className="absolute left-3 top-2.5 text-slate-400"><Icons.Search /></div>
                        </div>

                        <div className="flex items-center gap-4">
                            <button onClick={() => setIsCartOpen(true)} className="relative p-2 hover:bg-slate-100 rounded-full transition-colors">
                                <Icons.Cart />
                                {cart.length > 0 && <span className="absolute top-0 right-0 w-4 h-4 bg-red-500 text-white text-[10px] font-bold flex items-center justify-center rounded-full">{cart.length}</span>}
                            </button>
                        </div>
                    </div>
                </nav>

                {/* Hero */}
                <header className="bg-indigo-900 text-white py-16 px-4 relative overflow-hidden">
                    <div className="absolute inset-0 opacity-20 bg-[url('https://images.unsplash.com/photo-1481627834876-b7833e8f5570?auto=format&fit=crop&q=80&w=2000')] bg-cover bg-center"></div>
                    <div className="max-w-7xl mx-auto relative z-10 text-center">
                        <h1 className="text-4xl md:text-6xl font-black mb-4 tracking-tight">Discover Your Next Adventure</h1>
                        <p className="text-indigo-200 text-lg md:text-xl max-w-2xl mx-auto">Curated stories, timeless classics, and modern masterpieces. Find the book that speaks to you.</p>
                    </div>
                </header>

                {/* Filters */}
                <div className="sticky top-16 z-30 bg-white border-b border-slate-200 shadow-sm py-3">
                    <div className="max-w-7xl mx-auto px-4 overflow-x-auto no-scrollbar flex gap-2">
                        {CATEGORIES.map(cat => (
                            <button 
                                key={cat} 
                                onClick={() => setCategory(cat)}
                                className={`px-4 py-1.5 rounded-full text-sm font-bold whitespace-nowrap transition-all ${category === cat ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                            >
                                {cat}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Grid */}
                <main className="max-w-7xl mx-auto px-4 py-8">
                    {filteredBooks.length === 0 ? (
                        <div className="text-center py-20 text-slate-400">
                            <p className="text-lg">No books found matching your criteria.</p>
                            <button onClick={() => { setSearch(""); setCategory("All"); }} className="mt-4 text-indigo-600 font-bold hover:underline">Clear filters</button>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
                            {filteredBooks.map(book => (
                                <BookCard 
                                    key={book.id} 
                                    book={book} 
                                    onAdd={(e) => addToCart(e, book)} 
                                    onClick={() => setSelectedBook(book)}
                                />
                            ))}
                        </div>
                    )}
                </main>

                {/* Floating Chat Button */}
                <button 
                    onClick={() => setIsChatOpen(!isChatOpen)}
                    className="fixed bottom-6 right-6 w-14 h-14 bg-indigo-600 hover:bg-indigo-700 text-white rounded-full shadow-xl shadow-indigo-300 flex items-center justify-center transition-transform hover:scale-110 z-40"
                >
                    {isChatOpen ? <Icons.Close /> : <Icons.Chat />}
                </button>

                {/* Modals & Drawers */}
                <CartDrawer isOpen={isCartOpen} onClose={() => setIsCartOpen(false)} cart={cart} updateQuantity={updateQuantity} checkout={checkout} />
                <BookDetailsModal book={selectedBook} onClose={() => setSelectedBook(null)} onAdd={(e: any) => addToCart(e, selectedBook!)} />
                <AIChat isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} books={books} />
            </div>
        </ErrorBoundary>
    );
};

const rootEl = document.getElementById("root");
if (rootEl) {
    const root = createRoot(rootEl);
    root.render(<Bookstore />);
}
