// 관리자 모드: 화면 오른쪽 상단 모서리(#adminCorner)를 누르면 비밀번호를 물어보고,
// 서버(xeon-worker)의 /api/verify-admin으로 매번 검증합니다.
// 비밀번호 원문은 이 탭의 메모리(변수)에만 잠깐 보관하고, 관리자 행동(방 삭제)을 할 때마다
// 서버로 같이 보내서 서버가 다시 확인합니다 — 클라이언트의 "나는 관리자다" 라는 말을 그냥 믿지 않음.
//
// 비밀번호 입력은 브라우저 기본 prompt() 대신, 직접 만든 모달(입력창 type="password")을
// 써서 입력하는 동안 화면에 ●●● 로만 보이고 그대로 노출되지 않게 함.
import { callApi } from "./api.js";

let cachedPassword = null; // 새로고침하면 초기화됨 (의도된 동작)

export function isAdmin() {
  return cachedPassword !== null;
}

/* =========================================================
   관리자 비밀번호 입력 모달 (직접 구현)
   - 페이지에 한 번만 만들어두고(lazy) 필요할 때마다 보여줬다 숨김
   - 기존 .modal-overlay / .modal / .btn 스타일을 그대로 재사용
========================================================= */
let modalEls = null;

function buildAdminModal() {
  if (modalEls) return modalEls;

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.style.display = "none";
  overlay.innerHTML = `
    <div class="modal">
      <h2>관리자 로그인</h2>
      <label>비밀번호</label>
      <input id="adminPasswordInput" type="password" maxlength="50" autocomplete="off" placeholder="비밀번호">
      <div class="modal-actions">
        <button type="button" class="btn" id="adminCancelBtn">취소</button>
        <button type="button" class="btn primary" id="adminConfirmBtn">확인</button>
      </div>
      <p class="error-msg" id="adminModalError"></p>
    </div>
  `;
  document.body.appendChild(overlay);

  modalEls = {
    overlay,
    input: overlay.querySelector("#adminPasswordInput"),
    confirmBtn: overlay.querySelector("#adminConfirmBtn"),
    cancelBtn: overlay.querySelector("#adminCancelBtn"),
    errorEl: overlay.querySelector("#adminModalError"),
  };
  return modalEls;
}

// 모달을 띄우고 사용자가 입력한 비밀번호(문자열) 또는 취소 시 null을 돌려줌
function askAdminPassword() {
  const { overlay, input, confirmBtn, cancelBtn, errorEl } = buildAdminModal();

  return new Promise((resolve) => {
    errorEl.textContent = "";
    input.value = "";
    overlay.style.display = "flex";
    // display가 바뀐 직후 바로 focus를 주면 씹히는 경우가 있어 다음 틱에 시도
    setTimeout(() => input.focus(), 0);

    function cleanup(result) {
      overlay.style.display = "none";
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onOverlayClick);
      input.removeEventListener("keydown", onKeydown);
      resolve(result);
    }
    function onConfirm() {
      cleanup(input.value);
    }
    function onCancel() {
      cleanup(null);
    }
    function onOverlayClick(e) {
      if (e.target === overlay) onCancel(); // 바깥 영역 클릭 시 취소
    }
    function onKeydown(e) {
      if (e.key === "Enter") onConfirm();
      else if (e.key === "Escape") onCancel();
    }

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onOverlayClick);
    input.addEventListener("keydown", onKeydown);
  });
}

export async function promptAdminLogin() {
  if (isAdmin()) return true;
  const pw = await askAdminPassword();
  if (pw === null || pw === "") return false; // 취소 또는 빈 입력

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
