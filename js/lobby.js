import { db, ensureSignedIn, onAuthChange, currentUserInfo, signInWithGoogle, signOutAndGoGuest } from "./firebase-config.js";
import {
  collection, doc, getDoc, getDocs, onSnapshot,
  query, orderBy
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { isAdmin, promptAdminLogin, getAdminPassword } from "./admin.js";
import { callApi } from "./api.js";

const roomListEl = document.getElementById("roomList");
const emptyMsgEl = document.getElementById("emptyMsg");

const createModal = document.getElementById("createModal");
const createRoomBtn = document.getElementById("createRoomBtn");
const cancelCreateBtn = document.getElementById("cancelCreateBtn");
const confirmCreateBtn = document.getElementById("confirmCreateBtn");
const createError = document.getElementById("createError");

const passwordModal = document.getElementById("passwordModal");
const cancelJoinBtn = document.getElementById("cancelJoinBtn");
const confirmJoinBtn = document.getElementById("confirmJoinBtn");
const joinPasswordInput = document.getElementById("joinPasswordInput");
const joinError = document.getElementById("joinError");

const adminCornerEl = document.getElementById("adminCorner");
const refreshRoomsBtn = document.getElementById("refreshRoomsBtn");

let currentUser = null;
let roomsCache = {};      // roomId -> room data (실시간 반영)
let pendingJoinRoomId = null;

const FIRST_MOVE_LABEL = { random: "무작위", host: "방장 선", challenger: "도전자 선" };

// 닉네임 형식: 공백/특수문자 금지, 한글·영문·숫자만, 2~20자 (서버 검증 규칙과 동일)
const NICKNAME_RE = /^[a-zA-Z0-9가-힣]{2,20}$/;

// 내 프로필(닉네임/게스트 여부)과 전적 — 로비 좌하단 프로필 박스에 표시
let myProfile = { nickname: null, isGuest: true, needsNicknameSetup: false };
let myStats = null;
let profileBoxEl = null;
let profileUserUnsub = null;
let profileStatsUnsub = null;

init();

async function init() {
  currentUser = await ensureSignedIn();
  renderAuthCorner();
  onAuthChange(() => renderAuthCorner()); // 구글 연결/전환/로그아웃마다 UI 갱신
  buildProfileBox();

  // 방 목록 구독/버튼 연결은 rooms 컬렉션이 누구나 읽기 가능하고 currentUser에도
  // 의존하지 않으므로, 프로필 초기화(서버 왕복)를 기다리지 않고 바로 시작함
  // — 그래야 로비가 뜨자마자 방 목록/방 생성 버튼이 곧바로 반응함.
  subscribeRoomList();
  bindUI();

  await ensureUserProfile();
  subscribeProfile();
  await checkResumableRoom();
}

/* =========================================================
   내 프로필(닉네임/게스트여부) 초기화
   - 최초 로그인이면 서버(worker)가 users/{uid} 문서를 만들어줌
     (게스트는 Guest+월일년+오늘 몇 번째 가입인지 조합으로 자동 생성됨)
   - 이미 있으면 lastLoginAt만 갱신하고 기존 닉네임을 그대로 돌려받음
========================================================= */
async function ensureUserProfile() {
  try {
    const res = await callApi("/api/ensure-user", {});
    myProfile = {
      nickname: res.nickname,
      isGuest: !!res.isGuest,
      needsNicknameSetup: !!res.needsNicknameSetup,
    };
  } catch (e) {
    console.error("[프로필 초기화 실패]", e);
  }
  renderProfileBox();
  await forceNicknameSetupIfNeeded();
}

/* =========================================================
   구글 계정으로 처음 로그인했을 때(또는 게스트→구글 전환 직후)
   서버가 needsNicknameSetup:true를 돌려주면, 임시 이름(PlayerXXXXXXXX) 대신
   원하는 닉네임을 바로 정하도록 설정창을 띄움. 규칙 위반/중복이면 이유를
   알려주고 다시 물어봄. 취소하면 나중에 프로필 박스에서 설정하라고 안내.
========================================================= */
async function forceNicknameSetupIfNeeded() {
  if (!myProfile.needsNicknameSetup) return;

  const next = window.prompt(
    "환영해요! 사용할 닉네임을 정해주세요.\n(공백·특수문자 없이 한글·영문·숫자 2~20자, 다른 사람과 중복될 수 없어요)",
    ""
  );
  if (next === null) {
    alert("닉네임을 나중에 정하고 싶다면, 왼쪽 아래 프로필을 눌러서 언제든 설정할 수 있어요.");
    return;
  }

  const trimmed = next.trim();
  if (!NICKNAME_RE.test(trimmed)) {
    alert("닉네임은 공백·특수문자 없이 한글·영문·숫자로 2~20자여야 해요.");
    return forceNicknameSetupIfNeeded();
  }

  try {
    const res = await callApi("/api/set-nickname", { nickname: trimmed });
    myProfile.nickname = res.nickname;
    myProfile.needsNicknameSetup = false;
    renderProfileBox();
  } catch (e) {
    alert(e.message);
    return forceNicknameSetupIfNeeded();
  }
}

function subscribeProfile() {
  if (!currentUser) return;
  if (profileUserUnsub) profileUserUnsub();
  if (profileStatsUnsub) profileStatsUnsub();

  profileUserUnsub = onSnapshot(doc(db, "users", currentUser.uid), (snap) => {
    if (snap.exists()) {
      const d = snap.data();
      myProfile.nickname = d.nickname;
      myProfile.isGuest = !!d.isGuest;
    }
    renderProfileBox();
  });

  profileStatsUnsub = onSnapshot(doc(db, "playerStats", currentUser.uid), (snap) => {
    myStats = snap.exists() ? snap.data() : { wins: 0, losses: 0, draws: 0 };
    renderProfileBox();
  });
}

/* =========================================================
   프로필 박스(로비 맨 왼쪽 하단) — 닉네임 + 전적(ㅇㅇ승ㅇㅇ패ㅇㅇ%)
   클릭하면 닉네임 변경(하루 1회, 게스트는 불가)
========================================================= */
function buildProfileBox() {
  profileBoxEl = document.createElement("div");
  profileBoxEl.id = "profileBox";
  profileBoxEl.className = "profile-box";
  profileBoxEl.title = "클릭해서 닉네임 변경 (하루 1회)";
  document.body.appendChild(profileBoxEl);
  profileBoxEl.addEventListener("click", handleNicknameClick);
}

function renderProfileBox() {
  if (!profileBoxEl) return;
  const wins = (myStats && myStats.wins) || 0;
  const losses = (myStats && myStats.losses) || 0;
  const draws = (myStats && myStats.draws) || 0;
  const total = wins + losses + draws;
  const rate = total > 0 ? Math.round((wins / total) * 100) : 0;

  profileBoxEl.innerHTML = `
    <div class="profile-nickname">${escapeHtml(myProfile.nickname || "...")}</div>
    <div class="profile-record">${wins}승 ${losses}패 ${rate}%</div>
    ${myProfile.isGuest ? `<div class="profile-hint">게스트 (닉네임 변경 불가)</div>` : `<div class="profile-hint">클릭해서 닉네임 변경</div>`}
  `;
}

async function handleNicknameClick() {
  if (myProfile.isGuest) {
    alert("게스트는 닉네임을 변경할 수 없어요. 구글로 로그인하면 원하는 닉네임을 정할 수 있어요.");
    return;
  }
  const next = window.prompt(
    "새 닉네임을 입력하세요 (공백·특수문자 없이 한글·영문·숫자 2~20자, 하루에 한 번만 변경 가능)",
    myProfile.nickname || ""
  );
  if (next === null) return; // 취소
  const trimmed = next.trim();
  if (!trimmed) return;
  if (trimmed === myProfile.nickname) return;
  if (!NICKNAME_RE.test(trimmed)) {
    alert("닉네임은 공백·특수문자 없이 한글·영문·숫자로 2~20자여야 해요.");
    return;
  }

  try {
    const res = await callApi("/api/set-nickname", { nickname: trimmed });
    myProfile.nickname = res.nickname;
    renderProfileBox();
  } catch (e) {
    alert(e.message);
  }
}

/* =========================================================
   로그인 상태 표시(우상단, admin-corner와 겹치지 않게 좌상단)
   - 게스트: "게스트로 플레이 중" + 구글로 로그인 버튼
   - 구글 로그인 됨: 프로필 사진 + 이름 + 로그아웃(게스트로) 버튼
========================================================= */
let authCornerEl = document.getElementById("authCorner");
if (!authCornerEl) {
  authCornerEl = document.createElement("div");
  authCornerEl.id = "authCorner";
  authCornerEl.className = "auth-corner";
  document.body.insertBefore(authCornerEl, document.body.firstChild);
}

function renderAuthCorner() {
  const info = currentUserInfo();
  if (!info) return;

  if (info.isAnonymous) {
    authCornerEl.innerHTML = `
      <span class="auth-status">게스트로 플레이 중</span>
      <button type="button" class="btn primary auth-btn" id="googleLoginBtn">구글로 로그인</button>
    `;
    document.getElementById("googleLoginBtn").addEventListener("click", handleGoogleLogin);
  } else {
    authCornerEl.innerHTML = `
      ${info.photoURL ? `<img class="auth-avatar" src="${info.photoURL}" alt="" />` : ""}
      <span class="auth-status">${escapeHtml(info.displayName || info.email || "로그인됨")}</span>
      <button type="button" class="btn auth-btn" id="logoutBtn">게스트로 전환</button>
    `;
    document.getElementById("logoutBtn").addEventListener("click", handleLogout);
  }
}

async function handleGoogleLogin() {
  const btn = document.getElementById("googleLoginBtn");
  if (btn) btn.disabled = true;
  try {
    const result = await signInWithGoogle();
    currentUser = result ? result.user : currentUser;
    if (result) {
      // 구글 연결/전환 후에는 프로필(닉네임/게스트여부)도 다시 확인
      await ensureUserProfile();
      subscribeProfile();
      if (result.switched) {
        // 게스트 uid에서 기존 구글 계정 uid로 바뀌었으므로 진행 중 방 배너 등도 다시 확인
        await checkResumableRoom();
      }
    }
  } catch (e) {
    console.error(e);
    alert("로그인에 실패했어요: " + e.message);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleLogout() {
  const btn = document.getElementById("logoutBtn");
  if (btn) btn.disabled = true;
  try {
    await signOutAndGoGuest();
  } catch (e) {
    console.error(e);
    alert("전환에 실패했어요: " + e.message);
  }
}

/* =========================================================
   이전에 하던 게임으로 돌아가기
   - 같은 브라우저(익명 로그인 uid 유지)에서 room.js가 저장해둔
     localStorage의 마지막 방 id를 확인해서, 아직 유효하면(내가 host/challenger고
     status가 finished가 아니면) 돌아가기 배너를 보여줌
========================================================= */
async function checkResumableRoom() {
  const lastRoomId = localStorage.getItem("xeon_last_room");
  if (!lastRoomId) return;

  let snap;
  try {
    snap = await getDoc(doc(db, "rooms", lastRoomId));
  } catch (e) {
    return; // 네트워크 문제 등이면 그냥 조용히 넘어감(다음에 다시 시도)
  }

  if (!snap.exists()) {
    localStorage.removeItem("xeon_last_room");
    return;
  }
  const room = snap.data();
  const stillMine = room.hostId === currentUser.uid || room.challengerId === currentUser.uid;
  if (!stillMine || room.status === "finished") {
    localStorage.removeItem("xeon_last_room");
    return;
  }

  showResumeBanner(lastRoomId, room);
}

function showResumeBanner(roomId, room) {
  const banner = document.createElement("div");
  banner.className = "resume-banner";
  banner.innerHTML = `
    <span>진행 중이던 "${escapeHtml(room.name)}" 방이 있어요.</span>
    <button type="button" class="btn primary" id="resumeGoBtn">돌아가기</button>
    <button type="button" class="btn" id="resumeDismissBtn">닫기</button>
  `;
  document.body.insertBefore(banner, document.body.firstChild);

  document.getElementById("resumeGoBtn").addEventListener("click", () => {
    goToRoom(roomId);
  });
  document.getElementById("resumeDismissBtn").addEventListener("click", () => {
    localStorage.removeItem("xeon_last_room");
    banner.remove();
  });
}

function subscribeRoomList() {
  const q = query(collection(db, "rooms"), orderBy("createdAt", "desc"));
  onSnapshot(q, (snapshot) => {
    roomsCache = {};
    snapshot.forEach((docSnap) => {
      roomsCache[docSnap.id] = docSnap.data();
    });
    renderRoomList();
  });
}

/* =========================================================
   방 목록 수동 새로고침 버튼
   - 방 목록은 onSnapshot으로 이미 실시간 반영되지만, 혹시 연결이 끊기거나
     "지금 최신 상태인지 눈으로 확인하고 싶을 때"를 위해 수동 새로고침도 제공.
   - 버튼을 누르면 서버에서 한 번 다시 읽어와 목록을 갱신하고, 아이콘을 잠깐 회전시킴.
========================================================= */
async function handleRefreshRooms() {
  if (!refreshRoomsBtn || refreshRoomsBtn.disabled) return;

  refreshRoomsBtn.disabled = true;
  refreshRoomsBtn.classList.add("spinning");

  try {
    const q = query(collection(db, "rooms"), orderBy("createdAt", "desc"));
    const snapshot = await getDocs(q);
    roomsCache = {};
    snapshot.forEach((docSnap) => {
      roomsCache[docSnap.id] = docSnap.data();
    });
    renderRoomList();
  } catch (e) {
    console.error("[방 목록 새로고침 실패]", e);
  } finally {
    // 회전 애니메이션이 눈에 보이도록 살짝 텀을 두고 정리
    setTimeout(() => {
      refreshRoomsBtn.classList.remove("spinning");
      refreshRoomsBtn.disabled = false;
    }, 400);
  }
}

function renderRoomList() {
  const ids = Object.keys(roomsCache);
  roomListEl.innerHTML = "";
  emptyMsgEl.style.display = ids.length === 0 ? "block" : "none";

  const admin = isAdmin();

  ids.forEach((roomId) => {
    const room = roomsCache[roomId];
    const li = document.createElement("li");
    li.className = "room-item" + (room.status === "playing" ? " playing" : "");

    const undoLabel = room.undoLimit === -1 ? "무제한" : `${room.undoLimit}회`;
    const tc = room.timeControl || {};
    const timeLabel = tc.presetSeconds ? `${Math.floor(tc.presetSeconds / 60)}분${tc.incrementSeconds ? `+${tc.incrementSeconds}초` : ""}` : "무제한";
    const subText = `선공: ${FIRST_MOVE_LABEL[room.firstMoveRule] || "무작위"} · 무르기 ${undoLabel} · 시간 ${timeLabel}${room.hasPassword ? " · 🔒" : ""}`;
    const statusLabel = room.status === "waiting" ? "대기중" : room.status === "playing" ? "게임중(관전 가능)" : "종료";

    li.innerHTML = `
      <div class="room-info">
        <span class="room-name">${escapeHtml(room.name)}</span>
        <span class="room-sub">${subText}</span>
      </div>
      <div class="room-right">
        <span class="room-status-badge">${statusLabel}</span>
        ${admin ? `<button class="room-delete-btn" type="button" data-room-id="${roomId}" title="방 삭제(관리자)">✕</button>` : ""}
      </div>
    `;

    li.addEventListener("click", () => onRoomClick(roomId, room));

    if (admin) {
      const delBtn = li.querySelector(".room-delete-btn");
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation(); // 방 입장 클릭으로 안 번지게
        handleAdminDeleteRoom(roomId, room.name);
      });
    }

    roomListEl.appendChild(li);
  });
}

function onRoomClick(roomId, room) {
  if (room.hasPassword) {
    pendingJoinRoomId = roomId;
    joinPasswordInput.value = "";
    joinError.textContent = "";
    passwordModal.style.display = "flex";
    joinPasswordInput.focus();
  } else {
    goToRoom(roomId);
  }
}

async function handleAdminDeleteRoom(roomId, roomName) {
  if (!confirm(`"${roomName}" 방을 삭제할까요? (관리자)`)) return;
  try {
    // 클라이언트는 더 이상 Firestore를 직접 지울 권한이 없음(firestore.rules에서 update/delete 전면 차단).
    // 서버(xeon-worker)가 비밀번호를 다시 검증한 뒤에만 삭제됨.
    await callApi("/api/admin-delete", { roomId, password: getAdminPassword() });
  } catch (e) {
    console.error(e);
    alert("삭제에 실패했어요: " + e.message);
  }
}

function bindUI() {
  createRoomBtn.addEventListener("click", () => {
    createError.textContent = "";
    document.getElementById("roomNameInput").value = "";
    document.getElementById("roomPasswordInput").value = "";
    document.getElementById("firstMoveRuleInput").value = "random";
    document.getElementById("undoLimitInput").value = "0";
    document.getElementById("timePresetInput").value = "unlimited";
    document.getElementById("customMinInput").value = "5";
    document.getElementById("incrementSecInput").value = "0";
    document.getElementById("customTimeGroup").style.display = "none";
    createModal.style.display = "flex";
  });

  document.getElementById("timePresetInput").addEventListener("change", (e) => {
    document.getElementById("customTimeGroup").style.display = e.target.value === "custom" ? "block" : "none";
  });

  cancelCreateBtn.addEventListener("click", () => (createModal.style.display = "none"));

  confirmCreateBtn.addEventListener("click", handleCreateRoom);

  cancelJoinBtn.addEventListener("click", () => {
    passwordModal.style.display = "none";
    pendingJoinRoomId = null;
  });

  confirmJoinBtn.addEventListener("click", handleJoinWithPassword);

  if (adminCornerEl) {
    adminCornerEl.addEventListener("click", async () => {
      if (await promptAdminLogin()) renderRoomList(); // 성공하면 X버튼들 즉시 노출
    });
  }

  if (refreshRoomsBtn) {
    refreshRoomsBtn.addEventListener("click", handleRefreshRooms);
  }
}

async function handleCreateRoom() {
  const name = document.getElementById("roomNameInput").value.trim();
  const password = document.getElementById("roomPasswordInput").value;
  const firstMoveRule = document.getElementById("firstMoveRuleInput").value;
  const undoLimit = parseInt(document.getElementById("undoLimitInput").value, 10);

  const timePreset = document.getElementById("timePresetInput").value;
  const incrementSeconds = parseInt(document.getElementById("incrementSecInput").value, 10) || 0;
  let presetSeconds = null; // null = 무제한
  if (timePreset === "custom") {
    const mins = parseInt(document.getElementById("customMinInput").value, 10) || 5;
    presetSeconds = mins * 60;
  } else if (timePreset !== "unlimited") {
    presetSeconds = parseInt(timePreset, 10);
  }

  if (!name) {
    createError.textContent = "방 이름을 입력해주세요.";
    return;
  }

  confirmCreateBtn.disabled = true;

  try {
    // 방 생성 자체를 Worker(서비스 계정)가 처리하도록 변경.
    // 비밀번호는 여기서 해시로 만들지 않고 평문 그대로 서버에 전달 —
    // 서버가 해시를 계산해서 클라이언트가 절대 읽을 수 없는 roomSecrets 문서에만 저장함.
    const res = await callApi("/api/create-room", {
      name,
      password,
      firstMoveRule,
      undoLimit,
      timeControl: { presetSeconds, incrementSeconds },
    });

    goToRoom(res.roomId);
  } catch (e) {
    console.error(e);
    createError.textContent = "방 생성에 실패했어요. 다시 시도해주세요.";
  } finally {
    confirmCreateBtn.disabled = false;
  }
}

async function handleJoinWithPassword() {
  if (!pendingJoinRoomId) return;
  const input = joinPasswordInput.value;
  joinError.textContent = "";

  // 비밀번호가 맞는지는 더 이상 클라이언트가 직접 확인하지 않음(passwordHash를
  // 클라이언트가 아예 읽을 수 없게 됐기 때문). 여기서는 방으로 이동만 하고,
  // 실제 검증은 room.js가 입장할 때 호출하는 /api/join에서 서버가 함.
  // 비밀번호는 세션에만 잠깐 담아 room.js에 전달(로그인 유지 목적 아님, 새로고침 시 사라짐).
  sessionStorage.setItem(`xeon_join_pw_${pendingJoinRoomId}`, input);

  passwordModal.style.display = "none";
  goToRoom(pendingJoinRoomId);
}

function goToRoom(roomId) {
  window.location.href = `room.html?room=${roomId}`;
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
