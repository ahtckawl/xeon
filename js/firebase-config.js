// Firebase 초기화 (CDN 모듈 방식 — npm/빌드 과정 불필요)
// 이 파일은 다른 모든 js 파일보다 먼저 로드되어 firebase 앱을 준비합니다.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  linkWithPopup,
  signInWithCredential,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

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

export const WORKER_BASE_URL = "https://xeon-worker.ahtckawl.workers.dev";

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);       // Firestore: 방/게임 데이터

// 사이트에 들어오는 즉시 익명 로그인 (로그인창 없음, uid로만 방장/도전자/관전자 구분)
// 구글 로그인은 여기서 자동으로 하지 않고, 유저가 명시적으로 "구글로 로그인" 버튼을
// 눌렀을 때만 signInWithGoogle()을 호출함.
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

// 로그인 상태가 바뀔 때마다(구글 연결 성공, 로그아웃 등) UI를 다시 그릴 수 있도록
// 콜백을 등록하는 헬퍼. lobby.js 등에서 사용.
export function onAuthChange(callback) {
  return onAuthStateChanged(auth, callback);
}

export function currentUserInfo() {
  const u = auth.currentUser;
  if (!u) return null;
  return {
    uid: u.uid,
    isAnonymous: u.isAnonymous,
    displayName: u.displayName,
    photoURL: u.photoURL,
    email: u.email,
  };
}

/* =========================================================
   구글 로그인
   - 현재 uid가 익명(게스트)이면 linkWithPopup으로 "연결"해서
     기존 uid를 그대로 유지함 (playerStats, 진행 중이던 방 정보가
     그대로 이어짐).
   - 그 구글 계정이 이미 다른 uid로 가입돼 있으면 연결이 실패하는데
     (auth/credential-already-in-use), 이 경우엔 그 기존 계정으로
     전환함 — 이 브라우저의 게스트 기록은 버려지고, 원래 그 구글
     계정에 쌓여있던 전적으로 이어짐.
   - 팝업을 유저가 그냥 닫은 경우(auth/popup-closed-by-user,
     auth/cancelled-popup-request)는 에러로 취급하지 않고 조용히 무시.
========================================================= */
export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  const user = auth.currentUser;

  try {
    if (user && user.isAnonymous) {
      const result = await linkWithPopup(user, provider);
      return { user: result.user, switched: false };
    }
    const result = await signInWithPopup(auth, provider);
    return { user: result.user, switched: false };
  } catch (e) {
    if (e.code === "auth/credential-already-in-use") {
      const cred = GoogleAuthProvider.credentialFromError(e);
      const result = await signInWithCredential(auth, cred);
      return { user: result.user, switched: true }; // 게스트 uid에서 기존 구글 계정으로 전환됨
    }
    if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") {
      return null; // 유저가 취소함 — 에러 아님
    }
    throw e;
  }
}

export async function signOutAndGoGuest() {
  await signOut(auth);
  await signInAnonymously(auth); // 로그아웃 후에도 게스트로는 바로 이용 가능하게
}
