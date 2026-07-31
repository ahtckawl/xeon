// 관리자 모드: 화면 오른쪽 상단 모서리(#adminCorner)를 누르면 비밀번호를 물어보고,
// 서버(xeon-worker)의 /api/verify-admin으로 매번 검증합니다.
// 비밀번호 원문은 이 탭의 메모리(변수)에만 잠깐 보관하고, 관리자 행동(방 삭제)을 할 때마다
// 서버로 같이 보내서 서버가 다시 확인합니다 — 클라이언트의 "나는 관리자다" 라는 말을 그냥 믿지 않음.
import { callApi } from "./api.js";

let cachedPassword = null; // 새로고침하면 초기화됨 (의도된 동작)

export function isAdmin() {
  return cachedPassword !== null;
}

export async function promptAdminLogin() {
  if (isAdmin()) return true;
  const pw = window.prompt("관리자 비밀번호를 입력하세요");
  if (pw === null) return false; // 취소

  try {
    const res = await callApi("/api/verify-admin", { password: pw });
    if (res.ok) {
      cachedPassword = pw;
      return true;
    }
  } catch (e) {
    // 아래 alert로 통일 처리
  }
  alert("비밀번호가 틀렸어요.");
  return false;
}

// 관리자 행동(방 삭제 등)을 요청할 때 서버에 같이 보낼 비밀번호
export function getAdminPassword() {
  return cachedPassword;
}
