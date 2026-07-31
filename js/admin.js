// 관리자 모드: 화면 오른쪽 상단 모서리(#adminCorner)를 누르면 비밀번호를 물어보고,
// 맞으면 세션 동안(이 탭을 닫기 전까지) 관리자 권한을 부여합니다.
// 비밀번호 원문 대신 SHA-256 해시값만 저장해서, 소스코드를 열어봐도 평문이 바로 보이지 않도록 함
// (원문: q%123451234 → 아래 값으로 해시해서 넣어둔 것. 바꾸고 싶으면 새 비밀번호를 SHA-256으로 해시해서 교체하면 됨)
const ADMIN_PASSWORD_HASH = "ec3a4e722d617c6215464576ae73a9175876d0f663502708fc1bf4ae9c49e0fb";
const SESSION_KEY = "xeonChessIsAdmin";

async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function isAdmin() {
  return sessionStorage.getItem(SESSION_KEY) === "1";
}

export async function promptAdminLogin() {
  if (isAdmin()) return true;
  const pw = window.prompt("관리자 비밀번호를 입력하세요");
  if (pw === null) return false; // 취소
  const inputHash = await sha256(pw);
  if (inputHash === ADMIN_PASSWORD_HASH) {
    sessionStorage.setItem(SESSION_KEY, "1");
    return true;
  }
  alert("비밀번호 오류.");
  return false;
}
