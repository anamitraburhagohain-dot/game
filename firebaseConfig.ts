// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDVSqnEe1o57urBRrMKGiY_IOyOLmRSVw4",
  authDomain: "teenpatti-b626a.firebaseapp.com",
  databaseURL: "https://teenpatti-b626a-default-rtdb.asia-southeast1.firebasedatabase.app/"
  projectId: "teenpatti-b626a",
  storageBucket: "teenpatti-b626a.firebasestorage.app",
  messagingSenderId: "687205335645",
  appId: "1:687205335645:web:d11951f51c3a7b5fdc03b4"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);