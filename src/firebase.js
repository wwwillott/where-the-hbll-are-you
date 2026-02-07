import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyCKqDUk-fKqmv2KQTkEVyG4UKq4eIRF3To",
  authDomain: "where-the-hbll-are-you.firebaseapp.com",
  projectId: "where-the-hbll-are-you",
  storageBucket: "where-the-hbll-are-you.firebasestorage.app",
  messagingSenderId: "596878142483",
  appId: "1:596878142483:web:ab43b6c44070801560e3e6"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);