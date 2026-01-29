
// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDa6e7k6JfBLrO7FkFGHMr8Mm9MkqMGM9k",
  authDomain: "game-b7bad.firebaseapp.com",
  databaseURL: "https://game-b7bad-default-rtdb.asia-southeast1.firebasedatabase.app/",
  projectId: "game-b7bad",
  storageBucket: "game-b7bad.firebasestorage.app",
  messagingSenderId: "650318082136",
  appId: "1:650318082136:web:200731022d896cac769a2d"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
