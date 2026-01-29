
import { db } from './firebaseConfig';
import { ref, get, set, push, onValue } from "firebase/database";
import { INITIAL_BOOKS } from './constants';

export interface Book {
    id: string;
    title: string;
    author: string;
    price: number;
    category: string;
    rating: number;
    cover: string;
    description: string;
}

export interface Order {
    id: string;
    items: { bookId: string; quantity: number }[];
    total: number;
    timestamp: number;
    status: 'pending' | 'completed';
}

// Updated ref to force new data seed
const BOOKS_REF = 'bookstore/books_v2';
const ORDERS_REF = 'bookstore/orders';

export const api = {
    // Subscribe to the books list. If empty, seed with initial data.
    subscribeToBooks: (callback: (books: Book[]) => void) => {
        const booksRef = ref(db, BOOKS_REF);
        return onValue(booksRef, (snapshot) => {
            if (snapshot.exists()) {
                const data = snapshot.val();
                const booksList = Array.isArray(data) ? data : Object.values(data);
                callback(booksList as Book[]);
            } else {
                // If no books exist, seed the database
                api.resetInventory();
                callback(INITIAL_BOOKS);
            }
        });
    },

    resetInventory: async () => {
        await set(ref(db, BOOKS_REF), INITIAL_BOOKS);
    },

    placeOrder: async (items: { bookId: string; quantity: number; price: number }[]) => {
        const total = items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        await push(ref(db, ORDERS_REF), {
            items,
            total,
            timestamp: Date.now(),
            status: 'completed'
        });
        return true;
    }
};
