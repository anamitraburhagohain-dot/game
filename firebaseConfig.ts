// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getDatabase, Database } from "firebase/database";

// Your web app's Firebase configuration is now read from environment variables
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.FIREBASE_DATABASE_URL,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

export let isFirebaseConfigured = false;
export let db: Database | null = null;

// --- Configuration Validation ---
// Check if essential Firebase config values are present.
if (
  firebaseConfig.apiKey &&
  firebaseConfig.authDomain &&
  firebaseConfig.databaseURL &&
  firebaseConfig.projectId
) {
  // Initialize Firebase
  const app = initializeApp(firebaseConfig);
  db = getDatabase(app);
  isFirebaseConfigured = true;
} else {
  // If config is missing, log a warning and the app will run in mock mode.
  const warningMessage = `
    *****************************************************************
    * WARNING: FIREBASE CONFIGURATION MISSING OR INCOMPLETE.        *
    * The app will run in local-only mock mode without real-time    *
    * features. Game state will not be saved or synced.             *
    *                                                               *
    * To enable Firebase, create a .env.local file in the project   *
    * root with your Firebase credentials. See README.md for        *
    * instructions.                                                 *
    *****************************************************************
  `;
  console.warn(warningMessage);
}
