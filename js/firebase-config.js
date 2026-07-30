// Firebase 초기화 (CDN 모듈 방식 — npm/빌드 과정 불필요)
// 이 파일은 다른 모든 js 파일보다 먼저 로드되어 firebase 앱을 준비합니다.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyAXhqKHf7Iyjk6q9zGHbWenKFnl7er0bBE",
  authDomain: "xeon-ccb94.firebaseapp.com",
  databaseURL: "https://xeon-ccb94-default-rtdb.firebaseio.com",
  projectId: "xeon-ccb94",
  storageBucket: "xeon-ccb94.firebasestorage.app",
  messagingSenderId: "507369501337",
  appId: "1:507369501337:web:b613fabec15f525fc27e08",
  measurementId: "G-0Y11W17FSE"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);       // Firestore: 방/게임 데이터
export const rtdb = getDatabase(app);       // Realtime Database: 접속 감지(presence)

// 사이트에 들어오는 즉시 익명 로그인 (로그인창 없음, uid로만 방장/도전자/관전자 구분)
export function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(auth, (user) => {
      if (user) {
        resolve(user);
      } else {
        signInAnonymously(auth).catch(reject);
      }
    });
  });
}
