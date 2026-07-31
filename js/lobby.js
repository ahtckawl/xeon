import { db, ensureSignedIn } from "./firebase-config.js";
import {
  collection, doc, setDoc, getDoc, deleteDoc, onSnapshot,
  query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { isAdmin, promptAdminLogin } from "./admin.js";

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

let currentUser = null;
let roomsCache = {};      // roomId -> room data (실시간 반영)
let pendingJoinRoomId = null;

const FIRST_MOVE_LABEL = { random: "무작위", host: "방장 선", challenger: "도전자 선" };

init();

async function init() {
  currentUser = await ensureSignedIn();
  subscribeRoomList();
  bindUI();
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
    await deleteDoc(doc(db, "rooms", roomId));
  } catch (e) {
    console.error(e);
    alert("삭제에 실패했어요.");
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
    const roomRef = doc(collection(db, "rooms"));
    const hasPassword = password.length > 0;
    const passwordHash = hasPassword ? await sha256(password) : null;

    await setDoc(roomRef, {
      name,
      status: "waiting",
      hostId: currentUser.uid,
      challengerId: null,
      spectatorCount: 0,
      firstMoveRule,
      undoLimit,
      timeControl: { presetSeconds, incrementSeconds },
      hasPassword,
      passwordHash,
      hostReady: false,
      challengerReady: false,
      createdAt: serverTimestamp(),
      lastActivityAt: serverTimestamp(),
      gameOverAt: null
    });

    goToRoom(roomRef.id);
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

  const roomSnap = await getDoc(doc(db, "rooms", pendingJoinRoomId));
  if (!roomSnap.exists()) {
    joinError.textContent = "방이 사라졌어요.";
    return;
  }
  const room = roomSnap.data();
  const inputHash = await sha256(input);

  if (inputHash !== room.passwordHash) {
    joinError.textContent = "비밀번호가 틀렸어요.";
    return;
  }

  passwordModal.style.display = "none";
  goToRoom(pendingJoinRoomId);
}

function goToRoom(roomId) {
  window.location.href = `room.html?room=${roomId}`;
}

async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
